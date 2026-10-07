import test from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import {
  WS2812_CHANNEL_MA,
  WS2812_LED_MA,
  estimateCurrentMa,
  currentAtBrightness,
  PowerBudget,
  PeakMeter,
} from '../core/power.js';

/**
 * The power model is what protects a 5 V supply, so the tests pin the arithmetic
 * itself: a wrong factor of 3 or 255 here is a brownout on the real wall.
 */

test('channel and per-LED constants', () => {
  assert.equal(WS2812_CHANNEL_MA, 20);
  assert.equal(WS2812_LED_MA, 60);
});

test('one LED at full white is 60 mA', () => {
  assert.equal(estimateCurrentMa(new Uint8Array([255, 255, 255])), 60);
});

test('400 LEDs at full white is 24 A, and half brightness is half current', () => {
  const full = new Uint8Array(1200).fill(255);
  assert.equal(estimateCurrentMa(full), 24000);

  const half = new Uint8Array(1200).fill(128);
  const ma = estimateCurrentMa(half);
  assert.ok(Math.abs(ma - 24000 * (128 / 255)) < 1e-9);
  assert.ok(ma < estimateCurrentMa(full));
});

test('black draws nothing and order does not matter', () => {
  assert.equal(estimateCurrentMa(new Uint8Array(1200)), 0);

  const a = new Uint8Array([255, 0, 0, 0, 0, 255]);
  const b = new Uint8Array([0, 0, 255, 255, 0, 0]);
  assert.equal(estimateCurrentMa(a), estimateCurrentMa(b));
});

test('perChannelMa scales the estimate for a different LED spec', () => {
  const white = new Uint8Array([255, 255, 255]);
  assert.equal(estimateCurrentMa(white, { perChannelMa: 10 }), 30);
});

test('currentAtBrightness is linear in k and does not touch the panel', () => {
  const p = new Panel();
  p.fill(255, 255, 255);
  const before = p.toBytes();

  assert.equal(currentAtBrightness(p, 1), 24000);
  assert.equal(currentAtBrightness(p, 0.5), 12000);
  assert.equal(currentAtBrightness(p, 0), 0);
  assert.deepEqual(p.toBytes(), before);
});

test('a frame over the limit is clamped to the effective limit', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  const p = new Panel();
  p.fill(255, 255, 255);

  const k = budget.brightnessFor(p, 1);
  assert.ok(k < 1, 'full white must be clamped under an 8 A budget');
  assert.ok(Math.abs(budget.lastMa - 8000) < 1e-9);
  assert.equal(budget.clampedFrames, 1);
});

test('headroom reserves part of the limit', () => {
  const budget = new PowerBudget(8000, { headroom: 0.25 });
  assert.equal(budget.effectiveLimitMa, 6000);

  const p = new Panel();
  p.fill(255, 255, 255);
  const k = budget.brightnessFor(p, 1);
  assert.ok(Math.abs(budget.lastMa - 6000) < 1e-9);
  assert.ok(k < 1);
});

test('a frame under the budget is not clamped', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  const p = new Panel();
  p.fill(10, 10, 10);

  const k = budget.brightnessFor(p, 1);
  assert.equal(k, 1);
  assert.equal(budget.clampedFrames, 0);
  assert.ok(budget.lastMa < 8000);
});

test('the requested brightness is respected when it is lower than the ceiling', () => {
  const budget = new PowerBudget(24000, { headroom: 0 });
  const p = new Panel();
  p.fill(255, 255, 255);

  assert.equal(budget.brightnessFor(p, 0.4), 0.4);
  assert.equal(budget.clampedFrames, 0);
});

test('minBrightness keeps the wall from going dark on an impossible budget', () => {
  const budget = new PowerBudget(100, { headroom: 0, minBrightness: 0.05 });
  const p = new Panel();
  p.fill(255, 255, 255);

  const k = budget.brightnessFor(p, 1);
  assert.equal(k, 0.05);
  assert.ok(k > 0, 'a 0.05 floor is the point: the wall stays visible');
});

test('observe lowers the ceiling for the frames that follow a hot one', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  const hot = new Uint8Array(1200).fill(255);

  const ma = budget.observe(hot);
  assert.equal(ma, 24000);
  assert.ok(budget.k < 1, 'the adaptive ceiling must drop after an over-budget frame');
  assert.equal(budget.clampedFrames, 1);

  const kAfter = budget.k;
  budget.observe(hot);
  assert.ok(budget.k < kAfter, 'a second hot frame must lower it again');
});

test('observe leaves the ceiling alone while frames stay under the limit', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  budget.observe(new Uint8Array(1200).fill(255));
  const lowered = budget.k;

  budget.observe(new Uint8Array(1200).fill(1));
  assert.equal(budget.k, lowered);
});

test('reset restores the ceiling after a scene change', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  budget.observe(new Uint8Array(1200).fill(255));
  assert.ok(budget.k < 1);

  budget.reset();
  assert.equal(budget.k, 1);
  assert.equal(budget.clampedFrames, 0);
  assert.equal(budget.peakMa, 0);
});

test('toMeta is the wire payload: brightness as 0..255 and limitMa as an integer', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  budget.observe(new Uint8Array(1200).fill(255));

  const m = budget.toMeta();
  assert.ok(Number.isInteger(m.brightness) && m.brightness >= 0 && m.brightness <= 255);
  assert.equal(m.limitMa, 8000);
  assert.ok(m.brightness < 255, 'a clamped budget must tell the wall to dim');
});

test('limitMa must be positive', () => {
  assert.throws(() => new PowerBudget(0), RangeError);
  assert.throws(() => new PowerBudget(-1), RangeError);
  assert.throws(() => new PowerBudget(Number.NaN), RangeError);
});

test('headroom is clamped into a usable range', () => {
  assert.equal(new PowerBudget(8000, { headroom: 5 }).headroom, 0.9);
  assert.equal(new PowerBudget(8000, { headroom: -3 }).headroom, 0);
  assert.ok(new PowerBudget(8000, { headroom: 5 }).effectiveLimitMa > 0);
});

test('PeakMeter reports the worst frame in the window, not the last one', () => {
  const meter = new PeakMeter(4);
  meter.push(new Uint8Array(1200).fill(1));
  meter.push(new Uint8Array(1200).fill(255));
  meter.push(new Uint8Array(1200).fill(1));

  assert.equal(meter.windowPeak, 24000);
  assert.ok(meter.windowMean < meter.windowPeak);
});

test('PeakMeter forgets samples older than the window', () => {
  const meter = new PeakMeter(2);
  meter.push(new Uint8Array(1200).fill(255));
  meter.push(new Uint8Array(1200).fill(0));
  assert.equal(meter.windowPeak, 24000);

  meter.push(new Uint8Array(1200).fill(0));
  assert.equal(meter.windowPeak, 0, 'the hot sample has aged out of a 2-frame window');
});

test('PeakMeter mean over a partly filled window averages only real samples', () => {
  const meter = new PeakMeter(10);
  meter.push(new Uint8Array(1200).fill(255));
  assert.equal(meter.windowMean, 24000);
  assert.equal(meter.windowPeak, 24000);
});

test('PeakMeter with no samples reports zero rather than NaN', () => {
  const meter = new PeakMeter(5);
  assert.equal(meter.windowPeak, 0);
  assert.equal(meter.windowMean, 0);
});

test('PeakMeter.reset clears the window', () => {
  const meter = new PeakMeter(3);
  meter.push(new Uint8Array(1200).fill(255));
  meter.reset();
  assert.equal(meter.windowPeak, 0);
  assert.equal(meter.windowMean, 0);
  assert.equal(meter.peak, 0);
});

test('PeakMeter rejects a nonsense window', () => {
  assert.throws(() => new PeakMeter(0), RangeError);
  assert.throws(() => new PeakMeter(-2), RangeError);
  assert.throws(() => new PeakMeter(2.5), RangeError);
});

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

test('the slider is BIDIRECTIONAL: the power ratchet must never latch it', () => {
  // The field report: "requested brightness does absolutely nothing". The
  // requested k used to be folded INTO the one-way adaptive ceiling, so
  // dragging the wall down worked once and the slider could never bring it
  // back: min(want, ceiling) remembered the old low forever. An operator
  // moving a slider is not a picture swinging its own ink; both directions
  // must work.
  const budget = new PowerBudget(24000, { headroom: 0 });
  const p = new Panel();
  p.fill(255, 255, 255);

  assert.equal(budget.brightnessFor(p, 0.4), 0.4, 'down works');
  assert.equal(budget.brightnessFor(p, 1), 1, 'back up recovers IMMEDIATELY, no reset');
  assert.equal(budget.brightnessFor(p, 0.25), 0.25);
  assert.equal(budget.brightnessFor(p, 0.6), 0.6);

  // The ratchet keeps its power meaning: under a real clamp, raising the
  // slider above the ceiling recovers only to the ceiling, and the ceiling
  // still ratchets down across hot frames.
  const tight = new PowerBudget(8000, { headroom: 0 });
  const q = new Panel();
  q.fill(255, 255, 255);
  const low = tight.brightnessFor(q, 1); // ceiling ~ 8000/24000
  assert.ok(low < 0.4, 'the clamp is the binding number here');
  assert.equal(tight.brightnessFor(q, 0.2), 0.2, 'slider below the ceiling rules');
  assert.equal(tight.brightnessFor(q, 1), low, 'slider above the ceiling: the ceiling rules');
  assert.equal(tight.brightnessFor(q, 0.3), 0.3, 'and back under the ceiling: slider rules again');

  // toMeta declares the APPLIED k, so the wall is lit with the number it is told.
  const b2 = new PowerBudget(24000, { headroom: 0 });
  b2.brightnessFor(p, 0.4);
  assert.equal(b2.toMeta().brightness, Math.round(0.4 * 255), 'meta declares the slider, not the ceiling');
});

/*
 * The two that matter for the panel. Clamping against the frame's own ink makes
 * the wall's brightness a function of the picture: a scrolling banner dims and
 * brightens the whole panel several times a second, which is what a flickering
 * curtain wall looks like with every byte and every counter correct.
 */
test('a dip in ink does not step the wall back up', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  const hot = new Panel();
  hot.fill(255, 255, 255);
  const less = new Panel();
  less.fill(200, 200, 200);

  const k1 = budget.brightnessFor(hot, 1);
  const k2 = budget.brightnessFor(less, 1);
  assert.equal(k2, k1, 'dimmer ink must not change the ceiling at all');
});

test('a dim picture never brightens the wall back', () => {
  const budget = new PowerBudget(8000, { headroom: 0 });
  const hot = new Panel();
  hot.fill(255, 255, 255);
  const cool = new Panel();
  cool.fill(20, 20, 20);

  const low = budget.brightnessFor(hot, 1);
  let k = low;
  for (let i = 0; i < 60; i++) k = budget.brightnessFor(cool, 1);
  assert.equal(k, low, 'two seconds of a dimmer picture must not step the wall up');

  // Only a deliberate scene change may brighten it, and that is reset().
  budget.reset();
  assert.equal(budget.brightnessFor(cool, 1), 1);
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

// -------------------------------------------------------------------------
// The full-white death spiral (live panel, 2026-10-14): a full-white panel at
// limit 18000 mA aims brightnessFor at effectiveLimitMa = 16200; the rendered
// bytes then estimate a hair OVER that margin from integer rounding, and the
// old observe() fired its multiplicative decay against effectiveLimitMa — so
// every single frame multiplied k by ~0.9996 with no recovery. The wall
// spiralled to the minBrightness floor (k=0.05) and the meta record carried
// br=13: the panel sat at 5% brightness, dull, with the slider looking dead.
// -------------------------------------------------------------------------

test('a sustained full-white panel settles at the clamp, it does not spiral to the floor', () => {
  const budget = new PowerBudget(18000); // headroom 0.1 => effective 16200
  const panel = new Panel();
  panel.fill(255, 255, 255);
  const layout = { map: null }; // pack through identity-ish: build bytes by hand
  const bytes = new Uint8Array(1200).fill(255);

  let k = 1;
  for (let frame = 0; frame < 600; frame++) {
    k = budget.brightnessFor(panel, 1);
    const rendered = bytes.map((v) => (v * k) | 0); // the app's scale path
    budget.observe(rendered);
  }

  // 16200 / 24000 = 0.675, and the floor is 0.05: the spiral ended at the floor.
  assert.ok(k > 0.6, `k settled at ${k}; must hold near the 0.675 clamp, not decay`);
  assert.ok(budget.k > 0.6, `adaptive ceiling decayed to ${budget.k}`);
});

test('toMeta brightness is the k that is actually applied - one state, not two', () => {
  const budget = new PowerBudget(18000);
  const panel = new Panel();
  panel.fill(255, 255, 255);
  const k = budget.brightnessFor(panel, 1);
  assert.equal(budget.toMeta().brightness, Math.round(k * 255));
});

test('observe still fires when the real current crosses the real limit', () => {
  const budget = new PowerBudget(1000);
  const over = new Uint8Array(1200).fill(255); // 24000 mA against a 1000 mA limit
  budget.observe(over);
  assert.ok(budget.k < 1, 'a frame over the hard limit must lower the ceiling');
  assert.ok(budget.clampedFrames >= 1);
});

// The headroom slider is a margin control, and the adaptive ceiling is a
// one-way ratchet (only reset() brightens the wall back). So the app's
// headroom handler must reset like the limit handler does: raising headroom
// clamps k, and lowering it recovers nothing while the ratchet holds.
test('headroom cycle: raising it clamps, lowering it with a reset recovers', () => {
  const budget = new PowerBudget(18000, { headroom: 0.1 });
  const panel = new Panel();
  panel.fill(255, 255, 255);
  const bytes = new Uint8Array(1200).fill(255);
  const render = (k) => bytes.map((v) => (v * k) | 0);

  let k = budget.brightnessFor(panel, 1);
  budget.observe(render(k));
  assert.ok(k > 0.6, `baseline clamp ~0.675, got ${k}`);

  // Raise headroom to 0.9: margin 1800 mA against 24000 => k ~0.075.
  budget.headroom = 0.9;
  k = budget.brightnessFor(panel, 1);
  assert.ok(k < 0.1, `headroom 0.9 must clamp hard, got ${k}`);
  budget.observe(render(k));

  // Lower it back. Without a reset the ratchet holds the 0.075 clamp forever;
  // with one (the app's handler), k returns to the 0.675 the margin allows.
  budget.headroom = 0.1;
  assert.ok(budget.brightnessFor(panel, 1) < 0.1, 'the ratchet must hold without a reset');
  budget.reset();
  k = budget.brightnessFor(panel, 1);
  assert.ok(k > 0.6, `after reset k must recover, got ${k}`);
  assert.equal(budget.toMeta().brightness, Math.round(k * 255));
});

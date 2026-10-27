/**
 * core/color.js — saturation and gamma.
 *
 * The contract worth pinning is the one the wall exposed: a bright pastel reads as
 * white because the eye desaturates at high luminance, so saturation has to be able
 * to push a colour AWAY from grey. The rest is the maths that makes that safe —
 * neutral settings change nothing, and a boost clips instead of wrapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyColor,
  gammaTable,
  whiteBalanceGains,
  COLOR_DEFAULTS,
  SATURATION_RANGE,
  GAMMA_RANGE,
  TEMPERATURE_RANGE,
  TINT_RANGE,
  BLACK_LEVEL_RANGE,
  WB_FLOOR,
} from '../core/color.js';

const px = (...rgb) => Uint8Array.from(rgb);

/** Spread between the largest and smallest channel — how colourful a pixel is. */
function spread(p) {
  return Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
}

test('neutral settings change nothing', () => {
  const before = px(200, 40, 90);
  const after = applyColor(before.slice());
  assert.deepEqual([...after], [...before]);
});

test('saturation pushes a pastel away from grey', () => {
  // The wall's own case: pink reading as white at high brightness.
  const pink = px(255, 182, 193);
  const before = spread(pink);
  const after = applyColor(pink.slice(), { saturation: 1.4 });
  assert.ok(spread(after) > before, `spread ${before} -> ${spread(after)}`);
  assert.deepEqual([...after], [255, 170, 186]);
});

test('saturation 0 collapses to grey', () => {
  const after = applyColor(px(255, 0, 0), { saturation: 0 });
  assert.equal(spread(after), 0, 'no colour left');
  assert.ok(after[0] > 0, 'and not black either');
});

test('a boost clips instead of wrapping', () => {
  const after = applyColor(px(255, 0, 0), { saturation: 2 });
  assert.deepEqual([...after], [255, 0, 0], 'bright channels pin at 255, dark at 0');
});

test('gamma deepens midtones and pins both ends', () => {
  const t = gammaTable(2);
  assert.equal(t[0], 0, 'black stays black');
  assert.equal(t[255], 255, 'white stays white');
  assert.equal(t[128], 64, 'midpoint follows the curve');

  const after = applyColor(px(128, 128, 128), { gamma: 2 });
  assert.deepEqual([...after], [64, 64, 64]);
});

test('saturation and gamma compose without either being skipped', () => {
  const after = applyColor(px(255, 182, 193), { saturation: 1.4, gamma: 2 });
  // (255,170,186) then gamma2: 255 -> 255, 170 -> 113, 186 -> 136
  assert.deepEqual([...after], [255, 113, 136]);
});

test('the ranges are the ones the UI offers', () => {
  assert.equal(SATURATION_RANGE.min, 0);
  assert.ok(SATURATION_RANGE.max > 1, 'the control must be able to boost');
  assert.ok(GAMMA_RANGE.max >= 2, 'and reach a normal display gamma');
  assert.equal(COLOR_DEFAULTS.saturation, 1);
  assert.equal(COLOR_DEFAULTS.gamma, 1);
});

test('white balance is neutral at rest and cut-only when moved', () => {
  assert.deepEqual(whiteBalanceGains(0, 0), [1, 1, 1]);

  for (const [t, m] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [0.5, -0.25]]) {
    const gains = whiteBalanceGains(t, m);
    assert.ok(Math.min(...gains) >= WB_FLOOR, `no channel is cut below the floor: ${gains}`);
    assert.ok(Math.max(...gains) <= 1 + 1e-9, `gains must never exceed 1: ${gains}`);
    assert.ok(Math.abs(Math.max(...gains) - 1) < 1e-9, `the largest gain is pinned at 1: ${gains}`);
  }
});

test('temperature moves red against blue, tint moves green against both', () => {
  const warm = whiteBalanceGains(1, 0);
  assert.ok(warm[0] > warm[2], 'warm favours red over blue');
  assert.deepEqual(warm.map((v) => +v.toFixed(4)), [1, 0.6667, 0.3333]);

  const cool = whiteBalanceGains(-1, 0);
  assert.ok(cool[2] > cool[0], 'cool favours blue over red');

  const magenta = whiteBalanceGains(0, 1);
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2], 'magenta pulls green below both');

  const green = whiteBalanceGains(0, -1);
  assert.ok(green[1] > green[0] && green[1] > green[2], 'green lifts green above both');
});

test('white balance never clips white to a colour', () => {
  // The point of the cut-only normalisation: a correction that BOOSTED a channel
  // would drive 255 past full and turn white into yellow. The strongest channel
  // must come through untouched, and the others only ever cut.
  const after = applyColor(px(255, 255, 255), { temperature: 1, tint: 1 });
  assert.equal(after[0], 255, 'the strongest channel is untouched');
  assert.ok(after[1] < 255 && after[2] < 255, 'the others are only ever cut');
});

test('black level crushes near-black and leaves white alone', () => {
  assert.deepEqual([...applyColor(px(10, 10, 10), { blackLevel: 20 })], [0, 0, 0]);
  assert.deepEqual([...applyColor(px(255, 255, 255), { blackLevel: 20 })], [255, 255, 255]);
  // (128 - 20) * 255/235 = 117.2 -> 117
  assert.deepEqual([...applyColor(px(128, 128, 128), { blackLevel: 20 })], [117, 117, 117]);
});

test('the neutral path is the identity, by reference', () => {
  const before = px(6, 8, 20);
  assert.equal(applyColor(before), before, 'no levers: the same array comes back');
  assert.equal(applyColor(before, { blackLevel: 0 }), before, 'black level 0 is neutral too');
});

test('every lever composes in the documented order', () => {
  // white balance -> saturation -> black level -> gamma, hand-computed on one
  // pixel: (200,100,50) with warm 0.5, no saturation, black 20, gamma 2.
  const after = applyColor(px(200, 100, 50), {
    temperature: 0.5,
    saturation: 1,
    blackLevel: 20,
    gamma: 2,
  });
  assert.deepEqual([...after], [149, 17, 0]);
});

test('the new ranges are the ones the UI offers', () => {
  assert.deepEqual(TEMPERATURE_RANGE, { min: -1, max: 1, step: 0.05 });
  assert.deepEqual(TINT_RANGE, { min: -1, max: 1, step: 0.05 });
  assert.equal(BLACK_LEVEL_RANGE.min, 0);
  assert.ok(BLACK_LEVEL_RANGE.max >= 32, 'the floor must reach into a dark sky');
  assert.equal(COLOR_DEFAULTS.temperature, 0);
  assert.equal(COLOR_DEFAULTS.tint, 0);
  assert.equal(COLOR_DEFAULTS.blackLevel, 0);
});

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
  COLOR_DEFAULTS,
  SATURATION_RANGE,
  GAMMA_RANGE,
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

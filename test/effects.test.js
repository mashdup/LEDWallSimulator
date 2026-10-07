import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { Layout, identity } from '../core/layout.js';
import {
  applyBrightness,
  blend,
  wipe,
  gradient,
  physicalIndexPattern,
} from '../core/effects.js';

const grey = (p, x, y) => p.getPixel(x, y)[0];

// -------------------------------------------------------------------------
// applyBrightness — the renderer's artistic multiplier
// -------------------------------------------------------------------------

test('applyBrightness(1) is identity and does not touch the bytes', () => {
  const p = new Panel(2, 1);
  p.setPixel(0, 0, 200, 100, 50);
  const before = p.toBytes();
  assert.equal(applyBrightness(p, 1), p);
  assert.deepEqual(p.toBytes(), before);
});

test('applyBrightness scales with floor rounding and never wraps', () => {
  const p = new Panel(2, 1);
  p.setPixel(0, 0, 200, 100, 50);
  applyBrightness(p, 0.5);
  assert.deepEqual(p.getPixel(0, 0), [100, 50, 25]);

  const q = new Panel(1, 1);
  q.setPixel(0, 0, 255, 255, 255);
  applyBrightness(q, 0);
  assert.deepEqual(q.getPixel(0, 0), [0, 0, 0]);
});

test('applyBrightness rejects a multiplier outside 0..1 instead of wrapping to black', () => {
  const p = new Panel(1, 1);
  p.setPixel(0, 0, 255, 255, 255);
  // k=2 on Uint8Array would compute 510 and store 255 & 0xFF... = 254 for 255,
  // and 200*2 = 400 -> 144. Silent corruption either way.
  assert.throws(() => applyBrightness(p, 2), /brightness must be within 0\.\.1, got 2/);
  assert.throws(() => applyBrightness(p, -0.1), /brightness must be within 0\.\.1/);
  assert.throws(() => applyBrightness(p, NaN), /brightness must be within 0\.\.1/);
  assert.deepEqual(p.getPixel(0, 0), [255, 255, 255], 'a rejected call must not half-apply');
});

// -------------------------------------------------------------------------
// blend
// -------------------------------------------------------------------------

test('blend alpha 0 leaves the base untouched, alpha 1 replaces it', () => {
  const base = new Panel(1, 1);
  base.setPixel(0, 0, 10, 20, 30);
  const over = new Panel(1, 1);
  over.setPixel(0, 0, 255, 0, 0);

  const none = new Panel(1, 1);
  none.setPixels(base.toBytes());
  blend(none, over, 0);
  assert.deepEqual(none.getPixel(0, 0), [10, 20, 30]);

  const full = new Panel(1, 1);
  full.setPixels(base.toBytes());
  blend(full, over, 1);
  assert.deepEqual(full.getPixel(0, 0), [255, 0, 0]);
});

test('blend with alpha omitted uses the over panel as per-channel alpha', () => {
  // The "over" panel carries its own opacity in its channel values, so a
  // channel is both the colour it moves toward and how far it moves:
  // green 51 over black lands at 51 * 51/255 = 10.
  const base = new Panel(2, 1);
  base.fill(0, 0, 0);
  const over = new Panel(2, 1);
  over.setPixel(0, 0, 255, 0, 0); // full red
  over.setPixel(1, 0, 0, 51, 0); // 20% green
  const out = new Panel(2, 1);
  blend(base, over, undefined, out);
  assert.deepEqual(out.getPixel(0, 0), [255, 0, 0]);
  assert.deepEqual(out.getPixel(1, 0), [0, 10, 0]);
});

test('blend writes into out and leaves base unchanged; out === base is in-place', () => {
  const base = new Panel(1, 1);
  base.setPixel(0, 0, 0, 0, 0);
  const over = new Panel(1, 1);
  over.setPixel(0, 0, 255, 255, 255);

  const out = new Panel(1, 1);
  assert.equal(blend(base, over, 1, out), out);
  assert.deepEqual(out.getPixel(0, 0), [255, 255, 255]);
  assert.deepEqual(base.getPixel(0, 0), [0, 0, 0], 'base must not be mutated when out is supplied');

  assert.equal(blend(base, over, 1), base);
  assert.deepEqual(base.getPixel(0, 0), [255, 255, 255]);
});

test('blend rejects mismatched panels', () => {
  assert.throws(() => blend(new Panel(2, 2), new Panel(3, 3), 1), /blend panels must match: 4 vs 9/);
});

// -------------------------------------------------------------------------
// wipe
// -------------------------------------------------------------------------

test('wipe t=0 is entirely `from`, t=1 entirely `to`', () => {
  const from = new Panel(4, 1);
  from.fill(0, 0, 0);
  const to = new Panel(4, 1);
  to.fill(255, 255, 255);

  const at0 = new Panel(4, 1);
  wipe(from, to, 0, { out: at0, feather: 2 });
  assert.deepEqual([grey(at0, 0, 0), grey(at0, 1, 0), grey(at0, 2, 0), grey(at0, 3, 0)], [0, 0, 0, 0]);

  const at1 = new Panel(4, 1);
  wipe(from, to, 1, { out: at1, feather: 2 });
  assert.deepEqual([grey(at1, 0, 0), grey(at1, 1, 0), grey(at1, 2, 0), grey(at1, 3, 0)], [255, 255, 255, 255]);
});

test('wipe mid-progress is a real crossfade, not a 0/1 mask', () => {
  // edge = 0.5 * (cols + feather) = 3; w = clamp01((3 - x) / 2).
  const from = new Panel(4, 1);
  from.fill(0, 0, 0);
  const to = new Panel(4, 1);
  to.fill(255, 255, 255);
  const mid = new Panel(4, 1);
  wipe(from, to, 0.5, { out: mid, feather: 2 });
  assert.deepEqual([grey(mid, 0, 0), grey(mid, 1, 0), grey(mid, 2, 0), grey(mid, 3, 0)], [255, 255, 127, 0]);
});

test('wipe feather 0 is a hard edge', () => {
  const from = new Panel(4, 1);
  from.fill(0, 0, 0);
  const to = new Panel(4, 1);
  to.fill(255, 255, 255);
  const hard = new Panel(4, 1);
  wipe(from, to, 0.5, { out: hard, feather: 0 });
  assert.deepEqual([grey(hard, 0, 0), grey(hard, 1, 0), grey(hard, 2, 0), grey(hard, 3, 0)], [0, 0, 255, 255]);
});

test('wipe progress is monotonic: more progress never darkens a cell', () => {
  const from = new Panel(6, 1);
  from.fill(0, 0, 0);
  const to = new Panel(6, 1);
  to.fill(255, 255, 255);
  const out = new Panel(6, 1);

  let previous = null;
  for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    out.fill(0, 0, 0);
    wipe(from, to, t, { out, feather: 2 });
    if (previous) {
      for (let x = 0; x < 6; x++) {
        assert.ok(grey(out, x, 0) >= previous[x], `t=${t} darkened cell ${x}: ${previous} -> ${grey(out, x, 0)}`);
      }
    }
    previous = [0, 1, 2, 3, 4, 5].map((x) => grey(out, x, 0));
  }
});

test('wipe directions mirror each other', () => {
  const from = new Panel(4, 1);
  from.fill(0, 0, 0);
  const to = new Panel(4, 1);

  const lr = new Panel(4, 1);
  const rl = new Panel(4, 1);
  wipe(from, to, 0.5, { out: lr, dir: 'lr', feather: 1 });
  wipe(from, to, 0.5, { out: rl, dir: 'rl', feather: 1 });
  for (let x = 0; x < 4; x++) assert.equal(grey(lr, x, 0), grey(rl, 3 - x, 0));

  const tb = new Panel(1, 4);
  const bt = new Panel(1, 4);
  const f2 = new Panel(1, 4);
  const t2 = new Panel(1, 4);
  t2.fill(255, 255, 255);
  wipe(f2, t2, 0.5, { out: tb, dir: 'tb', feather: 1 });
  wipe(f2, t2, 0.5, { out: bt, dir: 'bt', feather: 1 });
  for (let y = 0; y < 4; y++) assert.equal(grey(tb, 0, y), grey(bt, 0, 3 - y));
});

test('wipe radial is symmetric about the panel centre', () => {
  const from = new Panel(4, 4);
  const to = new Panel(4, 4);
  to.fill(255, 255, 255);
  const out = new Panel(4, 4);
  // t=0.35: the centre is already saturated, the corners are not. At t=0.5 the
  // whole panel has passed, which is why the lead has to be read mid-sweep.
  wipe(from, to, 0.35, { out, dir: 'radial', feather: 1 });
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      assert.equal(grey(out, x, y), grey(out, 3 - x, y), `x mirror at ${x},${y}`);
      assert.equal(grey(out, x, y), grey(out, x, 3 - y), `y mirror at ${x},${y}`);
    }
  }
  assert.equal(grey(out, 1, 1), 255);
  assert.ok(grey(out, 1, 1) > grey(out, 0, 0), 'radial wipe must open from the centre');
});

test('wipe defaults to writing into `from`, and rejects mismatched panels', () => {
  const from = new Panel(2, 1);
  const to = new Panel(2, 1);
  to.fill(255, 255, 255);
  assert.equal(wipe(from, to, 1), from);
  assert.deepEqual(from.getPixel(0, 0), [255, 255, 255]);

  assert.throws(() => wipe(new Panel(2, 1), new Panel(3, 1), 0.5), /wipe panels must match in size/);
});

// -------------------------------------------------------------------------
// gradient
// -------------------------------------------------------------------------

test('gradient hits both endpoints exactly and is monotonic along the axis', () => {
  const p = new Panel(3, 1);
  gradient(p, { from: [0, 0, 0], to: [255, 0, 0], axis: 'x' });
  assert.deepEqual(p.getPixel(0, 0), [0, 0, 0]);
  assert.deepEqual(p.getPixel(1, 0), [127, 0, 0]);
  assert.deepEqual(p.getPixel(2, 0), [255, 0, 0]);
});

test('gradient axis y ramps down the rows and leaves every column identical', () => {
  const p = new Panel(2, 3);
  gradient(p, { from: [0, 0, 255], to: [255, 0, 0], axis: 'y' });
  assert.deepEqual(p.getPixel(0, 0), [0, 0, 255]);
  assert.deepEqual(p.getPixel(1, 0), [0, 0, 255], 'a y-axis ramp must not vary across x');
  assert.deepEqual(p.getPixel(0, 2), [255, 0, 0]);
});

test('gradient on a single-cell axis does not divide by zero', () => {
  const p = new Panel(1, 1);
  gradient(p, { from: [10, 10, 10], to: [200, 200, 200] });
  assert.deepEqual(p.getPixel(0, 0), [10, 10, 10]);
});

// -------------------------------------------------------------------------
// physicalIndexPattern — the wiring self-test
// -------------------------------------------------------------------------

test('physicalIndexPattern numbers cells by PHYSICAL index, greyscale', () => {
  const layout = new Layout(); // serpentine: row 1 runs backwards
  const p = new Panel();
  physicalIndexPattern(p, layout);

  const scale = 255 / 399;
  for (const [x, y, physical] of [[0, 0, 0], [1, 0, 1], [19, 0, 19], [0, 1, 39], [19, 1, 20], [0, 19, 399]]) {
    const expected = Math.round(physical * scale);
    assert.deepEqual(p.getPixel(x, y), [expected, expected, expected], `cell ${x},${y} (physical ${physical})`);
  }
});

test('the pattern follows the layout, not the grid order', () => {
  // Same panel, two wiring guesses: the darkest and brightest cells move.
  const snake = new Panel();
  const straight = new Panel();
  physicalIndexPattern(snake, new Layout());
  physicalIndexPattern(straight, identity());

  assert.notDeepEqual(snake.getPixel(0, 1), straight.getPixel(0, 1));
  // identity: physical 399 is the last cell in row order, (19,19).
  assert.equal(grey(straight, 19, 19), 255);
  // serpentine: row 19 is reversed, so physical 399 sits at (0,19).
  assert.equal(grey(snake, 0, 19), 255);
  assert.equal(grey(snake, 19, 19), Math.round(380 * (255 / 399)));
});

test('the pattern uses the whole 0..255 range whatever the wiring guess', () => {
  // Layout changes where each value lands, never which values appear — so a
  // photo of the wall reads as a numbering, not as a different palette.
  const values = (layout) => {
    const p = new Panel();
    physicalIndexPattern(p, layout);
    const seen = [];
    for (let i = 0; i < p.pixels.length; i += 3) seen.push(p.pixels[i]);
    return seen.sort((a, b) => a - b);
  };
  assert.deepEqual(values(new Layout()), values(identity()));
  assert.deepEqual(values(new Layout({ flipX: true })), values(identity()));
});

test('physicalIndexPattern keeps channels equal', () => {
  const p = new Panel();
  physicalIndexPattern(p, new Layout());
  for (let i = 0; i < p.pixels.length; i += 3) {
    assert.equal(p.pixels[i], p.pixels[i + 1]);
    assert.equal(p.pixels[i + 1], p.pixels[i + 2]);
  }
});

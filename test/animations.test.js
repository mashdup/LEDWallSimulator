import test from 'node:test';
import assert from 'node:assert/strict';
import { animFrame, parseHex } from '../core/animations.js';

const G = 20;
const lit = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] || px[i + 1] || px[i + 2]) n++;
  return n;
};
const at = (px, x, y) => [px[(y * G + x) * 3], px[(y * G + x) * 3 + 1], px[(y * G + x) * 3 + 2]];

test('animFrame is pure: same state and time, byte-identical frame', () => {
  const a = animFrame({ kind: 'anim', name: 'plasma' }, 1791998675.5);
  const b = animFrame({ kind: 'anim', name: 'plasma' }, 1791998675.5);
  assert.deepEqual(a, b);
  assert.equal(lit(a), G * G, 'plasma fills the grid');
});

test('clear is black, fill is the color, rect draws a block', () => {
  assert.equal(lit(animFrame({ kind: 'clear' }, 100)), 0);
  const red = animFrame({ kind: 'fill', color: '#ff0000' }, 100);
  assert.equal(lit(red), G * G);
  assert.deepEqual(at(red, 0, 0), [255, 0, 0]);
  const block = animFrame({ kind: 'rect', x: 2, y: 3, w: 4, h: 5, color: '#00ff00' }, 100);
  assert.equal(lit(block), 20);
  assert.deepEqual(at(block, 3, 4), [0, 255, 0]);
  assert.deepEqual(at(block, 6, 4), [0, 0, 0]);
});

test('every named animation produces a lit, in-range frame', () => {
  for (const name of ['demo', 'bounce', 'rain', 'fire', 'plasma', 'bars', 'clock', 'sparkle']) {
    const px = animFrame({ kind: 'anim', name }, 1791998675.123);
    // bounce is a 2x2 ball plus a 5-cell trail: at most 9 lit cells by design.
    const min = name === 'bounce' ? 5 : 10;
    assert.ok(lit(px) >= min, `${name} should light ${min}+ pixels, got ${lit(px)}`);
  }
  assert.equal(lit(animFrame({ kind: 'anim', name: 'off' }, 100)), 0);
});

test('animations advance: consecutive times give consecutive frames', () => {
  const a = animFrame({ kind: 'anim', name: 'rain' }, 1791998675.0);
  const b = animFrame({ kind: 'anim', name: 'rain' }, 1791998675.033);
  assert.notDeepEqual(a, b, 'rain must move between frames');
});

test('clock reads real time: the second hand sits at the sampled second', () => {
  // 12:00:30.000 UTC: the second hand points straight down (frac 0.5).
  const t = Date.UTC(2026, 0, 1, 12, 0, 30, 0) / 1000;
  const px = animFrame({ kind: 'anim', name: 'clock' }, t);
  const green = [];
  for (let i = 0; i < px.length; i += 3) {
    if (px[i + 1] > 200 && px[i] < 100) green.push(i / 3);
  }
  // All green cells must sit on the center column, below center (pointing down).
  for (const idx of green) {
    assert.equal(idx % G, 10, 'second hand on the center column at :30');
    assert.ok(idx >= 10 * G + 10, 'second hand below center at :30');
  }
});

test('parseHex handles short, long, and junk', () => {
  assert.deepEqual(parseHex('#f00'), [255, 0, 0]);
  assert.deepEqual(parseHex('#00ff00'), [0, 255, 0]);
  assert.deepEqual(parseHex('red'), [255, 255, 255]);
  assert.deepEqual(parseHex(undefined), [255, 255, 255]);
});

test('snitch: gold-dominant comet on a dark sky, and it flies', () => {
  const f = animFrame({ v: 1, kind: 'anim', name: 'snitch' }, 1234.5);
  // The snitch is gold: the brightest pixel must be red-dominant and bright.
  let best = -1;
  let bestPx = null;
  for (let i = 0; i < f.length; i += 3) {
    const lum = f[i] + f[i + 1] + f[i + 2];
    if (lum > best) { best = lum; bestPx = [f[i], f[i + 1], f[i + 2]]; }
  }
  assert.ok(bestPx[0] > 200, `snitch core must be bright, got ${bestPx}`);
  assert.ok(bestPx[0] > bestPx[2] * 2, `snitch core must be gold (blue-poor), got ${bestPx}`);
  // Most of the sky is dark night, not a wash.
  let dark = 0;
  for (let i = 0; i < f.length; i += 3) if (f[i] + f[i + 1] + f[i + 2] < 90) dark++;
  assert.ok(dark > 300, `night sky must dominate, ${dark}/400 dark`);
  // It flies: a frame 0.5 s later has the snitch elsewhere.
  const f2 = animFrame({ v: 1, kind: 'anim', name: 'snitch' }, 1235.0);
  let moved = 0;
  for (let i = 0; i < f.length; i += 3) {
    if (Math.abs(f[i] - f2[i]) + Math.abs(f[i + 1] - f2[i + 1]) + Math.abs(f[i + 2] - f2[i + 2]) > 40) moved++;
  }
  assert.ok(moved > 10, `the snitch must move, ${moved} pixels changed`);
});
test('sparkle: a pink field that sparkles, and the sparkles twinkle', () => {
  const f = animFrame({ v: 1, kind: 'anim', name: 'sparkle' }, 1234.5);
  // DOMINANTLY pink is the brief, so measure the whole panel, not one pixel:
  // every cell lit, red high, blue mid, green low. A field that is pink on
  // average can still be a magenta/green wash cell by cell, so check the
  // per-cell relation too.
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let pinkCells = 0;
  let sparkCells = 0;
  for (let i = 0; i < f.length; i += 3) {
    const [r, g, b] = [f[i], f[i + 1], f[i + 2]];
    rSum += r; gSum += g; bSum += b;
    if (r > 235 && b > 215 && b > 170) { sparkCells++; continue; }
    if (r > 60 && r > g + 40 && b > g + 20) pinkCells++;
  }
  // The panel is pink EVERYWHERE except the sparkles. An average-only check
  // passes on a magenta-and-green wash; a per-cell check does not.
  assert.equal(pinkCells + sparkCells, 400, 'every cell is pink or a sparkle, nothing in between');
  assert.ok(sparkCells >= 1 && sparkCells < 60, `sparkles must exist and stay sparse, got ${sparkCells}/400`);
  assert.ok(rSum / 400 > 110, `the field must be bright enough to be a pink WALL, got r=${Math.round(rSum / 400)}`);
  assert.ok(rSum / 400 > bSum / 400 + 20, 'red over blue: rose, not violet');
  assert.ok(bSum / 400 > gSum / 400 + 40, 'blue well over green: pink, not brown');

  // The sparkles: cells driven to near-white-pink, and SPARSE - a sparkle
  // field that covers a third of the panel is snow, not sparkle.
  const sparks = (px) => {
    const out = [];
    for (let i = 0; i < px.length; i += 3) {
      if (px[i] > 235 && px[i + 2] > 215 && px[i + 1] > 170) out.push(i / 3);
    }
    return out;
  };
  const s0 = sparks(f);
  assert.ok(s0.length >= 1, 'a frame must have at least one sparkle');
  assert.ok(s0.length < 60, `sparkles must stay sparse, got ${s0.length}/400`);

  // They TWINKLE: the set of lit sparkles moves over a third of a second,
  // while the pink field underneath stays a field.
  const f2 = animFrame({ v: 1, kind: 'anim', name: 'sparkle' }, 1234.83);
  const s1 = sparks(f2);
  const same = s0.filter((c) => s1.includes(c)).length;
  assert.ok(s0.length > 0 && s1.length > 0, 'both frames sparkle');
  assert.ok(same < Math.max(s0.length, s1.length), 'the same cells must not all be lit twice: that is a static pattern');
  let field = 0;
  for (let i = 0; i < f.length; i += 3) {
    const d = Math.abs(f[i] - f2[i]) + Math.abs(f[i + 1] - f2[i + 1]) + Math.abs(f[i + 2] - f2[i + 2]);
    if (d < 30) field++;
  }
  assert.ok(field > 300, `the pink field must hold still while the sparkles fire, ${field}/400 steady`);

  // Pure like every other animation: the same server second, the same bytes.
  assert.deepEqual(f, animFrame({ v: 1, kind: 'anim', name: 'sparkle' }, 1234.5));
});

import { emptyPixels, pixelsToHex } from '../core/drawings.js';

test('a pic state paints its own cells, and an unused cell is black, not white', () => {
  const p = emptyPixels();
  const put = (x, y, r, g, b) => {
    const i = (y * G + x) * 4;
    p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255;
  };
  put(5, 7, 255, 0, 0);
  put(19, 0, 0, 0, 255);
  const px = animFrame({ v: 1, kind: 'pic', pixels: pixelsToHex(p) }, 100);
  assert.deepEqual(at(px, 5, 7), [255, 0, 0]);
  assert.deepEqual(at(px, 19, 0), [0, 0, 255]);
  assert.deepEqual(at(px, 5, 8), [0, 0, 0], 'a cell with a=0 is the wall being off');
  assert.equal(lit(px), 2);

  // Junk pixels are a black frame, not a throw: the driver pushes every tick.
  assert.equal(lit(animFrame({ v: 1, kind: 'pic', pixels: 'deadbeef' }, 100)), 0);
});

test('gallery is black in the pure generator, NOT the demo (the reported bug)', () => {
  // animFrame's default branch is the demo, which is right for a page that
  // has received no command. A gallery state IS a command: a driver that fell
  // through played confetti where a family drawing belongs.
  assert.equal(lit(animFrame({ v: 1, kind: 'gallery', interval: 5 }, 1791998675.5)), 0);
  // The demo still answers a fresh page.
  assert.ok(lit(animFrame({ v: 1, kind: 'demo' }, 1791998675.5)) > 0);
});

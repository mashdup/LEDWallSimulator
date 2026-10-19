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
  for (const name of ['demo', 'bounce', 'rain', 'fire', 'plasma', 'bars', 'clock']) {
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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel, DEFAULT_COLS, DEFAULT_ROWS, BYTES_PER_PIXEL } from '../core/panel.js';

test('20x20 panel is 400 cells and 1200 bytes', () => {
  const p = new Panel();
  assert.equal(p.cols, DEFAULT_COLS);
  assert.equal(p.rows, DEFAULT_ROWS);
  assert.equal(p.count, 400);
  assert.equal(p.byteLength, 1200);
  assert.equal(p.pixels.length, 1200);
});

test('setPixel/getPixel round-trip at the logical (x,y) address', () => {
  const p = new Panel();
  assert.ok(p.setPixel(3, 7, 10, 20, 30));
  assert.deepEqual(p.getPixel(3, 7), [10, 20, 30]);

  // The byte address is (y*cols + x)*3 — row-major, not column-major.
  const i = (7 * 20 + 3) * 3;
  assert.deepEqual([p.pixels[i], p.pixels[i + 1], p.pixels[i + 2]], [10, 20, 30]);
});

test('corners land where the row-major layout says they should', () => {
  const p = new Panel();
  p.setPixel(0, 0, 1, 0, 0);
  p.setPixel(19, 0, 0, 1, 0);
  p.setPixel(0, 19, 0, 0, 1);
  p.setPixel(19, 19, 1, 1, 1);

  assert.equal(p.pixels[0], 1); // (0,0) -> byte 0
  assert.equal(p.pixels[1 + 19 * 3], 1); // (19,0) -> byte 57
  assert.equal(p.pixels[2 + 19 * 20 * 3], 1); // (0,19) -> byte 1197 channel b
  assert.equal(p.pixels[1199], 1); // (19,19) -> last byte
});

test('out-of-range pixels are clipped, not wrapped or thrown', () => {
  const p = new Panel();
  p.fill(9, 9, 9);
  for (const [x, y] of [[-1, 0], [20, 0], [0, -1], [0, 20], [-1, -1], [99, 99]]) {
    assert.equal(p.setPixel(x, y, 255, 255, 255), false, `setPixel(${x},${y})`);
    assert.equal(p.getPixel(x, y), null, `getPixel(${x},${y})`);
  }
  // Clipping must not have written anywhere: the fill is intact.
  assert.equal(p.pixels.every((v) => v === 9), true);
});

test('clear zeroes everything; fill sets every channel', () => {
  const p = new Panel();
  p.fill(255, 128, 64);
  assert.equal(p.pixels[0], 255);
  assert.equal(p.pixels[1199], 64);
  p.clear();
  assert.equal(p.pixels.reduce((a, v) => a + v, 0), 0);
});

test('toBytes returns a copy, so the sim cannot alias the panel', () => {
  const p = new Panel();
  p.setPixel(0, 0, 42, 42, 42);
  const copy = p.toBytes();
  copy[0] = 0;
  assert.equal(p.getPixel(0, 0)[0], 42);
  assert.notEqual(copy, p.pixels);
});

test('toBytesScaled truncates without mutating the panel', () => {
  const p = new Panel();
  p.fill(200, 100, 50);
  const half = p.toBytesScaled(0.5);
  assert.deepEqual([half[0], half[1], half[2]], [100, 50, 25]);
  assert.equal(p.pixels[0], 200);
});

test('setPixels validates length', () => {
  const p = new Panel();
  assert.throws(() => p.setPixels(new Uint8Array(1199)), RangeError);
  assert.throws(() => p.setPixels(new Uint8Array(1201)), RangeError);
  p.setPixels(new Uint8Array(1200).fill(7));
  assert.equal(p.pixels[600], 7);
});

test('equals compares content, not identity', () => {
  const a = new Panel();
  const b = new Panel();
  assert.ok(a.equals(b));
  b.setPixel(5, 5, 1, 2, 3);
  assert.ok(!a.equals(b));
  assert.ok(!a.equals(new Panel(10, 10)));
});

test('non-positive or fractional dimensions are rejected', () => {
  for (const [c, r] of [[0, 20], [20, 0], [-1, 5], [2.5, 20], [NaN, 20]]) {
    assert.throws(() => new Panel(c, r), RangeError, `Panel(${c}, ${r})`);
  }
});

test('BYTES_PER_PIXEL is 3 and consistent with byteLength', () => {
  assert.equal(BYTES_PER_PIXEL, 3);
  const p = new Panel(4, 3);
  assert.equal(p.byteLength, 4 * 3 * BYTES_PER_PIXEL);
});

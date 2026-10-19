import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID,
  PIXEL_BYTES,
  PIXEL_HEX_LEN,
  emptyPixels,
  pixelsFromHex,
  pixelsToHex,
  isPixelHex,
  parseColor,
  floodFill,
  newDrawing,
  validateEntry,
} from '../core/drawings.js';

/**
 * The drawing model, tested where it lives: core/. The editor page, the
 * server store, the content protocol, and the gallery renderer all import
 * these same functions, so a hex string that round-trips here round-trips
 * all the way to the wall.
 */

test('the grid is the panel: 20x20 RGBA, 1600 bytes, 3200 hex chars', () => {
  assert.equal(GRID, 20);
  assert.equal(PIXEL_BYTES, GRID * GRID * 4);
  assert.equal(PIXEL_HEX_LEN, PIXEL_BYTES * 2);
  assert.equal(emptyPixels().length, PIXEL_BYTES);
});

test('hex round-trips every byte value, and is lowercase', () => {
  const p = emptyPixels();
  for (let i = 0; i < PIXEL_BYTES; i++) p[i] = i % 256;
  const hex = pixelsToHex(p);
  assert.equal(hex.length, PIXEL_HEX_LEN);
  assert.match(hex, /^[0-9a-f]+$/);
  assert.deepEqual(pixelsFromHex(hex), p);
});

test('the wire form is validated by shape, nothing looser', () => {
  assert.ok(isPixelHex(pixelsToHex(emptyPixels())));
  for (const bad of [null, undefined, 42, '', 'zz'.repeat(PIXEL_HEX_LEN / 2),
                     pixelsToHex(emptyPixels()).slice(0, -1), '0x' + '00'.repeat(PIXEL_BYTES)]) {
    assert.equal(isPixelHex(bad), false, String(bad));
    assert.equal(pixelsFromHex(bad), null, String(bad));
  }
});

test('parseColor takes the hex forms the picker and palette emit', () => {
  assert.deepEqual(parseColor('#f80'), [255, 136, 0, 255]);
  assert.deepEqual(parseColor('#ff8800'), [255, 136, 0, 255]);
  assert.deepEqual(parseColor('#ff880080'), [255, 136, 0, 128]);
  for (const bad of ['red', 'rgb(1,2,3)', '#ff880', '', null, '#gggggg']) {
    assert.equal(parseColor(bad), null, String(bad));
  }
});

test('floodFill fills the contiguous region, in place', () => {
  const p = emptyPixels();
  // A wall of opaque blue splits the grid: the left column region only.
  for (let y = 0; y < GRID; y++) {
    const q = (y * GRID + 5) * 4;
    p[q] = 0; p[q + 1] = 0; p[q + 2] = 255; p[q + 3] = 255;
  }
  assert.equal(floodFill(p, 0, 0, [255, 0, 0, 255]), true);
  const at = (x, y) => {
    const q = (y * GRID + x) * 4;
    return [p[q], p[q + 1], p[q + 2], p[q + 3]];
  };
  assert.deepEqual(at(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(4, 19), [255, 0, 0, 255]);
  assert.deepEqual(at(5, 0), [0, 0, 255, 255], 'the wall must stop the flood');
  assert.deepEqual(at(6, 0), [0, 0, 0, 0], 'and it must not cross it');
});

test('filling a region with its own color is a no-op, not a hang', () => {
  const p = emptyPixels();
  // All-transparent grid, filling transparent with transparent: the same-color
  // guard is what stops the flood from recursing over the whole grid forever.
  assert.equal(floodFill(p, 0, 0, [0, 0, 0, 0]), false);
  // Erasing a filled region back to transparent is the same call, and works.
  assert.equal(floodFill(p, 0, 0, [255, 255, 255, 255]), true);
  assert.equal(floodFill(p, 0, 0, [0, 0, 0, 0]), true);
  assert.deepEqual(p, emptyPixels());
});

test('floodFill refuses cells outside the grid', () => {
  const p = emptyPixels();
  for (const [x, y] of [[-1, 0], [0, -1], [GRID, 0], [0, GRID], [1.5, 3], [NaN, 0]]) {
    assert.equal(floodFill(p, x, y, [1, 2, 3, 255]), false, `${x},${y}`);
  }
});

test('a drawing entry has an id, a bounded name, hex pixels, and a timestamp', () => {
  const p = emptyPixels();
  p[0] = 12;
  const e = newDrawing('  hello  ', p, 1234);
  assert.equal(e.name, 'hello');
  assert.equal(e.createdAt, 1234);
  assert.equal(e.pixels, pixelsToHex(p));
  assert.ok(e.id.length > 8, 'a uuid');
  assert.ok(validateEntry(e));
  assert.equal(newDrawing('x'.repeat(200), p).name.length, 40, 'names are bounded');
});

test('validateEntry rejects a malformed store record', () => {
  const good = newDrawing('a', emptyPixels());
  assert.ok(validateEntry(good));
  for (const bad of [null, undefined, 42, 'x', [],
                     { ...good, id: '' },
                     { ...good, name: 'x'.repeat(50) },
                     { ...good, pixels: 'nope' },
                     { ...good, createdAt: 'yesterday' }]) {
    assert.equal(validateEntry(bad), false, JSON.stringify(bad));
  }
});

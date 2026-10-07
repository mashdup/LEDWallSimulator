import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { Layout, identity } from '../core/layout.js';
import { pack, packInto, packScaled, unpack } from '../core/buffer.js';
import { RGB_BYTES } from '../core/frame.js';

test('pack produces exactly 1200 bytes', () => {
  const p = new Panel();
  const bytes = pack(p, new Layout());
  assert.equal(bytes.length, 1200);
  assert.equal(bytes.length, RGB_BYTES);
});

/**
 * The plan's acceptance criterion: "verify a known pattern packs to the
 * expected 1200 bytes". A single lit cell must land on exactly one byte
 * triplet, at the physical index the layout says.
 */
test('a known pattern lands on the expected physical offsets', () => {
  const layout = new Layout(); // serpentine, 20 rows of 20
  const p = new Panel();
  p.setPixel(0, 0, 255, 0, 0); // physical 0
  p.setPixel(19, 0, 0, 255, 0); // physical 19
  p.setPixel(0, 1, 0, 0, 255); // physical 39 (row 1 is snaked)
  p.setPixel(19, 1, 1, 2, 3); // physical 20

  const b = pack(p, layout);
  assert.equal(b.length, 1200);

  assert.deepEqual([b[0], b[1], b[2]], [255, 0, 0]);
  assert.deepEqual([b[19 * 3], b[19 * 3 + 1], b[19 * 3 + 2]], [0, 255, 0]);
  assert.deepEqual([b[39 * 3], b[39 * 3 + 1], b[39 * 3 + 2]], [0, 0, 255]);
  assert.deepEqual([b[20 * 3], b[20 * 3 + 1], b[20 * 3 + 2]], [1, 2, 3]);

  // Nothing else lit: exactly 4 triplets nonzero.
  let lit = 0;
  for (let i = 0; i < b.length; i += 3) if (b[i] || b[i + 1] || b[i + 2]) lit++;
  assert.equal(lit, 4);
});

test('pack with identity layout is a straight copy of logical order', () => {
  const p = new Panel();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) p.setPixel(x, y, x, y, (x + y) & 255);
  assert.deepEqual(Array.from(pack(p, identity())), Array.from(p.toBytes()));
});

test('pack is a permutation: every source triplet appears exactly once', () => {
  const layout = new Layout();
  const p = new Panel();
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const v = y * 20 + x; // unique per cell, split across two channels
      p.setPixel(x, y, v & 0xff, v >> 8, 0);
    }
  }
  const b = pack(p, layout);
  const seen = new Set();
  for (let i = 0; i < b.length; i += 3) {
    assert.equal(b[i + 2], 0);
    const key = b[i] | (b[i + 1] << 8);
    assert.ok(!seen.has(key), `cell ${key} duplicated`);
    seen.add(key);
  }
  assert.equal(seen.size, 400);
  assert.equal([...seen].sort((a, c) => a - c).join(','), Array.from({ length: 400 }, (_, k) => k).join(','));
});

test('packInto reuses a scratch buffer without allocating', () => {
  const layout = new Layout();
  const scratch = new Uint8Array(1200);
  const p = new Panel();
  p.setPixel(0, 1, 7, 7, 7);
  const out = packInto(p, layout, scratch);
  assert.equal(out, scratch);
  assert.deepEqual([scratch[39 * 3], scratch[39 * 3 + 1], scratch[39 * 3 + 2]], [7, 7, 7]);
});

test('packInto rejects a scratch buffer of the wrong size', () => {
  assert.throws(() => packInto(new Panel(), new Layout(), new Uint8Array(1199)), RangeError);
});

test('pack rejects a panel/layout size mismatch', () => {
  assert.throws(() => pack(new Panel(10, 10), new Layout()), RangeError);
});

test('unpack is the exact inverse of pack', () => {
  const layout = new Layout();
  const p = new Panel();
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) p.setPixel(x, y, (x * 13) & 255, (y * 7) & 255, (x * y) & 255);
  }
  const round = unpack(pack(p, layout), layout);
  assert.ok(round.equals(p));
});

/**
 * The "what the wall actually sees" preview: pack with the real (wrong) layout,
 * unpack with identity. A wiring mistake must show up as scrambled content
 * rather than being silently corrected.
 */
test('packing with a wrong layout and unpacking with identity scrambles visibly', () => {
  const wrong = new Layout({ flipX: true, snake: false });
  const p = new Panel();
  p.setPixel(0, 0, 255, 255, 255); // logical top-left

  const asSeen = unpack(pack(p, wrong), identity());
  // flipX puts logical (0,0) at physical 19, so the wall lights cell (19,0).
  assert.deepEqual(asSeen.getPixel(19, 0), [255, 255, 255]);
  assert.deepEqual(asSeen.getPixel(0, 0), [0, 0, 0]);
  assert.ok(!asSeen.equals(p), 'a wrong layout must not round-trip to the same image');
});

test('unpack validates length', () => {
  assert.throws(() => unpack(new Uint8Array(1197), new Layout()), RangeError);
  assert.throws(() => unpack(new Uint8Array(1203), new Layout()), RangeError);
});

test('packScaled applies brightness in physical order without touching the panel', () => {
  const layout = new Layout();
  const p = new Panel();
  p.setPixel(0, 1, 200, 100, 50); // physical 39
  const b = packScaled(p, layout, 0.5);
  assert.deepEqual([b[39 * 3], b[39 * 3 + 1], b[39 * 3 + 2]], [100, 50, 25]);
  assert.deepEqual(p.getPixel(0, 1), [200, 100, 50]);
});

test('packScaled(1) equals pack', () => {
  const layout = new Layout();
  const p = new Panel();
  for (let i = 0; i < 400; i++) p.setPixel(i % 20, (i / 20) | 0, i & 255, (i * 3) & 255, 0);
  assert.deepEqual(Array.from(packScaled(p, layout, 1)), Array.from(pack(p, layout)));
});

test('pack handles a mid-row-folding strip layout', () => {
  const layout = new Layout({ stripLength: 50, snake: true });
  const p = new Panel();
  p.setPixel(0, 2, 9, 9, 9); // physical 40
  p.setPixel(10, 2, 8, 8, 8); // physical 99 (snaked strip 1)
  const b = pack(p, layout);
  assert.deepEqual([b[40 * 3], b[40 * 3 + 1], b[40 * 3 + 2]], [9, 9, 9]);
  assert.deepEqual([b[99 * 3], b[99 * 3 + 1], b[99 * 3 + 2]], [8, 8, 8]);
  assert.ok(unpack(b, layout).equals(p));
});

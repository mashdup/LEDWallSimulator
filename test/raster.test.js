import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { downsampleArea, downsampleAreaRGB, blitArea } from '../core/raster.js';

/**
 * Helpers build sources in source-pixel space. `pxPerCell` ties the two spaces
 * together: a source of w*h pixels expressing `cells` cells means each
 * destination cell covers w/cells source pixels.
 */
function rgba(w, h, fill = (x, y) => [0, 0, 0, 0]) {
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

const opaque = (r, g, b) => (x, y) => [r, g, b, 255];
const cell = (out, dstW, dx) => [out[dx * 3], out[dx * 3 + 1], out[dx * 3 + 2]];

// -------------------------------------------------------------------------
// Coverage is brightness
// -------------------------------------------------------------------------
/** Red channel of every destination cell in row 0. */
const row = (out, dstW) => Array.from({ length: dstW }, (_, dx) => out[dx * 3]);

test('a fully covered cell keeps the source colour exactly', () => {
  // 4 source px per cell, all opaque white.
  const out = downsampleArea(rgba(4, 1, opaque(255, 255, 255)), 4, 1, 1, 1);
  assert.deepEqual(cell(out, 1, 0), [255, 255, 255]);
});

test('half-covered cell is half as bright as fully covered', () => {
  // 4 source px, 2 opaque white then 2 transparent -> 50% coverage.
  const src = rgba(4, 1, (x) => (x < 2 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const out = downsampleArea(src, 4, 1, 1, 1);
  assert.deepEqual(cell(out, 1, 0), [127, 127, 127]);
});

test('a single antialiased fringe pixel is a fringe, not full brightness', () => {
  // 4 source px, one at alpha 1 -> 1/4 coverage * 1/255 alpha.
  const src = rgba(4, 1, (x) => (x === 0 ? [255, 255, 255, 1] : [0, 0, 0, 0]));
  const out = downsampleArea(src, 4, 1, 1, 1);
  assert.deepEqual(cell(out, 1, 0), [0, 0, 0]);

  // alpha 64 on one of four px -> 64/4 = 16.
  const src2 = rgba(4, 1, (x) => (x === 0 ? [255, 255, 255, 64] : [0, 0, 0, 0]));
  assert.deepEqual(cell(downsampleArea(src2, 4, 1, 1, 1), 1, 0), [16, 16, 16]);
});

test('area averaging, not nearest neighbour: a 2x2 source in a 4x4 cell averages', () => {
  // Source is 2x2 px expressing 0.5 cells, so one destination cell covers a
  // 4x4 source area of which only the 2x2 top-left is lit.
  const src = rgba(2, 2, opaque(200, 100, 50));
  const out = downsampleArea(src, 2, 2, 1, 1, { srcCells: 0.5, srcCellH: 0.5 });
  // 4 lit px of a 16 px cell area -> 1/4 brightness.
  assert.deepEqual(cell(out, 1, 0), [50, 25, 12]);
});

test('area outside the source counts as transparent', () => {
  // The source is 1 cell wide (2 px at srcCells 1) but we ask for 2
  // destination cells: the second one has no source at all and must come back
  // black rather than inherit the first cell's colour.
  const src = rgba(2, 1, opaque(255, 255, 255));
  const out = downsampleArea(src, 2, 1, 2, 1, { srcCells: 1 });
  assert.deepEqual(cell(out, 2, 0), [255, 255, 255]);
  assert.deepEqual(cell(out, 2, 1), [0, 0, 0]);
});

test('a half-cell offset splits coverage between two cells', () => {
  // Source: 2 px = 2 cells, opaque white. Shifted half a cell, cell 0 covers
  // source [-0.5, 0.5) -> half a pixel of ink; cell 1 covers [0.5, 1.5) -> a
  // whole pixel; cell 2 covers [1.5, 2.5) -> half again.
  const src = rgba(2, 1, opaque(255, 255, 255));
  const out = downsampleArea(src, 2, 1, 4, 1, { srcCells: 2, offsetX: 0.5 });
  assert.deepEqual(row(out, 4), [127, 255, 127, 0]);
});

test('sub-cell shifts produce a brightness ramp, not a whole-cell jump', () => {
  // Same 2-cell opaque block sampled at quarter-cell steps: cell 0's value
  // must fall off one step at a time, which is what makes text glide instead
  // of stepping a whole cell per tick.
  const src = rgba(2, 1, opaque(255, 255, 255));
  const ramp = [0, 0.25, 0.5, 0.75, 1].map(
    (ox) => cell(downsampleArea(src, 2, 1, 4, 1, { srcCells: 2, offsetX: ox }), 4, 0)[0],
  );
  assert.deepEqual(ramp, [255, 191, 127, 63, 0]);
  // Strictly decreasing over the shift: no plateau-then-cliff.
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] < ramp[i - 1], `ramp ${ramp}`);
});

test('total coverage is conserved under a sub-cell shift', () => {
  // Moving the source must not create or destroy ink: the sum over all cells
  // stays constant while the distribution changes. 8 lit px over 8 cells of
  // 1 px each = 8 * 255 = 2040.
  const src = rgba(8, 1, opaque(255, 255, 255));
  const total = (ox) => {
    const out = downsampleArea(src, 8, 1, 10, 1, { srcCells: 8, offsetX: ox });
    return row(out, 10).reduce((a, b) => a + b, 0);
  };
  const at = [0, 0.3, 0.5, 0.7, 1].map(total);
  for (const v of at) assert.ok(Math.abs(v - 2040) <= 4, `coverage ${v} at offset`);
});

// -------------------------------------------------------------------------
// Buffer reuse
// -------------------------------------------------------------------------

test('a reused out buffer is fully rewritten — no stale pixels from the last frame', () => {
  const out = new Uint8Array(2 * 3);
  out.fill(255);
  const src = rgba(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  downsampleArea(src, 2, 1, 2, 1, { out });
  assert.deepEqual(cell(out, 2, 0), [255, 255, 255]);
  assert.deepEqual(cell(out, 2, 1), [0, 0, 0], 'uncovered cell must be zeroed, not left lit');
});

// -------------------------------------------------------------------------
// Colour mixing
// -------------------------------------------------------------------------

test('a mixed cell is the alpha-weighted mean colour', () => {
  // 2 px, 1 cell: red at full alpha, blue at full alpha -> mean.
  const src = rgba(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  assert.deepEqual(cell(downsampleArea(src, 2, 1, 1, 1), 1, 0), [127, 0, 127]);
});

test('alpha weights colour and coverage together', () => {
  // Red at alpha 255, blue at alpha 51, over a 2px cell:
  // R = 255*255 / (2*255) = 127, B = 255*51 / (2*255) = 25.
  const src = rgba(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 51]));
  assert.deepEqual(cell(downsampleArea(src, 2, 1, 1, 1), 1, 0), [127, 0, 25]);
});

test('downsampleAreaRGB treats a plain RGB source as fully opaque', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0]);
  assert.deepEqual(cell(downsampleAreaRGB(rgb, 2, 1, 1, 1), 1, 0), [127, 127, 0]);
});

// -------------------------------------------------------------------------
// blitArea
// -------------------------------------------------------------------------

test('blitArea writes into a panel at a cell offset', () => {
  const p = new Panel(4, 2);
  const src = rgba(2, 2, opaque(200, 100, 50));
  blitArea(p, src, 2, 2, { cellX: 1, cellY: 1 });
  assert.deepEqual(p.getPixel(1, 1), [200, 100, 50]);
  assert.deepEqual(p.getPixel(0, 0), [0, 0, 0]);
});

test('blitArea clips cells that fall off the panel', () => {
  const p = new Panel(2, 1);
  const src = rgba(4, 1, opaque(255, 255, 255));
  blitArea(p, src, 4, 1, { cellX: 1 });
  assert.deepEqual(p.getPixel(1, 0), [255, 255, 255]);
  assert.equal(p.getPixel(2, 0), null);
  // Nothing written outside the grid, and the in-bounds cell is intact.
  assert.deepEqual(p.getPixel(0, 0), [0, 0, 0]);
});

test('blitArea modes: replace overwrites, add saturates, max keeps the brighter', () => {
  const src = rgba(1, 1, opaque(200, 200, 200));

  const rep = new Panel(1, 1);
  rep.setPixel(0, 0, 10, 10, 10);
  blitArea(rep, src, 1, 1);
  assert.deepEqual(rep.getPixel(0, 0), [200, 200, 200]);

  const add = new Panel(1, 1);
  add.setPixel(0, 0, 100, 100, 100);
  blitArea(add, src, 1, 1, { mode: 'add' });
  assert.deepEqual(add.getPixel(0, 0), [255, 255, 255], 'add must saturate at 255, not wrap');

  const max = new Panel(1, 1);
  max.setPixel(0, 0, 250, 50, 250);
  blitArea(max, src, 1, 1, { mode: 'max' });
  assert.deepEqual(max.getPixel(0, 0), [250, 200, 250], 'max keeps the brighter channel per channel');
});

test('blitArea opacity scales the ink it writes', () => {
  const p = new Panel(1, 1);
  const src = rgba(1, 1, opaque(255, 255, 255));
  blitArea(p, src, 1, 1, { opacity: 0.5 });
  assert.deepEqual(p.getPixel(0, 0), [127, 127, 127]);
});

test('blitArea with a scratch buffer does not allocate per call', () => {
  const scratch = new Uint8Array(2 * 2 * 3);
  const p = new Panel(2, 2);
  const src = rgba(2, 2, opaque(120, 60, 30));
  blitArea(p, src, 2, 2, { scratch });
  assert.deepEqual(p.getPixel(0, 0), [120, 60, 30]);
  assert.equal(scratch.length, 12);
});

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

test('bad dimensions and short buffers are rejected', () => {
  const src = rgba(2, 1, opaque(255, 255, 255));
  assert.throws(() => downsampleArea(src, 0, 1, 1, 1), /source must be >= 1x1/);
  assert.throws(() => downsampleArea(src, 2, 1, 0, 1), /destination must be >= 1x1/);
  assert.throws(() => downsampleArea(src, 4, 1, 1, 1), /source buffer too small: need 16 bytes, got 8/);
  assert.throws(
    () => downsampleArea(src, 2, 1, 1, 1, { srcCells: 0 }),
    /srcCells\/srcCellH must be > 0/,
  );
});

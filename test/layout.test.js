import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { Layout, LAYOUT_DEFAULTS, identity, layoutVariants } from '../core/layout.js';

/**
 * The layout map is the one file that changes when the wiring is real, so its
 * semantics are pinned hard here: strip axis, snake direction, offsets, flips.
 */

test('default layout: 20 rows of 20, serpentine', () => {
  const l = new Layout();
  assert.equal(l.count, 400);
  assert.equal(l.strips, 20);
  assert.equal(l.stripLength, 20);

  // Row 0 runs forwards.
  assert.equal(l.index(0, 0), 0);
  assert.equal(l.index(19, 0), 19);
  // Row 1 is snaked: it starts at 39 and runs backwards.
  assert.equal(l.index(0, 1), 39);
  assert.equal(l.index(19, 1), 20);
  // Row 2 runs forwards again.
  assert.equal(l.index(0, 2), 40);
  assert.equal(l.index(19, 2), 59);
  // Last row.
  assert.equal(l.index(0, 19), 399);
  assert.equal(l.index(19, 19), 380);
});

test('snake:false gives a plain row-major raster', () => {
  const l = new Layout({ snake: false });
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) assert.equal(l.index(x, y), y * 20 + x);
  }
});

test('stripAxis:"y" makes a strip a column', () => {
  const l = new Layout({ stripAxis: 'y' });
  assert.equal(l.index(0, 0), 0);
  assert.equal(l.index(0, 19), 19); // column 0, snaked? no: strip 0 is column 0
  assert.equal(l.index(1, 0), 39); // column 1 is strip 1 -> reversed
  assert.equal(l.index(1, 19), 20);
});

test('startOffsets relocate individual strips', () => {
  // A spliced data line where the whole chain is rotated by one strip:
  // strip 0 physically begins at LED 20, and strip 19 wraps to LED 0.
  const offsets = Array.from({ length: 20 }, (_, i) => ((i + 1) % 20) * 20);
  const l = new Layout({ startOffsets: offsets, snake: false });
  assert.equal(l.index(0, 0), 20);
  assert.equal(l.index(19, 0), 39);
  assert.equal(l.index(0, 1), 40);
  assert.equal(l.index(0, 19), 0);
  assertPermutation(l);
});

test('startOffsets that overlap are rejected, not silently half-dark', () => {
  // strip 1 shifted to 25 collides with strip 2 at 40: the wall would have
  // dead pixels, so construction must fail.
  const offsets = Array.from({ length: 20 }, (_, i) => (i === 1 ? 25 : i * 20));
  assert.throws(() => new Layout({ startOffsets: offsets, snake: false }), /claimed by cells/);
});

test('startOffsets length must match the strip count', () => {
  assert.throws(() => new Layout({ startOffsets: [0, 1] }), RangeError);
  assert.throws(() => new Layout({ startOffsets: new Array(20).fill(-1) }), RangeError);
});

test('flipX mirrors columns; flipY mirrors rows', () => {
  const base = new Layout({ snake: false });
  const fx = new Layout({ snake: false, flipX: true });
  const fy = new Layout({ snake: false, flipY: true });

  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      assert.equal(fx.index(x, y), base.index(19 - x, y), `flipX(${x},${y})`);
      assert.equal(fy.index(x, y), base.index(x, 19 - y), `flipY(${x},${y})`);
    }
  }
});

test('flips compose with snake without breaking the permutation', () => {
  const l = new Layout({ snake: true, flipX: true, flipY: true });
  assertPermutation(l);
});

test('transpose maps a rotated grid', () => {
  const l = new Layout({ transpose: true, snake: false });
  // transpose swaps the wiring coordinates, so the raster becomes column-major:
  // cell (x,y) lands on physical x*cols + y.
  assert.equal(l.index(3, 7), 3 * 20 + 7);
  assert.equal(l.index(0, 0), 0);
  assert.equal(l.index(19, 19), 19 * 20 + 19);
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) assert.equal(l.index(x, y), x * 20 + y);
  }
  assertPermutation(l);
});

test('transpose on a non-square grid is rejected rather than silently wrong', () => {
  assert.throws(() => new Layout({ cols: 20, rows: 10, transpose: true, stripLength: 10 }), RangeError);
});

test('stripLength must divide the pixel count', () => {
  assert.throws(() => new Layout({ stripLength: 7 }), RangeError);
  assert.throws(() => new Layout({ stripLength: 0 }), RangeError);
  assert.throws(() => new Layout({ stripLength: 400 * 20 }), RangeError);
});

test('a strip may fold mid-row, which is what a spliced curtain does', () => {
  // 50-LED strips on a 20-wide grid: strip 0 covers rows 0-1 plus 10 cells of
  // row 2. Serpentine folds alternate, and the map is still a permutation.
  const l = new Layout({ stripLength: 50, snake: true });
  assert.equal(l.strips, 8);
  assert.equal(l.index(0, 0), 0);
  assert.equal(l.index(19, 1), 39);
  assert.equal(l.index(0, 2), 40); // continues into row 2
  assert.equal(l.index(9, 2), 49); // strip 0 ends mid-row
  assert.equal(l.index(10, 2), 99); // strip 1 is snaked, so it runs backwards
  assertPermutation(l);

  assertPermutation(new Layout({ stripAxis: 'y', stripLength: 40, snake: true }));
});

test('a bad layout that double-claims an LED fails at construction', () => {
  // stripLength 20 with every strip offset to 0 maps 20 cells onto LEDs 0..19.
  const offsets = new Array(20).fill(0);
  assert.throws(() => new Layout({ startOffsets: offsets }), /claimed by cells/);
});

test('a layout that maps past the end of the strip fails at construction', () => {
  const offsets = new Array(20).fill(0).map((_, i) => i * 20 + 5); // last strip ends at 404
  assert.throws(() => new Layout({ startOffsets: offsets }), /outside 0\.\./);
});

test('inverse is the exact inverse of map', () => {
  const l = new Layout();
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const p = l.index(x, y);
      assert.deepEqual(l.cellOf(p), [x, y], `cellOf(${p}) for (${x},${y})`);
    }
  }
});

test('index() clips out-of-range coordinates to -1', () => {
  const l = new Layout();
  assert.equal(l.index(-1, 0), -1);
  assert.equal(l.index(0, 20), -1);
  assert.equal(l.index(20, 20), -1);
});

test('with() is immutable and returns a new Layout', () => {
  const a = new Layout();
  const b = a.with({ snake: false });
  assert.notEqual(a, b);
  assert.equal(a.snake, true);
  assert.equal(b.snake, false);
  assert.equal(b.stripLength, a.stripLength);
  assert.equal(b.cols, a.cols);
});

test('identity() is the reference frame for the wiring preview', () => {
  const l = identity();
  for (let c = 0; c < 400; c++) {
    const x = c % 20;
    const y = (c / 20) | 0;
    assert.equal(l.index(x, y), c);
  }
});

test('layoutVariants enumerates 8 distinct mountings', () => {
  const variants = [...layoutVariants()];
  assert.equal(variants.length, 8);
  const signatures = new Set(variants.map((v) => JSON.stringify(v.map)));
  assert.equal(signatures.size, 8, 'variants must be distinguishable by their map');
  for (const v of variants) assertPermutation(v);
});

test('LAYOUT_DEFAULTS describes a 20x20 panel', () => {
  assert.equal(LAYOUT_DEFAULTS.cols, 20);
  assert.equal(LAYOUT_DEFAULTS.rows, 20);
  assert.equal(LAYOUT_DEFAULTS.stripLength, 20);
  assert.equal(LAYOUT_DEFAULTS.stripAxis, 'x');
});

test('describe() and preview() are usable during calibration', () => {
  const l = new Layout();
  assert.match(l.describe(), /20x20 rows of 20/);
  assert.match(l.describe(), /snake/);
  const lines = l.preview().split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[0].trim().split(/\s+/).length, 20);
});

/** Every physical LED claimed exactly once — the wall has no dead pixels. */
function assertPermutation(l) {
  const seen = new Set();
  for (let y = 0; y < l.rows; y++) {
    for (let x = 0; x < l.cols; x++) {
      const p = l.index(x, y);
      assert.ok(p >= 0 && p < l.count, `index(${x},${y}) = ${p}`);
      assert.ok(!seen.has(p), `LED ${p} claimed twice`);
      seen.add(p);
    }
  }
  assert.equal(seen.size, l.count);
}

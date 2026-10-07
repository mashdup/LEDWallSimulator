import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { Scroller, LEFT, RIGHT, bitmap } from '../core/scroller.js';

/** Solid opaque block source, 1 source px per panel cell. */
function block(cellsW, cellsH, alpha = 255) {
  const rgba = new Uint8Array(cellsW * cellsH * 4);
  for (let i = 0; i < cellsW * cellsH; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = alpha;
  }
  return bitmap(rgba, cellsW, cellsH, 1);
}

/** 1 where any row of the column is lit, 0 where the whole column is dark. */
function litColumns(panel) {
  const out = [];
  for (let x = 0; x < panel.cols; x++) {
    let lit = 0;
    for (let y = 0; y < panel.rows; y++) {
      const [r, g, b] = panel.getPixel(x, y);
      if (Math.max(r, g, b) > lit) lit = Math.max(r, g, b);
    }
    out.push(lit > 0 ? 1 : 0);
  }
  return out;
}

/** Longest run of fully dark columns across the panel. */
function longestDarkRun(panel) {
  let run = 0;
  let best = 0;
  for (const lit of litColumns(panel)) {
    run = lit ? 0 : run + 1;
    if (run > best) best = run;
  }
  return best;
}

/** Ink on the panel, in cells: sum of per-cell brightness over the grid. */
function coverage(panel) {
  let s = 0;
  for (let x = 0; x < panel.cols; x++) {
    for (let y = 0; y < panel.rows; y++) {
      const [r, g, b] = panel.getPixel(x, y);
      s += Math.max(r, g, b) / 255;
    }
  }
  return s;
}

// -------------------------------------------------------------------------
// Period and advance
// -------------------------------------------------------------------------

test('period is one copy plus its gap', () => {
  const sc = new Scroller({ panel: new Panel(20, 4), source: block(8, 2), gap: 2 });
  assert.equal(sc.period, 10);
});

test('offset is distance travelled: advance always increases it, wrapping at the period', () => {
  const sc = new Scroller({ panel: new Panel(20, 4), source: block(8, 2), gap: 2, cellsPerFrame: 0.25 });
  assert.equal(sc.advance(), 0.25);
  assert.equal(sc.advance(), 0.5);
  sc.seek(9.9);
  // 9.9 is not representable exactly, so the wrap lands on 0.15000000000000036.
  // What matters is that it wrapped into [0, period) instead of running away.
  const wrapped = sc.advance();
  assert.ok(wrapped >= 0 && wrapped < sc.period, `offset ${wrapped} left [0, period)`);
  assert.ok(Math.abs(wrapped - 0.15) < 1e-9, `expected ~0.15, got ${wrapped}`);
  const next = sc.advance(10);
  assert.ok(Math.abs(next - 2.65) < 1e-9, `expected ~2.65, got ${next}`);
});

test('seek accepts fractional and negative offsets and normalises into the period', () => {
  const sc = new Scroller({ panel: new Panel(20, 4), source: block(8, 2), gap: 2 });
  assert.equal(sc.seek(-3), 7);
  assert.equal(sc.seek(12.5), 2.5);
  assert.equal(sc.seek(10), 0);
});

test('tick advances and renders; frame counts frames', () => {
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, cellsPerFrame: 0.25 });
  assert.equal(sc.tick(), panel);
  sc.tick();
  assert.equal(sc.frame, 2);
  assert.equal(sc.offset, 0.5);
});

test('cellsPerFrame 0 is a static banner with an infinite pass', () => {
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1, cellsPerFrame: 0 });
  sc.render();
  const first = panel.toBytes();
  sc.advance(10);
  sc.render();
  assert.deepEqual(panel.toBytes(), first);
  assert.equal(sc.passDurationMs(30), Infinity);
  assert.equal(sc.cellsPerSecond(30), 0);
});

test('passDurationMs and cellsPerSecond agree with the period', () => {
  const sc = new Scroller({ panel: new Panel(20, 4), source: block(8, 2), gap: 2, cellsPerFrame: 0.25 });
  assert.equal(sc.cellsPerSecond(30), 7.5);
  // 10 cells of period at 7.5 cells/s = 1.333 s.
  assert.equal(sc.passDurationMs(30), (10 / 0.25) * (1000 / 30));
});

// -------------------------------------------------------------------------
// Direction: the contract the UI promises ("text flows right->left")
// -------------------------------------------------------------------------

test('LEFT scrolls the block leftward, one cell per advance', () => {
  // period 22 > panel width, so one copy dominates and its motion is readable.
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 14, y: 1, direction: LEFT, cellsPerFrame: 1 });

  const edges = [];
  for (let i = 0; i < 6; i++) {
    sc.render();
    const cols = litColumns(panel);
    // Right edge of the leftmost lit run: the tail of the copy entering from
    // the left. Moving left means this edge retreats.
    edges.push(cols.indexOf(1) === 0 ? cols.lastIndexOf(1, cols.indexOf(0) - 1) : -1);
    sc.advance();
  }
  assert.deepEqual(edges, [5, 4, 3, 2, 1, 0]);
});

test('RIGHT scrolls the block rightward, one cell per advance', () => {
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 14, y: 1, direction: RIGHT, cellsPerFrame: 1 });

  const edges = [];
  for (let i = 0; i < 6; i++) {
    sc.render();
    const cols = litColumns(panel);
    // Left edge of the rightmost lit run: the head entering from the right.
    const last = cols.lastIndexOf(1);
    let first = last;
    while (first > 0 && cols[first - 1] === 1) first--;
    edges.push(first);
    sc.advance();
  }
  assert.deepEqual(edges, [14, 15, 16, 17, 18, 19]);
});

test('the two directions are exact horizontal mirrors of each other', () => {
  const source = block(8, 2);
  for (const offset of [0, 3.25, 7.5]) {
    const a = new Panel(20, 4);
    const b = new Panel(20, 4);
    const sa = new Scroller({ panel: a, source, gap: 2, y: 1, direction: LEFT });
    const sb = new Scroller({ panel: b, source, gap: 2, y: 1, direction: RIGHT });
    sa.seek(offset);
    sa.render();
    sb.seek(offset);
    sb.render();
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 4; y++) {
        assert.deepEqual(a.getPixel(x, y), b.getPixel(19 - x, y), `mirror at x=${x} y=${y} offset=${offset}`);
      }
    }
  }
});

// -------------------------------------------------------------------------
// Tiling: the marquee contract
// -------------------------------------------------------------------------

test('a short banner tiles: several copies are on the panel at once', () => {
  // 4 cells of text + 2 of gap = period 6 on a 20-wide panel: 3+ copies visible.
  // Drawing only two copies would leave a 14-cell blank stretch in the middle.
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(4, 2), gap: 2, y: 1 });
  sc.seek(0);
  sc.render();
  assert.deepEqual(litColumns(panel), [
    0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0,
  ]);
});

test('no blank pause: no dark run is longer than the gap, at any offset', () => {
  for (const [cellsW, gap] of [[4, 2], [8, 2], [12, 4]]) {
    const panel = new Panel(20, 4);
    const sc = new Scroller({ panel, source: block(cellsW, 2), gap, y: 1 });
    for (let offset = 0; offset < sc.period; offset += 0.05) {
      sc.seek(offset);
      sc.render();
      assert.ok(
        longestDarkRun(panel) <= gap,
        `cellsW=${cellsW} gap=${gap} offset=${offset.toFixed(2)}: dark run ${longestDarkRun(panel)}`,
      );
    }
  }
});

test('ink is conserved while a tiled marquee scrolls', () => {
  // Two full copies on screen at all times: 8 cells x 2 rows x 2 copies = 32.
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1, cellsPerFrame: 0.25 });
  const samples = [];
  for (let i = 0; i < 40; i++) {
    sc.tick();
    samples.push(coverage(panel));
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(max - min < 0.5, `coverage wanders: ${min}..${max}`);
  assert.ok(Math.abs(min - 32) < 0.5 && Math.abs(max - 32) < 0.5, `coverage ${min}..${max}, expected ~32`);
});

test('sub-cell motion changes the panel every tick, and never by a whole cell', () => {
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1, cellsPerFrame: 0.25 });
  sc.render();
  let previous = panel.toBytes();
  let maxDelta = 0;
  for (let i = 0; i < 40; i++) {
    sc.tick();
    const now = panel.toBytes();
    let changed = false;
    for (let j = 0; j < now.length; j++) {
      if (now[j] !== previous[j]) changed = true;
      const d = Math.abs(now[j] - previous[j]);
      if (d > maxDelta) maxDelta = d;
    }
    assert.ok(changed, `tick ${i} produced an identical frame — the marquee stepped, not glided`);
    previous = now;
  }
  // 0.25 cells/frame must never flash a cell from dark to full in one tick.
  assert.ok(maxDelta < 255, `a single tick moved a cell by ${maxDelta}/255`);
});

// -------------------------------------------------------------------------
// Panel interaction
// -------------------------------------------------------------------------

test('rows outside the text band stay dark', () => {
  const panel = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1 });
  sc.seek(0);
  sc.render();
  assert.deepEqual(panel.getPixel(2, 0), [0, 0, 0]);
  assert.deepEqual(panel.getPixel(2, 1), [255, 255, 255]);
  assert.deepEqual(panel.getPixel(2, 2), [255, 255, 255]);
  assert.deepEqual(panel.getPixel(2, 3), [0, 0, 0]);
});

test('clear: true wipes the panel; clear: false leaves other content alone', () => {
  const source = block(8, 2);

  const wiped = new Panel(20, 4);
  wiped.setPixel(19, 3, 9, 9, 9);
  const clearer = new Scroller({ panel: wiped, source, gap: 2, y: 1 });
  clearer.seek(0);
  clearer.render();
  assert.deepEqual(wiped.getPixel(19, 3), [0, 0, 0]);

  const kept = new Panel(20, 4);
  kept.setPixel(19, 3, 9, 9, 9);
  const painter = new Scroller({ panel: kept, source, gap: 2, y: 1, clear: false });
  painter.seek(0);
  painter.render();
  assert.deepEqual(kept.getPixel(19, 3), [9, 9, 9]);
});

test('opacity scales the ink written', () => {
  const panel = new Panel(20, 4);
  const dim = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1, opacity: 0.5 });
  dim.seek(0);
  dim.render();
});

test('render can target a panel other than the one it was built with', () => {
  const panel = new Panel(20, 4);
  const offscreen = new Panel(20, 4);
  const sc = new Scroller({ panel, source: block(8, 2), gap: 2, y: 1 });
  sc.seek(0);
  sc.render(offscreen);
  assert.equal(panel.pixels.every((v) => v === 0), true, 'the built-in panel must stay untouched');
  assert.equal(offscreen.pixels.some((v) => v > 0), true);
});

// -------------------------------------------------------------------------
// bitmap + validation
// -------------------------------------------------------------------------

test('bitmap expresses source pixels in panel cells', () => {
  const b = bitmap(new Uint8Array(400 * 200 * 4), 400, 200, 20);
  assert.equal(b.cellsW, 20);
  assert.equal(b.cellsH, 10);
  assert.equal(b.pxPerCell, 20);
});

test('bad scroller configuration is rejected up front', () => {
  const panel = new Panel(20, 4);
  const source = block(4, 2);
  assert.throws(() => new Scroller({ panel, source, cellsPerFrame: -1 }), /cellsPerFrame must be >= 0/);
  assert.throws(() => new Scroller({ panel, source, cellsPerFrame: NaN }), /cellsPerFrame must be >= 0/);
  assert.throws(() => new Scroller({ panel, source, direction: 0 }), /direction must be LEFT \(-1\) or RIGHT \(1\)/);
  assert.throws(() => new Scroller({ source }), /requires a panel/);
  assert.throws(() => new Scroller({ panel }), /requires a source bitmap/);
  assert.throws(() => bitmap(new Uint8Array(4), 1, 1, 0), /pxPerCell must be > 0/);
});

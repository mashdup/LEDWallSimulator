import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { bitmap } from '../core/scroller.js';
import { Panner, fitRect, fillRect, DOWN, UP } from '../core/panner.js';

/**
 * Tall banded source: 40x400 px in four 100 px bands (red, green, blue, white),
 * so "which part of the page is on the grid" is readable straight off the panel.
 * At 2 px per cell that is 20 x 200 cells: 10x taller than the grid.
 */
const BANDS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];

function bands(cellsW, cellsH, pxPerCell = 2) {
  const w = cellsW * pxPerCell;
  const h = cellsH * pxPerCell;
  const rgba = new Uint8Array(w * h * 4);
  const bandH = h / BANDS.length;
  for (let y = 0; y < h; y++) {
    const [r, g, b] = BANDS[Math.floor(y / bandH)];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return bitmap(rgba, w, h, pxPerCell);
}

/** Name of the band a panel is showing, or 'mixed' if it spans a boundary. */
function band(panel) {
  const names = new Set();
  for (let y = 0; y < panel.rows; y++) {
    for (let x = 0; x < panel.cols; x++) {
      const [r, g, b] = panel.getPixel(x, y);
      if (r > 200 && g > 200 && b > 200) names.add('white');
      else if (r > 200) names.add('red');
      else if (g > 200) names.add('green');
      else if (b > 200) names.add('blue');
      else names.add('dark');
    }
  }
  return names.size === 1 ? [...names][0] : 'mixed';
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
// fitRect / fillRect: contain vs cover
// -------------------------------------------------------------------------

test('fitRect contains a wide source: full width, letterboxed height', () => {
  const r = fitRect(1280, 800, 20, 20);
  assert.equal(r.w, 20);
  assert.equal(r.h, 12.5);
  assert.equal(r.y, 3.75); // centred letterbox
  assert.equal(r.x, 0);
  assert.equal(r.scale, 64); // source px per cell
});

test('fitRect contains a tall source: full height, letterboxed width', () => {
  const r = fitRect(800, 1200, 20, 20);
  assert.equal(r.h, 20);
  assert.equal(r.w, 20 * (800 / 1200));
  assert.ok(r.x > 0);
  assert.equal(r.y, 0);
});

test('fillRect covers a wide source: full height, cropped sides', () => {
  const r = fillRect(1280, 800, 20, 20);
  assert.equal(r.h, 20);
  assert.equal(r.w, 32);
  assert.equal(r.x, -6); // overflow cropped equally on both sides
  assert.equal(r.y, 0);
  assert.ok(r.scale < fitRect(1280, 800, 20, 20).scale, 'cover must magnify more than contain');
});

test('fillRect covers a tall source: full width, cropped top and bottom', () => {
  const r = fillRect(800, 1200, 20, 20);
  assert.equal(r.w, 20);
  assert.equal(r.h, 30);
  assert.equal(r.y, -5);
  assert.equal(r.x, 0);
});

test('fit and fill agree when the source already matches the grid aspect', () => {
  const fit = fitRect(1200, 1200, 20, 20);
  const fill = fillRect(1200, 1200, 20, 20);
  assert.deepEqual(fit, fill);
});

test('both presets preserve aspect ratio', () => {
  for (const [w, h] of [[1280, 800], [800, 1200], [1920, 400], [300, 2400]]) {
    for (const rect of [fitRect(w, h, 20, 20), fillRect(w, h, 20, 20)]) {
      assert.ok(Math.abs(rect.w / rect.h - w / h) < 1e-9, `${w}x${h} distorted`);
    }
  }
});

test('fit never exceeds the grid and fill never leaves a gap', () => {
  const fit = fitRect(1280, 800, 20, 20);
  assert.ok(fit.w <= 20 && fit.h <= 20);
  const fill = fillRect(1280, 800, 20, 20);
  assert.ok(fill.w >= 20 && fill.h >= 20);
});

test('geometry rejects zero and negative sizes', () => {
  assert.throws(() => fitRect(0, 800, 20, 20), RangeError);
  assert.throws(() => fillRect(1280, -1, 20, 20), RangeError);
  assert.throws(() => fitRect(1280, 800, 20, 0), RangeError);
});

// -------------------------------------------------------------------------
// Panner: the window walks the whole source
// -------------------------------------------------------------------------

test('offset 0 is the near end of the source, not its middle', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.render();
  assert.equal(band(panel), 'red');
});

test('offset span is the far end of the source', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.seek(1);
  assert.equal(p.offset, p.span);
  p.render();
  assert.equal(band(panel), 'white');
});

test('the sweep reaches every band in order', () => {
  const panel = new Panel(20, 20);
  // Unlooped: a looping pan treats offset == span as the near end again, which
  // is correct for a cycle but would hide the last band from this test.
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0, loop: false });
  const seen = [];
  // 60 cells per step across a 180-cell span: one step per band.
  for (let i = 0; i < 4; i++) {
    p.render();
    seen.push(band(panel));
    p.advance(60);
  }
  assert.deepEqual(seen, ['red', 'green', 'blue', 'white']);
});

test('span is the off-grid overflow along the pan axis', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2 });
  assert.equal(p.span, 180); // 200 cells of source - 20 cells of grid
});

test('a source that fits the grid has nothing to pan and does not move', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 20), mode: 'fit' });
  assert.equal(p.span, 0);
  assert.equal(p.progress, 0);
  assert.equal(p.advance(5), 0); // no division by zero, no wrap
});

test('visible reports the fraction of the source on the grid', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2 });
  assert.equal(p.visible, 0.1); // 400 cells shown of 4000
  const whole = new Panner({ panel: new Panel(20, 20), source: bands(20, 10), mode: 'fit' });
  assert.equal(whole.visible, 1);
});

test('progress tracks the offset across the span', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.seek(0.5);
  assert.equal(p.progress, 0.5);
  assert.equal(p.offset, 90);
  assert.throws(() => p.seek(1.2), RangeError);
  assert.throws(() => p.seek(-0.1), RangeError);
});

test('advance is fractional and accumulates without rounding', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0.15 });
  for (let i = 0; i < 10; i++) p.advance();
  assert.ok(Math.abs(p.offset - 1.5) < 1e-12, `expected 1.5, got ${p.offset}`);
});

test('a looped pan wraps back to the near end', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.seek(1); // offset 180 = span
  p.advance(10);
  assert.equal(p.offset, 10, '10 cells past the far end must re-enter from the near end');
});

test('an unlooped pan parks at the far end', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0, loop: false });
  p.advance(500);
  assert.equal(p.offset, p.span);
  p.render();
  assert.equal(band(panel), 'white');
});

test('UP reverses the sweep', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 60, direction: UP, loop: false });
  p.seek(1);
  p.advance();
  p.render();
  assert.equal(band(panel), 'blue');
});

test('panning along x walks a wide source sideways', () => {
  const panel = new Panel(20, 20);
  // 400x40 px: four 100 px bands laid out horizontally at 2 px/cell.
  const w = 400;
  const h = 40;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = BANDS[Math.floor(x / 100)];
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  const p = new Panner({ panel, source: bitmap(rgba, w, h, 2), axis: 'x', pxPerCell: 2, cellsPerFrame: 0 });
  assert.equal(p.span, 180);
  p.render();
  assert.equal(band(panel), 'red');
  p.seek(1);
  p.render();
  assert.equal(band(panel), 'white');
});

test('the pan axis is near-aligned while material is off-grid', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2 });
  assert.equal(p.rect.y, 0, 'a centred pan axis would skip the top of the page');
  // Cross axis stays centred: a wide page keeps its text column mid-wall.
  const wide = new Panner({ panel: new Panel(20, 20), source: bands(200, 20), pxPerCell: 2, axis: 'y' });
  assert.equal(wide.rect.y, 0);
  assert.equal(wide.rect.x, (20 - 200) / 2);
});

test('a source that fits is centred on the pan axis too', () => {
  // 80x20 px at 2 px/cell = 40 x 10 cells. fit magnifies it to the grid's
  // width (contain scales up as well as down), leaving a 5-cell-tall band that
  // must be split evenly top and bottom rather than hanging at the near edge.
  const p = new Panner({ panel: new Panel(20, 20), source: bands(40, 10), mode: 'fit' });
  assert.equal(p.rect.w, 20);
  assert.equal(p.rect.h, 5);
  assert.equal(p.span, 0);
  assert.equal(p.rect.y, 7.5);
  assert.equal(p.rect.x, 0);
});

test('pxPerCell overrides the zoom the mode would pick', () => {
  const src = bands(20, 200);
  const zoomed = new Panner({ panel: new Panel(20, 20), source: src, pxPerCell: 8 });
  assert.equal(zoomed.rect.scale, 8);
  // 40x400 px at 8 px/cell = 5 x 50 cells: narrower than the grid, so the pan
  // axis is the only overflow and the cross axis centres.
  assert.equal(zoomed.rect.w, 5);
  assert.equal(zoomed.rect.h, 50);
  assert.equal(zoomed.span, 30);
  assert.ok(zoomed.visible > 0.1, 'more zoom must show a larger fraction of the page');
});

test('render clears the panel by default and can blend instead', () => {
  const panel = new Panel(20, 20);
  // A colour the source never contains, so any leftover is visible.
  panel.fill(9, 250, 9);
  const p = new Panner({ panel, source: bands(20, 20), mode: 'fit' });
  p.render();
  assert.deepEqual(panel.getPixel(10, 10), [0, 0, 255]); // cell 10 sits in the blue band
  for (let y = 0; y < panel.rows; y++) {
    for (let x = 0; x < panel.cols; x++) {
      const [r, g, b] = panel.getPixel(x, y);
      assert.notDeepEqual([r, g, b], [9, 250, 9], 'clear must wipe the previous frame');
    }
  }

  panel.fill(0, 255, 0);
  const keep = new Panner({ panel, source: bands(20, 20), mode: 'fit', clear: false, blend: 'max' });
  keep.render();
  const [r, g, b] = panel.getPixel(10, 10);
  assert.ok(g > 200 && b > 200, `max blend must keep both layers, got ${[r, g, b]}`);
});

test('opacity dims the window', () => {
  const panel = new Panel(20, 20);
  const full = new Panner({ panel, source: bands(20, 20), mode: 'fit' });
  full.render();
  const bright = coverage(panel);

  panel.fill(0, 0, 0);
  const dim = new Panner({ panel, source: bands(20, 20), mode: 'fit', opacity: 0.5 });
  dim.render();
  const half = coverage(panel);
  assert.ok(half < bright * 0.6 && half > bright * 0.4, `expected ~half, got ${half} vs ${bright}`);
});

test('geometry is recomputed when the source is swapped', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2 });
  assert.equal(p.span, 180);
  p.source = bands(20, 40);
  assert.equal(p.span, 20, 'a shorter capture must shrink the pan range');
});

test('the pan offset survives a source swap', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.seek(0.5);
  const offset = p.offset;
  p.source = bands(20, 200); // a fresh capture of the same page
  assert.equal(p.offset, offset, 'a live feed must not jump back to the top on refresh');
});

test('cellsPerFrame 0 holds the window still', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  p.seek(0.3);
  const at = p.offset;
  for (let i = 0; i < 20; i++) p.advance();
  assert.equal(p.offset, at, 'a zero step must not drift');
  // An explicit step still moves it: 0 is the default, not a lock.
  assert.equal(p.advance(5), at + 5);
});

test('constructor rejects bad options', () => {
  const panel = new Panel(20, 20);
  const src = bands(20, 20);
  assert.throws(() => new Panner({ source: src }), TypeError);
  assert.throws(() => new Panner({ panel }), TypeError);
  assert.throws(() => new Panner({ panel, source: src, mode: 'stretch' }), RangeError);
  assert.throws(() => new Panner({ panel, source: src, axis: 'z' }), RangeError);
  assert.throws(() => new Panner({ panel, source: src, pxPerCell: 0 }), RangeError);
  assert.throws(() => new Panner({ panel, source: src, cellsPerFrame: -1 }), RangeError);
  assert.throws(() => new Panner({ panel, source: src, direction: 0 }), RangeError);
});

test('DOWN and UP are the documented signs', () => {
  assert.equal(DOWN, 1);
  assert.equal(UP, -1);
});

// -------------------------------------------------------------------------
// Cost: a 30 fps loop must not allocate or recompute per frame
// -------------------------------------------------------------------------

test('render reuses one scratch buffer across frames', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2 });
  const scratch = p.scratch;
  for (let i = 0; i < 50; i++) {
    p.advance();
    p.render();
  }
  assert.equal(p.scratch, scratch, 'scratch must not be reallocated');
  assert.equal(scratch.length, 20 * 20 * 3);
});

test('rect is cached until the geometry actually changes', () => {
  const p = new Panner({ panel: new Panel(20, 20), source: bands(20, 200), pxPerCell: 2 });
  const first = p.rect;
  assert.equal(p.rect, first);
  assert.equal(p.rect, first);
  p.pxPerCell = 4;
  assert.notEqual(p.rect, first, 'a zoom change must invalidate the cache');
});

test('a full 20x20 sweep of a 200-cell page renders every cell', () => {
  const panel = new Panel(20, 20);
  const p = new Panner({ panel, source: bands(20, 200), pxPerCell: 2, cellsPerFrame: 0 });
  let dark = 0;
  for (let i = 0; i <= 180; i += 3) {
    p.seek(i / 180);
    p.render();
    for (let y = 0; y < panel.rows; y++) {
      for (let x = 0; x < panel.cols; x++) {
        if (Math.max(...panel.getPixel(x, y)) === 0) dark++;
      }
    }
  }
  assert.equal(dark, 0, 'no cell should be left unlit while panning an opaque page');
});

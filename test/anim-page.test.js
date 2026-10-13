import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PNG_SIGNATURE,
  freePort,
  startServe,
  decodePng,
  pngSize,
  rgbaOf,
} from './harness.js';

import { Panel, DEFAULT_COLS, DEFAULT_ROWS } from '../core/panel.js';
import { Panner, fitRect, fillRect } from '../core/panner.js';
import { bitmap } from '../core/scroller.js';
import { findChrome } from '../tools/capture.js';

import {
  W,
  H,
  BAR_W,
  BAR_H,
  SPEED_X,
  SPEED_Y,
  bars,
  frameRgba,
} from '../web/anim-400.js';

/**
 * The 400x400 animated page, end to end.
 *
 * The question this suite answers is the one the wall's whole design hangs on:
 * when a web page is exactly the size of the grid, does the wall show what the
 * page is doing? A 400x400 page at 20 source px per cell is exactly 20x20 cells,
 * so there is nothing left over to pan — the framing is fixed and the ONLY way
 * animation reaches the panel is a fresh capture. That makes this the test for the
 * live-feed path itself: page -> Chromium -> PNG -> core/raster -> Panel.
 *
 * It is worth being precise about what is under test, because the easy version of
 * this test proves nothing. web/anim-400.js holds the scene geometry and the page
 * imports it, so the test can ask "what should these pixels be?" of the SAME code
 * that painted them. A test that redrew the bars itself would only show that the
 * test agrees with the test. Comparing the scene's answer against the bytes a real
 * browser returned is what would catch colour management shifting 255,0,0, a
 * screenshot taken before the canvas painted, a PNG the raster misreads, or a
 * capture route that hands back a stale frame.
 *
 * Skipped, never failed, where no browser is installed.
 */

const PX_PER_CELL = 20;

/** The frame where both bars land on cell boundaries at once. See anim-400.js. */
const CRISP_T = 2 / 3;

async function shot(base, query) {
  const url = encodeURIComponent(`${base}/anim-400.html${query}`);
  const res = await fetch(`${base}/capture?url=${url}&w=${W}&h=${H}&dsf=1&wait=0`);
  if (!res.ok) {
    throw new Error(`capture failed: ${res.status} ${await res.text()}`);
  }
  const png = Buffer.from(await res.arrayBuffer());
  return { res, png, decoded: decodePng(png) };
}

/**
 * Put a captured page on the grid the way the app does: a Panner at an explicit
 * zoom, which is what `pageZoom` = 20 and auto-zoom off mean in web/app.js.
 */
function panelOf(decoded, opts = {}) {
  const source = bitmap(rgbaOf(decoded), decoded.w, decoded.h, 1);
  const panel = new Panel(DEFAULT_COLS, DEFAULT_ROWS);
  const panner = new Panner({
    panel,
    source,
    pxPerCell: opts.pxPerCell ?? PX_PER_CELL,
    mode: opts.mode,
    axis: opts.axis,
    cellsPerFrame: 0,
  });
  panner.render();
  return { panel, panner, source };
}

/**
 * Columns carrying the red bar and rows carrying the green bar.
 *
 * "Any cell in the column/row", not "every cell": the bars cross, and green is
 * painted after red, so the crossing blanks a couple of cells of the red bar. A
 * column is still the red bar's column with 19 of its 20 cells lit, and requiring
 * all 20 would make the measurement depend on where the crossing happened.
 */
function barsOn(panel) {
  const redCols = [];
  const greenRows = [];
  for (let x = 0; x < panel.cols; x++) {
    for (let y = 0; y < panel.rows; y++) {
      const [r, g] = panel.getPixel(x, y);
      if (r > 200 && g < 60) {
        redCols.push(x);
        break;
      }
    }
  }
  for (let y = 0; y < panel.rows; y++) {
    for (let x = 0; x < panel.cols; x++) {
      const [, g] = panel.getPixel(x, y);
      if (g > 200) {
        greenRows.push(y);
        break;
      }
    }
  }
  return { redCols, greenRows };
}

// -------------------------------------------------------------------------
// The fixture, through the real capture route
// -------------------------------------------------------------------------

test('the 400x400 fixture is served and captured at exactly 400x400', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const { res, png, decoded } = await shot(serve.base, `?t=${CRISP_T}`);

    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, 'the capture must be a PNG');
    assert.deepEqual(pngSize(png), { w: W, h: H }, 'IHDR must be the size we asked for');
    assert.deepEqual(
      { w: decoded.w, h: decoded.h },
      { w: W, h: H },
      'the decoded pixels must be the size the IHDR claims',
    );

    const headers = {
      device: [res.headers.get('x-capture-width'), res.headers.get('x-capture-height')],
      css: [res.headers.get('x-capture-css-width'), res.headers.get('x-capture-css-height')],
      scroll: res.headers.get('x-capture-scroll-height'),
    };
    assert.deepEqual(headers.device, [String(W), String(H)]);
    assert.deepEqual(headers.css, [String(W), String(H)], 'the page must lay out at the viewport asked for');
    // scrollHeight == viewport is the whole premise: a 400x400 page has no part of
    // itself below the fold, so there is nothing for a pan to reach.
    assert.equal(headers.scroll, String(H), 'the page must be exactly one viewport tall');
  } finally {
    await serve.stop();
  }
});

test('the captured PNG is byte-for-byte what the page painted', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    for (const time of [0, CRISP_T, 1, 3.25]) {
      const { decoded } = await shot(serve.base, `?t=${time}`);
      const expected = frameRgba(time);

      const bad = [];
      for (let i = 0, j = 0; i < W * H; i++, j += decoded.channels) {
        const want = i * 4;
        if (
          decoded.pixels[j] !== expected[want] ||
          decoded.pixels[j + 1] !== expected[want + 1] ||
          decoded.pixels[j + 2] !== expected[want + 2]
        ) {
          bad.push({
            x: i % W,
            y: (i / W) | 0,
            got: [decoded.pixels[j], decoded.pixels[j + 1], decoded.pixels[j + 2]],
            want: [expected[want], expected[want + 1], expected[want + 2]],
          });
        }
      }

      assert.equal(
        bad.length,
        0,
        `t=${time}: ${bad.length} of ${W * H} pixels differ from the scene, first ${JSON.stringify(bad[0])}`,
      );
    }
  } finally {
    await serve.stop();
  }
});

// -------------------------------------------------------------------------
// Geometry: a page the size of the grid
// -------------------------------------------------------------------------

test('a 400x400 page at 20 px/cell maps 1:1 onto the 20x20 grid', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const { decoded } = await shot(serve.base, `?t=${CRISP_T}`);
    const { panel, panner, source } = panelOf(decoded);

    assert.equal(source.w, W);
    assert.equal(source.h, H);

    // 400 source px / 20 px per cell = 20 cells: the source is the grid.
    assert.equal(panner.rect.w, DEFAULT_COLS);
    assert.equal(panner.rect.h, DEFAULT_ROWS);
    assert.equal(panner.rect.scale, PX_PER_CELL);
    assert.equal(panner.rect.x, 0, 'no letterbox: the source fills the grid exactly');
    assert.equal(panner.rect.y, 0);
    assert.equal(panner.visible, 1, 'every source cell must be on the wall');

    // The claim being tested: nothing to pan, so the framing cannot drift.
    assert.equal(panner.span, 0);
    assert.equal(panner.progress, 0);
    assert.equal(panner.advance(5), 0, 'advance must be a no-op rather than wrapping');
    assert.equal(panner.tick().getPixel(0, 0).length, 3, 'tick must still render');
    assert.equal(panner.progress, 0, 'and still not move');

    // Every cell is either a bar or background: no partial coverage anywhere.
    for (let y = 0; y < panel.rows; y++) {
      for (let x = 0; x < panel.cols; x++) {
        const [r, g, b] = panel.getPixel(x, y);
        const lit = (r > 200 && g < 60) || (g > 200 && r < 60);
        assert.ok(
          lit ? Math.max(r, g, b) === 255 : Math.max(r, g, b) === 0,
          `cell ${x},${y} is partial (${r},${g},${b}); a 1:1 mapping must not average anything`,
        );
      }
    }
  } finally {
    await serve.stop();
  }
});

test('auto zoom lands on the same 1:1 scale, fit or fill', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const { decoded } = await shot(serve.base, `?t=${CRISP_T}`);

    // Auto zoom (pageAutoZoom) means pxPerCell = null, so the mode picks the zoom.
    // A square source and a square grid make fit and fill agree.
    for (const mode of ['fit', 'fill']) {
      const { panel, panner } = panelOf(decoded, { mode });
      assert.equal(panner.rect.scale, PX_PER_CELL, `${mode} must land on 20 px/cell`);
      assert.equal(panner.span, 0, `${mode} must have nothing to pan`);
      assert.equal(panner.visible, 1);
      assert.deepEqual(barsOn(panel).redCols, [4, 5], `${mode} must place the red bar identically`);
    }

    // The presets themselves, independent of any browser.
    for (const rect of [fitRect(W, H, DEFAULT_COLS, DEFAULT_ROWS), fillRect(W, H, DEFAULT_COLS, DEFAULT_ROWS)]) {
      assert.equal(rect.scale, PX_PER_CELL);
      assert.equal(rect.w, DEFAULT_COLS);
      assert.equal(rect.h, DEFAULT_ROWS);
      assert.equal(rect.x, 0);
      assert.equal(rect.y, 0);
    }
  } finally {
    await serve.stop();
  }
});

test('the bars land on whole cells at t = 2/3', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const { decoded } = await shot(serve.base, `?t=${CRISP_T}`);
    const { panel } = panelOf(decoded);

    // Derived from the scene, not typed in: 80 px / 20 = cells 4-5, 60 px / 20 = row 3.
    const { x, y } = bars(CRISP_T);
    assert.equal(x, 80);
    assert.equal(y, 60);
    const firstRedCol = x / PX_PER_CELL;
    const redCols = Array.from({ length: BAR_W / PX_PER_CELL }, (_, i) => firstRedCol + i);
    const greenRows = Array.from({ length: BAR_H / PX_PER_CELL }, (_, i) => y / PX_PER_CELL + i);

    assert.deepEqual(barsOn(panel), { redCols, greenRows });
  } finally {
    await serve.stop();
  }
});

test('a bar straddling a cell boundary reads as two half-lit cells', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const { decoded } = await shot(serve.base, '?t=1');
    const { panel } = panelOf(decoded);

    // t=1 puts the green bar at y 90..110: 10 px of row 4 (80..100) and 10 px of
    // row 5 (100..120). Area averaging must report that as two half-bright rows,
    // not one bright row and one dark one. This is what keeps a moving bar from
    // jumping a whole cell per frame.
    const { y } = bars(1);
    assert.equal(y, 90);

    // Column 0, so the red bar (x 120..160) is nowhere near these samples.
    assert.equal(panel.getPixel(0, 3)[1], 0, 'row 3 must be untouched');
    assert.equal(panel.getPixel(0, 4)[1], 127, 'row 4 is half covered');
    assert.equal(panel.getPixel(0, 5)[1], 127, 'row 5 is half covered');
    assert.equal(panel.getPixel(0, 6)[1], 0, 'row 6 must be untouched');

    // And the red bar is still exactly two cells wide at the same instant.
    const redRow = [...Array(panel.cols)].map((_, x) => (panel.getPixel(x, 0)[0] > 200 ? x : -1)).filter((x) => x >= 0);
    assert.deepEqual(redRow, [6, 7], '120 px/s at t=1 is x=120: cells 6-7');
  } finally {
    await serve.stop();
  }
});

// -------------------------------------------------------------------------
// Live feed: the only path by which animation reaches a grid-sized page
// -------------------------------------------------------------------------

test('a deterministic frame re-shoots identical, so the app skips the re-raster', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const first = await shot(serve.base, `?t=${CRISP_T}`);
    const again = await shot(serve.base, `?t=${CRISP_T}`);

    // web/page.js keys its cached raster on this hash: equal hashes mean the
    // downsample is reused instead of redone on every poll.
    assert.equal(
      first.res.headers.get('x-capture-hash'),
      again.res.headers.get('x-capture-hash'),
      'the same frame must hash the same',
    );
    assert.deepEqual(first.png, again.png, 'and be the same bytes');
  } finally {
    await serve.stop();
  }
});

test('a different frame of the same page is a different capture', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    const a = await shot(serve.base, '?t=0');
    const b = await shot(serve.base, '?t=1');

    assert.notEqual(
      a.res.headers.get('x-capture-hash'),
      b.res.headers.get('x-capture-hash'),
      'a moved bar must not look like the frame before it',
    );
    assert.notDeepEqual(a.png, b.png);
    assert.deepEqual(barsOn(panelOf(a.decoded).panel).redCols, [0, 1], 't=0 has the red bar at x=0: cells 0-1');
    assert.deepEqual(barsOn(panelOf(a.decoded).panel).greenRows, [0]);
  } finally {
    await serve.stop();
  }
});

test('the animated page advances on the wall at its designed rate', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    // No ?t, so the page animates. Same URL twice: the capture service re-shoots
    // the live tab rather than re-navigating it, which is exactly what the app's
    // poll loop does. If the wall were showing a frozen frame, this is the test
    // that would say so.
    const before = await shot(serve.base, '');
    const started = Date.now();
    await new Promise((done) => setTimeout(done, 500));
    const after = await shot(serve.base, '');
    const elapsedMs = Date.now() - started;

    assert.notDeepEqual(before.png, after.png, 'a live page must not replay one cached image');

    const from = barsOn(panelOf(before.decoded).panel).redCols[0];
    const to = barsOn(panelOf(after.decoded).panel).redCols[0];
    assert.ok(Number.isInteger(from) && Number.isInteger(to), `red bar must be measurable: ${from} -> ${to}`);

    // Shortest signed distance on a 20-cell wrap: the bar re-enters from the left
    // after x=400, and a wrap must not read as the bar running backwards.
    const cells = ((to - from) % DEFAULT_COLS + DEFAULT_COLS) % DEFAULT_COLS;
    const moved = cells > DEFAULT_COLS / 2 ? cells - DEFAULT_COLS : cells;
    assert.ok(moved > 0, `the red bar must advance, moved ${moved} cells in ${elapsedMs} ms`);

    // The rate, not just the motion: 120 px/s is 6 cells/s, so ~500 ms is ~3
    // cells. Cell quantisation and capture latency make an exact figure
    // meaningless, so the band is deliberately wide — it is there to catch a
    // frozen page (0) or a source animation running at the wrong speed, which is
    // what a frame-count-based animation would do on a throttled display.
    const pxPerSecond = (moved * PX_PER_CELL) / (elapsedMs / 1000);
    assert.ok(
      pxPerSecond > SPEED_X / 2 && pxPerSecond < SPEED_X * 2,
      `red bar moved ${moved} cells in ${elapsedMs} ms = ${pxPerSecond.toFixed(0)} px/s, expected near ${SPEED_X}`,
    );

    // The vertical bar is the second axis of the same claim.
    const greenFrom = barsOn(panelOf(before.decoded).panel).greenRows[0];
    const greenTo = barsOn(panelOf(after.decoded).panel).greenRows[0];
    if (Number.isInteger(greenFrom) && Number.isInteger(greenTo)) {
      const gCells = ((greenTo - greenFrom) % DEFAULT_ROWS + DEFAULT_ROWS) % DEFAULT_ROWS;
      const gMoved = gCells > DEFAULT_ROWS / 2 ? gCells - DEFAULT_ROWS : gCells;
      assert.ok(gMoved >= 0, `green bar must not run backwards: ${greenFrom} -> ${greenTo}`);
    }
  } finally {
    await serve.stop();
  }
});

test('the fixture scene is deterministic and wraps without drifting', () => {
  // No browser needed: this is the contract the browser tests lean on.
  assert.deepEqual(bars(0), { x: 0, y: 0 });
  assert.deepEqual(bars(CRISP_T), { x: 80, y: 60 });
  assert.deepEqual(bars(1), { x: 120, y: 90 });

  // Same t, same pixels — twice.
  assert.deepEqual(frameRgba(1.25), frameRgba(1.25));

  // Whole-cell times must land on cell boundaries exactly, which is what kills the
  // float wobble (2/3 * 120 is 79.99999999999999 before rounding).
  for (let cell = 0; cell < DEFAULT_COLS; cell++) {
    const t = cell * (PX_PER_CELL / SPEED_X);
    assert.equal(bars(t).x % PX_PER_CELL, 0, `t=${t}: red bar must sit on a cell boundary`);
  }
  for (let cell = 0; cell < DEFAULT_ROWS; cell++) {
    const t = cell * (PX_PER_CELL / SPEED_Y);
    assert.equal(bars(t).y % PX_PER_CELL, 0, `t=${t}: green bar must sit on a cell boundary`);
  }

  // Wrapping, not clipping. The invariant is that a frame's total lit area is the
  // same at every t: a bar that ran off the edge would lose pixels, and the old
  // version of frameRgba did exactly that (it also smeared red into the next row
  // when x + BAR_W passed 400). Coverage is measured, not assumed.
  const litOf = (t) => {
    const px = frameRgba(t);
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] || px[i + 1] || px[i + 2]) lit += 1;
    }
    return lit;
  };
  const expected = W * BAR_H + H * BAR_W - BAR_W * BAR_H; // red + green - crossing
  for (const t of [0, 0.5, 1, 3.33, 3.34, 100, 1e6, -1, -0.5]) {
    const { x, y } = bars(t);
    assert.ok(Number.isInteger(x) && Number.isInteger(y), `t=${t}: positions must be whole px`);
    assert.ok(x >= 0 && x < W && y >= 0 && y < H, `t=${t}: bar origin ${x},${y} must stay on the page`);
    assert.equal(litOf(t), expected, `t=${t}: wrapping must not gain or lose lit pixels`);
  }

  assert.throws(() => bars(Number.NaN), RangeError);
  assert.throws(() => frameRgba(0, new Uint8Array(16)), RangeError);
});

/**
 * banner — fetch live copy from a local page and rasterise it into the Bitmap
 * core/scroller.js scrolls.
 *
 * Rasterised HIGH, never at 20x20: core/raster.js area-averages the source
 * area each panel cell covers and reads alpha as coverage — a cell whose area
 * holds no ink is dark, a cell that holds ink takes the average colour of that
 * ink. A 20x20 source gives each cell exactly one sample, so that decision is
 * made by the font rasteriser at one pixel per 50 mm cell: glyph edges snap to
 * whole cells and a scrolling marquee flickers as cells flip on and off.
 * Rendering at `pxPerCell` source pixels per cell (12 by default => ~144
 * samples per cell) hands the averaging real sub-cell detail, antialiased
 * fringe included, so which cells a stroke touches resolves consistently as the
 * text glides.
 *
 * DOM lives here, maths lives in core/. Nothing in this file is Node-testable
 * (it needs a 2d canvas); everything it produces is.
 */

import { bitmap } from '../core/scroller.js';

const DEFAULT_URL = './banner.txt';
const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_CAP_ROWS = 14;
const DEFAULT_PX_PER_CELL = 12;
const DEFAULT_COLOR = '#ffffff';
const DEFAULT_FALLBACK = 'BANNER OFFLINE';
/** Bold condensed sans: narrow glyphs are what actually fit 20 cells. */
const DEFAULT_FONT = '700 100px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

/** Font size the cap height and descent are measured at; everything scales from it. */
const PROBE_SIZE = 100;
/** Used when the engine reports no glyph bounding box (older 2d contexts). */
const CAP_FALLBACK = 0.7;
const DESCENT_FALLBACK = 0.21;
/** Air so an antialiased glyph edge is never clipped by the canvas border. */
const PAD = 1;

/** The size token of a CSS font shorthand — a number WITH a unit, so a weight like `700` is not mistaken for it. */
const SIZE_TOKEN = /\b\d+(?:\.\d+)?(?:px|pt|em|rem|ex|ch|pc|vh|vw)\b/i;
const CRLF = /\r\n?/g;
const BOM = /^\uFEFF/;

/**
 * Plain fetch, exported for reuse and tests.
 *
 * `cache: 'no-store'` because the poll exists to see edits to a local file; a
 * cached 200 would freeze the banner. CRLF is collapsed so a banner.txt edited
 * in a Windows editor does not smuggle `\r` into the measured advance width,
 * and a BOM is dropped because it renders as an invisible glyph that shifts the
 * whole line right.
 *
 * @param {string} [url]
 * @returns {Promise<string>} normalised text; rejects on a non-2xx response
 */
export async function fetchBanner(url = DEFAULT_URL) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`banner fetch failed: ${res.status} ${res.statusText}`);
  return normalise(await res.text());
}

/** Trim trailing whitespace per line and drop blank leading/trailing lines. */
function normalise(raw) {
  const lines = raw
    .replace(BOM, '')
    .replace(CRLF, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Poll a banner page and turn its text into a scroller source.
 *
 * The app owns one Banner, calls refresh() on a timer, and calls bitmap() only
 * when `changed` is true — but bitmap() caches by text anyway, so a 300 ms poll
 * of unchanged copy costs one fetch and zero rasterising.
 */
export class Banner {
  /** @type {HTMLCanvasElement|OffscreenCanvas|null} Reused across renders; resizing in place beats allocating a canvas per poll. */
  #canvas = null;
  #ctx = null;
  /** @type {import('../core/scroller.js').Bitmap|null} */
  #raster = null;
  /** The key `#raster` was built from. */
  #rasterKey = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  #timer = null;
  #text;
  #stale = false;

  /**
   * @param {object} [opts]
   * @param {string} [opts.url] default './banner.txt'
   * @param {number} [opts.intervalMs] poll period, plan says 200-500; default 300
   * @param {string} [opts.fallback] text to show when the fetch fails
   * @param {number} [opts.capRows] cap height in panel cells; plan says 13-15; default 14
   * @param {number} [opts.pxPerCell] source pixels per panel cell; default 12
   * @param {string} [opts.font] CSS font shorthand; default a bold condensed sans
   * @param {string} [opts.color] glyph colour; default '#ffffff'
   */
  constructor(opts = {}) {
    this.url = opts.url ?? DEFAULT_URL;
    /** Floored at 50 ms: polling a static local file faster is pure request load. */
    this.intervalMs = Math.max(50, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.fallback = opts.fallback ?? DEFAULT_FALLBACK;
    /**
     * Cap-height budget for the whole block, in panel cells. Split across lines
     * so a two-line banner still fits the 20-row panel instead of overflowing
     * it: one line gets 14 rows of caps, two lines get 7 each.
     */
    this.capRows = opts.capRows ?? DEFAULT_CAP_ROWS;
    this.pxPerCell = opts.pxPerCell ?? DEFAULT_PX_PER_CELL;
    this.font = opts.font ?? DEFAULT_FONT;
    this.color = opts.color ?? DEFAULT_COLOR;

    if (!(this.capRows > 0)) throw new RangeError(`capRows must be > 0, got ${this.capRows}`);
    if (!(this.pxPerCell > 0)) throw new RangeError(`pxPerCell must be > 0, got ${this.pxPerCell}`);

    this.#text = this.fallback;
  }

  /** Current text — never null; the fallback stands in until a fetch succeeds. */
  get text() {
    return this.#text;
  }

  /** True if the last refresh failed; the app should show a status light. */
  get stale() {
    return this.#stale;
  }

  /** Source canvas dimensions in pixels, for the app's debug readout. */
  get sourceSize() {
    const { w, h, pxPerCell } = this.bitmap();
    return { w, h, pxPerCell };
  }

  /**
   * One poll. Never rejects: a failed fetch keeps the previous copy and flips
   * `stale`, because a stale banner on the wall beats a blank one — and a
   * rejection surfacing out of a timer is an unhandled rejection, i.e. a crash.
   *
   * @returns {Promise<{text: string, changed: boolean}>}
   */
  async refresh() {
    let text;
    try {
      text = await fetchBanner(this.url);
    } catch {
      this.#stale = true;
      return { text: this.#text, changed: false };
    }
    this.#stale = false;
    const changed = text !== this.#text;
    this.#text = text;
    return { text, changed };
  }

  /** Start the poll loop (idempotent; kicks one refresh immediately so the wall is not blank for a whole interval). */
  start() {
    if (this.#timer !== null) return this;
    const poll = () => {
      this.refresh().catch(() => {});
    };
    poll();
    this.#timer = setInterval(poll, this.intervalMs);
    return this;
  }

  /** Stop the poll loop (idempotent). */
  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    return this;
  }

  /**
   * Re-render the current text into the offscreen canvas and return a
   * core/scroller.js Bitmap. Cached by text: identical copy is returned as the
   * same object, so a 300 ms poll never re-rasterises.
   *
   * @returns {import('../core/scroller.js').Bitmap}
   */
  bitmap() {
    const key = this.#key();
    if (this.#raster === null || this.#rasterKey !== key) {
      this.#raster = this.#render(this.#text);
      this.#rasterKey = key;
    }
    return this.#raster;
  }

  /**
   * Cache key: the text plus everything that changes the raster. The app may
   * retune font/colour/capRows live, and a stale bitmap for the new settings
   * would be worse than re-rendering.
   */
  #key() {
    return `${this.#text}\u0000${this.font}\u0000${this.color}\u0000${this.capRows}\u0000${this.pxPerCell}`;
  }

  /**
   * Text -> RGBA source.
   *
   * Sizing is done in two measured steps, not from a font size:
   *
   * 1. Cap height, not font size. Fonts are sized by em, but the plan's 13-15
   *    rows is a CAP height, and cap/em varies a lot (Arial ~0.72, condensed
   *    faces lower). So the font is measured at PROBE_SIZE, the ascent of 'H'
   *    is read off `actualBoundingBoxAscent`, and the size that would put a cap
   *    at exactly `capPx` source pixels is solved for. Any font then lands at
   *    the same visual size on the wall.
   * 2. Width from `measureText`, not from a character count. The advance width
   *    is what the scroller tiles, so cellsW = width / pxPerCell is the true
   *    width in cells and the repeat period (cellsW + gap) is honest — no
   *    visible pause at the wrap and no overlap between copies.
   *
   * Lines stack: band i's cap top sits at the band boundary, its baseline
   * `capPx` below that, and the band pitch is cap + measured descent, so one
   * band's descenders end exactly where the next band's caps begin.
   */
  #render(text) {
    const lines = text.split('\n');
    const pxPerCell = this.pxPerCell;
    const capPx = (this.capRows * pxPerCell) / lines.length;

    const ctx = this.#context();
    const canvas = /** @type {HTMLCanvasElement|OffscreenCanvas} */ (this.#canvas);

    ctx.font = this.#fontAt(PROBE_SIZE);
    const { cap, descent } = this.#metrics(ctx);

    const size = (capPx * PROBE_SIZE) / cap;
    const descentPx = (descent / PROBE_SIZE) * size;
    const bandH = capPx + descentPx;
    const height = Math.max(1, Math.ceil(lines.length * bandH) + 2 * PAD);

    ctx.font = this.#fontAt(size);
    let advance = 0;
    for (const line of lines) advance = Math.max(advance, ctx.measureText(line).width);
    // Ceil, plus PAD: an advance width is fractional and the last glyph's
    // antialiased fringe must not be cut. Empty text still gets a 1px canvas.
    const width = Math.max(1, Math.ceil(advance) + 2 * PAD);

    canvas.width = width;
    canvas.height = height;
    // Resizing wipes the context state, so the font is re-applied after it.
    ctx.font = this.#fontAt(size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Transparent background on purpose: raster.js reads alpha as coverage, so
    // an opaque background would report every cell as fully covered and light
    // the whole wall. Only the glyphs carry alpha.
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.color;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], PAD, PAD + capPx + i * bandH);
    }

    const { data } = ctx.getImageData(0, 0, width, height);
    // The Bitmap shape is core's, not ours: scroller.bitmap() is the one
    // definition of cellsW/cellsH, and it validates pxPerCell.
    return bitmap(data, width, height, pxPerCell);
  }

  /** Lazily create the offscreen canvas so `new Banner()` works before any canvas is needed. */
  #context() {
    if (this.#ctx !== null) return this.#ctx;
    if (typeof OffscreenCanvas === 'function') {
      this.#canvas = new OffscreenCanvas(1, 1);
    } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      this.#canvas = document.createElement('canvas');
    } else {
      throw new Error('Banner.bitmap() needs a canvas: OffscreenCanvas or document');
    }
    // Readback on every copy change: opting in keeps the canvas CPU-backed
    // instead of round-tripping the GPU for getImageData.
    const ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('Banner: no 2d canvas context available');
    this.#ctx = ctx;
    return ctx;
  }

  /** Cap height and descender depth of the current font at PROBE_SIZE. */
  #metrics(ctx) {
    const cap = ctx.measureText('H').actualBoundingBoxAscent;
    const descent = ctx.measureText('gypq').actualBoundingBoxDescent;
    return {
      cap: cap > 0 ? cap : PROBE_SIZE * CAP_FALLBACK,
      descent: descent > 0 ? descent : PROBE_SIZE * DESCENT_FALLBACK,
    };
  }

  /** Rebuild opts.font with its size token swapped, so the family/weight survive. */
  #fontAt(size) {
    const token = this.font.match(SIZE_TOKEN);
    if (token === null) return `700 ${size}px ${this.font}`;
    return `${this.font.slice(0, token.index)}${size}px${this.font.slice(token.index + token[0].length)}`;
  }
}

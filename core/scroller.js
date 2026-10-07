/**
 * scroller — horizontal marquee at FRACTIONAL cells per frame.
 *
 * Fractional is the point: on a 20-cell-wide grid, stepping a whole cell per
 * tick makes text jump a glyph-width every frame and reads as a stuttering
 * ticker. Advancing 0.2 cells/frame makes it glide.
 *
 * core/ is DOM-free, so the source is a plain RGBA bitmap plus its natural size
 * expressed in cells. The web layer renders text to an offscreen canvas at high
 * resolution and hands us getImageData().data; the scrolling maths lives here.
 *
 * No DOM, no browser APIs.
 */

import { blitArea } from './raster.js';

/**
 * @typedef {object} Bitmap
 * @property {Uint8Array|Uint8ClampedArray} rgba row-major RGBA
 * @property {number} w source width in pixels
 * @property {number} h source height in pixels
 * @property {number} cellsW source width expressed in panel cells
 * @property {number} cellsH source height expressed in panel cells
 */

/**
 * Build a Bitmap descriptor from a high-resolution RGBA buffer and the
 * pixels-per-cell the web layer rendered at.
 */
export function bitmap(rgba, w, h, pxPerCell) {
  if (!(pxPerCell > 0)) throw new RangeError(`pxPerCell must be > 0, got ${pxPerCell}`);
  return { rgba, w, h, cellsW: w / pxPerCell, cellsH: h / pxPerCell, pxPerCell };
}

export const LEFT = -1;
export const RIGHT = 1;

export class Scroller {
  /**
   * @param {object} opts
   * @param {import('./panel.js').Panel} opts.panel
   * @param {Bitmap} opts.source
   * @param {number} [opts.cellsPerFrame] fractional advance per frame
   * @param {number} [opts.gap] blank cells between repeats of the text
   * @param {number} [opts.direction] LEFT (-1, text flows right-to-left) or RIGHT
   * @param {number} [opts.y] top row of the text band
   * @param {boolean} [opts.clear] clear the panel before each render
   * @param {number} [opts.opacity] 0..1
   */
  constructor(opts) {
    const { panel, source } = opts;
    if (!panel) throw new TypeError('Scroller requires a panel');
    if (!source || !source.rgba) throw new TypeError('Scroller requires a source bitmap');

    this.panel = panel;
    this.source = source;
    this.cellsPerFrame = opts.cellsPerFrame ?? 0.25;
    this.gap = opts.gap ?? 2;
    this.direction = opts.direction ?? LEFT;
    this.y = opts.y ?? 0;
    this.clearBeforeRender = opts.clear ?? true;
    this.opacity = opts.opacity ?? 1;
    this.scratch = new Uint8Array(panel.cols * panel.rows * 3);

    if (!(this.cellsPerFrame >= 0)) {
      throw new RangeError(`cellsPerFrame must be >= 0, got ${this.cellsPerFrame}`);
    }
    if (this.direction !== LEFT && this.direction !== RIGHT) {
      throw new RangeError(`direction must be LEFT (-1) or RIGHT (1), got ${this.direction}`);
    }

    /**
     * Repeat distance: one copy of the text plus the gap. Copies tile at this
     * spacing, so the tail leaving one edge and the head entering the other are
     * the same stream — no visible wrap, no blank pause.
     */
    this.period = source.cellsW + this.gap;
    /** Fractional position in [0, period). */
    this.offset = 0;
    this.frame = 0;
  }

  /** Fractional cells per second at a given frame rate. */
  cellsPerSecond(fps) {
    return this.cellsPerFrame * fps;
  }

  /** Milliseconds for one repeat cycle (one copy plus its gap). */
  passDurationMs(fps) {
    return this.cellsPerFrame > 0 ? (this.period / this.cellsPerFrame) * (1000 / fps) : Infinity;
  }

  /**
   * Advance the offset by one frame. `offset` is distance travelled, always
   * increasing; `direction` chooses which way render() maps that distance onto
   * the panel. Mixing the two signs here would make both directions scroll the
   * same way.
   */
  advance(frames = 1) {
    this.offset = wrap(this.offset + this.cellsPerFrame * frames, this.period);
    this.frame += frames;
    return this.offset;
  }

  /** Set the offset directly (fractional allowed). Returns the new offset. */
  seek(offset) {
    this.offset = wrap(offset, this.period);
    return this.offset;
  }

  /**
   * Render the current offset into the panel. Every copy that can intersect the
   * panel is drawn: with a short banner (period < cols) several copies are on
   * screen at once, and drawing only two would leave a blank gap in the middle
   * of the stream instead of tiling it.
   */
  render(target = this.panel) {
    if (this.clearBeforeRender) target.clear();

    // Left edge of copy k=0 in panel cell coordinates.
    const base = this.direction === LEFT
      ? this.panel.cols - this.offset
      : this.offset - this.source.cellsW;
    const step = this.direction * this.period;

    for (let k = 0; k < this.#copyCount(base); k++) this.#blitCopy(target, base + k * step);
    return target;
  }

  /**
   * How many copies, starting at `base` and stepping away from it, still touch
   * the panel. The span is the same in both directions: the first copy hangs
   * `cellsW` beyond the panel edge it enters from, and every later copy is one
   * period further along, so the count is the distance to the far edge plus one
   * copy width, in periods.
   */
  #copyCount(base) {
    const span = this.direction === LEFT ? base + this.source.cellsW : this.panel.cols - base;
    return Math.max(1, Math.ceil(span / this.period));
  }

  /** Advance + render in one call — the frame loop's hot path. */
  tick(target = this.panel) {
    this.advance();
    return this.render(target);
  }

  /**
   * Draw one copy whose left edge sits at fractional cell x. Only the cells it
   * actually touch are visited, and each gets true partial coverage from
   * blitArea — that is what makes sub-cell motion smooth.
   */
  #blitCopy(target, x) {
    const { cols, rows } = target;
    const { cellsW, cellsH } = this.source;

    const gx0 = Math.max(0, Math.floor(x));
    const gx1 = Math.min(cols, Math.floor(x + cellsW) + 1);
    if (gx1 <= gx0) return;

    const gy0 = Math.max(0, Math.floor(this.y));
    const gy1 = Math.min(rows, Math.floor(this.y + cellsH) + 1);
    blitArea(target, this.source.rgba, this.source.w, this.source.h, {
      // Destination cell gx samples source cell (gx - x); with gx = gx0 the
      // source-space offset is x - gx0. Fractional here is what makes sub-cell
      // motion smooth.
      x: x - gx0,
      y: this.y - gy0,
      cellX: gx0,
      cellY: gy0,
      dstW: gx1 - gx0,
      dstH: gy1 - gy0,
      srcCells: cellsW,
      srcCellH: cellsH,
      opacity: this.opacity,
      mode: 'max',
      scratch: this.scratch,
    });
  }
}

function wrap(v, span) {
  const m = v % span;
  return m < 0 ? m + span : m;
}

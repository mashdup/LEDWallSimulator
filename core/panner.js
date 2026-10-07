/**
 * panner — a magnified window that scrolls THROUGH a source image.
 *
 * The scroller tiles a source sideways across the grid. A webpage wants the
 * opposite: the source is far bigger than 20x20, and shrinking the whole thing
 * to 400 cells makes body text unreadable — 14 px type on a 1280 px page is a
 * fifth of one cell, so a full-page thumbnail is just a colour swatch. What is
 * legible on a 50 mm pitch grid is a ZOOMED window: 20 cells covering a few
 * lines of a paragraph, panning down the page.
 *
 * So this is the magnifying counterpart of scroller.js. `pxPerCell` is the zoom
 * (source pixels per grid cell), `fitRect`/`fillRect` are the two presets that
 * pick it for you (contain vs cover, aspect preserved), and `Panner` slides the
 * resulting drawing through the grid one fractional cell at a time. Fractional
 * for the same reason the marquee is fractional: a whole-cell step on a 20-cell
 * grid is a visible jump.
 *
 * Anchoring is deliberately asymmetric. The axis being panned is aligned to the
 * NEAR edge of the grid, so offset 0 is the top of the page and offset `span` is
 * the bottom — the whole page is reachable. Centring that axis would start the
 * sweep in the middle of the page and never show its head. The cross axis is
 * centred, which is what keeps a wide page's text column in the middle of the
 * wall. When the source already fits the grid there is nothing to pan, so the
 * pan axis centres too and the letterbox is split evenly.
 *
 * No DOM, no browser APIs. The source is a core Bitmap (whatever web/ decodes
 * from a PNG); the geometry and the scrolling live here and are testable.
 */

import { blitArea } from './raster.js';

/** @typedef {import('./scroller.js').Bitmap} Bitmap */

export const DOWN = 1;
export const UP = -1;

/**
 * Validate geometry inputs once, at the boundary. A zero/negative source or grid
 * here produces NaN offsets that read as a black panel, which is far harder to
 * debug than an exception naming the bad number.
 */
function checkGeometry(srcW, srcH, dstCols, dstRows) {
  if (!(srcW > 0) || !(srcH > 0)) {
    throw new RangeError(`source must have positive size, got ${srcW}x${srcH}`);
  }
  if (!(dstCols > 0) || !(dstRows > 0)) {
    throw new RangeError(`destination grid must be positive, got ${dstCols}x${dstRows}`);
  }
}

/**
 * Contain: the WHOLE source is visible, aspect preserved, centred.
 *
 * The source is letterboxed — it never exceeds the grid, so one axis equals the
 * grid and the other is smaller. Right for a logo or a screenshot you must not
 * crop; wrong for a page, because it shrinks the text.
 *
 * Returned in DESTINATION CELL units, ready for raster.blitArea: `w`/`h` are the
 * source's size expressed in grid cells (its `srcCells`/`srcCellH`), `x`/`y` are
 * where its top-left sits, and `scale` is source pixels per grid cell — the zoom.
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {number} dstCols grid width in cells
 * @param {number} dstRows grid height in cells
 * @returns {{x: number, y: number, w: number, h: number, scale: number}}
 */
export function fitRect(srcW, srcH, dstCols, dstRows) {
  checkGeometry(srcW, srcH, dstCols, dstRows);
  const { w, h, scale } = fitSize(srcW, srcH, dstCols, dstRows);
  return { x: (dstCols - w) / 2, y: (dstRows - h) / 2, w, h, scale };
}

/**
 * Cover: the WHOLE grid is covered, aspect preserved, centred.
 *
 * The mirror of fitRect — the source overflows the grid on one axis, so `x` or
 * `y` is negative and the edges are cropped. This is the mode a page wants: the
 * grid is filled at the largest scale that keeps the width honest, and the
 * overflow is exactly the material a Panner scrolls through.
 *
 * @param {number} srcW source width in pixels
 * @param {number} srcH source height in pixels
 * @param {number} dstCols grid width in cells
 * @param {number} dstRows grid height in cells
 * @returns {{x: number, y: number, w: number, h: number, scale: number}}
 */
export function fillRect(srcW, srcH, dstCols, dstRows) {
  checkGeometry(srcW, srcH, dstCols, dstRows);
  const { w, h, scale } = fillSize(srcW, srcH, dstCols, dstRows);
  return { x: (dstCols - w) / 2, y: (dstRows - h) / 2, w, h, scale };
}

/** Contain sizing: the axis tighter in the source fills the grid, the other shrinks. */
function fitSize(srcW, srcH, dstCols, dstRows) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstCols / dstRows;
  const w = srcAspect >= dstAspect ? dstCols : dstRows * srcAspect;
  const h = srcAspect >= dstAspect ? dstCols / srcAspect : dstRows;
  return { w, h, scale: srcW / w };
}

/** Cover sizing: the looser axis of the source fills the grid, the other overflows. */
function fillSize(srcW, srcH, dstCols, dstRows) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstCols / dstRows;
  const w = srcAspect >= dstAspect ? dstRows * srcAspect : dstCols;
  const h = srcAspect >= dstAspect ? dstRows : dstCols / srcAspect;
  return { w, h, scale: srcW / w };
}

/**
 * A fitRect/fillRect drawing (or an explicit zoom), panned along one axis.
 *
 * Geometry is recomputed whenever `source` is reassigned, because a fresh
 * capture has a different height and the pan range depends on it. The offset
 * itself is kept across refreshes, so a live feed does not jump back to the top
 * of the page every time it is re-shot.
 */
export class Panner {
  /**
   * @param {object} opts
   * @param {import('./panel.js').Panel} opts.panel
   * @param {Bitmap} opts.source
   * @param {'fill'|'fit'} [opts.mode] fill = cover and pan (default), fit = contain
   * @param {number} [opts.pxPerCell] zoom override: source pixels per grid cell.
   *   Omit it and the mode picks one. Larger = more magnified = fewer cells of
   *   the page visible at once.
   * @param {'x'|'y'} [opts.axis] axis to pan along (default 'y': read down the page)
   * @param {number} [opts.cellsPerFrame] fractional advance per frame
   * @param {number} [opts.direction] DOWN (1) or UP (-1)
   * @param {boolean} [opts.loop] wrap to the far end when the pan runs out
   * @param {boolean} [opts.clear] clear the panel before each render
   * @param {number} [opts.opacity] 0..1
   * @param {'replace'|'add'|'max'} [opts.blend]
   */
  constructor(opts) {
    const { panel, source } = opts;
    if (!panel) throw new TypeError('Panner requires a panel');
    if (!source || !source.rgba) throw new TypeError('Panner requires a source bitmap');

    this.panel = panel;
    this.source = source;
    this.mode = opts.mode ?? 'fill';
    if (this.mode !== 'fill' && this.mode !== 'fit') {
      throw new RangeError(`mode must be 'fill' or 'fit', got ${opts.mode}`);
    }
    this.axis = opts.axis ?? 'y';
    if (this.axis !== 'x' && this.axis !== 'y') {
      throw new RangeError(`axis must be 'x' or 'y', got ${opts.axis}`);
    }
    this.cellsPerFrame = opts.cellsPerFrame ?? 0.15;
    this.direction = opts.direction ?? DOWN;
    if (this.direction !== DOWN && this.direction !== UP) {
      throw new RangeError(`direction must be DOWN (1) or UP (-1), got ${opts.direction}`);
    }
    if (!(this.cellsPerFrame >= 0)) {
      throw new RangeError(`cellsPerFrame must be >= 0, got ${this.cellsPerFrame}`);
    }
    this.loop = opts.loop ?? true;
    this.clearBeforeRender = opts.clear ?? true;
    this.opacity = opts.opacity ?? 1;
    this.blend = opts.blend ?? 'replace';

    /** Zoom override; null means "derive it from the mode". */
    this.pxPerCell = opts.pxPerCell ?? null;
    if (this.pxPerCell !== null && !(this.pxPerCell > 0)) {
      throw new RangeError(`pxPerCell must be > 0, got ${this.pxPerCell}`);
    }

    /** Pan position in cells along `axis`, measured from the near end. */
    this.offset = 0;
    // Same convention as Scroller: one scratch buffer for the downsample, so a
    // 30 fps render loop does not allocate 1200 bytes every frame.
    this.scratch = new Uint8Array(panel.cols * panel.rows * 3);
  }

  /**
   * How the source is drawn right now: {x, y, w, h, scale} in cells.
   *
   * Cached against the source size and the zoom, so a 500 ms refresh of an
   * unchanged capture does not redo the maths and a new capture invalidates it.
   */
  get rect() {
    const key = this.#geometryKey();
    if (this.#rect === null || this.#rectKey !== key) {
      const { w: srcW, h: srcH } = this.source;
      const cols = this.panel.cols;
      const rows = this.panel.rows;

      let w;
      let h;
      let scale;
      if (this.pxPerCell === null) {
        ({ w, h, scale } = this.mode === 'fill'
          ? fillSize(srcW, srcH, cols, rows)
          : fitSize(srcW, srcH, cols, rows));
      } else {
        // Explicit zoom: the source keeps its aspect at that scale, and whatever
        // hangs past the grid is what the pan walks through.
        w = srcW / this.pxPerCell;
        h = srcH / this.pxPerCell;
        scale = this.pxPerCell;
      }

      const pannable = (this.axis === 'y' ? h : w) > (this.axis === 'y' ? rows : cols);
      // Pan axis: near-aligned while there is off-grid material to reach, so the
      // sweep covers the whole source. Centred once it fits, so the letterbox is
      // split instead of hanging off the far edge. Cross axis: always centred.
      const panCells = this.axis === 'y' ? h : w;
      const panGrid = this.axis === 'y' ? rows : cols;
      const crossCells = this.axis === 'y' ? w : h;
      const crossGrid = this.axis === 'y' ? cols : rows;
      const panPos = pannable ? 0 : (panGrid - panCells) / 2;
      const crossPos = (crossGrid - crossCells) / 2;

      this.#rect = this.axis === 'y'
        ? { x: crossPos, y: panPos, w, h, scale }
        : { x: panPos, y: crossPos, w, h, scale };
      this.#rectKey = key;
    }
    return this.#rect;
  }

  #geometryKey() {
    // axis is in the key because it decides which axis is near-aligned: change
    // it and the cached rect would pan the wrong way through the source.
    return `${this.source.w}x${this.source.h}:${this.pxPerCell}:${this.mode}:${this.axis}`;
  }

  /**
   * How far the window can pan before the source runs out, in cells.
   *
   * Zero when the source already fits the grid — there is nothing off-grid to
   * scroll to, and `advance` then does nothing instead of wrapping a division by
   * zero.
   */
  get span() {
    const panCells = this.axis === 'y' ? this.rect.h : this.rect.w;
    const panGrid = this.axis === 'y' ? this.panel.rows : this.panel.cols;
    return Math.max(0, panCells - panGrid);
  }

  /** Fraction of the source on the grid at once, 0..1. */
  get visible() {
    const r = this.rect;
    const cells = this.panel.cols * this.panel.rows;
    return Math.min(1, cells / (r.w * r.h));
  }

  /** 0 at the near end of the source, 1 at the far end. */
  get progress() {
    const span = this.span;
    return span > 0 ? this.offset / span : 0;
  }

  /**
   * Move the window along the source. Fractional cells are kept, not rounded.
   *
   * @param {number} [cells] override the step (negative reverses direction)
   * @returns {number} the new offset
   */
  advance(cells = this.cellsPerFrame) {
    const span = this.span;
    if (span === 0) return (this.offset = 0);

    let next = this.offset + cells * this.direction;
    if (this.loop) {
      // Wrap, so a live feed keeps cycling the page instead of parking at the
      // bottom. Modulo handles negative steps and steps larger than span.
      next = ((next % span) + span) % span;
    } else {
      next = Math.min(span, Math.max(0, next));
    }
    return (this.offset = next);
  }

  /** Jump straight to a fraction of the source (0 = top, 1 = bottom). */
  seek(progress) {
    if (!(progress >= 0) || progress > 1) {
      throw new RangeError(`progress must be in [0,1], got ${progress}`);
    }
    this.offset = progress * this.span;
    return this.offset;
  }

  /**
   * Draw the current window into the panel.
   *
   * The pan enters blitArea as a NEGATIVE destination offset: destination cell d
   * samples source cell (d - offset), so pushing `offset` negative makes d sample
   * deeper into the source — i.e. further down the page.
   */
  render(target = this.panel) {
    const r = this.rect;
    if (this.clearBeforeRender) target.clear();
    blitArea(target, this.source.rgba, this.source.w, this.source.h, {
      x: r.x - (this.axis === 'x' ? this.offset : 0),
      y: r.y - (this.axis === 'y' ? this.offset : 0),
      srcCells: r.w,
      srcCellH: r.h,
      opacity: this.opacity,
      mode: this.blend,
      // Scratch is sized for this.panel; a differently sized target gets its own.
      scratch: target === this.panel ? this.scratch : undefined,
    });
    return target;
  }

  /** Advance + render in one call — the frame loop's hot path. */
  tick(target = this.panel) {
    this.advance();
    return this.render(target);
  }

  #rect = null;
  #rectKey = '';
}

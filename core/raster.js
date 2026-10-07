/**
 * raster — area-averaged downsampling from a high-resolution source bitmap
 * into the 20x20 grid.
 *
 * Area averaging, never nearest-neighbour: at 50 mm pitch a 20x20 grid is very
 * coarse, and nearest-neighbour sampling snaps glyph edges to whole cells,
 * which reads as crunchy flicker while text scrolls. Averaging the source area
 * each cell covers gives stable, anti-aliased output.
 *
 * core/ stays DOM-free, so the source here is a plain RGBA buffer (whatever the
 * browser produced from its offscreen canvas via getImageData). The canvas work
 * lives in web/; the maths lives here and is testable in Node.
 *
 * No DOM, no browser APIs.
 */

import { BYTES_PER_PIXEL } from './panel.js';

/**
 * Area-average an RGBA source down to dstW x dstH RGB.
 *
 * Fractional offsets are honoured: dst cell (dx,dy) covers the source rectangle
 * [(dx - ox) * sx, (dx + 1 - ox) * sx) x [(dy - oy) * sy, (dy + 1 - oy) * sy),
 * weighted by actual overlap area. That is what makes a marquee glide instead
 * of stepping a whole glyph per tick.
 *
 * Alpha is coverage, and coverage survives into the output: a cell's value is
 * its average ink colour SCALED BY the fraction of the cell area that carries
 * ink, i.e. `sum(alpha * area * rgb) / (cellArea * 255)`. Dividing by the
 * covered alpha instead would cancel coverage — a cell touched by a single
 * antialiased fringe pixel would come back at full brightness, and a scrolling
 * marquee would step a whole cell per tick no matter how fractional the offset
 * is. Area outside the source bitmap counts as transparent, so a cell clipped by
 * the source edge is correctly dimmer.
 *
 * @param {Uint8Array|Uint8ClampedArray} src RGBA, row-major
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {object} [opts]
 * @param {number} [opts.offsetX] destination-space x offset of the source (fractional allowed)
 * @param {number} [opts.offsetY]
 * @param {number} [opts.srcCells] source width expressed in destination cells (default dstW)
 * @param {number} [opts.srcCellH] source height in destination cells (default dstH)
 * @param {Uint8Array} [opts.out] reusable dstW*dstH*3 buffer
 * @returns {Uint8Array} RGB, dstW*dstH*3
 */
export function downsampleArea(src, srcW, srcH, dstW, dstH, opts = {}) {
  if (srcW < 1 || srcH < 1) throw new RangeError(`source must be >= 1x1, got ${srcW}x${srcH}`);
  if (dstW < 1 || dstH < 1) throw new RangeError(`destination must be >= 1x1, got ${dstW}x${dstH}`);
  const expected = srcW * srcH * 4;
  if (src.length < expected) {
    throw new RangeError(`source buffer too small: need ${expected} bytes, got ${src.length}`);
  }

  const cellsW = opts.srcCells ?? dstW;
  const cellsH = opts.srcCellH ?? dstH;
  if (!(cellsW > 0) || !(cellsH > 0)) throw new RangeError('srcCells/srcCellH must be > 0');

  const ox = opts.offsetX ?? 0;
  const oy = opts.offsetY ?? 0;
  const sx = srcW / cellsW;
  const sy = srcH / cellsH;

  const out = opts.out ?? new Uint8Array(dstW * dstH * BYTES_PER_PIXEL);

  /** Source pixels per destination cell: the denominator every cell is measured
   *  against, so partial coverage reads as partial brightness. */
  const cellArea = sx * sy;
  const invCell = 1 / (cellArea * 255);

  for (let dy = 0; dy < dstH; dy++) {
    // Source row overlap for this destination row.
    const y0 = (dy - oy) * sy;
    const y1 = (dy + 1 - oy) * sy;
    let sy0 = Math.floor(y0);
    let sy1 = Math.ceil(y1);
    if (sy1 > srcH) sy1 = srcH;
    if (sy0 < 0) sy0 = 0;

    for (let dx = 0; dx < dstW; dx++) {
      const x0 = (dx - ox) * sx;
      const x1 = (dx + 1 - ox) * sx;
      let sx0 = Math.floor(x0);
      let sx1 = Math.ceil(x1);
      if (sx1 > srcW) sx1 = srcW;
      if (sx0 < 0) sx0 = 0;

      const o = (dy * dstW + dx) * BYTES_PER_PIXEL;

      // No source overlap at all: the cell is fully transparent. Written
      // explicitly because `out` may be a buffer reused from the previous frame.
      if (sy1 <= sy0 || sx1 <= sx0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        continue;
      }

      let accR = 0, accG = 0, accB = 0;

      for (let y = sy0; y < sy1; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        const row = y * srcW;
        for (let x = sx0; x < sx1; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const a = src[(row + x) * 4 + 3];
          if (a === 0) continue;
          const wa = a * wx * wy;
          accR += src[(row + x) * 4] * wa;
          accG += src[(row + x) * 4 + 1] * wa;
          accB += src[(row + x) * 4 + 2] * wa;
        }
      }

      out[o] = accR * invCell;
      out[o + 1] = accG * invCell;
      out[o + 2] = accB * invCell;
    }
  }

  return out;
}

/**
 * Area-average an RGBA source straight into a Panel.
 *
 * @param {import('./panel.js').Panel} panel
 * @param {Uint8Array|Uint8ClampedArray} src RGBA
 * @param {number} srcW
 * @param {number} srcH
 * @param {object} [opts]
 * @param {number} [opts.x] destination cell offset
 * @param {number} [opts.y]
 * @param {number} [opts.dstW] destination width in cells (default panel.cols)
 * @param {number} [opts.dstH]
 * @param {number} [opts.srcCells] source width expressed in cells (its natural size)
 * @param {number} [opts.srcCellH]
 * @param {number} [opts.opacity] 0..1 multiplier
 * @param {'replace'|'add'|'max'} [opts.mode]
 * @param {Uint8Array} [opts.scratch] reusable RGB scratch
 */
export function blitArea(panel, src, srcW, srcH, opts = {}) {
  const dstW = opts.dstW ?? panel.cols;
  const dstH = opts.dstH ?? panel.rows;
  const opacity = opts.opacity ?? 1;
  const mode = opts.mode ?? 'replace';

  const rgb = downsampleArea(src, srcW, srcH, dstW, dstH, {
    offsetX: opts.x ?? 0,
    offsetY: opts.y ?? 0,
    srcCells: opts.srcCells,
    srcCellH: opts.srcCellH,
    out: opts.scratch,
  });

  const px = panel.pixels;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const gx = dx + (opts.cellX ?? 0);
      const gy = dy + (opts.cellY ?? 0);
      if (!panel.inBounds(gx, gy)) continue;
      const i = (gy * panel.cols + gx) * BYTES_PER_PIXEL;
      const j = (dy * dstW + dx) * BYTES_PER_PIXEL;
      const r = rgb[j] * opacity;
      const g = rgb[j + 1] * opacity;
      const b = rgb[j + 2] * opacity;
      if (mode === 'add') {
        px[i] = Math.min(255, px[i] + r);
        px[i + 1] = Math.min(255, px[i + 1] + g);
        px[i + 2] = Math.min(255, px[i + 2] + b);
      } else if (mode === 'max') {
        if (r > px[i]) px[i] = r;
        if (g > px[i + 1]) px[i + 1] = g;
        if (b > px[i + 2]) px[i + 2] = b;
      } else {
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
    }
  }
  return panel;
}

/**
 * Downsample a plain RGB source (no alpha channel) — handy for tests and for
 * bitmap effects that do not come from a canvas.
 */
export function downsampleAreaRGB(src, srcW, srcH, dstW, dstH, opts = {}) {
  const rgba = new Uint8Array(srcW * srcH * 4);
  for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
    rgba[j] = src[i];
    rgba[j + 1] = src[i + 1];
    rgba[j + 2] = src[i + 2];
    rgba[j + 3] = 255;
  }
  return downsampleArea(rgba, srcW, srcH, dstW, dstH, opts);
}

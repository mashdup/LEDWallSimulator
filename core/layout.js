/**
 * Layout — logical (x,y) -> physical LED index.
 *
 * THIS IS THE FILE YOU EDIT ONCE WHEN THE WIRING IS REAL.
 * Everything else (renderer, effects, sim, protocol) stays untouched.
 *
 * Model of a real curtain panel:
 *   - the grid is cut into strips of `stripLength` LEDs
 *   - a strip advances along `stripAxis` ('x' = a strip is one row, 'y' = one column)
 *   - `snake` makes alternate strips run backwards, which is what a serpentine
 *     daisy-chain physically does
 *   - `startOffsets` handles strips that do not begin at stripLength*n on the
 *     data line (spliced controller, spare LEDs, a tail segment)
 *   - flipX / flipY / transpose correct "the panel is mounted upside down /
 *     rotated / the strips run the other way"
 *
 * No DOM, no browser APIs.
 */

import { DEFAULT_COLS, DEFAULT_ROWS } from './panel.js';

export const LAYOUT_DEFAULTS = {
  cols: DEFAULT_COLS,
  rows: DEFAULT_ROWS,
  /** Axis a strip travels along. 'x': a strip is one row of `stripLength` cells. */
  stripAxis: 'x',
  stripLength: DEFAULT_COLS,
  /** Optional per-strip physical start offset. null => stripLength * stripIndex. */
  startOffsets: null,
  /** Alternate strips run backwards (serpentine wiring). */
  snake: true,
  flipX: false,
  flipY: false,
  /** Grid is wired rotated 90 degrees. Requires a square grid. */
  transpose: false,
};

/**
 * @typedef {typeof LAYOUT_DEFAULTS} LayoutConfig
 */

export class Layout {
  /** @param {Partial<LayoutConfig>} [config] */
  constructor(config = {}) {
    const cfg = { ...LAYOUT_DEFAULTS, ...config };

    const { cols, rows } = cfg;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError(`Layout dimensions must be positive integers, got ${cols}x${rows}`);
    }
    if (cfg.transpose && cols !== rows) {
      throw new RangeError(`transpose requires a square grid, got ${cols}x${rows}`);
    }
    if (cfg.stripAxis !== 'x' && cfg.stripAxis !== 'y') {
      throw new RangeError(`stripAxis must be 'x' or 'y', got ${JSON.stringify(cfg.stripAxis)}`);
    }

    const count = cols * rows;
    const stripLength = cfg.stripLength;
    if (!Number.isInteger(stripLength) || stripLength < 1 || count % stripLength !== 0) {
      throw new RangeError(
        `stripLength must divide the pixel count: ${count} % ${stripLength} !== 0`,
      );
    }


    const strips = count / stripLength;
    let offsets = cfg.startOffsets;
    if (offsets != null) {
      if (offsets.length !== strips) {
        throw new RangeError(`startOffsets must have ${strips} entries, got ${offsets.length}`);
      }
      offsets = Array.from(offsets, (v) => {
        if (!Number.isInteger(v) || v < 0) {
          throw new RangeError(`startOffsets entries must be non-negative integers, got ${v}`);
        }
        return v;
      });
    }

    this.cols = cols;
    this.rows = rows;
    this.count = count;
    this.strips = strips;
    this.stripLength = stripLength;
    this.stripAxis = cfg.stripAxis;
    this.snake = cfg.snake;
    this.flipX = cfg.flipX;
    this.flipY = cfg.flipY;
    this.transpose = cfg.transpose;
    this.startOffsets = offsets;

    this.map = this.#buildMap();
    this.inverse = invertMap(this.map, count);
  }

  /** Physical index for logical cell (x,y). Out of range returns -1. */
  index(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return -1;
    return this.map[y * this.cols + x];
  }

  /** Logical cell holding physical LED `p`, as [x,y]. */
  cellOf(p) {
    const c = this.inverse[p];
    if (c == null || c < 0) return null;
    return [c % this.cols, (c / this.cols) | 0];
  }

  /** Same layout with flags changed — immutable, so calibration can try variants. */
  with(flags) {
    return new Layout({
      cols: this.cols,
      rows: this.rows,
      stripAxis: this.stripAxis,
      stripLength: this.stripLength,
      startOffsets: this.startOffsets,
      snake: this.snake,
      flipX: this.flipX,
      flipY: this.flipY,
      transpose: this.transpose,
      ...flags,
    });
  }

  #buildMap() {
    const { cols, rows, stripLength, strips, stripAxis, snake } = this;
    const offsets = this.startOffsets;
    const map = new Int32Array(this.count);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // 1. Mounting corrections: logical grid -> wiring-space coordinates.
        let u = x;
        let v = y;
        if (this.transpose) {
          const t = u;
          u = v;
          v = t;
        }
        if (this.flipX) u = cols - 1 - u;
        if (this.flipY) v = rows - 1 - v;

        // 2. Wiring space is a linear raster along the strip axis: for 'x' a
        // strip runs across a row and continues into the next row when
        // stripLength > cols. strip = linear / stripLength, pos = linear % it.
        const linear = stripAxis === 'x' ? v * cols + u : u * rows + v;
        const strip = (linear / stripLength) | 0;
        let pos = linear % stripLength;
        if (snake && (strip & 1) === 1) pos = stripLength - 1 - pos;

        const start = offsets ? offsets[strip] : strip * stripLength;
        map[y * cols + x] = start + pos;
      }
    }

    // A layout is only valid if it is a permutation: two cells landing on one
    // LED means half the wall is dead, and that must fail here rather than
    // corrupt the panel after it is mounted.
    const seen = new Int32Array(this.count).fill(-1);
    for (let c = 0; c < this.count; c++) {
      const p = map[c];
      if (p < 0 || p >= this.count) {
        throw new RangeError(
          `layout maps cell ${c} to physical ${p}, outside 0..${this.count - 1}`,
        );
      }
      if (seen[p] !== -1) {
        throw new RangeError(
          `physical LED ${p} claimed by cells ${seen[p]} and ${c}; check stripLength/startOffsets`,
        );
      }
      seen[p] = c;
    }
    return map;
  }

  /** Human-readable wiring description, for the calibration pass. */
  describe() {
    const flags = [
      this.transpose ? 'transpose' : null,
      this.flipX ? 'flipX' : null,
      this.flipY ? 'flipY' : null,
      this.snake ? 'snake' : null,
    ].filter(Boolean).join(', ') || 'straight';
    const axis = this.stripAxis === 'x' ? 'rows' : 'columns';
    return `${this.cols}x${this.rows} ${axis} of ${this.stripLength} (${flags})`;
  }

  /** Compact one-line map preview: physical index per row of cells. */
  preview() {
    const { cols, rows } = this;
    const lines = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push(String(this.map[y * cols + x]).padStart(3, ' '));
      lines.push(row.join(''));
    }
    return lines.join('\n');
  }
}

function invertMap(map, count) {
  const inv = new Int32Array(count);
  for (let c = 0; c < count; c++) inv[map[c]] = c;
  return inv;
}

/**
 * Physical index == logical index. Useful as the reference frame for the
 * "what the wall actually sees" preview: pack with the real layout, then
 * unpack with identity, and any wiring mistake shows up as scrambled text.
 */
export function identity(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  return new Layout({ cols, rows, stripLength: cols, snake: false, flipX: false, flipY: false });
}

/**
 * The eight mounting variants to try against a real panel.
 * Milestone 5 is "which of these is it" — enumerate them instead of guessing.
 */
export function* layoutVariants(base = LAYOUT_DEFAULTS) {
  const seed = { ...LAYOUT_DEFAULTS, ...base };
  for (const transpose of [false, true]) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        yield new Layout({ ...seed, transpose, flipX, flipY });
      }
    }
  }
}

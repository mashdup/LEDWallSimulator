/**
 * Panel — the logical 20x20 framebuffer.
 *
 * Pure data: a flat RGB byte array in LOGICAL (x,y) order. Physical wiring is
 * applied later by layout.js / buffer.js, so nothing here knows about strips.
 *
 * No DOM, no fetch, no browser APIs — this must run under Node so it is testable,
 * and it must stay plain JS so the browser can import the exact same files.
 */

export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 20;
export const BYTES_PER_PIXEL = 3;

export class Panel {
  /**
   * @param {number} [cols]
   * @param {number} [rows]
   */
  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError(`Panel dimensions must be positive integers, got ${cols}x${rows}`);
    }
    this.cols = cols;
    this.rows = rows;
    /** Flat RGB, logical order: index = (y * cols + x) * 3 */
    this.pixels = new Uint8Array(cols * rows * BYTES_PER_PIXEL);
  }

  /** Total logical pixels. */
  get count() {
    return this.cols * this.rows;
  }

  /** Byte length of the flat RGB array (1200 for a 20x20 panel). */
  get byteLength() {
    return this.pixels.length;
  }

  /**
   * Write one pixel. Out-of-range coordinates are clipped and return false —
   * the scroller relies on this rather than try/catch in the hot path.
   */
  setPixel(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return false;
    const i = (y * this.cols + x) * BYTES_PER_PIXEL;
    const p = this.pixels;
    p[i] = r;
    p[i + 1] = g;
    p[i + 2] = b;
    return true;
  }

  /** Read one pixel as [r,g,b]; out of range returns null. */
  getPixel(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    const i = (y * this.cols + x) * BYTES_PER_PIXEL;
    const p = this.pixels;
    return [p[i], p[i + 1], p[i + 2]];
  }

  /** True when the coordinate is on the grid. */
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  clear() {
    this.pixels.fill(0);
    return this;
  }

  fill(r, g, b) {
    const p = this.pixels;
    for (let i = 0; i < p.length; i += BYTES_PER_PIXEL) {
      p[i] = r;
      p[i + 1] = g;
      p[i + 2] = b;
    }
    return this;
  }

  /**
   * Copy of the grid in LOGICAL order. Use this for the sim; use
   * buffer.pack() for anything that goes to the wall.
   */
  toBytes() {
    return this.pixels.slice();
  }

  /** Copy of the grid scaled by a 0..1 multiplier, without mutating the panel. */
  toBytesScaled(k) {
    const src = this.pixels;
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = (src[i] * k) | 0;
    return out;
  }

  /** Replace the whole grid from a flat logical-order RGB array. */
  setPixels(bytes) {
    if (bytes.length !== this.pixels.length) {
      throw new RangeError(`Expected ${this.pixels.length} bytes, got ${bytes.length}`);
    }
    this.pixels.set(bytes);
    return this;
  }

  /** Cheap equality, for tests and for skipping unchanged frames. */
  equals(other) {
    if (other.cols !== this.cols || other.rows !== this.rows) return false;
    const a = this.pixels, b = other.pixels;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
}

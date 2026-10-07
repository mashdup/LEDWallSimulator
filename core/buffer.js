/**
 * buffer — logical grid -> flat RGB in PHYSICAL LED order (1200 bytes).
 *
 * The wall receives bytes in the order its LEDs are wired. The renderer only
 * ever thinks in (x,y). pack() is the one crossing.
 *
 * No DOM, no browser APIs.
 */

import { Panel, BYTES_PER_PIXEL } from './panel.js';

/**
 * Pack a Panel into physical LED order.
 * @param {Panel} panel
 * @param {import('./layout.js').Layout} layout
 * @param {Uint8Array} [out] reusable 1200-byte scratch buffer
 * @returns {Uint8Array}
 */
export function packInto(panel, layout, out) {
  if (panel.count !== layout.count) {
    throw new RangeError(
      `panel (${panel.count} cells) and layout (${layout.count} cells) disagree`,
    );
  }
  const dst = out ?? new Uint8Array(layout.count * BYTES_PER_PIXEL);
  if (dst.length !== layout.count * BYTES_PER_PIXEL) {
    throw new RangeError(`out must be ${layout.count * BYTES_PER_PIXEL} bytes, got ${dst.length}`);
  }

  const src = panel.pixels;
  const map = layout.map;
  for (let cell = 0, cells = layout.count; cell < cells; cell++) {
    const s = cell * BYTES_PER_PIXEL;
    const p = map[cell] * BYTES_PER_PIXEL;
    dst[p] = src[s];
    dst[p + 1] = src[s + 1];
    dst[p + 2] = src[s + 2];
  }
  return dst;
}

export function pack(panel, layout) {
  return packInto(panel, layout);
}

/**
 * Inverse: physical-order bytes -> a Panel in logical order.
 * Used by the "what the wall actually sees" sim toggle: pack with the real
 * layout, unpack with identity, and a wiring mistake appears as scrambled text.
 */
export function unpack(bytes, layout) {
  if (bytes.length !== layout.count * BYTES_PER_PIXEL) {
    throw new RangeError(
      `expected ${layout.count * BYTES_PER_PIXEL} bytes, got ${bytes.length}`,
    );
  }
  const panel = new Panel(layout.cols, layout.rows);
  const dst = panel.pixels;
  const inv = layout.inverse;
  for (let led = 0, n = layout.count; led < n; led++) {
    const p = led * BYTES_PER_PIXEL;
    const c = inv[led] * BYTES_PER_PIXEL;
    dst[c] = bytes[p];
    dst[c + 1] = bytes[p + 1];
    dst[c + 2] = bytes[p + 2];
  }
  return panel;
}

/**
 * Pack with an optional brightness multiplier applied, without mutating the panel.
 */
export function packScaled(panel, layout, k) {
  const src = panel.pixels;
  const dst = new Uint8Array(src.length);
  const map = layout.map;
  for (let cell = 0, cells = layout.count; cell < cells; cell++) {
    const s = cell * BYTES_PER_PIXEL;
    const p = map[cell] * BYTES_PER_PIXEL;
    dst[p] = (src[s] * k) | 0;
    dst[p + 1] = (src[s + 1] * k) | 0;
    dst[p + 2] = (src[s + 2] * k) | 0;
  }
  return dst;
}

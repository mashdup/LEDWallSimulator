/**
 * User drawings: the 20x20 pixel model shared by the editor page, the
 * server's drawing store, the content protocol, and the gallery renderer.
 *
 * A drawing is one flat Uint8Array of RGBA bytes, 4 bytes per cell, row
 * major, 20x20 = 1600 bytes. Alpha is the whole transparency story: a cell
 * with a=0 is "not used", renders as nothing (the wall's black shows
 * through), and is skipped by the editor's checkerboard.
 *
 * The wire form is lowercase hex of those bytes (3200 chars): tiny, cheap
 * to validate with one regex, and it rides the existing JSON content
 * channel without base64 plumbing on either side.
 *
 * Pure module: no DOM, no fetch, no fs. It runs under Node so the tests
 * exercise the exact code the browser runs.
 */

export const GRID = 20;
export const PIXEL_BYTES = GRID * GRID * 4;
export const PIXEL_HEX_LEN = PIXEL_BYTES * 2;

const HEX_RE = /^[0-9a-f]+$/;

/** emptyPixels() -> fresh all-transparent RGBA grid. */
export function emptyPixels() {
  return new Uint8Array(PIXEL_BYTES);
}

/** pixelsFromHex(hex) -> Uint8Array, or null if not exactly PIXEL_HEX_LEN hex chars. */
export function pixelsFromHex(hex) {
  if (typeof hex !== 'string' || hex.length !== PIXEL_HEX_LEN || !HEX_RE.test(hex)) return null;
  const bytes = new Uint8Array(PIXEL_BYTES);
  for (let i = 0; i < PIXEL_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** pixelsToHex(bytes) -> lowercase hex string, the wire form of a drawing. */
export function pixelsToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** isPixelHex(v) -> true for a legal wire form. */
export function isPixelHex(v) {
  return typeof v === 'string' && v.length === PIXEL_HEX_LEN && HEX_RE.test(v);
}

/** parseColor('#rgb'|'#rrggbb'|'#rrggbbaa') -> [r,g,b,a 0-255], or null. */
export function parseColor(css) {
  if (typeof css !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(css);
  if (m === null) return null;
  const h = m[1];
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 255];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
  ];
}

/**
 * floodFill(bytes, x, y, [r, g, b, a]) -> true when it painted.
 *
 * Classic 4-neighbour bucket fill over the RAW bytes: a cell counts as the
 * target when its bytes match, so transparency is a region like any color —
 * filling the "unused" area with a color is how a black background gets
 * painted deliberately, and filling it back to transparent is the eraser's
 * blob. A fill of the exact same color is a no-op (returns false), which is
 * what stops the flood from recursing forever.
 */
export function floodFill(bytes, x, y, rgba) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GRID || y >= GRID) return false;
  const start = (y * GRID + x) * 4;
  const same = bytes[start] === rgba[0] && bytes[start + 1] === rgba[1]
    && bytes[start + 2] === rgba[2] && bytes[start + 3] === rgba[3];
  if (same) return false;
  const tr = bytes[start], tg = bytes[start + 1], tb = bytes[start + 2], ta = bytes[start + 3];
  const stack = [start];
  while (stack.length > 0) {
    const p = stack.pop();
    if (bytes[p] !== tr || bytes[p + 1] !== tg || bytes[p + 2] !== tb || bytes[p + 3] !== ta) continue;
    bytes[p] = rgba[0];
    bytes[p + 1] = rgba[1];
    bytes[p + 2] = rgba[2];
    bytes[p + 3] = rgba[3];
    const px = (p / 4) % GRID;
    if (px > 0) stack.push(p - 4);
    if (px < GRID - 1) stack.push(p + 4);
    if (p - GRID * 4 >= 0) stack.push(p - GRID * 4);
    if (p + GRID * 4 < PIXEL_BYTES) stack.push(p + GRID * 4);
  }
  return true;
}

/**
 * Drawing entries, the server store's shape: {id, name, pixels, createdAt}.
 * pixels is the hex wire form. validateEntry checks the SHAPE only (no fs,
 * no ids from the wire); the server composes it with newDrawing.
 */
export function newDrawing(name, pixels, now = Date.now()) {
  return {
    id: crypto.randomUUID(),
    name: String(name ?? '').trim().slice(0, 40),
    pixels: pixelsToHex(pixels),
    createdAt: now,
  };
}

export function validateEntry(e) {
  return e !== null && typeof e === 'object'
    && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64
    && typeof e.name === 'string' && e.name.length <= 40
    && isPixelHex(e.pixels)
    && Number.isFinite(e.createdAt);
}

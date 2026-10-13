/**
 * anim-400.js — the scene behind anim-400.html, kept DOM-free on purpose.
 *
 * The page is a thin shell that paints this into a canvas; test/anim-page.test.js
 * imports the SAME functions to compute the pixels the page is supposed to paint.
 * That is the whole point of splitting it out: a test that redrew the bars itself
 * would only prove the test agrees with itself. Sharing the geometry means the
 * test compares "what the scene says" against "what Chromium actually returned",
 * so what is under test is the capture route — page -> browser -> PNG -> raster.
 *
 * Positions are rounded to whole source pixels. putImageData is pixel-exact and
 * has no subpixel blending, so a fractional bar edge would be a lie about what the
 * page can paint. Rounding also kills float wobble: 2/3 * 120 is 79.99999999999999
 * in IEEE-754, and a fixture that is supposed to land on a cell boundary must land
 * on it.
 */

/** Source size: exactly 20x20 grid cells at 20 source px per cell. */
export const W = 400;
export const H = 400;

/** Bar thickness in source px: 2 cells wide, 1 cell tall. */
export const BAR_W = 40;
export const BAR_H = 20;

/**
 * Bar speeds in source px per second, chosen to be exact in panel cells:
 * 120 px/s crosses a 20 px cell every 1/6 s, 90 px/s every 2/9 s. So t = 2/3 s
 * puts both bars on cell boundaries simultaneously — the frame the test asserts.
 */
export const SPEED_X = 120;
export const SPEED_Y = 90;

export const BLACK = [0, 0, 0];
export const RED = [255, 0, 0];
export const GREEN = [0, 255, 0];

/**
 * Bar origins at time `t` seconds, in whole source px, wrapped into the page.
 *
 * Wrapped twice: once before rounding so a huge `t` cannot lose precision in the
 * modulo, and once after, because rounding a value already inside the page can
 * still push it one px past the edge (t = 3.33 is 399.6 px, which rounds to 400).
 * An origin of exactly W would put the bar's first pixel on the next row.
 *
 * @param {number} t
 * @returns {{x: number, y: number}}
 */
export function bars(t) {
  if (!Number.isFinite(t)) throw new RangeError(`t must be a finite number of seconds, got ${t}`);
  const wrap = (v, size) => ((Math.round(v) % size) + size) % size;
  return {
    x: wrap(t * SPEED_X, W),
    y: wrap(t * SPEED_Y, H),
  };
}

/**
 * Paint frame `t` into an RGBA buffer, row-major, W*H*4.
 *
 * Green is painted after red, so where the bars cross the panel cell reads green.
 * The background is opaque black rather than transparent: the capture route returns
 * a PNG with no alpha channel, so an opaque source is what the browser can actually
 * hand back, and both sides of the comparison then mean the same thing.
 *
 * @param {number} t
 * @param {Uint8Array|Uint8ClampedArray} [out] reusable W*H*4 buffer
 * @returns {Uint8Array|Uint8ClampedArray} out
 */
export function frameRgba(t, out = new Uint8Array(W * H * 4)) {
  const need = W * H * 4;
  if (!out || out.length < need) {
    throw new RangeError(`frame buffer too small: need ${need} bytes, got ${out?.length}`);
  }

  for (let i = 0; i < need; i += 4) {
    out[i] = BLACK[0];
    out[i + 1] = BLACK[1];
    out[i + 2] = BLACK[2];
    out[i + 3] = 255;
  }

  const { x, y } = bars(t);

  // Both bars wrap around the page instead of running off the edge. Two reasons,
  // one of them a bug this used to have: writing px up to x + BAR_W walks past the
  // end of the row, and (row + 400) * 4 is the first pixel of the NEXT row, so a
  // bar near the right edge smeared red sideways; writing py past H fell off the
  // end of the buffer and silently dropped the rest of the bar. Wrapping keeps the
  // coverage constant at every t, which is also what a looping banner actually
  // looks like: the part leaving the right edge re-enters on the left.
  for (let dy = 0; dy < H; dy++) {
    const row = ((y + dy) % H) * W;
    for (let dx = 0; dx < BAR_W; dx++) {
      const i = (row + ((x + dx) % W)) * 4;
      out[i] = RED[0];
      out[i + 1] = RED[1];
      out[i + 2] = RED[2];
    }
  }

  for (let dy = 0; dy < BAR_H; dy++) {
    const row = ((y + dy) % H) * W;
    for (let px = 0; px < W; px++) {
      const i = (row + px) * 4;
      out[i] = GREEN[0];
      out[i + 1] = GREEN[1];
      out[i + 2] = GREEN[2];
    }
  }

  return out;
}

/**
 * The frame as core sees it: a plain {rgba, w, h} source, so a test can hand it to
 * the same downsampleArea the browser app uses without importing core/scroller.
 */
export function frameSource(t, out = new Uint8Array(W * H * 4)) {
  return { rgba: frameRgba(t, out), w: W, h: H };
}

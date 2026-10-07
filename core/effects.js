/**
 * effects — small, allocation-light grid operations.
 *
 * Everything here works on a Panel in place (or into a supplied target) so the
 * frame loop does not allocate per frame.
 *
 * No DOM, no browser APIs.
 */

import { BYTES_PER_PIXEL } from './panel.js';

/**
 * Scale every channel in place by k (0..1). This is the renderer's artistic
 * multiplier; the power clamp in power.js is a separate, safety-critical one.
 *
 * k > 1 is rejected rather than clamped: channels are already at their maximum,
 * and Uint8Array assignment wraps mod 256, so a multiplier of 2 would turn full
 * white into black. A brightness of 200 where 200/255 was meant is exactly that
 * mistake, and it should fail loudly.
 */
export function applyBrightness(panel, k) {
  if (!(k >= 0 && k <= 1)) throw new RangeError(`brightness must be within 0..1, got ${k}`);
  const p = panel.pixels;
  if (k === 1) return panel;
  for (let i = 0; i < p.length; i++) p[i] = (p[i] * k) | 0;
  return panel;
}

/**
 * Blend `over` onto `base` with per-pixel alpha (0..255), writing into `out`.
 * out === base is allowed (in-place).
 */
export function blend(base, over, alpha, out = base) {
  if (base.count !== over.count) {
    throw new RangeError(`blend panels must match: ${base.count} vs ${over.count}`);
  }
  const a = typeof alpha === 'number' ? clamp01(alpha) * 255 : null;
  const b = base.pixels, o = over.pixels, d = out.pixels;
  for (let i = 0; i < b.length; i += BYTES_PER_PIXEL) {
    for (let c = 0; c < 3; c++) {
      const t = a ?? o[i + c]; // per-channel alpha when alpha is omitted
      d[i + c] = b[i + c] + ((o[i + c] - b[i + c]) * t) / 255;
    }
  }
  return out;
}

/**
 * Wipe a transition between two panels: `from` on one side of a moving edge,
 * `to` on the other, with `feather` cells of crossfade so the edge does not
 * crawl as a hard 1-cell line.
 *
 * @param {import('./panel.js').Panel} from
 * @param {import('./panel.js').Panel} to
 * @param {number} t 0..1 progress of the wipe
 * @param {object} [opts]
 * @param {'lr'|'rl'|'tb'|'bt'|'radial'} [opts.dir]
 * @param {number} [opts.feather] cells of crossfade (0 = hard edge)
 * @param {import('./panel.js').Panel} [opts.out]
 */
export function wipe(from, to, t, opts = {}) {
  const dir = opts.dir ?? 'lr';
  const feather = Math.max(0, opts.feather ?? 2);
  const out = opts.out ?? from;
  const { cols, rows } = from;
  if (from.count !== to.count) throw new RangeError('wipe panels must match in size');

  const p = t < 0 ? 0 : t > 1 ? 1 : t;
  const fb = from.pixels, tb = to.pixels, d = out.pixels;
  const maxSpan = dir === 'radial' ? Math.hypot(cols, rows) : dir === 'lr' || dir === 'rl' ? cols : rows;
  const edge = p * (maxSpan + feather);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const pos = dir === 'lr' ? x
        : dir === 'rl' ? cols - 1 - x
        : dir === 'tb' ? y
        : dir === 'bt' ? rows - 1 - y
        : Math.hypot(x + 0.5 - cols / 2, y + 0.5 - rows / 2);

      // 0 before the feather zone (fully `from`), 1 after it (fully `to`).
      const w = feather === 0 ? (pos < edge ? 0 : 1) : clamp01((edge - pos) / feather);

      const i = (y * cols + x) * BYTES_PER_PIXEL;
      // w is already a 0..1 mix weight, unlike blend's 0..255 alpha.
      for (let c = 0; c < 3; c++) d[i + c] = fb[i + c] + (tb[i + c] - fb[i + c]) * w;
    }
  }
  return out;
}

/** Uniform colour ramp, for the wiring self-test and calibration patterns. */
export function gradient(panel, { from = [0, 0, 0], to = [255, 255, 255], axis = 'x' } = {}) {
  const { cols, rows } = panel;
  const span = axis === 'y' ? Math.max(1, rows - 1) : Math.max(1, cols - 1);
  const p = panel.pixels;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = (axis === 'y' ? y : x) / span;
      const i = (y * cols + x) * BYTES_PER_PIXEL;
      p[i] = from[0] + (to[0] - from[0]) * t;
      p[i + 1] = from[1] + (to[1] - from[1]) * t;
      p[i + 2] = from[2] + (to[2] - from[2]) * t;
    }
  }
  return panel;
}

/**
 * Number every LED with its PHYSICAL index as a greyscale value, so a photo of
 * the wall tells you the wiring order directly.
 */
export function physicalIndexPattern(panel, layout) {
  const p = panel.pixels;
  const map = layout.map;
  const scale = 255 / Math.max(1, layout.count - 1);
  for (let cell = 0; cell < layout.count; cell++) {
    const v = Math.round(map[cell] * scale);
    const i = cell * BYTES_PER_PIXEL;
    p[i] = v;
    p[i + 1] = v;
    p[i + 2] = v;
  }
  return panel;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

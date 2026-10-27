/**
 * color — the LED fine-tune: white balance, saturation, black level, gamma.
 *
 * All four exist because a diffused LED wall misbehaves in ways the content
 * cannot fix. Neighbouring beads sum and the eye desaturates bright light (the
 * Bezold–Brücke shift), so a pastel at high brightness reads white. The beads'
 * R/G/B dies have different efficiencies, so "white" at 255,255,255 is never
 * actually neutral. And the diffuser scatters ambient light, so near-black
 * content reads as a grey haze instead of black.
 *
 * These are renderer transforms, not protocol ones. The frame stays 1200 raw RGB
 * bytes and the sink stays dumb — the wall cannot tell that anything happened.
 *
 * They are deliberately NOT shown in the preview. They are corrections for the
 * physical wall, tuned by looking at the wall; the design on screen must not
 * move when they do. See web/app.js.
 *
 * No DOM, no browser APIs: this runs under Node for the tests and in the page.
 */

/** Neutral: every lever at rest. Applying these is a no-op. */
export const COLOR_DEFAULTS = Object.freeze({
  saturation: 1,
  gamma: 1,
  temperature: 0,
  tint: 0,
  blackLevel: 0,
});

/** Sensible ranges for the UI sliders. */
export const SATURATION_RANGE = Object.freeze({ min: 0, max: 2, step: 0.05 });
export const GAMMA_RANGE = Object.freeze({ min: 0.5, max: 2.5, step: 0.05 });
export const TEMPERATURE_RANGE = Object.freeze({ min: -1, max: 1, step: 0.05 });
export const TINT_RANGE = Object.freeze({ min: -1, max: 1, step: 0.05 });
export const BLACK_LEVEL_RANGE = Object.freeze({ min: 0, max: 64, step: 1 });
export const TYPICAL_GAMMA = 2;

/**
 * How hard a full-slider white-balance move pulls. 0.5 makes a full turn a
 * 1.5x/0.5x ratio before normalisation — a strong but usable correction, and
 * small slider moves stay subtle.
 */
export const WB_STRENGTH = 0.5;

/**
 * No channel is ever cut below this. Temperature and tint both push on red, so
 * the two extremes together would otherwise zero it — and a white balance that
 * can delete a primary is a bug, not an extreme setting.
 */
export const WB_FLOOR = 0.1;

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* gammaTable allocates 256 bytes, so cache by value: a slider drag would otherwise
 * rebuild it every frame. */
const gammaCache = new Map();

/**
 * 256-entry gamma table. gamma > 1 deepens midtones, which is the standard fix for
 * LED output that looks washed out; gamma = 1 is the identity and is skipped
 * entirely by applyColor.
 * @param {number} gamma
 * @returns {Uint8Array}
 */
export function gammaTable(gamma) {
  const g = gamma > 0 ? gamma : 1;
  const hit = gammaCache.get(g);
  if (hit) return hit;

  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = Math.round(255 * Math.pow(i / 255, g));
  gammaCache.set(g, table);
  return table;
}

/**
 * White balance as the two perceptual axes a camera presents:
 *
 *   temperature  -1 cool (blue)  .. +1 warm (amber)
 *   tint         -1 green        .. +1 magenta
 *
 * Both are relative channel gains around 1.0, so a neutral pair is an exact
 * no-op.
 *
 * The gains are normalised so the LARGEST is 1.0 — a cut-only correction. A
 * channel cannot be driven past full, so the only way to rebalance a white point
 * is to take light away from the strong channels; normalising is what keeps a
 * "boost" from clipping white to a colour (255,255,255 with gains 1.5/1/0.5 is
 * yellow, not white). The wall dims a little as you correct it, which is
 * physically what the correction is. No channel is cut below WB_FLOOR.
 *
 * @param {number} [temperature] -1..1
 * @param {number} [tint] -1..1
 * @param {number} [strength]
 * @returns {[number, number, number]} gains for R, G, B
 */
export function whiteBalanceGains(temperature = 0, tint = 0, strength = WB_STRENGTH) {
  const t = clamp(temperature, -1, 1);
  const m = clamp(tint, -1, 1);

  // Warm and magenta both add red; magenta pulls green down; cool and magenta
  // both add blue.
  let r = 1 + (t + m) * strength;
  let g = 1 - m * strength;
  let b = 1 + (-t + m) * strength;

  const max = Math.max(r, g, b);
  if (max > 1) {
    r /= max;
    g /= max;
    b /= max;
  }
  return [Math.max(WB_FLOOR, r), Math.max(WB_FLOOR, g), Math.max(WB_FLOOR, b)];
}

/**
 * The LED fine-tune over a flat RGB array, in place.
 *
 * Order is deliberate and fixed:
 *   1. white balance — per-channel gain, the wall's own colour cast
 *   2. saturation    — per pixel around its OWN mean, so a pastel is pushed
 *                      back toward its hue rather than toward white. A global
 *                      brightness change moves a colour along the grey axis;
 *                      this moves it away from it.
 *   3. black level   — crush near-black to true black, white stays white
 *   4. gamma         — the final encode
 *
 * @param {Uint8Array} pixels flat RGB triplets, mutated in place
 * @param {{saturation?: number, gamma?: number, temperature?: number,
 *          tint?: number, blackLevel?: number}} [opts]
 * @returns {Uint8Array} the same array
 */
export function applyColor(pixels, opts = {}) {
  const sat = opts.saturation ?? 1;
  const gam = opts.gamma ?? 1;
  const black = clamp(opts.blackLevel ?? 0, 0, 254);

  const [gr, gg, gb] = whiteBalanceGains(opts.temperature ?? 0, opts.tint ?? 0);
  const wb = gr !== 1 || gg !== 1 || gb !== 1;
  const table = gam === 1 ? null : gammaTable(gam);

  // The common case — every lever neutral — must cost nothing.
  if (sat === 1 && table === null && !wb && black === 0) return pixels;

  // Black level rescales so white stays white: subtract the floor, then stretch
  // what is left back over the full range. Without the stretch the whole wall
  // would dim as the floor rose. The multiply comes BEFORE the divide so the top
  // of the range is exact — 255 * (255/235) is 254.9999… and truncates to 254,
  // but (255-20)*255/235 is exactly 255.
  const denom = black > 0 ? 255 - black : 0;

  for (let i = 0; i < pixels.length; i += 3) {
    let r = wb ? pixels[i] * gr : pixels[i];
    let g = wb ? pixels[i + 1] * gg : pixels[i + 1];
    let b = wb ? pixels[i + 2] * gb : pixels[i + 2];

    if (sat !== 1) {
      const mean = (r + g + b) / 3;
      r = mean + (r - mean) * sat;
      g = mean + (g - mean) * sat;
      b = mean + (b - mean) * sat;
    }

    if (black > 0) {
      r = ((r - black) * 255) / denom;
      g = ((g - black) * 255) / denom;
      b = ((b - black) * 255) / denom;
    }

    pixels[i] = table === null ? clamp255(r) : table[clamp255(r)];
    pixels[i + 1] = table === null ? clamp255(g) : table[clamp255(g)];
    pixels[i + 2] = table === null ? clamp255(b) : table[clamp255(b)];
  }
  return pixels;
}

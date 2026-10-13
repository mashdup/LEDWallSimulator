/**
 * color — saturation and gamma, applied host-side to a finished frame.
 *
 * Both exist because a diffused LED wall washes out: neighbouring beads sum, and
 * the eye desaturates bright light (the Bezold–Brücke shift), so a pastel at high
 * brightness reads white. Pure channels survive it; mixtures do not.
 *
 * These are renderer transforms, not protocol ones. The frame stays 1200 raw RGB
 * bytes and the sink stays dumb — the wall cannot tell that anything happened.
 *
 * No DOM, no browser APIs: this runs under Node for the tests and in the page.
 */

/** Neutral: no saturation boost, no gamma. Applying these is a no-op. */
export const COLOR_DEFAULTS = Object.freeze({ saturation: 1, gamma: 1 });

/** Sensible range for a UI slider, and the usual display setting. */
export const SATURATION_RANGE = Object.freeze({ min: 0, max: 2, step: 0.05 });
export const GAMMA_RANGE = Object.freeze({ min: 0.5, max: 2.5, step: 0.05 });
export const TYPICAL_GAMMA = 2;

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

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
 * Saturation and gamma over a flat RGB array, in place.
 *
 * Saturation is applied per pixel around that pixel's OWN mean, so a pastel is
 * pushed back toward its hue rather than toward white — which is the whole point:
 * a global brightness change moves a colour along the grey axis, this moves it
 * away from it.
 *
 * Order matters: saturation in the linear-ish domain first, then gamma as the
 * final encode.
 *
 * @param {Uint8Array} pixels flat RGB triplets, mutated in place
 * @param {{saturation?: number, gamma?: number}} [opts]
 * @returns {Uint8Array} the same array
 */
export function applyColor(pixels, opts = {}) {
  const sat = opts.saturation ?? 1;
  const gam = opts.gamma ?? 1;
  const table = gam === 1 ? null : gammaTable(gam);

  // The common case — both neutral — must cost nothing.
  if (sat === 1 && table === null) return pixels;

  for (let i = 0; i < pixels.length; i += 3) {
    let r = pixels[i];
    let g = pixels[i + 1];
    let b = pixels[i + 2];

    if (sat !== 1) {
      const mean = (r + g + b) / 3;
      r = mean + (r - mean) * sat;
      g = mean + (g - mean) * sat;
      b = mean + (b - mean) * sat;
    }

    pixels[i] = table === null ? clamp255(r) : table[clamp255(r)];
    pixels[i + 1] = table === null ? clamp255(g) : table[clamp255(g)];
    pixels[i + 2] = table === null ? clamp255(b) : table[clamp255(b)];
  }
  return pixels;
}

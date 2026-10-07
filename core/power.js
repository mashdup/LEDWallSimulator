/**
 * power — global brightness multiplier + peak-current estimator.
 *
 * Arithmetic: a WS2812B channel draws up to ~20 mA at full on, so one LED at
 * full white is ~60 mA and 400 LEDs at literal full white is ~24 A. The plan's
 * "≈12 A at full white" figure corresponds to about half that (real banner
 * content never saturates every channel, and 12 A is the number a realistic
 * 5 V supply can actually deliver). Both numbers come out of the same
 * estimator: it is linear in brightness, so the clamp below is what matters,
 * not which headline figure you quote.
 *
 * The estimator is deliberately worst-case (sum of channel energies), not
 * average-frame: a supply sags on the worst frame, not the average one.
 *
 * No DOM, no browser APIs.
 */

import { BYTES_PER_PIXEL } from './panel.js';

export const WS2812_CHANNEL_MA = 20;
export const WS2812_LED_MA = WS2812_CHANNEL_MA * 3;

/**
 * Worst-case current for a flat RGB array.
 * @param {Uint8Array} bytes RGB, any order (order is irrelevant to current)
 * @param {{perChannelMa?: number}} [opts]
 * @returns {number} milliamps
 */
export function estimateCurrentMa(bytes, { perChannelMa = WS2812_CHANNEL_MA } = {}) {
  let ma = 0;
  for (let i = 0; i < bytes.length; i += BYTES_PER_PIXEL) {
    ma += bytes[i] + bytes[i + 1] + bytes[i + 2];
  }
  return (ma * perChannelMa) / 255;
}

/** Current of a panel scaled by k, without allocating. */
export function currentAtBrightness(panel, k, perChannelMa = WS2812_CHANNEL_MA) {
  const p = panel.pixels;
  let ma = 0;
  for (let i = 0; i < p.length; i++) ma += p[i];
  return (ma * k * perChannelMa) / 255;
}

/**
 * PowerBudget — the largest brightness multiplier that keeps the worst frame
 * seen so far under a current limit.
 *
 * It is adaptive: it never promises a limit it has not observed. A frame that
 * blows the budget lowers the ceiling for subsequent frames, which is what you
 * want on a supply that sags.
 */
export class PowerBudget {
  /**
   * @param {number} limitMa hard ceiling in milliamps
   * @param {object} [opts]
   * @param {number} [opts.maxBrightness] ceiling for k (default 1)
   * @param {number} [opts.minBrightness] floor for k, so the wall never goes dark
   * @param {number} [opts.headroom] fraction of limit reserved (0..1)
   * @param {number} [opts.perChannelMa]
   */
  constructor(limitMa = 8000, opts = {}) {
    if (!(limitMa > 0)) throw new RangeError(`limitMa must be > 0, got ${limitMa}`);
    this.limitMa = limitMa;
    this.maxBrightness = opts.maxBrightness ?? 1;
    this.minBrightness = opts.minBrightness ?? 0.05;
    this.headroom = Math.max(0, Math.min(0.9, opts.headroom ?? 0.1));
    this.perChannelMa = opts.perChannelMa ?? WS2812_CHANNEL_MA;
    /** Current ceiling, lowered when an observed frame would have exceeded the limit. */
    this.k = this.maxBrightness;
    this.lastMa = 0;
    this.peakMa = 0;
    this.clampedFrames = 0;
  }

  get effectiveLimitMa() {
    return this.limitMa * (1 - this.headroom);
  }

  /**
   * Brightness multiplier to apply to the next frame.
   * @param {Panel} panel
   * @param {number} [requested] the renderer's own artistic multiplier
   */
  brightnessFor(panel, requested = 1) {
    const want = Math.max(0, Math.min(this.maxBrightness, requested));
    const atFull = currentAtBrightness(panel, 1, this.perChannelMa);
    const limit = this.effectiveLimitMa;

    let k = want;
    if (atFull > limit) k = Math.min(k, limit / atFull);
    k = Math.max(this.minBrightness, k);

    this.lastMa = atFull * k;
    if (this.lastMa > this.peakMa) this.peakMa = this.lastMa;
    if (k < want) this.clampedFrames++;

    return k;
  }

  /** Observe a finished frame and adapt the ceiling for the ones after it. */
  observe(physicalBytes) {
    const ma = estimateCurrentMa(physicalBytes, { perChannelMa: this.perChannelMa });
    this.lastMa = ma;
    if (ma > this.peakMa) this.peakMa = ma;
    const limit = this.effectiveLimitMa;
    if (ma > limit) {
      this.k = Math.max(this.minBrightness, this.k * (limit / ma));
      this.clampedFrames++;
    }
    return ma;
  }

  /** Reset the adaptive ceiling (e.g. after a scene change or on a new meta frame). */
  reset(k = this.maxBrightness) {
    this.k = Math.max(this.minBrightness, Math.min(this.maxBrightness, k));
    this.peakMa = 0;
    this.clampedFrames = 0;
  }

  /** The meta-frame payload describing this budget to the wall. */
  toMeta() {
    return { brightness: Math.round(this.k * 255), limitMa: Math.round(this.limitMa) };
  }
}

/**
 * PeakMeter — worst case over a rolling window, for reporting rather than
 * clamping. Frame-to-frame current on a banner swings a lot; a peak over ~1 s
 * is the number that decides whether a supply is adequate.
 */
export class PeakMeter {
  /** @param {number} [windowFrames] */
  constructor(windowFrames = 30) {
    if (!Number.isInteger(windowFrames) || windowFrames < 1) {
      throw new RangeError(`windowFrames must be a positive integer, got ${windowFrames}`);
    }
    this.window = windowFrames;
    this.samples = new Float64Array(windowFrames);
    this.i = 0;
    this.filled = 0;
    this.peak = 0;
  }

  /** @param {Uint8Array} physicalBytes */
  push(physicalBytes, perChannelMa = WS2812_CHANNEL_MA) {
    const ma = estimateCurrentMa(physicalBytes, { perChannelMa });
    this.samples[this.i] = ma;
    this.i = (this.i + 1) % this.window;
    if (this.filled < this.window) this.filled++;
    if (ma > this.peak) this.peak = ma;
    return ma;
  }

  get windowPeak() {
    let m = 0;
    for (let i = 0; i < this.filled; i++) if (this.samples[i] > m) m = this.samples[i];
    return m;
  }

  get windowMean() {
    if (this.filled === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.samples[i];
    return s / this.filled;
  }

  reset() {
    this.samples.fill(0);
    this.i = 0;
    this.filled = 0;
    this.peak = 0;
  }
}

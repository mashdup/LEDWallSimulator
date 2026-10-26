/**
 * power — global brightness multiplier + peak-current estimator.
 *
 * Arithmetic: these are APA106/PL9823-class beads, but the class nominal is the
 * same one WS2812 parts use — a channel draws up to ~20 mA at full on, so one
 * LED at full white is ~60 mA and 400 LEDs at literal full white is ~24 A. The
 * plan's "≈12 A at full white" figure corresponds to about half that (real banner
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
    /** The k the last frame was actually rendered at; see brightnessFor. */
    this.appliedK = this.k;
    /** Worst frame at full brightness over the recent past; see brightnessFor. */
    this.worstFullMa = 0;
    this.lastMa = 0;
    this.peakMa = 0;
    this.clampedFrames = 0;
  }

  get effectiveLimitMa() {
    return this.limitMa * (1 - this.headroom);
  }

  /**
   * Brightness multiplier to apply to the next frame.
   *
   * The ceiling is clamped against the WORST frame of the recent past, not the
   * frame in hand. Clamping against this frame's own ink makes the wall's
   * brightness a function of the picture: a scrolling banner draws more ink from
   * one frame to the next, so k swings several times a second. Every byte and
   * every counter stays correct while the whole panel visibly flickers, which is
   * the failure this class exists to prevent.
   *
   * @param {Panel} panel
   * @param {number} [requested] the renderer's own artistic multiplier
   */
  brightnessFor(panel, requested = 1) {
    const want = Math.max(0, Math.min(this.maxBrightness, requested));
    const atFull = currentAtBrightness(panel, 1, this.perChannelMa);

    /* Hold the worst frame of the recent past. Monotonic on purpose: any release
     * fast enough to matter is also fast enough to make k follow the picture
     * again, and this frame's own ink is in the max below anyway, so the limit
     * is still never exceeded even once. reset() starts it over on a scene
     * change, which is the only thing that should ever brighten the wall back. */
    this.worstFullMa = Math.max(this.worstFullMa, atFull);

    const limit = this.effectiveLimitMa;
    /* this.k is the adaptive ceiling: ONE state, shared with observe() and
     * toMeta(). The ratchet covers the POWER CEILING only — the requested
     * brightness is NOT folded into it. Folding it in latched the slider into
     * the one-way ratchet: dragging the wall down worked once, and dragging
     * the slider back up could never brighten anything, because
     * min(want, this.k) remembered the old low. The ratchet exists so the
     * PICTURE cannot swing the wall's brightness; an operator moving a
     * slider is the opposite of a picture, and must be bidirectional. */
    let cap = this.k;
    if (this.worstFullMa > limit) cap = Math.min(cap, limit / this.worstFullMa);
    cap = Math.max(this.minBrightness, cap);
    this.k = cap;

    /* The requested brightness rides ON TOP of the ceiling: the slider can
     * lower the wall, the ceiling can lower it further, and raising the
     * slider recovers to min(ceiling) immediately — no reset needed. The
     * applied k is the number the page scales by, the meta declares, and
     * the estimator sees; this.k alone is only the ceiling. */
    const k = Math.max(this.minBrightness, Math.min(want, cap));
    this.appliedK = k;

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
    /* Compare against the FULL limit, not effectiveLimitMa. brightnessFor has
     * already aimed the frame at effectiveLimitMa, so at the clamp point the
     * rendered estimate sits exactly on that margin, and integer rounding in
     * the scale path puts it a hair over. Firing the decay there made every
     * clamped frame multiply this.k by ~0.9996 forever: a full-white panel
     * spiralled to the minBrightness floor (k=0.05, meta br=13) and the wall
     * went permanently dull with no way back. The headroom belongs to
     * brightnessFor; observe() is the last line, and it fires only when the
     * real current crosses the real limit. */
    if (ma > this.limitMa) {
      this.k = Math.max(this.minBrightness, this.k * (this.limitMa / ma));
      this.clampedFrames++;
    }
    return ma;
  }

  /** Reset the adaptive ceiling (e.g. after a scene change or on a new meta frame). */
  reset(k = this.maxBrightness) {
    this.k = Math.max(this.minBrightness, Math.min(this.maxBrightness, k));
    this.appliedK = this.k;
    /* A scene change starts the peak-hold over: holding a stale peak would leave
     * the new scene dim for as long as the release takes. */
    this.worstFullMa = 0;
    this.peakMa = 0;
    this.clampedFrames = 0;
  }

  /** The meta-frame payload describing this budget to the wall. Declares the
   * brightness the frames are ACTUALLY rendered at (appliedK: ceiling ∧
   * requested), not the bare ceiling — the wall must be lit with the number
   * it is told. min() with this.k keeps the invariant that meta never
   * declares brighter than the current ceiling, even when observe() lowered
   * that ceiling between two brightnessFor() calls. */
  toMeta() {
    const k = Math.min(this.appliedK, this.k);
    return { brightness: Math.round(k * 255), limitMa: Math.round(this.limitMa) };
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

/**
 * calibration — the four wiring patterns, defined once, in pure JS.
 *
 * Why this file exists: firmware/firmware.ino has a self-test that drives the
 * same four patterns straight from physical LED indices (it has no layout map —
 * core/layout.js owns that), and milestone 5 is comparing what the wall actually
 * shows against what core/layout.js predicts. That comparison is only worth
 * doing if both sides are running the *same* pattern, so the pattern definitions
 * live here and the firmware is checked against them by test/calibration.test.js
 * rather than kept in parallel by memory.
 *
 * A pattern is written into a Panel in LOGICAL space: cell (x,y) gets the colour
 * that its physical index deserves, according to `layout`. Pack that panel with
 * `identity()` and the resulting 1200 bytes are byte-for-byte what the firmware
 * puts on the wall for the same pattern. That equality is the contract, and it
 * is asserted in the tests.
 *
 *   all-red        every LED full red        -> no dead pixels, no brownouts
 *   column-sweep   LEDs where index%20==c    -> a column under the identity
 *                                               layout; reveals snake direction
 *                                               and strip boundaries
 *   walk           one white LED, 0..399     -> reads the physical order off the
 *                                               wall directly
 *   index-map      R = 20+12*(i/20),          -> every LED is identifiable;
 *                  G = 20+12*(i%20), B = 30      compare against core/layout.js
 *
 * `walk` and `column-sweep` are animated: `step` is the step index, exactly the
 * firmware's `stepIndex`. `all-red` and `index-map` are static.
 *
 * No DOM, no fetch, no browser APIs.
 */

import { BYTES_PER_PIXEL } from './panel.js';
import { LED_COUNT } from './frame.js';

/** Pattern names, in the order the firmware's self-test cycles through them. */
export const CALIBRATION_PATTERNS = Object.freeze(['all-red', 'column-sweep', 'walk', 'index-map']);

/**
 * Timing, mirroring firmware/firmware.ino's -D defaults. These are the numbers
 * a human watches the wall with, so they are part of the shared contract: the
 * Node bridge and the flashed firmware have to pace the same way or the two
 * views of the panel are not comparable.
 */
export const CALIBRATION_TIMING = Object.freeze({
  /** How long each pattern runs before the cycle advances to the next. */
  redMs: 4000,
  columnMs: 4000,
  walkMs: 6400,
  indexMs: 6000,
  /** Pace of the animated patterns. */
  columnStepMs: 200,
  walkStepMs: 16,
});

/**
 * Watchdog / decoder timing, also shared with the firmware (and with
 * tools/bridge.js's virtual sink, which is a port of the firmware's loop()).
 */
export const WALL_TIMING = Object.freeze({
  /** No complete frame for this long => fade to black rather than freeze. */
  staleMs: 1500,
  /** Fade-to-black ramp length and granularity. */
  fadeMs: 400,
  fadeSteps: 24,
  /** A gap this long mid-frame means the tail is gone: discard the partial. */
  partialGapMs: 40,
  /** How often the device reports a status line. */
  statusIntervalMs: 1000,
  /** Power limit assumed until the host sends a meta frame. */
  defaultLimitMa: 8000,
  /**
   * A held frame is re-sent this often. Not a device limit: the stale watchdog
   * cannot tell an unchanged wall from a dead host, so a driver that sent only on
   * change would let a still wall fade to black. A third of staleMs leaves 3x
   * margin, and costs ~2.4 KB/s at 921600, which the wire does not notice.
   */
  staticRefreshMs: 500,
});

/**
 * index-map colour legend. The firmware prints this when it enters the pattern;
 * the sim shows it next to the canvas. test/calibration.test.js pins the
 * firmware's copy of the string to this one.
 */
export const INDEX_MAP_LEGEND = 'R = 20 + 12*(index/20), G = 20 + 12*(index%20), B = 30';

/**
 * index-map groups 400 LEDs into 20 groups of 20, i.e. the rows and columns of
 * the IDENTITY layout: group = index/20, position = index%20. Hard-coding 20 is
 * deliberate — the frame payload is frozen at 1200 bytes, so the panel this
 * pattern can describe is always 400 LEDs, and the firmware hard-codes the same
 * 20. A different grid would make the two encodings disagree.
 */
export const INDEX_MAP_GROUP = 20;
const INDEX_MAP_BASE = 20;
const INDEX_MAP_STEP = 12;
const INDEX_MAP_BLUE = 30;

/** Column-sweep lit colour, matching the firmware's green + faint blue tint. */
const COLUMN_ON = [0, 255, 40];
const COLUMN_OFF = [0, 0, 0];

/**
 * Colour for one PHYSICAL LED index. Exported because the cross-language test
 * asserts the firmware's bytes against this function directly, without going
 * through a layout at all.
 *
 * @param {string} name one of CALIBRATION_PATTERNS
 * @param {number} physical physical LED index, 0..count-1
 * @param {number} [step] animation step index (firmware's stepIndex)
 * @param {number} [count] LED count
 * @returns {number[]} [r,g,b]
 */
export function patternColor(name, physical, step = 0, count = LED_COUNT) {
  if (!Number.isInteger(physical) || physical < 0 || physical >= count) {
    throw new RangeError(`patternColor: index ${physical} out of range for ${count} LEDs`);
  }
  if (!Number.isInteger(step) || step < 0) {
    throw new RangeError(`patternColor: step must be a non-negative integer, got ${step}`);
  }
  if (count !== LED_COUNT) {
    throw new RangeError(
      `calibration patterns are defined for ${LED_COUNT} LEDs (the frame payload is frozen at ${LED_COUNT * 3} bytes), got ${count}`,
    );
  }

  switch (name) {
    case 'all-red':
      return [255, 0, 0];

    case 'column-sweep': {
      const on = physical % INDEX_MAP_GROUP === step % INDEX_MAP_GROUP;
      return on ? COLUMN_ON : COLUMN_OFF;
    }

    case 'walk':
      return physical === step % count ? [255, 255, 255] : [0, 0, 0];

    case 'index-map':
      return [
        INDEX_MAP_BASE + INDEX_MAP_STEP * Math.floor(physical / INDEX_MAP_GROUP),
        INDEX_MAP_BASE + INDEX_MAP_STEP * (physical % INDEX_MAP_GROUP),
        INDEX_MAP_BLUE,
      ];

    default:
      throw new RangeError(
        `unknown calibration pattern "${name}"; expected one of ${CALIBRATION_PATTERNS.join(', ')}`,
      );
  }
}

/**
 * How long a pattern runs before the cycle advances, and how often it steps.
 * @param {string} name
 * @returns {{durationMs: number, stepMs: number}}
 */
export function patternPace(name) {
  switch (name) {
    case 'all-red':
      return { durationMs: CALIBRATION_TIMING.redMs, stepMs: 0 };
    case 'column-sweep':
      return { durationMs: CALIBRATION_TIMING.columnMs, stepMs: CALIBRATION_TIMING.columnStepMs };
    case 'walk':
      return { durationMs: CALIBRATION_TIMING.walkMs, stepMs: CALIBRATION_TIMING.walkStepMs };
    case 'index-map':
      return { durationMs: CALIBRATION_TIMING.indexMs, stepMs: 0 };
    default:
      throw new RangeError(
        `unknown calibration pattern "${name}"; expected one of ${CALIBRATION_PATTERNS.join(', ')}`,
      );
  }
}

/**
 * Paint a calibration pattern onto a Panel in logical space.
 *
 * The colour a cell gets is decided by the physical index `layout` says that
 * cell is — which is exactly what the wall will show. Pack the result with
 * `identity()` and you get the firmware's bytes.
 *
 * @param {string} name one of CALIBRATION_PATTERNS
 * @param {import('./panel.js').Panel} panel
 * @param {import('./layout.js').Layout} layout
 * @param {number} [step] animation step index
 * @returns {Panel} panel, painted in place
 */
export function calibrationPattern(name, panel, layout, step = 0) {
  if (panel.count !== layout.count) {
    throw new RangeError(`panel (${panel.count} cells) and layout (${layout.count} cells) disagree`);
  }
  const p = panel.pixels;
  const map = layout.map;
  const count = layout.count;
  for (let cell = 0; cell < count; cell++) {
    const [r, g, b] = patternColor(name, map[cell], step, count);
    const i = cell * BYTES_PER_PIXEL;
    p[i] = r;
    p[i + 1] = g;
    p[i + 2] = b;
  }
  return panel;
}

/**
 * The same pattern as the flat 1200 bytes the firmware would write: physical
 * index i at bytes 3i..3i+2. No Panel, no layout — this is the raw contract the
 * cross-language test compares against firmware/firmware.ino.
 */
export function calibrationPhysicalBytes(name, step = 0, count = LED_COUNT) {
  const out = new Uint8Array(count * BYTES_PER_PIXEL);
  for (let led = 0; led < count; led++) {
    const [r, g, b] = patternColor(name, led, step, count);
    const i = led * BYTES_PER_PIXEL;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return out;
}

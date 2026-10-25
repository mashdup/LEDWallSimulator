/**
 * bridge.js — drive the wall from Node.
 *
 * plan.md puts the brain in the browser, and for a banner that is right. But
 * milestone 5 is "sit in front of a real panel and work out which of the eight
 * mountings the wiring actually is", and that job wants two things this repo did
 * not have:
 *
 *   - the SAME patterns the flashed firmware's self-test shows, so the two views
 *     of the panel are comparable, and
 *   - the ability to change core/layout.js and re-run without reflashing, which
 *     costs ~20 s per iteration with arduino-cli and ~0 s from Node.
 *
 * So this is a host-side driver with two transports and one device model:
 *
 *   VirtualWall      a port of firmware/firmware.ino's loop(): the same decoder,
 *                    the same rescan, the same watchdog, the same power guard,
 *                    the same status line. The device exists in JS, so all of it
 *                    is testable with no hardware in the room.
 *   SerialTransport  the real thing: `serialport`, the same in-flight bound as
 *                    web/sinks.js's SerialSink, and a reader that turns the
 *                    firmware's status lines back into objects.
 *
 * Sources produce frames; transports carry them; WallDriver paces them and owns
 * the meta frame. Sources yield ALREADY-PHYSICAL 1200-byte payloads:
 *
 *   patternSource  calibration patterns are physical by definition (the firmware
 *                  has no layout map), so they bypass the layout entirely.
 *   pageSource     a live web page -> core/panner.js -> Panel -> pack(layout).
 *
 * That split is deliberate. A calibration pattern packed through your layout and
 * then judged through your layout cancels out and tells you nothing; raw physical
 * bytes are what the wall actually receives, which is the whole point of the
 * exercise. `--preview` is the other half: it prints what YOUR layout would light
 * up, so the two views can be compared side by side.
 *
 * Usage:
 *   node tools/bridge.js --help
 *   node tools/bridge.js --verify                    # no hardware needed
 *   node tools/bridge.js --pattern walk --preview
 *   node tools/bridge.js --cycle --layout flipX,flipY
 *   node tools/bridge.js --page http://127.0.0.1:8080/anim-400.html --serve
 *   node tools/bridge.js --pattern index-map --port COM5
 *   node tools/bridge.js --status --port COM5
 *
 * `--port` selects the real device; without it the virtual wall is used, so the
 * same command line is a dry run or a live run.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Panel,
  Layout,
  identity,
  pack,
  frame,
  meta,
  nextSeq,
  encodeFrameInto,
  LED_COUNT,
  RGB_BYTES,
  FRAME_BYTES,
  CALIBRATION_PATTERNS,
  CALIBRATION_TIMING,
  WALL_TIMING,
  INDEX_MAP_LEGEND,
  patternPace,
  calibrationPhysicalBytes,
  Panner,
  DOWN,
  bitmap,
} from '../core/index.js';
import { FRAME_MAGIC, META_MAGIC, OFFSET_RGB, sameBytes } from '../core/frame.js';
import { DEFAULT_BAUD, MAX_IN_FLIGHT, WIRE_MS_PER_FRAME } from '../web/sinks.js';
import { decodePng, rgbaOf } from './png.js';
import { freePort, isFetchablePort } from './ports.js';

const SERVE_SCRIPT = fileURLToPath(new URL('./serve.js', import.meta.url));

/** Rescans per drain. Matches firmware MAX_REWINDS and core/frame.js's maxRewinds. */
export const MAX_REWINDS = 8;

/** Mirrors firmware's `enum RxState`, because the status line reports it as a number. */
export const RX = Object.freeze({ IDLE: 0, SEQ: 1, RGB: 2, END: 3, META: 4 });

/** Mirrors firmware's `enum WallState`. */
export const WALL = Object.freeze({ DARK: 0, LIVE: 1, FADING: 2 });

/** Self-test pattern names exactly as the firmware prints them, indexed like CALIBRATION_PATTERNS. */
export const SELFTEST_NAMES = Object.freeze(['ALL_RED', 'COLUMN_SWEEP', 'WALK', 'INDEX_MAP']);

/** The sketch's -D PIN_DATA default; only used to label the virtual device. */
export const PIN_DATA = 27;

/**
 * How long `--status` reads a real port when `--duration` is not given. The
 * firmware prints at STATUS_INTERVAL_MS = 1000, so 5 s lands ~5 status lines —
 * enough to see a counter move, short enough that a forgotten invocation ends.
 */
export const STATUS_DEFAULT_MS = 5000;

// ---------------------------------------------------------------------------
// Power guard — the firmware's arithmetic, in JS, so both sides can be pinned
// ---------------------------------------------------------------------------

/**
 * B_max(limit) = floor(limit * 255 / (NUM_LED * 3 * CHANNEL_MA)), capped at 255.
 * Identical to firmware's maxBrightnessForLimit(), including the integer division.
 */
export function maxBrightnessForLimit(limitMa, { channelMa = 20, ledCount = LED_COUNT } = {}) {
  const denom = ledCount * 3 * channelMa; // 24000
  const b = Math.floor((limitMa * 255) / denom);
  return b > 255 ? 255 : b;
}

/** Full-white current at a brightness — the firmware's fullWhiteMa(). */
export function fullWhiteMa(brightness, { channelMa = 20, ledCount = LED_COUNT } = {}) {
  return Math.floor((ledCount * 3 * channelMa * brightness) / 255);
}

/**
 * Current of what is ACTUALLY on the wall: the frame's channel sum scaled by
 * CHANNEL_MA/255 and by the brightness actually applied. Same formula as the
 * firmware's estimateFrameMa(), so a status line read off a real board is
 * directly comparable with one produced here.
 */
export function estimateFrameMa(rgb, brightness, { channelMa = 20 } = {}) {
  let sum = 0;
  for (let i = 0; i < rgb.length; i++) sum += rgb[i];
  const b = brightness >= 255 ? 255 : brightness;
  return Math.floor((channelMa * sum * b) / (255 * 255));
}


/**
 * Adafruit_NeoPixel's brightness semantics: b < 255 scales a channel as
 * (c * b) >> 8, and 255 means "no scaling at all" (multiplier 256).
 */
export function scaleChannel(value, brightness) {
  if (brightness >= 255) return value;
  return (value * brightness) >> 8;
}
// ---------------------------------------------------------------------------
// VirtualWall — a faithful port of firmware/firmware.ino's loop()
// ---------------------------------------------------------------------------

/**
 * The device, in JS.
 *
 * Every constant comes from core/calibration.js's WALL_TIMING / CALIBRATION_TIMING,
 * which test/calibration.test.js pins against the firmware's -D defaults, so this
 * port cannot drift from the sketch without a test failing. The port itself is
 * branch-for-branch: byte-at-a-time decoder, one-level budgeted rescan,
 * truncated-frame abort, time-derived fade steps, brightness folded into the
 * render rather than left to setBrightness().
 *
 * `strip` is what the LEDs are actually showing, in wire order (R,G,B at 3*led).
 * It is the honest output: lastFrame is what was RECEIVED and strip is what was
 * DRAWN, and the difference between them is exactly what the power guard and the
 * watchdog fade do. A discarded frame's bytes stay in rxBuf and never reach strip,
 * which is the property the whole decoder exists to guarantee.
 */
export class VirtualWall {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.selftest] start in the wiring self-test, like a -DSELFTEST=1 build
   * @param {number} [opts.limitMa] power limit before the host sends a meta frame
   * @param {(line: string) => void} [opts.onLog] receives everything the board would print
   * @param {object} [opts.timing] overrides for WALL_TIMING (tests use a short staleMs)
   */
  constructor(opts = {}) {
    this.timing = { maxRewinds: MAX_REWINDS, ...WALL_TIMING, ...opts.timing };
    this.onLog = opts.onLog ?? (() => {});

    /** Power guard state, named as in the sketch. */
    this.limitMa = opts.limitMa ?? this.timing.defaultLimitMa;
    this.wantBrightness = 255;
    this.activeBrightness = 0;

    /** Storage, mirroring the sketch's statics: nothing is allocated per frame. */
    this.rxBuf = new Uint8Array(RGB_BYTES);
    this.metaBuf = new Uint8Array(4); // brightness, limitLo, limitHi, end
    this.lastFrame = new Uint8Array(RGB_BYTES);
    this.strip = new Uint8Array(RGB_BYTES);

    this.rx = { state: RX.IDLE, n: 0, seq: 0, metaN: 0 };
    this.stats = { frames: 0, meta: 0, discarded: 0, resyncs: 0, rewinds: 0, seqGaps: 0, stale: 0 };

    /** millis(). Advanced only by step(), so time is something a test controls. */
    this.clock = 0;
    this.lastCompleteMs = 0;
    this.lastByteMs = 0;
    this.statusMs = 0;

    this.wall = WALL.DARK;
    this.fadeStartMs = 0;
    this.fadeStep = 0;
    this.lastSeq = 0;
    this.haveLastSeq = false;

    this.rescanning = false;
    this.rewindBudget = this.timing.maxRewinds;

    /** The UART ring buffer: written by the host, consumed one drain per step(). */
    this.rxQueue = [];

    this.self = { active: opts.selftest ?? false, pattern: 0, startMs: 0, stepNextMs: 0, stepIndex: 0 };

    // setup(): clear, apply the guard, show once, then announce.
    this.strip.fill(0);
    this.lastCompleteMs = this.clock;
    this.lastByteMs = this.clock;
    this.statusMs = this.clock;
    this.#applyBrightnessGuard();

    if (this.self.active) {
      this.#beginPattern(0);
      this.onLog('selftest active: a complete frame from the host takes over immediately');
    }
    this.onLog(this.#readyLine());
  }

  // -- host-facing API ------------------------------------------------------

  /** Write bytes to the device, as a host writing to the port. */
  push(bytes) {
    for (let i = 0; i < bytes.length; i++) this.rxQueue.push(bytes[i]);
    return this;
  }

  /**
   * One loop() iteration: drain what is available, abort a truncated frame,
   * service the watchdog, run the self-test if it owns the wall, print a status
   * line if one is due.
   *
   * @param {number} ms elapsed millis since the previous step
   * @returns {string|null} the status line, if this iteration printed one
   */
  step(ms = 0) {
    this.clock += ms;

    // loop() reads Serial.available() ONCE and then reads exactly that many
    // bytes. Bytes written after this point wait for the next iteration, which is
    // what makes the truncated-frame rule observable at all.
    this.rewindBudget = this.timing.maxRewinds;
    let pending = this.rxQueue.length;
    while (pending-- > 0) this.#feedByte(this.rxQueue.shift());

    this.#abortTruncatedFrame();
    this.#serviceWall();
    if (this.self.active) this.#selftestRun();

    if (this.clock - this.statusMs >= this.timing.statusIntervalMs) {
      this.statusMs = this.clock;
      const line = this.statusLine();
      this.onLog(line);
      return line;
    }
    return null;
  }

  /**
   * Run the device for `ms` of its own time.
   * @param {number} ms
   * @param {{tickMs?: number, until?: (w: VirtualWall) => boolean}} [opts]
   */
  run(ms, opts = {}) {
    const tick = opts.tickMs ?? 8;
    let left = ms;
    while (left > 0) {
      const slice = Math.min(tick, left);
      this.step(slice);
      left -= slice;
      if (opts.until?.(this)) break;
    }
    return this;
  }

  /** The status line exactly as the board prints it. */
  statusLine() {
    const state = this.wall === WALL.LIVE ? 'live' : this.wall === WALL.FADING ? 'fading' : 'dark';
    return [
      'wall',
      `seq=${this.lastSeq}`,
      `br=${this.activeBrightness}/${maxBrightnessForLimit(this.limitMa)}`,
      `est=${estimateFrameMa(this.lastFrame, this.activeBrightness)}mA`,
      `cap=${fullWhiteMa(this.activeBrightness)}mA`,
      `limit=${this.limitMa}mA`,
      `state=${state}`,
      `rx=${this.rx.state}`,
      `frames=${this.stats.frames}`,
      `meta=${this.stats.meta}`,
      `disc=${this.stats.discarded}`,
      `resync=${this.stats.resyncs}`,
      `rewind=${this.stats.rewinds}`,
      `gaps=${this.stats.seqGaps}`,
      `stale=${this.stats.stale}`,
    ].join(' ');
  }

  #readyLine() {
    return (
      `sink ready pin=${PIN_DATA} leds=${LED_COUNT} baud=${DEFAULT_BAUD} frame=${FRAME_BYTES}B `
      + `limit=${this.limitMa}mA br=${this.activeBrightness}`
    );
  }

  /** What LED `led` is actually showing: [r,g,b] out of the strip buffer. */
  wallPixel(led) {
    const i = led * 3;
    return [this.strip[i], this.strip[i + 1], this.strip[i + 2]];
  }

  /** True when every LED equals `expected` (physical order) after the guard scales it. */
  shows(expected, { brightness = this.activeBrightness } = {}) {
    for (let i = 0; i < RGB_BYTES; i++) {
      if (this.strip[i] !== scaleChannel(expected[i], brightness)) return false;
    }
    return true;
  }

  /** Fraction of LEDs lit at all — the number that says "the wall is not dark". */
  litFraction() {
    let lit = 0;
    for (let led = 0; led < LED_COUNT; led++) {
      const i = led * 3;
      if (this.strip[i] || this.strip[i + 1] || this.strip[i + 2]) lit++;
    }
    return lit / LED_COUNT;
  }

  // -- power guard ----------------------------------------------------------

  #applyBrightnessGuard() {
    const cap = maxBrightnessForLimit(this.limitMa);
    this.activeBrightness = this.wantBrightness <= cap ? this.wantBrightness : cap;
  }

  /** 256 is identity; b < 255 is Adafruit's (c * b) >> 8 multiplier. */
  brightnessScale() {
    return this.activeBrightness >= 255 ? 256 : this.activeBrightness;
  }

  // -- decoder --------------------------------------------------------------

  #feedByte(b) {
    this.lastByteMs = this.clock;
    const rx = this.rx;

    switch (rx.state) {
      case RX.IDLE:
        if (b === 0xa5) {
          rx.state = RX.SEQ;
          rx.n = 0;
        } else if (b === 0xa4) {
          rx.state = RX.META;
          rx.metaN = 0;
        } else {
          rx.n = 0; // garbage before magic: skip it, keep scanning
          this.stats.resyncs++;
        }
        break;

      case RX.SEQ:
        rx.seq = b;
        rx.n = 0;
        rx.state = RX.RGB;
        break;

      case RX.RGB:
        rx.n += 1;
        this.rxBuf[rx.n - 1] = b;
        if (rx.n === RGB_BYTES) rx.state = RX.END; // exact length: a 1201st byte is never accepted
        break;

      case RX.END: {
        // Reset first: the rescan below feeds bytes through this same machine.
        rx.state = RX.IDLE;
        rx.n = 0;
        if (b === 0x5a) {
          this.#commitFrame();
        } else {
          // End byte wrong => the whole frame is suspect. The pixels already
          // collected stay in rxBuf and are never shown.
          this.stats.discarded++;
          this.#rescanRecord(this.rxBuf, RGB_BYTES, 0, b);
        }
        break;
      }

      case RX.META: {
        this.metaBuf[rx.metaN] = b;
        rx.metaN += 1;
        if (rx.metaN === 4) {
          const good = this.metaBuf[3] === 0x5a;
          rx.state = RX.IDLE;
          rx.metaN = 0;
          if (good) {
            this.#applyMeta(this.metaBuf[0], this.metaBuf[1] | (this.metaBuf[2] << 8));
          } else {
            this.stats.discarded++;
            // Same salvage as a frame: skip brightness, scan limitLo/limitHi/end.
            this.#rescanRecord(this.metaBuf, 4, 1, null);
          }
        }
        break;
      }

      default:
        rx.state = RX.IDLE;
        rx.n = 0;
        rx.metaN = 0;
        break;
    }
  }

  /**
   * A record just failed its end-byte check. Throw it away, then look inside it
   * for a magic byte and replay from there.
   *
   * Why: a dropped byte makes the reader one byte short, so it swallows the next
   * frame's 0xA5 as payload and the record ends on that frame's seq byte instead
   * of 0x5A. The magic we need is sitting in the buffer we just rejected.
   *
   * Scan window matches core/frame.js exactly: the payload and the byte that
   * failed the end check, never the magic or the seq.
   *
   * `extra` is the byte that failed the end check when it lives outside `region`
   * (the frame case), or null when the region already contains it (the meta case).
   */
  #rescanRecord(region, len, scanFrom, extra) {
    if (this.rescanning || this.rewindBudget === 0) return; // one level, budgeted per drain

    let k = scanFrom;
    while (k < len && region[k] !== 0xa5 && region[k] !== 0xa4) k++;

    const extraIsMagic = extra === 0xa5 || extra === 0xa4;
    if (k >= len && !extraIsMagic) return; // nothing to salvage: plain forward resync

    this.rewindBudget -= 1;
    this.stats.rewinds++;
    this.stats.resyncs++;

    this.rescanning = true;
    for (let i = k; i < len; i++) this.#feedByte(region[i]);
    if (extra !== null) this.#feedByte(extra);
    this.rescanning = false;
  }

  /**
   * Truncated frame: the tail never arrives. Discard the partial and go back to
   * scanning for a magic byte. No rescan here — this record holds only the
   * truncated frame's own bytes, so any 0xA5 inside it is payload, and replaying
   * it would invent a frame that was never sent.
   */
  #abortTruncatedFrame() {
    if (this.rx.state === RX.IDLE) return;
    if (this.clock - this.lastByteMs >= this.timing.partialGapMs) {
      this.stats.discarded++;
      this.rx.state = RX.IDLE;
      this.rx.n = 0;
      this.rx.metaN = 0;
    }
  }

  #commitFrame() {
    this.lastFrame.set(this.rxBuf);
    this.lastCompleteMs = this.clock;
    this.stats.frames++;

    // seq is a uint8 that wraps 255 -> 0. It is not a validity check — a lost
    // frame is simply replaced by the next complete one — but a delta other than
    // +1 says the host dropped a frame upstream. The mask makes the wrap read as
    // +1, so a wrap is never a false gap.
    if (this.haveLastSeq && ((this.rx.seq - this.lastSeq) & 0xff) !== 1) this.stats.seqGaps++;
    this.lastSeq = this.rx.seq;
    this.haveLastSeq = true;
    this.wall = WALL.LIVE;
    this.#renderWall(256);

    if (this.self.active) {
      // A real frame from the host takes over the wall immediately.
      this.self.active = false;
      this.onLog('selftest: stopped by host frame');
    }
  }

  #applyMeta(brightness, limitMa) {
    this.stats.meta++;
    this.wantBrightness = brightness;
    this.limitMa = limitMa;
    this.#applyBrightnessGuard();
    // The new clamp has to reach the wall now, not at the next frame.
    if (this.wall === WALL.LIVE) this.#renderWall(256);
  }

  // -- rendering ------------------------------------------------------------

  /**
   * Copy lastFrame into the strip buffer.
   *
   * fadeScale == 256 is "no watchdog fade"; lower values are the ramp. The
   * declared brightness is folded in here rather than left to a setBrightness()
   * call, because this is the only place pixels reach the strip — the same rule
   * the firmware follows, and the reason the power guard is real.
   */
  #renderWall(fadeScale) {
    const scale = (fadeScale * this.brightnessScale()) >> 8;
    if (scale >= 256) {
      this.strip.set(this.lastFrame);
      return;
    }
    for (let i = 0; i < RGB_BYTES; i++) this.strip[i] = (this.lastFrame[i] * scale) >> 8;
  }

  // -- watchdog -------------------------------------------------------------

  #serviceWall() {
    const now = this.clock;

    if (this.wall === WALL.LIVE) {
      if (now - this.lastCompleteMs >= this.timing.staleMs) {
        this.wall = WALL.FADING;
        this.fadeStartMs = now;
        this.fadeStep = 0;
        this.stats.stale++;
      }
      return;
    }

    if (this.wall === WALL.FADING) {
      // Step index comes straight from elapsed time, so the ramp always finishes
      // in fadeMs no matter how fast the loop happens to spin.
      const step = Math.floor((now - this.fadeStartMs) * this.timing.fadeSteps / this.timing.fadeMs);
      if (step <= this.fadeStep) return;
      this.fadeStep = step;
      if (this.fadeStep >= this.timing.fadeSteps) {
        this.strip.fill(0);
        this.wall = WALL.DARK;
      } else {
        this.#renderWall(((256 * (this.timing.fadeSteps - this.fadeStep)) / this.timing.fadeSteps) | 0);
      }
      return;
    }
    // WALL.DARK: idle until the next complete frame arrives.
  }

  // -- self-test ------------------------------------------------------------

  #patternMs(index) {
    switch (index) {
      case 0: return CALIBRATION_TIMING.redMs;
      case 1: return CALIBRATION_TIMING.columnMs;
      case 2: return CALIBRATION_TIMING.walkMs;
      default: return CALIBRATION_TIMING.indexMs;
    }
  }

  #beginPattern(index) {
    this.self.pattern = index;
    this.self.startMs = this.clock;
    this.self.stepNextMs = this.clock;
    this.self.stepIndex = 0;
    const name = SELFTEST_NAMES[index];
    this.onLog(`selftest: ${name}`);
    if (name === 'INDEX_MAP') {
      this.onLog(`  colour legend: ${INDEX_MAP_LEGEND}`);
      this.onLog('  group 0..19 = index/20 (rows of the identity layout)');
      this.onLog('  position 0..19 = index%20 (columns of the identity layout)');
    }
  }

  /** Mirrors selftestRun(): one switch, no early return, watchdog kept off at the end. */
  #selftestRun() {
    const now = this.clock;

    if (now - this.self.startMs >= this.#patternMs(this.self.pattern)) {
      this.#beginPattern((this.self.pattern + 1) % CALIBRATION_PATTERNS.length);
    }

    const name = CALIBRATION_PATTERNS[this.self.pattern];
    const pace = patternPace(name);

    if (pace.stepMs === 0) {
      // all-red / index-map: painted once, then held for the pattern's duration.
      if (this.self.stepIndex === 0) {
        this.#paintPattern(0);
        this.self.stepIndex = 1;
      }
    } else if (now >= this.self.stepNextMs) {
      this.self.stepNextMs = now + pace.stepMs;
      this.#paintPattern(this.self.stepIndex);
      this.self.stepIndex += 1;
    }

    // Keep the watchdog off while the self-test is driving the wall.
    this.lastCompleteMs = this.clock;
  }

  #paintPattern(step) {
    this.lastFrame.set(calibrationPhysicalBytes(CALIBRATION_PATTERNS[this.self.pattern], step));
    this.#renderWall(256);
  }
}

// ---------------------------------------------------------------------------
// Status line parsing — reading the board back
// ---------------------------------------------------------------------------

/**
 * Parse one firmware status line.
 *
 * The board prints this whether or not anything else is wired up, so it is the
 * only feedback channel a calibration pass has: `br=` tells you what the power
 * guard actually allowed, `disc`/`rewind` tell you the wire is losing bytes,
 * `gaps` tells you the host is dropping frames, and `stale` tells you the stream
 * stopped. Reading it back is what makes `--status` a diagnostic rather than a
 * guess.
 *
 * @param {string} line
 * @returns {object|null} null for anything that is not a status line
 */
export function parseStatusLine(line) {
  const text = line.trim();
  if (!text.startsWith('wall ')) return null;

  const out = { kind: 'status', raw: text };
  for (const token of text.slice('wall '.length).split(' ')) {
    const eq = token.indexOf('=');
    if (eq < 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    switch (key) {
      case 'br': {
        const slash = value.indexOf('/');
        out.brightness = Number(value.slice(0, slash));
        out.brightnessCap = Number(value.slice(slash + 1));
        break;
      }
      case 'est': out.estimateMa = Number(value.replace(/mA$/, '')); break;
      // `cap=` is full-white current at the applied brightness, not a limit.
      case 'cap': out.fullWhiteMa = Number(value.replace(/mA$/, '')); break;
      case 'limit': out.limitMa = Number(value.replace(/mA$/, '')); break;
      // The WLED sink spells the declared budget `lim=`; the sketch spells it
      // `limit=` and appends the unit. Both are the same field.
      case 'lim': out.limitMa = Number(value.replace(/mA$/, '')); break;
      case 'state': out.state = value; break;
      case 'rx': out.rx = Number(value); break;
      // Only the WLED sink has a radio to report; the sketch never prints these.
      case 'wifi': out.wifiMode = Number(value); break;
      case 'woff': out.wifiOffs = Number(value); break;
      case 'seq': out.seq = Number(value); break;
      case 'frames': out.frames = Number(value); break;
      case 'meta': out.meta = Number(value); break;
      case 'disc': out.discarded = Number(value); break;
      case 'resync': out.resyncs = Number(value); break;
      case 'rewind': out.rewinds = Number(value); break;
      case 'gaps': out.seqGaps = Number(value); break;
      // Only the WLED rig can see a refresh in flight; the sketch has no such field.
      case 'torn': out.torn = Number(value); break;
      case 'stale': out.stale = Number(value); break;
      default: break;
    }
  }
  return out;
}

/**
 * Self-test announcements, so a calibration run knows which pattern it is
 * looking at. The firmware prints these and nothing else about its state.
 */
export function parseSelftestLine(line) {
  const text = line.trim();
  if (!text.startsWith('selftest:')) return null;
  const rest = text.slice('selftest:'.length).trim();
  if (rest.startsWith('stopped by host frame')) return { kind: 'selftest', event: 'stopped' };
  const name = rest.split(' ')[0];
  const index = SELFTEST_NAMES.indexOf(name);
  if (index < 0) return null;
  return { kind: 'selftest', event: 'pattern', name, pattern: CALIBRATION_PATTERNS[index] };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * VirtualTransport — the virtual wall behind the same interface the real port
 * has, so WallDriver cannot tell them apart.
 *
 * The wire IS modelled, in the one way that matters: a frame takes
 * WIRE_MS_PER_FRAME (~13 ms of wire time at 921600 8N1) to reach the device, and
 * no more than MAX_IN_FLIGHT frames are outstanding — the same two rules
 * web/sinks.js's SerialSink applies to a real port. Bytes are delivered in one
 * gulp rather than spread across 13 ms; the device's decoder is chunk-agnostic,
 * so the difference is invisible to it.
 */
export class VirtualTransport {
  /** @param {{wall?: VirtualWall, tickMs?: number, maxInFlight?: number}} [opts] */
  constructor(opts = {}) {
    this.wall = opts.wall ?? new VirtualWall();
    this.tickMs = opts.tickMs ?? 8;
    this.maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
    /** @type {Array<{at: number, bytes: Uint8Array}>} frames still on the wire */
    this.pending = [];
    this.stats = { sent: 0, bytes: 0, dropped: 0 };
  }

  get connected() {
    return true;
  }

  /** @returns {boolean} false when the wire is already carrying maxInFlight frames */
  send(bytes) {
    if (this.pending.length >= this.maxInFlight) {
      this.stats.dropped++;
      return false;
    }
    // Copy: WallDriver reuses its encode buffer, and a frame on the wire must not
    // be able to change underneath the device.
    this.pending.push({ at: this.wall.clock + WIRE_MS_PER_FRAME, bytes: bytes.slice() });
    this.stats.sent++;
    this.stats.bytes += bytes.length;
    return true;
  }

  /** Advance the device's clock in real time, delivering what the wire has finished carrying. */
  async sleep(ms) {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(this.tickMs, left);
      this.wall.step(slice);
      left -= slice;
      this.#flush();
    }
    this.#flush();
  }

  #flush() {
    const now = this.wall.clock;
    while (this.pending.length > 0 && this.pending[0].at <= now) {
      const { bytes } = this.pending.shift();
      this.wall.push(bytes);
    }
  }

  async close() {
    this.pending.length = 0;
  }
}

/**
 * SerialTransport — the real port.
 *
 * `serialport` is loaded with a dynamic import on purpose: the virtual path, the
 * verify scenario, and every test must work on a machine where the native module
 * failed to build, and a top-level import would make this whole file unusable
 * there.
 *
 * Backpressure mirrors web/sinks.js exactly: at most MAX_IN_FLIGHT writes
 * outstanding, and a frame is DROPPED rather than queued, because a growing queue
 * on a live banner means the wall is showing last week's frame.
 */
export class SerialTransport {
  /**
   * @param {object} opts
   * @param {string} opts.path COM5 or /dev/ttyUSB0
   * @param {number} [opts.baudRate] must match the sketch's -D BAUD
   * @param {number} [opts.maxInFlight]
   */
  constructor(opts) {
    if (!opts || typeof opts.path !== 'string' || opts.path === '') {
      throw new TypeError('SerialTransport requires a path');
    }
    this.path = opts.path;
    this.baudRate = opts.baudRate ?? DEFAULT_BAUD;
    this.maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
    this.port = null;
    this.inFlight = 0;
    this.stats = { sent: 0, bytes: 0, dropped: 0, errors: 0 };
    /** Lines the device has printed that nothing has read yet. */
    this.lineQueue = [];
    this.waiters = [];
    /** Partial line carried across a chunk boundary. */
    this.partial = '';
  }

  get connected() {
    return this.port !== null && this.port.isOpen;
  }

  async open() {
    if (this.connected) return this;
    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch (err) {
      throw new Error(
        `bridge: --port needs the serialport package (${err.message}). It is the only `
        + 'non-builtin dependency in this toolchain; run npm install.',
      );
    }
    this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    this.port.on('data', (chunk) => this.#onData(chunk));
    this.port.on('error', () => {
      this.stats.errors++;
    });
    await new Promise((done, fail) => {
      this.port.open((err) => (err ? fail(new Error(`bridge: cannot open ${this.path}: ${err.message}`)) : done()));
    });
    // Same run-mode pulse as the app's SerialSink (web/sinks.js): the
    // previous host's close sequence (DTR deasserted -> IO0 LOW through the
    // auto-reset circuit) leaves the chip in the BOOTLOADER; without this,
    // the bridge writes to a dark wall. DTR asserted = IO0 HIGH = boot into
    // firmware.
    await this.#pulseRunMode(this.port);
    return this;
  }

  async #pulseRunMode(port) {
    const set = (s) => new Promise((done, fail) => port.set(s, (err) => (err ? fail(err) : done())));
    try {
      await set({ dtr: true, rts: true });
      await new Promise((done) => setTimeout(done, 100));
      await set({ dtr: true, rts: false });
    } catch {
      // Drivers without modem control: nothing to pulse; the chip is
      // already running. Not a connection failure.
    }
  }

  /** @returns {boolean} false when the port is already carrying maxInFlight frames */
  send(bytes) {
    if (!this.connected) return false;
    if (this.inFlight >= this.maxInFlight) {
      this.stats.dropped++;
      return false;
    }
    const chunk = bytes.slice();
    this.inFlight += 1;
    this.stats.sent++;
    this.stats.bytes += chunk.length;
    this.port.write(chunk, (err) => {
      this.inFlight -= 1;
      if (err) this.stats.errors++;
    });
    return true;
  }

  /** A real port has no clock to advance; this is wall time. */
  async sleep(ms) {
    await new Promise((done) => setTimeout(done, ms));
  }

  /**
   * Everything the device prints, as it arrives.
   *
   * The firmware's output is line-oriented (Serial.println), so lines are the
   * right unit: status lines and self-test announcements each fit on one, and a
   * calibration run needs the announcements to know which pattern it is looking
   * at.
   */
  async *lines() {
    for (;;) {
      if (this.lineQueue.length > 0) {
        yield this.lineQueue.shift();
        continue;
      }
      if (!this.connected) return;
      await new Promise((done) => this.waiters.push(done));
    }
  }

  /** Status lines only, parsed. */
  async *statusLines() {
    for await (const line of this.lines()) {
      const parsed = parseStatusLine(line);
      if (parsed) yield parsed;
    }
  }

  async close() {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    for (const done of this.waiters) done();
    this.waiters.length = 0;
    // Leave the chip RUNNING, not in the bootloader: pulse run mode before
    // letting go so the next host (the app, the bridge, esptool) opens a
    // port to a live firmware.
    if (port.isOpen) await this.#pulseRunMode(port);
    if (port.isOpen) await new Promise((done) => port.close(done));
  }

  #onData(chunk) {
    this.partial += chunk.toString('utf8');
    let nl;
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      const line = this.partial.slice(0, nl).replace(/\r$/, '');
      this.partial = this.partial.slice(nl + 1);
      if (line === '') continue;
      this.lineQueue.push(line);
      const done = this.waiters.shift();
      if (done) done();
    }
  }
}

/* DDP — WLED's realtime transport, and how LedFX, xLights and Hyperion drive
 * it. The same frozen frame record goes in; what leaves is DDP over UDP.
 *
 * Header, per WLED's own udp.cpp:
 *
 *   0  flags     0x40 (VER1) | 0x01 (PUSH)
 *   1  sequence  1..15 — WLED's comment: "0 means unused"
 *   2  type      0x0B (RGB24)
 *   3  id        0x01 (DISPLAY)
 *   4  offset    32-bit, MSB first — always 0: a 1200-byte frame fits one
 *   8  length    16-bit, MSB first       packet, and the protocol allows 1440
 *  10  payload   R,G,B triplets
 *
 * DDP carries no brightness, so the meta record's brightness is applied here,
 * host-side, with the same shift the sketch uses. The limit is dropped: WLED has
 * a brightness limiter of its own.
 */
export const DDP_PORT = 4048;
const DDP_HEADER_BYTES = 10;
const DDP_FLAGS_VER1 = 0x40;
const DDP_FLAGS_PUSH = 0x01;
const DDP_TYPE_RGB24 = 0x0b;
const DDP_ID_DISPLAY = 0x01;

export class DdpTransport {
  /**
   * @param {object} opts
   * @param {string} opts.host WLED's address, optionally host:port
   * @param {number} [opts.port] default 4048
   * @param {number} [opts.brightness] 0..255, until a meta record says otherwise
   * @param {{send: Function}} [opts.socket] injected by tests
   */
  constructor(opts) {
    if (!opts || typeof opts.host !== 'string' || opts.host === '') {
      throw new TypeError('DdpTransport requires a host');
    }
    const colon = opts.host.lastIndexOf(':');
    const inlinePort = colon > 0 && /^\d+$/.test(opts.host.slice(colon + 1));
    this.host = inlinePort ? opts.host.slice(0, colon) : opts.host;
    this.port = inlinePort ? Number(opts.host.slice(colon + 1)) : (opts.port ?? DDP_PORT);
    this.brightness = opts.brightness ?? 255;
    this.sequence = 0;
    this.socket = opts.socket ?? null;
    this.ownsSocket = opts.socket === undefined;
    this.stats = { sent: 0, bytes: 0, meta: 0, dropped: 0 };
  }

  get connected() {
    return this.socket !== null;
  }

  async open() {
    if (this.connected) return this;
    const { createSocket } = await import('node:dgram');
    this.socket = createSocket('udp4');
    // A datagram to a host that is not listening surfaces as ECONNREFUSED on a
    // later receive on Windows; there is nothing useful to do with it here.
    this.socket.on('error', () => {});
    // A UDP socket holds the event loop open by itself, and every bounded run
    // (--duration, --status) is a process that has to exit.
    if (typeof this.socket.unref === 'function') this.socket.unref();
    return this;
  }

  /** @returns {boolean} false when the record was not a frame we could send */
  send(bytes) {
    if (!this.connected) return false;

    if (bytes[0] === META_MAGIC) {
      this.brightness = bytes[1];
      this.stats.meta += 1;
      return true;
    }
    if (bytes[0] !== FRAME_MAGIC) {
      this.stats.dropped += 1;
      return false;
    }

    const rgb = bytes.subarray(OFFSET_RGB, OFFSET_RGB + RGB_BYTES);
    const packet = Buffer.allocUnsafe(DDP_HEADER_BYTES + rgb.length);
    this.sequence = (this.sequence % 15) + 1; // 1..15; 0 means "unused"
    packet[0] = DDP_FLAGS_VER1 | DDP_FLAGS_PUSH;
    packet[1] = this.sequence;
    packet[2] = DDP_TYPE_RGB24;
    packet[3] = DDP_ID_DISPLAY;
    packet.writeUInt32BE(0, 4);
    packet.writeUInt16BE(rgb.length, 8);

    const b = this.brightness;
    if (b >= 255) {
      packet.set(rgb, DDP_HEADER_BYTES);
    } else {
      for (let i = 0; i < rgb.length; i++) packet[DDP_HEADER_BYTES + i] = (rgb[i] * b) >> 8;
    }

    this.socket.send(packet, this.port, this.host);
    this.stats.sent += 1;
    this.stats.bytes += packet.length;
    return true;
  }

  /** UDP has no clock to advance; this is wall time. */
  async sleep(ms) {
    await new Promise((done) => setTimeout(done, ms));
  }

  /** DDP is one-way. WLED's own UI and JSON API are the readback. */
  async *lines() {}

  async close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && this.ownsSocket && typeof socket.close === 'function') socket.close();
  }
}
/** COM5 / /dev/ttyUSB0 names, for --list. */
export async function listPorts() {
  try {
    const { SerialPort } = await import('serialport');
    return await SerialPort.list();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * How long a static pattern is held before its frame is sent again.
 *
 * A static pattern is the point of truth — the wall has to sit on it, not flash
 * it and fade. The device fades a wall that goes quiet for timing.staleMs, so
 * driving one from here means re-sending it; a third of the stale window leaves
 * 3x margin and costs ~2.4 KB/s, which 921600 does not notice.
 */
export const STATIC_REFRESH_MS = WALL_TIMING.staticRefreshMs;

/**
 * Calibration patterns, paced exactly like the flashed firmware's self-test.
 *
 * Pacing comes from core/calibration.js's CALIBRATION_TIMING, which
 * test/calibration.test.js pins against the firmware's -D defaults. That is the
 * point: watch the wall from Node, then watch it from the flashed board, and the
 * two are the same show — so any difference you see is a wiring fact rather than
 * a timing artefact.
 *
 * One deliberate difference. The flashed self-test paints a static pattern once
 * and holds it with the stale watchdog switched off, because inside the sketch
 * nothing can fade it. Driven from here the watchdog is live, so a static pattern
 * is re-sent every STATIC_REFRESH_MS — same picture, same slot length, no fade.
 * Sending it once and trusting the wall to keep showing it is what made
 * `--pattern index-map` a 1.5 s flash followed by black on real hardware, which
 * is exactly the pattern the calibration pass is supposed to read.
 *
 * @param {string} name one of CALIBRATION_PATTERNS
 * @param {object} [opts]
 * @param {number} [opts.durationMs] how long to run it; default the firmware's own duration
 * @param {number} [opts.steps] cap the number of steps emitted (tests)
 * @yields {{bytes: Uint8Array, holdMs: number, label: string, step: number}}
 */
export async function* patternSource(name, opts = {}) {
  const pace = patternPace(name); // throws for an unknown name
  const durationMs = opts.durationMs ?? pace.durationMs;
  const { stepMs } = pace;

  if (stepMs === 0) {
    // Static: the bytes never change, so the step only paces the re-send, and the
    // last hold absorbs the remainder so the slot lasts exactly as long as the
    // firmware's — a cycle stays 20.4 s.
    const refreshMs = Math.min(STATIC_REFRESH_MS, durationMs);
    const available = Math.ceil(durationMs / refreshMs);
    const steps = opts.steps === undefined ? available : Math.min(available, opts.steps);
    for (let step = 0; step < steps; step++) {
      const holdMs = Math.min(refreshMs, durationMs - step * refreshMs);
      yield { bytes: calibrationPhysicalBytes(name, 0), holdMs, label: name, step };
    }
    return;
  }

  const available = Math.floor(durationMs / stepMs);
  const steps = opts.steps === undefined ? available : Math.min(available, opts.steps);
  for (let step = 0; step < steps; step++) {
    yield { bytes: calibrationPhysicalBytes(name, step), holdMs: stepMs, label: name, step };
  }
}

/**
 * All four patterns in firmware order, forever — the self-test cycle.
 * @yields the same records as patternSource
 */
export async function* cycleSource(opts = {}) {
  for (;;) {
    for (const name of CALIBRATION_PATTERNS) yield* patternSource(name, opts);
  }
}

/**
 * Ask the dev server's /capture route for a raster of a page.
 *
 * The route is the only place in this project that turns arbitrary HTML into
 * pixels, because it is the only place with a browser. Node has no rasteriser and
 * inventing a second one would be a second implementation of something
 * web/banner.js and web/page.js already do correctly.
 */
async function captureShot(endpoint, { url, width, height, dsf, waitMs, reload }) {
  const query = new URLSearchParams({
    url,
    w: String(width),
    h: String(height),
    dsf: String(dsf),
    wait: String(waitMs),
  });
  if (reload) query.set('reload', '1');

  const res = await fetch(`${endpoint}?${query}`, { cache: 'no-store' });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      // Non-JSON error body: statusText is all there is.
    }
    throw new Error(`page capture failed: ${res.status} ${detail}`);
  }

  const header = (name) => Number(res.headers.get(name));
  return {
    png: Buffer.from(await res.arrayBuffer()),
    hash: res.headers.get('X-Capture-Hash'),
    width: header('X-Capture-Width'),
    height: header('X-Capture-Height'),
    scrollHeight: header('X-Capture-Scroll-Height'),
    ms: header('X-Capture-Ms'),
  };
}

/**
 * A live web page, captured through the dev server and panned down the panel.
 *
 * This is milestone 2's pipeline running headless: the same core/panner.js the
 * browser app uses, fed by the same Chromium capture the app uses, with no tab
 * open anywhere. It is also the only way to put arbitrary HTML on the wall from a
 * machine that is not running the app.
 *
 * Needs tools/serve.js running (npm run serve, or pass --serve here) — the
 * rasterising happens there, and a page on some other origin cannot be drawn by
 * this process.
 *
 * @param {string} url absolute http(s) page URL
 * @param {object} [opts]
 * @param {string} [opts.endpoint] capture route URL, default http://127.0.0.1:8080/capture
 * @param {number} [opts.pollMs] minimum gap between captures; default max(100, 1000/fps)
 * @param {number} [opts.fps] frame rate the wall is fed at; default 30
 * @param {number} [opts.pxPerCell] zoom: source pixels per panel cell. Omit for the mode's own choice.
 * @param {'fill'|'fit'} [opts.mode]
 * @param {'x'|'y'} [opts.axis]
 * @param {number} [opts.cellsPerFrame] fractional pan per frame
 * @param {number} [opts.width] CSS viewport width to render the page at
 * @param {number} [opts.height] CSS viewport height
 * @param {number} [opts.dsf] device pixels per CSS pixel
 * @param {number} [opts.frames] stop after this many frames (tests)
 * @yields {{bytes: Uint8Array, holdMs: number, label: string, panel: Panel, capture: object, panOffset: number}}
 */
export async function* pageSource(url, opts = {}) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) {
    throw new RangeError(`pageSource: url must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
  }

  const endpoint = opts.endpoint ?? 'http://127.0.0.1:8080/capture';
  const fps = opts.fps ?? 30;
  const holdMs = 1000 / fps;
  // Poll as fast as the capture route answers, floored at 100 ms. Measured on
  // this machine: a shot is ~50 ms of Chromium work and the route sustains ~16
  // captures/s. The old 500 ms default refreshed the page at 2 Hz while the wall
  // ran at 30 fps, so a live page reached the wall as a slideshow.
  const pollMs = opts.pollMs ?? Math.max(100, holdMs);
  const layout = opts.layout ?? new Layout();
  const panel = new Panel();

  /** Panner config, fixed for the life of the source. */
  const view = {
    mode: opts.mode ?? 'fill',
    axis: opts.axis ?? 'y',
    pxPerCell: opts.pxPerCell ?? null,
    cellsPerFrame: opts.cellsPerFrame ?? 0.15,
    direction: opts.direction ?? DOWN,
    loop: opts.loop ?? true,
  };

  /** Re-decode only when the capture's content hash changes: a static page costs one screenshot and zero decodes per poll. */
  let hash = null;
  let panner = null;
  let shot = null;

  const apply = (next) => {
    if (next.hash === hash && panner !== null) {
      shot = next; // same pixels: keep the pan, skip the decode
      return;
    }
    const decoded = decodePng(next.png);
    // A captured page is opaque, so alpha is 255 everywhere and core/scroller.js
    // reads every cell as fully covered: the page's own background is part of the
    // image. The Bitmap's cell unit is one source pixel; the zoom is a display
    // choice, which is what core/panner.js's pxPerCell is for.
    const source = bitmap(rgbaOf(decoded), decoded.w, decoded.h, 1);
    // Pixels are swapped into the LIVE Panner, not rebuilt. `offset` IS the
    // wall's scroll position: reconstructing on every poll snapped the sweep back
    // to the top of the page, so the wall never got past the first screenful.
    // Rebuild only when the capture's size changed, because the pan range depends
    // on it — the same rule web/app.js's buildPanner() uses.
    if (panner !== null && panner.source.w === source.w && panner.source.h === source.h) {
      panner.source = source;
    } else {
      panner = new Panner({ panel, source, ...view });
    }
    hash = next.hash;
    shot = next;
  };

  const request = (reload = false) => captureShot(endpoint, {
    url,
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
    dsf: opts.dsf ?? 1,
    waitMs: opts.waitMs ?? 400,
    reload,
  });

  // The first frame must be a real capture: a caller that asks for three frames
  // expects the page in all three, not a blank grid while the first shot is in
  // flight.
  apply(await request(true));

  let lastStart = Date.now();
  /** The capture currently in flight. At most one, so shots never queue on the tab. */
  let inFlight = null;
  /** Set when the generator finishes: a capture landing after that is not news. */
  let finished = false;

  const limit = opts.frames ?? Infinity;
  try {
    for (let emitted = 0; emitted < limit; emitted++) {
      // Captured in the BACKGROUND. A shot is a Chromium screenshot — ~50 ms, up to
      // ~125 ms when the page reflows — so awaiting it here stalled the frame loop
      // for that long (measured: 52 ms average gap, 124 ms worst, on a 33 ms
      // budget) and the wall hitched on every refresh. The loop keeps its own pace
      // and takes whatever the last finished capture produced.
      if (inFlight === null && Date.now() - lastStart >= pollMs) {
        lastStart = Date.now();
        inFlight = request().then(
          (next) => {
            inFlight = null;
            if (finished) return;
            apply(next);
          },
          (err) => {
            inFlight = null;
            // A dead upstream must not kill a running wall: keep the last good
            // capture and let the next poll try again. A source that has already
            // ended has nothing to go stale — its last capture is in the past.
            if (!finished) opts.onStale?.(err.message);
          },
        );
      }

      panner.tick();
      yield {
        bytes: pack(panel, layout),
        holdMs,
        label: url,
        panel,
        capture: shot,
        // The pan position, exposed because it is the thing a live feed can lose:
        // a refresh that rebuilds the Panner snaps this to 0 and the wall jumps
        // back to the top of the page.
        panOffset: panner.offset,
      };
    }
  } finally {
    finished = true;
  }
}

// ---------------------------------------------------------------------------
// WallDriver
// ---------------------------------------------------------------------------

/**
 * WallDriver — paces a source onto a transport and owns the meta frame.
 *
 * The meta frame goes out BEFORE the first frame, because the device's power
 * guard is what protects the supply and a guard configured after the first bright
 * frame is a guard that watched one frame blow past the limit.
 */
export class WallDriver {
  /**
   * @param {object} opts
   * @param {VirtualTransport|SerialTransport} opts.transport
   * @param {import('../core/index.js').Layout} [opts.layout] how logical cells map to physical LEDs
   * @param {number} [opts.brightness] 0..255, what the host asks for
   * @param {number} [opts.limitMa] power budget declared to the device
   * @param {number} [opts.fps] default 30
   * @param {(rec: object) => void} [opts.onFrame]
   */
  constructor(opts) {
    if (!opts || !opts.transport) throw new TypeError('WallDriver requires a transport');
    this.transport = opts.transport;
    this.layout = opts.layout ?? new Layout();
    this.brightness = opts.brightness ?? 255;
    this.limitMa = opts.limitMa ?? WALL_TIMING.defaultLimitMa;
    this.fps = opts.fps ?? 30;
    this.onFrame = opts.onFrame ?? (() => {});
    this.seq = 0;
    this.stopped = false;
    /** Reused: 1203 bytes per frame at 30 fps is 36 KB/s of garbage for nothing. */
    this.out = new Uint8Array(FRAME_BYTES);
    this.stats = { frames: 0, skipped: 0, unchanged: 0, meta: 0 };
    /** The payload the transport was last given, and when, or null for nothing. */
    this.lastSent = null;
    this.lastSentMs = 0;
    /** Logical time. The transport's sleep is this driver's only clock, so a test
     * running a 4 s slot in milliseconds still sees a 4 s slot. */
    this.clockMs = 0;
  }

  sendMeta() {
    const record = meta({ brightness: this.brightness, limitMa: this.limitMa });
    if (this.transport.send(record)) this.stats.meta += 1;
    return record;
  }

  /**
   * @param {AsyncIterable<{bytes: Uint8Array, holdMs: number}>} source
   * @param {{durationMs?: number}} [opts]
   */
  async run(source, opts = {}) {
    const deadline = opts.durationMs === undefined ? null : Date.now() + opts.durationMs;
    this.stopped = false;
    this.sendMeta();

    for await (const rec of source) {
      if (this.stopped) break;
      if (deadline !== null && Date.now() >= deadline) break;

      this.clockMs += rec.holdMs ?? 1000 / this.fps;

      // Only send what changed, plus a periodic re-send so the device's stale
      // watchdog stays fed: it cannot tell an unchanged wall from a dead host, so
      // a change-only rule would let a still wall fade to black. Continuously
      // rewriting the buffer is the other extreme — it races the device's own
      // render loop without adding anything. Skipping also skips the seq advance,
      // so a still wall burns no sequence numbers and reports no phantom gaps.
      const changed = this.lastSent === null || !sameBytes(rec.bytes, this.lastSent);
      if (!changed && this.clockMs - this.lastSentMs < STATIC_REFRESH_MS) {
        this.stats.unchanged += 1;
        this.onFrame(rec);
        await this.transport.sleep(rec.holdMs ?? 1000 / this.fps);
        continue;
      }
      // Copy rather than alias: sources reuse their buffers between records.
      if (this.lastSent === null) this.lastSent = new Uint8Array(rec.bytes.length);
      this.lastSent.set(rec.bytes);
      this.lastSentMs = this.clockMs;

      encodeFrameInto(this.out, this.seq, rec.bytes);
      if (this.transport.send(this.out)) {
        this.seq = nextSeq(this.seq);
        this.stats.frames += 1;
      } else {
        this.stats.skipped += 1;
      }
      this.onFrame(rec);
      await this.transport.sleep(rec.holdMs ?? 1000 / this.fps);
    }
  }

  stop() {
    this.stopped = true;
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Indexed by the lit-channel bitmask: 0 off, 1 R, 2 G, 3 yellow, 4 B, 5 magenta, 6 cyan, 7 white. */
const LEGEND = Object.freeze(['.', 'R', 'G', 'Y', 'B', 'M', 'C', 'W']);

/**
 * ASCII view of what a wall is showing, laid out where the cells ARE.
 *
 * This is the calibration tool without the panel: pack a pattern with your current
 * core/layout.js and this prints what the wall would light up. Compare it against
 * the physical-order pattern the firmware shows and the wiring question answers
 * itself.
 *
 * @param {Uint8Array} strip 1200 bytes in PHYSICAL LED order
 * @param {import('../core/index.js').Layout} layout which physical LED each cell is
 */
export function asciiPreview(strip, layout = identity()) {
  const rows = [];
  for (let y = 0; y < layout.rows; y++) {
    let line = '';
    for (let x = 0; x < layout.cols; x++) {
      const i = layout.index(x, y) * 3;
      const mask = (strip[i] > 24 ? 1 : 0) | (strip[i + 1] > 24 ? 2 : 0) | (strip[i + 2] > 24 ? 4 : 0);
      line += LEGEND[mask];
    }
    rows.push(line);
  }
  return rows.join('\n');
}

/**
 * Turn `--page` into a URL the capture route can actually fetch.
 *
 * `--serve` picks a port you cannot know in advance, so a page is normally given as
 * a path (`/anim-400.html`) and resolved against the server that is about to serve
 * it. An absolute URL on some other port is guaranteed to fail — the capture route
 * would be asking a server that is not running for a page only this one has — so the
 * server's own origin wins and the substitution is printed instead of hidden.
 */
function servedPageUrl(page, port) {
  const base = `http://127.0.0.1:${port}`;
  if (!/^https?:/i.test(page)) {
    const resolved = new URL(page.startsWith('/') ? page : `/${page}`, base).href;
    console.log(`bridge: --page ${page} -> ${resolved}`);
    return resolved;
  }

  const url = new URL(page);
  if (url.port === String(port)) return page;
  const served = new URL(url.pathname + url.search, base);
  console.log(`bridge: --page ${page} -> ${served.href} (the dev server's own origin)`);
  return served.href;
}

// ---------------------------------------------------------------------------
// serve.js helper
// ---------------------------------------------------------------------------

/**
 * Boot tools/serve.js for --page, on a port a client can actually reach, and take
 * the whole process tree down on the way out.
 *
 * Same teardown rule tools/start.js follows: on Windows a plain child.kill()
 * stops only Node and orphans the Chromium serve.js owns, so the next run pays for
 * a second browser and can fail on a locked profile. Hence taskkill /T.
 */
async function startServe(port) {
  const child = spawn(process.execPath, [SERVE_SCRIPT, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  const collect = (chunk) => { log += chunk; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const ready = /LED wall dev server: (http:\/\/127\.0\.0\.1:\d+)/;
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve.js did not report a port: ${log}`)), 20_000);
    const check = () => {
      const bound = ready.exec(log);
      if (!bound) return false;
      clearTimeout(timer);
      done();
      return true;
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`serve.js exited early (${code}): ${log}`));
    });
    check();
  });

  return {
    port,
    endpoint: `http://127.0.0.1:${port}/capture`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      await new Promise((done) => child.once('exit', done));
    },
  };
}

// ---------------------------------------------------------------------------
// Verify — the whole pipeline, no hardware
// ---------------------------------------------------------------------------

/**
 * A scripted scenario against the virtual wall, in the order a real hookup
 * happens. Each phase asserts something and prints what the device saw, so the
 * output reads like a bench log rather than a pass/fail list.
 *
 * The phases are the properties the firmware's decoder exists to guarantee: a bad
 * frame never reaches the LEDs, one lost byte costs one frame, a truncated frame
 * is never half-shown, a dead stream goes dark instead of freezing, and the power
 * guard changes pixels rather than just the log.
 *
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {{ok: boolean, phases: Array<{name: string, pass: boolean, detail: string}>, wall: VirtualWall}}
 */
export async function verify(opts = {}) {
  const say = opts.log ?? ((line) => console.log(line));
  const phases = [];
  const check = (name, pass, detail) => {
    phases.push({ name, pass, detail });
    say(`${pass ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    return pass;
  };

  // limit 24000 mA so the power guard allows full brightness: pixel assertions stay
  // comparable. Phase 3 then lowers the limit and proves the guard reaches the LEDs.
  const wall = new VirtualWall({ selftest: true, limitMa: 24000, onLog: (line) => say(`  device | ${line}`) });
  const transport = new VirtualTransport({ wall });
  const layout = new Layout();
  const out = new Uint8Array(FRAME_BYTES);
  const black = new Uint8Array(RGB_BYTES);
  const redBytes = calibrationPhysicalBytes('all-red', 0);
  let allGood = true;

  // 1. The self-test owns the wall until the host says otherwise.
  wall.run(1200);
  const red = wall.wallPixel(0);
  allGood = check(
    'selftest takeover',
    red[0] === 255 && red[1] === 0 && red[2] === 0 && wall.self.active && wall.litFraction() === 1,
    `ALL_RED on the wall before any host frame (${red.join(',')}); ${(wall.litFraction() * 100).toFixed(0)}% lit`,
  ) && allGood;

  // 2. A complete frame ends the self-test and takes over.
  const onePixel = new Panel();
  onePixel.setPixel(0, 0, 255, 255, 255);
  encodeFrameInto(out, 0, pack(onePixel, layout));
  transport.send(out);
  await transport.sleep(60);
  allGood = check(
    'host frame takeover',
    !wall.self.active && wall.stats.frames === 1 && wall.wallPixel(0).join(',') === '255,255,255',
    `selftest stopped by host frame; frames=${wall.stats.frames} lit=${(wall.litFraction() * 100).toFixed(2)}%`,
  ) && allGood;

  // 3. Power guard: a 4000 mA budget must dim the wall, not just the log.
  transport.send(meta({ brightness: 255, limitMa: 4000 }));
  await transport.sleep(40);
  const guarded = parseStatusLine(wall.statusLine());
  const dimmed = wall.wallPixel(0);
  allGood = check(
    'power guard reaches the pixels',
    guarded.brightness === 42 && dimmed[0] === scaleChannel(255, 42),
    `limit=4000mA -> br=${guarded.brightness}/42, the white LED is now ${dimmed.join(',')} (was 255,255,255)`,
  ) && allGood;

  // 4. A clean stream: 13 walk frames, no discards, no seq gaps.
  //    The driver's seq continues from the wall's last committed frame, exactly as a
  //    host must; restarting at 0 after frames have already landed is a gap by definition.
  const driver = new WallDriver({ transport, layout, brightness: 255, limitMa: 24000 });
  driver.seq = nextSeq(wall.lastSeq);
  const before = { ...wall.stats };
  await driver.run(patternSource('walk', { durationMs: 400, steps: 13 }));
  // The virtual wire carries a frame 13 ms after it is handed over, so the clock has
  // to advance once more before the last frame of a finite source is on the wall.
  await transport.sleep(WIRE_MS_PER_FRAME + 20);
  const walked = wall.stats.frames - before.frames;
  allGood = check(
    'clean stream',
    walked === 13
      && wall.stats.discarded === before.discarded
      && wall.stats.seqGaps === before.seqGaps
      && driver.stats.skipped === 0,
    `${walked} walk frames landed, disc=${wall.stats.discarded} gaps=${wall.stats.seqGaps}`,
  ) && allGood;

  // 5. One dropped byte mid-stream: one frame lost, the next one still lands.
  //    The hole is in the MIDDLE of a payload, which is the case the rewind exists
  //    for: the short record swallows the next frame's 0xA5 as its last payload byte,
  //    so the magic we need is sitting inside the record we just rejected.
  const s1 = (wall.lastSeq + 1) & 0xff;
  const s2 = (s1 + 1) & 0xff;
  const broken = frame(s1, black); // the frame that gets lost
  const hole = broken.subarray(0, 700); // payload byte 700 is the one the wire loses
  transport.send(new Uint8Array([...hole, ...broken.subarray(701)]));
  transport.send(frame(s2, redBytes)); // and this one must still land
  await transport.sleep(40);
  const afterHole = wall.stats.frames; // the salvaged frame is already committed
  allGood = check(
    'dropped byte recovery',
    wall.stats.discarded === before.discarded + 1
      && wall.stats.rewinds === before.rewinds + 1
      && wall.stats.frames === afterHole
      && wall.wallPixel(0).join(',') === '255,0,0',
    `disc=${wall.stats.discarded} rewind=${wall.stats.rewinds} gaps=${wall.stats.seqGaps}; the frame after the hole landed (frames=${wall.stats.frames})`,
  ) && allGood;

  // 6. Truncated tail: a partial frame is never half-rendered.
  const litBeforePartial = wall.litFraction();
  const framesBeforePartial = wall.stats.frames;
  transport.send(frame((wall.lastSeq + 1) & 0xff, redBytes).subarray(0, 300));
  await transport.sleep(WALL_TIMING.partialGapMs + 30);
  allGood = check(
    'truncated frame discarded',
    wall.rx.state === RX.IDLE
      && wall.stats.discarded === before.discarded + 2
      && wall.stats.frames === framesBeforePartial
      && wall.litFraction() === litBeforePartial,
    `300 of ${FRAME_BYTES} bytes then silence -> rx=${wall.rx.state} (idle), disc=${wall.stats.discarded}, wall unchanged at ${(litBeforePartial * 100).toFixed(0)}% lit`,
  ) && allGood;

  // 7. Watchdog: no frames for staleMs => fade to black, not a frozen wall.
  const litBeforeFade = wall.litFraction();
  await transport.sleep(WALL_TIMING.staleMs + WALL_TIMING.fadeMs + 60);
  allGood = check(
    'watchdog fade',
    wall.wall === WALL.DARK && wall.litFraction() === 0 && wall.stats.stale >= 1,
    `${(litBeforeFade * 100).toFixed(0)}% lit -> 0% over ${WALL_TIMING.fadeMs}ms, stale=${wall.stats.stale}`,
  ) && allGood;

  // 8. Resume: the stream comes back with one frame, no re-sync handshake.
  transport.send(frame((wall.lastSeq + 1) & 0xff, redBytes));
  await transport.sleep(40);
  allGood = check(
    'stream resume',
    wall.wall === WALL.LIVE && wall.litFraction() === 1,
    `state=${parseStatusLine(wall.statusLine()).state} again with one frame, gaps still ${wall.stats.seqGaps}`,
  ) && allGood;

  // 9. The status line is machine-readable, because on a real board it is the only
  //    feedback a calibration pass gets.
  const parsed = parseStatusLine(wall.statusLine());
  allGood = check(
    'status line round-trip',
    parsed !== null
      && parsed.frames === wall.stats.frames
      && parsed.state === 'live'
      && parsed.limitMa === wall.limitMa
      && parsed.brightness === wall.activeBrightness,
    wall.statusLine(),
  ) && allGood;

  return { ok: allGood, phases, wall };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node tools/bridge.js [options]

  --port <path>        real device (COM5, /dev/ttyUSB0); without it the virtual wall is used
  --ddp <host[:port]>  stream frames to WLED over DDP (UDP), default port 4048
  --virtual            force the virtual wall even when --port is given
  --baud <n>           serial baud, default ${DEFAULT_BAUD} (must match the sketch's -D BAUD)
  --list               list serial ports and exit
  --verify             scripted end-to-end scenario against the virtual wall (no hardware)
  --status             read the device's own output instead of sending frames
  --pattern <name>     ${CALIBRATION_PATTERNS.join(' | ')}; a static pattern
                       (all-red, index-map) is re-sent while it holds, so the
                       device's stale watchdog cannot fade it out mid-read
  --cycle              run all four patterns in firmware order, forever
  --duration <ms>      how long to run; --status defaults to 5000, a pattern
                       defaults to its own duration
  --page <url|path>    pan a live web page onto the wall; a bare path like
                       /anim-400.html is served by --serve
  --serve              start tools/serve.js for --page, on a free port
  --serve-port <n>     port for that dev server instead of a free one
  --endpoint <url>     capture route URL, default http://127.0.0.1:8080/capture
  --poll <ms>          re-capture period for --page, default max(100, 1000/--fps)
  --brightness <0-255> what the host asks for, default 255
  --limit <mA>         power budget declared to the device, default ${WALL_TIMING.defaultLimitMa}
  --layout <flags>     comma separated: flipX, flipY, transpose, snake, no-snake,
                       strip=<n>, axis=x|y, start=0/20/40/...
  --preview            ASCII view of the wall, printed whenever it changes
  --selftest           start the virtual wall in the wiring self-test
  --help, -h           this text
`;

/**
 * `--layout flipX,flipY,no-snake,strip=10` -> a Layout.
 *
 * The calibration pass is "try the eight mountings", so the flags have to be
 * typeable in one line rather than edited into a JS file between attempts.
 */
export function parseLayoutFlags(spec) {
  const config = {};
  if (spec === null || spec === undefined || String(spec).trim() === '') return config;

  for (const raw of String(spec).split(',')) {
    const flag = raw.trim();
    if (flag === '') continue;
    const eq = flag.indexOf('=');
    const name = eq < 0 ? flag : flag.slice(0, eq);
    const value = eq < 0 ? undefined : flag.slice(eq + 1);
    switch (name) {
      case 'flipX': config.flipX = true; break;
      case 'flipY': config.flipY = true; break;
      case 'transpose': config.transpose = true; break;
      case 'snake': config.snake = true; break;
      case 'no-snake': case 'straight': config.snake = false; break;
      case 'strip': case 'stripLength':
        config.stripLength = Number(value);
        if (!Number.isInteger(config.stripLength) || config.stripLength < 1) {
          throw new RangeError(`strip=${value} must be a positive integer`);
        }
        break;
      case 'axis':
        if (value !== 'x' && value !== 'y') throw new RangeError(`axis must be x or y, got ${value}`);
        config.stripAxis = value;
        break;
      case 'start': case 'startOffsets': {
        // '/' separated: a comma is already this flag's own separator.
        const list = String(value).split('/').map((v) => Number(v));
        if (list.length === 0 || list.some((v) => !Number.isInteger(v) || v < 0)) {
          throw new RangeError(`start entries must be non-negative integers, got ${value}`);
        }
        config.startOffsets = list;
        break;
      }
      default: throw new RangeError(`unknown flag ${JSON.stringify(flag)}`);
    }
  }
  return config;
}

export function parseArgs(argv) {
  const opts = {
    port: null,
    virtual: false,
    baud: DEFAULT_BAUD,
    ddp: null,
    list: false,
    verify: false,
    status: false,
    pattern: null,
    cycle: false,
    duration: null,
    page: null,
    serve: false,
    servePort: null,
    endpoint: null,
    fps: 30,
    pollMs: null,
    brightness: 255,
    limit: WALL_TIMING.defaultLimitMa,
    layout: '',
    preview: false,
    selftest: false,
    help: false,
  };

  const need = (name, value) => {
    if (value === undefined) throw new Error(`${name} needs a value`);
    return value;
  };
  const num = (name, value) => {
    const parsed = Number(need(name, value));
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${JSON.stringify(value)}`);
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port': opts.port = need('--port', argv[++i]); break;
      case '--ddp': opts.ddp = need('--ddp', argv[++i]); break;
      case '--virtual': opts.virtual = true; break;
      case '--baud': opts.baud = num('--baud', argv[++i]); break;
      case '--list': opts.list = true; break;
      case '--verify': opts.verify = true; break;
      case '--status': opts.status = true; break;
      case '--pattern': opts.pattern = need('--pattern', argv[++i]); break;
      case '--cycle': opts.cycle = true; break;
      case '--duration': opts.duration = num('--duration', argv[++i]); break;
      case '--page': opts.page = need('--page', argv[++i]); break;
      case '--serve': opts.serve = true; break;
      case '--serve-port':
        opts.servePort = num('--serve-port', argv[++i]);
        if (!Number.isInteger(opts.servePort) || !isFetchablePort(opts.servePort)) {
          throw new RangeError(
            `--serve-port ${opts.servePort} is not a port a client can connect to; pick any other, e.g. 8080`,
          );
        }
        break;
      case '--endpoint': opts.endpoint = need('--endpoint', argv[++i]); break;
      case '--fps': opts.fps = num('--fps', argv[++i]); break;
      case '--poll': opts.pollMs = num('--poll', argv[++i]); break;
      case '--brightness': opts.brightness = num('--brightness', argv[++i]); break;
      case '--limit': opts.limit = num('--limit', argv[++i]); break;
      case '--layout': opts.layout = need('--layout', argv[++i]); break;
      case '--preview': opts.preview = true; break;
      case '--selftest': opts.selftest = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (opts.servePort !== null && !opts.serve) {
    throw new Error('--serve-port needs --serve (it is the port the dev server binds)');
  }

  if (opts.brightness < 0 || opts.brightness > 255) {
    throw new RangeError(`--brightness must be 0..255, got ${opts.brightness}`);
  }
  if (!(opts.fps > 0)) throw new RangeError(`--fps must be > 0, got ${opts.fps}`);
  if (opts.duration !== null && !(opts.duration > 0)) throw new RangeError(`--duration must be > 0, got ${opts.duration}`);
  if (opts.pollMs !== null && !(opts.pollMs >= 100)) {
    throw new RangeError(`--poll must be >= 100 ms (a capture is a Chromium screenshot), got ${opts.pollMs}`);
  }
  return opts;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`bridge: ${err.message}`);
    console.error(USAGE);
    return 2;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  if (opts.list) {
    const ports = await listPorts();
    if (ports.length === 0) {
      console.log('no serial ports found (is the board plugged in, and did serialport build?)');
      return 0;
    }
    for (const p of ports) {
      console.log(`${p.path}  ${[p.manufacturer, p.serialNumber, p.pnpId].filter(Boolean).join('  ')}`);
    }
    return 0;
  }

  if (opts.verify) {
    const { ok } = await verify();
    console.log(ok ? '\nverify: all phases passed' : '\nverify: FAILED');
    return ok ? 0 : 1;
  }

  const modes = [opts.pattern, opts.cycle, opts.page, opts.status].filter(Boolean);
  if (modes.length === 0) {
    console.error('bridge: nothing to do. Pick --verify, --pattern, --cycle, --page or --status.');
    console.error(USAGE);
    return 2;
  }
  if (modes.length > 1) {
    console.error(`bridge: pick one of ${modes.join(', ')} at a time.`);
    return 2;
  }
  if (opts.pattern !== null && !CALIBRATION_PATTERNS.includes(opts.pattern)) {
    console.error(`bridge: unknown pattern ${JSON.stringify(opts.pattern)}; expected ${CALIBRATION_PATTERNS.join(' | ')}`);
    return 2;
  }
  if (opts.preview && !opts.virtual && (opts.port !== null || opts.ddp !== null)) {
    // DDP counts as a device too: --preview reads the LOCAL wall back to draw it,
    // and a DDP sink is remote, so there is no strip here to draw. Without this it
    // reached wall.strip on a null wall.
    console.error('bridge: --preview reads the device back, so it needs the virtual wall. Add --virtual.');
    return 2;
  }

  let layout;
  try {
    layout = new Layout(parseLayoutFlags(opts.layout));
  } catch (err) {
    console.error(`bridge: --layout ${JSON.stringify(opts.layout)}: ${err.message}`);
    return 2;
  }

  /** The device: a real port, or firmware.ino's loop() written in JS. */
  let transport = null;
  let wall = null;
  let serve = null;

  try {
    if (opts.ddp !== null) {
      transport = await new DdpTransport({ host: opts.ddp, brightness: opts.brightness }).open();
      console.log(`bridge: ddp -> ${transport.host}:${transport.port}`);
    } else if (opts.port !== null && !opts.virtual) {
      transport = await new SerialTransport({ path: opts.port, baudRate: opts.baud }).open();
      console.log(`bridge: ${opts.port} @ ${opts.baud}`);
    } else {
      wall = new VirtualWall({
        selftest: opts.selftest || opts.status || opts.cycle,
        limitMa: opts.limit,
        onLog: (line) => console.log(`  device | ${line}`),
      });
      transport = new VirtualTransport({ wall });
      console.log(`bridge: virtual wall (no --port). ${layout.describe()}`);
    }

    if (opts.status) {
      // Read the device rather than drive it: what you do while a board is plugged
      // in and you are looking at the LEDs.
      //
      // `--duration` bounds both transports. A serial port has no clock of its own,
      // so an unbounded read is a process that never exits — which, piped into a
      // pager or `tail`, is indistinguishable from a hang: the device prints at
      // 1 Hz and the pipe buffers everything behind it. Default to STATUS_DEFAULT_MS
      // so the common case terminates; pass a larger --duration to watch longer.
      const statusMs = opts.duration ?? STATUS_DEFAULT_MS;
      const deadline = Date.now() + statusMs;
      if (transport instanceof SerialTransport) {
        for await (const line of transport.lines()) {
          const status = parseStatusLine(line);
          const pattern = parseSelftestLine(line);
          if (status) {
            console.log(
              `  ${status.state.padEnd(6)} frames=${status.frames} disc=${status.discarded}`
              + ` rewind=${status.rewinds} gaps=${status.seqGaps} stale=${status.stale}`
              + ` br=${status.brightness}/${status.brightnessCap} est=${status.estimateMa}mA`,
            );
          } else if (pattern) {
            console.log(`  pattern: ${pattern.pattern ?? pattern.event}`);
          } else {
            console.log(`  | ${line}`);
          }
          if (Date.now() >= deadline) break;
        }
      } else {
        // The virtual wall prints on its own clock, so the bound is virtual time.
        // Same default as the serial path: an unbounded loop here spins forever.
        for (;;) {
          wall.step(100);
          if (wall.clock >= statusMs) break;
        }
      }
      return 0;
    }

    if (opts.page !== null) {
      if (opts.endpoint === null) {
        if (opts.serve) {
          const port = opts.servePort ?? await freePort();
          serve = await startServe(port);
          opts.endpoint = serve.endpoint;
          console.log(`bridge: dev server on http://127.0.0.1:${port}`);
          opts.page = servedPageUrl(opts.page, port);
        } else {
          if (!/^https?:/i.test(opts.page)) {
            console.error('bridge: --page needs a URL here; pass --serve and a path like /anim-400.html');
            return 2;
          }
          opts.endpoint = 'http://127.0.0.1:8080/capture';
          console.log('bridge: using http://127.0.0.1:8080/capture (npm run serve, or pass --serve / --endpoint)');
        }
      }
    }

    let source;
    if (opts.cycle) source = cycleSource();
    else if (opts.pattern !== null) source = patternSource(opts.pattern, { durationMs: opts.duration ?? undefined });
    else {
      source = pageSource(opts.page, {
        endpoint: opts.endpoint,
        layout,
        fps: opts.fps,
        pollMs: opts.pollMs ?? undefined,
        onStale: (message) => console.log(`  capture stale: ${message}`),
      });
    }

    const driver = new WallDriver({
      transport,
      layout,
      brightness: opts.brightness,
      limitMa: opts.limit,
      fps: opts.fps,
    });

    if (opts.preview) {
      // Print when the WALL changes, not once per source frame: a live page would
      // otherwise repaint the same grid 30 times a second, and a discarded frame
      // would print nothing at all even though it is the interesting event.
      const shown = new Uint8Array(RGB_BYTES).fill(0xff); // nothing committed yet
      driver.onFrame = (rec) => {
        if (sameBytes(shown, wall.strip)) return;
        shown.set(wall.strip);
        const step = rec.step === undefined ? '' : ` step=${rec.step}`;
        console.log(`\n${rec.label}${step}\n${asciiPreview(wall.strip, layout)}`);
      };
    }

    process.once('SIGINT', () => driver.stop());
    process.once('SIGTERM', () => driver.stop());

    await driver.run(source, opts.duration === null ? {} : { durationMs: opts.duration });

    if (wall !== null) {
      console.log(wall.statusLine());
      if (opts.preview) console.log(asciiPreview(wall.strip, layout));
    }
    console.log(
      `bridge: sent ${driver.stats.frames} frames (${driver.stats.skipped} skipped for backpressure), `
      + `${transport.stats.bytes} bytes, ${transport.stats.dropped} dropped`,
    );
    return 0;
  } catch (err) {
    console.error(`bridge: ${err.message}`);
    return 1;
  } finally {
    if (transport) await transport.close().catch(() => {});
    if (serve) await serve.stop().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}

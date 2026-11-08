/**
 * showfile — the `.ledshow` a wall can play with nothing attached.
 *
 * WHY THIS EXISTS
 * ---------------
 * The architecture is browser-as-brain, and that is a good default: the renderer
 * lives where the fonts, the canvas and the drawings are. But it has one failure
 * mode the wall cannot forgive — the laptop. A tab closes, a machine sleeps, a
 * cable is knocked, and the wall goes dark in the middle of a party with nothing
 * to fall back on (firmware's watchdog fades it to black in STALE_MS and stays
 * there).
 *
 * A baked show is the smallest thing that fixes that, and it is small precisely
 * because it does NOT port the renderer. The host does all of it — layout,
 * packing, the LED fine-tune — and writes out frames in the exact 1200-byte wire
 * order the frame protocol already carries. The device then only has to play
 * them, which is a file seek, a black frame and a per-byte lerp between two
 * frames it already has.
 *
 * That is also why the frames are CALIBRATED: `applyColor` has already run over
 * these bytes at bake time. A baked show is a photograph of the wall, not a
 * drawing of it, and §"The fingerprint" below is how that stays honest.
 *
 * THE FILE
 * --------
 *
 *   0..39         header, 40 bytes (see SHOW_OFF)
 *   40..          count * 1200 bytes, wire order: physical LED order, RGB
 *   end-4..end    u32 LE crc32 of every byte before it
 *
 * Frame payloads are byte-for-byte what `core/frame.js` puts on the wire
 * (OFFSET_RGB..): physical LED order, R,G,B, not the beads' B,G,R — the
 * firmware's renderWall() does that reorder for both paths, so a baked frame and
 * a streamed frame cannot disagree.
 *
 * A frame is 1200 bytes, so 100 drawings is 120 KB. The S3 has 16 MB of flash.
 * Size is not the constraint; the constraint is that a baked show is a snapshot.
 *
 * THE SLOT CLOCK
 * --------------
 * `showTiming()` is `galleryTiming()` (core/content-protocol.js) with the two
 * differences a device without a browser forces:
 *
 *   1. time is millis since playback started, not epoch seconds. A baked show is
 *      self-contained, so it does not need a shared clock — nothing else is
 *      watching it.
 *   2. the break is BLACK. A baked show carries no gap animation, so `gapAnim`
 *      is always 'none' and the seam at the end of a drawing fades into nothing.
 *
 * And one difference that is easy to miss and must not be:
 *
 *   3. the ROTATION is `slot % count`, which `content-protocol.js` bans in
 *      capitals. The ban is correct THERE and wrong HERE, and the distinction is
 *      the whole reason this file is allowed the arithmetic: a live gallery's
 *      roster MUTATES — a guest adds a drawing and every index into the list
 *      re-bases, which is the bug that made the wall skip seats and repeat
 *      drawings. A baked show's roster is a number in a file that nothing can
 *      change while it plays. There is no re-basing to get wrong. If this file
 *      ever grows a `setDrawings()`, the arithmetic has to go with it.
 *
 * No DOM, no fetch, no node built-ins: the baker, the tests and (later) an
 * in-page bake all run this exact module.
 */

import { RGB_BYTES } from './frame.js';
import { GRID } from './drawings.js';
import { COLOR_DEFAULTS } from './color.js';
import { LAYOUT_DEFAULTS } from './layout.js';

/** 'L','E','D','S'. Four ASCII bytes, so `head -c4` on the file is readable. */
export const SHOW_MAGIC = Object.freeze([0x4c, 0x45, 0x44, 0x53]);
export const SHOW_MAGIC_STR = 'LEDS';
export const SHOW_VERSION = 1;

/**
 * Header field offsets. Exported as an OBJECT rather than as a pile of
 * individual constants because the firmware has to count the same bytes, and one
 * table that both sides can be pinned against beats eight names that can drift
 * independently (see test/showfile.test.js, which reads firmware.ino and pins
 * these numbers against its literals).
 */
export const SHOW_OFF = Object.freeze({
  magic: 0,        // 4 bytes
  version: 4,      // u8
  flags: 5,        // u8   bit0 = frames are colour-tuned (applyColor ran)
  transition: 6,   // u8   TRANSITION_CODES
  reserved0: 7,    // u8   must be 0
  count: 8,        // u16 LE
  intervalSec: 10, // u16 LE  the drawing part of the slot, >= 1
  gapSec: 12,      // u16 LE  the break part, 0 = no break
  transitionMs: 14,// u16 LE  blend length at each seam, 0 = hard cut
  fingerprint: 16, // u32 LE  see calibrationFingerprint()
  brightness: 20,  // u8   the meta brightness this show was baked for
  reserved1: 21,   // u8   must be 0
  limitMa: 22,     // u16 LE  the power budget it was baked for
  worstMa: 24,     // u32 LE  worst-frame current of the whole show at `brightness`
  bodyBytes: 28,   // u32 LE  count * 1200, so truncation is caught before a read
  reserved2: 32,   // 8 bytes, must be 0
});

export const SHOW_HEADER_BYTES = 40;
export const SHOW_CRC_BYTES = 4;
export const SHOW_FRAME_BYTES = RGB_BYTES; // 1200
export const SHOW_FRAME_OFFSET = SHOW_HEADER_BYTES;

/** Header flag: the pixels carry the host's LED fine-tune. */
export const SHOW_FLAG_TUNED = 1;

/**
 * The transitions a BAKED show may use. Deliberately not TRANSITION_NAMES.
 *
 * `wipe`, `dissolve` and `slide` are directional and cell-ordered, and they live
 * in `core/transitions.js` where the whole grid is a JS array with a `.set()`.
 * On the device a transition is 1200 bytes of integer arithmetic per seam, and
 * two of them is the honest budget for step one. Rather than silently turning a
 * dissolve into a fade on the wall — which would look like a bug and pass every
 * test — the format refuses anything it cannot do, and the baker says so.
 */
export const TRANSITION_CODES = Object.freeze({ none: 0, fade: 1 });
export const TRANSITION_NAMES_BAKED = Object.freeze(['none', 'fade']);

/** The cadence a show uses when the baker is told "just the defaults". */
export const SHOW_DEFAULTS = Object.freeze({
  intervalSec: 8,
  gapSec: 5,
  transition: 'fade',
  transitionMs: 1000,
  brightness: 255,
  limitMa: 8000,
});

// ---------------------------------------------------------------------------
// crc32 (IEEE, reflected, the zlib polynomial)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * crc32(bytes, seed) -> u32, with `seed` letting a caller checksum a file in
 * pieces. The device does exactly that while an upload streams in, so the
 * transport check costs one pass it is already making.
 */
export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** FNV-1a 32 over a string — the fingerprint's mixer. Stable, tiny, no crypto. */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/**
 * calibrationFingerprint({layout, color}) -> u32
 *
 * A baked frame has TWO host-side transforms frozen into it, and only one of them
 * is obvious:
 *
 *   - the LED fine-tune (`applyColor`), which is the one everybody remembers;
 *   - the LAYOUT permutation (`buffer.pack`), which is the one that bites. A
 *     frame is in physical LED order, so if the strip wiring is re-measured and
 *     `core/layout.js`'s snake/flip/transpose flags change, every baked frame is
 *     now addressed to the wrong beads. That is not a colour cast, it is a
 *     scrambled picture, and no amount of calibration re-dialling fixes it.
 *
 * So the fingerprint covers both, canonically: layout fields in a fixed order,
 * `startOffsets` joined (it is an array, and JSON would let key order leak in),
 * and the five colour levers rounded to 1e-4 so a slider nudge at the 12th
 * decimal does not invalidate a gallery.
 *
 * The device cannot recompute this — it has no layout map and runs no colour
 * maths. It reports the number, and the console's number is the comparison. That
 * is a check a person makes, not a check the machine makes, and the plan says so
 * rather than pretending otherwise.
 */
export function calibrationFingerprint({ layout = LAYOUT_DEFAULTS, color = COLOR_DEFAULTS } = {}) {
  const l = { ...LAYOUT_DEFAULTS, ...layout };
  const c = { ...COLOR_DEFAULTS, ...color };
  const n = (v) => (Number.isFinite(v) ? Number(v).toFixed(4) : '0.0000');
  const canon = [
    `cols=${l.cols}`, `rows=${l.rows}`,
    `axis=${l.stripAxis}`, `len=${l.stripLength}`,
    `start=${Array.isArray(l.startOffsets) ? l.startOffsets.join(',') : '-'}`,
    `snake=${l.snake ? 1 : 0}`, `fx=${l.flipX ? 1 : 0}`, `fy=${l.flipY ? 1 : 0}`,
    `tr=${l.transpose ? 1 : 0}`,
    `sat=${n(c.saturation)}`, `gam=${n(c.gamma)}`,
    `temp=${n(c.temperature)}`, `tint=${n(c.tint)}`, `black=${n(c.blackLevel)}`,
  ].join(';');
  return fnv1a32(canon);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function checkInt(name, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new RangeError(`show: ${name} must be an integer in ${lo}..${hi}, got ${v}`);
  }
}

/**
 * showBytes({frames, ...}) -> Uint8Array, the whole file.
 *
 * Throws rather than clamping, on purpose: a bake is a deliberate act with a
 * human watching the summary line, so a bad cadence must be an error at the
 * keyboard, not a silently different show on the wall. (Contrast
 * `galleryTiming`, which clamps because it must never throw mid-frame.)
 */
export function showBytes({
  frames,
  intervalSec = SHOW_DEFAULTS.intervalSec,
  gapSec = SHOW_DEFAULTS.gapSec,
  transition = SHOW_DEFAULTS.transition,
  transitionMs = SHOW_DEFAULTS.transitionMs,
  brightness = SHOW_DEFAULTS.brightness,
  limitMa = SHOW_DEFAULTS.limitMa,
  worstMa = 0,
  fingerprint = 0,
  tuned = true,
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new RangeError('show: needs at least one frame');
  }
  checkInt('count', frames.length, 1, 0xffff);
  checkInt('intervalSec', intervalSec, 1, 0xffff);
  checkInt('gapSec', gapSec, 0, 0xffff);
  checkInt('transitionMs', transitionMs, 0, 0xffff);
  checkInt('brightness', brightness, 0, 255);
  checkInt('limitMa', limitMa, 0, 0xffff);
  if (!Number.isInteger(worstMa) || worstMa < 0 || worstMa > 0xffffffff) {
    throw new RangeError(`show: worstMa must be a u32, got ${worstMa}`);
  }
  if (!Object.hasOwn(TRANSITION_CODES, transition)) {
    throw new RangeError(
      `show: transition "${transition}" cannot be baked; a device plays ${TRANSITION_NAMES_BAKED.join(' or ')}`,
    );
  }
  for (const f of frames) {
    if (!(f instanceof Uint8Array)) {
      throw new RangeError(`show: every frame must be a Uint8Array, got ${typeof f}`);
    }
    if (f.length !== SHOW_FRAME_BYTES) {
      throw new RangeError(`show: every frame must be ${SHOW_FRAME_BYTES} bytes, got ${f.length}`);
    }
  }

  const bodyBytes = frames.length * SHOW_FRAME_BYTES;
  const out = new Uint8Array(SHOW_HEADER_BYTES + bodyBytes + SHOW_CRC_BYTES);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(SHOW_MAGIC, SHOW_OFF.magic);
  out[SHOW_OFF.version] = SHOW_VERSION;
  out[SHOW_OFF.flags] = tuned ? SHOW_FLAG_TUNED : 0;
  out[SHOW_OFF.transition] = TRANSITION_CODES[transition];
  out[SHOW_OFF.reserved0] = 0;
  dv.setUint16(SHOW_OFF.count, frames.length, true);
  dv.setUint16(SHOW_OFF.intervalSec, intervalSec, true);
  dv.setUint16(SHOW_OFF.gapSec, gapSec, true);
  dv.setUint16(SHOW_OFF.transitionMs, transitionMs, true);
  dv.setUint32(SHOW_OFF.fingerprint, fingerprint >>> 0, true);
  out[SHOW_OFF.brightness] = brightness;
  out[SHOW_OFF.reserved1] = 0;
  dv.setUint16(SHOW_OFF.limitMa, limitMa, true);
  dv.setUint32(SHOW_OFF.worstMa, worstMa >>> 0, true);
  dv.setUint32(SHOW_OFF.bodyBytes, bodyBytes, true);
  // reserved2 stays zero: it is the only field a future version can grow into
  // without moving anything, and a non-zero there is how a reader would know.

  let at = SHOW_HEADER_BYTES;
  for (const f of frames) {
    out.set(f, at);
    at += SHOW_FRAME_BYTES;
  }
  dv.setUint32(at, crc32(out.subarray(0, at)), true);
  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * parseShow(bytes) -> {header, frames} or null.
 *
 * Tolerant of nothing and trusted by nobody: this is the gate the firmware's
 * loader mirrors, and every check here is one the device cannot skip either. It
 * returns null rather than throwing because the only caller that matters is a
 * boot path, and a wall that refuses to start because of a bad file is worse
 * than a wall that starts dark and says why.
 */
export function parseShow(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length < SHOW_HEADER_BYTES + SHOW_CRC_BYTES) return null;
  for (let i = 0; i < SHOW_MAGIC.length; i++) if (bytes[i] !== SHOW_MAGIC[i]) return null;
  if (bytes[SHOW_OFF.version] !== SHOW_VERSION) return null;
  if (bytes[SHOW_OFF.reserved0] !== 0 || bytes[SHOW_OFF.reserved1] !== 0) return null;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(SHOW_OFF.count, true);
  const bodyBytes = dv.getUint32(SHOW_OFF.bodyBytes, true);
  const intervalSec = dv.getUint16(SHOW_OFF.intervalSec, true);
  const gapSec = dv.getUint16(SHOW_OFF.gapSec, true);
  const transitionMs = dv.getUint16(SHOW_OFF.transitionMs, true);
  const transitionCode = bytes[SHOW_OFF.transition];

  if (count === 0) return null;
  if (intervalSec < 1) return null;
  if (bodyBytes !== count * SHOW_FRAME_BYTES) return null;
  if (bytes.length !== SHOW_HEADER_BYTES + bodyBytes + SHOW_CRC_BYTES) return null;
  const code = TRANSITION_NAMES_BAKED[transitionCode];
  if (code === undefined) return null;

  const crcAt = SHOW_HEADER_BYTES + bodyBytes;
  if (dv.getUint32(crcAt, true) !== crc32(bytes.subarray(0, crcAt))) return null;

  const frames = [];
  for (let i = 0; i < count; i++) {
    const at = SHOW_HEADER_BYTES + i * SHOW_FRAME_BYTES;
    frames.push(bytes.slice(at, at + SHOW_FRAME_BYTES));
  }

  return {
    header: {
      version: SHOW_VERSION,
      flags: bytes[SHOW_OFF.flags],
      tuned: (bytes[SHOW_OFF.flags] & SHOW_FLAG_TUNED) !== 0,
      transition: code,
      count,
      intervalSec,
      gapSec,
      transitionMs,
      fingerprint: dv.getUint32(SHOW_OFF.fingerprint, true),
      brightness: bytes[SHOW_OFF.brightness],
      limitMa: dv.getUint16(SHOW_OFF.limitMa, true),
      worstMa: dv.getUint32(SHOW_OFF.worstMa, true),
      bodyBytes,
      fileBytes: bytes.length,
    },
    frames,
  };
}

/** One line about what a show is, for a bake summary or a boot banner. */
export function describeShow(header) {
  return `${header.count} drawings, ${header.intervalSec}s + ${header.gapSec}s break, `
    + `${header.transition} ${header.transitionMs}ms, ${header.brightness}/255, `
    + `${header.limitMa}mA limit, worst ${header.worstMa}mA, fp ${header.fingerprint}`;
}

// ---------------------------------------------------------------------------
// The slot clock
// ---------------------------------------------------------------------------

/** Slot length in ms: the drawing plus its break. */
export function showPeriodMs(header) {
  return (Math.max(1, header.intervalSec) + Math.max(0, header.gapSec)) * 1000;
}

/**
 * The blend length actually used, clamped exactly as `galleryTiming` clamps it:
 * to half the drawing minus a quarter second, so both seams fit inside the part
 * of the slot they belong to and finish before the other one starts.
 */
export function showBlendMs(header) {
  const showMs = Math.max(1, header.intervalSec) * 1000;
  return Math.max(0, Math.min(header.transitionMs, Math.floor((showMs - 250) / 2)));
}

/**
 * showTiming(elapsedMs, header) -> {kind, idx, prevIdx, from, k}
 *
 * WHERE the show is. `kind` is what the slot is showing right now ('drawing' or
 * 'break'), `idx` is the drawing of THIS slot (meaningful even during a break,
 * because the break between two drawings belongs to the slot it follows), `from`
 * is the other side of the blend and `k` is 0..1 progress toward `kind`.
 *
 * Both seams open, for the same reason `galleryTiming` opens both: a cycle that
 * is soft at one boundary and hard at the next reads as a fault, and the eye
 * finds it immediately even when it cannot name it.
 */
export function showTiming(elapsedMs, header) {
  const showMs = Math.max(1, header.intervalSec) * 1000;
  const gapMs = Math.max(0, header.gapSec) * 1000;
  const period = showMs + gapMs;
  const count = Math.max(1, header.count);
  const e = Math.max(0, Math.floor(elapsedMs));

  const slot = Math.floor(e / period);
  const phase = e - slot * period;
  const idx = ((slot % count) + count) % count;
  const prevIdx = (idx + count - 1) % count;
  const trans = showBlendMs(header);

  // The break proper: nothing to paint but black.
  if (gapMs > 0 && phase >= showMs) return { kind: 'break', idx, prevIdx, from: null, k: 0 };
  if (trans <= 0) return { kind: 'drawing', idx, prevIdx, from: null, k: 0 };

  // Opening seam: from the break if there is one, otherwise from the previous
  // drawing. `from: 'black'` and `from: 'prev'` are what the renderer resolves.
  if (phase < trans) {
    return {
      kind: 'drawing', idx, prevIdx,
      from: gapMs > 0 ? 'black' : 'prev',
      k: phase / trans,
    };
  }

  // Closing seam: this slot's own break is the target, and the drawing is what
  // the wall is leaving — so `kind` is the break and `k` runs toward black.
  if (gapMs > 0 && phase >= showMs - trans) {
    return { kind: 'break', idx, prevIdx, from: 'drawing', k: (phase - (showMs - trans)) / trans };
  }

  return { kind: 'drawing', idx, prevIdx, from: null, k: 0 };
}

const BLACK_FRAME = new Uint8Array(SHOW_FRAME_BYTES);

/**
 * showFrameAt(show, elapsedMs) -> 1200 wire-order bytes.
 *
 * The reference renderer: what the device's `localCompose()` must paint, at the
 * same instant. It exists so the timing and the blend can be tested in Node —
 * the firmware's arithmetic is three integer lines and this is the thing they
 * are checked against, the way `core/frame.js` is what the decoder is checked
 * against.
 *
 * Integer math throughout, matching the device: a blend is
 * `from + (to - from) * k >> 8` with k in 0..256, because the S3's float unit is
 * fine but the equality is easier to believe when neither side has a rounding
 * mode to differ about. `k` is the FLOOR of `k*256`, not the nearest: the
 * firmware computes it as `(phase * 256) / trans` in unsigned integers, which
 * truncates, and a reference renderer that rounded would disagree with the wall
 * on the one frame in eight where the two rules land either side of a boundary.
 */
export function showFrameAt(show, elapsedMs) {
  const tm = showTiming(elapsedMs, show.header);
  const cur = show.frames[tm.idx] ?? BLACK_FRAME;
  const to = tm.kind === 'break' ? BLACK_FRAME : cur;
  if (tm.from === null) return to.slice();

  const from = tm.from === 'black' ? BLACK_FRAME
    : tm.from === 'prev' ? (show.frames[tm.prevIdx] ?? BLACK_FRAME)
      : cur;

  const k = Math.floor(Math.max(0, Math.min(1, tm.k)) * 256);
  const out = new Uint8Array(SHOW_FRAME_BYTES);
  for (let i = 0; i < SHOW_FRAME_BYTES; i++) {
    out[i] = (from[i] + (((to[i] - from[i]) * k) >> 8)) | 0;
  }
  return out;
}

/** GRID is re-exported so a caller building frames does not import two modules. */
export { GRID };

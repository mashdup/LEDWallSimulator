/**
 * showfile.test.js — the `.ledshow` format, and the pin between it and the
 * firmware's player.
 *
 * Two jobs, and the second is the one worth having:
 *
 *   1. the format is a gate: a corrupt, truncated, or impossible file is refused
 *      whole, never half-played. Every check here is one the device also makes,
 *      so a file that passes in Node and fails on the wall means the two lists
 *      have drifted — which is what job 2 is for.
 *
 *   2. the firmware is text, and nothing else connects it to `core/showfile.js`.
 *      This is the same trick test/calibration.test.js plays on the self-test:
 *      read `firmware/firmware.ino` as a string and pin the literals the boot
 *      loader depends on (the magic bytes, the header offsets, the version, the
 *      transition codes) against the exported JS constants. No compile, no
 *      flash, no shell — a future edit to either side fails here instead of
 *      quietly reading a gallery out of the wrong byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SHOW_MAGIC,
  SHOW_MAGIC_STR,
  SHOW_VERSION,
  SHOW_OFF,
  SHOW_HEADER_BYTES,
  SHOW_CRC_BYTES,
  SHOW_FRAME_BYTES,
  SHOW_FLAG_TUNED,
  SHOW_DEFAULTS,
  TRANSITION_CODES,
  TRANSITION_NAMES_BAKED,
  crc32,
  fnv1a32,
  calibrationFingerprint,
  showBytes,
  parseShow,
  describeShow,
  showPeriodMs,
  showBlendMs,
  showTiming,
  showFrameAt,
} from '../core/showfile.js';
import { RGB_BYTES } from '../core/frame.js';
import { LAYOUT_DEFAULTS } from '../core/layout.js';
import { COLOR_DEFAULTS } from '../core/color.js';

const FIRMWARE = readFileSync(new URL('../firmware/firmware.ino', import.meta.url), 'utf8');

/** `n` distinct frames, so a blend between two of them is visible in the bytes. */
function frames(n, seed = 1) {
  const out = [];
  for (let f = 0; f < n; f++) {
    const b = new Uint8Array(SHOW_FRAME_BYTES);
    for (let i = 0; i < b.length; i++) b[i] = (i + f * 37 + seed) & 0xff;
    out.push(b);
  }
  return out;
}

const solid = (v) => Uint8Array.from({ length: SHOW_FRAME_BYTES }, () => v);

function build(opts = {}) {
  return showBytes({ frames: frames(3), ...opts });
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

test('layout is the protocol payload, plus a header and a crc', () => {
  assert.equal(SHOW_FRAME_BYTES, RGB_BYTES, 'a baked frame is a frame payload');
  const file = build({ intervalSec: 8, gapSec: 5, transitionMs: 1000 });
  assert.equal(file.length, SHOW_HEADER_BYTES + 3 * SHOW_FRAME_BYTES + SHOW_CRC_BYTES);
  // The magic is readable as ASCII, which is the whole point of choosing it.
  assert.equal(SHOW_MAGIC_STR, String.fromCharCode(...SHOW_MAGIC));
  assert.equal(String.fromCharCode(...file.subarray(0, 4)), 'LEDS');
});

test('a show round-trips: header and every frame byte-identical', () => {
  const source = frames(4);
  const file = showBytes({
    frames: source,
    intervalSec: 6,
    gapSec: 2,
    transition: 'fade',
    transitionMs: 750,
    brightness: 180,
    limitMa: 6000,
    worstMa: 4200,
    fingerprint: 0xdeadbeef,
  });
  const show = parseShow(file);
  assert.notEqual(show, null);
  assert.equal(show.header.count, 4);
  assert.equal(show.header.intervalSec, 6);
  assert.equal(show.header.gapSec, 2);
  assert.equal(show.header.transition, 'fade');
  assert.equal(show.header.transitionMs, 750);
  assert.equal(show.header.brightness, 180);
  assert.equal(show.header.limitMa, 6000);
  assert.equal(show.header.worstMa, 4200);
  assert.equal(show.header.fingerprint, 0xdeadbeef);
  assert.equal(show.header.tuned, true);
  assert.equal(show.header.bodyBytes, 4 * SHOW_FRAME_BYTES);
  for (let i = 0; i < source.length; i++) {
    assert.deepEqual([...show.frames[i]], [...source[i]], `frame ${i}`);
  }
});

test('the parsed frames are the packed payloads, in wire order, untouched', () => {
  // Not "close": a bake is only worth anything if what comes out of the file is
  // byte-for-byte what the frame encoder would have put on the wire.
  const seen = [0, 200, 17, 255];
  const file = build({ frames: seen.map(solid) });
  const show = parseShow(file);
  assert.deepEqual(show.frames.map((f) => f[0]), seen);
  assert.equal(show.frames[0].length, RGB_BYTES);
});

test('the crc covers the header as well as the frames', () => {
  const file = build();
  const at = file.length - SHOW_CRC_BYTES;
  const stored = new DataView(file.buffer, file.byteOffset).getUint32(at, true);
  assert.equal(stored, crc32(file.subarray(0, at)));
  // A single flipped bit anywhere — header or payload — breaks it.
  const dirty = file.slice();
  dirty[SHOW_OFF.intervalSec] ^= 0x01;
  assert.equal(parseShow(dirty), null);
  const dirtyFrame = file.slice();
  dirtyFrame[SHOW_HEADER_BYTES + 500] ^= 0x80;
  assert.equal(parseShow(dirtyFrame), null);
});

test('a truncated file is refused, not played short', () => {
  const file = build();
  assert.equal(parseShow(file.subarray(0, file.length - 1)), null, 'one byte short');
  assert.equal(parseShow(file.subarray(0, SHOW_HEADER_BYTES + 100)), null, 'mid-frame');
  assert.equal(parseShow(file.subarray(0, SHOW_HEADER_BYTES)), null, 'header only');
  assert.equal(parseShow(new Uint8Array(0)), null, 'empty');
  assert.equal(parseShow('not bytes'), null, 'not a buffer');
});

test('the header cannot lie about the body', () => {
  const file = build();
  const dv = new DataView(file.buffer, file.byteOffset);
  // bodyBytes says 4 frames, count says 3: refused even though the crc is fixed
  // up afterwards, because the two fields disagree and no reader can pick one.
  const lie = file.slice();
  new DataView(lie.buffer, lie.byteOffset).setUint32(SHOW_OFF.bodyBytes, 4 * SHOW_FRAME_BYTES, true);
  const at = lie.length - SHOW_CRC_BYTES;
  new DataView(lie.buffer, lie.byteOffset).setUint32(at, crc32(lie.subarray(0, at)), true);
  assert.equal(parseShow(lie), null);
  assert.equal(dv.getUint32(SHOW_OFF.bodyBytes, true), 3 * SHOW_FRAME_BYTES);
});

test('an impossible version, magic or transition code is refused', () => {
  const forEachMutation = (fn) => {
    const file = build();
    fn(file, new DataView(file.buffer, file.byteOffset));
    const at = file.length - SHOW_CRC_BYTES;
    new DataView(file.buffer, file.byteOffset).setUint32(at, crc32(file.subarray(0, at)), true);
    return parseShow(file);
  };
  assert.equal(forEachMutation((f) => { f[0] = 0x4e; }), null, 'magic');
  assert.equal(forEachMutation((f) => { f[SHOW_OFF.version] = 2; }), null, 'version');
  assert.equal(forEachMutation((f) => { f[SHOW_OFF.reserved0] = 1; }), null, 'reserved');
  assert.equal(forEachMutation((f) => { f[SHOW_OFF.transition] = 4; }), null, 'transition code');
  assert.equal(forEachMutation((f, dv) => { dv.setUint16(SHOW_OFF.intervalSec, 0, true); }), null, 'zero interval');
  assert.equal(forEachMutation((f, dv) => { dv.setUint16(SHOW_OFF.count, 0, true); }), null, 'no drawings');
});

test('the baker refuses what the device cannot play', () => {
  // Silent degradation is the failure this prevents: a dissolve that becomes a
  // fade on the wall would look like a bug and pass every other test here.
  for (const t of ['wipe', 'dissolve', 'slide', 'nope']) {
    assert.throws(() => showBytes({ frames: frames(1), transition: t }), /cannot be baked/);
  }
  assert.deepEqual([...TRANSITION_NAMES_BAKED], ['none', 'fade']);
  assert.equal(TRANSITION_CODES.none, 0);
  assert.equal(TRANSITION_CODES.fade, 1);
});

test('the baker refuses an empty show, a short frame, and a bad cadence', () => {
  assert.throws(() => showBytes({ frames: [] }), /at least one frame/);
  assert.throws(() => showBytes({ frames: [new Uint8Array(10)] }), /1200 bytes/);
  assert.throws(() => showBytes({ frames: [new Array(1200).fill(0)] }), /must be a Uint8Array/);
  assert.throws(() => showBytes({ frames: frames(1), intervalSec: 0 }), /intervalSec/);
  assert.throws(() => showBytes({ frames: frames(1), gapSec: -1 }), /gapSec/);
  assert.throws(() => showBytes({ frames: frames(1), brightness: 256 }), /brightness/);
});

test('describeShow says the things a person needs before flashing', () => {
  const show = parseShow(build({ brightness: 200, limitMa: 9000, worstMa: 8800 }));
  const line = describeShow(show.header);
  // One line, because it is read at a keyboard before a flash and then again in
  // the device's boot banner: the count, the cadence, the brightness and budget
  // it was baked for, and the fingerprint to compare against the console.
  assert.equal(line, '3 drawings, 8s + 5s break, fade 1000ms, 200/255, 9000mA limit, worst 8800mA, fp 0');
});

test('crc32 and fnv1a32 are the published values', () => {
  // Golden values, so a rewrite of either mixer cannot quietly change every
  // fingerprint (and therefore invalidate every gallery already on a wall).
  const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  // Seeded CRC is the same function continued, which is how an upload checksums
  // a file in pieces without buffering it.
  assert.equal(crc32(ascii('56789'), crc32(ascii('1234'))), crc32(ascii('123456789')));
});

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

test('the fingerprint follows the wall, and only the wall', () => {
  const base = calibrationFingerprint();

  // The LED fine-tune is frozen into the pixels.
  for (const [k, v] of [['saturation', 1.2], ['gamma', 2], ['temperature', 0.3], ['tint', -0.2], ['blackLevel', 12]]) {
    assert.notEqual(calibrationFingerprint({ color: { ...COLOR_DEFAULTS, [k]: v } }), base, k);
  }

  // And so is the LAYOUT, which is the one that is easy to forget: a re-measured
  // snake or transpose flag re-addresses every baked frame to the wrong beads.
  for (const [k, v] of [['snake', true], ['flipX', true], ['flipY', true], ['transpose', true]]) {
    assert.notEqual(calibrationFingerprint({ layout: { ...LAYOUT_DEFAULTS, [k]: v } }), base, k);
  }
  assert.notEqual(
    calibrationFingerprint({ layout: { ...LAYOUT_DEFAULTS, startOffsets: [0, 20, 40] } }),
    base,
    'strip start offsets',
  );

  // Stable: default args, an explicit copy, and a copy with shuffled keys are
  // the same wall, so they must be the same number.
  assert.equal(calibrationFingerprint({}), base);
  assert.equal(calibrationFingerprint({ color: { ...COLOR_DEFAULTS } }), base);
  const shuffled = { blackLevel: 0, tint: 0, temperature: 0, gamma: 1, saturation: 1 };
  assert.equal(calibrationFingerprint({ color: shuffled }), base);

  // And a nudge below the rounding band is not a different wall: a slider that
  // lands on 1.0000000001 must not invalidate every gallery on the wall.
  assert.equal(calibrationFingerprint({ color: { ...COLOR_DEFAULTS, saturation: 1 + 1e-9 } }), base);
});

// ---------------------------------------------------------------------------
// The slot clock
// ---------------------------------------------------------------------------

const H = (over = {}) => ({ count: 3, intervalSec: 8, gapSec: 5, transitionMs: 1000, ...over });

test('a slot is the drawing plus its break', () => {
  assert.equal(showPeriodMs(H()), 13_000);
  assert.equal(showPeriodMs(H({ gapSec: 0 })), 8_000);
});

test('the blend is clamped to half the drawing, as galleryTiming clamps it', () => {
  // Deliberately the same rule as core/content-protocol.js: two blends that fit
  // inside the part of the slot they belong to, and no overlap at the boundary.
  assert.equal(showBlendMs(H({ transitionMs: 1000 })), 1000);
  assert.equal(showBlendMs(H({ transitionMs: 60_000 })), Math.floor((8000 - 250) / 2));
  assert.equal(showBlendMs(H({ intervalSec: 1, transitionMs: 5000 })), 375);
  assert.equal(showBlendMs(H({ transitionMs: 0 })), 0);
});

test('the show walks its slots and wraps, and the wrap is not a re-base', () => {
  const h = H();
  const at = (ms) => showTiming(ms, h);
  assert.equal(at(0).idx, 0);
  assert.equal(at(7000).idx, 0, 'still the first drawing');
  assert.equal(at(14_000).idx, 1, 'second slot');
  assert.equal(at(27_000).idx, 2, 'third slot');
  assert.equal(at(40_000).idx, 0, 'wraps to the first');
  assert.equal(at(40_000).prevIdx, 2, 'and remembers what it came from');
  /* A NEGATIVE elapsed time is clamped to the start of the show, not wrapped:
   * millis() minus a start stamp cannot be negative on the device (the stamp is
   * taken at a start that has already happened), so the only thing a negative
   * input can mean is a caller's arithmetic error — and the top of the show is
   * the safe answer for it. This differs from galleryTiming, which wraps because
   * a shared epoch clock genuinely can be skewed. */
  assert.equal(at(-1).idx, 0);
  assert.equal(at(0.9).idx, 0);
});

test('both seams open, and neither runs past its boundary', () => {
  const h = H();
  // Opening seam: black -> drawing, k 0..1 over the first 1000 ms.
  const open0 = showTiming(0, h);
  assert.deepEqual([open0.kind, open0.from, open0.k], ['drawing', 'black', 0]);
  const openMid = showTiming(500, h);
  assert.equal(openMid.from, 'black');
  assert.equal(openMid.k, 0.5);
  // The middle of the drawing is a hard answer with no blend.
  assert.deepEqual([showTiming(4000, h).kind, showTiming(4000, h).from], ['drawing', null]);
  // Closing seam: drawing -> black, k 0..1 over the last 1000 ms of the drawing.
  const close0 = showTiming(7000, h);
  assert.deepEqual([close0.kind, close0.from, close0.k], ['break', 'drawing', 0]);
  assert.equal(showTiming(7500, h).k, 0.5);
  // The break proper.
  assert.deepEqual([showTiming(9000, h).kind, showTiming(9000, h).from], ['break', null]);
  assert.deepEqual([showTiming(12_999, h).kind, showTiming(12_999, h).from], ['break', null]);
});

test('with no gap, the seam blends the previous drawing instead of black', () => {
  const h = H({ gapSec: 0, transitionMs: 1000 });
  const seam = showTiming(8000 + 500, h);
  assert.equal(seam.idx, 1);
  assert.equal(seam.prevIdx, 0);
  assert.equal(seam.from, 'prev');
  assert.equal(seam.k, 0.5);
});

test('a hard cut has no partial frame at all', () => {
  const h = H({ transitionMs: 0 });
  for (const ms of [0, 1, 7999, 8000, 8001, 12_999]) {
    const tm = showTiming(ms, h);
    assert.equal(tm.from, null, `t=${ms}`);
    assert.equal(tm.k, 0, `t=${ms}`);
  }
});

// ---------------------------------------------------------------------------
// The reference renderer
// ---------------------------------------------------------------------------

test('the frame at a seam is between its two sides, and lands exactly on them', () => {
  const h = H({ gapSec: 5, transitionMs: 1000 });
  const show = { header: h, frames: [solid(200), solid(40), solid(0)] };

  // At k=0 from black: the drawing is not on the wall yet.
  assert.equal(showFrameAt(show, 0)[0], 0);
  // Halfway into the opening seam: exactly half of 200.
  assert.equal(showFrameAt(show, 500)[0], 100);
  assert.equal(showFrameAt(show, 1000)[0], 200, 'k=1 lands on the drawing, byte for byte');
  // The drawing mid-slot is the drawing, untouched.
  assert.deepEqual([...showFrameAt(show, 4000)], [...show.frames[0]]);
  // Halfway out, and then black.
  assert.equal(showFrameAt(show, 7500)[0], 100);
  assert.equal(showFrameAt(show, 8000)[0], 0);
  assert.equal(showFrameAt(show, 10_000)[0], 0, 'the break is black');
});

test('the renderer is a pure function of the clock', () => {
  const h = H();
  const show = { header: h, frames: frames(3) };
  for (const ms of [0, 250, 999, 1000, 5000, 7000, 7500, 8500, 13_000, 26_500, 999_999]) {
    assert.deepEqual([...showFrameAt(show, ms)], [...showFrameAt(show, ms)], `t=${ms}`);
  }
});

test('a blend between two real drawings is arithmetic, not a fade to grey', () => {
  const a = solid(0);
  const b = solid(255);
  const h = H({ gapSec: 0, transitionMs: 1000 });
  const show = { header: h, frames: [a, b] };
  // The seam at 8000..9000 blends a -> b, so the middle is 128 in every channel
  // and the ends are the two drawings themselves.
  assert.equal(showFrameAt(show, 8000)[0], 0);
  // 255 * 128 >> 8 is 127, not 128: the blend floors, and both sides floor the
  // same way. The asymmetry is invisible on the wall and it is what makes the
  // firmware's integer arithmetic checkable against this one.
  assert.equal(showFrameAt(show, 8500)[0], 127);
  assert.equal(showFrameAt(show, 9000)[0], 255);
});

// ---------------------------------------------------------------------------
// The pin to the firmware
// ---------------------------------------------------------------------------

test('the firmware counts the same header the format defines', () => {
  // Each of these is a number the boot loader indexes with. If one moves here
  // and not there, the wall reads a gallery out of the middle of a colour.
  const pins = {
    SHOW_OFF_COUNT: SHOW_OFF.count,
    SHOW_OFF_INTERVAL: SHOW_OFF.intervalSec,
    SHOW_OFF_GAP: SHOW_OFF.gapSec,
    SHOW_OFF_TRANSITION_MS: SHOW_OFF.transitionMs,
    SHOW_OFF_FINGERPRINT: SHOW_OFF.fingerprint,
    SHOW_OFF_BRIGHTNESS: SHOW_OFF.brightness,
    SHOW_OFF_LIMIT: SHOW_OFF.limitMa,
    SHOW_OFF_WORST: SHOW_OFF.worstMa,
    SHOW_OFF_BODY: SHOW_OFF.bodyBytes,
    SHOW_OFF_VERSION: SHOW_OFF.version,
    SHOW_OFF_FLAGS: SHOW_OFF.flags,
    SHOW_OFF_TRANSITION: SHOW_OFF.transition,
  };
  for (const [name, value] of Object.entries(pins)) {
    // Anchored on the NAME, which already carries its SHOW_OFF_ prefix, and on a
    // word boundary after the value so `SHOW_OFF_GAP = 12` cannot be satisfied by
    // a longer name that merely starts the same way.
    const m = new RegExp(`\\b${name}\\s*=\\s*${value}\\b`);
    assert.match(FIRMWARE, m, `firmware must define ${name} = ${value}`);
  }
  assert.match(FIRMWARE, new RegExp(`SHOW_HEADER_BYTES\\s*=\\s*${SHOW_HEADER_BYTES}\\b`));
  assert.match(FIRMWARE, new RegExp(`SHOW_CRC_BYTES\\s*=\\s*${SHOW_CRC_BYTES}\\b`));
  assert.match(FIRMWARE, new RegExp(`SHOW_VERSION\\s*=\\s*${SHOW_VERSION}\\b`));
  assert.match(FIRMWARE, new RegExp(`SHOW_MAGIC_STR\\s+"${SHOW_MAGIC_STR}"`), 'the long magic');
  assert.match(FIRMWARE, /SHOW_MAGIC_BYTES\[\]\s*=\s*\{\s*0x4c\s*,\s*0x45\s*,\s*0x44\s*,\s*0x53\s*\}/);
});

test('the firmware plays the same two transitions, at the same codes', () => {
  assert.match(FIRMWARE, new RegExp(`SHOW_TRANSITION_NONE\\s*=\\s*${TRANSITION_CODES.none}\\b`));
  assert.match(FIRMWARE, new RegExp(`SHOW_TRANSITION_FADE\\s*=\\s*${TRANSITION_CODES.fade}\\b`));
  // And has no third: a code the device cannot honour must not exist to be sent.
  assert.equal(TRANSITION_NAMES_BAKED.length, 2);
});

test('the firmware clamps the blend with the same arithmetic', () => {
  // (showMs - 250) / 2, in integer milliseconds. The constants are pinned by
  // name because the reason for the 250 is a comment, not something a test can
  // recover if someone "simplifies" it.
  assert.match(FIRMWARE, /SHOW_BLEND_GUARD_MS\s*=\s*250\b/);
  assert.match(FIRMWARE, /SHOW_BLEND_DIV\s*=\s*2\b/);
});

test('the firmware never regrows a derived index into a mutable roster', () => {
  // The device is allowed `slot % count` ONLY because a baked file is immutable.
  // content-protocol.js bans the same arithmetic for a live gallery, and the
  // moment the firmware grows a way to change the roster the two rules collide.
  assert.match(FIRMWARE, /SHOW IS IMMUTABLE/);
});

test('the default cadence in the format is the gallery default', () => {
  // SHOW_DEFAULTS is what the baker uses when told nothing, and it exists so a
  // baked show looks like the live gallery it replaces: 8 s + 5 s, fade 1 s.
  assert.equal(SHOW_DEFAULTS.intervalSec, 8);
  assert.equal(SHOW_DEFAULTS.gapSec, 5);
  assert.equal(SHOW_DEFAULTS.transition, 'fade');
  assert.equal(SHOW_DEFAULTS.transitionMs, 1000);
});

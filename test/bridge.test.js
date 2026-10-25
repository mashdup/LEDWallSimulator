import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frame, meta, LED_COUNT, RGB_BYTES } from '../core/frame.js';
import { WS2812_CHANNEL_MA } from '../core/power.js';
import { Layout, identity } from '../core/layout.js';
import { calibrationPhysicalBytes } from '../core/calibration.js';
import { findChrome } from '../tools/capture.js';
import { startServe, freePort } from './harness.js';
import { bars, W, H } from '../web/anim-400.js';
import {
  VirtualWall,
  VirtualTransport,
  WallDriver,
  verify,
  parseStatusLine,
  parseSelftestLine,
  parseLayoutFlags,
  maxBrightnessForLimit,
  fullWhiteMa,
  estimateFrameMa,
  STATIC_REFRESH_MS,
  scaleChannel,
  patternSource,
  pageSource,
  asciiPreview,
  main,
  parseArgs,
  RX,
  WALL,
  DdpTransport,
} from '../tools/bridge.js';

/**
 * tools/bridge.js — the host-side driver and the device model it drives.
 *
 * The bridge exists so milestone 5 (calibrate the wiring against a real panel) can
 * be rehearsed with no board in the room, which only holds if the JS device behaves
 * like firmware/firmware.ino. test/calibration.test.js already pins the sketch's
 * constants against core/, so what is left to pin here is the behaviour those
 * constants produce: the guard's arithmetic, the decoder's refusal to show a broken
 * frame, the in-flight bound, and the source -> driver -> transport -> device
 * pipeline running end to end on a virtual clock.
 */

/** magic, seq, 1200 payload, end */
const END_INDEX = RGB_BYTES + 2;

/** A wall bright enough that pixel assertions are not pre-dimmed by the guard. */
function brightWall(opts = {}) {
  return new VirtualWall({ limitMa: 24000, ...opts });
}

test('the scripted verify scenario passes every phase', async () => {
  const lines = [];
  const { ok, phases, wall } = await verify({ log: (line) => lines.push(line) });

  assert.ok(ok, `verify failed: ${phases.filter((p) => !p.pass).map((p) => p.name).join(', ')}`);
  // Nine phases is the scenario: self-test takeover, host takeover, power guard,
  // clean stream, dropped byte, truncated frame, watchdog fade, resume, status line.
  assert.equal(phases.length, 9, 'verify is a fixed scenario; a phase quietly disappearing is a regression');
  assert.ok(phases.every((p) => p.pass));
  assert.equal(wall.stats.discarded, 2, 'the scenario injects exactly two broken records');
  assert.equal(wall.stats.rewinds, 1, 'exactly one of them is salvageable by a rewind');
  assert.ok(lines.some((line) => line.includes('selftest: ALL_RED')), 'the self-test must announce itself');
});

test('the power guard allows the brightest brightness that still fits the limit', () => {
  for (const limit of [1, 500, 4000, 8000, 12000, 24000]) {
    const cap = maxBrightnessForLimit(limit);
    assert.ok(cap >= 0 && cap <= 255, `cap out of range at ${limit}mA: ${cap}`);
    assert.ok(fullWhiteMa(cap) <= limit, `cap=${cap} at ${limit}mA draws ${fullWhiteMa(cap)}mA, over the limit`);
    if (cap < 255) {
      assert.ok(
        fullWhiteMa(cap + 1) > limit,
        `cap=${cap} at ${limit}mA is not the tightest safe value: ${cap + 1} also fits`,
      );
    }
  }

  // Full white on 400 LEDs is plan.md's 12 A figure, and it is the only limit that
  // lets brightness reach 255.
  assert.equal(fullWhiteMa(255), LED_COUNT * 3 * WS2812_CHANNEL_MA);
  assert.equal(maxBrightnessForLimit(fullWhiteMa(255)), 255);
  assert.equal(maxBrightnessForLimit(fullWhiteMa(255) - 1), 254);
});

test('the guard clamps the declared brightness, and the clamp reaches the pixels', () => {
  const wall = brightWall({ limitMa: 4000 });
  wall.push(meta({ brightness: 255, limitMa: 4000 }));
  wall.push(frame(0, new Uint8Array(RGB_BYTES).fill(255)));
  wall.run(20);

  const cap = maxBrightnessForLimit(4000);
  assert.equal(wall.wantBrightness, 255, 'the host still asked for 255');
  assert.equal(wall.activeBrightness, cap, 'what is applied is what the limit allows');
  assert.deepEqual(wall.wallPixel(0), [scaleChannel(255, cap), scaleChannel(255, cap), scaleChannel(255, cap)]);

  // Lowering the limit must dim the wall that is already showing, not just the next frame.
  wall.push(meta({ brightness: 255, limitMa: 2000 }));
  wall.run(20);
  assert.equal(wall.activeBrightness, maxBrightnessForLimit(2000));
  assert.deepEqual(wall.wallPixel(0), new Array(3).fill(scaleChannel(255, maxBrightnessForLimit(2000))));
});

test('the status line parses back into the numbers a calibration run needs', () => {
  const wall = new VirtualWall({ limitMa: 6000 });
  wall.push(meta({ brightness: 200, limitMa: 6000 }));
  wall.push(frame(7, new Uint8Array(RGB_BYTES).fill(3)));
  wall.run(20);

  const cap = maxBrightnessForLimit(6000);
  const parsed = parseStatusLine(wall.statusLine());
  assert.ok(parsed, 'statusLine() must parse with its own parser');
  assert.equal(parsed.kind, 'status');
  assert.equal(parsed.seq, 7);
  assert.equal(wall.wantBrightness, 200, 'the host asked for 200');
  assert.equal(parsed.brightness, cap, 'the board reports what it APPLIED, not what was asked');
  assert.equal(parsed.brightnessCap, cap);
  assert.equal(parsed.limitMa, 6000);
  assert.equal(parsed.fullWhiteMa, fullWhiteMa(cap));
  assert.equal(parsed.estimateMa, estimateFrameMa(wall.lastFrame, cap));
  assert.equal(parsed.state, 'live');
  assert.equal(parsed.rx, RX.IDLE);
  assert.equal(parsed.frames, 1);
  assert.equal(parsed.discarded, 0);

  // A calibration run reads the board's other output through parseSelftestLine, so
  // this parser must not invent a status out of prose.
  for (const line of ['selftest: ALL_RED', 'sink ready pin=27 leds=400', '', 'wall']) {
    assert.equal(parseStatusLine(line), null, `should not parse as status: ${JSON.stringify(line)}`);
  }

  assert.deepEqual(parseSelftestLine('selftest: INDEX_MAP'), {
    kind: 'selftest',
    event: 'pattern',
    name: 'INDEX_MAP',
    pattern: 'index-map',
  });
  assert.deepEqual(parseSelftestLine('selftest: stopped by host frame'), { kind: 'selftest', event: 'stopped' });
  assert.equal(parseSelftestLine('wall seq=0'), null);
});

test("the WLED rig's status line parses, including the torn counter", () => {
  // Measured off the board verbatim, then with torn=3. The rig prints no sketch-
  // only fields (no est=, no cap=, no rx=) and spells the budget lim=, so this
  // line has to parse on its own terms: br is applied/wanted, gaps is seq deltas.
  const line = 'wall frames=8797 meta=25 disc=0 resync=0 rewind=0 gaps=7 torn=3 br=85/195 lim=8000 wifi=0 woff=1 state=live';
  const parsed = parseStatusLine(line);
  assert.ok(parsed, 'the rig line must parse');
  assert.equal(parsed.frames, 8797);
  assert.equal(parsed.discarded, 0);
  assert.equal(parsed.resyncs, 0);
  assert.equal(parsed.rewinds, 0);
  assert.equal(parsed.seqGaps, 7);
  assert.equal(parsed.brightness, 85, 'applied');
  assert.equal(parsed.brightnessCap, 195, 'wanted');
  assert.equal(parsed.limitMa, 8000);
  assert.equal(parsed.wifiMode, 0);
  assert.equal(parsed.wifiOffs, 1);
  assert.equal(parsed.state, 'live');
  // The counter that matters for a flicker on a clean wire: a paint skipped
  // because the previous refresh was still clocking out.
  assert.equal(parsed.torn, 3);

  // The sketch has no such field, and a missing field must not read as zero: 0
  // says "no tearing", undefined says "this build cannot see tearing".
  const sketch = parseStatusLine('wall seq=137 br=85/85 est=4210mA cap=8000mA limit=8000mA state=live rx=0 frames=412 disc=1 gaps=0');
  assert.equal(sketch.torn, undefined, 'absent torn= must stay absent');
});

test('a frame that fails its end byte never reaches the LEDs', () => {
  const wall = brightWall();
  const white = new Uint8Array(RGB_BYTES).fill(255);

  wall.push(frame(0, white));
  wall.run(20);
  assert.deepEqual(wall.wallPixel(0), [255, 255, 255]);
  assert.equal(wall.stats.frames, 1);

  const broken = frame(1, white);
  broken[600] = 0; // pixels the host never sent
  broken[END_INDEX] = 0x00; // and the end byte is wrong
  wall.push(broken);
  wall.run(20);

  assert.equal(wall.stats.frames, 1, 'a rejected frame must not count as committed');
  assert.equal(wall.stats.discarded, 1);
  assert.deepEqual(wall.wallPixel(0), [255, 255, 255], 'the wall keeps showing the last good frame');
  assert.equal(wall.wall, WALL.LIVE);
  assert.equal(wall.rx.state, RX.IDLE, 'the decoder returns to scanning instead of sticking');
});

test('a truncated frame is discarded, not half-rendered', () => {
  const wall = brightWall();
  const red = new Uint8Array(RGB_BYTES);
  for (let i = 0; i < red.length; i += 3) red[i] = 255;

  wall.push(frame(0, red));
  wall.run(20);
  const litBefore = wall.litFraction();
  assert.equal(litBefore, 1);

  wall.push(frame(1, new Uint8Array(RGB_BYTES)).subarray(0, 300)); // a black frame, cut short
  wall.run(200);

  assert.equal(wall.stats.discarded, 1);
  assert.equal(wall.stats.frames, 1, 'the partial frame never committed');
  assert.equal(wall.rx.state, RX.IDLE, 'the decoder gave up on it and went back to scanning');
  assert.equal(wall.litFraction(), litBefore, 'the wall still shows the last complete frame');
});

test('garbage before a frame is skipped, not mistaken for pixels', () => {
  const wall = brightWall();
  const white = new Uint8Array(RGB_BYTES).fill(255);

  wall.push(new Uint8Array([0x00, 0x41, 0x5a, 0xff, 0x00])); // junk, including a fake end byte
  wall.push(frame(0, white));
  wall.run(20);

  assert.equal(wall.stats.frames, 1);
  assert.deepEqual(wall.wallPixel(0), [255, 255, 255]);
  assert.equal(wall.stats.resyncs, 5, 'skipped bytes must be counted: they are the wire-quality signal');
  assert.equal(wall.stats.discarded, 0, 'nothing was framed wrongly, only noise was ignored');
});

test('one dropped byte is recovered from inside the record it corrupted', () => {
  const wall = brightWall();
  const white = new Uint8Array(RGB_BYTES).fill(255);
  const red = new Uint8Array(RGB_BYTES);
  for (let i = 0; i < red.length; i += 3) red[i] = 255;

  // A byte lost mid-frame leaves the reader one short, so it swallows the NEXT
  // frame's magic as payload and ends on that frame's seq byte. The magic we need
  // is sitting in the buffer we just rejected — that is what the rescan is for.
  const stream = new Uint8Array([...frame(0, white), ...frame(1, red)]);
  const lost = 600;
  wall.push(new Uint8Array([...stream.subarray(0, lost), ...stream.subarray(lost + 1)]));
  wall.run(20);

  assert.equal(wall.stats.frames, 1, 'the corrupted record is gone, the one behind it is not');
  assert.equal(wall.stats.discarded, 1);
  assert.equal(wall.stats.rewinds, 1, 'the salvage must be counted: it is a wire fault, not a normal path');
  assert.equal(wall.lastSeq, 1);
  assert.deepEqual(wall.wallPixel(0), [255, 0, 0], 'the salvaged frame must be intact, not shifted');
  assert.equal(wall.rx.state, RX.IDLE);
});

test('the virtual wire bounds outstanding frames and drops rather than queues', async () => {
  const wall = brightWall();
  const transport = new VirtualTransport({ wall, maxInFlight: 2 });

  assert.equal(transport.send(frame(0, new Uint8Array(RGB_BYTES))), true);
  assert.equal(transport.send(frame(1, new Uint8Array(RGB_BYTES))), true);
  assert.equal(transport.send(frame(2, new Uint8Array(RGB_BYTES))), false, 'a full wire must reject, not buffer');
  assert.equal(transport.stats.dropped, 1);
  assert.equal(transport.pending.length, 2);

  await transport.sleep(40);
  assert.equal(transport.pending.length, 0, 'the wire drains on the virtual clock');
  assert.equal(wall.stats.frames, 2);
});

test('a finite source leaves nothing stranded on the virtual wire', async () => {
  const wall = brightWall();
  const transport = new VirtualTransport({ wall });
  const driver = new WallDriver({ transport, brightness: 255, limitMa: 24000 });

  await driver.run(patternSource('walk', { durationMs: 400, steps: 13 }));
  await transport.sleep(40);

  assert.equal(driver.stats.frames, 13);
  assert.equal(driver.stats.skipped, 0, '13 frames at the pattern pace never exceeds the in-flight bound');
  assert.equal(wall.stats.frames, 13, 'every frame the driver sent must reach the wall');
  assert.equal(wall.stats.discarded, 0);
  assert.equal(wall.stats.seqGaps, 0, 'a fresh stream must not read as a gap');
  assert.equal(transport.pending.length, 0);

  // The meta frame goes out before the first frame: the guard has to be configured
  // before anything bright is on the wall.
  assert.equal(driver.stats.meta, 1);
  assert.equal(wall.stats.meta, 1);
  assert.equal(wall.activeBrightness, 255);
});

/**
 * A static pattern is the point of truth, so the wall sits on it for the whole
 * slot instead of flashing it and fading.
 *
 * Driven from the host the stale watchdog is live, so the source has to re-send
 * the frame. Sending it once made `--pattern index-map` a 1.5 s flash followed by
 * black on real hardware: on a 6 s slot, four and a half seconds of nothing while
 * the operator is trying to read the mapping off the wall.
 */
test('a static pattern is re-sent while held, so the watchdog never fades it', async () => {
  const wall = brightWall();
  const transport = new VirtualTransport({ wall });
  const driver = new WallDriver({ transport, limitMa: 24000 });

  await driver.run(patternSource('index-map', { durationMs: 4000 }));
  await transport.sleep(40);

  const resends = Math.ceil(4000 / STATIC_REFRESH_MS);
  assert.equal(driver.stats.frames, resends, `a 4000 ms slot is ${resends} re-sends, not one`);
  assert.equal(wall.stats.frames, driver.stats.frames, 'every re-send must land');
  assert.equal(wall.stats.stale, 0, 'the watchdog must never fire while a static pattern is held');
  assert.equal(wall.wall, WALL.LIVE, 'the wall stays live for the whole slot');
  assert.ok(wall.shows(calibrationPhysicalBytes('index-map', 0)),
    'and it is still showing the pattern the host is holding');
});

test('seq continuity across a driver is judged as continuity', async () => {
  const wall = brightWall();
  const transport = new VirtualTransport({ wall });
  const first = new WallDriver({ transport, limitMa: 24000 });
  await first.run(patternSource('all-red', { durationMs: 20 }));
  await transport.sleep(40);

  // A second driver that restarts at seq 0 after the wall has seen seq 0 is a gap:
  // the host went backwards, and the wall is entitled to say so.
  const second = new WallDriver({ transport, limitMa: 24000 });
  await second.run(patternSource('all-red', { durationMs: 20 }));
  await transport.sleep(40);
  assert.equal(wall.stats.seqGaps, 1);

  // Continuing the sequence is what a host must do; a wrap is not a gap.
  const third = new WallDriver({ transport, limitMa: 24000 });
  third.seq = (wall.lastSeq + 1) & 0xff;
  await third.run(patternSource('all-red', { durationMs: 20 }));
  await transport.sleep(40);
  assert.equal(wall.stats.seqGaps, 1, 'a continuing stream adds no gap');
});

/**
 * The self-test takeover announcement is a one-shot event, not a per-frame one.
 *
 * It is printed from commitFrame(), which runs once per received frame, so an
 * unguarded println makes a 30 fps stream emit 30 lines/s and the status line —
 * the only thing the calibration pass reads — becomes unreadable. Measured on
 * real hardware: 40 consecutive `selftest: stopped` lines in a 4 s run.
 * test/calibration.test.js pins the sketch's guard; this pins the behaviour.
 */
test('the self-test takeover announcement is printed once, not per frame', () => {
  const logs = [];
  const wall = new VirtualWall({
    selftest: true,
    limitMa: 24000,
    onLog: (line) => logs.push(line),
  });

  const white = new Uint8Array(RGB_BYTES).fill(255);
  for (let seq = 0; seq < 12; seq++) {
    wall.push(frame(seq, white));
    wall.step(33);
  }

  assert.equal(wall.stats.frames, 12, 'every frame must land');
  assert.equal(wall.self.active, false, 'the first host frame must take the wall over');
  const stops = logs.filter((line) => line.includes('stopped by host frame'));
  assert.equal(stops.length, 1,
    `exactly one takeover announcement across 12 frames, got ${stops.length}: ${JSON.stringify(logs)}`);
});

test('the watchdog fades to black instead of freezing on the last frame', () => {
  const wall = brightWall();
  const white = new Uint8Array(RGB_BYTES).fill(255);
  wall.push(frame(0, white));
  wall.run(20);
  assert.equal(wall.wall, WALL.LIVE);

  // The watchdog measures from the last COMPLETE frame, and the frame only lands a
  // few ms after it is pushed, so the stale window has to be computed relative to
  // the commit — not to the push.
  const sinceCommit = wall.clock - wall.lastCompleteMs;
  wall.run(wall.timing.staleMs - sinceCommit - 1);
  assert.equal(wall.wall, WALL.LIVE, 'not yet stale: a stalled stream must not flicker');

  wall.run(2);
  assert.equal(wall.wall, WALL.FADING);
  assert.equal(wall.stats.stale, 1);

  // Mid-ramp: dimming, not a step to black. litFraction() cannot show this (it only
  // asks "lit at all"), so read the pixel the LEDs are actually holding.
  wall.run(wall.timing.fadeMs / 2);
  assert.equal(wall.wall, WALL.FADING, 'half the ramp is not the end of it');
  const mid = wall.wallPixel(0);
  assert.ok(mid[0] > 0 && mid[0] < 255, `mid-fade must be dimmed, got ${mid.join(',')}`);

  wall.run(wall.timing.fadeMs / 2 + 20);
  assert.equal(wall.wall, WALL.DARK);
  assert.equal(wall.litFraction(), 0);
  assert.equal(wall.stats.stale, 1, 'one stale event per dropout, not one per tick');

  // One frame brings it back; there is no re-sync handshake to wait for.
  wall.push(frame(1, white));
  wall.run(20);
  assert.equal(wall.wall, WALL.LIVE);
  assert.equal(wall.litFraction(), 1);
});

test('--layout accepts the flag names core/layout.js defines and rejects the rest', () => {
  assert.deepEqual(parseLayoutFlags('flipX,flipY'), { flipX: true, flipY: true });
  assert.deepEqual(parseLayoutFlags(' transpose '), { transpose: true });
  assert.deepEqual(parseLayoutFlags('no-snake'), { snake: false });
  for (const [bad, why] of [['flipz', /unknown flag/], ['cols=20', /unknown flag/], ['strip=0', /strip/], ['axis=z', /axis/]]) {
    assert.throws(() => parseLayoutFlags(bad), why, `--layout ${bad} must be a usage error`);
  }
  // A trailing comma is typing noise, not an error: the calibration pass is typed
  // by hand at a bench.
  assert.deepEqual(parseLayoutFlags('flipX,'), { flipX: true });

  // The flags must reach the Layout that the preview and the packing both use.
  const layout = new Layout(parseLayoutFlags('flipX,transpose'));
  assert.equal(layout.flipX, true);
  assert.equal(layout.transpose, true);
});

test('the preview shows the wall through the layout being calibrated', () => {
  const layout = new Layout(); // calibrated: columns of 20, straight, top->bottom
  const wall = brightWall();
  const white = new Uint8Array(RGB_BYTES);
  white[0] = 255; // physical LED 0 only
  wall.push(frame(0, white));
  wall.run(20);

  const preview = asciiPreview(wall.strip, layout);
  const rows = preview.split('\n');
  const lit = rows.flatMap((line, y) =>
    [...line].map((ch, x) => (ch === '.' ? null : { y, x })).filter(Boolean),
  );

  assert.equal(rows.length, layout.rows, 'one row per panel cell');
  assert.equal(rows[0].length, layout.cols, 'one column per panel cell');
  assert.equal(lit.length, 1, 'exactly one cell is lit');
  assert.deepEqual(lit[0], { y: 0, x: 0 });

  // The calibrated wiring's actual signature: strips are COLUMNS. Physical 19
  // is the last LED of strip 0, so it sits at the BOTTOM of column 0; physical
  // 20 is the first LED of strip 1, and because the panel is not serpentine it
  // sits at the TOP of column 1. A row-major raster would put 19 at the END of
  // row 0 and 20 at the START of row 1 — which is the exact question a
  // calibration pass answers by looking at the wall.
  const wall2 = brightWall();
  const other = new Uint8Array(RGB_BYTES);
  other[19 * 3] = 255;
  other[20 * 3 + 1] = 255; // green, so the two cells are distinguishable from each other
  wall2.push(frame(0, other));
  wall2.run(20);

  const calibrated = asciiPreview(wall2.strip, layout).split('\n');
  const litX = (rows, y) => [...rows[y]].findIndex((ch) => ch !== '.');
  assert.equal(litX(calibrated, 19), 0, 'physical 19 ends column 0, at the bottom');
  assert.equal(litX(calibrated, 0), 1, 'physical 20 starts column 1, at the top: the panel is straight, not serpentine');

  const straight = asciiPreview(wall2.strip, identity()).split('\n');
  assert.equal(litX(straight, 0), 19, 'identity puts physical 19 at the END of row 0');
  assert.equal(litX(straight, 1), 0, 'identity puts physical 20 at the START of row 1');
  assert.notEqual(calibrated[19], straight[19], 'the preview must depend on the layout being calibrated');
});

test('pageSource puts a live web page on the wall, headless', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const serve = await startServe(port);
  try {
    // ?t=2/3 is the fixture's deterministic frame: 80 px and 60 px put the red bar
    // on cells 4-5 and the green bar on row 3, at 20 source px per cell.
    const url = `${serve.base}/anim-400.html?t=${2 / 3}`;
    const wall = brightWall();
    const transport = new VirtualTransport({ wall });
    const driver = new WallDriver({ transport, layout: identity(), limitMa: 24000 });

    const source = pageSource(url, {
      endpoint: `${serve.base}/capture`,
      layout: identity(),
      width: W,
      height: H,
      dsf: 1,
      waitMs: 0,
      pxPerCell: 20,
      cellsPerFrame: 0,
      frames: 3,
    });

    await driver.run(source);
    await transport.sleep(40);
    // cellsPerFrame: 0 means every capture is pixel-identical, so the driver sends
    // the first and skips the rest: a wall holds its last frame, so re-sending an
    // identical strip is pure traffic. That is the dedup, exercised end to end.
    assert.equal(driver.stats.frames, 1, 'identical captures are sent once, not three times');
    assert.equal(driver.stats.unchanged, 2, 'the two repeats are counted as unchanged');
    assert.equal(wall.stats.frames, 1);
    assert.equal(wall.stats.discarded, 0);

    // identity layout means physical index == cell, so the strip can be read as the
    // grid directly: what the wall shows is what the page painted.
    const PX = 20;
    const { x, y } = bars(2 / 3);
    const redCols = [x / PX, x / PX + 1];
    const greenRow = y / PX;
    assert.deepEqual(redCols, [4, 5], 'the fixture must still put the red bar on cells 4-5');
    assert.equal(greenRow, 3);

    // Red is a full-height band, green a full-width band painted over it. Row 0 is
    // outside the green band, so the red bar must be intact there.
    for (const col of redCols) {
      const [r, g, b] = wall.wallPixel(0 * 20 + col);
      assert.ok(r > 200 && g < 60 && b < 60, `cell ${col},0 should be red, got ${r},${g},${b}`);
    }
    const [gr, gg] = wall.wallPixel(greenRow * 20 + 0);
    assert.ok(gg > 200 && gr < 60, `cell 0,${greenRow} should be green, got ${gr},${gg}`);

    // Lit area is derivable from the geometry: 2 columns + 1 row - 2 crossing cells.
    const expectedLit = (2 * 20 + 1 * 20 - 2) / 400;
    assert.equal(wall.litFraction(), expectedLit, 'the wall must show exactly the page, nothing averaged');
  } finally {
    await serve.stop();
  }
});

/**
 * The two things that make a live page look smooth on the wall, measured on one
 * 60-frame run: the pan must keep its position across refreshes, and the frame loop
 * must not spend its 33 ms budget waiting for a screenshot.
 *
 * Both were broken, and both produce exactly the "not smooth" that was reported:
 *
 *   pan:    `pageSource` built a `new Panner` on every content change, and the
 *           constructor sets `offset = 0`. Measured trace of the old loop on the
 *           fixture below: offsets sawtoothed `0.15 0.30 0.15 0.30 …` for the whole
 *           run (24 decreases in 59 steps), so the wall never got past the first
 *           screenful and the bar left the panel for a third of the frames.
 *   pace:   `await refresh()` sat inside the frame loop, so the wall stopped
 *           emitting frames for the whole screenshot: median gap 95 ms and max
 *           118 ms on a 33 ms budget, with the fixed loop at 47 ms and 79 ms on the
 *           same machine under the same CPU load.
 *
 * tall-800.html is the fixture: 800 px tall, so a 400x800 capture is 20x40 cells at
 * 20 px per cell — a 20-cell pan span. anim-400.html is 400x400, exactly one grid,
 * so its span is 0 and it cannot show a pan reset at all.
 *
 * The loop is paced here with real sleeps rather than through WallDriver:
 * VirtualTransport.sleep advances the DEVICE clock in virtual slices, so driving
 * this source through it would spin 60 frames in a few milliseconds and land one
 * poll — the pan contract needs several refreshes to have landed.
 */
test('pageSource keeps its pan position and its frame pace on a live page', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const FRAMES = 60;
  const FPS = 30;
  const HOLD = 1000 / FPS;
  const port = await freePort();
  const serve = await startServe(port);
  try {
    const offsets = [];
    const litRows = [];
    const gaps = [];
    const hashes = new Set();

    const started = Date.now();
    let last = started;
    for await (const rec of pageSource(`${serve.base}/tall-800.html?speed=140`, {
      endpoint: `${serve.base}/capture`,
      layout: identity(),
      fps: FPS,
      pollMs: 100,
      width: 400,
      height: 800,
      dsf: 1,
      waitMs: 0,
      pxPerCell: 20,
      cellsPerFrame: 0.15,
      frames: FRAMES,
    })) {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
      offsets.push(rec.panOffset);
      hashes.add(rec.capture.hash);
      // The bar is the only green thing on the page, so the lit row IS where the
      // sweep has got to. Read off the panel: what the wall shows, not what the
      // Panner believes it drew.
      let row = -1;
      for (let y = 0; y < 20 && row < 0; y++) {
        for (let x = 0; x < 20; x++) {
          const [r, g, b] = rec.panel.getPixel(x, y);
          if (g > 100 && r < 60 && b < 60) { row = y; break; }
        }
      }
      litRows.push(row);
      await new Promise((done) => setTimeout(done, rec.holdMs));
    }
    const elapsed = Date.now() - started;

    assert.equal(offsets.length, FRAMES);

    // The premise of the pan assertion: content has to actually change during the
    // run, or "no reset" is vacuously true of a source that never refreshed.
    assert.ok(hashes.size >= 5,
      `the page must refresh several times during the run, saw ${hashes.size} distinct captures`);

    // --- pan ---------------------------------------------------------------
    const decreases = offsets.filter((o, i) => i > 0 && o < offsets[i - 1] - 1e-9);
    assert.equal(decreases.length, 0,
      `the pan must never jump back: offset decreased ${decreases.length}x of ${offsets.length - 1} steps, `
      + `offsets=${offsets.map((o) => o.toFixed(2)).join(' ')}`);
    assert.ok(offsets.at(-1) >= offsets[0] + 5,
      `60 frames at 0.15 cells must advance the pan ~9 cells, got ${offsets[0]} -> ${offsets.at(-1)}`);

    // The bar sweeps at 7 cells/s and the pan chases it at 4.5 cells/s, so the lit
    // row creeps DOWN at ~2.5 cells/s and stays on the 20-row panel for ~8 s of page
    // life — wide enough that a loaded machine (a 3-6 s run) still sees the sweep.
    // The offsets above are what detect a pan reset (a reset makes barRow - offset
    // jump FORWARD, so the lit row cannot prove it alone); this corroborates that the
    // wall is showing the sweep move. 1-row dips are tolerated: the fixture rounds the
    // bar to whole source pixels, so a row boundary can be crossed a frame early.
    const lit = litRows.filter((row) => row >= 0);
    assert.ok(lit.length >= FRAMES * 0.7,
      `the bar must be on the wall for most of the run, lit ${lit.length} of ${FRAMES} `
      + `(run took ${elapsed} ms, so the sweep covered ~${(elapsed * 2.5 / 1000).toFixed(1)} rows)`);
    const backwards = lit.filter((row, i) => i > 0 && lit[i - 1] - row >= 2);
    assert.equal(backwards.length, 0, `the sweep must move down the wall, lit rows=${litRows.join(' ')}`);
    assert.ok(lit.at(-1) - lit[0] >= 5,
      `the bar must travel several rows down the wall, lit rows=${litRows.join(' ')}`);

    // --- pacing ------------------------------------------------------------
    // Median gap is the discriminator, measured against the pre-fix loop under the
    // same CPU load the full suite creates: 47 ms fixed vs 95 ms when a capture is
    // awaited inline (max 78 vs 116). Total elapsed is NOT used as a pacing bound —
    // fixed 2911/3201 ms against pre-fix 4419/4581 ms overlaps once the machine is
    // busy, so it only guards against a hang.
    const sorted = gaps.slice(1).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(elapsed < FRAMES * 200,
      `${FRAMES} frames took ${elapsed} ms — the frame loop stalled outright`);
    assert.ok(median <= 70,
      `median frame gap ${median} ms on a ${Math.round(HOLD)} ms budget (max ${Math.max(...gaps)}); `
      + 'a capture must be awaited in the background, not in the frame loop');
  } finally {
    await serve.stop();
  }
});

test('--poll is validated and reaches the page source', () => {
  assert.equal(parseArgs(['--page', '/anim-400.html']).pollMs, null, 'unset means the source decides');
  assert.equal(parseArgs(['--page', '/anim-400.html', '--poll', '150']).pollMs, 150);
  assert.throws(() => parseArgs(['--page', '/x', '--poll', '50']), /--poll must be >= 100/);
  assert.throws(() => parseArgs(['--page', '/x', '--poll', 'abc']), /--poll/);
});

test('--brightness is parsed and bounded, not just advertised', () => {
  assert.equal(parseArgs([]).brightness, 255, 'default is full brightness');
  assert.equal(parseArgs(['--brightness', '30']).brightness, 30);
  assert.equal(parseArgs(['--brightness', '0']).brightness, 0);
  assert.throws(() => parseArgs(['--brightness', '256']), /--brightness must be 0\.\.255/);
  assert.throws(() => parseArgs(['--brightness', 'abc']), /--brightness/);
});

test('a DDP frame carries WLED\'s header and a brightness-scaled payload', () => {
  const sent = [];
  const transport = new DdpTransport({
    host: '127.0.0.1:5568',
    brightness: 128,
    socket: { send: (packet, port, host) => sent.push({ packet, port, host }) },
  });

  assert.equal(transport.port, 5568, 'host:port overrides the default');
  assert.equal(transport.host, '127.0.0.1');

  const rgb = new Uint8Array(RGB_BYTES).fill(200);
  assert.equal(transport.send(frame(7, rgb)), true);

  assert.equal(sent.length, 1);
  const { packet, port, host } = sent[0];
  assert.equal(port, 5568);
  assert.equal(host, '127.0.0.1');
  assert.equal(packet.length, 10 + RGB_BYTES, '10-byte header then RGB');
  assert.equal(packet[0], 0x41, 'flags: VER1 | PUSH');
  assert.equal(packet[1], 1, 'sequence starts at 1 — WLED treats 0 as unused');
  assert.equal(packet[2], 0x0b, 'type: RGB24');
  assert.equal(packet[3], 0x01, 'id: DISPLAY');
  assert.equal(packet.readUInt32BE(4), 0, 'offset');
  assert.equal(packet.readUInt16BE(8), RGB_BYTES, 'length, MSB first');
  assert.equal(packet[10], (200 * 128) >> 8, 'brightness applied host-side');

  const seqs = new Set();
  for (let i = 0; i < 20; i++) {
    transport.send(frame(i, rgb));
    seqs.add(sent[sent.length - 1].packet[1]);
  }
  assert.ok(!seqs.has(0), 'the sequence never lands on 0');
  assert.ok(Math.min(...seqs) >= 1 && Math.max(...seqs) <= 15, 'the sequence stays in 1..15');
});

test('a DDP meta record sets brightness instead of painting the wall', () => {
  const sent = [];
  const transport = new DdpTransport({ host: 'wled.local', socket: { send: () => sent.push(1) } });
  assert.equal(transport.send(meta({ brightness: 40, limitMa: 24000 })), true);
  assert.equal(sent.length, 0, 'a meta record is not a datagram');
  assert.equal(transport.brightness, 40);
  assert.equal(transport.port, 4048, 'the DDP default port');
});

test('--preview refuses a remote sink instead of crashing', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (line) => errors.push(line);
  let code;
  try {
    // Needs a real action, or the earlier "nothing to do" guard fires first.
    code = await main(['--ddp', '192.168.1.118', '--pattern', 'all-red', '--preview']);
  } finally {
    console.error = realError;
  }
  assert.equal(code, 2, 'a bad flag combination is a usage error, not a crash');
  assert.match(errors.join('\n'), /--preview reads the device back/);
});

/**
 * The CLI is the deliverable for milestone 2/4: one command must take a live web page
 * onto the wall. Everything above tests the parts; this tests the wiring between them,
 * including the two things only a real invocation catches — that --serve can find a
 * port, and that --page can name a path instead of a URL whose port you cannot know.
 */
test('main() runs page -> wall end to end from the CLI', async () => {
  const lines = [];
  const log = console.log;
  let code = 1;
  console.log = (...args) => {
    for (const piece of args.join(' ').split('\n')) lines.push(piece);
  };
  try {
    // Long enough for Chromium to boot and take the first screenshot even while the
    // rest of the suite is running: a capture is a real screenshot, not a cheap read.
    code = await main(['--page', '/anim-400.html', '--serve', '--preview', '--duration', '4000', '--limit', '24000']);
  } finally {
    console.log = log;
  }

  assert.equal(code, 0, lines.join('\n'));

  const served = lines.find((line) => line.startsWith('bridge: dev server on '));
  assert.ok(served, `--serve must report its port, got:\n${lines.join('\n')}`);
  const port = new URL(served.slice('bridge: dev server on '.length)).port;
  assert.ok(port, 'the dev server URL must carry the port it bound');

  const resolved = lines.find((line) => line.startsWith('bridge: --page /anim-400.html -> '));
  assert.ok(resolved, 'a path --page must be resolved against the server that serves it');
  assert.equal(new URL(resolved.split(' -> ')[1].split(' ')[0]).port, port,
    'the page URL must point at the dev server, not at a port nobody is listening on');

  const grids = lines.filter((line) => /^[.RGYBMCW]{20}$/.test(line));
  assert.ok(grids.length >= 20, `--preview must print 20-cell rows, saw ${grids.length}`);
  // The last block is the settled wall: it must be showing the page, not the dark
  // grid the wall starts on before the first capture lands.
  const settled = grids.slice(-20);
  assert.ok(settled.some((row) => /[RGYBMCW]/.test(row)),
    `the wall must be showing the page, not a blank grid:\n${settled.join('\n')}`);

  const sent = lines.at(-1);
  const frames = Number(/sent (\d+) frames/.exec(sent)?.[1]);
  assert.ok(frames >= 5, `expected frames on the wire, got: ${sent}`);
  assert.ok(!/\d+ dropped/.test(sent) || / 0 dropped/.test(sent), `frames must not be dropped: ${sent}`);
});

test('--serve-port is validated against the ports a client can reach', () => {
  assert.throws(() => parseArgs(['--serve', '--serve-port', '0']), /port a client can connect to/);
  assert.throws(() => parseArgs(['--serve', '--serve-port', '65536']), /port a client can connect to/);
  assert.throws(() => parseArgs(['--serve-port', '8080']), /needs --serve/);
  assert.equal(parseArgs(['--serve', '--serve-port', '8080']).servePort, 8080);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FPS,
  DEFAULT_LIMIT_MA,
  DEFAULT_SECONDS,
  classifyLine,
  gradient,
  judge,
  parseArgs,
  shortFrame,
} from '../tools/wallcheck.js';
import { FRAME_BYTES, RGB_BYTES } from '../core/frame.js';
import { parseStatusLine } from '../tools/bridge.js';

/**
 * wallcheck is the one-command answer to "is this build healthy?", so its verdict
 * has to be right about the failure that motivated it: a transport that loses
 * bytes, and a decoder that does (or does not) recover from it.
 *
 * The verdict is a pure function of the counters, so it is tested here against
 * synthetic readings rather than hardware. The counter arithmetic is the part
 * that can be wrong; whether the bytes arrive is what the tool measures.
 *
 * Two rules matter and are easy to get backwards:
 *  - One frame of slack. The device prints its status at 1 Hz, so a frame can
 *    still be in flight when the final reading is taken. Demanding lost === 0
 *    would fail a healthy run at random.
 *  - A fault that was never SEEN is not a pass. If the transport eats the short
 *    frame before the decoder looks at it, disc stays 0 — and the resync path,
 *    which is the whole reason this sink exists, was never exercised.
 */

/** A parsed status line, with only the fields a verdict reads spelled out. */
const status = (over = {}) => ({
  kind: 'status',
  frames: 0,
  meta: 0,
  discarded: 0,
  resyncs: 0,
  rewinds: 0,
  seqGaps: 0,
  brightness: 255,
  brightnessCap: 255,
  state: 'live',
  ...over,
});

test('a clean run passes, and one frame of slack is allowed for one still in flight', () => {
  const before = status();
  const exact = judge({ sent: 400, before, after: status({ frames: 400 }) });
  assert.equal(exact.ok, true, exact.reasons.join('; '));
  assert.equal(exact.lost, 0);

  // The status line prints at 1 Hz; the last frame can legitimately not be in the
  // reading yet. This must NOT be reported as loss.
  const inFlight = judge({ sent: 400, before, after: status({ frames: 399 }) });
  assert.equal(inFlight.ok, true, inFlight.reasons.join('; '));
  assert.equal(inFlight.lost, 1);
});

test('frames that never decoded fail, and the count is the host/device difference', () => {
  // What the USB-CDC transport measured: 305 sent, 295 decoded.
  const verdict = judge({ sent: 305, before: status(), after: status({ frames: 295, discarded: 11, resyncs: 11, rewinds: 11, seqGaps: 21 }) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.lost, 10);
  assert.ok(
    verdict.reasons.some((r) => r.includes('10 of 305')),
    `expected a lost-frame reason, got: ${verdict.reasons.join('; ')}`,
  );
});

test('a transport that loses bytes fails even when every frame that arrived was clean', () => {
  // resync counts bytes seen between frames. It is the number that separates a
  // lossy transport from a clean one, and it cannot be seen from `frames` alone.
  const verdict = judge({ sent: 300, before: status(), after: status({ frames: 300, resyncs: 1159, discarded: 6, rewinds: 2 }) });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes('resync')), verdict.reasons.join('; '));
  assert.ok(verdict.reasons.some((r) => r.includes('discarded')), verdict.reasons.join('; '));
});

test('a discarded record fails a clean run even when nothing was resynced', () => {
  // A malformed record reached the decoder. On a healthy transport that cannot
  // happen at all, so it is a failure on its own — resync counts are a separate
  // signal, not the only one.
  const verdict = judge({ sent: 200, before: status(), after: status({ frames: 200, discarded: 1 }) });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes('discarded')), verdict.reasons.join('; '));
});

test('an injected fault passes only when it was discarded AND the next frame recovered', () => {
  // The measured shape of a healthy recovery: disc, resync and rewind all move by
  // one, the sequence skips the fault's number, and every real frame still decodes.
  const recovered = judge({
    sent: 240,
    before: status(),
    after: status({ frames: 240, meta: 1, discarded: 1, resyncs: 1, rewinds: 1, seqGaps: 1 }),
    fault: true,
  });
  assert.equal(recovered.ok, true, recovered.reasons.join('; '));

  // Transport ate the short frame before the decoder saw it: disc stayed 0. That
  // is not a pass — the resync path was never tested.
  const eaten = judge({
    sent: 240,
    before: status(),
    after: status({ frames: 240, meta: 1 }),
    fault: true,
  });
  assert.equal(eaten.ok, false);
  assert.ok(eaten.reasons.some((r) => r.includes('never discarded')), eaten.reasons.join('; '));
});

test('a fault that was discarded but cascaded into losing the next frame still fails', () => {
  // Adalight's behaviour: the bad frame is discarded and the frame after it is
  // lost too. disc moves, rewind does not, and one real frame is gone.
  const verdict = judge({
    sent: 240,
    before: status(),
    after: status({ frames: 239, discarded: 1, resyncs: 1, rewinds: 0, seqGaps: 2 }),
    fault: true,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes('never decoded') || r.includes('not recover')), verdict.reasons.join('; '));
});

test('no reading at all is a failure rather than a pass', () => {
  assert.equal(judge({ sent: 10, before: null, after: null }).ok, false);
  // A device that printed before the run but nothing during it proves nothing.
  const before = status();
  assert.equal(judge({ sent: 10, before, after: before }).ok, false);
});

test('the classification separates the boot banner from a reading', () => {
  const boot = classifyLine('wall sink ready leds=400 baud=921600 limit=8000mA cap=85/255 proto=A5/A4');
  assert.equal(boot.kind, 'boot', 'the banner is not a reading');

  const reading = classifyLine('wall frames=400 meta=1 disc=0 resync=0 rewind=0 gaps=0 br=255/255 lim=24000 wifi=0 woff=1 state=live');
  assert.equal(reading.kind, 'status');
  assert.equal(reading.frames, 400);
  assert.equal(reading.discarded, 0);
  assert.equal(reading.resyncs, 0);
  assert.equal(reading.rewinds, 0);
  assert.equal(reading.seqGaps, 0);
  // The WLED sink spells the budget `lim=` and reports its radio; the shared
  // parser has to understand both spellings or the tool silently sees nothing.
  assert.equal(reading.limitMa, 24000);
  assert.equal(reading.wifiMode, 0);
  assert.equal(reading.wifiOffs, 1);

  assert.equal(classifyLine('frame magic 0xA5'), null);
});

test('the pattern actually moves, or it would be skipped as a still wall', () => {
  // A repeated frame is never re-sent by either driver (STATIC_REFRESH_MS excepted),
  // so a static test pattern would measure almost nothing.
  const all = [];
  for (let seq = 0; seq < 8; seq++) all.push(gradient(seq));
  for (let i = 0; i < all.length; i++) {
    assert.equal(all[i].length, RGB_BYTES);
    for (let j = i + 1; j < all.length; j++) {
      assert.notDeepEqual(all[i], all[j], `frame ${i} and ${j} are identical`);
    }
  }
});

test('the fault frame is exactly one payload byte short of a real frame', () => {
  const short = shortFrame(7);
  assert.equal(short.length, FRAME_BYTES - 1, 'the whole point is that it is short by one');
  assert.equal(short[0], 0xa5);
  assert.equal(short[1], 7);
  assert.equal(short[short.length - 1], 0x5a, 'the end byte is present, so the loss is in the payload');
});

test('arguments parse to sane defaults and reject nonsense', () => {
  const opts = parseArgs(['--port', 'COM8']);
  assert.equal(opts.port, 'COM8');
  assert.equal(opts.seconds, DEFAULT_SECONDS);
  assert.equal(opts.fps, DEFAULT_FPS);
  assert.equal(opts.limit, DEFAULT_LIMIT_MA);
  assert.equal(opts.fault, false);

  assert.equal(parseArgs(['--port', 'COM8', '--fault']).fault, true);
  assert.equal(parseArgs(['--port', 'COM8', '--seconds', '30']).seconds, 30);

  assert.throws(() => parseArgs(['--port', 'COM8', '--seconds', '0']), /--seconds/);
  assert.throws(() => parseArgs(['--port', 'COM8', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--port']), /needs a value/);
});

test('parseStatusLine leaves the sketch line untouched while reading the sink line', () => {
  // The two firmwares share a parser. Adding the sink's fields must not change
  // what a sketch reading looks like.
  const sketch = parseStatusLine('wall seq=137 br=85/85 est=4210mA cap=8000mA limit=8000mA state=live rx=0 frames=412 meta=3 disc=1 resync=20 rewind=1 gaps=0 stale=0');
  assert.equal(sketch.limitMa, 8000);
  assert.equal(sketch.wifiMode, undefined, 'the sketch has no radio to report');
  assert.equal(sketch.discarded, 1);
});

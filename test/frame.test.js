import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../core/panel.js';
import { Layout } from '../core/layout.js';
import { pack, unpack } from '../core/buffer.js';
import {
  FRAME_MAGIC,
  META_MAGIC,
  FRAME_END,
  LED_COUNT,
  RGB_BYTES,
  FRAME_BYTES,
  META_BYTES,
  OFFSET_RGB,
  OFFSET_END,
  frame,
  encodeFrameInto,
  meta,
  nextSeq,
  FrameDecoder,
} from '../core/frame.js';

test('protocol constants', () => {
  assert.equal(FRAME_MAGIC, 0xa5);
  assert.equal(META_MAGIC, 0xa4);
  assert.equal(FRAME_END, 0x5a);
  assert.equal(LED_COUNT, 400);
  assert.equal(RGB_BYTES, 1200);
  assert.equal(FRAME_BYTES, 1203);
  assert.equal(META_BYTES, 5);
});

/**
 * plan.md says "Total 1204 bytes", but the fields it lists — magic, seq,
 * 1200 RGB, end — sum to 1203. The field list is what the firmware counts,
 * so the test pins 1203 and names the discrepancy rather than hiding it.
 */
test('a frame is 1203 bytes: magic, seq, 1200 RGB, end', () => {
  const rgb = new Uint8Array(RGB_BYTES).fill(3);
  const f = frame(7, rgb);
  assert.equal(f.length, 1203);
  assert.equal(f[0], FRAME_MAGIC);
  assert.equal(f[1], 7);
  assert.equal(f[1202], FRAME_END);
  assert.equal(f.subarray(2, 1202).every((v) => v === 3), true);
  assert.equal(OFFSET_END, 1202);
  assert.equal(OFFSET_RGB, 2);
});

test('frame rejects the wrong RGB length', () => {
  assert.throws(() => frame(0, new Uint8Array(1199)), RangeError);
  assert.throws(() => frame(0, new Uint8Array(1201)), RangeError);
});

test('encodeFrameInto writes into a reusable buffer', () => {
  const buf = new Uint8Array(FRAME_BYTES);
  const out = encodeFrameInto(buf, 1, new Uint8Array(RGB_BYTES).fill(9));
  assert.equal(out, buf);
  assert.equal(buf[0], FRAME_MAGIC);
  assert.equal(buf[1202], FRAME_END);
  assert.throws(() => encodeFrameInto(new Uint8Array(1204), 0, new Uint8Array(RGB_BYTES)), RangeError);
});

test('seq wraps 255 -> 0 and is masked on encode', () => {
  assert.equal(nextSeq(0), 1);
  assert.equal(nextSeq(254), 255);
  assert.equal(nextSeq(255), 0);
  assert.equal(frame(256, new Uint8Array(RGB_BYTES))[1], 0);
  assert.equal(frame(-1, new Uint8Array(RGB_BYTES))[1], 255);
});

test('meta frame is 5 bytes with brightness and LE current limit', () => {
  const m = meta({ brightness: 200, limitMa: 8000 });
  assert.equal(m.length, 5);
  assert.equal(m[0], META_MAGIC);
  assert.equal(m[1], 200);
  assert.equal(m[2], 8000 & 0xff);
  assert.equal(m[3], (8000 >> 8) & 0xff);
  assert.equal(m[4], FRAME_END);
});

test('meta clamps out-of-range brightness and limit', () => {
  assert.equal(meta({ brightness: 300 })[1], 255);
  assert.equal(meta({ brightness: -5 })[1], 0);
  const big = meta({ limitMa: 70000 });
  assert.equal(big[2] | (big[3] << 8), 0xffff);
});

test('decoder round-trips a frame', () => {
  const layout = new Layout();
  const p = new Panel();
  p.setPixel(3, 4, 11, 22, 33);
  const f = frame(42, pack(p, layout));

  const d = new FrameDecoder();
  const got = d.feed(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].seq, 42);
  assert.deepEqual(Array.from(got[0].rgb), Array.from(f.subarray(2, 1202)));
  assert.equal(d.stats.frames, 1);
  assert.equal(d.stats.discarded, 0);
});

test('decoder reassembles a frame split across arbitrary chunks', () => {
  const f = frame(5, new Uint8Array(RGB_BYTES).fill(4));
  const d = new FrameDecoder();
  const out = [];
  // Feed one byte at a time — the worst possible framing.
  for (let i = 0; i < f.length; i++) out.push(...d.feed(f.subarray(i, i + 1)));
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 5);
  assert.equal(out[0].rgb.length, RGB_BYTES);
});

test('decoder splits a chunk containing two frames', () => {
  const a = frame(1, new Uint8Array(RGB_BYTES).fill(1));
  const b = frame(2, new Uint8Array(RGB_BYTES).fill(2));
  const joined = new Uint8Array(FRAME_BYTES * 2);
  joined.set(a, 0);
  joined.set(b, FRAME_BYTES);

  const d = new FrameDecoder();
  const out = d.feed(joined);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.seq), [1, 2]);
});

/** Drop-safety is the whole point of the protocol. */
test('garbage before the magic is skipped', () => {
  const junk = new Uint8Array([0x00, 0x11, 0x99, 0x00, 0x5a, 0x00]);
  const f = frame(9, new Uint8Array(RGB_BYTES).fill(7));
  const stream = new Uint8Array(junk.length + FRAME_BYTES);
  stream.set(junk, 0);
  stream.set(f, junk.length);

  const d = new FrameDecoder();
  const out = d.feed(stream);
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 9);
  assert.ok(d.stats.resyncs > 0);
});

test('a wrong end byte discards the frame entirely', () => {
  const f = frame(3, new Uint8Array(RGB_BYTES).fill(1));
  f[1202] = 0x00; // the end byte, at index 1202
  const d = new FrameDecoder();
  assert.equal(d.feed(f).length, 0);
  assert.equal(d.stats.discarded, 1);
  assert.equal(d.stats.frames, 0);
});

/**
 * The realistic failure: one byte lost mid-frame. The frame comes up one byte
 * short, so the decoder swallows the NEXT frame's magic byte as payload and
 * rejects the record. Resync must recover that magic, so the loss costs the
 * damaged frame only — not the rest of the stream.
 */
test('a single dropped byte costs one frame, not the stream', () => {
  const a = frame(1, new Uint8Array(RGB_BYTES).fill(200));
  const b = frame(2, new Uint8Array(RGB_BYTES).fill(100));
  const c = frame(3, new Uint8Array(RGB_BYTES).fill(50));

  const stream = new Uint8Array(FRAME_BYTES * 3);
  stream.set(a, 0);
  stream.set(b, FRAME_BYTES);
  stream.set(c, FRAME_BYTES * 2);

  // Drop one byte from the middle of frame a.
  const dropped = new Uint8Array(stream.length - 1);
  dropped.set(stream.subarray(0, 600), 0);
  dropped.set(stream.subarray(601), 600);

  const d = new FrameDecoder();
  const out = d.feed(dropped);
  const seqs = out.map((r) => r.seq);

  assert.equal(d.stats.discarded, 1, 'the damaged frame must be rejected');
  assert.ok(!seqs.includes(1), 'the damaged frame must never render');
  assert.ok(seqs.includes(2), 'the frame whose magic was swallowed must be recovered');
  assert.ok(seqs.includes(3), 'the rest of the stream must keep decoding');
  assert.ok(d.stats.rewinds > 0, 'resync must have rewound to the swallowed magic');
  assert.equal(out.find((r) => r.seq === 2).rgb[0], 100);
});

/** Losing a whole frame is normal at 921600 under load; the sink must know. */
test('a whole dropped frame is reported as a seq gap', () => {
  const a = frame(10, new Uint8Array(RGB_BYTES).fill(1));
  const b = frame(11, new Uint8Array(RGB_BYTES).fill(2));
  const c = frame(12, new Uint8Array(RGB_BYTES).fill(3));

  const stream = new Uint8Array(FRAME_BYTES * 3);
  stream.set(a, 0);
  stream.set(c, FRAME_BYTES); // b never arrives

  const d = new FrameDecoder();
  const out = d.feed(stream.subarray(0, FRAME_BYTES * 2));
  assert.deepEqual(out.map((r) => r.seq), [10, 12]);
  assert.equal(d.stats.gaps, 1);
  assert.equal(d.stats.discarded, 0);
});

test('a truncated frame is never rendered', () => {
  const d = new FrameDecoder();
  const partial = frame(3, new Uint8Array(RGB_BYTES).fill(255)).subarray(0, 600);
  assert.equal(d.feed(partial).length, 0);
  assert.equal(d.stats.frames, 0);
  // A frame that arrives complete afterwards still decodes.
  const out = d.feed(frame(4, new Uint8Array(RGB_BYTES).fill(1)));
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 4);
});

test('a magic byte inside RGB payload does not desync a good frame', () => {
  // 0xA5 appears in the payload; the decoder counts bytes, so it must not
  // mistake payload content for a new frame start.
  const rgb = new Uint8Array(RGB_BYTES).fill(FRAME_MAGIC);
  const f = frame(11, rgb);
  const d = new FrameDecoder();
  const out = d.feed(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].rgb.every((v) => v === FRAME_MAGIC), true);
});

test('decoder handles interleaved meta and frames', () => {
  const d = new FrameDecoder();
  const stream = new Uint8Array(META_BYTES + FRAME_BYTES + META_BYTES);
  stream.set(meta({ brightness: 128, limitMa: 6000 }), 0);
  stream.set(frame(1, new Uint8Array(RGB_BYTES).fill(3)), META_BYTES);
  stream.set(meta({ brightness: 64, limitMa: 4000 }), META_BYTES + FRAME_BYTES);

  const frames = [];
  const metas = [];
  d.feed(stream, (f) => frames.push(f), (m) => metas.push(m));
  assert.equal(frames.length, 1);
  assert.equal(metas.length, 2);
  assert.equal(metas[0].brightness, 128);
  assert.equal(metas[0].limitMa, 6000);
  assert.equal(metas[1].brightness, 64);
  assert.equal(metas[1].limitMa, 4000);
});

test('a bad meta frame is discarded', () => {
  const m = meta({ brightness: 100 });
  m[4] = 0x00;
  const d = new FrameDecoder();
  assert.equal(d.feed(m).length, 0);
  assert.equal(d.stats.discarded, 1);
});

test('reset() abandons a half-received frame', () => {
  const d = new FrameDecoder();
  d.feed(frame(1, new Uint8Array(RGB_BYTES)).subarray(0, 500));
  d.reset();
  const out = d.feed(frame(2, new Uint8Array(RGB_BYTES).fill(1)));
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 2);
});

test('decoded rgb is a copy, so the next frame cannot overwrite it', () => {
  const d = new FrameDecoder();
  const a = d.feed(frame(1, new Uint8Array(RGB_BYTES).fill(200)))[0];
  d.feed(frame(2, new Uint8Array(RGB_BYTES).fill(0)));
  assert.equal(a.rgb[0], 200);
});

test('seq survives a wrap across a stream', () => {
  const d = new FrameDecoder();
  const seqs = [254, 255, 0, 1].map((s) =>
    d.feed(frame(s, new Uint8Array(RGB_BYTES)))[0].seq,
  );
  assert.deepEqual(seqs, [254, 255, 0, 1]);
});

test('end-to-end: panel -> pack -> frame -> decode -> unpack reproduces the grid', () => {
  const layout = new Layout();
  const p = new Panel();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) p.setPixel(x, y, x * 12, y * 12, 40);

  const d = new FrameDecoder();
  const [f] = d.feed(frame(0, pack(p, layout)));
  const back = unpack(f.rgb, layout);
  assert.ok(back.equals(p));
});

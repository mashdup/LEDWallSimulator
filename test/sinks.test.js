import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  Panel,
  Layout,
  pack,
  unpack,
  frame,
  meta,
  encodeFrameInto,
  FrameDecoder,
  FRAME_BYTES,
  FRAME_MAGIC,
  META_BYTES,
  META_MAGIC,
  FRAME_END,
  RGB_BYTES,
  LED_COUNT,
} from '../core/index.js';
import {
  SimSink,
  BroadcastSink,
  SerialSink,
  openSink,
  SINK_KINDS,
  DEFAULT_BAUD,
  MAX_IN_FLIGHT,
  WIRE_MS_PER_FRAME,
} from '../web/sinks.js';

/**
 * web/sinks.js is browser-facing but DOM-free: it touches only navigator.serial
 * and BroadcastChannel. Both are stubbable here, so the wire contract the ESP32
 * depends on is tested in Node rather than only by eye.
 */

// -------------------------------------------------------------------------
// Fake Web Serial
// -------------------------------------------------------------------------

/**
 * A SerialPort stand-in. Writes resolve immediately unless `hold` or `fail` is
 * set, which is how the in-flight cap and the write-failure path are exercised.
 */
function fakePort({ hold = false, fail = false, openError = null } = {}) {
  const listeners = new Map();
  const port = {
    written: [],
    opened: null,
    closed: false,
    getInfo: () => ({ usbProductName: 'ESP32 UART' }),
    open: async (opts) => {
      if (openError !== null) throw new Error(openError);
      port.opened = opts;
    },
    close: async () => {
      port.closed = true;
    },
    writable: {
      getWriter: () => ({
        write: (chunk) => {
          port.written.push(chunk);
          if (fail) return Promise.reject(new Error('UART buffer full'));
          if (hold) return new Promise(() => {}); // never settles: stays in flight
          return Promise.resolve();
        },
        close: async () => {
          port.writerClosed = true;
        },
      }),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    emit: (type) => {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
  return port;
}

/** Install a navigator.serial that hands out `port`, and return the sink. */
async function connectedSink(port, opts = {}) {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: async () => port } },
    configurable: true,
    writable: true,
  });
  try {
    const sink = new SerialSink(opts);
    await sink.open();
    return sink;
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true });
  }
}

const sampleFrame = () => {
  const panel = new Panel();
  panel.fill(10, 20, 30);
  return frame(7, pack(panel, new Layout()));
};

const settle = () => new Promise((r) => setImmediate(r));

// -------------------------------------------------------------------------
// Record validation — shared by every sink
// -------------------------------------------------------------------------

test('every sink refuses a record that is not a whole frame or meta', () => {
  const good = sampleFrame();
  const goodMeta = meta({ brightness: 200, limitMa: 6000 });

  const bad = [
    new Uint8Array([1, 2, 3]), // wrong length
    new Uint8Array(FRAME_BYTES).fill(0), // right length, wrong magic
    new Uint8Array(META_BYTES).fill(0),
    good.slice(0, FRAME_BYTES - 1), // truncated frame
    new Uint8Array(FRAME_BYTES + 1), // one byte of slop appended
    'not bytes',
    null,
  ];

  const sinks = [
    new SimSink(),
    new BroadcastSink({ channel: `led-wall-test-validate-${process.pid}` }),
    new SerialSink(),
  ];
  try {
    for (const sink of sinks) {
      for (const bytes of bad) {
        assert.equal(sink.send(bytes), false, `${sink.kind} accepted ${String(bytes)?.slice(0, 30)}`);
      }
      assert.equal(sink.stats.rejected, bad.length, `${sink.kind} rejected count`);
      assert.equal(sink.stats.sent, 0, `${sink.kind} must not send a rejected record`);
    }

    // A closed serial sink drops; it does not reject. The distinction matters
    // because it proves classification runs BEFORE the transport is consulted:
    // garbage must never reach the wire, open port or not.
    const serial = sinks[2];
    assert.equal(serial.stats.dropped, 0, 'a rejected record is not a dropped one');
    assert.equal(serial.send(good), false, 'an unopened serial sink cannot send');
    assert.equal(serial.stats.sent, 0);
    assert.equal(serial.stats.dropped, 1, 'a valid frame with no port is dropped');
    assert.equal(serial.stats.rejected, bad.length, 'the open check must not re-count as a rejection');

    for (const sink of [sinks[0], sinks[1]]) {
      assert.equal(sink.send(good), true, `${sink.kind} refused a valid frame`);
      assert.equal(sink.send(goodMeta), true, `${sink.kind} refused a valid meta`);
      assert.equal(sink.stats.sent, 2, `${sink.kind} sent count`);
      assert.equal(sink.stats.meta, 1, `${sink.kind} meta count`);
    }
  } finally {
    for (const sink of sinks) sink.close();
  }
});

// -------------------------------------------------------------------------
// SimSink — the reference path
// -------------------------------------------------------------------------

test('SimSink hands the bytes through unchanged and keeps a reference, not a copy', () => {
  const seen = [];
  const sink = new SimSink({ onFrame: (b) => seen.push(b) });
  const f = sampleFrame();

  assert.equal(sink.send(f), true);
  assert.equal(sink.lastFrame, f, 'the sim wants the live buffer, not a 1203-byte copy');
  assert.equal(seen[0], f);
  assert.deepEqual(Array.from(seen[0]), Array.from(f));
});

test('SimSink.lastFrame stays a frame when a meta record arrives', () => {
  const sink = new SimSink();
  const f = sampleFrame();
  sink.send(f);
  const m = meta({ brightness: 128, limitMa: 4000 });
  sink.send(m);

  assert.equal(sink.last, m, 'last follows every record');
  assert.equal(sink.lastFrame, f, 'lastFrame must not be overwritten by meta');
  assert.equal(sink.lastFrame.length, FRAME_BYTES);
});

// -------------------------------------------------------------------------
// SerialSink — the wire to the ESP32
// -------------------------------------------------------------------------

test('a serial sink without navigator.serial explains the secure-context rule', async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    const sink = new SerialSink();
    await assert.rejects(() => sink.open(), /navigator\.serial is undefined/);
    await assert.rejects(() => sink.open(), /127\.0\.0\.1/);
    assert.equal(sink.connected, false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true });
  }
});

test('open() requests a port, opens it at the wire baud, and is idempotent', async () => {
  const port = fakePort();
  const sink = await connectedSink(port);
  try {
    assert.deepEqual(port.opened, { baudRate: DEFAULT_BAUD });
    assert.equal(sink.connected, true);

    const again = await sink.open();
    assert.equal(again, port, 'an open sink must not prompt for a port again');
  } finally {
    await sink.close();
  }
});

test('a port held by another program is reported as an actionable error', async () => {
  const port = fakePort({ openError: 'Permission denied' });
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: async () => port } },
    configurable: true,
    writable: true,
  });
  try {
    const sink = new SerialSink({ baud: 921600 });
    await assert.rejects(() => sink.open(), /Could not open ESP32 UART at 921600 baud/);
    await assert.rejects(() => sink.open(), /Close any monitor\/Arduino IDE holding that COM port/);
    assert.equal(sink.port, null, 'a failed open must not leave a half-open port');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true });
  }
});

test('bytes written to the wire are exactly what core/frame.js encoded', async () => {
  const port = fakePort();
  const sink = await connectedSink(port);
  try {
    const layout = new Layout();
    const panel = new Panel();
    panel.setPixel(0, 0, 255, 0, 0);
    panel.setPixel(19, 19, 0, 255, 0);
    const packed = pack(panel, layout);

    const wire = new Uint8Array(FRAME_BYTES);
    assert.equal(sink.send(encodeFrameInto(wire, 42, packed)), true);
    await settle();

    const onWire = port.written[0];
    assert.equal(onWire.length, FRAME_BYTES);
    assert.equal(onWire[0], FRAME_MAGIC);
    assert.equal(onWire[1], 42);
    assert.equal(onWire[FRAME_BYTES - 1], FRAME_END);

    // Payload offsets follow the layout, not the logical grid: cell (19,19) is
    // LED 380 on a snake-wired panel, so a test that assumed 399 would be wrong
    // the moment the wiring is re-calibrated.
    const at = (x, y) => layout.map[y * layout.cols + x] * 3;
    assert.deepEqual(Array.from(onWire.subarray(2 + at(0, 0), 2 + at(0, 0) + 3)), [255, 0, 0], '(0,0) on the wire');
    assert.deepEqual(Array.from(onWire.subarray(2 + at(19, 19), 2 + at(19, 19) + 3)), [0, 255, 0], '(19,19) on the wire');
    // 2 lit LEDs x 1 non-zero channel + magic + seq + end = 5. Anything else on
    // the wire would mean pack() smeared a pixel into the wrong LED.
    assert.equal(onWire.filter((b) => b !== 0).length, 5, 'only the two lit channels may be non-zero');
    assert.equal(sink.stats.bytes, FRAME_BYTES);
  } finally {
    await sink.close();
  }
});

test('the sink copies each record: reusing the frame buffer cannot corrupt bytes in transit', async () => {
  const port = fakePort({ hold: true });
  const sink = await connectedSink(port, { maxInFlight: 4 });
  try {
    const wire = new Uint8Array(FRAME_BYTES);
    const packed = new Uint8Array(RGB_BYTES).fill(200);
    encodeFrameInto(wire, 1, packed);
    assert.equal(sink.send(wire), true);

    // The renderer does exactly this on the next tick: overwrite the same buffer.
    wire.fill(0);
    wire[1] = 2;

    const onWire = port.written[0];
    assert.equal(onWire[1], 1, 'the queued frame must keep its own seq');
    assert.ok(onWire.subarray(2, 2 + RGB_BYTES).every((b) => b === 200), 'queued payload was overwritten');
    assert.notEqual(onWire, wire, 'the writer must not hold the caller-owned buffer');
  } finally {
    await sink.close();
  }
});

test('a frame is dropped, not queued, once the wire is full', async () => {
  const port = fakePort({ hold: true });
  const sink = await connectedSink(port);
  try {
    assert.equal(MAX_IN_FLIGHT, 2, 'two frames is what the ESP32 ring buffer can hold');

    for (let i = 0; i < MAX_IN_FLIGHT; i++) assert.equal(sink.send(sampleFrame()), true, `frame ${i}`);
    assert.equal(sink.inFlight, MAX_IN_FLIGHT);

    for (let i = 0; i < 5; i++) {
      assert.equal(sink.send(sampleFrame()), false, `frame ${MAX_IN_FLIGHT + i} must be dropped`);
    }
    assert.equal(port.written.length, MAX_IN_FLIGHT, 'the wire must not be overflown');
    assert.equal(sink.stats.sent, MAX_IN_FLIGHT);
    assert.equal(sink.stats.dropped, 5);
  } finally {
    await sink.close();
  }
});

test('a frame that never reaches the wire is counted as dropped, not sent', async () => {
  const sink = new SerialSink();
  assert.equal(sink.send(sampleFrame()), false);
  assert.equal(sink.stats.dropped, 1);
  assert.equal(sink.stats.sent, 0);
  assert.equal(sink.lastError, 'serial sink is not open');
});

test('a failed write retires the port and records why', async () => {
  const port = fakePort({ fail: true });
  const sink = await connectedSink(port);
  try {
    assert.equal(sink.send(sampleFrame()), true, 'the send is accepted before the write settles');
    await settle();
    await settle();

    assert.equal(sink.stats.errors, 1);
    assert.equal(sink.connected, false, 'an errored stream rejects every later write');
    assert.match(sink.lastError, /Serial write failed: UART buffer full/);
    assert.equal(sink.send(sampleFrame()), false, 'no further writes to a dead stream');
  } finally {
    await sink.close();
  }
});

test('pulling the cable while idle clears `connected` immediately', async () => {
  const port = fakePort();
  const sink = await connectedSink(port);
  try {
    assert.equal(sink.connected, true);
    port.emit('disconnect');

    assert.equal(sink.connected, false);
    assert.equal(sink.port, null);
    assert.equal(sink.lastError, 'The serial device disconnected.');
    assert.equal(sink.send(sampleFrame()), false);
  } finally {
    await sink.close();
  }
});

test('close() flushes queued frames, releases the port, and is idempotent', async () => {
  const port = fakePort();
  const sink = await connectedSink(port);

  sink.send(sampleFrame());
  sink.send(meta({ brightness: 255, limitMa: 8000 }));
  await sink.close();

  assert.equal(port.written.length, 2, 'queued frames must drain before the port goes');
  assert.equal(port.writerClosed, true);
  assert.equal(port.closed, true);
  assert.equal(sink.connected, false);
  assert.equal(port.listenerCount('disconnect'), 0, 'a close we started is not a cable pull');

  await sink.close();
  assert.equal(port.closed, true);
});

// -------------------------------------------------------------------------
// End-to-end: the bytes a sink writes are the bytes the wall decodes
// -------------------------------------------------------------------------

test('a stream through the serial sink decodes back to the exact panel', async () => {
  const port = fakePort();
  const sink = await connectedSink(port, { maxInFlight: 8 });
  const layout = new Layout();
  const wire = new Uint8Array(FRAME_BYTES);

  try {
    const panels = [];
    for (let seq = 0; seq < 4; seq++) {
      const panel = new Panel();
      panel.fill(seq * 10, 255 - seq * 40, seq * 5);
      panels.push(panel);
      sink.send(encodeFrameInto(wire, seq, pack(panel, layout)));
      if (seq === 1) sink.send(meta({ brightness: 180, limitMa: 5000 }));
    }
    await settle();

    const stream = new Uint8Array(port.written.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of port.written) {
      stream.set(chunk, at);
      at += chunk.length;
    }
    assert.equal(stream.length, 4 * FRAME_BYTES + META_BYTES, '4 frames + 1 meta on the wire');

    // Each chunk size is a separate decoder pass over the same bytes: a frame
    // must survive arriving as 1203 one-byte reads as well as one whole write.
    for (const size of [1, 7, 400, 999, 1203, stream.length]) {
      const decoder = new FrameDecoder();
      const frames = [];
      const metas = [];
      for (let i = 0; i < stream.length; i += size) {
        decoder.feed(stream.subarray(i, i + size), (f) => frames.push(f), (m) => metas.push(m));
      }

      assert.equal(frames.length, 4, `chunk ${size}: decoded ${frames.length} of 4 frames`);
      assert.equal(metas.length, 1, `chunk ${size}: meta`);
      assert.deepEqual(metas[0], { brightness: 180, limitMa: 5000 }, `chunk ${size}: meta fields`);
      assert.deepEqual(
        decoder.stats,
        { frames: 4, meta: 1, discarded: 0, resyncs: 0, rewinds: 0, gaps: 0 },
        `chunk ${size}: decoder stats`,
      );

      frames.forEach((f, i) => {
        assert.equal(f.seq, i, `chunk ${size}: seq`);
        // f.rgb is PHYSICAL order; unpack() is the inverse of the sender's pack().
        const round = unpack(f.rgb, layout);
        assert.ok(round.equals(panels[i]), `chunk ${size}: frame ${i} pixels`);
      });
    }
  } finally {
    await sink.close();
  }
});

test('one dropped byte costs one frame, not a run of black frames', async () => {
  const port = fakePort();
  const sink = await connectedSink(port, { maxInFlight: 8 });
  try {
    const SENT = 6;
    for (let seq = 0; seq < SENT; seq++) sink.send(frame(seq, new Uint8Array(RGB_BYTES).fill(100)));
    await settle();

    const clean = new Uint8Array(port.written.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of port.written) {
      clean.set(chunk, at);
      at += chunk.length;
    }
    assert.equal(clean.length, SENT * FRAME_BYTES);

    /**
     * Where the byte goes changes what the damage looks like, so each position
     * is pinned separately:
     *   - a payload byte breaks that frame's end check -> discarded + rewind
     *   - an end byte never arrives -> the frame is never started, visible only
     *     as a seq gap (what the firmware reports as stats.seqGaps)
     * In every case exactly one frame is lost and the rest are whole.
     */
    const drop = (at_) => {
      const damaged = new Uint8Array(clean.length - 1);
      damaged.set(clean.subarray(0, at_));
      damaged.set(clean.subarray(at_ + 1), at_);
      return damaged;
    };

    const cases = [
      ['payload byte', 600, { discarded: 1, rewinds: 1, gaps: 0, seqs: [1, 2, 3, 4, 5] }],
      ['end byte of frame 0', FRAME_BYTES - 1, { discarded: 1, rewinds: 1, gaps: 0, seqs: [1, 2, 3, 4, 5] }],
      ['end byte of frame 1', 2 * FRAME_BYTES - 1, { discarded: 1, rewinds: 1, gaps: 1, seqs: [0, 2, 3, 4, 5] }],
      ['magic byte of frame 1', FRAME_BYTES, { discarded: 0, rewinds: 0, gaps: 1, seqs: [0, 2, 3, 4, 5] }],
    ];

    for (const [label, at_, want] of cases) {
      const decoder = new FrameDecoder();
      const frames = decoder.feed(drop(at_));
      const lost = SENT - frames.length;

      assert.equal(lost, 1, `${label}: ${frames.length} of ${SENT} frames survived`);
      assert.deepEqual(
        frames.map((f) => f.seq),
        want.seqs,
        `${label}: which frame was lost`,
      );
      assert.equal(decoder.stats.discarded, want.discarded, `${label}: discarded`);
      assert.equal(decoder.stats.rewinds, want.rewinds, `${label}: rewinds`);
      assert.equal(decoder.stats.gaps, want.gaps, `${label}: the loss must be visible, not silent`);
      assert.ok(
        frames.every((f) => f.rgb.length === RGB_BYTES && f.rgb.every((b) => b === 100)),
        `${label}: a salvaged frame must be whole, not shifted`,
      );
    }
  } finally {
    await sink.close();
  }
});

// -------------------------------------------------------------------------
// BroadcastSink — the no-cable path
// -------------------------------------------------------------------------

test('two tabs on the same channel see each other, and never their own posts', async () => {
  const name = `led-wall-test-${process.pid}`;
  const sender = new BroadcastSink({ channel: name });
  const receiver = new BroadcastSink({ channel: name });
  const got = [];
  receiver.subscribe((b) => got.push(b));

  try {
    assert.equal(sender.connected, true);
    const f = sampleFrame();
    assert.equal(sender.send(f), true);

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.length, 1, 'the other tab must receive the frame');
    assert.deepEqual(Array.from(got[0]), Array.from(f));
    assert.notEqual(got[0], f, 'structured clone: the receiver owns its copy');
    assert.equal(sender.stats.received, 0, 'a tab must not receive its own post');
    assert.equal(receiver.stats.sent, 0);
  } finally {
    sender.close();
    receiver.close();
  }
});

test('a broadcast sink with no channel degrades to dropped, not a crash', () => {
  const Real = globalThis.BroadcastChannel;
  // What an opaque origin (file://) actually does: the constructor throws.
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    value: function throwing() {
      throw new Error('BroadcastChannel is not available in an opaque origin');
    },
    configurable: true,
    writable: true,
  });
  try {
    const sink = new BroadcastSink({ channel: 'led-wall-test-opaque' });
    assert.equal(sink.connected, false, 'a tab that cannot fan out is degraded, not broken');
    assert.equal(sink.send(sampleFrame()), false);
    assert.equal(sink.stats.dropped, 1);
    assert.equal(sink.stats.sent, 0);
    sink.close();
  } finally {
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: Real, configurable: true, writable: true });
  }
});

test('garbage on the channel is rejected before it reaches a listener', async () => {
  const name = `led-wall-test-junk-${process.pid}`;
  const sender = new BroadcastChannel(name);
  const receiver = new BroadcastSink({ channel: name });
  const got = [];
  receiver.subscribe((b) => got.push(b));

  try {
    sender.postMessage(new Uint8Array([9, 9, 9]));
    sender.postMessage('hello');
    sender.postMessage(new Uint8Array(FRAME_BYTES)); // right length, wrong magic
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(got.length, 0);
    assert.equal(receiver.stats.rejected, 3);
    assert.equal(receiver.stats.received, 0);
  } finally {
    sender.close();
    receiver.close();
  }
});

test('unsubscribe stops delivery', async () => {
  const name = `led-wall-test-unsub-${process.pid}`;
  const sender = new BroadcastSink({ channel: name });
  const receiver = new BroadcastSink({ channel: name });
  const got = [];
  const off = receiver.subscribe((b) => got.push(b));

  try {
    off();
    sender.send(sampleFrame());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.length, 0);
    assert.throws(() => receiver.subscribe('not a function'), /needs a function/);
  } finally {
    sender.close();
    receiver.close();
  }
});

// -------------------------------------------------------------------------
// openSink + wire-rate constants
// -------------------------------------------------------------------------

test('openSink builds every documented kind and rejects an unknown one', async () => {
  assert.deepEqual(SINK_KINDS, ['sim', 'broadcast', 'serial']);

  const sim = await openSink('sim');
  assert.equal(sim.kind, 'sim');
  const bc = await openSink('broadcast', { channel: `led-wall-test-open-${process.pid}` });
  assert.equal(bc.kind, 'broadcast');

  await assert.rejects(
    () => openSink('websocket'),
    /unknown sink kind "websocket"; expected one of sim, broadcast, serial/,
  );

  sim.close();
  bc.close();
});

test('the wire rate is derived from the frame size, not hand-typed', () => {
  assert.equal(DEFAULT_BAUD, 921600);
  assert.ok(Math.abs(WIRE_MS_PER_FRAME - (FRAME_BYTES * 10 * 1000) / DEFAULT_BAUD) < 1e-9);
  // 8N1: 10 bits per byte. This is the floor under the frame rate a serial sink
  // can sustain, and it is what PARTIAL_GAP_MS in the firmware is measured against.
  assert.ok(WIRE_MS_PER_FRAME > 12 && WIRE_MS_PER_FRAME < 14, `wire time ${WIRE_MS_PER_FRAME} ms`);
  assert.ok(MAX_IN_FLIGHT * FRAME_BYTES < 4096, 'in-flight frames must fit the ESP32 ring buffer');
});

// -------------------------------------------------------------------------
// Cross-language contract with firmware/sketch.ino
//
// The sketch cannot be compiled or run from this machine, so the only available
// ground truth for the C++ side is its declared constants. The wire format is a
// two-language contract: if either side drifts, the wall shows garbage. This
// test reads the sketch and pins every number the byte layout depends on.
// -------------------------------------------------------------------------

const SKETCH = readFileSync(fileURLToPath(new URL('../firmware/sketch.ino', import.meta.url)), 'utf8');

/**
 * Read one protocol constant out of the sketch. The sketch declares them two
 * ways — tunable ones as `#define`, frozen wire numbers as `static const` — so
 * the parser accepts both and only ever compares VALUES, never formatting.
 */
const constant = (name) => {
  const m =
    SKETCH.match(new RegExp(`#define\\s+${name}\\s+([0-9]+)`)) ??
    SKETCH.match(new RegExp(`static\\s+const\\s+\\w+\\s+${name}\\s*=\\s*(0x[0-9A-Fa-f]+|[0-9]+)`));
  if (m === null) throw new Error(`firmware/sketch.ino no longer declares ${name}`);
  return parseInt(m[1], 0); // 0x-prefixed magics parse as hex, plain numbers as decimal
};

test('the firmware declares the same protocol constants as core/frame.js', () => {
  assert.equal(constant('NUM_LED'), LED_COUNT);
  assert.equal(constant('BAUD'), DEFAULT_BAUD);
  assert.equal(constant('LED_BYTES'), RGB_BYTES);
  assert.equal(constant('FRAME_BYTES'), FRAME_BYTES);
  assert.equal(constant('META_BYTES'), META_BYTES);
  assert.equal(constant('CHANNEL_MA'), 20, 'core/power.js assumes 20 mA per channel');

  assert.equal(constant('FRAME_MAGIC'), FRAME_MAGIC);
  assert.equal(constant('META_MAGIC'), META_MAGIC);
  assert.equal(constant('FRAME_END'), FRAME_END);
});

test('the firmware ring buffer holds the frames the browser is allowed to have in flight', () => {
  const ring = constant('SERIAL_RX_BYTES');
  assert.ok(
    MAX_IN_FLIGHT * FRAME_BYTES <= ring,
    `${MAX_IN_FLIGHT} frames = ${MAX_IN_FLIGHT * FRAME_BYTES} B exceeds the ${ring} B UART buffer`,
  );
});

test('the firmware brightness cap matches the core current model', () => {
  // sketch maxBrightnessForLimit(): b = min(255, limit * 255 / (NUM_LED * 3 * CHANNEL_MA))
  const cap = (limit) => Math.min(255, Math.floor((limit * 255) / (constant('NUM_LED') * 3 * constant('CHANNEL_MA'))));

  // The cap is only a guard if feeding it back through the sketch's own
  // fullWhiteMa() stays under the declared limit.
  const fullWhiteMa = (b) => Math.floor((constant('NUM_LED') * 3 * constant('CHANNEL_MA') * b) / 255);
  for (const limit of [4000, 8000, 12000, 18000, 24000]) {
    assert.ok(fullWhiteMa(cap(limit)) <= limit, `limit ${limit} mA: cap ${cap(limit)} draws ${fullWhiteMa(cap(limit))} mA`);
    assert.ok(limit < 24000 ? cap(limit) < 255 : cap(limit) === 255, `limit ${limit} mA clamp`);
  }
  assert.equal(cap(8000), 85, 'the documented 8 A figure');
  assert.equal(cap(24000), 255, 'full budget means no clamp');
  assert.equal(cap(0), 0, 'a zero budget must go dark, not stay lit');

  // The sketch documents its cap as a table in a comment. If the formula and the
  // table disagree, whoever reads the comment calibrates the PSU wrong.
  const table = [...SKETCH.matchAll(/limit\s+(\d+)\s*mA\s*->\s*B_max\s+(\d+)/g)].map(
    ([_, limitText, capText]) => [Number(limitText), Number(capText)],
  );
  assert.ok(table.length >= 4, 'the sketch documents a limit -> B_max table');
  for (const [limit, documented] of table) {
    assert.equal(cap(limit), documented, `sketch documents ${limit} mA -> ${documented}`);
  }
});

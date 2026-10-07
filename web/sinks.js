/**
 * sinks — how finished frames leave the renderer.
 *
 * One interface, `send(bytes)`, three implementations: the local canvas sim, a
 * same-origin tab-to-tab fan-out, and Web Serial to the ESP32. Every sink takes
 * exactly what core/frame.js produces — a complete 1203-byte frame or a 5-byte
 * meta record — and checks only length + magic before handing it on. Real
 * validation is core/frame.js FrameDecoder's job on both ends, so the sim and
 * the wall agree on what a "complete frame" means and a frame that looks right
 * on screen is the frame the wall gets.
 *
 * Dropping is a designed outcome, not a failure. The firmware renders the last
 * COMPLETE frame it saw and discards a partial one, so skipping a frame costs
 * one frame of motion. Queueing frames the wire cannot carry costs an unbounded
 * buffer and, eventually, a frame boundary landing mid-way through an overflowed
 * UART ring buffer — which loses real bytes, not just frames. Every sink
 * therefore has a bounded output and counts its drops in `stats`.
 *
 * Browser APIs only: navigator.serial and BroadcastChannel. No DOM, no fetch,
 * no timers.
 */

import { FRAME_BYTES, FRAME_MAGIC, META_BYTES, META_MAGIC } from '../core/frame.js';

/** Wire rate; must match firmware/sketch.ino's -D BAUD=921600. */
export const DEFAULT_BAUD = 921600;

/**
 * 8N1 costs 10 bits per byte, so one frame is ~13 ms of wire time at 921600 —
 * the floor under the frame rate a serial sink can actually sustain. Derived
 * from the protocol constants so it cannot drift from the frame size.
 */
export const WIRE_MS_PER_FRAME = (FRAME_BYTES * 10 * 1000) / DEFAULT_BAUD;

/**
 * Frames allowed on the wire at once. The ESP32 gives its UART ~4096 bytes of
 * ring buffer (firmware SERIAL_RX_BYTES) — three frames. Two in flight keeps the
 * host ahead of the device without ever overflowing it. A tab throttled to the
 * background and then resumed would otherwise dump its whole backlog at once and
 * corrupt frame boundaries; dropping is strictly better than bursting.
 */
export const MAX_IN_FLIGHT = 2;

/** Channel both tabs must agree on for the broadcast sink. */
export const CHANNEL = 'led-wall';

/**
 * FrameSink — the common shape. `send(bytes)` accepts one complete record from
 * core/frame.js and returns whether it was handed off or dropped, so a hot frame
 * loop never has to try/catch a transport.
 *
 * Subclasses MUST implement send(); close() is a no-op here because the base
 * holds nothing to release.
 */
export class FrameSink {
  /** @param {string} kind one of SINK_KINDS */
  constructor(kind) {
    this.kind = kind;
    /** Same counters on every sink so the UI can treat them alike. */
    this.stats = { sent: 0, dropped: 0, rejected: 0, meta: 0 };
  }

  /**
   * @param {Uint8Array} bytes one complete frame or meta record
   * @returns {boolean} true if handed off, false if dropped/rejected
   */
  send(bytes) {
    throw new Error(`${this.kind} sink does not implement send()`);
  }

  /** Release everything this sink holds. Idempotent. */
  close() {}
}

/**
 * Sim sink — the bytes go straight back into the page that produced them. No
 * transport, so it cannot fail; it is also the reference path the other two are
 * measured against, which is the point of the shared interface.
 */
export class SimSink extends FrameSink {
  /**
   * @param {object} [opts]
   * @param {(bytes: Uint8Array) => void} [opts.onFrame] receives every record unchanged
   */
  constructor({ onFrame } = {}) {
    super('sim');
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    /**
     * References to the bytes last handed to send(), not copies: the sim wants
     * the current frame, and copying 1203 bytes per tick to alias it would be
     * pure waste. `lastFrame` skips meta records so a UI can show frame bytes.
     */
    this.last = null;
    this.lastFrame = null;
  }

  send(bytes) {
    const kind = classify(bytes);
    if (kind === null) {
      this.stats.rejected++;
      return false;
    }
    this.stats.sent++;
    if (kind === 'meta') this.stats.meta++;
    this.last = bytes;
    if (kind === 'frame') this.lastFrame = bytes;
    this.onFrame?.(bytes);
    return true;
  }
}

/**
 * BroadcastSink — same-origin tab-to-tab fan-out over BroadcastChannel, so a
 * second tab can show (or record) exactly what the first tab is sending without
 * a server. A receiving tab hands the received bytes to FrameDecoder unchanged.
 */
export class BroadcastSink extends FrameSink {
  /**
   * @param {object} [opts]
   * @param {string} [opts.channel] channel name, shared by both tabs
   * @param {(bytes: Uint8Array) => void} [opts.onFrame] called with every record
   *   that arrives from another tab (this tab's own posts are never echoed back)
   */
  constructor({ channel = CHANNEL, onFrame } = {}) {
    super('broadcast');
    this.channelName = channel;
    this.channel = null;
    /**
     * BroadcastChannel construction can throw in an opaque origin (file://).
     * A tab that cannot fan out is a degraded tab, not a crash: the sim keeps
     * running and `stats.sent` stays 0 so the UI can say so.
     */
    try {
      if (typeof BroadcastChannel !== 'undefined') this.channel = new BroadcastChannel(channel);
    } catch {
      this.channel = null;
    }
    this.stats.received = 0;
    this.listeners = new Set(typeof onFrame === 'function' ? [onFrame] : []);
    if (this.channel !== null) {
      this.channel.onmessage = (event) => this.#receive(event.data);
    }
  }

  /** True when this tab actually has a channel to talk on. */
  get connected() {
    return this.channel !== null;
  }

  /**
   * Add a receiving-side listener (e.g. one that feeds a FrameDecoder).
   * @param {(bytes: Uint8Array) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe(fn) needs a function');
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  send(bytes) {
    const kind = classify(bytes);
    if (kind === null) {
      this.stats.rejected++;
      return false;
    }
    if (this.channel === null) {
      this.stats.dropped++;
      return false;
    }
    /**
     * postMessage structured-clones the typed array: the receiving tab gets its
     * own copy it can feed to FrameDecoder without worrying about the sender
     * reusing its scratch buffer, and the sender's buffer stays reusable too.
     */
    this.channel.postMessage(bytes);
    this.stats.sent++;
    if (kind === 'meta') this.stats.meta++;
    return true;
  }

  #receive(data) {
    const bytes = asBytes(data);
    if (bytes === null || classify(bytes) === null) {
      this.stats.rejected++;
      return;
    }
    this.stats.received++;
    for (const fn of this.listeners) fn(bytes);
  }

  close() {
    const channel = this.channel;
    if (channel === null) return;
    this.channel = null;
    this.listeners.clear();
    try {
      channel.close();
    } catch {
      // Already closed by the browser; nothing left to release.
    }
  }
}

/**
 * SerialSink — Web Serial to the ESP32. One port, one writer, held open for the
 * whole session: the writer serialises `write()` calls, so a frame handed over in
 * one call is one contiguous run of bytes on the wire and two frames can never
 * interleave.
 */
export class SerialSink extends FrameSink {
  /**
   * @param {object} [opts]
   * @param {number} [opts.baud]
   * @param {number} [opts.maxInFlight] frames queued on the wire at once
   */
  constructor({ baud = DEFAULT_BAUD, maxInFlight = MAX_IN_FLIGHT } = {}) {
    super('serial');
    this.baud = baud;
    this.maxInFlight = maxInFlight;
    this.port = null;
    this.writer = null;
    this.inFlight = 0;
    /** Human-readable reason for the last failure, for the connect UI. */
    this.lastError = null;
    this.stats.bytes = 0;
    this.stats.errors = 0;
  }

  get connected() {
    return this.writer !== null;
  }

  /**
   * Ask the browser for a port and open it. Idempotent: an already-open sink
   * returns its port instead of prompting again.
   * @returns {Promise<SerialPort>}
   */
  async open() {
    if (this.port !== null) return this.port;

    const serial = globalThis.navigator?.serial;
    if (serial === undefined || serial === null) {
      // Loud on purpose: the cause is the URL in the address bar, and a silent
      // no-op here would look like a broken cable.
      throw new Error(serialUnavailableMessage());
    }

    let port;
    try {
      port = await serial.requestPort();
    } catch (err) {
      throw new Error(
        'No serial port was selected, so the wall cannot be driven over USB. ' +
          'Pick the ESP32 COM/UART port in the browser prompt (or reconnect the cable).',
        { cause: err },
      );
    }

    try {
      await port.open({ baudRate: this.baud });
    } catch (err) {
      throw new Error(
        `Could not open ${portName(port)} at ${this.baud} baud. ` +
          'Close any monitor/Arduino IDE holding that COM port, then connect again.',
        { cause: err },
      );
    }

    this.port = port;
    try {
      this.writer = port.writable.getWriter();
    } catch (err) {
      this.port = null;
      await closePort(port, this.#onDisconnect);
      throw new Error('The port opened but its writable stream was unavailable.', { cause: err });
    }
    // Keep `connected` honest when the cable is pulled while idle, instead of
    // only discovering it on the next failed write.
    port.addEventListener('disconnect', this.#onDisconnect);
    this.lastError = null;
    return port;
  }

  send(bytes) {
    const kind = classify(bytes);
    if (kind === null) {
      this.stats.rejected++;
      return false;
    }
    if (this.writer === null) {
      this.stats.dropped++;
      if (this.lastError === null) this.lastError = 'serial sink is not open';
      return false;
    }
    if (this.inFlight >= this.maxInFlight) {
      // The wire is still carrying an earlier frame; skip this one rather than
      // grow a queue. See MAX_IN_FLIGHT.
      this.stats.dropped++;
      return false;
    }

    /**
     * Copy, deliberately: the stream holds this chunk until the UART has drained
     * it (~13 ms), and the renderer reuses its frame buffer on the next tick.
     * Handing the writer a caller-owned buffer would let the next frame overwrite
     * bytes still in transit — the one way this protocol can be corrupted.
     */
    const chunk = bytes.slice();
    this.inFlight++;
    this.stats.sent++;
    this.stats.bytes += chunk.length;
    if (kind === 'meta') this.stats.meta++;

    this.writer.write(chunk).then(
      () => {
        this.inFlight--;
      },
      (err) => {
        this.inFlight--;
        this.stats.errors++;
        // A stream that has errored rejects every later write; stop pretending
        // the port is usable and let the UI report why.
        this.writer = null;
        this.lastError = `Serial write failed: ${reason(err)}`;
      },
    );
    return true;
  }

  /** Flush queued writes, then release the port. Idempotent. */
  async close() {
    const port = this.port;
    const writer = this.writer;
    this.port = null;
    this.writer = null;
    if (writer !== null) {
      try {
        // writer.close() waits for the frames already queued to drain.
        await writer.close();
      } catch {
        // Broken or already-closed stream; port.close() below is what matters.
      }
    }
    if (port !== null) await closePort(port, this.#onDisconnect);
  }

  #onDisconnect = () => {
    if (this.port === null) return;
    this.writer = null;
    this.port = null;
    this.lastError = 'The serial device disconnected.';
  };
}

/** Every sink kind openSink() understands. */
export const SINK_KINDS = ['sim', 'broadcast', 'serial'];

/**
 * Build a sink, and for the serial kind connect it.
 *
 * Only 'serial' can fail, and only for reasons a person can act on (no secure
 * context, no port chosen, port held by another program). 'sim' and 'broadcast'
 * degrade instead of throwing, so a renderer can always draw.
 *
 * @param {'sim'|'broadcast'|'serial'} kind
 * @param {object} [opts] forwarded to the sink's constructor
 * @returns {Promise<FrameSink>}
 */
export async function openSink(kind, opts = {}) {
  switch (kind) {
    case 'sim':
      return new SimSink(opts);
    case 'broadcast':
      return new BroadcastSink(opts);
    case 'serial': {
      const sink = new SerialSink(opts);
      await sink.open();
      return sink;
    }
    default:
      throw new Error(
        `unknown sink kind ${JSON.stringify(kind)}; expected one of ${SINK_KINDS.join(', ')}`,
      );
  }
}

/**
 * Length + magic only. Anything else is not a record this protocol recognises,
 * and pushing a wrong-length payload at the firmware would shift every frame
 * boundary after it — so it is refused before it reaches the wire.
 * @returns {'frame'|'meta'|null}
 */
function classify(bytes) {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof Uint8ClampedArray)) return null;
  if (bytes.length === FRAME_BYTES) return bytes[0] === FRAME_MAGIC ? 'frame' : null;
  if (bytes.length === META_BYTES) return bytes[0] === META_MAGIC ? 'meta' : null;
  return null;
}

/** A postMessage clone can arrive as an ArrayBuffer; normalise it. */
function asBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return value;
  return null;
}

/**
 * Close a port whatever state it is in. The disconnect listener is removed first
 * so a close we initiated cannot be reported to the UI as a cable pull.
 */
async function closePort(port, onDisconnect) {
  port.removeEventListener?.('disconnect', onDisconnect);
  try {
    await port.close();
  } catch {
    // Already closed, or closed by the browser after a disconnect.
  }
}

function portName(port) {
  const info = port?.getInfo?.();
  return info?.usbProductName ?? info?.productName ?? 'the selected port';
}

function reason(err) {
  return err?.message ?? String(err);
}

/**
 * Web Serial is gated on a secure context, which is exactly why tools/serve.js
 * binds 127.0.0.1 only. "navigator.serial is undefined" is not actionable on
 * its own — the fix is the URL in the address bar.
 */
function serialUnavailableMessage() {
  const where = globalThis.location?.href ?? 'this page';
  if (globalThis.isSecureContext === true) {
    return (
      `Web Serial is unavailable in this browser: navigator.serial is undefined even though ` +
      `${where} is a secure context. Web Serial is Chromium-only, so use the broadcast sink ` +
      '(or a Chromium-based browser) to drive the wall.'
    );
  }
  return (
    `Web Serial is unavailable: navigator.serial is undefined, so no port can be requested. ` +
    `The page is loaded from ${where}. navigator.serial exists only in a secure context — ` +
    'open the app at http://127.0.0.1:<port> (loopback counts) or any https:// origin. ' +
    'A LAN address such as http://192.168.1.20:8080 is not a secure context and never ' +
    'exposes the serial API. Run `npm run serve`, which binds 127.0.0.1 for exactly this ' +
    'reason, and open the loopback URL it prints; otherwise use the broadcast sink.'
  );
}

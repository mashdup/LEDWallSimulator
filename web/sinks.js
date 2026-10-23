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

import {
  FRAME_BYTES,
  FRAME_MAGIC,
  META_BYTES,
  META_MAGIC,
  OFFSET_RGB,
  RGB_BYTES,
  LED_COUNT,
} from '../core/frame.js';

/** Wire rate; must match firmware/firmware.ino's -D BAUD=921600. */
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
 * SerialPortSink — the shared half of every Web Serial sink: acquire the port,
 * hold at most MAX_IN_FLIGHT records on the wire, notice a cable pull.
 *
 * Subclasses supply `encode(record)`: the bytes to write for one record, or null
 * when this transport has nothing to send for it. The returned buffer belongs to
 * the sink, not the caller — the stream holds it until the UART has drained
 * (~13 ms), while the renderer reuses its own buffer on the very next tick — so
 * an encode that would alias its input has to copy. See SerialSink.encode.
 */
class SerialPortSink extends FrameSink {
  /**
   * @param {string} kind
   * @param {object} [opts]
   * @param {number} [opts.baud]
   * @param {number} [opts.maxInFlight] records queued on the wire at once
   */
  constructor(kind, { baud = DEFAULT_BAUD, maxInFlight = MAX_IN_FLIGHT } = {}) {
    super(kind);
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
   * Wire bytes for one record, or null to send nothing for it.
   * @abstract
   * @param {Uint8Array} bytes one complete frame or meta record
   * @param {'frame'|'meta'} kind already classified by send()
   * @returns {Uint8Array|null}
   */
  encode() {
    throw new Error(`${this.kind} sink does not implement encode()`);
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

    let port = null;
    // A port the user has granted before needs NO gesture to open; a fresh
    // requestPort() does. Preferring the granted port is the difference
    // between 'a reload darkens the wall' (a browser can only ask a human)
    // and 'the wall heals itself' (Electron grants at install, so the
    // reloaded page reopens COM8 on its own, and an ESP32 that
    // re-enumerates mid-show streams again without a click).
    try {
      const granted = await serial.getPorts();
      if (Array.isArray(granted) && granted.length > 0) port = granted[granted.length - 1];
    } catch {
      // No getPorts on this engine: the picker decides, as before.
    }
    if (port === null) {
      try {
        port = await serial.requestPort();
      } catch (err) {
        throw new Error(
          'No serial port was selected, so the wall cannot be driven over USB. ' +
            'Pick the ESP32 COM/UART port in the browser prompt (or reconnect the cable).',
          { cause: err },
        );
      }
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

    // The chip may have been left in the bootloader by the last session's
    // death; a reset pulse is what makes 'kill the app, launch again' work.
    await resetIntoRunMode(port);

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
      if (this.lastError === null) this.lastError = `${this.kind} sink is not open`;
      return false;
    }

    const chunk = this.encode(bytes, kind);
    if (chunk === null) {
      // This transport has nothing to send for this record — WLED has no meta
      // record at all. Accepted, and deliberately not counted as a frame.
      this.stats.meta++;
      return true;
    }

    if (this.inFlight >= this.maxInFlight) {
      // The wire is still carrying earlier records; skip this one rather than
      // grow a queue. See MAX_IN_FLIGHT.
      this.stats.dropped++;
      return false;
    }

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
    // A close the app asked for is final: the reconnect watcher is armed only
    // by a cable pull, and a deliberate Disconnect must not be undone.
    this.reconnectArmed = false;
    // Leave the chip in RUN mode. The driver's close defaults deassert both
    // lines, and deasserted DTR holds IO0 LOW through the auto-reset
    // circuit - so the chip reboots into the BOOTLOADER on every app close,
    // and the next app opens a port to a dark wall ('connected', streaming,
    // nothing lit). Pulse a clean run-mode boot before letting go.
    if (port !== null) await resetIntoRunMode(port);
    if (writer !== null) {
      try {
        // writer.close() waits for the records already queued to drain.
        await writer.close();
      } catch {
        // Broken or already-closed stream; port.close() below is what matters.
      }
    }
    if (port !== null) await closePort(port, this.#onDisconnect);
  }

  #onDisconnect = () => {
    if (this.port === null) return;
    const port = this.port;
    const writer = this.writer;
    this.writer = null;
    this.port = null;
    this.lastError = 'The serial device disconnected.';
    // A disconnected port is NOT a closed port. The browser keeps it — and
    // its OS handle in the serial service, which lives in the BROWSER
    // process — open until the page calls close(). This wall draws amps, a
    // bright frame can sag USB, and the ESP32's port re-enumerates: every
    // cycle used to leak one port forever, because close() reads this.port
    // and this handler had just nulled it. Hours of a show is hundreds of
    // leaked handles in the process that paints the page — which is the
    // plain-grey-screen-with-no-Aw-Snap symptom this now fixes. Release the
    // writer lock and close the port the device left behind.
    try {
      writer?.releaseLock();
    } catch {
      // The disconnect already killed the stream; there is no lock to let go.
    }
    closePort(port, this.#onDisconnect).catch(() => {});
    // Then arm for the cable's return: the ESP32 re-enumerates within
    // seconds of a sag, the grant rides with the device, so getPorts()
    // hands back a usable port and the stream resumes with no human and no
    // gesture. One-shot per pull; a failed open re-arms for the next try.
    this.#armReconnect();
  };

  #armReconnect() {
    const serial = globalThis.navigator?.serial;
    if (serial === undefined || serial === null || typeof serial.addEventListener !== 'function') return;
    this.reconnectArmed = true;
    serial.addEventListener('connect', () => {
      this.open().then(
        () => { this.reconnectArmed = false; },
        () => { if (this.reconnectArmed) this.#armReconnect(); },
      );
    }, { once: true });
  }
}

/**
 * SerialSink — Web Serial to the ESP32 running firmware/firmware.ino, sending
 * this repo's own 1203-byte frame records unchanged.
 */
export class SerialSink extends SerialPortSink {
  constructor(opts) {
    super('serial', opts);
  }

  /**
   * Copy, deliberately: the stream holds this chunk until the UART has drained
   * it (~13 ms), and the renderer reuses its frame buffer on the next tick.
   * Handing the writer a caller-owned buffer would let the next frame overwrite
   * bytes still in transit — the one way this protocol can be corrupted.
   */
  encode(bytes) {
    return bytes.slice();
  }
}

/** Bytes before the pixel data in an Adalight frame: 'A' 'd' 'a' hi lo checksum. */
const ADALIGHT_HEADER = 6;

/**
 * AdalightSink — Web Serial to WLED, framed as WLED's serial realtime input.
 *
 *   'A' 'd' 'a'  hi  lo  checksum        checksum = hi ^ lo ^ 0x55
 *   <1200 bytes of pixel data, in the strip's own wire order>
 *
 * 1206 bytes for 400 LEDs. This exists because WLED's Apa106 driver is the one
 * proven against this panel: our own RMT bit timing has never been validated
 * against these beads, and the symptom of getting it slightly wrong is beads
 * misreading bits — a flicker synchronised to frames, with every host-side
 * counter reporting success.
 *
 * Two requirements, both measured on this wall:
 *   - **WLED's own output must be off.** Realtime replaces its strip buffer per
 *     frame but does not suspend the renderer, so a running effect repaints
 *     between frames and shows through as colour tracking your frames.
 *   - **Baud is advisory.** The ESP32-S3 presents native USB-CDC, so the rate is
 *     set by USB, not by this number.
 *
 * WLED has no meta record: brightness rides in the frame bytes, and WLED's own
 * `bri` is a separate control. A meta record is accepted and ignored.
 */
export class AdalightSink extends SerialPortSink {
  constructor(opts) {
    super('adalight', opts);
    /** The brightness the page declared via meta. WLED has no meta record, so
     *  this sink folds it into the frame bytes — the one place WLED will see
     *  it. Scales like the firmware: (v * b) >> 8, 255 = no scaling. */
    this.brightness = 255;
  }

  encode(bytes, kind) {
    if (kind !== 'frame') {
      // Meta layout: 0xA4 | brightness | limitLo | limitHi | 0x5A. Nothing
      // goes on the wire for it, but the brightness must be remembered.
      if (kind === 'meta') this.brightness = bytes[1];
      return null;
    }

    /*
     * The header carries the LED count MINUS ONE — that is Adalight's convention,
     * not an off-by-one. WLED's parser (wled00/wled_serial.cpp) does
     * `count += next + 1` while reading the two count bytes, then consumes
     * exactly `count` pixels.
     *
     * Send the raw count and WLED reads one pixel past the payload: it swallows
     * the next frame's first three header bytes, so that frame's header never
     * matches and the whole record is discarded as garbage. The result is frames
     * landing intermittently — flicker — while every byte of every frame that
     * does sync is perfectly correct, and WLED's strip buffer reads back clean.
     */
    const n = LED_COUNT - 1;
    const hi = (n >> 8) & 0xff;
    const lo = n & 0xff;
    const out = new Uint8Array(ADALIGHT_HEADER + RGB_BYTES);
    out[0] = 0x41; // 'A'
    out[1] = 0x64; // 'd'
    out[2] = 0x61; // 'a'
    out[3] = hi;
    out[4] = lo;
    out[5] = hi ^ lo ^ 0x55;
    out.set(bytes.subarray(OFFSET_RGB, OFFSET_RGB + RGB_BYTES), ADALIGHT_HEADER);
    if (this.brightness < 255) {
      const b = this.brightness;
      for (let i = ADALIGHT_HEADER; i < out.length; i++) out[i] = (out[i] * b) >> 8;
    }
    return out;
  }
}

/**
 * HttpSink — frames to the local dev server, which forwards them to the wall as
 * DDP. A browser cannot send UDP, so this is the only way the page itself can
 * drive WLED: tools/serve.js owns the socket.
 *
 * Meta records are forwarded too, unchanged. The server's DDP transport applies a
 * meta record's brightness to the frames that follow it, which is exactly what
 * the firmware does with it — so the page's brightness slider keeps working.
 *
 * Backpressure matches every other sink: at most maxInFlight requests outstanding,
 * and a frame is dropped rather than queued, because a growing queue means the
 * wall is displaying a frame from seconds ago.
 */
export class HttpSink extends FrameSink {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] endpoint the dev server exposes
   * @param {number} [opts.maxInFlight] requests outstanding at once
   */
  constructor({ url = '/frame', maxInFlight = MAX_IN_FLIGHT } = {}) {
    super('http');
    this.url = url;
    this.maxInFlight = maxInFlight;
    this.inFlight = 0;
    /** Human-readable reason for the last failure, for the connect UI. */
    this.lastError = null;
    this.stats.bytes = 0;
    this.stats.errors = 0;
  }

  send(bytes) {
    const kind = classify(bytes);
    if (kind === null) {
      this.stats.rejected++;
      return false;
    }
    if (this.inFlight >= this.maxInFlight) {
      this.stats.dropped++;
      return false;
    }
    this.inFlight += 1;
    this.stats.sent += 1;
    if (kind === 'meta') this.stats.meta += 1;
    this.stats.bytes += bytes.length;
    // A copy: fetch reads the body asynchronously, and the renderer reuses its
    // buffer for the next frame, so aliasing it would post whatever is current
    // when the request is finally serialised.
    const body = bytes.slice();
    fetch(this.url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        this.lastError = null;
      })
      .catch((err) => {
        this.stats.errors += 1;
        this.lastError = reason(err);
      })
      .finally(() => {
        this.inFlight -= 1;
      });
    return true;
  }
}

/** Every sink kind openSink() understands. */
export const SINK_KINDS = ['sim', 'broadcast', 'serial', 'adalight', 'http'];

/**
 * Build a sink, and for the serial kind connect it.
 *
 * Only 'serial' can fail, and only for reasons a person can act on (no secure
 * context, no port chosen, port held by another program). 'sim' and 'broadcast'
 * degrade instead of throwing, so a renderer can always draw.
 *
 * @param {'sim'|'broadcast'|'serial'|'http'} kind
 * @param {object} [opts] forwarded to the sink's constructor
 * @returns {Promise<FrameSink>}
 */
export async function openSink(kind, opts = {}) {
  switch (kind) {
    case 'sim':
      return new SimSink(opts);
    case 'broadcast':
      return new BroadcastSink(opts);
    case 'http':
      return new HttpSink(opts);
    case 'serial':
    case 'adalight': {
      const sink = kind === 'serial' ? new SerialSink(opts) : new AdalightSink(opts);
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

/**
 * esptool-style hard reset into RUN mode, for the classic DTR->IO0 /
 * RTS->EN transistor auto-reset circuit (measured on this board, and the
 * reason 'kill the app, relaunch, wall dark' alternated):
 *
 *   DTR asserted  -> IO0 HIGH (Q1 off, pull-up wins)   -> boot into firmware
 *   DTR deasserted-> IO0 LOW  (Q1 on, pulls IO0 down)  -> boot into BOOTLOADER
 *   RTS asserted  -> EN LOW (Q2 on)                    -> chip held in reset
 *
 * The old pulse left DTR deasserted while pulsing RTS, so the chip came
 * out of reset with IO0 LOW - straight into the bootloader. The pulse
 * itself was stranding the chip, and the driver's close sequence (both
 * signals deasserted) did the same on every app close: works, fails,
 * works, fails. The fix is esptool's reset_to_run: assert DTR (IO0 HIGH)
 * FIRST and hold it, pulse RTS (reset), release RTS - the chip boots
 * with IO0 HIGH and runs the firmware.
 */
async function resetIntoRunMode(port) {
  try {
    await port.setSignals({ dataTerminalLow: true, requestToSendLow: true });
    await new Promise((r) => setTimeout(r, 100));
    await port.setSignals({ dataTerminalLow: true, requestToSendLow: false });
  } catch {
    // Drivers without modem control (virtual ports, some adapters): nothing
    // to pulse, and the chip is already running. Not a connection failure.
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

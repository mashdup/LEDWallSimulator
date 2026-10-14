// wallcheck — is the sink actually healthy? One connection, one verdict.
//
// The device's own counters are the only thing that can tell "the bytes arrived"
// from "the bytes were lost", and reading them naively lies in two ways:
//
//  1. DTR/RTS toggling on this board's auto-reset circuit reboots the ESP32, so the
//     counters do not survive a close and reopen — a second run always opens onto a
//     freshly-booted zero. Read them in a different connection from the one that
//     streamed and the answer is always 0, which is exactly what made the first
//     `bridge.js` runs look like frames=0 while the wall was fine, and why this
//     tool holds one handle for the whole run.
//  2. A still wall is not re-sent frame by frame — both drivers skip an unchanged
//     image, so a static pattern measures almost nothing. This streams a moving
//     gradient, where every frame is a real frame on the wire.
//
// Difference against the sketch's own counters matters too: this build reports
// `disc`/`resync`/`rewind` separately, and the interesting number is `resync`,
// which counts bytes seen between frames. On a clean transport it sits at zero.
//
// Usage:
//   node tools/wallcheck.js --port COM8
//   node tools/wallcheck.js --port COM8 --seconds 30 --verbose
//   node tools/wallcheck.js --port COM8 --fault      # prove the resync works

import { pathToFileURL } from 'node:url';

import { frame, meta, FRAME_MAGIC, FRAME_END, RGB_BYTES } from '../core/frame.js';
import { parseStatusLine } from './bridge.js';

export const DEFAULT_BAUD = 921600;
export const DEFAULT_SECONDS = 15;
export const DEFAULT_FPS = 20;
export const DEFAULT_BRIGHTNESS = 255;
export const DEFAULT_LIMIT_MA = 24000;

/** How long to wait for the sink to say anything at all. A reset plus boot is ~2 s. */
export const BOOT_TIMEOUT_MS = 8000;
/** The status line is printed at 1 Hz, so a fresh one is at most this far away. */
export const STATUS_PERIOD_MS = 1300;

/**
 * A moving gradient. Every frame differs from the last, so nothing is skipped as
 * a still wall and every frame is a genuine test of the transport.
 */
export function gradient(seq) {
  const pixels = new Uint8Array(RGB_BYTES);
  for (let i = 0; i < RGB_BYTES; i += 3) {
    const led = i / 3;
    pixels[i] = (led + seq * 7) & 0xff;
    pixels[i + 1] = (led * 3 + seq * 11) & 0xff;
    pixels[i + 2] = 128;
  }
  return pixels;
}

/**
 * A frame exactly one payload byte short.
 *
 * Sent immediately before a good frame, this is the sharpest test the protocol
 * has: the decoder reads the short record plus that frame's magic as its 1202nd
 * body byte, the end check fails, and the rescan finds the magic *inside the
 * record it just rejected* and replays from there. The good frame is then still
 * decoded. That recovery is the entire difference between this sink and Adalight,
 * which would corrupt the short frame and the next one.
 */
export function shortFrame(seq) {
  return Buffer.concat([
    Buffer.from([FRAME_MAGIC, seq & 0xff]),
    new Uint8Array(RGB_BYTES - 1),
    Buffer.from([FRAME_END]),
  ]);
}

/** Boot banner and status lines share the `wall ` prefix; only one is a reading. */
export function classifyLine(line) {
  const text = line.trim();
  if (text.startsWith('wall sink ready')) return { kind: 'boot', raw: text };
  return parseStatusLine(text);
}

/**
 * Compare the counters either side of a run and say whether the transport held.
 *
 * @param {object} run
 * @param {number} run.sent good frames the host wrote (the injected fault excluded)
 * @param {object} run.before status before the stream
 * @param {object} run.after status after it
 * @param {boolean} [run.fault] whether a short frame was injected
 * @returns {{ok: boolean, reasons: string[], delta: object|null, lost: number}}
 */
export function judge({ sent, before, after, fault = false }) {
  if (!before || !after) {
    return { ok: false, reasons: ['no status line from the device'], delta: null, lost: 0 };
  }
  if (after === before) {
    return { ok: false, reasons: ['the device printed no new status line during the run'], delta: null, lost: 0 };
  }

  const delta = {
    frames: after.frames - before.frames,
    meta: after.meta - before.meta,
    discarded: after.discarded - before.discarded,
    resyncs: after.resyncs - before.resyncs,
    rewinds: after.rewinds - before.rewinds,
    seqGaps: after.seqGaps - before.seqGaps,
  };

  const reasons = [];
  // One frame may still be in flight when the last status line is printed, so a
  // single frame of slack is honest rather than lenient.
  const lost = sent - delta.frames;
  if (lost > 1) reasons.push(`${lost} of ${sent} frames never decoded`);

  if (fault) {
    // The fault must be SEEN and RECOVERED. A transport that eats the short frame
    // before the decoder sees it reports disc=0, which is not a pass: the resync
    // path was never exercised.
    if (delta.discarded < 1) reasons.push('the injected short frame was never discarded — the transport ate it before the decoder saw it');
    if (delta.rewinds < 1) reasons.push('the short frame was discarded but the rescan did not recover the frame after it');
  } else {
    if (delta.discarded) reasons.push(`${delta.discarded} record(s) discarded`);
    if (delta.resyncs) reasons.push(`${delta.resyncs} resync(s) — bytes are being lost somewhere before the decoder`);
    if (delta.rewinds) reasons.push(`${delta.rewinds} rescan(s)`);
    // One gap is the stream restart, not a fault. The sink tracks the last sequence
    // it saw so it can report a dropped frame, but it does not print that number
    // back, so a fresh run cannot continue it — and this tool always starts at 0.
    // A whole frame lost in transport shows up in `frames` as well, which is the
    // direct measurement, so gaps only mean something past that one restart.
    if (delta.seqGaps > 1) {
      reasons.push(`${delta.seqGaps} sequence gaps — more than the single restart gap a fresh run always shows`);
    }
  }

  return { ok: reasons.length === 0, reasons, delta, lost };
}

/**
 * Exit status is the verdict: 0 healthy, 1 not, 2 the run never started (bad
 * arguments, port would not open, device silent). 2 is separate so a wrapper can
 * tell "the wall is losing frames" from "I never reached the wall".
 */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }
  if (!opts.port) {
    console.error('wallcheck: --port is required. List ports with: node tools/bridge.js --list');
    return 2;
  }

  let SerialPort;
  try {
    ({ SerialPort } = await import('serialport'));
  } catch (err) {
    console.error(`wallcheck: needs the serialport package (${err.message}); run npm install`);
    return 2;
  }

  const port = new SerialPort({ path: opts.port, baudRate: opts.baud, autoOpen: false });
  const seen = { latest: null, boot: null, count: 0 };

  let partial = '';
  port.on('data', (chunk) => {
    partial += chunk.toString('latin1');
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const raw = partial.slice(0, nl).replace(/\r$/, '');
      partial = partial.slice(nl + 1);
      if (!raw.startsWith('wall ')) continue;
      const parsed = classifyLine(raw);
      if (!parsed) continue;
      if (parsed.kind === 'boot') { seen.boot = parsed.raw; continue; }
      seen.latest = parsed;
      seen.count++;
      if (opts.verbose) console.log(`  ${raw}`);
    }
  });

  try {
    await new Promise((done, fail) => {
      port.open((err) => {
        if (!err) return done();
        // "Access denied" on a port that is listed means someone else holds it,
        // and on this machine that is usually a serial monitor left open or a
        // second agent session streaming the same wall.
        const busy = /denied|busy|in use/i.test(err.message);
        return fail(new Error(
          `cannot open ${opts.port}: ${err.message}`
          + (busy ? ' — another process is holding the port. Close any serial monitor or other session streaming this wall, then retry.' : ''),
        ));
      });
    });
    console.log(`wallcheck: ${opts.port} @ ${opts.baud}`);

    // The first status line proves the sink is alive and gives the baseline. Every
    // number in the verdict is a delta, so it does not matter whether this board
    // just booted or has been running for an hour — except for the sequence, which
    // judge() accounts for.
    await until(() => seen.latest !== null, BOOT_TIMEOUT_MS, 'the device printed no status line');
    if (seen.boot) console.log(`  ${seen.boot}`);

    const before = seen.latest;
    const total = Math.round(opts.seconds * opts.fps);
    const faultAt = opts.fault ? Math.floor(total / 2) : -1;
    console.log(
      `  streaming ${total} frames at ${opts.fps} fps for ${opts.seconds}s`
      + `${opts.fault ? ', plus one deliberate short frame' : ''}`,
    );

    await write(port, Buffer.from(meta({ brightness: opts.brightness, limitMa: opts.limit })));

    const interval = 1000 / opts.fps;
    const started = Date.now();
    let seq = 0;
    let sent = 0;
    for (let i = 0; i < total; i++) {
      if (i === faultAt) {
        await write(port, shortFrame(seq));
        seq = (seq + 1) & 0xff;
      }
      await write(port, Buffer.from(frame(seq, gradient(seq))));
      seq = (seq + 1) & 0xff;
      sent++;
      const wait = started + (i + 1) * interval - Date.now();
      if (wait > 0) await sleep(wait);
    }

    // The reading has to come from this same handle: close and reopen and the
    // counters are zero again, which is the trap this tool exists to avoid.
    await until(() => seen.latest !== before, STATUS_PERIOD_MS, 'the device stopped printing status');

    const after = seen.latest;
    const verdict = judge({ sent, before, after, fault: opts.fault });
    console.log(`  device frames=${after.frames} meta=${after.meta} disc=${after.discarded} resync=${after.resyncs} rewind=${after.rewinds} gaps=${after.seqGaps} br=${after.brightness}/${after.brightnessCap} state=${after.state}`);
    if (verdict.delta) {
      const d = verdict.delta;
      console.log(`  delta  frames=+${d.frames} meta=+${d.meta} disc=+${d.discarded} resync=+${d.resyncs} rewind=+${d.rewinds} gaps=+${d.seqGaps}`);
    }

    if (verdict.ok) {
      const restart = verdict.delta.seqGaps === 1 ? ', one restart gap' : '';
      console.log(`  PASS — ${verdict.delta.frames}/${sent} frames decoded${opts.fault ? ', fault discarded and recovered' : ', no bytes lost'}${restart}`);
      return 0;
    }
    console.log('  FAIL');
    for (const reason of verdict.reasons) console.log(`    - ${reason}`);
    return 1;
  } catch (err) {
    console.error(`wallcheck: ${err.message}`);
    return 2;
  } finally {
    await new Promise((done) => port.close(() => done()));
  }
}

// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    port: null,
    baud: DEFAULT_BAUD,
    seconds: DEFAULT_SECONDS,
    fps: DEFAULT_FPS,
    brightness: DEFAULT_BRIGHTNESS,
    limit: DEFAULT_LIMIT_MA,
    fault: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const need = (name) => {
      if (i + 1 >= argv.length) throw new RangeError(`${name} needs a value`);
      return argv[++i];
    };
    switch (argv[i]) {
      case '--port': opts.port = need('--port'); break;
      case '--baud': opts.baud = Number(need('--baud')); break;
      case '--seconds': opts.seconds = Number(need('--seconds')); break;
      case '--fps': opts.fps = Number(need('--fps')); break;
      case '--brightness': opts.brightness = Number(need('--brightness')); break;
      case '--limit': opts.limit = Number(need('--limit')); break;
      case '--fault': opts.fault = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new RangeError(`unknown option ${argv[i]}`);
    }
  }
  if (!(opts.seconds > 0)) throw new RangeError(`--seconds must be > 0, got ${opts.seconds}`);
  if (!(opts.fps > 0)) throw new RangeError(`--fps must be > 0, got ${opts.fps}`);
  return opts;
}

function printHelp() {
  console.log(`wallcheck — stream a moving pattern and read the sink's own counters back.

Usage: node tools/wallcheck.js --port COM8 [options]

  --port <path>      serial port (required); list with: node tools/bridge.js --list
  --seconds <n>      how long to stream (default ${DEFAULT_SECONDS})
  --fps <n>          frames per second (default ${DEFAULT_FPS})
  --brightness <n>   meta brightness to send first (default ${DEFAULT_BRIGHTNESS})
  --limit <mA>       meta current budget to send first (default ${DEFAULT_LIMIT_MA})
  --fault            inject one frame a payload byte short. It must be discarded
                     AND recovered, with every real frame still decoded
  --baud <n>         wire rate (default ${DEFAULT_BAUD})
  --verbose          echo every status line as it arrives

Exit status: 0 healthy, 1 frames lost, 2 the run never reached the device.`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function write(port, bytes) {
  return new Promise((done, fail) => port.write(bytes, (err) => (err ? fail(err) : done())));
}

async function until(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(25);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => {
    console.error(`wallcheck: ${err.message}`);
    return 2;
  });
}

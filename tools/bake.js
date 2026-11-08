/**
 * bake.js — turn a gallery into a `.ledshow` the wall can play with nothing
 * attached, and optionally push it down the cable.
 *
 * WHY A BAKER AND NOT A FIRMWARE RENDERER
 * ---------------------------------------
 * `core/showfile.js` has the long version. The short one: the two transforms a
 * frame needs — the layout permutation and the LED fine-tune — already exist in
 * core/ and already run identically in Node and in the page. A baked frame is
 * therefore a photograph of the wall: `animFrame` → `packInto` → `applyColor`,
 * the same three calls web/app.js's frame loop makes. The device only plays what
 * comes out, so a baked gallery cannot look different from the streamed one.
 *
 * That is also the trade, and it is worth being blunt about: this is a SNAPSHOT.
 * Change the fine-tune or re-measure the wiring and the file is stale — the
 * fingerprint in the header is how you find out (see core/showfile.js,
 * "The fingerprint"). Re-run the bake.
 *
 * USAGE
 * -----
 *   node tools/bake.js                        # the wall's own gallery → data/show.led
 *   node tools/bake.js --out data/xmas.led --interval 10 --gap 3
 *   node tools/bake.js --solid '#ff8800' --solid '#00ff66'
 *   node tools/bake.js --upload COM6          # bake, then send it to the wall
 *   node tools/bake.js --info data/show.led   # what is in this file
 *   node tools/bake.js --verify data/show.led # walk every slot's clock
 *
 * The LED fine-tune flags are the console's sliders, spelled the way
 * `web/app.js` persists them (`wall.settings.v1` in localStorage). The baker
 * cannot read a browser's localStorage, so on a calibrated wall copy the values
 * out of the console's readout line:
 *
 *   node tools/bake.js --saturation 1.15 --gamma 2 --temperature 0.1 --black-level 6
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Panel } from '../core/panel.js';
import { Layout } from '../core/layout.js';
import { packInto } from '../core/buffer.js';
import { applyColor, COLOR_DEFAULTS } from '../core/color.js';
import { animFrame } from '../core/animations.js';
import { DrawingStore } from '../core/drawing-store.js';
import { estimateCurrentMa, WS2812_CHANNEL_MA } from '../core/power.js';
import {
  SHOW_DEFAULTS,
  TRANSITION_NAMES_BAKED,
  calibrationFingerprint,
  crc32,
  showBytes,
  parseShow,
  describeShow,
  showTiming,
  showFrameAt,
  showPeriodMs,
  showBlendMs,
} from '../core/showfile.js';
import { SerialTransport, parseLayoutFlags } from './bridge.js';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STORE = resolve(REPO, 'data/drawings.json');
const DEFAULT_OUT = resolve(REPO, 'data/show.led');

/** One upload chunk. Must be <= the firmware's SHOW_CHUNK_MAX (1024). */
const UPLOAD_CHUNK = 1024;
const CHUNK_MAGIC = 0xa3;
const COMMIT_MAGIC = 0xa2;
const RECORD_END = 0x5b;

export function usage() {
  return `bake a gallery into a show the wall can play with no host attached

  node tools/bake.js [source] [options]

source (default: the wall's own gallery)
  --store <file>        a drawing store JSON (default data/drawings.json)
  --solid <#rgb|#rrggbb> one solid drawing; repeat, in order
  --info <file.ledshow> print a show's header and exit
  --verify <file.ledshow> walk the show's clock and check every slot

options
  --out <file>          where to write (default data/show.led)
  --interval <s>        seconds per drawing (${SHOW_DEFAULTS.intervalSec})
  --gap <s>             seconds of break between drawings (${SHOW_DEFAULTS.gapSec})
  --transition <name>   ${TRANSITION_NAMES_BAKED.join(' | ')} (${SHOW_DEFAULTS.transition})
  --transition-ms <ms>  blend length at each seam (${SHOW_DEFAULTS.transitionMs})
  --brightness <0-255>  the brightness the show is baked for (${SHOW_DEFAULTS.brightness})
  --limit <mA>          the power budget it is baked for (${SHOW_DEFAULTS.limitMa})
  --saturation <n> --gamma <n> --temperature <n> --tint <n> --black-level <n>
                        the LED fine-tune, as the console's sliders show it
  --layout <spec>       wiring flags: snake, flipX, flipY, transpose, axis=x|y,
                        strip=<n>, start=<a/b/c>   (default: core/layout.js)
  --reverse             bake the gallery newest-first
  --upload <port>       send it to the wall over serial after writing (e.g. COM6)
  --dry-run             build and describe, write nothing
  --json                print the summary as JSON (for a script)
`;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function num(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

export function parseArgs(argv) {
  const opts = {
    store: DEFAULT_STORE,
    out: DEFAULT_OUT,
    solids: [],
    info: null,
    verify: null,
    intervalSec: SHOW_DEFAULTS.intervalSec,
    gapSec: SHOW_DEFAULTS.gapSec,
    transition: SHOW_DEFAULTS.transition,
    transitionMs: SHOW_DEFAULTS.transitionMs,
    brightness: SHOW_DEFAULTS.brightness,
    limitMa: SHOW_DEFAULTS.limitMa,
    color: { ...COLOR_DEFAULTS },
    layoutSpec: '',
    reverse: false,
    upload: null,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--help': case '-h': throw new Error(usage());
      case '--store': opts.store = resolve(next()); break;
      case '--out': opts.out = resolve(next()); break;
      case '--solid': opts.solids.push(next()); break;
      case '--info': opts.info = resolve(next()); break;
      case '--verify': opts.verify = resolve(next()); break;
      case '--interval': opts.intervalSec = num(next(), '--interval'); break;
      case '--gap': opts.gapSec = num(next(), '--gap'); break;
      case '--transition': opts.transition = next(); break;
      case '--transition-ms': opts.transitionMs = num(next(), '--transition-ms'); break;
      case '--brightness': opts.brightness = num(next(), '--brightness'); break;
      case '--limit': opts.limitMa = num(next(), '--limit'); break;
      case '--saturation': opts.color.saturation = num(next(), '--saturation'); break;
      case '--gamma': opts.color.gamma = num(next(), '--gamma'); break;
      case '--temperature': opts.color.temperature = num(next(), '--temperature'); break;
      case '--tint': opts.color.tint = num(next(), '--tint'); break;
      case '--black-level': opts.color.blackLevel = num(next(), '--black-level'); break;
      case '--layout': opts.layoutSpec = next(); break;
      case '--reverse': opts.reverse = true; break;
      case '--upload': opts.upload = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      default: throw new Error(`unknown option ${arg}\n\n${usage()}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

/**
 * One drawing -> one 1200-byte wire frame.
 *
 * This is web/app.js's frame loop with the parts a still picture does not need:
 * `animFrame({kind:'pic'})` is the exact expression the app feeds a gallery slot,
 * and it is the reason a baked drawing and a streamed one are the same bytes —
 * including the treatment of a transparent cell, which renders as its stored
 * RGB (the editor's eraser writes 0,0,0,0), not as a composite over anything.
 */
function bakeFrame(pixelsHex, panel, layout, packed, color) {
  const rgb = animFrame({ kind: 'pic', pixels: pixelsHex }, 0, panel.cols);
  panel.pixels.set(rgb);
  packInto(panel, layout, packed);
  // In place, and after packing: applyColor is per-pixel, so packing first is
  // identical to packing after — and it is what makes the fine-tune land on the
  // bytes that leave, which is the whole point (see core/color.js).
  applyColor(packed, color);
  return packed.slice();
}

/** A solid colour as a drawing, so `--solid` needs no store and no editor. */
export function solidPixels(css) {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(css).trim());
  if (m === null) throw new Error(`--solid needs #rgb or #rrggbb, got ${JSON.stringify(css)}`);
  const h = m[1];
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const out = [];
  // A drawing is RGBA per cell; alpha 255 = used, so the cell renders as painted.
  for (let i = 0; i < 400; i++) out.push(r, g, b, 255);
  return Buffer.from(out).toString('hex');
}

/**
 * Collect the cues, in play order.
 *
 * The store's order is admission order, which is the order the gallery cycled in
 * — so a bake of a live gallery reproduces the show the wall has been running.
 * `--reverse` is there because the last few drawings are usually the newest and
 * the ones a party remembers.
 */
export function collectCues(opts) {
  if (opts.solids.length > 0) {
    return opts.solids.map((css, i) => ({ name: `solid ${css}`, pixels: solidPixels(css), i }));
  }
  const store = new DrawingStore(opts.store).load();
  const cues = store.list.map((e, i) => ({ name: e.name || `drawing ${i + 1}`, pixels: e.pixels, i }));
  if (cues.length === 0) {
    throw new Error(
      `no drawings in ${opts.store} — save some from the wall's editor first, `
      + 'or bake solids with --solid',
    );
  }
  return opts.reverse ? cues.reverse() : cues;
}

/**
 * Bake. Returns `{file, header, frames, source}` without touching the disk, so
 * `--dry-run`, `--json` and the tests all get the same object.
 */
export function bake(opts) {
  const cues = collectCues(opts);
  const layout = new Layout(parseLayoutFlags(opts.layoutSpec));
  const panel = new Panel(layout.cols, layout.rows);
  const packed = new Uint8Array(panel.byteLength);

  const frames = cues.map((cue) => bakeFrame(cue.pixels, panel, layout, packed, opts.color));

  /* Worst-case current, computed the way the estimator intends: the worst FRAME
   * at the brightness the show will run at, not the average. The device cannot
   * estimate this — it has no idea what a colour costs — so the number is baked
   * in and printed in the boot banner. It is also the check that catches a bake
   * made for a bigger supply than the one on the table. */
  let worstMa = 0;
  for (const f of frames) {
    const ma = estimateCurrentMa(f, { perChannelMa: WS2812_CHANNEL_MA });
    const scaled = Math.round((ma * opts.brightness) / 255);
    if (scaled > worstMa) worstMa = scaled;
  }

  const fingerprint = calibrationFingerprint({ layout, color: opts.color });

  const file = showBytes({
    frames,
    intervalSec: opts.intervalSec,
    gapSec: opts.gapSec,
    transition: opts.transition,
    transitionMs: opts.transitionMs,
    brightness: opts.brightness,
    limitMa: opts.limitMa,
    worstMa,
    fingerprint,
    tuned: Object.entries(COLOR_DEFAULTS).some(([k, v]) => opts.color[k] !== v),
  });

  return { file, cues, frames, fingerprint, worstMa };
}

// ---------------------------------------------------------------------------
// Inspecting
// ---------------------------------------------------------------------------

export function readShow(path) {
  const show = parseShow(new Uint8Array(readFileSync(path)));
  if (show === null) {
    throw new Error(`${path} is not a show this firmware can play (magic, version, length or crc)`);
  }
  return show;
}

/**
 * Walk the show's clock from start to one full period past the last slot, and
 * report what each moment resolves to.
 *
 * This is the check a bake deserves and a screenshot cannot give: it proves the
 * wrap, both seams of every slot, and that no instant resolves to a partial
 * frame that is neither a drawing nor black. It runs the same `showTiming` /
 * `showFrameAt` the firmware's arithmetic is pinned against, so a slot boundary
 * that lands in the wrong place on the wall fails HERE rather than at the party.
 */
export function verifyShow(show) {
  const period = showPeriodMs(show.header);
  const blend = showBlendMs(show.header);
  const problems = [];
  const slots = [];

  for (let slot = 0; slot < show.header.count; slot++) {
    const t0 = slot * period;
    const draw = showTiming(t0 + Math.floor(blend) + 1, show.header);
    if (draw.kind !== 'drawing') problems.push(`slot ${slot}: ${Math.floor(blend) + 1} ms in is a ${draw.kind}`);
    if (draw.idx !== slot) problems.push(`slot ${slot}: resolves to drawing ${draw.idx}`);
    const frame = showFrameAt(show, t0 + Math.floor(blend) + 1);
    if (frame.length !== 1200) problems.push(`slot ${slot}: frame is ${frame.length} bytes`);
    if (blend > 0) {
      // The opening seam must begin at black-or-previous and end on the drawing.
      const start = showFrameAt(show, t0);
      const end = showFrameAt(show, t0 + blend);
      if (!start.every((v) => v === 0) && show.header.gapSec > 0) {
        problems.push(`slot ${slot}: the seam does not open from black`);
      }
      if (!end.every((v, i) => v === show.frames[slot][i])) {
        problems.push(`slot ${slot}: the seam does not land on the drawing`);
      }
    }
    slots.push({ slot, idx: draw.idx, periodMs: period, blendMs: blend });
  }

  // The wrap: one period after the last slot is the first drawing again.
  const wrap = showTiming(show.header.count * period + Math.floor(blend) + 1, show.header);
  if (wrap.idx !== 0) problems.push(`wrap resolves to drawing ${wrap.idx}, not 0`);

  return { slots, periodMs: period, blendMs: blend, problems };
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

const le32 = (v) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
const le16 = (v) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff]);

/**
 * Push a show down the serial cable.
 *
 * Records are contiguous and offset-checked, so the device refuses a stream with
 * a hole in it instead of writing one — see the firmware's RX_SHOW_HEAD. The
 * commit record carries the size and a crc of the WHOLE file; the device has been
 * checksumming as it wrote, so the comparison is one integer and the file is
 * either exactly what was sent or it is not kept.
 */
export async function uploadShow(file, port, { log = console.log } = {}) {
  const transport = new SerialTransport({ path: port });
  await transport.open();
  const lines = transport.lines()[Symbol.asyncIterator]();
  try {
    // Give the firmware a moment to settle after the DTR pulse before the first
    // record; a chunk that lands mid-boot is counted as resync noise.
    await transport.sleep(250);

    /* The wall sets the pace, not this loop.
     *
     * A flash write takes milliseconds and a 921600 UART fills the device's 4 KB
     * ring in ~44 ms, so an unpaced upload overruns it while the wall is in
     * LittleFS — and the symptom is a chunk whose tail byte silently never
     * arrives. Measured: a 6 KB show aborted every time unpaced, and the same
     * file at 60 ms per chunk landed first try. So each chunk is acknowledged
     * (`upload: chunk <bytes>`) and the next one waits for it. That makes the
     * upload exactly as fast as the flash, and turns a lost record into a
     * specific error at the chunk that was lost rather than a twenty-second
     * silence at commit time. */
    const WAIT_MS = 15_000;
    const FAIL = /^upload: (aborted|refused|rename failed)/;

    const waitFor = async (match, what) => {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return { ok: false, line: `upload: no ${what} from the wall` };
        const next = await Promise.race([
          lines.next(),
          transport.sleep(left).then(() => ({ timedOut: true })),
        ]);
        if (next.timedOut || next.done) return { ok: false, line: `upload: no ${what} from the wall` };
        const line = next.value;
        if (FAIL.test(line)) return { ok: false, line };
        if (match(line)) return { ok: true, line };
      }
    };

    let offset = 0;
    let seq = 0;
    while (offset < file.length) {
      const len = Math.min(UPLOAD_CHUNK, file.length - offset);
      const record = new Uint8Array(1 + 1 + 4 + 2 + len + 1);
      record[0] = CHUNK_MAGIC;
      record[1] = seq & 0xff;
      record.set(le32(offset), 2);
      record.set(le16(len), 6);
      record.set(file.subarray(offset, offset + len), 8);
      record[record.length - 1] = RECORD_END;

      if (transport.send(record) === false) {
        return { ok: false, line: `upload: the port refused a chunk at ${offset}` };
      }
      offset += len;
      seq++;

      const ack = await waitFor((l) => l === `upload: chunk ${offset}`, `ack for the chunk at ${offset - len}`);
      if (!ack.ok) return ack;
      if ((seq & 0x0f) === 0) log(`upload: ${offset}/${file.length} B`);
    }

    const commit = new Uint8Array(1 + 4 + 4 + 1);
    commit[0] = COMMIT_MAGIC;
    commit.set(le32(file.length), 1);
    commit.set(le32(crc32(file)), 5);
    commit[commit.length - 1] = RECORD_END;
    if (transport.send(commit) === false) {
      return { ok: false, line: 'upload: the port refused the commit record' };
    }

    // The verdict, not an assumption: the wall refuses a bad crc, an unplayable
    // header, or a rename it cannot do, and all three are things a caller has to
    // see.
    return await waitFor((l) => l.startsWith('upload: ok'), 'verdict');
  } finally {
    await transport.close();
  }
}

// crc32 comes from core/showfile.js with the rest of the format — one
// implementation, so an upload and a file on disk are checksummed by the same
// arithmetic the device mirrors.

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.info !== null) {
    const show = readShow(opts.info);
    console.log(`${opts.info}: ${describeShow(show.header)}`);
    console.log(`  ${show.header.fileBytes} bytes, ${show.header.fileBytes ? (show.header.fileBytes / 1024).toFixed(1) : 0} KiB`);
    return 0;
  }

  if (opts.verify !== null) {
    const show = readShow(opts.verify);
    const v = verifyShow(show);
    console.log(`${opts.verify}: ${describeShow(show.header)}`);
    console.log(`  period ${v.periodMs} ms, blend ${v.blendMs} ms, ${v.slots.length} slots`);
    for (const p of v.problems) console.log(`  FAIL ${p}`);
    if (v.problems.length === 0) console.log('  ok: every slot resolves to its own drawing, both seams land');
    return v.problems.length === 0 ? 0 : 1;
  }

  const { file, cues, fingerprint, worstMa } = bake(opts);
  const header = parseShow(file).header;

  if (opts.json) {
    console.log(JSON.stringify({
      out: opts.dryRun ? null : opts.out,
      bytes: file.length,
      fingerprint,
      worstMa,
      header,
      cues: cues.map((c) => c.name),
    }, null, 2));
  } else {
    console.log(`baked ${cues.length} drawing(s) from ${opts.solids.length > 0 ? '--solid' : opts.store}`);
    console.log(`  ${describeShow(header)}`);
    console.log(`  ${file.length} bytes (${(file.length / 1024).toFixed(1)} KiB), fingerprint ${fingerprint}`);
    if (header.worstMa > header.limitMa) {
      console.log(
        `  WARNING worst frame ${header.worstMa}mA is over the ${header.limitMa}mA budget: `
        + 'the wall will clamp its brightness at boot, and the show will run dimmer than baked',
      );
    }
    if (!header.tuned) {
      console.log('  note: the LED fine-tune is neutral — on a calibrated wall, bake with its sliders');
    }
  }

  if (!opts.dryRun) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, file);
    if (!opts.json) console.log(`  wrote ${opts.out}`);
  }

  if (opts.upload !== null) {
    if (opts.dryRun) throw new Error('--upload and --dry-run do not go together');
    if (!opts.json) console.log(`  uploading to ${opts.upload} ...`);
    const result = await uploadShow(file, opts.upload, { log: opts.json ? () => {} : console.log });
    if (opts.json) console.log(JSON.stringify({ upload: result }, null, 2));
    else console.log(`  ${result.line}`);
    if (!result.ok) return 1;
  }
  return 0;
}

/* Run as a program, not as a module: the tests import `bake` and `verifyShow`
 * from here, and a `main()` that fires on import would bake on `import`. */
const ENTRY = process.argv[1] ? resolve(process.argv[1]) : '';
if (ENTRY === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`bake: ${err.message}`);
    process.exit(1);
  });
}

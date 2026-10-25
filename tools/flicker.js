// Flicker probe: drive the wall at a CONTROLLED arrival rate, with a controlled
// pattern, and read the board's own counters back in the same second.
//
// The wall's two flicker stories look the same from the floor and are opposite in
// the fix, so the point of this tool is to separate them:
//
//   --fill rrggbb   a FLAT FIELD. The host sends the same 1200 bytes every frame,
//                   so no content exists to blame: no rasteriser, no desync, no
//                   torn frame, no dropped byte. Runs of beads in colours nobody
//                   asked for, on a flat field with disc=0/resync=0, are the beads
//                   misreading bits — electrical, and no firmware change moves it.
//   --fps 60        the arrival-rate ceiling. 400 APA106 beads are 30 bits each at
//                   a ~1.7 us bit, so one refresh is ~20 ms of wire: ~49 fps. Send
//                   faster than that, or in bursts, and the stream collapses
//                   (measured at 60 fps: ~36 of 57 frames/s decoded, disc~10/s,
//                   resync 1000-4000/s). Nothing may stream this wall past ~45.
//   --pace burst    makes the burstiness visible: a UART paces one frame per ~13 ms
//                   at 921600, USB-CDC delivers a whole frame at once, and only the
//                   second one lands while the previous refresh is still clocking
//                   out. That is what the rig's `torn=` counter counts.
//   --sweep         brightness steps, because a bit-timing fault is brightness-
//                   independent and a supply sag is not. The board caps brightness
//                   by the declared limit (400 beads x 3 ch x channel mA), so a
//                   sweep has to move the limit with it.
//
// Close the app first: the port is single-open. `node tools/freeport.js <port>`
// names the holder.
//
// Usage:
//   node tools/flicker.js --fill ff0000 --duration 45000        # the flat-field test
//   node tools/flicker.js --fps 60                              # over the ceiling
//   node tools/flicker.js --fps 42 --pace burst --burst 3       # burst vs paced
//   node tools/flicker.js --pattern checker --duration 25000 \
//        --sweep 40:8000,85:8000,140:20000,195:40000,255:80000
import { frame, meta, nextSeq, LED_COUNT, RGB_BYTES } from '../core/frame.js';

const USAGE = `flicker probe — controlled arrival rate + the board's counters, same second

  node tools/flicker.js [--port P] [--fps N] [--duration MS] [--pattern sweep|checker]
                        [--fill rrggbb] [--pace spaced|burst] [--burst N]
                        [--bri N] [--limit MA] [--sweep bri:lim,bri:lim,...]

  --fill      flat field: the same 1200 bytes every frame (the electrical test)
  --fps       arrival rate; the strip's refresh caps it near 49 (default 30)
  --pace      burst sends N frames back-to-back, the way USB-CDC delivers them
  --sweep     brightness steps as bri:limit pairs, printed as they are applied
  --duration  per run, ms (default 12000)

The port is single-open: close the app, and "node tools/freeport.js <port>" to see
who is holding it. Watch the WALL while this runs, and note the second of any
flicker against the banners it prints.`;

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? dflt : argv[i + 1];
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const PORT = arg('port', process.env.WALL_PORT || '/dev/cu.usbmodem59810005071');
const FPS = Math.max(1, Math.min(200, Number(arg('fps', 30)) || 30));
const DURATION = Math.max(500, Number(arg('duration', 12000)) || 12000);
const PACE = arg('pace', 'spaced') === 'burst' ? 'burst' : 'spaced';
const BURST = Math.max(1, Number(arg('burst', 3)) || 3);
const BRI = Math.max(0, Math.min(255, Number(arg('bri', 195)) || 0));
const LIMIT = Math.max(500, Number(arg('limit', 8000)) || 8000);
const FILL = /^[0-9a-fA-F]{6}$/.test(arg('fill', '')) ? arg('fill').toLowerCase() : null;
const PATTERN = arg('pattern', 'sweep') === 'checker' ? 'checker' : 'sweep';
const period = Math.max(1, Math.round(1000 / FPS));

// Brightness is capped by the declared limit, so a step moves both. Pairs are
// bri:limit; a bare number keeps --limit.
const STEPS = (arg('sweep', '') || '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [b, l] = s.split(':').map(Number);
    return Number.isFinite(b) ? { bri: b, lim: Number.isFinite(l) ? l : LIMIT } : null;
  })
  .filter(Boolean);

/** A moving high-contrast column: maximal byte churn, easy for an eye to catch. */
function sweep(t) {
  const rgb = new Uint8Array(RGB_BYTES);
  const col = Math.floor(t / period / 3) % 20;
  for (let i = 0; i < LED_COUNT; i++) {
    const c = i % 20;
    const on = c === col ? 255 : c === (col + 1) % 20 ? 96 : 0;
    rgb.set([on, on, on], i * 3);
  }
  return rgb;
}

/**
 * A chessboard that swaps every frame: maximum CURRENT churn as well as byte
 * churn. A bead that misreads bits and a bead whose supply sags look identical
 * for one frame; the discriminator is brightness, so pair this with --sweep.
 */
function checker(t) {
  const rgb = new Uint8Array(RGB_BYTES);
  const phase = Math.floor(t / period) % 2;
  for (let i = 0; i < LED_COUNT; i++) {
    const on = (((i / 20) | 0) + (i % 20) + phase) % 2 === 0 ? 255 : 0;
    rgb.set([on, on, on], i * 3);
  }
  return rgb;
}

/** A flat field: the same 1200 bytes every frame. See --fill in the header. */
function flat() {
  const rgb = new Uint8Array(RGB_BYTES);
  const r = parseInt(FILL.slice(0, 2), 16);
  const g = parseInt(FILL.slice(2, 4), 16);
  const b = parseInt(FILL.slice(4, 6), 16);
  for (let i = 0; i < LED_COUNT; i++) rgb.set([r, g, b], i * 3);
  return rgb;
}

const draw = FILL ? flat : PATTERN === 'checker' ? checker : sweep;

const counters = { frames: 0, meta: 0, disc: 0, resync: 0, rewind: 0, gaps: 0, torn: null };
// The board's counters are CUMULATIVE for its whole uptime, so the first delta
// must be taken against the board's own first report, not against zero. Baseline
// against zero and the first line reads as a catastrophe: every corrupt byte
// since the last power-on, attributed to one second.
let base = null;
let written = 0;
let line = '';

function onData(d) {
  line += d.toString('latin1');
  const parts = line.split(/\r?\n/);
  line = parts.pop();
  for (const l of parts) {
    const m = /frames=(\d+)\D+meta=(\d+)\D+disc=(\d+)\D+resync=(\d+)\D+rewind=(\d+)\D+gaps=(\d+)(?:\D+torn=(\d+))?/.exec(l);
    if (!m) continue;
    counters.frames = +m[1];
    counters.meta = +m[2];
    counters.disc = +m[3];
    counters.resync = +m[4];
    counters.rewind = +m[5];
    counters.gaps = +m[6];
    counters.torn = m[7] === undefined ? null : +m[7];
    if (base === null) base = { ...counters, t: Date.now(), written };
  }
}

function report() {
  if (base === null) {
    console.log('  (no status line from the board yet — is the port open elsewhere, and is this the rig build?)');
    return;
  }
  const now = Date.now();
  const d = (k) => counters[k] - base[k];
  // `gaps` is NOT a wire fault. The rig counts a status window in which frames
  // arrived and NO meta frame did (usermod.cpp noteGap(): statusFrames > 0 &&
  // !statusMetaSeen), so a sender that sends frames and no metas ticks it once a
  // second by construction. The wire counters are disc/resync/rewind (+ torn on a
  // build that has it), and decoded==written is the clean statement.
  const loss = d('disc') + d('resync') + d('rewind') + (counters.torn === null ? 0 : d('torn'));
  const sent = written - base.written;
  const torn = counters.torn === null ? '' : ` torn=+${d('torn')}`;
  const flag = loss > 0 ? '   <-- bytes not landing (disc/resync/rewind)'
    : d('gaps') > 0 ? '   frames landing; sender sent no meta that second (gaps is metadata, not the wire)'
      : '   clean';
  console.log(
    `  sent ${sent}/s  board decoded ${d('frames')}/s  disc=+${d('disc')} resync=+${d('resync')}` +
    ` rewind=+${d('rewind')} gaps=+${d('gaps')}${torn}` + flag,
  );
  base = { ...counters, t: now, written };
}

const { SerialPort } = await import('serialport').catch((err) => {
  console.error(
    `flicker: needs the serialport package (${err.message}). It is the only reason ` +
    `to install it: npm i --no-save --include=optional serialport`,
  );
  process.exit(1);
});

const port = new SerialPort({ path: PORT, baudRate: 921600, autoOpen: false });
port.on('data', onData);
port.on('error', (e) => {
  console.error(`flicker: ${e.message}`);
  process.exit(1);
});

port.on('open', async () => {
  port.write(meta({ brightness: BRI, limitMa: LIMIT }));
  console.log(
    `flicker: ${PORT} @921600  ${FPS} fps  ${FILL ? `FLAT FIELD #${FILL}` : `pattern=${PATTERN}`}` +
    `  pace=${PACE}${PACE === 'burst' ? ` x${BURST}` : ''}  bri=${BRI} lim=${LIMIT}  ${DURATION} ms`,
  );
  if (FPS > 45) console.log('flicker: above the strip ceiling (~49 fps for 400 APA106) — expect the stream to collapse');
  if (STEPS.length) console.log(`flicker: brightness steps -> ${STEPS.map((s) => `bri=${s.bri} lim=${s.lim}`).join('  |  ')}`);
  console.log('flicker: watch the wall; a flicker that survives a FLAT FIELD is electrical, not data\n');

  const tick = setInterval(report, 1000);
  const start = Date.now();
  const stepEvery = STEPS.length ? Math.max(1, Math.round(DURATION / STEPS.length / period)) : 0;
  let n = 0;

  while (Date.now() - start < DURATION) {
    const t = Date.now() - start;
    if (stepEvery && n % stepEvery === 0 && n / stepEvery < STEPS.length) {
      const s = STEPS[n / stepEvery];
      port.write(meta({ brightness: s.bri, limitMa: s.lim }));
      console.log(`  >>> step ${n / stepEvery + 1}/${STEPS.length}: bri=${s.bri} lim=${s.lim}  (watch the wall)`);
    }
    if (PACE === 'burst') {
      for (let k = 0; k < BURST; k++) {
        port.write(frame(nextSeq(seqAt(written + k)), draw(t + k * period)));
        written++;
      }
      await new Promise((r) => setTimeout(r, period * BURST));
    } else {
      port.write(frame(nextSeq(seqAt(written)), draw(t)));
      written++;
      await new Promise((r) => setTimeout(r, period));
    }
    n++;
  }

  clearInterval(tick);
  report();
  await new Promise((r) => setTimeout(r, 1200));
  console.log(
    `\nflicker: sent ${written} records; board reports frames=${counters.frames} disc=${counters.disc}` +
    ` resync=${counters.resync} rewind=${counters.rewind} gaps=${counters.gaps}` +
    (counters.torn === null ? ' torn=(this build has no such field)' : ` torn=${counters.torn}`),
  );
  console.log('flicker: gaps counts status windows with frames and no meta, so it ticks +1 per run (and '
    + 'per second) for a sender that sends no metas. It is not a wire fault; disc/resync/rewind/torn are.');
  port.close(() => process.exit(0));
});

// seq is a uint8 in the record; this run's own frame number, mod 256, offset once
// so the first record is not a repeat of a stream that ran before it.
function seqAt(i) {
  return (i + 1) & 255;
}

port.open(() => {});

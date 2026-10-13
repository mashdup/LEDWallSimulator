// Step through each colour channel on the wall, one at a time, while reading the
// device's own counters on the same port.
//
// A single-channel test localises a fault that no counter can see: if red lights
// and blue does not, the host is sending correct bytes and the loss is in the
// channel mapping or the output stage. The counters say whether frames ARRIVED;
// only this says what came out.
import { SerialPort } from 'serialport';

const PATH = process.argv[2] ?? 'COM6';
const LEDS = 400;
const FRAME_BYTES = 1203;
const STEP_MS = 3000;

const PHASES = [
  ['RED   (255,0,0)', 255, 0, 0],
  ['GREEN (0,255,0)', 0, 255, 0],
  ['BLUE  (0,0,255)', 0, 0, 255],
  ['WHITE (255,255,255)', 255, 255, 255],
  ['OFF   (0,0,0)', 0, 0, 0],
];

const frame = new Uint8Array(FRAME_BYTES);
const build = (seq, r, g, b) => {
  frame[0] = 0xa5;
  frame[1] = seq & 0xff;
  for (let i = 0; i < LEDS; i++) {
    frame[2 + i * 3] = r;
    frame[3 + i * 3] = g;
    frame[4 + i * 3] = b;
  }
  frame[FRAME_BYTES - 1] = 0x5a;
  return frame;
};

const port = new SerialPort({ path: PATH, baudRate: 921600, autoOpen: false });
await new Promise((ok, fail) => port.open((e) => (e ? fail(e) : ok())));

let rx = '';
let lastBoots = null;
port.on('data', (b) => {
  rx += b.toString('utf8');
  let nl;
  while ((nl = rx.indexOf('\n')) >= 0) {
    const line = rx.slice(0, nl).trim();
    rx = rx.slice(nl + 1);
    if (!line.includes('wall seq')) continue;
    const g = (k) => (new RegExp(`${k}=(\\d+)`).exec(line) ?? [])[1];
    const boots = g('boots');
    const mark = lastBoots !== null && boots !== lastBoots ? `  <<< REBOOT ${lastBoots}->${boots}` : '';
    lastBoots = boots;
    console.log(`  device: frames=${g('frames')} seq=${g('seq')} disc=${g('disc')} rewind=${g('rewind')} gaps=${g('gaps')} state=${(/state=(\w+)/.exec(line)??[])[1]} boots=${boots}${mark}`);
  }
});

let seq = 0;
for (const [label, r, g, b] of PHASES) {
  console.log(`PHASE ${label}`);
  const until = Date.now() + STEP_MS;
  while (Date.now() < until) {
    port.write(build(seq, r, g, b));
    seq = (seq + 1) & 0xff;
    await new Promise((res) => setTimeout(res, 33));
  }
}

// Repeat the two that discriminate: red (needs no blue) and blue.
for (const [label, r, g, b] of [PHASES[0], PHASES[2]]) {
  console.log(`PHASE ${label} (repeat)`);
  const until = Date.now() + STEP_MS;
  while (Date.now() < until) {
    port.write(build(seq, r, g, b));
    seq = (seq + 1) & 0xff;
    await new Promise((res) => setTimeout(res, 33));
  }
}

await new Promise((r) => setTimeout(r, 1500));
await new Promise((ok) => port.close(ok));
console.log('done');

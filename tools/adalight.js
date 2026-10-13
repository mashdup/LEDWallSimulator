// Does WLED receive every byte of an Adalight stream, at a given rate?
//
// Adalight has no resync: WLED reads a 6-byte header and then exactly count*3
// bytes. One byte lost mid-frame shifts every pixel after it, so the wall shows a
// rotation of the colours sent - flicker - while the host reports a perfect
// stream. This measures it rather than inferring it: stream solid red for a few
// seconds, then ask WLED for its strip buffer ('L' = tpm2 packet) and compare.
import { SerialPort } from 'serialport';

const PATH = process.argv[2] ?? 'COM6';
const LEDS = 400;
const RATES = (process.argv[3] ?? '5,15,30').split(',').map(Number);
const SECONDS = 3;

const hi = (LEDS >> 8) & 0xff;
const lo = LEDS & 0xff;
const frame = Buffer.alloc(6 + LEDS * 3);
frame[0] = 0x41; frame[1] = 0x64; frame[2] = 0x61;
frame[3] = hi; frame[4] = lo; frame[5] = hi ^ lo ^ 0x55;
for (let i = 0; i < LEDS; i++) { frame[6 + i*3] = 255; frame[7 + i*3] = 0; frame[8 + i*3] = 0; }

const port = new SerialPort({ path: PATH, baudRate: 921600, autoOpen: false });
await new Promise((ok, fail) => port.open((e) => (e ? fail(e) : ok())));
let rx = '';
port.on('data', (b) => { rx += b.toString('latin1'); });

console.log(`streaming solid red for ${SECONDS}s at each rate, then reading the strip back\n`);
for (const rate of RATES) {
  const until = Date.now() + SECONDS * 1000;
  let sent = 0;
  while (Date.now() < until) {
    port.write(frame);
    sent++;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.round(1000 / rate))));
  }

  // Query, retrying with a keepalive frame between attempts. Once the stream
  // stops, WLED's realtime lapses within ~2.5 s and clears the buffer it would
  // have reported, so the readback has to land inside that window - and WLED
  // only gets a chance to answer between realtime frames.
  let buf = Buffer.alloc(0);
  for (let attempt = 0; attempt < 6 && buf.length < 1204; attempt++) {
    rx = '';
    port.write(Buffer.from([0x4c]));
    await new Promise((r) => setTimeout(r, 250));
    buf = Buffer.from(rx, 'latin1');
    if (buf.length < 1204) {
      port.write(frame);                       // keep realtime from lapsing
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (buf.length < 1204 || buf[0] !== 0xc9 || buf[1] !== 0xda) {
    console.log(`${rate} fps: no usable readback (${buf.length} bytes, magic ${buf.subarray(0,2).toString('hex')})`);
    await new Promise((r) => setTimeout(r, 2500));
    continue;
  }
  const data = buf.subarray(4, 4 + LEDS * 3);
  let bad = 0, firstBad = -1;
  for (let i = 0; i < LEDS; i++) {
    const want = [255, 0, 0][i % 3];
    if (data[i] !== want) { bad++; if (firstBad < 0) firstBad = i; }
  }
  console.log(`${rate} fps (~${(sent / SECONDS).toFixed(0)} actual): sent ${sent} frames | readback ${buf.length}B | mismatched bytes ${bad}/1200${firstBad >= 0 ? ` first at ${firstBad} (wanted ${[255,0,0][firstBad%3]}, got ${data[firstBad]})` : ''}`);
  if (firstBad >= 0) {
    console.log(`    bytes around first mismatch: ${[...data.subarray(Math.max(0, firstBad - 3), firstBad + 6)].join(',')}`);
    console.log(`    expected pattern            : ${[[255,0,0][(firstBad-3+300)%3], [255,0,0][(firstBad-2+300)%3], [255,0,0][(firstBad-1+300)%3], 255,0,0,255,0,0,255].join(',')}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}
await new Promise((ok) => port.close(ok));

// tools/freeport-args.js - pure arg parsing for freeport (unit-testable).

const USAGE =
  'usage: npm run freeport -- COM8 [--kill]\n' +
  '       npm run freeport -- /dev/cu.usbmodem59810005071 [--kill]   (macOS)\n' +
  '       npm run freeport -- /dev/ttyACM0 [--kill]                  (Linux)\n' +
  '  finds the process holding a serial port (Windows: the handle-table scan;\n' +
  '  macOS/Linux: lsof on the /dev node); --kill terminates it - the only real\n' +
  '  "force disconnect", since a port is exclusive and no API closes a handle\n' +
  '  held by another process.';

// COMn (Windows), the macOS cu.* forms (bare 'cu.usbmodemX' or the full
// path), and Linux ttyACM/ttyUSB. A serial port name is not free-form text:
// everything here is a path under /dev, resolved in freeport-scan.
const PORT_RE = /^(com\d{1,3}|(cu|tty)\.[\w.+-]+|\/dev\/(cu|tty)[\w.+-]+|tty(ACM|USB)\d+|usb(modem|serial)[\w.+-]*)$/i;

/** Parse CLI args: a serial port name, optional --kill. */
export function parsePortArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('-'));
  const pos = argv.filter((a) => !a.startsWith('-'));
  if (pos.length !== 1 || !PORT_RE.test(pos[0])) {
    return { ok: false, usage: USAGE };
  }
  const bad = flags.filter((f) => f !== '--kill');
  if (bad.length > 0) return { ok: false, usage: `${USAGE}\nfreeport: unknown flag ${bad[0]}` };
  // COM8 -> COM8 (Windows names are case-normalized); a /dev path is NOT
  // uppercased, because /dev/CU.USBMODEM598 does not exist.
  const port = /^com\d+$/i.test(pos[0]) ? pos[0].toUpperCase() : pos[0];
  return { ok: true, port, kill: flags.includes('--kill') };
}

export function shouldKill(args) {
  return args.kill === true;
}

export function formatHolders(holders) {
  return holders
    .map((h) => `freeport: ${h.device} held by pid ${h.pid} (${h.name})`)
    .join('\n');
}

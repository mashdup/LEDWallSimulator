/**
 * serial-pick.cjs — choose the wall's port out of Chromium's picker list.
 *
 * Why this file exists (measured on the mac, release 0.11.6): the picker
 * logged 3 ports and the matcher chose NONE, so requestPort() resolved to
 * null and the console reported 'No serial port was selected'. The wall was
 * in the list the whole time:
 *
 *   {"portName":"cu.usbmodem59810005071","displayName":"USB Single Serial",
 *    "vendorId":"6790","productId":"21971","usbDriverName":"com.wch..."}
 *
 * The old matcher was Windows-shaped in three independent ways, and each one
 * alone was fatal:
 *
 *   1. ID BASE. Chromium reports vendorId/productId as HEX strings on
 *      Windows ('1a86') and as DECIMAL strings on macOS ('6790' = 0x1a86).
 *      A string compare against '1a86' can only ever match one platform, so
 *      ids are now compared NUMERICALLY, from both readings.
 *   2. PORT NAMES. The fallback was /^com\d+$/; macOS names the same cable
 *      'cu.usbmodem59810005071' (Linux: 'ttyACM0'). There is no COMn on a
 *      Mac, so that fallback answered 'no port' on every non-Windows machine.
 *   3. THE FIELD THAT HOLDS THE NAME. deviceInstanceId is a Windows field;
 *      on macOS it is undefined, and the product string lives in
 *      displayName / usbDriverName, which the old regex never looked at.
 *
 * macOS also hands the picker two ports that are not a wall and never are —
 * cu.Bluetooth-Incoming-Port and cu.debug-console — so "just take the first
 * port" would open the Bluetooth RFCOMM device and drive a dark wall. The
 * noise list below is what makes a single-candidate fallback safe to have.
 */

/** Vendors whose chips are used as the wall's USB-UART (numeric, both bases). */
const KNOWN_VIDS = [
  0x1a86, // WCH CH340/341/342/343/344/552 — the show machine's chip
  0x343d, // QinHeng CH9102/CH9344
  0x10c4, // Silicon Labs CP210x (common on ESP32 dev boards)
  0x0403, // FTDI FT232/FT232R
  0x067b, // Prolific PL2303
  0x303a, // Espressif (ESP32-S2/S3 native USB, TinyUSB CDC)
  0x1234, // TinyUSB default id (ESP32-S2/S3 'JTAG+CDC')
  0x0d28, // ARM mbed/DAPLink (firmware flashing rigs)
];

/**
 * Ports macOS (and Windows' Bluetooth PAN plumbing) list that are never a
 * serial cable: Bluetooth RFCOMM modems and the iOS debug console.
 */
const NOISE = /bluetooth|debug-console|debug-console-|pda-sync|wlan|infrared|irda|hub|tty\.debug/i;

/** Product/driver strings that name a USB-UART or an ESP32's own USB. */
const SIGNATURE =
  /usb[\s_-]*(single[\s_-]+)?(jtag[\s_-]*\/?\s*[\s_-]*)?serial|serial[\s_-]*(port|device|debug|controller|jtag)|usb[\s_-]*cdc|\bcdc[\s_-]?acm|ch34\d|ch9102|ch9344|cp210\d?|ftdi|ft232|pl2303|esp-?32|esp-?s3|jtag|wchusbserial|usb-?jtag|uart|wch/i;

/** Port names that are a real serial device on some platform. */
const SERIAL_NAME = /^(cu|tty)\.(usb(modem|serial)|wchusbserial|ACM\d|USB\d|GREG|SLAB|SLAB-USB|mbed)|^com\d+$|^(tty(ACM|USB)\d+)/i;

/** The show machine's shipped port; a tie-break, not a requirement. */
const PREFERRED_NAME = /^com8$/i;

/** Every string value of a port record, joined — the fields a signature can live in. */
function fields(port) {
  const out = [];
  for (const v of Object.values(port ?? {})) {
    if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out.join(' ');
}

/** Compact one-line description for the venue log (it is the only witness). */
function describePort(port) {
  if (port === null || port === undefined) return 'null';
  const s = JSON.stringify(port) ?? String(port);
  return s.length > 220 ? `${s.slice(0, 220)}...` : s;
}

/**
 * Chromium's id strings, read as BOTH bases: '1a86' (Windows, hex) and
 * '6790' (macOS, decimal) are the same chip. Returns the candidate numbers.
 */
function idNumbers(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/^#/, '');
  if (!/^[0-9a-f]+$/.test(s)) return [];
  const out = [];
  if (/^\d+$/.test(s)) out.push(parseInt(s, 10));
  if (/^[0-9a-f]{1,4}$/.test(s)) out.push(parseInt(s, 16));
  return [...new Set(out)].filter((n) => Number.isFinite(n));
}

function idMatches(value, wanted) {
  const nums = idNumbers(value);
  return nums.length > 0 && nums.includes(wanted);
}

/** '1a86:7523' / '6790:21971' / '0x1a86:0x7523' — both bases accepted. */
function vidPidMatches(port, prefer) {
  // Up to 5 digits: macOS prints a 16-bit pid in DECIMAL, and 0x55d3 is
  // '21971' — a 4-char cap silently made every macOS pid unmatchable.
  const hit = /^0?x?([0-9a-f]{1,5}):0?x?([0-9a-f]{1,5})$/i.exec(String(prefer).trim());
  if (hit === null) return false;
  const vid = parseInt(hit[1], 16);
  const pid = parseInt(hit[2], 16);
  return (
    idMatches(port.vendorId, vid) &&
    (Number.isNaN(pid) || pid > 0xffff ? true : idMatches(port.productId, pid))
  );
}

function isNoise(port) {
  return NOISE.test(fields(port));
}

/** Real evidence that this record is the wall's UART (not just "a port"). */
function hasSignature(port) {
  if (KNOWN_VIDS.some((vid) => idMatches(port?.vendorId, vid))) return true;
  return SIGNATURE.test(fields(port));
}

/**
 * Pick the wall's port.
 *
 * precedence: explicit preference (--wall-serial, name substring or vid:pid)
 * → a record with UART/ESP32 signature evidence → a serial-shaped port name
 * → a lone non-noise port (the single-cable case, which is every show
 * machine). Refuses on everything else: a dark wall over the
 * Bluetooth-Incoming-Port is worse than a refused picker.
 *
 * @param {Iterable<object>} portList the list Electron hands select-serial-port
 * @param {{prefer?: string}} opts prefer: substring of a name, or 'vid:pid'
 * @returns {{port: object|null, why: string, ports: object[]}}
 */
function pickSerialPort(portList, opts = {}) {
  const ports = Array.from(portList ?? []);
  const prefer = String(opts.prefer ?? '').trim();
  if (prefer !== '') {
    const wanted = (p) =>
      vidPidMatches(p, prefer) ||
      new RegExp(prefer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(fields(p));
    const hit = ports.find(wanted);
    if (hit !== undefined) return { port: hit, why: `--wall-serial '${prefer}'`, ports };
    return { port: null, why: `--wall-serial '${prefer}' matched none of ${ports.length} port(s)`, ports };
  }

  const live = ports.filter((p) => !isNoise(p));
  const tier = [
    ['signature', (p) => hasSignature(p)],
    ['serial-shaped name', (p) => SERIAL_NAME.test(String(p.portName ?? '')) || SERIAL_NAME.test(fields(p))],
    ['preferred port (COM8)', (p) => PREFERRED_NAME.test(String(p.portName ?? ''))],
    ['only non-Bluetooth port on the machine', () => live.length === 1],
  ];
  for (const [why, test] of tier) {
    const hit = live.find(test);
    if (hit !== undefined) return { port: hit, why, ports };
  }
  const skipped = ports.length - live.length;
  return {
    port: null,
    why: `no serial port in ${ports.length} port(s)` + (skipped > 0 ? ` (${skipped} were Bluetooth/debug noise)` : ''),
    ports,
  };
}

module.exports = { pickSerialPort, describePort, hasSignature, isNoise, idMatches, idNumbers, KNOWN_VIDS };

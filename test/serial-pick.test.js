import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { pickSerialPort, describePort, idNumbers, hasSignature } = require('../tools/electron/serial-pick.cjs');

/**
 * The port picker, judged on the field records that broke it.
 *
 * Release 0.11.6 on a Mac: the picker log listed three ports, the matcher
 * chose none, requestPort() resolved to null, and the console told the human
 * to "pick the ESP32 port in the browser prompt" — a prompt the app shell
 * answers itself. The wall was in the list. These tests are that log line.
 */

// Verbatim from userData/wall.log on the mac (the truncation is Chromium's,
// and the matcher must not need the tail: usbDriverName is not consulted).
const MAC_ESP32 = {
  portId: '2D440DD0160931E5B8751D0FB4DB824C',
  portName: 'cu.usbmodem59810005071',
  displayName: 'USB Single Serial',
  vendorId: '6790', //  0x1a86 — Chromium reports DECIMAL on macOS
  productId: '21971', // 0x55d3
  serialNumber: '5981000507',
  usbDriverName: 'com.wch.usbserial',
};
const MAC_BLUETOOTH = { portId: '35E6226F21A3E372D64C7AB83693BB3C', portName: 'cu.Bluetooth-Incoming-Port' };
const MAC_DEBUG = { portId: '03D4654A11040B142138BB3279F49550', portName: 'cu.debug-console' };
const MAC_LIST = [MAC_BLUETOOTH, MAC_DEBUG, MAC_ESP32];

// The same wall on the show machine (Windows): hex ids, a deviceInstanceId,
// and a COM name. Both shapes must land on the same tier.
const WIN_ESP32 = {
  portId: '7',
  portName: 'COM8',
  displayName: 'USB-SERIALCH340 (COM8)',
  deviceInstanceId: 'USB\\VID_1A86&PID_7523\\5&2B52C0A3&0&3',
  vendorId: '1a86',
  productId: '7523',
};
const WIN_LIST = [{ portId: '1', portName: 'COM1' }, WIN_ESP32];

test('the mac field record is chosen (regression: 3 ports listed, none chosen)', () => {
  const { port, why } = pickSerialPort(MAC_LIST);
  assert.ok(port, `a port must be chosen, got: ${why}`);
  assert.equal(port.portId, MAC_ESP32.portId);
});

test('macOS Bluetooth and debug-console are never chosen', () => {
  const { port } = pickSerialPort([MAC_BLUETOOTH, MAC_ESP32, MAC_DEBUG]);
  assert.equal(port.portId, MAC_ESP32.portId);
  assert.equal(pickSerialPort([MAC_BLUETOOTH, MAC_DEBUG]).port, null, 'noise alone is a refusal, not a grab');
});

test('the Windows record still chooses COM8 by its VID', () => {
  const { port, why } = pickSerialPort(WIN_LIST);
  assert.equal(port.portId, WIN_ESP32.portId, why);
});

test('ids match in both bases: 6790 == 1a86 == 0x1a86', () => {
  assert.ok(idNumbers('6790').includes(0x1a86));
  assert.ok(idNumbers('1a86').includes(0x1a86));
  assert.ok(idNumbers('0x1a86').includes(0x1a86));
  assert.equal(hasSignature({ vendorId: '6790', portName: 'cu.usbmodem59810005071' }), true);
  assert.equal(hasSignature({ vendorId: '1a86' }), true);
  assert.equal(hasSignature({ vendorId: '0403', portName: 'cu.ftdi_probe' }), true); // FTDI
  assert.equal(hasSignature({ vendorId: '1234', displayName: 'USB JTAG/serial debug unit' }), true); // ESP32-S3 native USB
});

test('the ESP32-S3 native-USB port is recognised without a UART chip', () => {
  const s3 = { portName: 'cu.usbmodemE831104C8B1C2', displayName: 'USB JTAG/serial debug unit', vendorId: '1234', productId: '4660' };
  assert.equal(pickSerialPort([MAC_BLUETOOTH, s3]).port.portName, s3.portName);
});

test('no signature at all: a serial-shaped name still wins over noise', () => {
  const plain = { portName: 'cu.usbserial-A50285BI' };
  assert.equal(pickSerialPort([MAC_DEBUG, plain]).port.portName, plain.portName);
  const acm = { portName: 'ttyACM0' };
  assert.equal(pickSerialPort([acm]).port.portName, 'ttyACM0');
});

test('a single unidentifiable port is chosen (one-cable machine, tier: lone candidate)', () => {
  const odd = { portId: 'p1', portName: 'cu.weirdbrand0' };
  const { port, why } = pickSerialPort([MAC_BLUETOOTH, odd]);
  assert.equal(port.portId, 'p1', why);
});

test('nothing plausible: refuse, and say why', () => {
  const r = pickSerialPort([MAC_BLUETOOTH, MAC_DEBUG]);
  assert.equal(r.port, null);
  assert.match(r.why, /2 were Bluetooth\/debug noise/);
  assert.equal(pickSerialPort([]).port, null);
});

test('--wall-serial prefers a name substring', () => {
  const { port, why } = pickSerialPort(MAC_LIST, { prefer: 'usbmodem' });
  assert.equal(port.portId, MAC_ESP32.portId);
  assert.match(why, /--wall-serial 'usbmodem'/);
});

test('--wall-serial prefers vid:pid in either base', () => {
  assert.equal(pickSerialPort(MAC_LIST, { prefer: '1a86:55d3' }).port.portId, MAC_ESP32.portId);
  assert.equal(pickSerialPort(WIN_LIST, { prefer: '1A86:7523' }).port.portId, WIN_ESP32.portId);
  assert.equal(pickSerialPort(MAC_LIST, { prefer: '6790:21971' }).port.portId, MAC_ESP32.portId);
});

test('a preference that matches nothing refuses — it never silently falls back', () => {
  const r = pickSerialPort(MAC_LIST, { prefer: 'COM8' });
  assert.equal(r.port, null);
  assert.match(r.why, /matched none/);
});

test('describePort keeps the venue log readable on a 2 MB log cap', () => {
  assert.equal(describePort(null), 'null');
  const fat = describePort({ portName: 'COM8', junk: 'x'.repeat(500) });
  assert.ok(fat.length <= 230, fat.length);
  assert.ok(fat.endsWith('...'));
});

test('the matcher survives the field shape that has no string fields', () => {
  // Measured on Windows: SerialPortInfo came back with every field undefined.
  const bare = { portId: 'x' };
  assert.equal(hasSignature(bare), false);
  assert.equal(pickSerialPort([bare]).port.portId, 'x', 'a lone port is still the wall');
});

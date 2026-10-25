import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePortArgs, formatHolders, shouldKill } from '../tools/freeport-args.js';

/**
 * 'Force disconnect' on Windows means killing the holder - the dangerous
 * part is pointing it at the wrong port, so the arg gate is the tested
 * contract: exactly one COMn, only --kill as a flag.
 */

test('parsePortArgs accepts a COM port and optional --kill', () => {
  assert.deepEqual(parsePortArgs(['COM8']), { ok: true, port: 'COM8', kill: false });
  assert.deepEqual(parsePortArgs(['com8', '--kill']), { ok: true, port: 'COM8', kill: true });
  assert.equal(shouldKill(parsePortArgs(['COM8', '--kill'])), true);
  assert.equal(shouldKill(parsePortArgs(['COM8'])), false);
});

test('parsePortArgs rejects missing, extra, or non-COM positional args', () => {
  assert.equal(parsePortArgs([]).ok, false);
  assert.equal(parsePortArgs(['COM8', 'COM9']).ok, false);
  assert.equal(parsePortArgs(['LPT1']).ok, false);
  assert.equal(parsePortArgs(['8']).ok, false);
});

test('parsePortArgs rejects unknown flags with a named complaint', () => {
  const r = parsePortArgs(['COM8', '--force']);
  assert.equal(r.ok, false);
  assert.match(r.usage, /unknown flag --force/);
});

test('parsePortArgs rejects LPT1, a bare number, and shell junk', () => {
  assert.equal(parsePortArgs(['LPT1']).ok, false);
  assert.equal(parsePortArgs(['8']).ok, false);
  assert.equal(parsePortArgs(['/dev/null']).ok, false);
  assert.equal(parsePortArgs(['/dev/tty']).ok, false);
});

test('parsePortArgs accepts the macOS and Linux names, and does NOT uppercase a path', () => {
  // COM8 is uppercased for the Windows scan; '/dev/cu.usbmodem…' must arrive
  // intact — /dev/CU.USBMODEM598 does not exist, and the uppercasing was the
  // Windows assumption baked into the CLI.
  assert.deepEqual(parsePortArgs(['/dev/cu.usbmodem59810005071']), {
    ok: true, port: '/dev/cu.usbmodem59810005071', kill: false,
  });
  assert.equal(parsePortArgs(['cu.wchusbserial140', '--kill']).port, 'cu.wchusbserial140');
  assert.equal(parsePortArgs(['usbmodem59810005071']).ok, true);
  assert.deepEqual(parsePortArgs(['/dev/ttyACM0', '--kill']), { ok: true, port: '/dev/ttyACM0', kill: true });
  assert.equal(parsePortArgs(['ttyUSB0']).ok, true);
  assert.match(parsePortArgs([]).usage, /dev\/cu\.usbmodem/);
});

test('formatHolders names pid, process and device - the point of the tool', () => {
  const text = formatHolders([
    { pid: 17660, name: 'electron', device: '\\Device\\Serial2' },
    { pid: 42, name: 'arduino-ide', device: '\\Device\\Serial2' },
  ]);
  assert.match(text, /pid 17660 \(electron\)/);
  assert.match(text, /pid 42 \(arduino-ide\)/);
});

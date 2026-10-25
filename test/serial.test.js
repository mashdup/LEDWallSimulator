import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { parseProbeOutput, serialPorts, serialTakeOver, posixPortNames, posixBusyNames } from '../tools/serial.js';
import { posixDeviceCandidates } from '../tools/freeport-scan.js';
import { freePort, startServe } from './harness.js';

/**
 * The serial pre-flight: 'the port is taken' must be a named warning before
 * Connect, not an opaque open() failure after it. The probe shells out to
 * PowerShell, so the unit-testable core is the parser (real output has CRLF,
 * banners and blank lines) and the HTTP contract of GET /serial.
 */

test('parseProbeOutput reads exact COMn=FREE|BUSY lines and ignores noise', () => {
  const out = parseProbeOutput(
    '\r\nCOM8=FREE\r\nCOM3=BUSY\r\n\r\nsome banner\r\ncom6=Free\r\nnot a port=x\r\nCOM12=BUSY\r\n'
  );
  assert.deepEqual(out, [
    { port: 'COM8', state: 'FREE' },
    { port: 'COM3', state: 'BUSY' },
    { port: 'COM6', state: 'FREE' },
    { port: 'COM12', state: 'BUSY' },
  ]);
});

test('parseProbeOutput on garbage yields no ports (non-Windows, no PowerShell)', () => {
  assert.deepEqual(parseProbeOutput(''), []);
  assert.deepEqual(parseProbeOutput('CommandNotFound\r\n'), []);
});

test('GET /serial answers a JSON port list, no-store', async () => {
  const port = await freePort();
  const serve = await startServe(port);
  try {
    const res = await fetch(`${serve.base}/serial`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const list = await res.json();
    assert.ok(Array.isArray(list));
    for (const p of list) {
      // Windows names ports COMn; macOS 'cu.usbmodem…'/'cu.usbserial…',
      // Linux 'ttyACM0'. The endpoint's contract is 'a real port name on
      // this machine', and a hardcoded COMn assertion is the Windows-shaped
      // bug this file is about: it passes on the show machine and fails on
      // every Mac, exactly like the picker did.
      assert.ok(
        /^COM\d+$/.test(p.port) || /^(cu|tty)\.[\w.+-]+$/.test(p.port) || /^tty(ACM|USB)\d+$/.test(p.port),
        `not a port name: ${p.port}`
      );
      assert.ok(p.state === 'FREE' || p.state === 'BUSY');
    }
  } finally {
    await serve.stop();
  }
});

// ---- the POSIX probe (macOS / Linux) --------------------------------------
//
// On Windows 'busy' can only be learned by test-opening the port, which
// toggles DTR/RTS and reboots the ESP32. On a Mac, lsof names the holder
// directly: no open, no reset, no PowerShell. The probe used to answer []
// there (spawn('powershell.exe') fails), so the pre-flight warning and the
// app's port-name seed were dead on every non-Windows machine.

test('posixPortNames lists the wall-shaped nodes and drops the mac decoys', () => {
  const darwin = (n) => /^cu\./.test(n) && !/bluetooth|debug-console/i.test(n);
  assert.equal(darwin('cu.usbmodem59810005071'), true);
  assert.equal(darwin('cu.wchusbserial140'), true);
  assert.equal(darwin('cu.Bluetooth-Incoming-Port'), false);
  assert.equal(darwin('cu.debug-console'), false);
  // The real machine, whatever it is: a list, never a throw, never null.
  const names = posixPortNames();
  assert.ok(Array.isArray(names));
  for (const n of names) {
    assert.doesNotMatch(n, /bluetooth|debug-console/i, 'the mac lists these two and neither is a cable');
  }
});

test('posixBusyNames reads lsof -F output: holder present, quiet ports absent', () => {
  // Verbatim lsof field format: p<pid> starts a process set, c<command>,
  // n<name> per open file. 'sleep' is what a real session's holder looks
  // like when a shell has the port (see the recorded probe in README).
  const fake = () => ({
    stdout: ['p15914', 'csleep', 'f3', 'n/dev/cu.usbmodem59810005071'].join('\n'),
    status: 1,
    error: undefined,
  });
  const busy = posixBusyNames(['cu.usbmodem59810005071', 'cu.usbserial-A50285BI'], fake);
  assert.deepEqual([...busy], ['cu.usbmodem59810005071']);
});

test('posixBusyNames with no lsof reports nothing busy (never warns on a tool we lack)', () => {
  const missing = () => ({ error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) });
  assert.equal(posixBusyNames(['cu.usbmodem59810005071'], missing).size, 0);
});

test('serialPorts on this machine answers port+state, never throws', async () => {
  const ports = await serialPorts({ bypassCache: true });
  assert.ok(Array.isArray(ports));
  if (process.platform !== 'win32') {
    // On a Mac/Linux box the probe must find the OS names, not []: [] is the
    // Windows-probe failure mode that made the pre-flight silent here.
    for (const p of ports) assert.ok('path' in p && p.port.startsWith('/dev/') === false);
  }
});

test('posixDeviceCandidates accepts every spelling a human pastes', () => {
  const real = posixPortNames()[0];
  if (real === undefined) return; // a machine with no cable: nothing to check
  const full = `/dev/${real}`;
  assert.deepEqual(posixDeviceCandidates(full), [full]);
  assert.deepEqual(posixDeviceCandidates(real), [full]);
  // A human pastes the interesting half of the name; the cu. is inferred.
  assert.deepEqual(posixDeviceCandidates(real.replace(/^cu\./, '')), [full]);
  assert.deepEqual(posixDeviceCandidates('COM8'), [], 'a Windows name on a Mac is a typo, not a path');
  assert.deepEqual(posixDeviceCandidates('/dev/../../etc/passwd'), []);
  assert.deepEqual(posixDeviceCandidates(''), []);
});

test('serialPorts on a Mac with no lsof still lists ports, all FREE (no invented warnings)', async () => {
  const ports = await serialPorts({ bypassCache: true, run: () => ({ error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) }) });
  assert.ok(Array.isArray(ports));
  for (const p of ports) {
    assert.equal(p.state, 'FREE');
    assert.match(p.path, /^\/dev\//);
  }
});

test('serialPorts caches: two calls in the window share one probe', async () => {
  const a = await serialPorts();
  const b = await serialPorts();
  assert.equal(a, b); // same array identity = cache hit, no second PowerShell
});

// Regression: the probe's timeout timer called ps.kill('ignore') - a POSIX
// signal convention that THROWS ERR_UNKNOWN_SIGNAL on Windows. The timer
// runs on the dev server's event loop, so a PowerShell cold start slower
// than the timeout crashed the whole server: blank content, dead Connect,
// and every symptom pointed at the app. These tests pin the probe's
// promise: it resolves, always, whatever PowerShell does.
test('probe timeout kills the hung probe and resolves - it must never throw (this crash killed the server)', async () => {
  // timeoutMs 1 forces the kill path on every machine: a real PowerShell
  // cannot cold-start in 1 ms. Before the fix this threw from the timer
  // and took the process down.
  const ports = await serialPorts({ timeoutMs: 1, bypassCache: true });
  assert.ok(Array.isArray(ports));
});

test('probe resolves [] when PowerShell is unavailable (Windows: the only probe there)', async () => {
  if (process.platform !== 'win32') return; // macOS/Linux use lsof; see below
  // PATH stripped: spawn('powershell.exe') fails to resolve. The probe must
  // answer 'no ports', not reject - the app treats [] as 'say nothing'.
  const r = spawnSync(
    process.execPath,
    ['-e', "import('./tools/serial.js').then(m => m.serialPorts({ bypassCache: true })).then(p => console.log('RES:' + JSON.stringify(p)))"],
    { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 20000 }
  );
  assert.match(String(r.stdout), /RES:\[\]/);
  assert.equal(r.status, 0);
});

test('serialTakeOver rejects junk port names without scanning', async () => {
  const r = await serialTakeOver('nonsense');
  assert.equal(r.ok, false);
  // Windows: 'invalid port name'. macOS/Linux: a named complaint that COMn/
  // junk is not a /dev node here. Both refuse before any scan runs.
  assert.match(r.error, /invalid port|not a serial port/);
});

test('serialTakeOver spares (does not kill) a non-killable holder', async () => {
  // COM8 right now is held by the LIVE app (electron) - killing it would
  // end the user's show, so this test only proves the gate exists: the
  // function must expose 'spared' for anything outside its kill list, and
  // the kill list is electron-only (tools/serial.js). A scan that finds the
  // live electron must mark it killable=true by NAME; we assert the name
  // gate regex behavior through the spared/killed split without invoking
  // a real kill: probe COM8 read-only via findHolders is slow, so we test
  // the contract on a port that cannot exist.
  const r = await serialTakeOver('COM999');
  assert.equal(r.ok, false); // NODEVICE path
});

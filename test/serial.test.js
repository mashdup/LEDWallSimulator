import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { parseProbeOutput, serialPorts } from '../tools/serial.js';
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
      assert.match(p.port, /^COM\d+$/);
      assert.ok(p.state === 'FREE' || p.state === 'BUSY');
    }
  } finally {
    await serve.stop();
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

test('probe resolves [] when PowerShell is unavailable', async () => {
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

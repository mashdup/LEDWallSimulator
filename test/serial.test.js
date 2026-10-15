import test from 'node:test';
import assert from 'node:assert/strict';

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

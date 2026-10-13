import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BLOCKED_PORTS, isFetchablePort, freePort } from '../tools/ports.js';

/**
 * Port picking, against the real client.
 *
 * The bug this defends: `listen(0)` returns whatever the OS has free, and the
 * fetch standard declares a list of ports unreachable. A server on one of them
 * binds, prints a URL, and then answers nothing — every request dies in the
 * client before a socket opens, with the whole error being "bad port". On Windows
 * the dynamic range starts low enough (~5444 here) to overlap seven of them, so
 * this failure arrives as an intermittent test failure rather than a pattern.
 *
 * The blocked list is asserted against this machine's undici by actually calling
 * fetch, so the list in ports.js is checked rather than trusted.
 */

const SERVE_SCRIPT = fileURLToPath(new URL('../tools/serve.js', import.meta.url));

/** Ask fetch to connect to a port with nothing listening, and classify the failure. */
async function reach(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return { kind: 'connected', status: res.status };
  } catch (err) {
    const cause = err.cause;
    const message = String(cause?.message ?? cause?.code ?? err.message);
    return { kind: /bad port/i.test(message) ? 'blocked' : 'refused', message };
  }
}

test('every port ports.js calls unreachable is refused by fetch before connecting', async () => {
  // Two directions, because a list that is merely too long would also make the
  // helper "work": each blocked port must actually be refused, and a port just
  // outside the list must be reachable enough to reach the connect stage.
  for (const port of BLOCKED_PORTS) {
    const outcome = await reach(port);
    assert.equal(outcome.kind, 'blocked', `port ${port} should be refused by fetch: ${outcome.message}`);
    assert.equal(isFetchablePort(port), false, `ports.js must list ${port}`);
  }

  // Neighbours of blocked ports: if these were refused too, the real blocked set
  // would be wider than the one encoded here.
  for (const port of [4191, 5999, 6001, 6664, 6670, 6698, 10081]) {
    const outcome = await reach(port);
    assert.notEqual(
      outcome.kind,
      'blocked',
      `port ${port} sits next to a blocked port but must not be treated as one`,
    );
  }
});

test('freePort never hands back a port a client is forbidden to reach', async () => {
  // Enough samples to cover the blocked ports inside this machine's dynamic range
  // several times over: the old helper returned 6000 outright, and a range scan
  // would have caught it only by luck.
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, `not a port: ${port}`);
    assert.ok(
      isFetchablePort(port),
      `freePort returned unreachable port ${port}; fetch would refuse every request to it`,
    );
    seen.add(port);
  }
  assert.ok(seen.size > 1, `freePort returned the same port 60 times: ${[...seen]}`);
});

test('a server bound on a freePort answers a real fetch', async () => {
  // The point of the helper is not the number, it is that the pair (bind, fetch)
  // works. listen(0) plus fetch is exactly the combination that used to fail.
  const port = await freePort();
  const server = createTestServer();
  await new Promise((done, fail) => server.once('error', fail).listen(port, '127.0.0.1', done));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'pong');
  } finally {
    // undici pools the socket it just used, and server.close() waits for sockets
    // to drain — without this the test hangs on a keep-alive connection instead
    // of finishing.
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('serve.js refuses to bind a port browsers will not connect to', async () => {
  // Without this, serve.js prints "LED wall dev server: http://127.0.0.1:6000/"
  // and the browser app fails on every request with no hint that the port is why.
  const child = spawn(process.execPath, [SERVE_SCRIPT, '--port', '6000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve.js hung instead of refusing port 6000: ${out}`)), 15_000);
    child.once('exit', (c) => { clearTimeout(timer); done(c); });
    child.once('error', fail);
  });

  assert.equal(code, 2, `expected a refusal with exit 2, got ${code}: ${out}`);
  assert.match(out, /unreachable/i);
  assert.doesNotMatch(out, /dev server/, 'it must not advertise a URL it knows is dead');
});

/** Minimal server for the bind-and-fetch contract. */
function createTestServer() {
  return createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('pong');
  });
}


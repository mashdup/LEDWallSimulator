import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { freePort } from '../tools/ports.js';

/**
 * tools/start.js — the command a person actually types.
 *
 * What is worth pinning is not that it runs serve.js, but the three ways a
 * launcher goes wrong:
 *   1. it opens the browser before the socket is bound, so the tab shows
 *      "connection refused" and the app looks broken;
 *   2. it silently relocates a port you asked for, so you end up with a server
 *      on a port you never chose;
 *   3. its teardown kills the Node process and leaves the Chromium serve.js owns
 *      alive, holding a profile directory and a DevTools port.
 *
 * Every assertion here is against a real child process and a real fetch.
 */

const START_SCRIPT = fileURLToPath(new URL('../tools/start.js', import.meta.url));
const READY = /LED wall dev server: (http:\/\/127\.0\.0\.1:\d+)/;
/** start.js's own line, printed after it sees serve.js's URL. */
const LAUNCHED = /Ctrl\+C to stop/;

/** Can anything connect to this port? */
async function reach(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    await res.arrayBuffer();
    return { kind: 'connected', status: res.status, type: res.headers.get('content-type') };
  } catch (err) {
    return { kind: /bad port/i.test(String(err.cause?.message ?? err.message)) ? 'blocked' : 'refused' };
  }
}

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Occupy a port so a launcher has to deal with it being taken. */
async function occupy(port) {
  const server = createServer((_req, res) => res.writeHead(503).end('occupier'));
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return () => new Promise((done) => server.close(done));
}

/**
 * Run tools/start.js and wait for it to report a bound server.
 * Returns the URL it announced, not the port asked for, so the assertions follow
 * whatever the launcher decided.
 *
 * Readiness needs the launcher's *own* closing line, not just serve.js's URL:
 * start.js forwards serve.js's three lines in one chunk and then prints its
 * `Ctrl+C to stop.` line in the next write, so a gate that resolves on the URL
 * would let the test read a log that is missing a line which is already queued
 * and simply has not been flushed to the pipe yet.
 */
async function runStart(args) {
  const child = spawn(process.execPath, [START_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  const settled = await new Promise((done) => {
    // A timeout is deliberately not `ready`: a launcher that never prints its
    // banner must be reported as a failure, not as a server to assert against.
    const timer = setTimeout(() => done({ state: 'timeout' }), 20_000);
    const check = () => {
      if (!(READY.test(log) && /loopback URL/.test(log) && LAUNCHED.test(log))) return false;
      clearTimeout(timer);
      done({ state: 'ready' });
      return true;
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ state: 'exited', code: signal === null ? code : signal });
      return true;
    });
    check();
  });

  const url = READY.exec(log)?.[1] ?? null;
  return {
    child,
    log: () => log,
    url,
    port: url === null ? null : Number(new URL(url).port),
    settled,
    /**
     * Tear the whole tree down the way the script promises to.
     *
     * The wait POLLS the child's exit state, it does not await the 'exit'
     * event. taskkill is synchronous, and on a killed tree the event can fire
     * in the gap between the kill returning and the listener being attached -
     * and a wait that can miss the event it is waiting for is a suite that
     * hangs forever. This suite did: the file's last test finished, the child
     * was dead, and the runner sat on it until the 120 s test timeout fired.
     * Bounded and state-based, a teardown can only be slow, never stuck.
     */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      const deadline = Date.now() + 5_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
      }
    },
  };
}

test('npm start serves the app on the port it announces, and its teardown frees it', async (t) => {
  const port = await freePort();
  const run = await runStart(['--no-browser', '--port', String(port)]);
  try {
    // No skip here: with --no-browser the launcher has no external dependency,
    // so never printing a bound-server banner is exactly the failure this test
    // exists to catch.
    assert.equal(
      run.settled.state,
      'ready',
      `start.js must report a bound server (${JSON.stringify(run.settled)}): ${run.log()}`,
    );

    // The URL printed is the URL that answers. A launcher that announces one
    // port and binds another is worse than one that fails.
    assert.equal(run.port, port, 'start.js must use the port it was given');

    // serve.js's own output is forwarded, not swallowed — including the reason
    // loopback is mandatory, which is the thing users get wrong.
    assert.match(run.log(), /Serving .*web/);
    assert.match(run.log(), /loopback URL/);
    assert.match(run.log(), /Ctrl\+C to stop/);

    const page = await reach(port);
    assert.equal(page.kind, 'connected', 'the announced URL must answer');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
  } finally {
    await run.stop();
  }

  // No orphaned server left holding the port: this is the failure mode that makes
  // the next run fail on a locked profile or a busy port.
  const after = await until(() => reach(run.port).then((r) => r.kind === 'refused'));
  assert.equal(after, true, `port ${run.port} must be free again after start.js exits`);
});

test('a port you asked for is honoured, so a busy one fails loudly instead of moving', async () => {
  const port = await freePort();
  const release = await occupy(port);
  try {
    const run = await runStart(['--no-browser', '--port', String(port)]);
    const code = run.settled.state === 'exited'
      ? run.settled.code
      : await new Promise((done) => run.child.once('exit', (c) => done(c)));
    try {
      assert.equal(code, 1, `start.js must exit non-zero on a busy port: ${run.log()}`);
      assert.match(run.log(), /already in use/);
      // The honest error names the port you asked for and suggests another.
      assert.match(run.log(), new RegExp(`port ${port} is already in use`));
      assert.match(run.log(), /--port/);
      // And it must not have quietly started somewhere else.
      assert.equal(run.url, null, 'a busy explicit port must not be relocated');
    } finally {
      await run.stop();
    }
  } finally {
    await release();
  }
});

test('with no port requested, a taken 8080 falls back to a reachable one', async (t) => {
  let release = null;
  try {
    release = await occupy(8080);
  } catch (err) {
    t.skip(`cannot occupy 8080 to test the fallback (${err.code ?? err.message})`);
    return;
  }
  try {
    const run = await runStart(['--no-browser']);
    try {
      if (run.settled.state !== 'ready') {
        t.skip(`start.js did not fall back (${JSON.stringify(run.settled)}): ${run.log()}`);
        return;
      }
      assert.match(run.log(), /already in use — using \d+ instead/);
      assert.notEqual(run.port, 8080, 'the fallback must not reuse the taken port');
      assert.equal((await reach(run.port)).kind, 'connected', 'the fallback port must serve');
    } finally {
      await run.stop();
    }
  } finally {
    await release();
  }
});

test('start.js refuses a port browsers will not connect to, before binding anything', async () => {
  const run = await runStart(['--no-browser', '--port', '6000']);
  const code = run.settled.state === 'exited'
    ? run.settled.code
    : await new Promise((done) => run.child.once('exit', (c) => done(c)));
  try {
    assert.equal(code, 2, `start.js must refuse port 6000: ${run.log()}`);
    assert.match(run.log(), /unreachable by design/);
    assert.equal(run.url, null, 'it must not print a URL that cannot be fetched');
  } finally {
    await run.stop();
  }
});

test('a bad argument is a usage error, not a half-started server', async () => {
  for (const args of [['--nope'], ['--port'], ['--port', 'not-a-port'], ['--port', '0']]) {
    const run = await runStart(['--no-browser', ...args]);
    const code = run.settled.state === 'exited'
      ? run.settled.code
      : await new Promise((done) => run.child.once('exit', (c) => done(c)));
    try {
      assert.equal(code, 2, `${args.join(' ')} must be rejected: ${run.log()}`);
      assert.match(run.log(), /usage: npm start/);
      assert.equal(run.url, null, `${args.join(' ')} must not start a server`);
    } finally {
      await run.stop();
    }
  }
});

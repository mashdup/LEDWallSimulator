/**
 * harness.js — plumbing shared by the suites that need a real server and a real
 * browser, so the tricky parts exist once.
 *
 * The part worth not duplicating is startServe's teardown. On Windows a plain
 * child.kill() stops only the Node process, so the Chromium it launched survives
 * as an orphan holding a profile directory and a DevTools port; the next test run
 * then pays for a second browser and may fail on a locked profile. taskkill /T is
 * the only thing that takes the whole tree, and it is easy to forget in a copy.
 *
 * decodePng lives in tools/png.js: tools/capture.js only ever reads a PNG's IHDR
 * (it hands the bytes to the browser, which decodes them itself), so anything that
 * wants to assert WHICH pixels a page produced has to decode in Node. Both sides
 * need it — the suites, and tools/bridge.js turning a captured page into frames —
 * so it is re-exported here the way freePort is.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVE_SCRIPT = fileURLToPath(new URL('../tools/serve.js', import.meta.url));

/** Poll a condition until it holds or the deadline passes; returns the final value. */
export async function waitFor(predicate, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, stepMs));
  }
}

// freePort and the PNG decoder live in tools/ so serve.js, capture.js, bridge.js
// and every suite share one implementation. Re-exported here because the suites
// import their plumbing from this file.
export { freePort } from '../tools/ports.js';
export { PNG_SIGNATURE, pngSize, decodePng, rgbOf, rgbaOf } from '../tools/png.js';

/**
 * Boot tools/serve.js as a real child process on an ephemeral port.
 *
 * A child process rather than an in-process import because serve.js owns one
 * Capture for its whole life (that is the point of it: every request reuses the
 * same tab), and importing it into the test process would share that browser with
 * every other suite in the run.
 */
export async function startServe(port) {
  const child = spawn(process.execPath, [SERVE_SCRIPT, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const ready = /LED wall dev server: http/;
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve.js did not start: ${log}`)), 15_000);
    const check = () => {
      if (!ready.test(log)) return false;
      clearTimeout(timer);
      done();
      return true;
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`serve.js exited early (${code}): ${log}`));
    });
    check();
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      await new Promise((done) => child.once('exit', done));
    },
  };
}

export const captureQuery = (params) => new URLSearchParams(params).toString();

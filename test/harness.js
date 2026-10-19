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
 *
 * The suites run one file at a time (npm test passes --test-concurrency=1).
 * Several of them launch a real Chromium; run in parallel they contend for CPU,
 * DevTools ports and profile directories, and the browser tests start timing out
 * on a machine that handles each of them fine on its own.
 */

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
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
 *
 * args are appended verbatim (e.g. ['--data', tmpFile]) so a suite can point
 * the drawings store at a temp path and never touch the repo's data/.
 */
export async function startServe(port, args = []) {
  const child = spawn(process.execPath, [SERVE_SCRIPT, '--port', String(port), ...args], {
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

/**
 * The browser side of the harness: a real Chromium speaking CDP.
 *
 * The suites that prove a page RENDERS (not just serves) all need the same
 * three things: launch a browser that survives on Windows without orphaning,
 * open tabs, and evaluate an expression in one. That plumbing is fiddly and
 * silent when it breaks, so it exists once, here.
 */

/**
 * Args that turn the gallery's guest guards off, for suites that post several
 * drawings to one server instance. The guards are ON by default - the guest
 * page is the one handed to strangers - so opting out has to be visible at
 * every call site that does.
 */
export function noGuards() {
  return ['--rate-spacing', '0', '--rate-burst', '0', '--max-drawings', '0', '--owner-token', 'test-owner-token'];
}

/** Poll a JSON endpoint until it answers, or the budget runs out. */
export async function pollJson(url, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Poll a predicate until it returns a truthy value; returns that value. */
export async function waitForValue(what, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what.label ?? 'condition'}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result);
      }
    };
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP websocket failed'));
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, {res, rej});
      this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }

  async openTab(url) {
    const {targetId} = await this.send('Target.createTarget', {url});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    await this.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', {expression, returnByValue: true}, sessionId);
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

/**
 * Launch a browser and connect. The caller owns the teardown: kill the
 * process, then remove the profile (Windows keeps a deleted profile alive
 * in the process it is locked to, hence the retries).
 */
export async function openBrowser(chrome, dbgPort, profile) {
  const proc = spawn(
    chrome,
    [
      ...(chrome.includes('headless-shell') ? [] : ['--headless=new']),
      '--no-sandbox',
      '--no-first-run',
      '--disable-gpu',
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    {stdio: 'ignore'},
  );
  const version = await pollJson(`http://127.0.0.1:${dbgPort}/json/version`);
  const cdp = await Cdp.open(version.webSocketDebuggerUrl);
  return {proc, cdp};
}

/** Windows-safe profile removal, with the retries a locked directory needs. */
export function dropProfile(dir) {
  try {
    rmSync(dir, {recursive: true, force: true, maxRetries: 12, retryDelay: 150});
  } catch {
    /* leftover temp dir; nothing the assertions depend on */
  }
}

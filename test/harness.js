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
const RELAY_SCRIPT = fileURLToPath(new URL('../relay/server.js', import.meta.url));

/**
 * Boot a Node script as a child and wait for a line in its stdout.
 *
 * startServe and startRelay are the same shape - spawn, wait for the banner,
 * tear the whole tree down - because the teardown is the part that is easy to
 * get wrong twice: on Windows a plain kill() leaves the child's own children
 * alive, and a relay that survives a test run holds the data file the next run
 * is asserting against.
 */
async function startNode(script, args, banner, what) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  // `log` accumulates every chunk, and the banner is matched against the whole
  // of it. Node's startup writes (the URL, the token, the serial probe) arrive
  // in several chunks, so a suite that needs a line from the banner - the
  // generated owner token, for one - has to read the accumulated log, not the
  // newest chunk.
  const live = () => log;
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${what} did not start: ${live()}`)), 15_000);
    const check = () => {
      if (!banner.test(live())) return false;
      clearTimeout(timer);
      done();
      return true;
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`${what} exited early (${code}): ${live()}`));
    });
    check();
  });
  return {
    log: () => log,
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

/**
 * Poll a condition until it holds, and return WHAT IT FOUND.
 *
 * The predicate is AWAITED. It used to be called without await, and a promise
 * is always truthy - so every async predicate (the CDP kind, where the
 * condition is a page eval) reported satisfied on the first poll, before the
 * page had loaded, and the assertions that followed were racing a browser.
 * Tests still passed with that, which is the worst kind of green: they passed
 * because the next assertion happened to poll properly.
 *
 * The return value is the predicate's truthy value, not `true`: a caller that
 * wants the page's status text, not just "it matched", asks for it. A predicate
 * that returns a boolean returns a boolean. `waitForValue` is kept as an alias
 * for the same contract.
 */
export async function waitFor(what, budgetMs = 15_000, stepMs = 150) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${what.label ?? 'condition'}`);
    await new Promise((done) => setTimeout(done, stepMs));
  }
}

/**
 * waitFor with a sentence attached to the failure.
 *
 * A timeout that says "timeout waiting for condition" is a debugging session;
 * the same timeout that says what the condition was is a bug report. The label
 * rides on the predicate because the predicate is the only place that knows.
 */
export function until(what, label) {
  what.label = label;
  return what;
}

export const waitForValue = waitFor;

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
  const r = await startNode(SERVE_SCRIPT, ['--port', String(port), ...args], /LED wall dev server: http/, 'serve.js');
  return { base: `http://127.0.0.1:${port}`, log: r.log, stop: r.stop };
}

/**
 * Boot relay/server.js. The relay is a plain HTTP server with no browser of its
 * own, so it needs no special isolation - only the same teardown discipline.
 */
export async function startRelay(port, args = []) {
  const r = await startNode(RELAY_SCRIPT, ['--port', String(port), '--host', '127.0.0.1', ...args], /LED wall relay: http/, 'relay/server.js');
  return { base: `http://127.0.0.1:${port}`, log: r.log, stop: r.stop };
}

/** POST a JSON body and return the response, parsed lazily by the caller. */
export async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  r.bodyText = await r.text();
  try {
    r.json = JSON.parse(r.bodyText);
  } catch {
    r.json = null;
  }
  return r;
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

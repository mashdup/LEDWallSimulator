import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

import {findChrome} from '../tools/capture.js';
import {freePort, startServe} from './harness.js';

/**
 * Content sync through the server - the only topology that reaches every
 * renderer.
 *
 * The wall's pipeline spans disconnected browser worlds: a human's content
 * tab, control tabs, and the headless capture browser that photographs the
 * page. They share no tabs and no BroadcastChannel - only the server. So
 * the content state lives at GET/POST /content, renderers poll it, and
 * every phase is derived from the server clock.
 *
 * This test drives the real thing: the HTTP contract (initial state, legal
 * posts, rejected junk) and two real browser tabs that must agree on what
 * the wall shows after a POST - the property the BroadcastChannel design
 * could never deliver to the capture browser.
 *
 * Skipped, never failed, where no browser is installed.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what.label ?? 'condition'}`);
    await sleep(150);
  }
}

class Cdp {
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

test('GET /content starts at the demo state', async () => {
  const serve = await startServe(await freePort());
  try {
    const r = await fetch(`${serve.base}/content`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.state.kind, 'demo');
    assert.ok(Number.isInteger(j.rev));
    assert.ok(Number.isFinite(j.at));
  } finally {
    await serve.stop();
  }
});

test('POST /content stores legal commands, rejects junk, bumps rev', async () => {
  const serve = await startServe(await freePort());
  try {
    const post = (body, type = 'application/json') =>
      fetch(`${serve.base}/content`, {method: 'POST', headers: {'content-type': type}, body});

    const a = await post(JSON.stringify({v: 1, kind: 'text', text: 'HELLO'}));
    assert.equal(a.status, 200);
    const ja = await a.json();
    assert.equal(ja.state.text, 'HELLO');

    const bad = await post('not json at all');
    assert.equal(bad.status, 400);
    const badKind = await post(JSON.stringify({v: 1, kind: 'world-domination'}));
    assert.equal(badKind.status, 400);

    const b = await post(JSON.stringify({v: 1, kind: 'clear'}));
    const jb = await b.json();
    assert.ok(jb.rev > ja.rev, 'rev must increase so renderers detect changes');
    assert.equal(jb.state.kind, 'clear');

    // no-store: a cached /content is a frozen wall.
    assert.match(a.headers.get('cache-control'), /no-store/);
  } finally {
    await serve.stop();
  }
});

test('two real browser tabs agree on the content after one POST', async () => {
  const chrome = findChrome();
  if (chrome === null) return; // no browser on this machine: nothing to prove

  const serve = await startServe(await freePort());
  const dbgPort = await freePort();
  const profile = mkdtempSync(`${tmpdir()}\omp-sync-`);
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

  try {
    const version = await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    });
    const cdp = await Cdp.open(version.webSocketDebuggerUrl);

    // Two independent renderers of the same page - the human's tab and the
    // capture browser are no different: both are just instances polling.
    const tabA = await cdp.openTab(`${serve.base}/content.html?wall=1`);
    const tabB = await cdp.openTab(`${serve.base}/content.html`);

    const statusIs = (session, re, label) => async () => {
      const t = await cdp.eval(session, 'document.getElementById("status").textContent');
      if (re.test(t)) return t;
      return null;
    };

    // Both modules live and polling: the initial state is the demo.
    assert.match(await waitFor(statusIs(tabA, /demo/, 'tab A polling')), /demo/);
    assert.match(await waitFor(statusIs(tabB, /demo/, 'tab B polling')), /demo/);

    // One POST, from outside both tabs - exactly what the control page does.
    const r = await fetch(`${serve.base}/content`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({v: 1, kind: 'text', text: 'SYNCED WALL'}),
    });
    assert.equal(r.status, 200);

    // BOTH tabs must show it: sync is a property of the pair, not of the POST.
    assert.match(await waitFor(statusIs(tabA, /text: SYNCED WALL/, 'tab A shows text')), /text: SYNCED WALL/);
    assert.match(await waitFor(statusIs(tabB, /text: SYNCED WALL/, 'tab B shows text')), /text: SYNCED WALL/);

    // Pixel identity: a static state must render byte-identical canvases in
    // both tabs - the property the wall depends on, since its capture page
    // is just another instance. (Static chosen deliberately: an animation
    // sampled across a second boundary would differ by one frame, which is
    // in-phase behavior, not a bug.)
    await fetch(`${serve.base}/content`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({v: 1, kind: 'fill', color: '#ff0000'}),
    });
    const fillIs = (session, label) => async () => {
      const t = await cdp.eval(session, 'document.getElementById("status").textContent');
      return /fill/.test(t) ? t : null;
    };
    await waitFor(fillIs(tabA, 'tab A shows fill'));
    await waitFor(fillIs(tabB, 'tab B shows fill'));
    const canvasIs = (session) => async () => {
      const d = await cdp.eval(session, 'document.getElementById("wall").toDataURL()');
      return d.includes('base64,') ? d : null;
    };
    const a = await waitFor(canvasIs(tabA));
    const b = await waitFor(canvasIs(tabB));
    assert.equal(a, b, 'two instances must render the identical frame');

    // An animation name must reach both tabs too (status is the ack; the
    // frames themselves are pure functions of the shared server clock).
    await fetch(`${serve.base}/content`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({v: 1, kind: 'anim', name: 'plasma'}),
    });
    assert.match(await waitFor(statusIs(tabA, /plasma/, 'tab A shows plasma')), /plasma/);
    assert.match(await waitFor(statusIs(tabB, /plasma/, 'tab B shows plasma')), /plasma/);

    // And the control page's own status mirrors the server state.
    const ctl = await cdp.openTab(`${serve.base}/control.html`);
    assert.match(await waitFor(statusIs(ctl, /rev \d+ · plasma/, 'control mirrors server')), /rev \d+ · plasma/);
  } finally {
    proc.kill();
    await serve.stop();
    try {
      rmSync(profile, {recursive: true, force: true, maxRetries: 12, retryDelay: 150});
    } catch {
      /* leftover temp dir; nothing the assertions depend on */
    }
  }
});

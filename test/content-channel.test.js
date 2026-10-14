import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

import {findChrome} from '../tools/capture.js';
import {freePort, startServe} from './harness.js';

/**
 * The content protocol, end to end, in a real browser.
 *
 * The protocol's unit tests prove the messages; the app-page tests prove each
 * page boots. Neither proves the two pages are CONNECTED: the first bug this
 * protocol shipped with was a content page with no listener at all - the
 * sender was healthy, the receiver was dead, and every test stayed green.
 *
 * So this test drives the real thing: one Chrome, two tabs (the app and
 * content.html), a click on the app's Send text button, and the content
 * page's status line read back over CDP. If BroadcastChannel, the wiring,
 * the protocol, or the content page's handler breaks on any side, this is
 * the test that says so.
 *
 * Skipped, never failed, where no browser is installed.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what.label}`);
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

test('the app page drives a content page over the channel, in a real browser', async () => {
  const chrome = findChrome();
  if (chrome === null) return; // no browser on this machine: nothing to prove

  const serve = await startServe(await freePort());
  const dbgPort = await freePort();
  const profile = mkdtempSync(`${tmpdir()}\\omp-channel-`);
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
    // Wait for the debugging endpoint, then attach at browser level.
    const version = await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    });
    version.label = 'devtools endpoint';
    const cdp = await Cdp.open(version.webSocketDebuggerUrl);

    const content = await cdp.openTab(`${serve.base}/content.html?wall=1`);
    const app = await cdp.openTab(`${serve.base}/`);

    // Both modules must be fully live before the click: the content page
    // marks its status 'demo' at the end of its module body, and the app's
    // layout dropdown is filled by app.js at the end of its own.
    const statusIs = (re, label) => async () => {
      const t = await cdp.eval(content, 'document.getElementById("status").textContent');
      return re.test(t) ? t : null;
    };
    assert.match(await waitFor(statusIs(/demo/, 'content module (status=demo)')), /demo/);

    const appReady = () => cdp.eval(app, 'document.querySelectorAll("#wallLayout option").length > 0');
    assert.ok(await waitFor(appReady));

    // The click a human makes: type text, press Send text.
    await cdp.eval(app, `
      document.getElementById('contentText').value = 'HELLO WALL';
      document.getElementById('contentSend').click();
      'clicked';
    `);

    // The far end must react: the content page's status line is the ack.
    assert.match(await waitFor(statusIs(/text: HELLO WALL/, 'channel delivery (text)')), /text: HELLO WALL/);

    // And a second kind, to prove the handler is not a one-trick listener:
    // Fill repaints, and the status flips to 'fill'.
    await cdp.eval(app, `document.getElementById('contentFill').click(); 'clicked';`);
    assert.match(await waitFor(statusIs(/^fill$/, 'channel delivery (fill)')), /^fill$/);
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

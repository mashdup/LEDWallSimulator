import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { findChrome } from '../tools/capture.js';
import { freePort, startServe, openBrowser, waitForValue as waitFor, dropProfile } from './harness.js';

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

    // The clock: GET.at is the server's CURRENT time, and must advance
    // between polls. Renderers rebase their animation clock on every poll;
    // if at were the last-POST time, every poll would snap every animation
    // back to the moment of the last command - a sawtooth clock that reads
    // as animation constantly restarting (the bug this guards).
    const g1 = await (await fetch(`${serve.base}/content`)).json();
    await new Promise((r) => setTimeout(r, 300));
    const g2 = await (await fetch(`${serve.base}/content`)).json();
    assert.ok(g2.at > g1.at, 'GET.at must advance with real time, not sit at the last POST');
  } finally {
    await serve.stop();
  }
});

test('POST/GET /content/frame: the pushed canvas round-trips', async () => {
  const serve = await startServe(await freePort());
  try {
    // Nothing pushed: 404, so the app's page source reports a clear failure
    // instead of decoding garbage.
    const empty = await fetch(`${serve.base}/content/frame`);
    assert.equal(empty.status, 404);

    const png = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG signature, minimal stand-in
    const post = await fetch(`${serve.base}/content/frame`, {
      method: 'POST',
      headers: {'content-type': 'image/png'},
      body: png,
    });
    assert.equal(post.status, 204);

    const got = await fetch(`${serve.base}/content/frame`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(got.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

    // Latest wins: the wall must never fetch a stale frame.
    const png2 = Buffer.from('00112233', 'hex');
    await fetch(`${serve.base}/content/frame`, {method: 'POST', headers: {'content-type': 'image/png'}, body: png2});
    const got2 = Buffer.from(await (await fetch(`${serve.base}/content/frame`)).arrayBuffer());
    assert.deepEqual(got2, png2);

    // Query strings are ignored: PageSource appends ?url=...&w=... to the
    // endpoint, and the push route must serve the frame regardless.
    const q = await fetch(`${serve.base}/content/frame?url=x&w=400&h=400&reload=1`);
    assert.equal(q.status, 200);
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
  let proc = null;

  try {
    const { proc: browser, cdp } = await openBrowser(chrome, dbgPort, profile);
    proc = browser;

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
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
  }
});

test('text state SCROLLS: pushed frames change over time (regression: it sat still)', async () => {
  // The frame pusher fed seek() a pass FRACTION (0..1) where it takes a
  // CELL offset in [0, period): the text rendered, sat under one cell from
  // the start, and wrapped - visible, and stone still. The wall showed the
  // word and never moved it. A frame is only alive if it CHANGES, so this
  // test compares two pushed frames 1.2 s apart: byte-identical PNGs from
  // the same encoder mean a frozen banner.
  const chrome = findChrome();
  if (chrome === null) return; // no browser on this machine: nothing to prove

  const serve = await startServe(await freePort());
  const dbgPort = await freePort();
  const profile = mkdtempSync(`${tmpdir()}\omp-scroll-`);
  let proc = null;

  try {
    const { proc: browser, cdp } = await openBrowser(chrome, dbgPort, profile);
    proc = browser;

    // The app page, switched to the content feed: it is the frame driver.
    // The eval must not race module load: the select exists in the static
    // DOM long before app.js attaches its change listener, so a single
    // dispatch can land in the void. Re-dispatch until frames flow.
    const app = await cdp.openTab(`${serve.base}/`);
    await waitFor(async () =>
      cdp.eval(app, '!!document.getElementById("sourceMode")').catch(() => null),
    20000);

    await fetch(`${serve.base}/content`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({v: 1, kind: 'text', text: 'SCROLLING BANNER TEST', color: '#00ff00'}),
    });

    const frame = async () => {
      const r = await fetch(`${serve.base}/content/frame`);
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    };
    const dispatch = () =>
      cdp.eval(
        app,
        '(() => { const s = document.getElementById("sourceMode"); s.value = "content"; s.dispatchEvent(new Event("change")); })();',
      ).catch(() => {});
    // A background tab in the test browser is throttled to ~1 Hz, so the
    // first push can take a second; the dispatch retry covers the listener
    // race, the budget covers the throttle.
    const f1 = await waitFor(async () => {
      const f = await frame();
      if (f !== null) return f;
      await dispatch();
      await sleep(400);
      return null;
    }, 25000);
    await sleep(1500);
    const f2 = await waitFor(frame, 20000);
    assert.ok(!f1.equals(f2), 'pushed text frames are byte-identical over 1.5 s: the banner is not scrolling');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
  }
});

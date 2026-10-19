import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findChrome } from '../tools/capture.js';
import {
  freePort,
  startServe,
  openBrowser,
  waitForValue as waitFor,
  dropProfile,
} from './harness.js';
import { GRID, emptyPixels, pixelsToHex, pixelsFromHex } from '../core/drawings.js';

/**
 * The guest page (public.html): a stranger with a phone.
 *
 * Two promises, and both are about capability, not pixels:
 *   1. it can add to the gallery and NOTHING ELSE - no content command, no
 *      WebSocket, no wall control. The page's own DOM is the boundary a guest
 *      can see, so the test asserts the boundary, not just the happy path.
 *   2. "on the wall right now" is the drawing the wall is painting, derived
 *      from the server clock by the same arithmetic the renderers use.
 *
 * Drawing happens through synthetic pointer events on the canvas: the page is
 * a pointer surface, and poking a JS field would test a path no guest takes.
 *
 * Skipped, never failed, where no browser is installed.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
}

function solid(rgba) {
  const p = emptyPixels();
  for (let i = 0; i < GRID * GRID; i++) {
    p[i * 4] = rgba[0]; p[i * 4 + 1] = rgba[1]; p[i * 4 + 2] = rgba[2]; p[i * 4 + 3] = 255;
  }
  return p;
}

/** One tap at the centre of cell (x, y), down and up, as a finger does it. */
function tap(x, y) {
  return `(() => {
    const c = document.getElementById('grid');
    const r = c.getBoundingClientRect();
    const cx = r.left + ((${x} + 0.5) * r.width) / ${GRID};
    const cy = r.top + ((${y} + 0.5) * r.height) / ${GRID};
    const mk = (t) => new PointerEvent(t, { pointerId: 1, clientX: cx, clientY: cy, bubbles: true, isPrimary: true });
    c.dispatchEvent(mk('pointerdown'));
    c.dispatchEvent(mk('pointerup'));
    return document.getElementById('cells').textContent;
  })()`;
}

/** Record every non-GET fetch and every WebSocket construction from load on. */
const SPY = `(() => {
  window.__posts = [];
  window.__ws = [];
  const fetch0 = window.fetch;
  window.fetch = (url, opts) => {
    const m = (opts && opts.method ? String(opts.method) : 'GET').toUpperCase();
    if (m !== 'GET') window.__posts.push(m + ' ' + String(url));
    return fetch0(url, opts);
  };
  const WS = window.WebSocket;
  window.WebSocket = function (url, proto) { window.__ws.push(String(url)); return new WS(url, proto); };
  return 'spy';
})()`;

test('the guest page saves to the gallery and never addresses the wall', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-public-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json')]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-public-profile-'));
  let proc = null;

  try {
    const before = await (await fetch(`${serve.base}/content`)).json();

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/public.html`);
    // Ready means the MODULE has run, not that the DOM exists: the markup is
    // there before a single swatch is rendered, and a click on a swatch that
    // is not there yet is a null, not a failure of the page.
    await waitFor(async () => cdp.eval(tab, `(() => {
      if (!document.querySelector('#palette .swatch')) return null;
      ${SPY}
      return 'ready';
    })()`).catch(() => null), 15_000);

    // The empty grid gates the one verb: a guest is not shown a button that
    // can only fail.
    assert.equal(
      await cdp.eval(tab, 'document.getElementById("save").disabled'),
      true,
      'an empty drawing must disable the save button',
    );

    // Draw one red cell, sign it, put it on the wall.
    await cdp.eval(tab, `document.querySelector('#palette .swatch[title="#ff0000"]').click()`);
    const cells = await cdp.eval(tab, tap(2, 3));
    assert.equal(cells, '1 / 400 lit', 'one tap must light exactly one cell');
    await cdp.eval(tab, `document.getElementById('name').value = 'guest'`);
    assert.equal(await cdp.eval(tab, 'document.getElementById("save").disabled'), false,
      'a lit cell must enable the save button');
    await cdp.eval(tab, `document.getElementById('save').click()`);

    const list = await waitFor(async () => {
      const metas = await (await fetch(`${serve.base}/drawings`)).json();
      return metas.length === 1 ? metas : null;
    }, 15_000);
    assert.equal(list[0].name, 'guest', 'the signature is the entry name');

    // The stored bytes are the drawn bytes: the cell lit, everything else OFF.
    const entry = await (await fetch(`${serve.base}/drawings/${list[0].id}`)).json();
    const p = pixelsFromHex(entry.pixels);
    const at = (x, y) => [p[(y * GRID + x) * 4], p[(y * GRID + x) * 4 + 1], p[(y * GRID + x) * 4 + 2], p[(y * GRID + x) * 4 + 3]];
    assert.deepEqual(at(2, 3), [255, 0, 0, 255], 'the tapped cell must be stored lit and red');
    assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'an untouched cell must be stored OFF, not white');

    // The capability boundary: exactly one write, to /drawings, and no
    // WebSocket at all. A guest page that can POST /content can clear the
    // wall, dim it, or scroll text over somebody's drawing.
    const posts = await cdp.eval(tab, 'JSON.stringify(window.__posts)');
    assert.deepEqual(JSON.parse(posts), ['POST /drawings'], 'the only write allowed is the gallery');
    assert.deepEqual(JSON.parse(await cdp.eval(tab, 'JSON.stringify(window.__ws)')), [], 'no socket: no wall feed');

    // Belt to the same braces: the wall's content state is untouched - same
    // rev, before and after a guest saved.
    const after = await (await fetch(`${serve.base}/content`)).json();
    assert.equal(after.rev, before.rev, 'a guest save must not change the wall content rev');

    // And the page offers no controls a guest has no business having.
    const dom = await cdp.eval(tab, `(() => {
      const ids = ['send', 'gallery', 'interval', 'brightness', 'limitMa', 'contentText'];
      return JSON.stringify(ids.filter((i) => document.getElementById(i) !== null));
    })()`);
    assert.deepEqual(JSON.parse(dom), [], 'no wall controls in the guest DOM');

    // The thank-you moment is the guest's only feedback that anything happened.
    assert.equal(await cdp.eval(tab, 'document.getElementById("thanks").hidden'), false,
      'saving must show the thank-you card');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

test('the guest page shows what the wall is showing, by the server clock', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-publicnow-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json')]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-publicnow-profile-'));
  let proc = null;

  try {
    const red = await postJson(`${serve.base}/drawings`, { name: 'red', pixels: pixelsToHex(solid([255, 0, 0])) });
    const blue = await postJson(`${serve.base}/drawings`, { name: 'blue', pixels: pixelsToHex(solid([0, 0, 255])) });
    assert.ok(red.ok && blue.ok);
    const start = await postJson(`${serve.base}/content`, { v: 1, kind: 'gallery', interval: 4 });
    assert.equal(start.status, 200);

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/public.html`);

    // The module has run and the first gallery read has landed.
    await waitFor(async () => cdp.eval(tab, `document.querySelector('#strip canvas') ? 'ready' : null`)
      .catch(() => null), 15_000);

    // The panel fills in from two reads (the list, then the entry's pixels);
    // wait for the name to appear rather than for a fixed delay.
    const seen = await waitFor(async () => {
      const who = await cdp.eval(tab, 'document.getElementById("who").textContent').catch(() => '');
      return who === 'red' || who === 'blue' ? who : null;
    }, 20_000);
    assert.ok(['red', 'blue'].includes(seen), `the panel must name a saved drawing, saw ${seen}`);

    // The panel must agree with the server clock, which is the same arithmetic
    // the wall's renderers use: index = floor(serverTime / interval) % n. The
    // tolerance is one step, because the page and Node read the clock at
    // different instants and the cycle moves.
    const state = await (await fetch(`${serve.base}/content`)).json();
    const metas = await (await fetch(`${serve.base}/drawings`)).json();
    const n = metas.length;
    const idx = Math.floor(state.at / 1000 / state.state.interval) % n;
    const allowed = [metas[idx].name, metas[(idx + 1) % n].name];
    assert.ok(allowed.includes(seen), `the panel must show ${allowed.join(' or ')}, saw ${seen}`);

    // The highlighted thumbnail is the same entry the panel names: the strip
    // and the panel are one state, not two widgets that can disagree.
    const marked = await cdp.eval(tab, `(() => {
      const on = document.querySelector('#strip canvas.on');
      return on === null ? null : on.dataset.idx;
    })()`);
    assert.ok(marked !== null, 'the strip must mark the current entry');
    assert.equal(metas[Number(marked)].name, seen, 'the strip highlight and the panel must name the same drawing');

    // The countdown is the guest's proof the wall is alive, and it must be
    // inside the interval it was given. It is polled, not read once: the panel
    // fills in as the page's first reads land.
    const when = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("when").textContent').catch(() => '');
      return /next in \d+ s/.test(t) ? t : null;
    }, 10_000);
    const secs = Number(when.match(/next in (\d+) s/)[1]);
    assert.ok(secs >= 1 && secs <= 4, `the countdown must be within the interval, saw '${when}'`);

    // The page's glow is the wall's color: the room and the wall agree.
    const glow = await cdp.eval(tab, `getComputedStyle(document.documentElement).getPropertyValue('--glow').trim()`);
    const [r, g, b] = glow.split(',').map((v) => Number(v.trim()));
    const lit = seen === 'red' ? [r > 150 && g < 90 && b < 90] : [b > 150 && r < 90 && g < 90];
    assert.ok(lit[0], `the page glow must take the wall's color (${seen}), saw ${glow}`);

    // A one-off picture (sent by the owner) reads in the panel too: the guest
    // sees what the wall sees, whatever the wall is showing.
    const pic = await postJson(`${serve.base}/content`, { v: 1, kind: 'pic', pixels: pixelsToHex(solid([0, 255, 0])) });
    assert.equal(pic.status, 200);
    const label = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("who").textContent').catch(() => '');
      return t.includes('one-off') ? t : null;
    }, 15_000);
    assert.match(label, /one-off picture/);
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

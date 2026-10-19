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
import { GRID, pixelsFromHex } from '../core/drawings.js';

/**
 * The guest page (public.html): a stranger with a phone.
 *
 * The promise is capability, and the page is small enough to assert it
 * completely: it draws, it signs, it saves, and it touches the server EXACTLY
 * once - `POST /drawings`. No content command, no WebSocket, no reads of the
 * wall's state, no wall panel in its DOM. A guest page that can POST /content
 * can clear the wall, dim it, or scroll text over somebody's drawing; a guest
 * page that shows the wall's state is a page with a polling loop to get wrong.
 *
 * Drawing happens through synthetic pointer events on the canvas: the page is
 * a pointer surface, and poking a JS field would test a path no guest takes.
 *
 * Skipped, never failed, where no browser is installed.
 */

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

/** Record every fetch and every WebSocket construction, from this moment on. */
const SPY = `(() => {
  window.__calls = [];
  window.__ws = [];
  const fetch0 = window.fetch;
  window.fetch = (url, opts) => {
    const m = (opts && opts.method ? String(opts.method) : 'GET').toUpperCase();
    window.__calls.push(m + ' ' + String(url));
    return fetch0(url, opts);
  };
  const WS = window.WebSocket;
  window.WebSocket = function (url, proto) { window.__ws.push(String(url)); return new WS(url, proto); };
  return 'spy';
})()`;

test('a guest draws, signs, saves - and touches the server exactly once', async () => {
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

    // Nothing is read: no wall state, no gallery list, no frame. The page
    // cannot show what the wall is showing, and does not try to.
    assert.deepEqual(JSON.parse(await cdp.eval(tab, 'JSON.stringify(window.__calls)')), [],
      'the guest page must not poll the server');

    // The empty grid gates the one verb: a guest is not shown a button that
    // can only fail.
    assert.equal(await cdp.eval(tab, 'document.getElementById("save").disabled'), true,
      'an empty drawing must disable the save button');

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

    // The whole capability boundary, in one line: exactly one request, a
    // POST, to /drawings - and no socket, so no wall feed to write into.
    assert.deepEqual(JSON.parse(await cdp.eval(tab, 'JSON.stringify(window.__calls)')), ['POST /drawings'],
      'the only request a guest page may make is the gallery save');
    assert.deepEqual(JSON.parse(await cdp.eval(tab, 'JSON.stringify(window.__ws)')), [], 'no socket: no wall feed');

    // Belt to the same braces: the wall's content state is untouched - same
    // rev, before and after a guest saved.
    const after = await (await fetch(`${serve.base}/content`)).json();
    assert.equal(after.rev, before.rev, 'a guest save must not change the wall content rev');

    // And the DOM a guest can see carries no wall controls and no wall panel:
    // not hidden, not disabled - absent.
    const dom = await cdp.eval(tab, `(() => {
      const ids = ['send', 'gallery', 'interval', 'brightness', 'limitMa', 'contentText',
                   'now', 'strip', 'who', 'when', 'liveDot', 'liveLabel'];
      return JSON.stringify(ids.filter((i) => document.getElementById(i) !== null));
    })()`);
    assert.deepEqual(JSON.parse(dom), [], 'no wall controls and no wall panel in the guest DOM');

    // The guest's only feedback: the card with the drawing that was saved,
    // and the per-device pause that follows.
    assert.equal(await cdp.eval(tab, 'document.getElementById("thanks").hidden'), false,
      'saving must show the thank-you card');
    const label = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("save").textContent').catch(() => '');
      return t.startsWith('Next one in') ? t : null;
    }, 5_000);
    assert.match(label, /Next one in \d+ s/, 'the save must be followed by the cooldown label');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

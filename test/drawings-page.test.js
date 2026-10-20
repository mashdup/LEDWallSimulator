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
  noGuards,
  waitForValue as waitFor,
  dropProfile,
  decodePng,
  rgbaOf,
} from './harness.js';
import { GRID, emptyPixels, pixelsToHex } from '../core/drawings.js';

/**
 * A drawing the wall can see: editor bytes -> server -> content page ->
 * pushed frame pixels.
 *
 * The assertions are on the PUSHED FRAME, decoded in Node, not on the page's
 * DOM: the wall photographs that frame, so "the status line says pic" proves
 * nothing. A pixel that arrives at the right cell with the right color is
 * what a drawing being displayed actually means.
 *
 * Skipped, never failed, where no browser is installed.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function at(rgba, x, y) {
  const i = (y * GRID + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
}

async function frame(serve) {
  const r = await fetch(`${serve.base}/content/frame`);
  if (!r.ok) return null;
  const png = Buffer.from(await r.arrayBuffer());
  const decoded = decodePng(png);
  if (decoded.w !== GRID || decoded.h !== GRID) return null; // not the 20x20 push yet
  return { rgba: rgbaOf(decoded), png };
}

function solid(rgba) {
  const p = emptyPixels();
  for (let i = 0; i < GRID * GRID; i++) {
    p[i * 4] = rgba[0]; p[i * 4 + 1] = rgba[1]; p[i * 4 + 2] = rgba[2]; p[i * 4 + 3] = 255;
  }
  return p;
}

/** Poll the pushed frame until `pick` selects something from it. */
async function frameWhere(serve, pick, budgetMs = 25_000) {
  return waitFor(async () => {
    const shot = await frame(serve);
    return shot === null ? null : pick(shot);
  }, budgetMs);
}

test('a pic message paints the drawing on the wall feed, cell for cell', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-pic-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-pic-profile-'));
  let proc = null;

  try {
    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/content.html?wall=1`);
    await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /demo/.test(t) ? t : null;
    });

    // A pattern with a hole: two lit cells, everything else transparent. The
    // hole is the point — a drawing's empty cells must stay OFF, not become
    // white, not become black-on-black, just nothing.
    const p = emptyPixels();
    const put = (x, y, r, g, b) => {
      const i = (y * GRID + x) * 4;
      p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255;
    };
    put(2, 3, 255, 0, 0);
    put(17, 18, 0, 255, 0);

    const sent = await postJson(`${serve.base}/content`, { v: 1, kind: 'pic', pixels: pixelsToHex(p) });
    assert.equal(sent.status, 200);

    // Poll for the pattern, not for the first frame that arrives: the page is
    // already running the demo, and its frame is legal - the assertion is
    // about THIS drawing landing.
    const shot = await frameWhere(serve, (s) => (at(s.rgba, 2, 3)[3] === 255 ? s : null));
    assert.deepEqual(at(shot.rgba, 2, 3), [255, 0, 0, 255], 'the red cell must land on its own cell');
    assert.deepEqual(at(shot.rgba, 17, 18), [0, 255, 0, 255], 'and the green one on its own');
    assert.equal(at(shot.rgba, 0, 0)[3], 0, 'an unused cell must push as transparent, not as a color');
    assert.deepEqual(at(shot.rgba, 3, 3), [0, 0, 0, 0], 'no bleed into the neighbour');

    // The status line is the human-facing ack, and the gallery label must not
    // leak into a one-shot pic.
    const status = await cdp.eval(tab, 'document.getElementById("status").textContent');
    assert.match(status, /pic/);
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

test('the gallery cycles the saved drawings, driven by the server clock', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-gallery-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-gallery-profile-'));
  let proc = null;

  try {
    // Entries exist BEFORE the gallery starts: the list is fetched on entry,
    // and the cycle position is floor(serverTime / interval) % n, so a page
    // that loads mid-cycle lands on the same drawing as one that has been
    // open all along.
    const red = await postJson(`${serve.base}/drawings`, { name: 'red', pixels: pixelsToHex(solid([255, 0, 0])) });
    const blue = await postJson(`${serve.base}/drawings`, { name: 'blue', pixels: pixelsToHex(solid([0, 0, 255])) });
    assert.ok(red.ok && blue.ok);

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/content.html?wall=1`);
    await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /demo/.test(t) ? t : null;
    });

    const start = await postJson(`${serve.base}/content`, { v: 1, kind: 'gallery', interval: 1 });
    assert.equal(start.status, 200);

    // Two seconds at one second per drawing: both entries must appear, and
    // each must be the whole wall (the gallery shows one drawing at a time).
    const seen = new Set();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const shot = await frame(serve);
      if (shot !== null) {
        const c = at(shot.rgba, 0, 0);
        if (c[3] === 255 && c[0] === 255 && c[1] === 0 && c[2] === 0) seen.add('red');
        if (c[3] === 255 && c[0] === 0 && c[1] === 0 && c[2] === 255) seen.add('blue');
        if (seen.size === 2) break;
      }
      await sleep(120);
    }
    assert.deepEqual([...seen].sort(), ['blue', 'red'], 'the gallery must show every saved drawing in turn');

    // The status names the entry: a wall that cycles silently is a wall
    // nobody can explain.
    const status = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /gallery 1\/2|gallery 2\/2/.test(t) ? t : null;
    }, 10_000);
    assert.match(status, /gallery [12]\/2 · (red|blue)/);

    // An empty gallery is a black wall, not a crash: delete everything and
    // the renderer must keep serving frames. The owner token is what opens a
    // delete - the same gate the owner's page uses.
    for (const id of [red.json.id, blue.json.id]) {
      await fetch(`${serve.base}/drawings/${id}`, {
        method: 'DELETE', headers: { 'x-wall-owner': 'test-owner-token' },
      });
    }
    const cleared = await frameWhere(serve, (s) => (at(s.rgba, 0, 0)[3] === 0 ? s : null), 15_000);
    assert.ok(cleared, 'an emptied gallery must go dark');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

test('the APP tab as frame driver shows drawings too, not the demo', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-appdraw-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-appdraw-profile-'));
  let proc = null;

  try {
    const one = await postJson(`${serve.base}/drawings`, {
      name: 'red', pixels: pixelsToHex(solid([255, 0, 0])),
    });
    assert.ok(one.ok);

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/index.html`);

    // The app generates the wall's frames only in the content feed - the mode
    // the wall runs in, because the app tab holds the keep-alive and a hidden
    // content tab throttles and starves the push. Drive it from the DOM, the
    // way a person does.
    // Runtime.evaluate takes an EXPRESSION, so the DOM poke has to be an IIFE.
    // And it re-dispatches every poll: the page's DOM exists before app.js has
    // run, so a change event fired once can land on a select with no listener
    // attached yet - the app boots in its default mode and never sees it.
    // Confirmation is the app's own field, not the select's value.
    await waitFor(async () => cdp.eval(tab, `(() => {
      const sel = document.getElementById('sourceMode');
      if (!sel) return null;
      sel.value = 'content';
      sel.dispatchEvent(new Event('change'));
      return document.getElementById('pageEndpoint').value === '/content/frame' ? 'content-feed' : null;
    })()`).catch(() => null), 15_000);

    // A fill first: the frame the gallery must REPLACE. Asserting on red alone
    // would pass with the demo branch, which is the bug this guards.
    const blue = await postJson(`${serve.base}/content`, { v: 1, kind: 'fill', color: '#0000ff' });
    assert.equal(blue.status, 200);
    await frameWhere(serve, (s) => {
      const c = at(s.rgba, 0, 0);
      return c[2] === 255 && c[3] === 255 ? s : null;
    }, 25_000);

    const gallery = await postJson(`${serve.base}/content`, { v: 1, kind: 'gallery', interval: 1 });
    assert.equal(gallery.status, 200);

    const red = await frameWhere(serve, (s) => {
      const c = at(s.rgba, 0, 0);
      return c[0] === 255 && c[1] === 0 && c[2] === 0 && c[3] === 255 ? s : null;
    }, 25_000);
    assert.ok(red, 'the app driver must paint the gallery drawing, not play the demo');

    // The break, through the driver that actually runs the wall. The app tab is
    // the frame driver in content-feed mode - it holds the keep-alive and is
    // never throttled - so the break has to be resolved HERE, not only in a
    // content tab. The driver's job is to say which slot of the cycle the clock
    // is in and hand animFrame an anim state; animFrame's own gallery branch is
    // black on purpose, so a driver that forgets plays a dark wall where the
    // break animation belongs.
    const withBreak = await postJson(`${serve.base}/content`, {
      v: 1, kind: 'gallery', interval: 1, gap: 1, gapAnim: 'plasma',
    });
    assert.equal(withBreak.status, 200);
    const breakSeen = await frameWhere(serve, (s) => (classify(s) === 'other' ? s : null), 25_000);
    assert.ok(breakSeen, 'the app driver must paint the break animation, not a dark wall');

    // And a one-shot pic through the same driver.
    const pic = await postJson(`${serve.base}/content`, {
      v: 1, kind: 'pic', pixels: pixelsToHex(solid([0, 255, 0])),
    });
    assert.equal(pic.status, 200);
    await frameWhere(serve, (s) => {
      const c = at(s.rgba, 0, 0);
      return c[1] === 255 && c[3] === 255 ? s : null;
    }, 25_000);
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

test('the owner prunes the gallery with the token, and a page without it cannot', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-owner-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-owner-profile-'));
  let proc = null;

  try {
    const one = await postJson(`${serve.base}/drawings`, {
      name: 'red', pixels: pixelsToHex(solid([255, 0, 0])),
    });
    assert.ok(one.ok);

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/draw.html`);
    const listed = async () => cdp.eval(tab, `document.querySelectorAll('#entries .entry').length === 1 ? 'ready' : null`)
      .catch(() => null);
    await waitFor(listed, 15_000);

    // No token in this browser: the ✕ is refused, out loud, and the entry
    // stays. A guest page has nothing to add here - it is not shown a button
    // that can only fail in the first place.
    await cdp.eval(tab, `document.querySelector('#entries .entry button:last-child').click()`);
    const refused = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /owner token/i.test(t) ? t : null;
    }, 10_000);
    assert.match(refused, /owner token/);
    assert.equal((await (await fetch(`${serve.base}/drawings`)).json()).length, 1,
      'a page with no token cannot prune the gallery');

    // The token, typed once and remembered per browser. The reload is deferred
    // because navigating destroys the execution context the eval is running in.
    await cdp.eval(tab, `(() => {
      localStorage.setItem('ledwall-owner-token', 'test-owner-token');
      setTimeout(() => location.reload(), 0);
      return 'ok';
    })()`).catch(() => null);
    // Readiness is the RELOADED page: the token in the field (it is read from
    // storage at load) and the entry listed. Polling only the entry list can
    // be answered by the old page still on screen, and the next click then
    // lands on a page mid-navigation with no DOM at all.
    await waitFor(async () => cdp.eval(tab, `(() => {
      const ok = document.getElementById('owner')?.value === 'test-owner-token'
        && document.querySelectorAll('#entries .entry').length === 1;
      return ok ? 'ready' : null;
    })()`).catch(() => null), 15_000);

    await cdp.eval(tab, `document.querySelector('#entries .entry button:last-child').click()`);
    await waitFor(async () => {
      const metas = await (await fetch(`${serve.base}/drawings`)).json();
      return metas.length === 0;
    }, 10_000);
    assert.deepEqual(await (await fetch(`${serve.base}/drawings`)).json(), [],
      'the owner token prunes what a stranger cannot touch');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

/**
 * Classify a frame by counting its cells. Corners are not enough: an
 * animation's corners are legitimately black at some phases (plasma fades, the
 * demo bounces elsewhere), so a corner test reads a living animation as a dark
 * wall. The two drawings here are uniform 400-cell fills, which is the only
 * thing a frame can be "solid" against.
 */
function classify(shot) {
  let lit = 0;
  let red = 0;
  let blue = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = at(shot.rgba, x, y);
      if (c[3] === 0) continue;
      lit += 1;
      if (c[0] === 255 && c[1] === 0 && c[2] === 0) red += 1;
      else if (c[0] === 0 && c[1] === 0 && c[2] === 255) blue += 1;
    }
  }
  if (lit === 0) return 'dark';
  if (red === GRID * GRID) return 'red';
  if (blue === GRID * GRID) return 'blue';
  return 'other';
}

/**
 * Watch the feed for `ms` and return every frame kind seen, in order of first
 * sight. `stop` is a predicate on the set, not a size: a frame that is dark
 * counts too (the list fetch, the first tick of a drawing that has not
 * arrived), so "three kinds" is not the same as "the cycle is proven".
 */
async function watchKinds(serve, ms, stop = (seen) => seen.size >= 3) {
  const seen = new Set();
  const order = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !stop(order)) {
    const shot = await frame(serve);
    if (shot !== null) {
      const k = classify(shot);
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
    await sleep(100);
  }
  return order;
}

test('the gallery takes a break: an animation fills the gap between drawings', async () => {
  const chrome = findChrome();
  if (chrome === null) return;

  const dir = mkdtempSync(join(tmpdir(), 'omp-break-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'drawings.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-break-profile-'));
  let proc = null;

  try {
    const red = await postJson(`${serve.base}/drawings`, { name: 'red', pixels: pixelsToHex(solid([255, 0, 0])) });
    const blue = await postJson(`${serve.base}/drawings`, { name: 'blue', pixels: pixelsToHex(solid([0, 0, 255])) });
    assert.ok(red.ok && blue.ok);

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/content.html?wall=1`);
    await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /demo/.test(t) ? t : null;
    });

    // One second of drawing, one second of plasma, twice round: a 4 s cycle.
    const start = await postJson(`${serve.base}/content`, {
      v: 1, kind: 'gallery', interval: 1, gap: 1, gapAnim: 'plasma',
    });
    assert.equal(start.status, 200);

    const seen = await watchKinds(serve, 30_000, (o) => o.includes('red') && o.includes('blue') && o.includes('other'));
    for (const k of ['red', 'blue', 'other']) {
      assert.ok(seen.includes(k), `the cycle must contain ${k}; saw ${JSON.stringify(seen)}`);
    }

    // The status names the break too: a wall that animates silently is a wall
    // nobody can explain to a guest.
    const status = await waitFor(async () => {
      const t = await cdp.eval(tab, 'document.getElementById("status").textContent').catch(() => '');
      return /gallery break/.test(t) ? t : null;
    }, 10_000);
    assert.match(status, /gallery break · plasma/);

    // gapAnim 'none' is the same cadence with a dark gap - the break is a
    // duration, and what fills it is a choice.
    const plain = await postJson(`${serve.base}/content`, {
      v: 1, kind: 'gallery', interval: 1, gap: 1, gapAnim: 'none',
    });
    assert.equal(plain.status, 200);
    const dark = await watchKinds(serve, 30_000, (o) => o.includes('red') && o.includes('blue') && o.includes('dark'));
    for (const k of ['red', 'blue', 'dark']) {
      assert.ok(dark.includes(k), `a dark break must show ${k}; saw ${JSON.stringify(dark)}`);
    }
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    dropProfile(profile);
    dropProfile(dir);
  }
});

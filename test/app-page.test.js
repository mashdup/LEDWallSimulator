import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

import { findChrome } from '../tools/capture.js';
import { freePort, startServe, openBrowser, waitFor, waitForValue, dropProfile, noGuards } from './harness.js';
import { GAP_ANIM_NAMES, TRANSITION_NAMES } from '../core/content-protocol.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

/**
 * index.html boots — or says exactly why it did not.
 *
 * The failure this defends is the most likely way this app is ever opened wrong:
 * double-clicking web/index.html. A `<script type="module" src="./app.js">` whose
 * import is refused by file:// runs none of its own code, so the page shows a
 * black canvas, a header, and a console line nobody has open. Every control is
 * present, every readout is empty, and nothing on screen mentions the port.
 *
 * index.html therefore catches its own import and prints the reason. That is only
 * worth having if it is checked, and the check has to be a real browser loading a
 * real file:// URL: Node cannot tell you what a browser refuses.
 *
 * `--dump-dom` is the instrument because it serialises the live DOM after the
 * page's own script has run, which is the only way to see both halves of the
 * contract: the banner visible on a file:// open, and the app genuinely running
 * when served (the layout dropdown is empty in the HTML and is filled by app.js,
 * so a populated one is proof the module body executed).
 *
 * Skipped, never failed, where no browser is installed.
 */

const INDEX = fileURLToPath(new URL('../web/index.html', import.meta.url));

/**
 * Browsers that actually implement --dump-dom.
 *
 * Not every Chromium on this machine can do it, and the failure is not an error
 * message: the Playwright `chrome.exe` build accepts the flag, prints nothing, and
 * hangs until it is killed — even on about:blank. The classic `chrome-headless-shell`
 * build and Edge both dump and exit. So the candidates are tried in order with a
 * short deadline each, rather than trusting findChrome()'s answer (which is the
 * right answer for CDP capture and the wrong one here).
 */
function dumpCandidates() {
  // Ranked by whether the build is known to honour --dump-dom, cheapest first:
  // a build that ignores the flag only reveals itself by timing out.
  const RANK = { 'chrome-headless-shell.exe': 0, 'msedge.exe': 1, 'chrome.exe': 2 };
  const roots = [
    `${process.env.LOCALAPPDATA}\\ms-playwright`,
    'C:/Program Files/Google/Chrome/Application',
    'C:/Program Files (x86)/Google/Chrome/Application',
    'C:/Program Files/Microsoft/Edge/Application',
    'C:/Program Files (x86)/Microsoft/Edge/Application',
  ];
  const found = new Set();
  const names = ['chrome-headless-shell.exe', 'msedge.exe', 'chrome.exe'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // A system browser sits directly in its Application directory; ms-playwright
    // keeps one directory per revision, with the binary one level deeper.
    for (const name of names) {
      const direct = join(root, name);
      if (existsSync(direct)) found.add(direct);
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(root, entry.name);
      for (const name of names) {
        for (const dir of [nested, join(nested, 'chrome-win64'), join(nested, 'chrome-headless-shell-win64')]) {
          const candidate = join(dir, name);
          if (existsSync(candidate)) found.add(candidate);
        }
      }
    }
  }
  return [...found].sort((a, b) => {
    const byName = RANK[basename(a)] - RANK[basename(b)];
    // Within a build type, the newest Playwright revision first.
    return byName || b.localeCompare(a, 'en', { numeric: true });
  });
}

/** Load a URL in a real browser and return the DOM as the browser left it. */
function dumpDom(url, budgetMs) {
  const failures = [];
  for (const browser of dumpCandidates()) {
    const profile = mkdtempSync(`${tmpdir()}\\omp-dumpdom-`);
    try {
      const run = spawnSync(
        browser,
        [
          // --headless=new only exists on the normal build; the shell binary is
          // headless by construction and rejects the flag.
          ...(browser.includes('headless-shell') ? [] : ['--headless=new']),
          '--no-sandbox',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          '--disable-extensions',
          '--hide-scrollbars',
          `--user-data-dir=${profile}`,
          `--virtual-time-budget=${budgetMs}`,
          '--dump-dom',
          url,
        ],
        { encoding: 'utf8', timeout: 25_000, windowsHide: true },
      );
      if (run.status === 0 && run.stdout.includes('<')) return run.stdout;
      failures.push(
        `${browser}: exit ${run.status ?? run.signal} ${String(run.stderr ?? '').slice(0, 160)}`.trim(),
      );
    } finally {
      // Chromium releases profile files lazily, so this delete can lose a race
      // against a handle the browser has not closed. It is cleanup: a leftover
      // temp dir must not turn a passing DOM assertion into a test failure.
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
      } catch {
        /* left behind in the temp dir; nothing the assertions depend on */
      }
    }
  }
  if (failures.length === 0) return null; // no browser installed at all
  throw new Error(`dump-dom failed for ${url}:\n${failures.join('\n')}`);
}

/** The opening tag of an element, so attribute state can be asserted. */
function tag(dom, id) {
  const at = dom.indexOf(`id="${id}"`);
  if (at === -1) throw new Error(`no element with id "${id}" in the dumped DOM`);
  const end = dom.indexOf('>', at);
  return dom.slice(at, end === -1 ? at + 200 : end + 1);
}

/**
 * Text inside an element, tags stripped. The window runs to the element's own
 * closing tag (nested tags are counted) so a banner made of several <p> is read
 * whole rather than truncated at the first </p>.
 */
function inner(dom, id) {
  const at = dom.indexOf(`id="${id}"`);
  if (at === -1) throw new Error(`no element with id "${id}" in the dumped DOM`);
  const start = dom.indexOf('>', at) + 1;
  const name = dom.slice(dom.lastIndexOf('<', at) + 1, dom.indexOf('>', at)).split(/\s/)[0];
  let depth = 1;
  let cursor = start;
  while (depth > 0) {
    const next = dom.indexOf('<', cursor);
    if (next === -1) break;
    if (dom.startsWith(`</${name}`, next)) depth -= 1;
    else if (dom.startsWith(`<${name}`, next) && !dom.startsWith(`<${name}/`, next)) depth += 1;
    cursor = dom.indexOf('>', next) + 1;
  }
  return dom.slice(start, cursor).replace(/<[^>]*>/g, ' ').trim();
}

test('opening index.html from disk says why the sim never started', (t) => {
  const dom = dumpDom(`file:///${INDEX.replace(/\\/g, '/')}`, 4000);
  if (dom === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  // The banner must be VISIBLE: `hidden` is removed by app.js's catch block, and
  // an element that is present but hidden is the same silence as no element at all.
  assert.doesNotMatch(tag(dom, 'bootError'), /\bhidden\b/, 'the boot failure banner must be visible');
  assert.match(inner(dom, 'bootError'), /must be served, not opened from disk/);
  assert.match(inner(dom, 'bootError'), /npm start/);

  // The browser's own reason, not a generic warning: this is what tells you the
  // scheme is the problem rather than a broken build.
  assert.match(inner(dom, 'bootErrorDetail'), /Failed to fetch dynamically imported module/);

  // Proof the app really did not run: #wallLayout is empty in the HTML and app.js
  // fills it synchronously at boot from core/layout.js variants.
  assert.equal(inner(dom, 'wallLayout'), '', 'app.js must not have populated the layout list');
});

test('the same page served over loopback boots the app and stays quiet', async (t) => {
  const port = await freePort();
  const serve = await startServe(port);
  let dom = null;
  try {
    dom = dumpDom(`${serve.base}/`, 6000);
    if (dom === null) {
      t.skip('no Chrome/Chromium/Edge on this machine');
      return;
    }

    // Served: the banner exists (it is in the markup) but stays hidden. Asserting
    // the attribute rather than its absence from the file is what catches a
    // catch-block that fires on a healthy boot.
    assert.match(tag(dom, 'bootError'), /\bhidden\b/, 'a healthy boot must not show the banner');

    // The frame loop is running: app.js writes fps/seq/byte-count into #frameOut,
    // and virtual time advanced it, so the module body executed end to end.
    assert.match(inner(dom, 'frameOut'), /\d+\.\d+ fps · seq \d+ · 1203 B\/frame/);

    // The layout dropdown is filled by app.js from core/layout.js variants, so a
    // populated one is proof the module body ran to its end.
    assert.match(inner(dom, 'wallLayout'), /matches the sender \(no wiring mistake\)/);
  } finally {
    await serve.stop();
  }
});

test('content.html served boots its module: demo running, channel live', async (t) => {
  const port = await freePort();
  const serve = await startServe(port);
  try {
    const dom = dumpDom(`${serve.base}/content.html?wall=1`, 4000);
    if (dom === null) {
      t.skip('no Chrome/Chromium/Edge on this machine');
      return;
    }
    // The module body ran to its end: the demo started and the status line
    // says so. A page whose imports failed (file://, a 404 in core/) leaves
    // the status at its markup value, which is exactly the silent failure
    // this test exists to catch - the content page is the far end of the
    // content protocol, and a dead listener there is invisible from the app.
    assert.match(inner(dom, 'status'), /demo/, 'content module must run and mark its status');
  } finally {
    await serve.stop();
  }
});

/**
 * The gallery, from the console.
 *
 * The app page is the console a person actually has open at the wall, so the
 * cadence has to be here and not only on the control page. Two properties are
 * worth a browser: the selects are built from the lists the protocol gate
 * validates (a console that offers a name the wall refuses is a 400 with no
 * explanation), and the fields MIRROR the server - a console opened at the wall
 * shows the cadence somebody else set, because the wall's state is the truth.
 */
test('the console carries the gallery cadence, and mirrors the server that set it', async (t) => {
  const chrome = findChrome();
  if (chrome === null) { t.skip('no browser on this machine'); return; }

  const dir = mkdtempSync(join(tmpdir(), 'omp-console-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'd.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-console-profile-'));
  let proc = null;

  try {
    const hex = pixelsToHex(emptyPixels());
    for (const name of ['red', 'blue']) {
      const r = await fetch(`${serve.base}/drawings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, pixels: hex }),
      });
      assert.ok(r.ok);
    }

    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/index.html`);

    // The app's own field, not the markup: the module body has to have run for
    // the selects to have any options at all.
    await waitFor(async () => cdp.eval(tab, `(() =>
      document.querySelectorAll('#galGapAnim option').length > 1 ? 'ready' : null
    )()`).catch(() => null), 15_000);

    // The lists are the protocol's lists, in the browser that renders them.
    const gapNames = JSON.parse(await cdp.eval(tab, `JSON.stringify([...document.querySelectorAll('#galGapAnim option')].map((o) => o.value))`));
    const transNames = JSON.parse(await cdp.eval(tab, `JSON.stringify([...document.querySelectorAll('#galTrans option')].map((o) => o.value))`));
    assert.deepEqual(gapNames, GAP_ANIM_NAMES, 'the break select is built from the gate list');
    assert.deepEqual(transNames, TRANSITION_NAMES, 'and so is the transition select');

    // Drive it the way a person does.
    await cdp.eval(tab, `(() => {
      document.getElementById('galInterval').value = '4';
      document.getElementById('galGap').value = '2';
      document.getElementById('galGapAnim').value = 'bars';
      document.getElementById('galTrans').value = 'wipe';
      document.getElementById('galTransSec').value = '2';
      document.getElementById('galStart').click();
      return 'sent';
    })()`);

    await waitFor(async () => {
      const j = await (await fetch(`${serve.base}/content`)).json();
      const s = j.state;
      return s.kind === 'gallery' && s.interval === 4 && s.gap === 2 && s.gapAnim === 'bars'
        && s.transition === 'wipe' && s.transitionSec === 2 ? 'sent' : null;
    }, 10_000);

    // A SECOND console: the mirror. It never touched a control, and it must
    // show the cadence the first one set, because the wall's state is the
    // truth and the panel is a readout of it.
    const tab2 = await cdp.openTab(`${serve.base}/index.html`);
    const mirrored = await waitForValue(async () => cdp.eval(tab2, `(() => {
      const ok = document.getElementById('galInterval').value === '4'
        && document.getElementById('galGap').value === '2'
        && document.getElementById('galGapAnim').value === 'bars'
        && document.getElementById('galTrans').value === 'wipe'
        && document.getElementById('galTransSec').value === '2'
        && document.getElementById('galStart').classList.contains('on');
      return ok ? 'mirrored' : null;
    })()`).catch(() => null), 15_000);
    assert.equal(mirrored, 'mirrored', 'a console opened at the wall must show the cadence the wall is running');

    // The count is the gallery's own number, and it arrives with the list.
    const counted = await waitForValue(async () => {
      const t2 = await cdp.eval(tab2, 'document.getElementById(\"galCount\").textContent').catch(() => '');
      return /2 drawings/.test(t2) ? t2 : null;
    }, 10_000);
    assert.match(counted, /2 drawings/);

    // The relay line: the console is at a party, and the owner's one question
    // is "are the phones getting through?". This wall was started with no
    // --relay, so the honest answer is a sentence, not a spinner.
    const relayLine = await waitForValue(async () => {
      const t = await cdp.eval(tab2, 'document.getElementById("relayOut").textContent').catch(() => '');
      return /relay:/.test(t) ? t : null;
    }, 10_000);
    assert.match(relayLine, /relay: off/, 'the console says what the wall is doing about the public relay');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    dropProfile(profile);
  }
});

test('the watchdogs record a frozen tab and NEVER reload it', async (t) => {
  const chrome = findChrome();
  if (chrome === null) { t.skip('no browser on this machine'); return; }

  const dir = mkdtempSync(join(tmpdir(), 'omp-watchdog-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'd.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-watchdog-profile-'));
  let proc = null;

  try {
    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/index.html`);

    // The heartbeat is real: the frame clock stamps it, so a running page
    // has a fresh one.
    await waitFor(async () => cdp.eval(tab, `(() =>
      Number(localStorage.getItem('wall-heartbeat')) > 0 ? 'beating' : null
    )()`).catch(() => null), 15_000);

    // A page-level sentinel: a RELOAD would wipe it. The old watchdog reloaded
    // on wake, and that was the bug this pins shut — Web Serial needs a user
    // gesture, so a reloaded console cannot re-open COM8: the cure was a dark
    // wall. The watchdog now records, and does not touch navigation.
    await cdp.eval(tab, `(() => {
      window.__probe = 'alive';
      localStorage.setItem('wall-heartbeat', String(Date.now() - 60_000));
      document.dispatchEvent(new Event('visibilitychange'));
      return 'fired';
    })()`);

    // The event is recorded...
    const recorded = await waitFor(async () => cdp.eval(tab, `(() => {
      const e = JSON.parse(localStorage.getItem('wall-events') ?? '[]');
      return e.some((x) => x.kind === 'frozen') ? 'recorded' : null;
    })()`).catch(() => null), 10_000);
    assert.equal(recorded, 'recorded', 'a frozen wake-up is recorded in the incident log');

    // ...and the page is the SAME page: the sentinel survived, so no reload
    // happened, so the serial port (in this fake, the whole page state) lived.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await cdp.eval(tab, 'window.__probe'), 'alive',
      'the watchdog must NOT reload: a reload drops the serial port and darkens the wall');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    dropProfile(profile);
  }
});

test('the grey page: paint stall recorded, canvas revived, page NOT reloaded', async (t) => {
  const chrome = findChrome();
  if (chrome === null) { t.skip('no browser on this machine'); return; }

  const dir = mkdtempSync(join(tmpdir(), 'omp-paint-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'd.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-paint-profile-'));
  let proc = null;

  try {
    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;
    const tab = await cdp.openTab(`${serve.base}/index.html`);

    // The rAF pulse is real: a painting tab stamps its beat.
    await waitFor(async () => cdp.eval(tab, `(() =>
      Number(localStorage.getItem('wall-raf-beat')) > 0 ? 'painting' : null
    )()`).catch(() => null), 15_000);

    // Simulate the grey page: the compositor died (the beat goes stale) while
    // the tab stayed visible. The worker-driven tick is the only thing alive,
    // and that is exactly where paintCheck runs.
    await cdp.eval(tab, `(() => {
      window.__probe = 'alive';
      localStorage.setItem('wall-raf-beat', String(Date.now() - 60_000));
      return 'stalled';
    })()`);

    // The stall is recorded and shown in the readout, on the SAME page.
    const back = await waitFor(async () => cdp.eval(tab, `(() => {
      const e = JSON.parse(localStorage.getItem('wall-events') ?? '[]');
      const fps = (document.getElementById('frameOut')?.textContent ?? '');
      return e.some((x) => x.kind === 'paint-stall') && /WATCH:.*paint stalls/.test(fps)
        ? 'recorded' : null;
    })()`).catch(() => null), 20_000);
    assert.equal(back, 'recorded', 'a visible grey page must record the stall and say so in the readout');

    // The page is the SAME page: no reload, so the serial stream (the wall
    // itself) never blinked. The revive is paint-side only: the canvas
    // backing store is re-allocated, which is the in-page trick Chromium
    // needs to rebuild a dead paint pipeline.
    assert.equal(await cdp.eval(tab, 'window.__probe'), 'alive',
      'the paint cure must NOT reload: the wall streams from the worker and the port');

    // And painting resumed: a living compositor stamps the beat fresh again,
    // so the cure (or the browser's own recovery) restored the frame loop.
    const painting = await waitFor(async () => cdp.eval(tab, `(() =>
      Date.now() - Number(localStorage.getItem('wall-raf-beat') ?? 0) < 5_000 ? 'painting' : null
    )()`).catch(() => null), 15_000);
    assert.equal(painting, 'painting', 'after the revive the compositor is painting again');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    dropProfile(profile);
  }
});

test('a granted serial port reopens at boot: the show joins itself, no click', async (t) => {
  const chrome = findChrome();
  if (chrome === null) { t.skip('no browser on this machine'); return; }

  const dir = mkdtempSync(join(tmpdir(), 'omp-auto-'));
  const serve = await startServe(await freePort(), ['--data', join(dir, 'd.json'), ...noGuards()]);
  const dbgPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'omp-auto-profile-'));
  let proc = null;

  try {
    const browser = await openBrowser(chrome, dbgPort, profile);
    proc = browser.proc;
    const cdp = browser.cdp;

    // The wall device exists as a GRANTED port before the page ever loads:
    // that is Electron's steady state (permission handler grants at install)
    // and the browser's state after one human Connect. The page must open it
    // and stream with zero interaction.
    const fake = `(() => {
      const port = {
        opened: null,
        getInfo: () => ({ path: 'COM9', usbProductName: 'ESP32 UART' }),
        open: async (o) => { port.opened = o; },
        setSignals: async () => {},
        close: async () => {},
        writable: { getWriter: () => ({ write: () => Promise.resolve(), releaseLock: () => {}, close: async () => {} }) },
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      window.__wallPort = port;
      Object.defineProperty(navigator, 'serial', { value: {
        getPorts: async () => [port],
        requestPort: async () => port,
        addEventListener: () => {},
      }, configurable: true });
    })()`;

    const tab = await cdp.openTab('about:blank');
    await cdp.send('Page.enable', {}, tab);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fake }, tab);
    await cdp.send('Page.navigate', { url: `${serve.base}/index.html` }, tab);

    // No clicks, no gestures: the console connects itself and names the port.
    const connected = await waitFor(async () => {
      const t2 = await cdp.eval(tab, 'document.getElementById("sinkOut").textContent').catch(() => '');
      return /reopened the granted port/.test(t2) ? t2 : null;
    }, 15_000);
    assert.match(connected, /COM9/, 'the reopened port is named, the way Connect names it');

    // It really opened the granted device at the wire baud, and the frame
    // line says the serial sink is streaming.
    const proof = await waitFor(async () => cdp.eval(tab, `(() => {
      const opened = window.__wallPort.opened;
      const fps = document.getElementById('frameOut')?.textContent ?? '';
      return opened?.baudRate === 921600 && /sink serial/.test(fps) ? JSON.stringify(opened) : null;
    })()`).catch(() => null), 15_000);
    assert.match(proof, /921600/, 'the granted port opened at the wire baud - the wall streams from the first tick');
  } finally {
    if (proc !== null) proc.kill();
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    dropProfile(profile);
  }
});

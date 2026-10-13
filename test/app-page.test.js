import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

import { freePort, startServe } from './harness.js';

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

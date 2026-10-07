import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  Capture,
  findChrome,
  safeCaptureUrl,
  parseCaptureParams,
} from '../tools/capture.js';

/**
 * tools/capture.js turns a URL into a PNG by driving a local headless Chromium
 * over CDP; tools/serve.js exposes it as GET /capture. Three things are worth
 * pinning here:
 *   1. the URL policy and the numeric clamps — pure functions, always testable,
 *      and the security-relevant part (the endpoint fetches caller-chosen URLs);
 *   2. a real end-to-end capture, the only way to know the CDP sequence actually
 *      produces a page-tall image rather than a viewport-sized one;
 *   3. the HTTP contract the browser app reads: status codes, X-Capture-* headers
 *      and the content hash that tells a new frame from a pixel-identical re-shoot.
 * Anything needing a browser is skipped, never failed, where none is installed.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SERVE_SCRIPT = fileURLToPath(new URL('../tools/serve.js', import.meta.url));


/** Poll a condition until it holds or the deadline passes; returns the final value. */
async function waitFor(predicate, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, stepMs));
  }
}

// -------------------------------------------------------------------------
// URL policy
// -------------------------------------------------------------------------

test('safeCaptureUrl accepts absolute http and https', () => {
  const http = safeCaptureUrl('http://example.com/a?b=1');
  assert.equal(http.protocol, 'http:');
  assert.equal(http.hostname, 'example.com');

  const https = safeCaptureUrl('  https://example.com/index.html  ');
  assert.equal(https.protocol, 'https:');
  assert.equal(https.pathname, '/index.html');
});

test('safeCaptureUrl refuses every scheme that could read the local machine', () => {
  const refused = [
    'file:///C:/Users/someone/Documents/secret.txt',
    'file:///F:/Development/LEDProject/package.json',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(document.cookie)',
    'blob:http://127.0.0.1:8080/0b8a-1',
    'about:blank',
    'view-source:https://example.com/',
    'ws://127.0.0.1:8080/',
  ];
  for (const raw of refused) {
    assert.throws(() => safeCaptureUrl(raw), RangeError, `should refuse ${raw}`);
  }
});

test('safeCaptureUrl refuses relative, empty and unparseable input', () => {
  for (const raw of ['', '   ', 'example.com/', '/capture?url=x', '..\\..\\windows', 'http://', 'not a url at all']) {
    assert.throws(() => safeCaptureUrl(raw), RangeError, `should refuse ${JSON.stringify(raw)}`);
  }

  // These messages reach a developer console through the browser app, so they
  // have to name the reason rather than say "invalid".
  assert.throws(() => safeCaptureUrl('file:///C:/x'), /refused protocol file:/);
  assert.throws(() => safeCaptureUrl(''), /url is required/);
});

// -------------------------------------------------------------------------
// Query parsing: defaults and clamps
// -------------------------------------------------------------------------

test('parseCaptureParams applies the documented defaults', () => {
  const params = parseCaptureParams(new URLSearchParams({ url: 'https://example.com/' }));
  assert.equal(params.url, 'https://example.com/');
  assert.equal(params.width, 1280);
  assert.equal(params.height, 800);
  assert.equal(params.dsf, 1);
  assert.equal(params.waitMs, 500);
  assert.equal(params.reload, false);
});

test('parseCaptureParams clamps out-of-range dimensions instead of rejecting them', () => {
  const high = parseCaptureParams(new URLSearchParams({
    url: 'https://example.com/',
    w: '99999',
    h: '1',
    dsf: '99',
    wait: '999999',
    reload: '1',
  }));
  assert.equal(high.width, 2400);
  assert.equal(high.height, 64);
  assert.equal(high.dsf, 4);
  assert.equal(high.waitMs, 5000);
  assert.equal(high.reload, true);

  const low = parseCaptureParams(new URLSearchParams({ url: 'https://example.com/', w: '0', h: '10', dsf: '0' }));
  assert.equal(low.width, 64);
  assert.equal(low.height, 64);
  assert.equal(low.dsf, 1);
});

test('parseCaptureParams keeps in-range values and accepts reload spellings', () => {
  const params = parseCaptureParams(new URLSearchParams({ url: 'https://example.com/', w: '800', h: '600', dsf: '2', wait: '0' }));
  assert.equal(params.width, 800);
  assert.equal(params.height, 600);
  assert.equal(params.dsf, 2);
  assert.equal(params.waitMs, 0);

  for (const value of ['1', 'true', 'TRUE', 'yes']) {
    assert.equal(parseCaptureParams(new URLSearchParams({ url: 'https://example.com/', reload: value })).reload, true);
  }
  for (const value of ['', '0', 'no', 'maybe']) {
    assert.equal(parseCaptureParams(new URLSearchParams({ url: 'https://example.com/', reload: value })).reload, false);
  }
});

test('parseCaptureParams rejects a missing url and a non-numeric dimension', () => {
  assert.throws(() => parseCaptureParams(new URLSearchParams({ w: '800' })), RangeError);
  assert.throws(() => parseCaptureParams(new URLSearchParams({ url: 'file:///C:/x' })), RangeError);
  assert.throws(() => parseCaptureParams(new URLSearchParams({ url: 'https://example.com/', w: 'big' })), /w must be a number/);
});

test('findChrome returns an existing path or null', () => {
  const found = findChrome();
  if (found !== null) assert.ok(found.length > 0);
});

// -------------------------------------------------------------------------
// End-to-end capture against a real Chromium
// -------------------------------------------------------------------------

/**
 * A page comfortably taller than any requested viewport: 30 bands of 100 CSS px
 * plus a heading and a self-updating clock. The clock is the point — it proves a
 * reused tab re-renders (a LIVE feed) instead of replaying one cached image.
 */
const BANDS = 30;
const TALL_CSS = BANDS * 100;

const page = ({ bands = BANDS, live = true, label = 'Tall capture page' }) => `<!doctype html>
<meta charset=utf-8>
<title>${label}</title>
<style>
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
  .band { box-sizing: border-box; height: 100px; padding: 8px 14px; border-bottom: 1px solid #bbb; }
  .band:nth-child(odd) { background: #eef3ff; }
</style>
<h1 style="padding:14px">${label}</h1>
<div id="clock">0</div>
${Array.from({ length: bands }, (_, i) => `<div class="band">Band ${i + 1} — ${'the quick brown fox jumps over the lazy dog '.repeat(4)}</div>`).join('')}
${live ? `<script>
  let n = 0;
  setInterval(() => { n += 1; document.getElementById('clock').textContent = 'tick ' + n; }, 100);
</script>` : ''}
`;

/**
 * Loopback page server. `/` is animated, `/static` is frozen and varies only by
 * its `v` query parameter — that is what makes "same page twice" and "different
 * page" comparable byte for byte.
 */
async function startPageServer() {
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const html = path === '/static'
      ? page({ live: false, label: `Static page v${query.get('v') ?? '1'}` })
      : page({ bands: Number(query.get('bands') ?? BANDS) });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url: `${base}/`,
    pageUrl: (v) => `${base}/static?v=${v}`,
    tallUrl: (bands) => `${base}/?bands=${bands}`,
  };
}

const pngSize = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

test('a real Chromium captures a tall page top-to-bottom', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const pages = await startPageServer();
  const capture = new Capture({ idleMs: 5000 });
  try {
    const first = await capture.shot({ url: pages.url, width: 900, height: 600, waitMs: 300 });

    assert.deepEqual(first.png.subarray(0, 8), PNG_SIGNATURE, 'the capture must be a PNG');
    assert.ok(first.png.length > 1000, 'a 900x3000 page is not a few hundred bytes');

    // IHDR must agree with what the API reports, or the wall scales the wrong geometry.
    const dims = pngSize(first.png);
    assert.equal(dims.w, first.width);
    assert.equal(dims.h, first.height);

    // The whole page was rendered, not just the 600 CSS px the caller asked for.
    assert.ok(first.scrollHeight >= TALL_CSS, `scrollHeight ${first.scrollHeight} should cover ${TALL_CSS}px`);
    assert.equal(first.cssWidth, 900);
    assert.ok(first.cssHeight >= TALL_CSS, `cssHeight ${first.cssHeight} should cover ${TALL_CSS}px`);
    assert.equal(first.height, first.cssHeight, 'dsf 1: device px == CSS px');
    assert.ok(first.height > 600, 'the shot is taller than the requested viewport');
    assert.equal(first.url, pages.url);

    // Give the page's own timer time to move so the comparison below cannot be
    // a coin flip on two shots landing inside the same 100 ms tick.
    await new Promise((done) => setTimeout(done, 300));

    // Reuse: the second shot skips launch and navigation, so it is markedly faster.
    const second = await capture.shot({ url: pages.url, width: 900, height: 600, waitMs: 0 });
    assert.ok(second.ms < first.ms, `reused tab ${second.ms}ms should beat cold ${first.ms}ms`);
    assert.equal(second.height, first.height);

    // A reused tab re-renders: the page changed pixels between the two shots.
    assert.notDeepEqual(second.png, first.png, 'a live feed must re-render, not replay a cached image');

    // reload: true pays for the navigation again.
    const reloaded = await capture.shot({ url: pages.url, width: 900, height: 600, waitMs: 0, reload: true });
    assert.equal(reloaded.height, first.height);

    // Device scale factor multiplies device pixels without changing CSS layout.
    const zoomed = await capture.shot({ url: pages.url, width: 400, height: 600, dsf: 2, waitMs: 0 });
    assert.equal(zoomed.width, 800);
    assert.equal(zoomed.cssWidth, 400);
    // A refused upstream is a plain Error (user-presentable), not a RangeError
    // and not a raw CDP socket error.
    await assert.rejects(
      () => capture.shot({ url: 'http://127.0.0.1:1/', width: 320, height: 240 }),
      (err) => err instanceof Error && !(err instanceof RangeError) && err.message.startsWith('capture:'),
    );

    // The next shot of a good URL still works on the same Capture instance.
    const shot = await capture.shot({ url: pages.url, width: 320, height: 240, waitMs: 0 });
    assert.equal(shot.width, 320);
    assert.ok(shot.height >= TALL_CSS);
  } finally {
    await capture.close();
    pages.server.close();
  }
});

test('a browser that dies underneath the service is relaunched by the next shot', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const pages = await startPageServer();
  const capture = new Capture({ idleMs: 0 });
  try {
    const before = await capture.shot({ url: pages.url, width: 320, height: 240, waitMs: 0 });
    assert.ok(before.width === 320 && capture.pid !== null);

    // Simulate a crash: kill the browser tree from outside. The service must
    // notice (socket close / process exit) rather than wait forever on it.
    const pid = capture.pid;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }

    const after = await capture.shot({ url: pages.url, width: 320, height: 240, waitMs: 0 });
    assert.notEqual(capture.pid, pid, 'the relaunched browser is a new process');
    assert.equal(after.width, 320);
    assert.ok(after.height >= TALL_CSS, 'the page is re-navigated and re-captured from scratch');
  } finally {
    await capture.close();
    pages.server.close();
  }
});

test('close() is idempotent and a closed Capture refuses further shots', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const pages = await startPageServer();
  const capture = new Capture({ idleMs: 0 });
  try {
    const shot = await capture.shot({ url: pages.url, width: 320, height: 240, waitMs: 0 });
    assert.equal(shot.width, 320);
    assert.notEqual(capture.pid, null, 'a live browser has a pid');

    await capture.close();
    await capture.close(); // idempotent
    assert.equal(capture.pid, null, 'close releases the browser');

    // Reusing a closed instance must be a clear error, not a hang or a silent
    // relaunch: the app holds one Capture for its whole life.
    await assert.rejects(
      () => capture.shot({ url: pages.url, width: 320, height: 240 }),
      /has been closed/,
    );
  } finally {
    await capture.close();
    pages.server.close();
  }
});

test('a failed capture rejects with a plain Error and does not poison the service', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const pages = await startPageServer();
  const capture = new Capture({ navTimeoutMs: 4000, idleMs: 5000 });
  try {
    // Port 1 on loopback: connects and is refused immediately.
    await assert.rejects(
      () => capture.shot({ url: 'http://127.0.0.1:1/', width: 320, height: 240 }),
      (err) => err instanceof Error && !(err instanceof RangeError) && err.message.startsWith('capture:'),
    );

    // One refused URL must not tear down the browser: every other URL on this
    // Capture is captured with it, and a wall with one dead feed would pay a
    // Chromium relaunch per frame. What must die is the tab, not the browser.
    assert.notEqual(capture.pid, null, 'the shared browser survives one refused URL');

    // The dead tab must be reset, not left half-navigated: the same URL asked
    // for again has to fail fast again rather than hang on a dead session.
    await assert.rejects(
      () => capture.shot({ url: 'http://127.0.0.1:1/', width: 320, height: 240, waitMs: 0 }),
      (err) => err instanceof Error && !(err instanceof RangeError) && err.message.startsWith('capture:'),
      'a dead host must reject again, not hang',
    );

    // The next shot of a good URL still works on the same Capture instance.
    const shot = await capture.shot({ url: pages.url, width: 320, height: 240, waitMs: 0 });
    assert.equal(shot.width, 320);
    assert.ok(shot.height >= TALL_CSS);
  } finally {
    await capture.close();
    pages.server.close();
  }
});

test('a tab left dead by a failed shot is released, not held forever', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const capture = new Capture({ navTimeoutMs: 4000, idleMs: 500 });
  try {
    // The only URL this Capture ever shoots is a dead one. Its tab is left
    // sitting on an error page, and nobody is going to ask for it again.
    await assert.rejects(
      () => capture.shot({ url: 'http://127.0.0.1:1/', width: 320, height: 240, waitMs: 0 }),
      (err) => err.message.startsWith('capture:'),
    );
    assert.notEqual(capture.pid, null, 'the browser is alive immediately after the failure');

    // A failed shot must arm the same idle clock a successful one does, or a
    // wall with one dead feed keeps a Chromium and its renderer for good.
    const released = await waitFor(() => capture.pid === null, 15_000);
    assert.ok(released, 'the dead tab was closed and the browser went with it');
    assert.equal(capture.tabCount, 0, 'no tab record is left holding the URL');
  } finally {
    await capture.close();
  }
});

// -------------------------------------------------------------------------
// GET /capture — the HTTP contract the browser app reads
// -------------------------------------------------------------------------

/** Ask the OS for a port, release it, and hope nothing steals it before serve.js binds. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = netServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * Boot tools/serve.js as a real child process on an ephemeral port.
 *
 * Killing it is platform-specific and matters: on Windows a plain child.kill()
 * terminates only the Node process, so the Chromium it launched would survive as
 * an orphan. taskkill /T takes the whole tree. On POSIX, SIGTERM reaches the
 * handler that already closes the Capture.
 */
async function startServe(port) {
  const child = spawn(process.execPath, [SERVE_SCRIPT, '--port', String(port)], {
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

const captureQuery = (params) => new URLSearchParams(params).toString();

test('GET /capture answers bad parameters with 400 JSON and never throws', async () => {
  const port = await freePort();
  const serve = await startServe(port);
  try {
    const cases = [
      { label: 'missing url', query: captureQuery({ w: '800' }) },
      { label: 'local file', query: captureQuery({ url: 'file:///C:/Windows/win.ini' }) },
      { label: 'data url', query: captureQuery({ url: 'data:text/html,hi' }) },
      { label: 'non-numeric width', query: captureQuery({ url: 'https://example.com/', w: 'wide' }) },
    ];
    for (const { label, query } of cases) {
      const res = await fetch(`${serve.base}/capture?${query}`);
      assert.equal(res.status, 400, label);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', label);
      const body = await res.json();
      assert.equal(typeof body.error, 'string', label);
      assert.ok(body.error.length > 0, label);
    }

    // A capture failure upstream is a 502 with a message, not a stack or a hang.
    const dead = await fetch(`${serve.base}/capture?${captureQuery({ url: 'http://127.0.0.1:1/' })}`);
    assert.equal(dead.status, 502);
    assert.equal(dead.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.ok((await dead.json()).error.startsWith('capture:'));

    // Static serving is untouched: an unknown path is still a plain 404.
    const missing = await fetch(`${serve.base}/definitely-not-a-file.html`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') ?? '', /^text\/plain/);
  } finally {
    await serve.stop();
  }
});

test('GET /capture serves a PNG with X-Capture-* headers and a content hash that tracks the pixels', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  const port = await freePort();
  const pages = await startPageServer();
  const serve = await startServe(port);
  try {
    const query = captureQuery({ url: pages.pageUrl(1), w: '500', h: '400', wait: '0' });

    const first = await fetch(`${serve.base}/capture?${query}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const png = Buffer.from(await first.arrayBuffer());
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);

    const width = Number(first.headers.get('x-capture-width'));
    const height = Number(first.headers.get('x-capture-height'));
    const cssWidth = Number(first.headers.get('x-capture-css-width'));
    const cssHeight = Number(first.headers.get('x-capture-css-height'));
    const scrollHeight = Number(first.headers.get('x-capture-scroll-height'));
    const ms = Number(first.headers.get('x-capture-ms'));
    const hash = first.headers.get('x-capture-hash');

    assert.ok(Number.isInteger(width) && Number.isInteger(height), 'device dimensions must be reported');
    assert.deepEqual(pngSize(png), { w: width, h: height }, 'IHDR must match the reported dimensions');
    assert.equal(cssWidth, 500);
    assert.ok(cssHeight >= TALL_CSS, `the whole page should be rendered, got ${cssHeight}`);
    assert.ok(scrollHeight >= TALL_CSS, `the real page height should be reported, got ${scrollHeight}`);
    assert.ok(ms >= 0);
    assert.equal(Number(first.headers.get('content-length')), png.length);

    // The hash is what lets the browser app skip decoding a frame it already has.
    assert.match(hash ?? '', /^[0-9a-f]{16}$/, 'X-Capture-Hash must be present and hex');

    // Same page, same pixels -> same hash, even though the tab re-rendered.
    const again = await fetch(`${serve.base}/capture?${query}`);
    const againPng = Buffer.from(await again.arrayBuffer());
    assert.equal(again.headers.get('x-capture-hash'), hash, 'a pixel-identical re-shoot must hash the same');
    assert.deepEqual(againPng, png);

    // Different content -> different hash.
    const other = await fetch(`${serve.base}/capture?${captureQuery({ url: pages.pageUrl(2), w: '500', h: '400', wait: '0' })}`);
    assert.equal(other.status, 200);
    assert.notEqual(other.headers.get('x-capture-hash'), hash, 'changed page content must change the hash');

    // Clamping is visible in the headers rather than rejected: w clamps to 2400,
    // dsf to 4, and h=1 is raised to the page's real height because the viewport
    // grows to cover the whole page (maxCssHeight 4096 is only the ceiling).
    const clamped = await fetch(`${serve.base}/capture?${captureQuery({ url: pages.pageUrl(1), w: '99999', h: '1', dsf: '9' })}`);
    assert.equal(clamped.status, 200);
    const clampCssWidth = Number(clamped.headers.get('x-capture-css-width'));
    const clampCssHeight = Number(clamped.headers.get('x-capture-css-height'));
    const clampScroll = Number(clamped.headers.get('x-capture-scroll-height'));
    assert.equal(clampCssWidth, 2400);
    assert.ok(clampCssHeight >= TALL_CSS && clampCssHeight <= 4096, `viewport should cover the page, got ${clampCssHeight}`);
    assert.equal(clampCssHeight, clampScroll, 'the viewport was grown to the whole page');
    assert.equal(Number(clamped.headers.get('x-capture-width')), 2400 * 4, 'dsf clamps to 4');
    assert.equal(Number(clamped.headers.get('x-capture-height')), clampCssHeight * 4);
  } finally {
    pages.server.close();
    await serve.stop();
  }
});

test('a viewport-dependent page: the PNG always matches the geometry reported for it', async (t) => {
  if (findChrome() === null) {
    t.skip('no Chrome/Chromium/Edge on this machine');
    return;
  }

  // A page whose height depends on the viewport it is rendered in: 1000 CSS px
  // plus half a viewport. Growing the viewport to fit the page grows the page,
  // so scrollHeight chases the viewport instead of settling on it. This is the
  // case the convergence loop exists for, and the case where it is easiest to
  // report a height that was never actually applied.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html>
<meta charset=utf-8>
<title>Viewport dependent page</title>
<style>
  body { margin: 0; }
  #grow { height: calc(1000px + 50vh); background: #2266cc; }
</style>
<div id="grow"></div>
`);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const capture = new Capture({ idleMs: 5000 });
  try {
    const shot = await capture.shot({ url, width: 700, height: 600, waitMs: 0 });
    const dims = pngSize(shot.png);

    assert.equal(dims.h, shot.height, 'IHDR must agree with the reported height');
    // The invariant the wall depends on: the PNG IS the viewport we asked the
    // browser to render, so scaling it to the panel cannot crop or stretch it.
    assert.equal(
      shot.height,
      shot.cssHeight,
      `dsf 1: PNG ${shot.height}px must equal the applied viewport ${shot.cssHeight}px`,
    );
    assert.ok(shot.cssHeight >= 600, `the viewport must at least cover the request, got ${shot.cssHeight}`);
    assert.ok(
      shot.scrollHeight >= shot.cssHeight,
      `the page is ${shot.scrollHeight}px tall; the viewport cannot be taller than the page`,
    );

    // The chase is bounded and converging, not runaway. This page's height is
    // 1000 + half the viewport, so viewport and page chase a fixed point at
    // 2000 px: each shot lands closer than the last, and maxCssHeight is the
    // ceiling that stops the loop from spending every frame on a page that
    // would otherwise grow forever.
    const second = await capture.shot({ url, width: 700, height: 600, waitMs: 0 });
    const third = await capture.shot({ url, width: 700, height: 600, waitMs: 0 });
    for (const shot of [second, third]) {
      assert.equal(
        pngSize(shot.png).h,
        shot.cssHeight,
        `every shot's PNG must be the viewport it reports, got ${pngSize(shot.png).h} vs ${shot.cssHeight}`,
      );
      assert.ok(
        shot.scrollHeight >= shot.cssHeight,
        `viewport ${shot.cssHeight} must not exceed the page's ${shot.scrollHeight}`,
      );
    }

    const firstStep = second.cssHeight - shot.cssHeight;
    const secondStep = third.cssHeight - second.cssHeight;
    assert.ok(firstStep > 0, `the viewport should grow toward the page, ${shot.cssHeight} -> ${second.cssHeight}`);
    assert.ok(
      secondStep < firstStep,
      `steps must shrink as the chase converges: ${firstStep}px then ${secondStep}px`,
    );
    assert.ok(third.cssHeight <= 4096, `the chase must stay under maxCssHeight, got ${third.cssHeight}`);
  } finally {
    server.close();
    await capture.close();
  }
});

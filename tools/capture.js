// Live webpage capture: raster a real web page to a PNG using a local headless
// Chromium driven over the Chrome DevTools Protocol, with zero npm dependencies
// (node:child_process, node:net, node:fs, node:os, node:path, global fetch,
// global WebSocket).
//
// Why a browser at all: the LED wall shows whatever the browser app is showing,
// and the only thing that can faithfully raster an arbitrary page — CSS, fonts,
// images, canvas, animations — is a real browser engine. CDP is a plain JSON
// protocol over a WebSocket, so Node's built-in WebSocket is enough; no puppeteer.
//
// Usage: import { Capture, findChrome, safeCaptureUrl, parseCaptureParams } from './capture.js'

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Viewport defaults for a shot that does not ask for anything specific. */
const DEFAULTS = {
  width: 1280,
  height: 800,
  dsf: 1,
  waitMs: 500,
  maxCssHeight: 4096,
  navTimeoutMs: 15000,
  idleMs: 60000,
};

// Hard bounds shared by Capture.shot() and the /capture route. A request must
// not be able to ask for a 40000px viewport (Chromium would allocate hundreds of
// megabytes and die) or a 1px one (useless), so out-of-range numbers are clamped
// into this window instead of being forwarded to the browser.
const BOUNDS = {
  width: [64, 2400],
  height: [64, 2400],
  dsf: [1, 4],
  waitMs: [0, 5000],
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value))));

const isConnectionLoss = (err) =>
  err instanceof Error &&
  /connection (?:is )?closed|browser exited|could not reach the browser|could not open the DevTools WebSocket|timed out connecting to the browser|capture session was closed/.test(
    err.message,
  );

/**
 * Locate a browser we are allowed to drive headlessly.
 *
 * Order is deliberate: an explicit LED_CHROME always wins (CI boxes, portable
 * builds, Brave, canary), then the newest Playwright-managed Chromium (newest
 * build number first, because those directories accumulate), then the normal
 * system installs. Pure fs checks — no shell, no `where`, no PATH scanning — so
 * behaviour is identical whatever the calling shell is.
 */
export function findChrome() {
  const override = process.env.LED_CHROME;
  if (override && existsSync(override)) return resolve(override);

  // Where Playwright puts its downloads on Windows and on Unix-ish systems.
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const roots = [join(localAppData, 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')];

  // Relative path of the executable inside a chromium-<build> directory.
  const layout =
    process.platform === 'win32'
      ? ['chrome-win64', 'chrome.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
        : ['chrome-linux64', 'chrome'];

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // no Playwright cache here
    }
    const builds = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      .map((entry) => entry.name)
      // chromium-1243 is newer than chromium-1228; non-numeric names sort last.
      .sort((a, b) => {
        const na = Number(/^chromium-(\d+)$/.exec(a)?.[1] ?? -1);
        const nb = Number(/^chromium-(\d+)$/.exec(b)?.[1] ?? -1);
        return nb !== na ? nb - na : b.localeCompare(a);
      });
    for (const name of builds) {
      const candidate = join(root, name, ...layout);
      if (existsSync(candidate)) return candidate;
    }
  }

  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Validate a capture target.
 *
 * This endpoint is a browser-driven fetcher that runs on a loopback server, so
 * it is the one place in the project where a URL string becomes a real fetch of
 * attacker-chosen text. `file:///C:/Users/...`, `data:`, `javascript:` and
 * `blob:` would let a <img src="/capture?url=..."> read the local disk or run
 * script in a page's origin through the browser. Only absolute http(s) passes.
 */
export function safeCaptureUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RangeError('capture: url is required (absolute http(s) URL)');
  }
  const text = raw.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError(`capture: not an absolute URL: ${JSON.stringify(text.slice(0, 120))}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RangeError(`capture: refused protocol ${url.protocol} (only http: and https:)`);
  }
  if (!url.hostname) {
    throw new RangeError(`capture: no host in ${JSON.stringify(text.slice(0, 120))}`);
  }
  return url;
}

/**
 * Turn a /capture query string into shot arguments: validate the URL, clamp the
 * numbers, default whatever is absent. Kept here (rather than inline in the
 * route) so the policy is testable without a browser.
 */
export function parseCaptureParams(params) {
  const number = (name, key, [min, max]) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return DEFAULTS[name];
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new RangeError(`capture: ${key} must be a number, got ${JSON.stringify(raw.slice(0, 40))}`);
    }
    return clampInt(value, min, max);
  };

  return {
    url: safeCaptureUrl(params.get('url') ?? '').toString(),
    width: number('width', 'w', BOUNDS.width),
    height: number('height', 'h', BOUNDS.height),
    dsf: number('dsf', 'dsf', BOUNDS.dsf),
    waitMs: number('waitMs', 'wait', BOUNDS.waitMs),
    reload: ['1', 'true', 'yes'].includes((params.get('reload') ?? '').toLowerCase()),
  };
}

/** Read the real pixel size out of a PNG's IHDR so reported dims match the bytes. */
function pngDims(png) {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('capture: the browser did not return a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Ask the OS for a port nobody is using, so we never clash with a 9222 debugger. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * A lazily launched headless Chromium with one live tab per URL.
 *
 * Tab reuse is what makes the feed LIVE: the first shot of a URL navigates, every
 * later shot only screenshots the same tab, so CSS animations, clocks, video
 * frames and polling updates keep rendering and the wall keeps up with the page
 * without paying a navigation (and a full re-fetch of every asset) per frame.
 * `reload: true` is the escape hatch when the page itself must be re-fetched.
 */
export class Capture {
  #width;
  #height;
  #dsf;
  #waitMs;
  #maxCssHeight;
  #navTimeoutMs;
  #idleMs;

  #proc = null; // spawned browser
  #profileDir = null;
  #ws = null; // browser-level CDP socket
  #launching = null; // in-flight launch, so concurrent shots share one browser
  #nextId = 0;
  #pending = new Map(); // request id -> { resolve, reject, timer, method }
  #waiters = new Map(); // `${sessionId}\0${event}` -> [waiter]
  #tabs = new Map(); // absolute URL -> tab record
  #closed = false;

  constructor(opts = {}) {
    const num = (name, fallback) => (Number.isFinite(opts[name]) ? opts[name] : fallback);
    this.#width = clampInt(num('width', DEFAULTS.width), ...BOUNDS.width);
    this.#height = clampInt(num('height', DEFAULTS.height), ...BOUNDS.height);
    this.#dsf = clampInt(num('dsf', DEFAULTS.dsf), ...BOUNDS.dsf);
    this.#waitMs = clampInt(num('waitMs', DEFAULTS.waitMs), ...BOUNDS.waitMs);
    this.#maxCssHeight = Math.max(64, Math.round(num('maxCssHeight', DEFAULTS.maxCssHeight)));
    this.#navTimeoutMs = Math.max(1000, Math.round(num('navTimeoutMs', DEFAULTS.navTimeoutMs)));
    // idleMs <= 0 disables idle tab closing (the browser then lives until close()).
    this.#idleMs = Math.round(num('idleMs', DEFAULTS.idleMs));
  }

  /**
   * Capture one page.
   *
   * @param {{url: string, width?: number, height?: number, dsf?: number, waitMs?: number, reload?: boolean}} request
   * @returns {Promise<{png: Buffer, width: number, height: number, cssWidth: number, cssHeight: number, scrollHeight: number, ms: number, url: string}>}
   *   `width`/`height` are the PNG's device pixels; `cssWidth`/`cssHeight` are the
   *   CSS viewport the browser actually rendered; `scrollHeight` is the whole page
   *   in CSS px, so a caller can tell that the page is taller than what was taken.
   */
  async shot(request = {}) {
    if (this.#closed) throw new Error('capture: this Capture has been closed');

    const target = safeCaptureUrl(request.url);
    const params = {
      url: target.toString(),
      width: clampInt(request.width ?? this.#width, ...BOUNDS.width),
      height: clampInt(request.height ?? this.#height, ...BOUNDS.height),
      dsf: clampInt(request.dsf ?? this.#dsf, ...BOUNDS.dsf),
      waitMs: clampInt(request.waitMs ?? this.#waitMs, ...BOUNDS.waitMs),
      reload: Boolean(request.reload),
    };

    let tab = this.#tabs.get(params.url);
    if (!tab) {
      tab = {
        url: params.url,
        targetId: null,
        sessionId: null,
        navigated: false,
        applied: null,
        // Shots on one tab are chained, never interleaved: two CDP call sequences
        // on the same session would fight over the viewport override and the
        // screenshot region.
        chain: Promise.resolve(),
        timer: null,
      };
      this.#tabs.set(params.url, tab);
    }

    const run = tab.chain.then(
      () => this.#capture(tab, params),
      // A failed shot must not poison the chain: the next request still runs,
      // on a rebuilt tab if the failure killed this one.
      () => this.#capture(tab, params),
    );
    tab.chain = run.then(
      () => {},
      () => {
        // A failed shot leaves a live tab sitting on an error page, and nothing
        // will shoot it again unless the caller asks. Put it on the same idle
        // clock as an unwanted tab, otherwise one broken URL holds a browser —
        // and a full renderer — for the life of the service.
        if (!this.#closed) this.#armIdle(tab);
      },
    );
    return run;
  }

  /** PID of the live browser, or null when nothing is running. Diagnostics/tests. */
  get pid() {
    return this.#proc?.pid ?? null;
  }

  /** How many URLs currently have a live tab. */
  get tabCount() {
    return this.#tabs.size;
  }

  /** Kill the browser and close the socket. Idempotent; safe to call twice. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const tab of this.#tabs.values()) clearTimeout(tab.timer);
    this.#tabs.clear();
    await this.#stopBrowser();
  }

  // --------------------------------------------------------------------------
  // One shot
  // --------------------------------------------------------------------------

  /**
   * One shot, with exactly one retry when the browser underneath it vanished.
   *
   * A wall driver asks for frames continuously; a Chromium that crashes must
   * cost it one dropped frame, not a dead service. A page that is simply broken
   * is not retried — that would turn every bad URL into double the work.
   */
  async #capture(tab, params) {
    try {
      return await this.#attempt(tab, params);
    } catch (err) {
      if (this.#closed || !isConnectionLoss(err)) throw err;
      return await this.#attempt(tab, params);
    }
  }

  async #attempt(tab, params) {
    const started = Date.now();
    await this.#ensureBrowser();
    await this.#ensureTab(tab);

    if (params.reload || !tab.navigated) {
      await this.#navigate(tab, params);
      tab.navigated = true;
    }

    // How tall is the page really?
    let measured = await this.#measure(tab);
    let cssHeight = this.#targetHeight(measured.scrollHeight, params.height);

    // A warm tab already at the geometry this shot wants needs no convergence:
    // the loop below exists because RESIZING can reflow a page (100vh blocks,
    // sticky headers, lazy images) and change scrollHeight, and the 120 ms is
    // the settle time for that reflow. When nothing is being resized there is no
    // reflow to wait for, and paying it on every frame of a live feed costs ~40%
    // of the shot. `tab.applied` is exactly the geometry currently in force.
    if (
      tab.applied?.width !== params.width ||
      tab.applied?.dsf !== params.dsf ||
      tab.applied?.height !== cssHeight
    ) {
      // Each pass applies a height and then reads the page back. A page whose
      // height depends on its own viewport (`calc(1000px + 50vh)`) grows every
      // time the viewport grows, so it may never settle and the pass cap is what
      // bounds that chase. `cssHeight` must only ever name a height we have
      // actually applied, because the screenshot is taken at the viewport in
      // force — reporting a height the page asked for but we never set would
      // describe an image we did not take.
      for (let pass = 0; pass < 3; pass++) {
        await this.#applyMetrics(tab, params.width, cssHeight, params.dsf);
        await delay(120);
        measured = await this.#measure(tab);
        const next = this.#targetHeight(measured.scrollHeight, params.height);
        if (next === cssHeight) break;
        cssHeight = next;
      }
      // Converged: the last height we applied is the one the page agrees with.
      // Out of passes: apply the height the page last asked for so the PNG and
      // the geometry reported for it are the same viewport. No-op when the loop
      // converged, so a normal page pays nothing here.
      if (await this.#applyMetrics(tab, params.width, cssHeight, params.dsf)) {
        await delay(120);
        measured = await this.#measure(tab);
      }
    }

    const shot = await this.#send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      tab.sessionId,
      Math.max(10_000, this.#navTimeoutMs),
    );
    if (typeof shot?.data !== 'string') throw new Error('capture: the browser returned no screenshot data');

    const png = Buffer.from(shot.data, 'base64');
    const device = pngDims(png);

    this.#armIdle(tab);
    return {
      png,
      width: device.width,
      height: device.height,
      cssWidth: params.width,
      cssHeight,
      scrollHeight: measured.scrollHeight,
      ms: Date.now() - started,
      url: measured.href || params.url,
    };
  }

  /**
   * The viewport height to render: the whole page, but never less than what the
   * caller asked for and never more than maxCssHeight.
   */
  #targetHeight(scrollHeight, requested) {
    return Math.min(Math.max(scrollHeight || 0, requested), this.#maxCssHeight);
  }

  async #navigate(tab, params) {
    const { sessionId } = tab;
    // Lay the viewport out before the first paint so the page lays out at the
    // width we are going to capture at (reflow-free first load).
    await this.#applyMetrics(tab, params.width, params.height, params.dsf);

    // Registered before Page.navigate is sent: a fast local page can fire its
    // load event before the navigate response is even processed, and a missed
    // event would look exactly like a navigation timeout. Shots on a tab are
    // serialised, so the next load event to arrive after this point belongs to
    // this navigation. (loadEventFired carries no loaderId in current Chrome,
    // so it cannot be matched by id — only by ordering.)
    const loaded = this.#waitFor(
      sessionId,
      'Page.loadEventFired',
      () => true,
      this.#navTimeoutMs,
      `load of ${params.url}`,
    );

    let nav;
    try {
      nav = await this.#send('Page.navigate', { url: params.url }, sessionId, this.#navTimeoutMs);
    } catch (err) {
      loaded.cancel();
      throw err;
    }
    if (nav?.errorText) {
      loaded.cancel();
      throw new Error(`capture: ${params.url} could not be loaded: ${nav.errorText}`);
    }

    try {
      await loaded;
    } catch (err) {
      // A page whose subresource hangs forever never fires load. If the
      // document itself is already complete we can still shoot it; otherwise the
      // tab is half-loaded and the next shot must rebuild it rather than reuse it.
      const ready = await this.#evaluate(tab, 'document.readyState').catch(() => null);
      if (ready !== 'complete') throw err;
    }

    // Let the page's own scripts, fonts and lazy content settle after load.
    if (params.waitMs > 0) await delay(params.waitMs);
  }

  /**
   * Read the page's real height — and park it at the top of the document while
   * we are already in there. A page can be left scrolled by an anchor or by its
   * own script, and the wall always wants the top of the document; doing both in
   * one `Runtime.evaluate` is one CDP round trip instead of two per shot.
   */
  async #measure(tab) {
    const value = await this.#evaluate(
      tab,
      `(() => {
        window.scrollTo(0, 0);
        const de = document.documentElement, body = document.body;
        return {
          scrollHeight: Math.max(de ? de.scrollHeight : 0, body ? body.scrollHeight : 0),
          href: String(location.href),
        };
      })()`,
    );
    if (!value || typeof value.scrollHeight !== 'number') {
      throw new Error('capture: the page did not report a measurable height');
    }
    return value;
  }

  async #evaluate(tab, expression) {
    const res = await this.#send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      tab.sessionId,
      10_000,
    );
    if (res?.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown error';
      throw new Error(`capture: the page rejected the capture script: ${text}`);
    }
    return res?.result?.value;
  }

  /**
   * Set the viewport, unless it is already exactly this.
   *
   * @returns {Promise<boolean>} true if the viewport actually changed, i.e. the
   * page has to reflow and the caller owes it a settle delay before shooting.
   */
  async #applyMetrics(tab, width, height, dsf) {
    if (tab.applied?.width === width && tab.applied?.height === height && tab.applied?.dsf === dsf) {
      return false;
    }
    await this.#send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: dsf, mobile: false },
      tab.sessionId,
      10_000,
    );
    tab.applied = { width, height, dsf };
    return true;
  }

  // --------------------------------------------------------------------------
  // Browser lifecycle
  // --------------------------------------------------------------------------

  /**
   * A browser is reusable only while its process AND its DevTools socket are
   * both alive. They die at different moments — a killed Chromium closes its
   * socket well before its `exit` event lands — so trusting `#proc` alone would
   * hand the next shot a socket that can no longer answer.
   */
  async #ensureBrowser() {
    if (this.#proc && this.#ws && this.#ws.readyState <= 1) return;
    if (this.#launching) return this.#launching; // concurrent first shots share one launch
    if (this.#proc || this.#ws) await this.#stopBrowser(); // reap the half-dead one
    const launching = this.#launch().finally(() => {
      if (this.#launching === launching) this.#launching = null;
    });
    this.#launching = launching;
    return launching;
  }

  async #launch() {
    if (this.#closed) throw new Error('capture: this Capture has been closed');

    const chrome = findChrome();
    if (!chrome) {
      throw new Error('capture: no Chrome/Edge/Chromium found — set LED_CHROME to the browser executable');
    }

    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'led-capture-'));
    this.#profileDir = profile;

    const proc = spawn(
      chrome,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        `--window-size=${this.#width},${Math.min(this.#height, 1200)}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    // Chrome's own complaints are the only useful diagnostics when it refuses to
    // start (sandbox, profile lock, missing DLL) — keep a bounded tail of them.
    let log = '';
    const collect = (chunk) => {
      if (log.length < 4000) log += chunk;
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    proc.once('error', (err) => {
      const current = this.#proc === proc;
      if (current) this.#proc = null;
      if (current) this.#failConnections(new Error(`capture: could not start ${chrome}: ${err.message}`));
      this.#dropProfile(profile);
    });
    proc.once('exit', (code, signal) => {
      // Only the browser we are still talking to may fail its connections. A
      // replacement is already live by the time an old process reports its
      // death, and failing connections then would reject the new browser's
      // calls. #stopBrowser already failed them for a browser we chose to stop.
      const current = this.#proc === proc;
      if (current) this.#proc = null;
      if (current) {
        const tail = log.trim() ? ` — ${log.trim().slice(-300)}` : '';
        this.#failConnections(
          new Error(`capture: the browser exited (${signal ?? `code ${code}`})${tail}`),
        );
      }
      // Always this launch's own profile: #profileDir may already point at the
      // replacement's, and deleting that would pull the rug out from under it.
      this.#dropProfile(profile);
    });

    this.#proc = proc;

    // The debugging endpoint takes a moment to answer; poll instead of sleeping
    // a fixed amount, so a fast start costs ~250ms and a slow one still works.
    const deadline = Date.now() + Math.max(8000, this.#navTimeoutMs);
    let version = null;
    while (Date.now() < deadline && proc.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          version = await res.json();
          break;
        }
      } catch {
        // not listening yet
      }
      await delay(200);
    }
    if (!version) {
      const tail = log.trim() ? ` — ${log.trim().slice(-300)}` : '';
      await this.#stopBrowser();
      throw new Error(`capture: ${chrome} started but its debugging endpoint never answered${tail}`);
    }

    const wsUrl = version.webSocketDebuggerUrl ?? version['Web-Socket-Debugger-Url'];
    if (!wsUrl) {
      await this.#stopBrowser();
      throw new Error('capture: the browser did not advertise a DevTools WebSocket');
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('capture: timed out connecting to the browser')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        done();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        fail(new Error('capture: could not open the DevTools WebSocket'));
      });
    });

    // Assigned before any listener exists: a close delivered later must be able
    // to tell whether it belongs to *this* socket.
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => {
      // A socket that is no longer ours belongs to a browser we already replaced
      // (killed from outside, then relaunched). Failing its connections would
      // reject the calls the *new* browser has already started.
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#failConnections(new Error('capture: the DevTools connection closed'));
    });
    ws.addEventListener('error', () => {
      // Individual send failures are reported by the per-request timeout; the
      // close event that follows is what tears the state down.
    });
  }

  /** Make sure this tab has a live target+session in the current browser. */
  async #ensureTab(tab) {
    if (tab.sessionId && this.#ws) return;

    const { targetId } = await this.#send('Target.createTarget', { url: 'about:blank' }, undefined, 15_000);
    // flatten: true multiplexes the tab's traffic over the single browser socket
    // with a sessionId field, which is what lets several URLs share one browser.
    const { sessionId } = await this.#send('Target.attachToTarget', { targetId, flatten: true });
    tab.targetId = targetId;
    tab.sessionId = sessionId;
    tab.navigated = false;
    tab.applied = null;

    // Page.* events (loadEventFired) only arrive once the domain is enabled.
    await this.#send('Page.enable', {}, sessionId, 10_000);
  }

  #armIdle(tab) {
    if (this.#idleMs <= 0) return;
    clearTimeout(tab.timer);
    // An unused tab is a full Chromium renderer holding a page's worth of memory;
    // a wall that stops asking for a URL should stop paying for it.
    tab.timer = setTimeout(() => {
      this.#tabs.delete(tab.url);
      if (tab.targetId && this.#ws) {
        this.#send('Target.closeTarget', { targetId: tab.targetId }, undefined, 5000).catch(() => {});
      }
      tab.sessionId = null;
      if (this.#tabs.size === 0) this.#stopBrowser().catch(() => {});
    }, this.#idleMs);
    tab.timer.unref();
  }
  #failConnections(err) {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#pending.clear();
    for (const [, waiters] of this.#waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    }
    this.#waiters.clear();
    // Every tab belongs to the browser that just went away; the next shot of the
    // same URL rebuilds its tab instead of reusing a dead session.
    for (const tab of this.#tabs.values()) {
      tab.sessionId = null;
      tab.targetId = null;
      tab.navigated = false;
      tab.applied = null;
    }
  }

  async #stopBrowser() {
    const proc = this.#proc;
    const ws = this.#ws;
    this.#proc = null;
    this.#ws = null;

    if (ws && ws.readyState <= 1) {
      // Ask Chrome to exit on its own first: that tears down its renderer/GPU
      // children cleanly. Browser.close usually never answers, so it is fired
      // and forgotten rather than awaited.
      try {
        ws.send(JSON.stringify({ id: ++this.#nextId, method: 'Browser.close', params: {} }));
      } catch {
        // already gone
      }
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
    this.#failConnections(new Error('capture: the capture session was closed'));

    if (proc && proc.exitCode === null && proc.signalCode === null) {
      let settle = null;
      const exited = new Promise((done) => {
        settle = done;
        proc.once('exit', done);
      });
      const timer = setTimeout(() => settle?.(), 1500);
      await Promise.race([exited, timer]);
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null) {
        // Hard kill. On Windows Chromium spawns child processes that outlive a
        // plain TerminateProcess of the parent, so take the whole tree.
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.unref();
          await new Promise((done) => {
            killer.once('close', done);
            killer.once('error', done);
            setTimeout(done, 3000).unref();
          });
        } else {
          proc.kill('SIGKILL');
        }
      }
    }
    this.#dropProfile();
  }

  /**
   * Remove one launch's temp profile. The directory is passed explicitly: a late
   * `exit` from a browser we already replaced must not delete the profile its
   * replacement is running on.
   */
  #dropProfile(dir = this.#profileDir) {
    if (!dir) return;
    if (this.#profileDir === dir) this.#profileDir = null;
    try {
      // Chrome can still be flushing the profile when it exits; force + retries
      // turn "sometimes fails" into "usually cleans up" without a second process.
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {
      // A leftover temp profile is untidy, not a bug worth failing a capture for.
    }
  }

  // --------------------------------------------------------------------------
  // CDP plumbing
  // --------------------------------------------------------------------------

  #send(method, params = {}, sessionId, timeoutMs = this.#navTimeoutMs) {
    const ws = this.#ws;
    if (!ws || ws.readyState >= 2) {
      return Promise.reject(new Error('capture: the browser connection is closed'));
    }
    return new Promise((done, fail) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        fail(new Error(`capture: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: done, reject: fail, timer, method });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        fail(new Error(`capture: could not reach the browser: ${err.message}`));
      }
    });
  }

  #waitFor(sessionId, method, predicate, timeoutMs, label) {
    const key = `${sessionId}\u0000${method}`;
    const waiter = { predicate, resolve: null, reject: null, timer: null };
    const promise = new Promise((done, fail) => {
      waiter.resolve = done;
      waiter.reject = fail;
    });
    waiter.timer = setTimeout(() => {
      this.#removeWaiter(key, waiter);
      waiter.reject(new Error(`capture: timed out waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    waiter.timer.unref();
    const list = this.#waiters.get(key);
    if (list) list.push(waiter);
    else this.#waiters.set(key, [waiter]);

    promise.cancel = () => {
      clearTimeout(waiter.timer);
      this.#removeWaiter(key, waiter);
    };
    return promise;
  }

  #removeWaiter(key, waiter) {
    const list = this.#waiters.get(key);
    if (!list) return;
    const at = list.indexOf(waiter);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.#waiters.delete(key);
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        waiter.reject(new Error(`capture: ${waiter.method} failed: ${msg.error.message}`));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    const key = `${msg.sessionId ?? ''}\u0000${msg.method}`;
    const list = this.#waiters.get(key);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const waiter = list[i];
      if (!waiter.predicate(msg.params ?? {})) continue;
      clearTimeout(waiter.timer);
      list.splice(i, 1);
      waiter.resolve(msg.params ?? {});
    }
    if (list.length === 0) this.#waiters.delete(key);
  }
}

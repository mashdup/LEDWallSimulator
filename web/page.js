/**
 * page — capture a LIVE web page and hand it to core/panner.js as a Bitmap.
 *
 * The pixels come from the dev server's `/capture` route (tools/capture.js),
 * which drives a real headless Chromium over CDP: navigate, measure the page,
 * resize the viewport to cover it, screenshot. That is why the rasterising does
 * NOT happen here — a page on some other origin cannot be drawn onto a canvas
 * from this tab (no CORS headers on arbitrary sites, so `drawImage` would taint
 * or fail), and no DOM in this page can lay out someone else's site. The capture
 * is a PNG from a browser that CAN see it, fetched as same-origin bytes.
 *
 * The PNG is opaque, so alpha is 255 everywhere and core/raster.js reads every
 * cell as fully covered: the page's own background is part of the image. That is
 * correct here — a page is not ink on transparency the way banner text is.
 *
 * Cell unit: for banner text, `pxPerCell` is a property of the SOURCE (the text
 * was rendered at 12 px per panel cell). A web page has no such property — it is
 * laid out in CSS pixels at its own size. So the Bitmap here is built at
 * pxPerCell 1: its cell unit IS a source pixel, and the zoom is a DISPLAY choice
 * made by core/panner.js. That split is what makes a 1280 px page legible on 400
 * cells: the panner shows a magnified window of it instead of crushing it whole.
 *
 * DOM lives here, maths lives in core/. Nothing in this file is Node-testable
 * (it needs fetch, createImageBitmap and a 2d canvas); everything it produces is.
 */

import { bitmap } from '../core/scroller.js';

const DEFAULT_URL = 'https://example.com/';
const DEFAULT_ENDPOINT = '/capture';
/**
 * Poll period. Longer than the banner's 300 ms on purpose: each poll is a real
 * browser screenshot (tens of ms of Chromium work), not a static file read.
 */
const DEFAULT_INTERVAL_MS = 500;
/** A page's natural layout width. 1280 is where most sites stop reflowing. */
const DEFAULT_VIEWPORT_W = 1280;
const DEFAULT_VIEWPORT_H = 800;
/** Device pixels per CSS pixel. 1 keeps the PNG the size the page laid out at. */
const DEFAULT_DSF = 1;

/**
 * One capture, exported for reuse and tests.
 *
 * `cache: 'no-store'` because the whole point is seeing the page as it is NOW —
 * a cached 200 would freeze a live feed. The X-Capture-* headers are read back so
 * the app can report what was actually rendered and how much taller the page
 * really is than the window that was captured.
 *
 * @param {object} [opts]
 * @param {string} [opts.url] absolute http(s) page URL
 * @param {string} [opts.endpoint] capture route, default '/capture'
 * @param {number} [opts.width] CSS viewport width to render the page at
 * @param {number} [opts.height] CSS viewport height
 * @param {number} [opts.dsf] device pixels per CSS pixel
 * @param {number} [opts.waitMs] settle time after load
 * @param {boolean} [opts.reload] force re-navigation instead of re-shooting the live tab
 * @returns {Promise<{blob: Blob, meta: object}>}
 */
export async function fetchPage(opts = {}) {
  const url = opts.url ?? DEFAULT_URL;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const query = new URLSearchParams({
    url,
    w: String(opts.width ?? DEFAULT_VIEWPORT_W),
    h: String(opts.height ?? DEFAULT_VIEWPORT_H),
    dsf: String(opts.dsf ?? DEFAULT_DSF),
    wait: String(opts.waitMs ?? 400),
  });
  if (opts.reload) query.set('reload', '1');

  const res = await fetch(`${endpoint}?${query}`, { cache: 'no-store' });
  if (!res.ok) {
    // The route's JSON error body names the real cause (no browser installed,
    // unreachable host, navigation timeout); surfacing it beats "502".
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      // Non-JSON error body: statusText is all we have.
    }
    throw new Error(`page capture failed: ${res.status} ${detail}`);
  }

  const header = (name) => Number(res.headers.get(name));
  return {
    blob: await res.blob(),
    meta: {
      url,
      hash: res.headers.get('X-Capture-Hash'),
      width: header('X-Capture-Width'),
      height: header('X-Capture-Height'),
      cssWidth: header('X-Capture-Css-Width'),
      cssHeight: header('X-Capture-Css-Height'),
      scrollHeight: header('X-Capture-Scroll-Height'),
      ms: header('X-Capture-Ms'),
    },
  };
}

/**
 * Poll a live page through the capture route and produce a panner source.
 *
 * The app owns one PageSource, calls refresh() on a timer, and reads bitmap()
 * every frame. Decoding happens inside refresh(), so bitmap() is a plain sync
 * getter the 30 fps loop can call without awaiting — and it only re-decodes when
 * the capture bytes actually differ, so a static page costs one screenshot and
 * zero decodes per poll.
 */
export class PageSource {
  /** @type {HTMLCanvasElement|OffscreenCanvas|null} Reused across decodes. */
  #canvas = null;
  #ctx = null;
  /** @type {import('../core/scroller.js').Bitmap|null} */
  #raster = null;
  /** The capture key `#raster` was decoded from. */
  #rasterKey = null;
  /** @type {object|null} */
  #meta = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  #timer = null;
  /** True while the poll loop is running; guards the self-rescheduling chain. */
  #running = false;
  #stale = false;
  /** Message from the last failed capture, or null. */
  #error = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.url] page to capture
   * @param {string} [opts.endpoint] capture route
   * @param {number} [opts.intervalMs] poll period; default 500
   * @param {number} [opts.width] CSS viewport width; default 1280
   * @param {number} [opts.height] CSS viewport height; default 800
   * @param {number} [opts.dsf] device pixels per CSS pixel; default 1
   * @param {number} [opts.waitMs] settle time after load; default 400
   */
  constructor(opts = {}) {
    this.url = opts.url ?? DEFAULT_URL;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    // Floored at 100 ms: a capture is a Chromium screenshot, and polling one
    // faster than that only queues work behind the previous screenshot.
    this.intervalMs = Math.max(100, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.width = opts.width ?? DEFAULT_VIEWPORT_W;
    this.height = opts.height ?? DEFAULT_VIEWPORT_H;
    this.dsf = opts.dsf ?? DEFAULT_DSF;
    this.waitMs = opts.waitMs ?? 400;

    if (!(this.width > 0) || !(this.height > 0)) {
      throw new RangeError(`viewport must be positive, got ${this.width}x${this.height}`);
    }
  }

  /** True if the last capture failed; the app should show a status light. */
  get stale() {
    return this.#stale;
  }

  /** Why the last capture failed, or null. The wall keeps the previous frame either way. */
  get error() {
    return this.#error;
  }

  /** What the last successful capture reported, or null before the first one. */
  get meta() {
    return this.#meta;
  }

  /**
   * One capture + decode. Never rejects: a failed capture keeps the previous
   * frame and flips `stale`, because a stale page on the wall beats a blank
   * wall — and a rejection escaping a timer is an unhandled rejection, i.e. a
   * crash.
   *
   * @param {boolean} [reload] force re-navigation (used when the URL changes)
   * @returns {Promise<{changed: boolean}>}
   */
  async refresh(reload = false) {
    try {
      const { blob, meta } = await fetchPage({
        url: this.url,
        endpoint: this.endpoint,
        width: this.width,
        height: this.height,
        dsf: this.dsf,
        waitMs: this.waitMs,
        reload,
      });
      // Decode only when the pixels differ. `hash` is the route's sha256 of the
      // PNG; if a proxy ever strips that header the key is null and every poll
      // re-decodes, which is correct-but-wasteful rather than wrong.
      const key = meta.hash === null || meta.hash === undefined
        ? null
        : `${meta.hash}|${meta.width}x${meta.height}`;
      const changed = key !== this.#rasterKey;
      if (changed) this.#raster = await this.#decode(blob);
      this.#rasterKey = key;
      this.#meta = meta;
      this.#stale = false;
      this.#error = null;
      return { changed };
    } catch (err) {
      this.#stale = true;
      this.#error = err.message;
      return { changed: false };
    }
  }

  /**
   * Start the poll loop (idempotent; kicks one capture immediately so the wall
   * is not blank for a whole interval).
   *
   * Self-rescheduling, NOT `setInterval`. A capture is a Chromium screenshot and
   * the route serialises shots on one tab, so a fixed-interval timer fires again
   * while the previous capture is still in flight; those requests then queue on
   * the tab's chain and every frame the wall shows gets older. So `intervalMs`
   * is a minimum gap between captures, not a firing rate — the next one starts as
   * soon as this one lands if the page is slow. `test/page.test.js` pins this:
   * captures never overlap, and a slow capture does not queue a backlog behind it.
   *
   * Where the ceiling is, measured on a 400x400 animated page (settle 0):
   *   interval 500 ms -> 4.4 captures/s, 108 ms median
   *   interval 150 ms -> 8.3 captures/s, 233 ms median
   *   interval 100 ms -> 8.6 captures/s, 318 ms median
   * Throughput saturates around 8.5 captures/s: below a ~150 ms interval you buy
   * no frames and only add queueing on the serialised tab. At 150 ms the wall
   * trails the live page by one capture cycle (measured: exactly 1 cell of a
   * 20-cell grid for a bar moving 120 px/s = 167 ms), which is the floor for a
   * request/response pipeline — the frame is already ~100 ms old when it arrives.
   */
  start() {
    if (this.#running) return this;
    this.#running = true;
    const poll = async () => {
      if (!this.#running) return;
      const started = Date.now();
      await this.refresh();
      if (!this.#running) return;
      this.#timer = setTimeout(poll, Math.max(0, this.intervalMs - (Date.now() - started)));
    };
    poll();
    return this;
  }

  /** Stop the poll loop (idempotent). */
  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    return this;
  }

  /**
   * The captured frame as a core Bitmap, or null until the first capture lands.
   *
   * pxPerCell 1: the Bitmap's cell unit is a source pixel, because a page has no
   * natural size in panel cells — core/panner.js chooses the zoom.
   *
   * @returns {import('../core/scroller.js').Bitmap|null}
   */
  bitmap() {
    return this.#raster;
  }

  /**
   * PNG bytes -> RGBA.
   *
   * The browser decodes the PNG (no decoder in Node, none needed), and a canvas
   * is the only way to read pixels back out of an ImageBitmap.
   * `willReadFrequently` keeps that canvas CPU-backed instead of round-tripping
   * the GPU for every getImageData.
   */
  async #decode(blob) {
    const ctx = this.#context();
    const img = await createImageBitmap(blob);
    // Read the size BEFORE close(): a closed ImageBitmap reports width/height 0,
    // and getImageData(0, 0, 0, 0) throws "The source width is 0".
    const { width, height } = img;
    const canvas = /** @type {HTMLCanvasElement|OffscreenCanvas} */ (this.#canvas);
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    // Release the decoded bitmap only once its pixels are ours.
    img.close?.();
    return bitmap(data, width, height, 1);
  }

  /** Lazily create the offscreen canvas so `new PageSource()` works before any decode is needed. */
  #context() {
    if (this.#ctx !== null) return this.#ctx;
    if (typeof OffscreenCanvas === 'function') {
      this.#canvas = new OffscreenCanvas(1, 1);
    } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      this.#canvas = document.createElement('canvas');
    } else {
      throw new Error('PageSource needs a canvas: OffscreenCanvas or document');
    }
    const ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('PageSource: no 2d canvas context available');
    this.#ctx = ctx;
    return this.#ctx;
  }
}

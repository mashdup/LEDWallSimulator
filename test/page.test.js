/**
 * Poll-loop contracts for web/page.js.
 *
 * page.js is the DOM half of the app: it needs fetch, createImageBitmap and a
 * canvas. Node has fetch; the shims below supply the rest, which is enough to
 * test the thing that actually decides how live a page feed is — WHEN captures
 * are issued. The raster maths is covered by test/raster.test.js and the capture
 * route by test/capture.test.js; nothing else covers the poller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PageSource } from '../web/page.js';

// 4x4 PNG, the smallest thing that is still a PNG. The decoder is shimmed, so
// only its byte length matters for the "is this a real capture" assertions.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Stand in for the /capture route, recording when each request started and how
 * many were in flight at once. `maxInflight` is the number that matters: a
 * poller that overlaps requests pushes every frame the wall shows further into
 * the past, because the route serialises shots on one tab.
 */
function fakeCapture({ latencyMs = 0, fail = false } = {}) {
  const started = [];
  let inflight = 0;
  let maxInflight = 0;
  let n = 0;

  const fetchImpl = async (url) => {
    n += 1;
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    const t0 = Date.now();
    started.push(t0);
    const query = new URL(url, 'http://127.0.0.1').searchParams;

    try {
      if (latencyMs > 0) await sleep(latencyMs);
      if (fail) throw new Error('the capture route exploded');

      return new Response(new Blob([PNG]), {
        headers: {
          'X-Capture-Hash': `hash-${n}`,
          'X-Capture-Width': '4',
          'X-Capture-Height': '4',
          'X-Capture-Css-Width': String(Number(query.get('w'))),
          'X-Capture-Css-Height': String(Number(query.get('h'))),
          'X-Capture-Scroll-Height': '4',
          'X-Capture-Ms': String(Date.now() - t0),
        },
      });
    } finally {
      inflight -= 1;
    }
  };

  return {
    fetchImpl,
    get calls() {
      return started.length;
    },
    /** Millisecond gaps between consecutive capture starts. */
    get gaps() {
      return started.slice(1).map((t, i) => t - started[i]);
    },
    get maxInflight() {
      return maxInflight;
    },
  };
}

/**
 * Install the browser APIs page.js needs, returning a restore function so the
 * shims cannot leak into another test file.
 */
function withBrowserApis(fetchImpl) {
  const saved = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };

  globalThis.fetch = fetchImpl;
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        drawImage() {},
        getImageData: (_x, _y, w, h) => ({ data: new Uint8Array(w * h * 4) }),
      };
    }
  };

  return () => Object.assign(globalThis, saved);
}

test('the poll loop never overlaps captures', async () => {
  const restore = withBrowserApis(null);
  try {
    // Latency well above the interval: this is exactly the case a fixed-interval
    // timer gets wrong, because it keeps firing while the last capture is running.
    const fake = fakeCapture({ latencyMs: 120 });
    globalThis.fetch = fake.fetchImpl;
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 40 });

    source.start();
    await sleep(700);
    source.stop();

    assert.ok(fake.calls >= 3, `expected several captures, got ${fake.calls}`);
    assert.equal(
      fake.maxInflight,
      1,
      'captures must be serialised: overlapping them only makes every frame older',
    );
  } finally {
    restore();
  }
});

test('intervalMs is a minimum gap between captures, not a firing rate', async () => {
  const restore = withBrowserApis(null);
  try {
    const fake = fakeCapture({ latencyMs: 150 });
    globalThis.fetch = fake.fetchImpl;
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 40 });

    source.start();
    await sleep(800);
    source.stop();

    const slowest = Math.max(...fake.gaps);
    assert.ok(
      slowest < 150 + 120,
      `a slow capture must not queue the next one behind a backlog: max gap ${slowest}ms`,
    );
    const fastest = Math.min(...fake.gaps);
    assert.ok(
      fastest >= 150 * 0.6,
      `gap ${fastest}ms should track the ${150}ms capture time, not the 40ms interval`,
    );
  } finally {
    restore();
  }
});

test('start() is idempotent: it does not fork a second poll chain', async () => {
  const restore = withBrowserApis(null);
  try {
    const fake = fakeCapture({ latencyMs: 60 });
    globalThis.fetch = fake.fetchImpl;
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 150 });

    source.start();
    source.start();
    source.start();
    await sleep(650);
    source.stop();

    // Three chains would interleave and roughly triple the request count; one
    // chain at 150 ms plus ~60 ms of work fits about four captures in 650 ms.
    assert.ok(fake.calls <= 6, `expected one chain of captures, got ${fake.calls}`);
    assert.equal(fake.maxInflight, 1);
  } finally {
    restore();
  }
});

test('stop() halts the chain, including a capture already in flight', async () => {
  const restore = withBrowserApis(null);
  try {
    const fake = fakeCapture({ latencyMs: 100 });
    globalThis.fetch = fake.fetchImpl;
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 50 });

    source.start();
    await sleep(260);
    source.stop();
    const atStop = fake.calls;

    await sleep(400);
    assert.equal(fake.calls, atStop, 'no capture may start after stop()');
  } finally {
    restore();
  }
});

test('a failed capture keeps the last frame and reports stale', async () => {
  const restore = withBrowserApis(null);
  try {
    const ok = fakeCapture();
    globalThis.fetch = ok.fetchImpl;
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 1000 });

    await source.refresh();
    assert.equal(source.stale, false);
    const frame = source.bitmap();
    assert.ok(frame, 'the first capture must produce a frame');

    globalThis.fetch = fakeCapture({ fail: true }).fetchImpl;
    await source.refresh();

    assert.equal(source.stale, true);
    assert.match(source.error, /capture route exploded/);
    assert.equal(source.bitmap(), frame, 'a stale page on the wall beats a blank wall');
  } finally {
    restore();
  }
});

test('a capture with identical bytes does not re-decode', async () => {
  const restore = withBrowserApis(null);
  try {
    let decodes = 0;
    const fake = fakeCapture();
    globalThis.fetch = fake.fetchImpl;
    globalThis.createImageBitmap = async () => {
      decodes += 1;
      return { width: 4, height: 4, close() {} };
    };
    const source = new PageSource({ url: 'http://127.0.0.1/page', intervalMs: 1000 });

    // Same hash both times: the raster is already correct, so the second poll
    // costs a screenshot and zero decoding.
    globalThis.fetch = async (url) => {
      const res = await fake.fetchImpl(url);
      res.headers.set('X-Capture-Hash', 'same');
      return res;
    };

    const first = await source.refresh();
    const second = await source.refresh();

    assert.equal(first.changed, true);
    assert.equal(second.changed, false, 'identical capture bytes must not re-decode');
    assert.equal(decodes, 1, `expected one decode, got ${decodes}`);
  } finally {
    restore();
  }
});

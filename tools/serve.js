// Zero-dependency static dev server for the LED wall browser app.
//
// Binds to 127.0.0.1 ONLY: Web Serial (navigator.serial) requires a secure
// context, and http://127.0.0.1 qualifies as one while http://192.168.x.x does
// not — so the page must be reached over loopback for the serial sink to work.
//
// Usage: node tools/serve.js [--port 8080]   (or: npm run serve, PORT=8080)
//
// Gallery guards for the guest page (web/public.html), all server-side:
//   --rate-spacing <ms>   minimum gap between POST /drawings per address (10000; 0 off)
//   --rate-burst <n>      posts allowed per --rate-window (6; 0 off)
//   --rate-window <ms>    burst window (60000)
//   --max-drawings <n>    gallery size cap (200; 0 off)
//   --owner-token <hex>   the DELETE token (else WALL_OWNER_TOKEN, else a random
//                         one saved to data/owner-token.txt and printed at start)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Capture, parseCaptureParams } from './capture.js';
import { parseMessage } from '../core/content-protocol.js';
import { newDrawing, validateEntry, isPixelHex, pixelsFromHex } from '../core/drawings.js';
import { isFetchablePort } from './ports.js';
import { serialPorts, serialTakeOver } from './serial.js';
import { FRAME_BYTES } from '../core/frame.js';
import { DdpTransport } from './bridge.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

// Site root: the repo's web/ directory.
const ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
// core/ is imported directly by the browser app as ESM (no bundler), so it has
// to be reachable as /core/*.js. It is the same files the Node tests run.
const CORE_ROOT = resolve(fileURLToPath(new URL('../core/', import.meta.url)));

// The drawings store: user entries live in one JSON file on disk, so a
// gallery survives a server restart. --data <file> redirects it (the tests
// point it at a temp path); the default is repo data/, which is gitignored.
const DATA_FILE = resolve(fileURLToPath(new URL('../data/drawings.json', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  // Must be text/javascript (not application/octet-stream) or browser ESM
  // imports of core/*.js are refused.
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Flag number: --name 5000 -> 5000; absent, unparsable or negative -> default. */
function flagNumber(argv, name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Flags this server reads, each with one value: --name <value>. */
const VALUE_FLAGS = new Set([
  '--ddp', '--data', '--owner-token',
  '--rate-spacing', '--rate-burst', '--rate-window', '--max-drawings',
]);

/** Parse --port / PORT with the documented precedence: flag > env > default. */
function resolvePort(argv) {
  let flag = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      flag = argv[++i];
    } else if (arg.startsWith('--port=')) {
      flag = arg.slice('--port='.length);
    } else if (VALUE_FLAGS.has(arg)) {
      i++; // consumed by its own resolver; accepted here so one argv carries all of them
    } else {
      console.error(`serve: unknown argument ${arg}`);
      console.error('usage: node tools/serve.js [--port <port>] [--ddp <host>] [--data <file>]');
      console.error('       [--owner-token <hex>] [--rate-spacing <ms>] [--rate-burst <n>] [--rate-window <ms>] [--max-drawings <n>]');
      process.exit(2);
    }
  }

  const raw = flag ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`serve: invalid port ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  if (!isFetchablePort(port)) {
    // Binding succeeds on these ports and then nothing can connect to them: the
    // fetch standard (and Chromium) refuse them outright, so the server would
    // print a URL that is guaranteed to fail. Refusing here is the honest error.
    console.error(`serve: port ${port} is unreachable by design — browsers refuse it.`);
    console.error('Pick any other port, e.g. --port 8080');
    process.exit(2);
  }
  return port;
}

/**
 * Map a request URL onto a path inside a served root, or null if it is not
 * allowed. Percent-decodes, normalises Windows separators, then rejects any
 * '..' segment outright so nothing can climb out of the served roots.
 */
function safePath(rawUrl) {
  let decoded;
  try {
    decoded = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  const segments = decoded.replace(/\\/g, '/').split('/');
  const clean = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    // NUL/control chars and ':' (Windows drive letters, alternate data
    // streams) never belong in a filename.
    if (/[\u0000-\u001f:]/.test(segment)) return null;
    clean.push(segment);
  }

  // /core/... is served from the repo's core/ directory; everything else from
  // web/. Both roots are confined the same way.
  const mounted = clean[0] === 'core';
  const base = mounted ? CORE_ROOT : ROOT;
  const rest = mounted ? clean.slice(1) : clean;

  const target = resolve(join(base, ...rest));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

function respond(res, status, headers, body) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendFile(res, target, info, type, headOnly) {
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': type,
    'Content-Length': String(info.size),
    'Last-Modified': info.mtime.toUTCString(),
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(target);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * One browser for the whole server process: launching Chromium costs ~0.5s and
 * tens of MB, and the whole point of the endpoint is a live feed, so every
 * request must reuse the same tab rather than cold-start a browser.
 */
const capture = new Capture();

/**
 * GET /capture?url=<encoded>&w=<css>&h=<css>&dsf=<n>&wait=<ms>&reload=1
 *
 * Handled before static serving because /capture is not a file: it is a live
 * raster of an arbitrary web page, returned as a PNG the browser app can draw
 * straight onto the panel. The X-Capture-* headers tell the caller what was
 * actually rendered (device pixels) and how much taller the page really is
 * (X-Capture-Scroll-Height), which is what a scroller needs to pan.
 */
async function handleCapture(req, res, url) {
  let params;
  try {
    params = parseCaptureParams(url.searchParams);
  } catch (err) {
    // RangeError from the URL policy or a non-numeric dimension.
    respond(res, 400, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: err.message }) + '\n');
    return;
  }

  try {
    const shot = await capture.shot(params);
    // Content hash of the PNG: a live feed polls the same page every 500 ms and
    // most of those shots are pixel-identical. The browser app compares this to
    // skip decoding a frame it already has — Blob identity is useless for that
    // because every response is a fresh Blob object.
    const hash = createHash('sha256').update(shot.png).digest('hex').slice(0, 16);
    respond(
      res,
      200,
      {
        'Content-Type': 'image/png',
        'Content-Length': String(shot.png.length),
        'X-Capture-Hash': hash,
        'X-Capture-Width': String(shot.width),
        'X-Capture-Height': String(shot.height),
        'X-Capture-Css-Width': String(shot.cssWidth),
        'X-Capture-Css-Height': String(shot.cssHeight),
        'X-Capture-Scroll-Height': String(shot.scrollHeight),
        'X-Capture-Ms': String(shot.ms),
      },
      req.method === 'HEAD' ? undefined : shot.png,
    );
  } catch (err) {
    // No browser installed, a dead host, a hung navigation, a crashed Chromium:
    // all are "the upstream could not be captured", and the request handler must
    // never throw — an unhandled rejection here would take the dev server down.
    respond(res, 502, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: err.message }) + '\n');
  }
}

/**
 * POST /frame — one record from the page, forwarded to the wall as DDP.
 *
 * The page cannot send UDP, so the socket lives here: the app's http sink posts
 * the same 1203-byte record the serial sink would write, and this hands it to the
 * same DdpTransport the bridge uses. Off unless --ddp names a target, so a plain
 * `npm run serve` behaves exactly as before.
 *
 * The size cap is the protocol's own frame size: anything larger is not a record
 * this server should be forwarding, and reading it whole to find that out would
 * be the only unbounded buffer in the process.
 */
async function handleFrame(req, res) {
  if (ddp === null) {
    respond(res, 503, { 'Content-Type': 'text/plain; charset=utf-8' }, 'no --ddp target\n');
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FRAME_BYTES) {
      req.destroy();
      respond(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'record too large\n');
      return;
    }
    chunks.push(chunk);
  }
  if (ddp.send(Buffer.concat(chunks))) {
    respond(res, 204, {}, '');
  } else {
    respond(res, 503, { 'Content-Type': 'text/plain; charset=utf-8' }, 'record refused\n');
  }
}

/**
 * GET/POST /content - the content state, server-side.
 *
 * The wall's pipeline spans THREE disconnected browser worlds: the control
 * tab, a human's content tab, and the headless capture browser that renders
 * the page the wall photographs. They share no tabs, no BroadcastChannel, no
 * storage - only this server. So the content state lives HERE: pages POST
 * commands, every page GETs (state, serverTime) and renders it. Deriving
 * animation phase from the server clock makes all instances show the same
 * frame at the same moment - the wall, the control tab, and a human's tab
 * are one synced view, not three animations.
 *
 * Last write wins; a monotonically increasing rev lets renderers detect
 * changes without diffing. Bodies are protocol messages: parseMessage is the
 * gate, so the server stores only legal commands.
 */
const content = { rev: 0, at: Date.now(), state: { v: 1, kind: 'demo' } };

function handleContentGet(req, res) {
  // no-store: renderers poll this every ~100 ms; a cached answer is a frozen wall.
  // `at` is the server's CURRENT time, not the last-POST time: renderers
  // rebase their clock on every poll (serverAt + elapsed). If at were the
  // POST time, every poll would snap every animation back to the moment of
  // the last command - a sawtooth clock, seen as animation that constantly
  // restarts. The POST time stays in the body as postedAt for reference.
  respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    JSON.stringify({...content, at: Date.now()}));
}

async function handleContentPost(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 8 KB: a pic message carries a whole 20x20 drawing as hex (~3.3 KB), so
    // the old 4 KB cap left almost no headroom for the JSON envelope.
    if (size > 8192) {
      req.destroy();
      respond(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'content command too large\n');
      return;
    }
    chunks.push(chunk);
  }
  let m;
  try {
    m = parseMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    m = null;
  }
  if (m === null) {
    respond(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not a legal content command\n');
    return;
  }
  content.rev += 1;
  content.at = Date.now();
  content.state = m;
  respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    JSON.stringify(content));
}

/**
 * POST/GET /content/frame - the content page pushes its own canvas, the
 * wall fetches the latest.
 *
 * The /capture route photographs a page at ~60-90 ms per shot: the wall's
 * frame rate tops out near 10 fps no matter what the app's 30 fps loop
 * wants. A pushing page removes the photographer entirely: content.html
 * POSTs its canvas PNG after every draw (~30 fps), the app fetches the
 * freshest bytes in a few milliseconds. The push is self-throttled by an
 * in-flight guard, so a slow encode lowers the rate instead of queueing.
 *
 * Only the LATEST frame is kept - the wall is a display, not a recorder.
 */
const contentFrame = { png: null, type: 'image/jpeg', hash: null, at: 0 };

async function handleContentFramePost(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      req.destroy();
      respond(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'frame too large\n');
      return;
    }
    chunks.push(chunk);
  }
  contentFrame.png = Buffer.concat(chunks);
  // The hash lets PageSource skip decoding identical frames - the same
  // contract the /capture route offers. Without it, a poller must decode
  // every poll (correct), and with a null-vs-null compare written as
  // 'changed', it must never decode at all (the frozen wall this fixes).
  contentFrame.hash = createHash('sha256').update(contentFrame.png).digest('hex').slice(0, 16);
  // Echo back what was pushed; the pusher declares the encoding.
  contentFrame.type = req.headers['content-type'] ?? 'image/jpeg';
  contentFrame.at = Date.now();
  respond(res, 204, {}, '');
}

function handleContentFrameGet(req, res) {
  if (contentFrame.png === null) {
    respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'no frame pushed yet\n');
    return;
  }
  respond(res, 200, {
    'Content-Type': contentFrame.type,
    'Cache-Control': 'no-store',
    'X-Capture-Hash': contentFrame.hash,
    'X-Capture-Ms': String(Date.now() - contentFrame.at),
  }, contentFrame.png);
}

/**
 * GET/POST/DELETE /drawings - the user drawing entries, server-side.
 *
 * Same reasoning as /content: the editor tab, the server, and the gallery
 * renderer (the capture browser) share nothing but this server, so the
 * gallery lives HERE. An entry is {id, name, pixels, createdAt}; pixels is
 * the hex wire form core/drawings.js defines, and validateEntry is the
 * gate - the store never holds a malformed drawing.
 *
 * No users and no moderation: anyone who can reach the site can add an entry
 * (it is a self-hosted family wall), so the write path is guarded by address
 * and the delete path by a token - see the guards below. The list is ordered
 * oldest first, so the gallery's clock-cycling (index = floor(t/interval) % n)
 * shows a stable order that never reshuffles while it cycles.
 */
function resolveDataFile(argv) {
  const i = argv.indexOf('--data');
  return i < 0 ? DATA_FILE : resolve(argv[i + 1] ?? DATA_FILE);
}

const drawings = { file: resolveDataFile(process.argv.slice(2)), list: [] };

function loadDrawings() {
  try {
    const raw = JSON.parse(readFileSync(drawings.file, 'utf8'));
    if (Array.isArray(raw)) drawings.list = raw.filter(validateEntry);
  } catch {
    // No file, junk file: an empty gallery, not a crash. The store is
    // user data; a corrupt one is left on disk, not silently overwritten
    // (it is only written after a successful mutation).
  }
}

function saveDrawings() {
  try {
    mkdirSync(dirname(drawings.file), { recursive: true });
    writeFileSync(drawings.file, JSON.stringify(drawings.list));
  } catch (err) {
    console.error(`serve: drawings not saved: ${err.message}`);
  }
}

loadDrawings();

/** The list without the pixel payloads: what GET /drawings answers. */
function drawingMetas() {
  return drawings.list.map(({ id, name, createdAt }) => ({ id, name, createdAt }));
}

/**
 * The public view of one entry: the pixels, and never the delete secret.
 *
 * The secret is handed to the creator ONCE, in the POST response, and stored
 * beside the entry. If GET /drawings/<id> echoed it, the gallery would be
 * deletable by every visitor - the list is public, so a guest could read the
 * secret of every entry in two requests. The store keeps it, the API never
 * serves it.
 */
function publicEntry(e) {
  return { id: e.id, name: e.name, pixels: e.pixels, createdAt: e.createdAt };
}

/**
 * The guest page's guards. web/public.html is handed to people with no account
 * and no name, so the server's only identities are the source address and a
 * token, and both guards live HERE: a client-side cooldown is a speed bump, not
 * a limit.
 *
 *   rate   - a per-address spacing and burst window on POST /drawings, plus a
 *            total gallery cap. A flood is the realistic failure of a wall you
 *            put a QR code in front of.
 *   tokens - DELETE needs the owner token, or the entry's own delete secret
 *            (given to the creator at POST time, so a guest can take their own
 *            drawing back). Without a token the gallery is append-only for a
 *            stranger, and only the owner's list is prunable.
 *
 * The address is the SOCKET address, on purpose: X-Forwarded-For is trivially
 * forged by exactly the client this limit exists for, and this server is
 * loopback-bound with no proxy in front of it that would set it truthfully.
 */
const rate = {
  spacingMs: flagNumber(process.argv.slice(2), '--rate-spacing', 10_000),
  burst: flagNumber(process.argv.slice(2), '--rate-burst', 6),
  windowMs: flagNumber(process.argv.slice(2), '--rate-window', 60_000),
  maxEntries: flagNumber(process.argv.slice(2), '--max-drawings', 200),
};

const hits = new Map(); // address -> { last, times: [] }

/**
 * rateGate(addr) -> {ok} | {ok:false, retryMs, why}.
 *
 * A REJECTED post records nothing: if it did, hammering the endpoint would push
 * one's own lockout further out, so a flood would be its own reward and a
 * legitimate guest who tapped twice would be locked for minutes.
 */
function rateGate(addr) {
  const now = Date.now();
  if (hits.size > 32) { // one small record per address seen in the window
    for (const [k, v] of hits) if (now - v.last > rate.windowMs) hits.delete(k);
  }
  const h = hits.get(addr) ?? { last: 0, times: [] };
  hits.set(addr, h);
  if (rate.spacingMs > 0 && now - h.last < rate.spacingMs) {
    return { ok: false, retryMs: rate.spacingMs - (now - h.last), why: 'one at a time' };
  }
  if (rate.burst > 0) {
    h.times = h.times.filter((t) => now - t < rate.windowMs);
    if (h.times.length >= rate.burst) {
      return { ok: false, retryMs: rate.windowMs - (now - h.times[0]), why: 'too many in a row' };
    }
  }
  h.last = now;
  h.times.push(now);
  return { ok: true };
}

function clientAddr(req) {
  return req.socket?.remoteAddress ?? '?';
}

/**
 * The owner token: --owner-token <hex>, then WALL_OWNER_TOKEN, then a random
 * one persisted beside the store (data/owner-token.txt), so the owner can copy
 * it once and it survives every restart. An empty token DISABLES owner auth -
 * it is not a shared secret of "", and a guest sending an empty header must not
 * be handed the delete path.
 */
function resolveOwnerToken(argv) {
  const i = argv.indexOf('--owner-token');
  if (i >= 0 && typeof argv[i + 1] === 'string' && argv[i + 1].trim() !== '') {
    return { token: argv[i + 1].trim(), file: null };
  }
  const env = (process.env.WALL_OWNER_TOKEN ?? '').trim();
  if (env !== '') return { token: env, file: null };
  const file = join(dirname(drawings.file), 'owner-token.txt');
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (t !== '') return { token: t, file };
  } catch { /* no file yet */ }
  const fresh = randomBytes(16).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${fresh}\n`);
  } catch (err) {
    console.error(`serve: owner token not saved (${err.message}); this one lasts until restart`);
  }
  return { token: fresh, file };
}

const owner = resolveOwnerToken(process.argv.slice(2));

/** Constant-time compare, length-guarded (timingSafeEqual throws on a mismatch). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function handleDrawings(req, res, url) {
  const seg = url.pathname.split('/');
  if (req.method === 'GET') {
    // /drawings/<id> -> the full entry (the gallery renderer fetches the
    // pixels of one drawing per poll; the metas never carry pixels).
    if (seg[2] !== undefined) {
      const e = drawings.list.find((d) => d.id === seg[2]);
      if (e === undefined) {
        respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'no such drawing\n');
      } else {
        respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(publicEntry(e)));
      }
      return;
    }
    respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(drawingMetas()));
    return;
  }
  if (req.method === 'POST') {
    if (seg.length !== 2) {
      respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, `404 Not Found: ${req.url}\n`);
      return;
    }
    // The gate runs BEFORE the body is read: a rejected post should not make
    // the server absorb 3.3 KB it is going to throw away. A client whose body
    // is still being written may see the reset instead of the 429 - both are
    // "refused", which is what the guest page shows.
    const gate = rateGate(clientAddr(req));
    if (!gate.ok) {
      const secs = Math.max(1, Math.ceil(gate.retryMs / 1000));
      respond(res, 429, { 'Retry-After': String(secs), 'Content-Type': 'text/plain; charset=utf-8' },
        `${gate.why} - try again in ${secs} s\n`);
      return;
    }
    if (rate.maxEntries > 0 && drawings.list.length >= rate.maxEntries) {
      // 507: the gallery is the owner's resource, and the honest answer to a
      // full one is "full", not "saved".
      respond(res, 507, { 'Content-Type': 'text/plain; charset=utf-8' },
        'the gallery is full - the owner prunes it\n');
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) { // a full 20x20 hex drawing is ~3.3 KB; more is not a drawing
        req.destroy();
        respond(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'drawing too large\n' );
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object' || !isPixelHex(body.pixels)) {
      respond(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not a legal drawing\n');
      return;
    }
    // newDrawing takes BYTES; the wire form is hex. Feeding it the hex string
    // would encode each character, not each byte, and store 6400 chars of
    // nonsense - so the conversion is explicit here, at the boundary.
    const e = newDrawing(body.name, pixelsFromHex(body.pixels));
    // The creator's undo token, served ONCE, here and nowhere else: the guest
    // page keeps it in that browser's storage and can take its own drawing
    // back, and nobody who did not post it has it.
    e.secret = randomBytes(10).toString('hex');
    drawings.list.push(e);
    saveDrawings();
    respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ id: e.id, name: e.name, createdAt: e.createdAt, secret: e.secret }));
    return;
  }
  if (req.method === 'DELETE') {
    const ownerHdr = req.headers['x-wall-owner'];
    const delHdr = req.headers['x-wall-delete'];
    if (typeof ownerHdr !== 'string' && typeof delHdr !== 'string') {
      respond(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' },
        'X-Wall-Owner (the owner token) or X-Wall-Delete (the entry secret) is required\n');
      return;
    }
    const isOwner = owner.token !== '' && typeof ownerHdr === 'string' && safeEqual(ownerHdr, owner.token);
    const i = drawings.list.findIndex((d) => d.id === seg[2]);
    if (i < 0) {
      respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'no such drawing\n');
      return;
    }
    if (!isOwner) {
      const secret = drawings.list[i].secret;
      if (typeof delHdr !== 'string' || typeof secret !== 'string' || !safeEqual(delHdr, secret)) {
        respond(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'that token does not open this entry\n');
        return;
      }
    }
    drawings.list.splice(i, 1);
    saveDrawings();
    respond(res, 204, {}, '');
    return;
  }
  respond(res, 405, { Allow: 'GET, POST, DELETE', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
}

const server = createServer(async (req, res) => {
  // GET/HEAD serve files; POST is the frame/content/drawings uploads;
  // DELETE is a drawing entry removal.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST' && req.method !== 'DELETE') {
    respond(res, 405, { Allow: 'GET, HEAD, POST, DELETE', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
    return;
  }

  // Base is a dummy: only the pathname and the query string matter here, and a
  // fixed base keeps this independent of the port actually bound.
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method === 'POST') {
    if (url.pathname === '/frame') {
      await handleFrame(req, res);
      return;
    }
    if (url.pathname === '/content') {
      await handleContentPost(req, res);
      return;
    }
    if (url.pathname === '/content/frame') {
      await handleContentFramePost(req, res);
      return;
    }
    if (url.pathname === '/drawings' || url.pathname.startsWith('/drawings/')) {
      await handleDrawings(req, res, url);
      return;
    }
    respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, `404 Not Found: ${req.url}\n`);
    return;
  }
  if (url.pathname === '/capture') {
    await handleCapture(req, res, url);
    return;
  }
  if (url.pathname === '/content/frame') {
    handleContentFrameGet(req, res);
    return;
  }
  if (url.pathname === '/content') {
    handleContentGet(req, res);
    return;
  }
  if (url.pathname === '/drawings' || url.pathname.startsWith('/drawings/')) {
    if (req.method === 'GET') {
      await handleDrawings(req, res, url);
      return;
    }
    if (req.method === 'DELETE') {
      await handleDrawings(req, res, url);
      return;
    }
  }
  // GET /serial - [{port:'COM8', state:'FREE'|'BUSY'}]. The app shows this
  // before Connect so 'port is taken' is a warning, not a mystery failure.
  if (url.pathname === '/serial') {
    // ?fresh=1 bypasses the 3 s cache: the takeover path needs the probe to
    // RUN (its test-open clears the wch driver's zombie port-lock), not to
    // answer from memory.
    const ports = await serialPorts({ bypassCache: url.searchParams.get('fresh') === '1' });
    respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(ports));
    return;
  }
  // POST /serial/takeover {port} - take the port from a dead app's corpse.
  // The handle scan takes seconds, so the app calls this only on the
  // failure path (Connect's open failed). The kill list is restricted to
  // our own electron.exe (tools/serial.js): a foreign holder (Arduino IDE,
  // PuTTY) is reported, never killed.
  if (url.pathname === '/serial/takeover') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let port = '';
      try { port = JSON.parse(body).port; } catch { /* fallthrough */ }
      serialTakeOver(port).then((r) => {
        respond(res, r.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          JSON.stringify(r));
      }, (e) => {
        respond(res, 500, { 'Content-Type': 'application/json; charset=utf-8' },
          JSON.stringify({ ok: false, error: String((e && e.message) || e), results: [] }));
      });
    });
    return;
  }

  let target = safePath(req.url ?? '/');

  try {
    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target);
    }
    sendFile(res, target, info, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', req.method === 'HEAD');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, `404 Not Found: ${req.url}\n`);
    } else if (err?.code === 'EACCES') {
      respond(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden\n');
    } else {
      respond(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error\n');
    }
  }
});

/** --ddp <host[:port]>: where POST /frame forwards to. Absent means the route is off. */
function resolveDdpTarget(argv) {
  const i = argv.indexOf('--ddp');
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined) {
    console.error('serve: --ddp needs a host, e.g. --ddp 192.168.1.118');
    process.exitCode = 1;
    return null;
  }
  return value;
}

const ddpHost = resolveDdpTarget(process.argv.slice(2));
const ddp = ddpHost === null ? null : await new DdpTransport({ host: ddpHost }).open();
if (ddp !== null) console.log(`serve: POST /frame -> DDP ${ddp.host}:${ddp.port}`);

const port = resolvePort(process.argv.slice(2));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`serve: port ${port} is already in use on ${HOST}.`);
    console.error(`Try another port: PORT=${port + 1} node tools/serve.js  (or --port ${port + 1})`);
  } else {
    console.error('serve:', err.message);
  }
  process.exitCode = 1;
  server.close(() => process.exit(1));
});

server.listen(port, HOST, () => {
  console.log(`LED wall dev server: http://${HOST}:${port}/`);
  console.log(`Serving ${ROOT}`);
  console.log('Web Serial needs this loopback URL — a LAN IP will not expose navigator.serial.');
  const burst = rate.burst > 0 ? `, burst ${rate.burst} per ${rate.windowMs / 1000} s` : '';
  const cap = rate.maxEntries > 0 ? `, cap ${rate.maxEntries} entries` : '';
  console.log(`serve: guest posts: one per ${rate.spacingMs / 1000} s per address${burst}${cap}`);
  // Printed on purpose: this is a self-hosted wall on one machine, and the
  // owner needs the token to prune the gallery from draw.html. It is also in
  // data/owner-token.txt, so it survives the console scrolling away.
  console.log(`serve: owner token (draw.html -> "owner token"): ${owner.token}`
    + (owner.file === null ? '' : `  [saved to ${owner.file}]`));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nserve: ${signal}, shutting down.`);
    // Ctrl+C must not orphan a headless Chromium (and its renderer children):
    // close() asks the browser to exit, then hard-kills the tree if it does not.
    capture.close().catch(() => {});
    server.close(() => process.exit(0));
    // Anything still streaming should not hold the process open.
    setTimeout(() => process.exit(0), 500).unref();
  });
}

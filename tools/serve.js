// Zero-dependency static dev server for the LED wall browser app.
//
// Binds to 127.0.0.1 ONLY: Web Serial (navigator.serial) requires a secure
// context, and http://127.0.0.1 qualifies as one while http://192.168.x.x does
// not — so the page must be reached over loopback for the serial sink to work.
//
// Usage: node tools/serve.js [--port 8080]   (or: npm run serve, PORT=8080)

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { Capture, parseCaptureParams } from './capture.js';
import { parseMessage } from '../core/content-protocol.js';
import { isFetchablePort } from './ports.js';
import { FRAME_BYTES } from '../core/frame.js';
import { DdpTransport } from './bridge.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

// Site root: the repo's web/ directory.
const ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
// core/ is imported directly by the browser app as ESM (no bundler), so it has
// to be reachable as /core/*.js. It is the same files the Node tests run.
const CORE_ROOT = resolve(fileURLToPath(new URL('../core/', import.meta.url)));

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

/** Parse --port / PORT with the documented precedence: flag > env > default. */
function resolvePort(argv) {
  let flag = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      flag = argv[++i];
    } else if (arg.startsWith('--port=')) {
      flag = arg.slice('--port='.length);
    } else if (arg === '--ddp') {
      i++; // consumed by resolveDdpTarget; accepted here so one argv carries both
    } else {
      console.error(`serve: unknown argument ${arg}`);
      console.error('usage: node tools/serve.js [--port <port>] [--ddp <host>]');
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
    if (size > 4096) {
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

const server = createServer(async (req, res) => {
  // GET/HEAD serve files; POST is only the frame upload from the page.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    respond(res, 405, { Allow: 'GET, HEAD, POST', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
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

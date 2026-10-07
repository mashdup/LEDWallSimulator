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
    } else {
      console.error(`serve: unknown argument ${arg}`);
      console.error('usage: node tools/serve.js [--port <port>]');
      process.exit(2);
    }
  }

  const raw = flag ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`serve: invalid port ${JSON.stringify(raw)}`);
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

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    respond(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
    return;
  }

  // Base is a dummy: only the pathname and the query string matter here, and a
  // fixed base keeps this independent of the port actually bound.
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (url.pathname === '/capture') {
    await handleCapture(req, res, url);
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

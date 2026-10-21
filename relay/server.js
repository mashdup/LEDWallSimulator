/**
 * relay/server.js — the public side of the wall.
 *
 * A party has 200 phones and no LAN they can join. So the guest drawing page
 * is served from a public HTTPS name (https://wall.hoa.family), strangers post
 * to it, and the wall - which is behind NAT, on a laptop, possibly on a phone
 * hotspot, possibly switched off - DIALS OUT to it and pulls.
 *
 * That direction is the whole design:
 *
 *   - The wall never accepts a connection. Its loopback-only binding, which
 *     Web Serial requires and which keeps the console off the network, stays.
 *   - A guest who posts while the wall is rebooting is not refused and does not
 *     lose the drawing: it queues, and the wall pulls it when it is back. The
 *     party does not depend on the laptop being healthy.
 *   - Two-way: the owner's own posts go up, so the relay's gallery and the
 *     wall's gallery are the same gallery, from whichever side you stand.
 *
 * ## What this server is NOT
 *
 * It serves THREE files, listed in STATIC below, and nothing else. Not the
 * console, not the control page, not the wall's state, not the drawing list.
 * The guest page's capability boundary has always been its module graph - here
 * the graph is also the file list, so the relay cannot serve app.js even by
 * accident, and there is no /content to read and no /drawings to enumerate.
 *
 * It has no wall in it. It is a queue with a gate.
 *
 * ## The gate
 *
 * Same guards as the wall's server, same code (core/guards.js), keyed on what
 * this topology can actually vouch for: the real IP (from X-Forwarded-For,
 * because Caddy is a real proxy and --trusted-proxy says so) AND the page's
 * device token. Per-address alone would be one global limit behind a proxy:
 * the first drawing at the party would lock the room out.
 *
 *   node relay/server.js --port 8080 --data /data/drawings.json \
 *     [--trusted-proxy] [--owner-token <hex>] [--wall-key <hex>] \
 *     [--rate-spacing <ms>] [--rate-burst <n>] [--rate-window <ms>] [--max-drawings <n>]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isPixelHex } from '../core/drawings.js';
import { DrawingStore } from '../core/drawing-store.js';
import { clientAddr, deviceKey, makeAuth, makeRateGate, resolveToken, safeEqual } from '../core/guards.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);

function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : dflt;
}

function flagNumber(name, dflt) {
  const raw = flag(name, null);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`relay: ${name} needs a non-negative integer, got ${raw}`);
    process.exit(2);
  }
  return n;
}

// Environment is the container's voice; flags are the operator's. A Docker
// Compose file reads better with RELAY_DATA / RELAY_TRUSTED_PROXY than with a
// command line, and the two must not disagree in silence.
const env = (n) => (process.env[n] ?? '').trim();

const PORT = flagNumber('--port', Number(env('RELAY_PORT') || 8080));
const HOST = flag('--host', env('RELAY_HOST') !== '' ? env('RELAY_HOST') : '127.0.0.1');
const DATA = flag('--data', env('RELAY_DATA') !== '' ? env('RELAY_DATA') : join(ROOT, 'data', 'relay-drawings.json'));
const TRUST_PROXY = argv.includes('--trusted-proxy') || env('RELAY_TRUSTED_PROXY') === '1';

const store = new DrawingStore(DATA).load();
const rate = makeRateGate({
  spacingMs: flagNumber('--rate-spacing', 10_000),
  burst: flagNumber('--rate-burst', 6),
  windowMs: flagNumber('--rate-window', 60_000),
  maxEntries: flagNumber('--max-drawings', 0), // 0 = no cap: the owner clears it
});

/**
 * Two gates per post, because behind a proxy the two jobs are different jobs.
 *
 * The DEVICE gate is the politeness limit: one guest, one drawing at a time.
 * The ADDRESS gate is flood control on a whole network. Behind Caddy every
 * phone in the room arrives from one address, so if the address gate carried
 * the politeness limit, a party of twenty would be one drawing per ten seconds
 * for everybody - the exact failure the device token exists to remove. So the
 * address gate is deliberately loose: it stops a script, not a guest.
 */
const deviceGate = makeRateGate({
  spacingMs: flagNumber('--rate-spacing', 10_000),
  burst: flagNumber('--rate-burst', 6),
  windowMs: flagNumber('--rate-window', 60_000),
  maxEntries: 0,
});
const addrGate = makeRateGate({
  // No spacing at all: a room of twenty phones is one address, and a spacing
  // limit here is a limit on the room. The burst is the flood control - a
  // script exhausts it in seconds, a queue of guests never does.
  spacingMs: flagNumber('--addr-spacing', 0),
  burst: flagNumber('--addr-burst', 40),
  windowMs: flagNumber('--rate-window', 60_000),
  maxEntries: 0,
});

const owner = resolveToken({ argv, flag: '--owner-token', env: 'WALL_OWNER_TOKEN', file: join(dirname(DATA), 'owner-token.txt') });
const wall = resolveToken({ argv, flag: '--wall-key', env: 'WALL_RELAY_KEY', file: join(dirname(DATA), 'wall-key.txt') });
const auth = makeAuth(owner.token);

/**
 * The three files this server will hand out, and the URL each one answers to.
 *
 * web/public.html imports '../core/drawings.js' and './draw-editor.js'. Served
 * at `/`, those resolve to /core/drawings.js and /draw-editor.js - which is
 * exactly this table, and nothing more.
 */
const STATIC = new Map([
  ['/', { file: join(ROOT, 'web', 'public.html'), type: 'text/html; charset=utf-8' }],
  // /index.html is deliberately NOT here. It is the wall's console, and a
  // public relay must not answer it: the console is the frame driver, the
  // serial panel and the gallery controls, and none of it belongs to a guest.
  ['/core/drawings.js', { file: join(ROOT, 'core', 'drawings.js'), type: 'text/javascript; charset=utf-8' }],
  ['/draw-editor.js', { file: join(ROOT, 'web', 'draw-editor.js'), type: 'text/javascript; charset=utf-8' }],
  // The table card. Not part of the wall, and not linked from the guest page
  // (a guest does not need it); it is the page you open once, on the machine
  // that serves the relay, and print. Its address line reads location.host,
  // so the paper cannot disagree with the server.
  ['/card.html', { file: join(ROOT, 'web', 'card.html'), type: 'text/html; charset=utf-8' }],
]);

function respond(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function text(res, status, msg) {
  respond(res, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, `${msg}\n`);
}

function json(res, status, obj) {
  respond(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The wall key: the only identity that can pull, push, or prune everything. */
function isWall(req) {
  return wall.token !== '' && typeof req.headers['x-wall-key'] === 'string' && safeEqual(req.headers['x-wall-key'], wall.token);
}

const MAX_POST = 8192; // a full 20x20 hex drawing is ~3.3 KB; more is not a drawing
const MAX_BATCH = 1 << 20; // a wall pushing a day of family pictures

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;
  const seg = path.split('/');

  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true, count: store.size, seq: store.seq });
    return;
  }

  const st = STATIC.get(path);
  if (st !== undefined) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      text(res, 405, 'method not allowed');
      return;
    }
    let body;
    try {
      body = readFileSync(st.file);
    } catch {
      text(res, 500, 'the page is not installed on this relay');
      return;
    }
    respond(res, 200, {
      'Content-Type': st.type,
      // The page is the thing a guest's phone must never run stale at a party:
      // no cache, so a deploy is visible on the next scan.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }, body);
    return;
  }

  // ---- the wall's sync channel: one key, two verbs ------------------------
  if (path === '/pull' && req.method === 'GET') {
    if (!isWall(req)) {
      text(res, 401, 'X-Wall-Key is required');
      return;
    }
    json(res, 200, store.since(Number(url.searchParams.get('since') ?? '0')));
    return;
  }

  if (path === '/push' && req.method === 'POST') {
    if (!isWall(req)) {
      text(res, 401, 'X-Wall-Key is required');
      return;
    }
    const raw = await readBody(req, MAX_BATCH);
    if (raw === null) {
      text(res, 413, 'batch too large');
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object') {
      text(res, 400, 'not JSON');
      return;
    }
    let added = 0;
    for (const e of Array.isArray(body.entries) ? body.entries : []) {
      if (e === null || typeof e !== 'object' || typeof e.id !== 'string') continue;
      if (store.has(e.id)) continue; // ids are the dedupe key: twice is once
      if (!isPixelHex(e.pixels)) continue;
      if (store.adopt({ id: e.id, name: e.name, pixels: e.pixels, createdAt: e.createdAt, origin: 'local' }) !== null) added += 1;
    }
    for (const id of Array.isArray(body.deleted) ? body.deleted : []) {
      if (typeof id === 'string') store.remove(id);
    }
    json(res, 200, { added, cursor: store.seq, count: store.size });
    return;
  }

  // ---- the guest surface: exactly what web/public.html calls --------------
  if (path === '/drawings' && req.method === 'POST') {
    // The gate runs BEFORE the body is read: a refusal must not make the server
    // absorb 3.3 KB it is about to throw away.
    const isOwner = auth.isOwner(req);
    const ip = clientAddr(req, { trustProxy: TRUST_PROXY });
    const device = deviceKey(req);
    const gates = isOwner ? [{ ok: true }]
      : [deviceGate.check(`d:${device}`), addrGate.check(`a:${ip}`)];
    const refused = gates.find((g) => !g.ok);
    if (refused !== undefined) {
      const secs = Math.max(1, Math.ceil(refused.retryMs / 1000));
      respond(res, 429, {
        'Retry-After': String(secs),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      }, `${refused.why} - try again in ${secs} s\n`);
      return;
    }
    if (!isOwner && rate.maxEntries > 0 && store.size >= rate.maxEntries) {
      // 507: the honest answer to a full gallery is "full", not "saved".
      text(res, 507, 'the gallery is full - ask the owner to clear it');
      return;
    }
    const raw = await readBody(req, MAX_POST);
    if (raw === null) {
      text(res, 413, 'drawing too large');
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object' || !isPixelHex(body.pixels)) {
      text(res, 400, 'not a legal drawing');
      return;
    }
    const e = store.add(body.name, body.pixels, 'guest');
    // The creator's undo token, served ONCE, here and nowhere else.
    json(res, 200, { id: e.id, name: e.name, createdAt: e.createdAt, secret: e.secret });
    return;
  }

  if (seg[1] === 'drawings' && seg[2] !== undefined && req.method === 'DELETE') {
    const id = seg[2];
    const entry = store.byId(id);
    // Auth BEFORE the lookup is reported: a stranger must not learn which ids
    // exist by watching 403 turn into 404.
    const isOwner = auth.isOwner(req);
    if (!isOwner && (entry === null || !auth.opens(entry)(req))) {
      text(res, entry === null ? 404 : 403, entry === null ? 'no such drawing' : 'that token does not open this entry');
      return;
    }
    if (entry === null) {
      text(res, 404, 'no such drawing');
      return;
    }
    store.remove(id);
    json(res, 200, { id, removed: true, cursor: store.seq });
    return;
  }

  text(res, 404, `404 Not Found: ${path}`);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    // A relay that dies mid-party is the failure this whole file exists to
    // avoid: one broken request answers 500 and keeps serving.
    console.error(`relay: ${req.method} ${req.url} -> ${err.message}`);
    if (!res.headersSent) text(res, 500, 'relay error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`LED wall relay: http://${HOST}:${PORT}/`);
  console.log(`relay: gallery ${store.size} drawings, cursor ${store.seq}, data ${DATA}`);
  console.log(`relay: guests are gated per device AND per address (${TRUST_PROXY ? 'X-Forwarded-For, as configured behind a proxy' : 'socket address, no proxy trusted'})`);
  console.log(`relay: politeness ${deviceGate.spacingMs / 1000} s / burst ${deviceGate.burst} per device;`
    + ` flood ${addrGate.spacingMs / 1000} s / burst ${addrGate.burst} per network`
    + (rate.maxEntries > 0 ? `; cap ${rate.maxEntries} entries` : '; no gallery cap'));
  if (wall.token !== '') {
    console.log(`relay: the wall pairs with ${wall.file ? `the key in ${wall.file}` : 'the --wall-key you passed'}`);
  } else {
    console.log('relay: no wall key - sync endpoints are closed, guests can still post');
  }
  if (owner.token !== '') {
    console.log(`relay: owner token ${owner.file ? `in ${owner.file}` : 'from the environment'} (prunes the gallery)`);
  }
  console.log(`relay: scan https://wall.hoa.family/ at the party${PORT === 443 ? '' : ` (behind Caddy, which terminates TLS)`}`);
});

// A key generated on this run is printed once, so it can be copied to the
// laptop. A key that already existed is NOT printed: this box is reachable from
// the internet, and its log is not a secret store.
if (wall.fresh) {
  console.log(`relay: generated the wall key: ${wall.token}${wall.file === null ? '' : ` (saved to ${wall.file})`}`);
}

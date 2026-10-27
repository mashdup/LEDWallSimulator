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
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isPixelHex } from '../core/drawings.js';
import { DrawingStore } from '../core/drawing-store.js';
import { parseMessage } from '../core/content-protocol.js';
import { makeConsole } from './console.js';
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

/**
 * The host that gets the console role (see relay/console.js for why the role is
 * a Host and not a path prefix). Empty means no console anywhere: the relay
 * stays the guest queue it always was.
 */
const CONSOLE_HOST = (flag('--console-host', env('RELAY_CONSOLE_HOST')) || '').toLowerCase();

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
 * The sign-in gate: a token is 32 hex characters and guessing it is hopeless,
 * but a bot can still hammer the form, so the door is rate-limited per address.
 * Same shared gate as everything else in this file.
 */
const loginGate = makeRateGate({ spacingMs: 0, burst: 10, windowMs: 60_000, maxEntries: 0 });

const clientIp = (req) => clientAddr(req, { trustProxy: TRUST_PROXY });

const consoleRole = makeConsole({
  token: owner.token,
  webRoot: join(ROOT, 'web'),
  coreRoot: join(ROOT, 'core'),
  log: (m) => console.log(m),
  api: (req, res, url, path) => consoleApi(req, res, url, path),
});

/** The wall's last visit, for the console: "the queue is being fed". */
const seen = { wall: 0 };

/**
 * The content state, in memory.
 *
 * Deliberately not on disk: the gallery is user data, this is the state of a
 * running wall. A relay restart loses the cadence command, and the wall's own
 * server still holds the truth - it is the one that pushes. No /capture here:
 * that route launches a headless Chromium, which is a Node job on the wall, and
 * the app tab is the frame driver.
 */
const content = { rev: 0, at: Date.now(), state: { v: 1, kind: 'demo' } };
const frame = { png: null, at: 0, hash: '' };

/**
 * The console's API: the same routes the console uses on the wall's own server,
 * answered here because in this topology there is no local server to answer
 * them. Reached only through relay/console.js's role handler, which means only
 * with a valid session - so unlike the wall's loopback server, these need no
 * per-route auth of their own: there is exactly one door.
 */
async function consoleApi(req, res, url, path) {
  const seg = path.split('/');

  if (path === '/content' && req.method === 'GET') {
    // `at` is the CURRENT time, not the last POST: renderers rebase their clock
    // on every poll, so a POST-time `at` would snap every animation back to the
    // moment of the last command - a sawtooth clock.
    json(res, 200, { ...content, at: Date.now(), gallery: store.schedule(content.state) });
    return true;
  }

  if (path === '/content' && req.method === 'POST') {
    const raw = await readBody(req, MAX_POST);
    if (raw === null) {
      text(res, 413, 'content command too large');
      return true;
    }
    let m;
    try {
      m = parseMessage(JSON.parse(raw));
    } catch {
      m = null;
    }
    if (m === null) {
      text(res, 400, 'not a legal content command');
      return true;
    }
    content.rev += 1;
    content.at = Date.now();
    content.state = m;
    json(res, 200, content);
    return true;
  }

  if (path === '/content/frame' && req.method === 'POST') {
    // The app tab pushes PNG at up to 30 fps when it drives the frames. This
    // is the same contract as the wall's own server: latest wins, no queue.
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_FRAME) {
        req.destroy();
        text(res, 413, 'frame too large');
        return true;
      }
      chunks.push(chunk);
    }
    const png = Buffer.concat(chunks);
    frame.png = png;
    frame.at = Date.now();
    frame.hash = createHash('sha1').update(png).digest('hex').slice(0, 12);
    json(res, 200, { bytes: png.length, hash: frame.hash });
    return true;
  }

  if (path === '/content/frame' && req.method === 'GET') {
    if (frame.png === null) {
      text(res, 404, 'no frame pushed yet');
      return true;
    }
    respond(res, 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Capture-Hash': frame.hash,
      'X-Capture-Ms': String(Date.now() - frame.at),
    }, frame.png);
    return true;
  }

  if (path === '/drawings' && req.method === 'GET') {
    // The console's gallery list. Unlike the guest host - which answers 404 for
    // this, so a stranger cannot enumerate the gallery - here a session has
    // been proven, and draw.html needs the list to show what will cycle.
    json(res, 200, store.metas());
    return true;
  }

  if (path === '/drawings' && req.method === 'POST') {
    // The owner saving a drawing from draw.html, on the console host. A session
    // is the owner, so the guards are lifted exactly as X-Wall-Owner lifts them
    // on the wall's own server: no rate gate, no gallery cap.
    const raw = await readBody(req, MAX_POST);
    if (raw === null) {
      text(res, 413, 'drawing too large');
      return true;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (body === null || typeof body !== 'object' || !isPixelHex(body.pixels)) {
      text(res, 400, 'not a legal drawing');
      return true;
    }
    const e = store.add(body.name, body.pixels, 'local');
    json(res, 200, { id: e.id, name: e.name, createdAt: e.createdAt, secret: e.secret });
    return true;
  }

  if (seg[1] === 'drawings' && seg[2] !== undefined) {
    const entry = store.byId(seg[2]);
    if (req.method === 'GET') {
      if (entry === null) {
        text(res, 404, 'no such drawing');
        return true;
      }
      json(res, 200, DrawingStore.publicEntry(entry));
      return true;
    }
    if (req.method === 'DELETE') {
      // A session IS the owner: this is the token path of the wall's own
      // server, with a cookie standing in for X-Wall-Owner.
      if (entry === null) {
        text(res, 404, 'no such drawing');
        return true;
      }
      store.remove(entry.id);
      json(res, 200, { id: entry.id, removed: true, cursor: store.seq });
      return true;
    }
  }

  if (path === '/relay' && req.method === 'GET') {
    // What the console's relay line means HERE: the wall is the one that dials
    // out, so the question is "when did it last visit?". A stale number is the
    // signal that the laptop is asleep or off the hotspot, and the queue is
    // growing without a wall to show it.
    json(res, 200, {
      enabled: wall.token !== '',
      url: '',
      lastError: null,
      syncedAt: seen.wall,
      sent: 0,
      cursor: store.seq,
      count: store.size,
      wallSeenAt: seen.wall,
    });
    return true;
  }

  if (path === '/serial' && req.method === 'GET') {
    // There is no Node serial port on this machine: the wall's ESP32 is plugged
    // into the laptop, and the browser talks to it directly. An empty list is
    // the honest answer, and the console already treats it as "nothing to warn
    // about" rather than as a failure.
    json(res, 200, []);
    return true;
  }

  return false;
}

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
const MAX_FRAME = 1 << 20; // one 400x400 PNG; a frame that is not that is not a frame

/**
 * Is this request for the console role?
 *
 * The Host header, because the console imports './app.js' and '../core/x.js':
 * mounted at a path prefix, every one of those resolves outside the mount and
 * the page 404s its own brain. A dedicated host serves the page at / and the
 * module graph resolves unchanged - and the guest host, which is what the QR
 * code points at, gains no console route at all.
 */
function wantsConsole(req) {
  if (CONSOLE_HOST === '') return false;
  const host = String(req.headers.host ?? '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === CONSOLE_HOST;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;
  const seg = path.split('/');

  // ---- the two roles -----------------------------------------------------
  // The console host gets the console (and its API) and nothing else; every
  // other host gets the guest surface. The split is the Host header, so the
  // guest host cannot reach a console route even by guessing its path.
  if (wantsConsole(req)) {
    await consoleRole.handle(req, res, url, {
      text, json, respond, readBody, clientIp, loginGate,
    });
    return;
  }

  // Any other host: the guest surface, and no console routes at all.
  if (CONSOLE_HOST !== '' && (path === '/login' || path === '/logout')) {
    text(res, 404, '404 Not Found');
    return;
  }

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
    // The diet: every pull is the wall saying "I am here", which is the only
    // way this machine can know. The console shows it as a staleness number.
    seen.wall = Date.now();
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
    console.log(`relay: owner token ${owner.file ? `in ${owner.file}` : 'from the environment'} (prunes the gallery, signs in the console)`);
  }
  if (CONSOLE_HOST === '') {
    console.log('relay: console off (no --console-host): this relay is the guest queue only');
  } else if (owner.token === '') {
    console.log(`relay: WARNING ${CONSOLE_HOST} is configured but there is no owner token - the console refuses everyone`);
  } else {
    console.log(`relay: console at https://${CONSOLE_HOST}/ - sign in with the owner token, 12 h per sign-in`);
  }
  console.log(`relay: scan https://wall.hoa.family/ at the party${PORT === 443 ? '' : ` (behind Caddy, which terminates TLS)`}`);
});

// A key generated on this run is printed once, so it can be copied to the
// laptop. A key that already existed is NOT printed: this box is reachable from
// the internet, and its log is not a secret store.
if (wall.fresh) {
  console.log(`relay: generated the wall key: ${wall.token}${wall.file === null ? '' : ` (saved to ${wall.file})`}`);
}

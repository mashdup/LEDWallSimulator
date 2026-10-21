/**
 * The console, published: the wall's control page, served over HTTPS behind a
 * session, so the wall laptop needs no local server — it opens a URL and
 * connects the serial port.
 *
 * ## Why this is possible at all
 *
 * The Node server is NOT in the frame path. The browser generates the frames
 * and hands them to navigator.serial itself (web/sinks.js is browser APIs
 * only), and HTTPS is a secure context, so a page served from
 * https://wall-console.hoa.family gets navigator.serial exactly as
 * http://127.0.0.1:8080 does. COM8 belongs to the browser, not to the server.
 *
 * ## Why it needs a session, and why that session is the whole job
 *
 * The console was written for one machine: its own. It has no auth, because
 * "who is allowed to drive the wall" was answered by the loopback bind. Publish
 * it and the wall is world-controllable — and the name will be on printed cards
 * next to the guest URL, so guests WILL find it. So nothing here is served to an
 * anonymous request: not the page, not app.js, not the content state, not the
 * gallery list. The login is the owner token, and the session cookie is what
 * lifts the guards, exactly as X-Wall-Owner does on the wall's own server.
 *
 * SameSite=Strict + HttpOnly + Secure is the CSRF story: a cross-site request
 * carries no cookie, so a stranger's page cannot drive the wall. There is no
 * CSRF token to forget, and no CORS surface at all.
 *
 * ## The role is the Host header, not a path prefix
 *
 * The console imports './app.js' and '../core/x.js'. Mount it at /console and
 * every one of those relative specifiers resolves outside the mount, so the
 * page would 404 its own brain. A dedicated host serves the page at / and the
 * whole module graph resolves unchanged — and the guest host, which is what the
 * QR code points at, gains no console routes at all: the boundary is which
 * request the role handler ever sees.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'wall_session';

/** Extensions the console will hand out. Everything else is a 404, not a download. */
const CONSOLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.ico']);

/**
 * Map a console URL onto a file, or null when the request is not allowed.
 *
 * `/core/<name>.js` is core/, everything else is web/ — which is how the page's
 * own imports resolve. The name is validated, not joined: no '..' segment, no
 * NUL, no Windows drive letter, no character outside [A-Za-z0-9._-] and '/'.
 * A whitelist of extensions means a path that survives all of that is still
 * only ever source, never a key file.
 */
export function consoleFile(webRoot, coreRoot, pathname) {
  const rel = pathname.startsWith('/core/') ? pathname.slice('/core/'.length) : pathname;
  const root = pathname.startsWith('/core/') ? coreRoot : webRoot;
  if (rel === '' || rel.includes('\0') || rel.includes('..')) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(rel)) return null;
  const ext = extname(rel).toLowerCase();
  if (!CONSOLE_EXT.has(ext)) return null;
  const file = join(root, rel);
  // join() normalises, so a traversal that survived the checks above lands
  // outside the root; the prefix test is the one that has to hold.
  const a = file.replace(/\\/g, '/');
  const b = root.replace(/\\/g, '/');
  return a === b || a.startsWith(`${b}/`) ? file : null;
}

/**
 * @param {object} o
 * @param {string} o.token the owner token: the only credential that signs in.
 *        Empty means the console is OFF — an unauthenticated console is not a
 *        configuration, it is an exposure.
 * @param {(msg: string) => void} [o.log]
 */
export function makeConsole({ token, webRoot, coreRoot, api = null, log = () => {} }) {
  /** session id -> expiry timestamp (ms). In memory: a restart signs everyone
   *  out, which is the safe direction for a credential that drives a wall. */
  const sessions = new Map();
  const enabled = token !== '';

  function sweep() {
    const now = Date.now();
    for (const [id, at] of sessions) if (at <= now) sessions.delete(id);
  }

  function sessionId(req) {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }

  function authed(req) {
    if (!enabled) return false;
    const id = sessionId(req);
    if (typeof id !== 'string' || id.length < 16) return false;
    const at = sessions.get(id);
    return at !== undefined && at > Date.now();
  }

  function signIn() {
    sweep();
    const id = randomBytes(24).toString('hex');
    sessions.set(id, Date.now() + SESSION_MS);
    return id;
  }

  function signOut(req) {
    const id = sessionId(req);
    if (id !== null) sessions.delete(id);
  }

  const cookieFor = (id) =>
    `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
  const deadCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

  /** Constant-time compare, length-guarded (timingSafeEqual throws on a mismatch). */
  function tokenOk(given) {
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(token));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>wall · console</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#14121a;
         color:#f4f1ee; font:500 16px/1.4 system-ui, "Segoe UI", sans-serif; }
  form { width: min(92vw, 360px); background:#1d1a24; border:1px solid #3a3446;
         border-radius:14px; padding:26px 22px; }
  h1 { font-size:17px; margin:0 0 4px; letter-spacing:.02em; }
  p  { font-size:13px; opacity:.62; margin:0 0 18px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:9px;
          border:1px solid #4a4356; background:#14121a; color:#fff;
          font:500 15px ui-monospace, Consolas, monospace; }
  button { width:100%; margin-top:12px; padding:11px; border:0; border-radius:9px;
           background:#ff3d81; color:#180a11; font:700 15px/1 system-ui, sans-serif;
           cursor:pointer; }
  .bad { color:#ff6b6b; font-size:13px; margin-top:12px; }
  .note { font-size:11.5px; opacity:.5; margin-top:16px; line-height:1.5; }
</style></head>
<body><form method="post" action="/login" autocomplete="off">
  <h1>wall console</h1>
  <p>The owner token signs in. Guests draw at the public page.</p>
  <input name="token" type="password" inputmode="text" spellcheck="false"
         autofocus placeholder="owner token" aria-label="owner token">
  <button type="submit">Sign in</button>
  <div class="note">Twelve hours per sign-in. The token is the one the wall's
  server prints at startup, and the relay keeps it in its data volume.</div>
</form></body></html>`;

  const OFF_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>console off</title><style>body{background:#14121a;color:#f4f1ee;
font:500 16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;
text-align:center}code{background:#1d1a24;padding:2px 6px;border-radius:5px}</style></head>
<body><div><p>The console is off on this relay.</p>
<p>It is served only when an owner token exists — an unauthenticated control
panel for a wall is not a configuration, it is an exposure.</p>
<p>Set <code>--owner-token</code> (or <code>WALL_OWNER_TOKEN</code>), or let the
relay generate one into its data volume.</p></div></body></html>`;

  async function handle(req, res, url, helpers) {
    const { text, json, respond, readBody, clientIp, loginGate } = helpers;
    const path = url.pathname;

    if (!enabled) {
      if (req.method === 'GET' && (path === '/' || path === '/login')) {
        respond(res, 403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, OFF_HTML);
        return;
      }
      text(res, 404, 'console off');
      return;
    }

    // ---- the door --------------------------------------------------------
    if (path === '/login' && req.method === 'GET') {
      respond(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, LOGIN_HTML);
      return;
    }
    if (path === '/login' && req.method === 'POST') {
      const g = loginGate.check(`a:${clientIp(req)}`);
      if (!g.ok) {
        const secs = Math.max(1, Math.ceil(g.retryMs / 1000));
        respond(res, 429, { 'Retry-After': String(secs), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          `too many sign-in attempts - try again in ${secs} s\n`);
        return;
      }
      const raw = await readBody(req, 4096);
      let given = '';
      const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : (raw ?? '');
      if (body.startsWith('{')) {
        try {
          given = String(JSON.parse(body).token ?? '');
        } catch { /* not json */ }
      } else {
        for (const pair of body.split('&')) {
          const i = pair.indexOf('=');
          if (i > 0 && decodeURIComponent(pair.slice(0, i)) === 'token') given = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        }
      }
      if (given === '' || !tokenOk(given)) {
        // One sentence, no detail: "is that a real token" is the question an
        // attacker is asking, and the answer must not be free.
        respond(res, 401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          LOGIN_HTML.replace('<div class="note">', '<div class="bad">that token did not work</div><div class="note">'));
        return;
      }
      const id = signIn();
      log(`console: signed in from ${clientIp(req)}`);
      respond(res, 303, { Location: '/', 'Set-Cookie': cookieFor(id), 'Cache-Control': 'no-store' }, '');
      return;
    }
    if (path === '/logout' && req.method === 'POST') {
      signOut(req);
      respond(res, 303, { Location: '/login', 'Set-Cookie': deadCookie, 'Cache-Control': 'no-store' }, '');
      return;
    }

    // ---- everything else is behind the door ------------------------------
    if (!authed(req)) {
      // HTML gets the door; everything the page fetches gets a 401, so a
      // session that expires mid-party is a visible failure and not a wall
      // that quietly stops answering.
      const wantsPage = req.method === 'GET' && (path === '/' || /\.html$/.test(path));
      if (wantsPage) {
        respond(res, 401, { Location: '/login', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, LOGIN_HTML);
        return;
      }
      text(res, 401, 'sign in: GET /login');
      return;
    }

    // The console's data routes. They live in relay/server.js because they are
    // about the store and the content state, but they are reached only through
    // here - which is to say, only with a session. There is exactly one door.
    if (api !== null && await api(req, res, url, path)) return;

    if (path === '/' ) {
      const file = consoleFile(webRoot, coreRoot, '/index.html');
      serve(file, res, helpers);
      return;
    }
    const file = consoleFile(webRoot, coreRoot, path);
    if (file === null) {
      text(res, 404, `404 Not Found: ${path}`);
      return;
    }
    serve(file, res, helpers);
  }

  function serve(file, res, { respond, text }) {
    if (file === null) {
      text(res, 404, 'not found');
      return;
    }
    let body;
    try {
      body = readFileSync(file);
    } catch {
      text(res, 404, 'not found');
      return;
    }
    const ext = extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
            : ext === '.svg' ? 'image/svg+xml'
              : ext === '.png' ? 'image/png'
                : 'application/octet-stream';
    // no-store on the console: a party must never open a cached console, and a
    // deploy is a restart, not a cache flush.
    respond(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body);
  }

  return {
    enabled,
    handle,
    get sessions() {
      sweep();
      return sessions.size;
    },
  };
}

/** A stable hash of the token, for logs: never the token itself. */
export function tokenHint(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

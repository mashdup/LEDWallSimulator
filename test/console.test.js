/**
 * The published console: the wall's control page served over HTTPS, behind a
 * session, so the wall laptop needs no local server.
 *
 * The suite is mostly about one property, because it is the property that makes
 * the feature safe to switch on: an anonymous request gets nothing. Not the
 * page, not app.js, not the content state, not the gallery list. Everything
 * else here is in service of proving that boundary is real rather than
 * intended - including the guest host, which must not answer a console route
 * even when asked for one by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { request } from 'node:http';

import { freePort, startRelay } from './harness.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

const hex = pixelsToHex(emptyPixels());
const OWNER = 'ownertoken0123456789abcdef';
const WALL_KEY = 'wallkey0123456789abcdef12';
const GUEST = 'wall.hoa.family';
const CONSOLE = 'wall-console.hoa.family';

/** A relay with a console host, plus the cookie jar a browser would keep. */
async function up(t, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-console-'));
  const port = await freePort();
  const relay = await startRelay(port, [
    '--data', join(dir, 'd.json'),
    '--owner-token', OWNER,
    '--wall-key', WALL_KEY,
    '--console-host', CONSOLE,
    '--rate-spacing', '0', '--rate-burst', '0', '--addr-spacing', '0', '--addr-burst', '0',
    ...args,
  ]);
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return { ...relay, port, dir };
}

/**
 * Send a request as if it arrived from a given Host.
 *
 * node:http, not fetch: undici ignores a caller-supplied `host` header (it
 * fills it in from the URL), so the role dispatch — which reads
 * req.headers.host and nothing else — would never see the console name. A raw
 * request is also what Caddy does, so this is the more truthful client.
 */
function at(relay, host, path, init = {}) {
  const headers = { ...(init.headers ?? {}), host };
  const body = init.body ?? null;
  if (body !== null && !('content-length' in headers)) {
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: relay.port, path, method: init.method ?? 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
          arrayBuffer: async () => buf,
          bytes: buf,
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** The session cookie out of a Set-Cookie header, or null. */
function cookieOf(res) {
  const raw = res.headers.get('set-cookie');
  // node:http hands multiple Set-Cookie headers back as an array.
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const one of list) {
    const m = /wall_session=([0-9a-f]+)/.exec(one);
    if (m !== null) return `wall_session=${m[1]}`;
  }
  return null;
}

/** Sign in and return the cookie. */
async function signIn(relay) {
  const res = await at(relay, CONSOLE, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${OWNER}`,
  });
  assert.equal(res.status, 303, 'a correct token is a redirect into the console');
  const cookie = cookieOf(res);
  assert.ok(cookie !== null, 'and it sets a session cookie');
  return cookie;
}

test('the console host is a different machine from the guest host', async (t) => {
  const relay = await up(t);

  // The guest host: the drawing page, and NOT the console.
  const page = await at(relay, GUEST, '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Put it on the wall|draw/i);

  // The console host: the login form, because nobody is signed in.
  const console_ = await at(relay, CONSOLE, '/');
  assert.equal(console_.status, 401, 'an anonymous request for the console gets the door, not the console');
  assert.match(await console_.text(), /owner token/i);

  // ...and the console routes do not exist on the guest host at all.
  for (const path of ['/login', '/logout']) {
    const r = await at(relay, GUEST, path);
    assert.equal(r.status, 404, `${path} must not exist on the host the QR code points at`);
  }
});

test('nothing is served to an anonymous request: not the page, not its modules, not its data', async (t) => {
  const relay = await up(t);

  // The console's static surface and every data route the page uses. Each one
  // is a real capability: app.js generates frames, /content changes what the
  // wall shows, /drawings lists the family's pictures.
  const paths = [
    '/app.js', '/app.css', '/sim.js', '/sinks.js', '/worker-clock.js',
    '/core/index.js', '/core/animations.js', '/core/content-protocol.js',
    '/draw.html', '/public.html', '/content.html', '/index.html',
    '/content', '/content/frame', '/drawings', '/relay', '/serial',
  ];
  for (const path of paths) {
    const r = await at(relay, CONSOLE, path);
    assert.equal(r.status, 401, `${path} must require a session (got ${r.status})`);
  }

  // And a POST is not a way around the door either.
  const post = await at(relay, CONSOLE, '/content', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, kind: 'fill', color: '#ff0000' }),
  });
  assert.equal(post.status, 401, 'a stranger cannot change what the wall shows');
});

test('the owner token signs in, and the session opens the console and its API', async (t) => {
  const relay = await up(t);

  // A wrong token is a 401 that says nothing useful, and no cookie.
  const bad = await at(relay, CONSOLE, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=not-the-token',
  });
  assert.equal(bad.status, 401);
  assert.equal(cookieOf(bad), null, 'a failed sign-in mints no session');
  assert.match(await bad.text(), /did not work/i);

  const cookie = await signIn(relay);

  // The console page, and the modules it imports: the whole graph resolves.
  const page = await at(relay, CONSOLE, '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<select id="sink"/, 'it is the console, not the guest page');
  for (const path of ['/app.js', '/core/index.js', '/core/animations.js', '/sim.js', '/sinks.js']) {
    const r = await at(relay, CONSOLE, path, { headers: { cookie } });
    assert.equal(r.status, 200, `${path} is served to a session`);
  }
  // The page's own imports resolve relative to the host root, which is exactly
  // why the role is a Host and not a path prefix.
  assert.match(html, /\.\/app\.js/, 'index.html imports ./app.js, so it must be served at /');

  // The content state: the console drives the wall with it.
  const state = await (await at(relay, CONSOLE, '/content', { headers: { cookie } })).json();
  assert.equal(state.state.kind, 'demo', 'a fresh relay starts at the demo');
  const posted = await at(relay, CONSOLE, '/content', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, kind: 'fill', color: '#ff0000' }),
  });
  assert.equal(posted.status, 200);
  const after = await (await at(relay, CONSOLE, '/content', { headers: { cookie } })).json();
  assert.equal(after.state.kind, 'fill');
  assert.equal(after.rev, 1);

  // Junk is refused by the same protocol gate the wall uses.
  const junk = await at(relay, CONSOLE, '/content', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, kind: 'nonsense' }),
  });
  assert.equal(junk.status, 400, 'the console cannot push a command the wall would refuse');
});

test('the frame channel is latest-wins, so the wall never shows a stale frame', async (t) => {
  const relay = await up(t);
  const cookie = await signIn(relay);

  const before = await at(relay, CONSOLE, '/content/frame', { headers: { cookie } });
  assert.equal(before.status, 404, 'no frame has been pushed yet');

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const push = await at(relay, CONSOLE, '/content/frame', {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png,
  });
  assert.equal(push.status, 200);

  const got = await at(relay, CONSOLE, '/content/frame', { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-type'), /image\/png/);
  assert.match(got.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

  const png2 = Buffer.from('00112233', 'hex');
  await at(relay, CONSOLE, '/content/frame', {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: png2,
  });
  const got2 = Buffer.from(await (await at(relay, CONSOLE, '/content/frame', { headers: { cookie } })).arrayBuffer());
  assert.deepEqual(got2, png2, 'latest wins');
});

test('a session is the owner: the gallery list, saving, and pruning', async (t) => {
  const relay = await up(t);
  const cookie = await signIn(relay);

  // A guest posts on the guest host, as a phone would.
  const posted = await at(relay, GUEST, '/drawings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wall-device': 'dev-g' },
    body: JSON.stringify({ name: 'Ada', pixels: hex }),
  });
  assert.equal(posted.status, 200);

  // The console lists it - which the guest host deliberately does not.
  const list = await (await at(relay, CONSOLE, '/drawings', { headers: { cookie } })).json();
  assert.deepEqual(list.map((e) => e.name), ['Ada']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'name'],
    'the list carries no pixels and no secret, even for the owner');
  assert.equal((await at(relay, GUEST, '/drawings')).status, 404,
    'and a stranger still cannot enumerate it');

  // The owner saves from draw.html: no rate gate, no cap, no token header -
  // the session is the credential.
  const saved = await at(relay, CONSOLE, '/drawings', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Family', pixels: hex }),
  });
  assert.equal(saved.status, 200, 'a session saves without a token header');
  const savedEntry = await saved.json();
  assert.ok(typeof savedEntry.secret === 'string', 'and still gets its own undo token');

  // Read one entry, then prune it.
  const one = await (await at(relay, CONSOLE, `/drawings/${savedEntry.id}`, { headers: { cookie } })).json();
  assert.equal(one.pixels, hex, 'the pixels cross intact');
  assert.equal(one.secret, undefined, 'and the secret never rides a GET');
  const del = await at(relay, CONSOLE, `/drawings/${savedEntry.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200, 'the owner prunes with the session');
  assert.deepEqual((await (await at(relay, CONSOLE, '/drawings', { headers: { cookie } })).json()).map((e) => e.name), ['Ada']);

  // An anonymous DELETE is not a DELETE.
  const anon = await at(relay, CONSOLE, `/drawings/${list[0].id}`, { method: 'DELETE' });
  assert.equal(anon.status, 401, 'no session, no prune');
});

test('the console reports when the wall last visited, because that is the only thing it can know', async (t) => {
  const relay = await up(t);
  const cookie = await signIn(relay);

  const before = await (await at(relay, CONSOLE, '/relay', { headers: { cookie } })).json();
  assert.equal(before.wallSeenAt, 0, 'a wall that has never pulled is a wall that has never visited');
  assert.equal(before.url, '', 'on this relay the console IS the relay: there is no relay URL to show');

  await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': WALL_KEY } });
  const after = await (await at(relay, CONSOLE, '/relay', { headers: { cookie } })).json();
  assert.ok(after.wallSeenAt > 0, 'a pull is the wall saying "I am here"');
  assert.equal(after.count, 0);
});

test('signing out ends the session, and a restart ends all of them', async (t) => {
  const relay = await up(t);
  const cookie = await signIn(relay);
  assert.equal((await at(relay, CONSOLE, '/', { headers: { cookie } })).status, 200);

  const out = await at(relay, CONSOLE, '/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.equal((await at(relay, CONSOLE, '/', { headers: { cookie } })).status, 401,
    'the old cookie is dead');
});

test('a relay with no owner token serves no console at all', async (t) => {
  // An unauthenticated control panel for a wall is not a configuration, it is
  // an exposure. Without a token the role refuses everyone, including a request
  // that presents the (empty) token.
  const dir = mkdtempSync(join(tmpdir(), 'omp-console-off-'));
  const port = await freePort();
  // Its own relay: `up()` already passes a token, and a second --owner-token
  // would be ignored (indexOf finds the first), which would make this test
  // assert the opposite of what it says.
  const relay = await startRelay(port, ['--data', join(dir, 'd.json'),
    '--owner-token', '', '--wall-key', WALL_KEY, '--console-host', CONSOLE,
    '--rate-spacing', '0', '--rate-burst', '0', '--addr-spacing', '0', '--addr-burst', '0']);
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  const base = { ...relay, port };
  const r = await at(base, CONSOLE, '/');
  assert.equal(r.status, 403, 'the console is off, and it says so');
  assert.match(await r.text(), /owner token/i);
  for (const path of ['/app.js', '/content', '/drawings']) {
    const x = await at(base, CONSOLE, path);
    assert.equal(x.status, 404, `${path} does not exist while the console is off`);
  }
  // The guest side is unaffected: the party can still draw.
  const page = await at(base, GUEST, '/');
  assert.equal(page.status, 200);
});

test('a relay with no console host keeps its old surface exactly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-noconsole-'));
  const port = await freePort();
  const relay = await startRelay(port, ['--data', join(dir, 'd.json'), '--owner-token', OWNER,
    '--wall-key', WALL_KEY, '--rate-spacing', '0', '--rate-burst', '0', '--addr-spacing', '0', '--addr-burst', '0']);
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });

  // No --console-host: every host is a guest host, and /login does not exist.
  assert.equal((await fetch(`${relay.base}/`)).status, 200);
  assert.equal((await fetch(`${relay.base}/login`)).status, 404);
  assert.equal((await fetch(`${relay.base}/app.js`)).status, 404);
  assert.equal((await fetch(`${relay.base}/content`)).status, 404);
});

test('the console cannot be walked out of with a path', async (t) => {
  const relay = await up(t);
  const cookie = await signIn(relay);

  // The traversal shapes worth trying, including the ones a Windows server
  // would honour: encoded dots, backslashes, an absolute path, and the key
  // files the relay keeps beside its data.
  const attempts = [
    '/core/../../data/wall-key.txt',
    '/../data/wall-key.txt',
    '/..%2fdata%2fwall-key.txt',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..\\data\\wall-key.txt',
    '/core/%00.js',
    '/data/wall-key.txt',
    '/wall-key.txt',
    '/owner-token.txt',
  ];
  for (const path of attempts) {
    const r = await at(relay, CONSOLE, path, { headers: { cookie } });
    assert.ok(r.status === 404 || r.status === 400,
      `${path} must not be served (got ${r.status})`);
    const body = await r.text();
    assert.ok(!/wall-key\.txt|owner-token/i.test(body) || !/[0-9a-f]{32}/.test(body),
      `${path} must not leak a key`);
  }
});

test('same-site strict, http-only: the cookie is not a CSRF hole', async (t) => {
  const relay = await up(t);
  const res = await at(relay, CONSOLE, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${OWNER}`,
  });
  const raw = [res.headers.get('set-cookie')].flat().join(' | ');
  assert.match(raw, /HttpOnly/, 'script cannot read the session');
  assert.match(raw, /Secure/, 'it never travels in clear');
  assert.match(raw, /SameSite=Strict/, 'a cross-site request carries no cookie, so no CSRF token is needed');
  assert.match(raw, /Path=\//);
});

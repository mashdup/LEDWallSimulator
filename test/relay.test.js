import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startRelay, postJson } from './harness.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

/**
 * The public relay: a queue with a gate, and the gate is the test.
 *
 * The relay is the first part of this project that a stranger reaches over the
 * internet. Everything worth pinning is about that: what a stranger can do, what
 * a stranger can learn, and what happens to a party of 200 phones when the only
 * identity they share is one proxy address.
 */

const hex = pixelsToHex(emptyPixels());

async function up(t, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-relay-'));
  const port = await freePort();
  const relay = await startRelay(port, ['--data', join(dir, 'd.json'), ...args]);
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return relay;
}

const post = (base, body, headers) => postJson(`${base}/drawings`, body, headers);

test('a guest posts, gets its entry back, and gets the takeback token exactly once', async (t) => {
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0']);
  const r = await post(relay.base, { name: 'Ada', pixels: hex }, { 'x-wall-device': 'dev-a' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Ada');
  assert.match(r.json.secret, /^[0-9a-f]{20}$/, 'the entry secret is the creator token');

  // The relay serves no list: a stranger cannot enumerate the gallery, and so
  // cannot harvest names, ids, or (two requests later) anybody's delete token.
  const list = await fetch(`${relay.base}/drawings`);
  assert.equal(list.status, 404, 'GET /drawings does not exist on the public side');
  const one = await fetch(`${relay.base}/drawings/${r.json.id}`);
  assert.equal(one.status, 404, 'and neither does GET /drawings/<id>');

  // Takeback works with the secret, and nothing else does.
  const ok = await fetch(`${relay.base}/drawings/${r.json.id}`, {
    method: 'DELETE', headers: { 'x-wall-delete': r.json.secret },
  });
  assert.equal(ok.status, 200);
  const again = await fetch(`${relay.base}/drawings/${r.json.id}`, {
    method: 'DELETE', headers: { 'x-wall-delete': r.json.secret },
  });
  assert.equal(again.status, 404, 'a deleted entry is gone, not deletable twice');
});

test('the gate is per device, not per proxy address', async (t) => {
  // 10 s spacing. Behind Caddy every guest in the room is one address, so a
  // per-address gate is one global gate: the first drawing locks the party out.
  const relay = await up(t, ['--rate-spacing', '10000', '--rate-burst', '0', '--trusted-proxy']);
  const a = await post(relay.base, { name: 'one', pixels: hex }, {
    'x-wall-device': 'dev-1', 'x-forwarded-for': '203.0.113.9',
  });
  assert.equal(a.status, 200, 'the first guest posts');
  const b = await post(relay.base, { name: 'two', pixels: hex }, {
    'x-wall-device': 'dev-2', 'x-forwarded-for': '203.0.113.9',
  });
  assert.equal(b.status, 200, 'and the guest beside them posts too: same address, different device');
  const c = await post(relay.base, { name: 'three', pixels: hex }, {
    'x-wall-device': 'dev-1', 'x-forwarded-for': '203.0.113.9',
  });
  assert.equal(c.status, 429, 'the same device twice in a row is the thing that is limited');
  assert.match(c.headers.get('retry-after'), /^\d+$/, 'and the refusal carries the pause the page obeys');
});

test('X-Forwarded-For is believed only when a proxy was declared', async (t) => {
  // No --trusted-proxy: the socket is the identity, and a typed header changes
  // nothing. This is the case where XFF is forged by exactly the client the
  // limit exists for.
  const relay = await up(t, ['--rate-spacing', '10000', '--rate-burst', '0']);
  const first = await post(relay.base, { name: 'one', pixels: hex }, {
    'x-wall-device': 'shared', 'x-forwarded-for': '2001:db8::1',
  });
  assert.equal(first.status, 200);
  const second = await post(relay.base, { name: 'two', pixels: hex }, {
    'x-wall-device': 'shared', 'x-forwarded-for': '2001:db8::2',
  });
  assert.equal(second.status, 429, 'two forged addresses, one device: the device gate is real without a proxy');
});

test('the owner token lifts the gate, and a wrong token is not the owner', async (t) => {
  const relay = await up(t, ['--rate-spacing', '10000', '--rate-burst', '0', '--owner-token', 'deadbeef']);
  for (let i = 0; i < 4; i++) {
    const r = await post(relay.base, { name: `scan ${i}`, pixels: hex }, {
      'x-wall-owner': 'deadbeef', 'x-wall-device': 'owner-laptop',
    });
    assert.equal(r.status, 200, `the owner posts ${i + 1} in a row: the guards are for strangers`);
  }
  const stranger = await post(relay.base, { name: 'me too', pixels: hex }, {
    'x-wall-owner': 'nope', 'x-wall-device': 'guest',
  });
  assert.equal(stranger.status, 200, 'a wrong owner header is just a guest, not a key');
  const blocked = await post(relay.base, { name: 'again', pixels: hex }, { 'x-wall-device': 'guest' });
  assert.equal(blocked.status, 429, 'and the guest gate still applies to them');
});

test('the wall pulls with its key, and a guest cannot read the gallery', async (t) => {
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0', '--wall-key', 'wallkey1']);
  await post(relay.base, { name: 'Ada', pixels: hex }, { 'x-wall-device': 'dev-a' });

  const noKey = await fetch(`${relay.base}/pull?since=0`);
  assert.equal(noKey.status, 401, 'pull is not a public endpoint');
  const wrong = await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey2' } });
  assert.equal(wrong.status, 401);

  const r = await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey1' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].name, 'Ada');
  assert.equal(j.entries[0].pixels, hex, 'the wall needs the pixels; a guest never sees this call');
  assert.equal(j.entries[0].secret, undefined, 'and the pull never carries the creator token');
  assert.ok(Number.isInteger(j.cursor));

  // The cursor is the whole sync story: asking again from it yields nothing.
  const next = await (await fetch(`${relay.base}/pull?since=${j.cursor}`, { headers: { 'x-wall-key': 'wallkey1' } })).json();
  assert.deepEqual(next.entries, [], 'a pull from the cursor is empty until something happens');
});

test('two-way: the wall pushes its own pictures, and ids are the dedupe key', async (t) => {
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0', '--wall-key', 'wallkey1']);
  const entry = { id: 'owner-1', name: 'Family', pixels: hex, createdAt: Date.now() };
  const r = await postJson(`${relay.base}/push`, { entries: [entry] }, { 'x-wall-key': 'wallkey1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 1);

  const again = await postJson(`${relay.base}/push`, { entries: [entry] }, { 'x-wall-key': 'wallkey1' });
  assert.equal(again.json.added, 0, 'the same drawing pushed twice is one drawing');
  assert.equal((await (await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey1' } })).json()).count, 1);

  // Junk from a paired wall is dropped, not stored: the pairing key is not a
  // licence to write nonsense into the gallery.
  const junk = await postJson(`${relay.base}/push`, { entries: [{ id: 'x-1', name: 'junk', pixels: 'zz' }] }, { 'x-wall-key': 'wallkey1' });
  assert.equal(junk.json.added, 0);

  const noKey = await postJson(`${relay.base}/push`, { entries: [entry] });
  assert.equal(noKey.status, 401, 'push is not a public endpoint');
});

test('a delete becomes a tombstone the wall can see, on both sides', async (t) => {
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0', '--wall-key', 'wallkey1']);
  const posted = await post(relay.base, { name: 'Ada', pixels: hex }, { 'x-wall-device': 'dev-a' });
  const before = await (await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey1' } })).json();

  const del = await fetch(`${relay.base}/drawings/${posted.json.id}`, {
    method: 'DELETE', headers: { 'x-wall-delete': posted.json.secret },
  });
  assert.equal(del.status, 200);

  const after = await (await fetch(`${relay.base}/pull?since=${before.cursor}`, { headers: { 'x-wall-key': 'wallkey1' } })).json();
  assert.deepEqual(after.deleted.map((d) => d.id), [posted.json.id], 'the wall is told what to remove');
  assert.equal(after.entries.length, 0);

  // The wall deleting locally: push the id, and the relay forgets it too.
  const pushed = await postJson(`${relay.base}/push`, { deleted: [after.deleted[0].id] }, { 'x-wall-key': 'wallkey1' });
  assert.equal(pushed.status, 200);
  const last = await (await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey1' } })).json();
  assert.equal(last.count, 0, 'the gallery is one gallery, from either side');
});

test('the public surface is the guest page and its modules, and the relay is not the wall', async (t) => {
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0']);
  for (const [path, type] of [['/', 'text/html'], ['/core/drawings.js', 'text/javascript'], ['/draw-editor.js', 'text/javascript'], ['/card.html', 'text/html']]) {
    const r = await fetch(`${relay.base}${path}`);
    assert.equal(r.status, 200, `${path} is served`);
    assert.match(r.headers.get('content-type'), new RegExp(type));
  }
  // The card is the one page a guest never opens, and it must not reach the
  // wall either: it is paper, and a page with no fetches has nothing to abuse.
  const card = await (await fetch(`${relay.base}/card.html`)).text();
  assert.ok(!/fetch\(/.test(card), 'the printed card asks the server for nothing');
  // The capability boundary is the file list: the console, the control page,
  // the wall's state and the drawing list are not on this server at all.
  for (const path of ['/index.html?wall=1', '/control.html', '/app.js', '/content', '/drawings', '/capture', '/content/frame']) {
    const r = await fetch(`${relay.base}${path}`);
    assert.ok(r.status === 404 || r.status === 405, `${path} must not exist on a public relay (got ${r.status})`);
  }
  const page = await (await fetch(`${relay.base}/`)).text();
  assert.match(page, /core\/drawings\.js/, 'the page the relay serves is the guest page');
  // The capability boundary is the MODULE GRAPH, so assert on the module graph.
  // (A substring search for 'content-protocol' fails on this page: its header
  // comment explains, in prose, that it imports no content-protocol.js - and a
  // test that reads prose as code breaks the moment the prose gets clearer.)
  const imports = [...page.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./draw-editor.js', '../core/drawings.js'].sort(),
    'the guest page imports the editor and the pixel model, and nothing wall-side');
  assert.ok(!/new WebSocket/.test(page), 'and it opens no socket: it has no wall to watch');
});

test('the flood gate is per network, and a guest is not a flood', async (t) => {
  // The address gate is loose on purpose: behind one NAT, a room of phones is
  // one address. It stops a script, not a queue of guests.
  const relay = await up(t, ['--rate-spacing', '0', '--rate-burst', '0', '--addr-spacing', '0', '--addr-burst', '3']);
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await post(relay.base, { name: `g${i}`, pixels: hex }, { 'x-wall-device': `dev-${i}` });
    codes.push(r.status);
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429],
    'four guests from one network past a burst of three: the first three post, the flood is refused');
});

test('the relay survives a restart with its cursor, so a wall never replays history', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-relay-r-'));
  const data = join(dir, 'd.json');
  const port = await freePort();
  let relay = await startRelay(port, ['--data', data, '--rate-spacing', '0', '--rate-burst', '0', '--wall-key', 'wallkey1']);
  try {
    await post(relay.base, { name: 'Ada', pixels: hex }, { 'x-wall-device': 'dev-a' });
    const j = await (await fetch(`${relay.base}/pull?since=0`, { headers: { 'x-wall-key': 'wallkey1' } })).json();
    assert.equal(j.entries.length, 1);
    await relay.stop();

    relay = await startRelay(port, ['--data', data, '--rate-spacing', '0', '--rate-burst', '0', '--wall-key', 'wallkey1']);
    const after = await (await fetch(`${relay.base}/pull?since=${j.cursor}`, { headers: { 'x-wall-key': 'wallkey1' } })).json();
    assert.equal(after.entries.length, 0, 'a restart does not rewind the cursor and re-serve the gallery');
    assert.equal(after.count, 1, 'and the gallery is still the gallery');
  } finally {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

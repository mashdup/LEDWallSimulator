import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startServe, noGuards } from './harness.js';
import { emptyPixels, pixelsToHex, newDrawing, validateEntry } from '../core/drawings.js';

/**
 * The drawings store over HTTP: the editor POSTs entries, the gallery
 * renderer reads them, and the only reason either works is that the state
 * lives on the server (the same reasoning as /content — the capture browser
 * shares nothing with a tab).
 *
 * Every suite points serve.js at a temp --data file, so the repo's real
 * data/drawings.json is never touched by a test run.
 */

const json = (v) => JSON.stringify(v);

function tempData() {
  const dir = mkdtempSync(join(tmpdir(), 'omp-draw-'));
  return { file: join(dir, 'drawings.json'), dir };
}

async function serveOn(args) {
  const port = await freePort();
  return startServe(port, args);
}

// Every instance points at a temp store with the guest guards OFF: these tests
// post several drawings to one server, which is exactly what the rate limit
// exists to stop.
function args(file) {
  return ['--data', file, ...noGuards()];
}

test('GET /drawings starts as an empty list', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const r = await fetch(`${serve.base}/drawings`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await r.json(), []);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('POST adds an entry; the list is metas, the id carries the pixels', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const p = emptyPixels();
    p[0] = 255; p[3] = 255; // one opaque red cell
    const hex = pixelsToHex(p);

    const post = await fetch(`${serve.base}/drawings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ name: 'first', pixels: hex }),
    });
    assert.equal(post.status, 200);
    const meta = await post.json();
    assert.equal(meta.name, 'first');
    assert.ok(meta.id.length > 8);
    assert.ok(Number.isFinite(meta.createdAt));
    assert.equal(meta.pixels, undefined, 'the list response must not carry pixel payloads');

    const list = await (await fetch(`${serve.base}/drawings`)).json();
    assert.deepEqual(list, [{ id: meta.id, name: 'first', createdAt: meta.createdAt }]);

    const full = await (await fetch(`${serve.base}/drawings/${meta.id}`)).json();
    assert.equal(full.pixels, hex, 'the bytes must round-trip exactly');

    // A drawing with no name is legal: the entry flow is "draw, press save".
    const anon = await fetch(`${serve.base}/drawings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ pixels: hex }),
    });
    assert.equal(anon.status, 200);
    assert.equal((await anon.json()).name, '');
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the store gate rejects junk with a status, never a crash', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const post = (body) => fetch(`${serve.base}/drawings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(json({}))).status, 400, 'no pixels');
    assert.equal((await post(json({ pixels: 'deadbeef' }))).status, 400, 'too short');
    assert.equal((await post(json({ pixels: 'zz'.repeat(1600) }))).status, 400, 'not hex');
    assert.equal((await post(json({ pixels: '00'.repeat(1601) }))).status, 400, 'too long');
    assert.equal((await post(json({ pixels: pixelsToHex(emptyPixels()), name: 'x'.repeat(200) }))).status, 200,
      'a long name is truncated by the store, not refused');

    // Over the size cap: a drawing is ~3.3 KB, so a 20 KB body is not a
    // drawing. The server destroys the request while answering, and a client
    // whose body is still being written may see the reset instead of the 413 -
    // both are "refused", so the assertion accepts either.
    let big = null;
    try {
      big = await post(json({ pixels: pixelsToHex(emptyPixels()), pad: 'a'.repeat(20000) }));
    } catch {
      big = null;
    }
    if (big !== null) assert.equal(big.status, 413);

    // The store is still healthy afterwards.
    assert.equal((await (await fetch(`${serve.base}/drawings`)).json()).length, 1);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('DELETE removes an entry; unknown ids are 404, not 500', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const hex = pixelsToHex(emptyPixels());
    const a = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'a', pixels: hex }),
    })).json();
    const b = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'b', pixels: hex }),
    })).json();

    // Auth first, lookup second: an unauthenticated caller is told "no" before
    // it is told whether an id exists.
    assert.equal((await fetch(`${serve.base}/drawings/none`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${serve.base}/drawings/none`, {
      method: 'DELETE', headers: { 'x-wall-owner': 'test-owner-token' },
    })).status, 404, 'unknown ids are 404, not 500');
    assert.equal((await fetch(`${serve.base}/drawings/${a.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': 'test-owner-token' },
    })).status, 204);
    assert.equal((await fetch(`${serve.base}/drawings/${a.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': 'test-owner-token' },
    })).status, 404, 'twice is 404');

    // Order is stable (oldest first): the gallery cycles by index, so a
    // removal must not reshuffle what the remaining indices point at.
    const list = await (await fetch(`${serve.base}/drawings`)).json();
    assert.deepEqual(list.map((m) => m.name), ['b']);
    assert.equal(list[0].id, b.id);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the gallery survives a restart, and a corrupt record is dropped not trusted', async () => {
  const { file, dir } = tempData();
  const hex = pixelsToHex(emptyPixels());
  const serve = await serveOn(args(file));
  let kept;
  try {
    kept = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'kept', pixels: hex }),
    })).json();
  } finally {
    await serve.stop();
  }

  // A record whose pixels are not the wire form: validateEntry is the gate at
  // load time too, so one bad line never becomes a 500 in the renderer.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.push({ id: 'junk', name: 'junk', pixels: 'not-hex', createdAt: 1 });
  writeFileSync(file, json(stored));

  const again = await serveOn(args(file));
  try {
    const list = await (await fetch(`${again.base}/drawings`)).json();
    assert.deepEqual(list.map((m) => m.id), [kept.id], 'the good entry survives, the junk is gone');
    const full = await (await fetch(`${again.base}/drawings/${kept.id}`)).json();
    assert.equal(full.pixels, hex);
    assert.equal(full.name, 'kept');
  } finally {
    await again.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('a missing or unparseable data file is an empty gallery, not a dead server', async () => {
  const { file, dir } = tempData(); // file does not exist
  const serve = await serveOn(args(file));
  try {
    assert.deepEqual(await (await fetch(`${serve.base}/drawings`)).json(), []);
    writeFileSync(file, 'this is not json at all');
    const r = await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: json({ name: 'ok', pixels: pixelsToHex(emptyPixels()) }),
    });
    assert.equal(r.status, 200, 'a corrupt store must not break the write path');
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the content gate accepts pic and gallery, so a driver tab can show a drawing', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const hex = pixelsToHex(emptyPixels());
    const post = (body) => fetch(`${serve.base}/content`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json(body),
    });

    const pic = await post({ v: 1, kind: 'pic', pixels: hex });
    assert.equal(pic.status, 200);
    assert.equal((await pic.json()).state.pixels, hex);

    const gallery = await post({ v: 1, kind: 'gallery', interval: 8 });
    assert.equal(gallery.status, 200);
    assert.equal((await gallery.json()).state.interval, 8);

    // The same gate as every other kind: a bad payload is a 400, not a state.
    assert.equal((await post({ v: 1, kind: 'pic', pixels: 'deadbeef' })).status, 400);
    assert.equal((await post({ v: 1, kind: 'gallery', interval: 0 })).status, 400);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('a stored entry is exactly the shape core defines (no server-side drift)', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const p = emptyPixels();
    p[4] = 7; // cell 1's red channel
    const hex = pixelsToHex(p);
    const e = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'shape', pixels: hex }),
    })).json();
    const full = await (await fetch(`${serve.base}/drawings/${e.id}`)).json();
    assert.ok(validateEntry(full), 'what the server stores must satisfy core');
    assert.deepEqual(new Date(full.createdAt) instanceof Date, true);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});
test('the guest flood is limited by address, and a refusal is a real 429', async () => {
  const { file, dir } = tempData();
  // Small numbers so the test is seconds, not the 10 s default.
  const serve = await serveOn(['--data', file, '--rate-spacing', '700', '--rate-burst', '3',
    '--rate-window', '60000', '--max-drawings', '0']);
  try {
    const hex = pixelsToHex(emptyPixels());
    const post = () => fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'x', pixels: hex }),
    });

    const first = await post();
    assert.equal(first.status, 200, 'the first post is always allowed');

    // The spacing gate: immediately after a save, the answer is 429 with a
    // Retry-After the client can obey.
    const second = await post();
    assert.equal(second.status, 429, 'a second post inside the spacing is refused');
    const retry = Number(second.headers.get('retry-after'));
    assert.ok(retry >= 1 && retry <= 60, `Retry-After must be a usable delay, saw ${second.headers.get('retry-after')}`);
    assert.match(await second.text(), /one at a time/);

    // A refusal records nothing: hammering must not push one's own lockout
    // further out, and the gate must open on schedule.
    await post();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await post()).status, 200, 'the gate opens when the spacing has passed');

    // The burst cap on top of the spacing: a slow drip that never violates the
    // spacing still stops at the window's limit.
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 750));
      seen.push((await post()).status);
    }
    assert.ok(seen.includes(429), `the burst cap must bite, saw ${seen.join(',')}`);

    // The gate is on the write path only: reading the gallery is free, and a
    // guest page that polls the wall must not be limited for it.
    for (let i = 0; i < 30; i++) assert.equal((await fetch(`${serve.base}/drawings`)).status, 200);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('a full gallery answers 507, not a fake success', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(['--data', file, '--max-drawings', '2', '--rate-spacing', '0', '--rate-burst', '0']);
  try {
    const hex = pixelsToHex(emptyPixels());
    const post = () => fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'x', pixels: hex }),
    });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const full = await post();
    assert.equal(full.status, 507, 'the cap is the honest answer');
    assert.match(await full.text(), /full/);
    assert.equal((await (await fetch(`${serve.base}/drawings`)).json()).length, 2, 'a refused post writes nothing');
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('DELETE needs a token: the owner prunes, the creator takes back, strangers do not', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(['--data', file, '--rate-spacing', '0', '--rate-burst', '0',
    '--max-drawings', '0', '--owner-token', 'owner-secret']);
  try {
    const hex = pixelsToHex(emptyPixels());
    const post = (name) => fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name, pixels: hex }),
    }).then((r) => r.json());
    const mine = await post('mine');
    const theirs = await post('theirs');

    // No token at all: 401, and the entry is still there.
    const anon = await fetch(`${serve.base}/drawings/${mine.id}`, { method: 'DELETE' });
    assert.equal(anon.status, 401, 'an unauthenticated delete is refused before anything is looked up');
    assert.match(await anon.text(), /X-Wall-Owner/);

    // A wrong token: 403. The id is not a secret (the list is public), so the
    // answer to a stranger with a guessed token is "no", not "not found".
    const wrong = await fetch(`${serve.base}/drawings/${mine.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': 'guess' },
    });
    assert.equal(wrong.status, 403);

    // The creator's own secret takes their drawing back.
    const undo = await fetch(`${serve.base}/drawings/${mine.id}`, {
      method: 'DELETE', headers: { 'x-wall-delete': mine.secret },
    });
    assert.equal(undo.status, 204, 'the creator can undo their own post');
    assert.equal((await (await fetch(`${serve.base}/drawings`)).json()).length, 1);

    // ...and not anybody else's: the secret is per entry.
    const cross = await fetch(`${serve.base}/drawings/${theirs.id}`, {
      method: 'DELETE', headers: { 'x-wall-delete': mine.secret },
    });
    assert.equal(cross.status, 403, 'a delete secret opens one entry, not the gallery');

    // The owner prunes everything, including what nobody signed.
    const ownerDel = await fetch(`${serve.base}/drawings/${theirs.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': 'owner-secret' },
    });
    assert.equal(ownerDel.status, 204);
    assert.deepEqual(await (await fetch(`${serve.base}/drawings`)).json(), []);
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('an empty owner token is no auth, and the per-entry secret keeps working', async () => {
  const { file, dir } = tempData();
  // --owner-token with a blank value: that must DISABLE owner auth, not become
  // a shared secret of "" that any guest can send in an empty header.
  const serve = await serveOn(['--data', file, '--rate-spacing', '0', '--rate-burst', '0',
    '--max-drawings', '0', '--owner-token', ' ']);
  try {
    const e = await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: json({ name: 'x', pixels: pixelsToHex(emptyPixels()) }),
    }).then((r) => r.json());
    const empty = await fetch(`${serve.base}/drawings/${e.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': '' },
    });
    assert.ok(empty.status === 401 || empty.status === 403,
      `an empty owner token must not delete, saw ${empty.status}`);
    const bySecret = await fetch(`${serve.base}/drawings/${e.id}`, {
      method: 'DELETE', headers: { 'x-wall-delete': e.secret },
    });
    assert.equal(bySecret.status, 204, 'the per-entry secret works with no owner token configured');
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the delete secret is stored, served once, and never readable back', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(args(file));
  try {
    const hex = pixelsToHex(emptyPixels());
    const e = await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'secret', pixels: hex }),
    }).then((r) => r.json());
    assert.ok(typeof e.secret === 'string' && e.secret.length >= 16, 'POST hands the creator a token');

    // The list and the entry never carry it: the list is public, so a served
    // secret would mean every visitor can delete every drawing.
    const metas = await (await fetch(`${serve.base}/drawings`)).json();
    assert.deepEqual(Object.keys(metas[0]).sort(), ['createdAt', 'id', 'name']);
    const full = await (await fetch(`${serve.base}/drawings/${e.id}`)).json();
    assert.deepEqual(Object.keys(full).sort(), ['createdAt', 'id', 'name', 'pixels'],
      'GET must not leak the delete secret');
    assert.equal(full.pixels, hex, 'and stripping it must not break the entry');

    // It IS in the store, and it survives a restart: the creator's undo token
    // has to outlive the server that issued it.
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored[0].secret, e.secret);
    await serve.stop();

    const again = await serveOn(args(file));
    try {
      const undo = await fetch(`${again.base}/drawings/${e.id}`, {
        method: 'DELETE', headers: { 'x-wall-delete': e.secret },
      });
      assert.equal(undo.status, 204, 'the token keeps working after a restart');
    } finally {
      await again.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the owner token is generated once, saved beside the store, and stable', async () => {
  const { file, dir } = tempData();
  const noToken = noGuards().filter((a, i, arr) => arr[i] !== '--owner-token' && arr[i - 1] !== '--owner-token');
  const serve = await startServe(await freePort(), ['--data', file, ...noToken]);
  try {
    const tokenFile = join(dir, 'owner-token.txt');
    const token = readFileSync(tokenFile, 'utf8').trim();
    assert.ok(/^[0-9a-f]{32}$/.test(token), `a random token is hex, saw ${token}`);
    const e = await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: json({ name: 'x', pixels: pixelsToHex(emptyPixels()) }),
    }).then((r) => r.json());
    assert.equal((await fetch(`${serve.base}/drawings/${e.id}`, {
      method: 'DELETE', headers: { 'x-wall-owner': token },
    })).status, 204, 'the generated token opens the gallery');

    // Restart: the same file, the same token. A token that changes every boot
    // is a token the owner cannot keep in the editor.
    await serve.stop();
    const again = await startServe(await freePort(), ['--data', file, ...noToken]);
    try {
      assert.equal(readFileSync(tokenFile, 'utf8').trim(), token, 'the token is stable across restarts');
    } finally {
      await again.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

test('the owner token lifts the post limit and the cap: the guards are for strangers', async () => {
  const { file, dir } = tempData();
  // Guards ON, at the shipped defaults, with a known token.
  const serve = await serveOn(['--data', file, '--owner-token', 'test-owner-token']);
  try {
    const hex = pixelsToHex(emptyPixels());
    const post = (base, owner) => fetch(`${base}/drawings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(owner ? { 'x-wall-owner': owner } : {}) },
      body: json({ name: 'x', pixels: hex }),
    });

    // The owner's real workflow: a stack of family pictures, saved one after
    // another from one laptop. One address, ten seconds a save, twenty
    // minutes - a limit on the wrong person.
    const owner = [];
    for (let i = 0; i < 5; i++) owner.push((await post(serve.base, 'test-owner-token')).status);
    assert.deepEqual(owner, [200, 200, 200, 200, 200], 'the owner is never rate limited');

    // The gate is still there for everyone else, on the same address, one
    // second later: lifting it is proof of being the owner, not a client flag.
    // And the owner's posts do NOT consume the guest allowance - the owner
    // saving twenty pictures cannot starve the wall for the next guest, and a
    // guest gets the same first save and the same 429 after it.
    assert.equal((await post(serve.base, null)).status, 200, 'a guest keeps their own first save');
    assert.equal((await post(serve.base, null)).status, 429, 'the gate is untouched for strangers');
    assert.equal((await post(serve.base, 'wrong-token')).status, 429, 'a wrong token is a stranger, not an owner');

    // The cap is the owner's own number, and the token is the only way to
    // raise it at runtime: the gallery is the owner's resource. A FRESH store -
    // the cap is about the size of the gallery, and sharing this file would
    // carry the five saves above into it and turn this into a test of cleanup.
    const fresh = tempData();
    const only = await serveOn(['--data', fresh.file, '--owner-token', 'test-owner-token',
      '--rate-spacing', '0', '--rate-burst', '0', '--max-drawings', '2']);
    try {
      assert.equal((await post(only.base, 'test-owner-token')).status, 200);
      assert.equal((await post(only.base, 'test-owner-token')).status, 200);
      assert.equal((await post(only.base, null)).status, 507, 'the cap holds for strangers');
      assert.equal((await post(only.base, 'test-owner-token')).status, 200, 'the owner can post past their own cap');
      assert.equal((await (await fetch(`${only.base}/drawings`)).json()).length, 3);
    } finally {
      await only.stop();
      rmSync(fresh.dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    }
  } finally {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  }
});

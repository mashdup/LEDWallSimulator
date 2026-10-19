import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startServe } from './harness.js';
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

test('GET /drawings starts as an empty list', async () => {
  const { file, dir } = tempData();
  const serve = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
  try {
    const hex = pixelsToHex(emptyPixels());
    const a = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'a', pixels: hex }),
    })).json();
    const b = await (await fetch(`${serve.base}/drawings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ name: 'b', pixels: hex }),
    })).json();

    assert.equal((await fetch(`${serve.base}/drawings/none`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${serve.base}/drawings/${a.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${serve.base}/drawings/${a.id}`, { method: 'DELETE' })).status, 404, 'twice is 404');

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
  const serve = await serveOn(['--data', file]);
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

  const again = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
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
  const serve = await serveOn(['--data', file]);
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

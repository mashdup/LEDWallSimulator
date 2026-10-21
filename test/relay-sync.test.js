/**
 * The wall's side of the relay: the dial-out sync loop (tools/relay-client.js).
 *
 * The relay suite proves the public side keeps a queue. This proves the wall
 * visits it - and the interesting part is not the happy path, it is the shape
 * of the failures: a wall that starts with no signal, a delete that must travel
 * both ways, and a drawing that must never echo back to where it came from.
 *
 * A party laptop on a phone hotspot loses signal when people crowd around it.
 * The wall must not care: the local gallery keeps running, and the drawings
 * arrive late rather than never.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startRelay, startServe } from './harness.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

const hex = pixelsToHex(emptyPixels());
const WALL_KEY = 'wallkey1234567890abcdef';

/** A relay on its own temp store, stopped with the test. */
async function relayUp(t, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-relay-sync-'));
  const port = await freePort();
  const relay = await startRelay(port, ['--data', join(dir, 'relay.json'),
    '--wall-key', WALL_KEY, '--rate-spacing', '0', '--rate-burst', '0', ...args]);
  // Stop the child, then drop the directory. A leaked server holds its stdout
  // pipe open, and the test runner waits on that pipe: a suite that forgets
  // one stop() finishes every test and then never exits.
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return { ...relay, dir };
}

/** The wall, pointed at a relay, syncing fast. */
async function wallUp(t, relayBase, args = [], key = WALL_KEY) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-wall-sync-'));
  const serve = await startServe(await freePort(), [
    '--data', join(dir, 'drawings.json'),
    '--owner-token', 'ownerkey1',
    '--rate-spacing', '0', '--rate-burst', '0',
    '--relay', relayBase, '--relay-key', key, '--relay-interval', '250',
    ...args,
  ]);
  t.after(async () => {
    await serve.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return { ...serve, dir };
}

async function guestPost(base, name, device = 'dev-1') {
  return fetch(`${base}/drawings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wall-device': device },
    body: JSON.stringify({ name, pixels: hex }),
  });
}

async function wallList(base) {
  return (await fetch(`${base}/drawings`)).json();
}

async function relayPull(base, since = 0) {
  const r = await fetch(`${base}/pull?since=${since}`, { headers: { 'x-wall-key': WALL_KEY } });
  return { status: r.status, body: await r.json() };
}

async function until(fn, what, ms = 12_000) {
  const stop = Date.now() + ms;
  let last = null;
  while (Date.now() < stop) {
    last = await fn();
    if (last.done) return last.value;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(`${what} (waited ${ms} ms, last saw ${JSON.stringify(last?.seen)})`);
}

test('the wall pulls what guests posted to the relay', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t, relay.base);

  for (const [name, dev] of [['Ada', 'dev-a'], ['Kai', 'dev-b']]) {
    assert.equal((await guestPost(relay.base, name, dev)).status, 200, 'the guest posts to the relay');
  }

  const got = await until(
    async () => {
      const list = await wallList(wall.base);
      return { done: list.length === 2, seen: list.map((e) => e.name), value: list };
    },
    'the wall shows the guests\' drawings',
  );
  assert.deepEqual(got.map((e) => e.name).sort(), ['Ada', 'Kai'],
    'the party sees the phones that posted while the wall was nowhere near them');

  // The wall's renderer reads the same store, so the gallery needs no relay of
  // its own: this is the whole integration - names, ids, and pixels that pass
  // core's gate on the way in.
  const full = await (await fetch(`${wall.base}/drawings/${got[0].id}`)).json();
  assert.equal(full.pixels, hex, 'the pixels crossed the wire intact');
});

test('the wall pushes what the owner saved, and nothing echoes back', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t, relay.base);

  const saved = await (await fetch(`${wall.base}/drawings`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wall-owner': 'ownerkey1' },
    body: JSON.stringify({ name: 'Family', pixels: hex }),
  })).json();

  const seen = await until(
    async () => {
      const { body } = await relayPull(relay.base);
      return { done: body.entries.some((e) => e.name === 'Family'), seen: body.entries.map((e) => e.name), value: body };
    },
    'the relay carries the wall\'s own drawing',
  );
  assert.equal(seen.count, 1, 'one drawing on the relay: the wall pushed exactly one');

  // The echo is the bug this proves absent: a pulled entry is marked as the
  // relay's, so it never rides the push. Two walls on one relay would otherwise
  // copy each other's galleries forever, and one wall alone would replay its
  // whole gallery on every connect.
  await new Promise((r) => setTimeout(r, 1_200));
  const after = await relayPull(relay.base);
  assert.equal(after.body.count, 1, 'the wall did not push back what it pulled');
  assert.equal(after.body.entries.filter((e) => e.id === saved.id).length, 1,
    'and it did not push the owner\'s drawing twice');
});

test('a delete travels both ways, and the dead drawing stays dead', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t, relay.base);

  // Guest posts to the relay, then takes it back. The wall must forget it.
  const mine = await (await guestPost(relay.base, 'Temp', 'dev-x')).json();
  await until(async () => {
    const list = await wallList(wall.base);
    return { done: list.some((e) => e.id === mine.id), seen: list.map((e) => e.name), value: list };
  }, 'the wall received the guest drawing');

  const back = await fetch(`${relay.base}/drawings/${mine.id}`, {
    method: 'DELETE', headers: { 'x-wall-device': 'dev-x', 'x-wall-delete': mine.secret },
  });
  assert.equal(back.status, 200, 'the guest takes it back from the relay');

  await until(async () => {
    const list = await wallList(wall.base);
    return { done: !list.some((e) => e.id === mine.id), seen: list.map((e) => e.name), value: list };
  }, 'the wall forgot the drawing the guest deleted');

  // The owner prunes on the wall; the relay must follow.
  const saved = await (await fetch(`${wall.base}/drawings`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wall-owner': 'ownerkey1' },
    body: JSON.stringify({ name: 'Prune me', pixels: hex }),
  })).json();
  await until(async () => {
    const { body } = await relayPull(relay.base);
    return { done: body.entries.some((e) => e.id === saved.id), seen: body.entries.map((e) => e.name), value: body };
  }, 'the relay received the wall drawing');
  assert.equal((await fetch(`${wall.base}/drawings/${saved.id}`, {
    method: 'DELETE', headers: { 'x-wall-owner': 'ownerkey1' },
  })).status, 204, 'the owner prunes it on the wall');

  await until(async () => {
    const { body } = await relayPull(relay.base);
    return { done: !body.entries.some((e) => e.id === saved.id), seen: body.entries.map((e) => e.name), value: body };
  }, 'the relay followed the owner\'s delete');

  // The tombstone is the reason a delete cannot come back: the wall's next
  // connect must not re-pull what the relay already removed.
  await new Promise((r) => setTimeout(r, 1_200));
  const list = await wallList(wall.base);
  assert.ok(!list.some((e) => e.id === saved.id), 'and it stays deleted, not resurrected by the next sync');
});

test('a wall with no signal keeps drawing, and catches up when the relay appears', async (t) => {
  // The realistic party failure: the laptop is on a hotspot, and the relay is
  // unreachable when the wall boots. Offline must be a state, not a crash.
  const deadPort = await freePort();
  const wall = await wallUp(t, `http://127.0.0.1:${deadPort}`);

  const saved = await (await fetch(`${wall.base}/drawings`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wall-owner': 'ownerkey1' },
    body: JSON.stringify({ name: 'Offline', pixels: hex }),
  })).json();
  assert.ok(saved.id, 'the wall saves with the relay unreachable');
  const list = await wallList(wall.base);
  assert.equal(list.length, 1, 'the wall\'s own gallery works with no relay at all');
  assert.match(wall.log(), /relay: not syncing/, 'and it says so, once');

  // The relay appears. The client backs off, so allow for one backoff cycle.
  const relay = await startRelay(deadPort, ['--data', join(wall.dir, 'late-relay.json'),
    '--wall-key', WALL_KEY, '--rate-spacing', '0', '--rate-burst', '0']);
  t.after(async () => { await relay.stop(); });

  const seen = await until(
    async () => {
      const { body } = await relayPull(relay.base);
      return { done: body.entries.some((e) => e.id === saved.id), seen: body.entries.map((e) => e.name), value: body };
    },
    'the wall delivered the offline drawing once the relay appeared',
    30_000,
  );
  assert.equal(seen.entries.find((e) => e.id === saved.id).name, 'Offline');

  // ...and the guest who posted during the blackout arrives on the wall.
  await guestPost(relay.base, 'Blackout', 'dev-late');
  await until(async () => {
    const l = await wallList(wall.base);
    return { done: l.some((e) => e.name === 'Blackout'), seen: l.map((e) => e.name), value: l };
  }, 'the wall caught up on the blackout posting', 30_000);
});

test('a wall with no key is a wall the relay refuses, and the wall says so', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t, relay.base, [], 'wrong-key-0000000000');

  await guestPost(relay.base, 'Stuck', 'dev-1');
  // Nothing arrives, and the reason is in the log, not in a silent gap.
  await new Promise((r) => setTimeout(r, 2_000));
  const list = await wallList(wall.base);
  assert.equal(list.length, 0, 'a wall that cannot prove itself gets nothing');
  assert.match(wall.log(), /refused the wall key/, 'and the refusal names the key, not the network');

  // The relay is unbothered: guests keep posting, the queue keeps growing.
  assert.equal((await guestPost(relay.base, 'Still fine', 'dev-2')).status, 200,
    'a refusing wall does not stop the party');
});

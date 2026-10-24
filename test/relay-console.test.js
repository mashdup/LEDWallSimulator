/**
 * The relay, configured from the CONSOLE: the point is that neither the wall
 * laptop nor the packaged .exe ever needs a command line. The owner picks the
 * relay from a dropdown, types the key once, and the server persists the
 * pairing (relay.json beside the gallery) so every later boot - reboot, app
 * restart, fresh binary with no flags - relays by itself.
 *
 * The safety contract this pins: re-pointing the relay is owner-token-gated
 * (the hand that prunes the gallery is the only hand allowed to move the
 * party's plumbing), the wall key is never served back to any page, and a
 * half-config (URL without a key) is refused loudly instead of syncing to
 * nothing with 401s in a log nobody reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startRelay, startServe } from './harness.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

const hex = pixelsToHex(emptyPixels());
const WALL_KEY = 'wallkey1234567890abcdef';
const OWNER = 'ownerkey1';

async function relayUp(t, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-relay-con-'));
  const port = await freePort();
  const relay = await startRelay(port, ['--data', join(dir, 'relay.json'),
    '--wall-key', WALL_KEY, '--rate-spacing', '0', '--rate-burst', '0', ...args]);
  t.after(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return relay;
}

/** The wall with NO relay flags on its command line - the packaged-app shape. */
async function wallUp(t, extraArgs = [], dataDir = null) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'omp-wall-con-'));
  const serve = await startServe(await freePort(), [
    '--data', join(dir, 'drawings.json'),
    '--owner-token', OWNER,
    '--rate-spacing', '0', '--rate-burst', '0',
    ...extraArgs,
  ]);
  t.after(async () => {
    await serve.stop();
    if (dataDir === null) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  return { ...serve, dir };
}

function post(base, cfg, owner = OWNER) {
  return fetch(`${base}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner === null ? {} : { 'x-wall-owner': owner }) },
    body: JSON.stringify(cfg),
  });
}

async function guestPost(base, name, device = 'dev-1') {
  return fetch(`${base}/drawings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wall-device': device },
    body: JSON.stringify({ name, pixels: hex }),
  });
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

test('the console points the wall at the relay: no flags, no restart, party live', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t);

  const g0 = await (await fetch(`${wall.base}/relay`)).json();
  assert.equal(g0.enabled, false, 'a flag-free boot starts unpaired, like always');

  const bad = await post(wall.base, { url: relay.base, key: WALL_KEY }, null);
  assert.equal(bad.status, 401, 're-pointing the relay is the owner hand only');

  const ok = await post(wall.base, { url: relay.base, key: WALL_KEY, intervalMs: 250 });
  assert.equal(ok.status, 200, 'the owner points it and it takes effect immediately');
  assert.deepEqual(await ok.json(), { ok: true, enabled: true, url: relay.base });

  await guestPost(relay.base, 'Ada');
  await until(
    async () => {
      const list = await (await fetch(`${wall.base}/drawings`)).json();
      return { done: list.length === 1, seen: list.map((e) => e.name) };
    },
    'the dropdown-configured relay syncs like a flag-configured one',
  );

  // Persisted beside the gallery: this is what makes the NEXT boot relay by
  // itself with no shortcut flags anywhere.
  const saved = JSON.parse(readFileSync(join(wall.dir, 'relay.json'), 'utf8'));
  assert.equal(saved.url, relay.base);
  assert.equal(saved.key, WALL_KEY, 'the key is kept on the wall\'s own disk, never served');

  const g1 = await (await fetch(`${wall.base}/relay`)).json();
  assert.equal(g1.enabled, true);
  assert.equal(g1.keySet, true, 'the console learns only THAT a key exists');
  assert.ok(!(await (await fetch(`${wall.base}/relay`)).text()).includes(WALL_KEY),
    'the wall key is never served to a page');
});

test('relay.json is remembered: a flag-free boot (the packaged app) relays by itself', async (t) => {
  const relay = await relayUp(t);
  // A boot after the owner configured the console: the pairing is on disk,
  // the command line is bare - exactly the installed .exe on show night.
  const dir = mkdtempSync(join(tmpdir(), 'omp-wall-con2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }));
  writeFileSync(join(dir, 'relay.json'), JSON.stringify({ url: relay.base, key: WALL_KEY, intervalMs: 250 }));

  const wall = await wallUp(t, [], dir);
  await guestPost(relay.base, 'Kai');
  await until(
    async () => {
      const list = await (await fetch(`${wall.base}/drawings`)).json();
      return { done: list.length === 1, seen: list.map((e) => e.name) };
    },
    'the rebooted app relays with no flags and no human',
  );
});

test('a half-config is refused, and an empty key keeps the saved one', async (t) => {
  const relay = await relayUp(t);
  const wall = await wallUp(t);

  const half = await post(wall.base, { url: relay.base });
  assert.equal(half.status, 400, 'URL without a key is a party that syncs to nothing - refuse it');
  assert.match((await half.json()).why, /wall key/);

  assert.equal((await post(wall.base, { url: relay.base, key: WALL_KEY, intervalMs: 250 })).status, 200);
  // Change only the URL (trailing slash): the key field is empty because the
  // console masks it, so the saved key must survive.
  const edit = await post(wall.base, { url: `${relay.base}/`, key: '' });
  assert.equal(edit.status, 200, 'empty key means keep the saved one');
  const saved = JSON.parse(readFileSync(join(wall.dir, 'relay.json'), 'utf8'));
  assert.equal(saved.key, WALL_KEY, 'the saved key survived the URL edit');
  assert.equal(saved.url, relay.base, 'the trailing slash was normalized');

  await guestPost(relay.base, 'Niv');
  await until(
    async () => {
      const list = await (await fetch(`${wall.base}/drawings`)).json();
      return { done: list.length === 1, seen: list.map((e) => e.name) };
    },
    'the re-pointed relay keeps syncing with the kept key',
  );

  // Off is a config too: guests fall back to the local network.
  const off = await post(wall.base, { url: '' });
  assert.equal(off.status, 200);
  const g = await (await fetch(`${wall.base}/relay`)).json();
  assert.equal(g.enabled, false, 'the dropdown\'s Off really does unplug the queue');
});

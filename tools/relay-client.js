/**
 * The wall's side of the relay: a client that DIALS OUT.
 *
 * The wall is a laptop behind NAT, on a venue network or a phone hotspot, and
 * its server is loopback-bound because Web Serial requires a secure context.
 * So it cannot be reached, and it should not be: the console stays off the
 * network. The relay on jarvis is the public door, and the wall visits it.
 *
 * ## One number does the whole sync
 *
 * Every mutation - a drawing added, a drawing deleted - carries a `seq` in the
 * store. The client keeps two of them:
 *
 *   sent   how far the relay has been told about this wall
 *   cursor how far this wall has been told about the relay
 *
 * A push is "everything local with seq > sent"; a pull is "everything with
 * seq > cursor". Both cursors live in the store's state file, so a wall that
 * reboots mid-party resumes where it left off. There is no diffing, no
 * timestamps, no "last modified" - and no way for a drawing to come back from
 * the dead, because deletes are tombstones on the same number line.
 *
 * ## Offline is the normal case, not the error case
 *
 * A party laptop on a phone hotspot loses signal when people crowd around it,
 * and the wall must not care. Every failure is caught, the interval backs off
 * to a minute, and the local gallery keeps running the whole time: guests who
 * posted to the relay are simply shown a little later. The wall never blocks
 * on the relay, and the relay never blocks on the wall.
 */

const BACKOFF_MAX_MS = 60_000;

/**
 * @param {object} o
 * @param {import('../core/drawing-store.js').DrawingStore} o.store
 * @param {string} o.url relay base, e.g. https://wall.hoa.family
 * @param {string} o.key X-Wall-Key
 * @param {number} o.intervalMs
 * @param {(msg: string) => void} [o.log]
 */
export function makeRelayClient({ store, url, key, intervalMs = 5_000, log = () => {} }) {
  let timer = null;
  let inFlight = false;
  let backoff = intervalMs;
  let lastError = null;
  let syncedAt = 0;

  const sentKey = 'relaySent';
  const cursorKey = 'relayCursor';

  function headers() {
    return { 'content-type': 'application/json', 'x-wall-key': key };
  }

  async function resq(r, what) {
    // A 401 is not a dead relay: it is a live relay that does not recognise
    // this wall. Saying "not reachable" there sends the owner off to check the
    // network while the actual problem is one argument on the command line.
    if (r.status === 401 || r.status === 403) throw new Error(`${what}: the relay refused the wall key (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`${what} -> HTTP ${r.status}`);
  }

  async function push() {
    const sent = Number(store.meta[sentKey] ?? 0);
    if (store.seq <= sent) return 0;
    const entries = store.list
      .filter((e) => e.origin !== 'relay' && e.seq > sent)
      .map(({ id, name, pixels, createdAt }) => ({ id, name, pixels, createdAt }));
    const deleted = store.deleted.filter((d) => d.seq > sent).map((d) => d.id);
    if (entries.length === 0 && deleted.length === 0) {
      store.meta[sentKey] = store.seq;
      store.save();
      return 0;
    }
    const r = await fetch(`${url}/push`, { method: 'POST', headers: headers(), body: JSON.stringify({ entries, deleted }) });
    await resq(r, 'push');
    store.meta[sentKey] = store.seq;
    store.save();
    return entries.length + deleted.length;
  }

  async function pull() {
    const cursor = Number(store.meta[cursorKey] ?? 0);
    const r = await fetch(`${url}/pull?since=${cursor}`, { headers: { 'x-wall-key': key } });
    await resq(r, 'pull');
    const j = await r.json();
    let added = 0;
    for (const e of Array.isArray(j.entries) ? j.entries : []) {
      if (store.adopt({ ...e, origin: 'relay' }) !== null) added += 1;
    }
    for (const d of Array.isArray(j.deleted) ? j.deleted : []) {
      // Apply the peer's delete WITHOUT recording a tombstone of our own: this
      // delete is already on the relay, and re-recording it would send it back
      // and make the wall look like the one that asked.
      if (typeof d?.id === 'string') store.drop(d.id);
    }
    if (Number.isInteger(j.cursor)) store.meta[cursorKey] = j.cursor;
    store.save();
    return added;
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const up = await push();
      const down = await pull();
      backoff = intervalMs;
      syncedAt = Date.now();
      if (lastError !== null || up + down > 0) {
        log(`relay: synced${lastError !== null ? ' again (it is back)' : ''}`
          + `${up > 0 ? ` · sent ${up}` : ''}${down > 0 ? ` · received ${down}` : ''}`
          + ` · ${store.size} drawings`);
      }
      lastError = null;
    } catch (err) {
      // Offline is the normal case: say it once, back off, keep the wall alive.
      if (lastError === null) log(`relay: not syncing (${err.message}) - the wall keeps running, and will catch up`);
      lastError = err.message;
      backoff = Math.min(BACKOFF_MAX_MS, Math.max(intervalMs, backoff * 2));
    } finally {
      // EVERY tick arms the next one, success included. Arming only from
      // start() and the failure path made a client that synced once and then
      // sat there for the rest of the party: the wall showed the drawings that
      // arrived first, and never saw a delete, a late posting, or anything
      // it had saved itself. A loop that only re-arms when it fails is a loop
      // that stops working the moment it works.
      inFlight = false;
      reschedule();
    }
  }

  function reschedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(tick, backoff);
    timer.unref(); // a wall with an unreachable relay must still exit on Ctrl+C
  }

  return {
    tick,
    start() {
      tick();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    get status() {
      return {
        url,
        lastError,
        syncedAt,
        sent: Number(store.meta[sentKey] ?? 0),
        cursor: Number(store.meta[cursorKey] ?? 0),
      };
    },
  };
}

/** --relay <url> / WALL_RELAY. Empty means the feature is off, which is the default. */
export function resolveRelay(argv) {
  const i = argv.indexOf('--relay');
  const url = (i >= 0 ? String(argv[i + 1] ?? '') : (process.env.WALL_RELAY ?? '')).trim();
  const k = argv.indexOf('--relay-key');
  const key = (k >= 0 ? String(argv[k + 1] ?? '') : (process.env.WALL_RELAY_KEY ?? '')).trim();
  const ms = Number(argv[argv.indexOf('--relay-interval') + 1]);
  return { url, key, intervalMs: Number.isInteger(ms) && ms >= 250 ? ms : 5_000 };
}

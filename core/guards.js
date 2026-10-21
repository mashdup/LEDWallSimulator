/**
 * The guards a stranger's page needs, in one place.
 *
 * web/public.html is handed to people with no account and no name, by way of a
 * QR code. Every limit that protects the wall lives here, on the server: a
 * client-side cooldown is a speed bump, and a tab with devtools walks past it.
 *
 *   rate   - a spacing and a burst window on POST /drawings, plus a gallery cap
 *   tokens - the owner token (the gallery), and the entry secret (one entry)
 *
 * ## What an "address" is, and when it lies
 *
 * The wall's own server is loopback-bound with no proxy in front of it, so the
 * socket address is the only honest identity, and X-Forwarded-For is forged by
 * exactly the client the limit exists for.
 *
 * The relay sits behind Caddy on the same box. There, the socket address is
 * 127.0.0.1 for every guest on the internet - a per-address limit becomes one
 * global limit, and the first drawing locks the party out. Caddy is a real
 * proxy and sets XFF truthfully, so the relay may trust it - and only when it
 * is told to, with --trusted-proxy, because the same code run without a proxy
 * in front of it must not believe a header anyone can type.
 *
 * `trustProxy` is therefore not a formatting switch. It is a statement about
 * the topology, and it is the caller's to make.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Constant-time compare, length-guarded (timingSafeEqual throws on a mismatch). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * makeRateGate({spacingMs, burst, windowMs, maxEntries}) -> gate.
 *
 * A REJECTED post records nothing: if it did, hammering would push one's own
 * lockout further out, so a flood would be its own reward - and a guest who
 * tapped twice would be locked out for minutes.
 *
 * Keys are opaque strings: an address on the wall, a device token on the relay.
 * The gate does not know what a key means, which is what lets both servers use
 * the same arithmetic.
 */
export function makeRateGate({ spacingMs = 10_000, burst = 6, windowMs = 60_000, maxEntries = 0 } = {}) {
  const hits = new Map();
  return {
    spacingMs,
    burst,
    windowMs,
    maxEntries,
    check(key) {
      const now = Date.now();
      if (hits.size > 512) { // bounded memory: a party is a lot of phones
        for (const [k, v] of hits) if (now - v.last > windowMs) hits.delete(k);
      }
      const h = hits.get(key) ?? { last: 0, times: [] };
      hits.set(key, h);
      if (spacingMs > 0 && now - h.last < spacingMs) {
        return { ok: false, retryMs: spacingMs - (now - h.last), why: 'one at a time' };
      }
      if (burst > 0) {
        h.times = h.times.filter((t) => now - t < windowMs);
        if (h.times.length >= burst) {
          return { ok: false, retryMs: windowMs - (now - h.times[0]), why: 'too many in a row' };
        }
      }
      h.last = now;
      h.times.push(now);
      return { ok: true };
    },
    /** Reset a key: a device that just succeeded starts its clock fresh. */
    reset(key) {
      const h = hits.get(key);
      if (h !== undefined) h.times = [];
    },
  };
}

/**
 * The client's real address.
 *
 * With `trustProxy`, the left-most XFF entry wins: Caddy appends the peer it
 * saw, and the relay's own socket is loopback. Without it, the socket, always.
 */
export function clientAddr(req, { trustProxy = false } = {}) {
  const socket = req.socket?.remoteAddress ?? '?';
  if (!trustProxy) return socket;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || xff === '') return socket;
  return xff.split(',')[0].trim() || socket;
}

/**
 * The device key: a random id the guest page minted into localStorage.
 *
 * Behind a proxy this is the only per-person identity a stranger's browser
 * offers, and it is deliberately weak: it is a cookie in a private tab, it is
 * gone when the browser is, and anyone who reads the source can rotate it.
 * That is the right strength. It is not an auth token and grants nothing; it is
 * the difference between "one guest, one drawing at a time" and "the first
 * guest at the party draws for everyone". The address gate stays, coarser,
 * underneath it.
 */
export function deviceKey(req) {
  const hdr = req.headers['x-wall-device'];
  if (typeof hdr !== 'string') return 'nodevice';
  const clean = hdr.replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  return clean === '' ? 'nodevice' : clean;
}

/**
 * makeAuth({token}) -> {isOwner(req), opens(entry)(req)}.
 *
 * The owner token lifts the guards, because the guards exist for strangers:
 * the owner who scans twenty family pictures from one laptop is one address at
 * ten seconds a save, which is a limit on the wrong person.
 *
 * An empty token DISABLES owner auth - it is not a shared secret of "", and a
 * guest sending an empty header must not be handed the delete path.
 */
export function makeAuth(token) {
  return {
    token,
    isOwner(req, header = 'x-wall-owner') {
      const hdr = req.headers[header];
      return token !== '' && typeof hdr === 'string' && safeEqual(hdr, token);
    },
    /** The per-entry secret: minted at POST, served once, opens exactly one entry. */
    opens(entry) {
      return (req) => {
        const hdr = req.headers['x-wall-delete'];
        return typeof hdr === 'string' && typeof entry.secret === 'string' && safeEqual(hdr, entry.secret);
      };
    },
  };
}

/**
 * Resolve a token: the flag, then the env var, then a random one
 * persisted beside the store, so it survives every restart and can be copied
 * once.
 */
export function resolveToken({ argv, flag, env, file, label = 'owner token' }) {
  const i = argv.indexOf(flag);
  if (i >= 0) {
    const given = typeof argv[i + 1] === 'string' ? argv[i + 1].trim() : '';
    // Present and BLANK is a decision, not an omission: it means "no owner".
    // Falling through to the env or to a generated file here would turn an
    // explicit "off" into a working secret nobody was told about - which is
    // the opposite of what the operator asked for.
    return given === '' ? { token: '', file: null, off: true } : { token: given, file: null };
  }
  const fromEnv = (process.env[env] ?? '').trim();
  if (fromEnv !== '') return { token: fromEnv, file: null };
  if (file === null) return { token: randomBytes(16).toString('hex'), file: null };
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (t !== '') return { token: t, file };
  } catch { /* no file yet */ }
  const fresh = randomBytes(16).toString('hex');
  try {
    // mkdirSync / writeFileSync / dirname are the imports at the top of this
    // file. This block used to call require() - which an ES module does not
    // have - so it threw, the catch swallowed it, and the token was never
    // written while the banner cheerfully reported the path it was saved to.
    // A catch that swallows a bug turns a broken feature into a silent one.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${fresh}\n`);
  } catch {
    // No place to keep it: this one lasts until restart, and the banner says so.
  }
  return { token: fresh, file, fresh: true };
}

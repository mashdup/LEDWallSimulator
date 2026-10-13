/**
 * ports.js — picking a loopback port that `fetch` will actually connect to.
 *
 * The trap this exists to kill: `server.listen(0)` asks the OS for any free
 * ephemeral port and hands back whatever it gets. On Windows that range can start
 * as low as ~5444, and it overlaps the ports the fetch standard declares
 * "unreachable": a client refuses them before it ever opens a socket, so the
 * server binds happily and every request to it fails with the bare words
 * "bad port". Symptom: a test that passes four times and fails on the fifth,
 * with a stack that points at fetch and a server log that says it started fine.
 *
 * Chromium enforces the same list on its own network requests, so a dev server
 * sitting on one of these ports is broken for the browser app too — which is why
 * serve.js refuses one rather than binding it.
 *
 * The list is the fetch standard's blocked-port set, verified against this
 * machine's undici in test/ports.test.js rather than trusted from memory.
 */

import { createServer } from 'node:net';

/** Ports the fetch standard refuses to connect to, whatever the OS says is free. */
export const BLOCKED_PORTS = Object.freeze([
  1, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const BLOCKED = new Set(BLOCKED_PORTS);

/**
 * True when a client is allowed to connect to this port at all.
 *
 * Deliberately not "is this port free": free and unreachable are different
 * failures, and only this one produces a server that starts and answers nothing.
 */
export function isFetchablePort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && !BLOCKED.has(port);
}

/**
 * Ask the OS for a free port, and keep asking until the answer is one a client
 * can reach.
 *
 * `listen(0)` allocates from the dynamic range in order, so a blocked answer is
 * not a dead end — the next call lands on the next port. The retry is bounded so
 * a machine with a pathological range fails loudly instead of spinning.
 */
export function freePort({ attempts = 16 } = {}) {
  const tryOnce = () => new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

  return (async () => {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const port = await tryOnce();
      if (isFetchablePort(port)) return port;
      last = port;
    }
    throw new Error(
      `freePort: ${attempts} ephemeral ports in a row were unreachable `
      + `(last: ${last}). The fetch standard blocks ${BLOCKED_PORTS.length} ports; `
      + 'pass an explicit port outside them instead.',
    );
  })();
}

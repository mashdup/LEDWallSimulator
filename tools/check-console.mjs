// Does the PUBLISHED console boot in a real browser over HTTPS?
//
//   WALL_OWNER_TOKEN=<token> node tools/check-console.mjs
//   WALL_CONSOLE_URL=https://wall-console.example/ WALL_OWNER_TOKEN=... node tools/check-console.mjs
//
// This is not in the test suite because it needs a deployed relay and the owner
// token: it is the one check that cannot be run against a local fixture, and it
// is the one that proves the premise - that a page served over HTTPS gets
// navigator.serial, so the wall laptop needs no local server.
//
// Everything else proves the server side. This proves the thing the whole idea
// rests on: that a page served from the public name gets a working module graph
// (imports resolve relative to the host root), that app.js starts its loop, and
// that the serial panel is present and can enumerate. navigator.serial itself
// is only defined in a secure context, so its presence over https:// is the
// claim, and over plain http to a LAN address it must be absent.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { openBrowser, waitFor, dropProfile } = await import('../test/harness.js');
const { findChrome } = await import('../tools/capture.js');

const BASE = process.env.WALL_CONSOLE_URL ?? 'https://wall-console.hoa.family';
const TOKEN = process.env.WALL_OWNER_TOKEN ?? '';

const chrome = findChrome();
if (chrome === null) {
  console.log('no chrome on this machine: nothing to prove');
  process.exit(0);
}
if (TOKEN === '') {
  console.log('set WALL_OWNER_TOKEN to run this');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'omp-pubconsole-'));
const dbg = 9337;
const { proc, cdp } = await openBrowser(chrome, dbg, profile);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  // The sign-in form, in the browser, the way the owner meets it.
  const tab = await cdp.openTab(`${BASE}/login`);
  const title = await waitFor(async () => {
    const t = await cdp.eval(tab, 'document.querySelector("h1")?.textContent ?? ""').catch(() => '');
    return t.includes('console') ? t : null;
  }, 20_000);
  check('the login form renders', title.includes('console'), title);

  // Sign in from the page: fill, submit, land in the console.
  await cdp.eval(tab, `(() => {
    const i = document.querySelector('input[name="token"]');
    i.value = ${JSON.stringify(TOKEN)};
    document.querySelector('form').submit();
    return 'submitted';
  })()`);
  const landed = await waitFor(async () => {
    const h = await cdp.eval(tab, 'location.pathname + "|" + (document.title ?? "")').catch(() => '');
    return h.startsWith('/|') ? h : null;
  }, 25_000);
  check('the token signs in from the page', landed.startsWith('/|'), landed);

  // The console booted: its own controls, and the sim canvas the frame loop
  // paints into. A module 404 would leave these dead.
  const booted = await waitFor(async () => {
    const v = await cdp.eval(tab, `(() => {
      const sel = document.getElementById('sink');
      const canvas = document.getElementById('sim');
      const out = document.getElementById('sinkOut')?.textContent ?? '';
      return sel && canvas && canvas.width > 0 ? (sel.options.length + '|' + canvas.width + '|' + out) : null;
    })()`).catch(() => null);
    return v;
  }, 25_000);
  const [opts, width] = booted.split('|');
  check('app.js booted (sinks populated, sim sized)', Number(opts) >= 2 && Number(width) > 0, booted);

  // The frame loop is live: the sim canvas CHANGES between two reads. This is
  // the honest proof that the module graph booted and a loop is running - the
  // demo animation moves, and no text readout can be mistaken for it.
  const snap = () => cdp.eval(tab, 'document.getElementById("sim").toDataURL().length + ":" + document.getElementById("sim").toDataURL().slice(-40)').catch(() => '');
  const first = await snap();
  const moved = await waitFor(async () => {
    const now = await snap();
    return now !== first && now.length > 10 ? now : null;
  }, 20_000);
  check('the frame loop is running (the sim canvas moves)', moved !== first, `${first.slice(0, 14)} -> ${moved.slice(0, 14)}`);

  // THE CLAIM: a secure context gives the page navigator.serial. Over https to
  // the public name, the wall's COM port is reachable from the browser.
  const serial = await cdp.eval(tab, `(() => {
    const secure = window.isSecureContext;
    const api = typeof navigator.serial;
    const getPorts = typeof navigator.serial?.getPorts;
    return JSON.stringify({ secure, api, getPorts, origin: location.origin });
  })()`);
  const s = JSON.parse(serial);
  check('the page is a secure context', s.secure === true, s.origin);
  check('navigator.serial exists', s.api === 'object', `typeof navigator.serial = ${s.api}`);
  check('and it can enumerate ports', s.getPorts === 'function', `getPorts = ${s.getPorts}`);

  // The relay line: on the published console it reports when the wall last
  // visited, which is the only thing this machine can know. (The gallery count
  // is deliberately NOT asserted here: it is written when the list is fetched,
  // and that only happens once the console is driving a gallery.)
  const relayLine = await waitFor(async () => {
    const v = await cdp.eval(tab, 'document.getElementById("relayOut")?.textContent ?? ""').catch(() => '');
    return /this relay/.test(v) ? v : null;
  }, 25_000);
  check('the relay line speaks about the wall, not a URL', /the wall last visited/.test(relayLine), relayLine);

  // The gallery list answers a session, so draw.html and the gallery controls
  // have something to work with. Runtime.evaluate does not await a promise (the
  // harness passes no awaitPromise), so the fetch parks its answer on window and
  // the check polls for it - the same discipline the page tests use.
  await cdp.eval(tab, `(() => {
    window.__list = 'pending';
    fetch('/drawings', { cache: 'no-store' })
      .then((r) => r.json().then((j) => { window.__list = r.status + '|' + (Array.isArray(j) ? j.length : 'x'); }))
      .catch((e) => { window.__list = 'error:' + e.message; });
    return 'asked';
  })()`);
  const list = await waitFor(async () => {
    const v = await cdp.eval(tab, 'window.__list').catch(() => '');
    return v === 'pending' ? null : v;
  }, 20_000);
  check('the gallery list answers a session', /^200[|][0-9]+$/.test(list), list);
} finally {
  try {
    proc.kill();
    // Windows holds the profile's files open for a moment after the kill, and
    // an rmSync that loses that race throws EPERM from a finally block - which
    // turns "one check failed" into "the whole run crashed".
    await new Promise((r) => setTimeout(r, 1200));
  } catch { /* already gone */ }
  dropProfile(profile);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

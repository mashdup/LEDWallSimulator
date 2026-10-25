// tools/serial.js - "is this COM port free?" without a native module.
//
// A COM port is exclusive: if another program (Arduino IDE monitor, PuTTY, a
// stale bridge) holds it, port.open() in the app fails with a generic
// 'Failed to open serial port'. That failure arrives AFTER the user clicked
// Connect, with no hint about who holds the port. This probe test-opens each
// port from OUTSIDE the app via PowerShell's SerialPort class, so the app can
// warn before the click.
//
// Side effect worth knowing: opening a port toggles DTR/RTS, and the ESP32
// auto-reset circuit reads that as a reset request. The probe therefore
// REBOOTS a connected ESP32. Harmless here (the firmware streams from
// whatever the host sends next, and the watchdog is disabled), but it is why
// the probe is cached and lazy, not hammered.

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// Enumerate, then test-open each port. 'FREE' = we opened and closed it;
// anything else (busy, access denied, gone) = 'BUSY'.
const PROBE_PS = [
  'foreach ($p in [System.IO.Ports.SerialPort]::GetPortNames()) {',
  '$r = "BUSY";',
  'try { $s = New-Object System.IO.Ports.SerialPort $p; $s.Open(); $s.Close(); $s.Dispose(); $r = "FREE" } catch { }',
  'Write-Output "$p=$r"',
  '}',
].join(' ');

/**
 * Parse PowerShell probe output ('COM8=FREE') into port records. Tolerates
 * banners, blank lines and CRLF noise: only exact 'COMn=FREE|BUSY' lines count.
 */
export function parseProbeOutput(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(COM\d+)=(FREE|BUSY)$/i.exec(line.trim());
    if (m) out.push({ port: m[1].toUpperCase(), state: m[2].toUpperCase() });
  }
  return out;
}

// ---- the POSIX half (macOS / Linux) ---------------------------------------
//
// The Windows probe test-opens every port, which is the only way to learn
// 'busy' there, and it reboots the ESP32 while at it. On a Mac that is both
// unnecessary and rude: `lsof` names the process holding a /dev/cu.* node,
// so the probe has no side effects at all. Enumeration mirrors what Chromium
// lists, because a port the app cannot open is not worth warning about:
// macOS exposes USB-UARTs as cu.usbmodem*/cu.usbserial*/cu.wchusbserial*, and
// lists two things that are never a cable (cu.Bluetooth-*, cu.debug-console);
// Linux uses ttyACM*/ttyUSB*.

const POSIX_NOISE = /bluetooth|debug-console|pda-sync|wlan|irda/i;

/** Real serial devices in /dev, as Chromium's Web Serial would list them. */
export function posixPortNames(platform = process.platform) {
  let names;
  try {
    names = readdirSync('/dev');
  } catch {
    return [];
  }
  const keep =
    platform === 'darwin'
      ? (n) => /^cu\./.test(n) && !POSIX_NOISE.test(n)
      : (n) => /^tty(ACM\d+|USB\d+|CH34\d|wchusbserial|ACM)/.test(n) || /^ttyUSB\d+$/.test(n);
  return names.filter(keep).sort();
}

/**
 * Which of these /dev nodes some process already has open. One lsof call for
 * the whole list; `+c 0` so long app paths ('/Applications/LED Wall.app/…')
 * are not truncated to lsof's 19-char default and lose the identity the
 * takeover's kill-list depends on. No lsof (bare container): report NOTHING
 * busy — a warning we cannot back up is worse than no warning.
 */
export function posixBusyNames(names, run = spawnSync) {
  if (names.length === 0) return new Set();
  const devices = names.map((n) => `/dev/${n}`);
  const r = run('lsof', ['-n', '-P', '+c', '0', '-F', 'pcn', '--', ...devices], {
    encoding: 'utf8',
    timeout: 8000,
  });
  if (r === undefined || r.error) return new Set();
  const busy = new Set();
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (!line.startsWith('n')) continue;
    const name = line.slice(1).split(':')[0]; // 'n/dev/cu.usbmodemX' (locks append :lock)
    const base = name.replace(/^\/dev\//, '');
    if (names.includes(base)) busy.add(base);
  }
  return busy;
}

let cache = { at: 0, ports: [] };
const CACHE_MS = 3000;
// PowerShell cold start on a busy Windows machine measured > 5 s; a tight
// timeout made the probe kill itself mid-startup. 15 s is patient.
const PROBE_TIMEOUT_MS = 15000;

/**
 * Probe the machine. Cached for CACHE_MS so Connect-click spam is free.
 * NEVER rejects and NEVER throws asynchronously: this runs inside the dev
 * server, and an uncaught exception in the probe's timeout timer took the
 * whole server down - 'kill("ignore")' is POSIX-only and throws on Windows
 * (ERR_UNKNOWN_SIGNAL), so a slow PowerShell killed the show: blank content
 * and a dead Connect, both blamed on the app. Every failure mode resolves
 * to [] and the app stays quiet about it.
 */
export async function serialPorts(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!opts.bypassCache && Date.now() - cache.at < CACHE_MS) return cache.ports;
  // Non-Windows: enumerate /dev and ask lsof who holds what. The PowerShell
  // probe below answers [] on a Mac (spawn fails), which made the app's
  // pre-flight and its port-name seed dead on every non-Windows machine.
  if (process.platform !== 'win32') {
    const names = posixPortNames(process.platform);
    const busy = posixBusyNames(names, opts.run ?? spawnSync);
    const ports = names.map((n) => ({
      port: n,
      path: `/dev/${n}`,
      state: busy.has(n) ? 'BUSY' : 'FREE',
    }));
    cache = { at: Date.now(), ports };
    return ports;
  }
  const ports = await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done(parseProbeOutput(body));
    };
    let body = '';
    let ps;
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE_PS], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      done([]); // spawn itself refused
      return;
    }
    ps.stdout.on('data', (d) => { body += d; });
    ps.on('error', () => done([])); // no PowerShell (non-Windows): report nothing
    ps.on('close', finish);
    const timer = setTimeout(() => {
      // A valid signal only: 'ignore' throws ERR_UNKNOWN_SIGNAL on Windows,
      // and this timer runs on the SERVER's event loop - an exception here
      // is a crashed dev server, which is exactly the regression this fixes.
      try {
        ps.kill(); // SIGTERM; TerminateProcess on Windows
      } catch {
        // Already exited, or the OS refuses: nothing to clean up.
      }
      finish();
    }, timeoutMs);
    timer.unref?.();
  });
  cache = { at: Date.now(), ports };
  return ports;
}

// ---- port takeover ---------------------------------------------------------

import { findHolders, killHolders } from './freeport-scan.js';

/**
 * Take a COM port away from a dead app's corpse. When the wall app dies
 * mid-connection (window closed uncleanly, killed process), its Electron
 * process - or a child of it - can keep the COM handle, and the next
 * Connect fails on a port the OS says is busy. The only force-disconnect
 * on Windows is to terminate the holder, so we do that ONLY for our own
 * app's binary (electron.exe running our main.cjs tree); any other holder
 * (Arduino IDE, PuTTY, a firmware flasher) is reported untouched - killing
 * a user's editor mid-edit is not a side effect a Connect click should
 * have. Never throws.
 */
export function serialTakeOver(port, opts = {}) {
  void opts; // (killHolders spawns its own taskkill; no injectables needed)
  const p = String(port ?? '').trim();
  if (process.platform === 'win32') {
    if (!/^COM\d{1,3}$/i.test(p)) return Promise.resolve({ ok: false, error: `invalid port name '${port}'`, results: [] });
    const found = findHolders(p);
    if (!found.ok) return Promise.resolve({ ok: false, error: found.error, results: [] });
    const killable = (name) => /^electron(\.exe)?$/i.test(name);
    const results = killHolders(found.holders, killable);
    return Promise.resolve({
      ok: true,
      error: null,
      holders: found.holders,
      results,
      killed: results.filter((r) => r.killed).map((r) => r.pid),
      spared: results.filter((r) => !r.killed).map((r) => ({ pid: r.pid, name: r.name, reason: r.reason })),
    });
  }
  // macOS/Linux: the same rule, a different kill. On a Mac the holder of a
  // Web Serial port is the app's own utility process ('Electron Helper' /
  // 'LED Wall Helper'), so the auto-kill list is our binaries plus electron —
  // and nothing else. A holder named 'arduino-ide' is reported and spared.
  const found = findHolders(p);
  if (!found.ok) return Promise.resolve({ ok: false, error: found.error, results: [] });
  const killable = (name) =>
    /(^|[\/])(electron|LED Wall|LED Wall Helper[^\/]*|led-wall\S*)$/i.test(String(name)) ||
    /LED Wall\.app\/Contents/i.test(String(name));
  const results = killHolders(found.holders, killable);
  return Promise.resolve({
    ok: true,
    error: null,
    holders: found.holders,
    results,
    killed: results.filter((r) => r.killed).map((r) => r.pid),
    spared: results.filter((r) => !r.killed).map((r) => ({ pid: r.pid, name: r.name, reason: r.reason })),
  });
}

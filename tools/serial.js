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

import { spawn } from 'node:child_process';

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
  const p = String(port ?? '').toUpperCase();
  if (!/^COM\d{1,3}$/.test(p)) return Promise.resolve({ ok: false, error: `invalid port name '${port}'`, results: [] });
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

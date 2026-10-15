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

/** Probe the machine. Cached for CACHE_MS so Connect-click spam is free. */
export async function serialPorts() {
  if (Date.now() - cache.at < CACHE_MS) return cache.ports;
  const ports = await new Promise((done) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE_PS], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let body = '';
    ps.stdout.on('data', (d) => { body += d; });
    const finish = () => done(parseProbeOutput(body));
    ps.on('error', () => done([])); // no PowerShell (non-Windows): report nothing
    ps.on('close', finish);
    setTimeout(() => { ps.kill('ignore'); finish(); }, 5000).unref?.();
  });
  cache = { at: Date.now(), ports };
  return ports;
}

// macOS dev builds: make `npm run wall` able to touch Web Serial at all.
//
// The first serial call in a renderer starts Chromium's serial stack, which
// enumerates Bluetooth serial devices. That ask goes through TCC, and TCC
// refuses (and aborts the process) when the bundle that asks has no
// NSBluetoothAlwaysUsageDescription:
//
//   __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__
//
// Electron's prebuilt helpers have no such key, and an ad-hoc signed binary
// cannot be granted access, so on Apple silicon every dev run died on the
// serial call - the venue log stopped at 'window loaded' and said nothing
// about serial, which reads like a hung picker and is really a dead process.
// The release build survives because Developer ID signing lets macOS show
// the one-time Bluetooth prompt (and the release build's helper plists now
// carry the key; see tools/electron/afterPack.cjs).
//
// So patch the dev Electron.app: the key in the main plist and in every
// helper plist, then re-sign ad-hoc (modifying Info.plist breaks the
// signature). npm ci throws this away, so this runs from the launcher every
// time - it is idempotent and only re-signs when it changed something.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = {
  NSBluetoothAlwaysUsageDescription:
    'The LED wall lists serial devices, and macOS includes Bluetooth serial ports in that list.',
  NSBluetoothPeripheralUsageDescription:
    'The LED wall lists serial devices, and macOS includes Bluetooth serial ports in that list.',
};

export const devElectronApp = (root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) =>
  path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');

/** Every Info.plist that can be charged the Bluetooth ask. */
export function plistTargets(app) {
  const out = [path.join(app, 'Contents', 'Info.plist')];
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  if (!existsSync(frameworks)) return out;
  for (const name of (spawnSync('ls', [frameworks], { encoding: 'utf8' }).stdout || '').split('\n')) {
    const trimmed = name.trim();
    if (/Helper(\s*\([^)]*\))?\.app$/.test(trimmed)) out.push(path.join(frameworks, trimmed, 'Contents', 'Info.plist'));
  }
  return out.filter(existsSync);
}

/** Insert the usage descriptions. Returns the plists that changed. */
export function patchPlists(app) {
  const touched = [];
  for (const plist of plistTargets(app)) {
    let changed = false;
    for (const [key, value] of Object.entries(KEYS)) {
      // macOS plutil has no -key (that is GNU plutil); -extract is the probe.
      if (spawnSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).status === 0) continue;
      const res = spawnSync('plutil', ['-insert', key, '-string', value, plist], { encoding: 'utf8' });
      if (res.status !== 0) return { ok: false, error: `${plist}: ${(res.stderr || res.stdout || 'plutil failed').trim()}` };
      changed = true;
    }
    if (changed) touched.push(plist);
  }
  return { ok: true, touched };
}

/**
 * Make the dev Electron.app serial-capable. sign: pass false to only check.
 * Returns { ok, patched, signed, error }.
 */
export function ensureDevSerialPlist(app = devElectronApp(), { sign = true } = {}) {
  if (!existsSync(app)) return { ok: false, error: `no dev Electron.app at ${app}` };
  const { ok, touched, error } = patchPlists(app);
  if (!ok) return { ok: false, error };
  if (!touched.length) return { ok: true, patched: false, signed: false };
  if (!sign) return { ok: true, patched: true, signed: false };
  const res = spawnSync('codesign', ['--force', '--deep', '-s', '-', app], { encoding: 'utf8', timeout: 180000 });
  // An ad-hoc signature is what makes the patched bundle launchable again.
  if (res.status !== 0) return { ok: false, patched: true, error: `codesign: ${(res.stderr || res.stdout || 'failed').trim()}` };
  return { ok: true, patched: true, signed: true };
}

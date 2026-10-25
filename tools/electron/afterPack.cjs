// electron-builder afterPack hook (macOS).
//
// Web Serial on macOS enumerates Bluetooth serial devices too (a paired
// Bluetooth modem shows up as /dev/cu.Bluetooth-Incoming-Port), so the
// serial stack asks TCC for Bluetooth access. TCC reads the usage
// description from the bundle of the process that ASKS - and the ask comes
// from a Helper app, not the main app. Electron's prebuilt helpers ship
// without NSBluetoothAlwaysUsageDescription, and electron-builder's helper
// plists do not add it. The main app's plist has it, which is why a
// Developer ID signed build survives on a machine that already granted the
// prompt - and why anything else (a local build, an unsigned CI run, a dev
// build) dies on the first serial call with:
//
//   __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__
//   "The app's Info.plist must contain an NSBluetoothAlwaysUsageDescription key"
//
// Measured on this mac on 2026-10-25: every locally built and every
// ad-hoc-re-signed copy aborted there, with the venue log stopping right
// after 'window loaded' - the wall never got a serial request, so the log
// said nothing about serial at all.
//
// So: put the key in every helper bundle's Info.plist. It costs nothing and
// makes the release build independent of the TCC-grant-then-re-sign dance.

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KEYS = {
  NSBluetoothAlwaysUsageDescription:
    'The LED wall lists serial devices, and macOS includes Bluetooth serial ports in that list.',
  NSBluetoothPeripheralUsageDescription:
    'The LED wall lists serial devices, and macOS includes Bluetooth serial ports in that list.',
};

/** Insert the keys into one Info.plist. Returns a one-line description of what changed. */
function addKeys(plist, plutil) {
  const out = [];
  for (const [key, value] of Object.entries(KEYS)) {
    // macOS plutil has no -key (that is GNU plutil); -extract is the probe.
    const check = spawnSync(plutil, ['-extract', key, 'raw', plist], { encoding: 'utf8' });
    if (check.status === 0) continue; // already declared
    const res = spawnSync(plutil, ['-insert', key, '-string', value, plist], { encoding: 'utf8' });
    if (res.status !== 0) return { ok: false, error: `${key}: ${res.stderr || res.stdout || 'plutil failed'}`.trim() };
    out.push(key);
  }
  return { ok: true, added: out };
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  const plutil = spawnSync('which', ['plutil'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/plutil';

  const targets = [path.join(appPath, 'Contents', 'Info.plist')];
  const ls = spawnSync('ls', [frameworks], { encoding: 'utf8' });
  for (const name of (ls.stdout || '').split('\n')) {
    if (/Helper(\s*\([^)]*\))?\.app$/.test(name.trim())) targets.push(path.join(frameworks, name.trim(), 'Contents', 'Info.plist'));
  }

  const notes = [];
  for (const plist of targets) {
    const res = addKeys(plist, plutil);
    if (!res.ok) context.packager.info.warn(`serial bluetooth plist: ${plist} - ${res.error}`);
    else if (res.added.length) notes.push(`${path.basename(path.dirname(path.dirname(plist)))}: ${res.added.join(', ')}`);
  }
  if (notes.length) context.packager.info.info(`serial bluetooth plist: ${notes.join(' | ')}`);
};

// Plain node runs (the dev patch) reuse this with a console reporter.
module.exports.addKeys = addKeys;

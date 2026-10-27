/**
 * The wall's own calibration is persisted, and every control is in the list.
 *
 * The power budget and the LED fine-tune are properties of the HARDWARE, dialed
 * once per wall. Losing them on a reload is the failure this defends: the wall
 * comes back dim and colour-cast until someone re-dials it.
 *
 * app.js is browser code, so this checks the two things that can silently drift
 * apart — the persisted id list and the controls in the markup. A slider added
 * without being added to SETTINGS_IDS would simply not persist, and nothing on
 * screen would say so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

/** The ids app.js persists, read out of its own SETTINGS_IDS array. */
function persistedIds() {
  const block = /const SETTINGS_IDS = \[([\s\S]*?)\];/.exec(app);
  assert.ok(block, 'SETTINGS_IDS must exist');
  return [...block[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
}

test('every persisted setting has a control in the markup', () => {
  const ids = persistedIds();
  assert.ok(ids.length >= 8, `expected the whole calibration, saw ${ids.length}`);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no control with id="${id}"`);
  }
});

test('the persisted list is exactly the wall calibration', () => {
  // Pinned so a NEW control is a conscious decision to persist it or not.
  assert.deepEqual(persistedIds().sort(), [
    'blackLevel', 'brightness', 'gamma', 'headroom',
    'limitMa', 'saturation', 'temperature', 'tint',
  ]);
});

test('the markup carries the wall calibration as the starting point', () => {
  // A fresh browser (no localStorage) must start at the wall's own settings, not
  // at generic defaults. Pinned so a stray edit to a value= is a test failure.
  const defaults = {};
  for (const id of persistedIds()) {
    const m = new RegExp(`id="${id}"[^>]*value="([^"]+)"`).exec(html);
    assert.ok(m, `no value= on the control for ${id}`);
    defaults[id] = Number(m[1]);
  }
  assert.deepEqual(defaults, {
    limitMa: 24000,
    brightness: 0.5,
    headroom: 0.1,
    saturation: 1.1,
    gamma: 1.5,
    temperature: 0.55,
    tint: 0.25,
    blackLevel: 9,
  });
});

test('the fine-tune readout exists, and is refreshed on load and on input', () => {
  assert.ok(html.includes('id="tuneOut"'), 'the readout element must exist');
  assert.match(app, /for \(const id of SETTINGS_IDS\) \$\(id\)\.addEventListener\('input', saveSettings\)/);
  assert.match(app, /function loadSettings\(\)/, 'loadSettings must exist');
  assert.match(app, /\nloadSettings\(\);/, 'loadSettings must be called at boot');
});

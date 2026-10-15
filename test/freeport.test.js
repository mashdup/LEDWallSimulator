import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePortArgs, formatHolders, shouldKill } from '../tools/freeport-args.js';

/**
 * 'Force disconnect' on Windows means killing the holder - the dangerous
 * part is pointing it at the wrong port, so the arg gate is the tested
 * contract: exactly one COMn, only --kill as a flag.
 */

test('parsePortArgs accepts a COM port and optional --kill', () => {
  assert.deepEqual(parsePortArgs(['COM8']), { ok: true, port: 'COM8', kill: false });
  assert.deepEqual(parsePortArgs(['com8', '--kill']), { ok: true, port: 'COM8', kill: true });
  assert.equal(shouldKill(parsePortArgs(['COM8', '--kill'])), true);
  assert.equal(shouldKill(parsePortArgs(['COM8'])), false);
});

test('parsePortArgs rejects missing, extra, or non-COM positional args', () => {
  assert.equal(parsePortArgs([]).ok, false);
  assert.equal(parsePortArgs(['COM8', 'COM9']).ok, false);
  assert.equal(parsePortArgs(['LPT1']).ok, false);
  assert.equal(parsePortArgs(['8']).ok, false);
});

test('parsePortArgs rejects unknown flags with a named complaint', () => {
  const r = parsePortArgs(['COM8', '--force']);
  assert.equal(r.ok, false);
  assert.match(r.usage, /unknown flag --force/);
});

test('formatHolders names pid, process and device - the point of the tool', () => {
  const text = formatHolders([
    { pid: 17660, name: 'electron', device: '\\Device\\Serial2' },
    { pid: 42, name: 'arduino-ide', device: '\\Device\\Serial2' },
  ]);
  assert.match(text, /pid 17660 \(electron\)/);
  assert.match(text, /pid 42 \(arduino-ide\)/);
});

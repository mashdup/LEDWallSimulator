/**
 * The preview is the DESIGN; saturation and gamma are the LED fine-tune.
 *
 * Saturation and gamma configure the physical wall — they compensate for the
 * diffuser and the beads' response — so they must not move the picture on
 * screen. The failure this defends is easy to reintroduce: both were applied to
 * `panel.pixels` before packing, and the preview draws the packed bytes, so an
 * operator tuning the wall watched the design change instead.
 *
 * app.js is browser code and its frame loop is a closure, so this asserts the
 * one thing that can go wrong — the pipeline order — against the source, the
 * same way animations.test.js asserts content.html owns no renderer of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('the LED fine-tune lands on the wire bytes, never on the preview', () => {
  assert.ok(
    /applyColor\(packed,/.test(src),
    'applyColor must tune the packed wire bytes',
  );
  assert.ok(
    !/applyColor\(panel\.pixels/.test(src),
    'applyColor must not tune panel.pixels: the preview would show the fine-tune',
  );
});

test('the preview draws the untuned design, the sink gets the tuned bytes', () => {
  assert.ok(
    /sim\.drawWall\(preview,/.test(src),
    'draw() must paint `preview` (the design), not `packed` (the tuned wire)',
  );
  assert.ok(
    /encodeFrameInto\(wire, seq, packed\)/.test(src),
    'the encoder must send `packed`, the tuned bytes',
  );
});

test('the pipeline order is pack -> snapshot the design -> tune the wire', () => {
  const pack = src.indexOf('packInto(panel, layout, packed)');
  const snap = src.indexOf('preview.set(packed)');
  const tune = src.indexOf('applyColor(packed');
  assert.ok(pack >= 0 && snap >= 0 && tune >= 0, 'all three steps must exist');
  assert.ok(pack < snap, 'the design must be packed before it is snapshotted');
  assert.ok(snap < tune, 'the snapshot must happen before the wire is tuned');
});

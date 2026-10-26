import test from 'node:test';
import assert from 'node:assert/strict';
import { metaDelivery } from '../core/metalink.js';

test('fresh wall owes the brightness, then a told number is not owed again', () => {
  const d = metaDelivery();
  assert.ok(d.owed(200), 'a wall that has heard nothing must be told');
  d.told(200, true);
  assert.ok(!d.owed(200), 'a told brightness must not be re-sent every frame');
  assert.ok(d.owed(120), 'a changed brightness is owed');
});

test('a refused send stays owed, so the next frame retries', () => {
  const d = metaDelivery();
  d.told(180, false); // cable out: sink.send() returned false
  assert.ok(d.owed(180), 'a refused meta was never delivered: it must be owed');
  d.told(180, true);
  assert.ok(!d.owed(180), 'once accepted it is told');
});

test('the reconnect bug: link back means the wall rebooted and forgot everything', () => {
  // The field report: "the LEDs ignore the brightness setting". The serial
  // sink reconnected itself after a USB sag; the ESP32 power-cycled to its
  // default brightness; the loop's send-on-change rule had nothing to send.
  const d = metaDelivery();
  d.told(140, true);
  assert.ok(!d.owed(140));
  assert.equal(d.noteLink(false), false, 'going down is not a link return');
  assert.equal(d.noteLink(true), true, 'coming back is a link return');
  assert.ok(d.owed(140), 'the SAME number is owed again: the device forgot it');
  d.told(140, true);
  assert.ok(!d.owed(140), 'and it settles back to quiet once retold');
});

test('a link that never drops never forces a re-send', () => {
  const d = metaDelivery();
  d.told(200, true);
  for (let i = 0; i < 1000; i++) assert.equal(d.noteLink(true), false);
  assert.ok(!d.owed(200), 'a steady link stays quiet: no 30 Hz meta spam');
});

test('meta refused during the dark window survives the reconnect', () => {
  // Slider moved while the cable was out: the send is refused, the link
  // drops, the link comes back - the number must still reach the wall.
  const d = metaDelivery();
  d.told(140, true);
  d.noteLink(false);
  d.told(90, false); // refused: the new value is owed, not latched
  assert.ok(d.owed(90));
  d.noteLink(true);
  assert.ok(d.owed(90), 'after the reconnect the pending value is still owed');
  d.told(90, true);
  assert.ok(!d.owed(90));
});

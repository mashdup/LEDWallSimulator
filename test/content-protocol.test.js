import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_CHANNEL,
  CONTENT_PROTOCOL_V,
  CONTENT_KINDS,
  ANIM_NAMES,
  GAP_ANIM_NAMES,
  TRANSITION_NAMES,
  GALLERY_DEFAULTS,
  galleryPeriod,
  galleryTiming,
  galleryFrame,
  makeMessage,
  parseMessage,
} from '../core/content-protocol.js';
import { emptyPixels, pixelsToHex, PIXEL_HEX_LEN, GRID } from '../core/drawings.js';
import { readFileSync } from 'node:fs';

test('channel and version are stable names', () => {
  assert.equal(CONTENT_CHANNEL, 'ledwall-content');
  assert.equal(CONTENT_PROTOCOL_V, 1);
  assert.deepEqual(CONTENT_KINDS, ['clear', 'fill', 'rect', 'text', 'anim', 'pic', 'gallery']);
});

test('clear normalizes to a bare versioned message', () => {
  assert.deepEqual(makeMessage('clear'), {v: 1, kind: 'clear'});
});

test('fill requires a color', () => {
  assert.deepEqual(makeMessage('fill', {color: '#ff8800'}), {v: 1, kind: 'fill', color: '#ff8800'});
  assert.deepEqual(makeMessage('fill', {color: 'red'}), {v: 1, kind: 'fill', color: 'red'});
  assert.throws(() => makeMessage('fill'), RangeError);
  assert.throws(() => makeMessage('fill', {color: '#zzz'}), RangeError);
  assert.throws(() => makeMessage('fill', {color: 'rgb(1,2,3)'}), RangeError);
});

test('rect requires in-range integers and a color', () => {
  assert.deepEqual(makeMessage('rect', {x: 0, y: 0, w: 2, h: 2, color: '#fff'}),
    {v: 1, kind: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#fff'});
  for (const bad of [{x: -1, y: 0, w: 1, h: 1, color: 'red'},
                     {x: 0, y: 0, w: 0, h: 1, color: 'red'},
                     {x: 0.5, y: 0, w: 1, h: 1, color: 'red'},
                     {x: 0, y: 0, w: 1, h: 1}]) {
    assert.throws(() => makeMessage('rect', bad), RangeError, JSON.stringify(bad));
  }
});

test('text requires non-empty bounded text; options are validated', () => {
  assert.deepEqual(makeMessage('text', {text: 'hello'}), {v: 1, kind: 'text', text: 'hello'});
  assert.deepEqual(makeMessage('text', {text: 'hi', color: 'red', fps: 12, step: 2, loop: false}),
    {v: 1, kind: 'text', text: 'hi', color: 'red', fps: 12, step: 2, loop: false});
  assert.throws(() => makeMessage('text', {text: ''}), RangeError);
  assert.throws(() => makeMessage('text', {text: 'x'.repeat(2001)}), RangeError);
  assert.throws(() => makeMessage('text', {text: 'hi', fps: 0}), RangeError);
  assert.throws(() => makeMessage('text', {text: 'hi', fps: 121}), RangeError);
  assert.throws(() => makeMessage('text', {text: 'hi', loop: 'yes'}), RangeError);
});

test('anim is a known name, nothing else', () => {
  assert.deepEqual(makeMessage('anim', {name: 'demo'}), {v: 1, kind: 'anim', name: 'demo'});
  assert.deepEqual(makeMessage('anim', {name: 'off'}), {v: 1, kind: 'anim', name: 'off'});
  for (const name of ANIM_NAMES) {
    assert.equal(makeMessage('anim', {name}).name, name);
  }
  assert.throws(() => makeMessage('anim', {name: 'party'}), RangeError);
});

test('pic carries a drawing in the wire form, and nothing else', () => {
  const hex = pixelsToHex(emptyPixels());
  assert.equal(makeMessage('pic', {pixels: hex}).pixels, hex);
  // Uppercase hex is normalized: the store, the renderer, and the byte-for-byte
  // pixel-identity tests all compare the wire form as text.
  assert.equal(makeMessage('pic', {pixels: hex.toUpperCase()}).pixels, hex);
  for (const bad of [{}, {pixels: ''}, {pixels: 'zz'.repeat(1600)},
                     {pixels: pixelsToHex(emptyPixels()).slice(0, -2)},
                     {pixels: 'x'.repeat(PIXEL_HEX_LEN)}]) {
    assert.throws(() => makeMessage('pic', bad), RangeError, JSON.stringify(bad));
  }
});

test('gallery is a cadence, not a payload: the list lives on the server', () => {
  assert.deepEqual(makeMessage('gallery'), {v: 1, kind: 'gallery'});
  assert.deepEqual(makeMessage('gallery', {interval: 8}), {v: 1, kind: 'gallery', interval: 8});
  for (const bad of [{interval: 0}, {interval: -1}, {interval: 601}, {interval: 1.5}, {interval: '8'}]) {
    assert.throws(() => makeMessage('gallery', bad), RangeError, JSON.stringify(bad));
  }
});

test('parseMessage accepts objects and JSON strings, drops everything illegal', () => {
  assert.deepEqual(parseMessage('{"v":1,"kind":"clear"}'), {v: 1, kind: 'clear'});
  assert.deepEqual(parseMessage({v: 1, kind: 'clear'}), {v: 1, kind: 'clear'});
  for (const bad of ['not json', '{"v":2,"kind":"clear"}', '{"v":1,"kind":"dance"}',
                     '{"v":1}', null, undefined, 42, [], '',
                     '{"v":1,"kind":"fill"}',
                     '{"v":1,"kind":"text","text":""}',
                     '{"v":1,"kind":"anim"}',
                     '{"v":1,"kind":"pic"}',
                     '{"v":1,"kind":"pic","pixels":"deadbeef"}',
                     '{"v":1,"kind":"gallery","interval":0}']) {
    assert.equal(parseMessage(bad), null, String(bad));
  }
});

test('parseMessage strips unknown fields from a legal envelope', () => {
  // A sender may add fields for its own protocol version; the receiver keeps
  // only what the kinds define, so a stray payload never reaches the canvas.
  const m = parseMessage({v: 1, kind: 'clear', smuggled: 'exec()'});
  assert.deepEqual(m, {v: 1, kind: 'clear'});
});

test('the gallery carries a break: gap seconds and which animation fills them', () => {
  assert.deepEqual(makeMessage('gallery', {interval: 8, gap: 5, gapAnim: 'rain'}),
    {v: 1, kind: 'gallery', interval: 8, gap: 5, gapAnim: 'rain'});
  // gap 0 is legal and means no break - the gallery is plain cycling again.
  assert.deepEqual(makeMessage('gallery', {gap: 0}), {v: 1, kind: 'gallery', gap: 0});
  // 'none' is a name here, and every anim name is: the select is built from
  // this list, so a control page can never offer a break the wall refuses.
  assert.deepEqual(GAP_ANIM_NAMES, ['none', ...ANIM_NAMES]);
  assert.deepEqual(makeMessage('gallery', {gapAnim: 'none'}), {v: 1, kind: 'gallery', gapAnim: 'none'});
  for (const bad of [{gap: -1}, {gap: 601}, {gap: 1.5}, {gap: '5'}, {gap: null},
                     {gapAnim: 'dancing'}, {gapAnim: 5}, {gapAnim: ''},
                     {transition: 'teleport'}, {transition: 5},
                     {transitionSec: -1}, {transitionSec: 31}, {transitionSec: 0.5}, {transitionSec: '1'}]) {
    assert.throws(() => makeMessage('gallery', bad), RangeError, JSON.stringify(bad));
  }
});

test('the default break is a real animation, not a dark wall', () => {
  assert.ok(GALLERY_DEFAULTS.gap > 0, 'a gallery with no break has no break to configure');
  assert.ok(GAP_ANIM_NAMES.includes(GALLERY_DEFAULTS.gapAnim));
  assert.notEqual(GALLERY_DEFAULTS.gapAnim, 'none');
  assert.ok(GALLERY_DEFAULTS.interval > 0);
  // A gallery that hard-cuts between pictures is the thing people notice as
  // harsh; the default is a real transition, and it is a name the gate knows.
  assert.ok(TRANSITION_NAMES.includes(GALLERY_DEFAULTS.transition));
  assert.notEqual(GALLERY_DEFAULTS.transition, 'none');
  assert.ok(GALLERY_DEFAULTS.transitionSec > 0);
});

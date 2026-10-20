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
  gallerySlot,
  makeMessage,
  parseMessage,
} from '../core/content-protocol.js';
import { emptyPixels, pixelsToHex, PIXEL_HEX_LEN } from '../core/drawings.js';

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

test('gallerySlot is the whole cadence as arithmetic on the shared clock', () => {
  // Two drawings, 8 s each, 5 s of rain between: period 26, and the cycle
  // repeats exactly - so a page that loads mid-cycle lands in the same slot.
  const at = (t) => gallerySlot(t, 2, 8, 5, 'rain');
  const show = (d) => ({ drawing: d, anim: null, from: null, k: 0 });
  const brk = (a) => ({ drawing: -1, anim: a, from: null, k: 0 });
  assert.deepEqual(at(0), show(0));
  assert.deepEqual(at(7.9), show(0));
  assert.deepEqual(at(8), brk('rain'));
  assert.deepEqual(at(12.9), brk('rain'));
  assert.deepEqual(at(13), show(1));
  assert.deepEqual(at(20.9), show(1));
  assert.deepEqual(at(21), brk('rain'));
  assert.deepEqual(at(26), at(0), 'the cycle must repeat, not drift');
  assert.deepEqual(at(26 * 1000 + 3), at(3), 'and stay in phase after an hour');

  // gap 0 is the old cadence exactly: floor(t / interval) % n.
  for (const t of [0, 4, 8, 12, 100, 3601]) {
    assert.deepEqual(gallerySlot(t, 3, 5, 0, 'rain'), show(Math.floor(t / 5) % 3));
  }

  // gapAnim 'none' is a dark break, which is what "no animation" means here.
  assert.deepEqual(gallerySlot(8, 2, 8, 5, 'none'), brk(null));

  // An empty gallery is dark, and never an index into an empty list.
  assert.deepEqual(gallerySlot(0, 0, 8, 5, 'rain'), brk(null));
  assert.deepEqual(gallerySlot(123, -3, 8, 5, 'rain'), brk(null));

  // A renderer must never throw on a bad cadence: the gate rejects messages,
  // this survives them. Negative time is real too - a clock skew.
  assert.deepEqual(gallerySlot(-1, 2, 8, 5, 'rain'), brk('rain'));
  assert.deepEqual(gallerySlot(0, 2, 0, -5, 'rain'), show(0));
  assert.deepEqual(gallerySlot(50, 2, 8, 5, 'rain'), gallerySlot(50, 2, 8, 5, 'rain'));
});

test('a transition opens a slot: from, to, and how far between', () => {
  // 8 s drawing, 5 s of rain, 2 s of fade. The fade opens each slot, and the
  // frame it blends FROM is what the previous slot was showing when it ended -
  // its break, because there is one.
  const at = (t) => gallerySlot(t, 2, 8, 5, 'rain', 2);
  assert.deepEqual(at(0), { drawing: 0, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0 });
  assert.deepEqual(at(1), { drawing: 0, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0.5 });
  assert.deepEqual(at(2), { drawing: 0, anim: null, from: null, k: 0 }, 'the transition is over');
  assert.deepEqual(at(8), { drawing: -1, anim: 'rain', from: null, k: 0 },
    'the drawing -> break seam is a cut: a transition is for the picture swap,');
  assert.deepEqual(at(11), { drawing: -1, anim: 'rain', from: null, k: 0 },
    'and a wipe into a moving pattern on a 20-cell panel is a wipe of noise');
  assert.deepEqual(at(14), { drawing: 1, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0.5 });

  // With no break, the previous slot IS a drawing, and the transition is the
  // drawing-to-drawing wipe the feature is mostly used for.
  const plain = gallerySlot(0.5, 3, 10, 0, 'none', 1);
  assert.deepEqual(plain, { drawing: 0, anim: null, from: { drawing: 2, anim: null }, k: 0.5 });

  // transitionSec 0 is no transition at all: the hard cut, the old behaviour.
  assert.deepEqual(gallerySlot(0, 2, 8, 5, 'rain', 0), { drawing: 0, anim: null, from: null, k: 0 });

  // A transition longer than the slot it opens is CLAMPED, not honoured: a
  // blend that runs past the boundary would find its own target changed under
  // it halfway through.
  const long = gallerySlot(6, 2, 8, 5, 'rain', 30);
  assert.ok(long.k > 0 && long.k < 1, `mid-slot it is still blending, k=${long.k}`);
  assert.ok(gallerySlot(7.9, 2, 8, 5, 'rain', 30).from === null,
    'and it is over the drawing it opened, before the break starts');

  // k is progress, monotonic across the window.
  const ks = [0, 0.5, 1, 1.5, 1.99].map((t) => gallerySlot(t, 2, 8, 5, 'rain', 2).k);
  assert.deepEqual(ks, [...ks].sort((a, b) => a - b), 'progress rises with the clock');
  assert.ok(ks[0] === 0 && ks[ks.length - 1] < 1 && ks[ks.length - 1] > 0.9, `0..1 across the window, saw ${ks}`);
});

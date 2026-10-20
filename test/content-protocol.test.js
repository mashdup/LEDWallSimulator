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

test('a transition opens every seam: into the drawing, and out of it', () => {
  // 8 s drawing, 5 s of rain, 2 s of fade. The cycle is
  //   [rain] --fade--> [drawing] --fade--> [rain]
  // and the descriptor names both seams: `from` is the frame the wall was on,
  // the returned slot is the frame it is heading to.
  const at = (t) => gallerySlot(t, 2, 8, 5, 'rain', 2);
  assert.deepEqual(at(0), { drawing: 0, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0 });
  assert.deepEqual(at(1), { drawing: 0, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0.5 });
  assert.deepEqual(at(2), { drawing: 0, anim: null, from: null, k: 0 }, 'the blend in is over');
  assert.deepEqual(at(5), { drawing: 0, anim: null, from: null, k: 0 }, 'the middle of a drawing is itself');

  // The seam the old arithmetic cut: the drawing leaving for its own break.
  // The blend starts trans seconds BEFORE the break, and the target is the
  // break - so the renderer paints rain and blends the drawing over it by 1-k.
  assert.deepEqual(at(6), { drawing: -1, anim: 'rain', from: { drawing: 0, anim: null }, k: 0 },
    'the drawing -> break seam is a blend, not a cliff');
  assert.deepEqual(at(7), { drawing: -1, anim: 'rain', from: { drawing: 0, anim: null }, k: 0.5 });
  assert.deepEqual(at(8), { drawing: -1, anim: 'rain', from: null, k: 0 },
    'and it lands exactly as the break begins: no jump, no double frame');
  assert.deepEqual(at(11), { drawing: -1, anim: 'rain', from: null, k: 0 });
  assert.deepEqual(at(14), { drawing: 1, anim: null, from: { drawing: -1, anim: 'rain' }, k: 0.5 });

  // Continuity, which is the whole point: the last blended frame and the first
  // unblended one describe the same wall. k runs to 1 at the boundary, and the
  // frame AT the boundary is the target - so nothing snaps.
  const before = at(7.999);
  assert.ok(before.k > 0.99 && before.k < 1, `k reaches 1 at the seam, saw ${before.k}`);
  assert.deepEqual(at(8).anim, before.anim, 'the seam does not change what is showing');

  // With no break, the previous slot IS a drawing, and the transition is the
  // drawing-to-drawing wipe the feature is mostly used for. There is no out
  // seam to blend: the next slot's blend in covers that boundary from the
  // other side, so the cycle is still soft everywhere.
  assert.deepEqual(gallerySlot(0.5, 3, 10, 0, 'none', 1), { drawing: 0, anim: null, from: { drawing: 2, anim: null }, k: 0.5 });
  assert.deepEqual(gallerySlot(9.5, 3, 10, 0, 'none', 1), { drawing: 0, anim: null, from: null, k: 0 },
    'no break, so no out seam');

  // transitionSec 0 is no transition at all: the hard cut, the old behaviour.
  assert.deepEqual(gallerySlot(0, 2, 8, 5, 'rain', 0), { drawing: 0, anim: null, from: null, k: 0 });
  assert.deepEqual(gallerySlot(7, 2, 8, 5, 'rain', 0), { drawing: 0, anim: null, from: null, k: 0 });

  // A transition longer than the drawing is CLAMPED to HALF of it, so both
  // seams fit inside the drawing and never meet in the middle: two overlapping
  // blends have no defined result at all.
  const trans = (8 - 0.25) / 2;
  const long = gallerySlot(1, 2, 8, 5, 'rain', 30);
  assert.ok(long.k > 0 && long.k < 1, `mid-blend in, k=${long.k}`);
  assert.ok(Math.abs(gallerySlot(8 - trans, 2, 8, 5, 'rain', 30).k - 0) < 1e-9,
    'the out blend starts where the clamp says it must');
  assert.ok(gallerySlot(4, 2, 8, 5, 'rain', 30).from === null,
    'and between the two seams the drawing is simply itself');

  // k is progress, monotonic across each window.
  const ks = [0, 0.5, 1, 1.5, 1.99].map((t) => gallerySlot(t, 2, 8, 5, 'rain', 2).k);
  assert.deepEqual(ks, [...ks].sort((a, b) => a - b), 'progress rises with the clock');
  assert.ok(ks[0] === 0 && ks[ks.length - 1] < 1 && ks[ks.length - 1] > 0.9, `0..1 across the window, saw ${ks}`);
  const out = [6, 6.5, 7, 7.5, 7.99].map((t) => gallerySlot(t, 2, 8, 5, 'rain', 2).k);
  assert.deepEqual(out, [...out].sort((a, b) => a - b), 'and so it rises on the way out');
});
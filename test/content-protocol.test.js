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
  galleryNextMeta,
  makeMessage,
  parseMessage,
} from '../core/content-protocol.js';
import { emptyPixels, pixelsToHex, PIXEL_HEX_LEN } from '../core/drawings.js';
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

/* A live gallery, in the server's own clock. gallerySlot's tSec is the server
 * clock in SECONDS (Date.now()/1000) and entries carry createdAt in epoch MS -
 * two units, one clock, and getting them wrong is the easiest way to write a
 * test that proves nothing. Everything below is written in SECONDS and converted
 * once, in meta().
 *
 * PERIOD is interval 8 + gap 5; S0 is a whole number of periods after the epoch,
 * so it is exactly a slot boundary and every phase below is exact. */
const EPOCH = 1_700_000_000_000;
const SHOW = 8, GAP = 5, PERIOD = SHOW + GAP;
const S0 = Math.ceil(EPOCH / 1000 / PERIOD) * PERIOD;

/** metas from creation times in SECONDS. */
const meta = (timesSec) => timesSec.map((t, j) => ({ id: `d${j}`, name: `d${j}`, createdAt: t * 1000 }));

/** `n` drawings, each admitted at the start of its own slot, `n` slots before S0. */
const established = (n) => meta(Array.from({ length: n }, (_, j) => S0 - (n - j) * PERIOD));

/** Creation times (seconds) of `n` established drawings, `n` slots before S0. */
const baseTimes = (n) => Array.from({ length: n }, (_, j) => S0 - (n - j) * PERIOD);

/** The old arithmetic, kept here as the counter-example the fix is measured against. */
function oldSlot(tSec, count, show, brk) {
  if (count === 0) return -1;
  const period = show + brk;
  const cycle = count * period;
  const pos = ((tSec % cycle) + cycle) % cycle;
  const slot = Math.floor(pos / period);
  const phase = pos - slot * period;
  return phase >= show ? -1 : slot;
}

test('a drawing submitted mid-slot does not touch the slot in progress', () => {
  // The field report: "a guest submits and the gallery jumps to the new drawing
  // and keeps going". The cause was arithmetic - the cycle was count * period,
  // so the modulus carried the list length and a guest changed it. Every
  // boundary re-anchored against absolute time: the drawing on the wall swapped,
  // a break appeared where a drawing was showing, and a transition fired for it.
  const base = established(3);
  for (const phase of [0.5, 4, 7.9, SHOW, PERIOD - 0.1]) {
    const t = S0 + phase;
    const before = gallerySlot(t, base, SHOW, GAP, 'rain', 2);
    // The very same instant, with a drawing that arrived a moment ago.
    const after = gallerySlot(t, meta([...base.map((m) => m.createdAt / 1000), t - 0.001]), SHOW, GAP, 'rain', 2);
    assert.deepEqual(after, before, `a submission changed the slot at phase ${phase}`);
  }
});

test('the old arithmetic really did jump, so this test is not vacuous', () => {
  // Proving the fix is a fix: at the same instant the old formula moves and the
  // new one does not. If both ever agree here, the regression is not covered and
  // the test is decoration.
  //
  // t = S0 + 10 is mid-break, the point where adding a drawing used to change
  // which drawing the wall would show next.
  // The old shape is measured on a clock starting at 0, which is where it was
  // wrong: its modulus was count * period, so a real instant exists at which
  // adding a drawing moves the slot. 39 s, mid-slot for both lengths.
  assert.notEqual(oldSlot(39, 3, SHOW, GAP), oldSlot(39, 4, SHOW, GAP),
    `the old shape must jump here - saw ${oldSlot(39, 3, SHOW, GAP)} vs ${oldSlot(39, 4, SHOW, GAP)}`);
  // And the new shape must not, at the equivalent point on the live clock.
  const t = S0 + 4;
  const base = established(3);
  assert.equal(gallerySlot(t, base, SHOW, GAP, 'rain').drawing,
    gallerySlot(t, meta([...base.map((m) => m.createdAt / 1000), t - 0.001]), SHOW, GAP, 'rain').drawing,
    'the new shape must not');
});

test('a submitted drawing joins the rotation at the next boundary, in order', () => {
  // One new drawing per slot: the queue walks 0,1,2,3... Never a repeat, never a
  // skip. Counting the rotation from the slot the gallery became non-empty is
  // what buys this - `slotIndex mod count` on an absolute index advances by one
  // per slot only while count is fixed; when a guest adds a drawing the modulus
  // of a two-billion-slot number moves and the position jumps.
  // Three drawings already in the queue, then one submitted at each following
  // boundary. The invariant is the STEP, not the absolute index (which depends on
  // when the queue started): consecutive slots must differ by exactly +1 mod the
  // count. That is "every drawing shown once, in order, nothing skipped" - and it
  // is what `slotIndex mod count` breaks, because the modulus moves when a guest
  // submits and the step becomes 2, or 0.
  const seen = [];
  for (let k = 0; k < 9; k++) {
    const arrivals = Array.from({ length: k }, (_, j) => S0 + (j + 1) * PERIOD);
    const count = 3 + k;
    seen.push({
      count,
      drawing: gallerySlot(S0 + k * PERIOD, meta([...baseTimes(3), ...arrivals]), SHOW, GAP, 'none').drawing,
    });
  }
  for (let k = 1; k < seen.length; k++) {
    const step = ((seen[k].drawing - seen[k - 1].drawing) % seen[k].count + seen[k].count) % seen[k].count;
    assert.equal(step, 1, `slot ${k} advanced by ${step}, not 1: ${seen.map((s) => s.drawing).join(',')}`);
  }
  assert.ok(seen.every((s) => s.drawing >= 0 && s.drawing < s.count), 'every index is in range');

  // A list that is NOT growing still wraps, exactly as it always did.
  const wrapped = Array.from({ length: 8 }, (_, i) =>
    gallerySlot(S0 + i * PERIOD, established(3), SHOW, GAP, 'none').drawing);
  assert.deepEqual(wrapped, [0, 1, 2, 0, 1, 2, 0, 1], `fixed list wraps, saw ${wrapped}`);
});

test('rapid submissions never change what is showing at the moment they arrive', () => {
  // The multi-guest case from the report, stated as the invariant that matters:
  // a drawing that arrived at time t must not change the descriptor AT time t.
  // Comparing consecutive samples would measure the cadence instead - samples 3 s
  // apart legitimately cross a designed boundary (a slot opens at phase 0, its
  // break at phase SHOW). What is compared here is the SAME instant with and
  // without a submission that landed a moment before it.
  const base = established(3);
  for (let i = 0; i < 30; i++) {
    const t = S0 + i * 3;
    const withNew = [...base, { id: `guest${i}`, name: 'guest', createdAt: t * 1000 - 1 }];
    const quiet = gallerySlot(t, base, SHOW, GAP, 'rain', 2);
    const loud = gallerySlot(t, withNew, SHOW, GAP, 'rain', 2);
    const boundaryMs = Math.floor(t / PERIOD) * PERIOD * 1000;
    const eligible = withNew[base.length].createdAt <= boundaryMs;
    if (!eligible) {
      const phase = t - Math.floor(t / PERIOD) * PERIOD;
      assert.deepEqual(loud, quiet, `a submission changed the show at phase ${phase}`);
    }
  }
});

test('an empty gallery is dark, and the first drawing opens at its own boundary', () => {
  assert.deepEqual(gallerySlot(S0, [], SHOW, GAP, 'rain'), { drawing: -1, anim: null, from: null, k: 0 });
  // A single drawing, created mid-slot, becomes eligible at the NEXT boundary:
  // its own slot's phase-0 shows it, and the break of that slot is still dark.
  const one = [{ id: 'only', name: 'only', createdAt: (S0 + 1) * 1000 }];
  assert.equal(gallerySlot(S0 + 0.5, one, SHOW, GAP, 'none').drawing, -1, 'not yet eligible');
  assert.equal(gallerySlot(S0 + PERIOD, one, SHOW, GAP, 'none').drawing, 0, 'eligible at the boundary');
  assert.equal(gallerySlot(S0 + PERIOD + SHOW, one, SHOW, GAP, 'rain').anim, 'rain', 'and it breaks');
});

test("a transition names the previous slot with the previous slot's count", () => {
  // The blend at the start of a drawing must come FROM what the wall was on. If
  // it borrowed the new list length it would name a drawing that was never
  // shown, and the wipe would start from a frame the viewer did not see.
  // Three established drawings, and a fourth admitted AT this boundary. Asked
  // 0.1 s in, the blend is open; the wall came from the previous slot, which had
  // only 3 eligible drawings, so `from` must be one of those - never index 3, the
  // newcomer that had not been shown yet.
  const grew = meta([...baseTimes(3), S0]); // arrives exactly at the boundary
  const s = gallerySlot(S0 + 0.1, grew, SHOW, GAP, 'none', 2);
  assert.ok(s.from !== null && s.k > 0, 'the boundary opens with a blend');
  assert.ok(s.from.drawing < 3,
    `from must be a drawing the wall could actually have been on, saw ${s.from.drawing}`);
  assert.equal(s.drawing, 3, 'and the newcomer is what the wall is blending INTO');
});

test("galleryNextMeta prefetches the next slot's drawing, during a break too", () => {
  const ms = established(3);
  // While a drawing is up and while the break is up, the helper must name the
  // SAME next drawing - and it must not be the current one. The fetch that
  // matters happens during the break: the boundary is up to `gap` seconds away,
  // so a fetch saved for the boundary arrives a frame late.
  const duringShow = galleryNextMeta(ms, S0 + 4, SHOW, GAP);
  const duringBreak = galleryNextMeta(ms, S0 + SHOW + 2, SHOW, GAP);
  assert.ok(duringShow !== null && duringBreak !== null);
  assert.equal(duringShow.id, duringBreak.id, 'both must name the next slot');
  assert.notEqual(duringShow.id, `d${gallerySlot(S0 + 4, ms, SHOW, GAP, 'rain').drawing}`);
  assert.equal(galleryNextMeta([], S0, SHOW, GAP), null, 'an empty gallery has nothing to prefetch');
});

test('the renderers pass the metas list, not its length', () => {
  // The freeze only happens if the live gallery hands gallerySlot the array.
  // Passing `.length` restores the old behaviour exactly, silently, and nothing
  // on screen would notice until a guest submitted.
  for (const f of ['web/app.js', 'web/content.html']) {
    const src = readFileSync(f, 'utf8');
    const call = /gallerySlot\(([^)]*)\)/.exec(src);
    assert.ok(call, `${f} must call gallerySlot`);
    assert.match(call[1], /\bmetas,/, `${f} must pass metas, not a count`);
    assert.ok(!call[1].includes('metas.length'),
      `${f} must not pass metas.length: a count cannot be frozen per slot`);
  }
});

test('the drawing list is served in createdAt order', () => {
  // The per-slot freeze reads the list as "everything up to index count existed
  // then", which is only true if the list is in creation order. The store is the
  // one place that knows, and both servers answer GET /drawings from it, so the
  // sort lives there and nowhere else.
  const src = readFileSync('core/drawing-store.js', 'utf8');
  const body = /metas\(\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(body, 'metas() must exist');
  assert.match(body[1], /sort/, 'metas() must sort');
  assert.match(body[1], /createdAt/, 'by createdAt');
});
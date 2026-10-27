/**
 * The gallery's clock half: where in the slot we are, and how the two sides of
 * a seam blend.
 *
 * WHICH drawing a slot shows is the server's cursor (test/drawing-store.test.js).
 * These functions own the timing and the composition only, and that split is the
 * fix: a phase cannot be disturbed by a guest adding or pruning a drawing, while
 * an index into the roster can, which is what made the show jump.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { galleryPeriod, galleryTiming, galleryFrame } from '../core/content-protocol.js';
import { GRID } from '../core/drawings.js';

const GSTATE = {
  kind: 'gallery', interval: 8, gap: 5, gapAnim: 'rain',
  transition: 'fade', transitionSec: 2,
};

/** A schedule shaped like the store's answer, with named drawings. */
const sched = (over = {}) => ({
  cur: { id: 'a', name: 'A' },
  prev: { id: 'b', name: 'B' },
  next: { id: 'c', name: 'C' },
  slotStart: 1000,
  period: 13,
  count: 3,
  positions: 3,
  ...over,
});

test('galleryPeriod is the one place a slot length is computed', () => {
  assert.equal(galleryPeriod(GSTATE), 13, 'interval + gap');
  assert.equal(galleryPeriod({ ...GSTATE, gap: 0 }), 8, 'a gap of 0 is no break');
  assert.equal(galleryPeriod({ kind: 'text' }), 0, 'not the gallery: no cadence');
  assert.equal(galleryPeriod(null), 0, 'and no state is no cadence');
  // interval clamps UP to 1: a zero-length slot makes period 0, and the cursor's
  // slot arithmetic divides by it.
  assert.equal(galleryPeriod({ kind: 'gallery', interval: 0 }), 1);
  assert.equal(galleryPeriod({ kind: 'gallery', interval: 8, gap: -5 }), 8, 'a negative gap is no gap');
});

test('galleryTiming opens both seams and never lets them meet in the middle', () => {
  // transitionSec is clamped to HALF the drawing minus a quarter second, so the
  // in-blend holds [0, 2) and the out-blend [6, 8): they cannot overlap, and a
  // blend never runs past its boundary to find its target changed under it.
  const at = (ph) => galleryTiming(1000 + ph, 1000, 13, GSTATE);
  assert.deepEqual(at(1), { kind: 'drawing', anim: 'rain', from: 'break', k: 0.5 });
  assert.deepEqual(at(4), { kind: 'drawing', anim: 'rain', from: null, k: 0 }, 'the drawing is itself');
  assert.deepEqual(at(7), { kind: 'break', anim: 'rain', from: 'drawing', k: 0.5 },
    'the out-seam already paints the break, blending the drawing over it');
  assert.deepEqual(at(9), { kind: 'break', anim: 'rain', from: null, k: 0 }, 'the break proper');

  // A transition wider than the clamp is CUT, not honoured.
  const wide = { ...GSTATE, transitionSec: 30 };
  assert.deepEqual(galleryTiming(1004, 1000, 13, wide),
    { kind: 'drawing', anim: 'rain', from: null, k: 0 });
  assert.equal(galleryTiming(1006, 1000, 13, wide).from, 'drawing', 'the out-seam starts at the clamp');

  // No break in the cadence: the drawing-to-drawing seam names the PREVIOUS slot,
  // which is the cursor's memory of an id, never an index computed here.
  const noGap = { ...GSTATE, gap: 0 };
  assert.deepEqual(galleryTiming(1001, 1000, 8, noGap),
    { kind: 'drawing', anim: 'rain', from: 'prev', k: 0.5 });
  assert.equal(galleryTiming(1004, 1000, 8, noGap).from, null, 'and there is no out-seam to blend');

  // transitionSec 0 is a hard cut everywhere - the old behaviour, still legal.
  assert.deepEqual(galleryTiming(1001, 1000, 13, { ...GSTATE, transitionSec: 0 }),
    { kind: 'drawing', anim: 'rain', from: null, k: 0 });
});

test('anim says what the break WOULD be on every path, not only when kind is break', () => {
  // The slot of a deleted drawing is kind 'drawing' with nothing to paint, and its
  // substitute is the break frame - so a frame builder needs `anim` while kind
  // still says 'drawing'. Reading anim only from a break made that hole paint
  // black on a wall that has a break animation configured.
  for (const ph of [0, 1, 4, 6, 7, 9]) {
    assert.equal(galleryTiming(1000 + ph, 1000, 13, GSTATE).anim, 'rain', `phase ${ph}`);
  }
  // gapAnim 'none' is a dark break, and it is still reported, as null.
  const dark = { ...GSTATE, gapAnim: 'none' };
  for (const ph of [1, 4, 9]) {
    assert.equal(galleryTiming(1000 + ph, 1000, 13, dark).anim, null, `phase ${ph}`);
  }
});

test('galleryTiming wraps the phase, so a skewed or stale clock cannot crash it', () => {
  // A renderer whose last poll is older than the slot the server just opened
  // gives a negative phase; clock skew makes server time move back. Both wrap.
  for (const d of [-0.1, -1, -14]) {
    const r = galleryTiming(1000 + d, 1000, 13, GSTATE);
    assert.ok(r.kind === 'drawing' || r.kind === 'break', `phase ${d} -> ${r.kind}`);
    assert.ok(r.k >= 0 && r.k <= 1, `k stays in range: ${r.k}`);
  }
  // Clamped, never validated: a renderer must not throw mid-frame.
  assert.ok(galleryTiming(1004, 1000, 0, GSTATE) !== undefined, 'period 0 answers');
  for (const bad of [NaN, Infinity, -Infinity, undefined]) {
    assert.ok(galleryTiming(bad, 1000, 13, GSTATE).kind !== undefined, `no throw for ${String(bad)}`);
  }
});

/** A fetcher that records what was asked and returns a flat frame per channel. */
function spy(pic = 10, anim = 20) {
  const asks = [];
  return {
    asks,
    pic: (id) => {
      asks.push(`pic:${id}`);
      return new Uint8Array(GRID * GRID * 3).fill(pic);
    },
    anim: (name) => {
      asks.push(`anim:${name}`);
      return new Uint8Array(GRID * GRID * 3).fill(anim);
    },
  };
}

test('galleryFrame paints the break animation during the break', () => {
  const f = spy();
  const bytes = galleryFrame(1009, sched(), GSTATE, f);
  assert.deepEqual([...new Set(bytes)], [20], 'exactly the break frame');
  assert.ok(f.asks.includes('anim:rain'));
});

test('galleryFrame warms the next drawing while this one is up', () => {
  // The whole reason the schedule carries `next`: a submission becomes eligible
  // at the boundary, and pixels fetched only then mean the boundary opens dark.
  const f = spy();
  galleryFrame(1004, sched(), GSTATE, f);
  assert.deepEqual(f.asks.filter((a) => a.startsWith('pic:')), ['pic:c', 'pic:a'],
    'next is warmed, then the drawing being painted');

  // A one-drawing gallery: next IS cur, and must not be asked for twice a frame.
  const g = spy();
  galleryFrame(1004, sched({ next: { id: 'a', name: 'A' } }), GSTATE, g);
  assert.deepEqual(g.asks.filter((a) => a.startsWith('pic:')), ['pic:a'], 'no duplicate fetch');
});

test('galleryFrame does not build the break frame on a frame that shows a drawing', () => {
  // tm.anim is populated on every path (a hole needs it), so building it eagerly
  // would render `rain` or `fire` - a full 1200-pixel animation - on all ~30
  // frames a second that show a drawing, and throw every one away.
  const f = spy();
  galleryFrame(1004, sched(), GSTATE, f);
  assert.ok(!f.asks.some((a) => a.startsWith('anim:')),
    `mid-drawing, no animation work: ${f.asks.join(' ')}`);

  // A blend that involves the break still asks for it exactly once.
  const g = spy();
  galleryFrame(1001, sched(), GSTATE, g); // in-seam: break -> drawing
  assert.equal(g.asks.filter((a) => a.startsWith('anim:')).length, 1, 'built once for the blend');
});

test('galleryFrame uses the real transitions, not a private fade', () => {
  // fade/wipe/dissolve/slide are the gallery's feature, and wipe and dissolve are
  // directional and cell-ordered. Re-deriving the blend inside the frame builder
  // would quietly turn every transition into a fade, and the wall would look wrong
  // while every test still passed.
  // Mid-in-blend (phase 1, k 0.5): break frame is 0, drawing frame is 200.
  const at = (transition) => galleryFrame(1001, sched(), { ...GSTATE, transition }, spy(200, 0));
  const fade = at('fade');
  const wipe = at('wipe');
  const dissolve = at('dissolve');
  assert.deepEqual([...new Set(fade)], [100], 'a fade is the linear mean at k=0.5');
  assert.ok(!fade.every((v, i) => v === wipe[i]), 'a wipe differs from a fade at the same k');
  assert.ok(wipe.some((v) => v === 200) && wipe.some((v) => v === 0),
    'and is a real reveal, not a blend - cells are on one side or the other');
  assert.ok(!fade.every((v, i) => v === dissolve[i]), 'a dissolve differs from a fade');

  // 'none' is a HARD CUT: during the window the wall still holds the from-side,
  // and jumps at the boundary. That is the contract in transitions.js (k>=1 is
  // `to` for every name), and it is why a name is checked after progress.
  const cut = galleryFrame(1001, sched(), { ...GSTATE, transition: 'none' }, spy(200, 0));
  assert.deepEqual([...new Set(cut)], [0], 'no blend: still the break frame');
});

test('a hole paints the break, and still warms the next drawing', () => {
  // The slot a pruned drawing owned: its bytes are gone, so the rest of the slot
  // goes to the break rather than holding a frame that no longer exists.
  const f = spy();
  const bytes = galleryFrame(1004, sched({ cur: null }), GSTATE, f);
  assert.deepEqual([...new Set(bytes)], [20], 'the break, not black');
  assert.ok(f.asks.includes('pic:c'),
    'a hole still warms the next drawing - the early return must not skip the prefetch');
});

test('an empty gallery asks for nothing, and is dark only when the break is dark', () => {
  // gapAnim 'none' means the break IS black, so an empty gallery is black and no
  // fetch happens at all. With a real break animation the gallery is empty but
  // the wall is not: it shows the break, which is what the cadence asked for.
  const empty = sched({ cur: null, prev: null, next: null, count: 0 });

  const f = spy();
  const dark = galleryFrame(1004, empty, { ...GSTATE, gap: 0, gapAnim: 'none' }, f);
  assert.deepEqual([...new Set(dark)], [0], 'dark');
  assert.deepEqual(f.asks, [], 'and no fetch on a gallery with nothing in it');

  const g = spy();
  const brk = galleryFrame(1004, empty, { ...GSTATE, gapAnim: 'rain' }, g);
  assert.deepEqual([...new Set(brk)], [20], 'the break animation plays while the gallery is empty');
  assert.ok(g.asks.includes('anim:rain'));
});

test('the renderers read the schedule and never compute a rotation', () => {
  // The fault this replaces was arithmetic: an index into the roster re-based
  // whenever a guest added or pruned a drawing. A renderer computing its own
  // rotation reintroduces it silently - and these tests would still pass, because
  // the fault only shows when the list changes mid-show.
  for (const f of ['web/app.js', 'web/content.html']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /galleryFrame\(/, `${f} must compose through core's galleryFrame`);
    assert.ok(!/gallerySlot\(/.test(src),
      `${f} must not call a rotation function: identity comes from the server`);
    assert.ok(!/metas\.length/.test(src), `${f} must not size or index the roster to pick a drawing`);
    assert.ok(!/fetch\(['"`]\/drawings['"`]/.test(src),
      `${f} must not fetch the roster: the schedule answers who, what next, and how many`);
  }
});

test('core owns no rotation, so there is no second path to drift', () => {
  const core = readFileSync('core/content-protocol.js', 'utf8');
  assert.ok(!/function gallerySlot/.test(core), 'no derived rotation in core');
  assert.ok(!/slotFor|queuePos|countAt/.test(core), 'and none of its old helpers');
});

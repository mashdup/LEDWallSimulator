/**
 * The gallery cursor: which drawing a slot shows, remembered rather than derived.
 *
 * Two field reports, one cause. A guest submitting a drawing made the show skip
 * to it and carry on; an owner pruning one made drawings come round twice. Both
 * were the same arithmetic - `slot mod count` - and an index into a mutable
 * roster re-bases whenever the roster changes. The fix is a cursor that holds a
 * queue POSITION, advanced one per boundary at read time, so neither operation
 * can move what is already on screen.
 *
 * These are the tests that would have caught the original bug, and the reason
 * they belong here rather than in the clock tests: the fault only appears when
 * the list changes mid-show, which is exactly what a store owns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DrawingStore } from '../core/drawing-store.js';
import { emptyPixels, pixelsToHex } from '../core/drawings.js';

const PX = pixelsToHex(emptyPixels());
const PERIOD = 13; // interval 8 + gap 5, the default cadence

let dir;
const fresh = (name) => new DrawingStore(join(dir, `${name}.json`)).load();

/** Slot k's midpoint, in server-epoch seconds: safely inside slot k. */
const slotMid = (k) => Math.floor(Date.now() / 1000 / PERIOD) * PERIOD + k * PERIOD + 1;
const name = (sched) => (sched.cur === null ? 'HOLE' : sched.cur.name);

test.before(() => { dir = mkdtempSync(join(tmpdir(), 'gal-cursor-')); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

test('the rotation is one queue position per slot, in admission order', () => {
  const s = fresh('rot');
  s.add('A', PX); s.add('B', PX); s.add('C', PX); s.add('D', PX);
  const seen = Array.from({ length: 9 }, (_, k) => name(s.gallery(slotMid(k), PERIOD)));
  assert.deepEqual(seen, ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A'],
    `a clean lap of four, saw ${seen}`);
});

test('a drawing submitted mid-slot does not touch the slot in progress', () => {
  // Report 1. The modulus used to carry the list length, so the instant a guest
  // POSTed, every boundary in the show re-anchored against absolute time: the
  // drawing changed mid-slot, a break appeared where a drawing was, and a
  // transition fired for it.
  const s = fresh('submit');
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  for (const phase of [0.5, 4, 7.9, PERIOD - 0.1]) {
    const t = slotMid(0) - 1 + phase;
    const before = JSON.stringify(s.gallery(t, PERIOD));
    s.add('guest', PX);
    const after = JSON.stringify(s.gallery(t, PERIOD));
    assert.equal(after, before, `a submission changed the slot at phase ${phase}`);
  }
});

test('a submitted drawing joins after a full lap, never cutting in', () => {
  const s = fresh('join');
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  s.add('D', PX); // submitted while A's slot is running
  const seen = Array.from({ length: 6 }, (_, k) => name(s.gallery(slotMid(k), PERIOD)));
  assert.equal(seen[0], 'A');
  assert.ok(!seen.slice(0, 3).includes('D'), `D waits its turn: ${seen}`);
});

test('pruning a drawing cannot move any other drawing to a new slot', () => {
  // Report 2. Deleting the entry BEFORE the cursor is what made the first fix
  // fail: advancing one LIVE entry per boundary stepped the pointer backwards,
  // and [A,B,C,D] showing C with B removed went to A - a repeat on screen. A
  // PERMANENT position makes the lap keep its shape; and the hole's own boundary
  // steps on to the next live drawing, so the break plays ONCE - a hole-slot of
  // animation followed by the next slot's own break was the animation twice.
  const s = fresh('prune');
  s.add('A', PX); const b = s.add('B', PX); s.add('C', PX); s.add('D', PX);
  s.remove(b.id);
  const seen = Array.from({ length: 9 }, (_, k) => name(s.gallery(slotMid(k), PERIOD)));
  assert.deepEqual(seen, ['A', 'C', 'D', 'A', 'C', 'D', 'A', 'C', 'D'],
    `the hole is never painted, saw ${seen}`);
  assert.equal(seen.filter((n) => n === 'A').length, 3,
    'A keeps its own turn - once per 4-slot lap, at slots 0, 3 and 6');
  assert.ok(!seen.includes('HOLE'), 'no slot answers the break animation on its own');
  // prev is what the PREVIOUS slot showed, so the skip over the hole must not
  // leave prev naming the hole (a 'prev' transition into nothing is a dark flash).
  // A FRESH store: reading slot 1 on the store above, whose cursor already lives
  // at slot 8, is a forward advance, not a rewind.
  const q = fresh('prune-prev');
  q.add('A', PX); const c = q.add('B', PX); q.add('C', PX); q.add('D', PX);
  q.remove(c.id);
  q.gallery(slotMid(0), PERIOD);
  assert.equal(q.gallery(slotMid(1), PERIOD).cur.name, 'C');
  assert.equal(q.gallery(slotMid(1), PERIOD).prev.name, 'A',
    "C's slot remembers A, the drawing actually shown before it");
});

test('deleting the drawing being shown ends its slot, and does not repeat it', () => {
  const s = fresh('prune-current');
  s.add('A', PX); s.add('B', PX);
  const k = 0;
  assert.equal(name(s.gallery(slotMid(k), PERIOD)), 'A');
  s.remove(s.byId(s.gallery(slotMid(k), PERIOD).cur.id).id);
  // The slot it owned is spent: the rest of it shows no drawing rather than
  // holding bytes the server no longer has.
  assert.equal(name(s.gallery(slotMid(k) + 0.5, PERIOD)), 'HOLE');
  assert.equal(name(s.gallery(slotMid(k + 1), PERIOD)), 'B', 'and the queue moves on');
});

test('the cursor catches up in one step, so a wall restarted overnight lands right', () => {
  // Read-time advance is catch-up, not a timer. A wall that comes back after a
  // night off has tens of thousands of boundaries behind it: an O(steps) loop
  // would turn every poll into a freeze, so the walk is one modulo.
  const s = fresh('catchup');
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  const start = s.gallery(slotMid(0), PERIOD);
  assert.equal(name(start), 'A');
  const late = s.gallery(slotMid(0) + 100000 * PERIOD, PERIOD);
  assert.equal(late.slotStart % PERIOD, 0, 'the slot it lands on is a real boundary');
  assert.ok(['A', 'B', 'C'].includes(name(late)), 'and a live drawing: ' + name(late));
  // One boundary later is exactly one position later: the rotation did not slip.
  const after = s.gallery(late.slotStart + PERIOD + 1, PERIOD);
  const all = ['A', 'B', 'C'];
  assert.equal(all[(all.indexOf(name(late)) + 1) % 3], name(after),
    `${name(late)} -> ${name(after)}`);
});

test('two readers of one store agree, and a read does not move the show', () => {
  // Idempotence is what makes MULTIPLE renderers agree without coordinating: the
  // cursor only moves when server time crosses a boundary, so a second poll
  // inside the same slot is a no-op. This is why the schedule can be read on
  // every poll at 10 Hz by three tabs and still be one show.
  const s = fresh('readers');
  s.add('A', PX); s.add('B', PX);
  const t = slotMid(0);
  const a = JSON.stringify(s.gallery(t, PERIOD));
  for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(s.gallery(t, PERIOD)), a, 'reads are pure');
  assert.equal(JSON.stringify(s.gallery(t + 0.01, PERIOD)), a, 'and time inside a slot is pure');
});

test('a cadence change re-baselines instead of walking millions of slots', () => {
  // slot is floor(t / period), so slot numbers are only comparable inside ONE
  // cadence. Moving interval 8 to 3 would otherwise look like a jump of millions
  // and the cursor would spin the queue tens of thousands of times in one read.
  const s = fresh('cadence');
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  const slow = s.gallery(slotMid(0), PERIOD);
  const fast = s.gallery(slotMid(0), 8); // interval 8, gap 0
  assert.equal(fast.cur.name, slow.cur.name, 'the same drawing survives the change');
  assert.equal(fast.prev, null, 'and a cadence that just started has no previous slot');
  assert.equal(fast.period, 8, 'the answer reports the cadence it actually used');
});

test('the schedule answers who, what was before, what is next, and how many', () => {
  const s = fresh('shape');
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  const r = s.gallery(slotMid(0), PERIOD);
  assert.deepEqual(Object.keys(r).sort(),
    ['count', 'cur', 'next', 'now', 'period', 'positions', 'prev', 'slotStart']);
  assert.equal(r.cur.name, 'A');
  assert.equal(r.next.name, 'B', 'next is the first LIVE position ahead, for the prefetch');
  assert.equal(r.count, 3);
  assert.equal(r.positions, 3);
  assert.ok(Number.isFinite(r.now) && r.now > 1e11, 'now is the server clock in ms');
});

test('a hole between the cursor and the next drawing does not hide it', () => {
  // next skips holes rather than answering null at the first one, or the drawing
  // after a pruned one would never be warmed and its boundary would open dark.
  // The hole goes IMMEDIATELY after the cursor: that is the "between" the name
  // promises, and the only arrangement where skipping it changes the answer.
  const s = fresh('holes-ahead');
  s.add('A', PX); const b = s.add('B', PX); s.add('C', PX); s.add('D', PX);
  s.remove(b.id);
  const r = s.gallery(slotMid(0), PERIOD);
  assert.equal(r.cur.name, 'A');
  assert.equal(r.next.name, 'C', `B is a hole, so next lands on C: ${r.next?.name}`);
  assert.equal(r.count, 3, 'count is live drawings');
  assert.equal(r.positions, 4, 'positions is the queue, holes included');
});

test('an empty gallery keeps its cursor rather than restarting the rotation', () => {
  const s = fresh('empty');
  const a = s.add('A', PX);
  assert.equal(name(s.gallery(slotMid(0), PERIOD)), 'A');
  s.remove(a.id);
  const e = s.gallery(slotMid(1), PERIOD);
  assert.equal(e.cur, null, 'nothing to show');
  assert.equal(e.count, 0);
  assert.equal(e.next, null, 'and nothing to warm');
  // Refill: the show resumes from the queue, not from a re-created epoch cursor.
  s.add('B', PX);
  assert.ok(['B'].includes(name(s.gallery(slotMid(2), PERIOD))), 'resumes on B');
});

test('a re-admitted drawing does not take a second position in the queue', () => {
  // remove() leaves a hole by design, and the relay can hand back an entry this
  // store already pruned. Appending it again would put the same drawing in the
  // show twice per lap, and nothing downstream could tell the two copies apart.
  const s = fresh('readmit');
  const a = s.add('A', PX); s.add('B', PX);
  s.remove(a.id);
  s.adopt({ id: a.id, name: 'A', pixels: a.pixels, createdAt: a.createdAt });
  assert.equal(s.queue.length, 2, `queue stays at two positions: ${s.queue.length}`);
  const seen = Array.from({ length: 5 }, (_, k) => name(s.gallery(slotMid(k), PERIOD)));
  assert.deepEqual(seen, ['A', 'B', 'A', 'B', 'A'], `and the rotation is a clean lap: ${seen}`);
});

test('a store written before the queue existed still shows every drawing', () => {
  // INVARIANT: every entry in `list` has a position in `queue`. load() reconciles
  // it at boot, so an upgrade (or a hand-edited file) cannot leave a drawing that
  // is in the store, in the public list, deletable - and never shown.
  const file = join(dir, 'legacy.json');
  const legacy = new DrawingStore(file);
  const e = legacy.add('A', PX);
  legacy.add('B', PX);
  // Simulate an older build's sidecar: no queue, no cursor.
  rmSync(`${file}.state`);
  writeFileSync(`${file}.state`, JSON.stringify({ seq: legacy.seq, deleted: [] }));

  const reopened = new DrawingStore(file).load();
  assert.equal(reopened.queue.length, 2, 'both entries were given positions');
  const seen = Array.from({ length: 4 }, (_, k) => name(reopened.gallery(slotMid(k), PERIOD)));
  assert.deepEqual(seen, ['A', 'B', 'A', 'B'], `no drawing is invisible: ${seen}`);
});

test('the cursor survives a restart, so a reload does not rewind the show', () => {
  const file = join(dir, 'persist.json');
  const s = new DrawingStore(file).load();
  s.add('A', PX); s.add('B', PX); s.add('C', PX);
  // The show's slot 0 is the read that CREATES the cursor (see the rotation
  // test), so anchor it at slotMid(0) first, then walk to C's slot.
  assert.equal(name(s.gallery(slotMid(0), PERIOD)), 'A', 'the first slot opens on the first drawing');
  const t = slotMid(2); // C's slot
  assert.equal(name(s.gallery(t, PERIOD)), 'C');
  const again = new DrawingStore(file).load();
  assert.equal(name(again.gallery(t, PERIOD)), 'C', 'same slot after reload');
  assert.equal(again.gallery(t, PERIOD).prev.name, 'B', 'and it remembers what came before');
});

test('schedule() answers only the gallery, and uses the shared period', () => {
  const s = fresh('schedule');
  s.add('A', PX);
  assert.equal(s.schedule({ kind: 'text', text: 'hi' }), null, 'a banner costs nothing');
  assert.equal(s.schedule(null), null);
  const r = s.schedule({ kind: 'gallery', interval: 8, gap: 5 });
  assert.equal(r.period, 13, 'the same sum the renderers use for their phase');
  assert.equal(r.cur.name, 'A');
});

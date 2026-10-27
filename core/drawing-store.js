/**
 * The drawing gallery as a store: entries, a cursor, and a JSON file.
 *
 * This used to live inside tools/serve.js. It is here because two servers need
 * the same gallery: the wall's loopback server, and the public relay on jarvis.
 * Two implementations of a gate are two chances to get it wrong, and the gate
 * here is the one that decides whether a stranger can delete a family
 * drawing - so there is one, and both servers import it.
 *
 * DOM-free and Node-testable, like the rest of core/. It knows about files and
 * about nothing else: no HTTP, no sockets, no timers.
 *
 * ## The cursor
 *
 * Every entry carries a `seq`, and every delete leaves a tombstone `{id, seq}`.
 * `since(cursor)` is then the whole sync story in one call: everything that
 * happened since the number you last saw. A relay client that was offline for
 * an hour asks once and is current; a client that has never asked passes 0 and
 * gets the gallery.
 *
 * Tombstones are kept, not compacted. They are ~40 bytes, the gallery is a
 * party's worth of drawings, and a compaction that drops a delete the wall has
 * not seen yet is a drawing that comes back from the dead - the worst kind of
 * bug in a slideshow, because it comes back looking like a feature.
 *
 * ## The gallery queue and its cursor
 *
 * WHICH drawing is on screen is remembered, not derived. `queue` is the order
 * drawings were admitted (append-only: an add goes to the tail, a delete leaves
 * a hole nothing shifts into), and `cursor` pins the drawing the current slot is
 * showing, by ID.
 *
 * This exists because the alternative - computing the rotation from the roster
 * and the clock - cannot be stable. `slot mod count` is discontinuous in the
 * count, and a party changes the count constantly: a guest adding a drawing
 * re-anchored every boundary (the show skipped to the newcomer), and pruning
 * one moved the pointer backwards (the same drawing came round twice). An index
 * into a mutable set re-bases whenever the set does; that is a property of the
 * arithmetic, not of the storage, and no schema or database fixes it.
 *
 * Remembering survives both operations, because nothing is an index anymore: an
 * add cannot move the pinned id, and a delete of the pinned id leaves it pinned
 * until the next boundary - the slot finishes what it started, the removed
 * drawing is simply not painted again. A delete of ANY other drawing never
 * touches the current slot or the one due next.
 *
 * The cursor lives here, in the wall's own store, beside the meta bag that
 * already exists so "a wall that restarts mid-party resumes where it left off".
 * It cannot live in a pure function of time shared with the relay: a peer's
 * delete arriving through `drop()` records no tombstone ON PURPOSE (a tombstone
 * here would echo the same delete back to the relay forever), so the two servers
 * structurally cannot share a history to reconstruct. One owner, the wall, the
 * thing being looked at.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { newDrawing, pixelsFromHex, validateEntry } from './drawings.js';
import { galleryPeriod } from './content-protocol.js';

export class DrawingStore {
  /** @param {string} file JSON file to persist to. */
  constructor(file) {
    this.file = file;
    /** @type {object[]} */
    this.list = [];
    /** @type {{id: string, seq: number}[]} */
    this.deleted = [];
    /** Ids in admission order, PERMANENT positions: a remove leaves a hole. */
    this.queue = [];
    /** {slot, id, prevId, period, nextId, count, positions} - the slot's answer. */
    this.cursor = null;
    /**
     * A persisted bag for one server's own bookkeeping - the relay client's
     * cursors live here, so a wall that restarts mid-party resumes where it
     * left off instead of replaying the whole gallery at the relay.
     */
    this.meta = {};
    this.seq = 0;
  }

  /** Read the file. Tolerant: no file, junk file, an empty gallery, not a crash. */
  load() {
    this.seq = 0;
    for (const e of this.list) this.seq = Math.max(this.seq, e.seq ?? 0);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        // An entry written by an older build has no seq; give it one, in file
        // order, so a restart never rewinds the cursor and re-serves history.
        this.list = raw.filter(validateEntry).map((e) => {
          const entry = { ...e };
          if (!Number.isInteger(entry.seq)) entry.seq = ++this.seq;
          else this.seq = Math.max(this.seq, entry.seq);
          return entry;
        });
      }
      const s = JSON.parse(readFileSync(`${this.file}.state`, 'utf8'));
      if (Array.isArray(s.deleted)) this.deleted = s.deleted.filter((d) => typeof d?.id === 'string');
      if (Array.isArray(s.queue)) this.queue = s.queue.filter((id) => typeof id === 'string');
      if (s.cursor !== null && typeof s.cursor === 'object') {
        // id may legitimately be null: an empty gallery has a cursor with nothing
        // pinned, and a pruned drawing leaves the cursor on an id that no longer
        // resolves. Both are states, not corruption, so neither is rejected here.
        this.cursor = {
          slot: Number(s.cursor.slot) || 0,
          id: typeof s.cursor.id === 'string' ? s.cursor.id : null,
          prevId: typeof s.cursor.prevId === 'string' ? s.cursor.prevId : null,
          period: Number(s.cursor.period) || 0,
        };
      }
      // nextId/count/positions are DERIVED from the queue and the list, and the
      // file may predate them or carry a stale copy: touchCursor() recomputes
      // them from what was just loaded, so a boot never trusts three numbers
      // that a hand-edit could have moved.
      if (Number.isInteger(s.seq)) this.seq = Math.max(this.seq, s.seq);
      if (s.meta !== null && typeof s.meta === 'object') this.meta = s.meta;
    } catch {
      // The store is user data: a corrupt one is left on disk, not silently
      // overwritten (it is only written after a successful mutation).
    }
    /* INVARIANT: every entry in `list` has a position in `queue`. The gallery
     * walks the queue, so an entry missing from it would be in the store, in the
     * public list, deletable - and never shown: a silent hole rather than a loud
     * one. add() and adopt() both go through admit(), so the only way this can
     * fail is a file written by an older build (no queue field at all) or edited
     * by hand. Reconcile it once here at boot, in creation order. */
    const queued = new Set(this.queue);
    const orphans = this.list.filter((e) => !queued.has(e.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const e of orphans) this.queue.push(e.id);
    if (this.cursor !== null) this.touchCursor();
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.list));
    writeFileSync(`${this.file}.state`, JSON.stringify({
      seq: this.seq, deleted: this.deleted, meta: this.meta,
      queue: this.queue, cursor: this.cursor,
    }));
  }

  get size() {
    return this.list.length;
  }

  /**
   * The list without the pixel payloads: what a public GET answers.
   *
   * Exactly {id, name, createdAt} - no seq, no origin, no secret. This is the
   * roster: what the gallery CONTAINS. It is not the schedule, and a renderer
   * must not try to derive one from it - the schedule is `schedule()`/`gallery()`
   * below, and deriving rotation from this list's index is the bug the cursor
   * replaced. Every field added to a public list is one more thing a stranger
   * can sort, correlate or enumerate, so it stays three fields.
   *
   * Ordered by createdAt, HERE, at the source both servers answer from, because
   * `this.list` is append-only in ARRIVAL order and entries adopted from the
   * relay arrive in that order, not the order they were drawn. The gallery no
   * longer indexes this list, but a viewer reading it - the console's count, the
   * draw page's list - should still see the party's drawings in the order they
   * happened.
   */
  metas() {
    return this.list
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The public view of one entry: the pixels, and NEVER the delete secret.
   *
   * The secret goes to the creator once, in the POST response. If a GET echoed
   * it, the gallery would be deletable by every visitor - the list is public,
   * so reading it and then deleting everything is two requests.
   */
  /**
   * The full entry, pixels included, with the secret stripped.
   *
   * Exactly {id, name, pixels, createdAt} - the shape the wall's renderer and
   * its tests already know. `seq` is added by `since()`, where the sync cursor
   * needs it, and by nothing that answers a stranger's GET.
   */
  static publicEntry(e) {
    return { id: e.id, name: e.name, pixels: e.pixels, createdAt: e.createdAt };
  }

  /**
   * Add a drawing from its WIRE form (hex pixels).
   *
   * The hex -> bytes conversion is explicit here, at the boundary: newDrawing
   * takes bytes, and handing it the hex string encodes each CHARACTER, storing
   * 6400 chars of nonsense - a bug this exact line caught once already.
   *
   * @returns {object} the stored entry, secret included (the caller decides who
   *                    ever sees it, which is: only the creator, once).
   */
  add(name, pixelsHex, origin = 'local') {
    const e = newDrawing(name, pixelsFromHex(pixelsHex));
    e.secret = randomBytes(10).toString('hex');
    e.origin = origin;
    e.seq = ++this.seq;
    this.list.push(e);
    this.admit(e.id);
    this.save();
    return e;
  }

  /**
   * Adopt an entry that arrived from a peer (the wall pushing to the relay, or
   * the relay pulling into the wall). Ids are the dedupe key: the same drawing
   * arriving twice is one drawing.
   */
  adopt(entry) {
    if (this.list.some((e) => e.id === entry.id)) return null;
    const e = { ...entry };
    delete e.secret;
    if (!validateEntry(e)) return null;
    e.seq = ++this.seq;
    this.list.push(e);
    this.admit(e.id);
    this.save();
    return e;
  }

  /**
   * Give a drawing its slot in the gallery queue.
   *
   * The id must not already be in the queue: remove() leaves a HOLE there (by
   * design - positions are permanent so nothing shifts), and the relay can hand
   * back an entry this store has already pruned. Appending a second copy would
   * put the same drawing in the show twice per lap, and the two copies would be
   * indistinguishable to everything downstream.
   */
  admit(id) {
    if (!this.queue.includes(id)) this.queue.push(id);
  }

  byId(id) {
    return this.list.find((e) => e.id === id) ?? null;
  }

  /**
   * Remove an entry and record the tombstone every peer needs.
   *
   * The queue keeps a HOLE here and the cursor keeps its id: the slot the pruned
   * drawing owned finishes on the break (its bytes are gone from the server, so
   * holding them would be holding a frame that cannot be fetched), and nothing
   * else changes its turn.
   *
   * The hole is PERMANENT, and that is the whole point: positions are the one
   * thing no roster change can move, so every surviving drawing keeps its own
   * turn forever. The alternative - compacting the queue - re-bases the lap, and
   * re-basing is exactly the jump this design removes; doing it "only at a
   * boundary" is a re-base every lap. The hole's own boundary steps straight to
   * the next live drawing (see advance()), so a deletion costs the show one
   * drawing's slot, not a doubled break animation. A re-adopted id refills its
   * own hole (see admit()).
   */
  remove(id) {
    const i = this.list.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.list.splice(i, 1);
    // The queue keeps the hole and the cursor keeps its id: see gallery().
    this.deleted.push({ id, seq: ++this.seq });
    this.save();
    return true;
  }

  /**
   * Everything that happened since `cursor`: new entries, deletes, and the new
   * cursor to send back next time. Peers get the pixels (they render them);
   * secrets are never in this payload.
   */
  since(cursor) {
    const c = Number.isFinite(cursor) ? cursor : 0;
    return {
      entries: this.list.filter((e) => e.seq > c).map((e) => ({ ...DrawingStore.publicEntry(e), seq: e.seq })),
      deleted: this.deleted.filter((d) => d.seq > c),
      cursor: this.seq,
      count: this.list.length,
    };
  }

  /**
   * Apply a peer's delete without recording a tombstone.
   *
   * `remove` is a local decision to delete, so it leaves a tombstone for every
   * peer to follow. `drop` is a peer's delete arriving here: the tombstone
   * already exists out there, and writing a new one would send the same delete
   * back - a wall that keeps asking the relay to remove what the relay just
   * told it to remove.
   */
  drop(id) {
    const i = this.list.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.list.splice(i, 1);
    this.save();
    return true;
  }

  /**
   * gallery(tSec, periodSec) -> the wall's schedule for the slot in progress.
   *
   * {cur, prev, next} are metas ({id, name}) or null; `slotStart` is the boundary
   * this slot opened at, in server-epoch seconds; `period` is what the cursor
   * advanced on; `count` is the live gallery and `positions` the queue's length,
   * holes included; `now` is the slot's own timestamp in ms. The server answers
   * this and the renderers paint it: which drawing is on screen is REMEMBERED,
   * and cannot move except at a boundary.
   *
   * The answer is FROZEN for the slot: every field is a property of the cursor,
   * computed when the boundary opened, so ten reads inside one slot return byte-
   * identical JSON. That is not cosmetics - the renderers poll at ~10 Hz, and a
   * response that jitters mid-slot (a count that moves when a guest submits, a
   * `now` that ticks per call) is indistinguishable from a show that changed.
   *
   * THE CURSOR IS AN ID. That is the whole fix, and the reason two earlier
   * attempts failed. The first derived the drawing from `slot mod count`, so a
   * guest adding a drawing re-anchored every boundary in the show and the wall
   * skipped to the newcomer. The second derived it from a queue POSITION, so a
   * prune pulled the pointer backwards and drawings came round twice. Both were
   * indexing a mutable roster, and an index re-bases whenever the roster does:
   * the fact "which drawing is on screen now" is not in the roster, so it has to
   * be stored. It is, as an id.
   *
   * The first read CREATES the cursor, and the slot it is created in is the show's
   * slot 0: it shows the first live drawing. Pinning to `absolute slot mod count`
   * instead would open the wall on whichever drawing the Unix epoch happens to
   * point at, which is stable but reads as a random startup.
   *
   * Advancing happens at READ time, in catch-up: no timer, and a wall restarted
   * after a night off lands exactly where its own clock says it should. It is
   * also what makes several readers agree without coordinating - the cursor only
   * moves when server time crosses a boundary, so a second read inside the same
   * slot is a pure no-op.
   *
   * period <= 0 or a non-finite time answers the current state WITHOUT advancing:
   * a caller that cannot name a cadence must not be able to move the show.
   */
  gallery(tSec, periodSec) {
    const period = Math.max(1, Math.floor(Number(periodSec) || 0));
    if (this.cursor === null) {
      // Anchor the first cursor to the slot it is created in, on the FIRST
      // drawing. Starting at slot 0 instead would make the first read catch up
      // ~138 million boundaries and land on whichever drawing the epoch happens
      // to point at - stable, but it reads as a random startup.
      this.cursor = {
        slot: Math.floor(tSec / period), id: this.liveIds()[0] ?? null, prevId: null, period,
      };
      this.touchCursor();
      this.save();
    }
    if (Number.isFinite(tSec) && periodSec >= 1) {
      /* `slot` is floor(t / period), so slot numbers are comparable only inside
       * ONE cadence. An operator moving interval 8 to 3 would otherwise make the
       * current slot look like a jump of millions and the show would spin. A
       * cadence change re-baselines: same drawing, this cadence's slot number, no
       * prev (there is no previous slot in a cadence that just started). */
      if (this.cursor.period !== period) {
        this.cursor = {
          slot: Math.floor(tSec / period), id: this.cursor.id, prevId: null, period,
        };
        this.touchCursor();
        this.save();
      }
      if (this.advance(Math.floor(tSec / period))) this.save();
    }

    const byId = new Map(this.list.map((e) => [e.id, e]));
    const metaOf = (id) => {
      const e = id === null || id === undefined ? undefined : byId.get(id);
      return e === undefined ? null : { id: e.id, name: e.name };
    };
    const slotStart = this.cursor.slot * this.cursor.period;
    return {
      /* A drawing deleted MID-_slot answers null for the rest of that slot: its
       * bytes are gone from the server, and holding them would be holding a frame
       * that cannot be fetched. The slot finishes on the break - the renderer's
       * hole path (see galleryFrame) substitutes it. A boundary never lands on a
       * hole at all: advance() steps over it (see its note on the doubled break). */
      cur: metaOf(this.cursor.id),
      // prev is the cursor's OWN memory of what this slot replaced, never a
      // derived index: what the viewer saw is a fact about the past, and the past
      // must not depend on how big the list happens to be now.
      prev: metaOf(this.cursor.prevId),
      // The drawing due next (holes skipped), for the renderer's prefetch, so a
      // boundary cannot open on a dark frame while its pixels are still in
      // flight. Stored, not recomputed per read: see the frozen-for-the-slot note.
      next: metaOf(this.cursor.nextId),
      slotStart,
      // The cadence the cursor is actually on, which can differ from what was
      // asked for: a caller re-baselining mid-change must not compute its phase
      // against a boundary the server never used.
      period: this.cursor.period,
      // count and positions are the cursor's, taken when the boundary opened:
      // a guest adding a drawing mid-slot must not change a single byte of the
      // answer until the next boundary (the mid-slot submit test is this).
      // count is live drawings; positions is the queue, holes included - the
      // difference is what tells a console that the show has a break-shaped turn.
      count: this.cursor.count,
      positions: this.cursor.positions,
      // The slot's own timestamp, not the clock at call time: "now" is the
      // answer's identity stamp, and one that ticks per poll is a response that
      // is never equal to itself - no read is pure, no cache valid, no reader
      // provably agreeing with another.
      now: slotStart * 1000,
    };
  }

  /**
   * Refresh the cursor's derived fields (count, positions, nextId) from the
   * current queue and list. Called at every cursor write - anchor, advance,
   * cadence re-baseline, boot - and nowhere mid-slot, which is what keeps the
   * slot's answer frozen while its slot runs.
   */
  touchCursor() {
    this.cursor.count = this.liveIds().length;
    this.cursor.positions = this.queue.length;
    this.cursor.nextId = this.nextLive();
    return this.cursor;
  }

  /**
   * nextLive() -> the first live id strictly ahead of the cursor's position,
   * skipping holes, wrapping; null when nothing live is ahead (a gallery whose
   * only live drawing is the one being shown, a lap of holes, or an empty queue).
   *
   * Holes are skipped rather than answered: the prefetch exists to put bytes in
   * the renderer's cache before a boundary opens, and a hole has no bytes to
   * warm. Stopping at the cursor's own position keeps a one-live-drawing gallery
   * from asking for the drawing already on screen.
   */
  nextLive() {
    const n = this.queue.length;
    if (n === 0) return null;
    const at = this.queue.indexOf(this.cursor.id);
    const from = at >= 0 ? at : -1; // cursor names nothing in the queue: scan from the front
    for (let k = 1; k < n; k++) {
      const cand = this.queue[(((from + k) % n) + n) % n];
      if (this.byId(cand)) return cand;
    }
    return null;
  }

  /**
   * liveIds() -> the queue with pruned entries dropped, in admission order.
   *
   * NOT the lap the gallery walks - the lap is the queue, holes included, so a
   * pruned drawing's turn stays its own. This is the roster with the holes
   * filtered out: what the count answers, and where the anchor looks for the
   * first drawing to show (a queue whose front entry is a hole must not open the
   * show on a break). Recomputed rather than cached, because remove()/drop() can
   * land between reads and a stale cache would count a deleted drawing live.
   */
  liveIds() {
    const inStore = new Set(this.list.map((e) => e.id));
    const out = [];
    for (const id of this.queue) if (inStore.has(id)) out.push(id);
    return out;
  }

  /**
   * Walk the cursor to slot `slot`, in one step. Returns whether it moved, so the
   * caller writes the file only when something changed.
   *
   * The step is over the QUEUE - permanent positions, holes included - so a
   * delete cannot move any surviving drawing's turn. A boundary that lands on a
   * hole steps on to the next live position: the hole keeps its place in the lap
   * (the lap stays `positions` slots long) but never answers a slot, so the
   * break between two drawings is one animation, not a hole-slot of animation
   * followed by the next slot's own break. Only a gallery with NOTHING live
   * answers a null `cur`, and the renderer's hole path (see galleryFrame) paints
   * the break for it. `nextId` is always live, so the prefetch never asks for a
   * 404.
   *
   * Closed form rather than a loop because a reader can be very late: a wall
   * restarted after a night off has thousands of boundaries to catch up, and the
   * answer is one modulo, not one iteration per missed slot. prevId comes from
   * the position before the landing one, which is exact across any number of
   * catch-up steps: the queue is periodic, so the neighbour before a landing is
   * what the slot before this one showed - a hole included, whose meta resolves
   * to null and whose transition the renderer spends on the break.
   */
  advance(slot) {
    if (this.cursor.slot === slot) return false;
    const steps = Math.max(1, slot - this.cursor.slot);
    const n = this.queue.length;
    if (n === 0) {
      this.cursor = { ...this.cursor, slot, id: null, prevId: null };
      this.touchCursor();
      return true;
    }
    const mod = (v) => ((v % n) + n) % n;
    const at = this.queue.indexOf(this.cursor.id);
    // A cursor naming nothing in the queue (a hand-edited file) resumes at the
    // front; a cursor on a HOLE resumes from the hole, one step on.
    let landed = mod(Math.max(0, at) + steps);
    /* A boundary that lands on a HOLE steps on to the next live position instead
     * of spending the slot on the break. A full slot of break animation, directly
     * followed by the break that ENDS the next drawing's slot, is the animation
     * playing twice in a row - what a deletion used to do. The hole still keeps
     * its position (the lap is still `n` slots long and every survivor keeps its
     * own turn); only the boundary refuses to be answered by nothing. A queue
     * with no live drawing at all lands on the hole, and `cur` answers null: the
     * empty gallery keeps its break, which is what the cadence asked for. */
    if (!this.byId(this.queue[landed])) {
      for (let k = 1; k < n; k++) {
        const cand = mod(landed + k);
        if (this.byId(this.queue[cand])) { landed = cand; break; }
      }
    }
    // prevId is the position before the landing one, walked back past any holes
    // the skip jumped over: it must name what the PREVIOUS slot actually showed
    // (a hole resolves to null, and a 'prev' transition into nothing is a flash
    // of dark at the seam). A lap of holes has nothing to walk back to and stays
    // a hole, whose meta resolves to null and whose transition goes to the break.
    let before = mod(landed - 1);
    if (!this.byId(this.queue[before])) {
      for (let k = 2; k <= n; k++) {
        const cand = mod(landed - k);
        if (this.byId(this.queue[cand])) { before = cand; break; }
      }
    }
    this.cursor = {
      ...this.cursor,
      slot,
      id: this.queue[landed],
      prevId: this.queue[before],
    };
    this.touchCursor();
    return true;
  }


  schedule(state) {
    const period = galleryPeriod(state);
    if (period < 1) return null;
    return this.gallery(Date.now() / 1000, period);
  }

  /** The ids this store has already been told about, for a peer's dedupe. */
  has(id) {
    return this.list.some((e) => e.id === id);
  }
}

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
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { newDrawing, pixelsFromHex, validateEntry } from './drawings.js';

export class DrawingStore {
  /** @param {string} file JSON file to persist to. */
  constructor(file) {
    this.file = file;
    /** @type {object[]} */
    this.list = [];
    /** @type {{id: string, seq: number}[]} */
    this.deleted = [];
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
      if (Number.isInteger(s.seq)) this.seq = Math.max(this.seq, s.seq);
      if (s.meta !== null && typeof s.meta === 'object') this.meta = s.meta;
    } catch {
      // The store is user data: a corrupt one is left on disk, not silently
      // overwritten (it is only written after a successful mutation).
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.list));
    writeFileSync(`${this.file}.state`, JSON.stringify({ seq: this.seq, deleted: this.deleted, meta: this.meta }));
  }

  get size() {
    return this.list.length;
  }

  /**
   * The list without the pixel payloads: what a public GET answers.
   *
   * Exactly {id, name, createdAt} - no seq, no origin, no secret. The gallery
   * renderer cycles by the clock and needs nothing else, and every field added
   * to a public list is one more thing a stranger can sort, correlate or
   * enumerate.
   *
   * Ordered by createdAt, HERE, at the source both servers answer from. The
   * gallery freezes its rotation against a slot's start time and reads the list
   * as "everything up to index count existed then", which is only true if the
   * list is in creation order. `this.list` is append-only in ARRIVAL order, and
   * entries adopted from the relay arrive in that order, not the order they were
   * drawn - so a copy that is not sorted would put a rotation index on the wrong
   * drawing. A stable sort also keeps same-millisecond entries in arrival order.
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
    this.save();
    return e;
  }

  byId(id) {
    return this.list.find((e) => e.id === id) ?? null;
  }

  /** Remove an entry and record the tombstone every peer needs. */
  remove(id) {
    const i = this.list.findIndex((e) => e.id === id);
    if (i < 0) return false;
    this.list.splice(i, 1);
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

  /** The ids this store has already been told about, for a peer's dedupe. */
  has(id) {
    return this.list.some((e) => e.id === id);
  }
}

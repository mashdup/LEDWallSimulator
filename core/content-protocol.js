/**
 * The content protocol: what a driver tab says to a companion content page.
 *
 * The wall app renders whatever a page shows; the content page is the author
 * surface. To drive content from the app (or any other tab on the same
 * origin), the two talk over a BroadcastChannel named CONTENT_CHANNEL, and
 * every message on it is one of these validated kinds. Validation lives here,
 * in core, so the browser page, the Node tools, and the tests all agree on
 * what a legal command is - a content page never executes a malformed
 * message, and a bad payload is a silent drop, not a thrown handler.
 *
 * Kinds:
 *   clear                          blank the canvas, stop everything
 *   fill    {color}                solid wall
 *   rect    {x, y, w, h, color}    draw a block of cells
 *   text    {text, color?, fps?, step?, loop?}   scroll a banner
 *   anim    {name: 'demo' | 'off'} start/stop the page's own demo
 *   pic     {pixels}  one 20x20 user drawing (hex RGBA wire form)
 *   gallery {interval?, gap?, gapAnim?, transition?, transitionSec?}
 *            cycle the saved drawings on the server, with an animation in the
 *            break between them and a transition into each slot
 */

import { isPixelHex } from './drawings.js';
import { TRANSITION_NAMES } from './transitions.js';

export const CONTENT_CHANNEL = 'ledwall-content';
export const CONTENT_PROTOCOL_V = 1;

export const CONTENT_KINDS = ['clear', 'fill', 'rect', 'text', 'anim', 'pic', 'gallery'];

/**
 * Named animations the content pages know how to draw. Every one is a pure
 * function of server time, so all instances - tabs, control pages, the
 * headless capture browser - render the identical frame at the same second.
 * 'off' stops animation (black); 'demo' is the original bouncing block.
 */
export const ANIM_NAMES = ['demo', 'bounce', 'rain', 'fire', 'plasma', 'bars', 'clock', 'snitch', 'sparkle', 'pumpkin', 'off'];

/**
 * What may fill the break between gallery drawings: every animation, plus
 * 'none' for a wall that simply goes dark between pictures.
 */
export const GAP_ANIM_NAMES = ['none', ...ANIM_NAMES];

/** Re-exported so a consumer of the protocol has the transition list next to the cadence fields it validates. */
export { TRANSITION_NAMES } from './transitions.js';

/** The gallery cadence a page uses when it is told to "start the gallery" and nothing else is chosen. */
export const GALLERY_DEFAULTS = {
  interval: 8, gap: 5, gapAnim: 'rain', transition: 'fade', transitionSec: 1,
};

/**
 * gallerySlot(tSec, n, interval, gap, gapAnim, transitionSec) -> slot descriptor
 *
 * The whole cadence as one pure function of the shared server clock, so the
 * wall, a human's tab and a capture browser that loads fresh mid-cycle all land
 * on the same slot of the same cycle - and on the same frame of the same
 * transition. A slot is one drawing plus its break, so:
 *
 *   period = interval + gap;  slot = floor(t / period);  phase = t - slot*period
 *   drawing = slot mod n;     phase < interval ? drawing : the break
 *
 * `n` may be a NUMBER (a fixed list) or an ARRAY of metas carrying `createdAt`
 * (a live gallery). With an array the length is frozen per slot - a drawing
 * submitted mid-slot joins at the next boundary instead of re-anchoring every
 * boundary in the show. See the note in the body; this is the difference
 * between a guest submission appearing at the next changeover and the whole
 * gallery skipping.
 *
 * The transition opens EVERY seam of the slot, both ends of the drawing:
 *
 *   [break] --transition--> [drawing] --transition--> [break]
 *
 * and the descriptor says so - `from` is the frame the wall was on, `to` is
 * this slot's, `k` is 0..1 progress. Outside a transition window `from` is
 * null and `k` is 0.
 *
 * Both seams, not just the first: the cadence is one cycle, and a cycle that
 * is soft at one boundary and hard at the next is exactly the asymmetry the
 * eye reads as a fault - the wall fades into a drawing and then falls off a
 * cliff out of it. The blend at the end of a drawing runs INTO its own break,
 * and the break's frame is taken at the same `t` the renderer is drawing, so
 * the target is a live picture, not a frozen one: a wipe into `rain` is a wipe
 * of a moving curtain. `gapAnim: 'none'` (a dark break) makes the same seam a
 * fade to black, which is the nicer of the two.
 *
 * `transitionSec` is clamped to HALF the drawing, minus a quarter second, so
 * both blends fit inside the part of the slot they belong to and finish before
 * the other seam starts. A blend that runs past a boundary finds its own target
 * changed under it halfway through - the frame it is blending toward is no
 * longer the one it started from - and two overlapping blends have no defined
 * result at all.
 *
 * `gap`, `transitionSec` and friends are CLAMPED, not validated: this is a
 * renderer's arithmetic on a clock, and a renderer must never throw in the
 * middle of a frame. The protocol gate is what rejects a bad message; this is
 * what survives one. Negative time is real (clock skew), so `pos` is wrapped
 * into range before it indexes anything.
 *
 * Returns {drawing, anim, from, k}. An empty gallery is {drawing: -1,
 * anim: null, from: null, k: 0} - dark, and never an index into an empty list.
 */
export function gallerySlot(tSec, n, interval = 8, gap = 0, gapAnim = 'none', transitionSec = 0) {
  const show = Math.max(1, Number(interval) || 1);
  const brk = Math.max(0, Number(gap) || 0);
  const period = show + brk;

  /* The list length this slot may use is frozen AT THE SLOT; see slotFor.
   * This is what stops a guest submission from resetting the show. */
  const { count, drawing } = slotFor(tSec, n, period);
  if (count === 0) return { drawing: -1, anim: null, from: null, k: 0 };
  const breakSlot = () => ({ drawing: -1, anim: gapAnim === 'none' ? null : gapAnim });
  const phase = tSec - Math.floor(tSec / period) * period;

  if (brk > 0 && phase >= show) {
    // The break proper: the blend that opened it finished at this instant.
    return { ...breakSlot(), from: null, k: 0 };
  }

  const cur = { drawing, anim: null };
  // Half the drawing, so the seam at the start and the seam at the end of the
  // same drawing each get their blend and never meet in the middle.
  const trans = Math.max(0, Math.min(Number(transitionSec) || 0, (show - 0.25) / 2));
  if (trans <= 0) return { ...cur, from: null, k: 0 };

  // The seam at the START of the drawing: from what the previous slot was
  // showing when it ended - its break, if there is one, otherwise its drawing.
  if (phase < trans) {
    const from = brk > 0 ? breakSlot() : prevSlot(tSec, n, period);
    return { ...cur, from, k: phase / trans };
  }

  // The seam at the END of the drawing: this slot's own break is the target,
  // and the drawing is what the wall is leaving. `to` is the break, so the
  // renderer paints the break and blends the drawing over it by 1-k.
  if (brk > 0 && phase >= show - trans) {
    return { ...breakSlot(), from: cur, k: (phase - (show - trans)) / trans };
  }

  return { ...cur, from: null, k: 0 };
}

/**
 * slotFor(tSec, n, period) -> {slotIndex, count, drawing}
 *
 * The rotation, as arithmetic on the shared clock. Two decisions live here and
 * they are the whole fix for "a submission jumps the gallery":
 *
 * 1. A slot is `floor(t / period)` - a boundary in ABSOLUTE time. It used to be
 *    `floor((t mod (count * period)) / period)`, so the modulus carried the
 *    list length and a guest who submitted a drawing moved every boundary in
 *    the show: the drawing on the wall changed mid-slot, a break appeared where
 *    a drawing was, and a transition fired for it. A period-only modulus can
 *    not be moved by anything but the cadence settings.
 *
 * 2. `count` is the number of drawings that already existed when this slot
 *    BEGAN. `n` is either a number (a fixed list, all of it eligible) or an
 *    array of metas carrying `createdAt` (a live gallery). With the array, a
 *    drawing submitted mid-slot joins at the next boundary, which is the only
 *    moment the viewer has already been shown is a change point.
 *
 * 3. The rotation is a QUEUE, walked from each drawing's own eligibility slot -
 *    see queuePos. A submission appends to the back and is reached after a full
 *    lap; it never re-positions the drawings already in line.
 *
 * Both stay pure functions of server time plus data the server already has, so
 * the wall, a human's tab and a capture browser loading mid-cycle still agree.
 *
 * `createdAt` is epoch milliseconds and `tSec` is the same server clock divided
 * by 1000, so the boundary `slotIndex * period` in seconds is
 * `slotIndex * period * 1000` in the entries' own unit.
 */
function slotFor(tSec, n, period) {
  const slotIndex = Math.floor(tSec / period);
  const count = countAt(slotIndex, n, period);
  if (count === 0) return { slotIndex, count: 0, drawing: -1 };
  if (!Array.isArray(n)) return { slotIndex, count, drawing: wrap(slotIndex, count) };
  return { slotIndex, count, drawing: queuePos(slotIndex, n, period) };
}

/**
 * queuePos(slotIndex, metas, period) -> the drawing index this slot shows, or -1
 *
 * The gallery is a QUEUE: one slot per drawing, a new submission joins at the
 * back and is reached after a full lap. Nothing is skipped or repeated by the
 * arrival itself.
 *
 * Why not `slotIndex mod count`: that expression is discontinuous in `count`,
 * and a live gallery's `count` changes every time a guest submits. The wall's
 * position moves by whatever the two moduli happen to differ by. Measured at an
 * 8 s interval, one submission made the rotation go 0 -> 3, skipping two
 * drawings.
 *
 * The recurrence p -> (p + 1) mod c has no closed form when c changes, but c
 * changes only at a boundary where a drawing became eligible, and BETWEEN those
 * it is a plain +1. So walk the change points and close-form the stretches: one
 * step per distinct eligibility slot. Because the eligible PREFIX is indexed, an
 * appended drawing leaves every existing drawing at its own index, so walking
 * the stretches never has to re-base a position.
 *
 * Cost: one pass over the list plus one modulo per distinct eligibility slot.
 * The gallery is capped (--max-drawings, default 200), so that is a couple of
 * hundred cheap steps per frame at worst, and the list is already scanned once
 * per frame by countAt - the same order of work, not a new class of it.
 *
 * Deletions are the one case the walk cannot see, because a removed drawing
 * leaves no `createdAt` behind: the count taken from the surviving list can be
 * smaller than the history assumed, and the last modulo clamps the position back
 * into range. A pruning can shift the rotation by a lap - once, never during a
 * slot, and it cannot skip a drawing that still exists.
 */
function queuePos(slotIndex, metas, period) {
  const msPerSlot = period * 1000;
  const starts = [];
  for (const m of metas) if (Number.isFinite(m?.createdAt)) starts.push(Math.ceil(m.createdAt / msPerSlot));
  if (starts.length === 0) return -1;
  starts.sort((a, b) => a - b);

  /* Distinct change points, each with the count in effect from it onward.
   * Because metas is in createdAt order, starts is already sorted and the count
   * at the END of each group is simply its running index. */
  const marks = [];
  for (let i = 0; i < starts.length; ) {
    const slot = starts[i];
    while (i < starts.length && starts[i] === slot) i++;
    marks.push({ slot, count: i });
  }

  /* Walk only the change points at or before the slot asked for; one step per
   * distinct arrival slot, so a 200-drawing gallery costs at most 200.
   *
   * Within a stretch the queue is a plain +1 (wrapped at THAT stretch's count),
   * and the step INTO a change point wraps at the count after the newcomers are
   * in. The order is the rule: wrapping at the count before the arrival shifts
   * the pointer by however much the queue grew, which is precisely how a
   * submission came to skip the drawing that was next in line. */
  let pos = 0;               // the gallery's first slot shows its first drawing
  let cur = marks[0];
  for (let j = 1; j < marks.length; j++) {
    const next = marks[j];
    if (next.slot > slotIndex) break;
    pos = wrap(pos + (next.slot - cur.slot - 1), cur.count);   // run the stretch
    pos = wrap(pos + 1, next.count);                           // step into the change
    cur = next;
  }
  return wrap(pos + (slotIndex - cur.slot), cur.count);
}

// JS % follows the dividend's sign, and clock skew can make tSec negative.
function wrap(v, m) {
  return ((v % m) + m) % m;
}

/** How many of `n` existed at the start of slot `idx`. A number answers itself. */
function countAt(idx, n, period) {
  if (!Array.isArray(n)) return Number.isInteger(n) && n > 0 ? n : 0;
  const startMs = idx * period * 1000;
  let c = 0;
  for (const m of n) if (Number.isFinite(m?.createdAt) && m.createdAt <= startMs) c++;
  return c;
}

/**
 * The slot before this one, as `{drawing, anim}` the renderer can fetch. Asked
 * at the previous slot's midpoint, so it carries that slot's own frozen count:
 * a list that grew one boundary ago must not borrow the new length to name the
 * drawing the wall was actually on.
 */
function prevSlot(tSec, n, period) {
  const prev = slotFor(tSec - period / 2, n, period);
  return { drawing: prev.drawing, anim: null };
}

/**
 * galleryNextMeta(metas, tSec, interval, gap) -> meta | null
 *
 * The drawing the NEXT slot will show. A renderer uses this to fetch a new
 * drawing's pixels while the current one is still up, so a submission that
 * becomes eligible at the next boundary is on screen already instead of opening
 * as a dark frame - the one glitch a live gallery still has once the jumping is
 * fixed. Returns null when the next slot is a break or there is nothing to
 * fetch. Shares slotFor with the scheduler, so it cannot drift from it.
 */
export function galleryNextMeta(metas, tSec, interval = 8, gap = 0) {
  if (!Array.isArray(metas) || metas.length === 0) return null;
  const period = Math.max(1, Number(interval) || 1) + Math.max(0, Number(gap) || 0);
  /* Any instant inside the next slot names the same drawing, because a slot's
   * drawing index is constant across the slot (the break is a phase OF the slot,
   * not a slot of its own). tSec + period is inside slot+1 for every phase, so
   * this works while a drawing is up AND while the break is - which is the
   * moment a fetch actually helps, since the boundary is up to `gap` seconds
   * away and a fetch that waits for the boundary is a frame late. */
  const next = slotFor(tSec + period, metas, period);
  if (next.count === 0 || next.drawing < 0) return null;
  return metas[next.drawing] ?? null;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$/;

function isColor(v) {
  return typeof v === 'string' && COLOR_RE.test(v);
}

function intIn(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * makeMessage(kind, payload) -> validated message object.
 * Throws on an illegal payload so a broken sender fails loudly at the call
 * site, not silently on the receiving page.
 */
export function makeMessage(kind, payload = {}) {
  const m = parseMessage({v: CONTENT_PROTOCOL_V, kind, ...payload});
  if (m === null) throw new RangeError(`content: illegal ${kind} message: ${JSON.stringify(payload)}`);
  return m;
}

/** parseMessage(data) -> normalized message, or null if not a legal command. */
export function parseMessage(data) {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data === null || typeof data !== 'object') return null;
  if (data.v !== CONTENT_PROTOCOL_V) return null;
  if (!CONTENT_KINDS.includes(data.kind)) return null;

  switch (data.kind) {
    case 'clear':
      return {v: CONTENT_PROTOCOL_V, kind: 'clear'};
    case 'fill':
      return isColor(data.color) ? {v: CONTENT_PROTOCOL_V, kind: 'fill', color: data.color} : null;
    case 'rect':
      // 20x20 is the panel this protocol was drawn for; the receiving page
      // clips, so the bound here is sanity, not a hard panel contract.
      if (!isColor(data.color)) return null;
      if (!intIn(data.x, 0, 999) || !intIn(data.y, 0, 999)) return null;
      if (!intIn(data.w, 1, 999) || !intIn(data.h, 1, 999)) return null;
      return {v: CONTENT_PROTOCOL_V, kind: 'rect', x: data.x, y: data.y, w: data.w, h: data.h, color: data.color};
    case 'text': {
      if (typeof data.text !== 'string' || data.text.length === 0) return null;
      if (data.text.length > 2000) return null;
      const m = {v: CONTENT_PROTOCOL_V, kind: 'text', text: data.text};
      if (data.color !== undefined) {
        if (!isColor(data.color)) return null;
        m.color = data.color;
      }
      // fps/step ride the Scroller contract: positive integers, sane bounds.
      for (const k of ['fps', 'step']) {
        if (data[k] !== undefined) {
          if (!Number.isInteger(data[k]) || data[k] < 1 || data[k] > 120) return null;
          m[k] = data[k];
        }
      }
      if (data.loop !== undefined) {
        if (typeof data.loop !== 'boolean') return null;
        m.loop = data.loop;
      }
      return m;
    }
    case 'anim':
      return ANIM_NAMES.includes(data.name)
        ? {v: CONTENT_PROTOCOL_V, kind: 'anim', name: data.name}
        : null;
    case 'pic':
      // The drawing itself rides in the message: a driver tab can show a
      // picture on the wall without it ever being saved to the gallery.
      return isPixelHex(data.pixels)
        ? {v: CONTENT_PROTOCOL_V, kind: 'pic', pixels: data.pixels.toLowerCase()}
        : null;
    case 'gallery': {
      // The list lives on the server (GET /drawings); the message carries
      // only the cadence. The renderer picks the entry from the shared
      // server clock, so every instance shows the same drawing - and the
      // same break between drawings, for the same reason: the break is a
      // slot in the same clock arithmetic, not a timer anyone starts.
      const m = {v: CONTENT_PROTOCOL_V, kind: 'gallery'};
      if (data.interval !== undefined) {
        if (!intIn(data.interval, 1, 600)) return null;
        m.interval = data.interval;
      }
      if (data.gap !== undefined) {
        // 0 is legal and means "no break": the gallery is back to plain cycling.
        if (!intIn(data.gap, 0, 600)) return null;
        m.gap = data.gap;
      }
      if (data.gapAnim !== undefined) {
        if (!GAP_ANIM_NAMES.includes(data.gapAnim)) return null;
        m.gapAnim = data.gapAnim;
      }
      if (data.transition !== undefined) {
        if (!TRANSITION_NAMES.includes(data.transition)) return null;
        m.transition = data.transition;
      }
      if (data.transitionSec !== undefined) {
        // Whole seconds: the cadence is spoken in seconds everywhere else, and
        // a 0.4 s value nobody can type into a number input is a value that
        // will never be set. 0 is legal and means a hard cut.
        if (!intIn(data.transitionSec, 0, 30)) return null;
        m.transitionSec = data.transitionSec;
      }
      return m;
    }
    default:
      return null;
  }
}

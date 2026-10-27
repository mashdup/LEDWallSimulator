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

import { isPixelHex, GRID } from './drawings.js';
import { TRANSITION_NAMES, applyTransition } from './transitions.js';

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

/* The gallery has NO rotation function, and must not get one back.
 *
 * It used to: gallerySlot(t, n, ...) computed 'drawing = slot mod count' (then a
 * frozen-per-slot count, then a reconstructed queue walk - three attempts at the
 * same idea). All three were unstable, for one reason: an index into a mutable
 * roster re-bases whenever the roster does. A guest adding a drawing re-anchored
 * every boundary in the show and the wall skipped to it; pruning one moved the
 * pointer BACKWARDS and the same drawing came round twice. Both were the same bug
 * reported twice, and no arithmetic over a live list can fix it - the fact
 * 'which drawing is on screen now' is not in the list.
 *
 * It is in DrawingStore's cursor instead: an id, remembered, advanced one queue
 * position per boundary at read time (a pruned position lands as a hole, and the
 * renderer paints the break). core/content-protocol.js is left holding the
 * clock half only (galleryPeriod, galleryTiming), which is pure and cannot be
 * disturbed by the roster. Re-adding a derived rotation here would reintroduce
 * the fault and the test suite would pass, because the fault only appears when
 * the list changes mid-show - which is what a party does constantly.
 */

/**
 * galleryPeriod(state) -> seconds per slot, or 0 if there is no gallery cadence.
 *
 * The one place that knows a slot is interval + gap. Both servers need it to
 * advance the store's cursor and every renderer needs it to place the phase
 * inside the slot, and two copies of that sum are two chances for a boundary to
 * land in different places on the wall and on the tab.
 */
export function galleryPeriod(state) {
  if (state?.kind !== 'gallery') return 0;
  const { show, brk } = cadence(state);
  return show + brk;
}

/**
 * cadence(state) -> {show, brk}, the two durations normalised.
 *
 * One place, because a slot is `show + brk` in the server's cursor and the same
 * sum in the renderer's phase: two copies of the clamping are two chances for a
 * boundary to land in one place on the wall and another in the tab. interval
 * clamps up to 1 (a zero-length slot would make period 0 and divide the cursor's
 * slot arithmetic by it); gap clamps down to 0 (a negative break is not a break).
 */
function cadence(state) {
  const show = Math.max(1, Number(state?.interval) || 1);
  const brk = Math.max(0, Number(state?.gap) || 0);
  return { show, brk };
}

/**
 * galleryTiming(tSec, slotStart, period, state) -> {kind, anim, from, k}
 *
 * WHERE a slot is, never WHICH drawing is in it: identity comes from the
 * server's cursor (see DrawingStore.gallery), and this is the clock half.
 * Splitting the two is what makes the gallery survive a guest adding or
 * pruning a drawing - a phase cannot be disturbed by the roster, and an index
 * into the roster can, which is the bug this replaces.
 *
 * The transition opens EVERY seam of the slot, both ends of the drawing:
 *
 *   [break] --transition--> [drawing] --transition--> [break]
 *
 * `kind` is what the wall paints now ('drawing' or 'break'), `anim` is the
 * break's animation (null for a dark break, meaningless during a drawing),
 * `from` is the OTHER side of the blend and `k` is 0..1 progress toward `kind`.
 * Outside a transition window `from` is null and `k` is 0.
 *
 * Both seams, not just the first: the cadence is one cycle, and a cycle that is
 * soft at one boundary and hard at the next is exactly the asymmetry the eye
 * reads as a fault - the wall fades into a drawing and then falls off a cliff
 * out of it. The blend at the end of a drawing runs INTO its own break, and the
 * break's frame is taken at the same `t` the renderer is drawing, so the target
 * is a live picture, not a frozen one: a wipe into `rain` is a wipe of a moving
 * curtain. `gapAnim: 'none'` (a dark break) makes the same seam a fade to black.
 *
 * `transitionSec` is clamped to HALF the drawing, minus a quarter second, so both
 * blends fit inside the part of the slot they belong to and finish before the
 * other seam starts. A blend that runs past a boundary finds its own target
 * changed under it halfway through - the frame it is blending toward is no
 * longer the one it started from - and two overlapping blends have no defined
 * result at all.
 *
 * Clamped, not validated: a renderer must never throw in the middle of a frame.
 * Negative time is real (clock skew, and a renderer whose poll is older than the
 * slot the server just opened), so the phase is wrapped into [0, period) before
 * anything is decided.
 */
export function galleryTiming(tSec, slotStart, period, state = {}) {
  const { show, brk } = cadence(state);
  const p = Number(period) || 0;
  /* `anim` is what this cadence's BREAK looks like, and it is populated on every
   * path, not only when kind === 'break'. kind says what the slot is SHOWING;
   * anim says what the break frame WOULD be, and a frame builder needs both at
   * once: the slot of a deleted drawing is kind 'drawing' with no drawing to
   * paint, and its substitute is exactly this break. Reading anim only when kind
   * is 'break' makes that hole paint black on a wall that has a break animation
   * configured - a bug found by a test, not by the eye. */
  const gapAnim = state.gapAnim ?? 'none';
  const anim = gapAnim === 'none' ? null : gapAnim;
  if (p < 1) return { kind: 'break', anim, from: null, k: 0 };

  const phase = (((tSec - slotStart) % p) + p) % p;

  if (brk > 0 && phase >= show) {
    // The break proper: the blend that opened it finished at this instant.
    return { kind: 'break', anim, from: null, k: 0 };
  }

  const trans = Math.max(0, Math.min(Number(state.transitionSec) || 0, (show - 0.25) / 2));
  if (trans <= 0) return { kind: 'drawing', anim, from: null, k: 0 };

  // The seam at the START of the drawing: from what the slot before this one
  // ended with - its break if there is one, otherwise its drawing. Which drawing
  // that was is the cursor's answer (`prev`), never this function's business.
  if (phase < trans) {
    return { kind: 'drawing', anim, from: brk > 0 ? 'break' : 'prev', k: phase / trans };
  }

  // The seam at the END of the drawing: this slot's own break is the target, and
  // the drawing is what the wall is leaving. kind is the break, so the renderer
  // paints the break and blends the drawing over it by 1-k.
  if (brk > 0 && phase >= show - trans) {
    return { kind: 'break', anim, from: 'drawing', k: (phase - (show - trans)) / trans };
  }

  return { kind: 'drawing', anim, from: null, k: 0 };
}

/**
 * galleryFrame(tSec, sched, state, fetch) -> 1200 flat RGB bytes
 *
 * The whole gallery picture in one call: the server's schedule (WHO) plus the
 * clock (WHERE in the slot) plus two byte suppliers. Both renderers go through
 * this, because a gallery composed twice is a gallery that can drift - the same
 * reason the animation switch was removed from content.html.
 *
 * `fetch` is `{ pic(id, tSec), anim(name, tSec) }`. Pixels come from the
 * renderers' own caches and fetching, which core has no business with; core
 * decides only WHICH id and WHICH animation to ask for, and how to blend them.
 * A pic supplier that has not got the bytes yet returns dark and retries next
 * frame - that is the renderers' contract, not this function's.
 *
 * `sched` is the store's answer: {cur, prev, next, slotStart, period}. A null
 * cur is an empty gallery: dark, and never a crash on a missing id.
 */
export function galleryFrame(tSec, sched, state, fetch) {
  const dark = new Uint8Array(GRID * GRID * 3);
  const tm = galleryTiming(tSec, sched.slotStart, sched.period, state);
  /* The break frame is built ON DEMAND, once. tm.anim is populated on every path
   * (a hole needs it while kind says 'drawing'), so computing it eagerly would
   * render `rain` or `fire` - a full 1200-pixel animation - on every one of the
   * ~30 frames a second that show a drawing, and throw it away. The memo keeps a
   * blend from building it twice in one frame. */
  let brkFrame = null;
  const breakOf = () => {
    if (brkFrame === null) brkFrame = tm.anim === null ? dark : fetch.anim(tm.anim, tSec);
    return brkFrame;
  };
  const drawingBytes = (which) => {
    const m = which === 'cur' ? sched.cur : which === 'prev' ? sched.prev : null;
    return m === null ? dark : fetch.pic(m.id, tSec);
  };

  /* Prefetch the drawing due NEXT, before anything else can return early.
   * A submission becomes eligible at the boundary, and if its pixels are only
   * asked for then, the boundary opens on a dark frame for a whole poll.
   * fetch.pic starts the download on a cache miss and is a no-op once it has
   * landed, so the bytes here are deliberately discarded.
   *
   * This sits at the TOP rather than beside the paint path because the slot of a
   * deleted drawing answers `cur === null` and returns early below: warming the
   * next drawing only on the paths that show one would mean a prune reliably
   * makes the FOLLOWING boundary open dark - the hole hides the next drawing AND
   * fails to prepare it. Skipped when next is cur: a one-drawing gallery is
   * already showing it. */
  if (sched.next !== null && sched.next.id !== sched.cur?.id) fetch.pic(sched.next.id, tSec);

  // What the wall is showing NOW, and what it came from. `from` is a NAME here,
  // not bytes, because which side is which is the timing function's knowledge.
  if (tm.kind === 'drawing' && sched.cur === null) {
    /* The drawing pinned to this slot was deleted mid-slot, or the gallery is
     * empty. Its pixels cannot be fetched, so the rest of the slot goes to the
     * break (dark when the cadence has none) rather than holding a frame that no
     * longer exists - a deletion that keeps showing what it removed is the wrong
     * kind of smooth.
     *
     * If the slot is mid-TRANSITION into that drawing, the blend still runs, but
     * toward the break instead: k is progress toward what this slot was going to
     * show, so spending it on the substitute is what keeps the seam soft. */
    const target = breakOf();
    if (tm.from === 'prev') {
      return applyTransition(state.transition ?? 'none', drawingBytes('prev'), target, tm.k);
    }
    return target;
  }
  const to = tm.kind === 'break' ? breakOf() : drawingBytes('cur');

  if (tm.from === null) return to;
  const from = tm.from === 'break'
    ? breakOf()
    : tm.from === 'prev' ? drawingBytes('prev') : drawingBytes('cur');
  // applyTransition, not a private blend: fade/wipe/dissolve/slide are the
  // gallery's feature, and wipe and dissolve are DIRECTIONAL and cell-ordered.
  // Re-deriving the blend here would quietly turn every transition into a fade
  // and the wall would look wrong while every test still passed.
  return applyTransition(state.transition ?? 'none', from, to, tm.k);
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

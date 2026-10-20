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
export const ANIM_NAMES = ['demo', 'bounce', 'rain', 'fire', 'plasma', 'bars', 'clock', 'snitch', 'sparkle', 'off'];

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
 * transition. A slot is one drawing plus its break, so a cycle is n slots:
 *
 *   period = interval + gap;  pos = t mod (n * period)
 *   slot   = floor(pos / period);  phase = pos - slot * period
 *   phase < interval ? drawing[slot] : the break
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
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  if (count === 0) return { drawing: -1, anim: null, from: null, k: 0 };
  const show = Math.max(1, Number(interval) || 1);
  const brk = Math.max(0, Number(gap) || 0);
  const breakSlot = () => ({ drawing: -1, anim: gapAnim === 'none' ? null : gapAnim });

  const period = show + brk;
  const cycle = count * period;
  const pos = ((tSec % cycle) + cycle) % cycle;
  const slot = Math.floor(pos / period);
  const phase = pos - slot * period;

  if (brk > 0 && phase >= show) {
    // The break proper: the blend that opened it finished at this instant.
    return { ...breakSlot(), from: null, k: 0 };
  }

  const cur = { drawing: slot, anim: null };
  // Half the drawing, so the seam at the start and the seam at the end of the
  // same drawing each get their blend and never meet in the middle.
  const trans = Math.max(0, Math.min(Number(transitionSec) || 0, (show - 0.25) / 2));
  if (trans <= 0) return { ...cur, from: null, k: 0 };

  // The seam at the START of the drawing: from what the previous slot was
  // showing when it ended - its break, if there is one, otherwise its drawing.
  if (phase < trans) {
    const from = brk > 0 ? breakSlot() : { drawing: (slot - 1 + count) % count, anim: null };
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

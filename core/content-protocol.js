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
 *   gallery {interval?}  cycle the saved drawings on the server
 */

import { isPixelHex } from './drawings.js';

export const CONTENT_CHANNEL = 'ledwall-content';
export const CONTENT_PROTOCOL_V = 1;

export const CONTENT_KINDS = ['clear', 'fill', 'rect', 'text', 'anim', 'pic', 'gallery'];

/**
 * Named animations the content pages know how to draw. Every one is a pure
 * function of server time, so all instances - tabs, control pages, the
 * headless capture browser - render the identical frame at the same second.
 * 'off' stops animation (black); 'demo' is the original bouncing block.
 */
export const ANIM_NAMES = ['demo', 'bounce', 'rain', 'fire', 'plasma', 'bars', 'clock', 'snitch', 'off'];

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
      // server clock, so every instance shows the same drawing.
      const m = {v: CONTENT_PROTOCOL_V, kind: 'gallery'};
      if (data.interval !== undefined) {
        if (!Number.isInteger(data.interval) || data.interval < 1 || data.interval > 600) return null;
        m.interval = data.interval;
      }
      return m;
    }
    default:
      return null;
  }
}

/**
 * The animation library as pure bytes: animFrame(state, t) -> flat RGB.
 *
 * Every animation is a pure function of server time - no local state, no
 * Math.random (texture comes from deterministic coordinate hashes), so any
 * renderer - a browser tab, the wall app, a Node tool - computes the
 * identical frame at the same second. This is the same library content.html
 * draws to its canvas, in canvas-free form so the app tab (which holds the
 * audio keep-alive and is never throttled) can generate the wall's frames
 * itself: a hidden content tab throttles to ~1 Hz and starves the push,
 * which is exactly the frozen wall this moves away from.
 *
 * Phase discipline (see the jitter fix in content.html): t is seconds since
 * the epoch (~1.8e9); periodic math wraps it to one hour first, because at
 * 2e10 a double's spacing is ~4000 and modulo/hue arithmetic quantizes into
 * chaotic jumps. 'clock' is the one animation that must see the raw epoch.
 */

import { GRID, pixelsFromHex } from './drawings.js';

const ORANGE = [255, 136, 0];
const GREEN = [0, 255, 102];

function hash(n) {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a, b) => hash(a * 127.1 + b * 311.7);
  const s = (u) => u * u * (3 - 2 * u);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * s(xf);
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * s(xf);
  return a + (b - a) * s(yf);
}

/** HSL -> [r,g,b] 0..255. Exported: content.html's sparkle paints from these
 * exact numbers, so the capture browser and the frame driver agree on every
 * pink pixel instead of each trusting its own colour conversion. */
export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(h / 60)];
  return [(seg[0] + m) * 255, (seg[1] + m) * 255, (seg[2] + m) * 255];
}

/** #rgb / #rrggbb -> [r,g,b]; anything else -> white. */
export function parseHex(css) {
  if (typeof css !== 'string') return [255, 255, 255];
  let m = /^#([0-9a-f]{3})$/i.exec(css);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(css);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return [255, 255, 255];
}

/**
 * animFrame(state, tRaw, grid) -> Uint8Array(grid*grid*3) flat RGB.
 * state is a protocol message: anim{name}, fill{color}, clear, rect, demo,
 * pic{pixels}, gallery{interval}.
 *
 * The default branch is the DEMO, on purpose: a renderer that has just
 * loaded, with no command sent yet, shows something alive. That is also why
 * 'gallery' returns black here rather than falling through - a gallery state
 * is legal, and a driver that plays the demo in gallery mode is showing
 * confetti where a family drawing belongs.
 */
export function animFrame(state, tRaw, grid = 20) {
  const px = new Uint8Array(grid * grid * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= grid || y >= grid) return;
    const i = (y * grid + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const rect = (x, y, w, h, c) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c[0], c[1], c[2]);
  };
  const t = tRaw % 3600;

  switch (state.kind) {
    case 'clear':
      return px;
    case 'fill': {
      const c = parseHex(state.color);
      rect(0, 0, grid, grid, c);
      return px;
    }
    case 'rect': {
      rect(state.x, state.y, state.w, state.h, parseHex(state.color));
      return px;
    }
    case 'text':
      return px; // the banner pipeline owns text; see the app's Scroller path
    case 'pic': {
      // A user drawing: RGBA on the wire, RGB on the panel. A cell with a=0
      // is "not used", and the wall's black is exactly that - zero.
      const rgba = grid === GRID ? pixelsFromHex(state.pixels) : null;
      if (rgba === null) return px;
      for (let i = 0; i < grid * grid; i++) {
        px[i * 3] = rgba[i * 4];
        px[i * 3 + 1] = rgba[i * 4 + 1];
        px[i * 3 + 2] = rgba[i * 4 + 2];
      }
      return px;
    }
    case 'gallery':
      // Which entry is showing is a function of the server clock AND the
      // server's drawing list, so the driver resolves it to a pic state (see
      // app.js / content.html); this module never fetches.
      return px;
    default:
      break;
  }

  const name = state.kind === 'anim' ? state.name : 'demo';
  switch (name) {
    case 'off':
      return px;
    case 'bounce': {
      for (let k = 5; k >= 1; k--) {
        const tk = t - k * 0.09;
        const x = Math.round((Math.sin(tk * 1.7) * 0.5 + 0.5) * (grid - 1));
        const y = Math.round((1 - Math.abs(Math.sin(tk * 2.3))) * (grid - 1));
        const a = 1 - k / 6;
        set(x, y, ORANGE[0] * a, ORANGE[1] * a, ORANGE[2] * a);
      }
      const bx = Math.round((Math.sin(t * 1.7) * 0.5 + 0.5) * (grid - 1));
      const by = Math.round((1 - Math.abs(Math.sin(t * 2.3))) * (grid - 1));
      rect(bx, by, 2, 2, ORANGE);
      return px;
    }
    case 'rain': {
      for (let c = 0; c < grid; c++) {
        const speed = 5 + hash(c) * 9;
        const phase = hash(c + 100) * (grid + 6);
        const pos = (t * speed + phase) % (grid + 6);
        const head = Math.floor(pos);
        for (let k = 0; k < 5; k++) {
          const y = head - k;
          if (y < 0 || y >= grid) continue;
          const a = 1 - k / 5;
          if (k === 0) set(c, y, 191, 232, 255);
          else set(c, y, 60 * a, 140 * a, 255 * a);
        }
      }
      return px;
    }
    case 'fire': {
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const n = noise(x * 0.9, y * 0.9 - t * 7);
          const heat = Math.max(0, 1 - (grid - 1 - y) / (grid * 0.75)) * (0.55 + 0.45 * n);
          if (heat <= 0.08) continue;
          const c = heat > 0.85 ? [255, 255, 255] : heat > 0.6 ? [255, 210, 63] : heat > 0.35 ? [255, 90, 0] : [140, 29, 0];
          set(x, y, c[0], c[1], c[2]);
        }
      }
      return px;
    }
    case 'plasma': {
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const v = Math.sin(x / 3 + t * 1.1) + Math.sin(y / 4 + t * 0.7) + Math.sin((x + y) / 5 + t * 1.7);
          const [r, g, b] = hsl(((v + 3) / 6) * 300 + t * 12, 1, 0.52);
          set(x, y, r, g, b);
        }
      }
      return px;
    }
    case 'bars': {
      for (let x = 0; x < grid; x++) {
        const h = Math.max(1, Math.round(
          grid * 0.5 * (1 + 0.55 * Math.sin(t * 2.1 + x * 0.7) + 0.45 * Math.sin(t * 3.3 + x * 1.9)) / 2
        ));
        for (let y = grid - 1; y >= grid - h; y--) {
          const f = (grid - y) / grid;
          const c = f > 0.8 ? [255, 51, 85] : f > 0.55 ? [255, 204, 0] : [34, 221, 102];
          set(x, y, c[0], c[1], c[2]);
        }
      }
      return px;
    }
    case 'clock': {
      const d = new Date(tRaw * 1000);
      const sec = d.getSeconds() + d.getMilliseconds() / 1000;
      const min = d.getMinutes() + sec / 60;
      const hr = (d.getHours() % 12) + min / 60;
      const cx = (grid - 1) / 2;
      const cy = (grid - 1) / 2;
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 - Math.PI / 2;
        set(Math.round(cx + Math.cos(a) * 8), Math.round(cy + Math.sin(a) * 8), 51, 51, 51);
      }
      const hand = (frac, len, c) => {
        const a = frac * Math.PI * 2 - Math.PI / 2;
        for (let r = 1; r <= len; r++) set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), c[0], c[1], c[2]);
      };
      hand(hr / 12, 4, [255, 255, 255]);
      hand(min / 60, 6, [204, 204, 204]);
      hand(sec / 60, 7, [0, 255, 102]);
      set(Math.round(cx), Math.round(cy), 255, 255, 255);
      return px;
    }
    case 'snitch': {
      // The Golden Snitch: a night sky of faintly twinkling stars, and a
      // gold comet darting along a Lissajous path perturbed by smooth
      // noise - the erratic flit of something with wings. Deterministic
      // like every animation: same server second, same frame in every
      // renderer. The trail is analytic (past positions sampled from the
      // same function), so no state and no local clock.
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const star = hash(x * 157.3 + y * 71.7);
          if (star > 0.93) {
            const tw = 0.35 + 0.3 * Math.sin(t * (1.5 + star * 2) + star * 40);
            set(x, y, 45 * tw, 50 * tw, 80 * tw);
          } else {
            set(x, y, 6, 8, 22);
          }
        }
      }
      const pos = (tt) => [
        (grid - 1) * (0.5 + 0.4 * Math.sin(tt * 1.9) + 0.1 * (noise(tt * 1.3, 11.3) - 0.5) * 2),
        (grid - 1) * (0.5 + 0.4 * Math.sin(tt * 2.6 + 1.3) + 0.1 * (noise(tt * 1.3, 47.7) - 0.5) * 2),
      ];
      for (let k = 10; k >= 1; k--) {
        const [tx, ty] = pos(t - k * 0.05);
        const a = (1 - k / 11) * 0.55;
        set(Math.round(tx), Math.round(ty), 255 * a, 200 * a, 60 * a);
      }
      const [sx, sy] = pos(t);
      const cx = Math.round(sx);
      const cy = Math.round(sy);
      set(cx - 1, cy, 130, 100, 30);
      set(cx + 1, cy, 130, 100, 30);
      set(cx, cy - 1, 130, 100, 30);
      set(cx, cy + 1, 130, 100, 30);
      set(cx, cy, 255, 214, 90);
      return px;
    }
    case 'sparkle': {
      // Pink with sparkles: a deep rose field that drifts, and sparse cells
      // that flash white-pink on their own period. The field is the point -
      // the panel must READ pink from across the room - so the base sits low
      // (lightness 0.22-0.40) and the sparkles get the headroom.
      //
      // Which cells can twinkle, and when, comes from a coordinate hash: the
      // sparkle cells are fixed pixels with fixed phases, so every renderer
      // twinkles at the same cells in the same order, forever in phase, with
      // no state and no Math.random. The envelope is w^8 - a flash, not a
      // pulse: a wide flat base and a short bright peak, which is what a
      // sparkle is. The halo is a plus of neighbours at half the flash, so a
      // single lit cell reads as a star and not as a stray white pixel.
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const n = noise(x * 0.16 + t * 0.07, y * 0.16 - t * 0.05);
          const [r, g, b] = hsl(318 + 16 * (n - 0.5) * 2, 0.85, 0.22 + 0.18 * n);
          set(x, y, r, g, b);
        }
      }
      const flash = (x, y, f) => {
        if (x < 0 || y < 0 || x >= grid || y >= grid) return;
        const i = (y * grid + x) * 3;
        px[i] += (255 - px[i]) * f;
        px[i + 1] += (236 - px[i + 1]) * f;
        px[i + 2] += (248 - px[i + 2]) * f;
      };
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const seed = hash(x * 157.3 + y * 71.7);
          if (seed <= 0.86) continue;
          const period = 1.6 + seed * 4.0;
          const p = ((t + seed * 100) % period) / period;
          const w = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
          const f = w * w * w * w * w * w * w * w;
          if (f < 0.02) continue;
          flash(x, y, f);
          const h = f * 0.5;
          flash(x - 1, y, h);
          flash(x + 1, y, h);
          flash(x, y - 1, h);
          flash(x, y + 1, h);
        }
      }
      return px;
    }
    case 'pumpkin': {
      // Jack-o'-lantern for Halloween: a fat pumpkin on a night sky, a candle
      // flickering inside it, and a bat flapping across the top. Pure like
      // every animation: the flicker is the noise field sampled along the
      // time axis, so every renderer flickers in lockstep, no state.
      const cx = (grid - 1) / 2;
      const cy = grid * 0.62;
      const rx = grid * 0.36;
      const ry = grid * 0.28;
      const flick = noise(t * 5.7 + 13.1, 8.3);         // the candle, 0..1
      const candle = 0.72 + 0.28 * noise(t * 5.7, 3.7); // body glow envelope
      const glow = [255, 150 + 90 * flick, 40 + 120 * flick]; // light through the carve
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const star = hash(x * 157.3 + y * 71.7);
          if (star > 0.94) {
            // The twinkle is a shimmer of brightness, never a swap of role:
            // tw stays in [0.24, 1.0] so a star cell never sinks BELOW the
            // sky. A star dipping under the sky opens a dark hole that closes
            // again, and a hole reads as a color flicker, not a twinkle.
            const tw = 0.62 + 0.38 * Math.sin(t * (1.2 + star * 2) + star * 40);
            set(x, y, 70 * tw, 76 * tw, 118 * tw);
          } else {
            // Night blue, green-over-red: purple sky (red-over-green) reads
            // pink next to the blue stars, and the pair then alternates hue.
            set(x, y, 6, 8, 20);
          }
        }
      }
      // The body: an ellipse, dark at the rim, vertical ridges, brightened
      // toward the middle where the candle sits behind the wall of flesh.
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1) continue;
          const ridge = 0.82 + 0.18 * Math.cos(dx * 4.4);
          const f = candle * (0.85 + 0.15 * (1 - d2)) * ridge;
          set(x, y, 255 * f, 110 * f, 12 * f);
        }
      }
      const stem = Math.round(cy - ry) - 1;
      set(Math.round(cx), stem, 90 * candle, 60 * candle, 26 * candle);
      set(Math.round(cx) + 1, stem - 1, 70 * candle, 48 * candle, 22 * candle);
      // The carved face: candlelight through the cuts. Triangle eyes closing
      // toward the grin, a nose, a toothed zigzag mouth.
      const put = (x, y) => set(x, y, glow[0], glow[1], glow[2]);
      for (const s of [-1, 1]) {
        const ex = Math.round(cx + s * rx * 0.45);
        const ey = Math.round(cy - ry * 0.4);
        put(ex - 1, ey);
        put(ex, ey);
        put(ex + 1, ey);
        put(ex + (s < 0 ? 0 : -1), ey + 1);
        put(ex + (s < 0 ? 1 : -2), ey + 2);
      }
      const ny = Math.round(cy + ry * 0.15);
      put(Math.round(cx) - 1, ny);
      put(Math.round(cx), ny);
      const my = Math.round(cy + ry * 0.55);
      for (let x = Math.round(cx - rx * 0.55); x <= Math.round(cx + rx * 0.55); x++) put(x, my);
      put(Math.round(cx - rx * 0.35), my - 1);
      put(Math.round(cx + rx * 0.35), my - 1);
      put(Math.round(cx - rx * 0.15), my + 1);
      put(Math.round(cx + rx * 0.15), my + 1);
      // One bat per 34 s cycle, wings from a hard-flapping sign.
      const bt = t % 34;
      if (bt < 14) {
        const bx = Math.round(-2 + (bt / 14) * (grid + 4));
        const tip = Math.sin(bt * 14) > 0 ? -1 : 1;
        set(bx, 2, 52, 56, 84);
        set(bx - 1, 2 + tip, 52, 56, 84);
        set(bx + 1, 2 + tip, 52, 56, 84);
      }
      return px;
    }
    default: { // 'demo' and any future name falls back to the original
      const bx = Math.round((Math.sin(t * 1.3) * 0.5 + 0.5) * (grid - 1));
      const by = Math.round((Math.sin(t * 0.9) * 0.5 + 0.5) * (grid - 1));
      rect(bx, by, 2, 2, ORANGE);
      const secs = Math.floor(t) % grid;
      for (let x = 0; x <= secs; x++) set(x, grid - 1, GREEN[0], GREEN[1], GREEN[2]);
      return px;
    }
  }
}

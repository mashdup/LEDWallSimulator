/**
 * Sim — canvas preview of the wall.
 *
 * The sim is not decoration: it draws the same frame the wall will render, so
 * the only reason it exists is that it draws it *like a wall*. Two things have
 * to be right or the preview lies:
 *
 *   - Each cell is a SOFT RADIAL BLOB, not a hard square. A WS2812B behind a
 *     diffuser is a light patch roughly a cell and a half across, and two
 *     neighbouring patches SUM. Hard squares make a banner look crisp on screen
 *     and mushy on the wall — exactly the surprise the sim is supposed to
 *     remove. Blobs are composited with 'lighter' so overlapping light adds.
 *   - drawWall() puts every byte at the LED's TRUE physical cell, so a wrong
 *     layout shows up as mirrored/snaked text before anything is wired.
 *
 * Hot path: 400 blobs at 30 fps. NO CanvasGradient is allocated per cell. Each
 * gradient is built once in UNIT space (centre 0,0, outer radius 1) and cached
 * per distinct colour, then positioned and scaled with setTransform. One
 * gradient therefore serves every cell, every frame, and every resize, and a
 * text banner only ever touches a handful of them. (An offscreen blob sprite
 * would need document.createElement; keeping the gradient-and-transform trick
 * means this module never touches anything but the canvas it is handed.)
 *
 * DOM surface: the canvas element and its 2d context. No document, no fetch,
 * no timers, no serial.
 */

import { DEFAULT_COLS, DEFAULT_ROWS, BYTES_PER_PIXEL } from '../core/panel.js';

const DEFAULT_GLOW = 0.9;

/** CSS px per grid side used when the canvas has never been laid out. */
const FALLBACK_CSS = 400;

/**
 * Radial falloff approximating a LED behind a diffuser: bright core, long soft
 * skirt. A linear ramp would read as a hard-edged disc; this is close to the
 * measured gaussian-ish profile without needing a per-pixel model.
 * Flat [stop, alpha, stop, alpha, ...] so building a gradient allocates nothing.
 */
const FALLOFF = [
  0.0, 1.0,
  0.22, 0.9,
  0.45, 0.66,
  0.65, 0.4,
  0.82, 0.18,
  1.0, 0.0,
];

/**
 * Colour cache granularity: 7 bits per channel of the *normalised* colour.
 * 128 levels is invisible on a diffused blob but collapses the cache from
 * "one gradient per grey level per frame" to a bounded handful.
 */
const Q_BITS = 7;
const Q_STEP = 1 << (8 - Q_BITS); // 2
const Q_MAX = (1 << Q_BITS) - 1; // 127
const Q_MUL = 255 / Q_MAX;

/** Cap on cached gradients; a banner needs far fewer, this only bounds a stress pattern. */
const MAX_GRADIENTS = 1024;

const BACKGROUND = '#060608';
const GRID_MINOR = 'rgba(255,255,255,0.07)';
const GRID_MAJOR = 'rgba(255,255,255,0.18)';
const GRID_EDGE = 'rgba(255,255,255,0.3)';
const LABEL = 'rgba(255,255,255,0.55)';

/** 50 mm pitch: every 5th cell is a 250 mm reference point when measuring the real panel. */
const MAJOR_EVERY = 5;

export class Sim {
  #fitted;
  #cssW;
  #cssH;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.cols] default 20
   * @param {number} [opts.rows] default 20
   * @param {number} [opts.cell] CSS pixels per cell; default derived from canvas size
   * @param {number} [opts.glow] blob radius as a multiple of cell size; default ~0.9
   */
  constructor(canvas, opts = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Sim requires a canvas element');
    }
    // alpha:false: the panel is opaque, so the compositor can skip source-over
    // alpha bookkeeping on every blob.
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Sim requires a 2d canvas context');

    this.canvas = canvas;
    this.ctx = ctx;
    this.cols = dim(opts.cols ?? DEFAULT_COLS, 'cols');
    this.rows = dim(opts.rows ?? DEFAULT_ROWS, 'rows');
    this.glow = positive(opts.glow ?? DEFAULT_GLOW, 'glow');
    /** CSS px per cell, or null to derive it from the canvas box. */
    this.cellCss = opts.cell == null ? null : positive(opts.cell, 'cell');
    this.overlay = false;
    /** 'logical' after draw(), 'wall' after drawWall() — decides overlay labels. */
    this.mode = 'logical';
    /** Quantised colour key -> CanvasGradient in unit space. The whole point of the design. */
    this.gradients = new Map();
    /** Layout from the last drawWall(), used only for overlay labels. */
    this.layout = null;

    this.width = 0;
    this.height = 0;
    /** Device px per cell (opts.cell is CSS px; this is cell * dpr, rounded). */
    this.cell = 1;
    this.radius = 1;
    this.originX = 0;
    this.originY = 0;

    this.#fitted = false;
    this.#cssW = 0;
    this.#cssH = 0;
    this.#fit();
  }

  /**
   * Draw a Panel's logical grid (what you designed).
   * @param {import('../core/panel.js').Panel} panel
   */
  draw(panel) {
    if (!panel || !panel.pixels) throw new TypeError('draw expects a Panel');
    this.#useGrid(panel.cols, panel.rows);
    this.mode = 'logical';
    this.layout = null;
    this.#paint(panel.pixels, null);
    return this;
  }

  /**
   * Draw packed physical bytes at each LED's TRUE physical location —
   * the "what the wall actually sees" preview. For physical index p, the
   * bytes land at cell layout.cellOf(p).
   * @param {Uint8Array} physicalBytes 1200 bytes, physical order
   * @param {import('../core/layout.js').Layout} layout the REAL wiring
   */
  drawWall(physicalBytes, layout) {
    if (!layout || typeof layout.cellOf !== 'function') {
      throw new TypeError('drawWall requires the real Layout (core/layout.js); there is no logical fallback');
    }
    if (!physicalBytes) throw new TypeError('drawWall expects physical-order RGB bytes');

    const cells = layout.count ?? layout.cols * layout.rows;
    const expected = cells * BYTES_PER_PIXEL;
    if (physicalBytes.length !== expected) {
      throw new RangeError(`expected ${expected} bytes for ${cells} LEDs, got ${physicalBytes.length}`);
    }

    this.#useGrid(layout.cols, layout.rows);
    this.mode = 'wall';
    this.layout = layout;
    this.#paint(physicalBytes, layout);
    return this;
  }

  /**
   * Re-fit the canvas to its CSS box at devicePixelRatio. Safe to call any
   * time, including before the first draw.
   * @returns {{width: number, height: number, dpr: number, cell: number}}
   *          width/height are BACKING-STORE (device) pixels; cell is device px per cell.
   */
  resize() {
    this.#fit();
    this.#clear();
    return { width: this.width, height: this.height, dpr: this.dpr, cell: this.cell };
  }

  /**
   * Overlay a cell grid + index labels for calibration.
   *
   * Labels are INFERRED from the last draw call: after drawWall() they show the
   * PHYSICAL index of the LED that lands in that cell; after draw() they show
   * the logical index. Pass `mode` to force one regardless of what was drawn.
   * @param {boolean} on
   * @param {'logical'|'wall'} [mode]
   */
  setOverlay(on, mode = null) {
    this.overlay = !!on;
    if (mode === 'wall' || mode === 'logical') this.mode = mode;
    return this;
  }

  /**
   * Blob radius as a multiple of cell size. Tune against the real panel: if the
   * sim looks sharper than the wall, raise it.
   */
  setGlow(glow) {
    this.glow = positive(glow, 'glow');
    this.radius = this.cell * this.glow;
    return this;
  }

  /** Adopt a grid size different from the current one (panel and layout must agree with the sim). */
  #useGrid(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new RangeError(`grid must be positive integers, got ${cols}x${rows}`);
    }
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.#fit();
    }
  }

  /** Re-derive the backing-store size, device px per cell, and centring offset. */
  #fit() {
    const dpr = devicePixelRatio(this.canvas);
    const box = this.#cssBox();

    const width = Math.max(1, Math.round(box.width * dpr));
    const height = Math.max(1, Math.round(box.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const cellCss = this.cellCss ?? Math.min(box.width / this.cols, box.height / this.rows);
    // Integer device px per cell: keeps the grid aligned to the pixel grid so
    // overlay lines stay 1 px, and the leftover space goes to centring.
    const cell = Math.max(1, Math.round(cellCss * dpr));

    this.dpr = dpr;
    this.width = width;
    this.height = height;
    this.cell = cell;
    this.radius = cell * this.glow;
    this.originX = Math.round((width - cell * this.cols) / 2);
    this.originY = Math.round((height - cell * this.rows) / 2);

    this.#cssW = box.width;
    this.#cssH = box.height;
    this.#fitted = true;
  }

  /**
   * The canvas' CSS box.
   *
   * An unstyled canvas lays out at its ATTRIBUTE size, so writing
   * width = cssW * dpr makes the next clientWidth read back cssW * dpr and
   * resize() would multiply by dpr again on every call. The tell is that the
   * layout box equals the backing store: then the attribute is driving layout
   * and the box already chosen is the truth. When they differ, CSS is driving
   * layout, so the box is re-measured — that is the normal case for a canvas
   * sized by a stylesheet, and it is what makes a window resize work.
   *
   * Residual: a CSS box that happens to grow to exactly the current backing
   * size is read as "no change". It costs one scale step and recovers on the
   * next measurement; the alternative (getComputedStyle) is a DOM API this
   * module is not allowed to reach for.
   */
  #cssBox() {
    const el = this.canvas;
    const w = el.clientWidth;
    const h = el.clientHeight;

    if (this.#fitted && Math.abs(w - el.width) <= 1 && Math.abs(h - el.height) <= 1) {
      return { width: this.#cssW, height: this.#cssH };
    }
    // Not laid out at all (detached, display:none, zero-size container):
    // keep the last box we fitted to, else fall back to the canvas' own size.
    if (!(w > 0) || !(h > 0)) {
      if (this.#fitted) return { width: this.#cssW, height: this.#cssH };
      return {
        width: el.width > 0 ? el.width : FALLBACK_CSS,
        height: el.height > 0 ? el.height : FALLBACK_CSS,
      };
    }
    return { width: w, height: h };
  }

  /**
   * One frame: background, blobs, optional overlay.
   * @param {Uint8Array} bytes RGB, logical order when layout is null, physical order otherwise
   * @param {import('../core/layout.js').Layout|null} layout
   */
  #paint(bytes, layout) {
    const ctx = this.ctx;
    const { cols, rows, cell, originX, originY } = this;
    const right = originX + cols * cell;
    const bottom = originY + rows * cell;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    // The panel has an edge: light must not wash the canvas around it.
    ctx.beginPath();
    ctx.rect(originX, originY, cols * cell, rows * cell);
    ctx.clip();
    // Additive: two lit neighbours must sum, the way two light patches do.
    ctx.globalCompositeOperation = 'lighter';

    if (layout) {
      const inverse = layout.inverse;
      const n = cols * rows;
      if (inverse) {
        // Physical order: LED p lands in cell inverse[p]. cellOf(p) returns a
        // fresh [x,y] per call — 400 arrays a frame — and the inverse map is
        // the identical lookup without them.
        for (let p = 0; p < n; p++) {
          const i = p * BYTES_PER_PIXEL;
          const r = bytes[i];
          const g = bytes[i + 1];
          const b = bytes[i + 2];
          // A mostly-dark banner is mostly zero: a transparent blob is pure waste.
          if ((r | g | b) === 0) continue;
          const c = inverse[p];
          if (c < 0) continue;
          this.#blob(originX + ((c % cols) + 0.5) * cell, originY + (((c / cols) | 0) + 0.5) * cell, r, g, b);
        }
      } else {
        for (let p = 0; p < n; p++) {
          const at = layout.cellOf(p);
          if (at === null) continue;
          const i = p * BYTES_PER_PIXEL;
          const r = bytes[i];
          const g = bytes[i + 1];
          const b = bytes[i + 2];
          if ((r | g | b) === 0) continue;
          this.#blob(originX + (at[0] + 0.5) * cell, originY + (at[1] + 0.5) * cell, r, g, b);
        }
      }
    } else {
      // Logical order: row-major, which is also memory order — no modulo.
      let i = 0;
      for (let y = 0; y < rows; y++) {
        const cy = originY + (y + 0.5) * cell;
        for (let x = 0; x < cols; x++, i += BYTES_PER_PIXEL) {
          const r = bytes[i];
          const g = bytes[i + 1];
          const b = bytes[i + 2];
          if ((r | g | b) === 0) continue;
          this.#blob(originX + (x + 0.5) * cell, cy, r, g, b);
        }
      }
    }

    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (this.overlay) this.#drawOverlay(right, bottom);
  }

  /** One lit cell: cached unit-space gradient, placed and scaled in one transform. */
  #blob(cx, cy, r, g, b) {
    const ctx = this.ctx;
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    ctx.globalAlpha = max / 255;
    ctx.fillStyle = this.#gradient(r, g, b, max);
    const rad = this.radius;
    ctx.setTransform(rad, 0, 0, rad, cx, cy);
    // The gradient fades to alpha 0 at radius 1 and stays 0 beyond it, so a
    // square fill is enough — no arc, no path allocation.
    ctx.fillRect(-1, -1, 2, 2);
  }

  /**
   * Cached gradient for a colour. Normalised so the strongest channel is full
   * and the strength is carried in globalAlpha: dim anti-aliased glyph edges
   * then share the gradient of their full-bright hue instead of minting one
   * gradient per grey level.
   */
  #gradient(r, g, b, max) {
    const s = 255 / max;
    const qr = quant(r * s);
    const qg = quant(g * s);
    const qb = quant(b * s);
    const key = (qr << (2 * Q_BITS)) | (qg << Q_BITS) | qb;

    let grad = this.gradients.get(key);
    if (grad === undefined) {
      if (this.gradients.size >= MAX_GRADIENTS) {
        // Map preserves insertion order, so the first key is the oldest entry.
        this.gradients.delete(this.gradients.keys().next().value);
      }
      const R = Math.round(qr * Q_MUL);
      const G = Math.round(qg * Q_MUL);
      const B = Math.round(qb * Q_MUL);
      grad = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (let i = 0; i < FALLOFF.length; i += 2) {
        grad.addColorStop(FALLOFF[i], `rgba(${R},${G},${B},${FALLOFF[i + 1]})`);
      }
      this.gradients.set(key, grad);
    }
    return grad;
  }

  /**
   * Calibration overlay: cell grid plus one index per cell. This is a measuring
   * aid, not part of the 30 fps path — 400 fillText calls are the expensive
   * part of the whole module, so leave it off while scrolling.
   */
  #drawOverlay(right, bottom) {
    const ctx = this.ctx;
    const { cols, rows, cell, originX, originY } = this;

    ctx.lineWidth = 1;
    // Half-pixel offsets so a 1-device-px line does not straddle two columns.
    ctx.strokeStyle = GRID_MINOR;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = originX + x * cell + 0.5;
      ctx.moveTo(px, originY);
      ctx.lineTo(px, bottom);
    }
    for (let y = 0; y <= rows; y++) {
      const py = originY + y * cell + 0.5;
      ctx.moveTo(originX, py);
      ctx.lineTo(right, py);
    }
    ctx.stroke();

    ctx.strokeStyle = GRID_MAJOR;
    ctx.beginPath();
    for (let x = 0; x <= cols; x += MAJOR_EVERY) {
      const px = originX + x * cell + 0.5;
      ctx.moveTo(px, originY);
      ctx.lineTo(px, bottom);
    }
    for (let y = 0; y <= rows; y += MAJOR_EVERY) {
      const py = originY + y * cell + 0.5;
      ctx.moveTo(originX, py);
      ctx.lineTo(right, py);
    }
    ctx.stroke();

    ctx.strokeStyle = GRID_EDGE;
    ctx.strokeRect(originX + 0.5, originY + 0.5, cols * cell, rows * cell);

    const size = Math.max(7, Math.min(16, Math.round(cell * 0.3)));
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Labels sit on top of lit blobs, so they need their own dark halo.
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = Math.max(2, size * 0.35);
    ctx.fillStyle = LABEL;

    const wall = this.mode === 'wall' && this.layout !== null;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = y * cols + x;
        const label = wall ? this.layout.index(x, y) : c;
        ctx.fillText(String(label), originX + (x + 0.5) * cell, originY + (y + 0.5) * cell);
      }
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  #clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);
  }

}

/**
 * devicePixelRatio reached through the canvas' own window instead of the
 * global: sim.js must not assume a top-level window exists, and a canvas in a
 * detached document has none — fall back to 1 rather than throw.
 */
function devicePixelRatio(canvas) {
  const view = canvas.ownerDocument?.defaultView;
  const dpr = view?.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function quant(v) {
  const q = Math.round(v / Q_STEP);
  return q > Q_MAX ? Q_MAX : q < 0 ? 0 : q;
}

function positive(v, name) {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be > 0, got ${v}`);
  return v;
}

function dim(v, name) {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer, got ${v}`);
  return v;
}

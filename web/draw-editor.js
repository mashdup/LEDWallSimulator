// draw-editor.js - the 20x20 drawing surface both drawing pages share.
//
// Two pages need an editor: draw.html (the owner's editor, which can also put
// a picture on the wall right now) and public.html (the guest page, which can
// only add to the gallery). The EDITING is identical in both - the model, the
// pointer stroke, the undo stack, the flood fill, the tool and color state -
// and only the LOOK and the exits differ. Duplicated, the two would drift, and
// the drift would show up as "it looks right here and wrong there", which is
// the one failure a drawing app must not have.
//
// So: the editor owns core's RGBA bytes and paints them through a `paint`
// callback the page supplies. The page owns its pixels' appearance (a plain
// grid, or a lit LED matrix) and everything about the server. The canvas is
// the only DOM the editor touches.
//
// The model is core/drawings.js, shared with the server store and the wall
// renderer: the editor holds no parallel representation, so what is on screen
// is byte-for-byte what the wall paints.

import { GRID, emptyPixels, floodFill, parseColor } from '../core/drawings.js';

/** One-tap colors for people who do not want to open a picker. */
export const DEFAULT_PALETTE = [
  '#000000', '#ffffff', '#808080', '#c0c0c0',
  '#ff0000', '#ff6600', '#ffcc00', '#ffff00',
  '#66ff33', '#00ff88', '#00ffff', '#3399ff',
  '#0044ff', '#aa00ff', '#ff00ff', '#ff66aa',
  '#7b3f00', '#5cd6ff',
];

/** The most recent colors, per device: there are no accounts here. */
export function loadRecent(key, max = 10) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((c) => parseColor(c) !== null).slice(0, max) : [];
  } catch {
    return []; // private mode: recents are a convenience, not a requirement
  }
}

export function saveRecent(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ditto */
  }
}

/**
 * Flat cells with hairline grid lines: the honest "graph paper" look. A page
 * that wants its grid to read as a lit LED panel passes its own paint.
 */
export function flatPaint(ctx, pixels, { cell, size }) {
  // Black first: transparent cells must read as OFF, exactly as on the wall.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < GRID * GRID; i++) {
    if (pixels[i * 4 + 3] === 0) continue;
    ctx.fillStyle = `rgba(${pixels[i * 4]},${pixels[i * 4 + 1]},${pixels[i * 4 + 2]},${(pixels[i * 4 + 3] / 255).toFixed(3)})`;
    ctx.fillRect((i % GRID) * cell, ((i / GRID) | 0) * cell, cell, cell);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  for (let k = 1; k < GRID; k++) {
    ctx.beginPath(); ctx.moveTo(k * cell + 0.5, 0); ctx.lineTo(k * cell + 0.5, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, k * cell + 0.5); ctx.lineTo(size, k * cell + 0.5); ctx.stroke();
  }
}

/**
 * Create an editor on `canvas`.
 *
 *   cell      canvas pixels per LED cell; canvas.width must be cell * GRID
 *   paint     (ctx, pixels, {cell, size}) => void, defaults to flatPaint
 *   onChange  called after every mutation, with the editor
 *
 * The returned object is the page's whole interface to the drawing:
 * pixels / isEmpty / clear / undo / canUndo / setTool / setColor / render.
 */
export function createEditor(canvas, { cell = 32, paint = flatPaint, onChange = null } = {}) {
  if (canvas.width !== cell * GRID) {
    // A canvas that is not cell*GRID wide silently clips the grid: the last
    // column of the drawing is off screen, and the wall shows it. Fail loud.
    throw new Error(`draw-editor: canvas is ${canvas.width}px, needs ${cell * GRID} for ${cell}px cells`);
  }
  const ctx = canvas.getContext('2d');
  let pixels = emptyPixels();
  let tool = 'pencil';
  let color = '#ff3355';
  let drawing = false;
  const last = { x: -1, y: -1 };
  const undoStack = [];

  const api = {
    canvas,
    get pixels() { return pixels; },
    get tool() { return tool; },
    get color() { return color; },
    get onChange() { return onChange; },
    set onChange(fn) { onChange = fn; },
    setPixels(bytes) { pixels = bytes; render(); },
    isEmpty() {
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return false;
      return true;
    },
    setTool(t) { tool = t; },
    setColor(css) {
      const rgba = parseColor(css);
      if (rgba === null) return false;
      color = '#' + rgba.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
      render();
      return true;
    },
    render,
    undo() {
      if (undoStack.length === 0) return false;
      pixels = undoStack.pop();
      render();
      return true;
    },
    canUndo() { return undoStack.length > 0; },
    clear() {
      if (api.isEmpty()) return;
      pushUndo();
      pixels = emptyPixels();
      render();
    },
  };

  function render() {
    paint(ctx, pixels, { cell, size: canvas.width });
    if (onChange !== null) onChange(api);
  }

  function pushUndo() {
    undoStack.push(pixels.slice());
    if (undoStack.length > 40) undoStack.shift();
  }

  function setCell(x, y, rgba) {
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
    const p = (y * GRID + x) * 4;
    pixels[p] = rgba[0]; pixels[p + 1] = rgba[1]; pixels[p + 2] = rgba[2]; pixels[p + 3] = rgba[3];
  }

  // A finger on a phone moves in big steps between pointer events; without a
  // line between the last cell and this one, diagonal drags leave gaps.
  function lineTo(x, y, rgba) {
    let x0 = last.x, y0 = last.y;
    const dx = Math.abs(x - x0), dy = Math.abs(y - y0);
    const sx = x0 < x ? 1 : -1, sy = y0 < y ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      setCell(x0, y0, rgba);
      if (x0 === x && y0 === y) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const scale = canvas.width / r.width;
    return [
      Math.floor(((ev.clientX - r.left) * scale) / cell),
      Math.floor(((ev.clientY - r.top) * scale) / cell),
    ];
  }

  function apply(x, y) {
    const rgba = tool === 'eraser' ? [0, 0, 0, 0] : parseColor(color);
    if (tool === 'fill') {
      floodFill(pixels, x, y, rgba);
    } else if (last.x >= 0 && (x !== last.x || y !== last.y)) {
      lineTo(x, y, rgba);
    } else {
      setCell(x, y, rgba);
    }
    last.x = x; last.y = y;
    render();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    // A synthetic pointerdown (a test, an automation) has no pointer to
    // capture, and setPointerCapture throws on one - which would leave the
    // stroke unstarted.
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* nothing to capture */ }
    pushUndo();
    drawing = true;
    last.x = -1; last.y = -1;
    const [x, y] = cellAt(ev);
    apply(x, y);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drawing || tool === 'fill') return; // a fill is one tap, not a drag
    const [x, y] = cellAt(ev);
    if (x === last.x && y === last.y) return;
    apply(x, y);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, () => { drawing = false; last.x = -1; last.y = -1; });
  }

  render();
  return api;
}

/**
 * Transitions between wall frames, as pure bytes.
 *
 * A transition is a function of (from, to, k) where k is 0..1 progress, and
 * `from`/`to` are flat RGB grids (the same form animFrame returns). That is
 * the whole contract, and it is what makes a transition safe in this
 * architecture: the wall's frame is a pure function of the shared server
 * clock, so the progress of a wipe is not an animation anyone starts - it is
 * arithmetic on the same clock that picks the drawing (see gallerySlot). A
 * capture browser that loads mid-wipe, a phone tab, and the app tab that
 * drives the frames all compute the same k and land on the same half-wiped
 * frame.
 *
 * Every transition here is deterministic and stateless. The dissolve uses a
 * hash of the CELL COORDINATES, not randomness: the same cells dissolve in the
 * same order in every renderer, forever in phase.
 */

/** Names the gallery may use between slots. 'none' is a hard cut. */
export const TRANSITION_NAMES = ['none', 'fade', 'wipe', 'dissolve', 'slide'];

/**
 * cellHash(x, y) -> 0..1, deterministic.
 *
 * Integer mixing, no floating-point trig: the same value in Node and in every
 * Chromium, so a dissolve dissolves identically on the wall and in a test.
 */
export function cellHash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * applyTransition(name, from, to, k, grid) -> Uint8Array(grid*grid*3)
 *
 * k <= 0 is `from`, k >= 1 is `to`, byte for byte: a transition that has not
 * started and one that has finished must be indistinguishable from no
 * transition at all, or every slot boundary would flicker.
 *
 * An unknown name is a hard cut, not a guess: the protocol gate is what
 * rejects a bad name, and a renderer must never throw in the middle of a
 * frame.
 */
export function applyTransition(name, from, to, k, grid = 20) {
  const n = grid * grid * 3;
  const p = new Uint8Array(n);
  const prog = clamp01(k);
  // Progress is checked BEFORE the name: 'none' is a hard cut, and a hard cut
  // that never completes would leave the old frame on the wall forever. The
  // ends are the contract - k>=1 is `to` for every name, including 'none'.
  if (prog >= 1) { p.set(to.subarray(0, n)); return p; }
  if (name === 'none' || prog <= 0) { p.set(from.subarray(0, n)); return p; }

  switch (name) {
    case 'fade': {
      for (let i = 0; i < n; i++) p[i] = from[i] + (to[i] - from[i]) * prog;
      return p;
    }
    case 'wipe': {
      // A vertical bar sweeping left to right, with a lit leading edge: on a
      // 20-cell panel a bare 0/1 reveal reads as a jump, and an edge cell is
      // what makes it read as a sweep.
      const edge = prog * grid;
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const src = (y * grid + x) * 3;
          const on = x < edge;
          const lead = !on && x < edge + 1;
          if (lead) {
            p[src] = 255; p[src + 1] = 255; p[src + 2] = 255;
          } else if (on) {
            p[src] = to[src]; p[src + 1] = to[src + 1]; p[src + 2] = to[src + 2];
          } else {
            p[src] = from[src]; p[src + 1] = from[src + 1]; p[src + 2] = from[src + 2];
          }
        }
      }
      return p;
    }
    case 'dissolve': {
      // Each cell cross-fades on its own schedule, set by its coordinates.
      // The 0.24 band is the fade width around a cell's threshold: without it
      // the whole panel changes in 400 hard steps, which on an LED wall reads
      // as noise rather than a dissolve.
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const th = cellHash(x, y);
          const local = clamp01((prog - th + 0.12) / 0.24);
          for (let c = 0; c < 3; c++) {
            const i = (y * grid + x) * 3 + c;
            p[i] = from[i] + (to[i] - from[i]) * local;
          }
        }
      }
      return p;
    }
    case 'slide': {
      // The new drawing pushes in from the right and carries the old one off
      // the left edge. At k=0 the old frame is whole, at k=1 the new one is:
      // the two offsets are one movement, not two animations.
      const d = prog * grid;
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const i = (y * grid + x) * 3;
          const fx = x + d;
          const tx = x - (grid - d);
          if (tx >= 0) {
            const s = (y * grid + Math.floor(tx)) * 3;
            p[i] = to[s]; p[i + 1] = to[s + 1]; p[i + 2] = to[s + 2];
          } else if (fx < grid) {
            const s = (y * grid + Math.floor(fx)) * 3;
            p[i] = from[s]; p[i + 1] = from[s + 1]; p[i + 2] = from[s + 2];
          }
          // else: the gap between the two frames - black, which is the wall's
          // own background and needs no special case.
        }
      }
      return p;
    }
    default:
      p.set(from.subarray(0, n));
      return p;
  }
}

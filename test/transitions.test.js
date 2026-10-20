/**
 * Transitions as pure bytes: the frame at k, from two frames.
 *
 * The property that matters is at the ends: a transition that has not started
 * must be `from` byte for byte, and one that has finished must be `to`. If
 * either end is approximate, every slot boundary flickers, and on a wall that
 * runs for hours a flicker per drawing is the whole complaint.
 *
 * The middle is checked by shape, not by exact pixels: what "wipe at 40%"
 * means is a statement about which cells came from which frame, and that is
 * what a person sees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITION_NAMES, applyTransition, cellHash } from '../core/transitions.js';

const G = 20;
const N = G * G * 3;

function frame(r, g, b) {
  const p = new Uint8Array(N);
  for (let i = 0; i < N; i += 3) { p[i] = r; p[i + 1] = g; p[i + 2] = b; }
  return p;
}

const RED = frame(255, 0, 0);
const BLUE = frame(0, 0, 255);
const cell = (p, x, y) => [p[(y * G + x) * 3], p[(y * G + x) * 3 + 1], p[(y * G + x) * 3 + 2]];

test('every transition is exactly `from` at k<=0 and exactly `to` at k>=1', () => {
  for (const name of TRANSITION_NAMES) {
    for (const k of [-1, 0]) {
      assert.deepEqual(applyTransition(name, RED, BLUE, k, G), RED,
        `${name} at k=${k} must be the from frame, byte for byte`);
    }
    for (const k of [1, 2]) {
      assert.deepEqual(applyTransition(name, RED, BLUE, k, G), BLUE,
        `${name} at k=${k} must be the to frame, byte for byte`);
    }
  }
});

test('fade is a linear blend, and the midpoint is half of each', () => {
  const mid = applyTransition('fade', RED, BLUE, 0.5, G);
  // 255*0.5 = 127.5 -> 127 in both channels: the blend is arithmetic, and it
  // is symmetric, which is what "fade" means on a wall.
  assert.deepEqual(cell(mid, 5, 5), [127, 0, 127], 'half of each, in both channels');
  const q = applyTransition('fade', RED, BLUE, 0.25, G);
  assert.ok(cell(q, 0, 0)[0] > cell(mid, 0, 0)[0], 'the outgoing channel falls as progress rises');
  assert.ok(cell(q, 0, 0)[2] < cell(mid, 0, 0)[2], 'and the incoming one rises');
});

test('wipe reveals whole columns, left to right, with a lit leading edge', () => {
  const mid = applyTransition('wipe', RED, BLUE, 0.5, G);
  for (let y = 0; y < G; y++) {
    assert.deepEqual(cell(mid, 2, y), [0, 0, 255], 'the left is the new frame');
    assert.deepEqual(cell(mid, 18, y), [255, 0, 0], 'the right is still the old one');
  }
  // The edge cell is white: on a 20-cell panel a bare 0/1 reveal reads as a
  // jump, and the moving edge is what makes it read as a sweep.
  assert.deepEqual(cell(mid, 10, 10), [255, 255, 255], 'a lit leading edge');
});

test('slide moves one picture across and the other off, in one movement', () => {
  const mid = applyTransition('slide', RED, BLUE, 0.5, G);
  assert.deepEqual(cell(mid, 19, 0), [0, 0, 255], 'the new frame has entered from the right');
  assert.deepEqual(cell(mid, 0, 0), [255, 0, 0], 'the old frame is leaving to the left');
  // k=1 has no seam anywhere: the two offsets are one movement, so the last
  // frame is the new drawing whole, not a picture with an edge on it.
  assert.deepEqual(applyTransition('slide', RED, BLUE, 1, G), BLUE);
});

test('dissolve is per cell, deterministic, and finishes', () => {
  const a = applyTransition('dissolve', RED, BLUE, 0.5, G);
  const b = applyTransition('dissolve', RED, BLUE, 0.5, G);
  assert.deepEqual(a, b, 'the same k must give the same frame in every renderer, forever');

  let converted = 0;
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (cell(a, x, y)[2] === 255) converted++;
  assert.ok(converted > 100 && converted < 300,
    `half way through a dissolve about half the cells have moved, saw ${converted}`);

  // Every cell is on the schedule: a dissolve that skips cells would leave
  // them stuck at the old frame forever.
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const th = cellHash(x, y);
      assert.ok(th >= 0 && th <= 1, `cellHash(${x}, ${y}) = ${th} must be a progress point`);
    }
  }
  assert.notEqual(cellHash(0, 0), cellHash(7, 3), 'the schedule must vary across the panel');
});

test('an unknown transition is a hard cut, never a throw', () => {
  // The protocol gate rejects a bad name. This is the renderer, mid-frame, on
  // a message that got through some other way: it must paint, not crash.
  assert.deepEqual(applyTransition('teleport', RED, BLUE, 0.5, G), RED);
  assert.deepEqual(applyTransition(undefined, RED, BLUE, 0.5, G), RED);
  assert.deepEqual(applyTransition('none', RED, BLUE, 0.5, G), RED, 'and "none" is the old frame until k=1');
});

test('the output is always a full grid, whatever k is', () => {
  for (const name of TRANSITION_NAMES) {
    for (const k of [0, 0.1, 0.5, 0.9, 1]) {
      const p = applyTransition(name, RED, BLUE, k, G);
      assert.equal(p.length, N, `${name} at k=${k}`);
      assert.ok(p.every((v) => v >= 0 && v <= 255), `${name} at k=${k} stays in byte range`);
    }
  }
});

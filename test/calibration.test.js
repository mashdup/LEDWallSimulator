/**
 * calibration.test.js — the cross-language pin between core/calibration.js and
 * firmware/firmware.ino's SELFTEST.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Milestone 5 is "compare what the wall shows against what core/layout.js
 * predicts". That comparison is only meaningful if the patterns the firmware
 * paints and the patterns core/calibration.js predicts are the SAME pattern:
 * same four names, same order, same colours, same pace, same 20-wide grouping.
 * Nothing else in the project checks that. The firmware is C++ and the sim is
 * JS; no type system, build step, or shared header connects them, so the
 * contract lives here, as text.
 *
 * This file reads firmware/firmware.ino as a string and pins its literals —
 * the -D defaults, the self-test names, the printed colour legend, and the
 * arithmetic inside selftestRun() — against the exported JS constants. It does
 * not compile, flash, or shell out; it only requires that a future edit to
 * either side fails loudly here rather than quietly desynchronising the wall
 * from the prediction. Protocol constants (magic bytes, frame size) are already
 * pinned by test/frame.test.js and are deliberately not repeated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../core/panel.js';
import { Layout, identity } from '../core/layout.js';
import { pack } from '../core/buffer.js';
import { LED_COUNT } from '../core/frame.js';
import { WS2812_CHANNEL_MA } from '../core/power.js';
import {
  CALIBRATION_PATTERNS,
  CALIBRATION_TIMING,
  WALL_TIMING,
  INDEX_MAP_LEGEND,
  INDEX_MAP_GROUP,
  patternColor,
  patternPace,
  calibrationPattern,
  calibrationPhysicalBytes,
} from '../core/calibration.js';

const FIRMWARE = readFileSync(new URL('../firmware/firmware.ino', import.meta.url), 'utf8');

/**
 * One `#define NAME <number>` literal. Extracted rather than substring-matched
 * so a changed number produces "STALE_MS is 1200, expected staleMs 1500"
 * instead of a bare "not found".
 */
function define(name) {
  const m = FIRMWARE.match(new RegExp(`#define\\s+${name}\\s+(\\d+)`));
  assert.ok(m, `firmware/firmware.ino: no #define ${name} — the tunable was renamed or removed`);
  return Number(m[1]);
}

/** Assert an exact expression is present in the firmware, verbatim. */
function has(text, what) {
  assert.ok(FIRMWARE.includes(text), `firmware/firmware.ino: missing ${what}: ${JSON.stringify(text)}`);
}

/** Body of a firmware function, brace-matched, so checks stay inside one pattern. */
function body(signature) {
  const at = FIRMWARE.indexOf(signature);
  assert.ok(at >= 0, `firmware/firmware.ino: no function ${signature}`);
  const open = FIRMWARE.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < FIRMWARE.length; i++) {
    const c = FIRMWARE[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return FIRMWARE.slice(open + 1, i);
  }
  throw new Error(`firmware/firmware.ino: unterminated body for ${signature}`);
}

/** The four case blocks of selftestRun(), in source order. */
const SELFTEST_RUN = body('static void selftestRun(void)');
const CASE_MARKS = ['case SP_ALL_RED', 'case SP_COLUMN_SWEEP', 'case SP_WALK', 'case SP_INDEX_MAP', 'default:'].map(
  (label) => {
    const at = SELFTEST_RUN.indexOf(label);
    assert.ok(at >= 0, `firmware/firmware.ino: selftestRun has no ${label} case`);
    return at;
  },
);
const CASES = Object.fromEntries(
  CALIBRATION_PATTERNS.map((name, i) => [name, SELFTEST_RUN.slice(CASE_MARKS[i], CASE_MARKS[i + 1])]),
);

// -------------------------------------------------------------------------
// Timing: the -D defaults must equal CALIBRATION_TIMING
// -------------------------------------------------------------------------

/**
 * These are the numbers a human watches the wall with. If the flashed board
 * paces differently from the bridge and the sim, the two views of the panel are
 * not comparable and milestone 5's side-by-side is noise.
 */
test('firmware self-test timing equals CALIBRATION_TIMING', () => {
  const pins = [
    ['SELFTEST_RED_MS', 'redMs'],
    ['SELFTEST_COLUMN_MS', 'columnMs'],
    ['SELFTEST_WALK_MS', 'walkMs'],
    ['SELFTEST_INDEX_MS', 'indexMs'],
    ['SELFTEST_COLUMN_STEP_MS', 'columnStepMs'],
    ['SELFTEST_WALK_STEP_MS', 'walkStepMs'],
  ];
  for (const [macro, key] of pins) {
    assert.equal(
      define(macro),
      CALIBRATION_TIMING[key],
      `firmware #define ${macro} must equal CALIBRATION_TIMING.${key}`,
    );
  }
});

/** A pattern running for the right time is useless if it reads the wrong macro. */
test('patternMs maps each pattern to its own duration macro', () => {
  const patternMs = body('static uint32_t patternMs(uint8_t p)');
  const pins = [
    ['case SP_ALL_RED', 'SELFTEST_RED_MS'],
    ['case SP_COLUMN_SWEEP', 'SELFTEST_COLUMN_MS'],
    ['case SP_WALK', 'SELFTEST_WALK_MS'],
    ['default', 'SELFTEST_INDEX_MS'],
  ];
  for (const [label, macro] of pins) {
    const m = patternMs.match(new RegExp(`${label}:\\s*return \\(uint32_t\\)([A-Z_]+);`));
    assert.ok(m, `firmware patternMs(): no ${label} returning a timing macro`);
    assert.equal(m[1], macro, `firmware patternMs() ${label} must return ${macro}`);
  }
});

/** The animated patterns must step at their own pace, not a shared one. */
test('each animated pattern advances on its own step macro', () => {
  for (const [name, macro] of [['column-sweep', 'SELFTEST_COLUMN_STEP_MS'], ['walk', 'SELFTEST_WALK_STEP_MS']]) {
    const re = new RegExp(`stepNextMs = now \\+ \\(uint32_t\\)(${macro});`);
    assert.ok(
      CASES[name].match(re),
      `firmware selftestRun case SP_${name.toUpperCase().replace('-', '_')} must step by ${macro}`,
    );
  }
});

// -------------------------------------------------------------------------
// Watchdog / decoder timing: the -D defaults must equal WALL_TIMING
// -------------------------------------------------------------------------

test('firmware watchdog and status timing equals WALL_TIMING', () => {
  const pins = [
    ['STALE_MS', 'staleMs'],
    ['FADE_MS', 'fadeMs'],
    ['FADE_STEPS', 'fadeSteps'],
    ['PARTIAL_GAP_MS', 'partialGapMs'],
    ['STATUS_INTERVAL_MS', 'statusIntervalMs'],
    ['DEFAULT_LIMIT_MA', 'defaultLimitMa'],
  ];
  for (const [macro, key] of pins) {
    assert.equal(
      define(macro),
      WALL_TIMING[key],
      `firmware #define ${macro} must equal WALL_TIMING.${key}`,
    );
  }
});

/**
 * The takeover announcement must fire on the TRANSITION out of the self-test,
 * not on every frame.
 *
 * It sits in commitFrame(), which runs once per received frame. Unconditional, a
 * 30 fps stream prints 30 lines/s and buries the status line that the whole
 * calibration pass reads — measured on real hardware on COM8: 40 consecutive
 * `selftest: stopped` lines in a 4 s run, no status line visible.
 *
 * The JS mirror in tools/bridge.js already guarded it with `if (this.self.active)`;
 * the sketch drifted from it, which is exactly the drift this file exists to catch.
 */
test('the self-test takeover announcement is one-shot, not per frame', () => {
  const commit = body('static void commitFrame(void)');
  const guarded = /if\s*\(\s*selftestActive\s*\)\s*\{[^}]*selftest: stopped by host frame/s;
  assert.ok(
    guarded.test(commit),
    'firmware commitFrame(): the takeover println must be inside `if (selftestActive) { … }`, '
    + 'otherwise every frame prints a line and the status line is unreadable',
  );
  // The flag must be cleared inside that guard, or the announcement repeats.
  const block = commit.match(guarded)[0];
  assert.match(block, /selftestActive\s*=\s*false/, 'the guard must clear selftestActive');
});

// -------------------------------------------------------------------------
// Geometry and power: NUM_LED / CHANNEL_MA
// -------------------------------------------------------------------------

test('firmware NUM_LED and CHANNEL_MA equal the core constants', () => {
  assert.equal(define('NUM_LED'), LED_COUNT, 'firmware #define NUM_LED must equal core/frame.js LED_COUNT');
  assert.equal(
    define('CHANNEL_MA'),
    WS2812_CHANNEL_MA,
    'firmware #define CHANNEL_MA must equal core/power.js WS2812_CHANNEL_MA',
  );
  // The firmware's own static_assert is what keeps NUM_LED frozen at 400; if
  // that line goes away the pin above is the only thing holding the geometry.
  has('NUM_LED * 3u == LED_BYTES', 'the static_assert freezing NUM_LED to the 1200-byte payload');
});

// -------------------------------------------------------------------------
// Names: SELF_NAMES order must equal CALIBRATION_PATTERNS
// -------------------------------------------------------------------------

const NAME_MAP = {
  ALL_RED: 'all-red',
  COLUMN_SWEEP: 'column-sweep',
  WALK: 'walk',
  INDEX_MAP: 'index-map',
};

test('SELF_NAMES are CALIBRATION_PATTERNS in the same order', () => {
  const m = FIRMWARE.match(/static const char \*const SELF_NAMES\[SP_COUNT\] = \{([^}]*)\};/s);
  assert.ok(m, 'firmware/firmware.ino: no SELF_NAMES[SP_COUNT] table');
  const names = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);

  assert.equal(names.length, CALIBRATION_PATTERNS.length, 'SELF_NAMES count must equal CALIBRATION_PATTERNS');
  assert.deepEqual(
    names.map((n) => {
      assert.ok(n in NAME_MAP, `firmware self-test name "${n}" is not a known calibration pattern`);
      return NAME_MAP[n];
    }),
    [...CALIBRATION_PATTERNS],
    'SELF_NAMES, mapped to JS names, must equal CALIBRATION_PATTERNS in order',
  );

  // The enum drives the cycle; the table only labels it. Both must agree.
  const enumBody = FIRMWARE.match(/enum SelfPattern : uint8_t \{([^}]*)\}/s);
  assert.ok(enumBody, 'firmware/firmware.ino: no enum SelfPattern');
  const order = [...enumBody[1].matchAll(/\bSP_([A-Z_]+)\b/g)].map((x) => x[1]).filter((n) => n !== 'COUNT');
  assert.deepEqual(order, names, 'enum SelfPattern order must match SELF_NAMES order');
});

// -------------------------------------------------------------------------
// The index-map colour legend
// -------------------------------------------------------------------------

/**
 * The legend is the calibration instrument: you read a colour off the wall and
 * the legend tells you which physical index you are looking at. If the printed
 * legend and core/calibration.js disagree, the reading is wrong.
 */
test('the firmware prints INDEX_MAP_LEGEND verbatim', () => {
  has(INDEX_MAP_LEGEND, 'INDEX_MAP_LEGEND, verbatim');
  const m = FIRMWARE.match(/Serial\.println\(F\(\s*"  colour legend: ([^"]*)"\s*\)\)/);
  assert.ok(m, 'firmware/firmware.ino: no "colour legend:" println in selftestBeginPattern');
  assert.equal(m[1], INDEX_MAP_LEGEND, 'the printed colour legend must equal INDEX_MAP_LEGEND');
});

// -------------------------------------------------------------------------
// Pattern arithmetic: the firmware's expressions vs patternColor()
// -------------------------------------------------------------------------

test('all-red writes the same triple as patternColor("all-red")', () => {
  const m = CASES['all-red'].match(/selftestFillAll\((\d+),\s*(\d+),\s*(\d+)\)/);
  assert.ok(m, 'firmware selftestRun case SP_ALL_RED must fill every LED with one literal triple');
  assert.deepEqual(
    [Number(m[1]), Number(m[2]), Number(m[3])],
    patternColor('all-red', 0),
    'the all-red literal triple must equal patternColor("all-red", i)',
  );
});

test('column-sweep lights index % 20 == col with the same on/off triples', () => {
  const block = CASES['column-sweep'];

  const col = block.match(/const uint8_t col = \(uint8_t\)\(stepIndex % (\d+)u\);/);
  assert.ok(col, 'firmware column-sweep must derive the lit column as stepIndex % <group>u');
  assert.equal(
    Number(col[1]),
    INDEX_MAP_GROUP,
    'firmware column-sweep group must equal INDEX_MAP_GROUP (columns of the identity layout)',
  );

  const on = block.match(/const bool on = \(uint8_t\)\(i % (\d+)u\) == col;/);
  assert.ok(on, 'firmware column-sweep must light LEDs where i % <group>u == col');
  assert.equal(Number(on[1]), INDEX_MAP_GROUP, 'firmware column-sweep LED modulus must equal INDEX_MAP_GROUP');

  const lit = block.match(/lastFrame\[i \* 3 \+ 1\] = on \? (\d+) : (\d+);/);
  const tint = block.match(/lastFrame\[i \* 3 \+ 2\] = on \? (\d+) : (\d+);/);
  const dark = block.match(/lastFrame\[i \* 3 \+ 0\] = (\d+);/);
  assert.ok(lit && tint && dark, 'firmware column-sweep must write r/g/b per LED from the `on` flag');

  const group = INDEX_MAP_GROUP;
  const onColour = patternColor('column-sweep', group, group);
  const offColour = patternColor('column-sweep', 1, group);
  assert.deepEqual(onColour, [0, 255, 40], 'sanity: the JS lit colour is green with a faint blue tint');
  assert.deepEqual(offColour, [0, 0, 0], 'sanity: the JS unlit colour is black');

  assert.equal(Number(dark[1]), offColour[0], 'column-sweep red must be 0 for both lit and unlit LEDs');
  assert.deepEqual(
    [Number(lit[1]), Number(lit[2])],
    [onColour[1], offColour[1]],
    'column-sweep green [lit, unlit] must equal patternColor("column-sweep", ...)',
  );
  assert.deepEqual(
    [Number(tint[1]), Number(tint[2])],
    [onColour[2], offColour[2]],
    'column-sweep blue [lit, unlit] must equal patternColor("column-sweep", ...)',
  );
});

test('walk lights stepIndex % NUM_LED white and blacks the rest', () => {
  const block = CASES['walk'];
  has('stepIndex % NUM_LED', 'the walk LED index expression (stepIndex % NUM_LED)');
  assert.ok(
    block.includes('stepIndex % NUM_LED'),
    'firmware walk must light exactly the LED at stepIndex % NUM_LED',
  );

  const lit = patternColor('walk', 0, 0);
  const off = patternColor('walk', 0, 1);
  const bg = block.match(/selftestFillAll\((\d+),\s*(\d+),\s*(\d+)\)/);
  assert.ok(bg, 'firmware walk must clear the wall before lighting one LED');
  assert.deepEqual(
    [Number(bg[1]), Number(bg[2]), Number(bg[3])],
    off,
    'the walk background triple must equal patternColor("walk", i, step) for an unlit LED',
  );

  const rgb = ['0', '1', '2'].map((slot) => {
    const m = block.match(new RegExp(`lastFrame\\[i \\* 3 \\+ ${slot}\\] = (\\d+);`));
    assert.ok(m, `firmware walk must write channel ${slot} of the lit LED`);
    return Number(m[1]);
  });
  assert.deepEqual(rgb, lit, 'the walk lit triple must equal patternColor("walk", step, step)');
});

test('index-map encodes the physical index with the same base, step and group', () => {
  const block = CASES['index-map'];
  const red = block.match(/lastFrame\[i \* 3 \+ 0\] = \(uint8_t\)\((\d+) \+ (\d+) \* \(i \/ (\d+)u\)\);/);
  const green = block.match(/lastFrame\[i \* 3 \+ 1\] = \(uint8_t\)\((\d+) \+ (\d+) \* \(i % (\d+)u\)\);/);
  const blue = block.match(/lastFrame\[i \* 3 \+ 2\] = (\d+);/);
  assert.ok(red && green && blue, 'firmware index-map must write R = base + step*(i/group), G = base + step*(i%group), B = blue');
  const first = patternColor('index-map', 0);
  const sameGroup = patternColor('index-map', 1);
  const lastInGroup = patternColor('index-map', INDEX_MAP_GROUP - 1);
  const nextGroup = patternColor('index-map', INDEX_MAP_GROUP);

  assert.equal(Number(red[1]), first[0], 'index-map red base must equal patternColor("index-map", 0)[0]');
  assert.equal(
    Number(red[2]),
    nextGroup[0] - first[0],
    'index-map red step must equal the JS step across one group boundary',
  );
  assert.equal(Number(red[3]), INDEX_MAP_GROUP, 'index-map red divisor must equal INDEX_MAP_GROUP');
  assert.equal(first[0], sameGroup[0], 'sanity: red is constant within a group, so it encodes the group');

  assert.equal(Number(green[1]), first[1], 'index-map green base must equal patternColor("index-map", 0)[1]');
  assert.equal(
    Number(green[2]),
    sameGroup[1] - first[1],
    'index-map green step must equal the JS step across one position within a group',
  );
  assert.equal(Number(green[3]), INDEX_MAP_GROUP, 'index-map green modulus must equal INDEX_MAP_GROUP');
  assert.equal(
    Number(green[1]) + Number(green[2]) * (INDEX_MAP_GROUP - 1),
    lastInGroup[1],
    'the firmware ramp must end where the JS ramp ends inside a group',
  );

  assert.equal(Number(blue[1]), first[2], 'index-map blue constant must equal patternColor("index-map", i)[2]');
});

/**
 * The arithmetic above is extracted from the firmware's own expressions. This
 * pins those expressions verbatim as well, so renaming a variable or changing a
 * divisor is reported as "the expression is gone", not as a mystery number.
 */
test('the firmware writes exactly the expressions core/calibration.js models', () => {
  has('20 + 12 * (i / 20u)', 'index-map red expression');
  has('20 + 12 * (i % 20u)', 'index-map green expression');
  has('lastFrame[i * 3 + 2] = 30;', 'index-map blue literal');
  has('(uint8_t)(i % 20u) == col', 'column-sweep lit-column expression');
  has('const uint8_t col = (uint8_t)(stepIndex % 20u);', 'column-sweep column counter');
  has('stepIndex % NUM_LED', 'walk lit-LED expression');
  has('selftestFillAll(255, 0, 0)', 'all-red triple');
  has('on ? 255 : 0', 'column-sweep lit green');
  has('on ? 40 : 0', 'column-sweep lit blue tint');
  // INDEX_MAP_GROUP is the 20 in every one of those divisors.
  assert.equal(INDEX_MAP_GROUP, 20, 'the firmware hard-codes 20u; INDEX_MAP_GROUP must be the same 20');
});

// -------------------------------------------------------------------------
// JS-side consistency: the prediction is self-consistent
// -------------------------------------------------------------------------

test('index-map gives all 400 LEDs a distinct colour, in range 20..254', () => {
  const seen = new Set();
  let min = 255;
  let max = 0;
  for (let i = 0; i < LED_COUNT; i++) {
    const [r, g, b] = patternColor('index-map', i);
    for (const c of [r, g, b]) {
      assert.ok(c >= 20 && c <= 254, `index-map channel ${c} at index ${i} is outside 20..254`);
      min = Math.min(min, c);
      max = Math.max(max, c);
    }
    seen.add(`${r},${g},${b}`);
  }
  assert.equal(seen.size, LED_COUNT, 'index-map must identify every LED: 400 indices, 400 distinct colours');
  assert.equal(min, 20, 'the legend says the lowest channel value is 20');
  assert.equal(max, 20 + 12 * (INDEX_MAP_GROUP - 1), 'the legend says the highest channel value is 20 + 12*(group-1)');
});

test('calibrationPhysicalBytes("all-red") is 1200 bytes of full red', () => {
  const bytes = calibrationPhysicalBytes('all-red');
  assert.equal(bytes.length, LED_COUNT * 3, 'the physical payload is 3 bytes per LED');
  for (let i = 0; i < bytes.length; i += 3) {
    assert.equal(bytes[i], 255, `LED ${i / 3} red`);
    assert.equal(bytes[i + 1], 0, `LED ${i / 3} green`);
    assert.equal(bytes[i + 2], 0, `LED ${i / 3} blue`);
  }
});

test('patternPace durations and steps come straight from CALIBRATION_TIMING', () => {
  assert.deepEqual(patternPace('all-red'), { durationMs: CALIBRATION_TIMING.redMs, stepMs: 0 });
  assert.deepEqual(patternPace('column-sweep'), {
    durationMs: CALIBRATION_TIMING.columnMs,
    stepMs: CALIBRATION_TIMING.columnStepMs,
  });
  assert.deepEqual(patternPace('walk'), {
    durationMs: CALIBRATION_TIMING.walkMs,
    stepMs: CALIBRATION_TIMING.walkStepMs,
  });
  assert.deepEqual(patternPace('index-map'), { durationMs: CALIBRATION_TIMING.indexMs, stepMs: 0 });
});

test('patternColor rejects an unknown name, a bad index, and a bad step', () => {
  assert.throws(() => patternColor('spiral', 0), /unknown calibration pattern "spiral"/);
  assert.throws(() => patternColor('all-red', -1), /out of range/);
  assert.throws(() => patternColor('all-red', LED_COUNT), /out of range/);
  assert.throws(() => patternColor('all-red', 1.5), /out of range/);
  assert.throws(() => patternColor('walk', 0, -1), /non-negative integer/);
  assert.throws(() => patternColor('walk', 0, 0.5), /non-negative integer/);
});

// -------------------------------------------------------------------------
// calibrationPattern is layout-relative
//
// This is what makes milestone 5 work: the pattern is defined in PHYSICAL
// index space (that is what the firmware writes), and calibrationPattern paints
// it onto logical cells through the layout. So a wiring assumption shows up as
// a recognisable distortion of the pattern, not as a different pattern.
// -------------------------------------------------------------------------

test('index-map on the identity layout colours cell (x,y) as row y, column x', () => {
  const layout = identity();
  const panel = calibrationPattern('index-map', new Panel(layout.cols, layout.rows), layout, 0);
  for (const [x, y] of [[0, 0], [19, 0], [0, 19], [3, 4], [19, 19]]) {
    assert.equal(layout.index(x, y), y * INDEX_MAP_GROUP + x, `identity() must map (${x},${y}) to that physical index`);
    assert.deepEqual(
      panel.getPixel(x, y),
      [20 + 12 * y, 20 + 12 * x, 30],
      `identity index-map cell (${x},${y}) must be R=20+12*y, G=20+12*x, B=30`,
    );
  }
});

/**
 * The calibrated default is the interesting case: strips are columns running
 * top->bottom, so the G ramp runs down each column and the R ramp steps across
 * the columns. Reading R off the wall tells you which column you are on;
 * reading G tells you how far down it.
 */
test('index-map on the calibrated column layout ramps down each column', () => {
  const layout = new Layout();
  const panel = calibrationPattern('index-map', new Panel(layout.cols, layout.rows), layout, 0);

  assert.equal(layout.index(19, 1), 381, 'the calibrated layout puts (19,1) at physical 381');
  assert.deepEqual(panel.getPixel(19, 1), [20 + 12 * 19, 20 + 12 * 1, 30], 'cell (19,1) holds physical 381');

  assert.equal(layout.index(0, 1), 1, 'column 0 runs top->bottom, so (0,1) is physical 1');
  assert.deepEqual(panel.getPixel(0, 1), [20 + 12 * 0, 20 + 12 * 1, 30], 'cell (0,1) holds physical 1');
});

/**
 * The bridge/firmware equality: painting a pattern through a layout and packing
 * through the SAME layout reproduces the flat bytes the firmware writes — and it
 * does so whatever wiring guess that layout is. That layout-independence is what
 * lets tools/bridge.js offer `--pattern` without knowing the wall: the bytes it
 * sends are the calibration pattern, full stop.
 */
test('packing a calibration pattern through its own layout reproduces the firmware bytes', () => {
  const layouts = [
    ['default', new Layout()],
    ['identity', identity()],
    ['flipX+transpose', new Layout({ flipX: true, transpose: true })],
  ];
  for (const step of [0, 7, 42]) {
    for (const name of CALIBRATION_PATTERNS) {
      const expected = calibrationPhysicalBytes(name, step);
      for (const [label, layout] of layouts) {
        const panel = new Panel(layout.cols, layout.rows);
        assert.deepEqual(
          pack(calibrationPattern(name, panel, layout, step), layout),
          expected,
          `pack(calibrationPattern(${name}, ${label}), ${label}) at step ${step} must equal calibrationPhysicalBytes(${name}, ${step})`,
        );
      }
    }
  }
});

/** The sentence the bridge depends on: the pattern bytes do not depend on the layout. */
test('every layout produces the same calibration bytes once packed with itself', () => {
  const layouts = [
    ['default', new Layout()],
    ['identity', identity()],
    ['flipX+transpose', new Layout({ flipX: true, transpose: true })],
    ['snake-off flipY', new Layout({ snake: false, flipY: true })],
  ];
  for (const name of CALIBRATION_PATTERNS) {
    for (const step of [0, 13]) {
      const reference = pack(
        calibrationPattern(name, new Panel(20, 20), layouts[0][1], step),
        layouts[0][1],
      );
      for (const [label, layout] of layouts.slice(1)) {
        assert.deepEqual(
          pack(calibrationPattern(name, new Panel(layout.cols, layout.rows), layout, step), layout),
          reference,
          `${name} at step ${step} packed through ${label} must equal the same bytes as through ${layouts[0][0]}`,
        );
      }
      assert.deepEqual(
        reference,
        calibrationPhysicalBytes(name, step),
        `${name} at step ${step} must equal calibrationPhysicalBytes regardless of layout`,
      );
    }
  }
});

test('walk lights exactly the cell holding physical 42', () => {
  for (const layout of [new Layout(), identity(), new Layout({ flipX: true, transpose: true })]) {
    const panel = calibrationPattern('walk', new Panel(layout.cols, layout.rows), layout, 42);
    const lit = [];
    for (let cell = 0; cell < layout.count; cell++) {
      const [r, g, b] = [panel.pixels[cell * 3], panel.pixels[cell * 3 + 1], panel.pixels[cell * 3 + 2]];
      if (r || g || b) lit.push(cell);
      else assert.deepEqual([r, g, b], [0, 0, 0], `cell ${cell} must be black`);
    }
    assert.deepEqual(lit, [layout.inverse[42]], 'exactly one cell lights: the one whose physical index is 42');
    assert.deepEqual(panel.getPixel(...layout.cellOf(42)), [255, 255, 255], 'the lit cell is white');
  }
});

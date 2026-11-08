/**
 * bake.test.js — tools/bake.js, from the outside.
 *
 * Two properties are worth a suite of their own, and neither is about the
 * argument parser:
 *
 *   1. a baked show is DETERMINISTIC. Bake the same gallery twice and the bytes
 *      are identical. That is what makes the crc meaningful, what makes a bake
 *      reviewable in a diff, and what lets a wall's file be compared against a
 *      fresh bake to answer "is this stale?".
 *
 *   2. the two host-side transforms are ACTUALLY in the file. A bake that
 *      quietly ignored --layout or --gamma would produce a valid, playing,
 *      wrong gallery — the failure mode this whole feature is most exposed to,
 *      because everything about it looks fine until a person looks at the wall.
 *
 * The CLI is run as a subprocess rather than through imports on purpose: bake.js
 * pulls in tools/bridge.js for the serial transport, and a test should not have
 * to hold a serialport-capable module graph open to check whether a file was
 * written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseShow } from '../core/showfile.js';

const BAKE = fileURLToPath(new URL('../tools/bake.js', import.meta.url));

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BAKE, ...args], { encoding: 'utf8', ...opts });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** A scratch directory per test: bake writes, and a shared one would collide. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ledwall-bake-'));
  return {
    dir,
    path: (name) => join(dir, name),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Two drawings that are nothing like each other, in the store's own wire form. */
function storeWith(dir, colours) {
  const list = colours.map((c, i) => {
    const cells = [];
    for (let p = 0; p < 400; p++) cells.push(...c, 255);
    return {
      id: `d${i}`,
      name: `drawing ${i + 1}`,
      pixels: Buffer.from(cells).toString('hex'),
      createdAt: 1_700_000_000_000 + i,
      seq: i + 1,
    };
  });
  const file = join(dir, 'drawings.json');
  writeFileSync(file, JSON.stringify(list));
  return file;
}

const solidArgs = (n, out) => [
  ...Array.from({ length: n }, (_, i) => ['--solid', ['#ff0000', '#00ff00', '#0000ff'][i % 3]]).flat(),
  '--out', out,
];

// ---------------------------------------------------------------------------

test('a bake writes a show the firmware would accept, and --info reads it back', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    const baked = run(solidArgs(3, out));
    assert.equal(baked.code, 0, baked.out);

    const show = parseShow(new Uint8Array(readFileSync(out)));
    assert.notEqual(show, null, 'the file parses as a show');
    assert.equal(show.header.count, 3);
    assert.equal(show.header.intervalSec, 8);
    assert.equal(show.header.gapSec, 5);
    assert.equal(show.header.transition, 'fade');

    const info = run(['--info', out]);
    assert.equal(info.code, 0, info.out);
    assert.match(info.out, /3 drawings, 8s \+ 5s break, fade 1000ms/);
  } finally {
    s.done();
  }
});

test('the same gallery bakes to the same bytes, twice', () => {
  const s = scratch();
  try {
    const a = s.path('a.led');
    const b = s.path('b.led');
    assert.equal(run(solidArgs(3, a)).code, 0);
    assert.equal(run(solidArgs(3, b)).code, 0);
    assert.deepEqual([...readFileSync(a)], [...readFileSync(b)]);
  } finally {
    s.done();
  }
});

test('a bake of the wall\'s own store reproduces the gallery, in admission order', () => {
  const s = scratch();
  try {
    const store = storeWith(s.dir, [[255, 0, 0], [0, 255, 0]]);
    const out = s.path('show.led');
    const res = run(['--store', store, '--out', out]);
    assert.equal(res.code, 0, res.out);

    const show = parseShow(new Uint8Array(readFileSync(out)));
    assert.equal(show.header.count, 2);
    // Every cell of frame 0 is red and every cell of frame 1 is green: the two
    // frames are the drawings, not the drawings blended with anything.
    assert.deepEqual([...new Set(show.frames[0].filter((_, i) => i % 3 === 0))], [255]);
    assert.deepEqual([...new Set(show.frames[0].filter((_, i) => i % 3 === 1))], [0]);
    assert.deepEqual([...new Set(show.frames[1].filter((_, i) => i % 3 === 1))], [255]);
  } finally {
    s.done();
  }
});

test('--reverse bakes the newest first, and changes nothing else', () => {
  const s = scratch();
  try {
    const store = storeWith(s.dir, [[255, 0, 0], [0, 0, 255]]);
    const fwd = s.path('fwd.led');
    const rev = s.path('rev.led');
    assert.equal(run(['--store', store, '--out', fwd]).code, 0);
    assert.equal(run(['--store', store, '--out', rev, '--reverse']).code, 0);
    const a = parseShow(new Uint8Array(readFileSync(fwd)));
    const b = parseShow(new Uint8Array(readFileSync(rev)));
    assert.deepEqual([...a.frames[0]], [...b.frames[1]]);
    assert.deepEqual([...a.frames[1]], [...b.frames[0]]);
    assert.equal(a.header.fingerprint, b.header.fingerprint, 'the cadence did not change');
  } finally {
    s.done();
  }
});

test('the LED fine-tune is IN the pixels, and moves the fingerprint', () => {
  const s = scratch();
  try {
    const plain = s.path('plain.led');
    const tuned = s.path('tuned.led');
    // A MID-tone, not a primary: gamma and black level are identities at 0 and
    // 255, so a pure red would pass through untouched and the test would pass for
    // the wrong reason.
    assert.equal(run(['--solid', '#7f7f7f', '--out', plain]).code, 0);
    const res = run(['--solid', '#7f7f7f', '--out', tuned, '--gamma', '2', '--black-level', '8']);
    assert.equal(res.code, 0, res.out);

    const a = parseShow(new Uint8Array(readFileSync(plain)));
    const b = parseShow(new Uint8Array(readFileSync(tuned)));
    assert.notDeepEqual([...a.frames[0]], [...b.frames[0]], 'gamma reached the bytes');
    assert.notEqual(a.header.fingerprint, b.header.fingerprint);
    assert.equal(a.header.tuned, false);
    assert.equal(b.header.tuned, true);
  } finally {
    s.done();
  }
});

test('the layout is IN the pixels too, which is the one that scrambles a picture', () => {
  const s = scratch();
  try {
    const flat = s.path('flat.led');
    const snake = s.path('snake.led');
    // Index-map-shaped content: a solid colour would be blind to a permutation,
    // so bake something whose every cell differs. A gradient drawing does that.
    const cells = [];
    for (let p = 0; p < 400; p++) {
      cells.push(p % 256, (p * 7) % 256, 40, 255);
    }
    const store = join(s.dir, 'gradient.json');
    writeFileSync(store, JSON.stringify([
      { id: 'g', name: 'gradient', pixels: Buffer.from(cells).toString('hex'), createdAt: 1, seq: 1 },
    ]));

    assert.equal(run(['--store', store, '--out', flat]).code, 0);
    assert.equal(run(['--store', store, '--out', snake, '--layout', 'snake']).code, 0);
    const a = parseShow(new Uint8Array(readFileSync(flat)));
    const b = parseShow(new Uint8Array(readFileSync(snake)));
    assert.notDeepEqual([...a.frames[0]], [...b.frames[0]], 'the wire order changed');
    assert.notEqual(a.header.fingerprint, b.header.fingerprint);
  } finally {
    s.done();
  }
});

test('the worst frame current is baked in, because the device cannot estimate it', () => {
  const s = scratch();
  try {
    const white = s.path('white.led');
    const dim = s.path('dim.led');
    assert.equal(run(['--solid', '#ffffff', '--out', white]).code, 0);
    assert.equal(run(['--solid', '#ffffff', '--out', dim, '--brightness', '128']).code, 0);
    // 400 LEDs * 3 channels * 20 mA = 24 A at full white, which is exactly the
    // figure core/power.js warns about; half brightness is half the current.
    assert.equal(parseShow(new Uint8Array(readFileSync(white))).header.worstMa, 24000);
    assert.equal(parseShow(new Uint8Array(readFileSync(dim))).header.worstMa, 12047);
  } finally {
    s.done();
  }
});

test('--verify walks every slot and passes a good show', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    assert.equal(run(solidArgs(3, out)).code, 0);
    const res = run(['--verify', out]);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /period 13000 ms, blend 1000 ms, 3 slots/);
    assert.match(res.out, /ok: every slot resolves to its own drawing/);
  } finally {
    s.done();
  }
});

test('a corrupted show is refused by --info with a nonzero exit', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    assert.equal(run(solidArgs(2, out)).code, 0);
    const bytes = readFileSync(out);
    bytes[bytes.length - 8] ^= 0xff;           // one flipped bit in the last frame
    writeFileSync(out, bytes);
    const res = run(['--info', out]);
    assert.equal(res.code, 1);
    assert.match(res.out, /not a show this firmware can play/);
  } finally {
    s.done();
  }
});

test('the baker refuses what the device cannot play, loudly', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    const wipe = run(['--solid', '#ff0000', '--out', out, '--transition', 'wipe']);
    assert.equal(wipe.code, 1);
    assert.match(wipe.out, /cannot be baked/);

    const zero = run(['--solid', '#ff0000', '--out', out, '--interval', '0']);
    assert.equal(zero.code, 1);
    assert.match(zero.out, /intervalSec/);

    const empty = run(['--store', s.path('nope.json'), '--out', out]);
    assert.equal(empty.code, 1);
  } finally {
    s.done();
  }
});

test('--dry-run describes a bake and writes nothing', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    const res = run(['--solid', '#ff8800', '--out', out, '--dry-run']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /baked 1 drawing\(s\)/);
    assert.throws(() => readFileSync(out), /ENOENT/);
  } finally {
    s.done();
  }
});

test('--json is machine-readable and matches what landed in the file', () => {
  const s = scratch();
  try {
    const out = s.path('show.led');
    const res = run(['--store', storeWith(s.dir, [[1, 2, 3]]), '--out', out, '--json']);
    assert.equal(res.code, 0, res.out);
    const summary = JSON.parse(res.out);
    const show = parseShow(new Uint8Array(readFileSync(out)));
    assert.equal(summary.bytes, show.header.fileBytes);
    assert.equal(summary.header.count, show.header.count);
    assert.equal(summary.fingerprint, show.header.fingerprint);
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------
// The pin to the firmware that receives the upload
// ---------------------------------------------------------------------------

test('the upload framing matches the firmware that receives it', async () => {
  // This is the one part of the feature no test here can exercise for real: it
  // needs a board. So the RECORD LAYOUT is pinned as text instead, on both
  // sides, the way test/calibration.test.js pins the self-test — a byte order
  // that drifts between the two files is a wall that refuses every upload with a
  // crc mismatch, and nothing else in this suite would say why.
  const { readFileSync } = await import('node:fs');
  const firmware = readFileSync(new URL('../firmware/firmware.ino', import.meta.url), 'utf8');
  const baker = readFileSync(new URL('../tools/bake.js', import.meta.url), 'utf8');

  // The three magics, on both sides.
  assert.match(firmware, /SHOW_CHUNK_MAGIC\s*=\s*0xA3/);
  assert.match(firmware, /SHOW_COMMIT_MAGIC\s*=\s*0xA2/);
  assert.match(firmware, /SHOW_RECORD_END\s*=\s*0x5B/);
  assert.match(baker, /CHUNK_MAGIC = 0xa3/);
  assert.match(baker, /COMMIT_MAGIC = 0xa2/);
  assert.match(baker, /RECORD_END = 0x5b/);

  // The chunk body is seq u8, offset u32, len u16 — in that order, at those
  // offsets, on both sides. The firmware decodes it by hand, so the offsets are
  // the contract and there is no struct to keep them honest.
  assert.match(firmware, /SHOW_CHUNK_HEAD\s*=\s*7\b/);
  assert.match(firmware, /le32\(upHead \+ 1\)/);
  assert.match(firmware, /le16\(upHead \+ 5\)/);
  assert.match(baker, /record\.set\(le32\(offset\), 2\)/);
  assert.match(baker, /record\.set\(le16\(len\), 6\)/);

  // The commit body is size u32 then crc u32.
  assert.match(firmware, /SHOW_COMMIT_BODY\s*=\s*8\b/);
  assert.match(firmware, /upCommit\(le32\(upCommitBuf\), le32\(upCommitBuf \+ 4\)\)/);
  assert.match(baker, /commit\.set\(le32\(file\.length\), 1\)/);
  assert.match(baker, /commit\.set\(le32\(crc32\(file\)\), 5\)/);

  // The per-chunk ack is the upload's FLOW CONTROL, not a progress bar: the wall
  // prints it after the flash write and the baker waits for that exact string
  // before sending the next chunk, because an unpaced upload overruns the
  // device's ring buffer while LittleFS is writing. Two files, one string.
  assert.match(firmware, /F\("upload: chunk "\)/);
  assert.match(baker, /`upload: chunk \$\{offset\}`/);

  // And a chunk must fit the device's buffer: the baker must not be able to send
  // a payload the receiver would refuse as too long.
  const max = Number(/SHOW_CHUNK_MAX\s+(\d+)/.exec(firmware)?.[1]);
  const chunk = Number(/UPLOAD_CHUNK = (\d+)/.exec(baker)?.[1]);
  assert.ok(Number.isInteger(max) && Number.isInteger(chunk), 'both limits are literals');
  assert.ok(chunk <= max, `the baker sends ${chunk}-byte chunks into a ${max}-byte buffer`);
});

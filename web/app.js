/**
 * app.js — the browser brain.
 *
 * One Panel, one frame loop. The loop rasterises the banner, clamps it against
 * the power budget, packs it through the layout, and hands finished frames to
 * whichever sink is selected. The sim and the wall consume the SAME bytes, so
 * what you see here is what the ESP32 will get — nothing here is throwaway.
 *
 * core/ is imported unmodified from /core/*.js (see tools/serve.js): the browser
 * runs the identical modules the Node tests run.
 */

import {
  Panel,
  Layout,
  LAYOUT_DEFAULTS,
  identity,
  layoutVariants,
  packInto,
  Scroller,
  Panner,
  PowerBudget,
  PeakMeter,
  encodeFrameInto,
  meta,
  nextSeq,
  FrameDecoder,
  physicalIndexPattern,
  FRAME_BYTES,
  RGB_BYTES,
} from '../core/index.js';

import { Sim } from './sim.js';
import { Banner } from './banner.js';
import { PageSource } from './page.js';
import { openSink, SINK_KINDS, CHANNEL } from './sinks.js';

const $ = (id) => document.getElementById(id);

const canvas = $('sim');
const sim = new Sim(canvas);
const panel = new Panel();

/** Scratch buffers allocated once: 30 fps x 1200 bytes is not something to GC. */
const packed = new Uint8Array(RGB_BYTES);
const wire = new Uint8Array(FRAME_BYTES);

let layout = new Layout();
let wallLayout = identity();
let variantList = [...layoutVariants()];
let variantIndex = 0;

const budget = new PowerBudget(8000, { headroom: 0.1 });
const peak = new PeakMeter(30);

const banner = new Banner({ url: $('bannerUrl').value, intervalMs: Number($('pollMs').value), capRows: Number($('capRows').value) });
banner.start();

const page = new PageSource({
  url: $('pageUrl').value,
  intervalMs: Number($('pagePoll').value),
  width: Number($('pageW').value),
  height: Number($('pageH').value),
  waitMs: Number($('pageWait').value),
});

/**
 * Which feed drives the wall. 'text' scrolls a banner sideways; 'page' pans a
 * live web page through the grid. Exactly one is polling at a time so a hidden
 * feed costs no requests and no rasterising.
 */
let sourceMode = 'text';
/** The active renderer: a Scroller or a Panner. Both expose tick(panel). */
let renderer = null;
let sink = null;
let seq = 0;
let wallView = false;
let indexPattern = false;
let fps = 0;
let lastTick = performance.now();
let sent = 0;
let dropped = 0;

// ---------------------------------------------------------------------------
// Layout controls
// ---------------------------------------------------------------------------

function readLayoutFlags() {
  return {
    snake: $('snake').checked,
    flipX: $('flipX').checked,
    flipY: $('flipY').checked,
    transpose: $('transpose').checked,
    stripLength: Number($('stripLength').value),
    stripAxis: $('stripAxis').value,
  };
}

function applyLayout() {
  const flags = readLayoutFlags();
  try {
    layout = new Layout({ ...LAYOUT_DEFAULTS, ...flags });
  } catch (err) {
    // stripLength not dividing 400, or transpose on a non-square grid: keep the
    // last good layout rather than taking the sim down.
    setOutput($('layoutOut'), `layout rejected: ${err.message}`, 'err');
    return;
  }
  setOutput($('layoutOut'), `${layout.describe()}\n${layout.preview()}`);
  syncWallOptions();
}

/**
 * The wall-view dropdown is the calibration answer list: identity plus the
 * eight mountings. Pick the one that matches the photo you took of the wall.
 */
function syncWallOptions() {
  const sel = $('wallLayout');
  if (sel.options.length === 0) {
    const options = [{ label: 'matches the sender (no wiring mistake)', layout: identity() }];
    for (const v of variantList) options.push({ label: v.describe(), layout: v });
    for (const o of options) {
      const el = document.createElement('option');
      el.textContent = o.label;
      el.dataset.key = options.indexOf(o);
      el._layout = o.layout;
      sel.append(el);
    }
  }
  const chosen = sel.selectedIndex;
  wallLayout = sel.options[chosen]?._layout ?? identity();
}

// ---------------------------------------------------------------------------
// Sources -> renderer
// ---------------------------------------------------------------------------

/** Banner text -> Scroller. Rebuilt whenever the copy or its metrics change. */
function buildScroller() {
  const source = banner.bitmap();
  renderer = new Scroller({
    panel,
    source,
    cellsPerFrame: Number($('speed').value),
    direction: Number($('direction').value),
    // Centre the text band vertically so a 14-row cap sits on the panel.
    y: Math.max(0, Math.floor((panel.rows - source.cellsH) / 2)),
    clear: true,
  });
  setOutput(
    $('bannerText'),
    `${banner.text}\n${source.cellsW.toFixed(1)} x ${source.cellsH.toFixed(1)} cells · pass ${(renderer.passDurationMs(30) / 1000).toFixed(1)}s`,
    banner.stale ? 'warn' : '',
  );
}

/**
 * The live-page readout. Rebuilt every frame, not only when a capture lands:
 * `pan` is a property of the renderer, and the renderer keeps panning across a
 * static page (identical capture hash means no rebuild), so a readout written
 * only by buildPanner() freezes at the position it had when the last capture
 * arrived while the wall carries on scrolling.
 */
function pageReadout() {
  const source = page.bitmap();
  if (source === null || !(renderer instanceof Panner)) {
    return page.stale ? `capture failed: ${page.error}` : 'capturing…';
  }
  const meta = page.meta;
  return `${source.w} x ${source.h} px · page ${meta.cssWidth} x ${meta.scrollHeight} css px\n` +
    `zoom ${renderer.rect.scale.toFixed(1)} px/cell · ${renderer.visible * 100 | 0}% of page on the wall\n` +
    `pan ${(renderer.progress * 100).toFixed(0)}% of ${renderer.span.toFixed(0)} cells · capture ${meta.ms} ms` +
    (page.stale ? `\nstale: ${page.error}` : '');
}

/**
 * Captured page -> Panner.
 *
 * The Panner is REBUILT only when the capture's size changes; a live page that
 * keeps its dimensions gets its `source` swapped in place, which preserves
 * `offset` — re-constructing on every 500 ms poll would snap the pan back to the
 * top of the page and the wall would never get past the first screenful.
 */
function buildPanner() {
  const source = page.bitmap();
  if (source === null) {
    renderer = null;
    setOutput(
      $('pageOut'),
      page.stale ? `capture failed: ${page.error}` : 'capturing…',
      page.stale ? 'err' : 'warn',
    );
    return;
  }

  const zoom = $('pageAutoZoom').checked ? null : Number($('pageZoom').value);
  if (
    renderer instanceof Panner &&
    renderer.source.w === source.w &&
    renderer.source.h === source.h &&
    renderer.pxPerCell === zoom &&
    renderer.axis === $('pageAxis').value
  ) {
    renderer.source = source;
  } else {
    renderer = new Panner({
      panel,
      source,
      axis: $('pageAxis').value,
      pxPerCell: zoom,
      cellsPerFrame: Number($('pageSpeed').value),
      direction: Number($('pageDirection').value),
      loop: true,
      clear: true,
    });
  }

  setOutput($('pageOut'), pageReadout(), page.stale ? 'warn' : 'ok');
}

/**
 * Switch feeds. Only the active one polls: a page capture is a Chromium
 * screenshot, so leaving it running while a banner is on screen would burn a
 * browser every 500 ms for pixels nobody sees.
 */
function setSourceMode(mode) {
  sourceMode = mode === 'page' ? 'page' : 'text';
  const isPage = sourceMode === 'page';

  $('bannerControls').hidden = isPage;
  $('pageControls').hidden = !isPage;

  if (isPage) {
    banner.stop();
    page.start();
    buildPanner();
  } else {
    page.stop();
    banner.start();
    buildScroller();
  }
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function tick() {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;

  if (indexPattern) {
    // Calibration pattern: every LED shows its own physical index as greyscale.
    physicalIndexPattern(panel, layout);
  } else {
    // A new source lands on a poll timer, not on this loop, so the frame loop
    // picks it up by identity: null renderer, or a source the renderer does not
    // have. When nothing changed that is one reference compare per frame.
    // Rebuilding on a real change is what makes an edited banner.txt or a fresh
    // page capture reach the wall; the marquee restarts because the copy it was
    // scrolling no longer exists.
    if (sourceMode === 'page') {
      if (renderer === null || renderer.source !== page.bitmap()) buildPanner();
    } else if (renderer === null || renderer.source !== banner.bitmap()) {
      buildScroller();
    }
    if (renderer) renderer.tick(panel);
    else panel.clear();
  }

  // Power clamp first: the multiplier is decided from the frame we just drew,
  // so a bright frame is dimmed before it ever reaches the wall.
  const k = budget.brightnessFor(panel, Number($('brightness').value));
  packInto(panel, layout, packed);
  if (k < 1) for (let i = 0; i < packed.length; i++) packed[i] = (packed[i] * k) | 0;

  const ma = budget.observe(packed);
  peak.push(packed);

  encodeFrameInto(wire, seq, packed);
  seq = nextSeq(seq);

  if (sink) {
    try {
      // Sinks report a refused frame as false rather than throwing, so the
      // counter follows what actually left the page, not what we attempted.
      if (sink.send(wire)) sent++;
      else dropped++;
    } catch (err) {
      dropped++;
      setOutput($('sinkOut'), `send failed: ${err.message}`, 'err');
    }
  }

  draw();
  report(k, ma);
}

function draw() {
  // Nothing displays a hidden tab, so the canvas work is pure waste there — but
  // the bytes above it still went out, which is the whole point of the split.
  if (document.hidden) return;
  // Both views draw the SAME clamped bytes; only the display layout differs.
  // Drawing the packed array at the sender's own layout reproduces the design
  // as authored (byte layout.index(x,y) lands on cell (x,y)), so the sim shows
  // exactly the brightness the wall receives instead of the unclamped panel.
  sim.drawWall(packed, wallView ? wallLayout : layout);
  sim.setOverlay($('overlay').checked);
}

function setOutput(el, text, cls = '') {
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'err');
  if (cls) el.classList.add(cls);
}

function report(k, ma) {
  setOutput(
    $('powerOut'),
    `k ${k.toFixed(3)}${k < 1 ? ' (clamped)' : ''}\n` +
    `frame ${ma.toFixed(0)} mA · peak ${peak.windowPeak.toFixed(0)} mA · mean ${peak.windowMean.toFixed(0)} mA\n` +
    `limit ${budget.effectiveLimitMa.toFixed(0)} mA · clamped frames ${budget.clampedFrames}`,
    k < 1 ? 'warn' : '',
  );
  setOutput(
    $('frameOut'),
    `${fps.toFixed(1)} fps · seq ${((seq - 1) & 255)} · ${FRAME_BYTES} B/frame\n` +
    `sent ${sent} · dropped ${dropped}${sink ? ` · sink ${sink.kind ?? 'sim'}` : ' · sink none'}`,
  );

  // The pan advances every frame even when the capture bytes do not change, so
  // the page readout is refreshed alongside the other live telemetry instead of
  // only when a new capture lands.
  if (sourceMode === 'page' && renderer instanceof Panner) {
    setOutput($('pageOut'), pageReadout(), page.stale ? 'warn' : 'ok');
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function connect() {
  const kind = $('sink').value;
  if (!SINK_KINDS.includes(kind)) return;
  try {
    sink = await openSink(kind, {
      baud: Number($('baud').value),
      channel: CHANNEL,
      onFrame: kind === 'broadcast' ? onIncoming : null,
    });
    // Tell the wall our brightness and current limit before the first frame,
    // so it never runs an unbudgeted frame while the host is still measuring.
    sink.send(meta(budget.toMeta()));
    setOutput($('sinkOut'), `connected: ${sink.kind}`, 'ok');
    $('connect').disabled = true;
    $('disconnect').disabled = false;
  } catch (err) {
    sink = null;
    setOutput($('sinkOut'), err.message, 'err');
    $('connect').disabled = false;
    $('disconnect').disabled = true;
  }
}

/** A tab receiving broadcast frames decodes them with the same core decoder. */
const incoming = new FrameDecoder();
function onIncoming(bytes) {
  const records = incoming.feed(bytes);
  if (records.length === 0) return;
  const last = records[records.length - 1];
  const what = last.rgb
    ? `frame seq ${last.seq}`
    : `meta k ${last.brightness} · ${last.limitMa} mA`;
  setOutput(
    $('rxOut'),
    `rx ${what}\n` +
    `decoded ${incoming.stats.frames} · gaps ${incoming.stats.gaps} · ` +
    `discarded ${incoming.stats.discarded} · rewinds ${incoming.stats.rewinds}`,
  );
}

async function disconnect() {
  // SerialSink.close() drains the writer; the others are synchronous.
  try {
    await sink?.close();
  } catch (err) {
    setOutput($('sinkOut'), `close: ${err.message}`, 'err');
  }
  sink = null;
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  setOutput($('sinkOut'), 'disconnected');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const id of ['snake', 'flipX', 'flipY', 'transpose', 'stripLength', 'stripAxis']) {
  $(id).addEventListener('change', applyLayout);
}
$('wallLayout').addEventListener('change', syncWallOptions);

$('cycleVariant').addEventListener('click', () => {
  // Walk the eight mountings and push the flags into the sender, so you can
  // watch the same banner render under each candidate wiring.
  const v = variantList[variantIndex++ % variantList.length];
  $('snake').checked = v.snake;
  $('flipX').checked = v.flipX;
  $('flipY').checked = v.flipY;
  $('transpose').checked = v.transpose;
  $('stripLength').value = v.stripLength;
  $('stripAxis').value = v.stripAxis;
  applyLayout();
});

$('indexPattern').addEventListener('click', () => {
  indexPattern = !indexPattern;
  $('indexPattern').textContent = indexPattern ? 'Back to banner' : 'Number every LED';
});

$('wallView').addEventListener('change', (e) => {
  wallView = e.target.checked;
  $('viewNote').textContent = wallView
    ? `rendering packed bytes at ${wallLayout.describe()}`
    : 'rendering the design as authored';
});
$('sourceMode').addEventListener('change', (e) => setSourceMode(e.target.value));

$('bannerUrl').addEventListener('change', () => {
  banner.url = $('bannerUrl').value;
  banner.refresh().then(buildScroller);
});
$('pollMs').addEventListener('change', () => {
  banner.intervalMs = Number($('pollMs').value);
  banner.stop();
  banner.start();
});
$('capRows').addEventListener('change', () => {
  banner.capRows = Number($('capRows').value);
  banner.refresh().then(buildScroller);
});
$('speed').addEventListener('input', () => {
  if (renderer instanceof Scroller) renderer.cellsPerFrame = Number($('speed').value);
});
$('direction').addEventListener('change', () => {
  if (renderer instanceof Scroller) renderer.direction = Number($('direction').value);
});

$('pageUrl').addEventListener('change', () => {
  page.url = $('pageUrl').value;
  // A different page is a different tab target: force a re-navigation rather
  // than re-shooting whatever the capture tab still has open.
  page.refresh(true).then(buildPanner);
});
for (const [id, key] of [['pagePoll', 'intervalMs'], ['pageW', 'width'], ['pageH', 'height'], ['pageWait', 'waitMs']]) {
  $(id).addEventListener('change', () => {
    page[key] = Number($(id).value);
    if (key === 'intervalMs') {
      page.stop();
      page.start();
    } else {
      // A new viewport size is a new capture geometry: re-shoot now so the pan
      // range matches the image the wall is showing.
      page.refresh(true).then(buildPanner);
    }
  });
}
$('pageAutoZoom').addEventListener('change', () => {
  $('pageZoom').disabled = $('pageAutoZoom').checked;
  buildPanner();
});
$('pageZoom').addEventListener('input', () => {
  if (!$('pageAutoZoom').checked) buildPanner();
});
$('pageAxis').addEventListener('change', buildPanner);
$('pageSpeed').addEventListener('input', () => {
  if (renderer instanceof Panner) renderer.cellsPerFrame = Number($('pageSpeed').value);
});
$('pageDirection').addEventListener('change', () => {
  if (renderer instanceof Panner) renderer.direction = Number($('pageDirection').value);
});
$('pageRestart').addEventListener('click', () => {
  if (renderer instanceof Panner) renderer.seek(0);
});
$('pageEnd').addEventListener('click', () => {
  if (renderer instanceof Panner) renderer.seek(1);
});


$('limitMa').addEventListener('change', () => {
  budget.limitMa = Number($('limitMa').value);
  budget.reset();
  sink?.send(meta(budget.toMeta()));
});
$('headroom').addEventListener('change', () => {
  budget.headroom = Number($('headroom').value);
});

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);

window.addEventListener('resize', () => sim.resize());

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

applyLayout();
syncWallOptions();
sim.resize();
$('pageZoom').disabled = $('pageAutoZoom').checked;

// Build the banner renderer immediately: Banner.bitmap() rasterises its
// fallback copy, so the wall shows something while the first fetch is in flight
// instead of sitting black until the poll lands.
buildScroller();
banner.refresh().catch((err) => setOutput($('bannerText'), `banner: ${err.message}`, 'err'));

/**
 * Fixed 30 fps on a timer, not requestAnimationFrame.
 *
 * The wall's frame rate is a property of the wire (921600 gives ~75 frames/s
 * theoretical), not of the display. rAF is also throttled to ~1 fps in a hidden
 * tab, which would starve the sink and let the firmware watchdog fade the panel
 * the moment this page stops being the front tab — the opposite of a wall driver.
 * A timer keeps the stream alive; only the canvas work is skipped while hidden.
 */
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
let next = performance.now();

function loop() {
  const now = performance.now();
  if (now - next >= -1) {
    // Never let the schedule drift behind the clock: a throttled or suspended
    // tab resumes at the current frame instead of replaying a backlog.
    next = Math.max(next + FRAME_MS, now - FRAME_MS);
    try {
      tick();
    } catch (err) {
      // The setTimeout below is the only thing keeping the stream alive, so a
      // throw escaping tick() would cost the wall every frame after it, not
      // just the broken one. Report which frame failed and keep going: a bad
      // layout or a source that changed mid-frame is a recoverable state, and
      // a wall that goes dark permanently is not.
      setOutput($('frameOut'), `frame failed: ${err.message}`, 'err');
    }
  }
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

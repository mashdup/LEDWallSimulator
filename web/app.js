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
  applyColor,
  Scroller,
  Panner,
  PowerBudget,
  PeakMeter,
  encodeFrameInto,
  meta,
  nextSeq,
  sameBytes,
  FrameDecoder,
  calibrationPattern,
  patternPace,
  CALIBRATION_PATTERNS,
  INDEX_MAP_LEGEND,
  FRAME_BYTES,
  RGB_BYTES,
  WALL_TIMING,
} from '../core/index.js';

import { Sim } from './sim.js';
import { Banner } from './banner.js';
import { PageSource } from './page.js';
import { openSink, SINK_KINDS, CHANNEL } from './sinks.js';
import { createClock } from './worker-clock.js';
import { startKeepAlive } from './keep-alive.js';
import { ANIM_NAMES, makeMessage } from '../core/content-protocol.js';
import { animFrame } from '../core/animations.js';

const $ = (id) => document.getElementById(id);

const canvas = $('sim');
const sim = new Sim(canvas);
const panel = new Panel();

/** Scratch buffers allocated once: 30 fps x 1200 bytes is not something to GC. */
const packed = new Uint8Array(RGB_BYTES);
// The scaled copy: what the wall will actually draw after it folds in the
// meta brightness, and therefore what the sim, the estimator and the peak
// meter must look at. The wire carries `packed` raw.
const rendered = new Uint8Array(RGB_BYTES);
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
  endpoint: $('pageEndpoint').value,
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
/**
 * The bytes the CURRENT sink was last given, or null for "this sink has had
 * nothing". Null rather than a zero-filled buffer because a still wall must
 * still be pushed once when a sink connects: without that, connecting to an
 * image that is not changing leaves the wall showing whatever it had.
 */
let lastSent = null;
/** The brightness the wall was last told via meta; meta is re-sent on change. */
let lastMetaBr = -1;
/** When the last frame went out, so the stale watchdog can be fed. */
let lastSentMs = 0;
let wallView = false;
/**
 * Which calibration pattern the sender is driving, or 'off' for the banner.
 * Same four patterns as the firmware self-test and the Node bridge, paced by
 * the same CALIBRATION_TIMING, so the sim's view and the wall's view are
 * directly comparable during the milestone-5 pass.
 */
let calibration = 'off';
let calStep = 0;
let calNextMs = 0;
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
  setOutput($('layoutOut'), layout.describe());
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
    // Default to the calibrated mounting - the first variant, carrying
    // LAYOUT_DEFAULTS (stripAxis 'y': strips are columns, top->bottom, not
    // serpentine) - not identity, which is the 'no wiring mistake' answer
    // for a sender wired row-major. The wall is wired column-major.
    sel.selectedIndex = 1;
  }
  wallLayout = sel.options[sel.selectedIndex]?._layout ?? identity();
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
 * The Panner is REBUILT only when the capture's size, zoom, or axis changes; a live
 * page that keeps its dimensions gets its `source` swapped in place, which preserves
 * `offset` — re-constructing on every poll would snap the pan back to the top of the
 * page and the wall would never get past the first screenful. tools/bridge.js's
 * pageSource had exactly that bug and test/bridge.test.js now pins both sides.
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
  sourceMode = mode === 'content' ? 'content' : mode === 'page' ? 'page' : 'text';
  const isPage = sourceMode === 'page' || sourceMode === 'content';

  $('bannerControls').hidden = isPage;
  $('pageControls').hidden = !isPage;

  if (sourceMode === 'content') applyContentPresets();
  if (sourceMode === 'page' && page.endpoint === '/content/frame') restoreCaptureDefaults();

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

/**
 * The 'content' feed is page mode with the push pipeline's correct
 * settings applied as a unit - the five fields that took manual tuning
 * (endpoint, refresh, auto-zoom, speed, URL) are one decision, and one
 * decision made wrong is a frozen or stuttering wall:
 *   - endpoint /content/frame: the app tab generates the frames (never
 *     throttled, holds the audio keep-alive); no capture, no photographer
 *   - refresh 34 ms: one poll per frame tick
 *   - auto-zoom on: the pushed frame is 20x20 - the wall's own resolution
 *   - speed 0: the frame IS the view; panning a 20x20 source is a shake
 *   - URL: this server's content page, for the state and as a mirror
 */
function applyContentPresets() {
  const url = `${location.origin}/content.html?wall=1`;
  $('pageUrl').value = url;
  page.url = url;
  $('pageEndpoint').value = '/content/frame';
  page.endpoint = '/content/frame';
  $('pagePoll').value = 34;
  page.intervalMs = 34;
  $('pageAutoZoom').checked = true;
  $('pageZoom').disabled = true;
  $('pageSpeed').value = 0;
  if (renderer instanceof Panner) renderer.cellsPerFrame = 0;
}

/**
 * The mirror of applyContentPresets: leaving the content feed for plain
 * page mode must restore the capture settings, or the push endpoint
 * silently answers every page-mode poll (it ignores the url parameter),
 * and the page capture looks completely dead. Presets that go in
 * pairs go out in pairs.
 */
function restoreCaptureDefaults() {
  $('pageEndpoint').value = '/capture';
  page.endpoint = '/capture';
  $('pagePoll').value = 150;
  page.intervalMs = 150;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function tick() {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
  if (calibration !== 'off') {
    // Same pacing as the firmware's self-test: the step index advances on a
    // wall clock, not on this loop's frame rate, so a 30 fps tab and a 240 MHz
    // ESP32 show the same pattern at the same moment.
    const pace = patternPace(calibration);
    if (pace.stepMs > 0 && now >= calNextMs) {
      calNextMs = now + pace.stepMs;
      calStep++;
    }
    calibrationPattern(calibration, panel, layout, calStep);
  } else {
    // A new source lands on a poll timer, not on this loop, so the frame loop
    // picks it up by identity: null renderer, or a source the renderer does not
    // have. When nothing changed that is one reference compare per frame.
    // Rebuilding on a real change is what makes an edited banner.txt or a fresh
    // page capture reach the wall; the marquee restarts because the copy it was
    // scrolling no longer exists.
    if (sourceMode === 'page' || sourceMode === 'content') {
      if (renderer === null || renderer.source !== page.bitmap()) buildPanner();
    } else if (renderer === null || renderer.source !== banner.bitmap()) {
      buildScroller();
    }
    if (renderer) renderer.tick(panel);
    else panel.clear();
  }

  // Colour before the power clamp: the estimator must see the bytes that actually
  // leave, and the sim draws these same packed bytes, so the preview stays honest.
  // Saturation pulls each pixel away from its own mean, which is what rescues a
  // pastel that the diffuser and a bright wall would otherwise wash to white.
  applyColor(panel.pixels, {
    saturation: Number($('saturation').value),
    gamma: Number($('gamma').value),
  });

  // Power clamp next: the multiplier is decided from the frame we just drew, so a
  // bright frame is dimmed before it ever reaches the wall.

  const k = budget.brightnessFor(panel, Number($('brightness').value));
  packInto(panel, layout, packed);
  // Brightness is applied ONCE, at the sink: the sketch folds the meta
  // brightness into renderWall(), and the DDP transport applies it to the
  // frames that follow. Scaling the wire bytes here as well made the wall
  // display k-squared — half the clamp, squared, and a visibly dim wall.
  // `rendered` is the scaled copy the estimator, the peak meter and the sim
  // see, which is what the wall will actually draw once the sink scales it.
  rendered.set(packed);
  if (k < 1) for (let i = 0; i < rendered.length; i++) rendered[i] = (rendered[i] * k) | 0;

  const ma = budget.observe(rendered);
  peak.push(rendered);

  // The clamp moves between scene changes (its peak-hold is monotonic), so
  // a meta re-send on change is rare — 5 bytes, and the wall's applied
  // brightness stops being whatever the first frame asked for.
  const br = Math.round(k * 255);
  if (br !== lastMetaBr) {
    lastMetaBr = br;
    sink?.send(meta({ brightness: br, limitMa: Math.round(budget.limitMa) }));
  }

  // A frame goes out when the bytes changed, or when the wall's stale-frame
  // watchdog is due a feed. The device fades to black after WALL_TIMING.staleMs of
  // silence, so a change-only rule would darken a still wall: a watchdog cannot
  // tell "nothing changed" from "the host died". A third of the window leaves 3x
  // margin, and the same rule and number that tools/bridge.js already uses keeps
  // the two drivers showing a static pattern identically.
  //
  // Continuing here also skips the encode and the seq advance, so a still wall
  // burns no sequence numbers and the decoder reports no phantom gaps.
  const changed = lastSent === null || !sameBytes(packed, lastSent);
  if (!changed && now - lastSentMs < WALL_TIMING.staticRefreshMs) {
    draw();
    report(k, ma);
    return;
  }
  if (lastSent === null) lastSent = new Uint8Array(RGB_BYTES);
  lastSent.set(packed);
  lastSentMs = now;

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
  // Both views draw the SAME scaled bytes; only the display layout differs.
  // Drawing the rendered array at the sender's own layout reproduces the design
  // as authored (byte layout.index(x,y) lands on cell (x,y)), so the sim shows
  // exactly the brightness the wall receives instead of the unclamped panel.
  sim.drawWall(rendered, wallView ? wallLayout : layout);
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
  if ((sourceMode === 'page' || sourceMode === 'content') && renderer instanceof Panner) {
    setOutput($('pageOut'), pageReadout(), page.stale ? 'warn' : 'ok');
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function connect() {
  const kind = $('sink').value;
  if (!SINK_KINDS.includes(kind)) return;
  // The click that connects the wall is also the gesture that lets a silent
  // audio stream start: Chrome throttles a hidden tab's timers AND its
  // workers to ~1 Hz, and the audio exemption is the only in-page escape.
  startKeepAlive();
  try {
    sink = await openSink(kind, {
      baud: Number($('baud').value),
      channel: CHANNEL,
      onFrame: kind === 'broadcast' ? onIncoming : null,
    });
    // Tell the wall our brightness and power budget before the first frame,
    // so it never runs an unbudgeted frame while the host is still measuring.
    const m = budget.toMeta();
    lastMetaBr = m.brightness;
    sink.send(meta(m));
    // A fresh sink has been given nothing, so the next tick must push even if the
    // image is not changing; otherwise connecting to a still wall shows nothing.
    lastSent = null;
    // Name what we connected to: a programmatic port picker can choose an
    // unrelated COM device, and 'connected: serial' over a dead wall is a
    // trap. The path and product name make a wrong choice visible.
    const info = sink.port?.getInfo?.();
    const whom = info
      ? `${info.path ?? 'port'}${info.usbProductName ? ` (${info.usbProductName})` : ''}`
      : '';
    setOutput($('sinkOut'), `connected: ${sink.kind}${whom ? ` - ${whom}` : ''}`, 'ok');
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

$('calibration').addEventListener('change', (e) => {
  calibration = e.target.value;
  // Restart the step clock with the pattern: a walk that resumes at step 137
  // would start mid-strip and read as a wiring fault that is not there.
  calStep = 0;
  calNextMs = performance.now();
  setOutput(
    $('calOut'),
    calibration === 'off'
      ? 'banner feed'
      : `${calibration}: the sim shows what ${layout.describe()} predicts the wall shows.\n` +
        (calibration === 'index-map' ? `legend — ${INDEX_MAP_LEGEND}` : 'compare against the wall, then pick the matching mounting below.'),
  );
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
$('pageEndpoint').addEventListener('change', () => {
  // '/capture' photographs any URL (60-90 ms per shot, ~10 fps ceiling);
  // '/content/frame' serves the content page's own pushed canvas (a few ms,
  // ~30 fps). The query string PageSource appends is ignored by the push
  // route, so no other setting changes between the two modes.
  page.endpoint = $('pageEndpoint').value;
  page.refresh(true).then(buildPanner);
});
for (const [id, key] of [['pagePoll', 'intervalMs'], ['pageW', 'width'], ['pageH', 'height'], ['pageWait', 'waitMs']]) {
  $(id).addEventListener('change', () => {
    page[key] = Number($(id).value);    if (key === 'intervalMs') {
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

// Chrome throttles hidden tabs (and their workers) to ~1 Hz; the audio
// exemption is the in-page escape, and any click grants it. Connect is the
// main gesture, but the frame loop needs the exemption even before a sink
// exists - so any first interaction on the page arms it, not just Connect.
addEventListener('pointerdown', () => startKeepAlive(), { once: true });

// Content frame generator: when page mode points at /content/frame, THIS
// tab generates the wall's frames. The alternative - a content tab pushing
// its own canvas - fails exactly when it matters: a hidden content tab is
// throttled to ~1 Hz (measured: 0.3 fps) and the wall freezes. The app tab
// holds the audio keep-alive from the Connect click, is never throttled,
// and is the driver anyway: it polls the content state, renders the pure
// animation library (core/animations.js) at the server's phase, and pushes
// a 20x20 JPEG the page source fetches a few ms later. The content tab
// becomes an optional mirror, and a hidden one costs nothing.
const cPanel = new Panel();
const cCanvas = document.createElement('canvas');
cCanvas.width = 20;
cCanvas.height = 20;
const cCtx = cCanvas.getContext('2d');
let cState = { kind: 'demo' };
let cRev = -1;
let cServerAt = Date.now();
let cLocalAt = performance.now();
let cScroller = null;
let cPassMs = 0;
let cPushing = false;

async function pollContent() {
  try {
    const r = await fetch('/content', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    cServerAt = j.at;
    cLocalAt = performance.now();
    if (j.rev !== cRev) {
      cRev = j.rev;
      cState = j.state;
      cScroller = null;
      if (j.state.kind === 'text') {
        const src = new Banner({ fallback: j.state.text, color: j.state.color ?? '#ffffff' });
        cScroller = new Scroller({
          panel: cPanel,
          source: src.bitmap(),
          cellsPerFrame: j.state.step ?? 1,
          direction: -1,
        });
        cPassMs = cScroller.passDurationMs(30);
      }
      // The control surface mirrors the server on the SAME poll that drives
      // the frames - no second fetch loop, no second clock.
      mirrorContent(j);
    }
  } catch {
    // Server unreachable: keep the last state; the wall holds its frame.
  }
}
setInterval(pollContent, 100);
pollContent();

function pushContentFrame() {
  if (page.endpoint !== '/content/frame' || cPushing) return;
  cPushing = true;
  const tSec = cServerAt / 1000 + (performance.now() - cLocalAt) / 1000;
  let bytes;
  if (cState.kind === 'text' && cScroller !== null) {
    cScroller.seek(((tSec * 1000) % cPassMs) / cPassMs);
    cScroller.render(cPanel);
    bytes = cPanel.pixels;
  } else {
    bytes = animFrame(cState, tSec);
  }
  const img = cCtx.createImageData(20, 20);
  for (let i = 0; i < 400; i++) {
    img.data[i * 4] = bytes[i * 3];
    img.data[i * 4 + 1] = bytes[i * 3 + 1];
    img.data[i * 4 + 2] = bytes[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  cCtx.putImageData(img, 0, 0);
  cCanvas.toBlob((blob) => {
    if (blob === null) {
      cPushing = false;
      return;
    }
    fetch('/content/frame', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: blob,
    }).catch(() => {}).then(() => { cPushing = false; });
    // PNG, deliberately: JPEG's 8x8 blocks are 40% of a 20x20 frame each,
    // so its artifacts land directly on LED cells (an orange square gains
    // red/green ringing). At 400x400 PNG encoding was the bottleneck and
    // JPEG won; at 20x20 PNG encodes in ~1 ms and is lossless - pixel art
    // demands exact colors, and this is nothing but pixel art.
  }, 'image/png');
}

// Content controls: the server is the single source of truth for content
// state. The wall's pipeline spans disconnected browser worlds - this app
// window, content tabs, control pages, the capture browser - which share no
// tabs and no BroadcastChannel; only GET/POST /content reaches all of them.
// Commands are validated by makeMessage here and parseMessage at the server,
// and the status line mirrors the server's state: the ack IS the state.
async function sendContent(m, label) {
  try {
    const r = await fetch('/content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(m),
      cache: 'no-store',
    });
    setOutput($('contentOut'), r.ok ? `sent: ${label}` : `send FAILED: HTTP ${r.status}`, r.ok ? 'ok' : 'err');
  } catch (err) {
    // file:// has no server to POST to; the served app always does.
    setOutput($('contentOut'), err.message, 'err');
  }
}

$('contentSend').addEventListener('click', () => {
  const text = $('contentText').value.trim();
  if (text === '') return;
  sendContent(makeMessage('text', {text, color: $('contentColor').value}), `text ${text.slice(0, 24)}`);
});
$('contentText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('contentSend').click();
});
$('contentFill').addEventListener('click', () => {
  sendContent(makeMessage('fill', {color: $('contentColor').value}), 'fill');
});
$('contentClear').addEventListener('click', () => {
  sendContent(makeMessage('clear'), 'clear');
});

// Animation gallery: one button per library animation. Animations are pure
// functions of the server clock, so every renderer computes the identical
// frame at the same second; the button only changes server state.
for (const name of ANIM_NAMES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.dataset.anim = name;
  b.addEventListener('click', () => sendContent(makeMessage('anim', {name}), `anim ${name}`));
  $('contentAnims').append(b);
}

// Mirror the server's current state into the status line and light the
// matching animation button, so the panel shows what the wall shows.
function mirrorContent(j) {
  const s = j.state;
  const what = s.kind === 'text' ? `text: ${String(s.text).slice(0, 32)}`
    : s.kind === 'anim' ? s.name
    : s.kind;
  setOutput($('contentOut'), `server rev ${j.rev} - showing: ${what}`);
  for (const b of $('contentAnims').children) {
    b.classList.toggle('on', s.kind === 'anim' && b.dataset.anim === s.name);
  }
}


$('limitMa').addEventListener('change', () => {
  budget.limitMa = Number($('limitMa').value);
  budget.reset();
  const m = budget.toMeta();
  lastMetaBr = m.brightness;
  sink?.send(meta(m));
});
$('headroom').addEventListener('change', () => {
  budget.headroom = Number($('headroom').value);
  // Same contract as the limit slider: the adaptive ceiling is a one-way
  // ratchet by design (only a reset brightens the wall back), so widening
  // the margin MUST reset it — raising headroom clamps k, lowering it
  // recovers nothing while the ratchet holds the old clamp. And the wall
  // must be told: the meta brightness rides the reset k.
  budget.reset();
  const m = budget.toMeta();
  lastMetaBr = m.brightness;
  sink?.send(meta(m));
});

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);

// Serial pre-flight: a COM port is exclusive, and an open() failure on a
// port held by the Arduino monitor (or a stale bridge) is the opaque
// 'Failed to open serial port'. Ask the server which ports Windows reports
// as busy BEFORE the user clicks Connect, so 'the port is taken' is a
// named warning, not a mystery. The probe test-opens ports, which toggles
// DTR/RTS and reboots a connected ESP32 - so this runs on load, not on a
// timer; the server caches it for 3 s regardless.
async function serialPreflight() {
  try {
    const res = await fetch('/serial');
    if (!res.ok) return;
    const ports = await res.json();
    const busy = ports.filter((p) => p.state === 'busy').map((p) => p.port);
    if (busy.length > 0 && sink === null) {
      setOutput($('sinkOut'), `warning: ${busy.join(', ')} in use by another program - close its serial monitor before connecting`, 'warn');
    }
  } catch {
    // Server without /serial (older serve.js): stay quiet, open() will report.
  }
}
serialPreflight();

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
 * Fixed 30 fps on a WORKER clock, not requestAnimationFrame and not a main-
 * thread timer.
 *
 * The wall's frame rate is a property of the wire (921600 gives ~75 frames/s
 * theoretical), not of the display. rAF is throttled to ~1 fps in a hidden
 * tab, and Chromium throttles plain timers in a hidden tab to ~1 Hz as well
 * - either way the stream starves the moment this tab stops being the front
 * tab, and the firmware watchdog fades the panel. Workers are exempt from
 * background throttling, so the tempo lives in one: the stream keeps full
 * pace with the tab in the background, and only the canvas work is skipped
 * while hidden.
 */
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
let next = performance.now();

const clock = createClock(FRAME_MS);
clock.onTick = () => {
  const now = performance.now();
  if (now - next >= -1) {
    // Never let the schedule drift behind the clock: a throttled or suspended
    // tab resumes at the current frame instead of replaying a backlog.
    next = Math.max(next + FRAME_MS, now - FRAME_MS);
    try {
      tick();
      pushContentFrame();
    } catch (err) {
      // The clock is the only thing keeping the stream alive, so a throw
      // escaping tick() would cost the wall every frame after it, not just
      // the broken one. Report which frame failed and keep going: a bad
      // layout or a source that changed mid-frame is a recoverable state, and
      // a wall that goes dark permanently is not.
      setOutput($('frameOut'), `frame failed: ${err.message}`, 'err');
    }
  }
};
// Paint the first frame now, not one clock period from now: the old loop ran
// tick() synchronously at module load, and a page that renders its first
// frame ~33 ms late is a page whose readout is empty when a snapshot lands.
clock.onTick();
clock.start();

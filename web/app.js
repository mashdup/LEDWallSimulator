/**
 * app.js — the browser brain.
 *
 * One Panel, one frame loop. The loop rasterises the banner, clamps it against
 * the power budget, packs it through the layout, and hands finished frames to
 * whichever sink is selected. The sim shows the wall's EXPECTED VIEW at full
 * brightness - the un-scaled wire bytes - so a power clamp dims the wall,
 * never the preview (the clamp reads out on the power line).
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
  metaDelivery,
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
import { ANIM_NAMES, makeMessage, gallerySlot, GAP_ANIM_NAMES, TRANSITION_NAMES, GALLERY_DEFAULTS } from '../core/content-protocol.js';
import { applyTransition } from '../core/transitions.js';
import { animFrame } from '../core/animations.js';

const $ = (id) => document.getElementById(id);

const canvas = $('sim');
const sim = new Sim(canvas);
const panel = new Panel();

/** Scratch buffers allocated once: 30 fps x 1200 bytes is not something to GC. */
const packed = new Uint8Array(RGB_BYTES);
// The scaled copy: what the wall will actually draw after it folds in the
// meta brightness, and therefore what the estimator and the peak meter must
// look at. The wire carries `packed` raw, and so does the sim: the preview
// shows the design at full brightness, and the clamp lives on the power line.
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
// Best-known path of the wall's port. A failed open cannot ask the port for
// its info (there is no port), so the takeover needs the last good path. It
// is NOT hardcoded to COM8: that is the show machine's Windows name, and the
// same cable on a Mac is 'cu.usbmodem59810005071'. The seed comes from the
// server's port list (serialPreflight); Connect overwrites it with the path
// it actually opened.
let lastSerialPort = null;

/**
 * Connect found the port busy: a corpse of a previous app instance is
 * holding it (window closed uncleanly, process killed - Windows keeps the
 * COM handle with the corpse). Ask the server to name the holder and
 * terminate it. The server kills ONLY our own electron.exe; a foreign
 * holder (Arduino IDE, PuTTY, a flasher) is named and spared - killing a
 * user's editor mid-edit is not a side effect a Connect click should have.
 * Returns true when a corpse was cleared, so Connect retries the open.
 */
async function serialTakeOver() {
  if (lastSerialPort === null) return false; // nothing was ever named; nothing to free
  try {
    const r = await fetch('/serial/takeover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: lastSerialPort }),
    });
    const j = await r.json();
    if (j.killed && j.killed.length > 0) return true;
    if (j.spared && j.spared.length > 0) {
      const s = j.spared[0];
      setOutput($('sinkOut'), `port held by ${s.name} (pid ${s.pid}) - close it, or: npm run freeport -- ${lastSerialPort} --kill`, 'warn');
      return false;
    }
    // No process holds the port, yet the open failed: the lock is in the
    // wch driver, not in any process (measured: closing a connected app
    // leaves the port un-openable for a while - the alternating
    // 'works, fails, works' pattern). The probe's test-open clears that
    // zombie lock as a side effect, so run one fresh and retry.
    await fetch('/serial?fresh=1').catch(() => {});
    return true;
  } catch {
    return false; // no server (file:// demo): the original error stands
  }
}
let seq = 0;
/**
 * The bytes the CURRENT sink was last given, or null for "this sink has had
 * nothing". Null rather than a zero-filled buffer because a still wall must
 * still be pushed once when a sink connects: without that, connecting to an
 * image that is not changing leaves the wall showing whatever it had.
 */
let lastSent = null;
/**
 * What the wall has been told via meta (brightness + budget), as a state
 * machine: re-sent on change, and — the part that keeps the LEDs honest —
 * re-sent whenever the sink link comes BACK. The serial sink reconnects
 * itself after a USB sag, the ESP32 power-cycles, its firmware boots at the
 * default brightness, and the naive "send on change" rule leaves the wall
 * full-bright with a dead-looking slider. See core/metalink.js.
 */
const metaState = metaDelivery();
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
  // leave. Saturation pulls each pixel away from its own mean, which is what
  // rescues a pastel that the diffuser and a bright wall would otherwise wash
  // to white. The preview draws these same un-scaled bytes (see draw()).
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
  // `rendered` is the scaled copy the estimator and the peak meter see,
  // which is what the wall will actually draw once the sink scales it. The
  // sim deliberately does NOT look at this copy: the preview shows the
  // design at full brightness, because a preview that dims with the power
  // clamp reads like the content changed when only the budget did.
  rendered.set(packed);
  if (k < 1) for (let i = 0; i < rendered.length; i++) rendered[i] = (rendered[i] * k) | 0;

  const ma = budget.observe(rendered);
  peak.push(rendered);

  // The clamp moves between scene changes (its peak-hold is monotonic), so
  // a meta re-send on change is rare — 5 bytes, and the wall's applied
  // brightness stops being whatever the first frame asked for. The link
  // check is what makes the re-send cover the case change cannot see: a
  // silent serial reconnect has rebooted the wall back to its default
  // brightness, and a meta refused during the dark window is still owed.
  metaState.noteLink(sink === null || sink.connected !== false);
  const br = Math.round(k * 255);
  if (metaState.owed(br)) {
    metaState.told(br, sink?.send(meta({ brightness: br, limitMa: Math.round(budget.limitMa) })) !== false);
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
  // The preview is the wall's EXPECTED VIEW, brightness ignored: it draws the
  // raw wire bytes, before the power clamp's k. The clamp is a property of the
  // power system, not of the content, and a preview that dimmed with it reads
  // as the picture changing when only the budget moved. k and the mA readouts
  // live on the power line, which is where a clamp is visible on purpose.
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
    `sent ${sent} · dropped ${dropped}${sink ? ` · sink ${sink.kind ?? 'sim'}` : ' · sink none'}` +
    watchLine(),
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
  if (!SINK_KINDS.includes(kind)) return { ok: false, error: `unknown sink kind '${kind}'` };
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
    metaState.told(m.brightness, sink.send(meta(m)) !== false);
    // A fresh sink has been given nothing, so the next tick must push even if the
    // image is not changing; otherwise connecting to a still wall shows nothing.
    lastSent = null;
    // Name what we connected to: a programmatic port picker can choose an
    // unrelated COM device, and 'connected: serial' over a dead wall is a
    // trap. The path and product name make a wrong choice visible.
    const info = sink.port?.getInfo?.();
    if (info?.path) lastSerialPort = info.path;
    const whom = info
      ? `${info.path ?? 'port'}${info.usbProductName ? ` (${info.usbProductName})` : ''}`
      : '';
    setOutput($('sinkOut'), `connected: ${sink.kind}${whom ? ` - ${whom}` : ''}`, 'ok');
    $('connect').disabled = true;
    $('disconnect').disabled = false;
    // The app shell logs this outcome (its 'autostart: gesture -> ...' line
    // used to say 'connected' over a refused picker, because connect()
    // resolves either way and the shell had nothing to read).
  } catch (err) {
    sink = null;
    // A serial open failure is almost always 'port busy', and the usual
    // holder is our own previous instance's corpse. Name it, kill it if it
    // is ours, retry the open once. A spared foreign holder was already
    // named by serialTakeOver.
    if (kind === 'serial' && /serial port/i.test(String(err && err.message))) {
      setOutput($('sinkOut'), 'serial port busy - checking for a stale instance...', 'warn');
      if (await serialTakeOver()) {
        // The driver lock releases asynchronously after the probe; give it
        // a beat, and retry once more if the first attempt lands mid-release.
        await new Promise((r) => setTimeout(r, 400));
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            sink = await openSink(kind, { baud: Number($('baud').value), channel: CHANNEL });
            break;
          } catch (e2) {
            if (attempt === 1) {
              sink = null;
              setOutput($('sinkOut'), e2.message, 'err');
              $('connect').disabled = false;
              $('disconnect').disabled = true;
              return { ok: false, error: e2.message };
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        const m2 = budget.toMeta();
        metaState.told(m2.brightness, sink.send(meta(m2)) !== false);
        lastSent = null;
        setOutput($('sinkOut'), `connected: ${sink.kind} - ${lastSerialPort} (took over from the previous instance)`, 'ok');
        $('connect').disabled = true;
        $('disconnect').disabled = false;
        return { ok: true, port: lastSerialPort };
      }
    }
    setOutput($('sinkOut'), err.message, 'err');
    $('connect').disabled = false;
    $('disconnect').disabled = true;
    return { ok: false, error: err.message };
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

// The gallery, app-side. The entries live on the server (GET /drawings) and
// which one is showing is floor(serverTime / interval) % n - the same pure
// arithmetic content.html uses, so this tab, a content tab, and a page loaded
// mid-cycle all land on the same drawing. animFrame cannot resolve it (this
// module never fetches), and its default branch is the demo: left alone, a
// driver in gallery mode plays confetti where a family drawing belongs.
const cGallery = { metas: [], fetchedAt: 0, cache: new Map(), inflight: null, pending: new Set() };

function cGalleryRefresh(force = false) {
  if (cGallery.inflight !== null) return cGallery.inflight;
  if (!force && Date.now() - cGallery.fetchedAt < 2000) return Promise.resolve();
  cGallery.inflight = fetch('/drawings', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : []))
    .then((metas) => {
      cGallery.metas = Array.isArray(metas) ? metas : [];
      cGallery.fetchedAt = Date.now();
      // The count is written where the number is learned. Mirroring it only on
      // a content rev change would show "0 drawings" forever: the list arrives
      // a moment after the state that asks for it, and the state does not
      // change again.
      renderGalleryCount();
    }, () => {
      // Server down: keep cycling the list we already have.
    })
    .then(() => { cGallery.inflight = null; });
  return cGallery.inflight;
}

function cGalleryFetch(id) {
  if (cGallery.cache.has(id) || cGallery.pending.has(id)) return;
  cGallery.pending.add(id);
  fetch(`/drawings/${id}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((e) => {
      if (e !== null && typeof e.pixels === 'string') cGallery.cache.set(id, e.pixels);
    }, () => {
      /* not cached: the next tick retries */
    })
    .then(() => { cGallery.pending.delete(id); });
}

/**
 * The flat RGB bytes of one slot: a drawing off the wire, a break animation,
 * or dark. From the pure generator, so the transition blends two frames of the
 * same origin, and this tab and a content tab compose identical bytes.
 */
function cSlotBytes(slot, tSec) {
  if (slot.anim !== null) return animFrame({ kind: 'anim', name: slot.anim }, tSec);
  if (slot.drawing < 0) return new Uint8Array(20 * 20 * 3);
  const meta = cGallery.metas[slot.drawing];
  const hex = cGallery.cache.get(meta.id);
  if (hex === undefined) {
    cGalleryFetch(meta.id);
    return new Uint8Array(20 * 20 * 3); // dark this tick; the pixels land on the next one
  }
  return animFrame({ kind: 'pic', pixels: hex }, tSec);
}

/** The bytes to push this tick: the slot, plus the transition into it. */
function cGalleryBytes(tSec) {
  cGalleryRefresh(); // self-throttled: one list fetch per 2 s, one in flight
  const slot = gallerySlot(tSec, cGallery.metas.length,
    cState.interval ?? 5, cState.gap ?? 0, cState.gapAnim ?? 'none', cState.transitionSec ?? 0);
  const to = cSlotBytes(slot, tSec);
  // The transition is a slot boundary, not a timer: k comes from the same
  // clock arithmetic that picked the slot, so a page that loads mid-wipe is
  // mid-wipe, and the capture browser and this driver agree on the frame.
  if (slot.from === null) return to;
  return applyTransition(cState.transition ?? 'none', cSlotBytes(slot.from, tSec), to, slot.k);
}

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
      // Entering the gallery: pull the list now, do not wait out the 2 s
      // refresh window, so the first drawing shows within one poll.
      if (j.state.kind === 'gallery') cGalleryRefresh(true);
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

/**
 * The relay, in the console: one line, read from the wall's own server.
 *
 * The wall dials out, so the console cannot know the relay's state on its own,
 * and the owner needs to see it at a party: "synced" is the queue moving, "not
 * syncing" is the phones posting into a relay the laptop cannot reach while the
 * wall keeps showing what it already has. The wording distinguishes the two
 * failures that matter - no signal, and a key the relay does not recognise.
 */
function renderRelay(j) {
  const el = $('relayOut');
  if (el === null) return;
  syncRelayUi(j);
  if (!j.enabled) {
    setOutput(el, 'relay: off (guests reach this wall over the local network only)', 'warn');
    return;
  }
  // The published console IS the relay, so there is no relay URL to show: the
  // number that matters there is when the wall last visited (see GET /relay in
  // relay/server.js). A wall's own server reports its relay's URL instead.
  const host = j.url === '' ? 'this relay' : (() => {
    try { return new URL(j.url).host; } catch { return j.url; }
  })();
  if (j.lastError !== null) {
    setOutput(el, `relay: ${host} - ${j.lastError}`, 'err');
    return;
  }
  const ago = j.syncedAt > 0 ? Math.max(0, Math.round((Date.now() - j.syncedAt) / 1000)) : -1;
  // Two different facts, two different words. On the wall's own server the
  // client reports ITS last sync with the relay ("synced"). On the published
  // console the same number is when the wall last visited THIS machine - the
  // thing the owner needs to know there, where a stale number means the laptop
  // is asleep while the queue grows.
  const verb = j.url === '' ? 'the wall last visited' : 'synced';
  setOutput(el, `relay: ${host} - ${verb}${ago >= 0 ? ` ${ago} s ago` : ' never'} · ${j.count} drawings`, 'ok');
}

async function pollRelay() {
  try {
    const r = await fetch('/relay', { cache: 'no-store' });
    if (r.ok) renderRelay(await r.json());
  } catch { /* the wall's own server is the thing that just went away */ }
}

/**
 * The relay dropdown: configure the pairing from the console, not from a
 * command line. The server persists it (relay.json beside the gallery), so
 * the packaged app needs no flags and no flag-laden shortcut: set it once,
 * every boot relays by itself. Gated by the owner token server-side (401
 * without it) - the hand that can re-point the relay is the hand that
 * prunes the gallery. The key is never sent TO the page: an empty key field
 * on Apply means 'keep the saved one', and GET says only keySet: true.
 */
const PUBLIC_RELAY = 'https://wall.hoa.family';
// Same localStorage key draw.html uses: the owner types it once, per browser.
const RELAY_OWNER_KEY = 'ledwall-owner-token';
let relayEditing = false;

function syncRelayUi(j) {
  const sel = $('relayMode');
  if (sel === null) return;
  // The published console IS the relay (url '' while enabled): a relay
  // cannot pair with itself, so the controls go dark there and the status
  // line keeps telling the truth about the wall's last visit.
  const isPublisher = j.enabled === true && j.url === '';
  for (const id of ['relayMode', 'relayUrl', 'relayKey', 'relayOwner', 'relayApply']) {
    const el = $(id);
    if (el !== null) el.disabled = isPublisher;
  }
  if (isPublisher || relayEditing) return;
  const url = String(j.url ?? '').replace(/\/+$/, '');
  sel.value = j.enabled ? (url === PUBLIC_RELAY ? 'public' : 'custom') : 'off';
  $('relayUrlRow').hidden = sel.value !== 'custom';
  if (sel.value === 'custom' && j.url !== '') $('relayUrl').value = j.url;
  $('relayKey').placeholder = j.keySet === true ? 'wall key (saved)' : 'wall key';
}

const relayOwner = $('relayOwner');
if (relayOwner !== null) {
  try { relayOwner.value = localStorage.getItem(RELAY_OWNER_KEY) ?? ''; } catch { /* private mode */ }
  relayOwner.addEventListener('input', () => {
    try { localStorage.setItem(RELAY_OWNER_KEY, relayOwner.value.trim()); } catch { /* private mode */ }
  });
}
$('relayMode')?.addEventListener('change', (e) => {
  relayEditing = true;
  $('relayUrlRow').hidden = e.target.value !== 'custom';
});
$('relayUrl')?.addEventListener('input', () => { relayEditing = true; });
$('relayKey')?.addEventListener('input', () => { relayEditing = true; });
$('relayApply')?.addEventListener('click', async () => {
  const mode = $('relayMode').value;
  const cfg = mode === 'off'
    ? { url: '' }
    : mode === 'public'
      ? { url: PUBLIC_RELAY, key: $('relayKey').value.trim() }
      : { url: $('relayUrl').value.trim(), key: $('relayKey').value.trim() };
  const owner = $('relayOwner').value.trim() || (() => {
    try { return localStorage.getItem(RELAY_OWNER_KEY) ?? ''; } catch { return ''; }
  })();
  try {
    const r = await fetch('/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wall-owner': owner },
      body: JSON.stringify(cfg),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      setOutput($('relayOut'), 'relay: owner token needed - the server prints it at startup (this box remembers it, and draw.html shares it)', 'err');
      return;
    }
    if (!r.ok) {
      setOutput($('relayOut'), `relay: ${j.why ?? `refused (HTTP ${r.status})`}`, 'err');
      return;
    }
    relayEditing = false;
    $('relayKey').value = '';
    setOutput($('relayOut'), j.enabled
      ? `relay: pointed at ${j.url} - dialling out, and every later start will relay by itself`
      : 'relay: off - guests reach this wall over the local network only', 'ok');
    pollRelay();
  } catch (err) {
    setOutput($('relayOut'), `relay: the server did not answer (${err.message})`, 'err');
  }
});

setInterval(pollRelay, 5_000);
pollRelay();

function pushContentFrame() {
  if (page.endpoint !== '/content/frame' || cPushing) return;
  cPushing = true;
  const tSec = cServerAt / 1000 + (performance.now() - cLocalAt) / 1000;
  let bytes;
  if (cState.kind === 'text' && cScroller !== null) {
    // seek() takes a CELL offset in [0, period), not a fraction: the old
    // code fed the pass fraction (0..1) straight in, so the text sat
    // between 0 and 1 cell and wrapped - visible, and stone still. Multiply
    // by the period to make the fraction an actual position.
    const frac = cPassMs > 0 ? ((tSec * 1000) % cPassMs) / cPassMs : 0;
    cScroller.seek(frac * cScroller.period);
    cScroller.render(cPanel);
    bytes = cPanel.pixels;
  } else if (cState.kind === 'gallery') {
    bytes = cGalleryBytes(tSec);
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

// The gallery, from the console. The cadence is the whole command: the entries
// live on the server, and which one is showing - and where in the transition
// the wall is - is arithmetic on the shared server clock, so this button only
// sets the cadence and every renderer (the capture browser, a phone, this tab
// driving the frames) lands in the same slot. The selects are built from the
// lists the protocol gate validates, so the console can never offer a value the
// wall would refuse.
/** The gallery's own number, in the console. Written where it is learned. */
function renderGalleryCount() {
  setOutput($('galCount'), `${cGallery.metas.length} drawings`);
}

const galGapAnim = $('galGapAnim');
for (const name of GAP_ANIM_NAMES) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name === 'none' ? 'dark' : name;
  galGapAnim.append(o);
}
const galTrans = $('galTrans');
for (const name of TRANSITION_NAMES) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name === 'none' ? 'hard cut' : name;
  galTrans.append(o);
}
galGapAnim.value = GALLERY_DEFAULTS.gapAnim;
galTrans.value = GALLERY_DEFAULTS.transition;
$('galInterval').value = String(GALLERY_DEFAULTS.interval);
$('galGap').value = String(GALLERY_DEFAULTS.gap);
$('galTransSec').value = String(GALLERY_DEFAULTS.transitionSec);

$('galStart').addEventListener('click', () => {
  const interval = Math.max(1, Math.min(600, Number($('galInterval').value) || GALLERY_DEFAULTS.interval));
  const gap = Math.max(0, Math.min(600, Number($('galGap').value) || 0));
  const gapAnim = GAP_ANIM_NAMES.includes(galGapAnim.value) ? galGapAnim.value : 'none';
  const transition = TRANSITION_NAMES.includes(galTrans.value) ? galTrans.value : 'none';
  const transitionSec = Math.max(0, Math.min(30, Number($('galTransSec').value) || 0));
  $('galInterval').value = String(interval);
  $('galGap').value = String(gap);
  $('galTransSec').value = String(transitionSec);
  sendContent(makeMessage('gallery', { interval, gap, gapAnim, transition, transitionSec }),
    `gallery every ${interval} s${gap > 0 ? `, ${gap} s of ${gapAnim} between` : ''}`
    + `${transitionSec > 0 ? `, ${transition} ${transitionSec} s` : ', hard cut'}`);
});

// Mirror the server's current state into the status line and light the
// matching animation button, so the panel shows what the wall shows.
function mirrorContent(j) {
  const s = j.state;
  const what = s.kind === 'text' ? `text: ${String(s.text).slice(0, 32)}`
    : s.kind === 'anim' ? s.name
    : s.kind === 'pic' ? 'drawing'
    : s.kind === 'gallery' ? `gallery · every ${s.interval ?? 5} s${(s.gap ?? 0) > 0 ? ` + ${s.gap} s of ${s.gapAnim ?? 'none'}` : ''}${(s.transitionSec ?? 0) > 0 ? ` · ${s.transition ?? 'fade'} ${s.transitionSec} s` : ''}`
    : s.kind;
  setOutput($('contentOut'), `server rev ${j.rev} - showing: ${what}`);
  for (const b of $('contentAnims').children) {
    b.classList.toggle('on', s.kind === 'anim' && b.dataset.anim === s.name);
  }
  $('galStart').classList.toggle('on', s.kind === 'gallery');
  // The cadence fields mirror the server on the SAME poll that changes the
  // state - so a console opened at the wall shows what the wall is doing,
  // including a cadence set from the control page or the drawing page. This
  // runs on a rev change, never under the person typing.
  if (s.kind === 'gallery') {
    $('galInterval').value = String(s.interval ?? GALLERY_DEFAULTS.interval);
    $('galGap').value = String(s.gap ?? 0);
    galGapAnim.value = GAP_ANIM_NAMES.includes(s.gapAnim) ? s.gapAnim : 'none';
    galTrans.value = TRANSITION_NAMES.includes(s.transition) ? s.transition : 'none';
    $('galTransSec').value = String(s.transitionSec ?? 0);
  }
  // The count is the one thing about the gallery the app does not already
  // know: the entries live on the server, and the list arrives with the cycle.
  // Only while the wall is IN the gallery - the list is the gallery's data, and
  // a console that polls it in every mode is a second polling loop nobody asked
  // for.
  if (s.kind === 'gallery') {
    renderGalleryCount();
    if (cGallery.metas.length === 0) cGalleryRefresh(true);
  }
}


$('limitMa').addEventListener('change', () => {
  budget.limitMa = Number($('limitMa').value);
  budget.reset();
  const m = budget.toMeta();
  // Record the outcome with the delivery state: a refused send (cable out)
  // stays owed, and the frame loop retries when the link is back.
  metaState.told(m.brightness, sink?.send(meta(m)) !== false);
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
  metaState.told(m.brightness, sink?.send(meta(m)) !== false);
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
    // Seed the takeover target: on a Mac the port is 'cu.usbmodem…', never
    // COM8, so a hardcoded seed asks the server to free a port that does not
    // exist. The first real port the server reports is the best guess.
    if (lastSerialPort === null && Array.isArray(ports) && ports.length > 0) {
      lastSerialPort = ports[0].port;
    }
    const busy = ports.filter((p) => p.state === 'busy' || p.state === 'BUSY').map((p) => p.port);
    if (busy.length > 0 && sink === null) {
      setOutput($('sinkOut'), `warning: ${busy.join(', ')} in use by another program - close its serial monitor before connecting`, 'warn');
    }
  } catch {
    // Server without /serial (older serve.js): stay quiet, open() will report.
  }
}
serialPreflight();

// Auto-reconnect: a GRANTED serial port reopens with no gesture, so this
// rejoins the show by itself after a crash-reload, an app restart, a machine
// reboot — the wall's stream resumes with no human at the keyboard. (The
// companion lives in sinks.js: a cable PULL re-arms on the device's own
// 'connect' event, so a power-sag re-enumeration heals mid-show too.)
// Silent when nothing was ever granted: the first show of the day always
// starts with a human clicking Connect, which is the right amount of intent
// — UNLESS the app shell is running, which answers window.wallAutoStart()
// and manufactures the one thing the page cannot: a user gesture.
(async () => {
  const serial = globalThis.navigator?.serial;
  if (serial?.getPorts === undefined) return;
  const granted = await serial.getPorts().catch(() => []);
  if (Array.isArray(granted) && granted.length > 0 && sink === null) {
    await window.wallSerialConnect();
    // Only rewrite the line when the reopen SUCCEEDED (connect() already
    // named any failure); name the port the way Connect names it, so the
    // owner can tell 'auto-healed onto COM8' from 'connected by hand'.
    if (sink !== null) {
      const info = sink.port?.getInfo?.();
      setOutput(
        $('sinkOut'),
        `auto-reconnected: ${sink.kind}${info?.path ? ` - ${info.path}` : ''} - reopened the granted port, no click needed`,
        'ok',
      );
    }
  }
})();

// The app shell's two entry points (main.cjs drives them after every page
// load): wallAutoStart reports what the page needs ('granted' = reconnected
// itself; 'gesture' = the picker needs a click the shell will synthesize),
// and wallSerialConnect performs the connect once that gesture exists.
window.wallSerialConnect = () => {
  $('sink').value = 'serial';
  return connect();
};
window.wallAutoStart = async () => {
  const serial = globalThis.navigator?.serial;
  if (serial?.getPorts === undefined) return 'none';
  if (sink !== null) return 'connected';
  const granted = await serial.getPorts().catch(() => []);
  if (Array.isArray(granted) && granted.length > 0) {
    await window.wallSerialConnect();
    return 'granted';
  }
  return 'gesture';
};

window.addEventListener('resize', () => sim.resize());

// ---------------------------------------------------------------------------
// Self-healing watchdog
// ---------------------------------------------------------------------------

/**
 * Watchdogs DETECT; they never reload. (An earlier revision reloaded the
 * page on a stale wake or a paint stall, and that was wrong for THIS page:
 * a reload drops the serial port — Web Serial needs a user gesture, so a
 * reloaded console cannot re-open COM8 by itself — which turns every
 * hiccup into a dark wall and a human click. And a page that reloads on
 * every stall is a wall that blinks. Detection without destruction:
 * record the event, show it in the readout, and for the grey page try a
 * non-destructive revive of the painting. The wall's stream lives in the
 * worker clock and the serial port, NOT in the painting, so the wall keeps
 * lighting through all of this — which is the point of the whole design.)
 *
 * The measurements behind the two detectors (see also keep-alive.js):
 * Edge's Sleeping Tabs, Chrome's Memory Saver and Power Saver freeze a
 * background tab's timers and worker — the heartbeat goes stale; and the
 * plain-grey-window failure (no Aw Snap) is the compositor producing no
 * frames while the page's JS stays alive — the rAF probe goes silent.
 */
const HEARTBEAT_KEY = 'wall-heartbeat';
const EVENTS_KEY = 'wall-events';
const HEARTBEAT_WRITE_MS = 1000;
/** A wake-up older than this was frozen. */
const STALE_RESUME_MS = 10_000;

function stampHeartbeat() {
  try {
    localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
  } catch {
    // Private mode / storage disabled: the watchdog silently self-cancels.
  }
}

// A fresh load is alive: stamp before any resume check can read the store.
stampHeartbeat();
let lastBeatMs = Date.now();

/** A capped ring of {kind, at} — the show's own incident log, visible to the owner. */
function recordEvent(kind) {
  let events = [];
  try {
    events = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? '[]');
    if (!Array.isArray(events)) events = [];
  } catch {
    events = [];
  }
  events.push({ kind, at: Date.now() });
  while (events.length > 20) events.shift();
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    // Storage off: the watchdog records nothing; the wall is unaffected.
  }
}

function readEvents() {
  try {
    const e = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? '[]');
    return Array.isArray(e) ? e : [];
  } catch {
    return [];
  }
}

/**
 * The owner-facing summary for the frame line: what the browser did to this
 * tab, and the promise that matters — the serial stream lives in the worker
 * and the port, so a faltering browser never took the wall down with it.
 */
function watchLine() {
  const events = readEvents();
  if (events.length === 0) return '';
  const n = (kind) => events.filter((e) => e.kind === kind).length;
  const last = events[events.length - 1];
  const at = new Date(last.at).toLocaleTimeString();
  const parts = [];
  if (n('paint-stall') > 0) parts.push(`${n('paint-stall')} paint stalls`);
  if (n('frozen') > 0) parts.push(`${n('frozen')} frozen wakes`);
  if (parts.length === 0) parts.push(`${events.length} browser events`);
  return `\nWATCH: ${parts.join(' · ')} (last ${at}) — the browser faltered; the wall stream never stopped`;
}

function resumeCheck() {
  if (document.visibilityState !== 'visible') return;
  let beatMs = 0;
  try {
    beatMs = Number(localStorage.getItem(HEARTBEAT_KEY) ?? 0);
  } catch {
    return;
  }
  // A stale heartbeat on wake says: the browser froze this tab, and while it
  // was frozen the streams died with it (worker clock, serial in-flight).
  // The clock re-arms itself on the first tick; the owner sees the count.
  if (Date.now() - beatMs > STALE_RESUME_MS) recordEvent('frozen');
}
document.addEventListener('visibilitychange', resumeCheck);
addEventListener('pageshow', resumeCheck);

/**
 * The grey page: the tab is visible, the frame clock is running (it lives in
 * a worker, far from the compositor), and the window paints NOTHING — full
 * grey, no Aw Snap. That is the compositor/GPU process failing to produce
 * frames, and the heartbeat cannot see it: the page is alive, only the
 * painting is dead, and no wake event fires because the tab was never hidden.
 *
 * requestAnimationFrame is the page's probe for the painting: rAF fires only
 * when the compositor asks for a frame. The frame loop deliberately does NOT
 * use rAF (a hidden tab must keep streaming), so a dedicated rAF pulse costs
 * nothing and tells the truth: a VISIBLE tab whose rAF goes silent for
 * RAF_STALL_MS has no compositor — the PREVIEW is dead (the wall keeps
 * lighting: the stream is in the worker and the port).
 *
 * The cure is non-destructive: re-allocate the canvas backing store and
 * nudge the compositing layer, which is the in-page trick that makes
 * Chromium rebuild a dead paint pipeline WITHOUT touching the serial port.
 * Every stall is recorded and counted in the readout, so the owner can see
 * it happening, and a human F5 stays the last resort — not the reflex.
 *
 * The beat rides in localStorage (stamped at 2 Hz from the rAF itself) so
 * the check runs on the worker-driven tick and a test can drive it.
 */
const RAF_BEAT_KEY = 'wall-raf-beat';
const RAF_BEAT_WRITE_MS = 500;
/** A visible tab's compositor missing for this long is dead, not busy. */
const RAF_STALL_MS = 10_000;
let lastRafWriteMs = 0;

function stampRafBeat() {
  const now = Date.now();
  if (now - lastRafWriteMs >= RAF_BEAT_WRITE_MS) {
    lastRafWriteMs = now;
    try {
      localStorage.setItem(RAF_BEAT_KEY, String(now));
    } catch {
      // Storage off: the paint watchdog self-cancels, like the heartbeat.
    }
  }
}

(function rafPulse() {
  stampRafBeat();
  requestAnimationFrame(rafPulse);
})();

/**
 * Revive the painting without touching the wall: resizing the canvas makes
 * Chromium re-allocate its backing store and rebuild the compositor layer,
 * and the transform nudge forces the document layer to re-composite. Both
 * are pure paint-side operations: the serial port, the worker clock and the
 * in-flight frames are untouched, so the COM8 stream never blinks.
 */
function revivePainting() {
  try {
    const w = canvas.width;
    const h = canvas.height;
    canvas.width = w + 1; // the re-allocation: same CSS box, new store
    canvas.width = w;
    sim.resize();
    document.body.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      document.body.style.transform = '';
    });
  } catch {
    // A failed revive is the same as no revive; the wall is unaffected.
  }
}

function paintCheck() {
  // Only a visible tab is expected to paint: a hidden tab has no rAF by design.
  if (document.visibilityState !== 'visible') return;
  let beat = 0;
  try {
    beat = Number(localStorage.getItem(RAF_BEAT_KEY) ?? 0);
  } catch {
    return;
  }
  if (beat === 0 || Date.now() - beat <= RAF_STALL_MS) return;
  // One strike per stall: FORCE the beat fresh (the 2 Hz throttle must not
  // swallow this write, or every tick after a stall records another one),
  // record it, and try to revive the paint.
  lastRafWriteMs = Date.now();
  try {
    localStorage.setItem(RAF_BEAT_KEY, String(lastRafWriteMs));
  } catch {
    // Storage off: nothing to stamp.
  }
  recordEvent('paint-stall');
  revivePainting();
}

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
    // The watchdog's pulse: one localStorage stamp a second, off the clock
    // that drives the wall — if this tick runs, the page is alive.
    const wallNow = Date.now();
    if (wallNow - lastBeatMs >= HEARTBEAT_WRITE_MS) {
      lastBeatMs = wallNow;
      stampHeartbeat();
    }
    // The paint watchdog rides the same worker-driven tick: it must run when
    // the compositor does NOT, which is exactly the grey-page case.
    paintCheck();
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

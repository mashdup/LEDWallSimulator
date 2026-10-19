# LED Curtain Wall — Build Plan

*Hardware:* 1m² panel, 400 APA106/PL9823 beads (**not WS2812B** — see firmware/README.md, "Panel identity"), 20×20 @ 50mm pitch, 3-wire. Data line spliced off the built-in controller to an ESP32.

*Architecture:* the browser is the whole brain. It fetches the banner, rasterises it, applies effects, and streams finished frames. The ESP32 is a dumb pixel sink. Sim and wall use the same frame protocol, so nothing is throwaway.

## Repo layout


led-wall/
  core/        framebuffer, layout map, effects   (pure JS, no DOM)
  web/         banner page + canvas sim + connect UI
  firmware/    esp32 sketch.ino
  test/        unit tests for core


## 1. Core framebuffer (core/)

- Panel class: 20×20 grid, setPixel(x, y, r, g, b), clear(), toBytes().
- layout.js: logical (x,y) → physical LED index. Zigzag/snake direction, strip start offsets, and a flipX/flipY/transpose set of flags. *This is the file you'll edit once when the wiring is real* — everything else stays untouched.
- buffer.js: packs the grid into a flat RGB byte array (1200 bytes).
- No DOM, no fetch, no browser APIs in core/. It must run under Node so it's testable.

## 2. Frame protocol

Fixed-size, self-clocking, drop-safe:


0xA5        frame magic
seq         uint8, wraps
1200 bytes  RGB, physical LED order (post-layout)
0x5A        frame end

Total 1204 bytes. Firmware renders the last complete frame it saw; a partial frame is discarded, so a dropped byte never corrupts the wall. Baud 921600.

Also define a meta frame (magic 0xA4) for brightness and power budget — see §6.

## 3. Banner renderer (web/)

- Banner source is your own page. Fetch it via fetch() on a short poll (200–500ms) or an EventSource stream if you want push.
- Rasterise text into the 20×20 grid: render to an offscreen canvas at high res, downsample to 20×20 with area averaging (not nearest — nearest looks crunchy at 50mm pitch).
- Scroller: horizontal marquee at fractional pixels per frame, so text glides rather than jumps a whole glyph per tick.
- Font sized to the grid: cap height ≈ 13–15 rows leaves room for descenders and looks right on a curtain.

## 4. Sim (web/)

Canvas, 20×20 cells scaled up, each cell drawn as a soft radial blob rather than a hard square — that approximates how diffused curtain LEDs actually blend, so what you see on screen matches what you'll get on the wall. Same Panel instance as the wall path. Include a "what the wall actually sees" toggle that renders with the physical index order, so you can preview a wiring mistake before it's installed.

*Colour.* The renderer carries two output stages in `core/color.js`, applied to the
finished frame before the power clamp — so the estimator and the sim both see the
bytes that actually leave. **Saturation** pulls each pixel away from its own mean:
a diffused wall and the eye's own desaturation at high luminance (the
Bezold–Brücke shift) both wash a pastel toward white, and pure channels are the
only ones that survive it. **Gamma** is the usual display curve, which deepens
midtones at the same power draw. Both are host-side; the frame protocol stays raw
RGB bytes and the sink stays dumb.

## 5. Transport

*Sink:* **two, and both work.** The renderer emits the same frozen frame records
either way, so this is a transport choice, not a code fork:

- **Offline — USB.** browser → Web Serial → the sketch → beads, no network at
  all. The sketch drives the panel itself: the RMT emits the part's real bit
  timing (350 ns / 1350 ns, a 1.7 µs bit) at 20 MHz resolution, and needs no
  library. `Adafruit_NeoPixel` cannot express those timings, and NeoPixelBus does
  not build on ESP32 core 3.x without patching, so the timing is generated here.
- **Network — DDP.** browser → `tools/serve.js` → DDP/UDP → WLED → beads. WLED
  drives the beads with its own Apa106 RMT method. Use it when the wall has to be
  somewhere else, or driven from a phone.

`firmware/README.md`, "Panel identity", carries the evidence for the part, its
timings, and the order. *Why Web Serial is viable:* it needs a secure context, so
serve the page from `tools/serve.js`, which binds 127.0.0.1 for exactly that.

## 6. Power budget

400 APA106/PL9823 beads at full white ≈ 12A at 5V. Realistically you'll never run full white, but the renderer should carry a global brightness multiplier plus a peak-current estimator: compare the estimate against the firmware's status-line draw.
1. core/ + tests — framebuffer, layout map, byte packing. Verify a known pattern packs to the expected 1200 bytes.
2. Canvas sim scrolling live text from a local page.
3. Power estimator + brightness clamp.
4. Sink + wall lit — offline over USB (Web Serial), and over the network via WLED
   and DDP (see §5).
5. Layout calibration pass against the real panel using the physical-order preview.

Milestone 1 is the one worth doing today — it's pure logic, fully testable, and everything else hangs off it.

## 7. Drawings and the gallery

The wall is a family noticeboard as much as a data display, so anyone who can
reach it can put a picture on it. `web/draw.html` is a standalone 20×20 editor
(pencil / eraser / bucket, native color picker, quick palette, recents, undo),
and it has exactly two exits:

- **Send** → `POST /content {kind:'pic', pixels:<3200 hex chars>}` — show this
  drawing now. The bytes ride in the message, so a picture needs no server state
  beyond the content channel every renderer already polls.
- **Save** → `POST /drawings`, and `{kind:'gallery', interval}` puts the wall in
  cycling mode.

The model is `core/drawings.js`: one flat RGBA grid, 4 bytes per cell, 20×20 =
1600 bytes, and the wire form is lowercase hex of those bytes (3200 chars). Alpha
is the whole transparency story — a cell with `a=0` is *not used*, so it renders
as nothing and the wall's black shows through. Empty is not white and not black:
it is off, which is what a curtain of LEDs does with a cell nobody addressed.

*Why the gallery lives on the server:* the topology is browser-as-brain, and the
capture browser shares nothing with the tab a person draws in. `GET /drawings`
(metas, never pixels) and `GET /drawings/<id>` (one entry's pixels) are the only
way a drawing made on a phone reaches the wall. `{kind:'gallery', interval}` is a
cadence signal, not a payload: which entry is showing is
`floor(serverTime / interval) % n`, a pure function of the shared clock, so a page
that loads mid-cycle lands on the same drawing as one that has been open an hour.

*Why the store is one JSON file:* there are no users and no moderation here, and
`validateEntry` is the gate at write time and at load time — a hand-edited or
corrupt record is dropped, never trusted, and never a 500 in the renderer.
### 7.1 The guest page (`web/public.html`)

`draw.html` is the owner's editor: it can show a picture now, start the gallery,
remove an entry. A stranger standing in front of the wall gets `public.html`,
which can do exactly one thing — add to the gallery — and says so in its own
words. The boundary is not a permission flag and not a hidden panel: the page
imports `core/drawings.js` and `web/draw-editor.js` and nothing else, so it has
no `content-protocol.js` and no WebSocket in its module graph. It reads
`GET /content` and `GET /drawings` to show what the wall is painting right now,
and writes exactly one request: `POST /drawings`. The test asserts that
boundary, not the happy path: one recorded non-GET fetch (`POST /drawings`),
zero `WebSocket` constructions, the content `rev` identical before and after a
guest saves, and no `send` / `gallery` / `interval` element in the DOM.

*Why it is front-facing:* this page is in a window, so it leads with the wall.
The grid is painted as a lit LED matrix (round beads, dark gaps, a glass
highlight, and an unused cell drawn as a dim dead LED) because that is what the
drawing is going to become; the tools sit under the grid in the thumb zone as
icons; there is one verb and one button, "Put it on the wall"; and the page's
ambient glow is tinted by the dominant color of the drawing the wall is showing,
so the room and the wall agree. The "on the wall right now" panel derives its
position from the server clock with the same `floor(serverTime / interval) % n`
the renderers use, so a guest sees the wall's actual frame, not a guess.

*Why the editing is a shared module:* `web/draw-editor.js` owns the RGBA bytes,
the pointer stroke, the undo stack and the tool/color state, and paints through
a `paint` callback the page supplies. Both pages therefore cannot disagree about
what a drawing *is*, while the owner's grid stays graph paper and the guest's
grid reads as LEDs. The canvas is the only DOM the editor touches.

*Anonymity, stated honestly:* there is no account, so "who" is a name the
visitor types and nobody checks. The 20 s save cooldown is per device and
client-side — it slows one excited person down and is not a security boundary.
A wall handed out on this page needs a server-side rate limit, and the owner's
list is the pruning tool.

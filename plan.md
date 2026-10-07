# LED Curtain Wall — Build Plan

*Hardware:* 1m² panel, 400 WS2812B, 20×20 @ 50mm pitch, 3-wire. Data line spliced off the built-in controller to an ESP32.

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

## 5. Transport

Two sinks behind one interface, FrameSink.send(bytes):
*Sim sink* — straight to canvas, or WebSocket to a second browser tab.
- *Serial sink* — Web Serial: navigator.serial.requestPort(), 921600, write frames as fast as they're produced, with a frame-rate cap.

*Important constraint:* Web Serial requires a secure context. http://localhost and https:// work; plain http://192.168.1.x does *not* get the serial API. So either serve the page over localhost/HTTPS with a cert, or use the WebSocket sink and let the ESP32 take frames over WiFi instead of a cable. Decide this early — it changes the firmware, not the renderer.

## 6. Power budget

400 WS2812B at full white ≈ 12A at 5V. Realistically you'll never run full white, but the renderer should carry a global brightness multiplier plus a peak-current estimator: comp…
1. core/ + tests — framebuffer, layout map, byte packing. Verify a known pattern packs to the expected 1200 bytes.
2. Canvas sim scrolling live text from a local page.
3. Power estimator + brightness clamp.
4. Serial sink + firmware, wall lit.
5. Layout calibration pass against the real panel using the physical-order preview.

Milestone 1 is the one worth doing today — it's pure logic, fully testable, and everything else hangs off it.
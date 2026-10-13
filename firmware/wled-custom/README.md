# wled-custom — WLED as the offline USB sink

A custom WLED build for the curtain wall. WLED keeps the one thing it does
perfectly here — its **Apa106/PL9823 RMT output**, the method that actually lights
this panel — and gets a serial front end we control.

## Why a custom build

Everything in `firmware/README.md` points at one conclusion. WLED drives the wall
smoothly over **DDP**, and the sketch drives it smoothly over **Web Serial**, but
WLED-over-serial flickers:

- The ESP32-S3's **native USB serial loses bytes** — espressif/arduino-esp32#9378,
  *"[HWCDC] Missing data via USB Serial on C3/C6/S3"*. Reproduced on this board.
- **WiFi makes it worse** — wled/WLED#2698, traffic to/from WLED starves the
  serial path.
- **Adalight has no resync.** It reads a 6-byte header and then exactly `count*3`
  bytes. One dropped byte corrupts the rest of that frame *and* the next, so the
  wall flickers in random colours. `core/frame.js` already documents the fix; the
  stock sink just does not use it.

So this build changes two things and nothing else:

1. **A drop-safe framed protocol.** The sink decodes the same `0xA5`/`0xA4`
   records the browser already emits (`core/frame.js`), with the same resync: a
   rejected record is scanned for the next magic and replayed from there, so a
   lost byte costs **one frame**, not a corrupted run. This is `wled00/usermod.cpp`.
2. **A transport that does not lose the bytes.** WLED is compiled with Adalight
   out (`WLED_DISABLE_ADALIGHT`, so the usermod owns `Serial`) and can put
   `Serial` on either port:

   | env | Serial is | cable goes in | why |
   |---|---|---|---|
   | `led_wall_s3_uart` *(recommended)* | UART0 → the CH9102F bridge | the board's **UART** port | a real UART with a real FIFO; espressif/arduino-esp32#9378 never applies to it |
   | `led_wall_s3_usb` | the S3's own USB-OTG | the **USB** port (COM6 today) | convenient; still the buggy transport, but robust framing caps a lost byte at one frame |

Because the records match, `web/sinks.js` **SerialSink** and `tools/bridge.js`
drive this build with **no host changes**. Pick **Sink → `serial`** in the app;
`adalight` is dead on this build by design.

## Files

```
wled-custom/
  platformio_override.ini   our two envs + panel defaults (overlaid onto the clone)
  wled00/usermod.cpp        the sink: framed decoder + power guard (overlaid)
  setup.sh                  clone WLED at the pinned tag, then overlay
  build.sh                  pio run -e <env>
  flash.sh                  pio run -e <env> -t upload [--port]
  README.md                 this file
```

WLED itself is **not** vendored. `setup.sh` clones it to `firmware/wled/`
(git-ignored) and copies the two overlay files over it. Only the overlay is
tracked here, so a WLED update is `WLED_TAG=v0.16.0 ./setup.sh`.

## Build

```sh
cd firmware/wled-custom
./setup.sh                 # clone WLED v0.15.5 + overlay     (first run)
./build.sh                 # led_wall_s3_uart
./build.sh led_wall_s3_usb
```

Output: `firmware/wled/.pio/build/<env>/firmware.bin` (and a merged image under
`firmware/wled/build_output/release/`). On this machine it needs PlatformIO,
which downloads `espressif32@6.3.2` + arduino-esp32 `2.0.9` on first build
(~3–4 min).

## Flash

```sh
./flash.sh led_wall_s3_usb COM6          # cable in the USB port
./flash.sh led_wall_s3_uart COM5         # cable in the UART port
```

Flashing always goes through the ROM USB-serial/JTAG (esptool), so it works on
COM6 even for the UART build. Only *talking to the sketch afterwards* depends on
which port `Serial` landed on — the UART build talks on the CH9102F port, the USB
build on COM6.

> **This replaces the sketch on the board.** The working sketch image is
> `firmware/build/firmware.ino.bin` + `flash_args` and is the documented recovery
> (`firmware/README.md`, "ESP32-S3 boards"). The WLED clones' flash layout is
> 16 MB qio / 8 MB octal PSRAM, which is what `esptool flash-id` reports for this
> unit — a mismatched image SHA-fails and reset-loops.

## Verify

Serial records are the same ones the sketch speaks, so the existing tools work:

```sh
node tools/bridge.js --port COM6 --cycle           # four calibration patterns
node tools/bridge.js --port COM5 --cycle           # UART build
```

or open the app (`node tools/serve.js`), set **Sink → `serial`**, and Connect.
The firmware prints its own line at boot and once a second:

```
wall sink ready leds=400 baud=921600 limit=8000mA cap=85/255 proto=A5/A4
wall frames=412 meta=3 disc=0 resync=0 rewind=0 gaps=0 br=85/255 lim=8000 state=live
```

`disc`/`rewind` climbing means the transport is still dropping bytes (expected on
`led_wall_s3_usb` under load; a rarer, self-healing event than Adalight's). On the
UART build both should sit at 0.

### Measured on the real panel

Both envs flashed and confirmed against the panel. Identical firmware and framing,
same 400 beads; the only difference is which port `Serial` is on.

**UART0 → CH9102F (`led_wall_s3_uart`, COM8) — lossless.** A moving gradient at
20 fps for 20 s (`tmp/uart_stream.mjs`):

```
host sent 400 records
wall   frames=400 meta=1 disc=0 resync=0 rewind=0 gaps=0 br=255/255 lim=24000 state=live
```

400 of 400, no discards, no rescans, no gaps. Repeating it with one frame
deliberately made a payload byte short gave `frames=240 disc=1 resync=1 rewind=1
gaps=1` across 240 good frames: every real frame still arrived, and the corruption
was confined to the frame that carried it.

**USB-OTG (`led_wall_s3_usb`, COM6) — ~3% of frames lost, none corrupted.** Driven
with the repo's own host, `node tools/bridge.js --port COM6 --cycle --duration 15000`:

```
bridge: sent 305 frames (0 skipped for backpressure), 366920 bytes, 0 dropped
wall   frames=337 meta=4 disc=11 resync=11 rewind=11 gaps=21 br=85/255 lim=8000 state=live
```

305 sent, 295 decoded, 10 lost-byte events, all 10 self-healed by the rewind, **0
corrupted frames**. That is espressif/arduino-esp32#9378 in the numbers: the
transport still drops bytes, but the framing turns each loss into a skipped frame
instead of a corrupted run. Adalight would have flickered in random colours through
the frame after every one of those 10 events.

Those two runs are the whole argument for the UART env: same records, same decoder,
and the loss disappears with the port.

Two things learned on the bench. The CH9102F asserts DTR/RTS on open and this
board's auto-reset circuit is wired to it, so **opening the port reboots the ESP32** —
the counters have to be read in the *same* connection that streams, or a close and
reopen resets them to zero before you can look (`tmp/uart_stream.mjs` does exactly
that, and is why the first `bridge.js` runs appeared to show `frames=0`). And the
meta clamp is confirmed on both transports: `limitMa=8000` → `br=85/255`,
`limitMa=24000` → `br=255/255`.

Drop-safety was exercised directly (`tmp/verify3.mjs`): a frame one payload byte
short, immediately followed by a good frame, reported `disc=1 resync=1 rewind=1` and
the **next** frame still decoded — the rescan found the following magic inside the
record it had just rejected, which is exactly what `core/frame.js` describes.

## Radio off (`led_wall_s3_uart`)

The UART env turns the ESP32's radio off and keeps it off, so a streamed wall never
beacons or scans at all (wled/WLED#2698).

**Racing WLED does not work, and is measurably worse than doing nothing.**
`WiFi.mode(WIFI_OFF)` on its own does not hold: `WLED::handleConnection()` runs every
loop and re-inits the stack whenever it believes it is disconnected. Instrumented
with a `woff=` counter, the radio came back every ~9 s and the usermod took it down
again each time — and because a teardown blocks for far longer than the 8 KB RX ring
absorbs at 921600, every one of those events cost ~1000 bytes of the stream, seen as
a `resync` burst:

```
frames=91  disc=0  resync=0    woff=1
frames=109 disc=6  resync=1159 woff=2      <- WLED brought it back; the teardown overflowed the ring
frames=281 disc=12 resync=2027 woff=3
```

That is worse than leaving WiFi on, which measured lossless on this transport.

**Compiling the manager out is what works.** `handleConnection()` is the only caller
of `initConnection()`, so `setup.sh` applies a one-line patch to `wled00/wled.cpp`:
`handleConnection();` guarded by `#ifndef LED_WALL_WIFI_OFF`, against one anchor,
refusing to patch if that anchor is not found exactly once. With it gone nothing
re-inits the stack, so the single boot-time teardown holds. The same 20 s at 20 fps:

```
frames=400 meta=1 disc=0 resync=0 rewind=0 gaps=0 wifi=0 woff=1 state=live
```

`wifi=0` throughout, `woff=1` (off once at boot, never back), 400 of 400 frames. The
injected-fault run confirms drop-safety is intact: `disc=1 resync=1 rewind=1` across
300 good frames.

The cost is the web UI and OTA outright — no AP, no client, no `findWiFi`. The panel
config is baked in below, so a wall always driven by the wire loses nothing. Use
`led_wall_s3_usb` when the UI is needed.

## Panel defaults baked in

So a wiped config still lights correctly (values read out of the WLED config that
drove this panel before — firmware/README.md, "Panel identity"):

| setting | value |
|---|---|
| data pin | GPIO21 |
| length | 400 |
| LED type | `TYPE_APA106` (APA106/PL9823 RGB, id 27) |
| colour order | `COL_ORDER_BGR` |
| bus mA / channel | 20 (`LED_WALL_CHANNEL_MA`) |
| default limit | 8000 mA (`LED_WALL_DEFAULT_LIMIT_MA`) |

Brightness and the power clamp come from the `0xA4` meta frame, with the sketch's
arithmetic: `B_max = limit * 255 / (LED_COUNT * 3 * CHANNEL_MA)`, applied as
WLED's own brightness so the stream owns the wall.

## Deliberately not done yet

- **No network surface on the UART env.** The radio is off by design there, so
  anything that needs it — DDP, the app's `http` sink, OTA, the web UI — needs
  `led_wall_s3_usb` or a re-flash. That is the trade for a quiet, lossless stream.
- The usermod is the **v1** API (`wled00/usermod.cpp`) — the least machinery that
  can own `Serial`. If a settings page is ever wanted, move it to a v2 usermod and
  register it in `wled00/usermods_list.cpp`.
- No on-device status *query* yet (the sketch's `bridge.js --status` reads the
  sketch's format, not WLED's). The 1 Hz print above is the readback for now.

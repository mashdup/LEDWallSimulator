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

- **WiFi is left on** (so the UI still works to re-flash/reconfigure). For a
  streaming venue, turn it off — `-D LED_WALL_WIFI_OFF=1`, or WLED's AP/STA off.
  WiFi is the #2698 interference source; with it off the serial path is cleanest.
- The usermod is the **v1** API (`wled00/usermod.cpp`) — the least machinery that
  can own `Serial`. If a settings page is ever wanted, move it to a v2 usermod and
  register it in `wled00/usermods_list.cpp`.
- No on-device status *query* yet (the sketch's `bridge.js --status` reads the
  sketch's format, not WLED's). The 1 Hz print above is the readback for now.

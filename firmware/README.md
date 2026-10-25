# firmware/ — ESP32 pixel sink

The ESP32 is dumb on purpose. The browser fetches the banner, rasterises it,
applies effects, budgets the power, and streams finished frames. This sketch
decodes frames off the serial port and pushes pixels onto 400 APA106/PL9823
beads. It has no layout map, no effects, no knowledge of what a "picture" is.

Single file: `firmware.ino` — the name must match the directory, because Arduino
resolves a sketch as `<directory>/<directory>.ino`. A differently named file
makes every `arduino-cli` command fail with `main file missing from sketch`.

---

## Panel identity

The beads are **APA106/PL9823-class, not WS2812B**. Everything in this repo that
says "WS2812B" is an assumption made before the panel was lit, and it was wrong.
This section is the corrected record.

Established empirically on the real panel by sweeping WLED's chipset list. The
settings that render correctly:

| Setting | Value |
| --- | --- |
| WLED LED type | `APA106/PL9823 RGB` |
| Color Order | **BGR** |
| Length | 400 |
| Data pin (WLED rig) | GPIO21 |
| Supply | 20 A @ 5 V |
| Matrix (WLED rig) | 20×20, one panel, vertical, serpentine off |
| Panel flags (raw) | `v:1 s:0 r:0 b:0` |
The sketch's S3 default is GPIO17, but **this wall's data lead is on GPIO21** —
the pin WLED drove when the panel rendered correctly. Build with `-DPIN_DATA=21`.

What that implies:

- **The bit timing is not WS2812B's.** WLED cannot drive this part with its
  WS2812 type: its APA106 support is a dedicated RMT method. Per NeoPixelBus that
  method bit-times 350 ns / 1350 ns — a 1.7 µs period, ~588 kHz — against
  WS2812B's 400 / 800 ns at 1.25 µs (800 kHz). The bead decides a bit on its
  high-time, thresholding near 850 ns, so an 800 ns "1" reads as a 0 and a
  WS2812B signal decodes *partially*: the "lights up but flickers like static"
  seen at bring-up, and never reliably.
- **The sketch drives the panel itself, from the RMT.** The bit timing is generated
  in `firmware.ino`: 350 ns / 1350 ns at 20 MHz resolution, so both durations are
  exact tick counts (7 and 27). No LED library — `Adafruit_NeoPixel` has no such
  mode (its options are 1250 ns and 2500 ns per bit), and NeoPixelBus does not
  build on ESP32 core 3.x without patching. Channel order is one constant pair.
- **The order is BGR**, and it lives in one place: the `OFF_R`, `OFF_G`, `OFF_B`
  constants in `firmware.ino`. The protocol carries R,G,B; these beads want B,G,R,
  so that pair of constants is the only place a wrong order can hide.
- **Status: this sketch is the offline path and it works** — driven over Web Serial
  from the app, the wall renders solid and steady.

  One hard-won note: `rmt_new_tx_channel()` rejects a zero `trans_queue_depth` with
  `ESP_ERR_INVALID_ARG`. A zero-initialised config struct leaves it at 0, the
  channel stays null, and every frame is rendered and thrown away with **no counter
  to show it** — which is why the status line carries `rmt=`. If the wall is dark
  and the frame counters are healthy, look there first.

To re-verify on the bench: drive a **dense** frame (`all-red`) and look for a
uniform, steady colour. The self-test's own sparse patterns cannot show this
fault — a single lit dot leaves 1197 of 1200 bytes as zeros, and zeros decode
correctly under either timing. That is why it looked clean while a solid colour
did not.

## Wiring

3-wire panel: **5V, GND, data**. The data line is **spliced off the panel's
built-in controller** — the built-in controller is removed from the data line
entirely, not left dangling on it.

```
ESP32 3V3 ──────────────(logic only; NOT the panel supply)
ESP32 GPIO27 ──[level shifter]──► panel DATA (DIN of the first bead in the chain)
ESP32 GND ──────────────────────► panel GND   ┐
5V PSU (>= 12 A @ 5 V; this wall is on 20 A) ──┴─► panel 5V
```

Hard requirements:

- **Common ground.** ESP32 GND, panel GND and the 5 V supply GND must all be
  the same node. Without it the data edges are referenced to nothing and the
  wall flickers or latches garbage.
- **Level shift the data line — as margin, not a prerequisite.** The ESP32 is a
  3.3 V part, and these beads want `VIH >= 0.7 * VDD` = 3.5 V at a 5 V supply, so
  a bare GPIO -> DIN connection is 0.2 V short of spec. Observed on this panel:
  it renders correctly anyway once the ground is one clean node. Use a 1-channel
  translator (TXB0104 / SN74AHCT1G08 / a 2N7000 low-side inverter stage) if you
  see intermittent colour errors. Do **not** use a resistor divider: it slows
  the data rate (these beads bit-time 350/1350 ns, ~588 kHz).
- **Data into the FIRST pixel of the strip**, the end that the built-in
  controller used. The output of the last pixel is not connected to anything.
- **A decoupling cap (1000 uF or more) at the panel's 5 V input**, and keep the
  data run short and away from the power leads.
- **Feed the panel from a real 5 V supply — for brightness, not for function.**
  The ESP32's 3V3 pin does light the panel, visibly dim: 3.3 V is below these
  beads' 3.5 V minimum. It just cannot source a bright wall — 400 beads at full
  white is 400 x 3 x 20 mA = **24 A worst case**, ~12 A for a realistic
  full-white wall (WLED quotes 23 A for brightest white, ~8 A for most effects).

`PIN_DATA` defaults to **GPIO27**. Any GPIO works; GPIO27 is not one of the
strapping pins, so it is safe to probe at boot.

---

## Frame protocol

Baud **921600**, 8N1. Everything on the wire is fixed-size, self-clocking and
drop-safe. Mirrors `core/frame.js` byte for byte.

### Frame — 1203 bytes

| offset   | size | meaning                                    |
|---------:|-----:|:-------------------------------------------|
| 0        | 1    | `0xA5` frame magic                         |
| 1        | 1    | `seq` uint8, wraps 255 -> 0                |
| 2..1201  | 1200 | RGB triplets in **physical LED order**     |
| 1202     | 1    | `0x5A` frame end                           |

> `plan.md` prose says "Total 1204 bytes". The fields it lists sum to **1203**,
> and `core/frame.js` makes 1203 authoritative. The field list is what the sink
> counts, so the end byte lands at index 1202.

### Meta — 5 bytes

| offset | size | meaning                          |
|-------:|-----:|:---------------------------------|
| 0      | 1    | `0xA4` meta magic                |
| 1      | 1    | `brightness` uint8, 0..255       |
| 2..3   | 2    | `limitMa` uint16 **little endian** |
| 4      | 1    | `0x5A` frame end                 |

### Drop-safety rule

The sink renders the **last complete frame it saw**. A frame is complete when
(a) it started on a magic byte, (b) exactly 1200 payload bytes were read, and
(c) the end byte is `0x5A`. Anything else is discarded outright and the decoder
rescans for the next magic byte. **A partial frame is never rendered**, so a
dropped byte can never corrupt the wall.

`seq` is not a validity check. A lost frame is simply replaced by the next
complete one; a delta other than +1 is counted in `stats.seqGaps` so the host
can see that it dropped frames upstream. The subtraction is uint8 arithmetic,
so 255 -> 0 reads as +1 and a wrap is never a false gap.

---

## Receive state machine

Named states, byte at a time, no `readBytes()`, no timeout, no assumed
alignment. Chunking is irrelevant: a frame may arrive split across any number of
`Serial.read()` boundaries or in one gulp.

| state      | waiting for                                            |
|:-----------|:-------------------------------------------------------|
| `RX_IDLE`  | a magic byte. Everything else is noise (`stats.resyncs`) |
| `RX_SEQ`   | the seq byte after `0xA5`                              |
| `RX_RGB`   | 1200 payload bytes. A 1201st byte is never accepted    |
| `RX_END`   | `0x5A` at index 1202                                   |
| `RX_META`  | 4 bytes after `0xA4`, ending in `0x5A`                 |

Two recovery paths, both matching `core/frame.js`:

1. **Rescan a rejected record.** When the end byte is wrong, the record just
   consumed is scanned for a magic byte and replayed from there. A dropped byte
   makes the reader one byte short, so it swallows the *next* frame's `0xA5` as
   payload and the record ends on that frame's seq instead of `0x5A` — the magic
   you need is sitting in the buffer you just rejected. Without the rescan one
   lost byte costs a run of black frames; with it, it costs one frame.
   Scan window is identical to core's: the payload and the byte that failed the
   end check, never the magic or the seq. Replay is in-place and safe — the
   decoder writes `rxBuf` from index 0 while the replay reads it from index
   `k >= 0`, both advancing one byte per iteration, so the read index stays
   strictly ahead of the write index.
   `MAX_REWINDS` (default 8) budgets rescans per drain of the serial buffer, the
   same budget `core/frame.js` applies per `feed()`, so a payload stuffed with
   `0xA5` cannot make the rescan quadratic. Replay is one level deep: a bad end
   byte found during a replay is discarded but never rescanned again.

2. **Abort a truncated frame.** If bytes stop mid-frame for `PARTIAL_GAP_MS`
   (default 40 ms; a whole 1203-byte frame is ~13 ms of wire time at 921600 8N1)
   the rest of that frame is never coming. The partial is discarded and the
   machine goes back to scanning. No rescan here: that record holds only the
   truncated frame's own bytes, so any `0xA5` inside it is payload and replaying
   it would invent a frame that was never sent.

Measured over 3000 corrupt streams (7200 emitted frames, truncated frames, wrong
end bytes, junk between frames, identical chunking on both sides):

| decoder | frames recovered | partial frames rendered |
|:--------|-----------------:|------------------------:|
| forward-only resync | 7162 / 7200 | 0 |
| this sink (rescan)  | 7183 / 7200 | 0 |
| `core/frame.js`     | 7178 / 7200 | 0 |

The sim and the wall recover the same way, so a defect seen in the browser is a
real defect.

---

## Stale-frame watchdog

No complete frame for `STALE_MS` (default **1500 ms**) => the wall **fades to
black** over `FADE_MS` (400 ms) in `FADE_STEPS` (24) steps instead of freezing a
half-updated wall. The step index comes from elapsed time, so the ramp always
finishes in `FADE_MS` no matter how fast `loop()` spins.

`lastFrame` is kept intact throughout the fade, so the stream resumes at full
scale on the very next complete frame — no black gap after a hiccup. The fade is
a `WALL_LIVE -> WALL_FADING -> WALL_DARK` ramp; `stats.stale` counts the trips.

Why 1500 ms: the browser is the brain, so a stalled tab, a dropped WebSocket or
a paused dev server all look identical from the wall. A frozen frame is worse
than dark, because it looks like the wall is working.

**`STALE_MS=0` disables the fade**, and the wall then holds its last frame
indefinitely. That is what the panel runs in normal use, and the reason is the
paragraph above read backwards: from the wall's side, a host that merely stalled
is indistinguishable from one that died. Chrome throttles timers in a background
tab to ~1 Hz, and to once a minute after five minutes hidden, so a tab that is
not in front spends longer than `STALE_MS` between frames and the wall blinks
black every time. Measured here: an 18 s stream that stalled once reported
`stale=1`; the same stream with `STALE_MS=0` followed by six seconds of total
silence left `state=live` and `stale=0`, holding the last frame.

Keep the fade for the calibration pass, where a silent stream *should* be
obvious, and for anything driving the wall from a machine that might die.

---

## Power guard

`limitMa` from the meta frame is informational to the renderer but enforced
here as a brightness clamp. Arithmetic, per the shared power contract
(`WS2812_CHANNEL_MA = 20`):

```
worst case = every LED full white at brightness B
I(B)       = NUM_LED * 3 channels * CHANNEL_MA * B / 255
           = 400 * 3 * 20 * B / 255
           = 24000 * B / 255  ~= 94.12 * B  mA

=> B_max(limit) = floor(limit * 255 / 24000)

   limit   4000 mA -> B_max  42
   limit   8000 mA -> B_max  85      <- DEFAULT_LIMIT_MA
   limit  12000 mA -> B_max 127
   limit  18000 mA -> B_max 191
   limit  24000 mA -> B_max 255
   limit      0 mA -> B_max   0      (literal: no current allowed => wall dark)
```

`applyBrightnessGuard()` clamps `strip.setBrightness()` to
`min(wantBrightness, B_max(limitMa))`, so estimated current cannot exceed the
declared limit even if the browser asks for something it should not.

This is the **full-white bound**, so it is conservative: a real banner frame has
dark cells and draws less. `estimateFrameMa()` sums the actual channel values of
the frame on the wall and is reported by the status line, so you can compare the
real draw against the bound. Adafruit_NeoPixel applies gamma tables when scaling
by brightness, which pulls the effective channel value below the linear `B/255`
estimate — again on the safe side.

`limitMa == 0` is treated literally: brightness 0, wall dark. If you want no
limit, send a large `limitMa` (24000+ saturates at 255), not zero.

`DEFAULT_LIMIT_MA` (8000) applies until the browser sends a meta frame.

---

## Power envelope (measured on the wall, 2026-10-14)

The panel's built-in ribbon — not the supply — is the current ceiling. Probe
experiment: the last column alone at full white is *very bright* (1.2 A
reaches the far corner with voltage to spare), so the path is healthy; the
limit is cumulative I·R loss. Lighting white columns progressively, the
far-column probe dims at **5 columns ≈ 6–7 A total**, and the full-white
ramp knee sits near 42% ink (≈10 A average demand). Full white is 24 A at
20 mA/channel and is unreachable: br above ~100 buys heat, not light.

Supplies tried: 20 A and 40 A — **no difference**, which is what identifies
the ribbon as the constraint. The ribbon ran cold to the touch, and the
page's 8000 mA default keeps the estimator's margin just above the collapse
zone, so it stays the default. If brightness ever needs to grow, the move
is a second power pair to the far corner (additive, same bus): the probe
proves the far end takes full voltage at low current, so dual injection
should roughly double the envelope.

## Self-test (`-D SELFTEST=1`)

**Calibrated 2026-10-14 (milestone 5, complete).** WALK + INDEX_MAP read off
the live panel: strips are **columns**, each running **top→bottom**, every
column restarting at the top (**not serpentine**), advancing **left→right**;
index 0 top-left, 399 bottom-right. `core/layout.js` now defaults to
`stripAxis: 'y'`, `snake: false`, no flips — `index = 20·col + row` — and a
logical top-left "F" streamed through that layout lands upright on the wall.

Milestone 5: layout calibration. Patterns address **physical LED indices** — the
firmware has no layout map, `core/layout.js` owns that. That is exactly what
makes them useful: what you see on the wall is the raw physical order, and the
browser's "what the wall actually sees" preview should match it.

| pattern         | what it does                                   | what it tells you |
|:----------------|:-----------------------------------------------|:------------------|
| `ALL_RED`       | every LED full red                             | no dead pixels, no brownouts |
| `COLUMN_SWEEP`  | LEDs where `index % 20 == c`, sweeping c       | snake direction, strip boundaries |
| `WALK`          | one white LED, index 0..399                    | reads the physical order off the wall |
| `INDEX_MAP`     | `R = 20+12*(i/20)`, `G = 20+12*(i%20)`, `B = 30` | every LED identifiable; calibrate `snake` / `flipX` / `flipY` / `transpose` against `core/layout.js` |

`INDEX_MAP` prints its colour legend to the serial console. A complete frame
from the browser ends the self-test immediately (`selftest: stopped by host
frame`), so you can leave the flag on during bring-up.

---

## Status line

Every `STATUS_INTERVAL_MS` (1000 ms) unless `-D STATUS=0`:

```
wall seq=137 br=85/85 est=4210mA cap=8000mA limit=8000mA state=live rx=0
frames=412 meta=3 disc=1 resync=20 rewind=1 gaps=0 stale=0
```

`rewind=` is the number of discarded records that were rescanned and replayed —
the recovery counter for the rescan path above. During the calibration pass,
watch `disc`/`rewind`/`gaps` together: `rewind` climbing with `disc` means the
serial link is dropping bytes; `gaps` climbing with `disc == 0` means the browser
is dropping frames before it sends them.

---

## Build and flash

Requires the **ESP32 core for Arduino**. No LED library: the sketch generates the
panel's bit timing from the RMT directly, because nothing in the library ecosystem
can express it (see "Panel identity" above).

Verified on this machine with `arduino-cli 1.5.1` and `esp32:esp32 3.3.12`.

```sh
arduino-cli core update-index
arduino-cli core install esp32:esp32

# verify it compiles
arduino-cli compile --fqbn esp32:esp32:esp32 firmware

# wiring self-test build
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --build-property "compiler.cpp.extra_flags=-DSELFTEST=1" \
  --build-property "compiler.c.extra_flags=-DSELFTEST=1" \
  firmware

# flash, then watch the status line
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM5 firmware
arduino-cli monitor --fqbn esp32:esp32:esp32 -p COM5 -b 921600
```

Run from the repo root (`firmware` is the sketch directory). Replace `COM5` with
your port (`arduino-cli board list` shows it). On Linux the port is usually
`/dev/ttyUSB0` or `/dev/ttyACM0`.

Custom pin / watchdog / limit — pass the `-D` flags through
`compiler.cpp.extra_flags` (and `compiler.c.extra_flags`), **not**
`build.extra_flags`:

```sh
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --build-property "compiler.cpp.extra_flags=-DPIN_DATA=26 -DSTALE_MS=2500 -DSELFTEST=1" \
  --build-property "compiler.c.extra_flags=-DPIN_DATA=26 -DSTALE_MS=2500 -DSELFTEST=1" \
  firmware
```

> `build.extra_flags` is the ESP32 core's own slot: setting it replaces
> `-DESP32=ESP32` and the rest of the core's flags, and Adafruit_NeoPixel then
> fails with `#error Architecture not supported`. The `compiler.*.extra_flags`
> slots are additive and are the ones to use.

`NUM_LED` is frozen at 400 by the protocol — `static_assert(NUM_LED * 3 == 1200)`
fails the build if you change it, because the frame payload is 1200 bytes.

### ESP32-S3 boards

Tested on an **ESP32-S3 DevKitC-1**. `esptool flash-id` reports **16 MB of flash**
(manufacturer `0x68`, device `0x4018`, quad, 3.3 V); this file said N8R8/8 MB for
months and that is wrong, which matters the moment anyone flashes a merged image
built for a different size. Its CH9102F UART bridge is `VID_1A86&PID_55D3` and its
own USB-OTG is `VID_303A&PID_1001`; the cable has been in the **USB-OTG** port,
which enumerates as COM6 on this machine. Two things differ from the classic
ESP32, and each produces a wall that does nothing while every command reports
success:

1. **GPIO27 is a flash pin on the S3, and the beads are on 21.** GPIO26–32 are
   the SPI flash interface — GPIO27 is `SPIHD` — so the classic ESP32's data pin
   drives the flash chip on this board. The sketch therefore defaults to 27 on
   the classic target and **21 on the S3** (`CONFIG_IDF_TARGET_ESP32S3` selects
   the branch).

   **21 is measured, not chosen.** It is the pin the beads are actually wired
   to, read out of the WLED config that was driving this panel before this
   sketch took the board over: `hw.led.ins[0].pin = [21]`, next to `type: 27`
   (APA106/PL9823 RGB) and `order: 4` (BGR, which is what `firmware.ino`'s
   `OFF_R/OFF_G/OFF_B` already implements). 17 is equally free on the S3 and was
   this file's original advice, but nothing is wired to it: a pin-17 build leaves
   the wall dark while the decoder reports `frames` climbing, `disc=0`,
   `resync=0`, `rmt=1` and non-zero `est` — healthy counters and no light, which
   reads as a driver fault and is not one.

   On this module the free set is 1–18, 21, 38–42, 47, 48. Avoid: 26–32 flash,
   **33–37 octal PSRAM** (live on an R8 module), 43/44 UART0 to the CH9102F,
   19/20 USB D-/D+ (dead the moment you enable USB-CDC), 0/3/45/46 strapping.

   GPIO48 is the onboard WS2812 — the core's own variant says
   `#define PIN_RGB_LED 48` — so it is the bring-up pin: the self-test is
   visible with nothing wired. Do not use it for the panel. The variant header
   carries a warning about it: *"Some boards have too low voltage on this pin
   (board design bug) — Use different pin with 3V"*. These beads need
   `VIH ≥ 0.7 × VDD` = 3.5 V, so a pin the core flags as marginal is the last
   place for that margin, and it is also pixel 0's net.

   Bring up on 48, splice the panel, then drive it on 21.

   **A dark wall with healthy counters means the pin, not the driver.** Read it
   back from whatever was driving the panel before (`curl http://<wled-ip>/json/cfg`,
   `hw.led.ins[0].pin`) instead of trusting this file: the pin WLED lit the beads
   on IS the wiring. The firmware prints `sink ready pin=...` once at boot. It
   also reports `rmt=1` in its status line whether or not anything is wired to
   the pin, so that flag proves the RMT channel exists, not that it reaches the
   beads.

2. **`CDCOnBoot` must match the USB port the cable is in.** The board has two:
   the CH9102F UART bridge (`VID_1A86`, on **UART0**) and the S3's own USB-OTG
   (`VID_303A&PID_1001`). They enumerate as different COM ports, and Windows may
   renumber between them — a board that was COM8 comes back as COM6 when the
   cable moves.

   - Cable in the **UART** port: `CDCOnBoot=default` (disabled), so `Serial` stays
     on UART0 where the CH9102F can hear it.
   - Cable in the **USB-OTG** port: `CDCOnBoot=cdc`, so `Serial` moves to the USB
     peripheral.

   Get it wrong and the wall does nothing while every command reports success:
   the upload verifies, the sketch runs, and every byte goes to the other port.
   `--status` then reads nothing, and the ROM banner is invisible too, which
   looks exactly like a hung sketch. It cost an hour chasing a driver fault that
   was really this setting not matching the cable.
3. **`arduino-cli upload` rejects `--build-property`.** It recompiles from
   scratch with the sketch's defaults, so it flashes a GPIO27 build and exits
   0. Compile to a known directory, then flash that directory:

```sh
PIN=21                     # 48 for bring-up on the onboard LED, 21 for the panel
STALE=0                    # 0 = hold the last frame (a display); 1500 = fade
FQBN="esp32:esp32:esp32s3:FlashSize=8M,PSRAM=disabled,CDCOnBoot=cdc,UploadMode=default"
arduino-cli compile --fqbn "$FQBN" --build-path build \
  --build-property "compiler.cpp.extra_flags=-DPIN_DATA=$PIN -DSTALE_MS=$STALE" \
  --build-property "compiler.c.extra_flags=-DPIN_DATA=$PIN -DSTALE_MS=$STALE" \
  firmware

# esptool is not on PATH; the core ships it under the Arduino15 tools dir
ESPTOOL="$LOCALAPPDATA/Arduino15/packages/esp32/tools/esptool_py/5.3.1/esptool.exe"
"$ESPTOOL" --chip esp32s3 --port COM6 --baud 921600 write_flash @build/flash_args
```

> **Flashing someone else's merged image (WLED, etc.) is not the same job.**
> `write_flash 0x0 image.bin` replaces the bootloader and partition table too, so
> it cannot be undone by re-flashing this sketch's app region alone — and a build
> for the wrong flash size or PSRAM type boots into
> `SHA-256 comparison failed: ... Attempting to boot anyway...` followed by a
> TG0WDT reset loop, which looks like a dead board. `esptool` still reports
> "Hash of data verified", because it verifies with the same parameters it wrote.
> Check the part first with `esptool flash-id`, then use the project's own
> installer (WLED's web installer at install.wled.me works over Web Serial and
> picks the variant itself). Recovery is always this sketch: flashing
> `build/flash_args` rewrites all four regions and the board comes straight back.

`CDCOnBoot=default` is the menu key for **Disabled** — the value is the key,
not the label, so `CDCOnBoot=disabled` is rejected as an invalid option.

Use `build/flash_args` rather than typing addresses: it carries the S3's own
layout, where the bootloader lands at `0x0` and not the `0x1000` the classic
ESP32 uses. Confirm the `-D` flags reached the compile before flashing:

```sh
node -e "const j=JSON.parse(require('fs').readFileSync('build/compile_commands.json','utf8'));
const r=j.find(e=>(e.file||'').includes('firmware.ino.cpp'));
console.log((r.arguments||[]).join(' ').match(/-D(PIN_DATA|SELFTEST|ARDUINO_USB_CDC_ON_BOOT)=\S*/g));"
```

Expect `-DPIN_DATA=17`, `-DSELFTEST=1`, `-DARDUINO_USB_CDC_ON_BOOT=0`.

### Host side

Two ways to get bytes **to the serial port** — and a third that skips the sketch
entirely:

1. **Web Serial straight from the page** — `web/sinks.js` `SerialSink`
   (`sink = serial` in the UI). Works at 921600 on `http://localhost` /
   `https://` only (secure context), and it caps frames in flight at
   `MAX_IN_FLIGHT = 2` because Chromium's serial writer gives no flow control
   and the ESP32 UART ring buffer is ~4096 bytes.
2. **`tools/bridge.js`** — the Node side of the same protocol, for when you
   want the wall driven from a terminal instead of a browser tab. `serialport`
   is the only non-builtin in the toolchain.

   ```sh
   node tools/bridge.js --list                       # what is plugged in
   node tools/bridge.js --port COM5 --cycle          # the four calibration patterns
   node tools/bridge.js --port COM5 --status         # read the device's own report
   node tools/bridge.js --port COM5 --status --duration 0   # ...and keep watching
   ```

   Without `--port` it drives `VirtualWall` — `loop()` of this sketch written in
   JS, same decoder, same guard, same watchdog — which is what makes the
   calibration pass reheasurable with no hardware in the room, and what
   `test/bridge.test.js` asserts against. `--preview` prints the wall as ASCII
   through the layout you are calibrating; compare it with what the panel
   actually lights and `core/layout.js` answers itself.

   A static pattern (`all-red`, `index-map`) is re-sent every
   `STATIC_REFRESH_MS` (500 ms, a third of `STALE_MS`) while it holds. The flashed
   self-test can paint one once and leave it, because nothing inside the sketch
   will fade it; a host-driven frame is under the watchdog, so one frame followed
   by a long sleep is a 1.5 s flash and then black.

   A **still wall is not re-sent frame by frame.** Both drivers send when the
   bytes change, and otherwise only every `STATIC_REFRESH_MS`, so a held image
   costs ~2.4 KB/s instead of 36 KB/s while the watchdog stays fed. Skipping also
   skips the sequence number, so a still wall reports no phantom seq gaps. A sink
   that connects to an image which is not changing still gets it pushed once —
   without that it would show whatever the panel already had.

   `--status` on a real port reads for 5 s and exits; `--duration 0` watches
   forever. A serial port has no clock of its own, so an unbounded read is a
   process that never terminates — piped into `tail`, that is indistinguishable
   from a hang, because the device prints at 1 Hz and the pipe buffers the rest.

The page's sinks today are `sim`, `broadcast`, `serial`, `adalight` and `http`
(`SINK_KINDS` in `web/sinks.js`). `serial` speaks this repo's own 1203-byte
protocol to the sketch; **`adalight` speaks WLED's** (below); `http` hands the
records to the dev server, which forwards them as DDP.

**Serial straight to WLED (Adalight).** WLED also takes Adalight frames on its
serial port, so a stream can reach the beads through WLED's Apa106 method with no
DDP, no sketch and no level shifter. Three things, all measured on this panel:

**WiFi starves the serial path — disable it.** WLED's own issue tracker
(wled/WLED#2698) reports Adalight-over-serial glitching *"in random colours"* and
traces it to *"interference by wifi activity, proportional to traffic to/from
WLED"*, with **disabling WiFi on the ESP as the workaround**. Reproduced here:
streaming 400 LEDs at a fixed 16 frames/s, WLED refreshed 12 fps with a quiet
network and **8 fps** while the HTTP API was polled 20 times a second. The frames
that lose the race are dropped, and Adalight has no resync, so every pixel after
a dropped byte is wrong — flicker in random colours, at any frame rate.

So: for a streamed wall, turn WLED's WiFi off (or never join it), and do not touch
its web UI or API while streaming. That costs the HTTP API — drive it over the
serial port, which is the point of this route anyway. The default `115200` baud is
also only good for *"about 50-100 LEDs"* per WLED's serial docs; this panel has
400, so raise it under Sync settings. Neither is advisory here.

**The header count is `LED_COUNT - 1`.** WLED's parser does `count += next + 1`
while reading the two count bytes and then consumes exactly `count` pixels, so the
Adalight header carries one less than the LED count. Send the raw count and WLED
reads one pixel past the payload, swallowing the next frame's first three header
bytes; that frame loses sync and is discarded whole. Every byte of a frame that
does sync is then perfectly correct — which is why a strip readback says the
stream is clean while the wall flickers.

**Do not run this route over the S3's USB-CDC port.** Measured here: solid green
at 15 fps for 40 s, a quiet network, nothing else attached and WLED's own output
off — it still glitched. That matches espressif/arduino-esp32#9378, *"[HWCDC]
Missing data via USB Serial on C3/C6/S3"*, which reports the S3 losing bytes on
its native USB serial. WiFi makes it worse (above); association alone is enough.

Adalight has no resync, so a dropped byte corrupts the rest of that frame *and* the
frame after it. Both USB attempts on this panel — the Node probe and the browser's
`adalight` sink — glitch for that reason. It is a platform fault, not a framing
one: the header count and checksum are now verified correct against WLED's parser,
and every frame that does arrive syncs byte-perfect (which is exactly why the
strip readback keeps looking clean while the wall flickers).

**Use DDP over the network instead.** It is measured clean on this wall — 42
frames, 0 dropped, a smooth sweep, and a smooth scrolling banner through the app's
`http` sink. `AdalightSink` is kept rather than deleted: the framing is right, and
this route becomes viable the moment the transport is a real UART (the board's
CH9102F port — unverified, and WLED's S3 build may keep `Serial` on USB-CDC
regardless) rather than USB-CDC.

**The offline serial route is now built, and the UART transport is clean —
`firmware/wled-custom/`.** WLED keeps its Apa106 output and gets the repo's own
`0xA5`/`0xA4` framed sink, with the resync `core/frame.js` already specified, so a
lost byte costs one frame instead of a corrupted run. `Serial` can be put on the
CH9102F UART or on the S3's own USB-OTG; same firmware, same records, and the byte
loss tracks the port. Measured on this panel: over the UART **400 of 400 frames at
20 fps, `disc=rewind=gaps=0`**, and over USB-OTG 305 sent / 295 decoded with 10
lost-byte events, every one self-healed and no frame corrupted. The UART env also
silences the radio, since that is wled/WLED#2698's interference source — but WLED's
connection manager brings it back every ~9 s and each teardown costs ~1000 bytes of
stream, so it is compiled out rather than raced. See that directory's README.

The page can do this itself: **Sink → `Web Serial → WLED (Adalight)`**.
`AdalightSink` wraps each frame record's 1200-byte payload in WLED's header —
`'A' 'd' 'a'`, the LED count minus one, and `hi ^ lo ^ 0x55` — for 1206 bytes on
the wire, and drops meta records, which WLED has no field for. The framing is
correct and tested; on this board the *transport* is what fails, so treat this as
available but not recommended, and prefer `http` (DDP) above.

**Running this with no network at all — a venue, a party.** The wall needs no
internet and no router; it needs a link between the laptop and the ESP32, and WLED
provides one itself. Set **AP Behaviour → Always** (Config → WiFi Setup) so its
access point comes up regardless of any saved network, then:

1. **join `WLED-AP`** from the laptop — `192.168.4.1` by default, the value in
   the config's `ap.ip` — and put WLED's output **off** (realtime needs that).
2. **start the dev server pointed at the AP:**
   `node tools/serve.js --port 8080 --ddp 192.168.4.1`
3. **open `http://127.0.0.1:8080/`** and set
   **Sink → `HTTP → dev server → WLED (DDP)`** → Connect.

Everything the app needs is on loopback — the page, the renderer, the socket — so
only the DDP datagrams leave the machine, and they only have to reach the ESP32.
This is the configuration to take to a venue: no cable, no infrastructure, and the
one path measured clean on this panel (42 frames, 0 dropped, smooth sweep, smooth
banner). Note it is also unaffected by the WiFi/serial problem above, because it
*is* the WiFi path rather than a serial one riding alongside it.

- **WLED's own output must be off.** Realtime replaces the strip buffer per
  frame but does not suspend the renderer, so a running effect keeps repainting
  between frames and shows through as colour that tracks your frames. That reads
  as a stream fault and is not one; with the output off the panel follows the
  stream exactly.
- **Baud is meaningless on a USB-CDC port.** The S3's own controller presents
  such a port, and the same query answered identically at 115200, 230400, 460800,
  921600 and 1500000. `0xB5` (WLED's "switch to 921600") is a no-op there. Never
  diagnose a USB-CDC link by its baud setting — and note `0xB5` *is* sticky on a
  real UART until the next reboot.
- **Serial queries are only answered while the output is off.** With the strip
  running, `'l'` (JSON) and `'L'` (tpm2 packet: `c9 da`, 4 header bytes, then
  1200 bytes in wire order) both return nothing. Reading the buffer back means
  stopping the stream and querying before WLED's output resumes, which is what
  makes a byte-level check of a stream awkward rather than routine.

**DDP straight to WLED** — `node tools/bridge.js --ddp <wled-ip>` streams the same
frozen frame records over UDP. This is the *proven* path for this panel: WLED
drives the beads with its own Apa106 RMT method, which is what actually works
here, so the sketch is not in the loop at all — no serial port, no level shifter,
no cable. `--brightness` is applied host-side because DDP carries no brightness
field, and the port defaults to 4048 (`<host>:<port>` overrides it; check WLED's
own realtime port setting if nothing lands).

**Do not use WLED's `live` field to check this.** It does not reflect DDP or
DRGB reception. Measured here: a JSON API packet written over the same UDP socket
landed correctly while `live` stayed absent the whole time. A dense frame and
your eyes are the only reliable readback. Also note that two streams at once
flicker the wall between their brightnesses — that is a sign both are landing,
not a fault.

**One connected page at a time.** Every connected page posts its own frame
stream to the server, and the server forwards them all, so two tabs interleave
two different videos and the wall flickers between them. That is not a
stuttering transport — it is two writers. Disconnect or close every other tab
driving the wall before judging a stream, and remember that a headless capture
(`tools/bridge.js --page`) counts as one.

**Leave WLED's own UI alone while streaming.** Any state change from outside
realtime — a slider, a preset, the phone app, an API write — sets WLED's
`realtimeOverride`, and its realtime handler then discards incoming frames
(`if (realtimeOverride) return;` in `udp.cpp`). It only clears when realtime
*times out*, and a continuous stream prevents that timeout, so a stray tap can
silently block the wall until the stream is stopped and restarted. Looking at
the page at 192.168.1.118 is harmless — reads do not touch it. Do not *change*
anything there while a stream is running.

**Localising an output fault.** No counter on the device can see whether light
comes out, and `est`/`state=live`/`rmt=1` are all satisfied by a sketch that
decodes frames perfectly onto a pin connected to nothing. The only test that
splits "the bytes are wrong" from "the beads are not listening" is to send one
channel at a time and look:

```sh
node tools/channels.js COM6
```

It steps RED, GREEN, BLUE, WHITE, OFF, then repeats red and blue, three seconds
each, over a solid field — while printing the device's `frames`, `seq`, `disc`,
`rewind`, `gaps`, `state` and `boots` on the same port. Read both at once:
counters climbing with a colour missing localises the fault to that channel's
mapping or its output stage; counters climbing with **nothing** on the panel
means the data line is not on `PIN_DATA` at all.

Measured with it: 454 frames across all seven phases, `disc=0 rewind=0 gaps=0`,
`state=live`, `boots` unchanged — so a host stream does not crash this sketch and
the decoder keeps up. That is what cleared the firmware of a crash-reset theory
for a panel that went dark mid-session.

**A flat field is the discriminator between "the bytes are wrong" and "the beads
misread bits".** Send a solid colour and the host sends the *same 1200 bytes every
frame*. Nothing about the content can be at fault — no rasteriser, no desync, no
torn frame, no dropped byte, no effect repainting — because the data does not
change. If runs of beads still show colours nobody asked for, the fault is on the
beads' side of the pin. That is the whole test, and it costs one command:

```sh
node tools/bridge.js --pattern all-red --port COM8 --duration 45000
```

**Measured on this panel, mac only: a static red field grows runs of green beads.**
Every frame was byte-identical and every frame decoded — `wrote 29/s, decoded 29/s,
disc=0 resync=0 rewind=0` across four 45 s flat fields (white, red, black, grey) and
four 30 s brightness steps — and the wall still showed green runs at fixed columns,
some flickering. A bead that misreads a *bit count* latches its colour from the
wrong slice of the stream and passes the rest downstream shifted, so the fault
travels as a **run** of beads — which is what a "column" of the 20x20 matrix is.

**The colours say how many bits are being dropped, because the shifts are
byte-aligned.** In this wall's BGR order a red bead is `B=0x00 G=0x00 R=0xFF`, and a
bright green needs `G=0xFF` — the red byte landing in the green slot, i.e. **one
byte late**. A blue bead is `B=0xFF G=0x00 R=0x00`, and blue showing **red** needs
**two bytes late**. Measured on the wall: a blue field grew red pixels, a red field
grew green ones, at fixed positions, some flickering.

**The colours also say what triggers it: the low runs.** At this sketch's 350/1350 ns
(1.7 us) bit, the longest low run in a flat field is 16 consecutive zeros for red and
blue — **27.2 us** — against a latch-reset window in the 30 us region for these
beads. White is 24 ones and has **no low run at all**; grey `#555555` (`01010101`)
maxes out at **1.7 us**; black is 24 zeros, **40.8 us**, over the window — and
invisible, because a shifted zero is dark. So:

- **Power is ruled out, not assumed.** Flat white draws **8.0 A** at the app's
  settings and **18.4 A** when the limit is raised, and was steady at every step
  while 1766 records decoded with `disc=0 resync=0`. Flat red draws **2.7 A** and
  broke. A sag does not get worse as the load drops by a factor of three.
- **Brightness is ruled out by the same logic, and by the beads' own protocol:**
  APA106 carries global brightness in a separate word, so the *colour bytes* —
  and therefore the low runs — do not change with brightness at all. The white
  ladder was clean at 1.9 A through 18.4 A.
- **Content-dependence is the pattern, not the drawing:** red and blue (16 zeros)
  break, white and grey do not, positions sit at fixed beads, and the affected set
  moves as the content's bytes change. A 3 us margin against a reset window is
  exactly the margin a host's ground offset and a data line 0.2 V short of `VIH`
  can eat — which is why the same wall is steady on an earthed desktop and breaks
  on the mac, and why four cables changed nothing.

So the fix is the margin, in this order:

1. **Level-shift the data to 5 V** — the Wiring section above prescribes exactly
   this for "intermittent colour errors": a TXB0104, SN74AHCT1G08 or a 2N7000
   low-side stage. `VIH >= 0.7 x VDD` = 3.5 V at 5 V; a bare GPIO is 3.3 V, and
   0.2 V of spec deficit is the whole budget here. ~300 ohms in series at the
   first bead damps the ringing that starts a false reset on a long low.
2. **Bond the panel PSU's 0 V to the ESP32's GND at ONE node** — the first hard
   requirement above; a floating reference spends the same margin.
3. **A USB isolator (ADuM3160 module)** if the fault must stop following the host:
   it passes the data and breaks the ground path entirely, which is the difference
   between the desktop and the laptop. A **self-powered hub is not that test** —
   it takes the host's 5 V away and leaves the ground continuous, and measured
   here it changed nothing.
4. **Free confirmation, no parts**: trim the PSU to **4.5 V**. `VIH` scales with
   VDD, so 3.15 V puts the ESP32's 3.3 V *inside* spec. If the runs go on red, the
   margin story is confirmed. Do not go below ~4.0 V; the beads' own floor is near
   there, and check the meter — 5.3 V maximum for these beads.

Do **not** shorten the bit period chasing this: 1.7 us -> 1.25 us would put 16 zeros
at 20 us, and these beads are explicitly not WS2812B-timed — `WS2812B signal
decodes *partially*` (Wiring above) is this same fault, seen from the other side.

**The strip's refresh sets a hard ceiling of ~49 frames/s.** 400 APA106 beads are
30 bits each at a ~1.7 µs bit, so one refresh is ~20 ms of wire. Measured on this
wall, streaming the repo's own records: 30, 42 and 45 fps decode perfectly
(`disc=0 resync=0 gaps=0`, `decoded == written`); at **60 fps** the stream
 collapses — ~36 of 57 frames/s decoded, `disc~10/s`, `gaps~10/s` and
**1000-4000 `resync`/s**, which is the decoder drowning in the middle of frames.
Nothing may stream this wall faster than ~45 fps, and the app's fixed 30 fps is the
right number, not a conservative one. `node tools/flicker.js` is the measurement:
it streams at a chosen rate and prints the board's counter deltas in the same second.

```sh
node tools/flicker.js --fps 45      # clean
node tools/flicker.js --fps 60      # collapse: 36 of 57 decoded, resync in the thousands
node tools/flicker.js --fps 42 --pace burst --burst 3
```

**`torn=` is the counter for the one host-visible version of that fault** (the
`wled-custom` rig; the sketch has no such field). The realtime pixels *are* the
buffer a transfer reads, so painting the next frame while the previous one is still
clocking out hands the beads a frame made of two frames — a run of beads in the next
frame's colours, self-correcting at the next refresh, invisible to every host
counter. **Whether that window exists on this board is what the counter measures,
not what it assumes**: this rig's notes and the enlarged RX ring say `strip.show()`
blocks for the transfer, in which case the branch never fires and `torn` sits at 0
forever; NeoPixelBus's RMT methods post a DMA transfer and report busy until the ISR
reaps it, in which case the window is ~20 ms wide and a bursting host (USB-CDC
delivers a whole frame at once, where a 921600 UART paces one per ~13 ms) lands
inside it. `commitFrame()` checks `strip.IsUpdating()` and skips the paint, so the
newest frame lands one refresh late rather than partly — one comparison either way.
Read it as a measurement: `torn` climbing says the host is bursting and the path is
real; `torn=0` with a flicker on a flat field says the fault is electrical and no
firmware change will move it.

---


## Compilation status

**Compiled and flashed on this machine.** `arduino-cli 1.5.1` +
`esp32:esp32 3.3.12` + `Adafruit NeoPixel 1.15.5`.

Classic ESP32 (`--fqbn esp32:esp32:esp32`):

```
default (PIN_DATA=27)                                    : 291749 B flash (22%), 25332 B RAM (7%)
SELFTEST + -DSTALE_MS=800 -DMAX_REWINDS=4 -DDEFAULT_LIMIT_MA=6000
                                                         : 292837 B flash (22%), 25340 B RAM (7%)
```

ESP32-S3 (`esp32:esp32:esp32s3:FlashSize=8M,PSRAM=disabled,CDCOnBoot=default`,
`-DSELFTEST=1`, **no `-DPIN_DATA`** — the default is 17): 306378 B flash (23%),
24664 B RAM (7%). Byte-identical size to the explicit `-DPIN_DATA=17` and
`-DPIN_DATA=48` builds, as expected for a literal.

Zero warnings from the sketch itself; the `static_assert` protocol checks pass
in every build.

**Verified on real hardware** — ESP32-S3 DevKitC-1, COM8 at 921600, self-test
build with **no `-DPIN_DATA`**, one lit LED per frame so the draw stays in tens
of mA:

| check | observed |
|:------|:---------|
| boot | `sink ready pin=17 leds=400 baud=921600 frame=1203B limit=8000mA br=85` — the S3 default, resolved on the board |
| self-test | `ALL_RED` → `COLUMN_SWEEP` → `WALK` → `INDEX_MAP` cycling, status line at 1 Hz |
| 86-frame 30 fps stream | `frames=173 disc=0 resync=0 rewind=0 gaps=1 stale=1`, host `dropped=0 errors=0` |
| power guard | `limit=4000` → `br=42/42`; `limit=24000` → `br=255/255` |
| watchdog | stream stopped → `state=dark`, `stale` climbed to 2 |

Not verified: anything that needs the panel itself. The data line is not yet
spliced to the board. The board is currently flashed with the S3 default,
**GPIO17**, so the self-test runs dark — GPIO17 drives nothing. To watch
bring-up with nothing wired, build `-DPIN_DATA=48` (the onboard WS2812),
confirm the patterns light, then rebuild with no `-DPIN_DATA` and splice.

The boot banner is one-shot from `setup()`, so `--status` (which attaches after
reset) never shows it. Pulse EN over RTS with DTR deasserted — the same
auto-reset circuit esptool uses — and read from boot.

Flashing found one real bug: the takeover announcement in `commitFrame()` was
unguarded, so every received frame printed `selftest: stopped by host frame` —
40 lines in a 4 s run, burying the status line. The JS mirror already had the
`if (selftestActive)` guard; the sketch had drifted from it.

Verified before the compiler was available:

- Brace/parenthesis/`#if`/`#endif` balance across the whole sketch (56/56,
  333/333, 29/29), no `TODO`/placeholder/pseudocode bodies.
- The decoder, watchdog, power clamp and self-test scheduling were ported
  verbatim to a throwaway Node harness and run differentially against the real
  `core/frame.js` encoder and `FrameDecoder`: 33 checks, all passing — 300-frame
  clean stream with `seq` wrapping 255 -> 0, garbage before magic, wrong end
  byte, magic-valued payload bytes (`0xA5`/`0xA4`/`0x5A` inside the payload),
  every chunk size 1..4096, truncated frame followed by a complete one, meta
  clamp table, watchdog fade at 1/7/13/33 ms loop rates, a 10 s 30 fps stream
  with no watchdog trip, 3000 pristine streams and 3000 corrupt streams.
- No dynamic allocation in the decode or render path: one static receive buffer,
  one static copy of the last complete frame, one static `Adafruit_NeoPixel`.
  No `new`, no `malloc`, no `String`, no `std::vector`, nothing per frame.

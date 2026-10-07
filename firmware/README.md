# firmware/ — ESP32 pixel sink

The ESP32 is dumb on purpose. The browser fetches the banner, rasterises it,
applies effects, budgets the power, and streams finished frames. This sketch
decodes frames off the serial port and pushes pixels onto 400 WS2812B. It has
no layout map, no effects, no knowledge of what a "picture" is.

Single file: `sketch.ino`.

---

## Wiring

3-wire panel: **5V, GND, data**. The data line is **spliced off the panel's
built-in controller** — the built-in controller is removed from the data line
entirely, not left dangling on it.

```
ESP32 3V3 ──────────────(logic only; NOT the panel supply)
ESP32 GPIO27 ──[level shifter]──► panel DATA (WS2812B DIN, first pixel of the strip)
ESP32 GND ──────────────────────► panel GND   ┐
5V PSU (>= 12 A @ 5 V for a full-white wall) ──┴─► panel 5V
```

Hard requirements:

- **Common ground.** ESP32 GND, panel GND and the 5 V supply GND must all be
  the same node. Without it the data edges are referenced to nothing and the
  wall flickers or latches garbage.
- **Level shift the data line.** The ESP32 is a 3.3 V part. WS2812B wants
  `VIH >= 0.7 * VDD` = 3.5 V at a 5 V supply, so a bare GPIO27 -> DIN connection
  is marginal-to-broken. Use a 1-channel translator (TXB0104 / SN74AHCT1G08 /
  a 2N7000 low-side inverter stage). Do **not** use a resistor divider: it
  slows the ~800 kHz data rate.
- **Data into the FIRST pixel of the strip**, the end that the built-in
  controller used. The output of the last pixel is not connected to anything.
- **A decoupling cap (1000 uF or more) at the panel's 5 V input**, and keep the
  data run short and away from the power leads.
- **Feed the panel from a real 5 V supply, not the ESP32's 3V3 pin.** 400
  WS2812B at full white is 400 x 3 x 20 mA = **24 A worst case**, ~12 A for a
  realistic full-white wall. The board cannot source that.

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

## Self-test (`-D SELFTEST=1`)

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

Requires the **ESP32 core for Arduino** and **Adafruit NeoPixel**.

Verified on this machine with `arduino-cli 1.5.1`, `esp32:esp32 3.3.12`,
`Adafruit NeoPixel 1.15.5`.

```sh
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install "Adafruit NeoPixel"

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

### Host side

Two ways to get bytes to the port:

1. **Web Serial straight from the page** — `web/sinks.js` `SerialSink`
   (`sink = serial` in the UI). Works at 921600 on `http://localhost` /
   `https://` only (secure context), and it caps frames in flight at
   `MAX_IN_FLIGHT = 2` because Chromium's serial writer gives no flow control
   and the ESP32 UART ring buffer is ~4096 bytes.
2. **Node bridge** (not written — needs the `serialport` package, the only
   non-builtin in this toolchain). A page-side WebSocket sink does not exist
   yet; `BroadcastSink` is same-origin tab fan-out only, so a Node process
   cannot read from it. If the browser path starves, add a WebSocket
   `FrameSink` to `web/sinks.js` and a `tools/bridge.js` that pipes its frames
   to the port — `core/frame.js` already produces the exact bytes to write.

The page's three sinks today are `sim`, `broadcast`, `serial`
(`SINK_KINDS` in `web/sinks.js`).

---

## Compilation status

**Compiled on this machine.** `arduino-cli 1.5.1` + `esp32:esp32 3.3.12` +
`Adafruit NeoPixel 1.15.5`, `--fqbn esp32:esp32:esp32`:

```
default  : 291853 B flash (22%), 25332 B RAM (7%)
SELFTEST + -DPIN_DATA=4 -DSTALE_MS=800 -DMAX_REWINDS=4 -DDEFAULT_LIMIT_MA=6000
         : 292937 B flash (22%), 25340 B RAM (7%)
```

Zero warnings from the sketch itself; the `static_assert` protocol checks pass
in both builds. Not verified: flashing and anything that needs the panel —
no hardware was attached.

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

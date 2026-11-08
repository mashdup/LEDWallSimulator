/*
 * ============================================================================
 *  LED curtain wall — ESP32 pixel sink
 * ============================================================================
 *
 *  ============================ READ THIS FIRST ===========================
 *  The panel is NOT WS2812B. It is APA106/PL9823: 350 ns high + 1350 ns low for
 *  a 0 and the reverse for a 1, a 1.7 us bit. No off-the-shelf driver here can
 *  emit that — Adafruit_NeoPixel only offers 1250 ns and 2500 ns, and
 *  NeoPixelBus, which can, does not run on ESP32 core 3.x — so the timing is
 *  generated directly from the RMT below. See firmware/README.md, "Panel
 *  identity", for how that was established.
 *
 *  This sketch is the OFFLINE path: browser -> Web Serial -> here -> beads,
 *  with no network anywhere. WLED over DDP is the network path.
 *  ========================================================================
 *
 *  The browser is the brain. It fetches the banner, rasterises it, applies
 *  effects and streams finished frames. This sketch is a dumb sink: it decodes
 *  frames off the serial port and pushes pixels onto 400 APA106/PL9823 beads.
 *
 *  BUT A WALL WITH NOTHING ATTACHED STILL HAS TO BE A WALL (PLAYER, on by
 *  default). The brain is a laptop, and a laptop closes its lid. So the sketch
 *  also carries a PLAYER: a baked show in LittleFS — a header and N flat frames
 *  in the same 1200-byte wire order this decoder already speaks — which it plays
 *  from boot, or (opt-in) after a stream goes stale. It is NOT a renderer. The
 *  host did all of the rendering at bake time; the device seeks a frame, blends
 *  two of them and clocks bytes out. See "The player" below, core/showfile.js
 *  for the format, and tools/bake.js for how a gallery becomes one.
 *
 *  Shows arrive over the same serial port, as 0xA3/0xA2 upload records, so a
 *  baked gallery needs no cable, no SD card and no flash tool. See "Uploading".
 *
 *  Wire protocol (FROZEN — mirrors core/frame.js byte for byte):
 *
 *    frame : 0xA5 | seq u8 | 1200 bytes RGB in PHYSICAL LED order | 0x5A   (1203 B)
 *    meta  : 0xA4 | brightness u8 | limitMa u16 little endian    | 0x5A   (   5 B)
 *
 *  Byte offsets (FRAME_BYTES = 1203):
 *
 *    0        0xA5   frame magic
 *    1        u8     seq
 *    2..1201  1200   RGB triplets, physical LED order
 *    1202     0x5A   frame end
 *
 *  plan.md's prose says "Total 1204 bytes"; the fields it lists sum to 1203 and
 *  core/frame.js makes 1203 authoritative. The field list is what the sink
 *  counts, so the end byte lands at index 1202.
 *
 *  Drop-safety rule: render the LAST COMPLETE frame only. A frame is complete
 *  when (a) it started on a magic byte, (b) exactly 1200 payload bytes were
 *  read, and (c) the end byte is 0x5A. Anything else is discarded outright and
 *  the decoder rescans for the next magic byte. A partial frame is NEVER
 *  rendered, so a dropped byte can never corrupt the wall.
 *
 *  Resync detail (this is what makes a single dropped byte cheap): when the end
 *  byte is wrong, the record just consumed is rescanned for a magic byte and
 *  replayed from there. One dropped byte looks exactly like that — the swallowed
 *  record contains the NEXT frame's magic — so without the rescan one lost byte
 *  costs a run of black frames, and with it it costs one frame. core/frame.js
 *  does the same thing, so the sim and the wall recover identically.
 *  Measured over 3000 corrupt streams (7200 emitted frames, identical chunking
 *  on both sides): forward-only resync recovers 7162, this rescan recovers
 *  7183, core/frame.js recovers 7178. Zero partial frames ever reached the wall.
 *
 *  Allocation policy: one static receive buffer, one static copy of the last
 *  complete frame, one static NeoPixel object. No heap traffic in the decode
 *  or render path, no String, no Vector, no new/malloc, nothing per frame.
 *
 *  Build flags (all overridable with -D):
 *    -D PIN_DATA=27            LED data GPIO (21 on ESP32-S3 — the wired pin)
 *    -D NUM_LED=400            LED count (frozen at 400 by the protocol)
 *    -D BAUD=921600            serial baud
 *    -D SELFTEST=1             enable the wiring self-test patterns
 *    -D STALE_MS=1500          watchdog fade; 0 disables it (hold last frame)
 *    -D MAX_REWINDS=8          rescans allowed per serial drain (== core's budget)
 *    -D DEFAULT_LIMIT_MA=8000  power limit before the host sends a meta frame
 *    -D STATUS=0               silence the periodic status line
 *    -D PLAYER=0               build the sink alone; no filesystem, no baked show
 *    -D LOCAL_BOOT=0           do not play the baked show at boot
 *    -D LOCAL_FALLBACK_MS=0    0 = the stale stream goes dark; >0 = play the show
 *    -D NVS_MIN_MS=10000       throttle on persisting brightness/limit
 *  See firmware/README.md for the exact arduino-cli invocations, and for the one
 *  board setting that makes every print below invisible: CDCOnBoot must be
 *  `default` while the cable is in the CH343 UART port, or Serial moves to the
 *  S3's native USB and this sketch prints to a socket nobody has plugged in.
 * ============================================================================
 */

#include <Arduino.h>
#include <string.h>
#include "driver/rmt_tx.h"

/* Reset diagnostics. A board that reboots mid-stream blanks the wall, and from
 * the host's side that is indistinguishable from a stream fault — which makes
 * every downstream counter look clean while the panel still blinks. `rst` is
 * esp_reset_reason() and `boots` counts resets without a power cycle. */
#include "esp_system.h"
#include "esp_attr.h"

/* Boot bookkeeping. RTC memory survives a software, watchdog or brownout reset
 * but not a power cycle, and it holds garbage after a cold start — hence the
 * magic word, which is what tells "first ever boot" from "booted again". */
RTC_NOINIT_ATTR static uint32_t bootMagic;
RTC_NOINIT_ATTR static uint32_t bootCount;
static const uint32_t BOOT_MAGIC = 0x4c454431u;  // 'LED1'

/* What a stream actually produced, held in RTC memory so it outlives the reset
 * that ends the session. Without this a browser session leaves nothing to read:
 * the reset that closes it also zeroes every counter, which is exactly the
 * evidence needed to tell a clean stream from a broken one. `rtcLive` is
 * refreshed once a second, and a new boot banks it into `rtcPrev`, so `prev=` in
 * the status line reports what the previous session had reached. */
RTC_NOINIT_ATTR static uint32_t rtcLive[5];  // frames, discarded, resyncs, rewinds, gaps
RTC_NOINIT_ATTR static uint32_t rtcPrev[5];

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// GPIO27 is a free pin on the classic ESP32 and is the sketch's original
// default. On the ESP32-S3 it is SPIHD — part of the SPI flash interface — so
// the same default silently drives the flash chip and the wall stays dark
// while every command exits 0. Default to a pin that is free on the SoC being
// built. CONFIG_IDF_TARGET_ESP32S3 is defined only for the S3 target —
// confirmed by compiling a probe sketch for both targets.
//
// 21 is measured, not chosen: it is where the beads are wired, read out of the
// WLED config that drove this panel before this sketch (hw.led.ins[0].pin).
// 17 is equally free on the S3 and was the original plan, but nothing is wired
// to it — a pin-17 build is dark while the decoder reports frames climbing,
// disc=0, rmt=1 and non-zero est, which reads as a driver fault and is not one.
#ifndef PIN_DATA
#  if defined(CONFIG_IDF_TARGET_ESP32S3)
#    define PIN_DATA 21
#  else
#    define PIN_DATA 27
#  endif
#endif

#ifndef NUM_LED
#define NUM_LED 400
#endif

#ifndef BAUD
#define BAUD 921600
#endif

/* These beads are APA106/PL9823-class, NOT WS2812B. Established on this panel
 * by sweeping WLED's chipset list: the only type that renders correctly is
 * "APA106/PL9823 RGB", and WLED drives it with a dedicated RMT method —
 * NeoEsp32RmtMethod(Apa106) — where WS2812 uses its Ws2812x one. That method
 * bit-times 350 ns / 1350 ns, a 1.7 us period (~588 kHz), against WS2812B's
 * 400 / 800 ns at 1.25 us (800 kHz). This part's "1" threshold therefore falls
 * between the WS2812B driver's 800 ns and the 1350 ns the bead wants, so a
 * WS2812B-driven signal decodes *partially*: exactly the "it lights but flickers
 * like static" seen at bring-up, and never reliably. See firmware/README.md,
 * "Panel identity".
 *
 * The panel wants BGR. WLED renders correct colours at Color Order = BGR on
 * the live panel, which is the trustworthy observation; the GRB this file used
 * to carry was derived during the floating-ground episode described below, when
 * noise made a 4-byte stride look plausible, so it came from unreliable data.
 * The bit timing and the channel order are both properties of this file now,
 * not of a library. See ledInit() and the OFF_* constants below.
 *
 * History, still true: the panel was first driven through a floating ground —
 * no GND between the ESP32 and the panel's own 5 V supply — which garbled every
 * dense frame into colour bands, and that noise is what made a 4-byte RGBW
 * stride look like the answer.
 *
 * The order is BGR: WLED drives this panel correctly at Color Order = BGR, and
 * NeoPixelBus's own ESP32 examples pair this WS2811-family part with its BGR
 * feature. It lives in one place below, so swapping it is a one-line change. */

/* 1 = compile in the wiring self-test (milestone 5: layout calibration). */
#ifndef SELFTEST
#define SELFTEST 0
#endif

/* No complete frame for this long => fade to black, do not freeze.
 *
 * 0 disables the watchdog and the wall holds its last frame indefinitely. That
 * is what a display wants: at this layer a host that merely stalled — a
 * throttled browser tab, a long GC pause, a screenshot being taken — is
 * indistinguishable from one that died, and fading for it turns every hitch in
 * the stream into a visible blink. The fade is still the right default for the
 * calibration pass, where a silent stream SHOULD be obvious. */
#ifndef STALE_MS
#define STALE_MS 1500
#endif

/* Fade-to-black ramp length and granularity (watchdog only). */
#ifndef FADE_MS
#define FADE_MS 400
#endif
#ifndef FADE_STEPS
#define FADE_STEPS 24
#endif
/* A frame whose bytes stop mid-way is truncated: the tail is gone. At 921600
 * 8N1 a whole 1203-byte frame is ~13 ms of wire time, so a gap this long while
 * mid-frame means the rest of that frame is never coming. Discard the partial
 * and resynchronise on the next magic byte instead of eating the next frame's
 * header as payload. */
#ifndef PARTIAL_GAP_MS
#define PARTIAL_GAP_MS 40
#endif

/* Rescans allowed per drain of the serial buffer. core/frame.js budgets 8
 * rewinds per feed() call for exactly this reason: a payload stuffed with
 * 0xA5 bytes would otherwise make the rescan quadratic. One dropped byte needs
 * one rewind, so the budget never bites in normal operation. */
#ifndef MAX_REWINDS
#define MAX_REWINDS 8
#endif

/* WS2812B worst case per colour channel, per the shared power contract. */
#ifndef CHANNEL_MA
#define CHANNEL_MA 20
#endif

/* Limit assumed until the browser sends a meta frame. */
#ifndef DEFAULT_LIMIT_MA
#define DEFAULT_LIMIT_MA 8000
#endif

/* show() for 400 LEDs takes ~12 ms; the host keeps streaming during that, so
 * the UART ring buffer has to hold several frames or bytes get dropped. */
#ifndef SERIAL_RX_BYTES
#define SERIAL_RX_BYTES 4096
#endif

#ifndef STATUS
#define STATUS 1
#endif
#ifndef STATUS_INTERVAL_MS
#define STATUS_INTERVAL_MS 1000
#endif

/* ---- the player (see "The player" below) ----------------------------------
 *
 * PLAYER=0 builds the old sketch exactly: a sink and nothing else. It is the
 * escape hatch if the filesystem ever fails to mount on some board, and it is
 * the build the streamed path is measured on.
 *
 * LOCAL_BOOT=1 starts the baked show at boot, before a host says anything. That
 * is the whole point of the feature: a wall that has been power-cycled at a
 * venue comes back showing the gallery instead of a dark rectangle. A host frame
 * takes the wall over immediately and permanently for that session.
 *
 * LOCAL_FALLBACK_MS=0 leaves the mid-stream behaviour ALONE: a stalled stream
 * fades to black and stays black, which is the honest answer — it tells an
 * operator looking at the wall that the tether is dead. A non-zero value instead
 * starts the baked show that long after the last complete frame. Set it when a
 * party matters more than the diagnosis; leave it at 0 while calibrating.
 */
#ifndef PLAYER
#define PLAYER 1
#endif
#ifndef LOCAL_BOOT
#define LOCAL_BOOT 1
#endif
#ifndef LOCAL_FALLBACK_MS
#define LOCAL_FALLBACK_MS 0
#endif

/* ---- the standby animation (see "The standby" below) -----------------------
 *
 * What the wall does with nothing attached, when there is no baked show. This is
 * the cheap answer and it needs no host, no filesystem, no bake and no format:
 * the animation IS the firmware. Nothing is stored, so nothing can go stale, and
 * a board with a blank flash still comes up alive.
 *
 * 0 = off (the wall goes dark, which is the calibration behaviour)
 * 1 = ember     a slow amber fire, dimmer toward the top
 * 2 = drift     soft colour bands sliding sideways
 * 3 = breathe   one warm gradient pulsing on a 8 s cycle
 * 4 = cycle     each of the three, 25 s at a time
 *
 * It is deliberately NOT core/animations.js. Those animations are the CONTENT,
 * and they must stay the host's: a second copy of `fire` in C++ would be a second
 * answer to what the wall is showing, and the two would drift. Standby art is a
 * different job — it should read as "the wall is idling", the way a screensaver
 * does, so being visibly calmer than any content is the point.
 */
#ifndef STANDBY
#define STANDBY 1
#endif

/* Standby runs dimmer than content, on purpose: an idle wall may be on for hours
 * with nobody watching, and 400 beads at content brightness is heat, power and
 * LED hours spent on nothing. 0..255, folded in as a render scale (128 is half).
 * The operator's own brightness and the power guard still apply on top. */
#ifndef STANDBY_LEVEL
#define STANDBY_LEVEL 160
#endif

/* Repaint rate. The panel needs ~16.3 ms of wire time per frame (61 fps ceiling),
 * and these effects are slow by design — 20 fps is smooth for a diffused curtain
 * at 50 mm pitch and leaves the UART and the decoder most of the loop. */
#ifndef STANDBY_FPS
#define STANDBY_FPS 20
#endif

/* Seconds each pattern is held when STANDBY=4. */
#ifndef STANDBY_CYCLE_SEC
#define STANDBY_CYCLE_SEC 25
#endif

/* Largest upload chunk payload. The serial ring buffer is 4096 and one chunk
 * record is this plus 8 bytes of framing, so 1024 leaves room for the decoder to
 * keep up with a host that writes faster than LittleFS can flush. */
#ifndef SHOW_CHUNK_MAX
#define SHOW_CHUNK_MAX 1024
#endif

/* Brightness and the power limit are the operator's dial and belong to the WALL,
 * not to a session: re-dialling them after every power cycle is the wrong
 * default on a supply that has to be treated with respect. Writes are throttled
 * to one per this interval, and only when a value actually changed — NVS has a
 * finite write budget and a party is a lot of meta frames. */
#ifndef NVS_MIN_MS
#define NVS_MIN_MS 10000
#endif

#if SELFTEST
#ifndef SELFTEST_RED_MS
#define SELFTEST_RED_MS 4000
#endif
#ifndef SELFTEST_COLUMN_MS
#define SELFTEST_COLUMN_MS 4000
#endif
#ifndef SELFTEST_WALK_MS
#define SELFTEST_WALK_MS 6400
#endif
#ifndef SELFTEST_INDEX_MS
#define SELFTEST_INDEX_MS 6000
#endif
#ifndef SELFTEST_COLUMN_STEP_MS
#define SELFTEST_COLUMN_STEP_MS 200
#endif
#ifndef SELFTEST_WALK_STEP_MS
#define SELFTEST_WALK_STEP_MS 16
#endif
#endif  // SELFTEST

// ---------------------------------------------------------------------------
// Protocol constants (must match core/frame.js)
// ---------------------------------------------------------------------------
static const uint8_t  FRAME_MAGIC = 0xA5;
static const uint8_t  META_MAGIC  = 0xA4;
static const uint8_t  FRAME_END   = 0x5A;

static const uint16_t LED_BYTES   = 1200;  // 400 LEDs * 3
static const uint16_t FRAME_BYTES = 1203;  // magic + seq + 1200 RGB + end
static const uint8_t  META_BYTES  = 5;     // magic + brightness + 2 + end

static_assert(NUM_LED * 3u == LED_BYTES,
              "NUM_LED must stay 400: the frame payload is frozen at 1200 bytes");
static_assert(FRAME_BYTES == 1u + 1u + LED_BYTES + 1u, "frame layout mismatch");
static_assert(META_BYTES == 1u + 1u + 2u + 1u, "meta layout mismatch");

// ---------------------------------------------------------------------------
// Baked-show format (must match core/showfile.js byte for byte)
// ---------------------------------------------------------------------------
/*
 * test/showfile.test.js reads THIS FILE as text and pins every constant below
 * against the JS ones, the way test/calibration.test.js pins the self-test. The
 * pin exists because the boot loader indexes a file with these numbers and a
 * silent drift reads a gallery out of the middle of somebody's colour.
 *
 * Why the payload is the frame payload: a baked frame is in PHYSICAL LED order,
 * R,G,B, which is exactly what the frame protocol carries (OFFSET_RGB onward).
 * renderFrom() does the B,G,R reorder for both paths, so a streamed frame and a
 * baked one cannot disagree about a pixel — and the baker only has to call the
 * same core/ functions the browser calls.
 */
#define SHOW_MAGIC_STR "LEDS"
static const uint8_t SHOW_MAGIC_BYTES[] = {0x4c, 0x45, 0x44, 0x53};

static const uint8_t  SHOW_VERSION           = 1;
static const uint16_t SHOW_HEADER_BYTES      = 40;
static const uint8_t  SHOW_CRC_BYTES         = 4;
static const uint8_t  SHOW_FLAG_TUNED        = 1;
static const uint8_t  SHOW_TRANSITION_NONE   = 0;
static const uint8_t  SHOW_TRANSITION_FADE   = 1;

/* Header offsets. SHOW_OFF_COUNT is where the drawing count lives, and so on. */
static const uint8_t  SHOW_OFF_VERSION       = 4;
static const uint8_t  SHOW_OFF_FLAGS         = 5;
static const uint8_t  SHOW_OFF_TRANSITION    = 6;
static const uint8_t  SHOW_OFF_RESERVED0     = 7;
static const uint8_t  SHOW_OFF_COUNT         = 8;
static const uint8_t  SHOW_OFF_INTERVAL      = 10;
static const uint8_t  SHOW_OFF_GAP           = 12;
static const uint8_t  SHOW_OFF_TRANSITION_MS = 14;
static const uint8_t  SHOW_OFF_FINGERPRINT   = 16;
static const uint8_t  SHOW_OFF_BRIGHTNESS    = 20;
static const uint8_t  SHOW_OFF_RESERVED1     = 21;
static const uint8_t  SHOW_OFF_LIMIT         = 22;
static const uint8_t  SHOW_OFF_WORST         = 24;
static const uint8_t  SHOW_OFF_BODY          = 28;

/* The blend clamp. Same rule as core/content-protocol.js's galleryTiming: half
 * the drawing minus SHOW_BLEND_GUARD_MS, so both seams of a slot fit inside the
 * part of the slot they belong to and can never overlap at the boundary. */
static const uint16_t SHOW_BLEND_GUARD_MS = 250;
static const uint16_t SHOW_BLEND_DIV      = 2;

/* Upload framing. Two records, on the same serial port as the frames: a wall in a
 * venue has a cable, so the cable is how a gallery gets in — no SD card, no
 * flash tool, no rebuild. */
static const uint8_t  SHOW_CHUNK_MAGIC  = 0xA3;  // seq, offset u32, len u16, payload
static const uint8_t  SHOW_COMMIT_MAGIC = 0xA2;  // size u32, crc32 u32
static const uint8_t  SHOW_RECORD_END   = 0x5B;
static const uint8_t  SHOW_CHUNK_HEAD  = 7;   // seq + offset(4) + len(2)
static const uint8_t  SHOW_COMMIT_BODY = 8;   // size(4) + crc(4)

static_assert(SHOW_HEADER_BYTES == SHOW_OFF_BODY + 4u + 8u, "show header padding");

/**
 * The header, decoded. Field-for-field the file format for readers, nothing more.
 *
 * Declared HERE, above the first function, because the Arduino builder hoists a
 * prototype for every function in a .ino to just above the first definition — so
 * a type used in a signature has to be visible before that point or every
 * prototype that mentions it fails to compile. (It is also the right place: the
 * decoded header belongs next to the byte offsets it comes from.)
 */
struct ShowHeader {
  uint16_t count;
  uint16_t intervalSec;
  uint16_t gapSec;
  uint16_t transitionMs;
  uint8_t  transition;
  uint8_t  brightness;
  uint8_t  tuned;
  uint16_t limitMa;
  uint32_t fingerprint;
  uint32_t worstMa;
  uint32_t bodyBytes;
  uint32_t fileBytes;
};

// ---------------------------------------------------------------------------
// Static storage — no heap anywhere below
// ---------------------------------------------------------------------------
static uint8_t wireBuf[LED_BYTES];    // what the strip is sent, in wire order

/* Channel order on the wire. The protocol carries R,G,B; these beads want B,G,R. */
static const uint8_t OFF_R = 2, OFF_G = 1, OFF_B = 0;

/* ---- LED output: the part's own bit timing, straight out of the RMT --------
 *
 * 20 MHz resolution makes one tick 50 ns, so both durations are exact integers:
 * 350 ns = 7 ticks, 1350 ns = 27. That exactness is the point — a rounded
 * duration is the same class of error as the wrong bit rate.
 *
 * rmt_new_tx_channel() rejects the legacy driver's company: mixing driver/rmt.h
 * with driver/rmt_tx.h aborts with "driver_ng is not allowed to be used with the
 * legacy driver". This file uses the new API only.
 */
static const uint32_t RMT_RESOLUTION_HZ = 20u * 1000u * 1000u;
static const uint16_t TICKS_T0H = 7;   // 350 ns
static const uint16_t TICKS_T0L = 27;  // 1350 ns
static const uint16_t TICKS_T1H = 27;  // 1350 ns
static const uint16_t TICKS_T1L = 7;   // 350 ns

static rmt_channel_handle_t rmtChannel = nullptr;
static rmt_encoder_handle_t rmtEncoder = nullptr;

/** Install the RMT channel and its encoder. False leaves the wall dark. */
static bool ledInit(void) {
  rmt_tx_channel_config_t ch = {};
  ch.clk_src = RMT_CLK_SRC_DEFAULT;
  ch.gpio_num = (gpio_num_t)PIN_DATA;
  ch.resolution_hz = RMT_RESOLUTION_HZ;
  ch.mem_block_symbols = 64;
  /* Must be non-zero: rmt_new_tx_channel() rejects depth 0 with
   * ESP_ERR_INVALID_ARG, and a zero-initialised struct leaves it at 0. */
  ch.trans_queue_depth = 4;
  if (rmt_new_tx_channel(&ch, &rmtChannel) != ESP_OK) return false;

  rmt_bytes_encoder_config_t enc = {};
  enc.bit0.level0 = 1; enc.bit0.duration0 = TICKS_T0H;
  enc.bit0.level1 = 0; enc.bit0.duration1 = TICKS_T0L;
  enc.bit1.level0 = 1; enc.bit1.duration0 = TICKS_T1H;
  enc.bit1.level1 = 0; enc.bit1.duration1 = TICKS_T1L;
  enc.flags.msb_first = 1;
  if (rmt_new_bytes_encoder(&enc, &rmtEncoder) != ESP_OK) return false;

  return rmt_enable(rmtChannel) == ESP_OK;
}

/* Clock the buffer out and wait for it: 1200 bytes is ~16.3 ms of wire time, so
 * loop() is blocked for it exactly as it was with a library show(). The UART ring
 * buffer holds three frames, so the host keeps streaming through it. */
static void ledShow(void) {
  if (rmtChannel == nullptr) return;
  rmt_transmit_config_t tx = {};
  tx.loop_count = 0;
  if (rmt_transmit(rmtChannel, rmtEncoder, wireBuf, sizeof(wireBuf), &tx) == ESP_OK) {
    rmt_tx_wait_all_done(rmtChannel, 200);
  }
}

static uint8_t rxBuf[LED_BYTES];      // frame currently being received
static uint8_t lastFrame[LED_BYTES];  // last COMPLETE frame, wire order (R,G,B)


/* millis() is read once per loop() iteration, never per byte: a frame is 1203
 * bytes and the decoder must not pay for a clock read on each one. */
static uint32_t tNow = 0;

// ---------------------------------------------------------------------------
// Receive state machine
// ---------------------------------------------------------------------------
enum RxState : uint8_t {
  RX_IDLE = 0,  // scanning for a magic byte; everything else is noise
  RX_SEQ,       // frame magic consumed; the next byte is the seq
  RX_RGB,       // collecting the 1200 payload bytes
  RX_END,       // payload complete; expecting 0x5A at index 1202
  RX_META,      // collecting the 4 meta bytes after 0xA4
  /* Upload records. They share the stream with frames and are told apart by
   * magic, so the host needs no separate mode: it either streams frames or
   * uploads a show, and this machine does not care which. */
  RX_SHOW_HEAD,   // collecting seq + offset + len after 0xA3
  RX_SHOW_DATA,   // collecting `upChunkLen` payload bytes
  RX_SHOW_TAIL,   // expecting 0x5B after a chunk's payload
  RX_SHOW_COMMIT  // collecting size + crc after 0xA2, then 0x5B
};

static RxState  state   = RX_IDLE;
static uint16_t rxN     = 0;      // payload bytes collected in rxBuf
static uint8_t  rxSeq   = 0;      // seq of the frame being received
static uint8_t  metaBuf[META_BYTES - 1u];  // brightness, limitLo, limitHi, end
static uint8_t  metaN   = 0;

/* True while a discarded record is being replayed through feedByte(). Replay is
 * one level deep: a bad end byte found during a replay is discarded but never
 * rescanned again, so the work per bad frame is bounded by one record (1201
 * bytes) and there is no recursion. */
static bool rescanning = false;

/* Rescans left in the current serial drain; refilled in loop(). */
static uint8_t rewindBudget = MAX_REWINDS;

struct Stats {
  uint32_t frames;      // complete frames rendered
  uint32_t meta;        // meta frames applied
  uint32_t discarded;   // frames rejected (bad end byte / truncated)
  uint32_t resyncs;     // non-magic bytes skipped while idle
  uint32_t rewinds;     // discarded records rescanned for a magic byte
  uint32_t seqGaps;     // complete frames whose seq did not advance by 1
  uint32_t stale;       // watchdog fades to black
  uint32_t localFalls;  // streams that died and handed the wall to the player
  uint32_t standbyStarts;  // times the standby animation took the wall
} stats = {0, 0, 0, 0, 0, 0, 0, 0, 0};

// ---------------------------------------------------------------------------
// Power guard
// ---------------------------------------------------------------------------
/*
 * Arithmetic (documented, per the shared power contract):
 *
 *   worst case = every LED full white at brightness B
 *   I(B)       = NUM_LED * 3 channels * CHANNEL_MA * B / 255
 *              = 400 * 3 * 20 * B / 255
 *              = 24000 * B / 255  ~= 94.12 * B  mA
 *
 *   => B_max(limit) = floor(limit * 255 / (NUM_LED * 3 * CHANNEL_MA))
 *                   = floor(limit * 255 / 24000)
 *
 *      limit   4000 mA -> B_max  42
 *      limit   8000 mA -> B_max  85
 *      limit  12000 mA -> B_max 127
 *      limit  18000 mA -> B_max 191
 *      limit  24000 mA -> B_max 255
 *
 * This is the full-white bound, so it is conservative: a real banner frame has
 * dark cells and draws less. renderWall() applies the scale with the same
 * integer shift the whole render path uses (see brightnessScale below), so the
 * estimate and the draw share one arithmetic rather than two.
 */
static uint8_t maxBrightnessForLimit(uint16_t limit) {
  const uint32_t denom = (uint32_t)NUM_LED * 3u * (uint32_t)CHANNEL_MA;  // 24000
  uint32_t b = ((uint32_t)limit * 255u) / denom;
  if (b > 255u) b = 255u;
  return (uint8_t)b;
}

__attribute__((unused)) static uint32_t fullWhiteMa(uint8_t brightness) {
  return ((uint32_t)NUM_LED * 3u * (uint32_t)CHANNEL_MA * (uint32_t)brightness) / 255u;
}

/* Estimated current of what is ACTUALLY on the wall: the frame's channel sum
 * scaled by CHANNEL_MA/255 and by the brightness actually applied. Integer only,
 * no float, no allocation. Reported by the status line.
 *
 * Worst product: 1200 * 255 * 20 * 255 = 1.56e9, inside uint32. */
__attribute__((unused)) static uint32_t estimateFrameMa(const uint8_t *rgb, uint8_t brightness) {
  uint32_t sum = 0;
  for (uint16_t i = 0; i < LED_BYTES; i++) sum += rgb[i];
  const uint32_t b = (brightness >= 255u) ? 255u : (uint32_t)brightness;
  return ((uint32_t)CHANNEL_MA * sum * b) / (255u * 255u);
}

static uint8_t  wantBrightness = 255;             // what the host asked for
static uint16_t limitMa        = DEFAULT_LIMIT_MA;  // declared budget
static uint8_t  activeBrightness = 0;             // wantBrightness, clamped

/* NOTE: brightness is never handed to the driver, and that is deliberate.
 *
 * NeoPixelBus's SetPixelColor() is a plain store — it applies no scaling of its
 * own — so renderWall() folds the brightness into the value it writes. That
 * keeps the guard real: activeBrightness is what actually reaches the LEDs, not
 * a field on a driver object that nothing reads. */
static void applyBrightnessGuard(void) {
  const uint8_t cap = maxBrightnessForLimit(limitMa);
  activeBrightness = (wantBrightness <= cap) ? wantBrightness : cap;
}

/* Brightness as an 8-bit fixed-point scale: a stored brightness b < 255 scales
 * a channel as (c * b) >> 8, and 255 means "no scaling at all". 256 is the
 * identity multiplier. This is the sketch's own arithmetic — see the note above
 * on why the driver is not asked to scale. */
static uint16_t brightnessScale(void) {
  return (activeBrightness >= 255u) ? 256u : (uint16_t)activeBrightness;
}

// ---------------------------------------------------------------------------
// Wall state + watchdog
// ---------------------------------------------------------------------------
enum WallState : uint8_t {
  WALL_DARK = 0,  // nothing to show
  WALL_LIVE,      // a complete frame is on the wall
  WALL_FADING,    // watchdog ramp down in progress
  WALL_LOCAL,     // the baked show is on the wall; no host involved
  WALL_STANDBY    // the standby animation owns the wall; no host, no filesystem
};

static WallState wall = WALL_DARK;

static uint32_t lastCompleteMs = 0;  // when the last complete frame landed
static uint32_t lastByteMs     = 0;  // when the last byte landed
static uint32_t statusMs       = 0;
static uint32_t fadeStartMs    = 0;  // when the watchdog started ramping down
static uint8_t  fadeStep       = 0;  // last fade step rendered
static uint8_t  lastSeq        = 0;
static bool     haveLastSeq    = false;

#if SELFTEST
/* Declared here so commitFrame() can hand the wall over to the host; the
 * self-test itself lives further down. */
static bool selftestActive = true;
#endif

/* Copy lastFrame onto the strip and clock it out.
 *
 * fadeScale == 256 is "no watchdog fade"; lower values are the fade ramp. The
 * declared brightness is folded in here rather than left to a brightness call,
 * because this is the only place the pixels actually reach the strip:
 *
 *   scale = (fadeScale * brightnessScale) >> 8
 *
 * Both factors top out at 256, so the product fits in 16 bits and 256*256>>8
 * lands back on the identity branch. SetPixelColor() is a plain store in
 * NeoPixelBus — no gamma table, no brightness call — so this is still one pass
 * over the frame, and the feature reorders the channels on the way in. */
static void renderFrom(const uint8_t *rgb, uint16_t fadeScale) {
  const uint16_t scale = (uint16_t)(((uint32_t)fadeScale * (uint32_t)brightnessScale()) >> 8);

  if (scale >= 256u) {
    for (uint16_t i = 0; i < NUM_LED; i++) {
      const uint16_t w = (uint16_t)(i * 3);
      wireBuf[w + OFF_R] = rgb[w + 0];
      wireBuf[w + OFF_G] = rgb[w + 1];
      wireBuf[w + OFF_B] = rgb[w + 2];
    }
  } else {
    for (uint16_t i = 0; i < NUM_LED; i++) {
      const uint16_t w = (uint16_t)(i * 3);
      wireBuf[w + OFF_R] = (uint8_t)((rgb[w + 0] * scale) >> 8);
      wireBuf[w + OFF_G] = (uint8_t)((rgb[w + 1] * scale) >> 8);
      wireBuf[w + OFF_B] = (uint8_t)((rgb[w + 2] * scale) >> 8);
    }
  }
  ledShow();
}

/* The streamed frame: lastFrame, in wire order, R,G,B. */
static void renderWall(uint16_t fadeScale) {
  renderFrom(lastFrame, fadeScale);
}

static void clearWall(void) {
  memset(wireBuf, 0, sizeof(wireBuf));
  ledShow();
}

/* ==========================================================================
 *  The player: a baked show, played from LittleFS
 * ==========================================================================
 *
 *  WHAT THIS IS NOT. It is not a renderer. `core/showfile.js` explains why the
 *  bake happens on the host: the layout permutation and the LED fine-tune are
 *  the two transforms a frame needs, and both of them already live in core/ and
 *  already run identically in Node and in the page. Porting them here would be a
 *  second implementation of the same maths, which is the one thing this project
 *  has spent its whole test suite avoiding. So the device gets frames that are
 *  finished, and does three things to them: seek, blend, clock out.
 *
 *  SHOW IS IMMUTABLE, and that is load-bearing. This file is allowed `slot %
 *  count` — arithmetic core/content-protocol.js bans in capitals — for exactly
 *  one reason: a live gallery's roster mutates, so an index into it re-bases and
 *  the wall skips seats and repeats drawings. A baked show's roster is a number
 *  in a file that nothing can change while it plays. If this ever grows a way to
 *  change the roster mid-show, the arithmetic has to go with it and the cursor
 *  has to move into the file.
 *
 *  RAM: three static 1200-byte buffers (current drawing, previous drawing, the
 *  blend result) and the upload chunk. No heap, no String, nothing per frame.
 */
#if PLAYER

#include <LittleFS.h>
#include <Preferences.h>

#define SHOW_PATH     "/show.led"
#define SHOW_TMP_PATH "/show.tmp"
#define SHOW_OLD_PATH "/show.old"

static uint8_t  localCur[LED_BYTES];    // the drawing of the slot we are in
static uint8_t  localPrev[LED_BYTES];   // the drawing of the slot before it
static uint8_t  localMix[LED_BYTES];    // what is being painted (cur, prev, or a blend)

static struct {
  bool       present;    // a validated show is on flash
  ShowHeader h;
  bool       playing;    // the wall is being driven by it right now
  uint32_t   startMs;
  uint8_t    curIdx;
  uint8_t    prevIdx;
  bool       primed;
  // What was last painted, so a still frame is not re-clocked 60 times a second.
  uint8_t    paintedIdx;
  uint8_t    paintedKind;
  uint16_t   paintedK;
  bool       painted;
} local;

static struct {
  uint32_t starts;
  uint32_t frames;      // frames painted from the show
  uint32_t seams;       // slot boundaries crossed
  uint32_t underruns;   // frames requested that could not be read
  uint32_t rejects;     // shows refused at load
  uint32_t upChunks;
  uint32_t upBytes;
  uint32_t upRejects;
} localStats;

// ---------------------------------------------------------------------------
// crc32 — the same reflected IEEE polynomial core/showfile.js and zlib use
// ---------------------------------------------------------------------------
/* Bitwise, no table: this runs once at boot over ~120 KB (measured ~15 ms at
 * 240 MHz), and a table would be 1 KB of flash to buy back a number nobody is
 * waiting on. `crc32Begin`/`crc32End` bracket it so an upload can checksum a
 * file in the same pieces it is already writing, without buffering all of it. */
static uint32_t crc32Begin(void) { return 0xFFFFFFFFu; }

static uint32_t crc32Update(uint32_t crc, const uint8_t *p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    crc ^= p[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 1u) ? ((crc >> 1) ^ 0xEDB88320u) : (crc >> 1);
    }
  }
  return crc;
}

static uint32_t crc32End(uint32_t crc) { return crc ^ 0xFFFFFFFFu; }

static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
static uint32_t le32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// ---------------------------------------------------------------------------
// Loading and validating
// ---------------------------------------------------------------------------
/** Chunk buffer, shared by the file checksum and the upload path. */
static uint8_t fsChunk[512];

/** The blend length actually used, clamped exactly as showBlendMs() clamps it. */
static uint16_t showBlendMs(const ShowHeader &h) {
  const int32_t showMs = (int32_t)h.intervalSec * 1000;
  int32_t t = (showMs - (int32_t)SHOW_BLEND_GUARD_MS) / (int32_t)SHOW_BLEND_DIV;
  if (t < 0) t = 0;
  if (t > (int32_t)h.transitionMs) t = (int32_t)h.transitionMs;
  if (h.transition == SHOW_TRANSITION_NONE) t = 0;
  return (uint16_t)t;
}

/**
 * Probe a file: structural checks first, then the trailing crc. False for a
 * missing file, a truncated one, a future version, or a single flipped bit — and
 * the header is only written to `out` when every check passed, so a caller can
 * never be looking at half a header.
 */
static bool showProbe(const char *path, ShowHeader *out) {
  fs::File f = LittleFS.open(path, "r");
  if (!f) return false;
  const uint32_t size = (uint32_t)f.size();
  if (size < (uint32_t)SHOW_HEADER_BYTES + SHOW_CRC_BYTES) { f.close(); return false; }

  uint8_t head[SHOW_HEADER_BYTES];
  if (f.read(head, SHOW_HEADER_BYTES) != (int)SHOW_HEADER_BYTES) { f.close(); return false; }

  for (uint8_t i = 0; i < sizeof(SHOW_MAGIC_BYTES); i++) {
    if (head[i] != SHOW_MAGIC_BYTES[i]) { f.close(); return false; }
  }
  if (head[SHOW_OFF_VERSION] != SHOW_VERSION) { f.close(); return false; }
  if (head[SHOW_OFF_RESERVED0] != 0 || head[SHOW_OFF_RESERVED1] != 0) { f.close(); return false; }
  if (head[SHOW_OFF_TRANSITION] > SHOW_TRANSITION_FADE) { f.close(); return false; }

  const uint16_t count       = le16(head + SHOW_OFF_COUNT);
  const uint16_t intervalSec = le16(head + SHOW_OFF_INTERVAL);
  const uint32_t bodyBytes   = le32(head + SHOW_OFF_BODY);
  if (count == 0 || intervalSec < 1) { f.close(); return false; }
  if (bodyBytes != (uint32_t)count * (uint32_t)LED_BYTES) { f.close(); return false; }
  if (size != (uint32_t)SHOW_HEADER_BYTES + bodyBytes + SHOW_CRC_BYTES) { f.close(); return false; }

  /* The crc covers everything before itself, so the tail is read separately
   * from the stream that is checksummed — no four-byte pipeline, no cleverness. */
  uint32_t crc = crc32Begin();
  uint32_t left = size - SHOW_CRC_BYTES;
  if (!f.seek(0)) { f.close(); return false; }
  while (left > 0) {
    const size_t want = left < sizeof(fsChunk) ? (size_t)left : sizeof(fsChunk);
    const size_t got = f.read(fsChunk, want);
    if (got == 0) { f.close(); return false; }   // short file that the size lied about
    crc = crc32Update(crc, fsChunk, got);
    left -= got;
  }
  uint8_t tail[SHOW_CRC_BYTES];
  if (f.read(tail, SHOW_CRC_BYTES) != (int)SHOW_CRC_BYTES) { f.close(); return false; }
  f.close();
  if (le32(tail) != crc32End(crc)) return false;

  out->count        = count;
  out->intervalSec  = intervalSec;
  out->gapSec       = le16(head + SHOW_OFF_GAP);
  out->transitionMs = le16(head + SHOW_OFF_TRANSITION_MS);
  out->transition   = head[SHOW_OFF_TRANSITION];
  out->brightness   = head[SHOW_OFF_BRIGHTNESS];
  out->tuned        = (head[SHOW_OFF_FLAGS] & SHOW_FLAG_TUNED) ? 1 : 0;
  out->limitMa      = le16(head + SHOW_OFF_LIMIT);
  out->fingerprint  = le32(head + SHOW_OFF_FINGERPRINT);
  out->worstMa      = le32(head + SHOW_OFF_WORST);
  out->bodyBytes    = bodyBytes;
  out->fileBytes    = size;
  return true;
}

/** Read drawing `idx` into `out`. False leaves the wall showing what it had. */
static bool showReadFrame(uint8_t idx, uint8_t *out) {
  fs::File f = LittleFS.open(SHOW_PATH, "r");
  if (!f) return false;
  const uint32_t at = (uint32_t)SHOW_HEADER_BYTES + (uint32_t)idx * (uint32_t)LED_BYTES;
  bool ok = f.seek(at) && f.read(out, LED_BYTES) == (int)LED_BYTES;
  f.close();
  return ok;
}

/** One line about a show, for the boot banner and for the bake summary to match. */
static void showAnnounce(const ShowHeader &h) {
  Serial.print(F("show: "));
  Serial.print(h.count);
  Serial.print(F(" drawings, "));
  Serial.print(h.intervalSec);
  Serial.print(F("s + "));
  Serial.print(h.gapSec);
  Serial.print(F("s break, "));
  Serial.print(h.transition == SHOW_TRANSITION_FADE ? F("fade") : F("cut"));
  Serial.print(' ');
  Serial.print(showBlendMs(h));
  Serial.print(F("ms, "));
  Serial.print(h.brightness);
  Serial.print(F("/255, "));
  Serial.print(h.limitMa);
  Serial.print(F("mA limit, worst "));
  Serial.print(h.worstMa);
  Serial.print(F("mA, fp "));
  Serial.print(h.fingerprint);
  Serial.print(F(", tuned="));
  Serial.print(h.tuned ? 1 : 0);
  Serial.print(F(", "));
  Serial.print(h.fileBytes);
  Serial.println(F("B"));
}

// ---------------------------------------------------------------------------
// NVS: the operator's dial belongs to the wall
// ---------------------------------------------------------------------------
static Preferences prefs;
static bool  nvsReady    = false;
static bool  nvsDirty    = false;
static uint32_t nvsWriteMs = 0;
static uint8_t  nvsSavedBrightness = 255;
static uint16_t nvsSavedLimit      = DEFAULT_LIMIT_MA;
/* Whether a value was actually RESTORED, rather than whether it happens to equal
 * the compiled default: a wall dialled to 255/8000 is a wall with an opinion, and
 * "the number matches the initialiser" is not the same statement. */
static bool     nvsHaveBrightness = false;
static bool     nvsHaveLimit      = false;

static void nvsLoad(void) {
  if (!prefs.begin("wall", false)) return;
  nvsReady = true;
  /*
   * `isKey`, not a sentinel default. Preferences::getUShort takes a uint16_t
   * default, so the obvious "pass 0x10000 and check it came back" is silently
   * truncated to 0 on the way in — a missing key and a stored 0 are then the
   * same answer, and the wall boots with limit=0. It did: the first boot of
   * this code read limit=0mA, maxBrightnessForLimit(0) returned 0, and the panel
   * came up at brightness 0 with the power guard doing exactly what it was told.
   * The banner said `nvs: br=255 limit=0mA (restored)` — "restored" from a key
   * that did not exist. Ask whether the key is there; never infer it from a
   * value the getter is allowed to invent.
   */
  if (prefs.isKey("br")) {
    wantBrightness = prefs.getUChar("br", 255);
    nvsSavedBrightness = wantBrightness;
    nvsHaveBrightness = true;
  }
  if (prefs.isKey("lim")) {
    limitMa = prefs.getUShort("lim", DEFAULT_LIMIT_MA);
    nvsSavedLimit = limitMa;
    nvsHaveLimit = true;
  }
  applyBrightnessGuard();
  Serial.print(F("nvs: br="));
  Serial.print(wantBrightness);
  Serial.print(F(" limit="));
  Serial.print(limitMa);
  Serial.print(nvsHaveBrightness || nvsHaveLimit ? F("mA (restored)") : F("mA (nothing saved)"));
  Serial.print(F(" -> br="));
  Serial.print(activeBrightness);
  Serial.println(F("/255 after the guard"));
}

/**
 * Persist the dial, throttled and only on a real change.
 *
 * A meta frame arrives rarely and a party is a long evening, but NVS sectors are
 * a finite resource and a wall that wears out its flash writing the same two
 * bytes is a wall that dies of bookkeeping. So: throttled to NVS_MIN_MS, skipped
 * when nothing changed, and never forced.
 */
static void nvsNote(uint32_t now) {
  if (!nvsReady) return;
  if (wantBrightness == nvsSavedBrightness && limitMa == nvsSavedLimit) return;
  if (now - nvsWriteMs < (uint32_t)NVS_MIN_MS) { nvsDirty = true; return; }
  prefs.putUChar("br", wantBrightness);
  prefs.putUShort("lim", limitMa);
  nvsSavedBrightness = wantBrightness;
  nvsSavedLimit = limitMa;
  nvsWriteMs = now;
  nvsDirty = false;
}

/** A throttled write that was deferred still lands, on the next quiet second. */
static void nvsFlushDeferred(uint32_t now) {
  if (!nvsDirty || !nvsReady) return;
  if (now - nvsWriteMs < (uint32_t)NVS_MIN_MS) return;
  nvsNote(now);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
/** Blend `from` toward `to` at k/256. A null side means black — the wall's own
 *  background, which is what a baked show has for a break. The arithmetic is the
 *  reference renderer's, integer for integer (core/showfile.js showFrameAt):
 *  `f + ((t - f) * k >> 8)` with an ARITHMETIC shift, so a negative delta floors
 *  the same way the JS `>>` does and the two cannot disagree by one. */
static void mixInto(uint8_t *out, const uint8_t *from, const uint8_t *to, uint16_t k) {
  for (uint16_t i = 0; i < LED_BYTES; i++) {
    const int32_t f = (from == nullptr) ? 0 : (int32_t)from[i];
    const int32_t t = (to == nullptr) ? 0 : (int32_t)to[i];
    out[i] = (uint8_t)(f + (((t - f) * (int32_t)k) >> 8));
  }
}

static void localStop(void) {
  if (!local.playing) return;
  local.playing = false;
  local.painted = false;
  Serial.println(F("local: stopped"));
}

/**
 * Start the baked show.
 *
 * `startMs` is reset to NOW rather than to a slot boundary, so the wall begins at
 * the top of the first drawing — which is what a person who just walked in
 * expects, and the only moment where "which slot is this" has a right answer.
 * The blend is skipped on the first paint for the same reason: fading INTO a
 * gallery from black on every boot reads as a fault, not as a transition.
 */
static void localStart(void) {
  if (!local.present) return;
  /* Never re-enter. Starting twice is not idempotent: it re-stamps startMs, so a
   * second start mid-fade replays the opening seam forever. Cheap to guard, and
   * this exact bug has already been paid for once. */
  if (local.playing) return;
  local.playing = true;
  local.primed = false;
  local.curIdx = 0xFFu;
  local.prevIdx = 0xFFu;
  local.painted = false;
  local.startMs = tNow;
  nvsFlushDeferred(tNow);
  wall = WALL_LOCAL;
  localStats.starts++;
  Serial.print(F("local: playing "));
  Serial.print(local.h.count);
  Serial.println(F(" drawings"));
}

/**
 * Paint the frame this instant calls for, if it is a different frame from the
 * one already on the wall.
 *
 * The skip is not an optimisation, it is what keeps the port usable: ledShow()
 * blocks for ~16 ms of wire time, so re-clocking an unchanged drawing 60 times a
 * second would starve the serial decoder and make an upload crawl. Repainting
 * only when (drawing, seam, k) changes gives ~60 fps through a blend — where the
 * change is real — and one repaint per slot otherwise.
 */
static void localCompose(void) {
  if (!local.playing || !local.present) return;

  const uint32_t elapsed = tNow - local.startMs;
  const uint32_t showMs  = (uint32_t)local.h.intervalSec * 1000u;
  const uint32_t gapMs   = (uint32_t)local.h.gapSec * 1000u;
  const uint32_t period  = showMs + gapMs;
  const uint32_t slot    = elapsed / period;
  const uint32_t phase   = elapsed - slot * period;
  const uint8_t  idx     = (uint8_t)(slot % (uint32_t)local.h.count);  // SHOW IS IMMUTABLE

  if (idx != local.curIdx) {
    if (local.primed) {
      memcpy(localPrev, localCur, LED_BYTES);   // static -> static
      local.prevIdx = local.curIdx;
      localStats.seams++;
    }
    /* A read that fails mid-show leaves the previous drawing up rather than
     * blanking the wall: a filesystem hiccup is not a reason to lose the
     * picture, and the counter is what makes it visible. */
    if (!showReadFrame(idx, localCur)) {
      localStats.underruns++;
      if (!local.primed) memset(localCur, 0, LED_BYTES);
    }
    local.curIdx = idx;
    local.primed = true;
  }

  const uint16_t trans = showBlendMs(local.h);
  const uint8_t *from = nullptr;
  const uint8_t *to = localCur;
  uint16_t k = 0;
  uint8_t kind = 0;   // 0 = drawing, 1 = break

  if (gapMs > 0 && phase >= showMs) {
    /* The break proper. A baked show carries no gap animation, so the break is
     * black — the wall's own background, which is what `nullptr` means below. */
    to = nullptr;
    kind = 1;
  } else if (trans == 0) {
    // A hard cut: the drawing, whole, with no partial frame at any instant.
  } else if (phase < trans) {
    /* The opening seam. `from` is the break when there is one, otherwise the
     * previous drawing — which is what keeps a no-gap gallery soft too. */
    from = (gapMs > 0) ? nullptr : localPrev;
    k = (uint16_t)((phase * 256u) / (uint32_t)trans);
  } else if (phase >= showMs - trans) {
    /* The closing seam: the drawing is what the wall is leaving, so the target is
     * the break and k runs toward it. */
    to = nullptr;
    kind = 1;
    from = localCur;
    k = (uint16_t)(((phase - (showMs - trans)) * 256u) / (uint32_t)trans);
  }

  if (to == nullptr) {
    if (from == nullptr) memset(localMix, 0, LED_BYTES);   // the break
    else mixInto(localMix, from, nullptr, k);             // drawing -> black
  } else if (from == nullptr) {
    if (k == 0) memcpy(localMix, to, LED_BYTES);          // the drawing, whole
    else mixInto(localMix, nullptr, to, k);               // black -> drawing
  } else {
    mixInto(localMix, from, to, k);                       // drawing -> drawing
  }

  if (local.painted && local.paintedIdx == local.curIdx && local.paintedKind == kind
      && local.paintedK == k) {
    return;                                       // nothing new to clock out
  }
  local.painted = true;
  local.paintedIdx = local.curIdx;
  local.paintedKind = kind;
  local.paintedK = k;
  localStats.frames++;
  renderFrom(localMix, 256u);
}

// ---------------------------------------------------------------------------
// Uploading: 0xA3 chunks, then a 0xA2 commit
// ---------------------------------------------------------------------------
/*
 * A gallery gets onto the wall over the cable that is already there. The records
 * sit in the same byte stream as the frames and are told apart by their magic, so
 * the browser needs no special mode to send one — a host either streams frames or
 * uploads a show, and the decoder does not care which.
 *
 * Ordering is ENFORCED, not assumed: a chunk's offset must be exactly how many
 * bytes have already been written. A dropped record is then a refusal instead of a
 * hole, because a hole would be a file with a valid length and a silent gap in a
 * drawing — the worst possible outcome, since every check would pass.
 *
 * Nothing touches SHOW_PATH until the commit record has been verified. The live
 * show is renamed aside, the new one renamed in, and the old one deleted after —
 * so the window in which neither exists is a rename, not a whole upload.
 */
static fs::File upFile;
static bool     upActive = false;
static uint32_t upWritten = 0;
static uint32_t upCrc = 0;
static uint16_t upChunkLen = 0;
static uint16_t upChunkGot = 0;
static uint8_t  upSeq = 0;
static uint8_t  upChunk[SHOW_CHUNK_MAX];
static uint8_t  upHead[SHOW_CHUNK_HEAD];
static uint8_t  upHeadN = 0;
static uint8_t  upCommitBuf[SHOW_COMMIT_BODY + 1u];
static uint8_t  upCommitN = 0;

/*
 * Aborts are LOUD, and they carry a reason.
 *
 * The first version of this was silent, and it cost an afternoon: a dropped byte
 * in a chunk made the tail check fail, the upload was abandoned, and the only
 * symptom was `--upload` printing "no verdict from the wall" twenty seconds
 * later. A `catch` around a bug turns a broken feature into a silent one, and a
 * bare `return` does the same thing to a protocol.
 */
static void upAbort(const __FlashStringHelper *why) {
  if (upFile) upFile.close();
  upActive = false;
  upWritten = 0;
  upCrc = 0;
  upChunkLen = 0;
  upChunkGot = 0;
  localStats.upRejects++;
  Serial.print(F("upload: aborted "));
  Serial.println(why);
}

/** Open the temp file for a fresh upload, discarding anything half-written. */
static bool upBegin(void) {
  if (upFile) upFile.close();
  LittleFS.remove(SHOW_TMP_PATH);
  upFile = LittleFS.open(SHOW_TMP_PATH, "w");
  if (!upFile) { upActive = false; return false; }
  upActive = true;
  upWritten = 0;
  upCrc = crc32Begin();
  return true;
}

/** Commit: size and crc decide whether the file is worth keeping. */
static void upCommit(uint32_t size, uint32_t crc) {
  if (!upActive || !upFile) { localStats.upRejects++; return; }
  upFile.close();
  upActive = false;

  const uint32_t computed = crc32End(upCrc);
  fs::File chk = LittleFS.open(SHOW_TMP_PATH, "r");
  const uint32_t actual = chk ? (uint32_t)chk.size() : 0u;
  if (chk) chk.close();

  if (size != upWritten || actual != size || computed != crc) {
    Serial.print(F("upload: refused (size "));
    Serial.print(actual);
    Serial.print('/');
    Serial.print(size);
    Serial.print(F(" crc "));
    Serial.print(computed);
    Serial.print('/');
    Serial.println(crc);
    LittleFS.remove(SHOW_TMP_PATH);
    localStats.upRejects++;
    return;
  }

  /* Validate the BYTES, not just the transport: a file can arrive intact and
   * still be something this firmware cannot play (a newer version, a code the
   * device has no transition for). Probing before the rename is what makes the
   * refusal harmless. */
  ShowHeader probe;
  if (!showProbe(SHOW_TMP_PATH, &probe)) {
    Serial.println(F("upload: refused (not a show this firmware can play)"));
    LittleFS.remove(SHOW_TMP_PATH);
    localStats.upRejects++;
    return;
  }

  LittleFS.remove(SHOW_OLD_PATH);
  const bool had = LittleFS.exists(SHOW_PATH);
  if (had && !LittleFS.rename(SHOW_PATH, SHOW_OLD_PATH)) {
    Serial.println(F("upload: refused (cannot put the live show aside)"));
    LittleFS.remove(SHOW_TMP_PATH);
    localStats.upRejects++;
    return;
  }
  if (!LittleFS.rename(SHOW_TMP_PATH, SHOW_PATH)) {
    Serial.println(F("upload: rename failed"));
    if (had) LittleFS.rename(SHOW_OLD_PATH, SHOW_PATH);   // put it back
    localStats.upRejects++;
    return;
  }
  LittleFS.remove(SHOW_OLD_PATH);

  local.h = probe;
  local.present = true;
  localStats.upBytes += size;
  Serial.print(F("upload: ok "));
  Serial.print(size);
  Serial.println(F("B"));
  showAnnounce(probe);

  /* A live show is restored rather than replaced by a reboot: the file changed
   * under it, so it restarts at slot 0 with the new one. Anything else would have
   * the wall mid-blend between two files it no longer has. */
  if (local.playing) { local.playing = false; localStart(); }
}

/**
 * Decide what the wall can play, and with which dial settings.
 *
 * The precedence is deliberate. The show header says what it was BAKED for; NVS
 * says what an operator last dialled while looking at the wall. The operator
 * wins on brightness (they were watching it), and the LOWER limit wins on power
 * (the safer of two statements about the same supply). Neither can push past
 * maxBrightnessForLimit, which is applied by applyBrightnessGuard as always.
 */
static void showAdopt(void) {
  ShowHeader h;
  if (!showProbe(SHOW_PATH, &h)) {
    if (LittleFS.exists(SHOW_PATH)) {
      localStats.rejects++;
      Serial.println(F("show: refused (bad magic, version, length or crc)"));
    }
    local.present = false;
    return;
  }
  local.h = h;
  local.present = true;

  if (!nvsHaveBrightness) wantBrightness = h.brightness;
  /* Power: the LOWER of the two statements about the same supply wins, and the
   * header speaks when NVS says nothing. */
  if (h.limitMa != 0 && (!nvsHaveLimit || h.limitMa < limitMa)) limitMa = h.limitMa;
  applyBrightnessGuard();
  showAnnounce(h);
}

static void localMount(void) {
  if (LittleFS.begin(false)) { Serial.println(F("fs: littlefs mounted")); return; }
  /* A fresh board has an unformatted data partition. Formatting it is safe here
   * because this partition exists only for the show — but it is announced, not
   * silent: a filesystem that keeps failing to mount is a real fault, and a
   * quiet reformat on every boot would hide it forever. */
  Serial.println(F("fs: mount failed, formatting the show partition"));
  if (LittleFS.begin(true)) Serial.println(F("fs: formatted"));
  else Serial.println(F("fs: unavailable, the player is off"));
}

/** Is there a baked show on flash? The one question the idle decision needs, and
 *  it has to be answerable in a build with no player at all. */
static bool haveShow(void) { return local.present; }

static void localService(void) {
  if (wall != WALL_LOCAL) return;
  localCompose();
  nvsFlushDeferred(tNow);
}

/** Repaint the current local frame — after a brightness change, say. */
static void localRepaint(void) {
  if (wall != WALL_LOCAL) return;
  local.painted = false;
  localCompose();
}

#else  // !PLAYER

/* The sink-only build: the same sketch it always was. The callers below stay
 * unconditional, so the streamed path is bit-identical with the player compiled
 * out and there is exactly one thing to blame if it ever is not. */
static void localStop(void) {}
static void localStart(void) {}
static bool haveShow(void) { return false; }
static void localService(void) {}
static void localRepaint(void) {}
static void localMount(void) {}
static void showAdopt(void) {}
static void nvsLoad(void) {}
static void nvsNote(uint32_t) {}
static void nvsFlushDeferred(uint32_t) {}

#endif  // PLAYER

/* ==========================================================================
 *  The standby: what an idle wall shows
 * ==========================================================================
 *
 *  No host, no filesystem, no bake, no format — the animation IS the firmware.
 *  That is the point: the wall has to be alive with nothing attached, and the
 *  cheapest thing that can never go stale, never needs uploading and works on a
 *  board with a blank flash is a function of millis().
 *
 *  Two constraints shape what is here.
 *
 *  IT PAINTS IN PHYSICAL ORDER. The firmware has no layout map (core/layout.js
 *  owns that, and §9.1 is why it stays there), so this addresses LED `i` as
 *  column i/20, row i%20 — which is this panel's measured wiring (index =
 *  20*col + row). If the wiring is ever re-measured the standby will come out
 *  mirrored or rotated; it will still be an animation, and it is standby art, so
 *  that is cosmetic rather than wrong. Content is unaffected: content is packed
 *  host-side by the real layout.
 *
 *  IT IS NOT core/animations.js. Those are the content library and they stay the
 *  host's — a C++ copy of `fire` would be a second answer to what the wall shows,
 *  and the two would drift apart exactly like the two power estimators nearly
 *  did. Standby art is a different job: it should read as "the wall is idling",
 *  the way a screensaver does, and being visibly calmer than any content is the
 *  feature rather than a compromise.
 */
#if STANDBY

static uint8_t  sbBuf[LED_BYTES];
static uint8_t  sbPattern   = (STANDBY < 1 ? 1 : (STANDBY > 4 ? 1 : STANDBY));
static uint32_t sbStartMs   = 0;
static uint32_t sbNextPaintMs = 0;

static const char *sbPatternName(uint8_t p) {
  switch (p) {
    case 2:  return "drift";
    case 3:  return "breathe";
    case 4:  return "cycle";
    default: return "ember";
  }
}

/* Integer hash -> 0..1. Same family of mixing as core/animations.js's hash (no
 * trig, so it is cheap and stable), but nothing depends on the two agreeing:
 * noise is not content. */
static uint32_t sbHash(uint32_t n) {
  n = (n << 13) ^ n;
  return n * (n * n * 15731u + 789221u) + 1376312589u;
}

static float sbUnit(int32_t x, int32_t y) {
  const uint32_t h = sbHash((uint32_t)x * 374761393u + (uint32_t)y * 668265263u);
  return (float)((h >> 8) & 0xFFFFFFu) / 16777215.0f;
}

/** Value noise with a smoothstep between the lattice points: no trig in the
 *  inner loop, and it tiles nothing — a slow scroll through it reads as drifting
 *  heat rather than as a repeating texture. */
static float sbNoise(float x, float y) {
  const int32_t xi = (int32_t)floorf(x);
  const int32_t yi = (int32_t)floorf(y);
  const float xf = x - (float)xi;
  const float yf = y - (float)yi;
  const float sx = xf * xf * (3.0f - 2.0f * xf);
  const float sy = yf * yf * (3.0f - 2.0f * yf);
  const float a = sbUnit(xi, yi);
  const float b = sbUnit(xi + 1, yi);
  const float c = sbUnit(xi, yi + 1);
  const float d = sbUnit(xi + 1, yi + 1);
  const float top = a + (b - a) * sx;
  const float bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/** Coordinate of LED `i` in the panel's measured physical order. */
static inline uint8_t sbCol(uint16_t i) { return (uint8_t)(i / 20u); }
static inline uint8_t sbRow(uint16_t i) { return (uint8_t)(i % 20u); }
static inline uint8_t sbByte(float v) {
  if (!(v > 0.0f)) return 0;            // also catches NaN
  if (v > 255.0f) return 255;
  return (uint8_t)v;
}

/** A slow amber fire, cooler toward the top. Two noise fields at different
 *  scales and speeds: the fast one is the flicker, the slow one is where the hot
 *  patches are. */
static void sbEmber(uint32_t tMs) {
  const float t = (float)tMs * 0.001f;
  for (uint16_t i = 0; i < NUM_LED; i++) {
    const float x = (float)sbCol(i);
    const float y = (float)sbRow(i);
    const float n1 = sbNoise(x * 0.30f + t * 0.50f, y * 0.22f - t * 1.10f);
    const float n2 = sbNoise(x * 0.11f - t * 0.25f, y * 0.45f - t * 2.10f);
    float heat = n1 * 0.62f + n2 * 0.38f;
    heat *= 1.0f - (y / 20.0f) * 0.50f;
    heat = heat * heat;
    const float g = heat * heat;
    sbBuf[i * 3 + 0] = sbByte(255.0f * heat);
    sbBuf[i * 3 + 1] = sbByte(110.0f * g);
    sbBuf[i * 3 + 2] = sbByte(18.0f * g * heat);
  }
}

/** Soft bands sliding sideways, blue into violet. The slowest of the three and
 *  the least attention-grabbing. */
static void sbDrift(uint32_t tMs) {
  const float t = (float)tMs * 0.001f;
  for (uint16_t i = 0; i < NUM_LED; i++) {
    const float u = (float)sbCol(i) * 0.16f + (float)sbRow(i) * 0.03f + t * 0.09f;
    const float v = 0.5f + 0.5f * sinf(u * 6.2831853f);
    const float w = v * v * (3.0f - 2.0f * v);
    sbBuf[i * 3 + 0] = sbByte(26.0f + 150.0f * w);
    sbBuf[i * 3 + 1] = sbByte(8.0f + 46.0f * w);
    sbBuf[i * 3 + 2] = sbByte(58.0f + 160.0f * (1.0f - w));
  }
}

/** One warm radial gradient pulsing on an 8 s cycle. The calmest of the three:
 *  what a wall should do at 3 a.m. */
static void sbBreathe(uint32_t tMs) {
  const float t = (float)tMs * 0.001f;
  const float k = 0.5f - 0.5f * cosf(t * 0.7853982f);   // 8 s period
  for (uint16_t i = 0; i < NUM_LED; i++) {
    const float dx = (float)sbCol(i) - 9.5f;
    const float dy = (float)sbRow(i) - 9.5f;
    const float d = sqrtf(dx * dx + dy * dy) / 13.4f;
    float v = k * (1.0f - d * 0.85f);
    if (!(v > 0.0f)) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    sbBuf[i * 3 + 0] = sbByte(255.0f * v);
    sbBuf[i * 3 + 1] = sbByte(150.0f * v * v);
    sbBuf[i * 3 + 2] = sbByte(60.0f * v * v * v);
  }
}

/** Standby brightness as a render scale, so the operator's brightness and the
 *  power guard still apply on top of it. */
static uint16_t sbScale(void) {
  return (STANDBY_LEVEL >= 255) ? 256u : (uint16_t)STANDBY_LEVEL;
}

static void sbCompose(void) {
  const uint32_t elapsed = tNow - sbStartMs;
  uint8_t p = sbPattern;
  if (p == 4) {
    p = (uint8_t)(1u + (elapsed / ((uint32_t)STANDBY_CYCLE_SEC * 1000u)) % 3u);
  }
  switch (p) {
    case 2:  sbDrift(elapsed); break;
    case 3:  sbBreathe(elapsed); break;
    default: sbEmber(elapsed); break;
  }
}

static void sbRepaint(void) {
  if (wall != WALL_STANDBY) return;
  sbCompose();
  renderFrom(sbBuf, sbScale());
}

static void standbyStart(void) {
  if (wall == WALL_STANDBY) return;    // never re-enter: re-stamping startMs replays the loop
  wall = WALL_STANDBY;
  sbStartMs = tNow;
  sbNextPaintMs = tNow;
  stats.standbyStarts++;
  Serial.print(F("standby: "));
  Serial.println(sbPatternName(sbPattern));
}

static void standbyStop(void) {
  if (wall != WALL_STANDBY) return;
  wall = WALL_DARK;
  Serial.println(F("standby: stopped"));
}

static void standbyService(void) {
  if (wall != WALL_STANDBY) return;
  if ((int32_t)(tNow - sbNextPaintMs) < 0) return;
  /* Deadline from the last frame, not from now, so the cadence does not sag by
   * however long a repaint took. */
  sbNextPaintMs += (1000u / (uint32_t)STANDBY_FPS);
  if ((int32_t)(tNow - sbNextPaintMs) >= 0) sbNextPaintMs = tNow + (1000u / (uint32_t)STANDBY_FPS);
  sbRepaint();
}

#else  // !STANDBY

/* Off: the wall goes dark when idle, which is what a calibration pass wants. The
 * call sites stay unconditional so there is one code path to reason about. */
static void standbyStart(void) {}
static void standbyStop(void) {}
static void standbyService(void) {}
static void sbRepaint(void) {}

#endif  // STANDBY

/* Current of whatever is on the wall right now: the streamed frame, or the
 * standby's own buffer at its own dimmer scale. Declared here because it is the
 * first point at which both buffers exist, and the status line calls it. */
static uint32_t estimateForWall(void) {
#if STANDBY
  if (wall == WALL_STANDBY) {
    const uint16_t level = (STANDBY_LEVEL >= 255) ? 256u : (uint16_t)STANDBY_LEVEL;
    const uint8_t eff = (uint8_t)(((uint32_t)activeBrightness * (uint32_t)level) >> 8);
    return estimateFrameMa(sbBuf, eff);
  }
#endif
  return estimateFrameMa(lastFrame, activeBrightness);
}

/* A frame just passed every check. Publish it, then render it. */
static void commitFrame(void) {
  /* A host frame ends any local playback, for good: the streamed path is the
   * richer one and a wall that kept flipping between them would be a wall with
   * two authors. The show stays on flash for the next boot. */
  localStop();
  standbyStop();

  memcpy(lastFrame, rxBuf, LED_BYTES);  // static -> static, no heap
  lastCompleteMs = tNow;
  stats.frames++;

  /* seq is a uint8 that wraps 255 -> 0. It is not a validity check — a lost
   * frame is simply replaced by the next complete one — but a delta other than
   * +1 tells us the host dropped a frame upstream. The subtraction is uint8
   * arithmetic, so 255 -> 0 reads as +1 and a wrap is never a false gap. */
  if (haveLastSeq && (uint8_t)(rxSeq - lastSeq) != 1u) stats.seqGaps++;
  lastSeq = rxSeq;
  haveLastSeq = true;
  wall = WALL_LIVE;
  renderWall(256u);

#if SELFTEST
  /* A real frame from the browser takes over the wall immediately. The
   * announcement is on the TRANSITION only: commitFrame() runs once per frame,
   * so printing unconditionally spams ~30 lines/s at 30 fps and buries the
   * status line that the calibration pass reads. */
  if (selftestActive) {
    selftestActive = false;
    Serial.println(F("selftest: stopped by host frame"));
  }
#endif
}

static void applyMeta(uint8_t brightness, uint16_t limit) {
  stats.meta++;
  wantBrightness = brightness;
  limitMa = limit;
  applyBrightnessGuard();
  /* The operator just dialled the wall, so the dial has to outlive a power
   * cycle: a wall that comes back at 255/8000mA after a brownout is a wall that
   * has to be re-set by hand at a party. Throttled — see nvsNote. */
  nvsNote(tNow);
  /* The new clamp has to reach the wall now, not at the next frame: repaint the
   * frame we already have. renderWall() applies the brightness itself, so this
   * is a real repaint, not a no-op. */
  if (wall == WALL_LIVE) {
    renderWall(256u);
  } else {
    /* Only one of these does anything: each is guarded by the wall state it
     * owns, so a brightness change reaches whichever renderer is on the panel
     * without this needing to know which one that is. */
    localRepaint();
    sbRepaint();
  }
}

/* Forward declaration: the rescan below replays bytes through the decoder. */
static void feedByte(uint8_t b);

/*
 * A record just failed its end-byte check. Throw it away, then look inside it
 * for a magic byte and replay from there.
 *
 * Why: a dropped byte makes the reader one byte short, so it swallows the next
 * frame's 0xA5 as payload and the record ends on that frame's seq byte instead
 * of 0x5A. The magic we need is therefore sitting in the buffer we just
 * rejected. Rescanning recovers that frame; scanning only forward loses it and
 * every byte read until the frame after it.
 *
 * Scan window matches core/frame.js exactly: the payload and the byte that
 * failed the end check, never the magic or the seq.
 *
 * In-place replay is safe without a scratch copy: the decoder writes rxBuf from
 * index 0 while this loop reads it from index k >= 0, and both advance one byte
 * per iteration, so the read index stays strictly ahead of the write index.
 *
 * `extra` is the byte that failed the end check when it lives outside `region`
 * (the frame case), or -1 when the region already contains it (the meta case).
 */
static void rescanRecord(const uint8_t *region, uint16_t len, uint16_t scanFrom, int16_t extra) {
  if (rescanning || rewindBudget == 0) return;  // one level, budgeted per drain

  uint16_t k = scanFrom;
  while (k < len && region[k] != FRAME_MAGIC && region[k] != META_MAGIC) k++;

  const bool extraIsMagic = (extra >= 0) &&
      (((uint8_t)extra) == FRAME_MAGIC || ((uint8_t)extra) == META_MAGIC);
  if (k >= len && !extraIsMagic) return;  // nothing to salvage: plain forward resync

  rewindBudget--;
  stats.rewinds++;
  stats.resyncs++;

  rescanning = true;
  for (uint16_t i = k; i < len; i++) feedByte(region[i]);
  if (extra >= 0) feedByte((uint8_t)extra);
  rescanning = false;
}

/* Byte-at-a-time decoder. Chunking is irrelevant: a frame may be split across
 * any number of Serial.read() boundaries, or arrive in one gulp. */
static void feedByte(uint8_t b) {
  lastByteMs = tNow;

  switch (state) {
    case RX_IDLE:
      if (b == FRAME_MAGIC) {
        state = RX_SEQ;
        rxN = 0;
      } else if (b == META_MAGIC) {
        state = RX_META;
        metaN = 0;
#if PLAYER
      } else if (b == SHOW_CHUNK_MAGIC) {
        state = RX_SHOW_HEAD;
        upHeadN = 0;
      } else if (b == SHOW_COMMIT_MAGIC) {
        state = RX_SHOW_COMMIT;
        upCommitN = 0;
#endif
      } else {
        stats.resyncs++;  // garbage before magic: skip it, keep scanning
      }
      break;

    case RX_SEQ:
      rxSeq = b;
      rxN = 0;
      state = RX_RGB;
      break;

    case RX_RGB:
      rxBuf[rxN++] = b;
      /* Exact length: a 1201st payload byte is never accepted. */
      if (rxN == LED_BYTES) state = RX_END;
      break;

    case RX_END:
      /* Reset first: the rescan below feeds bytes through this same machine. */
      state = RX_IDLE;
      rxN = 0;
      if (b == FRAME_END) {
        commitFrame();
      } else {
        /* End byte wrong => the whole frame is suspect. The pixels already
         * collected stay in rxBuf and are never shown. */
        stats.discarded++;
        rescanRecord(rxBuf, LED_BYTES, 0, (int16_t)b);
      }
      break;

    case RX_META:
      metaBuf[metaN++] = b;
      if (metaN == META_BYTES - 1u) {
        const bool ok = (metaBuf[META_BYTES - 2u] == FRAME_END);
        state = RX_IDLE;
        metaN = 0;
        if (ok) {
          applyMeta(metaBuf[0], (uint16_t)(metaBuf[1] | ((uint16_t)metaBuf[2] << 8)));
        } else {
          stats.discarded++;
          /* Same salvage as a frame: skip brightness, scan limitLo/limitHi/end. */
          rescanRecord(metaBuf, META_BYTES - 1u, 1, -1);
        }
      }
      break;

#if PLAYER
    /* ---- upload records ----------------------------------------------------
     *
     * Contiguity is the whole safety story here. A chunk must arrive at exactly
     * the offset that has already been written, so a record lost in the cable is
     * a REFUSAL rather than a hole. A hole would leave a file with a valid
     * length and a silent gap in the middle of a drawing, and every check — the
     * size, the crc over what was written, the header — would pass.
     */
    case RX_SHOW_HEAD:
      upHead[upHeadN++] = b;
      if (upHeadN == SHOW_CHUNK_HEAD) {
        upHeadN = 0;
        upSeq = upHead[0];
        const uint32_t offset = le32(upHead + 1);
        upChunkLen = le16(upHead + 5);
        state = RX_IDLE;
        if (upChunkLen == 0 || upChunkLen > SHOW_CHUNK_MAX) {
          upAbort(F("chunk length out of range"));
          break;
        }
        if (offset == 0) {
          /* Offset zero starts a new upload, whatever was in flight: a host that
           * restarts is not an error, and the file it abandoned is a temp. */
          if (!upBegin()) { upAbort(F("cannot open the temp file")); break; }
        } else if (!upActive || offset != upWritten) {
          upAbort(F("chunk offset is not where the file ends"));
          break;
        }
        upChunkGot = 0;
        state = RX_SHOW_DATA;
      }
      break;

    case RX_SHOW_DATA:
      upChunk[upChunkGot++] = b;
      if (upChunkGot == upChunkLen) state = RX_SHOW_TAIL;
      break;

    case RX_SHOW_TAIL:
      state = RX_IDLE;
      if (b != SHOW_RECORD_END) { upAbort(F("bad record tail")); break; }
      if (!upFile || !upActive || (uint16_t)upFile.write(upChunk, upChunkLen) != upChunkLen) {
        upAbort(F("short write to flash"));
        break;
      }
      /* Checksummed as it lands, so the commit record costs one compare rather
       * than a second pass over a file that was just written. */
      upCrc = crc32Update(upCrc, upChunk, upChunkLen);
      upWritten += upChunkLen;
      localStats.upChunks++;
      /*
       * ACK, and this is not decoration — it is the upload's flow control.
       *
       * A flash write takes milliseconds; a 921600 UART fills its ring buffer in
       * ~44 ms. Writing to LittleFS inside the serial drain therefore means the
       * host can overrun a 4 KB ring while the wall is in the flash, and the
       * first symptom is a chunk whose tail byte never arrives. Measured here:
       * an unpaced 6 KB upload aborted every time, the same file at 60 ms per
       * chunk landed first try.
       *
       * So the wall sets the pace. The host waits for this line before sending
       * the next chunk, which makes the upload exactly as fast as the flash and
       * turns a lost record into an immediate, specific error instead of a
       * twenty-second silence at commit time.
       */
      Serial.print(F("upload: chunk "));
      Serial.println(upWritten);
      break;

    case RX_SHOW_COMMIT:
      upCommitBuf[upCommitN++] = b;
      if (upCommitN == SHOW_COMMIT_BODY + 1u) {
        upCommitN = 0;
        state = RX_IDLE;
        if (upCommitBuf[SHOW_COMMIT_BODY] != SHOW_RECORD_END) { upAbort(F("bad commit tail")); break; }
        upCommit(le32(upCommitBuf), le32(upCommitBuf + 4));
      }
      break;
#endif  // PLAYER

    default:
      state = RX_IDLE;
      rxN = 0;
      metaN = 0;
      break;
  }
}

/* Truncated frame: the tail never arrives. Discard the partial and go back to
 * scanning for a magic byte. No rescan here: this record holds only the
 * truncated frame's own bytes, so any 0xA5 inside it is payload, and replaying
 * it would invent a frame that was never sent. */
static void abortTruncatedFrame(void) {
  if (state == RX_IDLE) return;
  if (tNow - lastByteMs >= (uint32_t)PARTIAL_GAP_MS) {
    stats.discarded++;
    state = RX_IDLE;
    rxN = 0;
    metaN = 0;
  }
}

/* Watchdog: no complete frame for STALE_MS => fade out instead of freezing a
 * half-updated wall. lastFrame is kept intact so the stream resumes instantly.
 *
 * What happens at the END of the fade is now a decision, and the default is still
 * to go dark. That is deliberate: a black wall is the honest report that the
 * tether is dead, and an operator standing in front of it can see that something
 * needs plugging in. LOCAL_FALLBACK_MS > 0 trades that diagnosis for continuity —
 * the baked show starts instead — and is the setting for a party, not for a
 * calibration pass. It is never on by default, because a wall that silently
 * switches to last month's gallery while a stream is broken is a wall that lies. */
static void serviceWall(void) {
  const uint32_t now = tNow;

  if (wall == WALL_LIVE) {
    if (STALE_MS != 0 && now - lastCompleteMs >= (uint32_t)STALE_MS) {
      wall = WALL_FADING;
      fadeStartMs = now;
      fadeStep = 0;
      stats.stale++;
    }
    return;
  }

  if (wall == WALL_FADING) {
    /* Step index comes straight from elapsed time, so the ramp always finishes
     * in FADE_MS no matter how fast loop() happens to spin. */
    const uint8_t step = (uint8_t)(((now - fadeStartMs) * (uint32_t)FADE_STEPS) / (uint32_t)FADE_MS);
    if (step <= fadeStep) return;
    fadeStep = step;
    if (fadeStep >= FADE_STEPS) {
      clearWall();
      wall = WALL_DARK;
    } else {
      renderWall((uint16_t)((256u * (uint32_t)(FADE_STEPS - fadeStep)) / (uint32_t)FADE_STEPS));
    }
    return;
  }

  /*
   * WALL_DARK: idle until the next complete frame arrives — or until the player
   * takes over.
   *
   * The fallback lives HERE and not at the end of the fade, and the difference
   * is the whole feature. A fade ends ~1.9 s after the stream stopped
   * (STALE_MS + FADE_MS), so a LOCAL_FALLBACK_MS above that — which is any value
   * worth setting — was never satisfied at that instant, and the wall went dark
   * and stayed dark: measured on the panel, `live -> fading -> dark` and then
   * nothing for as long as anyone watched. The wait has to be re-evaluated while
   * the wall is dark, which is what this branch does.
   *
   * The states above each RETURN, and this last branch must be tested for
   * WALL_DARK explicitly rather than assumed. It was assumed first, and because
   * WALL_LOCAL is not live and not fading it fell in here too — so the player
   * re-started itself on every loop iteration (measuring 1017 starts in the
   * first second), stamped startMs to now each time so it never left the opening
   * fade, and printed "local: playing" often enough to block on the UART and
   * stop the status line altogether. A state machine whose default arm does the
   * interesting thing is a state machine that does it to itself.
   *
   * With STALE_MS=0 this never runs, because WALL_LIVE never leaves live — "hold
   * the last frame" and "hand over to the gallery" are two answers to the same
   * question and only one of them can win. See firmware/README.md.
   */
  if (wall != WALL_DARK) return;
  if (LOCAL_FALLBACK_MS != 0 && now - lastCompleteMs >= (uint32_t)LOCAL_FALLBACK_MS) {
    /* The baked show is the richer answer and wins if one is on flash; standby is
     * what is always available, so it is the fallback of last resort. One rule,
     * and the SAME rule at boot (see setup) — a wall that prefers the gallery at
     * boot and the ember after a disconnect would look like it changed its mind. */
    if (haveShow()) {
      stats.localFalls++;
      localStart();
    } else {
      standbyStart();
    }
  }
}

#if STATUS
static void serviceStatus(void) {
  if (tNow - statusMs < (uint32_t)STATUS_INTERVAL_MS) return;
  statusMs = tNow;
  Serial.print(F("wall seq="));
  Serial.print(lastSeq);
  Serial.print(F(" br="));
  Serial.print(activeBrightness);
  Serial.print(F("/"));
  Serial.print(maxBrightnessForLimit(limitMa));
  Serial.print(F(" est="));
  /* The estimator reads the buffer that is ON the wall. During standby that is
   * not lastFrame, and reporting the stale stream's current for an idle wall is
   * the kind of number that gets believed: an all-night ember drawing nothing is
   * a supply check, not a curiosity. */
  Serial.print(estimateForWall());
  Serial.print(F("mA cap="));
  Serial.print(fullWhiteMa(activeBrightness));
  Serial.print(F("mA limit="));
  Serial.print(limitMa);
  Serial.print(F("mA state="));
  Serial.print(wall == WALL_LIVE ? "live"
             : wall == WALL_FADING ? "fading"
             : wall == WALL_LOCAL ? "local"
             : wall == WALL_STANDBY ? "standby"
             : "dark");
  Serial.print(F(" rx="));
  Serial.print((int)state);
  Serial.print(F(" frames="));
  Serial.print(stats.frames);
  Serial.print(F(" meta="));
  Serial.print(stats.meta);
  Serial.print(F(" disc="));
  Serial.print(stats.discarded);
  Serial.print(F(" resync="));
  Serial.print(stats.resyncs);
  Serial.print(F(" rewind="));
  Serial.print(stats.rewinds);
  Serial.print(F(" gaps="));
  Serial.print(stats.seqGaps);
  /* Visible proof the output stage exists: a null channel means every frame is
   * rendered and thrown away, which no other counter can show. */
  Serial.print(F(" rmt="));
  Serial.print(rmtChannel == nullptr ? 0 : 1);
  Serial.print(F(" stale="));
  Serial.print(stats.stale);
#if PLAYER
  /* The show: whether one is on flash, what it is, and what it has done. `fp=` is
   * the calibration fingerprint the bake froze into the pixels — the device cannot
   * recompute it (it has no layout map and runs no colour maths), so this is the
   * number an operator compares against the console's. See core/showfile.js. */
  Serial.print(F(" show="));
  Serial.print(local.present ? 1 : 0);
  Serial.print(F(" drawings="));
  Serial.print(local.present ? local.h.count : 0);
  Serial.print(F(" fp="));
  Serial.print(local.present ? local.h.fingerprint : 0);
  Serial.print(F(" worst="));
  Serial.print(local.present ? local.h.worstMa : 0);
  Serial.print(F("mA local="));
  Serial.print(localStats.frames);
  Serial.print(F(" seams="));
  Serial.print(localStats.seams);
  Serial.print(F(" falls="));
  Serial.print(stats.localFalls);
  Serial.print(F(" sb="));
  Serial.print(stats.standbyStarts);
#endif
  Serial.print(F(" rst="));
  Serial.print((int)esp_reset_reason());
  Serial.print(F(" boots="));
  Serial.print(bootCount);
  rtcLive[0] = stats.frames;
  rtcLive[1] = stats.discarded;
  rtcLive[2] = stats.resyncs;
  rtcLive[3] = stats.rewinds;
  rtcLive[4] = stats.seqGaps;
  /* frames/discarded/rewinds/gaps of the session that ended in a reset. */
  Serial.print(F(" prev="));
  Serial.print(rtcPrev[0]);
  Serial.print('/');
  Serial.print(rtcPrev[1]);
  Serial.print('/');
  Serial.print(rtcPrev[3]);
  Serial.print('/');
  Serial.println(rtcPrev[4]);
}
#endif

// ---------------------------------------------------------------------------
// Self-test (SELFTEST=1): validate wiring before the browser is connected
// ---------------------------------------------------------------------------
#if SELFTEST
/*
 * These patterns address PHYSICAL LED indices — the firmware has no layout map,
 * core/layout.js owns that. That is exactly what makes them useful for
 * milestone 5: what you see on the wall is the raw physical order, and the
 * browser's "what the wall actually sees" preview should match it.
 *
 *   ALL_RED      every LED full red      -> no dead pixels, no brownouts
 *   COLUMN_SWEEP LEDs where index%20==c  -> a column under the identity layout;
 *                                           reveals snake direction and strip
 *                                           boundaries
 *   WALK         one white LED, index 0..399 -> reads the physical order off
 *                                           the wall directly
 *   INDEX_MAP    colour encodes the index: R = 20+12*(i/20), G = 20+12*(i%20)
 *                -> every LED is identifiable; compare against core/layout.js
 *                output to calibrate snake/flipX/flipY/transpose
 * A real frame from the browser ends the self-test immediately.
 */
enum SelfPattern : uint8_t {
  SP_ALL_RED = 0,
  SP_COLUMN_SWEEP,
  SP_WALK,
  SP_INDEX_MAP,
  SP_COUNT
};

static const char *const SELF_NAMES[SP_COUNT] = {
    "ALL_RED", "COLUMN_SWEEP", "WALK", "INDEX_MAP"};

static uint8_t  pattern        = SP_ALL_RED;
static uint32_t patternStartMs = 0;
static uint32_t stepNextMs     = 0;
static uint16_t stepIndex      = 0;

static uint32_t patternMs(uint8_t p) {
  switch (p) {
    case SP_ALL_RED:       return (uint32_t)SELFTEST_RED_MS;
    case SP_COLUMN_SWEEP:  return (uint32_t)SELFTEST_COLUMN_MS;
    case SP_WALK:          return (uint32_t)SELFTEST_WALK_MS;
    default:               return (uint32_t)SELFTEST_INDEX_MS;
  }
}

static void selftestBeginPattern(uint8_t p) {
  pattern = p;
  patternStartMs = tNow;
  stepNextMs = tNow;
  stepIndex = 0;
  Serial.print(F("selftest: "));
  Serial.println(SELF_NAMES[p]);
  if (p == SP_INDEX_MAP) {
    Serial.println(F("  colour legend: R = 20 + 12*(index/20), G = 20 + 12*(index%20), B = 30"));
    Serial.println(F("  group 0..19 = index/20 (rows of the identity layout)"));
    Serial.println(F("  position 0..19 = index%20 (columns of the identity layout)"));
  }
}

static void selftestFillAll(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < NUM_LED; i++) {
    lastFrame[i * 3 + 0] = r;
    lastFrame[i * 3 + 1] = g;
    lastFrame[i * 3 + 2] = b;
  }
}

static void selftestRun(void) {
  const uint32_t now = tNow;

  if (now - patternStartMs >= patternMs(pattern)) {
    selftestBeginPattern((uint8_t)((pattern + 1u) % SP_COUNT));
  }

  switch (pattern) {
    case SP_ALL_RED:
      if (stepIndex == 0) {
        selftestFillAll(255, 0, 0);
        renderWall(256u);
        stepIndex = 1;
      }
      break;

    case SP_COLUMN_SWEEP: {
      if ((int32_t)(now - stepNextMs) < 0) break;
      stepNextMs = now + (uint32_t)SELFTEST_COLUMN_STEP_MS;
      const uint8_t col = (uint8_t)(stepIndex % 20u);
      for (uint16_t i = 0; i < NUM_LED; i++) {
        const bool on = (uint8_t)(i % 20u) == col;
        lastFrame[i * 3 + 0] = 0;
        lastFrame[i * 3 + 1] = on ? 255 : 0;
        lastFrame[i * 3 + 2] = on ? 40 : 0;
      }
      renderWall(256u);
      stepIndex++;
      break;
    }

    case SP_WALK: {
      if ((int32_t)(now - stepNextMs) < 0) break;
      stepNextMs = now + (uint32_t)SELFTEST_WALK_STEP_MS;
      selftestFillAll(0, 0, 0);
      const uint16_t i = stepIndex % NUM_LED;
      lastFrame[i * 3 + 0] = 255;
      lastFrame[i * 3 + 1] = 255;
      lastFrame[i * 3 + 2] = 255;
      renderWall(256u);
      stepIndex++;
      break;
    }

    case SP_INDEX_MAP:
      if (stepIndex == 0) {
        for (uint16_t i = 0; i < NUM_LED; i++) {
          lastFrame[i * 3 + 0] = (uint8_t)(20 + 12 * (i / 20u));
          lastFrame[i * 3 + 1] = (uint8_t)(20 + 12 * (i % 20u));
          lastFrame[i * 3 + 2] = 30;
        }
        renderWall(256u);
        stepIndex = 1;
      }
      break;

    default:
      selftestBeginPattern(SP_ALL_RED);
      break;
  }

  /* Keep the watchdog off while the self-test is driving the wall. */
  lastCompleteMs = tNow;
}
#endif  // SELFTEST

// ---------------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------------
void setup(void) {
  memset(rxBuf, 0, sizeof(rxBuf));
  memset(lastFrame, 0, sizeof(lastFrame));

  /* ESP32 wants the ring-buffer size set before begin(): show() for 400 LEDs
   * clocks out ~12 ms while the host keeps streaming. */
  Serial.setRxBufferSize(SERIAL_RX_BYTES);
  Serial.begin(BAUD);
  delay(50);
  Serial.println(F("init: serial up"));

  /* Counted before anything else can reset us, so the banner carries it. */
  if (bootMagic != BOOT_MAGIC) {
    bootMagic = BOOT_MAGIC;
    bootCount = 0;
    memset(rtcLive, 0, sizeof(rtcLive));
    memset(rtcPrev, 0, sizeof(rtcPrev));
  }
  /* Bank the previous session's totals before this one overwrites them. */
  memcpy(rtcPrev, rtcLive, sizeof(rtcPrev));
  memset(rtcLive, 0, sizeof(rtcLive));
  bootCount++;
  ledInit();

  /* The filesystem and the operator's dial, before the wall can show anything:
   * showAdopt() decides what the wall is allowed to play and with which
   * brightness, and it needs NVS already loaded to know whether an operator has
   * ever dialled this wall. See showAdopt() for the precedence. */
  localMount();
  nvsLoad();
  showAdopt();
  applyBrightnessGuard();

  wall = WALL_DARK;
  state = RX_IDLE;
  tNow = millis();
  lastCompleteMs = tNow;
  lastByteMs = tNow;
  statusMs = tNow;
#if PLAYER
  nvsWriteMs = tNow;   // the throttle starts at boot, not at 0
#endif

#if SELFTEST
  selftestBeginPattern(SP_ALL_RED);
  Serial.println(F("selftest active: a complete frame from the host takes over immediately"));
#endif

  Serial.print(F("sink ready pin="));
  Serial.print(PIN_DATA);
  Serial.print(F(" leds="));
  Serial.print(NUM_LED);
  Serial.print(F(" baud="));
  Serial.print(BAUD);
  Serial.print(F(" frame="));
  Serial.print(FRAME_BYTES);
  Serial.print(F("B limit="));
  Serial.print(limitMa);
  Serial.print(F("mA br="));
  Serial.print(activeBrightness);
  Serial.print(F(" rst="));
  Serial.print((int)esp_reset_reason());
  Serial.print(F(" boots="));
  Serial.print(bootCount);
  Serial.print(F(" player="));
  Serial.print(PLAYER);
#if STANDBY
  Serial.print(F(" standby="));
  Serial.print(sbPatternName(sbPattern));
  Serial.print(F("@"));
  Serial.print(STANDBY_FPS);
  Serial.print(F("fps level="));
  Serial.print(STANDBY_LEVEL);
#endif
  Serial.println();

  /* Boot: whoever can show something, does. The baked show if there is one and
   * LOCAL_BOOT allows it, and otherwise the standby — which needs nothing at all,
   * so a board with a blank flash still comes up alive.
   *
   * Under SELFTEST the wall keeps the wiring patterns instead: a calibration pass
   * must not be interrupted by a gallery or an ember, and the self-test's real job
   * is to prove the wiring before anything pretty is on the panel. */
#if !SELFTEST
  bool booted = false;
#  if PLAYER && LOCAL_BOOT
  if (local.present) { localStart(); booted = true; }
#  endif
  if (!booted) standbyStart();     // a no-op when STANDBY=0
#  if PLAYER
  if (!booted && !local.present) {
    if (LittleFS.exists(SHOW_PATH)) Serial.println(F("local: the show on flash was refused"));
    else Serial.println(F("local: no show on flash (standby is what runs instead)"));
  }
#  endif
#endif
}

void loop(void) {
  tNow = millis();  // one clock read per iteration, shared by everything below

  /* Drain whatever the host has sent. No readBytes(), no timeout, no assumed
   * alignment — the state machine finds its own frame boundaries. The rewind
   * budget is refilled per drain, mirroring core/frame.js's per-feed() budget. */
  rewindBudget = MAX_REWINDS;
  int pending = Serial.available();
  while (pending-- > 0) {
    const int b = Serial.read();
    if (b < 0) break;
    feedByte((uint8_t)b);
  }

  abortTruncatedFrame();
  serviceWall();
  localService();
  standbyService();

#if SELFTEST
  if (selftestActive) selftestRun();
#endif

#if STATUS
  serviceStatus();
#endif
}

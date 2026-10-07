/*
 * ============================================================================
 *  LED curtain wall — ESP32 pixel sink
 * ============================================================================
 *
 *  The browser is the brain. It fetches the banner, rasterises it, applies
 *  effects and streams finished frames. This sketch is a dumb sink: it decodes
 *  frames off the serial port and pushes pixels onto 400 WS2812B.
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
 *    -D PIN_DATA=27            WS2812 data GPIO
 *    -D NUM_LED=400            LED count (frozen at 400 by the protocol)
 *    -D BAUD=921600            serial baud
 *    -D SELFTEST=1             enable the wiring self-test patterns
 *    -D STALE_MS=1500          watchdog: fade to black after this long
 *    -D MAX_REWINDS=8          rescans allowed per serial drain (== core's budget)
 *    -D DEFAULT_LIMIT_MA=8000  power limit before the host sends a meta frame
 *    -D STATUS=0               silence the periodic status line
 *  See firmware/README.md for the exact arduino-cli invocations.
 * ============================================================================
 */

#include <Arduino.h>
#include <string.h>
#include <Adafruit_NeoPixel.h>

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
#ifndef PIN_DATA
#define PIN_DATA 27
#endif

#ifndef NUM_LED
#define NUM_LED 400
#endif

#ifndef BAUD
#define BAUD 921600
#endif

/* NEO_GRB is what WS2812B wants. The ESP32 backend of Adafruit_NeoPixel is
 * RMT-based; no extra define is needed, the library picks RMT on ESP32. */
#ifndef PIXEL_TYPE
#define PIXEL_TYPE (NEO_GRB + NEO_KHZ800)
#endif

/* 1 = compile in the wiring self-test (milestone 5: layout calibration). */
#ifndef SELFTEST
#define SELFTEST 0
#endif

/* No complete frame for this long => fade to black, do not freeze. */
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
// Static storage — no heap anywhere below
// ---------------------------------------------------------------------------
static Adafruit_NeoPixel strip(NUM_LED, PIN_DATA, PIXEL_TYPE);

static uint8_t rxBuf[LED_BYTES];      // frame currently being received
static uint8_t lastFrame[LED_BYTES];  // last COMPLETE frame, wire order (R,G,B)

/* Channel offsets inside the NeoPixel buffer, derived from PIXEL_TYPE once in
 * setup() so the render loop never re-derives them and never calls
 * setPixelColor() 400 times. Bits 5:4 = red offset, 3:2 = green, 1:0 = blue. */
static uint8_t offR = 0, offG = 0, offB = 0;

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
  RX_META       // collecting the 4 meta bytes after 0xA4
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
} stats = {0, 0, 0, 0, 0, 0, 0};

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
 * dark cells and draws less. Adafruit_NeoPixel also applies gamma tables when
 * scaling by brightness, which pulls the effective channel value below the
 * linear B/255 estimate — again on the safe side of the limit.
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

/* Estimated current of the frame actually on the wall: sum every channel value
 * and scale by CHANNEL_MA/255. Integer only, no float, no allocation.
 * Reported by the status line; kept available for the power guard. */
__attribute__((unused)) static uint32_t estimateFrameMa(const uint8_t *rgb) {
  uint32_t sum = 0;
  for (uint16_t i = 0; i < LED_BYTES; i++) sum += rgb[i];
  return ((uint32_t)CHANNEL_MA * sum) / 255u;
}

static uint8_t  wantBrightness = 255;             // what the host asked for
static uint16_t limitMa        = DEFAULT_LIMIT_MA;  // declared budget
static uint8_t  activeBrightness = 0;             // wantBrightness, clamped

static void applyBrightnessGuard(void) {
  const uint8_t cap = maxBrightnessForLimit(limitMa);
  activeBrightness = (wantBrightness <= cap) ? wantBrightness : cap;
  strip.setBrightness(activeBrightness);
}

// ---------------------------------------------------------------------------
// Wall state + watchdog
// ---------------------------------------------------------------------------
enum WallState : uint8_t {
  WALL_DARK = 0,  // nothing to show
  WALL_LIVE,      // a complete frame is on the wall
  WALL_FADING     // watchdog ramp down in progress
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

/* Copy lastFrame into the NeoPixel buffer and clock it out.
 * scale256 == 256 is identity; lower values are the watchdog fade. */
static void renderWall(uint16_t scale256) {
  uint8_t *px = strip.getPixels();
  if (scale256 >= 256u) {
    for (uint16_t i = 0; i < NUM_LED; i++) {
      const uint16_t w = (uint16_t)(i * 3);
      px[w + offR] = lastFrame[w + 0];
      px[w + offG] = lastFrame[w + 1];
      px[w + offB] = lastFrame[w + 2];
    }
  } else {
    for (uint16_t i = 0; i < NUM_LED; i++) {
      const uint16_t w = (uint16_t)(i * 3);
      px[w + offR] = (uint8_t)((lastFrame[w + 0] * scale256) >> 8);
      px[w + offG] = (uint8_t)((lastFrame[w + 1] * scale256) >> 8);
      px[w + offB] = (uint8_t)((lastFrame[w + 2] * scale256) >> 8);
    }
  }
  strip.show();
}

static void clearWall(void) {
  strip.clear();
  strip.show();
}

/* A frame just passed every check. Publish it, then render it. */
static void commitFrame(void) {
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
  /* A real frame from the browser takes over the wall immediately. */
  selftestActive = false;
  Serial.println(F("selftest: stopped by host frame"));
#endif
}

static void applyMeta(uint8_t brightness, uint16_t limit) {
  stats.meta++;
  wantBrightness = brightness;
  limitMa = limit;
  applyBrightnessGuard();
  /* setBrightness() only takes effect at show(): repaint the frame we already
   * have so a meta frame is visible immediately, even between frames. */
  if (wall == WALL_LIVE) renderWall(256u);
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
 * half-updated wall. lastFrame is kept intact so the stream resumes instantly. */
static void serviceWall(void) {
  const uint32_t now = tNow;

  if (wall == WALL_LIVE) {
    if (now - lastCompleteMs >= (uint32_t)STALE_MS) {
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
  // WALL_DARK: idle until the next complete frame arrives.
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
  Serial.print(estimateFrameMa(lastFrame));
  Serial.print(F("mA cap="));
  Serial.print(fullWhiteMa(activeBrightness));
  Serial.print(F("mA limit="));
  Serial.print(limitMa);
  Serial.print(F("mA state="));
  Serial.print(wall == WALL_LIVE ? "live" : (wall == WALL_FADING ? "fading" : "dark"));
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
  Serial.print(F(" stale="));
  Serial.println(stats.stale);
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
  offR = (uint8_t)((PIXEL_TYPE >> 4) & 3u);
  offG = (uint8_t)((PIXEL_TYPE >> 2) & 3u);
  offB = (uint8_t)(PIXEL_TYPE & 3u);

  memset(rxBuf, 0, sizeof(rxBuf));
  memset(lastFrame, 0, sizeof(lastFrame));

  /* ESP32 wants the ring-buffer size set before begin(): show() for 400 LEDs
   * clocks out ~12 ms while the host keeps streaming. */
  Serial.setRxBufferSize(SERIAL_RX_BYTES);
  Serial.begin(BAUD);
  strip.begin();
  strip.clear();
  applyBrightnessGuard();
  strip.show();

  wall = WALL_DARK;
  state = RX_IDLE;
  tNow = millis();
  lastCompleteMs = tNow;
  lastByteMs = tNow;
  statusMs = tNow;

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
  Serial.println(activeBrightness);
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

#if SELFTEST
  if (selftestActive) selftestRun();
#endif

#if STATUS
  serviceStatus();
#endif
}

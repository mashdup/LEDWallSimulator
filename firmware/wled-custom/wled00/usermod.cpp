#include "wled.h"

/*
 * LED curtain wall — serial sink (v1 usermod).
 *
 * WLED keeps its proof-tested Apa106/PL9823 RMT output and gets a *new* serial
 * front end. Adalight is compiled out (WLED_DISABLE_ADALIGHT), so this file owns
 * Serial outright: no second reader, no state machine fighting over bytes.
 *
 * Wire protocol — fixed-size, self-clocking, drop-safe. Byte-for-byte the same
 * records the browser already emits (core/frame.js), so web/sinks.js SerialSink
 * and tools/bridge.js drive this build with no host change.
 *
 *   Frame (1203 B):  0xA5 | seq u8 | 1200 B RGB (physical LED order) | 0x5A
 *   Meta  (   5 B):  0xA4 | brightness u8 | limitMa u16 LE            | 0x5A
 *
 * Drop-safety: the last COMPLETE frame is what renders. A record is complete
 * only when it began on a magic byte, read exactly its body length, and ended on
 * 0x5A. Anything else is thrown away whole. On a rejected record the decoder
 * rewinds to the first magic *inside the discarded bytes* and replays from
 * there — that magic is the next frame, which is exactly what one dropped byte
 * hides. Rewinds are budgeted, and replay is one level deep, so a payload full
 * of 0xA5 cannot make this quadratic. This mirrors core/frame.js FrameDecoder.
 *
 * Why this exists: the ESP32-S3's native USB serial loses bytes
 * (espressif/arduino-esp32#9378), and WiFi makes it worse. Adalight has no
 * resync, so a single lost byte flickers the wall in random colours for the rest
 * of that frame *and* the next. Here a lost byte costs one frame.
 *
 * Build flags (see platformio_override.ini):
 *   LED_WALL_LED_COUNT        400     must match PIXEL_COUNTS
 *   LED_WALL_CHANNEL_MA       20      per-channel mA, as core/power.js
 *   LED_WALL_DEFAULT_LIMIT_MA 8000    until the host sends a meta frame
 *   LED_WALL_PARTIAL_GAP_MS   40      a whole frame is ~13 ms of wire time
 *   LED_WALL_MAX_REWINDS      8       rescans per drain of the serial buffer
 *   LED_WALL_BAUD             921600  ignored on a USB-CDC port
 *   LED_WALL_RX_BUFFER        8192    see userSetup()
 *   LED_WALL_STATUS           1       print a 1 Hz status line (serialCanTX)
 *   LED_WALL_WIFI_OFF         0       1 => drop WiFi on the first frame
 */

#ifndef LED_WALL_LED_COUNT
  #define LED_WALL_LED_COUNT 400
#endif
#ifndef LED_WALL_CHANNEL_MA
  #define LED_WALL_CHANNEL_MA 20
#endif
#ifndef LED_WALL_DEFAULT_LIMIT_MA
  #define LED_WALL_DEFAULT_LIMIT_MA 8000
#endif
#ifndef LED_WALL_PARTIAL_GAP_MS
  #define LED_WALL_PARTIAL_GAP_MS 40
#endif
#ifndef LED_WALL_MAX_REWINDS
  #define LED_WALL_MAX_REWINDS 8
#endif
#ifndef LED_WALL_BAUD
  #define LED_WALL_BAUD 921600
#endif
#ifndef LED_WALL_RX_BUFFER
  #define LED_WALL_RX_BUFFER 8192
#endif
#ifndef LED_WALL_STATUS
  #define LED_WALL_STATUS 1
#endif
#ifndef LED_WALL_WIFI_OFF
  #define LED_WALL_WIFI_OFF 0
#endif

static constexpr uint8_t  WALL_FRAME_MAGIC = 0xA5;
static constexpr uint8_t  WALL_META_MAGIC  = 0xA4;
static constexpr uint8_t  WALL_END         = 0x5A;
static constexpr uint16_t WALL_RGB_BYTES   = LED_WALL_LED_COUNT * 3u;   // 1200
static constexpr uint16_t WALL_FRAME_BODY  = 1u + WALL_RGB_BYTES + 1u;  // 1202
static constexpr uint16_t WALL_META_BODY   = 4u;                        // bright + limit(2) + end

enum : uint8_t { RX_IDLE = 0, RX_FRAME, RX_META };

// --- decoder state -----------------------------------------------------------
static uint8_t  rxBody[WALL_FRAME_BODY];  // scratch record; only committed when complete
static uint16_t rxN        = 0;
static uint8_t  rxState    = RX_IDLE;
static uint32_t rxLastMs   = 0;

// Replayed tail of a rejected record. One record deep, by construction.
static uint8_t  replayBuf[WALL_FRAME_BODY];
static uint16_t replayLen  = 0;
static uint16_t replayPos  = 0;
static bool     replaying  = false;
static uint8_t  rewindsLeft = 0;

static uint8_t  lastSeq     = 0;
static bool     haveLastSeq = false;

// --- power contract ----------------------------------------------------------
static uint8_t  wantBrightness   = 255;
static uint16_t limitMa          = LED_WALL_DEFAULT_LIMIT_MA;
static uint8_t  activeBrightness = 255;

// --- counters (status line) --------------------------------------------------
static uint32_t statFrames    = 0;
static uint32_t statMeta      = 0;
static uint32_t statDiscarded = 0;
static uint32_t statResyncs   = 0;
static uint32_t statRewinds   = 0;
static uint32_t statGaps      = 0;

#if LED_WALL_WIFI_OFF
static bool     wifiPulled = false;
static uint32_t statWifiOff = 0;   // radioOff() calls; >1 means WLED is fighting it

/*
 * Kill the radio.
 *
 * This only holds because setup.sh compiles WLED::handleConnection() out when
 * LED_WALL_WIFI_OFF is set, and that function is the only caller of
 * initConnection(). Racing it instead was measured and rejected: left running it
 * brought the radio back every ~9 s, and because a teardown blocks for far longer
 * than the 8 KB RX ring absorbs at 921600, each one cost ~1000 bytes of stream
 * (visible as a resync burst). The state writes below are belt-and-braces for any
 * path we have not accounted for; userLoop() re-checks each pass.
 */
static void radioOff() {
  statWifiOff++;
  WiFi.disconnect(true);
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  apActive = false;
  interfacesInited = false;
  lastReconnectAttempt = millis();
}
#endif

/*
 * Brightness the declared current limit allows, worst case: every LED full white.
 *   I(B) = LED_COUNT * 3 * CHANNEL_MA * B / 255  =>  B_max = limit * 255 / denom
 * Full-white bound, so conservative. Same integer arithmetic as the sketch
 * (firmware/firmware.ino, maxBrightnessForLimit).
 */
static uint8_t maxBrightnessForLimit(uint16_t limit) {
  const uint32_t denom = (uint32_t)LED_WALL_LED_COUNT * 3u * (uint32_t)LED_WALL_CHANNEL_MA;
  uint32_t b = ((uint32_t)limit * 255u) / denom;
  if (b > 255u) b = 255u;
  return (uint8_t)b;
}

/*
 * activeBrightness is wantBrightness clamped by the limit, and it is pushed into
 * WLED's own brightness model so the stream owns the wall's brightness:
 * realtimeLock() and applyBri() both call strip.setBrightness(scaledBri(briT))
 * when briT is 0, and would otherwise clobber us with briLast. Keeping bri/briT/
 * briLast in step with what actually renders makes those paths agree.
 */
static void applyBrightnessGuard() {
  const uint8_t cap = maxBrightnessForLimit(limitMa);
  activeBrightness = (wantBrightness <= cap) ? wantBrightness : cap;
  bri = briT = briLast = activeBrightness;
  strip.setBrightness(scaledBri(activeBrightness), true);
}

static void commitFrame() {
  const uint8_t seq = rxBody[0];
  // seq is not a validity check; a delta != +1 just says the host dropped one.
  // uint8_t arithmetic, so 255 -> 0 reads as +1 and a wrap is never a false gap.
  if (haveLastSeq && (uint8_t)(seq - lastSeq) != 1u) statGaps++;
  lastSeq = seq;
  haveLastSeq = true;

  /*
   * Lock FIRST, then paint. On the first frame realtimeLock() is what clears the
   * strip ("for i: setPixelColor(i, BLACK)") before entering realtime mode, so
   * painting ahead of it would have that first frame wiped and shown black.
   * realtimeLock() also installs the timeout that keeps realtime engaged; while
   * realtimeOverride is set WLED deliberately ignores incoming frames, so we
   * skip the paint and the show exactly as the Adalight reader did.
   */
  realtimeLock(realtimeTimeoutMs, REALTIME_MODE_ADALIGHT);
  if (!realtimeOverride) {
    const uint8_t *rgb = rxBody + 1;
    uint16_t n = strip.getLengthTotal();
    if (n > (uint16_t)LED_WALL_LED_COUNT) n = (uint16_t)LED_WALL_LED_COUNT;
    for (uint16_t i = 0; i < n; i++) {
      setRealtimePixel(i, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 0);
    }
    strip.show();
  }
  statFrames++;
}

static void applyMeta() {
  wantBrightness = rxBody[0];
  limitMa = (uint16_t)rxBody[1] | ((uint16_t)rxBody[2] << 8);
  applyBrightnessGuard();
  // A brightness change has to reach the wall now, not at the next frame.
  if (realtimeMode) {
    realtimeLock(realtimeTimeoutMs, REALTIME_MODE_ADALIGHT);
    if (!realtimeOverride) strip.show();
  }
  statMeta++;
}

static void feedByte(uint8_t b) {
  if (rxState == RX_IDLE) {
    if (b == WALL_FRAME_MAGIC)      { rxState = RX_FRAME; rxN = 0; }
    else if (b == WALL_META_MAGIC)  { rxState = RX_META;  rxN = 0; }
    else                            { statResyncs++; }
    return;
  }

  const uint16_t need = (rxState == RX_FRAME) ? WALL_FRAME_BODY : WALL_META_BODY;
  rxBody[rxN++] = b;
  if (rxN < need) return;

  if (rxBody[need - 1] == WALL_END) {
    if (rxState == RX_FRAME) commitFrame();
    else                     applyMeta();
    rxState = RX_IDLE;
    rxN = 0;
    return;
  }

  // Bad end byte: the whole record is suspect, so throw it away.
  statDiscarded++;
  rxState = RX_IDLE;
  rxN = 0;

  // A dropped byte makes the reader short, so it swallowed the next frame's
  // magic as payload and the record ended on that frame's seq instead of 0x5A.
  // The magic needed is sitting in the record just rejected. Rescan it (from
  // index 1: the magic at index 0 is the one that already failed) and replay
  // from the next magic onward. One level deep: a bad end found during a replay
  // is discarded and never rescanned again.
  if (replaying) return;
  for (uint16_t k = 1; k < need; k++) {
    if (rxBody[k] == WALL_FRAME_MAGIC || rxBody[k] == WALL_META_MAGIC) {
      if (rewindsLeft == 0) return;  // budget spent for this drain
      rewindsLeft--;
      statRewinds++;
      statResyncs++;
      replayLen = need - k;
      replayPos = 0;
      memcpy(replayBuf, rxBody + k, replayLen);
      return;
    }
  }
}

// Drain a queued replay before the live byte that follows it, exactly once deep.
static void drainReplay() {
  while (replayPos < replayLen) {
    const uint8_t rb = replayBuf[replayPos++];
    if (replayPos >= replayLen) { replayPos = 0; replayLen = 0; }
    replaying = true;
    feedByte(rb);
    replaying = false;
  }
}

void userSetup() {
#if !ARDUINO_USB_CDC_ON_BOOT
  /*
   * The core began Serial at 115200 for the console; the wall streams at 921600.
   *
   * The RX buffer matters more than the baud. strip.show() blocks for the RMT
   * transfer, and 400 APA106 beads at a 1.7 us bit are ~16 ms of wire time. At
   * 921600 that is ~1500 bytes arriving while nothing is reading, against the
   * core's default 256-byte ring — so the buffer has to be enlarged or the
   * stream overflows during every single show(). end() first: this core can only
   * resize the ring before begin().
   */
  Serial.end();
  Serial.setRxBufferSize(LED_WALL_RX_BUFFER);
  Serial.begin(LED_WALL_BAUD);
  Serial.setTimeout(50);
#endif

  applyBrightnessGuard();

#if LED_WALL_STATUS
  if (serialCanTX) {
    Serial.printf_P(PSTR("wall sink ready leds=%u baud=%u limit=%umA cap=%u/%u proto=A5/A4\n"),
                    (unsigned)strip.getLengthTotal(), (unsigned)LED_WALL_BAUD,
                    (unsigned)LED_WALL_DEFAULT_LIMIT_MA,
                    (unsigned)maxBrightnessForLimit(limitMa), (unsigned)activeBrightness);
  }
#endif
}

void userConnected() {
  // Nothing to do: this build is driven by the wire, not the network.
}

void userLoop() {
#if LED_WALL_WIFI_OFF
  /*
   * Radio off once, at boot, then a cheap check each pass.
   *
   * The teardown blocks for a long time, which must NOT happen mid-stream: at
   * 921600 the 8 KB RX ring is only ~89 ms of slack and the spill shows up as a
   * burst of resyncs. Hence once, before any frame can arrive. Afterwards the
   * check is a cached mode field, so it costs nothing; radioOff() runs again only
   * if something we have not accounted for turned the radio back on.
   */
  if (!wifiPulled) { wifiPulled = true; radioOff(); }
  else if (WiFi.getMode() != WIFI_OFF) radioOff();
#endif

  if (!serialCanRX) return;

  // A record that stopped mid-frame is never going to finish.
  if (rxState != RX_IDLE && (uint32_t)(millis() - rxLastMs) > LED_WALL_PARTIAL_GAP_MS) {
    rxState = RX_IDLE;
    rxN = 0;
  }

  /*
   * Read what has arrived, but bounded: commitFrame() calls strip.show(), which
   * blocks for the RMT transfer. Reading the whole ring here would just delay
   * that show by the same amount and change nothing about the byte budget, so
   * the cap only keeps loop() responsive. The RX ring is what absorbs show().
   */
  rewindsLeft = LED_WALL_MAX_REWINDS;
  uint16_t budget = 2048;
  while (budget-- > 0 && Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    rxLastMs = millis();
    feedByte((uint8_t)c);
    drainReplay();
  }

#if LED_WALL_STATUS
  static uint32_t lastStatus = 0;
  const uint32_t now = millis();
  if (serialCanTX && now - lastStatus >= 1000) {
    lastStatus = now;
    Serial.printf_P(PSTR("wall frames=%lu meta=%lu disc=%lu resync=%lu rewind=%lu gaps=%lu br=%u/%u lim=%u wifi=%u woff=%lu state=%s\n"),
                    (unsigned long)statFrames, (unsigned long)statMeta,
                    (unsigned long)statDiscarded, (unsigned long)statResyncs,
                    (unsigned long)statRewinds, (unsigned long)statGaps,
                    (unsigned)activeBrightness, (unsigned)wantBrightness,
                    (unsigned)limitMa, (unsigned)WiFi.getMode(),
#if LED_WALL_WIFI_OFF
                    (unsigned long)statWifiOff,
#else
                    0ul,
#endif
                    realtimeMode ? "live" : "idle");
  }
#endif
}

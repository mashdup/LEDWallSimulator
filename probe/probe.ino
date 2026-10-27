/* PIN PROBE — a disposable bring-up sketch, NOT the wall firmware.
 *
 * Purpose: find where this board's LEDs and beads live, with eyes only.
 *
 * Phase A: drive every free GPIO HIGH one at a time. Plain status LEDs light
 * when their pin is HIGH. Each pin is announced on Serial at 921600.
 *
 * Phase B: for each candidate data pin, clock out a short ALL-RED field with
 * the beads' own 350/1350 ns bit timing (copied from firmware.ino). A WS2812/
 * SK6812-class LED on that pin lights (any colour = that pin). GPIO21 is in the
 * list: if the shifter chain is alive, the WALL lights red during its step and
 * stays latched after.
 *
 * Avoids: 26-32 (flash), 33-37 (octal PSRAM on R8 modules), 43/44 (UART0),
 * 19/20 (USB D-/D+), 0/3/46 (strapping).
 */
#include <Arduino.h>
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"

static const int highPins[] = {
  1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 21, 35, 38, 39, 40, 41, 42, 47, 48
};

static const int rmtPins[] = {
  48, 45, 2, 8, 16, 17, 21, 35, 38, 39, 40, 14, 15, 1, 3
};

static const uint32_t RMT_RESOLUTION_HZ = 20u * 1000u * 1000u;
static const uint16_t TICKS_T0H = 7;
static const uint16_t TICKS_T0L = 27;
static const uint16_t TICKS_T1H = 27;
static const uint16_t TICKS_T1L = 7;

/* 4 beads worth of red in BGR wire order: B=0 G=0 R=FF repeated. */
static uint8_t redBytes[12];

static void clockOut(int pin) {
  rmt_channel_handle_t ch = nullptr;
  rmt_encoder_handle_t enc = nullptr;
  rmt_tx_channel_config_t cfg = {};
  cfg.clk_src = RMT_CLK_SRC_DEFAULT;
  cfg.gpio_num = (gpio_num_t)pin;
  cfg.resolution_hz = RMT_RESOLUTION_HZ;
  cfg.mem_block_symbols = 64;
  cfg.trans_queue_depth = 4;
  if (rmt_new_tx_channel(&cfg, &ch) != ESP_OK) return;
  rmt_bytes_encoder_config_t ec = {};
  ec.bit0.level0 = 1; ec.bit0.duration0 = TICKS_T0H;
  ec.bit0.level1 = 0; ec.bit0.duration1 = TICKS_T0L;
  ec.bit1.level0 = 1; ec.bit1.duration0 = TICKS_T1H;
  ec.bit1.level1 = 0; ec.bit1.duration1 = TICKS_T1L;
  ec.flags.msb_first = 1;
  if (rmt_new_bytes_encoder(&ec, &enc) == ESP_OK) {
    if (rmt_enable(ch) == ESP_OK) {
      rmt_transmit_config_t tx = {};
      tx.loop_count = 0;
      /* Repeat the field so a human eye catches it and beads latch it. */
      for (int i = 0; i < 30; i++) {
        if (rmt_transmit(ch, enc, redBytes, sizeof(redBytes), &tx) == ESP_OK)
          rmt_tx_wait_all_done(ch, 200);
        delay(50);
      }
    }
    rmt_disable(ch);
  }
  rmt_del_encoder(enc);
  rmt_del_channel(ch);
}

void setup() {
  Serial.begin(921600);
  delay(1500);
  Serial.println(F("PROBE: phase A - plain GPIO HIGH sweep, watch the board"));
  for (unsigned i = 0; i < sizeof(highPins) / sizeof(highPins[0]); i++) {
    int p = highPins[i];
    Serial.printf("A: pin %d HIGH\r\n", p);
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
    delay(1200);
    digitalWrite(p, LOW);
    pinMode(p, INPUT);
  }
  for (unsigned i = 0; i < sizeof(redBytes); i++)
    redBytes[i] = (i % 3 == 2) ? 0xFF : 0x00;  // B,G,R -> red
  Serial.println(F("PROBE: phase B - red field per candidate pin, watch LED AND WALL"));
}

void loop() {
  for (unsigned i = 0; i < sizeof(rmtPins) / sizeof(rmtPins[0]); i++) {
    int p = rmtPins[i];
    Serial.printf("B: pin %d red-field\r\n", p);
    clockOut(p);
    delay(800);
  }
  Serial.println(F("PROBE: cycle done, repeating. Wall stays latched on last lit pin."));
  delay(3000);
}

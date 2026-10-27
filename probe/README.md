# probe — a disposable bring-up sketch

**Not part of the app or the wall firmware.** Flash it, watch what lights, flash
the real firmware back. It exists because "the wall is dark and every counter is
clean" is ambiguous, and the counters cannot resolve it — the decoder sits
*upstream* of the data pin, so a board that decodes 1208/1208 frames proves the
serial link is alive and nothing about whether edges reach the beads. See
`../firmware/README.md`, "Bring-up order".

It answers two questions with eyes only, no multimeter:

1. **Where are this board's LEDs?** Phase A drives every free GPIO HIGH in turn
   and prints the pin number. A plain status LED lights on its own pin. (Board
   look-alikes disagree about this: a DevKitC-1 puts its RGB LED on GPIO48, and a
   clone may not — a dark "onboard LED" on 48 says more about the board than the
   sketch.)
2. **Which pin drives the beads?** Phase B clocks a short ALL-RED field on each
   candidate pin using the beads' own 350/1350 ns timing (copied from
   `firmware.ino`). A WS2812/SK6812-class LED on that pin lights; **GPIO 21 is in
   the list, and the wall's DIN is wired to 21** — if the chain from 21 to the
   strip is intact, the wall lights red on that step and stays latched.

It loops, so a missed phase is not a missed diagnosis. The wall latches the last
field it saw, so after a run it holds the last colour rather than going dark.

## Build and flash

```sh
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=disabled,CDCOnBoot=default,UploadMode=default" \
  --build-path build-probe probe

# esptool ships under the Arduino15 tools dir, not on PATH
"$LOCALAPPDATA/Arduino15/packages/esp32/tools/esptool_py/5.3.1/esptool.exe" \
  --chip esp32s3 --port COM8 --baud 921600 write_flash @build-probe/flash_args
```

Watch the announcements on the same port (opening it reboots the board — that is
expected and is the source of the reset you are about to see anyway):

```sh
node tools/bridge.js --port COM8 --status --duration 0
```

…or anything that reads the port; `probe` prints `A: pin N HIGH` / `B: pin N
red-field` as it goes.

## After using it

Flash the panel build back — the probe leaves the wall with no sink firmware:

```sh
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=disabled,CDCOnBoot=default,UploadMode=default" \
  --build-path build --build-property "compiler.cpp.extra_flags=-DPIN_DATA=21 -DSTALE_MS=0" \
  --build-property "compiler.c.extra_flags=-DPIN_DATA=21 -DSTALE_MS=0" firmware
```

Pins it deliberately avoids: 26–32 (flash), 33–37 (octal PSRAM on R8 modules),
43/44 (UART0 to the CH9102F), 19/20 (USB D-/D+), 0/3/45/46 (strapping).

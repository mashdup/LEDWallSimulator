#!/usr/bin/env bash
#
# Flash a built environment to the board.
#
#   ./flash.sh led_wall_s3_usb COM6
#   ./flash.sh led_wall_s3_uart COM5      # after moving the cable to the UART port
#
# Flashing happens over the ROM USB-serial/JTAG (esptool), so it works on COM6
# even for a build whose Serial lives on UART0/CH9102F. Only *talking* to the
# sketch afterwards depends on which port the firmware put Serial on.
#
# NOTE: this replaces whatever is on the board. The working sketch image lives in
# ../build/ (firmware.ino.bin / flash_args) and is the documented recovery.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLED_DIR="$HERE/../wled"
ENV="${1:-led_wall_s3_uart}"
PORT="${2:-}"

if command -v pio >/dev/null 2>&1; then PIO=pio
elif [ -x "$HOME/.platformio/penv/Scripts/pio.exe" ]; then PIO="$HOME/.platformio/penv/Scripts/pio.exe"
elif [ -x "$HOME/.platformio/penv/bin/pio" ]; then PIO="$HOME/.platformio/penv/bin/pio"
else echo "PlatformIO (pio) not found" >&2; exit 1; fi

UPLOAD_ARGS=()
[ -n "$PORT" ] && UPLOAD_ARGS=(--upload-port "$PORT")

echo "uploading $ENV${PORT:+ to $PORT}"
"$PIO" run -d "$WLED_DIR" -e "$ENV" -t upload "${UPLOAD_ARGS[@]}"

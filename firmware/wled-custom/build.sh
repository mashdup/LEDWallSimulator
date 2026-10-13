#!/usr/bin/env bash
#
# Build one of the wall environments. Run setup.sh first.
#
#   ./build.sh                    # led_wall_s3_uart (recommended)
#   ./build.sh led_wall_s3_usb    # USB-OTG variant
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLED_DIR="$HERE/../wled"
ENV="${1:-led_wall_s3_uart}"

if [ ! -f "$WLED_DIR/platformio_override.ini" ]; then
  echo "overlay not applied yet; running setup.sh" >&2
  "$HERE/setup.sh"
fi

if command -v pio >/dev/null 2>&1; then PIO=pio
elif [ -x "$HOME/.platformio/penv/Scripts/pio.exe" ]; then PIO="$HOME/.platformio/penv/Scripts/pio.exe"
elif [ -x "$HOME/.platformio/penv/bin/pio" ]; then PIO="$HOME/.platformio/penv/bin/pio"
else echo "PlatformIO (pio) not found; install it or add it to PATH" >&2; exit 1; fi

echo "building $ENV"
"$PIO" run -d "$WLED_DIR" -e "$ENV"

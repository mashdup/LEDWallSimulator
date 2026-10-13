#!/usr/bin/env bash
#
# Lay this overlay over a WLED checkout.
#
# Clones WLED at the pinned tag on first run (WLED is *not* vendored into this
# repo; only the overlay is tracked). Re-running is safe: it only copies our two
# files over the clone.
#
#   ./setup.sh              # clone v0.15.5 if missing, then overlay
#   WLED_TAG=v0.15.4 ./setup.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLED_DIR="$HERE/../wled"
WLED_TAG="${WLED_TAG:-v0.15.5}"

if [ ! -d "$WLED_DIR/.git" ]; then
  echo "cloning WLED $WLED_TAG -> $WLED_DIR"
  git clone --depth 1 --branch "$WLED_TAG" https://github.com/wled/WLED.git "$WLED_DIR"
else
  echo "using existing clone: $WLED_DIR ($(git -C "$WLED_DIR" describe --tags --always 2>/dev/null || echo unknown))"
fi

cp "$HERE/platformio_override.ini" "$WLED_DIR/platformio_override.ini"
cp "$HERE/wled00/usermod.cpp"       "$WLED_DIR/wled00/usermod.cpp"
echo "overlay applied: platformio_override.ini + wled00/usermod.cpp"

# WLED::handleConnection() brings the radio back up whenever it thinks it is
# disconnected, so a runtime WiFi-off cannot hold — measured, the radio returned
# every ~9 s, and because a teardown blocks for far longer than the 8 KB UART RX
# ring absorbs at 921600, each one cost ~1000 bytes of the stream. handleConnection
# is the only caller of initConnection(), so compiling that one call out is enough.
# One line, one anchor, and it fails loudly rather than silently building wrong.
WLED_CPP="$WLED_DIR/wled00/wled.cpp"
if grep -q "LED_WALL_WIFI_OFF" "$WLED_CPP"; then
  echo "wled.cpp already patched"
elif [ "$(grep -c '^  handleConnection();$' "$WLED_CPP")" = "1" ]; then
  sed -i 's|^  handleConnection();$|#ifndef LED_WALL_WIFI_OFF\n  handleConnection();\n#endif|' "$WLED_CPP"
  echo "wled.cpp patched: handleConnection() compiled out when LED_WALL_WIFI_OFF is set"
else
  echo "setup: handleConnection() call site not found exactly once in wled.cpp; refusing to patch" >&2
  exit 1
fi

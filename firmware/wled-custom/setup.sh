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

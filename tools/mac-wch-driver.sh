#!/usr/bin/env bash
#
# Install WCH's macOS USB-serial driver (CH34XSER_MAC / CH34xVCPDriver), then
# report which driver actually claimed the board.
#
# WHY: this mac drives the ESP32-S3's USB-CDC with Apple's built-in
# AppleUSBACMData (generic CDC-ACM). Windows drives the same device with WCH's
# vendor driver. Same firmware, same beads, same bytes - and the wall flickers
# only on the mac. The driver is the one concrete difference found so far, so
# this is the A/B: install WCH's driver and see whether the seams move.
#
# The package is signed by "Developer ID Installer: Nanjing Qinheng
# Microelectronics Co., Ltd. (5JZGQTGU4W)" and notarized by Apple, and its
# IOKitPersonalities claim idVendor 6790 + idProduct 21971 - this board exactly.
#
# Needs sudo (a password prompt) and a REBOOT to take effect.
#
#   ./tools/mac-wch-driver.sh            # download + verify only (no install)
#   ./tools/mac-wch-driver.sh --install  # download + verify + install
#   ./tools/mac-wch-driver.sh --check    # which driver owns the board right now
#
set -euo pipefail

WORK="${TMPDIR:-/tmp}/wch-driver"
PKG_URL="https://file.wch.cn/download/file?id=369"   # the URL Homebrew's cask uses
EXPECT_VID=6790
EXPECT_PID=21971

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

check() {
  say "Which driver owns the board right now?"
  if ! ls /dev/cu.* >/dev/null 2>&1; then
    echo "  no /dev/cu.* devices at all - is the board plugged in?"
  fi
  echo "  ports:"
  ls /dev/cu.* 2>/dev/null | sed 's/^/    /' || true
  echo "  USB driver classes under the device:"
  ioreg -r -c IOUSBHostDevice -d 6 2>/dev/null \
    | grep -E 'class (AppleUSBACM|CH34x|IOSerialBSDClient)' \
    | sed 's/^/    /' || true
  echo
  echo "  AppleUSBACMData  -> Apple's generic CDC-ACM driver (the current state)"
  echo "  CH34xVCPData     -> WCH's vendor driver (what Windows uses)"
  echo
  echo "  Expect the port name to change after installing:"
  echo "    cu.usbmodem*        (Apple driver)"
  echo "    cu.wchusbserial*    (WCH driver)"
}

if [ "${1:-}" = "--check" ]; then check; exit 0; fi

mkdir -p "$WORK"
cd "$WORK"

if [ ! -f CH34xVCPDriver.pkg ]; then
  say "Downloading the WCH driver package"
  curl -sL -m 300 -A 'Mozilla/5.0' -o wch-driver.zip "$PKG_URL"
  file wch-driver.zip
  rm -rf x && mkdir x && (cd x && unzip -q ../wch-driver.zip)
  PKG="$(find x -name 'CH34xVCPDriver.pkg' | head -1)"
  [ -n "$PKG" ] || { echo "no .pkg inside the zip - aborting"; exit 1; }
  cp "$PKG" CH34xVCPDriver.pkg
fi

say "Verifying the signature (must be Nanjing Qinheng, notarized by Apple)"
pkgutil --check-signature CH34xVCPDriver.pkg | head -8

say "Confirming the driver claims THIS board ($EXPECT_VID:$EXPECT_PID)"
rm -rf exp && pkgutil --expand-full CH34xVCPDriver.pkg exp >/dev/null 2>&1 || true
PLIST="$(find exp -name Info.plist -path '*CH34xVCPDriver.kext*' | head -1)"
if [ -n "$PLIST" ]; then
  if plutil -p "$PLIST" | grep -q "\"idProduct\" => $EXPECT_PID"; then
    echo "  yes: idVendor $EXPECT_VID + idProduct $EXPECT_PID is in IOKitPersonalities"
  else
    echo "  WARNING: $EXPECT_PID not found in the driver's device list - it may not claim this board"
  fi
else
  echo "  (could not read the kext Info.plist; skipping the device check)"
fi

if [ "${1:-}" != "--install" ]; then
  say "Dry run complete. Nothing was installed."
  echo "  Re-run with --install to install (needs sudo + a reboot):"
  echo "    $0 --install"
  exit 0
fi

say "Installing (this asks for your password)"
sudo installer -pkg CH34xVCPDriver.pkg -target /

say "Installed. Now:"
cat <<'EOF'
  1. If macOS asks, allow the extension:
       System Settings -> Privacy & Security -> Allow (Nanjing Qinheng Microelectronics)
  2. Reboot:
       sudo reboot
  3. After the reboot, plug the board in and check which driver took it:
       ./tools/mac-wch-driver.sh --check
  4. Then the A/B - watch the wall for seams (LEDs 70-78, 136-147, 180-191):
       node tools/flicker.js --fill 0000ff --fps 30 --bri 255 --limit 8000 --duration 45000
     (the port auto-detects, so a renamed cu.wchusbserial* needs no flag)
  5. To remove it again:
       sudo rm -rf /Library/Extensions/CH34xVCP*.kext && sudo reboot
EOF

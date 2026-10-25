# LED Wall

A 1 m² APA106/PL9823 LED curtain wall: **the computer is the brain, the ESP32
is a dumb pixel sink** fed over USB serial at 921600 baud. Drawings, live
color, animations and guest submissions all become 60 Hz frames of
`[header][1200 GRB pixels][checksum]`; the ESP32 pushes them to the strip
with zero creative decisions.

## The app (this is what the show machine runs)

`npm run wall` is not a browser shortcut — it boots a real app: an Electron
shell that owns its own local server (`tools/serve.js`), its own window, and
the serial device. Dev and the packaged binary run the identical shape.

```
npm run wall                        # dev run from the repo
npm run wall -- --kiosk             # fullscreen, always-on-top
npm run wall -- --relay https://wall.hoa.family --relay-key <hex>
                                    # one-shot relay pairing (the console dropdown
                                    # is the normal way; see "The relay" below)
npm run wall -- --debug             # DevTools + CDP on 127.0.0.1:9223 (for probes)
npm run wall -- --wall-serial usbmodem   # pin the port the picker answers with:
                                    # a name substring ('usbmodem', 'COM8') or
                                    # 'vid:pid' in either base ('1a86:7523',
                                    # '6790:21971'). Default: pick by signature.
npm run wall -- http(s)://...       # drive a published console instead of local
```

The console page opens at `http://127.0.0.1:8080/` (the loopback origin is
required for Web Serial; a LAN IP will not expose `navigator.serial`).
Guest drawing page: `/draw`.

### Why an app and not a browser tab

Every one of these was measured in the field, on the wall machine, in a
browser:

- The GPU process grew to **1.1 GB private bytes** (RTX 5080 + AMD iGPU + a
  virtual display in the compositing chain) and the window went fully grey —
  JS alive, no crash, unrecoverable without a human. → The app runs with
  **hardware acceleration off**: painting is software and boring; the wall's
  real output is serial bytes, which never touch a GPU.
- Tab sleeping / Memory Saver / Power Saver blank and freeze background
  tabs. → An app has no tabs and no tab policy: `backgroundThrottling: false`
  is ours, not a browser's favor.
- A Web Serial `requestPort()` **requires a user gesture**, so every reload
  of a browser console kills the wall until a human clicks Connect again. →
  The app answers the port picker programmatically, reopens **granted**
  ports gesture-free via `getPorts()` at boot, and when nothing is granted
  the shell **dispatches a trusted synthetic key event through its own
  debugger** — a real input event is what transient activation means, so the
  app can afford the one thing the page must never fake.
- The same cable is a different string per OS, and a picker written from one
  machine's log refuses the wall on the next. → `tools/electron/serial-pick.cjs`
  matches by **signature, both id bases, and every name shape**: the wall is
  `COM8` / `VID_1A86&PID_7523` / vendorId `'1a86'` on Windows and
  `cu.usbmodem59810005071` / "USB Single Serial" / vendorId `'6790'` on
  macOS — Chromium prints ids in **hex on Windows and decimal on macOS**
  (6790 = 0x1a86), `deviceInstanceId` does not exist on macOS, and macOS
  lists `cu.Bluetooth-Incoming-Port` + `cu.debug-console` as decoys, so
  "take the first port" drives a dark wall. Tested on the field records
  (`test/serial-pick.test.js`).
- A bright frame can sag USB and the ESP32's port re-enumerates. → The sink
  closes the port on disconnect (no handle leaks — that leak was the grey
  page's root cause), arms on the device's own `connect` event, and the
  stream resumes by itself mid-show.
- Renderer death: the shell reloads the window, and the reload **reopens the
  granted serial port by itself** — the wall goes dark for one reconnect, not
  for the rest of the night. In a browser that same reload is a dark wall,
  which is why the page's own watchdogs detect-and-record there and
  detect-revive-reload here.

The page keeps its watchdogs in both modes (a `WATCH:` line in the fps
readout, incident ring in `localStorage['wall-events']`).

## The relay (guest drawings from phones)

Set it once in the console, no command line, no shortcut flags: the
**Relay** dropdown (Off / wall.hoa.family / Custom) + the wall key from the
relay's docker logs + the owner token. The server persists the pairing in
`relay.json` beside the gallery, so every later start — app restart, machine
reboot, bare portable .exe — relays by itself. The status line says what the
wall is doing (`synced N s ago · N drawings`); the wall key is never served
back to any page, and re-pointing the relay needs the owner token (the hand
that prunes the gallery is the only hand allowed to move the plumbing).

The `--relay/--relay-key` flags still work and win for the boot they are
given — handy for a factory-style one-shot before a show.

## Building the binaries

```
npm run dist        # Windows: dist\LED Wall <ver>.exe (portable) + Setup .exe
npm run dist:linux  # Linux: AppImage + deb (x64) + tar.gz (x64, arm64)
npm run dist:mac    # macOS (run ON a Mac): dmg + zip
```

No Node.js install is needed at the venue: the app is its own runtime
(the server runs as `ELECTRON_RUN_AS_NODE` under the app binary), and the
packaged app needs no native modules at all — the browser side uses Web
Serial. `serialport` is an *optional* dependency for the CLI tools
(`npm run serve`, `tools/wallcheck.js`) and is excluded from the package.

## Data & logs (per machine, outside the app bundle)

- Windows packaged: `%APPDATA%\led-wall-simulator\`
- macOS packaged: `~/Library/Application Support/led-wall-simulator/`
- dev: `.wall-electron/` in this repo

Both hold `drawings.json` (the gallery; owner token beside it) and
**`wall.log`** — the venue incident log: renderer/GPU deaths, serial picker
decisions, autostart outcomes. On an incident, read the tail of that file.

## Linux & macOS

**Linux x64** (builds natively here: `npm run dist:linux`):

- `led-wall-simulator_<ver>_amd64.deb` — `sudo apt install ./led-wall-simulator_*_amd64.deb`
- `LED Wall-<ver>.AppImage` — `chmod +x` and run (AppRun), no install at all
- `led-wall-simulator-<ver>.tar.gz` — extract, run `./led-wall-simulator`

**Linux arm64** (Raspberry Pi 4/5, ARM laptops, the little show-box):
`led-wall-simulator-<ver>-arm64.tar.gz` — extract and run; built cross with
`npmRebuild: false` because the app carries ZERO native modules.

Serial on Linux: the ESP32's wch UART appears as `/dev/ttyUSB0` (kernel
`ch341` driver, stock). The browser stack needs device permission:
`sudo usermod -aG dialout $USER` (re-login once). That is the whole setup.

Serial on macOS: the same cable is `/dev/cu.usbmodem<serial>` under Apple's
built-in CDC-ACM driver, or `/dev/cu.wchusbserial<serial>` under WCH's own
driver. **Install WCH's driver — the Apple one flickers the wall.** Nothing to
install and no group to join for the *port* to work; see below for why you want
the driver anyway. `npm run freeport -- /dev/cu.usbmodem…` names whoever holds
it (lsof, so no probe-open and no ESP32 reset — the Windows probe's side
effect). The app's pre-flight and takeover speak both OSes: `GET /serial`
reports the `/dev` nodes and their state, `COM8` on a Mac is now a named
complaint instead of silence. `tools/flicker.js` auto-detects the port, so a
driver swap needs no flag.

**The mac driver decides whether this wall flickers. Measured, and the whole
reason this file mentions it.** The ESP32-S3 presents USB-CDC, so macOS claims
it with the generic `AppleUSBACMData` and the wall shows colour seams at fixed
beads (70-78, 136-147, 180-191 of 400) on a flat field — while **every** digital
counter stays clean: `decoded == written`, `disc=0 resync=0`, at 8/15/30/30.5/
31/32/33/42/45 fps, spaced and bursty, and with no intra-frame write gap over
146 us. Installing WCH's driver (the one Windows uses) and rebooting with the
board attached removes it completely. Same bytes, same firmware, same beads,
same power, same host: **only the driver changed.**

```sh
./tools/mac-wch-driver.sh            # download + verify the vendor package (no install)
./tools/mac-wch-driver.sh --install  # install (asks for your password)
# approve it: System Settings -> General -> Login Items & Extensions -> Driver Extensions
sudo reboot                          # WITH THE BOARD PLUGGED IN
./tools/mac-wch-driver.sh --check    # want cu.wchusbserial* and a running dext
```

The package is signed by *Nanjing Qinheng Microelectronics* and notarized by
Apple, and its personalities claim `idVendor 6790` + `idProduct 21971` exactly.
Two things that cost time here and are worth knowing: on macOS 26 the driver is
a **DriverKit system extension**, not a kext, so `/Library/Extensions` and
`kmutil` show nothing and are the wrong places to look — use
`systemextensionsctl list`; and the dext only claims the interface at USB
enumeration, so **the board must be attached at boot** or Apple's driver keeps
it. A CDC-ACM device that Apple has already claimed will not be handed to the
dext by a replug alone.

Serial on macOS is also a **privacy** grant, and the part that bites: the
first serial call asks TCC for Bluetooth, because a paired Bluetooth modem
*is* a serial port to macOS (`/dev/cu.Bluetooth-Incoming-Port` shows up in
the list). Two measured consequences:

- TCC reads the usage description from the bundle that **asks**, and the ask
  comes from an Electron *Helper* app. Electron's helpers and electron-builder's
  generated helpers ship without `NSBluetoothAlwaysUsageDescription`, so
  anything that cannot be granted an answer dies with
  `__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION` — mid-serial, right after
  `window loaded`, which reads exactly like a hung port picker. The build
  declares the key in the app and in every helper now (`build.mac.extendInfo`
  plus `tools/electron/afterPack.cjs`); `tools/mac-dev-serial.js` patches the
  dev `node_modules/electron` bundle the same way, from the launcher.
- macOS charges the ask to the **responsible process**, and a process started
  from a shell inherits the *terminal*. Measured: launching the app from this
  terminal logged `tccd: Refusing authorization request for service
  kTCCServiceBluetoothAlways and subject Sub:{dev.warp.Warp-Stable…}` and the
  wall died. **Start the show from Finder/Launchpad, not a terminal**, and
  accept the one-time Bluetooth prompt. A terminal launch works only if the
  terminal itself holds Bluetooth permission.

Electron needs a desktop session's libraries (gtk3, nss, gbm, asound —
standard on any desktop distro; a bare server/WSL needs them via apt) and,
on distros that block unprivileged user-SUID (24.04+), the
`--no-sandbox` flag: the app's window is the only thing that runs, it is
our own code, and the flag is an app argument like `--kiosk`.

**macOS**: electron-builder refuses to produce Mac binaries on Windows
(signing and dmg tooling are macOS-only). The release workflow builds the
dmg on a macos runner; with the five Apple secrets present (the SAME names
the Anvil/CodeHamrUI release uses) it signs and notarizes, absent them it
ships unsigned:

- `MAC_CERT_P12` (base64 of the Developer ID .p12), `MAC_CERT_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Local build on any Mac without secrets: `npm ci --omit=optional && npm run dist:mac`.
Unsigned builds open with right-click → Open (Gatekeeper); Web Serial uses
the macOS TCC prompt once, the app's permission handler answers the picker
from then on - the same self-healing story as Windows. The picker's port
MATCH is the platform-aware one (see `tools/electron/serial-pick.cjs`): on
the 0.11.6 dmg it listed the ESP32 and chose nothing, because its id
compare and its `/^com\d+$/` fallback were Windows-shaped, so the console
reported "No serial port was selected" with the wall in front of it.

Data & logs land in the per-OS userData (`~/.config/led-wall-simulator/`
Linux, `~/Library/Application Support/led-wall-simulator/` macOS).

**A wall that flickers on the mac and not on Windows is the mac's serial
driver.** Measured, and it is the one mac-specific cause this wall has. The
symptom: runs of beads in colours nobody sent, at **fixed** beads (70-78,
136-147, 180-191 of 400), on a flat field, only on the mac. The cause: macOS
claims the ESP32-S3's USB-CDC with the generic `AppleUSBACMData`, where Windows
uses WCH's vendor driver. Installing WCH's driver removes it completely — see
"Serial on macOS" above for the install, and note the board must be **attached
at boot** for the DriverKit extension to claim the interface.

What made this expensive to find is that **every digital counter is clean on
both drivers.** On the Apple driver, with the seams plainly visible on the wall:
`decoded == written`, `disc=0 resync=0`, at 8/15/30/30.5/31/32/33/42/45 fps,
spaced and bursty; the host's own writes had no intra-frame gap over 146 us; the
wall was steady with the serial port closed (the board driving itself) and steady
on Windows with the same firmware. So these are all ruled out **by measurement**,
not by argument:

- **the bytes** — a flat field sends the same 1200 bytes every frame and still
  shifted, and the board's parser reported every frame intact
- **the frame rate** — identical seams at every rate from 8 to 45 fps
- **the arrival pattern** — bursts of 3 changed how *bad* it looked and nothing
  in the counters; pacing alone is not the cause
- **power and brightness** — flat white was steady at 8 A *and* 18.4 A; red broke
  at 2.7 A, so a sag cannot be it (it would worsen as load *rose*). APA106
  carries brightness in its own word, so the colour bytes never change with it
- **the firmware** — the same build is clean on Windows
- **the app** — `tools/flicker.js`, which is not the app, reproduces it
- **the cable, the beads, the PSU, the ground bond** — unchanged across the fix

Only the driver changed. The board's counters stay clean on both drivers because
Apple's driver does deliver every byte correctly at the UART level; the
difference is in how it services the endpoint, and the beads are sensitive to the
resulting gaps in the RMT feed. That is why nothing digital could see it, and why
the fix is a driver install rather than anything in this repo.

`node tools/flicker.js --fill 0000ff --fps 30 --bri 255 --limit 8000 --duration 45000`
is the check, with the app closed. The port auto-detects, so the driver swap
needs no flag. The ~49 fps ceiling from the APA106 refresh (400 beads x 30 bits
at a 1.7 us bit is ~20 ms of wire) and the rig's `torn=` counter are in
`firmware/README.md`.

## Show-machine quick start

1. Run `LED Wall Setup <ver>.exe` (one click), or drop `LED Wall <ver>.exe`
   (portable) anywhere.
2. Put a shortcut to it in `shell:startup` for a cold-boot-to-show machine
   (add `--kiosk` to the shortcut's target for fullscreen).
3. Open the page, pick the **Relay** dropdown → wall.hoa.family, paste the
   wall key + owner token, Apply. Done once; the machine relays forever
   after (see "The relay").
4. The app picks the wch UART (COM8) by itself; Connect only if the picker
   must see a specific port.

## Repo map

| path | what |
|---|---|
| `web/` | the console page: sim canvas, worker clock, frame pipeline, Web Serial sink |
| `core/` | shared frame/color/animation logic (no DOM) |
| `tools/serve.js` | the local server: static, `/api`, `/draw`, relay client |
| `tools/electron/` | the app shell (main + preload bridge) |
| `tools/start.js` | the launcher (`npm start` browser modes, `npm run wall` app mode) |
| `relay/` | the public relay (Docker, its own README) |
| `firmware/` | the ESP32 sink firmware (Arduino + WLED fork notes) |
| `test/` | node:test suite — `npm test` (headless-Chromium page tests included) |

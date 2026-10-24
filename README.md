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
  The app answers the port picker programmatically (the wch/COM8 device is
  preferred by vendor id), reopens **granted** ports gesture-free via
  `getPorts()` at boot, and when nothing is granted the shell **dispatches a
  trusted synthetic key event through its own debugger** — a real input event
  is what transient activation means, so the app can afford the one thing the
  page must never fake.
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

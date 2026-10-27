# LED Curtain Wall — Build Plan

*Hardware:* 1m² panel, 400 APA106/PL9823 beads (**not WS2812B** — see firmware/README.md, "Panel identity"), 20×20 @ 50mm pitch, 3-wire. Data line spliced off the built-in controller to an ESP32.

*Architecture:* the browser is the whole brain. It fetches the banner, rasterises it, applies effects, and streams finished frames. The ESP32 is a dumb pixel sink. Sim and wall use the same frame protocol, so nothing is throwaway.

## Repo layout


led-wall/
  core/        framebuffer, layout map, effects   (pure JS, no DOM)
  web/         banner page + canvas sim + connect UI
  firmware/    esp32 sketch.ino
  test/        unit tests for core


## 1. Core framebuffer (core/)

- Panel class: 20×20 grid, setPixel(x, y, r, g, b), clear(), toBytes().
- layout.js: logical (x,y) → physical LED index. Zigzag/snake direction, strip start offsets, and a flipX/flipY/transpose set of flags. *This is the file you'll edit once when the wiring is real* — everything else stays untouched.
- buffer.js: packs the grid into a flat RGB byte array (1200 bytes).
- No DOM, no fetch, no browser APIs in core/. It must run under Node so it's testable.

## 2. Frame protocol

Fixed-size, self-clocking, drop-safe:


0xA5        frame magic
seq         uint8, wraps
1200 bytes  RGB, physical LED order (post-layout)
0x5A        frame end

Total 1204 bytes. Firmware renders the last complete frame it saw; a partial frame is discarded, so a dropped byte never corrupts the wall. Baud 921600.

Also define a meta frame (magic 0xA4) for brightness and power budget — see §6.

## 3. Banner renderer (web/)

- Banner source is your own page. Fetch it via fetch() on a short poll (200–500ms) or an EventSource stream if you want push.
- Rasterise text into the 20×20 grid: render to an offscreen canvas at high res, downsample to 20×20 with area averaging (not nearest — nearest looks crunchy at 50mm pitch).
- Scroller: horizontal marquee at fractional pixels per frame, so text glides rather than jumps a whole glyph per tick.
- Font sized to the grid: cap height ≈ 13–15 rows leaves room for descenders and looks right on a curtain.

## 4. Sim (web/)

Canvas, 20×20 cells scaled up, each cell drawn as a soft radial blob rather than a hard square — that approximates how diffused curtain LEDs actually blend, so what you see on screen matches what you'll get on the wall. Same Panel instance as the wall path. Include a "what the wall actually sees" toggle that renders with the physical index order, so you can preview a wiring mistake before it's installed.

*Colour.* `core/color.js` holds the **LED fine-tune**: four output stages applied
to the finished frame — **white balance** (temperature + tint, cut-only per-channel
gains, because the beads' R/G/B dies differ in efficiency so 255,255,255 is never
neutral), **saturation** (pulls each pixel away from its own mean: a diffused wall
and the eye's desaturation at high luminance — the Bezold–Brücke shift — both wash a
pastel toward white, and pure channels are the only ones that survive it), **black
level** (crushes the floor the diffuser's scattered ambient light raises, and stays
white at the top), and **gamma** (the usual display curve, deepening midtones at the
same power draw). All are host-side; the frame protocol stays raw RGB bytes and the
sink stays dumb.

**The preview shows none of them.** These correct the *physical wall*, so they are
dialled by looking at the wall; applied to the design they make the operator watch
the picture change while calibrating the hardware. The pipeline therefore packs the
design into wire order first, snapshots that for the preview, then tunes the packed
bytes in place — legal because packing permutes whole pixels and every one of these
stages is per-pixel. The estimator reads the tuned bytes (those are what draw
current), the preview does not. See `README.md`, "The wall's own calibration".

## 5. Transport

*Sink:* **two, and both work.** The renderer emits the same frozen frame records
either way, so this is a transport choice, not a code fork:

- **Offline — USB.** browser → Web Serial → the sketch → beads, no network at
  all. The sketch drives the panel itself: the RMT emits the part's real bit
  timing (350 ns / 1350 ns, a 1.7 µs bit) at 20 MHz resolution, and needs no
  library. `Adafruit_NeoPixel` cannot express those timings, and NeoPixelBus does
  not build on ESP32 core 3.x without patching, so the timing is generated here.
- **Network — DDP.** browser → `tools/serve.js` → DDP/UDP → WLED → beads. WLED
  drives the beads with its own Apa106 RMT method. Use it when the wall has to be
  somewhere else, or driven from a phone.

`firmware/README.md`, "Panel identity", carries the evidence for the part, its
timings, and the order. *Why Web Serial is viable:* it needs a secure context, so
serve the page from `tools/serve.js`, which binds 127.0.0.1 for exactly that.

## 6. Power budget

400 APA106/PL9823 beads at full white ≈ 12A at 5V. Realistically you'll never run full white, but the renderer should carry a global brightness multiplier plus a peak-current estimator: compare the estimate against the firmware's status-line draw.

*(Written before the panel was measured: full white is the hard bound of 400 × 3 × 20 mA = **24 A**, and ~12 A is the realistic figure — see `firmware/README.md`, "Power envelope", and `README.md`, "The wall's own calibration", for the budget and headroom this ended up shipping with.)*
1. core/ + tests — framebuffer, layout map, byte packing. Verify a known pattern packs to the expected 1200 bytes.
2. Canvas sim scrolling live text from a local page.
3. Power estimator + brightness clamp.
4. Sink + wall lit — offline over USB (Web Serial), and over the network via WLED
   and DDP (see §5).
5. Layout calibration pass against the real panel using the physical-order preview.

Milestone 1 is the one worth doing today — it's pure logic, fully testable, and everything else hangs off it.

## 7. Drawings and the gallery

The wall is a family noticeboard as much as a data display, so anyone who can
reach it can put a picture on it. `web/draw.html` is a standalone 20×20 editor
(pencil / eraser / bucket, native color picker, quick palette, recents, undo),
and it has exactly two exits:

- **Send** → `POST /content {kind:'pic', pixels:<3200 hex chars>}` — show this
  drawing now. The bytes ride in the message, so a picture needs no server state
  beyond the content channel every renderer already polls.
- **Save** → `POST /drawings`, and `{kind:'gallery', interval}` puts the wall in
  cycling mode.

The model is `core/drawings.js`: one flat RGBA grid, 4 bytes per cell, 20×20 =
1600 bytes, and the wire form is lowercase hex of those bytes (3200 chars). Alpha
is the whole transparency story — a cell with `a=0` is *not used*, so it renders
as nothing and the wall's black shows through. Empty is not white and not black:
it is off, which is what a curtain of LEDs does with a cell nobody addressed.

*Why the gallery lives on the server:* the topology is browser-as-brain, and the
capture browser shares nothing with the tab a person draws in. `GET /drawings`
(metas, never pixels) and `GET /drawings/<id>` (one entry's pixels) are the only
way a drawing made on a phone reaches the wall. `{kind:'gallery', interval}` is a
cadence signal, not a payload: which entry is showing is
`floor(serverTime / interval) % n`, a pure function of the shared clock, so a page
that loads mid-cycle lands on the same drawing as one that has been open an hour.

*Why the store is one JSON file:* there are no users and no moderation here, and
`validateEntry` is the gate at write time and at load time — a hand-edited or
corrupt record is dropped, never trusted, and never a 500 in the renderer.
### 7.1 The guest page (`web/public.html`)

`draw.html` is the owner's editor: it can show a picture now, start the gallery,
remove an entry. A stranger standing in front of the wall gets `public.html`,
which can do exactly one thing — add to the gallery — and shows exactly one
thing: the grid, the tools, one button. The boundary is not a permission flag and
not a hidden panel: the page imports `core/drawings.js` and
`web/draw-editor.js` and nothing else, so it has no `content-protocol.js` and no
WebSocket in its module graph. It writes one request, `POST /drawings`, and it
reads nothing — not `/content`, not `/drawings`, not the frame. A guest does not
need to know what the wall is showing, and a page that polls every two seconds
is a page with a polling loop to get wrong. The test asserts that boundary
completely: the only request made is `POST /drawings`, zero `WebSocket`
constructions, the content `rev` identical before and after a guest saves, and no
`send` / `gallery` / `interval` control and no wall panel anywhere in the DOM.

*Why it is front-facing:* this page is in a window, so the style carries it. The
grid is painted as a lit LED matrix (round beads, dark gaps, a glass highlight,
and an unused cell drawn as a dim dead LED) because that is what the drawing is
going to become; the tools sit under the grid in the thumb zone as icons; there
is one verb and one button, "Put it on the wall", stuck to the bottom of the
viewport on a phone so a guest never hunts for it; and the LED glow is the only
accent, so nothing competes with the panel.

*Why the editing is a shared module:* `web/draw-editor.js` owns the RGBA bytes,
the pointer stroke, the undo stack and the tool/color state, and paints through
a `paint` callback the page supplies. Both pages therefore cannot disagree about
what a drawing *is*, while the owner's grid stays graph paper and the guest's
grid reads as LEDs. The canvas is the only DOM the editor touches.

*Anonymity, stated honestly:* there is no account, so "who" is a name the
visitor types and nobody checks. The 20 s save cooldown is per device and
client-side — it slows one excited person down and is not a security boundary.
A wall handed out on this page needs a server-side rate limit, and the owner's
list is the pruning tool.

### 7.2 The guest guards (server-side)

A page handed to strangers needs limits it cannot be talked out of, so every
guard is in `tools/serve.js`, not in the page:

| guard | flag | default |
| --- | --- | --- |
| minimum gap between `POST /drawings` per address | `--rate-spacing <ms>` | 10 000 |
| posts per window per address (burst) | `--rate-burst <n>` over `--rate-window <ms>` | 6 / 60 000 |
| gallery size cap | `--max-drawings <n>` | 200 |
| the delete key | `--owner-token <hex>` | random, saved to `data/owner-token.txt`, printed at start |

*The address is the socket address.* `X-Forwarded-For` is forged by exactly the
client the limit exists for, and this server is loopback-bound with no proxy in
front of it that would set the header truthfully. A **rejected** post records
nothing: if it did, hammering would push one's own lockout further out, so a
flood would be its own reward. The gate runs before the body is read, so a
refusal does not make the server absorb 3.3 KB it is going to throw away. A full
gallery answers **507**, not a fake success, and a rate refusal is a **429 with
`Retry-After`** — which the guest page obeys, so its own cooldown is a mirror of
the real limit rather than a guess at one.

*Deletes need a key, and there are two, with different reach.* The **owner
token** (`X-Wall-Owner`) prunes the whole gallery; `draw.html` keeps it per
browser and the server prints it at startup. The **entry secret**
(`X-Wall-Delete`) is generated at POST time, returned **once** in the save
response, and opens exactly that entry — so a guest can take their own drawing
back and nobody else's. `GET /drawings/<id>` serves a public view that strips
it: the list is public, so a served secret would mean every visitor can delete
every drawing in two requests. Auth is checked before the id lookup, so an
unauthenticated caller is told *no* before it is told whether an id exists. An
empty `--owner-token` **disables** owner auth rather than becoming a shared
secret of `""`.

*What this does not do:* no accounts, so "who" is still a name the visitor
types; the address limit is one per device behind one address, so a determined
flood from a network is not stopped, only slowed; and the gallery is still
public. This is the honest shape of a self-hosted wall with a QR code in front
of it — enough that an excited family cannot fill the wall, and the owner can
always clear it.

### 7.3 The break between drawings

A gallery of family drawings on a wall is a slideshow, and a slideshow with no
rest is a slideshow nobody watches. So the gallery has a **break**: each
drawing shows for `interval` seconds, then the wall runs one of its own
animations for `gap` seconds, then the next drawing.

The break is **not a timer**. It is a slot in the same clock arithmetic as the
drawings, in one pure function, `gallerySlot(tSec, n, interval, gap, gapAnim)`
in `core/content-protocol.js`:

```
period = n * (interval + gap)
pos    = t mod period
slot   = floor(pos / period);  phase = pos - slot * period
phase < interval  ->  drawing[slot]
phase >= interval ->  the break, gapAnim
```

That is the whole design, and it buys the one property the wall needs: a
capture browser that loads fresh at 19:04:07, a phone tab that has been open
since 18:00, and the app tab that drives the frames all land in the same slot
of the same cycle. Nobody "starts" the break, nobody syncs it, and a renderer
that reloads mid-break is in the break. `gap: 0` is the old cadence, byte for
byte (`floor(t / interval) % n`), and `gapAnim: 'none'` is a dark gap — the
break is a duration, and what fills it is a choice.

*The break is selectable from the animation library, and the select is built
from `GAP_ANIM_NAMES` — the same list the protocol gate validates — so a
control page can never offer a break the wall would refuse.* Defaults live in
`GALLERY_DEFAULTS` (8 s of drawing, 5 s of `rain`), not in page markup: the
markup's `value=` is a placeholder, the constant is the truth.

*`animFrame()`'s `gallery` branch stays black, and the driver resolves the
slot.* The pure generator never fetches the drawing list, so it cannot know
which slot the clock is in; `web/app.js` and `web/content.html` do, and the app
tab is the driver that runs the wall. A driver that forgets plays a dark wall
where the break animation belongs — the test for that is in the app-tab test,
because the app tab is the one the wall actually runs.

*`gallerySlot` clamps, `parseMessage` rejects.* The gate is for senders; the
slot function is a renderer's arithmetic on a clock, and a renderer must never
throw in the middle of a frame. Negative time is real (clock skew), so `pos` is
wrapped into `[0, period)` before it indexes anything.

### 7.4 The owner is not a guest

The guards in §7.2 are for strangers, and a token is proof of not being one. So
`X-Wall-Owner` on `POST /drawings` **lifts the rate limit and the gallery cap**,
and `draw.html` sends it on the save as well as the delete.

The reason is the owner's actual workflow, not a loophole: twenty scanned
family pictures, saved one after another from one laptop, is one address at ten
seconds a save — twenty minutes of waiting, and a cap that fills on the owner's
own fiftieth entry while they are curating. A limit on the person who owns the
wall is a limit on the wrong person.

Two consequences, both wanted:

*The owner's posts do not consume the guest allowance.* The gate records what
it gates. The owner saving twenty pictures cannot starve the wall for the next
guest, and a guest gets the same first save, and the same 429 after it, whether
the owner has posted or not.

*The cap is the owner's own number, and the token is the only way to raise it
at runtime.* `--max-drawings` protects the wall from the page on the QR code;
it was never a ceiling on the person who set it.

The token is not a client flag: a wrong token is a stranger, and gets the 429.

### 7.5 The transition between slots

A gallery with a break is a slideshow that rests; a gallery with a **transition**
is one that arrives. Each slot opens by blending in — the frame the wall was on,
and the new drawing, with `k` going from 0 to 1 over `transitionSec` seconds.
Default: `fade`, 1 s.

`core/transitions.js` is the whole effect library, and it is pure bytes:

```
applyTransition(name, from, to, k, grid) -> Uint8Array(grid*grid*3)
```

`fade` is linear; `wipe` reveals whole columns with a lit leading edge (on a
20-cell panel a bare 0/1 reveal reads as a *jump*; the moving edge is what reads
as a sweep); `slide` moves one picture in from the right and carries the other
off the left, as one movement, so the last frame has no seam in it; `dissolve`
cross-fades each cell on a schedule set by a **hash of its coordinates** — not
randomness, so the same cells dissolve in the same order in every renderer,
forever in phase.

*The contract is at the ends.* `k <= 0` is `from` byte for byte and `k >= 1` is
`to`, for every name **including `none`**. A transition that starts or ends
approximately flickers at every slot boundary, and a wall that runs for hours
flickers once per drawing. The first version of this file had exactly that bug:
the name was checked before the progress, so `none` at `k = 1` returned the old
frame — a hard cut that never completed.

*Both seams, not one.* The cadence is one cycle, and a cycle that is soft at one
boundary and hard at the next is exactly the asymmetry the eye reads as a fault:
the wall **fades into** a drawing and then **falls off a cliff** out of it. So the
transition opens every seam — `[break] → [drawing] → [break]` — with the same
name and the same duration, and the drawing's exit blends into its own break.
The target's frame is taken at the same `t` the renderer is drawing, so the
break is a live picture during the blend: a wipe into `rain` is a wipe of a
moving curtain, and `gapAnim: 'none'` makes the same seam a fade to black.

*The clamp is half the drawing.* Both blends live inside the drawing's own
window, so each finishes before the other starts: `transitionSec` is clamped to
`(interval - 0.25) / 2`. A blend that runs past a boundary finds its own target
changed under it halfway through — the frame it is blending toward is no longer
the one it started from — and two overlapping blends have no defined result at
all. With no break there is no exit seam to blend (the next slot's entry covers
that boundary from the other side), so the cycle is still soft everywhere.

*Both renderers compose the gallery from the pure generator.* `content.html` and
`app.js` build the frame as `animFrame(slot)` blended with
`applyTransition(animFrame(previous slot))`. That is a deliberate narrowing: the
gallery is the one place where the capture browser and the frame driver are
guaranteed byte-identical, because neither uses its own painter there. A
transition needs *two* frames of the same origin, and two implementations of the
animation library cannot promise that.

*The test asserts the shape, not the color.* A fade between a red wall and a blue
wall is a **uniform purple** — "both colors present" is true of a wipe and false
of a fade, so it is the wrong observable. The observable that fits every
transition is a frame that is **neither saved drawing**: a picture the gallery
never made. The wipe adds the assertion that only a wipe has — one drawing on
one side, the other on the other. And the control is the hard cut: with
`transitionSec: 0` there must be no in-between frame at all, which is what stops
the first two assertions from proving nothing.

### 7.6 The gallery, in the console

The app page is the console a person actually has open at the wall, so the
cadence lives there too: **every N s · break M s of ⟨anim⟩ · transition ⟨name⟩
K s · Start gallery**, next to the animation buttons, with `Draw…` and `Guest
page` links and the drawing count. The control page and the drawing page keep
the same controls; all three send the same message, and the wall's state is the
truth for all of them.

The console **mirrors**: a cadence set from a phone opens the fields on the
console, and the Start button lights when the wall is in gallery mode. The
mirror runs on the poll that *changes* the state, never under the person typing.

*The count is written where it is learned.* Mirroring it on a rev change showed
"0 drawings" forever: the drawing list arrives a moment after the state that
asks for it, and the state never changes again. So `renderGalleryCount()` runs
in the list's own `.then`, and the status line no longer carries a number it
cannot have — a panel that shows `0 drawings` next to `3 drawings` is two
clocks, and this project has exactly one.

### 7.7 The harness bug this surfaced

`waitFor(predicate)` called the predicate **without awaiting it**. A promise is
always truthy, so every async predicate — the CDP kind, where the condition is a
page eval — reported satisfied on the first poll, before the page had loaded.

The tests still passed. That is the worst kind of green: they passed because the
*next* assertion happened to poll properly (`frameWhere`'s own loop, a status
line that had time to update), so the readiness checks were decorative and a
genuine race was invisible. The new console test exposed it by asserting a field
value with no polling loop behind it.

`waitFor` now awaits, returns the predicate's truthy **value** (not `true`), and
throws on timeout; `waitForValue` is an alias, so both names are one contract.
Every existing suite passes unchanged — which is the point: the fix did not make
the tests true, it made the readiness checks real.

## 8. The public relay (`relay/`)

A party's phones are not on the wall's network, and the wall is a laptop behind
NAT whose server is loopback-bound on purpose (Web Serial needs a secure
context; `http://192.168.x.x` is not one). So the wall cannot be reached, and
should not be: the console, the serial panel and the frame driver stay off the
network.

The relay is the public door — a container on jarvis, behind Caddy at
`https://wall.hoa.family`. Guests post to it; the wall **dials out** to it.

```
phone ──HTTPS──> Caddy ──> relay (Docker, loopback:8091) ──> /data
                              ^
                              |  GET /pull?since=N   POST /push
wall laptop (loopback:8080, serial to the panel, gallery on screen)
```

### 8.1 A queue, not a proxy

The wall is the thing that must not fail at 22:00. A proxy puts it on the
critical path of a guest's save: laptop asleep, rebooting, or off the hotspot,
and the phone shows an error and the drawing is gone. A queue takes the wall off
that path — the guest gets a 200 from a machine that is always up, and the wall
shows the drawings the moment it is back.

Two-way, so the owner's family pictures on the wall reach the phones too, and a
delete on either side is final on both.

### 8.2 One number does the whole sync

`core/drawing-store.js` gives every mutation a `seq`, and every delete a
tombstone `{id, seq}`. `since(cursor)` is the whole sync story in one call:
everything that happened after the number you last saw.

The wall keeps two cursors in the store's state file — `sent` (how far the relay
has been told about this wall) and `cursor` (how far this wall has been told
about the relay) — so a reboot mid-party resumes where it left off. No diffing,
no timestamps, no "last modified", and no way for a deleted drawing to come back
from the dead: tombstones live on the same number line.

Two rules keep the loop honest:

- **An adopted entry is marked `origin: 'relay'` and never rides the push.**
  Without that, one wall replays its whole gallery on every connect, and two
  walls copy each other forever.
- **A peer's delete is applied with `drop()`, not `remove()`.** `remove` is a
  local decision, so it records a tombstone for peers to follow; `drop` is a
  delete that is already out there, and re-recording it sends the same delete
  back — a wall that keeps asking the relay to remove what the relay just told
  it to remove.

Secrets never cross the wire: `adopt()` strips the per-entry delete secret, so
the wall's guests keep the takeback token the relay minted for them, and the
wall never learns anyone's.

### 8.3 Offline is a state, not an error

The wall's client (`tools/relay-client.js`) backs off to 60 s, says the failure
**once**, and keeps the local gallery running the whole time. A 401 is reported
as "the relay refused the wall key", not as "not reachable" — the first sends
the owner to the command line, the second sends them to the router.

The bug this suite caught: the client re-armed its timer from `start()` and from
the failure path, but not after a success. It synced once and then sat there for
the rest of the party — the wall showed the drawings that arrived first and never
saw a delete, a late posting, or anything it had saved itself. **A loop that only
re-arms when it fails is a loop that stops working the moment it works.** Every
tick arms the next one, success included.

### 8.4 Three gates, and the proxy breaks the obvious one

Behind Caddy, `clientAddr(req)` is the same loopback address for every guest in
the room. A per-address limit is then one global limit: the first drawing locks
the party out. So the relay splits the job:

| gate | key | default | stops |
|---|---|---|---|
| politeness | `x-wall-device` (random id in localStorage) | 10 s, burst 6/min | one guest hammering save |
| flood | real IP (XFF, only with `--trusted-proxy`) | burst 40/min, **no spacing** | a script, not a room of guests |
| `rate_limit` (Caddy) | real IP | operator's | the internet at large |

The address gate is deliberately loose: a room of twenty phones is one address,
so any spacing limit there is a limit on the room. The device token is weak on
purpose — a random string in `localStorage`, gone with the browser, rotated by
anyone who opens devtools. It is not a credential and grants nothing. It is the
difference between a per-guest limit and a global one, and the flood gate stays
underneath it. `X-Forwarded-For` is believed only when `--trusted-proxy` says a
proxy is in front: on the wall's own loopback server, the socket stays the
identity, because there a forged header is the only kind a client sends.

### 8.5 The surface, and the store that is now one thing

The relay's entire public surface is a table: the guest page, the two modules it
imports, `POST /drawings`, `DELETE /drawings/<id>`, `/healthz`, and the two sync
verbs behind the wall key. `/index.html` — the wall's console — is not in the
table, and neither is `GET /drawings`: a stranger cannot enumerate the gallery
and cannot see the wall.

The guest page's boundary is asserted as what it is: the **module graph**. The
test collects the page's `from '...'` specifiers and requires the set to be
exactly `../core/drawings.js` and `./draw-editor.js`, and requires no
`new WebSocket`. (An earlier version of that test grepped the page for the
string `content-protocol` — and failed on the page's own header comment, which
explains in prose that it imports no content-protocol.js. Prose is not code.)

`core/drawing-store.js` and `core/guards.js` are now the single implementation
behind both servers: the wall's `/drawings` API and the relay's queue share the
store, the rate gate, the token resolver and the auth. The wall's suite
(`test/drawings-api.test.js`) is the proof the refactor kept the behaviour, not
just the shape.

Two bugs the refactor exposed, both worth naming:

- **`resolveToken` called `require()` inside an ES module.** It threw, the
  surrounding `catch` swallowed it, the token was never written to disk, and the
  startup banner cheerfully printed the path it had "saved" it to. A `catch`
  around a bug turns a broken feature into a silent one.
- **The harness grepped the newest stdout chunk, not the accumulated log.** A
  suite that reads the generated owner token out of the banner saw nothing,
  because the token line arrived in an earlier chunk.

### 8.6 The console shows the relay, and does not touch it

The console has one read-only line: `relay: wall.hoa.family - synced 3 s ago �
14 drawings`, `relay: wall.hoa.family - the relay refused the wall key (HTTP
401)`, or `relay: off`. It reads `GET /relay` from the wall's own server, which
answers from the client's state.

Read-only on purpose. The pairing is a command-line flag, and a field that
could repoint the wall at another relay mid-party is a way to break the party
with a stray click. The console's job at a party is to tell the owner that the
queue is moving � not to be a second place to configure the same thing.

### 8.7 The card, and the QR that is not in this repo

`web/card.html` is a print-friendly sign: the address in a black box, in type a
person can read across a room, and a dashed square for a taped-on QR. It reads
`location.host` for the address, so printing it from the relay makes the paper
agree with the server. It fetches nothing, and the relay's test asserts that.

The QR code itself is deliberately **not** implemented here. A QR encoder is
~300 lines of GF(256) Reed-Solomon, format-info placement and mask penalties,
and the failure mode is a matrix that looks right and does not scan � which is
a party that cannot start, and no test in this suite can scan one. Any generator
on the internet makes a correct QR for a 25-character URL in five seconds.

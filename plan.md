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

*Colour.* The renderer carries two output stages in `core/color.js`, applied to the
finished frame before the power clamp — so the estimator and the sim both see the
bytes that actually leave. **Saturation** pulls each pixel away from its own mean:
a diffused wall and the eye's own desaturation at high luminance (the
Bezold–Brücke shift) both wash a pastel toward white, and pure channels are the
only ones that survive it. **Gamma** is the usual display curve, which deepens
midtones at the same power draw. Both are host-side; the frame protocol stays raw
RGB bytes and the sink stays dumb.

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

*One seam, on purpose.* The transition opens the **drawing**. The drawing →
break seam stays a cut: a transition is for the boundary people experience as a
hard swap (picture to picture), the break is a rest, and on a 20-cell panel a
wipe into a moving pattern is a wipe of noise. Keeping one seam blended also
keeps the blend inside the part of the slot it belongs to, which is what makes
it finish — a transition longer than the drawing it opens is clamped, because a
blend that runs past a boundary finds its own target changed under it halfway
through.

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

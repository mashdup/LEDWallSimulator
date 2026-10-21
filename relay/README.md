# The public relay

One page, one POST, and a wall that dials out.

At a party the phones are not on the wall's network, and the wall is a laptop
behind NAT whose server is loopback-bound on purpose (Web Serial needs a secure
context, and `http://192.168.x.x` is not one). So the wall cannot be reached,
and should not be: the console, the serial panel and the frame driver stay off
the network.

This relay is the public door. It runs on jarvis behind Caddy at
`https://wall.hoa.family`, and it holds a queue:

- **guests** post drawings to it, from the page at `/` (the same
  `web/public.html` the wall serves locally);
- **the wall** visits it on a timer — pull what arrived, push what the owner
  saved — and never accepts an inbound connection.

```
phone ──HTTPS──> Caddy ──> relay (Docker, loopback:8091) ──> /data
                              ^
                              |  dial-out: GET /pull?since=N, POST /push
wall laptop (loopback:8080, serial to the panel, gallery on screen)
```

## Why a queue and not a proxy

The wall is the thing that must not fail at 22:00. A proxy puts the wall on the
critical path of a guest's save: if the laptop sleeps, reboots, or loses the
hotspot, the phone shows an error and the drawing is gone. A queue takes the
wall off that path. The guest gets a 200 from a machine that is always up, and
a wall that was offline shows the drawings the moment it is online again.

Two-way, so the wall's own gallery (the owner's family pictures) reaches the
phones too, and a delete on either side is final on both.

## Pairing

The relay and the wall share one secret, the **wall key**. It is the only thing
that opens `/pull` and `/push`, and it is not the guest page's problem: the
page never sees it, and a guest cannot read the gallery through it.

```bash
# on jarvis
cd relay
docker compose up -d --build
docker logs ledwall-relay          # prints the wall key once, and the owner token
docker compose logs -f ledwall-relay

# on the wall laptop
npm run serve -- --relay https://wall.hoa.family --relay-key <the key from the log>
```

The key lives in `relay/data/wall-key.txt` (a volume), so a rebuild keeps the
pairing. The owner token lives beside it and prunes the relay's gallery.

## Caddy

`wall.hoa.family` already resolves (CNAME to this box) and Caddy already has a
`*.hoa.family` certificate via Porkbun DNS-01. Add the site block in
`relay/Caddyfile.snippet` to `/opt/homebrew/etc/Caddyfile`, then
`caddy reload`. The relay binds loopback only, like every other service here:
Caddy owns 443 and terminates TLS.

Caddy's `rate_limit` directive is **not** enabled, and not because of a version
number: experimental features are not registered in a Caddy that was not
started with `--experimental`, and `caddy run --help` does not even list that
flag. Adding the block makes the whole Caddyfile fail to load, and the reload
takes down every site on the machine. The relay's two gates cover the job, and
the shape of the edge limit is written (commented) in the snippet for whoever
enables the flag.

Validate before reloading, always:

```bash
caddy validate --config /opt/homebrew/etc/Caddyfile --adapter caddyfile
caddy reload   --config /opt/homebrew/etc/Caddyfile --adapter caddyfile
```

## The gates, and what each one is for

| gate | where | key | default | stops |
|---|---|---|---|---|
| politeness | relay | `x-wall-device` (a random id in localStorage) | 10 s, burst 6/min | one guest hammering save |
| flood | relay | real client IP (X-Forwarded-For, `--trusted-proxy`) | burst 40/min, no spacing | a script; NOT a room of guests |
| rate | wall | socket address | 10 s, burst 6/min, cap 200 | a flood on the local network |
| body | relay / wall | Content-Length | 8 KB per drawing, 1 MB per wall batch | a body that is not a drawing |
| `rate_limit` | Caddy | real IP | **off**: experimental features are not registered without `--experimental` | the internet at large |

The address gate at the relay is deliberately loose. Behind Caddy, every phone
in the room is one address: a 10-second spacing there is one drawing per ten
seconds for the whole party, which is the failure the device token exists to
remove. A device token is weak on purpose — a random string in localStorage,
gone with the browser, rotated by anyone with devtools. It is not a credential
and grants nothing. It is the difference between a per-guest limit and a global
one, and the flood gate stays underneath it.

## What the guest page can reach

The relay's entire surface is a table in `relay/server.js`: `/` (the guest
page), `/core/drawings.js`, `/draw-editor.js`, `POST /drawings`,
`DELETE /drawings/<id>`, `GET /healthz`, and the two sync verbs behind the wall
key. `/index.html` — the wall's console — is not in the table. `/content`,
`/capture`, `/drawings` (the list) are not either: a stranger cannot enumerate
the gallery, and cannot see the wall.

The boundary is the module graph, and the test asserts it as one: the guest
page imports `core/drawings.js` and `web/draw-editor.js`, opens no WebSocket,
and its entire fetch log is `POST /drawings` (plus its own takeback `DELETE`).

## Offline is a state, not an error

The wall's client backs off to 60 s, says the failure once, and keeps the local
gallery running the whole time. Every mutation on either side carries a `seq`;
the wall keeps two cursors (`sent`, `cursor`) in its store's state file, so a
reboot mid-party resumes where it left off, and deletes are tombstones on the
same number line — a drawing that was taken back does not come back on the next
sync.

## Flags

```
node relay/server.js [--port 8080] [--host 127.0.0.1] [--data <file>]
                     [--trusted-proxy]        # believe X-Forwarded-For (Caddy)
                     [--wall-key <hex>]        # else WALL_RELAY_KEY, else generated into <data-dir>/wall-key.txt
                     [--owner-token <hex>]     # else WALL_OWNER_TOKEN, else generated into <data-dir>/owner-token.txt
                     [--rate-spacing <ms>] [--rate-burst <n>] [--rate-window <ms>]
                     [--addr-spacing <ms>] [--addr-burst <n>]
                     [--max-drawings <n>]      # 0 = no cap (the owner clears the gallery by hand)
```

In a container, `RELAY_DATA`, `RELAY_TRUSTED_PROXY`, `RELAY_PORT`, `RELAY_HOST`
do the same jobs. `RELAY_HOST=0.0.0.0` is required inside the container:
Docker's `-p` forwards to the container's eth0, and a server bound to loopback
in there is unreachable � the mapped port answers with an empty reply. The
loopback discipline on this box is the **host** side of the mapping
(`127.0.0.1:8091`), which is the half the internet sees.

## The card on the table

`/card.html` is a print-friendly sign: the address in large type, in a box, and
a dashed square where a printed QR code goes. Open it on the machine that serves
the relay and print it � the address line reads `location.host`, so the paper
cannot disagree with the server. It has no fetches and no state; it is paper,
and it is on the relay's file list because that is where the address is true.

The QR itself is yours to generate (any generator, the URL is 25 characters).
A QR encoder is not worth shipping inside the wall: a subtly wrong matrix is a
party that cannot start, and nothing in this repo's test suite can scan one.

## Deployed on jarvis

`~/ledwall-relay/repo` (git clone), container `ledwall-relay`, host
`127.0.0.1:8091`, data in `relay/data/`. Deploy:

```bash
cd ~/ledwall-relay/repo && git pull && cd relay && docker compose up -d --build
docker logs ledwall-relay                       # the wall key (printed at first boot)
docker compose exec -T ledwall-relay cat /data/wall-key.txt    # the key, any time
docker compose exec -T ledwall-relay cat /data/owner-token.txt # the owner token
```

Rollback: `docker compose down`, and delete the site block from the Caddyfile
(a dated `Caddyfile.bak-ledwall-*` sits beside it).

## Tests

```
node --test test/relay.test.js test/relay-sync.test.js
```

`relay.test.js` is the public side: the guest's takeback token, the per-device
gate (not per proxy address), X-Forwarded-For believed only when a proxy was
declared, the wall key, two-way push with dedupe, tombstones, the static
surface, cursor persistence across a restart.

`relay-sync.test.js` is the wall's side: pulls what guests posted, pushes what
the owner saved, echoes nothing back, propagates deletes in both directions and
keeps them dead, keeps drawing while the relay is down and catches up when it
appears, and reports a refused key as a refused key.

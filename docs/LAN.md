# Finding the server on the home network (LAN fallback)

Every TV client used to know exactly one address, `https://marqu33.duckdns.org`.
Inside the house that name resolves (via the UDM Pro's local DNS record) to the
Dell, but a device that does not use the router for DNS, or a router without
the record, cannot reach a server that is sitting on its own LAN the moment the
internet drops. So every client also knows the server's **LAN address**, learned
while online, and races the two.

This file is the protocol. Every client implements the same thing; if you change
one, change them all.

## The server side: `GET /api/lan`

Public (no session needed), CORS `*`, never cached. Always returns:

```json
{ "app": "marquee", "id": "<server id>", "port": 8096,
  "lan": ["http://192.168.1.103:8096"], "internet": true }
```

- `id` — random, generated once and stored in `data/lan.json` (git-ignored).
- `lan` — `http://<ipv4>:<port>` for each private IPv4 on a physical adapter
  (VPN/virtual adapters such as PIA's `wgpia0`, Hyper-V `vEthernet`, `10.x` and
  link-local are skipped). `config.lanAddrs` (array of IPs) overrides detection.
- `internet` — whether the server can currently reach the internet (TMDB).

Optional query parameters add fields:

| Param | Adds | When |
|---|---|---|
| `nonce=<8-128 chars [A-Za-z0-9_-]>` | `proof` | Only on a **direct** request (the socket peer is a private address and the request did not come through Caddy). A request through the public name never gets a proof, so a proof cannot be relayed from the internet. |
| (a valid session: Bearer / cookie / `?token=`) | `key` | Any request. |
| `pair=<32-128 chars [A-Za-z0-9_-]>` | `key`, `token` | When that pair id was registered (below) and its token is still valid. |

**`proof` = lowercase hex of HMAC-SHA256(key, "marquee-lan:" + nonce)**, where
the HMAC key is the UTF-8 bytes of the `key` string itself (a 64-char hex
string; do not hex-decode it) and the message is UTF-8. Test vector (pinned in
`test/lan.test.mjs`): key `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
nonce `TestNonce123` →
`5228742fab314bfeacb3b8bd5a092dcec8f8f036ccffa9395841782884d9b9e3`.

`POST /api/lan/pair {pair}` (needs a session) binds a pair id to the calling
session's token. It exists for the web-view shells (Android TV, webOS), which
cannot read the web app's HttpOnly session cookie and so have no token of their
own to carry to another origin.

## The client side

State to persist per device:
`publicBase` (the configured public URL), `lanBases` (list from `lan`),
`serverId`, `lanKey`, and for the web-view shells a random `pairId`.

### Learning (whenever online and signed in)

- Native clients (Apple TV, Roku lib): `GET <activeBase>/api/lan` with the
  Bearer token → store `lan`, `id`, `key`.
- Web-view shells: `GET <base>/api/lan?pair=<pairId>` → store `lan`, `id`,
  `key`, `token`. Only call this over HTTPS (the public base) or on a LAN base
  that has already passed the proof check, because the pair id is a credential.
- Never learn from an unverified LAN base.

### Resolving (at launch, on a network change, and after a connection failure)

1. Start both probes at once:
   - **LAN**: for each cached LAN base (only if a `lanKey` is cached),
     `GET <lan>/api/lan?nonce=<fresh random>` with a ~2.5 s timeout. It
     **passes only if** `app == "marquee"`, `id == serverId` and `proof` equals
     the HMAC you compute. A wrong or missing proof is a failure, not a pass.
   - **Public**: `GET <publicBase>/api/lan`, ~6 s timeout. It passes on **any**
     HTTP response below 500 (a server that predates this endpoint answers 401,
     and that still proves it is up).
2. The first LAN pass wins immediately — LAN is preferred when both work.
3. Otherwise, once every LAN probe has failed or timed out, use public if it
   passed; else wait for public.
4. Neither: keep the last base and show the client's normal "can't reach"
   state, retrying as it already does.

Never send the session token, pair id, or anything else secret to a LAN base
before it has passed the proof check.

### After switching

- Everything that builds a URL (API calls, stream/HLS/subtitle URLs, TopShelf,
  art that is not already absolute) uses the active base. Art URLs in JSON are
  already absolute and point at whatever host the request used (see
  `src/artcache.js`).
- Web-view shells hand the session to the new origin so nobody signs in twice:
  Android sets the `mstoken` cookie for the new origin with `CookieManager`;
  webOS appends `&token=<token>` (the web app already turns that into its
  readable cookie). Both append `&pair=<pairId>` on their web-app URL so the web
  app registers the pair (it strips the parameter from the address bar
  afterwards).

## What is not done

- No mDNS/Bonjour. The cached LAN address is refreshed every time a client is
  online, and the Dell has a fixed address, so discovery by broadcast would only
  help if the Dell changed address during an outage.

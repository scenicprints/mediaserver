# Audio track selection — implementation brief

> For an agent picking this up cold. Everything needed is here; you should not
> need the conversation this came from. Read [../CLAUDE.md](../CLAUDE.md) first
> for how the project is built, run and deployed.

## The problem

The owner watches on an **Apple TV feeding a projector with a surround system**
and wants **no quality loss** there. Friends stream **from outside the network**
on **Android TV, Google TV, Roku**, and there is also a **VAVA 4K projector**
(Android-based, 32-bit ARM — see `androidtv/` per-ABI APK notes).

One audio track cannot satisfy both. A TrueHD or DTS-HD track is what the owner
wants at home and is exactly what forces the server to re-encode audio for
everyone else. The fix is to carry **more than one audio track per file** and let
the player pick — manually, or automatically from a device profile.

**This brief covers the Marquee-side work: listing tracks, choosing one, and
remembering the choice.** Producing the extra tracks is a separate job handled by
the storage optimizer (`src/optimize.js`).

## Device capability research

Verified September 2026. Do not "simplify" this table from memory — several
entries are counter-intuitive.

| Device | AAC | AC-3 | E-AC-3 | DTS | TrueHD |
|---|---|---|---|---|---|
| **Apple TV 4K** | yes | yes | yes (+Atmos via JOC) | **no** | **no** |
| **Roku** | yes | yes (most) | yes — *preferred* | passthrough only, no decode | **no** |
| **Android TV / Google TV** | yes | yes | yes | device-dependent | rare |
| **VAVA 4K projector** | yes | yes | yes | DTS-HD yes, **but known lip-sync bug** | no |
| **Browser (web player)** | yes | no | no | no | no |

Two findings that matter:

1. **Apple TV cannot pass through TrueHD or DTS-HD, and still cannot.** HDMI
   audio passthrough was expected in tvOS 26 and **did not ship**. The device
   decodes to multichannel LPCM or Dolby MAT. tvOS also refuses DTS in any form.
   The Marquee Apple TV app gets away with TrueHD/DTS today only because VLCKit
   software-decodes them and outputs multichannel LPCM — lossless samples, but
   **Atmos height objects are lost**, and some TrueHD streams crash the decoder
   (see `quant_step_size larger than huff_lsbs` in the optimizer notes).
2. **E-AC-3 is the only format every target handles natively.** It is Roku's
   recommended multichannel format, and Roku's own guidance is that apps should
   *also* always ship an AAC stereo fallback.

**Do not infer a device's speaker layout from its built-in speakers.** The VAVA
has stereo drivers but also eARC and optical out, so it may well be feeding a
surround receiver. Codec support and output layout are independent questions and
the profile below keeps them separate.

## Feature A — list and choose an audio track

**There is no endpoint for this yet.** `public/app.js` (~line 2402) has a
rudimentary menu built from the browser's `video.audioTracks`, which only works
when the browser is decoding and knows nothing about the real file.

**Add** `GET /api/audio/list/:kind/:fileId` → the audio streams of that file:

```json
{ "tracks": [
  { "index": 0, "codec": "truehd", "channels": 8, "language": "eng",
    "title": "Dolby TrueHD 7.1", "bitrateKbps": null, "default": true,
    "compatible": { "appletv": false, "roku": false, "androidtv": false, "browser": false } },
  { "index": 1, "codec": "eac3", "channels": 6, "language": "eng",
    "title": "Dolby Digital Plus 5.1", "bitrateKbps": 640, "default": false,
    "compatible": { "appletv": true, "roku": true, "androidtv": true, "browser": false } }
] }
```

- Source the stream list from the `media_info.audio_json` column the optimizer
  already populates (`src/optimize.js`), falling back to a live `ffprobe` via
  `probe()` in `src/ffmpeg.js` when a file has not been probed.
- `compatible` comes from the table above. Put that mapping in **one** exported
  constant so it is not duplicated across server and clients.
- Admin-gated like every other `/api` route; see `requireAdmin` usage patterns.

**Selection must reach playback.** `audioOpts(req)` in `src/server.js` (~1153)
already parses `?audio=surround`, `?dboost`, `?night`, `?norm`. Add
`?atrack=<index>` there and thread it into `playInfo()` and `transcodeStream()`
in `src/ffmpeg.js`, which currently hardcode the **first** audio stream. When a
track is chosen, the ffmpeg map becomes `-map 0:a:<index>` rather than the
default first-audio behaviour.

## Feature B — device profile that picks automatically

Add a **Device** section to Settings. The user states what they are watching on;
Marquee then picks the best track without being asked.

Two independent settings, because they are independent facts:

- **Device type** — `appletv` | `androidtv` | `roku` | `vava` | `browser` | `auto`
- **Audio output** — `surround` | `stereo`

Selection rule, in order:

1. An explicit per-title choice by the user (Feature A) always wins.
2. Otherwise pick the **highest-quality track the device can decode natively**,
   respecting the output setting — prefer a multichannel track when output is
   `surround`, a stereo track when it is `stereo`.
3. If nothing is natively compatible, fall through to today's behaviour and let
   the server transcode. This must never hard-fail playback.

`auto` should guess from the client: the TV apps can send an explicit value, the
web player defaults to `browser`.

## Feature C — pick the right *version*, not just the right track

**Strongly recommended, and probably worth more than A and B combined.**

The owner already keeps a **4K version for home and a 1080p version for remote
viewing**. That is what the duplicate files in the library are *for* — they are
deliberate, not redundancy. But nothing currently acts on it: version choice is
remembered per user in the `prefs` table (`verid:m<id>` / `verid:e<id>`, see
`public/app.js` ~1175), so a remote friend who once picked the 4K file keeps
getting the 4K file, and the server dutifully re-encodes it down.

`isRemote(req)` already exists in `src/server.js` (~89) and correctly identifies
off-network viewers by IP and Host. Use it: when a viewer is remote and no
explicit version choice has been made for that title, **default to the smallest
version at or below the remote cap** instead of the largest.

Measured 2026-09-09: the owner's upload is **~33 Mbps**, and the 1080p versions
run **2.5-4 Mbps**. They stream direct with enormous headroom. The remote cap
(`remoteMaxHeight` 1080 / `remoteMaxBitrateKbps` 6000, `config.json`) correctly
leaves such files alone — the transcodes seen in telemetry are almost all remote
viewers being served the **4K** file when a perfectly good 1080p one exists.

## Data model

Reuse the existing `prefs` / `user_prefs` tables. No schema change needed.

| Key | Meaning |
|---|---|
| `atrack:m<id>` / `atrack:e<id>` | chosen audio stream index for a title |
| `device` | device type from the Device settings section |
| `aout` | `surround` or `stereo` |

**Never use `localStorage` for these.** The owner watches from several devices
and per-browser storage has bitten this project before — see the Prefs note in
CLAUDE.md.

## Constraints

- **4K HDR files are never modified by the optimizer.** `isProtected()` in
  `src/optimize.js` enforces it in three places. This brief adds no file
  modification, but do not weaken that rule to "make selection easier."
- **The native TV apps already bypass transcoding.** `/api/play?native=1`
  (`src/server.js` ~1176) forces `mode: 'direct'` unconditionally. Track
  selection for those clients is therefore a *client-side* concern — libVLC picks
  the stream — so the Apple TV and Android TV apps need the chosen index passed
  through to the player, not a server-side remux.
- **The web player is the only client doing real transcoding**, and browsers
  support neither AC-3 nor E-AC-3. A browser viewer will still get an AAC
  transcode; that is correct and should not be "fixed" by degrading the file.
- Match the house style: vanilla front-end, no framework, `node:sqlite`,
  synchronous DB calls, ESM.

## Out of scope

Creating the additional audio tracks. That belongs to `src/optimize.js`, runs
behind its verify-before-delete gate, and is tracked separately. This brief
assumes files may have one track or several and must behave correctly either way.

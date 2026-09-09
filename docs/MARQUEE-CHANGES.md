# Marquee change log — for reimplementation on iOS

> Every user-visible change to Marquee, recorded as **behaviour** rather than as
> code, so the iOS app can be built to match without reading vanilla JS. Newest
> first. If you change Marquee, add to this file in the same pass — reconstructing
> it afterwards loses the reasoning, which is the part that matters.

---

## 2026-09-09 — Batch 2: device audio profile, track selection, playback endings

### Device audio profile

**What it is.** A setting in Settings ▸ Audio: *"What are you watching on?"* —
Detect / Apple TV / Android-Google TV / Roku / VAVA projector / Browser.

**Stored per DEVICE, not per account.** On web this is `localStorage`. On iOS use
`UserDefaults`. This is a deliberate exception to Marquee's rule that playback
preferences live server-side in `prefs`: a device's audio support is a fact about
hardware, not a taste. An Apple TV cannot decode DTS whoever is signed in.

**The capability table is an intersection and must be copied exactly.** Two
entries are counter-intuitive and cost real playback if guessed:

| Device | Can decode |
|---|---|
| Apple TV | aac, ac3, eac3, mp3, alac |
| Android / Google TV | aac, ac3, eac3, mp3, opus, vorbis, flac |
| Roku | aac, ac3, eac3, mp3 |
| VAVA 4K | aac, ac3, eac3 |
| Browser | aac, mp3, opus, vorbis, flac |

- **Apple TV cannot decode DTS or TrueHD**, and HDMI audio passthrough did **not**
  ship in tvOS 26 — it decodes to multichannel LPCM instead. The Marquee tvOS app
  only plays DTS today because VLCKit software-decodes it.
- **Opus plays on Android TV but not on Apple TV or Roku.** Assuming otherwise
  made an earlier pass miss 271 files.
- **Roku cannot decode TrueHD at all** and only passes DTS through.

**Speaker layout is a separate question from codec support.** The existing Audio
output (Stereo / Surround) setting stays independent: a projector with stereo
drivers may be feeding a surround receiver over eARC. Do not infer one from the
other.

### Audio track selection

**New endpoint** `GET /api/audio/list/:kind/:fileId` → `{ tracks: [...] }`, each
with `index` (0-based among audio streams), `codec`, `channels`, `layout`,
`language`, `title`, `bitrateKbps`, `default`, `commentary`, and a `playable` map
per device type.

**New query parameter** `?atrack=N` on `/api/play`, `/api/transcode` and
`/api/seekpoint`, threaded into ffmpeg as `-map 0:a:N`. Without it ffmpeg takes
the first audio stream, which on a DTS-first remux is exactly the one an Apple TV
cannot decode.

**When the chooser appears:**

- **Before the pre-roll**, never after — the pre-roll is theatre and shouldn't be
  followed by a dialog.
- Only when the device can play **more than one** track. One playable option is
  not a choice; pick it silently.
- **Never on an auto-advance.** A binge must not become a quiz. The player is
  told `autoAdvance: true` when the play came from an Up Next chain or Live TV.
- If the device can play **nothing** in the file, don't ask — let the server
  transcode as before. Playback must never depend on this feature working.

**Nothing is remembered between sessions.** A stored track index goes stale the
moment a file changes, and a remembered wrong choice is worse than asking again.
A manual pick does carry forward down an Up Next chain, so a binge stays
consistent, and dies when you leave.

**Auto-pick ranking:** match the speaker layout first (surround wants the most
channels; stereo prefers an actual 2.0 track), then match the codec/language
already chosen in this chain, then bitrate, then the container's default flag.
**Commentary tracks never win automatically** — detected by a `comment`
disposition or "comment" in the title.

**Remote control:** arrows move, Enter selects, Back/Escape takes the default.

### Version selection for remote viewers

`GET /api/settings` now returns `remote` (boolean, decided server-side by IP and
Host) and `remoteCap` `{ height, kbps }`.

**When a viewer is remote and has made no explicit choice, play the SMALLEST
version at or under the cap**, not the largest. The owner keeps 1080p copies
alongside 4K ones precisely for this; nothing used to act on it, so a remote
viewer who once opened the 4K kept getting it re-encoded on every play. That was
most of the transcoding visible in telemetry. An explicit choice still wins.

### Playback endings — three separate faults

1. **Live TV never advanced.** Both tune paths passed `onEnded: null`, so a
   finished programme sat on a dead picture. Now the channel rolls on: the next
   item from the guide is offered as an Up Next card and plays automatically. The
   channel index is captured at tune time, so a programme ending never tunes
   whatever the user has since highlighted.
2. **Binge only advanced if you clicked.** The Up Next card had Play Now and
   Dismiss and **no countdown**, so it waited forever. It now counts down visibly
   and advances at zero. Dismiss cancels it and it will not re-offer for that
   episode.
3. **Movies ended and sat there.** Films pass `onEnded: null` because there is
   nothing to roll into, and nothing handled that. There is now an end card —
   *Watch again*, *Back*, and **the next film in the collection** when the library
   has it — which also returns on its own after 90 seconds for when you fell
   asleep.

**And a fourth, which caused intermittent "sometimes it doesn't advance":** the
guard that ignores a transcode stream ending mid-film used an 8-second window.
Transcoded MKVs routinely report a duration disagreeing with the real stream by
more than that, so genuine endings were swallowed and the chain died silently. It
now treats an ending as real if within 60s of the end **or** past 97% of the
reported duration.

### Deployment note

`config.json` was pointed at an **ffmpeg 7.x** build. ffmpeg 8.1.2 requires nvenc
API 13.1 (driver 610+) and this box's GTX 1050 Ti is on 560.94 / API 12.2, so
every NVENC encode was failing its probe and all transcoding silently ran on CPU.
Restarting picks this up; hardware encoding returns.

---

## 2026-09-09 — Batch 3: the same behaviour on the Apple TV app

Batch 2 ported to `appletv/` (SwiftUI + VLCKit). Same behaviour, three
deliberate differences, all of them because tvOS is not a browser.

### Version selection for remote viewers — same

`PlaybackPolicy` in `Store.swift`: `isRemote` is filled from `GET /api/settings`
on every home load, and both `bestFile` properties go through it. Off-network a
title with several versions plays the **smallest non-4K** copy; on-network the
server's own best-first order stands.

### Audio track selection — same ranking, different surface

**Difference 1: there is no chooser dialog before the pre-roll.** libVLC
software-decodes every codec in the library, so on tvOS the question is never
*can this play* — only *which one is right*. A modal in front of every film on a
projector would be worse than the problem. The tracks are instead auto-picked
silently and the player's existing audio menu (gear ▸ Audio) is the manual
override, now labelled from the server (`ENG · DTS · 5.1`) instead of libVLC's
"Track 1".

Ranking is Batch 2's, unchanged: speaker layout first (surround wants the most
channels, stereo prefers a real 2.0 mix), then bitrate, then the container's
default flag; **commentary never wins automatically**.

**The bridge between the two track lists is ordinal position.** libVLC's track
ids are not stream indexes and its names are not parseable, while the server
returns ffprobe's audio streams in container order. Position N in one is
position N in the other. If the two counts disagree, something is being
filtered, the mapping is not trustworthy, and VLC's own choice is left alone.

**Difference 2: no device-type setting.** The device is an Apple TV; there is
nothing to choose. The Audio output (Stereo/Surround) setting stays, and now
*defaults* from the actual HDMI route — more than two output channels means a
receiver, so it starts on Surround. A stored choice always wins.

### Playback endings — the same three faults, and one more

1. **Live TV never advanced.** `TunedLive` and `LivePlayer` now carry the
   channel they were tuned from, and `LivePlayer` resolves whatever the guide
   says is on next into the player's Up Next queue. So a finished programme
   rolls on through the ordinary advance path instead of dismissing to the
   guide. The channel is captured at tune time, so a programme ending never
   tunes whatever has since been highlighted.
2. **The Up Next card had no countdown.** tvOS did auto-advance at the end, but
   silently — the card just sat there giving no sign it was going to act. It now
   counts down visibly, and has a **Dismiss** button, which stops the roll-on for
   that episode only.
3. **Films dismissed straight back to the detail screen.** Correct, but abrupt
   enough to read as a crash. There is now the same end card as the web —
   *Watch again*, *Back*, and **the next film in the collection** when the
   library has it — returning on its own after 90 seconds. The next part is
   resolved to a playable file at play time, so the end card never has to wait.
   Live TV that runs out of guide, and a dismissed binge, still just leave.
4. **`playNext()` was hardcoded to the episode endpoint.** Fine for a TV binge,
   wrong for a Live TV channel, which mixes films and episodes: rolling into a
   film asked `/api/stream/episode/<movie file id>` and got nothing. It now
   picks the endpoint — and the `kind` that progress reporting and audio probing
   use — from what is actually being played.

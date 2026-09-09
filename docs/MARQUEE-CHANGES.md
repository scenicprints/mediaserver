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

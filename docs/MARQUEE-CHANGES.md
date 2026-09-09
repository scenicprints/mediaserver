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

---

## 2026-09-09 — Skip Credits everywhere, and neither skip card on Live TV

### The gap

Skip Intro shipped on all three clients. Its other half did not: **Skip Credits
existed only in the web player.** The Apple TV app and the Android TV native
player each had the intro pill and nothing at the end of an episode, which reads
as a broken pair rather than a missing feature — a viewer who sees Skip Intro
work reasonably expects the other one.

The Android side was the most clearly unfinished: the WebView shell has been
sending `hasUpNext: !!ctx.onEnded` in the handoff spec all along
(`tryNativeHandoff`), and `PlayerActivity` never read it. The wiring was there;
only the button was missing.

### What it does

Same rule as the web, on every client: a **named credits chapter** where the file
has one, otherwise the **last 45 seconds of an episode that has a next one**.
Bounded at both ends, so it cannot linger. It goes to the next episode — it does
not seek to the end of this one. That is what the web button has always done and
what people mean by it.

- **Apple TV** — a twin of its Skip Intro button (same size, fill, corner radius
  and stroke), hidden while the Up Next card is up: two controls doing the same
  job is worse than one.
- **Android TV** — a twin of its Skip Intro pill, same corner, same "▸ (OK)"
  suffix. The two never coexist, one being at the start of an episode and the
  other at the end. It reports the same outcome a natural ending does, so the web
  shell's Up Next chain runs unchanged rather than the player seeking to the end
  and making the viewer watch a black frame first.

**Each button matches the app it lives in, not the other apps.** The web player
is on the Braun language — square corners, uppercase, letterspaced; Apple TV's is
a rounded filled pill; Android's is a white rounded pill. Importing one client's
styling into another would have made the new button the odd one out on its own
screen.

### Neither card appears on Live TV

There is no intro to skip past on a channel and no credits to skip out of — the
next programme arrives on its own. This was already true on the web (`.vp-live
.vp-skipbtn` is `display:none`, and `updateSkipButtons` returns early, which now
also hides them rather than leaving them as they were) and on Android (`!live`).

**It was NOT true on Apple TV**, which loaded an intro range for any episode
including one tuned from a channel — so a Live TV programme could show a Skip
Intro button positioned from the episode file's own fingerprint, over a
programme already in progress. `loadMeta()` now skips the lookup when `live`.

This is about the two SKIP cards only. Live TV still offers the next programme
as an Up Next card and still rolls on by itself; that is channel continuity, not
skipping, and it stays.

### Also

The Apple TV Up Next card's **Dismiss** now sits under the card, right-aligned
with it, instead of floating beside it. The web keeps its actions inside the
card, which tvOS cannot do — a Button's label cannot contain another focusable
Button — and beside it the capsule read as unrelated to the card.

---

## 2026-09-09 — Live TV offers no way to skip, on any client

Not just the skip cards: **a channel exposes no seeking at all.** You cannot
rewind, jump forward, or scrub one, because there is nowhere to scrub to — the
schedule decides what is on.

This was already true on the web (`.vp-live` hides the scrub bar, the transport
and the clock) and on Android TV (`seekBy()` returns immediately when `live`).

**Apple TV was the outlier and allowed all of it.** A tuned channel got the full
scrubber with a progress thumb, a `position / duration` clock, and D-pad
left/right wired straight to `jump(±10)` with no live check anywhere. Now:

- `jump()` refuses when live, so no future caller can reintroduce seeking by
  accident;
- `skipIntro()` refuses when live too — that is the other way into a seek;
- the scrubber is **not rendered** on a channel rather than merely disabled. It
  is the surface the D-pad seeks from, so leaving it on screen would keep ±10s
  reachable however well the seek itself is guarded;
- the clock is replaced by a **LIVE** flag, because a position within a
  programme you joined halfway is not information anyone wants.

Play/pause is deliberately left alone — pausing is not skipping. Worth revisiting
separately: the web hides it on a live feed, and pausing a simulated-live channel
desyncs it from the schedule.

### A note on the tvOS palette

The LIVE flag uses `VP.accent2`, the treatment the player already gives its own
"UP NEXT" label — not the web's Braun orange. The tvOS **browse** UI is on the
Braun palette (`Theme.Palette.signal`, "Braun orange. State only, never
decoration"), but `PlayerView` deliberately carries its own `VP` set, described
in the source as "the web player's tokens". Those tokens are the pre-Braun
purple/blue ones, so orange would have been the only warm thing on that screen.

**That divergence is worth a decision at some point**: the tvOS player is styled
to a version of the web player that no longer exists. Left as-is here rather than
restyled in passing.

---

## 2026-09-09 — The Apple TV player joins the rest of the app

The tvOS **browse** UI is Braun. The **player** was not, and nobody had noticed
because it looked deliberate: `PlayerView.swift` carried its own palette called
`VP`, commented "the web player's tokens (style.css :root)" — but those tokens
were the ones the web had *before* it was restyled. Purple `#6c5cff`, cyan
`#37c2ff`, a diagonal gradient between them, and glow shadows. 29 uses of `VP`,
zero uses of the app's `Palette`.

So the one screen you spend a whole film looking at was the only screen not
speaking the app's language.

`VP` is now defined in terms of `Theme.black` rather than deleted, so all 29 call
sites keep reading sensibly while the look changes underneath them:

- **One signal colour.** `accent` and `accent2` both resolve to `pal.signal` now,
  and `grad` is a flat colour, not a `LinearGradient` — the purple/cyan pair only
  ever existed to make a gradient, and Braun does not gradient.
- **Always the dark finish**, whatever the app's finish setting says. This chrome
  sits on top of a picture, and light chrome over a picture is unreadable.
- **Squared off.** Every `Capsule` and `RoundedRectangle` is a `Rectangle`. The
  round transport buttons stay round — a dial is Braun; rounded plastic is not.
- **Small caps, letterspaced.** SKIP INTRO, SKIP CREDITS, DISMISS, UP NEXT,
  FINISHED, LIVE.
- **The scrub bar is a scale, not a tube**: thinner, and its thumb is a hairline
  cursor rather than a glowing dot.
- **The focus ring is a switch that is selected, not a light that is glowing**: a
  hard rectangle in the signal colour, no 22pt bloom, and a 1.03 lift instead of
  1.08.

The LIVE flag added earlier the same day is `pal.signal` accordingly — state,
never decoration, which is what LIVE is.

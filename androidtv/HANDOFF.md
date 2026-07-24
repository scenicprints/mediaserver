# Android TV ("Google OS") — native player handoff

> **STATUS 2026-07-20: SHIPPED (v1, awaiting on-TV verification).**
> `PlayerActivity.kt` (libVLC 3.6.5 — newest 3.x that compiles against SDK 34;
> 3.7.x demands compileSdk 36) direct-plays `/api/stream` via the
> `MarqueeTV.playNative` web-bridge handoff in `public/app.js`. The web player
> is the automatic fallback: old APK, the Settings ▸ Audio "Classic" toggle, or
> a native failure (which reopens the same title in the web player at the same
> position). `/api/play?native=1` logs truthful direct-play stats — compare
> transcode share before/after in Settings ▸ Diagnostics. CI note: branch
> pushes of `androidtv/**` are compile checks only; main publishes the rolling
> release. Still open: on-TCL verification, audio-track picker, caption delay,
> Up Next overlay inside native (currently chains through the web app between
> episodes), HDR display-mode switching (deliberately NOT attempted — see the
> tvOS crash below).

**Original goal (context):** bring the Android TV app to the same standard we
achieved on Apple TV — a **native player that direct-plays everything** — by
copying how Plex works. Repo root: `C:\mediaserver`. This app: `androidtv/` (Kotlin).

---

## 🔴 Why this matters — LIVE evidence (captured 2026-07-17)

A real remote user was watching on Android TV **right now**, and it's actively
broken. From `GET /api/admin/sessions`:

- **User `trvsmith5`**, **Ted Lasso S2·E6**, paused at **0:56 / 35:08**.
- Device UA: `Android 11; Smart TV … wv … Chrome` → the **Marquee Android TV app
  (a WebView of the web player)**.
- **Remote** (public IP), downlink ~9.7 Mbps.
- Server decision: **`mode: transcode`** — `video: transcode → 1080p ≤6000k
  (remote)`, `audio: downmix → stereo`. Source = 4K HEVC (3840×1920, 7.5 Mbps,
  E-AC-3).
- **`transcodeSpeed: 0.0165`** → the Dell encodes at **1.6 % of real-time**.
- **`watchingForSec: 5952`** → connected **99 minutes**, watched **56 seconds**.
  Effectively unwatchable.

**Root cause:** Android app is a WebView → the web `<video>` can't decode 4K HEVC
remotely → server is forced to transcode → the Dell (software encode, weak GPU)
chokes at 0.0165×.

**The fix (same as Apple TV):** a **native libVLC player** direct-plays the raw
`/api/stream` URL — libVLC decodes 4K HEVC on-device, **no server transcode at
all**. Bandwidth fits (7.5 Mbps source < 9.7 Mbps downlink), so it would stream
directly and smoothly. This isn't cosmetic parity — it fixes a broken
remote-playback experience for real users.

---

## How we fixed Apple TV (by studying Plex, then copying its architecture)

- **Problem:** the Apple TV app (SwiftUI/tvOS, `appletv/`) used Apple's native
  AVPlayer, which refuses MKV, `hev1`-tagged HEVC, HDR, E-AC-3 — so HEVC
  "wouldn't play." The server's HLS-remux workaround was fragile.
- **We investigated Plex** (installed on the same machine — logs at
  `%LOCALAPPDATA%\Plex Media Server\Logs`): Plex for Apple TV **direct-plays
  everything** (client profile declares direct-play for `container=mkv &
  videoCodec=*`; **zero** playback transcode sessions in its logs). Plex "just
  works" because it ships its **own bundled libVLC/libmpv player** that decodes
  every container/codec itself — it never uses the OS-native player and never
  asks the server to remux.
- **We copied that:** replaced AVPlayer with **VLCKit (libVLC)** — SPM package
  `tylerjonesio/vlckit-spm` 3.6.0, `import VLCKitSPM`. The app now points at the
  raw byte-range stream `GET /api/stream/:fileId` (and
  `/api/stream/episode/:fileId`) and libVLC plays any file. **No server remux.**
- **We matched the web player's UI** (`public/app.js` + `public/style.css`) —
  the design source of truth (and the current Android app is literally a WebView
  of it). Gradient scrubber (`--grad` #6c5cff→#37c2ff), 3-zone HUD (title top /
  round-glass −10·play·+10 center / bottom scrim with scrubber + `elapsed/total`
  + CC + gear), the web focus ring (white inner + purple outer + glow + scale),
  scrollable gear/CC menu with **"✨ Generate with AI…" FIRST**, Off, tracks;
  Skip Intro; Up Next autoplay.

**Reference implementation to read: `appletv/Sources/PlayerView.swift`.**

---

## Your task: do the SAME for Android TV

1. **Investigate first** (like we did): confirm how Plex's *Android* client plays
   media (Plex Android = ExoPlayer + an mpv/libVLC fallback for universal
   playback). Choose the Android equivalent of VLCKit — **recommended: libVLC for
   Android** (`org.videolan.android:libvlc-all`) for maximum codec coverage
   matching the Apple TV VLCKit build. ExoPlayer/Media3 is an alternative but
   doesn't cover everything. Pick and justify.
2. **Build a native Android TV player** (Leanback or Compose-TV) that direct-plays
   the raw `/api/stream` URL with libVLC — **no server remux**, exactly like
   Apple TV. Replace the WebView playback path.
3. **Match the web-player design** (`public/app.js` + `style.css`) — gradient
   scrubber, 3-zone HUD, focus ring, gear/CC menu with AI-subtitles FIRST, Off,
   tracks, Skip Intro, Up Next. Native D-pad focus (the WebView currently just
   forwards keys).

### Server APIs (all exist; `src/`)
- `GET /api/stream/:fileId` & `/api/stream/episode/:fileId` — raw byte-range video
- `GET /api/subtitles/list/:kind/:fileId` → `[{label, idx}]`
- `GET /api/subtitle/:fileId?idx=N` (movie) / `/api/subtitle/episode/:fileId?idx=N` — WebVTT
- `POST` + `GET /api/subtitles/generate {kind,fileId,target=orig|en|es}` — Whisper
  AI subs; poll returns `{status,pct,phase}` — **show a live %** the user can
  check on
- `GET /api/play/:kind/:fileId` — `{intro:{start,end} (episodes only), chapters}`
- `GET /api/mediainfo/:kind/:fileId` — `{width,height,fps,hdr,bitDepth,vcodec,acodec}`
- `POST /api/session/heartbeat` + `/api/session/end`, progress endpoints — resume
  + admin now-playing (`GET /api/admin/sessions` to observe live sessions)
- Auth: `?token=<token>` (tokens table in `data/library.db`, node:sqlite)

---

## Learnings / gotchas from the Apple TV build (apply the analogs)

- **Threading:** libVLC delivers callbacks off the main thread — update UI state
  only on the UI/main looper (an off-main UI mutation crashed the tvOS app).
- **Captions default ON** with libVLC (it auto-enables the first embedded text
  track) — force them **off** unless the user picks one.
- **Resume:** don't use a "start at" option that seeks before playback is ready
  (it crashed/restarted on tvOS). Seek to the resume position **once, after the
  player is actually playing & seekable**.
- **HDR:** to actually output HDR the app must switch the display mode itself (the
  OS won't infer it from a custom player). Android TV: `Display.getMode` /
  `preferredDisplayModeId` / MediaCodec HDR. Apply it **before** the player starts
  rendering (mid-play display reconfigure crashed the tvOS video surface). (On
  tvOS this is still unverified — see Apple TV status below.)
- **Remote transcode is death on this hardware** (0.0165× — see live evidence).
  Native direct-play is the whole point.

---

## ⚠️ TOP PRIORITY — UNRESOLVED on Apple TV (finish this too)

**HDR display-switching is broken TWO ways, and it's the root of both symptoms:**

1. **It does NOT engage HDR output** — no HDR badge on the TV/projector even when
   playing 4K HDR10 (Ted Lasso) from the beginning. The
   `AVDisplayManager.preferredDisplayCriteria` /
   `AVDisplayCriteria(refreshRate:formatDescription:)` switch is a silent no-op.
2. **It CRASHES on RESUME** (app closes). Correct diagnosis (my earlier
   `:start-time` theory was WRONG — removing it did not fix resume):
   - Build with the HDR switch **OFF** (`92cae93`): resume worked fine.
   - Builds with it **ON** (`4bb24d4`, `83e2bbf`): resume crashes; from-beginning
     does not.
   - The only resume-specific action is the **seek** to the saved position. So the
     crash is the **HDR display reconfigure colliding with the seek** — the seek
     (`player.time = …` in `handleTime`, fired on first time-update) happens while
     the display is still switching mode, killing libVLC's video surface.
   So: HDR switch (in `applyDisplayCriteria`, called from `start()`) both fails to
   produce HDR AND destabilizes playback.

**What to do — stop guessing, get evidence:**
- INSTRUMENT `applyDisplayCriteria` + the resume seek: log each step to the
  server (before media-info → built format desc → about to set
  preferredDisplayCriteria → set OK → before seek → after seek) so the next crash
  reveals the EXACT line. Or pull the TestFlight crash report from App Store
  Connect.
- The AVDisplayManager approach may be wrong for a VLCKit/Metal video surface —
  research how **VLC-iOS / Infuse** do tvOS HDR + refresh-rate switching (they may
  configure libVLC HDR passthrough directly rather than using AVDisplayManager,
  or they tear down / re-create the video output around the mode switch).
- **Immediate safe state:** DISABLE the display-switch (comment out the
  `applyDisplayCriteria(mi)` call in `start()`). That makes the app fully stable
  (resume works, as in `92cae93`); libVLC still DECODES HDR — you just don't get
  the OS mode-switch until this is solved properly.
- tvOS also requires Settings→Video&Audio→**Match Content** ON for
  `preferredDisplayCriteria` to have any effect — but that alone won't fix the
  crash; the switch↔seek collision is the real bug.

**The same HDR trap will hit the Android native player** — apply the display/HDR
mode change BEFORE the player renders and DON'T seek during the reconfigure.

## Where the Apple TV work left off (context; don't regress)

- **Latest TestFlight build: commit `83e2bbf` (main).** Apple TV fully on VLCKit;
  web-matched premium player; Plex-style Library (continuous grid, Movies/TV
  toggle, A-Z jump rail, condensed genre + Unwatched filters); version-picker
  shows sizes; franchise release-order sort; branded MARQUEE logo/top-shelf.
- **Verified working on device:** HEVC/MKV/E-AC-3 playback, HUD, subtitles incl.
  AI generation, no white-flash, no from-beginning crash.
- **Other recent (assume UNVERIFIED):** live AI-subtitle %, condensed genres,
  A-Z jump. The resume crash + HDR are the open items above.
- **Build/test loop (no Mac; owner on Windows):** push to `appletv/**` → GitHub
  Actions "Apple TV preview shots" = Simulator COMPILE CHECK (does not ship);
  "Apple TV app" = TestFlight, `workflow_dispatch` MANUAL only. Read CI logs via
  the stored GitHub credential. See `appletv/HANDOFF.md`.
- **Android build/ship:** check `androidtv/build.gradle`, `keystore/`, and the
  `.github/workflows/` for the Android APK/self-update pipeline before shipping.

**Start by reading:** `appletv/Sources/PlayerView.swift` (reference),
`public/app.js` + `style.css` (design), `androidtv/app/src/main/.../MainActivity.kt`
(current WebView), and confirm the Plex-Android approach before writing code.

# Apple TV app — continuation guide

Read this first, then the `apple-tv-app-decision` auto-memory (loaded every
session). Everything is pushed to `origin/main` (scenicprints/mediaserver,
public repo). **Coordinate: only ONE session edits shared code at a time; this
app work has stayed inside `appletv/` — never touch `public/*`, `androidtv/*`,
and touch `src/server.js` only for the HLS hook already in place.**

## TL;DR — where we are (2026-07-14)
Native **SwiftUI tvOS** app ("Marquee") for the media server, shipping via
**TestFlight** (owner has no Mac → cloud macOS CI). The app is **built,
signed, and installing on the owner's Apple TV**. Full 1:1 parity with the web
app (`public/`) is the goal and is ~90% done. The pipeline is green and
repeatable. There is also a **preview pipeline** that screenshots the real app
in the tvOS Simulator so we review look **before** shipping to TestFlight.

## How to SHIP (owner ships from PC, or you push)
- Any push under `appletv/**` triggers `.github/workflows/appletv.yml` →
  builds on macos-15 → TestFlight. Owner has auto-distribution on ("Marquee
  Testers" internal group) so the Apple TV auto-updates.
- Watch a run: `gh run watch <id> --exit-status`; failures are almost always a
  Swift compile error — `gh run view <id> --log-failed | grep error:`.
- **Do NOT regress these CI fixes:** runner = **macos-15** + `xcode-select`
  newest Xcode (XcodeGen emits objectVersion-77); **archive with
  `CODE_SIGNING_ALLOWED=NO`**, sign at export; ASC API key must be **Admin**
  role; `ITSAppUsesNonExemptEncryption=false` in Info.plist skips the
  compliance prompt.

## How to PREVIEW without shipping
- `gh workflow run "Apple TV preview shots"` → `.github/workflows/appletv-preview.yml`
  builds for the tvOS Simulator, boots it, and screenshots each tab, uploaded
  as the `preview-shots` artifact. Also runs automatically on push to
  `appletv/**`. Its main value is as the **Swift compile check** (no local
  toolchain on the owner's Windows box).
- **DO NOT deliver screenshot galleries to the owner anymore** (2026-07-14):
  the JPEG/Artifact galleries rendered at "1/4 of the image" on his end and he
  ended that loop — "just ship it". He reviews on the actual Apple TV. The loop
  is now: change → preview build green → owner says ship → ship.
- It uses **mock data from TMDB** (secret `MARQUEE_PREVIEW_TMDB`) because the
  owner's server is often offline/unreachable from CI — see
  `Store.loadPreviewMock` + the `PREVIEW_*` env hook in `MediaServerApp.swift`.
- Download shots if you need them: `gh run download <id> -n preview-shots`.
- **Known harness flakiness:** the tab captured right after the first
  terminate+relaunch (Movies) reliably photographs the tvOS boot/home screen.
  A size-based retry (<300 KB → relaunch) is in the workflow but the ~1.8 MB
  springboard grab still slips past — if it matters again, also retry when the
  screenshot's md5 matches the previous tab's, or sleep between terminate and
  relaunch.

## What's built (Swift in `appletv/Sources/`)
Home/Movies/TV as **BrowseScreen** (rotating **Marquee hero** — weekly pick of
6, 9s rotation + dots — over the web's full categorized rows); rich **movie
detail** (cast, More Like This, Favorite/Watched, version picker, Resume + From
Beginning); **TV detail** with **season cards** + episodes; **Library** A-Z;
**Live TV** = full DirecTV-style **EPG** (movies + TV episodes, LT_EPOCH
schedule, hero preview + guide grid); **Collections**, **Search**, **Requests**;
**full Settings** with admin-only gating (`store.isAdmin`); **AVPlayer**
playback with resume + progress sync + **pre-roll** (AVQueuePlayer);
**streaming merge** (Movie/Show decode string ids `stream:movie:123`; provider
badges + deep-links). Player routes non-mp4/m4v/mov containers to **HLS**.

## Server HLS — DEPLOYED (needs on-device test)
`src/hls.js` (`/api/hls/*`) is wired into `src/server.js` and pushed. Additive,
transcodes mkv/etc. to HLS for AVPlayer. **Not yet verified on-device** — the
first real .mkv is the test. Subtitles (below) will extend this module.

## ROADMAP — prioritized, pick up here
**2026-07-14 (later): owner's first real on-device review came back with ~15
issues; ALL were addressed in one big batch (commit `aaa322a`) — see the
auto-memory for the list.** The headline pieces of that batch:
- **HLS v2 (`src/hls.js`)** — full VOD playlist + seek-on-demand ffmpeg restarts
  (absolute segment numbering, `-copyts`, keyframes forced on the 6s grid,
  NVENC when present). Fixes the "LIVE" badge on transcodes, gives real
  duration/scrubbing, makes resume + Live TV join-in-progress work, and
  `master.m3u8` lists WebVTT subtitle renditions (sidecar/embedded/AI) so the
  NATIVE tvOS CC picker works. Video is always re-encoded (never copied) so
  segments align with the uniform playlist — revisit if quality/load complains.
- Subtitle-aware playback: native containers with subtitle tracks also route
  through HLS (`Store.resolvePlaybackURL`) so CC is available; "AI Subtitles"
  buttons on movie detail + episode long-press call `/api/subtitles/generate`
  and poll.
- Player heartbeats `/api/session/heartbeat` (admin Now Playing works from
  tvOS) and shows Skip Intro/Credits via `AVPlayerViewController
  .contextualActions` from `/api/play` intro/chapter data.
- Server additions (all additive): `show_title` on `/api/continue`, TV cast on
  `/api/shows/:id/extra`, `registerHls(app, db, { allSubtitleTracks })`.
- UI parity: card labels below posters (always visible), wordmark scrolls with
  the page, Home rows mixed, Collections decode fixed (meta:* ids), Library/
  search include streaming, show detail is a movie-style description window,
  movie overview moved BELOW the splash, Live TV guide times floored to
  :00/:30 + wider labels + custom row focus (no white platter).

**Still open / verify next:**
1. **On-device re-test of everything above** — especially mkv seek/scrub (HLS
   v2 is unverified on real hardware), Skip Intro appearing, CC picker showing
   tracks, admin Now Playing, Live TV joining mid-program.
2. **Server deploy**: the Dell picks up `src/*` only when the owner runs the
   web app's update (git pull + restart via run.bat). HLS v2 + the endpoint
   additions need that before on-device testing shows them.
3. **TV-show Back exits the app** — `.toolbar(.hidden,for:.tabBar)` fix is
   STILL unconfirmed. If broken, switch detail to fullScreenCover +
   `.onExitCommand { dismiss }`.
4. Preview harness flakiness (sim grabs the tvOS home screen for random tabs —
   re-run); detail/Collections screens aren't captured yet.
5. Not done: trailer playback (YouTube on tvOS — skipped by choice); dboost/
   night/norm audio filters are ignored on the HLS path (only stereo fold).
6. An uncommitted `androidtv/MainActivity.kt` change sits in the owner's
   working tree (not from an Apple TV session) — left alone, don't commit it.

## Facts a new chat needs
- Bundle `com.scenicprints.marqueetv`, app name "Marquee TV". Server default
  `https://marqu33.duckdns.org`. Owner Apple ID **`jbkevinwagner@gmail.com`**.
- Secrets already set: `APPLE_TEAM_ID` W44MLC3KC2, `ASC_ISSUER_ID`
  9607b849-ad0d-4854-8c2f-c232d8d07dca, `ASC_KEY_ID` 92DYT68946 (Admin),
  `ASC_KEY_P8_BASE64`, and preview `MARQUEE_PREVIEW_TMDB` (+ USER/PASS/SERVER).
- Owner isn't a CLI person; owner-only steps (Apple portal, secrets, installing
  TestFlight) go one at a time via the browser. Ship grouped, meaningful updates.
- Owner can't reach the server from their dev PC (LAN NAT hairpin); the Apple TV
  and CI reach it when it's up.

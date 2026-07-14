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

## How to PREVIEW without shipping (the review loop we now use)
- `gh workflow run "Apple TV preview shots"` → `.github/workflows/appletv-preview.yml`
  builds for the tvOS Simulator, boots it, and screenshots each tab, uploaded
  as the `preview-shots` artifact.
- It uses **mock data from TMDB** (secret `MARQUEE_PREVIEW_TMDB`) because the
  owner's server is often offline/unreachable from CI — see
  `Store.loadPreviewMock` + the `PREVIEW_*` env hook in `MediaServerApp.swift`.
- Download + view: `gh run download <id> -n preview-shots -D /tmp/shots`.
- To show the owner: downscale the PNGs to JPEG + base64 into an HTML page and
  publish via the Artifact tool (that's how the gallery was delivered).
- **Known harness flakiness:** Library & Settings tabs sometimes capture the
  login screen (the mock token gets cleared mid-run). FIX: give `Store` a
  `previewMode` flag so `isLoggedIn` stays true and a 401 can't clear it in
  preview. Detail/Collections/Requests/Search aren't screenshotted yet — add
  them (detail needs launching straight into a `.movie(id)` route).

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
Owner saw build 13, said it "looked nothing like" the web, gave 11 issues;
fixes shipped in batches H/I/J (see auto-memory). **Still open, roughly in order:**
1. **Confirm the H/I/J fixes on-device** — owner has only seen the preview
   gallery, not the fixes on the actual Apple TV. Get their read first.
2. **AI/Whisper subtitles in the player** (owner-requested, item 11). AVPlayer
   needs subs as an HLS WebVTT rendition — extend `src/hls.js` to add a
   subtitle group (extract embedded subs via ffmpeg `embeddedSubtitles`/
   `extractSubtitle`, and external/OpenSubtitles/Whisper via `/api/subtitle/*`).
   Add a CC picker + "Generate AI subtitles" (`/api/subtitles/generate`, poll).
3. **TV-show Back exits the app** — attempted fix `.toolbar(.hidden,for:.tabBar)`
   is UNCONFIRMED. If still broken, present detail via `fullScreenCover` +
   `.onExitCommand { dismiss }` instead of a NavigationStack push.
4. **Version picker** present (Menu when >1 file) but owner reported missing —
   confirm on a multi-version title.
5. **Verify .mkv playback** via the deployed HLS end-to-end on the Apple TV.
6. **Fix preview harness** (Library/Settings login flicker) + add remaining
   tabs/detail to the gallery.
7. Polish from on-device eyes: focus/spacing/colors, hero timing.
8. Not done: trailer playback (YouTube on tvOS — skipped by choice); Live TV is
   movie+episode but tune-in for episodes fetches the show to resolve the file.

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

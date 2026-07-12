# Apple TV app — handoff / continuation guide

Read this first, then `appletv/README.md` (owner-facing setup) and the
`apple-tv-app-decision` auto-memory. Everything is pushed to `origin/main`
(scenicprints/mediaserver, public repo, no secrets).

## TL;DR — where we are
Native **SwiftUI tvOS** app for the "Marquee" media server, delivered via
**TestFlight** (owner has **no Mac** → cloud macOS CI). Scaffold + CI are built
and pushed. **BLOCKED on Apple Developer Program approval** — owner enrolled as
Individual (~2026-07-12, $99/yr) and is waiting on the approval email. Nothing in
the pipeline can run until that lands.

## Why native (not a WebView wrapper like the TCL)
**tvOS has no WebView.** The Android TV app (`androidtv/`) just wraps the web UI;
that's impossible on tvOS, so this is a real native SwiftUI UI that reuses only
the server's HTTP API. The recurring **$99/yr is unavoidable** (TestFlight builds
expire ~90 days; the App Store won't approve a personal media-server app).

## What's built (in `appletv/`, at commit 4719c80+)
- `Sources/MediaServerApp.swift` — `@main`; `ContentView` shows `LoginView` until
  signed in, else a `TabView` (Movies / Settings).
- `Sources/Store.swift` — API client + auth. Default server
  `https://marqu33.duckdns.org`. `login/register/checkSession/logout/loadMovies`.
  Sends `Authorization: Bearer <token>` (server also accepts a cookie or `?token=`).
- `Sources/LoginView.swift` — username / password / invite-code form.
- `Sources/MoviesView.swift` — poster grid (`LazyVGrid` + `.buttonStyle(.card)` for
  native tvOS D-pad focus).
- `Sources/SettingsView.swift` — server URL + logout; `Color(hex:)` helper.
- `Resources/Info.plist`, `Resources/Assets.xcassets` — tvOS plist + layered
  **Brand Assets** icon (gradient placeholders — may need tweaks; see risks).
- `project.yml` — **XcodeGen** spec. Bundle id **`com.scenicprints.marqueetv`**,
  tvOS 17, automatic signing. (CI runs `xcodegen generate` to make the .xcodeproj.)
- `.github/workflows/appletv.yml` — macOS runner → xcodegen → `xcodebuild` archive
  (`-allowProvisioningUpdates` + ASC API key) → export (app-store) → upload to
  TestFlight (`xcrun altool`). **Manual trigger only** (`workflow_dispatch`) until
  the secrets exist, so it doesn't auto-fail.

First build is deliberately **minimal** (login → movie grid → settings) to prove
the pipeline. Full UI comes after it's landing on the device.

## NEXT STEPS (once Apple approves — owner does the browser steps; guide them)
1. developer.apple.com → Identifiers → register App ID `com.scenicprints.marqueetv`.
2. App Store Connect → Apps → **+** → new **tvOS** app, same bundle id, name "Marquee".
3. App Store Connect → Users and Access → **Integrations → App Store Connect API** →
   create key with **App Manager** role. Download `AuthKey_XXXX.p8` (**one-time**!).
   Note the **Key ID** and **Issuer ID**.
4. Membership page → note the 10-char **Team ID**.
5. GitHub repo → Settings → Secrets and variables → Actions → add:
   - `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`
   - `ASC_KEY_P8_BASE64` — base64 of the `.p8`. On Windows PowerShell:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\AuthKey_XXXX.p8"))`
6. Apple TV → install **TestFlight**, sign in with the same Apple ID.
7. Trigger CI: GitHub → Actions → "Apple TV app" → **Run workflow**. Watch it.

## KNOWN RISKS — expect a shakeout (Swift can't be compiled locally; no Mac)
Plan for **2–3 CI iterations** to get a green build. Most likely to break:
- **Signing** — `-allowProvisioningUpdates` + ASC API key for automatic signing is
  finicky in CI; may need to switch to **fastlane** (`match`/`sigh` + `pilot`).
  This is the #1 suspect.
- **tvOS asset catalog** — the layered Brand Assets icon (`Contents.json`/sizes) may
  need fixing if `xcodebuild` complains about a missing/invalid app icon.
- **Upload** — `altool` is deprecated; may need switching to `xcrun notarytool`/
  fastlane `pilot`.
- **Scheme** — confirm XcodeGen produces a shared scheme named `MarqueeTV`.

## After the pipeline is green
Build the real UI to match the web app: cinematic detail pages, **AVPlayer**
video player, Continue Watching, TV shows, Live TV, Collections, Requests — all
against the existing server API. Playback: AVPlayer can't set headers, so stream
via **`?token=`** on the URL (server supports it); transcode streams likely need
an **HLS** endpoint (consider adding one server-side + a client-aware `playInfo`).

## Project context the new chat needs
- Server: Node/Fastify/`node:sqlite` at `C:\Users\jkevi\mediaserver` (dev PC) +
  deployed on the **Dell** (auto-start via Task Scheduler, **Caddy** HTTPS, **PIA**
  split-tunnel). Public URL **`https://marqu33.duckdns.org`**.
- Auth: multi-user. Admin **`jkevinwagner` / `masterchief`**. Invite code
  **`lantern-6274`**. `/api/login` → token (Bearer / cookie / `?token=`).
- Working client: **TCL Google TV** (`androidtv/` WebView app, self-updating via the
  `marquee-tv-latest` GitHub release). Dead ends: LG UM6900 (webOS locked/OOM),
  VAVA 4K (2016 WebView). Apple TV is the current focus.
- Repo `scenicprints/mediaserver` (public). Push to `origin/main`; the Dell
  auto-updates on `run.bat`'s `git pull --ff-only`.
- **Coordinate:** only ONE session should edit the shared code at a time.

## Do NOT
- Never commit the `.p8` or any secret to the repo.
- Don't switch the workflow to a `push` trigger until the secrets are set and a
  build succeeds (it's manual-only for now on purpose).

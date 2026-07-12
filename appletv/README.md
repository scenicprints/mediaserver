# Marquee — Apple TV app (native SwiftUI → TestFlight)

A native tvOS app that talks to the media server's existing `/api` (login, movies,
player). tvOS has no WebView, so unlike the Android TV app this is a real native
UI. Built in the cloud (GitHub Actions macOS) and delivered via **TestFlight** —
no Mac needed. `bundle id: com.scenicprints.marqueetv`.

## Status
First build = **minimal, to prove the pipeline**: sign in → movie poster grid →
Settings (server URL + logout). Full UI (detail pages, AVPlayer, Live TV, etc.)
comes after the pipeline is green.

## Your one-time setup (all in a browser, after Apple approves your enrollment)
1. **developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →** register an
   **App ID** with bundle id `com.scenicprints.marqueetv`.
2. **App Store Connect → Apps → +** → new **tvOS** app, same bundle id, name "Marquee".
3. **App Store Connect → Users and Access → Integrations → App Store Connect API →** create a
   key with **App Manager** access. Download the **`AuthKey_XXXX.p8`** (one-time download!) and
   note the **Key ID** and **Issuer ID**.
4. **Membership** page → note your 10-char **Team ID**.
5. Add these as **GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `APPLE_TEAM_ID` — the Team ID
   - `ASC_KEY_ID` — the Key ID
   - `ASC_ISSUER_ID` — the Issuer ID
   - `ASC_KEY_P8_BASE64` — the `.p8` file base64-encoded (I'll give you the exact command)
6. On the **Apple TV**: install **TestFlight** (App Store), sign in with your Apple ID, and once
   the first build lands, tap **Install** for Marquee.

Then every push to `appletv/**` builds and ships a new TestFlight build automatically.

## Notes
- Signing/upload (the CI's last steps) almost always needs a **shakeout run or two** — that's
  normal for tvOS CI; we'll fix whatever the first run surfaces.
- The app icon is a gradient placeholder (real tvOS layered "Brand Assets") — easy to swap later.
- The app points at `https://marqu33.duckdns.org` (changeable in Settings). Playback (AVPlayer)
  and the rest of the UI are the next milestones.

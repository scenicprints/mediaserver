# Marquee — Android TV app

A full-screen **WebView** shell around the Marquee media server plus a **native
libVLC player** (`PlayerActivity`), for Android TV / Google TV **and plain
Android boxes** — the VAVA 4K projector (Android 7.1) included. It loads
`https://marqu33.duckdns.org/?tv=1` (TV mode: no fullscreen button, no cursor).
The existing web UI + focus engine do all the work, and the server's login
cookie means a **one-time sign-in**.

`minSdk 23`, and the manifest declares `LAUNCHER` beside `LEANBACK_LAUNCHER`
with `leanback required="false"`, so the icon appears on a non-TV launcher too.

## How you get it onto a device

Builds are release-signed and published to the rolling **`marquee-tv-latest`**
release as **per-ABI APKs**. Take `app-armeabi-v7a-release.apk` (~41 MB) unless
you have a reason not to: every arm64 Android device runs it too, while the
universal APK is 94 MB purely because it carries both libVLCs.

**Short links** (served by the media server, public on purpose, because typing a
GitHub release URL on a remote is miserable):

- `marqu33.duckdns.org/tv` → the armeabi-v7a build. **Use this one.**
- `marqu33.duckdns.org/tv/64` → the arm64 build, if a device wants its native one.

1. **Allow unknown sources.** Android TV / Google TV: **Settings → System → About
   →** click *Build* 7×, then **Developer options → Apps from unknown sources**.
   Android 7.1 boxes (VAVA): **Settings → Security → Unknown sources** — it's a
   single global toggle on that version, not per-app.
2. **Get the file on there**, whichever the device allows:
   - **USB stick + the device's file manager** — the one that always works, and
     the only route on a VAVA with no browser.
   - **`adb install app-armeabi-v7a-release.apk`** over USB or `adb connect
     <ip>:5555`, if the device exposes ADB. Best loop for iterating, since
     `adb logcat` then tells you why something failed.
   - **A downloader/browser app** on the device, pointed at `…/tv`.
3. **Open "Marquee"** → sign in once with the invite code → done.

After the first install the app **updates itself**: it reads `version.json` from
the same release, compares versionCode, and pulls the APK matching its own ABI —
so this sideload is a one-time cost per device.

## Notes / next iterations
- Release-signed with the committed `keystore/marquee.jks`, so every build can
  install over the last one. The in-app self-updater is live (see above).
- **Verify on the real remote:** D-pad navigation (arrows/Enter should drive the web
  focus engine), the **Back** button (mapped to the web app's Back), and video playback.
  If arrows don't navigate, we translate D-pad → arrow keydowns in `MainActivity`.
- The server URL is hardcoded in `MainActivity.kt` (`startUrl`). A settings screen to
  change it can come later.

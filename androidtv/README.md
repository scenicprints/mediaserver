# Marquee — Android TV app

A thin full-screen **WebView** shell around the Marquee media server, for your
friend's **TCL Google/Android TV**. It loads `https://marqu33.duckdns.org/?tv=1`
(TV mode: no fullscreen button, no cursor). The existing web UI + focus engine do
all the work, and the server's login cookie means a **one-time sign-in**.

## How you get it onto the TV

1. **Build it** — push this folder; the GitHub Action (`.github/workflows/androidtv.yml`)
   builds a debug APK and attaches it to the **`marquee-tv-latest`** release. Grab the
   `app-debug.apk` from there (Releases tab). (Or download the run's `marquee-tv-debug`
   artifact.)
2. **Let the TV install unknown apps** — on the TCL: **Settings → System → About →**
   click *Build* 7× to enable Developer options, then **Settings → System → Developer
   options → turn on "Apps from unknown sources"** (or grant it when prompted).
3. **Sideload the APK** — easiest is the **Downloader** app (from the Google Play Store
   on the TV): open it, type the URL of the `app-debug.apk` from the release, download,
   and install. (Alternatives: `adb install app-debug.apk`, or a USB drive + a file
   manager.)
4. **Open "Marquee"** from the TV home screen → sign in once with the invite code →
   done.

## Notes / next iterations
- **Debug-signed** for now (installs fine for personal sideloading). Release signing +
  an in-app self-updater (check `marquee-tv-latest`, download, install) come next so you
  can push updates without re-sideloading.
- **Verify on the real remote:** D-pad navigation (arrows/Enter should drive the web
  focus engine), the **Back** button (mapped to the web app's Back), and video playback.
  If arrows don't navigate, we translate D-pad → arrow keydowns in `MainActivity`.
- The server URL is hardcoded in `MainActivity.kt` (`startUrl`). A settings screen to
  change it can come later.

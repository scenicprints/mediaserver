# Marquee for Roku — parity checklist

**The rule: the Roku app looks and behaves exactly like the Android TV app.**
The Android TV app is a WebView of `public/` in TV mode (`?tv=1`, `body.tv-mode`)
plus a native libVLC player (`androidtv/.../PlayerActivity.kt`). So the reference
is `public/app.js` + `public/focus.js` + `public/telemetry.js` + `public/style.css`
(tv-mode rules, Braun finish) + `PlayerActivity.kt`. Nothing ships until every box
below is ticked AND checked on a real Roku.

**Scope cuts (owner, 2026-09-18):** no trailers, and no admin features at all (admin is
desktop only). The Roku app is the viewer's app. Anything admin-gated in the web app is
simply absent, even when an admin signs in on the Roku.

Every line here was read out of the source (2026-09-18, sha 79b4122). When the web
app changes, this file changes with it and the Roku app follows.

## Delivery (OTA)

- [ ] **Shell channel**: tiny sideloaded channel. At launch it loads the real app as
      a SceneGraph `ComponentLibrary` from `https://marqu33.duckdns.org/roku/marquee.zip`.
- [ ] Server serves `/roku/marquee.zip` built from `roku/lib/` (so a push + the Dell's
      Update = every Roku is on the new app next launch, no one touches the TV).
- [ ] Shell shows the MARQUEE loading splash while the library loads; if the server is
      unreachable, says so and retries (never a blank screen).
- [ ] Shell never needs updating for app changes. Version shown in Settings footer.
- [ ] **Shell self-update**: the app (loaded from the server, so itself OTA) checks
      `/roku/version.json`; if the server's shell `build_version` is newer than the running
      shell, it downloads `/roku/shell.zip` and installs it through the Roku's own developer
      installer (`http://127.0.0.1/plugin_install`, digest auth `rokudev` + the install-day
      password). **Unverified on a real Roku: install day includes a test update.**

## Look (tokens from style.css — Braun edition)

- [ ] Fonts bundled: Archivo 400/500/600, Roboto Mono 400/500 (`public/fonts/`).
- [ ] Finish **Black** (default on Roku; "Match the device" = Black, Roku has no system
      light/dark): bg #141416, bg-2 #232327, panel #1D1D20, panel-2 #232327, sunk #0E0E10,
      line #33333A, line-2 #28282E, text #EFEEE9, text-2 #8C8C86, muted #65655F,
      accent #F26A16, accent-deep #C85410, on-accent #141416, inverse #EFEEE9.
- [ ] Finish **White**: bg #E7E6E1, bg-2 #EFEEE9, panel #F8F7F4, panel-2 #EFEEE9,
      sunk #DEDCD5, line #CBC9C2, line-2 #DCDAD3, text #1A1B1D, text-2 #75756E,
      muted #A3A29B, accent #DE5F10, accent-deep #B84A08, on-accent #FFF, inverse #1A1B1D.
- [ ] Nothing rounded except circles (icon-btn, transport buttons, wtoggle, live dot).
- [ ] Nav bar: solid panel, 1px line under it, 68px tall + TV overscan inset (5.5vw sides,
      14px+4vh top). Brand "MARQUEE" ink, 600, letter-spacing .3em, 20px. Tabs uppercase
      13px/500, .16em tracking, text-2; active = text + 3px accent underline; focused =
      ink underline (accent if also active) + accent 16% wash.
- [ ] Tabs on TV: Home, Movies, TV Shows, Live TV, Library, Collections (Requests hidden
      from the ribbon on TV; lives in Settings ▸ Requests). Search field (underline style,
      150px, 170px focused). Settings gear (outlined circle). No update pill (admin).
- [ ] Buttons: square, 1px line, uppercase 13px/600, .16em, padding 14×24. Primary/Play =
      accent fill, on-accent ink; focused primary = accent-deep + ink border. Focused
      outline button = inverse fill. Segmented chosen cell = inverse fill.
- [ ] Chips/badges: square, 1px line, text-2, uppercase 12px/500, .1em.
- [ ] Row titles uppercase, .2em tracking, 600. Machine readouts (times, filenames) in
      Roboto Mono.
- [ ] Card focus: ink inset 3px frame on the poster + 6px accent bar 10px under the tile.
      No scale, no glow, no dimming.
- [ ] Hero: art plate left (16:9, 1px line), title/meta/overview/actions right; dial of
      ticks (2×11 muted, active 3×22 accent) under the actions. No scrim, no text on art.
- [ ] Detail: 21:9 art band framed by a hairline, content below it; 190px poster + info
      grid; meta as instrument panel (mono 17px cells split by hairlines).
- [ ] Player chrome is PlayerActivity's (always the dark palette): see Player below.

## Boot, auth, session

- [ ] Login screen: MARQUEE brand, "Sign in to continue", Username, Password, Sign in,
      "New here? Create an account" toggle → register mode (adds Invite code field,
      "Create your account", "Create account", "Have an account? Sign in").
- [ ] Errors: "Enter a username and password.", "Could not reach the server.", server error text.
- [ ] Token persisted on the Roku (registry); Bearer on API calls, `?token=` on media/art.
- [ ] Any 401 on /api (except login/register/auth/status) → back to login.
- [ ] Back on the login screen does nothing (nowhere to go).
- [ ] After login: offline probe (no-op on Roku, same as Android: helper absent → no
      Download buttons), loadAll (movies, shows, continue, collections, prefs), render
      Home. (No update check: that is admin.)
- [ ] Prefs are server-side (`/api/prefs`): `verid:*`, `pq`, `sd:*`.
      Per-DEVICE settings (finish, devtype, audioMode, dboost, night, norm)
      live on the Roku (registry), exactly as the web keeps them in localStorage.

## Focus engine (focus.js behaviour)

- [ ] First key press only reveals focus, landing on the active ribbon tab (main browse).
- [ ] Ribbon is its own zone: arrows never cross into it from content; Down leaves it.
- [ ] Up with nothing above in content → ribbon (active tab).
- [ ] Horizontal moves stay inside the row/grid/hscroll/season strip/actions/tabs; at a
      row end Right drops to the first item of the next row, Left rises to the last item
      of the row above.
- [ ] Vertical moves are row-aware: nearest row band, carousel rows entered at their
      START (first card), grids keep column alignment.
- [ ] "See all ›" sits one step LEFT of its row's first card, never a vertical stop.
- [ ] Focused item is scrolled to the vertical centre.
- [ ] Enter on a tab: opens the view and drops focus into its first target (Live TV:
      releases focus to the guide).
- [ ] Back: closes the top modal → closes the detail → leaves a See-all grid → lifts to
      the ribbon → on the ribbon does nothing.
- [ ] Opening a detail/modal pre-seats focus on its Play button, else first card, else
      first control.
- [ ] Text fields: OK opens the Roku keyboard; Up/Down leave the field.

## Home / Movies / TV Shows rows

- [ ] Hero: weekly-seeded pick of 6 with backdrops (never streaming-only titles), rotates
      every 9s. Home = movies+shows by rating; Movies/TV = that kind. Title, year chip,
      ★ rating chip, "N episodes" (show) or top quality chip (movie), 4-line overview,
      ▶ PLAY + ⓘ MORE INFO.
- [ ] Continue Watching first (tab-aware: movies on Movies, episodes on TV, all on Home),
      with progress bars and a ✓ "Mark watched" (dismiss) action.
- [ ] Pinned: up to 2 seasonal rows (full holiday calendar: New Year, Big Game, Valentine,
      Presidents, St Patrick, Easter, Earth Day, May the Fourth, Cinco de Mayo, Mother's,
      Memorial, Father's, Fourth of July, Back to School, Halloween, Not-So-Spooky,
      Veterans, Thanksgiving, Christmas; windows, nearest-wins, min counts, same regexes),
      then Recently Added.
- [ ] Rotating pool with TV quotas core 3 / mood 3 / discovery 2 / genre 3 / decade 1,
      topic claiming, a core row leads. Seed = (4-hour clock XOR random per launch) per view;
      stays fixed for the session. All candidate rows: Recommended, Recently Released,
      Top Rated, Critically Acclaimed, Fresh This Week, Favorites, Unwatched (Movies)/
      Unwatched, Watch Again, 4K (Movies), New Episodes, Finish What You Started,
      Movies + TV Shows (Home only); 18 mood rows; Hidden Gems, Short and Sweet, Settle In,
      From the Vault, Watched Lately, Roll the Dice, Because you watched X, The Year N,
      3 franchise rows; every genre; every decade. De-dupe by normalised name.
- [ ] 12 cards per row on TV; See all › opens the full grid with ‹ Back and a count.
- [ ] Card: poster (or title placeholder), badges (N new / NEW 14 days / top quality when
      >1 version / streaming provider colour badge / "▸ Also on X"), progress bar,
      focused shows title + ▶ + ✓ watched toggle (movies) + sub (year / N episodes).
- [ ] Card OK = open detail; card ▶ = play; streaming cards open the service.
- [ ] Search (ribbon field): live filter on titles, "Results for “q”" grid of movies+shows;
      empty query returns to the view.

## Library, Collections

- [ ] Library: Movies/TV Shows tabs, count, A–Z sections (articles ignored, # bucket),
      A–Z rail on the right that jumps to a letter.
- [ ] Collections: Movies/TV tabs; TV shows the "aren't grouped yet" message; grid of
      franchise cards (16:10 art, count badge, name without " Collection"); empty message.
- [ ] Collection detail: art band, poster, name, "N films in your library", Films grid.

## Movie detail

- [ ] Art band, poster, title, chips (year, ★, runtime h m, quality), genres, actions:
      ▶ RESUME + ↺ FROM BEGINNING (resume > 5s) or ▶ PLAY; ☆ Favorite/★ Favorited;
      Mark watched/✓ Watched (clears resume, redraws play buttons); provider buttons
      "Netflix ▸"; Version picker (>1 file, label = quality · size · tags) remembered via
      `verid:m<id>` + `pq`.
- [ ] Tagline, overview, filename (mono).
- [ ] Cast & Crew (directors first, circle-less square photos 118px, placeholders), franchise
      strip (owned ones open, others dimmed, "▸ in library"), More Like This. No Trailers & Extras section.
- [ ] Remote viewers get the smallest version under the cap by default (`/api/settings`
      remote + remoteCap), explicit choice always wins.

## Show + episode detail

- [ ] Show: art band, poster, title, year, ★, N episodes; ▶ PLAY (first unwatched);
      Mark show watched/✓ Show watched. Overview. Season cards with season posters
      (Specials = season 0), active = accent frame + label; per-season tool row
      ("Season N · M episodes" + Mark season watched). Episode rows: still, S·EE, title
      · qualities, 2-line overview, ○/✓ watched toggle, progress bar.
- [ ] Episode detail: still band, ‹ Show button, S·E title, air date, ★, runtime, quality,
      Resume/From beginning/Play, Mark watched, version picker, overview,
      Cast & Crew.
- [ ] Continue Watching ▶ on an episode opens the show and plays that episode.

## Player — what Android TV actually shows: the native PlayerActivity

On Android TV the web player never appears in normal use: `tryNativeHandoff` hands every
play to `PlayerActivity.kt`, and the web app only chains what happens after. So the Roku
player copies PlayerActivity (sizes in dp = CSS px, x2 on the Roku canvas) and the web's
native-handoff chain. The web player (caption delay, online subtitle search, in-player
version switch, soundtrack chooser, Up Next card, end card) is Android's FALLBACK only.

- [ ] Direct plays `/api/stream/...` (Roku Video node). If the Roku can't decode it, the
      fallback is the server's `/api/hls/...` path at the same position (Android: native
      failure -> web player, which asks the server to transcode). `/api/play?native=1`
      fetched for duration + intro and to log the play.
- [ ] Pre-roll (`/api/preroll/stream`) before a movie started from 0; locked (only Back,
      which exits everything); a broken pre-roll just starts the movie. The fallback
      path plays it too (on Android the fallback is the web player, which does).
- [ ] Resume seeks exactly once, after playback starts. Captions forced OFF ~800ms after
      start until the viewer picks one.
- [ ] Buffering overlay: dark wash rgba(14,14,22,.73), "MARQUEE" 34sp bold .35 tracking,
      "LOADING…" 12sp .22 tracking, text-2.
- [ ] HUD (hidden by default, 4s auto-hide): top band 34/22/34/30dp padding, black 70%->0
      gradient, title 18sp bold ink, subtitle 13sp text-2 (hidden if empty). Bottom band
      34/30/34/24dp, black 78%->0 gradient: 4dp scrub (track white 18%, fill signal), 10dp
      gap, row: play icon "❚❚"/"▶" 15sp bold (hidden on live), time "0:00 / 0:00" 13sp
      .06 tracking (live: "LIVE" signal .3 tracking), hint right-aligned 12sp .08 tracking
      text-3: "OK play/pause · ◀ ▶ ±10s · ▼ subtitles · Back exit" (live: "▼ subtitles · Back exit").
- [ ] Keys: OK = Skip Intro if showing, else Skip Credits if showing, else play/pause;
      ⏯ = play/pause; ◀/⏪ = -10s; ▶/⏩ = +10s; ▲ = show HUD; ▼ = subtitles menu;
      Back = hide HUD if showing, else save progress and exit. Live: no pause, no seek.
- [ ] Skip Intro pill "SKIP INTRO ▸  (OK)" / Skip Credits "SKIP CREDITS ▸  (OK)": bottom
      right 40dp/90dp, 20x11dp padding, bold 14sp .18 tracking, dark rgba(20,20,22,.82)
      fill, 1dp rule border. Intro window from `/api/play` intro range, one-shot.
      Credits: last 45s of an episode that has a next one -> ends now, chain continues.
- [ ] Subtitles menu: right panel 340dp wide, 30dp from the edge, vertically centred,
      rgba(29,29,32,.96) + 1dp rule. Header "Subtitles" 11sp bold .24 tracking text-3;
      rows 14sp text-2, selected row panel-2 fill + signal text, "✓ " prefix on the current
      one. Rows: "✨ Generate with AI…" (-> "✨ Generating… N% (phase)", "✨ Failed — try
      again"), "Off", every server track. Up/Down move, OK picks, Back closes.
- [ ] Chain (web `__marqueeNativeDone`): episode ended -> next episode plays (next
      episode's preferred version); movie ended -> back to its detail page, Continue
      Watching refreshed; failure -> fallback path from the same position. Live TV
      programme ended -> next programme on that channel.
- [ ] Progress POST every 10s + on pause + on exit (watched at >92% or natural end);
      never on Live TV. Heartbeat every 10s (sessionId, kind, fileId, title, subtitle,
      mode direct, position, duration, paused, live, stalls, tv, native, audioMode native),
      session end on exit. Rebuffer telemetry (>700ms, not seek refills), load/close/error.
- [ ] Remote viewers default to the smallest version under the cap; explicit version
      choice wins (`verid:*`, `pq`).

## Live TV

- [ ] Identical channel builder (32 defs, first 25 with ≥3 items, audience gate, seeded
      shuffles, LT_EPOCH 2024-01-01), wall-clock schedule, numbered from 1.
- [ ] Preview (≥54% of height on TV): channel number badge, NAME, ● LIVE, title, chips,
      overview, progress bar, "▶ N min in", "Up next 9:30 PM · Title", ▶ TUNE IN.
- [ ] Guide: GUIDE header + time bar (30-min labels, now line), five rows on screen, 168px
      channel cells, blocks sized by duration, live block highlighted, selected row wash
      + inset accent bar. Redraws every 30s.
- [ ] ▲▼ change channel (Up at channel 1 → ribbon), OK tunes in at the live offset.
- [ ] Programme end rolls onto the next programme on that channel.
- [ ] The ● live dots (GUIDE header, channel badge) pulse like `.lt-live-dot`: a ring
      growing 0→9px and fading .5→0 over the first 70% of 2s, CSS ease, forever.

## Requests (Settings ▸ Requests on TV)

- [ ] Status check; not set up / unreachable message with the ⚙ Open Settings button
      (app.js renders it for everyone, so the Roku does too; it opens Settings).
- [ ] "Connected to Radarr (movies) and Sonarr (TV)." Quality segment buttons per service.
- [ ] Search box (≥2 chars, 350ms debounce), results with poster, MOVIE/TV badge, year,
      2-line overview, ＋ Request / ✓ Already in library / Requesting… / ✓ Requested —
      searching / ✓ Already requested / ⚠ error. OK on the card requests.
- [ ] Live download queue every 8s: badge, title, bar, %, state · time left · quality.

## Streaming services

- [ ] Provider badges + colours (Netflix, Prime Video, Disney+, Hulu, Max, Apple TV+,
      Paramount+, Peacock). Opening one lands the service on that title, as Android does
      (it opens the service's search URL inside the service's own app): ECP
      `/search/browse?keyword=<title>&provider-id=<id>&launch=true`, falling back to
      `/launch/<id>`, then the same toast, "That app isn't installed on this TV".
      Telemetry `deeplink` with result `search:<id>` / `launch:<id>` / `none:…`.
      **VERIFY ON DEVICE: whether the search deep-link lands on the title.**

## Settings

- [ ] Account row: "Signed in as NAME", Log out.
- [ ] Tabs: General, Display, Audio, Streaming, Requests. (Streaming is shown to viewers
      in app.js; Now Playing and Diagnostics are admin-gated and absent.)
- [ ] Streaming: "Streaming services" block, the merge copy, a toggle per source
      (server-side prefs, same as the web).
- [ ] General: OpenSubtitles account (key/user/pass, Save subtitle account, Disconnect,
      status line; blank field = leave unchanged). Your password (current/new, Change
      password, "Password changed. Your other devices have been signed out.").
- [ ] Display: Finish — Match the device / White / Black (per device).
- [ ] Audio: device type (Detect/Apple TV/Android/Roku/VAVA/Browser + "Treating this as…"
      note), Audio output Stereo/Surround, Dialogue boost Off/Normal/Strong, Night mode,
      Loudness normalization — all per device, sent as play query params. Same copy text.
- [ ] TV player engine block (shown in the Android app because its native player exists):
      ⚡ Native (recommended) / 🌐 Classic, per device. Classic on Android is the web
      player; on the Roku it plays the server's HLS stream from the start.
- [ ] Footer: version text only (Check for updates is admin).

## Telemetry

- [ ] Stable device id, boot event (model, OS, resolution, app version), errors,
      failed/slow API calls, nav, player, buffer, deeplink, batched to `/api/telemetry`
      every 7s, requeue on failure, cap 300.
- [ ] `vitals` every 60s so the Roku shows up in Diagnostics' per-device smoothness,
      the way telemetry.js's rAF sampler does: a frame-length Timer counted for a
      second (fps, how many ticks came ≥50ms late, the worst gap), skipped while the
      player is up, dropped if the window overshoots 2.5s.

## Things Android has that do NOT appear (identical to Android)

- Offline downloads: the web app only shows them when a loopback helper exists. The
  Android app has none, so no Download buttons. Same on Roku.
- Fullscreen button, mouse hover states: hidden in TV mode on Android. Same on Roku.

## Build notes (what the port does that the page can't show)

- Side-by-side check (2026-09-19): every screen was driven with the same remote keys in
  the web app (TV mode, 960x540 at DPR 2, the MarqueeTV bridge stubbed, trailers hidden)
  and the Roku simulator, frames diffed, and focus compared step by step. Things it
  caught and fixed: sign-in card spacing/background/Sign-in focus, settings sheet
  sizing to content, the Streaming source chips (per-user, not admin), Audio/Requests
  spacing, the grid Back being a row-head, See all padding, Live TV art at 30%, the
  White-finish Live TV fade, --shadow-pop, the scrolled nav, the card title ink, and
  scroll kept across re-renders.

- Primary buttons are flat (`.btn.primary` has `border:none`, 41 tall, 43 when stretched
  in a flex row); `.btn-play` keeps its border (43). Focused: inverse fill, the signal
  glow ring, lifted 1px.
- Rows and Live TV channels are computed server-side by `src/roku.js`, a line-for-line
  port of app.js. `test/roku-parity.test.mjs` runs the real app.js code next to the
  port and fails if they ever disagree. Change one, change both.

## Simulator vs real Roku (brs-engine can't answer these; check on install day)

Known simulator artifacts (not app bugs; do not "fix" them in the app):
- A Poster partly scrolled out of its clipping rect is re-cropped from the visible part
  in the simulator, so a half-visible art band shows a different slice. A real Roku crops
  from the full node.
- With loadWidth/loadHeight set, the simulator stretches the decoded bitmap to that box
  before scaleToZoom, so a 16:9 still in a 2:3 poster box looks squeezed. A real Roku
  applies scaleToZoom while decoding. Check an episode page's poster on the device.
- The simulator interprets BrightScript in JavaScript: opening a detail takes ~1.5s after
  the data arrives. Check the real speed on the device.
- A Group's `scale` is not applied to its children; animate node fields directly.

- Fonts, images and the Http task load from the library's own `pkg:/` on a device; the
  simulator resolves `pkg:/` to the shell, so the harness copies them in. Confirm the
  library's assets load on the device (no missing text, no missing emoji).
- Video: direct play of the owner's real files, the HLS fallback, captions, audio tracks.
- The live-dot pulse timing (it runs in the simulator). The buffering overlay is static on
  Android (PlayerActivity just shows/hides it), so it is static here too.
- ECP launches of the streaming channels, and the shell self-update.

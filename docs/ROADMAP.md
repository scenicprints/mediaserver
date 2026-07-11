# Roadmap

Living task list for the media server. Keep this current — it's the single source of truth
for "what's next." See [../CLAUDE.md](../CLAUDE.md) for how the project works.

Status legend: ✅ done · 🔜 next · 📋 backlog · 💡 idea (not committed)

---

## ✅ Done
- Node/Fastify/`node:sqlite` server; vanilla web UI; dark theme.
- In-app **library manager**: browse the server's drives, add folders as **Movies** or
  **TV Shows**, remove them — no config editing.
- **Movies**: recursive scan, filename parsing (handles `(500) Days of Summer`, scene names),
  TMDB metadata (poster/overview/rating), HTTP-range streaming (seeking).
- **Movie versions**: multiple qualities of one film → one card + a quality picker (4K/1080p/…).
- **TV shows**: season/episode parsing (`S01E01`, `1x02`, Season folders), TMDB show +
  per-episode metadata (real titles, overviews, still thumbnails), season tabs + episode list.
- **Episode versions**: same episode in multiple qualities → one row + a quality picker.
- **Continue Watching** row (tab-aware: movies on Movies tab, episodes on TV tab).
- **Watched/unwatched** tracking + manual toggles; auto-play next episode (binge).
- **Subtitles**: local `.srt` sidecars served as WebVTT; **OpenSubtitles search + download**
  (in-app account settings).
- **Self-update**: push to GitHub → owner clicks "⟳ Update" in-app → server pulls & restarts,
  with a progress overlay. Auto-checks for updates.
- Deployed on the Dell; managed from the browser.
- **"MYFLIX" UI overhaul** (streaming-grade): cinematic dark identity with a gradient accent;
  fixed nav with Home/Movies/TV views; rotating **hero billboard**; horizontal **content rows**
  (Continue Watching, Recently Added, Top Rated, …); **hover-preview cards** with quick
  play/watched; **cinematic detail modal** (backdrop hero, meta chips, version picker,
  season/episode browser). `/api/movies` & `/api/shows` now expose backdrop/overview/added_at.
- **Custom theater video player**: full-screen takeover on Play (not a box over the splash);
  custom scrub/seek, skip ±10s, volume, playback speed, fullscreen, auto-hiding chrome,
  keyboard shortcuts, click-to-pause. In-player settings menu switches **subtitle source**,
  **version/quality**, and **subtitle delay/offset** (fixes audio↔subtitle lag) without
  leaving the movie. **Play from Beginning** vs **Resume**. **Up Next** card + auto-advance
  for episodes. (Best-effort audio-track list where the browser supports it.)
  **Skip Intro** button (heuristic: appears ~5–90s in, jumps ahead). Bug fixes: control-bar
  clicks (pointer-events) and Continue-Watching opening details vs auto-playing.
- **Browse-all grids** — Movies/TV views end with a Plex-style full wrapping grid of the whole
  library (with a count).
- **Season cards with artwork** — the show view uses TMDB season poster cards (via
  `/api/shows/:id/extra`) instead of number pills.
- **Library + endless categories + subtitle sources + version memory**: a real **Library**
  nav section (Movies/TV toggle + **A–Z letter rail**) replacing the top-right grid button;
  home/Movies/TV have a **fixed top‑4** (Continue Watching, Recently Added, Recently Released,
  Recommended) then **shuffled** genre/decade/rating/quality categories (near‑endless);
  the player **remembers the last version** you picked (localStorage `pq`); external `.srt`
  detection broadened (loose name match either direction, `Subs/`/`Subtitles/` subfolders,
  language labels, **multiple tracks** listed in the player, auto‑shows an existing track).
- **Categories galore + fixes**: genre + decade + rating/quality/watched categories (genres
  auto-**backfilled** from TMDB into movies/shows); a **▦ browse-all** nav button; **rich
  episode detail** (still, air date, rating, runtime, cast & crew via `/api/episodes/:id/extra`).
  Fixes: grid/search views no longer slide under the nav; player settings menu opens on the
  gear (SVG click) and CC/settings stay clickable with the menu open.
- **Player v2 + episode details + categories**: subtitle search now appears **above** the
  player; **custom subtitle renderer** (no freeze on version switch, clean delay/offset,
  styled captions); removed playback speed; SVG-icon player polish. **Episode details screen**
  (still/overview/version selector/Resume/From-beginning) before playing. **More home
  categories** (Recently Released, Unwatched, New Episodes…) and every row has **"See all" →
  full grid**.
- **Franchise / collection grouping** — movie detail shows a "… Collection" section (TMDB
  `belongs_to_collection` → `/collection/{id}`), entries in order, owned ones playable.
- **tvOS focus engine (10-ft / remote navigation)** — the whole web UI now drives like an
  Apple-TV interface. A new `public/focus.js` is a self-contained **spatial navigation engine**:
  arrow keys / a TV remote move a single **focused** item that **scales + glows** (white +
  accent ring, revealed hover-info) while the rest of the field **dims**; focus follows with
  `scrollIntoView` (cards center in their row). **Enter** activates (dispatches a real click,
  so every existing card/button keeps its behavior), **Backspace** is the Menu/Back button
  (closes the top modal / detail). Horizontal moves stay **in-row and wrap** at the ends (Right
  past the last card drops to the next row; Left before the first rises to the previous row);
  vertical moves cross rows preserving column. It's **scope-aware** — an open modal traps focus
  inside itself, then the detail view, then main browse — and **suspends** during the video
  player / update overlay (they own the keyboard). **Mouse and remote coexist**: any mouse
  movement drops out of remote mode so normal hover returns; the next arrow re-lights focus.
  New screens (detail, modals) **pre-seat** focus on their primary Play button. Decoupled from
  `app.js` (pure DOM + MutationObservers), so it needed no changes to existing view code.
  In remote mode the top menu also grows slightly to read as a proper 10-ft menu bar.
- **Live TV: 25 channels + an audience-aware lineup.** Replaced the "top-N genres + everything"
  channel builder (which put a kids show next to an adult one) with a curated, prioritized list
  of ~32 channel definitions, keeping the first **25** that have ≥3 titles. Each channel is one
  coherent filter (PRIME, ADRENALINE/Action, NIGHTMARE/Horror, FAMILY ROOM, decades, TOP SHELF…).
  A genre-based **audience tier** (family / general / mature) gates every channel: family-safe
  channels never include mature titles and mature channels never include family titles, so a
  **kids title and an adult title can never share a channel**. Mature channels are interleaved
  into the lineup (not dumped last) so every audience has a home. Verified with a synthetic
  library: exactly 25 channels, all mature channels + the family channel present, zero
  family/mature mixing.
- **Whisper progress that actually moves; Skip Intro/Credits via chapters.**
  - **Whisper "stuck at 0%" fixed.** The wait was mostly **audio extraction** (ffmpeg pulling a
    full movie's audio out before Whisper starts) shown as "transcribing 0%." Now extraction is
    its own phase with ffmpeg `-progress` streamed to a real bar ("Extracting audio… NN%"), then
    "Transcribing… NN%". Transcribe progress also falls back to segment timestamps vs. duration
    if whisper's `%` line is buffered.
  - **Skip Intro no longer shows on movies.** The old heuristic ran for everything; now the
    heuristic is **TV-episodes only** (movies have no intro). Added **ffprobe chapter detection**
    (`-show_chapters` → `/api/play` returns chapters): when a file has named chapters (common in
    `.mkv`), Skip Intro/**Skip Credits** are **precise** and work for anything — they appear only
    inside the Intro/Credits chapters, which correctly handles a **cold open before the intro**.
    Skip Credits jumps to the next episode (or the end).
- **Skip Intro via audio fingerprinting (real theme-song detection) + episode-duration probing.**
  New `src/introdetect.js`: at import, per **season**, fingerprint the first 8 min of each episode's
  audio with **Chromaprint `fpcalc`** (auto-installed to `tools/fpcalc/` on first run, ~2 MB) and
  find the **longest recurring segment across episodes** — the theme. Stores a precise
  `intro_start`/`intro_end` per episode (+ the episode's real **duration**, which fpcalc reports —
  this also fixes Live TV's episode lengths). Matching is by **content, not position**, so it
  handles **cold opens** (theme found wherever it sits) and per-season intro changes; the matcher
  aligns two fingerprints (bit-error ≤ 8/32), finds the longest run, and pads the end by 2 s.
  Background job on boot, guarded by `intro_checked` (runs once per episode; new episodes on
  rescan). `/api/play` returns `intro` for episodes; the player uses it for a **precise Skip Intro**
  (chapters still win when present, heuristic only if neither). Verified end-to-end on generated
  episodes sharing a theme at different cold-open offsets: detected within ~1–2 s, Skip Intro shows
  exactly over the theme and jumps to its end. Compute-heavy — first import of a big library churns
  in the background; **expect threshold tuning on the real library** (BIT_THRESH / MIN_INTRO_SEC).
- **Live TV airs real episodes (fixes "tune in → starts from the beginning").** Show channels used
  to treat each show as one generic 30-min block and play the "next unwatched episode from 0," so
  the guide and playback disagreed. Now channels air **individual episodes** with their real
  durations: a new `GET /api/livetv/episodes` (flat playable episodes + show art/genres) feeds the
  schedule, so `nowOn` picks the **exact episode + offset** and tuning drops you into that episode
  at the **live point** (not the start). Preview/guide show the show title + `SxEy · Episode`.
  Episodes without a stored duration fall back to ~30 min until they've been played once.
- **Ribbon-is-its-own-zone nav + live-only Live TV player.**
  - **The top ribbon is now reached with Back, not arrows.** Arrow keys stay in the content and
    never climb into the MARQUEE bar; **Back** lifts focus up to the ribbon (Left/Right across
    tabs, **Enter or Down** drops back into the content; Back on the ribbon = leave-app on tvOS,
    no-op on web). Live TV yields to the ribbon when it's focused. (`focus.js` zone logic in
    `pick`/`move`/`back`/`activate`.)
  - **Live TV player is a real broadcast** — no play/pause, no seek bar, no ±10s skip, no Skip
    Intro/Credits (you can't time-travel live). A **● LIVE** tag replaces the scrubber; volume,
    subtitles/CC, fullscreen and Back(=change channel) remain. Driven by a `live` flag on the
    player + a `.vp-live` class.
- **TV-remote batch: text-field nav, meta-collections, seasonal row.** (This is a 10-ft TV app
  first; browser second.)
  - **Text fields are remote-navigable** (no more being "locked in the search box" — remotes have
    no Tab). Search boxes + dropdowns joined the focus engine: a remote lands on a field, **Enter**
    starts typing (TV keyboard), **Up/Down exits** the field back to spatial nav (Left/Right still
    move the cursor). Requests no longer auto-focuses the field, and pre-seats remote focus on it.
    `window.tvSeat`/`tvNavActive` exposed from `focus.js`.
  - **Broad meta-collections**: the Collections tab now shows studio/franchise groupings —
    **Marvel Cinematic Universe, Star Wars, Pixar, Disney Animated Classics, Disney Live-Action,
    DreamWorks, DC Extended Universe** — not just tight TMDB collections. Driven by a new
    `companies` column (production-company ids, backfilled from TMDB; DCEU is a curated tmdbId
    list). Each needs 3+ owned. `/api/collections` returns meta first, then TMDB collections;
    `/api/collections/meta:<id>` for detail.
  - **Collections minimum raised to 3** (was 2) — 1–2 films isn't a collection.
  - **Seasonal home row**: a themed row (🎃 Halloween, 🎄 Holiday, ☀️ Summer Blockbusters,
    💘 Date Night, 🌸 Spring, 🍂 Fall, ❄️ New Year…) chosen by the current month, added as the last
    **permanent** row on Home/Movies/TV.
- **Feedback batch: watch-state + player + nav polish.**
  - **Live TV no longer touches Continue Watching.** Tuning a channel plays with no `progressUrl`,
    so ephemeral live viewing never writes watch-state (movies tune at the live offset; shows play
    their next episode). `save()` no-ops without a `progressUrl`.
  - **Bulk mark watched/unwatched** for TV: per-episode (existing), a **whole-season** toggle in a
    new toolbar above the episode list, and a **whole-show** button in the show header. New
    `POST /api/shows/:id/watched {watched, season?}` updates all matching episodes (clears resume).
  - **First-press autoplay fix.** Awaiting `/api/play` dropped the click's transient activation, so
    Chrome blocked sound-autoplay until a second press. Now `attemptPlay()` falls back to muted
    play (always allowed) then unmutes — it starts on the first press.
  - **Arrow-key up now scrolls.** `scroll-padding-top` (96px) lets `scrollIntoView` clear the fixed
    nav, so focusing an item above actually scrolls up (previously only down scrolled).
  - **Requests is remote-navigable.** Result cards are in the focus engine (`.req-card`, focus ring,
    Enter requests).
  - **3GP** added to the scanner + MIME. (All the listed formats — MKV/AVI/WMV/MPG/3GP video and
    AC3/E-AC3/DTS/TrueHD/MP2/WMA/Opus/FLAC audio — already play via the ffmpeg transcode path; only
    MP4/M4V/MOV/WebM direct-play in a browser.)
- **Whisper on the GPU + faster decoding; watched-button fix.**
  - **AI subtitles now run on the GPU.** Install auto-picks the whisper **cuBLAS** build when an
    NVIDIA driver is present (`nvcuda.dll`) — it bundles the CUDA runtime, so the Dell's 1050 Ti
    works with just the driver. Falls back to the CPU build if the GPU binary won't load
    (verified via a test-run). ⚙ Settings shows "running on the GPU ⚡ / CPU" and, when a GPU is
    detected but the CPU build is installed, a **⚡ Switch to GPU** button (`force` reinstall,
    wipes only the binary, keeps the model). Also switched decoding to **greedy** (`-bo 1 -bs 1`)
    and multi-thread (`-t`), a big speed-up on CPU too. This addresses "whisper takes too long."
  - **Watched-button fix.** Marking a movie/episode **watched** now immediately collapses
    "Resume / From beginning" to a single **Play** (watched clears the resume point), and marking
    it **unwatched** does not bring Resume back. The buttons re-render live instead of going stale;
    the server already zeroed `resume_position` on watched, so it persists on reopen.
- **Feedback pass: DirecTV-style guide, stricter Collections, Whisper as a background job + Spanish.**
  - **Live TV → proper EPG guide.** Replaced the sidebar list with a DirecTV-style grid: a
    now-playing **preview pane** on top, then a scrolling **guide** — channel column on the left,
    a **time axis** (30-min columns) across the top, **program blocks sized by duration**, the
    current show highlighted, and a red **now-line**. ▲▼ change channel, Enter/click a live block
    tunes in. Fixed the **nav overlap** (the guide now clears the fixed nav, measured dynamically
    since the nav can wrap to two rows).
  - **Collections are pickier.** Only franchises where you own **2+ films** show up (was ≥1, so
    single-movie "collections" cluttered it).
  - **Whisper is now a background job with a progress bar**, so a full movie no longer hangs the
    UI on a dead spinner — the request returns immediately, the player polls and shows
    "Transcribing… NN%", and you can close it and keep watching; the track appears when ready
    (whisper `-pp` progress parsed from its output). **Spanish (and any language) subtitles** work
    via a new `src/translate.js`: Whisper makes the English track, then cues are translated
    (LibreTranslate if `config.translateUrl` is set, else a zero-config Google fallback). Player
    menu now offers **Transcribe / English / Spanish**. Verified end-to-end: real job with live
    progress produced both "EN (AI)" and "ES (AI)" tracks (¡"(música lúgubre)"!).
    *Speed follow-up:* on the Dell, transcription is CPU-bound (slow for long films) — switching to
    the whisper cuBLAS build for the 1050 Ti via `whisperBinUrl` would make it much faster.
- **Collections tab + Live TV + AI subtitles (Whisper)** — three pipeline features in one batch:
  - **Collections tab** (nav, beside Library): owned movies grouped by TMDB franchise. A new
    background `backfillMovieDetails()` fetches each movie's details **once** (`col_checked`
    flag) to store `collection_id/name/poster` **and** runtime (one request, reused by Live TV).
    `GET /api/collections` + `/api/collections/:id`; Movies/TV toggle (TV shows a friendly
    empty state — TMDB rarely groups TV); grid of franchise cards → collection page of owned
    films, playable. Remote-navigable (`.coll-card` added to the focus engine).
  - **Live TV (channel surfing)**: a deterministic virtual broadcast built client-side from the
    library — every channel is a seeded looping playlist and "now playing" is computed from the
    **wall clock**, so every device tuned in sees the same thing on air. Channels: THE MAIN EVENT
    (movies), THE BINGE (series), genre stations (ADRENALINE/NEBULA/PRESTIGE…), a REWIND decade
    channel; movies + shows mixed. A cinematic "TV screen" (now-playing backdrop, ● LIVE,
    progress through the program, up-next time) + a channel **guide**; ▲▼ surf, Enter tunes in
    (a movie **drops in at the live offset** like catching a broadcast mid-way; a show plays its
    next episode). Live TV owns the arrows while active (focus engine steps aside via `lt-active`).
  - **AI subtitles (whisper.cpp)**: one-click install from ⚙ Settings (CPU build into `tools/`;
    the Dell's 1050 Ti can use the cuBLAS build via `whisperBinUrl` in config). In the player's
    subtitle menu, **✨ Generate with AI** → *Transcribe spoken audio* or *Translate to English*;
    ffmpeg extracts 16 kHz mono → whisper → WebVTT sidecar (`<file>.<lang>-ai.vtt`, cached), which
    the subtitle plumbing now serves (`.vtt` sidecars are first-class alongside `.srt`) and labels
    "EN (AI)"/"Auto (AI)". Verified end-to-end on real media (install → generate → served track).
    Note: translating *to non-English* targets (e.g. English→Spanish) still needs a separate
    translator step — whisper only translates to English; captured as a follow-up.
- **Server-side playback prefs + player v4 (visible remote focus, cleaner theater UI)** —
  fixes the owner's top complaints for real this time:
  - **Version & caption-delay memory moved server-side** (new `prefs` key-value table in
    SQLite + `GET/POST /api/prefs`). localStorage was per-browser, so choices made on the PC
    never followed to the TV — that's why "remember my version" kept failing. The client keeps
    an in-memory mirror, writes through on change, and **auto-migrates any old localStorage
    prefs to the server on first load**. Watch state was already server-side (DB).
  - **Visible focus in the player.** Arrow keys move a **glowing focus ring** across the
    scrub bar and buttons (same visual language as the library cards) so you can always see
    where you are. Bar = home position: ←/→ **seek with a time-bubble preview** (repeated
    presses accumulate, commit ~0.5 s after the last press), Enter = play/pause, ↓ drops to
    the buttons (←/→ move, Enter presses, ↑ returns). First press with hidden controls only
    reveals them. Gear+Enter opens the settings menu (which already had its own highlight).
    Mouse use hides the ring; the next key press brings it back.
  - **Cleaner theater UI**: removed the floating center button cluster (video click and the
    bottom bar are the controls; a calm **paused badge** appears when paused); taller
    scrub bar with a hover/drag time bubble; bigger round buttons (46 px, 10-ft friendly);
    stronger bottom gradient; skip-intro/up-next/menu raised above the taller bar.
- **Playback engine (FFmpeg) + player v3** — the player now plays **every file type**.
  New `src/ffmpeg.js`: **one-click FFmpeg install from ⚙ Settings** (downloads a static build
  into git-ignored `tools/`, extracts with Windows' bundled bsdtar, re-detects — no CLI, made
  for the Dell), ffprobe **probing** (cached), a **direct-vs-transcode decision**
  (`GET /api/play/:kind/:fileId`, also returns the real duration), and **live transcoding**
  (`GET /api/transcode/:kind/:fileId?start=s`) to fragmented MP4 — video/audio are **copied
  when already browser-compatible** (mkv h264+ac3 = cheap remux), re-encoded otherwise;
  **NVENC** used when *functionally* present (verified with a 1-frame test encode — merely
  being listed isn't enough, that burned us on a machine without the NVIDIA driver).
  Player upgrades: **virtual timeline** for transcode streams (seek restarts the stream at an
  offset; scrub/time/progress/Up-Next all run through `cur()`/`dur()`); **caption-delay popup
  stays open** for repeated ± presses (an outside-click handler counted re-rendered, detached
  buttons as "outside" — fixed) and the delay is **remembered per file+track** (`sd:` keys);
  **per-title version memory** (`verid:m<id>`/`verid:e<id>`, dropdowns reflect it); captions
  re-render on a 200 ms timer (not just `timeupdate`) with optional-hours timestamp parsing
  and multi-cue support; **CC with no tracks jumps straight to online search**; playback errors
  show a real in-player message (and point at Settings when FFmpeg is missing).
  **Remote-friendly player**: ←/→ seek ±10s, Enter/Space play-pause, ↑ opens the settings menu
  (↑/↓ move a highlighted option, Enter picks, ←/→ nudge caption delay, Back closes),
  Backspace = Back everywhere. Fix: `/api/check-update`'s **synchronous git fetch froze the
  event loop** (stuttered active streams every 30 min) — now async `execFile`.
  Also fixed: focused (scaled) cards **no longer clip** inside horizontal scrollers
  (`.dp-hscroll`/`.season-cards` got padding+negative-margin breathing room).
- **Full cinematic detail page** (movies + shows): full-page takeover with a big backdrop splash
  (distinct from the poster), genres, runtime, a discreet **version dropdown** showing file
  differences (quality · size · codec/source), **Cast & Crew** and **Trailers** and **More
  Like This** (TMDB, recommendations cross-referenced with the local library). New
  `/api/movies/:id/extra` via `tmdb.movieExtra()`.

---

## 🔜 Next (start here — priority order)
0. **Skip Intro via audio fingerprinting — DONE (see above).** Follow-ups: **tune the thresholds on
   the real library** via the Dell's Claude (check a few shows; adjust `BIT_THRESH`/`MIN_INTRO_SEC`
   in `src/introdetect.js` if intros are mis-bounded); consider a **manual re-run trigger** /
   progress indicator in Settings; and the **same technique on end-credits** for a precise Skip
   Credits. Note: the scanner leaves **stale file rows** when a file is deleted/replaced on disk
   (surfaced during testing) — a small cleanup worth doing (prune episode_files/movie_files whose
   path no longer exists on rescan).
0b. **Whisper "auto-generate subtitles for files that have none" (opt-in toggle).** Owner asked
    whether to pre-generate like intros — decided NO for the whole library (too expensive, rarely
    needed), but a targeted background job for files with **zero** existing subtitle tracks is
    worth a Settings toggle. Explicit translations stay on-demand.
0c. **Native Apple TV app: drop the fullscreen toggle** (TVs are always fullscreen) + other
    browser-isms (cursor hiding). Deferred to when the native client is built.
1. **tvOS look & feel — polish pass (the focus engine itself is DONE, see above).** The remote
   focus engine (arrow/Enter/Back nav, scale+glow, dim, wrap, scoped to modals/detail) shipped.
   Remaining refinements: verify it on the **real Apple TV / Fire TV remote** (their D-pads emit
   arrow keys, but confirm Enter/Back mappings); optionally push **larger 10-ft typography** more
   broadly (currently only the top menu grows in remote mode); let the remote **focus + type in
   the search box** (deliberately excluded for now so arrows keep navigating); consider a
   left/right **Skip Intro / Up Next** reachable by remote inside the player.
2. **Embedded subtitles inside media files** (owner asked; `.mkv` often has embedded subs).
   The ffmpeg pipeline **now exists** (`src/ffmpeg.js`) — use `probe()` to list subtitle
   streams and an ffmpeg `-map 0:s:N` extract-to-WebVTT endpoint; list them alongside sidecar
   tracks in the player.
3. **Audio‑track selection** — same story: pipeline exists; add an `audio=N` param to
   `/api/transcode` (`-map 0:a:N`) and list probe-detected audio tracks in the player menu.
4. **Skip Intro accuracy** — upgrade the heuristic with ffprobe chapter markers (probe() is
   available now) / per‑show manual ranges.
5. **Verify on the real Dell library (~1592 movies):** install the playback engine from
   ⚙ Settings (one click; NVENC should light up on the 1050 Ti), then real‑media playback
   (mkv transcode, seek, subtitle sync/offset with remembered delay, version memory, Up Next),
   genre backfill at scale, Library A–Z performance.

**Decision still open:** the native Apple TV *app* delivery — cloud‑build → TestFlight ($99/yr)
vs a Fire TV / Nvidia Shield box. (Separate from #1, which is the *web* UI feeling tvOS‑like.)

## 🎯 Owner's requested pipeline (queued 2026‑07‑10)
**Items 1–3 SHIPPED** (see "Collections tab + Live TV + AI subtitles" under Done). Remaining
follow-ups + the still-gated item 4:

- **AI subtitles speed — DONE** (GPU cuBLAS auto-select + greedy decoding). Possible next:
  a model picker (tiny/base/small) and a "generate ahead of time" batch for a whole show.
- **Live TV polish**: per-show episode-length durations in the schedule (currently a 30-min block
  per series airing), horizontal time-scroll in the guide, channel logos, and letting a tuned
  **show** drop into the live episode+offset (movies already drop in at the live offset).
  DONE this pass: DirecTV-style EPG grid, nav-overlap fix.
- **Collections**: a Home "Your Collections" row; group TV franchises where TMDB has them.
  DONE this pass: only surface franchises with 2+ owned films.

4. **Requests → Radarr/Sonarr — DONE (2026-07-11).** A **Requests** nav tab: type a movie/show,
   it searches Radarr (`movie/lookup`) + Sonarr (`series/lookup`) and one click **adds + triggers
   a search** so the downloader grabs it. `src/arr.js` talks to the v3 APIs (`X-Api-Key`), fetching
   each instance's quality profile / root folder / language profile so nothing's hardcoded. Connect
   in ⚙ Settings (Radarr/Sonarr URL + API key → saved in git-ignored `config.json`). Owned titles
   show "Already in library." **Verified end-to-end on the Dell against real Radarr 6.2.1.10461 +
   Sonarr 4.0.18.2978 (2026-07-11):** status connected, search returns movies+shows with in-library
   flags, adds land in both apps monitored with a search triggered (movie picked HD-1080p profile;
   Sonarr v4 language-profile handling clean). No API-compat issues.
   **Follow-ons shipped:** a live **"Downloading now" queue** in the Requests tab (polls
   Radarr/Sonarr `/queue` every 8s — title, progress bar, state/ETA/quality, error rows first)
   and a **quality-profile picker** (per-service Movie/Show selects; the chosen `qualityProfileId`
   is passed through to the add; defaults to 1080p). Verified against the mock.
   Possible next: a "my requests" history list; per-item cancel/remove from the queue.

<details><summary>Original detailed notes for items 1–3 (kept for reference)</summary>

1. **Auto‑generated / translated subtitles (Whisper).** When no subtitles exist for a title —
   or the owner wants a language we don't have (e.g. an English movie, but they need **Spanish**
   subs) — **generate them locally**. Pipeline: ffmpeg (already installed via `src/ffmpeg.js`)
   extracts/decodes audio → a **Whisper** model transcribes to timed cues → optional
   **translation** to the target language → serve as WebVTT through the existing subtitle plumbing.
   - Likely **whisper.cpp** (a small static binary + a downloadable model, installed the same
     one‑click way as ffmpeg into `tools/`; no Python). GPU (1050 Ti) can accelerate.
   - Whisper can transcribe **and translate to English** natively; for **other target languages**
     (Spanish, etc.) pair transcription with a translation step (research: whisper translate is
     English‑only, so non‑English targets need a separate translator — argos‑translate offline,
     or a translate API). Decide offline‑only vs API.
   - UX: in the player's subtitle menu add **"Generate subtitles…"** with a language picker; show
     progress (it's slow — background job, cache the result as a sidecar `.vtt` next to the file
     or in `data/`). Reuse the server‑side prefs/caching patterns. Persist generated tracks so
     it's a one‑time cost per file+language.

2. **Collections tab (next to Library).** We already pull TMDB collections (movie detail shows a
   "… Collection" section via `belongs_to_collection`). Promote this to a **top‑level nav tab**
   beside Library: a **Movies / TV toggle**, then a grid of **collection cards** (franchise
   poster + count of owned entries); opening one lists its entries in order, owned ones playable
   (same treatment as the detail‑page collection row). Needs `collection_id` stored at enrich
   time so we can group owned titles without a live TMDB call per render (see the existing
   "Franchise home row" backlog note — same prerequisite). TV "collections" ≈ franchises where
   TMDB has them; otherwise the toggle can group by show for now.

3. **Live TV mode (channel surfing).** A mode that organizes the library into **channels named
   like real TV stations** and makes it feel like **surfing broadcast TV**. Movies and TV shows
   are **mixed** on a channel. Think: each "channel" has a running **schedule/now‑playing** so
   tuning in drops you into something already "in progress," and ↑/↓ (or channel buttons) surf
   between channels while ←/→ do something channel‑appropriate. Build a **virtual schedule**
   (deterministic from a seed + wall clock so every device tuned to a channel sees the same thing),
   group content into themed channels (by genre/decade/franchise → e.g. "Action Blvd", "90s
   Nights", a Marvel channel), and a **guide/EPG** view. Remote‑first, leans on the tvOS focus
   work. This is the biggest of the four — its own multi‑batch effort.

4. **Requests window → Sonarr/Radarr.** A place to **request** movies/shows not in the library,
   eventually wired to **Radarr (movies)** and **Sonarr (TV)** to auto‑fetch. **DO NOT BUILD YET
   — the owner will greenlight this explicitly.** (When greenlit: a Requests view + a `requests`
   table; integrate Radarr/Sonarr APIs with server‑side API keys in `config.json`, never
   committed. Until then, leave this untouched.)

</details>

## 📋 Backlog (owner-requested — fill in)
> The owner said there's "a massive amount of things to get done." List them here with
> enough detail for a cold agent to act. Template:
>
> - **<feature>** — what it should do, why, any specifics / acceptance criteria.

- **Skip Intro — accuracy upgrade** — the heuristic Skip Intro button is done. Upgrade with
  real skip points: **ffprobe chapter markers** (many `.mkv`s tag "Intro"/"Credits") and/or
  **per-show manual intro/outro ranges** the owner sets once.

- **Audio track selection** — pick among multiple embedded audio tracks. Browser `<video>`
  can't reliably switch embedded audio tracks, so this needs **ffprobe** (detect tracks) +
  **ffmpeg** to remux/transcode the chosen track server-side. Bigger infra (same ffmpeg work
  as transcoding). Player exposes `audioTracks` as a best-effort stopgap where the browser
  supports it.
- **Franchise home row (refinement)** — the movie detail already shows a Collection section;
  a follow-up is a Home "Your Collections" row grouping *owned* movies by franchise (needs
  collection_id stored at enrich time).
- **Sort / filter options** on the browse-all grids (by year, rating, recently added, unwatched).

## 🧭 Major milestone: Apple TV app (decision pending)
Owner wants a native Apple TV client but has no Mac. Options:
- **Cloud-build → TestFlight** (Codemagic/GitHub Actions macOS runners → TestFlight → install
  on the Apple TV). Needs **$99/yr** Apple Developer. True native app, no Mac at home; slow
  build/iteration.
- **Pivot to Fire TV / Nvidia Shield** — sideload a custom app or load a web app; no Apple fee,
  fast iteration.
Not started. Needs the owner's call on the path.

**Formats the client must support (owner's list):** video MKV, MP4, AVI, M4V, WMV, MPG, 3GP;
audio AAC, E-AC3 (DD+), AC3 (DD), MP3, DTS, Opus, TrueHD, MP2, WMAv2, WMApro, FLAC. On the **web**
player these already work via the ffmpeg transcode path (only MP4/M4V/MOV/WebM direct-play).
A native **Apple TV** app (AVPlayer) direct-plays more (HEVC, AC3/E-AC3 passthrough) but not all
(DTS/TrueHD/WMA/AVI/WMV) — so the native client will need the **same server-side transcode
fallback**, with a client-specific direct-play capability list to avoid transcoding what AVPlayer
can already handle. Keep `src/ffmpeg.js`'s `playInfo()` decision per-client when that lands.

## 💡 Ideas (not yet requested — for discussion)
- Sort/filter (year, rating, recently added, unwatched) and a "Recently Added" row.
- Global search across movies + TV at once.
- Hardware transcoding via the 1050 Ti's NVENC for codecs a browser/client can't play,
  and for lower-bandwidth streams.
- Remote access outside the home (e.g. Tailscale) — private, no port-forwarding.
- Auto-start on boot pointed at `run.bat` (so updates keep working after reboots).
- Music and/or photo libraries.
- Multiple users / simple profiles.
- Better fuzzy matching + a manual "fix match" UI for titles TMDB gets wrong.

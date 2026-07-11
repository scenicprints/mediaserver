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

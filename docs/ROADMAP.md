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
- **Full cinematic detail page** (movies + shows): full-page takeover with a big backdrop splash
  (distinct from the poster), genres, runtime, a discreet **version dropdown** showing file
  differences (quality · size · codec/source), **Cast & Crew** and **Trailers** and **More
  Like This** (TMDB, recommendations cross-referenced with the local library). New
  `/api/movies/:id/extra` via `tmdb.movieExtra()`.

---

## 🔜 Next
- Handoff docs + the MYFLIX UI overhaul are done. **Owner has a large backlog still to
  enumerate — capture each item in the Backlog below as it comes in.**

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

# CLAUDE.md — Personal Media Server (handoff)

> **Read this first.** It's the handoff for any agent picking up this project: what it
> is, how it's built, how to run/test/deploy, the conventions, and where things stand.
> The living task list is in [docs/ROADMAP.md](docs/ROADMAP.md).

## What this is
A custom, self-hosted media server — "a better Plex, built for one person" — for movies
and TV. It runs on the owner's home server and streams to any browser on the home
network. Goals: **snappy, private, fully owned, no accounts or upsells.**
Owner: **scenicprints** (jkevinwagner@gmail.com).

## Physical setup
- **Dev machine**: a Windows 11 PC where code is written and tested against sample data.
- **Server**: an old **Dell**, Windows 10, Ryzen 7 2700 (8c/16t), 16 GB RAM, GTX 1050 Ti
  (has NVENC). Runs 24/7. Media lives on hard drives attached to it (e.g. `H:\Movies`).
  LAN address `http://192.168.1.103:8096`.
- **Repo**: https://github.com/scenicprints/mediaserver — **public, contains NO secrets.**
- The owner runs/manages everything from a browser; they declined SSH / remote desktop.

## Stack
- **Node.js 24 LTS** + **Fastify 5**.
- **`node:sqlite`** (built-in `DatabaseSync`, synchronous) — chosen deliberately to avoid
  native-module compilation on Windows. No `better-sqlite3`.
- **TMDB** for movie/TV metadata; **OpenSubtitles** for subtitle search.
- Frontend: **vanilla HTML/CSS/JS** — no framework, no build step, no front-end deps.
  Edit `public/*` and refresh. Dark theme via CSS variables.
- Only production deps: `fastify`, `@fastify/static`. Everything else is stdlib
  (global `fetch`, `node:sqlite`, `fs`, `child_process`). Keep it that way if you can.

## Run it (dev, on Windows)
```
node C:\Users\jkevi\mediaserver\src\server.js
```
- Binds `::` (dual-stack) on port **8096** → `http://localhost:8096`, `127.0.0.1:8096`, or LAN IP.
- On boot: seed libraries from config (first run only) → scan all libraries → enrich
  metadata in the background → listen.
- No build/watch. Edit `public/*` → refresh. Edit `src/*` → restart node.
- **Gotcha:** a freshly spawned shell may lack `node` on PATH — refresh from Machine+User
  env, or use the full path `C:\Program Files\nodejs\node.exe`.

## File map
| File | Role |
|---|---|
| `src/server.js` | Fastify app: all API routes, streaming, boot sequence, self-update |
| `src/db.js` | `node:sqlite` schema + migrations |
| `src/scan.js` | Recursive scanner: movie libs → movies+files; tv libs → shows+episodes+files |
| `src/parse.js` | Filename parsing: `parseMovie`, `parseEpisode`, `detectQuality`, `scrubTitle`, group keys |
| `src/tmdb.js` | TMDB: `enrichLibrary` (movies), `enrichShows`, `enrichEpisodes` |
| `src/opensubtitles.js` | OpenSubtitles: `searchSubtitles`, `downloadSubtitle`, login/token |
| `src/ffmpeg.js` | Playback engine: FFmpeg detect + one-click install (→ `tools/`, git-ignored), ffprobe probing, direct-vs-transcode decision, live fMP4 transcode |
| `src/whisper.js` | AI subtitles: whisper.cpp detect + one-click install (→ `tools/whisper/`), ffmpeg audio extract → transcribe/translate → WebVTT sidecar |
| `src/arr.js` | Requests: Radarr (movies) + Sonarr (TV) v3 API — search/lookup, add + trigger search, fetch quality profile/root folder |
| `src/translate.js` | Subtitle translation (LibreTranslate if `config.translateUrl`, else Google) for non-English AI subs |
| `src/fsbrowse.js` | Server-side folder browser for the in-app picker |
| `src/scan-cli.js`, `src/enrich-cli.js` | Standalone CLI helpers (`npm run scan` / `enrich`) |
| `public/index.html` | UI markup (grids, modals, player, overlays) |
| `public/app.js` | All front-end logic (plain DOM, no framework) |
| `public/style.css` | Styles (dark theme, CSS variables) |
| `deploy/run.bat` | **The Dell runner**: `git pull` + `node`, restarts on exit code 42 (self-update) |
| `deploy/setup-dell.ps1` | One-time Dell setup (Node, deps, firewall) |
| `deploy/install-autostart.ps1` | Optional: launch at login via Task Scheduler |
| `config.json` | **git-ignored** local config (port, mediaRoots, keys, creds) |
| `config.example.json` | Template for `config.json` |
| `data/` | **git-ignored** SQLite database |

## Data model
- **libraries** — folders the owner added; each `type` = `movie` or `tv`.
- **movies** (logical: title/year/metadata/watch-state) + **movie_files** (one row per
  physical file/quality). Grouped by normalized title+year, so multiple qualities of one
  film collapse into one movie with a version picker.
- **shows** → **episodes** (logical: one per show+season+episode) → **episode_files**
  (one per physical file/quality).
- **Watch state** (`resume_position`, `watched`, `last_played_at`) lives on the *logical*
  movie/episode and is shared across its file versions.
- **Quality** (`4K`/`1080p`/`720p`/`SD`) is detected from filenames, stored per file.

## API reference (all under `/api`)
- **Movies:** `GET /movies`, `GET /movies/:id` (incl. `files[]`), `POST /movies/:id/progress`, `/favorite`, `/watched`
- **TV:** `GET /shows`, `GET /shows/:id` (seasons→episodes→files), `POST /episodes/:id/progress`, `/watched`
- **Home:** `GET /continue` (in-progress movies + episodes)
- **Streaming (HTTP Range / seeking):** `GET /stream/:fileId`, `GET /stream/episode/:fileId`
- **Subtitles:** `GET /subtitle/:fileId` & `/subtitle/episode/:fileId` (serves a sidecar `.srt` as WebVTT); `GET /subtitles/search`, `POST /subtitles/download` (OpenSubtitles)
- **Libraries/setup:** `GET/POST/DELETE /libraries`, `GET /fs` (folder browser), `POST /scan`, `POST /enrich`
- **Settings:** `GET /settings`, `POST /settings/opensubtitles`
- **Prefs (cross-device playback memory):** `GET /prefs` (all), `POST /prefs` `{key, value}`
  (null/empty value deletes). Keys: `verid:m<id>`/`verid:e<id>` preferred file per title,
  `sd:<fileId>:<trackIdx>` caption delay, `pq` last quality. **Never store these in
  localStorage — it's per-browser and the owner watches from multiple devices.**
- **Self-update:** `GET /version`, `GET /check-update`, `POST /update` (exits 42 → `run.bat` pulls & restarts)
- **Collections:** `GET /collections` (owned movies grouped by TMDB franchise), `GET /collections/:id`
- **Playback engine:** `GET /play/:kind/:fileId` (direct vs transcode + duration), `GET /transcode/:kind/:fileId?start=`, `GET/POST /ffmpeg[/install]`
- **AI subtitles:** `GET/POST /whisper[/install]`, `POST /subtitles/generate` `{kind,fileId,language,translate}`
- **Requests (Radarr/Sonarr):** `GET /requests/status`, `GET /requests/search?q=`, `POST /requests/add` `{type,tmdbId|tvdbId}`, `POST /settings/arr` `{radarr,sonarr:{url,apiKey}}`. Keys → git-ignored `config.json` (`config.radarr`/`config.sonarr`). **Never commit config.json.**

## Deploy & update workflow — IMPORTANT
The Dell auto-updates from GitHub:
1. Develop on the Windows PC, commit, **push to `origin/main`**.
2. The Dell checks GitHub (on load + every 30 min) and shows a **⟳ Update available** pill.
3. The owner clicks it → the server `git pull`s and restarts itself
   (`run.bat` loops; `POST /api/update` does `process.exit(42)`; `run.bat` sees 42 and re-runs).

- **Never ship zip files.** Push to GitHub; the owner updates in-app.
- The Dell's `C:\mediaserver` is a git checkout tracking `origin/main`, started via
  `deploy/run.bat`.
- **Secrets** (TMDB key, OpenSubtitles account) live only in the Dell's git-ignored
  `config.json`, entered via **⚙ Folders → Subtitle search** in the UI.
  **Never put secrets in code and never commit `config.json`.**

## Schema changes / migrations
When changing the DB shape, add a migration in `src/db.js`. The pattern used so far:
detect the old schema (e.g. a column that no longer exists), `DROP` the affected tables,
and let a rescan rebuild them — **the files on disk are the source of truth**, and the
`libraries` table is preserved so the owner never has to re-add folders. Losing watch-state
on a migration is acceptable (it's minimal). This runs automatically on the next boot after
an update.

## Conventions
- ESM (`"type": "module"`).
- Synchronous DB via `node:sqlite` (`db.prepare(...).run/get/all`).
- Vanilla front-end — no framework, no bundler. Keep it that way unless there's a strong reason.
- Match the surrounding code style and comment density.
- Config is read with a BOM guard (PowerShell can prepend a UTF-8 BOM that breaks `JSON.parse`).
- End commit messages with `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Testing
- Restart node, hit the API. **PowerShell 5.1 quirks:** use `-UseBasicParsing`; it can't set
  the `Range` header (use `curl.exe -r 0-4 <url>` to test range streaming).
- Sample data: `sample-media/` (movies, incl. tricky `(500) Days of Summer` and scene-named
  files) and `sample-tv/` (Breaking Bad / The Office). These are placeholder files — they
  don't actually play, but they exercise scanning/metadata/UI.
- **Real playable test media** (dev machine): `C:\Users\jkevi\mediaserver-testmedia\` —
  ffmpeg-generated `Transcode Test (2020) 1080p.mkv` (HEVC+AC3 → exercises the transcode
  path; has a matching `.srt`) and `Direct Test (2021) 720p.mp4` (H264+AAC → direct play).
  Added as a movie library in the dev DB. Regenerate with ffmpeg's `testsrc2`/`sine` if lost.
- Browser checks via the preview tools: **screenshots hang on remote TMDB poster images —
  use `preview_snapshot` / `preview_eval` to read the DOM instead.**
- Simulate progress by POSTing to `/progress`; simulate an episode ending with
  `player.dispatchEvent(new Event('ended'))`.

## Owner's working style (important)
- **Big, batched updates only.** Accumulate several features/fixes, then push once. Do not
  push — or tell them to update — after every small change.
- Not a CLI expert: when they must run commands on the Dell, give **one command at a time**
  and confirm each before the next.
- They manage the server entirely from the browser.

## Apple TV (a major future item — not started)
The owner wants a native Apple TV app but has **no Mac**. A Mac is only needed to
*compile/sign* a tvOS app → use a **cloud macOS CI (Codemagic / GitHub Actions)** →
**TestFlight** → install on the Apple TV (no Mac at home). Cost: **$99/yr** Apple Developer
(recurring). Open alternative: switch the TV box to **Fire TV / Nvidia Shield** to skip the
fee and slow cloud builds. Decision not yet made.

## Current status (2026-07-10, sha 2b6af0e)
Built & verified: in-app library manager (folder picker, movie/TV), movie scanning + TMDB
metadata, movie versions/quality picker, HTTP-range streaming, TV shows (season/episode
parsing, TMDB show + episode metadata incl. titles/thumbnails), episode versions/quality
picker, Continue Watching (tab-aware), watched/unwatched tracking, auto-play next episode,
local `.srt` subtitles + OpenSubtitles search/download, self-update via GitHub with an
in-app progress overlay, and in-app OpenSubtitles settings.

**Next up / backlog: [docs/ROADMAP.md](docs/ROADMAP.md).** The owner has a large list of
remaining work — keep that file current as the single source of truth for what's next.

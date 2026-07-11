import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.js';
import { scanLibraries, seedLibraries } from './scan.js';
import { enrichLibrary, enrichShows, enrichEpisodes, movieExtra, showExtra, backfillGenres, episodeExtra, backfillMovieDetails } from './tmdb.js';
import { ext, qualityRank } from './parse.js';
import { listDrives, listDirs } from './fsbrowse.js';
import { osEnabled, searchSubtitles, downloadSubtitle, clearAuth } from './opensubtitles.js';
import { detectFfmpeg, status as ffmpegStatus, installFfmpeg, playInfo, transcodeStream, ffmpegBin } from './ffmpeg.js';
import { detectWhisper, status as whisperStatus, installWhisper, generate as generateSubs } from './whisper.js';
import { translateVttFile } from './translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Strip a leading UTF-8 BOM if present — some editors/PowerShell add one, and
// JSON.parse rejects it.
const CONFIG_PATH = path.join(ROOT, 'config.json');
const configText = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '');
const config = JSON.parse(configText);
// Resolve relative media roots against the project folder (not the CWD the
// process happens to be launched from). Absolute paths like H:\Movies pass
// through untouched.
const mediaRoots = (config.mediaRoots || []).map((r) => path.resolve(ROOT, r));
const db = openDb(path.resolve(ROOT, config.dbPath));

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.flv': 'video/x-flv'
};

const app = Fastify({ logger: false });

// Accept POSTs with an empty or unusual content-type (e.g. action buttons that
// send no body) without a 415. JSON bodies still use the built-in parser.
app.addContentTypeParser('*', (req, payload, done) => done(null, undefined));

// Serve the web UI from /public
app.register(fastifyStatic, {
  root: path.join(ROOT, 'public'),
  prefix: '/'
});

// ---- API ----

app.get('/api/movies', async () => {
  return db.prepare(
    `SELECT m.id, m.title, m.year, m.poster, m.backdrop, m.overview, m.rating, m.genres,
            m.watched, m.favorite, m.resume_position, m.duration, m.runtime, m.added_at,
            COUNT(f.id) AS versions,
            GROUP_CONCAT(DISTINCT f.quality) AS qualities
     FROM movies m
     LEFT JOIN movie_files f ON f.movie_id = m.id
     GROUP BY m.id
     ORDER BY m.title COLLATE NOCASE`
  ).all();
});

// Collections tab: owned movies grouped by TMDB franchise/collection. Each
// entry has the collection art (falls back to a member poster) and how many of
// its films are in the library.
app.get('/api/collections', async () => {
  const rows = db.prepare(
    `SELECT collection_id AS id, collection_name AS name,
            COUNT(*) AS count,
            MAX(collection_poster) AS poster,
            MAX(backdrop) AS backdrop,
            MIN(poster) AS memberPoster
     FROM movies
     WHERE collection_id IS NOT NULL
     GROUP BY collection_id, collection_name
     HAVING count >= 2
     ORDER BY name COLLATE NOCASE`
  ).all();
  return rows.map((r) => ({ id: r.id, name: r.name, count: r.count, poster: r.poster || r.memberPoster, backdrop: r.backdrop }));
});

// One collection's owned entries, in release order (playable).
app.get('/api/collections/:id', async (req) => {
  const meta = db.prepare('SELECT collection_name AS name, MAX(collection_poster) AS poster, MAX(backdrop) AS backdrop FROM movies WHERE collection_id = ?').get(req.params.id);
  const items = db.prepare(
    `SELECT id, title, year, poster, backdrop, overview, rating, watched, resume_position, duration, runtime
     FROM movies WHERE collection_id = ? ORDER BY year, title COLLATE NOCASE`
  ).all(req.params.id);
  return { name: meta && meta.name, poster: meta && meta.poster, backdrop: meta && meta.backdrop, items };
});

// Rich TMDB detail (genres, cast, director, trailer, recommendations). Owned
// recommendations get a localId so the UI can make them playable.
app.get('/api/movies/:id/extra', async (req, reply) => {
  const m = db.prepare('SELECT tmdb_id FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return reply.code(404).send({ error: 'not found' });
  const extra = await movieExtra(config.tmdbApiKey, m.tmdb_id);
  if (!extra) return { genres: [], runtime: null, cast: [], directors: [], trailer: null, recommendations: [] };
  const owned = db.prepare('SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL').all();
  const byTmdb = new Map(owned.map((o) => [o.tmdb_id, o.id]));
  for (const r of extra.recommendations) r.localId = byTmdb.get(r.tmdb_id) || null;
  if (extra.collection) for (const p of extra.collection.parts) p.localId = byTmdb.get(p.tmdb_id) || null;
  return extra;
});

app.get('/api/movies/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const files = db.prepare(
    'SELECT id, quality, filename, size, path FROM movie_files WHERE movie_id = ?'
  ).all(req.params.id);
  // Highest quality first, so it's the default version to play.
  files.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  for (const f of files) { f.subtitles = listSubtitles(f.path).map((s, i) => ({ label: s.label, idx: i })); delete f.path; }
  row.files = files;
  return row;
});

// Save playback position (continue-watching) and watched state.
app.post('/api/movies/:id/progress', async (req, reply) => {
  const { position, duration, watched } = req.body || {};
  const row = db.prepare('SELECT id FROM movies WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  db.prepare(
    `UPDATE movies SET resume_position = ?, duration = COALESCE(?, duration),
     watched = COALESCE(?, watched), last_played_at = ? WHERE id = ?`
  ).run(position ?? 0, duration ?? null, watched ?? null, Date.now(), req.params.id);
  return { ok: true };
});

app.post('/api/movies/:id/favorite', async (req, reply) => {
  const row = db.prepare('SELECT favorite FROM movies WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const next = row.favorite ? 0 : 1;
  db.prepare('UPDATE movies SET favorite = ? WHERE id = ?').run(next, req.params.id);
  return { favorite: next };
});

app.post('/api/movies/:id/watched', async (req, reply) => {
  const { watched } = req.body || {};
  const row = db.prepare('SELECT watched FROM movies WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const next = watched != null ? (watched ? 1 : 0) : (row.watched ? 0 : 1);
  db.prepare(
    'UPDATE movies SET watched = ?, resume_position = CASE WHEN ? = 1 THEN 0 ELSE resume_position END WHERE id = ?'
  ).run(next, next, req.params.id);
  return { watched: next };
});

// Trigger a rescan of all libraries on demand.
app.post('/api/scan', async () => {
  return scanLibraries(db);
});

// Trigger TMDB enrichment on demand (movies + shows).
app.post('/api/enrich', async () => {
  const movies = await enrichLibrary(db, config.tmdbApiKey);
  const shows = await enrichShows(db, config.tmdbApiKey);
  const episodes = await enrichEpisodes(db, config.tmdbApiKey);
  return { movies, shows, episodes };
});

// ---- Continue Watching (in-progress movies + episodes) ----

app.get('/api/continue', async () => {
  const movies = db.prepare(
    `SELECT 'movie' AS kind, id, title, poster, resume_position, duration, last_played_at,
            NULL AS show_id, NULL AS season, NULL AS episode
     FROM movies WHERE resume_position > 30 AND watched = 0 AND last_played_at IS NOT NULL`
  ).all();
  const episodes = db.prepare(
    `SELECT 'episode' AS kind, e.id, COALESCE(e.title, 'Episode ' || e.episode) AS title,
            s.poster AS poster, e.resume_position, e.duration, e.last_played_at,
            s.id AS show_id, e.season, e.episode
     FROM episodes e JOIN shows s ON s.id = e.show_id
     WHERE e.resume_position > 30 AND e.watched = 0 AND e.last_played_at IS NOT NULL`
  ).all();
  return [...movies, ...episodes]
    .sort((a, b) => (b.last_played_at || 0) - (a.last_played_at || 0))
    .slice(0, 20);
});

// ---- TV shows ----

app.get('/api/shows', async () => {
  return db.prepare(
    `SELECT s.id, s.title, s.year, s.poster, s.backdrop, s.overview, s.rating, s.genres, s.added_at,
            COUNT(e.id) AS episodes,
            SUM(CASE WHEN e.watched = 0 THEN 1 ELSE 0 END) AS unwatched,
            MAX(e.last_played_at) AS last_played_at
     FROM shows s LEFT JOIN episodes e ON e.show_id = s.id
     GROUP BY s.id
     ORDER BY s.title COLLATE NOCASE`
  ).all();
});

app.get('/api/episodes/:id/extra', async (req, reply) => {
  const row = db.prepare(
    'SELECT e.season, e.episode, s.tmdb_id FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?'
  ).get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  return (await episodeExtra(config.tmdbApiKey, row.tmdb_id, row.season, row.episode)) || {};
});

app.get('/api/shows/:id/extra', async (req, reply) => {
  const s = db.prepare('SELECT tmdb_id FROM shows WHERE id = ?').get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'not found' });
  return (await showExtra(config.tmdbApiKey, s.tmdb_id)) || { seasons: [] };
});

app.get('/api/shows/:id', async (req, reply) => {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(req.params.id);
  if (!show) return reply.code(404).send({ error: 'not found' });
  const eps = db.prepare(
    `SELECT id, season, episode, title, overview, still, duration, resume_position, watched
     FROM episodes WHERE show_id = ?
     ORDER BY season, episode`
  ).all(req.params.id);

  // Attach the file versions (qualities) of each episode, best first.
  const filesStmt = db.prepare('SELECT id, quality, filename, size, path FROM episode_files WHERE episode_id = ?');
  for (const e of eps) {
    const files = filesStmt.all(e.id);
    files.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    for (const f of files) { f.subtitles = listSubtitles(f.path).map((s, i) => ({ label: s.label, idx: i })); delete f.path; }
    e.files = files;
  }

  // Group episodes into seasons.
  const seasonsMap = new Map();
  for (const e of eps) {
    const s = e.season ?? 0;
    if (!seasonsMap.has(s)) seasonsMap.set(s, []);
    seasonsMap.get(s).push(e);
  }
  show.seasons = [...seasonsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({ season, episodes }));
  show.episodeCount = eps.length;
  return show;
});

app.post('/api/episodes/:id/progress', async (req, reply) => {
  const { position, duration, watched } = req.body || {};
  const row = db.prepare('SELECT id FROM episodes WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  db.prepare(
    `UPDATE episodes SET resume_position = ?, duration = COALESCE(?, duration),
     watched = COALESCE(?, watched), last_played_at = ? WHERE id = ?`
  ).run(position ?? 0, duration ?? null, watched ?? null, Date.now(), req.params.id);
  return { ok: true };
});

app.post('/api/episodes/:id/watched', async (req, reply) => {
  const { watched } = req.body || {};
  const row = db.prepare('SELECT watched FROM episodes WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const next = watched != null ? (watched ? 1 : 0) : (row.watched ? 0 : 1);
  db.prepare(
    'UPDATE episodes SET watched = ?, resume_position = CASE WHEN ? = 1 THEN 0 ELSE resume_position END WHERE id = ?'
  ).run(next, next, req.params.id);
  return { watched: next };
});

// ---- Self-update (git pull + restart, driven by run.bat) ----

function gitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    let date = null;
    try {
      date = execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: ROOT }).toString().trim();
    } catch {}
    return { sha, date, tracked: true };
  } catch {
    return { sha: 'unknown', date: null, tracked: false };
  }
}

app.get('/api/version', async () => gitInfo());

// Ask GitHub whether newer code exists (fetches, then compares local vs remote).
// Async git — the fetch can take seconds, and a synchronous call here would
// freeze the whole event loop (stuttering any video streaming in progress).
const git = (args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: ROOT, timeout: 15000, windowsHide: true },
    (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
});

app.get('/api/check-update', async () => {
  try {
    await git(['fetch', 'origin', 'main', '--quiet']);
    const current = await git(['rev-parse', 'HEAD']);
    const latest = await git(['rev-parse', 'origin/main']);
    const behind = parseInt(await git(['rev-list', '--count', 'HEAD..origin/main']).catch(() => '0'), 10) || 0;
    return { current: current.slice(0, 7), latest: latest.slice(0, 7), updateAvailable: current !== latest, behind };
  } catch {
    return { updateAvailable: false, error: 'offline or updates not enabled' };
  }
});

// Exit with code 42 so the run.bat wrapper pulls the latest code and relaunches.
app.post('/api/update', async (req, reply) => {
  reply.send({ ok: true, restarting: true });
  setTimeout(() => process.exit(42), 400);
});

// ---- Libraries (the folders the user points us at) ----

app.get('/api/libraries', async () => {
  return db.prepare('SELECT * FROM libraries ORDER BY type, path COLLATE NOCASE').all();
});

app.post('/api/libraries', async (req, reply) => {
  const body = req.body || {};
  const p = body.path;
  if (!p) return reply.code(400).send({ error: 'path required' });
  if (!fs.existsSync(p)) return reply.code(400).send({ error: 'folder not found on server' });
  const type = body.type === 'tv' ? 'tv' : 'movie';
  const name = body.name || path.basename(p) || p;

  db.prepare('INSERT OR IGNORE INTO libraries (path, type, name) VALUES (?, ?, ?)').run(p, type, name);
  const lib = db.prepare('SELECT * FROM libraries WHERE path = ?').get(p);

  // Scan straight away so new titles show up, then enrich in the background.
  const scan = scanLibraries(db);
  if (config.tmdbApiKey) {
    enrichLibrary(db, config.tmdbApiKey)
      .then(() => enrichShows(db, config.tmdbApiKey))
      .then(() => enrichEpisodes(db, config.tmdbApiKey))
      .then(() => backfillGenres(db, config.tmdbApiKey))
      .catch((e) => console.error('Enrichment error:', e.message));
  }
  return { library: lib, scan };
});

app.delete('/api/libraries/:id', async (req, reply) => {
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!lib) return reply.code(404).send({ error: 'not found' });
  db.prepare('DELETE FROM movie_files WHERE library_id = ?').run(req.params.id);
  db.prepare('DELETE FROM episode_files WHERE library_id = ?').run(req.params.id);
  // Drop movies/episodes/shows that no longer have any files.
  db.prepare('DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM movie_files)').run();
  db.prepare('DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM episode_files)').run();
  db.prepare('DELETE FROM shows WHERE id NOT IN (SELECT DISTINCT show_id FROM episodes)').run();
  db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
  return { ok: true };
});

// ---- Server-side folder browser (for the in-app folder picker) ----

app.get('/api/fs', async (req, reply) => {
  const p = req.query.path;
  try {
    if (!p) return { path: null, parent: null, drives: listDrives(), dirs: [] };
    return listDirs(p);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

// ---- Video streaming with HTTP Range support (seeking) ----

function streamFile(filePath, req, reply) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return reply.code(404).send({ error: 'file missing on disk' });
  }

  const total = stat.size;
  const type = MIME[ext(filePath)] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    }
    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${total}`)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', end - start + 1)
      .header('Content-Type', type);
    return reply.send(fs.createReadStream(filePath, { start, end }));
  }

  reply
    .header('Content-Length', total)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', type);
  return reply.send(fs.createReadStream(filePath));
}

// Stream a specific movie file (version) by its file id.
app.get('/api/stream/:fileId', (req, reply) => {
  const row = db.prepare('SELECT path FROM movie_files WHERE id = ?').get(req.params.fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });
  return streamFile(row.path, req, reply);
});

// Stream a specific TV episode file (version) by its file id.
app.get('/api/stream/episode/:fileId', (req, reply) => {
  const row = db.prepare('SELECT path FROM episode_files WHERE id = ?').get(req.params.fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });
  return streamFile(row.path, req, reply);
});

// ---- Playback engine (ffmpeg): play decision + transcode streaming ----

function fileRow(kind, fileId) {
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  return db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(fileId);
}

// How should the browser play this file? `direct` = today's range streaming;
// `transcode` = ffmpeg remux/transcode to fragmented MP4. Also reports the real
// duration (from ffprobe) so the player has a timeline even when transcoding.
app.get('/api/play/:kind/:fileId', async (req, reply) => {
  const { kind, fileId } = req.params;
  const row = fileRow(kind, fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const info = await playInfo(row.path);
  const directUrl = (kind === 'episode' ? '/api/stream/episode/' : '/api/stream/') + fileId;
  return {
    mode: info.mode,
    duration: info.duration,
    reason: info.reason || null,
    url: info.mode === 'transcode' ? `/api/transcode/${kind}/${fileId}` : directUrl
  };
});

// Live-transcoded stream. ?start=SECONDS seeks (the client restarts the stream
// and keeps a virtual timeline). The ffmpeg child is killed when the client
// disconnects so seeks don't pile up encoder processes.
app.get('/api/transcode/:kind/:fileId', async (req, reply) => {
  const { kind, fileId } = req.params;
  const row = fileRow(kind, fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const info = await playInfo(row.path);
  if (info.mode !== 'transcode') return reply.code(400).send({ error: 'file does not need transcoding' });
  const start = Math.max(0, parseFloat(req.query.start) || 0);
  const proc = transcodeStream(row.path, { start, vcopy: info.vcopy, acopy: info.acopy });
  proc.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim()));
  proc.on('error', (e) => console.error('[ffmpeg] spawn error:', e.message));
  req.raw.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
  reply.header('Content-Type', 'video/mp4');
  return reply.send(proc.stdout);
});

// ---- Playback prefs (server-side so they follow the user across devices) ----
// Version choices and caption delays used to live in localStorage, which is
// per-browser — pick a version on the PC and the TV knows nothing about it.
app.get('/api/prefs', async () => {
  return Object.fromEntries(db.prepare('SELECT key, value FROM prefs').all().map((r) => [r.key, r.value]));
});
app.post('/api/prefs', async (req, reply) => {
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string') return reply.code(400).send({ error: 'key required' });
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM prefs WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
  return { ok: true };
});

// Engine status + one-click install (download a static build into tools/).
app.get('/api/ffmpeg', async () => ffmpegStatus());
app.post('/api/ffmpeg/install', async () => {
  if (!ffmpegStatus().installing) installFfmpeg(ROOT, config); // fire and forget; poll GET /api/ffmpeg
  return ffmpegStatus();
});

// ---- AI subtitle generation (whisper.cpp) ----
app.get('/api/whisper', async () => whisperStatus());
app.post('/api/whisper/install', async (req) => {
  const force = !!(req.body && req.body.force); // force = re-install (e.g. switch to GPU)
  if (!whisperStatus().installing) installWhisper(ROOT, config, { force });
  return whisperStatus();
});

// AI subtitle generation runs as a background job (a full movie takes minutes),
// so the request returns immediately and the player polls for progress. `target`
// is 'orig' (transcribe spoken language), 'en' (translate to English), or a
// language code like 'es' (English via whisper, then translated to Spanish).
const subJobs = new Map(); // key -> { status, pct, phase, error, result }
const jobKey = (kind, fileId, target) => `${kind}:${fileId}:${target}`;

async function runSubJob(job, kind, fileId, target) {
  const row = fileRow(kind, fileId);
  if (!row) { job.status = 'error'; job.error = 'file not found'; return; }
  try {
    const toEnglish = target === 'en' || (target !== 'orig' && target !== 'auto');
    const twoPhase = toEnglish && target !== 'en'; // translate to a non-English target
    job.phase = 'transcribing';
    const baseVtt = await generateSubs(ROOT, ffmpegBin(), row.path, {
      language: 'auto', translate: toEnglish,
      onProgress: (p) => { job.pct = Math.round(p * (twoPhase ? 70 : 100)); }
    });
    let vttPath = baseVtt;
    if (twoPhase) {
      job.phase = 'translating';
      const outPath = row.path.replace(/\.[^.]+$/, '') + `.${target}-ai.vtt`;
      vttPath = await translateVttFile(baseVtt, outPath, target, {
        config, onProgress: (p) => { job.pct = 70 + Math.round(p * 30); }
      });
    }
    const list = listSubtitles(row.path);
    const idx = Math.max(0, list.findIndex((s) => s.path === vttPath));
    job.result = { subtitles: list.map((s, i) => ({ label: s.label, idx: i })), idx };
    job.pct = 100; job.status = 'done';
  } catch (e) {
    job.status = 'error'; job.error = e.message;
  }
}

app.post('/api/subtitles/generate', async (req, reply) => {
  const { kind, fileId, target = 'orig' } = req.body || {};
  if (!fileRow(kind, fileId)) return reply.code(404).send({ error: 'not found' });
  if (!whisperStatus().available) return reply.code(400).send({ error: 'The AI subtitle engine is not installed yet — install it in ⚙ Settings.' });
  const key = jobKey(kind, fileId, target);
  let job = subJobs.get(key);
  if (!job || job.status === 'error') {
    job = { status: 'running', pct: 0, phase: 'starting', error: null, result: null };
    subJobs.set(key, job);
    runSubJob(job, kind, fileId, target); // fire and forget; client polls GET
  }
  return { status: job.status, pct: job.pct, phase: job.phase, error: job.error, result: job.result };
});

app.get('/api/subtitles/generate', async (req) => {
  const { kind, fileId, target = 'orig' } = req.query;
  const job = subJobs.get(jobKey(kind, fileId, target));
  if (!job) return { status: 'none' };
  return { status: job.status, pct: job.pct, phase: job.phase, error: job.error, result: job.result };
});

// ---- Subtitles: .srt sidecars served as WebVTT ----

// Find external .srt subtitles for a video: next to it (loose name match, either
// direction) and in a Subs/Subtitles subfolder. Returns [{ path, label }].
function listSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nstem = norm(stem);
  const out = [];

  const consider = (folder, loose) => {
    let files;
    try { files = fs.readdirSync(folder); } catch { return; }
    for (const f of files) {
      if (!/\.(srt|vtt)$/i.test(f)) continue;
      const b = path.basename(f, path.extname(f));
      const nb = norm(b);
      const match = loose || nb === nstem || nb.startsWith(nstem) || nstem.startsWith(nb) || nb.includes(nstem) || nstem.includes(nb);
      if (!match) continue;
      // AI-generated tracks are tagged "<lang>-ai" or "orig-ai" by whisper.js.
      const ai = b.match(/[.\-_ ](orig|[a-z]{2,3})-ai$/i);
      let label;
      if (ai) label = (ai[1].toLowerCase() === 'orig' ? 'Auto' : ai[1].toUpperCase()) + ' (AI)';
      else {
        const lang = (b.toLowerCase().match(/[.\-_ ]([a-z]{2,3})(\.forced|\.sdh)?$/) || [])[1];
        const extra = b.length > stem.length ? b.slice(stem.length).replace(/[.\-_]+/g, ' ').trim() : '';
        label = lang ? lang.toUpperCase() : (extra || 'Subtitles');
      }
      out.push({ path: path.join(folder, f), label });
    }
  };
  consider(dir, false);
  for (const sub of ['Subs', 'Subtitles', 'subs', 'subtitles', 'Sub']) consider(path.join(dir, sub), true);

  const seen = new Set();
  return out.filter((s) => (seen.has(s.path) ? false : seen.add(s.path)));
}

function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

function serveSubtitle(videoPath, idx, reply) {
  const subs = videoPath ? listSubtitles(videoPath) : [];
  const sub = subs[idx] || subs[0];
  if (!sub) return reply.code(404).send({ error: 'no subtitle' });
  let text;
  try { text = fs.readFileSync(sub.path, 'utf8'); } catch { return reply.code(404).send({ error: 'unreadable' }); }
  reply.header('Content-Type', 'text/vtt; charset=utf-8');
  // .vtt sidecars (e.g. AI-generated) are already WebVTT; .srt needs converting.
  return reply.send(/\.vtt$/i.test(sub.path) ? text.replace(/^﻿/, '') : srtToVtt(text));
}

app.get('/api/subtitle/episode/:fileId', (req, reply) => {
  const row = db.prepare('SELECT path FROM episode_files WHERE id = ?').get(req.params.fileId);
  return serveSubtitle(row && row.path, parseInt(req.query.idx, 10) || 0, reply);
});

app.get('/api/subtitle/:fileId', (req, reply) => {
  const row = db.prepare('SELECT path FROM movie_files WHERE id = ?').get(req.params.fileId);
  return serveSubtitle(row && row.path, parseInt(req.query.idx, 10) || 0, reply);
});

// ---- Subtitle search + download (OpenSubtitles) ----

app.get('/api/subtitles/search', async (req, reply) => {
  if (!osEnabled(config.openSubtitles)) return reply.code(400).send({ error: 'OpenSubtitles is not configured yet — add your API key.' });
  const { kind, fileId } = req.query;
  let params;
  if (kind === 'episode') {
    const f = db.prepare('SELECT episode_id FROM episode_files WHERE id = ?').get(fileId);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const ep = db.prepare(
      'SELECT e.season, e.episode, s.title AS showTitle FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?'
    ).get(f.episode_id);
    params = { query: ep.showTitle, season: ep.season, episode: ep.episode };
  } else {
    const f = db.prepare('SELECT movie_id FROM movie_files WHERE id = ?').get(fileId);
    if (!f) return reply.code(404).send({ error: 'not found' });
    const mv = db.prepare('SELECT title, tmdb_id FROM movies WHERE id = ?').get(f.movie_id);
    params = mv.tmdb_id ? { tmdb_id: mv.tmdb_id } : { query: mv.title };
  }
  return searchSubtitles(config.openSubtitles, params);
});

app.post('/api/subtitles/download', async (req, reply) => {
  if (!osEnabled(config.openSubtitles)) return reply.code(400).send({ error: 'OpenSubtitles is not configured.' });
  const { kind, fileId, file_id } = req.body || {};
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  const row = db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });

  const srt = await downloadSubtitle(config.openSubtitles, file_id);
  if (!srt) return reply.code(502).send({ error: 'Download failed — check your login, or you may have hit the daily limit.' });

  const dest = row.path.replace(/\.[^.]+$/, '') + '.en.srt';
  try {
    fs.writeFileSync(dest, srt, 'utf8');
  } catch (e) {
    return reply.code(500).send({ error: 'Could not save subtitle: ' + e.message });
  }
  return { ok: true };
});

// ---- Settings (in-app config, e.g. OpenSubtitles account) ----

app.get('/api/settings', async () => ({
  tmdb: { configured: !!config.tmdbApiKey },
  openSubtitles: {
    configured: osEnabled(config.openSubtitles),
    username: (config.openSubtitles && config.openSubtitles.username) || ''
  }
}));

app.post('/api/settings/opensubtitles', async (req, reply) => {
  const { apiKey, username, password } = req.body || {};
  config.openSubtitles = {
    apiKey: (apiKey || '').trim(),
    username: (username || '').trim(),
    password: password || ''
  };
  try {
    // Persist to config.json (stays local — it's git-ignored).
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    return reply.code(500).send({ error: 'could not save: ' + e.message });
  }
  clearAuth();
  return { ok: true, configured: osEnabled(config.openSubtitles) };
});

// ---- Boot ----

async function start() {
  // First run only: seed libraries from config.mediaRoots. After that, the user
  // manages folders in the app and this is a no-op.
  seedLibraries(db, mediaRoots);

  const ff = await detectFfmpeg(ROOT, config);
  console.log(ff.available
    ? `FFmpeg playback engine: ready${ff.nvenc ? ' (NVENC hardware encoding)' : ''}.`
    : 'FFmpeg playback engine: not installed — exotic formats will not transcode (install from ⚙ Settings).');
  const ws = await detectWhisper(ROOT, config);
  console.log(ws.available ? 'AI subtitle engine (whisper): ready.' : 'AI subtitle engine (whisper): not installed (optional; install from ⚙ Settings).');

  // Scan on startup so the library is fresh, then kick off enrichment in the
  // background (don't block the server coming up).
  const scan = scanLibraries(db);
  console.log(`Scan complete: ${scan.added} new file(s), ${scan.seen} video file(s) seen.`);

  if (config.tmdbApiKey) {
    (async () => {
      const m = await enrichLibrary(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${m} movie(s) updated.`);
      const s = await enrichShows(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${s} show(s) updated.`);
      const ep = await enrichEpisodes(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${ep} episode(s) updated.`);
      await backfillGenres(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      await backfillMovieDetails(db, config.tmdbApiKey, { log: (x) => console.log(x) });
    })().catch((e) => console.error('Enrichment error:', e.message));
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`\n  Media server running at http://localhost:${config.port}\n`);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});

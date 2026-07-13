import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.js';
import { scanLibraries, seedLibraries } from './scan.js';
import { enrichLibrary, enrichShows, enrichEpisodes, movieExtra, showExtra, backfillGenres, episodeExtra, backfillMovieDetails, backfillCompanies } from './tmdb.js';
import { ext, qualityRank } from './parse.js';
import { listDrives, listDirs } from './fsbrowse.js';
import { osEnabled, searchSubtitles, downloadSubtitle, clearAuth } from './opensubtitles.js';
import { detectFfmpeg, status as ffmpegStatus, installFfmpeg, playInfo, transcodeStream, ffmpegBin } from './ffmpeg.js';
import { detectWhisper, status as whisperStatus, installWhisper, generate as generateSubs } from './whisper.js';
import { translateVttFile } from './translate.js';
import { radarrEnabled, sonarrEnabled, testConn, radarrSearch, radarrAdd, sonarrSearch, sonarrAdd, getProfiles, radarrQueue, sonarrQueue } from './arr.js';
import { runIntroDetection, introForFile } from './introdetect.js';
import { hashPassword, verifyPassword, newToken, tokenFromReq, cookieHeader } from './auth.js';
import { PROVIDERS, providersList, refreshCatalog, catalogFor, catalogProviderMap, titleProviders, watchLink, status as streamingStatus } from './streaming.js';

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
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2'
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

// ---- Auth guard ----
// The invite code is baked into the app you hand out, so anyone with the app
// can self-register, but a stranger who finds the public URL cannot. Override
// it in config.json (never commit it).
const INVITE_CODE = String(config.inviteCode || 'CHANGE-ME');
const HTTPS = !!config.https; // set once we're behind TLS, to mark cookies Secure

// Endpoints reachable without a session (everything else under /api requires one).
const AUTH_PUBLIC = new Set(['/api/auth/status', '/api/register', '/api/login']);

function currentUser(req) {
  const tok = tokenFromReq(req);
  if (!tok) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.role FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?'
  ).get(tok);
  if (row) db.prepare('UPDATE tokens SET last_used_at = ? WHERE token = ?').run(Date.now(), tok);
  return row || null;
}

function requireAdmin(req, reply) {
  if (!req.user || req.user.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' });
    return false;
  }
  return true;
}

// Gate every /api/* route (except the auth endpoints) behind a valid session.
// Static files (the UI + login page) stay public so the app can load and log in.
app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/')) return;
  if (AUTH_PUBLIC.has(url)) return;
  const user = currentUser(req);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
});

// Simple per-IP throttle on the credential endpoints (they're internet-facing).
const authHits = new Map();
function authThrottled(req) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const rec = authHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++;
  authHits.set(ip, rec);
  return rec.n > 20; // >20 attempts/minute/IP
}

// When the first (admin) account is created, adopt the pre-accounts globals so
// the owner keeps their existing watch state, prefs and OpenSubtitles login.
function migrateGlobalsToAdmin(adminId) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO watch_state (user_id, kind, item_id, resume_position, watched, favorite, last_played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const m of db.prepare(
    'SELECT id, resume_position, watched, favorite, last_played_at FROM movies WHERE resume_position > 0 OR watched = 1 OR favorite = 1 OR last_played_at IS NOT NULL'
  ).all()) {
    ins.run(adminId, 'movie', m.id, m.resume_position || 0, m.watched || 0, m.favorite || 0, m.last_played_at || null);
  }
  for (const e of db.prepare(
    'SELECT id, resume_position, watched, last_played_at FROM episodes WHERE resume_position > 0 OR watched = 1 OR last_played_at IS NOT NULL'
  ).all()) {
    ins.run(adminId, 'episode', e.id, e.resume_position || 0, e.watched || 0, 0, e.last_played_at || null);
  }
  for (const p of db.prepare('SELECT key, value FROM prefs').all()) {
    db.prepare('INSERT OR IGNORE INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)').run(adminId, p.key, p.value);
  }
  const os = config.openSubtitles;
  if (os) {
    for (const [k, v] of Object.entries({ 'os:apiKey': os.apiKey, 'os:username': os.username, 'os:password': os.password })) {
      if (v) db.prepare('INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(adminId, k, String(v));
    }
  }
}

// ---- Per-user watch state & settings helpers ----
// resume/watched/favorite/last-played live per-user in watch_state; `duration`
// stays on the media row (a file property, not per-user).
function wsGet(userId, kind, itemId) {
  return db.prepare(
    'SELECT resume_position, watched, favorite, last_played_at FROM watch_state WHERE user_id = ? AND kind = ? AND item_id = ?'
  ).get(userId, kind, itemId) || { resume_position: 0, watched: 0, favorite: 0, last_played_at: null };
}
function wsUpsert(userId, kind, itemId, fields) {
  const next = { ...wsGet(userId, kind, itemId), ...fields };
  db.prepare(
    `INSERT INTO watch_state (user_id, kind, item_id, resume_position, watched, favorite, last_played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind, item_id) DO UPDATE SET
       resume_position = excluded.resume_position, watched = excluded.watched,
       favorite = excluded.favorite, last_played_at = excluded.last_played_at`
  ).run(userId, kind, itemId, next.resume_position || 0, next.watched || 0, next.favorite || 0, next.last_played_at ?? null);
  return next;
}
// Overlay a user's watch state onto a list of movie/episode rows (matched by .id).
function overlayWatch(userId, items, kind = 'movie') {
  for (const it of items) Object.assign(it, wsGet(userId, kind, it.id));
  return items;
}
// A user's own OpenSubtitles login (stored per-user in user_settings; the raw
// creds never go to the client).
function userOS(userId) {
  const cfg = {};
  for (const r of db.prepare("SELECT key, value FROM user_settings WHERE user_id = ? AND key LIKE 'os:%'").all(userId)) {
    cfg[r.key.slice(3)] = r.value;
  }
  return cfg;
}

// ---- API ----

// ---- Auth / accounts ----

// Does an admin exist yet? The app uses this to show "create account" vs "log in".
app.get('/api/auth/status', async () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return { hasUsers: n > 0 };
});

// Self-register with the app's baked-in invite code. The first account created
// becomes the admin (the owner); everyone after is a normal user.
app.post('/api/register', async (req, reply) => {
  if (authThrottled(req)) return reply.code(429).send({ error: 'too many attempts — wait a minute' });
  const { username, password, code } = req.body || {};
  if (String(code || '') !== INVITE_CODE) return reply.code(403).send({ error: 'invalid invite code' });
  const uname = String(username || '').trim().toLowerCase();
  if (uname.length < 2) return reply.code(400).send({ error: 'username too short' });
  if (String(password || '').length < 4) return reply.code(400).send({ error: 'password too short' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
    return reply.code(409).send({ error: 'that username is taken' });
  }
  const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const role = first ? 'admin' : 'user';
  const id = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(uname, hashPassword(password), role, Date.now()).lastInsertRowid;
  if (first) migrateGlobalsToAdmin(id);
  const token = newToken();
  db.prepare('INSERT INTO tokens (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
    .run(token, id, Date.now(), Date.now());
  reply.header('Set-Cookie', cookieHeader(token, { secure: HTTPS }));
  return { token, user: { username: uname, role } };
});

app.post('/api/login', async (req, reply) => {
  if (authThrottled(req)) return reply.code(429).send({ error: 'too many attempts — wait a minute' });
  const { username, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  const u = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(uname);
  if (!u || !verifyPassword(password, u.password_hash)) {
    return reply.code(401).send({ error: 'wrong username or password' });
  }
  const token = newToken();
  db.prepare('INSERT INTO tokens (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
    .run(token, u.id, Date.now(), Date.now());
  reply.header('Set-Cookie', cookieHeader(token, { secure: HTTPS }));
  return { token, user: { username: u.username, role: u.role } };
});

app.post('/api/logout', async (req, reply) => {
  const tok = tokenFromReq(req);
  if (tok) db.prepare('DELETE FROM tokens WHERE token = ?').run(tok);
  reply.header('Set-Cookie', cookieHeader('', { clear: true }));
  return { ok: true };
});

app.get('/api/me', async (req) => ({ user: req.user }));

// Admin: manage accounts (you add your friend here — no server-level access for them).
app.get('/api/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
});

app.post('/api/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { username, password, role } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (uname.length < 2) return reply.code(400).send({ error: 'username too short' });
  if (String(password || '').length < 4) return reply.code(400).send({ error: 'password too short' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
    return reply.code(409).send({ error: 'that username is taken' });
  }
  const r = role === 'admin' ? 'admin' : 'user';
  const id = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(uname, hashPassword(password), r, Date.now()).lastInsertRowid;
  return { id, username: uname, role: r };
});

app.delete('/api/users/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = Number(req.params.id);
  if (id === req.user.id) return reply.code(400).send({ error: "you can't delete your own account" });
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!target) return reply.code(404).send({ error: 'not found' });
  if (target.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) return reply.code(400).send({ error: "can't delete the last admin" });
  }
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM watch_state WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_prefs WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
});

// ---- Streaming sources ------------------------------------------------------
// A per-user preference: each user picks which sources (local + streaming
// services) merge into their Movies/TV. Default: local on, no services enabled.
function userSources(req) {
  const row = db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(req.user.id, 'sources');
  let s = null; try { s = JSON.parse(row && row.value); } catch {}
  const valid = new Set(PROVIDERS.map((p) => p.id));
  return {
    local: s ? s.local !== false : true,
    enabled: s && Array.isArray(s.enabled) ? s.enabled.filter((x) => valid.has(x)) : []
  };
}

// Shape a streaming catalog title like a local movie/show card, tagged so the
// client shows a provider badge and deep-links out instead of playing locally.
function streamItem(t) {
  return {
    id: 'stream:' + t.kind + ':' + t.tmdb_id, tmdb_id: t.tmdb_id,
    source: 'stream', providers: t.providers,
    title: t.title, year: t.year, poster: t.poster, backdrop: t.backdrop,
    overview: t.overview, rating: t.rating, genres: JSON.stringify(t.genres || []),
    watched: 0, favorite: 0, resume_position: 0, duration: null, runtime: null,
    added_at: null, last_played_at: null, versions: 0, qualities: null,
    episodes: 0, unwatched: 0
  };
}

// Append enabled streaming titles to a local list, dropping any already owned
// locally (dedupe by tmdb_id) — and tagging the surviving owned title with which
// enabled services ALSO carry it, so the client can badge "also on Netflix".
function withStreaming(req, kind, local) {
  const src = userSources(req);
  const base = src.local ? local : [];
  if (!src.enabled.length) return base;
  if (src.local) {
    const also = catalogProviderMap(kind, src.enabled);
    for (const it of base) { const on = also.get(it.tmdb_id); if (on && on.length) it.alsoOn = on; }
  }
  const owned = new Set(local.map((x) => x.tmdb_id).filter(Boolean));
  const extra = catalogFor(kind, src.enabled).filter((t) => !owned.has(t.tmdb_id)).map(streamItem);
  return [...base, ...extra];
}

// Which of the user's enabled services carry this exact title (authoritative,
// per-title). Empty when streaming is off or the title isn't on any enabled one.
async function alsoOnFor(req, kind, tmdbId) {
  const enabled = userSources(req).enabled;
  if (!enabled.length || !tmdbId) return [];
  const on = await titleProviders(config.tmdbApiKey, kind, tmdbId, config.region || 'US');
  return enabled.filter((s) => on.includes(s));
}

app.get('/api/movies', async (req) => {
  const local = db.prepare(
    `SELECT m.id, m.tmdb_id, m.title, m.year, m.poster, m.backdrop, m.overview, m.rating, m.genres,
            COALESCE(w.watched, 0) AS watched, COALESCE(w.favorite, 0) AS favorite,
            COALESCE(w.resume_position, 0) AS resume_position, m.duration, m.runtime,
            m.added_at, w.last_played_at,
            COUNT(f.id) AS versions,
            GROUP_CONCAT(DISTINCT f.quality) AS qualities
     FROM movies m
     LEFT JOIN movie_files f ON f.movie_id = m.id
     LEFT JOIN watch_state w ON w.user_id = ? AND w.kind = 'movie' AND w.item_id = m.id
     GROUP BY m.id
     ORDER BY m.title COLLATE NOCASE`
  ).all(req.user.id);
  return withStreaming(req, 'movie', local);
});

// Broad "meta-collections" — studios/franchises that aren't a single TMDB
// collection. Defined by production company id, or a curated tmdbId list where
// no clean company exists (DC). `not`/`notGenre` carve subsets apart.
const META_COLLECTIONS = [
  { id: 'meta:mcu', name: 'Marvel Cinematic Universe', company: 420 },
  { id: 'meta:starwars', name: 'Star Wars', company: 1 }, // Lucasfilm
  { id: 'meta:pixar', name: 'Pixar', company: 3 },
  { id: 'meta:disney-animation', name: 'Disney Animated Classics', company: 6125 }, // Walt Disney Animation Studios
  { id: 'meta:disney-live', name: 'Disney Live-Action', company: 2, not: [6125, 3], notGenre: ['Animation'] }, // Walt Disney Pictures, minus animated
  { id: 'meta:dreamworks', name: 'DreamWorks Animation', company: 521 },
  { id: 'meta:dceu', name: 'DC Extended Universe', tmdbIds: [49521, 209112, 297761, 297762, 141052, 297802, 287947, 495764, 464052, 436969, 791373, 436270, 594767, 298618, 565770, 572802] }
];

function metaMembers(def) {
  const rows = db.prepare(
    `SELECT id, title, year, poster, backdrop, overview, rating, watched, resume_position, duration, runtime, genres, companies, tmdb_id
     FROM movies WHERE tmdb_id IS NOT NULL`
  ).all();
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  return rows.filter((m) => {
    if (def.tmdbIds) return def.tmdbIds.includes(m.tmdb_id);
    const cos = parse(m.companies);
    if (!cos.includes(def.company)) return false;
    if (def.not && def.not.some((c) => cos.includes(c))) return false;
    if (def.notGenre && def.notGenre.some((g) => parse(m.genres).includes(g))) return false;
    return true;
  }).sort((a, b) => (a.year || 0) - (b.year || 0));
}

// Collections tab: broad meta-collections (Marvel, Disney, Star Wars…) first,
// then TMDB franchise collections. Each needs 3+ owned titles.
app.get('/api/collections', async () => {
  const meta = META_COLLECTIONS.map((def) => {
    const items = metaMembers(def);
    if (items.length < 3) return null;
    const art = items.find((i) => i.backdrop) || items[0];
    return { id: def.id, name: def.name, count: items.length, poster: art.poster, backdrop: art.backdrop, meta: true };
  }).filter(Boolean).sort((a, b) => b.count - a.count);

  const tmdb = db.prepare(
    `SELECT collection_id AS id, collection_name AS name, COUNT(*) AS count,
            MAX(collection_poster) AS poster, MAX(backdrop) AS backdrop, MIN(poster) AS memberPoster
     FROM movies WHERE collection_id IS NOT NULL
     GROUP BY collection_id, collection_name HAVING count >= 3 ORDER BY name COLLATE NOCASE`
  ).all().map((r) => ({ id: r.id, name: r.name, count: r.count, poster: r.poster || r.memberPoster, backdrop: r.backdrop }));

  return [...meta, ...tmdb];
});

// One collection's owned entries, in release order (playable). Handles both
// meta:<id> and numeric TMDB collection ids.
app.get('/api/collections/:id', async (req) => {
  const id = req.params.id;
  if (id.startsWith('meta:')) {
    const def = META_COLLECTIONS.find((d) => d.id === id);
    if (!def) return { name: null, items: [] };
    const items = overlayWatch(req.user.id, metaMembers(def));
    const art = items.find((i) => i.backdrop) || items[0] || {};
    return { name: def.name, poster: art.poster, backdrop: art.backdrop, items };
  }
  const meta = db.prepare('SELECT collection_name AS name, MAX(collection_poster) AS poster, MAX(backdrop) AS backdrop FROM movies WHERE collection_id = ?').get(id);
  const items = overlayWatch(req.user.id, db.prepare(
    `SELECT id, title, year, poster, backdrop, overview, rating, watched, resume_position, duration, runtime
     FROM movies WHERE collection_id = ? ORDER BY year, title COLLATE NOCASE`
  ).all(id));
  return { name: meta && meta.name, poster: meta && meta.poster, backdrop: meta && meta.backdrop, items };
});

// Rich TMDB detail (genres, cast, director, trailer, recommendations). Owned
// recommendations get a localId so the UI can make them playable.
app.get('/api/movies/:id/extra', async (req, reply) => {
  const m = db.prepare('SELECT tmdb_id FROM movies WHERE id = ?').get(req.params.id);
  if (!m) return reply.code(404).send({ error: 'not found' });
  const extra = await movieExtra(config.tmdbApiKey, m.tmdb_id);
  if (!extra) return { genres: [], runtime: null, cast: [], directors: [], trailer: null, recommendations: [], alsoOn: await alsoOnFor(req, 'movie', m.tmdb_id) };
  const owned = db.prepare('SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL').all();
  const byTmdb = new Map(owned.map((o) => [o.tmdb_id, o.id]));
  for (const r of extra.recommendations) r.localId = byTmdb.get(r.tmdb_id) || null;
  if (extra.collection) for (const p of extra.collection.parts) p.localId = byTmdb.get(p.tmdb_id) || null;
  extra.alsoOn = await alsoOnFor(req, 'movie', m.tmdb_id); // enabled services that also carry it
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
  // Overlay this user's watch state onto the logical movie.
  Object.assign(row, wsGet(req.user.id, 'movie', row.id));
  row.files = files;
  return row;
});

// Save playback position (continue-watching) and watched state — per user.
app.post('/api/movies/:id/progress', async (req, reply) => {
  const { position, duration, watched } = req.body || {};
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
  if (duration != null) db.prepare('UPDATE movies SET duration = ? WHERE id = ?').run(duration, id);
  const fields = { resume_position: position ?? 0, last_played_at: Date.now() };
  if (watched != null) fields.watched = watched ? 1 : 0;
  wsUpsert(req.user.id, 'movie', id, fields);
  return { ok: true };
});

app.post('/api/movies/:id/favorite', async (req, reply) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
  const next = wsGet(req.user.id, 'movie', id).favorite ? 0 : 1;
  wsUpsert(req.user.id, 'movie', id, { favorite: next });
  return { favorite: next };
});

app.post('/api/movies/:id/watched', async (req, reply) => {
  const { watched } = req.body || {};
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
  const cur = wsGet(req.user.id, 'movie', id);
  const next = watched != null ? (watched ? 1 : 0) : (cur.watched ? 0 : 1);
  wsUpsert(req.user.id, 'movie', id, { watched: next, resume_position: next ? 0 : cur.resume_position });
  return { watched: next };
});

// Trigger a rescan of all libraries on demand (admin only).
app.post('/api/scan', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return scanLibraries(db);
});

// Trigger TMDB enrichment on demand (movies + shows) — admin only.
app.post('/api/enrich', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const movies = await enrichLibrary(db, config.tmdbApiKey);
  const shows = await enrichShows(db, config.tmdbApiKey);
  const episodes = await enrichEpisodes(db, config.tmdbApiKey);
  return { movies, shows, episodes };
});

// ---- Continue Watching (in-progress movies + episodes) ----

app.get('/api/continue', async (req) => {
  const uid = req.user.id;
  const movies = db.prepare(
    `SELECT 'movie' AS kind, m.id, m.title, m.poster, w.resume_position, m.duration, w.last_played_at,
            NULL AS show_id, NULL AS season, NULL AS episode
     FROM watch_state w JOIN movies m ON m.id = w.item_id
     WHERE w.user_id = ? AND w.kind = 'movie' AND w.resume_position > 30 AND w.watched = 0 AND w.last_played_at IS NOT NULL`
  ).all(uid);
  const episodes = db.prepare(
    `SELECT 'episode' AS kind, e.id, COALESCE(e.title, 'Episode ' || e.episode) AS title,
            s.poster AS poster, w.resume_position, e.duration, w.last_played_at,
            s.id AS show_id, e.season, e.episode
     FROM watch_state w JOIN episodes e ON e.id = w.item_id JOIN shows s ON s.id = e.show_id
     WHERE w.user_id = ? AND w.kind = 'episode' AND w.resume_position > 30 AND w.watched = 0 AND w.last_played_at IS NOT NULL`
  ).all(uid);
  return [...movies, ...episodes]
    .sort((a, b) => (b.last_played_at || 0) - (a.last_played_at || 0))
    .slice(0, 20);
});

// ---- TV shows ----

app.get('/api/shows', async (req) => {
  const local = db.prepare(
    `SELECT s.id, s.tmdb_id, s.title, s.year, s.poster, s.backdrop, s.overview, s.rating, s.genres, s.added_at,
            COUNT(e.id) AS episodes,
            SUM(CASE WHEN COALESCE(w.watched, 0) = 0 THEN 1 ELSE 0 END) AS unwatched,
            MAX(w.last_played_at) AS last_played_at
     FROM shows s
     LEFT JOIN episodes e ON e.show_id = s.id
     LEFT JOIN watch_state w ON w.user_id = ? AND w.kind = 'episode' AND w.item_id = e.id
     GROUP BY s.id
     ORDER BY s.title COLLATE NOCASE`
  ).all(req.user.id);
  return withStreaming(req, 'tv', local);
});

// Flat list of playable episodes (with the show's art/genres) so Live TV can
// air individual episodes with real durations — a proper broadcast schedule.
app.get('/api/livetv/episodes', async () => {
  return db.prepare(
    `SELECT e.id AS epId, e.show_id AS showId, e.season, e.episode, e.title AS epTitle, e.still, e.duration,
            s.title AS showTitle, s.poster, s.backdrop, s.overview, s.genres, s.year, s.rating
     FROM episodes e JOIN shows s ON s.id = e.show_id
     WHERE EXISTS (SELECT 1 FROM episode_files f WHERE f.episode_id = e.id)
     ORDER BY s.id, e.season, e.episode`
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
  const extra = (await showExtra(config.tmdbApiKey, s.tmdb_id)) || { seasons: [] };
  extra.alsoOn = await alsoOnFor(req, 'tv', s.tmdb_id); // enabled services that also carry it
  return extra;
});

app.get('/api/shows/:id', async (req, reply) => {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(req.params.id);
  if (!show) return reply.code(404).send({ error: 'not found' });
  const eps = db.prepare(
    `SELECT e.id, e.season, e.episode, e.title, e.overview, e.still, e.duration,
            COALESCE(w.resume_position, 0) AS resume_position, COALESCE(w.watched, 0) AS watched
     FROM episodes e
     LEFT JOIN watch_state w ON w.user_id = ? AND w.kind = 'episode' AND w.item_id = e.id
     WHERE e.show_id = ?
     ORDER BY e.season, e.episode`
  ).all(req.user.id, req.params.id);

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
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM episodes WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
  if (duration != null) db.prepare('UPDATE episodes SET duration = ? WHERE id = ?').run(duration, id);
  const fields = { resume_position: position ?? 0, last_played_at: Date.now() };
  if (watched != null) fields.watched = watched ? 1 : 0;
  wsUpsert(req.user.id, 'episode', id, fields);
  return { ok: true };
});

app.post('/api/episodes/:id/watched', async (req, reply) => {
  const { watched } = req.body || {};
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM episodes WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not found' });
  const cur = wsGet(req.user.id, 'episode', id);
  const next = watched != null ? (watched ? 1 : 0) : (cur.watched ? 0 : 1);
  wsUpsert(req.user.id, 'episode', id, { watched: next, resume_position: next ? 0 : cur.resume_position });
  return { watched: next };
});

// Bulk mark a whole show (or one season) watched/unwatched. Body: { watched:0|1,
// season? } — omit season for the whole show. Watched also clears resume points.
app.post('/api/shows/:id/watched', async (req, reply) => {
  const show = db.prepare('SELECT id FROM shows WHERE id = ?').get(req.params.id);
  if (!show) return reply.code(404).send({ error: 'not found' });
  const next = (req.body && req.body.watched) ? 1 : 0;
  const season = req.body && req.body.season;
  const eps = db.prepare(
    'SELECT id FROM episodes WHERE show_id = ?' + (season != null ? ' AND season = ?' : '')
  ).all(...(season != null ? [req.params.id, season] : [req.params.id]));
  for (const e of eps) {
    const cur = wsGet(req.user.id, 'episode', e.id);
    wsUpsert(req.user.id, 'episode', e.id, { watched: next, resume_position: next ? 0 : cur.resume_position });
  }
  return { watched: next, episodes: eps.length };
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

// Short, easy-to-type link for sideloading the Android TV app onto a new TV
// (typing the full GitHub release URL on a remote is painful). Public on purpose.
app.get('/tv', async (req, reply) =>
  reply.redirect('https://github.com/scenicprints/mediaserver/releases/download/marquee-tv-latest/app-release.apk')
);

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
    // "What's new": the subject line of each incoming commit, so the update
    // splash can tell the user what the update actually does.
    let notes = [];
    if (current !== latest) {
      const log = await git(['log', '--format=%s', 'HEAD..origin/main']).catch(() => '');
      notes = log.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    }
    return { current: current.slice(0, 7), latest: latest.slice(0, 7), updateAvailable: current !== latest, behind, notes };
  } catch {
    return { updateAvailable: false, error: 'offline or updates not enabled' };
  }
});

// Exit with code 42 so the run.bat wrapper pulls the latest code and relaunches.
// Admin only — a normal user must never be able to restart the shared server.
app.post('/api/update', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  reply.send({ ok: true, restarting: true });
  setTimeout(() => process.exit(42), 400);
});

// ---- Libraries (the folders the user points us at) ----

app.get('/api/libraries', async () => {
  return db.prepare('SELECT * FROM libraries ORDER BY type, path COLLATE NOCASE').all();
});

app.post('/api/libraries', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
  if (!requireAdmin(req, reply)) return;
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
  if (!requireAdmin(req, reply)) return;
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

// The "Audio" settings tab is a per-DEVICE choice (a TV's speaker setup, not the
// person), so the client passes it per request as query params rather than it
// living in the user's server-side prefs. Defaults = stereo fold, normal boost,
// no night mode, no normalization — a two-speaker TV's own downmix drops the
// center/dialogue channel, so folding on the server (correctly) is the default.
function audioOpts(req) {
  const q = req.query || {};
  return {
    forceStereo: q.audio !== 'surround',
    dboost: q.dboost === 'off' || q.dboost === 'strong' ? q.dboost : 'normal',
    night: q.night === '1',
    norm: q.norm === '1'
  };
}

// How should the browser play this file? `direct` = today's range streaming;
// `transcode` = ffmpeg remux/transcode to fragmented MP4. Also reports the real
// duration (from ffprobe) so the player has a timeline even when transcoding.
app.get('/api/play/:kind/:fileId', async (req, reply) => {
  const { kind, fileId } = req.params;
  const row = fileRow(kind, fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const info = await playInfo(row.path, audioOpts(req));
  const directUrl = (kind === 'episode' ? '/api/stream/episode/' : '/api/stream/') + fileId;
  return {
    mode: info.mode,
    duration: info.duration,
    reason: info.reason || null,
    chapters: info.chapters || [],
    intro: kind === 'episode' ? introForFile(db, fileId) : null, // fingerprinted theme-song range
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
  const opts = audioOpts(req);
  const info = await playInfo(row.path, opts);
  if (info.mode !== 'transcode') return reply.code(400).send({ error: 'file does not need transcoding' });
  const start = Math.max(0, parseFloat(req.query.start) || 0);
  const proc = transcodeStream(row.path, {
    start, vcopy: info.vcopy, acopy: info.acopy, downmix: info.downmix, scaleH: info.scaleH,
    forceStereo: opts.forceStereo, dboost: opts.dboost, night: opts.night, norm: opts.norm
  });
  proc.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim()));
  proc.on('error', (e) => console.error('[ffmpeg] spawn error:', e.message));
  req.raw.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
  reply.header('Content-Type', 'video/mp4');
  return reply.send(proc.stdout);
});

// ---- Playback prefs (server-side so they follow the user across devices) ----
// Version choices and caption delays used to live in localStorage, which is
// per-browser — pick a version on the PC and the TV knows nothing about it.
app.get('/api/prefs', async (req) => {
  return Object.fromEntries(
    db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(req.user.id).map((r) => [r.key, r.value])
  );
});
app.post('/api/prefs', async (req, reply) => {
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string') return reply.code(400).send({ error: 'key required' });
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(req.user.id, key);
  } else {
    db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
      .run(req.user.id, key, String(value));
  }
  return { ok: true };
});

// ---- Streaming services -----------------------------------------------------
// Which sources (local + streaming services) merge into Movies/TV for this user.
app.get('/api/providers', async (req) => {
  const src = userSources(req);
  return { providers: providersList(), enabled: src.enabled, local: src.local, status: streamingStatus() };
});
app.post('/api/providers', async (req) => {
  const valid = new Set(PROVIDERS.map((p) => p.id));
  const body = req.body || {};
  const enabled = Array.isArray(body.enabled) ? body.enabled.filter((x) => valid.has(x)) : [];
  const local = body.local !== false;
  db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
    .run(req.user.id, 'sources', JSON.stringify({ enabled, local }));
  return { ok: true, enabled, local };
});
// Deep-link for a streaming title — opens the service to that exact title.
app.get('/api/watch-link', async (req) => {
  const kind = req.query.kind === 'tv' ? 'tv' : 'movie';
  const tmdbId = parseInt(req.query.tmdbId, 10);
  if (!tmdbId) return { link: null };
  return { link: await watchLink(config.tmdbApiKey, kind, tmdbId, config.region || 'US') };
});

// Engine status + one-click install (download a static build into tools/).
app.get('/api/ffmpeg', async () => ffmpegStatus());
app.post('/api/ffmpeg/install', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  if (!ffmpegStatus().installing) installFfmpeg(ROOT, config); // fire and forget; poll GET /api/ffmpeg
  return ffmpegStatus();
});

// ---- AI subtitle generation (whisper.cpp) ----
app.get('/api/whisper', async () => whisperStatus());
app.post('/api/whisper/install', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
    const info = await playInfo(row.path);
    const mediaDuration = (info && info.duration) || 0;
    job.phase = 'extracting';
    // Extraction gets 0–12%, transcription the rest (or up to 70% if we still
    // have to translate afterwards).
    const transcribeCap = twoPhase ? 58 : 88;
    const baseVtt = await generateSubs(ROOT, ffmpegBin(), row.path, {
      language: 'auto', translate: toEnglish, mediaDuration,
      onProgress: (p, phase) => {
        if (phase === 'extracting') { job.phase = 'extracting'; job.pct = Math.round(p * 12); }
        else { job.phase = 'transcribing'; job.pct = 12 + Math.round(p * transcribeCap); }
      }
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

// ---- Requests (Radarr / Sonarr) ----
// Search either service and add ("request") titles you don't own yet; Radarr/
// Sonarr then fetch them. Config (url + apiKey per service) lives in the
// git-ignored config.json, entered via Settings.

app.get('/api/requests/status', async () => ({
  radarr: await testConn(config.radarr),
  sonarr: await testConn(config.sonarr)
}));

app.get('/api/requests/search', async (req, reply) => {
  const q = (req.query.q || '').trim();
  if (!q) return [];
  const tasks = [];
  if (radarrEnabled(config.radarr)) tasks.push(radarrSearch(config.radarr, q).catch(() => []));
  if (sonarrEnabled(config.sonarr)) tasks.push(sonarrSearch(config.sonarr, q).catch(() => []));
  if (!tasks.length) return reply.code(400).send({ error: 'Radarr/Sonarr are not configured yet — add them in Settings.' });
  const results = (await Promise.all(tasks)).flat();
  // Interleave movies and shows, most relevant first-ish (they arrive ranked
  // per service); keep a reasonable cap.
  return results.slice(0, 40);
});

app.post('/api/requests/add', async (req, reply) => {
  const { type, tmdbId, tvdbId, qualityProfileId } = req.body || {};
  try {
    if (type === 'movie') {
      if (!radarrEnabled(config.radarr)) return reply.code(400).send({ error: 'Radarr is not configured.' });
      const r = await radarrAdd(config.radarr, tmdbId, qualityProfileId);
      return r.ok ? { ok: true, already: !!r.already, title: r.title } : reply.code(502).send({ error: r.error });
    }
    if (type === 'tv') {
      if (!sonarrEnabled(config.sonarr)) return reply.code(400).send({ error: 'Sonarr is not configured.' });
      const r = await sonarrAdd(config.sonarr, tvdbId, qualityProfileId);
      return r.ok ? { ok: true, already: !!r.already, title: r.title } : reply.code(502).send({ error: r.error });
    }
    return reply.code(400).send({ error: 'unknown type' });
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
});

// Quality profiles per service (for the picker) + the current download queues.
app.get('/api/requests/profiles', async () => ({
  radarr: await getProfiles(config.radarr).catch(() => null),
  sonarr: await getProfiles(config.sonarr).catch(() => null)
}));

app.get('/api/requests/queue', async () => {
  const [rq, sq] = await Promise.all([
    radarrQueue(config.radarr).catch(() => []),
    sonarrQueue(config.sonarr).catch(() => [])
  ]);
  // Show unfinished/erroring items first, then by progress.
  return [...rq, ...sq].sort((a, b) => (b.errorMessage ? 1 : 0) - (a.errorMessage ? 1 : 0) || b.progress - a.progress);
});

// Save Radarr/Sonarr connection settings (url + apiKey) to config.json.
app.post('/api/settings/arr', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { radarr, sonarr } = req.body || {};
  const clean = (s) => (s && s.url ? { url: s.url.trim().replace(/\/+$/, ''), apiKey: (s.apiKey || '').trim() } : undefined);
  if (radarr !== undefined) config.radarr = clean(radarr);
  if (sonarr !== undefined) config.sonarr = clean(sonarr);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    return reply.code(500).send({ error: 'could not save: ' + e.message });
  }
  return { radarr: await testConn(config.radarr), sonarr: await testConn(config.sonarr) };
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
  const os = userOS(req.user.id);
  if (!osEnabled(os)) return reply.code(400).send({ error: 'OpenSubtitles isn’t set up in your Settings yet — add your API key.' });
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
  return searchSubtitles(os, params);
});

app.post('/api/subtitles/download', async (req, reply) => {
  const os = userOS(req.user.id);
  if (!osEnabled(os)) return reply.code(400).send({ error: 'OpenSubtitles isn’t set up in your Settings.' });
  const { kind, fileId, file_id } = req.body || {};
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  const row = db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });

  const srt = await downloadSubtitle(os, file_id);
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

// Per-user settings; server-level config (TMDB/Radarr/Sonarr) only for admins.
app.get('/api/settings', async (req) => {
  const os = userOS(req.user.id);
  const out = {
    user: { username: req.user.username, role: req.user.role },
    openSubtitles: { configured: osEnabled(os), username: os.username || '' }
  };
  if (req.user.role === 'admin') {
    out.tmdb = { configured: !!config.tmdbApiKey };
    out.radarr = { configured: radarrEnabled(config.radarr), url: (config.radarr && config.radarr.url) || '' };
    out.sonarr = { configured: sonarrEnabled(config.sonarr), url: (config.sonarr && config.sonarr.url) || '' };
  }
  return out;
});

// Each user saves their own OpenSubtitles login (per-user, so quotas don't mix).
app.post('/api/settings/opensubtitles', async (req, reply) => {
  const { apiKey, username, password } = req.body || {};
  const vals = {
    'os:apiKey': (apiKey || '').trim(),
    'os:username': (username || '').trim(),
    'os:password': password || ''
  };
  const upsert = db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
  for (const [k, v] of Object.entries(vals)) {
    if (v) upsert.run(req.user.id, k, v); else del.run(req.user.id, k);
  }
  const os = userOS(req.user.id);
  clearAuth(os); // drop this account's cached login token
  return { ok: true, configured: osEnabled(os) };
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

  // Bring the server up FIRST — the library is already in the DB from the last
  // run, so a restart is instant even on a big library. A fresh disk rescan
  // (walking 1000s of files off HDDs) and TMDB enrichment then run in the
  // background instead of holding the port closed. This fixes "the server takes
  // forever to come back after an update."
  await app.listen({ port: config.port, host: config.host });
  console.log(`\n  Media server running at http://localhost:${config.port}\n`);

  (async () => {
    await new Promise((r) => setTimeout(r, 500)); // let the first page load paint before the scan
    const scan = scanLibraries(db);
    console.log(`Scan complete: ${scan.added} new file(s), ${scan.seen} video file(s) seen${scan.removed ? `, ${scan.removed} stale file(s) pruned` : ''}.`);

    if (config.tmdbApiKey) {
      const m = await enrichLibrary(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${m} movie(s) updated.`);
      const s = await enrichShows(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${s} show(s) updated.`);
      const ep = await enrichEpisodes(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      console.log(`TMDB enrichment: ${ep} episode(s) updated.`);
      await backfillGenres(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      await backfillMovieDetails(db, config.tmdbApiKey, { log: (x) => console.log(x) });
      await backfillCompanies(db, config.tmdbApiKey, { log: (x) => console.log(x) });
    }
  })().catch((e) => console.error('Startup scan/enrich error:', e.message));

  // Streaming services (admin-only feature): pull each service's popular catalog
  // from TMDB so it can merge into browse, then refresh every 12h. Fully async —
  // never blocks the port or playback.
  if (config.tmdbApiKey) {
    const region = config.region || 'US';
    refreshCatalog(config.tmdbApiKey, { region, log: (x) => console.log(x) })
      .catch((e) => console.error('Streaming catalog error:', e.message));
    setInterval(() => {
      refreshCatalog(config.tmdbApiKey, { region, log: (x) => console.log(x) })
        .catch((e) => console.error('Streaming catalog refresh error:', e.message));
    }, 12 * 3600 * 1000);
  }

  // Intro (theme-song) detection + episode-duration probing — TEMPORARILY OFF
  // (pulled pending a rebuild). Set `"introDetection": true` in config.json to
  // re-enable. Fully async when it runs, so it never blocks playback.
  if (config.introDetection) {
    (async () => {
      await new Promise((r) => setTimeout(r, 45000)); // let boot/scan settle before the heavy job
      await runIntroDetection(db, ROOT, config, { log: (x) => console.log(x) });
    })().catch((e) => console.error('Intro detection error:', e.message));
  }
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});

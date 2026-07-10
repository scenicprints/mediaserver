import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.js';
import { scanLibraries, seedLibraries } from './scan.js';
import { enrichLibrary } from './tmdb.js';
import { ext, qualityRank } from './parse.js';
import { listDrives, listDirs } from './fsbrowse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Strip a leading UTF-8 BOM if present — some editors/PowerShell add one, and
// JSON.parse rejects it.
const configText = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, '');
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
    `SELECT m.id, m.title, m.year, m.poster, m.rating, m.watched, m.favorite,
            m.resume_position, m.duration, m.runtime,
            COUNT(f.id) AS versions,
            GROUP_CONCAT(DISTINCT f.quality) AS qualities
     FROM movies m
     LEFT JOIN movie_files f ON f.movie_id = m.id
     GROUP BY m.id
     ORDER BY m.title COLLATE NOCASE`
  ).all();
});

app.get('/api/movies/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const files = db.prepare(
    'SELECT id, quality, filename, size FROM movie_files WHERE movie_id = ?'
  ).all(req.params.id);
  // Highest quality first, so it's the default version to play.
  files.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
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

// Trigger a rescan of all libraries on demand.
app.post('/api/scan', async () => {
  return scanLibraries(db);
});

// Trigger TMDB enrichment on demand.
app.post('/api/enrich', async () => {
  const updated = await enrichLibrary(db, config.tmdbApiKey);
  return { updated };
});

// ---- Self-update (git pull + restart, driven by run.bat) ----

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

app.get('/api/version', async () => ({ sha: gitSha() }));

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

  // Scan straight away so new movies show up, then enrich in the background.
  const scan = scanLibraries(db);
  if (config.tmdbApiKey) {
    enrichLibrary(db, config.tmdbApiKey).catch((e) => console.error('Enrichment error:', e.message));
  }
  return { library: lib, scan };
});

app.delete('/api/libraries/:id', async (req, reply) => {
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!lib) return reply.code(404).send({ error: 'not found' });
  db.prepare('DELETE FROM movie_files WHERE library_id = ?').run(req.params.id);
  // Drop movies that no longer have any files.
  db.prepare('DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM movie_files)').run();
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

// Stream a specific file (version) by its file id.
app.get('/api/stream/:fileId', (req, reply) => {
  const row = db.prepare('SELECT path FROM movie_files WHERE id = ?').get(req.params.fileId);
  if (!row) return reply.code(404).send({ error: 'not found' });

  let stat;
  try {
    stat = fs.statSync(row.path);
  } catch {
    return reply.code(404).send({ error: 'file missing on disk' });
  }

  const total = stat.size;
  const type = MIME[ext(row.path)] || 'application/octet-stream';
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
    return reply.send(fs.createReadStream(row.path, { start, end }));
  }

  reply
    .header('Content-Length', total)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', type);
  return reply.send(fs.createReadStream(row.path));
});

// ---- Boot ----

async function start() {
  // First run only: seed libraries from config.mediaRoots. After that, the user
  // manages folders in the app and this is a no-op.
  seedLibraries(db, mediaRoots);

  // Scan on startup so the library is fresh, then kick off enrichment in the
  // background (don't block the server coming up).
  const scan = scanLibraries(db);
  console.log(`Scan complete: ${scan.added} new file(s), ${scan.seen} video file(s) seen.`);

  if (config.tmdbApiKey) {
    enrichLibrary(db, config.tmdbApiKey, { log: (m) => console.log(m) })
      .then((n) => console.log(`TMDB enrichment: ${n} movie(s) updated.`))
      .catch((e) => console.error('Enrichment error:', e.message));
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`\n  Media server running at http://localhost:${config.port}\n`);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});

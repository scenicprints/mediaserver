// Find media on disk, so the optimizer can work without Marquee.
//
// Until now every file it touched came from movie_files and episode_files in
// Marquee's database, filled in by Marquee's own scan. Handed anything else the
// program failed with "no such table: movie_files" — so for anyone running Plex,
// Jellyfin, Emby, or no server at all, it did not work.
//
// THE SHAPE OF THE FIX. This does not change the eight places the engine reads
// and writes the library. It creates tables of the SAME SHAPE in a database the
// optimizer owns, and fills them from folders the owner names. Every query, join
// and repoint downstream carries on untouched, which is the point: the scanner
// is new, so it is where a bug would be, and the proven parts should not be
// rewritten to accommodate it.
//
// Everything is filed as a "movie". The optimizer never asks what a file IS — it
// asks how big, what codec, how many channels, and probes the file itself to
// find out. Seasons and episode numbers exist in Marquee because Marquee has a
// library to present; here they would be guesses in a column nothing reads.
//
// IT NEVER WRITES TO DISK. It reads directory entries and sizes. The only thing
// it changes is rows in its own database.
import fs from 'node:fs';
import path from 'node:path';
import { volumeKeyOf, volumeAvailable } from './engine.mjs';

// The same list Marquee's own scanner uses, so a library that moves between the
// two is seen identically.
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.flv',
  '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.3g2'
]);

// Files that are something else mid-write. The optimizer's own temp output is in
// here: indexing that would have it plan work against a half-encoded file, and
// then — since the row looks like a library file — potentially replace a real
// film with it.
const WORKING_FILE = /\.marquee-opt\.tmp\.|\.partial$|\.replacing$|^\._/i;

// Folders that are never media, and two that are actively dangerous to walk.
//
// "Plex Versions" holds Plex's own re-encodes of the file sitting next to it:
// indexing those adds a second, worse copy of everything Plex has optimised.
// $RECYCLE.BIN holds deleted files, which must not be resurrected into a
// library. @eaDir and .@__thumb are Synology and QNAP thumbnail stores, which on
// a NAS share contain thousands of tiny files and no media at all.
const SKIP_DIRS = new Set([
  'plex versions', '$recycle.bin', 'system volume information',
  '@eadir', '.@__thumb', '#recycle', '.trash-1000', 'lost+found',
  '$sysreset', 'found.000'
]);

/**
 * The library tables, shaped exactly as Marquee's are.
 *
 * CREATE TABLE IF NOT EXISTS, and only ever called on a database the optimizer
 * owns — never on Marquee's. The columns are the ones the engine's queries
 * actually name: title for display, movie_id for the join, and path/filename/
 * size because the repoint after a successful job writes all three.
 *
 * The three TV tables are created empty. Nothing fills them, but the engine's
 * reads LEFT JOIN through them, and a missing table is an error where an empty
 * one is simply no rows.
 */
export function ensureLibrarySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      year  INTEGER
    );
    CREATE TABLE IF NOT EXISTS movie_files (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER,
      path     TEXT UNIQUE NOT NULL,
      filename TEXT,
      size     INTEGER,
      added_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER, season INTEGER, episode INTEGER
    );
    CREATE TABLE IF NOT EXISTS episode_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER,
      path TEXT UNIQUE NOT NULL, filename TEXT, size INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_movie_files_path ON movie_files(path);
  `);
}

/** Is this a video file worth indexing? */
export function isMedia(name) {
  if (WORKING_FILE.test(name)) return false;
  if (name.startsWith('.')) return false;
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

/** Should the walk go into this directory? */
export function isSkippedDir(name) {
  return SKIP_DIRS.has(String(name).toLowerCase());
}

// A readable name for the window. Not metadata and not pretending to be: the
// filename without its extension, release junk trimmed off the end. Nothing
// downstream makes a decision on it — it is what a row is called on screen.
export function titleFromPath(p) {
  let base = path.basename(String(p)).replace(/\.[^.]+$/, '');
  base = base.replace(/[._]+/g, ' ');
  const cut = base.search(
    /\b(2160p|1080p|1080i|720p|480p|576p|4k|uhd|hdr10\+?|hdr|dv|10bit|x264|x265|h ?264|h ?265|hevc|avc|xvid|divx|bluray|blu-ray|brrip|bdrip|bdremux|remux|web-?dl|web-?rip|webrip|hdrip|hdtv|dvdrip|dvd|proper|repack|internal|imax|aac|ac3|eac3|ddp?5|dts|truehd|atmos|flac|multi)\b/i
  );
  if (cut > 0) base = base.slice(0, cut);
  return base.replace(/[\s\-_.]+$/, '').replace(/\s+/g, ' ').trim() || path.basename(String(p));
}

/**
 * Walk a folder and hand back every media file in it.
 *
 * Symlinks and junctions are NOT followed. On Windows a junction pointing at a
 * parent turns a walk into an infinite one, and a NAS share full of them is a
 * normal thing to meet. lstat rather than stat is what makes that true.
 *
 * `onDir` is called per directory so a long scan can report progress instead of
 * looking hung.
 */
export function walkMedia(root, { onDir = () => {}, maxDepth = 24 } = {}) {
  const out = [];
  const seenDirs = new Set();   // belt and braces, in case a link slips through

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let real = dir;
    try { real = fs.realpathSync.native(dir); } catch { /* use the path as given */ }
    if (seenDirs.has(real.toLowerCase())) return;
    seenDirs.add(real.toLowerCase());

    onDir(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;              // never followed, never indexed
      if (e.isDirectory()) {
        if (!isSkippedDir(e.name)) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isMedia(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      if (size <= 0) continue;                       // a 0-byte file is not media
      out.push({ path: p, size });
    }
  };

  walk(root, 0);
  return out;
}

/**
 * Bring the database in line with what is on disk.
 *
 * Returns { added, updated, removed, seen, skippedFolders }.
 *
 * A folder on a volume that cannot be reached is SKIPPED ENTIRELY and its rows
 * are left alone — never treated as "the files are gone". That is the same rule
 * the rest of the program follows, and here it is the difference between
 * unplugging a drive and losing its library.
 */
export function syncLibrary(db, folders, { log = () => {}, onProgress = null } = {}) {
  ensureLibrarySchema(db);

  const wanted = Array.isArray(folders) ? folders.filter((f) => f && String(f).trim()) : [];
  const found = new Map();                   // lower-cased path -> { path, size }
  const skippedFolders = [];
  const vols = new Map();

  for (const folder of wanted) {
    const key = volumeKeyOf(folder);
    if (!volumeAvailable(key, vols)) {
      skippedFolders.push(folder);
      log(`skipping ${folder} — the drive or share it is on is not reachable`);
      continue;
    }
    let ok = false;
    try { ok = fs.statSync(folder).isDirectory(); } catch { ok = false; }
    if (!ok) { skippedFolders.push(folder); log(`skipping ${folder} — not a folder`); continue; }

    for (const f of walkMedia(folder, { onDir: onProgress || undefined })) {
      found.set(f.path.toLowerCase(), f);     // Windows paths differ only by case
    }
  }

  const existing = db.prepare('SELECT id, movie_id, path, size FROM movie_files').all();
  const byPath = new Map(existing.map((r) => [String(r.path).toLowerCase(), r]));

  const insMovie = db.prepare('INSERT INTO movies (title, year) VALUES (?, NULL)');
  const insFile = db.prepare('INSERT INTO movie_files (movie_id, path, filename, size, added_at) VALUES (?,?,?,?,?)');
  const setSize = db.prepare('UPDATE movie_files SET size = ? WHERE id = ?');
  const delFile = db.prepare('DELETE FROM movie_files WHERE id = ?');
  const delMovie = db.prepare('DELETE FROM movies WHERE id = ?');

  let added = 0, updated = 0, removed = 0;

  for (const [lower, f] of found) {
    const row = byPath.get(lower);
    if (!row) {
      const m = insMovie.run(titleFromPath(f.path));
      insFile.run(m.lastInsertRowid, f.path, path.basename(f.path), f.size, Date.now());
      added++;
      continue;
    }
    // A changed size means the file was replaced or is still being written. The
    // probe cache keys on size and mtime, so recording it is what makes the
    // optimizer look at the file again rather than trusting a stale reading.
    if (Number(row.size) !== f.size) { setSize.run(f.size, row.id); updated++; }
  }

  // Gone from disk — but only within folders actually scanned this time.
  const scannedRoots = wanted
    .filter((f) => !skippedFolders.includes(f))
    .map((f) => path.resolve(f).toLowerCase());
  const under = (p) => scannedRoots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

  for (const row of existing) {
    const lower = String(row.path).toLowerCase();
    if (found.has(lower)) continue;
    if (!under(path.resolve(row.path).toLowerCase())) continue;   // not ours to judge
    delFile.run(row.id);
    if (row.movie_id) { try { delMovie.run(row.movie_id); } catch { /* shared, leave it */ } }
    removed++;
  }

  // Probe rows for files that no longer exist would otherwise be planned against
  // for ever; the same cleanup Marquee's scan does.
  let orphanedInfo = 0;
  try {
    orphanedInfo = db.prepare(`
      DELETE FROM media_info
      WHERE file_kind = 'movie' AND file_id NOT IN (SELECT id FROM movie_files)`).run().changes;
  } catch { /* media_info may not exist yet on a brand-new database */ }

  return { added, updated, removed, seen: found.size, skippedFolders, orphanedInfo };
}

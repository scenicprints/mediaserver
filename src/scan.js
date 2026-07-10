import fs from 'node:fs';
import path from 'node:path';
import { isVideo, parseMovie, detectQuality, groupKey } from './parse.js';

// Seed the libraries table from config.mediaRoots the first time only, so
// existing setups (and the sample folder) keep working. After that, libraries
// are managed entirely in the app.
export function seedLibraries(db, roots) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n;
  if (count > 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO libraries (path, type, name) VALUES (?, ?, ?)');
  for (const r of roots) {
    const abs = path.resolve(r);
    insert.run(abs, 'movie', path.basename(abs) || abs);
  }
}

// Scan every movie library. Each video file is attached to a logical movie
// (grouped by title+year), so multiple qualities of the same film collapse into
// one entry. TV libraries are skipped for now but stay registered.
export function scanLibraries(db) {
  const libs = db.prepare('SELECT id, path, type FROM libraries').all();
  const fileExists = db.prepare('SELECT id FROM movie_files WHERE path = ?');
  const findMovie = db.prepare('SELECT id FROM movies WHERE group_key = ?');
  const insMovie = db.prepare(
    'INSERT INTO movies (group_key, title, year, added_at) VALUES (?, ?, ?, ?)'
  );
  const insFile = db.prepare(
    `INSERT OR IGNORE INTO movie_files (movie_id, library_id, path, filename, quality, size, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let added = 0, seen = 0;
  for (const lib of libs) {
    if (lib.type !== 'movie') continue;
    walk(path.resolve(lib.path), (full, stat) => {
      const name = path.basename(full);
      if (!isVideo(name)) return;
      seen++;
      if (fileExists.get(full)) return;

      const { title, year } = parseMovie(name);
      const key = groupKey(title, year);
      const existing = findMovie.get(key);
      const movieId = existing
        ? existing.id
        : insMovie.run(key, title, year, Date.now()).lastInsertRowid;

      insFile.run(movieId, lib.id, full, name, detectQuality(name), stat.size, Date.now());
      added++;
    });
  }
  return { added, seen };
}

function walk(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing drive — skip quietly
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, cb);
    } else if (e.isFile()) {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      cb(full, stat);
    }
  }
}

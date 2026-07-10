import fs from 'node:fs';
import path from 'node:path';
import {
  isVideo, parseMovie, detectQuality, groupKey,
  parseEpisode, showFromFilename, cleanShowName, showKey
} from './parse.js';

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

// Scan every library. Movie libraries → logical movies + files (grouped by
// title+year). TV libraries → shows + episodes (grouped by show name, with
// season/episode parsed from filenames and Season folders).
export function scanLibraries(db) {
  const libs = db.prepare('SELECT id, path, type FROM libraries').all();

  // Movie statements
  const fileExists = db.prepare('SELECT id FROM movie_files WHERE path = ?');
  const findMovie = db.prepare('SELECT id FROM movies WHERE group_key = ?');
  const insMovie = db.prepare('INSERT INTO movies (group_key, title, year, added_at) VALUES (?, ?, ?, ?)');
  const insFile = db.prepare(
    `INSERT OR IGNORE INTO movie_files (movie_id, library_id, path, filename, quality, size, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  // TV statements
  const epExists = db.prepare('SELECT id FROM episodes WHERE path = ?');
  const findShow = db.prepare('SELECT id FROM shows WHERE group_key = ?');
  const insShow = db.prepare('INSERT INTO shows (group_key, title, library_id, added_at) VALUES (?, ?, ?, ?)');
  const insEp = db.prepare(
    `INSERT OR IGNORE INTO episodes (show_id, library_id, path, filename, season, episode, quality, size, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const SEASON_FOLDER = /^(season\s*\d+|s\d{1,2}|specials)$/i;

  let added = 0, seen = 0;
  for (const lib of libs) {
    const root = path.resolve(lib.path);

    if (lib.type === 'movie') {
      walk(root, (full, stat) => {
        const name = path.basename(full);
        if (!isVideo(name)) return;
        seen++;
        if (fileExists.get(full)) return;
        const { title, year } = parseMovie(name);
        const key = groupKey(title, year);
        const existing = findMovie.get(key);
        const movieId = existing ? existing.id : insMovie.run(key, title, year, Date.now()).lastInsertRowid;
        insFile.run(movieId, lib.id, full, name, detectQuality(name), stat.size, Date.now());
        added++;
      });
    } else if (lib.type === 'tv') {
      walk(root, (full, stat) => {
        const name = path.basename(full);
        if (!isVideo(name)) return;
        seen++;
        if (epExists.get(full)) return;

        const rel = path.relative(root, full);
        const segs = rel.split(path.sep).slice(0, -1); // folder segments only
        const ep = parseEpisode(name, segs);
        if (!ep) return; // couldn't identify an episode — skip

        // Show name: the top folder under the library, unless that's a Season
        // folder (user pointed at a single show) — then use filename/lib name.
        let showNameRaw;
        if (segs.length && !SEASON_FOLDER.test(segs[0])) showNameRaw = segs[0];
        else showNameRaw = showFromFilename(name) || path.basename(root);

        const showName = cleanShowName(showNameRaw);
        const key = showKey(showName);
        if (!key) return;

        const existingShow = findShow.get(key);
        const showId = existingShow ? existingShow.id : insShow.run(key, showName, lib.id, Date.now()).lastInsertRowid;
        insEp.run(showId, lib.id, full, name, ep.season, ep.episode, detectQuality(name), stat.size, Date.now());
        added++;
      });
    }
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

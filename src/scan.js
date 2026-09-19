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
// Async: the directory walk yields to the event loop between folders, so a
// rescan of a big library never freezes active streams (the same class of bug
// as the synchronous check-update git fetch that stuttered playback).
export async function scanLibraries(db) {
  const libs = db.prepare('SELECT id, path, type FROM libraries').all();

  // Movie statements
  // An already-known path is not skipped blindly: the file behind it can change.
  // When a damaged copy was replaced by a surviving smaller one at the same path,
  // the row kept the old size - Ready Player One read 78.2 GB for a 6.8 GB file -
  // and everything that trusts the size (the optimizer's savings, gap reports)
  // was wrong. The size is refreshed whenever it no longer matches the disk.
  const fileExists = db.prepare('SELECT id, size FROM movie_files WHERE path = ?');
  const setMovieSize = db.prepare('UPDATE movie_files SET size = ? WHERE id = ?');
  const findMovie = db.prepare('SELECT id FROM movies WHERE group_key = ?');
  const insMovie = db.prepare('INSERT INTO movies (group_key, title, year, added_at) VALUES (?, ?, ?, ?)');
  const insFile = db.prepare(
    `INSERT OR IGNORE INTO movie_files (movie_id, library_id, path, filename, quality, size, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  // TV statements
  const epFileExists = db.prepare('SELECT id, size FROM episode_files WHERE path = ?');
  const setEpSize = db.prepare('UPDATE episode_files SET size = ? WHERE id = ?');
  const findShow = db.prepare('SELECT id FROM shows WHERE group_key = ?');
  const insShow = db.prepare('INSERT INTO shows (group_key, title, library_id, added_at) VALUES (?, ?, ?, ?)');
  const findEp = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?');
  const insEp = db.prepare('INSERT INTO episodes (show_id, season, episode, added_at) VALUES (?, ?, ?, ?)');
  const insEpFile = db.prepare(
    `INSERT OR IGNORE INTO episode_files (episode_id, library_id, path, filename, quality, size, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const SEASON_FOLDER = /^(season\s*\d+|s\d{1,2}|specials)$/i;

  let added = 0, seen = 0, refreshed = 0;
  for (const lib of libs) {
    const root = path.resolve(lib.path);

    if (lib.type === 'movie') {
      await walk(root, (full, stat) => {
        const name = path.basename(full);
        if (!isVideo(name)) return;
        seen++;
        const had = fileExists.get(full);
        if (had) {
          if (Number(had.size) !== stat.size) { setMovieSize.run(stat.size, had.id); refreshed++; }
          return;
        }
        let { title, year } = parseMovie(name);
        // If the filename lacked a year (often a generic file inside a nicely
        // named folder like "Inception (2010)\movie.mkv"), use the folder name.
        if (!year) {
          const dir = path.dirname(full);
          if (path.resolve(dir) !== root) {
            const pm = parseMovie(path.basename(dir));
            if (pm.year) { title = pm.title; year = pm.year; }
          }
        }
        const key = groupKey(title, year);
        const existing = findMovie.get(key);
        const movieId = existing ? existing.id : insMovie.run(key, title, year, Date.now()).lastInsertRowid;
        insFile.run(movieId, lib.id, full, name, detectQuality(name), stat.size, Date.now());
        added++;
      });
    } else if (lib.type === 'tv') {
      await walk(root, (full, stat) => {
        const name = path.basename(full);
        if (!isVideo(name)) return;
        seen++;
        const hadEp = epFileExists.get(full);
        if (hadEp) {
          if (Number(hadEp.size) !== stat.size) { setEpSize.run(stat.size, hadEp.id); refreshed++; }
          return;
        }

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

        // One logical episode per show+season+episode; the file is a version of it.
        const existingEp = findEp.get(showId, ep.season, ep.episode);
        const episodeId = existingEp ? existingEp.id : insEp.run(showId, ep.season, ep.episode, Date.now()).lastInsertRowid;
        insEpFile.run(episodeId, lib.id, full, name, detectQuality(name), stat.size, Date.now());
        added++;
      });
    }
  }
  const { removed } = await pruneMissing(db);
  return { added, seen, removed, refreshed };
}

// Remove DB rows for files that were deleted or replaced on disk, then drop any
// logical movie/episode/show left with no files. The files on disk are the
// source of truth. SAFETY: only prune within libraries whose root is currently
// reachable — a temporarily disconnected drive (unplugged USB, offline share)
// must never wipe its whole library.
export async function pruneMissing(db) {
  const libs = db.prepare('SELECT id, path FROM libraries').all();
  const reachable = new Set();
  for (const lib of libs) {
    try {
      if (fs.statSync(path.resolve(lib.path)).isDirectory()) reachable.add(lib.id);
    } catch { /* unreadable/missing root — leave its rows untouched */ }
  }

  // Existence checks are async in batches — thousands of stat calls against a
  // spinning disk must not freeze streams for the duration.
  const missing = async (rows) => {
    const gone = [];
    for (let i = 0; i < rows.length; i += 64) {
      const batch = rows.slice(i, i + 64);
      const checks = await Promise.all(batch.map((f) =>
        reachable.has(f.library_id) ? fs.promises.access(f.path).then(() => false, () => true) : false));
      for (let j = 0; j < batch.length; j++) if (checks[j]) gone.push(batch[j].id);
    }
    return gone;
  };
  let removed = 0;
  const delMovieFile = db.prepare('DELETE FROM movie_files WHERE id = ?');
  for (const id of await missing(db.prepare('SELECT id, path, library_id FROM movie_files').all())) {
    delMovieFile.run(id); removed++;
  }
  const delEpFile = db.prepare('DELETE FROM episode_files WHERE id = ?');
  for (const id of await missing(db.prepare('SELECT id, path, library_id FROM episode_files').all())) {
    delEpFile.run(id); removed++;
  }

  // Entries for working files indexed before the scan learned to skip them.
  // These are not caught above, because the file can still be on disk: an
  // optimizer run stopped mid-encode leaves its temp output behind, and an
  // entry for it plays a half-written file.
  const delWorking = (table) => db.prepare(`DELETE FROM ${table}
    WHERE path LIKE '%.marquee-opt.tmp.%' OR path LIKE '%.replacing' OR path LIKE '%.partial'`).run().changes;
  removed += delWorking('movie_files') + delWorking('episode_files');

  // Drop logical rows that no longer have any files (same cleanup the
  // library-delete handler uses).
  db.prepare('DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM movie_files)').run();
  db.prepare('DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM episode_files)').run();
  db.prepare('DELETE FROM shows WHERE id NOT IN (SELECT DISTINCT show_id FROM episodes)').run();

  // And the probe rows for those files.
  //
  // media_info is keyed on (file_kind, file_id) by convention rather than by a
  // foreign key, so nothing cascades and this step was simply missing: every
  // file that ever vanished left its probe row behind for good. Sixty-five had
  // collected here.
  //
  // They are not harmless clutter. The optimizer plans work from media_info,
  // and so does the pool migration — a row with no file is a phantom entry in
  // both, and in the migration it is a planned move of something that does not
  // exist. This inherits the same protection as the deletions above: a file on
  // an unreachable drive is never counted as missing, so its row survives.
  //
  // media_info belongs to the optimizer and only exists once it has run, so on a
  // fresh install this cleanup has nothing to clean - and must not take the scan
  // down with "no such table", which it did.
  const hasInfo = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_info'").get();
  const orphanedInfo = !hasInfo ? 0 : db.prepare(`
    DELETE FROM media_info
    WHERE (file_kind = 'movie'   AND file_id NOT IN (SELECT id FROM movie_files))
       OR (file_kind = 'episode' AND file_id NOT IN (SELECT id FROM episode_files))`).run().changes;

  return { removed, orphanedInfo };
}

// Folders whose contents are another program's output rather than source media.
//
// "Plex Versions" holds what Plex's "Optimize for TV" produced: a re-encode of
// the episode sitting next to it. Walking into it indexed 127 of those as real
// episodes, so Attack on Titan S03E13 appeared with two files, one a transcode
// of the other — and the transcode was usually the LARGER of the two, so any
// rule that picked by size would have preferred it.
//
// Matched as a whole folder name, never as a substring, so a show called
// "Plex Versions Documentary" would still be scanned.
const GENERATED_DIRS = new Set(['plex versions']);

// Files that exist only while another job is working on them: the optimizer's
// output before it replaces the original, the original parked aside during that
// swap, and a copy still in flight. A scan that lands mid-encode indexed one as
// a real episode - "...S01E02 From The Underground to The Mainstream.marquee-opt.tmp.21360.mu7pwufu.mkv" -
// and the entry was left pointing at nothing once the encode finished.
const WORKING_FILE = /\.marquee-opt\.tmp\.|\.replacing$|\.partial$/i;

async function walk(dir, cb) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing drive — skip quietly
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (GENERATED_DIRS.has(e.name.toLowerCase())) continue;
      await walk(full, cb);
    } else if (e.isFile()) {
      if (WORKING_FILE.test(e.name)) continue;
      let stat;
      try { stat = await fs.promises.stat(full); } catch { continue; }
      cb(full, stat);
    }
  }
}

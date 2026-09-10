// Plex's leftovers.
//
// "Optimize for TV" made Plex re-encode episodes into a copy of its own, kept
// in a `Plex Versions` folder next to the real file. Plex is gone; the folders
// are not. There are 127 of them here, 131 GB, and Marquee's scanner walks
// straight into them and indexes the output as if it were source media — so
// Attack on Titan S03E13 shows up as a real episode with two files, one of
// which is a transcode of the other.
//
// A detail that matters when judging these: 107 of the 127 are BIGGER than the
// file they were made from. That is not a sign they are better. They are second
// generation — an encode of an encode — so the original is the better picture
// at every size. Anyone reading the sizes alone would conclude the opposite,
// which is exactly why the choice of which copy to keep is made on provenance
// here and never on size.
//
// Deleting generated output should be safe by definition. "Should be" is how
// libraries die, so it is proved per file instead: a Plex copy is only ever
// removed while a real file for that same episode is present on disk. If the
// original was ever lost, its Plex copy IS the episode now and is left alone.
import fs from 'node:fs';
import path from 'node:path';

// Plex's own folder name, matched as a whole path segment so a show legitimately
// called "Plex Versions Documentary" could never be caught by it.
export const PLEX_DIR = 'Plex Versions';

export function isPlexVersion(p) {
  return String(p || '').split(/[\\/]/).some((seg) => seg.toLowerCase() === PLEX_DIR.toLowerCase());
}

/**
 * Every indexed Plex transcode, with the real file that justifies removing it.
 *
 * Reports only. `safe` entries have a surviving original; `orphans` do not and
 * are never offered for deletion.
 */
export function findPlexVersions(db) {
  const rows = db.prepare(`
    SELECT ef.id, ef.path, ef.episode_id, mi.size, mi.width, mi.height
    FROM episode_files ef
    LEFT JOIN media_info mi ON mi.file_kind = 'episode' AND mi.file_id = ef.id`).all()
    .filter((r) => isPlexVersion(r.path));

  const safe = [], orphans = [], gone = [];
  for (const r of rows) {
    if (!fs.existsSync(r.path)) { gone.push(r); continue; }
    const keepers = siblingsOf(db, r);
    if (keepers.length) safe.push({ ...r, keep: keepers[0], keepers: keepers.length });
    else orphans.push(r);
  }
  return {
    safe, orphans, gone,
    bytes: safe.reduce((n, r) => n + (Number(r.size) || 0), 0)
  };
}

/** Real (non-Plex) files for the same episode that are actually on disk. */
function siblingsOf(db, row) {
  return db.prepare(`
    SELECT ef.id, ef.path, mi.size, mi.width, mi.height
    FROM episode_files ef
    LEFT JOIN media_info mi ON mi.file_kind = 'episode' AND mi.file_id = ef.id
    WHERE ef.episode_id = ? AND ef.id != ?`).all(row.episode_id, row.id)
    .filter((s) => !isPlexVersion(s.path) && fs.existsSync(s.path))
    .sort((a, b) => Number(b.size) - Number(a.size));
}

/**
 * Is this file safe to delete RIGHT NOW?
 *
 * Re-proved at the moment of deletion rather than trusted from a report, which
 * may have been generated long ago and against a library that has since moved.
 * A stale list must not be able to delete the last copy of an episode.
 */
export function confirmPlexDropSafe(db, fileId) {
  const row = db.prepare(`
    SELECT ef.id, ef.path, ef.episode_id, mi.size
    FROM episode_files ef
    LEFT JOIN media_info mi ON mi.file_kind = 'episode' AND mi.file_id = ef.id
    WHERE ef.id = ?`).get(fileId);

  if (!row) return { ok: false, reason: 'not in the library' };
  if (!isPlexVersion(row.path)) return { ok: false, reason: 'not a Plex Versions file — this only ever removes generated copies' };
  if (!fs.existsSync(row.path)) return { ok: false, reason: 'already gone from disk' };

  const keepers = siblingsOf(db, row);
  if (!keepers.length) {
    return { ok: false, reason: 'this is the only surviving file for that episode — the original must have been lost, so this copy is the episode now' };
  }
  return { ok: true, keeper: keepers[0], reason: null };
}

/**
 * Delete one Plex transcode and forget it.
 *
 * The file goes first and the rows second: a row pointing at a deleted file is
 * a visible, fixable problem, while a deleted row pointing at a file still on
 * disk leaves 131 GB that nothing in the program can see or account for.
 */
export function dropPlexVersion(db, fileId) {
  const check = confirmPlexDropSafe(db, fileId);
  if (!check.ok) return check;

  const row = db.prepare('SELECT id, path FROM episode_files WHERE id = ?').get(fileId);
  const size = (() => { try { return fs.statSync(row.path).size; } catch { return 0; } })();

  try { fs.rmSync(row.path); }
  catch (e) { return { ok: false, reason: 'could not delete: ' + e.message }; }

  db.prepare("DELETE FROM media_info WHERE file_kind = 'episode' AND file_id = ?").run(fileId);
  db.prepare('DELETE FROM episode_files WHERE id = ?').run(fileId);

  return { ok: true, freed: size, path: row.path, keeper: check.keeper.path };
}

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg', '.webm', '.flv', '.divx']);

/**
 * Remove what is left in a Plex Versions folder once its transcodes are gone.
 *
 * Plex extracted every subtitle track of each episode into its own sidecar
 * beside the transcode — 542 .srt files here, belonging to videos that no
 * longer exist. They came OUT of the originals, so the originals still have
 * them; nothing is lost by removing them, and leaving them behind means the
 * folders never go away.
 *
 * The gate is deliberately blunt: if the folder still holds a video, or any
 * file the library is using, nothing is touched and it is reported instead.
 * That way this can never become a general-purpose recursive delete pointed at
 * a media drive — the one shape of mistake that has already cost this library
 * a terabyte.
 */
export function purgePlexLeftovers(dirs, db = null, { log = () => {} } = {}) {
  const purged = [], refused = [];

  const filesIn = (dir) => {
    const out = [];
    const walk = (x) => {
      let e = [];
      try { e = fs.readdirSync(x, { withFileTypes: true }); } catch { return; }
      for (const y of e) {
        const full = path.join(x, y.name);
        if (y.isDirectory()) walk(full); else out.push(full);
      }
    };
    walk(dir);
    return out;
  };

  for (const dir of dirs) {
    if (!isPlexVersion(dir + path.sep + 'x')) { refused.push({ dir, why: 'not a Plex Versions folder' }); continue; }
    const files = filesIn(dir);

    const video = files.filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()));
    if (video.length) { refused.push({ dir, why: `${video.length} video file(s) still here`, files: video.slice(0, 5) }); continue; }

    if (db) {
      const used = files.filter((f) =>
        db.prepare('SELECT 1 FROM episode_files WHERE lower(path) = lower(?)').get(f) ||
        db.prepare('SELECT 1 FROM movie_files WHERE lower(path) = lower(?)').get(f));
      if (used.length) { refused.push({ dir, why: `${used.length} file(s) still in the library`, files: used.slice(0, 5) }); continue; }
    }

    let bytes = 0;
    for (const f of files) { try { bytes += fs.statSync(f).size; } catch {} }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      purged.push({ dir, files: files.length, bytes });
      log(`removed ${dir} (${files.length} leftover file(s))`);
    } catch (e) {
      refused.push({ dir, why: 'could not remove: ' + e.message });
    }
  }
  return { purged, refused };
}

/**
 * Remove the now-empty Plex Versions folders left behind.
 *
 * Only ever empty ones, deepest first, and never a folder that still holds
 * anything at all — an unexpected file in there is a reason to stop and leave
 * it for a person, not to recurse harder.
 */
export function pruneEmptyPlexDirs(roots, { log = () => {} } = {}) {
  const removed = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) visit(path.join(dir, e.name));
    try {
      if (fs.readdirSync(dir).length === 0 && isPlexVersion(dir + path.sep + 'x')) {
        fs.rmdirSync(dir);
        removed.push(dir);
        log('removed empty ' + dir);
      }
    } catch { /* not empty, or in use — leave it */ }
  };
  for (const r of roots) visit(r);
  return removed;
}

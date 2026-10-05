// The scanner: what makes the optimizer work without Marquee.
//
// It is the newest code in the program and it feeds every decision downstream,
// so these tests are mostly about what it must NOT do: index its own temp
// output, walk into a junction loop, resurrect a deleted file out of a recycle
// bin, index Plex's re-encodes as if they were media, or decide that an
// unplugged drive means the library is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureLibrarySchema, syncLibrary, walkMedia, isMedia, isSkippedDir, titleFromPath
} from '../scanner.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
const put = (dir, rel, bytes = 'x'.repeat(2048)) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
};
function freshDb() {
  const db = new DatabaseSync(':memory:');
  ensureLibrarySchema(db);
  db.exec(`CREATE TABLE media_info (file_kind TEXT, file_id INTEGER, path TEXT, size INTEGER,
    PRIMARY KEY (file_kind, file_id))`);
  return db;
}
const paths = (db) => db.prepare('SELECT path FROM movie_files ORDER BY path').all().map((r) => r.path);

test('it finds video files and ignores everything else', () => {
  const dir = tmp();
  put(dir, 'Film (1999).mkv');
  put(dir, 'Show/Season 1/ep.mp4');
  put(dir, 'notes.txt');
  put(dir, 'poster.jpg');
  put(dir, 'Film (1999).srt');
  const found = walkMedia(dir).map((f) => path.basename(f.path)).sort();
  assert.deepEqual(found, ['Film (1999).mkv', 'ep.mp4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("it never indexes the optimizer's own temp output", () => {
  // This is the one that could destroy something: a half-encoded temp file
  // indexed as a library file is a file the optimizer may later treat as the
  // real thing.
  for (const n of [
    'Film (1999).marquee-opt.tmp.14396.abc.mkv',
    'Film (1999).mkv.partial',
    'Film (1999).mkv.replacing',
    '._Film (1999).mkv'
  ]) {
    assert.equal(isMedia(n), false, n);
  }
  assert.equal(isMedia('Film (1999).mkv'), true);
});

test('it does not walk into folders that are not media', () => {
  for (const d of ['Plex Versions', '$RECYCLE.BIN', 'System Volume Information', '@eaDir', '.@__thumb', '#recycle']) {
    assert.equal(isSkippedDir(d), true, d);
  }
  assert.equal(isSkippedDir('Season 1'), false);
  assert.equal(isSkippedDir('Plex Versions Documentary'), false, 'matched as a whole name, not a substring');
});

test("a deleted file in a recycle bin is not resurrected into the library", () => {
  const dir = tmp();
  put(dir, 'Keep (1999).mkv');
  put(dir, '$RECYCLE.BIN/S-1-5-21/Deleted (1998).mkv');
  put(dir, 'Plex Versions/Optimized for TV/Keep (1999).mkv');
  assert.deepEqual(walkMedia(dir).map((f) => path.basename(f.path)), ['Keep (1999).mkv']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a zero-byte file is not media', () => {
  const dir = tmp();
  put(dir, 'Real (1999).mkv');
  put(dir, 'Empty (1999).mkv', '');
  assert.deepEqual(walkMedia(dir).map((f) => path.basename(f.path)), ['Real (1999).mkv']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a symlinked folder is not followed, so a loop cannot hang the scan', () => {
  const dir = tmp();
  put(dir, 'Movies/Film (1999).mkv');
  let linked = false;
  try {
    fs.symlinkSync(dir, path.join(dir, 'Movies', 'loop'), 'junction');
    linked = true;
  } catch { /* needs privilege on some systems; the guard is still asserted below */ }

  // Completes at all, which is the assertion — an followed loop never returns.
  const found = walkMedia(dir);
  assert.equal(found.length, 1);
  if (linked) assert.ok(!found.some((f) => f.path.includes('loop')), 'the link was walked');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- syncLibrary ---------------------------------------------------------

test('new files are added, with a readable title', () => {
  const dir = tmp();
  put(dir, 'The Thing (1982) 2160p UHD BluRay x265-GROUP.mkv');
  const db = freshDb();
  const r = syncLibrary(db, [dir]);
  assert.equal(r.added, 1);
  assert.equal(r.seen, 1);
  assert.equal(db.prepare('SELECT title FROM movies').get().title, 'The Thing (1982)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second scan of unchanged files changes nothing', () => {
  const dir = tmp();
  put(dir, 'Film (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [dir]);
  const again = syncLibrary(db, [dir]);
  assert.deepEqual(
    { added: again.added, updated: again.updated, removed: again.removed },
    { added: 0, updated: 0, removed: 0 }
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 1, 'no duplicate row');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file whose size changed is recorded, so it gets looked at again', () => {
  const dir = tmp();
  const p = put(dir, 'Film (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [dir]);
  fs.writeFileSync(p, 'x'.repeat(9000));
  const r = syncLibrary(db, [dir]);
  assert.equal(r.updated, 1);
  assert.equal(db.prepare('SELECT size FROM movie_files').get().size, 9000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file deleted from disk loses its row and its probe row', () => {
  const dir = tmp();
  const p = put(dir, 'Film (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [dir]);
  const id = db.prepare('SELECT id FROM movie_files').get().id;
  db.prepare("INSERT INTO media_info (file_kind, file_id, path, size) VALUES ('movie',?,?,1)").run(id, p);

  fs.rmSync(p);
  const r = syncLibrary(db, [dir]);
  assert.equal(r.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_info').get().n, 0, 'a probe row with no file is planned against for ever');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AN UNREACHABLE FOLDER NEVER EMPTIES THE LIBRARY', () => {
  // The one that would be unforgivable. Unplugging a drive must not read as
  // "every film on it was deleted" — the rows have to survive untouched.
  const dir = tmp();
  put(dir, 'Film (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [dir]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 1);

  const gone = path.join(String.fromCharCode(92) + String.fromCharCode(92) + 'NO-SUCH-HOST-XYZZY', 'share', 'media');
  const r = syncLibrary(db, [gone]);
  assert.deepEqual(r.skippedFolders, [gone]);
  assert.equal(r.removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 1, 'the library must still be there');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rows outside the folders being scanned are left alone', () => {
  // Two libraries, scanned separately: scanning one must not delete the other.
  const a = tmp(), b = tmp();
  put(a, 'A (1999).mkv');
  put(b, 'B (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [a, b]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 2);

  const r = syncLibrary(db, [a]);               // only the first folder this time
  assert.equal(r.removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 2);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('no folders configured is a no-op, not a wipe', () => {
  const dir = tmp();
  put(dir, 'Film (1999).mkv');
  const db = freshDb();
  syncLibrary(db, [dir]);
  for (const arg of [[], null, undefined, ['']]) {
    const r = syncLibrary(db, arg);
    assert.equal(r.removed, 0, JSON.stringify(arg));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movie_files').get().n, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the tables it creates are the shape the engine already queries', () => {
  // The whole design rests on this: if these match, none of the engine's reads,
  // joins or repoints need changing.
  const db = freshDb();
  const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  for (const c of ['id', 'movie_id', 'path', 'filename', 'size']) assert.ok(cols('movie_files').includes(c), 'movie_files.' + c);
  for (const c of ['id', 'title']) assert.ok(cols('movies').includes(c), 'movies.' + c);
  for (const c of ['id', 'title']) assert.ok(cols('shows').includes(c), 'shows.' + c);
  for (const c of ['id', 'show_id', 'season', 'episode']) assert.ok(cols('episodes').includes(c), 'episodes.' + c);
  for (const c of ['id', 'episode_id', 'path', 'size']) assert.ok(cols('episode_files').includes(c), 'episode_files.' + c);

  // And the engine's actual join must run against them.
  assert.doesNotThrow(() => db.prepare(`
    SELECT mi.*, COALESCE(m.title, s.title) AS title, e.season, e.episode
    FROM media_info mi
    LEFT JOIN movie_files   mf ON mi.file_kind = 'movie'   AND mf.id = mi.file_id
    LEFT JOIN movies        m  ON m.id  = mf.movie_id
    LEFT JOIN episode_files ef ON mi.file_kind = 'episode' AND ef.id = mi.file_id
    LEFT JOIN episodes      e  ON e.id  = ef.episode_id
    LEFT JOIN shows         s  ON s.id  = e.show_id
    WHERE (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all());
});

test('titles are readable without pretending to be metadata', () => {
  assert.equal(titleFromPath('P:\\M\\The Thing (1982) 2160p BluRay x265.mkv'), 'The Thing (1982)');
  assert.equal(titleFromPath('Blade.Runner.2049.2017.1080p.WEB-DL.mkv'), 'Blade Runner 2049 2017');
  assert.equal(titleFromPath('/n/Film.mkv'), 'Film');
  // A name that is nothing BUT a junk token keeps it: the trim only applies to
  // junk after something, so there is still a name on screen rather than a
  // blank row.
  assert.equal(titleFromPath('2160p.mkv'), '2160p');
  // And if trimming would leave nothing at all, the filename is used.
  assert.equal(titleFromPath('- .mkv'), '- .mkv');
  assert.ok(titleFromPath('x').length > 0, 'a title is never empty');
});

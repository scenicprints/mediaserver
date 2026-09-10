// Can this delete something that is not a Plex leftover, or the last copy of
// an episode?
//
// It deletes 131 GB in one pass, so those are the only two questions that
// matter. Real files on disk and real deletions; only the library rows are
// faked, because what is under test is the decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  isPlexVersion, findPlexVersions, confirmPlexDropSafe, dropPlexVersion,
  pruneEmptyPlexDirs, purgePlexLeftovers
} from '../plexversions.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexv-'));
let n = 0;

function world() {
  const dir = path.join(root, 'w' + ++n);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'l.db'));
  db.exec(`
    CREATE TABLE episode_files (id INTEGER PRIMARY KEY, episode_id INTEGER, path TEXT);
    CREATE TABLE movie_files (id INTEGER PRIMARY KEY, movie_id INTEGER, path TEXT);
    CREATE TABLE media_info (file_kind TEXT, file_id INTEGER, path TEXT, size INTEGER, width INTEGER, height INTEGER);
  `);
  let id = 0;
  const add = (episodeId, rel, bytes = 4096) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    const fid = ++id;
    db.prepare('INSERT INTO episode_files (id, episode_id, path) VALUES (?,?,?)').run(fid, episodeId, p);
    db.prepare("INSERT INTO media_info (file_kind, file_id, path, size, width, height) VALUES ('episode',?,?,?,1920,1080)").run(fid, p, bytes);
    return { id: fid, path: p };
  };
  return { dir, db, add };
}

test('a Plex Versions folder is matched as a whole path segment', () => {
  assert.ok(isPlexVersion('F:\\Show\\03\\Plex Versions\\Optimized for TV\\Show\\S03E13.mp4'));
  assert.ok(isPlexVersion('F:/Show/03/Plex Versions/x.mkv'), 'forward slashes too');
  assert.ok(isPlexVersion('F:\\Show\\PLEX VERSIONS\\x.mkv'), 'case-insensitive');
  // The thing a substring match would get wrong.
  assert.ok(!isPlexVersion('F:\\Plex Versions Documentary\\S01E01.mkv'));
  assert.ok(!isPlexVersion('F:\\Show\\My Plex Versions Backup.mkv'));
  assert.ok(!isPlexVersion('F:\\Show\\01\\Show - 1x01.mkv'));
  assert.ok(!isPlexVersion(''));
  assert.ok(!isPlexVersion(null));
});

test('it removes the transcode and keeps the original', () => {
  const w = world();
  const real = w.add(1, 'Show/01/Show - 1x01.mkv', 8192);
  const plex = w.add(1, 'Show/01/Plex Versions/Optimized for TV/Show/S01E01.mp4', 4096);

  const found = findPlexVersions(w.db);
  assert.equal(found.safe.length, 1);
  assert.equal(found.orphans.length, 0);

  const r = dropPlexVersion(w.db, plex.id);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(plex.path), 'the transcode is gone');
  assert.ok(fs.existsSync(real.path), 'THE ORIGINAL MUST SURVIVE');
  // And the library must stop claiming the episode has two files.
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM episode_files WHERE episode_id = 1').get().n, 1);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM media_info WHERE file_id = ?").get(plex.id).n, 0);
});

// The one that would actually lose an episode.
test('a Plex copy that is the ONLY copy is refused', () => {
  const w = world();
  const plex = w.add(7, 'Show/02/Plex Versions/Optimized for TV/Show/S02E01.mp4');

  const found = findPlexVersions(w.db);
  assert.equal(found.safe.length, 0);
  assert.equal(found.orphans.length, 1, 'it must be reported as an orphan, not offered for deletion');

  const check = confirmPlexDropSafe(w.db, plex.id);
  assert.equal(check.ok, false);
  assert.match(check.reason, /only surviving file/);
  const r = dropPlexVersion(w.db, plex.id);
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(plex.path), 'and it must still be there afterwards');
});

// The original row exists but the file itself has gone: still an orphan.
test('a sibling that is only a database row does not count as a surviving copy', () => {
  const w = world();
  const real = w.add(3, 'Show/01/Show - 1x01.mkv');
  const plex = w.add(3, 'Show/01/Plex Versions/S01E01.mp4');
  fs.rmSync(real.path);                      // row remains, file does not

  assert.equal(findPlexVersions(w.db).orphans.length, 1);
  const r = dropPlexVersion(w.db, plex.id);
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(plex.path));
});

// Another Plex copy is not a justification for deleting this Plex copy.
test('two Plex copies of one episode do not justify each other', () => {
  const w = world();
  const a = w.add(5, 'Show/01/Plex Versions/Optimized for TV/S01E01.mp4');
  const b = w.add(5, 'Show/01/Plex Versions/Optimized for Mobile/S01E01.mp4');
  const found = findPlexVersions(w.db);
  assert.equal(found.safe.length, 0);
  assert.equal(found.orphans.length, 2);
  assert.equal(dropPlexVersion(w.db, a.id).ok, false);
  assert.equal(dropPlexVersion(w.db, b.id).ok, false);
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
});

// Nothing outside a Plex Versions folder may be deleted by this, ever.
test('it refuses any file that is not a Plex leftover', () => {
  const w = world();
  const real = w.add(1, 'Show/01/Show - 1x01.mkv');
  w.add(1, 'Show/01/Plex Versions/S01E01.mp4');
  const check = confirmPlexDropSafe(w.db, real.id);
  assert.equal(check.ok, false);
  assert.match(check.reason, /not a Plex Versions file/);
  assert.equal(dropPlexVersion(w.db, real.id).ok, false);
  assert.ok(fs.existsSync(real.path));
});

// Size is not evidence: 107 of the real ones are BIGGER than the file they were
// made from, and keeping the bigger copy would keep the transcode.
test('a Plex copy larger than the original is still the one that goes', () => {
  const w = world();
  const real = w.add(2, 'Show/01/Show - 1x01.mkv', 4096);
  const plex = w.add(2, 'Show/01/Plex Versions/S01E01.mp4', 16384);
  const r = dropPlexVersion(w.db, plex.id);
  assert.equal(r.ok, true, 'provenance decides, not size');
  assert.ok(fs.existsSync(real.path));
  assert.ok(!fs.existsSync(plex.path));
});

test('a stale report cannot delete anything twice', () => {
  const w = world();
  w.add(1, 'Show/01/Show - 1x01.mkv');
  const plex = w.add(1, 'Show/01/Plex Versions/S01E01.mp4');
  assert.equal(dropPlexVersion(w.db, plex.id).ok, true);
  const again = dropPlexVersion(w.db, plex.id);
  assert.equal(again.ok, false);
  assert.match(again.reason, /not in the library/);
});

test('empty Plex folders are pruned, and folders with anything in them are not', () => {
  const w = world();
  const keep = path.join(w.dir, 'Show', '01', 'Plex Versions', 'Optimized for TV');
  fs.mkdirSync(keep, { recursive: true });
  const emptyRoot = path.join(w.dir, 'Show', '02', 'Plex Versions', 'Optimized for TV');
  fs.mkdirSync(emptyRoot, { recursive: true });
  fs.writeFileSync(path.join(keep, 'something-unexpected.txt'), 'x');

  const removed = pruneEmptyPlexDirs([
    path.join(w.dir, 'Show', '01', 'Plex Versions'),
    path.join(w.dir, 'Show', '02', 'Plex Versions')
  ]);
  assert.ok(fs.existsSync(keep), 'a folder still holding a file is left alone');
  assert.ok(!fs.existsSync(emptyRoot), 'an empty one is removed');
  assert.ok(removed.length >= 1);
  // And it must never climb out of a Plex Versions folder.
  assert.ok(fs.existsSync(path.join(w.dir, 'Show', '02')), 'the season folder must survive');
});

// Purging what is left behind is a recursive delete pointed at a media drive,
// which is the exact shape of the mistake that once cost this library 1.29 TiB.
// So the gate matters more than the feature.
test('leftover subtitles are purged once the transcodes are gone', () => {
  const w = world();
  const dir = path.join(w.dir, 'Show', '01', 'Plex Versions');
  const deep = path.join(dir, 'Optimized for TV', 'Show');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'S01E01.eng.srt'), 'sub');
  fs.writeFileSync(path.join(deep, 'S01E01.spa.srt'), 'sub');

  const r = purgePlexLeftovers([dir], w.db);
  assert.equal(r.purged.length, 1);
  assert.equal(r.purged[0].files, 2);
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(w.dir, 'Show', '01')), 'the season folder must survive');
});

test('a folder still holding a video is refused, not purged', () => {
  const w = world();
  const dir = path.join(w.dir, 'Show', '01', 'Plex Versions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'S01E01.eng.srt'), 'sub');
  fs.writeFileSync(path.join(dir, 'S01E01.mp4'), 'video');

  const r = purgePlexLeftovers([dir], w.db);
  assert.equal(r.purged.length, 0);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /video file/);
  assert.ok(fs.existsSync(path.join(dir, 'S01E01.mp4')), 'nothing may be deleted');
  assert.ok(fs.existsSync(path.join(dir, 'S01E01.eng.srt')));
});

test('a folder holding anything the library still uses is refused', () => {
  const w = world();
  const dir = path.join(w.dir, 'Show', '01', 'Plex Versions');
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, 'S01E01.eng.srt');
  fs.writeFileSync(sub, 'sub');
  w.db.prepare('INSERT INTO episode_files (id, episode_id, path) VALUES (999, 1, ?)').run(sub);

  const r = purgePlexLeftovers([dir], w.db);
  assert.equal(r.purged.length, 0);
  assert.match(r.refused[0].why, /still in the library/);
  assert.ok(fs.existsSync(sub));
});

// It must be impossible to point this at a real media folder.
test('it refuses any directory that is not a Plex Versions folder', () => {
  const w = world();
  const real = path.join(w.dir, 'Show', '01');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'Show - 1x01.mkv'), 'video');

  const r = purgePlexLeftovers([real, w.dir, 'F:\\', 'C:\\'], w.db);
  assert.equal(r.purged.length, 0);
  assert.equal(r.refused.length, 4);
  for (const x of r.refused) assert.match(x.why, /not a Plex Versions folder/);
  assert.ok(fs.existsSync(path.join(real, 'Show - 1x01.mkv')));
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

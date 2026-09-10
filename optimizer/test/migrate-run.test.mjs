// Can the migration be interrupted without losing a file?
//
// It will be interrupted. Twenty thousand files across USB disks that have
// already logged IO retries is many hours of work, and the machine reboots,
// the enclosure drops, someone closes the window. So the question is not
// whether it stops mid-flight but what it leaves behind when it does.
//
// The claim these tests exist to check is narrow and absolute: at EVERY point
// in the sequence, killing the process leaves the file readable through the
// library. Not "usually". Not "unless it was mid-copy". Every point.
//
// So rather than testing the happy path, each case here interrupts at a
// specific step and then asserts the two things that actually matter — the
// bytes still exist somewhere, and the library's path points at them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ensureSchema } from '../engine.mjs';
import {
  ensureMigrateSchema, journalPlan, preflight, migrateOne,
  runMigration, migrationStatus, repointLibraries
} from '../migrate.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-run-'));
let n = 0;

// A library of real files under a fake "source drive", with rows pointing at
// them, and a fake "pool" to move them into.
function world({ files = 2, size = 32 * 1024 } = {}) {
  const dir = path.join(root, 'w' + ++n);
  const src = path.join(dir, 'src');
  const pool = path.join(dir, 'pool');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(pool, { recursive: true });

  const db = new DatabaseSync(path.join(dir, 'library.db'));
  ensureSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS movie_files (id INTEGER PRIMARY KEY, movie_id INTEGER, library_id INTEGER, path TEXT, filename TEXT, quality TEXT, size INTEGER, duration REAL, added_at INTEGER);`);
  db.exec(`CREATE TABLE IF NOT EXISTS episode_files (id INTEGER PRIMARY KEY, episode_id INTEGER, library_id INTEGER, path TEXT, filename TEXT, quality TEXT, size INTEGER, added_at INTEGER);`);
  db.exec(`CREATE TABLE IF NOT EXISTS libraries (id INTEGER PRIMARY KEY, path TEXT, type TEXT, name TEXT);`);
  ensureMigrateSchema(db);

  const moves = [];
  for (let i = 1; i <= files; i++) {
    const name = `Film ${i} (200${i}).mkv`;
    const p = path.join(src, name);
    fs.writeFileSync(p, Buffer.alloc(size, i));
    db.prepare('INSERT INTO movie_files (id, movie_id, library_id, path, filename, size) VALUES (?, ?, 1, ?, ?, ?)')
      .run(i, i, p, name, size);
    db.prepare('INSERT INTO media_info (file_kind, file_id, path, size) VALUES (?, ?, ?, ?)')
      .run('movie', i, p, size);
    moves.push({ kind: 'movie', fileId: i, from: p, to: path.join(pool, name) });
  }
  return { dir, src, pool, db, plan: { moves } };
}

// What the library says, and whether it is true.
function reachable(db, fileId) {
  const row = db.prepare('SELECT path FROM movie_files WHERE id = ?').get(fileId);
  const mi = db.prepare("SELECT path FROM media_info WHERE file_kind = 'movie' AND file_id = ?").get(fileId);
  return {
    path: row?.path,
    exists: row?.path ? fs.existsSync(row.path) : false,
    agrees: row?.path === mi?.path
  };
}

test('a completed move leaves the file where the library says it is', async () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  const r = await migrateOne(w.db, row);

  assert.equal(r.state, 'done');
  const f = reachable(w.db, 1);
  assert.ok(f.exists, 'the library must point at a file that exists');
  assert.ok(f.agrees, 'movie_files and media_info must not disagree');
  assert.equal(f.path, path.join(w.pool, 'Film 1 (2001).mkv'));
  assert.ok(!fs.existsSync(path.join(w.src, 'Film 1 (2001).mkv')), 'the source is gone once it is safely copied');
});

// The crash window that matters most: interrupted after the copy but before
// anything was deleted.
test('interrupted after copying: both copies exist and the library still resolves', async () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();

  // Copy and repoint, then stop — exactly the state a kill leaves behind.
  w.db.prepare("UPDATE pool_moves SET state = 'planned' WHERE id = 1").run();
  fs.copyFileSync(row.src, row.dst);
  w.db.prepare('UPDATE movie_files SET path = ? WHERE id = 1').run(row.dst);
  w.db.prepare("UPDATE media_info SET path = ? WHERE file_kind = 'movie' AND file_id = 1").run(row.dst);
  w.db.prepare("UPDATE pool_moves SET state = 'copied' WHERE id = 1").run();

  assert.ok(reachable(w.db, 1).exists, 'still readable while interrupted');

  // Resuming must finish the delete rather than re-copying onto itself.
  const resumed = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  const r = await migrateOne(w.db, resumed);
  assert.equal(r.state, 'done');
  assert.ok(reachable(w.db, 1).exists);
  assert.ok(!fs.existsSync(row.src));
});

// A half-written .partial from a killed copy must not be mistaken for the file.
test('a leftover .partial is never adopted as the copy', async () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  fs.mkdirSync(path.dirname(row.dst), { recursive: true });
  fs.writeFileSync(row.dst + '.partial', Buffer.alloc(9, 0xff));   // truncated junk

  const r = await migrateOne(w.db, row);
  assert.equal(r.state, 'done');
  assert.equal(fs.statSync(row.dst).size, 32 * 1024, 'the real copy, not the stub');
  assert.ok(reachable(w.db, 1).exists);
});

// The destination is occupied. Nothing may be written over it.
test('an occupied destination is refused and the original is kept', async () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  fs.mkdirSync(path.dirname(row.dst), { recursive: true });
  fs.writeFileSync(row.dst, Buffer.alloc(32 * 1024, 0x77));

  const r = await migrateOne(w.db, row);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /refusing to overwrite/);
  assert.ok(fs.existsSync(row.src), 'THE ORIGINAL MUST STILL BE THERE');
  assert.equal(reachable(w.db, 1).path, row.src, 'and the library must still point at it');
});

// The last guard before an irreversible delete: the copy is compared to the
// source byte-for-byte. Nothing else in this suite can make a real copy corrupt
// itself, so the copy is stubbed to land the wrong bytes at the right size —
// the exact failure a size-only check would wave through.
test('a copy with the wrong bytes is destroyed and the original survives', async () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();

  const corrupting = (src, dst) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const buf = fs.readFileSync(src);
    buf[Math.floor(buf.length / 2)] ^= 0xff;      // one flipped byte, same size
    fs.writeFileSync(dst, buf);
    return buf.length;
  };

  const r = await migrateOne(w.db, row, { copyFn: corrupting });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /does not match the source/);
  assert.ok(fs.existsSync(row.src), 'THE ORIGINAL MUST STILL BE THERE');
  assert.ok(!fs.existsSync(row.dst), 'and the bad copy must be gone, not left to be found later');
  assert.equal(reachable(w.db, 1).path, row.src, 'the library must not have been repointed at it');
});

// A flipped byte inside the head/tail sample is caught cheaply. One in the
// middle of a 200 GB file is not — the sampling skips it by design. Full
// verification is what { full: true } is for, and it has to actually work.
test('full verification catches corruption the sampled check would miss', async () => {
  const w = world({ files: 1, size: 4096 });
  journalPlan(w.db, w.plan);
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  const corrupting = (src, dst) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const buf = fs.readFileSync(src);
    buf[2048] ^= 0x01;
    fs.writeFileSync(dst, buf);
  };
  const r = await migrateOne(w.db, row, { copyFn: corrupting, full: true });
  assert.equal(r.state, 'failed');
  assert.ok(fs.existsSync(row.src));
});

test('a failed file does not stop the rest of the run', async () => {
  const w = world({ files: 4 });
  journalPlan(w.db, w.plan);
  // Sabotage the second file by parking something at its destination.
  const bad = w.db.prepare('SELECT * FROM pool_moves WHERE id = 2').get();
  fs.mkdirSync(path.dirname(bad.dst), { recursive: true });
  fs.writeFileSync(bad.dst, Buffer.alloc(10, 0));

  const stats = await runMigration(w.db, { isWatching: async () => false });
  assert.equal(stats.done, 3);
  assert.equal(stats.failed, 1);
  for (const id of [1, 3, 4]) assert.ok(reachable(w.db, id).exists, `file ${id} should have made it`);
  assert.ok(fs.existsSync(bad.src), 'the failed one is still on the source drive');
});

// This check failed open once and a friend's film went choppy. It must treat
// "cannot tell" the same as "yes".
test('it stands down when anyone is watching, and when it cannot tell', async () => {
  for (const answer of [true, null, undefined, 'maybe']) {
    const w = world({ files: 2 });
    journalPlan(w.db, w.plan);
    const stats = await runMigration(w.db, { isWatching: async () => answer });
    assert.equal(stats.done, 0, `must not move a file when isWatching() says ${String(answer)}`);
  }
  const w = world({ files: 2 });
  journalPlan(w.db, w.plan);
  const stats = await runMigration(w.db, { isWatching: async () => { throw new Error('endpoint down'); } });
  assert.equal(stats.done, 0, 'an error asking must not be read as "nobody is watching"');
});

test('a stop request is honoured between files, not mid-file', async () => {
  const w = world({ files: 5 });
  journalPlan(w.db, w.plan);
  let seen = 0;
  const stats = await runMigration(w.db, {
    isWatching: async () => false,
    shouldStop: () => seen >= 2,
    onProgress: () => { seen++; }
  });
  assert.equal(stats.done, 2);
  const st = migrationStatus(w.db);
  assert.equal(st.done, 2);
  assert.equal(st.remaining, 3);
  // Nothing may be left in a torn state.
  const torn = w.db.prepare("SELECT COUNT(*) AS n FROM pool_moves WHERE state = 'copying'").get().n;
  assert.equal(torn, 0);
});

test('journalling refuses to overwrite a run that is part-way through', () => {
  const w = world({ files: 3 });
  journalPlan(w.db, w.plan);
  assert.throws(() => journalPlan(w.db, w.plan), /part-way through/);
  assert.doesNotThrow(() => journalPlan(w.db, w.plan, { replace: true }));
});

test('preflight refuses a pool that is not there', () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const bad = preflight(w.db, { poolRoot: path.join(w.dir, 'no-such-pool') });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join('\n'), /does not exist/);
});

test('preflight refuses when the pool is too small for the library', () => {
  const w = world({ files: 1 });
  journalPlan(w.db, w.plan);
  const tight = preflight(w.db, { poolRoot: w.pool, headroomBytes: 2 ** 60 });
  assert.equal(tight.ok, false);
  assert.match(tight.problems.join('\n'), /free, needs/);
});

test('preflight passes on a sane setup', () => {
  const w = world({ files: 2 });
  journalPlan(w.db, w.plan);
  const ok = preflight(w.db, { poolRoot: w.pool, headroomBytes: 1024 });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.ok, true);
  assert.equal(ok.files, 2);
});

// A library row deleted out from under a file that never moved makes the file
// vanish from Marquee while sitting safely on disk — data loss to the only
// person who can tell, with none of the evidence.
test('an old library root with files left in it is kept, not deleted', async () => {
  const w = world({ files: 2 });
  w.db.prepare("INSERT INTO libraries (id, path, type, name) VALUES (9, ?, 'movie', 'src')").run(w.src);
  w.db.prepare('UPDATE movie_files SET library_id = 9').run();
  journalPlan(w.db, w.plan);

  // Move only one of the two.
  const row = w.db.prepare('SELECT * FROM pool_moves WHERE id = 1').get();
  await migrateOne(w.db, row);

  const map = [[w.src.replace(/\\/g, '/'), w.pool.replace(/\\/g, '/')]];
  const out = repointLibraries(w.db, map);
  const stillThere = w.db.prepare('SELECT COUNT(*) AS n FROM libraries WHERE id = 9').get().n;
  assert.equal(stillThere, 1, 'the old root still holds a file, so it must survive');
  assert.ok(out.kept.length >= 1);
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

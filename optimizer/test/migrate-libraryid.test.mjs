// A repointed row must also change libraries.
//
// The migration used to update only path and filename. That left every moved
// row carrying the id of the library it came from - a library whose root no
// longer contains the file. Harmless looking, until the old library is retired:
// DELETE /api/libraries/:id deletes every movie_files/episode_files row with
// that id, which after the G: evacuation would have been the whole TV library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ensureSchema } from '../engine.mjs';
import { ensureMigrateSchema, journalPlan, migrateOne } from '../migrate.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-libid-'));
let n = 0;

function world() {
  const dir = path.join(root, 'w' + ++n);
  const src = path.join(dir, 'oldroot');
  const pool = path.join(dir, 'pool');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(pool, { recursive: true });

  const db = new DatabaseSync(path.join(dir, 'library.db'));
  ensureSchema(db);
  db.exec('CREATE TABLE IF NOT EXISTS movie_files (id INTEGER PRIMARY KEY, movie_id INTEGER, library_id INTEGER, path TEXT, filename TEXT, quality TEXT, size INTEGER, duration REAL, added_at INTEGER);');
  db.exec('CREATE TABLE IF NOT EXISTS episode_files (id INTEGER PRIMARY KEY, episode_id INTEGER, library_id INTEGER, path TEXT, filename TEXT, quality TEXT, size INTEGER, added_at INTEGER);');
  db.exec('CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY, show_id INTEGER);');
  db.exec('CREATE TABLE IF NOT EXISTS shows (id INTEGER PRIMARY KEY, group_key TEXT, title TEXT, library_id INTEGER, added_at INTEGER);');
  db.exec('CREATE TABLE IF NOT EXISTS libraries (id INTEGER PRIMARY KEY, path TEXT, type TEXT, name TEXT);');
  ensureMigrateSchema(db);
  return { dir, src, pool, db };
}

const put = (dir, name, byte) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(4096, byte));
  return p;
};

test('a moved movie joins the library that owns its new root', async () => {
  const w = world();
  w.db.prepare('INSERT INTO libraries (id, path, type, name) VALUES (?, ?, ?, ?)').run(1, w.src, 'movie', 'old');
  w.db.prepare('INSERT INTO libraries (id, path, type, name) VALUES (?, ?, ?, ?)').run(2, w.pool, 'movie', 'pool');

  const from = put(w.src, 'Film (2001).mkv', 1);
  const to = path.join(w.pool, 'Film (2001).mkv');
  w.db.prepare('INSERT INTO movie_files (id, movie_id, library_id, path, filename, size) VALUES (1, 1, 1, ?, ?, 4096)').run(from, 'Film (2001).mkv');
  w.db.prepare("INSERT INTO media_info (file_kind, file_id, path, size) VALUES ('movie', 1, ?, 4096)").run(from);
  journalPlan(w.db, { moves: [{ kind: 'movie', fileId: 1, from, to }] }, { replace: true });

  const row = w.db.prepare("SELECT * FROM pool_moves WHERE state = 'planned'").get();
  const res = await migrateOne(w.db, row);
  assert.equal(res.state, 'done', res.error);

  const f = w.db.prepare('SELECT path, library_id FROM movie_files WHERE id = 1').get();
  assert.equal(f.path, to);
  assert.equal(Number(f.library_id), 2, 'the row must now belong to the pool library');
});

test('a show follows its episodes only once none are left behind', async () => {
  const w = world();
  w.db.prepare('INSERT INTO libraries (id, path, type, name) VALUES (?, ?, ?, ?)').run(1, w.src, 'tv', 'old');
  w.db.prepare('INSERT INTO libraries (id, path, type, name) VALUES (?, ?, ?, ?)').run(2, w.pool, 'tv', 'pool');
  w.db.prepare('INSERT INTO shows (id, group_key, title, library_id) VALUES (1, ?, ?, 1)').run('show', 'Show');
  w.db.prepare('INSERT INTO episodes (id, show_id) VALUES (1, 1), (2, 1)').run();

  const moves = [];
  for (const i of [1, 2]) {
    const name = `Show - 1x0${i}.mkv`;
    const from = put(w.src, name, i);
    w.db.prepare('INSERT INTO episode_files (id, episode_id, library_id, path, filename, size) VALUES (?, ?, 1, ?, ?, 4096)').run(i, i, from, name);
    w.db.prepare("INSERT INTO media_info (file_kind, file_id, path, size) VALUES ('episode', ?, ?, 4096)").run(i, from);
    moves.push({ kind: 'episode', fileId: i, from, to: path.join(w.pool, name) });
  }
  journalPlan(w.db, { moves }, { replace: true });

  const rows = w.db.prepare("SELECT * FROM pool_moves WHERE state = 'planned' ORDER BY id").all();

  assert.equal((await migrateOne(w.db, rows[0])).state, 'done');
  assert.equal(Number(w.db.prepare('SELECT library_id FROM episode_files WHERE id = 1').get().library_id), 2);
  assert.equal(Number(w.db.prepare('SELECT library_id FROM shows WHERE id = 1').get().library_id), 1,
    'episode 2 is still in the old library, so the show stays put');

  assert.equal((await migrateOne(w.db, rows[1])).state, 'done');
  assert.equal(Number(w.db.prepare('SELECT library_id FROM shows WHERE id = 1').get().library_id), 2,
    'the last episode has landed, so the show moves too');
});

test('with no library owning the destination, the id is left alone', async () => {
  const w = world();
  w.db.prepare('INSERT INTO libraries (id, path, type, name) VALUES (?, ?, ?, ?)').run(1, w.src, 'movie', 'old');

  const from = put(w.src, 'Orphan (2009).mkv', 7);
  const to = path.join(w.pool, 'Orphan (2009).mkv');
  w.db.prepare('INSERT INTO movie_files (id, movie_id, library_id, path, filename, size) VALUES (1, 1, 1, ?, ?, 4096)').run(from, 'Orphan (2009).mkv');
  w.db.prepare("INSERT INTO media_info (file_kind, file_id, path, size) VALUES ('movie', 1, ?, 4096)").run(from);
  journalPlan(w.db, { moves: [{ kind: 'movie', fileId: 1, from, to }] }, { replace: true });

  const row = w.db.prepare("SELECT * FROM pool_moves WHERE state = 'planned'").get();
  assert.equal((await migrateOne(w.db, row)).state, 'done');
  const f = w.db.prepare('SELECT path, library_id FROM movie_files WHERE id = 1').get();
  assert.equal(f.path, to, 'the path still moves');
  assert.equal(Number(f.library_id), 1, 'nothing owns the destination, so the id is untouched');
});

// When a file disappears, does everything about it disappear?
//
// It did not. The scan removed the movie_files / episode_files row and pruned
// the movies, episodes and shows above it — but media_info is keyed on
// (file_kind, file_id) by convention rather than a foreign key, so nothing
// cascaded and the probe row stayed for good. Sixty-five had accumulated in the
// real library.
//
// That matters more than tidiness: the optimizer plans work from media_info and
// so does the pool migration, so a row with no file is a phantom job in one and
// a planned move of nothing in the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// The prune is one statement and the rest of scan() needs a filesystem, real
// libraries and TMDB. The statement is what regressed, so the statement is what
// is tested — kept identical to the one in scan.js.
const PRUNE = `
  DELETE FROM media_info
  WHERE (file_kind = 'movie'   AND file_id NOT IN (SELECT id FROM movie_files))
     OR (file_kind = 'episode' AND file_id NOT IN (SELECT id FROM episode_files))`;

function world() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE movie_files (id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE episode_files (id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE media_info (file_kind TEXT, file_id INTEGER, path TEXT);
  `);
  return db;
}
const infoCount = (db) => db.prepare('SELECT COUNT(*) n FROM media_info').get().n;

test('a probe row whose file row is gone is removed', () => {
  const db = world();
  db.exec(`INSERT INTO movie_files (id, path) VALUES (1, 'H:\\Movies\\Kept.mkv')`);
  db.exec(`INSERT INTO media_info VALUES ('movie', 1, 'H:\\Movies\\Kept.mkv')`);
  db.exec(`INSERT INTO media_info VALUES ('movie', 2, 'H:\\Movies\\Vanished.mkv')`);

  assert.equal(db.prepare(PRUNE).run().changes, 1);
  assert.equal(infoCount(db), 1);
  assert.equal(db.prepare('SELECT file_id FROM media_info').get().file_id, 1);
});

test('episodes are pruned on their own table, not the movie one', () => {
  const db = world();
  db.exec(`INSERT INTO episode_files (id, path) VALUES (7, 'F:\\Show\\S01E01.mkv')`);
  // Same id as the surviving episode, but a movie — must not be saved by it.
  db.exec(`INSERT INTO media_info VALUES ('episode', 7, 'F:\\Show\\S01E01.mkv')`);
  db.exec(`INSERT INTO media_info VALUES ('episode', 8, 'F:\\Show\\S01E02.mkv')`);
  db.exec(`INSERT INTO media_info VALUES ('movie', 7, 'H:\\Movies\\Nope.mkv')`);

  db.prepare(PRUNE).run();
  // Compared as strings: node:sqlite hands back null-prototype rows, which
  // deepEqual rejects on the prototype rather than on anything that matters.
  const left = db.prepare('SELECT file_kind, file_id FROM media_info ORDER BY file_kind, file_id')
    .all().map((r) => `${r.file_kind}:${r.file_id}`);
  assert.deepEqual(left, ['episode:7']);
});

// The prune must never touch a row that still has its file.
test('nothing with a live file row is removed', () => {
  const db = world();
  for (let i = 1; i <= 40; i++) {
    db.prepare('INSERT INTO movie_files (id, path) VALUES (?, ?)').run(i, `H:\\Movies\\m${i}.mkv`);
    db.prepare('INSERT INTO media_info VALUES (?, ?, ?)').run('movie', i, `H:\\Movies\\m${i}.mkv`);
  }
  assert.equal(db.prepare(PRUNE).run().changes, 0);
  assert.equal(infoCount(db), 40);
});

test('running it twice changes nothing the second time', () => {
  const db = world();
  db.exec(`INSERT INTO movie_files (id, path) VALUES (1, 'a.mkv')`);
  db.exec(`INSERT INTO media_info VALUES ('movie', 1, 'a.mkv'), ('movie', 2, 'b.mkv'), ('movie', 3, 'c.mkv')`);
  assert.equal(db.prepare(PRUNE).run().changes, 2);
  assert.equal(db.prepare(PRUNE).run().changes, 0);
  assert.equal(infoCount(db), 1);
});

// A file_kind the prune does not know about is left alone rather than deleted,
// so adding a new kind later cannot silently wipe its rows.
test('an unrecognised file_kind is left alone', () => {
  const db = world();
  db.exec(`INSERT INTO media_info VALUES ('something-else', 99, 'x.mkv')`);
  assert.equal(db.prepare(PRUNE).run().changes, 0);
  assert.equal(infoCount(db), 1);
});

test('an empty library prunes to empty without error', () => {
  const db = world();
  db.exec(`INSERT INTO media_info VALUES ('movie', 1, 'a.mkv'), ('episode', 1, 'b.mkv')`);
  assert.equal(db.prepare(PRUNE).run().changes, 2);
  assert.equal(infoCount(db), 0);
});

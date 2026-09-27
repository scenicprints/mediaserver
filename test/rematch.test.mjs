// The re-check rewrites metadata on the production library, so what it must
// never do is as important as what it fixes: a title the matcher can't place
// keeps its match, and every change it makes can be put back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rematchMovies } from '../src/rematch.js';

function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE movies (id INTEGER PRIMARY KEY, title TEXT, year INTEGER, tmdb_id INTEGER, overview TEXT,
    poster TEXT, backdrop TEXT, rating REAL, genres TEXT, runtime INTEGER, collection_id INTEGER,
    collection_name TEXT, collection_poster TEXT, companies TEXT, col_checked INTEGER)`);
  const ins = db.prepare('INSERT INTO movies VALUES (?, ?, ?, ?, ?, ?, NULL, 8, ?, 88, 94032, ?, NULL, ?, 1)');
  // The reported case: all three wearing the 1994 film's match.
  ins.run(1, 'Lion', 2016, 8587, 'Simba...', 'lk94.jpg', '["Animation"]', 'The Lion King Collection', '[2]');
  ins.run(2, 'The Lion King', 1994, 8587, 'Simba...', 'lk94.jpg', '["Animation"]', 'The Lion King Collection', '[2]');
  ins.run(3, 'The Lion King', 2019, 8587, 'Simba...', 'lk94.jpg', '["Animation"]', 'The Lion King Collection', '[2]');
  ins.run(4, 'Obscure Film', 1971, 555, 'Right all along', 'ob.jpg', '["Drama"]', null, '[]');
  return db;
}

const TMDB = {
  'Lion|2016': { tmdb_id: 334543, overview: 'Saroo...', poster: 'lion.jpg', backdrop: 'lionb.jpg', rating: 8 },
  'The Lion King|1994': { tmdb_id: 8587, overview: 'Simba...', poster: 'lk94.jpg', backdrop: null, rating: 8 },
  'The Lion King|2019': { tmdb_id: 420818, overview: 'Simba again', poster: 'lk19.jpg', backdrop: null, rating: 7 }
};
const search = async (_key, title, year) => TMDB[`${title}|${year}`] || null;

test('wrong matches move to the right film; right ones and unplaceable ones stay', async () => {
  const db = library();
  const { checked, changed } = await rematchMovies(db, 'k', { search, pauseMs: 0 });
  assert.equal(checked, 4);
  assert.deepEqual(changed.map((c) => [c.id, c.to]), [[1, 334543], [3, 420818]]);

  const row = (id) => db.prepare('SELECT * FROM movies WHERE id = ?').get(id);
  assert.equal(row(1).tmdb_id, 334543);
  assert.equal(row(1).poster, 'lion.jpg');
  // Everything that belonged to the old film is cleared for the backfills.
  assert.equal(row(1).genres, null);
  assert.equal(row(1).collection_name, null);
  assert.equal(row(1).col_checked, 0);
  assert.equal(row(2).tmdb_id, 8587);
  assert.equal(row(2).collection_name, 'The Lion King Collection', 'an already-right match is untouched');
  assert.equal(row(4).tmdb_id, 555, '"not sure" never replaces a match');
  assert.equal(row(4).poster, 'ob.jpg');
});

test('every change is logged with the old row, so it can be put back', async () => {
  const db = library();
  await rematchMovies(db, 'k', { search, pauseMs: 0 });
  const log = db.prepare('SELECT * FROM rematch_log ORDER BY movie_id').all();
  assert.equal(log.length, 2);
  const old = JSON.parse(log[0].old_row);
  assert.equal(old.tmdb_id, 8587);
  assert.equal(old.poster, 'lk94.jpg');
});

test('a dry run changes nothing', async () => {
  const db = library();
  const { changed } = await rematchMovies(db, 'k', { search, pauseMs: 0, apply: false });
  assert.equal(changed.length, 2);
  assert.equal(db.prepare('SELECT tmdb_id FROM movies WHERE id = 1').get().tmdb_id, 8587);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rematch_log').get().n, 0);
});

test('an outage part-way stops the pass instead of skipping titles', async () => {
  const db = library();
  let n = 0;
  const flaky = async (...a) => { if (++n === 2) { const e = new Error('offline'); e.offline = true; throw e; } return search(...a); };
  await assert.rejects(rematchMovies(db, 'k', { search: flaky, pauseMs: 0 }), /offline/);
  // The first title was fixed; a rerun finishes the rest and leaves it alone.
  const again = await rematchMovies(db, 'k', { search, pauseMs: 0 });
  assert.deepEqual(again.changed.map((c) => c.id), [3]);
});

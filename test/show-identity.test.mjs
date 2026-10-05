// Two shows with one name ("Doctor Who (1963)" / "(2005)", "The Office (US)" /
// "(UK)") must stay two shows and be matched to two TMDB entries. These pin the
// folder parsing, the repair of a library scanned before that was true, and
// the one-time re-check of old matches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { reconcileShows } from '../src/scan.js';
import { rematchShows } from '../src/rematch.js';
import { showFolderYear, showFolderCountry, showSearchTitle, showKey, showFolderOf } from '../src/parse.js';

test('the folder name gives a year and a country, and the key keeps the year', () => {
  assert.equal(showFolderYear('Doctor Who (2005)'), 2005);
  assert.equal(showFolderYear('Doctor Who'), null);
  assert.equal(showFolderCountry('The Office (US)'), 'US');
  assert.equal(showFolderCountry('The Office (UK)'), 'GB');
  assert.equal(showSearchTitle('The Office (UK)'), 'The Office');
  assert.equal(showKey('Doctor Who', 2005), 'doctor who|2005');
  assert.equal(showKey('Doctor Who'), 'doctor who');
});

test('showFolderOf follows the scanner: the top folder, unless that is a season folder', () => {
  assert.equal(showFolderOf('P:\\TV', 'P:\\TV\\Doctor Who (2005)\\Season 1\\x.mkv'), 'Doctor Who (2005)');
  assert.equal(showFolderOf('P:\\TV\\Severance', 'P:\\TV\\Severance\\Season 1\\Severance.S01E01.mkv'), 'Severance');
});

function library() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shows-')), 'lib.db'));
  db.prepare("INSERT INTO libraries (id, path, type, name) VALUES (1, 'P:\\TV', 'tv', 'TV')").run();
  // As the old scanner left it: both Doctor Whos merged into one show keyed
  // without a year, matched to the 2005 series, with colliding episodes.
  db.prepare("INSERT INTO shows (id, group_key, title, tmdb_id, library_id, added_at) VALUES (1, 'doctor who', 'Doctor Who', 57243, 1, 0)").run();
  const ep = db.prepare('INSERT INTO episodes (id, show_id, season, episode, title, added_at) VALUES (?, 1, ?, ?, ?, 0)');
  const file = db.prepare('INSERT INTO episode_files (episode_id, library_id, path, filename, size, added_at) VALUES (?, 1, ?, ?, 1, 0)');
  ep.run(1, 1, 1, 'Rose'); ep.run(2, 1, 2, 'The End of the World'); ep.run(3, 1, 3, 'The Unquiet Dead');
  file.run(1, 'P:\\TV\\Doctor Who (2005)\\Season 1\\s01e01.mkv', 's01e01.mkv');
  file.run(2, 'P:\\TV\\Doctor Who (2005)\\Season 1\\s01e02.mkv', 's01e02.mkv');
  file.run(3, 'P:\\TV\\Doctor Who (2005)\\Season 1\\s01e03.mkv', 's01e03.mkv');
  file.run(1, 'P:\\TV\\Doctor Who (1963)\\Season 1\\s01e01.mkv', 's01e01.mkv'); // a "version" of Rose
  return db;
}

test('a show merged from two folders is split, and the bigger folder keeps the show', () => {
  const db = library();
  const r = reconcileShows(db);
  assert.deepEqual(r, { rekeyed: 1, split: 1 });
  const shows = db.prepare('SELECT id, group_key, title, folder_year, tmdb_id FROM shows ORDER BY id').all().map((x) => ({ ...x }));
  assert.deepEqual(shows, [
    { id: 1, group_key: 'doctor who|2005', title: 'Doctor Who', folder_year: 2005, tmdb_id: 57243 },
    { id: 2, group_key: 'doctor who|1963', title: 'Doctor Who', folder_year: 1963, tmdb_id: null }
  ]);
  // Rose keeps one file; the 1963 file is now its own show's S01E01.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_files WHERE episode_id = 1').get().n, 1);
  const moved = db.prepare("SELECT e.show_id, e.season, e.episode FROM episode_files f JOIN episodes e ON e.id = f.episode_id WHERE f.path LIKE '%(1963)%'").get();
  assert.deepEqual({ ...moved }, { show_id: 2, season: 1, episode: 1 });
  // And it is a no-op the second time.
  assert.deepEqual(reconcileShows(db), { rekeyed: 0, split: 0 });
});

test('the show re-check moves a wrong match, clears its episodes, and leaves shows with no evidence alone', async () => {
  const db = library();
  reconcileShows(db);
  // Pretend the old matcher put the 2005 folder on the 1963 entry.
  db.prepare('UPDATE shows SET tmdb_id = 121 WHERE id = 1').run();
  db.prepare("INSERT INTO shows (id, group_key, title, tmdb_id, added_at) VALUES (9, 'severance', 'Severance', 95396, 0)").run();
  const asked = [];
  const search = async (_k, title, year, country) => {
    asked.push([title, year, country]);
    return year === 2005 ? { tmdb_id: 57243, overview: 'Rose', poster: 'p', backdrop: 'b', rating: 8, year: 2005 } : null;
  };
  const { changed } = await rematchShows(db, 'k', { search, pauseMs: 0 });
  assert.deepEqual(changed.map((c) => [c.id, c.to]), [[1, 57243]]);
  assert.ok(!asked.some(([t]) => t === 'Severance'), 'a show with no year or country is not re-searched');
  assert.equal(db.prepare('SELECT title FROM episodes WHERE id = 1').get().title, null, 'episode titles are refetched for the right show');
  assert.equal(db.prepare("SELECT kind FROM rematch_log").get().kind, 'show');
});

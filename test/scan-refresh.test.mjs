// Does a rescan see what is actually on disk?
//
// Two ways it did not:
//   - A known path was skipped outright, so when the file behind it changed the
//     row kept the old size. After Sept 8, Ready Player One read 78.2 GB for a
//     file that was 6.8 GB on disk, and every report built on those sizes -
//     including the optimizer's "space to reclaim" - was wrong.
//   - Files that only exist while a job works on them were indexed like media:
//     a scan landing mid-encode added the optimizer's temp output as an episode,
//     which then pointed at nothing once the encode finished.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { scanLibraries } from '../src/scan.js';

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-'));
  const movies = path.join(dir, 'Movies');
  const tv = path.join(dir, 'TV Shows');
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(path.join(tv, 'Hip-Hop Evolution', '01'), { recursive: true });
  const db = openDb(path.join(dir, 'library.db'));
  db.prepare('INSERT INTO libraries (path, type, name) VALUES (?, ?, ?)').run(movies, 'movie', 'Movies');
  db.prepare('INSERT INTO libraries (path, type, name) VALUES (?, ?, ?)').run(tv, 'tv', 'TV Shows');
  return { dir, movies, tv, db };
}

test('a file replaced at the same path gets its new size', async () => {
  const w = world();
  const film = path.join(w.movies, 'Ready Player One (2018).mkv');
  fs.writeFileSync(film, Buffer.alloc(78_000));
  await scanLibraries(w.db);
  assert.equal(Number(w.db.prepare('SELECT size FROM movie_files WHERE path = ?').get(film).size), 78_000);

  // The damaged big copy is gone; a smaller one now sits at the same path.
  fs.writeFileSync(film, Buffer.alloc(6_800));
  const r = await scanLibraries(w.db);
  assert.equal(Number(w.db.prepare('SELECT size FROM movie_files WHERE path = ?').get(film).size), 6_800);
  assert.equal(r.refreshed, 1);
  assert.equal(Number(w.db.prepare('SELECT COUNT(*) n FROM movie_files').get().n), 1, 'refreshed, not duplicated');
});

test('an episode replaced at the same path gets its new size', async () => {
  const w = world();
  const ep = path.join(w.tv, 'Hip-Hop Evolution', '01', 'Hip-Hop Evolution S01E02.mkv');
  fs.writeFileSync(ep, Buffer.alloc(5_000));
  await scanLibraries(w.db);
  fs.writeFileSync(ep, Buffer.alloc(3_000));
  const r = await scanLibraries(w.db);
  assert.equal(Number(w.db.prepare('SELECT size FROM episode_files WHERE path = ?').get(ep).size), 3_000);
  assert.equal(r.refreshed, 1);
});

test('an unchanged file is not rewritten', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.movies, 'Heat (1995).mkv'), Buffer.alloc(1_000));
  await scanLibraries(w.db);
  const r = await scanLibraries(w.db);
  assert.equal(r.refreshed, 0);
});

test("the optimizer's working files are never indexed", async () => {
  const w = world();
  const folder = path.join(w.tv, 'Hip-Hop Evolution', '01');
  fs.writeFileSync(path.join(folder, 'Hip-Hop Evolution S01E02 From The Underground.mkv'), Buffer.alloc(100));
  // The exact shape of the file that got indexed on 2026-09-18.
  fs.writeFileSync(path.join(folder, 'Hip-Hop Evolution S01E02 From The Underground.marquee-opt.tmp.21360.mu7pwufu.mkv'), Buffer.alloc(100));
  fs.writeFileSync(path.join(w.movies, 'Heat (1995).mkv.replacing'), Buffer.alloc(100));
  fs.writeFileSync(path.join(w.movies, 'Heat (1995).mkv.partial'), Buffer.alloc(100));
  await scanLibraries(w.db);
  const eps = w.db.prepare('SELECT path FROM episode_files').all().map((r) => path.basename(r.path));
  assert.deepEqual(eps, ['Hip-Hop Evolution S01E02 From The Underground.mkv']);
  assert.equal(Number(w.db.prepare('SELECT COUNT(*) n FROM movie_files').get().n), 0);
});

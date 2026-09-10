// Can `drop` delete the last copy of something?
//
// It must not, and the report it is driven from is not evidence: the owner acts
// on that list later, possibly much later, possibly after the library has moved
// underneath it. So every guard is re-proved at the moment of deletion, and
// these tests are written from the position that the report is a liar.
//
// Real files on disk, real byte comparison. The only thing faked is the library
// rows, because what is being tested is the decision, not SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ensureSchema } from '../engine.mjs';
import { confirmDropSafe } from '../duplicates.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-drop-'));

// Big enough that the fingerprint's head/tail sampling is exercised rather than
// reading the whole thing as one chunk.
function makeFile(name, seed, mb = 2) {
  const p = path.join(dir, name);
  const buf = Buffer.alloc(mb * 1024 * 1024);
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < buf.length; i += 32) { h = crypto.createHash('sha256').update(h).digest(); h.copy(buf, i); }
  fs.writeFileSync(p, buf);
  return p;
}

function db() {
  const d = new DatabaseSync(path.join(dir, `t${Math.random().toString(36).slice(2)}.db`));
  ensureSchema(d);
  d.exec(`CREATE TABLE IF NOT EXISTS movie_files (id INTEGER PRIMARY KEY, movie_id INTEGER, path TEXT);`);
  return d;
}

let seq = 1;
function addFile(d, p, { width = 1920, height = 1080, vcodec = 'h264', duration = 3600, probe_error = null } = {}) {
  const id = seq++;
  const size = fs.statSync(p).size;
  d.prepare(`INSERT INTO media_info (file_kind, file_id, path, size, mtime, duration, width, height, vcodec, probe_error)
             VALUES ('movie', ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(id, p, size, duration, width, height, vcodec, probe_error);
  d.prepare('INSERT INTO movie_files (id, movie_id, path) VALUES (?, 1, ?)').run(id, p);
  return id;
}

test('a real duplicate is droppable, and names the copy that survives', async () => {
  const d = db();
  const a = makeFile('twin-a.mkv', 'same');
  const b = makeFile('twin-b.mkv', 'same');
  const idA = addFile(d, a), idB = addFile(d, b);

  const r = await confirmDropSafe(d, 'movie', idA);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.keeper.file_id, idB, 'it must say which copy is being kept');
});

test('the LAST copy is never droppable', async () => {
  const d = db();
  const only = makeFile('only.mkv', 'unique');
  const id = addFile(d, only);

  const r = await confirmDropSafe(d, 'movie', id);
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing else|only one/i);
  assert.ok(fs.existsSync(only), 'the file must still be there');
});

test('two files that merely LOOK alike are not duplicates', async () => {
  // The whole reason this feature reads bytes: episodic TV encodes to identical
  // size, duration, resolution and codec. Deleting on metadata destroys episodes.
  const d = db();
  const e1 = makeFile('s20e13.mkv', 'ep13');
  const e2 = path.join(dir, 's20e14.mkv');
  fs.writeFileSync(e2, Buffer.alloc(fs.statSync(e1).size, 7)); // same SIZE, different bytes
  const id1 = addFile(d, e1), id2 = addFile(d, e2);

  const r = await confirmDropSafe(d, 'movie', id1);
  assert.equal(r.ok, false, 'identical metadata must not be enough');
  assert.match(r.reason, /identical bytes|only one/i);
  assert.ok(fs.existsSync(e1) && fs.existsSync(e2));
  assert.ok(id2);
});

test('4K is never dropped as a duplicate, even with a genuine twin', async () => {
  const d = db();
  const a = makeFile('4k-a.mkv', 'uhd');
  const b = makeFile('4k-b.mkv', 'uhd');
  const idA = addFile(d, a, { width: 3840, height: 2160 });
  addFile(d, b, { width: 3840, height: 2160 });

  const r = await confirmDropSafe(d, 'movie', idA);
  assert.equal(r.ok, false, 'the 4K rule must beat a confirmed byte match');
  assert.match(r.reason, /4K/);
});

test('scope 4K counts as 4K here too', async () => {
  // 3840x1606 is 4K by width. Judging on height would call it 1080p and delete it.
  const d = db();
  const a = makeFile('scope-a.mkv', 'scope');
  const b = makeFile('scope-b.mkv', 'scope');
  const idA = addFile(d, a, { width: 3840, height: 1606 });
  addFile(d, b, { width: 3840, height: 1606 });

  const r = await confirmDropSafe(d, 'movie', idA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /4K/);
});

test('a stale report cannot delete anything — the twin is re-checked, not trusted', async () => {
  const d = db();
  const a = makeFile('stale-a.mkv', 'pair');
  const b = makeFile('stale-b.mkv', 'pair');
  const idA = addFile(d, a);
  addFile(d, b);

  assert.equal((await confirmDropSafe(d, 'movie', idA)).ok, true, 'setup: droppable while both exist');

  // The world moves on: the other copy is gone by the time the owner acts.
  fs.rmSync(b);
  const r = await confirmDropSafe(d, 'movie', idA);
  assert.equal(r.ok, false, 'with the twin gone this is now the last copy');
  assert.ok(fs.existsSync(a));
});

test('a file already gone from disk is refused rather than reported as deleted', async () => {
  const d = db();
  const a = makeFile('missing.mkv', 'x');
  const id = addFile(d, a);
  fs.rmSync(a);
  const r = await confirmDropSafe(d, 'movie', id);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already gone/i);
});

test('an unreadable file is refused — it cannot be compared', async () => {
  const d = db();
  const a = makeFile('bad-a.mkv', 'q');
  const b = makeFile('bad-b.mkv', 'q');
  const idA = addFile(d, a, { probe_error: 'Invalid data found when processing input' });
  addFile(d, b);
  const r = await confirmDropSafe(d, 'movie', idA);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot be read/i);
});

test('an id that is not in the library is refused', async () => {
  const r = await confirmDropSafe(db(), 'movie', 999999);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in the library/i);
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

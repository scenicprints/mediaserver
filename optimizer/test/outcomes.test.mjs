// A decision is not a failure.
//
// Two correct outcomes were being recorded as faults, and the window listed them
// under "Stuck · given up on":
//
//   "already plays on every device" — nothing needed doing. It was also absent
//       from isRetryableFailure()'s list, so it was retried three times first and
//       recorded as "gave up after 3 attempts".
//   "VMAF x is below the pass mark" — the quality gate worked. The re-encode was
//       not good enough, so the original was kept.
//
// 802 jobs were sitting in 'failed' on this library; 665 of them were these. The
// owner read that as 800 broken files. Both now land in 'kept', which the Stuck
// list does not select, and which the queue never retries on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stuck, retryStuck, isRetryableFailure, sweepLibraryTemps, originalOf, pidOf } from '../engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'engine.mjs'), 'utf8').split('\r\n').join('\n');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE optimize_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_kind TEXT, file_id INTEGER, profile TEXT,
    state TEXT, path TEXT, error TEXT, attempts INTEGER DEFAULT 0, next_try_at INTEGER,
    pct INTEGER DEFAULT 0, old_size INTEGER, new_size INTEGER, reason TEXT,
    started_at INTEGER, ended_at INTEGER)`);
  db.exec(`CREATE TABLE media_info (
    file_kind TEXT, file_id INTEGER, path TEXT, size INTEGER, mtime INTEGER, duration REAL,
    container TEXT, vcodec TEXT, width INTEGER, height INTEGER, pix_fmt TEXT, hdr INTEGER,
    vkbps INTEGER, acodec TEXT, achannels INTEGER, akbps INTEGER, audio_json TEXT,
    probed_at INTEGER, probe_error TEXT, probe_attempts INTEGER DEFAULT 0,
    PRIMARY KEY (file_kind, file_id))`);
  return db;
}

const addJob = (db, state, error) => db
  .prepare("INSERT INTO optimize_jobs (file_kind, file_id, profile, state, path, error) VALUES ('movie', abs(random()%100000), 'audio', ?, 'X:\\\\f.mkv', ?)")
  .run(state, error);

test('the quality gate records a decision, not a failure', () => {
  // The rejection branch must not write 'failed'; that is the whole bug.
  const i = SRC.indexOf('note(`REJECTED ${path.basename(src)}');
  assert.ok(i > 0, 'the rejection branch moved');
  const branch = SRC.slice(i, i + 1200);   // the branch carries a long comment
  assert.match(branch, /setState\('kept'/, 'a VMAF rejection must be kept, not failed');
  assert.doesNotMatch(branch, /setState\('failed'/);
});

test('a file that already plays everywhere is flagged as nothing-to-do', () => {
  assert.match(SRC, /if \(!plan\.need\) return \{ ok: false, nothingToDo: true/,
    'planAddAudio saying "no" must be distinguishable from an error');
  const i = SRC.indexOf('if (res.nothingToDo)');
  assert.ok(i > 0, 'the addaudio path does not check nothingToDo');
  assert.match(SRC.slice(i, i + 200), /setState\('kept'/);
});

test('Stuck lists only real faults', () => {
  const db = freshDb();
  addJob(db, 'failed', 'the IO operation had to be retried');
  addJob(db, 'retry', 'not enough free space on P:');
  addJob(db, 'kept', 'kept the original: VMAF 94.80 is below the 95 pass mark');
  addJob(db, 'kept', 'already plays on every device');
  addJob(db, 'done', null);
  addJob(db, 'skipped', 'no longer worth optimizing');

  const s = stuck(db);
  assert.equal(s.jobs.length, 2, 'only the two genuine faults belong here');
  for (const j of s.jobs) assert.ok(['failed', 'retry'].includes(j.state));
});

test('the queue does not quietly retry a kept file, but --judged still can', () => {
  const db = freshDb();
  addJob(db, 'kept', 'kept the original: VMAF 94.80 is below the 95 pass mark');
  addJob(db, 'failed', 'not enough free space on P:');

  // Plain retry: the I/O error is worth another go, the judgement is not.
  const plain = retryStuck(db, {});
  assert.equal(plain.jobs, 1, 'only the retryable fault should be requeued');
  assert.equal(db.prepare("SELECT state FROM optimize_jobs WHERE error LIKE 'kept%'").get().state, 'kept');

  // --judged is exactly "reconsider what you judged", e.g. after lowering the bar.
  const judged = retryStuck(db, { includeJudged: true });
  assert.equal(judged.jobs, 1, 'the kept file must be reachable from --judged');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM optimize_jobs WHERE state = \'queued\'').get().n, 2);
});

test('a quality rejection is never treated as worth retrying on its own', () => {
  assert.equal(isRetryableFailure('verification failed: VMAF 94.80 is below the 95 pass mark'), false);
  // The world being unreliable, on the other hand, is worth another go. Note
  // "cannot stat source" is deliberately NOT in this category — it means the
  // file moved, not that the disk hiccupped.
  assert.equal(isRetryableFailure('not enough free space on P:'), true);
  assert.equal(isRetryableFailure('cannot stat source: EIO'), false);
});

// ---- the library-wide temp sweep ----------------------------------------

test('the sweep clears a leftover whose original is still there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const orig = path.join(dir, 'Film (1999).mkv');
  const tmp = path.join(dir, 'Film (1999).marquee-opt.tmp.999999.abc.mkv');
  fs.writeFileSync(orig, 'original');
  fs.writeFileSync(tmp, 'leftover');

  const db = freshDb();
  db.prepare('INSERT INTO media_info (file_kind, file_id, path) VALUES (?,?,?)').run('movie', 1, orig);

  const r = sweepLibraryTemps(db, {});
  assert.equal(r.cleared, 1);
  assert.equal(fs.existsSync(tmp), false, 'the leftover should be gone');
  assert.equal(fs.existsSync(orig), true, 'the original must be untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sweep KEEPS a temp whose original is gone — it is the only copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const orig = path.join(dir, 'Film (1999).mkv');
  const tmp = path.join(dir, 'Film (1999).marquee-opt.tmp.999999.abc.mkv');
  fs.writeFileSync(tmp, 'the only copy');          // no original beside it

  const db = freshDb();
  db.prepare('INSERT INTO media_info (file_kind, file_id, path) VALUES (?,?,?)').run('movie', 1, orig);

  const r = sweepLibraryTemps(db, {});
  assert.equal(r.cleared, 0);
  assert.equal(r.orphans.length, 1);
  assert.equal(fs.existsSync(tmp), true, 'deleting this is the data loss the sweep exists to clean up after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sweep never touches this process\'s own in-flight encode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const orig = path.join(dir, 'Film (1999).mkv');
  const mine = path.join(dir, `Film (1999).marquee-opt.tmp.${process.pid}.abc.mkv`);
  fs.writeFileSync(orig, 'original');
  fs.writeFileSync(mine, 'being written right now');

  const db = freshDb();
  db.prepare('INSERT INTO media_info (file_kind, file_id, path) VALUES (?,?,?)').run('movie', 1, orig);

  const r = sweepLibraryTemps(db, {});
  assert.equal(r.cleared, 0, 'its original exists, so only the pid check can save it');
  assert.equal(fs.existsSync(mine), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pidOf and originalOf read the name the encoder writes', () => {
  const p = 'P:\\Movies\\Film (1999).marquee-opt.tmp.14396.muqd4uma.mkv';
  assert.equal(pidOf(p), 14396);
  assert.equal(originalOf(p), 'P:\\Movies\\Film (1999).mkv');
  assert.equal(pidOf('P:\\Movies\\Film (1999).mkv'), null);
});

test('the VMAF message reports enough precision to be believable', () => {
  const vmaf = fs.readFileSync(path.join(HERE, '..', 'vmaf.mjs'), 'utf8');
  // "VMAF 95.0 is below the 95 pass mark" was true (94.95) and read as a bug.
  assert.match(vmaf, /VMAF \$\{mean\.toFixed\(2\)\} is below/);
});

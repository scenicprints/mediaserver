// Does the program give up correctly?
//
// Two failures used to be permanent and silent: a job that failed sat in
// 'failed' for ever because the queue only ever selected 'queued', and a file
// that failed to probe was never read again because the scanner only re-reads
// when size or mtime changes. Both dropped out of the program's attention
// entirely, so the only way to find them was for a person to go looking — which
// is exactly the thing the program exists to avoid.
//
// The fix has to be bounded in the other direction too. One attempt at a 75 GB
// remux is a full read and a full write of a tired USB disk, so "retry until it
// works" is its own kind of broken. These tests pin both edges: it must try
// again, and it must stop trying.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ensureSchema, isRetryableFailure, stuck, retryStuck } from '../engine.mjs';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-retry-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  ensureSchema(db);
  return { db, dir };
}

const addJob = (db, { state = 'failed', error = null, attempts = 0, profile = 'audio', path: p = 'X:/f.mkv' } = {}) => {
  db.prepare(`INSERT INTO optimize_jobs (file_kind, file_id, profile, state, path, error, attempts, created_at)
              VALUES ('movie', abs(random() % 100000), ?, ?, ?, ?, ?, ?)`)
    .run(profile, state, p, error, attempts, Date.now());
  return db.prepare('SELECT last_insert_rowid() id').get().id;
};

// ---- What is worth trying again ---------------------------------------

test('a drive that hiccuped is worth another go', () => {
  // The real one, verbatim from the Apocalypse Now job.
  assert.equal(isRetryableFailure('[out#0/matroska] Error closing file: Invalid argument'), true);
  assert.equal(isRetryableFailure('Input/output error'), true);
  assert.equal(isRetryableFailure('not enough free space on H: (needs ~75.0 GB to work safely)'), true);
  assert.equal(isRetryableFailure('timed out'), true);
});

test('a judgement is not worth trying again', () => {
  // Re-running an identical encode reaches an identical verdict and costs
  // another hour of the machine.
  assert.equal(isRetryableFailure('verification failed: VMAF 91.2 is below the 95 pass mark'), false);
  assert.equal(isRetryableFailure('verification failed: output is not smaller (2.10 GB vs 2.05 GB)'), false);
  assert.equal(isRetryableFailure('worst scene scored VMAF 88.0, below the 90 floor'), false);
});

test('a file that is gone or changed belongs to the scanner, not the retry loop', () => {
  assert.equal(isRetryableFailure('source file is gone'), false);
  assert.equal(isRetryableFailure('file changed since it was probed — rescan and requeue'), false);
  assert.equal(isRetryableFailure('file no longer in the library'), false);
});

test('an empty reason is not a licence to retry for ever', () => {
  assert.equal(isRetryableFailure(''), false);
  assert.equal(isRetryableFailure(null), false);
  assert.equal(isRetryableFailure(undefined), false);
});

// ---- Reporting ---------------------------------------------------------

test('stuck() shows what is waiting and what was given up on, separately', () => {
  const { db } = freshDb();
  addJob(db, { state: 'retry', error: 'Input/output error', attempts: 1 });
  addJob(db, { state: 'failed', error: 'verification failed: VMAF 90.1 is below the 95 pass mark' });
  addJob(db, { state: 'done' });
  addJob(db, { state: 'queued' });

  const s = stuck(db);
  assert.equal(s.jobs.length, 2, 'done and queued jobs are not stuck');
  assert.equal(s.jobs.filter((j) => j.state === 'retry').length, 1);
  assert.equal(s.jobs.filter((j) => j.state === 'failed').length, 1);
});

test('stuck() reports unreadable files too', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO media_info (file_kind, file_id, path, probe_error, probe_attempts)
              VALUES ('episode', 1, 'F:/x.mkv', 'No such file or directory', 2)`).run();
  db.prepare(`INSERT INTO media_info (file_kind, file_id, path, probe_error)
              VALUES ('movie', 2, 'G:/ok.mkv', NULL)`).run();

  const s = stuck(db);
  assert.equal(s.probes.length, 1, 'a file that probes fine is not stuck');
  assert.equal(s.probes[0].attempts, 2);
  assert.match(s.probes[0].probe_error, /No such file/);
});

// ---- Putting it back ---------------------------------------------------

test('retry requeues the transient failures and leaves the judgements alone', () => {
  const { db } = freshDb();
  const io = addJob(db, { state: 'failed', error: 'Error closing file: Invalid argument', attempts: 3 });
  const judged = addJob(db, { state: 'failed', error: 'verification failed: VMAF 90.1 is below the 95 pass mark' });

  const r = retryStuck(db);
  assert.equal(r.jobs, 1, 'exactly one job should have been requeued');

  const get = (id) => db.prepare('SELECT state, attempts, error FROM optimize_jobs WHERE id = ?').get(id);
  assert.equal(get(io).state, 'queued');
  assert.equal(get(io).attempts, 0, 'a requeued job starts its attempt count again');
  assert.equal(get(io).error, null);
  assert.equal(get(judged).state, 'failed', 'a rejected encode is not silently retried');
});

test('retry --judged reconsiders a rejected encode, but only when asked', () => {
  const { db } = freshDb();
  const judged = addJob(db, { state: 'failed', error: 'verification failed: VMAF 90.1 is below the 95 pass mark' });
  assert.equal(retryStuck(db).jobs, 0);
  assert.equal(retryStuck(db, { includeJudged: true }).jobs, 1);
  assert.equal(db.prepare('SELECT state FROM optimize_jobs WHERE id = ?').get(judged).state, 'queued');
});

test('retry by id overrides the program on that one job', () => {
  const { db } = freshDb();
  const judged = addJob(db, { state: 'failed', error: 'verification failed: VMAF 90.1 is below the 95 pass mark' });
  const other = addJob(db, { state: 'failed', error: 'Input/output error' });

  const r = retryStuck(db, { id: judged });
  assert.equal(r.jobs, 1);
  assert.equal(db.prepare('SELECT state FROM optimize_jobs WHERE id = ?').get(judged).state, 'queued');
  assert.equal(db.prepare('SELECT state FROM optimize_jobs WHERE id = ?').get(other).state, 'failed',
    'an id-targeted retry must not touch anything else');
});

test('a "gave up after N attempts" job is still recognisably transient', () => {
  const { db } = freshDb();
  const id = addJob(db, { state: 'failed', attempts: 3, error: 'gave up after 3 attempts: Input/output error' });
  assert.equal(retryStuck(db).jobs, 1, 'the give-up prefix must not hide the real reason');
  assert.equal(db.prepare('SELECT state FROM optimize_jobs WHERE id = ?').get(id).state, 'queued');
});

test('retry clears the probe counters so unreadable files get read again', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO media_info (file_kind, file_id, path, probe_error, probe_attempts)
              VALUES ('episode', 1, 'F:/x.mkv', 'boom', 3)`).run();
  const r = retryStuck(db);
  assert.equal(r.probes, 1);
  assert.equal(db.prepare('SELECT probe_attempts a FROM media_info WHERE file_id = 1').get().a, 0);
});

// ---- The migration -----------------------------------------------------

test('ensureSchema adds the new columns to an existing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-mig-'));
  const db = new DatabaseSync(path.join(dir, 'old.db'));
  // The schema as it was before any of this existed.
  db.exec(`CREATE TABLE optimize_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, file_kind TEXT NOT NULL,
    file_id INTEGER NOT NULL, profile TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', path TEXT,
    old_size INTEGER, new_size INTEGER, old_summary TEXT, new_summary TEXT, reason TEXT, error TEXT,
    pct REAL DEFAULT 0, created_at INTEGER, started_at INTEGER, ended_at INTEGER);`);
  db.exec(`CREATE TABLE media_info (file_kind TEXT NOT NULL, file_id INTEGER NOT NULL, path TEXT NOT NULL,
    size INTEGER, mtime INTEGER, probe_error TEXT, PRIMARY KEY (file_kind, file_id));`);
  db.prepare(`INSERT INTO optimize_jobs (file_kind, file_id, profile, state) VALUES ('movie', 1, 'audio', 'failed')`).run();

  ensureSchema(db);
  ensureSchema(db); // must be safe to run repeatedly

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('optimize_jobs').includes('attempts'));
  assert.ok(cols('optimize_jobs').includes('next_try_at'));
  assert.ok(cols('media_info').includes('probe_attempts'));
  // The row that was already there survives, and reads as never-attempted.
  const row = db.prepare('SELECT state, attempts FROM optimize_jobs WHERE file_id = 1').get();
  assert.equal(row.state, 'failed');
  assert.equal(row.attempts ?? 0, 0);
});

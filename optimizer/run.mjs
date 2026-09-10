// The optimizer. A separate program from the media server.
//
// It shares Marquee's SQLite database — it has to, or a file it rewrites would
// leave the library pointing at something that no longer exists — and it asks
// Marquee over HTTP whether anyone is watching before it does anything. Beyond
// that the two are independent: separate process, separate code, separate logs.
// A crash here cannot take down playback.
//
// HOW IT IS MEANT TO RUN. Once over the existing library, then only over what
// arrives afterwards. Probe results are cached against each file's size and
// mtime, so a second pass costs almost nothing and re-examines nothing: the
// first run does the work, every run after it looks at new content only.
//
//   node optimizer/run.mjs status      what it knows and what is pending
//   node optimizer/run.mjs scan        probe anything new (safe, read-only)
//   node optimizer/run.mjs plan        what it would do, changes nothing
//   node optimizer/run.mjs work [N]    do up to N jobs, then stop
//   node optimizer/run.mjs watch       stay running; handle new content as it lands
//   node optimizer/run.mjs duplicates  find real duplicates and recommend which
//                                      copy to keep. Reports only, never deletes.
//   node optimizer/run.mjs drop <k:id> [...]  delete a copy the report named, after
//                                      proving all over again that an identical
//                                      twin still exists. This is the only part
//                                      of the program that deletes on request.
//   node optimizer/run.mjs stuck       what it has given up on and why
//   node optimizer/run.mjs retry [id]  put stuck work back in the queue. With no
//                                      id, everything that failed for a reason
//                                      that might not recur; --judged also
//                                      reconsiders encodes rejected on quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as ff from './ffmpeg.mjs';
import * as engine from './engine.mjs';
import { findDuplicates, confirmDropSafe } from './duplicates.mjs';
import { startUI } from './ui.mjs';
import { writeBadFileList } from './badfiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'status';
const arg = Number(process.argv[3]) || 0;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---- The log survives the window --------------------------------------
//
// This runs unattended, for weeks, in a console window nobody is watching. Up
// to now that window WAS the log: close it, or reboot, and every decision it
// made went with it. That is the wrong property for the one program on this
// machine that deletes things, and after 2026-09-08 it is the wrong property
// twice over.
//
// Kept deliberately dumb — append a line, roll the file when it gets big. No
// dependency, nothing to configure, and nothing that can fail in a way that
// stops the actual work: every write is best-effort.
const LOG_FILE = path.join(ROOT, 'data', 'optimizer.log');
const LOG_MAX = 8 * 1024 * 1024;

function logToFile(line) {
  try {
    // Roll once, keeping one generation. Two files of bounded size beats an
    // unbounded one, and beats losing the history entirely.
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch { /* no log yet, or the roll failed — either way, carry on */ }
    fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8');
  } catch { /* logging must never be the thing that stops the work */ }
}

const log = (m) => {
  const line = `[${stamp()}] ${m}`;
  console.log(line);
  logToFile(line);
};
const TB = (b) => (Number(b) / 2 ** 40).toFixed(2) + ' TiB';
const GB = (b) => (Number(b) / 2 ** 30).toFixed(1) + ' GB';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
const db = new DatabaseSync(path.join(ROOT, 'data', 'library.db'));
engine.ensureSchema(db);

// Ask the media server whether anyone is streaming. If it will not answer we
// assume someone IS watching and stand down — the safe direction to be wrong in.
async function someoneWatching() {
  const port = config.port || 8096;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (res.status === 404) return false;      // older server without the endpoint
  } catch {
    return false;                              // server down: nobody is watching it
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/sessions`, { signal: AbortSignal.timeout(3000) });
    if (res.status === 401 || res.status === 403) return null; // cannot tell
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j.sessions) ? j.sessions.length > 0 : !!j.count;
  } catch { return null; }
}

const policy = {
  allow4kVideo: config.optimizeAllow4kVideo === true,
  allowHdrVideo: config.optimizeAllowHdrVideo === true
};

// Pacing. These drives are USB and two of them logged I/O retries under load,
// so the defaults here are deliberately gentle: a minute between files, and the
// run aborts if Windows reports any disk trouble while it is working. Override
// in config.json under "optimizeThrottle" if the drives turn out to be fine.
engine.setThrottle({
  pauseBetweenJobsMs: 60_000,
  // Cap the read at 8x realtime. Uncapped, ffmpeg pulls as hard as the drive
  // allows, which is what made the machine unresponsive twice on 2026-09-08.
  // 8x is still far faster than the encode for any video job, so this costs
  // almost nothing except on pure stream-copies — where the drive is the only
  // thing working and is exactly where the gentleness is wanted.
  readRate: 8,
  stopOnDiskErrors: true,
  maxJobsPerRun: 0,
  ...(config.optimizeThrottle || {})
});

const BAD_LIST = path.join(ROOT, 'data', 'needs-redownload.txt');

async function doScan() {
  const before = db.prepare('SELECT COUNT(*) n FROM media_info').get().n;
  const n = await engine.runProbeScan(db, { log });
  const total = engine.scannableFiles(db).length;
  // Anything unreadable becomes a re-download list a person can act on, kept
  // current on every scan rather than accumulating stale entries.
  const bad = writeBadFileList(db, BAD_LIST);
  if (bad.length) log(bad.length + " file(s) need re-downloading — see " + BAD_LIST);
  log(n ? `probed ${n} file(s) — ${before + n} of ${total} known` : `nothing new (${before} of ${total} already known)`);
  return n;
}

function showPlan() {
  const { items, totals } = engine.analyze(db, policy);
  log(`${totals.files.toLocaleString()} files known, holding ${TB(totals.bytes)}`);
  log(`reclaimable: ${TB(totals.saveBytes)}`);
  for (const [k, v] of Object.entries(totals.byProfile)) log(`  ${k.padEnd(6)} ${String(v.files).padStart(5)} files  ${GB(v.saveBytes)}`);
  const sur = engine.compatibilityCandidates(db);
  log(`${sur.length} file(s) would play better on a TV with an added surround track (${sur.filter((s) => s.hdr).length} of them 4K HDR)`);
  // Printed every run so a regression is loud rather than silent.
  const bad = items.filter((i) => i.tier === '4K' && i.hdr);
  log(`SAFETY: 4K HDR files in the destructive plan: ${bad.length} (must be 0)`);
  if (bad.length) { console.error('SAFETY CHECK FAILED'); process.exit(1); }
  return { items, sur };
}

async function work(limit) {
  const busy = await someoneWatching();
  if (busy === true) { log('someone is watching — standing down'); return 0; }
  if (busy === null) log('could not reach the server to check for viewers; continuing');

  const { items } = engine.analyze(db, policy);
  const profiles = Array.isArray(config.optimizeAutoProfiles) ? config.optimizeAutoProfiles : ['audio'];
  let queued = 0;
  for (const it of items.filter((i) => profiles.includes(i.profile))) {
    if (queued >= limit) break;
    if (engine.enqueue(db, it.kind, it.fileId, policy).jobId) queued++;
  }
  if (profiles.includes('addaudio')) {
    for (const it of engine.compatibilityCandidates(db)) {
      if (queued >= limit) break;
      if (engine.enqueueAddAudio(db, it.kind, it.fileId).jobId) queued++;
    }
  }
  log(`queued ${queued} job(s)`);
  if (!queued) return 0;

  // Stop the moment a viewer appears; the job in flight returns to the queue.
  engine.worker.stop = false;
  const watch = setInterval(async () => { if (await someoneWatching() === true) engine.worker.stop = true; }, 20000);
  try { await engine.runQueue(db, { log, ...policy }); } finally { clearInterval(watch); }
  return queued;
}

// ---- One at a time -----------------------------------------------------
//
// Two optimizers on the same library is the worst case this program has: both
// reading and writing multi-gigabyte files on the same tired USB disks at once,
// which is the exact condition that made this machine unresponsive twice, and
// both picking jobs out of the same queue with no idea the other exists.
//
// It happened for real on 2026-09-09 — a hand-started run and the service, side
// by side — so the program now refuses rather than trusting whoever starts it
// to check first. Read-only commands are unaffected; they touch nothing.
const LOCK = path.join(ROOT, 'data', 'optimizer.lock');
const NEEDS_LOCK = ['work', 'watch'];

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function takeLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (held.pid && held.pid !== process.pid && alive(held.pid)) {
      log(`another optimizer is already running (pid ${held.pid}, started ${new Date(held.at).toLocaleString()}).`);
      log('Refusing to start a second one — two of these on the same drives is how the machine locks up.');
      process.exit(1);
    }
    // The holder is gone; the lock is stale and ours to take.
  } catch { /* no lock, or unreadable: take it */ }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), cmd }), 'utf8');
  const release = () => { try { const h = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (h.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(130); });
}

if (NEEDS_LOCK.includes(cmd)) takeLock();

const st = await ff.detect(ROOT, config);
if (!st.available) { console.error('ffmpeg not found — nothing can run'); process.exit(1); }

if (cmd === 'status') {
  const s = engine.status(db);
  log(`ffmpeg ready, hardware encoding ${st.nvenc ? 'available' : 'NOT available (CPU only)'}`);
  log(`${s.probed} of ${s.scannable} files probed`);
  log(`jobs: ${JSON.stringify(s.jobs)}`);
  log(`reclaimed so far: ${GB(s.reclaimedBytes)}`);
  const stk = engine.stuck(db);
  if (stk.jobs.length || stk.probes.length) {
    log(`stuck: ${stk.jobs.filter((j) => j.state === 'retry').length} awaiting retry, ` +
        `${stk.jobs.filter((j) => j.state === 'failed').length} given up on, ` +
        `${stk.probes.length} unreadable — see "stuck"`);
  }
  const busy = await someoneWatching();
  log(`someone watching: ${busy === null ? 'unknown' : busy}`);
} else if (cmd === 'scan') {
  await doScan();
  showPlan();
} else if (cmd === 'plan') {
  showPlan();
} else if (cmd === 'work') {
  await doScan();
  await work(arg || 5);
} else if (cmd === 'stuck') {
  const { jobs, probes } = engine.stuck(db);
  const waiting = jobs.filter((j) => j.state === 'retry');
  const gaveUp = jobs.filter((j) => j.state === 'failed');

  if (waiting.length) {
    log(`${waiting.length} job(s) waiting to be tried again:`);
    for (const j of waiting) {
      const when = j.next_try_at ? new Date(j.next_try_at).toLocaleString() : 'next run';
      console.log(`  #${j.id} ${path.basename(j.path || '')} — attempt ${j.attempts || 0}/3, due ${when}`);
      console.log(`      ${String(j.error || '').split('\n')[0].slice(0, 160)}`);
    }
  }
  if (gaveUp.length) {
    log(`${gaveUp.length} job(s) it has given up on:`);
    for (const j of gaveUp) {
      console.log(`  #${j.id} ${path.basename(j.path || '')} (${j.profile})`);
      console.log(`      ${String(j.error || '').split('\n')[0].slice(0, 200)}`);
    }
  }
  if (probes.length) {
    log(`${probes.length} file(s) it cannot read:`);
    for (const p of probes) {
      console.log(`  ${path.basename(p.path)} — ${p.attempts} attempt(s)`);
      console.log(`      ${String(p.probe_error || '').split('\n')[0].slice(0, 200)}`);
    }
  }
  if (!jobs.length && !probes.length) log('Nothing stuck.');
  else log('Use "retry" to put these back in the queue.');
} else if (cmd === 'retry') {
  const judged = process.argv.includes('--judged');
  const r = engine.retryStuck(db, { id: arg, includeJudged: judged });
  log(`Requeued ${r.jobs} job(s)${r.probes ? ` and cleared ${r.probes} probe failure(s)` : ''}.`);
  if (!arg && !judged) log('Encodes rejected on quality were left alone — "retry --judged" reconsiders those too.');
  if (r.jobs) log('Run "work" to actually do them.');
} else if (cmd === 'duplicates') {
  log('Metadata alone cannot tell a duplicate from two episodes that encode alike,');
  log('so every candidate is confirmed by reading the bytes. Nothing is deleted.');
  log('');
  const res = await findDuplicates(db, {
    log,
    full: process.argv.includes('--full'),
    onProgress: (n, total) => { if (n % 10 === 0) log(`  checked ${n}/${total} candidate groups`); }
  });
  log('');
  if (!res.confirmed.length) {
    log('No genuine duplicates found.');
  } else {
    let total = 0;
    for (const d of res.confirmed) {
      total += d.reclaimable;
      log(`${GB(d.size)}  ${d.title}${d.note ? '   [' + d.note + ']' : ''}`);
      log(`   KEEP  ${d.keep.r.path}`);
      log(`         (${d.keep.reasons.join(', ') || 'no particular advantage'})`);
      for (const x of d.drop) log(`   DROP  ${x.r.file_kind}:${x.r.file_id}  ${x.r.path}`);
    }
    log('');
    log(`${res.confirmed.length} duplicate group(s), ${GB(total)} reclaimable if you remove the DROP copies.`);
    log('Nothing has been deleted.');
    log('To remove one, pass its id:   node optimizer/run.mjs drop movie:1234');
    log('It is checked again at that point, so an out-of-date list cannot delete the last copy.');
  }
  log(`${res.falsePositives} candidate group(s) turned out to be different files that merely look identical.`);
} else if (cmd === 'drop') {
  // The owner's decision, taken one file at a time and re-proved before it is
  // acted on. Nothing here is automatic and nothing here is bulk.
  const targets = process.argv.slice(3).filter((a) => /^(movie|episode):\d+$/i.test(a));
  if (!targets.length) {
    log('Nothing to do. Pass ids from the duplicates report, e.g.:');
    log('  node optimizer/run.mjs drop movie:1234 episode:5678');
    process.exit(1);
  }
  let freed = 0, gone = 0;
  for (const t of targets) {
    const [kind, idStr] = t.split(':');
    const fileId = parseInt(idStr, 10);
    const row = db.prepare('SELECT path, size FROM media_info WHERE file_kind = ? AND file_id = ?').get(kind, fileId);
    const name = row ? path.basename(row.path) : t;

    const check = await confirmDropSafe(db, kind, fileId, { full: process.argv.includes('--full') });
    if (!check.ok) { log(`REFUSED ${name}: ${check.reason}`); continue; }

    log(`${name}`);
    log(`  identical to ${check.keeper.path}`);
    try {
      fs.rmSync(row.path, { force: true });
    } catch (e) { log(`  FAILED to delete: ${e.message}`); continue; }

    // Take it out of the library too, or Marquee keeps offering a file that is
    // no longer there.
    const table = kind === 'episode' ? 'episode_files' : 'movie_files';
    try { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(fileId); } catch (e) { log('  (library row: ' + e.message + ')'); }
    try { db.prepare('DELETE FROM media_info WHERE file_kind = ? AND file_id = ?').run(kind, fileId); } catch {}

    freed += Number(row.size) || 0;
    gone++;
    log('  deleted; the copy above is untouched.');
  }
  log('');
  log(`Removed ${gone} of ${targets.length} requested. ${GB(freed)} freed.`);
} else if (cmd === 'watch') {
  // How this is meant to run: unattended, for good. It clears whatever backlog
  // exists, then wakes every 15 minutes to pick up new content.
  //
  // It used to work only when the probe scan found something new, which meant
  // that on an already-probed library — the exact case of a first run — it
  // found nothing, did nothing, and slept, for ever. The backlog IS the work
  // the first time round, and there is nothing new to find.
  // The window. Served from THIS process so there is one database handle and
  // no chance of the page and the worker disagreeing about what is happening.
  startUI(db, { port: config.optimizerUiPort || 8097, logFile: LOG_FILE, policy, log });
  log('watching. Clearing the existing backlog first, then new content as it lands.');
  log('Ctrl+C to stop; it also stands down on its own whenever someone is watching.');
  for (;;) {
    try {
      await doScan();
      // Keep going until the plan is exhausted or a viewer appears — work()
      // returns 0 for both, so this drains rather than doing five and sleeping
      // for a quarter of an hour with a thousand files still to go.
      let did = 0;
      do { did = await work(arg || 5); } while (did > 0);
    } catch (e) { log('error: ' + e.message); }
    await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
  }
} else {
  console.error(`unknown command "${cmd}" — try status, scan, plan, work, watch, duplicates, drop, stuck or retry`);
  process.exit(1);
}

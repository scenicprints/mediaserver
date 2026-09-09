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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as ff from './ffmpeg.mjs';
import * as engine from './engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'status';
const arg = Number(process.argv[3]) || 0;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);
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

async function doScan() {
  const before = db.prepare('SELECT COUNT(*) n FROM media_info').get().n;
  const n = await engine.runProbeScan(db, { log });
  const total = engine.scannableFiles(db).length;
  log(n ? `probed ${n} file(s) — ${before + n} of ${total} known` : `nothing new (${before} of ${total} already known)`);
  return n;
}

function showPlan() {
  const { items, totals } = engine.analyze(db, policy);
  log(`${totals.files.toLocaleString()} files known, holding ${TB(totals.bytes)}`);
  log(`reclaimable: ${TB(totals.saveBytes)}`);
  for (const [k, v] of Object.entries(totals.byProfile)) log(`  ${k.padEnd(6)} ${String(v.files).padStart(5)} files  ${GB(v.saveBytes)}`);
  const sur = engine.surroundCandidates(db);
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
    for (const it of engine.surroundCandidates(db)) {
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

const st = await ff.detect(ROOT, config);
if (!st.available) { console.error('ffmpeg not found — nothing can run'); process.exit(1); }

if (cmd === 'status') {
  const s = engine.status(db);
  log(`ffmpeg ready, hardware encoding ${st.nvenc ? 'available' : 'NOT available (CPU only)'}`);
  log(`${s.probed} of ${s.scannable} files probed`);
  log(`jobs: ${JSON.stringify(s.jobs)}`);
  log(`reclaimed so far: ${GB(s.reclaimedBytes)}`);
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
} else if (cmd === 'watch') {
  log('watching for new content. Ctrl+C to stop.');
  for (;;) {
    try {
      const n = await doScan();
      if (n) await work(arg || 5);
    } catch (e) { log('error: ' + e.message); }
    await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
  }
} else {
  console.error(`unknown command "${cmd}" — try status, scan, plan, work or watch`);
  process.exit(1);
}

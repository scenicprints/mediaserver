// Drive the storage optimizer directly, without going through the server.
//
// This exists so the work can run while the live server keeps serving. It talks
// to the same library.db (SQLite WAL handles the concurrent access) and uses the
// same optimizer/engine.mjs the scheduled runs do, so there is one
// implementation and one safety gate, not two.
//
//   node tools/run-optimizer.mjs scan              full probe pass (read-only)
//   node tools/run-optimizer.mjs plan              what it would do, no changes
//   node tools/run-optimizer.mjs run audio 10      queue N audio-only jobs and run them
//
// The 4K and HDR video vetoes are ON here and are not exposed as flags — this
// script cannot re-encode a 4K or HDR video stream even by accident.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = 'C:\\mediaserver';
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'src', f)).href);
const { detect: detectFfmpeg } = await imp('ffmpeg.mjs');
const opt = await imp('engine.mjs');

const GB = (b) => (Number(b) / 2 ** 30).toFixed(1) + ' GB';
const TB = (b) => (Number(b) / 2 ** 40).toFixed(2) + ' TB';
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);

// Read the real config so we use the ffmpeg build the server is configured for.
const cfg = JSON.parse((await import('node:fs')).default
  .readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const ff = await detectFfmpeg(ROOT, cfg);
log(`ffmpeg ready=${ff.available} nvenc=${ff.nvenc}`);
if (!ff.available) { console.error('ffmpeg unavailable — stopping.'); process.exit(1); }

const db = new DatabaseSync(path.join(ROOT, 'data', 'library.db'));
opt.ensureSchema(db);

const cmd = process.argv[2] || 'plan';

if (cmd === 'scan') {
  const limit = Number(process.argv[3]) || 0;
  log(`probing (limit ${limit || 'none'}) …`);
  const t0 = Date.now();
  await opt.runProbeScan(db, { log: (m) => log(m), limit });
  log(`probe pass done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (cmd === 'plan' || cmd === 'scan') {
  const { items, totals } = opt.analyze(db, {});
  log('');
  log(`probed and considered: ${totals.files.toLocaleString()} files holding ${TB(totals.bytes)}`);
  log(`recoverable: ${TB(totals.saveBytes)}`);
  for (const [k, v] of Object.entries(totals.byProfile)) {
    log(`  ${k.padEnd(6)} ${String(v.files).padStart(5)} files  ${GB(v.saveBytes)}`);
  }
  for (const [k, v] of Object.entries(totals.byTier)) {
    log(`  tier ${k.padEnd(6)} ${String(v.files).padStart(5)} files  holding ${TB(v.bytes)}  recoverable ${GB(v.saveBytes)}`);
  }
  // Safety assertions, printed every run so a regression is loud.
  const bad4k = items.filter((i) => i.tier === '4K' && i.profile !== 'audio');
  const badHdr = items.filter((i) => i.hdr && i.profile !== 'audio');
  log(`SAFETY: 4K files queued for video re-encode: ${bad4k.length} (must be 0)`);
  log(`SAFETY: HDR files queued for video re-encode: ${badHdr.length} (must be 0)`);
  if (bad4k.length || badHdr.length) { console.error('SAFETY CHECK FAILED — stopping.'); process.exit(1); }
}

if (cmd === 'run') {
  const profile = process.argv[3] || 'audio';
  const n = Number(process.argv[4]) || 10;
  const { items } = opt.analyze(db, {});
  const pool = items.filter((i) => i.profile === profile);

  // Belt and braces: this script only ever runs audio-profile work unless told
  // otherwise explicitly, and never anything that touches 4K/HDR video.
  const unsafe = pool.filter((i) => i.profile !== 'audio' && (i.tier === '4K' || i.hdr));
  if (unsafe.length) { console.error('refusing: unsafe items in pool'); process.exit(1); }

  const batch = pool.slice(0, n);
  log(`${pool.length} '${profile}' candidates; queueing ${batch.length}`);
  let queued = 0;
  for (const it of batch) {
    const r = opt.enqueue(db, it.kind, it.fileId, {});
    if (r.jobId && !r.error) queued++;
    else log(`  skip ${path.basename(it.path)}: ${r.error}`);
  }
  log(`queued ${queued}; working through them one at a time…`);

  const t0 = Date.now();
  await opt.runQueue(db, { log: (m) => log(m) });

  const done = db.prepare("SELECT * FROM optimize_jobs WHERE state = 'done'").all();
  const failed = db.prepare("SELECT * FROM optimize_jobs WHERE state IN ('failed','skipped')").all();
  const saved = done.reduce((s, j) => s + (Number(j.old_size) - Number(j.new_size)), 0);
  log('');
  log(`=== batch finished in ${((Date.now() - t0) / 60000).toFixed(1)} min ===`);
  log(`done ${done.length}, not applied ${failed.length}, reclaimed ${GB(saved)}`);
  for (const j of failed.slice(-10)) log(`  ${j.state}: ${path.basename(j.path || '')} — ${j.error}`);
}

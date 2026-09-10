// Runs the optimizer inside whatever is hosting it.
//
// The work itself — probing, planning, encoding, verifying, the gates, the
// pacing — lives in engine.mjs and is not duplicated here or anywhere else.
// This is only the loop and the wiring, factored out of app.mjs so the desktop
// application and the headless service run the *same* code rather than two
// copies that drift.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as engine from './engine.mjs';
import * as ff from './ffmpeg.mjs';
import { startUI } from './ui.mjs';
import { writeBadFileList } from './badfiles.mjs';

const LOG_MAX = 8 * 1024 * 1024;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---- One engine at a time --------------------------------------------------
//
// Two optimizers on the same drives is the worst case this program has: both
// reading and writing multi-gigabyte files at once on disks that already log
// I/O retries, and both pulling from one queue with no idea the other exists.
//
// The guard lives HERE rather than in an entry point, because there are now
// several ways in — the desktop application, the headless service, the command
// line — and a lock held by one of them has to be visible to all of them.
// Electron's own single-instance lock only stops a second copy of Electron.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function takeEngineLock(lockPath) {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (held.pid && held.pid !== process.pid && alive(held.pid)) return held;   // someone else has it
  } catch { /* no lock, or unreadable — ours to take */ }
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch { /* if we cannot write it, carry on rather than refusing to work */ }
  const release = () => {
    try {
      const h = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (h.pid === process.pid) fs.rmSync(lockPath, { force: true });
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(0); });
  return null;
}

export async function startEngine({ root, port = 8097 } = {}) {
  const LOG_FILE = path.join(root, 'data', 'optimizer.log');
  const BAD_LIST = path.join(root, 'data', 'needs-redownload.txt');

  function log(m) {
    const line = `[${stamp()}] ${m}`;
    try { console.log(line); } catch { /* no console when packaged */ }
    try {
      try { if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
      fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8');
    } catch { /* logging never stops the work */ }
  }

  const held = takeEngineLock(path.join(root, 'data', 'optimizer.lock'));
  if (held) {
    const e = new Error('Another optimizer is already running (process ' + held.pid + ').');
    e.code = 'ALREADY_RUNNING';
    e.holder = held;
    throw e;
  }

  const cfgPath = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  const dbPath = path.resolve(root, config.dbPath || './data/library.db');
  if (!fs.existsSync(dbPath)) throw new Error(`No library database at ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  engine.ensureSchema(db);

  const st = await ff.detect(root, config);
  if (!st.available) throw new Error('ffmpeg not found — nothing can run');
  log(`ffmpeg ready, hardware encoding ${st.nvenc ? 'available' : 'NOT available (CPU only)'}`);

  const policy = {
    allow4kVideo: config.optimizeAllow4kVideo === true,
    allowHdrVideo: config.optimizeAllowHdrVideo === true
  };
  engine.setThrottle({
    pauseBetweenJobsMs: 60_000,
    readRate: 8,
    stopOnDiskErrors: true,
    maxJobsPerRun: 0,
    ...(config.optimizeThrottle || {})
  });

  startUI(db, { port, logFile: LOG_FILE, policy, log });

  const profiles = Array.isArray(config.optimizeAutoProfiles) ? config.optimizeAutoProfiles : ['audio'];

  async function someoneWatching() {
    const p = config.port || 8096;
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 404) return false;
    } catch { return false; }
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/admin/sessions`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) return null;
      const j = await res.json();
      return Array.isArray(j.sessions) ? j.sessions.length > 0 : !!j.count;
    } catch { return null; }
  }

  async function once() {
    await engine.runProbeScan(db, { log });
    const bad = writeBadFileList(db, BAD_LIST);
    if (bad.length) log(`${bad.length} file(s) need re-downloading — see ${BAD_LIST}`);

    for (;;) {
      if (await someoneWatching() === true) { log('someone is watching — standing down'); return; }
      const { items } = engine.analyze(db, policy);
      let queued = 0;
      for (const it of items.filter((i) => profiles.includes(i.profile))) {
        if (queued >= 5) break;
        if (engine.enqueue(db, it.kind, it.fileId, policy).jobId) queued++;
      }
      if (profiles.includes('addaudio')) {
        for (const it of engine.compatibilityCandidates(db)) {
          if (queued >= 5) break;
          if (engine.enqueueAddAudio(db, it.kind, it.fileId).jobId) queued++;
        }
      }
      if (!queued) return;
      log(`queued ${queued} job(s)`);
      engine.worker.stop = false;
      const watcher = setInterval(async () => { if (await someoneWatching() === true) engine.worker.stop = true; }, 20000);
      try { await engine.runQueue(db, { log, ...policy }); } finally { clearInterval(watcher); }
    }
  }

  // Deliberately not awaited: the host has a window to put on screen and must
  // not sit behind a library scan to do it.
  (async () => {
    log('Working. It clears the backlog first, then handles new content as it arrives.');
    for (;;) {
      try { await once(); } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
      await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
    }
  })();

  return { db, log, port };
}

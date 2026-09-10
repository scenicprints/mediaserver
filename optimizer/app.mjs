// The optimizer as an application.
//
// run.mjs is the command line — a script, built on top-level await, which is
// exactly right for typing at and exactly wrong for packaging: Node's single
// executable format takes one CommonJS entry, and CommonJS cannot have
// top-level await.
//
// So this is the same program with a different front door. No arguments, no
// commands, no decisions to make: it starts working, opens its window, and
// keeps going. Everything below the surface — the engine, the gates, the
// pacing, the lock — is the identical module the CLI uses, imported rather
// than reimplemented, so the two cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

import * as engine from './engine.mjs';
import * as ff from './ffmpeg.mjs';
import { startUI } from './ui.mjs';
import { writeBadFileList } from './badfiles.mjs';

// Where the library lives. Beside the executable normally; the source tree when
// running from it. Both are checked, because a packaged exe and a checkout are
// laid out differently and neither should need configuring.
function findRoot() {
  const here = path.dirname(process.execPath);
  const candidates = [
    path.resolve(here, '..'),          // dist/MarqueeOptimizer.exe -> project root
    here,                              // exe sitting in the project root
    'C:\\mediaserver',                 // where it actually is on this machine
    process.cwd()
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'config.json'))) return c;
  }
  return process.cwd();
}

const ROOT = findRoot();
const LOG_FILE = path.join(ROOT, 'data', 'optimizer.log');
const BAD_LIST = path.join(ROOT, 'data', 'needs-redownload.txt');
const LOCK = path.join(ROOT, 'data', 'optimizer.lock');
const LOG_MAX = 8 * 1024 * 1024;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(m) {
  const line = `[${stamp()}] ${m}`;
  // The packaged exe is a GUI-subsystem binary with no console attached, so a
  // write to stdout has nowhere to go and can throw. The file is the real log;
  // the console is only for when it is run from a prompt.
  try { console.log(line); } catch {}
  try {
    try { if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8');
  } catch { /* logging never stops the work */ }
}

// One at a time — see the same guard in run.mjs. Two of these on the same disks
// is the worst thing that can happen to this machine.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function takeLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (held.pid && held.pid !== process.pid && alive(held.pid)) {
      log(`another optimizer is already running (pid ${held.pid}). Opening its window instead.`);
      return false;
    }
  } catch { /* no lock, or stale */ }
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), cmd: 'app' }), 'utf8');
  } catch {}
  const release = () => {
    try { const h = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (h.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(0); });
  return true;
}

function openBrowser(url) {
  try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

async function main() {
  const cfgPath = path.join(ROOT, 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { log(`cannot read ${cfgPath}: ${e.message}`); process.exitCode = 1; return; }

  const dbPath = path.resolve(ROOT, config.dbPath || './data/library.db');
  if (!fs.existsSync(dbPath)) { log(`no library database at ${dbPath}`); process.exitCode = 1; return; }
  const db = new DatabaseSync(dbPath);
  engine.ensureSchema(db);

  const port = config.optimizerUiPort || 8097;
  const url = `http://localhost:${port}`;

  // A second copy just shows you the first one's window rather than refusing
  // and looking broken — double-clicking twice is a normal thing to do.
  if (!takeLock()) { openBrowser(url); return; }

  const st = await ff.detect(ROOT, config);
  if (!st.available) { log('ffmpeg not found — nothing can run'); process.exitCode = 1; return; }
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
  openBrowser(url);

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

    // Drain the plan rather than doing a handful and sleeping with a thousand
    // files still to go.
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
      const watch = setInterval(async () => { if (await someoneWatching() === true) engine.worker.stop = true; }, 20000);
      try { await engine.runQueue(db, { log, ...policy }); } finally { clearInterval(watch); }
    }
  }

  log('Working. It clears the backlog first, then handles new content as it arrives.');
  for (;;) {
    try { await once(); } catch (e) { log('error: ' + e.message); }
    await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
  }
}

main().catch((e) => { log('fatal: ' + (e && e.stack || e)); process.exitCode = 1; });

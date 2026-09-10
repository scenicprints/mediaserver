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

// ---- When it is allowed to work -------------------------------------------
//
// The optimizer competes for the same disks, CPU and GPU that playback needs,
// and on this machine that showed up as someone's film going choppy. Standing
// down when a viewer appears is necessary but not sufficient: by the time it
// notices, it is already mid-encode on a 30 GB file.
//
// So the heavy work is confined to hours when nobody is realistically watching.
// The application itself keeps running the whole time — the window, the log,
// the duplicate finder are always there — only the encoding is scheduled.
const DEFAULT_WINDOW = { from: '00:00', to: '05:00' };

function parseHM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return fallback;
  const h = Math.min(23, Math.max(0, +m[1]));
  const mm = Math.min(59, Math.max(0, +m[2]));
  return h * 60 + mm;
}

// Handles a window that crosses midnight, which the default one does.
function withinWindow(win, now = new Date()) {
  const from = parseHM(win.from, 0);
  const to = parseHM(win.to, 5 * 60);
  const cur = now.getHours() * 60 + now.getMinutes();
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

function minutesUntilOpen(win, now = new Date()) {
  const from = parseHM(win.from, 0);
  const cur = now.getHours() * 60 + now.getMinutes();
  return from >= cur ? from - cur : (24 * 60 - cur) + from;
}
// Local time, not UTC. The working window is expressed in local hours, so a
// log in UTC would show 03:10 for a job that ran at 20:10 and make the one
// thing this log has to prove — that it only worked overnight — unreadable.
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

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
  const workWindow = { ...DEFAULT_WINDOW, ...(config.optimizeWindow || {}) };

  // Is anyone watching?
  //
  // This asks a loopback-only endpoint that needs no login, because the old
  // route needed one, always answered 401, and "cannot tell" was being read as
  // "carry on" — so the optimizer worked straight through other people's films
  // for as long as that code existed.
  //
  // It now fails CLOSED. If the server cannot be reached, or answers something
  // unexpected, the assumption is that someone IS watching. A missed hour of
  // housekeeping costs nothing; a stuttering film costs the whole point of the
  // machine. The one exception is a server that is not running at all, which
  // genuinely means nobody is watching.
  async function someoneWatching() {
    const p = config.port || 8096;
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/local/activity`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const j = await res.json();
        return Number(j.watching) > 0;
      }
      // Reachable but refusing: an older server without this endpoint. Assume
      // someone is watching rather than guessing in the optimizer's favour.
      log('cannot tell who is watching (server answered ' + res.status + ') — standing down to be safe');
      return true;
    } catch (e) {
      // Nothing listening at all: the media server is down, so nobody is
      // watching anything.
      if (e && (e.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(String(e.message)))) return false;
      log('cannot reach the media server — standing down to be safe');
      return true;
    }
  }

  async function once() {
    // Scanning is cheap — it reads headers, not whole files — so the library
    // stays up to date around the clock. Only the encoding is scheduled.
    await engine.runProbeScan(db, { log });
    const bad = writeBadFileList(db, BAD_LIST);
    if (bad.length) log(`${bad.length} file(s) need re-downloading — see ${BAD_LIST}`);

    if (!withinWindow(workWindow)) return;

    for (;;) {
      if (!withinWindow(workWindow)) { log('outside the working hours — stopping for tonight'); return; }
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
      // Watch for both reasons to stop mid-job: a viewer appearing, and the
      // window closing. Either returns the file in flight to the queue with its
      // temp cleaned up, so nothing is left half-done at five in the morning.
      const watcher = setInterval(async () => {
        if (!withinWindow(workWindow)) { log('working hours are over — finishing up'); engine.worker.stop = true; return; }
        if (await someoneWatching() === true) engine.worker.stop = true;
      }, 20000);
      try { await engine.runQueue(db, { log, ...policy }); } finally { clearInterval(watcher); }
    }
  }

  // Deliberately not awaited: the host has a window to put on screen and must
  // not sit behind a library scan to do it.
  (async () => {
    log(`Working hours: ${workWindow.from} to ${workWindow.to}.`);
    if (!withinWindow(workWindow)) {
      const mins = minutesUntilOpen(workWindow);
      log(`Outside those hours — next run in ${Math.floor(mins / 60)}h ${mins % 60}m. The window and the duplicate finder work regardless.`);
    }
    for (;;) {
      try { await once(); } catch (e) { log('error: ' + (e && e.message ? e.message : e)); }
      // Five minutes, so the start of the window is not missed by much.
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
    }
  })();

  return { db, log, port, window: workWindow, withinWindow: () => withinWindow(workWindow) };
}

// Intro (theme-song) detection by audio fingerprinting — the same idea Plex and
// Jellyfin use. At import, per SEASON, we fingerprint the start of each episode
// with Chromaprint (fpcalc) and find the longest recurring audio segment across
// episodes — that's the theme. We store a precise intro start/end per episode
// (and the episode's real duration, which fpcalc reports for free). Matching per
// season handles per-season intro changes; matching by content (not position)
// handles cold opens before the intro.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { playInfo } from './ffmpeg.js';

const yield_ = () => new Promise((r) => setImmediate(r)); // let the event loop breathe

const FPCALC_URL = 'https://github.com/acoustid/chromaprint/releases/download/v1.6.0/chromaprint-fpcalc-1.6.0-windows-x86_64.zip';
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';

const ITEM_SEC = 0.1238;   // seconds per Chromaprint sub-fingerprint
const ANALYZE_SEC = 480;   // fingerprint the first 8 minutes (covers cold-open + intro)
const BIT_THRESH = 8;      // max differing bits (of 32) to call two items a match
const MAX_GAP = 4;         // tolerate short mismatch bursts inside a matched run
const MIN_INTRO_SEC = 10;  // ignore matches shorter than this
const MAX_INTRO_START = 360; // an intro must begin within the first 6 minutes
const END_PAD = 2;         // pad the detected end so Skip lands just past the theme
const MAX_SHIFT_ITEMS = 1600; // how far intros may be shifted between episodes (~3.3 min)

let fpcalcPath = null;

function findExe(dir, name) {
  try {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.toLowerCase() === name) return p;
      }
    }
  } catch {}
  return null;
}

// Find fpcalc, downloading the tiny Chromaprint build on first use (no UI —
// it's ~2 MB). Returns null if it can't be obtained (detection then no-ops).
async function ensureFpcalc(root, config = {}) {
  if (fpcalcPath && fs.existsSync(fpcalcPath)) return fpcalcPath;
  const dir = path.join(root, 'tools', 'fpcalc');
  fpcalcPath = config.fpcalcPath || findExe(dir, 'fpcalc.exe');
  if (fpcalcPath) return fpcalcPath;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'fpcalc.zip');
    const res = await fetch(config.fpcalcUrl || FPCALC_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('download ' + res.status);
    const out = fs.createWriteStream(zip);
    for await (const chunk of res.body) { if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    await new Promise((resolve, reject) => execFile(fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar', ['-xf', zip, '-C', dir], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
    fs.rmSync(zip, { force: true });
    fpcalcPath = findExe(dir, 'fpcalc.exe');
  } catch (e) {
    console.error('[intro] could not install fpcalc:', e.message);
    fpcalcPath = null;
  }
  return fpcalcPath;
}

// Fingerprint the first ANALYZE_SEC of a file → { duration, fp: Int32Array }.
// Async (execFile, not …Sync) so decoding audio never blocks the event loop —
// the server stays responsive while this churns through the library.
function fingerprint(file) {
  return new Promise((resolve) => {
    execFile(fpcalcPath, ['-raw', '-length', String(ANALYZE_SEC), file],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120000 }, (err, stdout) => {
        if (err) return resolve({ duration: null, fp: null });
        const out = String(stdout);
        const dur = parseFloat((out.match(/DURATION=([\d.]+)/) || [])[1]) || null;
        const raw = (out.match(/FINGERPRINT=([\d,\-]+)/) || [])[1];
        resolve({ duration: dur, fp: raw ? Int32Array.from(raw.split(',').map(Number)) : null });
      });
  });
}

function popcount(n) { n = n - ((n >> 1) & 0x55555555); n = (n & 0x33333333) + ((n >> 2) & 0x33333333); return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24; }

// Find the longest audio segment common to fingerprints A and B. Returns the
// segment's position in each (seconds), or null. Handles the segment sitting at
// different offsets (cold opens of different lengths).
async function matchIntro(A, B) {
  const maxShift = Math.min(MAX_SHIFT_ITEMS, Math.min(A.length, B.length) - 1);
  let bestOff = 0, bestScore = -1;
  for (let d = -maxShift; d <= maxShift; d++) {
    let s = 0;
    const i0 = Math.max(0, -d), i1 = Math.min(A.length, B.length - d);
    for (let i = i0; i < i1; i++) if (popcount(A[i] ^ B[i + d]) <= BIT_THRESH) s++;
    if (s > bestScore) { bestScore = s; bestOff = d; }
    if (((d + maxShift) & 511) === 0) await yield_(); // don't hog the CPU during the offset search
  }
  const d = bestOff, i0 = Math.max(0, -d), i1 = Math.min(A.length, B.length - d);
  let runS = -1, gap = 0, best = null;
  for (let i = i0; i <= i1; i++) {
    const m = i < i1 && popcount(A[i] ^ B[i + d]) <= BIT_THRESH;
    if (m) { if (runS < 0) runS = i; gap = 0; }
    else { gap++; if (gap > MAX_GAP) { if (runS >= 0) { const len = (i - gap) - runS; if (!best || len > best.len) best = { s: runS, e: i - gap, len }; } runS = -1; } }
  }
  if (!best || best.len * ITEM_SEC < MIN_INTRO_SEC) return null;
  const aStart = best.s * ITEM_SEC, bStart = (best.s + d) * ITEM_SEC;
  if (aStart > MAX_INTRO_START || bStart > MAX_INTRO_START) return null;
  return {
    a: { start: Math.max(0, aStart), end: best.e * ITEM_SEC + END_PAD },
    b: { start: Math.max(0, bStart), end: (best.e + d) * ITEM_SEC + END_PAD }
  };
}

// Analyze one season: fingerprint each episode, match consecutive pairs, and
// return a Map of epId → { start, end } (best/longest match per episode). Fully
// async + paced so it never blocks playback.
async function analyzeSeason(eps) {
  const fps = [];
  for (const e of eps) { fps.push({ ep: e, ...(await fingerprint(e.path)) }); await new Promise((r) => setTimeout(r, 30)); }
  const introById = new Map();
  const assign = (ep, range) => {
    if (!range) return;
    const prev = introById.get(ep.id);
    if (!prev || (range.end - range.start) > (prev.end - prev.start)) introById.set(ep.id, range);
  };
  for (let i = 0; i + 1 < fps.length; i++) {
    const A = fps[i], B = fps[i + 1];
    if (!A.fp || !B.fp) continue;
    const m = await matchIntro(A.fp, B.fp);
    if (m) { assign(A.ep, m.a); assign(B.ep, m.b); }
  }
  return { introById, durations: new Map(fps.map((f) => [f.ep.id, f.duration])) };
}

// Background job: for every show/season with episodes not yet analyzed, detect
// intros and fill in durations. Paced so it doesn't peg the box.
export async function runIntroDetection(db, root, config = {}, { log = () => {} } = {}) {
  const rows = db.prepare(
    `SELECT e.id, e.show_id, e.season, f.path
     FROM episodes e JOIN episode_files f ON f.episode_id = e.id
     WHERE (e.intro_checked IS NULL OR e.intro_checked = 0)
     GROUP BY e.id ORDER BY e.show_id, e.season, e.episode`
  ).all();
  if (!rows.length) return 0;
  if (!(await ensureFpcalc(root, config))) { log('Intro detection: fpcalc unavailable — skipped.'); return 0; }

  // Group by show+season.
  const seasons = new Map();
  for (const r of rows) { const k = r.show_id + ':' + r.season; (seasons.get(k) || seasons.set(k, []).get(k)).push(r); }

  const setIntro = db.prepare('UPDATE episodes SET intro_start = ?, intro_end = ?, duration = COALESCE(?, duration), intro_checked = 1 WHERE id = ?');
  let done = 0;
  for (const eps of seasons.values()) {
    try {
      if (eps.length >= 2) {
        const { introById, durations } = await analyzeSeason(eps);
        for (const ep of eps) {
          const intro = introById.get(ep.id);
          setIntro.run(intro ? intro.start : null, intro ? intro.end : null, durations.get(ep.id) || null, ep.id);
          done++;
        }
        const found = eps.filter((e) => introById.get(e.id)).length;
        log(`Intro detection: show ${eps[0].show_id} S${eps[0].season} — ${found}/${eps.length} episodes matched.`);
      } else {
        // Single-episode season: no intro to match, but still record duration.
        for (const ep of eps) {
          const info = await playInfo(ep.path).catch(() => null);
          setIntro.run(null, null, (info && info.duration) || null, ep.id);
          done++;
        }
      }
    } catch (e) { log('Intro detection error: ' + e.message); }
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`Intro detection: processed ${done} episode(s).`);
  return done;
}

// The stored intro range for a single episode file (for the player).
export function introForFile(db, fileId) {
  const row = db.prepare(
    'SELECT e.intro_start AS start, e.intro_end AS end FROM episode_files f JOIN episodes e ON e.id = f.episode_id WHERE f.id = ?'
  ).get(fileId);
  if (row && row.start != null && row.end != null && row.end > row.start) return { start: row.start, end: row.end };
  return null;
}

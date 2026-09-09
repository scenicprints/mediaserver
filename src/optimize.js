// Storage optimizer: find files that are bigger than they need to be, and
// rewrite them smaller without changing what you can watch.
//
// Two ideas drive this module.
//
// 1. **The library already models "many files, one title."** Optimizing is
//    therefore a per-FILE operation, never a per-title one. Multiple versions of
//    the same movie are deliberate here, so nothing in this file ever reasons
//    about "you have three copies of X" — it only ever asks "is THIS file
//    carrying more bits than it needs to?"
//
// 2. **Never lose a file to a bad encode.** Every job writes to a sidecar temp
//    file, then has to pass a verification gate (probe + real decode spot-checks
//    at three points) before the source is deleted and the DB row is repointed.
//    A failed gate leaves the original exactly where it was and reports why.
//
// The cheapest big win is audio, not video: a TrueHD or DTS-HD track runs
// 20–40 Mbps where E-AC-3 640k sounds fine on a TV, and converting it copies the
// video stream untouched — no quality loss, no HDR/Dolby Vision risk, minutes
// per file instead of hours. It also happens to fix Apple TV playback, which
// can't copy TrueHD and crashes ffmpeg trying to decode it.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ffmpegBin, ffprobeBin, nvencAvailable } from './ffmpeg.js';

const yield_ = () => new Promise((r) => setImmediate(r));

// ---- Policy ------------------------------------------------------------

// Bitrate a given resolution tier should land at, in kbps. Deliberately
// conservative: these are "obviously wasteful above this" lines, not targets we
// chase downward. A file already at or under its tier is left alone.
const TIER_TARGET = { '4K': 16000, '1080p': 5000, '720p': 2500, 'SD': 1200 };

// Only re-encode video when the source is meaningfully over its tier — a file
// 10% over isn't worth an hour of GPU time and a generation of quality loss.
const OVER_TIER = 1.5;

// Audio codecs that store far more than a TV can use. Lossless (truehd/mlp/
// flac/pcm) and the DTS family are the whole list; ac3/eac3/aac/opus already
// sit at sane bitrates and are copied through untouched.
const BLOAT_AUDIO = new Set(['truehd', 'mlp', 'dts', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray', 'pcm_dvd']);

// Codecs that are already compact AND playable everywhere. If a file carries one
// of these alongside its lossless track, we have a safe fallback: drop the
// lossless track instead of decoding it. That matters because ffmpeg's TrueHD
// decoder crashes on some streams ("quant_step_size larger than huff_lsbs"), and
// most Blu-ray remuxes ship a compatibility AC-3 track for exactly this reason.
const COMPAT_AUDIO = new Set(['ac3', 'eac3', 'aac']);

// What a converted audio track becomes. E-AC-3 is the sweet spot: every TV,
// Apple TV, and Android TV decodes it, Apple can *copy* it (so the server never
// has to transcode audio for the HLS path), and 640 kbps 5.1 is transparent
// enough for a living room.
const AUDIO_CODEC = 'eac3';
const AUDIO_KBPS = 640;
const AUDIO_MAX_CH = 6; // ffmpeg's E-AC-3 encoder tops out at 5.1

// A job needs room to write its output beside the source before the source can
// be deleted. Require comfortably more than the source size.
const FREE_SPACE_FACTOR = 1.15;

const TMP_SUFFIX = '.marquee-opt.tmp';

// ---- Never overwrite a file that already exists ------------------------
//
// `fs.renameSync` on Windows maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING:
// if something is already at the destination it is silently destroyed. On
// 2026-09-08 that behaviour, in a migration that computed destination paths
// without checking them, overwrote 55 4K remuxes with the smaller web-rip of the
// same film — 1.29 TiB, unrecoverable from disk. The library deliberately holds
// several versions of a title under the same filename in different folders, so
// collisions are not an edge case here; they are the normal shape of the data.
//
// Every move in this codebase goes through these two functions. They refuse
// rather than replace. A refusal is a bug report; an overwrite is a bereavement.
export function moveNoClobber(src, dst) {
  if (fs.existsSync(dst)) {
    throw new Error(`destination already exists, refusing to overwrite: ${dst}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

export function copyNoClobber(src, dst) {
  if (fs.existsSync(dst)) {
    throw new Error(`destination already exists, refusing to overwrite: ${dst}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.partial';
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(src, tmp);
  const a = fs.statSync(src).size, b = fs.statSync(tmp).size;
  if (a !== b) { fs.rmSync(tmp, { force: true }); throw new Error(`size mismatch after copy: ${a} vs ${b}`); }
  fs.renameSync(tmp, dst);
  return b;
}

// Pre-flight for any batch of moves: find every collision BEFORE a single file
// is touched — against files already on disk, and against other moves in the
// same batch that would land on the same path. Acting first and validating
// afterwards is what turned a bug into data loss.
export function findCollisions(moves) {
  const problems = [];
  const claimed = new Map();
  for (const m of moves) {
    const to = String(m.to);
    const from = String(m.from);
    if (to.toLowerCase() === from.toLowerCase()) continue;
    if (fs.existsSync(to)) problems.push({ ...m, why: 'a different file is already at the destination' });
    const prior = claimed.get(to.toLowerCase());
    if (prior) problems.push({ ...m, why: `two files in this batch both want this path (also ${prior})` });
    claimed.set(to.toLowerCase(), from);
  }
  return problems;
}

// Resolution tier, judged on WIDTH.
//
// Height is a trap: a 2.39:1 scope film is letterboxed in the *encode*, not with
// black bars, so a 4K scope movie is 3840x1606 and a 1080p scope movie is
// 1920x800. Keying on height calls the first one "1080p" and the second "720p",
// which would have handed the entire 4K scope collection to the video re-encoder
// that 4K is explicitly meant to be protected from. Width is stable across
// aspect ratios; height is only the fallback for the odd file with no width.
export function tierOf(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const mp = (w * h) / 1e6; // megapixels

  // Width catches widescreen; pixel count catches everything else. A film is
  // promoted if EITHER test says so, which keeps the rule strictly protective:
  // a title can only ever move UP a tier, never down.
  //
  //   3840x2160 DCI-ish  8.29 MP   3840x1606 scope 4K  6.17 MP
  //   2872x2156 IMAX     6.19 MP <- width says 1080p, pixels say 4K. Pixels win.
  //   1920x1080          2.07 MP   1920x800 scope      1.54 MP
  //   1620x1080 pillar   1.75 MP <- width says 720p, pixels say 1080p.
  if (w >= 3000 || mp >= 5.0) return '4K';
  if (w >= 1700 || mp >= 1.3) return '1080p';
  if (w >= 1100 || mp >= 0.6) return '720p';
  if (w > 0) return 'SD';

  if (h >= 1500) return '4K';
  if (h >= 900) return '1080p';
  if (h >= 600) return '720p';
  return 'SD';
}

// ---- The hard rule: 4K HDR files are never modified --------------------
//
// Not "vetoed by default", not "off unless configured" — excluded outright,
// with no switch anywhere that turns it back on. These are the irreplaceable
// files in this library: the 4K HDR remuxes. Nothing in this module opens one
// for writing, re-encodes it, remuxes it, or replaces it. Not the video, not
// the audio, not the container.
//
// It is enforced in three independent places — the planner, the queue, and the
// job runner — so that a bug in any one of them still cannot reach these files.
// That redundancy is deliberate: on 2026-09-08 a single missing check destroyed
// 55 of them, and a rule this important should not depend on one line of code
// being right.
export function isProtected(info) {
  if (!info) return true;                        // unknown means hands off
  if (info.probe_error) return true;
  const tier = tierOf(info.width, info.height);
  return tier === '4K' && !!info.hdr;
}

export const PROTECTED_REASON = 'protected: 4K HDR — never modified';

// ---- Schema ------------------------------------------------------------

// Probing 20k files takes hours, so results are cached and keyed on
// (size, mtime) — a file that hasn't changed is never re-probed.
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_info (
      file_kind  TEXT NOT NULL,
      file_id    INTEGER NOT NULL,
      path       TEXT NOT NULL,
      size       INTEGER,
      mtime      INTEGER,
      duration   REAL,
      container  TEXT,
      vcodec     TEXT,
      width      INTEGER,
      height     INTEGER,
      pix_fmt    TEXT,
      hdr        INTEGER DEFAULT 0,
      vkbps      INTEGER,
      acodec     TEXT,
      achannels  INTEGER,
      akbps      INTEGER,
      audio_json TEXT,
      probed_at  INTEGER,
      probe_error TEXT,
      PRIMARY KEY (file_kind, file_id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_media_info_path ON media_info(path);');

  // One row per optimization attempt — the audit trail. Kept after success so
  // the admin panel can show what was reclaimed and what a file used to be.
  db.exec(`
    CREATE TABLE IF NOT EXISTS optimize_jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_kind   TEXT NOT NULL,
      file_id     INTEGER NOT NULL,
      profile     TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'queued',
      path        TEXT,
      old_size    INTEGER,
      new_size    INTEGER,
      old_summary TEXT,
      new_summary TEXT,
      reason      TEXT,
      error       TEXT,
      pct         REAL DEFAULT 0,
      created_at  INTEGER,
      started_at  INTEGER,
      ended_at    INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_optjobs_state ON optimize_jobs(state);');
}

// ---- Probing -----------------------------------------------------------

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    if (!cmd) return resolve(null);
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Run ffmpeg and resolve to null on success, or its stderr tail on failure.
// (Verification cares about *why* something failed, so we keep the message.)
function runFfmpeg(args, { timeout = 0, onLine } = {}) {
  return new Promise((resolve) => {
    const bin = ffmpegBin();
    if (!bin) return resolve('ffmpeg unavailable');
    const child = execFile(bin, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout },
      (err, _stdout, stderr) => {
        if (!err) return resolve(null);
        const tail = String(stderr || err.message).trim().split('\n').slice(-4).join(' ').slice(0, 400);
        resolve(tail || 'ffmpeg failed');
      });
    if (onLine && child.stderr) {
      let buf = '';
      child.stderr.on('data', (d) => {
        buf += d;
        const lines = buf.split(/[\r\n]/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      });
    }
  });
}

// HDR is worth knowing even though we never re-encode 4K video: it's the reason
// a file is off-limits to the video profile, and the admin panel shows it.
function isHdr(v) {
  const trc = String(v.color_transfer || '').toLowerCase();
  const pri = String(v.color_primaries || '').toLowerCase();
  return trc.includes('smpte2084') || trc.includes('arib-std-b67') || pri.includes('bt2020') ? 1 : 0;
}

async function probeOne(filePath) {
  const bin = ffprobeBin();
  if (!bin) return { error: 'ffprobe unavailable' };
  const out = await run(bin, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries',
    'format=duration,bit_rate,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt,channels,bit_rate,color_transfer,color_primaries:stream_tags=language,title',
    filePath
  ], 60000);
  let j = null;
  try { j = JSON.parse(out); } catch {}
  if (!j || !j.streams) return { error: 'probe failed' };

  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const a = audio[0] || {};
  let size = 0, mtime = 0;
  try { const st = fs.statSync(filePath); size = st.size; mtime = Math.round(st.mtimeMs); } catch {}
  const duration = +(j.format && j.format.duration) || 0;

  // Per-track audio detail — the audio profile needs to know *which* tracks are
  // bloated, and its output index, to build the right -c:a:N flags.
  const audio_json = JSON.stringify(audio.map((s, i) => ({
    i,                                     // index among audio streams (the "a:N" specifier)
    codec: s.codec_name || '?',
    ch: +s.channels || 0,
    kbps: Math.round((+s.bit_rate || 0) / 1000) || null,
    lang: (s.tags && s.tags.language) || null
  })));

  return {
    size, mtime, duration,
    container: (j.format && j.format.format_name) || null,
    vcodec: v.codec_name || null,
    width: +v.width || 0,
    height: +v.height || 0,
    pix_fmt: v.pix_fmt || null,
    hdr: isHdr(v),
    // Overall file bitrate is the honest number for "what does this cost me" —
    // a per-stream video bit_rate is frequently absent in MKV.
    vkbps: duration > 0 && size ? Math.round(size * 8 / duration / 1000) : null,
    acodec: a.codec_name || null,
    achannels: +a.channels || 0,
    akbps: Math.round((+a.bit_rate || 0) / 1000) || null,
    audio_json
  };
}

// Every file the optimizer is allowed to look at. Files on a drive that isn't
// mounted are excluded outright — the F: library is offline, and a missing
// drive must never be mistaken for a missing file.
export function scannableFiles(db) {
  const roots = mountedRoots();
  const rows = [
    ...db.prepare('SELECT id AS file_id, path, size FROM movie_files').all().map((r) => ({ ...r, file_kind: 'movie' })),
    ...db.prepare('SELECT id AS file_id, path, size FROM episode_files').all().map((r) => ({ ...r, file_kind: 'episode' }))
  ];
  return rows.filter((r) => roots.has(String(r.path).slice(0, 2).toUpperCase()));
}

// Drive letters that are actually present AND readable right now.
//
// This is deliberately the same test `pruneMissing` in scan.js uses (statSync +
// isDirectory), not `existsSync`: on Windows a drive letter can answer
// existsSync while the volume behind it is not really usable. An external USB
// disk that has dropped out must read as "not mounted" here, so the optimizer
// leaves its files completely alone rather than drawing conclusions about
// media it cannot currently see.
export function mountedRoots() {
  const set = new Set();
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':';
    try { if (fs.statSync(d + '\\').isDirectory()) set.add(d); } catch {}
  }
  return set;
}

export const scan = { running: false, done: 0, total: 0, startedAt: 0, error: null };

// Background pass: probe everything not already cached at its current size+mtime.
// Paced with a yield between files so playback and the UI stay responsive.
export async function runProbeScan(db, { log = () => {}, limit = 0 } = {}) {
  if (scan.running) return 0;
  ensureSchema(db);
  const cached = new Map();
  for (const r of db.prepare('SELECT file_kind, file_id, size, mtime FROM media_info').all()) {
    cached.set(r.file_kind + ':' + r.file_id, r);
  }
  let todo = scannableFiles(db).filter((f) => {
    const c = cached.get(f.file_kind + ':' + f.file_id);
    if (!c) return true;
    let st = null;
    try { st = fs.statSync(f.path); } catch { return false; } // gone: leave the stale row, the scanner owns deletions
    return c.size !== st.size || c.mtime !== Math.round(st.mtimeMs);
  });
  if (limit > 0) todo = todo.slice(0, limit);
  if (!todo.length) return 0;

  scan.running = true; scan.done = 0; scan.total = todo.length; scan.startedAt = Date.now(); scan.error = null;
  const up = db.prepare(`
    INSERT INTO media_info (file_kind, file_id, path, size, mtime, duration, container, vcodec, width, height,
                            pix_fmt, hdr, vkbps, acodec, achannels, akbps, audio_json, probed_at, probe_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(file_kind, file_id) DO UPDATE SET
      path=excluded.path, size=excluded.size, mtime=excluded.mtime, duration=excluded.duration,
      container=excluded.container, vcodec=excluded.vcodec, width=excluded.width, height=excluded.height,
      pix_fmt=excluded.pix_fmt, hdr=excluded.hdr, vkbps=excluded.vkbps, acodec=excluded.acodec,
      achannels=excluded.achannels, akbps=excluded.akbps, audio_json=excluded.audio_json,
      probed_at=excluded.probed_at, probe_error=excluded.probe_error`);

  try {
    for (const f of todo) {
      const info = await probeOne(f.path);
      const now = Date.now();
      if (info.error) {
        up.run(f.file_kind, f.file_id, f.path, Number(f.size) || 0, 0, null, null, null, 0, 0,
          null, 0, null, null, 0, null, null, now, info.error);
      } else {
        up.run(f.file_kind, f.file_id, f.path, info.size, info.mtime, info.duration, info.container,
          info.vcodec, info.width, info.height, info.pix_fmt, info.hdr, info.vkbps, info.acodec,
          info.achannels, info.akbps, info.audio_json, now, null);
      }
      scan.done++;
      if (scan.done % 200 === 0) log(`Optimizer: probed ${scan.done}/${scan.total}`);
      await yield_();
    }
    log(`Optimizer: probed ${scan.done} file(s).`);
  } catch (e) {
    scan.error = e.message;
    log('Optimizer probe error: ' + e.message);
  } finally {
    scan.running = false;
  }
  return scan.done;
}

// ---- Analysis ----------------------------------------------------------

// Decide what (if anything) should be done to one probed file.
//
// Both `allow4kVideo` and `allowHdrVideo` are off unless the owner turns them
// on. A vetoed file is not skipped — it still gets its bloated audio fixed,
// which is where most of the easy savings live anyway.
export function planFor(info, { allow4kVideo = false, allowHdrVideo = false } = {}) {
  if (!info || info.probe_error) return { profile: 'none', reason: info?.probe_error || 'not probed' };
  if (!info.vcodec) return { profile: 'none', reason: 'no video stream' };
  // Enforcement 1 of 3. Before anything else is considered.
  if (isProtected(info)) return { profile: 'none', reason: PROTECTED_REASON, protected: true };

  const tier = tierOf(info.width, info.height);
  const target = TIER_TARGET[tier];
  const size = Number(info.size) || 0;
  const dur = Number(info.duration) || 0;
  if (!size || !dur) return { profile: 'none', reason: 'unknown size/duration' };

  let audio = [];
  try { audio = JSON.parse(info.audio_json || '[]'); } catch {}

  // What a track currently costs. A per-track bit_rate is often missing in MKV,
  // so fall back to a conservative estimate per codec — deliberately low, so we
  // never over-promise savings.
  const estKbps = (a) => a.kbps || (a.codec === 'truehd' || a.codec === 'mlp' ? 4500
    : a.codec === 'dts' ? 1500
    : a.codec.startsWith('pcm') ? (a.ch || 2) * 1152
    : a.codec === 'flac' ? 900 : 700);

  // What a track would become: 5.1 gets the full 640k, stereo doesn't need it.
  const newKbps = (a) => ((a.ch || 2) > 2 ? AUDIO_KBPS : 320);

  // Only worth touching if the replacement is meaningfully smaller — converting
  // a 900 kbps stereo FLAC to 640k E-AC-3 costs quality and saves nothing.
  const bloated = audio.filter((a) => {
    if (!BLOAT_AUDIO.has(String(a.codec).toLowerCase())) return false;
    return estKbps(a) > newKbps(a) * 1.5;
  });

  const audioKbps = bloated.reduce((n, a) => n + estKbps(a), 0);
  const audioNewKbps = bloated.reduce((n, a) => n + newKbps(a), 0);
  const audioSaveBytes = Math.max(0, (audioKbps - audioNewKbps) * 1000 / 8 * dur);

  const totalKbps = Number(info.vkbps) || Math.round(size * 8 / dur / 1000);
  const videoKbps = Math.max(0, totalKbps - audio.reduce((n, a) => n + estKbps(a), 0));

  // Is the *video* over its tier? Judge the video stream, not the file total —
  // otherwise a lossless audio track alone makes a modest video look wasteful.
  const videoOver = videoKbps > target * OVER_TIER;

  // Two independent vetoes, both on by default:
  //   4K  — this box's Pascal NVENC is a real quality step down at 4K.
  //   HDR — any re-encode drops Dolby Vision, at every resolution, so an HDR
  //         file is off-limits to the video profile whatever size it is.
  // Neither veto affects audio: a vetoed file still gets its TrueHD/DTS fixed.
  const veto = (tier === '4K' && !allow4kVideo) ? '4K'
    : (info.hdr && !allowHdrVideo) ? 'HDR'
    : null;
  const videoAllowed = videoOver && !veto;
  const videoSaveBytes = videoAllowed ? Math.max(0, (videoKbps - target) * 1000 / 8 * dur) : 0;

  const wantAudio = bloated.length > 0 && audioSaveBytes > 200 * 2 ** 20; // ignore <200 MB of audio waste
  const wantVideo = videoAllowed && videoSaveBytes > 300 * 2 ** 20;

  let profile = 'none';
  if (wantAudio && wantVideo) profile = 'both';
  else if (wantAudio) profile = 'audio';
  else if (wantVideo) profile = 'video';

  const reason = profile === 'none'
    ? (veto && videoOver ? `${veto} video left alone by policy` : 'already efficient')
    : [
        wantAudio ? `${bloated.map((a) => a.codec.toUpperCase()).join('+')} audio → E-AC-3` : null,
        wantVideo ? `${Math.round(videoKbps / 100) / 10} Mbps ${tier} video → HEVC ~${target / 1000} Mbps` : null,
        // Say out loud when big video is being deliberately left alone, so the
        // panel never looks like it just missed a 35 Mbps file.
        !wantVideo && veto && videoOver ? `${veto} video kept as-is` : null
      ].filter(Boolean).join(', ');

  // Is there already a compact, universally-playable track in this file? If so,
  // dropping the lossless tracks is a viable fallback when re-encoding them
  // fails — and it needs no audio decoding at all, so a broken TrueHD stream
  // can't defeat it. Prefer a surround track; settle for any compatible one.
  const compat = audio.filter((a) => COMPAT_AUDIO.has(String(a.codec).toLowerCase()));
  const keeper = compat.find((a) => (a.ch || 0) >= 6) || compat[0] || null;

  return {
    profile, reason, tier, hdr: !!info.hdr, veto,
    totalKbps, videoKbps: Math.round(videoKbps),
    bloatedAudio: bloated,
    // Everything needed to retry as a pure stream-copy that discards the
    // lossless tracks rather than converting them.
    canDropAudio: !!keeper && bloated.length > 0,
    keepAudio: keeper,
    saveBytes: Math.round((wantAudio ? audioSaveBytes : 0) + (wantVideo ? videoSaveBytes : 0))
  };
}

// The whole library's plan, newest waste first.
export function analyze(db, { allow4kVideo = false, allowHdrVideo = false } = {}) {
  ensureSchema(db);
  const rows = db.prepare(`
    SELECT mi.*, COALESCE(m.title, s.title) AS title, e.season, e.episode
    FROM media_info mi
    LEFT JOIN movie_files   mf ON mi.file_kind = 'movie'   AND mf.id = mi.file_id
    LEFT JOIN movies        m  ON m.id  = mf.movie_id
    LEFT JOIN episode_files ef ON mi.file_kind = 'episode' AND ef.id = mi.file_id
    LEFT JOIN episodes      e  ON e.id  = ef.episode_id
    LEFT JOIN shows         s  ON s.id  = e.show_id
    WHERE (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all();

  const mounted = mountedRoots();
  const items = [];
  const totals = { files: 0, bytes: 0, saveBytes: 0, byProfile: {}, byTier: {} };

  for (const r of rows) {
    if (!mounted.has(String(r.path).slice(0, 2).toUpperCase())) continue;
    const plan = planFor(r, { allow4kVideo, allowHdrVideo });
    const size = Number(r.size) || 0;
    totals.files++; totals.bytes += size;
    const tier = plan.tier || tierOf(r.width, r.height);
    totals.byTier[tier] = totals.byTier[tier] || { files: 0, bytes: 0, saveBytes: 0 };
    totals.byTier[tier].files++; totals.byTier[tier].bytes += size;
    if (plan.profile === 'none') continue;
    totals.saveBytes += plan.saveBytes;
    totals.byTier[tier].saveBytes += plan.saveBytes;
    totals.byProfile[plan.profile] = totals.byProfile[plan.profile] || { files: 0, saveBytes: 0 };
    totals.byProfile[plan.profile].files++;
    totals.byProfile[plan.profile].saveBytes += plan.saveBytes;
    items.push({
      kind: r.file_kind, fileId: r.file_id, path: r.path,
      title: r.title || path.basename(r.path),
      season: r.season, episode: r.episode,
      size, duration: r.duration, tier, hdr: !!r.hdr,
      vcodec: r.vcodec, width: r.width, height: r.height, acodec: r.acodec, achannels: r.achannels,
      totalKbps: plan.totalKbps, videoKbps: plan.videoKbps,
      profile: plan.profile, reason: plan.reason, saveBytes: plan.saveBytes
    });
  }
  items.sort((a, b) => b.saveBytes - a.saveBytes);
  return { items, totals };
}

// ---- Encoding ----------------------------------------------------------

function freeSpaceOn(filePath) {
  try {
    const st = fs.statfsSync(path.parse(filePath).root);
    return st.bavail * st.bsize;
  } catch { return Infinity; } // if we can't tell, let the encode fail loudly instead
}

// Build the ffmpeg command for a profile.
//
// Audio profile: `-map 0 -c copy` keeps every stream — video, subtitles, chapters,
// attachments — byte-identical, and only the bloated audio tracks are re-encoded
// in place. That's why it's fast and lossless where it matters.
// `audioMode` is 'convert' (re-encode the lossless tracks) or 'drop' (discard
// them and keep the file's existing compatible track). 'drop' decodes no audio
// at all, which is what makes it a reliable fallback.
function buildArgs(info, plan, src, dst, { audioMode = 'convert' } = {}) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', src, '-map', '0', '-map', '-0:d?', '-max_interleave_delta', '0'];
  const doVideo = plan.profile === 'video' || plan.profile === 'both';
  const doAudio = plan.profile === 'audio' || plan.profile === 'both';
  if (doAudio && audioMode === 'drop') {
    // Deselect each bloated audio track; everything else still passes through.
    for (const a of plan.bloatedAudio) args.push('-map', `-0:a:${a.i}`);
  }

  if (doVideo) {
    const target = TIER_TARGET[plan.tier];
    // 10-bit sources stay 10-bit — dropping to 8-bit would band the gradients
    // this bitrate is trying to protect.
    const tenBit = /10le|10be|p010/.test(String(info.pix_fmt || ''));
    if (nvencAvailable()) {
      args.push('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '26',
        '-b:v', `${target}k`, '-maxrate', `${Math.round(target * 1.5)}k`, '-bufsize', `${target * 3}k`);
      if (tenBit) args.push('-pix_fmt', 'p010le');
    } else {
      args.push('-c:v', 'libx265', '-preset', 'medium', '-crf', '22',
        '-maxrate', `${Math.round(target * 1.5)}k`, '-bufsize', `${target * 3}k`);
      if (tenBit) args.push('-pix_fmt', 'yuv420p10le');
    }
    // hvc1 (not hev1) is what Apple's players require; harmless everywhere else.
    args.push('-tag:v', 'hvc1');
    // A keyframe every 2s keeps seeking snappy in every one of our players.
    args.push('-g', '48', '-keyint_min', '48');
    // Carry HDR signalling through verbatim rather than letting ffmpeg guess.
    if (info.hdr) args.push('-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc');
  } else {
    args.push('-c:v', 'copy');
  }

  args.push('-c:a', 'copy', '-c:s', 'copy', '-c:t', 'copy');
  if (doAudio && audioMode === 'convert') {
    for (const a of plan.bloatedAudio) {
      const ch = Math.min(a.ch || 2, AUDIO_MAX_CH); // E-AC-3 tops out at 5.1
      args.push(`-c:a:${a.i}`, AUDIO_CODEC, `-b:a:${a.i}`, `${ch > 2 ? AUDIO_KBPS : 320}k`);
      if ((a.ch || 0) > AUDIO_MAX_CH) args.push(`-ac:a:${a.i}`, String(AUDIO_MAX_CH));
    }
  }
  args.push(dst);
  return args;
}

// ---- Verification gate -------------------------------------------------

// The output has to prove itself before the source is allowed to die. Probing
// alone isn't enough: a truncated file often probes fine, so we also force a
// real decode at the start, middle, and end and require all three to be clean.
async function verify(src, dst, info, plan) {
  let sStat, dStat;
  try { sStat = fs.statSync(src); dStat = fs.statSync(dst); }
  catch (e) { return 'output missing: ' + e.message; }

  if (dStat.size < 1 << 20) return 'output is implausibly small';
  if (dStat.size >= sStat.size) return `output is not smaller (${(dStat.size / 2 ** 30).toFixed(2)} GB vs ${(sStat.size / 2 ** 30).toFixed(2)} GB)`;

  const out = await probeOne(dst);
  if (out.error) return 'output failed to probe: ' + out.error;

  const srcDur = Number(info.duration) || 0;
  if (srcDur > 0) {
    const drift = Math.abs((out.duration || 0) - srcDur);
    if (drift > Math.max(1.5, srcDur * 0.005)) return `duration drifted ${drift.toFixed(1)}s (${srcDur.toFixed(0)}s → ${(out.duration || 0).toFixed(0)}s)`;
  }
  if (!out.vcodec) return 'output has no video stream';
  if (!out.acodec) return 'output has no audio stream';

  // Copied video must come through pixel-identical in shape.
  if (plan.profile === 'audio' && (out.width !== info.width || out.height !== info.height)) {
    return `copied video changed size (${info.width}x${info.height} → ${out.width}x${out.height})`;
  }
  if (plan.profile !== 'audio' && (!out.height || out.height !== info.height)) {
    return `re-encoded video height changed (${info.height} → ${out.height})`;
  }

  // Decode spot-checks. `-xerror` turns any decode warning into a failure, so a
  // corrupt or truncated stream can't slip through as "probed fine."
  const dur = out.duration || srcDur || 0;
  const points = dur > 60 ? [1, Math.max(2, dur / 2), Math.max(3, dur - 15)] : [0];
  for (const t of points) {
    const err = await runFfmpeg(['-hide_banner', '-nostdin', '-xerror', '-v', 'error',
      '-ss', String(Math.floor(t)), '-i', dst, '-t', '4', '-map', '0:v:0?', '-map', '0:a:0?',
      '-f', 'null', '-'], { timeout: 180000 });
    if (err) return `decode check failed at ${Math.floor(t)}s: ${err}`;
  }
  return null; // clean
}

// ---- Job queue ---------------------------------------------------------

export const worker = { running: false, current: null, stop: false, log: [] };

function note(msg) {
  worker.log.push({ ts: Date.now(), msg });
  if (worker.log.length > 300) worker.log.splice(0, worker.log.length - 300);
}

export function enqueue(db, kind, fileId, { allow4kVideo = false, allowHdrVideo = false, force = false } = {}) {
  ensureSchema(db);
  const info = db.prepare('SELECT * FROM media_info WHERE file_kind = ? AND file_id = ?').get(kind, fileId);
  if (!info) return { error: 'file has not been probed yet' };
  // Enforcement 2 of 3. A protected file cannot enter the queue at all, even if
  // something hands us its id directly.
  if (isProtected(info)) return { error: PROTECTED_REASON };
  const plan = planFor(info, { allow4kVideo, allowHdrVideo });
  if (plan.profile === 'none') return { error: 'nothing to optimize: ' + plan.reason };
  const existing = db.prepare("SELECT id FROM optimize_jobs WHERE file_kind = ? AND file_id = ? AND state IN ('queued','running','verifying')").get(kind, fileId);
  if (existing) return { error: 'already queued', jobId: existing.id };
  // A file that already failed is not retried automatically. Without this the
  // unattended loop would spend forever re-encoding the same broken file, and a
  // 75 GB retry loop is expensive. `force` is how the owner asks for a retry.
  if (!force) {
    const prior = db.prepare("SELECT id, error FROM optimize_jobs WHERE file_kind = ? AND file_id = ? AND state IN ('failed','skipped') ORDER BY id DESC LIMIT 1").get(kind, fileId);
    if (prior) return { error: 'previously failed — not retried automatically' };
  }
  const r = db.prepare(`INSERT INTO optimize_jobs (file_kind, file_id, profile, state, path, old_size, old_summary, reason, created_at)
                        VALUES (?,?,?,'queued',?,?,?,?,?)`)
    .run(kind, fileId, plan.profile, info.path, info.size, summarize(info), plan.reason, Date.now());
  return { jobId: Number(r.lastInsertRowid), profile: plan.profile, reason: plan.reason };
}

// Queue an "add a compatible surround track" job. Separate from enqueue()
// because it is allowed on 4K HDR files, which enqueue() refuses outright.
export function enqueueAddAudio(db, kind, fileId, { force = false } = {}) {
  ensureSchema(db);
  const info = db.prepare('SELECT * FROM media_info WHERE file_kind = ? AND file_id = ?').get(kind, fileId);
  if (!info) return { error: 'file has not been probed yet' };
  const plan = planAddAudio(info);
  if (!plan.need) return { error: plan.reason };
  const existing = db.prepare("SELECT id FROM optimize_jobs WHERE file_kind = ? AND file_id = ? AND state IN ('queued','running','verifying')").get(kind, fileId);
  if (existing) return { error: 'already queued', jobId: existing.id };
  if (!force) {
    const prior = db.prepare("SELECT id FROM optimize_jobs WHERE file_kind = ? AND file_id = ? AND profile = 'addaudio' AND state IN ('failed','skipped') ORDER BY id DESC LIMIT 1").get(kind, fileId);
    if (prior) return { error: 'previously failed — not retried automatically' };
  }
  const r = db.prepare(`INSERT INTO optimize_jobs (file_kind, file_id, profile, state, path, old_size, old_summary, reason, created_at)
                        VALUES (?,?,'addaudio','queued',?,?,?,?,?)`)
    .run(kind, fileId, info.path, info.size, summarize(info), plan.reason, Date.now());
  return { jobId: Number(r.lastInsertRowid), profile: 'addaudio', reason: plan.reason };
}

// Everything in the library that would play better on a TV with one more audio
// track. Used by the Storage panel and by automatic mode.
export function surroundCandidates(db) {
  ensureSchema(db);
  const rows = db.prepare(`
    SELECT mi.*, COALESCE(m.title, s.title) AS title, e.season, e.episode
    FROM media_info mi
    LEFT JOIN movie_files   mf ON mi.file_kind='movie'   AND mf.id = mi.file_id
    LEFT JOIN movies        m  ON m.id  = mf.movie_id
    LEFT JOIN episode_files ef ON mi.file_kind='episode' AND ef.id = mi.file_id
    LEFT JOIN episodes      e  ON e.id  = ef.episode_id
    LEFT JOIN shows         s  ON s.id  = e.show_id
    WHERE mi.probe_error IS NULL AND (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all();
  const out = [];
  for (const r of rows) {
    const p = planAddAudio(r);
    if (!p.need) continue;
    // Only surround sources are worth it — adding a stereo E-AC-3 next to a
    // stereo MP3 achieves nothing.
    if (p.channels < 6) continue;
    out.push({
      kind: r.file_kind, fileId: r.file_id, path: r.path,
      title: r.title || path.basename(r.path), season: r.season, episode: r.episode,
      size: Number(r.size) || 0, tier: tierOf(r.width, r.height), hdr: !!r.hdr,
      from: p.srcDesc, reason: p.reason
    });
  }
  out.sort((a, b) => (b.hdr ? 1 : 0) - (a.hdr ? 1 : 0) || b.size - a.size);
  return out;
}

function summarize(info) {
  const mb = Number(info.size) ? (Number(info.size) / 2 ** 30).toFixed(2) + ' GB' : '?';
  return `${info.vcodec || '?'} ${info.height || '?'}p ${info.vkbps ? Math.round(info.vkbps / 100) / 10 + ' Mbps' : ''} · ${info.acodec || '?'} ${info.achannels || '?'}ch · ${mb}`.replace(/\s+/g, ' ');
}

// Run queued jobs one at a time. One at a time is deliberate: the box also has
// to serve playback, and two concurrent encodes on a 1050 Ti help nobody.
export async function runQueue(db, { log = () => {}, allow4kVideo = false, allowHdrVideo = false } = {}) {
  if (worker.running) return;
  worker.running = true; worker.stop = false;
  try {
    for (;;) {
      if (worker.stop) { note('Stopped by request.'); break; }
      const job = db.prepare("SELECT * FROM optimize_jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get();
      if (!job) break;
      await runJob(db, job, { log, allow4kVideo, allowHdrVideo });
    }
  } finally {
    worker.running = false; worker.current = null;
  }
}

async function runJob(db, job, { log, allow4kVideo, allowHdrVideo }) {
  const setState = (state, fields = {}) => {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE optimize_jobs SET state = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`)
      .run(state, ...cols.map((c) => fields[c]), job.id);
  };

  const info = db.prepare('SELECT * FROM media_info WHERE file_kind = ? AND file_id = ?').get(job.file_kind, job.file_id);
  if (!info) return setState('failed', { error: 'file no longer in the library', ended_at: Date.now() });

  // Adding an audio track is the sanctioned exception to the 4K HDR rule, so it
  // is handled before the protection check — it copies the video rather than
  // re-encoding it, and proves that with a bitstream hash rather than asking to
  // be trusted. See addCompatibleAudio().
  if (job.profile === 'addaudio') {
    worker.current = { jobId: job.id, path: info.path, profile: 'addaudio', pct: 0, startedAt: Date.now() };
    setState('running', { started_at: Date.now() });
    note(`Adding a surround track to ${path.basename(info.path)}`);
    const res = await addCompatibleAudio(db, job.file_kind, job.file_id, { log });
    if (res.ok) {
      note(`Done ${path.basename(info.path)} — E-AC-3 added, video bitstream verified identical`);
      return setState('done', {
        new_size: res.newSize, pct: 100, ended_at: Date.now(),
        reason: `added E-AC-3 surround; video bitstream verified identical (${res.beforeHash})`
      });
    }
    note(`FAILED ${path.basename(info.path)}: ${res.error}`);
    return setState('failed', { error: res.error, ended_at: Date.now() });
  }

  // Enforcement 3 of 3. The last gate before ffmpeg is handed a path — a job
  // queued before this rule existed, or by a future bug, still stops here.
  if (isProtected(info)) {
    note(`Skipped ${path.basename(info.path)} — ${PROTECTED_REASON}`);
    return setState('skipped', { error: PROTECTED_REASON, ended_at: Date.now() });
  }

  const src = info.path;
  if (!fs.existsSync(src)) return setState('failed', { error: 'source file is gone', ended_at: Date.now() });

  // A file whose bytes changed since the probe must be re-probed before we act
  // on stale conclusions.
  try {
    const st = fs.statSync(src);
    if (st.size !== Number(info.size) || Math.round(st.mtimeMs) !== Number(info.mtime)) {
      return setState('failed', { error: 'file changed since it was probed — rescan and requeue', ended_at: Date.now() });
    }
  } catch (e) { return setState('failed', { error: 'cannot stat source: ' + e.message, ended_at: Date.now() }); }

  const plan = planFor(info, { allow4kVideo, allowHdrVideo });
  if (plan.profile === 'none') return setState('skipped', { error: 'no longer worth optimizing: ' + plan.reason, ended_at: Date.now() });

  const need = Number(info.size) * FREE_SPACE_FACTOR;
  if (freeSpaceOn(src) < need) {
    return setState('failed', { error: `not enough free space on ${src.slice(0, 2)} (needs ~${(need / 2 ** 30).toFixed(1)} GB to work safely)`, ended_at: Date.now() });
  }

  // Same directory as the source so the final move is a rename on one volume,
  // never a multi-gigabyte cross-drive copy.
  const ext = plan.profile === 'audio' ? path.extname(src) : '.mkv';
  const dst = src.replace(/\.[^.]+$/, '') + TMP_SUFFIX + ext;
  fs.rmSync(dst, { force: true });

  worker.current = { jobId: job.id, path: src, profile: plan.profile, pct: 0, startedAt: Date.now() };
  setState('running', { started_at: Date.now(), profile: plan.profile, reason: plan.reason });
  note(`Optimizing ${path.basename(src)} — ${plan.reason}`);
  log(`Optimizer: ${path.basename(src)} — ${plan.reason}`);

  const totalDur = Number(info.duration) || 0;
  const encode = (audioMode) => runFfmpeg(buildArgs(info, plan, src, dst, { audioMode }), {
    onLine: (line) => {
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line);
      if (m && totalDur > 0) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        const pct = Math.min(99, Math.round(t / totalDur * 100));
        if (worker.current) worker.current.pct = pct;
        db.prepare('UPDATE optimize_jobs SET pct = ? WHERE id = ?').run(pct, job.id);
      }
    }
  });

  let audioMode = 'convert';
  let err = await encode(audioMode);

  // Some TrueHD streams kill ffmpeg's decoder partway through
  // ("quant_step_size larger than huff_lsbs"). When the file already carries a
  // compatible track, retry by DROPPING the lossless tracks instead of decoding
  // them — no audio decode, so the broken stream can't be hit, and it saves more
  // space than converting would have.
  if (err && !worker.stop && plan.canDropAudio && (plan.profile === 'audio' || plan.profile === 'both')) {
    fs.rmSync(dst, { force: true });
    const keep = plan.keepAudio;
    note(`Retrying ${path.basename(src)} without decoding audio — keeping its ${String(keep.codec).toUpperCase()} ${keep.ch}ch track`);
    audioMode = 'drop';
    err = await encode(audioMode);
  }

  if (worker.stop) {
    fs.rmSync(dst, { force: true });
    return setState('queued', { error: null, pct: 0 });
  }
  if (err) {
    fs.rmSync(dst, { force: true });
    note(`FAILED ${path.basename(src)}: ${err}`);
    return setState('failed', { error: err, ended_at: Date.now() });
  }

  // ---- The gate. Nothing is deleted until this returns clean. ----
  setState('verifying', {});
  const bad = await verify(src, dst, info, plan);
  if (bad) {
    fs.rmSync(dst, { force: true });
    note(`REJECTED ${path.basename(src)}: ${bad} — original untouched.`);
    log(`Optimizer rejected ${path.basename(src)}: ${bad}`);
    return setState('failed', { error: 'verification failed: ' + bad, ended_at: Date.now() });
  }

  // Verified. Replace the source, keeping its exact name where possible so
  // nothing else in the library (subtitles, artwork, .nfo) loses its partner.
  const newSize = fs.statSync(dst).size;
  const finalPath = path.extname(src).toLowerCase() === ext.toLowerCase()
    ? src
    : src.replace(/\.[^.]+$/, '') + ext;
  try {
    fs.rmSync(src, { force: true });
    fs.renameSync(dst, finalPath);
  } catch (e) {
    // The source is gone but the rename failed — surface it loudly; the encoded
    // file is still on disk under its temp name and can be renamed by hand.
    note(`CRITICAL: ${path.basename(src)} replaced but rename failed: ${e.message}. Encoded file is at ${dst}`);
    return setState('failed', { error: `replace failed after delete — encoded file is at ${dst}: ${e.message}`, ended_at: Date.now() });
  }

  // Repoint the library at the new file.
  const table = job.file_kind === 'episode' ? 'episode_files' : 'movie_files';
  db.prepare(`UPDATE ${table} SET path = ?, filename = ?, size = ? WHERE id = ?`)
    .run(finalPath, path.basename(finalPath), newSize, job.file_id);

  const fresh = await probeOne(finalPath);
  if (!fresh.error) {
    db.prepare(`UPDATE media_info SET path=?, size=?, mtime=?, duration=?, container=?, vcodec=?, width=?, height=?,
                 pix_fmt=?, hdr=?, vkbps=?, acodec=?, achannels=?, akbps=?, audio_json=?, probed_at=?, probe_error=NULL
                 WHERE file_kind=? AND file_id=?`)
      .run(finalPath, fresh.size, fresh.mtime, fresh.duration, fresh.container, fresh.vcodec, fresh.width,
        fresh.height, fresh.pix_fmt, fresh.hdr, fresh.vkbps, fresh.acodec, fresh.achannels, fresh.akbps,
        fresh.audio_json, Date.now(), job.file_kind, job.file_id);
  }

  const saved = Number(info.size) - newSize;
  note(`Done ${path.basename(finalPath)} — saved ${(saved / 2 ** 30).toFixed(2)} GB`);
  log(`Optimizer: ${path.basename(finalPath)} saved ${(saved / 2 ** 30).toFixed(2)} GB`);
  setState('done', {
    new_size: newSize, path: finalPath, pct: 100, ended_at: Date.now(),
    // Say which route actually worked, so "dropped the lossless track" is never
    // a silent outcome the owner discovers later.
    reason: audioMode === 'drop'
      ? `${plan.reason} (kept the existing ${String(plan.keepAudio.codec).toUpperCase()} ${plan.keepAudio.ch}ch track, dropped the lossless)`
      : plan.reason,
    new_summary: fresh.error ? null : summarize({ ...fresh, size: newSize })
  });
}

// ---- Adding a compatible audio track ------------------------------------
//
// The one operation allowed to touch a 4K HDR file, because it provably cannot
// harm the picture: the video stream is COPIED, never decoded, and an extra
// audio track is appended alongside the existing ones. Nothing is removed.
//
// The owner's actual requirement is "do not lose HDR", and HDR is only lost when
// video is re-encoded. So rather than avoid these files, every job here PROVES
// the picture is untouched: it hashes the video bitstream before and after, and
// rejects the result if a single bit differs. That is a stronger guarantee than
// not opening the file, because it is verified rather than assumed.
//
// Why it is needed: Apple TV cannot decode DTS or TrueHD at all, and its HDMI
// audio passthrough did not ship in tvOS 26. When a film carries only DTS, the
// server must re-encode the audio on the fly — and with the Apple TV app's
// stereo default, that means the surround system gets a stereo downmix. An
// appended E-AC-3 5.1 track is copied straight through instead (src/hls.js
// prefers E-AC-3 above every other codec), so the projector gets real surround
// with no server work at all.

// Codecs a file can already carry that make this unnecessary.
const APPLE_COPYABLE = new Set(['aac', 'ac3', 'eac3', 'mp3', 'alac']);

// MD5 of the VIDEO BITSTREAM alone — not the container, not the file. Copying a
// stream into a new container changes the file completely while leaving this
// identical, which is exactly the property we need to test.
async function videoStreamHash(file) {
  const bin = ffmpegBin();
  if (!bin) return null;
  const out = await run(bin, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], 1800000);
  const m = /MD5=([0-9a-f]+)/i.exec(String(out || ''));
  return m ? m[1] : null;
}

// Does this file need a compatible surround track, and which stream should it be
// built from? Applies to any file, protected or not — this operation is safe for
// both by construction.
export function planAddAudio(info) {
  if (!info || info.probe_error) return { need: false, reason: 'not probed' };
  let audio = [];
  try { audio = JSON.parse(info.audio_json || '[]'); } catch {}
  if (!audio.length) return { need: false, reason: 'no audio streams' };

  // Already has something Apple/Roku/Android can play natively in surround.
  const copyable = audio.filter((a) => APPLE_COPYABLE.has(String(a.codec).toLowerCase()));
  if (copyable.some((a) => (a.ch || 0) >= 6)) {
    return { need: false, reason: 'already has a copyable surround track' };
  }

  // Build from the richest track available — most channels wins, then the
  // lossless one, so the added track comes from the best source in the file.
  const src = audio.slice().sort((a, b) => (b.ch || 0) - (a.ch || 0))[0];
  if (!src) return { need: false, reason: 'no usable source track' };

  return {
    need: true,
    srcIndex: src.i,
    srcDesc: `${src.codec}/${src.ch || '?'}ch`,
    lang: src.lang || null,
    channels: Math.min(src.ch || 6, AUDIO_MAX_CH),
    reason: `add E-AC-3 ${Math.min(src.ch || 6, AUDIO_MAX_CH) > 2 ? '5.1' : 'stereo'} built from ${src.codec}/${src.ch || '?'}ch`,
    existing: audio.length
  };
}

// Do it. Encode → prove the video is untouched → only then swap the file in.
// `dryRun` writes the new file next to the source and leaves both in place so
// the result can be inspected before anything is replaced.
export async function addCompatibleAudio(db, kind, fileId, { log = () => {}, dryRun = false } = {}) {
  ensureSchema(db);
  const info = db.prepare('SELECT * FROM media_info WHERE file_kind = ? AND file_id = ?').get(kind, fileId);
  if (!info) return { ok: false, error: 'not probed' };
  const src = info.path;
  if (!fs.existsSync(src)) return { ok: false, error: 'file is gone' };

  const plan = planAddAudio(info);
  if (!plan.need) return { ok: false, error: plan.reason };

  const st = fs.statSync(src);
  if (st.size !== Number(info.size)) return { ok: false, error: 'file changed since it was probed — rescan first' };
  if (freeSpaceOn(src) < st.size * 1.2) return { ok: false, error: `not enough free space on ${src.slice(0, 2)}` };

  const dst = src.replace(/\.[^.]+$/, '') + TMP_SUFFIX + path.extname(src);
  fs.rmSync(dst, { force: true });

  log(`${path.basename(src)} — ${plan.reason}`);
  log('  hashing the source video stream…');
  const beforeHash = await videoStreamHash(src);
  if (!beforeHash) { return { ok: false, error: 'could not hash the source video' }; }

  const n = plan.existing;                       // output index of the appended track
  const args = [
    '-hide_banner', '-nostdin', '-y', '-i', src,
    '-map', '0', '-map', `0:a:${plan.srcIndex}`, '-map', '-0:d?',
    '-max_interleave_delta', '0',
    '-c', 'copy',                                 // everything copied, including video
    `-c:a:${n}`, AUDIO_CODEC, `-b:a:${n}`, `${plan.channels > 2 ? AUDIO_KBPS : 320}k`,
    `-ac:a:${n}`, String(plan.channels),
    `-metadata:s:a:${n}`, `title=Surround ${plan.channels > 2 ? '5.1' : '2.0'} (E-AC-3)`
  ];
  if (plan.lang) args.push(`-metadata:s:a:${n}`, `language=${plan.lang}`);
  args.push(dst);

  log('  encoding (video copied, one track added)…');
  const err = await runFfmpeg(args, { timeout: 3 * 3600 * 1000 });
  if (err) { fs.rmSync(dst, { force: true }); return { ok: false, error: err }; }

  // ---- The gate ----
  log('  verifying…');
  const out = await probeOne(dst);
  if (out.error) { fs.rmSync(dst, { force: true }); return { ok: false, error: 'output failed to probe' }; }

  const afterHash = await videoStreamHash(dst);
  const checks = [];
  const fail = (m) => checks.push(m);

  // THE one that matters. A single differing bit means the picture was touched.
  if (!afterHash || afterHash !== beforeHash) fail(`VIDEO BITSTREAM CHANGED (${beforeHash} → ${afterHash}) — HDR could not be guaranteed`);
  if (out.width !== info.width || out.height !== info.height) fail(`resolution changed ${info.width}x${info.height} → ${out.width}x${out.height}`);
  if (out.pix_fmt !== info.pix_fmt) fail(`pixel format changed ${info.pix_fmt} → ${out.pix_fmt}`);
  if (!!out.hdr !== !!info.hdr) fail(`HDR flag changed ${info.hdr} → ${out.hdr}`);
  const durDrift = Math.abs((out.duration || 0) - (Number(info.duration) || 0));
  if (Number(info.duration) && durDrift > Math.max(1.5, info.duration * 0.005)) fail(`duration drifted ${durDrift.toFixed(1)}s`);

  let outAudio = [];
  try { outAudio = JSON.parse(out.audio_json || '[]'); } catch {}
  if (outAudio.length !== plan.existing + 1) fail(`expected ${plan.existing + 1} audio tracks, got ${outAudio.length}`);
  const added = outAudio[outAudio.length - 1];
  if (!added || added.codec !== AUDIO_CODEC) fail(`added track is ${added && added.codec}, expected ${AUDIO_CODEC}`);
  if (added && plan.channels > 2 && (added.ch || 0) < 6) fail(`added track has ${added && added.ch} channels, expected ${plan.channels}`);
  // Additive: the file must get BIGGER. Smaller means something was dropped.
  const newSize = fs.statSync(dst).size;
  if (newSize <= st.size) fail(`output is not larger (${(newSize / 2 ** 30).toFixed(2)} vs ${(st.size / 2 ** 30).toFixed(2)} GB) — something was removed`);

  if (checks.length) {
    fs.rmSync(dst, { force: true });
    log('  REJECTED: ' + checks.join('; '));
    return { ok: false, error: 'verification failed: ' + checks.join('; '), beforeHash, afterHash };
  }

  log(`  verified — video bitstream identical (${beforeHash})`);

  if (dryRun) {
    const keep = src.replace(/\.[^.]+$/, '') + '.ADDED-AUDIO-SAMPLE' + path.extname(src);
    fs.renameSync(dst, keep);
    log(`  dry run — result left at ${keep}, original untouched`);
    return { ok: true, dryRun: true, sample: keep, beforeHash, afterHash, oldSize: st.size, newSize };
  }

  // Swap in. The original is only removed once everything above passed.
  fs.rmSync(src, { force: true });
  fs.renameSync(dst, src);
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  db.prepare(`UPDATE ${table} SET size = ? WHERE id = ?`).run(newSize, fileId);
  const fresh = await probeOne(src);
  if (!fresh.error) {
    db.prepare('UPDATE media_info SET size=?, mtime=?, acodec=?, achannels=?, audio_json=?, probed_at=? WHERE file_kind=? AND file_id=?')
      .run(fresh.size, fresh.mtime, fresh.acodec, fresh.achannels, fresh.audio_json, Date.now(), kind, fileId);
  }
  log(`  done — added ${plan.channels > 2 ? '5.1' : '2.0'} E-AC-3, +${((newSize - st.size) / 2 ** 20).toFixed(0)} MB`);
  return { ok: true, beforeHash, afterHash, oldSize: st.size, newSize };
}

// ---- Automatic mode ----------------------------------------------------

// The optimizer as a standing background service rather than something a human
// drives. It wakes on a timer, probes whatever the scanner has newly imported,
// queues what's worth doing, and works the queue — so media added next month
// gets the same treatment as media added today, with nobody watching it happen.
//
// Three rules keep it a good citizen on a box whose day job is serving video:
//   1. It never encodes while somebody is watching. Playback always wins.
//   2. One job at a time, and it stops the moment a viewer appears.
//   3. It never retries a file that already failed (see enqueue).
export const auto = {
  enabled: false,
  running: false,
  phase: 'idle',      // idle | probing | working | paused
  lastRun: 0,
  lastError: null,
  probed: 0,
  completed: 0,
  reclaimedBytes: 0,
  timer: null
};

const AUTO_TICK_MS = 10 * 60 * 1000;   // how often to look for new work
const AUTO_SETTLE_MS = 3 * 60 * 1000;  // quiet time required after the last viewer leaves

// `isBusy()` is supplied by the server and reports whether anyone is streaming.
export function startAuto(db, {
  log = () => {},
  isBusy = () => false,
  allow4kVideo = false,
  allowHdrVideo = false,
  profiles = ['audio'],       // which profiles run unattended
  batch = 5                   // jobs per wake-up, so it never runs away
} = {}) {
  if (auto.timer) return;
  ensureSchema(db);
  auto.enabled = true;
  log('Optimizer: automatic mode on (' + profiles.join(', ') + ').');

  const tick = async () => {
    if (auto.running) return;
    auto.running = true;
    try {
      // Playback beats housekeeping, always.
      if (isBusy()) { auto.phase = 'paused'; return; }

      // 1. Probe anything the scanner has imported since last time. Cheap, and
      //    it's what makes new media get picked up without anyone asking.
      auto.phase = 'probing';
      const n = await runProbeScan(db, { log });
      auto.probed += n;
      if (n) log(`Optimizer: probed ${n} newly added file(s).`);

      if (isBusy()) { auto.phase = 'paused'; return; }

      // 2. Queue a small batch of the biggest wins in the allowed profiles.
      auto.phase = 'working';
      const { items } = analyze(db, { allow4kVideo, allowHdrVideo });
      const pool = items.filter((i) => profiles.includes(i.profile));
      let queued = 0;
      for (const it of pool) {
        if (queued >= batch) break;
        const r = enqueue(db, it.kind, it.fileId, { allow4kVideo, allowHdrVideo });
        if (r.jobId && !r.error) queued++;
      }

      // Surround tracks are opted into separately from the size-reduction
      // profiles: they make files bigger, and they are the only thing allowed
      // to touch a 4K HDR file, so switching one on must not switch on the other.
      if (profiles.includes('addaudio')) {
        for (const it of surroundCandidates(db)) {
          if (queued >= batch) break;
          const r = enqueueAddAudio(db, it.kind, it.fileId);
          if (r.jobId && !r.error) queued++;
        }
      }

      // 3. Work the queue, bailing out the instant somebody starts watching.
      //    The in-flight job is returned to the queue, not lost.
      const before = db.prepare("SELECT COALESCE(SUM(old_size - new_size),0) b FROM optimize_jobs WHERE state='done'").get().b;
      worker.stop = false;
      const watcher = setInterval(() => { if (isBusy()) worker.stop = true; }, 15000);
      try {
        await runQueue(db, { log, allow4kVideo, allowHdrVideo });
      } finally {
        clearInterval(watcher);
      }
      const after = db.prepare("SELECT COALESCE(SUM(old_size - new_size),0) b FROM optimize_jobs WHERE state='done'").get().b;
      const gained = Number(after) - Number(before);
      if (gained > 0) {
        auto.reclaimedBytes = Number(after);
        auto.completed = db.prepare("SELECT COUNT(*) n FROM optimize_jobs WHERE state='done'").get().n;
        log(`Optimizer: reclaimed ${(gained / 2 ** 30).toFixed(2)} GB this pass.`);
      }
      auto.lastRun = Date.now();
      auto.lastError = null;
    } catch (e) {
      auto.lastError = e.message;
      log('Optimizer auto error: ' + e.message);
    } finally {
      auto.phase = 'idle';
      auto.running = false;
    }
  };

  // Wait for boot, the first scan, and any first-load playback to settle before
  // touching a disk in anger.
  auto.timer = setInterval(tick, AUTO_TICK_MS);
  setTimeout(tick, AUTO_SETTLE_MS);
}

export function stopAuto(log = () => {}) {
  if (auto.timer) { clearInterval(auto.timer); auto.timer = null; }
  auto.enabled = false;
  worker.stop = true;   // put any in-flight job back in the queue
  auto.phase = 'idle';
  log('Optimizer: automatic mode off.');
}

// ---- Status ------------------------------------------------------------

export function status(db) {
  ensureSchema(db);
  const counts = {};
  for (const r of db.prepare('SELECT state, COUNT(*) n FROM optimize_jobs GROUP BY state').all()) counts[r.state] = r.n;
  const reclaimed = db.prepare("SELECT COALESCE(SUM(old_size - new_size), 0) AS b FROM optimize_jobs WHERE state = 'done'").get().b;
  const probed = db.prepare('SELECT COUNT(*) n FROM media_info WHERE probe_error IS NULL').get().n;
  return {
    scan: { running: scan.running, done: scan.done, total: scan.total, error: scan.error },
    auto: { enabled: auto.enabled, phase: auto.phase, lastRun: auto.lastRun, lastError: auto.lastError },
    worker: { running: worker.running, current: worker.current },
    jobs: counts,
    reclaimedBytes: Number(reclaimed) || 0,
    probed,
    scannable: scannableFiles(db).length,
    nvenc: nvencAvailable(),
    log: worker.log.slice(-60)
  };
}

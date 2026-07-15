// ---------------------------------------------------------------------------
// HLS transcoding for the Apple TV (AVPlayer) client.
//
// AVPlayer can't consume the fragmented-MP4 transcode pipe the web player uses,
// so files whose container isn't natively playable (mkv/avi/…) — or that need
// subtitles, which AVPlayer only accepts as an HLS WebVTT rendition — are
// served here as HLS. Everything is scoped to /api/hls/*.
//
// v2 — VOD playlists + seek-on-demand (replaces the "event" live playlist):
//  * index.m3u8 is a FULL pre-generated VOD playlist (uniform 6s segments,
//    ENDLIST) built from the file's probed duration. AVPlayer therefore shows
//    the real duration and a full scrub bar instead of a "LIVE" badge, resume
//    works, and Live TV can join a program in progress.
//  * Segments are transcoded on demand: a request for a segment we haven't
//    produced yet restarts ffmpeg at that offset (-ss n*6, absolute timestamps
//    via -copyts, -start_number n). Segment numbering is absolute, so segments
//    cached from earlier runs stay valid across seeks.
//  * Video is ALWAYS re-encoded with keyframes forced every 6s so the segment
//    grid exactly matches the playlist (copying the source video would split
//    at source keyframes and drift from the uniform playlist). NVENC when
//    available (same detection as the web transcode path), else libx264.
//  * master.m3u8 lists WebVTT subtitle renditions (sidecar + embedded + AI)
//    on top of the video variant, so the native tvOS subtitle picker works.
//
// Wired from src/server.js:
//     import { registerHls } from './hls.js';
//     registerHls(app, db, { allSubtitleTracks });
//
// NOTE: transcoding can't be exercised by the tvOS CI — verify on-device.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegBin, playInfo, status as ffStatus } from './ffmpeg.js';

const ROOT = path.join(os.tmpdir(), 'marquee-hls');
const IDLE_MS = 90 * 1000;      // kill a session after this long with no request
const MAX_SESSIONS = 3;         // cap concurrent transcodes
const SEG_SECONDS = 6;
const SEG_WAIT_MS = 45 * 1000;  // max wait for one segment to materialize
const LOOKAHEAD = 10;           // serve-from-current-run window past the head

const sessions = new Map();     // sig -> { dir, proc, startSeg, done, lastAccess }
const infoCache = new Map();    // `${path}:${optsig}` -> { at, info }

function audioOptsFromQuery(q) {
  return {
    forceStereo: q.audio !== 'surround',
    dboost: q.dboost || 'normal',
    night: q.night === '1',
    norm: q.norm === '1'
  };
}

function fileRow(db, kind, fileId) {
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  return db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(fileId);
}

function optsig(opts) {
  return `${opts.forceStereo ? 's' : 'x'}-${opts.dboost}-${opts.night ? 'n' : ''}-${opts.norm ? 'l' : ''}`;
}
function sig(kind, fileId, opts) {
  return `${kind}-${fileId}-${optsig(opts)}`.replace(/[^a-z0-9-]/gi, '');
}

// probe (cached ~10 min) — the playlist, master, and encoder all need it.
async function cachedInfo(filePath, opts) {
  const key = `${filePath}:${optsig(opts)}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.info;
  const info = await playInfo(filePath, opts);
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

// The query string to propagate onto segment/subtitle URIs (AVPlayer resolves
// them relative to the playlist and drops its query — including ?token=, which
// every /api route requires).
function passQuery(q) {
  const keep = ['token', 'audio', 'dboost', 'night', 'norm'];
  const parts = [];
  for (const k of keep) if (q[k] != null && q[k] !== '') parts.push(`${k}=${encodeURIComponent(q[k])}`);
  return parts.length ? '?' + parts.join('&') : '';
}

function killSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  try { s.proc && s.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  sessions.delete(key);
}

// Reap idle sessions so abandoned transcodes don't pile up.
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) if (now - s.lastAccess > IDLE_MS) killSession(key);
}, 30 * 1000).unref();

// Segments ffmpeg's own playlist lists are complete (it appends AFTER closing
// the file). Merge them into the session's done-set; return the run's head.
function refreshDone(s) {
  try {
    const txt = fs.readFileSync(path.join(s.dir, 'ff.m3u8'), 'utf8');
    for (const m of txt.matchAll(/seg(\d{5})\.ts/g)) s.done.add(parseInt(m[1], 10));
  } catch {}
}

function spawnFfmpeg(s, filePath, opts, info, startSeg) {
  const ff = ffmpegBin();
  if (!ff) throw new Error('ffmpeg not installed');
  const nvenc = !!ffStatus().nvenc;
  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts'];
  if (nvenc) args.push('-hwaccel', 'auto');
  if (startSeg > 0) args.push('-ss', String(startSeg * SEG_SECONDS));
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  // Video: always re-encode with keyframes forced on the 6s grid so segment
  // boundaries exactly match the uniform VOD playlist. After a seek, -ss
  // resets timestamps to 0 and -output_ts_offset (below) shifts the muxed
  // segments back to their absolute position — the same mechanism Jellyfin
  // uses; unlike -copyts it can't produce negative-DTS mux failures.
  const scaleH = info.mode === 'transcode' ? (info.scaleH || 0) : 0;
  if (scaleH) args.push('-vf', `scale=-2:${scaleH}`);
  args.push('-force_key_frames', `expr:gte(t,n_forced*${SEG_SECONDS})`);
  if (nvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-bf', '0', '-pix_fmt', 'yuv420p');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-bf', '0', '-pix_fmt', 'yuv420p');

  // Audio: AAC stereo (device downmix), or copy when the source is already fine
  // ("direct"-eligible files only come through here for the subtitle rendition).
  const acopy = info.mode === 'direct' ? true : !!info.acopy;
  if (acopy) args.push('-c:a', 'copy');
  else {
    args.push('-c:a', 'aac', '-b:a', '192k');
    if (opts.forceStereo) args.push('-ac', '2');
  }

  if (startSeg > 0) args.push('-output_ts_offset', String(startSeg * SEG_SECONDS));
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEG_SECONDS),
    '-hls_segment_type', 'mpegts',
    '-hls_list_size', '0',
    '-start_number', String(startSeg),
    '-hls_segment_filename', path.join(s.dir, 'seg%05d.ts'),
    path.join(s.dir, 'ff.m3u8')
  );
  console.log(`[hls] start ${path.basename(filePath)} @seg${startSeg}${nvenc ? ' (nvenc)' : ' (x264)'}`);

  const proc = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  proc.on('error', (e) => console.error('[hls] spawn error:', e.message));
  proc.on('exit', (code) => { if (code && code !== 255) console.error(`[hls] ffmpeg exit ${code}: ${err.trim().split('\n').pop() || ''}`); });
  s.proc = proc;
  s.startSeg = startSeg;
}

async function ensureSession(key, filePath, opts, info, startSeg) {
  let s = sessions.get(key);
  if (!s) {
    // Evict the oldest session if we're at the cap.
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
      if (oldest) killSession(oldest[0]);
    }
    const dir = path.join(ROOT, key);
    fs.mkdirSync(dir, { recursive: true });
    s = { dir, proc: null, startSeg, done: new Set(), lastAccess: Date.now() };
    sessions.set(key, s);
    spawnFfmpeg(s, filePath, opts, info, startSeg);
  }
  s.lastAccess = Date.now();
  return s;
}

// Restart the encoder at a new offset (seek). Cached segments stay valid —
// numbering is absolute — so only the process is replaced, never the dir.
function restartAt(s, filePath, opts, info, startSeg) {
  refreshDone(s); // bank what the outgoing run finished
  try { s.proc && s.proc.kill('SIGKILL'); } catch {}
  // Drop any half-written segment the killed run left behind (it exists on
  // disk but was never listed) so it can't be served as a truncated file.
  try {
    for (const f of fs.readdirSync(s.dir)) {
      const m = /^seg(\d{5})\.ts$/.exec(f);
      if (m && !s.done.has(parseInt(m[1], 10))) fs.rmSync(path.join(s.dir, f), { force: true });
    }
  } catch {}
  spawnFfmpeg(s, filePath, opts, info, startSeg);
}

function running(s) { return s.proc && s.proc.exitCode === null; }
function head(s) {
  let h = s.startSeg - 1;
  for (const n of s.done) if (n >= s.startSeg && n > h) h = n;
  return h;
}

export function registerHls(app, db, helpers = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const allSubtitleTracks = helpers.allSubtitleTracks || (async () => []);

  const resolve = (req, reply) => {
    const kind = req.params.kind === 'episode' ? 'episode' : 'movie';
    const row = fileRow(db, kind, req.params.fileId);
    if (!row) { reply.code(404).send({ error: 'not found' }); return null; }
    return { kind, row, opts: audioOptsFromQuery(req.query || {}), q: passQuery(req.query || {}) };
  };

  // Master playlist: the video variant + every subtitle track as a WebVTT
  // rendition, so AVPlayer's native CC picker lists them.
  //
  // AVPlayer treats a rendition group with DUPLICATE NAMEs as a hard error and
  // rejects the whole master playlist — and real libraries produce duplicates
  // constantly (three "EN" sidecars + embedded "English"…). That single quirk
  // made every subtitled file refuse to play while bare files direct-played.
  // So: uniquify names, cap the list, and never advertise a CODECS attribute
  // (it's optional, and a wrong value — e.g. copied AC-3 vs the claimed AAC —
  // is another whole-playlist reject).
  app.get('/api/hls/:kind/:fileId/master.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    let lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    let tracks = [];
    try { tracks = (await allSubtitleTracks(r.row.path)).slice(0, 12); } catch {}
    const seen = new Map(); // base name -> count
    tracks.forEach((t, i) => {
      let name = String(t.label || `Subtitles ${i + 1}`).replace(/"/g, "'");
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name} ${n}`;
      const lang = /^[a-z]{2,3}$/i.test(name) ? `,LANGUAGE="${name.toLowerCase()}"` : '';
      lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",DEFAULT=NO,AUTOSELECT=NO${lang},URI="subs/${i}.m3u8${r.q}"`);
    });
    const subs = tracks.length ? ',SUBTITLES="subs"' : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=20000000${subs}`);
    lines.push(`index.m3u8${r.q}`);
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(lines.join('\n') + '\n');
  });

  // A subtitle rendition: one segment spanning the whole file, pointing at the
  // existing WebVTT endpoints (which convert/extract as needed).
  app.get('/api/hls/:kind/:fileId/subs/:idx.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    const info = await cachedInfo(r.row.path, r.opts);
    const dur = Math.max(1, info.duration || 1);
    const idx = parseInt(req.params.idx, 10) || 0;
    const base = r.kind === 'episode' ? `/api/subtitle/episode/${req.params.fileId}` : `/api/subtitle/${req.params.fileId}`;
    const q = r.q ? `${r.q}&idx=${idx}` : `?idx=${idx}`;
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(dur)}`,
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${dur.toFixed(3)},`, `${base}${q}`, '#EXT-X-ENDLIST'
    ];
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(lines.join('\n') + '\n');
  });

  // The media playlist: a complete VOD timeline built from the probed duration.
  // Serving it never waits on ffmpeg — segments are produced on demand below.
  app.get('/api/hls/:kind/:fileId/index.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    const info = await cachedInfo(r.row.path, r.opts);
    if (!info.duration) return reply.code(500).send({ error: 'could not probe duration' });
    const total = info.duration;
    const count = Math.max(1, Math.ceil(total / SEG_SECONDS));
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${SEG_SECONDS + 1}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS'
    ];
    for (let i = 0; i < count; i++) {
      const d = i === count - 1 ? Math.max(0.5, total - SEG_SECONDS * i) : SEG_SECONDS;
      lines.push(`#EXTINF:${d.toFixed(3)},`);
      lines.push(`seg${String(i).padStart(5, '0')}.ts${r.q}`);
    }
    lines.push('#EXT-X-ENDLIST');
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(lines.join('\n') + '\n');
  });

  // Segment: serve it if it's done; if not, (re)aim ffmpeg at it and wait.
  app.get('/api/hls/:kind/:fileId/:seg', async (req, reply) => {
    const m = /^seg(\d{5})\.ts$/.exec(req.params.seg);
    if (!m) return reply.code(400).send({ error: 'bad segment' });
    const n = parseInt(m[1], 10);
    const r = resolve(req, reply);
    if (!r) return;
    const info = await cachedInfo(r.row.path, r.opts);
    const key = sig(r.kind, req.params.fileId, r.opts);

    let s;
    try { s = await ensureSession(key, r.row.path, r.opts, info, n); }
    catch (e) { return reply.code(500).send({ error: e.message }); }

    const file = path.join(s.dir, req.params.seg);
    const ready = () => {
      refreshDone(s);
      if (s.done.has(n)) return true;
      // A finished run's files are all complete even if its playlist write raced.
      if (!running(s) && fs.existsSync(file)) return true;
      return false;
    };

    if (!ready()) {
      // If the current run will never produce this segment (it's behind the
      // start, too far ahead, or the process died), restart at the segment.
      if (!running(s) || n < s.startSeg || n > head(s) + LOOKAHEAD) {
        restartAt(s, r.row.path, r.opts, info, n);
      }
      const t0 = Date.now();
      while (Date.now() - t0 < SEG_WAIT_MS) {
        await new Promise((res) => setTimeout(res, 250));
        s.lastAccess = Date.now();
        if (ready()) break;
        if (!running(s) && !fs.existsSync(file)) {
          return reply.code(500).send({ error: 'transcode failed' });
        }
      }
      if (!ready()) return reply.code(504).send({ error: 'segment not ready in time' });
    }

    s.lastAccess = Date.now();
    reply.header('Content-Type', 'video/mp2t');
    return reply.send(fs.createReadStream(file));
  });
}

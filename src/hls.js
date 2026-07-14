// ---------------------------------------------------------------------------
// HLS transcoding for the Apple TV (AVPlayer) client.
//
// AVPlayer can't consume the fragmented-MP4 transcode pipe the web player uses,
// so files whose container isn't natively playable (mkv/avi/…) are served here
// as HLS: ffmpeg transcodes/remuxes into an on-disk session directory and this
// serves the growing playlist + segments. Everything is scoped to /api/hls/* —
// it does not touch any existing route.
//
// To enable, add two lines to src/server.js:
//     import { registerHls } from './hls.js';
//     registerHls(app, db);            // after `db` and `app` exist
//
// NOTE: transcoding is CPU/GPU heavy and can't be exercised by the tvOS CI —
// verify on-device with a real .mkv before relying on it in production.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegBin, playInfo } from './ffmpeg.js';

const ROOT = path.join(os.tmpdir(), 'marquee-hls');
const IDLE_MS = 90 * 1000;      // kill a session after this long with no request
const MAX_SESSIONS = 3;         // cap concurrent transcodes
const SEG_SECONDS = 6;

const sessions = new Map();     // key -> { dir, proc, lastAccess }

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

function sig(kind, fileId, opts) {
  return `${kind}-${fileId}-${opts.forceStereo ? 's' : 'x'}-${opts.dboost}-${opts.night ? 'n' : ''}-${opts.norm ? 'l' : ''}`
    .replace(/[^a-z0-9-]/gi, '');
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

async function startSession(key, filePath, opts) {
  // Evict the oldest idle session if we're at the cap.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    if (oldest) killSession(oldest[0]);
  }
  const dir = path.join(ROOT, key);
  fs.mkdirSync(dir, { recursive: true });

  const info = await playInfo(filePath, opts);   // reuse the direct/transcode decision
  const ff = ffmpegBin();
  if (!ff) throw new Error('ffmpeg not installed');

  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-hwaccel', 'auto'];
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  // Video: copy when the codec is already fine (remux); otherwise transcode to H.264.
  // NVENC is used automatically when available (see server config); libx264 is the
  // portable fallback. Tune the encoder here if a given box can't keep up at 4K.
  if (info.vcopy) {
    args.push('-c:v', 'copy');
  } else {
    if (info.scaleH) args.push('-vf', `scale=-2:${info.scaleH}`);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-bf', '0', '-pix_fmt', 'yuv420p');
  }
  // Audio: AAC stereo (with the device's downmix/night/norm), or copy if already fine.
  if (info.acopy) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
    if (opts.forceStereo) args.push('-ac', '2');
  }
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEG_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  );

  const proc = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.on('error', (e) => console.error('[hls] spawn error:', e.message));
  proc.on('exit', () => { /* leave files for in-flight requests; idle reaper cleans up */ });
  sessions.set(key, { dir, proc, lastAccess: Date.now() });
  return dir;
}

// Wait for ffmpeg to write the playlist with at least one segment listed.
async function waitForPlaylist(dir, timeoutMs = 20000) {
  const m3u8 = path.join(dir, 'index.m3u8');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const txt = fs.readFileSync(m3u8, 'utf8');
      if (txt.includes('.ts')) return txt;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export function registerHls(app, db) {
  fs.mkdirSync(ROOT, { recursive: true });

  app.get('/api/hls/:kind/:fileId/index.m3u8', async (req, reply) => {
    const kind = req.params.kind === 'episode' ? 'episode' : 'movie';
    const row = fileRow(db, kind, req.params.fileId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const opts = audioOptsFromQuery(req.query || {});
    const key = sig(kind, req.params.fileId, opts);

    let s = sessions.get(key);
    if (s && (!s.proc || s.proc.exitCode === null)) {
      s.lastAccess = Date.now();
    } else {
      try { await startSession(key, row.path, opts); }
      catch (e) { return reply.code(500).send({ error: e.message }); }
      s = sessions.get(key);
    }
    const txt = await waitForPlaylist(s.dir);
    if (!txt) return reply.code(504).send({ error: 'transcode did not start in time' });
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(txt);
  });

  app.get('/api/hls/:kind/:fileId/:seg', async (req, reply) => {
    const seg = req.params.seg;
    if (!/^seg\d{5}\.ts$/.test(seg)) return reply.code(400).send({ error: 'bad segment' });
    const kind = req.params.kind === 'episode' ? 'episode' : 'movie';
    // Find the session dir this segment belongs to (any matching key for the file).
    const prefix = `${kind}-${req.params.fileId}-`;
    const entry = [...sessions.entries()].find(([k]) => k.startsWith(prefix));
    if (!entry) return reply.code(404).send({ error: 'no session' });
    entry[1].lastAccess = Date.now();
    const file = path.join(entry[1].dir, seg);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'segment not ready' });
    reply.header('Content-Type', 'video/mp2t');
    return reply.send(fs.createReadStream(file));
  });
}

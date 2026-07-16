// ---------------------------------------------------------------------------
// HLS delivery for the Apple TV (AVPlayer) client. Scoped to /api/hls/*.
//
// v3 — REMUX-first (the fix for "Plex direct-plays this, Marquee doesn't").
// The Apple TV plays HEVC (incl. Main10/HDR10), H.264, AAC, AC3 and EAC3
// (Dolby Digital+/Atmos) natively — it just can't read the MKV *container* and
// won't accept an MP4 with certain quirks over plain range. So the ONLY thing
// most files need is a container change, not a re-encode. v1/v2 re-encoded
// everything (browser-style), which made 1080p HEVC come out black and 4K HDR
// HEVC fail to start on the 1050 Ti.
//
// Now: probe the streams and COPY every stream the Apple TV supports into a
// fragmented-MP4 HLS (VOD) — a fast, lossless remux — re-encoding ONLY a stream
// whose codec genuinely isn't supported. We serve ffmpeg's own playlist (copy
// can't produce the uniform segments a synthetic playlist assumes; boundaries
// land on the source keyframes), rewriting the segment/init URIs to carry the
// ?token=. master.m3u8 still lists WebVTT subtitle renditions for the native CC
// picker.
//
// Wired from src/server.js:
//     import { registerHls } from './hls.js';
//     registerHls(app, db, { allSubtitleTracks });
//
// NOTE: transcode/remux can't be exercised by the tvOS CI — verify on-device
// (hit GET /api/hls/debug as admin for the live ffmpeg args + stderr).
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegBin, probe, status as ffStatus } from './ffmpeg.js';

const ROOT = path.join(os.tmpdir(), 'marquee-hls');
const IDLE_MS = 120 * 1000;     // kill a session this long after its last request
const MAX_SESSIONS = 4;
const SEG_SECONDS = 6;
const WAIT_MS = 45 * 1000;      // max wait for a segment/playlist to materialize

// Codecs the Apple TV (tvOS/AVPlayer) decodes natively → copy, never re-encode.
const APPLE_VIDEO = new Set(['h264', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1']);
const APPLE_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3', 'alac']);

const sessions = new Map();     // key -> session
const probeCache = new Map();   // path -> { at, info }

// ---- Debug log: a plain file the on-server operator (or a Claude with shell
// access to the Dell) can `cat` WITHOUT auth, plus an in-memory ring the admin
// /api/hls/debug endpoint returns. Every playback decision, ffmpeg spawn (full
// command), exit code + stderr, and playlist/segment stall is recorded — so the
// exact failure on a REAL file is visible instead of guessed at. ----
const LOG_FILE = path.join(ROOT, 'debug.log');
const recentLog = [];
function logEvent(event, data = {}) {
  const rec = { t: new Date().toISOString(), event, ...data };
  recentLog.push(rec);
  if (recentLog.length > 80) recentLog.shift();
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n'); } catch {}
  console.log(`[hls] ${event}`, JSON.stringify(data));
}

function audioOptsFromQuery(q) {
  return { forceStereo: q.audio !== 'surround' };
}
function fileRow(db, kind, fileId) {
  const table = kind === 'episode' ? 'episode_files' : 'movie_files';
  return db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(fileId);
}
function key(kind, fileId, opts) {
  return `${kind}-${fileId}-${opts.forceStereo ? 's' : 'x'}`.replace(/[^a-z0-9-]/gi, '');
}

// Probe once (cached ~10 min): the video/audio codec names + duration decide
// copy-vs-transcode and feed the subtitle rendition timing.
async function codecInfo(filePath) {
  const hit = probeCache.get(filePath);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.info;
  const p = await probe(filePath);
  const streams = (p && p.streams) || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const info = {
    vcodec: v && String(v.codec_name || '').toLowerCase(),
    vtag: v && String(v.codec_tag_string || '').toLowerCase(),
    acodec: a && String(a.codec_name || '').toLowerCase(),
    duration: parseFloat(p && p.format && p.format.duration) || 0
  };
  probeCache.set(filePath, { at: Date.now(), info });
  return info;
}

// Propagate the query the segment/init/subtitle URIs need (AVPlayer resolves
// them relative to the playlist and drops the query — including ?token=).
function passQuery(q) {
  const keep = ['token', 'audio'];
  const parts = [];
  for (const k of keep) if (q[k] != null && q[k] !== '') parts.push(`${k}=${encodeURIComponent(q[k])}`);
  return parts.length ? '?' + parts.join('&') : '';
}

function killSession(k) {
  const s = sessions.get(k);
  if (!s) return;
  try { s.proc && s.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  sessions.delete(k);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastAccess > IDLE_MS) killSession(k);
}, 30 * 1000).unref();

const running = (s) => s.proc && s.proc.exitCode === null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until `file` exists (or the process finished producing output).
async function waitFor(s, file) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    if (fs.existsSync(file)) return true;
    if (!running(s)) return fs.existsSync(file);
    await sleep(200);
    s.lastAccess = Date.now();
  }
  return fs.existsSync(file);
}

// Wait until ffmpeg's playlist actually LISTS a segment (it can create ff.m3u8
// a beat before the first .m4s lands — serving that empty playlist makes
// AVPlayer give up with nothing to play). Returns the playlist text, or null.
async function waitForPlaylist(s, ff) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    let txt = '';
    try { txt = fs.readFileSync(ff, 'utf8'); } catch {}
    if (/\.m4s/.test(txt)) return txt;
    if (!running(s)) return /\.m4s/.test(txt) ? txt : null;  // died before a segment
    await sleep(200);
    s.lastAccess = Date.now();
  }
  try { return fs.readFileSync(ff, 'utf8'); } catch { return null; }
}

function spawnFfmpeg(s, filePath, opts, ci) {
  const ff = ffmpegBin();
  if (!ff) throw new Error('ffmpeg not installed');
  const nvenc = !!ffStatus().nvenc;
  const vcopy = !!ci.vcodec && APPLE_VIDEO.has(ci.vcodec);
  const acopy = !!ci.acodec && APPLE_AUDIO.has(ci.acodec);

  const args = ['-hide_banner', '-loglevel', 'error'];
  // GPU decode only helps when we must actually re-encode video; a copy needs no
  // decode at all (and the hwaccel path is exactly what mangled 10-bit HEVC).
  if (!vcopy && nvenc) args.push('-hwaccel', 'auto');
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (vcopy) {
    args.push('-c:v', 'copy');
    // AVPlayer only decodes HEVC tagged 'hvc1'; a file tagged 'hev1' plays
    // audio with NO VIDEO. Re-tag on the copy (bitstream is identical) — this
    // is THE fix for HEVC files that direct-played as audio-only.
    if (ci.vcodec === 'hevc' || ci.vcodec === 'h265') args.push('-tag:v', 'hvc1');
  } else {
    // Truly-unsupported video (rare: VC-1, MPEG-2…): re-encode to H.264 with
    // IDR keyframes on the 6s grid.
    args.push('-force_key_frames', `expr:gte(t,n_forced*${SEG_SECONDS})`);
    if (nvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-bf', '0',
                         '-forced-idr', '1', '-profile:v', 'high', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-bf', '0',
                   '-sc_threshold', '0', '-pix_fmt', 'yuv420p');
  }

  if (acopy) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '256k');
    if (opts.forceStereo) args.push('-ac', '2');
  }

  // Fragmented-MP4 HLS, VOD. AVPlayer requires HEVC in fMP4 (not mpegts) anyway.
  // ffmpeg writes its own keyframe-aligned playlist to ff.m3u8; we serve a
  // token-rewritten copy of it.
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEG_SECONDS),
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    // EVENT, not VOD: AVPlayer fetches a VOD playlist ONCE, so while the remux
    // is still producing segments it would see only the first one or two and
    // stall. An EVENT playlist tells AVPlayer to re-fetch as it grows; we append
    // #EXT-X-ENDLIST when ffmpeg finishes, which makes it a complete/seekable VOD.
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(s.dir, 'seg%05d.m4s'),
    path.join(s.dir, 'ff.m3u8')
  );

  s.vcopy = vcopy; s.acopy = acopy;
  s.lastArgs = `${ff} ${args.join(' ')}`;
  logEvent('spawn', {
    file: path.basename(filePath), vcodec: ci.vcodec, vtag: ci.vtag, acodec: ci.acodec,
    videoMode: vcopy ? 'copy' : 'transcode', audioMode: acopy ? 'copy' : 'aac', retagHvc1: vcopy && (ci.vcodec === 'hevc' || ci.vcodec === 'h265'),
    cmd: s.lastArgs
  });

  const proc = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => { s.err = ((s.err || '') + d).slice(-4000); s.lastErr = s.err.trim(); });
  proc.on('error', (e) => logEvent('spawn_error', { file: path.basename(filePath), error: e.message }));
  proc.on('exit', (code) => {
    s.lastExit = code;
    logEvent('exit', { file: path.basename(filePath), code, stderr: (s.err || '').trim().slice(-1500) });
  });
  s.proc = proc;
}

async function ensureSession(k, filePath, opts, ci) {
  let s = sessions.get(k);
  if (s) { s.lastAccess = Date.now(); return s; }
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    if (oldest) killSession(oldest[0]);
  }
  const dir = path.join(ROOT, k);
  fs.mkdirSync(dir, { recursive: true });
  s = { dir, proc: null, lastAccess: Date.now() };
  sessions.set(k, s);
  spawnFfmpeg(s, filePath, opts, ci);
  return s;
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

  // Log EVERY request the Apple TV makes, in order — the request SEQUENCE is the
  // real diagnostic: master→(nothing) means AVPlayer rejected the master;
  // master→index→init→segN→index(refetch) means it's working. `range` shows
  // whether AVPlayer is byte-seeking a segment.
  app.addHook('onRequest', async (req) => {
    const m = /^\/api\/hls\/(movie|episode)\/(\d+)\/([^?]*)/.exec(req.url);
    if (m) logEvent('request', { res: decodeURIComponent(m[3]), kind: m[1], fileId: m[2], range: req.headers.range || null, ua: (req.headers['user-agent'] || '').slice(0, 40) });
  });

  // Playback decision for the Apple TV: can AVPlayer DIRECT-PLAY this file, or
  // must it go through the HLS remux? Direct play needs a native container
  // (mp4/m4v/mov) with codecs AVPlayer reads as-is — notably HEVC must be tagged
  // 'hvc1' (a 'hev1' tag is audio-only), and the container can't be Matroska.
  // Anything else routes to /api/hls (which remuxes: retags HEVC, repackages
  // the container — a fast lossless copy, not a re-encode).
  app.get('/api/hls/decide/:kind/:fileId', async (req, reply) => {
    const kind = req.params.kind === 'episode' ? 'episode' : 'movie';
    const row = fileRow(db, kind, req.params.fileId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ci = await codecInfo(row.path);
    const ext = path.extname(row.path).toLowerCase();
    const nativeContainer = ['.mp4', '.m4v', '.mov'].includes(ext);
    const directVideo = ci.vcodec === 'h264'
      || (ci.vcodec === 'hevc' && ci.vtag === 'hvc1');   // hev1 → must remux
    const directAudio = !ci.acodec || ['aac', 'ac3', 'eac3', 'mp3', 'alac'].includes(ci.acodec);
    const direct = nativeContainer && directVideo && directAudio;
    logEvent('decide', { file: path.basename(row.path), direct, vcodec: ci.vcodec, vtag: ci.vtag, acodec: ci.acodec, container: ext });
    return { direct, vcodec: ci.vcodec, vtag: ci.vtag, acodec: ci.acodec, container: ext };
  });

  // Admin diagnostics: what is the transcoder actually doing?
  app.get('/api/hls/debug', async (req, reply) => {
    if (!req.user || req.user.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
    return {
      logFile: LOG_FILE,
      recent: recentLog.slice(-40),
      sessions: [...sessions.entries()].map(([k, s]) => ({
        key: k, running: running(s), vcopy: s.vcopy, acopy: s.acopy,
        lastExit: s.lastExit ?? null, idleSec: Math.round((Date.now() - s.lastAccess) / 1000),
        args: s.lastArgs || null, lastErr: s.lastErr || null
      }))
    };
  });

  // Master: the video variant + WebVTT subtitle renditions (unique NAMEs; no
  // CODECS attribute — a wrong one rejects the whole playlist).
  app.get('/api/hls/:kind/:fileId/master.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    let tracks = [];
    try { tracks = (await allSubtitleTracks(r.row.path)).slice(0, 12); } catch {}
    const seen = new Map();
    tracks.forEach((t, i) => {
      let name = String(t.label || `Subtitles ${i + 1}`).replace(/"/g, "'");
      const n = (seen.get(name) || 0) + 1; seen.set(name, n);
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

  // A subtitle rendition: one WebVTT covering the whole file.
  app.get('/api/hls/:kind/:fileId/subs/:idx.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    const ci = await codecInfo(r.row.path);
    const dur = Math.max(1, ci.duration || 1);
    const idx = parseInt(req.params.idx, 10) || 0;
    const base = r.kind === 'episode' ? `/api/subtitle/episode/${req.params.fileId}` : `/api/subtitle/${req.params.fileId}`;
    const q = r.q ? `${r.q}&idx=${idx}` : `?idx=${idx}`;
    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(dur)}`,
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${dur.toFixed(3)},`, `${base}${q}`, '#EXT-X-ENDLIST'
    ];
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(lines.join('\n') + '\n');
  });

  // The media playlist: ffmpeg's own (keyframe-aligned) playlist, with the init
  // + segment URIs rewritten to carry the token. Grows as ffmpeg produces; we
  // add ENDLIST once ffmpeg has finished if it didn't write one.
  app.get('/api/hls/:kind/:fileId/index.m3u8', async (req, reply) => {
    const r = resolve(req, reply);
    if (!r) return;
    const ci = await codecInfo(r.row.path);
    const k = key(r.kind, req.params.fileId, r.opts);
    let s;
    try { s = await ensureSession(k, r.row.path, r.opts, ci); }
    catch (e) { return reply.code(500).send({ error: e.message }); }

    const ff = path.join(s.dir, 'ff.m3u8');
    let pl = await waitForPlaylist(s, ff);
    if (!pl) {
      // ffmpeg produced no playable segment — surface the real reason (it's the
      // #1 thing to know when a file won't play).
      const why = (s.lastErr || '').split('\n').pop() || 'transcoder produced no output';
      logEvent('no_segments', { file: path.basename(r.row.path), why, exit: s.lastExit ?? null });
      return reply.code(500).send({ error: `playback failed: ${why}` });
    }
    logEvent('playlist_served', { file: path.basename(r.row.path), segments: (pl.match(/\.m4s/g) || []).length, running: running(s) });
    pl = pl
      .replace(/URI="init\.mp4"/g, `URI="init.mp4${r.q}"`)
      .replace(/^(seg\d+\.m4s)\s*$/gm, (m, f) => `${f}${r.q}`);
    if (!running(s) && !/#EXT-X-ENDLIST/.test(pl)) pl += '#EXT-X-ENDLIST\n';
    reply.header('Content-Type', 'application/vnd.apple.mpegurl');
    return reply.send(pl);
  });

  // init.mp4 (fMP4 header) or a media segment.
  app.get('/api/hls/:kind/:fileId/:seg', async (req, reply) => {
    const name = req.params.seg;
    if (!/^(init\.mp4|seg\d+\.m4s)$/.test(name)) return reply.code(400).send({ error: 'bad segment' });
    const r = resolve(req, reply);
    if (!r) return;
    const ci = await codecInfo(r.row.path);
    const k = key(r.kind, req.params.fileId, r.opts);
    let s;
    try { s = await ensureSession(k, r.row.path, r.opts, ci); }
    catch (e) { return reply.code(500).send({ error: e.message }); }

    const file = path.join(s.dir, name);
    if (!(await waitFor(s, file))) {
      return reply.code(running(s) ? 504 : 500).send({ error: 'segment not available' });
    }
    s.lastAccess = Date.now();
    reply.header('Content-Type', 'video/mp4');
    return reply.send(fs.createReadStream(file));
  });
}

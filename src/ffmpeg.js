// FFmpeg integration: detection, one-click install, media probing, and
// transcode streaming. FFmpeg is optional — without it the server behaves
// exactly as before (direct streaming only). With it, files a browser can't
// play (mkv/hevc/ac3/avi/…) are remuxed or transcoded to fragmented MP4 on
// the fly, with keyframe-fast seeking via `-ss`.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// A static Windows build with libx264 + h264_nvenc; ~90 MB zip, extracts to
// <version>_build/bin/{ffmpeg,ffprobe}.exe. Downloaded into tools/ (git-ignored).
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe'; // bsdtar — extracts zips on Win10+

let ffmpegPath = null;
let ffprobePath = null;
let hasNvenc = false;
let maxTranscodeHeight = 0; // config cap on re-encoded video height (0 = auto/off)
// Remote ceiling: a viewer coming in over the internet (behind Caddy) can't carry
// a full-bitrate 4K stream, so remote sessions are capped to this height/bitrate and
// re-encoded to fit. LOCAL sessions are never touched (full quality). 0 = disabled.
let remoteMaxHeight = 1080;
let remoteMaxKbps = 6000;
const probeCache = new Map(); // path+mtime -> probe json

function tryRun(cmd, args) {
  return new Promise((resolve) => {
    if (!cmd) return resolve(null);
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout)));
  });
}

// Find bin/ffmpeg.exe anywhere under the tools dir (the zip nests it in a
// versioned folder we don't want to hardcode).
function findInTools(toolsDir, exe) {
  try {
    const stack = [toolsDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.toLowerCase() === exe) return p;
      }
    }
  } catch {}
  return null;
}

export async function detectFfmpeg(root, config = {}) {
  maxTranscodeHeight = Number(config.maxTranscodeHeight) || 0; // e.g. 1080 to force a cap
  remoteMaxHeight = config.remoteMaxHeight != null ? Number(config.remoteMaxHeight) : 1080; // 0 disables the remote cap
  remoteMaxKbps = config.remoteMaxBitrateKbps != null ? Number(config.remoteMaxBitrateKbps) : 6000;
  const toolsDir = path.join(root, 'tools');
  const candidates = [
    config.ffmpegPath,
    findInTools(toolsDir, 'ffmpeg.exe'),
    'ffmpeg' // PATH
  ].filter(Boolean);
  ffmpegPath = null; ffprobePath = null; hasNvenc = false;
  for (const c of candidates) {
    if (await tryRun(c, ['-version'])) { ffmpegPath = c; break; }
  }
  if (!ffmpegPath) return status();
  const probeCandidates = [
    config.ffprobePath,
    ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || '')),
    findInTools(toolsDir, 'ffprobe.exe'),
    'ffprobe'
  ].filter(Boolean);
  for (const c of probeCandidates) {
    if (await tryRun(c, ['-version'])) { ffprobePath = c; break; }
  }
  const encoders = (await tryRun(ffmpegPath, ['-hide_banner', '-encoders'])) || '';
  hasNvenc = false;
  if (encoders.includes('h264_nvenc')) {
    // Listed ≠ usable (needs an NVIDIA driver present) — prove it with a
    // one-frame encode; fall back to libx264 if it fails.
    hasNvenc = (await tryRun(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=256x256', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'])) !== null;
  }
  return status();
}

export const ffmpegBin = () => ffmpegPath;

export function status() {
  return {
    available: !!(ffmpegPath && ffprobePath),
    nvenc: hasNvenc,
    installing: install.phase ? { phase: install.phase, pct: install.pct } : null,
    error: install.error
  };
}

// ---- One-click install (download zip -> extract with bsdtar -> re-detect) ----
const install = { phase: null, pct: 0, error: null };

export async function installFfmpeg(root, config) {
  if (install.phase) return; // already running
  install.error = null;
  const toolsDir = path.join(root, 'tools');
  const zipPath = path.join(toolsDir, 'ffmpeg.zip');
  try {
    fs.mkdirSync(toolsDir, { recursive: true });
    install.phase = 'downloading'; install.pct = 0;
    const res = await fetch(FFMPEG_ZIP_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const out = fs.createWriteStream(zipPath);
    let got = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (total) install.pct = Math.round((got / total) * 100);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));

    install.phase = 'extracting'; install.pct = 100;
    await new Promise((resolve, reject) => {
      execFile(fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar', ['-xf', zipPath, '-C', toolsDir],
        { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(zipPath, { force: true });

    install.phase = 'detecting';
    await detectFfmpeg(root, config);
    if (!ffmpegPath) throw new Error('extracted but ffmpeg.exe was not found');
    install.phase = null;
  } catch (e) {
    install.phase = null;
    install.error = e.message;
  }
}

// ---- Probing ----
export async function probe(filePath) {
  if (!ffprobePath) return null;
  let key;
  try { key = filePath + ':' + fs.statSync(filePath).mtimeMs; } catch { return null; }
  if (probeCache.has(key)) return probeCache.get(key);
  const out = await tryRun(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath
  ]);
  let json = null;
  try { json = JSON.parse(out); } catch {}
  probeCache.set(key, json);
  return json;
}

// Last video keyframe at or before `t` seconds. Copied (remuxed) video can only
// begin on a keyframe: ask ffmpeg to start mid-GOP and it silently emits from the
// previous keyframe anyway — up to a whole GOP of video the player doesn't know
// about, played over silence-padded audio, with the virtual timeline (and every
// subtitle cue) off by the gap for the rest of the session. That was the "audio
// lags after resume/seek" bug. Seeks on the copy path snap here first, and the
// player is told the real start. Returns `t` unchanged when it can't tell.
export async function keyframeBefore(filePath, t) {
  if (!ffprobePath || !(t > 0)) return Math.max(0, t || 0);
  // Don't PREDICT the keyframe (scenecut keyframes aren't always seekable — mkv
  // seeks land on cue points only); ASK: seek exactly like ffmpeg's demuxer will
  // and read the first video packet it produces. Its pts IS the true stream start.
  const out = await tryRun(ffprobePath, [
    '-v', 'error', '-read_intervals', `${t.toFixed(3)}%+#1`,
    '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,dts_time',
    '-of', 'json', filePath
  ]);
  try {
    const p = (JSON.parse(out || '{}').packets || [])[0];
    const ts = p ? parseFloat(p.pts_time ?? p.dts_time) : NaN;
    // Sanity: the demuxer seeks backward, so the packet must be at or before t
    // (allow a frame of slack). Anything else means seeking is broken — keep t.
    if (Number.isFinite(ts) && ts >= 0 && ts <= t + 0.1) return ts;
  } catch {}
  return t;
}

// First video keyframe AT OR AFTER `t` seconds. Skip Intro seeks here: on the
// copy path a plain seek to the intro's end snaps BACK to the previous keyframe
// (landing you inside the intro again, up to a GOP short), so instead we land on
// the first keyframe past it — you're always clear of the theme. Returns `t` if
// none is found ahead (e.g. t is beyond the last keyframe).
export async function keyframeAtOrAfter(filePath, t) {
  if (!ffprobePath || !(t > 0)) return Math.max(0, t || 0);
  const out = await tryRun(ffprobePath, [
    '-v', 'error', '-read_intervals', `${t.toFixed(3)}%+30`,
    '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames',
    '-show_entries', 'frame=pts_time', '-of', 'json', filePath
  ]);
  try {
    for (const f of (JSON.parse(out || '{}').frames || [])) {
      const ts = parseFloat(f.pts_time);
      if (Number.isFinite(ts) && ts >= t - 0.05) return ts;
    }
  } catch {}
  return t;
}

// Text-based subtitle streams embedded in the file (mkv rips usually carry
// them). Bitmap subs (PGS/VobSub) can't become WebVTT without OCR — excluded.
// Returns [{ sIndex, label }] where sIndex is the subtitle-relative stream index
// (ffmpeg's -map 0:s:N numbering).
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
export async function embeddedSubtitles(filePath) {
  const p = await probe(filePath);
  const subs = ((p && p.streams) || []).filter((s) => s.codec_type === 'subtitle');
  const out = [];
  subs.forEach((s, sIndex) => {
    if (!TEXT_SUB_CODECS.has(String(s.codec_name || '').toLowerCase())) return;
    const tags = s.tags || {};
    const lang = (tags.language || tags.LANGUAGE || '').toLowerCase();
    const title = tags.title || tags.TITLE || '';
    const flags = [s.disposition?.forced ? 'forced' : '', s.disposition?.hearing_impaired ? 'SDH' : ''].filter(Boolean).join(' ');
    const base = title || (lang && lang !== 'und' ? lang.toUpperCase() : 'Subtitles');
    out.push({ sIndex, label: `${base}${flags ? ' ' + flags : ''} (embedded)` });
  });
  return out;
}

// Extract one embedded text-subtitle stream to WebVTT at `outPath` (ffmpeg
// converts srt/ass/mov_text and strips styling). Demux-only — no video decode —
// but it does read through the file, so callers cache the result.
export function extractSubtitle(filePath, sIndex, outPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y', '-v', 'error', '-i', filePath, '-map', `0:s:${sIndex}`, '-f', 'webvtt', outPath
    ], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

// ---- Direct-play decision ----
// Chrome/Edge can natively play these container+codec combos; everything else
// goes through ffmpeg (video/audio are copied when already compatible, so an
// mkv with h264+aac is a cheap remux, not a re-encode).
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function chaptersOf(p) {
  return (p.chapters || []).map((c) => ({
    start: parseFloat(c.start_time) || 0,
    end: parseFloat(c.end_time) || 0,
    title: (c.tags && c.tags.title) || ''
  })).filter((c) => c.end > c.start);
}

// Per-device audio options (the "Audio" settings tab): `forceStereo` folds
// surround down to stereo (a two-speaker TV's own fold buries the dialogue/center
// channel); `night` compresses dynamic range; `norm` normalizes loudness. Any of
// these needs the audio re-encoded, so the file can no longer direct-play or
// audio-copy — that's what `needAudio` reflects.
export async function playInfo(filePath, { forceStereo = false, night = false, norm = false, remote = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ffmpegPath || !ffprobePath) {
    return { mode: 'direct', duration: null, reason: 'no-ffmpeg', chapters: [] };
  }
  const p = await probe(filePath);
  if (!p || !p.streams) return { mode: 'direct', duration: null, reason: 'probe-failed', chapters: [] };
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const duration = parseFloat(p.format && p.format.duration) || null;
  const chapters = chaptersOf(p);
  const vOK = !!v && VIDEO_OK.has(v.codec_name);
  const aOK = !a || AUDIO_OK.has(a.codec_name);
  const multichannel = !!a && (+a.channels || 0) > 2;
  const downmix = forceStereo && multichannel; // fold 5.1/7.1 → stereo, server-side
  const needAudio = downmix || night || norm;  // any of these forces an audio re-encode
  // Downscale ONLY when the encoder can't sustain the source resolution in real
  // time (otherwise a 4K→4K encode lags audio → A/V desync). Last resort, not the
  // default — timestamp/async hardening in transcodeStream is the first line of
  // defense. With a hardware encoder (NVENC) we keep the source resolution; a
  // CPU-only encoder can't do >1080p live, so it caps at 1080p. `maxTranscodeHeight`
  // in config forces a cap (e.g. 1080) if a given box still can't keep up at 4K.
  const srcH = v ? (+v.height || 0) : 0;
  const cap = maxTranscodeHeight || (hasNvenc ? 0 : 1080); // 0 = no cap (keep source res)
  const scaleH = cap && srcH > cap ? cap : 0;
  // B-frames cause the lip-sync lag: a copied B-frame video's first frame displays a
  // couple frames late (has_b_frames / fps ≈ 67ms) → video starts after the audio →
  // constant audio-ahead. So only remux (copy) the video when it has NO B-frames;
  // otherwise re-encode it (transcodeStream emits `-bf 0`, so the output starts at 0).
  const bf = v ? (+v.has_b_frames || 0) : 0;
  const vcopy = vOK && bf === 0;
  // Engine summary for the admin playback badge: what each stream is and what the
  // server will do with it, plus the source per-stream start offset — a non-zero
  // gap here is the usual culprit for a constant A/V (lip-sync) offset.
  const srcKbps = Math.round((+(p.format && p.format.bit_rate) || 0) / 1000) || null; // source overall bitrate
  const src = {
    video: v ? { codec: v.codec_name, width: +v.width || 0, height: srcH } : null,
    audio: a ? { codec: a.codec_name, channels: +a.channels || 0 } : null,
    srcKbps,
    startV: v ? +v.start_time || 0 : 0,
    startA: a ? +a.start_time || 0 : 0
  };
  const acopy = aOK && !needAudio;
  // Remote ceiling: a viewer over the internet can't carry a full-bitrate 4K stream,
  // so if the source is bigger than the remote cap we re-encode it down to fit — even
  // if it would otherwise direct-play or video-copy (neither can shrink bitrate). This
  // is the ONLY place quality is reduced, and only for remote; local is untouched.
  if (remote && (remoteMaxHeight || remoteMaxKbps)) {
    let srcKbps = Math.round((+(p.format && p.format.bit_rate) || 0) / 1000);
    if (!srcKbps && duration) { try { srcKbps = Math.round(fs.statSync(filePath).size * 8 / duration / 1000); } catch {} }
    const overRes = remoteMaxHeight && srcH > remoteMaxHeight;
    const overRate = remoteMaxKbps && srcKbps > Math.round(remoteMaxKbps * 1.15); // small headroom before we bother
    if (overRes || overRate) {
      const rScaleH = overRes ? remoteMaxHeight : 0;
      const aAction = acopy ? 'copy' : (downmix ? 'downmix → stereo' : (a ? `${String(a.codec_name || '').toUpperCase()} → AAC` : 'none'));
      return {
        mode: 'transcode', duration, vcopy: false, acopy, downmix, scaleH: rScaleH, maxKbps: remoteMaxKbps, chapters,
        engine: { ...src, mode: 'transcode', videoAction: `transcode → ${rScaleH || srcH}p ≤${remoteMaxKbps}k (remote)`, audioAction: aAction, remote: true }
      };
    }
  }
  if (DIRECT_EXT.has(ext) && vOK && aOK && !needAudio) {
    return { mode: 'direct', duration, chapters, engine: { ...src, mode: 'direct', videoAction: 'direct play', audioAction: 'direct play' } };
  }
  const videoAction = vcopy ? 'copy (remux)' : (scaleH ? `transcode → ${scaleH}p` : (bf > 0 ? 'transcode (de-B-frame)' : 'transcode'));
  const audioAction = acopy ? 'copy' : (downmix ? 'downmix → stereo' : (a ? `${String(a.codec_name || '').toUpperCase()} → AAC` : 'none'));
  return {
    mode: 'transcode', duration, vcopy, acopy, downmix, scaleH, maxKbps: 0, chapters,
    engine: { ...src, mode: 'transcode', videoAction, audioAction }
  };
}

// ---- Diagnostics: deep source timing (admin bug-hunting) ----
// The container start_time (shown in the badge) is 0/0 even for laggy files, so
// this digs into the actual first packet PTS/DTS, B-frames, and frame-rate mode —
// the things that differ between a synthetic clip and a real problem file.
export async function sourceTiming(filePath) {
  if (!ffprobePath) return null;
  const j = async (args) => { try { return JSON.parse(await tryRun(ffprobePath, args) || '{}'); } catch { return {}; } };
  const firstPkts = async (sel) =>
    ((await j(['-v', 'error', '-select_streams', sel, '-read_intervals', '%+#4',
      '-show_entries', 'packet=pts_time,dts_time', '-of', 'json', filePath])).packets || [])
      .map((p) => ({ pts: p.pts_time === undefined ? null : +p.pts_time, dts: p.dts_time === undefined ? null : +p.dts_time }));
  const streams = (await j(['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,start_time,has_b_frames,r_frame_rate,avg_frame_rate,channels,time_base,codec_tag_string',
    '-of', 'json', filePath])).streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || {};
  return {
    video: { codec: v.codec_name, startTime: +v.start_time || 0, hasBFrames: v.has_b_frames,
      rFrameRate: v.r_frame_rate, avgFrameRate: v.avg_frame_rate, firstPackets: await firstPkts('v:0') },
    audio: { codec: a.codec_name, startTime: +a.start_time || 0, channels: +a.channels || 0,
      firstPackets: await firstPkts('a:0') }
  };
}

// ---- Transcode stream ----
// Fragmented MP4 to stdout. `start` = seek offset in seconds (client restarts
// the stream to seek and keeps a virtual timeline).
// 5.1→stereo downmix matrices by dialogue-boost level. A TV's own fold buries
// the center channel (where on-screen dialogue lives); the higher levels keep
// the center at full level and pull the surrounds back so dialogue stays out
// front. `aformat` first normalizes any surround layout (5.0/6.1/7.1, side- vs
// back-channel naming) to canonical 5.1 so the pan matrix always has the
// channels it references. Every level outputs stereo.
function downmixFilter(level) {
  const pan = (fc, w) => `aformat=channel_layouts=5.1,pan=stereo|FL=${fc}FC+${w}*FL+${w}*BL|FR=${fc}FC+${w}*FR+${w}*BR`;
  if (level === 'off') return pan('0.707*', '0.707');   // standard ITU fold
  if (level === 'strong') return pan('', '0.15');       // center full, surrounds well back
  return pan('', '0.30');                                // 'normal' (default): center full
}
// Night mode: tame loud peaks so dialogue stays audible at low volume, with a
// limiter to prevent clipping. Loudness normalization: even out perceived volume
// across titles to an EBU R128 target (single-pass, streaming-safe).
const NIGHT_FILTER = 'acompressor=threshold=-24dB:ratio=4:attack=20:release=250,alimiter=limit=0.95';
const NORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';

export function transcodeStream(filePath, { start = 0, vcopy = false, acopy = false, downmix = false, forceStereo = false, dboost = 'normal', night = false, norm = false, scaleH = 0, maxKbps = 0, duration = 0 } = {}) {
  if (maxKbps > 0) vcopy = false; // can't cap a copied stream's bitrate — must re-encode
  // First line of defense against A/V drift (applied regardless of resolution):
  // `+genpts` regenerates missing timestamps up front, and `aresample=async=1`
  // (below) keeps audio locked to the video timeline.
  // `-stats` forces ffmpeg's periodic progress line (incl. `speed=N x`) to stderr
  // even at -loglevel error, so the server can read the realtime encode factor and
  // surface it in the admin monitor (speed ≈ 1× = the transcode is the bottleneck).
  const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-fflags', '+genpts'];
  // Offload decode to the GPU when we have one — this is what lets a 4K source
  // transcode in real time without downscaling (CPU HEVC decode is the bottleneck).
  // `auto` falls back to software if the GPU can't decode a given file.
  if (hasNvenc) args.push('-hwaccel', 'auto');
  // `-noaccurate_seek` is THE lip-sync-on-seek fix (this is what Plex does), and
  // it's needed ONLY on the copy path. Default (accurate) seek decode-and-trims
  // each stream to the exact requested time — but a COPIED video can't cut mid-GOP
  // so it backs up to the keyframe, while the RE-ENCODED audio trims precisely to
  // the request. That differential (up to a full GOP — ~7 s on the owner's
  // SpongeBob file) then gets baked in as permanent A/V offset when the muxer
  // zeroes each stream independently. `-noaccurate_seek` makes BOTH streams start
  // at the same keyframe, so no differential can arise and `make_zero` shifts them
  // together. Verified with a flash+beep test file (keyframes every 8 s): raw
  // mid-GOP seeks went from a 6000 ms A/V split to 23/23 events aligned within
  // ~30 ms. The client learns the true keyframe start via /api/seekpoint and uses
  // it as its timeline base, so position + subtitles stay correct.
  //   On the RE-ENCODE path, video is decoded so accurate seek trims BOTH streams
  // to exactly the requested time (already aligned, no differential), and the
  // client's base stays at the requested time — so we must NOT snap there.
  if (start > 0) {
    args.push('-ss', String(start));
    if (vcopy) args.push('-noaccurate_seek');
  }
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (duration > 0) args.push('-t', String(duration)); // used by the admin diagnostics sample
  if (vcopy) {
    args.push('-c:v', 'copy');
  } else {
    if (scaleH) args.push('-vf', `scale=-2:${scaleH}`); // downscale 4K/UHD so it transcodes in real time
    // `-bf 0` = no B-frames in our output, so the re-encoded video starts at t=0
    // (a B-frame reorder delay would push it late → audio ahead).
    // `maxKbps` caps the delivered bitrate for a remote viewer: quality-targeted
    // (cq/crf) but with a hard `-maxrate`/`-bufsize` ceiling so a busy scene can't
    // spike above what the uplink can carry (the remote-lag fix). 0 = uncapped (local).
    const cap = maxKbps > 0;
    if (hasNvenc) {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-bf', '0', '-pix_fmt', 'yuv420p');
      if (cap) args.push('-rc', 'vbr', '-cq', '25', '-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps * 2}k`);
      else args.push('-cq', '23');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-pix_fmt', 'yuv420p');
      if (cap) args.push('-crf', '23', '-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps * 2}k`);
      else args.push('-crf', '21');
    }
  }
  if (acopy) {
    args.push('-c:a', 'copy');
  } else {
    // Order: fold down first (→ stereo), then compress, then normalize, then a
    // final aresample=async=1 that pads/stretches audio to keep it locked to the
    // (re-encoded) video timeline instead of drifting out of sync.
    const af = [];
    if (downmix) af.push(downmixFilter(dboost));
    if (night) af.push(NIGHT_FILTER);
    if (norm) af.push(NORM_FILTER);
    // Keep audio locked to the (now also re-encoded) video timeline.
    af.push('aresample=async=1');
    args.push('-af', af.join(','));
    args.push('-c:a', 'aac', '-b:a', '192k');
    // A pan-based downmix already emits stereo; otherwise force stereo when the
    // device wants it (surround mode keeps the source's channel count).
    if (!downmix && forceStereo) args.push('-ac', '2');
  }
  // Normalize container start timestamps to zero — keeps the copied video and the
  // re-encoded audio referenced to the same zero so they don't start misaligned.
  args.push('-avoid_negative_ts', 'make_zero');
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

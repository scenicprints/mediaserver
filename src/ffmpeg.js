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
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ]);
  let json = null;
  try { json = JSON.parse(out); } catch {}
  probeCache.set(key, json);
  return json;
}

// ---- Direct-play decision ----
// Chrome/Edge can natively play these container+codec combos; everything else
// goes through ffmpeg (video/audio are copied when already compatible, so an
// mkv with h264+aac is a cheap remux, not a re-encode).
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

export async function playInfo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ffmpegPath || !ffprobePath) {
    return { mode: 'direct', duration: null, reason: 'no-ffmpeg' };
  }
  const p = await probe(filePath);
  if (!p || !p.streams) return { mode: 'direct', duration: null, reason: 'probe-failed' };
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const duration = parseFloat(p.format && p.format.duration) || null;
  const vOK = !!v && VIDEO_OK.has(v.codec_name);
  const aOK = !a || AUDIO_OK.has(a.codec_name);
  if (DIRECT_EXT.has(ext) && vOK && aOK) return { mode: 'direct', duration };
  return { mode: 'transcode', duration, vcopy: vOK, acopy: aOK };
}

// ---- Transcode stream ----
// Fragmented MP4 to stdout. `start` = seek offset in seconds (client restarts
// the stream to seek and keeps a virtual timeline).
export function transcodeStream(filePath, { start = 0, vcopy = false, acopy = false } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  if (vcopy) args.push('-c:v', 'copy');
  else if (hasNvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  if (acopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The optimizer's own ffmpeg handling.
//
// Deliberately self-contained rather than importing Marquee's src/ffmpeg.js.
// This is a separate program: it shares the media server's DATABASE and asks it
// whether anyone is watching, but it does not share its code, so a change on
// either side cannot break the other. Locating two executables is a small price
// for that independence.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

let ffmpegPath = null;
let ffprobePath = null;
let hasHevcNvenc = false;

function tryRun(cmd, args) {
  return new Promise((resolve) => {
    if (!cmd) return resolve(null);
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// The zip nests the binaries under a versioned folder, so search rather than
// hardcode a path that changes with every ffmpeg release.
function findInTools(dir, exe) {
  try {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name.toLowerCase() === exe) return p;
      }
    }
  } catch {}
  return null;
}

export async function detect(root, config = {}) {
  const toolsDir = path.join(root, 'tools');
  ffmpegPath = null; ffprobePath = null; hasHevcNvenc = false;

  for (const c of [config.ffmpegPath, findInTools(toolsDir, 'ffmpeg.exe'), 'ffmpeg'].filter(Boolean)) {
    if (await tryRun(c, ['-version'])) { ffmpegPath = c; break; }
  }
  if (!ffmpegPath) return status();

  for (const c of [
    config.ffprobePath,
    ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || '')),
    findInTools(toolsDir, 'ffprobe.exe'),
    'ffprobe'
  ].filter(Boolean)) {
    if (await tryRun(c, ['-version'])) { ffprobePath = c; break; }
  }

  // Listed is not the same as usable: an encoder can appear in -encoders and
  // still fail because the driver is too old for its nvenc API. Prove it with a
  // one-frame encode. (This box's ffmpeg 8.x did exactly that — see the notes on
  // the driver mismatch that made every NVENC encode fail silently.)
  const encoders = (await tryRun(ffmpegPath, ['-hide_banner', '-encoders'])) || '';
  if (encoders.includes('hevc_nvenc')) {
    hasHevcNvenc = (await tryRun(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=256x256', '-frames:v', '1',
      '-c:v', 'hevc_nvenc', '-f', 'null', '-'])) !== null;
  }
  return status();
}

export function status() {
  return { available: !!(ffmpegPath && ffprobePath), nvenc: hasHevcNvenc, ffmpegPath, ffprobePath };
}

export const ffmpegBin = () => ffmpegPath;
export const ffprobeBin = () => ffprobePath;
export const nvencAvailable = () => hasHevcNvenc;

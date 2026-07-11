// Local subtitle generation with whisper.cpp. Optional, one-click install like
// ffmpeg. Given a video, it uses ffmpeg to extract 16 kHz mono audio, then runs
// whisper to produce a WebVTT track — either transcribed in the spoken language
// or translated to English. Generated tracks are cached as sidecar .vtt files
// next to the video so it's a one-time cost per file+mode.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// Overridable in config.json (release asset names drift over whisper.cpp
// versions). Default is the CPU x64 build — works on any Windows box. The Dell's
// 1050 Ti could use the much faster cuBLAS build by setting `whisperBinUrl` to
// whisper-cublas-12.4.0-bin-x64.zip (needs the CUDA runtime). Model URL is
// stable on Hugging Face.
const DEFAULT_BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';
const DEFAULT_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';

let binPath = null;
let modelPath = null;

function tryRun(cmd, args) {
  return new Promise((resolve) => {
    if (!cmd) return resolve(null);
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) =>
      resolve(err && !stderr ? null : String(stdout || '') + String(stderr || '')));
  });
}

// Find the first of `names` (in preference order) anywhere under `dir`. Order
// matters: whisper-cli.exe is the real CLI; main.exe is a deprecated stub that
// only prints a warning and exits 1.
function findFile(dir, names) {
  const all = [];
  try {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else all.push({ name: ent.name.toLowerCase(), path: p });
      }
    }
  } catch {}
  for (const want of names) { const hit = all.find((f) => f.name === want); if (hit) return hit.path; }
  return null;
}

export async function detectWhisper(root, config = {}) {
  const dir = path.join(root, 'tools', 'whisper');
  binPath = config.whisperPath || findFile(dir, ['whisper-cli.exe', 'main.exe', 'whisper.exe']);
  // Any ggml-*.bin model counts.
  modelPath = null;
  try {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (/^ggml.*\.bin$/i.test(ent.name)) { modelPath = p; break; }
      }
      if (modelPath) break;
    }
  } catch {}
  // The .exe existing is enough — whisper CLIs exit non-zero on --help, so we
  // don't gate on running it; generate() surfaces any real runtime error.
  return status();
}

export function status() {
  return { available: !!(binPath && modelPath), hasBinary: !!binPath, hasModel: !!modelPath, installing: install.phase ? { phase: install.phase, pct: install.pct } : null, error: install.error };
}

const install = { phase: null, pct: 0, error: null };

async function download(url, dest, phaseLabel) {
  install.phase = phaseLabel; install.pct = 0;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${phaseLabel} failed (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (total) install.pct = Math.round((got / total) * 100);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
}

export async function installWhisper(root, config) {
  if (install.phase) return;
  install.error = null;
  const dir = path.join(root, 'tools', 'whisper');
  const modelsDir = path.join(dir, 'models');
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    // Binary (skip if the user already dropped one in / config points to one).
    await detectWhisper(root, config);
    if (!binPath) {
      const zip = path.join(dir, 'whisper.zip');
      await download(config.whisperBinUrl || DEFAULT_BIN_URL, zip, 'downloading binary');
      install.phase = 'extracting';
      await new Promise((resolve, reject) => execFile(fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar', ['-xf', zip, '-C', dir], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
      fs.rmSync(zip, { force: true });
    }
    // Model.
    if (!modelPath) {
      await download(config.whisperModelUrl || DEFAULT_MODEL_URL, path.join(modelsDir, 'ggml-base.bin'), 'downloading model');
    }
    install.phase = 'detecting';
    await detectWhisper(root, config);
    if (!binPath) throw new Error('binary not found after extract — set whisperBinUrl in config.json');
    if (!modelPath) throw new Error('model not found after download');
    install.phase = null;
  } catch (e) {
    install.phase = null;
    install.error = e.message;
  }
}

// Generate a WebVTT for `videoPath`. `translate` → English; otherwise transcribe
// in `language` ('auto' lets whisper detect). Returns the .vtt path (cached).
export async function generate(root, ffmpegPath, videoPath, { language = 'auto', translate = false } = {}) {
  if (!binPath || !modelPath) throw new Error('whisper not installed');
  if (!ffmpegPath) throw new Error('ffmpeg required to extract audio');
  const tag = translate ? 'en-ai' : (language === 'auto' ? 'orig-ai' : language + '-ai');
  const vttPath = videoPath.replace(/\.[^.]+$/, '') + `.${tag}.vtt`;
  if (fs.existsSync(vttPath)) return vttPath;

  const wav = path.join(root, 'tools', 'whisper', `job-${Date.now()}.wav`);
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
      { windowsHide: true }, (e) => (e ? reject(new Error('audio extract failed')) : resolve()));
  });

  const outBase = wav.replace(/\.wav$/, '');
  const args = ['-m', modelPath, '-f', wav, '-ovtt', '-of', outBase, '-l', language];
  if (translate) args.push('--translate');
  await new Promise((resolve, reject) => {
    // Run from the binary's own folder so Windows finds its sibling DLLs
    // (ggml.dll, whisper.dll, …) regardless of the server's working directory.
    const p = spawn(binPath, args, { windowsHide: true, cwd: path.dirname(binPath) });
    let err = '', out = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (e) => reject(new Error('could not start whisper: ' + e.message)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      console.error('[whisper] exit', code, '\nargs:', args.join(' '), '\nstderr:', err.slice(-400), '\nstdout:', out.slice(-200));
      reject(new Error(`whisper exited ${code}`));
    });
  });

  try { fs.copyFileSync(outBase + '.vtt', vttPath); } catch (e) { throw new Error('whisper produced no output'); }
  fs.rmSync(wav, { force: true });
  fs.rmSync(outBase + '.vtt', { force: true });
  return vttPath;
}

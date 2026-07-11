// Local subtitle generation with whisper.cpp. Optional, one-click install like
// ffmpeg. Given a video, it uses ffmpeg to extract 16 kHz mono audio, then runs
// whisper to produce a WebVTT track — either transcribed in the spoken language
// or translated to English. Generated tracks are cached as sidecar .vtt files
// next to the video so it's a one-time cost per file+mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// Two prebuilt Windows binaries (overridable in config.json — release asset
// names drift). The **GPU (cuBLAS)** build is many times faster and bundles the
// CUDA runtime DLLs, so it runs with just an NVIDIA driver (no CUDA toolkit).
// We pick it automatically when an NVIDIA driver is present (nvcuda.dll), and
// fall back to the CPU build if it can't load. Model URL is stable on HF.
const CPU_BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';
const GPU_BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip';
const DEFAULT_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';

let binPath = null;
let modelPath = null;
let usingGpu = false;   // is the active binary the cuBLAS build?
let gpuDetected = false; // is an NVIDIA driver present on this machine?

// An NVIDIA driver present means the GPU build's nvcuda dependency is satisfied.
function gpuAvailable(config = {}) {
  if (config.whisperGpu === false) return false;
  if (config.whisperGpu === true) return true;
  try { return fs.existsSync('C:\\Windows\\System32\\nvcuda.dll'); } catch { return false; }
}
function whisperThreads() { return Math.max(4, Math.min(8, Math.floor(os.cpus().length / 2))); }

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
  gpuDetected = gpuAvailable(config);
  // The active build is the GPU one if the CUDA runtime sits beside the binary.
  usingGpu = !!(binPath && fs.existsSync(path.join(path.dirname(binPath), 'cublas64_12.dll')));
  // The .exe existing is enough — whisper CLIs exit non-zero on --help, so we
  // don't gate on running it; generate() surfaces any real runtime error.
  return status();
}

export function status() {
  return {
    available: !!(binPath && modelPath), hasBinary: !!binPath, hasModel: !!modelPath,
    gpu: usingGpu, gpuAvailable: gpuDetected,
    installing: install.phase ? { phase: install.phase, pct: install.pct } : null, error: install.error
  };
}

// Prove a freshly-installed binary actually loads (the GPU build fails to start
// if its DLLs can't load). Running --help prints usage and exits 1 when healthy;
// a DLL-load failure produces no output and a special exit code.
function testRun() {
  return new Promise((resolve) => {
    if (!binPath) return resolve(false);
    const p = spawn(binPath, ['--help'], { windowsHide: true, cwd: path.dirname(binPath) });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(out.length > 20 || code === 1));
  });
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

// Download + extract a binary build into tools/whisper (wiping any old binary
// first, but never the model). Returns nothing; sets binPath via detect.
async function fetchBinary(dir, url) {
  // Remove a previous binary folder so switching CPU<->GPU is clean.
  try { fs.rmSync(path.join(dir, 'Release'), { recursive: true, force: true }); } catch {}
  const zip = path.join(dir, 'whisper.zip');
  await download(url, zip, 'downloading binary');
  install.phase = 'extracting';
  await new Promise((resolve, reject) => execFile(fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar', ['-xf', zip, '-C', dir], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
  fs.rmSync(zip, { force: true });
}

// Install (or `force`-reinstall to switch CPU<->GPU). Picks the GPU build when
// an NVIDIA driver is present, verifies it loads, and falls back to CPU if not.
export async function installWhisper(root, config, { force = false } = {}) {
  if (install.phase) return;
  install.error = null;
  const dir = path.join(root, 'tools', 'whisper');
  const modelsDir = path.join(dir, 'models');
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    await detectWhisper(root, config);

    const wantGpu = gpuAvailable(config);
    const needBinary = force || !binPath || (wantGpu && !usingGpu);
    if (needBinary) {
      const url = config.whisperBinUrl || (wantGpu ? GPU_BIN_URL : CPU_BIN_URL);
      await fetchBinary(dir, url);
      await detectWhisper(root, config);
      // If we installed the GPU build but it won't load, fall back to CPU.
      if (binPath && usingGpu && !(await testRun())) {
        install.phase = 'downloading binary';
        await fetchBinary(dir, config.whisperCpuUrl || CPU_BIN_URL);
        await detectWhisper(root, config);
      }
    }

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
// in `language` ('auto' lets whisper detect). `onProgress(0..1)` fires as it runs.
// Returns the .vtt path (cached so re-requests are instant).
export async function generate(root, ffmpegPath, videoPath, { language = 'auto', translate = false, onProgress } = {}) {
  if (!binPath || !modelPath) throw new Error('whisper not installed');
  if (!ffmpegPath) throw new Error('ffmpeg required to extract audio');
  const tag = translate ? 'en-ai' : (language === 'auto' ? 'orig-ai' : language + '-ai');
  const vttPath = videoPath.replace(/\.[^.]+$/, '') + `.${tag}.vtt`;
  if (fs.existsSync(vttPath)) { if (onProgress) onProgress(1); return vttPath; }

  const wav = path.join(root, 'tools', 'whisper', `job-${Date.now()}.wav`);
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e) => (e ? reject(new Error('audio extract failed')) : resolve()));
  });

  const outBase = wav.replace(/\.wav$/, '');
  // Speed: use several threads and greedy decoding (beam/best-of = 1) — far
  // faster than the default beam search, with only a small accuracy cost.
  // -pp prints "progress = NN%" as it decodes.
  const args = ['-m', modelPath, '-f', wav, '-ovtt', '-of', outBase, '-l', language,
    '-t', String(whisperThreads()), '-bo', '1', '-bs', '1', '-pp'];
  if (translate) args.push('--translate');
  await new Promise((resolve, reject) => {
    // Run from the binary's own folder so Windows finds its sibling DLLs
    // (ggml.dll, whisper.dll, …) regardless of the server's working directory.
    const p = spawn(binPath, args, { windowsHide: true, cwd: path.dirname(binPath) });
    let err = '', out = '';
    const scan = (s) => {
      if (!onProgress) return;
      const all = String(s).match(/progress\s*=\s*(\d+)/g);
      if (all) onProgress(Math.min(0.99, parseInt(all[all.length - 1].match(/\d+/)[0], 10) / 100));
    };
    p.stderr.on('data', (d) => { err += d; scan(d); });
    p.stdout.on('data', (d) => { out += d; scan(d); });
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
  if (onProgress) onProgress(1);
  return vttPath;
}

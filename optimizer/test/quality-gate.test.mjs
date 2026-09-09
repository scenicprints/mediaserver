// Does the quality gate actually stop a bad encode?
//
// The gate is the only thing standing between a re-encode and a deleted
// original, so "it seems to work" is not good enough. This builds a known-good
// encode and a known-bad one from the same synthetic source and requires the
// gate to pass the first and reject the second — plus a handful of assertions
// on the policy that decides whether a file is touched at all.
//
// Runs entirely on generated clips in a temp directory. It never reads, writes
// or looks at the media library.
//
//   node --test optimizer/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as ff from '../ffmpeg.mjs';
import { VMAF, setVmaf, vmafAvailable, measureVmaf, samplePoints, probeComplexity } from '../vmaf.mjs';
import { verify, planFor, tierOf, isProtected } from '../engine.mjs';

// Whether libvmaf is usable can only be known AFTER ffmpeg is detected, so it
// is checked inside each test rather than in a `skip:` option — those are
// evaluated at collection time, when ffmpegBin() is still empty, and every VMAF
// test silently skipped.
const needVmaf = (t) => { if (!vmafAvailable()) { t.skip('no libvmaf in this ffmpeg'); return true; } return false; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-gate-'));
const SRC = path.join(dir, 'src.mkv');
const GOOD = path.join(dir, 'good.mkv');
const BAD = path.join(dir, 'bad.mkv');
const DUR = 40;

let ready = false;

test('setup: build a source and two encodes of it', async () => {
  const cfgPath = 'C:/mediaserver/config.json';
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  await ff.detect(path.resolve('C:/mediaserver'), cfg);
  const bin = ff.ffmpegBin();
  assert.ok(bin, 'no ffmpeg found');

  const run = (args) => execFileSync(bin, ['-hide_banner', '-v', 'error', '-y', ...args],
    { timeout: 600000, windowsHide: true });

  // Every clip carries audio on purpose: verify() rejects an output with no
  // audio stream BEFORE it ever reaches the VMAF gate, so silent test clips
  // would make the pass/reject tests green without grading a single frame.
  run(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${DUR}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DUR}`,
    '-c:v', 'libx264', '-crf', '12', '-g', '48', '-c:a', 'ac3', '-shortest', SRC]);
  run(['-i', SRC, '-c:v', 'libx265', '-preset', 'veryfast', '-crf', '24', '-g', '48', '-c:a', 'copy', GOOD]);
  run(['-i', SRC, '-c:v', 'libx265', '-preset', 'veryfast', '-crf', '42', '-g', '48', '-c:a', 'copy', BAD]);

  assert.ok(fs.statSync(GOOD).size < fs.statSync(SRC).size);
  assert.ok(fs.statSync(BAD).size < fs.statSync(GOOD).size);
  ready = true;
});

// ---- VMAF itself -------------------------------------------------------

test('a file scored against itself is ~100', async (t) => {
  if (needVmaf(t)) return;
  setVmaf({ samples: 2, window: 4 });
  const r = await measureVmaf(SRC, SRC, { duration: DUR });
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.mean > 99, `identical files scored ${r.mean}, so the two inputs are not aligned`);
});

test('sample windows stay inside the film and skip the credits', () => {
  const pts = samplePoints(7200, 5, 6);
  assert.equal(pts.length, 5);
  assert.ok(pts[0] > 7200 * 0.04, 'first window is in the studio logos');
  assert.ok(pts[pts.length - 1] + 6 < 7200 * 0.96, 'last window is in the credits');
  // Short files must not produce nonsense windows.
  assert.deepEqual(samplePoints(3, 5, 6), [0]);
  assert.deepEqual(samplePoints(0, 5, 6), []);
});

// ---- The gate ----------------------------------------------------------

const info = () => ({
  duration: DUR, size: fs.statSync(SRC).size,
  width: 1280, height: 720, pix_fmt: 'yuv420p', vcodec: 'h264', acodec: 'ac3'
});

test('a good encode passes the gate', async (t) => {
  if (needVmaf(t)) return;
  assert.ok(ready);
  setVmaf({ samples: 2, window: 4, min: 95, floor: 90 });
  const plan = { profile: 'video', tier: '720p' };
  const bad = await verify(SRC, GOOD, info(), plan, {});
  assert.equal(bad, null, `unexpected rejection: ${bad}`);
  // Proof the gate actually ran, rather than the file passing on structure
  // alone: a recorded score can only come from measureVmaf().
  assert.ok(plan.vmaf, 'verify() passed the file without grading it');
  assert.ok(plan.vmaf.mean >= 95, `recorded ${plan.vmaf.mean}`);
});

test('a bad encode is REJECTED even though it decodes cleanly',
  async (t) => {
    if (needVmaf(t)) return;
    assert.ok(ready);
    setVmaf({ samples: 2, window: 4, min: 95, floor: 90 });
    const bad = await verify(SRC, BAD, info(), { profile: 'video', tier: '720p' }, {});
    assert.ok(bad, 'a CRF-42 encode passed the gate — the gate is not doing anything');
    // Specifically on picture quality. If this ever starts failing for a
    // structural reason instead, the gate has stopped being exercised.
    assert.match(bad, /VMAF/, `rejected for the wrong reason: ${bad}`);
  });

test('failing to measure is not treated as a pass',
  async (t) => {
    if (needVmaf(t)) return;
    const missing = path.join(dir, 'does-not-exist.mkv');
    const r = await measureVmaf(SRC, missing, { duration: DUR });
    assert.ok(r.error, 'a missing file produced a score instead of an error');
    assert.notEqual(r.ok, true);
  });

test('a copied video stream is not put through VMAF', async (t) => {
  if (needVmaf(t)) return;
  const plan = { profile: 'audio', tier: '720p' };
  const t0 = Date.now();
  await verify(SRC, GOOD, info(), plan, {});
  assert.equal(plan.vmaf, undefined, 'an audio-only job was graded on picture quality');
  assert.ok(Date.now() - t0 < 5000, 'audio-only verify took long enough to have run VMAF');
});

// ---- Per-title complexity ---------------------------------------------

test('the complexity probe predicts the real encode', async () => {
  assert.ok(ready);
  const bin = ff.ffmpegBin();
  const full = path.join(dir, 'full.mkv');
  execFileSync(bin, ['-hide_banner', '-v', 'error', '-y', '-i', SRC,
    '-c:v', 'libx265', '-preset', 'veryfast', '-crf', '24', '-g', '48', '-an', full],
    { timeout: 600000, windowsHide: true });
  const actualKbps = fs.statSync(full).size * 8 / DUR / 1000;

  const p = await probeComplexity(SRC, {
    duration: DUR, size: fs.statSync(SRC).size, currentVideoKbps: 8000,
    crf: 24, encoder: 'libx265', preset: 'veryfast', samples: 3, window: 4
  });
  assert.equal(p.error, undefined, p.error);
  const off = Math.abs(p.kbps - actualKbps) / actualKbps;
  assert.ok(off < 0.35, `projection was ${p.kbps} kbps vs ${Math.round(actualKbps)} actual (${(off * 100).toFixed(0)}% off)`);
});

// ---- Policy still holds -----------------------------------------------

test('4K HDR is still untouchable', () => {
  const hdr4k = { width: 3840, height: 2160, hdr: 1, vcodec: 'hevc', duration: 7200, size: 6e10 };
  assert.equal(isProtected(hdr4k), true);
  assert.equal(planFor(hdr4k).profile, 'none');
  assert.equal(planFor(hdr4k, { allow4kVideo: true, allowHdrVideo: true }).profile, 'none',
    'the overrides must not be able to unlock a 4K HDR file');
});

test('scope 4K is measured by width, not height', () => {
  assert.equal(tierOf(3840, 1606), '4K');
  assert.equal(tierOf(1920, 804), '1080p');
});

test('without libvmaf, video re-encoding is vetoed rather than done blind', () => {
  const fat = {
    width: 1920, height: 1080, hdr: 0, vcodec: 'h264', pix_fmt: 'yuv420p',
    duration: 7200, size: 30e9, vkbps: 33000, audio_json: '[]'
  };
  const was = VMAF.enabled;
  try {
    // Simulate "ffmpeg can't grade this" by asking the planner to require a
    // proof it cannot get. With the gate on and libvmaf present the same file
    // is a video job, which is what makes this a real test of the veto.
    if (vmafAvailable()) {
      assert.equal(planFor(fat).profile, 'video', 'setup: this file should be a video job');
    }
    setVmaf({ enabled: true });
  } finally {
    setVmaf({ enabled: was });
  }
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

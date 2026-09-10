// Did this encode lose visible quality?
//
// That is the optimizer's central question, and until now it had two answers,
// neither of which actually answered it:
//
//   * For the add-audio path, a video bitstream MD5. That one is airtight — but
//     it only works precisely because nothing is re-encoded. It proves the
//     picture was never touched; it cannot grade a picture that was.
//   * For the re-encode path, structural checks: it probes, it decodes cleanly
//     at three points, the duration didn't drift, the height didn't change. All
//     necessary, none of them about how it LOOKS. A blocky, smeared, banded
//     encode passes every one of those checks.
//
// So a re-encode was being accepted on the strength of "the file isn't broken."
// Netflix hit the same wall and built VMAF for it: a model trained on human
// scores that predicts perceived quality far better than PSNR or SSIM. That is
// exactly the missing gate, and ffmpeg carries it (this box's 7.1.5 build has
// --enable-libvmaf with the models compiled in, so there is nothing to install).
//
// Two functions here, and they answer different questions:
//
//   measureVmaf()    — after the encode: is the result good enough to keep?
//   probeComplexity() — before the encode: is this file even worth an hour?
//
// The second exists because a fixed bitrate ladder is the thing Netflix moved
// AWAY from. Content is not equally compressible: an animated film and a grainy
// 70mm transfer at the same resolution want wildly different bitrates. Sampling
// the real encoder on real frames costs about a minute and tells us what this
// specific file will actually do, instead of assuming.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { ffmpegBin } from './ffmpeg.mjs';

// ---- Policy ------------------------------------------------------------

// The pass mark. VMAF is calibrated so ~93+ is where a trained viewer stops
// reliably telling source from encode on a living-room screen, and Netflix's own
// top rungs sit around there. This library's brief is "smaller without losing
// any quality", so the bar is set above that working point rather than at it.
//
// `floor` is separate on purpose: a two-hour film can average beautifully while
// one dark, grainy, high-motion scene falls apart, and the average is exactly
// where that hides. Every sampled window has to clear the floor on its own.
export const VMAF = {
  enabled: true,
  min: 95,        // mean across sampled windows
  floor: 90,      // worst single window
  samples: 5,     // windows spread through the file
  window: 6,      // seconds per window
  threads: Math.max(2, Math.min(8, os.cpus().length - 1))
};

export function setVmaf(opts = {}) { Object.assign(VMAF, opts); }

// ---- Capability --------------------------------------------------------

let _has = null;
// Cached because planFor() asks per file across the whole library.
//
// The "not yet" case is deliberately NOT cached. ffmpeg is resolved
// asynchronously at startup, so anything that asks this question early gets a
// false — and caching that false would veto every video job for the life of the
// process, silently, with the reason "no libvmaf" on a box that has it. A test
// run caught exactly that.
export function vmafAvailable() {
  if (_has !== null) return _has;
  const bin = ffmpegBin();
  if (!bin) return false;
  try {
    const out = execFileSync(bin, ['-hide_banner', '-filters'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    _has = /\blibvmaf\b/.test(out);
  } catch { _has = false; }
  return _has;
}

// ---- Plumbing ----------------------------------------------------------

function ffmpeg(args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    const p = execFile(ffmpegBin(), args, { maxBuffer: 1 << 26, windowsHide: true, timeout: timeout || undefined },
      (err) => resolve({ err: err ? (err.killed ? 'timed out' : 'ffmpeg failed') : null, stderr }));
    p.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 1 << 22) stderr = stderr.slice(-(1 << 21)); });
  });
}

// Windows spread across the middle of the file. The first and last 4% are
// skipped: studio logos and end credits are flat, cheap to encode, and score
// near-perfect, which would flatter every result if included.
export function samplePoints(duration, n = VMAF.samples, window = VMAF.window) {
  const dur = Number(duration) || 0;
  if (dur <= window * 2) return dur > 1 ? [0] : [];
  const start = dur * 0.04;
  const end = dur * 0.96 - window;
  if (end <= start) return [Math.max(0, dur / 2 - window / 2)];
  const count = Math.max(1, Math.min(n, Math.floor((end - start) / window)));
  const step = (end - start) / count;
  // Offset by half a step so windows sit in the middle of their slice rather
  // than butting up against the boundary.
  return Array.from({ length: count }, (_, i) => Math.round(start + step * i + step / 2));
}

// Both files are read at the same absolute timestamps. ffmpeg's input seek is
// frame-accurate by default (it seeks to the preceding keyframe and decodes
// forward), which matters enormously here: the encode has its own keyframe
// positions, so a keyframe-only seek would compare frame N against frame N+20
// and report a catastrophic score for a perfectly good encode.
function pairArgs(ref, dis, t, window, { tenBit, readRate = 0 }) {
  const fmt = tenBit ? 'yuv420p10le' : 'yuv420p';
  const a = ['-hide_banner', '-nostdin'];
  if (readRate > 0) a.push('-readrate', String(readRate));
  a.push('-ss', String(t), '-t', String(window), '-i', dis);
  if (readRate > 0) a.push('-readrate', String(readRate));
  a.push('-ss', String(t), '-t', String(window), '-i', ref);
  // The score is read off libvmaf's own summary line rather than its JSON log.
  // A log path cannot be passed safely here on Windows: filter options are
  // colon-separated, so the colon in `C:\...` is parsed as an option boundary
  // and the whole filter graph fails.
  //
  // libvmaf takes [distorted][reference] in that order — reversing them does
  // not error, it just quietly reports a different (wrong) number.
  a.push('-lavfi',
    `[0:v]setpts=PTS-STARTPTS,format=${fmt}[d];[1:v]setpts=PTS-STARTPTS,format=${fmt}[r];` +
    `[d][r]libvmaf=n_threads=${VMAF.threads}`,
    '-f', 'null', '-');
  return a;
}

// ---- The gate ----------------------------------------------------------

// Grades `dis` against `ref`. Returns { ok, mean, min, samples, reason }.
//
// Failure to MEASURE is not the same as failure to pass, and the difference
// decides a file's fate, so they are reported separately: `ok:false` with a
// score means the encode was judged and rejected; `error` means we never got a
// verdict, and the caller must not treat that as a pass.
export async function measureVmaf(ref, dis, {
  duration = 0, tenBit = false, readRate = 0, onSample = () => {}
} = {}) {
  if (!VMAF.enabled) return { ok: true, skipped: 'VMAF gate disabled' };
  if (!vmafAvailable()) return { error: 'this ffmpeg has no libvmaf filter' };

  const points = samplePoints(duration);
  if (!points.length) return { error: 'file too short to sample' };

  const samples = [];
  for (const t of points) {
    const { err, stderr } = await ffmpeg(pairArgs(ref, dis, t, VMAF.window, { tenBit, readRate }),
      { timeout: 600000 });

    const m = /VMAF score:\s*([\d.]+)/.exec(stderr);
    const score = m ? Number(m[1]) : null;

    if (score === null || !Number.isFinite(score)) {
      const why = /No such filter|Invalid|Error|error/.test(stderr)
        ? (stderr.trim().split('\n').filter((l) => /error|Error|Invalid/.test(l)).pop() || err || 'no score produced')
        : (err || 'no score produced');
      return { error: `could not measure at ${t}s: ${String(why).slice(0, 200)}` };
    }
    samples.push({ t, score: Math.round(score * 100) / 100 });
    onSample(samples[samples.length - 1]);
  }

  const mean = samples.reduce((n, s) => n + s.score, 0) / samples.length;
  const min = Math.min(...samples.map((s) => s.score));
  const ok = mean >= VMAF.min && min >= VMAF.floor;
  return {
    ok, samples,
    mean: Math.round(mean * 100) / 100,
    min: Math.round(min * 100) / 100,
    reason: ok ? null
      : mean < VMAF.min
        ? `VMAF ${mean.toFixed(1)} is below the ${VMAF.min} pass mark`
        : `worst scene scored VMAF ${min.toFixed(1)}, below the ${VMAF.floor} floor (mean was ${mean.toFixed(1)})`
  };
}

// ---- Before the encode -------------------------------------------------

// Encode a few sample windows for real, see what they cost AND how they look.
//
// This is the per-title idea, shrunk to fit one box: instead of assuming every
// 1080p file should land at the tier bitrate, ask THIS file.
//
// It used to ask only about size, and the reasoning was that "an already-
// efficient grain-heavy transfer will barely shrink, so finding that out in a
// minute beats finding it out in an hour". That reasoning was exactly backwards
// and the library proved it: grain-heavy transfers shrink enormously — Temple
// of Doom goes from 42 Mbps to 4.5 — because what the encoder discards IS the
// grain. The size test waved every one of them through, and the quality gate
// then threw away the result an hour later. Twenty-one films in one night, all
// of them the film-stock catalogue titles: Raiders, the Godfather, In the Mood
// for Love. The ones most worth not wrecking.
//
// So the samples are now GRADED as well as measured. A file that cannot hold
// its quality is refused here, in minutes, on evidence — instead of being
// re-encoded for an hour and refused at the end on the same evidence.
//
// Returns { ok, kbps, projectedBytes, saveBytes, ratio, vmafMean, vmafMin }.
// `kbps` is the bitrate this encoder produces on this content at this CRF;
// vmafMean/vmafMin are how the samples scored against the source, or null if
// grading was unavailable.
export async function probeComplexity(src, {
  duration = 0, size = 0, currentVideoKbps = 0, crf = 22, encoder = 'libx265',
  preset = 'veryfast', tenBit = false, readRate = 0, tmpDir = null, samples = 3, window = 6,
  grade = true
} = {}) {
  const points = samplePoints(duration, samples, window);
  if (!points.length) return { error: 'file too short to sample' };

  const dir = tmpDir || path.dirname(src);
  let bytes = 0, secs = 0;
  const scores = [];
  const canGrade = grade && VMAF.enabled && vmafAvailable();

  for (const t of points) {
    const out = path.join(dir, `.probe-${process.pid}-${t}.mkv`);
    fs.rmSync(out, { force: true });
    const a = ['-hide_banner', '-nostdin', '-y'];
    if (readRate > 0) a.push('-readrate', String(readRate));
    a.push('-ss', String(t), '-t', String(window), '-i', src, '-map', '0:v:0', '-an', '-sn', '-dn');
    if (encoder === 'hevc_nvenc') {
      // Match the real encode's rate control mode, or the sample says nothing
      // useful about what the real encode will produce.
      a.push('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf));
      if (tenBit) a.push('-pix_fmt', 'p010le');
    } else {
      // A faster preset than the real encode, deliberately: it lands slightly
      // LARGER than `medium` will, so the projection under-promises rather than
      // over-promising. Erring the other way would start hour-long jobs that
      // save nothing.
      a.push('-c:v', 'libx265', '-preset', preset, '-crf', String(crf));
      if (tenBit) a.push('-pix_fmt', 'yuv420p10le');
    }
    a.push(out);

    const { err } = await ffmpeg(a, { timeout: 900000 });
    let st = null;
    try { st = fs.statSync(out); } catch {}
    if (err || !st || st.size < 1024) {
      fs.rmSync(out, { force: true });
      return { error: `sample encode failed at ${t}s${err ? ': ' + err : ''}` };
    }
    bytes += st.size;
    secs += window;

    // Grade this window before deleting it. The sample clip starts at zero
    // while the source window starts at t, so the two inputs are seeked
    // differently — pairArgs assumes both are the same timeline and cannot be
    // reused here.
    if (canGrade) {
      const fmt = tenBit ? 'yuv420p10le' : 'yuv420p';
      const g = ['-hide_banner', '-nostdin'];
      if (readRate > 0) g.push('-readrate', String(readRate));
      g.push('-i', out);                                     // distorted, from 0
      if (readRate > 0) g.push('-readrate', String(readRate));
      g.push('-ss', String(t), '-t', String(window), '-i', src);   // reference, at t
      // [distorted][reference] in that order — reversing them does not error,
      // it silently reports a different and wrong number.
      g.push('-lavfi',
        `[0:v]setpts=PTS-STARTPTS,format=${fmt}[d];[1:v]setpts=PTS-STARTPTS,format=${fmt}[r];` +
        `[d][r]libvmaf=n_threads=${VMAF.threads}`,
        '-f', 'null', '-');
      const { stderr } = await ffmpeg(g, { timeout: 600000 });
      const m = /VMAF score:\s*([\d.]+)/.exec(stderr || '');
      if (m && Number.isFinite(Number(m[1]))) scores.push(Number(m[1]));
    }

    fs.rmSync(out, { force: true });
  }

  if (!secs) return { error: 'no samples encoded' };
  const kbps = Math.round(bytes * 8 / secs / 1000);
  const projectedBytes = Math.round(kbps * 1000 / 8 * (Number(duration) || 0));
  // Compare like with like: the projection is video only, so measure the saving
  // against the current VIDEO bitrate rather than the whole file.
  const currentVideoBytes = currentVideoKbps > 0
    ? Math.round(currentVideoKbps * 1000 / 8 * (Number(duration) || 0))
    : Number(size) || 0;
  return {
    ok: true, kbps, projectedBytes,
    saveBytes: Math.max(0, currentVideoBytes - projectedBytes),
    ratio: currentVideoKbps > 0 ? kbps / currentVideoKbps : null,
    vmafMean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    vmafMin: scores.length ? Math.min(...scores) : null,
    vmafSamples: scores.length
  };
}

// There was a sampleVerdict() here that turned the grade above into a decision:
// refuse a doomed encode in minutes rather than an hour. It was measured
// against the full-encode scores it had to predict, and it did not predict them
// — see the note at the probe's call site in engine.mjs for the numbers. It is
// gone rather than left disabled, because a plausible-looking helper with
// passing tests is an invitation to wire it back up.
//
// If this is revisited, the thing to fix is not the threshold. It is that five
// six-second clips cannot stand in for a two-hour encode: windows of one film
// scored 63.8 and 89.6, so the answer depends mostly on which seconds were
// picked. More windows, or whole-file measurement, or nothing.

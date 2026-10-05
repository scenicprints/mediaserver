// ---------------------------------------------------------------------------
// Library-disk guard: every touch of a media file or folder goes through here.
//
// A library disk can HANG rather than fail. 2026-09-26: one USB member of the
// DrivePool (E:) sat in a reset loop for hours, and every read of P: blocked in
// the kernel - not an error, not a timeout, just never returning. One
// fs.readdirSync (sidecar subtitles, on a title page) froze the event loop; the
// listen backlog filled and every client got "connection refused" while the
// process still held port 8096, so the restarter could not replace it either
// (EADDRINUSE). It came back by itself the moment E: dropped off the bus.
//
// So, for any path that lives on a library volume:
//   - never a *Sync fs call on a request path or in the scan - use these;
//   - every call has a deadline (`wait`). A caller that runs out gets an
//     EDISKSTALL error and answers without the disk (a title page without its
//     subtitle list, a 503 for a stream) - never "missing", which would prune.
//   - While any call on a volume has been outstanding longer than a caller's
//     `wait`, that caller fails at once instead of queueing behind it. A thread
//     blocked in the kernel cannot be cancelled: it holds a libuv threadpool
//     slot until the device answers, and four of those was the whole default
//     pool - static files, art and DNS with it. The volume clears by itself when
//     the stuck call finally returns (device back, or dropped off: ENOENT).
//   - At most PER_VOLUME calls in flight per volume, so a hung volume pins a
//     few threads, never all of them.
// A spun-down disk waking (~10 s) is under STALL_MS, so the default patience
// rides it out; only callers that asked for less (title pages) skip it.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

const STALL_MS = 20000;
const PER_VOLUME = 4;

const vols = new Map(); // 'P:\' -> { key, inflight: Map(op -> startedAt), queue: [run] }

export const volumeOf = (p) => path.parse(path.resolve(String(p))).root.toUpperCase();

function vol(p) {
  const k = volumeOf(p);
  let v = vols.get(k);
  if (!v) vols.set(k, (v = { key: k, inflight: new Map(), queue: [] }));
  return v;
}

// How long the oldest outstanding call on this volume has been waiting.
function stuckFor(v) {
  let t = Infinity;
  for (const s of v.inflight.values()) if (s < t) t = s;
  return t === Infinity ? 0 : Date.now() - t;
}

function stallError(p, v) {
  const e = new Error(`disk not responding (${v.key}): ${p}`);
  e.code = 'EDISKSTALL';
  return e;
}

export const isStall = (e) => !!e && e.code === 'EDISKSTALL';
export const volumeStalled = (p) => stuckFor(vol(p)) > STALL_MS;

// Run fn() (returns a promise for one fs call on `p`) under the rules above.
export function diskOp(p, fn, { wait = STALL_MS } = {}) {
  const v = vol(p);
  wait = Math.min(wait, STALL_MS);
  if (stuckFor(v) >= wait) return Promise.reject(stallError(p, v));
  return new Promise((resolve, reject) => {
    let done = false;
    const give = setTimeout(() => { done = true; reject(stallError(p, v)); }, wait);
    const run = () => {
      if (done) return next(v); // caller already gave up while queued
      if (stuckFor(v) >= wait) { done = true; clearTimeout(give); reject(stallError(p, v)); return next(v); }
      const op = Promise.resolve().then(fn);
      v.inflight.set(op, Date.now());
      const warn = setTimeout(() => {
        console.error(`[disk] ${v.key} not responding (a call has waited ${STALL_MS / 1000}s); failing fast until it answers`);
        for (const q of v.queue.splice(0)) q(); // everything waiting for a slot fails now
      }, STALL_MS);
      op.then((r) => { if (!done) { done = true; resolve(r); } }, (e) => { if (!done) { done = true; reject(e); } })
        .finally(() => {
          const waited = Date.now() - v.inflight.get(op);
          clearTimeout(warn); clearTimeout(give);
          v.inflight.delete(op);
          if (waited > STALL_MS) console.error(`[disk] ${v.key} answered after ${Math.round(waited / 1000)}s`);
          next(v);
        });
    };
    if (v.inflight.size < PER_VOLUME) run(); else v.queue.push(run);
  });
}

function next(v) {
  while (v.inflight.size < PER_VOLUME && v.queue.length) v.queue.shift()();
}

const fsp = fs.promises;
export const stat = (p, o) => diskOp(p, () => fsp.stat(p), o);
export const readdir = (p, opts, o) => diskOp(p, () => fsp.readdir(p, opts), o);
export const readFile = (p, enc, o) => diskOp(p, () => fsp.readFile(p, enc), o);
export const access = (p, o) => diskOp(p, () => fsp.access(p), o);
export const rm = (p, opts, o) => diskOp(p, () => fsp.rm(p, opts), o);
// true/false like fs.existsSync, but a stalled disk throws rather than say "missing".
export const exists = (p, o) => access(p, o).then(() => true, (e) => { if (isStall(e)) throw e; return false; });

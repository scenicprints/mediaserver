// Find genuinely duplicated files, and recommend which copy to keep.
//
// This is the one part of the optimizer that never acts on its own. It reports;
// the owner decides. The reason is specific rather than squeamish:
//
// Matching on metadata DOES NOT WORK for this library. Episodic TV is encoded
// with identical settings and runs to identical lengths, so two different
// episodes routinely share the same size, duration, resolution and codec. A
// scan of this library found 98 such groups, and among them were
// "Family Guy S20E13" paired with "S20E14", and "How It's Made 12x01" paired
// with "14x04" — completely different content that is indistinguishable by
// every cheap test. Deleting on that evidence would destroy episodes.
//
// So metadata only ever produces CANDIDATES. Nothing is called a duplicate
// until the bytes have been compared. And even then, nothing is deleted here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tierOf, driveRank } from './engine.mjs';

// Hash a slice of the file rather than all of it: the first and last 64 MB plus
// the exact byte length. Two different episodes never collide on that, and it
// turns a 200 GB read into a few hundred megabytes. A full hash is available
// with { full: true } when certainty matters more than time.
//
// EVERY READ HERE MUST BE ASYNCHRONOUS, and that is not a style preference.
//
// This function used to be `async` in name only: openSync, readSync, closeSync
// all the way down, so the `await` at every call site returned an
// already-settled promise and never yielded. Node is single-threaded, so a
// synchronous 64 MB read off a USB disk freezes the ENTIRE process for as long
// as the platter takes — the HTTP server cannot answer, the encoder cannot
// advance, the window goes blank. Scanning a few hundred candidates froze it
// for minutes at a stretch and looked exactly like a crash. With { full: true }
// on a 50 GB file it was a single unbroken stall.
//
// fs.promises reads run on libuv's threadpool, so the event loop keeps turning
// and the rest of the program stays alive while the disk works. The buffer is
// also 4 MB and reused rather than 64 MB allocated per file: Buffer.alloc
// zero-fills, so the old version memset 64 MB for every file it looked at.
//
// The bytes fed to the hash are unchanged, so fingerprints still match those
// taken by the old code.
const READ_BUF = 4 << 20;

// Same reasoning as the reads below: existsSync looks free, but on a USB disk
// that has spun down it is a stall, and this is asked once per candidate file
// across hundreds of them.
const exists = (p) => fs.promises.access(p).then(() => true, () => false);

export async function fingerprint(file, { full = false } = {}) {
  const CHUNK = 64 * 1024 * 1024;
  const h = crypto.createHash('sha256');
  const { size } = await fs.promises.stat(file);
  h.update(String(size));

  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(READ_BUF, Math.max(1, size)));
    // Hash `bytes` starting at `start`, a bufferful at a time. Each read is an
    // await, which is the yield point that keeps the process responsive.
    const hashRange = async (start, bytes) => {
      let pos = start, left = bytes;
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), pos);
        if (bytesRead <= 0) break;
        h.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
        left -= bytesRead;
      }
    };

    if (full || size <= CHUNK * 2) {
      await hashRange(0, size);
    } else {
      await hashRange(0, CHUNK);
      await hashRange(size - CHUNK, CHUNK);
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}

// Which copy is worth keeping? Higher score wins. Deliberately conservative and
// explainable — the owner sees the reasoning, not just a verdict.
//
// Note what these tests can and cannot do here. Every copy in a group has the
// SAME BYTES — that is what got it into the group — so it necessarily has the
// same audio tracks, the same container contents, the same resolution. All
// three tests below therefore tie for every real duplicate, and the winner was
// whichever row SQLite happened to return first. The recommendation looked
// reasoned and was arbitrary.
//
// Drive health is the tiebreak, because it is the one thing that genuinely
// differs between two identical files: one of them is on a disk with 552
// reallocated sectors and the other is not. It is applied as a fraction so it
// orders ties without ever outranking a real difference — which matters
// because this same function is used where the copies are NOT identical.
export function scoreCopy(r) {
  let score = 0;
  const reasons = [];
  const audio = (() => { try { return JSON.parse(r.audio_json || '[]'); } catch { return []; } })();
  if (audio.length > 1) { score += audio.length; reasons.push(`${audio.length} audio tracks`); }
  if (/\.mkv$/i.test(r.path)) { score += 2; reasons.push('mkv (carries more)'); }
  // A file sitting in the folder its resolution says it belongs in is the more
  // deliberately-placed copy.
  const inRightFolder = tierOf(r.width, r.height) === '4K'
    ? /\\4k\\/i.test(r.path) : !/\\4k\\/i.test(r.path);
  if (inRightFolder) { score += 3; reasons.push('correct folder'); }

  // Healthiest drive first. driveRank returns 0 for the best drive in the
  // configured order, so a smaller rank must score higher.
  const rank = driveRank(r.path);
  score += 1 / (rank + 2);
  reasons.push(`on ${String(r.path).slice(0, 2).toUpperCase()}`);

  return { score, reasons };
}

/** Everything worth knowing about one copy, for a person deciding by eye. */
export function describeCopy(r) {
  let audio = [];
  try { audio = JSON.parse(r.audio_json || '[]'); } catch { /* no tracks listed */ }
  return {
    id: `${r.file_kind}:${r.file_id}`,
    path: r.path,
    drive: String(r.path || '').slice(0, 2).toUpperCase(),
    folder: path.dirname(String(r.path || '')),
    filename: path.basename(String(r.path || '')),
    size: Number(r.size) || 0,
    container: r.container || null,
    duration: Number(r.duration) || 0,
    vcodec: r.vcodec || null,
    width: r.width || null,
    height: r.height || null,
    tier: tierOf(r.width, r.height),
    vkbps: r.vkbps || null,
    hdr: !!r.hdr,
    audio: audio.map((a) => ({ codec: a.codec || null, ch: a.ch || null, kbps: a.kbps || null, lang: a.lang || null }))
  };
}

/**
 * Which of these fields actually differ across the copies?
 *
 * The honest answer for a byte-identical group is "only the location", and
 * saying so plainly is more useful than a table of numbers that are the same in
 * every column. It also makes a genuine difference impossible to miss.
 */
export function differencesBetween(copies) {
  const fields = [
    ['resolution', (c) => (c.width && c.height ? `${c.width}x${c.height}` : null)],
    ['video codec', (c) => c.vcodec],
    ['video bitrate', (c) => (c.vkbps ? Math.round(c.vkbps / 100) / 10 + ' Mbps' : null)],
    ['HDR', (c) => (c.hdr ? 'yes' : 'no')],
    ['container', (c) => c.container],
    ['runtime', (c) => (c.duration ? Math.round(c.duration / 60) + ' min' : null)],
    ['size', (c) => c.size],
    ['audio', (c) => c.audio.map((a) => `${a.codec} ${a.ch}ch${a.lang ? ' ' + a.lang : ''}`).join(' + ')]
  ];
  const out = [];
  for (const [name, get] of fields) {
    const values = copies.map(get);
    if (new Set(values.map((v) => String(v))).size > 1) out.push({ field: name, values });
  }
  return out;
}

// Is this file safe to delete as a duplicate, RIGHT NOW?
//
// The report is a snapshot and the owner acts on it later — possibly much
// later, possibly after the library has changed underneath it. So nothing is
// taken on trust from the report: the twin is found again and the bytes are
// compared again at the moment of deletion. A stale report must not be able to
// delete the last copy of anything.
//
// Returns { ok, keeper, reason }. Only ok:true is safe to act on.
export async function confirmDropSafe(db, fileKind, fileId, { full = false } = {}) {
  const me = db.prepare('SELECT * FROM media_info WHERE file_kind = ? AND file_id = ?').get(fileKind, fileId);
  if (!me) return { ok: false, reason: 'not in the library' };
  if (me.probe_error) return { ok: false, reason: 'this file cannot be read, so it cannot be compared' };
  if (!(await exists(me.path))) return { ok: false, reason: 'already gone from disk' };

  // The owner's rule, enforced here and not merely reported: 4K is never
  // deleted as a duplicate.
  if (tierOf(me.width, me.height) === '4K') {
    return { ok: false, reason: '4K — never deleted as a duplicate' };
  }

  // Find the same cheap group the report used, then prove it by reading.
  const peers = db.prepare(`
    SELECT * FROM media_info
    WHERE file_kind IS NOT NULL AND size = ? AND width = ? AND height = ? AND vcodec IS ?
      AND NOT (file_kind = ? AND file_id = ?)`)
    .all(me.size, me.width, me.height, me.vcodec, fileKind, fileId)
    .filter((p) => Math.abs((Number(p.duration) || 0) - (Number(me.duration) || 0)) < 1);

  if (!peers.length) return { ok: false, reason: 'nothing else in the library looks like this file' };

  let mine;
  try { mine = await fingerprint(me.path, { full }); }
  catch (e) { return { ok: false, reason: 'could not read this file: ' + e.message }; }

  for (const p of peers) {
    if (!(await exists(p.path))) continue;
    let theirs;
    try { theirs = await fingerprint(p.path, { full }); } catch { continue; }
    if (theirs === mine) return { ok: true, keeper: p, reason: null };
  }
  return { ok: false, reason: 'no surviving copy has identical bytes — this may be the only one' };
}

export async function findDuplicates(db, { log = () => {}, full = false, onProgress = null } = {}) {
  const rows = db.prepare(`
    SELECT mi.*, COALESCE(m.title, s.title) AS title
    FROM media_info mi
    LEFT JOIN movie_files   mf ON mi.file_kind='movie'   AND mf.id = mi.file_id
    LEFT JOIN movies        m  ON m.id  = mf.movie_id
    LEFT JOIN episode_files ef ON mi.file_kind='episode' AND ef.id = mi.file_id
    LEFT JOIN episodes      e  ON e.id  = ef.episode_id
    LEFT JOIN shows         s  ON s.id  = e.show_id
    WHERE mi.probe_error IS NULL AND mi.size > 0
      AND (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all();

  // Stage 1 — cheap. Group on everything that can be compared without reading.
  const groups = new Map();
  for (const r of rows) {
    const key = [r.size, Math.round(Number(r.duration) || 0), r.width, r.height, r.vcodec].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const candidates = [...groups.values()].filter((g) => g.length > 1);
  log(`${candidates.length} candidate group(s) from metadata — these are NOT yet duplicates`);

  // Stage 2 — read the bytes. This is what separates a real duplicate from two
  // episodes that merely encode alike.
  const confirmed = [];
  let checked = 0;
  for (const g of candidates) {
    const byHash = new Map();
    for (const r of g) {
      if (!(await exists(r.path))) continue;
      let fp;
      try { fp = await fingerprint(r.path, { full }); }
      catch (e) { log(`  could not read ${path.basename(r.path)}: ${e.message}`); continue; }
      if (!byHash.has(fp)) byHash.set(fp, []);
      byHash.get(fp).push(r);
    }
    checked++;
    if (onProgress) onProgress(checked, candidates.length);
    for (const [hash, same] of byHash) {
      if (same.length < 2) continue;
      const scored = same.map((r) => ({ r, ...scoreCopy(r) })).sort((a, b) => b.score - a.score);
      const is4k = same.some((r) => tierOf(r.width, r.height) === '4K');
      confirmed.push({
        hash,
        title: same[0].title || path.basename(same[0].path),
        size: Number(same[0].size) || 0,
        reclaimable: Number(same[0].size) * (same.length - 1),
        is4k,
        keep: scored[0],
        drop: scored.slice(1),
        // Full specifications for every copy, and an explicit list of what
        // actually differs between them. Without this the panel showed two
        // paths and a Delete button, which is not enough to decide anything.
        copies: scored.map((s) => ({ ...describeCopy(s.r), reasons: s.reasons, recommended: s === scored[0] })),
        differs: differencesBetween(scored.map((s) => describeCopy(s.r))),
        // The owner said 4K is never deleted as a duplicate. Surfaced, not acted on.
        note: is4k ? '4K — reported only, never proposed for deletion' : null
      });
    }
  }

  const falsePositives = candidates.length - confirmed.length;
  log(`${confirmed.length} genuine duplicate group(s); ${falsePositives} candidate group(s) were different files that merely look alike`);
  return { confirmed, candidateGroups: candidates.length, falsePositives };
}

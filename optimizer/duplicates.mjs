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
import { tierOf } from './engine.mjs';

// Hash a slice of the file rather than all of it: the first and last 64 MB plus
// the exact byte length. Two different episodes never collide on that, and it
// turns a 200 GB read into a few hundred megabytes. A full hash is available
// with { full: true } when certainty matters more than time.
export async function fingerprint(file, { full = false } = {}) {
  const CHUNK = 64 * 1024 * 1024;
  const h = crypto.createHash('sha256');
  const size = fs.statSync(file).size;
  h.update(String(size));
  const fd = fs.openSync(file, 'r');
  try {
    if (full || size <= CHUNK * 2) {
      const buf = Buffer.alloc(1 << 20);
      let pos = 0;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
        pos += n;
      }
    } else {
      const buf = Buffer.alloc(CHUNK);
      let n = fs.readSync(fd, buf, 0, CHUNK, 0);
      h.update(buf.subarray(0, n));
      n = fs.readSync(fd, buf, 0, CHUNK, size - CHUNK);
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Which copy is worth keeping? Higher score wins. Deliberately conservative and
// explainable — the owner sees the reasoning, not just a verdict.
function scoreCopy(r) {
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
  return { score, reasons };
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
  if (!fs.existsSync(me.path)) return { ok: false, reason: 'already gone from disk' };

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
    if (!fs.existsSync(p.path)) continue;
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
      if (!fs.existsSync(r.path)) continue;
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
        // The owner said 4K is never deleted as a duplicate. Surfaced, not acted on.
        note: is4k ? '4K — reported only, never proposed for deletion' : null
      });
    }
  }

  const falsePositives = candidates.length - confirmed.length;
  log(`${confirmed.length} genuine duplicate group(s); ${falsePositives} candidate group(s) were different files that merely look alike`);
  return { confirmed, candidateGroups: candidates.length, falsePositives };
}

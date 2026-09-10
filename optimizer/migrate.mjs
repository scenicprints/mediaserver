// Move the library into a pooled drive without losing anything.
//
// Six roots across four drives become three folders on one:
//
//   E:\4k, H:\4k            ->  P:\4K Movies
//   E:\Movies, H:\Movies    ->  P:\Movies
//   F:\, G:\TV Shows        ->  P:\TV Shows
//
// The whole problem is in that arrow. Two files can currently share a name and
// coexist because they are on different drives; in one folder, one of them
// overwrites the other. A first pass over this library found 53 such pairs
// holding 142 GiB — and among them were *Return of the Jedi* at 55 GiB and at
// 27 GiB, which is not an accident. This library keeps several versions of a
// title ON PURPOSE. A migration that "just moves the files" would delete half
// of a deliberate collection and report success.
//
// So nothing moves until every collision has been classified:
//
//   VERSION    different bytes -> both are wanted. Keep both, give the second a
//              name that says what it is rather than picking a winner.
//   DUPLICATE  identical bytes -> one is redundant. Move one; LEAVE the other
//              exactly where it is.
//   UNKNOWN    cannot be read -> never touched, reported for a person.
//
// Note what DUPLICATE does not do: delete. A migration that deletes has two
// ways to lose a file instead of one, and it would be making that call about
// thousands of files in a single unattended run. So the redundant copy simply
// stays behind on the old drive and goes in the report. The owner deletes it
// later, or never — the old drives are being retired anyway, so doing nothing
// also works. The migration's blast radius is "a file is in two places", which
// costs disk. It is never "a file is in no places".
//
// This module PLANS. It reads, it fingerprints, it decides, and it writes
// nothing. Executing the plan is a separate step that takes this output as
// input, so the decisions can be reviewed before any file moves.
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './duplicates.mjs';
import { driveRank } from './engine.mjs';

// Longest prefix wins, so H:\4k is matched before H:\ would be.
export const DEFAULT_MAP = [
  ['E:/4k', 'P:/4K Movies'],
  ['H:/4k', 'P:/4K Movies'],
  ['E:/Movies', 'P:/Movies'],
  ['H:/Movies', 'P:/Movies'],
  ['G:/TV Shows', 'P:/TV Shows'],
  ['F:/', 'P:/TV Shows']
];

const norm = (p) => String(p || '').replace(/\\/g, '/');
const win = (p) => String(p || '').replace(/\//g, '\\');

/** Where a current path lands in the pool, or null if no rule covers it. */
export function targetFor(sourcePath, map = DEFAULT_MAP) {
  const n = norm(sourcePath);
  const ordered = [...map].sort((a, b) => norm(b[0]).length - norm(a[0]).length);
  for (const [from, to] of ordered) {
    const f = norm(from).replace(/\/+$/, '');
    if (n.toLowerCase() === f.toLowerCase()) return norm(to);
    if (n.toLowerCase().startsWith(f.toLowerCase() + '/')) {
      return path.posix.join(norm(to), n.slice(f.length + 1));
    }
  }
  return null;
}

/**
 * A name that distinguishes a second version instead of overwriting the first.
 *
 * The size is the label because it is the thing that actually differs and the
 * thing the owner cares about — a 55 GiB remux and a 27 GiB encode of the same
 * film are kept apart for a reason, and "[55GB]" says which is which at a
 * glance. Marquee already models several files per title, so both remain one
 * movie with two versions.
 *
 * The label alone is NOT guaranteed unique — 26.6 GB and 27.2 GB both round to
 * 27 — so callers must run the result past a taken-set. `uniqueName` does that
 * and is what the planner actually uses; a test caught this by planning six
 * versions of one title and watching them all collapse onto "[0GB]".
 */
export function versionedName(targetPath, sizeBytes) {
  const dir = path.posix.dirname(norm(targetPath));
  const ext = path.posix.extname(targetPath);
  const stem = path.posix.basename(targetPath, ext);
  const gb = Math.round(Number(sizeBytes) / 2 ** 30);
  return path.posix.join(dir, `${stem} [${gb}GB]${ext}`);
}

/** The first name in the `X`, `X (2)`, `X (3)` sequence that nobody has claimed. */
export function uniqueName(candidate, taken) {
  if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
  const dir = path.posix.dirname(candidate);
  const ext = path.posix.extname(candidate);
  const stem = path.posix.basename(candidate, ext);
  for (let i = 2; ; i++) {
    const c = path.posix.join(dir, `${stem} (${i})${ext}`);
    if (!taken.has(c.toLowerCase())) { taken.add(c.toLowerCase()); return c; }
  }
}

/**
 * Build the migration plan.
 *
 * Returns { moves, collisions, unmapped, stats }. Nothing is written. `moves`
 * is every file with its final destination; a collision that resolved to
 * DUPLICATE contributes one move and one `drop` entry rather than two moves.
 */
export async function planMigration(db, {
  map = DEFAULT_MAP,
  full = false,          // full-file hashing rather than head/tail sampling
  log = () => {},
  onProgress = null
} = {}) {
  const rows = db.prepare('SELECT file_kind, file_id, path, size FROM media_info').all();

  const byTarget = new Map();
  const unmapped = [];
  for (const r of rows) {
    const t = targetFor(r.path, map);
    if (!t) { unmapped.push(r); continue; }
    const key = t.toLowerCase();
    if (!byTarget.has(key)) byTarget.set(key, { target: t, files: [] });
    byTarget.get(key).files.push(r);
  }

  const moves = [];
  const collisions = [];
  const contested = [...byTarget.values()].filter((g) => g.files.length > 1);

  // Every plain destination is spoken for before any renaming starts, so a
  // generated version name can never land on a file that was already going to
  // be there under its own name.
  const taken = new Set([...byTarget.keys()]);
  log(`${rows.length} file(s); ${contested.length} contested destination(s) to classify`);

  let done = 0;
  for (const group of byTarget.values()) {
    if (group.files.length === 1) {
      const f = group.files[0];
      moves.push({ kind: f.file_kind, fileId: f.file_id, from: win(f.path), to: win(group.target), reason: 'unique' });
      continue;
    }

    // Contested. Read the bytes before deciding anything.
    const sized = [];
    for (const f of group.files) {
      let real = Number(f.size) || 0;
      let fp = null, err = null;
      try { real = fs.statSync(f.path).size; } catch (e) { err = e.message; }
      if (!err) {
        try { fp = await fingerprint(f.path, { full }); } catch (e) { err = e.message; }
      }
      sized.push({ ...f, real, fp, err });
    }
    done++;
    if (onProgress) onProgress(done, contested.length);

    const unreadable = sized.filter((s) => s.err);
    if (unreadable.length) {
      // Never guess about a file that cannot be read.
      collisions.push({ target: win(group.target), verdict: 'UNKNOWN', files: sized.map(strip),
        note: 'at least one file could not be read; left alone for a person to look at' });
      continue;
    }

    const identical = sized.every((s) => s.fp === sized[0].fp);
    if (identical) {
      // Same bytes, so the only question is which copy makes the trip. Take the
      // one on the healthiest drive: it is the one most likely to still be
      // readable when the copy actually happens.
      const [keep, ...rest] = [...sized].sort((a, b) => driveRank(a.path) - driveRank(b.path));
      moves.push({ kind: keep.file_kind, fileId: keep.file_id, from: win(keep.path), to: win(group.target), reason: 'one of an identical pair' });
      collisions.push({
        target: win(group.target), verdict: 'DUPLICATE',
        keep: win(keep.path), leave: rest.map((d) => win(d.path)),
        bytes: rest.reduce((n, d) => n + d.real, 0),
        files: sized.map(strip),
        note: 'identical bytes; the other copy stays put and is not deleted'
      });
      continue;
    }

    // Different bytes: every one of these is wanted. Largest keeps the plain
    // name; the rest get a size-labelled one.
    const ordered = [...sized].sort((a, b) => b.real - a.real);
    const renamed = [];
    ordered.forEach((f, i) => {
      const to = i === 0 ? group.target : uniqueName(versionedName(group.target, f.real), taken);
      if (i > 0) renamed.push(win(to));
      moves.push({ kind: f.file_kind, fileId: f.file_id, from: win(f.path), to: win(to),
        reason: i === 0 ? 'largest version keeps the name' : 'version, renamed to keep both' });
    });
    collisions.push({
      target: win(group.target), verdict: 'VERSION',
      files: sized.map(strip),
      renamedTo: renamed
    });
  }

  // A plan that would still overwrite something is a broken plan. This is the
  // assertion that the whole module exists to be able to make.
  const dests = new Map();
  for (const m of moves) {
    const k = m.to.toLowerCase();
    if (!dests.has(k)) dests.set(k, []);
    dests.get(k).push(m);
  }
  const overwrites = [...dests.entries()].filter(([, v]) => v.length > 1);

  return {
    moves,
    collisions,
    unmapped: unmapped.map((u) => win(u.path)),
    overwrites: overwrites.map(([k, v]) => ({ target: k, from: v.map((m) => m.from) })),
    stats: {
      files: rows.length,
      moves: moves.length,
      contested: contested.length,
      duplicates: collisions.filter((c) => c.verdict === 'DUPLICATE').length,
      versions: collisions.filter((c) => c.verdict === 'VERSION').length,
      unknown: collisions.filter((c) => c.verdict === 'UNKNOWN').length,
      reclaimableBytes: collisions.filter((c) => c.verdict === 'DUPLICATE').reduce((n, c) => n + (c.bytes || 0), 0)
    }
  };
}

function strip(s) {
  return { path: win(s.path), size: s.real, kind: s.file_kind, fileId: s.file_id, err: s.err || null };
}

/** Write the plan somewhere a person can read it before agreeing to it. */
export function writePlan(plan, file) {
  const GB = (b) => (Number(b) / 2 ** 30).toFixed(2) + ' GB';
  const out = [];
  out.push('POOL MIGRATION PLAN — ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  out.push('');
  out.push('NOTHING HAS BEEN MOVED. This is what would happen.');
  out.push('');
  out.push(`files            : ${plan.stats.files}`);
  out.push(`moves planned    : ${plan.stats.moves}`);
  out.push(`contested names  : ${plan.stats.contested}`);
  out.push(`  kept as versions: ${plan.stats.versions}   (different bytes — both wanted)`);
  out.push(`  true duplicates : ${plan.stats.duplicates}   (identical bytes — ${GB(plan.stats.reclaimableBytes)} left behind, yours to delete)`);
  out.push(`  unreadable      : ${plan.stats.unknown}   (left alone)`);
  out.push(`unmapped files   : ${plan.unmapped.length}`);
  out.push(`WOULD OVERWRITE  : ${plan.overwrites.length}   (must be 0)`);
  out.push('');

  for (const c of plan.collisions) {
    out.push(`--- ${c.verdict}  ${c.target}`);
    for (const f of c.files) out.push(`      ${GB(f.size).padStart(10)}  ${f.path}${f.err ? '   [' + f.err + ']' : ''}`);
    if (c.verdict === 'DUPLICATE') { out.push(`      MOVE  ${c.keep}`); c.leave.forEach((d) => out.push(`      LEAVE ${d}   (not deleted — delete by hand if you want the space)`)); }
    if (c.verdict === 'VERSION') c.renamedTo.forEach((r) => out.push(`      renamed -> ${r}`));
    if (c.note) out.push(`      ${c.note}`);
    out.push('');
  }

  if (plan.overwrites.length) {
    out.push('!!! THESE WOULD STILL OVERWRITE — DO NOT RUN THIS PLAN !!!');
    for (const o of plan.overwrites) { out.push('  ' + o.target); o.from.forEach((f) => out.push('      ' + f)); }
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.join('\r\n'), 'utf8');
  } catch { /* the report is a convenience, not the work */ }
  return file;
}

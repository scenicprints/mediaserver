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
import { driveRank, copyNoClobberAsync, findCollisions } from './engine.mjs';

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

// ---- Carrying the plan out ---------------------------------------------
//
// Twenty thousand files, tens of terabytes, many hours, across USB disks that
// have already logged IO retries. It WILL be interrupted — by a reboot, a
// dropped enclosure, a power cut, someone closing the window. So the run is a
// journal rather than a loop: every file's state is on disk before and after
// the thing that changes it, and starting again picks up mid-file without
// redoing or re-losing anything.
//
// The order below is the whole design, and it is deliberately not the obvious
// one. Copy, verify, THEN point the library at the new copy, and only then
// delete the old one:
//
//   copy      -> both copies exist. A crash here costs disk, nothing else.
//   verify    -> the bytes at the destination are proved equal to the source.
//   repoint   -> the library now refers to the new copy, which is known good.
//   delete    -> the source goes, and it is the last thing to happen.
//
// Deleting before repointing leaves a window where the library points at a file
// that no longer exists. Repointing before verifying leaves one pointing at a
// bad copy. Every other ordering of these four steps has a window where a file
// is lost or unreachable; this one's worst case is a duplicate.

export function ensureMigrateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_moves (
      id          INTEGER PRIMARY KEY,
      file_kind   TEXT,
      file_id     INTEGER,
      src         TEXT NOT NULL,
      dst         TEXT NOT NULL,
      bytes       INTEGER DEFAULT 0,
      state       TEXT NOT NULL DEFAULT 'planned',
      error       TEXT,
      started_at  INTEGER,
      finished_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pool_moves_src ON pool_moves (src);
    CREATE INDEX IF NOT EXISTS pool_moves_state ON pool_moves (state);
  `);
}

/**
 * Write the plan into the journal.
 *
 * Refuses to touch a run that is part-way through. A plan is a snapshot of a
 * library the optimizer is still rewriting underneath it, so merging a fresh
 * plan into a half-finished run would mix two different views of where the
 * files are — and the older view would be the one holding the delete list.
 */
export function journalPlan(db, plan, { replace = false } = {}) {
  ensureMigrateSchema(db);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM pool_moves').get().n;
  if (existing && !replace) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM pool_moves WHERE state NOT IN ('done','skipped')").get().n;
    if (left) throw new Error(`a migration is already part-way through (${left} of ${existing} files left) — finish it or clear it first`);
    return { inserted: 0, alreadyDone: existing };
  }
  if (replace) db.exec('DELETE FROM pool_moves');

  const ins = db.prepare("INSERT INTO pool_moves (file_kind, file_id, src, dst, bytes, state) VALUES (?, ?, ?, ?, ?, 'planned')");
  db.exec('BEGIN');
  try {
    for (const m of plan.moves) {
      let bytes = 0;
      try { bytes = fs.statSync(m.from).size; } catch { /* re-checked at copy time */ }
      ins.run(m.kind ?? null, m.fileId ?? null, m.from, m.to, bytes);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted: plan.moves.length, alreadyDone: 0 };
}

/**
 * Everything that must be true before the first byte moves.
 *
 * Checked here, once, against the real filesystem rather than asserted per-file
 * halfway through. A run that stops on file 9,000 because the pool filled up is
 * a run that has left the library in two places with a plan for neither.
 */
export function preflight(db, { poolRoot = 'P:\\', headroomBytes = 50 * 2 ** 30 } = {}) {
  ensureMigrateSchema(db);
  const problems = [];
  const rows = db.prepare("SELECT * FROM pool_moves WHERE state NOT IN ('done','skipped')").all();
  if (!rows.length) problems.push('nothing is queued — journal a plan first');

  // The pool has to actually be mounted. Writing to a drive letter that is not
  // there does not fail loudly on Windows; it fails one mkdir at a time, deep
  // into a run.
  try {
    if (!fs.statSync(poolRoot).isDirectory()) problems.push(`${poolRoot} is not a directory`);
  } catch { problems.push(`${poolRoot} does not exist — is the pool mounted?`); }

  // Nothing may land on a file already on disk, or on another move's
  // destination. The planner asserts this too; it is re-asserted here because
  // the plan may have been made days ago and the library has not stood still.
  const clashes = findCollisions(rows.map((r) => ({ from: r.src, to: r.dst })));
  for (const c of clashes.slice(0, 20)) problems.push(`collision: ${c.to} (${c.why})`);
  if (clashes.length > 20) problems.push(`...and ${clashes.length - 20} more collisions`);

  const missing = rows.filter((r) => !fs.existsSync(r.src));
  if (missing.length) problems.push(`${missing.length} source file(s) have moved or gone since the plan was made — re-plan`);

  // Room for all of it, plus slack. Only one file is duplicated at a time, so
  // the requirement is the total plus headroom rather than twice anything.
  const need = rows.reduce((n, r) => n + (Number(r.bytes) || 0), 0);
  let free = -1;
  try { const s = fs.statfsSync(poolRoot); free = Number(s.bavail) * Number(s.bsize); } catch { /* reported below */ }
  if (free < 0) problems.push(`could not read free space on ${poolRoot}`);
  else if (free < need + headroomBytes) {
    problems.push(`pool has ${(free / 2 ** 40).toFixed(2)} TiB free, needs ${((need + headroomBytes) / 2 ** 40).toFixed(2)} TiB`);
  }

  return { ok: problems.length === 0, problems, files: rows.length, bytes: need, freeBytes: free };
}

/**
 * Move one file and repoint the library at it. The unit of crash-safety.
 *
 * Returns { state, error } and does not throw for an expected failure: one
 * unreadable file on a tired drive must not strand the other twenty thousand.
 *
 * `copyFn` is injectable for one reason: the byte-verify below is the guard
 * standing between a bad copy and the deletion of the only good one, and there
 * is no way to make a real copy silently corrupt itself on demand. A guard that
 * has never been watched working is a guard nobody should trust, so the test
 * suite supplies a copy that lands the wrong bytes and checks what happens.
 */
export async function migrateOne(db, row, { full = false, copyFn = copyNoClobberAsync } = {}) {
  const setState = db.prepare('UPDATE pool_moves SET state = ?, error = ?, finished_at = ? WHERE id = ?');
  const fail = (msg) => { setState.run('failed', msg, Date.now(), row.id); return { state: 'failed', error: msg }; };

  // Resuming: a row left in 'copied' already has a verified destination and a
  // repointed library. All that is still owed is deleting the source.
  if (row.state !== 'copied') {
    if (!fs.existsSync(row.src)) return fail('source is gone');
    if (fs.existsSync(row.dst)) return fail('destination already exists — refusing to overwrite');

    db.prepare('UPDATE pool_moves SET state = ?, started_at = ?, error = NULL WHERE id = ?').run('copying', Date.now(), row.id);
    try {
      await copyFn(row.src, row.dst);
    } catch (e) {
      try { fs.rmSync(row.dst + '.partial', { force: true }); } catch {}
      return fail('copy failed: ' + e.message);
    }

    // The copy already checked the size. This checks the bytes, because the
    // very next thing that happens is the original being deleted.
    try {
      const a = await fingerprint(row.src, { full });
      const b = await fingerprint(row.dst, { full });
      if (a !== b) {
        fs.rmSync(row.dst, { force: true });
        return fail('the copy does not match the source — copy removed, original untouched');
      }
    } catch (e) {
      try { fs.rmSync(row.dst, { force: true }); } catch {}
      return fail('could not verify the copy: ' + e.message);
    }

    // Verified. Point the library at the new copy and record having done so, in
    // one transaction, before anything is deleted.
    db.exec('BEGIN');
    try {
      repointFile(db, row);
      setState.run('copied', null, null, row.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return fail('could not update the library: ' + e.message); }
  }

  // Last: remove the source. If this fails the file is still safe — it is
  // merely in two places, and the row says so rather than claiming success.
  try {
    if (fs.existsSync(row.src)) fs.rmSync(row.src);
  } catch (e) {
    setState.run('copied', 'moved and repointed, but the old copy could not be deleted: ' + e.message, Date.now(), row.id);
    return { state: 'copied', error: e.message };
  }
  setState.run('done', null, Date.now(), row.id);
  return { state: 'done', error: null };
}

/** Rewrite every reference to this file's old path. Runs inside a transaction. */
function repointFile(db, row) {
  const dst = row.dst;
  const base = path.win32.basename(dst);
  if (row.file_kind === 'movie') {
    db.prepare('UPDATE movie_files SET path = ?, filename = ? WHERE id = ?').run(dst, base, row.file_id);
  } else if (row.file_kind === 'episode') {
    db.prepare('UPDATE episode_files SET path = ?, filename = ? WHERE id = ?').run(dst, base, row.file_id);
  }
  db.prepare('UPDATE media_info SET path = ? WHERE file_kind = ? AND file_id = ?').run(dst, row.file_kind, row.file_id);
}

/**
 * Run the journal to completion, or until told to stop.
 *
 * `isWatching` is the same rule the optimizer follows, for the same reason:
 * this saturates the disks playback reads from. It fails CLOSED — anything
 * other than a definite "no", including an error, stands the run down. The
 * version of this check that failed open is why a friend's film went choppy.
 */
export async function runMigration(db, {
  log = () => {},
  full = false,
  isWatching = async () => true,
  shouldStop = () => false,
  pauseMs = 0,
  onProgress = () => {}
} = {}) {
  ensureMigrateSchema(db);
  const started = Date.now();
  const stats = { done: 0, failed: 0, bytes: 0 };

  for (;;) {
    if (shouldStop()) { log('stopping — asked to'); break; }

    let watching = true;
    try { watching = await isWatching(); } catch { watching = true; }
    if (watching !== false) { log('someone is watching, or it cannot be determined — standing down'); break; }

    // 'copied' rows first: they are one delete away from finished and each one
    // is currently costing double the disk.
    const row = db.prepare(
      "SELECT * FROM pool_moves WHERE state IN ('planned','copying','copied') ORDER BY state = 'copied' DESC, id LIMIT 1"
    ).get();
    if (!row) { log('nothing left to move'); break; }

    const r = await migrateOne(db, row, { full });
    if (r.state === 'done') { stats.done++; stats.bytes += Number(row.bytes) || 0; }
    else if (r.state === 'failed') { stats.failed++; log(`FAILED ${row.src}: ${r.error}`); }
    onProgress(stats, row, r);

    if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
  }

  stats.elapsedMs = Date.now() - started;
  return stats;
}

/**
 * Collapse the six library roots into the three pool folders.
 *
 * Runs after the files have moved. A root that still holds files is left alone
 * and reported: deleting a library row out from under a file that never made
 * the trip makes it vanish from Marquee while sitting safely on disk, which
 * looks exactly like data loss and is much harder to diagnose.
 */
export function repointLibraries(db, map = DEFAULT_MAP) {
  const targets = [...new Set(map.map(([, to]) => win(to)))];
  const out = { created: [], repointed: [], kept: [], removed: [] };

  for (const t of targets) {
    const type = /tv shows$/i.test(t) ? 'tv' : 'movie';
    let lib = db.prepare('SELECT * FROM libraries WHERE lower(path) = lower(?)').get(t);
    if (!lib) {
      db.prepare('INSERT INTO libraries (path, type, name) VALUES (?, ?, ?)').run(t, type, path.win32.basename(t));
      lib = db.prepare('SELECT * FROM libraries WHERE lower(path) = lower(?)').get(t);
      out.created.push(t);
    }
    const table = type === 'tv' ? 'episode_files' : 'movie_files';
    const n = db.prepare(`UPDATE ${table} SET library_id = ? WHERE path LIKE ? AND library_id IS NOT ?`)
      .run(lib.id, t + '\\%', lib.id).changes;
    if (n) out.repointed.push({ path: t, files: n });
  }

  for (const old of db.prepare('SELECT * FROM libraries').all()) {
    if (targets.some((t) => t.toLowerCase() === String(old.path).toLowerCase())) continue;
    const movies = db.prepare('SELECT COUNT(*) AS n FROM movie_files WHERE library_id = ?').get(old.id).n;
    const eps = db.prepare('SELECT COUNT(*) AS n FROM episode_files WHERE library_id = ?').get(old.id).n;
    if (movies + eps > 0) { out.kept.push({ path: old.path, files: movies + eps }); continue; }
    db.prepare('DELETE FROM libraries WHERE id = ?').run(old.id);
    out.removed.push(old.path);
  }
  return out;
}

/** What the run looks like right now, for a progress bar or a status line. */
export function migrationStatus(db) {
  ensureMigrateSchema(db);
  const rows = db.prepare('SELECT state, COUNT(*) AS n, SUM(bytes) AS b FROM pool_moves GROUP BY state').all();
  const by = Object.fromEntries(rows.map((r) => [r.state, { files: r.n, bytes: Number(r.b) || 0 }]));
  const total = rows.reduce((n, r) => n + r.n, 0);
  const done = by.done?.files || 0;
  return {
    total,
    done,
    failed: by.failed?.files || 0,
    inFlight: (by.copying?.files || 0) + (by.copied?.files || 0),
    remaining: total - done,
    percent: total ? Math.round((done / total) * 100) : 0,
    byState: by,
    failures: db.prepare("SELECT src, dst, error FROM pool_moves WHERE state = 'failed' ORDER BY id LIMIT 50").all()
  };
}

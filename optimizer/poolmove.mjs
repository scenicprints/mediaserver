// Move the library into the pool without copying anything.
//
// StableBit DrivePool exposes a pool by showing the contents of a hidden
// PoolPart.<guid> folder on each member drive. A file already ON a member drive
// therefore joins the pool by being moved into that drive's own PoolPart folder
// — which is a rename within one volume. Instant, no bytes read or written.
// Measured on this machine: 256 MB in 2 ms, visible through P: immediately.
//
// That is the whole reason this step is not a multi-day copy. 23 TiB of media
// joins the pool in the time it takes NTFS to rewrite 20,000 directory entries.
//
// Six roots collapse into three categories, exactly as the cross-drive planner
// does, so both operations agree about where a file belongs:
//
//   E:\4k     H:\4k       ->  <drive>\PoolPart.x\4K Movies  ->  P:\4K Movies
//   E:\Movies H:\Movies   ->  <drive>\PoolPart.x\Movies     ->  P:\Movies
//   F:\                   ->  <drive>\PoolPart.x\TV Shows   ->  P:\TV Shows
//
// G: is deliberately absent. It is not a pool member: its media is copied into
// the pool separately (a real copy, since it crosses drives) and it then
// becomes the download drive.
import fs from 'node:fs';
import path from 'node:path';
import { findCollisions } from './engine.mjs';

/** Which category each source root maps to. Longest prefix wins. */
export const ROOT_MAP = [
  ['E:\\4k', '4K Movies'],
  ['E:\\Movies', 'Movies'],
  ['H:\\4k', '4K Movies'],
  ['H:\\Movies', 'Movies'],
  ['F:\\', 'TV Shows']
];

/**
 * Files the owner has decided about individually.
 *
 * Two of the contested pairs are not two encodes of one film, they are
 * different CUTS — the original theatrical releases against the official 4K
 * Special Editions — which the runtimes prove (Star Wars 122 vs 125 min, Jedi
 * 133 vs 135; theatrical runs 121 and 131). Both are wanted, so the plain name
 * goes to the official HDR/Atmos release and the print scan is labelled.
 *
 * `rename` changes the name inside the pool. `drop` leaves the file exactly
 * where it is and out of the pool — nothing here deletes anything.
 */
export const OVERRIDES = {
  'e:\\4k\\star wars (1977).mkv':
    { rename: 'Star Wars (1977) - Original Theatrical.mkv', why: 'original theatrical cut, 122 min' },
  'e:\\4k\\return of the jedi (1983).mkv':
    { rename: 'Return of the Jedi (1983) - Original Theatrical.mkv', why: 'original theatrical cut, 133 min' },
  // Same cut, weaker encode, and no 1080p exists for this film — so it stays as
  // the compatible fallback and size is the honest label.
  'h:\\4k\\war of the worlds (2005).mkv':
    { rename: 'War of the Worlds (2005) [6GB].mkv', why: 'lesser 4K encode kept as the fallback; no 1080p exists' },
  // Same cut, weaker encode, and a 1080p copy already covers the fallback role.
  'h:\\4k\\the running man (1987).mkv':
    { drop: true, why: '4.54 GB 4K encode; the 37.90 GB HDR copy and a 1080p both exist' },
  'e:\\4k\\saving private ryan (1998).mkv':
    { drop: true, why: '10.40 GB 4K encode; the 26.01 GB HDR copy and a 1080p both exist' },
};

/**
 * Paths dropped by EXACT, case-sensitive match.
 *
 * H:\4k holds two byte-identical copies of Spider-Man Far From Home whose names
 * differ only in the case of one letter. The map above is keyed on a lowercased
 * path, so both collapse onto the same key and a dry run showed it dropping
 * BOTH of them — losing the film from the pool entirely. Anything distinguished
 * only by case has to be matched with its case intact.
 */
export const DROP_EXACT = new Map([
  ['H:\\4k\\Spider-Man Far from Home (2019).mkv',
    'byte-identical duplicate of "Far From Home", differs only in filename case; the other copy goes into the pool']
]);

/**
 * The PoolPart folder inside `container`, or null if there is none.
 *
 * Takes the containing directory rather than a drive letter. The first version
 * did `drive.slice(0, 2) + '\\'`, which works for E: and H: and for nothing
 * else — it could not be tested against a temporary directory, and four tests
 * failed on exactly that. A pool part always sits beside the source roots, so
 * the caller passes their parent and this works for any path.
 */
export function poolPartOf(container) {
  const root = /^[A-Za-z]:$/.test(container) ? container + '\\' : container;
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  const parts = names.filter((n) => /^PoolPart\./i.test(n));
  if (!parts.length) return null;
  // A drive can carry an abandoned pool part from an older pool. The live one is
  // whichever the pool actually reads, so prefer the newest by creation time.
  const live = parts
    .map((n) => ({ n, t: (() => { try { return fs.statSync(path.join(root, n)).birthtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.t - a.t)[0];
  return path.join(root, live.n);
}

/**
 * Category for a source path, or null if no root covers it.
 *
 * Also returns the root that matched, because the pool part lives beside that
 * root — deriving it from the first two characters of the path only ever worked
 * for drive letters.
 */
export function categoryOf(p, map = ROOT_MAP) {
  const s = String(p || '');
  const ordered = [...map].sort((a, b) => b[0].replace(/\\+$/, '').length - a[0].replace(/\\+$/, '').length);
  for (const [root, cat] of ordered) {
    const r = root.replace(/\\+$/, '');
    if (s.toLowerCase() === r.toLowerCase()) return { cat, rest: '', root };
    if (s.toLowerCase().startsWith(r.toLowerCase() + '\\')) return { cat, rest: s.slice(r.length + 1), root };
  }
  return null;
}

/** Where a root's pool part sits: alongside the root, i.e. in its parent. */
export function containerOf(root) {
  const r = String(root).replace(/\\+$/, '');
  if (/^[A-Za-z]:$/.test(r)) return r + '\\';     // 'F:\' maps to the volume root
  return path.dirname(r);
}

/**
 * Plan the move. Reads only; writes nothing.
 *
 * Returns { moves, drops, unmapped, overwrites, stats }. Each move carries both
 * destinations: `physical` is where the file is renamed to on its own drive, and
 * `pool` is the path the library will point at once DrivePool shows it.
 */
export function planPoolMove(db, { map = ROOT_MAP, poolLetter = 'P' } = {}) {
  const rows = db.prepare(`SELECT file_kind, file_id, path, size FROM media_info`).all();
  const parts = new Map();
  const moves = [], drops = [], unmapped = [], noPart = [];

  for (const r of rows) {
    const hit = categoryOf(r.path, map);
    if (!hit) { unmapped.push(r.path); continue; }

    const container = containerOf(hit.root);
    if (!parts.has(container)) parts.set(container, poolPartOf(container));
    const part = parts.get(container);
    if (!part) { noPart.push(r.path); continue; }

    // Case-sensitive first: two files can differ only in the case of a letter.
    if (DROP_EXACT.has(r.path)) { drops.push({ ...r, why: DROP_EXACT.get(r.path) }); continue; }

    const key = String(r.path).toLowerCase();
    const ov = OVERRIDES[key];
    if (ov && ov.drop) { drops.push({ ...r, why: ov.why }); continue; }

    // The name inside the pool: usually unchanged, sometimes overridden.
    const rest = ov && ov.rename
      ? path.join(path.dirname(hit.rest), ov.rename)
      : hit.rest;

    moves.push({
      kind: r.file_kind, fileId: r.file_id, size: Number(r.size) || 0,
      from: r.path,
      physical: path.join(part, hit.cat, rest),
      pool: path.join(`${poolLetter}:\\`, hit.cat, rest),
      renamed: !!(ov && ov.rename),
      why: ov ? ov.why : null
    });
  }

  // Two files must never want one name, on a drive or in the pool view.
  const overwrites = [
    ...findCollisions(moves.map((m) => ({ from: m.from, to: m.physical }))),
    ...(() => {
      const byPool = new Map();
      const out = [];
      for (const m of moves) {
        const k = m.pool.toLowerCase();
        if (byPool.has(k)) out.push({ from: m.from, to: m.pool, why: `also claimed by ${byPool.get(k)}` });
        byPool.set(k, m.from);
      }
      return out;
    })()
  ];

  return {
    moves, drops, unmapped, noPart, overwrites,
    stats: {
      files: rows.length,
      moves: moves.length,
      renamed: moves.filter((m) => m.renamed).length,
      drops: drops.length,
      unmapped: unmapped.length,
      noPart: noPart.length,
      bytes: moves.reduce((n, m) => n + m.size, 0),
      overwrites: overwrites.length
    }
  };
}

/**
 * Everything still sitting on the mapped roots after the library moved.
 *
 * The library tracks video files, so that is all the plan above moved - and it
 * left 543 subtitle sidecars behind on the old roots. A player finds subtitles
 * by looking for a file of the same name beside the video, so a film in the
 * pool with its .srt on H:\Movies has silently lost its subtitles.
 *
 * These follow exactly the same mapping as the video they belong to, which is
 * why they can be planned the same way. They are not in the database, so
 * nothing needs repointing - they just have to travel with their film.
 *
 * `keep` lists paths that are meant to stay outside the pool, so the two films
 * deliberately excluded are not dragged in by this sweep.
 */
// Things that live on a drive because of the drive or an old tool, not because
// they are part of the library: Seagate's autorun and volume icons, Windows
// shortcuts, macOS resource forks, and 261 .metathumb thumbnails from whatever
// generated them. Carrying these into the pool would just spread the litter.
const JUNK = /^(\._|\.VolumeIcon|Autorun\.inf$|desktop\.ini$|Thumbs\.db$)|\.(lnk|metathumb)$/i;

export function planLeftovers({ map = ROOT_MAP, poolLetter = 'P', keep = null } = {}) {
  const exclude = keep || new Set([
    ...Object.entries(OVERRIDES).filter(([, o]) => o.drop).map(([p]) => p.toLowerCase()),
    ...[...DROP_EXACT.keys()].map((p) => p.toLowerCase())
  ]);

  const moves = [], skipped = [];
  for (const [root, cat] of map) {
    const container = containerOf(root);
    const part = poolPartOf(container);
    if (!part) continue;

    const walk = (dir) => {
      let es = [];
      try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          // Never walk into a pool part - those files are already home.
          if (/^PoolPart\./i.test(e.name)) continue;
          if (/^(System Volume Information|\$RECYCLE\.BIN)$/i.test(e.name)) continue;
          walk(p);
          continue;
        }
        if (exclude.has(p.toLowerCase())) { skipped.push({ path: p, why: 'deliberately kept outside the pool' }); continue; }
        if (JUNK.test(e.name)) { skipped.push({ path: p, why: 'drive or tool litter, not library content' }); continue; }
        const hit = categoryOf(p, map);
        if (!hit) continue;
        let size = 0;
        try { size = fs.statSync(p).size; } catch {}
        moves.push({
          from: p,
          physical: path.join(part, hit.cat, hit.rest),
          pool: path.join(`${poolLetter}:\\`, hit.cat, hit.rest),
          size
        });
      }
    };
    walk(root.replace(/\\+$/, '') || root);
  }

  const collisions = findCollisions(moves.map((m) => ({ from: m.from, to: m.physical })));
  return { moves, skipped, collisions, bytes: moves.reduce((n, m) => n + m.size, 0) };
}

/** Move the leftovers. Same-volume renames, nothing in the database to update. */
export function runLeftovers(plan, { log = () => {} } = {}) {
  let done = 0, failed = 0;
  for (const m of plan.moves) {
    if (!fs.existsSync(m.from)) { continue; }
    if (fs.existsSync(m.physical)) { failed++; log(`occupied, skipped: ${m.physical}`); continue; }
    try {
      fs.mkdirSync(path.dirname(m.physical), { recursive: true });
      fs.renameSync(m.from, m.physical);
      done++;
    } catch (e) { failed++; log(`failed ${m.from}: ${e.message}`); }
  }
  return { done, failed };
}

export function ensurePoolMoveSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poolpart_moves (
      id        INTEGER PRIMARY KEY,
      file_kind TEXT, file_id INTEGER,
      src       TEXT NOT NULL,
      physical  TEXT NOT NULL,
      pool      TEXT NOT NULL,
      bytes     INTEGER DEFAULT 0,
      state     TEXT NOT NULL DEFAULT 'planned',
      error     TEXT,
      done_at   INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS poolpart_moves_src ON poolpart_moves (src);
    CREATE INDEX IF NOT EXISTS poolpart_moves_state ON poolpart_moves (state);
  `);
}

/**
 * Move one file into its drive's PoolPart folder and repoint the library.
 *
 * The order is the same discipline the cross-drive migration uses, for the same
 * reason: nothing is recorded as done until the file has been seen at its new
 * home. A rename cannot half-succeed, so there is no copy to verify — but the
 * pool is a filesystem filter, and a file that is physically in the PoolPart
 * folder yet NOT visible through P: would leave the library pointing at a path
 * that does not resolve. So that is checked before the row is rewritten.
 */
export async function movePoolOne(db, row, { poolTimeoutMs = 15000 } = {}) {
  const fail = (m) => {
    db.prepare('UPDATE poolpart_moves SET state=?, error=?, done_at=? WHERE id=?').run('failed', m, Date.now(), row.id);
    return { ok: false, error: m };
  };

  if (!fs.existsSync(row.src)) return fail('source is gone');
  if (fs.existsSync(row.physical)) return fail('something is already at the destination');
  if (String(row.src).slice(0, 2).toUpperCase() !== String(row.physical).slice(0, 2).toUpperCase()) {
    return fail('source and destination are on different drives — this step only ever renames');
  }

  const before = fs.statSync(row.src).size;
  try {
    fs.mkdirSync(path.dirname(row.physical), { recursive: true });
    fs.renameSync(row.src, row.physical);
  } catch (e) { return fail('rename failed: ' + e.message); }

  // Wait for the pool to show it. DrivePool picks up changes to a pool part
  // promptly but not synchronously.
  const deadline = Date.now() + poolTimeoutMs;
  let visible = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(row.pool)) { visible = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!visible) {
    // Put it back rather than leave the library unable to reach it.
    try { fs.renameSync(row.physical, row.src); } catch {}
    return fail('moved, but it never appeared through the pool — reverted');
  }
  const after = fs.statSync(row.pool).size;
  if (after !== before) {
    try { fs.renameSync(row.physical, row.src); } catch {}
    return fail(`size through the pool is ${after}, expected ${before} — reverted`);
  }

  db.exec('BEGIN');
  try {
    const table = row.file_kind === 'episode' ? 'episode_files' : 'movie_files';
    db.prepare(`UPDATE ${table} SET path = ?, filename = ? WHERE id = ?`)
      .run(row.pool, path.basename(row.pool), row.file_id);
    db.prepare('UPDATE media_info SET path = ? WHERE file_kind = ? AND file_id = ?')
      .run(row.pool, row.file_kind, row.file_id);
    db.prepare('UPDATE poolpart_moves SET state=?, error=NULL, done_at=? WHERE id=?').run('done', Date.now(), row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    try { fs.renameSync(row.physical, row.src); } catch {}
    return fail('could not update the library: ' + e.message + ' — file moved back');
  }
  return { ok: true, pool: row.pool };
}

/** Journal a plan. Refuses to start over a run that is part-way through. */
export function journalPoolMove(db, plan, { replace = false } = {}) {
  ensurePoolMoveSchema(db);
  const n = db.prepare('SELECT COUNT(*) n FROM poolpart_moves').get().n;
  if (n && !replace) {
    const left = db.prepare("SELECT COUNT(*) n FROM poolpart_moves WHERE state NOT IN ('done')").get().n;
    if (left) throw new Error(`a pool move is already part-way through (${left} of ${n} left)`);
    return { inserted: 0 };
  }
  if (replace) db.exec('DELETE FROM poolpart_moves');
  const ins = db.prepare(`INSERT INTO poolpart_moves (file_kind, file_id, src, physical, pool, bytes, state)
                          VALUES (?,?,?,?,?,?,'planned')`);
  db.exec('BEGIN');
  try {
    for (const m of plan.moves) ins.run(m.kind, m.fileId, m.from, m.physical, m.pool, m.size);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted: plan.moves.length };
}

/** Work the journal. Renames are fast, so this gets through thousands quickly. */
export async function runPoolMove(db, { log = () => {}, shouldStop = () => false, onProgress = () => {} } = {}) {
  ensurePoolMoveSchema(db);
  const stats = { done: 0, failed: 0, bytes: 0, startedAt: Date.now() };
  for (;;) {
    if (shouldStop()) { log('stopping'); break; }
    const row = db.prepare("SELECT * FROM poolpart_moves WHERE state = 'planned' ORDER BY id LIMIT 1").get();
    if (!row) break;
    const r = await movePoolOne(db, row);
    if (r.ok) { stats.done++; stats.bytes += Number(row.bytes) || 0; }
    else { stats.failed++; log(`FAILED ${row.src}: ${r.error}`); }
    onProgress(stats, row, r);
  }
  stats.elapsedMs = Date.now() - stats.startedAt;
  return stats;
}

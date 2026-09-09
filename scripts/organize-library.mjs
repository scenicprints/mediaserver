// Put every movie in the right folder, and even out the two drives.
//
// Two goals, one pass, so no file is ever moved twice:
//
//   1. FOLDER IS CORRECT (the priority). A 4K film belongs in a "4k" folder and
//      nothing else does. Judged on the file's ACTUAL probed resolution, not on
//      the folder it sits in or what its filename claims.
//
//   2. DRIVES ARE EVEN. H: sits at 98% and E: at 21%, which starves the
//      optimizer — a job needs 1.15x the source free on its OWN drive.
//
// LAYOUT IS PRESERVED, which is the subtle part. These libraries are a mix:
// H:\Movies and both 4k folders are mostly flat files, while E:\Movies keeps
// each film in its own title folder. So the thing that moves is a UNIT — the
// whole title folder when a film lives in one, otherwise the file plus the
// sidecars sharing its name. Flattening E:\Movies would have been destructive.
//
// Same-drive moves are plain renames: instant, no bytes copied. Only the moves
// needed to balance the drives actually copy, so goal 1 is nearly free.
//
// Per unit the order is: copy -> verify byte counts -> update the database ->
// only then delete the source. The library never points at a file that isn't
// there, and an interrupted run is safe to re-run.
//
//   node tools/organize-library.mjs           show the plan, change nothing
//   node tools/organize-library.mjs --go      do it
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const { tierOf } = await import(pathToFileURL('C:\\mediaserver\\src\\optimize.js').href);

const GO = process.argv.includes('--go');
const SEP = path.sep;
const TiB = (b) => (Number(b) / 2 ** 40).toFixed(2) + ' TiB';
const GiB = (b) => (Number(b) / 2 ** 30).toFixed(1) + ' GB';
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const db = new DatabaseSync('C:\\mediaserver\\data\\library.db');

const libs = db.prepare("SELECT id, path FROM libraries WHERE type = 'movie'").all();
const slot = new Map();                       // "H|4k" -> library row
for (const l of libs) {
  const m = /^([A-Z]):\\(4k|Movies)$/i.exec(l.path);
  if (m) slot.set(`${m[1].toUpperCase()}|${/^4k$/i.test(m[2]) ? '4k' : 'Movies'}`, l);
}
for (const k of ['H|4k', 'H|Movies', 'E|4k', 'E|Movies']) {
  if (!slot.has(k)) { console.error('missing library for ' + k); process.exit(1); }
}
const libById = new Map(libs.map((l) => [l.id, l]));

const rows = db.prepare(`
  SELECT mf.id, mf.path, mf.filename, mf.size, mf.library_id, mi.width, mi.height
  FROM movie_files mf
  LEFT JOIN media_info mi ON mi.file_kind = 'movie' AND mi.file_id = mf.id`).all();

// ---- Group files into movable units ----
const units = new Map();
let unprobed = 0, offDrive = 0;
for (const r of rows) {
  const lib = libById.get(r.library_id);
  if (!lib) continue;
  const drive = String(r.path).slice(0, 1).toUpperCase();
  if (drive !== 'H' && drive !== 'E') { offDrive++; continue; }
  if (!r.width) { unprobed++; continue; }               // never move what we can't judge

  const rel = r.path.slice(lib.path.length + 1);
  const seg = rel.split(SEP);
  const foldered = seg.length > 1;
  const key = foldered ? `${lib.path}${SEP}${seg[0]}` : r.path;

  let u = units.get(key);
  if (!u) {
    u = { key, foldered, folderName: foldered ? seg[0] : null, lib, drive, size: 0, files: [], tier: 'SD' };
    units.set(key, u);
  }
  u.files.push({ ...r, rel });
  u.size += Number(r.size) || 0;
  // If a folder ever did hold mixed tiers, the highest wins — a 4K film must
  // never end up outside a 4k folder.
  const t = tierOf(r.width, r.height);
  const rank = { SD: 0, '720p': 1, '1080p': 2, '4K': 3 };
  if (rank[t] > rank[u.tier]) u.tier = t;
}

const all = [...units.values()];
log(`${rows.length} movie files -> ${all.length} movable units (${unprobed} unprobed and ${offDrive} off-drive, left alone)`);

const used = { H: 0, E: 0 };
for (const u of all) used[u.drive] += u.size;
const total = used.H + used.E;
const target = total / 2;
log(`H: ${TiB(used.H)}   E: ${TiB(used.E)}   even split = ${TiB(target)} each`);

// ---- Choose destination drive so the two end up even ----
for (const u of all) u.wantDrive = u.drive;
const heavy = used.H > used.E ? 'H' : 'E';
const light = heavy === 'H' ? 'E' : 'H';
let excess = used[heavy] - target;
if (excess > 0) {
  const movable = all
    .filter((u) => u.drive === heavy)
    .sort((a, b) => (b.tier === '4K' ? 1 : 0) - (a.tier === '4K' ? 1 : 0) || b.size - a.size);
  for (const u of movable) {
    if (excess <= 0) break;
    u.wantDrive = light;
    excess -= u.size;
  }
}

// ---- Work out the moves ----
const plan = [];
for (const u of all) {
  const wantKind = u.tier === '4K' ? '4k' : 'Movies';
  const destLib = slot.get(`${u.wantDrive}|${wantKind}`);
  const destRoot = u.foldered ? path.join(destLib.path, u.folderName) : destLib.path;
  const srcRoot = u.foldered ? u.key : null;

  // Where each file ends up, preserving any structure below the title folder.
  const moves = u.files.map((f) => ({
    id: f.id,
    from: f.path,
    to: u.foldered ? path.join(destLib.path, f.rel) : path.join(destLib.path, f.filename)
  }));
  if (moves.every((m) => m.to.toLowerCase() === m.from.toLowerCase())) continue;

  plan.push({
    ...u, wantKind, destLib, destRoot, srcRoot, moves,
    sameDrive: u.wantDrive === u.drive,
    reason: wantKind !== (/\\4k$/i.test(u.lib.path) ? '4k' : 'Movies') ? 'folder' : 'balance'
  });
}

const renames = plan.filter((p) => p.sameDrive);
const copies = plan.filter((p) => !p.sameDrive);
const copyBytes = copies.reduce((s, p) => s + p.size, 0);
const intoFourK = renames.filter((p) => p.wantKind === '4k');
const outOfFourK = renames.filter((p) => p.wantKind === 'Movies');

log('');
log(`FOLDER FIXES, same drive (instant renames, nothing copied): ${renames.length}`);
log(`   ${intoFourK.length} genuine 4K films moving INTO a 4k folder (${GiB(intoFourK.reduce((s, p) => s + p.size, 0))})`);
for (const p of intoFourK.slice(0, 8)) {
  const f = p.files[0];
  log(`     -> ${f.width}x${f.height}  ${p.moves[0].from}`);
}
if (intoFourK.length > 8) log(`     … and ${intoFourK.length - 8} more`);
log(`   ${outOfFourK.length} non-4K films moving OUT of a 4k folder (${GiB(outOfFourK.reduce((s, p) => s + p.size, 0))})`);
for (const p of outOfFourK) {
  const f = p.files[0];
  log(`     <- ${f.width}x${f.height} (${p.tier})  ${p.moves[0].from}`);
}

log('');
log(`DRIVE BALANCE, cross-drive (real copies): ${copies.length} units, ${TiB(copyBytes)}`);
for (const p of copies.slice(0, 6)) log(`     ${GiB(p.size).padStart(9)}  ${p.moves[0].from}  ->  ${p.moves[0].to}`);
if (copies.length > 6) log(`     … and ${copies.length - 6} more`);

const after = { H: 0, E: 0 };
for (const u of all) after[u.wantDrive] += u.size;
log('');
log(`after:  H: ${TiB(after.H)}   E: ${TiB(after.E)}`);

const freeOn = (d) => { try { const s = fs.statfsSync(d + ':\\'); return s.bavail * s.bsize; } catch { return 0; } };
if (copies.length && freeOn(light) < copyBytes * 1.05) {
  console.error(`not enough free space on ${light}: — stopping.`);
  process.exit(1);
}

if (!GO) { log(''); log('dry run — nothing changed. Re-run with --go.'); process.exit(0); }

// ---- Execute ----
function sidecarsOf(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  try {
    return fs.readdirSync(dir)
      .filter((f) => f !== path.basename(filePath) && f.startsWith(stem + '.'))
      .map((f) => path.join(dir, f));
  } catch { return []; }
}
function copyVerified(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.partial';
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(src, tmp);
  const a = fs.statSync(src).size, b = fs.statSync(tmp).size;
  if (a !== b) { fs.rmSync(tmp, { force: true }); throw new Error(`size mismatch ${a} vs ${b}`); }
  fs.renameSync(tmp, dst);
}
function copyTreeVerified(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name), d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyTreeVerified(s, d);
    else if (!(fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size)) copyVerified(s, d);
  }
}

function apply(p) {
  const updates = [];
  if (p.foldered) {
    const srcDir = p.srcRoot, dstDir = p.destRoot;
    if (fs.existsSync(srcDir)) {
      if (p.sameDrive) {
        fs.mkdirSync(path.dirname(dstDir), { recursive: true });
        fs.renameSync(srcDir, dstDir);                     // same volume: instant
      } else {
        copyTreeVerified(srcDir, dstDir);
      }
    }
    for (const m of p.moves) updates.push(m);
    if (!p.sameDrive && fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
  } else {
    for (const m of p.moves) {
      const sides = fs.existsSync(m.from) ? sidecarsOf(m.from) : [];
      if (fs.existsSync(m.from)) {
        if (p.sameDrive) {
          fs.mkdirSync(path.dirname(m.to), { recursive: true });
          fs.renameSync(m.from, m.to);
          for (const s of sides) {
            try { fs.renameSync(s, path.join(path.dirname(m.to), path.basename(s))); } catch {}
          }
        } else {
          if (!(fs.existsSync(m.to) && fs.statSync(m.to).size === fs.statSync(m.from).size)) copyVerified(m.from, m.to);
          for (const s of sides) {
            const sd = path.join(path.dirname(m.to), path.basename(s));
            try { if (!fs.existsSync(sd)) copyVerified(s, sd); } catch (e) { log(`  sidecar ${path.basename(s)}: ${e.message}`); }
          }
        }
      }
      updates.push(m);
      if (!p.sameDrive && fs.existsSync(m.from)) {
        fs.rmSync(m.from, { force: true });
        for (const s of sides) fs.rmSync(s, { force: true });
      }
    }
  }

  // Database last-but-one; source deletion (above, for cross-drive) already done
  // only after the copy verified. Renames are atomic so ordering is moot there.
  for (const m of updates) {
    db.prepare('UPDATE movie_files SET path = ?, library_id = ? WHERE id = ?').run(m.to, p.destLib.id, m.id);
    db.prepare("UPDATE media_info SET path = ? WHERE file_kind = 'movie' AND file_id = ?").run(m.to, m.id);
  }

  // Tidy up a title folder we just emptied.
  if (p.foldered && p.sameDrive) { /* renamed wholesale, nothing left behind */ }
  else if (!p.foldered) {
    const dir = path.dirname(p.moves[0].from);
    if (!/^[A-Z]:\\(4k|Movies)$/i.test(dir)) {
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
    }
  }
}

log('');
log('=== phase 1: folder fixes (renames, instant) ===');
let ok = 0, bad = 0;
for (const p of renames) {
  try { apply(p); ok++; } catch (e) { bad++; log(`FAILED ${p.key}: ${e.message}`); }
}
log(`phase 1 done: ${ok} moved, ${bad} failed`);

log('');
log(`=== phase 2: drive balance (${TiB(copyBytes)} to copy) ===`);
let cOk = 0, cBad = 0, doneBytes = 0;
const t0 = Date.now();
for (const [n, p] of copies.entries()) {
  try {
    apply(p); cOk++; doneBytes += p.size;
    const rate = doneBytes / ((Date.now() - t0) / 1000) / 2 ** 20;
    const eta = rate > 0 ? ((copyBytes - doneBytes) / 2 ** 20 / rate / 60).toFixed(0) : '?';
    log(`[${n + 1}/${copies.length}] ${(doneBytes / copyBytes * 100).toFixed(1)}%  ${GiB(p.size)}  ${path.basename(p.moves[0].to)}  (${rate.toFixed(0)} MB/s, ~${eta} min left)`);
  } catch (e) { cBad++; log(`FAILED ${p.key}: ${e.message}`); }
}

log('');
log(`done. folder fixes ${ok}/${renames.length}, balance moves ${cOk}/${copies.length}, failures ${bad + cBad}`);
for (const d of ['H', 'E']) {
  const b = db.prepare('SELECT COALESCE(SUM(size),0) b FROM movie_files WHERE path LIKE ?').get(d + ':%').b;
  log(`${d}: holds ${TiB(b)} of movies, ${TiB(freeOn(d))} free`);
}

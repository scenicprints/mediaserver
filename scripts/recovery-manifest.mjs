// Inventory everything the recovery produces, sort it into keep / junk / review,
// and (only when asked) delete the junk.
//
// The recovery is dredging up files deleted from H: years ago — TV episodes that
// were moved to F: and G: long since. Those are duplicates of content already in
// the library and are worth nothing. This keeps a record of all of it so the
// scratch drive can be cleaned out afterwards without guessing.
//
// Classification:
//   KEEP   — byte size exactly matches one of the 55 films that were destroyed
//   JUNK   — a file of the same name already exists on E:, F:, G: or H:
//   REVIEW — anything else; never deleted automatically
//
// SAFETY: deletion is opt-in (--delete-junk), and every path is checked to be
// under I:\recovered before it is touched. Nothing outside the recovery output
// folder can be deleted by this script under any circumstance — the library
// drives are not reachable from here even if the classification is wrong.
//
//   node scripts/recovery-manifest.mjs                 inventory only
//   node scripts/recovery-manifest.mjs --delete-junk   remove the duplicates
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const B = String.fromCharCode(92);
const ROOT = 'I:' + B + 'recovered';
const MANIFEST = 'C:' + B + 'mediaserver' + B + 'tools' + B + 'recovery-manifest.txt';
const DELETE = process.argv.includes('--delete-junk');
const GB = (b) => (Number(b) / 2 ** 30).toFixed(2);

if (!fs.existsSync(ROOT)) { console.log('nothing at ' + ROOT); process.exit(0); }

// --- the 55 we actually want back, keyed by exact byte size ---
const db = new DatabaseSync('C:/mediaserver/data/library.db', { readOnly: true });
const wantBySize = new Map();
for (const r of db.prepare(`
  SELECT mf.path, mi.size AS probesize FROM movie_files mf
  JOIN media_info mi ON mi.file_kind='movie' AND mi.file_id = mf.id`).all()) {
  if (!r.path.startsWith('H:' + B + '4k' + B)) continue;
  let st = null;
  try { st = fs.statSync(r.path); } catch { continue; }
  const was = Number(r.probesize) || 0;
  if (was && st.size < was) wantBySize.set(was, r.path.split(B).pop());
}

// --- what already exists in the library, by filename ---
const haveNames = new Set();
(function scan(dir, depth) {
  if (depth > 3) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
    else haveNames.add(e.name.toLowerCase());
  }
})('G:' + B + 'TV Shows', 0);
for (const d of ['F:' + B, 'E:' + B + 'Movies', 'E:' + B + '4k', 'H:' + B + 'Movies', 'H:' + B + '4k']) {
  (function scan(dir, depth) {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
      else haveNames.add(e.name.toLowerCase());
    }
  })(d, 0);
}

// --- inventory the recovery output ---
const files = [];
(function walk(d) {
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { try { files.push({ path: p, name: e.name, size: fs.statSync(p).size }); } catch {} }
  }
})(ROOT);

const keep = [], junk = [], review = [];
for (const f of files) {
  if (wantBySize.has(f.size)) { f.why = 'size matches ' + wantBySize.get(f.size); keep.push(f); }
  else if (haveNames.has(f.name.toLowerCase())) { f.why = 'already in the library'; junk.push(f); }
  else { f.why = 'unrecognised'; review.push(f); }
}

const sum = (a) => a.reduce((s, f) => s + f.size, 0);
const out = [];
out.push(`RECOVERY MANIFEST - ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
out.push(`${files.length} file(s), ${GB(sum(files))} GB in ${ROOT}`);
out.push('');
out.push(`KEEP   ${String(keep.length).padStart(4)} files  ${GB(sum(keep)).padStart(9)} GB  - one of the 55 destroyed films`);
out.push(`JUNK   ${String(junk.length).padStart(4)} files  ${GB(sum(junk)).padStart(9)} GB  - already in the library, safe to delete`);
out.push(`REVIEW ${String(review.length).padStart(4)} files  ${GB(sum(review)).padStart(9)} GB  - unrecognised, never auto-deleted`);
out.push('');
for (const [label, list] of [['KEEP', keep], ['JUNK', junk], ['REVIEW', review]]) {
  out.push(`--- ${label} ---`);
  for (const f of list.sort((a, b) => b.size - a.size)) {
    out.push(`  ${GB(f.size).padStart(8)} GB  ${f.name}${label === 'KEEP' ? '   <- ' + f.why : ''}`);
  }
  out.push('');
}
fs.writeFileSync(MANIFEST, out.join('\r\n'), 'utf8');
console.log(out.slice(0, 8).join('\n'));
console.log(`\nfull manifest written to ${MANIFEST}`);

if (!DELETE) {
  console.log('\n(inventory only - nothing deleted. Add --delete-junk to remove the duplicates.)');
  process.exit(0);
}

// --- deletion, hard-guarded ---
let removed = 0, freed = 0;
for (const f of junk) {
  const p = path.resolve(f.path);
  // The guard that matters: only ever inside the recovery output folder.
  if (!p.toLowerCase().startsWith(path.resolve(ROOT).toLowerCase() + B)) {
    console.error('REFUSING - outside the recovery folder: ' + p);
    continue;
  }
  if (wantBySize.has(f.size)) { console.error('REFUSING - size matches a wanted film: ' + p); continue; }
  try { fs.rmSync(p, { force: true }); removed++; freed += f.size; }
  catch (e) { console.error('failed to delete ' + p + ': ' + e.message); }
}
console.log(`\ndeleted ${removed} duplicate file(s), freed ${GB(freed)} GB`);
console.log(`kept ${keep.length} wanted file(s) and ${review.length} for review - untouched`);

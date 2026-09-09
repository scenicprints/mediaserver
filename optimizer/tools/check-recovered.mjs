// Work out what actually came back from the recovery, and whether it is usable.
//
// Recovered files often arrive with mangled names, wrong names, or no name at
// all — so identification is done by EXACT BYTE SIZE against the sizes recorded
// for each film when the library was probed. Those sizes are unique enough here
// to be a reliable fingerprint (the smallest gap between any two is far larger
// than any plausible collision).
//
// Then each candidate is opened with ffprobe and must prove it is a real video:
// right duration, right resolution, decodable. A recovery tool will happily hand
// back a 40 GB file that is half garbage, and that must never be put back into
// the library as if it were the original.
//
// Reads I: and the database. Writes nothing, moves nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const RECOVERED = 'I:\\recovered';
const BIN = 'C:\\mediaserver\\tools\\ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1\\bin\\ffprobe.exe';
const B = String.fromCharCode(92);
const GB = (b) => (Number(b) / 2 ** 30).toFixed(2);

const db = new DatabaseSync('C:/mediaserver/data/library.db', { readOnly: true });

// The 55 originals: what each one was before it was overwritten.
const wanted = [];
for (const r of db.prepare(`
  SELECT mf.path, mi.size AS probesize, mi.duration, mi.width, mi.height, mi.vcodec, m.title
  FROM movie_files mf
  JOIN media_info mi ON mi.file_kind='movie' AND mi.file_id = mf.id
  LEFT JOIN movies m ON m.id = mf.movie_id`).all()) {
  if (!r.path.startsWith('H:' + B + '4k' + B)) continue;
  let st = null;
  try { st = fs.statSync(r.path); } catch { continue; }
  const was = Number(r.probesize) || 0;
  if (was && st.size < was) {
    wanted.push({
      name: r.path.split(B).pop(), title: r.title, size: was,
      duration: Number(r.duration) || 0, width: r.width, height: r.height, vcodec: r.vcodec,
      dest: r.path
    });
  }
}
console.log(`looking for ${wanted.length} originals, ${(wanted.reduce((s, x) => s + x.size, 0) / 2 ** 40).toFixed(2)} TiB\n`);

if (!fs.existsSync(RECOVERED)) { console.log('nothing at ' + RECOVERED + ' yet.'); process.exit(0); }

const found = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else found.push({ path: p, size: fs.statSync(p).size });
  }
})(RECOVERED);
console.log(`recovery produced ${found.length} file(s), ${(found.reduce((s, f) => s + f.size, 0) / 2 ** 40).toFixed(2)} TiB\n`);

const bySize = new Map();
for (const f of found) {
  if (!bySize.has(f.size)) bySize.set(f.size, []);
  bySize.get(f.size).push(f);
}

function inspect(file) {
  try {
    const out = execFileSync(BIN, ['-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', file],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 8 << 20, timeout: 120000 });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return { ok: !!v, duration: +(j.format && j.format.duration) || 0, width: v && v.width, height: v && v.height, vcodec: v && v.codec_name };
  } catch (e) { return { ok: false, error: String(e.message).split('\n')[0].slice(0, 90) }; }
}

// Does the tail of the file decode? A truncated recovery probes fine at the
// start and falls apart at the end, which is exactly the failure that would
// otherwise get promoted back into the library.
function tailDecodes(file, duration) {
  if (!(duration > 90)) return true;
  try {
    execFileSync(BIN.replace('ffprobe.exe', 'ffmpeg.exe'),
      ['-hide_banner', '-nostdin', '-xerror', '-v', 'error', '-ss', String(Math.floor(duration - 45)),
        '-i', file, '-t', '20', '-map', '0:v:0?', '-f', 'null', '-'],
      { windowsHide: true, timeout: 300000 });
    return true;
  } catch { return false; }
}

const good = [], bad = [], unmatched = [];
for (const w of wanted) {
  const cands = bySize.get(w.size);
  if (!cands || !cands.length) { unmatched.push(w); continue; }
  const c = cands.shift();
  const info = inspect(c.path);
  const durOk = !w.duration || !info.duration || Math.abs(info.duration - w.duration) < Math.max(2, w.duration * 0.01);
  const resOk = !w.width || info.width === w.width;
  if (!info.ok) { bad.push({ w, c, why: 'not a readable video: ' + (info.error || '') }); continue; }
  if (!durOk) { bad.push({ w, c, why: `duration ${Math.round(info.duration)}s vs expected ${Math.round(w.duration)}s` }); continue; }
  if (!resOk) { bad.push({ w, c, why: `resolution ${info.width}x${info.height} vs expected ${w.width}x${w.height}` }); continue; }
  if (!tailDecodes(c.path, info.duration)) { bad.push({ w, c, why: 'the end of the file will not decode - truncated' }); continue; }
  good.push({ w, c });
}

console.log('=== VERIFIED GOOD (safe to put back) ===');
for (const g of good) console.log(`  ${GB(g.w.size).padStart(7)} GB  ${g.w.name}`);
console.log(`  ${good.length} file(s)\n`);

console.log('=== RECOVERED BUT DAMAGED (do not use) ===');
for (const b of bad) console.log(`  ${GB(b.w.size).padStart(7)} GB  ${b.w.name}\n              ${b.why}`);
console.log(`  ${bad.length} file(s)\n`);

console.log('=== NOT RECOVERED (re-download these) ===');
for (const u of unmatched) console.log(`  ${GB(u.size).padStart(7)} GB  ${u.name}`);
console.log(`  ${unmatched.length} file(s)`);

const leftover = [...bySize.values()].flat();
if (leftover.length) {
  console.log(`\n(${leftover.length} recovered file(s) matched nothing we were looking for - other deleted videos, ignore)`);
}

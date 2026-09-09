// Add a compatible E-AC-3 5.1 track to films that have none, so the Apple TV
// gets real surround instead of a server-side stereo downmix.
//
// The video stream is copied, never re-encoded, and every job proves it by
// comparing the video bitstream hash before and after. A single differing bit
// rejects the result and keeps the original. That is what protects HDR.
//
//   node scripts/add-surround-track.mjs                list what needs it
//   node scripts/add-surround-track.mjs --test         do ONE, on a copy, keep both
//   node scripts/add-surround-track.mjs --go [N]       do N for real (default 1)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const imp = (f) => import(pathToFileURL(path.join('C:\\mediaserver\\optimizer', f)).href);
const { detect: detectFfmpeg } = await imp('ffmpeg.mjs');
const opt = await imp('engine.mjs');

const B = String.fromCharCode(92);
const TEST = process.argv.includes('--test');
const GO = process.argv.includes('--go');
const LIMIT = Number(process.argv[process.argv.indexOf('--go') + 1]) || 1;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const cfg = JSON.parse(fs.readFileSync('C:\\mediaserver\\config.json', 'utf8').replace(/^\uFEFF/, ''));
const ff = await detectFfmpeg('C:\\mediaserver', cfg);
if (!ff.available) { console.error('ffmpeg unavailable'); process.exit(1); }

const db = new DatabaseSync('C:\\mediaserver\\data\\library.db');
opt.ensureSchema(db);

const rows = db.prepare(`
  SELECT mi.*, COALESCE(m.title, s.title) AS title
  FROM media_info mi
  LEFT JOIN movie_files   mf ON mi.file_kind='movie'   AND mf.id = mi.file_id
  LEFT JOIN movies        m  ON m.id  = mf.movie_id
  LEFT JOIN episode_files ef ON mi.file_kind='episode' AND ef.id = mi.file_id
  LEFT JOIN episodes      e  ON e.id  = ef.episode_id
  LEFT JOIN shows         s  ON s.id  = e.show_id
  WHERE mi.probe_error IS NULL AND (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all();

const need = [];
for (const r of rows) {
  if (!fs.existsSync(r.path)) continue;
  const p = opt.planAddAudio(r);
  if (p.need) need.push({ r, p, hdr: opt.isProtected(r) });
}
need.sort((a, b) => (b.hdr ? 1 : 0) - (a.hdr ? 1 : 0) || Number(b.r.size) - Number(a.r.size));

const GB = (b) => (Number(b) / 2 ** 30).toFixed(1);
log(`${need.length} file(s) have no surround track the TVs can play natively`);
log(`  of those, ${need.filter((x) => x.hdr).length} are 4K HDR — the ones that matter for the projector`);
log('');
for (const x of need.slice(0, 20)) {
  log(`  ${GB(x.r.size).padStart(7)} GB  ${x.hdr ? '4K HDR' : '      '}  ${x.r.title || path.basename(x.r.path)}`);
  log(`               ${x.p.reason}`);
}
if (need.length > 20) log(`  … and ${need.length - 20} more`);

if (!TEST && !GO) { log(''); log('nothing done. --test to try one on a copy, --go to apply.'); process.exit(0); }

if (TEST) {
  const x = need[0];
  if (!x) { log('nothing to test'); process.exit(0); }
  log('');
  log(`TEST on ${path.basename(x.r.path)} — original is NOT replaced`);
  const res = await opt.addCompatibleAudio(db, x.r.file_kind, x.r.file_id, { log: (m) => log(m), dryRun: true });
  log('');
  log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

let done = 0, failed = 0;
for (const x of need.slice(0, LIMIT)) {
  const res = await opt.addCompatibleAudio(db, x.r.file_kind, x.r.file_id, { log: (m) => log(m) });
  if (res.ok) done++; else { failed++; log(`  FAILED: ${res.error}`); }
}
log('');
log(`added to ${done} file(s), ${failed} failed`);

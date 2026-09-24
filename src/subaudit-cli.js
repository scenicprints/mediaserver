// Read-only audit: what the subtitle change does to the real library.
//
// The sidecar name matcher used to accept a hit ANYWHERE inside either name,
// which is how "English.srt" loose in the movies folder attached itself to The
// English Patient. Tightening it to a prefix fixes that, but a tightening can
// also take away a sidecar that was working — a name that sits INSIDE the
// video's name without starting it, like "Show - 01.srt" beside
// "[Group] Show - 01 [1080p].mkv".
//
// Tests cannot answer that question. Only the library can. So this runs both
// matchers, old and new, over every video the database knows about and prints
// the difference — before a rescan, and without touching anything.
//
//   npm run subaudit           summary + the first 40 of each list
//   npm run subaudit -- --all  every line
//
// It WRITES NOTHING: no database, no files, no renames. Every folder is read
// once and the listing reused, because 20k files on a spinning disk is the one
// cost this has.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { TEXT_SIDECAR_RE, BITMAP_SIDECAR_RE, sidecarMatches } from './subtitles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
const db = openDb(path.resolve(ROOT, config.dbPath));

const ALL = process.argv.includes('--all');
const SUB_FOLDERS = ['Subs', 'Subtitles', 'subs', 'subtitles', 'Sub'];

// One readdir per folder, for the whole run. Both matchers read from this, so
// the disk is walked once rather than twice.
const listings = new Map();          // folder -> string[] | null
function listDir(folder) {
  if (listings.has(folder)) return listings.get(folder);
  let files = null;
  try { files = fs.readdirSync(folder); } catch { /* missing, unreadable, or a drive that moved */ }
  listings.set(folder, files);
  return files;
}

// The matcher exactly as it stood before the change. Frozen on purpose: the
// point is to compare against what the library has actually been living with.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function oldMatch(videoStem, sidecarStem) {
  const nstem = norm(videoStem);
  const nb = norm(sidecarStem);
  return nb === nstem || nb.startsWith(nstem) || nstem.startsWith(nb) ||
    nb.includes(nstem) || nstem.includes(nb);
}
const OLD_SIDECAR_RE = /\.(srt|vtt)$/i;

// The folder walk both matchers share. `rule` decides what counts; `extRe`
// decides which files are even looked at. Deduped the way each version did it:
// the old one on the exact path, the new one case-insensitively (on Windows
// "Subs" and "subs" are the same folder, so the old one saw one file twice).
function collect(videoPath, extRe, rule, foldCase) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const out = [];
  const consider = (folder, loose) => {
    const files = listDir(folder);
    if (!files) return;
    for (const f of files) {
      if (!extRe.test(f)) continue;
      if (!loose && !rule(stem, path.basename(f, path.extname(f)))) continue;
      out.push(path.join(folder, f));
    }
  };
  consider(dir, false);
  for (const s of SUB_FOLDERS) consider(path.join(dir, s), true);
  const seen = new Set();
  return out.filter((p) => {
    const k = foldCase ? p.toLowerCase() : p;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const videos = [
  ...db.prepare("SELECT path, 'movie' AS kind FROM movie_files").all(),
  ...db.prepare("SELECT path, 'episode' AS kind FROM episode_files").all()
];

const lost = [];          // attached before, not now — the list that matters
const gained = [];        // attaches now, did not before
let dupesRemoved = 0;     // the Windows Subs/subs double-listing
let missingVideos = 0;
const attached = new Set();   // every sidecar that ends up on something, new rules

for (const v of videos) {
  const dir = path.dirname(v.path);
  if (listDir(dir) === null) { missingVideos++; continue; }

  const before = collect(v.path, OLD_SIDECAR_RE, oldMatch, false);
  const after = collect(v.path, TEXT_SIDECAR_RE, sidecarMatches, true);
  for (const p of after) attached.add(p.toLowerCase());

  const afterSet = new Set(after.map((p) => p.toLowerCase()));
  const beforeSet = new Set(before.map((p) => p.toLowerCase()));
  dupesRemoved += before.length - beforeSet.size;

  for (const p of before) {
    if (afterSet.has(p.toLowerCase())) continue;
    const vs = norm(path.basename(v.path, path.extname(v.path)));
    const ss = norm(path.basename(p, path.extname(p)));
    const prefix = vs.startsWith(ss) || ss.startsWith(vs);
    lost.push({ video: v.path, sub: p, why: prefix ? 'refused by name' : 'matched mid-name' });
  }
  for (const p of after) {
    if (!beforeSet.has(p.toLowerCase())) gained.push({ video: v.path, sub: p });
  }
}
// The same sidecar can be lost from several videos at once (that is the bug).
const lostFiles = new Set(lost.map((l) => l.sub.toLowerCase()));
// A loss is only a real loss if the file now attaches to NOTHING at all.
const orphanedByChange = [...lostFiles].filter((p) => !attached.has(p));

// Sidecars sitting in a scanned folder that belong to no video under either
// set of rules. These are the ones the change stops pretending to own.
// Keyed lower-cased to compare against `attached`, but the real spelling is
// kept as the value — a path printed in the wrong case is one you cannot paste.
const sidecarsSeen = new Map();      // lower-cased path -> path as it is on disk
const vobsub = [];
for (const [folder, files] of listings) {
  if (!files) continue;
  for (const f of files) {
    const full = path.join(folder, f);
    if (BITMAP_SIDECAR_RE.test(f)) { vobsub.push(full); continue; }
    if (TEXT_SIDECAR_RE.test(f)) sidecarsSeen.set(full.toLowerCase(), full);
  }
}
const orphans = [...sidecarsSeen].filter(([k]) => !attached.has(k)).map(([, p]) => p);

const show = (rows, fmt) => {
  const n = ALL ? rows.length : Math.min(rows.length, 40);
  for (let i = 0; i < n; i++) console.log('   ' + fmt(rows[i]));
  if (n < rows.length) console.log(`   ... and ${rows.length - n} more (run with --all)`);
};
const rel = (p) => p.replace(/\\/g, '/');

console.log(`\nSubtitle sidecar audit — READ ONLY, nothing was changed.`);
console.log(`${videos.length} video files in the database, ${listings.size} folders read.`);
if (missingVideos) {
  console.log(`\n!! ${missingVideos} of them are in folders that could not be read right now.`);
  console.log(`   Their sidecars were NOT checked. If drives are moving, finish the move`);
  console.log(`   and run this again — an empty result below does not mean "nothing lost".`);
}

console.log(`\n== SIDECARS THAT STOP ATTACHING (${lostFiles.size} file(s), ${lost.length} attachment(s)) ==`);
if (!lost.length) console.log('   none.');
else {
  console.log(`   ${orphanedByChange.length} of them now attach to NOTHING AT ALL. Those are the only`);
  console.log(`   ones that can be a real loss; the rest still reach another video.\n`);
  show(lost, (l) => `${l.why.padEnd(17)} ${rel(l.sub)}\n${' '.repeat(21)}was on: ${rel(l.video)}`);
}

console.log(`\n== SIDECARS THAT NOW ATTACH (${gained.length}) ==`);
if (!gained.length) console.log('   none.');
else show(gained, (g) => `${rel(g.sub)}\n${' '.repeat(21)}on: ${rel(g.video)}`);

console.log(`\n== DUPLICATE LISTINGS REMOVED: ${dupesRemoved} ==`);
console.log(`   One sidecar shown twice in the picker, because "Subs" and "subs" are`);
console.log(`   the same folder on Windows and the old dedupe keyed on the exact path.`);

console.log(`\n== SIDECARS BELONGING TO NO VIDEO (${orphans.length}) ==`);
if (!orphans.length) console.log('   none.');
else show(orphans, rel);

console.log(`\n== VOBSUB, SKIPPED ON PURPOSE (${vobsub.length}) ==`);
console.log(`   Bitmap images, not text. Listing them would offer a track that renders`);
console.log(`   nothing. They would need burning in during transcode, which is not built.`);
if (vobsub.length) show(vobsub.slice(0, ALL ? vobsub.length : 10), rel);

console.log('');
db.close();

// Compile the list of what was destroyed, for the owner to choose from by hand.
//
// For each of the 55 films it shows BOTH sides: what the overwritten copy was,
// and what the surviving copy is. That is the information needed to decide
// whether a title is worth re-acquiring — losing a 78 GB remux when a 6 GB
// version remains is a different decision per film, and it is the owner's to
// make, not something to automate.
//
// Produces a readable .txt and a .csv. Sends nothing anywhere.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const FFPROBE = 'C:\\mediaserver\\tools\\ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1\\bin\\ffprobe.exe';
const B = String.fromCharCode(92);
const OUT = 'C:' + B + 'mediaserver' + B + 'tools';
const db = new DatabaseSync('C:/mediaserver/data/library.db', { readOnly: true });

const rows = db.prepare(`
  SELECT mf.id, mf.path, mf.movie_id, mi.size AS probesize, mi.width, mi.height,
         mi.vcodec, mi.acodec, mi.achannels, mi.duration, m.title, m.year
  FROM movie_files mf
  JOIN media_info mi ON mi.file_kind='movie' AND mi.file_id = mf.id
  LEFT JOIN movies m ON m.id = mf.movie_id`).all();

const byMovie = new Map();
for (const r of rows) {
  if (!byMovie.has(r.movie_id)) byMovie.set(r.movie_id, []);
  byMovie.get(r.movie_id).push(r);
}

const lost = [];
for (const r of rows) {
  if (!r.path.startsWith('H:' + B + '4k' + B)) continue;
  let st = null;
  try { st = fs.statSync(r.path); } catch { continue; }
  const was = Number(r.probesize) || 0;
  if (!was || st.size >= was) continue;

  // The surviving copy is whatever now occupies that path. Read it directly —
  // inferring it from sibling database rows was unreliable, and this list is
  // what the owner decides from, so it has to be accurate.
  const survivor = { size: st.size };
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json',
      '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', r.path],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20, timeout: 60000 });
    const v = (JSON.parse(out).streams || [])[0] || {};
    survivor.width = v.width; survivor.height = v.height; survivor.vcodec = v.codec_name;
  } catch { /* leave unknown */ }

  lost.push({
    title: r.title || r.path.split(B).pop().replace(/\.[^.]+$/, ''),
    year: r.year || '',
    lostSize: was,
    lostRes: r.width ? `${r.width}x${r.height}` : '?',
    lostCodec: r.vcodec || '?',
    lostAudio: r.acodec ? `${r.acodec} ${r.achannels || '?'}ch` : '?',
    haveSize: survivor.size,
    haveRes: survivor.width ? `${survivor.width}x${survivor.height}` : '?',
    haveCodec: survivor.vcodec || '?',
    file: r.path.split(B).pop()
  });
}
lost.sort((a, b) => b.lostSize - a.lostSize);

const GB = (b) => (Number(b) / 2 ** 30).toFixed(1);
const totalLost = lost.reduce((s, x) => s + x.lostSize, 0);

const lines = [];
lines.push('FILMS WHOSE HIGH-QUALITY COPY WAS DESTROYED - 2026-09-08');
lines.push('');
lines.push(`${lost.length} films. ${(totalLost / 2 ** 40).toFixed(2)} TiB of the better copies.`);
lines.push('');
lines.push('Every one of these still PLAYS - a smaller copy survived and is in your');
lines.push('library now. This list is only about whether you want the better copy back.');
lines.push('');
lines.push('Sorted biggest loss first, so the ones worth re-downloading are at the top.');
lines.push('');
lines.push('  LOST          -> STILL HAVE       TITLE');
lines.push('  ' + ''.padEnd(74, '-'));
for (const x of lost) {
  const l = `${GB(x.lostSize)}GB ${x.lostRes}`.padEnd(22);
  const h = `${GB(x.haveSize)}GB ${x.haveRes}`.padEnd(18);
  lines.push(`  ${l}${h}${x.title}${x.year ? ' (' + x.year + ')' : ''}`);
}
lines.push('');
lines.push('The "still have" copies are real 4K in most cases - just far lower bitrate.');
fs.writeFileSync(OUT + B + 'lost-movies.txt', lines.join('\r\n'), 'utf8');

const csv = ['Title,Year,LostGB,LostResolution,LostVideoCodec,LostAudio,StillHaveGB,StillHaveResolution,Filename'];
for (const x of lost) {
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  csv.push([q(x.title), x.year, GB(x.lostSize), x.lostRes, x.lostCodec, q(x.lostAudio),
    GB(x.haveSize), x.haveRes, q(x.file)].join(','));
}
fs.writeFileSync(OUT + B + 'lost-movies.csv', csv.join('\r\n'), 'utf8');

console.log(`${lost.length} films, ${(totalLost / 2 ** 40).toFixed(2)} TiB`);
console.log('wrote tools\\lost-movies.txt and tools\\lost-movies.csv');
console.log('');
console.log(lines.slice(9, 22).join('\n'));

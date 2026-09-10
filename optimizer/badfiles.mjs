// The re-download list.
//
// A file the optimizer cannot read is not a problem it can solve — it is a
// problem only a fresh copy solves. So rather than leaving those buried in a
// database column, it keeps a standing list, written as titles and episode
// numbers rather than paths, because what you do with this list is go and find
// the thing again.
//
// Rewritten in full on every scan rather than appended to, so a file that has
// since been replaced drops off it on its own instead of nagging for ever.
import fs from 'node:fs';
import path from 'node:path';

// Human-readable identity for a broken file: what you would type into a search
// box. Falls back to the filename when the library has no idea what it is,
// which is itself informative — an unmatched file is usually junk.
function describe(r) {
  if (r.kind === 'episode') {
    const s = r.season != null ? String(r.season).padStart(2, '0') : '??';
    const e = r.episode != null ? String(r.episode).padStart(2, '0') : '??';
    const t = r.ep_title ? ` - ${r.ep_title}` : '';
    return `${r.show || 'Unknown show'} - S${s}E${e}${t}`;
  }
  return `${r.title || path.basename(r.path)}${r.year ? ` (${r.year})` : ''}`;
}

// Why it is on the list, in words rather than ffmpeg's.
function why(r, size) {
  if (size === 0) return 'empty file — the download never wrote any data';
  if (/invalid data/i.test(r.probe_error || '')) return 'damaged or incomplete';
  if (/no such file|not found/i.test(r.probe_error || '')) return 'missing from disk';
  if (/probe failed/i.test(r.probe_error || '')) return 'not readable (its drive may be disconnected)';
  return (r.probe_error || 'unreadable').split('\n')[0].slice(0, 120);
}

export function badFiles(db) {
  const rows = db.prepare(`
    SELECT mi.path, mi.probe_error, mi.size, mi.file_kind AS kind,
           m.title AS title, m.year AS year,
           s.title AS show, e.season AS season, e.episode AS episode, e.title AS ep_title
    FROM media_info mi
    LEFT JOIN movie_files   mf ON mi.file_kind='movie'   AND mf.id = mi.file_id
    LEFT JOIN movies        m  ON m.id  = mf.movie_id
    LEFT JOIN episode_files ef ON mi.file_kind='episode' AND ef.id = mi.file_id
    LEFT JOIN episodes      e  ON e.id  = ef.episode_id
    LEFT JOIN shows         s  ON s.id  = e.show_id
    WHERE mi.probe_error IS NOT NULL
    ORDER BY COALESCE(s.title, m.title, mi.path), e.season, e.episode`).all();

  return rows.map((r) => {
    let size = Number(r.size) || 0;
    try { size = fs.statSync(r.path).size; } catch { /* keep the recorded size */ }
    return {
      what: describe(r),
      why: why(r, size),
      path: r.path,
      sizeMB: Math.round(size / 1024 / 1024),
      kind: r.kind
    };
  });
}

// Write it where a person can find it. Plain text on purpose: this gets read on
// a phone, pasted into a search, printed if you like. Nothing about it should
// require this program to open it.
export function writeBadFileList(db, file) {
  const items = badFiles(db);
  const empties = items.filter((i) => i.sizeMB === 0);
  const out = [];
  out.push('FILES THAT NEED RE-DOWNLOADING');
  out.push(new Date().toISOString().replace('T', ' ').slice(0, 19));
  out.push('');
  out.push(`${items.length} file(s) the optimizer cannot read.`);
  if (empties.length) {
    out.push(`${empties.length} of them are 0 bytes — the download created the name and never wrote the data.`);
  }
  out.push('');
  out.push('This list is rewritten on every scan, so anything you replace drops off it.');
  out.push('');

  let lastGroup = null;
  for (const i of items) {
    // Group by show so a whole broken season reads as one job, not twelve.
    const group = i.what.includes(' - S') ? i.what.slice(0, i.what.indexOf(' - S')) : '(films)';
    if (group !== lastGroup) { out.push(''); out.push(group.toUpperCase()); lastGroup = group; }
    out.push(`  ${i.what}`);
    out.push(`      ${i.why}${i.sizeMB ? ` · ${i.sizeMB} MB on disk` : ''}`);
    out.push(`      ${i.path}`);
  }
  out.push('');

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.join('\r\n'), 'utf8');
  } catch { /* the list is a convenience; never let it stop the scan */ }
  return items;
}

// What can actually be reclaimed, split by how much quality it costs.
//
// Three tiers, because "smaller without losing quality" means different things
// and the difference matters:
//
//   TIER 1  TRULY LOSSLESS. Files carrying the SAME mix twice — a TrueHD 7.1 and
//           a DTS-HD 7.1 of identical channel count and language. Keeping the
//           better one and dropping the duplicate loses nothing you can hear,
//           because the surviving track is bit-identical to what it was. Pure
//           stream copy: no decoding, no encoding, minutes per file.
//
//   TIER 2  VIDEO UNTOUCHED, AUDIO RE-ENCODED. Lossless audio -> E-AC-3 640k.
//           The picture is copied bit-for-bit; only the audio is compressed.
//           Transparent on a TV, and it is what fixes streaming compatibility,
//           but it is NOT mathematically lossless and should not be sold as such.
//
//   TIER 3  VIDEO RE-ENCODED. Real quality loss. Listed for completeness only.
//
// 4K HDR is excluded from every tier by the hard rule and never appears here.
//
// Read-only. Measures; changes nothing.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const { tierOf, isProtected } = await import(pathToFileURL('C:\\mediaserver\\src\\optimize.js').href);
const B = String.fromCharCode(92);
const OUT = 'C:' + B + 'mediaserver' + B + 'tools' + B + 'shrink-options.txt';

const LOSSLESS = new Set(['truehd', 'mlp', 'dts', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray', 'pcm_dvd']);
const STREAMABLE = new Set(['aac', 'ac3', 'eac3']);   // no server audio work needed
const EAC3_KBPS = 640;

// A lossless track's real cost. Per-track bitrate is usually absent in MKV, so
// these are deliberately conservative estimates — better to under-promise.
const estKbps = (a) => a.kbps || (
  a.codec === 'truehd' || a.codec === 'mlp' ? 4500 :
  a.codec === 'dts' ? 1500 :
  String(a.codec).startsWith('pcm') ? (a.ch || 2) * 1152 :
  a.codec === 'flac' ? 900 : 700);

const db = new DatabaseSync('C:/mediaserver/data/library.db', { readOnly: true });
const rows = db.prepare(`
  SELECT mi.*, COALESCE(m.title, s.title) AS title, e.season, e.episode
  FROM media_info mi
  LEFT JOIN movie_files   mf ON mi.file_kind='movie'   AND mf.id = mi.file_id
  LEFT JOIN movies        m  ON m.id  = mf.movie_id
  LEFT JOIN episode_files ef ON mi.file_kind='episode' AND ef.id = mi.file_id
  LEFT JOIN episodes      e  ON e.id  = ef.episode_id
  LEFT JOIN shows         s  ON s.id  = e.show_id
  WHERE mi.probe_error IS NULL AND (mf.id IS NOT NULL OR ef.id IS NOT NULL)`).all();

const t1 = [], t2 = [], excluded = [];
let considered = 0;

for (const r of rows) {
  if (isProtected(r)) { excluded.push(r); continue; }
  const dur = Number(r.duration) || 0;
  if (!dur) continue;
  considered++;

  let audio = [];
  try { audio = JSON.parse(r.audio_json || '[]'); } catch {}
  const lossless = audio.filter((a) => LOSSLESS.has(String(a.codec).toLowerCase()));
  if (!lossless.length) continue;

  const title = (r.title || r.path.split(B).pop()) + (r.season != null ? ` S${r.season}E${r.episode}` : '');
  const base = { path: r.path, title, size: Number(r.size) || 0, tier: tierOf(r.width, r.height), dur };

  // --- Tier 1: the same mix stored more than once ---
  // Group by language + channel count. More than one lossless track in a group
  // means the file is carrying the identical mix twice over.
  const groups = new Map();
  for (const a of lossless) {
    const k = `${a.lang || 'und'}|${a.ch || 0}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  let dupKbps = 0;
  const dropped = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // keep the largest (best) one, drop the rest — what remains is untouched
    g.sort((x, y) => estKbps(y) - estKbps(x));
    for (const a of g.slice(1)) { dupKbps += estKbps(a); dropped.push(`${a.codec}/${a.ch}ch`); }
  }
  if (dupKbps > 0) {
    const save = dupKbps * 1000 / 8 * dur;
    if (save > 100 * 2 ** 20) t1.push({ ...base, save, detail: 'duplicate ' + dropped.join(' + ') });
  }

  // --- Tier 2: convert what is left ---
  const keptLossless = [];
  for (const g of groups.values()) { g.sort((x, y) => estKbps(y) - estKbps(x)); keptLossless.push(g[0]); }
  const convKbps = keptLossless.reduce((s, a) => s + Math.max(0, estKbps(a) - ((a.ch || 2) > 2 ? EAC3_KBPS : 320)), 0);
  if (convKbps > 0) {
    const save = convKbps * 1000 / 8 * dur;
    const fixesStreaming = !audio.some((a) => STREAMABLE.has(String(a.codec).toLowerCase()));
    if (save > 150 * 2 ** 20) {
      t2.push({ ...base, save, fixesStreaming, detail: keptLossless.map((a) => `${a.codec}/${a.ch}ch`).join(' + ') + ' -> E-AC-3' });
    }
  }
}

const TB = (b) => (b / 2 ** 40).toFixed(2) + ' TiB';
const GB = (b) => (b / 2 ** 30).toFixed(1);
const sum = (a) => a.reduce((s, x) => s + x.save, 0);
const streamFixes = t2.filter((x) => x.fixesStreaming);

const out = [];
out.push('WHAT CAN BE RECLAIMED, AND WHAT EACH TIER COSTS YOU');
out.push('');
out.push(`${considered.toLocaleString()} files considered.`);
out.push(`${excluded.length.toLocaleString()} 4K HDR files EXCLUDED BY RULE — not in any tier below.`);
out.push('');
out.push('TIER 1 — TRULY LOSSLESS (the same mix stored twice; drop the duplicate)');
out.push(`  ${t1.length} files, reclaims ${TB(sum(t1))}`);
out.push('  Pure stream copy. Nothing is decoded or re-encoded. The track that');
out.push('  remains is bit-identical. This is the only tier that genuinely costs');
out.push('  you nothing at all.');
out.push('');
out.push('TIER 2 — VIDEO UNTOUCHED, AUDIO COMPRESSED (lossless -> E-AC-3 640k)');
out.push(`  ${t2.length} files, reclaims ${TB(sum(t2))}`);
out.push(`  ${streamFixes.length} of these ALSO fix streaming — they currently have no`);
out.push('  device-friendly audio track at all, so anything that cannot decode');
out.push('  TrueHD or DTS forces the server to re-encode on the fly.');
out.push('  The picture is copied bit-for-bit. The audio is genuinely compressed:');
out.push('  transparent on a TV, but not mathematically lossless.');
out.push('');
out.push('TIER 3 — VIDEO RE-ENCODED');
out.push('  Not listed. Real quality loss, and not what you asked for.');
out.push('');
out.push('--- TIER 1, biggest first ---');
for (const x of t1.sort((a, b) => b.save - a.save).slice(0, 30)) {
  out.push(`  ${GB(x.save).padStart(7)} GB  ${x.tier.padEnd(6)} ${x.title}`);
  out.push(`               ${x.detail}`);
}
out.push('');
out.push('--- TIER 2, biggest first ---');
for (const x of t2.sort((a, b) => b.save - a.save).slice(0, 30)) {
  out.push(`  ${GB(x.save).padStart(7)} GB  ${x.tier.padEnd(6)} ${x.title}${x.fixesStreaming ? '   [also fixes streaming]' : ''}`);
  out.push(`               ${x.detail}`);
}
fs.writeFileSync(OUT, out.join('\r\n'), 'utf8');
console.log(out.slice(0, 24).join('\n'));
console.log(`\nfull report: ${OUT}`);

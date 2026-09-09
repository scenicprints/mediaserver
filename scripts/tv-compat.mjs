// What in this library forces the server to transcode for the TV apps?
//
// Direct play means the TV decodes the file as-is and the server just sends
// bytes. It breaks for two reasons, and only two that matter here:
//
//   VIDEO  — the TV has no hardware decoder for the codec. H.264 and HEVC are
//            safe on both Apple TV and Android TV. AV1, VC-1, MPEG-2 and the old
//            MPEG-4 ASP (DivX/Xvid) are not.
//
//   AUDIO  — the file has no track the TV can decode. AAC, AC-3 and E-AC-3 are
//            safe everywhere. TrueHD and DTS are not: Apple TV cannot handle
//            them at all, so the server has to decode and re-encode the audio,
//            and that alone turns a direct play into a transcode.
//
// The audio case is the important one, because it is fixable WITHOUT touching a
// single frame of video: add one compatible track alongside the existing ones.
// Nothing is removed, nothing is re-encoded, the picture is untouched.
//
// 4K HDR files are excluded from all of this by the hard rule and are only
// counted, never proposed for change.
//
// Read-only. Writes one report file. Changes nothing.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const { tierOf, isProtected } = await import(pathToFileURL('C:\\mediaserver\\src\\optimize.js').href);
const B = String.fromCharCode(92);
const OUT = 'C:' + B + 'mediaserver' + B + 'tools' + B + 'tv-compat.txt';

// Hardware-decodable on both an Apple TV 4K and a Google TV box.
const VIDEO_OK = new Set(['h264', 'hevc']);
// Decodable by the TV without the server re-encoding the audio.
const AUDIO_OK = new Set(['aac', 'ac3', 'eac3']);

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

const stats = {
  total: 0, protected: 0, fine: 0,
  audioOnly: [], videoBad: [], both: []
};
const videoCodecCount = {}, audioProblemCount = {};

for (const r of rows) {
  stats.total++;
  if (isProtected(r)) { stats.protected++; continue; }

  let audio = [];
  try { audio = JSON.parse(r.audio_json || '[]'); } catch {}

  const vOk = VIDEO_OK.has(String(r.vcodec || '').toLowerCase());
  const hasOkAudio = audio.some((a) => AUDIO_OK.has(String(a.codec).toLowerCase()));
  const noAudio = audio.length === 0;

  const item = {
    kind: r.file_kind, fileId: r.file_id, path: r.path,
    title: r.title || r.path.split(B).pop(),
    season: r.season, episode: r.episode,
    tier: tierOf(r.width, r.height), hdr: !!r.hdr, size: Number(r.size) || 0,
    vcodec: r.vcodec, audio: audio.map((a) => `${a.codec}/${a.ch || '?'}ch`).join(', ') || 'none'
  };

  if (!vOk) videoCodecCount[r.vcodec] = (videoCodecCount[r.vcodec] || 0) + 1;
  if (!hasOkAudio && !noAudio) {
    for (const a of audio) audioProblemCount[a.codec] = (audioProblemCount[a.codec] || 0) + 1;
  }

  if (vOk && (hasOkAudio || noAudio)) { stats.fine++; continue; }
  if (!vOk && !hasOkAudio) stats.both.push(item);
  else if (!vOk) stats.videoBad.push(item);
  else stats.audioOnly.push(item);
}

const GB = (b) => (b / 2 ** 30).toFixed(1);
const bytes = (a) => a.reduce((s, x) => s + x.size, 0);
const out = [];
out.push('WHAT STOPS YOUR LIBRARY DIRECT-PLAYING ON THE TVs');
out.push('');
out.push(`${stats.total.toLocaleString()} files examined`);
out.push('');
out.push(`  ${String(stats.fine).padStart(6)}  already direct-play on both TVs — nothing to do`);
out.push(`  ${String(stats.protected).padStart(6)}  4K HDR — EXCLUDED BY RULE, never touched, not counted below`);
out.push(`  ${String(stats.audioOnly.length).padStart(6)}  audio only: no TV-friendly track (FIXABLE without touching video)`);
out.push(`  ${String(stats.videoBad.length).padStart(6)}  video codec the TVs cannot decode`);
out.push(`  ${String(stats.both.length).padStart(6)}  both problems`);
out.push('');
out.push(`Audio-only cases hold ${GB(bytes(stats.audioOnly))} GB and are the ones worth fixing:`);
out.push('adding one compatible track leaves every existing stream untouched.');
out.push('');

out.push('--- audio codecs with no TV-friendly alternative in the file ---');
for (const [k, v] of Object.entries(audioProblemCount).sort((a, b) => b[1] - a[1])) out.push(`  ${String(v).padStart(6)}  ${k}`);
out.push('');
out.push('--- video codecs the TVs cannot hardware-decode ---');
for (const [k, v] of Object.entries(videoCodecCount).sort((a, b) => b[1] - a[1])) out.push(`  ${String(v).padStart(6)}  ${k}`);
out.push('');

for (const [label, list] of [
  ['AUDIO-ONLY — add a compatible track, video untouched', stats.audioOnly],
  ['VIDEO CODEC — would need a real re-encode', stats.videoBad],
  ['BOTH', stats.both]
]) {
  out.push(`=== ${label} (${list.length}) ===`);
  for (const i of list.sort((a, b) => b.size - a.size).slice(0, 40)) {
    const ep = i.season != null ? ` S${i.season}E${i.episode}` : '';
    out.push(`  ${GB(i.size).padStart(7)} GB  ${i.tier.padEnd(6)} ${String(i.vcodec).padEnd(6)} ${i.audio.padEnd(28)} ${i.title}${ep}`);
  }
  if (list.length > 40) out.push(`  … and ${list.length - 40} more`);
  out.push('');
}

fs.writeFileSync(OUT, out.join('\r\n'), 'utf8');
console.log(out.slice(0, 22).join('\n'));
console.log(`\nfull report: ${OUT}`);

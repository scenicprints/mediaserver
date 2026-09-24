// Sidecar subtitle files: which ones count, and turning each into WebVTT.
//
// Every client — the web UI, the LG/TCL webviews, the Apple TV app, Android
// TV's libVLC — is fed subtitles from the same endpoint, and that endpoint
// serves WebVTT. So a format is "supported" here exactly when it can be turned
// into WebVTT without OCR, which is the line this file draws.
//
// Before this, sidecar discovery accepted .srt and .vtt only, while EMBEDDED
// tracks (ffmpeg.js, TEXT_SUB_CODECS) already accepted ass/ssa. The same ASS
// subtitle was readable inside an mkv and invisible beside it.

import fs from 'node:fs';
import path from 'node:path';

// Text sidecars, all of which convert to WebVTT below.
export const TEXT_SIDECAR_RE = /\.(srt|vtt|ssa|ass|smi|sami)$/i;

// Bitmap sidecars, listed so their absence reads as a decision rather than an
// oversight. VobSub is an .idx index plus a .sub stream of SUBTITLE IMAGES —
// there is no text in it to convert, and OCR is not something this server does.
// Adding the extension to the list above would put a track in the picker that
// renders nothing at all, which is worse than not offering the track. The only
// real way to show one is to burn it into the video during transcode; that is
// not built, so these files are skipped.
export const BITMAP_SIDECAR_RE = /\.(sub|idx|pgs|sup)$/i;

// Decode a subtitle file to a string. Subtitle files travel the internet and
// land in whatever encoding their author had; UTF-16 with a BOM is common
// enough (and utterly unreadable as UTF-8) to be worth handling. Anything
// without a BOM is read as UTF-8, which covers everything else here.
export function decodeSubtitle(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const be = Buffer.from(buf.subarray(2));
    if (be.length % 2 === 0) { be.swap16(); return be.toString('utf16le'); }
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

export function readSubtitleFile(filePath) {
  return decodeSubtitle(fs.readFileSync(filePath));
}

// ---- Which sidecar belongs to which video ----

// Names that say nothing about a film. A DVD rip numbers its tracks
// ("2_English.srt"), so the leading digits are dropped before the check.
const GENERIC_STEMS = new Set([
  'english', 'eng', 'en', 'spanish', 'spa', 'es', 'french', 'fre', 'fra', 'fr',
  'german', 'ger', 'deu', 'de', 'italian', 'ita', 'it', 'portuguese', 'por', 'pt',
  'dutch', 'dut', 'nld', 'nl', 'japanese', 'jpn', 'ja', 'korean', 'kor', 'ko',
  'chinese', 'chi', 'zho', 'zh', 'russian', 'rus', 'ru', 'arabic', 'ara', 'ar',
  'subtitle', 'subtitles', 'subs', 'sub', 'forced', 'sdh', 'cc', 'track', 'default',
  'und', 'unknown'
]);

const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Does a sidecar sitting beside a video belong to it?
//
// Names are compared with case and punctuation stripped, and a match is one
// name being a PREFIX of the other: a sidecar carries the video's name plus a
// language or forced/SDH tag ("Film (2009).en.srt"), or the video carries the
// sidecar's name plus release junk ("Film (2009) 1080p BluRay-GRP.mkv" beside
// "Film (2009).srt").
//
// It used to accept a match ANYWHERE inside either name, which is how an
// orphan called "English.srt" loose in the movies folder attached itself to
// The English Patient — "theenglishpatient1996" contains "english". Fifteen
// sidecars in the pool have no video of their own, so this is not theoretical.
// A prefix cannot reach into the middle of a title, a bare language name is
// refused outright, and the one thing prefixes would have lost — names that
// differ only by a short leading word — is kept by requiring near-equal
// lengths rather than any length at all.
export function sidecarMatches(videoStem, sidecarStem) {
  const v = normName(videoStem);
  const s = normName(sidecarStem);
  if (!v || !s) return false;
  if (GENERIC_STEMS.has(s.replace(/^\d+/, ''))) return false;

  const [short, long] = s.length <= v.length ? [s, v] : [v, s];
  if (short.length < 4) return false;          // "en", "01": too little to go on
  if (long.startsWith(short)) return true;
  return long.includes(short) && short.length / long.length >= 0.7;
}

// ---- SubRip (.srt) ----

export function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

// ---- SubStation Alpha (.ssa / .ass) ----
//
// INI-ish: an [Events] section whose "Format:" line names the fields of the
// "Dialogue:" lines under it. The field ORDER is not fixed — SSA v4 opens with
// Marked, ASS v4+ with Layer — so the Format line is read rather than assumed.
// Text is always the last field and the only one allowed to contain commas,
// which is what bounds the split.

const SSA_TIME = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/;

// "0:00:01.23" (one-digit hours, centiseconds) -> "00:00:01.230".
function assTime(t) {
  const m = SSA_TIME.exec(t);
  if (!m) return null;
  const h = String(+m[1]).padStart(2, '0');
  return `${h}:${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')}.${m[4].padEnd(3, '0')}`;
}

function vttSeconds(vt) {
  const [h, m, rest] = vt.split(':');
  return (+h) * 3600 + (+m) * 60 + parseFloat(rest);
}

// Override blocks carry styling, karaoke timing and vector drawings. Italic,
// bold and underline have WebVTT equivalents and are kept; the rest goes.
function assText(raw) {
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  for (const [tag, open, close] of [['i', '<i>', '</i>'], ['b', '<b>', '</b>'], ['u', '<u>', '</u>']]) {
    s = s.replace(new RegExp(`\\{\\\\${tag}1\\}`, 'gi'), open)
      .replace(new RegExp(`\\{\\\\${tag}0\\}`, 'gi'), close);
  }
  return s
    .replace(/\{[^}]*\}/g, '')  // every remaining override block
    .replace(/\\[Nn]/g, '\n')   // hard and soft line breaks
    .replace(/\\h/g, ' ')       // non-breaking space
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const ASS_V4PLUS_FIELDS = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

export function assToVtt(ass) {
  const lines = ass.replace(/^﻿/, '').split(/\r?\n/);
  let fields = null;     // the Format line's field names, lower-cased
  let inEvents = false;
  const cues = [];

  for (const line of lines) {
    const sec = line.match(/^\s*\[(.+)\]\s*$/);
    if (sec) { inEvents = /^events$/i.test(sec[1].trim()); continue; }
    if (!inEvents) continue;

    const fmt = line.match(/^\s*Format\s*:\s*(.*)$/i);
    if (fmt) { fields = fmt[1].split(',').map((f) => f.trim().toLowerCase()); continue; }

    const dlg = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
    if (!dlg) continue;  // Comment:, Picture:, Sound: are not spoken lines

    // Without a Format line, assume the ASS v4+ order — every file in the wild
    // uses it, and the alternative is dropping the subtitle entirely.
    const f = fields || ASS_V4PLUS_FIELDS;
    const iStart = f.indexOf('start'), iEnd = f.indexOf('end'), iText = f.indexOf('text');
    if (iStart < 0 || iEnd < 0 || iText < 0) continue;

    const parts = dlg[1].split(',');
    if (parts.length < f.length) continue;
    const text = parts.slice(iText).join(',');   // Text on: commas and all
    const start = assTime(parts[iStart]);
    const end = assTime(parts[iEnd]);
    if (!start || !end || vttSeconds(end) <= vttSeconds(start)) continue;
    // A drawing (\p1 and up) is vector coordinates, not words. Rendered as
    // text it is a screenful of numbers over the picture.
    if (/\{[^}]*\\p\s*[1-9]/.test(text)) continue;

    const body = assText(text);
    if (!body) continue;
    cues.push({ start, end, body });
  }

  const seen = new Set();
  const out = ['WEBVTT', ''];
  for (const c of cues) {
    const key = `${c.start}|${c.end}|${c.body}`;
    if (seen.has(key)) continue;  // sign/karaoke layers repeat a line verbatim
    seen.add(key);
    out.push(`${c.start} --> ${c.end}`, c.body, '');
  }
  return out.join('\n');
}

// ---- SAMI (.smi / .sami) ----
//
// Microsoft's HTML-ish caption format: a run of <SYNC Start=ms> markers, each
// opening a cue that runs until the next marker. A marker whose paragraph is
// blank (conventionally "&nbsp;") is how the format clears the screen, so it
// ends the cue before it rather than starting one of its own.

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function unescapeHtml(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const k = name.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function vttStamp(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor(t / 60000) % 60, s = Math.floor(t / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}

export function samiToVtt(smi) {
  const src = smi.replace(/^﻿/, '');
  const marks = [];
  const re = /<sync\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m[1].match(/start\s*=\s*["']?(-?\d+)/i);
    if (!start) continue;
    marks.push({ at: parseInt(start[1], 10), from: re.lastIndex, tagAt: m.index });
  }

  const cues = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = src.slice(marks[i].from, i + 1 < marks.length ? marks[i + 1].tagAt : src.length);
    // One SYNC can hold a <P> per language; take the first that has words.
    const paras = chunk.split(/<p\b[^>]*>/i).slice(1);
    let body = '';
    for (const p of (paras.length ? paras : [chunk])) {
      const t = unescapeHtml(p.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
      if (t) { body = t; break; }
    }
    if (!body) continue;  // the blank marker that clears the screen
    // The last cue has nothing after it to end it; four seconds is the usual
    // reading time and the player hides it either way when the file ends.
    const end = i + 1 < marks.length ? marks[i + 1].at : marks[i].at + 4000;
    if (end <= marks[i].at) continue;
    cues.push({ start: marks[i].at, end, body });
  }

  const out = ['WEBVTT', ''];
  for (const c of cues) {
    out.push(`${vttStamp(c.start)} --> ${vttStamp(c.end)}`,
      c.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), '');
  }
  return out.join('\n');
}

// ---- Dispatch ----

// Convert one sidecar's text to WebVTT, chosen by its extension. A .vtt (an
// AI-generated track, say) is already there and passes through untouched.
export function sidecarToVtt(filePath, text) {
  if (/\.vtt$/i.test(filePath)) return text.replace(/^﻿/, '');
  if (/\.(ssa|ass)$/i.test(filePath)) return assToVtt(text);
  if (/\.(smi|sami)$/i.test(filePath)) return samiToVtt(text);
  return srtToVtt(text);
}

// ---- Discovery ----

// Short-TTL folder-listing cache for subtitle discovery. A show page asks for
// the subtitles of every episode file, and episodes share season folders — with
// up to 6 readdirs per file that was hundreds of synchronous disk hits per view
// (stuttering active streams on the Dell's HDDs). Cached, a 200-episode show
// costs a handful of reads. 10s TTL so a freshly downloaded .srt still appears
// on the next open.
const dirListCache = new Map(); // folder -> { t, files|null }
function cachedDirList(folder) {
  const now = Date.now();
  const hit = dirListCache.get(folder);
  if (hit && now - hit.t < 10e3) return hit.files;
  let files = null;
  try { files = fs.readdirSync(folder); } catch { /* missing/unreadable */ }
  if (dirListCache.size > 500) dirListCache.clear(); // tiny + self-limiting
  dirListCache.set(folder, { t: now, files });
  return files;
}

/** Forget every cached folder listing (a sidecar or video was just added or removed). */
export function clearSubtitleCache() {
  dirListCache.clear();
}

// Find external subtitle sidecars for a video: next to it (name match, see
// sidecarMatches) and in a Subs/Subtitles subfolder, where the folder itself is
// the scoping and every file in it counts. Returns [{ path, label }].
export function listSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const out = [];

  const consider = (folder, loose) => {
    const files = cachedDirList(folder);
    if (!files) return;
    for (const f of files) {
      if (!TEXT_SIDECAR_RE.test(f)) continue;
      const b = path.basename(f, path.extname(f));
      if (!loose && !sidecarMatches(stem, b)) continue;
      // AI-generated tracks are tagged "<lang>-ai" or "orig-ai" by whisper.js.
      const ai = b.match(/[.\-_ ](orig|[a-z]{2,3})-ai$/i);
      let label;
      if (ai) label = (ai[1].toLowerCase() === 'orig' ? 'Auto' : ai[1].toUpperCase()) + ' (AI)';
      else {
        const lang = (b.toLowerCase().match(/[.\-_ ]([a-z]{2,3})(\.forced|\.sdh)?$/) || [])[1];
        const extra = b.length > stem.length ? b.slice(stem.length).replace(/[.\-_]+/g, ' ').trim() : '';
        label = lang ? lang.toUpperCase() : (extra || 'Subtitles');
      }
      out.push({ path: path.join(folder, f), label });
    }
  };
  consider(dir, false);
  for (const sub of ['Subs', 'Subtitles', 'subs', 'subtitles', 'Sub']) consider(path.join(dir, sub), true);

  // Deduped case-insensitively, because the five spellings above are five
  // lookups of the SAME folder on Windows: "Subs" and "subs" both open it, and
  // a set keyed on the exact string sees two different paths to one file. Every
  // sidecar in a Subs folder has been listed twice in the picker.
  const seen = new Set();
  return out.filter((s) => {
    const k = s.path.toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

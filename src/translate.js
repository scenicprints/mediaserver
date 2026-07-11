// Subtitle translation. Whisper only transcribes or translates *to English*, so
// to get Spanish (or any other language) we translate the cues after Whisper.
//
// Two providers, tried in order:
//   1. LibreTranslate — if `config.translateUrl` is set (self-hosted or public
//      instance). Batches an array in one request; most reliable at scale.
//   2. Google's free endpoint — zero-config fallback, no key. Fine for a movie
//      but can rate-limit, so we go a few cues at a time and keep the original
//      text on any failure.
import fs from 'node:fs';

function parseVtt(text) {
  const cues = [];
  text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\n+/).forEach((block) => {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) return;
    const body = lines.slice(ti + 1).join('\n').trim();
    cues.push({ time: lines[ti].trim(), text: body });
  });
  return cues;
}

function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${c.time}\n${c.text}`).join('\n\n') + '\n';
}

async function libreBatch(url, texts, target) {
  const res = await fetch(url.replace(/\/$/, '') + '/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, source: 'auto', target, format: 'text' })
  });
  if (!res.ok) throw new Error('libretranslate ' + res.status);
  const d = await res.json();
  // LibreTranslate returns { translatedText: [...] } for an array input.
  const t = d.translatedText;
  return Array.isArray(t) ? t : texts.map((_, i) => (Array.isArray(t) ? t[i] : t));
}

async function googleOne(text, target) {
  const u = new URL('https://translate.googleapis.com/translate_a/single');
  u.searchParams.set('client', 'gtx');
  u.searchParams.set('sl', 'auto');
  u.searchParams.set('tl', target);
  u.searchParams.set('dt', 't');
  u.searchParams.set('q', text);
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('google ' + res.status);
  const d = await res.json();
  // d[0] is an array of [translatedChunk, originalChunk, …]; join the chunks.
  return (d[0] || []).map((seg) => seg[0]).join('');
}

// Translate an array of plain strings. onProgress(0..1) as it goes.
async function translateTexts(texts, target, { config = {}, onProgress } = {}) {
  const out = new Array(texts.length);
  if (config.translateUrl) {
    // Batch through LibreTranslate in chunks so one request isn't enormous.
    const CH = 80;
    for (let i = 0; i < texts.length; i += CH) {
      const slice = texts.slice(i, i + CH);
      try {
        const tr = await libreBatch(config.translateUrl, slice, target);
        for (let j = 0; j < slice.length; j++) out[i + j] = tr[j] || slice[j];
      } catch { for (let j = 0; j < slice.length; j++) out[i + j] = slice[j]; }
      if (onProgress) onProgress(Math.min(1, (i + slice.length) / texts.length));
    }
    return out;
  }
  // Google fallback: small concurrency, keep original on failure.
  const CONC = 5;
  let done = 0, idx = 0;
  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      try { out[i] = await googleOne(texts[i], target); }
      catch { out[i] = texts[i]; }
      done++;
      if (onProgress) onProgress(done / texts.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

// Read a source .vtt, translate its cue text to `target`, write `outPath`.
export async function translateVttFile(srcPath, outPath, target, opts = {}) {
  if (fs.existsSync(outPath)) { if (opts.onProgress) opts.onProgress(1); return outPath; }
  const cues = parseVtt(fs.readFileSync(srcPath, 'utf8'));
  const texts = cues.map((c) => c.text.replace(/\n/g, ' '));
  const translated = await translateTexts(texts, target, opts);
  cues.forEach((c, i) => { c.text = translated[i] || c.text; });
  fs.writeFileSync(outPath, toVtt(cues), 'utf8');
  return outPath;
}

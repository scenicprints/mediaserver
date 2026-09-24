// Local artwork cache — the reason the library still looks like itself when the
// internet is out.
//
// Posters, backdrops and stills are stored in the DB as absolute TMDB URLs
// (src/tmdb.js builds them), and were handed straight to <img src>. That works
// until the WAN drops, at which point every image on every screen fails and the
// UI is a wall of title-text placeholders. Plex doesn't have that problem
// because it copies artwork to disk at scan time and serves it itself.
//
// Rather than migrate the schema, this intercepts the two ends:
//   1. rewriteJson() swaps the TMDB image prefix for a local /art/ one on the
//      way out, so every route is covered at once — including ones added later,
//      and the person/collection/streaming art that is built on the fly.
//   2. GET /art/<size>/<file> serves the cached bytes, and on a miss fetches
//      from TMDB once and keeps the copy.
// The TMDB URL stays the canonical identity, so nothing in the DB changes and
// losing the cache directory is harmless — it refills.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TMDB_PREFIX = 'https://image.tmdb.org/t/p/';
const LOCAL_PREFIX = '/art/';

// TMDB image paths are content-addressed and never change under a given size,
// so a hit can be cached hard. Only these shapes are ever fetched or written.
const SAFE = /^(w\d{2,4}|h\d{2,4}|original)\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|svg)$/;

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

/** Absolute TMDB image URL -> the path we serve it at ("w500/abc.jpg"). */
export function relFor(url) {
  const s = String(url || '');
  return s.startsWith(TMDB_PREFIX) ? s.slice(TMDB_PREFIX.length) : null;
}

/**
 * Swap TMDB image URLs for local ones in an outgoing JSON body.
 *
 * `origin` must be the scheme+host the client actually reached us on, because
 * the result has to be ABSOLUTE. The tvOS app feeds these straight to
 * `URL(string:)` with no base (appletv/Sources/Components.swift), so a
 * root-relative "/art/..." would parse into a hostless URL and silently blank
 * every poster on the Apple TV. Deriving it from the request also means the
 * answer is right on whichever name the client used — the public hostname from
 * outside, the same hostname resolved to the LAN from inside — with nothing
 * hardcoded. Only when no origin can be determined does it fall back to a
 * root-relative path, which browsers resolve correctly anyway.
 */
export function rewriteJson(body, origin) {
  if (typeof body !== 'string' || !body.includes(TMDB_PREFIX)) return body;
  const prefix = origin ? String(origin).replace(/\/+$/, '') + LOCAL_PREFIX : LOCAL_PREFIX;
  return body.split(TMDB_PREFIX).join(prefix);
}

/** The scheme+host this request came in on, for building absolute art URLs. */
export function originOf(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  if (!host) return '';
  const proto = String((req && req.protocol) || 'http');
  return `${proto}://${host}`;
}

/** Fetch one image into the cache if it isn't there. Returns true if it's on disk after. */
export async function fetchOne(dir, rel) {
  if (!SAFE.test(rel)) return false;
  const dest = path.join(dir, rel);
  try { await fsp.access(dest); return true; } catch { /* not cached yet */ }

  let res;
  try { res = await fetch(TMDB_PREFIX + rel); } catch { return false; }
  if (!res || !res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return false;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // Write beside the target and rename, so a torn download can never be served
  // as a truncated image on the next request.
  const tmp = `${dest}.${process.pid}.part`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return true;
}

/**
 * Serve /art/<size>/<file> from disk, falling back to a one-time fetch.
 * Offline with a cold cache this 404s, which renders exactly the placeholder
 * the UI already shows for a title that has no artwork at all.
 */
export function registerArtCache(app, dir) {
  fs.mkdirSync(dir, { recursive: true });

  app.get('/art/*', async (req, reply) => {
    const rel = String(req.params['*'] || '');
    if (!SAFE.test(rel)) return reply.code(404).send('not found');

    const file = path.join(dir, rel);
    // Defence in depth: SAFE already forbids traversal, but never serve outside.
    if (!file.startsWith(path.join(dir, path.sep)) && path.dirname(file) !== dir) {
      if (!path.resolve(file).startsWith(path.resolve(dir))) return reply.code(404).send('not found');
    }

    let stat = null;
    try { stat = await fsp.stat(file); } catch { /* miss */ }
    if (!stat) {
      const ok = await fetchOne(dir, rel);
      if (!ok) return reply.code(404).send('not found');
      try { stat = await fsp.stat(file); } catch { return reply.code(404).send('not found'); }
    }

    return reply
      .header('Content-Type', MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream')
      .header('Content-Length', String(stat.size))
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(fs.createReadStream(file));
  });
}

/** Every TMDB art URL the library knows about, deduped. */
export function artUrlsInDb(db) {
  const out = new Set();
  const add = (v) => { const rel = relFor(v); if (rel && SAFE.test(rel)) out.add(rel); };
  const q = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };

  for (const r of q('SELECT poster, backdrop, collection_poster FROM movies')) {
    add(r.poster); add(r.backdrop); add(r.collection_poster);
  }
  for (const r of q('SELECT poster, backdrop FROM shows')) { add(r.poster); add(r.backdrop); }
  for (const r of q('SELECT still FROM episodes')) add(r.still);
  return [...out];
}

/**
 * Pull down everything the library references, so browsing works offline even
 * for titles nobody has opened yet. Best-effort and interruptible: anything that
 * fails is simply retried on the next run (or fetched on demand when viewed).
 */
export async function warm(db, dir, { concurrency = 6, log = () => {} } = {}) {
  const rels = artUrlsInDb(db);
  let done = 0, fetched = 0, failed = 0, i = 0;

  const worker = async () => {
    while (i < rels.length) {
      const rel = rels[i++];
      const dest = path.join(dir, rel);
      let had = true;
      try { await fsp.access(dest); } catch { had = false; }
      if (!had) {
        const ok = await fetchOne(dir, rel);
        if (ok) fetched++; else failed++;
      }
      done++;
    }
  };

  fs.mkdirSync(dir, { recursive: true });
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  log(`[art] cache warm: ${done} referenced, ${fetched} newly cached, ${failed} unavailable`);
  return { total: rels.length, fetched, failed };
}

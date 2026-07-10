// Minimal TMDB client. Uses Node's global fetch (no dependency).
// Get a free API key at https://www.themoviedb.org/settings/api

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';

export async function searchMovie(apiKey, title, year) {
  if (!apiKey) return null;
  const url = new URL(BASE + '/search/movie');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', title);
  if (year) url.searchParams.set('year', String(year));

  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit) return null;

  return {
    tmdb_id: hit.id,
    overview: hit.overview || null,
    poster: hit.poster_path ? POSTER + hit.poster_path : null,
    backdrop: hit.backdrop_path ? BACKDROP + hit.backdrop_path : null,
    rating: typeof hit.vote_average === 'number' ? hit.vote_average : null
  };
}

// Enrich every movie that hasn't been matched yet. Returns count updated.
export async function enrichLibrary(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) {
    log('No TMDB API key configured — skipping metadata enrichment.');
    return 0;
  }
  const rows = db.prepare('SELECT id, title, year FROM movies WHERE tmdb_id IS NULL').all();
  const update = db.prepare(
    `UPDATE movies SET tmdb_id = ?, overview = ?, poster = ?, backdrop = ?, rating = ? WHERE id = ?`
  );

  let updated = 0;
  for (const row of rows) {
    const meta = await searchMovie(apiKey, row.title, row.year);
    if (meta) {
      update.run(meta.tmdb_id, meta.overview, meta.poster, meta.backdrop, meta.rating, row.id);
      updated++;
      log(`  matched: ${row.title} (${row.year ?? '?'})`);
    } else {
      log(`  no match: ${row.title} (${row.year ?? '?'})`);
    }
    // Gentle pacing to stay well under TMDB rate limits.
    await new Promise((r) => setTimeout(r, 120));
  }
  return updated;
}

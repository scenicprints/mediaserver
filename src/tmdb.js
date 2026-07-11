// Minimal TMDB client. Uses Node's global fetch (no dependency).
// Get a free API key at https://www.themoviedb.org/settings/api

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const STILL = 'https://image.tmdb.org/t/p/w300';
const PROFILE = 'https://image.tmdb.org/t/p/w185';

// Season list (with poster art) for a show.
export async function showExtra(apiKey, tmdbId) {
  if (!apiKey || !tmdbId) return null;
  const url = new URL(`${BASE}/tv/${tmdbId}`);
  url.searchParams.set('api_key', apiKey);
  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const d = await res.json();
  return {
    seasons: (d.seasons || []).map((s) => ({
      season: s.season_number,
      name: s.name,
      poster: s.poster_path ? POSTER + s.poster_path : null,
      episodes: s.episode_count
    }))
  };
}

// Rich detail for a single episode: still, air date, rating, runtime, and people
// (director, writers, guest stars, main cast) — so the episode page matches movies.
export async function episodeExtra(apiKey, showTmdbId, season, episode) {
  if (!apiKey || !showTmdbId) return null;
  const url = new URL(`${BASE}/tv/${showTmdbId}/season/${season}/episode/${episode}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('append_to_response', 'credits');
  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const d = await res.json();

  const person = (c) => ({ name: c.name, role: c.character || c.job, profile: c.profile_path ? PROFILE + c.profile_path : null });
  const crew = d.crew || [];
  const directors = crew.filter((c) => c.job === 'Director').map((c) => ({ name: c.name, role: 'Director', profile: c.profile_path ? PROFILE + c.profile_path : null }));
  const writers = crew.filter((c) => c.department === 'Writing').slice(0, 2).map((c) => ({ name: c.name, role: 'Writer', profile: c.profile_path ? PROFILE + c.profile_path : null }));
  const guests = (d.guest_stars || []).slice(0, 10).map(person);
  const cast = (d.credits?.cast || []).slice(0, 8).map(person);

  return {
    still: d.still_path ? BACKDROP + d.still_path : null,
    overview: d.overview || null,
    airDate: d.air_date || null,
    rating: typeof d.vote_average === 'number' && d.vote_average > 0 ? d.vote_average : null,
    runtime: d.runtime || null,
    people: [...directors, ...writers, ...guests, ...cast]
  };
}

// Rich detail for a single movie: genres, runtime, cast, director(s), a trailer,
// and recommendations. One request (append_to_response) so it's cheap.
export async function movieExtra(apiKey, tmdbId) {
  if (!apiKey || !tmdbId) return null;
  const url = new URL(`${BASE}/movie/${tmdbId}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('append_to_response', 'credits,videos,recommendations');

  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const d = await res.json();

  const cast = (d.credits?.cast || []).slice(0, 14).map((c) => ({
    name: c.name, character: c.character, profile: c.profile_path ? PROFILE + c.profile_path : null
  }));
  const crew = d.credits?.crew || [];
  const directors = [...new Set(crew.filter((c) => c.job === 'Director').map((c) => c.name))];
  const vids = d.videos?.results || [];
  const trailer = vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer') || vids.find((v) => v.site === 'YouTube');
  const recommendations = (d.recommendations?.results || []).slice(0, 20).map((r) => ({
    tmdb_id: r.id, title: r.title, poster: r.poster_path ? POSTER + r.poster_path : null,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : null
  }));

  // Franchise / collection (e.g. "Star Wars Collection") — all entries, in order.
  let collection = null;
  if (d.belongs_to_collection) {
    try {
      const cu = new URL(`${BASE}/collection/${d.belongs_to_collection.id}`);
      cu.searchParams.set('api_key', apiKey);
      const cr = await fetch(cu);
      if (cr.ok) {
        const cd = await cr.json();
        collection = {
          name: cd.name,
          parts: (cd.parts || []).map((p) => ({
            tmdb_id: p.id, title: p.title, poster: p.poster_path ? POSTER + p.poster_path : null,
            year: p.release_date ? parseInt(p.release_date.slice(0, 4), 10) : null
          })).sort((a, b) => (a.year || 0) - (b.year || 0))
        };
      }
    } catch {}
  }

  return {
    genres: (d.genres || []).map((g) => g.name),
    runtime: d.runtime || null,
    tagline: d.tagline || null,
    cast, directors,
    trailer: trailer ? { key: trailer.key, name: trailer.name } : null,
    recommendations, collection
  };
}

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

export async function searchTv(apiKey, title) {
  if (!apiKey) return null;
  const url = new URL(BASE + '/search/tv');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', title);

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

  const year = hit.first_air_date ? parseInt(hit.first_air_date.slice(0, 4), 10) : null;
  return {
    tmdb_id: hit.id,
    overview: hit.overview || null,
    poster: hit.poster_path ? POSTER + hit.poster_path : null,
    backdrop: hit.backdrop_path ? BACKDROP + hit.backdrop_path : null,
    rating: typeof hit.vote_average === 'number' ? hit.vote_average : null,
    year
  };
}

// Enrich every show that hasn't been matched yet. Returns count updated.
export async function enrichShows(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) return 0;
  const rows = db.prepare('SELECT id, title FROM shows WHERE tmdb_id IS NULL').all();
  const update = db.prepare(
    `UPDATE shows SET tmdb_id = ?, overview = ?, poster = ?, backdrop = ?, rating = ?, year = ? WHERE id = ?`
  );

  let updated = 0;
  for (const row of rows) {
    const meta = await searchTv(apiKey, row.title);
    if (meta) {
      update.run(meta.tmdb_id, meta.overview, meta.poster, meta.backdrop, meta.rating, meta.year, row.id);
      updated++;
      log(`  matched show: ${row.title}`);
    } else {
      log(`  no match (show): ${row.title}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return updated;
}

// Fill in real episode names, overviews, and still thumbnails from TMDB, one
// season request per show/season. Only touches episodes still missing a title.
export async function enrichEpisodes(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) return 0;
  const shows = db.prepare(
    `SELECT DISTINCT s.id, s.tmdb_id FROM shows s
     JOIN episodes e ON e.show_id = s.id
     WHERE s.tmdb_id IS NOT NULL AND e.title IS NULL`
  ).all();
  const seasonsStmt = db.prepare('SELECT DISTINCT season FROM episodes WHERE show_id = ? AND title IS NULL');
  const updateEp = db.prepare(
    'UPDATE episodes SET title = ?, overview = ?, still = ? WHERE show_id = ? AND season = ? AND episode = ?'
  );

  let updated = 0;
  for (const show of shows) {
    for (const { season } of seasonsStmt.all(show.id)) {
      let data;
      try {
        const url = new URL(`${BASE}/tv/${show.tmdb_id}/season/${season}`);
        url.searchParams.set('api_key', apiKey);
        const res = await fetch(url);
        if (!res.ok) continue;
        data = await res.json();
      } catch {
        continue;
      }
      for (const e of data.episodes || []) {
        const info = updateEp.run(
          e.name || null,
          e.overview || null,
          e.still_path ? STILL + e.still_path : null,
          show.id, season, e.episode_number
        );
        if (info.changes) updated++;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    log(`  episodes enriched for show ${show.id}`);
  }
  return updated;
}

async function genresFor(apiKey, type, id) {
  try {
    const url = new URL(`${BASE}/${type}/${id}`);
    url.searchParams.set('api_key', apiKey);
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    return (d.genres || []).map((g) => g.name);
  } catch {
    return null;
  }
}

// Fill in genres for movies/shows that have a tmdb_id but no genres yet, so the
// browse categories (Action, Comedy, …) populate. Runs in the background.
export async function backfillGenres(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) return 0;
  const movies = db.prepare("SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND (genres IS NULL OR genres = '')").all();
  const shows = db.prepare("SELECT id, tmdb_id FROM shows WHERE tmdb_id IS NOT NULL AND (genres IS NULL OR genres = '')").all();
  const upM = db.prepare('UPDATE movies SET genres = ? WHERE id = ?');
  const upS = db.prepare('UPDATE shows SET genres = ? WHERE id = ?');
  let n = 0;
  for (const m of movies) {
    const g = await genresFor(apiKey, 'movie', m.tmdb_id);
    if (g) { upM.run(JSON.stringify(g), m.id); n++; }
    await new Promise((r) => setTimeout(r, 60));
  }
  for (const s of shows) {
    const g = await genresFor(apiKey, 'tv', s.tmdb_id);
    if (g) { upS.run(JSON.stringify(g), s.id); n++; }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (n) log(`Genres backfilled for ${n} title(s).`);
  return n;
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

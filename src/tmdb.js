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

// ---- Matching a file to a TMDB entry -------------------------------------
//
// This used to take `results[0]` and ask nothing further. TMDB orders search by
// POPULARITY, so a small film called "Dead" (2020) came back as Dead Poets
// Society: the query is a prefix of a far more famous title, and nothing looked
// at the year or at how much extra title had been bolted on. Wrong metadata is
// worse than none, because it silently rewrites a film's poster, plot and
// rating and you have to notice by eye.
//
// So every candidate is scored, and a candidate that doesn't clear the bar is
// refused rather than accepted as the best of a bad lot.

// Compare titles on their letters and digits only: punctuation, accents,
// ampersands and case are all noise ("WALL·E" = "Wall-E", "Se7en" = "Se7en").
function normTitle(s) {
  return String(s || '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const dropArticle = (s) => s.replace(/^(the|a|an) /, '');
const yearOf = (c) => {
  const d = c.release_date || c.first_air_date || '';
  const y = d ? parseInt(d.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : null;
};

const TITLE_EXACT = 100;   // same title once punctuation is set aside
const TITLE_PREFIX = 60;   // ours is the front of theirs, or the other way round
const TITLE_PART = 45;     // one contains the other somewhere
// A year that agrees is the strongest signal there is; one that disagrees by
// more than a release-date wobble is close to disqualifying.
const YEAR_SAME = 40, YEAR_NEAR = 18, YEAR_WRONG = -25, YEAR_WRONG_STEP = -3;
// Without a year to check against, demand a much closer title.
const FLOOR = 45;

export function scoreCandidate(c, wantTitle, wantYear) {
  const want = normTitle(wantTitle);
  const wantNA = dropArticle(want);
  if (!wantNA) return -Infinity;

  const wantWords = wantNA.split(' ').length;
  let best = 0, bestExtra = 0;
  for (const t of [c.title, c.original_title, c.name, c.original_name]) {
    if (!t) continue;
    const gotNA = dropArticle(normTitle(t));
    if (!gotNA) continue;
    let s;
    if (gotNA === wantNA) s = TITLE_EXACT;
    else if (gotNA.startsWith(wantNA + ' ') || wantNA.startsWith(gotNA + ' ')) s = TITLE_PREFIX;
    else if (gotNA.includes(wantNA) || wantNA.includes(gotNA)) s = TITLE_PART;
    else continue;
    // Words theirs has that ours doesn't. Only this direction is suspicious.
    // The other one costs nothing: "Marvel's Daredevil" naming the file for
    // TMDB's "Daredevil" is ordinary. Capped, because plenty of real titles are
    // long ("Dr. Strangelove or: How I Learned to Stop Worrying...").
    const extra = Math.max(0, gotNA.split(' ').length - wantNA.split(' ').length);
    s -= Math.min(extra, 6) * 6;
    if (s > best) { best = s; bestExtra = extra; }
  }
  if (best === 0) return -Infinity;   // titles have nothing in common

  const cy = yearOf(c);

  // The Dead Poets Society rule. When THEIR title carries on past ours, the
  // shared opening is not evidence of anything on its own — "Dead" opens Dead
  // Poets Society, "Up" opens Up in the Air, "Heat" opens Heat Wave. Only the
  // year turns it into evidence, and that is the difference between those and
  // "Birdman" really being "Birdman or (The Unexpected Virtue of Ignorance)".
  //
  // It has to be the SAME year, not the year-either-side that a straight title
  // match is allowed. That leniency exists for region release drift, and on a
  // partial title it is just another way to be wrong: "Dead (1990)" would have
  // taken Dead Poets Society (1989) on a one-year pass.
  const risky = bestExtra >= 2 || (bestExtra >= 1 && wantWords === 1);
  if (risky && !(wantYear && cy && cy === wantYear)) return -Infinity;

  if (wantYear && cy) {
    const off = Math.abs(cy - wantYear);
    if (off === 0) best += YEAR_SAME;
    else if (off === 1) best += YEAR_NEAR;   // region release dates drift a year
    else best += YEAR_WRONG + Math.min(off, 10) * YEAR_WRONG_STEP;
  }
  // Popularity breaks ties between equally good matches. Nothing more.
  best += Math.min(Number(c.popularity) || 0, 50) / 100;
  return best;
}

export function pickMatch(results, wantTitle, wantYear) {
  if (!Array.isArray(results) || !results.length) return null;
  let bestHit = null, bestScore = -Infinity;
  for (const c of results) {
    const s = scoreCandidate(c, wantTitle, wantYear);
    if (s > bestScore) { bestScore = s; bestHit = c; }
  }
  return bestScore >= FLOOR ? bestHit : null;
}

async function tmdbSearch(apiKey, kind, query, year) {
  const url = new URL(`${BASE}/search/${kind}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', query);
  if (year) url.searchParams.set('year', String(year));
  let res;
  try { res = await fetch(url); } catch { return []; }
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return (data && data.results) || [];
}

export async function searchMovie(apiKey, title, year) {
  if (!apiKey) return null;
  let hit = pickMatch(await tmdbSearch(apiKey, 'movie', title, year), title, year);
  // A year in a filename can be the release year somewhere else, or simply
  // wrong. If the filtered search found nothing worth having, look again
  // unfiltered — the year still has to earn its keep in the scoring.
  if (!hit && year) hit = pickMatch(await tmdbSearch(apiKey, 'movie', title), title, year);
  if (!hit) return null;

  return {
    tmdb_id: hit.id,
    overview: hit.overview || null,
    poster: hit.poster_path ? POSTER + hit.poster_path : null,
    backdrop: hit.backdrop_path ? BACKDROP + hit.backdrop_path : null,
    rating: typeof hit.vote_average === 'number' ? hit.vote_average : null
  };
}

export async function searchTv(apiKey, title, year) {
  if (!apiKey) return null;
  let hit = pickMatch(await tmdbSearch(apiKey, 'tv', title, year), title, year);
  if (!hit && year) hit = pickMatch(await tmdbSearch(apiKey, 'tv', title), title, year);
  if (!hit) return null;

  return {
    tmdb_id: hit.id,
    overview: hit.overview || null,
    poster: hit.poster_path ? POSTER + hit.poster_path : null,
    backdrop: hit.backdrop_path ? BACKDROP + hit.backdrop_path : null,
    rating: typeof hit.vote_average === 'number' ? hit.vote_average : null,
    year: yearOf(hit)
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

// One detail fetch per movie (cheap: same endpoint as genres) to capture the
// franchise/collection, runtime, and any missing genres — powers the
// Collections tab and gives Live TV real durations. `col_checked` guards it so
// each movie is only fetched once.
export async function backfillMovieDetails(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) return 0;
  const rows = db.prepare(
    'SELECT id, tmdb_id, genres, runtime FROM movies WHERE tmdb_id IS NOT NULL AND (col_checked IS NULL OR col_checked = 0)'
  ).all();
  const upd = db.prepare(
    `UPDATE movies SET collection_id = ?, collection_name = ?, collection_poster = ?,
       runtime = COALESCE(runtime, ?), genres = CASE WHEN genres IS NULL OR genres = '' THEN ? ELSE genres END,
       companies = ?, col_checked = 1 WHERE id = ?`
  );
  let n = 0;
  for (const m of rows) {
    let d = null;
    try {
      const url = new URL(`${BASE}/movie/${m.tmdb_id}`);
      url.searchParams.set('api_key', apiKey);
      const r = await fetch(url);
      if (r.ok) d = await r.json();
    } catch {}
    if (!d) { db.prepare('UPDATE movies SET col_checked = 1 WHERE id = ?').run(m.id); continue; }
    const col = d.belongs_to_collection;
    upd.run(
      col ? col.id : null,
      col ? col.name : null,
      col && col.poster_path ? POSTER + col.poster_path : null,
      d.runtime || null,
      d.genres ? JSON.stringify(d.genres.map((g) => g.name)) : null,
      JSON.stringify((d.production_companies || []).map((c) => c.id)),
      m.id
    );
    n++;
    await new Promise((r) => setTimeout(r, 70));
  }
  if (n) log(`Collection/details backfilled for ${n} movie(s).`);
  return n;
}

// Backfill production companies for the existing catalog (movies enriched before
// we stored them). One detail fetch each; runs once in the background.
export async function backfillCompanies(db, apiKey, { log = () => {} } = {}) {
  if (!apiKey) return 0;
  const rows = db.prepare('SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND companies IS NULL').all();
  const upd = db.prepare('UPDATE movies SET companies = ? WHERE id = ?');
  let n = 0;
  for (const m of rows) {
    let d = null;
    try { const url = new URL(`${BASE}/movie/${m.tmdb_id}`); url.searchParams.set('api_key', apiKey); const r = await fetch(url); if (r.ok) d = await r.json(); } catch {}
    upd.run(JSON.stringify(d && d.production_companies ? d.production_companies.map((c) => c.id) : []), m.id);
    n++;
    await new Promise((r) => setTimeout(r, 60));
  }
  if (n) log(`Studios backfilled for ${n} movie(s).`);
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

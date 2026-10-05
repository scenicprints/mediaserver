// Re-check every movie's TMDB match with the current matcher.
//
// Enrichment only ever looks at titles with no match yet, so a match made by
// the old matcher (which took TMDB's most popular result and asked nothing
// further) was never looked at again. That is how "Lion" (2016) and "The Lion
// King" (2019) both ended up wearing the 1994 Lion King's poster, plot and
// cast: the scorer that would now refuse those matches had never been shown
// them.
//
// So, once, every matched movie is searched again and scored. A match is only
// replaced when the matcher is confident about a DIFFERENT film; when it finds
// nothing it would accept, the old match stays, because "not sure" is not
// evidence the old one was wrong. Every replacement is written to rematch_log
// with the row as it was, so any single change can be put back.
//
// Shows too, but only those whose folder says something the match can be
// checked against: a year ("Doctor Who (2005)") or a country ("The Office
// (UK)"). A show's stored `year` came from the match itself, so a show with
// neither has nothing independent to re-check, and is left alone.

import { searchMovie, searchTv } from './tmdb.js';
import { showSearchTitle } from './parse.js';

export function ensureRematchLog(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rematch_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL DEFAULT 'movie',
      movie_id  INTEGER NOT NULL,
      title     TEXT,
      year      INTEGER,
      old_tmdb  INTEGER,
      new_tmdb  INTEGER,
      old_row   TEXT,
      at        INTEGER NOT NULL
    );
  `);
}

/**
 * Returns { checked, changed: [{ id, title, year, from, to }] }. With
 * apply:false nothing is written. An OfflineError escapes, so an interrupted
 * pass is simply run again later; titles already fixed come back unchanged.
 */
export async function rematchMovies(db, apiKey, { apply = true, pauseMs = 150, log = () => {}, search = searchMovie } = {}) {
  if (!apiKey) return { checked: 0, changed: [] };
  ensureRematchLog(db);
  const rows = db.prepare('SELECT * FROM movies WHERE tmdb_id IS NOT NULL ORDER BY id').all();
  const update = db.prepare(
    `UPDATE movies SET tmdb_id = ?, overview = ?, poster = ?, backdrop = ?, rating = ?,
       genres = NULL, runtime = NULL, collection_id = NULL, collection_name = NULL,
       collection_poster = NULL, companies = NULL, col_checked = 0
     WHERE id = ?`
  );
  const record = db.prepare(
    'INSERT INTO rematch_log (movie_id, title, year, old_tmdb, new_tmdb, old_row, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const changed = [];
  let checked = 0;
  for (const row of rows) {
    const meta = await search(apiKey, row.title, row.year);
    checked++;
    if (meta && meta.tmdb_id && meta.tmdb_id !== row.tmdb_id) {
      changed.push({ id: row.id, title: row.title, year: row.year, from: row.tmdb_id, to: meta.tmdb_id });
      log(`  rematch: ${row.title} (${row.year ?? '?'}) TMDB ${row.tmdb_id} -> ${meta.tmdb_id}`);
      if (apply) {
        // Genres, runtime, collection and studios belonged to the old film;
        // cleared here, the normal backfills fill them in for the right one.
        record.run(row.id, row.title, row.year, row.tmdb_id, meta.tmdb_id, JSON.stringify(row), Date.now());
        update.run(meta.tmdb_id, meta.overview, meta.poster, meta.backdrop, meta.rating, row.id);
      }
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { checked, changed };
}

/**
 * The same pass for shows, over shows whose folder carries a year or country.
 * A replaced match also clears the episodes' titles, overviews and stills
 * (they were the wrong show's) so enrichEpisodes fills them in again, and the
 * genres, which backfillGenres refills. `movie_id` in the log holds the show id.
 */
export async function rematchShows(db, apiKey, { apply = true, pauseMs = 150, log = () => {}, search = searchTv } = {}) {
  if (!apiKey) return { checked: 0, changed: [] };
  ensureRematchLog(db);
  const rows = db.prepare(
    'SELECT * FROM shows WHERE tmdb_id IS NOT NULL AND (folder_year IS NOT NULL OR folder_country IS NOT NULL) ORDER BY id'
  ).all();
  const update = db.prepare(
    'UPDATE shows SET tmdb_id = ?, overview = ?, poster = ?, backdrop = ?, rating = ?, year = ?, genres = NULL WHERE id = ?'
  );
  const clearEpisodes = db.prepare('UPDATE episodes SET title = NULL, overview = NULL, still = NULL WHERE show_id = ?');
  const record = db.prepare(
    "INSERT INTO rematch_log (kind, movie_id, title, year, old_tmdb, new_tmdb, old_row, at) VALUES ('show', ?, ?, ?, ?, ?, ?, ?)"
  );

  const changed = [];
  let checked = 0;
  for (const row of rows) {
    const meta = await search(apiKey, showSearchTitle(row.title), row.folder_year, row.folder_country);
    checked++;
    if (meta && meta.tmdb_id && meta.tmdb_id !== row.tmdb_id) {
      changed.push({ id: row.id, title: row.title, year: row.folder_year, from: row.tmdb_id, to: meta.tmdb_id });
      log(`  rematch: show ${row.title}${row.folder_year ? ` (${row.folder_year})` : ''} TMDB ${row.tmdb_id} -> ${meta.tmdb_id}`);
      if (apply) {
        record.run(row.id, row.title, row.folder_year, row.tmdb_id, meta.tmdb_id, JSON.stringify(row), Date.now());
        update.run(meta.tmdb_id, meta.overview, meta.poster, meta.backdrop, meta.rating, meta.year, row.id);
        clearEpisodes.run(row.id);
      }
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { checked, changed };
}

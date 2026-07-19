import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function tableCols(db, name) {
  try {
    return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');

  // The folders the user points us at (preserved across upgrades).
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'movie',
      name TEXT
    );
  `);

  // Migration: the old schema stored one row per FILE (it had a 'path' column).
  // The new schema is one logical movie + many files. Files on disk are the
  // source of truth, so we drop the old movie data and let a rescan rebuild it;
  // the user's libraries are untouched.
  if (tableCols(db, 'movies').includes('path')) {
    db.exec('DROP TABLE IF EXISTS movies;');
    db.exec('DROP TABLE IF EXISTS movie_files;');
  }

  // A logical movie: one poster/metadata/watch-state, keyed by title+year.
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key      TEXT UNIQUE NOT NULL,
      title          TEXT NOT NULL,
      year           INTEGER,
      tmdb_id        INTEGER,
      overview       TEXT,
      poster         TEXT,
      backdrop       TEXT,
      rating         REAL,
      genres         TEXT,
      runtime        INTEGER,
      duration       REAL,
      favorite       INTEGER DEFAULT 0,
      watched        INTEGER DEFAULT 0,
      resume_position REAL DEFAULT 0,
      last_played_at INTEGER,
      added_at       INTEGER
    );
  `);

  // A physical file (a specific quality/version) belonging to a movie.
  db.exec(`
    CREATE TABLE IF NOT EXISTS movie_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id   INTEGER NOT NULL,
      library_id INTEGER,
      path       TEXT UNIQUE NOT NULL,
      filename   TEXT NOT NULL,
      quality    TEXT,
      size       INTEGER,
      duration   REAL,
      added_at   INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_movie ON movie_files(movie_id);');

  // A logical TV show: one poster/metadata, keyed by normalized name.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key  TEXT UNIQUE NOT NULL,
      title      TEXT NOT NULL,
      year       INTEGER,
      tmdb_id    INTEGER,
      overview   TEXT,
      poster     TEXT,
      backdrop   TEXT,
      rating     REAL,
      library_id INTEGER,
      added_at   INTEGER
    );
  `);

  // Migrate the old file-per-row episodes table (had a 'path' column) to the
  // new logical episode + episode_files layout. Rebuilt from disk on rescan.
  if (tableCols(db, 'episodes').includes('path')) {
    db.exec('DROP TABLE IF EXISTS episodes;');
    db.exec('DROP TABLE IF EXISTS episode_files;');
  }

  // A logical episode: one per show+season+episode, holding metadata + watch state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id        INTEGER NOT NULL,
      season         INTEGER,
      episode        INTEGER,
      title          TEXT,
      overview       TEXT,
      still          TEXT,
      duration       REAL,
      resume_position REAL DEFAULT 0,
      watched        INTEGER DEFAULT 0,
      last_played_at INTEGER,
      added_at       INTEGER,
      UNIQUE(show_id, season, episode)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);');

  // A physical episode file (a specific quality/version).
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      library_id INTEGER,
      path       TEXT UNIQUE NOT NULL,
      filename   TEXT NOT NULL,
      quality    TEXT,
      size       INTEGER,
      added_at   INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_epfiles_episode ON episode_files(episode_id);');

  // Genres for browse categories (movies already have the column).
  const showCols = new Set(db.prepare('PRAGMA table_info(shows)').all().map((c) => c.name));
  if (!showCols.has('genres')) db.exec('ALTER TABLE shows ADD COLUMN genres TEXT');

  // TMDB franchise/collection grouping + a "details fetched" flag, so the
  // Collections tab can group owned movies without a live lookup per render.
  // `col_checked` = we've fetched movie details once (collection may be null).
  const movieCols = new Set(db.prepare('PRAGMA table_info(movies)').all().map((c) => c.name));
  if (!movieCols.has('collection_id')) db.exec('ALTER TABLE movies ADD COLUMN collection_id INTEGER');
  if (!movieCols.has('collection_name')) db.exec('ALTER TABLE movies ADD COLUMN collection_name TEXT');
  if (!movieCols.has('collection_poster')) db.exec('ALTER TABLE movies ADD COLUMN collection_poster TEXT');
  if (!movieCols.has('col_checked')) db.exec('ALTER TABLE movies ADD COLUMN col_checked INTEGER DEFAULT 0');
  // Production company ids (JSON array) → powers broad studio/franchise
  // "meta-collections" (Marvel, Disney, Star Wars, Pixar…).
  if (!movieCols.has('companies')) db.exec('ALTER TABLE movies ADD COLUMN companies TEXT');

  // Per-episode intro range (theme song), from audio-fingerprint detection at
  // import; `intro_checked` guards the (slow) analysis so it runs once.
  const epCols = new Set(db.prepare('PRAGMA table_info(episodes)').all().map((c) => c.name));
  if (!epCols.has('intro_start')) db.exec('ALTER TABLE episodes ADD COLUMN intro_start REAL');
  if (!epCols.has('intro_end')) db.exec('ALTER TABLE episodes ADD COLUMN intro_end REAL');
  if (!epCols.has('intro_checked')) db.exec('ALTER TABLE episodes ADD COLUMN intro_checked INTEGER DEFAULT 0');

  // Small key-value store for playback preferences that must survive across
  // browsers/devices (preferred version per title, caption delay per file+track,
  // last quality picked). The web client mirrors this in memory.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prefs (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ---- Multi-user: accounts, sessions, per-user settings & watch state ----
  // The server is now internet-facing with logins. Each account gets its own
  // watch state, playback prefs and OpenSubtitles login; the first account
  // created (via the app's baked-in invite code) becomes the admin.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_at    INTEGER
    );
  `);

  // Long-lived session tokens (a device stays logged in until it logs out).
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      created_at   INTEGER,
      last_used_at INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);');

  // Per-user settings that must stay server-side and private (e.g. each user's
  // own OpenSubtitles login, so subtitle downloads use their own quota).
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);

  // Per-user watch state (resume point / watched / favorite / last played),
  // replacing the global columns on movies/episodes so two people don't collide.
  // `duration` stays on the media rows — it's a property of the file, not the user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_state (
      user_id         INTEGER NOT NULL,
      kind            TEXT NOT NULL,            -- 'movie' | 'episode'
      item_id         INTEGER NOT NULL,
      resume_position REAL DEFAULT 0,
      watched         INTEGER DEFAULT 0,
      favorite        INTEGER DEFAULT 0,
      last_played_at  INTEGER,
      PRIMARY KEY (user_id, kind, item_id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_state(user_id);');

  // Per-user playback prefs (preferred version per title, caption delay per
  // file+track, last quality) — the per-user replacement for the global `prefs`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    );
  `);

  // ---- Client telemetry: the app's flight recorder ----
  // The TV apps run in other people's living rooms — when something breaks
  // there, this is the only way to see it. Every client batches events here
  // (errors, playback/buffer health, lag vitals, deep-link outcomes, device
  // info); admins read them in Settings ▸ Diagnostics. Ring-buffered by the
  // server on insert (row + age caps) so it can never grow unbounded.
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      user_id INTEGER,
      device  TEXT,
      type    TEXT NOT NULL,
      data    TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tele_ts ON telemetry(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tele_dev ON telemetry(device, id);');

  return db;
}

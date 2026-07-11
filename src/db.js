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

  return db;
}

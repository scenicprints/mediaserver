// `npm run rematch` — READ-ONLY: shows which movies the current matcher would
// move to a different TMDB film, without changing anything. The server applies
// the same pass by itself once (see runEnrichment in server.js); this is for
// looking before or after.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { rematchMovies, rematchShows } from './rematch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
const db = openDb(path.resolve(ROOT, config.dbPath));

const { checked, changed } = await rematchMovies(db, config.tmdbApiKey, { apply: false, log: (m) => console.log(m) });
console.log(`Checked ${checked} matched movie(s); ${changed.length} would move to a different TMDB film.`);
const shows = await rematchShows(db, config.tmdbApiKey, { apply: false, log: (m) => console.log(m) });
console.log(`Checked ${shows.checked} show(s) with a year or country in their folder; ${shows.changed.length} would move to a different TMDB show.`);

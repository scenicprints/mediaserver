import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { enrichLibrary } from './tmdb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const db = openDb(path.resolve(ROOT, config.dbPath));

const updated = await enrichLibrary(db, config.tmdbApiKey, { log: (m) => console.log(m) });
console.log(`TMDB enrichment: ${updated} movie(s) updated.`);

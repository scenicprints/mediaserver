import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedLibraries, scanLibraries } from './scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^﻿/, ''));
const db = openDb(path.resolve(ROOT, config.dbPath));

const mediaRoots = (config.mediaRoots || []).map((r) => path.resolve(ROOT, r));
seedLibraries(db, mediaRoots);
const result = await scanLibraries(db);
console.log(`Scan complete: ${result.added} new file(s), ${result.seen} video file(s) seen.`);

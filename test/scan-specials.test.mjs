// The scan itself, over a library laid out the way the pool is.
//
// The parser tests pin filenames. This one runs the real scanLibraries against
// real folders and a real database, because the thing that was broken was not
// "parseEpisode returns null" — it was 22 files that existed, played fine, and
// appeared nowhere in the app. The measure of the fix is rows in
// episode_files, so that is what is counted here.
//
// It also holds the other half: a rescan must not shuffle the episodes already
// indexed. The folders below include the shapes that a looser parser would
// most plausibly re-bucket — a show named 24, a film-shaped four-digit name,
// specials sitting beside a real season.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { scanLibraries } from '../src/scan.js';
import { ensureSchema } from '../optimizer/engine.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-'));
const TV = path.join(dir, 'TV Shows');

function put(rel) {
  const full = path.join(TV, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
}

// Season 0 specials in a bare "00" folder, with no episode number in sight.
put("Impractical Jokers/00/Impractical Jokers - Special 10 - Impractical Jokers' Joker Bowl The Pros Weigh In.mkv");
put('Impractical Jokers/00/Impractical Jokers - Special 36 - Impractical Jokers The Movie.mp4');
put('Impractical Jokers/01/Impractical Jokers - 1x01 - Public Transportation.mkv');

// A bare SSEE filename next to siblings that always parsed.
put('What If.!/01/0106.mp4');
put('What If.!/01/What If… - 1x01 - What If Captain Carter Were the First Avenger.mkv');

// Bare numeric season folders, which is how the whole library is laid out.
put('Rick and Morty/02/Rick and Morty - 2x01 - A Rickle in Time.mkv');
put('Rick and Morty/02/07 - Big Trouble in Little Sanchez.mkv');

// A show whose NAME is a number, to prove it is not read as a season.
put('24/Season 2/05 - Day 2 5.00pm.mkv');

// Things that are not episodes and must stay out.
put('Some Show/extras/behind the scenes.mkv');
put('Some Show/Season 1/Some Show - S01E01 - Pilot.mkv');

const db = openDb(path.join(dir, 'test.db'));
// scanLibraries prunes media_info at the end of every scan, but that table
// belongs to the optimizer and openDb does not create it — so the optimizer's
// own schema has to be in place before a scan will run.
ensureSchema(db);
db.prepare('INSERT INTO libraries (path, type, name) VALUES (?, ?, ?)').run(TV, 'tv', 'TV Shows');

const rows = () => db.prepare(`
  SELECT s.title AS show, e.season, e.episode, f.filename
  FROM episode_files f JOIN episodes e ON e.id = f.episode_id JOIN shows s ON s.id = e.show_id
  ORDER BY s.title, e.season, e.episode`).all();

test('setup: scan the library', async () => {
  const { added } = await scanLibraries(db);
  assert.ok(added > 0, 'nothing was scanned');
});

test('the specials land in season 0 of the right show', () => {
  const specials = rows().filter((r) => r.show === 'Impractical Jokers' && r.season === 0);
  assert.deepEqual(specials.map((r) => r.episode), [10, 36]);
});

test('the bare SSEE file lands beside its siblings', () => {
  const whatIf = rows().filter((r) => r.show.startsWith('What If'));
  assert.deepEqual(whatIf.map((r) => `S${r.season}E${r.episode}`), ['S1E1', 'S1E6']);
});

test('a bare numeric folder is a season', () => {
  const rm = rows().filter((r) => r.show === 'Rick and Morty');
  assert.deepEqual(rm.map((r) => `S${r.season}E${r.episode}`), ['S2E1', 'S2E7']);
});

test('the show called 24 is a show, not season 24', () => {
  const twentyFour = rows().filter((r) => r.show === '24');
  assert.deepEqual(twentyFour.map((r) => `S${r.season}E${r.episode}`), ['S2E5']);
});

test('a file with no episode in its name is still skipped', () => {
  assert.ok(!rows().some((r) => r.filename === 'behind the scenes.mkv'));
});

test('a rescan adds nothing and moves nothing', () => {
  // The real fear: a looser parser re-buckets an episode on the next scan, the
  // file lands on a new logical episode row, and the watch state and resume
  // point stay behind on the old one with nothing to say it happened.
  const before = JSON.stringify(rows());
  return scanLibraries(db).then(({ added }) => {
    assert.equal(added, 0, 'a rescan re-added files it had already indexed');
    assert.equal(JSON.stringify(rows()), before, 'an episode moved on rescan');
  });
});

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

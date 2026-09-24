// Episodes the parser could not see, and the ones it must keep seeing.
//
// Two shapes went missing when the library moved into the pool:
//
//   P:\TV Shows\Impractical Jokers\00\Impractical Jokers - Special 10 - ....mkv
//   P:\TV Shows\What If.!\01\0106.mp4
//
// "00" was not a season folder, "Special 10" was not an episode, and the bare
// number rule could not reach "0106" — it takes "010", demands a non-digit,
// finds "6", and every backtrack fails the same way. Twenty-two files, indexed
// nowhere.
//
// The other half of this file matters more than the first. A parser that gets
// LOOSER can re-bucket the 20,622 episodes already on the shelf, and moving a
// watched episode to the wrong season is worse than the twenty-two it rescues.
// So every rule added here is tried after the ones that already worked, and
// these tests pin both directions: the files that must now parse, and the ones
// that must still parse exactly as before — or still not parse at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode } from '../src/parse.js';

// ---- The files that were invisible ----

test('a bare "00" folder is the specials season', () => {
  assert.deepEqual(
    parseEpisode("Impractical Jokers - Special 10 - Impractical Jokers' Joker Bowl The Pros Weigh In.mkv",
      ['Impractical Jokers', '00']),
    { season: 0, episode: 10 }
  );
  assert.deepEqual(
    parseEpisode('Impractical Jokers - Special 36 - Impractical Jokers The Movie.mp4',
      ['Impractical Jokers', '00']),
    { season: 0, episode: 36 }
  );
});

test('"Special NN" is season 0 even with no folder to go on', () => {
  assert.deepEqual(parseEpisode('Some Show - Special 3.mkv', ['Some Show']),
    { season: 0, episode: 3 });
});

test('a "Specials" folder is season 0 too', () => {
  assert.deepEqual(parseEpisode('03 - Behind the Scenes.mkv', ['Some Show', 'Specials']),
    { season: 0, episode: 3 });
});

test('a bare SSEE filename reads as season+episode', () => {
  assert.deepEqual(parseEpisode('0106.mp4', ['What If.!', '01']), { season: 1, episode: 6 });
  assert.deepEqual(parseEpisode('0106 - The Title.mkv', ['What If.!', '01']), { season: 1, episode: 6 });
});

test('its siblings in that folder parse the way they always did', () => {
  assert.deepEqual(
    parseEpisode('What If… - 1x01 - What If Captain Carter Were the First Avenger.mkv', ['What If.!', '01']),
    { season: 1, episode: 1 }
  );
});

test('bare numeric season folders reach filenames with no pattern of their own', () => {
  assert.deepEqual(parseEpisode('07 - The One With The Title.mkv', ['Friends', '03']),
    { season: 3, episode: 7 });
  assert.deepEqual(parseEpisode('Rick and Morty - E05.mkv', ['Rick and Morty', '02']),
    { season: 2, episode: 5 });
});

// ---- The things a four-digit rule must not swallow ----

test('a film called 2012 is not an episode', () => {
  assert.equal(parseEpisode('2012 (2009).mkv', []), null);
  assert.equal(parseEpisode('2012 (2009).mkv', ['Movies']), null);
  // Even inside a season folder: 20 is not season 1, so the digits stay a year.
  assert.equal(parseEpisode('2012.mkv', ['Some Show', '01']), null);
});

test('an episode called 1917 stays ambiguous rather than becoming S19E17', () => {
  assert.equal(parseEpisode('1917.mkv', []), null);
  assert.equal(parseEpisode('1917.mkv', ['Some Show', '01']), null);
  assert.equal(parseEpisode('1917 (2019).mkv', ['Movies']), null);
});

// ---- The things a bare-number folder rule must not swallow ----

test('a show whose NAME is a number is not a season', () => {
  // P:\TV Shows\24\05 - Title.mkv — "24" is the show. Nothing sits above it,
  // so it is not read as a season folder and the file stays unparsed.
  assert.equal(parseEpisode('05 - Title.mkv', ['24']), null);
  // And with a real season folder below it, the season is the folder's.
  assert.deepEqual(parseEpisode('05 - Day 2 5.00pm.mkv', ['24', 'Season 2']),
    { season: 2, episode: 5 });
  assert.deepEqual(parseEpisode('05 - Day 2 5.00pm.mkv', ['24', '02']),
    { season: 2, episode: 5 });
});

// ---- Nothing that already parsed changes ----

test('an episode titled "... Special 2" is still its own episode', () => {
  assert.deepEqual(parseEpisode('07 - The Christmas Special 2.mkv', ['Some Show', 'Season 3']),
    { season: 3, episode: 7 });
  assert.deepEqual(parseEpisode('Some Show - S03E07 - The Christmas Special 2.mkv', []),
    { season: 3, episode: 7 });
});

test('"Special Delivery" is not a special', () => {
  assert.equal(parseEpisode('Some Show - Special Delivery.mkv', ['Some Show']), null);
});

test('the patterns that always worked still win first', () => {
  assert.deepEqual(parseEpisode('Breaking Bad S01E02.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Breaking.Bad.s01.e02.720p.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('The Office 3x04.avi'), { season: 3, episode: 4 });
  assert.deepEqual(parseEpisode('02 - Title.mkv', ['Show', 'Season 5']),
    { season: 5, episode: 2 });
  // The bare-number rule is anchored at the start of the name and always was —
  // "Show - 02 - Title" has never parsed, and still does not.
  assert.equal(parseEpisode('Show - 02 - Title.mkv', ['Show', 'Season 5']), null);
  assert.deepEqual(parseEpisode('E07 - Title.mkv', ['Show', 'S04']), { season: 4, episode: 7 });
});

test('a file with nothing to go on is still skipped', () => {
  assert.equal(parseEpisode('movie.mkv', []), null);
  assert.equal(parseEpisode('trailer.mp4', ['Some Show']), null);
});

// ---- The invariant the whole change rests on ----

// The parser as it stood before any of this, copied verbatim from the commit
// this branch started at. Kept here rather than imported, because the point is
// to compare against a FROZEN parser: the day someone edits parse.js in a way
// that moves an episode, this has to be the thing that does not move with it.
function oldSeasonFromSegments(segs) {
  for (const s of segs) {
    const m = s.match(/season\s*(\d{1,2})/i) || s.match(/^s(\d{1,2})$/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
function oldParseEpisode(filename, segs = []) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  let m = base.match(/S(\d{1,2})[\s._-]*E(\d{1,3})/i);
  if (m) return { season: +m[1], episode: +m[2] };

  m = base.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?:[^0-9]|$)/i);
  if (m) return { season: +m[1], episode: +m[2] };

  const seasonHint = oldSeasonFromSegments(segs);
  if (seasonHint != null) {
    m = base.match(/(?:^|[^a-z0-9])E(\d{1,3})(?:[^0-9]|$)/i);
    if (m) return { season: seasonHint, episode: +m[1] };
    m = base.match(/^(\d{1,3})(?:\D|$)/); // "02 - Title"
    if (m) return { season: seasonHint, episode: +m[1] };
  }
  return null;
}

const NAMES = [
  'Breaking Bad S01E02.mkv', 'Breaking.Bad.S01.E02.1080p.WEB-DL.mkv', 'show s1e2.avi',
  'The Office 3x04.avi', 'The.Office.US.3x04.HDTV.mkv', 'Show - 12x07 - Title.mkv',
  '02 - The Title.mkv', '2 - The Title.mkv', '107 - The Title.mkv', 'E07 - Title.mkv',
  '0106.mp4', '0106 - Title.mkv', '1206.mkv', '2012 (2009).mkv', '1917.mkv', '2001.mkv',
  'Show - Special 10 - Title.mkv', 'Show - Special 1.mkv', 'Special Delivery.mkv',
  '07 - The Christmas Special 2.mkv', 'Show - S02E03 - A Very Special Episode.mkv',
  'Impractical Jokers - Special 36 - Impractical Jokers The Movie.mp4',
  'What If… - 1x01 - What If Captain Carter Were the First Avenger.mkv',
  'pilot.mkv', 'trailer.mp4', 'Show (2015) - 1080p.mkv', 'Rick and Morty - E05.mkv',
  '24 - 2x05 - Day 2 5.00pm.mkv', '05 - Day 2 5.00pm.mkv', 'Episode 3.mkv', 'Part 2.mkv'
];
const SEGS = [
  [], ['Some Show'], ['24'], ['1883'], ['Some Show', 'Season 1'], ['Some Show', 'Season 12'],
  ['Some Show', 'S01'], ['Some Show', 'Specials'], ['Some Show', '00'], ['Some Show', '01'],
  ['Some Show', '02'], ['Some Show', '12'], ['Some Show', '19'], ['Some Show', '20'],
  ['24', 'Season 2'], ['24', '02'], ['01'], ['00'], ['Some Show', 'Season 1', 'Extras'],
  ['TV', 'Some Show', '03']
];

test('nothing that already parsed parses differently', () => {
  // 20,622 episodes are already indexed, and a looser parser that re-buckets
  // one of them is worse than the 22 it rescues: the file moves to another
  // season, its watch state and resume point stay behind on the old row, and
  // nothing reports that it happened. So every new rule is only ever allowed
  // to turn a null into an answer.
  let rescued = 0;
  for (const name of NAMES) {
    for (const segs of SEGS) {
      const before = oldParseEpisode(name, segs);
      const after = parseEpisode(name, segs);
      if (before === null) { if (after !== null) rescued++; continue; }
      assert.deepEqual(after, before, `${segs.join('/')}/${name} moved`);
    }
  }
  // And it is actually rescuing things, rather than passing by doing nothing.
  assert.ok(rescued > 20, `expected new matches, got ${rescued}`);
});

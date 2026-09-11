// A real-sized library, and a budget for building the browse rows against it.
//
// This fixture exists because of a specific failure. The row pool shipped to the
// Apple TV in build 72 called `genreList` — a property that parses the genres
// JSON on every read — from inside each row's filter, and matched the keyword
// moods by compiling a fresh regex per title. At the owner's library size that
// came to 86,358 JSON parses and 8,004 regex compiles for ONE page build, which
// runs from a SwiftUI body, which runs again on every press of the remote. The
// app locked up.
//
// Nothing caught it, because every test and every preview ran against a handful
// of sample titles, where a hundred-fold multiple of nothing is still nothing.
// The cost is a function of library size, so the fixture has to be library-sized.
//
// What is actually asserted is WORK PER TITLE, not wall time alone — wall time
// on a CI runner is noisy, and the counts are what carry across to Swift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const MOVIES = 1700, SHOWS = 350;
const ITEMS = MOVIES + SHOWS;

// TMDB's real genre vocabulary, both the film and the television lists.
const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music', 'Mystery', 'News', 'Reality',
  'Romance', 'Science Fiction', 'Soap', 'Talk', 'Thriller', 'TV Movie', 'War', 'Western',
  'Action & Adventure', 'Sci-Fi & Fantasy', 'War & Politics'];
// Long enough to cost what a real synopsis costs to scan.
const OVERVIEW = 'A synopsis of the length TMDB actually returns, a couple of hundred '
  + 'characters of plot so that scanning it for keywords costs what it really costs, '
  + 'including the words space and heist so some rows match and some do not.';

function library() {
  let r = 20260911;
  const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  const g = () => JSON.stringify([GENRES[Math.floor(rnd() * GENRES.length)],
    GENRES[Math.floor(rnd() * GENRES.length)]]);
  const movies = Array.from({ length: MOVIES }, (_, i) => ({
    id: i + 1, title: `Test Film ${i}`, year: 1930 + Math.floor(rnd() * 96),
    rating: 3 + rnd() * 7, genres: g(), overview: OVERVIEW,
    runtime: 70 + Math.floor(rnd() * 110), watched: rnd() < 0.3 ? 1 : 0,
    favorite: rnd() < 0.1 ? 1 : 0, qualities: rnd() < 0.2 ? '4K,1080p' : '1080p',
    versions: 1, added_at: Date.now() - Math.floor(rnd() * 3e10),
    last_played_at: rnd() < 0.2 ? Date.now() - Math.floor(rnd() * 1e10) : null,
    poster: '', backdrop: ''
  }));
  const shows = Array.from({ length: SHOWS }, (_, i) => ({
    id: i + 1, title: `Test Series ${i}`, year: 1985 + Math.floor(rnd() * 41),
    rating: 4 + rnd() * 6, genres: g(), overview: OVERVIEW,
    episodes: 6 + Math.floor(rnd() * 120), unwatched: Math.floor(rnd() * 20),
    added_at: Date.now() - Math.floor(rnd() * 3e10),
    last_played_at: rnd() < 0.2 ? Date.now() : null, poster: '', backdrop: ''
  }));
  const collections = Array.from({ length: 90 }, (_, i) => ({
    id: i, name: `Franchise ${i} Collection`, count: 4,
    ids: [i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 4]
  }));
  return { movies, shows, collections };
}

// Lift the row builder out of the front end and run it with counted stand-ins
// for the two things that got expensive.
function harness() {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const from = src.indexOf('const _genreCache');
  const to = src.indexOf('function renderView()');
  assert.ok(from > 0 && to > from, 'could not find the row block in public/app.js');

  const counts = { parses: 0, regexes: 0, cards: 0 };
  const ctx = {
    TV_MODE: false, ROW_N: 24, movies: [], shows: [], collections: [],
    Date, Math, Set, Map, WeakMap, Object, Array, String, Number, console,
    JSON: { parse: (s) => { counts.parses++; return JSON.parse(s); }, stringify: JSON.stringify },
    hashStr: (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; },
    buildMediaCard: (x, kind) => { counts.cards++; return { x, kind }; },
    byRating: (a, b) => (b.rating || 0) - (a.rating || 0),
    __regex: () => { counts.regexes++; }
  };
  vm.createContext(ctx);
  const NL = String.fromCharCode(10);
  const exports = ['pairsFor', 'candidateRows', 'chooseRows', 'seasonalRows', 'materializeRow', 'rng']
    .map((n) => `globalThis.${n} = ${n};`).join(NL);
  // Count regex work inside the sandbox — its RegExp is not this file's.
  const countRegex = 'globalThis.__t = RegExp.prototype.test;'
    + 'RegExp.prototype.test = function (s) { __regex(); return __t.call(this, s); };';
  vm.runInContext(src.slice(from, to) + NL + exports + NL + countRegex, ctx);
  return { ctx, counts };
}

function buildPage(ctx, counts, view) {
  counts.parses = 0; counts.regexes = 0; counts.cards = 0;
  const t0 = process.hrtime.bigint();
  const pool = ctx.pairsFor(view);
  const rows = [...ctx.seasonalRows(pool), ...ctx.chooseRows(view, pool, ctx.rng(4242))]
    .map((r) => ctx.materializeRow(r));
  return { rows, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('a page of rows costs a bounded amount of work per title', () => {
  const { ctx, counts } = harness();
  const lib = library();
  ctx.movies = lib.movies; ctx.shows = lib.shows; ctx.collections = lib.collections;

  for (const view of ['home', 'movies', 'tv']) {
    const { rows, ms } = buildPage(ctx, counts, view);
    assert.ok(rows.length >= 10, `${view}: expected a full page, got ${rows.length} rows`);

    // Genres are parsed ONCE per title. The number that broke the Apple TV was
    // 44 parses per title; anything above a couple means a row is re-parsing
    // inside its filter again.
    const perTitle = counts.parses / ITEMS;
    assert.ok(perTitle <= 2,
      `${view}: ${counts.parses} genre parses for ${ITEMS} titles (${perTitle.toFixed(1)} each). `
      + 'Something in the row pool is parsing genres inside a filter instead of once per title.');

    // Keyword rows scan each title a bounded number of times. Every scan here is
    // an NSRegularExpression COMPILE in the tvOS port, which is what made this
    // fatal there rather than merely wasteful.
    const scansPerTitle = counts.regexes / ITEMS;
    assert.ok(scansPerTitle <= 8,
      `${view}: ${counts.regexes} keyword scans for ${ITEMS} titles (${scansPerTitle.toFixed(1)} each).`);

    // Only the rows that made the page build cards.
    assert.ok(counts.cards <= rows.length * 24,
      `${view}: built ${counts.cards} cards for ${rows.length} rows — cards are being built for rows that were never shown.`);

    // Wall time is the blunt backstop. Generous, because CI runners are noisy;
    // it is there to catch an order-of-magnitude regression, not a slow day.
    assert.ok(ms < 400, `${view}: building the page took ${ms.toFixed(0)}ms for ${ITEMS} titles`);
  }
});

test('the library can double without the work per title changing', () => {
  // Cost has to be linear in the library. A row that filters inside a filter is
  // quadratic, looks fine on sample data, and is exactly the shape of the bug.
  const { ctx, counts } = harness();
  const small = library();
  ctx.movies = small.movies; ctx.shows = small.shows; ctx.collections = small.collections;
  const a = buildPage(ctx, counts, 'home');
  const aParses = counts.parses, aRegexes = counts.regexes;

  ctx.movies = small.movies.concat(small.movies.map((m) => ({ ...m, id: m.id + 100000 })));
  ctx.shows = small.shows.concat(small.shows.map((s) => ({ ...s, id: s.id + 100000 })));
  const b = buildPage(ctx, counts, 'home');

  const parseRatio = counts.parses / Math.max(aParses, 1);
  const regexRatio = counts.regexes / Math.max(aRegexes, 1);
  assert.ok(parseRatio < 2.6, `doubling the library multiplied genre parses by ${parseRatio.toFixed(1)}`);
  assert.ok(regexRatio < 2.6, `doubling the library multiplied keyword scans by ${regexRatio.toFixed(1)}`);
  assert.ok(a.rows.length >= 10 && b.rows.length >= 10);
});

test('the seasonal calendar does not scan the library more than once per theme', () => {
  const { ctx, counts } = harness();
  const lib = library();
  ctx.movies = lib.movies; ctx.shows = lib.shows; ctx.collections = lib.collections;
  counts.regexes = 0;
  const seasonal = ctx.seasonalRows(ctx.pairsFor('home'));
  // At most two rows run at once, each looking at each title at most twice
  // (title, then title+overview).
  assert.ok(seasonal.length <= 2, `${seasonal.length} seasonal rows — at most two should ever run`);
  assert.ok(counts.regexes <= ITEMS * 5,
    `seasonal matching scanned ${counts.regexes} times for ${ITEMS} titles`);
});

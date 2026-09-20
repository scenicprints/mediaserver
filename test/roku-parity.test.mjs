// The Roku must show exactly the rows and channels the Android TV app shows.
// The Android TV app runs public/app.js; the Roku gets its rows from
// src/roku.js, a port of the same functions run server-side. This lifts the
// real app.js code out (in TV mode) and runs both over the same library with
// the same seed, and they must agree row for row, card for card, channel for
// channel. If you change the row or channel logic in app.js, change roku.js too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { computeView, buildChannels } from '../src/roku.js';

const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
  'Family', 'Fantasy', 'Horror', 'Kids', 'Music', 'Mystery', 'Romance', 'Science Fiction',
  'Thriller', 'War', 'Western'];

function library() {
  let r = 20260919;
  const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  const g = () => JSON.stringify([GENRES[Math.floor(rnd() * GENRES.length)], GENRES[Math.floor(rnd() * GENRES.length)]]);
  const words = ['space', 'heist', 'christmas', 'football', 'mother', 'school', 'irish', 'haunted', 'president'];
  const movies = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1, title: `Film ${i} ${words[i % words.length]}`, year: 1950 + Math.floor(rnd() * 76),
    rating: 3 + rnd() * 7, genres: g(), overview: 'A story about ' + words[(i * 7) % words.length],
    runtime: 70 + Math.floor(rnd() * 110), watched: rnd() < 0.3 ? 1 : 0, duration: 6000,
    resume_position: rnd() < 0.1 ? 900 : 0,
    favorite: rnd() < 0.1 ? 1 : 0, qualities: rnd() < 0.2 ? '4K,1080p' : '1080p',
    versions: rnd() < 0.2 ? 2 : 1, added_at: Date.now() - Math.floor(rnd() * 3e9),
    last_played_at: rnd() < 0.2 ? Date.now() - Math.floor(rnd() * 1e10) : null,
    poster: '', backdrop: rnd() < 0.5 ? 'b' + i : ''
  }));
  const shows = Array.from({ length: 80 }, (_, i) => ({
    id: i + 1, title: `Series ${i}`, year: 1985 + Math.floor(rnd() * 41),
    rating: 4 + rnd() * 6, genres: g(), overview: 'Episodes of ' + words[i % words.length],
    episodes: 6 + Math.floor(rnd() * 60), unwatched: Math.floor(rnd() * 5),
    added_at: Date.now() - Math.floor(rnd() * 3e9),
    last_played_at: rnd() < 0.2 ? Date.now() : null, poster: '', backdrop: rnd() < 0.5 ? 's' + i : ''
  }));
  const collections = Array.from({ length: 30 }, (_, i) => ({
    id: i, name: `Franchise ${i} Collection`, count: 4, ids: [i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 4]
  }));
  const episodes = [];
  for (const s of shows.slice(0, 40)) {
    for (let e = 1; e <= 6; e++) {
      episodes.push({ epId: s.id * 100 + e, showId: s.id, season: 1, episode: e, epTitle: `Ep ${e}`, still: '',
        duration: 1200 + e * 60, showTitle: s.title, poster: '', backdrop: s.backdrop, overview: s.overview,
        genres: s.genres, year: s.year, rating: s.rating });
    }
  }
  return { movies, shows, collections, episodes };
}

// public/app.js, TV mode, with its own functions and nothing stubbed but the card builder.
// Arrays made in the sandbox carry its own Array.prototype, so copy them out
// with [...x] before a strict deepEqual or identical lists compare unequal.
function webApp(lib) {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const rowsFrom = src.indexOf('const _genreCache');
  const rowsTo = src.indexOf('function renderView()');
  const ltFrom = src.indexOf('const LT_EPOCH');
  const ltTo = src.indexOf('async function renderLiveTv()');
  assert.ok(rowsFrom > 0 && rowsTo > rowsFrom && ltFrom > 0 && ltTo > ltFrom, 'could not find the blocks in public/app.js');
  const ctx = {
    TV_MODE: true, ROW_N: 12, movies: lib.movies, shows: lib.shows, collections: lib.collections, ltEpisodes: lib.episodes,
    Date, Math, Set, Map, WeakMap, Object, Array, String, Number, JSON, console,
    buildMediaCard: (x, kind) => ({ id: x.id, kind }),
    byRating: (a, b) => (b.rating || 0) - (a.rating || 0)
  };
  vm.createContext(ctx);
  const NL = String.fromCharCode(10);
  const names = ['pairsFor', 'candidateRows', 'chooseRows', 'seasonalRows', 'materializeRow', 'rng', 'hashStr', 'buildChannels', 'ROW_QUOTA'];
  vm.runInContext(src.slice(rowsFrom, rowsTo) + NL + src.slice(ltFrom, ltTo) + NL
    + names.map((n) => `globalThis.${n} = ${n};`).join(NL), ctx);
  // The Live TV block declares its own `let ltEpisodes = []`; fill it the way
  // renderLiveTv does after fetching /api/livetv/episodes.
  ctx.__eps = lib.episodes;
  vm.runInContext('ltEpisodes = __eps;', ctx);
  return ctx;
}

test('the Roku gets the same rows, in the same order, as the Android TV app', () => {
  const lib = library();
  const web = webApp(lib);
  assert.deepEqual({ ...web.ROW_QUOTA }, { core: 3, mood: 3, discovery: 2, genre: 3, decade: 1 }, 'app.js TV quotas changed');
  for (const view of ['home', 'movies', 'tv']) {
    for (const seed of [1, 4242, 987654321]) {
      // app.js renderView(), minus the DOM.
      const P = web.pairsFor(view);
      const rand = web.rng((web.hashStr('rows:' + view) ^ seed) >>> 0);
      const pinned = [...web.seasonalRows(P), { group: 'core', name: 'Recently Added', items: P.slice(), sort: (a, b) => (b.x.added_at || 0) - (a.x.added_at || 0), min: 1 }];
      const seen = new Set();
      const webRows = [];
      for (const r of [...pinned, ...web.chooseRows(view, P, rand)]) {
        const key = r.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const m = web.materializeRow(r);
        webRows.push({ title: m.title, ids: [...m.cards].map((c) => c.kind + c.id) });
      }
      const roku = computeView(view, { movies: lib.movies, shows: lib.shows, continueItems: [], collections: lib.collections }, seed, new Date());
      const rokuRows = roku.rows.map((r) => ({ title: r.title, ids: r.cards.map((c) => c.type + c.id) }));
      assert.deepEqual(rokuRows, webRows, `${view} / seed ${seed}: the rows differ`);
    }
  }
});

test('the Roku gets the same Live TV channels and schedule as the Android TV app', () => {
  const lib = library();
  const web = webApp(lib);
  const webCh = web.buildChannels();
  const rokuCh = buildChannels(lib.movies, lib.episodes);
  assert.equal(rokuCh.length, webCh.length);
  for (let i = 0; i < webCh.length; i++) {
    assert.equal(rokuCh[i].name, webCh[i].name);
    assert.equal(rokuCh[i].number, webCh[i].number);
    assert.equal(rokuCh[i].total, webCh[i].total, `${webCh[i].name}: schedule length differs`);
    const ids = (c) => [...c.playlist].map((p) => p.kind + (p.kind === 'episode' ? p.ref.epId : p.ref.id));
    assert.deepEqual(ids(rokuCh[i]), ids(webCh[i]), `${webCh[i].name}: playlist differs`);
  }
});

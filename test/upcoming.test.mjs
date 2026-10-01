// "Releasing soon" follows the owner's rules to the letter, so pin them:
// the calendar month for movies (digital or disc, never cinema), the
// Sunday-to-Saturday week for episodes, and nothing that is already downloaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windows, moviesFrom, showsFrom, heroUpcoming } from '../src/upcoming.js';

const NOW = new Date(2026, 9, 14, 15); // Wednesday, Oct 14 2026

test('windows are the calendar month and the Sunday-to-Saturday week', () => {
  const w = windows(NOW);
  assert.deepEqual(w.month, ['2026-10-01', '2026-10-31']);
  assert.deepEqual(w.week, ['2026-10-11', '2026-10-17']);
  // A Sunday starts its own week.
  assert.deepEqual(windows(new Date(2026, 9, 18, 9)).week, ['2026-10-18', '2026-10-24']);
});

test('movies: the whole month of a digital or disc release; cinema never counts', () => {
  const w = windows(NOW);
  const got = moviesFrom([
    { id: 1, tmdbId: 11, title: 'Digital Late', digitalRelease: '2026-10-29T00:00:00Z', images: [{ coverType: 'fanart', remoteUrl: 'https://image.tmdb.org/t/p/original/a.jpg' }] },
    { id: 2, tmdbId: 12, title: 'Already Out', digitalRelease: '2026-10-02T00:00:00Z' },
    { id: 3, tmdbId: 13, title: 'Cinema Only', inCinemas: '2026-10-10T00:00:00Z', digitalRelease: '2026-12-20T00:00:00Z' },
    { id: 4, tmdbId: 14, title: 'Disc Only', physicalRelease: '2026-10-20T00:00:00Z' },
    { id: 5, tmdbId: 15, title: 'Downloaded', digitalRelease: '2026-10-05T00:00:00Z', hasFile: true },
    { id: 6, tmdbId: 16, title: 'Unmonitored', digitalRelease: '2026-10-05T00:00:00Z', monitored: false },
    { id: 7, tmdbId: 17, title: 'November', digitalRelease: '2026-11-01T00:00:00Z' }
  ], w);
  assert.deepEqual(got.map((m) => m.title), ['Already Out', 'Disc Only', 'Digital Late']);
  assert.equal(got[1].when, 'Disc release · Tue, Oct 20');
  // Past its date but not downloaded: still releasing soon.
  assert.equal(got[0].when, 'Digital release · Fri, Oct 2');
  // TMDB originals are resized for the hero; the cache rewrite handles the rest.
  assert.equal(got[2].backdrop, 'https://image.tmdb.org/t/p/w1280/a.jpg');
});

test('the date is the UTC day Radarr gave, never shifted into the day before', () => {
  const got = moviesFrom([{ id: 1, title: 'Edge', digitalRelease: '2026-10-01T00:00:00Z' }], windows(NOW));
  assert.equal(got[0].date, '2026-10-01');
});

test('episodes: this week only, one entry per show, library art and target when owned', () => {
  const w = windows(NOW);
  const series = { id: 9, title: 'Severance', tmdbId: 95396, images: [{ coverType: 'fanart', remoteUrl: 'https://artworks.thetvdb.com/x.jpg' }] };
  const eps = [
    { seriesId: 9, series, seasonNumber: 2, episodeNumber: 6, airDate: '2026-10-16', title: 'Six' },
    { seriesId: 9, series, seasonNumber: 2, episodeNumber: 5, airDate: '2026-10-12', title: 'Five' },
    { seriesId: 9, series, seasonNumber: 2, episodeNumber: 4, airDate: '2026-10-11', title: 'Four', hasFile: true },
    { seriesId: 9, series, seasonNumber: 2, episodeNumber: 7, airDate: '2026-10-18', title: 'Next week' },
    { seriesId: 3, series: { id: 3, title: 'Solo Show' }, seasonNumber: 1, episodeNumber: 1, airDate: '2026-10-15', title: 'TBA' }
  ];
  const lib = [{ id: 42, tmdb_id: 95396, title: 'Severance', poster: 'p.jpg', backdrop: 'b.jpg' }];
  const got = showsFrom(eps, w, lib);
  assert.deepEqual(got.map((s) => s.title), ['Severance', 'Solo Show']);
  assert.equal(got[0].when, 'S2 E5 + 1 more · from Mon, Oct 12');
  assert.equal(got[0].showId, 42);
  assert.equal(got[0].backdrop, 'b.jpg');
  assert.equal(got[1].when, 'S1 E1 · Thu, Oct 15', 'a TBA title is left out');
  assert.equal(got[1].showId, null);
});

test('the hero takes at most three, soonest first, and only titles with art', () => {
  const m = (title, date, art = 'x.jpg') => ({ title, date, backdrop: art, poster: null });
  const data = { movies: [m('M3', '2026-10-30'), m('M1', '2026-10-02'), m('NoArt', '2026-10-01', null)], shows: [m('S1', '2026-10-12'), m('S2', '2026-10-15')] };
  assert.deepEqual(heroUpcoming(data, 'home').map((x) => x.title), ['M1', 'S1', 'S2']);
  assert.deepEqual(heroUpcoming(data, 'movies').map((x) => x.title), ['M1', 'M3']);
  assert.deepEqual(heroUpcoming(data, 'tv').map((x) => x.title), ['S1', 'S2']);
});

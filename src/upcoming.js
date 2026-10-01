// "Releasing soon": what Radarr and Sonarr are waiting on, for the hero.
//
// The owner's rules, exactly:
//   - Only titles already in Radarr/Sonarr. Nothing is suggested from outside.
//   - A movie shows for the whole CALENDAR month of its digital or physical
//     (disc) release, whichever falls in this month. Cinema dates never count,
//     because a film in cinemas can't be downloaded.
//   - An episode shows for the calendar week (Sunday to Saturday) it airs.
//   - It stays up, still "releasing soon", after its date until the file is
//     downloaded; then it simply becomes a normal title in the library.
// The hero shows these without a Play button, since there is nothing to play.
//
// Radarr and Sonarr run on the Dell, so this works with the internet down.
// Every label is built here, once, so the web, Apple TV and Roku all say the
// same thing.

import { radarrEnabled, sonarrEnabled, arrGet } from './arr.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "2026-10-20T00:00:00Z" -> "2026-10-20". Radarr dates are UTC midnights;
// converting them to local time would move every release back a day.
const dayOf = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const labelDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return `${DAYS[dt.getDay()]}, ${MONTHS[m - 1]} ${d}`;
};

/** This calendar month and this Sunday-to-Saturday week, as YYYY-MM-DD bounds (inclusive). */
export function windows(now = new Date()) {
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1, 12);
  const m1 = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
  const w0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 12);
  const w1 = new Date(w0.getFullYear(), w0.getMonth(), w0.getDate() + 6, 12);
  return { month: [ymd(m0), ymd(m1)], week: [ymd(w0), ymd(w1)] };
}

const inRange = (day, [a, b]) => !!day && day >= a && day <= b;

// TMDB "original" images are huge; the hero wants a backdrop-sized one.
function sized(url, size) {
  const s = String(url || '');
  return s.startsWith('https://image.tmdb.org/t/p/') ? s.replace(/\/t\/p\/[^/]+\//, `/t/p/${size}/`) : (s || null);
}
function image(images, type) {
  const i = (images || []).find((x) => x.coverType === type);
  return i ? (i.remoteUrl || i.url || null) : null;
}

/** Radarr calendar entries -> releasing-soon movies. Pure, for testing. */
export function moviesFrom(list, { month }) {
  const out = [];
  for (const m of list || []) {
    if (!m || m.hasFile || m.monitored === false) continue;
    const digital = dayOf(m.digitalRelease), physical = dayOf(m.physicalRelease);
    let day = null, how = null;
    if (inRange(digital, month)) { day = digital; how = 'Digital release'; }
    else if (inRange(physical, month)) { day = physical; how = 'Disc release'; }
    if (!day) continue;
    out.push({
      upcoming: true, kind: 'movie', key: `up:movie:${m.tmdbId || m.id}`, tmdbId: m.tmdbId || null,
      title: m.title, year: m.year || null, overview: m.overview || '',
      rating: (m.ratings && m.ratings.tmdb && m.ratings.tmdb.value) || null,
      poster: sized(image(m.images, 'poster'), 'w500'), backdrop: sized(image(m.images, 'fanart'), 'w1280'),
      date: day, when: `${how} · ${labelDay(day)}`, showId: null
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Sonarr calendar episodes -> one releasing-soon entry per show. Art and the
 * More Info target come from the library's own copy of the show when there is
 * one (`library`: [{ id, tmdb_id, title, poster, backdrop }]).
 */
export function showsFrom(episodes, { week }, library = []) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byTmdb = new Map(library.filter((s) => s.tmdb_id).map((s) => [s.tmdb_id, s]));
  const byTitle = new Map(library.map((s) => [norm(s.title), s]));
  const groups = new Map();
  for (const e of episodes || []) {
    if (!e || e.hasFile || e.monitored === false) continue;
    const series = e.series || {};
    if (series.monitored === false) continue;
    const day = dayOf(e.airDate) || dayOf(e.airDateUtc);
    if (!inRange(day, week)) continue;
    const id = e.seriesId || series.id;
    if (!groups.has(id)) groups.set(id, { series, eps: [] });
    groups.get(id).eps.push({ ...e, day });
  }
  const out = [];
  for (const [id, { series, eps }] of groups) {
    eps.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.seasonNumber - b.seasonNumber) || (a.episodeNumber - b.episodeNumber)));
    const first = eps[0];
    const lib = (series.tmdbId && byTmdb.get(series.tmdbId)) || byTitle.get(norm(series.title)) || null;
    const code = `S${first.seasonNumber} E${first.episodeNumber}`;
    const when = eps.length === 1
      ? `${code}${first.title && !/^TBA$/i.test(first.title) ? ` “${first.title}”` : ''} · ${labelDay(first.day)}`
      : `${code} + ${eps.length - 1} more · from ${labelDay(first.day)}`;
    out.push({
      upcoming: true, kind: 'show', key: `up:show:${id}`, tmdbId: series.tmdbId || null,
      title: series.title || (lib && lib.title) || '', year: series.year || null,
      overview: first.overview || series.overview || '',
      rating: (series.ratings && series.ratings.value) || null,
      poster: (lib && lib.poster) || sized(image(series.images, 'poster'), 'w500'),
      backdrop: (lib && lib.backdrop) || sized(image(series.images, 'fanart'), 'w1280'),
      date: first.day, when, showId: lib ? lib.id : null
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Radarr/Sonarr are asked at most every few minutes; the hero is drawn far
// more often than that, and both are on the same box streaming video.
let cache = { at: 0, key: '', value: null };
const TTL = 5 * 60e3;

/** { movies, shows } releasing soon. Never throws: a service that is down just contributes nothing. */
export async function upcoming(config, library = [], now = new Date()) {
  const win = windows(now);
  const key = win.month.join() + win.week.join();
  if (cache.value && cache.key === key && Date.now() - cache.at < TTL) return withLibrary(cache.value, library, win);

  // Both at once, three seconds each: this sits in front of the home screen.
  // Radarr's calendar returns a movie if ANY of its dates (cinema too) falls in
  // the range; moviesFrom keeps only digital/physical ones. A service that is
  // down or slow contributes nothing rather than an error.
  const ask = (cfg, on, q) => (on ? arrGet(cfg, q, 3000).then((r) => (Array.isArray(r) ? r : [])).catch(() => null) : Promise.resolve([]));
  const [movies, episodes] = await Promise.all([
    ask(config.radarr, radarrEnabled(config.radarr), `/api/v3/calendar?start=${win.month[0]}&end=${win.month[1]}T23:59:59Z&unmonitored=false`),
    ask(config.sonarr, sonarrEnabled(config.sonarr), `/api/v3/calendar?start=${win.week[0]}&end=${win.week[1]}T23:59:59Z&unmonitored=false&includeSeries=true`)
  ]);
  const value = { movies: movies || [], episodes: episodes || [] };
  // A failed answer is not cached, so the next screen asks again.
  if (movies && episodes) cache = { at: Date.now(), key, value };
  return withLibrary(value, library, win);
}

function withLibrary({ movies, episodes }, library, win) {
  return { movies: moviesFrom(movies, win), shows: showsFrom(episodes, win, library) };
}

/**
 * What one hero gets. Home takes both kinds, Movies only movies, TV only shows;
 * soonest first, at most three, and only titles with art to put behind them.
 * Every client puts these first and fills the rest of its six slides with its
 * usual weekly pick, so the regular slides are unchanged.
 */
export const HERO_UPCOMING_MAX = 3;
export function heroUpcoming({ movies, shows }, view) {
  const list = view === 'movies' ? movies : view === 'tv' ? shows : [...movies, ...shows];
  return list
    .filter((x) => x.backdrop || x.poster)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, HERO_UPCOMING_MAX);
}

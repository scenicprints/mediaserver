// Streaming services: merge each service's popular catalog into the browse
// experience. We NEVER proxy the video — the services are DRM-locked and their
// ToS forbid it, and there's no consumer API to pull "your" account — so a
// streaming title carries a provider badge and deep-links out to the service.
//
// Data comes from TMDB (the same key the rest of the app uses): /discover by
// `with_watch_providers` gives the popular titles on a service, and a per-title
// /watch/providers call gives the deep-link. The catalog is cached in memory and
// refreshed periodically; which services are enabled is a per-user preference.
//
// Admin-only for now (gated in server.js): the owner tests it, then ships wider.

const BASE = 'https://api.themoviedb.org/3';
const POSTER = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280';

// Curated major US services: slug, display name, TMDB provider id, brand colour.
// Provider ids verified against /watch/providers/movie?watch_region=US.
export const PROVIDERS = [
  { id: 'netflix',   name: 'Netflix',     tmdb: 8,    color: '#e50914' },
  { id: 'prime',     name: 'Prime Video', tmdb: 9,    color: '#1399ff' },
  { id: 'disney',    name: 'Disney+',     tmdb: 337,  color: '#0a63e6' },
  { id: 'hulu',      name: 'Hulu',        tmdb: 15,   color: '#1ce783' },
  { id: 'max',       name: 'Max',         tmdb: 1899, color: '#a05cff' },
  { id: 'appletv',   name: 'Apple TV+',   tmdb: 350,  color: '#7d7d7d' },
  { id: 'paramount', name: 'Paramount+',  tmdb: 531,  color: '#0064ff' },
  { id: 'peacock',   name: 'Peacock',     tmdb: 386,  color: '#00b7eb' }
];
const BY_SLUG = new Map(PROVIDERS.map((p) => [p.id, p]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdbGet(apiKey, path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// provider slug -> array of normalized titles, per kind. Rebuilt on refresh.
let catalog = { movie: new Map(), tv: new Map() };
let genreMap = {};       // TMDB genre id -> name
let lastRefresh = 0;
let refreshing = false;

function norm(kind, r, slug) {
  const date = r.release_date || r.first_air_date || '';
  return {
    tmdb_id: r.id,
    kind,
    title: r.title || r.name || '',
    year: /^\d{4}/.test(date) ? parseInt(date.slice(0, 4), 10) : null,
    poster: r.poster_path ? POSTER + r.poster_path : null,
    backdrop: r.backdrop_path ? BACKDROP + r.backdrop_path : null,
    overview: r.overview || null,
    rating: typeof r.vote_average === 'number' && r.vote_average > 0 ? r.vote_average : null,
    genre_ids: r.genre_ids || [],
    popularity: r.popularity || 0,
    provider: slug
  };
}

// Pull the popular flatrate catalog for every provider (a couple of pages each),
// plus the genre id->name map so merged titles land in the right browse rows.
export async function refreshCatalog(apiKey, { region = 'US', pages = 2, log = () => {} } = {}) {
  if (!apiKey || refreshing) return;
  refreshing = true;
  try {
    const gm = {};
    for (const t of ['movie', 'tv']) {
      try { for (const g of (await tmdbGet(apiKey, `/genre/${t}/list`)).genres || []) gm[g.id] = g.name; } catch {}
    }
    if (Object.keys(gm).length) genreMap = gm;

    const next = { movie: new Map(), tv: new Map() };
    for (const p of PROVIDERS) {
      for (const kind of ['movie', 'tv']) {
        const items = [];
        for (let page = 1; page <= pages; page++) {
          try {
            const d = await tmdbGet(apiKey, `/discover/${kind}`, {
              with_watch_providers: p.tmdb, watch_region: region,
              watch_monetization_types: 'flatrate', sort_by: 'popularity.desc', page
            });
            for (const r of d.results || []) if (r.poster_path) items.push(norm(kind, r, p.id));
            if (page >= (d.total_pages || 1)) break;
          } catch {}
          await sleep(80);
        }
        next[kind].set(p.id, items);
      }
    }
    catalog = next;
    lastRefresh = Date.now();
    const n = ['movie', 'tv'].reduce((s, k) => s + [...next[k].values()].reduce((a, x) => a + x.length, 0), 0);
    log(`Streaming catalog: ${n} titles across ${PROVIDERS.length} services.`);
  } finally {
    refreshing = false;
  }
}

// Merge the enabled providers' titles for a kind ('movie'|'tv'), de-duping by
// TMDB id and collecting every provider a title appears on (for multi badges).
export function catalogFor(kind, slugs) {
  const byId = new Map();
  for (const slug of slugs) {
    if (!BY_SLUG.has(slug)) continue;
    for (const it of catalog[kind]?.get(slug) || []) {
      const ex = byId.get(it.tmdb_id);
      if (ex) { if (!ex.providers.includes(slug)) ex.providers.push(slug); }
      else byId.set(it.tmdb_id, {
        ...it,
        providers: [slug],
        genres: (it.genre_ids || []).map((id) => genreMap[id]).filter(Boolean)
      });
    }
  }
  return [...byId.values()];
}

// Public provider metadata for the settings UI.
export function providersList() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, color: p.color }));
}

export function status() {
  return { lastRefresh, ready: lastRefresh > 0, providers: PROVIDERS.length };
}

// Deep-link to a title's watch page (JustWatch-powered), which one-taps into the
// service. Cached — it's a per-title TMDB call. Falls back to the TMDB watch URL.
const linkCache = new Map();
export async function watchLink(apiKey, kind, tmdbId, region = 'US') {
  const type = kind === 'tv' ? 'tv' : 'movie';
  const key = `${type}:${tmdbId}:${region}`;
  if (linkCache.has(key)) return linkCache.get(key);
  let link = null;
  if (apiKey) {
    try {
      const d = await tmdbGet(apiKey, `/${type}/${tmdbId}/watch/providers`);
      link = d.results?.[region]?.link || null;
    } catch {}
  }
  const url = link || `https://www.themoviedb.org/${type}/${tmdbId}/watch?locale=${region}`;
  linkCache.set(key, url);
  return url;
}

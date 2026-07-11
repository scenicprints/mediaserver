// Radarr (movies) + Sonarr (TV) integration for the Requests feature. Both are
// running on the Dell alongside this server. We only need each one's base URL +
// API key (stored in the git-ignored config.json); quality profiles, root
// folders and language profiles are fetched from the app so nothing is
// hardcoded. All calls use the v3 API with the `X-Api-Key` header.

const POSTER = 'https://image.tmdb.org/t/p/w500';

const base = (cfg) => (cfg && cfg.url ? cfg.url.replace(/\/+$/, '') : '');
export const radarrEnabled = (cfg) => !!(cfg && cfg.url && cfg.apiKey);
export const sonarrEnabled = radarrEnabled;

async function arr(cfg, pathQ, opts = {}) {
  const res = await fetch(base(cfg) + pathQ, {
    ...opts,
    headers: { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

export async function testConn(cfg) {
  if (!radarrEnabled(cfg)) return { configured: false, ok: false };
  try {
    const r = await arr(cfg, '/api/v3/system/status');
    return { configured: true, ok: r.ok, version: r.ok && r.body ? r.body.version : null, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}

// Pick a quality profile + root folder: honor an explicit config value, else
// take the first the instance offers.
async function pickDefaults(cfg) {
  const [profiles, roots] = await Promise.all([
    arr(cfg, '/api/v3/qualityprofile'),
    arr(cfg, '/api/v3/rootfolder')
  ]);
  const profileList = Array.isArray(profiles.body) ? profiles.body : [];
  const rootList = Array.isArray(roots.body) ? roots.body : [];
  const byPref = (re) => profileList.find((p) => re.test(p.name));
  const qualityProfileId = cfg.qualityProfileId
    || (byPref(/1080/i) || byPref(/\bhd\b|720/i) || byPref(/any|standard/i) || profileList[0] || {}).id;
  const rootFolderPath = cfg.rootFolder || (rootList[0] || {}).path;
  return { qualityProfileId, rootFolderPath, profileList, rootList };
}

function poster(images) {
  const p = (images || []).find((i) => i.coverType === 'poster');
  if (!p) return null;
  return p.remoteUrl || p.url || null;
}

// ---- Movies (Radarr) ----
export async function radarrSearch(cfg, term) {
  const r = await arr(cfg, '/api/v3/movie/lookup?term=' + encodeURIComponent(term));
  if (!r.ok || !Array.isArray(r.body)) return [];
  return r.body.slice(0, 20).map((m) => ({
    type: 'movie', tmdbId: m.tmdbId, title: m.title, year: m.year || null,
    overview: m.overview || '', poster: poster(m.images),
    inLibrary: !!(m.id && m.id > 0), hasFile: !!m.hasFile
  }));
}

export async function radarrAdd(cfg, tmdbId) {
  const look = await arr(cfg, '/api/v3/movie/lookup/tmdb?tmdbId=' + tmdbId);
  const movie = look.body && !Array.isArray(look.body) ? look.body : (Array.isArray(look.body) ? look.body[0] : null);
  if (!movie) return { ok: false, error: 'Movie not found in Radarr lookup.' };
  if (movie.id && movie.id > 0) return { ok: true, already: true, title: movie.title };
  const { qualityProfileId, rootFolderPath } = await pickDefaults(cfg);
  if (!qualityProfileId || !rootFolderPath) return { ok: false, error: 'Radarr has no quality profile or root folder set up.' };
  const payload = {
    ...movie, qualityProfileId, rootFolderPath, monitored: true,
    minimumAvailability: 'released', addOptions: { searchForMovie: true }
  };
  const res = await arr(cfg, '/api/v3/movie', { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) return { ok: false, error: arrErr(res) };
  return { ok: true, title: movie.title };
}

// ---- TV (Sonarr) ----
export async function sonarrSearch(cfg, term) {
  const r = await arr(cfg, '/api/v3/series/lookup?term=' + encodeURIComponent(term));
  if (!r.ok || !Array.isArray(r.body)) return [];
  return r.body.slice(0, 20).map((s) => ({
    type: 'tv', tvdbId: s.tvdbId, title: s.title, year: s.year || null,
    overview: s.overview || '', poster: poster(s.images),
    inLibrary: !!(s.id && s.id > 0)
  }));
}

export async function sonarrAdd(cfg, tvdbId) {
  const look = await arr(cfg, '/api/v3/series/lookup?term=tvdb:' + tvdbId);
  const series = Array.isArray(look.body) ? look.body[0] : null;
  if (!series) return { ok: false, error: 'Series not found in Sonarr lookup.' };
  if (series.id && series.id > 0) return { ok: true, already: true, title: series.title };
  const { qualityProfileId, rootFolderPath } = await pickDefaults(cfg);
  if (!qualityProfileId || !rootFolderPath) return { ok: false, error: 'Sonarr has no quality profile or root folder set up.' };
  // languageprofile only exists on Sonarr v3 (v4 dropped it) — include it only
  // if the instance still has the endpoint.
  let languageProfileId;
  try { const lp = await arr(cfg, '/api/v3/languageprofile'); if (Array.isArray(lp.body) && lp.body[0]) languageProfileId = lp.body[0].id; } catch {}
  const payload = {
    ...series, qualityProfileId, rootFolderPath, monitored: true, seasonFolder: true,
    ...(languageProfileId ? { languageProfileId } : {}),
    addOptions: { searchForMissingEpisodes: true, monitor: 'all' }
  };
  const res = await arr(cfg, '/api/v3/series', { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) return { ok: false, error: arrErr(res) };
  return { ok: true, title: series.title };
}

function arrErr(res) {
  if (Array.isArray(res.body) && res.body[0] && res.body[0].errorMessage) return res.body[0].errorMessage;
  if (res.body && res.body.message) return res.body.message;
  return `HTTP ${res.status}`;
}

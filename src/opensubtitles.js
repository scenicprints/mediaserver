// Minimal OpenSubtitles REST client. Needs a free API key (and username/password
// for downloads) from https://www.opensubtitles.com/en/consumers
const BASE = 'https://api.opensubtitles.com/api/v1';
const UA = 'MyMediaServer v1.0';

// Per-account token cache (keyed by apiKey+username) — each user has their own
// OpenSubtitles login, so their tokens must not collide.
const tokenCache = new Map();
const cacheKey = (cfg) => `${cfg.apiKey}|${cfg.username || ''}`;

export function osEnabled(cfg) {
  return !!(cfg && cfg.apiKey);
}

// Drop the cached login token (call after credentials change). Pass a cfg to
// clear just that account, or nothing to clear all.
export function clearAuth(cfg) {
  if (cfg) tokenCache.delete(cacheKey(cfg));
  else tokenCache.clear();
}

async function login(cfg) {
  const cached = tokenCache.get(cacheKey(cfg));
  if (cached && Date.now() < cached.expires) return cached.token;
  if (!cfg.username || !cfg.password) return null;
  let res;
  try {
    res = await fetch(BASE + '/login', {
      method: 'POST',
      headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ username: cfg.username, password: cfg.password })
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  tokenCache.set(cacheKey(cfg), { token: data.token, expires: Date.now() + 23 * 3600 * 1000 });
  return data.token;
}

export async function searchSubtitles(cfg, { tmdb_id, query, season, episode, languages = 'en' }) {
  if (!osEnabled(cfg)) return [];
  const url = new URL(BASE + '/subtitles');
  url.searchParams.set('languages', languages);
  if (tmdb_id) url.searchParams.set('tmdb_id', String(tmdb_id));
  else if (query) url.searchParams.set('query', query);
  if (season != null) url.searchParams.set('season_number', String(season));
  if (episode != null) url.searchParams.set('episode_number', String(episode));

  let res;
  try {
    res = await fetch(url, { headers: { 'Api-Key': cfg.apiKey, 'User-Agent': UA } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || [])
    .map((s) => ({
      file_id: s.attributes && s.attributes.files && s.attributes.files[0] && s.attributes.files[0].file_id,
      release: (s.attributes && (s.attributes.release || (s.attributes.feature_details && s.attributes.feature_details.title))) || 'Subtitle',
      language: s.attributes && s.attributes.language,
      downloads: (s.attributes && s.attributes.download_count) || 0,
      hearing_impaired: !!(s.attributes && s.attributes.hearing_impaired)
    }))
    .filter((s) => s.file_id)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 15);
}

export async function downloadSubtitle(cfg, fileId) {
  if (!osEnabled(cfg)) return null;
  const token = await login(cfg);
  const headers = { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json', 'User-Agent': UA };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(BASE + '/download', { method: 'POST', headers, body: JSON.stringify({ file_id: fileId }) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.link) return null;

  try {
    const srt = await fetch(data.link, { headers: { 'User-Agent': UA } });
    if (!srt.ok) return null;
    return await srt.text();
  } catch {
    return null;
  }
}

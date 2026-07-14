// ============================================================
//  MYFLIX — front-end
// ============================================================

// ---------- Auth (login gate) ----------
// The session lives in an HttpOnly cookie the browser/WebView sends automatically
// on every same-origin request (fetch, <video>, <img>), so nothing below needs a
// token attached. If a call ever comes back 401 (session revoked/expired), drop
// to the login screen.
let currentUser = null;
let authMode = 'login'; // 'login' | 'register'

// ---------- LG webOS TV app auth (token instead of cookie) ----------
// The LG webOS app runtime doesn't keep the login cookie at all, so we carry the
// session token in the launch URL (?app=webos&token=…) and attach it to every
// request ourselves — Bearer header for fetch(), ?token= for media elements
// (<video> can't set headers). Gated behind ?app=webos, so web, phone and the
// Android TV (TCL) app are untouched: WEBOS_TOKEN is null and both helpers below
// become no-ops.
const IS_WEBOS_APP = new URLSearchParams(location.search).get('app') === 'webos';
const WEBOS_TOKEN = IS_WEBOS_APP ? new URLSearchParams(location.search).get('token') : null;
function withToken(url) {
  if (!WEBOS_TOKEN || !url || !(url.startsWith('/') || url.startsWith(location.origin))) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(WEBOS_TOKEN);
}

const _fetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  // webOS app: attach the token as a Bearer header on same-origin API calls.
  if (WEBOS_TOKEN && typeof args[0] === 'string' && (args[0].startsWith('/') || args[0].startsWith(location.origin))) {
    const init = (args[1] = args[1] || {});
    const h = new Headers(init.headers || {});
    if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + WEBOS_TOKEN);
    init.headers = h;
  }
  const res = await _fetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
  if (res.status === 401 && url.includes('/api/') && !/\/api\/(login|register|auth\/status)/.test(url)) {
    showAuth();
  }
  return res;
};

function showAuth() { const el = document.getElementById('auth'); if (el) el.classList.remove('hidden'); }
function hideAuth() { const el = document.getElementById('auth'); if (el) el.classList.add('hidden'); }

// ---------- TV / app mode ----------
// The Android TV WebView loads the UI with ?tv=1 (persisted after first load).
// In TV mode we drop browser-isms: the fullscreen button (a TV is always
// fullscreen) and the mouse cursor.
const TV_MODE = new URLSearchParams(location.search).has('tv') || localStorage.getItem('tvMode') === '1';
if (TV_MODE) {
  localStorage.setItem('tvMode', '1');
  document.body.classList.add('tv-mode');
}

// ---------- Session persistence for the LG webOS TV app ONLY ----------
// The LG webOS app runtime doesn't persist the server's HttpOnly login cookie
// across relaunches, so a normal login loops back to the sign-in screen. The fix
// below is gated entirely behind `?app=webos` — a flag ONLY the LG webOS app
// launches with. Web browsers, phones, and the Android TV (TCL) app never send
// it, so for them `persistToken` is a no-op and nothing changes. For the LG app,
// we mirror the session token into a readable `mstoken` cookie the server also
// accepts (tokenFromReq reads Bearer/cookie/query), and honor a token baked into
// the launch URL (?token=…) for zero-typing sign-in.
function persistToken(t) {
  if (!IS_WEBOS_APP || !t) return; // does nothing outside the LG webOS app
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = 'mstoken=' + encodeURIComponent(t) + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
}
persistToken(new URLSearchParams(location.search).get('token'));

function setupAuth() {
  const form = document.getElementById('auth-form');
  const sub = document.getElementById('auth-sub');
  const code = document.getElementById('auth-code');
  const submit = document.getElementById('auth-submit');
  const toggle = document.getElementById('auth-toggle');
  const err = document.getElementById('auth-error');
  const userEl = document.getElementById('auth-user');
  const passEl = document.getElementById('auth-pass');

  const applyMode = () => {
    const reg = authMode === 'register';
    sub.textContent = reg ? 'Create your account' : 'Sign in to continue';
    submit.textContent = reg ? 'Create account' : 'Sign in';
    submit.disabled = false;
    toggle.textContent = reg ? 'Have an account? Sign in' : 'New here? Create an account';
    code.classList.toggle('hidden', !reg);
    passEl.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    err.textContent = '';
  };
  toggle.addEventListener('click', () => { authMode = authMode === 'login' ? 'register' : 'login'; applyMode(); });
  applyMode();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) { err.textContent = 'Enter a username and password.'; return; }
    submit.disabled = true; submit.textContent = '…';
    const path = authMode === 'register' ? '/api/register' : '/api/login';
    const body = authMode === 'register' ? { username, password, code: code.value.trim() } : { username, password };
    let r, d;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      d = await r.json();
    } catch (_e) { err.textContent = 'Could not reach the server.'; applyMode(); return; }
    if (!r.ok) { err.textContent = (d && d.error) || 'Something went wrong.'; applyMode(); return; }
    persistToken(d && d.token); // mirror into a readable cookie so TV apps that
    location.reload();          // drop the HttpOnly cookie still stay signed in
  });
}

const nav = document.getElementById('nav');
const heroEl = document.getElementById('hero');
const heroBg = document.getElementById('hero-bg');
const heroContent = document.getElementById('hero-content');
const heroDots = document.getElementById('hero-dots');
const rowsEl = document.getElementById('rows');
const search = document.getElementById('search');
const detail = document.getElementById('detail');
const detailInner = document.getElementById('detail-inner');
const detailClose = document.getElementById('detail-close');

let movies = [];
let shows = [];
let continueItems = [];
let currentView = 'home';
let heroItems = [];
let heroIdx = 0;
let heroTimer = null;

// Skip Intro / Skip Credits. Driven ONLY by reliable, bounded signals — named
// chapters and fingerprint-detected intro ranges (see introdetect.js consensus).
// The old time-heuristic (show for the first 1–150s) is gone; that's what made
// the button linger for minutes on real content.
const SKIP_BUTTONS_ENABLED = true;

const NEW_MS = 14 * 24 * 3600 * 1000;
const isNew = (it) => it.added_at && Date.now() - it.added_at < NEW_MS;
const byRecent = (a, b) => (b.added_at || 0) - (a.added_at || 0);
const byRating = (a, b) => (b.rating || 0) - (a.rating || 0);

// ---- Playback prefs (server-backed so they follow you to every device) ----
let prefs = {};
async function loadPrefs() {
  try { prefs = await (await fetch('/api/prefs')).json(); } catch (_e) {}
  // One-time migration: push any prefs this browser stored locally (old
  // versions used localStorage) up to the server, then stop using them.
  const mine = Object.keys(localStorage).filter((k) => k === 'pq' || k.startsWith('verid:') || k.startsWith('sd:'));
  for (const k of mine) {
    if (!(k in prefs)) setPref(k, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
}
const getPref = (k) => prefs[k];
function setPref(key, value) {
  if (value === null || value === undefined || value === '') delete prefs[key];
  else prefs[key] = String(value);
  fetch('/api/prefs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: value === undefined ? null : value })
  }).catch(() => {});
}

async function loadAll() {
  const [mv, sh, cont] = await Promise.all([
    fetch('/api/movies').then((r) => r.json()),
    fetch('/api/shows').then((r) => r.json()),
    fetch('/api/continue').then((r) => r.json()),
    loadPrefs()
  ]);
  movies = mv; shows = sh; continueItems = cont;
  refreshPreroll(); // prefetch the movie pre-roll (fire and forget)
}

// ---------- Navigation ----------
document.querySelectorAll('.nav-link').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view))
);

function setView(view) {
  stopActivePlayer(); // switching top-level views must not leave a player running
  currentView = view;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  search.value = '';
  window.scrollTo({ top: 0 });
  renderView();
}

window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40));

function genresOf(m) { try { return JSON.parse(m.genres || '[]'); } catch (_e) { return []; } }
function allGenres(list) { const s = new Set(); list.forEach((m) => genresOf(m).forEach((g) => s.add(g))); return [...s].sort(); }
function decadesOf(list) { return [...new Set(list.map((m) => (m.year ? Math.floor(m.year / 10) * 10 : null)).filter(Boolean))].sort((a, b) => b - a); }

function recommended(list) {
  const r = list.filter((m) => !m.watched && (m.rating || 0) >= 7).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return r.length ? r : [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0));
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// There's always a season on — pick a theme by the current month and filter by
// genre (and a little title-matching for holidays, since we have no keywords).
function seasonalTheme() {
  const m = new Date().getMonth() + 1;
  const anyG = (it, gs) => genresOf(it).some((g) => gs.includes(g));
  const hasG = (it, g) => genresOf(it).includes(g);
  if (m === 12) return { title: '🎄 Holiday Movies', match: (it) => /christmas|holiday|santa|\belf\b|grinch|scrooge|no[eë]l|xmas|home alone|klaus|nightmare before/i.test(it.title) || (hasG(it, 'Family') && /snow|winter|miracle|wonderful life/i.test(it.title)) };
  if (m === 11) return { title: '🍂 Cozy Fall Favorites', match: (it) => anyG(it, ['Family', 'Comedy', 'Drama']) && (it.rating || 0) >= 6.5 };
  if (m === 10) return { title: '🎃 Halloween Frights', match: (it) => anyG(it, ['Horror', 'Thriller']) };
  if (m === 9) return { title: '🍁 Fall Dramas', match: (it) => hasG(it, 'Drama') && (it.rating || 0) >= 6.5 };
  if (m >= 6 && m <= 8) return { title: '☀️ Summer Blockbusters', match: (it) => anyG(it, ['Action', 'Adventure', 'Science Fiction']) && (it.rating || 0) >= 6.5 };
  if (m === 2) return { title: '💘 Date Night', match: (it) => hasG(it, 'Romance') };
  if (m >= 3 && m <= 5) return { title: '🌸 Spring Adventures', match: (it) => anyG(it, ['Adventure', 'Family', 'Fantasy']) };
  return { title: '❄️ New Year, Great Films', match: (it) => (it.rating || 0) >= 7.8 }; // January
}
// A seasonal row from a pool of {x, kind}. Null if too little fits the theme.
function seasonalRow(pool) {
  const t = seasonalTheme();
  const items = pool.filter((p) => t.match(p.x)).sort((a, b) => (b.x.rating || 0) - (a.x.rating || 0));
  if (items.length < 3) return null;
  const cards = (n) => items.slice(0, n).map((p) => buildMediaCard(p.x, p.kind));
  return { title: t.title, cards: cards(30), seeAll: () => ({ title: t.title, cards: cards(items.length) }) };
}

function renderView() {
  if (currentView !== 'livetv') stopLiveTv();
  if (currentView !== 'requests') stopRequestsPolling();
  if (currentView === 'library') { renderLibrary(); return; }
  if (currentView === 'collections') { renderCollections(); return; }
  if (currentView === 'requests') { renderRequests(); return; }
  if (currentView === 'livetv') { renderLiveTv(); return; }
  rowsEl.style.paddingTop = '';
  const top = [], rest = [];
  const byYear = (a, b) => (b.year || 0) - (a.year || 0);
  const push = (arr, title, list, kind) => { if (list.length) arr.push({ title, kind, cards: mediaCards(list.slice(0, 24), kind), seeAll: () => ({ title, cards: mediaCards(list, kind) }) }); };

  if (currentView === 'movies') {
    setHero(movies.filter((m) => m.backdrop));
    const cw = continueItems.filter((c) => c.kind === 'movie');
    if (cw.length) top.push({ title: 'Continue Watching', cards: continueCards(cw) });
    push(top, 'Recently Added', [...movies].sort(byRecent), 'movie');
    push(top, 'Recently Released', [...movies].sort(byYear), 'movie');
    push(top, 'Recommended', recommended(movies), 'movie');
    push(rest, 'Top Rated', [...movies].sort(byRating), 'movie');
    push(rest, 'Critically Acclaimed', movies.filter((m) => m.rating >= 8).sort(byRating), 'movie');
    push(rest, 'Unwatched', movies.filter((m) => !m.watched), 'movie');
    push(rest, 'Watch Again', movies.filter((m) => m.watched), 'movie');
    push(rest, 'Favorites', movies.filter((m) => m.favorite), 'movie');
    push(rest, '4K', movies.filter((m) => (m.qualities || '').includes('4K')), 'movie');
    allGenres(movies).forEach((g) => push(rest, g, movies.filter((m) => genresOf(m).includes(g)).sort(byRating), 'movie'));
    decadesOf(movies).forEach((d) => push(rest, `${d}s`, movies.filter((m) => m.year >= d && m.year < d + 10).sort(byYear), 'movie'));
  } else if (currentView === 'tv') {
    setHero(shows.filter((s) => s.backdrop));
    const cw = continueItems.filter((c) => c.kind === 'episode');
    if (cw.length) top.push({ title: 'Continue Watching', cards: continueCards(cw) });
    push(top, 'Recently Added', [...shows].sort(byRecent), 'show');
    push(top, 'Recently Released', [...shows].sort(byYear), 'show');
    push(top, 'Recommended', recommended(shows), 'show');
    push(rest, 'New Episodes', shows.filter((s) => s.unwatched > 0), 'show');
    push(rest, 'Top Rated', [...shows].sort(byRating), 'show');
    push(rest, 'Critically Acclaimed', shows.filter((s) => s.rating >= 8).sort(byRating), 'show');
    allGenres(shows).forEach((g) => push(rest, g, shows.filter((s) => genresOf(s).includes(g)).sort(byRating), 'show'));
    decadesOf(shows).forEach((d) => push(rest, `${d}s`, shows.filter((s) => s.year >= d && s.year < d + 10).sort(byYear), 'show'));
  } else {
    const mixed = [...movies.filter((m) => m.backdrop), ...shows.filter((s) => s.backdrop)].sort(byRating);
    setHero(mixed);
    if (continueItems.length) top.push({ title: 'Continue Watching', cards: continueCards(continueItems) });
    top.push({ title: 'Recently Added', cards: mixedRecent(24) });
    push(top, 'Recently Released', [...movies].sort(byYear), 'movie');
    push(top, 'Recommended', recommended(movies), 'movie');
    push(rest, 'Movies', [...movies].sort(byRating), 'movie');
    push(rest, 'TV Shows', [...shows].sort(byRating), 'show');
    push(rest, 'Critically Acclaimed', movies.filter((m) => m.rating >= 8).sort(byRating), 'movie');
    push(rest, 'Unwatched Movies', movies.filter((m) => !m.watched), 'movie');
    push(rest, 'Favorites', movies.filter((m) => m.favorite), 'movie');
    allGenres(movies).forEach((g) => push(rest, g, movies.filter((m) => genresOf(m).includes(g)).sort(byRating), 'movie'));
    decadesOf(movies).forEach((d) => push(rest, `${d}s`, movies.filter((m) => m.year >= d && m.year < d + 10).sort(byYear), 'movie'));
  }
  // Seasonal row — always last among the permanent (fixed) rows.
  const seasonalPool = currentView === 'tv' ? shows.map((x) => ({ x, kind: 'show' }))
    : currentView === 'movies' ? movies.map((x) => ({ x, kind: 'movie' }))
    : [...movies.map((x) => ({ x, kind: 'movie' })), ...shows.map((x) => ({ x, kind: 'show' }))];
  const sr = seasonalRow(seasonalPool);
  if (sr) top.push(sr);
  drawRows([...top, ...shuffle(rest)]);
}

let libraryKind = 'movie';
function renderLibrary() {
  heroEl.classList.add('hidden');
  rowsEl.style.paddingTop = '78px';
  rowsEl.innerHTML = '';
  const list = (libraryKind === 'tv' ? shows : movies).slice().sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const groups = {};
  for (const it of list) {
    let L = (it.title.replace(/^(the|a|an) /i, '')[0] || '#').toUpperCase();
    if (!/[A-Z]/.test(L)) L = '#';
    (groups[L] = groups[L] || []).push(it);
  }
  const letters = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((L) => groups[L]);

  const wrap = document.createElement('div');
  wrap.className = 'library';
  wrap.innerHTML = `
    <div class="lib-head">
      <div class="tabs">
        <button class="tab${libraryKind === 'movie' ? ' active' : ''}" data-k="movie">Movies</button>
        <button class="tab${libraryKind === 'tv' ? ' active' : ''}" data-k="tv">TV Shows</button>
      </div>
      <span class="row-count">${list.length}</span>
    </div>
    <div class="lib-scroll" id="lib-scroll"></div>
    <div class="az-rail">${letters.map((L) => `<button class="az" data-l="${L}">${L}</button>`).join('')}</div>`;
  rowsEl.appendChild(wrap);

  const scroll = wrap.querySelector('#lib-scroll');
  for (const L of letters) {
    const sec = document.createElement('div');
    sec.className = 'lib-letter';
    sec.id = 'L-' + L;
    sec.innerHTML = `<h3 class="lib-letter-h">${L}</h3><div class="lib-grid"></div>`;
    const grid = sec.querySelector('.lib-grid');
    groups[L].forEach((it) => grid.appendChild(buildMediaCard(it, libraryKind)));
    scroll.appendChild(sec);
  }
  wrap.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { libraryKind = b.dataset.k; renderLibrary(); }));
  wrap.querySelectorAll('.az').forEach((b) => b.addEventListener('click', () => { const t = document.getElementById('L-' + b.dataset.l); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
}

// ---------- Collections tab ----------
let collectionKind = 'movie';
async function renderCollections() {
  heroEl.classList.add('hidden');
  rowsEl.style.paddingTop = '78px';
  rowsEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'library';
  wrap.innerHTML = `
    <div class="lib-head">
      <div class="tabs">
        <button class="tab${collectionKind === 'movie' ? ' active' : ''}" data-k="movie">Movies</button>
        <button class="tab${collectionKind === 'tv' ? ' active' : ''}" data-k="tv">TV Shows</button>
      </div>
      <span class="row-count" id="col-count"></span>
    </div>
    <div class="coll-grid" id="coll-grid"></div>`;
  rowsEl.appendChild(wrap);
  wrap.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { collectionKind = b.dataset.k; renderCollections(); }));
  const grid = wrap.querySelector('#coll-grid');

  if (collectionKind === 'tv') {
    grid.innerHTML = `<div class="lib-empty" style="padding:40px 2px">TV shows aren't grouped into collections yet — browse them under <b>TV Shows</b> or <b>Library</b>.</div>`;
    return;
  }
  let cols = [];
  try { cols = await (await fetch('/api/collections')).json(); } catch (_e) {}
  document.getElementById('col-count').textContent = cols.length ? `${cols.length} collection${cols.length === 1 ? '' : 's'}` : '';
  if (!cols.length) {
    grid.innerHTML = `<div class="lib-empty" style="padding:40px 2px">No franchises found yet. Collections appear once TMDB details finish loading for your movies (they backfill in the background after a scan).</div>`;
    return;
  }
  for (const c of cols) {
    const card = document.createElement('div');
    card.className = 'coll-card';
    card.innerHTML = `
      <div class="coll-poster">${c.poster ? `<img src="${c.poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(c.name)}</span>`}
        <div class="coll-count">${c.count}</div></div>
      <div class="coll-name">${escapeHtml(c.name.replace(/ Collection$/, ''))}</div>`;
    card.addEventListener('click', () => openCollection(c.id));
    grid.appendChild(card);
  }
}

async function openCollection(id) {
  let data;
  try { data = await (await fetch('/api/collections/' + encodeURIComponent(id))).json(); } catch (_e) { return; }
  const items = data.items || [];
  detailInner.innerHTML = `
    <div class="dp-splash" style="background-image:url('${data.backdrop || data.poster || (items[0] && items[0].backdrop) || ''}')">
      <div class="dp-hero">
        <div class="dp-poster">${data.poster ? `<img src="${data.poster}" alt="">` : ''}</div>
        <div class="dp-info">
          <h1 class="dp-title">${escapeHtml((data.name || 'Collection').replace(/ Collection$/, ''))}</h1>
          <div class="dp-meta"><span class="chip">${items.length} film${items.length === 1 ? '' : 's'} in your library</span></div>
        </div>
      </div>
    </div>
    <div class="dp-body">
      <h3 class="seasons-h">Films</h3>
      <div class="lib-grid" id="coll-items"></div>
    </div>`;
  openDetailModal();
  detail.scrollTop = 0;
  const g = document.getElementById('coll-items');
  items.forEach((m) => g.appendChild(buildMediaCard(m, 'movie')));
}

// ---------- Requests (Radarr / Sonarr) ----------
let reqSearchTimer = null, reqQueueTimer = null;
let reqProfiles = { radarr: null, sonarr: null };   // { profiles:[{id,name}], default }
let reqMovieProfile = null, reqTvProfile = null;     // chosen quality profile ids
function stopRequestsPolling() { clearTimeout(reqQueueTimer); reqQueueTimer = null; }

async function renderRequests() {
  heroEl.classList.add('hidden');
  rowsEl.style.paddingTop = '78px';
  rowsEl.innerHTML = `
    <div class="requests">
      <div class="req-head">
        <h2 class="req-title">Request something</h2>
        <p class="muted" id="req-sub">Can't find a movie or show? Search for it — it'll be sent to your downloaders and show up when it's ready.</p>
        <div class="req-controls">
          <input id="req-search" class="req-input" type="search" placeholder="Search for a movie or TV show to request…" autocomplete="off" />
          <div id="req-quality" class="req-quality"></div>
        </div>
      </div>
      <div id="req-queue" class="req-queue"></div>
      <div id="req-results" class="req-results"></div>
    </div>`;
  const input = document.getElementById('req-search');
  const results = document.getElementById('req-results');

  let status;
  try { status = await (await fetch('/api/requests/status')).json(); } catch (_e) { status = {}; }
  const radarrOk = status.radarr && status.radarr.ok;
  const sonarrOk = status.sonarr && status.sonarr.ok;
  if (!radarrOk && !sonarrOk) {
    const both = status.radarr, so = status.sonarr;
    const detail = (both && both.configured) || (so && so.configured)
      ? 'Configured, but the server can\'t reach them right now. Check the URLs/keys in Settings.'
      : 'Not set up yet.';
    results.innerHTML = `<div class="req-empty">
      <p><b>Requests need Radarr and/or Sonarr.</b></p>
      <p class="muted">${detail}</p>
      <button class="btn primary" id="req-settings">⚙ Open Settings</button></div>`;
    document.getElementById('req-settings').addEventListener('click', openSettings);
    input.disabled = true;
    return;
  }
  document.getElementById('req-sub').textContent =
    `Connected to ${[radarrOk && 'Radarr (movies)', sonarrOk && 'Sonarr (TV)'].filter(Boolean).join(' and ')}. Search below.`;

  // Quality picker (one select per configured service).
  try { reqProfiles = await (await fetch('/api/requests/profiles')).json(); } catch (_e) {}
  renderQualityPicker(radarrOk, sonarrOk);

  // On a TV, don't auto-focus (it traps the remote in the field). Focus the box
  // only for mouse/desktop; a remote lands on it via the focus engine and Enter.
  if (!(window.tvNavActive && window.tvNavActive())) input.focus();
  if (window.tvSeat) window.tvSeat(input);
  input.addEventListener('input', () => {
    clearTimeout(reqSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    reqSearchTimer = setTimeout(() => doRequestSearch(q, results), 350);
  });

  // Live download queue, refreshed while this view is open.
  const pollQueue = async () => {
    if (currentView !== 'requests') return;
    await loadQueue();
    reqQueueTimer = setTimeout(pollQueue, 8000);
  };
  pollQueue();
}

function renderQualityPicker(radarrOk, sonarrOk) {
  const wrap = document.getElementById('req-quality'); if (!wrap) return;
  const sel = (label, data, chosen, onPick) => {
    if (!data || !data.profiles || !data.profiles.length) return '';
    const cur = chosen || data.default;
    return `<label class="req-qsel"><span>${label}</span><select data-role="${label}">${
      data.profiles.map((p) => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    }</select></label>`;
  };
  reqMovieProfile = reqMovieProfile || (reqProfiles.radarr && reqProfiles.radarr.default) || null;
  reqTvProfile = reqTvProfile || (reqProfiles.sonarr && reqProfiles.sonarr.default) || null;
  wrap.innerHTML =
    (radarrOk ? sel('Movie quality', reqProfiles.radarr, reqMovieProfile) : '') +
    (sonarrOk ? sel('Show quality', reqProfiles.sonarr, reqTvProfile) : '');
  const sels = wrap.querySelectorAll('select');
  sels.forEach((s) => s.addEventListener('change', () => {
    if (s.dataset.role === 'Movie quality') reqMovieProfile = +s.value; else reqTvProfile = +s.value;
  }));
}

async function loadQueue() {
  const box = document.getElementById('req-queue'); if (!box) return;
  let q;
  try { q = await (await fetch('/api/requests/queue')).json(); } catch (_e) { return; }
  if (!q.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="req-qhead">Downloading now <span class="row-count">${q.length}</span></h3>` +
    q.map((d) => {
      const pct = Math.round(d.progress);
      const state = d.errorMessage ? `<span class="req-err">⚠ ${escapeHtml(d.errorMessage)}</span>`
        : `${escapeHtml((d.state || '').replace(/([A-Z])/g, ' $1').trim() || 'queued')}${d.timeleft ? ' · ' + escapeHtml(d.timeleft) : ''}${d.quality ? ' · ' + escapeHtml(d.quality) : ''}`;
      return `<div class="req-qrow">
        <span class="req-badge ${d.type}">${d.type === 'movie' ? 'MOVIE' : 'TV'}</span>
        <div class="req-qbody">
          <div class="req-qtitle">${escapeHtml(d.title)}</div>
          <div class="req-qbar"><i style="width:${pct}%"></i></div>
        </div>
        <div class="req-qmeta"><div class="req-qpct">${pct}%</div><div class="req-qstate">${state}</div></div>
      </div>`;
    }).join('');
}

async function doRequestSearch(q, results) {
  results.innerHTML = '<div class="req-empty muted">Searching…</div>';
  let list;
  try {
    const r = await fetch('/api/requests/search?q=' + encodeURIComponent(q));
    if (!r.ok) { results.innerHTML = `<div class="req-empty muted">${escapeHtml((await r.json()).error || 'Search failed.')}</div>`; return; }
    list = await r.json();
  } catch (_e) { results.innerHTML = '<div class="req-empty muted">Search failed.</div>'; return; }
  if (!list.length) { results.innerHTML = '<div class="req-empty muted">No matches found.</div>'; return; }
  results.innerHTML = '';
  for (const it of list) results.appendChild(requestCard(it));
}

function requestCard(it) {
  const card = document.createElement('div');
  card.className = 'req-card';
  const owned = it.inLibrary || it.hasFile;
  card.innerHTML = `
    <div class="req-poster">${it.poster ? `<img src="${it.poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(it.title)}</span>`}
      <span class="req-badge ${it.type}">${it.type === 'movie' ? 'MOVIE' : 'TV'}</span></div>
    <div class="req-info">
      <div class="req-name">${escapeHtml(it.title)}${it.year ? ` <span class="muted">(${it.year})</span>` : ''}</div>
      <div class="req-over">${escapeHtml(it.overview || '')}</div>
      <button class="btn ${owned ? '' : 'primary'} req-btn" ${owned ? 'disabled' : ''}>${owned ? '✓ Already in library' : '＋ Request'}</button>
    </div>`;
  const btn = card.querySelector('.req-btn');
  // Enter/remote on the focused card triggers the request (the button itself
  // still works for mouse users).
  card.addEventListener('click', (e) => { if (!e.target.closest('.req-btn') && !owned && !btn.disabled) btn.click(); });
  if (!owned) btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Requesting…';
    try {
      const qualityProfileId = it.type === 'movie' ? reqMovieProfile : reqTvProfile;
      const r = await fetch('/api/requests/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: it.type, tmdbId: it.tmdbId, tvdbId: it.tvdbId, qualityProfileId })
      });
      const d = await r.json();
      if (r.ok) { btn.textContent = d.already ? '✓ Already requested' : '✓ Requested — searching'; btn.classList.remove('primary'); btn.classList.add('req-done'); loadQueue(); }
      else { btn.textContent = '⚠ ' + (d.error || 'Failed'); btn.disabled = false; }
    } catch (_e) { btn.textContent = '⚠ Failed'; btn.disabled = false; }
  });
  return card;
}

// ---------- Live TV (channel surfing) ----------
// A deterministic virtual broadcast: every channel is a looping playlist, and
// the "now playing" is computed from the wall clock, so every device tuned to
// a channel sees the same thing "on air." Movies and shows are mixed.
const LT_EPOCH = 1704067200; // 2024-01-01 UTC — a fixed origin for the schedule
let ltState = null; // { channels, sel, timer, onKey }
let ltEpisodes = []; // flat playable episodes (fetched once when Live TV opens)

// Build the item pool: movies + individual episodes. Each episode carries a
// show-like ref (show genres/art for grouping, episode title/still/duration for
// display + scheduling) so channels air real episodes at their real lengths.
function ltItemPool() {
  const mv = movies.filter((x) => x.backdrop || x.poster).map((ref) => ({ kind: 'movie', ref }));
  const ep = ltEpisodes.map((e) => ({
    kind: 'episode',
    ref: {
      show_id: e.showId, epId: e.epId, season: e.season, episode: e.episode,
      title: e.showTitle, epTitle: e.epTitle, still: e.still, poster: e.poster, backdrop: e.backdrop,
      overview: e.overview, genres: e.genres, year: e.year, rating: e.rating, duration: e.duration
    }
  }));
  return [...mv, ...ep];
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const ltDuration = (it) => it.kind === 'episode'
  ? (it.ref.duration || 30 * 60)                                   // real episode length, else ~30 min
  : ((it.ref.runtime && it.ref.runtime * 60) || it.ref.duration || 105 * 60);

// Audience tier from genres. Certifications aren't in TMDB data here, so we
// approximate: Horror/War (and Thriller/Crime that isn't also Family) = mature;
// Family/Kids (and non-mature Animation) = family; everything else general.
const LT_MATURE_HARD = ['Horror', 'War'];
const LT_MATURE_SOFT = ['Thriller', 'Crime'];
const LT_FAMILY_G = ['Family', 'Kids'];
function ltTier(it) {
  const g = genresOf(it.ref);
  const some = (arr) => g.some((x) => arr.includes(x));
  if (some(LT_MATURE_HARD)) return 'mature';
  if (some(LT_MATURE_SOFT) && !some(LT_FAMILY_G)) return 'mature';
  if (some(LT_FAMILY_G)) return 'family';
  if (g.includes('Animation') && !some([...LT_MATURE_HARD, ...LT_MATURE_SOFT])) return 'family';
  return 'general';
}
// A channel is either family-safe (family + general, never mature) or mature
// (general + mature, never family). So a kids title and an adult title can
// never share a channel — the "kids show then adult show" bug.
const ltAudOk = (it, mature) => (mature ? ltTier(it) !== 'family' : ltTier(it) !== 'mature');

function buildChannels() {
  const all = ltItemPool();
  if (!all.length) return [];

  const has = (it, name) => genresOf(it.ref).includes(name);
  const hasAny = (it, names) => genresOf(it.ref).some((x) => names.includes(x));
  const decadeOf = (it) => (it.ref.year ? Math.floor(it.ref.year / 10) * 10 : null);
  const byRating = (a, b) => (b.ref.rating || 0) - (a.ref.rating || 0);
  const byYear = (a, b) => (b.ref.year || 0) - (a.ref.year || 0);

  // Each channel is one clear, coherent filter. `mature` flips the audience gate.
  // Ordered by broad appeal AND balanced across audiences (mature channels are
  // interleaved, not dumped at the end) so we keep a good mix within the first 25.
  const defs = [
    { name: 'PRIME', sub: 'Feature Films', pick: (it) => it.kind === 'movie', sort: byRating },
    { name: 'BINGE TV', sub: 'Series Marathon', pick: (it) => it.kind === 'episode' },
    { name: 'ADRENALINE', sub: 'Action', pick: (it) => has(it, 'Action'), sort: byRating },
    { name: 'THE LAUGH TRACK', sub: 'Comedy', pick: (it) => has(it, 'Comedy') },
    { name: 'NIGHTMARE', sub: 'Horror', mature: true, pick: (it) => has(it, 'Horror') },
    { name: 'PRESTIGE', sub: 'Drama', pick: (it) => has(it, 'Drama'), sort: byRating },
    { name: 'FAMILY ROOM', sub: 'Family & Kids', pick: (it) => ltTier(it) === 'family' },
    { name: 'NEBULA', sub: 'Science Fiction', pick: (it) => has(it, 'Science Fiction') },
    { name: 'PRECINCT', sub: 'Crime', mature: true, pick: (it) => has(it, 'Crime') },
    { name: 'MYTHOS', sub: 'Fantasy', pick: (it) => has(it, 'Fantasy') },
    { name: 'PULSE', sub: 'Thrillers', mature: true, pick: (it) => has(it, 'Thriller') },
    { name: 'TRAILBLAZER', sub: 'Adventure', pick: (it) => has(it, 'Adventure') },
    { name: 'HEARTLINE', sub: 'Romance', pick: (it) => has(it, 'Romance') },
    { name: 'TOP SHELF', sub: 'Top Rated', pick: (it) => (it.ref.rating || 0) >= 7.5, sort: byRating },
    { name: 'TOON CITY', sub: 'Animation', pick: (it) => has(it, 'Animation') },
    { name: 'BLOCKBUSTER', sub: 'Big & Loud', pick: (it) => hasAny(it, ['Action', 'Adventure', 'Science Fiction']) && (it.ref.rating || 0) >= 6.5, sort: byRating },
    { name: 'AFTER DARK', sub: 'Late Night', mature: true, pick: (it) => hasAny(it, ['Horror', 'Thriller', 'Crime']), sort: byRating },
    { name: 'THE CRITICS', sub: 'Acclaimed', pick: (it) => (it.ref.rating || 0) >= 8, sort: byRating },
    { name: 'FRESH', sub: 'New Releases', pick: (it) => (it.ref.year || 0) >= 2020, sort: byYear },
    { name: 'REWIND 80s', sub: '1980s', pick: (it) => decadeOf(it) === 1980 },
    { name: 'REWIND 90s', sub: '1990s', pick: (it) => decadeOf(it) === 1990 },
    { name: 'FLASHBACK 00s', sub: '2000s', pick: (it) => decadeOf(it) === 2000 },
    { name: 'THROWBACK 10s', sub: '2010s', pick: (it) => decadeOf(it) === 2010 },
    { name: 'ENIGMA', sub: 'Mystery', pick: (it) => has(it, 'Mystery') },
    { name: 'FRONTLINE', sub: 'War Stories', mature: true, pick: (it) => has(it, 'War') },
    // Fillers below — used only if some channels above lack content.
    { name: 'THE REAL', sub: 'Documentary', pick: (it) => has(it, 'Documentary') },
    { name: 'ENCORE', sub: 'Music & Musicals', pick: (it) => has(it, 'Music') },
    { name: 'FRONTIER', sub: 'Westerns', pick: (it) => has(it, 'Western') },
    { name: 'SATURDAY MORNING', sub: 'Cartoons', pick: (it) => has(it, 'Animation') && ltTier(it) === 'family' },
    { name: 'DATE NIGHT', sub: 'Rom-Coms', pick: (it) => has(it, 'Romance') && has(it, 'Comedy') },
    { name: 'SITCOM CENTRAL', sub: 'TV Comedies', pick: (it) => it.kind === 'episode' && has(it, 'Comedy') },
    { name: 'THE SERIAL', sub: 'TV Dramas', pick: (it) => it.kind === 'episode' && has(it, 'Drama'), sort: byRating }
  ];

  const MIN = 3; // don't launch a channel with too little to air
  const channels = [];
  const seenName = new Set();
  for (const d of defs) {
    if (channels.length >= 25) break;
    let items = all.filter((it) => d.pick(it) && ltAudOk(it, !!d.mature));
    if (items.length < MIN || seenName.has(d.name)) continue;
    if (d.sort) items = items.slice().sort(d.sort);
    seenName.add(d.name);
    channels.push({ name: d.name, sub: d.sub, items });
  }
  return channels.map((c, i) => {
    const playlist = seededShuffle(c.items, hashStr(c.name));
    const total = playlist.reduce((s, it) => s + ltDuration(it), 0);
    return Object.assign({}, c, { number: i + 2, playlist, total });
  });
}

// What's on this channel right now (and the item + offset), from the wall clock.
function nowOn(chan, atSec) {
  let pos = ((atSec - LT_EPOCH) % chan.total + chan.total) % chan.total;
  for (let i = 0; i < chan.playlist.length; i++) {
    const d = ltDuration(chan.playlist[i]);
    if (pos < d) return { item: chan.playlist[i], offset: pos, endsIn: d - pos, idx: i };
    pos -= d;
  }
  return { item: chan.playlist[0], offset: 0, endsIn: ltDuration(chan.playlist[0]), idx: 0 };
}
function upcoming(chan, atSec, n) {
  const out = []; const cur = nowOn(chan, atSec); let clock = atSec + cur.endsIn; let idx = cur.idx + 1;
  for (let k = 0; k < n; k++) { const it = chan.playlist[idx % chan.playlist.length]; out.push({ item: it, at: clock }); clock += ltDuration(it); idx++; }
  return out;
}
const clockTime = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The guide window: a DirecTV-style grid showing WIN_MIN minutes across.
const WIN_MIN = 90;
const LABEL_W = 168; // channel-label column width (must match CSS)

// The programs airing on a channel across [winStart, winEnd] (seconds), each
// with its true start/end so the grid can size blocks by duration.
function programsInWindow(chan, winStart, winEnd) {
  const first = nowOn(chan, winStart);
  let start = winStart - first.offset;
  let idx = first.idx;
  const out = [];
  let guard = 0;
  while (start < winEnd && guard++ < 60) {
    const item = chan.playlist[idx % chan.playlist.length];
    const dur = ltDuration(item);
    out.push({ item, start, end: start + dur });
    start += dur; idx++;
  }
  return out;
}

async function renderLiveTv() {
  heroEl.classList.add('hidden');
  rowsEl.style.paddingTop = '0';
  document.body.classList.add('lt-active');
  // Pull the flat episode list once so channels can air individual episodes.
  if (!ltEpisodes.length) {
    rowsEl.innerHTML = '<div class="lib-empty" style="padding:100px var(--edge)">Tuning in…</div>';
    try { ltEpisodes = await (await fetch('/api/livetv/episodes')).json(); } catch (_e) {}
    if (currentView !== 'livetv') return; // user navigated away while loading
  }
  const channels = buildChannels();
  if (!channels.length) { rowsEl.innerHTML = '<div class="lib-empty" style="padding:100px var(--edge)">Add some movies or shows to start broadcasting.</div>'; return; }
  if (ltState) stopLiveTv();
  ltState = { channels, sel: 0, timer: null, onKey: null };

  rowsEl.innerHTML = `
    <div class="livetv">
      <div class="lt-preview" id="lt-preview"></div>
      <div class="lt-epg">
        <div class="lt-epg-head">
          <div class="lt-epg-title"><span class="lt-live-dot"></span> GUIDE</div>
          <div class="lt-timebar" id="lt-timebar"></div>
        </div>
        <div class="lt-epg-rows" id="lt-epg-rows"></div>
        <div class="lt-hint">▲▼ change channel · Enter to watch · click a show to tune in</div>
      </div>
    </div>`;
  // Clear the fixed nav dynamically (it can wrap to 2 rows on narrow screens).
  const fitNav = () => { const el = rowsEl.querySelector('.livetv'); if (el) el.style.paddingTop = nav.offsetHeight + 'px'; };
  fitNav();
  drawPreview(); drawEpg();

  ltState.onKey = (e) => {
    if (currentView !== 'livetv' || !document.getElementById('detail').classList.contains('hidden') || document.querySelector('.vp')) return;
    if (document.querySelector('.nav .tv-focus')) return; // ribbon has focus → let it drive
    if (e.key === 'ArrowDown') { e.preventDefault(); ltState.sel = (ltState.sel + 1) % channels.length; drawEpg(); drawPreview(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ltState.sel = (ltState.sel - 1 + channels.length) % channels.length; drawEpg(); drawPreview(); }
    else if (e.key === 'Enter') { e.preventDefault(); tuneIn(); }
  };
  document.addEventListener('keydown', ltState.onKey, true);
  ltState.onResize = fitNav;
  window.addEventListener('resize', fitNav);
  ltState.timer = setInterval(() => { drawEpg(); drawPreview(); }, 30000);
}

function stopLiveTv() {
  document.body.classList.remove('lt-active');
  if (!ltState) return;
  clearInterval(ltState.timer);
  if (ltState.onKey) document.removeEventListener('keydown', ltState.onKey, true);
  if (ltState.onResize) window.removeEventListener('resize', ltState.onResize);
  ltState = null;
}

function drawPreview() {
  const s = document.getElementById('lt-preview'); if (!s) return;
  const chan = ltState.channels[ltState.sel];
  const now = Math.floor(Date.now() / 1000);
  const on = nowOn(chan, now);
  const it = on.item.ref;
  const dur = ltDuration(on.item);
  const pct = Math.min(100, (on.offset / dur) * 100);
  const up = upcoming(chan, now, 1)[0];
  const isEp = on.item.kind === 'episode';
  const epLabel = isEp ? `S${it.season}·E${String(it.episode).padStart(2, '0')}${it.epTitle ? ' · ' + it.epTitle : ''}` : '';
  s.style.backgroundImage = `url('${it.still || it.backdrop || it.poster || ''}')`;
  s.innerHTML = `
    <div class="lt-preview-fade"></div>
    <div class="lt-preview-body">
      <div class="lt-chan-badge"><span class="lt-num">${chan.number}</span><span class="lt-name">${escapeHtml(chan.name)}</span><span class="lt-onair"><span class="lt-live-dot"></span>LIVE</span></div>
      <h1 class="lt-title">${escapeHtml(it.title)}</h1>
      <div class="lt-meta">
        ${isEp ? `<span class="chip">${escapeHtml(epLabel)}</span>` : (it.year ? `<span class="chip">${it.year}</span>` : '')}
        ${it.rating ? `<span class="chip rating">★ ${it.rating.toFixed(1)}</span>` : ''}
        <span class="chip">${escapeHtml(chan.sub)}</span>
      </div>
      <p class="lt-over">${escapeHtml((isEp ? it.epTitle : '') || it.overview || '')}</p>
      <div class="lt-prog"><div class="lt-prog-fill" style="width:${pct}%"></div></div>
      <div class="lt-times"><span>▶ ${Math.round(on.offset / 60)} min in</span>${up ? `<span class="muted">Up next ${clockTime(up.at)} · ${escapeHtml(up.item.ref.title)}</span>` : ''}</div>
      <div class="lt-actions"><button class="btn btn-play" id="lt-tune">▶ Tune In</button></div>
    </div>`;
  const t = document.getElementById('lt-tune'); if (t) t.addEventListener('click', tuneIn);
}

// Lightweight select (hover): move the highlight + refresh the preview pane
// without rebuilding the whole grid (avoids flicker).
function selectChannel(i) {
  if (!ltState || i === ltState.sel) return;
  ltState.sel = i;
  const rows = document.getElementById('lt-epg-rows');
  if (rows) [...rows.children].forEach((r, idx) => r.classList.toggle('sel', idx === i));
  drawPreview();
}

function drawEpg() {
  const rowsEl2 = document.getElementById('lt-epg-rows'); if (!rowsEl2) return;
  const now = Math.floor(Date.now() / 1000);
  const winStart = Math.floor(now / 1800) * 1800; // floor to :00/:30
  const winEnd = winStart + WIN_MIN * 60;
  const span = winEnd - winStart;
  const pos = (sec) => ((sec - winStart) / span) * 100;

  // time header labels every 30 min
  const bar = document.getElementById('lt-timebar');
  if (bar) {
    let h = '';
    for (let t = winStart; t < winEnd; t += 1800) h += `<span class="lt-timelbl" style="left:${pos(t)}%">${clockTime(t)}</span>`;
    bar.innerHTML = h + `<span class="lt-nowline" style="left:${pos(now)}%"></span>`;
  }

  rowsEl2.innerHTML = '';
  ltState.channels.forEach((chan, i) => {
    const row = document.createElement('div');
    row.className = 'lt-erow' + (i === ltState.sel ? ' sel' : '');
    const progs = programsInWindow(chan, winStart, winEnd);
    const blocks = progs.map((p) => {
      const left = Math.max(0, pos(p.start));
      const right = Math.min(100, pos(p.end));
      const w = Math.max(0, right - left);
      const live = now >= p.start && now < p.end;
      return `<div class="lt-block${live ? ' live' : ''}" style="left:${left}%;width:${w}%" title="${escapeHtml(p.item.ref.title)}">
        <span class="lt-block-t">${escapeHtml(p.item.ref.title)}</span></div>`;
    }).join('');
    row.innerHTML = `
      <div class="lt-echan"><span class="lt-enum">${chan.number}</span><span class="lt-ename">${escapeHtml(chan.name)}</span></div>
      <div class="lt-etrack"><span class="lt-nowline" style="left:${pos(now)}%"></span>${blocks}</div>`;
    // Hover previews the channel; a single click tunes straight in — no need to
    // go back up to a Tune In button.
    row.addEventListener('mouseenter', () => selectChannel(i));
    row.addEventListener('click', () => { ltState.sel = i; tuneIn(); });
    rowsEl2.appendChild(row);
  });
  const sel = rowsEl2.children[ltState.sel];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function tuneIn() {
  const chan = ltState.channels[ltState.sel];
  const on = nowOn(chan, Math.floor(Date.now() / 1000));
  const offset = Math.floor(on.offset); // drop in at the live position, not the start
  // Live TV is ephemeral: pass no progressUrl, so nothing tuned here is written
  // to watch-state / Continue Watching.
  if (on.item.kind === 'episode') { tuneEpisode(on.item.ref, offset); return; }
  const m = await (await fetch('/api/movies/' + on.item.ref.id)).json();
  const files = m.files || [];
  if (!files.length) { openDetail(m.id, false); return; }
  const f = preferredFile(files, 'm' + m.id);
  openPlayer({
    title: m.title, files, startFileId: f.id, verKey: 'm' + m.id,
    streamBase: '/api/stream/', subtitleBase: '/api/subtitle/', searchKind: 'movie',
    startAt: offset, progressUrl: null, upNext: null, onEnded: null, live: true // live feed
  });
}

// Tune into the exact episode that's "airing" now, at the live offset. Fetch the
// show so we have the episode's files (with subtitle tracks) to play.
async function tuneEpisode(epRef, offset) {
  let show;
  try { show = await (await fetch('/api/shows/' + epRef.show_id)).json(); } catch (_e) { return; }
  let ep = null;
  (show.seasons || []).forEach((s) => s.episodes.forEach((e) => { if (e.id === epRef.epId) ep = e; }));
  if (!ep) return;
  const files = ep.files || [];
  if (!files.length) return;
  const f = preferredFile(files, 'e' + ep.id);
  openPlayer({
    title: show.title, subtitle: episodeSub(ep), files, startFileId: f.id, verKey: 'e' + ep.id,
    streamBase: '/api/stream/episode/', subtitleBase: '/api/subtitle/episode/', searchKind: 'episode',
    startAt: offset, progressUrl: null, upNext: null, onEnded: null, live: true // live feed, at the live point
  });
}

function showGridView(title, cards) {
  heroEl.classList.add('hidden');
  window.scrollTo({ top: 0 });
  rowsEl.innerHTML = '';
  rowsEl.style.paddingTop = '78px';
  const sec = document.createElement('section');
  sec.className = 'row';
  sec.innerHTML = `<div class="row-head"><button class="btn sm" id="grid-back">‹ Back</button><h3 class="row-title" style="margin-left:8px">${escapeHtml(title)}</h3><span class="row-count">${cards.length}</span></div><div class="lib-grid"></div>`;
  const grid = sec.querySelector('.lib-grid');
  cards.forEach((c) => grid.appendChild(c));
  rowsEl.appendChild(sec);
  document.getElementById('grid-back').addEventListener('click', renderView);
}

function mixedRecent(n) {
  const m = movies.map((x) => ({ x, kind: 'movie' }));
  const s = shows.map((x) => ({ x, kind: 'show' }));
  return [...m, ...s]
    .sort((a, b) => (b.x.added_at || 0) - (a.x.added_at || 0))
    .slice(0, n)
    .map(({ x, kind }) => buildMediaCard(x, kind));
}

// ---------- Hero ----------
// A deterministic weekly shuffle: the featured set stays the same all week,
// then rotates to a fresh set the next week (same for every device, since it's
// seeded by the week number — not re-randomized on each load).
function weeklyPick(items, n) {
  const pool = (items || []).slice();
  if (pool.length <= n) return pool;
  let s = (Math.floor(Date.now() / 604800000) * 2654435761) >>> 0; // seed = weeks since epoch
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = pool.length - 1; i > 0; i--) { // seeded Fisher–Yates
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function setHero(items) {
  // The hero has a local Play button, so never feature deep-link-only streaming
  // titles there — they live in the rows/grids with a provider badge instead.
  heroItems = weeklyPick(items.filter((x) => x.source !== 'stream'), 6);
  heroIdx = 0;
  if (heroTimer) clearInterval(heroTimer);
  if (!heroItems.length) { heroEl.classList.add('hidden'); return; }
  heroEl.classList.remove('hidden');
  drawHero();
  heroTimer = setInterval(() => { heroIdx = (heroIdx + 1) % heroItems.length; drawHero(); }, 9000);
}

function drawHero() {
  const it = heroItems[heroIdx];
  const kind = it.episodes !== undefined ? 'show' : 'movie';
  heroBg.style.backgroundImage = `url("${it.backdrop || it.poster}")`;
  heroContent.innerHTML = `
    <h2 class="hero-title">${escapeHtml(it.title)}</h2>
    <div class="hero-meta">
      ${it.year ? `<span class="chip">${it.year}</span>` : ''}
      ${it.rating ? `<span class="chip rating">★ ${it.rating.toFixed(1)}</span>` : ''}
      ${kind === 'show' ? `<span class="chip">${it.episodes} episodes</span>` : (it.qualities ? `<span class="chip q">${it.qualities.split(',').sort().reverse()[0]}</span>` : '')}
    </div>
    <p class="hero-overview">${escapeHtml(it.overview || '')}</p>
    <div class="hero-actions">
      <button class="btn btn-play" id="hero-play">▶ Play</button>
      <button class="btn" id="hero-info">ⓘ More Info</button>
    </div>`;
  heroDots.innerHTML = heroItems.map((_, i) => `<button class="hero-dot${i === heroIdx ? ' active' : ''}" data-i="${i}"></button>`).join('');
  heroDots.querySelectorAll('.hero-dot').forEach((d) => d.addEventListener('click', () => { heroIdx = +d.dataset.i; drawHero(); }));
  document.getElementById('hero-play').addEventListener('click', () => openMedia(it, kind, true));
  document.getElementById('hero-info').addEventListener('click', () => openMedia(it, kind, false));
}

// ---------- Rows & cards ----------
function drawRows(rows) {
  rowsEl.innerHTML = '';
  for (const r of rows) {
    if (!r.cards.length) continue;
    if (r.grid) {
      const sec = document.createElement('section');
      sec.className = 'row';
      sec.innerHTML = `<div class="row-head"><h3 class="row-title">${escapeHtml(r.title)}</h3><span class="row-count">${r.cards.length}</span></div><div class="lib-grid"></div>`;
      const grid = sec.querySelector('.lib-grid');
      r.cards.forEach((c) => grid.appendChild(c));
      rowsEl.appendChild(sec);
      continue;
    }
    const row = document.createElement('section');
    row.className = 'row';
    row.innerHTML = `<div class="row-head"><h3 class="row-title">${escapeHtml(r.title)}</h3>${r.seeAll ? '<button class="see-all">See all ›</button>' : ''}</div>
      <button class="row-nav left">‹</button><div class="row-track"></div><button class="row-nav right">›</button>`;
    const track = row.querySelector('.row-track');
    r.cards.forEach((c) => track.appendChild(c));
    row.querySelector('.row-nav.left').addEventListener('click', () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' }));
    row.querySelector('.row-nav.right').addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' }));
    const sa = row.querySelector('.see-all');
    if (sa) sa.addEventListener('click', () => { const g = r.seeAll(); showGridView(g.title, g.cards); });
    rowsEl.appendChild(row);
  }
}

function mediaCards(list, kind) { return list.map((it) => buildMediaCard(it, kind)); }

// Streaming services we can badge + deep-link to (mirrors src/streaming.js).
// `search(q)` opens the service itself to that title — the badge already says
// where it is, so we go straight to the service, not an info page. (True exact-
// title / native-app launch needs each service's own content id, which no public
// data gives us, so we open the service's title search — lands you in the app.)
const STREAM_PROVIDERS = {
  netflix:   { name: 'Netflix',     color: '#e50914', search: (q) => `https://www.netflix.com/search?q=${q}` },
  prime:     { name: 'Prime Video', color: '#1399ff', search: (q) => `https://www.primevideo.com/search/?phrase=${q}` },
  disney:    { name: 'Disney+',     color: '#0a63e6', search: (q) => `https://www.disneyplus.com/search?q=${q}` },
  hulu:      { name: 'Hulu',        color: '#1ce783', search: (q) => `https://www.hulu.com/search?q=${q}` },
  max:       { name: 'Max',         color: '#a05cff', search: (q) => `https://play.max.com/search?q=${q}` },
  appletv:   { name: 'Apple TV+',   color: '#7d7d7d', search: (q) => `https://tv.apple.com/search?term=${q}` },
  paramount: { name: 'Paramount+',  color: '#0064ff', search: (q) => `https://www.paramountplus.com/search/?query=${q}` },
  peacock:   { name: 'Peacock',     color: '#00b7eb', search: (q) => `https://www.peacocktv.com/search?q=${q}` }
};

// A streaming (not-owned) title: shows a provider badge and, instead of playing
// locally, opens the service (DRM means we can't proxy the video).
function streamCard(it) {
  const provs = it.providers || [];
  const p = STREAM_PROVIDERS[provs[0]] || { name: provs[0] || 'Streaming', color: '#555' };
  const badge = `<div class="badge stream" style="background:${p.color}">${escapeHtml(p.name)}${provs.length > 1 ? ` +${provs.length - 1}` : ''}</div>`;
  return cardEl({ poster: it.poster, title: it.title, sub: it.year || '', badge, pct: 0, stream: p.name,
    onOpen: () => openStream(it), onPlay: () => openStream(it) });
}

// Open a service directly to this title (its search), not a TMDB page. Inside the
// Android TV app, hand the URL to the native bridge so it launches the real
// service app; in a browser, open it in a new tab.
function openService(slug, title) {
  const p = STREAM_PROVIDERS[slug];
  const url = p && p.search ? p.search(encodeURIComponent(title || '')) : null;
  if (!url) return;
  if (window.MarqueeTV && typeof window.MarqueeTV.openApp === 'function') window.MarqueeTV.openApp(url);
  else window.open(url, '_blank', 'noopener');
}
function openStream(it) { openService((it.providers || [])[0], it.title); }

function buildMediaCard(it, kind) {
  if (it.source === 'stream') return streamCard(it);
  const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
  let badge = '';
  if (kind === 'show' && it.unwatched > 0) badge = `<div class="badge new">${it.unwatched} new</div>`;
  else if (isNew(it)) badge = `<div class="badge new">NEW</div>`;
  else if (kind === 'movie' && it.versions > 1 && it.qualities) badge = `<div class="badge">${it.qualities.split(',').sort().reverse()[0]}</div>`;
  // Owned, but also streamable on an enabled service — flag it (top-left).
  if (it.alsoOn && it.alsoOn.length) {
    const ap = STREAM_PROVIDERS[it.alsoOn[0]] || { name: it.alsoOn[0], color: '#555' };
    badge += `<div class="badge alsoon" style="--c:${ap.color}">▸ ${escapeHtml(ap.name)}${it.alsoOn.length > 1 ? ` +${it.alsoOn.length - 1}` : ''}</div>`;
  }
  const sub = kind === 'show' ? `${it.episodes} episode${it.episodes === 1 ? '' : 's'}` : (it.year || '');
  return cardEl({
    poster: it.poster, title: it.title, sub, badge, pct,
    onOpen: () => openMedia(it, kind, false),
    onPlay: () => openMedia(it, kind, true),
    watched: kind === 'movie' ? { on: !!it.watched, toggle: () => toggleMovieWatched(it) } : null
  });
}

function continueCards(items) {
  return items.map((it) => {
    const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
    const sub = it.kind === 'episode' ? `S${it.season}·E${String(it.episode).padStart(2, '0')}` : 'Movie';
    return cardEl({
      poster: it.poster, title: it.title, sub, badge: '', pct,
      onOpen: () => openContinue(it, false),
      onPlay: () => openContinue(it, true),
      dismiss: () => dismissContinue(it)
    });
  });
}

function cardEl(cfg) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="poster">
      ${cfg.poster ? `<img src="${cfg.poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(cfg.title)}</span>`}
      ${cfg.badge || ''}
      ${cfg.pct > 1 ? `<div class="prog"><i style="width:${cfg.pct}%"></i></div>` : ''}
      <div class="card-info">
        <div class="ci-title">${escapeHtml(cfg.title)}</div>
        <div class="card-actions">
          <button class="round play" title="Play">▶</button>
          ${cfg.watched ? `<button class="round wq${cfg.watched.on ? ' on' : ''}" title="Watched">✓</button>` : ''}
          ${cfg.dismiss ? `<button class="round" title="Mark watched">✓</button>` : ''}
        </div>
        ${cfg.sub ? `<div class="card-sub">${escapeHtml(cfg.sub)}</div>` : ''}
      </div>
    </div>`;
  card.addEventListener('click', cfg.onOpen);
  card.querySelector('.round.play').addEventListener('click', (e) => { e.stopPropagation(); cfg.onPlay(); });
  const wq = card.querySelector('.round.wq');
  if (wq && cfg.watched) wq.addEventListener('click', (e) => { e.stopPropagation(); cfg.watched.toggle(); wq.classList.toggle('on'); });
  const dq = cfg.dismiss ? card.querySelector('.card-actions .round:last-child') : null;
  if (dq && cfg.dismiss) dq.addEventListener('click', (e) => { e.stopPropagation(); cfg.dismiss(); });
  return card;
}

function openMedia(it, kind, autoplay) {
  if (kind === 'show') openShow(it.id, null, autoplay);
  else openDetail(it.id, autoplay);
}
function openContinue(it, autoplay) {
  if (it.kind === 'movie') openDetail(it.id, autoplay);
  else openShow(it.show_id, autoplay ? it.id : null, autoplay);
}
async function dismissContinue(it) {
  const url = it.kind === 'movie' ? `/api/movies/${it.id}/watched` : `/api/episodes/${it.id}/watched`;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: 1 }) });
  continueItems = continueItems.filter((x) => !(x.kind === it.kind && x.id === it.id));
  renderView();
}
async function toggleMovieWatched(it) {
  const next = it.watched ? 0 : 1;
  await fetch(`/api/movies/${it.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
  it.watched = next; if (next) it.resume_position = 0;
}

// ---------- Movie detail (full page) ----------
function fmtSize(n) { if (!n) return ''; const gb = n / 1e9; return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB'; }
function fileTags(name) {
  const s = (name || '').toLowerCase(); const t = [];
  if (/x ?265|h ?265|hevc/.test(s)) t.push('HEVC'); else if (/x ?264|h ?264|avc/.test(s)) t.push('H.264');
  if (/blu-?ray|bdrip|brrip/.test(s)) t.push('BluRay'); else if (/web-?dl|webrip|\bweb\b/.test(s)) t.push('WEB'); else if (/hdtv/.test(s)) t.push('HDTV'); else if (/dvd/.test(s)) t.push('DVD');
  if (/hdr|dolby ?vision|dovi/.test(s)) t.push('HDR');
  if (/atmos|truehd|\bdts\b/.test(s)) t.push('Surround');
  return t;
}
function versionLabel(f, i) {
  const parts = [f.quality || 'Version ' + (i + 1)];
  const sz = fmtSize(f.size); if (sz) parts.push(sz);
  const tags = fileTags(f.filename); if (tags.length) parts.push(tags.join(' · '));
  return parts.join('   ·   ');
}
// Version memory (server-backed): this title's last-played version first
// (verid:m12 / verid:e34 → file id), then the last quality picked anywhere
// (pq), then the first file.
function preferredFile(files, key) {
  if (key) {
    const f = files.find((x) => x.id === +getPref('verid:' + key));
    if (f) return f;
  }
  const pq = getPref('pq');
  return (pq && files.find((f) => f.quality === pq)) || files[0] || null;
}
function rememberVersion(key, f) {
  if (!f) return;
  if (key) setPref('verid:' + key, f.id);
  if (f.quality) setPref('pq', f.quality);
}
function playTrailer(key) {
  const ov = document.createElement('div');
  ov.className = 'update-overlay'; ov.style.zIndex = 90;
  ov.innerHTML = `<div style="width:min(92vw,1040px);aspect-ratio:16/9;position:relative">
    <iframe src="https://www.youtube.com/embed/${key}?autoplay=1" allow="autoplay; fullscreen" allowfullscreen
      style="width:100%;height:100%;border:0;border-radius:12px"></iframe></div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

// Admin: permanently delete a file from the server (physical file + library
// entry), after a clear confirmation. Used by the movie and episode detail pages.
async function deleteFileFromServer(kind, file, onDone) {
  if (!file) return;
  if (!confirm(`Delete this file from the server?\n\n${file.filename}\n\nThis permanently removes it from disk and cannot be undone.`)) return;
  const r = await fetch(`/api/file/${kind}/${file.id}`, { method: 'DELETE' });
  if (!r.ok) { const d = await r.json().catch(() => ({})); alert('Delete failed: ' + (d.error || r.status)); return; }
  if (onDone) onDone();
}
const isAdmin = () => document.body.classList.contains('is-admin');

async function openDetail(id, autoplay = true) {
  const [m, extra] = await Promise.all([
    fetch('/api/movies/' + id).then((r) => r.json()),
    fetch('/api/movies/' + id + '/extra').then((r) => r.json()).catch(() => ({}))
  ]);
  const files = m.files || [];
  let current = preferredFile(files, 'm' + m.id);
  const resume = m.resume_position && m.resume_position > 5 ? m.resume_position : 0;
  const runtime = extra.runtime ? `${Math.floor(extra.runtime / 60)}h ${extra.runtime % 60}m` : '';
  const genres = extra.genres || [];

  const versionControl = files.length > 1
    ? `<span class="dp-version"><span>Version</span><select class="dp-select" id="ver-select">${files.map((f, i) => `<option value="${f.id}">${escapeHtml(versionLabel(f, i))}</option>`).join('')}</select></span>`
    : (current ? `<span class="dp-version"><span>${escapeHtml(versionLabel(current, 0))}</span></span>` : '');

  detailInner.innerHTML = `
    <div class="dp-splash" id="dp-splash" style="background-image:url('${m.backdrop || m.poster || ''}')">
      <div class="dp-hero">
        <div class="dp-poster">${m.poster ? `<img src="${m.poster}" alt="">` : ''}</div>
        <div class="dp-info">
          <h1 class="dp-title">${escapeHtml(m.title)}</h1>
          <div class="dp-meta">
            ${m.year ? `<span class="chip">${m.year}</span>` : ''}
            ${m.rating ? `<span class="chip rating">★ ${m.rating.toFixed(1)}</span>` : ''}
            ${runtime ? `<span class="chip">${runtime}</span>` : ''}
            ${current && current.quality ? `<span class="chip q">${current.quality}</span>` : ''}
          </div>
          ${genres.length ? `<div class="dp-genres">${genres.map((g) => `<span class="dp-genre">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
          <div class="dp-actions">
            <span id="d-playbtns"></span>
            <button class="btn" id="favBtn">${m.favorite ? '★ Favorited' : '☆ Favorite'}</button>
            <button class="btn" id="watchedBtn">${m.watched ? '✓ Watched' : 'Mark watched'}</button>
            ${(extra.alsoOn || []).map((slug) => { const p = STREAM_PROVIDERS[slug]; return p ? `<button class="btn btn-stream" data-slug="${slug}" style="--c:${p.color}">${escapeHtml(p.name)} ▸</button>` : ''; }).join('')}
            ${versionControl}
            ${isAdmin() && current ? `<button class="btn btn-danger" id="del-file" title="Delete this file from the server">🗑 Delete file</button>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="dp-body">
      ${extra.tagline ? `<p class="dp-tagline">${escapeHtml(extra.tagline)}</p>` : ''}
      <p class="overview">${escapeHtml(m.overview || 'No description yet.')}</p>
      ${current ? `<p class="filename">${escapeHtml(current.filename)}</p>` : ''}
      <div id="dp-sections"></div>
    </div>`;
  openDetailModal();
  detail.scrollTop = 0;

  // "Open on Netflix ▸" buttons → launch that service to this title.
  detailInner.querySelectorAll('.btn-stream').forEach((b) => b.addEventListener('click', () => openService(b.dataset.slug, m.title)));

  const sel = document.getElementById('ver-select');
  if (sel && current) sel.value = String(current.id); // reflect the remembered version
  if (sel) sel.addEventListener('change', () => { const f = files.find((x) => String(x.id) === sel.value); if (f) { current = f; rememberVersion('m' + m.id, f); } });

  // Admin: delete the currently-selected version's file from the server, then
  // close the detail and refresh the library (the movie vanishes if that was its
  // last version).
  const delBtn = document.getElementById('del-file');
  if (delBtn) delBtn.addEventListener('click', () => deleteFileFromServer('movie', current, closeDetail));

  function play(at) {
    openPlayer({
      title: m.title, files, startFileId: current.id, verKey: 'm' + m.id,
      streamBase: '/api/stream/', subtitleBase: '/api/subtitle/', searchKind: 'movie',
      startAt: at, progressUrl: `/api/movies/${m.id}/progress`, upNext: null, onEnded: null
    });
  }
  // Re-render the play button(s) so "Resume / From beginning" appears only when
  // there's actually a resume point. Marking watched clears it (and marking
  // unwatched does NOT bring it back), so those toggles update this live.
  let resumeAt = resume;
  const playBtns = document.getElementById('d-playbtns');
  function renderPlayBtns() {
    playBtns.innerHTML = resumeAt
      ? `<button class="btn btn-play" id="d-resume">▶ Resume</button><button class="btn" id="d-begin">↺ From beginning</button>`
      : `<button class="btn btn-play" id="d-play">▶ Play</button>`;
    if (resumeAt) {
      document.getElementById('d-resume').addEventListener('click', () => play(resumeAt));
      document.getElementById('d-begin').addEventListener('click', () => play(0));
    } else {
      document.getElementById('d-play').addEventListener('click', () => play(0));
    }
  }
  renderPlayBtns();
  if (autoplay) play(resumeAt || 0);

  document.getElementById('favBtn').addEventListener('click', async (e) => {
    const { favorite } = await (await fetch(`/api/movies/${m.id}/favorite`, { method: 'POST' })).json();
    e.target.textContent = favorite ? '★ Favorited' : '☆ Favorite';
  });
  document.getElementById('watchedBtn').addEventListener('click', async (e) => {
    const next = m.watched ? 0 : 1;
    await fetch(`/api/movies/${m.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    m.watched = next; e.target.textContent = next ? '✓ Watched' : 'Mark watched';
    if (next) { resumeAt = 0; m.resume_position = 0; } // watched clears the resume point
    renderPlayBtns();
  });

  // Cast & Crew, Trailers, More Like This
  const sections = document.getElementById('dp-sections');
  let html = '';
  const people = [];
  (extra.directors || []).forEach((d) => people.push({ name: d, role: 'Director', profile: null }));
  (extra.cast || []).forEach((c) => people.push({ name: c.name, role: c.character, profile: c.profile }));
  if (people.length) {
    html += `<div class="dp-section"><h3>Cast & Crew</h3><div class="dp-hscroll">${people.map((p) => `
      <div class="person">
        ${p.profile ? `<img class="pfp" src="${p.profile}" alt="">` : `<div class="pfp ph">${escapeHtml((p.name || '?')[0])}</div>`}
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="prole">${escapeHtml(p.role || '')}</div>
      </div>`).join('')}</div></div>`;
  }
  if (extra.collection && extra.collection.parts && extra.collection.parts.length > 1) {
    const parts = extra.collection.parts.filter((p) => p.poster);
    html += `<div class="dp-section"><h3>${escapeHtml(extra.collection.name)}</h3><div class="dp-hscroll">${parts.map((p) => `
      <div class="rec${p.localId ? ' owned' : ''}" data-local="${p.localId || ''}">
        <div class="poster"><img src="${p.poster}" alt="" loading="lazy"></div>
        <div class="rec-title">${escapeHtml(p.title)}${p.year ? ' (' + p.year + ')' : ''}</div>
      </div>`).join('')}</div></div>`;
  }
  if (extra.trailer) {
    html += `<div class="dp-section"><h3>Trailers &amp; Extras</h3><div class="dp-hscroll">
      <div class="trailer-card" data-key="${extra.trailer.key}">
        <div class="trailer-thumb" style="background-image:url('https://img.youtube.com/vi/${extra.trailer.key}/hqdefault.jpg')"></div>
        <div class="trailer-name">${escapeHtml(extra.trailer.name || 'Trailer')}</div>
      </div></div></div>`;
  }
  const recs = (extra.recommendations || []).filter((r) => r.poster);
  if (recs.length) {
    html += `<div class="dp-section"><h3>More Like This</h3><div class="dp-hscroll">${recs.map((r) => `
      <div class="rec${r.localId ? ' owned' : ''}" data-local="${r.localId || ''}">
        <div class="poster"><img src="${r.poster}" alt="" loading="lazy"></div>
        <div class="rec-title">${escapeHtml(r.title)}</div>
      </div>`).join('')}</div></div>`;
  }
  sections.innerHTML = html;
  sections.querySelectorAll('.trailer-card').forEach((c) => c.addEventListener('click', () => playTrailer(c.dataset.key)));
  sections.querySelectorAll('.rec.owned').forEach((c) => c.addEventListener('click', () => openDetail(+c.dataset.local, false)));
}

// ---------- Episode play + detail ----------
function episodeSub(ep) {
  return `S${ep.season}·E${String(ep.episode).padStart(2, '0')}${ep.title ? ' · ' + ep.title : ''}`;
}

function playEpisodeAt(show, flat, i, opts = {}) {
  if (i < 0 || i >= flat.length) return;
  const ep = flat[i].ep;
  const files = ep.files || [];
  if (!files.length) return;
  const next = flat[i + 1];
  openPlayer({
    title: show.title,
    subtitle: episodeSub(ep),
    files, startFileId: opts.fileId || preferredFile(files, 'e' + ep.id).id, verKey: 'e' + ep.id,
    streamBase: '/api/stream/episode/', subtitleBase: '/api/subtitle/episode/', searchKind: 'episode',
    startAt: opts.startAt != null ? opts.startAt : (ep.resume_position > 5 ? ep.resume_position : 0),
    progressUrl: `/api/episodes/${ep.id}/progress`,
    upNext: next ? { label: 'Up Next', still: next.ep.still || show.backdrop || show.poster || '', title: episodeSub(next.ep), play: () => playEpisodeAt(show, flat, i + 1) } : null,
    onEnded: next ? () => playEpisodeAt(show, flat, i + 1) : null
  });
}

async function openEpisodeDetail(show, flat, i) {
  const ep = flat[i].ep;
  const files = ep.files || [];
  let current = preferredFile(files, 'e' + ep.id);
  const resume = ep.resume_position && ep.resume_position > 5 ? ep.resume_position : 0;
  const extra = await fetch(`/api/episodes/${ep.id}/extra`).then((r) => r.json()).catch(() => ({}));
  const still = extra.still || ep.still || show.backdrop || show.poster || '';
  const overview = extra.overview || ep.overview || 'No description.';
  const versionControl = files.length > 1
    ? `<span class="dp-version"><span>Version</span><select class="dp-select" id="ep-ver">${files.map((f, k) => `<option value="${f.id}">${escapeHtml(versionLabel(f, k))}</option>`).join('')}</select></span>`
    : (current ? `<span class="dp-version"><span>${escapeHtml(versionLabel(current, 0))}</span></span>` : '');

  detailInner.innerHTML = `
    <div class="dp-splash" style="background-image:url('${still}')">
      <div class="dp-hero">
        <div class="dp-poster">${ep.still || show.poster ? `<img src="${ep.still || show.poster}" alt="">` : ''}</div>
        <div class="dp-info">
          <button class="btn sm" id="ep-back" style="margin-bottom:14px">‹ ${escapeHtml(show.title)}</button>
          <h1 class="dp-title" style="font-size:clamp(24px,3.6vw,42px)">${escapeHtml(episodeSub(ep))}</h1>
          <div class="dp-meta">
            ${extra.airDate ? `<span class="chip">${escapeHtml(extra.airDate)}</span>` : ''}
            ${extra.rating ? `<span class="chip rating">★ ${extra.rating.toFixed(1)}</span>` : ''}
            ${extra.runtime ? `<span class="chip">${extra.runtime}m</span>` : ''}
            ${current && current.quality ? `<span class="chip q">${current.quality}</span>` : ''}
          </div>
          <div class="dp-actions">
            <span id="ep-playbtns"></span>
            <button class="btn" id="ep-watched">${ep.watched ? '✓ Watched' : 'Mark watched'}</button>
            ${versionControl}
            ${isAdmin() && current ? `<button class="btn btn-danger" id="ep-del-file" title="Delete this file from the server">🗑 Delete file</button>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="dp-body">
      <p class="overview">${escapeHtml(overview)}</p>
      <div id="ep-sections"></div>
    </div>`;
  openDetailModal();
  detail.scrollTop = 0;

  const people = extra.people || [];
  if (people.length) {
    document.getElementById('ep-sections').innerHTML = `<div class="dp-section"><h3>Cast &amp; Crew</h3><div class="dp-hscroll">${people.map((p) => `
      <div class="person">
        ${p.profile ? `<img class="pfp" src="${p.profile}" alt="">` : `<div class="pfp ph">${escapeHtml((p.name || '?')[0])}</div>`}
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="prole">${escapeHtml(p.role || '')}</div>
      </div>`).join('')}</div></div>`;
  }

  const sel = document.getElementById('ep-ver');
  if (sel && current) sel.value = String(current.id); // reflect the remembered version
  if (sel) sel.addEventListener('change', () => { const f = files.find((x) => String(x.id) === sel.value); if (f) { current = f; rememberVersion('e' + ep.id, f); } });
  // Admin: delete this episode file from the server, then reopen the show (the
  // episode drops off if that was its last version).
  const epDelBtn = document.getElementById('ep-del-file');
  if (epDelBtn) epDelBtn.addEventListener('click', () => deleteFileFromServer('episode', current, () => { closeDetail(); }));
  const playAt = (at) => playEpisodeAt(show, flat, i, { fileId: current.id, startAt: at });
  let resumeAt = resume;
  const epPlayBtns = document.getElementById('ep-playbtns');
  function renderEpPlayBtns() {
    epPlayBtns.innerHTML = resumeAt
      ? `<button class="btn btn-play" id="ep-resume">▶ Resume</button><button class="btn" id="ep-begin">↺ From beginning</button>`
      : `<button class="btn btn-play" id="ep-play">▶ Play</button>`;
    if (resumeAt) {
      document.getElementById('ep-resume').addEventListener('click', () => playAt(resumeAt));
      document.getElementById('ep-begin').addEventListener('click', () => playAt(0));
    } else {
      document.getElementById('ep-play').addEventListener('click', () => playAt(0));
    }
  }
  renderEpPlayBtns();
  document.getElementById('ep-watched').addEventListener('click', async (e) => {
    const next = ep.watched ? 0 : 1;
    await fetch(`/api/episodes/${ep.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    ep.watched = next; e.target.textContent = next ? '✓ Watched' : 'Mark watched';
    if (next) { resumeAt = 0; ep.resume_position = 0; }
    renderEpPlayBtns();
  });
  document.getElementById('ep-back').addEventListener('click', () => openShow(show.id, null, false));
}

// ---------- Show detail ----------
async function openShow(id, autoEpId, autoplay = true) {
  const [show, extra] = await Promise.all([
    fetch('/api/shows/' + id).then((r) => r.json()),
    fetch('/api/shows/' + id + '/extra').then((r) => r.json()).catch(() => ({ seasons: [] }))
  ]);
  const seasons = show.seasons || [];
  const seasonPoster = {};
  (extra.seasons || []).forEach((s) => { seasonPoster[s.season] = s.poster; });

  detailInner.innerHTML = `
    <div class="dp-splash" style="background-image:url('${show.backdrop || show.poster || ''}')">
      <div class="dp-hero">
        <div class="dp-poster">${show.poster ? `<img src="${show.poster}" alt="">` : ''}</div>
        <div class="dp-info">
          <h1 class="dp-title">${escapeHtml(show.title)}</h1>
          <div class="dp-meta">
            ${show.year ? `<span class="chip">${show.year}</span>` : ''}
            ${show.rating ? `<span class="chip rating">★ ${show.rating.toFixed(1)}</span>` : ''}
            <span class="chip">${show.episodeCount} episode${show.episodeCount === 1 ? '' : 's'}</span>
          </div>
          <div class="dp-actions"><button class="btn btn-play" id="s-play">▶ Play</button><button class="btn" id="s-watched"></button></div>
        </div>
      </div>
    </div>
    <div class="dp-body">
      <p class="overview">${escapeHtml(show.overview || '')}</p>
      <h3 class="seasons-h">Seasons</h3>
      <div class="season-cards" id="season-cards"></div>
      <div class="episode-tools" id="episode-tools"></div>
      <div class="episode-list" id="episode-list"></div>
    </div>`;
  openDetailModal();
  detail.scrollTop = 0;

  const seasonCards = document.getElementById('season-cards');
  const epList = document.getElementById('episode-list');
  const epTools = document.getElementById('episode-tools');
  const seasonLabel = (s) => (s === 0 ? 'Specials' : 'Season ' + s);

  const flat = [];
  seasons.forEach((s, si) => s.episodes.forEach((ep) => flat.push({ ep, si })));
  let activeSeason = seasons[0];

  document.getElementById('s-play').addEventListener('click', () => {
    const idx = flat.findIndex((f) => !f.ep.watched);
    playEpisodeAt(show, flat, idx >= 0 ? idx : 0);
  });

  // Mark the whole show watched/unwatched (bulk).
  const sWatched = document.getElementById('s-watched');
  function refreshShowWatchedBtn() {
    const all = flat.length && flat.every((f) => f.ep.watched);
    sWatched.textContent = all ? '✓ Show watched' : 'Mark show watched';
    sWatched.dataset.all = all ? '1' : '0';
  }
  refreshShowWatchedBtn();
  sWatched.addEventListener('click', async () => {
    const next = sWatched.dataset.all === '1' ? 0 : 1;
    sWatched.disabled = true;
    await fetch(`/api/shows/${show.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    flat.forEach((f) => { f.ep.watched = next; if (next) f.ep.resume_position = 0; });
    sWatched.disabled = false;
    refreshShowWatchedBtn(); renderSeason(activeSeason);
  });

  // Per-season "mark season watched" toolbar, redrawn with each season.
  function refreshSeasonTools(seasonObj) {
    const all = seasonObj.episodes.length && seasonObj.episodes.every((e) => e.watched);
    epTools.innerHTML = `<span class="et-label">${escapeHtml(seasonLabel(seasonObj.season))} · ${seasonObj.episodes.length} episodes</span>
      <button class="btn sm" id="season-watched">${all ? '✓ Season watched' : 'Mark season watched'}</button>`;
    document.getElementById('season-watched').addEventListener('click', async (e) => {
      const next = all ? 0 : 1;
      e.target.disabled = true;
      await fetch(`/api/shows/${show.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next, season: seasonObj.season }) });
      seasonObj.episodes.forEach((ep) => { ep.watched = next; if (next) ep.resume_position = 0; });
      renderSeason(seasonObj); refreshShowWatchedBtn();
    });
  }

  function renderSeason(seasonObj) {
    activeSeason = seasonObj;
    refreshSeasonTools(seasonObj);
    epList.innerHTML = '';
    for (const ep of seasonObj.episodes) {
      const row = document.createElement('div');
      row.className = 'episode';
      const pct = ep.duration && ep.resume_position ? Math.min(100, (ep.resume_position / ep.duration) * 100) : 0;
      const quals = [...new Set((ep.files || []).map((f) => f.quality).filter(Boolean))];
      row.innerHTML = `
        ${ep.still ? `<img class="ethumb" src="${ep.still}" alt="" loading="lazy">` : '<div class="ethumb"></div>'}
        <span class="enum">${ep.season}·${String(ep.episode).padStart(2, '0')}</span>
        <div class="ebody">
          <div class="etitle">${escapeHtml(ep.title || 'Episode ' + ep.episode)}${quals.length ? ' · ' + quals.join('/') : ''}</div>
          ${ep.overview ? `<div class="eover">${escapeHtml(ep.overview)}</div>` : ''}
        </div>
        <button class="wtoggle${ep.watched ? ' on' : ''}" title="Watched">${ep.watched ? '✓' : '○'}</button>
        ${pct > 1 ? `<div class="eprog" style="width:${pct}%"></div>` : ''}`;
      const fi = flat.findIndex((f) => f.ep.id === ep.id);
      row.addEventListener('click', () => openEpisodeDetail(show, flat, fi));
      row.querySelector('.wtoggle').addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = ep.watched ? 0 : 1;
        await fetch(`/api/episodes/${ep.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
        ep.watched = next; if (next) { ep.resume_position = 0; const _pr = row.querySelector('.eprog'); if (_pr) _pr.remove(); }
        e.target.textContent = next ? '✓' : '○'; e.target.classList.toggle('on', !!next);
      });
      epList.appendChild(row);
    }
  }

  seasons.forEach((s, i) => {
    const poster = seasonPoster[s.season] || show.poster || '';
    const card = document.createElement('div');
    card.className = 'season-card' + (i === 0 ? ' active' : '');
    card.innerHTML = `
      <div class="sc-poster">${poster ? `<img src="${poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(seasonLabel(s.season))}</span>`}</div>
      <div class="sc-label">${escapeHtml(seasonLabel(s.season))}</div>
      <div class="sc-count">${s.episodes.length} ep</div>`;
    card.addEventListener('click', () => {
      seasonCards.querySelectorAll('.season-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      renderSeason(s);
    });
    seasonCards.appendChild(card);
  });
  if (seasons.length) renderSeason(seasons[0]);

  if (autoEpId) { const fi = flat.findIndex((f) => f.ep.id === autoEpId); if (fi >= 0) playEpisodeAt(show, flat, fi); }
  else if (autoplay && flat.length) { const idx = flat.findIndex((f) => !f.ep.watched); playEpisodeAt(show, flat, idx >= 0 ? idx : 0); }
}

// Save playback position periodically; onEnd optional (auto-advance).
function bindProgress(player, url, onEnd) {
  let last = 0;
  const save = () => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position: player.currentTime, duration: player.duration || null,
      watched: player.duration && player.currentTime / player.duration > 0.92 ? 1 : null
    })
  });
  player.ontimeupdate = () => { if (Date.now() - last > 5000) { last = Date.now(); save(); } };
  player.onpause = save;
  player.onended = () => { save(); if (onEnd) onEnd(); };
}

// ---------- Theater video player ----------
let activePlayer = null;
// Tear down the player and stop its audio. The player overlay lives on <body>
// (not inside the detail/view), so any "leave to browse" path must call this or
// the video keeps playing in the background. `.remove()` is overridden per player
// to hard-stop every <video> (see openPlayer) — detaching alone doesn't.
function stopActivePlayer() {
  if (activePlayer) { activePlayer.remove(); activePlayer = null; }
}

function fmtTime(t) {
  if (!t || isNaN(t)) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6"/></svg>',
  volHigh: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm13 2a4 4 0 0 0-2-3.46v6.92A4 4 0 0 0 16 12zm-2-7.5v2.06a6 6 0 0 1 0 10.88v2.06a8 8 0 0 0 0-15z"/></svg>',
  volMute: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zm18.3 2 1.4-1.4L21.4 9 20 10.6 18.4 9 17 10.4 18.6 12 17 13.6 18.4 15 20 13.4 21.6 15 23 13.6z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1l-.4-2.5H10.9l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-.9-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-.9c.5.4 1.1.7 1.7 1l.3 2.5h4.2l.4-2.5c.6-.3 1.2-.6 1.7-1l2.3.9 2-3.4-2-1.5zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  // Skip-to-next glyph for the Skip Intro/Credits labels (was the ⏭ emoji, which
  // renders blank on Google TV's stripped font — same bug the nav gear had).
  skipnext: '<svg class="skip-ico" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 5l8.5 7L6 19V5zm10.5 0H19v14h-2.5V5z"/></svg>'
};

// Pre-roll info (server-wide) is prefetched so the player can start it inside a
// click gesture (autoplay-with-sound). Refreshed on load and when the admin saves.
let prerollInfo = null;
async function refreshPreroll() {
  try { const r = await (await fetch('/api/preroll')).json(); prerollInfo = r && r.available ? r : null; }
  catch (_e) { prerollInfo = null; }
}

function openPlayer(ctx) {
  if (activePlayer) { activePlayer.remove(); activePlayer = null; }
  let current = ctx.files.find((f) => f.id === ctx.startFileId) || ctx.files[0];
  if (!current) return;
  let subOffset = 0;
  let cues = [];
  let subVisible = true;
  let currentSubIdx = -1;
  let upnextShown = false;
  const subUrl = (idx) => withToken(`${ctx.subtitleBase}${current.id}?idx=${idx}`);
  // Caption delay is remembered per file+track (server-side) and restored
  // next time — on any device.
  const delayKey = () => `sd:${current.id}:${currentSubIdx}`;
  const loadDelay = () => { subOffset = parseFloat(getPref(delayKey())) || 0; };
  const saveDelay = () => { setPref(delayKey(), subOffset || null); };

  // Playback mode: `direct` (native range streaming, seekable) or `transcode`
  // (ffmpeg fragmented-MP4 pipe for formats the browser can't play). Transcode
  // streams always begin at 0, so the player keeps a virtual timeline: real
  // position = base + video.currentTime, and seeking restarts the stream.
  let play = { mode: 'direct', duration: null, url: '', reason: null };
  let base = 0;
  let curEngine = null; // server's engine info for this file (admin clients only)
  // A stable id for this player instance, so the admin "Now Playing" monitor can
  // track one viewer across heartbeats and tell two devices/tabs apart.
  const sessionId = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const cur = () => (play.mode === 'transcode' ? base + video.currentTime : video.currentTime);
  const dur = () => play.duration || video.duration || 0;
  // Remuxed (copied) video can only start on a keyframe — the server emits from
  // the one BEFORE the requested time. Ask where the stream will really begin and
  // use that as the timeline base, or position/subtitles drift by the gap and the
  // first seconds play video over padded silence ("audio lags after seek/resume").
  async function resolveStart(t) {
    if (!(t > 0)) return 0;
    try {
      const r = await (await fetch(`/api/seekpoint/${ctx.searchKind}/${current.id}?start=${t.toFixed(2)}&${audioQuery()}`)).json();
      if (r && typeof r.start === 'number' && r.start >= 0 && r.start <= t) return r.start;
    } catch (_e) {}
    return t;
  }
  let seekGen = 0; // drop stale async seeks (rapid scrubbing)
  // Swapping src on a PLAYING element can carry stale audio-clock state across
  // the swap in Chromium-family browsers — the new stream then renders with a
  // constant A/V offset even though its container is perfectly aligned ("lags
  // after skipping ±10s"). A hard reset (drop src + load()) tears the whole
  // pipeline down so the next stream starts with fresh clocks.
  function resetPipeline() {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_e) {}
  }
  // THE "audio lags from the start" fix: never start rendering on bare metadata.
  // A live transcode pipe delivers a whole video GOP before the first audio
  // trickles in — start play() that early and video's clock runs ahead while the
  // audio pipeline is still filling: a session-constant audio-behind offset that
  // (tellingly) a later mid-session seek "cures", because by then the pipe is
  // warm and both decoders start together. Waiting for `canplay` (real decodable
  // data in BOTH streams) makes every start behave like that healthy case.
  function playWhenReady(startFn) {
    const go = () => { video.removeEventListener('canplay', go); startFn(); };
    if (video.readyState >= 3 /* HAVE_FUTURE_DATA */) startFn();
    else video.addEventListener('canplay', go);
  }
  async function seekTo(t) {
    t = Math.max(0, dur() ? Math.min(t, dur() - 0.3) : t);
    if (play.mode === 'transcode') {
      const gen = ++seekGen;
      const s = await resolveStart(t);
      if (gen !== seekGen) return; // a newer seek superseded this one
      base = s;
      resetPipeline();
      video.src = withToken(play.url + '?start=' + s.toFixed(2) + '&snapped=1&' + audioQuery());
      playWhenReady(() => video.play());
    } else video.currentTime = t;
  }

  const vp = document.createElement('div');
  vp.className = 'vp';
  vp.innerHTML = `
    <video playsinline></video>
    <video class="vp-preroll-vid hidden" playsinline></video>
    <div class="vp-subs"></div>
    <div class="vp-top vp-fade">
      <button class="vp-back">‹ Back</button>
      <div class="vp-titles"><div class="vp-t">${escapeHtml(ctx.title)}</div>${ctx.subtitle ? `<div class="vp-st">${escapeHtml(ctx.subtitle)}</div>` : ''}</div>
    </div>
    <div class="vp-engine hidden"></div>
    <div class="vp-bottom vp-fade">
      <div class="vp-scrub" data-pf>
        <div class="vp-track"></div><div class="vp-buffered"></div><div class="vp-played"></div>
        <div class="vp-bubble hidden">0:00</div>
        <input class="vp-seek" type="range" min="0" max="1000" value="0">
      </div>
      <div class="vp-ctrls">
        <span class="vp-time">0:00 / 0:00</span>
        <span class="vp-liveind"><span class="lt-live-dot"></span>LIVE</span>
        <div class="vp-spacer"></div>
        <button class="vp-cc" data-pf title="Subtitles">CC</button>
        <button class="vp-gear" data-pf title="Settings">${ICONS.gear}</button>
        <button class="vp-fs" data-pf title="Fullscreen">${ICONS.fullscreen}</button>
      </div>
    </div>
    <div class="vp-transport vp-fade">
      <button class="vp-skip" data-pf data-d="-10" title="Back 10 seconds">${ICONS.back}<b>10</b></button>
      <button class="vp-play" data-pf title="Play / Pause">${ICONS.pause}</button>
      <button class="vp-skip" data-pf data-d="10" title="Forward 10 seconds">${ICONS.fwd}<b>10</b></button>
    </div>
    <button class="vp-skipbtn vp-skipintro hidden" data-pf>Skip Intro ${ICONS.skipnext}</button>
    <button class="vp-skipbtn vp-skipcredits hidden" data-pf>Skip Credits ${ICONS.skipnext}</button>
    <div class="vp-menu hidden"></div>
    <div class="vp-upnext hidden"></div>
    <div class="vp-error hidden"></div>`;
  const live = !!ctx.live;             // Live TV: a real broadcast — no time-travel controls
  if (live) vp.classList.add('vp-live');
  document.body.appendChild(vp);
  document.body.style.overflow = 'hidden';
  activePlayer = vp;

  const video = vp.querySelector('video');
  const menu = vp.querySelector('.vp-menu');
  const upnext = vp.querySelector('.vp-upnext');
  const playedBar = vp.querySelector('.vp-played');
  const bufferedBar = vp.querySelector('.vp-buffered');
  const seek = vp.querySelector('.vp-seek');
  const timeEl = vp.querySelector('.vp-time');
  const playBtns = [vp.querySelector('.vp-play')];
  const bubble = vp.querySelector('.vp-bubble');
  const isEpisode = ctx.searchKind === 'episode';
  const skipIntro = vp.querySelector('.vp-skipintro');
  const skipCredits = vp.querySelector('.vp-skipcredits');
  // Intro/credits ranges for the current file (chapters or fingerprint), set in
  // loadFile(). `introSkipped` makes Skip Intro one-shot per file so it can't
  // nag if the seek lands a hair short of the intro end.
  let introCh = null, creditsCh = null, introSkipped = false;
  async function skipIntroNow() {
    introSkipped = true;
    skipIntro.classList.add('hidden');
    if (!introCh) return;
    // Land on the keyframe AT OR AFTER the intro end (copy-path seeks snap to the
    // previous keyframe, which could drop you back inside the intro).
    let target = introCh.end;
    if (play.mode === 'transcode') {
      try {
        const r = await (await fetch(`/api/seekpoint/${ctx.searchKind}/${current.id}?start=${introCh.end.toFixed(2)}&after=1&${audioQuery()}`)).json();
        if (r && typeof r.start === 'number' && r.start >= introCh.end - 0.2) target = r.start;
      } catch (_e) {}
    }
    seekTo(target);
  }
  skipIntro.addEventListener('click', skipIntroNow);
  skipCredits.addEventListener('click', () => { if (ctx.onEnded) ctx.onEnded(); else seekTo((dur() || cur()) - 1); skipCredits.classList.add('hidden'); });
  const errEl = vp.querySelector('.vp-error');
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    errEl.innerHTML = play.reason === 'no-ffmpeg'
      ? `<b>The browser can't play this file format.</b><span>Install the playback engine (one click in ⚙ Settings on the server) and it will play everything — MKV, HEVC, AVI, surround audio…</span>`
      : `<b>Playback failed.</b><span>This file may be corrupt or use a codec the player can't read.</span>`;
    errEl.classList.remove('hidden');
  });

  const subsDiv = vp.querySelector('.vp-subs');
  function parseVtt(text) {
    const out = [];
    text.replace(/\r/g, '').split(/\n\n+/).forEach((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) return;
      // Hours are optional (VTT allows MM:SS.mmm), milliseconds . or , (SRT).
      const m = timeLine.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/);
      if (!m) return;
      const start = (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      const end = (+m[5] || 0) * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
      const body = lines.slice(lines.indexOf(timeLine) + 1).join('\n').replace(/<[^>]+>/g, '');
      out.push({ start, end, html: escapeHtml(body).replace(/\n/g, '<br>') });
    });
    return out;
  }
  async function setSubtitle(url) {
    cues = []; renderSub();
    if (!url) return;
    try { const r = await fetch(url); if (r.ok) cues = parseVtt(await r.text()); } catch (_e) {}
    renderSub();
  }
  function renderSub() {
    if (!subVisible || !cues.length) { subsDiv.innerHTML = ''; return; }
    const t = cur() - subOffset;
    const active = cues.filter((c) => t >= c.start && t <= c.end);
    subsDiv.innerHTML = active.map((c) => c.html).join('<br>');
  }
  // Cues update on a short timer, not just `timeupdate` (which only fires ~4×/s
  // and made captions appear late / linger).
  const subTimer = setInterval(renderSub, 200);

  // Autoplay on the first press even though we had to await /api/play (which
  // drops the click's transient activation). If sound-autoplay is blocked, start
  // muted — always allowed — then immediately unmute; changing `muted` doesn't
  // re-trigger the policy, so it keeps playing with sound.
  function attemptPlay() {
    const p = video.play();
    if (p && p.catch) p.catch(() => {
      video.muted = true;
      video.play().then(() => { video.muted = false; }).catch(() => {});
    });
  }

  // Admin-only playback badge: is this file direct-playing or transcoding, and
  // exactly what's being converted — plus the source per-stream start offset,
  // which is the usual cause of a constant audio-ahead/behind (lip-sync) gap.
  function renderEngineBadge(eng) {
    const el = vp.querySelector('.vp-engine');
    if (!el) return;
    if (!eng || !document.body.classList.contains('is-admin')) { el.classList.add('hidden'); return; }
    const chLbl = (c) => (c === 1 ? 'mono' : c === 2 ? 'stereo' : c + 'ch');
    const vTxt = eng.video ? `${eng.video.codec} ${eng.video.height}p` : '—';
    const aTxt = eng.audio ? `${eng.audio.codec} ${chLbl(eng.audio.channels)}` : '—';
    const off = Math.abs((eng.startV || 0) - (eng.startA || 0));
    const offTxt = off > 0.01 ? ` · src A/V start ${(eng.startV || 0).toFixed(2)}/${(eng.startA || 0).toFixed(2)}s ⚠` : '';
    el.innerHTML = eng.mode === 'direct'
      ? `▶ Direct play · ${escapeHtml(vTxt)} · ${escapeHtml(aTxt)}${offTxt}`
      : `⚙ Transcoding · V ${escapeHtml(vTxt)} → ${escapeHtml(eng.videoAction)} · A ${escapeHtml(aTxt)} → ${escapeHtml(eng.audioAction)}${offTxt}`;
    el.classList.remove('hidden');
    el.title = 'Click to diagnose A/V sync';
  }
  // Click the admin badge to run the deep A/V-sync diagnosis on this exact file.
  vp.querySelector('.vp-engine')?.addEventListener('click', runDiagnose);
  async function runDiagnose() {
    if (!document.body.classList.contains('is-admin')) return;
    const el = vp.querySelector('.vp-engine'); const orig = el.innerHTML;
    el.innerHTML = '⏳ Diagnosing…';
    let d = null;
    try { d = await (await fetch(`/api/diagnose/${ctx.searchKind}/${current.id}`)).json(); } catch (_e) {}
    el.innerHTML = orig;
    if (d) showDiagnoseOverlay(d); else alert('Diagnose failed');
  }
  function showDiagnoseOverlay(d) {
    const sv = (d.source && d.source.video) || {}, sa = (d.source && d.source.audio) || {}, sm = d.sample, sk = d.seek;
    const pk = (arr) => (arr || []).map((p) => `pts ${p.pts} / dts ${p.dts}`).join('   ') || '—';
    const off = sm && !sm.error ? sm.offsetMs : null;
    const sampleLine = (s, label) => s.error ? `${label} error: ${s.error}`
      : `${label} → video ${s.video.startTime}s / audio ${s.audio.startTime}s  ⇒  A/V offset ${s.offsetMs} ms  ${Math.abs(s.offsetMs) > 15 ? '⚠ audio ' + (s.offsetMs > 0 ? 'AHEAD' : 'BEHIND') : '(synced)'}`;
    const text = [
      `ENGINE: ${d.engine ? d.engine.mode : '?'}   V→${(d.engine && d.engine.videoAction) || ''}   A→${(d.engine && d.engine.audioAction) || ''}`,
      ``,
      `SOURCE video: ${sv.codec}  B-frames=${sv.hasBFrames}  fps=${sv.rFrameRate} (avg ${sv.avgFrameRate})  start=${sv.startTime}`,
      `  first video packets: ${pk(sv.firstPackets)}`,
      `SOURCE audio: ${sa.codec} ${sa.channels}ch  start=${sa.startTime}`,
      `  first audio packets: ${pk(sa.firstPackets)}`,
      ``,
      !sm ? 'SAMPLE: direct play (no transcode)' : sampleLine(sm, 'SAMPLE (3s from start)'),
      !sk ? null
        : `SEEK   (resume path) requested ${sk.requested}s → keyframe snap ${sk.snapped}s (${sk.snapMs} ms back)\n  ${sampleLine(sk, 'sample at snap')}`
    ].filter((l) => l != null).join('\n');
    const ov = document.createElement('div');
    ov.className = 'diag-overlay';
    ov.innerHTML = `<div class="diag-box"><pre></pre><div class="diag-actions"><button class="btn primary" id="diag-copy">Copy for Claude</button><button class="btn" id="diag-close">Close</button></div></div>`;
    ov.querySelector('pre').textContent = text;
    vp.appendChild(ov);
    ov.querySelector('#diag-copy').addEventListener('click', () => { navigator.clipboard.writeText(JSON.stringify(d, null, 2)).catch(() => {}); ov.querySelector('#diag-copy').textContent = 'Copied ✓'; });
    ov.querySelector('#diag-close').addEventListener('click', () => ov.remove());
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  }

  async function loadFile(f, at) {
    current = f;
    errEl.classList.add('hidden');
    // Ask the server how to play this file (direct vs ffmpeg transcode) and
    // for its real duration. Falls back to direct if the endpoint fails.
    let info = null;
    try { info = await (await fetch(`/api/play/${ctx.searchKind}/${f.id}?${audioQuery()}`)).json(); } catch (_e) {}
    play = info && info.mode === 'transcode'
      ? { mode: 'transcode', duration: info.duration || null, url: info.url, reason: null }
      : { mode: 'direct', duration: (info && info.duration) || null, url: ctx.streamBase + f.id, reason: (info && info.reason) || null };
    curEngine = (info && info.engine) || null;
    renderEngineBadge(info && info.engine); // admin-only: shows direct-play vs what's being transcoded
    // Chapter-based Skip Intro / Skip Credits (precise when the file has named
    // chapters — common in .mkv rips).
    const chaps = (info && info.chapters) || [];
    // Chapters win when present; otherwise use the fingerprinted intro range.
    introCh = chaps.find((c) => /\b(intro|opening|op|main title|titles?)\b/i.test(c.title))
      || (info && info.intro && info.intro.end > info.intro.start ? info.intro : null);
    creditsCh = chaps.find((c) => /\b(credits?|ending|outro|ed|end ?card)\b/i.test(c.title)) || null;
    introSkipped = false; // fresh file → its Skip Intro is available again
    base = 0;
    if (play.mode === 'transcode') {
      base = await resolveStart(at || 0); // resume lands on the true keyframe start
      if (video.src) resetPipeline();     // version switch mid-playback = src swap
      video.src = withToken(play.url + '?start=' + base.toFixed(2) + '&snapped=1&' + audioQuery());
      // canplay, NOT loadedmetadata — see playWhenReady (starting on bare
      // metadata is what made from-beginning/resume playback lag).
      playWhenReady(() => attemptPlay());
    } else {
      if (video.src) resetPipeline();
      video.src = withToken(play.url);
      video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at; attemptPlay(); }, { once: true });
    }
    // The detail payload only knows sidecar files; ask for the FULL track list
    // (embedded mkv subtitles included) now that we're actually playing this file.
    try {
      const full = await (await fetch(`/api/subtitles/list/${ctx.searchKind}/${f.id}`)).json();
      if (Array.isArray(full) && full.length >= (current.subtitles || []).length) current.subtitles = full;
    } catch (_e) {}
    const subs = current.subtitles || [];
    if (subs.length) { currentSubIdx = 0; subVisible = true; loadDelay(); setSubtitle(subUrl(0)); }
    else { currentSubIdx = -1; subOffset = 0; setSubtitle(null); }
  }
  // Pre-roll: a video that plays before a MOVIE (not TV episodes, not Live TV),
  // and only when starting from the beginning (skipped on resume). Not skippable —
  // controls are locked until it ends. Fully fail-safe: any error/absence just
  // starts the movie. Plays on a separate overlay <video> so it never touches the
  // main player's state/handlers.
  function startMain() { loadFile(current, ctx.startAt || 0); }
  // `prerollInfo` is prefetched (see refreshPreroll), so we can start it
  // synchronously inside the click's user-activation → autoplay with sound.
  if (ctx.searchKind === 'movie' && !(ctx.startAt > 0) && prerollInfo) playPrerollThen(startMain);
  else startMain();

  function playPrerollThen(done) {
    const pv = vp.querySelector('.vp-preroll-vid');
    let doneOnce = false;
    const go = () => { if (doneOnce) return; doneOnce = true; pv.classList.add('hidden'); pv.removeAttribute('src'); vp.classList.remove('vp-prerolling'); done(); };
    vp.classList.add('vp-prerolling');
    pv.classList.remove('hidden');
    pv.src = withToken(prerollInfo.mode === 'transcode' ? prerollInfo.url + '?start=0&' + audioQuery() : prerollInfo.url);
    pv.addEventListener('ended', go, { once: true });
    pv.addEventListener('error', go, { once: true });
    // Safety net: never let a stuck pre-roll trap the viewer.
    setTimeout(() => { if (!doneOnce && (pv.error || pv.readyState < 2)) go(); }, 12000);
    // Play with sound; if the browser blocks it, fall back to muted then unmute.
    pv.muted = false;
    pv.play().catch(() => { pv.muted = true; pv.play().then(() => { pv.muted = false; }).catch(go); });
  }

  function setPlayIcons() {
    const i = video.paused ? ICONS.play : ICONS.pause;
    playBtns.forEach((b) => (b.innerHTML = i));
    vp.classList.toggle('vp-ispaused', video.paused);
  }
  // Resume robustly: video.play() returns a promise that a TV WebView can reject
  // (transient-activation quirks); fall back to a muted start then unmute, the
  // same trick attemptPlay() uses, so a remote's Play never silently no-ops.
  function playNow() {
    if (live) return;
    const p = video.play();
    if (p && p.catch) p.catch(() => { video.muted = true; video.play().then(() => { video.muted = false; }).catch(() => {}); });
  }
  function pauseNow() { if (!live) video.pause(); } // can't pause live TV
  function togglePlay() { if (live) return; video.paused ? playNow() : pauseNow(); }
  playBtns.forEach((b) => b.addEventListener('click', togglePlay));
  video.addEventListener('click', togglePlay);
  video.addEventListener('play', setPlayIcons);
  video.addEventListener('pause', setPlayIcons);
  setPlayIcons();

  // MediaSession: the reliable route for a TV remote's dedicated ▶⏸ button (and
  // OS/lock-screen media keys). Without registered handlers, a WebView pauses on
  // the hardware key but has no wired way to resume — the reported "can't pause
  // then play again". Registering play/pause/seek handlers makes those keys drive
  // OUR player, and keeping playbackState synced tells the OS which action is next.
  if ('mediaSession' in navigator && !live) {
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => { playNow(); showUI(); });
      ms.setActionHandler('pause', () => { pauseNow(); showUI(); });
      ms.setActionHandler('stop', () => { pauseNow(); showUI(); });
      ms.setActionHandler('seekbackward', (d) => { seekTo(cur() - (d && d.seekOffset ? d.seekOffset : 10)); showUI(); });
      ms.setActionHandler('seekforward', (d) => { seekTo(cur() + (d && d.seekOffset ? d.seekOffset : 10)); showUI(); });
      try { ms.setActionHandler('metadata', null); } catch (_e) {}
      ms.metadata = new MediaMetadata({ title: ctx.title || '', artist: ctx.subtitle || '' });
    } catch (_e) { /* older WebViews: some actions unsupported — ignore */ }
    const syncMs = () => { try { ms.playbackState = video.paused ? 'paused' : 'playing'; } catch (_e) {} };
    video.addEventListener('play', syncMs);
    video.addEventListener('pause', syncMs);
    syncMs();
  }

  // ---- Session heartbeat (feeds the admin "Now Playing" monitor) ----
  // Report our live state every ~10s (and on play/pause) so an admin can see who's
  // watching what, whether it's transcoding, and buffer/health for troubleshooting.
  function sessionHeartbeat() {
    if (!current) return;
    let bufAhead = 0;
    try { const bb = video.buffered; if (bb.length) bufAhead = Math.max(0, bb.end(bb.length - 1) - video.currentTime); } catch (_e) {}
    const sub = currentSubIdx >= 0 ? (current.subtitles || [])[currentSubIdx] : null;
    const body = {
      sessionId,
      kind: ctx.searchKind,
      fileId: current.id,
      title: ctx.title || '',
      subtitle: ctx.subtitle || '',
      mode: play && play.mode,
      engine: curEngine,
      position: cur(),
      duration: dur(),
      paused: video.paused,
      bufferedAhead: bufAhead,
      readyState: video.readyState,
      networkState: video.networkState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      live,
      subtitleTrack: sub ? (sub.label || sub.lang || 'on') : 'off',
      audioMode: audioGet('audioMode') === 'surround' ? 'surround' : 'stereo',
      tv: TV_MODE
    };
    try { fetch('/api/session/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_e) {}
  }
  const hbTimer = setInterval(sessionHeartbeat, 10000);
  video.addEventListener('playing', sessionHeartbeat);
  video.addEventListener('pause', sessionHeartbeat);

  vp.querySelectorAll('.vp-skip').forEach((b) => b.addEventListener('click', () => { seekTo(cur() + +b.dataset.d); }));

  // scrub + time (all through cur()/dur() so transcode's virtual timeline works)
  let seeking = false;
  video.addEventListener('timeupdate', () => {
    const d = dur();
    if (!seeking && d) { const p = cur() / d; playedBar.style.width = p * 100 + '%'; seek.value = p * 1000; }
    timeEl.textContent = `${fmtTime(cur())} / ${fmtTime(d)}`;
    if (video.buffered.length && d) {
      const buffered = (play.mode === 'transcode' ? base : 0) + video.buffered.end(video.buffered.length - 1);
      bufferedBar.style.width = Math.min(100, (buffered / d) * 100) + '%';
    }
    updateSkipButtons();
    renderSub();
    maybeUpNext();
    throttledSave();
  });
  // Skip Intro / Skip Credits visibility. Chapters are authoritative (and work
  // for anything, incl. a cold open before the intro). Without chapters we fall
  // back to a heuristic — but only for TV episodes, since movies have no intro.
  function updateSkipButtons() {
    if (!SKIP_BUTTONS_ENABLED) { skipIntro.classList.add('hidden'); skipCredits.classList.add('hidden'); return; }
    if (live) return; // no skipping on a live feed
    const t = cur(), d = dur();
    let showIntro = false, showCredits = false;
    // Intro: ONLY a named chapter or a fingerprint-detected range (introCh is set
    // from either in loadFile). Always bounded → the button auto-hides once you're
    // past the intro, and never appears when we don't actually know where it is.
    // `introSkipped` keeps it from re-showing after you've used it.
    if (introCh && !introSkipped) showIntro = t >= introCh.start && t < introCh.end;
    // Credits: a named chapter, or — only for an episode that has a next one — the
    // tail window, which is itself bounded so it can't linger.
    if (creditsCh) showCredits = t >= creditsCh.start;
    else if (isEpisode && ctx.onEnded && d) showCredits = t >= d - 45 && t < d - 1;
    const introWas = !skipIntro.classList.contains('hidden');
    const creditsWas = !skipCredits.classList.contains('hidden');
    const focusedBefore = pfEls()[pfIdx]; // capture before visibility changes shift the grid
    skipIntro.classList.toggle('hidden', !showIntro);
    skipCredits.classList.toggle('hidden', !showCredits);
    // Remote reachability. On a clean screen (no control ring up), auto-seat focus
    // on a skip button the instant it appears so the OK/center button skips in one
    // press — the tvOS way. If the viewer is already driving the controls (ring up)
    // we don't yank focus; the Skip row above the transport is one Up away. When a
    // focused skip button disappears, drop the ring back to the scrub bar.
    const justShown = (showIntro && !introWas) ? skipIntro : (showCredits && !creditsWas) ? skipCredits : null;
    if (justShown && !vp.classList.contains('vp-keys')) { vp.classList.add('vp-keys'); pfFocus(justShown); }
    // If the ring was on a skip button that just disappeared, its slot in the grid
    // is gone — put focus back on a stable control (the scrub bar) instead of
    // letting pfIdx silently land on whatever shifted into that index.
    else if (focusedBefore && focusedBefore.classList.contains('vp-skipbtn') && focusedBefore.classList.contains('hidden')) pfSet(0);
  }
  seek.addEventListener('input', () => {
    seeking = true;
    if (!dur()) return;
    playedBar.style.width = (seek.value / 10) + '%';
    bubble.textContent = fmtTime((seek.value / 1000) * dur());
    bubble.style.left = (seek.value / 10) + '%';
    bubble.classList.remove('hidden');
  });
  seek.addEventListener('change', () => { if (dur()) seekTo((seek.value / 1000) * dur()); seeking = false; bubble.classList.add('hidden'); });

  // Volume is controlled by the TV/remote itself, so the player has no on-screen
  // mute button or volume slider (removed by request).

  // fullscreen
  vp.querySelector('.vp-fs').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else if (vp.requestFullscreen) vp.requestFullscreen(); });

  // subtitles quick toggle (no tracks at all -> jump straight to online search)
  function onSubDownloaded() {
    current.subtitles = current.subtitles || [];
    current.subtitles.unshift({ label: 'Downloaded', idx: 0 });
    currentSubIdx = 0; subVisible = true; loadDelay(); setSubtitle(subUrl(0));
  }
  vp.querySelector('.vp-cc').addEventListener('click', () => {
    const subs = current.subtitles || [];
    if (!subs.length) { openSubSearch(ctx.searchKind, current.id, video, onSubDownloaded); return; }
    if (currentSubIdx < 0) { currentSubIdx = 0; subVisible = true; loadDelay(); setSubtitle(subUrl(0)); }
    else { subVisible = !subVisible; renderSub(); }
  });

  // settings menu — navigable by remote: Up/Down move a highlighted option,
  // Enter activates, Left/Right nudge the caption delay, Back closes.
  const gear = vp.querySelector('.vp-gear');
  let menuIdx = 0;
  const menuBtns = () => [...menu.querySelectorAll('button')];
  function paintMenu() {
    const btns = menuBtns();
    menuIdx = Math.max(0, Math.min(menuIdx, btns.length - 1));
    btns.forEach((b, i) => b.classList.toggle('focused', i === menuIdx));
    if (btns[menuIdx]) btns[menuIdx].scrollIntoView({ block: 'nearest' });
  }
  function buildMenu() {
    const audio = video.audioTracks && video.audioTracks.length > 1 ? [...video.audioTracks] : [];
    const subs = current.subtitles || [];
    menu.innerHTML = `
      ${ctx.files.length > 1 ? `<h4>Version</h4>${ctx.files.map((f, i) => `<button class="vp-opt ver" data-fid="${f.id}">${escapeHtml(versionLabel(f, i))}<span class="tick">${current.id === f.id ? '✓' : ''}</span></button>`).join('')}` : ''}
      ${audio.length ? `<h4>Audio</h4>${audio.map((a, i) => `<button class="vp-opt aud" data-i="${i}">${escapeHtml(a.label || a.language || 'Track ' + (i + 1))}<span class="tick">${a.enabled ? '✓' : ''}</span></button>`).join('')}` : ''}
      <h4>Subtitles</h4>
      <button class="vp-opt subt" data-i="-1">Off<span class="tick">${!(subVisible && currentSubIdx >= 0) ? '✓' : ''}</span></button>
      ${subs.map((s, i) => `<button class="vp-opt subt" data-i="${i}">${escapeHtml(s.label || 'Track ' + (i + 1))}<span class="tick">${subVisible && currentSubIdx === i ? '✓' : ''}</span></button>`).join('')}
      <button class="vp-opt" id="sub-search">Search online…</button>
      <button class="vp-opt" id="sub-generate">✨ Generate with AI…</button>
      <div class="vp-offset"><span style="color:var(--muted);font-size:12px">Delay</span><button data-o="-0.25">−</button><span class="val">${subOffset.toFixed(2)}s</span><button data-o="0.25">+</button></div>`;
    menu.querySelectorAll('.ver').forEach((b) => b.addEventListener('click', () => {
      const f = ctx.files.find((x) => String(x.id) === b.dataset.fid);
      if (f && f.id !== current.id) { rememberVersion(ctx.verKey, f); loadFile(f, cur()); }
      buildMenu();
    }));
    menu.querySelectorAll('.aud').forEach((b) => b.addEventListener('click', () => { [...video.audioTracks].forEach((a, i) => (a.enabled = i === +b.dataset.i)); buildMenu(); }));
    menu.querySelectorAll('.subt').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      if (i < 0) { subVisible = false; renderSub(); }
      else { currentSubIdx = i; subVisible = true; loadDelay(); setSubtitle(subUrl(i)); }
      buildMenu();
    }));
    const ss = menu.querySelector('#sub-search');
    if (ss) ss.addEventListener('click', () => {
      menu.classList.add('hidden');
      openSubSearch(ctx.searchKind, current.id, video, onSubDownloaded);
    });
    const gen = menu.querySelector('#sub-generate');
    if (gen) gen.addEventListener('click', () => generateSubsFlow());
    menu.querySelectorAll('.vp-offset button').forEach((b) => b.addEventListener('click', () => { subOffset = Math.round((subOffset + +b.dataset.o) * 100) / 100; saveDelay(); renderSub(); buildMenu(); }));
    paintMenu();
  }
  gear.addEventListener('click', () => { if (menu.classList.contains('hidden')) { menuIdx = 0; buildMenu(); menu.classList.remove('hidden'); } else menu.classList.add('hidden'); });
  // Close on outside click. Buttons inside the menu re-render it, so their
  // e.target is detached by the time this runs — a detached target must NOT
  // count as "outside" (that's what made the delay popup close on every press).
  vp.addEventListener('click', (e) => { if (!e.target.isConnected) return; if (!menu.contains(e.target) && !gear.contains(e.target)) menu.classList.add('hidden'); });

  // AI subtitle generation: pick a target language, kick off a background job on
  // the server, and poll its progress. The job keeps running even if you close
  // the menu and keep watching — the track appears when it's ready.
  async function generateSubsFlow() {
    let ws = {};
    try { ws = await (await fetch('/api/whisper')).json(); } catch (_e) {}
    if (!ws.available) {
      menu.innerHTML = `<h4>Generate with AI</h4><div class="vp-genmsg">The AI subtitle engine isn't installed yet. Open <b>⚙ Settings → AI subtitles</b> on the server to install it (one click), then try again.</div><button class="vp-opt" id="gen-back">‹ Back</button>`;
      menu.querySelector('#gen-back').addEventListener('click', buildMenu);
      return;
    }
    const PHASE = { extracting: 'Extracting audio', transcribing: 'Transcribing spoken audio', translating: 'Translating', starting: 'Starting' };
    let polling = false;
    const showProgress = (d) => {
      const pct = d.pct || 0;
      menu.innerHTML = `<h4>Generating subtitles</h4>
        <div class="vp-genmsg">
          <div class="vp-genbar"><i style="width:${pct}%"></i></div>
          <div style="margin-top:8px">${PHASE[d.phase] || 'Working'}… ${pct}%</div>
          <div style="margin-top:8px">A full movie takes a few minutes — you can close this and keep watching; the track appears when it's ready.</div>
        </div>
        <button class="vp-opt" id="gen-hide">Keep watching</button>`;
      menu.querySelector('#gen-hide').addEventListener('click', () => { polling = false; menu.classList.add('hidden'); });
    };
    const apply = (result) => {
      if (!result) return;
      current.subtitles = result.subtitles || current.subtitles;
      currentSubIdx = result.idx; subVisible = true; loadDelay(); setSubtitle(subUrl(result.idx));
      if (!menu.classList.contains('hidden')) buildMenu();
    };
    const fail = (msg) => {
      if (menu.classList.contains('hidden')) return;
      menu.innerHTML = `<h4>Generate with AI</h4><div class="vp-genmsg">Couldn't generate: ${escapeHtml(msg)}</div><button class="vp-opt" id="gen-back">‹ Back</button>`;
      menu.querySelector('#gen-back').addEventListener('click', buildMenu);
    };
    const start = async (target) => {
      polling = true;
      let d = {};
      try {
        const r = await fetch('/api/subtitles/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: ctx.searchKind, fileId: current.id, target })
        });
        d = await r.json();
        if (!r.ok) throw new Error(d.error || 'failed');
      } catch (e) { fail(e.message); return; }
      showProgress(d);
      const poll = async () => {
        if (!polling || !document.body.contains(vp)) return;
        let s = {};
        try { s = await (await fetch(`/api/subtitles/generate?kind=${ctx.searchKind}&fileId=${current.id}&target=${target}`)).json(); } catch (_e) {}
        if (s.status === 'done') { polling = false; apply(s.result); return; }
        if (s.status === 'error') { polling = false; fail(s.error || 'failed'); return; }
        if (!menu.classList.contains('hidden')) showProgress(s);
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 1500);
    };
    menu.innerHTML = `
      <h4>Generate with AI</h4>
      <button class="vp-opt" data-t="orig">Transcribe spoken audio<span class="tick">›</span></button>
      <button class="vp-opt" data-t="en">Subtitles in English<span class="tick">›</span></button>
      <button class="vp-opt" data-t="es">Subtitles in Spanish<span class="tick">›</span></button>
      <div class="vp-genmsg">Runs on the server. Great when no subtitles exist, or to translate a film. English &amp; Spanish are translated automatically.</div>
      <button class="vp-opt" id="gen-back">‹ Back</button>`;
    menu.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => start(b.dataset.t)));
    menu.querySelector('#gen-back').addEventListener('click', buildMenu);
  }

  // Up Next. While it's showing it OWNS the remote/keyboard: playback controls
  // are disabled and the arrows move only between its two buttons (Enter picks),
  // so it's actually reachable on a remote (the buttons used to be mouse-only).
  // Back still exits the episode. See the key handler for the input takeover.
  let unFocus = 0; // which card button is focused: 0 = Play Now, 1 = Dismiss
  const upNextActive = () => !upnext.classList.contains('hidden');
  function paintUpNext() {
    const btns = [...upnext.querySelectorAll('button')];
    btns.forEach((b, i) => b.classList.toggle('un-focus', vp.classList.contains('vp-keys') && i === unFocus));
  }
  function hideUpNext() { upnext.classList.add('hidden'); paintUpNext(); }
  function maybeUpNext() {
    if (!ctx.upNext || upnextShown || !dur()) return;
    if (dur() - cur() <= 22) {
      upnextShown = true;
      upnext.innerHTML = `
        <div class="un-still" style="background-image:url('${ctx.upNext.still || ''}')"></div>
        <div class="un-body"><div class="un-label">${escapeHtml(ctx.upNext.label)}</div>
          <div class="un-title">${escapeHtml(ctx.upNext.title)}</div>
          <div class="un-actions"><button class="btn btn-play sm" id="un-play">▶ Play Now</button><button class="btn sm" id="un-dismiss">Dismiss</button></div></div>`;
      upnext.classList.remove('hidden');
      upnext.querySelector('#un-play').addEventListener('click', () => ctx.upNext.play());
      upnext.querySelector('#un-dismiss').addEventListener('click', hideUpNext);
      unFocus = 0; vp.classList.add('vp-keys'); showUI(); paintUpNext(); // pre-seat remote focus on Play Now
    }
  }

  // progress saving
  let lastSave = 0;
  function save() {
    if (!ctx.progressUrl) return; // Live TV / ephemeral playback: don't record progress
    fetch(ctx.progressUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: cur(), duration: dur() || null, watched: dur() && cur() / dur() > 0.92 ? 1 : null }) });
  }
  function throttledSave() { if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); } }
  video.addEventListener('pause', save);
  video.addEventListener('ended', () => {
    save();
    // A transcode stream ending mid-film is a hiccup, not the credits.
    if (play.mode === 'transcode' && dur() && cur() < dur() - 8) return;
    if (ctx.onEnded) ctx.onEnded();
  });

  // auto-hide chrome
  let hideTimer;
  function showUI() { vp.classList.remove('hide-ui'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!video.paused && menu.classList.contains('hidden')) vp.classList.add('hide-ui'); }, 3500); }
  // Instant "get rid of everything" — hide all chrome now (press 'h', or the
  // remote's Back button as its first press). Also drops the key-focus ring.
  function hideUINow() { clearTimeout(hideTimer); vp.classList.remove('vp-keys'); vp.classList.add('hide-ui'); menu.classList.add('hidden'); }
  vp.addEventListener('mousemove', () => { vp.classList.remove('vp-keys'); paintPf(); paintUpNext(); showUI(); });
  showUI();

  // ---- Visible key/remote focus over the player controls ----
  // Arrow keys move a glowing focus ring across the scrub bar and buttons, so
  // you can always see where you are. The scrub bar is the home position:
  // Left/Right there seek (repeated presses accumulate into one jump, with a
  // time bubble previewing the target), Down drops to the buttons, Enter is
  // play/pause. On buttons, Left/Right move, Enter presses, Up returns to the
  // bar. Mouse use hides the ring; the next key brings it back.
  const pfEls = () => [...vp.querySelectorAll('[data-pf]')].filter((el) => el.offsetParent !== null); // visible only (Live TV hides seek/skip/play)
  let pfIdx = 0; // 0 = the scrub bar
  let pfCol = 0; // desired horizontal position, remembered across Up/Down row moves
  function paintPf() {
    const keys = vp.classList.contains('vp-keys');
    pfEls().forEach((el, i) => el.classList.toggle('pfocus', keys && i === pfIdx));
  }
  function pfSet(i) { pfIdx = Math.max(0, Math.min(i, pfEls().length - 1)); paintPf(); }
  // Focus a specific element (by node) via its flat pfEls index.
  function pfFocus(el) { const i = pfEls().indexOf(el); if (i >= 0) pfSet(i); }
  // The control rows, top → bottom: center transport, scrub bar, bottom utility
  // buttons. Live TV hides the first two, leaving just the utility row. Up/Down
  // step between rows; Left/Right move within one.
  function pfRows() {
    const vis = (el) => el && el.offsetParent !== null;
    // Skip Intro/Credits sit above everything: a transient "do this now" action.
    // They're only in the grid while visible (offsetParent filter), so Up from the
    // transport reaches whichever one is showing and Down drops back into playback.
    const skip = [...vp.querySelectorAll('.vp-skipbtn[data-pf]')].filter(vis);
    const transport = [...vp.querySelectorAll('.vp-transport [data-pf]')].filter(vis);
    const scrub = [...vp.querySelectorAll('.vp-scrub[data-pf]')].filter(vis);
    const utility = [...vp.querySelectorAll('.vp-ctrls [data-pf]')].filter(vis);
    return [skip, transport, scrub, utility].filter((r) => r.length);
  }
  function pfLocate() {
    const rows = pfRows(), el = pfEls()[pfIdx];
    for (let r = 0; r < rows.length; r++) { const c = rows[r].indexOf(el); if (c >= 0) return { rows, r, c }; }
    return { rows, r: 0, c: 0 };
  }

  // Debounced key-seek: presses accumulate, the bubble previews the target,
  // and the actual seek fires shortly after the last press.
  let pendingSeek = null, keySeekTimer = null;
  function keySeek(delta) {
    const from = pendingSeek !== null ? pendingSeek : cur();
    const target = Math.max(0, dur() ? Math.min(from + delta, dur() - 0.3) : Math.max(0, from + delta));
    pendingSeek = target;
    seeking = true;
    if (dur()) { const p = (target / dur()) * 100; playedBar.style.width = p + '%'; seek.value = p * 10; bubble.style.left = p + '%'; }
    bubble.textContent = fmtTime(target);
    bubble.classList.remove('hidden');
    clearTimeout(keySeekTimer);
    keySeekTimer = setTimeout(() => {
      const t = pendingSeek; pendingSeek = null; seeking = false;
      bubble.classList.add('hidden');
      seekTo(t);
    }, 550);
  }

  // close + keyboard (remote-friendly: arrows seek / open the menu, Enter is
  // play-pause, Backspace is the remote's Back button)
  function close() { save(); if (document.fullscreenElement) document.exitFullscreen(); vp.remove(); activePlayer = null; document.body.style.overflow = 'hidden'; }
  vp.querySelector('.vp-back').addEventListener('click', close);
  vp._onKey = (e) => {
    // Pre-roll is not skippable — swallow playback keys while it's running (Back
    // still closes the whole player, via the handler below only after this guard).
    if (vp.classList.contains('vp-prerolling') && e.key !== 'Escape' && e.key !== 'Backspace') { e.preventDefault(); return; }
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return; // typing (subtitle search)
    // Hardware media keys (some TV WebViews deliver the remote's ▶⏸ as a keydown
    // rather than via MediaSession) — handle them here too so pause/resume works
    // no matter which path fires. Kept above the menu/up-next guards on purpose.
    if (e.key === 'MediaPlayPause') { e.preventDefault(); togglePlay(); showUI(); return; }
    if (e.key === 'MediaPlay') { e.preventDefault(); playNow(); showUI(); return; }
    if (e.key === 'MediaPause' || e.key === 'MediaStop') { e.preventDefault(); pauseNow(); showUI(); return; }
    const menuOpen = !menu.classList.contains('hidden');
    const subsOpen = !document.getElementById('subs').classList.contains('hidden');
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (document.fullscreenElement && e.key === 'Escape') return; // browser exits fullscreen first
      e.preventDefault(); e.stopPropagation();
      if (subsOpen) document.getElementById('subs').classList.add('hidden');
      else if (menuOpen) menu.classList.add('hidden');
      // While watching (playing, chrome visible), the first Back just clears the
      // screen. Press it again — or when paused/already hidden — to exit.
      else if (!video.paused && !vp.classList.contains('hide-ui')) hideUINow();
      else close();
      return;
    }
    if (subsOpen) return; // the subtitle-results modal handles its own clicks
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); menuIdx += e.key === 'ArrowDown' ? 1 : -1; paintMenu(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const b = menuBtns()[menuIdx]; if (b) b.click(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const b = menu.querySelector(`.vp-offset button[data-o="${e.key === 'ArrowLeft' ? '-0.25' : '0.25'}"]`);
        if (b) b.click(); // Left/Right nudge caption delay while the menu is up
      }
      return;
    }
    // Up Next card is showing: it takes over input. Arrows pick a button, Enter
    // activates it, and every other key (seek, play/pause, skip) is swallowed so
    // playback can't be driven. Back already exited above, so you can still leave
    // the episode.
    if (upNextActive()) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); vp.classList.add('vp-keys'); unFocus = unFocus ? 0 : 1; paintUpNext();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); const b = upnext.querySelector(unFocus ? '#un-dismiss' : '#un-play'); if (b) b.click();
      } else { e.preventDefault(); } // no playback control while the card is up
      return;
    }
    const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key);
    if (nav) {
      e.preventDefault();
      vp.classList.add('vp-keys');
      // Controls hidden? Arrows just reveal them (focused on the bar). The OK/center
      // button (Enter) is the remote's primary play/pause — reveal AND toggle in one
      // press, so pausing/resuming never takes two presses from a clean screen.
      if (vp.classList.contains('hide-ui')) { showUI(); pfSet(0); if (e.key === 'Enter') togglePlay(); return; }
      showUI();
      const { rows, r, c } = pfLocate();
      const onBar = rows[r] && rows[r][c] && rows[r][c].classList.contains('vp-scrub');
      // Enter on the scrub bar (the home position) is play/pause; on an explicit
      // control it activates that control. Focus already on the ▶ transport button
      // also toggles, so OK reliably pauses/resumes wherever the ring naturally sits.
      if (e.key === 'Enter') {
        const el = rows[r] && rows[r][c];
        if (onBar || (el && el.classList.contains('vp-play'))) togglePlay();
        else (el || pfEls()[0]).click();
      }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Step to the adjacent row, keeping the remembered horizontal position.
        const nr = e.key === 'ArrowUp' ? r - 1 : r + 1;
        if (nr < 0 || nr >= rows.length) return;
        const dest = rows[nr];
        pfFocus(dest[Math.max(0, Math.min(pfCol, dest.length - 1))]);
      } else { // Left / Right
        const d = e.key === 'ArrowRight' ? 1 : -1;
        if (onBar) { keySeek(d * 10); return; } // the scrub bar seeks, doesn't move focus
        const nc = Math.max(0, Math.min(c + d, rows[r].length - 1));
        pfCol = nc;
        pfFocus(rows[r][nc]);
      }
      return;
    }
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); showUI(); }
    else if (e.key === 'f') vp.querySelector('.vp-fs').click();
    else if (e.key === 'h') { e.preventDefault(); hideUINow(); }
    else if (e.key === 'c') vp.querySelector('.vp-cc').click();
    else if (e.key === 's') { menuIdx = 0; buildMenu(); menu.classList.remove('hidden'); showUI(); }
  };
  document.addEventListener('keydown', vp._onKey, true);
  const origRemove = vp.remove.bind(vp);
  vp.remove = () => {
    clearInterval(subTimer);
    clearInterval(hbTimer);
    // Drop our session from the admin monitor at once (sendBeacon so it still
    // goes out if the page is unloading), rather than waiting for it to time out.
    try {
      const body = JSON.stringify({ sessionId });
      // withToken keeps it authorized on the webOS app (which has no cookie).
      if (navigator.sendBeacon) navigator.sendBeacon(withToken('/api/session/end'), new Blob([body], { type: 'application/json' }));
      else fetch('/api/session/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (_e) {}
    document.removeEventListener('keydown', vp._onKey, true);
    // Hard-stop every media element (main + pre-roll overlay) so audio can't keep
    // playing after you back out — just detaching a streaming <video> from the DOM
    // doesn't reliably kill its audio, and it also aborts the transcode request.
    vp.querySelectorAll('video').forEach((v) => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_e) {} });
    origRemove();
  };
}

// ---------- Detail modal open/close ----------
function openDetailModal() { detail.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeDetail() {
  stopActivePlayer(); // leaving the detail must tear the player down, or its audio
                      // keeps playing in the background (it lives on <body>, not here)
  detail.classList.add('hidden');
  detailInner.innerHTML = '';
  document.body.style.overflow = '';
  loadAll().then(renderView);
}
detailClose.addEventListener('click', closeDetail);
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !detail.classList.contains('hidden')) closeDetail(); });

// ---------- Search ----------
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (!q) { renderView(); return; }
  heroEl.classList.add('hidden');
  rowsEl.style.paddingTop = '78px';
  const mm = movies.filter((m) => m.title.toLowerCase().includes(q)).map((m) => buildMediaCard(m, 'movie'));
  const ss = shows.filter((s) => s.title.toLowerCase().includes(q)).map((s) => buildMediaCard(s, 'show'));
  drawRows([{ title: `Results for “${search.value.trim()}”`, cards: [...mm, ...ss] }]);
});

// ---------- Subtitle search ----------
const subsModal = document.getElementById('subs');
const subsList = document.getElementById('subs-list');
const subsStatus = document.getElementById('subs-status');
subsModal.addEventListener('click', (e) => { if (e.target === subsModal) subsModal.classList.add('hidden'); });

async function openSubSearch(kind, fileId, player, onApplied) {
  subsModal.classList.remove('hidden');
  subsStatus.textContent = 'Searching OpenSubtitles…';
  subsList.innerHTML = '';
  let results;
  try {
    const r = await fetch(`/api/subtitles/search?kind=${kind}&fileId=${fileId}`);
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))).error || 'Search failed.';
      subsStatus.textContent = err;
      if (/configured/i.test(err)) {
        subsList.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'btn primary'; btn.textContent = '⚙ Open Settings to add your OpenSubtitles key';
        btn.addEventListener('click', () => { subsModal.classList.add('hidden'); openSettings(); });
        subsList.appendChild(btn);
      }
      return;
    }
    results = await r.json();
  } catch (_e) { subsStatus.textContent = 'Search failed.'; return; }
  if (!results.length) { subsStatus.textContent = 'No subtitles found for this title.'; return; }
  subsStatus.textContent = `${results.length} result${results.length === 1 ? '' : 's'} — pick one to download:`;
  for (const s of results) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.innerHTML = `<span class="tag movie">${(s.language || 'en').toUpperCase()}</span>
      <span class="path">${escapeHtml(s.release)} · ↓${s.downloads}${s.hearing_impaired ? ' · HI' : ''}</span>
      <button class="btn primary sm">Get</button>`;
    item.querySelector('button').addEventListener('click', async (e) => {
      e.target.textContent = 'Downloading…'; e.target.disabled = true;
      let dr;
      try { dr = await fetch('/api/subtitles/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, fileId, file_id: s.file_id }) }); }
      catch (_e) { e.target.textContent = 'Failed'; e.target.disabled = false; return; }
      if (dr.ok) {
        e.target.textContent = '✓ Added';
        subsStatus.textContent = 'Subtitle added.';
        const subUrl = kind === 'episode' ? '/api/subtitle/episode/' + fileId : '/api/subtitle/' + fileId;
        if (onApplied) onApplied(subUrl); else if (player) attachSubtitle(player, subUrl);
        setTimeout(() => subsModal.classList.add('hidden'), 700);
      } else {
        e.target.textContent = 'Failed'; e.target.disabled = false;
        subsStatus.textContent = (await dr.json().catch(() => ({}))).error || 'Download failed.';
      }
    });
    subsList.appendChild(item);
  }
}

function attachSubtitle(player, url) {
  player.querySelectorAll('track').forEach((t) => t.remove());
  if (!url) return;
  const track = document.createElement('track');
  track.kind = 'subtitles'; track.label = 'Subtitles'; track.srclang = 'en'; track.src = url;
  player.appendChild(track);
}

// ---------- Settings / folders / update ----------
const settingsModal = document.getElementById('settings');
const settingsBtn = document.getElementById('settings-btn');
const libList = document.getElementById('lib-list');
const picker = document.getElementById('picker');
const pickerTitle = document.getElementById('picker-title');
const pickerPath = document.getElementById('picker-path');
const pickerList = document.getElementById('picker-list');
const pickerUp = document.getElementById('picker-up');
const pickerChoose = document.getElementById('picker-choose');
const versionEl = document.getElementById('version');
const updateBtn = document.getElementById('update-btn');
const updatePill = document.getElementById('update-pill');
const osKey = document.getElementById('os-key');
const osUser = document.getElementById('os-user');
const osPass = document.getElementById('os-pass');
const osStatus = document.getElementById('os-status');
const osSave = document.getElementById('os-save');
const pickerState = { path: null, parent: null, type: 'movie' };

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { document.getElementById(b.dataset.close).classList.add('hidden'); if (b.dataset.close === 'settings') stopSessionsPolling(); }));
[settingsModal, picker].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) { m.classList.add('hidden'); if (m === settingsModal) stopSessionsPolling(); } }));
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openPicker(b.dataset.add)));
settingsBtn.addEventListener('click', openSettings);

async function openSettings() {
  settingsModal.classList.remove('hidden');
  paintAudio();
  loadVersion(); checkForUpdate(); loadSettings(); loadFfmpeg(); loadWhisper(); loadIntro(); loadArr(); loadSources(); loadPreroll();
  // Resume the live monitor if settings reopens on the "Now Playing" tab.
  if (document.querySelector('#settings .settings-tabs .tab[data-tab="sessions"].active')) startSessionsPolling();
  await renderLibraries();
}

// ---- Pre-roll video (admin): a clip that plays before every movie ----
const prerollPathEl = document.getElementById('preroll-path');
const prerollSaveEl = document.getElementById('preroll-save');
const prerollStatusEl = document.getElementById('preroll-status');
async function loadPreroll() {
  if (!prerollPathEl) return;
  try {
    const s = await (await fetch('/api/settings')).json();
    if (!s.preroll) return; // non-admin
    prerollPathEl.value = s.preroll.path || '';
    if (s.preroll.path) prerollStatusEl.textContent = s.preroll.available
      ? '✓ Found on the server — plays before every movie.'
      : '⚠ Saved, but no file was found at that path on the server.';
  } catch (_e) {}
}
if (prerollSaveEl) prerollSaveEl.addEventListener('click', async () => {
  prerollSaveEl.textContent = 'Saving…'; prerollSaveEl.disabled = true;
  try {
    const r = await (await fetch('/api/settings/preroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: prerollPathEl.value.trim() }) })).json();
    prerollStatusEl.textContent = !r.path ? 'Pre-roll cleared — movies play with no intro.'
      : (r.available ? '✓ Saved — plays before every movie.' : '⚠ Saved, but no file was found at that path on the server.');
  } catch (_e) { prerollStatusEl.textContent = 'Could not save.'; }
  prerollSaveEl.textContent = 'Save pre-roll'; prerollSaveEl.disabled = false;
  refreshPreroll(); // pick up the new (or cleared) pre-roll for the next movie
});

// ---- Streaming services (admin preview): which sources merge into browse.
// Per-user server-side (follows the account), but the API is admin-gated for now.
async function loadSources() {
  const box = document.getElementById('sources-list');
  if (!box) return;
  let d;
  try { d = await (await fetch('/api/providers')).json(); } catch (_e) { return; }
  if (!d || !d.providers) return; // non-admin (403) — nothing to show
  const enabled = new Set(d.enabled || []);
  const chip = (id, name, color, on) =>
    `<button class="src-chip${on ? ' on' : ''}" data-src="${id}" style="--chip:${color}">${escapeHtml(name)}</button>`;
  box.innerHTML = chip('local', '📁 Local library', 'var(--accent)', d.local !== false)
    + d.providers.map((p) => chip(p.id, p.name, p.color, enabled.has(p.id))).join('');
  box.querySelectorAll('.src-chip').forEach((b) => b.addEventListener('click', async () => {
    b.classList.toggle('on');
    const on = [...box.querySelectorAll('.src-chip.on')].map((x) => x.dataset.src);
    const body = { local: on.includes('local'), enabled: on.filter((x) => x !== 'local') };
    try { await fetch('/api/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_e) {}
    await loadAll(); renderView(); // re-merge and repaint browse with the new sources
  }));
}

// ---- Audio (per-DEVICE, localStorage): these depend on the screen's speakers,
// not the person, so — unlike every other pref — they live in localStorage and
// ride along on each play request as query params. The /api/play + /api/transcode
// routes apply the fold/filters server-side (a TV's own 5.1→stereo fold drops the
// center/dialogue channel). Keys: audioMode (stereo|surround), dboost (off|
// normal|strong), night (0|1), norm (0|1).
const AUDIO_DEFAULTS = { audioMode: 'stereo', dboost: 'normal', night: '0', norm: '0' };
const audioGet = (k) => localStorage.getItem(k) || AUDIO_DEFAULTS[k];
function audioQuery() {
  const p = new URLSearchParams();
  p.set('audio', audioGet('audioMode') === 'surround' ? 'surround' : 'stereo');
  if (audioGet('dboost') !== 'normal') p.set('dboost', audioGet('dboost'));
  if (audioGet('night') === '1') p.set('night', '1');
  if (audioGet('norm') === '1') p.set('norm', '1');
  return p.toString();
}
// Segmented controls: [localStorage key, data-* attribute] per group. Clicking a
// button stores its value and repaints the group (selected = the `primary` look).
const AUDIO_GROUPS = [['audioMode', 'audio'], ['dboost', 'dboost'], ['night', 'night'], ['norm', 'norm']];
function paintAudio() {
  for (const [key, attr] of AUDIO_GROUPS)
    document.querySelectorAll('[data-' + attr + ']').forEach((b) => b.classList.toggle('primary', b.dataset[attr] === audioGet(key)));
}
for (const [key, attr] of AUDIO_GROUPS)
  document.querySelectorAll('[data-' + attr + ']').forEach((b) => b.addEventListener('click', () => { localStorage.setItem(key, b.dataset[attr]); paintAudio(); }));

// Settings tabs (General / Audio): show the matching panel, highlight the tab.
// Uses the app's `.tabs > .tab` convention so the remote focus engine can land
// on them (they're in its SELECTOR / HGROUP) — not a mouse-only control.
document.querySelectorAll('#settings .settings-tabs .tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('#settings .settings-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('#settings .tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === t.dataset.tab));
  // The "Now Playing" monitor only polls while its tab is the one on screen.
  if (t.dataset.tab === 'sessions') startSessionsPolling(); else stopSessionsPolling();
}));

// ---- Admin "Now Playing" monitor: live playback sessions across all users ----
let sessionsTimer = null;
function startSessionsPolling() { loadSessions(); clearInterval(sessionsTimer); sessionsTimer = setInterval(loadSessions, 4000); }
function stopSessionsPolling() { clearInterval(sessionsTimer); sessionsTimer = null; }
const sessCountEl = document.getElementById('sess-count');
const sessListEl = document.getElementById('sessions-list');
// A compact browser/device label from the User-Agent, for the "on what" column.
function deviceLabel(ua, tv) {
  ua = ua || '';
  let os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux' : '';
  let br = /Edg\//i.test(ua) ? 'Edge' : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari' : '';
  const parts = [tv ? '📺 TV' : '', os, br].filter(Boolean);
  return parts.join(' · ') || 'Unknown device';
}
function engineText(s) {
  const e = s.engine;
  if (s.mode !== 'transcode') return 'Direct play' + (e && e.video ? ` · ${e.video.codec} ${e.video.height}p` : '');
  if (!e) return 'Transcoding';
  const chLbl = (c) => (c === 1 ? 'mono' : c === 2 ? 'stereo' : c + 'ch');
  const v = e.video ? `${e.video.codec} ${e.video.height}p → ${e.videoAction || '?'}` : '';
  const a = e.audio ? `${e.audio.codec} ${chLbl(e.audio.channels)} → ${e.audioAction || '?'}` : '';
  return `Transcoding · V ${v} · A ${a}`;
}
const READY = ['nothing', 'metadata', 'current', 'future', 'enough'];
const NETST = ['empty', 'idle', 'loading', 'no source'];
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
async function loadSessions() {
  if (!sessListEl) return;
  let d = null;
  try { const r = await fetch('/api/admin/sessions'); if (!r.ok) return; d = await r.json(); } catch (_e) { return; }
  const list = (d && d.sessions) || [];
  if (sessCountEl) sessCountEl.textContent = list.length ? `${list.length} watching` : 'nobody watching';
  if (!list.length) {
    sessListEl.innerHTML = '<div class="sess-empty muted">No one is watching anything right now.</div>';
    return;
  }
  sessListEl.innerHTML = list.map((s) => {
    const pct = s.duration ? Math.min(100, Math.max(0, (s.position / s.duration) * 100)) : 0;
    const what = escapeHtml(s.title || 'Unknown') + (s.subtitle ? ` — <span class="muted">${escapeHtml(s.subtitle)}</span>` : '');
    const transcoding = s.mode === 'transcode';
    const stale = s.staleSec > 20; // missed ~2 heartbeats: connection may have dropped
    const health = [
      `buffered ${Math.round(s.bufferedAhead || 0)}s`,
      s.readyState != null ? READY[s.readyState] || ('ready ' + s.readyState) : null,
      s.networkState === 2 ? 'loading' : (s.networkState != null ? NETST[s.networkState] : null),
      (s.videoW && s.videoH) ? `${s.videoW}×${s.videoH}` : null
    ].filter(Boolean).join(' · ');
    const low = (s.bufferedAhead || 0) < 3 && !s.paused && !s.live; // possible buffering/stall
    return `
      <div class="sess-card${stale ? ' sess-stale' : ''}">
        <div class="sess-top">
          <span class="sess-user">${escapeHtml(s.username)}</span>
          <span class="sess-badges">
            <span class="sess-badge ${transcoding ? 'b-transcode' : 'b-direct'}">${transcoding ? '⚙ Transcode' : '▶ Direct'}</span>
            ${s.live ? '<span class="sess-badge b-live">LIVE</span>' : ''}
            <span class="sess-badge ${s.paused ? 'b-paused' : 'b-playing'}">${s.paused ? '⏸ Paused' : '▶ Playing'}</span>
            ${low ? '<span class="sess-badge b-warn">⏳ Low buffer</span>' : ''}
            ${stale ? '<span class="sess-badge b-warn">⚠ No signal ' + s.staleSec + 's</span>' : ''}
          </span>
        </div>
        <div class="sess-what">${what}</div>
        <div class="sess-bar"><div class="sess-bar-fill" style="width:${pct}%"></div></div>
        <div class="sess-meta muted">
          ${s.live ? 'LIVE' : `${fmtDur(s.position)} / ${fmtDur(s.duration)} (${Math.round(pct)}%)`}
          · watching ${fmtDur(s.watchingForSec)}
        </div>
        <div class="sess-eng muted">${escapeHtml(engineText(s))}</div>
        <div class="sess-dev muted">${escapeHtml(deviceLabel(s.userAgent, s.tv))} · ${escapeHtml(s.ip || '')} · ${escapeHtml(health)}${s.subtitleTrack && s.subtitleTrack !== 'off' ? ' · CC ' + escapeHtml(s.subtitleTrack) : ''} · ${escapeHtml(s.audioMode || '')}</div>
      </div>`;
  }).join('');
}

// ---- Requests: Radarr/Sonarr connection settings ----
const arrStatus = document.getElementById('arr-status');
const arrSave = document.getElementById('arr-save');
const radarrUrl = document.getElementById('radarr-url');
const radarrKey = document.getElementById('radarr-key');
const sonarrUrl = document.getElementById('sonarr-url');
const sonarrKey = document.getElementById('sonarr-key');
function arrStatusText(s) {
  const one = (name, x) => x && x.configured ? `${name} ${x.ok ? '✓ connected' + (x.version ? ' (v' + x.version + ')' : '') : '⚠ ' + (x.error || 'unreachable')}` : `${name} — not set`;
  return `${one('Radarr', s.radarr)} · ${one('Sonarr', s.sonarr)}`;
}
async function loadArr() {
  try {
    const s = await (await fetch('/api/settings')).json();
    if (s.radarr) radarrUrl.value = s.radarr.url || '';
    if (s.sonarr) sonarrUrl.value = s.sonarr.url || '';
    if (s.radarr && s.radarr.configured || s.sonarr && s.sonarr.configured) {
      const st = await (await fetch('/api/requests/status')).json();
      arrStatus.textContent = arrStatusText(st);
    }
  } catch (_e) {}
}
arrSave.addEventListener('click', async () => {
  arrSave.textContent = 'Testing…'; arrSave.disabled = true;
  const body = {
    radarr: { url: radarrUrl.value.trim(), apiKey: radarrKey.value.trim() },
    sonarr: { url: sonarrUrl.value.trim(), apiKey: sonarrKey.value.trim() }
  };
  try {
    const st = await (await fetch('/api/settings/arr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    arrStatus.textContent = arrStatusText(st);
  } catch (_e) { arrStatus.textContent = 'Could not save.'; }
  arrSave.textContent = 'Save & test connection'; arrSave.disabled = false;
  radarrKey.value = ''; sonarrKey.value = ''; // don't keep secrets in the field
});

// ---- AI subtitle engine (whisper) status + one-click install ----
const wsStatus = document.getElementById('ws-status');
const wsInstall = document.getElementById('ws-install');
let wsTimer = null;
async function loadWhisper() {
  clearTimeout(wsTimer); wsTimer = null;
  let s;
  try { s = await (await fetch('/api/whisper')).json(); } catch (_e) { wsStatus.textContent = ''; return; }
  if (s.installing) {
    wsInstall.classList.remove('hidden'); wsInstall.disabled = true; wsInstall.textContent = 'Installing…';
    const p = s.installing;
    wsStatus.textContent = p.phase && p.phase.startsWith('downloading') ? `⬇ ${p.phase}… ${p.pct}% (the GPU build is large — hang tight)` : `⚙ ${p.phase || 'setting up'}…`;
    wsTimer = setTimeout(loadWhisper, 1200);
    return;
  }
  if (s.available) {
    wsStatus.textContent = `✓ Ready — running on ${s.gpu ? 'the GPU ⚡ (fast)' : 'the CPU'}.`
      + (!s.gpu && s.gpuAvailable ? ' An NVIDIA GPU was detected — switch to it for much faster subtitles.' : '');
    if (!s.gpu && s.gpuAvailable) {
      wsInstall.classList.remove('hidden'); wsInstall.disabled = false;
      wsInstall.textContent = '⚡ Switch to GPU (much faster, ~680 MB)'; wsInstall.dataset.force = '1';
    } else wsInstall.classList.add('hidden');
    return;
  }
  wsInstall.classList.remove('hidden'); wsInstall.disabled = false; wsInstall.dataset.force = '';
  wsInstall.textContent = s.gpuAvailable ? '⬇ Install AI subtitle engine (GPU)' : '⬇ Install AI subtitle engine';
  wsStatus.textContent = s.error
    ? `Install failed: ${s.error}`
    : 'Not installed. Generates subtitles locally when none exist, and translates to English or Spanish. Needs the playback engine too.'
      + (s.gpuAvailable ? ' Your NVIDIA GPU will be used (fast).' : '');
}
wsInstall.addEventListener('click', async () => {
  const force = wsInstall.dataset.force === '1';
  wsInstall.disabled = true;
  try { await fetch('/api/whisper/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }) }); } catch (_e) {}
  loadWhisper();
});

// ---- Playback engine (ffmpeg) status + one-click install ----
const ffStatus = document.getElementById('ff-status');
const ffInstall = document.getElementById('ff-install');
let ffTimer = null;
async function loadFfmpeg() {
  clearTimeout(ffTimer); ffTimer = null;
  let s;
  try { s = await (await fetch('/api/ffmpeg')).json(); } catch (_e) { ffStatus.textContent = ''; return; }
  if (s.available) {
    ffStatus.textContent = `✓ Ready — every file type can play${s.nvenc ? ' (GPU accelerated)' : ''}.`;
    ffInstall.classList.add('hidden');
    return;
  }
  ffInstall.classList.remove('hidden');
  if (s.installing) {
    ffInstall.disabled = true;
    ffInstall.textContent = 'Installing…';
    ffStatus.textContent = s.installing.phase === 'downloading'
      ? `⬇ Downloading FFmpeg… ${s.installing.pct}%`
      : '⚙ Extracting & setting up…';
    ffTimer = setTimeout(loadFfmpeg, 1200);
  } else {
    ffInstall.disabled = false;
    ffInstall.textContent = '⬇ Install playback engine';
    ffStatus.textContent = s.error
      ? `Install failed: ${s.error} — try again.`
      : 'Not installed. Lets the server play formats browsers can\'t (MKV, HEVC, AVI, surround audio). One click, ~90 MB download.';
  }
}
ffInstall.addEventListener('click', async () => {
  ffInstall.disabled = true;
  try { await fetch('/api/ffmpeg/install', { method: 'POST' }); } catch (_e) {}
  loadFfmpeg();
});

// ---- Skip Intro detection status + manual re-run (admin) ----
const introStatusEl = document.getElementById('intro-status');
const introRunBtn = document.getElementById('intro-run');
let introTimer = null;
async function loadIntro() {
  if (!introStatusEl) return;
  clearTimeout(introTimer); introTimer = null;
  let s;
  try { s = await (await fetch('/api/intro/status')).json(); } catch (_e) { return; }
  if (s.error) return; // non-admin
  if (!s.totalEpisodes) { introStatusEl.textContent = 'No TV episodes in the library yet — Skip Intro is TV-only (movies have no intro).'; introRunBtn.classList.add('hidden'); return; }
  const parts = [`${s.checked}/${s.totalEpisodes} episodes analyzed`, `${s.found} intros found`];
  if (!s.fpcalc) parts.unshift('fingerprint tool installs on first run');
  introStatusEl.textContent = (s.running ? '⚙ Analyzing… ' : '') + parts.join(' · ')
    + (s.running ? '' : (s.checked < s.totalEpisodes ? ' — runs in the background.' : ' — done.'));
  introRunBtn.classList.remove('hidden');
  introRunBtn.disabled = s.running;
  introRunBtn.textContent = s.running ? 'Analyzing…' : (s.checked >= s.totalEpisodes ? 'Re-detect all intros' : 'Detect intros now');
  if (s.running || s.checked < s.totalEpisodes) introTimer = setTimeout(loadIntro, 4000); // poll while it works
}
if (introRunBtn) introRunBtn.addEventListener('click', async () => {
  // Re-detect all = force (clear intro_checked); otherwise just process the unchecked.
  const force = introRunBtn.textContent.startsWith('Re-detect');
  introRunBtn.disabled = true; introRunBtn.textContent = 'Starting…';
  try { await fetch('/api/intro/run' + (force ? '?force=1' : ''), { method: 'POST' }); } catch (_e) {}
  setTimeout(loadIntro, 800);
});

async function renderLibraries() {
  const libs = await (await fetch('/api/libraries')).json();
  if (!libs.length) { libList.innerHTML = '<div class="lib-empty">No folders yet — add one above.</div>'; return; }
  libList.innerHTML = '';
  for (const lib of libs) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.innerHTML = `<span class="tag ${lib.type}">${lib.type === 'tv' ? 'TV' : 'Movies'}</span>
      <span class="path">${escapeHtml(lib.path)}</span><button class="rm" title="Remove">✕</button>`;
    item.querySelector('.rm').addEventListener('click', async () => {
      if (!confirm(`Remove this ${lib.type === 'tv' ? 'TV Shows' : 'Movies'} folder?\n\n${lib.path}`)) return;
      await fetch('/api/libraries/' + lib.id, { method: 'DELETE' });
      await renderLibraries(); loadAll().then(renderView);
    });
    libList.appendChild(item);
  }
}

async function openPicker(type) {
  pickerState.type = type;
  pickerTitle.textContent = type === 'tv' ? 'Choose your TV Shows folder' : 'Choose your Movies folder';
  picker.classList.remove('hidden');
  await navigate(null);
}
async function navigate(path) {
  const data = await (await fetch(path ? '/api/fs?path=' + encodeURIComponent(path) : '/api/fs')).json();
  pickerState.path = data.path; pickerState.parent = data.parent;
  pickerPath.textContent = data.path || 'This PC — pick a drive';
  pickerChoose.disabled = !data.path; pickerChoose.style.opacity = data.path ? '1' : '0.45';
  const rows = data.drives && data.drives.length ? data.drives : data.dirs;
  pickerList.innerHTML = '';
  if (!rows || !rows.length) { pickerList.innerHTML = '<div class="frow"><span class="lib-empty">No sub-folders here — use this folder, or go up.</span></div>'; return; }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'frow';
    row.innerHTML = `<span>📁</span><span>${escapeHtml(r.name)}</span>`;
    row.addEventListener('click', () => navigate(r.path));
    pickerList.appendChild(row);
  }
}
pickerUp.addEventListener('click', () => navigate(pickerState.parent));
pickerChoose.addEventListener('click', async () => {
  if (!pickerState.path) return;
  pickerChoose.textContent = 'Adding…'; pickerChoose.disabled = true;
  await fetch('/api/libraries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pickerState.path, type: pickerState.type }) });
  pickerChoose.textContent = 'Use this folder';
  picker.classList.add('hidden');
  await renderLibraries(); loadAll().then(renderView);
});

async function loadVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    const v = await r.json();
    versionEl.textContent = v.sha && v.sha !== 'unknown' ? `version ${v.sha}${v.date ? ' · ' + v.date : ''}` : 'updates not enabled yet';
  } catch (_e) { versionEl.textContent = 'version unavailable'; }
}
async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    if (s.user) {
      const nameEl = document.getElementById('acct-name'); if (nameEl) nameEl.textContent = s.user.username;
      const roleEl = document.getElementById('acct-role'); if (roleEl) roleEl.textContent = s.user.role === 'admin' ? 'admin' : '';
    }
    if (s.openSubtitles.configured) { osStatus.textContent = '✓ Subtitle search is on' + (s.openSubtitles.username ? ' (' + s.openSubtitles.username + ')' : '') + '.'; osUser.value = s.openSubtitles.username || ''; }
    else osStatus.textContent = 'Add your free OpenSubtitles account to enable subtitle search.';
  } catch (_e) { osStatus.textContent = ''; }
  if (currentUser && currentUser.role === 'admin') loadUsers();
}

// ---- Account: logout + (admin) user management ----
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_e) {}
  location.reload();
});

async function loadUsers() {
  const list = document.getElementById('users-list');
  if (!list) return;
  let users = [];
  try { users = await (await fetch('/api/users')).json(); } catch (_e) { return; }
  if (!Array.isArray(users)) return;
  list.innerHTML = '';
  for (const u of users) {
    const isMe = currentUser && u.id === currentUser.id;
    const row = document.createElement('div');
    row.className = 'acct-item';
    const label = document.createElement('span');
    label.textContent = u.username + (u.role === 'admin' ? ' · admin' : '') + (isMe ? ' (you)' : '');
    row.appendChild(label);
    if (!isMe && u.role !== 'admin') {
      const del = document.createElement('button');
      del.className = 'btn'; del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        if (!confirm('Remove ' + u.username + '? Their watch history and settings are deleted.')) return;
        await fetch('/api/users/' + u.id, { method: 'DELETE' });
        loadUsers();
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  }
}

const nuAdd = document.getElementById('nu-add');
if (nuAdd) nuAdd.addEventListener('click', async () => {
  const u = document.getElementById('nu-user');
  const p = document.getElementById('nu-pass');
  const username = u.value.trim();
  const password = p.value;
  if (!username || !password) return;
  nuAdd.disabled = true;
  const r = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  nuAdd.disabled = false;
  if (r.ok) { u.value = ''; p.value = ''; loadUsers(); }
  else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not add user.'); }
});
osSave.addEventListener('click', async () => {
  osSave.textContent = 'Saving…'; osSave.disabled = true;
  let d = {};
  try { d = await (await fetch('/api/settings/opensubtitles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: osKey.value.trim(), username: osUser.value.trim(), password: osPass.value }) })).json(); } catch (_e) {}
  osSave.textContent = 'Save subtitle account'; osSave.disabled = false;
  osStatus.textContent = d.configured ? '✓ Saved — subtitle search is on.' : 'Saved.';
  osKey.value = ''; osPass.value = '';
});

async function checkForUpdate() {
  // Only admins can update the shared server, so only they see update UI.
  const isAdmin = currentUser && currentUser.role === 'admin';
  updateBtn.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) { updatePill.classList.add('hidden'); return; }
  try {
    const r = await (await fetch('/api/check-update', { cache: 'no-store' })).json();
    updatePill.classList.toggle('hidden', !r.updateAvailable);
    updateBtn.textContent = r.updateAvailable ? '⟳ Update available' : '⟳ Up to date';
    if (r.updateAvailable && getPref('skipUpdate') !== r.latest) showUpdateSplash(r);
    else if (!r.updateAvailable) updateSplash.classList.add('hidden');
  } catch (_e) {}
}
const updateOverlay = document.getElementById('update-overlay');
const updateStage = document.getElementById('update-stage');
const updateDetail = document.getElementById('update-detail');
const uSteps = { fetch: document.getElementById('ustep-fetch'), restart: document.getElementById('ustep-restart'), reload: document.getElementById('ustep-reload') };
function setStage(t, d) { updateStage.textContent = t; updateDetail.textContent = d || ''; }
function markStep(active, done) { Object.values(uSteps).forEach((el) => el.classList.remove('active')); done.forEach((k) => uSteps[k].classList.add('done')); if (active) uSteps[active].classList.add('active'); }
async function runUpdate(skipConfirm) {
  if (!skipConfirm && !confirm('Update to the latest version?\n\nThe server will restart and this page will reload automatically.')) return;
  Object.values(uSteps).forEach((el) => el.classList.remove('active', 'done'));
  updateOverlay.classList.remove('hidden');
  setStage('Starting update…', 'Asking the server to fetch the latest code'); markStep('fetch', []);
  try { await fetch('/api/update', { method: 'POST' }); } catch (_e) {}
  setStage('Applying update…', 'Pulling changes and restarting the server'); markStep('restart', ['fetch']);
  const start = Date.now();
  const poll = async () => {
    try { const r = await fetch('/api/version', { cache: 'no-store' }); if (r.ok) { const v = await r.json(); markStep('reload', ['fetch', 'restart']); setStage('Updated! 🎉', `Now on ${v.sha || ''} — reloading…`); setTimeout(() => location.reload(), 1400); return; } } catch (_e) {}
    if (Date.now() - start < 90000) { setStage('Restarting server…', 'Waiting for it to come back online'); setTimeout(poll, 1500); }
    else setStage('This is taking a while', 'The server may need a manual restart on the Dell.');
  };
  setTimeout(poll, 3000);
}
updateBtn.addEventListener('click', () => runUpdate());
updatePill.addEventListener('click', () => runUpdate());

// ---- Update splash (admin): forced-to-notice, with a skip + "what's new" ----
const updateSplash = document.getElementById('update-splash');
const usNotes = document.getElementById('us-notes');
const usSub = document.getElementById('us-sub');
document.getElementById('us-update').addEventListener('click', () => { updateSplash.classList.add('hidden'); runUpdate(true); });
document.getElementById('us-skip').addEventListener('click', () => {
  if (updateSplash.dataset.latest) setPref('skipUpdate', updateSplash.dataset.latest);
  updateSplash.classList.add('hidden');
});
function showUpdateSplash(r) {
  updateSplash.dataset.latest = r.latest;
  usSub.textContent = `You're on ${r.current} — ${r.latest} is ready`
    + (r.behind ? ` (${r.behind} update${r.behind > 1 ? 's' : ''} behind).` : '.');
  const notes = (r.notes && r.notes.length) ? r.notes : ['Improvements and fixes.'];
  usNotes.innerHTML = notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  updateSplash.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Boot ----------
(async function init() {
  setupAuth();
  const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!me || !me.user) { showAuth(); return; }
  currentUser = me.user;
  document.body.classList.toggle('is-admin', currentUser.role === 'admin');
  hideAuth();
  await loadAll();
  renderView();
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
})();

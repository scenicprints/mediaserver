// ============================================================
//  MYFLIX — front-end
// ============================================================
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

const NEW_MS = 14 * 24 * 3600 * 1000;
const isNew = (it) => it.added_at && Date.now() - it.added_at < NEW_MS;
const byRecent = (a, b) => (b.added_at || 0) - (a.added_at || 0);
const byRating = (a, b) => (b.rating || 0) - (a.rating || 0);

async function loadAll() {
  const [mv, sh, cont] = await Promise.all([
    fetch('/api/movies').then((r) => r.json()),
    fetch('/api/shows').then((r) => r.json()),
    fetch('/api/continue').then((r) => r.json())
  ]);
  movies = mv; shows = sh; continueItems = cont;
}

// ---------- Navigation ----------
document.querySelectorAll('.nav-link').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view))
);
document.getElementById('lib-btn').addEventListener('click', () => {
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  if (currentView === 'tv') showGridView('All TV Shows', mediaCards([...shows].sort(byTitle), 'show'));
  else showGridView('All Movies', mediaCards([...movies].sort(byTitle), 'movie'));
});

function setView(view) {
  currentView = view;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  search.value = '';
  window.scrollTo({ top: 0 });
  renderView();
}

window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40));

function genresOf(m) { try { return JSON.parse(m.genres || '[]'); } catch { return []; } }
function allGenres(list) { const s = new Set(); list.forEach((m) => genresOf(m).forEach((g) => s.add(g))); return [...s].sort(); }
function decadesOf(list) { return [...new Set(list.map((m) => (m.year ? Math.floor(m.year / 10) * 10 : null)).filter(Boolean))].sort((a, b) => b - a); }

function renderView() {
  rowsEl.style.paddingTop = '';
  const rows = [];
  const byYear = (a, b) => (b.year || 0) - (a.year || 0);
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const cat = (title, list, kind) => { if (list.length) rows.push({ title, kind, cards: mediaCards(list.slice(0, 24), kind), seeAll: () => ({ title, cards: mediaCards(list, kind) }) }); };

  if (currentView === 'movies') {
    setHero(movies.filter((m) => m.backdrop));
    const cw = continueItems.filter((c) => c.kind === 'movie');
    if (cw.length) rows.push({ title: 'Continue Watching', cards: continueCards(cw) });
    cat('Recently Added', [...movies].sort(byRecent), 'movie');
    cat('Recently Released', [...movies].sort(byYear), 'movie');
    cat('Top Rated', [...movies].sort(byRating), 'movie');
    cat('Critically Acclaimed', movies.filter((m) => m.rating >= 8).sort(byRating), 'movie');
    cat('Unwatched', movies.filter((m) => !m.watched), 'movie');
    cat('Watched Again', movies.filter((m) => m.watched), 'movie');
    cat('Favorites', movies.filter((m) => m.favorite), 'movie');
    cat('4K', movies.filter((m) => (m.qualities || '').includes('4K')), 'movie');
    allGenres(movies).forEach((g) => cat(g, movies.filter((m) => genresOf(m).includes(g)).sort(byRating), 'movie'));
    decadesOf(movies).forEach((d) => cat(`${d}s`, movies.filter((m) => m.year >= d && m.year < d + 10).sort(byYear), 'movie'));
    rows.push({ title: 'All Movies', cards: mediaCards([...movies].sort(byTitle), 'movie'), grid: true });
  } else if (currentView === 'tv') {
    setHero(shows.filter((s) => s.backdrop));
    const cw = continueItems.filter((c) => c.kind === 'episode');
    if (cw.length) rows.push({ title: 'Continue Watching', cards: continueCards(cw) });
    cat('Recently Added', [...shows].sort(byRecent), 'show');
    cat('New Episodes', shows.filter((s) => s.unwatched > 0), 'show');
    cat('Recently Released', [...shows].sort(byYear), 'show');
    cat('Top Rated', [...shows].sort(byRating), 'show');
    cat('Critically Acclaimed', shows.filter((s) => s.rating >= 8).sort(byRating), 'show');
    allGenres(shows).forEach((g) => cat(g, shows.filter((s) => genresOf(s).includes(g)).sort(byRating), 'show'));
    decadesOf(shows).forEach((d) => cat(`${d}s`, shows.filter((s) => s.year >= d && s.year < d + 10).sort(byYear), 'show'));
    rows.push({ title: 'All Shows', cards: mediaCards([...shows].sort(byTitle), 'show'), grid: true });
  } else {
    const mixed = [...movies.filter((m) => m.backdrop), ...shows.filter((s) => s.backdrop)].sort(byRating);
    setHero(mixed);
    if (continueItems.length) rows.push({ title: 'Continue Watching', cards: continueCards(continueItems) });
    rows.push({ title: 'Recently Added', cards: mixedRecent(24) });
    cat('Movies', [...movies].sort(byRating), 'movie');
    cat('TV Shows', [...shows].sort(byRating), 'show');
    cat('Recently Released', [...movies].sort(byYear), 'movie');
    cat('Critically Acclaimed', movies.filter((m) => m.rating >= 8).sort(byRating), 'movie');
    cat('Unwatched Movies', movies.filter((m) => !m.watched), 'movie');
    cat('Favorites', movies.filter((m) => m.favorite), 'movie');
    allGenres(movies).slice(0, 8).forEach((g) => cat(g, movies.filter((m) => genresOf(m).includes(g)).sort(byRating), 'movie'));
  }
  drawRows(rows);
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
function setHero(items) {
  heroItems = (items || []).slice(0, 6);
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

function buildMediaCard(it, kind) {
  const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
  let badge = '';
  if (kind === 'show' && it.unwatched > 0) badge = `<div class="badge new">${it.unwatched} new</div>`;
  else if (isNew(it)) badge = `<div class="badge new">NEW</div>`;
  else if (kind === 'movie' && it.versions > 1 && it.qualities) badge = `<div class="badge">${it.qualities.split(',').sort().reverse()[0]}</div>`;
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
function playTrailer(key) {
  const ov = document.createElement('div');
  ov.className = 'update-overlay'; ov.style.zIndex = 90;
  ov.innerHTML = `<div style="width:min(92vw,1040px);aspect-ratio:16/9;position:relative">
    <iframe src="https://www.youtube.com/embed/${key}?autoplay=1" allow="autoplay; fullscreen" allowfullscreen
      style="width:100%;height:100%;border:0;border-radius:12px"></iframe></div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

async function openDetail(id, autoplay = true) {
  const [m, extra] = await Promise.all([
    fetch('/api/movies/' + id).then((r) => r.json()),
    fetch('/api/movies/' + id + '/extra').then((r) => r.json()).catch(() => ({}))
  ]);
  const files = m.files || [];
  let current = files[0];
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
            ${resume ? `<button class="btn btn-play" id="d-resume">▶ Resume</button><button class="btn" id="d-begin">↺ From beginning</button>` : `<button class="btn btn-play" id="d-play">▶ Play</button>`}
            <button class="btn" id="favBtn">${m.favorite ? '★ Favorited' : '☆ Favorite'}</button>
            <button class="btn" id="watchedBtn">${m.watched ? '✓ Watched' : 'Mark watched'}</button>
            ${versionControl}
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

  const sel = document.getElementById('ver-select');
  if (sel) sel.addEventListener('change', () => { const f = files.find((x) => String(x.id) === sel.value); if (f) current = f; });

  function play(at) {
    openPlayer({
      title: m.title, files, startFileId: current.id,
      streamBase: '/api/stream/', subtitleBase: '/api/subtitle/', searchKind: 'movie',
      startAt: at, progressUrl: `/api/movies/${m.id}/progress`, upNext: null, onEnded: null
    });
  }
  if (resume) {
    document.getElementById('d-resume').addEventListener('click', () => play(resume));
    document.getElementById('d-begin').addEventListener('click', () => play(0));
  } else {
    document.getElementById('d-play').addEventListener('click', () => play(0));
  }
  if (autoplay) play(resume || 0);

  document.getElementById('favBtn').addEventListener('click', async (e) => {
    const { favorite } = await (await fetch(`/api/movies/${m.id}/favorite`, { method: 'POST' })).json();
    e.target.textContent = favorite ? '★ Favorited' : '☆ Favorite';
  });
  document.getElementById('watchedBtn').addEventListener('click', async (e) => {
    const next = m.watched ? 0 : 1;
    await fetch(`/api/movies/${m.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    m.watched = next; e.target.textContent = next ? '✓ Watched' : 'Mark watched';
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
    files, startFileId: opts.fileId || files[0].id,
    streamBase: '/api/stream/episode/', subtitleBase: '/api/subtitle/episode/', searchKind: 'episode',
    startAt: opts.startAt != null ? opts.startAt : (ep.resume_position > 5 ? ep.resume_position : 0),
    progressUrl: `/api/episodes/${ep.id}/progress`,
    upNext: next ? { label: 'Up Next', still: next.ep.still, title: episodeSub(next.ep), play: () => playEpisodeAt(show, flat, i + 1) } : null,
    onEnded: next ? () => playEpisodeAt(show, flat, i + 1) : null
  });
}

async function openEpisodeDetail(show, flat, i) {
  const ep = flat[i].ep;
  const files = ep.files || [];
  let current = files[0];
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
            ${resume ? `<button class="btn btn-play" id="ep-resume">▶ Resume</button><button class="btn" id="ep-begin">↺ From beginning</button>` : `<button class="btn btn-play" id="ep-play">▶ Play</button>`}
            <button class="btn" id="ep-watched">${ep.watched ? '✓ Watched' : 'Mark watched'}</button>
            ${versionControl}
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
  if (sel) sel.addEventListener('change', () => { const f = files.find((x) => String(x.id) === sel.value); if (f) current = f; });
  const playAt = (at) => playEpisodeAt(show, flat, i, { fileId: current.id, startAt: at });
  if (resume) {
    document.getElementById('ep-resume').addEventListener('click', () => playAt(resume));
    document.getElementById('ep-begin').addEventListener('click', () => playAt(0));
  } else {
    document.getElementById('ep-play').addEventListener('click', () => playAt(0));
  }
  document.getElementById('ep-watched').addEventListener('click', async (e) => {
    const next = ep.watched ? 0 : 1;
    await fetch(`/api/episodes/${ep.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    ep.watched = next; e.target.textContent = next ? '✓ Watched' : 'Mark watched';
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
          <div class="dp-actions"><button class="btn btn-play" id="s-play">▶ Play</button></div>
        </div>
      </div>
    </div>
    <div class="dp-body">
      <p class="overview">${escapeHtml(show.overview || '')}</p>
      <h3 class="seasons-h">Seasons</h3>
      <div class="season-cards" id="season-cards"></div>
      <div class="episode-list" id="episode-list"></div>
    </div>`;
  openDetailModal();
  detail.scrollTop = 0;

  const seasonCards = document.getElementById('season-cards');
  const epList = document.getElementById('episode-list');
  const seasonLabel = (s) => (s === 0 ? 'Specials' : 'Season ' + s);

  const flat = [];
  seasons.forEach((s, si) => s.episodes.forEach((ep) => flat.push({ ep, si })));

  document.getElementById('s-play').addEventListener('click', () => {
    const idx = flat.findIndex((f) => !f.ep.watched);
    playEpisodeAt(show, flat, idx >= 0 ? idx : 0);
  });

  function renderSeason(seasonObj) {
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
        ep.watched = next; if (next) { ep.resume_position = 0; row.querySelector('.eprog')?.remove(); }
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
  fullscreen: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>'
};

function openPlayer(ctx) {
  if (activePlayer) { activePlayer.remove(); activePlayer = null; }
  let current = ctx.files.find((f) => f.id === ctx.startFileId) || ctx.files[0];
  if (!current) return;
  let subOffset = 0;
  let cues = [];
  let subVisible = true;
  let upnextShown = false;

  const vp = document.createElement('div');
  vp.className = 'vp';
  vp.innerHTML = `
    <video playsinline></video>
    <div class="vp-subs"></div>
    <div class="vp-top vp-fade">
      <button class="vp-back">‹ Back</button>
      <div class="vp-titles"><div class="vp-t">${escapeHtml(ctx.title)}</div>${ctx.subtitle ? `<div class="vp-st">${escapeHtml(ctx.subtitle)}</div>` : ''}</div>
    </div>
    <div class="vp-center vp-fade">
      <button class="vp-skip" data-d="-10">${ICONS.back}<b>10</b></button>
      <button class="vp-bigplay">${ICONS.pause}</button>
      <button class="vp-skip" data-d="10">${ICONS.fwd}<b>10</b></button>
    </div>
    <div class="vp-bottom vp-fade">
      <div class="vp-scrub"><div class="vp-track"></div><div class="vp-buffered"></div><div class="vp-played"></div><input class="vp-seek" type="range" min="0" max="1000" value="0"></div>
      <div class="vp-ctrls">
        <button class="vp-play">${ICONS.pause}</button>
        <button class="vp-mute">${ICONS.volHigh}</button><input class="vp-volbar" type="range" min="0" max="1" step="0.05" value="1">
        <span class="vp-time">0:00 / 0:00</span>
        <div class="vp-spacer"></div>
        <button class="vp-cc" title="Subtitles">CC</button>
        <button class="vp-gear" title="Settings">${ICONS.gear}</button>
        <button class="vp-fs" title="Fullscreen">${ICONS.fullscreen}</button>
      </div>
    </div>
    <button class="vp-skipintro hidden">Skip Intro ⏭</button>
    <div class="vp-menu hidden"></div>
    <div class="vp-upnext hidden"></div>`;
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
  const playBtns = [vp.querySelector('.vp-play'), vp.querySelector('.vp-bigplay')];
  const skipIntro = vp.querySelector('.vp-skipintro');
  skipIntro.addEventListener('click', () => { video.currentTime = Math.min((video.duration || 9e9), video.currentTime + 80); skipIntro.classList.add('hidden'); });

  const subsDiv = vp.querySelector('.vp-subs');
  function parseVtt(text) {
    const out = [];
    text.replace(/\r/g, '').split(/\n\n+/).forEach((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) return;
      const m = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
      if (!m) return;
      const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
      const body = lines.slice(lines.indexOf(timeLine) + 1).join('\n').replace(/<[^>]+>/g, '');
      out.push({ start, end, html: escapeHtml(body).replace(/\n/g, '<br>') });
    });
    return out;
  }
  async function setSubtitle(url) {
    cues = []; renderSub();
    if (!url) return;
    try { const r = await fetch(url); if (r.ok) cues = parseVtt(await r.text()); } catch {}
    renderSub();
  }
  function renderSub() {
    if (!subVisible || !cues.length) { subsDiv.innerHTML = ''; return; }
    const t = video.currentTime - subOffset;
    const cue = cues.find((c) => t >= c.start && t <= c.end);
    subsDiv.innerHTML = cue ? cue.html : '';
  }
  function subOn() { return subVisible && cues.length > 0; }

  function loadFile(f, at) {
    current = f;
    video.src = ctx.streamBase + f.id;
    video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at; video.play(); }, { once: true });
    setSubtitle(f.subtitle ? ctx.subtitleBase + f.id : null);
  }
  loadFile(current, ctx.startAt || 0);

  function setPlayIcons() { const i = video.paused ? ICONS.play : ICONS.pause; playBtns.forEach((b) => (b.innerHTML = i)); }
  function togglePlay() { video.paused ? video.play() : video.pause(); }
  playBtns.forEach((b) => b.addEventListener('click', togglePlay));
  video.addEventListener('click', togglePlay);
  video.addEventListener('play', setPlayIcons);
  video.addEventListener('pause', setPlayIcons);
  vp.querySelectorAll('.vp-skip').forEach((b) => b.addEventListener('click', () => { video.currentTime += +b.dataset.d; }));

  // scrub + time
  let seeking = false;
  video.addEventListener('timeupdate', () => {
    if (!seeking && video.duration) { const p = video.currentTime / video.duration; playedBar.style.width = p * 100 + '%'; seek.value = p * 1000; }
    timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    if (video.buffered.length) bufferedBar.style.width = (video.buffered.end(video.buffered.length - 1) / (video.duration || 1)) * 100 + '%';
    skipIntro.classList.toggle('hidden', !(video.currentTime >= 5 && video.currentTime <= 90));
    renderSub();
    maybeUpNext();
    throttledSave();
  });
  seek.addEventListener('input', () => { seeking = true; if (video.duration) playedBar.style.width = (seek.value / 10) + '%'; });
  seek.addEventListener('change', () => { if (video.duration) video.currentTime = (seek.value / 1000) * video.duration; seeking = false; });

  // volume
  const mute = vp.querySelector('.vp-mute'), volbar = vp.querySelector('.vp-volbar');
  volbar.addEventListener('input', () => { video.volume = +volbar.value; video.muted = false; });
  mute.addEventListener('click', () => { video.muted = !video.muted; mute.innerHTML = video.muted ? ICONS.volMute : ICONS.volHigh; });

  // fullscreen
  vp.querySelector('.vp-fs').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else vp.requestFullscreen?.(); });

  // subtitles quick toggle
  vp.querySelector('.vp-cc').addEventListener('click', () => { subVisible = !subVisible; renderSub(); });

  // settings menu
  const gear = vp.querySelector('.vp-gear');
  function buildMenu() {
    const audio = video.audioTracks && video.audioTracks.length > 1 ? [...video.audioTracks] : [];
    menu.innerHTML = `
      ${ctx.files.length > 1 ? `<h4>Version</h4>${ctx.files.map((f, i) => `<button class="vp-opt ver" data-fid="${f.id}">${escapeHtml(versionLabel(f, i))}<span class="tick">${current.id === f.id ? '✓' : ''}</span></button>`).join('')}` : ''}
      ${audio.length ? `<h4>Audio</h4>${audio.map((a, i) => `<button class="vp-opt aud" data-i="${i}">${escapeHtml(a.label || a.language || 'Track ' + (i + 1))}<span class="tick">${a.enabled ? '✓' : ''}</span></button>`).join('')}` : ''}
      <h4>Subtitles</h4>
      <button class="vp-opt subo" data-m="off">Off<span class="tick">${!subOn() ? '✓' : ''}</span></button>
      ${cues.length || current.subtitle ? `<button class="vp-opt subo" data-m="on">English<span class="tick">${subOn() ? '✓' : ''}</span></button>` : ''}
      <button class="vp-opt" id="sub-search">Search online…</button>
      <div class="vp-offset"><span style="color:var(--muted);font-size:12px">Delay</span><button data-o="-0.25">−</button><span class="val">${subOffset.toFixed(2)}s</span><button data-o="0.25">+</button></div>`;
    menu.querySelectorAll('.ver').forEach((b) => b.addEventListener('click', () => { const f = ctx.files.find((x) => String(x.id) === b.dataset.fid); if (f && f.id !== current.id) loadFile(f, video.currentTime); buildMenu(); }));
    menu.querySelectorAll('.aud').forEach((b) => b.addEventListener('click', () => { [...video.audioTracks].forEach((a, i) => (a.enabled = i === +b.dataset.i)); buildMenu(); }));
    menu.querySelectorAll('.subo').forEach((b) => b.addEventListener('click', () => { subVisible = b.dataset.m === 'on'; renderSub(); buildMenu(); }));
    const ss = menu.querySelector('#sub-search');
    if (ss) ss.addEventListener('click', () => { menu.classList.add('hidden'); openSubSearch(ctx.searchKind, current.id, video, (url) => { current.subtitle = true; subVisible = true; setSubtitle(url); }); });
    menu.querySelectorAll('.vp-offset button').forEach((b) => b.addEventListener('click', () => { subOffset = Math.round((subOffset + +b.dataset.o) * 100) / 100; renderSub(); buildMenu(); }));
  }
  gear.addEventListener('click', () => { if (menu.classList.contains('hidden')) { buildMenu(); menu.classList.remove('hidden'); } else menu.classList.add('hidden'); });
  vp.addEventListener('click', (e) => { if (!menu.contains(e.target) && !gear.contains(e.target)) menu.classList.add('hidden'); });

  // up next
  function maybeUpNext() {
    if (!ctx.upNext || upnextShown || !video.duration) return;
    if (video.duration - video.currentTime <= 22) {
      upnextShown = true;
      upnext.innerHTML = `
        <div class="un-still" style="background-image:url('${ctx.upNext.still || ''}')"></div>
        <div class="un-body"><div class="un-label">${escapeHtml(ctx.upNext.label)}</div>
          <div class="un-title">${escapeHtml(ctx.upNext.title)}</div>
          <div class="un-actions"><button class="btn btn-play sm" id="un-play">▶ Play Now</button><button class="btn sm" id="un-dismiss">Dismiss</button></div></div>`;
      upnext.classList.remove('hidden');
      upnext.querySelector('#un-play').addEventListener('click', () => ctx.upNext.play());
      upnext.querySelector('#un-dismiss').addEventListener('click', () => upnext.classList.add('hidden'));
    }
  }

  // progress saving
  let lastSave = 0;
  function save() {
    fetch(ctx.progressUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: video.currentTime, duration: video.duration || null, watched: video.duration && video.currentTime / video.duration > 0.92 ? 1 : null }) });
  }
  function throttledSave() { if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); } }
  video.addEventListener('pause', save);
  video.addEventListener('ended', () => { save(); if (ctx.onEnded) ctx.onEnded(); });

  // auto-hide chrome
  let hideTimer;
  function showUI() { vp.classList.remove('hide-ui'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!video.paused && menu.classList.contains('hidden')) vp.classList.add('hide-ui'); }, 3000); }
  vp.addEventListener('mousemove', showUI);
  showUI();

  // close + keyboard
  function close() { save(); if (document.fullscreenElement) document.exitFullscreen(); vp.remove(); activePlayer = null; document.body.style.overflow = 'hidden'; }
  vp.querySelector('.vp-back').addEventListener('click', close);
  vp._onKey = (e) => {
    if (e.key === 'Escape') { if (document.fullscreenElement) return; e.stopPropagation(); close(); }
    else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') video.currentTime -= 5;
    else if (e.key === 'ArrowRight') video.currentTime += 5;
    else if (e.key === 'f') vp.querySelector('.vp-fs').click();
    else if (e.key === 'm') mute.click();
  };
  document.addEventListener('keydown', vp._onKey, true);
  const origRemove = vp.remove.bind(vp);
  vp.remove = () => { document.removeEventListener('keydown', vp._onKey, true); origRemove(); };
}

// ---------- Detail modal open/close ----------
function openDetailModal() { detail.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeDetail() {
  const player = document.getElementById('player');
  if (player) player.pause();
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
  } catch { subsStatus.textContent = 'Search failed.'; return; }
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
      catch { e.target.textContent = 'Failed'; e.target.disabled = false; return; }
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

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.add('hidden')));
[settingsModal, picker].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openPicker(b.dataset.add)));
settingsBtn.addEventListener('click', openSettings);

async function openSettings() {
  settingsModal.classList.remove('hidden');
  loadVersion(); checkForUpdate(); loadSettings();
  await renderLibraries();
}

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
  } catch { versionEl.textContent = 'version unavailable'; }
}
async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    if (s.openSubtitles.configured) { osStatus.textContent = '✓ Subtitle search is on' + (s.openSubtitles.username ? ' (' + s.openSubtitles.username + ')' : '') + '.'; osUser.value = s.openSubtitles.username || ''; }
    else osStatus.textContent = 'Add your free OpenSubtitles account to enable subtitle search.';
  } catch { osStatus.textContent = ''; }
}
osSave.addEventListener('click', async () => {
  osSave.textContent = 'Saving…'; osSave.disabled = true;
  let d = {};
  try { d = await (await fetch('/api/settings/opensubtitles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: osKey.value.trim(), username: osUser.value.trim(), password: osPass.value }) })).json(); } catch {}
  osSave.textContent = 'Save subtitle account'; osSave.disabled = false;
  osStatus.textContent = d.configured ? '✓ Saved — subtitle search is on.' : 'Saved.';
  osKey.value = ''; osPass.value = '';
});

async function checkForUpdate() {
  try {
    const r = await (await fetch('/api/check-update', { cache: 'no-store' })).json();
    updatePill.classList.toggle('hidden', !r.updateAvailable);
    updateBtn.textContent = r.updateAvailable ? '⟳ Update available' : '⟳ Up to date';
  } catch {}
}
const updateOverlay = document.getElementById('update-overlay');
const updateStage = document.getElementById('update-stage');
const updateDetail = document.getElementById('update-detail');
const uSteps = { fetch: document.getElementById('ustep-fetch'), restart: document.getElementById('ustep-restart'), reload: document.getElementById('ustep-reload') };
function setStage(t, d) { updateStage.textContent = t; updateDetail.textContent = d || ''; }
function markStep(active, done) { Object.values(uSteps).forEach((el) => el.classList.remove('active')); done.forEach((k) => uSteps[k].classList.add('done')); if (active) uSteps[active].classList.add('active'); }
async function runUpdate() {
  if (!confirm('Update to the latest version?\n\nThe server will restart and this page will reload automatically.')) return;
  Object.values(uSteps).forEach((el) => el.classList.remove('active', 'done'));
  updateOverlay.classList.remove('hidden');
  setStage('Starting update…', 'Asking the server to fetch the latest code'); markStep('fetch', []);
  try { await fetch('/api/update', { method: 'POST' }); } catch {}
  setStage('Applying update…', 'Pulling changes and restarting the server'); markStep('restart', ['fetch']);
  const start = Date.now();
  const poll = async () => {
    try { const r = await fetch('/api/version', { cache: 'no-store' }); if (r.ok) { const v = await r.json(); markStep('reload', ['fetch', 'restart']); setStage('Updated! 🎉', `Now on ${v.sha || ''} — reloading…`); setTimeout(() => location.reload(), 1400); return; } } catch {}
    if (Date.now() - start < 90000) { setStage('Restarting server…', 'Waiting for it to come back online'); setTimeout(poll, 1500); }
    else setStage('This is taking a while', 'The server may need a manual restart on the Dell.');
  };
  setTimeout(poll, 3000);
}
updateBtn.addEventListener('click', runUpdate);
updatePill.addEventListener('click', runUpdate);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Boot ----------
(async function init() {
  await loadAll();
  renderView();
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
})();

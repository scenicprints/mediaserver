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

function setView(view) {
  currentView = view;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  search.value = '';
  window.scrollTo({ top: 0 });
  renderView();
}

window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40));

function renderView() {
  const rows = [];
  if (currentView === 'movies') {
    setHero(movies.filter((m) => m.backdrop));
    rows.push(['Continue Watching', continueCards(continueItems.filter((c) => c.kind === 'movie'))]);
    rows.push(['Recently Added', mediaCards([...movies].sort(byRecent).slice(0, 20), 'movie')]);
    rows.push(['Top Rated', mediaCards([...movies].sort(byRating).slice(0, 20), 'movie')]);
    rows.push(['Favorites', mediaCards(movies.filter((m) => m.favorite), 'movie')]);
    rows.push(['All Movies', mediaCards([...movies].sort((a, b) => a.title.localeCompare(b.title)), 'movie')]);
  } else if (currentView === 'tv') {
    setHero(shows.filter((s) => s.backdrop));
    rows.push(['Continue Watching', continueCards(continueItems.filter((c) => c.kind === 'episode'))]);
    rows.push(['Recently Added', mediaCards([...shows].sort(byRecent).slice(0, 20), 'show')]);
    rows.push(['Top Rated', mediaCards([...shows].sort(byRating).slice(0, 20), 'show')]);
    rows.push(['All Shows', mediaCards([...shows].sort((a, b) => a.title.localeCompare(b.title)), 'show')]);
  } else {
    const mixed = [...movies.filter((m) => m.backdrop), ...shows.filter((s) => s.backdrop)].sort(byRating);
    setHero(mixed);
    rows.push(['Continue Watching', continueCards(continueItems)]);
    rows.push(['Recently Added', mixedRecent(20)]);
    rows.push(['Movies', mediaCards([...movies].sort(byRating), 'movie')]);
    rows.push(['TV Shows', mediaCards([...shows].sort(byRating), 'show')]);
    rows.push(['Favorites', mediaCards(movies.filter((m) => m.favorite), 'movie')]);
  }
  drawRows(rows);
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
  for (const [title, cards] of rows) {
    if (!cards.length) continue;
    const row = document.createElement('section');
    row.className = 'row';
    row.innerHTML = `<div class="row-head"><h3 class="row-title">${escapeHtml(title)}</h3></div>
      <button class="row-nav left">‹</button><div class="row-track"></div><button class="row-nav right">›</button>`;
    const track = row.querySelector('.row-track');
    cards.forEach((c) => track.appendChild(c));
    row.querySelector('.row-nav.left').addEventListener('click', () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' }));
    row.querySelector('.row-nav.right').addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' }));
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
      onOpen: () => openContinue(it),
      onPlay: () => openContinue(it),
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
function openContinue(it) {
  if (it.kind === 'movie') openDetail(it.id, true);
  else openShow(it.show_id, it.id, true);
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

// ---------- Movie detail ----------
async function openDetail(id, autoplay = true) {
  const m = await (await fetch('/api/movies/' + id)).json();
  const files = m.files || [];
  let current = files[0];
  const resume = m.resume_position && m.resume_position > 5 ? m.resume_position : 0;

  const versionRow = files.length > 1
    ? `<div class="versions"><span class="vlabel">Version</span>${files.map((f, i) => `<button class="qbtn${i === 0 ? ' active' : ''}" data-fid="${f.id}">${escapeHtml(f.quality || 'V' + (i + 1))}</button>`).join('')}</div>`
    : '';

  detailInner.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-hero" style="background-image:url('${m.backdrop || m.poster || ''}')">
        <video id="player" controls playsinline ${autoplay ? 'autoplay' : ''} poster="${m.backdrop || ''}" src="${current ? '/api/stream/' + current.id : ''}"></video>
      </div>
      <div class="detail-body">
        <h2>${escapeHtml(m.title)}</h2>
        <div class="detail-meta">
          ${m.year ? `<span class="chip">${m.year}</span>` : ''}
          ${m.rating ? `<span class="chip rating">★ ${m.rating.toFixed(1)}</span>` : ''}
          ${current && current.quality ? `<span class="chip q">${current.quality}</span>` : ''}
        </div>
        <div class="detail-actions">
          <button class="btn btn-play" id="d-play">▶ ${resume ? 'Resume' : 'Play'}</button>
          <button class="btn" id="favBtn">${m.favorite ? '★ Favorited' : '☆ Favorite'}</button>
          <button class="btn" id="watchedBtn">${m.watched ? '✓ Watched' : 'Mark watched'}</button>
          <button class="btn" id="subBtn">🔍 Subtitles</button>
        </div>
        ${versionRow}
        <p class="detail-overview">${escapeHtml(m.overview || 'No description yet.')}</p>
        ${current ? `<p class="filename">${escapeHtml(current.filename)}</p>` : ''}
      </div>
    </div>`;
  openDetailModal();

  const player = document.getElementById('player');
  if (resume) player.currentTime = resume;
  attachSubtitle(player, current && current.subtitle ? '/api/subtitle/' + current.id : null);
  document.getElementById('d-play').addEventListener('click', () => { player.scrollIntoView({ behavior: 'smooth', block: 'center' }); player.play(); });

  bindProgress(player, `/api/movies/${m.id}/progress`);

  detailInner.querySelectorAll('.qbtn').forEach((btn) => btn.addEventListener('click', () => {
    const f = files.find((x) => String(x.id) === btn.dataset.fid);
    if (!f || (current && current.id === f.id)) return;
    current = f;
    const at = player.currentTime, was = !player.paused;
    player.src = '/api/stream/' + f.id;
    player.addEventListener('loadedmetadata', () => { player.currentTime = at; if (was) player.play(); }, { once: true });
    attachSubtitle(player, f.subtitle ? '/api/subtitle/' + f.id : null);
    detailInner.querySelectorAll('.qbtn').forEach((b) => b.classList.toggle('active', b === btn));
  }));

  document.getElementById('favBtn').addEventListener('click', async (e) => {
    const { favorite } = await (await fetch(`/api/movies/${m.id}/favorite`, { method: 'POST' })).json();
    e.target.textContent = favorite ? '★ Favorited' : '☆ Favorite';
  });
  document.getElementById('watchedBtn').addEventListener('click', async (e) => {
    const next = m.watched ? 0 : 1;
    await fetch(`/api/movies/${m.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watched: next }) });
    m.watched = next; e.target.textContent = next ? '✓ Watched' : 'Mark watched';
  });
  document.getElementById('subBtn').addEventListener('click', () => { if (current) openSubSearch('movie', current.id, player); });
}

// ---------- Show detail ----------
async function openShow(id, autoEpId, autoplay = true) {
  const show = await (await fetch('/api/shows/' + id)).json();
  const seasons = show.seasons || [];

  detailInner.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-hero" style="background-image:url('${show.backdrop || show.poster || ''}')">
        <video id="player" controls playsinline poster="${show.backdrop || ''}"></video>
      </div>
      <div class="detail-body">
        <h2>${escapeHtml(show.title)}</h2>
        <div class="detail-meta">
          ${show.year ? `<span class="chip">${show.year}</span>` : ''}
          ${show.rating ? `<span class="chip rating">★ ${show.rating.toFixed(1)}</span>` : ''}
          <span class="chip">${show.episodeCount} episode${show.episodeCount === 1 ? '' : 's'}</span>
        </div>
        <div class="detail-actions">
          <button class="btn btn-play" id="s-play">▶ Play</button>
          <button class="btn hidden" id="ep-sub-btn">🔍 Subtitles</button>
        </div>
        <div class="versions hidden" id="ep-versions"></div>
        <p class="detail-overview">${escapeHtml(show.overview || '')}</p>
        <div class="season-tabs" id="season-tabs"></div>
        <div class="episode-list" id="episode-list"></div>
      </div>
    </div>`;
  openDetailModal();

  const seasonTabs = document.getElementById('season-tabs');
  const epList = document.getElementById('episode-list');
  const epVersions = document.getElementById('ep-versions');
  const player = document.getElementById('player');
  const epSubBtn = document.getElementById('ep-sub-btn');
  const seasonLabel = (s) => (s === 0 ? 'Specials' : 'Season ' + s);

  const flat = [];
  seasons.forEach((s, si) => s.episodes.forEach((ep) => flat.push({ ep, si })));
  let currentEpFile = null;

  epSubBtn.addEventListener('click', () => { if (currentEpFile) openSubSearch('episode', currentEpFile.id, player); });
  document.getElementById('s-play').addEventListener('click', () => {
    const idx = flat.findIndex((f) => !f.ep.watched);
    playByFlatIndex(idx >= 0 ? idx : 0);
  });

  function playByFlatIndex(i) {
    if (i < 0 || i >= flat.length) return;
    const { ep, si } = flat[i];
    seasonTabs.querySelectorAll('.season-tab').forEach((b, bi) => b.classList.toggle('active', bi === si));
    renderSeason(seasons[si]);
    const ei = seasons[si].episodes.findIndex((e) => e.id === ep.id);
    playEpisode(ep, epList.children[ei], i);
  }

  function playEpisode(ep, row, flatIndex) {
    epList.querySelectorAll('.episode').forEach((r) => r.classList.remove('playing'));
    if (row) row.classList.add('playing');
    const files = ep.files || [];
    let current = files[0];
    if (!current) return;
    currentEpFile = current;
    epSubBtn.classList.remove('hidden');

    player.src = '/api/stream/episode/' + current.id;
    player.play();
    player.scrollIntoView({ behavior: 'smooth', block: 'start' });
    attachSubtitle(player, current.subtitle ? '/api/subtitle/episode/' + current.id : null);
    const resume = ep.resume_position && ep.resume_position > 5 ? ep.resume_position : 0;
    if (resume) player.addEventListener('loadedmetadata', () => { player.currentTime = resume; }, { once: true });

    if (files.length > 1) {
      epVersions.classList.remove('hidden');
      epVersions.innerHTML = '<span class="vlabel">Version</span>' +
        files.map((f, i) => `<button class="qbtn${i === 0 ? ' active' : ''}" data-fid="${f.id}">${escapeHtml(f.quality || 'V' + (i + 1))}</button>`).join('');
      epVersions.querySelectorAll('.qbtn').forEach((btn) => btn.addEventListener('click', () => {
        const f = files.find((x) => String(x.id) === btn.dataset.fid);
        if (!f || current.id === f.id) return;
        current = f; currentEpFile = f;
        const at = player.currentTime, was = !player.paused;
        player.src = '/api/stream/episode/' + f.id;
        player.addEventListener('loadedmetadata', () => { player.currentTime = at; if (was) player.play(); }, { once: true });
        attachSubtitle(player, f.subtitle ? '/api/subtitle/episode/' + f.id : null);
        epVersions.querySelectorAll('.qbtn').forEach((b) => b.classList.toggle('active', b === btn));
      }));
    } else { epVersions.classList.add('hidden'); epVersions.innerHTML = ''; }

    bindProgress(player, `/api/episodes/${ep.id}/progress`, () => {
      if (typeof flatIndex === 'number') playByFlatIndex(flatIndex + 1);
    });
  }

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
      row.addEventListener('click', () => playByFlatIndex(fi));
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
    const btn = document.createElement('button');
    btn.className = 'season-tab' + (i === 0 ? ' active' : '');
    btn.textContent = seasonLabel(s.season);
    btn.addEventListener('click', () => {
      seasonTabs.querySelectorAll('.season-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSeason(s);
    });
    seasonTabs.appendChild(btn);
  });
  if (seasons.length) renderSeason(seasons[0]);

  if (autoEpId) { const fi = flat.findIndex((f) => f.ep.id === autoEpId); if (fi >= 0) playByFlatIndex(fi); }
  else if (autoplay && flat.length) { const idx = flat.findIndex((f) => !f.ep.watched); playByFlatIndex(idx >= 0 ? idx : 0); }
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
  const mm = movies.filter((m) => m.title.toLowerCase().includes(q)).map((m) => buildMediaCard(m, 'movie'));
  const ss = shows.filter((s) => s.title.toLowerCase().includes(q)).map((s) => buildMediaCard(s, 'show'));
  drawRows([[`Results for “${search.value.trim()}”`, [...mm, ...ss]]]);
});

// ---------- Subtitle search ----------
const subsModal = document.getElementById('subs');
const subsList = document.getElementById('subs-list');
const subsStatus = document.getElementById('subs-status');
subsModal.addEventListener('click', (e) => { if (e.target === subsModal) subsModal.classList.add('hidden'); });

async function openSubSearch(kind, fileId, player) {
  subsModal.classList.remove('hidden');
  subsStatus.textContent = 'Searching OpenSubtitles…';
  subsList.innerHTML = '';
  let results;
  try {
    const r = await fetch(`/api/subtitles/search?kind=${kind}&fileId=${fileId}`);
    if (!r.ok) { subsStatus.textContent = (await r.json().catch(() => ({}))).error || 'Search failed.'; return; }
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
        subsStatus.textContent = 'Subtitle added — use the CC button in the player.';
        if (player) attachSubtitle(player, kind === 'episode' ? '/api/subtitle/episode/' + fileId : '/api/subtitle/' + fileId);
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

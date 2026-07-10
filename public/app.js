const grid = document.getElementById('grid');
const search = document.getElementById('search');
const detail = document.getElementById('detail');
const detailInner = document.getElementById('detail-inner');
const closeBtn = document.getElementById('close');
const rescanBtn = document.getElementById('rescan');
const showGrid = document.getElementById('show-grid');
const tabs = document.querySelectorAll('.tab');
const continueEl = document.getElementById('continue');
const continueRow = document.getElementById('continue-row');

let movies = [];
let shows = [];
let currentTab = 'movies';

async function load() {
  const res = await fetch('/api/movies');
  movies = await res.json();
  render(movies);
}

async function loadShows() {
  const res = await fetch('/api/shows');
  shows = await res.json();
  renderShows(shows);
}

function renderShows(list) {
  showGrid.innerHTML = '';
  if (!list.length) {
    showGrid.innerHTML = '<p style="color:#9aa0b4;padding:20px">No TV shows yet — open ⚙ Folders and add a TV Shows folder.</p>';
    return;
  }
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="poster">
        ${s.poster ? `<img src="${s.poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(s.title)}</span>`}
        ${s.unwatched > 0 ? `<div class="badge">${s.unwatched} new</div>` : ''}
      </div>
      <div class="meta">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="y">${s.episodes} episode${s.episodes === 1 ? '' : 's'}</div>
      </div>`;
    card.addEventListener('click', () => openShow(s.id));
    showGrid.appendChild(card);
  }
}

function switchTab(tab) {
  currentTab = tab;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  grid.classList.toggle('hidden', tab !== 'movies');
  showGrid.classList.toggle('hidden', tab !== 'tv');
  search.value = '';
  search.placeholder = tab === 'tv' ? 'Search shows…' : 'Search movies…';
  if (tab === 'tv' && !shows.length) loadShows();
  else if (tab === 'tv') renderShows(shows);
  else render(movies);
}

tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function render(list) {
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<p style="color:#9aa0b4;padding:20px">No movies yet — open ⚙ Folders and add your movies drive.</p>';
    return;
  }
  for (const m of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const pct = m.duration && m.resume_position
      ? Math.min(100, (m.resume_position / m.duration) * 100)
      : 0;
    card.innerHTML = `
      <div class="poster">
        ${m.poster
          ? `<img src="${m.poster}" alt="" loading="lazy">`
          : `<span class="ph">${escapeHtml(m.title)}</span>`}
        ${m.versions > 1 ? `<div class="badge">${escapeHtml(versionBadge(m))}</div>` : ''}
        ${pct > 1 ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="meta">
        <div class="t">${escapeHtml(m.title)}</div>
        <div class="y">${m.year ?? ''}</div>
      </div>`;
    card.addEventListener('click', () => openDetail(m.id));
    grid.appendChild(card);
  }
}

async function openDetail(id) {
  const res = await fetch('/api/movies/' + id);
  const m = await res.json();
  const files = m.files || [];
  const resume = m.resume_position && m.resume_position > 5 ? m.resume_position : 0;
  let current = files[0]; // highest quality first (server-sorted)

  const versionRow = files.length > 1
    ? `<div class="row versions">
         <span class="vlabel">Version</span>
         ${files.map((f, i) =>
           `<button class="qbtn${i === 0 ? ' active' : ''}" data-fid="${f.id}">${escapeHtml(qualityLabel(f, i))}</button>`
         ).join('')}
       </div>`
    : '';

  detailInner.innerHTML = `
    <video id="player" controls autoplay playsinline
      src="${current ? '/api/stream/' + current.id : ''}"></video>
    <h2>${escapeHtml(m.title)}</h2>
    <div class="sub">${m.year ?? ''}${m.rating ? ' · ★ ' + m.rating.toFixed(1) : ''}${files.length > 1 ? ' · ' + files.length + ' versions' : ''}</div>
    ${versionRow}
    <div class="row">
      <button class="btn" id="favBtn">${m.favorite ? '★ Favorited' : '☆ Favorite'}</button>
      ${current ? `<span class="pill" id="fileName">${escapeHtml(current.filename)}</span>` : ''}
    </div>
    <p class="overview">${escapeHtml(m.overview || 'No description yet.')}</p>
  `;
  detail.classList.remove('hidden');

  const player = document.getElementById('player');
  if (resume) player.currentTime = resume;
  attachSubtitle(player, current && current.subtitle ? '/api/subtitle/' + current.id : null);

  // Switch quality/version without losing your place.
  detailInner.querySelectorAll('.qbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = files.find((x) => String(x.id) === btn.dataset.fid);
      if (!f || (current && current.id === f.id)) return;
      current = f;
      const at = player.currentTime;
      const wasPlaying = !player.paused;
      player.src = '/api/stream/' + f.id;
      player.addEventListener('loadedmetadata', () => {
        player.currentTime = at;
        if (wasPlaying) player.play();
      }, { once: true });
      attachSubtitle(player, f.subtitle ? '/api/subtitle/' + f.id : null);
      detailInner.querySelectorAll('.qbtn').forEach((b) => b.classList.toggle('active', b === btn));
      const fn = document.getElementById('fileName');
      if (fn) fn.textContent = f.filename;
    });
  });

  // Persist playback position periodically and on pause.
  let lastSave = 0;
  const save = () => {
    fetch(`/api/movies/${m.id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        position: player.currentTime,
        duration: player.duration || null,
        watched: player.duration && player.currentTime / player.duration > 0.92 ? 1 : null
      })
    });
  };
  player.addEventListener('timeupdate', () => {
    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); }
  });
  player.addEventListener('pause', save);

  document.getElementById('favBtn').addEventListener('click', async (e) => {
    const r = await fetch(`/api/movies/${m.id}/favorite`, { method: 'POST' });
    const { favorite } = await r.json();
    e.target.textContent = favorite ? '★ Favorited' : '☆ Favorite';
  });
}

async function openShow(id, autoEpId) {
  const show = await (await fetch('/api/shows/' + id)).json();
  const seasons = show.seasons || [];

  detailInner.innerHTML = `
    <video id="player" controls playsinline poster="${show.backdrop || ''}"></video>
    <div class="row versions hidden" id="ep-versions"></div>
    <h2>${escapeHtml(show.title)}</h2>
    <div class="sub">${show.year ?? ''}${show.rating ? ' · ★ ' + show.rating.toFixed(1) : ''} · ${show.episodeCount} episode${show.episodeCount === 1 ? '' : 's'}</div>
    <p class="overview">${escapeHtml(show.overview || '')}</p>
    <div class="season-tabs" id="season-tabs"></div>
    <div class="episode-list" id="episode-list"></div>
  `;
  detail.classList.remove('hidden');

  const seasonTabs = document.getElementById('season-tabs');
  const epList = document.getElementById('episode-list');
  const epVersions = document.getElementById('ep-versions');
  const player = document.getElementById('player');
  const seasonLabel = (s) => (s === 0 ? 'Specials' : 'Season ' + s);

  function playEpisode(ep, row) {
    epList.querySelectorAll('.episode').forEach((r) => r.classList.remove('playing'));
    if (row) row.classList.add('playing');
    const files = ep.files || [];
    let current = files[0];
    if (!current) return;

    player.src = '/api/stream/episode/' + current.id;
    player.play();
    player.scrollIntoView({ behavior: 'smooth', block: 'start' });
    attachSubtitle(player, current.subtitle ? '/api/subtitle/episode/' + current.id : null);

    const resume = ep.resume_position && ep.resume_position > 5 ? ep.resume_position : 0;
    if (resume) player.addEventListener('loadedmetadata', () => { player.currentTime = resume; }, { once: true });

    // Quality picker when the episode has multiple versions.
    if (files.length > 1) {
      epVersions.classList.remove('hidden');
      epVersions.innerHTML = '<span class="vlabel">Version</span>' +
        files.map((f, i) => `<button class="qbtn${i === 0 ? ' active' : ''}" data-fid="${f.id}">${escapeHtml(f.quality || 'V' + (i + 1))}</button>`).join('');
      epVersions.querySelectorAll('.qbtn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = files.find((x) => String(x.id) === btn.dataset.fid);
          if (!f || current.id === f.id) return;
          current = f;
          const at = player.currentTime;
          const wasPlaying = !player.paused;
          player.src = '/api/stream/episode/' + f.id;
          player.addEventListener('loadedmetadata', () => { player.currentTime = at; if (wasPlaying) player.play(); }, { once: true });
          attachSubtitle(player, f.subtitle ? '/api/subtitle/episode/' + f.id : null);
          epVersions.querySelectorAll('.qbtn').forEach((b) => b.classList.toggle('active', b === btn));
        });
      });
    } else {
      epVersions.classList.add('hidden');
      epVersions.innerHTML = '';
    }

    let lastSave = 0;
    const save = () => {
      fetch(`/api/episodes/${ep.id}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position: player.currentTime,
          duration: player.duration || null,
          watched: player.duration && player.currentTime / player.duration > 0.92 ? 1 : null
        })
      });
    };
    player.ontimeupdate = () => { if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); } };
    player.onpause = save;
  }

  function renderSeason(seasonObj) {
    epList.innerHTML = '';
    for (const ep of seasonObj.episodes) {
      const row = document.createElement('div');
      row.className = 'episode';
      const pct = ep.duration && ep.resume_position ? Math.min(100, (ep.resume_position / ep.duration) * 100) : 0;
      const quals = [...new Set((ep.files || []).map((f) => f.quality).filter(Boolean))];
      const qtext = quals.length ? ' · ' + quals.join('/') : '';
      row.innerHTML = `
        ${ep.still ? `<img class="ethumb" src="${ep.still}" alt="" loading="lazy">` : ''}
        <span class="num">${ep.season}·${String(ep.episode).padStart(2, '0')}</span>
        <span class="etitle">${escapeHtml(ep.title || 'Episode ' + ep.episode)}${qtext}</span>
        <span class="badges">${ep.watched ? '<span class="watched">✓ Watched</span>' : (pct > 1 ? '<span class="dot"></span>' : '')}</span>
        ${pct > 1 ? `<div class="eprog" style="width:${pct}%"></div>` : ''}`;
      row.addEventListener('click', () => playEpisode(ep, row));
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

  // Continue Watching deep-link: jump to and play a specific episode.
  if (autoEpId) {
    for (let i = 0; i < seasons.length; i++) {
      const idx = seasons[i].episodes.findIndex((e) => e.id === autoEpId);
      if (idx < 0) continue;
      seasonTabs.querySelectorAll('.season-tab').forEach((b, bi) => b.classList.toggle('active', bi === i));
      renderSeason(seasons[i]);
      playEpisode(seasons[i].episodes[idx], epList.children[idx]);
      break;
    }
  }
}

function closeDetail() {
  const player = document.getElementById('player');
  if (player) player.pause();
  detail.classList.add('hidden');
  detailInner.innerHTML = '';
  if (currentTab === 'movies') load(); else loadShows();
  loadContinue();
}

closeBtn.addEventListener('click', closeDetail);
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (currentTab === 'movies') {
    render(q ? movies.filter((m) => m.title.toLowerCase().includes(q)) : movies);
  } else {
    renderShows(q ? shows.filter((s) => s.title.toLowerCase().includes(q)) : shows);
  }
});

rescanBtn.addEventListener('click', async () => {
  rescanBtn.textContent = 'Scanning…';
  await fetch('/api/scan', { method: 'POST' });
  await fetch('/api/enrich', { method: 'POST' });
  rescanBtn.textContent = 'Rescan';
  load();
  loadShows();
});

// ---- Settings: manage Movies / TV Shows folders ----
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

const pickerState = { path: null, parent: null, type: 'movie' };

settingsBtn.addEventListener('click', openSettings);

let currentVersion = null;

async function loadVersion() {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (!r.ok) throw new Error('no version endpoint');
    const v = await r.json();
    currentVersion = v.sha && v.sha !== 'unknown' ? v.sha : null;
    versionEl.textContent = currentVersion
      ? `version ${v.sha}${v.date ? ' · ' + v.date : ''}`
      : 'updates not enabled yet';
  } catch {
    versionEl.textContent = 'version unavailable';
  }
}

// Ask the server if a newer version exists on GitHub; surface it if so.
async function checkForUpdate() {
  try {
    const r = await (await fetch('/api/check-update', { cache: 'no-store' })).json();
    if (r.updateAvailable) {
      updatePill.classList.remove('hidden');
      updateBtn.textContent = '⟳ Update available';
    } else {
      updatePill.classList.add('hidden');
      updateBtn.textContent = '⟳ Up to date';
    }
  } catch {
    // offline or updates not enabled — leave the UI quiet
  }
}

const updateOverlay = document.getElementById('update-overlay');
const updateStage = document.getElementById('update-stage');
const updateDetail = document.getElementById('update-detail');
const uSteps = {
  fetch: document.getElementById('ustep-fetch'),
  restart: document.getElementById('ustep-restart'),
  reload: document.getElementById('ustep-reload')
};

function setStage(title, detail) {
  updateStage.textContent = title;
  updateDetail.textContent = detail || '';
}

function markStep(activeKey, doneKeys) {
  Object.values(uSteps).forEach((el) => el.classList.remove('active'));
  doneKeys.forEach((k) => uSteps[k].classList.add('done'));
  if (activeKey) uSteps[activeKey].classList.add('active');
}

async function runUpdate() {
  if (!confirm('Update to the latest version?\n\nThe server will restart and this page will reload automatically.')) return;

  Object.values(uSteps).forEach((el) => el.classList.remove('active', 'done'));
  updateOverlay.classList.remove('hidden');
  setStage('Starting update…', 'Asking the server to fetch the latest code');
  markStep('fetch', []);

  try { await fetch('/api/update', { method: 'POST' }); } catch {}
  setStage('Applying update…', 'Pulling changes and restarting the server');
  markStep('restart', ['fetch']);

  const start = Date.now();
  const poll = async () => {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (r.ok) {
        const v = await r.json();
        markStep('reload', ['fetch', 'restart']);
        setStage('Updated! 🎉', `Now on version ${v.sha || ''} — reloading…`);
        setTimeout(() => location.reload(), 1400);
        return;
      }
    } catch {}
    if (Date.now() - start < 90000) {
      setStage('Restarting server…', 'Waiting for it to come back online');
      setTimeout(poll, 1500);
    } else {
      setStage('This is taking longer than expected', 'The server may need a manual restart on the Dell.');
    }
  };
  setTimeout(poll, 3000);
}

updateBtn.addEventListener('click', runUpdate);
updatePill.addEventListener('click', runUpdate);

// Check on load, then every 30 minutes.
checkForUpdate();
setInterval(checkForUpdate, 30 * 60 * 1000);

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.add('hidden'))
);
[settingsModal, picker].forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); })
);
document.querySelectorAll('[data-add]').forEach((b) =>
  b.addEventListener('click', () => openPicker(b.dataset.add))
);

async function openSettings() {
  settingsModal.classList.remove('hidden');
  loadVersion();
  checkForUpdate();
  await renderLibraries();
}

async function renderLibraries() {
  const libs = await (await fetch('/api/libraries')).json();
  if (!libs.length) {
    libList.innerHTML = '<div class="lib-empty">No folders yet — add one above.</div>';
    return;
  }
  libList.innerHTML = '';
  for (const lib of libs) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.innerHTML = `
      <span class="tag ${lib.type}">${lib.type === 'tv' ? 'TV' : 'Movies'}</span>
      <span class="path">${escapeHtml(lib.path)}</span>
      <button class="rm" title="Remove">✕</button>`;
    item.querySelector('.rm').addEventListener('click', async () => {
      if (!confirm(`Remove this ${lib.type === 'tv' ? 'TV Shows' : 'Movies'} folder?\n\n${lib.path}`)) return;
      await fetch('/api/libraries/' + lib.id, { method: 'DELETE' });
      await renderLibraries();
      load();
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
  const url = path ? '/api/fs?path=' + encodeURIComponent(path) : '/api/fs';
  const data = await (await fetch(url)).json();
  pickerState.path = data.path;
  pickerState.parent = data.parent;
  pickerPath.textContent = data.path || 'This PC — pick a drive';
  pickerChoose.disabled = !data.path;
  pickerChoose.style.opacity = data.path ? '1' : '0.45';

  const rows = data.drives && data.drives.length ? data.drives : data.dirs;
  pickerList.innerHTML = '';
  if (!rows || !rows.length) {
    pickerList.innerHTML = '<div class="frow"><span class="lib-empty">No sub-folders here — use this folder, or go up.</span></div>';
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'frow';
    row.innerHTML = `<span class="ico">📁</span><span>${escapeHtml(r.name)}</span>`;
    row.addEventListener('click', () => navigate(r.path));
    pickerList.appendChild(row);
  }
}

pickerUp.addEventListener('click', () => navigate(pickerState.parent));

pickerChoose.addEventListener('click', async () => {
  if (!pickerState.path) return;
  pickerChoose.textContent = 'Adding…';
  pickerChoose.disabled = true;
  await fetch('/api/libraries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: pickerState.path, type: pickerState.type })
  });
  pickerChoose.textContent = 'Use this folder';
  picker.classList.add('hidden');
  await renderLibraries();
  load();
});

// Small poster badge summarising the versions available.
function versionBadge(m) {
  if (m.qualities) return m.qualities.split(',').join(' · ');
  return m.versions + ' versions';
}

function qualityLabel(f, i) {
  return f.quality || 'Version ' + (i + 1);
}

// ---- Continue Watching ----
async function loadContinue() {
  let items = [];
  try { items = await (await fetch('/api/continue')).json(); } catch { return; }
  if (!items.length) { continueEl.classList.add('hidden'); return; }
  continueEl.classList.remove('hidden');
  continueRow.innerHTML = '';
  for (const it of items) {
    const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
    const sub = it.kind === 'episode' ? `S${it.season}·E${String(it.episode).padStart(2, '0')}` : 'Movie';
    const card = document.createElement('div');
    card.className = 'cw-card';
    card.innerHTML = `
      <div class="poster">
        ${it.poster ? `<img src="${it.poster}" alt="" loading="lazy">` : `<span class="ph">${escapeHtml(it.title)}</span>`}
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="meta"><div class="t">${escapeHtml(it.title)}</div><div class="y">${sub}</div></div>`;
    card.addEventListener('click', () => {
      if (it.kind === 'movie') openDetail(it.id);
      else openShow(it.show_id, it.id);
    });
    continueRow.appendChild(card);
  }
}

// ---- Subtitles: attach/replace a captions track on a <video> ----
function attachSubtitle(player, url) {
  player.querySelectorAll('track').forEach((t) => t.remove());
  if (!url) return;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'Subtitles';
  track.srclang = 'en';
  track.src = url;
  player.appendChild(track);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();
loadContinue();

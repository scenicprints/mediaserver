const grid = document.getElementById('grid');
const search = document.getElementById('search');
const detail = document.getElementById('detail');
const detailInner = document.getElementById('detail-inner');
const closeBtn = document.getElementById('close');
const rescanBtn = document.getElementById('rescan');

let movies = [];

async function load() {
  const res = await fetch('/api/movies');
  movies = await res.json();
  render(movies);
}

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

function closeDetail() {
  const player = document.getElementById('player');
  if (player) player.pause();
  detail.classList.add('hidden');
  detailInner.innerHTML = '';
  load(); // refresh progress bars
}

closeBtn.addEventListener('click', closeDetail);
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  render(q ? movies.filter((m) => m.title.toLowerCase().includes(q)) : movies);
});

rescanBtn.addEventListener('click', async () => {
  rescanBtn.textContent = 'Scanning…';
  await fetch('/api/scan', { method: 'POST' });
  await fetch('/api/enrich', { method: 'POST' });
  rescanBtn.textContent = 'Rescan';
  load();
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

const pickerState = { path: null, parent: null, type: 'movie' };

settingsBtn.addEventListener('click', openSettings);

async function loadVersion() {
  try {
    const v = await (await fetch('/api/version', { cache: 'no-store' })).json();
    versionEl.textContent = 'version ' + v.sha;
  } catch {
    versionEl.textContent = '';
  }
}

updateBtn.addEventListener('click', async () => {
  if (!confirm('Update to the latest version?\n\nThe server will restart and this page will reload automatically.')) return;
  updateBtn.textContent = 'Updating…';
  updateBtn.disabled = true;
  try { await fetch('/api/update', { method: 'POST' }); } catch {}
  // Wait for the server to come back after its restart, then reload.
  const start = Date.now();
  const poll = async () => {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch {}
    if (Date.now() - start < 90000) setTimeout(poll, 2000);
    else { updateBtn.textContent = 'Restart manually'; updateBtn.disabled = false; }
  };
  setTimeout(poll, 3500);
});

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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();

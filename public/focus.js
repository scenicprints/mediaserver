// ============================================================
//  Spatial focus engine — makes MARQUEE feel like a 10-ft
//  Apple-TV interface. Arrow keys / a TV remote move a single
//  glowing, scaled "focused" item; the rest of the field dims.
//  Enter activates it (a real click); Backspace is the Menu/Back
//  button. Purely DOM-driven and decoupled from app.js: it works
//  on whatever is on screen and activates by dispatching clicks,
//  so every existing card/button keeps its behavior.
// ============================================================
(function () {
  // The things a remote can land on. Curated so we never focus a
  // control nested inside a bigger one (e.g. the ▶ inside a card) —
  // the ancestor rule below keeps only the outermost target.
  const SELECTOR = [
    '.card', '.coll-card', '.req-card', '.nav-link', '.hero-dot', '.see-all', '.season-card',
    '.episode', '.rec', '.trailer-card', '.tab', '.az', '.frow',
    '.btn', '.close', '.detail-close', '.icon-btn', '.rm', '#update-pill',
    '.nav-search', '.req-input', '.dp-select', '.req-qsel select',
    '.auth-input', '.auth-toggle'
  ].join(',');

  let current = null;   // the focused element
  let navMode = false;  // true once the remote/arrows are in use

  const rectOf = (el) => el.getBoundingClientRect();
  const isVisible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const r = rectOf(el);
    return r.width > 1 && r.height > 1;
  };

  // Which layer owns focus right now: an open modal traps focus inside
  // itself, then the full-page detail view, otherwise the main browse.
  // Returns null when focus should be suspended entirely (video player /
  // update overlay have their own keyboard handling).
  function scope() {
    if (document.querySelector('.vp')) return null;
    if (!document.getElementById('update-overlay').classList.contains('hidden')) return null;
    // The login overlay traps focus inside itself (its fields, not the nav behind it).
    const auth = document.getElementById('auth');
    if (auth && !auth.classList.contains('hidden')) return auth;
    const modal = [...document.querySelectorAll('.modal')].find((m) => !m.classList.contains('hidden'));
    if (modal) return modal;
    const detail = document.getElementById('detail');
    if (!detail.classList.contains('hidden')) return detail;
    return document.body;
  }

  function candidates(root) {
    const all = [...root.querySelectorAll(SELECTOR)];
    return all.filter((el) => {
      if (!isVisible(el)) return false;
      // Drop anything that lives inside another candidate (outermost wins).
      const ancestor = el.parentElement && el.parentElement.closest(SELECTOR);
      return !(ancestor && root.contains(ancestor));
    });
  }

  // Horizontal traversal stays inside the current row/track/grid so a remote
  // moves card-to-card predictably (and wraps at the ends). Vertical traversal
  // is free to cross between these groups.
  const HGROUP = '.row-track, .lib-grid, .dp-hscroll, .season-cards, .nav-links, .hero-actions, .hero-dots, .dp-actions, .tabs';

  // Best candidate in a direction: nearest along the travel axis, strongly
  // preferring items aligned on the cross axis so columns/rows stay put.
  function pick(dir, root) {
    const cur = rectOf(current);
    const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
    const horizontal = dir === 'left' || dir === 'right';
    const inNav = !!current.closest('.nav');
    const grp = horizontal ? current.closest(HGROUP) : null;
    let best = null, bestScore = Infinity;
    for (const el of candidates(root)) {
      if (el === current) continue;
      // The top ribbon is its own zone: arrows never cross into it from the
      // content, and only Down leaves it (Back is the way up). See back().
      const elNav = !!el.closest('.nav');
      if (inNav) { if (dir === 'down' ? elNav : !elNav) continue; }
      else if (elNav) continue;
      if (grp && !inNav && el.closest(HGROUP) !== grp) continue;   // keep horizontal in-row
      const r = rectOf(el);
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      let along, cross;
      if (dir === 'right') { if (dx <= 1) continue; along = dx; cross = Math.abs(dy); }
      else if (dir === 'left') { if (dx >= -1) continue; along = -dx; cross = Math.abs(dy); }
      else if (dir === 'down') { if (dy <= 1) continue; along = dy; cross = Math.abs(dx); }
      else { if (dy >= -1) continue; along = -dy; cross = Math.abs(dx); }
      const score = along + cross * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Wrap horizontally at a row's edge: Right past the last card drops to the
  // first item of the next row down; Left before the first rises to the last
  // item of the row above. Keeps a remote from getting stuck at row ends.
  function wrap(dir, root) {
    const cur = rectOf(current);
    const cy = cur.top + cur.height / 2;
    let best = null, key = Infinity;
    for (const el of candidates(root)) {
      if (el === current) continue;
      const r = rectOf(el);
      const ecy = r.top + r.height / 2;
      if (dir === 'right') {
        if (ecy <= cy + 4) continue;                 // must be a lower row
        const k = ecy * 10000 + r.left;              // topmost, then leftmost
        if (k < key) { key = k; best = el; }
      } else {
        if (ecy >= cy - 4) continue;                 // must be a higher row
        const k = -ecy * 10000 - r.left;             // bottommost, then rightmost
        if (k < key) { key = k; best = el; }
      }
    }
    return best;
  }

  const noScroll = (el) => el.closest('.nav') || el.closest('.az-rail');

  function setCurrent(el) {
    if (!el) return;
    if (current) current.classList.remove('tv-focus');
    current = el;
    current.classList.add('tv-focus');
    if (!noScroll(el)) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  // Pick a sensible landing spot when focus is (re)initialized on a screen:
  // the primary Play button if there is one, else the first card, else the
  // first candidate at all.
  function firstTarget(root) {
    const play = [...root.querySelectorAll('.btn-play')].find(isVisible);
    if (play) return play;
    const card = [...root.querySelectorAll('.card')].find(isVisible);
    if (card) return card;
    return candidates(root)[0] || null;
  }

  function enterNav() {
    if (!navMode) { navMode = true; document.body.classList.add('tv-nav'); }
  }

  function move(dir) {
    const root = scope();
    if (!root) return;
    enterNav();
    // (Re)seat focus if it vanished (view re-rendered, modal closed, …).
    if (!current || !document.contains(current) || !isVisible(current) || !root.contains(current)) {
      setCurrent(firstTarget(root));
      return; // first press only reveals the focus, like tvOS.
    }
    const inNav = !!current.closest('.nav');
    const next = pick(dir, root) || ((!inNav && (dir === 'right' || dir === 'left')) ? wrap(dir, root) : null);
    if (next) setCurrent(next);
  }

  function activate() {
    if (!current || !document.contains(current)) return;
    // Enter on a text field / dropdown starts editing (brings up the TV's
    // on-screen keyboard); everything else is a click.
    const t = current.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') { current.focus(); return; }
    const wasTab = current.classList.contains('nav-link');
    current.click();
    if (wasTab) {
      // Opening a tab drops focus into the content below. Live TV owns its own
      // arrows, so there we just release the ribbon and let it take over.
      if (document.body.classList.contains('lt-active')) { if (current) current.classList.remove('tv-focus'); current = null; return; }
      const el = firstTarget(scope());
      if (el && !el.closest('.nav')) setCurrent(el);
    }
  }

  // Backspace = the remote's Menu/Back button. Layers close top-down; in the
  // main browse it lifts focus up to the ribbon (the TV way back to the menu).
  function back() {
    // On the login screen there's nowhere to go back to — don't leak to the nav.
    const auth = document.getElementById('auth');
    if (auth && !auth.classList.contains('hidden')) return;
    const modal = [...document.querySelectorAll('.modal')].find((m) => !m.classList.contains('hidden'));
    if (modal) { modal.classList.add('hidden'); return; }
    const detail = document.getElementById('detail');
    if (!detail.classList.contains('hidden')) { document.getElementById('detail-close').click(); return; }
    if (current && current.closest('.nav')) return; // already on the ribbon → nothing (leave-app on tvOS)
    const nav = document.querySelector('.nav-link.active') || document.querySelector('.nav-link');
    if (nav) { enterNav(); setCurrent(nav); }
  }

  const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  document.addEventListener('keydown', (e) => {
    // Let the video player own the keyboard.
    if (document.querySelector('.vp')) return;
    // Live TV surfs with its own arrows — but Back still lifts to the ribbon,
    // and once the ribbon has focus, its arrows are ours (not the guide's).
    if (document.body.classList.contains('lt-active') && document.getElementById('detail').classList.contains('hidden')) {
      const onRibbon = current && current.closest('.nav');
      if (!onRibbon && e.key !== 'Backspace') return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // While typing in a field, Up/Down (and Escape) exit it back to spatial nav
    // — remotes have no Tab. Left/Right and characters stay in the field.
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    if (typing) {
      if (e.key === 'Escape') { e.preventDefault(); a.blur(); return; }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; // let typing/cursor work
      a.blur(); // fall through to move()
    }

    if (DIRS[e.key]) { e.preventDefault(); move(DIRS[e.key]); }
    else if (e.key === 'Enter') { if (current) { e.preventDefault(); activate(); } }
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
  }, true);

  // Mouse and remote coexist: any mouse movement drops out of TV-nav mode so
  // the normal hover styling returns; the next arrow press re-lights focus.
  document.addEventListener('mousemove', () => {
    if (!navMode) return;
    navMode = false;
    document.body.classList.remove('tv-nav');
    if (current) current.classList.remove('tv-focus');
  }, { passive: true });

  // When a new screen appears (detail view, a modal), pre-seat focus on its
  // primary action so a remote can act immediately. Only shows the glow if the
  // user is already navigating by remote.
  function reseat(root) {
    const el = firstTarget(root);
    if (!el) return;
    if (current) current.classList.remove('tv-focus');
    current = el;
    if (navMode) setCurrent(el);
  }

  const watch = (el) => {
    if (!el) return;
    new MutationObserver(() => {
      if (!el.classList.contains('hidden')) setTimeout(() => reseat(el), 60);
      else if (current && el.contains(current)) current = null;
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  };
  watch(document.getElementById('detail'));
  document.querySelectorAll('.modal').forEach(watch);

  // A closing video player or a re-rendered main view should re-seat focus.
  new MutationObserver((muts) => {
    for (const m of muts) {
      if ([...m.removedNodes].some((n) => n.classList && n.classList.contains('vp'))) { current = null; break; }
    }
  }).observe(document.body, { childList: true });

  // Let a view place the remote focus on a specific element (e.g. Requests puts
  // it on the search box). Only lights up if the user is driving by remote.
  window.tvSeat = (el) => { if (el && navMode) setCurrent(el); else if (el) current = el; };
  window.tvNavActive = () => navMode;
})();

// The optimizer's own window.
//
// Everything this program does was reachable only by typing node commands at
// it, which is not a program so much as a set of instructions for operating
// one. This is the interface: what it is doing, what it has done, what it has
// given up on, and the one manual control — find duplicates, and delete the
// copies you choose.
//
// It is served BY the watch process rather than being a second program. One
// process means one database handle and no chance of the window and the worker
// disagreeing about what is happening, or of a "drop" landing mid-encode from a
// different connection.
//
// Deliberately not part of Marquee: separate program, separate port, separate
// process. A crash here cannot take down playback, and the media server has no
// idea this exists.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as engine from './engine.mjs';
import { findDuplicates, confirmDropSafe } from './duplicates.mjs';
import { badFiles } from './badfiles.mjs';
import { planMigration, writePlan, journalPlan, preflight, runMigration, migrationStatus } from './migrate.mjs';

// Duplicate scanning reads real bytes across the library and takes minutes, so
// it runs in the background and the page polls it. One at a time.
const dupes = { running: false, done: 0, total: 0, groups: [], error: null, ranAt: 0 };

// The pool migration, likewise: planning reads bytes and moving is hours. Both
// are background jobs the page watches rather than requests it waits on.
const migration = {
  planning: false, running: false, stop: false,
  done: 0, total: 0, error: null,
  report: null, summary: null, overwrites: null, collisions: [],
  stats: null
};

const GB = (b) => (Number(b) / 2 ** 30).toFixed(2) + ' GB';

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) d = d.slice(0, 1e6); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

export function startUI(db, {
  port = 8097,
  logFile = null,
  policy = {},
  log = () => {}
} = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(PAGE);
      }

      if (p === '/api/status') {
        const s = engine.status(db);
        const stk = engine.stuck(db);
        // The plan is a whole-library pass; only recompute when idle so the
        // page cannot slow down the actual work.
        let plan = null;
        if (!engine.worker.running && !engine.scan.running) {
          const a = engine.analyze(db, policy);
          const by = {};
          for (const it of a.items) {
            by[it.profile] = by[it.profile] || { files: 0, bytes: 0 };
            by[it.profile].files++; by[it.profile].bytes += it.saveBytes || 0;
          }
          plan = { by, totalBytes: a.items.reduce((n, i) => n + (i.saveBytes || 0), 0) };
        }
        return json(res, 200, {
          jobs: s.jobs, reclaimedBytes: s.reclaimedBytes, probed: s.probed, scannable: s.scannable,
          nvenc: s.nvenc, scan: s.scan,
          worker: { running: engine.worker.running, current: engine.worker.current },
          stuck: {
            retry: stk.jobs.filter((j) => j.state === 'retry').length,
            failed: stk.jobs.filter((j) => j.state === 'failed').length,
            unreadable: stk.probes.length,
            jobs: stk.jobs.slice(0, 40),
            probes: stk.probes.slice(0, 40)
          },
          plan,
          dupes: { running: dupes.running, done: dupes.done, total: dupes.total, error: dupes.error, ranAt: dupes.ranAt, count: dupes.groups.length }
        });
      }

      if (p === '/api/badfiles') {
        return json(res, 200, { items: badFiles(db) });
      }

      if (p === '/api/log') {
        let text = '';
        try {
          if (logFile && fs.existsSync(logFile)) {
            const buf = fs.readFileSync(logFile, 'utf8');
            text = buf.split(/\r?\n/).filter(Boolean).slice(-300).join('\n');
          }
        } catch { /* the log is a convenience, never a dependency */ }
        return json(res, 200, { text });
      }

      if (p === '/api/duplicates' && req.method === 'GET') {
        return json(res, 200, { ...dupes, groups: dupes.groups });
      }

      // ---- Pool migration ------------------------------------------------
      // Planning reads bytes across the library and moving is hours of work,
      // so both run in the background and the page polls. Neither is ever
      // started implicitly: this moves twenty thousand files and it happens
      // when someone presses the button, not when the program feels ready.
      if (p === '/api/migrate' && req.method === 'GET') {
        const st = migrationStatus(db);
        let ready = null;
        try { ready = preflight(db, { poolRoot: policy.poolRoot || 'P:\\' }); } catch (e) { ready = { ok: false, problems: [e.message] }; }
        return json(res, 200, { ...migration, status: st, preflight: ready, poolRoot: policy.poolRoot || 'P:\\' });
      }

      if (p === '/api/migrate/plan' && req.method === 'POST') {
        if (migration.planning || migration.running) return json(res, 409, { error: 'already busy' });
        migration.planning = true; migration.error = null; migration.done = 0; migration.total = 0;
        (async () => {
          try {
            const plan = await planMigration(db, {
              log: (m) => log('migrate: ' + m),
              onProgress: (d, n) => { migration.done = d; migration.total = n; }
            });
            migration.report = writePlan(plan, path.join(path.dirname(logFile || '.'), 'pool-migration-plan.txt'));
            migration.summary = plan.stats;
            migration.overwrites = plan.overwrites.length;
            migration.collisions = plan.collisions;
            journalPlan(db, plan, { replace: true });
            log(`migrate: planned ${plan.stats.moves} move(s), ${plan.overwrites.length} would overwrite`);
          } catch (e) { migration.error = e.message; log('migrate: planning failed — ' + e.message); }
          finally { migration.planning = false; }
        })();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/migrate/start' && req.method === 'POST') {
        if (migration.planning || migration.running) return json(res, 409, { error: 'already busy' });
        const ready = preflight(db, { poolRoot: policy.poolRoot || 'P:\\' });
        if (!ready.ok) return json(res, 409, { error: 'not ready', problems: ready.problems });
        migration.running = true; migration.stop = false; migration.error = null;
        (async () => {
          try {
            migration.stats = await runMigration(db, {
              log: (m) => log('migrate: ' + m),
              isWatching: policy.isWatching || (async () => true),
              shouldStop: () => migration.stop,
              onProgress: (s) => { migration.stats = s; }
            });
          } catch (e) { migration.error = e.message; log('migrate: run failed — ' + e.message); }
          finally { migration.running = false; }
        })();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/migrate/stop' && req.method === 'POST') {
        migration.stop = true;
        return json(res, 200, { ok: true, note: 'will stop after the file in flight finishes' });
      }

      if (p === '/api/duplicates/scan' && req.method === 'POST') {
        if (dupes.running) return json(res, 409, { error: 'already scanning' });
        const body = await readBody(req);
        dupes.running = true; dupes.error = null; dupes.done = 0; dupes.total = 0; dupes.groups = [];
        // Not awaited: this is minutes of reading and the page polls for it.
        (async () => {
          try {
            const r = await findDuplicates(db, {
              log,
              full: !!body.full,
              onProgress: (n, total) => { dupes.done = n; dupes.total = total; }
            });
            dupes.groups = r.confirmed.map((d) => ({
              title: d.title, size: d.size, reclaimable: d.reclaimable, is4k: d.is4k, note: d.note,
              keep: { path: d.keep.r.path, reasons: d.keep.reasons },
              drop: d.drop.map((x) => ({ id: `${x.r.file_kind}:${x.r.file_id}`, path: x.r.path }))
            }));
            dupes.ranAt = Date.now();
          } catch (e) { dupes.error = e.message; }
          finally { dupes.running = false; }
        })();
        return json(res, 202, { started: true });
      }

      if (p === '/api/drop' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        if (!/^(movie|episode):\d+$/.test(id)) return json(res, 400, { error: 'bad id' });
        const [kind, idStr] = id.split(':');
        const fileId = parseInt(idStr, 10);

        const row = db.prepare('SELECT path, size FROM media_info WHERE file_kind = ? AND file_id = ?').get(kind, fileId);
        // Re-proved here, not trusted from the list on screen — that list may
        // be minutes or days old and the library moves underneath it.
        const check = await confirmDropSafe(db, kind, fileId);
        if (!check.ok) return json(res, 409, { error: check.reason });

        try { fs.rmSync(row.path, { force: true }); }
        catch (e) { return json(res, 500, { error: 'could not delete: ' + e.message }); }

        const table = kind === 'episode' ? 'episode_files' : 'movie_files';
        try { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(fileId); } catch { /* library row may already be gone */ }
        try { db.prepare('DELETE FROM media_info WHERE file_kind = ? AND file_id = ?').run(kind, fileId); } catch {}

        log(`Deleted duplicate ${path.basename(row.path)} (${GB(row.size)}); kept ${check.keeper.path}`);
        // Take it off the list on screen as well.
        for (const g of dupes.groups) g.drop = g.drop.filter((x) => x.id !== id);
        return json(res, 200, { ok: true, freed: Number(row.size) || 0, keeper: check.keeper.path });
      }

      if (p === '/api/retry' && req.method === 'POST') {
        const body = await readBody(req);
        const r = engine.retryStuck(db, { id: Number(body.id) || 0, includeJudged: !!body.judged });
        return json(res, 200, r);
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  // Loopback only. This deletes files; it has no business being reachable from
  // the network, and unlike Marquee it has no accounts or login to protect it.
  server.listen(port, '127.0.0.1', () => log(`Optimizer window: http://localhost:${port}`));
  server.on('error', (e) => log(`Optimizer window could not start on ${port}: ${e.message}`));
  return server;
}

// ---------------------------------------------------------------------------
// The page. One file, no build step, no dependencies — the same Braun language
// as the rest: squared off, small caps, letterspaced, one signal colour used
// for state and never for decoration.
// ---------------------------------------------------------------------------
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Marquee Optimizer</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root {
    --paper:#141416; --panel:#1D1D20; --panel2:#232327; --sunk:#0E0E10;
    --ink:#EFEEE9; --ink2:#8C8C86; --ink3:#65655F; --rule:#33333A; --signal:#F26A16;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:26px 32px 18px; border-bottom:1px solid var(--rule); display:flex; align-items:baseline; gap:18px; }
  h1 { margin:0; font-size:17px; font-weight:600; letter-spacing:.28em; text-transform:uppercase; }
  .sub { color:var(--ink3); font-size:12px; letter-spacing:.12em; text-transform:uppercase; }
  main { padding:26px 32px 60px; max-width:1180px; }
  section { margin-bottom:34px; }
  h2 { font-size:12px; font-weight:600; letter-spacing:.24em; text-transform:uppercase;
    color:var(--ink3); margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); }
  .cell { background:var(--panel); padding:16px 18px; }
  .cell .k { color:var(--ink3); font-size:11px; letter-spacing:.16em; text-transform:uppercase; }
  .cell .v { font-size:26px; font-weight:600; margin-top:6px; font-variant-numeric:tabular-nums; }
  .cell .v.sig { color:var(--signal); }
  .now { border:1px solid var(--rule); background:var(--panel); padding:16px 18px; }
  .now .t { font-size:15px; font-weight:600; }
  .bar { height:6px; background:rgba(255,255,255,.14); margin-top:12px; }
  .bar i { display:block; height:100%; background:var(--signal); width:0; transition:width .4s; }
  button { font:inherit; font-size:12px; font-weight:600; letter-spacing:.18em; text-transform:uppercase;
    color:var(--ink); background:transparent; border:1px solid var(--rule); padding:11px 20px; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--signal); color:var(--signal); }
  button:disabled { color:var(--ink3); cursor:default; }
  button.sig { background:var(--signal); border-color:var(--signal); color:#141416; }
  button.sig:hover:not(:disabled) { background:#C85410; border-color:#C85410; color:#fff; }
  button.danger:hover:not(:disabled) { border-color:var(--signal); color:var(--signal); }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .dupe { border:1px solid var(--rule); background:var(--panel); padding:16px 18px; margin-bottom:1px; }
  .dupe .h { display:flex; justify-content:space-between; gap:16px; align-items:baseline; }
  .dupe .title { font-weight:600; font-size:15px; }
  .dupe .size { color:var(--ink3); font-variant-numeric:tabular-nums; font-size:12px; letter-spacing:.1em; }
  .keepline, .dropline { display:flex; gap:12px; align-items:center; margin-top:10px; font-size:12.5px; }
  .tag { font-size:10px; font-weight:700; letter-spacing:.16em; padding:3px 8px; border:1px solid var(--rule); white-space:nowrap; }
  .tag.keep { color:var(--ink2); }
  .tag.drop { color:var(--signal); border-color:var(--signal); }
  .tag.locked { color:var(--ink3); }
  .path { color:var(--ink2); word-break:break-all; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
  .why { color:var(--ink3); font-size:11.5px; }
  pre { background:var(--sunk); border:1px solid var(--rule); padding:14px 16px; margin:0;
    max-height:340px; overflow:auto; font-family:ui-monospace,Consolas,monospace; font-size:11.5px;
    color:var(--ink2); white-space:pre-wrap; word-break:break-word; }
  .empty { color:var(--ink3); padding:16px 18px; border:1px solid var(--rule); background:var(--panel); }
  .warn { color:var(--signal); }
</style></head>
<body>
<header>
  <h1>Marquee Optimizer</h1>
  <span class="sub" id="head">connecting</span>
</header>
<main>

<section>
  <h2>Now</h2>
  <div class="now" id="now"><div class="t">—</div></div>
</section>

<section>
  <h2>Library</h2>
  <div class="grid" id="stats"></div>
</section>

<section>
  <h2>Pool migration <span class="sub">— manual. Nothing moves until you say so.</span></h2>
  <div class="row" style="margin-bottom:14px">
    <button id="mplan">Plan the move</button>
    <button id="mgo" class="sig">Start moving</button>
    <button id="mstop">Stop</button>
    <span class="sub" id="mstate"></span>
  </div>
  <div id="migrate"></div>
</section>

<section>
  <h2>Duplicates <span class="sub">— manual. Nothing here is automatic.</span></h2>
  <div class="row" style="margin-bottom:14px">
    <button id="scan" class="sig">Find duplicates</button>
    <button id="scanfull">Find duplicates (full hash)</button>
    <span class="sub" id="dupstate"></span>
  </div>
  <div id="dupes"></div>
</section>

<section>
  <h2>Needs re-downloading <span class="sub">— files that cannot be read</span></h2>
  <div class="row" style="margin-bottom:14px">
    <button id="copybad">Copy list</button>
    <span class="sub" id="badstate"></span>
  </div>
  <div id="bad"></div>
</section>

<section>
  <h2>Stuck</h2>
  <div class="row" style="margin-bottom:14px">
    <button id="retry">Try these again</button>
    <span class="sub" id="stuckstate"></span>
  </div>
  <div id="stuck"></div>
</section>

<section>
  <h2>Log</h2>
  <pre id="log">…</pre>
</section>

</main>
<script>
const $ = (id) => document.getElementById(id);
const GB = (b) => (Number(b)/2**30).toFixed(2) + ' GB';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function get(u) { const r = await fetch(u); return r.json(); }
async function post(u, body) {
  const r = await fetch(u, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{}) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

function renderNow(s) {
  const w = s.worker;
  if (s.scan && s.scan.running) {
    const pct = s.scan.total ? Math.round(s.scan.done / s.scan.total * 100) : 0;
    $('now').innerHTML = '<div class="t">Reading the library</div>' +
      '<div class="why">' + s.scan.done + ' of ' + s.scan.total + ' files</div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>';
    return;
  }
  if (w && w.current) {
    const c = w.current;
    const name = String(c.path||'').split(/[\\\\/]/).pop();
    $('now').innerHTML = '<div class="t">' + esc(name) + '</div>' +
      '<div class="why">' + esc(c.profile || '') + '</div>' +
      '<div class="bar"><i style="width:' + (c.pct||0) + '%"></i></div>';
    return;
  }
  $('now').innerHTML = '<div class="t">Idle</div><div class="why">Waiting for new content. It stands down while anyone is watching.</div>';
}

function renderStats(s) {
  const q = s.jobs || {};
  const cells = [
    ['Reclaimed', GB(s.reclaimedBytes), true],
    ['Queued', (q.queued||0) + (q.retry||0), false],
    ['Done', q.done||0, false],
    ['Files', s.scannable.toLocaleString(), false],
    ['Unreadable', s.stuck.unreadable, false]
  ];
  if (s.plan) cells.push(['Still to reclaim', GB(s.plan.totalBytes), false]);
  cells.push(['Hardware encode', s.nvenc ? 'Yes' : 'CPU only', false]);
  $('stats').innerHTML = cells.map(([k,v,sig]) =>
    '<div class="cell"><div class="k">' + k + '</div><div class="v' + (sig?' sig':'') + '">' + esc(v) + '</div></div>').join('');
}

function renderDupes(d) {
  if (d.running) {
    $('dupstate').textContent = 'reading bytes — ' + d.done + ' of ' + d.total + ' candidate groups';
    $('scan').disabled = true; $('scanfull').disabled = true;
    return;
  }
  $('scan').disabled = false; $('scanfull').disabled = false;
  if (d.error) { $('dupstate').innerHTML = '<span class="warn">' + esc(d.error) + '</span>'; return; }
  if (!d.ranAt) { $('dupstate').textContent = 'not looked yet'; return; }

  const groups = d.groups || [];
  const total = groups.reduce((n,g) => n + (g.drop.length ? g.reclaimable : 0), 0);
  $('dupstate').textContent = groups.length + ' genuine duplicate group(s)' + (total ? ' — ' + GB(total) + ' reclaimable' : '');
  if (!groups.length) { $('dupes').innerHTML = '<div class="empty">Nothing is duplicated. Metadata matches were checked byte for byte and were different files.</div>'; return; }

  $('dupes').innerHTML = groups.map((g) =>
    '<div class="dupe"><div class="h"><span class="title">' + esc(g.title) + '</span>' +
      '<span class="size">' + GB(g.size) + (g.is4k ? ' · 4K' : '') + '</span></div>' +
      '<div class="keepline"><span class="tag keep">Keep</span><span class="path">' + esc(g.keep.path) + '</span></div>' +
      (g.keep.reasons && g.keep.reasons.length ? '<div class="why">' + esc(g.keep.reasons.join(', ')) + '</div>' : '') +
      g.drop.map((x) =>
        '<div class="dropline">' +
          (g.is4k
            ? '<span class="tag locked">4K — kept</span>'
            : '<button class="danger" data-drop="' + esc(x.id) + '">Delete</button>') +
          '<span class="path">' + esc(x.path) + '</span></div>').join('') +
      (g.note ? '<div class="why">' + esc(g.note) + '</div>' : '') +
    '</div>').join('');
}

function renderStuck(s) {
  const k = s.stuck;
  $('stuckstate').textContent = k.retry + ' waiting to retry · ' + k.failed + ' given up on · ' + k.unreadable + ' unreadable';
  const rows = [];
  for (const j of k.jobs) rows.push([j.state === 'retry' ? 'Retry' : 'Gave up', String(j.path||'').split(/[\\\\/]/).pop(), j.error]);
  for (const p of k.probes) rows.push(['Unreadable', String(p.path||'').split(/[\\\\/]/).pop(), p.probe_error]);
  $('stuck').innerHTML = rows.length
    ? rows.map(([tag,name,err]) =>
        '<div class="dupe"><div class="keepline"><span class="tag ' + (tag==='Retry'?'keep':'drop') + '">' + tag + '</span>' +
        '<span class="title" style="font-size:13px">' + esc(name) + '</span></div>' +
        '<div class="why">' + esc(String(err||'').split('\\n')[0].slice(0,220)) + '</div></div>').join('')
    : '<div class="empty">Nothing stuck.</div>';
}

let badCache = [];
async function renderBad() {
  const r = await get('/api/badfiles');
  badCache = r.items || [];
  const empties = badCache.filter((i) => i.sizeMB === 0).length;
  $('badstate').textContent = badCache.length
    ? badCache.length + ' file(s)' + (empties ? ' · ' + empties + ' are 0 bytes' : '')
    : 'nothing broken';
  if (!badCache.length) { $('bad').innerHTML = '<div class="empty">Every file in the library reads.</div>'; return; }

  // Grouped by show, because a broken season is one job rather than twelve.
  const groups = {};
  for (const i of badCache) {
    const g = i.what.includes(' - S') ? i.what.slice(0, i.what.indexOf(' - S')) : 'Films';
    (groups[g] = groups[g] || []).push(i);
  }
  $('bad').innerHTML = Object.entries(groups).map(([g, items]) =>
    '<div class="dupe"><div class="h"><span class="title">' + esc(g) + '</span>' +
    '<span class="size">' + items.length + ' file(s)</span></div>' +
    items.map((i) =>
      '<div class="dropline"><span class="tag ' + (i.sizeMB === 0 ? 'drop' : 'keep') + '">' +
      (i.sizeMB === 0 ? 'Empty' : 'Damaged') + '</span>' +
      '<span class="path">' + esc(i.what) + '</span></div>' +
      '<div class="why">' + esc(i.why) + '</div>').join('') +
    '</div>').join('');
}

async function tick() {
  try {
    const s = await get('/api/status');
    $('head').textContent = s.worker.running ? 'working' : 'idle';
    renderNow(s); renderStats(s); renderStuck(s);
    if (s.dupes.running) renderDupes(s.dupes);
    else if (s.dupes.ranAt && s.dupes.ranAt !== window.__dupAt) {
      window.__dupAt = s.dupes.ranAt;
      renderDupes(await get('/api/duplicates'));
    } else if (!s.dupes.ranAt) renderDupes(s.dupes);
    await renderBad();
    renderMigrate(await get('/api/migrate'));
    const l = await get('/api/log');
    $('log').textContent = l.text || 'nothing logged yet';
    $('log').scrollTop = $('log').scrollHeight;
  } catch (e) { $('head').textContent = 'not running'; }
}

function renderMigrate(m) {
  const st = m.status || {};
  const pf = m.preflight || {};
  $('mplan').disabled = !!(m.planning || m.running);
  $('mgo').disabled = !!(m.planning || m.running) || !pf.ok;
  $('mstop').disabled = !m.running;

  if (m.planning) {
    $('mstate').textContent = 'reading bytes — ' + m.done + ' of ' + m.total + ' contested name(s)';
  } else if (m.running) {
    const s = m.stats || {};
    $('mstate').textContent = (s.done||0) + ' moved, ' + (s.failed||0) + ' failed — ' + GB(s.bytes||0);
  } else if (m.error) {
    $('mstate').textContent = m.error;
  } else {
    $('mstate').textContent = st.total ? st.done + ' of ' + st.total + ' moved' : 'nothing planned yet';
  }

  const out = [];
  if (st.total) {
    out.push('<div class="bar"><i style="width:' + (st.percent||0) + '%"></i></div>');
    out.push('<div class="grid">' + [
      ['Planned', st.total.toLocaleString()],
      ['Moved', st.done.toLocaleString()],
      ['Left', st.remaining.toLocaleString()],
      ['Failed', st.failed]
    ].map(([k,v]) => '<div class="cell"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>').join('') + '</div>');
  }

  // The plan's own verdict on the contested names, which is the part worth
  // reading before pressing anything.
  if (m.summary) {
    out.push('<p class="sub">' + m.summary.versions + ' kept as separate versions · ' +
      m.summary.duplicates + ' identical copies left in place · ' +
      m.summary.unknown + ' unreadable · ' +
      (m.overwrites ? '<b style="color:var(--signal)">' + m.overwrites + ' WOULD OVERWRITE</b>' : 'nothing would be overwritten') +
      (m.report ? ' · <span class="path">' + esc(m.report) + '</span>' : '') + '</p>');
  }

  // Why the button is off. A disabled control with no reason is a bug report
  // waiting to happen.
  if (!pf.ok && (pf.problems||[]).length) {
    out.push('<p class="sub">Not ready:</p><ul class="sub">' +
      pf.problems.slice(0, 8).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>');
  }
  if ((st.failures||[]).length) {
    out.push('<p class="sub">Failed:</p>' + st.failures.slice(0, 10).map((f) =>
      '<div class="row"><span class="path">' + esc(f.src) + '</span><span class="sub">' + esc(f.error) + '</span></div>').join(''));
  }
  $('migrate').innerHTML = out.join('');
}

$('mplan').onclick = async () => { await post('/api/migrate/plan', {}); tick(); };
$('mstop').onclick = async () => { await post('/api/migrate/stop', {}); tick(); };
$('mgo').onclick = async () => {
  if (!confirm('Move the library into the pool?\\n\\nFiles are copied and verified before the original is deleted, and it stops whenever anyone starts watching. You can stop it at any time and it picks up where it left off.')) return;
  const r = await post('/api/migrate/start', {});
  if (!r.ok) alert('Not ready:\\n\\n' + ((r.data.problems||[r.data.error]).join('\\n')));
  tick();
};

$('scan').onclick = async () => { await post('/api/duplicates/scan', {}); tick(); };
$('scanfull').onclick = async () => { await post('/api/duplicates/scan', { full:true }); tick(); };
$('copybad').onclick = async () => {
  const text = badCache.map((i) => i.what).join('\\n');
  try { await navigator.clipboard.writeText(text); $('copybad').textContent = 'Copied'; }
  catch { $('copybad').textContent = 'Could not copy'; }
  setTimeout(() => { $('copybad').textContent = 'Copy list'; }, 1800);
};
$('retry').onclick = async () => { const r = await post('/api/retry', {}); alert('Requeued ' + (r.data.jobs||0) + ' job(s).'); tick(); };

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-drop]');
  if (!b) return;
  const id = b.getAttribute('data-drop');
  const row = b.parentElement.querySelector('.path').textContent;
  if (!confirm('Delete this copy?\\n\\n' + row + '\\n\\nThe other copy is kept. This cannot be undone.')) return;
  b.disabled = true; b.textContent = 'checking';
  const r = await post('/api/drop', { id });
  if (!r.ok) { b.disabled = false; b.textContent = 'Delete'; alert('Refused: ' + (r.data.error || 'unknown')); return; }
  b.parentElement.remove();
  tick();
});

tick();
setInterval(tick, 3000);
</script>
</body></html>`;

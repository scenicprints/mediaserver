// The optimizer's own window.
//
// Everything this program does was reachable only by typing node commands at
// it, which is not a program so much as a set of instructions for operating
// one. This is the interface: what it is doing, what it has done, what it has
// given up on, and which files it cannot read.
//
// It is served BY the watch process rather than being a second program. One
// process means one database handle and no chance of the window and the worker
// disagreeing about what is happening.
//
// Deliberately not part of Marquee: separate program, separate port, separate
// process. A crash here cannot take down playback, and the media server has no
// idea this exists.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as engine from './engine.mjs';
import { readSettings, writeSettings, SETTING_NAMES } from './settings.mjs';

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
  log = () => {},
  root = null,
  onSettingsSaved = () => {}
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
          plan
        });
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

      if (p === '/api/retry' && req.method === 'POST') {
        const body = await readBody(req);
        const r = engine.retryStuck(db, { id: Number(body.id) || 0, includeJudged: !!body.judged });
        return json(res, 200, r);
      }

      // ---- Settings --------------------------------------------------------
      // Only the keys settings.mjs knows about can be written, and each one is
      // validated there. A rejected value returns 400 with the reason and
      // changes nothing, rather than being quietly clamped into something the
      // owner did not ask for.
      if (p === '/api/settings' && req.method === 'GET') {
        if (!root) return json(res, 200, { unavailable: true });
        return json(res, 200, readSettings(root));
      }

      if (p === '/api/settings' && req.method === 'POST') {
        if (!root) return json(res, 503, { error: 'settings are not available in this build' });
        const body = await readBody(req);
        try {
          const now = writeSettings(root, body);
          onSettingsSaved(now);            // the pass mark lives in a module, so it is pushed
          log('Settings changed: ' + Object.keys(body).filter((k) => SETTING_NAMES.includes(k)).join(', '));
          return json(res, 200, now);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
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
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .card { border:1px solid var(--rule); background:var(--panel); padding:16px 18px; margin-bottom:1px; }
  .card .h { display:flex; justify-content:space-between; gap:16px; align-items:baseline; }
  .card .title { font-weight:600; font-size:15px; }
  .card .size { color:var(--ink3); font-variant-numeric:tabular-nums; font-size:12px; letter-spacing:.1em; }
  .keepline, .dropline { display:flex; gap:12px; align-items:center; margin-top:10px; font-size:12.5px; }
  .tag { font-size:10px; font-weight:700; letter-spacing:.16em; padding:3px 8px; border:1px solid var(--rule); white-space:nowrap; }
  .tag.keep { color:var(--ink2); }
  .tag.drop { color:var(--signal); border-color:var(--signal); }
  .path { color:var(--ink2); word-break:break-all; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; }
  .why { color:var(--ink3); font-size:11.5px; }
  pre { background:var(--sunk); border:1px solid var(--rule); padding:14px 16px; margin:0;
    max-height:340px; overflow:auto; font-family:ui-monospace,Consolas,monospace; font-size:11.5px;
    color:var(--ink2); white-space:pre-wrap; word-break:break-word; }
  .empty { color:var(--ink3); padding:16px 18px; border:1px solid var(--rule); background:var(--panel); }
  /* Settings. Each switch carries its own explanation, because the ones here
     change whether the program does anything at all and a bare label would
     leave the owner guessing. */
  .opt { display:flex; gap:12px; align-items:flex-start; padding:10px 0; }
  .opt + .opt { border-top:1px solid var(--rule); }
  .opt input[type=checkbox] { margin-top:3px; width:15px; height:15px; accent-color:var(--signal); flex:none; }
  .opt b { display:block; font-weight:600; font-size:13.5px; }
  .opt i { display:block; color:var(--ink3); font-size:11.5px; font-style:normal; margin-top:3px; max-width:70ch; }
  .fields { display:flex; gap:20px; flex-wrap:wrap; align-items:baseline; }
  .fields label { color:var(--ink3); font-size:11px; letter-spacing:.14em; text-transform:uppercase; }
  .fields input { background:var(--sunk); border:1px solid var(--rule); color:var(--ink); padding:6px 8px;
    font-family:ui-monospace,Consolas,monospace; font-size:12.5px; margin-left:8px; }
  .fields input:focus { outline:none; border-color:var(--signal); }
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
  <h2>Stuck</h2>
  <div class="row" style="margin-bottom:14px">
    <button id="retry">Try these again</button>
    <span class="sub" id="stuckstate"></span>
  </div>
  <div id="stuck"></div>
</section>

<section>
  <h2>Settings</h2>
  <div id="settings" class="card">
    <label class="opt">
      <input type="checkbox" id="s_pause">
      <span>
        <b>Pause while someone is watching</b>
        <i>Asks the media server before starting work. Turn this off if you do not
        run Marquee — the check treats "no answer" as "someone is watching", so
        with another server, or none, nothing will ever run.</i>
      </span>
    </label>
    <label class="opt">
      <input type="checkbox" id="s_always">
      <span>
        <b>Work around the clock</b>
        <i>Off means only between the hours below. Encoding is heavy; playback always wins either way.</i>
      </span>
    </label>
    <div class="opt">
      <span class="fields">
        <label>From <input type="text" id="s_from" size="5" placeholder="00:00"></label>
        <label>To <input type="text" id="s_to" size="5" placeholder="05:00"></label>
        <label>Media server port <input type="text" id="s_port" size="6" placeholder="8096"></label>
        <label>Quality pass mark <input type="text" id="s_vmaf" size="5" placeholder="95"></label>
      </span>
    </div>
    <div class="row" style="margin-top:4px">
      <button id="ssave" class="sig">Save</button>
      <span class="sub" id="sstate"></span>
    </div>
  </div>
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
    ['Shrunk', q.done||0, false],
    // Files the program looked at and chose to leave alone — either already
    // playable everywhere, or the re-encode was not good enough to keep. This
    // is a result, not a problem, and it used to be reported as 800 failures.
    ['Left as they were', (q.kept||0) + (q.skipped||0), false],
    ['Files', s.scannable.toLocaleString(), false]
  ];
  if (s.plan) cells.push(['Still to reclaim', GB(s.plan.totalBytes), false]);
  cells.push(['Hardware encode', s.nvenc ? 'Yes' : 'CPU only', false]);
  $('stats').innerHTML = cells.map(([k,v,sig]) =>
    '<div class="cell"><div class="k">' + k + '</div><div class="v' + (sig?' sig':'') + '">' + esc(v) + '</div></div>').join('');
}

// Only things that actually went wrong. A file the program decided to leave
// alone is in 'kept' and never reaches here, which is the point: this list is
// for faults someone may need to act on, and when it is padded with 800
// correct decisions nobody reads it at all.
function renderStuck(s) {
  const k = s.stuck;
  const total = k.failed + k.retry + k.unreadable;
  $('stuckstate').textContent = total === 0
    ? 'nothing went wrong'
    : [k.retry ? k.retry + ' waiting to retry' : null,
       k.failed ? k.failed + ' gave up' : null,
       k.unreadable ? k.unreadable + ' unreadable' : null].filter(Boolean).join(' · ');
  const rows = [];
  for (const j of k.jobs) rows.push([j.state === 'retry' ? 'Retry' : 'Gave up', String(j.path||'').split(/[\\\\/]/).pop(), j.error]);
  // A file that will not even probe is a genuine fault, so it belongs in this
  // list rather than in a panel of its own.
  for (const p of k.probes) rows.push(['Unreadable', String(p.path||'').split(/[\\\\/]/).pop(), p.probe_error]);
  $('stuck').innerHTML = rows.length
    ? rows.map(([tag,name,err]) =>
        '<div class="card"><div class="keepline"><span class="tag ' + (tag==='Retry'?'keep':'drop') + '">' + tag + '</span>' +
        '<span class="title" style="font-size:13px">' + esc(name) + '</span></div>' +
        '<div class="why">' + esc(String(err||'').split('\\n')[0].slice(0,220)) + '</div></div>').join('')
    : '<div class="empty">Nothing went wrong.</div>';
}

async function tick() {
  try {
    const s = await get('/api/status');
    $('head').textContent = s.worker.running ? 'working' : 'idle';
    renderNow(s); renderStats(s); renderStuck(s);
    const l = await get('/api/log');
    $('log').textContent = l.text || 'nothing logged yet';
    $('log').scrollTop = $('log').scrollHeight;
  } catch (e) { $('head').textContent = 'not running'; }
}

$('retry').onclick = async () => { const r = await post('/api/retry', {}); alert('Requeued ' + (r.data.jobs||0) + ' job(s).'); tick(); };

// ---- Settings ----------------------------------------------------------
// Loaded once rather than on every poll: the fields are editable, and
// overwriting them three seconds into someone typing is its own bug.
async function loadSettings() {
  const s = await get('/api/settings');
  if (s.unavailable) { $('settings').innerHTML = '<div class="empty">Settings are not available in this build.</div>'; return; }
  $('s_pause').checked = s.pauseWhileWatching !== false;
  $('s_always').checked = !!(s.optimizeWindow && s.optimizeWindow.always);
  $('s_from').value = (s.optimizeWindow && s.optimizeWindow.from) || '00:00';
  $('s_to').value = (s.optimizeWindow && s.optimizeWindow.to) || '05:00';
  $('s_port').value = s.mediaServerPort || 8096;
  $('s_vmaf').value = s.vmafPassMark != null ? s.vmafPassMark : 95;
}

$('ssave').onclick = async () => {
  $('ssave').disabled = true;
  $('sstate').textContent = 'saving…';
  const r = await post('/api/settings', {
    pauseWhileWatching: $('s_pause').checked,
    mediaServerPort: $('s_port').value.trim(),
    vmafPassMark: $('s_vmaf').value.trim(),
    optimizeWindow: { always: $('s_always').checked, from: $('s_from').value.trim(), to: $('s_to').value.trim() }
  });
  $('ssave').disabled = false;
  if (!r.ok) { $('sstate').innerHTML = '<span class="tag drop">' + esc(r.data.error || 'could not save') + '</span>'; return; }
  $('sstate').textContent = 'saved';
  await loadSettings();                       // show what was actually stored
  setTimeout(() => { $('sstate').textContent = ''; }, 2500);
};

loadSettings();
tick();
setInterval(tick, 3000);
</script>
</body></html>`;

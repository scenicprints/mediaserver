// ============================================================
//  Telemetry — the app's flight recorder. The TV apps run in
//  other people's living rooms; when something breaks there,
//  these events are the only way to see it. Captures JS errors,
//  failed/slow API calls, main-thread stalls + a periodic FPS
//  sample (the "feels laggy" numbers), and device info; app.js
//  adds player/buffering/navigation/deep-link events through
//  window.tele(type, data). Batches post to /api/telemetry every
//  few seconds (session-cookie auth; requeued until signed in).
//  Loaded FIRST and written defensively (old TV WebViews!) so
//  telemetry itself can never break the app.
// ============================================================
(function () {
  var Q = [];

  // A stable per-install id, so the admin Diagnostics view can tell the TCL
  // from the projector from a laptop. Not tied to identity — sessions carry it.
  var device = 'unknown';
  try {
    device = localStorage.getItem('teleDevice');
    if (!device) {
      device = 'd' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('teleDevice', device);
    }
  } catch (e) { /* storage unavailable — still report, just unnamed */ }

  window.tele = function (type, data) {
    try {
      if (Q.length >= 300) Q.shift(); // never grow unbounded while offline/logged out
      Q.push({ ts: Date.now(), type: String(type), data: data || {} });
    } catch (e) { /* never break the app */ }
  };

  function requeue(batch) { try { Q = batch.concat(Q).slice(0, 300); } catch (e) { /* drop */ } }
  function flush(unloading) {
    if (!Q.length) return;
    var batch = Q.splice(0, 100);
    var body = JSON.stringify({ device: device, events: batch });
    try {
      if (unloading && navigator.sendBeacon) {
        navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (res) { if (!res.ok) requeue(batch); }, function () { requeue(batch); });
    } catch (e) { requeue(batch); }
  }
  setInterval(function () { flush(false); }, 7000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true); // TV Home button = hidden, get the tail out
  });

  // ---- Errors: window errors, promise rejections, console.error ----
  window.addEventListener('error', function (e) {
    tele('error', {
      msg: String(e.message || e.type || '?').slice(0, 300),
      src: (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 600) : undefined
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    tele('error', {
      msg: ('unhandledrejection: ' + (r.message || r)).slice(0, 300),
      stack: r.stack ? String(r.stack).slice(0, 600) : undefined
    });
  });
  var cerror = console.error;
  console.error = function () {
    try { tele('error', { msg: ('console: ' + [].slice.call(arguments).map(String).join(' ')).slice(0, 300) }); } catch (e) { /* ignore */ }
    return cerror.apply(console, arguments);
  };

  // ---- Failed / slow API calls (a flaky remote link shows up here) ----
  var ofetch = window.fetch;
  if (ofetch) window.fetch = function (input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var t0 = Date.now();
    var p = ofetch.apply(window, arguments);
    if (url.indexOf('/api/') === 0 && url.indexOf('/api/telemetry') !== 0) {
      p.then(function (res) {
        var ms = Date.now() - t0;
        if (!res.ok && res.status !== 401) tele('net', { url: url.split('?')[0], status: res.status, ms: ms });
        else if (ms > 4000) tele('net', { url: url.split('?')[0], slow: true, ms: ms });
      }, function (err) {
        tele('net', { url: url.split('?')[0], failed: true, ms: Date.now() - t0, msg: String(err).slice(0, 120) });
      });
    }
    return p;
  };

  // ---- Lag vitals: long main-thread stalls + a 1s FPS sample each minute ----
  // These are the objective "the app feels laggy on this TV" numbers.
  var longCount = 0, longMax = 0;
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (en) { longCount++; if (en.duration > longMax) longMax = en.duration; });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* not supported — vitals still carry fps/heap */ }
  function fpsSample() {
    try {
      var frames = 0, t0 = performance.now();
      function tick(t) {
        frames++;
        if (t - t0 < 1000) requestAnimationFrame(tick);
        else {
          tele('vitals', {
            fps: Math.round(frames / ((t - t0) / 1000)),
            longTasks: longCount,
            longestMs: Math.round(longMax),
            heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined
          });
          longCount = 0; longMax = 0;
        }
      }
      requestAnimationFrame(tick);
    } catch (e) { /* ignore */ }
  }
  setInterval(fpsSample, 60000);

  // ---- Boot: what device is this? ----
  var nc = navigator.connection || {};
  var tvMode = false;
  try { tvMode = /[?&]tv=1/.test(location.search) || localStorage.getItem('tvMode') === '1'; } catch (e) { /* ignore */ }
  tele('boot', {
    ua: navigator.userAgent,
    viewport: innerWidth + 'x' + innerHeight,
    screen: (window.screen && screen.width) ? screen.width + 'x' + screen.height : undefined,
    dpr: window.devicePixelRatio,
    tv: tvMode,
    lang: navigator.language,
    downlink: nc.downlink,
    effType: nc.effectiveType,
    appVer: (function () {
      try { return window.MarqueeTV && MarqueeTV.appVersion ? MarqueeTV.appVersion() : undefined; } catch (e) { return undefined; }
    })()
  });
})();

// Side-by-side harness: the Android TV web UI (?tv=1, 960x540 CSS at DPR 2, the
// MarqueeTV bridge stubbed) and the Roku simulator, driven by the same remote keys.
// Used by scenarios.mjs. Output (web / roku / composite+diff PNGs) goes to ./out.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
// A dev-server session token (never commit one): MQ_TOKEN=... node scenarios.mjs
const TOKEN = process.env.MQ_TOKEN || '';
if (!TOKEN) { console.error('set MQ_TOKEN to a session token on the dev server'); process.exit(1); }
const SEED = Math.floor(Date.now() / 14400000);
const WEB = 'http://127.0.0.1:8096/?tv=1';
const SIM = `http://localhost:8099/?token=${TOKEN}&seed=${SEED}&debug=1&freeze=1`;
const WKEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Backspace' };
const RKEY = { up: 'up', down: 'down', left: 'left', right: 'right', ok: 'select', back: 'back', play: 'play', rev: 'rev', fwd: 'fwd' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open(opts = {}) {
  // One browser per app: a background tab pauses CSS transitions and rAF, which
  // froze the web's widths mid-transition and would stall the sim's canvas.
  const launch = () => puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', pipe: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--font-render-hinting=none',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
  });
  const browser = await launch();
  const rbrowser = await launch();
  const web = (await browser.pages())[0] || await browser.newPage();
  await web.setViewport({ width: 960, height: 540, deviceScaleFactor: 2 });
  if (!opts.loggedOut) await web.setCookie({ name: 'mstoken', value: TOKEN, url: 'http://127.0.0.1:8096/' });
  await web.evaluateOnNewDocument(() => {
    // Android's WebView: the MarqueeTV bridge exists, so native playback is used.
    window.__native = [];
    window.MarqueeTV = { openApp: (u) => window.__native.push({ openApp: u }), playNative: (s) => window.__native.push({ play: JSON.parse(s) }), appVersion: () => '1.0 (harness)' };
    // Pin the row shuffle: ROTATION_SEED = (now/4h) ^ random -> (now/4h) ^ 0.
    const si = window.setInterval; window.setInterval = (f, ms, ...a) => (ms === 9000 ? 0 : si(f, ms, ...a));
    const real = Math.random; Math.random = () => 0;
    document.addEventListener('DOMContentLoaded', () => { Math.random = real; });
    const st = document.createElement('style');
    // Owner's scope cut: no trailers on the Roku, so the web's Trailers & Extras row is hidden too.
    st.textContent = '::-webkit-scrollbar{display:none} .dp-section:has(.trailer-card){display:none!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
  });
  const roku = (await rbrowser.pages())[0] || await rbrowser.newPage();
  await roku.setViewport({ width: 1000, height: 800 });
  const errs = [];
  web.on('pageerror', (e) => errs.push('web: ' + e.message));
  await Promise.all([web.goto(WEB, { waitUntil: 'networkidle2' }), roku.goto(opts.loggedOut ? SIM.replace(/token=[^&]*&/, '') : SIM)]);
  // The Roku is ready once the first browse answered.
  for (let i = 0; i < 60; i++) {
    const ok = await roku.evaluate(() => window.__log && window.__log.some((l) => (/200 \/api\/roku\/browse/.test(l) || /401/.test(l))));
    if (ok) break;
    await sleep(500);
  }
  await sleep(2500);
  const close = async () => { await browser.close(); await rbrowser.close(); };
  return { browser, rbrowser, web, roku, errs, close };
}

export async function press(h, k, wait = 1300) {
  await Promise.all([
    WKEY[k] ? h.web.keyboard.press(WKEY[k]) : Promise.resolve(),
    h.roku.evaluate((kk) => window.key(kk), RKEY[k])
  ]);
  await sleep(wait);
}

export async function snap(h, name) {
  const w = await h.web.screenshot({ encoding: 'base64' });
  const r = await h.roku.evaluate(() => {
    const img = brs.getScreenshot();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync(path.join(OUT, name + '.web.png'), Buffer.from(w, 'base64'));
  fs.writeFileSync(path.join(OUT, name + '.roku.png'), Buffer.from(r, 'base64'));
  // Composite + diff in a scratch page.
  const p = await h.rbrowser.newPage();
  const res = await p.evaluate(async (a, b) => {
    const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const W = 960, H = 540;
    const ca = document.createElement('canvas'); ca.width = W; ca.height = H; ca.getContext('2d').drawImage(A, 0, 0, W, H);
    const cb = document.createElement('canvas'); cb.width = W; cb.height = H; cb.getContext('2d').drawImage(B, 0, 0, W, H);
    const da = ca.getContext('2d').getImageData(0, 0, W, H).data, db = cb.getContext('2d').getImageData(0, 0, W, H).data;
    const out = document.createElement('canvas'); out.width = W * 3; out.height = H;
    const o = out.getContext('2d'); o.drawImage(ca, 0, 0); o.drawImage(cb, W, 0);
    const d = o.createImageData(W, H); let bad = 0;
    for (let i = 0; i < da.length; i += 4) {
      const diff = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      const hot = diff > 60; if (hot) bad++;
      const g = (da[i] + da[i + 1] + da[i + 2]) / 12;
      d.data[i] = hot ? 255 : g; d.data[i + 1] = hot ? 40 : g; d.data[i + 2] = hot ? 40 : g; d.data[i + 3] = 255;
    }
    o.putImageData(d, W * 2, 0);
    return { png: out.toDataURL('image/png').split(',')[1], pct: (100 * bad / (W * H)).toFixed(2) };
  }, w, r);
  await p.close();
  fs.writeFileSync(path.join(OUT, name + '.cmp.png'), Buffer.from(res.png, 'base64'));
  return res.pct;
}

export async function webFocus(h) {
  return h.web.evaluate(() => {
    const f = document.querySelector('.tv-focus');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { cls: f.className, text: (f.textContent || f.value || f.placeholder || '').trim().slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

export async function rokuFocus(h) {
  return h.roku.evaluate(() => {
    const l = window.__log.filter((x) => /\[focus\] ->/.test(x)).pop() || '';
    return l.replace(/.*\[focus\]/, '').replace(/\\r.*/, '');
  });
}

// A scenario is a list of steps: 'up'|'down'|... | ['wait', ms] | ['snap', name] | ['fn', async (h)=>{}]
export async function run(name, steps, opts) {
  const h = await open(opts);
  const report = [];
  try {
    for (const s of steps) {
      if (typeof s === 'string') { await press(h, s); report.push(`${s}: web ${JSON.stringify(await webFocus(h))} | roku ${await rokuFocus(h)}`); }
      else if (s[0] === 'wait') await sleep(s[1]);
      else if (s[0] === 'k') { await press(h, s[1], s[2]); report.push(`${s[1]}: web ${JSON.stringify(await webFocus(h))} | roku ${await rokuFocus(h)}`); }
      else if (s[0] === 'snap') report.push(`SNAP ${s[1]}: diff ${await snap(h, name + '-' + s[1])}%`);
      else if (s[0] === 'fn') report.push(String(await s[1](h)));
    }
  } finally {
    if (h.errs.length) report.push('ERRORS: ' + h.errs.join(' / '));
    await h.close();
  }
  return report.join('\n');
}

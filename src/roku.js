// ---------------------------------------------------------------------------
// Roku client support.
//
// 1. Over-the-air delivery. The Roku runs a tiny sideloaded "shell" channel
//    that loads the real app as a SceneGraph ComponentLibrary from
//    /roku/marquee.zip, zipped here on demand from roku/lib/. So a push + the
//    Dell's Update is a Roku update too: nobody touches the TV. The shell
//    itself is served as /roku/shell.zip, and /roku/version.json says which
//    shell is current, so the app can reinstall a newer shell over itself.
//    These are public (they are code from a public repo, no data).
//
// 2. The browse logic, computed here. The Android TV app is the web app, and
//    the Roku has to show exactly the same rows. BrightScript is slow and has
//    no JS engine, so rather than rewrite ~400 lines of row/hero/channel logic
//    in it (and have the two drift), this is a line-for-line port of the
//    public/app.js functions, run server-side over the same /api data the web
//    gets. KEEP IN STEP WITH public/app.js: each block names its source.
//    The Roku sends its own seed and local date so the result is exactly what
//    the web computes in the viewer's browser.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ============================================================ zip (store/deflate, no deps)
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).split(path.sep).join('/'), path: p, mtime: st.mtimeMs, size: st.size });
  }
  return out;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const when = dosTime(new Date(2024, 0, 1)); // fixed, so identical input -> identical zip
  for (const f of files) {
    const data = fs.readFileSync(f.path);
    const crc = zlib.crc32(data);
    // Images and fonts barely compress; store them, deflate the text.
    const store = /\.(png|jpe?g|webp|ttf|otf)$/i.test(f.rel);
    const body = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.rel, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(when.time, 10); lh.writeUInt16LE(when.date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt16LE(when.time, 12); ch.writeUInt16LE(when.date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Rebuilt only when a file under the folder changes.
function zipCache(dir) {
  let cached = null;
  return () => {
    const files = walk(dir);
    const stamp = files.map((f) => f.rel + ':' + f.mtime + ':' + f.size).join('|');
    if (!cached || cached.stamp !== stamp) {
      const buf = buildZip(files);
      cached = { stamp, buf, hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) };
    }
    return cached;
  };
}

function manifestValue(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// This request's own origin, for rewriting art URLs that come back from an
// internal inject(). Same helper as artcache.js's originOf: keep them equal.
function originOf(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  if (!host) return '';
  const proto = String((req && req.protocol) || 'http');
  return `${proto}://${host}`;
}

// ============================================================ public/app.js port
// ---- helpers (app.js: genresOf, hashStr, rng, pickN, seededShuffle) ----
const _genreCache = new WeakMap();
function genresOf(m) {
  let g = _genreCache.get(m);
  if (g) return g;
  try { g = JSON.parse(m.genres || '[]'); } catch (_e) { g = []; }
  if (!Array.isArray(g)) g = [];
  _genreCache.set(m, g);
  return g;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function pickN(arr, n, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return n == null ? a : a.slice(0, n);
}
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const NEW_MS = 14 * 24 * 3600 * 1000;
const isNew = (it) => it.added_at && Date.now() - it.added_at < NEW_MS;
const byRating = (a, b) => (b.rating || 0) - (a.rating || 0);

// ---- rows (app.js "Home / Movies / TV Shows — the rows") ----
function pairsFor(view, movies, shows) {
  if (view === 'tv') return shows.map((x) => ({ x, kind: 'show' }));
  if (view === 'movies') return movies.map((x) => ({ x, kind: 'movie' }));
  return [...movies.map((x) => ({ x, kind: 'movie' })), ...shows.map((x) => ({ x, kind: 'show' }))];
}
const gOf = (p) => genresOf(p.x);
const hasG = (p, g) => gOf(p).includes(g);
const anyG = (p, gs) => gOf(p).some((g) => gs.includes(g));
const rat = (p) => p.x.rating || 0;
const yr = (p) => p.x.year || 0;
const mins = (p) => p.x.runtime || (p.x.duration ? Math.round(p.x.duration / 60) : 0);
const isMovie = (p) => p.kind === 'movie';
const lowTitle = (p) => (p.x.title || '').toLowerCase();
const _textCache = new WeakMap();
function lowText(p) {
  let t = _textCache.get(p.x);
  if (t === undefined) { t = ((p.x.title || '') + ' ' + (p.x.overview || '')).toLowerCase(); _textCache.set(p.x, t); }
  return t;
}
const pRating = (a, b) => rat(b) - rat(a);
const pYear = (a, b) => yr(b) - yr(a);
const pYearUp = (a, b) => yr(a) - yr(b);
const pAdded = (a, b) => (b.x.added_at || 0) - (a.x.added_at || 0);
const pPlayed = (a, b) => (b.x.last_played_at || 0) - (a.x.last_played_at || 0);

// ---- the seasonal calendar (app.js, verbatim) ----
const dayKey = (m, d) => m * 100 + d;
const nthDow = (y, m, dow, n) => 1 + ((dow - new Date(y, m - 1, 1).getDay() + 7) % 7) + (n - 1) * 7;
function lastDow(y, m, dow) { const last = new Date(y, m, 0); return last.getDate() - ((last.getDay() - dow + 7) % 7); }
function easterMD(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * mm + 114) / 31), ((h + l - 7 * mm + 114) % 31) + 1];
}
function spanAround(y, md, before, after) {
  const a = new Date(y, md[0] - 1, md[1] - before), b = new Date(y, md[0] - 1, md[1] + after);
  return [dayKey(a.getMonth() + 1, a.getDate()), dayKey(b.getMonth() + 1, b.getDate())];
}
const inWindow = (from, to, k) => (from <= to ? k >= from && k <= to : k >= from || k <= to);
function daysUntil(md, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let best = Infinity;
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const diff = Math.abs((new Date(y, md[0] - 1, md[1]) - today) / 86400000);
    if (diff < best) best = diff;
  }
  return best;
}

function seasonalCalendar(y) {
  const win = (m1, d1, m2, d2) => [dayKey(m1, d1), dayKey(m2, d2)];
  const superBowl = [2, nthDow(y, 2, 0, 2)];
  const easter = easterMD(y);
  const mothers = [5, nthDow(y, 5, 0, 2)];
  const memorial = [5, lastDow(y, 5, 1)];
  const fathers = [6, nthDow(y, 6, 0, 3)];
  const presidents = [2, nthDow(y, 2, 1, 3)];
  const thanks = [11, nthDow(y, 11, 4, 4)];
  return [
    { id: 'newyear', rank: 10, on: [1, 1], name: '🥂 Ring in the New Year', win: win(12, 22, 1, 3), min: 3,
      textRe: /\bnew year'?s?\b|times square|hogmanay|auld lang syne|midnight kiss/ },
    { id: 'superbowl', rank: 15, on: superBowl, name: '🏈 Big Game Weekend', win: spanAround(y, superBowl, 13, 1), min: 3,
      textRe: /\bfootball\b|quarterback|gridiron|touchdown|super bowl|friday night lights|\bnfl\b|linebacker|the blind side|remember the titans|\brudy\b|any given sunday|draft day|jerry maguire|the longest yard/ },
    { id: 'valentine', rank: 10, on: [2, 14], name: "💘 Valentine's Night In", win: win(2, 1, 2, 15), min: 4,
      genres: ['Romance'], minRating: 6, sort: pRating },
    { id: 'presidents', rank: 10, on: presidents, name: '🎩 Presidents Day', win: spanAround(y, presidents, 9, 1), min: 3,
      textRe: /\bpresident(ial)?\b|the white house|oval office|\blincoln\b|george washington|\bnixon\b|\bjfk\b|air force one|\bthe west wing\b|primary colors|all the president's men/ },
    { id: 'stpat', rank: 10, on: [3, 17], name: '☘️ Luck of the Irish', win: win(3, 4, 3, 18), min: 3,
      textRe: /\birish\b|\bireland\b|\bdublin\b|belfast|leprechaun|shamrock|\bceltic\b|boondock saints|the commitments|waking ned/ },
    { id: 'easter', rank: 10, on: easter, name: '🐣 Easter Weekend', win: spanAround(y, easter, 14, 1), min: 3,
      textRe: /\beaster\b|resurrection|the passion of the christ|ten commandments|prince of egypt|\bben-?hur\b|\brisen\b|jesus christ|\bmoses\b|easter bunny|peter rabbit|\bpassover\b/ },
    { id: 'earthday', rank: 20, on: [4, 22], name: '🌎 Earth Day', win: win(4, 12, 4, 23), min: 3,
      textRe: /\bwildlife\b|rainforest|\bsafari\b|national park|conservation|endangered|\bclimate\b|the natural world|\bpenguins?\b|\bwhales?\b|planet earth|our planet/ },
    { id: 'starwars', rank: 5, on: [5, 4], name: '🌌 May the Fourth', win: win(4, 24, 5, 5), min: 3,
      titleRe: /star wars|\bjedi\b|\bsith\b|skywalker|rogue one|the mandalorian|\bandor\b|ahsoka|clone wars|empire strikes back|phantom menace|attack of the clones|revenge of the sith|force awakens|the last jedi|book of boba/ },
    { id: 'cinco', rank: 20, on: [5, 5], name: '🌮 Cinco de Mayo', win: win(4, 27, 5, 6), min: 3,
      textRe: /\bmexico\b|\bmexican\b|\boaxaca\b|guadalajara|day of the dead|dia de los muertos|luchador|mariachi|\bcartel\b|tijuana|\bcoco\b/ },
    { id: 'mothers', rank: 10, on: mothers, name: "💐 Mother's Day", win: spanAround(y, mothers, 12, 1), min: 3,
      textRe: /\bmother(s|hood)?\b|\bmom\b|\bmoms\b|\bmama\b|\bmommy\b|\bmum\b/ },
    { id: 'memorial', rank: 10, on: memorial, name: '🇺🇸 Memorial Day', win: spanAround(y, memorial, 12, 1), min: 4,
      genres: ['War'], sort: pRating },
    { id: 'fathers', rank: 10, on: fathers, name: "🧢 Father's Day", win: spanAround(y, fathers, 12, 1), min: 3,
      textRe: /\bfather(s|hood)?\b|\bdad\b|\bdads\b|\bpapa\b|\bdaddy\b/ },
    { id: 'july4', rank: 5, on: [7, 4], name: '🎆 Fourth of July', win: win(6, 21, 7, 5), min: 3,
      titleRe: /independence day|the patriot\b|captain america|national treasure|born on the fourth of july|top gun|apollo 13|hidden figures|first man\b|saving private ryan|air force one|remember the titans|forrest gump|the sandlot|\bjaws\b|\bglory\b|rocky iv|the right stuff|\b1776\b|yankee doodle/,
      textRe: /independence day|fourth of july|american revolution|founding fathers|declaration of independence|revolutionary war/ },
    { id: 'school', rank: 20, on: [9, 1], name: '🎒 Back to School', win: win(8, 15, 9, 20), min: 4,
      textRe: /high school|\bcollege\b|university|\bcampus\b|\bteacher\b|\bstudents?\b|\bprincipal\b|graduation|\bdorm\b|freshman|senior year|classroom|\bprom\b|boarding school|\bdetention\b|valedictorian/ },
    { id: 'halloween', rank: 5, on: [10, 31], name: '🎃 Halloween Frights', win: win(9, 21, 10, 31), min: 5,
      genres: ['Horror'], sort: pRating },
    { id: 'notsospooky', rank: 12, on: [10, 31], name: '👻 Not-So-Spooky', win: win(10, 1, 10, 31), min: 3,
      pick: (p) => anyG(p, ['Family', 'Animation', 'Fantasy', 'Comedy'])
        && /\bhalloween\b|\bghosts?\b|\bghostly\b|\bmonsters?\b|\bwitch(es)?\b|\bvampire|\bpumpkin|haunted|\bspooky\b|\bzombie|goosebumps|hocus pocus|addams|\bghouls?\b|coraline|\bcasper\b|trick or treat/.test(lowText(p)) },
    { id: 'veterans', rank: 10, on: [11, 11], name: '🎖️ Veterans Day', win: win(11, 1, 11, 12), min: 4,
      genres: ['War'], sort: pRating },
    { id: 'thanksgiving', rank: 5, on: thanks, name: '🦃 Thanksgiving', win: spanAround(y, thanks, 13, 1), min: 3,
      textRe: /thanksgiving|\bturkey day\b|planes,? trains|home for the holidays|\bpilgrims?\b|\bplymouth\b|free birds|friendsgiving/ },
    { id: 'christmas', rank: 5, on: [12, 25], name: '🎄 Christmas Movies', win: win(11, 24, 12, 26), min: 3,
      textRe: /\bchristmas\b|\bxmas\b|santa claus|\bsanta\b|\bst\.? nick\b|father christmas|\belf\b|\bgrinch\b|scrooge|\bnoel\b|reindeer|\bnativity\b|north pole|home alone|die hard|it'?s a wonderful life|miracle on 34th|\bjingle\b|nutcracker|\byuletide\b|mistletoe|krampus|\bklaus\b|polar express|a christmas carol|a christmas story|\bgremlins\b|love actually/ }
  ];
}

function themeMatcher(t) {
  return (p) => {
    if (t.pick) return t.pick(p);
    if (t.minRating && rat(p) < t.minRating) return false;
    if (t.genres && !anyG(p, t.genres)) return false;
    if (t.titleRe || t.textRe) {
      const hit = (t.titleRe && t.titleRe.test(lowTitle(p))) || (t.textRe && t.textRe.test(lowText(p)));
      if (!hit) return false;
    }
    return true;
  };
}

// `now` is the VIEWER's local date (sent by the Roku), as the browser's would be.
function seasonalRows(pool, now) {
  const k = dayKey(now.getMonth() + 1, now.getDate());
  const out = [];
  const byNearest = (a, b) => (daysUntil(a.on, now) - daysUntil(b.on, now)) || (a.rank - b.rank);
  for (const t of seasonalCalendar(now.getFullYear()).sort(byNearest)) {
    if (!inWindow(t.win[0], t.win[1], k)) continue;
    const items = pool.filter(themeMatcher(t));
    if (items.length < (t.min || 4)) continue;
    out.push({ group: 'seasonal', name: t.name, items, sort: t.sort || pRating, min: t.min || 4 });
    if (out.length === 2) break;
  }
  return out;
}

function candidateRows(view, P, rand, collections, now) {
  const rows = [];
  const add = (group, name, items, sort, min, topic) => { if (items.length >= (min || 4)) rows.push({ group, name, items, sort, min, topic }); };
  const movieP = P.filter(isMovie);
  const showP = P.filter((p) => p.kind === 'show');
  const thisYear = now.getFullYear();
  const label = (onHome, elsewhere) => (view === 'home' ? onHome : elsewhere);

  add('core', 'Recommended', P.filter((p) => !p.x.watched && rat(p) >= 7), pRating);
  add('core', 'Recently Released', P.slice(), pYear);
  add('core', 'Top Rated', P.slice(), pRating);
  add('core', 'Critically Acclaimed', P.filter((p) => rat(p) >= 8), pRating);
  add('core', 'Fresh This Week', P.filter((p) => p.x.added_at && Date.now() - p.x.added_at < 7 * 86400000), pAdded, 3);
  add('core', 'Favorites', movieP.filter((p) => p.x.favorite), pRating, 3);
  add('core', label('Unwatched Movies', 'Unwatched'), movieP.filter((p) => !p.x.watched), pRating);
  add('core', 'Watch Again', movieP.filter((p) => p.x.watched), pPlayed, 3);
  add('core', label('4K Movies', '4K'), movieP.filter((p) => (p.x.qualities || '').includes('4K')), pRating, 3);
  add('core', 'New Episodes', showP.filter((p) => p.x.unwatched > 0), pAdded);
  add('core', 'Finish What You Started', showP.filter((p) => p.x.unwatched > 0 && p.x.last_played_at), pPlayed, 3);
  if (view === 'home') {
    add('core', 'Movies', movieP.slice(), pRating);
    add('core', 'TV Shows', showP.slice(), pRating);
  }

  const moods = [
    ['😄 Feel-Good Comedies', (p) => hasG(p, 'Comedy') && rat(p) >= 6.5, 'Comedy'],
    ['😱 Edge of Your Seat', (p) => anyG(p, ['Thriller', 'Mystery']) && rat(p) >= 6, 'Thriller'],
    ['💞 Rom-Coms', (p) => hasG(p, 'Romance') && hasG(p, 'Comedy'), null],
    ['🏡 Family Movie Night', (p) => hasG(p, 'Family') && rat(p) >= 6, 'Family'],
    ['🎨 Animated', (p) => hasG(p, 'Animation'), 'Animation'],
    ['📖 Based on a True Story', (p) => /based on (a |the )?(true|real)|a true story|true events|real events|inspired by (a |the )?true/.test(lowText(p)), null],
    ['🚀 Into the Unknown', (p) => hasG(p, 'Science Fiction') && rat(p) >= 6, 'Science Fiction'],
    ['🐉 Swords and Sorcery', (p) => hasG(p, 'Fantasy'), 'Fantasy'],
    ['🕵️ Crime and Capers', (p) => hasG(p, 'Crime'), 'Crime'],
    ['🎖️ War Stories', (p) => hasG(p, 'War'), 'War'],
    ['🤠 Westerns', (p) => hasG(p, 'Western'), 'Western'],
    ['🎬 Documentaries', (p) => hasG(p, 'Documentary'), 'Documentary'],
    ['🎵 Music and Musicals', (p) => hasG(p, 'Music'), 'Music'],
    ['💥 Big and Loud', (p) => anyG(p, ['Action', 'Adventure']) && rat(p) >= 6.5, 'Action'],
    ['🌌 Out in Space', (p) => /\bspace\b|astronauts?\b|\borbit\b|\bmars\b|\bnasa\b|spaceship|space station|\bgalaxy\b|interstellar|moon landing|cosmonaut/.test(lowText(p)), null],
    ['💰 Heists and Cons', (p) => /\bheist\b|\brobbery\b|con (man|artist)|\bthieves\b|bank job|\bgrifter|\bswindle|\bcaper\b/.test(lowText(p)), null],
    ['👹 Creature Features', (p) => hasG(p, 'Horror') && /\bmonsters?\b|\bcreature\b|\bsharks?\b|dinosaur|\bkaiju\b|\baliens?\b|\bbeast\b/.test(lowText(p)), null],
    ['🧠 Slow Burns', (p) => hasG(p, 'Drama') && mins(p) >= 130, null]
  ];
  for (const m of moods) add('mood', m[0], P.filter(m[1]), pRating, 4, m[2]);

  add('discovery', '💎 Hidden Gems', P.filter((p) => rat(p) >= 7 && !p.x.watched && !p.x.last_played_at && yr(p) && yr(p) <= thisYear - 5), pRating);
  add('discovery', '⏱️ Short and Sweet', movieP.filter((p) => mins(p) >= 40 && mins(p) <= 100), pRating);
  add('discovery', '🍿 Settle In', movieP.filter((p) => mins(p) >= 150), pRating);
  add('discovery', '📼 From the Vault', P.filter((p) => yr(p) && yr(p) < 1980), pRating);
  add('discovery', '⏪ Watched Lately', P.filter((p) => p.x.last_played_at), pPlayed, 3);
  add('discovery', '🎲 Roll the Dice', pickN(P, 60, rand), null);

  const played = P.filter((p) => p.x.last_played_at).sort(pPlayed).slice(0, 5);
  const seed = pickN(played, 1, rand)[0];
  if (seed && gOf(seed).length) {
    const gs = gOf(seed);
    add('discovery', `Because you watched ${seed.x.title}`, P.filter((p) => p.x !== seed.x && !p.x.watched && anyG(p, gs)), pRating);
  }

  const byYear = {};
  P.forEach((p) => { if (yr(p)) (byYear[yr(p)] = byYear[yr(p)] || []).push(p); });
  const fatYear = pickN(Object.keys(byYear).filter((k) => byYear[k].length >= 6), 1, rand)[0];
  if (fatYear) add('discovery', `The Year ${fatYear}`, byYear[fatYear], pRating);

  if (view !== 'tv') {
    for (const c of pickN(collections.filter((c) => (c.ids || []).length >= 3), 3, rand)) {
      const ids = new Set(c.ids);
      add('discovery', '🎞️ ' + c.name.replace(/ Collection$/, ''), movieP.filter((p) => ids.has(p.x.id)), pYearUp, 3);
    }
  }

  for (const g of [...new Set(P.flatMap(gOf))].sort()) add('genre', g, P.filter((p) => hasG(p, g)), pRating, 4, g);
  const decades = [...new Set(P.map((p) => (yr(p) ? Math.floor(yr(p) / 10) * 10 : 0)).filter(Boolean))].sort((a, b) => b - a);
  for (const d of decades) add('decade', `${d}s`, P.filter((p) => yr(p) >= d && yr(p) < d + 10), pYear);

  return rows;
}

// TV values (TV_MODE is always on for the Roku).
const ROW_QUOTA = { core: 3, mood: 3, discovery: 2, genre: 3, decade: 1 };
const ROW_N = 12;

function chooseRows(view, P, rand, collections, now) {
  const need = Object.assign({}, ROW_QUOTA);
  const claimed = new Set();
  const out = [];
  for (const r of pickN(candidateRows(view, P, rand, collections, now), null, rand)) {
    if (!need[r.group]) continue;
    if (r.topic && claimed.has(r.topic)) continue;
    if (r.topic) claimed.add(r.topic);
    need[r.group]--;
    out.push(r);
  }
  const lead = out.find((r) => r.group === 'core');
  return lead ? [lead, ...out.filter((r) => r !== lead)] : out;
}

// ---- cards (app.js buildMediaCard / streamCard / continueCards) ----
// The Roku draws exactly what these describe; no decisions are left to it.
const STREAM_PROVIDERS = {
  netflix: { name: 'Netflix', color: '#e50914' },
  prime: { name: 'Prime Video', color: '#1399ff' },
  disney: { name: 'Disney+', color: '#0a63e6' },
  hulu: { name: 'Hulu', color: '#1ce783' },
  max: { name: 'Max', color: '#a05cff' },
  appletv: { name: 'Apple TV+', color: '#7d7d7d' },
  paramount: { name: 'Paramount+', color: '#0064ff' },
  peacock: { name: 'Peacock', color: '#00b7eb' }
};

function streamCard(it) {
  const provs = it.providers || [];
  const p = STREAM_PROVIDERS[provs[0]] || { name: provs[0] || 'Streaming', color: '#555555' };
  return {
    type: 'stream', title: it.title, poster: it.poster || '', sub: it.year ? String(it.year) : '', pct: 0,
    badge: { text: p.name + (provs.length > 1 ? ` +${provs.length - 1}` : ''), style: 'stream', color: p.color },
    provider: provs[0] || '', providers: provs, year: it.year || null
  };
}

function mediaCard(it, kind) {
  if (it.source === 'stream') return streamCard(it);
  const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
  let badge = null;
  if (kind === 'show' && it.unwatched > 0) badge = { text: `${it.unwatched} new`, style: 'new' };
  else if (isNew(it)) badge = { text: 'NEW', style: 'new' };
  else if (kind === 'movie' && it.versions > 1 && it.qualities) badge = { text: it.qualities.split(',').sort().reverse()[0], style: 'plain' };
  let alsoOn = null;
  if (it.alsoOn && it.alsoOn.length) {
    const ap = STREAM_PROVIDERS[it.alsoOn[0]] || { name: it.alsoOn[0], color: '#555555' };
    alsoOn = { text: `▸ ${ap.name}${it.alsoOn.length > 1 ? ` +${it.alsoOn.length - 1}` : ''}`, color: ap.color };
  }
  const sub = kind === 'show' ? `${it.episodes} episode${it.episodes === 1 ? '' : 's'}` : (it.year ? String(it.year) : '');
  return {
    type: kind, id: it.id, title: it.title, poster: it.poster || '', sub, pct, badge, alsoOn,
    watched: kind === 'movie' ? !!it.watched : null
  };
}

function continueCards(items) {
  return items.map((it) => {
    const pct = it.duration && it.resume_position ? Math.min(100, (it.resume_position / it.duration) * 100) : 0;
    const sub = it.kind === 'episode' ? `S${it.season}·E${String(it.episode).padStart(2, '0')}` : 'Movie';
    return { type: 'continue', kind: it.kind, id: it.id, showId: it.show_id || null, title: it.title, poster: it.poster || '', sub, pct, dismiss: true };
  });
}

// ---- hero (app.js weeklyPick / setHero / drawHero) ----
function weeklyPick(items, n) {
  const pool = (items || []).slice();
  if (pool.length <= n) return pool;
  let s = (Math.floor(Date.now() / 604800000) * 2654435761) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function heroFor(view, movies, shows) {
  let items;
  if (view === 'movies') items = movies.filter((m) => m.backdrop);
  else if (view === 'tv') items = shows.filter((s) => s.backdrop);
  else items = [...movies.filter((m) => m.backdrop), ...shows.filter((s) => s.backdrop)].sort(byRating);
  return weeklyPick(items.filter((x) => x.source !== 'stream'), 6).map((it) => {
    const kind = it.episodes !== undefined ? 'show' : 'movie';
    return {
      kind, id: it.id, title: it.title, art: it.backdrop || it.poster || '', overview: it.overview || '',
      year: it.year || null, rating: it.rating ? it.rating.toFixed(1) : null,
      extra: kind === 'show' ? `${it.episodes} episodes` : (it.qualities ? it.qualities.split(',').sort().reverse()[0] : null),
      extraQ: kind !== 'show'
    };
  });
}

// ---- the page (app.js renderView) ----
export function computeView(view, data, seed, now) {
  const { movies, shows, continueItems, collections } = data;
  const P = pairsFor(view, movies, shows);
  const rand = rng((hashStr('rows:' + view) ^ seed) >>> 0);
  const out = [];
  const cw = view === 'movies' ? continueItems.filter((c) => c.kind === 'movie')
    : view === 'tv' ? continueItems.filter((c) => c.kind === 'episode')
    : continueItems;
  if (cw.length) out.push({ key: 'continuewatching', title: 'Continue Watching', parts: ['Continue Watching'], total: cw.length, cards: continueCards(cw), seeAll: false });
  const pinned = [...seasonalRows(P, now), { group: 'core', name: 'Recently Added', items: P.slice(), sort: pAdded, min: 1 }];
  const seen = new Set();
  for (const r of [...pinned, ...chooseRows(view, P, rand, collections, now)]) {
    const key = r.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const items = r.sort ? r.items.slice().sort(r.sort) : r.items;
    out.push({ key, title: r.name, parts: richParts(r.name), total: items.length, seeAll: true, all: items, cards: items.slice(0, ROW_N).map((p) => mediaCard(p.x, p.kind)) });
  }
  return { hero: heroFor(view, movies, shows), rows: out };
}

// ---- Live TV (app.js "Live TV (channel surfing)") ----
const LT_EPOCH = 1704067200;
const ltDuration = (it) => it.kind === 'episode'
  ? (it.ref.duration || 30 * 60)
  : ((it.ref.runtime && it.ref.runtime * 60) || it.ref.duration || 105 * 60);
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
const ltAudOk = (it, mature) => (mature ? ltTier(it) !== 'family' : ltTier(it) !== 'mature');

function ltItemPool(movies, ltEpisodes) {
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

export function buildChannels(movies, ltEpisodes) {
  const all = ltItemPool(movies, ltEpisodes);
  if (!all.length) return [];
  const has = (it, name) => genresOf(it.ref).includes(name);
  const hasAny = (it, names) => genresOf(it.ref).some((x) => names.includes(x));
  const decadeOf = (it) => (it.ref.year ? Math.floor(it.ref.year / 10) * 10 : null);
  const byRatingI = (a, b) => (b.ref.rating || 0) - (a.ref.rating || 0);
  const byYear = (a, b) => (b.ref.year || 0) - (a.ref.year || 0);
  const defs = [
    { name: 'PRIME', sub: 'Feature Films', pick: (it) => it.kind === 'movie', sort: byRatingI },
    { name: 'BINGE TV', sub: 'Series Marathon', pick: (it) => it.kind === 'episode' },
    { name: 'ADRENALINE', sub: 'Action', pick: (it) => has(it, 'Action'), sort: byRatingI },
    { name: 'THE LAUGH TRACK', sub: 'Comedy', pick: (it) => has(it, 'Comedy') },
    { name: 'NIGHTMARE', sub: 'Horror', mature: true, pick: (it) => has(it, 'Horror') },
    { name: 'PRESTIGE', sub: 'Drama', pick: (it) => has(it, 'Drama'), sort: byRatingI },
    { name: 'FAMILY ROOM', sub: 'Family & Kids', pick: (it) => ltTier(it) === 'family' },
    { name: 'NEBULA', sub: 'Science Fiction', pick: (it) => has(it, 'Science Fiction') },
    { name: 'PRECINCT', sub: 'Crime', mature: true, pick: (it) => has(it, 'Crime') },
    { name: 'MYTHOS', sub: 'Fantasy', pick: (it) => has(it, 'Fantasy') },
    { name: 'PULSE', sub: 'Thrillers', mature: true, pick: (it) => has(it, 'Thriller') },
    { name: 'TRAILBLAZER', sub: 'Adventure', pick: (it) => has(it, 'Adventure') },
    { name: 'HEARTLINE', sub: 'Romance', pick: (it) => has(it, 'Romance') },
    { name: 'TOP SHELF', sub: 'Top Rated', pick: (it) => (it.ref.rating || 0) >= 7.5, sort: byRatingI },
    { name: 'TOON CITY', sub: 'Animation', pick: (it) => has(it, 'Animation') },
    { name: 'BLOCKBUSTER', sub: 'Big & Loud', pick: (it) => hasAny(it, ['Action', 'Adventure', 'Science Fiction']) && (it.ref.rating || 0) >= 6.5, sort: byRatingI },
    { name: 'AFTER DARK', sub: 'Late Night', mature: true, pick: (it) => hasAny(it, ['Horror', 'Thriller', 'Crime']), sort: byRatingI },
    { name: 'THE CRITICS', sub: 'Acclaimed', pick: (it) => (it.ref.rating || 0) >= 8, sort: byRatingI },
    { name: 'FRESH', sub: 'New Releases', pick: (it) => (it.ref.year || 0) >= 2020, sort: byYear },
    { name: 'REWIND 80s', sub: '1980s', pick: (it) => decadeOf(it) === 1980 },
    { name: 'REWIND 90s', sub: '1990s', pick: (it) => decadeOf(it) === 1990 },
    { name: 'FLASHBACK 00s', sub: '2000s', pick: (it) => decadeOf(it) === 2000 },
    { name: 'THROWBACK 10s', sub: '2010s', pick: (it) => decadeOf(it) === 2010 },
    { name: 'ENIGMA', sub: 'Mystery', pick: (it) => has(it, 'Mystery') },
    { name: 'FRONTLINE', sub: 'War Stories', mature: true, pick: (it) => has(it, 'War') },
    { name: 'THE REAL', sub: 'Documentary', pick: (it) => has(it, 'Documentary') },
    { name: 'ENCORE', sub: 'Music & Musicals', pick: (it) => has(it, 'Music') },
    { name: 'FRONTIER', sub: 'Westerns', pick: (it) => has(it, 'Western') },
    { name: 'SATURDAY MORNING', sub: 'Cartoons', pick: (it) => has(it, 'Animation') && ltTier(it) === 'family' },
    { name: 'DATE NIGHT', sub: 'Rom-Coms', pick: (it) => has(it, 'Romance') && has(it, 'Comedy') },
    { name: 'SITCOM CENTRAL', sub: 'TV Comedies', pick: (it) => it.kind === 'episode' && has(it, 'Comedy') },
    { name: 'THE SERIAL', sub: 'TV Dramas', pick: (it) => it.kind === 'episode' && has(it, 'Drama'), sort: byRatingI }
  ];
  const MIN = 3;
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
    return Object.assign({}, c, { number: i + 1, playlist, total });
  });
}

function nowOn(chan, atSec) {
  let pos = ((atSec - LT_EPOCH) % chan.total + chan.total) % chan.total;
  for (let i = 0; i < chan.playlist.length; i++) {
    const d = ltDuration(chan.playlist[i]);
    if (pos < d) return { item: chan.playlist[i], offset: pos, endsIn: d - pos, idx: i };
    pos -= d;
  }
  return { item: chan.playlist[0], offset: 0, endsIn: ltDuration(chan.playlist[0]), idx: 0 };
}

// Programmes from `from` to `to` (seconds), with their true start/end, plus the
// one after — enough for the guide window, the preview's "Up next", and a
// programme rolling over while the guide is open.
// Programmes across [from, to], always running on to the one after `at` (the
// preview's "Up next" needs it even when it starts past the guide window).
function programmes(chan, from, to, at = from) {
  const first = nowOn(chan, from);
  let start = from - first.offset;
  let idx = first.idx;
  const out = [];
  let guard = 0;
  while (guard++ < 60) {
    const item = chan.playlist[idx % chan.playlist.length];
    const dur = ltDuration(item);
    out.push({ start, end: start + dur, item: ltItemOut(item) });
    start += dur; idx++;
    if (start >= to && out.length >= 2 && out[out.length - 1].start > at) break;
  }
  return out;
}

function ltItemOut(it) {
  const r = it.ref;
  if (it.kind === 'episode') {
    return { kind: 'episode', showId: r.show_id, epId: r.epId, season: r.season, episode: r.episode, title: r.title,
      epTitle: r.epTitle || '', still: r.still || '', backdrop: r.backdrop || '', poster: r.poster || '',
      overview: r.overview || '', year: r.year || null, rating: r.rating || null };
  }
  return { kind: 'movie', id: r.id, title: r.title, still: '', backdrop: r.backdrop || '', poster: r.poster || '',
    overview: r.overview || '', year: r.year || null, rating: r.rating || null };
}

// ---- colour emoji: the Roku draws them as images, so split them out ----
// Same classes as roku/tools/build_assets.py (which fetched their images):
// flags, SMP pictographs, a BMP symbol followed by VS16, and the BMP symbols
// that draw as emoji by default.
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}][\u{1F3FB}-\u{1F3FF}]?️?|[⌀-➿⬀-⯿]️|[⏩-⏬⏰⏳⌚⌛⚡✨✅❌⭐]/gu;
function emojiFile(seq) {
  return [...seq].map((c) => c.codePointAt(0)).filter((c) => c !== 0xFE0F).map((c) => c.toString(16)).join('_');
}
export function richParts(s) {
  s = String(s || '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(EMOJI_RE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ e: emojiFile(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ============================================================ routes
export function registerRoku(app, { ROOT }) {
  const LIB_DIR = path.join(ROOT, 'roku', 'lib');
  const SHELL_DIR = path.join(ROOT, 'roku', 'shell');
  const libZip = zipCache(LIB_DIR);
  const shellZip = zipCache(SHELL_DIR);

  const sendZip = (reply, z) => reply
    .header('content-type', 'application/zip')
    .header('cache-control', 'no-cache')
    .header('etag', '"' + z.hash + '"')
    .send(z.buf);

  app.get('/roku/marquee.zip', (req, reply) => sendZip(reply, libZip()));
  app.get('/roku/shell.zip', (req, reply) => sendZip(reply, shellZip()));
  app.get('/roku/version.json', (req, reply) => {
    reply.header('cache-control', 'no-cache').send({
      lib: libZip().hash,
      shell: Number(manifestValue(path.join(SHELL_DIR, 'manifest'), 'build_version')) || 0
    });
  });

  // Ask our own API for exactly what the web app would get, as the same user.
  // The internal host is swapped for the viewer's real origin in art URLs.
  const INTERNAL = 'mq-internal.local';
  async function inject(req, url) {
    const res = await app.inject({
      method: 'GET', url,
      headers: {
        host: INTERNAL,
        authorization: req.headers.authorization || '',
        cookie: req.headers.cookie || ''
      }
    });
    if (res.statusCode !== 200) return null;
    const origin = originOf(req);
    return JSON.parse(res.body.split('http://' + INTERNAL + '/art/').join(origin + '/art/'));
  }
  async function libraryData(req) {
    const [movies, shows, continueItems, collections] = await Promise.all([
      inject(req, '/api/movies'), inject(req, '/api/shows'), inject(req, '/api/continue'), inject(req, '/api/collections')
    ]);
    return {
      movies: movies || [], shows: shows || [], continueItems: continueItems || [],
      collections: Array.isArray(collections) ? collections : []
    };
  }
  // The viewer's local date, as their browser would have it: ?ymd=2026-09-18.
  function viewerNow(q) {
    const m = String(q.ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date();
  }
  const viewOf = (q) => (['home', 'movies', 'tv'].includes(q.view) ? q.view : 'home');

  app.get('/api/roku/browse', async (req) => {
    const data = await libraryData(req);
    const { hero, rows } = computeView(viewOf(req.query), data, (Number(req.query.seed) >>> 0), viewerNow(req.query));
    return { hero, rows: rows.map(({ all, ...r }) => r) };
  });

  // "See all ›": the same row, recomputed from the same seed, every card.
  app.get('/api/roku/seeall', async (req) => {
    const data = await libraryData(req);
    const { rows } = computeView(viewOf(req.query), data, (Number(req.query.seed) >>> 0), viewerNow(req.query));
    const r = rows.find((x) => x.key === req.query.key);
    if (!r) return { title: '', cards: [] };
    return { title: r.title, cards: r.all ? r.all.map((p) => mediaCard(p.x, p.kind)) : r.cards };
  });

  // Library tab: A–Z sections, as renderLibrary groups them.
  app.get('/api/roku/library', async (req) => {
    const kind = req.query.kind === 'tv' ? 'tv' : 'movie';
    const list = (await inject(req, kind === 'tv' ? '/api/shows' : '/api/movies')) || [];
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const groups = {};
    for (const it of list) {
      let L = (it.title.replace(/^(the|a|an) /i, '')[0] || '#').toUpperCase();
      if (!/[A-Z]/.test(L)) L = '#';
      (groups[L] = groups[L] || []).push(it);
    }
    const letters = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((L) => groups[L]);
    return {
      count: list.length,
      sections: letters.map((L) => ({ letter: L, cards: groups[L].map((it) => mediaCard(it, kind === 'tv' ? 'show' : 'movie')) }))
    };
  });

  // Ribbon search, as the search box's input handler does it.
  app.get('/api/roku/search', async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const data = await libraryData(req);
    const mm = data.movies.filter((m) => m.title.toLowerCase().includes(q)).map((m) => mediaCard(m, 'movie'));
    const ss = data.shows.filter((s) => s.title.toLowerCase().includes(q)).map((s) => mediaCard(s, 'show'));
    return { title: `Results for “${String(req.query.q || '').trim()}”`, cards: [...mm, ...ss] };
  });

  // Live TV guide: every channel's programmes across the window. Channels are
  // built from the whole library, so they are cached briefly per user.
  const chanCache = new Map();
  app.get('/api/roku/guide', async (req) => {
    const key = String(req.user.id);
    let c = chanCache.get(key);
    if (!c || Date.now() - c.at > 5 * 60e3) {
      const [movies, eps] = await Promise.all([inject(req, '/api/movies'), inject(req, '/api/livetv/episodes')]);
      c = { at: Date.now(), channels: buildChannels(movies || [], eps || []) };
      chanCache.set(key, c);
    }
    const at = Number(req.query.at) || Math.floor(Date.now() / 1000);
    const from = Number(req.query.from) || at;
    const to = Number(req.query.to) || at + 90 * 60;
    return {
      channels: c.channels.map((ch) => ({
        number: ch.number, name: ch.name, sub: ch.sub,
        programmes: programmes(ch, Math.min(from, at), Math.max(to, at + 1), at)
      }))
    };
  });
}

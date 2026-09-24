// Is the internet up? One answer for the whole server.
//
// Every outbound call used to find out for itself, one timeout at a time. With
// the WAN down that meant a detail page waited on TMDB for its cast, the
// enrichment pass logged "no match" for every title in the library (and in two
// places wrote that down as a permanent answer), and the art route tried TMDB
// again for every missing poster on every screen.
//
// Now a failed call marks the internet down, and while it is down calls to the
// outside fail at once instead of waiting. A cheap probe notices when it comes
// back, and whoever cares (the enrichment runner) is told on that edge.

const PROBE_URL = 'https://api.themoviedb.org/3/configuration';
const PROBE_EVERY_UP = 5 * 60e3;   // confirm now and then that it is still up
const PROBE_EVERY_DOWN = 60e3;     // and look for it coming back more often
const DEFAULT_TIMEOUT = 10e3;

let up = true;            // optimistic until something says otherwise
let changedAt = Date.now();
let timer = null;
const listeners = new Set();

export class OfflineError extends Error {
  constructor(msg = 'no internet connection') { super(msg); this.name = 'OfflineError'; this.offline = true; }
}

export function isOnline() { return up; }
export function status() { return { internet: up, since: changedAt }; }

/** Called with `true` when the internet comes back, `false` when it goes. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function set(next) {
  if (next === up) return;
  up = next;
  changedAt = Date.now();
  console.log(up ? '[net] internet is back' : '[net] internet unreachable; outside calls paused until it returns');
  for (const fn of listeners) { try { fn(up); } catch { /* a listener's problem, not ours */ } }
  schedule();
}

// A network-level failure (DNS, refused, reset, timeout) — not an HTTP status.
// An HTTP error of any kind means the far end answered, so the internet is up.
function isNetworkError(e) {
  return !!e && (e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError'
    || /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(String(e.message || '') + String(e.cause && e.cause.code || '')));
}

/**
 * fetch() for anything on the internet. Throws OfflineError at once while the
 * internet is known to be down, and on a network failure marks it down and
 * throws OfflineError. HTTP errors come back as ordinary responses.
 */
export async function netFetch(url, opts = {}) {
  if (!up) throw new OfflineError();
  const { timeout = DEFAULT_TIMEOUT, ...rest } = opts;
  try {
    const res = await fetch(url, { ...rest, signal: rest.signal || AbortSignal.timeout(timeout) });
    return res;
  } catch (e) {
    if (isNetworkError(e)) { set(false); throw new OfflineError(); }
    throw e;
  }
}

export async function probe() {
  try {
    // Any HTTP answer at all (TMDB says 401 without a key) proves the route out.
    await fetch(PROBE_URL, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    set(true);
  } catch (e) {
    if (isNetworkError(e)) set(false);
  }
  return up;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => { await probe(); schedule(); }, up ? PROBE_EVERY_UP : PROBE_EVERY_DOWN);
  if (timer.unref) timer.unref();
}

/** Start watching. Probes once straight away so the first answer is real. */
export function startWatching() {
  probe().finally(schedule);
}

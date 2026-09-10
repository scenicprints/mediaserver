// Tell Radarr and Sonarr where the library went.
//
// They keep their own copy of every path. Move the files underneath them and
// they do not notice; they notice later, all at once, when a scheduled disk
// scan finds 246 series with no files and starts re-downloading a library that
// is sitting right there on the new drive.
//
// The one rule that matters here is moveFiles: false. Both APIs will happily
// move the files themselves when a root folder changes — that is what the flag
// is for — and by the time this runs the files have ALREADY moved. Asking them
// to move again means asking them to move files that are not where they think
// they are, and Radarr's response to "the file is not where I expected" has
// historically been to forget it. The files are ours to move; the paths are
// theirs to update. This module only ever does the second.
//
// Split into plan and apply for the same reason as the file migration: the plan
// is read-only and can be looked at, and nothing is written until someone has.
import fs from 'node:fs';

// The same six-to-three mapping the files follow. Longest prefix wins.
export const ARR_MAP = [
  ['E:\\4k', 'P:\\4K Movies'],
  ['H:\\4k', 'P:\\4K Movies'],
  ['E:\\Movies', 'P:\\Movies'],
  ['H:\\Movies', 'P:\\Movies'],
  ['G:\\TV Shows', 'P:\\TV Shows'],
  ['F:\\', 'P:\\TV Shows']
];

const trimSlash = (p) => String(p || '').replace(/[\\/]+$/, '');

/** Where an arr's folder path lands in the pool, or null if no rule covers it. */
export function arrTarget(p, map = ARR_MAP) {
  const s = String(p || '');
  const ordered = [...map].sort((a, b) => trimSlash(b[0]).length - trimSlash(a[0]).length);
  for (const [from, to] of ordered) {
    const f = trimSlash(from);
    if (s.toLowerCase() === f.toLowerCase()) return trimSlash(to);
    if (s.toLowerCase().startsWith(f.toLowerCase() + '\\')) {
      return trimSlash(to) + '\\' + s.slice(f.length + 1);
    }
  }
  return null;
}

/** Minimal API client. Injectable so the tests never touch a real server. */
export function arrClient(cfg, { fetchImpl = fetch } = {}) {
  const base = String(cfg.url || '').replace(/\/$/, '');
  const call = async (method, ep, body) => {
    const res = await fetchImpl(base + ep, {
      method,
      headers: { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${method} ${ep} -> ${res.status} ${res.statusText || ''}`.trim());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (ep) => call('GET', ep),
    put: (ep, body) => call('PUT', ep, body),
    post: (ep, body) => call('POST', ep, body),
    del: (ep) => call('DELETE', ep)
  };
}

const KINDS = {
  radarr: { list: '/api/v3/movie', editor: '/api/v3/movie/editor', idsKey: 'movieIds', label: 'movie' },
  sonarr: { list: '/api/v3/series', editor: '/api/v3/series/editor', idsKey: 'seriesIds', label: 'series' }
};

/**
 * Work out what each arr's paths should become. Reads only.
 *
 * Returns { groups, problems }. `groups` is one entry per destination root,
 * carrying the ids to move there. `problems` is anything that makes the whole
 * rewrite unsafe — it is not a warning list, it is a refusal.
 */
export async function planArr(kind, cfg, { map = ARR_MAP, fetchImpl = fetch, checkDisk = true } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown service: ${kind}`);
  const api = arrClient(cfg, { fetchImpl });
  const items = await api.get(k.list);

  const problems = [];
  const groups = new Map();
  const claimed = new Map();
  const unmapped = [];

  for (const it of items) {
    const to = arrTarget(it.path, map);
    if (!to) { unmapped.push(it.path); continue; }

    // Two records landing on one folder is the same failure as two files
    // landing on one name, and it is worse here: the arr would manage both
    // records against one directory and one of them would start deleting the
    // other's episodes as "unwanted".
    const prior = claimed.get(to.toLowerCase());
    if (prior) problems.push(`two ${k.label} records both want ${to}: "${prior}" and "${it.path}"`);
    claimed.set(to.toLowerCase(), it.path);

    // Which pool root this record now belongs to.
    const root = trimSlash([...map].sort((a, b) => trimSlash(b[0]).length - trimSlash(a[0]).length)
      .find(([from]) => it.path.toLowerCase().startsWith(trimSlash(from).toLowerCase()))[1]);
    if (!groups.has(root)) groups.set(root, { root, ids: [], from: [] });
    groups.get(root).ids.push(it.id);
    groups.get(root).from.push({ id: it.id, path: it.path, to });
  }

  if (unmapped.length) {
    problems.push(`${unmapped.length} ${k.label} record(s) are outside every known root — the mapping is incomplete`);
    unmapped.slice(0, 10).forEach((p) => problems.push(`  unmapped: ${p}`));
  }

  // The folders have to be there before the arr is pointed at them. Repointing
  // a library at paths that do not exist yet is how you get 246 series marked
  // as missing and a queue full of re-downloads.
  if (checkDisk) {
    for (const g of groups.values()) {
      if (!fs.existsSync(g.root)) problems.push(`${g.root} does not exist yet — move the files first`);
    }
  }

  return { kind, groups: [...groups.values()], problems, total: items.length };
}

/**
 * Apply a plan. Refuses outright if the plan found anything wrong.
 *
 * Root folders are added before the records move and old ones removed after,
 * because an arr with no valid root folder for a record will not save it.
 */
export async function applyArr(kind, cfg, plan, { fetchImpl = fetch, dryRun = true, log = () => {} } = {}) {
  const k = KINDS[kind];
  if (plan.problems.length) {
    throw new Error(`refusing to rewrite ${kind}: ${plan.problems.length} problem(s)\n  ` + plan.problems.join('\n  '));
  }
  const api = arrClient(cfg, { fetchImpl });
  const done = { addedRoots: [], moved: [], removedRoots: [], dryRun };

  const existingRoots = await api.get('/api/v3/rootfolder');
  const have = new Set(existingRoots.map((r) => trimSlash(r.path).toLowerCase()));

  for (const g of plan.groups) {
    if (!have.has(trimSlash(g.root).toLowerCase())) {
      log(`add root folder ${g.root}`);
      if (!dryRun) await api.post('/api/v3/rootfolder', { path: g.root });
      done.addedRoots.push(g.root);
    }
  }

  for (const g of plan.groups) {
    log(`repoint ${g.ids.length} ${k.label} record(s) to ${g.root}`);
    if (!dryRun) {
      // moveFiles:false — see the note at the top of this file. The files are
      // already at the destination; this only updates where the arr looks.
      await api.put(k.editor, { [k.idsKey]: g.ids, rootFolderPath: g.root, moveFiles: false });
    }
    done.moved.push({ root: g.root, count: g.ids.length });
  }

  // Old roots go last, and only once nothing refers to them.
  const keep = new Set(plan.groups.map((g) => trimSlash(g.root).toLowerCase()));
  const after = dryRun ? [] : await api.get(k.list);
  for (const r of existingRoots) {
    if (keep.has(trimSlash(r.path).toLowerCase())) continue;
    const stillUsing = after.filter((it) => String(it.path).toLowerCase().startsWith(trimSlash(r.path).toLowerCase() + '\\'));
    if (!dryRun && stillUsing.length) {
      log(`keeping ${r.path} — ${stillUsing.length} record(s) still point into it`);
      continue;
    }
    log(`remove root folder ${r.path}`);
    if (!dryRun) await api.del(`/api/v3/rootfolder/${r.id}`);
    done.removedRoots.push(r.path);
  }

  return done;
}

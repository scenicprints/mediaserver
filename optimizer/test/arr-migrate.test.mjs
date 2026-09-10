// Can the Radarr/Sonarr rewrite make them re-download the library?
//
// That is the failure mode worth guarding. Radarr and Sonarr hold their own
// copy of every path; move the files underneath them and nothing happens until
// a scheduled scan finds 246 series with no files and starts fetching a library
// that is already on disk. Everything here is aimed at the three ways to cause
// that: pointing them at folders that do not exist, asking them to move files
// that have already moved, and letting two records share one folder.
//
// The API is stubbed. These tests must never touch the real servers, and a
// mistake in the stub is a failing test rather than 246 series pointed at a
// drive letter that is not mounted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planArr, applyArr, arrTarget } from '../arr-migrate.mjs';

const cfg = { url: 'http://127.0.0.1:7878', apiKey: 'test' };

// A stand-in arr that records what was asked of it.
function stubArr({ items = [], roots = [] } = {}) {
  const calls = [];
  let nextId = 100;
  const state = { items: structuredClone(items), roots: structuredClone(roots) };
  const fetchImpl = async (url, opts = {}) => {
    const ep = url.replace(cfg.url, '');
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, ep, body });

    const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data ?? null) });
    if (method === 'GET' && /\/(movie|series)$/.test(ep)) return reply(state.items);
    if (method === 'GET' && ep === '/api/v3/rootfolder') return reply(state.roots);
    if (method === 'POST' && ep === '/api/v3/rootfolder') {
      state.roots.push({ id: nextId++, path: body.path });
      return reply(state.roots.at(-1));
    }
    if (method === 'DELETE' && ep.startsWith('/api/v3/rootfolder/')) {
      const id = Number(ep.split('/').pop());
      state.roots = state.roots.filter((r) => r.id !== id);
      return reply(null);
    }
    if (method === 'PUT' && /editor$/.test(ep)) {
      const ids = new Set(body.movieIds || body.seriesIds || []);
      for (const it of state.items) {
        if (!ids.has(it.id)) continue;
        it.path = body.rootFolderPath + '\\' + it.path.split('\\').filter(Boolean).pop();
        it.rootFolderPath = body.rootFolderPath;
      }
      return reply(state.items.filter((i) => ids.has(i.id)));
    }
    return { ok: false, status: 404, statusText: 'no stub for ' + method + ' ' + ep, text: async () => '' };
  };
  return { fetchImpl, calls, state };
}

test('paths map into the pool the same way the files do', () => {
  assert.equal(arrTarget('F:\\Ahsoka'), 'P:\\TV Shows\\Ahsoka');
  assert.equal(arrTarget('G:\\TV Shows\\Andor'), 'P:\\TV Shows\\Andor');
  assert.equal(arrTarget('E:\\Movies\\Venom 3 (2024)'), 'P:\\Movies\\Venom 3 (2024)');
  assert.equal(arrTarget('H:\\4k\\Dune (2021)'), 'P:\\4K Movies\\Dune (2021)');
  assert.equal(arrTarget('E:\\4k'), 'P:\\4K Movies', 'a bare root maps to a bare root');
  assert.equal(arrTarget('Z:\\Somewhere\\Else'), null);
});

// H:\4k is inside H:\. Get this wrong and the 4K collection is filed as TV.
test('the more specific root wins', () => {
  assert.equal(arrTarget('H:\\4k\\Heat (1995)'), 'P:\\4K Movies\\Heat (1995)');
  assert.equal(arrTarget('H:\\Movies\\Heat (1995)'), 'P:\\Movies\\Heat (1995)');
});

test('it refuses to repoint at folders that do not exist yet', async () => {
  const { fetchImpl } = stubArr({ items: [{ id: 1, path: 'F:\\Ahsoka' }], roots: [{ id: 1, path: 'F:\\' }] });
  const plan = await planArr('sonarr', cfg, { fetchImpl });   // checkDisk defaults on; P:\ is not there
  assert.ok(plan.problems.length, 'a missing pool must be a problem, not a warning');
  assert.match(plan.problems.join('\n'), /does not exist yet/);
  await assert.rejects(() => applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: false }), /refusing to rewrite/);
});

// Two series records managing one directory: each one treats the other's
// episodes as unwanted files and deletes them.
test('two records wanting one folder is refused', async () => {
  const { fetchImpl } = stubArr({
    items: [{ id: 1, path: 'F:\\Rick and Morty' }, { id: 2, path: 'G:\\TV Shows\\Rick and Morty' }],
    roots: [{ id: 1, path: 'F:\\' }, { id: 3, path: 'G:\\TV Shows' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  assert.match(plan.problems.join('\n'), /both want P:\\TV Shows\\Rick and Morty/);
  await assert.rejects(() => applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: false }));
});

test('a record outside every known root stops the whole rewrite', async () => {
  const { fetchImpl } = stubArr({
    items: [{ id: 1, path: 'F:\\Ahsoka' }, { id: 2, path: 'D:\\Elsewhere\\Show' }],
    roots: [{ id: 1, path: 'F:\\' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  assert.match(plan.problems.join('\n'), /outside every known root/);
});

// The single most important assertion in this file.
test('it never asks the arr to move files', async () => {
  const { fetchImpl, calls } = stubArr({
    items: [{ id: 1, path: 'F:\\Ahsoka' }, { id: 2, path: 'G:\\TV Shows\\Andor' }],
    roots: [{ id: 1, path: 'F:\\' }, { id: 3, path: 'G:\\TV Shows' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  assert.deepEqual(plan.problems, []);
  await applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: false });

  const edits = calls.filter((c) => /editor$/.test(c.ep));
  assert.ok(edits.length, 'something must actually have been repointed');
  for (const e of edits) {
    assert.equal(e.body.moveFiles, false, 'moveFiles MUST be false — the files have already moved');
  }
});

test('both roots collapse into one and the records follow', async () => {
  const { fetchImpl, calls, state } = stubArr({
    items: [
      { id: 1, path: 'F:\\Ahsoka' },
      { id: 2, path: 'F:\\Andor' },
      { id: 3, path: 'G:\\TV Shows\\Bluey' }
    ],
    roots: [{ id: 1, path: 'F:\\' }, { id: 3, path: 'G:\\TV Shows' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  assert.equal(plan.groups.length, 1, 'F: and G: both land in P:\\TV Shows');
  assert.equal(plan.groups[0].ids.length, 3);

  const out = await applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: false });
  assert.deepEqual(out.addedRoots, ['P:\\TV Shows']);
  assert.deepEqual(state.items.map((i) => i.path).sort(), [
    'P:\\TV Shows\\Ahsoka', 'P:\\TV Shows\\Andor', 'P:\\TV Shows\\Bluey'
  ]);
  // The new root must be created before anything is pointed at it.
  const addIdx = calls.findIndex((c) => c.method === 'POST' && c.ep === '/api/v3/rootfolder');
  const editIdx = calls.findIndex((c) => /editor$/.test(c.ep));
  assert.ok(addIdx >= 0 && addIdx < editIdx, 'root folder added before the records move');
  assert.deepEqual(state.roots.map((r) => r.path), ['P:\\TV Shows']);
});

// Radarr keeps 4K and standard in separate roots on purpose. Collapsing them
// would silently merge two quality profiles' worth of library.
test('movies keep their 4K and standard roots apart', async () => {
  const { fetchImpl, state } = stubArr({
    items: [
      { id: 1, path: 'E:\\Movies\\Venom 3 (2024)' },
      { id: 2, path: 'H:\\4k\\Dune (2021)' },
      { id: 3, path: 'E:\\4k\\Heat (1995)' }
    ],
    roots: [{ id: 9, path: 'E:\\Movies' }, { id: 7, path: 'H:\\4k' }, { id: 10, path: 'E:\\4k' }]
  });
  const plan = await planArr('radarr', cfg, { fetchImpl, checkDisk: false });
  assert.equal(plan.groups.length, 2, 'two destinations, not one');
  await applyArr('radarr', cfg, plan, { fetchImpl, dryRun: false });
  assert.deepEqual(state.items.map((i) => i.path).sort(), [
    'P:\\4K Movies\\Dune (2021)', 'P:\\4K Movies\\Heat (1995)', 'P:\\Movies\\Venom 3 (2024)'
  ]);
});

test('a dry run changes nothing', async () => {
  const { fetchImpl, calls, state } = stubArr({
    items: [{ id: 1, path: 'F:\\Ahsoka' }],
    roots: [{ id: 1, path: 'F:\\' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  await applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: true });
  assert.equal(state.items[0].path, 'F:\\Ahsoka');
  assert.deepEqual(state.roots.map((r) => r.path), ['F:\\']);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'a dry run issues no writes at all');
});

// An old root that something still points into must survive, or those records
// lose their root folder and the arr stops managing them.
test('an old root still in use is not removed', async () => {
  const { fetchImpl, state } = stubArr({
    items: [{ id: 1, path: 'F:\\Ahsoka' }, { id: 2, path: 'F:\\Andor' }],
    roots: [{ id: 1, path: 'F:\\' }]
  });
  const plan = await planArr('sonarr', cfg, { fetchImpl, checkDisk: false });
  // Only repoint one of them, as a partial run would.
  plan.groups[0].ids = [1];
  plan.groups[0].from = plan.groups[0].from.filter((f) => f.id === 1);
  await applyArr('sonarr', cfg, plan, { fetchImpl, dryRun: false });
  assert.ok(state.roots.some((r) => r.path === 'F:\\'), 'F:\\ still holds Andor, so it stays');
});

// Against the real mapping, with the pool actually present.
test('the real six-to-three mapping produces three destinations', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arrmap-'));
  const map = [
    ['E:\\4k', path.join(tmp, '4K Movies')],
    ['H:\\4k', path.join(tmp, '4K Movies')],
    ['E:\\Movies', path.join(tmp, 'Movies')],
    ['H:\\Movies', path.join(tmp, 'Movies')],
    ['G:\\TV Shows', path.join(tmp, 'TV Shows')],
    ['F:\\', path.join(tmp, 'TV Shows')]
  ];
  for (const [, to] of map) fs.mkdirSync(to, { recursive: true });

  const { fetchImpl } = stubArr({
    items: [
      { id: 1, path: 'E:\\4k\\A' }, { id: 2, path: 'H:\\4k\\B' },
      { id: 3, path: 'E:\\Movies\\C' }, { id: 4, path: 'H:\\Movies\\D' },
      { id: 5, path: 'G:\\TV Shows\\E' }, { id: 6, path: 'F:\\F' }
    ],
    roots: []
  });
  const plan = await planArr('radarr', cfg, { fetchImpl, map });
  assert.deepEqual(plan.problems, [], 'a complete mapping onto real folders has no problems');
  assert.equal(plan.groups.length, 3);
  assert.equal(plan.groups.reduce((n, g) => n + g.ids.length, 0), 6);
  fs.rmSync(tmp, { recursive: true, force: true });
});

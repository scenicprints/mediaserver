// Moving the library into the pool: can it lose or overwrite anything?
//
// This step renames 8,660 files into their own drive's PoolPart folder. A rename
// within one volume cannot half-succeed, so there is no torn-copy risk — the
// dangers are different ones:
//
//   * two files claiming one name in the pool view, which merges two drives'
//     worth of identically-named files into one folder
//   * a file distinguished from another ONLY by letter case. H:\4k holds two
//     byte-identical Spider-Man copies differing by one capital, and the first
//     version of the override table lowercased its keys, so a dry run dropped
//     BOTH and lost the film. That is the bug these tests exist for.
//   * the library repointed to a pool path that does not resolve
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { categoryOf, poolPartOf, containerOf, planPoolMove, DROP_EXACT, OVERRIDES } from '../poolmove.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poolmove-'));
let n = 0;

function db(rows) {
  const d = new DatabaseSync(path.join(root, `t${++n}.db`));
  d.exec(`
    CREATE TABLE media_info (file_kind TEXT, file_id INTEGER, path TEXT, size INTEGER);
    CREATE TABLE movie_files (id INTEGER PRIMARY KEY, path TEXT, filename TEXT);
    CREATE TABLE episode_files (id INTEGER PRIMARY KEY, path TEXT, filename TEXT);
  `);
  const ins = d.prepare('INSERT INTO media_info VALUES (?,?,?,?)');
  rows.forEach((r, i) => ins.run(r.kind || 'movie', r.id ?? i + 1, r.path, r.size ?? 1024));
  return d;
}

// The six-to-three mapping has overlapping prefixes: H:\4k sits inside H:\.
test('the more specific root decides the category', () => {
  const at = (p) => { const h = categoryOf(p); return h && { cat: h.cat, rest: h.rest }; };
  assert.deepEqual(at('E:\\4k\\Dune (2021).mkv'), { cat: '4K Movies', rest: 'Dune (2021).mkv' });
  assert.deepEqual(at('H:\\Movies\\Dune (2021).mkv'), { cat: 'Movies', rest: 'Dune (2021).mkv' });
  assert.deepEqual(at('F:\\Ahsoka\\01\\ep.mkv'), { cat: 'TV Shows', rest: 'Ahsoka\\01\\ep.mkv' });
  assert.equal(categoryOf('G:\\TV Shows\\x.mkv'), null, 'G: is not a pool member and must not map');
  assert.equal(categoryOf('Z:\\Somewhere\\x.mkv'), null);
  // H:\4k is inside H:\, so the longer root has to win or the 4K collection
  // would be filed as TV.
  assert.equal(categoryOf('H:\\4k\\Heat (1995).mkv').cat, '4K Movies');
});

// The pool part sits beside the source roots, so it is found from the root's
// parent - not from the first two characters of the path.
test('the pool-part container is the root parent', () => {
  assert.equal(containerOf('E:\\4k'), 'E:\\');
  assert.equal(containerOf('H:\\Movies'), 'H:\\');
  assert.equal(containerOf('F:\\'), 'F:\\');
  assert.equal(containerOf('F:'), 'F:\\');
  assert.equal(containerOf(path.join('C:', 'tmp', 'drvX', '4k')), path.join('C:', 'tmp', 'drvX'));
});

// THE BUG. Two names differing only in case must be told apart.
test('a path differing only in letter case is matched exactly, not lowercased', () => {
  const keep = 'H:\\4k\\Spider-Man Far From Home (2019).mkv';   // capital F
  const drop = 'H:\\4k\\Spider-Man Far from Home (2019).mkv';   // lowercase f
  assert.ok(DROP_EXACT.has(drop), 'the duplicate must be listed');
  assert.ok(!DROP_EXACT.has(keep), 'the one to keep must NOT be listed');
  assert.notEqual(keep, drop);
  // And the lowercased forms collide, which is exactly why a lowercased key
  // could never have separated them.
  assert.equal(keep.toLowerCase(), drop.toLowerCase());
});

test('the override table never drops a film outright', () => {
  // Every `drop` must name a surviving copy in its reason, or it is a deletion
  // dressed up as a migration decision.
  for (const [p, o] of Object.entries(OVERRIDES)) {
    if (!o.drop) continue;
    assert.match(o.why, /exists?/i, `${p} is dropped without saying what survives`);
  }
});

test('a drive with no PoolPart folder is not a pool member', () => {
  const d = path.join(root, 'nopart');
  fs.mkdirSync(d, { recursive: true });
  assert.equal(poolPartOf(d), null);
});

test('the newest PoolPart wins when a drive carries an abandoned one', () => {
  const d = path.join(root, 'two');
  fs.mkdirSync(path.join(d, 'PoolPart.old'), { recursive: true });
  // Creation time ordering is what distinguishes a live part from a leftover;
  // F: really does carry a 2020 one alongside the current one.
  const t = Date.now();
  while (Date.now() - t < 30) { /* ensure a distinct birthtime */ }
  fs.mkdirSync(path.join(d, 'PoolPart.new'), { recursive: true });
  const got = poolPartOf(d);
  assert.ok(got && got.endsWith('PoolPart.new'), `picked ${got}`);
});

// Two drives holding the same filename in the same category is the whole reason
// the plan asserts before it moves.
test('two drives claiming one pool path is caught as a collision', () => {
  const drives = ['X', 'Y'].map((L) => {
    const d = path.join(root, 'drv' + L);
    fs.mkdirSync(path.join(d, 'PoolPart.aaa', '4K Movies'), { recursive: true });
    return d;
  });
  const map = [[path.join(drives[0], '4k'), '4K Movies'], [path.join(drives[1], '4k'), '4K Movies']];
  for (const d of drives) fs.mkdirSync(path.join(d, '4k'), { recursive: true });
  const same = 'Heat (1995).mkv';
  for (const d of drives) fs.writeFileSync(path.join(d, '4k', same), Buffer.alloc(16));

  const plan = planPoolMove(db([
    { id: 1, path: path.join(drives[0], '4k', same) },
    { id: 2, path: path.join(drives[1], '4k', same) }
  ]), { map });

  assert.equal(plan.moves.length, 2, 'both are planned');
  assert.ok(plan.stats.overwrites > 0, 'and the clash in the pool view must be reported');
});

test('a renamed file keeps its folder and only changes its name', () => {
  const d = path.join(root, 'ren');
  fs.mkdirSync(path.join(d, 'PoolPart.bbb'), { recursive: true });
  fs.mkdirSync(path.join(d, '4k'), { recursive: true });
  const map = [[path.join(d, '4k'), '4K Movies']];
  const plan = planPoolMove(db([{ id: 1, path: path.join(d, '4k', 'Ordinary (2000).mkv') }]), { map });
  assert.equal(plan.moves.length, 1);
  const m = plan.moves[0];
  assert.equal(path.basename(m.pool), 'Ordinary (2000).mkv');
  assert.ok(m.pool.startsWith('P:\\4K Movies'), m.pool);
  assert.ok(m.physical.includes('PoolPart.bbb'), m.physical);
  assert.equal(m.renamed, false);
});

// The physical destination and the pool path must agree, or the library ends up
// pointing somewhere the file is not.
test('physical and pool destinations describe the same file', () => {
  const d = path.join(root, 'agree');
  fs.mkdirSync(path.join(d, 'PoolPart.ccc'), { recursive: true });
  fs.mkdirSync(path.join(d, 'Movies', 'Sub'), { recursive: true });
  const map = [[path.join(d, 'Movies'), 'Movies']];
  const plan = planPoolMove(db([{ id: 1, path: path.join(d, 'Movies', 'Sub', 'f.mkv') }]), { map });
  const m = plan.moves[0];
  // Same category and same tail on both sides.
  assert.ok(m.physical.includes(path.join('Movies', 'Sub', 'f.mkv')), m.physical);
  assert.ok(m.pool.endsWith(path.join('Movies', 'Sub', 'f.mkv')), m.pool);
});

test('files outside every mapped root are reported, never moved', () => {
  const d = path.join(root, 'outside');
  fs.mkdirSync(path.join(d, 'PoolPart.ddd'), { recursive: true });
  const plan = planPoolMove(db([{ id: 1, path: path.join(d, 'Elsewhere', 'x.mkv') }]), { map: [[path.join(d, 'Movies'), 'Movies']] });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unmapped.length, 1);
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

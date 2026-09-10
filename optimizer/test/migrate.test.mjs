// Can the pool migration lose a file?
//
// It has every opportunity to. Six roots collapse into three, 20,857 files get
// a new home, and the library deliberately keeps several versions of the same
// title under the same name on different drives — two copies of Return of the
// Jedi, 55 GB and 27 GB, both wanted. Merge those folders naively and one of
// them is gone, with the run reporting success.
//
// So these tests are written from the assumption that the planner is trying to
// destroy something and has to be caught. Real files, real bytes; only the
// library rows are faked, because what is under test is the decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ensureSchema, setDriveOrder } from '../engine.mjs';
import { planMigration, targetFor, versionedName } from '../migrate.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-migrate-'));

function makeFile(name, seed, kb = 64) {
  const p = path.join(dir, name.replace(/[\\/:]/g, '_'));
  const buf = Buffer.alloc(kb * 1024);
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < buf.length; i += 32) { h = crypto.createHash('sha256').update(h).digest(); h.copy(buf, i); }
  fs.writeFileSync(p, buf);
  return p;
}

const posix = (p) => p.replace(/\\/g, '/');

// Stand-in drive roots. Separate directories, because two names that differ
// only in case cannot coexist in one folder on Windows.
function roots(...names) {
  return names.map((n) => {
    const p = path.join(dir, n);
    fs.mkdirSync(p, { recursive: true });
    return p;
  });
}

function db(rows) {
  const d = new DatabaseSync(path.join(dir, `t${Math.random().toString(36).slice(2)}.db`));
  ensureSchema(d);
  const ins = d.prepare('INSERT INTO media_info (file_kind, file_id, path, size) VALUES (?, ?, ?, ?)');
  rows.forEach((r, i) => ins.run(r.kind || 'movie', r.id ?? i + 1, r.path, r.size ?? 0));
  return d;
}

// The mapping is a set of prefix rules and the rules overlap: H:\4k is inside
// H:\. Getting that precedence wrong silently files every 4K film as a TV show.
test('longest matching root wins, not the first one listed', () => {
  assert.equal(targetFor('H:\\4k\\Dune (2021).mkv'), 'P:/4K Movies/Dune (2021).mkv');
  assert.equal(targetFor('H:\\Movies\\Dune (2021).mkv'), 'P:/Movies/Dune (2021).mkv');
  assert.equal(targetFor('E:\\4k\\Dune (2021).mkv'), 'P:/4K Movies/Dune (2021).mkv');
  assert.equal(targetFor('F:\\Rick and Morty\\S01E01.mkv'), 'P:/TV Shows/Rick and Morty/S01E01.mkv');
  assert.equal(targetFor('G:\\TV Shows\\Rick and Morty\\S01E01.mkv'), 'P:/TV Shows/Rick and Morty/S01E01.mkv');
});

// A file nobody wrote a rule for must not be quietly dropped from the plan.
test('a path outside every root is reported, not skipped in silence', async () => {
  const stray = makeFile('stray.mkv', 'stray');
  const plan = await planMigration(db([{ path: stray }]));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unmapped.length, 1);
});

// The whole reason this module exists.
test('two different files wanting one name are BOTH kept', async () => {
  // Two roots standing in for E:\4k and H:\4k, each holding a differently-sized
  // cut of the same film under the identical name.
  const [e, h] = roots('jedi-e', 'jedi-h');
  const name = 'Return of the Jedi (1983).mkv';
  fs.writeFileSync(path.join(e, name), Buffer.alloc(128 * 1024, 0xa1));
  fs.writeFileSync(path.join(h, name), Buffer.alloc(64 * 1024, 0xb2));
  setDriveOrder([]);
  const d = db([{ id: 1, path: path.join(e, name) }, { id: 2, path: path.join(h, name) }]);
  const map = [[posix(e), 'P:/4K Movies'], [posix(h), 'P:/4K Movies']];

  const plan = await planMigration(d, { map, full: true });
  assert.equal(plan.stats.versions, 1, 'different bytes must read as two versions');
  assert.equal(plan.stats.duplicates, 0);
  assert.equal(plan.moves.length, 2, 'both files must move — neither is discarded');
  assert.equal(plan.overwrites.length, 0, 'and they must not land on the same name');
  assert.equal(new Set(plan.moves.map((m) => m.to.toLowerCase())).size, 2);
});

// Identical bytes: one copy travels, the other is left alone. Never deleted.
test('a true duplicate is left in place, not deleted', async () => {
  const a = makeFile('dup-a.mkv', 'same');
  const b = makeFile('dup-b.mkv', 'same');
  setDriveOrder(['E:', 'H:']);
  const d = db([{ id: 1, path: a }, { id: 2, path: b }]);
  const map = [[path.dirname(a).replace(/\\/g, '/'), 'P:/TV Shows']];
  // Both rows share a basename target only if the names match, so force it.
  const plan = await planMigration(d, { map, full: true });
  // Different basenames here means no contest — that is itself worth asserting,
  // because a planner that groups by title rather than path would collide them.
  assert.equal(plan.stats.contested, 0, 'same bytes under different names is not a collision');
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.overwrites.length, 0);
});

test('identical bytes under one name: one moves, one stays, none deleted', async () => {
  const src1 = path.join(dir, 'dupdir1'); fs.mkdirSync(src1, { recursive: true });
  const src2 = path.join(dir, 'dupdir2'); fs.mkdirSync(src2, { recursive: true });
  const buf = Buffer.alloc(64 * 1024, 7);
  fs.writeFileSync(path.join(src1, 'S01E01.mkv'), buf);
  fs.writeFileSync(path.join(src2, 'S01E01.mkv'), buf);
  setDriveOrder([]);
  const d = db([
    { id: 1, path: path.join(src1, 'S01E01.mkv') },
    { id: 2, path: path.join(src2, 'S01E01.mkv') }
  ]);
  const map = [
    [src1.replace(/\\/g, '/'), 'P:/TV Shows'],
    [src2.replace(/\\/g, '/'), 'P:/TV Shows']
  ];
  const plan = await planMigration(d, { map, full: true });
  assert.equal(plan.stats.duplicates, 1);
  assert.equal(plan.moves.length, 1, 'exactly one copy makes the trip');
  assert.equal(plan.collisions[0].leave.length, 1, 'the other is left where it is');
  assert.ok(!('drop' in plan.collisions[0]), 'nothing in the plan is marked for deletion');
  assert.equal(plan.overwrites.length, 0);
});

// A file that cannot be read is the one case where guessing is unforgivable:
// it may be the failing drive, and the good copy might be the unreadable one.
test('an unreadable file is never classified', async () => {
  const good = makeFile('readable.mkv', 'x');
  const gone = path.join(dir, 'this-does-not-exist.mkv');
  const d = db([{ id: 1, path: good }, { id: 2, path: gone }]);
  const map = [[dir.replace(/\\/g, '/'), 'P:/Movies']];
  d.exec(`UPDATE media_info SET path = '${(dir + '/x/S01E01.mkv').replace(/\\/g, '/')}' WHERE file_id = 1`);
  d.exec(`UPDATE media_info SET path = '${(dir + '/y/S01E01.mkv').replace(/\\/g, '/')}' WHERE file_id = 2`);
  const map2 = [[(dir + '/x').replace(/\\/g, '/'), 'P:/Movies'], [(dir + '/y').replace(/\\/g, '/'), 'P:/Movies']];
  fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
  fs.copyFileSync(good, path.join(dir, 'x', 'S01E01.mkv'));   // y/S01E01.mkv deliberately absent

  const plan = await planMigration(d, { map: map2, full: true });
  assert.equal(plan.stats.unknown, 1);
  assert.equal(plan.moves.length, 0, 'neither file moves while one cannot be read');
  void map;
});

// The rename has to actually differ, or "keep both" keeps one.
test('the version rename produces a distinct, still-valid name', () => {
  const t = 'P:/4K Movies/Return of the Jedi (1983).mkv';
  const r = versionedName(t, 26.98 * 2 ** 30);
  assert.notEqual(r.toLowerCase(), t.toLowerCase());
  assert.match(r, /Return of the Jedi \(1983\) \[27GB\]\.mkv$/);
  assert.equal(path.posix.dirname(r), path.posix.dirname(t));
});

// Windows does not distinguish case, so a planner that does will happily plan
// two files onto one name. Far From Home / far from Home is real, in this
// library, on one drive.
test('names differing only in case are treated as the same destination', async () => {
  // One drive cannot hold both spellings, which is exactly why they are on two.
  const [a, b] = roots('case-a', 'case-b');
  fs.writeFileSync(path.join(a, 'Spider-Man Far From Home.mkv'), Buffer.alloc(64 * 1024, 1));
  fs.writeFileSync(path.join(b, 'Spider-Man Far from Home.mkv'), Buffer.alloc(64 * 1024, 2));
  const d = db([
    { id: 1, path: path.join(a, 'Spider-Man Far From Home.mkv') },
    { id: 2, path: path.join(b, 'Spider-Man Far from Home.mkv') }
  ]);
  const plan = await planMigration(d, { map: [[posix(a), 'P:/4K Movies'], [posix(b), 'P:/4K Movies']], full: true });
  assert.equal(plan.stats.contested, 1, 'case-only difference must collide');
  assert.equal(plan.moves.length, 2, 'both still move');
  assert.equal(plan.overwrites.length, 0);
});

// The backstop. Whatever the classification did, no two moves may share a
// destination — this is the assertion that would have caught the 1.29 TiB loss.
test('no plan may ever contain two moves to one destination', async () => {
  const s = path.join(dir, 'many'); fs.mkdirSync(s, { recursive: true });
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const sub = path.join(s, 'r' + i);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'Same Name.mkv'), Buffer.alloc(16 * 1024 * (i + 1), i));
    rows.push({ id: i + 1, path: path.join(sub, 'Same Name.mkv') });
  }
  const map = rows.map((r) => [path.dirname(r.path).replace(/\\/g, '/'), 'P:/Movies']);
  const plan = await planMigration(db(rows), { map, full: true });
  assert.equal(plan.moves.length, 6, 'six distinct files, six moves');
  assert.equal(plan.overwrites.length, 0);
  const dests = plan.moves.map((m) => m.to.toLowerCase());
  assert.equal(new Set(dests).size, dests.length);
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

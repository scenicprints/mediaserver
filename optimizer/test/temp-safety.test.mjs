// Can the program delete the only copy of a film?
//
// It could, and it came within one job of doing it. The add-audio path deleted
// the source and then renamed its finished temp file into place — and on
// Windows a delete on a file another process holds open does not remove the
// name, it marks it for deletion, so the rename fails EBUSY. Nine 4K films,
// 188 GiB, ended up with their sources gone and the real data sitting under
// temp names.
//
// And then the temp sweeper — which runs at the start of every storage job and
// deletes anything carrying the temp suffix — would have found all nine.
// Recovery was possible only because the optimizer happened not to pick another
// job in that folder first.
//
// These tests are about that: a temp file is litter only while the thing it was
// made from still exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sweepTempFiles, originalOf } from '../engine.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tempsafe-'));
let n = 0;
const dir = () => { const d = path.join(root, 'd' + ++n); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (p, bytes = 2048) => { fs.writeFileSync(p, Buffer.alloc(bytes, 7)); return p; };

// The name a temp file was made from has to be recoverable from the temp name,
// or the sweeper cannot tell litter from the last copy of something.
test('the original name is derivable from a temp name', () => {
  assert.equal(
    originalOf('H:\\4k\\Ex Machina (2015).marquee-opt.tmp.8028.mtwnwqh6.mkv'),
    path.join('H:\\4k', 'Ex Machina (2015).mkv'));
  assert.equal(
    originalOf('F:\\Show\\01\\Ep - 1x01.marquee-opt.tmp.123.abc.mkv'),
    path.join('F:\\Show\\01', 'Ep - 1x01.mkv'));
  // A film whose own title contains dots must survive the round trip.
  assert.equal(
    originalOf('E:\\Movies\\W.E. (2011).marquee-opt.tmp.9.z.mkv'),
    path.join('E:\\Movies', 'W.E. (2011).mkv'));
  assert.equal(originalOf('H:\\4k\\Ordinary Film (2015).mkv'), null, 'not a temp name');
  assert.equal(originalOf(''), null);
});

// The sweeper's actual job, which must still work.
test('a temp file is swept when its original is still there', () => {
  const d = dir();
  write(path.join(d, 'Film (2020).mkv'));
  const tmp = write(path.join(d, 'Film (2020).marquee-opt.tmp.1.a.mkv'), 4096);
  const freed = sweepTempFiles(d);
  assert.ok(!fs.existsSync(tmp), 'leftover litter goes');
  assert.ok(fs.existsSync(path.join(d, 'Film (2020).mkv')), 'the original stays');
  assert.equal(freed, 4096);
});

// THE ONE THAT MATTERS. This is the nine films.
test('a temp file is KEPT when its original is gone — it is the only copy', () => {
  const d = dir();
  const tmp = write(path.join(d, 'Ex Machina (2015).marquee-opt.tmp.8028.x.mkv'), 8192);
  // No 'Ex Machina (2015).mkv' — the swap deleted it and the rename failed.
  const notes = [];
  const freed = sweepTempFiles(d, { log: (m) => notes.push(m) });
  assert.ok(fs.existsSync(tmp), 'THE ONLY COPY MUST SURVIVE THE SWEEP');
  assert.equal(freed, 0, 'and nothing may be counted as reclaimed');
  assert.match(notes.join('\n'), /only copy/i, 'and it must say why it kept it');
});

test('a folder of orphaned temps loses none of them', () => {
  const d = dir();
  const orphans = [];
  for (const name of ['Ad Astra (2019)', 'Terminator 2 (1991)', "Philosopher's Stone (2001)"]) {
    orphans.push(write(path.join(d, name + '.marquee-opt.tmp.8028.q.mkv'), 1024));
  }
  // One genuine piece of litter alongside them, which should still go.
  write(path.join(d, 'Something Else (2001).mkv'));
  const litter = write(path.join(d, 'Something Else (2001).marquee-opt.tmp.2.b.mkv'), 512);

  sweepTempFiles(d);
  for (const o of orphans) assert.ok(fs.existsSync(o), `${path.basename(o)} must survive`);
  assert.ok(!fs.existsSync(litter), 'real litter is still cleared');
});

// The sweeper is called on a directory that may hold anything.
test('nothing without the temp suffix is ever touched', () => {
  const d = dir();
  const keep = [
    write(path.join(d, 'Film (2020).mkv')),
    write(path.join(d, 'Film (2020).en.srt')),
    write(path.join(d, 'poster.jpg')),
    write(path.join(d, 'movie.nfo'))
  ];
  sweepTempFiles(d);
  for (const k of keep) assert.ok(fs.existsSync(k), `${path.basename(k)} must be left alone`);
});

test('an unreadable directory is not an error', () => {
  assert.equal(sweepTempFiles(path.join(root, 'no-such-dir')), 0);
});

// A ".replacing" file is the new swap's parked original. The sweeper must not
// confuse it for a temp, and must not remove it — it may be the only copy too.
test('a parked original is not mistaken for a temp file', () => {
  const d = dir();
  const parked = write(path.join(d, 'Film (2020).mkv.replacing'), 4096);
  sweepTempFiles(d);
  assert.ok(fs.existsSync(parked), 'a parked original is not litter');
  assert.equal(originalOf(parked), null);
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

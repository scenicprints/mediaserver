// Which files the optimizer can see, and why a NAS library used to be invisible.
//
// The old test was `path.slice(0, 2)` compared against a list of drive letters.
// For \\NAS\media\Movies\Film.mkv that is "\\", which is never a drive letter,
// so every file on a network share was filtered out — silently. The window
// showed "Files: 0", no job ever ran, and nothing said why. A library on a share
// is one of the ordinary ways to own a media server, so that is not an edge
// case; it is a whole class of user for whom the program did nothing at all.
//
// The property being protected at the same time is the original one: a volume
// that is NOT reachable — an unplugged USB disk, an offline share — must still
// exclude its files, so an absent drive is never mistaken for missing media.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { volumeKeyOf, volumeAvailable, mountedRoots } from '../engine.mjs';

const B = String.fromCharCode(92);

test('a drive letter is its own volume', () => {
  assert.equal(volumeKeyOf('P:' + B + 'Movies' + B + 'Film.mkv'), 'P:');
  assert.equal(volumeKeyOf('c:' + B + 'x.mkv'), 'C:', 'case is normalised');
});

test('a UNC path resolves to its SHARE, not just the server', () => {
  // Two shares on one box are mounted independently, so \\NAS alone is the
  // wrong granularity — one can be reachable while the other is not.
  assert.equal(volumeKeyOf(B + B + 'NAS' + B + 'media' + B + 'Movies' + B + 'Film.mkv'), B + B + 'NAS' + B + 'MEDIA');
  assert.equal(volumeKeyOf(B + B + 'nas' + B + 'media'), B + B + 'NAS' + B + 'MEDIA');
});

test('forward slashes are accepted, because databases contain both', () => {
  assert.equal(volumeKeyOf('//NAS/media/Movies/Film.mkv'), B + B + 'NAS' + B + 'MEDIA');
  assert.equal(volumeKeyOf('P:/Movies/Film.mkv'), 'P:');
});

test('something that is neither has no volume, and is therefore not scannable', () => {
  for (const junk of ['', null, undefined, 'relative/path.mkv', 'Film.mkv', B + 'rooted.mkv']) {
    assert.equal(volumeKeyOf(junk), null, JSON.stringify(junk));
    assert.equal(volumeAvailable(volumeKeyOf(junk)), false);
  }
});

test('a UNC server with no share named is not a volume', () => {
  assert.equal(volumeKeyOf(B + B + 'NAS'), null);
  assert.equal(volumeKeyOf(B + B), null);
});

test('an unreachable volume is unavailable, which is what protects an offline drive', () => {
  // A drive letter that is not mounted, and a share that does not exist.
  const free = [...'ZYXWVU'].map((c) => c + ':').find((d) => !mountedRoots().has(d));
  if (free) assert.equal(volumeAvailable(free), false, `${free} should not be mounted`);
  assert.equal(volumeAvailable(B + B + 'NO-SUCH-HOST-XYZZY' + B + 'share'), false);
});

test('a volume that is reachable is available', () => {
  const here = volumeKeyOf(path.resolve(os.tmpdir(), 'x'));
  assert.ok(here, 'the temp directory should have a volume');
  assert.equal(volumeAvailable(here), true);
});

test('the cache stats each volume once, not once per file', () => {
  // scannableFiles passes a shared Map; on a library of 20,000 files across six
  // volumes that is six stat calls rather than twenty thousand, and a stat on an
  // unreachable share is a timeout, not a no-op.
  const cache = new Map();
  const key = volumeKeyOf(path.resolve(os.tmpdir(), 'x'));
  assert.equal(volumeAvailable(key, cache), true);
  assert.equal(cache.size, 1);
  // Poison the cache: a second call must use it rather than ask the disk again.
  cache.set(key, false);
  assert.equal(volumeAvailable(key, cache), false, 'the cached answer should be used');
});

test('mountedRoots still reports drive letters only', () => {
  // It feeds drive-health reporting, which is about physical disks, so a share
  // has no business in it.
  for (const r of mountedRoots()) assert.match(r, /^[A-Z]:$/);
});

test('a real file on this machine is visible through the volume test', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vol-')), 'Film (1999).mkv');
  fs.writeFileSync(f, 'x');
  assert.equal(volumeAvailable(volumeKeyOf(f)), true, 'a file that exists must be scannable');
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

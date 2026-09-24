// The artwork cache is what keeps the library looking like itself with the WAN
// down, so the things worth pinning are: the outgoing rewrite catches every
// shape of URL, the path guard refuses anything that isn't a TMDB image path,
// and a torn fetch never leaves a half-written file where a poster should be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rewriteJson, originOf, relFor, artUrlsInDb, fetchOne } from '../src/artcache.js';

test('rewriteJson swaps every TMDB image URL for a local one', () => {
  const body = JSON.stringify({
    poster: 'https://image.tmdb.org/t/p/w500/abc.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/def.jpg',
    people: [{ profile: 'https://image.tmdb.org/t/p/w185/ghi.jpg' }]
  });
  const out = JSON.parse(rewriteJson(body, 'https://marqu33.duckdns.org'));
  assert.equal(out.poster, 'https://marqu33.duckdns.org/art/w500/abc.jpg');
  assert.equal(out.backdrop, 'https://marqu33.duckdns.org/art/w1280/def.jpg');
  assert.equal(out.people[0].profile, 'https://marqu33.duckdns.org/art/w185/ghi.jpg');
});

// The tvOS app calls URL(string:) with no base, so a root-relative path would
// parse into a hostless URL and blank every poster on the Apple TV. Absolute is
// not a nicety here.
test('rewriteJson produces absolute URLs, and follows the host the client used', () => {
  const body = JSON.stringify({ poster: 'https://image.tmdb.org/t/p/w500/abc.jpg' });
  assert.equal(JSON.parse(rewriteJson(body, 'http://192.168.1.103:8096')).poster,
    'http://192.168.1.103:8096/art/w500/abc.jpg');
  assert.equal(JSON.parse(rewriteJson(body, 'https://host//')).poster, 'https://host/art/w500/abc.jpg');
  // No host to work from: root-relative, which browsers still resolve.
  assert.equal(JSON.parse(rewriteJson(body, '')).poster, '/art/w500/abc.jpg');
});

test('originOf reads the scheme and host the request arrived on', () => {
  assert.equal(originOf({ protocol: 'https', headers: { host: 'marqu33.duckdns.org' } }), 'https://marqu33.duckdns.org');
  assert.equal(originOf({ protocol: 'http', headers: { host: '192.168.1.103:8096' } }), 'http://192.168.1.103:8096');
  assert.equal(originOf({ headers: {} }), '');
  assert.equal(originOf(undefined), '');
});

test('rewriteJson leaves unrelated bodies untouched', () => {
  const body = JSON.stringify({ title: 'Heat', url: 'https://api.themoviedb.org/3/movie/949' });
  assert.equal(rewriteJson(body, 'https://h'), body);
  assert.equal(rewriteJson(undefined, 'https://h'), undefined);
});

test('relFor only claims TMDB image URLs', () => {
  assert.equal(relFor('https://image.tmdb.org/t/p/w500/abc.jpg'), 'w500/abc.jpg');
  assert.equal(relFor('https://evil.example/t/p/w500/abc.jpg'), null);
  assert.equal(relFor(null), null);
});

test('fetchOne refuses traversal and junk paths without touching the network', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artcache-'));
  for (const bad of ['../../etc/passwd', 'w500/../../x.jpg', 'w500/abc.exe', 'abc.jpg', '']) {
    assert.equal(await fetchOne(dir, bad), false, `should refuse: ${bad}`);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('fetchOne is a no-op when the file is already cached', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artcache-'));
  await fsp.mkdir(path.join(dir, 'w500'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'w500', 'abc.jpg'), 'cached-bytes');
  // No fetch stub installed: if it tried the network this would throw or fail.
  assert.equal(await fetchOne(dir, 'w500/abc.jpg'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'w500', 'abc.jpg'), 'utf8'), 'cached-bytes');
});

test('fetchOne writes atomically and leaves no .part behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artcache-'));
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('JPEGDATA').buffer });
  try {
    assert.equal(await fetchOne(dir, 'w500/abc.jpg'), true);
  } finally { globalThis.fetch = real; }
  assert.equal(fs.readFileSync(path.join(dir, 'w500', 'abc.jpg'), 'utf8'), 'JPEGDATA');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'w500')), ['abc.jpg']);
});

test('a failed fetch caches nothing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artcache-'));
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    assert.equal(await fetchOne(dir, 'w500/abc.jpg'), false);
  } finally { globalThis.fetch = real; }
  assert.equal(fs.existsSync(path.join(dir, 'w500')), false);
});

test('artUrlsInDb collects and dedupes across all art columns', () => {
  const rows = {
    'SELECT poster, backdrop, collection_poster FROM movies': [
      { poster: 'https://image.tmdb.org/t/p/w500/a.jpg', backdrop: 'https://image.tmdb.org/t/p/w1280/b.jpg', collection_poster: null },
      { poster: 'https://image.tmdb.org/t/p/w500/a.jpg', backdrop: null, collection_poster: 'https://image.tmdb.org/t/p/w500/c.jpg' }
    ],
    'SELECT poster, backdrop FROM shows': [{ poster: 'https://image.tmdb.org/t/p/w500/d.jpg', backdrop: null }],
    'SELECT still FROM episodes': [{ still: 'https://image.tmdb.org/t/p/w300/e.jpg' }, { still: null }]
  };
  const db = { prepare: (sql) => ({ all: () => rows[sql] || [] }) };
  const got = artUrlsInDb(db).sort();
  assert.deepEqual(got, ['w1280/b.jpg', 'w300/e.jpg', 'w500/a.jpg', 'w500/c.jpg', 'w500/d.jpg']);
});

test('artUrlsInDb survives a table that is not there yet', () => {
  const db = { prepare: () => { throw new Error('no such table'); } };
  assert.deepEqual(artUrlsInDb(db), []);
});

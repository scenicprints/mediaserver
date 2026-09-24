// The internet switch decides whether every outside call waits or fails at
// once, and its "back online" edge is what restarts an interrupted enrichment.
// Both directions are worth pinning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netFetch, isOnline, probe, onChange, OfflineError } from '../src/online.js';

test('a network failure marks the internet down, and calls then fail at once', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(netFetch('https://api.themoviedb.org/3/x'), OfflineError);
    assert.equal(isOnline(), false);
    await assert.rejects(netFetch('https://api.themoviedb.org/3/y'), OfflineError);
    assert.equal(calls, 1, 'the second call must not touch the network');
  } finally { globalThis.fetch = real; }
});

test('an HTTP error is an answer, not an outage', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const seen = [];
  const off = onChange((up) => seen.push(up));
  try {
    await probe(); // comes back from the previous test's outage
    assert.equal(isOnline(), true);
    assert.deepEqual(seen, [true]);
    const res = await netFetch('https://api.themoviedb.org/3/z');
    assert.equal(res.status, 401);
    assert.equal(isOnline(), true);
  } finally { off(); globalThis.fetch = real; }
});

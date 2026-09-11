// Does looking for duplicates freeze the program?
//
// It did. fingerprint() was declared `async` but every read inside it was
// synchronous — openSync, readSync, closeSync — so `await` returned an
// already-settled promise and never yielded. Node runs one thread, so a
// synchronous 64 MB read off a USB disk stops EVERYTHING: the web server stops
// answering, the encoder stops advancing, the window goes blank. Scanning a few
// hundred candidates froze it for minutes and read to the owner as a crash.
//
// The hash was never the bug and a test on the hash would never have caught it.
// So these tests measure the thing that actually broke: whether the event loop
// keeps turning while the disk is being read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fingerprint } from '../duplicates.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'responsive-'));

// Big enough that reading it is real work rather than a single buffer.
function bigFile(name, mb, seed = 1) {
  const p = path.join(dir, name);
  const fd = fs.openSync(p, 'w');
  const chunk = Buffer.alloc(1 << 20, seed);
  for (let i = 0; i < mb; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return p;
}

/**
 * How many times the event loop turned while `work` ran.
 *
 * Deliberately NOT a measure of elapsed time. The first version of this test
 * timed the longest stall, and it was worthless: the temp file lands on NVMe
 * and stays in the page cache, so even the old synchronous implementation
 * finished in under a timer tick and the test passed. The same code on the USB
 * media drives froze the program for minutes.
 *
 * Turn count is a structural property instead, and it holds on any hardware.
 * Blocking code yields zero times whether the disk is fast or slow; code that
 * awaits real reads yields once per chunk.
 */
async function loopTurns(work) {
  let turns = 0, running = true;
  const tick = () => { if (running) { turns++; setImmediate(tick); } };
  setImmediate(tick);
  try { await work(); } finally { running = false; }
  return turns;
}

// The headline. A synchronous implementation scores 0 here, on any disk.
test('fingerprinting lets the event loop keep turning', async () => {
  const f = bigFile('big.bin', 160);
  const turns = await loopTurns(() => fingerprint(f));
  assert.ok(turns > 20, `event loop turned only ${turns} times during a fingerprint — the reads are blocking`);
});

test('a full hash of a large file also yields', async () => {
  const f = bigFile('full.bin', 200, 2);
  const turns = await loopTurns(() => fingerprint(f, { full: true }));
  assert.ok(turns > 20, `event loop turned only ${turns} times during a full hash`);
});

// What the owner actually experienced: the window stops answering. Prove an
// HTTP server keeps serving while a scan-sized amount of hashing happens.
test('an HTTP server keeps answering while files are being hashed', async () => {
  const files = [bigFile('a.bin', 80, 3), bigFile('b.bin', 80, 4), bigFile('c.bin', 80, 5)];
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let served = 0, slowest = 0;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      const t0 = Date.now();
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume();
          res.on('end', () => { served++; slowest = Math.max(slowest, Date.now() - t0); resolve(); });
        });
        req.on('error', resolve);
      });
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  for (const f of files) await fingerprint(f, { full: true });
  polling = false;
  await poll;
  server.close();

  assert.ok(served > 10, `server answered only ${served} times during hashing — it was frozen`);
  assert.ok(slowest < 500, `slowest response was ${slowest}ms while hashing`);
});

// Behaviour must be unchanged: same bytes in, same fingerprint out, and files
// that differ must still be told apart.
test('the fingerprint still identifies and distinguishes correctly', async () => {
  const a = bigFile('same1.bin', 8, 9);
  const b = bigFile('same2.bin', 8, 9);
  const c = bigFile('diff.bin', 8, 10);
  const [ha, hb, hc] = await Promise.all([fingerprint(a), fingerprint(b), fingerprint(c)]);
  assert.equal(ha, hb, 'identical files must hash the same');
  assert.notEqual(ha, hc, 'different files must not');
  // Under the 128 MB sampling threshold both paths read the whole file, so they
  // must agree — the buffer size is an implementation detail, not an input.
  assert.equal(await fingerprint(a, { full: true }), ha);
});

// Size is part of the fingerprint, so a truncated file can never match.
test('a truncated copy never matches the original', async () => {
  const a = bigFile('whole.bin', 6, 11);
  const b = path.join(dir, 'cut.bin');
  fs.writeFileSync(b, fs.readFileSync(a).subarray(0, (6 << 20) - 4096));
  assert.notEqual(await fingerprint(a), await fingerprint(b));
});

test('a file smaller than the read buffer still hashes', async () => {
  const p = path.join(dir, 'tiny.bin');
  fs.writeFileSync(p, Buffer.from('hello'));
  const h = await fingerprint(p);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await fingerprint(p, { full: true }));
});

test('an empty file hashes without hanging', async () => {
  const p = path.join(dir, 'empty.bin');
  fs.writeFileSync(p, Buffer.alloc(0));
  assert.match(await fingerprint(p), /^[0-9a-f]{64}$/);
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

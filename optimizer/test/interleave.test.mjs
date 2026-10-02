// The muxer's interleave buffer must stay bounded.
//
// `-max_interleave_delta 0` reads like "off" but means "no limit": libavformat
// queues packets until it has one for every stream, with no cap. Every job here
// copies video at disk speed while encoding an audio track in real time, so the
// video runs minutes ahead and all of it waits in RAM.
//
// On a 2-hour 4K file that reached ~6 GB. On 2026-09-24 this box (15.9 GB RAM)
// ran out of commit and qBittorrent, DrivePool's service, Explorer and Defender
// died together with 0xc00000fd. One job - The Incredible Hulk - retried four
// times over two days and never completed.
//
// Asserted against the source text because the commands are assembled inside
// the run path. A value of 0 anywhere is the specific regression to catch, so
// the test names it rather than just checking the constant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine.mjs'), 'utf8')
  .split('\r\n').join('\n');

test('the interleave limit is a positive number, never 0', () => {
  const m = SRC.match(/const MAX_INTERLEAVE = \['-max_interleave_delta',\s*'(\d+)'\]/);
  assert.ok(m, 'MAX_INTERLEAVE no longer exists in the form the builders use');
  const us = Number(m[1]);
  assert.ok(us > 0, '0 means UNLIMITED buffering, which is what exhausted memory');
  // Generous enough for real interleaving, small enough that the queue cannot
  // grow to gigabytes on a long file.
  assert.ok(us <= 10_000_000, `${us}us is over 10s of drift — too much to hold in RAM`);
});

test('no ffmpeg command sets max_interleave_delta to 0', () => {
  const offenders = SRC.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /max_interleave_delta/.test(line))
    .filter(({ line }) => /'0'|"0"|,\s*0\b/.test(line));
  assert.deepEqual(offenders.map((o) => `line ${o.n}: ${o.line}`), [],
    'these set an unlimited interleave buffer');
});

test('every command that copies video while encoding audio bounds the buffer', () => {
  const lines = SRC.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/'-map',\s*'0'/.test(line)) return;        // maps every input stream
    const window = lines.slice(i, i + 4).join(' '); // the args wrap across lines
    if (!/MAX_INTERLEAVE|max_interleave_delta/.test(window)) {
      offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [], 'these map every stream without bounding the muxer queue');
});

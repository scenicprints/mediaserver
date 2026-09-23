// Attachment streams must never be mapped into a job's output.
//
// ffmpeg 7.1.5's matroska muxer aborts part-way when an attachment is present
// and any track is being encoded ("Received a packet for an attachment stream"
// -> "Invalid argument" -> task finished with error -22). The Empire Strikes
// Back wrote 600 KB instead of 60 GB, and the half-written file then tripped two
// unrelated-looking alarms - "output is not larger" and "VIDEO BITSTREAM
// CHANGED" - so the cause looked like two bugs. Proven on the real file: with
// `-map 0` the mux fails; with `-map -0:t?` it completes.
//
// Checked against the source because the commands are built inside the run
// path; what matters is that no builder can quietly lose the exclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine.mjs'), 'utf8')
  .split('\r\n').join('\n');

test('every ffmpeg command that maps all streams also drops attachments', () => {
  const lines = SRC.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/'-map',\s*'0'/.test(line)) return;              // maps every input stream
    const window = lines.slice(i, i + 4).join(' ');        // the args may wrap
    if (!/DROP_ATTACHMENTS|'-0:t\?'/.test(window)) offenders.push(`line ${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], 'these map every stream without excluding attachments');
});

test('the exclusion is the flag ffmpeg actually needs', () => {
  const m = SRC.match(/const DROP_ATTACHMENTS = \[([^\]]*)\]/);
  assert.ok(m, 'DROP_ATTACHMENTS no longer exists');
  assert.match(m[1], /'-map'/);
  assert.match(m[1], /'-0:t\?'/, "must be -0:t? - '-c:t copy' was tried on the real file and did not work");
});

// Discovery against a real folder: what listSubtitles finds when the files are
// actually on disk, and what the player is handed for each one.
//
// The unit tests next door check the matcher and the converters in isolation.
// This one builds the folder the pool actually looks like — films, their
// sidecars in five formats, a VobSub pair, and the orphans that belong to
// nothing — and walks the whole path, readdir to WebVTT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubtitles, readSubtitleFile, sidecarToVtt } from '../src/subtitles.js';

const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Almost{\\i0} nothing, really
`;

const SMI = `<SAMI><BODY>
<SYNC Start=2000><P Class=ENUSCC>A line of SAMI
<SYNC Start=4000><P Class=ENUSCC>&nbsp;
</BODY></SAMI>
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-subs-'));
const MOVIES = path.join(dir, 'Movies');
fs.mkdirSync(MOVIES);

const write = (name, body) => fs.writeFileSync(path.join(MOVIES, name), body);

// The films.
for (const f of ['The English Patient (1996) 1080p BluRay.mkv',
  'Anger Management (2003).mkv',
  'Spirited Away (2001).mkv',
  'Inception (2010) 1080p BluRay x264-GRP.mkv']) write(f, '');

// Sidecars that belong to Spirited Away, one per format.
write('Spirited Away (2001).srt', '1\n00:00:01,000 --> 00:00:03,000\nA line of SubRip\n');
write('Spirited Away (2001).en.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA line of WebVTT\n');
write('Spirited Away (2001).ja.ass', ASS);
write('Spirited Away (2001).ko.smi', SMI);
// And its VobSub pair, which has no text in it to show.
write('Spirited Away (2001).idx', '# VobSub index file\ntimestamp: 00:00:01:000, filepos: 000000000\n');
write('Spirited Away (2001).sub', '\x00\x00\x01\xba');
// One that belongs to Inception under its clean name.
write('Inception (2010).srt', '1\n00:00:01,000 --> 00:00:03,000\nInception\n');

// The orphans: real files in the pool with no video of their own.
write('English.srt', '1\n00:00:01,000 --> 00:00:03,000\nOrphan\n');
write('5050 (2011).srt', '1\n00:00:01,000 --> 00:00:03,000\nOrphan\n');
write('Anger Managment (2003).srt', '1\n00:00:01,000 --> 00:00:03,000\nOrphan\n');

const film = (n) => path.join(MOVIES, n);
const names = (v) => listSubtitles(v).map((s) => path.basename(s.path)).sort();

test('every text format beside a film is found', () => {
  assert.deepEqual(names(film('Spirited Away (2001).mkv')), [
    'Spirited Away (2001).en.vtt',
    'Spirited Away (2001).ja.ass',
    'Spirited Away (2001).ko.smi',
    'Spirited Away (2001).srt'
  ]);
});

test('the VobSub pair is not offered as a track', () => {
  const found = names(film('Spirited Away (2001).mkv'));
  assert.ok(!found.some((f) => /\.(sub|idx)$/i.test(f)),
    'a .sub/.idx track would appear in the picker and render nothing');
});

test('an orphan does not attach itself to a film it merely appears inside', () => {
  // "English.srt" sitting loose in the movies folder. The old matcher took a
  // hit anywhere in either name, so it landed on The English Patient.
  assert.deepEqual(names(film('The English Patient (1996) 1080p BluRay.mkv')), []);
  // Nor does a misspelled one reach the film it was meant for.
  assert.deepEqual(names(film('Anger Management (2003).mkv')), []);
});

test('a clean sidecar name still reaches a scene-named rip', () => {
  assert.deepEqual(names(film('Inception (2010) 1080p BluRay x264-GRP.mkv')),
    ['Inception (2010).srt']);
});

test('each track comes back as WebVTT a browser will render', () => {
  for (const s of listSubtitles(film('Spirited Away (2001).mkv'))) {
    const vtt = sidecarToVtt(s.path, readSubtitleFile(s.path));
    assert.match(vtt, /^WEBVTT/, path.basename(s.path));
    assert.match(vtt, /\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/, path.basename(s.path));
    assert.ok(!vtt.includes('Dialogue:'), 'raw SubStation Alpha reached the player');
    assert.ok(!vtt.includes('<SYNC'), 'raw SAMI reached the player');
  }
});

test('a Subs subfolder stays loose, because the folder is the scoping', () => {
  const show = path.join(dir, 'Show');
  fs.mkdirSync(path.join(show, 'Subs'), { recursive: true });
  fs.writeFileSync(path.join(show, 'Episode.mkv'), '');
  fs.writeFileSync(path.join(show, 'Subs', 'English.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  // "English.srt" is refused beside a film and accepted here: inside a Subs
  // folder the name is all anyone ever writes, and the folder says whose it is.
  // Listed ONCE — "Subs" and "subs" are two of the five spellings tried, and
  // on Windows both open the same folder.
  assert.deepEqual(listSubtitles(path.join(show, 'Episode.mkv')).map((s) => path.basename(s.path)),
    ['English.srt']);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

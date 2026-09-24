// Sidecar subtitles: which files count, which video they belong to, and what
// the player is actually handed.
//
// Two things were wrong. Sidecar discovery accepted .srt and .vtt only, while
// EMBEDDED tracks already accepted ass/ssa — so the same SubStation Alpha
// subtitle was readable inside an mkv and invisible beside it. And the name
// match accepted a hit ANYWHERE inside either name, which is how an orphan
// called "English.srt" loose in the movies folder attaches itself to The
// English Patient: "theenglishpatient1996" contains "english".
//
// The conversions are text in, text out, so they are tested as such — no
// server, no disk, no ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_SIDECAR_RE, BITMAP_SIDECAR_RE, sidecarMatches,
  srtToVtt, assToVtt, samiToVtt, sidecarToVtt, decodeSubtitle
} from '../src/subtitles.js';

// ---- Which extensions are sidecars ----

test('the text formats are accepted', () => {
  for (const f of ['Film (2009).srt', 'Film (2009).vtt', 'Film (2009).ssa',
    'Film (2009).ass', 'Film (2009).SMI', 'Film (2009).sami', 'Film (2009).en.ASS']) {
    assert.ok(TEXT_SIDECAR_RE.test(f), f);
  }
});

test('VobSub is refused on purpose', () => {
  // .idx is an index and .sub is a stream of subtitle IMAGES. There is no text
  // in either to convert, so listing them would offer a track that renders
  // nothing at all. 37 .sub and 34 .idx files in the pool stay unlisted.
  for (const f of ['Film (2009).sub', 'Film (2009).idx', 'Film (2009).sup']) {
    assert.ok(!TEXT_SIDECAR_RE.test(f), f);
    assert.ok(BITMAP_SIDECAR_RE.test(f), f);
  }
});

// ---- Which video a sidecar belongs to ----

test('an orphaned "English.srt" does not attach to The English Patient', () => {
  assert.equal(sidecarMatches('The English Patient (1996) 1080p BluRay', 'English'), false);
  assert.equal(sidecarMatches('The English Patient (1996)', 'English'), false);
  // Numbered DVD tracks are the same thing with a digit on the front.
  assert.equal(sidecarMatches('The English Patient (1996)', '2_English'), false);
  assert.equal(sidecarMatches('Spanish Harlem (1998)', 'Spanish'), false);
  assert.equal(sidecarMatches('Inception (2010)', 'subtitles'), false);
});

test('a misspelled orphan attaches to nothing', () => {
  // "Anger Managment (2003).srt" is in the pool with no video of its own. The
  // correctly spelled film must not adopt it.
  assert.equal(sidecarMatches('Anger Management (2003) 1080p', 'Anger Managment (2003)'), false);
});

test('the sidecars that do belong still match', () => {
  const v = 'Inception (2010)';
  assert.ok(sidecarMatches(v, 'Inception (2010)'));
  assert.ok(sidecarMatches(v, 'Inception (2010).en'));
  assert.ok(sidecarMatches(v, 'Inception (2010).eng.forced'));
  assert.ok(sidecarMatches(v, 'Inception (2010).es-ai'));      // whisper output
  assert.ok(sidecarMatches(v, 'Inception (2010) English SDH'));
  // The other direction: release junk on the video, a clean name on the sub.
  assert.ok(sidecarMatches('Inception (2010) 1080p BluRay x264-GRP', 'Inception (2010)'));
  // Punctuation and case are not part of the comparison.
  assert.ok(sidecarMatches('50/50 (2011)', '5050 (2011)'));
});

test('a different film is still a different film', () => {
  assert.equal(sidecarMatches('Inception (2010)', 'Titanic (1997)'), false);
  assert.equal(sidecarMatches('Inception (2010)', 'Inception (2010) Behind The Scenes Featurette'), true);
  assert.equal(sidecarMatches('Up (2009)', 'en'), false);      // too short to mean anything
  assert.equal(sidecarMatches('Up (2009)', ''), false);
});

// ---- SubRip ----

test('srt commas become WebVTT periods', () => {
  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:03,000\r\nHello\r\n');
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000/);
  assert.ok(!vtt.includes('\r'));
});

// ---- SubStation Alpha ----

const ASS = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,a note to the translator
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, world
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\i1}Whispered{\\i0}\\Non two lines
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
Dialogue: 0,0:00:10.00,0:00:10.00,Default,,0,0,0,,zero length
Dialogue: 0,0:00:11.00,0:00:12.00,Default,,0,0,0,,{\\an8}{\\pos(100,200)}
`;

test('ass converts to WebVTT', () => {
  const vtt = assToVtt(ASS);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.500\nHello, world/);
  assert.match(vtt, /00:00:04\.000 --> 00:00:06\.000\n<i>Whispered<\/i>\non two lines/);
});

test('ass lines that are not dialogue are left out', () => {
  const vtt = assToVtt(ASS);
  assert.ok(!vtt.includes('a note to the translator'), 'Comment: is not a spoken line');
  assert.ok(!vtt.includes('m 0 0 l 100'), 'a \\p drawing is coordinates, not words');
  assert.ok(!vtt.includes('zero length'), 'a cue that ends when it starts');
  assert.ok(!vtt.includes('00:00:11'), 'a positioning-only line has no text');
});

test('ass keeps the comma inside a line of dialogue', () => {
  // Text is the last field and the only one allowed commas, so the split has
  // to be bounded by the field count rather than by the first comma.
  assert.match(assToVtt(ASS), /\nHello, world\n/);
});

test('ssa v4 field order is read from the Format line, not assumed', () => {
  // SSA v4 opens with "Marked", ASS v4+ with "Layer". Assuming either one
  // silently reads the wrong fields as the timestamps.
  const ssa = `[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:02.00,0:00:04.00,Default,,0000,0000,0000,,An older file
`;
  assert.match(assToVtt(ssa), /00:00:02\.000 --> 00:00:04\.000\nAn older file/);
});

test('ass markup that would be read as WebVTT tags is escaped', () => {
  const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,5 < 6 & 7 > 6
`;
  assert.match(assToVtt(ass), /5 &lt; 6 &amp; 7 &gt; 6/);
});

// ---- SAMI ----

const SMI = `<SAMI>
<HEAD><TITLE>Test</TITLE></HEAD>
<BODY>
<SYNC Start=1000><P Class=ENUSCC>First line<br>second line
<SYNC Start=3000><P Class=ENUSCC>&nbsp;
<SYNC Start=5000><P Class=ENUSCC>Caf&#233; &amp; bar
</BODY>
</SAMI>
`;

test('sami converts to WebVTT', () => {
  const vtt = samiToVtt(SMI);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000\nFirst line\nsecond line/);
  assert.match(vtt, /00:00:05\.000 --> 00:00:09\.000\nCafé &amp; bar/);
});

test('a blank sami marker ends the cue before it instead of starting one', () => {
  const vtt = samiToVtt(SMI);
  assert.equal((vtt.match(/-->/g) || []).length, 2);
  assert.ok(!vtt.includes('00:00:03.000 -->'));
});

// ---- Reading and dispatch ----

test('a UTF-16 subtitle is not read as mojibake', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Héllo', 'utf16le')]);
  assert.equal(decodeSubtitle(le), 'Héllo');
  const beBody = Buffer.from('Héllo', 'utf16le'); beBody.swap16();
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody])), 'Héllo');
  assert.equal(decodeSubtitle(Buffer.from('﻿plain', 'utf8')), 'plain');
});

test('each extension goes to its own converter', () => {
  assert.match(sidecarToVtt('a.ass', ASS), /<i>Whispered<\/i>/);
  assert.match(sidecarToVtt('a.SSA', ASS), /<i>Whispered<\/i>/);
  assert.match(sidecarToVtt('a.smi', SMI), /First line/);
  assert.match(sidecarToVtt('a.srt', '1\n00:00:01,000 --> 00:00:02,000\nHi\n'), /00:00:01\.000/);
  // A .vtt is already WebVTT and must pass through untouched.
  assert.equal(sidecarToVtt('a.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'),
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
});

// Can the owner tell these two copies apart, and is "Keep" actually reasoned?
//
// The panel used to show a title, two paths and a Delete button. Nothing about
// resolution, codec, bitrate, audio or runtime — so there was no way to judge
// which copy to keep, only to trust a recommendation.
//
// And the recommendation did not deserve that trust. scoreCopy weighs audio
// track count, container and folder placement; every copy in a duplicate group
// has THE SAME BYTES, so all three tie by construction and the winner was
// whichever row SQLite returned first. It looked reasoned and was a coin toss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDriveOrder } from '../engine.mjs';
import { scoreCopy, describeCopy, differencesBetween } from '../duplicates.mjs';

const row = (over = {}) => ({
  file_kind: 'movie', file_id: 1,
  path: 'E:\\Movies\\Heat (1995).mkv',
  size: 8 * 2 ** 30, duration: 7020, container: 'matroska',
  vcodec: 'h264', width: 1920, height: 1080, vkbps: 9800, hdr: 0,
  audio_json: '[{"i":0,"codec":"dts","ch":6,"kbps":null,"lang":"eng"}]',
  ...over
});

// The health order used everywhere else in the optimizer: best drive first.
test.beforeEach(() => setDriveOrder(['I:', 'E:', 'H:', 'F:', 'G:']));

test('a copy is described in enough detail to judge it', () => {
  const d = describeCopy(row());
  assert.equal(d.drive, 'E:');
  assert.equal(d.filename, 'Heat (1995).mkv');
  assert.equal(d.folder, 'E:\\Movies');
  assert.equal(d.vcodec, 'h264');
  assert.equal(d.width, 1920);
  assert.equal(d.vkbps, 9800);
  assert.equal(d.tier, '1080p');
  assert.equal(d.duration, 7020);
  assert.deepEqual(d.audio, [{ codec: 'dts', ch: 6, kbps: null, lang: 'eng' }]);
  assert.equal(d.id, 'movie:1');
});

test('a copy with no audio metadata still describes cleanly', () => {
  const d = describeCopy(row({ audio_json: null, vkbps: null, width: null, height: null }));
  assert.deepEqual(d.audio, []);
  assert.equal(d.vkbps, null);
});

test('unparseable audio json does not throw', () => {
  assert.deepEqual(describeCopy(row({ audio_json: '{oh no' })).audio, []);
});

// The honest answer for a real duplicate group.
test('identical copies report no differences at all', () => {
  const a = describeCopy(row({ path: 'E:\\Movies\\Heat (1995).mkv' }));
  const b = describeCopy(row({ path: 'G:\\Movies\\Heat (1995).mkv', file_id: 2 }));
  assert.deepEqual(differencesBetween([a, b]), [],
    'byte-identical copies differ only in location, and the panel must say so');
});

test('a genuine quality difference is named and quantified', () => {
  const a = describeCopy(row({ width: 3840, height: 2160, vkbps: 55000, vcodec: 'hevc', size: 55 * 2 ** 30 }));
  const b = describeCopy(row({ width: 1920, height: 1080, vkbps: 9800, vcodec: 'h264', size: 8 * 2 ** 30, file_id: 2 }));
  const d = differencesBetween([a, b]);
  const fields = d.map((x) => x.field);
  for (const f of ['resolution', 'video codec', 'video bitrate', 'size']) {
    assert.ok(fields.includes(f), `${f} differs and must be reported`);
  }
  const res = d.find((x) => x.field === 'resolution');
  assert.deepEqual(res.values, ['3840x2160', '1920x1080'], 'and it must show BOTH values, not just that they differ');
});

test('differing audio is surfaced', () => {
  const a = describeCopy(row({ audio_json: '[{"codec":"truehd","ch":8,"lang":"eng"}]' }));
  const b = describeCopy(row({ audio_json: '[{"codec":"ac3","ch":6,"lang":"eng"}]', file_id: 2 }));
  const d = differencesBetween([a, b]);
  assert.ok(d.some((x) => x.field === 'audio'));
});

// The bug: with every other test tied, the drive decided nothing.
test('between two identical copies, the healthier drive wins', () => {
  const onE = scoreCopy(row({ path: 'E:\\Movies\\Heat (1995).mkv' }));
  const onG = scoreCopy(row({ path: 'G:\\Movies\\Heat (1995).mkv' }));
  assert.ok(onE.score > onG.score,
    'E: is ahead of G: in the health order, so the copy on E: must be recommended');
  assert.notEqual(onE.score, onG.score, 'and the two must not tie, or the choice is arbitrary again');
});

test('the whole health order is respected, not just the extremes', () => {
  const order = ['I:', 'E:', 'H:', 'F:', 'G:'];
  const scores = order.map((d) => scoreCopy(row({ path: `${d}\\Movies\\Heat (1995).mkv` })).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] > scores[i], `${order[i - 1]} must outrank ${order[i]}`);
  }
});

// The tiebreak must stay a tiebreak. scoreCopy is also used where the copies
// genuinely differ, and a healthy drive must never win against a better file.
test('drive health never outranks a real difference', () => {
  // Worst drive, but two audio tracks and in the right folder.
  const better = scoreCopy(row({
    path: 'G:\\Movies\\Heat (1995).mkv',
    audio_json: '[{"codec":"truehd","ch":8},{"codec":"ac3","ch":6}]'
  }));
  // Best drive, single track.
  const worse = scoreCopy(row({ path: 'I:\\Movies\\Heat (1995).mkv' }));
  assert.ok(better.score > worse.score,
    'an extra audio track must beat a healthier drive — the drive only breaks ties');
});

test('an unknown drive sorts behind every known one but still scores', () => {
  const known = scoreCopy(row({ path: 'G:\\Movies\\Heat (1995).mkv' })).score;
  const unknown = scoreCopy(row({ path: 'Z:\\Movies\\Heat (1995).mkv' })).score;
  assert.ok(unknown < known, 'a drive nobody has vouched for does not jump the queue');
  assert.ok(unknown > 0);
});

test('the reasons name the drive, so the recommendation explains itself', () => {
  const { reasons } = scoreCopy(row({ path: 'E:\\Movies\\Heat (1995).mkv' }));
  assert.ok(reasons.some((r) => r.includes('E:')), `reasons were: ${reasons.join(', ')}`);
});

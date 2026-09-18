// Which file names count as an episode?
//
// Two shows sat in the pool completely invisible to the library - MythBusters
// (443 files between them, filed as "Season 2003" / "MythBusters - 2003x01")
// and Tom and Jerry ("1940" / "Tom and Jerry - 1940x01"). The parser accepted
// only 1-2 digit seasons, so a year matched nothing at all.
//
// The fix must not be "allow four digits", because plenty of filenames carry a
// resolution: "1280x720" would then read as season 1280, episode 720. Years are
// matched as 19xx/20xx, and that boundary is what these tests hold in place.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEpisode } from '../src/parse.js';

test('the ordinary forms still parse', () => {
  assert.deepEqual(parseEpisode('Show S01E02.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Show - 1x02 - Title.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Show - 12x09.mkv'), { season: 12, episode: 9 });
  assert.deepEqual(parseEpisode('Rome - 2x01 - Passover.mkv'), { season: 2, episode: 1 });
});

test('a year works as a season number', () => {
  assert.deepEqual(parseEpisode('MythBusters - 2003x01 - Jet Assisted Chevy.avi'), { season: 2003, episode: 1 });
  assert.deepEqual(parseEpisode('Tom and Jerry - 1940x01 - Puss Gets The Boot.avi'), { season: 1940, episode: 1 });
  assert.deepEqual(parseEpisode('MythBusters - 2011x24 - Bikes and Bazookas.mkv'), { season: 2011, episode: 24 });
});

test('a resolution in the name is not an episode', () => {
  // The whole reason years are matched narrowly instead of by digit count.
  assert.equal(parseEpisode('Show Title 1280x720 WEB-DL.mkv'), null);
  assert.equal(parseEpisode('Show Title 1920x1080.mkv'), null);
  assert.equal(parseEpisode('Some Film 3840x2160 HDR.mkv'), null);
});

test('a year folder gives the season when the file does not', () => {
  assert.deepEqual(parseEpisode('E05 - Title.avi', ['Tom and Jerry', '1940']), { season: 1940, episode: 5 });
  assert.deepEqual(parseEpisode('07 - Title.avi', ['MythBusters', 'Season 2003']), { season: 2003, episode: 7 });
  assert.deepEqual(parseEpisode('E05 - Title.avi', ['Show', 'Season 3']), { season: 3, episode: 5 });
});

test('a four-digit folder that is not a year is not a season', () => {
  assert.equal(parseEpisode('E05 - Title.avi', ['Show', '4021']), null);
  assert.equal(parseEpisode('E05 - Title.avi', ['Show', '1080']), null);
});

test('the file name still wins over the folder', () => {
  assert.deepEqual(parseEpisode('Show - 2x03.mkv', ['Show', 'Season 2005']), { season: 2, episode: 3 });
});

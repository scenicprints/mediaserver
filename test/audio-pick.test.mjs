// The server's own audio pick for the Apple TV/Roku HLS route: a track the
// device plays as-is (so nothing is converted), and the feature mix, not an
// extra that happens to be in a nicer codec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAudioIndex } from '../src/hls.js';

const a = (codec_name, channels, extra = {}) => ({ codec_type: 'audio', codec_name, channels, ...extra });

test('TrueHD and DTS first in the file: the copyable track is chosen, so nothing is converted', () => {
  assert.equal(pickAudioIndex([a('truehd', 8), a('dts', 6), a('ac3', 6)]), 2);
});

test('the 5.1 film beats a 2.0 commentary even when the commentary is E-AC-3', () => {
  const commentary = a('eac3', 2, { tags: { title: 'Director Commentary' } });
  assert.equal(pickAudioIndex([a('truehd', 8), commentary, a('ac3', 6)]), 2);
});

test('more channels wins among copyable tracks; codec breaks a tie', () => {
  assert.equal(pickAudioIndex([a('aac', 2), a('ac3', 6)]), 1);
  assert.equal(pickAudioIndex([a('ac3', 6), a('eac3', 6)]), 1);
});

test('nothing copyable: the first track, to be transcoded as before', () => {
  assert.equal(pickAudioIndex([a('dts', 6), a('truehd', 8)]), 0);
  assert.equal(pickAudioIndex([]), 0);
});

// The version picker line has to tell two versions apart at a glance, from
// what is in the file rather than what its name happens to say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, tierOf, sizeText } from '../src/versions.js';

test('a 4K HDR film with lossless audio', () => {
  const probe = { streams: [
    { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 1606, color_transfer: 'smpte2084' },
    { codec_type: 'audio', codec_name: 'truehd', channels: 8, channel_layout: '7.1', profile: 'Dolby TrueHD + Dolby Atmos', disposition: { default: 1 } },
    { codec_type: 'audio', codec_name: 'ac3', channels: 6 }
  ] };
  assert.equal(describe({ quality: null, size: 58.2e9 }, probe).label, '4K · HEVC HDR10 · TrueHD Atmos 7.1 · 58.2 GB');
});

test('an episode whose filename says nothing still gets its tier from the picture', () => {
  const probe = { streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'eac3', channels: 6, channel_layout: '5.1(side)' }
  ] };
  const d = describe({ quality: null, filename: 'Show.S01E01.mkv', size: 1.4e9 }, probe);
  assert.equal(d.quality, '1080p');
  assert.equal(d.label, '1080p · H.264 · E-AC-3 5.1 · 1.4 GB');
});

test('scope films are tiered by width, not height', () => {
  assert.equal(tierOf(1920, 800), '1080p');
  assert.equal(tierOf(3840, 1600), '4K');
  assert.equal(tierOf(720, 480), 'SD');
});

test('with no probe it falls back to the name and the size', () => {
  assert.equal(describe({ quality: '720p', filename: 'x.mkv', size: 700e6 }, null).label, '720p · 700 MB');
  assert.equal(describe({ quality: null, filename: 'x.mkv', size: 0 }, null).label, 'x.mkv');
  assert.equal(sizeText(0), null);
});

test('Dolby Vision and DTS-HD MA are named', () => {
  const probe = { streams: [
    { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_transfer: 'smpte2084', side_data_list: [{ side_data_type: 'DOVI configuration record' }] },
    { codec_type: 'audio', codec_name: 'dts', profile: 'DTS-HD MA', channels: 6 }
  ] };
  assert.equal(describe({ size: 70e9 }, probe).label, '4K · HEVC Dolby Vision · DTS-HD MA 5.1 · 70.0 GB');
});

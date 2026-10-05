// What a version actually IS, for the version picker: "4K · HEVC HDR10 ·
// TrueHD 7.1 · 58.2 GB".
//
// The picker used to show the quality parsed from the filename, and for an
// episode nothing else, so two versions of the same episode whose names carry
// no "1080p" were both just "Version". This reads the file (ffprobe, cached
// per file in ffmpeg.js) and says what is in it. With no ffprobe, or a file
// that can't be read, it falls back to the filename's quality and the size.

export function sizeText(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return null;
  const gb = b / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

// Tier by WIDTH, the same rule as the optimizer: a 2.39:1 film is 3840x1606
// (4K) or 1920x800 (1080p), and keying on height calls those a tier too low.
export function tierOf(width, height) {
  const w = Number(width) || 0, h = Number(height) || 0;
  if (w >= 3200 || h >= 1800) return '4K';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  return w > 0 ? 'SD' : null;
}

const VCODEC = { hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', vc1: 'VC-1', wmv3: 'WMV' };
const ACODEC = { eac3: 'E-AC-3', ac3: 'AC-3', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM', alac: 'ALAC' };

function channelsText(n, layout) {
  if (/7\.1/.test(layout || '') || n === 8) return '7.1';
  if (/5\.1/.test(layout || '') || n === 6) return '5.1';
  if (n === 2) return 'Stereo';
  if (n === 1) return 'Mono';
  return n ? `${n}ch` : '';
}

function hdrOf(v) {
  const dv = (v.side_data_list || []).some((d) => /dovi|dolby vision/i.test(d.side_data_type || ''))
    || /^dvh|^dvhe/i.test(v.codec_tag_string || '');
  if (dv) return 'Dolby Vision';
  if (v.color_transfer === 'smpte2084') return 'HDR10';
  if (v.color_transfer === 'arib-std-b67') return 'HLG';
  return null;
}

function audioText(a) {
  if (!a) return null;
  let name = ACODEC[a.codec_name] || (a.codec_name || '').toUpperCase();
  const prof = String(a.profile || '');
  if (a.codec_name === 'dts' && /MA/.test(prof)) name = 'DTS-HD MA';
  else if (a.codec_name === 'dts' && /HRA|HD/.test(prof)) name = 'DTS-HD';
  if (/atmos/i.test(prof) || (a.codec_name === 'eac3' && /JOC/i.test(prof))) name += ' Atmos';
  const ch = channelsText(a.channels, a.channel_layout);
  return [name, ch].filter(Boolean).join(' ');
}

/** One file's picker line. `file` is { quality, filename, size }; `probe` is ffprobe JSON or null. */
export function describe(file, probe) {
  const streams = (probe && probe.streams) || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const a = audios.find((s) => s.disposition && s.disposition.default) || audios[0];
  const tier = (v && tierOf(v.width, v.height)) || file.quality || null;
  const video = v ? [VCODEC[v.codec_name] || (v.codec_name || '').toUpperCase(), hdrOf(v)].filter(Boolean).join(' ') : null;
  const parts = [tier, video, audioText(a), sizeText(file.size)].filter(Boolean);
  return {
    quality: tier,
    label: parts.length ? parts.join(' · ') : (file.filename || 'Version')
  };
}

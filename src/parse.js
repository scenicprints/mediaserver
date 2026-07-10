// Filename parsing: turn "H:\Movies\(500) Days of Summer (2009).mp4"
// into { title: "(500) Days of Summer", year: 2009 }.

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg'
]);

export function isVideo(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXTS.has(filename.slice(dot).toLowerCase());
}

export function ext(filename) {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

export function parseMovie(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;

  // Grab the LAST parenthesized 4-digit group as the year, so titles that
  // themselves contain a number in parens — like "(500) Days of Summer (2009)" —
  // resolve to 2009, not 500.
  const re = /\((\d{4})\)/g;
  let m, last = null;
  while ((m = re.exec(base)) !== null) last = m;

  let title = base;
  let year = null;

  if (last) {
    year = parseInt(last[1], 10);
    title = base.slice(0, last.index);
  } else {
    // Fallback for un-parenthesized years: "Movie Name 2009" or "Movie.Name.2009".
    const bare = base.match(/^(.*?)[.\s_-]+((?:19|20)\d{2})(?:\D.*)?$/);
    if (bare) {
      title = bare[1];
      year = parseInt(bare[2], 10);
    }
  }

  title = title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, year };
}

// Best-guess quality/resolution label from a filename. Returns null if unknown.
export function detectQuality(name) {
  const s = name.toLowerCase();
  if (/(^|[^a-z0-9])(2160p|4k|uhd|ultrahd)([^a-z0-9]|$)/.test(s)) return '4K';
  if (/(^|[^a-z0-9])(1080p|1080i|fullhd|fhd)([^a-z0-9]|$)/.test(s)) return '1080p';
  if (/(^|[^a-z0-9])(720p|hdready)([^a-z0-9]|$)/.test(s)) return '720p';
  if (/(^|[^a-z0-9])(480p|576p|dvdrip|dvd|sdtv)([^a-z0-9]|$)/.test(s)) return 'SD';
  return null;
}

// Sort rank so the highest quality comes first / is the default.
export function qualityRank(q) {
  return { '4K': 4, '1080p': 3, '720p': 2, SD: 1 }[q] || 0;
}

// Grouping key: two files with the same normalized title + year are the same
// movie (e.g. a 1080p and a 4K rip of "Inception (2010)").
export function groupKey(title, year) {
  const t = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${t}|${year || ''}`;
}

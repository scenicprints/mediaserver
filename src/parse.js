// Filename parsing: turn "H:\Movies\(500) Days of Summer (2009).mp4"
// into { title: "(500) Days of Summer", year: 2009 }.

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.3g2'
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

// Strip common release-junk tokens (resolution, source, codec, audio, group)
// that confuse metadata matching. Cuts everything from the first such token on.
const JUNK = /\b(2160p|1080p|1080i|720p|480p|576p|4k|uhd|hdr|10bit|x264|x265|h ?264|h ?265|hevc|avc|xvid|divx|bluray|blu-ray|brrip|bdrip|brip|web-?dl|web-?rip|webrip|hdrip|hdtv|dvdrip|dvdscr|dvd|remux|proper|repack|internal|aac|ac3|eac3|dd5|ddp5|dts|truehd|atmos|flac|multi|dual|hindi|ita|dubbed|subbed)\b/i;

export function scrubTitle(s) {
  const cut = s.search(JUNK);
  let out = cut > 0 ? s.slice(0, cut) : s;
  out = out.replace(/[\[(][^\])]*[\])]\s*$/g, ''); // trailing [group] / (tag)
  return out.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
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

  title = scrubTitle(title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim());
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

// ---- TV parsing ----

function stripExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function tidy(s) {
  return s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Season number hinted by a folder like "Season 2", "S02", "Specials",
// "Season 2003", a bare year folder like "1940", or a bare "02".
//
// Some shows are filed by year instead of by season number - MythBusters as
// "Season 2003", Tom and Jerry as "1940" - and with only \d{1,2} accepted those
// folders matched nothing, leaving 443 episodes in the pool but invisible to the
// library. Years are matched explicitly as 19xx/20xx rather than by widening the
// digit count, which would also swallow things that are not seasons.
//
// The bare-number form is how this library is actually laid out
// (P:\TV Shows\Rick and Morty\02\), and those episodes only indexed at all
// because their filenames happened to carry "2x01" as well. Where a filename
// had no pattern of its own, the file was invisible.
//
// It is deliberately narrow, because a bare number is also a plausible SHOW
// name. Only the LAST segment counts — a season folder is the video's own
// parent, never its grandparent — and only when something sits above it, so
// "TV Shows\24\ep.mkv" reads 24 as the show it is and not as season 24.
function seasonFromSegments(segs) {
  for (const s of segs) {
    const m = s.match(/season\s*(\d{1,2})(?!\d)/i) || s.match(/^s(\d{1,2})$/i)
      || s.match(/season\s*((?:19|20)\d{2})(?!\d)/i) || s.match(/^((?:19|20)\d{2})$/);
    if (m) return parseInt(m[1], 10);
    if (/^specials?$/i.test(s)) return 0;
  }
  const last = segs[segs.length - 1];
  if (segs.length >= 2 && /^\d{1,2}$/.test(last)) return parseInt(last, 10);
  return null;
}

// Extract season/episode from a filename (and optional folder segments).
// Handles S01E02, 1x02, "Exx" / bare "NN" / bare "SSEE" inside a season folder,
// and "Special NN".
//
// The rules are tried in order and every one of them is narrower than the last,
// because a looser parser that re-buckets an episode already on the shelf is
// worse than the files it rescues. Nothing here changes what an existing rule
// already matched.
export function parseEpisode(filename, segs = []) {
  const base = stripExt(filename);
  let m = base.match(/S(\d{1,2})[\s._-]*E(\d{1,3})/i);
  if (m) return { season: +m[1], episode: +m[2] };

  // A year used as the season: "MythBusters - 2003x01", "Tom and Jerry - 1940x01".
  // Checked before the 1-2 digit form, and restricted to 19xx/20xx so a
  // resolution in a filename cannot be read as an episode - widening the season
  // to four digits would turn "1280x720" into season 1280, episode 720.
  m = base.match(/(?:^|[^0-9])((?:19|20)\d{2})x(\d{1,3})(?:[^0-9]|$)/i);
  if (m) return { season: +m[1], episode: +m[2] };

  m = base.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?:[^0-9]|$)/i);
  if (m) return { season: +m[1], episode: +m[2] };

  const seasonHint = seasonFromSegments(segs);
  if (seasonHint != null) {
    m = base.match(/(?:^|[^a-z0-9])E(\d{1,3})(?:[^0-9]|$)/i);
    if (m) return { season: seasonHint, episode: +m[1] };
    m = base.match(/^(\d{1,3})(?:\D|$)/); // "02 - Title"
    if (m) return { season: seasonHint, episode: +m[1] };
    // Bare "SSEE": "0106.mp4" in a folder called "01" is S01E06. The old bare
    // rule could never reach it — it takes "010", demands a non-digit, finds
    // "6", and every backtrack fails the same way.
    //
    // Four digits is also what a year looks like, so the folder has to agree
    // with the first two: "2012 (2009).mkv" is a film and an episode called
    // "1917" is anyone's guess, and neither sits in a season 20 or 19 folder.
    m = base.match(/^(\d{2})(\d{2})(?:\D|$)/);
    if (m && +m[1] === seasonHint) return { season: seasonHint, episode: +m[2] };
  }

  // "Special 10" — season 0 is the standard specials season, the one Sonarr and
  // TMDB both use. Last, so an episode whose TITLE ends in "... Special 2" is
  // still read as the episode its folder and numbering say it is. The digits
  // are required, so "Special Delivery" is not a special.
  m = base.match(/(?:^|[^a-z0-9])Special\s*(\d{1,3})(?:[^0-9]|$)/i);
  if (m) return { season: 0, episode: +m[1] };

  return null;
}

// Show name derived from a filename when there's no show folder.
export function showFromFilename(filename) {
  const base = stripExt(filename);
  const m = base.match(/^(.*?)[\s._-]*(?:S\d{1,2}[\s._-]*E\d{1,3}|\d{1,2}x\d{1,3})/i);
  return scrubTitle(m ? m[1] : base);
}

// Clean a show folder name for display (drops a trailing "(2015)").
export function cleanShowName(name) {
  return tidy(name.replace(/\(\d{4}\)\s*$/, ''));
}

// A show's grouping key: normalized name, no year.
export function showKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

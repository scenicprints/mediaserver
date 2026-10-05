// The settings the window is allowed to change, and how they reach disk.
//
// config.json is shared with the media server and holds its secrets — API keys,
// an OpenSubtitles password, an invite code. So this does NOT rewrite the file
// from a parsed object: it reads what is there, changes only the keys listed
// below, and writes the result back. Anything it does not know about survives
// untouched, including comments-as-keys and settings added by a later version.
//
// Every value is validated here rather than trusted from the page, because the
// page is HTTP and HTTP is reachable by things that are not the page.
import fs from 'node:fs';
import path from 'node:path';

// name -> { get, coerce }  — the complete list of what may be written.
// Anything absent from this map cannot be changed through the UI at all.
const FIELDS = {
  // Whether to stand down while somebody is watching something.
  //
  // On by default and worth keeping on with a media server present: a stuttering
  // film costs more than a postponed hour of housekeeping. But the check asks
  // Marquee over HTTP, and it fails CLOSED — anything other than a clear "nobody
  // is watching" means stop. For someone running Plex, Jellyfin or Emby, or no
  // server at all, that is an optimizer that never once does any work, with
  // "standing down to be safe" as the only clue. Hence a switch.
  pauseWhileWatching: {
    coerce: (v) => v !== false && v !== 'false' && v !== 0,
    default: true
  },

  // The port the media server answers on, for the check above.
  mediaServerPort: {
    coerce: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port must be between 1 and 65535');
      return n;
    },
    default: 8096
  },

  // Around the clock, or only in the quiet hours.
  optimizeWindow: {
    coerce: (v) => {
      const o = v && typeof v === 'object' ? v : {};
      const hhmm = (s, fallback) => {
        const t = String(s ?? fallback);
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`"${t}" is not a time like 23:30`);
        return t;
      };
      return { from: hhmm(o.from, '00:00'), to: hhmm(o.to, '05:00'), always: o.always === true || o.always === 'true' };
    },
    default: { from: '00:00', to: '05:00', always: false }
  },

  // Folders to scan for media, for running without Marquee.
  //
  // Empty means "the library comes from Marquee's database" — the original and
  // still the default. Non-empty switches on the scanner, which keeps its own
  // movie_files rows in the optimizer's own database. The two are never mixed:
  // scanning into Marquee's database would put rows there that Marquee did not
  // make and would delete on its next scan.
  libraryFolders: {
    coerce: (v) => {
      if (v == null || v === '') return [];
      const list = Array.isArray(v) ? v : String(v).split(/\r?\n/);
      const out = [];
      for (const raw of list) {
        const f = String(raw).trim().replace(/[\\/]+$/, '');   // a trailing slash breaks the "is it under this root" test
        if (!f) continue;
        if (!/^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(f)) {
          throw new Error(`"${f}" is not a full path — use D:\\Media or \\\\server\\share\\Media`);
        }
        if (!out.some((e) => e.toLowerCase() === f.toLowerCase())) out.push(f);
      }
      return out;
    },
    default: []
  },

  // The quality bar a re-encode has to clear to be kept.
  //
  // Exposed because it is the single number that decides how much of a library
  // gets shrunk, and the right answer is a matter of taste. Floored at 80: below
  // that the gate stops being a safety net, and this is the setting most likely
  // to be turned down out of impatience and regretted later.
  vmafPassMark: {
    coerce: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 80 || n > 100) throw new Error('the pass mark must be between 80 and 100');
      return Math.round(n * 10) / 10;
    },
    default: 95
  }
};

export const SETTING_NAMES = Object.keys(FIELDS);

/** Current values, falling back to the documented default for anything unset. */
export function readSettings(root) {
  let raw = {};
  try { raw = JSON.parse(stripBom(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))); } catch { /* defaults */ }
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    if (raw[k] === undefined) { out[k] = f.default; continue; }
    try { out[k] = f.coerce(raw[k]); } catch { out[k] = f.default; }
  }
  // The media server's port has lived under `port` since before this existed.
  if (raw.mediaServerPort === undefined && raw.port !== undefined) {
    try { out.mediaServerPort = FIELDS.mediaServerPort.coerce(raw.port); } catch { /* keep the default */ }
  }
  return out;
}

/**
 * Write the given subset back, leaving every other key in config.json alone.
 *
 * Returns the full settings after the change. Throws with a readable message if
 * a value is rejected — and rejects the whole call rather than applying half of
 * it, so a bad field cannot leave settings in a state nobody asked for.
 */
export function writeSettings(root, patch) {
  const file = path.join(root, 'config.json');
  const text = fs.readFileSync(file, 'utf8');
  const raw = JSON.parse(stripBom(text));

  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!FIELDS[k]) continue;                       // not ours to write
    try { clean[k] = FIELDS[k].coerce(v); }
    catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  if (!Object.keys(clean).length) return readSettings(root);

  Object.assign(raw, clean);

  // Written beside the original and renamed over it, so a crash mid-write
  // cannot leave the media server without a config file at all.
  const tmp = file + '.writing';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return readSettings(root);
}

function stripBom(s) { return s.replace(/^﻿/, ''); }

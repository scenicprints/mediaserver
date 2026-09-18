# Task: subtitle sidecars and season-0 specials

Two parsing gaps in Marquee, both found while migrating the library into a
DrivePool pool. Real files on disk are affected; the counts below are actual.

Repo: `C:\mediaserver` (public — `config.json` holds secrets and is gitignored).
Run tests with `node --test "test/*.test.mjs" "optimizer/test/*.test.mjs"`.
163 pass today; keep them passing and add cases for what you change.

---

## 1. Subtitle sidecars: only `.srt` and `.vtt` are read

`listSubtitles()` in **`src/server.js:1855`** filters at **line 1866**:

```js
if (!/\.(srt|vtt)$/i.test(f)) continue;
```

The pool now holds these sidecars beside their films:

| extension | count | status |
|---|---|---|
| `.srt` | 526 | read |
| `.vtt` | 19 | read |
| `.sub` + `.idx` | 37 + 34 | ignored |
| `.ssa` | 2 | ignored |
| `.smi` | 1 | ignored |

**Do:** accept `.ssa` and `.ass` as text subtitles. `src/ffmpeg.js:209` already
lists `ssa`/`ass` in `TEXT_SUB_CODECS` for *embedded* tracks, so the conversion
path exists — this is only the sidecar filter disagreeing with it. Check how the
chosen sidecar is delivered to the player and convert to WebVTT if it is served
raw, since browsers do not render SubStation Alpha.

`.smi` (SAMI) is also text; add it only if converting it is straightforward.

**Do NOT** simply add `.sub`/`.idx` to that regex. VobSub is a *bitmap* format —
an `.idx` index plus an `.sub` image stream. It cannot be turned into text
without OCR, and adding the extension would offer the user a subtitle track that
renders nothing. Either burn it in during transcode, or leave it out and say so.

There are also **15 orphaned sidecars** with no matching video (`English.srt`,
`5050 (2011).srt`, `Anger Managment (2003).srt` — note the misspelling). The
matcher at line 1869 is deliberately loose (`includes` both ways), so check a
loose match cannot attach a wrong subtitle to a film; `English.srt` sitting in
`P:\Movies` is the case to test.

---

## 2. Season-0 specials and 4-digit episode names

`parseEpisode()` and `seasonFromSegments()` in **`src/parse.js:93-120`**.

`seasonFromSegments` matches only `Season 2` or `S02`:

```js
const m = s.match(/season\s*(\d{1,2})/i) || s.match(/^s(\d{1,2})$/i);
```

But this library uses **bare numeric season folders**, e.g. `F:\Rick and Morty\02\`
(now `P:\TV Shows\Rick and Morty\02\`). Those episodes only index today because
their *filenames* carry `2x01`. Where the filename lacks a pattern, they are lost.

### Failing case A — 21 files

```
P:\TV Shows\Impractical Jokers\00\Impractical Jokers - Special 10 - Impractical Jokers' Joker Bowl The Pros Weigh In.mkv
P:\TV Shows\Impractical Jokers\00\Impractical Jokers - Special 36 - Impractical Jokers The Movie.mp4
```

`00` is not recognised as a season, and `Special 10` is not recognised as an
episode, so `parseEpisode` returns null and all 21 are invisible in Marquee.
Expected: **season 0, episode 10** — season 0 is the standard specials season and
is what Sonarr already uses.

### Failing case B — 1 file

```
P:\TV Shows\What If.!\01\0106.mp4
```

Folder `01`, filename `0106` meaning S01E06. The existing bare-number rule is
`/^(\d{1,3})(?:\D|$)/`, which cannot match `0106`: it takes `010` then requires a
non-digit and finds `6`, and every backtrack fails the same way. Note the sibling
files in that folder DO parse (`What If… - 1x01 - ...`), so only this one is lost.

**Do:**
- let `seasonFromSegments` accept a folder that is just 1–2 digits (`00`, `01`, `02`)
- parse `Special\s*(\d{1,3})` as season 0
- parse a bare 4-digit `SSEE` filename when a season folder agrees with `SS`

**Be careful:** a 4-digit rule must not swallow legitimate titles. `2012 (2009).mkv`
is a film, and an episode named `1917` would be ambiguous. Require the season
folder to match the first two digits, and only apply it when nothing else matched.
Add a test that `2012` and `1917` are not parsed as episodes.

---

## Verification

After changing the parser, a rescan should pick up 22 files that are currently
invisible. Before/after counts:

```sql
SELECT COUNT(*) FROM episode_files;   -- 18838 before
```

Do not hand-write rows into the database; let the scanner find them. And check
the 20,622 files already indexed do not shift — a looser parser can re-bucket
existing episodes, which would be worse than the bug it fixes.

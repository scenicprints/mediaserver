# Marquee Optimizer

Keeps a media library lean and playable: converts audio tracks that a TV cannot
decode, and re-encodes video that is carrying more bits than it needs — without
ever replacing a file it cannot prove is still good.

It runs in the background, in the tray, and stands down while anyone is
watching something.

---

## Where it gets your library

On first run it asks, and there are two answers.

**Scan my own folders.** You name the folders your media is in; it finds the
video files itself and keeps its own catalogue. This is the answer for Plex,
Jellyfin, Emby, Kodi, or no media server at all. It needs nothing from them —
it reads your files, not their databases.

**From Marquee.** If you run Marquee, it uses the library Marquee has already
scanned, which means no second scan and no second copy of the catalogue.

| You have | Result |
|---|---|
| Any media, any server, or no server | Works — scan your own folders |
| Marquee, scanned at least once | Works — uses Marquee's library directly |
| Marquee installed but never scanned | Asks you to run a scan first, or to scan folders yourself |

The two are never mixed. With folders configured, the optimizer keeps its
catalogue in its own database under
`%APPDATA%\Marquee Optimizer\library\`; it does not write rows into Marquee's,
because Marquee would delete them on its next scan.

**When scanning your own folders:**

- Sub-folders are included.
- `Plex Versions`, `$RECYCLE.BIN`, `System Volume Information`, `@eaDir` and
  `.@__thumb` are skipped. Plex's own re-encodes are not media, and a deleted
  file should not come back as one.
- Symlinks and junctions are never followed, so a link pointing at a parent
  cannot turn the scan into an endless one.
- A folder on a drive or share that is not reachable is **skipped entirely** and
  its files stay in the catalogue. Unplugging a drive does not empty your
  library.
- **Turn off "pause while someone is watching"** unless you run Marquee's
  server. The check asks Marquee over HTTP and treats no answer as "someone is
  watching", so with another server it would never run. Choosing "scan my own
  folders" during setup turns it off for you.

## Requirements

- **Windows.** Drive and volume handling, the disk-health check and the tray are
  all Windows-specific.
- **Media files.** Either folders to scan, or a Marquee install that has
  already scanned them — see above. Nothing else is required.
- **ffmpeg with `libvmaf`.** This matters more than it sounds. Without libvmaf
  there is no way to prove a re-encode still looks like the original, so video
  shrinking is refused outright and only audio conversion runs. **Many ffmpeg
  builds do not include it.** The window tells you when yours doesn't. To check
  yourself — this is the same test the program makes:

  ```
  ffmpeg -hide_banner -filters | findstr libvmaf
  ```

  No output means no libvmaf.
- **Optional: an NVIDIA GPU** for `hevc_nvenc`. Without one it encodes on the
  CPU, which works and is slower. The window says which you have.

ffmpeg is looked for in this order: the `ffmpegPath` in the active `config.json`,
then a copy under the project's `tools/`, then plain `ffmpeg` on `PATH`.

## Running it

Double-click the executable. It opens a window and puts an icon in the tray.

- **Closing the window does not stop it.** It keeps working; the tray icon is
  how you know. Quit from the tray menu is how you actually stop it.
- **Start with Windows** is a tray-menu checkbox. It launches hidden, so the
  machine does not boot to a window nobody asked for.
- **Change library folder…** in the tray if Marquee moves.
- **Restart it if it stops** is another tray checkbox. It registers a Windows
  Scheduled Task that checks every five minutes and starts the optimizer again if
  it is not running — after a crash, or after something else took it down. It
  needs no administrator rights and stores no password.
- The window is at `http://localhost:8097`, bound to `127.0.0.1` only — it is
  not reachable from the network, which is why it has no password.

For a machine nobody sits at, `node optimizer/app.mjs` runs the same engine with
no window.

## Settings

In the window. They are written into the `config.json` of whichever root is in
use — Marquee's, or the optimizer's own when scanning folders.

- **Pause while someone is watching** — asks the media server before starting
  work. **Turn this off if you do not run Marquee's server**, or if it is not on
  the port below. The check deliberately fails closed: anything other than a
  clear "nobody is watching" means stand down, so with nothing to ask it would
  never run.
- **Media server port** — default 8096.
- **Work around the clock**, or only between the hours given. Encoding is heavy;
  playback wins either way.
- **Quality pass mark** — the VMAF score a re-encode must reach to be kept.
  Default 95, floor 80. Lower it and more files shrink, slightly less faithfully.

Nothing else in `config.json` is touched. The file belongs to the media server
and holds its API keys; saving a setting assigns only the four keys above and
leaves everything else, including settings a later version adds, exactly as it
found them.

## What it will not do

The point of this program is that it is boring and does not lose anything.

- **It never replaces a file it cannot verify.** Every job encodes to a temp file
  beside the original and then has to pass: output present and sane, runtime
  within 0.5% (or 1.5 seconds, whichever is larger), resolution unchanged, the
  video bitstream byte-identical when the video was copied, audio present, a real
  `-xerror` decode near the start, middle and end, and a VMAF score above the pass
  mark. Fail any of it and the temp file is deleted and the original is untouched.
- **It never overwrites.** Every move refuses rather than replacing. A library
  can hold several versions of a title under the same filename in different
  folders, so collisions are normal, not exceptional.
- **It leaves 4K and HDR video alone** unless explicitly allowed, because the
  quality judgement it can make is less trustworthy there. Audio conversion on
  those files is still done; it copies the picture.
- **It will not touch a file on a drive or share it cannot currently reach**, so
  an offline disk is never mistaken for missing media.
- **A file it decided not to shrink is not a failure.** Those appear as "left as
  they were". "Stuck" is only for things that actually went wrong.

## Where things are

| | |
|---|---|
| Log | `<root>\data\optimizer.log` — "Open log folder" in the tray |
| Its own tables | `media_info` and `optimize_jobs`, in whichever database is in use |
| Which root was chosen | `%APPDATA%\Marquee Optimizer\library-location.json` |
| Its own library, when scanning folders | `%APPDATA%\Marquee Optimizer\library\` |

"Root" is the Marquee folder, or the optimizer's own one above when it is
scanning folders itself.

## Building

```
node optimizer/build-app.mjs      # -> dist\Marquee Optimizer-win32-x64\
npm run test:optimizer            # the test suite
```

The version comes from `optimizer/package.json`.

## Licence

Apache License 2.0 — see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
Copyright 2026 Kevin Wagner.

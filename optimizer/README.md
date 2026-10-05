# Marquee Optimizer

Keeps a media library lean and playable: converts audio tracks that a TV cannot
decode, and re-encodes video that is carrying more bits than it needs — without
ever replacing a file it cannot prove is still good.

It runs in the background, in the tray, and stands down while anyone is
watching something.

---

## It requires Marquee. It will not work without it.

**This is not a standalone program.** The optimizer has no library scanner of
its own. Every file it works on comes from the `movie_files` and `episode_files`
tables in Marquee's SQLite database, which Marquee's own scan fills in.

Without Marquee there is nothing for it to read, and it says so rather than
starting: the setup screen asks for the folder Marquee is installed in — the one
containing `config.json` and `data\library.db` — and will not accept a folder
that has neither.

So:

| You have | Result |
|---|---|
| Marquee, scanned at least once | Works |
| Marquee installed but never scanned | Asks you to run a scan first |
| Plex, Jellyfin, Emby, Kodi | **Does not work.** There is nothing it can read. |
| A folder of media and no server | **Does not work.** |

Pointing it at a folder of films is not a supported mode and is not a setting
that has been overlooked — supporting it means building a scanner, which is a
different program from this one.

## Requirements

- **Windows.** Drive and volume handling, the disk-health check and the tray are
  all Windows-specific.
- **Marquee**, installed and scanned (see above).
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

ffmpeg is looked for in this order: the `ffmpegPath` in Marquee's `config.json`,
then a copy under the project's `tools/`, then plain `ffmpeg` on `PATH`.

## Running it

Double-click the executable. It opens a window and puts an icon in the tray.

- **Closing the window does not stop it.** It keeps working; the tray icon is
  how you know. Quit from the tray menu is how you actually stop it.
- **Start with Windows** is a tray-menu checkbox. It launches hidden, so the
  machine does not boot to a window nobody asked for.
- **Change library folder…** in the tray if Marquee moves.
- The window is at `http://localhost:8097`, bound to `127.0.0.1` only — it is
  not reachable from the network, which is why it has no password.

For a machine nobody sits at, `node optimizer/app.mjs` runs the same engine with
no window.

## Settings

In the window, and written back into Marquee's `config.json`:

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
| Log | `<Marquee folder>\data\optimizer.log` — "Open log folder" in the tray |
| Its own tables | `media_info` and `optimize_jobs` in Marquee's database |
| Chosen library folder | `%APPDATA%\Marquee Optimizer\library-location.json` |

## Building

```
node optimizer/build-app.mjs      # -> dist\Marquee Optimizer-win32-x64\
npm run test:optimizer            # the test suite
```

The version comes from `optimizer/package.json`.

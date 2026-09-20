# Roku parity tools

Local dev tooling for the Roku app. Nothing here ships to the Dell or the Roku.

- `sim-server.mjs` + `sim.html`: runs the Roku shell and library in the brs-engine
  simulator on port 8099, proxying the API to the dev server on 8096. Open
  `http://localhost:8099/?token=<session token>&debug=1` to use it by hand. The page has
  `key('up'|'down'|'left'|'right'|'select'|'back')` and `shot(name)` helpers.
- `scenarios.mjs` + `compare.mjs`: drives the Android TV web UI (`?tv=1`, 960x540 at
  DPR 2, the `MarqueeTV` bridge stubbed, trailers hidden) and the simulator with the
  same remote keys. Saves `out/<scenario>-<step>.web.png`, `.roku.png` and `.cmp.png`
  (web | roku | red diff), and prints where focus is on each side after every key.
- `bs-lib.json`, `bs-shell.json`: BrighterScript compile checks (`npm run check`).

## Run it

1. `npm install` in this folder.
2. Start the dev server (8096) and `npm run sim` (8099).
3. `MQ_TOKEN=<a session token on the dev server> npm run compare -- home rows`
   (no names = every scenario, which takes about 20 minutes).

Both apps pin the row shuffle to the same seed and freeze the hero (test-only launch
args `mqseed` / `mqfreeze` on the Roku, stubs on the web), so frames are comparable.

## Reading the results

A few percent of diff is text antialiasing and image scaling. Look at the `.cmp.png`
before believing a number. Known simulator artifacts are listed in
`roku/PARITY.md` (Simulator vs real Roku), so don't chase those in the app.

Each app runs in its own headless browser. A background tab pauses CSS transitions,
which once froze the web's search box mid-transition and looked like an app bug.

// Finding the library, and saying something useful when it cannot be found.
//
// What this replaces: a wrong guess at the install location produced "No
// library database at <path>" in an error box, and then an application sitting
// in the tray doing nothing, with no way to correct it short of editing JSON by
// hand. Fine on the machine it was written on; useless to anyone else.
//
// The question it asks is "where is Marquee", not "where is your media", and
// that is not pedantry: the optimizer has no scanner. Its work comes from
// movie_files and episode_files in Marquee's database, filled in by Marquee's
// own scan. Asking for a media folder would promise something it cannot do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rootProblems, loadSavedRoot, saveRoot } = require('../desktop/locate.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'locate-'));

// A folder that looks like a working Marquee install.
function install({ dbPath = null, db = true } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(dbPath ? { dbPath } : {}));
  if (db) {
    const p = path.resolve(dir, dbPath || 'data/library.db');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'sqlite');
  }
  return dir;
}

test('a real install has nothing wrong with it', () => {
  const dir = install();
  assert.deepEqual(rootProblems(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder that is not Marquee at all says so first', () => {
  const dir = tmp();
  const p = rootProblems(dir);
  assert.match(p[0], /not a Marquee folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config.json present but never scanned points at the scan, not at itself', () => {
  const dir = install({ db: false });
  const p = rootProblems(dir);
  assert.equal(p.length, 1);
  assert.match(p[0], /No library database/);
  // The fix is Marquee's, not the optimizer's, so the message has to say that
  // — otherwise the owner reasonably goes looking for a broken optimizer.
  assert.match(p[0], /Run Marquee once and let it scan/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database somewhere else is honoured, because config.json says where', () => {
  const dir = install({ dbPath: 'elsewhere/my.db' });
  assert.deepEqual(rootProblems(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dbPath that points nowhere names the path it actually looked at', () => {
  const dir = install({ dbPath: 'elsewhere/my.db', db: false });
  const p = rootProblems(dir).join('\n');
  assert.match(p, /elsewhere/, 'naming data\\\\library.db here would send the owner to the wrong place');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable config.json is reported rather than thrown', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const p = rootProblems(dir).join('\n');
  assert.match(p, /could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no folder at all is a problem, not a crash', () => {
  assert.deepEqual(rootProblems(null), ['No folder chosen.']);
  assert.deepEqual(rootProblems(''), ['No folder chosen.']);
});

// ---- remembering the answer ---------------------------------------------

test('a saved folder comes back', () => {
  const dir = install();
  const file = path.join(tmp(), 'nested', 'library-location.json');
  assert.equal(saveRoot(file, dir), true, 'must create its own directory');
  assert.equal(loadSavedRoot(file), dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a saved folder that has since gone is ignored rather than used', () => {
  const dir = install();
  const file = path.join(tmp(), 'library-location.json');
  saveRoot(file, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  // Returning a dead path would send the app back to the error box it used to
  // die in; returning null lets it fall through to the other candidates.
  assert.equal(loadSavedRoot(file), null);
});

test('a missing or corrupt saved file is just "nothing saved"', () => {
  const dir = tmp();
  assert.equal(loadSavedRoot(path.join(dir, 'nope.json')), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json at all');
  assert.equal(loadSavedRoot(bad), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving somewhere impossible reports false instead of throwing', () => {
  // Program Files is not writable, and a setup step that cannot save its answer
  // must still let the app run — it just asks again next time.
  const file = path.join(tmp(), 'f.json');
  fs.writeFileSync(file, '{}');
  assert.equal(saveRoot(path.join(file, 'under-a-file.json'), 'C:\\somewhere'), false);
});

// Settings are written into config.json, which the media server also owns.
//
// That file holds a TMDB key, an OpenSubtitles password, Radarr and Sonarr API
// keys and an invite code. So the one thing these tests exist to prove is that
// saving a setting cannot damage it: unknown keys survive, nothing else is
// rewritten, and a rejected value changes nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, writeSettings, SETTING_NAMES } from '../settings.mjs';

function root(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optset-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}
const configOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('defaults are returned when nothing is set', () => {
  const dir = root({});
  const s = readSettings(dir);
  assert.equal(s.pauseWhileWatching, true, 'pausing for playback must be the default');
  assert.equal(s.vmafPassMark, 95);
  assert.equal(s.optimizeWindow.always, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the media server's existing `port` is used when no explicit one is set", () => {
  const dir = root({ port: 9090 });
  assert.equal(readSettings(dir).mediaServerPort, 9090);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving a setting leaves every other key in config.json alone', () => {
  const secrets = {
    tmdbApiKey: 'SECRET-TMDB',
    openSubtitlesPassword: 'SECRET-OS',
    radarr: { url: 'http://127.0.0.1:7878', apiKey: 'SECRET-RADARR' },
    inviteCode: 'SECRET-INVITE',
    port: 8096,
    somethingAFutureVersionAdded: { nested: [1, 2, 3] }
  };
  const dir = root(secrets);

  writeSettings(dir, { pauseWhileWatching: false, vmafPassMark: 94 });

  const after = configOf(dir);
  assert.equal(after.tmdbApiKey, 'SECRET-TMDB');
  assert.equal(after.openSubtitlesPassword, 'SECRET-OS');
  assert.deepEqual(after.radarr, secrets.radarr);
  assert.equal(after.inviteCode, 'SECRET-INVITE');
  assert.deepEqual(after.somethingAFutureVersionAdded, { nested: [1, 2, 3] });
  assert.equal(after.pauseWhileWatching, false);
  assert.equal(after.vmafPassMark, 94);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a key the UI does not own cannot be written through it', () => {
  const dir = root({ tmdbApiKey: 'SECRET', dbPath: './data/library.db' });
  writeSettings(dir, { tmdbApiKey: 'STOLEN', dbPath: 'X:\\\\elsewhere.db', pauseWhileWatching: false });
  const after = configOf(dir);
  assert.equal(after.tmdbApiKey, 'SECRET', 'an API key must not be settable from the page');
  assert.equal(after.dbPath, './data/library.db');
  assert.equal(after.pauseWhileWatching, false, 'the allowed field still applies');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bad value is refused with a reason, and nothing is applied', () => {
  const dir = root({ port: 8096 });
  assert.throws(() => writeSettings(dir, { pauseWhileWatching: false, mediaServerPort: 70000 }),
    /port must be between/);
  // The whole call is rejected, so the good field in it must not have landed
  // either — half-applied settings are a state nobody asked for.
  assert.equal(configOf(dir).pauseWhileWatching, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the quality bar cannot be dropped to something meaningless', () => {
  const dir = root({});
  assert.throws(() => writeSettings(dir, { vmafPassMark: 10 }), /between 80 and 100/);
  assert.throws(() => writeSettings(dir, { vmafPassMark: 'off' }), /between 80 and 100/);
  assert.equal(writeSettings(dir, { vmafPassMark: 94 }).vmafPassMark, 94);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working hours have to be times', () => {
  const dir = root({});
  assert.throws(() => writeSettings(dir, { optimizeWindow: { from: '25:00', to: '05:00' } }), /not a time/);
  assert.throws(() => writeSettings(dir, { optimizeWindow: { from: 'midnight', to: '5am' } }), /not a time/);
  const ok = writeSettings(dir, { optimizeWindow: { from: '23:30', to: '06:15', always: false } });
  assert.deepEqual(ok.optimizeWindow, { from: '23:30', to: '06:15', always: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('around-the-clock is a flag, and survives a round trip', () => {
  const dir = root({});
  const saved = writeSettings(dir, { optimizeWindow: { always: true, from: '00:00', to: '05:00' } });
  assert.equal(saved.optimizeWindow.always, true);
  assert.equal(readSettings(dir).optimizeWindow.always, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config file with a BOM still reads and writes', () => {
  // Windows editors add one, and JSON.parse chokes on it. The media server
  // strips it when loading, so this has to as well or the first save throws.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optset-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '\uFEFF' + JSON.stringify({ tmdbApiKey: 'SECRET' }));
  assert.equal(readSettings(dir).vmafPassMark, 95);
  writeSettings(dir, { vmafPassMark: 93 });
  assert.equal(configOf(dir).tmdbApiKey, 'SECRET');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable config does not take the window down', () => {
  // The page asks for settings on load; throwing here would render it blank.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optset-'));
  assert.equal(readSettings(dir).pauseWhileWatching, true, 'no file at all: defaults');
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.equal(readSettings(dir).vmafPassMark, 95, 'unparseable: defaults');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing outside the declared list is writable', () => {
  // A tripwire. Every name here is something the page can change in a file that
  // also holds the media server's secrets, so growing this list should be a
  // deliberate act that shows up in a diff.
  assert.deepEqual(SETTING_NAMES.sort(),
    ['libraryFolders', 'mediaServerPort', 'optimizeWindow', 'pauseWhileWatching', 'vmafPassMark']);
});

// ---- folders to scan -----------------------------------------------------

test('folders accept a newline-separated list, as the page sends it', () => {
  const dir = root({});
  const s = writeSettings(dir, { libraryFolders: 'D:\\Media\\Movies\r\n\\\\NAS\\media\\TV\n' });
  assert.deepEqual(s.libraryFolders, ['D:\\Media\\Movies', '\\\\NAS\\media\\TV']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a trailing slash is trimmed, because it breaks the "is it under this root" test', () => {
  const dir = root({});
  assert.deepEqual(writeSettings(dir, { libraryFolders: ['D:\\Media\\'] }).libraryFolders, ['D:\\Media']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a relative path is refused — there is no cwd to resolve it against', () => {
  const dir = root({});
  assert.throws(() => writeSettings(dir, { libraryFolders: ['Movies'] }), /not a full path/);
  assert.throws(() => writeSettings(dir, { libraryFolders: ['.\\Movies'] }), /not a full path/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a UNC share is a valid folder, since that is where many libraries live', () => {
  const dir = root({});
  assert.deepEqual(writeSettings(dir, { libraryFolders: ['\\\\NAS\\media'] }).libraryFolders, ['\\\\NAS\\media']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicates are collapsed, including by case', () => {
  const dir = root({});
  const s = writeSettings(dir, { libraryFolders: ['D:\\Media', 'd:\\media', 'D:\\Media'] });
  assert.deepEqual(s.libraryFolders, ['D:\\Media']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('empty means "use Marquee", and is the default', () => {
  const dir = root({});
  assert.deepEqual(readSettings(dir).libraryFolders, []);
  assert.deepEqual(writeSettings(dir, { libraryFolders: '' }).libraryFolders, []);
  assert.deepEqual(writeSettings(dir, { libraryFolders: ['', '  '] }).libraryFolders, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

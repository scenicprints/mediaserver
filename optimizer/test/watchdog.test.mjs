// Restarting the optimizer if it stops.
//
// What this covers is not "does schtasks work" — that is Windows' job — but the
// one piece of logic that is ours and is easy to get wrong: the watchdog fires
// every few minutes whether or not anything is wrong, so an instance it starts
// while the app is ALREADY RUNNING must be silent. The default behaviour on a
// second instance is to show the window, which would raise it in the owner's
// face every five minutes, for ever, as the reward for turning the feature on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wd = require('../desktop/watchdog.cjs');

test('an instance the watchdog started is recognised', () => {
  assert.equal(wd.startedByWatchdog(['electron.exe', 'main.cjs', '--hidden', '--watchdog']), true);
});

test('an instance a PERSON started is not', () => {
  // Double-clicking the exe must still open the window.
  assert.equal(wd.startedByWatchdog(['Marquee Optimizer.exe']), false);
  // Started hidden by the login item is also not the watchdog: that is the
  // first instance, and it has its own reason not to show a window.
  assert.equal(wd.startedByWatchdog(['Marquee Optimizer.exe', '--hidden']), false);
});

test('the command it registers starts hidden AND marked as the watchdog', () => {
  const cmd = wd.taskCommand('C:\\Program Files\\Marquee Optimizer\\Marquee Optimizer.exe');
  assert.match(cmd, /--hidden/, 'a relaunch must not raise a window');
  assert.match(cmd, /--watchdog/, 'without this a relaunch of a running app shows the window');
  // The path has spaces in it on any normal install, and schtasks re-parses the
  // string it is given.
  assert.match(cmd, /^"C:\\Program Files\\Marquee Optimizer\\Marquee Optimizer\.exe"/);
  // And the flag the main process looks for must actually be in there.
  assert.equal(wd.startedByWatchdog(cmd.split(' ')), true);
});

test('it asks for no elevation and no stored password', () => {
  const args = wd.createArgs('C:\\x\\app.exe');
  assert.ok(!args.includes('/RL'), '/RL HIGHEST would demand administrator for a convenience');
  assert.ok(!args.includes('/RU'), 'another account would have no desktop for a tray app to live on');
  assert.ok(!args.includes('/RP'), 'no password should ever be stored for this');
});

test('it repeats on a sane interval, and replaces rather than duplicating', () => {
  const args = wd.createArgs('C:\\x\\app.exe');
  assert.deepEqual(args.slice(args.indexOf('/SC'), args.indexOf('/SC') + 4), ['/SC', 'MINUTE', '/MO', '5']);
  assert.ok(args.includes('/F'), 'without /F a second enable fails because the task already exists');

  const custom = wd.createArgs('C:\\x\\app.exe', 15);
  assert.equal(custom[custom.indexOf('/MO') + 1], '15');
});

test('the task has one fixed name, so it can be found and removed again', () => {
  assert.equal(typeof wd.TASK_NAME, 'string');
  assert.ok(wd.TASK_NAME.length > 0);
  assert.ok(wd.createArgs('C:\\x\\app.exe').includes(wd.TASK_NAME));
});

test('asking whether it is on never throws, whatever schtasks says', () => {
  // The tray menu is built from this. On a system where Task Scheduler is
  // locked down it has to answer false, not take the menu down with it.
  assert.equal(typeof wd.isEnabled(), 'boolean');
});

test('turning it off when it was never on is not an error', () => {
  assert.doesNotThrow(() => wd.disable());
});

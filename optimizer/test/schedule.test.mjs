// Does it only work when it is allowed to?
//
// The optimizer competes for the same disks, CPU and GPU as playback, and on
// this machine that showed up as a friend's film going choppy. Two rules now
// keep it out of the way, and both have a failure mode that is invisible until
// someone complains:
//
//   * the working window, 00:00–05:00, which CROSSES MIDNIGHT — the case that
//     a naive `from <= now && now < to` gets exactly backwards, running all day
//     and never at night;
//   * "is anyone watching", which used to fail OPEN. It asked an endpoint that
//     always answered 401, read that as "cannot tell", and carried on working.
//
// So both are tested here rather than in front of a viewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'engine-host.mjs'), 'utf8');

// The window helpers are internal to the module by design — nothing outside it
// should be deciding when the optimizer may run. Lift them out to test the
// actual implementation rather than a copy of it.
function loadHelpers() {
  const wanted = ['parseHM', 'withinWindow', 'minutesUntilOpen'];
  const bodies = wanted.map((name) => {
    const i = SRC.indexOf(`function ${name}(`);
    assert.notEqual(i, -1, `engine-host.mjs no longer defines ${name}() — has the schedule moved?`);
    // Take from the signature to the line with the closing brace at column 0.
    const rest = SRC.slice(i);
    const end = rest.indexOf('\n}\n');
    assert.notEqual(end, -1, `could not find the end of ${name}()`);
    return rest.slice(0, end + 2);
  }).join('\n');
  return new Function(`${bodies}\nreturn { ${wanted.join(', ')} };`)();
}

const { withinWindow, minutesUntilOpen, parseHM } = loadHelpers();
const at = (h, m = 0) => new Date(2026, 8, 10, h, m, 0);
const NIGHT = { from: '00:00', to: '05:00' };

test('the overnight window is open overnight and shut all day', () => {
  // The whole point: this window wraps past midnight.
  assert.equal(withinWindow(NIGHT, at(0, 0)), true, 'midnight exactly');
  assert.equal(withinWindow(NIGHT, at(2, 30)), true, 'the middle of it');
  assert.equal(withinWindow(NIGHT, at(4, 59)), true, 'one minute before it shuts');

  assert.equal(withinWindow(NIGHT, at(5, 0)), false, '05:00 is the end, not part of it');
  assert.equal(withinWindow(NIGHT, at(5, 1)), false);
  assert.equal(withinWindow(NIGHT, at(12, 0)), false, 'the middle of the day');
  assert.equal(withinWindow(NIGHT, at(20, 30)), false, 'prime viewing time');
  assert.equal(withinWindow(NIGHT, at(23, 59)), false, 'a minute before it opens');
});

test('a window inside one day still behaves', () => {
  const day = { from: '09:00', to: '17:00' };
  assert.equal(withinWindow(day, at(8, 59)), false);
  assert.equal(withinWindow(day, at(9, 0)), true);
  assert.equal(withinWindow(day, at(16, 59)), true);
  assert.equal(withinWindow(day, at(17, 0)), false);
});

test('it says how long until it may work again', () => {
  assert.equal(minutesUntilOpen(NIGHT, at(23, 0)), 60, 'an hour before midnight');
  assert.equal(minutesUntilOpen(NIGHT, at(20, 0)), 240, 'four hours before midnight');
  assert.equal(minutesUntilOpen(NIGHT, at(6, 0)), 18 * 60, 'just missed it — wait for tonight');
});

test('a malformed window falls back rather than running at all hours', () => {
  // A typo in config.json must not become "work whenever you like".
  assert.equal(parseHM('nonsense', 0), 0);
  assert.equal(parseHM('', 5 * 60), 5 * 60);
  assert.equal(parseHM('25:99', 0), 23 * 60 + 59, 'out-of-range values are clamped, not wrapped');
  assert.equal(withinWindow({ from: 'x', to: 'y' }, at(20, 0)), false,
    'an unreadable window falls back to the overnight default, so 8pm is still shut');
});

// ---- the rule that actually failed --------------------------------------

test('the viewer check fails CLOSED', () => {
  // Read from the source, because the behaviour that matters is a default, and
  // a default is easy to invert by accident.
  const i = SRC.indexOf('async function someoneWatching()');
  assert.notEqual(i, -1, 'someoneWatching() has moved');
  const body = SRC.slice(i, SRC.indexOf('\n  }', i));

  assert.match(body, /api\/local\/activity/,
    'it must ask the loopback endpoint, not the admin one that always answered 401');
  assert.match(body, /return true;/,
    'an unexpected answer must mean "someone is watching"');
  assert.doesNotMatch(body, /if \(res\.status === 401 \|\| res\.status === 403\) return null;/,
    'the 401-means-carry-on path must be gone');

  // Only one thing may conclude that nobody is watching without being told so:
  // a server that is not running.
  assert.match(body, /ECONNREFUSED/,
    'nothing listening is the one case that safely means nobody is watching');
});

test('the work loop checks the window before and during a job', () => {
  assert.match(SRC, /if \(!withinWindow\(workWindow\)\) return;/,
    'a run must not start outside the window');
  assert.match(SRC, /working hours are over — finishing up/,
    'a job in flight must be stopped when the window closes');
  assert.match(SRC, /engine\.worker\.stop = true/,
    'stopping must go through worker.stop, which requeues the file and clears its temp');
});

test('scanning is not gated — only the encoding is', () => {
  // Reading headers is cheap and keeps the library current around the clock;
  // it is rewriting files that has to wait for the small hours.
  const once = SRC.slice(SRC.indexOf('async function once()'));
  const scanAt = once.indexOf('runProbeScan');
  const gateAt = once.indexOf('if (!withinWindow(workWindow)) return;');
  assert.ok(scanAt !== -1 && gateAt !== -1);
  assert.ok(scanAt < gateAt, 'the probe scan should happen before the window check, not after it');
});

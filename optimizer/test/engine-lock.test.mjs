// When is the optimizer's lock really held?
//
// On 2026-09-17 the machine rebooted and the optimizer never came back. The lock
// file from two days earlier named pid 7404; after the reboot 7404 belonged to
// Chrome Remote Desktop's remoting_host.exe. "Is that pid alive?" said yes, so
// every start concluded another optimizer was running and quietly declined -
// with the desktop app's only complaint a dialog on a screen nobody watches.
//
// These pin the rule down with injected clocks and process tables, so none of it
// depends on what happens to be running on the machine executing the tests.
import test from 'node:test';
import assert from 'node:assert/strict';

import { lockIsStale } from '../engine-host.mjs';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 17, 17, 30);
const UPTIME = 2 * 3600;                         // booted two hours ago
const alive = () => true;
const dead = () => false;
const named = (n) => () => n;

test('a lock written before the last boot is stale, whatever holds that pid now', () => {
  // The real case: an optimizer pid from two days ago, reused after the reboot.
  const held = { pid: 7404, at: NOW - 48 * HOUR };
  assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: named('remoting_host.exe') }), true);
  // Even if the reused pid happened to land on another node process.
  assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: named('node.exe') }), true);
});

test('a live pid that is not an optimizer does not hold the lock', () => {
  const held = { pid: 7404, at: NOW - 30 * 60 * 1000 };   // written this boot
  assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: named('remoting_host.exe') }), true);
  assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: named('chrome.exe') }), true);
});

test('a running optimizer from this boot keeps its lock', () => {
  const held = { pid: 5224, at: NOW - 30 * 60 * 1000 };
  for (const name of ['Marquee Optimizer.exe', 'node.exe', 'electron.exe']) {
    assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: named(name) }), false, name);
  }
});

test('a dead pid never holds the lock', () => {
  assert.equal(lockIsStale({ pid: 5224, at: NOW - 60 * 1000 }, { now: NOW, uptimeSec: UPTIME, isAlive: dead, nameOf: named('node.exe') }), true);
});

test('when the process cannot be identified, the lock is respected', () => {
  // Running twice means two encoders on the same disks. Refusing costs a start.
  const held = { pid: 5224, at: NOW - 60 * 1000 };
  assert.equal(lockIsStale(held, { now: NOW, uptimeSec: UPTIME, isAlive: alive, nameOf: () => undefined }), false);
});

test('a malformed lock is stale', () => {
  assert.equal(lockIsStale(null), true);
  assert.equal(lockIsStale({}), true);
});

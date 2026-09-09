// Live TV has no controls that change where you are in the stream.
//
// No seeking, no scrubbing, no play/pause, no Skip Intro, no Skip Credits. A
// channel runs to a schedule; every one of those is a promise the player cannot
// keep.
//
// This exists because that rule kept being true in ONE client and quietly false
// in another. The web has enforced it for a long time; the Apple TV player
// shipped a full scrub bar, a position clock, D-pad seeking and a pause button
// on live channels, and the Android player let the OK key pause one. Each was
// found by a person watching television, which is the worst possible test rig.
//
// So: three clients, three languages, one set of rules, checked at the source.
// Grepping source text is a blunt instrument, but the alternative is building
// and driving three apps to assert something that is really a statement about
// the code — and a blunt check that runs on every push beats a precise one that
// never gets written.
//
// When a guard legitimately moves, update the pattern here in the same commit.
// A failure means "a client can do this on a live channel again", so read it
// before you edit it.
//
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const WEB = 'public/app.js';
const WEB_CSS = 'public/style.css';
const ATV = 'appletv/Sources/PlayerView.swift';
const AND = 'androidtv/app/src/main/java/com/scenicprints/marquee/PlayerActivity.kt';

// Every file must exist; a rename that silently skips these checks is exactly
// the failure mode this file is here to prevent.
test('the three client players are where the rules expect them', () => {
  for (const p of [WEB, WEB_CSS, ATV, AND]) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} is missing — update this test's paths`);
  }
});

// ---- helpers -----------------------------------------------------------

/** Collapse whitespace so a reformat doesn't fail an unrelated rule. */
const flat = (s) => s.replace(/\s+/g, ' ');

function requires(file, patterns, why) {
  const src = flat(read(file));
  for (const p of patterns) {
    assert.ok(p.test(src), `${file}: ${why}\n  expected to find: ${p}`);
  }
}

// ---- No seeking --------------------------------------------------------

test('web: seeking is blocked on a live feed', () => {
  requires(WEB, [
    // The chokepoint every seek path funnels through.
    /async function seekTo\(t\) \{.{0,400}?if \(live\) return;/,
  ], 'seekTo() must refuse when live');
  requires(WEB_CSS, [
    // The scrub bar and transport are not merely disabled, they are not there.
    /\.vp-live \.vp-scrub[^{]*\{ display: none/,
  ], 'the scrub bar/transport must be hidden on a live feed');
});

test('apple tv: seeking is blocked on a live channel', () => {
  requires(ATV, [
    /func jump\(_ s: Int\) \{ .{0,400}?guard !live else \{ return \}/,
    // The scrubber is the D-pad's seek surface — it must not be rendered.
    /if !live \{ scrubber \}/,
    // The scrub path added for the janky-seeking fix: a nudge moves a target
    // and seek(to:) is the single place a seek actually happens. Both refuse.
    /func nudge\(_ seconds: Double\) \{ guard !live,/,
    /func seek\(to t: Double\) \{ guard !live else \{ return \}/,
  ], 'every seek path must refuse when live AND the scrubber must not be rendered');
});

test('android tv: seeking is blocked on a live channel', () => {
  requires(AND, [
    /private fun seekBy\(deltaSec: Int\) \{ if \(live \|\| inPreroll\) return/,
  ], 'seekBy() must refuse when live');
});

// ---- No play/pause -----------------------------------------------------

test('web: a live feed cannot be paused', () => {
  requires(WEB, [
    /function togglePlay\(\) \{ if \(live\) return;/,
    /function pauseNow\(\) \{ if \(!live\)/,
    // The OS/lock-screen media keys must not be wired up at all for live.
    /if \('mediaSession' in navigator && !live\)/,
  ], 'every pause path must refuse when live');
});

test('apple tv: a live channel cannot be paused', () => {
  requires(ATV, [
    /func togglePlay\(\) \{ .{0,400}?guard !live else \{ return \}/,
    // The button is absent, not inert: an inert pause button still reads as a
    // promise the player cannot keep.
    /if !live \{ glassButton\(m\.isPlaying \? "pause\.fill" : "play\.fill"/,
  ], 'togglePlay() must refuse when live AND the play button must not be rendered');
});

test('android tv: a live channel cannot be paused', () => {
  requires(AND, [
    /private fun togglePause\(\) \{ .{0,400}?if \(live\) return/,
    // The ❚❚ / ▶ indicator means nothing when the state cannot change.
    /visibility = if \(live\) View\.GONE else View\.VISIBLE/,
  ], 'togglePause() must refuse when live AND the play indicator must be hidden');
});

test('android tv: the remote hint does not advertise pausing a channel', () => {
  const src = read(AND);
  const m = /text = if \(live\) "([^"]*)"/.exec(src);
  assert.ok(m, 'could not find the live remote-hint string');
  assert.doesNotMatch(m[1], /pause/i, `the live hint still offers pause: "${m[1]}"`);
  assert.doesNotMatch(m[1], /±10s|10s/i, `the live hint still offers seeking: "${m[1]}"`);
});

// ---- No Skip Intro / Skip Credits --------------------------------------

test('web: neither skip card appears on a live feed', () => {
  requires(WEB, [
    /if \(live\) \{ skipIntro\.classList\.add\('hidden'\); skipCredits\.classList\.add\('hidden'\); return; \}/,
  ], 'updateSkipButtons() must hide both and return when live');
  requires(WEB_CSS, [/\.vp-live \.vp-skipbtn \{ display: none/], 'skip buttons must be hidden on a live feed');
});

test('apple tv: neither skip card appears on a live channel', () => {
  requires(ATV, [
    // No intro range is even fetched for a channel.
    /if kind == "episode", !live, !offline,/,
    /func skipIntro\(\) \{ guard !live,/,
    /private func updateSkipCredits\(\) \{ guard !live,/,
  ], 'both skip controls must be gated on !live');
});

test('android tv: neither skip card appears on a live channel', () => {
  requires(AND, [
    /val inIntro = !live &&/,
    /val inCredits = !live &&/,
    /private fun skipIntroNow\(\) \{ .{0,400}?if \(live\) return/,
    /private fun skipCreditsNow\(\) \{ if \(creditsTaken \|\| live/,
  ], 'both skip controls must be gated on !live, at the button AND at the action');
});

// ---- The rule that started all this ------------------------------------

test('all three clients have BOTH skip controls, not just Skip Intro', () => {
  // Skip Intro shipped everywhere and Skip Credits only on the web, which is
  // what a viewer noticed: the pair looked broken rather than absent.
  assert.match(read(WEB), /vp-skipcredits/, 'web lost Skip Credits');
  assert.match(read(ATV), /func skipCredits\(\)/, 'apple tv lost Skip Credits');
  assert.match(read(AND), /private fun skipCreditsNow\(\)/, 'android tv lost Skip Credits');

  assert.match(read(WEB), /vp-skipintro/, 'web lost Skip Intro');
  assert.match(read(ATV), /func skipIntro\(\)/, 'apple tv lost Skip Intro');
  assert.match(read(AND), /private fun skipIntroNow\(\)/, 'android tv lost Skip Intro');
});

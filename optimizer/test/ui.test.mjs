// Does the page it serves actually run?
//
// A syntax error in that page does not look like an error. The HTML still
// renders, every heading is there, every button is there — and nothing works,
// because the whole script died at parse time and every field sits at whatever
// the markup said before the first update. It reads as "connecting…" for ever.
//
// That happened. Twice, in fact, from the same cause both times: the page is a
// template literal built inside a Node module, so a `\n` meant for the browser
// has to survive being written by a tool, stored in a string, and interpolated —
// and one that does not survive turns into a real newline in the middle of a
// string literal and takes the whole file with it.
//
// So the page gets parsed here, in the build, rather than in front of the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE } from '../ui.mjs';

function scriptOf(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'the page has no inline script — did the markup change?');
  return m[1];
}

test('the page it serves is valid JavaScript', () => {
  const js = scriptOf(PAGE);
  try {
    // Compiles without running: catches syntax errors, touches no DOM.
    new Function(js);
  } catch (e) {
    // Point at the offending line, because "Invalid or unexpected token" on its
    // own sends you hunting through three hundred lines.
    const lines = js.split('\n');
    let bad = 0;
    for (let i = 1; i <= lines.length; i++) {
      try { new Function(lines.slice(0, i).join('\n')); }
      catch (err) { if (err instanceof SyntaxError) { bad = i; break; } }
    }
    assert.fail(`page script does not parse: ${e.message}\n` +
      `  first bad line ${bad}: ${(lines[bad - 1] || '').trim().slice(0, 160)}`);
  }
});

test('no string literal was broken by a real newline', () => {
  // The specific failure both times. A quote that opens on one line and does
  // not close on it is almost always an escape that did not survive.
  const js = scriptOf(PAGE);
  js.split('\n').forEach((line, i) => {
    // Ignore comments and lines with no quotes at all.
    const code = line.replace(/\/\/.*$/, '');
    for (const q of ["'", '"']) {
      // Count unescaped quotes; an odd number means one is left open.
      const n = (code.match(new RegExp(`(?<!\\\\)${q}`, 'g')) || []).length;
      assert.equal(n % 2, 0,
        `line ${i + 1} leaves a ${q} quote open — an escape probably became a real newline:\n  ${line.trim().slice(0, 160)}`);
    }
  });
});

test('the page is themed and self-contained', () => {
  // It loads inside a desktop window with no network, so an external stylesheet
  // or script would simply never arrive.
  assert.doesNotMatch(PAGE, /<link[^>]+href=["']https?:/i, 'no external stylesheets');
  assert.doesNotMatch(PAGE, /<script[^>]+src=["']https?:/i, 'no external scripts');
  assert.match(PAGE, /--signal:\s*#F26A16/i, 'the Braun signal colour should be defined');
  assert.match(PAGE, /background:\s*var\(--paper\)/i, 'the body should paint its own ground');
});

test('every element the script drives exists in the markup', () => {
  const js = scriptOf(PAGE);
  const ids = new Set();
  for (const m of js.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size > 5, 'expected the script to address several elements');
  for (const id of ids) {
    assert.match(PAGE, new RegExp(`id="${id}"`),
      `the script updates #${id}, but nothing in the markup has that id`);
  }
});

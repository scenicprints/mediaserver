// Picking the right TMDB entry for a file.
//
// TMDB orders search results by POPULARITY, and the old code took results[0]
// without asking anything further. That is how a small 2020 film called "Dead"
// got Dead Poets Society' poster, plot and rating. Wrong metadata is worse than
// none: it looks fine until you happen to read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMatch, scoreCandidate } from '../src/tmdb.js';

// Shaped like a TMDB search result, with only the fields the matcher reads.
const m = (title, date, popularity = 1, extra = {}) =>
  Object.assign({ id: Math.floor(Math.random() * 1e6), title, release_date: date, popularity }, extra);

test('the reported bug: "Dead" (2020) is not Dead Poets Society', () => {
  // TMDB really does return the famous one first for this query.
  const results = [
    m('Dead Poets Society', '1989-06-02', 40),
    m('Dead', '2020-10-16', 1.2)
  ];
  const hit = pickMatch(results, 'Dead', 2020);
  assert.equal(hit.title, 'Dead');
  assert.equal(hit.release_date, '2020-10-16');
});

test('and if the right film is missing entirely, it matches nothing at all', () => {
  // Better a blank poster than confidently the wrong film.
  const hit = pickMatch([m('Dead Poets Society', '1989-06-02', 40)], 'Dead', 2020);
  assert.equal(hit, null);
});

test('popularity cannot outrank the year', () => {
  const results = [
    m('The Thing', '2011-10-14', 30),   // the prequel, more popular on TMDB
    m('The Thing', '1982-06-25', 20)
  ];
  assert.equal(pickMatch(results, 'The Thing', 1982).release_date, '1982-06-25');
  assert.equal(pickMatch(results, 'The Thing', 2011).release_date, '2011-10-14');
});

test('popularity still breaks a genuine tie', () => {
  const results = [m('Twins', '1988-12-09', 5), m('Twins', '1988-12-09', 25)];
  assert.equal(pickMatch(results, 'Twins', 1988).popularity, 25);
});

test('an exact title survives a wrong year on the file', () => {
  // A year typed into a filename is wrong far more often than a film is missing
  // from TMDB, so an exact title still matches. The year decides which of two
  // same-named films wins (see the remake test), not whether to match at all.
  assert.ok(pickMatch([m('Brazil', '1985-02-20', 10)], 'Brazil', 1984), 'one-year drift');
  assert.ok(pickMatch([m('Brazil', '1985-02-20', 10)], 'Brazil', 1999), 'badly typed year');
});

test('but a PARTIAL title with a wrong year matches nothing', () => {
  // This is the pairing that produced the bug: a shared opening and a year that
  // disagrees is not evidence of anything.
  assert.equal(pickMatch([m('Dead Poets Society', '1989-06-02', 40)], 'Dead', 1989 + 1), null);
  assert.equal(pickMatch([m('The Iron Giant', '1999-08-06', 20)], 'The Iron', 2015), null);
});

test('punctuation, case, accents and ampersands are not differences', () => {
  assert.ok(pickMatch([m('WALL·E', '2008-06-22')], 'Wall-E', 2008));
  assert.ok(pickMatch([m('Amélie', '2001-04-25')], 'Amelie', 2001));
  assert.ok(pickMatch([m('Fire & Ice', '1983-08-26')], 'Fire and Ice', 1983));
  assert.ok(pickMatch([m("Ocean's Eleven", '2001-12-07')], 'Oceans Eleven', 2001));
  assert.ok(pickMatch([m('Spider-Man: No Way Home', '2021-12-15')], 'Spider Man No Way Home', 2021));
});

test('a leading article is not a difference either', () => {
  assert.ok(pickMatch([m('The Fellowship of the Ring', '2001-12-19')], 'Fellowship of the Ring', 2001));
});

test('a long official title still matches the short name on the file', () => {
  // The extra-words penalty must not throw these away.
  assert.ok(pickMatch(
    [m('Dr. Strangelove or: How I Learned to Stop Worrying and Love the Bomb', '1964-01-29')],
    'Dr Strangelove', 1964));
  assert.ok(pickMatch(
    [m('Birdman or (The Unexpected Virtue of Ignorance)', '2014-08-27')],
    'Birdman', 2014));
});

test('extra branding on the file name is not suspicious', () => {
  // The safe direction: OUR title is the longer one.
  assert.ok(pickMatch([m('Daredevil', '2015-04-10')], "Marvel's Daredevil", null));
  assert.ok(pickMatch([m('The Clone Wars', '2008-08-15')], 'Star Wars The Clone Wars', 2008));
});

test('a sequel does not answer for the original', () => {
  const results = [m('Aliens', '1986-07-18', 30), m('Alien', '1979-05-25', 25)];
  assert.equal(pickMatch(results, 'Alien', 1979).title, 'Alien');
  assert.equal(pickMatch(results, 'Aliens', 1986).title, 'Aliens');
});

test('a numbered sequel is not its predecessor', () => {
  const results = [m('Blade Runner', '1982-06-25', 40), m('Blade Runner 2049', '2017-10-04', 30)];
  assert.equal(pickMatch(results, 'Blade Runner 2049', 2017).title, 'Blade Runner 2049');
  assert.equal(pickMatch(results, 'Blade Runner', 1982).title, 'Blade Runner');
});

test('original_title counts, for a film released under another name', () => {
  const hit = pickMatch(
    [m('The Wages of Fear', '1953-04-22', 8, { original_title: 'Le Salaire de la peur' })],
    'Le Salaire de la peur', 1953);
  assert.ok(hit);
});

test('a one-word file name will not take a longer famous title', () => {
  // The general form of the reported bug, with no year to help.
  assert.equal(pickMatch([m('Heat Wave', '1990-01-01', 20)], 'Heat', null), null);
  assert.equal(pickMatch([m('Up in the Air', '2009-09-05', 30)], 'Up', null), null);
  // ...but the real one still wins when it is there.
  const results = [m('Up in the Air', '2009-09-05', 30), m('Up', '2009-05-28', 28)];
  assert.equal(pickMatch(results, 'Up', 2009).title, 'Up');
});

test('nothing in common means no match, whatever the year says', () => {
  assert.equal(pickMatch([m('Casablanca', '1942-01-23', 50)], 'Predator', 1987), null);
});

test('empty and malformed input does not throw', () => {
  assert.equal(pickMatch([], 'Dead', 2020), null);
  assert.equal(pickMatch(null, 'Dead', 2020), null);
  assert.equal(pickMatch([m('Dead', '2020-10-16')], '', 2020), null);
  assert.equal(pickMatch([{ id: 1 }], 'Dead', 2020), null);
  assert.ok(Number.isFinite(scoreCandidate(m('Dead', '2020-10-16'), 'Dead', 2020)));
});

test('TV results are scored the same way, off first_air_date', () => {
  const t = (name, date, popularity = 1) => ({ id: 1, name, first_air_date: date, popularity });
  const results = [t('The Office', '2005-03-24', 50), t('The Office', '2001-07-09', 20)];
  assert.equal(pickMatch(results, 'The Office', 2001).first_air_date, '2001-07-09');
  assert.equal(pickMatch(results, 'The Office', 2005).first_air_date, '2005-03-24');
});

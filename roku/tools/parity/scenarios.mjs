// Drives the Android TV web UI and the Roku simulator with the same remote keys,
// saves web / roku / composite+diff frames to ./out and prints where focus is on
// each side after every key. See README.md.
//   MQ_TOKEN=<session token> node scenarios.mjs [name ...]
import { run } from './compare.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (n) => Array(n).fill('right'); const D = (n) => Array(n).fill('down');
const L = (n) => Array(n).fill('left'); const U = (n) => Array(n).fill('up');

// Screens: every view, in the Black finish.
const SCREENS = {
  home: [['snap','load'], 'down', 'down', ['snap','play'], 'right', ['snap','moreinfo'], ['k','ok',3500], ['snap','detail'], ...D(2), ['snap','detail-d2'], ...D(4), ['snap','detail-d6'], ['k','back',3000], ['snap','closed']],
  rows: [...D(3), ['snap','card1'], ...R(2), ['snap','card3'], 'down', ['snap','row2'], 'down', ['snap','row3'], ...D(3), ['snap','row6'], 'left', ['snap','row6-left'], 'up', ['snap','row5']],
  tabs: ['down', 'right', ['k','ok',3500], ['snap','movies'], ...D(3), ['snap','movies-rows'], 'up','up','up','up', 'right', ['k','ok',3500], ['snap','tv'], ...D(3), ['snap','tv-rows']],
  show: [...D(3), ...R(3), ['snap','office-card'], ['k','ok',4000], ['snap','show'], ...D(2), ['snap','show-d2'], ...D(3), ['snap','show-d5'], ['k','ok',4000], ['snap','episode'], 'down', ['snap','episode-d1'], ['k','back',3000], ['snap','ep-back']],
  live: ['down', ...R(3), ['k','ok',4000], ['snap','live'], 'down', ['snap','live-d1'], 'down', ['snap','live-d2'], 'up', 'up', 'up', ['snap','live-up3']],
  library: ['down', ...R(4), ['k','ok',4000], ['snap','library'], 'down', ['snap','lib-d1'], ...D(3), ['snap','lib-d4'], 'left', ['snap','lib-left']],
  collections: ['down', ...R(5), ['k','ok',4000], ['snap','coll'], 'down', ['snap','coll-d1'], 'right', ['snap','coll-r1'], ['k','ok',4000], ['snap','coll-open']],
  settings: ['down', ...R(7), ['snap','gear'], ['k','ok',3500], ['snap','settings'], 'down', ['snap','set-d1'], ...D(3), ['snap','set-d4'], ['k','back',2500], ['snap','set-closed']],
  requests: ['down', ...R(7), ['k','ok',3500], 'down', ['k','ok',4000], ['snap','tab'], 'down', ['snap','d1'], ...D(3), ['snap','d4']],
  streaming: ['down', ...R(7), ['k','ok',3500], 'down', 'left', ['k','ok',3000], ['snap','tab'], 'down', ['snap','d1'], ...D(3), ['snap','d4']],
  audio: ['down', ...R(7), ['k','ok',3500], 'down', 'left', 'left', ['k','ok',3000], ['snap','tab'], 'down', ['snap','d1'], ...D(4), ['snap','d5'], ...D(4), ['snap','d9']],
  display: ['down', ...R(7), ['k','ok',3500], 'down', 'left', 'left', 'left', ['k','ok',3000], ['snap','tab'], 'down', ['snap','d1']],
  general: ['down', ...R(7), ['k','ok',3500], ...D(5), ['snap','d5'], ...D(4), ['snap','d9'], ...D(4), ['snap','d13']],
};

// Behaviour: focus paths through the hero, detail, show, Back, A-Z rail, collections.
const BEHAVIOUR = {
  hero: ['down', 'down', 'right', 'down', ['snap','after-more-down'], 'up', 'up', 'left', 'left', 'right', 'right', 'right', ['snap','end']],
  detail: ['down', 'down', 'right', ['k','ok',3500], 'right', 'right', 'right', 'left', 'left', 'left', 'down', 'down', 'right', 'right', 'up', 'up', 'up', 'up', ['k','back',3000], 'down', ['snap','end']],
  showctl: [...D(3), ...R(3), ['k','ok',4000], 'right', 'down', 'right', 'down', 'right', 'left', 'down', 'right', 'up', 'up', 'up', 'up', ['snap','end']],
  back: [...D(4), ['k','back',1500], 'down', 'down', ['k','back',1500], ['k','back',1500], 'right', ['k','ok',3000], 'down', ['k','back',1500], ['snap','end']],
  lib: ['down', ...R(4), ['k','ok',4000], 'down', 'down', ...L(1), 'down', 'down', 'up', ['k','ok',2500], ['snap','az'], 'right', 'right', ['k','back',1500], ['snap','end']],
  coll: ['down', ...R(5), ['k','ok',4000], 'down', 'down', 'right', ['k','ok',4000], ['snap','open'], 'down', 'down', 'right', ['k','back',2500], ['snap','back']],
};

// Search: the web types into the focused field; the Roku types on its keyboard dialog.
const typeD = ['fn', async (h) => {
  await h.web.keyboard.type('d');
  for (const k of ['right', 'right', 'right', 'right', 'select']) { await h.roku.evaluate((kk) => window.key(kk), k); await sleep(450); }
  await sleep(2500);
  await h.roku.evaluate(() => window.key('back'));
  await sleep(1500);
  return 'typed d';
}];
const white = ['down', ...R(7), ['k', 'ok', 3500], 'down', 'left', 'left', 'left', ['k', 'ok', 3000], 'down', 'right', ['k', 'ok', 3000], ['k', 'back', 2500]];
const OTHER = {
  search: ['down', ...R(6), ['k', 'ok', 1500], typeD, ['snap', 'results'], 'down', ['snap', 'results-d1'], 'right', 'right', ['snap', 'results-r2']],
  seeall: [...D(4), 'left', ['k', 'ok', 3500], ['snap', 'grid'], 'down', ['snap', 'grid-d1'], 'down', 'down', ['snap', 'grid-d3'], ['k', 'back', 3000], ['snap', 'back']],
  white: [...white, 'down', 'down', 'up', 'up', ...R(3), ['k', 'ok', 4000], ['snap', 'live'], ['k', 'back', 1500], 'right', ['k', 'ok', 4000], ['snap', 'lib'], 'down', 'down', ['snap', 'lib-card'], ['k', 'back', 1500], 'right', ['k', 'ok', 4000], ['snap', 'coll'], ['k', 'back', 1500], 'right', 'right', ['k', 'ok', 3500], ['snap', 'settings']],
};

const ALL = { ...SCREENS, ...BEHAVIOUR, ...OTHER };
const which = process.argv.slice(2);
for (const [n, st] of Object.entries(ALL)) {
  if (which.length && !which.includes(n)) continue;
  console.log('=== ' + n);
  console.log(await run(n, st));
}
if (!which.length || which.includes('login')) {
  console.log('=== login');
  console.log(await run('login', [['snap', 'card'], 'down', ['snap', 'd1'], 'down', ['snap', 'd2'], 'down', ['snap', 'd3'], 'down', ['snap', 'd4']], { loggedOut: true }));
}

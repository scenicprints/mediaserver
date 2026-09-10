// The headless optimizer.
//
// The same program as the desktop application, without a window: for running as
// a service, from Task Scheduler, or on a machine nobody is sitting at. The
// work itself is startEngine() in engine-host.mjs — the identical function the
// desktop app calls — so the two cannot drift apart. This file is only what a
// windowless process has to do for itself: find the library, refuse to be
// started twice, and stay alive.
//
// run.mjs remains the command line. It is a script built on top-level await,
// which is right for typing at and wrong for packaging, since Node's single
// executable format takes a CommonJS entry and CommonJS cannot have it.
import fs from 'node:fs';
import path from 'node:path';

import { startEngine } from './engine-host.mjs';

function findRoot() {
  const here = path.dirname(process.execPath);
  const candidates = [
    path.resolve(here, '..'),          // dist/MarqueeOptimizer.exe -> project root
    here,                              // exe sitting in the project root
    'C:\\mediaserver',
    process.cwd()
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'config.json'))) return c;
  return process.cwd();
}

const ROOT = findRoot();

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function say(m) { try { console.log(`[${stamp()}] ${m}`); } catch {} }

// The one-at-a-time guard lives in startEngine, so every way in — this, the
// desktop application, the command line — shares it.
async function main() {
  let port = 8097;
  try { port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).optimizerUiPort || 8097; } catch {}

  try {
    await startEngine({ root: ROOT, port });
  } catch (e) {
    // Another copy already working is a normal outcome, not a failure: the
    // scheduler starting this while the desktop app runs should be quiet.
    if (e && e.code === 'ALREADY_RUNNING') { say(e.message); return; }
    say('could not start: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }

  // startEngine returns as soon as its loop is running; hold the process open.
  await new Promise(() => {});
}

main().catch((e) => { say('fatal: ' + (e && e.stack || e)); process.exitCode = 1; });

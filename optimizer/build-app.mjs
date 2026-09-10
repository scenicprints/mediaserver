// Package Marquee Optimizer as a Windows application.
//
// Produces dist/Marquee Optimizer-win32-x64/Marquee Optimizer.exe — a real
// program with its own window, taskbar entry and tray icon, that runs on a
// machine with nothing installed.
//
// The app root is optimizer/ rather than optimizer/desktop/, because the window
// is the smallest part of this: main.cjs imports the engine from one directory
// up, and packaging only the desktop folder would ship a window with nothing
// behind it.
//
//   node optimizer/build-app.mjs
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'dist');

const opts = {
  dir: HERE,
  out: OUT,
  name: 'Marquee Optimizer',
  appVersion: '1.0.0',
  // Stated explicitly rather than inferred from the app package.json: the
  // optimizer is not an npm project with electron as a dependency, it is a
  // folder of source that happens to be launched by one.
  electronVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  // asar keeps the source out of casual view and speeds up start-up. It is not
  // security — anyone can unpack it — but it does stop the app looking like a
  // folder of loose script files.
  asar: true,
  // Tests and build scripts are not part of the application.
  ignore: [
    /^\/test($|\/)/,
    /^\/build-exe\.mjs$/,
    /^\/build-app\.mjs$/,
    /^\/run\.mjs$/,          // the CLI stays a CLI; the app does not shell out to it
    /\.md$/
  ],
  win32metadata: {
    CompanyName: 'scenicprints',
    FileDescription: 'Marquee Optimizer',
    ProductName: 'Marquee Optimizer',
    OriginalFilename: 'Marquee Optimizer.exe'
  }
};

const [appPath] = await packager(opts);
const exe = path.join(appPath, 'Marquee Optimizer.exe');

if (!fs.existsSync(exe)) {
  console.error('packaging finished but no executable was produced at ' + exe);
  process.exit(1);
}

// Total size of the produced application, which is mostly Chromium and worth
// knowing before wondering where 200 MB went.
let total = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { try { total += fs.statSync(p).size; } catch {} }
  }
})(appPath);

console.log(`\n${exe}`);
console.log(`application folder: ${(total / 1024 / 1024).toFixed(0)} MB`);
console.log('Double-click the exe. It works in the background and lives in the tray.');

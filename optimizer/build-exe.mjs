// Build MarqueeOptimizer.exe.
//
// The optimizer is a real program now, so it should be a real program to start:
// something you double-click, not a node command someone has to remember. This
// bundles it into a single Windows executable with Node's own SEA support — the
// exe IS node, with the whole optimizer baked into it, so it runs on a machine
// with no Node installed and nothing to keep in step.
//
// Two steps, both from tools that ship with the project rather than a toolchain
// to maintain:
//   1. esbuild flattens the ESM sources into one CommonJS file, because SEA
//      takes a single CJS entry and the optimizer is a dozen ES modules.
//   2. postject injects that blob into a copy of node.exe.
//
// node:sqlite, node:http and ffmpeg are all external to this: sqlite and http
// are built into node (so they come along inside the exe for free), and ffmpeg
// is a separate binary the exe shells out to exactly as before.
//
//   node optimizer/build-exe.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'dist');
const BUNDLE = path.join(OUT, 'optimizer.cjs');
const SEA_CFG = path.join(OUT, 'sea-config.json');
const BLOB = path.join(OUT, 'optimizer.blob');
const EXE = path.join(OUT, 'MarqueeOptimizer.exe');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, windowsHide: true, ...opts });

fs.mkdirSync(OUT, { recursive: true });

// ---- 1. Bundle -------------------------------------------------------------
// The entry defaults to `watch` when given no arguments, because double-clicking
// an exe passes none and "start working and show me the window" is the only
// thing a double-click can sensibly mean.
const ENTRY = path.join(HERE, 'app.mjs');

console.log('bundling…');
run(process.execPath, [
  path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ENTRY,
  '--bundle',
  '--platform=node',
  '--target=node24',
  '--format=cjs',
  // Node builtins must NOT be bundled — they live inside the exe already.
  '--external:node:*',
  '--outfile=' + BUNDLE,
  // The top-level await in the entry needs a module format that allows it;
  // esbuild lowers it for CJS.
  '--log-level=warning'
]);

// ---- 2. SEA blob -----------------------------------------------------------
fs.writeFileSync(SEA_CFG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  // The optimizer reads its config and database from disk at runtime, so there
  // are no assets to embed — everything else is code.
  useSnapshot: false,
  useCodeCache: true
}, null, 2), 'utf8');

console.log('preparing blob…');
run(process.execPath, ['--experimental-sea-config', SEA_CFG]);

// ---- 3. Inject into a copy of node ----------------------------------------
console.log('building exe…');
fs.copyFileSync(process.execPath, EXE);
run(process.execPath, [
  path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  EXE, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
]);

// ---- 4. No console window --------------------------------------------------
// node.exe is a CONSOLE-subsystem binary, so Windows hands every copy of it a
// terminal — which is why double-clicking this produced a black window that
// looked like PowerShell. This program has no use for one: it logs to a file
// and its interface is a browser. Flipping the PE subsystem field to GUI (2)
// is the whole fix; the Subsystem field sits at offset 68 of the optional
// header in both PE32 and PE32+, so no format detection is needed.
{
  const buf = fs.readFileSync(EXE);
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(peOff) !== 0x00004550) {   // P,E,0,0
    console.warn("not a PE file — leaving the subsystem alone");
  } else {
    const subsystemOff = peOff + 24 + 68;
    const was = buf.readUInt16LE(subsystemOff);
    if (was === 3) {
      buf.writeUInt16LE(2, subsystemOff);   // IMAGE_SUBSYSTEM_WINDOWS_GUI
      fs.writeFileSync(EXE, buf);
      console.log("subsystem: console -> GUI (no terminal window)");
    } else {
      console.log("subsystem already " + was + " — left as is");
    }
  }
}

const size = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\n${EXE}  (${size} MB)`);
console.log('Double-click to run. It starts working and opens its window.');

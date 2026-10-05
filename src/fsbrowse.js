import path from 'node:path';
import * as disk from './diskguard.js';

// List available drive letters on Windows (e.g. C:\, H:\). On other platforms
// this returns the filesystem root so the picker still works. Every letter is
// touched, so a hung disk must not hold the picker (or, as a Sync call, the
// whole server): one that has not answered in 2 s is listed anyway.
export async function listDrives() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const roots = [];
  for (let c = 65; c <= 90; c++) roots.push(String.fromCharCode(c) + ':\\');
  const present = await Promise.all(roots.map((root) =>
    disk.access(root, { wait: 2000 }).then(() => true, (e) => disk.isStall(e)))); // else: letter not present
  return roots.filter((r, i) => present[i]).map((root) => ({ name: root, path: root }));
}

// List the sub-folders of a directory (folders only — this is a folder picker).
export async function listDirs(dir) {
  const abs = path.resolve(dir);
  const entries = await disk.readdir(abs, { withFileTypes: true }, { wait: 5000 });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent, // null means we're at a drive root
    dirs
  };
}

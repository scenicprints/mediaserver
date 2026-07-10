import fs from 'node:fs';
import path from 'node:path';

// List available drive letters on Windows (e.g. C:\, H:\). On other platforms
// this returns the filesystem root so the picker still works.
export function listDrives() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      fs.accessSync(root);
      drives.push({ name: root, path: root });
    } catch {
      // drive letter not present
    }
  }
  return drives;
}

// List the sub-folders of a directory (folders only — this is a folder picker).
export function listDirs(dir) {
  const abs = path.resolve(dir);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
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

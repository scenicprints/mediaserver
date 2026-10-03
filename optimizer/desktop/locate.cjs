// Is this folder a Marquee installation the optimizer can work with?
//
// Separated from main.cjs so it can be tested without Electron. It takes a
// folder and returns what is wrong with it in the owner's terms, which is the
// part worth getting right: the old behaviour was "No library database at
// <path>" in an error box, followed by an application that sat in the tray
// doing nothing with no way to correct it short of editing JSON.
//
// It asks WHERE MARQUEE IS, not where the media is, and that distinction is
// real rather than pedantic: the optimizer has no scanner of its own. The files
// it works on come from movie_files and episode_files in Marquee's database,
// which Marquee's own scan fills in. Asking for a media folder would imply a
// capability this program does not have.
const path = require('node:path');
const fs = require('node:fs');

/** Problems with `dir`, in order. An empty array means it will work. */
function rootProblems(dir) {
  if (!dir) return ['No folder chosen.'];

  const problems = [];
  const cfg = path.join(dir, 'config.json');
  const haveConfig = fs.existsSync(cfg);
  if (!haveConfig) problems.push('No config.json here — this is not a Marquee folder.');

  // Where the database lives is config.json's business, so it is read rather
  // than assumed; only the fallback is data\library.db.
  let dbPath = path.join(dir, 'data', 'library.db');
  if (haveConfig) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfg, 'utf8').replace(/^﻿/, ''));
      if (raw.dbPath) dbPath = path.resolve(dir, raw.dbPath);
    } catch (e) {
      problems.push('config.json here could not be read: ' + e.message);
    }
  }

  if (!fs.existsSync(dbPath)) {
    problems.push('No library database at ' + dbPath +
      '\nRun Marquee once and let it scan, then come back.');
  }
  return problems;
}

/** The folder remembered from a previous setup, or null. */
function loadSavedRoot(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).root;
    return saved && fs.existsSync(path.join(saved, 'config.json')) ? saved : null;
  } catch { return null; }
}

/** Remember it. Returns false rather than throwing — see the caller. */
function saveRoot(file, dir) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: dir }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

module.exports = { rootProblems, loadSavedRoot, saveRoot };

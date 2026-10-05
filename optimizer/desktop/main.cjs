// Marquee Optimizer — the desktop application.
//
// This was a browser tab, and a browser tab is not a program: it has an address
// bar, it lives in a window full of other tabs, closing the browser closes it,
// and nothing about it says "this is running". A thing that quietly rewrites
// your library in the background needs to look like an application and behave
// like one.
//
// So: a real window with no browser chrome, a taskbar entry, and a tray icon
// that says it is running. Closing the window leaves it working in the tray —
// closing a window should not stop a background job — and Quit from the tray is
// how you actually stop it.
//
// The engine runs in the main process rather than a child, so there is one
// database handle and the window cannot outlive or disagree with the worker.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { rootProblems, loadSavedRoot, saveRoot } = require('./locate.cjs');

// Not const: setup can change where the library is, and everything downstream
// reads these.
let ROOT = findRoot();
let PORT = readPort();

let win = null;
let tray = null;
let engineStarted = false;
let quitting = false;

// Where the owner's answer is remembered, if they had to be asked.
//
// userData, not beside the executable: a packaged app can sit in Program Files,
// which is not writable, and a setup step that cannot save its own answer would
// ask the same question at every launch.
function savedRootFile() {
  return path.join(app.getPath('userData'), 'library-location.json');
}

function findRoot() {
  // Packaged, the app sits in its own folder; in development it is run from the
  // project. Both are checked so neither needs configuring. A location the owner
  // chose during setup wins over all of them.
  const candidates = [
    loadSavedRoot(savedRootFile()),
    path.resolve(path.dirname(app.getPath('exe')), '..'),
    path.dirname(app.getPath('exe')),
    'C:\\mediaserver',
    path.resolve(__dirname, '..', '..'),
    process.cwd()
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'config.json'))) return c;
  return path.resolve(__dirname, '..', '..');
}

function readPort() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).optimizerUiPort || 8097; }
  catch { return 8097; }
}

// ---- Standalone: a root the optimizer owns ------------------------------
//
// Without Marquee there is no config.json and no library database, and the
// engine needs both. Rather than teaching it a second mode, setup builds a root
// that looks exactly like the one it already expects — config.json and
// data\library.db — inside userData. Everything downstream carries on unchanged;
// the only difference is that `libraryFolders` is set, which switches on the
// scanner.
function ownRoot() {
  return path.join(app.getPath('userData'), 'library');
}

function ownRootIsReady() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ownRoot(), 'config.json'), 'utf8'));
    return Array.isArray(cfg.libraryFolders) && cfg.libraryFolders.length > 0;
  } catch { return false; }
}

/** Ask for folders to scan, then build the root. True if it is ready to run. */
async function setUpOwnLibrary() {
  const folders = [];
  for (;;) {
    const picked = await dialog.showOpenDialog({
      title: folders.length ? 'Add another folder, or Cancel when done' : 'Which folder holds your media?',
      properties: ['openDirectory', 'multiSelections']
    });
    if (!picked.canceled) {
      for (const f of picked.filePaths) if (!folders.includes(f)) folders.push(f);
    }
    if (!folders.length) return false;        // cancelled before naming any

    const more = await dialog.showMessageBox({
      type: 'question',
      title: 'Marquee Optimizer — setup',
      message: folders.length === 1 ? 'One folder chosen' : `${folders.length} folders chosen`,
      detail: folders.join('\n') + '\n\nSub-folders are included.',
      buttons: ['Done', 'Add another…', 'Start over'],
      defaultId: 0, cancelId: 0, noLink: true
    });
    if (more.response === 0) break;
    if (more.response === 2) folders.length = 0;
  }

  const root = ownRoot();
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const cfgPath = path.join(root, 'config.json');
    // Written only if absent, so a second run through setup cannot discard
    // settings the owner has since changed.
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* new */ }
    cfg.libraryFolders = folders;
    cfg.dbPath = './data/library.db';
    // Nothing to ask about playback, so do not stand down waiting for an answer
    // that will never come. This is the setting that would otherwise leave a
    // non-Marquee install doing nothing at all.
    if (cfg.pauseWhileWatching === undefined) cfg.pauseWhileWatching = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (e) {
    dialog.showErrorBox('Marquee Optimizer', 'Could not set up the library folder.\n\n' + e.message);
    return false;
  }

  ROOT = root;
  PORT = readPort();
  saveRoot(savedRootFile(), root);
  return true;
}

/**
 * Ask for the Marquee folder until it points at something usable, or the owner
 * quits.
 *
 * Before this, a wrong guess at the location produced "No library database at
 * ..." in an error box and then an application that sat in the tray doing
 * nothing, with no way to correct it short of editing JSON by hand. Which is
 * fine for the machine it was written on and useless for anybody else.
 *
 * Returns true if the engine can now start.
 */
async function runSetup() {
  if (!rootProblems(ROOT).length) return true;
  // A standalone setup already done: its own root is saved and valid.
  if (ownRootIsReady()) { ROOT = ownRoot(); PORT = readPort(); return true; }

  for (;;) {
    const problems = rootProblems(ROOT);
    const r = await dialog.showMessageBox({
      type: 'question',
      title: 'Marquee Optimizer — setup',
      message: 'Where should the optimizer get its library?',
      detail:
        'It can work from Marquee, which has already scanned and catalogued ' +
        'everything — or it can scan folders itself, which is what to choose if ' +
        'you run Plex, Jellyfin, Emby, or no media server at all.\n\n' +
        'Tried for a Marquee install at: ' + ROOT + '\n' + problems.join('\n'),
      buttons: ['Scan my own folders…', 'I use Marquee — choose its folder…', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (r.response === 2) return false;
    if (r.response === 0) {
      if (await setUpOwnLibrary()) return true;
      continue;
    }

    const picked = await dialog.showOpenDialog({
      title: 'Where is Marquee installed?',
      properties: ['openDirectory'],
      defaultPath: fs.existsSync(ROOT) ? ROOT : undefined
    });
    if (picked.canceled || !picked.filePaths.length) continue;

    const dir = picked.filePaths[0];
    const bad = rootProblems(dir);
    if (bad.length) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Marquee Optimizer — setup',
        message: 'That folder will not work',
        detail: dir + '\n\n' + bad.join('\n'),
        buttons: ['Try again'],
        noLink: true
      });
      continue;
    }

    ROOT = dir;
    PORT = readPort();
    if (!saveRoot(savedRootFile(), dir)) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Marquee Optimizer',
        message: 'Carrying on, but this will be asked again next time',
        detail: 'The choice could not be saved to ' + savedRootFile(),
        buttons: ['OK'],
        noLink: true
      });
    }
    return true;
  }
}

// The tray icon, drawn rather than shipped as a file: a Braun-orange square on
// nothing, which is what this program's signal colour is for. A 16px PNG built
// by hand avoids carrying a binary asset around for eleven pixels of colour.
function trayIcon() {
  const file = path.join(__dirname, 'tray.png');
  if (fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,' +
    // 16x16, solid #F26A16 with a transparent 2px border.
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42mNkYPhfz0AEYBxVSFe' +
    'FMIUwhTCFMIUwhTCFMIUwhTCFMIUwhTCFMIUwhTCFMIUwhTCFAAB1nAgBqjkPHwAAAABJRU5ErkJggg=='
  );
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#141416',        // the app's own ground, so no white flash
    title: 'Marquee Optimizer',
    autoHideMenuBar: true,             // no File/Edit/View — this is not a browser
    titleBarStyle: 'hidden',
    titleBarOverlay: {                 // native buttons, the app's own colours
      color: '#141416',
      symbolColor: '#EFEEE9',
      height: 40
    },
    icon: trayIcon(),
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.removeMenu();
  win.loadURL(`http://127.0.0.1:${PORT}`);

  win.once('ready-to-show', () => { if (show) win.show(); });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return;                       // aborted by a newer navigation
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(`http://127.0.0.1:${PORT}`); }, 700);
  });

  // Closing the window does NOT stop the work. It is a background job with a
  // window, not a window that happens to do work.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // Anything that would open a new window goes to the real browser instead —
  // this app has exactly one page.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) createWindow(true);
  else { win.show(); win.focus(); }
}

// Start with Windows, and start WITHOUT a window.
//
// Closing the window has always left the work running, but nothing brought it
// back after a reboot: the machine came up and the optimizer simply was not
// there until someone double-clicked it. On a box whose whole job is to be left
// alone, that is the difference between a background service and a program
// somebody has to remember to start.
//
// The login entry passes --hidden so the machine does not boot to a window
// nobody asked for. Launched by hand it still opens, because then you did ask.
const HIDDEN_FLAG = '--hidden';

// Pick a different Marquee folder, then restart into it.
async function changeLibraryFolder() {
  const picked = await dialog.showOpenDialog({
    title: 'Where is Marquee installed?',
    properties: ['openDirectory'],
    defaultPath: fs.existsSync(ROOT) ? ROOT : undefined
  });
  if (picked.canceled || !picked.filePaths.length) return;

  const dir = picked.filePaths[0];
  const bad = rootProblems(dir);
  if (bad.length) {
    await dialog.showMessageBox({
      type: 'error', title: 'Marquee Optimizer', noLink: true,
      message: 'That folder will not work',
      detail: dir + '\n\n' + bad.join('\n'),
      buttons: ['OK']
    });
    return;
  }
  if (dir === ROOT) return;

  const r = await dialog.showMessageBox({
    type: 'question', title: 'Marquee Optimizer', noLink: true,
    message: 'Restart the optimizer on the new folder?',
    detail: 'Any job in progress stops and is picked up again afterwards — the ' +
            'file being written is a temp file beside the original, and the ' +
            'original is only replaced once a job passes its checks.\n\n' + dir,
    buttons: ['Restart', 'Cancel'],
    defaultId: 0, cancelId: 1
  });
  if (r.response !== 0) return;

  if (!saveRoot(savedRootFile(), dir)) {
    dialog.showErrorBox('Marquee Optimizer', 'Could not save the choice to ' + savedRootFile());
    return;
  }
  quitting = true;
  app.relaunch();
  app.quit();
}

function startsWithWindows() {
  try { return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin; }
  catch { return false; }
}

function setStartsWithWindows(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: [HIDDEN_FLAG] }); }
  catch (e) {
    dialog.showErrorBox('Marquee Optimizer', 'Could not change the startup setting.\n\n' + e.message);
  }
  buildTray(); // redraw, so the tick shows what actually happened rather than what was asked
}

function buildTray() {
  // Reused on redraw: a second `new Tray` leaves two icons in the notification
  // area, both live, and only one of them ever goes away.
  if (!tray) tray = new Tray(trayIcon());
  tray.setToolTip('Marquee Optimizer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Marquee Optimizer', click: showWindow },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startsWithWindows(),
      click: (item) => setStartsWithWindows(item.checked)
    },
    { type: 'separator' },
    {
      label: 'Open log folder',
      click: () => shell.openPath(path.join(ROOT, 'data'))
    },
    // The chosen folder has to be correctable. Once saved it wins over every
    // other candidate, so if Marquee moves — or the wrong folder was picked —
    // the alternative is finding and deleting a JSON file in AppData.
    //
    // Changing it means the engine is already holding the old database, so this
    // saves and restarts rather than pretending it can be swapped underneath.
    { label: 'Change library folder…', click: changeLibraryFolder },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
}

// Only one copy. Clicking the exe again shows the window that is already
// running rather than starting a second optimizer on the same drives, which is
// the worst thing that can happen to this machine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // Before anything else: can this even find a library? If not, ask — and if
    // the answer is "quit", quit, rather than sitting in the tray pretending.
    //
    // Deliberately ahead of the tray and the window. A tray icon that claims the
    // optimizer is running, over an engine that never started, is the failure
    // this replaces.
    if (!(await runSetup())) { quitting = true; app.quit(); return; }

    buildTray();

    // Engine FIRST, window second. The window points at a server this process
    // is about to start, and loading it a moment too early left the page on
    // "connecting" with its first fetches refused.
    try {
      // The engine is ESM; the Electron main process is CommonJS. A dynamic
      // import bridges the two without duplicating a line of it.
      const { startEngine } = await import('../engine-host.mjs');
      await startEngine({ root: ROOT, port: PORT });
      engineStarted = true;
    } catch (e) {
      if (e && e.code === 'ALREADY_RUNNING') {
        // Another copy is already doing the work. Show its window rather than
        // an error — from here that is a normal thing to have happened.
        dialog.showMessageBox({
          type: 'info',
          title: 'Marquee Optimizer',
          message: 'Already running',
          detail: e.message + '\n\nThis window is showing that copy.'
        });
      } else {
        dialog.showErrorBox('Marquee Optimizer',
          'The optimizer could not start.\n\n' + (e && e.message ? e.message : String(e)));
      }
    }

    // Double-clicked, so it opens. Started by Windows at login, it does not:
    // the tray icon is the only thing that should appear.
    createWindow(!process.argv.includes(HIDDEN_FLAG));
  });

  // No windows open is normal here — it lives in the tray.
  app.on('window-all-closed', (e) => { if (!quitting) e && e.preventDefault && e.preventDefault(); });
}

module.exports = { get engineStarted() { return engineStarted; } };

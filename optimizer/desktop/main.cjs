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

const ROOT = findRoot();
const PORT = readPort();

let win = null;
let tray = null;
let engineStarted = false;
let quitting = false;

function findRoot() {
  // Packaged, the app sits in its own folder; in development it is run from the
  // project. Both are checked so neither needs configuring.
  const candidates = [
    path.resolve(path.dirname(app.getPath('exe')), '..'),
    path.dirname(app.getPath('exe')),
    'C:\\mediaserver',
    path.resolve(__dirname, '..', '..'),
    process.cwd()
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'config.json'))) return c;
  return path.resolve(__dirname, '..', '..');
}

function readPort() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).optimizerUiPort || 8097; }
  catch { return 8097; }
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

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Marquee Optimizer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Marquee Optimizer', click: showWindow },
    { type: 'separator' },
    {
      label: 'Open log folder',
      click: () => shell.openPath(path.join(ROOT, 'data'))
    },
    {
      label: 'Files needing re-download',
      click: () => shell.openPath(path.join(ROOT, 'data', 'needs-redownload.txt'))
    },
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

    // You double-clicked it, so it opens.
    createWindow(true);
  });

  // No windows open is normal here — it lives in the tray.
  app.on('window-all-closed', (e) => { if (!quitting) e && e.preventDefault && e.preventDefault(); });
}

module.exports = { get engineStarted() { return engineStarted; } };

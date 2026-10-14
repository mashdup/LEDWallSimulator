/**
 * LED Wall - Electron main process.
 *
 * Why Electron after the Chrome --app attempt: the wall is a Chromium app,
 * and every problem we hit (hidden-tab throttling tiers, occlusion, second-
 * instance delegation, session restore beating --app, the --no-sandbox flag
 * silently killing app mode) is Chrome's tab lifecycle that we do not
 * control. Electron is the same Chromium engine with the lifecycle owned by
 * the app: no tabs, no throttling (disabled explicitly below), no profile
 * restore, and Web Serial with an explicit permission handler.
 *
 * The renderer is the existing app page served by tools/serve.js - the wall
 * stack (protocol, animations, power budget, frame pipeline) is unchanged.
 *
 * Usage: electron main.cjs <url>
 */
const { app, BrowserWindow, session, Menu, screen: electronScreen } = require('electron');
const path = require('node:path');

const url = process.argv.find((a) => /^http:\/\//.test(a)) ?? 'http://127.0.0.1:8080/';

// Dedicated userData inside the repo: the default (%APPDATA\<package name>)
// collides with any other instance of this package - two instances fighting
// over one cache directory produce 'Unable to move the cache: Access is
// denied' noise, and the single-instance lock then quits the newcomer with
// code 0, which reads like a crash. A known directory, plus the explicit
// message below, makes both outcomes legible.
app.setPath('userData', path.join(__dirname, '..', '..', '.wall-electron'));

// One show per machine: a second launch focuses the first window instead of
// opening a second wall (Chrome's delegation, done sanely).
if (!app.requestSingleInstanceLock()) {
  console.log('electron: another wall instance is already running - focused it instead of opening a second window.');
  console.log('electron: if that window is from an old session, close it (or Ctrl+C its launcher) and run again.');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function createWindow() {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      center: true,
      title: 'LED Wall',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false, // show() on ready-to-show: no ghost windows, no invisible app
      webPreferences: {
        // The whole point of leaving the browser: the frame loop must never
        // be throttled, and here WE decide that, not a tab policy.
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(url);

    win.once('ready-to-show', () => {
      // A saved off-screen bounds (multi-monitor history in userData) makes
      // the app 'start with no window'; center explicitly and log the
      // position so 'no window' is answerable from the launcher output.
      win.center();
      win.show();
      win.focus();
      console.log(`electron: window at ${JSON.stringify(win.getBounds())} on ${JSON.stringify(electronScreen.getPrimaryDisplay().workArea)}`);
    });
    win.webContents.on('did-finish-load', () => {
      console.log(`electron: window loaded ${url}`);
      win.webContents
        .executeJavaScript('document.title')
        .then((t) => console.log(`electron: renderer title: ${t}`))
        .catch(() => {});
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`electron: renderer gone: ${JSON.stringify(details)}`);
    });
    win.on('page-title-updated', (e) => e.preventDefault()); // keep 'LED Wall'
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    // Web Serial: grant the permission and answer the port picker. The wall
    // runs on the wch.cn USB-UART (COM8 on the show machine); prefer it,
    // otherwise the first serial port. The picker prompt never shows in a
    // kiosk app, so the answer must be programmatic.
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'serial');
    });
    ses.on('select-serial-port', (event, portList, _wc, callback) => {
      const ports = Array.from(portList);
      const preferred =
        ports.find((p) => /com8\b/i.test(p.path)) ??
        ports.find((p) => /^com\d+$/i.test(p.path)) ??
        ports[0];
      if (preferred) {
        callback(preferred.portId);
      } else {
        callback(''); // no ports: refuse the request cleanly
      }
      event.preventDefault();
    });

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

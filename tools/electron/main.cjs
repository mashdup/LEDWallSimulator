/**
 * LED Wall — Electron main process (the app shell).
 *
 * Why an app and not a browser tab: this shell exists for the failures we
 * MEASURED on the browser console, none of which page code can fix:
 *
 *   - The GPU process grew to 1.1 GB of private bytes on the show machine
 *     (RTX 5080 + AMD iGPU + a SudoMaker virtual display in the compositing
 *     chain) and the window went fully grey — no Aw Snap, JS alive. Fix:
 *     hardware acceleration is OFF for the wall. The sim canvas is ~400
 *     gradient blobs on a small canvas — trivial for CPU rasterizing — and
 *     the wall's real output is serial bytes, which never touch a GPU.
 *   - Tab sleeping / Memory Saver / Power Saver blank and freeze background
 *     tabs (the 10-minute grey). An app has no tabs and no tab policy.
 *   - Web Serial needs a USER GESTURE, so a reload of a browser console
 *     kills COM8 and the wall goes dark until a human clicks Connect.
 *     Here the port is granted at install (permission handler) and the
 *     page reopens the GRANTED port via navigator.serial.getPorts() —
 *     gesture-free — so a reload, a crash-recovery, or an ESP32 that
 *     re-enumerates mid-show (power sag on a bright frame is real at 8 A)
 *     all self-heal: the stream comes back on its own.
 *
 * This process also OWNS the server: it spawns tools/serve.js as a
 * node-as-electron child (so the packaged binary needs no Node install at
 * the venue), waits for its bound-socket line, and opens the window. Dev
 * (`npm run wall`) and packaged run the identical shape.
 *
 * Flags (all optional):
 *   --port <n>          serve port (default 8080)
 *   --relay <url>       public relay to pull guest drawings from
 *   --relay-key <hex>   pairing key for that relay
 *   --relay-interval ms sync period (serve.js default 5000)
 *   --kiosk             fullscreen, always-on-top (the show machine)
 *   --wall-serial <s>   port preference for the picker: a name substring
 *                       ('usbmodem', 'COM8') or 'vid:pid' ('1a86:7523').
 *                       Default: pick it from the list by signature — the
 *                       same cable is COM8/wch on Windows and
 *                       cu.usbmodem…/6790 on macOS (see serial-pick.cjs)
 *   --wall-debug        DevTools + CDP on 127.0.0.1:9223 for the renderer
 *                       (named so it cannot be mistaken for node's legacy
 *                       --debug: electron's CLI scans every argument for
 *                       node flags, and the legacy one makes the process
 *                       print DEP0062 and die - measured twice here)
 *   http(s)://...       load a published console URL instead of the local
 *                       server (no server is spawned in that mode)
 */
const { app, BrowserWindow, session, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pickSerialPort, describePort } = require('./serial-pick.cjs');

const argv = process.argv.slice(1); // app args (everything after main.cjs)
const has = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const externalUrl = argv.find((a) => /^https?:\/\//.test(a)) ?? null;
const PORT = Number(flagValue('--port') ?? 8080);
const WALL_SERIAL = flagValue('--wall-serial');
const SERVE_SCRIPT = path.join(__dirname, '..', 'serve.js');

// The measured 1.1 GB GPU-process grey page: painting is software, by
// decision. Must be set before app is ready.
app.disableHardwareAcceleration();

// External inspection (the scripts in scratch/ read fps, sink status, and
// frame seq from the outside): loopback-only CDP, dev convenience.
if (has('--wall-debug')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

// Dedicated userData: dev keeps it in the repo (.wall-electron) so the
// history of past runs stays where the dev looks; packaged lands in the
// per-product app-data directory. The data store (drawings) lives beside
// it, NOT inside the app bundle, which is read-only in Program Files.
const devData = path.join(__dirname, '..', '..', '.wall-electron');
if (app.isPackaged === false) app.setPath('userData', devData);
const DATA_FILE = path.join(app.getPath('userData'), 'drawings.json');

/**
 * The venue log. A packaged GUI app has NO console: every hard-won line in
 * this file (renderer-gone, child-gone, GPU deaths, serial autostart, the
 * picker's port dump) would evaporate exactly when we need it. One line per
 * event, capped near 2 MB (rotate: keep the newest half), living beside the
 * show data: userData/wall.log.
 */
const LOG_FILE = path.join(app.getPath('userData'), 'wall.log');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 2 * 1024 * 1024) {
      const tail = fs.readFileSync(LOG_FILE, 'utf8').slice(-512 * 1024);
      fs.writeFileSync(LOG_FILE, tail);
    }
  } catch {
    // First run: the file does not exist yet; appendFile will create it.
  }
  fs.appendFile(LOG_FILE, line, () => {});
  process.stdout.write(line);
}

// One show per machine.
if (!app.requestSingleInstanceLock()) {
  log('electron: another wall instance is already running - focused it instead.');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let serveChild = null;

  /**
   * Boot the wall server as a child of THIS binary (ELECTRON_RUN_AS_NODE:
   * the app is its own runtime; a venue machine needs no Node installed).
   * Resolves with the URL to open once serve.js announces its bound socket.
   */
  function startServer() {
    const args = [SERVE_SCRIPT, '--port', String(PORT), '--data', DATA_FILE];
    for (const f of ['--relay', '--relay-key', '--relay-interval']) {
      const v = flagValue(f);
      if (v !== null) args.push(f, v);
    }
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serveChild = child;
    const relay = (to) => (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim() !== '') to.write(`serve: ${line}\n`);
      }
    };
    child.stdout.on('data', relay(process.stdout));
    child.stderr.on('data', relay(process.stderr));
    child.once('exit', (code) => {
      log(`electron: the wall server exited (code ${code}) - closing the window with it`);
      app.quit();
    });
    return new Promise((resolve, reject) => {
      let log = '';
      const onData = (chunk) => {
        log += chunk;
        const m = /LED wall dev server: (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (m !== null) resolve(m[1]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      setTimeout(() => reject(new Error(`server did not bind: ${log}`)), 20_000);
    });
  }

  function createWindow(url) {
    const kiosk = has('--kiosk');
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      center: true,
      title: 'LED Wall',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false, // show() on ready-to-show: no ghost windows
      fullscreen: kiosk,
      alwaysOnTop: kiosk,
      webPreferences: {
        // The whole point of the shell: WE own the lifecycle. No throttling,
        // ever - not a tab policy we hope to be exempt from.
        backgroundThrottling: false,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(url);

    win.once('ready-to-show', () => {
      // A saved off-screen bounds (multi-monitor history) makes the app
      // 'start with no window'; center explicitly and log the geometry.
      win.center();
      win.show();
      win.focus();
      log(`electron: window at ${JSON.stringify(win.getBounds())} on ${JSON.stringify(screen.getPrimaryDisplay().workArea)}`);
    });
    // The owner token is the wall's own authority, generated at first start
    // and kept in userData beside the gallery. A human pasting it into the
    // console's boxes from a log file is a trap (the dev repo has a different
    // token from the installed app - measured: owner pastes the wrong one,
    // gets 401, 'it doesn't work'). The shell KNOWS the token: seed it into
    // the page's localStorage (the key draw.html and the relay form share),
    // and pre-fill the form's box. Local-only: this code runs inside the app
    // on the machine that owns the file; nothing about the token crosses the
    // network.
    const ownerSeed = () => {
      try {
        return fs.readFileSync(path.join(path.dirname(DATA_FILE), 'owner-token.txt'), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const seedOwner = () => {
      const tok = ownerSeed();
      if (tok === '') return;
      win.webContents
        .executeJavaScript(
          `(() => { try { localStorage.setItem('ledwall-owner-token', ${JSON.stringify(tok)}); } catch {}
            const el = document.getElementById('relayOwner');
            if (el && el.value === '') el.value = ${JSON.stringify(tok)}; })()`,
        )
        .catch(() => { /* page not ready; the Apply fallback reads localStorage */ });
    };
    win.webContents.on('did-finish-load', seedOwner);

    // Serial self-heal on every page load (boot, crash-reload, restart).
    // The page reopens GRANTED ports by itself (navigator.getPorts is
    // gesture-free); when NOTHING is granted - a first launch, or Electron
    // not persisting grants across sessions - the picker needs a user
    // gesture, and Blink enforces that even for an auto-granted permission
    // (measured: requestPort without one = SecurityError, Electron 44).
    // The shell's answer: dispatchKeyEvent through the debugger API is a
    // TRUSTED input event, and trusted input is exactly what transient
    // activation means. We manufacture the gesture, then let the page spend
    // it on requestPort() - which the handlers above answer with COM8, no
    // human, no dialog. A 'shift' key would be ignored (modifier keydowns
    // are not activation-triggering per spec); a plain 'a' is.
    win.webContents.on('did-finish-load', () => {
      log(`electron: window loaded ${url}`);
      (async () => {
        const wc = win.webContents;
        // app.js has top-level awaits, and a module with TLA does NOT block
        // the load event: at did-finish-load the entry points are not defined
        // yet (measured: 'no-page'). Poll for the page to be booted.
        let state = null;
        // executeJavaScript AWAITS the page's promise, and wallAutoStart()
        // awaits navigator.serial.getPorts(). The first serial call in a
        // renderer starts Chromium's serial utility process; when that
        // process cannot start (unsigned dev build, a machine with no serial
        // stack) the promise NEVER settles - and the shell sat here with an
        // empty log, which is how 'the app boots, the wall is dark, the log
        // says nothing about serial' shows up. Every poll gets a deadline,
        // and a stall is a LOGGED state, not a hang.
        const EVAL_TIMEOUT_MS = 4000;
        const poll = () => {
          const evalP = wc.executeJavaScript('window.wallAutoStart ? window.wallAutoStart() : null');
          // A late settlement of a timed-out eval must not warn the process.
          evalP.catch(() => {});
          return Promise.race([
            evalP,
            new Promise((done) => setTimeout(() => done('stalled'), EVAL_TIMEOUT_MS)),
          ]);
        };
        for (let i = 0; i < 40 && state === null; i++) {
          state = await poll();
          if (state === 'stalled') {
            log(`electron: serial autostart: wallAutoStart() did not settle in ${EVAL_TIMEOUT_MS} ms (attempt ${i + 1}/40) - navigator.serial is wedged on this machine`);
            return;
          }
          if (state === null) await new Promise((r) => setTimeout(r, 250));
        }
        if (state === null) {
          log('electron: serial autostart: the page never booted (10 s) - leaving it to a human');
          return;
        }
        if (state !== 'gesture') {
          log(`electron: serial autostart: ${state}`);
          return;
        }
        let attached = false;
        try {
          wc.debugger.attach('1.3');
          attached = true;
          const key = (type) => ({ type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', key('keyDown'));
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', key('keyUp'));
          // Report the OUTCOME, not the resolution: connect() swallows its
          // errors into the sink line, so a promise that resolved used to log
          // 'gesture -> connected' over a refused picker (measured on the mac:
          // 'refused' and 'connected' in the same second).
          const connectP = wc.executeJavaScript(
            'window.wallSerialConnect ? window.wallSerialConnect().then((r) => (r && r.ok === false) ? "FAILED: " + (r.error || "see the sink line") : "connected", (e) => "error: " + (e && e.message ? e.message : String(e))) : "no-page"',
          );
          connectP.catch(() => {}); // a late settle after the deadline is not our business
          // port.open() on a CDC-ACM node can block; an unevaluated promise
          // here would pin the debugger open and leave the venue log silent.
          const done = await Promise.race([
            connectP,
            new Promise((r) => setTimeout(() => r('stalled: port.open() never returned (15 s)'), 15000)),
          ]);
          log(`electron: serial autostart: gesture -> ${done}`);
        } catch (err) {
          log(`electron: serial autostart failed: ${err?.message ?? err}`);
        } finally {
          if (attached) { try { wc.debugger.detach(); } catch { /* already gone */ } }
        }
      })().catch((err) => log(`electron: serial autostart: ${err?.message ?? err}`));
    });

    // Crash recovery. A render-process-gone (OOM, GPU-loss kill) leaves the
    // window blank with no UI: reload it. This is safe HERE, and only here:
    // the serial port is a GRANTED device, so the reloaded page reopens it
    // through navigator.serial.getPorts() with no gesture - the wall stream
    // resumes by itself. In a browser that reload would be a dark wall
    // (gesture-gated picker), which is exactly why the page's own watchdogs
    // detect-and-record there, and reload-and-heal here.
    win.webContents.on('render-process-gone', (_e, details) => {
      log(`electron: renderer gone: ${JSON.stringify(details)} - reloading`);
      setTimeout(() => win.loadURL(url), 500);
    });
    win.on('page-title-updated', (e) => e.preventDefault()); // keep 'LED Wall'

    if (has('--wall-debug')) win.webContents.openDevTools({ mode: 'detach' });
    return win;
  }

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // GPU-side deaths are the grey-page family: log them with the child's
    // reason so the incident record outlives the window.
    app.on('child-process-gone', (_e, details) => {
      log(`electron: child process gone: ${JSON.stringify(details)}`);
    });

    // Web Serial: grant the permission and answer the port picker. The wall
    // runs on the wch.cn USB-UART (COM8 on the show machine); prefer it,
    // otherwise the first serial port. The picker prompt never shows in a
    // kiosk app, so the answer must be programmatic.
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'serial');
    });
    // The picker is answered programmatically: a kiosk wall has no human at a
    // dialog. The MATCH lives in serial-pick.cjs (unit-tested) because the
    // Windows-shaped version of it refused the wall on macOS while the port
    // was sitting in the list — see that file's header for the log excerpt.
    ses.on('select-serial-port', (event, portList, _wc, callback) => {
      const ports = Array.from(portList);
      const { port: chosen, why } = pickSerialPort(ports, { prefer: WALL_SERIAL });
      log(
        `electron: serial request - ${ports.length} port(s): ` +
        ports.map(describePort).join(' | ') +
        (chosen ? ` -> choosing ${describePort(chosen)} [${why}]` : ` -> none chosen: ${why}`),
      );
      callback(chosen ? chosen.portId : '');
      event.preventDefault();
    });

    let url = externalUrl;
    if (url === null) {
      try {
        url = await startServer();
      } catch (err) {
        log(`electron: ${err.message}`);
        app.quit();
        return;
      }
    }
    createWindow(url);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  });

  app.on('window-all-closed', () => app.quit());

  // A shell that quits takes its server with it - a show with a window and
  // no server (or the reverse) is the split-brain the launcher killed zombies
  // to avoid; the same logic applies to our own child.
  app.on('will-quit', () => {
    try {
      serveChild?.kill();
    } catch {
      // Already gone: the kill is a courtesy, the child exits with the session.
    }
  });
}

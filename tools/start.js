/**
 * start.js — the one command that runs the wall.
 *
 * `npm start` boots tools/serve.js, waits until the server has actually bound,
 * opens the loopback URL in the default browser, and takes the whole process
 * tree down on Ctrl+C. `npm run wall` (= `--app`) is the show-mode: the wall
 * opens as a standalone Chrome APP WINDOW instead of a browser tab.
 *
 * Why app mode is not a cosmetic choice - it is the throttling fix:
 *
 *   Chrome detects when a window is fully covered or minimized (occlusion)
 *   and treats it as a hidden tab: ~1 Hz timers, and after ~5 minutes,
 *   intensive throttling to one wake-up per minute. That is the cliff: the
 *   wall runs, then drops to 1 Hz. In-page exemptions (audible audio,
 *   looping media) fight this with diminishing returns.
 *
 *   The app window removes the cause instead:
 *     --disable-features=CalculateNativeWinOcclusion  a covered window is
 *        never classified as hidden, so the throttling never starts at all
 *     --app=<url>          no tab strip; the window is an app, not a tab
 *     --user-data-dir=...  a dedicated profile: no extensions, no sign-in,
 *        no Memory Saver interference - nothing that can inject jank
 *     --autoplay-policy=no-user-gesture-required  the keep-alive arms itself
 *        on load; no click ritual needed
 *
 * The in-page keep-alive stays as a second line of defense (it is harmless
 * and covers the case where the app is opened in a normal browser tab).
 *
 * Why this is a script rather than a two-line `start "" <url> && node
 * tools/serve.js`:
 *
 *   - Opening the browser first races the server. The tab lands on
 *     "connection refused", which looks exactly like a broken app.
 *   - serve.js owns one headless Chromium for its /capture endpoint. On Windows
 *     killing only the Node process leaves that browser and its renderer
 *     children alive, holding a profile directory and a DevTools port, so the
 *     next run pays for a second browser and can fail on a locked profile.
 *     Hence taskkill /T.
 *
 * Port choice: --port / PORT if you asked for one — honoured exactly, so a busy
 * port is a loud failure rather than a server on a port you did not ask for.
 * With no port requested, 8080 is used, falling back to a free reachable port
 * if something is already sitting on it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { findChrome } from './capture.js';
import { freePort, isFetchablePort } from './ports.js';

const SERVE_SCRIPT = fileURLToPath(new URL('./serve.js', import.meta.url));
const DEFAULT_PORT = 8080;

/** serve.js announces itself; the URL in that line is the truth about the port. */
const READY = /LED wall dev server: (http:\/\/127\.0\.0\.1:\d+)/;

/** The serve.js child this process is responsible for tearing down. */
let child = null;
/** The app-mode Chromium, when --app launched one. */
let appChild = null;
let shuttingDown = false;

function usage() {
  console.error('usage: npm start [-- --port <port>] [--no-browser]');
  console.error('       npm run wall  (standalone app window, show mode)');
  console.error('       node tools/start.js [--port 8090] [--no-browser] [--app]');
  console.error('       npm run wall -- --debug  (app with DevTools on 127.0.0.1:9223)');
}

/** Same flag/env precedence as serve.js: --port > PORT > 8080. */
function parseArgs(argv) {
  let flag = null;
  let browser = true;
  let app = false;
  let electron = false;
  let debug = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      flag = argv[i + 1];
      i += 1;
      if (flag === undefined) {
        console.error('start: --port needs a value');
        usage();
        process.exit(2);
      }
    } else if (arg.startsWith('--port=')) {
      flag = arg.slice('--port='.length);
    } else if (arg === '--no-browser') {
      browser = false;
    } else if (arg === '--app') {
      app = true;
    } else if (arg === '--electron') {
      electron = true;
    } else if (arg === '--debug') {
      // Opens Electron's DevTools protocol on 127.0.0.1:9223 so the app
      // page's state (fps, sink status, frame seq) can be read from
      // outside - the difference between 'connect failed' and 'connected
      // and the wall is dark' is a status line, and this reaches it.
      debug = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`start: unknown argument ${arg}`);
      usage();
      process.exit(2);
    }
  }

  const explicit = flag !== null || process.env.PORT !== undefined;
  const raw = flag ?? process.env.PORT ?? null;
  if (raw === null) return { port: null, explicit: false, browser, app, electron, debug };

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`start: invalid port ${JSON.stringify(raw)}`);
    usage();
    process.exit(2);
  }
  if (!isFetchablePort(port)) {
    // Refusing here rather than letting serve.js bind it: a server on one of
    // these ports starts happily and answers nothing.
    console.error(`start: port ${port} is unreachable by design — browsers refuse it.`);
    console.error('Pick any other port, e.g. 8080');
    process.exit(2);
  }
  return { port, explicit, browser, app, electron, debug };
}

/**
 * The show app: Electron. Same Chromium engine as --app mode, but the tab
 * lifecycle is gone entirely - no throttling tiers, no occlusion, no
 * delegation, no session restore, and backgroundThrottling:false is OUR
 * decision in main.cjs. Web Serial is granted and answered programmatically
 * there (COM8 preferred), so the show needs no click ritual for the picker.
 */
function openElectronWindow(url, debug = false) {
  // The electron package exports the binary path from CJS; ask a CJS child.
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("electron"))'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const bin = (probe.stdout ?? '').trim();
  if (probe.status !== 0 || !bin) {
    console.log('start: electron is not installed (npm i -D electron). Falling back to the default browser.');
    openInBrowser(url);
    return null;
  }
  const main = fileURLToPath(new URL('./electron/main.cjs', import.meta.url));
  // NO windowsHide here: it sets STARTF_USESHOWWINDOW/SW_HIDE on the
  // process, and Electron's browser window HONORS that (measured: with it,
  // MainWindowHandle stays 0 - the app runs with no window on the desktop;
  // without it, 'LED Wall' appears). Electron is a GUI binary, so no console
  // window exists to hide in the first place.
  const args = [main, url];
  // '--debug' as an APP argument: main.cjs turns it into the
  // remote-debugging-port switch (post-path CLI args are app args, not
  // Chromium switches - passing the raw switch here does nothing).
  if (debug) args.push('--debug');
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  proc.unref();
  // The single-instance newcomer touches the shared cache dir before it
  // notices the lock and exits; those errors are its last words, not the
  // show's. Drop them (and keep everything else visible).
  const NOISE = /Unable to move the cache|Unable to create cache|Gpu Cache Creation/;
  const relay = (to) => (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim() !== '' && !NOISE.test(line)) to.write(`electron: ${line}\n`.replace(/electron: electron: /g, 'electron: '));
    }
  };
  proc.stdout?.on('data', relay(process.stdout));
  proc.stderr?.on('data', relay(process.stderr));
  proc.once('exit', (code) => console.log(`electron: window process exited (code ${code})`));
  proc.once('error', (e) => {
    console.log(`start: could not launch electron (${e.code}). Open the URL in any Chrome as a fallback.`);
  });
  return proc;
}

/**
 * The show-mode window: a standalone Chrome app window, not a tab.
 *
 * The flags are the throttling fix, not cosmetics - see the header. The
 * dedicated profile lives in the repo (.wall-profile) so the app instance is
 * fully isolated from the user's browsing: no extensions, no sign-in, no
 * Memory Saver, and nothing to clean up beyond deleting the directory.
 */
const PROFILE_MATCH = 'wall-profile';

/** Blocking sleep without a shell: Atomics.wait parks the thread. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function staleInstancesAlive() {
  if (process.platform === 'win32') {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      `Where-Object CommandLine -like '*${PROFILE_MATCH}*' | ` +
      'Measure-Object -Property ProcessId -Unique | Select-Object -ExpandProperty Count'],
      { encoding: 'utf8', windowsHide: true });
    return Number((out.stdout ?? '').trim()) > 0;
  }
  const out = spawnSync('pgrep', ['-f', PROFILE_MATCH], { encoding: 'utf8' });
  return out.status === 0;
}

function killStaleInstances() {
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      `Where-Object CommandLine -like '*${PROFILE_MATCH}*' | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
      { stdio: 'ignore', windowsHide: true });
  } else {
    spawnSync('pkill', ['-f', PROFILE_MATCH], { stdio: 'ignore' });
  }
}

/**
 * Kill serve.js processes left by dead launchers. Ctrl+C in a terminal that
 * launched a detached app does not always take the whole tree down, and the
 * orphaned server is the root of the 'kill the app, relaunch, connect fails'
 * report: the stale launcher's Electron keeps COM8 (open() fails on a port
 * the OS says is busy), and the stale server pushes the new show onto a
 * random port, splitting the stack across two worlds. tools/serve.js is the
 * launcher's own script, so at startup any instance is a zombie of a dead
 * launcher - killing it is the clean field. (A deliberately standalone
 * 'npm run serve' is caught by the same net; restarting it is cheap.)
 */
function killStaleServe() {
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*serve.js*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
      { stdio: 'ignore', windowsHide: true });
  } else {
    spawnSync('pkill', ['-f', 'serve.js'], { stdio: 'ignore' });
  }
}

/**
 * Delete the whole profile directory. Chrome's session-restore triggers are
 * spread across the session files, Preferences (profile.exit_type), and the
 * exit marker; clearing a subset proved whack-a-mole (a reused profile kept
 * reopening tab windows). The profile is dedicated to the launcher and holds
 * nothing worth keeping, so nuke it: the next start is a clean start.
 */
function resetProfile() {
  const profileDir = fileURLToPath(new URL('../.wall-profile', import.meta.url));
  // Retry until the directory is actually gone: a dying Chrome's children
  // keep files locked for a moment, and a PARTIAL wipe leaves the session
  // behind - which is the tab window again (measured: partial wipe -> 95 px).
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(profileDir, {recursive: true, force: true, maxRetries: 4, retryDelay: 200});
    } catch {
      // Fall through to the existence check; it is the arbiter.
    }
    if (!existsSync(profileDir)) return;
    sleepMs(400);
  }
}

function openAppWindow(url) {
  let chrome;
  try {
    chrome = findChrome();
  } catch (err) {
    console.log(`start: no Chromium found (${err.message}). Open ${url} yourself.`);
    return null;
  }
  const profile = fileURLToPath(new URL('../.wall-profile', import.meta.url));
  // A second launch with the same profile DELEGATES to the running instance,
  // and delegated --app opens as a plain tab (verified: clean launch gives a
  // 39 px title bar - a real app window; delegation gives a 95 px tab strip).
  // The profile is dedicated to this launcher, so any instance carrying it is
  // a stale one from a previous session: clear it before launching, and WAIT
  // for the processes to actually die - a launch that races a dying instance
  // delegates to it and is back to a tab. Every `npm run wall` is therefore a
  // clean launch: always an app window, and running it twice replaces the
  // window instead of tab-ifying in the old one.
  killStaleInstances();
  for (let i = 0; i < 20 && staleInstancesAlive(); i++) sleepMs(250);
  // The count hits zero before the profile is actually released: dying
  // Chrome's children (crashpad, GPU) keep writing into it for a moment.
  // Wiping in that window partially fails, the Singleton lock survives, and
  // the new Chrome delegates to the corpse and exits silently (measured:
  // profile created, zero processes, no output). Let the corpse settle.
  sleepMs(1500);
  // A reused profile restores its previous session: after any earlier run,
  // Chromium reopens a normal tab window and --app is IGNORED (measured:
  // fresh profile 39 px app window, reused profile 95 px tab window; deleting
  // the session files alone is not enough - Preferences' exit_type keeps
  // triggering restore). The profile is disposable by design - the wall has
  // no state worth restoring, and Web Serial grants need a fresh gesture
  // after every page load anyway - so the launcher starts from a clean
  // profile every time: always an app window, in ~2 s of rebuild.
  resetProfile();
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    // Noise control for the Playwright Chromium build (measured startup
    // chatter; none of it affects the wall):
    //   GCM 'PHONE_REGISTRATION_ERROR' spam (no Google API key here, and
    //   the wall needs no background Google traffic). NOTE: --no-sandbox
    //   also silences the sandbox notice, but it was MEASURED to break
    //   app mode (95 px tab window instead of a 39 px app window) - the
    //   sandbox notice itself is a known-harmless Playwright build
    //   message, filtered in the relay below.
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--window-size=1280,800',
    // Random loopback DevTools port, announced in <profile>/DevToolsActivePort.
    // Cheap to keep: it makes the show window inspectable (window type,
    // fps) without reserving a fixed port, and it is loopback-only.
    '--remote-debugging-port=0',
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
  proc.unref();
  // Chrome's own words when the show window misbehaves (a dying browser
  // process is otherwise silent: stdio 'ignore' hides the exit reason).
  // Known-harmless chatter is dropped: GCM registration spam (no Google
  // API key in the Playwright build) and the DevTools banner.
  const NOISE = /gcm|GCM|PHONE_REGISTRATION|DevTools listening|wrong_secret|log in to GCM|Sandbox cannot access/;
  const relay = (to) => (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line.trim() !== '' && !NOISE.test(line)) to.write(`app: ${line}\n`);
    }
  };
  proc.stdout?.on('data', relay(process.stdout));
  proc.stderr?.on('data', relay(process.stderr));
  proc.once('exit', (code) => console.log(`app: window process exited (code ${code})`));
  proc.once('error', () => {
    console.log(`start: could not launch ${chrome}. Open ${url} in any Chrome,`);
    console.log('       or set LED_CHROME to the browser executable.');
  });
  return proc;
}

/**
 * Ask the OS default handler to open the page.
 *
 * Windows needs `start` with an empty title argument first: `start <url>` treats
 * a quoted first argument as the window title, so the URL would be swallowed.
 */
function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const opener = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  // No browser handler on this machine is a nuisance, not a failure: the server
  // is up and the URL is printed, so say what to do instead of dying.
  opener.once('error', () => {
    console.log(`start: could not open a browser. Open ${url} yourself.`);
  });
}

/**
 * Run serve.js on one port, forwarding its output, and open the browser the
 * moment it reports a bound socket. Resolves with the exit outcome.
 */
function serveOnce(port, openBrowser, appMode, electronMode, debug = false) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [SERVE_SCRIPT, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;

    let log = '';
    let announced = false;
    const pump = (chunk, to) => {
      log += chunk;
      to.write(chunk);
      if (announced) return;
      const ready = READY.exec(log);
      if (ready === null) return;
      announced = true;
      if (electronMode) appChild = openElectronWindow(ready[1], debug);
      else if (appMode) appChild = openAppWindow(ready[1]);
      else if (openBrowser) openInBrowser(ready[1]);
      console.log(`start: ${ready[1]} — Ctrl+C to stop.`);
    };
    proc.stdout.on('data', (chunk) => pump(chunk, process.stdout));
    proc.stderr.on('data', (chunk) => pump(chunk, process.stderr));

    proc.once('exit', (code, signal) => {
      child = null;
      done({ code: signal === null ? (code ?? 1) : 1, log });
    });
  });
}

/**
 * Ctrl+C / Ctrl+Break: shut the server down without orphaning its Chromium.
 *
 * serve.js usually receives the same console signal and closes its own browser,
 * so it gets a short grace period; taskkill /T only runs if it is still alive.
 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // The app window belongs to this session: take it down too, for the same
  // reason serve.js's headless Chromium must not be orphaned. Chrome
  // reparents its children, so a tree-kill of the launched PID misses them;
  // match on the dedicated profile directory instead - precise (only our
  // isolated instance carries it) and leaves the user's own Chrome alone.
  if (appChild !== null) {
    killStaleInstances();
    if (process.platform === 'win32') {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
        "Where-Object CommandLine -like '*electron*main.cjs*' | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
        { stdio: 'ignore', windowsHide: true });
    } else {
      spawnSync('pkill', ['-f', 'electron.*main.cjs'], { stdio: 'ignore' });
    }
  }
  const proc = child;
  if (proc === null) {
    process.exit(0);
    return;
  }
  proc.once('exit', () => process.exit(0));
  setTimeout(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  }, 1200).unref();
}

// SIGBREAK is Ctrl+Break on Windows only; registering it elsewhere throws.
for (const signal of process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM'] : ['SIGINT', 'SIGTERM']) {
  process.once(signal, shutdown);
}

const { port, explicit, browser, app, electron, debug } = parseArgs(process.argv.slice(2));

// A zombie serve.js from a dead launcher holds the port AND splits the show
// across two servers; the new launcher owns the script, so at startup every
// existing serve.js is a zombie.
killStaleServe();

let attempt = port ?? DEFAULT_PORT;
for (let tries = 0; ; tries++) {
  const outcome = await serveOnce(attempt, browser, app, electron, debug);
  if (outcome.code === 0 || shuttingDown) break;
  // An explicit port is a request, not a preference. Only an unrequested 8080
  // may move, and only once.
  if (explicit || tries > 0 || !/already in use/.test(outcome.log)) {
    process.exitCode = outcome.code;
    break;
  }
  let fallback = null;
  try {
    fallback = await freePort();
  } catch (err) {
    // Only reachable on a machine whose whole dynamic range is blocked ports.
    console.error(`start: ${err.message}`);
    process.exitCode = 1;
    break;
  }
  console.log(`start: port ${attempt} is already in use — using ${fallback} instead.`);
  attempt = fallback;
}

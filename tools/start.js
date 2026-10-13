/**
 * start.js — the one command that runs the wall.
 *
 * `npm start` boots tools/serve.js, waits until the server has actually bound,
 * opens the loopback URL in the default browser, and takes the whole process
 * tree down on Ctrl+C.
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
import { fileURLToPath } from 'node:url';

import { freePort, isFetchablePort } from './ports.js';

const SERVE_SCRIPT = fileURLToPath(new URL('./serve.js', import.meta.url));
const DEFAULT_PORT = 8080;

/** serve.js announces itself; the URL in that line is the truth about the port. */
const READY = /LED wall dev server: (http:\/\/127\.0\.0\.1:\d+)/;

/** The serve.js child this process is responsible for tearing down. */
let child = null;
let shuttingDown = false;

function usage() {
  console.error('usage: npm start [-- --port <port>] [--no-browser]');
  console.error('       node tools/start.js [--port 8090] [--no-browser]');
}

/** Same flag/env precedence as serve.js: --port > PORT > 8080. */
function parseArgs(argv) {
  let flag = null;
  let browser = true;

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
  if (raw === null) return { port: null, explicit: false, browser };

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
  return { port, explicit, browser };
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
function serveOnce(port, openBrowser) {
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
      if (openBrowser) openInBrowser(ready[1]);
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

const { port, explicit, browser } = parseArgs(process.argv.slice(2));

let attempt = port ?? DEFAULT_PORT;
for (let tries = 0; ; tries++) {
  const outcome = await serveOnce(attempt, browser);
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

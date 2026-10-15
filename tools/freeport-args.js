// tools/freeport-args.js - pure arg parsing for freeport (unit-testable).

const USAGE =
  'usage: npm run freeport -- COM8 [--kill]\n' +
  '  finds the process holding a COM port (Windows handle-table scan);\n' +
  '  --kill terminates it - the only real "force disconnect" on Windows.';

/** Parse CLI args: a COM port name, optional --kill. */
export function parsePortArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('-'));
  const pos = argv.filter((a) => !a.startsWith('-'));
  if (pos.length !== 1 || !/^com\d+$/i.test(pos[0])) {
    return { ok: false, usage: USAGE };
  }
  const bad = flags.filter((f) => f !== '--kill');
  if (bad.length > 0) return { ok: false, usage: `${USAGE}\nfreeport: unknown flag ${bad[0]}` };
  return { ok: true, port: pos[0].toUpperCase(), kill: flags.includes('--kill') };
}

export function shouldKill(args) {
  return args.kill === true;
}

export function formatHolders(holders) {
  return holders
    .map((h) => `freeport: ${h.device} held by pid ${h.pid} (${h.name})`)
    .join('\n');
}

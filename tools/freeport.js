// tools/freeport.js - find (and optionally kill) the process holding a COM port.
//
// The scan lives in tools/freeport-scan.js (shared with the server's
// takeover endpoint); this file is the CLI around it.
//
// Usage:
//   node tools/freeport.js COM8          -> report the holder
//   node tools/freeport.js COM8 --kill   -> terminate it
//
// Same-user processes are found without elevation; a holder running as
// Admin is only visible/killable from an elevated session.

import { spawnSync } from 'node:child_process';
import { parsePortArgs, formatHolders, shouldKill } from './freeport-args.js';
import { findHolders, killHolders } from './freeport-scan.js';

const args = parsePortArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(args.usage);
  process.exit(2);
}
console.log(`freeport: scanning for the process holding ${args.port}...`);
const found = findHolders(args.port);
if (!found.ok) {
  console.error(`freeport: ${found.error}`);
  process.exit(1);
}
if (found.holders.length === 0) {
  console.log(`freeport: no holder found - ${args.port} is free (or held by a process this session cannot see; an Admin-held port needs an Admin shell).`);
  process.exit(0);
}
console.log(formatHolders(found.holders));
if (shouldKill(args)) {
  for (const r of killHolders(found.holders)) {
    console.log(`freeport: kill ${r.pid} (${r.name}) -> ${r.killed ? 'terminated' : `failed (${r.reason})`}`);
  }
} else {
  console.log('freeport: rerun with --kill to terminate the holder (its own work is lost - that is the force disconnect).');
}

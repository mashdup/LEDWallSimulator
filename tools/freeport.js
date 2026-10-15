// tools/freeport.js - find (and optionally kill) the process holding a COM port.
//
// Windows COM ports are exclusive: the Arduino monitor, PuTTY, or a stale
// bridge process holds the handle, and no API closes it on another process's
// behalf. The only 'force disconnect' is to terminate the holder - so the
// useful tool is one that NAMES the holder (the pre-flight says 'COM8 is
// busy'; this says 'COM8 is held by arduino-ide.exe, pid 1234') and kills it
// on request.
//
// Method: the classic handle.exe algorithm. NtQuerySystemInformation gives
// every open handle system-wide; for each, duplicate it into our process and
// ask what it is. A COM port handle is object type 'File' (measured: there is
// no 'Device' type in the census), and naming File objects is the classic
// NtQueryObject hang - pipes and mailslots block the call forever. So File
// handles are named on worker threads with a 100 ms budget; hung queries are
// abandoned (the thread is a background thread and this process exits right
// after, so the OS reclaims everything). The match is the device path:
// QueryDosDevice('COM8') -> '\Device\Serial0'.
//
// Usage:
//   node tools/freeport.js COM8          -> report the holder
//   node tools/freeport.js COM8 --kill   -> terminate it
//
// Same-user processes are found without elevation; a holder running as
// Admin is only visible/killable from an elevated session.

import { spawnSync } from 'node:child_process';
import { parsePortArgs, formatHolders, shouldKill } from './freeport-args.js';

// C# injected into PowerShell (Add-Type compiles with the legacy CodeDom
// compiler: no IntPtr arithmetic, no string interpolation, no var-in-lambda
// fancy stuff beyond C# 5).
const CS = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;

public class PortHolder {
  [StructLayout(LayoutKind.Sequential)]
  struct Entry {
    public int Pid;
    public byte ObjectTypeIndex;
    public byte HandleFlags;
    public ushort Handle;
    public IntPtr Object;
    public int GrantedAccess;
  }

  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtDuplicateObject(IntPtr srcProc, IntPtr h, IntPtr dstProc, out IntPtr acc, int access, int attrs, int opts);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint QueryDosDevice(string name, StringBuilder sb, uint len);
  [DllImport("kernel32.dll")] static extern int GetCurrentProcessId();

  const int SystemHandleInformation = 16;
  const int ObjectNameInformation = 1;
  const int ObjectTypeInformation = 2;
  const int PROCESS_DUP_HANDLE = 0x40;
  const int DUPLICATE_SAME_ACCESS = 2;

  class Cand { public int Pid; public IntPtr Dup; }

  static string ReadUnicodeString(IntPtr buf) {
    ushort len = (ushort)Marshal.ReadInt16(buf, 0);
    IntPtr str = Marshal.ReadIntPtr(buf, IntPtr.Size == 8 ? 8 : 4);
    if (len == 0 || str == IntPtr.Zero) return "";
    return Marshal.PtrToStringUni(str, len / 2);
  }

  // Runs on a worker: NtQueryObject(name) can block forever on pipes.
  static string QueryName(IntPtr dup) {
    IntPtr q = Marshal.AllocHGlobal(4096);
    int r;
    try {
      if (NtQueryObject(dup, ObjectNameInformation, q, 4096, out r) != 0) return null;
      return ReadUnicodeString(q);
    } finally { Marshal.FreeHGlobal(q); }
  }

  static string NameWithTimeout(IntPtr dup, int budgetMs) {
    string name = null;
    ManualResetEvent done = new ManualResetEvent(false);
    ThreadStart work = delegate {
      try { name = QueryName(dup); } catch { }
      done.Set();
    };
    Thread th = new Thread(work);
    th.IsBackground = true; // a hung NtQueryObject must not keep us alive
    th.Start();
    if (!done.WaitOne(budgetMs)) return null; // abandoned; process exits soon
    return name;
  }

  public static string Find(string comName) {
    StringBuilder dev = new StringBuilder(260);
    if (QueryDosDevice(comName, dev, (uint)dev.Capacity) == 0) return "NODEVICE " + comName;
    string target = dev.ToString();
    int self = GetCurrentProcessId();

    int len = 1 << 20, ret;
    IntPtr buf = Marshal.AllocHGlobal(len);
    List<Cand> files = new List<Cand>();
    try {
      while (NtQuerySystemInformation(SystemHandleInformation, buf, len, out ret) == unchecked((int)0xC0000004)) {
        Marshal.FreeHGlobal(buf); len *= 2; buf = Marshal.AllocHGlobal(len);
      }
      int count = Marshal.ReadInt32(buf);
      int entrySize = Marshal.SizeOf(typeof(Entry));
      IntPtr basePtr = IntPtr.Add(buf, IntPtr.Size);
      IntPtr curProc = (IntPtr)(-1);

      for (int i = 0; i < count; i++) {
        IntPtr eptr = IntPtr.Add(basePtr, i * entrySize);
        Entry e = (Entry)Marshal.PtrToStructure(eptr, typeof(Entry));
        if (e.Pid == 0 || e.Pid == 4 || e.Pid == self) continue;
        IntPtr proc = OpenProcess(PROCESS_DUP_HANDLE, false, e.Pid);
        if (proc == IntPtr.Zero) continue;
        IntPtr dup;
        int st = NtDuplicateObject(proc, (IntPtr)e.Handle, curProc, out dup, 0, 0, DUPLICATE_SAME_ACCESS);
        CloseHandle(proc);
        if (st != 0 || dup == IntPtr.Zero) continue;

        IntPtr q = Marshal.AllocHGlobal(4096);
        int r2;
        string type = null;
        try {
          if (NtQueryObject(dup, ObjectTypeInformation, q, 4096, out r2) == 0) type = ReadUnicodeString(q);
        } finally { Marshal.FreeHGlobal(q); }
        if (type == "File") {
          Cand c = new Cand(); c.Pid = e.Pid; c.Dup = dup;
          files.Add(c); // named in phase 2, with timeouts
        } else {
          CloseHandle(dup);
        }
      }
    } finally { Marshal.FreeHGlobal(buf); }

    // Phase 2: name the File handles in parallel; hung queries are abandoned.
    object gate = new object();
    Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = 16 },
      delegate (Cand c) {
        string name = NameWithTimeout(c.Dup, 100);
        CloseHandle(c.Dup);
        if (name != null && string.Equals(name, target, StringComparison.OrdinalIgnoreCase)) {
          string pname;
          try { pname = System.Diagnostics.Process.GetProcessById(c.Pid).ProcessName; }
          catch { pname = "?"; }
          lock (gate) { Console.WriteLine("HOLDER " + c.Pid + " " + pname + " " + name); }
        }
      });
    return "DONE";
  }
}
`;

function findHolder(comName) {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition @'\n${CS}\n'@; [PortHolder]::Find('${comName}')`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 }
  );
  if (ps.error) return { error: `PowerShell unavailable: ${ps.error.message}` };
  const lines = String(ps.stdout ?? '').split(/\r?\n/);
  if (lines.some((l) => l.startsWith('NODEVICE'))) return { error: `${comName} does not exist on this machine.` };
  const holders = [];
  for (const line of lines) {
    const m = /^HOLDER (\d+) (\S+) (.+)$/.exec(line.trim());
    if (m) holders.push({ pid: Number(m[1]), name: m[2], device: m[3] });
  }
  return { holders };
}

const args = parsePortArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(args.usage);
  process.exit(2);
}
console.log(`freeport: scanning for the process holding ${args.port}...`);
const found = findHolder(args.port);
if (found.error) {
  console.error(`freeport: ${found.error}`);
  process.exit(1);
}
if (found.holders.length === 0) {
  console.log(`freeport: no holder found - ${args.port} is free (or held by a process this session cannot see; an Admin-held port needs an Admin shell).`);
  process.exit(0);
}
console.log(formatHolders(found.holders));
if (shouldKill(args)) {
  for (const h of found.holders) {
    const kill = spawnSync('taskkill.exe', ['/F', '/PID', String(h.pid)], { encoding: 'utf8', windowsHide: true });
    console.log(`freeport: kill ${h.pid} (${h.name}) -> ${kill.status === 0 ? 'terminated' : `failed (${(kill.stderr ?? '').trim()})`}`);
  }
} else {
  console.log('freeport: rerun with --kill to terminate the holder (its own work is lost - that is the force disconnect).');
}

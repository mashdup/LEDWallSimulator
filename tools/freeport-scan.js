// tools/freeport-scan.js - the COM-port handle scan, shared by the CLI
// (tools/freeport.js) and the server's takeover endpoint (tools/serial.js).
//
// Windows COM ports are exclusive: a stale process holds the handle and no
// API closes it on another process's behalf. The classic handle.exe
// algorithm: NtQuerySystemInformation lists every open handle; duplicate
// each and ask what it is. A COM port handle is object type 'File'
// (measured: no 'Device' type exists here), and naming File objects is the
// classic NtQueryObject hang - so File handles are named on worker threads
// with a 100 ms budget and hung queries are abandoned. The match is the
// device path: QueryDosDevice('COM8') -> '\Device\Serial0'.

import { spawnSync } from 'node:child_process';

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

/** Find every process holding `comName` (e.g. 'COM8'). Never throws. */
export function findHolders(comName) {
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition @'\n${CS}\n'@; [PortHolder]::Find('${comName}')`],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 }
  );
  if (ps.error) return { ok: false, error: `PowerShell unavailable: ${ps.error.message}`, holders: [] };
  const lines = String(ps.stdout ?? '').split(/\r?\n/);
  if (lines.some((l) => l.startsWith('NODEVICE'))) return { ok: false, error: `${comName} does not exist on this machine.`, holders: [] };
  const holders = [];
  for (const line of lines) {
    const m = /^HOLDER (\d+) (\S+) (.+)$/.exec(line.trim());
    if (m) holders.push({ pid: Number(m[1]), name: m[2], device: m[3] });
  }
  return { ok: true, error: null, holders };
}

/**
 * Terminate holders, filtered by a killable(name) predicate. A Connect
 * takeover must never kill arbitrary processes: the caller decides which
 * names are fair game (our own Electron zombies), everything else is
 * reported untouched. Never throws.
 */
export function killHolders(holders, killable = () => true) {
  const results = [];
  for (const h of holders) {
    if (!killable(h.name)) {
      results.push({ ...h, killed: false, reason: 'not an auto-killable process name' });
      continue;
    }
    const kill = spawnSync('taskkill.exe', ['/F', '/PID', String(h.pid)], { encoding: 'utf8', windowsHide: true });
    results.push({ ...h, killed: kill.status === 0, reason: kill.status === 0 ? 'terminated' : (kill.stderr ?? 'kill failed').trim() });
  }
  return results;
}

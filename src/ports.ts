// Phase 49: which processes listen on a local TCP port, and whether one of them belongs to a
// process tree (a background job). Previews only ever reach a port that her own job opened, so a
// job that merely prints "listening on :11434" can't make Sara proxy to another local service.
// Linux: /proc (net/tcp + each process's open sockets); Windows: netstat + the process list;
// macOS: lsof + ps. Anything that can't be checked counts as "not owned" (fail closed).
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

const run = (file: string, args: string[], timeoutMs = 8000): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });

/** Parent of every process (pid → ppid). */
export async function processParents(platform: NodeJS.Platform = process.platform): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // "pid (comm) state ppid …": comm may contain spaces and parentheses, so read after the last ')'.
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.set(Number(name), Number(rest[1]));
      } catch {
        /* gone */
      }
    }
    return out;
  }
  if (platform === 'win32') {
    // WMI now and then answers "Call cancelled" or "Quota violation" part-way through on a busy
    // machine (a cut list): a complete list always has this process in it, so try again until it does.
    // Asking for only the two fields keeps the query small, which is what fails far less often.
    let text = '';
    const self = new RegExp(`^${process.pid} \\d+\\s*$`, 'm');
    for (let i = 0; i < 3 && !self.test(text); i++) {
      if (i) await new Promise((r) => setTimeout(r, 300 * i));
      text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], 20_000);
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m) out.set(Number(m[1]), Number(m[2]));
    }
    return out;
  }
  const text = await run('/bin/ps', ['-axo', 'pid=,ppid=']);
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

/** A process and everything it started (by parent links). */
export function processTree(root: number, parents: Map<number, number>): Set<number> {
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (!tree.has(pid) && tree.has(ppid) && pid !== ppid) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

/**
 * One listening socket on a port. `reaches` = a connection to 127.0.0.1:port (the only address the
 * preview proxy uses) can land on it: IPv4 127.x / 0.0.0.0, or an IPv6 "any" socket on Linux/macOS
 * (dual-stack there by default). IPv6 loopback ([::1]) never counts: it is a separate socket, and a
 * job that binds [::1]:P next to another program's 127.0.0.1:P must not get that program previewed.
 */
export interface Listener {
  pid: number;
  reaches: boolean;
}

/** /proc/net/tcp* local address (hex) → does a 127.0.0.1 connection reach it? */
function reachesHex(hex: string): boolean {
  if (hex.length === 8) {
    // IPv4 in /proc is little-endian per 32-bit word: 0100007F = 127.0.0.1.
    const first = parseInt(hex.slice(6, 8), 16);
    return hex === '00000000' || first === 127;
  }
  // IPv6: only "any" (dual-stack) and v4-mapped 127.x / 0.0.0.0; never ::1.
  return /^0{32}$/.test(hex) || /^0000000000000000FFFF0000..00007F$/i.test(hex) || /^0000000000000000FFFF000000000000$/i.test(hex);
}

/** Parses /proc/net/tcp or tcp6: inode → reaches, for sockets listening on `port`. */
export function parseProcNet(text: string, port: number, out = new Map<string, boolean>()): Map<string, boolean> {
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue; // 0A = LISTEN
    const [addr, p] = f[1].split(':');
    if (parseInt(p, 16) !== port) continue;
    const hex = addr.toUpperCase();
    // Loopback/any only (a listener on a LAN address isn't reached by the proxy either).
    if (reachesHex(hex) || hex === '00000000000000000000000001000000') out.set(f[9], reachesHex(hex) || (out.get(f[9]) ?? false));
  }
  return out;
}

/** Socket inodes listening on `port` (Linux): inode → reaches 127.0.0.1. */
export function listeningInodes(port: number, tables: string[] = ['/proc/net/tcp', '/proc/net/tcp6']): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const t of tables) {
    try {
      parseProcNet(readFileSync(t, 'utf8'), port, out);
    } catch {
      continue;
    }
  }
  return out;
}

/** Parses `netstat -ano` (Windows). Dual-stack sockets show up twice there (0.0.0.0 and [::]), so only IPv4 lines reach. */
export function parseNetstat(text: string, port: number): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'TCP' || !/LISTEN/i.test(f[3])) continue;
    const local = f[1];
    const p = Number(local.slice(local.lastIndexOf(':') + 1));
    const host = local.slice(0, local.lastIndexOf(':'));
    if (p !== port) continue;
    if (/^(127\.|0\.0\.0\.0$)/.test(host)) out.push({ pid: Number(f[4]), reaches: true });
    else if (/^\[(::|::1)\]$/.test(host)) out.push({ pid: Number(f[4]), reaches: false });
  }
  return out;
}

/**
 * Phase 89: parses lines "<local address> <local port> <remote address> <remote port> [<state>] <pid>"
 * from Get-NetTCPConnection (Windows). Some Windows 11 builds leave listening sockets out of
 * `netstat -ano` and show them here with an empty or wrong state ("Closed"); a listener is the row
 * with no remote end (0.0.0.0 / :: and port 0) that isn't merely bound.
 */
export function parseNetTcp(text: string, port: number): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+) (\d+) (\S+) (\d+) \[(\w*)\] (\d+)$/.exec(line.trim());
    if (!m || Number(m[2]) !== port || m[4] !== '0' || !/^(0\.0\.0\.0|::)$/.test(m[3]) || /^bound$/i.test(m[5])) continue;
    const host = m[1];
    if (/^(127\.|0\.0\.0\.0$)/.test(host)) out.push({ pid: Number(m[6]), reaches: true });
    else if (host === '::' || host === '::1') out.push({ pid: Number(m[6]), reaches: false });
  }
  return out;
}

/** Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fptn` (macOS). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('f')) type = '';
    else if (line.startsWith('t')) type = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const name = line.slice(1);
      if (type === 'IPv4' || (!type && /^(127\.|\d)/.test(name))) {
        if (/^(127\.|\*:|0\.0\.0\.0:|localhost:)/.test(name)) out.push({ pid, reaches: true });
      } else if (/^\*:/.test(name)) out.push({ pid, reaches: true }); // IPv6 any: dual-stack on macOS
      else if (/^\[::1\]|^\[::ffff:127\./.test(name)) out.push({ pid, reaches: /ffff:127\./.test(name) });
    }
  }
  return out;
}

/** Local listeners on a TCP port (loopback or any address), with whether 127.0.0.1 reaches each. */
export async function portListeners(port: number, platform: NodeJS.Platform = process.platform): Promise<Listener[]> {
  if (platform === 'linux') {
    const inodes = listeningInodes(port);
    const out: Listener[] = [];
    const found = new Set<string>();
    if (!inodes.size) return out;
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${name}/fd`);
      } catch {
        continue; // not ours to look at, or gone
      }
      for (const fd of fds) {
        try {
          const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${name}/fd/${fd}`));
          if (m && inodes.has(m[1])) {
            out.push({ pid: Number(name), reaches: inodes.get(m[1])! });
            found.add(m[1]);
          }
        } catch {
          /* closed meanwhile */
        }
      }
    }
    // A reaching socket whose owner we can't see (another user's process) still blocks the port.
    for (const [inode, reaches] of inodes) if (reaches && !found.has(inode)) out.push({ pid: -1, reaches: true });
    return out;
  }
  if (platform === 'win32') {
    const text = await run('netstat.exe', ['-ano', '-p', 'TCP']);
    const text6 = await run('netstat.exe', ['-ano', '-p', 'TCPv6']);
    const found = parseNetstat(`${text}\n${text6}`, port);
    if (found.length) return found;
    // Phase 89: some Windows 11 builds leave listeners out of netstat: ask the TCP table another way.
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -LocalPort ${Math.trunc(port)} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress) $($_.LocalPort) $($_.RemoteAddress) $($_.RemotePort) [$($_.State)] $($_.OwningProcess)" }`], 15_000);
    return parseNetTcp(ps, port);
  }
  return parseLsof(await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fptn']));
}

/**
 * The decision, given the listeners and `root`'s process tree: a process in the tree must listen
 * where the proxy connects (127.0.0.1), and no process outside the tree may listen there too.
 */
export function ownsPort(listeners: Listener[], tree: Set<number>): boolean {
  const reach = listeners.filter((l) => l.reaches);
  if (!reach.length) return false;
  return reach.some((l) => tree.has(l.pid)) && reach.every((l) => tree.has(l.pid));
}

/** True when `root`'s tree (and nobody else) listens on 127.0.0.1:`port` (or a socket that 127.0.0.1 reaches). */
export async function treeListensOn(root: number, port: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const listeners = await portListeners(port, platform);
    if (!listeners.some((l) => l.reaches)) return false;
    const tree = processTree(root, await processParents(platform));
    return ownsPort(listeners, tree);
  } catch {
    return false;
  }
}

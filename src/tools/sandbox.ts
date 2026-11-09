// Process sandbox for the shell tool. On Linux with bubblewrap, commands run in fresh namespaces
// with a read-only system, only the workspace writable, and none of Sara's data (keys, database)
// visible. On macOS, the system's own sandbox-exec (Seatbelt) does the same with a generated
// profile. Without either (Windows), commands run directly in the workspace (clearly labelled), and
// the command tools ask the owner before every command unless the owner chose otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { containerRunArgv, containerUser } from '../container.ts';
import { egressAllowlist, engineEnv, openEgress, sandboxNode } from '../egress-run.ts';
import { privateLocalOn } from '../net-guard.ts';

/**
 * The workspace is HOME for commands, so this acts as git's global config: a default identity and
 * branch name. Repository config (`git config user.name ...`) still takes precedence.
 */
export function ensureGitConfig(workspace: string): void {
  const file = join(workspace, '.gitconfig');
  try {
    lstatSync(file);
    return; // already there (a file or a link: never written through)
  } catch {
    /* create it */
  }
  try {
    // 'wx': fails instead of following a link planted in the meantime.
    writeFileSync(file, '[user]\n\tname = Sara\n\temail = sara@localhost\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n', { flag: 'wx' });
  } catch {
    /* someone else made it */
  }
  excludeOwnFiles(workspace);
}

/**
 * When the workspace itself is a git repository, the app's own files in it (this .gitconfig, the
 * task files handed to Claude Code / Grok Build, caches tools write to HOME) are kept out of
 * commits through the repository's local exclude list (never committed, never pushed).
 */
export function excludeOwnFiles(workspace: string): void {
  const info = join(workspace, '.git', 'info');
  const file = join(info, 'exclude');
  try {
    if (!lstatSync(join(workspace, '.git')).isDirectory()) return;
    if (!existsSync(info)) return;
    let cur = '';
    try {
      if (lstatSync(file).isSymbolicLink()) return;
      cur = readFileSync(file, 'utf8');
    } catch {
      cur = '';
    }
    // The workspace is HOME for commands, so tools leave their caches and histories at its top.
    const own = ['/.gitconfig', '/.sara-task-*', '/.npm/', '/npm-cache/', '/.cache/', '/.local/', '/.pnpm-store/', '/.bash_history', '/.node_repl_history', '/.python_history', '/.lesshst', '/.wget-hsts'];
    const want = own.filter((l) => !cur.split(/\r?\n/).includes(l));
    if (want.length) writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}# Sara's own files\n${want.join('\n')}\n`);
  } catch {
    /* not a repository */
  }
}

/**
 * 'user' mode: the workspace belongs to the tools user's group (setgid, so new files do too) and the
 * data folders above it can be passed through but not listed or read.
 */
export function prepareForToolsUser(workspace: string, gid: number): void {
  try {
    const st = statSync(workspace);
    if (st.gid !== gid || (st.mode & 0o2070) !== 0o2070) {
      // First use: hand everything already in it to the tools group (once).
      const walk = (p: string) => {
        const e = lstatSync(p);
        if (e.isSymbolicLink()) return;
        chownSync(p, e.uid, gid);
        chmodSync(p, e.isDirectory() ? (e.mode & 0o7777) | 0o2070 : (e.mode & 0o7777) | 0o060);
        if (e.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
      };
      walk(workspace);
    }
    // Its parents (the workspaces folder and the data folder): passable (x) but not readable.
    for (let d = dirname(workspace), i = 0; i < 2; d = dirname(d), i++) {
      const st = statSync(d);
      if ((st.mode & 0o001) === 0) chmodSync(d, (st.mode & 0o7770) | 0o001);
    }
  } catch {
    // not root or not Linux: nothing to prepare
  }
}

/**
 * 'user' mode, at startup: nothing in the data folder is readable by other accounts, except the
 * workspaces and MCP homes the tools user works in (prepared when used). The folder itself stays
 * passable so the tools user can reach its workspace by path.
 */
export function lockDataDir(dataDir: string): void {
  const skip = new Set([join(dataDir, 'workspaces'), join(dataDir, 'mcp')]);
  const walk = (p: string) => {
    if (skip.has(p)) return;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.mode & 0o007) chmodSync(p, st.mode & 0o7770);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(dataDir);
  chmodSync(dataDir, 0o711);
  for (const d of skip) if (existsSync(d)) chmodSync(d, (statSync(d).mode & 0o7770) | 0o001);
}

export type SandboxMode = 'bwrap' | 'user' | 'seatbelt' | 'container' | 'none';

export interface SandboxInfo {
  mode: SandboxMode;
  /** Allow network access inside the sandbox (git clone, npm install, curl). */
  network: boolean;
  detail: string;
  /** EC8 'container' mode: the engine and its local image. */
  container?: { engine: 'podman' | 'docker'; exe: string; rootless: boolean; image: string; pre?: string[] };
  /** EC8: the admin requires a container sandbox and none works: every command is refused with this. */
  refuse?: string;
  /** EC8 'container' mode: the computer's own sandbox, for what keeps running outside containers
   * (tool servers, plugin processes, the testing browser, coding agents). */
  native?: SandboxInfo;
  /** 'user' mode: the unprivileged account commands run as. */
  uid?: number;
  gid?: number;
  /** 'seatbelt' mode: Sara's data folder, which commands may not read. */
  dataDir?: string;
}

/** EC8: the sandbox for things that are not run in a container (the container's native fallback). */
export function nativeOf(sb: SandboxInfo): SandboxInfo {
  return sb.mode === 'container' && sb.native ? { ...sb.native, network: sb.network } : sb;
}

/** The macOS sandbox tool (ships with every macOS). */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** What the owner is told when commands run without a sandbox. */
export function noSandboxNote(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'No sandbox on Windows: she asks before every command.';
  if (platform === 'darwin') return 'No sandbox on this Mac: she asks before every command.';
  return 'No sandbox: she asks before every command.';
}

export type SandboxPreference = 'auto' | 'bwrap' | 'seatbelt' | 'none';

export function detectSandbox(preference: SandboxPreference = 'auto', network = true, opts: { dataDir?: string } = {}): SandboxInfo {
  if (preference === 'none') return { mode: 'none', network, detail: `Sandbox switched off by configuration (SARA_SANDBOX=none). ${noSandboxNote()}` };
  if (process.platform === 'darwin') {
    const probe = existsSync(SANDBOX_EXEC) ? spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 }) : undefined;
    if (probe?.status === 0) return { mode: 'seatbelt', network, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), detail: "macOS sandbox: only the workspace writable; your home folder (documents, keys, mail) and Sara's data hidden." };
    if (preference !== 'auto') throw new Error('Sandbox required but the macOS sandbox (sandbox-exec) is not working.');
    return { mode: 'none', network, detail: `The macOS sandbox (sandbox-exec) isn't working. ${noSandboxNote('darwin')}` };
  }
  if (process.platform !== 'linux') {
    if (preference !== 'auto') throw new Error(`Sandbox required, but there is no command sandbox on ${process.platform === 'win32' ? 'Windows' : process.platform}.`);
    return { mode: 'none', network, detail: `Commands run directly in the workspace. ${noSandboxNote()}` };
  }
  if (preference === 'seatbelt') throw new Error('The seatbelt sandbox is for macOS; use bwrap or auto on Linux.');
  const probe = spawnSync('bwrap', [...bwrapArgs('/tmp', network), '/bin/sh', '-c', 'true'], { timeout: 5000 });
  if (probe.status === 0) return { mode: 'bwrap', network, detail: 'bubblewrap: read-only system, workspace writable, Sara data hidden.' };
  const why = probe.error ? 'bubblewrap is not installed' : `bubblewrap failed: ${String(probe.stderr).trim().slice(0, 200)}`;
  if (preference === 'bwrap') throw new Error(`Sandbox required but ${why}.`);
  // Containers (Docker) usually can't use bubblewrap. Running as root there, commands run as a
  // separate unprivileged user that can't read Sara's data (keys, database), only the workspace.
  const toolsUser = process.env.SARA_TOOLS_USER;
  if (toolsUser && process.getuid?.() === 0) {
    const id = (flag: string) => Number(String(spawnSync('id', [flag, toolsUser]).stdout).trim());
    const uid = id('-u');
    const gid = id('-g');
    if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0) {
      return { mode: 'user', network, uid, gid, detail: `separate user "${toolsUser}": commands can't read Sara's data, only the workspace.` };
    }
  }
  return { mode: 'none', network, detail: `${why}; commands run directly. Install bubblewrap for isolation. ${noSandboxNote('linux')}` };
}

/** A string in a Seatbelt profile (SBPL): double quotes with backslash escapes. */
export function sbplString(s: string): string {
  if (/[\0\n\r]/.test(s)) throw new Error('A sandbox path may not contain line breaks.');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export interface SeatbeltPaths {
  workspace: string;
  /** This run's own temporary folder (TMPDIR). */
  tmp: string;
  /** Sara's data folder: never readable (except the workspace inside it). */
  dataDir?: string;
  /** The owner's home folder (for ~/.ssh, ~/Library/Keychains and similar). */
  home?: string;
  /** Extra folders (a coding agent's own sign-in folder). */
  binds?: Bind[];
  /** Node's (and Sara's) own program folder: readable even when it is under the home folder. */
  runtime?: string;
  /** EC9: network off except this local egress proxy port. */
  proxyPort?: number;
}

/** Mach services a sandboxed command may look up on macOS (everything else is denied). */
export const SEATBELT_MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.DirectoryService.libinfo_v1',
  'com.apple.system.logger',
  'com.apple.logd',
  'com.apple.logd.events',
  'com.apple.system.notification_center',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.mDNSResponder',
  'com.apple.dnssd.service',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
  'com.apple.diagnosticd',
] as const;

/**
 * The macOS sandbox profile for one command. Seatbelt applies the last rule that matches, so the
 * order is: reading allowed broadly; then Sara's data and the owner's secrets hidden; then the
 * workspace and this run's temporary folder readable and writable again. Network only when on.
 */
export function seatbeltProfile(p: SeatbeltPaths, network: boolean): string {
  const home = p.home ?? homedir();
  // The owner's whole home folder is hidden (documents, photos, mail, keys…): her commands use the
  // workspace as their home, so they never need it. Only the workspace, this run's temp folder and
  // Node/Sara's own program folder (it may live in ~/Applications) are opened again below.
  // Security review (M6): also every other user's home (/Users), mounted disks and backup drives
  // (/Volumes, where copies of her vault key may live) and the per-user temporary folders
  // (/var/folders: other runs' temp folders, the testing browser's profiles); this run's own temp
  // folder is opened again below.
  const hidden = [...(p.dataDir ? [p.dataDir] : []), home, '/Users', '/Volumes', '/var/folders'];
  // The same folder can be reached through /private (/var, /tmp, /etc are links on macOS).
  const both = (d: string) => [...new Set([d, realOr(d)])];
  const sub = (d: string) => both(d).map((x) => `(subpath ${sbplString(x)})`).join(' ');
  const writable = [p.workspace, p.tmp, ...(p.binds ?? []).filter((b) => b.rw).map((b) => b.src)];
  const readable = [...(p.binds ?? []).filter((b) => !b.rw).map((b) => b.src), ...(p.runtime ? [p.runtime] : [])];
  // Tools such as git look up every folder above the working folder (stat, not listing). The
  // workspace lies inside the hidden data folder, so those folders themselves may be looked up,
  // never listed or read (verified on macOS 27: without this git says "Invalid path").
  const ancestors = new Set<string>();
  for (const d of [...writable, ...readable]) {
    for (const x of both(d)) {
      for (let a = posix.dirname(x); a !== '/' && a !== '.'; a = posix.dirname(a)) ancestors.add(a);
    }
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    // Security review (M6): only the system services everyday command-line tools need (user
    // lookups, logging, notifications, network settings, DNS, certificate checks, preferences).
    // Not LaunchServices or Apple Events (`open -a`, `osascript` could start programs outside the
    // sandbox), not the pasteboard, not the keychain (securityd).
    `(allow mach-lookup ${SEATBELT_MACH_SERVICES.map((n) => `(global-name ${sbplString(n)})`).join(' ')} (global-name-regex #"^com\\.apple\\.trustd"))`,
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow user-preference-read)',
    '(allow iokit-open)',
    '(allow pseudo-tty)',
    '(allow file-read*)',
    `(deny file-read* file-write* ${hidden.map(sub).join(' ')})`,
    `(allow file-read* file-write* ${writable.map(sub).join(' ')})`,
    ...(readable.length ? [`(allow file-read* ${readable.map(sub).join(' ')})`] : []),
    ...(ancestors.size ? [`(allow file-read-metadata ${[...ancestors].map((a) => `(literal ${sbplString(a)})`).join(' ')})`] : []),
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))',
    '(allow file-ioctl (regex #"^/dev/"))',
    network ? '(allow network*)' : '(allow network* (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ...(!network && p.proxyPort ? [`(allow network-outbound (remote ip "localhost:${Math.trunc(p.proxyPort)}"))`] : []),
  ].join('\n');
}

/** SARA_PROGRAM_PATH: extra program folders an operator gives Sara alone (a newer Python on a server
 *  whose system python3 must stay old). Absolute, no `..`; on Linux only under /usr, the part of the
 *  host the sandbox shows. */
function programPath(platform: NodeJS.Platform): string[] {
  return (process.env.SARA_PROGRAM_PATH ?? '')
    .split(':')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('/') && !d.split('/').includes('..') && (platform !== 'linux' || d.startsWith('/usr/')));
}

/** Where commands find programs when they run outside bubblewrap. */
export function commandPath(platform: NodeJS.Platform = process.platform, execPath = process.execPath): string {
  // Sara's own Node first (the installers bring a private one), so node/npm/npx are current.
  const own = dirname(execPath);
  // Apple's /usr/bin/git, make, clang… are shims (xcrun) that write a lookup cache into the user's
  // temporary folder, which the sandbox doesn't allow (a planted cache could redirect the owner's
  // own tools). The real programs in the developer folder come first instead.
  const dev = platform === 'darwin' ? developerBin() : undefined;
  const extra = programPath(platform);
  if (platform === 'darwin') return [own, ...extra, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...(dev ? [dev] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `${runtimeMountArgs().length ? `${RUNTIME_MOUNT}/bin:` : ''}${extra.map((d) => `${d}:`).join('')}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}

let devBin: string | null | undefined;
/** The Xcode / command line tools program folder on this Mac (`xcode-select -p`/usr/bin), if any. */
export function developerBin(): string | undefined {
  if (devBin !== undefined) return devBin ?? undefined;
  devBin = null;
  if (process.platform !== 'darwin') return undefined;
  try {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'], { timeout: 5000, encoding: 'utf8' });
    const dir = r.status === 0 ? posix.join(String(r.stdout).trim(), 'usr', 'bin') : '';
    if (dir.startsWith('/') && existsSync(posix.join(dir, 'git'))) devBin = dir;
  } catch {
    devBin = null;
  }
  return devBin ?? undefined;
}

/** Git for Windows' bash, when it's there (commands are written for sh); else cmd.exe. */
export function windowsShell(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): { file: string; args: (cmd: string) => string[]; sh: boolean } {
  const candidates = [
    `${env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`,
    `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Git\\bin\\bash.exe`,
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`] : []),
  ];
  for (const c of candidates) if (exists(c)) return { file: c, args: (cmd) => ['-c', cmd], sh: true };
  return { file: env.ComSpec ?? 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', cmd], sh: false };
}

/** C2: Windows process ids of the members of MSYS process group `pgid`, from Git Bash's `ps`
 * (columns PID PPID PGID WINPID ...). Never Sara herself or her parent, never group 0. */
export function msysGroupWinPids(psOutput: string, pgid: number, me: { self: number; parent: number } = { self: process.pid, parent: process.ppid }): number[] {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return [];
  const out: number[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (/^[A-Z]$/.test(c[0] ?? '')) c.shift(); // a status letter (S stopped, I waiting for input, O output)
    if (c.length < 4 || !/^\d+$/.test(c[2]) || !/^\d+$/.test(c[3])) continue;
    const win = Number(c[3]);
    if (Number(c[2]) === pgid && win > 0 && win !== me.self && win !== me.parent) out.push(win);
  }
  return out;
}

/** C2: ends every process of the Git Bash shell's own process group (the shell wrote its id to
 * `mark`). `ps` is Git's own (no WMI), so this stays quick on a busy PC. Best effort. */
async function stopShellGroup(bashFile: string, mark: string): Promise<void> {
  let pgid = NaN;
  for (let i = 0; i < 20 && !(pgid > 0); i++) {
    try {
      pgid = Number(readFileSync(mark, 'utf8').trim());
    } catch {
      await new Promise((r) => setTimeout(r, 50)); // stopped before the shell got that far
    }
  }
  if (!(pgid > 0)) return;
  const ps = win32.join(win32.dirname(win32.dirname(bashFile)), 'usr', 'bin', 'ps.exe');
  const out = await new Promise<string>((res) => {
    try {
      const p = spawn(ps, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      p.stdout.on('data', (d: Buffer) => (text += d.toString('utf8')));
      const timer = setTimeout(() => p.kill(), 10_000);
      p.on('close', () => (clearTimeout(timer), res(text)));
      p.on('error', () => (clearTimeout(timer), res('')));
    } catch {
      res('');
    }
  });
  for (const w of msysGroupWinPids(out, pgid)) {
    try {
      process.kill(w, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * The environment of a command on Windows (no sandbox there). Keeps what programs need to find
 * themselves (LOCALAPPDATA/APPDATA: Python, npm and Git look there; without them the Python install
 * manager thinks nothing is installed and downloads a new Python into the workspace), and leaves
 * the WindowsApps folder off the PATH: its python/python3 are store aliases, not real programs.
 */
export function windowsToolEnv(env: NodeJS.ProcessEnv, workspace: string, execPath = process.execPath): Record<string, string> {
  const keep = ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LOCALAPPDATA', 'APPDATA'];
  const path = (env.PATH ?? env.Path ?? '')
    .split(';')
    .filter((p) => p && !/[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(p.trim()));
  const out: Record<string, string> = { PATH: [win32.dirname(execPath), ...path].join(';'), USERPROFILE: workspace };
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** A short hint for the model when a program couldn't listen because the port is taken. */
export function portInUseHint(output: string): string {
  if (!/EADDRINUSE|address already in use|WinError 100(13|48)|Only one usage of each socket address|forbidden by its access permissions/i.test(output)) return '';
  const port = /EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(output)?.[1] ?? /\bport\s+(\d{2,5})\b/i.exec(output)?.[1];
  return `\n[hint: ${port ? `port ${port} is` : 'that port is'} already used by another program on this computer (or blocked). Don't ask for admin rights: start it again on another port, e.g. 5173, 8137 or 8765, and check it's free first.]`;
}

/** Where Sara's own Node runtime appears inside the sandbox (read-only). */
export const RUNTIME_MOUNT = '/opt/sara-node';

/**
 * Sara's private Node (e.g. /opt/sara/node) mounted read-only, so shell commands and MCP servers get
 * a current Node/npm/npx even when the system one is old. Nothing else from /opt is visible.
 */
export function runtimeMountArgs(execPath = process.execPath): string[] {
  const root = dirname(dirname(execPath));
  if (process.platform !== 'linux' || root.startsWith('/usr') || root === '/' || !existsSync(join(root, 'bin', 'npx'))) return [];
  return ['--ro-bind', root, RUNTIME_MOUNT];
}

function systemDirArgs(): string[] {
  const args: string[] = ['--ro-bind', '/usr', '/usr'];
  for (const d of ['/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
    if (!existsSync(d)) continue;
    const st = lstatSync(d);
    if (st.isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
    else args.push('--ro-bind', d, d);
  }
  // /etc is needed for DNS, TLS roots and user lookups. /opt, /home, /root, /var and /srv are
  // deliberately not mounted: on shared servers they hold other applications' files.
  args.push('--ro-bind', '/etc', '/etc');
  args.push(...runtimeMountArgs());
  return args;
}

export function bwrapArgs(workspace: string, network: boolean, binds: Bind[] = []): string[] {
  return [
    ...systemDirArgs(),
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/lib',
    '--bind', workspace, '/workspace',
    '--chdir', '/workspace',
    '--unshare-all',
    ...(network ? ['--share-net'] : []),
    '--die-with-parent',
    '--new-session',
    '--setenv', 'HOME', '/workspace',
    ...binds.flatMap((b) => [b.rw ? '--bind' : '--ro-bind', b.src, b.dest]),
  ];
}

/** An extra folder made visible inside the sandbox (e.g. a coding agent's own sign-in folder). */
export interface Bind {
  src: string;
  dest: string;
  rw?: boolean;
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  ms: number;
}

const SAFE_ENV = (home: string): NodeJS.ProcessEnv => ({
  PATH: commandPath(),
  HOME: home,
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  GIT_TERMINAL_PROMPT: '0',
});

/** Runs a shell command in the workspace. Never passes Sara's own environment (secrets) through. */
export interface RunOptions {
  timeoutMs: number;
  signal: AbortSignal;
  maxBytes?: number;
  gitName?: string;
  /** Output as it arrives (background jobs show progress). */
  onOutput?: (text: string) => void;
  /** Extra environment for this command only (never Sara's own environment). */
  env?: Record<string, string>;
  /** Extra folders inside the sandbox (bubblewrap); with other modes they're used in place. */
  binds?: Bind[];
  /** Phase 49: the started process (a preview only reaches ports this process tree listens on). */
  onSpawn?: (pid: number) => void;
}

/**
 * Phase 67: what commands get while "Nothing leaves this computer" is on, on top of a sandbox with
 * no network (bubblewrap, the macOS sandbox). Without such a sandbox (Windows, plain Linux) this is
 * best effort only: programs that honour these settings (git, npm, pip, curl, most HTTP libraries)
 * go nowhere, but a program that ignores them can still connect. docs/PRIVATE_LOCAL.md says so.
 */
export const PRIVATE_LOCAL_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  // git: only local repositories (no https, ssh or git:// remotes).
  GIT_ALLOW_PROTOCOL: 'file',
  npm_config_offline: 'true',
  PIP_NO_INDEX: '1',
  SARA_PRIVATE_LOCAL: '1',
};

/** EC8: a refused sandbox (the admin requires containers and none works) never runs anything. */
export function refusedRun(why: string): RunResult {
  return { exitCode: null, output: why, timedOut: false, ms: 0 };
}

/**
 * Runs a shell command in the workspace. EC9: when the egress allowlist is on and the command has
 * network, it only reaches listed hosts, through a proxy enforced by the strongest boundary the
 * sandbox has (src/egress-run.ts).
 */
export async function runCommand(command: string, workspace: string, sandbox: SandboxInfo, opts: RunOptions): Promise<RunResult> {
  if (sandbox.refuse) return refusedRun(sandbox.refuse);
  const allow = sandbox.network && !privateLocalOn() ? egressAllowlist() : undefined;
  if (!allow) return runPrepared(command, workspace, sandbox, opts, {});
  let eg;
  try {
    eg = await openEgress(sandbox, allow, { who: 'command', node: sandboxNode(process.execPath, runtimeMountArgs().length > 0, RUNTIME_MOUNT) });
  } catch (err) {
    return refusedRun(`The egress allowlist could not be set up, so the command did not run: ${(err as Error).message}`);
  }
  try {
    return await runPrepared(`${eg.prefix ?? ''}${command}`, workspace, eg.sandbox, { ...opts, env: { ...opts.env, ...eg.env }, binds: [...(opts.binds ?? []), ...eg.binds] }, { ...(eg.network ? { network: eg.network } : {}), ...(eg.hosts ? { hosts: eg.hosts } : {}), ...(eg.proxyPort ? { proxyPort: eg.proxyPort } : {}) });
  } finally {
    await eg.close();
  }
}

function runPrepared(command: string, workspace: string, sandbox: SandboxInfo, opts: RunOptions, extra: { network?: string; hosts?: string[]; proxyPort?: number }): Promise<RunResult> {
  // Phase 67: private local mode: no network for any command, whatever the caller asked for.
  const noNet = privateLocalOn();
  if (noNet) sandbox = { ...sandbox, network: false };
  const maxBytes = opts.maxBytes ?? 200_000;
  const started = Date.now();
  try {
    ensureGitConfig(workspace);
  } catch {
    // read-only or missing workspace: the command will report it
  }
  // No core dumps; cap single files at 4 GB (sh only: cmd.exe has no ulimit).
  const winShell = sandbox.mode === 'none' && process.platform === 'win32' ? windowsShell() : undefined;
  if (!winShell || winShell.sh) command = `ulimit -c 0 2>/dev/null; ulimit -f 8388608 2>/dev/null; ${command}`;
  let file: string;
  let args: string[];
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let containerName: string | undefined;
  // macOS and Windows: each run gets its own temporary folder (bubblewrap has its own /tmp; Linux
  // without it keeps the system one, which the separate tools user can write to).
  let runTmp: string | undefined;
  if (sandbox.mode === 'seatbelt' || sandbox.mode === 'container' || (sandbox.mode === 'none' && process.platform !== 'linux')) {
    try {
      runTmp = mkdtempSync(join(tmpdir(), 'sara-run-'));
    } catch {
      runTmp = undefined;
    }
  }
  // C2: Windows with Git Bash: the shell writes its own process id (its process group) where Stop
  // can read it. The command could rewrite it, but there it already runs as the owner, unsandboxed.
  // Kept next to the run's temp folder, not in it: the command's temp folder starts empty.
  const shellMark = winShell?.sh && runTmp ? `${runTmp}.shell` : undefined;
  if (shellMark) command = `printf %s $$ > '${shellMark.replaceAll("'", "'\\''")}' 2>/dev/null; ${command}`;
  const tmpEnv = runTmp && sandbox.mode !== 'container' ? (process.platform === 'win32' ? { TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp } : { TMPDIR: runTmp }) : {};
  if (sandbox.mode === 'bwrap') {
    file = 'bwrap';
    args = [...bwrapArgs(workspace, sandbox.network, opts.binds), '/bin/sh', '-c', command];
    cwd = workspace;
    env = SAFE_ENV('/workspace');
  } else if (sandbox.mode === 'user') {
    file = '/bin/sh';
    args = ['-c', command];
    cwd = workspace;
    env = SAFE_ENV(workspace);
    prepareForToolsUser(workspace, sandbox.gid!);
  } else if (sandbox.mode === 'seatbelt') {
    file = SANDBOX_EXEC;
    const ws = realOr(workspace);
    args = ['-p', seatbeltProfile({ workspace: ws, tmp: realOr(runTmp ?? tmpdir()), runtime: realOr(dirname(dirname(process.execPath))), ...(sandbox.dataDir ? { dataDir: realOr(sandbox.dataDir) } : {}), ...(opts.binds ? { binds: opts.binds } : {}), ...(extra.proxyPort ? { proxyPort: extra.proxyPort } : {}) }, sandbox.network), '/bin/sh', '-c', command];
    cwd = ws;
    env = SAFE_ENV(ws);
  } else if (sandbox.mode === 'container' && sandbox.container) {
    // EC8: the engine CLI, no host shell. The variables go in a private env file (no values in argv,
    // and the CLI keeps its own HOME/PATH); the container is named so a stop can kill it.
    const c = sandbox.container;
    containerName = `sara-${randomUUID().slice(0, 13)}`;
    const inner: Record<string, string> = { HOME: '/workspace', LANG: 'C.UTF-8', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', ...(opts.gitName ? { GIT_AUTHOR_NAME: opts.gitName, GIT_COMMITTER_NAME: opts.gitName } : {}), ...opts.env, ...(noNet ? PRIVATE_LOCAL_ENV : {}) };
    const envFile = join(runTmp ?? mkdtempSync(join(tmpdir(), 'sara-run-')), 'env');
    writeFileSync(envFile, Object.entries(inner).filter(([k, v]) => /^[A-Za-z_]\w*$/.test(k) && !/[\r\n\0]/.test(v)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    file = c.exe;
    args = [...(c.pre ?? []), ...containerRunArgv({ name: containerName, image: c.image, workspace, mounts: (opts.binds ?? []).map((b) => ({ src: b.src, dest: b.dest, ...(b.rw ? { rw: true } : {}) })), network: extra.network ?? (sandbox.network ? 'default' : 'none'), ...(extra.hosts ? { hosts: extra.hosts } : {}), env: [], envFile, ...(containerUser(c) ? { user: containerUser(c) } : {}), argv: ['/bin/sh', '-c', command] })];
    cwd = workspace;
    env = engineEnv();
  } else if (process.platform === 'win32') {
    file = winShell!.file;
    args = winShell!.args(command);
    cwd = workspace;
    env = { ...SAFE_ENV(workspace), ...windowsToolEnv(process.env, workspace) };
  } else {
    file = '/bin/sh';
    args = ['-c', command];
    cwd = workspace;
    env = SAFE_ENV(workspace);
  }

  return new Promise((resolvePromise) => {
  // Commits made in the workspace carry the companion's name (repo config still wins for user.name).
  // (A container gets these through its env file; the engine CLI keeps its own environment.)
  if (sandbox.mode !== 'container') {
    if (opts.gitName) env = { ...env, GIT_AUTHOR_NAME: opts.gitName, GIT_COMMITTER_NAME: opts.gitName };
    if (opts.env) env = { ...env, ...opts.env };
    env = { ...env, ...tmpEnv, ...(noNet ? PRIVATE_LOCAL_ENV : {}) };
  }
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(sandbox.mode === 'user' ? { uid: sandbox.uid, gid: sandbox.gid } : {}) });
    if (child.pid) opts.onSpawn?.(child.pid);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (b: Buffer) => {
      opts.onOutput?.(b.toString('utf8'));
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      chunks.push(b.subarray(0, maxBytes - size));
      size += b.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const kill = () => {
      // EC8: stopping the CLI does not stop its container: ask the engine to kill it by name.
      if (containerName && sandbox.container) {
        const c = sandbox.container;
        try {
          spawn(c.exe, [...(c.pre ?? []), 'kill', containerName], { stdio: 'ignore', windowsHide: true, shell: false, env: engineEnv() }).on('error', () => {});
        } catch {
          /* the CLI kill below still ends the wait */
        }
      }
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        // Windows: the whole tree (bash and whatever it started), not just the shell.
        else if (child.pid) {
          // MNT2: on a busy PC taskkill can take 15 s or more and sometimes gives up ("Call
          // cancelled"), which left the command running until its timeout. Try the tree once more,
          // then end the process itself (the exit grace below stops reading what it started). The
          // shell is never ended first: taskkill /T needs it alive to find its children.
          const alive = () => child.exitCode === null && child.signalCode === null;
          const direct = () => { if (alive()) child.kill('SIGKILL'); };
          const tree = (again: boolean) => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', direct).on('exit', (code) => { if (code !== 0 && alive()) { if (again) tree(false); else direct(); } });
          tree(true);
          // C2: taskkill goes through WMI and on a loaded PC took 15-25 s, often failing. Git Bash
          // lists its own processes without WMI: end the shell's process group directly (started
          // after taskkill so it has already begun walking the tree for native grandchildren).
          if (shellMark && winShell?.sh) void stopShellGroup(winShell.file, shellMark);
        } else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    // MNT2: a stop that came while the command was being prepared (egress, container checks) fires
    // no 'abort' event any more; without this the process ran until its timeout.
    if (opts.signal.aborted) kill();
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal.removeEventListener('abort', onAbort);
      if (runTmp) {
        try {
          rmSync(runTmp, { recursive: true, force: true, maxRetries: 3 });
          if (shellMark) rmSync(shellMark, { force: true });
        } catch {
          // a program still holds a file in it (Windows): the system cleans its temp folder
        }
      }
      let output = Buffer.concat(chunks).toString('utf8') + extra;
      if (truncated) output += `\n[output truncated at ${maxBytes} bytes]`;
      if (exitCode !== 0) output += portInUseHint(output);
      resolvePromise({ exitCode, output, timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => finish(null, `Failed to start: ${err.message}`));
    child.on('close', (code) => finish(code));
    // The shell has ended, but something it started (a server left running with &, or on Windows a
    // program taskkill missed) may still hold its output open, and 'close' would never come. Give it a
    // moment, then stop reading and answer, so the tool never hangs.
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, timedOut ? '' : '\n[a program it started is still running in the background]');
      }, 3000);
      graceTimer.unref?.();
    });
  });
}

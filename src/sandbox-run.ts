// Phase 80 (harness track M5, docs/design/HARNESS_TRACK.md §2.4, §3 M5, §6 risks 3-5, §7 #1): the
// sandbox gate. A risky command she wants to run in a coding conversation (or a team helper's run)
// first runs in a THROWAWAY COPY of the workspace, inside the strongest isolation this computer has:
//
//   Linux     bubblewrap (the existing shell sandbox, src/tools/sandbox.ts): the copy writable, the
//             rest of the system read-only, home and Sara's data hidden, no network unless allowed.
//   macOS     the Seatbelt profile from src/tools/sandbox.ts, with the copy as the only writable place.
//   Windows   Docker (a local image, never pulled) or WSL2 with bubblewrap when present; otherwise the
//             copy only, labelled NOT isolated: the copy plus a watch of the real workspace and a
//             canary file beside the copy, and the owner is always asked before anything is applied.
//
// Then it looks at what the command did (files added / changed / removed in the copy, writes outside
// the copy, network attempts it could see, processes left running, exit code, time) and hands back a
// SandboxResult. The owner chooses: Apply to my workspace (only the diff is written back), Discard,
// or Run for real (the normal run, an explicit choice). Nothing here skips an approval, the safety
// layer, the plan check (M2) or the budget (M4): src/chat.ts and src/team.ts call it at their
// approval point. Later milestones (M6 security pass, M7 threat pass, M11 red-team) use
// runInSandbox() and the Finding-shaped observations directly.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { SNAPSHOT_SKIP } from './snapshots.ts';
import { workspaceRef, type WorkspaceRef } from './runs.ts';
import { PRIVATE_LOCAL_ENV, runCommand, windowsShell, type Bind, type RunResult, type SandboxInfo } from './tools/sandbox.ts';
import { resolveInside } from './tools/workspace.ts';

// ------------------------------------------------------------------------------------------------
// 1. Which commands are risky (code only; no model call)
// ------------------------------------------------------------------------------------------------

/** Why a command goes to the sandbox first. */
export type RiskReason = 'writes' | 'installs' | 'deletes' | 'network' | 'scripts' | 'system';
export const RISK_REASONS: readonly RiskReason[] = ['writes', 'installs', 'deletes', 'network', 'scripts', 'system'];

export interface CommandRisk {
  /** Anything that may change files, reach the network or run code. Read-only commands are false. */
  risky: boolean;
  reasons: RiskReason[];
  /**
   * Git's own commands that change the repository rather than files (commit, push, checkout of a
   * branch, merge, …). A copy can't hand those back, so they keep the normal approval (and the
   * plan check, M2) instead of the sandbox.
   */
  gitOnly?: boolean;
}

/** Programs that only read (with the exceptions handled below). */
const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'pwd', 'echo', 'printf', 'true', 'false',
  'which', 'where', 'type', 'whereis', 'file', 'stat', 'du', 'df', 'tree', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'comm', 'basename', 'dirname',
  'realpath', 'readlink', 'date', 'printenv', 'id', 'whoami', 'uname', 'hostname', 'test', '[', 'jq', 'xxd', 'od', 'hexdump', 'md5sum',
  'sha1sum', 'sha256sum', 'shasum', 'nl', 'column', 'seq', 'sleep', 'cd', 'sort', 'awk', 'sed', 'find', 'ps', 'uptime', 'free', 'nproc', 'locale',
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'reflog', 'count-objects', 'whatchanged', 'name-rev', 'merge-base', 'check-ignore', 'version', 'help', 'rev-list', 'for-each-ref', 'show-ref', 'var']);
/** Git commands that change files only (the copy can hand those back). */
const GIT_FILES = new Set(['clean', 'restore']);
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
const INSTALLERS: Record<string, RegExp> = {
  npm: /^(install|i|ci|add|update|up|upgrade|uninstall|remove|rm|un|link|dedupe|prune|rebuild)$/,
  pnpm: /^(install|i|add|update|up|remove|rm|un|uninstall|link|prune|rebuild|dlx|import)$/,
  yarn: /^(install|add|upgrade|up|remove|link|dlx)$/,
  bun: /^(install|i|add|update|remove|rm|link|x)$/,
  pip: /^(install|uninstall|download|wheel)$/,
  pip3: /^(install|uninstall|download|wheel)$/,
  uv: /^(pip|add|sync|remove|tool|lock|venv)$/,
  poetry: /^(add|install|update|remove|lock)$/,
  pipenv: /^(install|uninstall|update|sync|lock)$/,
  cargo: /^(add|install|update|remove|fetch)$/,
  go: /^(get|install|mod)$/,
  gem: /^(install|update|uninstall)$/,
  bundle: /^(install|update|add)$/,
  composer: /^(install|require|update|remove)$/,
  dotnet: /^(add|restore|tool)$/,
};
const SYSTEM_INSTALLERS = new Set(['apt', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'brew', 'port', 'choco', 'winget', 'scoop', 'snap', 'flatpak', 'zypper']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat', 'ping', 'nslookup', 'dig', 'host', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'aria2c', 'http', 'gh']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item']);
const WRITERS = new Set(['touch', 'mkdir', 'cp', 'mv', 'ln', 'chmod', 'chown', 'chgrp', 'tee', 'dd', 'truncate', 'install', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', 'patch', 'copy', 'move', 'ren', 'rename', 'mklink', 'new-item', 'set-content', 'out-file', 'copy-item', 'move-item']);
const SYSTEM = new Set(['kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'shutdown', 'reboot', 'halt', 'poweroff', 'sudo', 'su', 'doas', 'runas', 'systemctl', 'service', 'launchctl', 'sc', 'reg', 'crontab', 'at', 'schtasks', 'mount', 'umount', 'chroot', 'setx']);

/** Replaces quoted text with a placeholder so `>` or `;` inside quotes doesn't count. */
function unquote(s: string): string {
  return s.replace(/'[^']*'/g, "'q'").replace(/"(?:[^"\\]|\\.)*"/g, '"q"');
}

/** The program a command segment runs (env assignments, `command`, `exec`, `time`, `nice` skipped). */
function programOf(tokens: string[]): { prog: string; rest: string[] } {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || /^(command|exec|time|nice|nohup|builtin|env)$/.test(tokens[i]))) {
    // `env FOO=1 node x.js`, `command -v x` (read-only lookup), `nohup node server.js &`
    if (tokens[i] === 'command' && tokens[i + 1] === '-v') return { prog: 'which', rest: tokens.slice(i + 2) };
    i++;
  }
  const raw = tokens[i] ?? '';
  const prog = raw.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return { prog: raw.startsWith('./') || raw.startsWith('../') || /^[A-Za-z]:[\\/]/.test(raw) || (raw.startsWith('/') && !/^\/(usr\/)?s?bin\//.test(raw)) ? `./${prog}` : prog, rest: tokens.slice(i + 1) };
}

/**
 * Sorts a shell command into read-only (passes straight through) or risky (goes to the sandbox
 * first) with the reasons. Unknown programs count as running code. Pure; no model call.
 */
export function classifyCommand(command: string): CommandRisk {
  const reasons = new Set<RiskReason>();
  let gitOnly = false;
  let anyNonGit = false;
  const cmd = String(command ?? '').trim();
  if (!cmd) return { risky: false, reasons: [] };
  const flat = unquote(cmd);
  // Command substitution or process substitution runs whatever is inside: treat as code.
  if (/\$\(|`|<\(|>\(/.test(flat)) reasons.add('scripts');
  // Output redirection to a file (not to /dev/null or another stream; `2>&1` is fine).
  for (const m of flat.matchAll(/(?:^|[^<>&0-9])(?:[0-9]|&)?>{1,2}\s*([^\s;&|<>]+)/g)) {
    const target = m[1];
    if (!/^(\/dev\/null|nul|NUL|\$null)$/.test(target) && !/^&[0-9-]$/.test(target)) reasons.add('writes');
  }
  // A heredoc into a program can be a script; a pipe into a shell or interpreter is.
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|python3?|node|perl|ruby|php|iex|invoke-expression)\b/i.test(flat)) reasons.add('scripts');
  // `2>&1`, `>&2`, `&>file` are redirections, not command separators.
  const noFd = (x: string) => x.replace(/[0-9]*>&[0-9-]+|&>>?|>&/g, ' > ');
  const segments = noFd(flat).split(/\|\||&&|[;|&\n]/).map((s) => s.trim()).filter(Boolean);
  const rawSegments = noFd(cmd).split(/\|\||&&|[;|&\n]/).map((s) => s.trim());
  segments.forEach((seg, n) => {
    const tokens = seg.split(/\s+/).filter(Boolean);
    let { prog, rest } = programOf(tokens);
    // `sudo …` / `doas …`: a system change, and whatever it runs counts too.
    while (prog === 'sudo' || prog === 'doas') {
      reasons.add('system');
      const r2 = rest.filter((tk, i) => !tk.startsWith('-') && !/^-[ugpCh]$/.test(rest[i - 1] ?? ''));
      ({ prog, rest } = programOf(r2));
    }
    const raw = rawSegments[n] ?? seg;
    const has = (re: RegExp) => rest.some((t) => re.test(t));
    if (!prog) return;
    if (prog === 'git') {
      const sub = rest.find((t) => !t.startsWith('-')) ?? '';
      const after = rest.slice(rest.indexOf(sub) + 1);
      if (!sub || GIT_READ.has(sub)) return;
      if (sub === 'branch' && after.every((t) => /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--verbose|--contains|--merged|--no-merged)$/.test(t) || !t.startsWith('-')) && !after.some((t) => /^-[dDmMcC]$|^--(delete|move|copy|force)$/.test(t)) && after.filter((t) => !t.startsWith('-')).length === 0) return;
      if (sub === 'tag' && (after.length === 0 || after.every((t) => /^(-l|--list|-n\d*)$/.test(t)))) return;
      if (sub === 'remote' && (after.length === 0 || after.every((t) => /^(-v|--verbose|show|get-url)$/.test(t) || !t.startsWith('-')) && !['add', 'remove', 'rm', 'rename', 'set-url', 'prune'].includes(after[0] ?? ''))) return;
      if (sub === 'config' && after.some((t) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(t))) return;
      if (sub === 'stash' && /^(list|show)$/.test(after[0] ?? '')) return;
      if (sub === 'worktree' && after[0] === 'list') return;
      if (GIT_FILES.has(sub) && !after.some((t) => /^(--staged|-S)$/.test(t))) {
        anyNonGit = true;
        reasons.add(sub === 'clean' ? 'deletes' : 'writes');
        return;
      }
      if (sub === 'checkout' && after.includes('--')) {
        anyNonGit = true;
        reasons.add('writes');
        return;
      }
      // The rest changes the repository itself: the normal approval and the plan check decide.
      gitOnly = true;
      reasons.add(GIT_NETWORK.has(sub) ? 'network' : 'writes');
      return;
    }
    anyNonGit = true;
    if (prog === 'find') {
      if (has(/^-(delete)$/)) reasons.add('deletes');
      if (has(/^-(exec|execdir|ok|okdir)$/)) reasons.add('scripts');
      if (has(/^-fprint/)) reasons.add('writes');
      return;
    }
    if (prog === 'sed') {
      if (has(/^-i|^--in-place/)) reasons.add('writes');
      if (/\bw\s|\/w\s|e\s/.test(raw) && /'[^']*\b[we]\b/.test(raw)) reasons.add('scripts');
      return;
    }
    if (prog === 'awk' || prog === 'gawk') {
      if (/system\s*\(|print[^;'"]*>|\|\s*getline|\|\s*"/.test(raw)) reasons.add('scripts');
      return;
    }
    if (prog === 'sort') {
      if (has(/^-o|^--output/)) reasons.add('writes');
      return;
    }
    if (READ_ONLY.has(prog)) return;
    // node -v, python --version, npm ls… only read.
    if (/^(node|python3?|py|ruby|perl|php|java|go|cargo|rustc|dotnet|deno|bun|npm|pnpm|yarn|pip3?|uv|gcc|clang|make|cmake|tsc)$/.test(prog) && rest.length > 0 && rest.every((t) => /^(-v|-V|--version|version)$/.test(t))) return;
    if (/^(npm|pnpm|yarn)$/.test(prog) && /^(ls|list|ll|la|view|info|show|config|get|explain|why|help|prefix|root|bin)$/.test(rest[0] ?? '') && !has(/^set$/)) return;
    if (/^(pip3?)$/.test(prog) && /^(list|show|freeze|check|help)$/.test(rest[0] ?? '')) return;
    if (SYSTEM_INSTALLERS.has(prog)) {
      reasons.add('installs');
      reasons.add('network');
      reasons.add('system');
      return;
    }
    const inst = INSTALLERS[prog];
    if (inst && inst.test(rest[0] ?? '')) {
      reasons.add('installs');
      reasons.add('network');
      return;
    }
    if (/^python3?$|^py$/.test(prog) && rest[0] === '-m' && /^(pip|ensurepip|venv)$/.test(rest[1] ?? '')) {
      reasons.add('installs');
      if (rest[1] === 'pip') reasons.add('network');
      return;
    }
    if (/^(npx|pnpx|bunx)$/.test(prog)) {
      reasons.add('scripts');
      reasons.add('network');
      return;
    }
    if (NETWORK.has(prog)) {
      reasons.add('network');
      if (prog === 'curl' && has(/^-o|^-O|^--output/)) reasons.add('writes');
      if (prog === 'wget') reasons.add('writes');
      return;
    }
    if (DELETERS.has(prog)) {
      reasons.add('deletes');
      return;
    }
    if (WRITERS.has(prog)) {
      reasons.add('writes');
      return;
    }
    if (SYSTEM.has(prog)) {
      reasons.add('system');
      return;
    }
    // Everything else runs code: interpreters, build tools, test runners, ./scripts, unknown programs.
    reasons.add('scripts');
  });
  const list = RISK_REASONS.filter((r) => reasons.has(r));
  return { risky: list.length > 0, reasons: list, ...(gitOnly && !anyNonGit ? { gitOnly: true } : {}) };
}

// ------------------------------------------------------------------------------------------------
// 2. Settings (Settings → Coding → Coding projects → "Try commands in a sandbox first")
// ------------------------------------------------------------------------------------------------

export type SandboxGateMode = 'off' | 'risky' | 'every';
export const SANDBOX_GATE_MODES: readonly SandboxGateMode[] = ['off', 'risky', 'every'];
/** Largest copy, in MB (the workspace without dependency folders). */
export const SANDBOX_SIZE_CHOICES = [100, 500, 2000] as const;
/** The longest a try may run before it is stopped (seconds). */
export const SANDBOX_TIME_CHOICES = [60, 120, 300, 600] as const;

export interface SandboxGateSettings {
  mode: SandboxGateMode;
  /** Let a try use the network (off: no network inside; a best-effort block in copy-only mode). */
  network: boolean;
  maxMB: (typeof SANDBOX_SIZE_CHOICES)[number];
  timeLimitS: (typeof SANDBOX_TIME_CHOICES)[number];
  /** Docker image used on Windows when Docker is present (local only: never pulled). */
  dockerImage: string;
}

/** §7 #1: on by default for risky commands on every platform (isolated where it can be). */
export const DEFAULT_SANDBOX_GATE: SandboxGateSettings = { mode: 'risky', network: false, maxMB: 500, timeLimitS: 120, dockerImage: 'node:24-slim' };

export function sandboxGateSettings(s: { sandboxGate?: Partial<SandboxGateSettings> } | undefined): SandboxGateSettings {
  const g = s?.sandboxGate ?? {};
  return {
    mode: SANDBOX_GATE_MODES.includes(g.mode as SandboxGateMode) ? (g.mode as SandboxGateMode) : DEFAULT_SANDBOX_GATE.mode,
    network: typeof g.network === 'boolean' ? g.network : DEFAULT_SANDBOX_GATE.network,
    maxMB: (SANDBOX_SIZE_CHOICES as readonly number[]).includes(Number(g.maxMB)) ? (Number(g.maxMB) as SandboxGateSettings['maxMB']) : DEFAULT_SANDBOX_GATE.maxMB,
    timeLimitS: (SANDBOX_TIME_CHOICES as readonly number[]).includes(Number(g.timeLimitS)) ? (Number(g.timeLimitS) as SandboxGateSettings['timeLimitS']) : DEFAULT_SANDBOX_GATE.timeLimitS,
    dockerImage: typeof g.dockerImage === 'string' && /^[a-z0-9][a-z0-9._\/-]{0,120}(:[\w.-]{1,64})?$/i.test(g.dockerImage) ? g.dockerImage : DEFAULT_SANDBOX_GATE.dockerImage,
  };
}

/** A settings PUT body checked and merged onto the current settings (an invalid value keeps the saved one). */
export function mergeSandboxGate(cur: SandboxGateSettings, body: Record<string, unknown>): SandboxGateSettings {
  const out = { ...cur };
  for (const k of ['mode', 'network', 'maxMB', 'timeLimitS', 'dockerImage'] as const) {
    if (body[k] === undefined) continue;
    const next = sandboxGateSettings({ sandboxGate: { ...cur, [k]: body[k] } as Partial<SandboxGateSettings> });
    if (next[k] === body[k]) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// 3. Isolation available on this computer
// ------------------------------------------------------------------------------------------------

export type SandboxDriver = 'bwrap' | 'seatbelt' | 'docker' | 'wsl' | 'copy';

export interface Isolation {
  driver: SandboxDriver;
  /** An OS boundary: writes outside the copy, the home folder and (unless allowed) the network are blocked. */
  isolated: boolean;
  /** Plain words for the card and Settings. */
  label: string;
  /** What was found (Windows: Docker / WSL2), for Settings. */
  found?: { docker: boolean; dockerImage?: boolean; wsl: boolean; wslBwrap?: boolean };
}

export const ISOLATION_LABELS: Record<SandboxDriver, string> = {
  bwrap: 'Isolated (bubblewrap): only the copy is writable; no network unless allowed.',
  seatbelt: 'Isolated (macOS sandbox): only the copy is writable; no network unless allowed.',
  docker: 'Isolated (Docker): only the copy is mounted; no network unless allowed.',
  wsl: 'Isolated (WSL2 with bubblewrap): only the copy is writable; no network unless allowed.',
  copy: 'Not isolated: it runs in a copy, but the command could still reach other files on this computer. Writes outside the copy are watched and flagged.',
};

export interface DetectDeps {
  platform?: NodeJS.Platform;
  /** Runs a probe (tests replace it). Returns the exit status. */
  probe?: (file: string, args: string[]) => number | null;
  /** Whether a file exists (tests replace it so the Windows path can be checked on any system). */
  exists?: (path: string) => boolean;
}

const probeRun = (file: string, args: string[]): number | null => {
  try {
    const r = spawnSync(file, args, { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    return r.error ? null : r.status;
  } catch {
    return null;
  }
};

/** The windows wsl.exe (never through PATH). */
export function wslExe(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/**
 * The strongest isolation for tries. Linux/macOS: the existing shell sandbox (bubblewrap /
 * Seatbelt). Windows: Docker with the image already present, else WSL2 with bubblewrap inside,
 * else the copy only. Nothing is installed or downloaded.
 */
export function detectIsolation(base: SandboxInfo, gate: Pick<SandboxGateSettings, 'dockerImage'> = DEFAULT_SANDBOX_GATE, deps: DetectDeps = {}): Isolation {
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? probeRun;
  if (base.mode === 'bwrap') return { driver: 'bwrap', isolated: true, label: ISOLATION_LABELS.bwrap };
  if (base.mode === 'seatbelt') return { driver: 'seatbelt', isolated: true, label: ISOLATION_LABELS.seatbelt };
  if (platform === 'win32') {
    const docker = probe('docker', ['version', '--format', '{{.Server.Version}}']) === 0;
    const dockerImage = docker && probe('docker', ['image', 'inspect', '--format', '{{.Id}}', gate.dockerImage]) === 0;
    if (docker && dockerImage) return { driver: 'docker', isolated: true, label: ISOLATION_LABELS.docker, found: { docker, dockerImage, wsl: false } };
    const wsl = (deps.exists ?? existsSync)(wslExe()) && probe(wslExe(), ['--status']) === 0;
    const wslBwrap = wsl && probe(wslExe(), ['-e', 'sh', '-c', 'command -v bwrap >/dev/null && bwrap --ro-bind / / --unshare-all true']) === 0;
    if (wsl && wslBwrap) return { driver: 'wsl', isolated: true, label: ISOLATION_LABELS.wsl, found: { docker, dockerImage, wsl, wslBwrap } };
    return { driver: 'copy', isolated: false, label: ISOLATION_LABELS.copy, found: { docker, dockerImage, wsl, wslBwrap } };
  }
  return { driver: 'copy', isolated: false, label: ISOLATION_LABELS.copy };
}

/** C:\a\b → /mnt/c/a/b (WSL's view of a Windows path). */
export function wslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) throw new Error(`Not a Windows drive path: ${p}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The docker command a try runs (through the Windows shell runner). Pure, for tests. */
export function dockerCommand(copyDir: string, command: string, opts: { image: string; network: boolean; deps?: { src: string; rel: string }[] }): string {
  return [
    'docker', 'run', '--rm', '-i=false',
    ...(opts.network ? [] : ['--network', 'none']),
    '--memory', '2g', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'HOME=/workspace', '-w', '/workspace',
    '-v', `${copyDir}:/workspace`,
    ...(opts.deps ?? []).flatMap((d) => ['-v', `${d.src}:/workspace/${d.rel}:ro`]),
    opts.image, '/bin/sh', '-c', command,
  ].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shq(a))).join(' ');
}

/** The WSL command a try runs: bubblewrap inside WSL2 with only the copy writable. Pure, for tests. */
export function wslCommand(copyDir: string, command: string, opts: { network: boolean; deps?: { src: string; rel: string }[] }): string {
  const ws = wslPath(copyDir);
  const args = [
    wslExe().replace(/\\/g, '/'), '-e', 'bwrap',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--ro-bind', '/etc', '/etc',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', ws, '/workspace', '--chdir', '/workspace',
    ...(opts.deps ?? []).flatMap((d) => ['--ro-bind', wslPath(d.src), `/workspace/${d.rel}`]),
    '--unshare-all', ...(opts.network ? ['--share-net'] : []), '--die-with-parent', '--new-session',
    '--setenv', 'HOME', '/workspace',
    '/bin/sh', '-c', command,
  ];
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shq(a))).join(' ');
}

// ------------------------------------------------------------------------------------------------
// 4. The copy
// ------------------------------------------------------------------------------------------------

/** Regenerable dependency and cache folders: never copied (bound read-only where the OS can). */
export const SANDBOX_HEAVY = new Set([...SNAPSHOT_SKIP, 'bower_components', '.pnpm-store', '.yarn', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.turbo', '.parcel-cache', '.terraform', '.dart_tool', 'Pods', '.angular']);
/** Sara's own files at the workspace top (src/tools/sandbox.ts excludeOwnFiles): not part of a diff. */
const OWN_FILES = /^(\.gitconfig|\.sara-task-[^/]*|\.npm\/.*|npm-cache\/.*|\.cache\/.*|\.local\/.*|\.pnpm-store\/.*|\.bash_history|\.node_repl_history|\.python_history|\.lesshst|\.wget-hsts|\.sara-canary-[^/]*|\.sara-ps)$/;
const MAX_FILES = 50_000;

export class SandboxTooBig extends Error {}

/** A small .gitignore reader: nested files, negation, anchoring, `**`, directory-only patterns. */
export class GitIgnore {
  readonly #rules: { base: string; re: RegExp; neg: boolean; dirOnly: boolean }[] = [];

  /** Adds the patterns of one ignore file (`base` = its folder, relative to the root, '' at the top). */
  add(base: string, text: string): void {
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      let neg = false;
      if (line.startsWith('!')) {
        neg = true;
        line = line.slice(1);
      }
      line = line.replace(/^\\([#!])/, '$1');
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      if (!line) continue;
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      let re = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '*') {
          if (line[i + 1] === '*') {
            const atStart = i === 0 || line[i - 1] === '/';
            const atEnd = i + 2 === line.length || line[i + 2] === '/';
            if (atStart && atEnd) {
              if (i + 2 === line.length) re += '.*';
              else {
                re += '(?:.*/)?';
                i++;
              }
              i++;
              continue;
            }
          }
          re += '[^/]*';
        } else if (ch === '?') re += '[^/]';
        else if (ch === '[') {
          const end = line.indexOf(']', i + 1);
          if (end > i) {
            re += `[${line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
            i = end;
          } else re += '\\[';
        } else if (ch === '\\' && i + 1 < line.length) re += line[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      }
      const full = anchored ? `^${re}$` : `(?:^|/)${re}$`;
      this.#rules.push({ base, re: new RegExp(full), neg, dirOnly });
    }
  }

  /** Is this path (relative to the root, `/`-separated) ignored? */
  ignored(rel: string, isDir: boolean): boolean {
    let out = false;
    for (const r of this.#rules) {
      if (r.base && !rel.startsWith(`${r.base}/`)) continue;
      if (r.dirOnly && !isDir) continue;
      const sub = r.base ? rel.slice(r.base.length + 1) : rel;
      if (r.re.test(sub)) out = !r.neg;
    }
    return out;
  }
}

interface FileStat {
  size: number;
  mtimeMs: number;
}
interface FileHash {
  size: number;
  sha: string;
  mode: number;
}

const toRel = (root: string, abs: string) => relative(root, abs).split(sep).join('/');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** sha256 + size + mode of every regular file under `root` (dependency folders and `.git` left out). */
function hashTree(root: string, skipGit = true): Map<string, FileHash> {
  const out = new Map<string, FileHash>();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SANDBOX_HEAVY.has(e.name)) continue;
        if (skipGit && e.name === '.git' && dir === root) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(abs);
        out.set(toRel(root, abs), { size: st.size, sha: sha256(readFileSync(abs)), mode: st.mode & 0o777 });
      } catch {
        /* vanished */
      }
    }
  };
  walk(root);
  return out;
}

/** Size + modified time of every file (cheap): the watch on the real workspace. */
function statTree(root: string, opts: { gitMeta?: boolean } = {}): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SANDBOX_HEAVY.has(e.name)) continue;
        if (e.name === '.git' && dir === root) {
          if (opts.gitMeta) walkGit(abs);
          continue;
        }
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(abs);
        out.set(toRel(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  };
  // The parts of a repository a command could use to run code later or move branches: HEAD,
  // config, packed refs, refs/ and hooks/ (never objects, the index or the worktree admin folders).
  const walkGit = (gitDir: string) => {
    const take = (abs: string) => {
      try {
        const st = statSync(abs);
        if (st.isFile()) out.set(toRel(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
        else if (st.isDirectory()) for (const n of readdirSync(abs)) take(join(abs, n));
      } catch {
        /* missing */
      }
    };
    for (const n of ['HEAD', 'config', 'packed-refs', 'refs', 'hooks', 'info']) take(join(gitDir, n));
  };
  walk(root, 0);
  return out;
}

/** Names (and kinds) directly inside a folder: for the outside watch (new entries only). */
function listing(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

function realGitDir(ws: string): string | undefined {
  try {
    return lstatSync(join(ws, '.git')).isDirectory() ? join(ws, '.git') : undefined;
  } catch {
    return undefined;
  }
}

const GIT_RUN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'core.untrackedCache=false', '-c', 'protocol.ext.allow=never'];

function gitSync(cwd: string, args: string[], timeout = 60_000): { status: number | null; out: string } {
  const r = spawnSync('git', [...GIT_RUN, ...args], { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.error ? null : r.status, out: String(r.stdout ?? '') };
}

export type CopyStrategy = 'worktree' | 'copy';

export interface CopyInfo {
  strategy: CopyStrategy;
  /** Files in the copy (without dependency folders). */
  files: number;
  bytes: number;
  ms: number;
  /** Dependency folders of the real workspace (bound read-only where possible; else missing in the copy). */
  heavy: string[];
  /** Why the worktree wasn't used (no repository, no commit yet, too many changes…). */
  note?: string;
  /** Symbolic links left out. */
  links: number;
}

const MAX_DIRTY_FOR_WORKTREE = 500;

/**
 * Makes the throwaway copy at `dest`: a detached `git worktree` at HEAD plus the uncommitted and
 * new (not ignored) files when the workspace is a repository with a commit and not too many
 * changes; otherwise a filtered copy honouring .gitignore. Dependency folders are never copied.
 * Files are cloned (reflink) where the file system can, else copied; never hard-linked (a command
 * writing in place would change the original).
 */
export function makeCopy(ws: string, dest: string, opts: { maxBytes: number; preferWorktree?: boolean }): CopyInfo {
  const t0 = Date.now();
  const heavy = readdirSync(ws, { withFileTypes: true }).filter((e) => e.isDirectory() && SANDBOX_HEAVY.has(e.name)).map((e) => e.name);
  let note: string | undefined;
  if (opts.preferWorktree !== false && realGitDir(ws)) {
    const head = gitSync(ws, ['rev-parse', '--verify', '-q', 'HEAD']);
    const top = gitSync(ws, ['rev-parse', '--show-toplevel']);
    const sameTop = top.status === 0 && resolve(top.out.trim()).toLowerCase() === resolve(ws).toLowerCase();
    if (head.status !== 0) note = 'no commit yet';
    else if (!sameTop) note = 'workspace is inside another repository';
    else {
      const st = gitSync(ws, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const parts = st.out.split('\0');
      const dirty: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.length < 4) continue;
        dirty.push(p.slice(3));
        if (p[0] === 'R' || p[0] === 'C') i++;
      }
      if (st.status !== 0) note = 'git status failed';
      else if (dirty.length > MAX_DIRTY_FOR_WORKTREE) note = `${dirty.length} uncommitted files`;
      else {
        // A detached worktree WITHOUT a checkout, filled with the real files byte for byte (tracked
        // and new, not ignored), then its index set to HEAD and refreshed: git in the copy sees what
        // the real workspace shows, whatever the line-ending settings of a fresh checkout would be.
        const add = gitSync(ws, ['worktree', 'add', '--no-checkout', '--detach', '--force', dest, 'HEAD'], 120_000);
        if (add.status === 0 && existsSync(dest)) {
          const listed = gitSync(ws, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
          let files = 0;
          let bytes = 0;
          let links = 0;
          for (const rel of new Set(listed.out.split('\0').filter(Boolean))) {
            if (rel.split('/').some((x) => SANDBOX_HEAVY.has(x))) continue;
            const src = join(ws, ...rel.split('/'));
            let st2;
            try {
              st2 = lstatSync(src);
            } catch {
              continue; // deleted in the real tree
            }
            if (st2.isSymbolicLink()) {
              links++;
              continue;
            }
            if (!st2.isFile()) continue;
            if (++files > MAX_FILES) throw new SandboxTooBig(`The workspace has more than ${MAX_FILES} files.`);
            bytes += st2.size;
            if (bytes > opts.maxBytes) throw new SandboxTooBig(`The workspace is larger than ${Math.round(opts.maxBytes / 1048576)} MB (without dependency folders and ignored files).`);
            const dst = join(dest, ...rel.split('/'));
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst, constants.COPYFILE_FICLONE);
          }
          gitSync(dest, ['read-tree', 'HEAD'], 60_000);
          gitSync(dest, ['update-index', '-q', '--refresh'], 120_000);
          return { strategy: 'worktree', files, bytes, ms: Date.now() - t0, heavy, links };
        }
        note = 'git worktree failed';
        removeWorktree(ws, dest);
      }
    }
  }
  // The filtered copy: .gitignore'd files and dependency folders stay behind; .git is not copied.
  const ig = new GitIgnore();
  try {
    ig.add('', readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8'));
  } catch {
    /* none */
  }
  let files = 0;
  let bytes = 0;
  let links = 0;
  mkdirSync(dest, { recursive: true });
  const walk = (dir: string) => {
    const relDir = toRel(ws, dir);
    try {
      const gi = join(dir, '.gitignore');
      if (existsSync(gi) && lstatSync(gi).isFile()) ig.add(relDir, readFileSync(gi, 'utf8'));
    } catch {
      /* unreadable */
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        links++;
        continue;
      }
      if (e.isDirectory()) {
        if (SANDBOX_HEAVY.has(e.name) || (e.name === '.git' && !relDir) || ig.ignored(rel, true)) continue;
        mkdirSync(join(dest, ...rel.split('/')), { recursive: true });
        walk(abs);
        continue;
      }
      if (!e.isFile() || ig.ignored(rel, false)) continue;
      if (++files > MAX_FILES) throw new SandboxTooBig(`The workspace has more than ${MAX_FILES} files.`);
      const size = statSync(abs).size;
      bytes += size;
      if (bytes > opts.maxBytes) throw new SandboxTooBig(`The workspace is larger than ${Math.round(opts.maxBytes / 1048576)} MB (without dependency folders and ignored files).`);
      copyFileSync(abs, join(dest, ...rel.split('/')), constants.COPYFILE_FICLONE);
    }
  };
  walk(ws);
  return { strategy: 'copy', files, bytes, ms: Date.now() - t0, heavy, links, ...(note ? { note } : {}) };
}

function removeWorktree(ws: string, dest: string): void {
  try {
    gitSync(ws, ['worktree', 'remove', '--force', dest], 60_000);
  } catch {
    /* removed below */
  }
  try {
    rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a program still holds a file (Windows) */
  }
  try {
    gitSync(ws, ['worktree', 'prune'], 30_000);
  } catch {
    /* fine */
  }
}

// ------------------------------------------------------------------------------------------------
// 5. Findings (the §2.5 shape; M6 makes them a table)
// ------------------------------------------------------------------------------------------------

export type SandboxRule = 'write-outside' | 'outside-blocked' | 'mass-delete' | 'git-hooks' | 'home-files' | 'executable' | 'network' | 'process-left' | 'timeout' | 'long-runtime' | 'not-isolated' | 'deps-missing' | 'too-big';
export type Severity = 'block' | 'high' | 'medium' | 'low' | 'info';

/** One thing the try showed. `quote` (when set) is a real line of the command's output, checked by code. */
export interface SandboxFinding {
  source: 'sandbox';
  severity: Severity;
  rule: SandboxRule;
  title: string;
  advice: string;
  /** Paths (relative to the workspace, or absolute when outside it). */
  files?: string[];
  quote?: string;
  /** How many (files deleted, processes stopped…). */
  count?: number;
  status: 'open' | 'applied' | 'discarded' | 'ran';
}

const SEV_RANK: Record<Severity, number> = { block: 4, high: 3, medium: 2, low: 1, info: 0 };

/** The "no theater" rule (§2.5): a finding that quotes output must quote a line that is really there. */
export function checkedFindings(list: SandboxFinding[], output: string): SandboxFinding[] {
  return list.filter((f) => !f.quote || output.split(/\r?\n/).some((l) => l.includes(f.quote!)));
}

// ------------------------------------------------------------------------------------------------
// 6. Running a try
// ------------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  size?: number;
}
export interface SandboxChanges {
  added: FileChange[];
  changed: FileChange[];
  removed: FileChange[];
}

export interface SandboxResult {
  id: string;
  command: string;
  workspaceDir: string;
  isolation: Isolation;
  network: boolean;
  copy: CopyInfo | null;
  /** The copy could not be made (too big): nothing ran. */
  notRun?: string;
  run: RunResult | null;
  changes: SandboxChanges;
  findings: SandboxFinding[];
  /** clean = nothing above "low"; flagged = something to look at. */
  verdict: 'clean' | 'flagged';
  ms: number;
  /** The copy, kept until Apply / Discard (deleted then). */
  copyDir?: string;
  /** The real workspace's file stats when the copy was made (Apply's conflict check). */
  readonly realAtStart?: Map<string, FileStat>;
  readonly copyAtStart?: Map<string, FileHash>;
}

export interface SandboxRunOptions {
  /** Where copies live: `<data>/cache/sandbox-runs`. */
  cacheDir: string;
  /** The shell sandbox found at startup (src/tools/sandbox.ts). */
  base: SandboxInfo;
  isolation: Isolation;
  network?: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  maxBytes?: number;
  /** Keep the copy for Apply (the gate). M6/M7/M11 runs leave it false: the copy goes at once. */
  keep?: boolean;
  gitName?: string;
  dockerImage?: string;
  /** Extra folders a red-team / eval run wants to watch for writes (absolute). */
  watch?: string[];
  /** Prefer a git worktree when the workspace is a repository (default true). */
  preferWorktree?: boolean;
  /**
   * Phase 86 (M11): files written into the COPY before the command runs (relative paths, inside the
   * copy only; never into the real workspace). Red-team mode puts its probe driver and plan here.
   * They are part of the "before" state, so they never show up as changes.
   */
  inject?: Record<string, string>;
}

const LEFT_MARK = '[sara-sandbox-left:';
const PIDS_MARK = '[sara-sandbox-pids:';
const SHELL_MARK = '[sara-sandbox-shell:';

/** Lines that show a write outside the copy was refused by the sandbox (EROFS / EACCES / EPERM). */
const BLOCKED_WRITE = /(Read-only file system|EROFS|Operation not permitted|EPERM|Permission denied|EACCES)/;
const NET_ATTEMPT = /(Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|Temporary failure in name resolution|Network is unreachable|ENETUNREACH|Name or service not known|Failed to establish a new connection|127\.0\.0\.1:9\b|connect ECONNREFUSED|Connection refused|unable to access 'https?:|nodename nor servname)/i;
const DOTFILES = /^(\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.zshenv|\.npmrc|\.yarnrc|\.pypirc|\.netrc|\.gitconfig|\.ssh\/.+|\.config\/.+|\.gnupg\/.+|\.aws\/.+|\.docker\/.+|\.kube\/.+)$/;
const EXEC_EXT = /\.(exe|bat|cmd|ps1|com|scr|msi|sh|bash|command|app)$/i;

/**
 * Runs `command` in a throwaway copy of `workspaceDir` and reports what it did. Never touches the
 * real workspace (on the copy-only driver it watches it and reports any change). The copy is
 * deleted at the end unless `keep` (the gate keeps it for Apply/Discard).
 */
export async function runInSandbox(workspaceDir: string, command: string, opts: SandboxRunOptions): Promise<SandboxResult> {
  const t0 = Date.now();
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(opts.cacheDir, id);
  const copyDir = join(runDir, 'ws');
  const network = opts.network ?? false;
  const iso = opts.isolation;
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const base: Omit<SandboxResult, 'copy' | 'run' | 'changes' | 'findings' | 'verdict' | 'ms'> = { id, command, workspaceDir, isolation: iso, network };
  const empty: SandboxChanges = { added: [], changed: [], removed: [] };
  // The watch on the real workspace starts BEFORE the copy (a command can't hide in the gap).
  const realBefore = statTree(workspaceDir, { gitMeta: true });
  let copy: CopyInfo;
  try {
    copy = makeCopy(workspaceDir, copyDir, { maxBytes: opts.maxBytes ?? DEFAULT_SANDBOX_GATE.maxMB * 1048576, ...(opts.preferWorktree === false ? { preferWorktree: false } : {}) });
  } catch (err) {
    cleanupRun(workspaceDir, runDir, copyDir);
    const msg = err instanceof SandboxTooBig ? err.message : `The copy could not be made: ${(err as Error).message}`;
    const f: SandboxFinding = { source: 'sandbox', severity: 'medium', rule: 'too-big', title: 'Too big for a sandbox try', advice: `${msg} Run it for real only if you trust it, or raise the size limit in Settings.`, status: 'open' };
    return { ...base, copy: null, notRun: msg, run: null, changes: empty, findings: [f], verdict: 'flagged', ms: Date.now() - t0 };
  }
  // Phase 86: injected files (the red-team driver) go into the copy only, through the same path guard.
  for (const [rel, text] of Object.entries(opts.inject ?? {})) {
    const dest = resolveInside(copyDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  // The deps: bound read-only where the OS can (bubblewrap, Docker, WSL), linked read-only for the
  // macOS sandbox (it refuses writes through the link), missing in the copy-only mode.
  const heavyDeps = copy.heavy.map((rel) => ({ src: join(workspaceDir, rel), rel }));
  const binds: Bind[] = [];
  if (iso.driver === 'bwrap') {
    for (const d of heavyDeps) binds.push({ src: d.src, dest: `/workspace/${d.rel}` });
    // The worktree's `.git` file points into the real repository: readable, never writable.
    const gitDir = realGitDir(workspaceDir);
    if (copy.strategy === 'worktree' && gitDir) binds.push({ src: gitDir, dest: gitDir });
  }
  const seatbeltLinks: string[] = [];
  if (iso.driver === 'seatbelt') {
    const gitDir = realGitDir(workspaceDir);
    if (copy.strategy === 'worktree' && gitDir) binds.push({ src: gitDir, dest: gitDir });
    for (const d of heavyDeps) {
      try {
        // A symbolic link to the real folder; the profile below only lets the command read it.
        const link = join(copyDir, d.rel);
        rmSync(link, { recursive: true, force: true });
        symlinkSync(d.src, link, 'dir');
        seatbeltLinks.push(d.rel);
        binds.push({ src: d.src, dest: d.src });
      } catch {
        /* the folder stays missing */
      }
    }
  }
  // The canary: a file beside the copy that nothing should touch.
  const canary = join(runDir, `.sara-canary-${id}`);
  const canaryText = `sara sandbox canary ${randomUUID()}\n`;
  writeFileSync(canary, canaryText);
  const watched = [...new Set([runDir, dirname(workspaceDir), ...(opts.watch ?? [])])];
  const listBefore = new Map(watched.map((d) => [d, listing(d)]));
  const homeBefore = iso.isolated ? undefined : listing(homedir());
  const copyBefore = hashTree(copyDir);
  // Run it.
  let cmd = command;
  // Processes left running are counted INSIDE the try, after the command: bubblewrap lists its own
  // process space; Git Bash on Windows lists the shell's process group (Windows keeps no usable
  // parent links once a shell has forked, so the system's process tree can't be followed).
  if (iso.driver === 'bwrap') cmd = `( ${command}\n); __sara_s=$?; __sara_n=0; for __p in /proc/[0-9]*; do __p=\${__p#/proc/}; [ "$__p" = 1 ] || [ "$__p" = "$$" ] || __sara_n=$((__sara_n+1)); done; echo "${LEFT_MARK} $__sara_n]"; exit $__sara_s`;
  const winProbe = iso.driver === 'copy' && process.platform === 'win32' && opts.base.mode === 'none' && windowsShell().sh;
  if (winProbe) cmd = `echo "${SHELL_MARK} $$]"; ( ${command}\n); __sara_s=$?; ps > .sara-ps 2>/dev/null; __sara_w=$(awk -v g=$$ 'NR>1 && $3==g && $1!=g && $8 != "/usr/bin/ps" {printf "%s ", $4}' .sara-ps 2>/dev/null); rm -f .sara-ps; echo "${PIDS_MARK} $__sara_w]"; exit $__sara_s`;
  let pid: number | undefined;
  const runOpts = { timeoutMs: opts.timeoutMs, signal: opts.signal, maxBytes: 200_000, onSpawn: (p: number) => (pid = p), ...(opts.gitName ? { gitName: opts.gitName } : {}) };
  const started = Date.now();
  let run: RunResult;
  if (iso.driver === 'bwrap' || iso.driver === 'seatbelt') {
    run = await runCommand(cmd, copyDir, { ...opts.base, network }, { ...runOpts, binds });
  } else if (iso.driver === 'docker') {
    run = await runCommand(dockerCommand(copyDir, command, { image: opts.dockerImage ?? DEFAULT_SANDBOX_GATE.dockerImage, network, deps: heavyDeps }), copyDir, { mode: 'none', network: true, detail: 'docker' }, runOpts);
  } else if (iso.driver === 'wsl') {
    run = await runCommand(wslCommand(copyDir, command, { network, deps: heavyDeps }), copyDir, { mode: 'none', network: true, detail: 'wsl' }, runOpts);
  } else {
    // Copy only: no OS boundary. Programs that honour proxy settings can't reach the network. In a
    // container ('user' mode) it still runs as the separate tools user.
    const mode: SandboxInfo = opts.base.mode === 'user' ? { ...opts.base, network } : { mode: 'none', network, detail: 'sandbox copy' };
    run = await runCommand(cmd, copyDir, mode, { ...runOpts, ...(network ? {} : { env: { ...PRIVATE_LOCAL_ENV } }) });
  }
  // Processes left running: bubblewrap counts them inside its own process space (and they end with
  // it); elsewhere the command's process group / process tree is checked and stopped.
  let left = 0;
  const mark = run.output.lastIndexOf(LEFT_MARK);
  if (mark >= 0) {
    left = Number(/\[sara-sandbox-left: (\d+)\]/.exec(run.output.slice(mark))?.[1] ?? 0);
    run = { ...run, output: (run.output.slice(0, mark) + run.output.slice(mark).replace(/\[sara-sandbox-left: \d+\]\n?/, '')).trimEnd() };
  }
  const pmark = run.output.lastIndexOf(PIDS_MARK);
  if (pmark >= 0) {
    const pids = (/\[sara-sandbox-pids:([\d ]*)\]/.exec(run.output.slice(pmark))?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    // The list is read from the command's own output, which the command could fake: only processes
    // that were started after the try began are ever stopped (never one that was already running).
    const born = await bornSince(pids, started);
    for (const p of born) spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    left += born.length;
    run = { ...run, output: (run.output.slice(0, pmark) + run.output.slice(pmark).replace(/\[sara-sandbox-pids:[\d ]*\]\n?/, '')).trimEnd() };
  } else if (winProbe) {
    // Stopped before the count (time limit, Stop): what is left of the shell's process group goes.
    const msys = Number(/\[sara-sandbox-shell: (\d+)\]/.exec(run.output)?.[1]);
    if (msys > 0) left += await stopMsysGroup(msys, started);
  } else if (pid && iso.driver !== 'bwrap') left += await stopLeftovers(pid, started);
  run = { ...run, output: run.output.replace(/\[sara-sandbox-shell: \d+\]\r?\n?/, '') };
  run = { ...run, output: run.output.replace(/\n?\[a program it started is still running in the background\]/, '') };
  // Observe.
  const copyAfter = hashTree(copyDir, false);
  const changes = diffTrees(copyBefore, copyAfter);
  const findings: SandboxFinding[] = [];
  if (!iso.isolated) findings.push({ source: 'sandbox', severity: 'info', rule: 'not-isolated', title: 'Not isolated on this computer', advice: 'It ran in a copy without an OS sandbox: it could still reach other files. The real workspace and the folders around the copy were watched.', status: 'open' });
  // Writes outside the copy: the real workspace, the canary, the folders around it.
  const realAfter = statTree(workspaceDir, { gitMeta: true });
  const outside: string[] = [];
  for (const [rel, a] of realAfter) {
    const b = realBefore.get(rel);
    if (!b || b.size !== a.size || b.mtimeMs !== a.mtimeMs) outside.push(rel);
  }
  for (const rel of realBefore.keys()) if (!realAfter.has(rel)) outside.push(rel);
  let canaryHit = false;
  try {
    canaryHit = readFileSync(canary, 'utf8') !== canaryText;
  } catch {
    canaryHit = true;
  }
  if (canaryHit) outside.push(canary);
  for (const d of watched) {
    const now = listing(d);
    for (const n of now) if (!listBefore.get(d)!.has(n) && !(d === runDir && n === 'ws')) outside.push(join(d, n));
    for (const n of listBefore.get(d)!) if (!now.has(n)) outside.push(join(d, n));
  }
  if (homeBefore) for (const n of listing(homedir())) if (!homeBefore.has(n)) outside.push(join(homedir(), n));
  const realOutside = outside.filter((p) => !/^\.git\/(worktrees|index|logs|objects|FETCH_HEAD|ORIG_HEAD)/.test(p));
  if (realOutside.length) findings.push({ source: 'sandbox', severity: 'high', rule: 'write-outside', title: 'Changed files outside the copy', advice: iso.isolated ? 'Something outside the copy changed while it ran. Check these files.' : 'This command changed files outside its copy (no OS sandbox here to stop it). Check these files before you go on.', files: realOutside.slice(0, 30), count: realOutside.length, status: 'open' });
  if (iso.isolated) {
    const gitDir = realGitDir(workspaceDir);
    const line = run.output.split(/\r?\n/).find((l) => BLOCKED_WRITE.test(l) && /(\/(?!workspace\b)[\w.-]+|[A-Za-z]:\\)/.test(l) && !/index\.lock/.test(l) && !(gitDir && l.includes(gitDir)));
    if (line) findings.push({ source: 'sandbox', severity: 'medium', rule: 'outside-blocked', title: 'Tried to write outside the copy (blocked)', advice: 'The sandbox stopped a write outside the copy. A real run would try that on your computer.', quote: line.trim().slice(0, 300), status: 'open' });
  }
  const total = copyBefore.size;
  if (changes.removed.length >= 20 || (changes.removed.length >= 5 && changes.removed.length >= total / 2)) findings.push({ source: 'sandbox', severity: 'high', rule: 'mass-delete', title: 'Deleted many files', advice: `It deleted ${changes.removed.length} of ${total} files in the copy. Applying it deletes them in your workspace.`, files: changes.removed.slice(0, 30).map((c) => c.path), count: changes.removed.length, status: 'open' });
  const touched = [...changes.added, ...changes.changed].map((c) => c.path);
  const hooks = touched.filter((p) => /^\.git\/(hooks\/|config$)|^\.husky\//.test(p));
  if (hooks.length) findings.push({ source: 'sandbox', severity: 'high', rule: 'git-hooks', title: 'Wrote git hooks or git settings', advice: 'Hooks run by themselves on the next commit or checkout. They are never applied to your workspace.', files: hooks, status: 'open' });
  const dots = touched.filter((p) => DOTFILES.test(p));
  if (dots.length) findings.push({ source: 'sandbox', severity: 'medium', rule: 'home-files', title: 'Wrote shell or tool settings files', advice: 'Files like .bashrc or .npmrc change how later commands behave. Look at them before applying.', files: dots, status: 'open' });
  const execs = changes.added.filter((c) => EXEC_EXT.test(c.path) || ((copyAfter.get(c.path)?.mode ?? 0) & 0o111 && process.platform !== 'win32')).map((c) => c.path);
  if (execs.length) findings.push({ source: 'sandbox', severity: 'low', rule: 'executable', title: 'Created programs or scripts', advice: 'New runnable files. Fine for a build; odd for a test run.', files: execs.slice(0, 30), status: 'open' });
  const netLine = run.output.split(/\r?\n/).find((l) => NET_ATTEMPT.test(l));
  if (netLine) findings.push({ source: 'sandbox', severity: network ? 'low' : 'medium', rule: 'network', title: network ? 'Used the network' : 'Tried to reach the network (blocked)', advice: network ? 'The try had network access.' : 'It needed the network and had none in the sandbox. Allow network for tries in Settings, or run it for real.', quote: netLine.trim().slice(0, 300), status: 'open' });
  if (left > 0) findings.push({ source: 'sandbox', severity: 'high', rule: 'process-left', title: 'Left programs running (stopped)', advice: 'It started programs that kept running after it finished. They were stopped; a real run would leave them going.', count: left, status: 'open' });
  if (run.timedOut) findings.push({ source: 'sandbox', severity: 'medium', rule: 'timeout', title: 'Ran out of time (stopped)', advice: `It ran past the ${Math.round(opts.timeoutMs / 1000)} s limit for tries and was stopped.`, status: 'open' });
  else if (run.ms > 60_000) findings.push({ source: 'sandbox', severity: 'low', rule: 'long-runtime', title: 'Took a long time', advice: `It ran for ${Math.round(run.ms / 1000)} s.`, status: 'open' });
  if (iso.driver === 'copy' && copy.heavy.length) findings.push({ source: 'sandbox', severity: 'info', rule: 'deps-missing', title: 'Dependency folders not copied', advice: `${copy.heavy.join(', ')} stayed out of the copy (too big to copy safely), so commands that need them may fail here.`, files: copy.heavy, status: 'open' });
  for (const rel of seatbeltLinks) rmSync(join(copyDir, rel), { force: true });
  const checked = checkedFindings(findings, run.output);
  const result: SandboxResult = {
    ...base,
    copy,
    run,
    changes,
    findings: checked,
    verdict: checked.some((f) => SEV_RANK[f.severity] >= SEV_RANK.medium) ? 'flagged' : 'clean',
    ms: Date.now() - t0,
    ...(opts.keep ? { copyDir } : {}),
  };
  Object.defineProperty(result, 'realAtStart', { value: realBefore, enumerable: false });
  Object.defineProperty(result, 'copyAtStart', { value: copyBefore, enumerable: false });
  if (!opts.keep) cleanupRun(workspaceDir, runDir, copyDir);
  return result;
}

function diffTrees(a: Map<string, FileHash>, b: Map<string, FileHash>): SandboxChanges {
  const added: FileChange[] = [];
  const changed: FileChange[] = [];
  const removed: FileChange[] = [];
  // Inside .git only hooks and the settings file matter (`git init` makes the rest; never applied).
  const skip = (p: string) => OWN_FILES.test(p) || (p.startsWith('.git/') && !/^\.git\/(hooks\/(?!.*\.sample$)|config$)/.test(p));
  for (const [p, h] of b) {
    if (skip(p)) continue;
    const o = a.get(p);
    if (!o) added.push({ path: p, size: h.size });
    else if (o.sha !== h.sha) changed.push({ path: p, size: h.size });
  }
  for (const [p, h] of a) if (!b.has(p) && !skip(p)) removed.push({ path: p, size: h.size });
  const by = (x: FileChange, y: FileChange) => (x.path < y.path ? -1 : 1);
  return { added: added.sort(by), changed: changed.sort(by), removed: removed.sort(by) };
}

/**
 * Stops whatever the try left running. POSIX: the command's own process group. Windows: the
 * processes descended from the command's shell that started after the try did (read from the
 * system process list), and nothing else.
 */
async function stopLeftovers(rootPid: number, since: number): Promise<number> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-rootPid, 0);
    } catch {
      return 0;
    }
    try {
      process.kill(-rootPid, 'SIGKILL');
    } catch {
      /* gone meanwhile */
    }
    return 1;
  }
  const pids = await windowsDescendants(rootPid, since);
  for (const p of pids) spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  return pids.length;
}

/** Windows (Git Bash): stops every process of an MSYS process group (by its Windows process id). */
async function stopMsysGroup(pgid: number, since: number): Promise<number> {
  const sh = windowsShell();
  if (!sh.sh) return 0;
  const out = String(spawnSync(sh.file, ['-c', 'ps'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }).stdout ?? '');
  const wins = out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => Number(c[2]) === pgid && Number(c[0]) !== pgid && Number(c[3]) > 0)
    .map((c) => Number(c[3]))
    .filter((n) => n !== process.pid);
  const born = await bornSince(wins, since);
  for (const w of born) spawnSync('taskkill', ['/PID', String(w), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  return born.length;
}

/**
 * Windows: of `pids`, only those whose process was created after `since` (with a second of slack).
 * A process that was already running when the try started is never stopped, whatever the try's
 * output claims, and neither is Sara herself or anything that started her. An unreadable process
 * list stops nothing.
 */
export async function bornSince(pids: number[], since: number): Promise<number[]> {
  if (!pids.length) return [];
  const want = new Set(pids.filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid && p !== process.ppid));
  if (!want.size) return [];
  const script = "Get-CimInstance Win32_Process -Property ProcessId,CreationDate | ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const out = await new Promise<string>((res) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    ps.stdout.on('data', (d: Buffer) => (text += d.toString('utf8')));
    const timer = setTimeout(() => ps.kill(), 20_000);
    ps.on('close', () => {
      clearTimeout(timer);
      res(text);
    });
    ps.on('error', () => res(''));
  });
  const born: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [p, at] = line.trim().split(/\s+/).map(Number);
    if (want.has(p) && Number.isFinite(at) && at + 1000 >= since) born.push(p);
  }
  return born;
}

/** Windows: processes under `rootPid` (by parent id, even after the parent ended) created since `since`. */
export async function windowsDescendants(rootPid: number, since: number): Promise<number[]> {
  const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await new Promise<string>((res) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      ps.stdout.on('data', (d: Buffer) => (s += d.toString('utf8')));
      const timer = setTimeout(() => ps.kill(), 20_000);
      ps.on('close', () => {
        clearTimeout(timer);
        res(s);
      });
      ps.on('error', () => res(''));
    });
    const rows = out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite));
    // A cut list (WMI under load) misses our own process: ask again.
    if (!rows.some((r) => r[0] === process.pid)) continue;
    const kids = new Map<number, { pid: number; at: number }[]>();
    for (const [p, pp, at] of rows) kids.set(pp, [...(kids.get(pp) ?? []), { pid: p, at }]);
    const found: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const k of kids.get(cur) ?? []) {
        // Process ids are reused on Windows: only children born after the try started count.
        if (k.at + 1000 < since || k.pid === process.pid) continue;
        found.push(k.pid);
        queue.push(k.pid);
      }
    }
    return found.filter((p) => p !== rootPid);
  }
  return [];
}

/** Deletes a try's folder (and the worktree registration, when the copy was a worktree). */
function cleanupRun(ws: string, runDir: string, copyDir: string): void {
  try {
    if (existsSync(join(copyDir, '.git')) && lstatSync(join(copyDir, '.git')).isFile()) removeWorktree(ws, copyDir);
  } catch {
    /* not a worktree */
  }
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows: a file still held; the startup sweep removes it */
  }
}

/** Throws the copy away (Discard, Run for real, or a cancelled turn). Idempotent. */
export function discardSandbox(r: SandboxResult): void {
  if (!r.copyDir) return;
  cleanupRun(r.workspaceDir, dirname(r.copyDir), r.copyDir);
  r.copyDir = undefined;
}

/** Startup: copies left by a crash or a restart mid-try go (and their worktree registrations). */
export function sweepSandboxRuns(cacheDir: string, workspaces: string[] = []): number {
  if (!existsSync(cacheDir)) return 0;
  let n = 0;
  for (const name of readdirSync(cacheDir)) {
    rmSync(join(cacheDir, name), { recursive: true, force: true, maxRetries: 3 });
    n++;
  }
  for (const ws of workspaces) if (realGitDir(ws)) gitSync(ws, ['worktree', 'prune'], 30_000);
  return n;
}

// ------------------------------------------------------------------------------------------------
// 7. Apply (only the diff goes back)
// ------------------------------------------------------------------------------------------------

export interface ApplyResult {
  written: string[];
  removed: string[];
  /** Files changed in the real workspace since the try started: left alone. */
  conflicts: string[];
  /** Never applied (git internals, hooks, dependency folders, links in the way). */
  refused: string[];
  /** M3 light manifests: HEAD + dirty files before and after the apply. */
  refBefore?: WorkspaceRef;
  refAfter?: WorkspaceRef;
}

/** Folders on the way to a file are real folders inside the workspace (never a link). */
function safeTarget(ws: string, rel: string): string | undefined {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return undefined;
  let cur = ws;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    } catch {
      mkdirSync(cur);
    }
  }
  const abs = join(cur, parts.at(-1)!);
  try {
    if (lstatSync(abs).isSymbolicLink()) return undefined;
  } catch {
    /* new file */
  }
  return abs;
}

/**
 * Writes exactly the try's diff into the real workspace: added and changed files are copied from
 * the copy, removed files deleted. A file the owner changed since the try started is left alone
 * (a conflict); git internals, hooks and dependency folders are never written. The copy goes
 * afterwards. Records the M3 workspace manifest before and after.
 */
export async function applySandbox(r: SandboxResult): Promise<ApplyResult> {
  if (!r.copyDir || !existsSync(r.copyDir)) throw new Error('This sandbox try is no longer there to apply.');
  const ws = r.workspaceDir;
  const refBefore = await workspaceRef(ws).catch(() => undefined);
  const out: ApplyResult = { written: [], removed: [], conflicts: [], refused: [] };
  const realNow = statTree(ws);
  const start = r.realAtStart ?? new Map<string, FileStat>();
  const changedSince = (rel: string) => {
    const a = start.get(rel);
    const b = realNow.get(rel);
    if (!a && !b) return false;
    if (!a || !b) return true;
    return a.size !== b.size || a.mtimeMs !== b.mtimeMs;
  };
  const refuse = (p: string) => p === '.git' || p.startsWith('.git/') || p.split('/').some((x) => SANDBOX_HEAVY.has(x)) || /^\.husky\//.test(p);
  for (const c of [...r.changes.added, ...r.changes.changed]) {
    if (refuse(c.path)) {
      out.refused.push(c.path);
      continue;
    }
    if (changedSince(c.path)) {
      out.conflicts.push(c.path);
      continue;
    }
    const target = safeTarget(ws, c.path);
    if (!target) {
      out.refused.push(c.path);
      continue;
    }
    const src = join(r.copyDir, ...c.path.split('/'));
    copyFileSync(src, target);
    out.written.push(c.path);
  }
  for (const c of r.changes.removed) {
    if (refuse(c.path)) {
      out.refused.push(c.path);
      continue;
    }
    if (changedSince(c.path)) {
      out.conflicts.push(c.path);
      continue;
    }
    const target = safeTarget(ws, c.path);
    if (!target) {
      out.refused.push(c.path);
      continue;
    }
    try {
      unlinkSync(target);
      out.removed.push(c.path);
    } catch {
      /* already gone */
    }
  }
  const refAfter = await workspaceRef(ws).catch(() => undefined);
  discardSandbox(r);
  return { ...out, ...(refBefore ? { refBefore } : {}), ...(refAfter ? { refAfter } : {}) };
}

// ------------------------------------------------------------------------------------------------
// 8. The gate (§2.3): when to try, when to ask, what the card and the model see
// ------------------------------------------------------------------------------------------------

/** Tools whose command goes through the gate. */
export const GATED_TOOLS = new Set(['shell']);

export interface GateInput {
  tool: string;
  args: Record<string, unknown>;
  /** A coding conversation or a team helper's run. */
  coding: boolean;
  settings: SandboxGateSettings;
}

/** Should this call be tried in the sandbox first? (Pure; the decision the tests pin.) */
export function shouldTry(i: GateInput): { try: boolean; risk: CommandRisk } {
  const command = String(i.args.command ?? '');
  const risk = classifyCommand(command);
  if (!GATED_TOOLS.has(i.tool) || !i.coding || i.settings.mode === 'off' || !command.trim()) return { try: false, risk };
  if (risk.gitOnly) return { try: false, risk };
  return { try: i.settings.mode === 'every' || risk.risky, risk };
}

/**
 * Before the try: ask first when there's no OS isolation and the tool asks first anyway (on such a
 * computer the copy is not a boundary, so the owner's OK comes before anything runs). With
 * isolation the try runs at once and its card is the approval.
 */
export function asksBeforeTry(isolation: Isolation, permission: 'auto' | 'ask'): boolean {
  return !isolation.isolated && permission === 'ask';
}

/**
 * After the try (§2.3): `allow` = apply by itself (an isolated try, a tool the owner lets run on
 * its own, nothing above "low" found and it didn't fail); `ask` = the Ran-in-a-sandbox card.
 * Without isolation (Windows copy mode) it ALWAYS asks (§7 #1).
 */
export function gateVerdict(r: SandboxResult, permission: 'auto' | 'ask'): { act: 'allow' } | { act: 'ask'; reason: string } {
  if (!r.isolation.isolated) return { act: 'ask', reason: 'not isolated' };
  if (permission === 'ask') return { act: 'ask', reason: 'you asked to be asked' };
  if (r.notRun) return { act: 'ask', reason: 'not tried' };
  if (r.verdict === 'flagged') return { act: 'ask', reason: 'findings' };
  return { act: 'allow' };
}

/** What the card shows (lists capped; the run record keeps the same). */
export interface SandboxCard {
  command: string;
  driver: SandboxDriver;
  isolated: boolean;
  label: string;
  network: boolean;
  ran: boolean;
  notRun?: string;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  strategy?: CopyStrategy;
  copyMs?: number;
  files?: number;
  added: FileChange[];
  changed: FileChange[];
  removed: FileChange[];
  counts: { added: number; changed: number; removed: number };
  findings: SandboxFinding[];
  output: string;
  verdict: 'clean' | 'flagged';
  reasons: RiskReason[];
}

const LIST_CAP = 30;
export function sandboxCard(r: SandboxResult, risk: CommandRisk): SandboxCard {
  const out = r.run?.output ?? '';
  return {
    command: r.command.slice(0, 2000),
    driver: r.isolation.driver,
    isolated: r.isolation.isolated,
    label: r.isolation.label,
    network: r.network,
    ran: Boolean(r.run),
    ...(r.notRun ? { notRun: r.notRun } : {}),
    exitCode: r.run?.exitCode ?? null,
    timedOut: r.run?.timedOut ?? false,
    ms: r.run?.ms ?? 0,
    ...(r.copy ? { strategy: r.copy.strategy, copyMs: r.copy.ms, files: r.copy.files } : {}),
    added: r.changes.added.slice(0, LIST_CAP),
    changed: r.changes.changed.slice(0, LIST_CAP),
    removed: r.changes.removed.slice(0, LIST_CAP),
    counts: { added: r.changes.added.length, changed: r.changes.changed.length, removed: r.changes.removed.length },
    findings: r.findings,
    output: out.length > 3000 ? `…${out.slice(-3000)}` : out,
    verdict: r.verdict,
    reasons: risk.reasons,
  };
}

export type SandboxDecision = 'applied' | 'auto-applied' | 'discarded' | 'ran' | 'cancelled';

/** What goes on the tool message and the run step (§2.1 `run_steps.tool_calls[].sandbox`). */
export interface SandboxRecord extends SandboxCard {
  id: string;
  decision: SandboxDecision;
  applied?: Omit<ApplyResult, 'refBefore' | 'refAfter'> & { refBefore?: WorkspaceRef; refAfter?: WorkspaceRef };
}

export function sandboxRecord(r: SandboxResult, risk: CommandRisk, decision: SandboxDecision, applied?: ApplyResult): SandboxRecord {
  const status: SandboxFinding['status'] = decision === 'applied' || decision === 'auto-applied' ? 'applied' : decision === 'ran' ? 'ran' : 'discarded';
  const card = sandboxCard(r, risk);
  return { ...card, findings: card.findings.map((f) => ({ ...f, status })), id: r.id, decision, ...(applied ? { applied: { ...applied, written: applied.written.slice(0, 200), removed: applied.removed.slice(0, 200) } } : {}) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line of what the try changed (for the model's tool result and the bridges). */
export function changesLine(c: SandboxChanges | SandboxCard): string {
  const n = 'counts' in c ? c.counts : { added: c.added.length, changed: c.changed.length, removed: c.removed.length };
  if (!n.added && !n.changed && !n.removed) return 'no files changed';
  return [n.added ? `${n.added} added` : '', n.changed ? `${n.changed} changed` : '', n.removed ? `${n.removed} removed` : ''].filter(Boolean).join(', ');
}

/** The tool result she reads (and the receipt check reads): the try's own output, then the decision. */
export function sandboxOutput(r: SandboxResult, decision: SandboxDecision, applied?: ApplyResult): string {
  const head = r.run ? `[${r.run.timedOut ? 'timed out' : `exit code ${r.run.exitCode ?? 'none'}`}, ${(r.run.ms / 1000).toFixed(1)}s, ran in a sandbox copy (${r.isolation.isolated ? 'isolated' : 'not isolated'})]` : '[not run: too big for a sandbox try]';
  const body = r.run ? r.run.output.trimEnd().slice(-30_000) || '(no output)' : r.notRun ?? '';
  const flags = r.findings.filter((f) => SEV_RANK[f.severity] >= SEV_RANK.low).map((f) => `- ${f.title}${f.files?.length ? `: ${f.files.slice(0, 5).join(', ')}` : ''}`);
  const what = `Sandbox try: ${changesLine(r.changes)}.${flags.length ? `\nWhat the try showed:\n${flags.join('\n')}` : ''}`;
  let tail: string;
  if (decision === 'applied' || decision === 'auto-applied') {
    const a = applied!;
    tail = `${decision === 'auto-applied' ? 'Applied by itself (a clean, isolated try)' : 'The owner applied it'}: ${plural(a.written.length, 'file', 'files')} written, ${plural(a.removed.length, 'file', 'files')} removed in the workspace.${a.conflicts.length ? ` Left alone because they changed meanwhile: ${a.conflicts.slice(0, 10).join(', ')}.` : ''}${a.refused.length ? ` Never applied: ${a.refused.slice(0, 10).join(', ')}.` : ''} The command itself did not run in the real workspace (anything it does outside files, like starting a server, didn't happen there).`;
  } else if (decision === 'discarded') tail = 'The owner discarded this try: nothing changed in the workspace. Do not run it again unless they ask; explain or change course.';
  else if (decision === 'cancelled') tail = 'Cancelled: nothing changed in the workspace.';
  else tail = 'The owner chose to run it for real.';
  return `${head}\n${body}\n\n${what}\n${tail}`;
}

// ------------------------------------------------------------------------------------------------
// 9. The gate object the app keeps (AppContext.sandboxGate)
// ------------------------------------------------------------------------------------------------

/** A try planned at the approval point (src/chat.ts, src/team.ts). */
export interface SandboxPlan {
  command: string;
  risk: CommandRisk;
  isolation: Isolation;
  /** No OS isolation and the tool asks first: the owner's OK comes before the try. */
  askFirst: boolean;
  /** Runs the try (the copy is kept for Apply / Discard). */
  run(signal: AbortSignal): Promise<SandboxResult>;
}

export class SandboxGate {
  readonly cacheDir: string;
  readonly #base: SandboxInfo;
  readonly #settings: () => SandboxGateSettings;
  readonly #detect: (base: SandboxInfo, gate: SandboxGateSettings) => Isolation;
  #iso?: Isolation;
  #isoImage?: string;

  constructor(cacheDir: string, base: SandboxInfo, settings: () => SandboxGateSettings, detect: (base: SandboxInfo, gate: SandboxGateSettings) => Isolation = (b, g) => detectIsolation(b, g)) {
    this.cacheDir = cacheDir;
    this.#base = base;
    this.#settings = settings;
    this.#detect = detect;
  }

  settings(): SandboxGateSettings {
    return this.#settings();
  }

  /** The isolation for tries (detected once; again when the Docker image setting changes or on refresh). */
  isolation(refresh = false): Isolation {
    const g = this.#settings();
    if (refresh || !this.#iso || this.#isoImage !== g.dockerImage) {
      this.#iso = this.#detect(this.#base, g);
      this.#isoImage = g.dockerImage;
    }
    return this.#iso;
  }

  /** A try for this call, or undefined when it passes straight through (read-only, off, not a command). */
  plan(i: { tool: string; args: Record<string, unknown>; coding: boolean; permission: 'auto' | 'ask'; workspaceDir: string; network: boolean; gitName?: string; timeoutMs?: number }): SandboxPlan | undefined {
    const g = this.#settings();
    const { try: go, risk } = shouldTry({ tool: i.tool, args: i.args, coding: i.coding, settings: g });
    if (!go) return undefined;
    const isolation = this.isolation();
    const command = String(i.args.command ?? '');
    const asked = Math.min(1800, Math.max(1, Number(i.args.timeout_seconds) || 120)) * 1000;
    const timeoutMs = Math.min(i.timeoutMs ?? asked, g.timeLimitS * 1000);
    return {
      command,
      risk,
      isolation,
      askFirst: asksBeforeTry(isolation, i.permission),
      run: (signal) =>
        runInSandbox(i.workspaceDir, command, {
          cacheDir: this.cacheDir,
          base: this.#base,
          isolation,
          network: g.network && i.network,
          timeoutMs,
          signal,
          maxBytes: g.maxMB * 1048576,
          keep: true,
          dockerImage: g.dockerImage,
          // Sara's data folder (the cache's grandparent) is watched too: a write there is flagged.
          watch: [dirname(dirname(this.cacheDir))],
          ...(i.gitName ? { gitName: i.gitName } : {}),
        }),
    };
  }
}

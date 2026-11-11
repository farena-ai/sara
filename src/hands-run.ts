// 3.5 (PC tools, docs/design/PC_TOOLS.md): commands and "open this" on the owner's own computer,
// through the Sara app there (c.run / c.open over the hands WebSocket). Off by default: the app's
// switch "Let her run commands on this computer" (Settings → Computer use). Every command is shown
// on that computer (Allow once / Allow for this task / Don't); a phone can't approve. Never as
// administrator; Stop kills the whole process tree; output is masked before it leaves.
//
// The rules live here so the server, the reference device (src/hands-ref.ts) and the tests agree;
// the Windows app does the same in desktop/windows/src/hands-run.cpp.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { maskDesktopText } from './hands-desktop.ts';

export const RUN_OPS = ['c.run', 'c.open'] as const;
export const RUN_OPS_SET: ReadonlySet<string> = new Set(RUN_OPS);
export const RUN_SHELLS = ['powershell', 'cmd'] as const;
export type RunShell = (typeof RUN_SHELLS)[number];
export const RUN_LIMITS = {
  commandChars: 4000,
  /** What the computer sends back at most (head + tail when longer). */
  outputChars: 64_000,
  /** What the model gets at most. */
  modelChars: 16_000,
  /** One live chunk, and all live chunks of one command. */
  chunkChars: 4000,
  liveChars: 64_000,
  timeoutS: { min: 5, def: 60, max: 600 },
  pathChars: 260,
  /** A task grant ("Allow for this task") ends after 15 minutes without a command. */
  grantMs: 15 * 60_000,
} as const;

export class RunRuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Never as administrator: these are refused outright (the app never elevates). */
const ELEVATE = [/-verb\s+['"]?runas\b/i, /\brunas(\.exe)?\b/i, /\bg?sudo\b/i, /\bStart-Process\b[^\n]*-Verb\b/i];
/** These always ask on the computer, whatever the policy (deletes, disks, registry, shutdown, downloads run as code…). */
const DESTRUCTIVE = /\b(remove-item|ri|rm|rmdir|rd|del|erase|format(-volume)?|clear-disk|initialize-disk|diskpart|clear-content|set-content|out-file|reg(\.exe)?\s+(add|delete|import|restore)|set-itemproperty|remove-itemproperty|new-itemproperty|stop-computer|restart-computer|shutdown(\.exe)?|logoff|set-executionpolicy|stop-process|spps|taskkill|kill|move-item|mv|move|ren(ame)?(-item)?|copy-item|xcopy|robocopy|cipher|bcdedit|vssadmin|wmic|icacls|takeown|attrib|uninstall(-package)?|msiexec|winget|choco|invoke-webrequest|iwr|curl|wget|invoke-restmethod|irm|invoke-expression|iex|start-bitstransfer|downloadstring|downloadfile|net(\.exe)?\s+(user|localgroup|share)|schtasks|sc(\.exe)?\s+(delete|config|create|stop)|new-service|set-service|disable-|enable-|git\s+(push|reset|clean|checkout|rebase|commit|merge))\b/i;
/** The opt-in read-only list: one simple command, its pipes only to shaping cmdlets. */
const READ_HEAD = /^(get-childitem|gci|dir|ls|get-content|gc|type|cat|get-location|gl|pwd|get-date|date\s*\/t|whoami|hostname|get-process|gps|ps|get-item|gi|test-path|get-volume|get-psdrive|git\s+(status|log|diff|branch|show|remote\s+-v))(\s|$)/i;
const READ_PIPE = /^(select-object|select|format-table|ft|format-list|fl|sort-object|sort|measure-object|measure|out-string)(\s|$)/i;

export interface RunPlan {
  command: string;
  shell: RunShell;
  cwd: string;
  timeoutS: number;
  /** One of the simple read-only commands (runs without asking only when the owner picked that). */
  readOnly: boolean;
  /** Always asks (Allow once only). */
  destructive: boolean;
}

export const runShell = (raw: unknown): RunShell => (String(raw ?? '').toLowerCase().trim() === 'cmd' ? 'cmd' : 'powershell');

/** Is this one simple read-only command (no `;`, `&`, redirects, subexpressions, script blocks)? */
export function readOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || c.length > 400 || /[;&<>`{}\r\n]|\$\(|@\(/.test(c)) return false;
  // Only $env:NAME variables.
  if (/\$(?!env:[A-Za-z_][\w]*)/i.test(c)) return false;
  const parts = c.split('|').map((p) => p.trim());
  if (!READ_HEAD.test(parts[0])) return false;
  if (/^(type|cat|gc|get-content)\b/i.test(parts[0]) && /\b(-stream|::)/i.test(parts[0])) return false;
  return parts.slice(1).every((p) => READ_PIPE.test(p));
}

/** Checks a command before it is sent (the server) and before it runs (the computer). */
export function runPlan(args: Record<string, unknown>): RunPlan {
  const command = String(args.command ?? '').replace(/\r\n/g, '\n').trim();
  if (!command) throw new RunRuleError('denied_local', 'command: the PowerShell or cmd command to run.');
  if (command.length > RUN_LIMITS.commandChars) throw new RunRuleError('denied_local', `That command is longer than ${RUN_LIMITS.commandChars} characters.`);
  if (/[\u0000]/.test(command)) throw new RunRuleError('denied_local', 'That command has a NUL character.');
  if (ELEVATE.some((re) => re.test(command))) throw new RunRuleError('denied_local', 'Commands never run as administrator on this computer (no runas, sudo or -Verb RunAs). Ask the owner to do that part themselves.');
  const shell = runShell(args.shell);
  const cwd = String(args.cwd ?? '').trim();
  if (cwd) {
    if (cwd.length > RUN_LIMITS.pathChars || /[\u0000-\u001f<>"|?*]/.test(cwd.replace(/^[a-z]:/i, ''))) throw new RunRuleError('denied_local', 'cwd: a folder path on that computer, like C:\\Users\\you\\Projects.');
    if (/^\\\\|^\/\//.test(cwd)) throw new RunRuleError('denied_local', 'cwd: a folder on that computer, not a network share.');
    if (!/^[a-z]:[\\/]/i.test(cwd) && !cwd.startsWith('/') && cwd !== '~' && !cwd.startsWith('~/') && !cwd.startsWith('~\\')) throw new RunRuleError('denied_local', 'cwd: a full folder path on that computer (like C:\\Users\\you\\Projects), or leave it out for the home folder.');
  }
  const t = Number(args.timeout ?? args.timeoutS ?? (args.timeoutMs !== undefined ? Number(args.timeoutMs) / 1000 : RUN_LIMITS.timeoutS.def));
  const timeoutS = Math.round(Math.min(RUN_LIMITS.timeoutS.max, Math.max(RUN_LIMITS.timeoutS.min, Number.isFinite(t) ? t : RUN_LIMITS.timeoutS.def)));
  const destructive = DESTRUCTIVE.test(command);
  return { command, shell, cwd, timeoutS, readOnly: !destructive && readOnlyCommand(command), destructive };
}

/** Masks key-shaped text (the Files and desktop rules) and control characters other than newlines and tabs. */
export const maskRunText = (s: string): string => maskDesktopText(String(s ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''));

/** At most `max` characters: the start and the end, with how much was left out between. */
export function capOutput(text: string, max: number = RUN_LIMITS.outputChars): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max / 4);
  const tail = max - head - 80;
  return { text: `${text.slice(0, head)}\n[\u2026 ${text.length - head - tail} characters left out \u2026]\n${text.slice(text.length - tail)}`, truncated: true };
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  seconds: number;
  timedOut: boolean;
  stopped: boolean;
}

/** The server's re-check of a computer's c.run answer (masked and capped again, whatever it sent). */
export function runResult(raw: Record<string, unknown>): RunResult {
  const out = capOutput(maskRunText(String(raw.output ?? '')));
  const code = typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? Math.round(raw.exitCode) : null;
  return { exitCode: code, output: out.text, truncated: out.truncated || raw.truncated === true, seconds: Math.max(0, Math.round(Number(raw.seconds) * 10) / 10 || 0), timedOut: raw.timedOut === true, stopped: raw.stopped === true };
}

/** File types never "opened" by c.open (opening a path never runs a program). */
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|url|reg|hta|cpl|jar|appref-ms|application|gadget|inf|scf|ms-settings)$/i;
export interface OpenPlan {
  kind: 'url' | 'path' | 'app';
  target: string;
}
/** c.open: a web or mail address, a file or folder by full path (never a program), or an installed app by name. */
export function openPlan(raw: unknown): OpenPlan {
  const target = String(raw ?? '').trim();
  if (!target || target.length > 2000 || /[\u0000-\u001f]/.test(target)) throw new RunRuleError('denied_local', 'target: a web address, a full file or folder path, or an installed app\u2019s name.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^mailto:/i.test(target)) {
    if (!/^(https?:\/\/|mailto:)/i.test(target)) throw new RunRuleError('denied_local', 'Only http, https and mailto addresses are opened.');
    return { kind: 'url', target };
  }
  if (/^[a-z]:[\\/]/i.test(target) || target.startsWith('/') || target.startsWith('~')) {
    if (/^\\\\|^\/\//.test(target)) throw new RunRuleError('denied_local', 'Only files and folders on that computer, not network shares.');
    if (target.length > RUN_LIMITS.pathChars) throw new RunRuleError('denied_local', 'That path is too long.');
    if (RUNNABLE.test(target)) throw new RunRuleError('denied_local', 'Opening a program or script file is refused (use pc_run, which the owner approves, or open the app by its name).');
    return { kind: 'path', target };
  }
  if (target.length > 80 || !/^[\w .+&'()-]+$/u.test(target)) throw new RunRuleError('denied_local', 'An app is opened by its name as in the Start menu (like "Notepad"), never a command line.');
  return { kind: 'app', target };
}

// ---------------- the device side (the reference hands; the Windows app ports it) ----------------

export interface RunExec {
  command: string;
  shell: RunShell;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}
export type RunExecutor = (x: RunExec) => Promise<{ exitCode: number | null; timedOut: boolean; stopped: boolean; pid?: number }>;

/** Kills a process and everything it started (Windows: taskkill /T; elsewhere its process group). */
export function killTree(pid: number): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    if (spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0) return;
    // taskkill /T can fail inside a nested job ("Quota violation"): find the tree ourselves, then end each.
    const q = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', windowsHide: true });
    const kids = new Map<number, number[]>();
    for (const line of String(q.stdout ?? '').split(/\r?\n/)) {
      const [c, p] = line.trim().split(/\s+/).map(Number);
      if (c && p !== undefined) kids.set(p, [...(kids.get(p) ?? []), c]);
    }
    const tree: number[] = [];
    const walk = (p: number) => {
      if (tree.includes(p) || tree.length > 500) return;
      tree.push(p);
      for (const c of kids.get(p) ?? []) walk(c);
    };
    walk(pid);
    for (const p of tree.reverse()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

/** The real runner: PowerShell / cmd on Windows (sh elsewhere), as this user, the tree killed on Stop or the deadline. */
export const spawnRun: RunExecutor = (x) =>
  new Promise((resolve) => {
    const cwd = !x.cwd || x.cwd === '~' ? homedir() : x.cwd.startsWith('~') ? homedir() + x.cwd.slice(1) : x.cwd;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      x.onChunk(`That folder doesn't exist on this computer: ${x.cwd}\n`);
      return resolve({ exitCode: null, timedOut: false, stopped: false });
    }
    const win = process.platform === 'win32';
    const [file, argv] = x.shell === 'cmd' ? (win ? ['cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ${x.command}`]] : ['/bin/sh', ['-c', x.command]]) : win ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${x.command}`]] : ['/bin/sh', ['-c', x.command]];
    const child = spawn(file as string, argv as string[], { cwd, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: win && x.shell === 'cmd' });
    let timedOut = false;
    let stopped = false;
    const end = () => killTree(child.pid ?? 0);
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, x.timeoutMs);
    const onAbort = () => {
      stopped = true;
      end();
    };
    x.signal.addEventListener('abort', onAbort, { once: true });
    const take = (b: Buffer) => x.onChunk(b.toString('utf8'));
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const done = (code: number | null) => {
      clearTimeout(timer);
      x.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: timedOut || stopped ? null : code, timedOut, stopped, ...(child.pid ? { pid: child.pid } : {}) });
    };
    child.on('error', (e) => {
      x.onChunk(`${e.message}\n`);
      done(null);
    });
    child.on('close', (code) => done(code));
    if (x.signal.aborted) onAbort();
  });

export interface RunPrompt {
  kind: 'run' | 'open';
  computer: string;
  /** What the card shows: the shell, the folder and the whole command (or what is opened). */
  text: string;
  /** "Allow for this task" is offered. */
  taskChoice: boolean;
}
export interface RunDeviceOptions {
  /** "Let her run commands on this computer" (off by default). */
  on: boolean;
  /** The same choices as desktop actions. */
  level?: 'ask' | 'task' | 'always';
  /** "Simple read-only commands without asking" (off by default). */
  readOnlyAuto?: boolean;
  /** The computer's own card. Without it nothing runs. */
  consent?: (p: RunPrompt) => Promise<'once' | 'task' | 'deny'>;
  exec?: RunExecutor;
  /** c.open (tests: a fixture that records what was opened). */
  open?: (p: OpenPlan) => Promise<void> | void;
  /** The app runs as administrator (then c.run refuses). */
  elevated?: () => boolean;
  /** Paused: the person took over, or the computer is locked (walk-away). */
  paused?: () => boolean;
}

/** The device's c.run / c.open (the reference hands; desktop/windows/src/hands-run.cpp is the same). */
export class RunDevice {
  readonly opts: RunDeviceOptions;
  readonly #grants = new Map<string, number>();
  /** Tests read it: what was opened here. */
  readonly opened: OpenPlan[] = [];
  constructor(opts: RunDeviceOptions) {
    this.opts = opts;
  }
  clearGrants(): void {
    this.#grants.clear();
  }

  async #approve(kind: 'run' | 'open', text: string, args: Record<string, unknown>, opts: { readOnly: boolean; destructive: boolean; computer: string; send: (ev: Record<string, unknown>) => void }): Promise<void> {
    const now = Date.now();
    for (const [k, at] of this.#grants) if (now - at > RUN_LIMITS.grantMs) this.#grants.delete(k);
    let level = this.opts.level ?? 'task';
    if (args.approvalLevel === 'ask') level = 'ask'; // the server can make it stricter, never looser
    const task = String(args.task ?? '').slice(0, 160);
    if (opts.readOnly && this.opts.readOnlyAuto === true && args.approvalLevel !== 'ask') return;
    const once = opts.destructive;
    const granted = !once && (level === 'always' || (level === 'task' && Boolean(task) && this.#grants.has(task)));
    if (granted) {
      this.#grants.set(task, now);
      return;
    }
    if (!this.opts.consent) throw new RunRuleError('denied_local', 'This computer has no approval card: nothing runs.');
    opts.send({ state: 'asking' });
    const answer = await this.opts.consent({ kind, computer: opts.computer, text, taskChoice: !once && level === 'task' && Boolean(task) });
    if (answer === 'deny') throw new RunRuleError('denied_local', 'The person at this computer said no.');
    if (answer === 'task' && task) this.#grants.set(task, Date.now());
  }

  #ready(): void {
    if (!this.opts.on) throw new RunRuleError('denied_local', '"Let her run commands on this computer" is off here: only the person here can switch it on, in the Sara app (Settings, Computer use).');
    if (this.opts.paused?.()) throw new RunRuleError('takeover', 'Paused on this computer (the person took over or it is locked): nothing new runs until they press Resume.');
  }

  /** c.run: approve (on this computer), run as this user, stream masked output, kill the tree on Stop or the deadline. */
  async run(args: Record<string, unknown>, ctx: { signal: AbortSignal; computer: string; send: (ev: Record<string, unknown>) => void; log: (what: string, target: string) => void }): Promise<RunResult> {
    this.#ready();
    const plan = runPlan(args);
    if (this.opts.elevated?.()) throw new RunRuleError('denied_local', 'The Sara app is running as administrator here, so commands are refused (they never run elevated). Start the app normally.');
    const where = plan.cwd || '~ (home)';
    try {
      await this.#approve('run', `${plan.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'} in ${where}${plan.destructive ? ' (this may change or delete things)' : ''}:\n${plan.command}`, args, { readOnly: plan.readOnly, destructive: plan.destructive, computer: ctx.computer, send: ctx.send });
    } catch (err) {
      ctx.log(`didn't run a command (${(err as Error).message.slice(0, 60)})`, plan.command);
      throw err;
    }
    ctx.signal.throwIfAborted();
    ctx.send({ state: 'running' });
    const started = Date.now();
    let all = '';
    let live = 0;
    let pending = '';
    let flushAt = 0;
    const flush = () => {
      if (!pending || live >= RUN_LIMITS.liveChars) return (pending = '');
      const c = maskRunText(pending).slice(0, Math.min(RUN_LIMITS.chunkChars, RUN_LIMITS.liveChars - live));
      live += c.length;
      pending = '';
      ctx.send({ state: 'running', chunk: c });
    };
    const exec = this.opts.exec ?? spawnRun;
    const r = await exec({
      command: plan.command,
      shell: plan.shell,
      cwd: plan.cwd,
      timeoutMs: plan.timeoutS * 1000,
      signal: ctx.signal,
      onChunk: (t) => {
        if (all.length < RUN_LIMITS.outputChars * 4) all += t;
        pending += t;
        if (pending.length >= RUN_LIMITS.chunkChars || Date.now() - flushAt > 250) {
          flushAt = Date.now();
          flush();
        }
      },
    });
    flush();
    const out = capOutput(maskRunText(all));
    const result: RunResult = { exitCode: r.exitCode, output: out.text, truncated: out.truncated, seconds: Math.round((Date.now() - started) / 100) / 10, timedOut: r.timedOut, stopped: r.stopped };
    ctx.log(r.stopped ? 'ran a command (stopped)' : r.timedOut ? 'ran a command (timed out)' : `ran a command (exit ${r.exitCode ?? '?'})`, plan.command);
    return result;
  }

  /** c.open: approve, then open with the default app (never a program file, never arguments). */
  async open(args: Record<string, unknown>, ctx: { signal: AbortSignal; computer: string; send: (ev: Record<string, unknown>) => void; log: (what: string, target: string) => void }): Promise<Record<string, unknown>> {
    this.#ready();
    const plan = openPlan(args.target);
    await this.#approve('open', `Open ${plan.kind === 'url' ? 'this address' : plan.kind === 'path' ? 'this file or folder' : 'this app'}:\n${plan.target}`, args, { readOnly: false, destructive: false, computer: ctx.computer, send: ctx.send });
    ctx.signal.throwIfAborted();
    if (!this.opts.open) throw new RunRuleError('unsupported', 'This computer can\u2019t open things.');
    await this.opts.open(plan);
    this.opened.push(plan);
    ctx.log(`opened ${plan.kind === 'url' ? 'an address' : plan.kind === 'path' ? 'a file or folder' : 'an app'}`, plan.target);
    return { opened: true, kind: plan.kind };
  }
}

/** The relative cwd check used by both sides (exported for tests). */
export const absoluteCwd = (cwd: string): boolean => !cwd || isAbsolute(cwd) || /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('~');

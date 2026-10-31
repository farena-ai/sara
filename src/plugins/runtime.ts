// Phase 98 (ST3, docs/design/STAPLES.md §6.5–§6.6): one plugin's process and its JSON channel.
//
// The process: `node --permission` with read access to the plugin's folder and its own data folder,
// write access to the data folder only, no child processes, workers or addons, a minimal
// environment (no Sara variables, no tokens), cwd = its data folder, a 128 MB heap. On Linux with
// bubblewrap it runs inside the same kind of profile as commands, without any network
// (`--unshare-all`, no `--share-net`) and only its folders bound; on macOS inside a generated
// Seatbelt profile without network. Elsewhere Node's permissions are the only fence (a seat belt,
// not a sandbox: the review card says "not fenced in").
//
// The channel: newline-delimited JSON over stdin/stdout, version 1. Caps: 1 MB per line, 100 calls
// a minute, 8 calls in flight; unknown types dropped; bad JSON dropped and logged. Requests Sara
// sends wait for a `result` with the same id, up to a time limit; a late answer is ignored.
//
// Crashes restart with a backoff (1 s, 5 s, 30 s); 3 crashes in 10 minutes and the plugin is
// switched off (the manager shows a card). On Linux the process is also killed above 256 MB RSS or
// 30 s of CPU in a minute.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bwrapArgs, SANDBOX_EXEC, seatbeltProfile, type SandboxInfo } from '../tools/sandbox.ts';

export const HOST_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'plugin-host.mjs');
export const MAX_LINE = 1024 * 1024;
export const CALLS_PER_MINUTE = 100;
export const IN_FLIGHT = 8;
export const BACKOFF_MS = [1000, 5000, 30_000] as const;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const MAX_CRASHES = 3;
export const MAX_RSS = 256 * 1024 * 1024;
export const MAX_CPU_MS_PER_MIN = 30_000;
const READY_MS = 15_000;

export type Fence = 'bwrap' | 'seatbelt' | 'node-only';

/** The fence this server can put around a plugin (the sandbox detected at start). */
export function fenceFor(sandbox: Pick<SandboxInfo, 'mode'>): Fence {
  return sandbox.mode === 'bwrap' ? 'bwrap' : sandbox.mode === 'seatbelt' ? 'seatbelt' : 'node-only';
}

export interface Spawned {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * The command line for one plugin process. `pluginDir` holds its code (read only), `dataDir` its
 * own files; `readExtra` are further read-only folders (the main workspace for files.read: workspace).
 */
export function spawnSpec(o: { fence: Fence; pluginDir: string; dataDir: string; main: string; readExtra?: string[]; saraDataDir?: string; execPath?: string; hostFile?: string }): Spawned {
  const exec = o.execPath ?? process.execPath;
  const host = o.hostFile ?? HOST_FILE;
  const reads = [o.pluginDir, o.dataDir, host, ...(o.readExtra ?? [])];
  const nodeFlags = (dataDir: string, readList: string[], hostPath: string, mainPath: string) => [
    '--permission',
    ...readList.map((r) => `--allow-fs-read=${r}`),
    `--allow-fs-write=${dataDir}`,
    '--max-old-space-size=128',
    '--disable-warning=ExperimentalWarning',
    '--no-addons',
    hostPath,
    mainPath,
  ];
  const env: Record<string, string> = { NODE_ENV: 'production', LANG: 'C.UTF-8', HOME: o.dataDir, TMPDIR: join(o.dataDir, 'tmp'), ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) };
  const mainAbs = join(o.pluginDir, ...o.main.split('/'));
  if (o.fence === 'bwrap') {
    // Inside: the data folder is /workspace (the only writable place); code, host and Node are
    // bound read-only at their own paths. No --share-net: no network namespace to the outside.
    const nodeRoot = dirname(dirname(exec));
    const binds = [
      { src: o.pluginDir, dest: o.pluginDir },
      { src: dirname(host), dest: dirname(host) },
      ...(nodeRoot.startsWith('/usr') ? [] : [{ src: nodeRoot, dest: nodeRoot }]),
      ...(o.readExtra ?? []).map((r) => ({ src: r, dest: r })),
    ];
    const inner = nodeFlags('/workspace', [o.pluginDir, '/workspace', host, ...(o.readExtra ?? [])], host, mainAbs);
    return { file: 'bwrap', args: [...bwrapArgs(o.dataDir, false, binds), '--setenv', 'TMPDIR', '/workspace/tmp', '--', exec, ...inner], cwd: o.dataDir, env: { ...env, HOME: '/workspace', TMPDIR: '/workspace/tmp' } };
  }
  if (o.fence === 'seatbelt') {
    const profile = seatbeltProfile({ workspace: o.dataDir, tmp: join(o.dataDir, 'tmp'), ...(o.saraDataDir ? { dataDir: o.saraDataDir } : {}), home: homedir(), binds: [{ src: o.pluginDir, dest: o.pluginDir }, { src: dirname(host), dest: dirname(host) }, ...(o.readExtra ?? []).map((r) => ({ src: r, dest: r }))], runtime: dirname(dirname(exec)) }, false);
    return { file: SANDBOX_EXEC, args: ['-p', profile, exec, ...nodeFlags(o.dataDir, reads, host, mainAbs)], cwd: o.dataDir, env };
  }
  return { file: exec, args: nodeFlags(o.dataDir, reads, host, mainAbs), cwd: o.dataDir, env };
}

// ---------------------------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------------------------

/** Splits a byte stream into lines; a line over the cap is dropped whole (and reported once). */
export class LineSplitter {
  #buf: Buffer[] = [];
  #size = 0;
  #dropping = false;
  readonly onLine: (line: string) => void;
  readonly onTooLong: () => void;
  readonly max: number;
  constructor(onLine: (line: string) => void, onTooLong: () => void, max = MAX_LINE) {
    this.onLine = onLine;
    this.onTooLong = onTooLong;
    this.max = max;
  }
  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) {
        const rest = chunk.subarray(start);
        if (this.#dropping) return;
        this.#size += rest.length;
        if (this.#size > this.max) {
          this.#buf = [];
          this.#size = 0;
          this.#dropping = true;
          this.onTooLong();
          return;
        }
        this.#buf.push(rest);
        return;
      }
      const part = chunk.subarray(start, nl);
      if (this.#dropping) {
        this.#dropping = false;
      } else if (this.#size + part.length > this.max) {
        this.onTooLong();
      } else {
        const line = Buffer.concat([...this.#buf, part]).toString('utf8');
        if (line.trim()) this.onLine(line);
      }
      this.#buf = [];
      this.#size = 0;
      start = nl + 1;
    }
  }
}

/** A message from the plugin (already parsed). */
export interface InMessage {
  v?: number;
  id?: string;
  type: string;
  [k: string]: unknown;
}

/** What the process reports to its manager. */
export interface ProcessEvents {
  /** A plugin → Sara call (fetch, tool, notify, card, model, kv.get, kv.set, bridge.inbound). */
  onCall(op: string, msg: InMessage): Promise<Record<string, unknown>>;
  onReady(msg: InMessage): void;
  onLog(kind: 'log' | 'denied' | 'crash' | 'timeout', text: string): void;
  /** The plugin crashed too often and was stopped for good (the manager switches it off). */
  onGaveUp(reason: string): void;
  /** Bridge events from the plugin aren't calls; this is the one-way `bridge.*` path. */
}

export type ProcessState = 'starting' | 'ready' | 'stopped' | 'crashed' | 'waiting';

/** Sliding one-minute counter. */
class PerMinute {
  #times: number[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(now = Date.now()): boolean {
    while (this.#times.length && now - this.#times[0] > 60_000) this.#times.shift();
    if (this.#times.length >= this.limit) return false;
    this.#times.push(now);
    return true;
  }
}

export class PluginProcess {
  state: ProcessState = 'stopped';
  readonly crashes: number[] = [];
  lastError = '';
  lastActivity = '';
  #child: ChildProcess | undefined;
  #pending = new Map<string, { resolve: (v: InMessage | undefined) => void; timer: NodeJS.Timeout }>();
  #seq = 0;
  #inFlight = 0;
  #rate = new PerMinute(CALLS_PER_MINUTE);
  #rateWarned = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #watchTimer: NodeJS.Timeout | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #stopping = false;
  #init: Record<string, unknown> = {};
  #cpuMark = { at: 0, ms: 0 };

  readonly key: string;
  readonly spec: () => Spawned;
  readonly events: ProcessEvents;
  readonly now: () => number;
  constructor(key: string, spec: () => Spawned, events: ProcessEvents, now: () => number = Date.now) {
    this.key = key;
    this.spec = spec;
    this.events = events;
    this.now = now;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  start(init: Record<string, unknown>): void {
    this.#init = init;
    this.#stopping = false;
    this.#spawn();
  }

  #spawn(): void {
    clearTimeout(this.#restartTimer);
    const sp = this.spec();
    mkdirSync(sp.cwd, { recursive: true, mode: 0o700 });
    mkdirSync(join(sp.cwd, 'tmp'), { recursive: true, mode: 0o700 });
    this.state = 'starting';
    let child: ChildProcess;
    try {
      child = spawn(sp.file, sp.args, { cwd: sp.cwd, env: sp.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false });
    } catch (err) {
      this.#crashed(`couldn't start: ${(err as Error).message}`);
      return;
    }
    this.#child = child;
    let stderr = '';
    const split = new LineSplitter(
      (line) => this.#line(line),
      () => this.events.onLog('denied', 'a line longer than 1 MB was dropped'),
    );
    child.stdout!.on('data', (c: Buffer) => split.push(c));
    child.stderr!.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000);
    });
    child.stdin!.on('error', () => {
      /* the process is gone; the exit handler deals with it */
    });
    child.on('error', (err) => {
      this.lastError = err.message;
    });
    child.on('exit', (code, sig) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      clearInterval(this.#watchTimer);
      clearTimeout(this.#readyTimer);
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.resolve(undefined);
      }
      this.#pending.clear();
      this.#inFlight = 0;
      if (this.#stopping) {
        this.state = 'stopped';
        return;
      }
      const why = `stopped (${sig ?? `exit ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}` : ''}`;
      this.#crashed(why);
    });
    this.send({ v: 1, type: 'init', ...this.#init });
    this.#readyTimer = setTimeout(() => {
      if (this.state === 'starting') {
        this.events.onLog('timeout', 'no "ready" within 15 s');
        this.#kill();
      }
    }, READY_MS);
    this.#readyTimer.unref?.();
    if (process.platform === 'linux' && child.pid) {
      this.#cpuMark = { at: this.now(), ms: 0 };
      this.#watchTimer = setInterval(() => this.#watch(child.pid!), 5000);
      this.#watchTimer.unref?.();
    }
  }

  /** Linux: RSS and CPU from /proc (killed above the caps). */
  #watch(pid: number): void {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
      if (rss > MAX_RSS) {
        this.events.onLog('crash', `killed: ${Math.round(rss / 1048576)} MB of memory (the cap is 256 MB)`);
        this.#kill();
        return;
      }
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
      const ticks = Number(stat[11] ?? 0) + Number(stat[12] ?? 0);
      const ms = (ticks * 1000) / 100;
      const t = this.now();
      if (t - this.#cpuMark.at >= 60_000) this.#cpuMark = { at: t, ms };
      else if (ms - this.#cpuMark.ms > MAX_CPU_MS_PER_MIN) {
        this.events.onLog('crash', 'killed: more than 30 s of busy CPU in a minute');
        this.#kill();
      }
    } catch {
      /* gone */
    }
  }

  #crashed(why: string): void {
    this.lastError = why;
    const t = this.now();
    this.crashes.push(t);
    while (this.crashes.length && t - this.crashes[0] > CRASH_WINDOW_MS) this.crashes.shift();
    this.events.onLog('crash', why);
    if (this.crashes.length >= MAX_CRASHES) {
      this.state = 'crashed';
      this.events.onGaveUp(why);
      return;
    }
    this.state = 'waiting';
    const delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)];
    this.#restartTimer = setTimeout(() => {
      if (!this.#stopping) this.#spawn();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #kill(): void {
    const c = this.#child;
    if (!c) return;
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /** Stops the process (and any restart). Resolves when it has exited. */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    clearInterval(this.#watchTimer);
    clearTimeout(this.#readyTimer);
    const c = this.#child;
    if (!c) {
      this.state = this.state === 'crashed' ? 'crashed' : 'stopped';
      return;
    }
    await new Promise<void>((resolveStop) => {
      const done = setTimeout(resolveStop, 3000);
      c.once('exit', () => {
        clearTimeout(done);
        resolveStop();
      });
      try {
        c.stdin?.end();
        c.kill('SIGKILL');
      } catch {
        clearTimeout(done);
        resolveStop();
      }
    });
    this.state = this.state === 'crashed' ? 'crashed' : 'stopped';
  }

  send(msg: Record<string, unknown>): boolean {
    const c = this.#child;
    if (!c?.stdin?.writable) return false;
    try {
      c.stdin.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Sends a request and waits for its result (undefined on a timeout, a crash or not running). */
  request(type: string, body: Record<string, unknown>, timeoutMs: number): Promise<InMessage | undefined> {
    if (this.state !== 'ready') return Promise.resolve(undefined);
    const id = `${type[0]}${++this.#seq}`;
    return new Promise((resolveReq) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.events.onLog('timeout', `${type}${body.hook ? ` ${String(body.hook)}` : body.name ? ` ${String(body.name)}` : ''}: no answer within ${timeoutMs} ms`);
        resolveReq(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolveReq, timer });
      if (!this.send({ v: 1, id, type, ...body })) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolveReq(undefined);
      }
    });
  }

  #line(line: string): void {
    let msg: InMessage;
    try {
      msg = JSON.parse(line) as InMessage;
    } catch {
      this.events.onLog('denied', `a line that isn't JSON was dropped (${line.slice(0, 60)})`);
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this.events.onLog('denied', 'a message without a type was dropped');
      return;
    }
    this.lastActivity = new Date(this.now()).toISOString();
    if (msg.type === 'ready') {
      if (this.state !== 'starting') return;
      clearTimeout(this.#readyTimer);
      this.state = 'ready';
      this.events.onReady(msg);
      return;
    }
    if (msg.type === 'result' || msg.type === 'error') {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const p = this.#pending.get(id);
      if (!p) return; // late or unknown: ignored
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.resolve(msg);
      return;
    }
    if (msg.type === 'log') {
      this.events.onLog('log', `${String(msg.level ?? 'info')}: ${String(msg.text ?? '').slice(0, 1500)}`);
      return;
    }
    if (msg.type === 'call') {
      const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : '';
      const op = String(msg.op ?? '');
      if (!id) {
        this.events.onLog('denied', 'a call without an id was dropped');
        return;
      }
      if (!this.#rate.take(this.now())) {
        const t = this.now();
        if (t - this.#rateWarned > 60_000) {
          this.#rateWarned = t;
          this.events.onLog('denied', 'more than 100 calls in a minute: calls refused for now');
        }
        this.send({ v: 1, id, type: 'error', error: 'rate limited: at most 100 calls a minute' });
        return;
      }
      if (this.#inFlight >= IN_FLIGHT) {
        this.send({ v: 1, id, type: 'error', error: 'busy: at most 8 calls at a time' });
        return;
      }
      this.#inFlight++;
      void this.events
        .onCall(op, msg)
        .then((r) => this.send({ v: 1, id, type: 'result', ...r }))
        .catch((err: Error) => this.send({ v: 1, id, type: 'error', error: String(err.message ?? err).slice(0, 500) }))
        .finally(() => {
          this.#inFlight = Math.max(0, this.#inFlight - 1);
        });
      return;
    }
    // Unknown types are dropped (forward compatible).
  }
}

/** Writes the minimal files a plugin's data folder starts with. */
export function prepareDataDir(dir: string): void {
  mkdirSync(join(dir, 'tmp'), { recursive: true, mode: 0o700 });
  const readme = join(dir, 'README.txt');
  if (!existsSync(readme)) writeFileSync(readme, "This plugin's own folder (Sara made it). It may read and write here only.\n", { mode: 0o600 });
}

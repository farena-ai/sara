// H_EXEC (docs/ops/H_EXEC_DESIGN.md): one approved plugin job. A typed plan (a declared program,
// a closed argument grammar, limits) runs in a disposable snapshot of the plugin's staged files or
// the selected workspace, inside the strongest fence this computer has:
//
//   Linux + bubblewrap  an OS sandbox: read-only system, the snapshot the only writable place, no
//                       network unless the approved plan has it, CPU/file-size ulimits.
//   everywhere else     NOT OS-sandboxed: only `node`, under Node's permission model (reads and
//                       writes limited to the snapshot, no child processes, workers or addons).
//                       Network is not blocked by the OS (proxy variables only).
//
// Never the real workspace: the snapshot is copied (no .git, links or dependency folders), hashed
// before and after for the changed-file list, and deleted at the end. Cancellable at any point.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { SANDBOX_HEAVY } from '../sandbox-run.ts';
import { bwrapArgs, PRIVATE_LOCAL_ENV, runtimeMountArgs, RUNTIME_MOUNT, type Bind, type SandboxInfo } from '../tools/sandbox.ts';

import { JOB_PROGRAMS, JOB_SOURCES, type JobProgram, type JobSource, type RunPermission } from './manifest.ts';
export { JOB_PROGRAMS, JOB_SOURCES, type JobProgram, type JobSource, type RunPermission };

export interface JobPlan {
  program: JobProgram;
  args: string[];
  source: JobSource;
  /** Source `data`: the folder inside the plugin's own data folder to snapshot. */
  from: string;
  /** The working folder inside the snapshot. */
  cwd: string;
  timeoutS: number;
  cpuS: number;
  maxOutputKB: number;
  network: boolean;
}

export type JobFence = 'bwrap' | 'node-only';
export const FENCE_LABELS: Record<JobFence, string> = {
  bwrap: 'OS sandbox (bubblewrap): only the disposable copy is writable',
  'node-only': 'not OS-sandboxed on this computer: Node permission model only, limited to a disposable copy',
};

export class JobRefused extends Error {}

export const MAX_ARGS = 64;
export const MAX_ARG = 1024;
export const MAX_SNAPSHOT_FILES = 20_000;
export const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
export const MAX_CHANGED = 500;
const PLAN_FIELDS = new Set(['program', 'args', 'source', 'from', 'cwd', 'timeoutS', 'cpuS', 'maxOutputKB', 'network']);
/** Node options a plan may use (a closed list; nothing that grants or debugs). `=` ones take a value. */
const NODE_FLAGS = new Set(['--test', '--test-only', '--experimental-strip-types', '--no-warnings', '--enable-source-maps']);
const NODE_VALUE_FLAGS = new Set(['--test-reporter', '--test-name-pattern', '--test-concurrency', '--test-timeout', '--test-isolation', '--disable-warning']);
const WIN_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** The bubblewrap fence where the shell sandbox is bubblewrap; the Node fence everywhere else. */
export function jobFenceFor(sandbox: SandboxInfo): JobFence {
  return sandbox.mode === 'bwrap' ? 'bwrap' : 'node-only';
}

/** A relative path inside a folder: forward slashes, no `..`/`.`, drive, UNC, device or ADS forms. */
export function relInside(v: string, allowDot: boolean): boolean {
  if (allowDot && v === '.') return true;
  if (!v || v.length > 300 || /[\0\r\n\\:*?"<>|]/.test(v) || v.startsWith('/') || v.endsWith('/')) return false;
  return v.split('/').every((s) => s && s !== '.' && s !== '..' && !WIN_DEVICE.test(s) && !/[ .]$/.test(s));
}

const int = (raw: Record<string, unknown>, k: string, dflt: number, max: number): number => {
  const v = raw[k] === undefined ? dflt : raw[k];
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new JobRefused(`${k} must be a whole number from 1 to ${max}.`);
  return v as number;
};

/** Checks a plan against the plugin's declared run permission and this computer's fence. */
export function parsePlan(raw: unknown, perm: RunPermission, fence: JobFence): JobPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobRefused('The plan must be an object.');
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!PLAN_FIELDS.has(k)) throw new JobRefused(`Unknown plan field "${k.slice(0, 40)}".`);
  const program = String(p.program ?? '');
  if (!(JOB_PROGRAMS as readonly string[]).includes(program)) throw new JobRefused(`"${program.slice(0, 40)}" isn't a program Sara can run for a plugin (node or npm).`);
  if (!perm.programs.includes(program as JobProgram)) throw new JobRefused(`The plugin doesn't declare "${program}" in permissions.run.programs.`);
  const source = (p.source ?? 'data') as string;
  if (!(JOB_SOURCES as readonly string[]).includes(source)) throw new JobRefused('source must be "data" or "workspace".');
  if (!perm.sources.includes(source as JobSource)) throw new JobRefused(`The plugin doesn't declare the source "${source}" in permissions.run.sources.`);
  const network = p.network === undefined ? false : p.network;
  if (typeof network !== 'boolean') throw new JobRefused('network must be true or false.');
  if (network && !perm.network) throw new JobRefused("The plugin doesn't declare network in permissions.run.");
  if (!Array.isArray(p.args)) throw new JobRefused('args must be a list of strings.');
  if (p.args.length > MAX_ARGS) throw new JobRefused(`A plan has at most ${MAX_ARGS} arguments.`);
  const args = p.args.map((a) => {
    if (typeof a !== 'string') throw new JobRefused('args must be a list of strings.');
    if (/[\0\r\n]/.test(a)) throw new JobRefused('An argument may not contain line breaks or NUL.');
    if (a.length > MAX_ARG) throw new JobRefused(`An argument is longer than ${MAX_ARG} characters.`);
    return a;
  });
  const from = p.from === undefined ? '.' : String(p.from);
  if (!relInside(from, true)) throw new JobRefused('from must be a relative path inside the plugin\'s own data folder.');
  if (source !== 'data' && from !== '.') throw new JobRefused('from is only for the source "data".');
  const cwd = p.cwd === undefined ? '.' : String(p.cwd);
  if (!relInside(cwd, true)) throw new JobRefused('cwd must be a relative path inside the copy.');
  if (program === 'node') checkNodeArgs(args, fence);
  else checkNpmArgs(args, fence);
  return { program: program as JobProgram, args, source: source as JobSource, from, cwd, timeoutS: int(p, 'timeoutS', 60, 600), cpuS: int(p, 'cpuS', 60, 600), maxOutputKB: int(p, 'maxOutputKB', 64, 256), network };
}

function checkNodeArgs(args: string[], fence: JobFence): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const ok = eq < 0 ? NODE_FLAGS.has(name) : NODE_VALUE_FLAGS.has(name) && a.length > eq + 1;
      if (!ok) throw new JobRefused(`"${a.slice(0, 60)}" isn't an allowed node option for a plugin job.`);
      if (name === '--test-isolation' && a.slice(eq + 1) !== 'none' && fence !== 'bwrap') throw new JobRefused('Test isolation in separate processes needs an OS sandbox; use --test-isolation=none here.');
      continue;
    }
    // The script (or a test file / glob for --test): inside the copy. Everything after belongs to it.
    if (!relInside(a, false)) throw new JobRefused(`"${a.slice(0, 60)}" must be a relative path inside the copy.`);
    if (!args.slice(0, i).includes('--test')) return;
  }
}

function checkNpmArgs(args: string[], fence: JobFence): void {
  if (fence !== 'bwrap') throw new JobRefused('npm runs lifecycle scripts as child processes: it needs an OS sandbox, which this computer does not have for plugin jobs.');
  const [cmd, script, ...rest] = args;
  if (cmd === 'test') {
    if (script !== undefined && script !== '--') throw new JobRefused('After "npm test" only "--" and the script\'s own arguments may follow.');
    return;
  }
  if (cmd !== 'run') throw new JobRefused('npm may only run "test" or "run <script>".');
  if (!script || !/^[\w:.-]{1,64}$/.test(script)) throw new JobRefused(`"${String(script ?? '').slice(0, 40)}" isn't a script name.`);
  if (rest.length && rest[0] !== '--') throw new JobRefused('After the script name only "--" and the script\'s own arguments may follow.');
}

/** The exact command the owner approves (POSIX quoting). */
export function commandLine(plan: Pick<JobPlan, 'program' | 'args'>): string {
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [plan.program, ...plan.args].map(q).join(' ');
}

// ------------------------------------------------------------------------------------------------
// the snapshot
// ------------------------------------------------------------------------------------------------

export interface SnapshotInfo {
  files: number;
  bytes: number;
  /** Symbolic links and other non-regular entries left out. */
  skipped: number;
}

/** Copies `src` into `dest`: regular files only, no `.git`, links or dependency folders. */
export function snapshotCopy(src: string, dest: string): SnapshotInfo {
  const info: SnapshotInfo = { files: 0, bytes: 0, skipped: 0 };
  const walk = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.name === '.git' || SANDBOX_HEAVY.has(e.name)) continue;
      const abs = join(from, e.name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        info.skipped++;
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, join(to, e.name));
        continue;
      }
      if (++info.files > MAX_SNAPSHOT_FILES) throw new JobRefused(`The source has more than ${MAX_SNAPSHOT_FILES} files.`);
      info.bytes += st.size;
      if (info.bytes > MAX_SNAPSHOT_BYTES) throw new JobRefused(`The source is larger than ${MAX_SNAPSHOT_BYTES / 1048576} MB (without .git and dependency folders).`);
      copyFileSync(abs, join(to, e.name), constants.COPYFILE_FICLONE);
    }
  };
  walk(src, dest);
  return info;
}

function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try {
          out.set(r, createHash('sha256').update(readFileSync(abs)).digest('hex'));
        } catch {
          out.set(r, 'unreadable');
        }
      } else out.set(r, 'special');
    }
  };
  walk(root, '');
  return out;
}

export interface JobChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

function diff(a: Map<string, string>, b: Map<string, string>): JobChanges {
  const c: JobChanges = { added: [], changed: [], removed: [] };
  for (const [p, h] of b) {
    const o = a.get(p);
    if (o === undefined) c.added.push(p);
    else if (o !== h) c.changed.push(p);
  }
  for (const p of a.keys()) if (!b.has(p)) c.removed.push(p);
  for (const k of ['added', 'changed', 'removed'] as const) c[k] = c[k].sort().slice(0, MAX_CHANGED);
  return c;
}

// ------------------------------------------------------------------------------------------------
// running it
// ------------------------------------------------------------------------------------------------

export interface JobResult {
  id: string;
  /** False when nothing was launched (cancelled first, or the copy could not be made). */
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  changed: JobChanges;
  fence: JobFence;
  fenceLabel: string;
  isolated: boolean;
  snapshot: SnapshotInfo;
  ms: number;
  /** True only after the run folder was verified gone. */
  deleted: boolean;
  /** Why nothing ran (a copy refusal). */
  error?: string;
}

export interface RunJobOptions {
  /** The folder to snapshot (already resolved and checked by the caller). */
  sourceDir: string;
  /** Where run folders live: `<data>/cache/plugin-jobs`. */
  cacheDir: string;
  fence: JobFence;
  signal: AbortSignal;
  execPath?: string;
  /** Source `workspace` under bubblewrap: its dependency folders, bound read-only. */
  depsFrom?: string;
  onStart?: (pid: number) => void;
}

function npmCli(execPath: string): string | undefined {
  const root = dirname(dirname(execPath));
  for (const c of [join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (existsSync(c)) return c;
  return undefined;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function removeRun(dir: string): boolean {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a file still held (Windows): retried */
    }
    if (!existsSync(dir)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return !existsSync(dir);
}

/** Runs one checked plan. Never throws for the command's own failure: the result says what happened. */
export async function runJob(plan: JobPlan, o: RunJobOptions): Promise<JobResult> {
  const t0 = Date.now();
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(o.cacheDir, id);
  const ws = join(runDir, 'ws');
  const tmp = join(runDir, 'tmp');
  const execPath = o.execPath ?? process.execPath;
  const res: JobResult = { id, started: false, exitCode: null, signal: null, timedOut: false, cancelled: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, changed: { added: [], changed: [], removed: [] }, fence: o.fence, fenceLabel: FENCE_LABELS[o.fence], isolated: o.fence === 'bwrap', snapshot: { files: 0, bytes: 0, skipped: 0 }, ms: 0, deleted: false };
  const finish = () => {
    res.deleted = removeRun(runDir);
    res.ms = Date.now() - t0;
    return res;
  };
  if (o.signal.aborted) {
    res.cancelled = true;
    res.deleted = true;
    res.ms = Date.now() - t0;
    return res;
  }
  try {
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    res.snapshot = snapshotCopy(o.sourceDir, ws);
  } catch (err) {
    res.error = err instanceof JobRefused ? err.message : `The copy could not be made: ${(err as Error).message}`;
    return finish();
  }
  const cwdAbs = plan.cwd === '.' ? ws : join(ws, ...plan.cwd.split('/'));
  if (!existsSync(cwdAbs) || !lstatSync(cwdAbs).isDirectory()) {
    res.error = `The folder "${plan.cwd}" isn't in the copy.`;
    return finish();
  }
  const before = hashTree(ws);
  let file: string;
  let args: string[];
  let env: Record<string, string>;
  const cpuLimit = `ulimit -t ${plan.cpuS} 2>/dev/null; ulimit -f 4194304 2>/dev/null; ulimit -c 0 2>/dev/null`;
  if (o.fence === 'bwrap') {
    // Node inside: under /usr as is, Sara's private runtime at RUNTIME_MOUNT, else its folder read-only.
    const root = dirname(dirname(execPath));
    const binds: Bind[] = [];
    let inner = execPath;
    if (!root.startsWith('/usr')) {
      if (runtimeMountArgs(execPath).length) inner = posix.join(RUNTIME_MOUNT, 'bin', 'node');
      else binds.push({ src: root, dest: root });
    }
    if (plan.source === 'workspace' && o.depsFrom) {
      for (const e of readdirSync(o.depsFrom, { withFileTypes: true })) if (e.isDirectory() && SANDBOX_HEAVY.has(e.name)) binds.push({ src: join(o.depsFrom, e.name), dest: `/workspace/${e.name}` });
    }
    let argv: string[] = [inner, ...plan.args];
    if (plan.program === 'npm') {
      const cli = npmCli(execPath);
      if (!cli) {
        res.error = 'npm was not found beside Sara\'s Node.';
        return finish();
      }
      argv = [inner, cli.startsWith(root) && inner !== execPath ? posix.join(RUNTIME_MOUNT, cli.slice(root.length).split('\\').join('/')) : cli, ...plan.args];
    }
    const innerCwd = plan.cwd === '.' ? '/workspace' : `/workspace/${plan.cwd}`;
    file = 'bwrap';
    args = [...bwrapArgs(ws, plan.network, binds), '--setenv', 'TMPDIR', '/tmp', '--', '/bin/sh', '-c', `${cpuLimit}; cd "$1" || exit 126; shift; exec "$@"`, 'sara-job', innerCwd, ...argv];
    env = { PATH: `${posix.dirname(inner)}:/usr/local/bin:/usr/bin:/bin`, HOME: '/workspace', TMPDIR: '/tmp', LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', ...(plan.network ? {} : PRIVATE_LOCAL_ENV) };
  } else {
    // The Node permission model: reads and writes only in the copy and this run's temp folder.
    const nodeArgs = [...plan.args];
    if (nodeArgs.includes('--test') && !nodeArgs.some((a) => a.startsWith('--test-isolation='))) nodeArgs.unshift('--test-isolation=none');
    file = execPath;
    args = ['--permission', `--allow-fs-read=${ws}`, `--allow-fs-read=${tmp}`, `--allow-fs-write=${ws}`, `--allow-fs-write=${tmp}`, '--max-old-space-size=512', '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning', ...nodeArgs];
    env = { PATH: dirname(execPath), HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}), ...(plan.network ? {} : PRIVATE_LOCAL_ENV) };
  }
  const cap = plan.maxOutputKB * 1024;
  const out: { buf: Buffer[]; n: number; cut: boolean }[] = [{ buf: [], n: 0, cut: false }, { buf: [], n: 0, cut: false }];
  await new Promise<void>((done) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: o.fence === 'bwrap' ? ws : cwdAbs, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      res.error = `It could not start: ${(err as Error).message}`;
      done();
      return;
    }
    res.started = true;
    if (child.pid) o.onStart?.(child.pid);
    const take = (k: 0 | 1) => (b: Buffer) => {
      const s = out[k];
      if (s.n >= cap) {
        s.cut = true;
        return;
      }
      const part = b.subarray(0, cap - s.n);
      if (part.length < b.length) s.cut = true;
      s.buf.push(part);
      s.n += part.length;
    };
    child.stdout!.on('data', take(0));
    child.stderr!.on('data', take(1));
    const stop = (why: 'timeout' | 'cancel') => {
      if (why === 'timeout') res.timedOut = true;
      else res.cancelled = true;
      killTree(child);
    };
    const timer = setTimeout(() => stop('timeout'), plan.timeoutS * 1000);
    const onAbort = () => stop('cancel');
    o.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      res.error = `It could not start: ${err.message}`;
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      res.exitCode = code;
      res.signal = sig;
      done();
    });
  });
  res.stdout = Buffer.concat(out[0].buf).toString('utf8');
  res.stderr = Buffer.concat(out[1].buf).toString('utf8');
  res.stdoutTruncated = out[0].cut;
  res.stderrTruncated = out[1].cut;
  res.changed = diff(before, hashTree(ws));
  return finish();
}

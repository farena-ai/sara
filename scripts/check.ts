// `npm run check`: the typecheck, then the tests, with one check at a time per folder.
// Two checks in one worktree share the test files' temp names, the caches and (when both were sent
// to the same file) the log, and the counts of one can then be read as the other's. That happened in
// 3.41.0. A lock file in outputs/ holds this process's id while the check runs. A second check in
// the same folder stops at once with one plain line. A lock left by a process that is gone is ignored.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CheckLock {
  pid: number;
  started: string;
}

/** True while a process with this id exists (signal 0 sends nothing; it works on Windows too). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file: string): CheckLock | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<CheckLock>;
    return typeof v.pid === 'number' ? { pid: v.pid, started: String(v.started ?? '') } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock, or says who holds it. The file is made with "wx" (fails when it is there), so two
 * checks that start together can't both get it.
 */
export function takeLock(file: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): { ok: true } | { ok: false; holder: CheckLock } {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid, started: new Date().toISOString() })}\n`, { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readLock(file);
    if (holder && holder.pid !== pid && alive(holder.pid)) return { ok: false, holder };
    // Stale (its process is gone), unreadable, or our own from before: remove it and try again.
    rmSync(file, { force: true });
  }
  return { ok: false, holder: readLock(file) ?? { pid: 0, started: '' } };
}

/** Removes the lock only when it is this process's. */
export function releaseLock(file: string, pid = process.pid): void {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}

export function refusal(file: string, holder: CheckLock): string {
  return `Another check is running in this folder (process ${holder.pid}${holder.started ? `, started ${holder.started}` : ''}). Wait for it to end, or run this one in another worktree. If that process is gone, delete ${file}.`;
}

let running: ReturnType<typeof spawn> | undefined;

function step(command: string, cwd: string): Promise<number> {
  return new Promise((done) => {
    const p = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    running = p;
    p.on('error', () => done(1));
    p.on('exit', (code) => done(code ?? 1));
  });
}

export async function runCheck(steps: string[], lockFile: string, cwd: string): Promise<number> {
  const got = takeLock(lockFile);
  if (!got.ok) {
    console.error(refusal(lockFile, got.holder));
    return 1;
  }
  const release = () => releaseLock(lockFile);
  process.on('exit', release);
  // Ctrl+C reaches the step too (same terminal). For a plain kill, pass it on as well as we can.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => (running?.kill(), process.exit(130)));
  try {
    for (const s of steps) {
      const code = await step(s, cwd);
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // --lock=<file> and --steps=<a;;b> are for the test of this file.
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const steps = arg('steps')?.split(';;') ?? ['npm run typecheck', 'npm test'];
  process.exitCode = await runCheck(steps, arg('lock') ?? join(root, 'outputs', 'check.lock'), root);
}

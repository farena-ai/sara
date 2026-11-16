// T3 (docs/SELF_CODE.md): the restart runner for a code change she applied to her own source folder.
// Sara starts it as a separate process (src/self-code.ts restartRunner) and then shuts herself down:
//   node self-code-runner.ts <plan.json>
// It waits until the old process is gone, starts her again the way she was started (same Node, same
// arguments, same folder, same environment), waits for /api/health (and /api/health/ready when it was
// fine before), and when she doesn't come up within the limit (or comes up worse) puts the snapshot of
// the changed files back and starts her again. The outcome lands in plan.resultFile, which she reads
// when she starts (SelfCode.finish). Under `node --watch` the watcher restarts her on the file change,
// so the runner only waits and checks. Node built-ins only; protected (src/self-code.ts PROTECTED_PATHS).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunnerPlan {
  kind: 'apply' | 'undo' | 'reapply';
  /** The change(s) this restart is for (one, or the re-applied queue). */
  ids: number[];
  root: string;
  /** The snapshot: files/<path> copies plus manifest.json (version, files that existed). */
  snapshotDir: string;
  files: { path: string; existed: boolean }[];
  resultFile: string;
  timeoutMs: number;
  port: number;
  pid: number;
  node: string;
  args: string[];
  cwd: string;
  mode: 'relaunch' | 'watch';
  /** /api/health/ready answered 200 before the change: it must again ("health worse" otherwise). */
  baselineReady: boolean;
  logFile: string;
}

export interface RunnerResult {
  state: 'restarting' | 'applied' | 'undone' | 'rolledback' | 'failed';
  message: string;
  at: string;
  kind: RunnerPlan['kind'];
  ids: number[];
}

/** The steps that touch processes (seams for the tests). */
export interface RunnerDriver {
  waitGone(pid: number): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  probe(): Promise<{ up: boolean; ready: boolean }>;
  sleep(ms: number): Promise<void>;
}

/** Puts the snapshot's files back (and removes files the change created). */
export function restoreSnapshot(plan: Pick<RunnerPlan, 'root' | 'snapshotDir' | 'files'>): void {
  for (const f of plan.files) {
    const live = join(plan.root, f.path);
    if (f.existed) {
      mkdirSync(dirname(live), { recursive: true });
      copyFileSync(join(plan.snapshotDir, 'files', f.path), live);
    } else rmSync(live, { force: true });
  }
}

const within = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

/** Restarts, health-checks and, when she doesn't come up properly, puts the snapshot back. */
export async function runPlan(plan: RunnerPlan, driver: RunnerDriver, now: () => Date = () => new Date()): Promise<RunnerResult> {
  const write = (state: RunnerResult['state'], message: string): RunnerResult => {
    const r: RunnerResult = { state, message, at: now().toISOString(), kind: plan.kind, ids: plan.ids };
    mkdirSync(dirname(plan.resultFile), { recursive: true });
    writeFileSync(plan.resultFile, `${JSON.stringify(r, null, 2)}\n`);
    return r;
  };
  const comesUp = async () => {
    // Counted in probes (one every 2 s), so a test's instant sleep doesn't spin for minutes.
    const tries = Math.max(1, Math.ceil(plan.timeoutMs / 2000));
    for (let i = 0; ; i++) {
      const p = await driver.probe().catch(() => ({ up: false, ready: false }));
      if (p.up && (p.ready || !plan.baselineReady)) return true;
      if (i >= tries) return false;
      await driver.sleep(2000);
    }
  };
  write('restarting', 'Restarting with the change…');
  let why = '';
  try {
    await driver.waitGone(plan.pid);
    await driver.start();
    if (await comesUp()) return write(plan.kind === 'undo' ? 'undone' : 'applied', plan.kind === 'undo' ? 'The change was taken out and she restarted fine.' : 'The change is in and she restarted fine.');
    why = `She didn't start properly within ${within(plan.timeoutMs)} after the change`;
  } catch (err) {
    why = `Restarting failed (${String((err as Error).message).split('\n')[0]})`;
  }
  try {
    await driver.stop();
    restoreSnapshot(plan);
    await driver.start();
    if (await comesUp()) return write('rolledback', `${why}, so she went back to the files she had and restarted.`);
  } catch {
    /* reported below */
  }
  return write('failed', `${why}, and going back didn't start her either. The old files are in ${plan.snapshotDir}.`);
}

async function probeAt(port: number): Promise<{ up: boolean; ready: boolean }> {
  const get = async (path: string) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
      await r.arrayBuffer();
      return r.status;
    } catch {
      return 0;
    }
  };
  const up = (await get('/api/health')) === 200;
  return { up, ready: up && (await get('/api/health/ready')) === 200 };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The real driver: starts her detached, as she was started. */
export function realDriver(plan: RunnerPlan): RunnerDriver {
  let child = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    sleep,
    probe: () => probeAt(plan.port),
    async waitGone(pid) {
      if (plan.mode === 'watch') return;
      const end = Date.now() + 60_000;
      while (alive(pid) && Date.now() < end) await sleep(500);
      if (alive(pid)) process.kill(pid);
      await sleep(1000);
    },
    async start() {
      if (plan.mode === 'watch') return;
      mkdirSync(dirname(plan.logFile), { recursive: true });
      const out = openSync(plan.logFile, 'a');
      const c = spawn(plan.node, plan.args, { cwd: plan.cwd, detached: true, stdio: ['ignore', out, out], env: process.env, windowsHide: true });
      child = c.pid ?? 0;
      c.unref();
    },
    async stop() {
      if (plan.mode === 'watch' || !child) return;
      if (alive(child)) process.kill(child);
      const end = Date.now() + 20_000;
      while (alive(child) && Date.now() < end) await sleep(300);
      child = 0;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  const file = process.argv[2];
  const plan = JSON.parse(readFileSync(file, 'utf8')) as RunnerPlan;
  if (existsSync(file)) rmSync(file, { force: true });
  const r = await runPlan(plan, realDriver(plan));
  process.exit(r.state === 'failed' ? 1 : 0);
}

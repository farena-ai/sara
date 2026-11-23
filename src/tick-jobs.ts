// X0: the jobs that ride the reminder tick (src/reminders.ts), each run on its own. One job that
// throws (a locked database, a bad row) no longer stops the jobs after it on every tick, and each
// job keeps a small record (last run, last error, how long it took) for the doctor and Readiness.
// No timers here: the tick calls tickJob() for each job in order.

export interface TickJobStatus {
  name: string;
  runs: number;
  failures: number;
  /** Failures in a row (0 after a good run). */
  failing: number;
  lastRunAt?: string;
  lastOkAt?: string;
  lastError?: string;
  lastMs: number;
  maxMs: number;
}

const jobs = new Map<string, TickJobStatus>();
/** A failing job is logged on its 1st, 2nd, 4th, 8th ... failure in a row, then about hourly, not every 15 seconds. */
const shouldLog = (n: number): boolean => n <= 2 || (n & (n - 1)) === 0 || n % 240 === 0;

function failed(s: TickJobStatus, err: unknown): void {
  s.failures++;
  s.failing++;
  s.lastError = String((err as Error)?.message ?? err).slice(0, 300);
  if (shouldLog(s.failing)) console.warn(`${s.name}: ${s.lastError}${s.failing > 2 ? ` (${s.failing} times in a row)` : ''}`);
}

/** Runs one job of the tick. Never throws; a rejected promise is recorded the same way. */
export function tickJob(name: string, fn: () => unknown, clock: () => number = Date.now): void {
  let s = jobs.get(name);
  if (!s) jobs.set(name, (s = { name, runs: 0, failures: 0, failing: 0, lastMs: 0, maxMs: 0 }));
  const st = s;
  const t0 = clock();
  st.runs++;
  st.lastRunAt = new Date(t0).toISOString();
  const ok = () => {
    st.failing = 0;
    st.lastOkAt = new Date(clock()).toISOString();
  };
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(ok, (err) => failed(st, err));
    else ok();
  } catch (err) {
    failed(st, err);
  } finally {
    st.lastMs = clock() - t0;
    if (st.lastMs > st.maxMs) st.maxMs = st.lastMs;
  }
}

/** Every job seen since the server started, in the order it first ran. */
export function tickJobStatus(): TickJobStatus[] {
  return [...jobs.values()].map((s) => ({ ...s }));
}

/** Jobs that failed on their latest run. */
export function tickJobsFailing(): TickJobStatus[] {
  return tickJobStatus().filter((s) => s.failing > 0);
}

/** Tests: start from nothing. */
export function resetTickJobs(): void {
  jobs.clear();
}

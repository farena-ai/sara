// X0: the jobs that ride the reminder tick (src/reminders.ts), each run on its own. One job that
// throws (a locked database, a bad row) no longer stops the jobs after it on every tick, and each
// job keeps a small record (last run, last error, how long it took) for the doctor and Readiness.
// The reminder tick calls tickJob() for each job in order. D2: workers with a period of their own
// use everyJob() below, which keeps the same record and owns the timer.

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
  /** everyJob(): rounds left out because the last one was still running. */
  skipped?: number;
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

export interface EveryJob {
  /** Runs no more rounds (a round already running finishes). */
  stop(): void;
}

/**
 * D2: runs `fn` every `everyMs` (first round after one period, like setInterval). A round that is
 * still running when the next is due makes that one skip, so rounds never overlap. A failure is
 * logged as "name: message" every time (as guard() in src/log.ts did) and kept in the record; the
 * next round runs as usual. The timer never keeps the process alive.
 */
export function everyJob(name: string, everyMs: number, fn: () => unknown, clock: () => number = Date.now): EveryJob {
  let busy = false;
  let stopped = false;
  const st = jobs.get(name) ?? { name, runs: 0, failures: 0, failing: 0, lastMs: 0, maxMs: 0 };
  jobs.set(name, st);
  const t0 = { at: 0 };
  const settle = (err?: unknown, failedRun = false) => {
    busy = false;
    st.lastMs = clock() - t0.at;
    if (st.lastMs > st.maxMs) st.maxMs = st.lastMs;
    if (failedRun) {
      st.failures++;
      st.failing++;
      const msg = (err as Error)?.message ?? err;
      st.lastError = String(msg).slice(0, 300);
      console.warn(`${name}: ${msg}`);
    } else {
      st.failing = 0;
      st.lastOkAt = new Date(clock()).toISOString();
    }
  };
  const round = () => {
    if (stopped) return;
    if (busy) {
      st.skipped = (st.skipped ?? 0) + 1;
      return;
    }
    busy = true;
    t0.at = clock();
    st.runs++;
    st.lastRunAt = new Date(t0.at).toISOString();
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(() => settle(), (err) => settle(err, true));
      else settle();
    } catch (err) {
      settle(err, true);
    }
  };
  const timer = setInterval(round, everyMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
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

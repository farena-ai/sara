// Windows: the system process list (PowerShell + WMI), used to follow a job's process tree (previews,
// tunnels) and to find what a sandbox try left running. Shared so every caller copes with a busy PC
// the same way:
// - On a loaded PC PowerShell alone takes 15-25 s to answer. Each try gets the rest of one shared
//   deadline instead of a short cut-off of its own: cutting a slow but good answer and asking again
//   only made it slower (three 20 s cut-offs took a minute and still came back empty).
// - WMI now and then answers "Call cancelled" or "Quota violation" part-way through (a cut list). A
//   complete list always has this process in it, so a list without it is asked for again.
// Anything that can't be read in time is an empty list: callers then treat nothing as owned or born.
import { execFile, spawn } from 'node:child_process';

export interface WinProcess {
  pid: number;
  ppid: number;
  /** Creation time (ms since 1970), when asked for; otherwise NaN. */
  createdMs: number;
}

/** The most one complete list may take, retries included (a loaded PC is slow, not wrong). */
export const WIN_PROCESS_LIST_MS = 60_000;

const ask = (script: string, timeoutMs: number, signal?: AbortSignal): Promise<string> =>
  new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });

/** Parses "pid ppid [createdMs]" lines; other lines (errors, blanks) are skipped. */
export function parseWinProcesses(text: string, withCreation: boolean): WinProcess[] {
  const out: WinProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = (withCreation ? /^(\d+) (\d+) (-?\d+)$/ : /^(\d+) (\d+)$/).exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdMs: withCreation ? Number(m[3]) : NaN });
  }
  return out;
}

/**
 * Every process with its parent (and, with `withCreation`, its creation time). Complete or empty:
 * a cut list is asked for again until `deadlineMs` runs out. Only the needed fields are asked for,
 * which keeps the WMI query small (it fails far less often).
 */
export async function windowsProcesses(opts: { withCreation?: boolean; signal?: AbortSignal; deadlineMs?: number } = {}): Promise<WinProcess[]> {
  const withCreation = opts.withCreation === true;
  const script = withCreation
    ? "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"
    : "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }";
  const deadline = Date.now() + (opts.deadlineMs ?? WIN_PROCESS_LIST_MS);
  for (let i = 0; !opts.signal?.aborted && deadline - Date.now() > 2000; i++) {
    if (i) await new Promise((r) => setTimeout(r, 300 * Math.min(i, 3)));
    const rows = parseWinProcesses(await ask(script, Math.max(1000, deadline - Date.now()), opts.signal), withCreation);
    if (rows.some((r) => r.pid === process.pid)) return rows;
  }
  return [];
}

/**
 * Ends a process and everything it started (taskkill /T). On a loaded PC taskkill can take 15-25 s
 * and sometimes gives up, so it gets a long limit, and when it fails the process itself is ended
 * directly (never first: taskkill /T needs it alive to find its children). Resolves when done.
 */
export function killTreeWindows(pid: number, timeoutMs = 60_000): Promise<void> {
  const direct = () => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) direct();
      resolve();
    };
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      tk.kill();
      finish(false);
    }, timeoutMs);
    tk.on('error', () => finish(false));
    tk.on('exit', (code) => finish(code === 0));
  });
}

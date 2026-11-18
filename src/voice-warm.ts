// U5 voice fast (docs/VOICE_FIRST.md "Engines stay loaded"): one long-lived engine process per model
// (deploy/voice/sara-voice-worker.c), so hearing and her voice skip the model load on every call.
// Line protocol over stdin/stdout, nothing on the network. Jobs run one at a time per worker.
// Lifecycle: started on first use (or when Talk opens), stopped after the idle time, killed when a
// job takes too long, restarted on the next job after a crash; three failures within 5 minutes pause
// it for 10 minutes. It won't start when the machine is low on memory. Every failure throws, and the
// caller (LocalVoiceEngine) falls back to the one-shot tools.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { freemem } from 'node:os';

export type WarmState = 'stopped' | 'starting' | 'ready' | 'broken';
export interface WorkerSpec {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}
export interface WarmOptions {
  /** Stop after this long without a job (read on every job; 0 = stop right after it). */
  idleMs: () => number;
  startTimeoutMs?: number;
  jobTimeoutMs?: number;
  /** Memory guard: don't start a worker with less free memory than this (MB). */
  minFreeMb?: number;
  freeMemMb?: () => number;
  /** Start a fresh process after this many jobs (keeps a slow leak bounded). */
  maxJobs?: number;
  now?: () => number;
}

export class WarmError extends Error {}

const FAIL_WINDOW = 5 * 60_000;
const PAUSE = 10 * 60_000;

export class WarmWorker {
  readonly #spec: () => WorkerSpec;
  readonly #o: Required<WarmOptions>;
  #p: ChildProcessWithoutNullStreams | undefined;
  #ready: Promise<void> | undefined;
  #buf = '';
  #waiting: { resolve: (s: string) => void; reject: (e: Error) => void } | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #idle: NodeJS.Timeout | undefined;
  #jobs = 0;
  #fails: number[] = [];
  #pausedUntil = 0;
  #starting = false;

  constructor(spec: () => WorkerSpec, opts: WarmOptions) {
    this.#spec = spec;
    this.#o = { startTimeoutMs: 30_000, jobTimeoutMs: 60_000, minFreeMb: 512, freeMemMb: () => freemem() / 1048576, maxJobs: 2000, now: Date.now, ...opts };
  }

  get state(): WarmState {
    if (this.#pausedUntil > this.#o.now()) return 'broken';
    if (!this.#p) return 'stopped';
    return this.#starting ? 'starting' : 'ready';
  }

  /** Loads the model now (Talk opened); resolves when it's ready, rejects like `ask`. */
  start(): Promise<void> {
    return this.#run(async () => {
      await this.#ensure();
      this.#arm();
    });
  }

  /** Sends one job line; resolves with the text after "ok ". */
  ask(line: string, timeoutMs = this.#o.jobTimeoutMs): Promise<string> {
    return this.#run(async () => {
      await this.#ensure();
      try {
        return await this.#line(`${line.replace(/[\r\n]+/g, ' ')}\n`, timeoutMs, 'took too long', false);
      } finally {
        if (++this.#jobs >= this.#o.maxJobs) this.stop();
        this.#arm();
      }
    });
  }

  stop(): void {
    clearTimeout(this.#idle);
    const p = this.#p;
    this.#p = undefined;
    this.#ready = undefined;
    this.#starting = false;
    this.#jobs = 0;
    const w = this.#waiting;
    this.#waiting = undefined;
    w?.reject(new WarmError('The voice engine stopped.'));
    if (p && p.exitCode === null) {
      p.stdin.end();
      p.kill();
    }
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #arm(): void {
    clearTimeout(this.#idle);
    if (!this.#p) return;
    const ms = this.#o.idleMs();
    if (ms <= 0) return this.stop();
    this.#idle = setTimeout(() => this.stop(), ms);
    this.#idle.unref();
  }

  #fail(err: Error): never {
    const now = this.#o.now();
    this.#fails = [...this.#fails.filter((t) => now - t < FAIL_WINDOW), now];
    if (this.#fails.length >= 3) {
      this.#pausedUntil = now + PAUSE;
      this.#fails = [];
    }
    throw err;
  }

  async #ensure(): Promise<void> {
    if (this.#pausedUntil > this.#o.now()) throw new WarmError('The voice engine is paused after repeated failures.');
    if (this.#p && this.#ready) return this.#ready;
    if (this.#o.freeMemMb() < this.#o.minFreeMb) throw new WarmError('Not enough free memory to keep the voice engine loaded.');
    const s = this.#spec();
    const p = spawn(s.cmd, s.args, { env: s.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#p = p;
    this.#starting = true;
    this.#buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => this.#data(d));
    p.stderr.resume(); // sherpa logs its config on stderr; not needed
    p.stdin.on('error', () => undefined);
    const gone = (why: string) => {
      if (this.#p !== p) return; // stopped on purpose; its job was already answered
      this.#p = undefined;
      this.#ready = undefined;
      this.#starting = false;
      clearTimeout(this.#idle);
      const w = this.#waiting;
      this.#waiting = undefined;
      w?.reject(new WarmError(why));
    };
    p.on('error', (e) => gone(`The voice engine could not start (${(e as NodeJS.ErrnoException).code ?? e.message}).`));
    p.on('exit', (code) => gone(`The voice engine stopped (exit ${code}).`));
    this.#ready = this.#line('', this.#o.startTimeoutMs, 'did not load in time', true).then(
      () => void (this.#starting = false),
      (e: Error) => {
        this.stop();
        throw e;
      },
    );
    return this.#ready;
  }

  #data(d: string): void {
    this.#buf += d;
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).replace(/\r$/, '');
      this.#buf = this.#buf.slice(i + 1);
      const w = this.#waiting;
      this.#waiting = undefined;
      if (!w) continue;
      if (line === 'ready' || line.startsWith('ok')) w.resolve(line.replace(/^(ready|ok) ?/, ''));
      else w.reject(new WarmError(line.replace(/^(err|fail) ?/, '') || 'The voice engine failed.'));
    }
  }

  /** Writes `send` (or nothing) and waits for the next answer line. */
  #line(send: string, timeoutMs: number, slow: string, starting: boolean): Promise<string> {
    const p = this.#p;
    if (!p) return Promise.reject(new WarmError('The voice engine stopped.'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = undefined;
        this.stop();
        reject(new WarmError(`The voice engine ${slow}.`));
      }, timeoutMs);
      this.#waiting = {
        resolve: (s) => (clearTimeout(timer), resolve(s)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      if (send) p.stdin.write(send);
    }).catch((e: Error) => {
      // A crash or a hang counts toward the pause; a plain "err" answer (bad input) doesn't.
      if (starting || this.#p !== p) this.#fail(e);
      throw e;
    });
  }
}

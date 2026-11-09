// Phase 30: Sara's own log file. Everything she prints still goes to the console (the system
// journal on a server, `docker logs` in Docker); a copy goes to <data>/logs/sara.log as one JSON
// object per line, with secrets hidden, rotated at 5 MB (5 old files kept). Settings → Data &
// health shows recent problems from it and offers it as a download.
// Phase 63: options for servers, from the environment (docs/INSTALL.md → Logs):
//   SARA_LOG_FORMAT  text (default, as before) | json: the console gets one JSON object per line
//   SARA_LOG_LEVEL   debug | info (default) | warn | error: quieter lines are left out everywhere
//   SARA_LOG_FILE    an extra log file (in SARA_LOG_FORMAT), rotated in-process at
//   SARA_LOG_MAX_MB  (default 10) keeping SARA_LOG_KEEP older files (default 5)
// Every line, wherever it goes, has known secrets and key-shaped values hidden first. Message
// contents are never logged (docs/PRIVACY.md → Logs).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { format } from 'node:util';

export const LOG_DIR = 'logs';
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 5;
const MSG_LIMIT = 4000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogLine {
  t: string;
  level: LogLevel;
  msg: string;
}

export interface LogOptions {
  format: 'text' | 'json';
  level: LogLevel;
  /** Extra log file (absolute, or relative to the working folder). */
  file?: string;
  maxBytes: number;
  keep: number;
  /** SARA_LOG_LEVEL was set: it wins over the level saved in Settings → Data & health. */
  levelFromEnv?: boolean;
}

/** Reads the SARA_LOG_* settings; anything unknown or out of range falls back to the default. */
export function logOptions(env: Record<string, string | undefined> = process.env): LogOptions {
  const fmt = env.SARA_LOG_FORMAT?.trim().toLowerCase();
  const lvl = env.SARA_LOG_LEVEL?.trim().toLowerCase() as LogLevel | undefined;
  const mb = Number(env.SARA_LOG_MAX_MB);
  const keep = Number(env.SARA_LOG_KEEP);
  return {
    format: fmt === 'json' ? 'json' : 'text',
    level: lvl && LOG_LEVELS.includes(lvl) ? lvl : 'info',
    ...(env.SARA_LOG_FILE?.trim() ? { file: resolve(env.SARA_LOG_FILE.trim()) } : {}),
    maxBytes: Math.round((env.SARA_LOG_MAX_MB && Number.isFinite(mb) && mb >= 1 && mb <= 10_000 ? mb : 10) * 1024 * 1024),
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 50 ? keep : 5,
    ...(lvl && LOG_LEVELS.includes(lvl) ? { levelFromEnv: true } : {}),
  };
}

/** Long token-like values (owner token, keys) are never written, whatever printed them. */
export function hideTokens(s: string): string {
  return s.replace(/(?<![\w-])[A-Za-z0-9_-]{40,}(?![\w-])/g, '[hidden]').replace(/\b(sk|xai|ghp|github_pat|gho)[-_][\w-]{12,}/g, '[hidden]');
}

/** One line as text: `2026-10-28T12:00:00.000Z WARN  message`. */
export const textLine = (l: LogLine) => `${l.t} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`;

/**
 * A file that is appended to and rotated, before a line would take it past `maxBytes`:
 * file → file.1 → … → file.<keep>, the oldest dropped. Its size is read from disk each time, so a
 * file someone emptied or moved away is noticed.
 */
export class RotatingFile {
  readonly path: string;
  readonly #max: number;
  readonly #keep: number;

  constructor(path: string, maxBytes: number, keep: number) {
    this.path = path;
    this.#max = maxBytes;
    this.#keep = keep;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(line: string): void {
    try {
      const size = existsSync(this.path) ? statSync(this.path).size : 0;
      if (size > 0 && size + Buffer.byteLength(line) > this.#max) this.#rotate();
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      /* a full disk must not stop Sara */
    }
  }

  #rotate(): void {
    rmSync(`${this.path}.${this.#keep}`, { force: true });
    for (let i = this.#keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    renameSync(this.path, `${this.path}.1`);
  }
}

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;

export class Log {
  readonly file: string;
  readonly options: LogOptions;
  readonly #own: RotatingFile;
  readonly #extra: RotatingFile | undefined;
  readonly #redact: (s: string) => string;
  readonly #now: () => Date;
  /** Problems (warn/error) since start, for the health history. */
  problems = 0;

  constructor(dataDir: string, redact: (s: string) => string = (s) => s, now: () => Date = () => new Date(), options: LogOptions = logOptions({})) {
    const dir = join(dataDir, LOG_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'sara.log');
    this.options = options;
    this.#own = new RotatingFile(this.file, MAX_BYTES, KEEP);
    this.#extra = options.file && resolve(options.file) !== resolve(this.file) ? new RotatingFile(options.file, options.maxBytes, options.keep) : undefined;
    this.#redact = redact;
    this.#now = now;
  }

  #level: LogLevel | undefined;

  /** The level in force: SARA_LOG_LEVEL if set, else the one saved in Settings, else info. */
  get level(): LogLevel {
    return this.#level ?? this.options.level;
  }

  /** The level saved in Settings → Data & health (ignored while SARA_LOG_LEVEL is set). */
  useSaved(level: LogLevel | undefined): void {
    this.#level = !this.options.levelFromEnv && level && LOG_LEVELS.includes(level) ? level : undefined;
  }

  /** True when lines of this level are kept. */
  wants(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.level);
  }

  /** The line as it is written everywhere (secrets hidden, length capped), or null when filtered out. */
  line(level: LogLevel, msg: string): LogLine | null {
    if (!this.wants(level)) return null;
    return { t: this.#now().toISOString(), level, msg: hideTokens(this.#redact(msg)).slice(0, MSG_LIMIT) };
  }

  /** The console form of a line: the message alone (text, as before) or one JSON object (json). */
  consoleText(l: LogLine): string {
    return this.options.format === 'json' ? JSON.stringify(l) : l.msg;
  }

  /** Writes a line to the log files (not the console). */
  write(level: LogLevel, msg: string): LogLine | null {
    const line = this.line(level, msg);
    if (line) this.#store(line);
    return line;
  }

  #store(line: LogLine): void {
    if (line.level === 'warn' || line.level === 'error') this.problems++;
    this.#own.write(`${JSON.stringify(line)}\n`);
    this.#extra?.write(`${this.options.format === 'json' ? JSON.stringify(line) : textLine(line)}\n`);
  }

  /** The newest lines (optionally only warnings and errors), newest first. */
  recent(opts: { problems?: boolean; limit?: number } = {}): LogLine[] {
    const out: LogLine[] = [];
    for (const f of [this.file, `${this.file}.1`]) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        try {
          const x = JSON.parse(l) as LogLine;
          if (!opts.problems || x.level === 'warn' || x.level === 'error') out.push(x);
        } catch {
          /* a torn line */
        }
        if (out.length >= (opts.limit ?? 50)) return out;
      }
    }
    return out;
  }

  /** The whole current log as plain text, for download. */
  text(): string {
    return this.recent({ limit: 20_000 }).reverse().map(textLine).join('\n');
  }

  /**
   * Routes console.log/info/debug/warn/error through the log: filtered by level, secrets hidden,
   * printed as text (as before) or as JSON lines, and copied to the log files.
   */
  captureConsole(target: ConsoleLike = console): void {
    for (const [method, level] of [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error']] as const) {
      const orig = target[method].bind(target);
      target[method] = (...args: unknown[]) => {
        const line = this.line(level, format(...args));
        if (!line) return;
        orig(this.consoleText(line));
        this.#store(line);
      };
    }
  }
}

/**
 * Runs one round of a background task (a timer tick) so that a failure is logged and the next
 * round still runs, instead of taking the whole server down (a full disk, a locked database).
 */
export function guard(name: string, fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err: Error) => console.warn(`${name}: ${err?.message ?? err}`));
  } catch (err) {
    console.warn(`${name}: ${(err as Error)?.message ?? err}`);
  }
}

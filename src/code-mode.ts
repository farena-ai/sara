// EC21 (docs/ops/EC2122_DESIGN.md): code mode. The model writes a short script against a typed
// tool API; it runs in a fenced child Node (permission model + network guard, inside bubblewrap or
// a container when the sandbox has one) and reaches the world only through Sara's tool calls, which
// the chat runs through its normal per-call path (src/chat.ts `oneCall`). This module is the runner:
// code preparation, the generated API, the child process, the protocol and the caps.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { containerRunArgv, containerUser } from './container.ts';
import { JOB_NET_GUARD, type JobFence } from './plugins/exec-job.ts';
import type { ToolSpec } from './providers/types.ts';
import { bwrapArgs, type Bind, type SandboxInfo } from './tools/sandbox.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const RUN_CODE = 'run_code';
export const MAX_CODE = 20_000;
export const BOOT = join(dirname(fileURLToPath(import.meta.url)), 'code-mode-boot.mjs');

export interface CodeLimits {
  /** Script time (waiting for a tool or an approval does not count). */
  scriptMs: number;
  /** Wall-clock cap for the whole run, approvals included. */
  wallMs: number;
  heapMb: number;
  maxCalls: number;
  resultChars: number;
  logChars: number;
}
export const DEFAULT_LIMITS: CodeLimits = { scriptMs: 30_000, wallMs: 600_000, heapMb: 64, maxCalls: 40, resultChars: 16_000, logChars: 4_000 };

export interface InnerResult {
  status: 'ok' | 'error' | 'denied';
  output: string;
}
export type CodeReason = 'error' | 'timeout' | 'memory' | 'calls' | 'output' | 'cancelled' | 'crashed';
export interface CodeResult {
  ok: boolean;
  result: string;
  logs: string;
  error?: string;
  reason?: CodeReason;
  calls: number;
  fence: JobFence;
  ms: number;
}

export class CodeRefused extends Error {}

/** The script as it will run: TypeScript stripped (types only; enums and namespaces refused). */
export function prepareCode(code: string, lang: 'js' | 'ts' = 'js'): string {
  const src = String(code ?? '');
  if (!src.trim()) throw new CodeRefused('The script is empty.');
  if (src.length > MAX_CODE) throw new CodeRefused(`The script is longer than ${MAX_CODE} characters: split the work or call the tools directly.`);
  if (lang !== 'ts') return src;
  try {
    // Wrapped so a top-level `return` parses; strip mode keeps every position, so the wrapper comes off by length.
    const head = 'async function sara_code() {\n';
    return stripTypeScriptTypes(`${head}${src}\n}`, { mode: 'strip' }).slice(head.length, -2);
  } catch (err) {
    throw new CodeRefused(`This TypeScript can't run as is (only type annotations are removed): ${(err as Error).message.split('\n')[0].slice(0, 200)}`);
  }
}

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

function tsType(s: Schema | undefined, depth = 0): string {
  if (!s || typeof s !== 'object') return 'unknown';
  if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 12) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return `${/[|&]/.test(tsType(s.items, depth + 1)) ? `(${tsType(s.items, depth + 1)})` : tsType(s.items, depth + 1)}[]`;
  if (t === 'object' || s.properties) {
    if (depth > 2 || !s.properties || !Object.keys(s.properties).length) return 'Record<string, unknown>';
    const req = new Set(s.required ?? []);
    return `{ ${Object.entries(s.properties).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsType(v, depth + 1)}`).join('; ')} }`;
  }
  return 'unknown';
}

const API_CAP = 6_000;
/** The typed tool API (TypeScript declarations) for the run_code description, ≤ ~6 000 characters. */
export function toolApi(specs: Pick<ToolSpec, 'name' | 'description' | 'parameters'>[]): string {
  const lines = ['declare const tools: {'];
  let len = lines[0].length;
  const more: string[] = [];
  for (const s of specs) {
    const p = (s.parameters ?? {}) as Schema;
    const opt = !(p.required ?? []).length;
    if (more.length) {
      more.push(s.name);
      continue;
    }
    const full = `  /** ${String(s.description ?? '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').replace(/\*\//g, '* /').split(/(?<=\.)\s/)[0].slice(0, 100)} */\n  ${s.name}(args${opt ? '?' : ''}: ${tsType(p)}): Promise<string>;`;
    if (len + full.length > API_CAP) {
      more.push(s.name);
      continue;
    }
    lines.push(full);
    len += full.length + 1;
  }
  if (more.length) {
    let names = more.join(', ');
    if (names.length > 2_000) names = `${names.slice(0, 2_000).replace(/, [^,]*$/, '')} and more`;
    lines.push(`  // Also (each takes an args object; ask find_tools for a schema): ${names}`, '  [name: string]: (args?: Record<string, unknown>) => Promise<string>;');
  }
  lines.push('};');
  return lines.join('\n');
}

/** The run_code tool's spec for this step: what it does, the rules, and the typed API of the tools offered now. */
export function runCodeSpec(specs: Pick<ToolSpec, 'name' | 'description' | 'parameters'>[]): ToolSpec {
  return {
    name: RUN_CODE,
    description: `Run a short JavaScript or TypeScript script that calls several of your tools in one go and returns only what you need (saves round trips for many reads, lookups or edits). The script is an async function body: use await, return the result (a string or JSON). Every call goes through the owner's normal approvals: a tool that asks waits for the owner; a refused one throws ToolDenied (a failed one ToolFailed), which you may catch. No network or files except through these tools; ${DEFAULT_LIMITS.scriptMs / 1000} s of script time, ${DEFAULT_LIMITS.maxCalls} calls at most. Each tool returns its text result.\n${toolApi(specs)}`,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The script (an async function body using `tools` and `return`).' },
        language: { type: 'string', enum: ['js', 'ts'], description: 'js (default) or ts (types are removed before it runs).' },
        purpose: { type: 'string', description: 'One short line: what the script does (shown to the owner).' },
      },
      required: ['code'],
    },
  };
}

/**
 * The registry entry (Settings lists it; the owner may set it to Ask or Off). The chat runs it
 * itself (src/chat.ts `codeCall`): calling `run` directly is refused.
 */
export function runCodeTool(isOn: () => boolean): Tool {
  return {
    spec: runCodeSpec([]),
    defaultPermission: 'auto',
    source: 'built-in',
    isAvailable: isOn,
    summarize: (a) => `Ran a script${a.purpose ? `: ${String(a.purpose).replace(/\s+/g, ' ').slice(0, 100)}` : ''}`,
    run: async () => {
      throw new ToolError('run_code runs only inside a chat turn.');
    },
  };
}

export interface SpawnPlanInput {
  fence: JobFence;
  /** The run's temp folder holding boot.mjs and guard.mjs. */
  dir: string;
  execPath: string;
  heapMb: number;
  container?: SandboxInfo['container'];
  name?: string;
}

/** How the child starts in each fence (pure: tested on every OS). */
export function codeSpawnPlan(o: SpawnPlanInput): { file: string; args: string[]; env: Record<string, string> } {
  const flags = (root: string, guardUrl: string, boot: string) => ['--permission', `--allow-fs-read=${root}`, `--import=${guardUrl}`, `--max-old-space-size=${o.heapMb}`, '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning', boot];
  const base = { LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' };
  if (o.fence === 'bwrap') {
    const root = dirname(dirname(o.execPath));
    const binds: Bind[] = root.startsWith('/usr') ? [] : [{ src: root, dest: root }];
    return { file: 'bwrap', args: [...bwrapArgs(o.dir, false, binds), '--', o.execPath, ...flags('/workspace', 'file:///workspace/guard.mjs', '/workspace/boot.mjs')], env: { ...base, PATH: '/usr/bin:/bin', HOME: '/workspace' } };
  }
  if (o.fence === 'container' && o.container) {
    const c = o.container;
    const user = containerUser(c);
    const argv = containerRunArgv({ name: o.name ?? `sara-code-${randomBytes(4).toString('hex')}`, image: c.image, workspace: o.dir, network: 'none', env: [], ...(user ? { user } : {}), argv: ['node', ...flags('/workspace', 'file:///workspace/guard.mjs', '/workspace/boot.mjs')] });
    return { file: c.exe, args: [...(c.pre ?? []), argv[0], '-i', ...argv.slice(1)], env: { ...base, PATH: process.env.PATH ?? '' } };
  }
  const env: Record<string, string> = { ...base, PATH: dirname(o.execPath), HOME: o.dir, USERPROFILE: o.dir, TMPDIR: o.dir, TEMP: o.dir, TMP: o.dir };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return { file: o.execPath, args: flags(o.dir, pathToFileURL(join(o.dir, 'guard.mjs')).href, join(o.dir, 'boot.mjs')), env };
}

export type CodeStep = { type: 'call'; id: number; name: string; args: Record<string, unknown> } | { type: 'done'; result: CodeResult };

export interface CodeRunInput {
  code: string;
  lang?: 'js' | 'ts';
  tools: string[];
  limits?: Partial<CodeLimits>;
  signal?: AbortSignal;
  sandbox?: SandboxInfo;
}

const clipTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} more characters cut]` : s);

/**
 * A running script, pulled one step at a time (the chat yields its own events between steps):
 * `next()` gives the next tool call (answer it with `answer()`) or the end.
 */
export class CodeRun {
  readonly fence: JobFence;
  readonly #lim: CodeLimits;
  readonly #child: ChildProcess;
  readonly #dir: string;
  readonly #tag = `\u0001${randomBytes(9).toString('base64url')}\u0002`;
  readonly #queue: CodeStep[] = [];
  #wake: (() => void) | undefined;
  #outstanding = 0;
  #calls = 0;
  #active = 0;
  #last = Date.now();
  readonly #started = Date.now();
  #logs: string[] = [];
  #stderr = '';
  #buf = '';
  #ended = false;
  #reason: CodeReason | undefined;
  #detail = '';
  readonly #timer: NodeJS.Timeout;
  readonly #onAbort: () => void;
  readonly #signal: AbortSignal | undefined;

  constructor(o: CodeRunInput) {
    this.#lim = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
    const code = prepareCode(o.code, o.lang);
    const sb = o.sandbox;
    if (sb?.refuse) throw new CodeRefused(sb.refuse);
    this.fence = sb?.mode === 'bwrap' ? 'bwrap' : sb?.mode === 'container' && sb.container ? 'container' : 'node-only';
    this.#dir = mkdtempSync(join(tmpdir(), 'sara-code-'));
    copyFileSync(BOOT, join(this.#dir, 'boot.mjs'));
    copyFileSync(JOB_NET_GUARD, join(this.#dir, 'guard.mjs'));
    const plan = codeSpawnPlan({ fence: this.fence, dir: this.#dir, execPath: process.execPath, heapMb: this.#lim.heapMb, ...(sb?.container ? { container: sb.container } : {}) });
    this.#child = spawn(plan.file, plan.args, { cwd: this.#dir, env: plan.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stdout!.setEncoding('utf8');
    this.#child.stderr!.setEncoding('utf8');
    this.#child.stdout!.on('data', (d: string) => this.#onOut(d));
    this.#child.stderr!.on('data', (d: string) => {
      if (this.#stderr.length < 8_000) this.#stderr += d;
    });
    this.#child.stdin!.on('error', () => {});
    this.#child.on('error', (err) => this.#end('crashed', `It could not start: ${err.message}`));
    this.#child.on('close', (code, sig) => {
      this.#clean();
      if (this.#ended) return;
      if (/heap out of memory|Allocation failed|ERR_WORKER_OUT_OF_MEMORY/i.test(this.#stderr)) this.#end('memory', `The script used more than ${this.#lim.heapMb} MB of memory and was stopped.`);
      else this.#end('crashed', `The script process ended unexpectedly (${sig ?? `exit ${code}`}). ${this.#stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`.trim());
    });
    this.#send({ type: 'start', tag: this.#tag, code, tools: o.tools });
    this.#timer = setInterval(() => this.#tick(), 50);
    this.#signal = o.signal;
    this.#onAbort = () => this.#end('cancelled', 'Cancelled.');
    if (o.signal?.aborted) this.#onAbort();
    else o.signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  get calls(): number {
    return this.#calls;
  }

  #send(m: unknown): void {
    if (!this.#ended && this.#child.stdin?.writable) this.#child.stdin.write(`${JSON.stringify(m)}\n`);
  }

  #tick(): void {
    const now = Date.now();
    if (this.#outstanding === 0) this.#active += now - this.#last;
    this.#last = now;
    if (this.#active > this.#lim.scriptMs) this.#end('timeout', `The script ran longer than ${this.#lim.scriptMs / 1000} s and was stopped.`);
    else if (now - this.#started > this.#lim.wallMs) this.#end('timeout', `The script took longer than ${Math.round(this.#lim.wallMs / 1000)} s in all and was stopped.`);
  }

  #onOut(d: string): void {
    this.#buf += d;
    if (this.#buf.length > 1_048_576 && !this.#buf.includes('\n')) return this.#end('output', 'The script wrote too much output at once and was stopped.');
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).replace(/\r$/, '');
      this.#buf = this.#buf.slice(i + 1);
      if (!line.startsWith(this.#tag)) {
        this.#log(line);
        continue;
      }
      let m: { type?: string; id?: number; name?: string; args?: Record<string, unknown>; ok?: boolean; result?: string; error?: string; logs?: string };
      try {
        m = JSON.parse(line.slice(this.#tag.length));
      } catch {
        continue;
      }
      if (m.type === 'call' && typeof m.id === 'number') {
        if (this.#calls >= this.#lim.maxCalls) return this.#end('calls', `The script made more than ${this.#lim.maxCalls} tool calls and was stopped.`);
        this.#calls++;
        this.#outstanding++;
        this.#push({ type: 'call', id: m.id, name: String(m.name), args: m.args && typeof m.args === 'object' ? m.args : {} });
      } else if (m.type === 'done') {
        if (m.logs) this.#log(m.logs);
        if (m.ok) this.#finish({ ok: true, result: clipTo(String(m.result ?? ''), this.#lim.resultChars) });
        else this.#finish({ ok: false, reason: 'error', error: String(m.error ?? 'The script failed.').slice(0, 2_000) });
      }
    }
  }

  #log(s: string): void {
    if (s) this.#logs.push(s);
  }

  #push(step: CodeStep): void {
    this.#queue.push(step);
    this.#wake?.();
  }

  #finish(r: { ok: boolean; result?: string; reason?: CodeReason; error?: string }): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#stop();
    this.#push({ type: 'done', result: { ok: r.ok, result: r.result ?? '', logs: clipTo(this.#logs.join('\n'), this.#lim.logChars), ...(r.error ? { error: r.error } : {}), ...(r.reason ? { reason: r.reason } : {}), calls: this.#calls, fence: this.fence, ms: Date.now() - this.#started } });
  }

  #end(reason: CodeReason, error: string): void {
    this.#reason = reason;
    this.#detail = error;
    this.#finish({ ok: false, reason, error });
  }

  #stop(): void {
    clearInterval(this.#timer);
    this.#signal?.removeEventListener('abort', this.#onAbort);
    try {
      this.#child.kill('SIGKILL');
    } catch {
      /* gone */
    }
    // The run's folder goes when the child has closed (Windows keeps open files); this is a fallback.
    setTimeout(() => this.#clean(), 500);
  }

  #clean(): void {
    try {
      rmSync(this.#dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* still in use: the fallback or the OS temp cleanup takes it */
    }
  }

  /** The next tool call the script waits on, or the end. */
  async next(): Promise<CodeStep> {
    for (;;) {
      const s = this.#queue.shift();
      if (s) return s;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }

  /** The result of one call (from the chat's normal call path). */
  answer(id: number, r: InnerResult): void {
    this.#outstanding = Math.max(0, this.#outstanding - 1);
    this.#last = Date.now();
    this.#send({ type: 'result', id, status: r.status, output: r.output });
  }

  /** Stops the script now (the turn ended). */
  cancel(): void {
    if (!this.#ended) this.#end('cancelled', 'Cancelled.');
  }

  get stopped(): { reason?: CodeReason; detail: string } {
    return { ...(this.#reason ? { reason: this.#reason } : {}), detail: this.#detail };
  }
}

/** Runs a script to the end with a plain callback for its calls (tests; simple callers). */
export async function runScript(o: CodeRunInput, call: (name: string, args: Record<string, unknown>) => Promise<InnerResult>): Promise<CodeResult> {
  const run = new CodeRun(o);
  for (;;) {
    const s = await run.next();
    if (s.type === 'done') return s.result;
    run.answer(s.id, await call(s.name, s.args));
  }
}

/** The text the model gets back from run_code. */
export function codeOutput(r: CodeResult, inner: { name: string; status: string }[]): string {
  const calls = inner.length ? `Calls (${inner.length}): ${inner.map((c) => `${c.name} ${c.status}`).join(', ')}` : 'Calls: none';
  const logs = r.logs ? `\nLogs:\n${r.logs}` : '';
  if (r.ok) return `${r.result || '(the script returned nothing)'}\n\n[${calls}]${logs}`;
  return `Error: ${r.error ?? 'The script failed.'}\n[${calls}]${logs}`;
}

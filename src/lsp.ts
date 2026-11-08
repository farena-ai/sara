// C13 (docs/ops/C13_DESIGN.md): the language-server engine. One server per (project folder,
// language), started when a tool first needs it and only if its program is on PATH (none is
// bundled): typescript-language-server, pyright-langserver, gopls, rust-analyzer. Read-only use:
// diagnostics for a file, go-to-definition, find references, hover.
// Caps: every request has a time limit; idle servers stop after a few minutes; at most a few run at
// once; node-based servers get a heap limit (NODE_OPTIONS) and, on Linux, any server is stopped
// when its memory passes the cap. The server gets a clean environment (never Sara's own keys).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cleanEnv } from './worktrees.ts';
import { inside } from './tools/workspace.ts';

export interface LspServerSpec {
  language: string;
  exts: string[];
  bin: string;
  args: string[];
  /** Runs on Node (gets a heap limit through NODE_OPTIONS). */
  node?: boolean;
  /** The LSP languageId per extension (default: the language). */
  ids?: Record<string, string>;
}

export const LSP_SERVERS: readonly LspServerSpec[] = [
  { language: 'typescript', exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], bin: 'typescript-language-server', args: ['--stdio'], node: true, ids: { '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' } },
  { language: 'python', exts: ['.py', '.pyi'], bin: 'pyright-langserver', args: ['--stdio'], node: true },
  { language: 'go', exts: ['.go'], bin: 'gopls', args: [] },
  { language: 'rust', exts: ['.rs'], bin: 'rust-analyzer', args: [] },
];

export function languageOf(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return LSP_SERVERS.find((s) => s.exts.includes(ext))?.language;
}

/** The program's full path on PATH (with PATHEXT on Windows), or undefined. */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  for (const d of dirs)
    for (const e of exts) {
      const p = join(d, bin + e);
      try {
        if (statSync(p).isFile() && (process.platform !== 'win32' || e)) return p;
      } catch {
        /* not here */
      }
    }
  return undefined;
}

export interface LspCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export interface Diagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}
export interface Location {
  path: string;
  line: number;
  column: number;
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'] as const;
const MAX_FILE = 2_000_000;

class LspClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly root: string;
  info?: { name?: string; version?: string };
  lastUsed = Date.now();
  dead: string | undefined;
  readonly #pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  readonly #diags = new Map<string, Diagnostic[]>();
  readonly #diagWait = new Map<string, (() => void)[]>();
  readonly #open = new Map<string, number>();
  #id = 0;
  #buf = Buffer.alloc(0);
  ready: Promise<void>;
  readonly #timeoutMs: number;
  constructor(cmd: LspCommand, root: string, o: { timeoutMs: number; memoryMB: number; node: boolean }) {
    this.root = root;
    this.#timeoutMs = o.timeoutMs;
    const env = cleanEnv({ ...(o.node ? { NODE_OPTIONS: `--max-old-space-size=${o.memoryMB}` } : {}), ...(cmd.env ?? {}) });
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd.command);
    this.proc = viaCmd ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd.command, ...cmd.args], { cwd: root, env, windowsHide: true }) : spawn(cmd.command, cmd.args, { cwd: root, env, windowsHide: true });
    this.proc.stdout.on('data', (d: Buffer) => this.#onData(d));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', (e) => this.#die(`could not start (${e.message})`));
    this.proc.on('exit', (code) => this.#die(`stopped (exit code ${code ?? 'none'})`));
    this.proc.stdin.on('error', () => {});
    this.ready = this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }], capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, references: {} } } }).then((r) => {
      this.info = (r as { serverInfo?: { name?: string; version?: string } })?.serverInfo;
      this.notify('initialized', {});
    });
    this.ready.catch(() => {});
  }
  #die(why: string): void {
    if (this.dead) return;
    this.dead = why;
    for (const p of this.#pending.values()) p.fail(new Error(`The language server ${why}.`));
    this.#pending.clear();
    for (const ws of this.#diagWait.values()) for (const w of ws) w();
    this.#diagWait.clear();
  }
  #write(m: Record<string, unknown>): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8');
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  #onData(d: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      const end = this.#buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(this.#buf.subarray(0, end).toString('ascii'))?.[1] ?? -1);
      if (len < 0 || len > 50_000_000) return void this.stop('sent a message that could not be read');
      if (this.#buf.length < end + 4 + len) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(this.#buf.subarray(end + 4, end + 4 + len).toString('utf8')) as Record<string, unknown>;
      } catch {
        m = {};
      }
      this.#buf = this.#buf.subarray(end + 4 + len);
      this.#onMessage(m);
    }
  }
  #onMessage(m: Record<string, unknown>): void {
    if (m.method === undefined && typeof m.id === 'number') {
      const p = this.#pending.get(m.id);
      this.#pending.delete(m.id);
      if (!p) return;
      if (m.error) p.fail(new Error(`The language server said: ${String((m.error as { message?: string }).message ?? 'error').slice(0, 300)}`));
      else p.ok(m.result);
      return;
    }
    if (m.method === 'textDocument/publishDiagnostics') {
      const params = m.params as { uri: string; diagnostics: { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string }[] };
      const list = (params.diagnostics ?? []).slice(0, 500).map((x) => ({ line: x.range.start.line + 1, column: x.range.start.character + 1, severity: SEVERITY[x.severity ?? 1] ?? 'error', message: String(x.message).slice(0, 1000), ...(x.source ? { source: String(x.source) } : {}) }));
      this.#diags.set(params.uri, list);
      for (const w of this.#diagWait.get(params.uri) ?? []) w();
      this.#diagWait.delete(params.uri);
      return;
    }
    // A request from the server (workspace/configuration, window/workDoneProgress/create…): answer
    // politely so it doesn't wait.
    if (m.method && m.id !== undefined) this.#write({ id: m.id, result: m.method === 'workspace/configuration' ? ((m.params as { items?: unknown[] })?.items ?? []).map(() => null) : null });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`The language server ${this.dead}.`));
    this.lastUsed = Date.now();
    const id = ++this.#id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        fail(new Error(`The language server took too long (over ${Math.round(this.#timeoutMs / 1000)} s).`));
      }, this.#timeoutMs);
      this.#pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) });
      this.#write({ id, method, params });
    });
  }
  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }
  /** Opens (or refreshes) a file from disk; returns its uri. */
  sync(abs: string, languageId: string): string {
    const uri = pathToFileURL(abs).href;
    const text = readFileSync(abs, 'utf8');
    const v = this.#open.get(uri);
    if (v === undefined) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version: v + 1 }, contentChanges: [{ text }] });
    this.#open.set(uri, (v ?? 0) + 1);
    this.#diags.delete(uri);
    return uri;
  }
  diagnosticsFor(uri: string, waitMs: number): Promise<Diagnostic[]> {
    const have = this.#diags.get(uri);
    if (have) return Promise.resolve(have);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        const d = this.#diags.get(uri);
        if (d) ok(d);
        else fail(new Error(`The language server took too long (over ${Math.round(waitMs / 1000)} s).`));
      }, waitMs);
      const list = this.#diagWait.get(uri) ?? [];
      list.push(() => {
        clearTimeout(timer);
        const d = this.#diags.get(uri);
        if (d) ok(d);
        else fail(new Error(`The language server ${this.dead ?? 'sent nothing'}.`));
      });
      this.#diagWait.set(uri, list);
    });
  }
  stop(why = 'was stopped'): void {
    if (!this.dead) {
      try {
        this.#write({ id: ++this.#id, method: 'shutdown' });
        this.#write({ method: 'exit' });
      } catch {
        /* gone */
      }
    }
    this.#die(why);
    const p = this.proc;
    setTimeout(() => {
      if (p.exitCode === null) p.kill();
    }, 500).unref();
  }
}

export interface LspEngineOptions {
  /** The command for a language (default: its program on PATH). */
  resolve?: (language: string) => LspCommand | undefined;
  timeoutMs?: number;
  idleMs?: number;
  memoryMB?: number;
  maxServers?: number;
}

export class LspEngine {
  readonly #clients = new Map<string, { client: LspClient; language: string }>();
  readonly #o: Required<Omit<LspEngineOptions, 'resolve'>> & { resolve: (language: string) => LspCommand | undefined };
  #sweep?: NodeJS.Timeout;
  constructor(o: LspEngineOptions = {}) {
    this.#o = {
      resolve:
        o.resolve ??
        ((language) => {
          const spec = LSP_SERVERS.find((s) => s.language === language);
          const command = spec ? findOnPath(spec.bin) : undefined;
          return spec && command ? { command, args: spec.args } : undefined;
        }),
      timeoutMs: o.timeoutMs ?? 15_000,
      idleMs: o.idleMs ?? 5 * 60_000,
      memoryMB: o.memoryMB ?? 1536,
      maxServers: o.maxServers ?? 4,
    };
  }

  /** Which servers are on this computer (for Settings). */
  available(): { language: string; bin: string; found: boolean }[] {
    return LSP_SERVERS.map((s) => ({ language: s.language, bin: s.bin, found: Boolean(this.#o.resolve(s.language)) }));
  }
  running(): { root: string; language: string }[] {
    return [...this.#clients.values()].filter((c) => !c.client.dead).map((c) => ({ root: c.client.root, language: c.language }));
  }
  serverInfo(root: string, language: string): { name?: string; version?: string } | undefined {
    return this.#clients.get(`${language}\u0000${resolve(root)}`)?.client.info;
  }

  async #client(root: string, rel: string): Promise<{ client: LspClient; abs: string; languageId: string }> {
    const abs = resolve(root, rel);
    if (!inside(root, abs)) throw new Error(`Path "${rel}" is outside the workspace.`);
    const language = languageOf(abs);
    if (!language) throw new NoServer(`No language server knows ${extname(abs) || 'this kind of'} files.`);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`No file ${rel}.`);
    if (st.size > MAX_FILE) throw new Error(`${rel} is too big for the language server (over 2 MB).`);
    const spec = LSP_SERVERS.find((s) => s.language === language)!;
    const key = `${language}\u0000${resolve(root)}`;
    let c = this.#clients.get(key);
    if (!c || c.client.dead) {
      const cmd = this.#o.resolve(language);
      if (!cmd) throw new NoServer(`No language server for ${language} on this computer (install ${spec.bin} and put it on PATH to get these).`);
      this.#evict();
      c = { client: new LspClient(cmd, resolve(root), { timeoutMs: this.#o.timeoutMs, memoryMB: this.#o.memoryMB, node: Boolean(spec.node) || /node(\.exe)?$/i.test(cmd.command) }), language };
      this.#clients.set(key, c);
      this.#startSweep();
    }
    await c.client.ready;
    return { client: c.client, abs, languageId: spec.ids?.[extname(abs).toLowerCase()] ?? language };
  }
  #evict(): void {
    const live = [...this.#clients.entries()].filter(([, c]) => !c.client.dead).sort((a, b) => a[1].client.lastUsed - b[1].client.lastUsed);
    while (live.length >= this.#o.maxServers) {
      const [k, c] = live.shift()!;
      c.client.stop('was stopped to make room for another');
      this.#clients.delete(k);
    }
  }
  #startSweep(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, c] of this.#clients) {
        if (c.client.dead || now - c.client.lastUsed > this.#o.idleMs) {
          c.client.stop('stopped after being idle');
          this.#clients.delete(k);
        } else if (process.platform === 'linux' && c.client.proc.pid) {
          // The memory cap for servers that are not on Node (and a backstop for those that are).
          try {
            const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${c.client.proc.pid}/status`, 'utf8'))?.[1] ?? 0);
            if (kb > this.#o.memoryMB * 1024) {
              c.client.stop(`was stopped: it used more than ${this.#o.memoryMB} MB`);
              this.#clients.delete(k);
            }
          } catch {
            /* gone */
          }
        }
      }
      if (!this.#clients.size && this.#sweep) {
        clearInterval(this.#sweep);
        this.#sweep = undefined;
      }
    }, 15_000);
    this.#sweep.unref();
  }

  #loc(root: string, raw: unknown): Location[] {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: Location[] = [];
    for (const x of list.slice(0, 200) as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } }[]) {
      const uri = x.uri ?? x.targetUri;
      const start = (x.range ?? x.targetSelectionRange)?.start;
      if (!uri || !start || !uri.startsWith('file:')) continue;
      const abs = fileURLToPath(uri);
      const rel = inside(root, abs) ? relative(root, abs).split(sep).join('/') : '(outside the workspace)';
      out.push({ path: rel, line: start.line + 1, column: start.character + 1 });
    }
    return out;
  }
  async diagnostics(root: string, rel: string): Promise<Diagnostic[]> {
    const { client, abs, languageId } = await this.#client(root, rel);
    const uri = client.sync(abs, languageId);
    return client.diagnosticsFor(uri, this.#o.timeoutMs);
  }
  async #at(method: string, root: string, rel: string, line: number, column: number, extra: Record<string, unknown> = {}): Promise<unknown> {
    const { client, abs, languageId } = await this.#client(root, rel);
    const uri = client.sync(abs, languageId);
    return client.request(method, { textDocument: { uri }, position: { line: Math.max(0, Math.floor(line) - 1), character: Math.max(0, Math.floor(column) - 1) }, ...extra });
  }
  async definition(root: string, rel: string, line: number, column: number): Promise<Location[]> {
    return this.#loc(root, await this.#at('textDocument/definition', root, rel, line, column));
  }
  async references(root: string, rel: string, line: number, column: number): Promise<Location[]> {
    return this.#loc(root, await this.#at('textDocument/references', root, rel, line, column, { context: { includeDeclaration: true } }));
  }
  async hover(root: string, rel: string, line: number, column: number): Promise<string | undefined> {
    const r = (await this.#at('textDocument/hover', root, rel, line, column)) as { contents?: unknown } | null;
    const c = r?.contents;
    const one = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : '');
    const text = Array.isArray(c) ? c.map(one).filter(Boolean).join('\n\n') : one(c);
    return text ? text.slice(0, 8000) : undefined;
  }
  stopAll(): void {
    for (const c of this.#clients.values()) c.client.stop();
    this.#clients.clear();
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = undefined;
  }
}

/** No server for that file: the tools answer in words, not as a failure. */
export class NoServer extends Error {}


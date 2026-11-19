// W3.1: the local test harness. `sara-addon test` starts the add-on and a test host, opens a small
// loopback bridge for the add-on's own tests (tests/harness.mjs) and runs them with `node --test`.
//
//   quick host  the JSON channel of docs/PLUGINS.md §6, here: the add-on runs in its own process with
//               Node's permission flags (only its folder and a scratch data folder), no global fetch,
//               and the calls it makes (fetch, tool, model, notify, card, kv) answered from fakes.json.
//   --sara dir  a throwaway Sara from a checkout, in this process: the add-on is staged, reviewed,
//               installed and switched on through the real PluginManager, and tools run as registered
//               Sara tools (src/addons/kit-host.ts). Nothing touches a running Sara or its data.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Card, Manifest, ToolParameters } from './kit.ts';

export interface Fakes {
  lang?: string;
  settings?: Record<string, string | number | boolean>;
  secrets?: Record<string, string>;
  /** url → the answer to `sara.fetch(url)` (anything else: no network in the test host). */
  fetch?: Record<string, { status?: number; contentType?: string; body: string }>;
  /** her tool name → the content `sara.tool(name)` gets (the owner's approval is assumed). */
  tools?: Record<string, string>;
  /** the text `sara.model()` answers, or null (refused). */
  model?: string | null;
  notes?: string[];
}
export interface ToolAnswer {
  content?: string;
  card?: Card;
  error?: string;
}
export interface Backend {
  /** One line for the terminal. */
  label: string;
  /** Lines after the start (tools, permissions). */
  info: string[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  hook?(hook: string, data: Record<string, unknown>): Promise<unknown>;
  schedule?(id: string): Promise<unknown>;
  sent(): unknown[];
  stop(): Promise<void>;
}

export function readFakes(dir: string): Fakes {
  const p = join(dir, 'tests', 'fakes.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Fakes;
  } catch (err) {
    throw new Error(`tests/fakes.json isn't valid JSON (${(err as Error).message}).`);
  }
}

/** Sara's own argument check for plugin tools (src/plugins/manager.ts checkArgs). */
export function checkArgs(schema: ToolParameters | undefined, args: Record<string, unknown>): string | undefined {
  const s = (schema ?? {}) as { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[]; additionalProperties?: boolean };
  if (s.type && s.type !== 'object') return 'the tool takes an object';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'the arguments must be an object';
  for (const r of s.required ?? []) if (args[r] === undefined) return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties?.[k];
    if (!p) {
      if (s.additionalProperties === false) return `unknown argument "${k}"`;
      continue;
    }
    const t = p.type;
    const ok = !t || (t === 'string' ? typeof v === 'string' : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : t === 'boolean' ? typeof v === 'boolean' : t === 'array' ? Array.isArray(v) : t === 'object' ? Boolean(v) && typeof v === 'object' && !Array.isArray(v) : true);
    if (!ok) return `argument "${k}" must be ${t === 'integer' ? 'a whole number' : `a ${t}`}`;
    if (p.enum && !p.enum.includes(v)) return `argument "${k}" must be one of ${p.enum.map(String).join(', ')}`;
  }
  if (JSON.stringify(args).length > 64 * 1024) return 'the arguments are too large';
  return undefined;
}

interface Pending {
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The quick host: the add-on in its own permission-limited process, spoken to over the JSON channel. */
export class QuickHost implements Backend {
  label = '';
  info: string[] = [];
  readonly calls: Record<string, unknown>[] = [];
  #child?: ChildProcess;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #buf = '';
  #stderr = '';
  #data = '';
  #kv = new Map<string, unknown>();
  #tools: { name: string; parameters?: ToolParameters }[] = [];
  #manifest: Manifest;
  #fakes: Fakes;
  #dir: string;
  #exited = false;

  constructor(dir: string, manifest: Manifest, fakes: Fakes) {
    this.#dir = resolve(dir);
    this.#manifest = manifest;
    this.#fakes = fakes;
  }

  async start(o: { readyMs?: number; node?: string } = {}): Promise<this> {
    this.#data = mkdtempSync(join(tmpdir(), 'sara-addon-data-'));
    const preload = join(this.#data, '.preload.mjs');
    // Like Sara's plugin host: no global fetch or WebSocket (network only through sara.fetch).
    writeFileSync(preload, 'delete globalThis.fetch;\ndelete globalThis.WebSocket;\ndelete globalThis.EventSource;\n');
    const main = join(this.#dir, this.#manifest.main);
    const args = ['--permission', `--allow-fs-read=${this.#dir}`, `--allow-fs-read=${this.#data}`, `--allow-fs-write=${this.#data}`, '--max-old-space-size=128', '--no-addons', '--disable-warning=ExperimentalWarning', '--import', pathToFileURL(preload).href, main];
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', LANG: 'C.UTF-8' };
    const child = spawn(o.node ?? process.execPath, args, { cwd: this.#data, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => this.#onData(c));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      this.#stderr = (this.#stderr + c).slice(-8000);
    });
    child.on('exit', (code) => {
      this.#exited = true;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`The add-on stopped (exit ${code}).${this.#stderr ? `\n${this.#stderr.trim()}` : ''}`));
        this.#pending.delete(id);
      }
    });
    const ready = new Promise<Record<string, unknown>>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`The add-on didn't say ready within ${(o.readyMs ?? 5000) / 1000} s.${this.#stderr ? `\n${this.#stderr.trim()}` : ''}`)), o.readyMs ?? 5000);
      this.#pending.set('ready', { resolve: res, reject: rej, timer });
    });
    const settings: Record<string, unknown> = {};
    for (const s of this.#manifest.settings ?? []) if (s.default !== undefined) settings[s.key] = s.default;
    Object.assign(settings, this.#fakes.settings ?? {});
    this.#send({ type: 'init', plugin: this.#manifest.id, companion: 'main', lang: this.#fakes.lang ?? 'en', settings, secrets: this.#fakes.secrets ?? {}, bridges: [], herName: 'Sara', bridgeApi: 0 });
    const msg = await ready;
    this.#tools = Array.isArray(msg.tools) ? (msg.tools as { name: string; parameters?: ToolParameters }[]) : [];
    const want = ((this.#manifest.permissions.tools as string[] | undefined) ?? []).slice().sort();
    const have = this.#tools.map((t) => t.name).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`The add-on said ready with tools [${have.join(', ')}], but sara-plugin.json lists [${want.join(', ')}]: run sara-addon build.`);
    this.label = `Quick host (the add-on in its own process, Node permission flags, no network): ${this.#manifest.id} ${this.#manifest.version}`;
    this.info = [`ready: ${have.join(', ') || '(no tools)'}`];
    return this;
  }

  #send(msg: Record<string, unknown>): void {
    if (!this.#exited) this.#child?.stdin?.write(`${JSON.stringify({ v: 1, ...msg })}\n`);
  }

  #request(msg: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> {
    const id = `t${++this.#seq}`;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`The add-on didn't answer within ${ms / 1000} s (Sara skips it then).`));
      }, ms);
      this.#pending.set(id, { resolve: res, reject: rej, timer });
      this.#send({ id, ...msg });
    });
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.calls.push({ op: 'log', level: 'warn', text: `not JSON (Sara drops it): ${line.slice(0, 200)}` });
        continue;
      }
      if (msg.type === 'ready') this.#settle('ready', msg);
      else if ((msg.type === 'result' || msg.type === 'error') && typeof msg.id === 'string' && this.#pending.has(msg.id)) this.#settle(msg.id, msg);
      else if (msg.type === 'call') void this.#answer(msg);
      else if (msg.type === 'log') this.calls.push({ op: 'log', level: msg.level, text: msg.text });
    }
  }

  #settle(id: string, msg: Record<string, unknown>): void {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    p.resolve(msg);
  }

  async #answer(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id;
    const op = String(msg.op ?? '');
    const ok = (fields: Record<string, unknown>) => this.#send({ id, type: 'result', ...fields });
    const no = (error: string) => this.#send({ id, type: 'error', error });
    const perms = this.#manifest.permissions as Record<string, unknown>;
    const { v: _v, id: _id, type: _t, ...rest } = msg;
    void _v;
    void _id;
    void _t;
    this.calls.push(rest);
    if (op === 'fetch') {
      const url = String(msg.url ?? '');
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return no('not a URL');
      }
      const allowed = ((perms.network as string[] | undefined) ?? []).some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.slice(0, -(a.length - 1)).split('.').length === 1 : host === a));
      if (!allowed) return no(`${host} isn't in the add-on's network list`);
      if (!url.startsWith('https://')) return no('https only');
      const f = this.#fakes.fetch?.[url];
      if (!f) return no(`The test host has no network: add "${url}" to tests/fakes.json "fetch".`);
      return ok({ status: f.status ?? 200, contentType: f.contentType ?? 'application/json', body: f.body, truncated: false });
    }
    if (op === 'tool') {
      const name = String(msg.name ?? '');
      if (!((perms.callTools as string[] | undefined) ?? []).includes(name)) return no(`${name} isn't in callTools`);
      const c = this.#fakes.tools?.[name];
      if (c === undefined) return no(`The test host has no answer for her tool ${name}: add it to tests/fakes.json "tools".`);
      return ok({ ok: true, content: c });
    }
    if (op === 'model') {
      if (!perms.model) return no('it has no model permission');
      if (typeof this.#fakes.model !== 'string') return no('The test host has no model: set tests/fakes.json "model" to the text it should answer.');
      return ok({ text: this.#fakes.model });
    }
    if (op === 'notify') return ok({ ok: true });
    if (op === 'card') return perms.cards ? ok({ ok: true }) : no('it has no cards permission');
    if (op === 'kv.get') return ok({ value: this.#kv.get(String(msg.key)) ?? null });
    if (op === 'kv.set') {
      if (this.#kv.size >= 200 && !this.#kv.has(String(msg.key))) return no('200 keys at most');
      if (JSON.stringify(msg.value ?? null).length > 64 * 1024) return no('64 KB a value at most');
      this.#kv.set(String(msg.key), msg.value);
      return ok({ ok: true });
    }
    if (op === 'memory.notes') return perms.memory === 'shared-notes' ? ok({ notes: this.#fakes.notes ?? [] }) : no('it has no memory permission');
    return no(`The test host doesn't do "${op}" (try --sara for the real host).`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const t = this.#tools.find((x) => x.name === name);
    if (!t) return { error: `no tool ${name}` };
    const bad = checkArgs(t.parameters, args);
    if (bad) return { error: bad };
    try {
      const r = await this.#request({ type: 'tool', name, args }, 30_000);
      if (r.type === 'error') return { error: String(r.error ?? 'error') };
      return { content: String(r.content ?? ''), ...(r.card ? { card: r.card as Card } : {}) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  async hook(hook: string, data: Record<string, unknown>): Promise<unknown> {
    const hooks = (this.#manifest.permissions.hooks as string[] | undefined) ?? [];
    if (!hooks.includes(hook)) return { error: `${hook} isn't in permissions.hooks` };
    const ms = { 'turn.before': 1500, 'tool.before': 1000, 'tool.after': 3000, 'reply.after': 5000 }[hook] ?? 30_000;
    const r = await this.#request({ type: 'hook', hook, data }, ms);
    const { v: _v, id: _id, type, ...rest } = r;
    void _v;
    void _id;
    return type === 'error' ? { error: rest.error } : rest;
  }

  async schedule(id: string): Promise<unknown> {
    const r = await this.#request({ type: 'schedule', schedule: id }, 60_000);
    return r.type === 'error' ? { error: r.error } : { ok: true };
  }

  sent(): unknown[] {
    return this.calls;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child && !this.#exited) {
      const gone = new Promise<void>((r) => child.once('exit', () => r()));
      child.kill();
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    }
    try {
      rmSync(this.#data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can hold the folder a moment after the child exits; it's a temp folder.
    }
  }
}

/** The loopback bridge the add-on's tests talk to (tests/harness.mjs). Bearer token, 127.0.0.1 only. */
export async function startBridge(backend: Backend): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const token = randomBytes(18).toString('hex');
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) return send(403, { error: 'forbidden' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return send(400, { error: 'bad JSON' });
      }
      try {
        if (req.url === '/tool') return send(200, await backend.callTool(String(body.name ?? ''), (body.args ?? {}) as Record<string, unknown>));
        if (req.url === '/hook') return backend.hook ? send(200, await backend.hook(String(body.hook ?? ''), (body.data ?? {}) as Record<string, unknown>)) : send(501, { error: 'Hooks run only in the quick host (sara-addon test without --sara).' });
        if (req.url === '/schedule') return backend.schedule ? send(200, await backend.schedule(String(body.id ?? ''))) : send(501, { error: 'Schedules run only in the quick host.' });
        if (req.url === '/sent') return send(200, backend.sent());
        return send(404, { error: 'not found' });
      } catch (err) {
        return send(500, { error: (err as Error).message });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, token, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The add-on's test files (tests/*.test.mjs, *.test.js). */
export function testFiles(dir: string): string[] {
  const t = join(dir, 'tests');
  if (!existsSync(t)) return [];
  return readdirSync(t)
    .filter((f) => /\.test\.(mjs|js)$/.test(f))
    .sort()
    .map((f) => join(t, f));
}

/** Runs `node --test` on the add-on's tests against a started backend; resolves with the exit code. */
export async function runTests(dir: string, backend: Backend, o: { log?: (s: string) => void; node?: string } = {}): Promise<number> {
  const log = o.log ?? ((s: string) => process.stdout.write(s));
  const files = testFiles(dir);
  if (!files.length) {
    log('There are no tests in tests/ (name them *.test.mjs).\n');
    return 1;
  }
  const bridge = await startBridge(backend);
  try {
    return await new Promise<number>((res) => {
      const env: Record<string, string | undefined> = { ...process.env, SARA_ADDON_URL: bridge.url, SARA_ADDON_TOKEN: bridge.token, SARA_ADDON_HOST: backend.hook ? 'quick' : 'sara' };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(o.node ?? process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => log(c));
      child.stderr.on('data', (c: string) => log(c));
      child.on('close', (code) => res(code ?? 1));
    });
  } finally {
    await bridge.close();
  }
}

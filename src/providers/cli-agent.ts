// Subscription models through the vendors' own command-line programs:
//   Claude: Claude Code (`claude -p`), signed in with the owner's `claude setup-token` token.
//   Grok:   Grok CLI (`grok -p`), signed in with `grok login --device-auth` (from Settings).
// Both are run as plain model calls: their built-in tools are switched off and Sara's tools are
// offered through an MCP bridge (src/agent-bridge.ts). A tool call pauses the CLI while Sara's
// normal turn loop runs the tool (approvals, sandbox, receipts); the next stream() call with the
// tool results resumes the same process.
import { agentInstallHint } from '../platform.ts';
import { assertOnline } from '../net-guard.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ProviderError, type ChatMessage, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent, type ToolSpec } from './types.ts';

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agent-bridge.ts');
const IDLE_KILL_MS = 35 * 60_000;
const TRANSCRIPT_CHARS = 60_000;

export type AgentKind = 'claude' | 'grok';

export interface AgentRuntime {
  kind: AgentKind;
  /** Path to the `claude` / `grok` executable. */
  bin: string;
  /** Arguments placed before Sara's own (tests run a fake CLI through node). */
  binArgs?: string[];
  /** Private HOME for the CLI (its login and caches live here, not in the owner's home). */
  home: string;
  /** Temp files (system prompt, MCP config). */
  tmpDir: string;
  /** Extra environment, e.g. CLAUDE_CODE_OAUTH_TOKEN. */
  env: () => Record<string, string>;
  /** Grok can't load an MCP config per run yet; its calls are text-only. */
  tools: boolean;
}

/** Turns Sara's message list into (system prompt, prompt) for a one-shot CLI call. */
export function toCliPrompt(messages: ChatMessage[], owner = 'Owner'): { system: string; prompt: string } {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  let lastUser = -1;
  // Phase 116: a steer (sent while she worked) is part of this turn, never its prompt.
  rest.forEach((m, i) => {
    if (m.role === 'user' && !m.steer) lastUser = i;
  });
  const fmt = (m: ChatMessage): string => {
    if (m.role === 'user' && m.steer) return `${owner} (sent while you worked): ${m.content}`;
    if (m.role === 'user') return `${owner}: ${m.content}${m.images?.length ? ` [${m.images.length} photo(s) attached; you can't see photos in this setup, so say so if it matters]` : ''}`;
    if (m.role === 'assistant') return `You: ${m.content}${m.toolCalls?.length ? `\n[you used: ${m.toolCalls.map((c) => c.name).join(', ')}]` : ''}`;
    if (m.role === 'tool') return `[${m.name} result]: ${m.content.slice(0, 2000)}`;
    return '';
  };
  const before = rest.slice(0, Math.max(0, lastUser)).map(fmt).join('\n\n');
  const after = lastUser >= 0 ? rest.slice(lastUser + 1).map(fmt).join('\n\n') : '';
  const transcript = before.length > TRANSCRIPT_CHARS ? `…${before.slice(-TRANSCRIPT_CHARS)}` : before;
  const system = [sys[0] ?? '', transcript ? `# The conversation so far (most recent last)\n\n${transcript}` : '', ...sys.slice(1)].filter(Boolean).join('\n\n');
  const lastMsg = lastUser >= 0 ? (rest[lastUser] as { content: string; images?: unknown[] }) : undefined;
  const last = lastMsg ? `${lastMsg.content}${lastMsg.images?.length ? `\n\n[${lastMsg.images.length} photo(s) attached; you can't see photos in this setup, so tell ${owner} and ask them to describe it or switch to a model that can see photos.]` : ''}` : 'Continue.';
  const prompt = after ? `${last}\n\n(Earlier in this turn:)\n${after}\n\nContinue from there.` : last;
  return { system, prompt };
}

interface Pending {
  id: string;
  name: string;
  resolve: (r: { text: string; isError: boolean }) => void;
}

/** One running CLI process for one Sara turn. */
class Session {
  readonly id = randomUUID();
  readonly events: (StreamEvent | { type: 'pause' } | { type: 'end' } | { type: 'fail'; message: string })[] = [];
  readonly pending = new Map<string, Pending>();
  proc: ChildProcess | undefined;
  server: Server | undefined;
  files: string[] = [];
  idle: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #expectCalls = 0;
  #seenCalls = 0;
  ended = false;
  callSeq = 0;

  push(ev: Session['events'][number]): void {
    this.events.push(ev);
    this.#wake?.();
  }

  /** The CLI announced N tool calls in one assistant message; pause once all N reached Sara. */
  expectCalls(n: number): void {
    this.#expectCalls += n;
    this.#maybePause();
  }

  sawCall(): void {
    this.#seenCalls++;
    this.#maybePause();
  }

  #maybePause(): void {
    if (this.#expectCalls > 0 && this.#seenCalls >= this.#expectCalls) {
      this.#expectCalls = 0;
      this.#seenCalls = 0;
      this.push({ type: 'pause' });
    }
  }

  async next(signal?: AbortSignal): Promise<Session['events'][number]> {
    while (!this.events.length) {
      if (signal?.aborted) throw new ProviderError('Stopped.');
      await new Promise<void>((r) => {
        this.#wake = r;
        signal?.addEventListener('abort', () => r(), { once: true });
      });
      this.#wake = undefined;
    }
    return this.events.shift()!;
  }

  close(): void {
    this.ended = true;
    clearTimeout(this.idle);
    for (const p of this.pending.values()) p.resolve({ text: 'The turn ended.', isError: true });
    this.pending.clear();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    this.server?.close();
    for (const f of this.files) rmSync(f, { force: true, recursive: true });
  }
}

const sessions = new Map<string, Session>();

/**
 * The models offered for a Claude subscription. Sara never sends the subscription token anywhere
 * itself (Anthropic's terms: only their own programs use it), so the list isn't read from
 * Anthropic's API. Instead it comes from the installed Claude Code program, which carries the model
 * names its own /model picker knows: it updates whenever Claude Code updates, with no network call.
 * Offered: for each family (Opus, Sonnet, Haiku, ...) every version of its newest generation plus
 * the newest of the one before, their 1M-context variants, then Claude Code's short names ("opus"
 * = always the newest). If the program can't be read, a built-in list is used.
 */
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];
/** Used only when the installed Claude Code can't be read (checked 2026-10-27, Claude Code 2.1.310). */
export const CLAUDE_FALLBACK = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-fable-5-1', 'claude-haiku-5-5'];
// The minor version is one digit (3-5, 4-6, 5-5) and the name must end there (quote, NUL, comma,
// space…): in the program file "claude-haiku-3-5" sits right before a stray "5", and reading two
// digits gave "claude-haiku-3-55". Dated snapshots (-20251001) are matched whole and skipped.
const MODEL_ID = /claude-([a-z]+)-(\d{1,2})(?!\d)(?:-(\d)(?!\d))?(?:-(\d{8}))?(\[1m\])?(?![\w.-])/g;
/** Claude 3.x models are retired: never offered, even when Claude Code still mentions them. */
const OLDEST_MAJOR = 4;
/** Families known to be models; another name counts only if Claude Code knows two or more versions of it. */
const KNOWN_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

/** Picks the current models out of every Claude model name found in Claude Code's program. */
export function pickClaudeModels(found: Iterable<string>): string[] {
  type V = { family: string; major: number; minor: number; long: boolean };
  const seen = new Map<string, V>();
  for (const name of found) {
    for (const m of name.matchAll(MODEL_ID)) {
      if (m[4]) continue; // dated snapshots: the undated name is the one to pick
      const v = { family: m[1], major: Number(m[2]), minor: Number(m[3] ?? 0), long: Boolean(m[5]) };
      if (v.major < OLDEST_MAJOR || v.major > 20) continue;
      seen.set(m[0], v);
    }
  }
  const out: { id: string; v: V }[] = [];
  const families = new Set([...seen.values()].map((v) => v.family));
  for (const family of families) {
    const vs = [...seen].filter(([, v]) => v.family === family);
    const versions = new Set(vs.map(([, v]) => `${v.major}.${v.minor}`));
    if (!KNOWN_FAMILIES.includes(family) && versions.size < 2) continue; // "claude-desktop-3", "claude-eval-9": not models
    const newest = Math.max(...vs.map(([, v]) => v.major));
    const before = vs.filter(([, v]) => v.major < newest);
    const prevBest = before.length ? before.reduce((a, b) => (b[1].major * 100 + b[1].minor > a[1].major * 100 + a[1].minor ? b : a)) : undefined;
    for (const [id, v] of vs) {
      const keep = v.major === newest || (prevBest && v.major === prevBest[1].major && v.minor === prevBest[1].minor);
      if (keep) out.push({ id, v });
    }
  }
  const rank = (f: string) => ['opus', 'sonnet', 'fable', 'haiku'].indexOf(f) + 1 || 9;
  out.sort((a, b) => rank(a.v.family) - rank(b.v.family) || a.v.family.localeCompare(b.v.family) || b.v.major - a.v.major || b.v.minor - a.v.minor || Number(a.v.long) - Number(b.v.long));
  return out.map((o) => o.id);
}

/** The Claude Code program file to read names from (the launcher may be a link or a small script). */
function claudeProgramFile(bin: string): string | undefined {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    return undefined;
  }
  try {
    if (statSync(real).size > 5_000_000) return real; // the native build itself
  } catch {
    return undefined;
  }
  // A launcher script: look for the package next to it or a few folders up.
  let dir = dirname(real);
  for (let i = 0; i < 5; i++) {
    for (const rel of ['node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', '.']) {
      for (const f of ['bin/claude.exe', 'bin/claude', 'cli.js', 'cli.mjs']) {
        const p = join(dir, rel, f);
        try {
          if (statSync(p).size > 1_000_000) return p;
        } catch {
          /* not here */
        }
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

const claudeListCache = new Map<string, { stamp: string; models: string[] }>();
/** Model names from the installed Claude Code (cached until the program file changes). */
export function claudeModels(bin?: string): string[] {
  const file = bin ? claudeProgramFile(bin) : undefined;
  if (!file) return [...CLAUDE_FALLBACK, ...CLAUDE_ALIASES];
  try {
    const st = statSync(file);
    const stamp = `${st.size}:${st.mtimeMs}`;
    const hit = claudeListCache.get(file);
    if (hit?.stamp === stamp) return [...hit.models];
    // Read in pieces (the native build is ~300 MB) and keep only matching names.
    const found = new Set<string>();
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8 * 1024 * 1024);
      let pos = 0;
      let tail = '';
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const text = tail + buf.toString('latin1', 0, n);
        // A name touching the end of this piece may be cut off ("claude-opus-4" of "…-4-5"): it is
        // read whole with the next piece, which starts with this tail.
        const last = pos >= st.size;
        for (const m of text.matchAll(MODEL_ID)) if (last || m.index + m[0].length < text.length - 64) found.add(m[0]);
        tail = text.slice(-128);
      }
    } finally {
      closeSync(fd);
    }
    const picked = pickClaudeModels(found);
    const models = picked.length ? [...picked, ...CLAUDE_ALIASES] : [...CLAUDE_FALLBACK, ...CLAUDE_ALIASES];
    claudeListCache.set(file, { stamp, models });
    return [...models];
  } catch {
    return [...CLAUDE_FALLBACK, ...CLAUDE_ALIASES];
  }
}

export class CliAgentProvider implements Provider {
  readonly config: ProviderConfig;
  readonly #rt: AgentRuntime;

  constructor(config: ProviderConfig, runtime: AgentRuntime) {
    this.config = config;
    this.#rt = runtime;
  }

  async listModels(): Promise<string[]> {
    // Phase 67: these programs talk to their vendor directly: never in private local mode.
    assertOnline(this.config.label);
    if (this.#rt.kind === 'claude') return claudeModels(this.#rt.bin);
    const out = await this.#run(['models'], 30_000);
    if (/not authenticated/i.test(out)) throw new ProviderError('Grok is not signed in. Settings → Subscriptions → Sign in to Grok.', 401);
    const models = [...out.matchAll(/^\s*[*-]\s+([\w.-]+)/gm)].map((m) => m[1]);
    return models.length ? models : ['grok-4.6'];
  }

  #env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const keep = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'TZ'];
    const env: NodeJS.ProcessEnv = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    mkdirSync(this.#rt.home, { recursive: true, mode: 0o700 });
    Object.assign(env, {
      HOME: this.#rt.home,
      USERPROFILE: this.#rt.home,
      XDG_CONFIG_HOME: join(this.#rt.home, '.config'),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      // Tool calls can wait for the owner's approval.
      MCP_TOOL_TIMEOUT: String(30 * 60_000),
      ...this.#rt.env(),
      ...extra,
    });
    return env;
  }

  /** Runs a short CLI command (models, status). */
  #run(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((res, rej) => {
      const p = spawn(this.#rt.bin, [...(this.#rt.binArgs ?? []), ...args], { env: this.#env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.on('error', (e) => {
        clearTimeout(t);
        rej(new ProviderError(`${this.config.label} isn't installed on this server (${e.message}). ${agentInstallHint()}`));
      });
      p.on('close', () => {
        clearTimeout(t);
        res(out);
      });
    });
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    assertOnline(this.config.label);
    // Resume a paused session when this call carries results for its pending tool calls.
    const results = trailingToolResults(req.messages);
    let session = [...sessions.values()].find((s) => !s.ended && s.pending.size && [...s.pending.keys()].every((id) => results.has(id)));
    if (session) {
      clearTimeout(session.idle);
      for (const [id, p] of session.pending) {
        const r = results.get(id)!;
        p.resolve({ text: r, isError: false });
      }
      session.pending.clear();
    } else {
      session = await this.#start(req);
    }
    const s = session;
    const onAbort = () => {
      s.close();
      sessions.delete(s.id);
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const ev = await s.next(req.signal);
        if (ev.type === 'pause') {
          s.idle = setTimeout(onAbort, IDLE_KILL_MS);
          s.idle.unref();
          return;
        }
        if (ev.type === 'end') {
          onAbort();
          return;
        }
        if (ev.type === 'fail') {
          onAbort();
          throw new ProviderError(ev.message);
        }
        yield ev;
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #start(req: ChatRequest): Promise<Session> {
    const s = new Session();
    sessions.set(s.id, s);
    const { system, prompt } = toCliPrompt(req.messages);
    mkdirSync(this.#rt.tmpDir, { recursive: true });
    const sysFile = join(this.#rt.tmpDir, `agent-${s.id}-system.txt`);
    writeFileSync(sysFile, system, { mode: 0o600 });
    s.files.push(sysFile);
    const tools = this.#rt.tools ? (req.tools ?? []) : [];
    let bridgeEnv: Record<string, string> = {};
    let mcpFile: string | undefined;
    // Grok reads MCP servers from ./.grok/config.toml, so each Grok turn runs in its own folder.
    let cwd = this.#rt.tmpDir;
    if (this.#rt.kind === 'grok') {
      cwd = join(this.#rt.tmpDir, `agent-${s.id}`);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      s.files.push(cwd);
    }
    if (tools.length) {
      const { port, token } = await this.#bridge(s, tools);
      bridgeEnv = { SARA_BRIDGE_URL: `http://127.0.0.1:${port}`, SARA_BRIDGE_TOKEN: token };
      const bridgeArgs = ['--disable-warning=ExperimentalWarning', BRIDGE];
      if (this.#rt.kind === 'grok') {
        // Grok only loads MCP servers from configs it trusts (its own home), so the "sara" server is
        // registered there once; this turn's address is in the turn folder (and the environment).
        ensureGrokBridge(this.#rt.home, process.execPath, bridgeArgs);
        writeFileSync(join(cwd, '.sara-bridge.json'), JSON.stringify({ url: bridgeEnv.SARA_BRIDGE_URL, token: bridgeEnv.SARA_BRIDGE_TOKEN }), { mode: 0o600 });
      } else {
        mcpFile = join(this.#rt.tmpDir, `agent-${s.id}-mcp.json`);
        writeFileSync(mcpFile, JSON.stringify({ mcpServers: { sara: { type: 'stdio', command: process.execPath, args: bridgeArgs, env: bridgeEnv } } }), { mode: 0o600 });
        s.files.push(mcpFile);
      }
    }
    const args =
      this.#rt.kind === 'claude'
        ? [
            '-p',
            '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
            '--system-prompt-file', sysFile,
            '--tools', '',
            '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
            ...(mcpFile ? ['--mcp-config', mcpFile, '--allowedTools', 'mcp__sara'] : []),
            '--model', req.model,
          ]
        : [
            '--prompt-file', join(this.#rt.tmpDir, `agent-${s.id}-prompt.txt`),
            '--output-format', 'streaming-messages-json', '--include-partial-messages',
            '--system-prompt-override', system,
            // Built-in tools stay off; Sara's own tools (MCP) are approved here because Sara's
            // approval cards already ask the owner where her settings say so.
            '--tools', '', '--disable-web-search', '--no-subagents', '--no-plan',
            ...(tools.length ? ['--always-approve'] : ['--permission-mode', 'dontAsk']),
            '-m', req.model,
          ];
    if (this.#rt.kind === 'grok') {
      writeFileSync(args[1], prompt, { mode: 0o600 });
      s.files.push(args[1]);
    }
    const proc = spawn(this.#rt.bin, [...(this.#rt.binArgs ?? []), ...args], { env: this.#env(bridgeEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd });
    s.proc = proc;
    if (this.#rt.kind === 'claude') proc.stdin.end(prompt);
    else proc.stdin.end();
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    let sawResult = false;
    proc.on('error', (e) => s.push({ type: 'fail', message: `${this.config.label} isn't installed on this server (${e.message}). ${agentInstallHint()}` }));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const type = e.type;
      const inner = (type === 'stream_event' ? e.event : type === 'content_block_delta' ? e : undefined) as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) s.push({ type: 'text', text: inner.delta.text });
      else if (type === 'assistant') {
        const content = ((e.message as { content?: { type: string }[] } | undefined)?.content ?? []).filter((b) => b.type === 'tool_use');
        if (content.length) s.expectCalls(content.length);
      } else if (type === 'result') {
        sawResult = true;
        if (e.is_error) s.push({ type: 'fail', message: friendly(this.config.label, [String(e.result ?? ''), ...((e.errors as string[]) ?? [])].join(' ').trim() || stderr) });
        else s.push({ type: 'end' });
      }
    });
    proc.on('close', (code) => {
      if (!sawResult && !s.ended) s.push({ type: 'fail', message: friendly(this.config.label, stderr || `exited with code ${code}`) });
    });
    return s;
  }

  /** Local HTTP endpoint the MCP bridge calls back into. */
  #bridge(s: Session, tools: ToolSpec[]): Promise<{ port: number; token: string }> {
    const token = randomBytes(24).toString('base64url');
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      if (req.method === 'GET' && req.url === '/tools') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))));
      }
      if (req.method === 'POST' && req.url === '/call') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          let call: { name?: string; arguments?: Record<string, unknown> };
          try {
            call = JSON.parse(body);
          } catch {
            return void res.writeHead(400).end();
          }
          const id = `cli_${s.id.slice(0, 8)}_${++s.callSeq}`;
          s.pending.set(id, {
            id,
            name: String(call.name),
            resolve: (r) => {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(r));
            },
          });
          s.push({ type: 'tool_call', call: { id, name: String(call.name), arguments: call.arguments ?? {} } });
          s.sawCall();
        });
        return;
      }
      res.writeHead(404).end();
    });
    s.server = server;
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as AddressInfo).port, token })));
  }
}

/**
 * Adds (or refreshes) the "sara" MCP server in Grok's own config. Any other MCP server in it is
 * removed: Grok starts those itself, outside the sandbox, so only Sara's own bridge may be there.
 */
export function ensureGrokBridge(home: string, command: string, args: string[]): void {
  const file = join(home, '.grok', 'config.toml');
  const q = (v: string) => JSON.stringify(v);
  const block = ['[mcp_servers.sara]', `command = ${q(command)}`, `args = [${args.map(q).join(', ')}]`, 'enabled = true', ''].join('\n');
  let cur = '';
  try {
    cur = readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  // Every MCP server table (and its sub-tables) goes, then the current sara block is added.
  const rest = cur.replace(/(^|\n)\[\[?mcp_servers[.\]][^\n]*\][\s\S]*?(?=\n\[(?!\[?mcp_servers[.\]])|$)/g, '').trimEnd();
  if (`${rest ? `${rest}\n\n` : ''}${block}` === cur) return;
  mkdirSync(join(home, '.grok'), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${rest ? `${rest}\n\n` : ''}${block}`, { mode: 0o600 });
}

function trailingToolResults(messages: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') out.set(m.toolCallId, m.content);
    else if (m.role === 'system') continue;
    else break;
  }
  return out;
}

export function friendly(label: string, raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  // Only real sign-in errors (an output that merely mentions "login" or contains "401" somewhere is
  // not one: that used to report a working sign-in as expired).
  if (/\b(not signed in|not logged in|not authenticated|unauthenticated|please (log|sign) ?in|run [`'"]?[\w-]+ login|invalid api key|invalid_grant|(access |oauth |auth )?token (has )?expired|session expired|401 unauthorized|unauthorized \(401\)|(http|status|code)[ :]*401)\b/i.test(t))
    return `${label} isn't signed in (or the sign-in expired). Settings → Subscriptions.`;
  if (/usage limit|rate limit|429|limit reached/i.test(t)) return `${label}: your subscription's usage limit is reached for now. ${t.slice(0, 200)}`;
  return `${label}: ${t.slice(0, 400) || 'the program stopped unexpectedly'}`;
}

/** Test hook: number of live sessions. */
export function liveAgentSessions(): number {
  return [...sessions.values()].filter((s) => !s.ended).length;
}

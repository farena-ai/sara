// Model Context Protocol client: connects to MCP servers (stdio or streamable HTTP), lists their
// tools and exposes them through the tool registry as mcp_<server>_<tool>. Stdio servers run in the
// same bubblewrap sandbox as shell commands, with their own home directory.
import { clearSizes } from '../lean.ts';
import { en } from '../i18n.ts';
import { netFetch, privateLocalOn } from '../net-guard.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { egressAllowlist, openEgress, sandboxNode, type EgressSetup } from '../egress-run.ts';
import { sseEvents } from '../sse.ts';
import type { ToolRegistry } from './registry.ts';
import { bwrapArgs, commandPath, nativeOf, prepareForToolsUser, PRIVATE_LOCAL_ENV, RUNTIME_MOUNT, runtimeMountArgs, SANDBOX_EXEC, seatbeltProfile, type Bind, type SandboxInfo } from './sandbox.ts';
import { clip, ToolError, type Tool, type ToolContext } from './types.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  /** stdio: executable and arguments. */
  command?: string;
  args?: string[];
  /** http: streamable HTTP endpoint. */
  url?: string;
  /**
   * Q-ADDONS: folders the owner chose for this server (a Store recipe's folder fields). The tool
   * sandbox makes each existing one visible at its own path; nothing else outside its folder.
   */
  folders?: string[];
}

/** Secret values for a server, stored in the vault as JSON under mcp:<name>. */
export interface McpSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export const mcpVaultKey = (name: string) => `mcp:${name}`;

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * Default permission for an MCP tool: tools the server marks read-only (and not destructive) run
 * without asking; anything that sends, changes or deletes asks first. The owner can change either.
 */
export function mcpDefaultPermission(t: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): 'auto' | 'ask' {
  return t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true ? 'auto' : 'ask';
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } };

interface Transport {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

/**
 * 2.55.2 fix: on Windows, `npx`/`npm` (and every preset that uses them) are `.cmd` shims, which
 * spawn() without a shell can't find (ENOENT), and Node refuses to run `.cmd` files without a shell.
 * npm's shims are run as `node <npm>/bin/npx-cli.js …` instead (no shell, no quoting); a name with an
 * `.exe` on PATH is used as is; any other `.cmd`/`.bat` gets a plain error saying what to do.
 */
export function windowsCommand(command: string, args: string[], pathVar = process.env.PATH, platform = process.platform, nodeExe = process.execPath): [string, string[]] {
  if (platform !== 'win32' || extname(command).toLowerCase() === '.exe') return [command, args];
  const base = command.replace(/\.(cmd|bat)$/i, '');
  const dirs = isAbsolute(command) ? [dirname(command)] : [...(pathVar ?? '').split(delimiter).filter(Boolean), dirname(nodeExe)];
  const name = isAbsolute(command) ? base.slice(dirname(command).length + 1) : base;
  for (const d of dirs) {
    if (existsSync(join(d, `${name}.exe`))) return [join(d, `${name}.exe`), args];
    if (/^(npx|npm)$/i.test(name) && (existsSync(join(d, `${name}.cmd`)) || d === dirname(nodeExe))) {
      const cli = join(d, 'node_modules', 'npm', 'bin', `${name.toLowerCase()}-cli.js`);
      if (existsSync(cli)) return [nodeExe, [cli, ...args]];
    }
    if (existsSync(join(d, `${name}.cmd`)) || existsSync(join(d, `${name}.bat`))) {
      throw new Error(`On Windows, "${command}" is a .cmd script, which Sara starts without a shell. Use its .exe, or "node" with the server's script path (often in node_modules/<package>/dist/index.js).`);
    }
  }
  return [command, args];
}

class StdioTransport implements Transport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #buf = '';
  #stderr = '';
  #exited: string | undefined;

  constructor(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, as?: { uid: number; gid: number }) {
    this.#child = spawn(file, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], ...(as ?? {}) });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (d: string) => this.#onData(d));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (d: string) => {
      this.#stderr = (this.#stderr + d).slice(-2000);
    });
    const onExit = (why: string) => {
      this.#exited = why;
      for (const p of this.#pending.values()) p.reject(new Error(`MCP server stopped (${why}). ${this.#stderr.trim().slice(-500)}`));
      this.#pending.clear();
    };
    this.#child.on('error', (e) => onExit(e.message));
    this.#child.on('exit', (code, sig) => onExit(sig ? `signal ${sig}` : `exit code ${code}`));
  }

  #onData(d: string): void {
    this.#buf += d;
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout
      }
      if (typeof msg.id !== 'number') continue; // notifications / server requests ignored
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  #write(obj: unknown): void {
    if (this.#exited) throw new Error(`MCP server is not running (${this.#exited}). ${this.#stderr.trim().slice(-500)}`);
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        try {
          this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } });
        } catch {
          // ignore
        }
        reject(new Error('Cancelled.'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.#pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  close(): void {
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => this.#child.kill('SIGKILL'), 2000).unref();
    this.#child.kill('SIGTERM');
  }
}

class HttpTransport implements Transport {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #session: string | undefined;
  #protocol: string | undefined;
  #nextId = 1;

  constructor(url: string, headers: Record<string, string>) {
    this.#url = url;
    this.#headers = headers;
  }

  #post(body: unknown, signal: AbortSignal): Promise<Response> {
    return netFetch(this.#url, {
      method: 'POST',
      signal,
      headers: {
        ...this.#headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
        ...(this.#protocol ? { 'mcp-protocol-version': this.#protocol } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    let res: Response;
    try {
      res = await this.#post({ jsonrpc: '2.0', id, method, params }, signal);
    } catch (err) {
      // Q-ADDONS: "fetch failed" said nothing; a program that is not running (Storybook, say) is named.
      if (!signal.aborted && err instanceof TypeError) throw new Error(`${HTTP_UNREACHABLE} (${this.#url})`);
      throw err;
    }
    const type = res.headers.get('content-type') ?? '';
    // B2: a web page (ComfyUI's own address, say) answers 405 or HTML, not JSON-RPC.
    if (res.status === 405 || /text\/html/i.test(type)) throw new Error(`${WEB_PAGE_ANSWER} (HTTP ${res.status})`);
    if (res.status === 401 || res.status === 403) throw new Error(`${HTTP_KEY_REFUSED} (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const session = res.headers.get('mcp-session-id');
    if (session) this.#session = session;
    let msg: JsonRpcResponse | undefined;
    if (type.includes('text/event-stream') && res.body) {
      for await (const ev of sseEvents(res.body)) {
        try {
          const m = JSON.parse(ev.data) as JsonRpcResponse;
          if (m.id === id) {
            msg = m;
            break;
          }
        } catch {
          // ignore non-JSON events
        }
      }
    } else {
      const body = await res.text();
      try { msg = JSON.parse(body) as JsonRpcResponse; } catch { msg = undefined; }
      if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') throw new Error(`${WEB_PAGE_ANSWER} (HTTP ${res.status})`);
    }
    if (!msg) throw new Error('MCP server sent no response.');
    if (msg.error) throw new Error(msg.error.message);
    if (method === 'initialize') this.#protocol = (msg.result as { protocolVersion?: string })?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    return msg.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.#post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, AbortSignal.timeout(15_000));
    await res.body?.cancel();
  }

  close(): void {
    if (!this.#session) return;
    netFetch(this.#url, { method: 'DELETE', headers: { ...this.#headers, 'mcp-session-id': this.#session } }).catch(() => {});
  }
}

export type McpStatus = 'stopped' | 'connecting' | 'ready' | 'error';

export class McpConnection {
  readonly config: McpServerConfig;
  status: McpStatus = 'stopped';
  error = '';
  tools: McpToolInfo[] = [];
  #transport: Transport | undefined;
  #egress: EgressSetup | undefined;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async connect(secrets: McpSecrets, o: { dataDir: string; sandbox: SandboxInfo; timeoutMs?: number }): Promise<void> {
    // EC8: tool servers keep the computer's own sandbox when commands use a container.
    const opts = { ...o, sandbox: nativeOf(o.sandbox) };
    this.status = 'connecting';
    this.error = '';
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    try {
      // EC9: under bubblewrap or the macOS sandbox a tool server with network reaches only the
      // allowlist's hosts (the same proxy as commands; refusals are audited as mcp:<name>).
      const allow = !privateLocalOn() && (opts.sandbox.mode === 'bwrap' || opts.sandbox.mode === 'seatbelt') && this.config.transport !== 'http' ? egressAllowlist() : undefined;
      this.#egress?.close().catch(() => {});
      this.#egress = allow ? await openEgress({ ...opts.sandbox, network: true }, allow, { who: `mcp:${this.config.name}`.slice(0, 60), node: sandboxNode(process.execPath, runtimeMountArgs().length > 0, RUNTIME_MOUNT) }) : undefined;
      this.#transport = this.#makeTransport(secrets, opts);
      await this.#transport.request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'sara', version: '0.2' } },
        timeout,
      );
      await this.#transport.notify('notifications/initialized');
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = (await this.#transport.request('tools/list', cursor ? { cursor } : {}, timeout)) as { tools?: McpToolInfo[]; nextCursor?: string };
        tools.push(...(r.tools ?? []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      this.tools = tools;
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = (err as Error).message;
      this.close();
      this.status = 'error';
    }
  }

  #makeTransport(secrets: McpSecrets, opts: { dataDir: string; sandbox: SandboxInfo }): Transport {
    const c = this.config;
    if (c.transport === 'http') {
      if (!c.url) throw new Error('No URL set.');
      return new HttpTransport(c.url, secrets.headers ?? {});
    }
    if (!c.command) throw new Error('No command set.');
    const home = join(opts.dataDir, 'mcp', c.name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: opts.sandbox.mode === 'bwrap' || process.platform !== 'darwin' ? `${opts.sandbox.mode === 'bwrap' && runtimeMountArgs().length ? `${RUNTIME_MOUNT}/bin:` : ''}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` : commandPath('darwin'),
      LANG: 'C.UTF-8',
      ...(process.platform === 'win32' ? { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...secrets.env,
      // Phase 67: private local mode: the add-on gets no network where the sandbox can enforce it
      // (bubblewrap, macOS) and the no-network settings everywhere else (best effort).
      ...(privateLocalOn() ? PRIVATE_LOCAL_ENV : {}),
      ...(this.#egress?.env ?? {}),
    };
    const eg = this.#egress;
    const net = !privateLocalOn() && !eg;
    if (opts.sandbox.mode === 'bwrap') {
      const cmd = eg?.prefix ? ['/bin/sh', '-c', `${eg.prefix}exec "$@"`, 'sara-mcp', c.command, ...(c.args ?? [])] : [c.command, ...(c.args ?? [])];
      return new StdioTransport('bwrap', [...bwrapArgs(home, net, [...mcpBinds(c, opts.dataDir), ...mcpBrowserBinds(), ...(eg?.binds ?? [])]), ...cmd], { ...baseEnv, HOME: '/workspace' }, home);
    }
    if (opts.sandbox.mode === 'seatbelt') {
      // macOS: the add-on runs inside the sandbox too, with its own folder as home (network on).
      const profile = seatbeltProfile({ workspace: home, tmp: tmpdir(), ...(opts.sandbox.dataDir ? { dataDir: opts.sandbox.dataDir } : {}), ...(eg?.proxyPort ? { proxyPort: eg.proxyPort } : {}) }, net);
      return new StdioTransport(SANDBOX_EXEC, ['-p', profile, c.command, ...(c.args ?? [])], { ...baseEnv, HOME: home }, home);
    }
    if (opts.sandbox.mode === 'user') {
      // Containers: the server runs as the separate tools user (can't read Sara's data).
      prepareForToolsUser(home, opts.sandbox.gid!);
      return new StdioTransport(c.command, c.args ?? [], { ...baseEnv, HOME: home }, home, { uid: opts.sandbox.uid!, gid: opts.sandbox.gid! });
    }
    const [file, args] = windowsCommand(c.command, c.args ?? [], baseEnv.PATH);
    return new StdioTransport(file, args, { ...baseEnv, HOME: home }, home);
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, ctx?: Pick<ToolContext, 'attachImage' | 'saveImage'>): Promise<string> {
    if (!this.#transport || this.status !== 'ready') throw new ToolError(`MCP server "${this.config.name}" is not connected${this.error ? `: ${this.error}` : ''}.`);
    let r: { content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]; isError?: boolean; structuredContent?: unknown };
    try {
      r = (await this.#transport.request('tools/call', { name, arguments: args }, AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]))) as typeof r;
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    let images = 0;
    const parts = (r.content ?? []).map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      if (c.type === 'image' && typeof c.data === 'string') return imageBlock(c.data, c.mimeType ?? '', ++images, ctx);
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`;
    });
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
    const text = clip(parts.join('\n') || '(no output)', 40_000);
    if (r.isError) throw new ToolError(text);
    return text;
  }

  close(): void {
    this.#transport?.close();
    this.#transport = undefined;
    this.#egress?.close().catch(() => {});
    this.#egress = undefined;
    this.status = 'stopped';
  }
}

/** B2: what an HTTP test says when the address is a web page, not a tool server. */
export const WEB_PAGE_ANSWER = en('That address answered like a web page, not a tool server. If this program needs an address of another service (like ComfyUI), put it in that setting instead.');
/** Q-ADDONS: what a test says when an HTTP tool server refuses the key (or none was saved). */
export const HTTP_KEY_REFUSED = en('The tool server refused the sign-in. Check the key or token saved for it (or add one).');
/** Q-ADDONS: what a test says when nothing answers at an HTTP tool server's address. */
export const HTTP_UNREACHABLE = en('Nothing answered at this address. Check that the program is running and the address is right.');

/** B2: what Sara may show from an MCP image block: like her photos (uploads.ts), at most 4 a call. */
const MCP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MCP_IMAGE_BYTES = 8 * 1024 * 1024;
const MCP_IMAGES_PER_CALL = 4;
function imageBlock(data: string, mime: string, n: number, ctx?: Pick<ToolContext, 'attachImage' | 'saveImage'>): string {
  if (!ctx?.attachImage || !ctx.saveImage) return "Image not attached: pictures from tools can't be shown here.";
  if (!MCP_IMAGE_TYPES.includes(mime.toLowerCase())) return `Image not attached: ${mime || 'this'} pictures can't be shown; only PNG, JPEG, WebP or GIF.`;
  if (n > MCP_IMAGES_PER_CALL) return `Image not attached: at most ${MCP_IMAGES_PER_CALL} pictures per tool call.`;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MCP_IMAGE_BYTES) return `Image not attached: it is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; pictures can be up to ${MCP_IMAGE_BYTES / 1024 / 1024} MB.`;
  try {
    ctx.attachImage(ctx.saveImage(bytes));
  } catch (err) {
    return `Image not attached: ${(err as Error).message}`;
  }
  return `Image attached to your reply (${Math.max(1, Math.round(bytes.length / 1024))} KB). It is shown to the owner with your message.`;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** Owns the MCP connections and keeps their tools registered. */
export class McpManager {
  readonly #connections = new Map<string, McpConnection>();
  readonly #registry: ToolRegistry;
  readonly #deps: { dataDir: string; sandbox: SandboxInfo; secrets: (name: string) => McpSecrets };

  constructor(registry: ToolRegistry, deps: { dataDir: string; sandbox: SandboxInfo; secrets: (name: string) => McpSecrets }) {
    this.#registry = registry;
    this.#deps = deps;
  }

  get(name: string): McpConnection | undefined {
    return this.#connections.get(name);
  }

  async start(config: McpServerConfig): Promise<McpConnection> {
    this.stop(config.name);
    const conn = new McpConnection(config);
    this.#connections.set(config.name, conn);
    if (!config.enabled) return conn;
    await conn.connect(this.#deps.secrets(config.name), this.#deps);
    if (this.#connections.get(config.name) !== conn) {
      conn.close();
      return conn;
    }
    // Phase 123: the server's list may have changed: its schema sizes are measured again.
    clearSizes();
    for (const t of conn.tools) this.#registry.add(this.#wrap(conn, t));
    return conn;
  }

  stop(name: string): void {
    const conn = this.#connections.get(name);
    if (!conn) return;
    for (const t of conn.tools) this.#registry.remove(mcpToolName(name, t.name));
    conn.close();
    this.#connections.delete(name);
  }

  async startAll(configs: McpServerConfig[]): Promise<void> {
    await Promise.all(configs.map((c) => this.start(c)));
  }

  stopAll(): void {
    for (const name of [...this.#connections.keys()]) this.stop(name);
  }

  #wrap(conn: McpConnection, t: McpToolInfo): Tool {
    const name = mcpToolName(conn.config.name, t.name);
    return {
      defaultPermission: mcpDefaultPermission(t),
      source: `MCP: ${conn.config.name}`,
      isAvailable: () => conn.status === 'ready',
      spec: {
        name,
        description: `[${conn.config.name}] ${t.description ?? t.name}`.slice(0, 1000),
        parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      },
      summarize: (a) => `${conn.config.name}: ${t.name} ${clip(JSON.stringify(a), 160)}`,
      run: (args, ctx) => conn.callTool(t.name, args, ctx.signal, ctx),
    };
  }
}

export function validateMcpConfig(input: Record<string, unknown>, name: string): McpServerConfig {
  if (!MCP_NAME_RE.test(name)) throw new Error('Server name: lowercase letters, digits and dashes (max 31).');
  const transport = input.transport === 'http' ? 'http' : input.transport === 'stdio' ? 'stdio' : undefined;
  if (!transport) throw new Error('transport must be stdio or http');
  const cfg: McpServerConfig = { name, transport, enabled: input.enabled !== false };
  const folders = Array.isArray(input.folders) ? input.folders.map((f) => String(f).trim()).filter((f) => (isAbsolute(f) || win32.isAbsolute(f)) && !/^([A-Za-z]:)?[\\/]*$/.test(f)).slice(0, 8) : [];
  if (transport === 'http') {
    let u: URL;
    try {
      u = new URL(String(input.url ?? ''));
    } catch {
      throw new Error('A valid URL is required for HTTP servers.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL must be http or https.');
    cfg.url = u.href;
  } else {
    const command = String(input.command ?? '').trim();
    if (!command) throw new Error('A command is required for stdio servers.');
    cfg.command = command;
    const args = Array.isArray(input.args) ? input.args.map(String) : typeof input.args === 'string' ? splitArgs(input.args) : [];
    cfg.args = args;
    if (folders.length) cfg.folders = folders;
  }
  return cfg;
}

/** The sandbox binds for a server's granted folders: existing ones only, never inside Sara's data. */
export function mcpBinds(cfg: McpServerConfig, dataDir: string): Bind[] {
  const data = resolve(dataDir);
  return (cfg.folders ?? []).filter((f) => {
    const rel = relative(data, resolve(f));
    const inData = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    return !inData && existsSync(f);
  }).map((f) => ({ src: f, dest: f, rw: true }));
}

/** Installed browsers' system folders, mounted read-only so browser tool servers (Playwright, Chrome
 *  DevTools) find the Chrome the owner installed instead of reporting it missing. */
const BROWSER_DIRS = ['/opt/google/chrome', '/opt/microsoft/msedge', '/usr/lib/chromium', '/usr/lib64/chromium-browser'];
export function mcpBrowserBinds(exists: (p: string) => boolean = existsSync): Bind[] {
  return BROWSER_DIRS.filter((d) => exists(d)).map((d) => ({ src: d, dest: d, rw: false }));
}

/** Splits a command-line string into arguments, honouring simple quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Ready-made servers the owner can add from Settings (secrets are filled in by the owner). */
export interface McpPreset {
  id: string;
  label: string;
  help: string;
  name: string;
  command: string;
  args: string[];
  secrets: { name: string; hint: string }[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'email',
    label: 'Email (IMAP/SMTP: Gmail, iCloud, Outlook, Fastmail, …)',
    help: 'Uses an app password, not your normal password (Gmail: myaccount.google.com/apppasswords; iCloud: appleid.apple.com). Reading and searching run on their own; sending, replying, moving and deleting always ask you first. Gmail: imap.gmail.com / smtp.gmail.com.',
    name: 'email',
    command: 'npx',
    args: ['-y', 'mcp-mail-server@2.1.2'],
    secrets: [
      { name: 'IMAP_HOST', hint: 'imap.gmail.com' },
      { name: 'IMAP_PORT', hint: '993' },
      { name: 'IMAP_SECURE', hint: 'true' },
      { name: 'SMTP_HOST', hint: 'smtp.gmail.com' },
      { name: 'SMTP_PORT', hint: '465' },
      { name: 'SMTP_SECURE', hint: 'true' },
      { name: 'EMAIL_USER', hint: 'you@gmail.com' },
      { name: 'EMAIL_ADDRESS', hint: 'you@gmail.com' },
      { name: 'EMAIL_PASS', hint: 'app password' },
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar (CalDAV: iCloud, Fastmail, Nextcloud, …)',
    help: 'Uses an app password. iCloud: https://caldav.icloud.com with your Apple ID; Fastmail: https://caldav.fastmail.com. Google Calendar is not supported here (Google requires its own sign-in). Looking at your calendar runs on its own; creating, changing or deleting events asks you first.',
    name: 'calendar',
    command: 'npx',
    args: ['-y', '@ni-c/caldav-mcp@0.1.5'],
    secrets: [
      { name: 'CALDAV_URL', hint: 'https://caldav.icloud.com' },
      { name: 'CALDAV_USERNAME', hint: 'you@icloud.com' },
      { name: 'CALDAV_PASSWORD', hint: 'app password' },
      { name: 'CALDAV_TIMEZONE', hint: 'America/Chicago' },
      { name: 'CALDAV_ALLOW_TOOLS', hint: 'essential' },
    ],
  },
];

// Model Context Protocol client: connects to MCP servers (stdio or streamable HTTP), lists their
// tools and exposes them through the tool registry as mcp_<server>_<tool>. Stdio servers run in the
// same bubblewrap sandbox as shell commands, with their own home directory.
//
// C3: dual-era. A server is first probed with `server/discover` on the stateless 2026-07-28
// revision (every request carries its version, client info and capabilities in params._meta; on
// HTTP also MCP-Protocol-Version, Mcp-Method and Mcp-Name, no session). A recognized modern error
// (-32022 with `supported`) keeps it modern; anything else falls back to the legacy `initialize`
// handshake (2025-11-25 offered, whatever older version the server answers is used). The era is
// remembered per server configuration until a connect with it fails. MCP Apps (extension
// io.modelcontextprotocol/ui): a tool whose _meta.ui.resourceUri names a ui:// page gets that page
// read after the call and kept in memory (McpAppStore) for the web chat's sandboxed frame.
import { randomUUID } from 'node:crypto';
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
import { policy } from '../policy-profile.ts';
import { clip, ToolError, type Permission, type Tool, type ToolContext } from './types.ts';

/** The handshake version the pre-C3 client offered (kept for older qualification tests). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** C3: the stateless revision Sara speaks first. */
export const MCP_MODERN_VERSION = '2026-07-28';
/** C3: the handshake version offered when a server turns out to be legacy. */
export const MCP_LEGACY_OFFER = '2025-11-25';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const UNSUPPORTED_VERSION = -32022;
/** C3: the MCP Apps extension and the page type Sara can show. */
export const MCP_UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** C3: the biggest app page Sara shows (bytes of HTML). */
export const MCP_APP_MAX_BYTES = 512 * 1024;
const CLIENT_INFO = { name: 'sara', version: '0.3' };
/** C3: how long a stdio probe waits before taking the server for legacy (some stay silent). */
const STDIO_PROBE_MS = 15_000;
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
  /** C3: show this server's apps (MCP Apps) in the chat. On unless set to false. */
  apps?: boolean;
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
  _meta?: Record<string, unknown>;
}

/** C3: a tool's MCP Apps metadata (`_meta.ui`; the flat `ui/resourceUri` form is still read). */
export function mcpToolUi(t: Pick<McpToolInfo, '_meta'>): { resourceUri?: string; model: boolean; app: boolean } {
  const ui = (t._meta?.ui && typeof t._meta.ui === 'object' ? t._meta.ui : {}) as { resourceUri?: unknown; visibility?: unknown };
  const uri = typeof ui.resourceUri === 'string' ? ui.resourceUri : typeof t._meta?.['ui/resourceUri'] === 'string' ? (t._meta['ui/resourceUri'] as string) : undefined;
  const vis = Array.isArray(ui.visibility) ? ui.visibility.map(String) : ['model', 'app'];
  return { ...(uri && uri.startsWith('ui://') ? { resourceUri: uri } : {}), model: vis.includes('model'), app: vis.includes('app') };
}

/** C3: a JSON-RPC error from the server, with its code and data (era detection reads them). */
export class McpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const supportedOf = (err: unknown): string[] | undefined => {
  if (!(err instanceof McpRpcError) || err.code !== UNSUPPORTED_VERSION) return undefined;
  const s = (err.data as { supported?: unknown } | undefined)?.supported;
  return Array.isArray(s) ? s.map(String) : [];
};

/** C3: the header form of a name (Mcp-Name): plain when header-safe ASCII, else the base64 sentinel. */
export function mcpHeaderValue(v: string): string {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(v) ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/**
 * Default permission for an MCP tool: tools the server marks read-only (and not destructive) run
 * without asking; anything that sends, changes or deletes asks first. The owner can change either.
 */
export function mcpDefaultPermission(t: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): 'auto' | 'ask' {
  return t.annotations?.readOnlyHint === true && t.annotations.destructiveHint !== true ? 'auto' : 'ask';
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface Transport {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
  /** C3: the modern version every request now declares (HTTP headers; stdio ignores it). */
  modern?: string;
  /** C3: the process stopped (a probe error then is not a reason to try the handshake). */
  readonly exited?: string | undefined;
  onNotification?: (method: string, params: unknown) => void;
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
  onNotification?: (method: string, params: unknown) => void;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #buf = '';
  #stderr = '';
  #exited: string | undefined;
  modern?: string;

  get exited(): string | undefined {
    return this.#exited;
  }

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
      if (typeof msg.id !== 'number') {
        // C4: server notifications (resources/updated, the draft events extension) go to the listener.
        const n = msg as unknown as { method?: unknown; params?: unknown; id?: unknown };
        if (typeof n.method === 'string' && n.id === undefined) this.onNotification?.(n.method, n.params);
        continue; // server requests ignored
      }
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new McpRpcError(Number(msg.error.code), String(msg.error.message ?? 'MCP error'), msg.error.data));
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
  onNotification?: (method: string, params: unknown) => void;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #session: string | undefined;
  #protocol: string | undefined;
  #nextId = 1;
  modern?: string;

  constructor(url: string, headers: Record<string, string>) {
    this.#url = url;
    this.#headers = headers;
  }

  #post(body: { jsonrpc: string; id?: number; method: string; params?: unknown }, signal: AbortSignal): Promise<Response> {
    // C3: a modern request names its version, method and target in headers; no session.
    const p = (body.params ?? {}) as { name?: unknown; uri?: unknown };
    const target = body.method === 'tools/call' || body.method === 'prompts/get' ? p.name : body.method === 'resources/read' ? p.uri : undefined;
    const modern = this.modern ? { 'mcp-protocol-version': this.modern, 'mcp-method': body.method, ...(typeof target === 'string' ? { 'mcp-name': mcpHeaderValue(target) } : {}) } : undefined;
    return netFetch(this.#url, {
      method: 'POST',
      signal,
      headers: {
        ...this.#headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(modern ?? {
          ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
          ...(this.#protocol ? { 'mcp-protocol-version': this.#protocol } : {}),
        }),
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // C3: modern servers answer 400 with a JSON-RPC error body (unsupported version, headers).
      let err: JsonRpcResponse['error'];
      try { err = (JSON.parse(body) as JsonRpcResponse).error; } catch { err = undefined; }
      if (err && typeof err.code === 'number') throw new McpRpcError(err.code, String(err.message ?? ''), err.data);
      throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const session = res.headers.get('mcp-session-id');
    if (session) this.#session = session;
    let msg: JsonRpcResponse | undefined;
    if (type.includes('text/event-stream') && res.body) {
      for await (const ev of sseEvents(res.body)) {
        try {
          const m = JSON.parse(ev.data) as JsonRpcResponse;
          const n = m as unknown as { method?: unknown; params?: unknown; id?: unknown };
          if (typeof n.method === 'string' && n.id === undefined) this.onNotification?.(n.method, n.params);
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
    if (msg.error) throw new McpRpcError(Number(msg.error.code), String(msg.error.message ?? 'MCP error'), msg.error.data);
    if (method === 'initialize') this.#protocol = (msg.result as { protocolVersion?: string })?.protocolVersion ?? MCP_LEGACY_OFFER;
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

/** C3: what a tools/call returned (content blocks, structured content). */
export type McpCallResult = { content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]; isError?: boolean; structuredContent?: unknown };

/** C3: the external origins an app page declared (only plain https/wss origins are kept). */
export type McpAppDomains = { connect: string[]; resource: string[] };
/** C3: an app page read from a ui:// resource. */
export type McpAppPage = { uri: string; html: string; csp: McpAppDomains };

const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** C3: the era a server configuration answered with last time (re-probed after a failed connect). */
const eraCache = new Map<string, 'modern' | 'legacy'>();
const eraKey = (c: McpServerConfig) => JSON.stringify([c.name, c.transport, c.command ?? '', c.args ?? [], c.url ?? '']);
const noCommonVersion = (v: string[]) => `${en('The tool server speaks only MCP versions Sara does not know yet.')} (${v.join(', ') || '?'})`;
export const MCP_INPUT_REQUIRED = en("The tool server asked for more input during this call, which Sara can't give yet.");

export class McpConnection {
  readonly config: McpServerConfig;
  status: McpStatus = 'stopped';
  error = '';
  tools: McpToolInfo[] = [];
  /** C3: 'modern' (2026-07-28, stateless) or 'legacy' (initialize handshake). */
  era: 'modern' | 'legacy' | undefined;
  /** C3: the protocol version in use. */
  protocol = '';
  /** C4: what the server said it can do (initialize result), for resources/subscribe. */
  capabilities: { resources?: { subscribe?: boolean } } = {};
  /** C4: a server notification (the manager forwards it to the event triggers). */
  onNotification?: (method: string, params: unknown) => void;
  #transport: Transport | undefined;
  #egress: EgressSetup | undefined;
  readonly #pages = new Map<string, McpAppPage>();

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  /** C3: client capabilities: the MCP Apps extension unless apps are off for this server. */
  #caps(): Record<string, unknown> {
    return this.config.apps === false ? {} : { extensions: { [MCP_UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } };
  }

  /** C3: one request; modern requests carry version, client and capabilities in params._meta. */
  async #rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const t = this.#transport;
    if (!t) throw new Error('Not connected.');
    const p = this.era === 'modern' ? { ...params, _meta: { ...((params._meta as Record<string, unknown> | undefined) ?? {}), [META_VERSION]: this.protocol, [META_CLIENT]: CLIENT_INFO, [META_CAPS]: this.#caps() } } : params;
    const r = await t.request(method, p, signal);
    if (r && typeof r === 'object' && (r as { resultType?: unknown }).resultType === 'input_required') throw new Error(MCP_INPUT_REQUIRED);
    return r;
  }

  async #legacy(timeout: AbortSignal): Promise<void> {
    const t = this.#transport!;
    this.era = 'legacy';
    t.modern = undefined;
    // Newest first; a strict server that refuses a version gets the next one (or one it names).
    const offers = LEGACY_VERSIONS.slice(0, 3);
    let r: { protocolVersion?: string; capabilities?: { resources?: { subscribe?: boolean } } } | undefined;
    for (let i = 0; ; i++) {
      try {
        r = (await t.request('initialize', { protocolVersion: offers[i], capabilities: this.#caps(), clientInfo: CLIENT_INFO }, timeout)) as typeof r;
        break;
      } catch (err) {
        const named = ((err instanceof McpRpcError ? (err.data as { supported?: unknown } | undefined)?.supported : undefined) ?? []) as unknown[];
        const next = named.map(String).find((v) => offers.includes(v) && offers.indexOf(v) > i);
        if (next) offers.splice(i + 1, 0, next);
        if (!(err instanceof McpRpcError) || t.exited || i + 1 >= offers.length) throw err;
      }
    }
    this.protocol = typeof r?.protocolVersion === 'string' ? r.protocolVersion : offers[0];
    this.capabilities = r?.capabilities && typeof r.capabilities === 'object' ? r.capabilities : {};
    await t.notify('notifications/initialized');
  }

  /** C3: server/discover on 2026-07-28; a recognized modern answer stays modern, anything else is legacy. */
  async #probe(timeout: AbortSignal): Promise<'modern' | 'legacy'> {
    const t = this.#transport!;
    this.era = 'modern';
    this.protocol = MCP_MODERN_VERSION;
    t.modern = MCP_MODERN_VERSION;
    const probe = this.config.transport === 'stdio' ? AbortSignal.any([timeout, AbortSignal.timeout(STDIO_PROBE_MS)]) : timeout;
    let result: { supportedVersions?: unknown; capabilities?: { resources?: { subscribe?: boolean } } } | undefined;
    let failure: unknown;
    try {
      result = (await this.#rpc('server/discover', {}, probe)) as typeof result;
    } catch (err) {
      failure = err;
    }
    if (!failure) {
      // A server that answers any method alike (no supportedVersions) is not a modern one.
      if (!Array.isArray(result?.supportedVersions)) return 'legacy';
      const v = result.supportedVersions.map(String);
      if (v.includes(MCP_MODERN_VERSION)) {
        this.capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
        return 'modern';
      }
      if (v.some((x) => LEGACY_VERSIONS.includes(x))) return 'legacy';
      throw new Error(noCommonVersion(v));
    }
    if (timeout.aborted) throw failure;
    const supported = supportedOf(failure);
    if (supported) {
      if (supported.some((x) => LEGACY_VERSIONS.includes(x)) && !supported.includes(MCP_MODERN_VERSION)) return 'legacy';
      throw supported.includes(MCP_MODERN_VERSION) ? failure : new Error(noCommonVersion(supported));
    }
    // The program stopped, or nothing answers at the address: no handshake would help.
    if (t.exited || (failure instanceof Error && failure.message.startsWith(HTTP_UNREACHABLE))) throw failure;
    return 'legacy';
  }

  async connect(secrets: McpSecrets, o: { dataDir: string; sandbox: SandboxInfo; timeoutMs?: number }): Promise<void> {
    // EC8: tool servers keep the computer's own sandbox when commands use a container.
    const opts = { ...o, sandbox: nativeOf(o.sandbox) };
    this.status = 'connecting';
    this.error = '';
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const key = eraKey(this.config);
    try {
      // EC9: under bubblewrap or the macOS sandbox a tool server with network reaches only the
      // allowlist's hosts (the same proxy as commands; refusals are audited as mcp:<name>).
      const allow = !privateLocalOn() && (opts.sandbox.mode === 'bwrap' || opts.sandbox.mode === 'seatbelt') && this.config.transport !== 'http' ? egressAllowlist() : undefined;
      this.#egress?.close().catch(() => {});
      this.#egress = allow ? await openEgress({ ...opts.sandbox, network: true }, allow, { who: `mcp:${this.config.name}`.slice(0, 60), node: sandboxNode(process.execPath, runtimeMountArgs().length > 0, RUNTIME_MOUNT) }) : undefined;
      this.#transport = this.#makeTransport(secrets, opts);
      this.#transport.onNotification = (m, p) => this.onNotification?.(m, p);
      // C3: a server known to be legacy skips the probe (a silent one would cost the probe's wait).
      const era = eraCache.get(key) === 'legacy' ? 'legacy' : await this.#probe(timeout);
      if (era === 'legacy') await this.#legacy(timeout);
      eraCache.set(key, era);
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = (await this.#rpc('tools/list', cursor ? { cursor } : {}, timeout)) as { tools?: McpToolInfo[]; nextCursor?: string };
        tools.push(...(r.tools ?? []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      this.tools = tools;
      this.status = 'ready';
    } catch (err) {
      eraCache.delete(key);
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

  /** C3: the raw tools/call result (MCP Apps get its structured content). */
  async callRaw(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (!this.#transport || this.status !== 'ready') throw new ToolError(`MCP server "${this.config.name}" is not connected${this.error ? `: ${this.error}` : ''}.`);
    try {
      return ((await this.#rpc('tools/call', { name, arguments: args }, AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]))) ?? {}) as McpCallResult;
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  }

  /** The result as text for the model (pictures attached); a tool error throws. */
  format(r: McpCallResult, ctx?: Pick<ToolContext, 'attachImage' | 'saveImage'>): string {
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

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, ctx?: Pick<ToolContext, 'attachImage' | 'saveImage'>): Promise<string> {
    return this.format(await this.callRaw(name, args, signal), ctx);
  }

  /** C3: reads an app page (ui://): the MCP Apps type, at most MCP_APP_MAX_BYTES; kept for the connection. */
  async readApp(uri: string, signal: AbortSignal): Promise<McpAppPage> {
    const known = this.#pages.get(uri);
    if (known) return known;
    if (!uri.startsWith('ui://')) throw new Error('not a ui:// page');
    const r = (await this.#rpc('resources/read', { uri }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))) as { contents?: { uri?: string; mimeType?: string; text?: unknown; blob?: unknown; _meta?: { ui?: { csp?: unknown } } }[] };
    const c = (r?.contents ?? []).find((x) => x.uri === uri) ?? r?.contents?.[0];
    if (!c) throw new Error('the server sent no page');
    if (!isAppMime(c.mimeType)) throw new Error(`its page type (${String(c.mimeType ?? 'none').slice(0, 60)}) is not an MCP App page`);
    const tooBig = new Error(`its page is over ${MCP_APP_MAX_BYTES / 1024} KB`);
    if (typeof c.blob === 'string' && c.blob.length > Math.ceil((MCP_APP_MAX_BYTES * 4) / 3) + 4) throw tooBig;
    const html = typeof c.text === 'string' ? c.text : typeof c.blob === 'string' ? Buffer.from(c.blob, 'base64').toString('utf8') : '';
    if (Buffer.byteLength(html, 'utf8') > MCP_APP_MAX_BYTES) throw tooBig;
    if (!html.trim()) throw new Error('its page is empty');
    const page: McpAppPage = { uri, html, csp: mcpAppDomains(c._meta?.ui?.csp) };
    this.#pages.set(uri, page);
    return page;
  }

  /** C4: resources/subscribe, when the server offers it (false otherwise; never throws). */
  async subscribe(uri: string): Promise<boolean> {
    if (!this.#transport || this.status !== 'ready' || this.capabilities.resources?.subscribe !== true) return false;
    try {
      await this.#rpc('resources/subscribe', { uri }, AbortSignal.timeout(15_000));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#transport?.close();
    this.#transport = undefined;
    this.#egress?.close().catch(() => {});
    this.#egress = undefined;
    this.#pages.clear();
    this.status = 'stopped';
  }
}

const isAppMime = (m: unknown): boolean => typeof m === 'string' && m.toLowerCase().replace(/[\s"]/g, '') === MCP_APP_MIME;

/** C3: the declared origins, kept only when each is a plain https (or wss for connections) origin. */
export function mcpAppDomains(raw: unknown): McpAppDomains {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { connectDomains?: unknown; resourceDomains?: unknown };
  const pick = (v: unknown, schemes: string) => (Array.isArray(v) ? v.map(String).filter((d) => new RegExp(`^(${schemes})://(\\*\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)*(:\\d{1,5})?$`, 'i').test(d)).slice(0, 8) : []);
  return { connect: pick(r.connectDomains, 'https|wss'), resource: pick(r.resourceDomains, 'https') };
}

/**
 * C3: the Content-Security-Policy an app page is served with. `sandbox allow-scripts` (never
 * allow-same-origin) gives it an opaque origin even if opened on its own: no cookies, storage, or
 * Sara's API; no forms, popups, nested frames or plugins; only the origins it declared.
 */
export function mcpAppCsp(d: McpAppDomains): string {
  const res = d.resource.length ? ` ${d.resource.join(' ')}` : '';
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline'${res}`,
    `style-src 'unsafe-inline'${res}`,
    `img-src data: blob:${res}`,
    `media-src data: blob:${res}`,
    `font-src data:${res}`,
    `connect-src ${d.connect.length ? d.connect.join(' ') : "'none'"}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** C3: what the web chat shows for an app (the page itself is fetched through its frame address). */
export type McpAppCard = { kind: 'mcp-app'; id: string; server: string; tool: string; title: string };

/** C3: an app shown in a conversation: its page, the call that opened it, where it may ask. */
export interface McpAppRecord {
  id: string;
  server: string;
  tool: string;
  uri: string;
  html: string;
  csp: McpAppDomains;
  conversationId: string;
  input: Record<string, unknown>;
  result: McpCallResult;
  createdAt: number;
}

/** C3: open apps, in memory (an app from before a restart says so and can be asked for again). */
export class McpAppStore {
  readonly #apps = new Map<string, McpAppRecord>();
  readonly #max: number;
  constructor(max = 40) {
    this.#max = max;
  }
  add(r: Omit<McpAppRecord, 'id' | 'createdAt'>): McpAppRecord {
    const rec = { ...r, id: randomUUID(), createdAt: Date.now() };
    this.#apps.set(rec.id, rec);
    for (const k of this.#apps.keys()) {
      if (this.#apps.size <= this.#max) break;
      this.#apps.delete(k);
    }
    return rec;
  }
  get(id: string): McpAppRecord | undefined {
    return this.#apps.get(id);
  }
  dropServer(server: string): void {
    for (const [k, v] of this.#apps) if (v.server === server) this.#apps.delete(k);
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
  /** C3: the apps open in conversations. */
  readonly apps = new McpAppStore();

  constructor(registry: ToolRegistry, deps: { dataDir: string; sandbox: SandboxInfo; secrets: (name: string) => McpSecrets }) {
    this.#registry = registry;
    this.#deps = deps;
  }

  get(name: string): McpConnection | undefined {
    return this.#connections.get(name);
  }

  /** C4: every server's notifications (server name, method, params): the event triggers listen. */
  onNotification?: (server: string, method: string, params: unknown) => void;
  /** C4: called after a server connects (the triggers subscribe to the resources they watch). */
  onReady?: (conn: McpConnection) => void;

  async start(config: McpServerConfig): Promise<McpConnection> {
    this.stop(config.name);
    const conn = new McpConnection(config);
    conn.onNotification = (m, p) => this.onNotification?.(config.name, m, p);
    this.#connections.set(config.name, conn);
    if (!config.enabled) return conn;
    await conn.connect(this.#deps.secrets(config.name), this.#deps);
    if (this.#connections.get(config.name) !== conn) {
      conn.close();
      return conn;
    }
    // Phase 123: the server's list may have changed: its schema sizes are measured again.
    clearSizes();
    // C3 (MCP Apps): tools only an app may call (visibility ["app"]) are not offered to the model.
    for (const t of conn.tools) if (mcpToolUi(t).model) this.#registry.add(this.#wrap(conn, t));
    if (conn.status === 'ready') this.onReady?.(conn);
    return conn;
  }

  stop(name: string): void {
    const conn = this.#connections.get(name);
    if (!conn) return;
    for (const t of conn.tools) this.#registry.remove(mcpToolName(name, t.name));
    conn.close();
    this.#connections.delete(name);
    this.apps.dropServer(name);
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
      run: async (args, ctx) => {
        const raw = await conn.callRaw(t.name, args, ctx.signal);
        const text = conn.format(raw, ctx);
        const uri = mcpToolUi(t).resourceUri;
        if (!uri || conn.config.apps === false || !ctx.attachAppCard || !ctx.conversationId) return text;
        // C3: the tool has an app: its page is read and shown with the result in the chat.
        try {
          const page = await conn.readApp(uri, ctx.signal);
          const rec = this.apps.add({ server: conn.config.name, tool: t.name, uri, html: page.html, csp: page.csp, conversationId: ctx.conversationId, input: args, result: appResult(raw) });
          ctx.attachAppCard({ kind: 'mcp-app', id: rec.id, server: conn.config.name, tool: t.name, title: clip(t.description ?? t.name, 80) });
          return `${text}\n(Its app is shown to the owner in the chat.)`;
        } catch (err) {
          return `${text}\nApp not shown: ${(err as Error).message}.`;
        }
      },
    };
  }

  /** C3: an app's tool, checked: the app is open, the tool is its own server's and open to apps. */
  appTool(appId: string, name: string): { rec: McpAppRecord; conn: McpConnection; tool: McpToolInfo; toolName: string } {
    const rec = this.apps.get(appId);
    if (!rec) throw new ToolError(en('This app is no longer open. Ask Sara to show it again.'));
    const conn = this.#connections.get(rec.server);
    if (!conn || conn.status !== 'ready') throw new ToolError(`MCP server "${rec.server}" is not connected.`);
    if (conn.config.apps === false) throw new ToolError(en('Apps are turned off for this tool server.'));
    const tool = conn.tools.find((x) => x.name === name);
    if (!tool) throw new ToolError(`The tool server has no tool "${clip(name, 80)}".`);
    if (!mcpToolUi(tool).app) throw new ToolError(en('That tool is not open to apps.'));
    return { rec, conn, tool, toolName: mcpToolName(rec.server, name) };
  }

  /** C3: the permission an app's call has: the tool's own (owner's choice, server choice, policy). */
  appPermission(appId: string, name: string, overrides: Record<string, Permission> | undefined): Permission {
    const { tool, toolName } = this.appTool(appId, name);
    if (this.#registry.get(toolName)) return this.#registry.permission(toolName, overrides);
    return policy().clamp(toolName, overrides?.[toolName] ?? this.#registry.policyFor?.(toolName) ?? mcpDefaultPermission(tool), undefined);
  }

  /** C3: runs a call an app asked for (after the permission check and any approval). */
  async callFromApp(appId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const { conn, rec } = this.appTool(appId, name);
    const r = appResult(await conn.callRaw(name, args, signal));
    // The chat may redraw (and reload) the app while a call waits: it then starts from the latest result.
    if (!r.isError) rec.result = r;
    return r;
  }
}

/** C3: what an app gets back from a call: content blocks and structured content, size-capped. */
function appResult(r: McpCallResult): McpCallResult {
  const out: McpCallResult = { content: (r.content ?? []).slice(0, 20), ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
  return JSON.stringify(out).length > 256 * 1024 ? { content: [{ type: 'text', text: clip((r.content ?? []).map((c) => c.text ?? '').join('\n'), 40_000) }], ...(r.isError ? { isError: true } : {}) } : out;
}

export function validateMcpConfig(input: Record<string, unknown>, name: string): McpServerConfig {
  if (!MCP_NAME_RE.test(name)) throw new Error('Server name: lowercase letters, digits and dashes (max 31).');
  const transport = input.transport === 'http' ? 'http' : input.transport === 'stdio' ? 'stdio' : undefined;
  if (!transport) throw new Error('transport must be stdio or http');
  const cfg: McpServerConfig = { name, transport, enabled: input.enabled !== false, ...(input.apps === false ? { apps: false } : {}) };
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

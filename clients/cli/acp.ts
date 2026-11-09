// EC14 (docs/ops/EC14_DESIGN.md, docs/EDITORS.md): Sara as the coding agent of editors that speak
// the Agent Client Protocol (Zed, JetBrains and others). Protocol version 1: JSON-RPC 2.0, one
// message per line over stdio (agentclientprotocol.com, schema release schema-v1.29.1).
//
//   sara-chat acp            (or `sara acp` on the server's computer) the editor starts this
//   sara-chat acp login      sign in once with a device code (the same sign-in as sara-chat)
//
// It talks to a running Sara with the saved sara-chat sign-in (--server <name> picks one) or
// SARA_URL + SARA_TOKEN. Each editor session is a coding chat on the server (the session id is the
// conversation id). When the editor offers its files, her file tools run in the editor's folder:
// reads and writes through the editor, listing and search on disk (read only), commands in the
// editor's terminal. Every write and command asks in the editor unless her own card already asked.
// Nothing is printed to stdout but protocol messages; notes go to stderr.
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiError, Client, configDir, findProfile, loadConfig, login, sseEvents, VERSION, type Io } from './sara.ts';

export const PROTOCOL_VERSION = 1;
const MAX_READ = 200_000;
const MAX_PROMPT = 90_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', 'coverage']);
/** Never read, listed or written for her: env files, keys, certificates, credentials, secret folders. */
export const EDITOR_SECRET = /(^\.env($|\.)|^\.npmrc$|^\.pypirc$|^\.netrc$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|gpg)$|^credentials(\.\w+)?$|\.tfstate$|^keystore\.properties$|^\.?secrets$|^\.ssh$|^\.aws$|^\.gnupg$)/i;

type Json = Record<string, unknown>;
interface Caps {
  read: boolean;
  write: boolean;
  terminal: boolean;
  authTerminal: boolean;
}
interface Session {
  id: string;
  cwd: string;
  turn?: { ctl: AbortController; cancelled: boolean };
  /** "Allow edits in this folder for this session" was picked. */
  editsOk: boolean;
  /** Commands allowed for this session ("Always allow this exact command"). */
  commandsOk: Set<string>;
}

export class AcpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const authRequired = () => new AcpError(-32000, 'Authentication required: sign in to Sara first (run "sara-chat acp login <address>" in a terminal).');

/** A path inside the session folder (relative or absolute), or a plain-words error. */
export function insideFolder(root: string, p: string): { abs: string; rel: string } {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p || '.');
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${p} is outside the folder open in the editor.`);
  if (rel.split(/[\\/]+/).some((part) => EDITOR_SECRET.test(part))) throw new Error("Sara doesn't read or change env files, keys or credentials.");
  return { abs, rel: rel.split(sep).join('/') || '.' };
}

/** The kind ACP editors draw a tool call with. */
export function toolKind(name: string): string {
  if (name === 'read_file' || name === 'list_dir') return 'read';
  if (name === 'write_file' || name === 'edit_file') return 'edit';
  if (name === 'search') return 'search';
  if (name === 'shell') return 'execute';
  if (name === 'web_fetch' || name === 'web_search') return 'fetch';
  return 'other';
}

/** edit_file's replacement (the same rules as her own tool, CRLF files included). */
export function applyEdit(text: string, args: Json): string {
  const oldS = String(args.old_string ?? '');
  const newS = typeof args.new_string === 'string' ? args.new_string : '';
  if (!oldS) throw new Error('old_string is empty.');
  let find = oldS;
  let put = newS;
  let count = text.split(find).length - 1;
  if (count === 0 && text.includes('\r\n') && oldS.includes('\n') && !oldS.includes('\r\n')) {
    find = oldS.replace(/\n/g, '\r\n');
    put = newS.replace(/\r?\n/g, '\r\n');
    count = text.split(find).length - 1;
  }
  if (count === 0) throw new Error('old_string was not found in the file. Read the file again and copy the text exactly.');
  if (count > 1 && args.replace_all !== true) throw new Error(`old_string matches ${count} places. Add more context or set replace_all.`);
  return args.replace_all === true ? text.split(find).join(put) : text.replace(find, () => put);
}

function numbered(text: string, args: Json): string {
  const lines = text.split('\n');
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
  const limit = Math.min(5000, Math.max(1, Math.floor(Number(args.limit) || 2000)));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice.map((l, i) => `${offset + i}| ${l}`).join('\n');
  if (out.length > MAX_READ) out = out.slice(0, MAX_READ) + '\n[truncated]';
  const end = offset - 1 + slice.length;
  if (end < lines.length) out += `\n[showing lines ${offset}-${end} of ${lines.length}]`;
  return out || '(empty file)';
}

export interface AgentOptions {
  /** One JSON-RPC message out (a line on stdout). */
  send: (msg: Json) => void;
  /** The signed-in server, or undefined (then sessions need a sign-in first). */
  client: () => Client | undefined;
  log?: (s: string) => void;
}

/** The agent side of ACP: answers the editor's requests and calls the editor back. */
export class AcpAgent {
  readonly #o: AgentOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #caps: Caps = { read: false, write: false, terminal: false, authTerminal: false };
  #editor = 'Editor';
  #disclosureOk = false;

  constructor(o: AgentOptions) {
    this.#o = o;
  }

  /** One message from the editor (a request, a notification or an answer to our request). */
  async receive(msg: Json): Promise<void> {
    if (msg.id !== undefined && msg.method === undefined) {
      const w = this.#waiting.get(Number(msg.id));
      if (!w) return;
      this.#waiting.delete(Number(msg.id));
      if (msg.error) w.reject(new Error(String((msg.error as Json).message ?? 'The editor refused.')));
      else w.resolve(msg.result);
      return;
    }
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Json;
    if (msg.id === undefined) {
      if (method === 'session/cancel') await this.#cancel(String(params.sessionId ?? ''));
      return;
    }
    try {
      const result = await this.#request(method, params);
      this.#o.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const e = err instanceof AcpError ? err : new AcpError(-32603, (err as Error).message);
      this.#o.send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
    }
  }

  /** A request to the editor; resolves with its result. */
  call(method: string, params: Json): Promise<Json> {
    const id = this.#nextId++;
    return new Promise((resolveP, reject) => {
      this.#waiting.set(id, { resolve: (v) => resolveP((v ?? {}) as Json), reject });
      this.#o.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #update(sessionId: string, update: Json): void {
    this.#o.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }
  #say(sessionId: string, text: string): void {
    if (text) this.#update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  #need(): Client {
    const c = this.#o.client();
    if (!c) throw authRequired();
    return c;
  }
  async #api<T = Json>(path: string, body?: unknown): Promise<T> {
    try {
      return await this.#need().json<T>(path, body !== undefined ? { body } : {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw authRequired();
      throw err;
    }
  }

  async #request(method: string, p: Json): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const cc = (p.clientCapabilities ?? {}) as Json;
        const fs = (cc.fs ?? {}) as Json;
        this.#caps = { read: fs.readTextFile === true, write: fs.writeTextFile === true, terminal: cc.terminal === true, authTerminal: (cc.auth as Json | undefined)?.terminal === true };
        const info = (p.clientInfo ?? {}) as Json;
        this.#editor = String(info.title ?? info.name ?? 'Editor').replace(/[\u0000-\u001f]/g, '').slice(0, 40) || 'Editor';
        const login = this.#caps.authTerminal
          ? { id: 'sara-login', name: 'Sign in to Sara', description: 'Shows a code to approve in Sara (Settings → Devices and sign-in).', type: 'terminal', args: ['login'] }
          : { id: 'sara-login', name: 'Sign in to Sara', description: 'In a terminal run: sara-chat acp login https://your-sara-address, approve the code in Sara, then start a new thread.' };
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { close: {} } },
          agentInfo: { name: 'sara', title: 'Sara', version: VERSION },
          authMethods: [login],
        };
      }
      case 'authenticate':
        // The sign-in happens in a terminal (sara-chat acp login); here we only check it.
        this.#need();
        return {};
      case 'session/new': {
        const cwd = resolve(String(p.cwd ?? process.cwd()));
        const s = await this.#api<{ conversationId: string }>('/editor/sessions', { editor: this.#editor, folder: cwd });
        this.#sessions.set(s.conversationId, { id: s.conversationId, cwd, editsOk: false, commandsOk: new Set() });
        return { sessionId: s.conversationId };
      }
      case 'session/load': {
        const id = String(p.sessionId ?? '');
        const cwd = resolve(String(p.cwd ?? process.cwd()));
        let page: { messages: { role: string; content: string }[] };
        try {
          page = await this.#api(`/conversations/${encodeURIComponent(id)}/messages?limit=100`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw new AcpError(-32002, `Resource not found: session ${id}`);
          throw err;
        }
        this.#sessions.set(id, { id, cwd, editsOk: false, commandsOk: new Set() });
        for (const m of page.messages ?? []) {
          if ((m.role !== 'user' && m.role !== 'assistant') || !m.content) continue;
          this.#update(id, { sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: m.content } });
        }
        return {};
      }
      case 'session/close':
        await this.#cancel(String(p.sessionId ?? ''));
        this.#sessions.delete(String(p.sessionId ?? ''));
        return {};
      case 'session/prompt':
        return this.#prompt(p);
      default:
        throw new AcpError(-32601, `Method not found: ${method}`);
    }
  }

  async #cancel(sessionId: string): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s?.turn || s.turn.cancelled) return;
    s.turn.cancelled = true;
    s.turn.ctl.abort();
    await this.#need().raw(`/conversations/${encodeURIComponent(sessionId)}/stop`, { body: {} }).catch(() => undefined);
  }

  /** The prompt's blocks as one message: text, embedded files, and linked files read through the editor. */
  async #content(s: Session, blocks: Json[]): Promise<string> {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push(String(b.text ?? ''));
      else if (b.type === 'resource') {
        const r = (b.resource ?? {}) as Json;
        if (typeof r.text === 'string') parts.push(fileBlock(String(r.uri ?? ''), r.text));
      } else if (b.type === 'resource_link') {
        const uri = String(b.uri ?? '');
        const path = uri.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, '$1') : '';
        try {
          if (!path || !this.#caps.read) throw new Error('not readable');
          const { abs } = insideFolder(s.cwd, path);
          const r = await this.call('fs/read_text_file', { sessionId: s.id, path: abs });
          parts.push(fileBlock(uri, String(r.content ?? '').slice(0, MAX_READ)));
        } catch {
          parts.push(`(file: ${String(b.name ?? uri)})`);
        }
      }
    }
    return parts.join('\n\n').slice(0, MAX_PROMPT).trim();
  }

  async #prompt(p: Json): Promise<{ stopReason: string }> {
    const s = this.#sessions.get(String(p.sessionId ?? ''));
    if (!s) throw new AcpError(-32002, `Resource not found: session ${String(p.sessionId ?? '')}`);
    if (s.turn) throw new AcpError(-32600, 'Sara is still working on this session.');
    const c = this.#need();
    const content = await this.#content(s, Array.isArray(p.prompt) ? (p.prompt as Json[]) : []);
    if (!content) return { stopReason: 'end_turn' };
    // The AI disclosure, once, the way the other apps ask for it (the server refuses chat before it).
    if (!this.#disclosureOk) {
      const me = await this.#api<{ disclosureAccepted: boolean; disclosure: string }>('/device/whoami');
      if (!me.disclosureAccepted) {
        if (/^i agree\.?$/i.test(content)) {
          await this.#api('/disclosure/accept', {});
          this.#disclosureOk = true;
          this.#say(s.id, 'Thank you. Ask me anything about this folder.');
        } else this.#say(s.id, `${me.disclosure}\n\nReply **I agree** to go on.`);
        return { stopReason: 'end_turn' };
      }
      this.#disclosureOk = true;
    }
    const turn = { ctl: new AbortController(), cancelled: false };
    s.turn = turn;
    const linked = this.#caps.read && this.#caps.write;
    try {
      const res = await c.raw(`/conversations/${encodeURIComponent(s.id)}/messages`, { body: { content, ...(linked ? { editor: { label: this.#editor, terminal: this.#caps.terminal } } : {}) } });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401) throw authRequired();
        throw new AcpError(-32603, data.error ?? `HTTP ${res.status}`);
      }
      for await (const ev of sseEvents(res.body)) await this.#event(s, ev, turn);
      return { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' };
    } catch (err) {
      if (turn.cancelled) return { stopReason: 'cancelled' };
      throw err;
    } finally {
      s.turn = undefined;
    }
  }

  async #event(s: Session, ev: Json, turn: { ctl: AbortController; cancelled: boolean }): Promise<void> {
    const id = String(ev.id ?? '');
    switch (ev.type) {
      case 'token':
        return this.#say(s.id, String(ev.text ?? ''));
      case 'notice':
        return this.#say(s.id, `_${String(ev.text ?? '')}_\n\n`);
      case 'replace':
        return this.#say(s.id, `\n\n_(Her reply was replaced by a safety check.)_\n\n${String(ev.text ?? '')}`);
      case 'error':
        if (!turn.cancelled) this.#say(s.id, `\n\n${String(ev.message ?? 'Something went wrong.')}`);
        return;
      case 'tool_call': {
        const args = (ev.args ?? {}) as Json;
        return this.#update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title: String(ev.summary ?? ev.name), kind: toolKind(String(ev.name)), status: 'pending', rawInput: args, ...this.#locations(s, args) });
      }
      case 'tool_running':
        return this.#update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
      case 'tool_result': {
        const ok = ev.status === 'ok';
        const shown = ['write_file', 'edit_file', 'shell'].includes(String(ev.name)) && ok;
        return this.#update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', ...(shown ? {} : { content: [textContent(String(ev.output ?? '').slice(0, 4000))] }) });
      }
      case 'approval': {
        const allowed = await this.#ask(s, { toolCallId: id, title: String(ev.summary ?? ev.name), kind: toolKind(String(ev.name)), rawInput: ev.args ?? {} }, []);
        await this.#need().json(`/approvals/${encodeURIComponent(String(ev.approvalId))}`, { body: { approved: allowed === 'once' } }).catch((err: Error) => this.#o.log?.(`approval: ${err.message}\n`));
        return;
      }
      case 'editor_call': {
        let answer: { ok: boolean; output: string };
        try {
          // A cancelled turn doesn't wait for the editor's answer to a request still open.
          const aborted = new Promise<never>((_, reject) => {
            if (turn.ctl.signal.aborted) reject(new Error('Cancelled.'));
            turn.ctl.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true });
          });
          answer = { ok: true, output: await Promise.race([this.#run(s, ev, turn.ctl.signal), aborted]) };
        } catch (err) {
          answer = { ok: false, output: (err as Error).message };
        }
        await this.#need().json(`/editor/calls/${encodeURIComponent(String(ev.callId))}`, { body: answer }).catch(() => undefined);
        return;
      }
    }
  }

  #locations(s: Session, args: Json): Json {
    if (typeof args.path !== 'string') return {};
    try {
      return { locations: [{ path: insideFolder(s.cwd, args.path).abs }] };
    } catch {
      return {};
    }
  }

  /** Asks in the editor. `always` = the session-scoped option's name (none: once or no). */
  async #ask(s: Session, toolCall: Json, extra: Json[], always?: string): Promise<'once' | 'always' | 'no'> {
    const options = [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, ...(always ? [{ optionId: 'allow-always', name: always, kind: 'allow_always' }] : []), { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }];
    try {
      const r = await this.call('session/request_permission', { sessionId: s.id, toolCall: { ...toolCall, ...(extra.length ? { content: extra } : {}) }, options });
      const o = (r.outcome ?? {}) as Json;
      if (o.outcome !== 'selected') return 'no';
      if (o.optionId === 'allow-once') return 'once';
      if (o.optionId === 'allow-always' && always) return 'always';
      return 'no';
    } catch {
      return 'no';
    }
  }

  /** Runs one of her file or command tools in the editor's folder; the text goes back to her. */
  async #run(s: Session, ev: Json, signal: AbortSignal): Promise<string> {
    const name = String(ev.name);
    const args = (ev.args ?? {}) as Json;
    const toolCallId = String(ev.id ?? '');
    const approved = ev.approved === true;
    if (name === 'read_file') {
      const { abs } = insideFolder(s.cwd, String(args.path ?? ''));
      return numbered(await this.#readText(s, abs), args);
    }
    if (name === 'write_file' || name === 'edit_file') {
      const { abs, rel } = insideFolder(s.cwd, String(args.path ?? ''));
      const before = await this.#readText(s, abs).catch(() => undefined);
      if (name === 'edit_file' && before === undefined) throw new Error(`File not found: ${rel}`);
      const after = name === 'edit_file' ? applyEdit(before!, args) : typeof args.content === 'string' ? args.content : '';
      const diff = { type: 'diff', path: abs, oldText: before ?? null, newText: after };
      if (!approved && !s.editsOk) {
        const a = await this.#ask(s, { toolCallId, title: `${name === 'edit_file' ? 'Edit' : 'Write'} ${rel}`, kind: 'edit', locations: [{ path: abs }] }, [diff], 'Allow edits in this folder for this session');
        if (a === 'no') throw new Error('The owner declined this change in the editor. Nothing was written.');
        if (a === 'always') s.editsOk = true;
      }
      if (signal.aborted) throw new Error('Cancelled.');
      await this.call('fs/write_text_file', { sessionId: s.id, path: abs, content: after });
      this.#update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, content: [diff] });
      return name === 'edit_file' ? `Edited ${rel}.` : `Wrote ${Buffer.byteLength(after)} bytes to ${rel}.`;
    }
    if (name === 'list_dir') return listFolder(s.cwd, String(args.path ?? '.'));
    if (name === 'search') return searchFolder(s.cwd, args, signal);
    if (name === 'shell') return this.#shell(s, String(args.command ?? ''), args, toolCallId, approved, signal);
    throw new Error(`${name} doesn't run in the editor.`);
  }

  async #readText(s: Session, abs: string): Promise<string> {
    if (this.#caps.read) return String((await this.call('fs/read_text_file', { sessionId: s.id, path: abs })).content ?? '');
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) throw new Error(`File not found: ${relative(s.cwd, abs)}`);
    return readFile(abs, 'utf8');
  }

  async #shell(s: Session, command: string, args: Json, toolCallId: string, approved: boolean, signal: AbortSignal): Promise<string> {
    if (!this.#caps.terminal) throw new Error("The editor didn't offer a terminal.");
    if (!command.trim()) throw new Error('No command.');
    if (!approved && !s.commandsOk.has(command)) {
      const a = await this.#ask(s, { toolCallId, title: `$ ${command}`, kind: 'execute', rawInput: { command } }, [], 'Always allow this exact command for this session');
      if (a === 'no') throw new Error('The owner declined this command in the editor. It did not run.');
      if (a === 'always') s.commandsOk.add(command);
    }
    const win = platform() === 'win32';
    const started = Date.now();
    const t = await this.call('terminal/create', { sessionId: s.id, command: win ? 'cmd.exe' : 'sh', args: win ? ['/d', '/s', '/c', command] : ['-c', command], cwd: s.cwd, outputByteLimit: 200_000 });
    const terminalId = String(t.terminalId ?? '');
    this.#update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [{ type: 'terminal', terminalId }] });
    const seconds = Math.min(1800, Math.max(1, Number(args.timeout_seconds) || 120));
    let timedOut = false;
    try {
      const stop = new Promise<'stop'>((r) => {
        const timer = setTimeout(() => {
          timedOut = true;
          r('stop');
        }, seconds * 1000);
        timer.unref?.();
        signal.addEventListener('abort', () => r('stop'), { once: true });
      });
      const exit = await Promise.race([this.call('terminal/wait_for_exit', { sessionId: s.id, terminalId }), stop]);
      if (exit === 'stop') await this.call('terminal/kill', { sessionId: s.id, terminalId }).catch(() => undefined);
      const out = await this.call('terminal/output', { sessionId: s.id, terminalId });
      const code = exit === 'stop' ? undefined : (exit as Json).exitCode;
      const status = timedOut ? `timed out after ${seconds}s` : signal.aborted ? 'cancelled' : `exit code ${code ?? 'none'}`;
      return `[${status}, ${((Date.now() - started) / 1000).toFixed(1)}s, in the editor's terminal]\n${String(out.output ?? '').trimEnd().slice(-30_000) || '(no output)'}`;
    } finally {
      await this.call('terminal/release', { sessionId: s.id, terminalId }).catch(() => undefined);
    }
  }
}

const textContent = (text: string) => ({ type: 'content', content: { type: 'text', text } });
const fileBlock = (uri: string, text: string) => `File ${uri}:\n\`\`\`\n${text.slice(0, MAX_READ)}\n\`\`\``;

async function listFolder(root: string, p: string): Promise<string> {
  const { abs, rel } = insideFolder(root, p);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    throw new Error(`Not a folder: ${rel}`);
  }
  entries = entries.filter((e) => !EDITOR_SECRET.test(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const e of entries.slice(0, 500)) {
    if (e.isDirectory()) lines.push(`${e.name}/`);
    else {
      const st = await lstat(join(abs, e.name)).catch(() => undefined);
      lines.push(st?.isSymbolicLink() ? `${e.name} → (link)` : `${e.name}${st ? `  (${st.size} bytes)` : ''}`);
    }
  }
  if (entries.length > 500) lines.push(`… ${entries.length - 500} more`);
  return lines.length ? lines.join('\n') : '(empty folder)';
}

async function searchFolder(root: string, args: Json, signal: AbortSignal): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(String(args.pattern ?? ''), args.ignore_case === true ? 'i' : '');
  } catch (err) {
    throw new Error(`Invalid pattern: ${(err as Error).message}`);
  }
  const start = insideFolder(root, String(args.path ?? '.')).abs;
  const results: string[] = [];
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= 200 || files > 20_000 || signal.aborted) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (results.length >= 200 || EDITOR_SECRET.test(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p);
      } else if (e.isFile()) {
        files++;
        const st = await stat(p).catch(() => undefined);
        if (!st || st.size > 1_000_000) continue;
        const buf = await readFile(p).catch(() => undefined);
        if (!buf || buf.subarray(0, 4000).includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && results.length < 200; i++) if (re.test(lines[i])) results.push(`${relative(root, p).split(sep).join('/')}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
  };
  await walk(start);
  if (!results.length) return 'No matches.';
  return results.join('\n') + (results.length >= 200 ? '\n[stopped at 200 matches]' : '');
}

/** The server to use: SARA_URL + SARA_TOKEN, else the saved sara-chat sign-in (--server picks one). */
export function signedInClient(env: NodeJS.ProcessEnv, server?: string, dir = configDir(env)): Client | undefined {
  if (env.SARA_URL && env.SARA_TOKEN) return new Client(env.SARA_URL, env.SARA_TOKEN);
  const p = findProfile(loadConfig(dir), server);
  return p?.token ? new Client(p.url, p.token) : undefined;
}

export const ACP_HELP = `sara acp: Sara as the coding agent of editors that speak the Agent Client Protocol (Zed, JetBrains)

  sara-chat acp [--server <name>]     the editor starts this (stdio); see docs/EDITORS.md
  sara-chat acp login [<address>]     sign in with a code you approve in Settings → Devices and sign-in

It uses the sara-chat sign-in, or SARA_URL and SARA_TOKEN.`;

/** `sara acp …` / `sara-chat acp …`: the stdio agent, or the sign-in. */
export async function runAcp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const serverFlag = argv.indexOf('--server');
  const server = serverFlag >= 0 ? argv[serverFlag + 1] : undefined;
  const words = argv.filter((a, i) => !a.startsWith('--') && !(serverFlag >= 0 && i === serverFlag + 1));
  if (argv.includes('--help') || words[0] === 'help') return (process.stdout.write(`${ACP_HELP}\n`), 0);
  if (words[0] === 'login') {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string) => new Promise<string | undefined>((r) => rl.question(q, (a) => r(a)));
    const address = words[1] ?? server ?? (findProfile(loadConfig(configDir(env)))?.url ? undefined : (await ask("Sara's address (like https://sara.example.com): "))?.trim());
    const io: Io = { out: (s) => void process.stderr.write(s), err: (s) => void process.stderr.write(s), color: Boolean(process.stderr.isTTY), ask };
    try {
      return await login(address || undefined, io, configDir(env), { name: 'Editor (sara acp)' });
    } finally {
      rl.close();
    }
  }
  const out = (msg: Json) => void process.stdout.write(`${JSON.stringify(msg)}\n`);
  const agent = new AcpAgent({ send: out, client: () => signedInClient(env, server), log: (s) => void process.stderr.write(s) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const running = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Requests run side by side (a prompt waits for the editor's answers to our own requests).
    const p = agent.receive(msg).catch((err: Error) => void process.stderr.write(`sara acp: ${err.message}\n`));
    running.add(p);
    void p.finally(() => running.delete(p));
  }
  await Promise.allSettled([...running]);
  return 0;
}

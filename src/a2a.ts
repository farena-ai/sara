// Phase 100 (ST5, docs/design/STAPLES.md §8, docs/A2A.md): A2A, the open Agent2Agent protocol, version
// 1.0, written from the public specification (https://a2a-protocol.org/latest/specification/ and its
// normative a2a.proto). This file is the protocol itself (objects, checks, errors), the owner's peer
// and task tables, and Sara as an A2A *server*: the thin public Agent Card, the per-peer extended
// card, and one operation handler behind both bindings (HTTP+JSON/REST at /a2a/v1, JSON-RPC 2.0 at
// /a2a/v1/rpc, Server-Sent Events for streams). Sara as a *client* is src/a2a-client.ts.
//
// What a peer request becomes: one context = one conversation `a2a:<peer>:<contextId>` on the `a2a`
// channel in the built-in *Agents* project, run by the server's runTracked with an OutsidePolicy
// (src/chat.ts): no memory by default, only the tools the owner ticked for that peer, every change
// behind the owner's approval card (TASK_STATE_AUTH_REQUIRED while it waits), per-peer budgets and
// rate limits, the peer's words as untrusted text, and the whole safety layer. Every message to a
// peer carries AI metadata and the first one of a context starts with a plain disclosure.
// Push notifications are not offered (Sara calling a URL a peer gives her is an SSRF channel), and
// `url` parts are never fetched.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { OwnerAuth } from './auth.ts';
import type { AppContext, ChatEvent, OutsidePolicy } from './chat.ts';
import { KeyLimiter } from './other-apps.ts';
import { CRISIS_RESOURCES, MINOR_BLOCK_REPLY, minorSexualMatch } from './safety.ts';
import { SECURITY_HEADERS } from './http.ts';

export const A2A_VERSION = '1.0';
export const A2A_CHANNEL = 'a2a';
export const AGENTS_PROJECT = 'Agents';
/** Request limits (STAPLES §8.2): 64 KB of text, 8 parts, raw parts up to 2 MB of these types. */
export const LIMITS = { textBytes: 64 * 1024, parts: 8, rawBytes: 2 * 1024 * 1024, dataBytes: 64 * 1024, bodyBytes: 3 * 1024 * 1024 + 64 * 1024 };
export const RAW_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';
export const TASK_STATES: readonly TaskState[] = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];
export const TERMINAL: ReadonlySet<string> = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
export const INTERRUPTED: ReadonlySet<string> = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);

export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}
export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}
export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}
export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp?: string;
}
export interface A2ATask {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}
export type StreamResponse =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: { taskId: string; contextId: string; status: TaskStatus; metadata?: Record<string, unknown> } }
  | { artifactUpdate: { taskId: string; contextId: string; artifact: Artifact; append?: boolean; lastChunk?: boolean; metadata?: Record<string, unknown> } };

// ---------------------------------------------------------------------------------------------
// Errors (spec §3.3.2, §5.4): one A2AError, mapped to JSON-RPC codes and HTTP statuses.
// ---------------------------------------------------------------------------------------------

const ERRORS = {
  TaskNotFound: [-32001, 404, 'TASK_NOT_FOUND', 'Task not found'],
  TaskNotCancelable: [-32002, 400, 'TASK_NOT_CANCELABLE', 'Task cannot be canceled'],
  PushNotificationNotSupported: [-32003, 400, 'PUSH_NOTIFICATION_NOT_SUPPORTED', 'Push notifications are not supported'],
  UnsupportedOperation: [-32004, 400, 'UNSUPPORTED_OPERATION', 'This operation is not supported'],
  ContentTypeNotSupported: [-32005, 400, 'CONTENT_TYPE_NOT_SUPPORTED', 'Incompatible content types'],
  InvalidAgentResponse: [-32006, 500, 'INVALID_AGENT_RESPONSE', 'Invalid agent response'],
  ExtendedAgentCardNotConfigured: [-32007, 400, 'EXTENDED_AGENT_CARD_NOT_CONFIGURED', 'Extended agent card not configured'],
  ExtensionSupportRequired: [-32008, 400, 'EXTENSION_SUPPORT_REQUIRED', 'Extension support required'],
  VersionNotSupported: [-32009, 400, 'VERSION_NOT_SUPPORTED', 'This A2A version is not supported'],
  ParseError: [-32700, 400, 'PARSE_ERROR', 'Invalid JSON payload'],
  InvalidRequest: [-32600, 400, 'INVALID_REQUEST', 'Request payload validation error'],
  MethodNotFound: [-32601, 404, 'METHOD_NOT_FOUND', 'Method not found'],
  InvalidParams: [-32602, 400, 'INVALID_ARGUMENT', 'Invalid parameters'],
  Internal: [-32603, 500, 'INTERNAL', 'Internal error'],
  // Custom (spec §3.3.2: authentication/authorisation errors are binding-specific; JSON-RPC custom codes).
  Unauthenticated: [-32010, 401, 'UNAUTHENTICATED', 'Authentication required'],
  RateLimited: [-32011, 429, 'RESOURCE_EXHAUSTED', 'Too many requests'],
} as const;
export type A2AErrorKind = keyof typeof ERRORS;

export class A2AError extends Error {
  readonly kind: A2AErrorKind;
  readonly code: number;
  readonly http: number;
  readonly reason: string;
  readonly field?: string;
  readonly retryAfter?: number;
  constructor(kind: A2AErrorKind, message?: string, extra: { field?: string; retryAfter?: number } = {}) {
    const [code, http, reason, standard] = ERRORS[kind];
    super(message ?? standard);
    this.kind = kind;
    this.code = code;
    this.http = http;
    this.reason = reason;
    if (extra.field) this.field = extra.field;
    if (extra.retryAfter) this.retryAfter = extra.retryAfter;
  }
  /** The `error.data` / `error.details` array: an ErrorInfo, and a BadRequest naming the field. */
  details(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: this.reason, domain: 'a2a-protocol.org', metadata: { timestamp: new Date().toISOString(), ...(this.kind === 'VersionNotSupported' ? { supportedVersions: A2A_VERSION } : {}) } }];
    if (this.field) out.push({ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: this.field, description: this.message }] });
    return out;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const bad = (field: string, message: string) => new A2AError('InvalidParams', message, { field });
const ID_RE = /^[\w.:@~-]{1,128}$/;

// ---------------------------------------------------------------------------------------------
// Checking what a peer sends (spec §14.1.1: validate against the schema before processing).
// ---------------------------------------------------------------------------------------------

/** A part: exactly one of text / raw / url / data, with optional filename, mediaType, metadata. */
export function checkPart(v: unknown, field: string): Part {
  if (!isObj(v)) throw bad(field, 'A part must be an object.');
  const kinds = (['text', 'raw', 'url', 'data'] as const).filter((k) => v[k] !== undefined);
  if (kinds.length !== 1) throw bad(field, 'A part must have exactly one of text, raw, url or data.');
  const p: Part = {};
  if (v.mediaType !== undefined) {
    if (typeof v.mediaType !== 'string' || v.mediaType.length > 100) throw bad(`${field}.mediaType`, 'mediaType must be a short string.');
    p.mediaType = v.mediaType.toLowerCase().split(';')[0].trim();
  }
  if (v.filename !== undefined) {
    if (typeof v.filename !== 'string' || v.filename.length > 200) throw bad(`${field}.filename`, 'filename must be a short string.');
    p.filename = v.filename.replace(/[\\/\0]/g, '_');
  }
  if (v.metadata !== undefined) {
    if (!isObj(v.metadata)) throw bad(`${field}.metadata`, 'metadata must be an object.');
    p.metadata = v.metadata;
  }
  const k = kinds[0];
  if (k === 'text') {
    if (typeof v.text !== 'string') throw bad(`${field}.text`, 'text must be a string.');
    p.text = v.text;
  } else if (k === 'raw') {
    if (typeof v.raw !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(v.raw)) throw bad(`${field}.raw`, 'raw must be base64.');
    if (Math.floor((v.raw.length * 3) / 4) > LIMITS.rawBytes + 4) throw new A2AError('ContentTypeNotSupported', 'A file part is at most 2 MB.', { field: `${field}.raw` });
    if (!p.mediaType || !RAW_TYPES.has(p.mediaType)) throw new A2AError('ContentTypeNotSupported', 'Files must be images (PNG, JPEG, WebP, GIF), PDF or text.', { field: `${field}.mediaType` });
    p.raw = v.raw;
  } else if (k === 'url') {
    if (typeof v.url !== 'string' || v.url.length > 2048) throw bad(`${field}.url`, 'url must be a string of up to 2048 characters.');
    p.url = v.url;
  } else {
    if (JSON.stringify(v.data ?? null).length > LIMITS.dataBytes) throw bad(`${field}.data`, 'A data part is at most 64 KB.');
    p.data = v.data;
  }
  return p;
}

/** A message from a client (role ROLE_USER), checked field by field (spec §4.1.4). */
export function checkMessage(v: unknown, field = 'message'): A2AMessage {
  if (!isObj(v)) throw bad(field, 'message is required.');
  if (typeof v.messageId !== 'string' || !v.messageId || v.messageId.length > 200) throw bad(`${field}.messageId`, 'messageId is required.');
  if (v.role !== 'ROLE_USER') throw bad(`${field}.role`, 'role must be ROLE_USER.');
  if (!Array.isArray(v.parts) || !v.parts.length) throw bad(`${field}.parts`, 'At least one part is required.');
  if (v.parts.length > LIMITS.parts) throw bad(`${field}.parts`, `At most ${LIMITS.parts} parts.`);
  const parts = v.parts.map((p, i) => checkPart(p, `${field}.parts[${i}]`));
  const textBytes = parts.reduce((n, p) => n + Buffer.byteLength(p.text ?? '', 'utf8'), 0);
  if (textBytes > LIMITS.textBytes) throw bad(`${field}.parts`, 'At most 64 KB of text.');
  const m: A2AMessage = { messageId: v.messageId, role: 'ROLE_USER', parts };
  for (const k of ['contextId', 'taskId'] as const) {
    if (v[k] === undefined || v[k] === '') continue;
    if (typeof v[k] !== 'string' || !ID_RE.test(v[k])) throw bad(`${field}.${k}`, `${k} must be a short id.`);
    m[k] = v[k];
  }
  if (v.metadata !== undefined) {
    if (!isObj(v.metadata)) throw bad(`${field}.metadata`, 'metadata must be an object.');
    m.metadata = v.metadata;
  }
  if (v.extensions !== undefined) {
    if (!Array.isArray(v.extensions) || v.extensions.some((x) => typeof x !== 'string')) throw bad(`${field}.extensions`, 'extensions must be a list of strings.');
    m.extensions = v.extensions as string[];
  }
  if (v.referenceTaskIds !== undefined) {
    if (!Array.isArray(v.referenceTaskIds) || v.referenceTaskIds.some((x) => typeof x !== 'string')) throw bad(`${field}.referenceTaskIds`, 'referenceTaskIds must be a list of strings.');
    m.referenceTaskIds = v.referenceTaskIds as string[];
  }
  return m;
}

export interface SendRequest {
  message: A2AMessage;
  returnImmediately: boolean;
  historyLength?: number;
  acceptedOutputModes?: string[];
  metadata?: Record<string, unknown>;
}
/** A SendMessageRequest (spec §3.2.1/§3.2.2). Push configs in it are refused (push is off). */
export function checkSendRequest(v: unknown): SendRequest {
  if (!isObj(v)) throw new A2AError('InvalidParams', 'params must be an object.');
  const message = checkMessage(v.message);
  const out: SendRequest = { message, returnImmediately: false };
  if (v.configuration !== undefined) {
    const c = v.configuration;
    if (!isObj(c)) throw bad('configuration', 'configuration must be an object.');
    if (c.taskPushNotificationConfig !== undefined && c.taskPushNotificationConfig !== null) throw new A2AError('PushNotificationNotSupported');
    if (c.returnImmediately !== undefined && typeof c.returnImmediately !== 'boolean') throw bad('configuration.returnImmediately', 'returnImmediately must be true or false.');
    out.returnImmediately = c.returnImmediately === true;
    if (c.historyLength !== undefined && c.historyLength !== null) out.historyLength = checkInt(c.historyLength, 'configuration.historyLength', 0, 1000);
    if (c.acceptedOutputModes !== undefined) {
      if (!Array.isArray(c.acceptedOutputModes) || c.acceptedOutputModes.some((x) => typeof x !== 'string')) throw bad('configuration.acceptedOutputModes', 'acceptedOutputModes must be a list of strings.');
      out.acceptedOutputModes = c.acceptedOutputModes as string[];
    }
  }
  if (v.metadata !== undefined) {
    if (!isObj(v.metadata)) throw bad('metadata', 'metadata must be an object.');
    out.metadata = v.metadata;
  }
  return out;
}

export function checkInt(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw bad(field, `${field} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The `A2A-Version` header: only 1.0 is served (an empty header means 0.3, spec §3.6). */
export function checkVersion(header: string | string[] | undefined): void {
  const v = String(Array.isArray(header) ? header[0] : (header ?? '')).trim();
  if (v === '1.0' || v === '1') return;
  throw new A2AError('VersionNotSupported', `A2A version ${v || '0.3 (no A2A-Version header)'} is not supported. This agent serves A2A ${A2A_VERSION}: send the header A2A-Version: ${A2A_VERSION}.`);
}

// ---------------------------------------------------------------------------------------------
// The owner's peers and tasks (STAPLES §8.4; the owner's database, additive).
// ---------------------------------------------------------------------------------------------

/** What a peer may do when it asks her (the owner's ticks; STAPLES §8.2, §8.6). */
export interface PeerPolicy {
  /** 'web': search the web (runs on its own); 'todo': add to-dos (asks you). Default: none (answer only). */
  tools: ('web' | 'todo')[];
  /** Her skills (ST1) offered to this peer (listed on its extended card; loaded when it asks for one). */
  skills: string[];
  /** 'shared': notes about the owner that other apps may see (facts only); default none. */
  memory: 'none' | 'shared';
  tokensPerDay: number;
  usdPerDay: number;
  tasksPerDay: number;
  perMinute: number;
  taskTokens: number;
  taskMinutes: number;
  /** Outbound: how many messages a day she may send this peer. */
  callsPerDay: number;
}
export const DEFAULT_POLICY: PeerPolicy = { tools: [], skills: [], memory: 'none', tokensPerDay: 100_000, usdPerDay: 0.5, tasksPerDay: 200, perMinute: 20, taskTokens: 30_000, taskMinutes: 5, callsPerDay: 50 };
/** Peer tool ticks → her tools, and which of them run without a card. */
export const PEER_TOOLS: Record<PeerPolicy['tools'][number], { tools: string[]; auto: string[] }> = {
  web: { tools: ['web_search', 'web_fetch'], auto: ['web_search', 'web_fetch'] },
  todo: { tools: ['todo'], auto: [] },
};

const clampNum = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
export function cleanPolicy(v: unknown, base: PeerPolicy = DEFAULT_POLICY): PeerPolicy {
  const o = isObj(v) ? v : {};
  const tools = Array.isArray(o.tools) ? (o.tools.filter((t) => t === 'web' || t === 'todo') as PeerPolicy['tools']) : base.tools;
  const skills = Array.isArray(o.skills) ? o.skills.filter((s): s is string => typeof s === 'string' && /^[a-z0-9-]{1,64}$/.test(s)).slice(0, 20) : base.skills;
  return {
    tools: [...new Set(tools)],
    skills: [...new Set(skills)],
    memory: o.memory === 'shared' ? 'shared' : o.memory === 'none' ? 'none' : base.memory,
    tokensPerDay: Math.round(clampNum(o.tokensPerDay, base.tokensPerDay, 1000, 5_000_000)),
    usdPerDay: clampNum(o.usdPerDay, base.usdPerDay, 0, 100),
    tasksPerDay: Math.round(clampNum(o.tasksPerDay, base.tasksPerDay, 1, 5000)),
    perMinute: Math.round(clampNum(o.perMinute, base.perMinute, 1, 600)),
    taskTokens: Math.round(clampNum(o.taskTokens, base.taskTokens, 1000, 500_000)),
    taskMinutes: clampNum(o.taskMinutes, base.taskMinutes, 0.05, 60),
    callsPerDay: Math.round(clampNum(o.callsPerDay, base.callsPerDay, 1, 1000)),
  };
}

export interface Peer {
  id: string;
  label: string;
  direction: 'in' | 'out' | 'both';
  deviceId: string | null;
  cardUrl: string | null;
  card: Record<string, unknown> | null;
  cardSha: string | null;
  cardCheckedAt: string | null;
  companion: string;
  policy: PeerPolicy;
  status: 'active' | 'removed';
  createdAt: string;
  lastSeen: string | null;
}
export interface TaskRow {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  contextId: string;
  state: TaskState;
  conversationId: string | null;
  runId: string | null;
  cardTaskId: number | null;
  statusMessage: A2AMessage | null;
  /** Outbound: the last task the peer reported (artifacts included). */
  snapshot: A2ATask | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, string | number | null>;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_peers (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  direction TEXT NOT NULL,
  device_id TEXT,
  card_url TEXT, card TEXT, card_sha TEXT, card_checked_at TEXT,
  companion TEXT NOT NULL DEFAULT 'main',
  policy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL, direction TEXT NOT NULL, context_id TEXT NOT NULL,
  state TEXT NOT NULL, conversation_id TEXT, run_id TEXT,
  card_task_id INTEGER,
  status_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS a2a_tasks_peer ON a2a_tasks(peer_id, updated_at);
CREATE TABLE IF NOT EXISTS a2a_artifacts (
  task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, name TEXT,
  parts TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (task_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
`;
const json = <T>(v: unknown, d: T): T => {
  if (typeof v !== 'string' || !v) return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};

export class A2AStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(SCHEMA);
    // Additive (Phase 100 as built): the outbound task's last snapshot from the peer.
    const cols = new Set((db.prepare('PRAGMA table_info(a2a_tasks)').all() as Row[]).map((r) => String(r.name)));
    if (!cols.has('snapshot')) db.exec('ALTER TABLE a2a_tasks ADD COLUMN snapshot TEXT');
  }
  now(): string {
    return this.#now().toISOString();
  }
  day(): string {
    return this.now().slice(0, 10);
  }

  #peer(r: Row): Peer {
    return {
      id: String(r.id),
      label: String(r.label),
      direction: (['in', 'out', 'both'].includes(String(r.direction)) ? r.direction : 'in') as Peer['direction'],
      deviceId: r.device_id === null ? null : String(r.device_id),
      cardUrl: r.card_url === null ? null : String(r.card_url),
      card: json<Record<string, unknown> | null>(r.card, null),
      cardSha: r.card_sha === null ? null : String(r.card_sha),
      cardCheckedAt: r.card_checked_at === null ? null : String(r.card_checked_at),
      companion: String(r.companion ?? 'main'),
      policy: cleanPolicy(json(r.policy, {})),
      status: r.status === 'removed' ? 'removed' : 'active',
      createdAt: String(r.created_at),
      lastSeen: r.last_seen === null ? null : String(r.last_seen),
    };
  }
  peers(all = false): Peer[] {
    return (this.db.prepare(`SELECT * FROM a2a_peers ${all ? '' : "WHERE status = 'active'"} ORDER BY created_at`).all() as Row[]).map((r) => this.#peer(r));
  }
  peer(id: string): Peer | undefined {
    const r = this.db.prepare("SELECT * FROM a2a_peers WHERE id = ? AND status = 'active'").get(id) as Row | undefined;
    return r ? this.#peer(r) : undefined;
  }
  peerByDevice(deviceId: string): Peer | undefined {
    const r = this.db.prepare("SELECT * FROM a2a_peers WHERE device_id = ? AND status = 'active'").get(deviceId) as Row | undefined;
    return r ? this.#peer(r) : undefined;
  }
  addPeer(p: { label: string; direction: Peer['direction']; deviceId?: string | null; cardUrl?: string | null; card?: unknown; cardSha?: string | null; policy?: PeerPolicy; companion?: string }): Peer {
    const id = `p${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const ts = this.now();
    this.db
      .prepare('INSERT INTO a2a_peers (id, label, direction, device_id, card_url, card, card_sha, card_checked_at, companion, policy, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.label.slice(0, 60), p.direction, p.deviceId ?? null, p.cardUrl ?? null, p.card ? JSON.stringify(p.card) : null, p.cardSha ?? null, p.card ? ts : null, p.companion ?? 'main', JSON.stringify(p.policy ?? DEFAULT_POLICY), 'active', ts);
    return this.peer(id)!;
  }
  updatePeer(id: string, patch: Partial<Pick<Peer, 'label' | 'direction' | 'deviceId' | 'cardUrl' | 'card' | 'cardSha' | 'policy' | 'status'>>): Peer | undefined {
    const cur = this.peer(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    this.db
      .prepare('UPDATE a2a_peers SET label = ?, direction = ?, device_id = ?, card_url = ?, card = ?, card_sha = ?, card_checked_at = ?, policy = ?, status = ? WHERE id = ?')
      .run(n.label.slice(0, 60), n.direction, n.deviceId, n.cardUrl, n.card ? JSON.stringify(n.card) : null, n.cardSha, patch.card ? this.now() : n.cardCheckedAt, JSON.stringify(n.policy), n.status, id);
    return this.peer(id) ?? (n.status === 'removed' ? n : undefined);
  }
  seen(id: string): void {
    this.db.prepare('UPDATE a2a_peers SET last_seen = ? WHERE id = ?').run(this.now(), id);
  }

  #task(r: Row): TaskRow {
    return {
      id: String(r.id),
      peerId: String(r.peer_id),
      direction: r.direction === 'out' ? 'out' : 'in',
      contextId: String(r.context_id),
      state: (TASK_STATES.includes(r.state as TaskState) ? r.state : 'TASK_STATE_FAILED') as TaskState,
      conversationId: r.conversation_id === null ? null : String(r.conversation_id),
      runId: r.run_id === null ? null : String(r.run_id),
      cardTaskId: r.card_task_id === null ? null : Number(r.card_task_id),
      statusMessage: json<A2AMessage | null>(r.status_message, null),
      snapshot: json<A2ATask | null>(r.snapshot, null),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  task(id: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#task(r) : undefined;
  }
  addTask(t: { id?: string; peerId: string; direction: 'in' | 'out'; contextId: string; state: TaskState; conversationId?: string | null; cardTaskId?: number | null; statusMessage?: A2AMessage | null; snapshot?: A2ATask | null }): TaskRow {
    const id = t.id ?? randomUUID();
    const ts = this.now();
    this.db
      .prepare('INSERT INTO a2a_tasks (id, peer_id, direction, context_id, state, conversation_id, card_task_id, status_message, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.peerId, t.direction, t.contextId, t.state, t.conversationId ?? null, t.cardTaskId ?? null, t.statusMessage ? JSON.stringify(t.statusMessage) : null, t.snapshot ? JSON.stringify(t.snapshot) : null, ts, ts);
    return this.task(id)!;
  }
  setTask(id: string, patch: { state?: TaskState; statusMessage?: A2AMessage | null; runId?: string | null; cardTaskId?: number | null; snapshot?: A2ATask | null; conversationId?: string | null }): TaskRow | undefined {
    const cur = this.task(id);
    if (!cur) return undefined;
    const n = { ...cur, ...patch };
    // Strictly increasing update times keep ListTasks paging stable within one millisecond.
    let ts = this.now();
    if (ts <= cur.updatedAt) ts = new Date(Date.parse(cur.updatedAt) + 1).toISOString();
    this.db
      .prepare('UPDATE a2a_tasks SET state = ?, status_message = ?, run_id = ?, card_task_id = ?, snapshot = ?, conversation_id = ?, updated_at = ? WHERE id = ?')
      .run(n.state, n.statusMessage ? JSON.stringify(n.statusMessage) : null, n.runId, n.cardTaskId, n.snapshot ? JSON.stringify(n.snapshot) : null, n.conversationId, ts, id);
    return this.task(id);
  }
  /** A peer's tasks, newest update first, with an opaque cursor (spec §3.1.4). */
  listTasks(peerId: string, direction: 'in' | 'out', f: { contextId?: string; state?: TaskState; after?: string; cursor?: { at: string; id: string }; limit: number }): { rows: TaskRow[]; total: number; next?: { at: string; id: string } } {
    const where = ['peer_id = ?', 'direction = ?'];
    const args: (string | number)[] = [peerId, direction];
    if (f.contextId) (where.push('context_id = ?'), args.push(f.contextId));
    if (f.state) (where.push('state = ?'), args.push(f.state));
    if (f.after) (where.push('updated_at > ?'), args.push(f.after));
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${where.join(' AND ')}`).get(...args) as Row).n);
    if (f.cursor) (where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'), args.push(f.cursor.at, f.cursor.at, f.cursor.id));
    const rows = (this.db.prepare(`SELECT * FROM a2a_tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, f.limit + 1) as Row[]).map((r) => this.#task(r));
    const more = rows.length > f.limit;
    const page = rows.slice(0, f.limit);
    return { rows: page, total, ...(more ? { next: { at: page.at(-1)!.updatedAt, id: page.at(-1)!.id } } : {}) };
  }
  openOutbound(): TaskRow[] {
    return (this.db.prepare("SELECT * FROM a2a_tasks WHERE direction = 'out' AND state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') ORDER BY created_at").all() as Row[]).map((r) => this.#task(r));
  }
  recent(limit = 20): TaskRow[] {
    return (this.db.prepare('SELECT * FROM a2a_tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#task(r));
  }
  tasksToday(peerId: string, direction: 'in' | 'out'): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM a2a_tasks WHERE peer_id = ? AND direction = ? AND created_at >= ?').get(peerId, direction, `${this.day()}T00:00:00`) as Row).n);
  }
  artifacts(taskId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM a2a_artifacts WHERE task_id = ? ORDER BY created_at, artifact_id').all(taskId) as Row[]).map((r) => {
      // `parts` holds the parts, or { parts, metadata } when the artifact has metadata.
      const v = json<Part[] | { parts: Part[]; metadata?: Record<string, unknown> }>(r.parts, []);
      const parts = Array.isArray(v) ? v : v.parts;
      return { artifactId: String(r.artifact_id), ...(r.name ? { name: String(r.name) } : {}), parts, ...(!Array.isArray(v) && v.metadata ? { metadata: v.metadata } : {}) };
    });
  }
  putArtifact(taskId: string, a: Artifact): void {
    const parts = a.metadata ? { parts: a.parts, metadata: a.metadata } : a.parts;
    this.db.prepare('INSERT INTO a2a_artifacts (task_id, artifact_id, name, parts, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, artifact_id) DO UPDATE SET name = excluded.name, parts = excluded.parts').run(taskId, a.artifactId, a.name ?? null, JSON.stringify(parts), this.now());
  }
  ledger(source: string): { tokens: number; usd: number; runs: number } {
    const r = this.db.prepare('SELECT tokens, usd, runs FROM budget_ledger WHERE day = ? AND source = ?').get(this.day(), source) as { tokens: number; usd: number; runs: number } | undefined;
    return r ?? { tokens: 0, usd: 0, runs: 0 };
  }
  addLedger(source: string, add: { tokens?: number; usd?: number; runs?: number }): void {
    this.db
      .prepare('INSERT INTO budget_ledger (day, source, tokens, usd, runs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, source) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd, runs = runs + excluded.runs')
      .run(this.day(), source, Math.round(add.tokens ?? 0), add.usd ?? 0, add.runs ?? 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Agent Cards (spec §4.4, §8): the thin public card and the per-peer extended card.
// ---------------------------------------------------------------------------------------------

/** RFC 8785-style canonical JSON (sorted keys), for card hashes and signatures. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
export const cardSha = (card: unknown): string => createHash('sha256').update(canonicalJson(card)).digest('hex');

export interface CardOptions {
  base: string;
  version: string;
  name: string;
}
export function publicCard(o: CardOptions): Record<string, unknown> {
  return {
    name: o.name,
    description: 'A personal AI assistant. Ask the owner for a key to send tasks.',
    version: o.version,
    supportedInterfaces: [
      { url: `${o.base}/a2a/v1`, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_VERSION },
      { url: `${o.base}/a2a/v1/rpc`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION },
    ],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: true },
    securitySchemes: { peerKey: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'A key the owner issued to your agent.' } } },
    securityRequirements: [{ schemes: { peerKey: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [],
  };
}

/** The `ask` skill every peer gets, then each Sara skill the owner offered it. */
export function extendedCard(o: CardOptions, offered: { name: string; description: string; tags: string[]; examples: string[] }[]): Record<string, unknown> {
  return {
    ...publicCard(o),
    description: `A personal AI assistant (${o.name}). It answers questions and does small tasks; anything that changes something waits for its owner's approval.`,
    skills: [
      { id: 'ask', name: 'Ask', description: `Ask ${o.name} a question or give her a small task.`, tags: ['question', 'task'], examples: ['What is a good name for a weekly newsletter about home cooking?'], inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain'] },
      ...offered.map((s) => ({ id: s.name, name: s.name, description: s.description.slice(0, 1024), tags: s.tags.slice(0, 10), ...(s.examples.length ? { examples: s.examples.slice(0, 5) } : {}), inputModes: ['text/plain'], outputModes: ['text/plain'] })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// What a peer's message becomes in her turn
// ---------------------------------------------------------------------------------------------

/** The message as text for her: text parts, data as JSON, links not opened, files named. */
export function partsToText(parts: Part[]): { text: string; images: { mediaType: string; raw: string }[] } {
  const out: string[] = [];
  const images: { mediaType: string; raw: string }[] = [];
  for (const p of parts) {
    if (p.text !== undefined) out.push(p.text);
    else if (p.data !== undefined) out.push(`The agent sent data (JSON):\n${JSON.stringify(p.data, null, 1).slice(0, LIMITS.dataBytes)}`);
    // SSRF (spec §14.1.1, STAPLES §3.2): a link is never fetched; she sees it as text.
    else if (p.url !== undefined) out.push(`The agent linked: ${p.url} (not opened)`);
    else if (p.raw !== undefined) {
      if (p.mediaType?.startsWith('image/')) images.push({ mediaType: p.mediaType, raw: p.raw });
      else if (p.mediaType?.startsWith('text/') || p.mediaType === 'application/json') out.push(`The agent attached ${p.filename ?? 'a text file'}:\n${Buffer.from(p.raw, 'base64').toString('utf8').slice(0, LIMITS.textBytes)}`);
      else out.push(`The agent attached ${p.filename ?? 'a file'} (${p.mediaType}; not opened).`);
    }
  }
  return { text: out.join('\n\n').trim() || '(no text)', images };
}

/** Her reply ends with a question to the agent (and she called no tool after it): INPUT_REQUIRED. */
export function asksBack(reply: string): boolean {
  const text = reply.trim();
  const last = text.split(/\n+/).at(-1)?.trim() ?? '';
  if (!/\?["'”’)\]*_]*$/.test(last) || last.length > 400) return false;
  // A closing offer after a real answer ("Want me to…?", "Would you like…?") is not a question back:
  // the task is done. A reply that is mostly the question still asks.
  const offer = /^(\W*)(want me to|would you like|do you want|shall i|should i|need (me|anything)|anything else|let me know|happy to|i can also|or (should|would|do))/i.test(last) || /\b(want me to|would you like me to|shall i|should i)\b/i.test(last);
  return !offer || text.length - last.length < 120;
}

const disclosureLine = (name: string, operator: string) => `This is ${name}, an AI assistant, answering for ${operator}.`;
export const aiMeta = (name: string, operator: string) => ({ ai: true, agent: name, operator });

// ---------------------------------------------------------------------------------------------
// The server: one handler for both bindings
// ---------------------------------------------------------------------------------------------

export interface A2AServerOptions {
  db: DatabaseSync;
  auth: OwnerAuth;
  /** The companion who answers (her runTracked, store, approvals). */
  app: AppContext;
  version: string;
  now?: () => Date;
  demo?: boolean;
}

interface Live {
  controller: { stop: () => void };
  listeners: Set<(ev: StreamResponse) => void>;
  canceled?: boolean;
  done: Promise<void>;
}

export class A2AServer {
  readonly store: A2AStore;
  readonly opts: A2AServerOptions;
  readonly #live = new Map<string, Live>();
  readonly #limiter = new Map<string, KeyLimiter>();
  /** This server's address as the peer reached it (src/server.ts sets it: https behind a trusted proxy). */
  baseOf: (req: IncomingMessage) => string = (req) => `http://${String(req.headers.host ?? 'localhost')}`;
  constructor(opts: A2AServerOptions) {
    this.opts = opts;
    this.store = new A2AStore(opts.db, opts.now);
  }
  get app(): AppContext {
    return this.opts.app;
  }
  settings() {
    const s = this.app.settings.get().a2a ?? {};
    return { enabled: s.enabled === true && !this.opts.demo, showName: s.showName === true, operator: (s.operator ?? '').trim().slice(0, 60) || 'its owner', lanInPrivate: s.lanInPrivate === true };
  }
  cardName(): string {
    return this.settings().showName ? this.app.persona.name : 'Sara';
  }
  cardOpts(req: IncomingMessage): CardOptions {
    return { base: this.baseOf(req), version: this.opts.version, name: this.cardName() };
  }
  /** Tests: waits until a task's run has ended. */
  async settled(taskId: string): Promise<void> {
    await this.#live.get(taskId)?.done;
  }

  // ---------------- HTTP entry ----------------

  /** Handles /.well-known/agent-card.json and /a2a/v1/*. Returns false when the path isn't A2A's. */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname !== '/.well-known/agent-card.json' && pathname !== '/a2a/v1' && !pathname.startsWith('/a2a/v1/')) return false;
    // Off (the default), on the demo and in a member's space: nothing here exists.
    if (!this.settings().enabled) {
      res.writeHead(404, { 'content-type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    if (pathname === '/.well-known/agent-card.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.#restError(res, new A2AError('UnsupportedOperation', 'Use GET.')), true;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(publicCard(this.cardOpts(req))));
      return true;
    }
    const rpc = pathname === '/a2a/v1/rpc';
    let rpcId: unknown = null;
    try {
      const peer = this.#authed(req);
      const lim = this.#limiterFor(peer).take(peer.id);
      if (lim) throw new A2AError('RateLimited', `Too many requests: try again in ${lim} s.`, { retryAfter: lim });
      this.store.seen(peer.id);
      if (rpc) {
        if (req.method !== 'POST') throw new A2AError('InvalidRequest', 'JSON-RPC requests are POSTs.');
        const body = await readBody(req);
        let msg: unknown;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          throw new A2AError('ParseError');
        }
        if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (msg.id !== undefined && typeof msg.id !== 'string' && typeof msg.id !== 'number' && msg.id !== null)) {
          rpcId = isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
          throw new A2AError('InvalidRequest');
        }
        rpcId = msg.id ?? null;
        checkVersion(req.headers['a2a-version']);
        await this.#rpc(req, res, peer, msg.method, msg.params ?? {}, rpcId);
      } else {
        checkVersion(req.headers['a2a-version']);
        await this.#rest(req, res, peer, pathname.slice('/a2a/v1'.length) || '/');
      }
    } catch (err) {
      const e = err instanceof A2AError ? err : new A2AError('Internal');
      if (!(err instanceof A2AError)) console.warn(`a2a: ${(err as Error).message}`);
      if (res.headersSent) {
        res.end();
      } else if (rpc) this.#rpcError(res, rpcId, e);
      else this.#restError(res, e);
    }
    return true;
  }

  #limiterFor(peer: Peer): KeyLimiter {
    const k = `${peer.id}:${peer.policy.perMinute}`;
    let l = this.#limiter.get(k);
    if (!l) this.#limiter.set(k, (l = new KeyLimiter(peer.policy.perMinute, 4)));
    return l;
  }

  /** Only an agent key (kind a2a) of an active peer: cookies, API keys, hands and device tokens are refused. */
  #authed(req: IncomingMessage): Peer {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    const id = m ? this.opts.auth.agentKeyId(m[1]) : undefined;
    const peer = id ? this.store.peerByDevice(id) : undefined;
    if (!peer || peer.direction === 'out') throw new A2AError('Unauthenticated', 'Send the key the owner gave your agent: Authorization: Bearer <key>.');
    return peer;
  }

  // ---------------- bindings ----------------

  async #rest(req: IncomingMessage, res: ServerResponse, peer: Peer, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams;
    if (path === '/message:send' || path === '/message:stream') {
      if (method !== 'POST') throw new A2AError('UnsupportedOperation', 'Use POST.');
      const body = await readJsonBody(req);
      if (path === '/message:send') return this.#sendJson(res, 200, await this.send(peer, body));
      return this.#stream(res, null, (emit) => this.sendStream(peer, body, emit));
    }
    if (path === '/extendedAgentCard') {
      if (method !== 'GET') throw new A2AError('UnsupportedOperation', 'Use GET.');
      return this.#sendJson(res, 200, this.extended(req, peer));
    }
    if (path === '/tasks') {
      if (method !== 'GET') throw new A2AError('UnsupportedOperation', 'Use GET.');
      const params: Record<string, unknown> = {};
      for (const k of ['contextId', 'status', 'pageSize', 'pageToken', 'historyLength', 'statusTimestampAfter', 'includeArtifacts']) if (q.has(k)) params[k] = q.get(k);
      if (params.includeArtifacts !== undefined) params.includeArtifacts = params.includeArtifacts === 'true';
      return this.#sendJson(res, 200, this.list(peer, params));
    }
    const m = /^\/tasks\/([^/:]+)(?::(cancel|subscribe))?(\/pushNotificationConfigs(?:\/[^/]+)?)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[3]) {
        // Push is off (STAPLES §3.2): every config operation answers PushNotificationNotSupported.
        await readBody(req).catch(() => undefined);
        this.#ownTask(peer, id);
        throw new A2AError('PushNotificationNotSupported');
      }
      if (m[2] === 'cancel') {
        if (method !== 'POST') throw new A2AError('UnsupportedOperation', 'Use POST.');
        await readBody(req).catch(() => undefined);
        return this.#sendJson(res, 200, await this.cancel(peer, { id }));
      }
      if (m[2] === 'subscribe') {
        if (method !== 'POST' && method !== 'GET') throw new A2AError('UnsupportedOperation', 'Use POST.');
        await readBody(req).catch(() => undefined);
        const first = this.#subscribeStart(peer, id);
        return this.#stream(res, null, (emit) => this.#follow(first, emit));
      }
      if (method !== 'GET') throw new A2AError('UnsupportedOperation', 'Use GET.');
      return this.#sendJson(res, 200, this.get(peer, { id, ...(q.has('historyLength') ? { historyLength: q.get('historyLength') } : {}) }));
    }
    throw new A2AError('MethodNotFound', 'No such A2A operation here.');
  }

  async #rpc(req: IncomingMessage, res: ServerResponse, peer: Peer, method: string, params: unknown, id: unknown): Promise<void> {
    const p = isObj(params) ? params : {};
    const ok = (result: unknown) => this.#sendJson(res, 200, { jsonrpc: '2.0', id, result }, 'application/json');
    switch (method) {
      case 'SendMessage':
        return ok(await this.send(peer, p));
      case 'SendStreamingMessage':
        return this.#stream(res, id, (emit) => this.sendStream(peer, p, emit));
      case 'GetTask':
        return ok(this.get(peer, p));
      case 'ListTasks':
        return ok(this.list(peer, p));
      case 'CancelTask':
        return ok(await this.cancel(peer, p));
      case 'SubscribeToTask': {
        if (typeof p.id !== 'string') throw bad('id', 'id is required.');
        const first = this.#subscribeStart(peer, p.id);
        return this.#stream(res, id, (emit) => this.#follow(first, emit));
      }
      case 'GetExtendedAgentCard':
        return ok(this.extended(req, peer));
      case 'CreateTaskPushNotificationConfig':
      case 'GetTaskPushNotificationConfig':
      case 'ListTaskPushNotificationConfigs':
      case 'DeleteTaskPushNotificationConfig':
        throw new A2AError('PushNotificationNotSupported');
      default:
        throw new A2AError('MethodNotFound', `Method not found: ${method.slice(0, 60)}`);
    }
  }

  #sendJson(res: ServerResponse, status: number, body: unknown, type = 'application/a2a+json'): void {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }
  #rpcError(res: ServerResponse, id: unknown, e: A2AError): void {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS };
    if (e.kind === 'Unauthenticated') headers['www-authenticate'] = 'Bearer realm="a2a"';
    if (e.retryAfter) headers['retry-after'] = String(e.retryAfter);
    // JSON-RPC errors travel in a 200, except when the transport itself refuses (no key, too many).
    res.writeHead(e.kind === 'Unauthenticated' ? 401 : e.kind === 'RateLimited' ? 429 : 200, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: e.code, message: e.message, data: e.details() } }));
  }
  #restError(res: ServerResponse, e: A2AError): void {
    const headers: Record<string, string> = { 'content-type': 'application/a2a+json', 'cache-control': 'no-store', ...SECURITY_HEADERS };
    if (e.kind === 'Unauthenticated') headers['www-authenticate'] = 'Bearer realm="a2a"';
    if (e.retryAfter) headers['retry-after'] = String(e.retryAfter);
    res.writeHead(e.http, headers);
    const status = { 400: e.kind === 'InvalidParams' ? 'INVALID_ARGUMENT' : 'FAILED_PRECONDITION', 401: 'UNAUTHENTICATED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL' }[e.http] ?? 'UNKNOWN';
    res.end(JSON.stringify({ error: { code: e.http, status, message: e.message, details: e.details() } }));
  }

  /** An SSE response: each StreamResponse as one `data:` line (JSON-RPC wraps it in a result). */
  async #stream(res: ServerResponse, rpcId: unknown, run: (emit: (ev: StreamResponse) => void) => Promise<void>): Promise<void> {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive', ...SECURITY_HEADERS });
    };
    const write = (s: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(s);
    };
    const beat = setInterval(() => started && write(': ping\n\n'), 15_000);
    try {
      await run((ev) => {
        start();
        write(`data: ${JSON.stringify(rpcId === null ? ev : { jsonrpc: '2.0', id: rpcId, result: ev })}\n\n`);
      });
    } catch (err) {
      // An error before the first event is a plain error answer (the caller writes it).
      if (!started) throw err;
      const e = err instanceof A2AError ? err : new A2AError('Internal');
      write(`data: ${JSON.stringify(rpcId === null ? { error: { code: e.http, message: e.message, details: e.details() } } : { jsonrpc: '2.0', id: rpcId, error: { code: e.code, message: e.message, data: e.details() } })}\n\n`);
    } finally {
      clearInterval(beat);
      if (started && !res.writableEnded) res.end();
    }
  }

  // ---------------- operations ----------------

  extended(req: IncomingMessage, peer: Peer): Record<string, unknown> {
    const offered = peer.policy.skills.flatMap((name) => {
      const v = this.app.skills?.resolve(name);
      if (!v || !v.enabled) return [];
      const meta = (v as unknown as { meta?: Record<string, string> }).meta ?? {};
      const tags = String(meta['sara-tags'] ?? '').split(/[,\s]+/).filter(Boolean);
      const examples = String(meta['sara-examples'] ?? '').split('|').map((x) => x.trim()).filter(Boolean);
      return [{ name: v.name, description: v.description, tags: tags.length ? tags : ['skill'], examples }];
    });
    return extendedCard(this.cardOpts(req), offered);
  }

  #ownTask(peer: Peer, id: unknown): TaskRow {
    const t = typeof id === 'string' ? this.store.task(id) : undefined;
    // Another peer's task, an outbound one or none at all: the same answer (spec §3.3.2).
    if (!t || t.peerId !== peer.id || t.direction !== 'in') throw new A2AError('TaskNotFound');
    return t;
  }

  /** A task as A2A sees it: status, artifacts, and the last `historyLength` messages. */
  view(t: TaskRow, o: { historyLength?: number; artifacts?: boolean } = {}): A2ATask {
    const s = this.settings();
    const status: TaskStatus = { state: t.state, timestamp: t.updatedAt, ...(t.statusMessage ? { message: t.statusMessage } : {}) };
    const out: A2ATask = { id: t.id, contextId: t.contextId, status, metadata: aiMeta(this.cardName(), s.operator) };
    if (o.artifacts !== false) out.artifacts = this.store.artifacts(t.id);
    if (o.historyLength !== 0 && t.conversationId) {
      const msgs = this.app.store
        .messages(t.conversationId)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.meta as { a2aTask?: string } | undefined)?.a2aTask === t.id)
        .map((m): A2AMessage => {
          const meta = (m.meta ?? {}) as { a2aId?: string };
          return { messageId: meta.a2aId ?? `m${m.id}`, contextId: t.contextId, taskId: t.id, role: m.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT', parts: [{ text: m.content }], ...(m.role === 'assistant' ? { metadata: aiMeta(this.cardName(), s.operator) } : {}) };
        });
      const n = o.historyLength;
      out.history = n === undefined ? msgs : msgs.slice(-n);
    }
    return out;
  }

  get(peer: Peer, p: Record<string, unknown>): A2ATask {
    const t = this.#ownTask(peer, p.id);
    const hl = p.historyLength === undefined || p.historyLength === null ? undefined : checkInt(p.historyLength, 'historyLength', 0, 1000);
    return this.view(t, { ...(hl !== undefined ? { historyLength: hl } : {}) });
  }

  list(peer: Peer, p: Record<string, unknown>): { tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number } {
    const pageSize = p.pageSize === undefined || p.pageSize === null || p.pageSize === '' ? 50 : checkInt(p.pageSize, 'pageSize', 1, 100);
    if (p.status !== undefined && p.status !== '' && !TASK_STATES.includes(p.status as TaskState)) throw bad('status', 'status must be a TaskState.');
    if (p.contextId !== undefined && (typeof p.contextId !== 'string' || p.contextId.length > 128)) throw bad('contextId', 'contextId must be a short id.');
    let cursor: { at: string; id: string } | undefined;
    if (p.pageToken) {
      try {
        const [at, id] = Buffer.from(String(p.pageToken), 'base64url').toString('utf8').split('|');
        if (!at || !id || Number.isNaN(Date.parse(at))) throw new Error();
        cursor = { at, id };
      } catch {
        throw bad('pageToken', 'That pageToken is not one this server gave out.');
      }
    }
    let after: string | undefined;
    if (p.statusTimestampAfter) {
      if (Number.isNaN(Date.parse(String(p.statusTimestampAfter)))) throw bad('statusTimestampAfter', 'statusTimestampAfter must be a timestamp.');
      after = new Date(String(p.statusTimestampAfter)).toISOString();
    }
    const hl = p.historyLength === undefined || p.historyLength === null || p.historyLength === '' ? 0 : checkInt(p.historyLength, 'historyLength', 0, 1000);
    const r = this.store.listTasks(peer.id, 'in', { ...(typeof p.contextId === 'string' && p.contextId ? { contextId: p.contextId } : {}), ...(p.status ? { state: p.status as TaskState } : {}), ...(after ? { after } : {}), ...(cursor ? { cursor } : {}), limit: pageSize });
    return {
      tasks: r.rows.map((t) => this.view(t, { historyLength: hl, artifacts: p.includeArtifacts === true })),
      nextPageToken: r.next ? Buffer.from(`${r.next.at}|${r.next.id}`).toString('base64url') : '',
      pageSize,
      totalSize: r.total,
    };
  }

  async cancel(peer: Peer, p: Record<string, unknown>): Promise<A2ATask> {
    const t = this.#ownTask(peer, p.id);
    if (TERMINAL.has(t.state)) throw new A2AError('TaskNotCancelable', `The task is already ${t.state}.`);
    const live = this.#live.get(t.id);
    if (live) {
      live.canceled = true;
      live.controller.stop();
      await Promise.race([live.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    const now = this.store.task(t.id)!;
    if (!TERMINAL.has(now.state)) this.#setState(now, 'TASK_STATE_CANCELED', this.#agentMessage(now, 'Canceled by the agent that asked.'));
    return this.view(this.store.task(t.id)!);
  }

  #subscribeStart(peer: Peer, id: string): TaskRow {
    const t = this.#ownTask(peer, id);
    if (TERMINAL.has(t.state)) throw new A2AError('UnsupportedOperation', `The task is already ${t.state}: subscribe only to tasks that are still going.`);
    return t;
  }

  /** The task first, then its updates until it ends (spec §3.1.6). */
  async #follow(t: TaskRow, emit: (ev: StreamResponse) => void, stopOnInterrupt = false): Promise<void> {
    emit({ task: this.view(t) });
    const live = this.#live.get(t.id);
    if (!live) return;
    await new Promise<void>((resolve) => {
      const fn = (ev: StreamResponse) => {
        emit(ev);
        const st = 'statusUpdate' in ev ? ev.statusUpdate.status.state : undefined;
        if (st && (TERMINAL.has(st) || (stopOnInterrupt && INTERRUPTED.has(st)))) {
          live.listeners.delete(fn);
          resolve();
        }
      };
      live.listeners.add(fn);
      void live.done.then(() => {
        live.listeners.delete(fn);
        resolve();
      });
    });
  }

  /** SendMessage: blocking until the task ends or is interrupted, unless returnImmediately. */
  async send(peer: Peer, body: unknown): Promise<{ task: A2ATask }> {
    const r = checkSendRequest(body);
    const t = this.#begin(peer, r);
    if (!r.returnImmediately && !TERMINAL.has(t.state)) await this.#untilSettled(t.id);
    return { task: this.view(this.store.task(t.id)!, { ...(r.historyLength !== undefined ? { historyLength: r.historyLength } : {}) }) };
  }

  /** SendStreamingMessage: the Task, then status and artifact updates, closing when it ends or waits. */
  async sendStream(peer: Peer, body: unknown, emit: (ev: StreamResponse) => void): Promise<void> {
    const r = checkSendRequest(body);
    const t = this.#begin(peer, r, true);
    if (TERMINAL.has(t.state) && !this.#live.has(t.id)) return void emit({ task: this.view(t) });
    await this.#follow(t, emit, true);
  }

  #untilSettled(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const fn = (ev: StreamResponse) => {
        const st = 'statusUpdate' in ev ? ev.statusUpdate.status.state : undefined;
        if (st && (TERMINAL.has(st) || INTERRUPTED.has(st))) {
          live.listeners.delete(fn);
          resolve();
        }
      };
      live.listeners.add(fn);
      void live.done.then(() => {
        live.listeners.delete(fn);
        resolve();
      });
    });
  }

  #agentMessage(t: Pick<TaskRow, 'id' | 'contextId'>, text: string): A2AMessage {
    const s = this.settings();
    return { messageId: randomUUID(), contextId: t.contextId, taskId: t.id, role: 'ROLE_AGENT', parts: [{ text }], metadata: aiMeta(this.cardName(), s.operator) };
  }

  #emit(id: string, ev: StreamResponse): void {
    for (const fn of [...(this.#live.get(id)?.listeners ?? [])]) {
      try {
        fn(ev);
      } catch {
        /* a closed stream */
      }
    }
  }

  #setState(t: Pick<TaskRow, 'id' | 'contextId'>, state: TaskState, message?: A2AMessage | null): void {
    const row = this.store.setTask(t.id, { state, ...(message !== undefined ? { statusMessage: message } : {}) });
    if (!row) return;
    const status: TaskStatus = { state, timestamp: row.updatedAt, ...(row.statusMessage ? { message: row.statusMessage } : {}) };
    this.#emit(t.id, { statusUpdate: { taskId: t.id, contextId: t.contextId, status } });
  }

  /** The conversation of a peer's context (in the built-in Agents project). */
  #conversation(peer: Peer, contextId: string, first = ''): string {
    const key = `${peer.id}:${contextId}`;
    const found = this.app.store.findChannelConversation(A2A_CHANNEL, key);
    if (found) return found.id;
    const projectId = this.app.planner ? this.app.planner.projectId(AGENTS_PROJECT) : null;
    // Titled by who asks and what it asked first, so the Agents project's list tells contexts apart.
    const what = first.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(please do this task and reply with what you did or found:\s*)/i, '');
    return this.app.store.createConversation({ title: (what ? `${peer.label}: ${what}` : `${peer.label} (agent)`).slice(0, 60), channel: A2A_CHANNEL, channelKey: key, projectId }).id;
  }

  /** Creates (or continues) the task, checks the budget, and starts her turn. */
  #begin(peer: Peer, r: SendRequest, streaming = false): TaskRow {
    const m = r.message;
    let task: TaskRow | undefined;
    let contextId = m.contextId;
    if (m.taskId) {
      task = this.#ownTask(peer, m.taskId);
      if (contextId && contextId !== task.contextId) throw bad('message.contextId', 'contextId does not match the task (spec §3.4.3).');
      contextId = task.contextId;
      if (TERMINAL.has(task.state)) throw new A2AError('UnsupportedOperation', `The task is ${task.state}: it takes no more messages. Send a new message without taskId (with the same contextId) to continue.`);
      if (task.state !== 'TASK_STATE_INPUT_REQUIRED') throw new A2AError('UnsupportedOperation', task.state === 'TASK_STATE_AUTH_REQUIRED' ? 'The task is waiting for the owner to approve something.' : 'The task is still working: wait for it, or cancel it.');
    }
    if (contextId) {
      // A context this peer started (or a new id it picked): another peer's ids can't be joined.
      const other = (this.store.db.prepare("SELECT peer_id FROM a2a_tasks WHERE context_id = ? AND direction = 'in' LIMIT 1").get(contextId) as Row | undefined)?.peer_id;
      if (other !== undefined && other !== peer.id) throw bad('message.contextId', 'That contextId belongs to another conversation.');
    }
    contextId ??= randomUUID();
    const conversationId = this.#conversation(peer, contextId, m.parts.find((p) => typeof p.text === 'string')?.text ?? '');
    // Budgets (STAPLES §2.1.5): a full ledger or the day's task cap refuses with REJECTED and the reason.
    const ledger = this.store.ledger(`a2a:${peer.id}`);
    const why = !task && this.store.tasksToday(peer.id, 'in') >= peer.policy.tasksPerDay
      ? `This agent has used all ${peer.policy.tasksPerDay} tasks for today. Try again tomorrow.`
      : ledger.tokens >= peer.policy.tokensPerDay
        ? `This agent has used its ${peer.policy.tokensPerDay} tokens for today. Try again tomorrow.`
        : peer.policy.usdPerDay > 0 && ledger.usd >= peer.policy.usdPerDay
          ? `This agent has used its $${peer.policy.usdPerDay.toFixed(2)} for today. Try again tomorrow.`
          : this.app.isBusy?.(conversationId)
            ? 'She is still answering in this context: wait for that task, or cancel it.'
            : undefined;
    const continuing = Boolean(task);
    if (!task) task = this.store.addTask({ peerId: peer.id, direction: 'in', contextId, state: 'TASK_STATE_SUBMITTED', conversationId });
    // The peer answered her question: the task works again (its snapshot no longer says INPUT_REQUIRED).
    if (continuing && !why) {
      this.#setState(task, 'TASK_STATE_WORKING', null);
      task = this.store.task(task.id)!;
    }
    if (why) {
      this.#setState(task, 'TASK_STATE_REJECTED', this.#agentMessage(task, why));
      return this.store.task(task.id)!;
    }
    const listeners = new Set<(ev: StreamResponse) => void>();
    let stop = () => {};
    let resolveDone!: () => void;
    const live: Live = { controller: { stop: () => stop() }, listeners, done: new Promise<void>((res) => (resolveDone = res)) };
    this.#live.set(task.id, live);
    const t = task;
    // Started on the next tick, so a stream sends the Task before the first update.
    setImmediate(() => {
      void this.#work(peer, t, r, conversationId, live, (fn) => (stop = fn))
        .catch((err: Error) => {
          console.warn(`a2a task: ${err.message}`);
          const cur = this.store.task(t.id);
          if (cur && !TERMINAL.has(cur.state)) this.#setState(cur, 'TASK_STATE_FAILED', this.#agentMessage(cur, 'Something went wrong on this side.'));
        })
        .finally(() => {
          this.#live.delete(t.id);
          resolveDone();
        });
    });
    void streaming;
    return this.store.task(t.id)!;
  }

  /** Her turn for the peer's message, mapped to task states (STAPLES §8.2 state mapping). */
  async #work(peer: Peer, t: TaskRow, r: SendRequest, conversationId: string, live: Live, setStop: (fn: () => void) => void): Promise<void> {
    const app = this.app;
    const s = this.settings();
    const name = this.cardName();
    const runTracked = app.runTracked;
    if (!runTracked) return this.#setState(t, 'TASK_STATE_FAILED', this.#agentMessage(t, 'This server cannot run turns for agents.'));
    const { text, images } = partsToText(r.message.parts);
    const uploads = images.flatMap((im) => {
      try {
        return app.uploads ? [app.uploads.save(`data:${im.mediaType};base64,${im.raw}`).id] : [];
      } catch {
        return [];
      }
    });
    const tools = peer.policy.tools.flatMap((k) => PEER_TOOLS[k].tools);
    const auto = peer.policy.tools.flatMap((k) => PEER_TOOLS[k].auto);
    // A skill the owner offered this peer, when it asks for it (metadata.skill or a mention).
    const want = String((r.message.metadata?.skill ?? r.metadata?.skill ?? '') as string);
    const notes = peer.policy.skills
      .filter((n) => n === want || new RegExp(`\\b${n.replace(/-/g, '[- ]')}\\b`, 'i').test(text))
      .slice(0, 1)
      .flatMap((n) => {
        const v = app.skills?.resolve(n);
        return v && v.enabled ? [app.skills!.activation(v)] : [];
      });
    const outside: OutsidePolicy = { source: `a2a:${peer.id}`, label: peer.label, operator: s.operator, tools, auto, approvals: 'ask', memory: peer.policy.memory, ...(notes.length ? { notes } : {}) };
    const before = app.usage?.forConversation(conversationId);
    const lastId = app.store.lastMessageId(conversationId);
    const firstOfContext = !app.store.messages(conversationId).some((m) => m.role === 'assistant');
    this.#setState(t, 'TASK_STATE_WORKING', null);
    // The reply streams as one artifact ('reply'), the disclosure first in a context's first answer.
    const artifactId = `reply-${t.id.slice(0, 8)}`;
    let sent = '';
    let pending = firstOfContext ? `${disclosureLine(name, s.operator)}\n\n` : '';
    let first = true;
    let held = false;
    let step = '';
    let reply = '';
    let replaced: string | undefined;
    let approvalAt = 0;
    let approvalSummary = '';
    let denied = false;
    let timedOut = false;
    let budgetStop = false;
    let toolsAfterText = false;
    let error = '';
    let crisis = false;
    const flush = (last: boolean) => {
      if (!pending && !last) return;
      const chunk = pending;
      pending = '';
      sent += chunk;
      this.#emit(t.id, { artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: { artifactId, name: 'Answer', parts: [{ text: chunk }], metadata: aiMeta(name, s.operator) }, append: !first, lastChunk: last } });
      first = false;
    };
    const timer = setInterval(() => flush(false), 250);
    const deadline = setTimeout(() => {
      budgetStop = true;
      app.stopTurn?.(conversationId);
    }, peer.policy.taskMinutes * 60_000);
    setStop(() => app.stopTurn?.(conversationId));
    try {
      await runTracked(
        conversationId,
        text,
        (ev: ChatEvent) => {
          if (ev.type === 'notice' && ev.kind === 'crisis') {
            crisis = true;
            pending += `${CRISIS_RESOURCES}\n\n`;
          } else if (ev.type === 'token') {
            step += ev.text;
            reply += ev.text;
            if (!held && minorSexualMatch(reply, { fromHer: true }) && reply.trim() !== MINOR_BLOCK_REPLY) held = true;
            if (!held) pending += ev.text;
          } else if (ev.type === 'replace') replaced = ev.text;
          else if (ev.type === 'tool_call') {
            step = '';
            if (reply.trim()) toolsAfterText = true;
          } else if (ev.type === 'approval') {
            approvalAt = Date.now();
            approvalSummary = ev.summary;
            // In-task authorisation (spec §7.6): the task waits for the owner's card.
            this.#setState(t, 'TASK_STATE_AUTH_REQUIRED', this.#agentMessage(t, `Waiting for ${s.operator} to approve: ${ev.summary}`));
          } else if (ev.type === 'tool_running' || (ev.type === 'tool_result' && ev.status !== 'denied' && approvalAt)) {
            if (approvalAt) {
              approvalAt = 0;
              this.#setState(t, 'TASK_STATE_WORKING', null);
            }
          } else if (ev.type === 'tool_result' && ev.status === 'denied' && approvalAt) {
            // A card the owner declined (or let run out) ends the task; she doesn't go on.
            if (Date.now() - approvalAt >= 9.5 * 60_000) timedOut = true;
            else denied = true;
            app.stopTurn?.(conversationId);
          } else if (ev.type === 'budget' && ev.state.stage === 'reached') budgetStop = true;
          else if (ev.type === 'error') error = ev.message;
        },
        { outside, externalApp: true, ...(tools.length ? {} : { noTools: true }), budget: { tokens: peer.policy.taskTokens, minutes: peer.policy.taskMinutes }, ...(uploads.length ? { images: uploads } : {}) },
      );
    } catch (err) {
      error = (err as Error).message;
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
    }
    // Tag this task's messages (history mapping: messageId kept in the message's meta).
    for (const msg of app.store.messages(conversationId).filter((x) => x.id > lastId)) {
      if (msg.role === 'user') app.store.updateMessageMeta(msg.id, { a2aTask: t.id, a2aId: r.message.messageId, a2aPeer: peer.id });
      else if (msg.role === 'assistant') app.store.updateMessageMeta(msg.id, { a2aTask: t.id, a2aId: randomUUID() });
    }
    const after = app.usage?.forConversation(conversationId);
    if (before && after) this.store.addLedger(`a2a:${peer.id}`, { tokens: after.tokens - before.tokens, usd: after.usd - before.usd, runs: 1 });
    else this.store.addLedger(`a2a:${peer.id}`, { runs: 1 });
    let finalText = replaced !== undefined ? reply.slice(0, reply.length - step.length) + replaced : held ? MINOR_BLOCK_REPLY : reply;
    finalText = finalText.trim();
    const blocked = finalText === MINOR_BLOCK_REPLY;
    if (held || replaced !== undefined) {
      // What was streamed is replaced by the checked words (spec: a new artifact chunk, not appended).
      pending = '';
      sent = '';
      first = true;
      pending = `${firstOfContext ? `${disclosureLine(name, s.operator)}\n\n` : ''}${crisis ? `${CRISIS_RESOURCES}\n\n` : ''}${finalText}`;
    }
    const full = `${firstOfContext ? `${disclosureLine(name, s.operator)}\n\n` : ''}${crisis ? `${CRISIS_RESOURCES}\n\n` : ''}${finalText}`;
    const cur = this.store.task(t.id)!;
    if (live.canceled) {
      if (finalText) this.store.putArtifact(t.id, { artifactId, name: 'Answer (stopped)', parts: [{ text: full }], metadata: aiMeta(name, s.operator) });
      flush(true);
      return this.#setState(cur, 'TASK_STATE_CANCELED', this.#agentMessage(cur, 'Canceled by the agent that asked.'));
    }
    if (blocked) {
      flush(true);
      return this.#setState(cur, 'TASK_STATE_REJECTED', this.#agentMessage(cur, MINOR_BLOCK_REPLY));
    }
    if (denied) {
      flush(true);
      return this.#setState(cur, 'TASK_STATE_REJECTED', this.#agentMessage(cur, `${s.operator} declined: ${approvalSummary}`));
    }
    if (timedOut) {
      flush(true);
      return this.#setState(cur, 'TASK_STATE_FAILED', this.#agentMessage(cur, `No answer from ${s.operator} in time for: ${approvalSummary}`));
    }
    if (budgetStop || (error && finalText)) {
      // A graceful stop: the partial answer is kept as an artifact (STAPLES §8.2 budget).
      if (finalText) this.store.putArtifact(t.id, { artifactId, name: 'Partial answer', parts: [{ text: full }], metadata: aiMeta(name, s.operator) });
      flush(true);
      return this.#setState(cur, 'TASK_STATE_FAILED', this.#agentMessage(cur, budgetStop ? 'Stopped at this task’s budget; the partial answer is attached.' : `Stopped: ${error.slice(0, 200)}`));
    }
    if (error || !finalText) {
      flush(true);
      return this.#setState(cur, 'TASK_STATE_FAILED', this.#agentMessage(cur, error ? `Something went wrong: ${error.slice(0, 200)}` : 'No answer came back.'));
    }
    if (!toolsAfterText && asksBack(finalText)) {
      // Her reply asks the agent something: the task waits for its answer (INPUT_REQUIRED).
      flush(true);
      return this.#setState(cur, 'TASK_STATE_INPUT_REQUIRED', this.#agentMessage(cur, full));
    }
    this.store.putArtifact(t.id, { artifactId, name: 'Answer', parts: [{ text: full }], metadata: aiMeta(name, s.operator) });
    flush(true);
    this.#setState(cur, 'TASK_STATE_COMPLETED', null);
  }

  /** The Agents page: peers with today's numbers, and the last 20 requests. */
  overview(): { peers: (Peer & { today: { tasks: number; tokens: number; usd: number; sent: number }; expiresAt: string | null })[]; recent: { id: string; peer: string; direction: string; state: TaskState; at: string; conversationId: string | null; text: string }[] } {
    const peers = this.store.peers().map((p) => {
      const l = this.store.ledger(`a2a:${p.id}`);
      return { ...p, today: { tasks: this.store.tasksToday(p.id, 'in'), tokens: l.tokens, usd: l.usd, sent: this.store.tasksToday(p.id, 'out') }, expiresAt: p.deviceId ? (this.opts.auth.expiresOf(p.deviceId) ?? null) : null };
    });
    const label = new Map(this.store.peers(true).map((p) => [p.id, p.label]));
    const recent = this.store.recent(20).map((t) => ({ id: t.id, peer: label.get(t.peerId) ?? t.peerId, direction: t.direction, state: t.state, at: t.updatedAt, conversationId: t.conversationId, text: (t.statusMessage?.parts[0]?.text ?? '').slice(0, 160) }));
    return { peers, recent };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > LIMITS.bodyBytes) throw new A2AError('ContentTypeNotSupported', 'The request is too large (a file part is at most 2 MB).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > LIMITS.bodyBytes) throw new A2AError('ContentTypeNotSupported', 'The request is too large (a file part is at most 2 MB).');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const b = await readBody(req);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    throw new A2AError('ParseError');
  }
}

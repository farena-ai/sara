// EC22 (docs/ops/EC2122_DESIGN.md): a small client for Sara's HTTP API. Zero dependencies: fetch,
// ReadableStream, TextDecoder and WebCrypto only, so it runs in Node 18+, Deno, Bun, workers and
// browsers. Every route it calls is in ./routes.ts (docs/API.md is generated from that table).
import { fill, ROUTES, type Route } from './routes.ts';
import { sseData } from './sse.ts';

export { fill, ROUTES, type Auth, type Route } from './routes.ts';
export { verifyWebhook, type WebhookInput, type WebhookResult } from './webhooks.ts';
export { sseData } from './sse.ts';

export interface SaraOptions {
  /** Where Sara runs, e.g. `https://sara.example.com` or `http://127.0.0.1:3000`. */
  server: string;
  /** A device token (from `auth.signIn`) for /api, or an API key for /v1. */
  token?: string;
  /** Your fetch (tests, proxies, older runtimes). Defaults to the global one. */
  fetch?: typeof fetch;
}

/** An error from Sara: the HTTP status and her message (in plain words). */
export class SaraError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = 'SaraError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface DeviceCode {
  code: string;
  pollToken: string;
  verifyUrl: string;
  interval: number;
  expiresAt: string;
  approveIn: string;
}
export interface WhoAmI {
  companion: string;
  device: { id: string; label: string; scope: string } | null;
  disclosureAccepted: boolean;
  disclosure: string;
}
export interface Conversation {
  id: string;
  title: string;
  mode: 'chat' | 'coding' | string;
  createdAt: string;
  updatedAt: string;
  working?: boolean;
  [k: string]: unknown;
}
export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'notice' | string;
  content: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}
export interface PendingApproval {
  approvalId: string;
  name: string;
  summary: string;
}
export interface ConversationView extends Conversation {
  messages: Message[];
  earlier: number;
  activity: { status: string; detail?: string; approvals: PendingApproval[] } | null;
}

/** The events of a streamed reply (the common ones are typed; others arrive as `OtherEvent`). */
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'notice'; kind?: string; text: string }
  | { type: 'tool_call'; id: string; name: string; summary: string; args?: unknown }
  | { type: 'tool_running'; id: string; name: string; summary: string }
  | { type: 'tool_result'; id: string; name: string; status: 'ok' | 'error' | 'denied'; output: string; ms: number }
  | { type: 'approval'; approvalId: string; id: string; name: string; summary: string; args?: unknown; alwaysOk?: boolean }
  | { type: 'replace'; messageId: number; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; messageId?: number }
  | OtherEvent;
export interface OtherEvent {
  type: 'image' | 'file' | 'proof' | 'claim_check' | 'sandbox' | 'budget' | 'checks' | 'mentions' | 'loop_guard' | 'contradiction' | 'unattended' | 'redteam' | 'advisory' | 'plugin' | 'tool_progress' | 'tool_delta' | 'sandbox_running' | 'checks_card';
  [k: string]: unknown;
}

export interface ReplyResult {
  text: string;
  events: ChatEvent[];
  approvals: { approvalId: string; name: string; summary: string; approved: boolean }[];
  error?: string;
}

export interface V1Message {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
}
export interface V1ChatInput {
  model: string;
  messages: V1Message[];
  /** Your conversation key (one conversation per key in Sara). */
  user?: string;
}
export interface V1Completion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: { index: number; message: { role: 'assistant'; content: string }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface V1ResponsesInput {
  model: string;
  input: string | { type?: 'message'; role: 'system' | 'developer' | 'user' | 'assistant'; content: string | ({ type: 'input_text' | 'output_text'; text: string } | { type: 'input_image'; image_url: string })[] }[];
  instructions?: string;
  previous_response_id?: string;
  /** false: not kept, so it can't be continued or read back. */
  store?: boolean;
}
export interface V1Response {
  id: string;
  object: 'response';
  status: 'completed' | 'failed' | 'in_progress' | string;
  model: string;
  previous_response_id: string | null;
  output: ({ type: 'message'; id: string; status: string; role: 'assistant'; content: { type: 'output_text'; text: string }[] } | { type: 'sara:tool_call'; id: string; status: string; name: string; summary: string; result: string | null } | { type: string; id: string; status: string })[];
  error: { code: string; message: string } | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  [k: string]: unknown;
}
export type V1ResponseEvent = { type: string; sequence_number: number; delta?: string; response?: V1Response; approval_id?: string; summary?: string; [k: string]: unknown };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

const route = (sdk: string): Route => {
  const r = ROUTES.find((x) => x.sdk === sdk);
  if (!r) throw new Error(`No route for ${sdk}`);
  return r;
};

export class Sara {
  readonly server: string;
  token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(o: SaraOptions) {
    const s = String(o.server ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(s)) throw new Error('server must be an http(s) address, like https://sara.example.com');
    this.server = s;
    this.token = o.token;
    this.#fetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  }

  /** One call by its SDK name (see ROUTES): JSON or raw bytes in; the Response back (errors thrown). */
  async request(sdk: string, o: { params?: Record<string, string | number>; query?: Record<string, string>; json?: unknown; bytes?: Uint8Array | ArrayBuffer | Blob; signal?: AbortSignal } = {}): Promise<Response> {
    const r = route(sdk);
    const q = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query)}` : '';
    const headers: Record<string, string> = {};
    if (this.token && r.auth !== 'none') headers.authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (o.bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = o.bytes as BodyInit;
    } else if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.server}${fill(r.path, o.params)}${q}`, { method: r.method, headers, ...(body !== undefined ? { body } : {}), ...(o.signal ? { signal: o.signal } : {}), redirect: 'error' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new SaraError(0, `Couldn't reach ${this.server}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      const e = (data as { error?: unknown } | undefined)?.error;
      const msg = typeof e === 'string' ? e : typeof (e as { message?: unknown })?.message === 'string' ? String((e as { message: string }).message) : `HTTP ${res.status}`;
      const code = typeof (e as { code?: unknown })?.code === 'string' ? String((e as { code: string }).code) : undefined;
      throw new SaraError(res.status, msg, code, data);
    }
    return res;
  }

  async #json<T>(sdk: string, o: Parameters<Sara['request']>[1] = {}): Promise<T> {
    const res = await this.request(sdk, o);
    return (await res.json()) as T;
  }

  /** Signing in with a device code: the person approves the code in Sara; the SDK keeps the token. */
  readonly auth = {
    start: (name: string): Promise<DeviceCode> => this.#json<DeviceCode>('auth.start', { json: { name } }),
    poll: async (pollToken: string): Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired'; token?: string; deviceId?: string }> => {
      try {
        return await this.#json('auth.poll', { json: { pollToken } });
      } catch (err) {
        if (err instanceof SaraError && err.status === 410) return { status: 'expired' };
        throw err;
      }
    },
    /** Start, show the code (`onCode`), poll until approved; resolves the token (also kept on this client). */
    signIn: async (o: { name: string; onCode: (c: DeviceCode) => void | Promise<void>; signal?: AbortSignal; intervalMs?: number }): Promise<string> => {
      const c = await this.auth.start(o.name);
      await o.onCode(c);
      const until = Date.parse(c.expiresAt) || Date.now() + 600_000;
      while (Date.now() < until) {
        await sleep(o.intervalMs ?? Math.max(1, c.interval) * 1000, o.signal);
        const p = await this.auth.poll(c.pollToken);
        if (p.status === 'approved' && p.token) {
          this.token = p.token;
          return p.token;
        }
        if (p.status === 'denied') throw new SaraError(403, 'The sign-in was denied.');
        if (p.status === 'expired') break;
      }
      throw new SaraError(410, 'The code expired. Start the sign-in again.');
    },
    whoami: (): Promise<WhoAmI> => this.#json<WhoAmI>('auth.whoami'),
    signOut: async (): Promise<void> => {
      await this.request('auth.signOut', { json: {} });
      this.token = undefined;
    },
  };

  readonly conversations = {
    list: (): Promise<Conversation[]> => this.#json<Conversation[]>('conversations.list'),
    create: (o: { title?: string; mode?: 'chat' | 'coding' } = {}): Promise<Conversation> => this.#json<Conversation>('conversations.create', { json: o }),
    get: (id: string, o: { limit?: number } = {}): Promise<ConversationView> => this.#json<ConversationView>('conversations.get', { params: { id }, ...(o.limit ? { query: { limit: String(o.limit) } } : {}) }),
    stop: async (id: string): Promise<void> => {
      await this.request('conversations.stop', { params: { id }, json: {} });
    },
  };

  /** Sends a message and yields her reply as it streams (tokens, tool steps, approval cards, done). */
  async *chat(conversationId: string, content: string, o: { docs?: number[]; signal?: AbortSignal } = {}): AsyncGenerator<ChatEvent> {
    const res = await this.request('chat.send', { params: { id: conversationId }, json: { content, ...(o.docs?.length ? { docs: o.docs } : {}) }, ...(o.signal ? { signal: o.signal } : {}) });
    if (!res.body) throw new SaraError(502, 'The reply had no body.');
    for await (const ev of sseData(res.body, o.signal)) if (ev && typeof ev === 'object' && typeof (ev as { type?: unknown }).type === 'string') yield ev as ChatEvent;
  }

  /**
   * Sends a message and waits for the whole reply. Approval cards go to `onApproval` (return true to
   * allow); without it they are left for the person to answer in Sara.
   */
  async reply(conversationId: string, content: string, o: { docs?: number[]; signal?: AbortSignal; onToken?: (t: string) => void; onApproval?: (a: Extract<ChatEvent, { type: 'approval' }>) => boolean | Promise<boolean> } = {}): Promise<ReplyResult> {
    let text = '';
    let error: string | undefined;
    const events: ChatEvent[] = [];
    const approvals: ReplyResult['approvals'] = [];
    for await (const ev of this.chat(conversationId, content, o)) {
      events.push(ev);
      if (ev.type === 'token') {
        text += ev.text;
        o.onToken?.(ev.text);
      } else if (ev.type === 'replace') text = ev.text;
      else if (ev.type === 'error') error = ev.message;
      else if (ev.type === 'approval' && o.onApproval) {
        const a = ev as Extract<ChatEvent, { type: 'approval' }>;
        const approved = Boolean(await o.onApproval(a));
        await this.approvals.answer(a.approvalId, approved);
        approvals.push({ approvalId: a.approvalId, name: a.name, summary: a.summary, approved });
      }
    }
    return { text, events, approvals, ...(error ? { error } : {}) };
  }

  readonly approvals = {
    /** Allow or deny one card (`approvalId` from an `approval` event). */
    answer: async (approvalId: string, approved: boolean, how?: string): Promise<void> => {
      await this.request('approvals.answer', { params: { id: approvalId }, json: { approved, ...(how ? { how } : {}) } });
    },
    /** The cards waiting in one conversation (e.g. after a reconnect). */
    pending: async (conversationId: string): Promise<PendingApproval[]> => (await this.conversations.get(conversationId, { limit: 1 })).activity?.approvals ?? [],
  };

  readonly files = {
    /** Uploads a document; with `conversationId` it is shared with that chat (send `doc.id` in `docs`). */
    upload: (data: Uint8Array | ArrayBuffer | Blob, o: { name: string; conversationId?: string; keep?: boolean }): Promise<{ doc: { id: number; name: string; [k: string]: unknown }; already?: boolean }> =>
      this.#json('files.upload', { bytes: data, query: { name: o.name, keep: o.keep ? '1' : '0', ...(o.conversationId ? { conversation: o.conversationId } : {}) } }),
  };

  /** The OpenAI-compatible API (token = an API key from Settings → Connections → Other apps). */
  readonly v1 = ((self: Sara) => ({
    models: (): Promise<{ object: 'list'; data: { id: string; object: 'model'; created: number; owned_by: string; name: string }[] }> => self.#json('v1.models'),
    chat: (i: V1ChatInput): Promise<V1Completion> => self.#json<V1Completion>('v1.chat', { json: { ...i, stream: false } }),
    /** Streams the reply's text pieces. */
    async *chatStream(i: V1ChatInput, signal?: AbortSignal): AsyncGenerator<string> {
      const res = await self.request('v1.chat', { json: { ...i, stream: true }, ...(signal ? { signal } : {}) });
      if (!res.body) return;
      for await (const ev of sseData(res.body, signal)) {
        const e = ev as { error?: { message?: string; code?: string }; choices?: { delta?: { content?: string } }[] };
        if (e.error) throw new SaraError(502, e.error.message ?? 'The reply failed.', e.error.code);
        const piece = e.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
    },
    /** Open Responses (`/v1/responses`): create, stream the semantic events, read or delete a stored one. */
    responses: {
      create: (i: V1ResponsesInput): Promise<V1Response> => self.#json<V1Response>('v1.responses', { json: { ...i, stream: false } }),
      /** Streams the events (`response.output_text.delta`, `sara:approval`, …); the last one is terminal. */
      async *stream(i: V1ResponsesInput, signal?: AbortSignal): AsyncGenerator<V1ResponseEvent> {
        const res = await self.request('v1.responses', { json: { ...i, stream: true }, ...(signal ? { signal } : {}) });
        if (!res.body) return;
        for await (const ev of sseData(res.body, signal)) yield ev as V1ResponseEvent;
      },
      get: (id: string): Promise<V1Response> => self.#json<V1Response>('v1.responses.get', { params: { id } }),
      delete: (id: string): Promise<{ id: string; object: 'response.deleted'; deleted: true }> => self.#json('v1.responses.delete', { params: { id } }),
    },
  }))(this);
}

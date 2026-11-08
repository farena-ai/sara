// C5: Open Responses (https://www.openresponses.org, spec 2026-04-24) next to /v1/chat/completions.
// POST /v1/responses runs ONE turn through the same turn engine, key, rate limit and safety layer as
// chat/completions; GET and DELETE /v1/responses/:id read and remove a stored response.
//
// Context: the request's `input` items (and, with `previous_response_id`, the earlier response's
// input and output first) are the history for this turn, like `X-Sara-History: client`. The last
// user message is the new turn; system/developer items and `instructions` become a low-priority note
// after her own instructions (never replacing them). Her character, memory, AI disclosure, crisis help
// and the minors block apply as everywhere.
//
// Tools: the app's own function tools are never run (as on chat/completions); her own tools run only
// when the owner allows them for other apps, with her normal approval rules. Each of her tool steps is
// a `sara:tool_call` output item (the spec's rule for hosted tools: a prefixed item type); an approval
// card she waits on streams as a `sara:approval` event and is answered in Sara (POST /api/approvals/:id).
// Not offered: /v1/responses/compact, the WebSocket transport, background mode.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './chat.ts';
import { BASE_HEADERS, readBody, sendError, sendJson, type OpenAIDeps } from './openai-api.ts';
import { appConversation, companionForModel, conversationKey, externalTurn, otherAppsSettings, type Caller } from './other-apps.ts';
import { UploadError } from './uploads.ts';

/** Stored responses: kept 30 days, at most this many per key (oldest go first). */
const KEEP_DAYS = 30;
const KEEP_PER_KEY = 500;
/** Lines of carried context kept per stored response (older ones drop off first). */
const MAX_CONTEXT = 400;
const MAX_IMAGES = 4;

type Line = { role: 'user' | 'assistant'; content: string };
interface Item {
  id: string;
  type: string;
  status: string;
  [k: string]: unknown;
}

const rid = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

function ensureTable(app: AppContext): void {
  app.store.db.exec(`CREATE TABLE IF NOT EXISTS api_responses (
  id TEXT PRIMARY KEY, caller TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  context TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS api_responses_caller ON api_responses(caller, created_at);`);
}

interface Stored {
  conversationId: string;
  context: Line[];
  body: Record<string, unknown>;
}

function load(app: AppContext, caller: Caller, id: string): Stored | undefined {
  ensureTable(app);
  const r = app.store.db.prepare('SELECT conversation_id, context, body FROM api_responses WHERE id = ? AND caller = ?').get(id, caller.id) as { conversation_id: string; context: string; body: string } | undefined;
  if (!r) return undefined;
  return { conversationId: r.conversation_id, context: JSON.parse(r.context) as Line[], body: JSON.parse(r.body) as Record<string, unknown> };
}

function save(app: AppContext, caller: Caller, conversationId: string, context: Line[], body: Record<string, unknown>): void {
  ensureTable(app);
  const db = app.store.db;
  const now = Math.floor(app.now().getTime() / 1000);
  db.prepare('INSERT OR REPLACE INTO api_responses (id, caller, conversation_id, created_at, context, body) VALUES (?, ?, ?, ?, ?, ?)').run(String(body.id), caller.id, conversationId, now, JSON.stringify(context.slice(-MAX_CONTEXT)), JSON.stringify(body));
  db.prepare('DELETE FROM api_responses WHERE created_at < ?').run(now - KEEP_DAYS * 86_400);
  db.prepare('DELETE FROM api_responses WHERE caller = ? AND id NOT IN (SELECT id FROM api_responses WHERE caller = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)').run(caller.id, caller.id, KEEP_PER_KEY);
}

/** Text of a content value: a string, or parts with input_text / output_text / text. */
function partsText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v
    .map((p) => (p && typeof p === 'object' && ['input_text', 'output_text', 'text', 'summary_text'].includes(String((p as { type?: unknown }).type)) ? String((p as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function partsImages(v: unknown): string[] | string {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object' || (p as { type?: unknown }).type !== 'input_image') continue;
    const url = (p as { image_url?: unknown }).image_url;
    if (typeof url !== 'string' || !url.startsWith('data:')) return 'Send pictures as data: URLs (input_image.image_url); Sara does not fetch pictures from web addresses.';
    out.push(url);
  }
  return out;
}

interface Parsed {
  lines: { role: string; content: string; images: string[] }[];
}

/** The request's `input`: a string, or a list of items (messages; other item types are skipped). */
function parseInput(v: unknown): Parsed | string {
  if (typeof v === 'string') return { lines: [{ role: 'user', content: v, images: [] }] };
  if (!Array.isArray(v) || !v.length) return '`input` must be a string or a non-empty list of items.';
  if (v.length > 2000) return 'Too many input items.';
  const lines: Parsed['lines'] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object') return 'Each input item must be an object.';
    const type = String((it as { type?: unknown }).type ?? 'message');
    if (type !== 'message') continue; // function_call(_output), reasoning, item_reference: nothing to run here
    const role = String((it as { role?: unknown }).role ?? '');
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) return `Unknown role "${role.slice(0, 20)}".`;
    const content = (it as { content?: unknown }).content;
    const images = role === 'user' ? partsImages(content) : [];
    if (typeof images === 'string') return images;
    lines.push({ role, content: partsText(content), images });
  }
  return { lines };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

/** The Response object (every field the spec's ResponseResource lists). */
function responseObject(o: { id: string; created: number; model: string; body: Record<string, unknown>; status: string; output: Item[]; error: { code: string; message: string } | null; usage: { input: number; output: number } | undefined; completedAt: number | null; store: boolean }): Record<string, unknown> {
  const b = o.body;
  return {
    id: o.id,
    object: 'response',
    created_at: o.created,
    completed_at: o.completedAt,
    status: o.status,
    incomplete_details: null,
    model: o.model,
    previous_response_id: strOrNull(b.previous_response_id),
    instructions: strOrNull(b.instructions),
    output: o.output,
    error: o.error,
    tools: [],
    tool_choice: 'auto',
    truncation: 'auto',
    parallel_tool_calls: false,
    text: { format: { type: 'text' } },
    top_p: num(b.top_p, 1),
    presence_penalty: num(b.presence_penalty, 0),
    frequency_penalty: num(b.frequency_penalty, 0),
    top_logprobs: 0,
    temperature: num(b.temperature, 1),
    reasoning: null,
    usage: o.usage ? { input_tokens: o.usage.input, output_tokens: o.usage.output, total_tokens: o.usage.input + o.usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } : null,
    max_output_tokens: typeof b.max_output_tokens === 'number' ? Math.floor(b.max_output_tokens) : null,
    max_tool_calls: null,
    store: o.store,
    background: false,
    service_tier: 'default',
    metadata: b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata) ? b.metadata : {},
    safety_identifier: strOrNull(b.safety_identifier),
    prompt_cache_key: strOrNull(b.prompt_cache_key),
  };
}

/** GET / DELETE /v1/responses/:id, POST /v1/responses. */
export async function handleResponses(req: IncomingMessage, res: ServerResponse, rest: string[], deps: OpenAIDeps, caller: Caller): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 1 && (method === 'GET' || method === 'DELETE')) {
    const id = rest[0];
    const found = /^resp_[a-f0-9]{32}$/.test(id) ? load(deps.app, caller, id) : undefined;
    if (!found) return sendError(res, 404, `No stored response with id "${id.slice(0, 60)}" for this key.`, 'invalid_request_error', 'response_not_found');
    if (method === 'GET') return sendJson(res, found.body);
    deps.app.store.db.prepare('DELETE FROM api_responses WHERE id = ? AND caller = ?').run(id, caller.id);
    return sendJson(res, { id, object: 'response.deleted', deleted: true });
  }
  if (rest.length) return sendError(res, 404, 'Sara offers POST /v1/responses and GET or DELETE /v1/responses/{id} (no compact or input_items).', 'invalid_request_error', 'unknown_url');
  if (method !== 'POST') return sendError(res, 405, 'Use POST.', 'invalid_request_error', 'method_not_allowed');
  return createResponse(req, res, deps, caller);
}

async function createResponse(req: IncomingMessage, res: ServerResponse, deps: OpenAIDeps, caller: Caller): Promise<void> {
  const body = await readBody(req);
  if (typeof body === 'string') return sendError(res, 400, body, 'invalid_request_error', 'invalid_body');
  const who = companionForModel(body.model, deps.app, deps.companions);
  if (!who) return sendError(res, 404, `The model "${String(body.model).slice(0, 60)}" does not exist. Use "sara" or a name from GET /v1/models.`, 'invalid_request_error', 'model_not_found');
  const app = who.app;
  const input = parseInput(body.input);
  if (typeof input === 'string') return sendError(res, 400, input, 'invalid_request_error', 'invalid_input');
  let prev: Stored | undefined;
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    prev = load(app, caller, String(body.previous_response_id));
    if (!prev) return sendError(res, 404, `Previous response "${String(body.previous_response_id).slice(0, 60)}" was not found (it may have been deleted, sent with store: false, or made with another key).`, 'invalid_request_error', 'previous_response_not_found');
  }
  const lastUserAt = input.lines.map((l, i) => ({ l, i })).filter((x) => x.l.role === 'user').at(-1);
  if (!lastUserAt || (!lastUserAt.l.content.trim() && !lastUserAt.l.images.length)) return sendError(res, 400, 'There is no user message to answer.', 'invalid_request_error', 'no_user_message');
  if (lastUserAt.l.images.length > MAX_IMAGES) return sendError(res, 400, `Up to ${MAX_IMAGES} pictures per message.`, 'invalid_request_error', 'too_many_images');
  if (!app.settings.get().disclosureAcceptedAt) return sendError(res, 403, `Open ${app.persona.name} in a browser once and accept the AI notice first.`, 'invalid_request_error', 'disclosure_not_accepted');
  let images: string[] = [];
  try {
    images = lastUserAt.l.images.map((u) => (app.uploads ? app.uploads.save(u).id : '')).filter(Boolean);
  } catch (err) {
    if (err instanceof UploadError) return sendError(res, 400, err.message, 'invalid_request_error', 'invalid_image');
    throw err;
  }
  const s = otherAppsSettings(app.settings.get());
  const header = req.headers['x-sara-conversation'];
  const convId = prev?.conversationId ?? appConversation(app, 'api', caller, conversationKey((Array.isArray(header) ? header[0] : header) || body.user || 'responses'));
  const note = [typeof body.instructions === 'string' ? body.instructions.trim() : '', ...input.lines.filter((l) => l.role === 'system' || l.role === 'developer').map((l) => l.content.trim())].filter(Boolean).join('\n\n');
  const fromInput: Line[] = input.lines.slice(0, lastUserAt.i).filter((l) => (l.role === 'user' || l.role === 'assistant') && l.content.trim()).map((l) => ({ role: l.role as Line['role'], content: l.content }));
  const history = [...(prev?.context ?? []), ...fromInput];
  const opts = { noTools: !s.tools, clientHistory: history, ...(images.length ? { images } : {}), ...(note ? { clientNote: { app: caller.label, text: note } } : {}) };

  if (!deps.limiter.begin(caller.id)) return sendError(res, 429, 'This key already has two replies running. Wait for one to finish.', 'rate_limit_exceeded', 'too_many_running', { 'retry-after': '5' });
  const id = rid('resp');
  const created = Math.floor(app.now().getTime() / 1000);
  const model = String(body.model ?? '').trim() || 'sara';
  const store = body.store !== false;
  const stream = body.stream === true;
  const output: Item[] = [];
  const toolItems = new Map<string, Item>();
  let msg: Item | undefined;
  let msgText = '';
  let seq = 0;
  const write = (s: string) => {
    if (stream && !res.destroyed && !res.writableEnded) res.write(s);
  };
  const emit = (type: string, fields: Record<string, unknown>) => write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`);
  const snapshot = (status: string, extra: { error?: { code: string; message: string } | null; usage?: { input: number; output: number }; completed?: boolean } = {}) =>
    responseObject({ id, created, model, body, status, output: structuredClone(output), error: extra.error ?? null, usage: extra.usage, completedAt: extra.completed ? Math.floor(app.now().getTime() / 1000) : null, store });
  const outputIndex = (it: Item) => output.indexOf(it);
  const closeMessage = () => {
    if (!msg) return;
    const part = { type: 'output_text', text: msgText, annotations: [], logprobs: [] };
    msg.content = [part];
    msg.status = 'completed';
    emit('response.output_text.done', { item_id: msg.id, output_index: outputIndex(msg), content_index: 0, text: msgText, logprobs: [] });
    emit('response.content_part.done', { item_id: msg.id, output_index: outputIndex(msg), content_index: 0, part });
    emit('response.output_item.done', { output_index: outputIndex(msg), item: msg });
    msg = undefined;
    msgText = '';
  };
  const addText = (t: string) => {
    if (!t) return;
    if (!msg) {
      msg = { id: rid('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
      output.push(msg);
      emit('response.output_item.added', { output_index: outputIndex(msg), item: { ...msg, content: [] } });
      emit('response.content_part.added', { item_id: msg.id, output_index: outputIndex(msg), content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    msgText += t;
    msg.content = [{ type: 'output_text', text: msgText, annotations: [], logprobs: [] }];
    emit('response.output_text.delta', { item_id: msg.id, output_index: outputIndex(msg), content_index: 0, delta: t, logprobs: [] });
  };
  const finishTools = (status: string) => {
    for (const it of toolItems.values()) {
      if (it.status !== 'in_progress') continue;
      it.status = status;
      emit('response.output_item.done', { output_index: outputIndex(it), item: it });
    }
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', connection: 'keep-alive', ...BASE_HEADERS });
      emit('response.created', { response: snapshot('in_progress') });
      emit('response.in_progress', { response: snapshot('in_progress') });
      heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
    }
    let said = false;
    const r = await externalTurn(app, convId, lastUserAt.l.content, opts, {
      onNotice: (t) => addText(`${t}\n\n`),
      onText: (t) => {
        addText(t);
        if (t.trim()) said = true;
      },
      onToolCall: (c) => {
        closeMessage();
        const it: Item = { id: rid('stc'), type: 'sara:tool_call', status: 'in_progress', call_id: c.id, name: c.name, summary: c.summary, result: null };
        toolItems.set(c.id, it);
        output.push(it);
        emit('response.output_item.added', { output_index: outputIndex(it), item: it });
      },
      onApproval: (summary, ids) => {
        const it = toolItems.get(ids.callId);
        emit('sara:approval', { approval_id: ids.approvalId, item_id: it?.id ?? null, name: ids.name, summary: summary.slice(0, 500), answer_in: 'Sara (or POST /api/approvals/{approval_id} with an owner device)' });
      },
      onToolResult: (t) => {
        const it = toolItems.get(t.id);
        if (!it || it.status !== 'in_progress') return;
        it.status = t.status === 'ok' ? 'completed' : 'failed';
        it.result = t.status;
        emit('response.output_item.done', { output_index: outputIndex(it), item: it });
      },
    });
    finishTools('incomplete');
    const failed = r.busy ? { code: 'conversation_busy', message: `${app.persona.name} is still answering in this conversation. Wait for her, or use another conversation.` } : r.error && !said && !r.text.trim() ? { code: 'turn_failed', message: r.error } : null;
    if (failed) {
      if (!stream) {
        if (r.busy) return sendError(res, 409, failed.message, 'invalid_request_error', 'conversation_busy');
        // UX 14: the AI notice (and crisis help) still reach the app when the turn fails.
        return sendError(res, 500, [msgText, r.error ?? ''].filter((x) => x.trim()).join('\n\n'), 'model_error', 'turn_failed');
      }
      closeMessage();
      emit('response.failed', { response: snapshot('failed', { error: failed, completed: false }) });
      write('data: [DONE]\n\n');
      return;
    }
    closeMessage();
    const final = snapshot('completed', { completed: true, ...(r.usage ? { usage: r.usage } : {}) });
    // Her own words go on with the chain (not the AI notice, which the next turn shows again when due).
    const reply = r.text;
    if (store) save(app, caller, convId, [...history, { role: 'user', content: lastUserAt.l.content }, ...(reply.trim() ? [{ role: 'assistant' as const, content: reply }] : [])], final);
    if (!stream) return sendJson(res, final);
    emit('response.completed', { response: final });
    write('data: [DONE]\n\n');
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (stream && !res.writableEnded) res.end();
    deps.limiter.end(caller.id);
  }
}

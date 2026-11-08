// Phase 57: an OpenAI-compatible API, so SillyTavern, Open WebUI, Raycast, phone shortcuts and
// scripts can talk to her with her own memory and personality: GET /v1/models lists her
// companions as models; POST /v1/chat/completions runs ONE turn through the normal turn engine.
//
// How history works: apps resend the whole conversation every time. By default only the LAST
// user message is taken as the new turn; she answers from her own history and memory in a
// conversation kept for that API key (and the conversation key the app picks with the `user`
// field or an X-Sara-Conversation header). With `X-Sara-History: client` the app's own earlier
// messages are used instead (for apps that manage their own context); the app's system messages
// then become a low-priority note after her own instructions. Either way her character, the AI
// disclosure, crisis help and the minors block apply, and tools/function calls from the app are
// ignored (her own tools only when the owner allows it, with her normal approval rules).
// C5: POST /v1/responses (Open Responses) lives in open-responses.ts on the same key and limits.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OwnerAuth } from './auth.ts';
import type { AppContext } from './chat.ts';
import type { CompanionManager } from './companions.ts';
import { handleResponses } from './open-responses.ts';
import { appConversation, callerOf, companionForModel, contentText, conversationKey, corsAllowed, externalTurn, KeyLimiter, modelIds, otherAppsSettings, type Caller } from './other-apps.ts';

export interface OpenAIDeps {
  app: AppContext;
  auth: OwnerAuth;
  companions?: CompanionManager;
  demo?: boolean;
  limiter: KeyLimiter;
}

const MAX_BODY = 4 * 1024 * 1024;
export const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

/** An error in OpenAI's shape: { error: { message, type, param, code } }. */
export function sendError(res: ServerResponse, status: number, message: string, type: string, code: string | null = null, extra: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...extra });
  res.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

export function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return 'Request body too large.';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) return 'Request body too large.';
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'The body must be a JSON object.';
    return v as Record<string, unknown>;
  } catch {
    return 'The body is not valid JSON.';
  }
}

interface InMessage {
  role: string;
  content: string;
}

/** The messages an app sent: role + plain text (pictures, tool calls and names are left out). */
export function cleanMessages(v: unknown): InMessage[] | string {
  if (!Array.isArray(v) || !v.length) return '`messages` must be a non-empty list.';
  if (v.length > 2000) return 'Too many messages.';
  const out: InMessage[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object') return 'Each message must be an object with a role and content.';
    const role = String((m as { role?: unknown }).role ?? '');
    if (!['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(role)) return `Unknown role "${role.slice(0, 20)}".`;
    out.push({ role, content: contentText((m as { content?: unknown }).content) });
  }
  return out;
}

/** "SillyTavern" from its user agent, else the key's label. */
function appName(req: IncomingMessage, caller: Caller): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const known = /SillyTavern|Open ?WebUI|Raycast|LibreChat|LobeChat|Chatbox|TypingMind|Msty|Jan\b/i.exec(ua)?.[0];
  return known ?? caller.label;
}

/** Handles /v1/*. Returns false when the path isn't one of ours (the caller answers 404). */
export async function handleOpenAI(req: IncomingMessage, res: ServerResponse, path: string, deps: OpenAIDeps): Promise<void> {
  const method = req.method ?? 'GET';
  if (deps.demo) return sendError(res, 404, 'The API for other apps is off on the demo server.', 'invalid_request_error', 'not_available');
  const s = otherAppsSettings(deps.app.settings.get());
  if (!corsAllowed(req, res, s)) return sendError(res, 403, 'This web address may not use the API. Allow it in Sara: Settings → Connections → Other apps → Browser apps that may call her.', 'invalid_request_error', 'origin_not_allowed');
  if (method === 'OPTIONS') {
    res.writeHead(204, BASE_HEADERS);
    return void res.end();
  }
  const caller = callerOf(req, deps.auth);
  if (!caller) return sendError(res, 401, 'Incorrect or missing API key. Make one in Sara: Settings → Connections → Other apps → Create an API key.', 'invalid_request_error', 'invalid_api_key', { 'www-authenticate': 'Bearer' });
  const wait = deps.limiter.take(caller.id);
  if (wait) return sendError(res, 429, `Too many requests with this key. Try again in ${wait} seconds.`, 'rate_limit_exceeded', 'rate_limit_exceeded', { 'retry-after': String(wait) });

  let parts: string[]; // ['v1', 'models', …]
  try {
    parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    // Hardening L6: a broken %-sequence is an unknown address, not a server error.
    return sendError(res, 404, `Unknown endpoint ${method} ${path.slice(0, 80)}. Sara offers GET /v1/models, POST /v1/chat/completions and POST /v1/responses.`, 'invalid_request_error', 'unknown_url');
  }
  const created = Math.floor(Date.parse(deps.app.store.firstOwnerMessageAt()?.toISOString() ?? '2026-01-01T00:00:00Z') / 1000);
  if (parts[1] === 'models' && method === 'GET') {
    const ids = modelIds(deps.app, deps.companions);
    const model = (id: string, name: string) => ({ id, object: 'model', created, owned_by: 'sara', name });
    if (parts[2]) {
      const want = parts.slice(2).join('/');
      const m = ids.find((x) => x.id === want.toLowerCase());
      if (!m) return sendError(res, 404, `The model "${want.slice(0, 60)}" does not exist. GET /v1/models lists her companions.`, 'invalid_request_error', 'model_not_found');
      return sendJson(res, model(m.id, m.who.app.persona.name));
    }
    return sendJson(res, { object: 'list', data: ids.map((x) => model(x.id, x.who.app.persona.name)) });
  }
  if (parts[1] === 'chat' && parts[2] === 'completions' && !parts[3]) {
    if (method !== 'POST') return sendError(res, 405, 'Use POST.', 'invalid_request_error', 'method_not_allowed');
    return chatCompletions(req, res, deps, caller);
  }
  // C5: Open Responses.
  if (parts[1] === 'responses') return handleResponses(req, res, parts.slice(2), deps, caller);
  return sendError(res, 404, `Unknown endpoint ${method} ${path.slice(0, 80)}. Sara offers GET /v1/models, POST /v1/chat/completions and POST /v1/responses.`, 'invalid_request_error', 'unknown_url');
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse, deps: OpenAIDeps, caller: Caller): Promise<void> {
  const body = await readBody(req);
  if (typeof body === 'string') return sendError(res, 400, body, 'invalid_request_error', 'invalid_body');
  const who = companionForModel(body.model, deps.app, deps.companions);
  if (!who) return sendError(res, 404, `The model "${String(body.model).slice(0, 60)}" does not exist. Use "sara" or a name from GET /v1/models.`, 'invalid_request_error', 'model_not_found');
  const msgs = cleanMessages(body.messages);
  if (typeof msgs === 'string') return sendError(res, 400, msgs, 'invalid_request_error', 'invalid_messages');
  const lastUser = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'user').at(-1);
  if (!lastUser || !lastUser.m.content.trim()) return sendError(res, 400, 'There is no user message to answer.', 'invalid_request_error', 'no_user_message');
  const app = who.app;
  if (!app.settings.get().disclosureAcceptedAt) return sendError(res, 403, `Open ${app.persona.name} in a browser once and accept the AI notice first.`, 'invalid_request_error', 'disclosure_not_accepted');
  const s = otherAppsSettings(app.settings.get());

  // Which conversation: the app's choice, or one per key.
  const header = req.headers['x-sara-conversation'];
  const key = conversationKey((Array.isArray(header) ? header[0] : header) || body.user);
  const convId = appConversation(app, 'api', caller, key);
  const clientMode = String(req.headers['x-sara-history'] ?? '').toLowerCase() === 'client';
  const name = appName(req, caller);
  const system = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content.trim()).filter(Boolean).join('\n\n');
  const earlier = clientMode ? msgs.slice(0, lastUser.i).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })) : undefined;
  const opts = { noTools: !s.tools, ...(earlier ? { clientHistory: earlier } : {}), ...(clientMode && system ? { clientNote: { app: name, text: system } } : {}) };

  if (!deps.limiter.begin(caller.id)) return sendError(res, 429, 'This key already has two replies running. Wait for one to finish.', 'rate_limit_exceeded', 'too_many_running', { 'retry-after': '5' });
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(app.now().getTime() / 1000);
  const model = String(body.model ?? '').trim() || 'sara';
  const stream = body.stream === true;
  try {
    if (!stream) {
      const r = await externalTurn(app, convId, lastUser.m.content, opts);
      if (r.busy) return sendError(res, 409, `${app.persona.name} is still answering in this conversation. Wait for her, or use another conversation key.`, 'invalid_request_error', 'conversation_busy');
      const content = [...r.notices, r.text].filter((x) => x.trim()).join('\n\n');
      // UX 14: the AI notice (and crisis help) still reach the app when the turn fails.
      if (r.error && !r.text.trim()) return sendError(res, 502, [...r.notices, r.error].filter((x) => x.trim()).join('\n\n'), 'api_error', 'turn_failed');
      return sendJson(res, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null }],
        ...(r.usage ? { usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output } } : {}),
        system_fingerprint: null,
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', connection: 'keep-alive', ...BASE_HEADERS });
    const write = (s: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(s);
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: null, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...extra })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    let said = false;
    const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
    try {
      const r = await externalTurn(app, convId, lastUser.m.content, opts, {
        onNotice: (t) => chunk({ content: `${t}\n\n` }),
        onText: (t) => {
          chunk({ content: t });
          if (t.trim()) said = true;
        },
        onApproval: (summary) => write(`: waiting for the owner's OK in Sara: ${summary.replace(/[\r\n]+/g, ' ').slice(0, 200)}\n\n`),
      });
      if (r.busy) write(`data: ${JSON.stringify({ error: { message: `${app.persona.name} is still answering in this conversation.`, type: 'invalid_request_error', param: null, code: 'conversation_busy' } })}\n\n`);
      // UX 14: the notice was streamed already; a turn that then failed still ends with the error.
      else if (r.error && !said && !r.text.trim()) write(`data: ${JSON.stringify({ error: { message: r.error, type: 'api_error', param: null, code: 'turn_failed' } })}\n\n`);
      else {
        chunk({}, 'stop');
        const so = body.stream_options as { include_usage?: unknown } | undefined;
        if (so?.include_usage === true && r.usage) write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output } })}\n\n`);
      }
      write('data: [DONE]\n\n');
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  } finally {
    deps.limiter.end(caller.id);
  }
}

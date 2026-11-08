// EC22: every route the SDK calls, in one table. docs/API.md is generated from it
// (scripts/api-reference.ts) and a test calls each one on a throwaway Sara, so the reference and
// the server can't drift apart.

export type Auth = 'none' | 'device' | 'api-key' | 'owner';

export interface Route {
  /** The SDK method that uses it. */
  sdk: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `:name` marks a path parameter. */
  path: string;
  auth: Auth;
  summary: string;
  body?: string;
  returns: string;
}

export const ROUTES: readonly Route[] = [
  { sdk: 'auth.start', method: 'POST', path: '/api/device/start', auth: 'none', summary: 'Start a device-code sign-in. Show `code` to the person; they approve it in Sara (Settings → Data & health → Devices and sign-in, or `verifyUrl`).', body: '{ name: string; scope?: "full" }', returns: '{ code, pollToken, verifyUrl, interval, expiresAt, approveIn }' },
  { sdk: 'auth.poll', method: 'POST', path: '/api/device/poll', auth: 'none', summary: 'Poll the sign-in every `interval` seconds until it is approved, denied or expired (410).', body: '{ pollToken: string }', returns: '{ status: "pending" | "approved" | "denied" | "expired"; token?; deviceId? }' },
  { sdk: 'auth.whoami', method: 'GET', path: '/api/device/whoami', auth: 'device', summary: 'Who this token belongs to, and whether the AI notice was accepted.', returns: '{ companion, device: { id, label, scope } | null, disclosureAccepted, disclosure }' },
  { sdk: 'auth.signOut', method: 'POST', path: '/api/device/logout', auth: 'device', summary: 'Sign this app out (the token stops working).', body: '{}', returns: '{ ok: true }' },
  { sdk: 'conversations.list', method: 'GET', path: '/api/conversations', auth: 'device', summary: 'Her conversations, newest first.', returns: 'Conversation[]' },
  { sdk: 'conversations.create', method: 'POST', path: '/api/conversations', auth: 'device', summary: 'Start a conversation.', body: '{ title?: string; mode?: "chat" | "coding" }', returns: 'Conversation' },
  { sdk: 'conversations.get', method: 'GET', path: '/api/conversations/:id', auth: 'device', summary: 'One conversation with its latest messages (`?limit=`) and what she is doing now (`activity.approvals` waiting for an answer).', returns: 'Conversation & { messages, earlier, activity }' },
  { sdk: 'chat.send', method: 'POST', path: '/api/conversations/:id/messages', auth: 'device', summary: 'Send a message; the reply streams back as server-sent events (`data: {"type": …}` per line): token, tool_call, tool_result, approval, notice, error, done.', body: '{ content: string; docs?: number[] }', returns: 'text/event-stream of ChatEvent' },
  { sdk: 'conversations.stop', method: 'POST', path: '/api/conversations/:id/stop', auth: 'device', summary: 'Stop her current reply in this conversation.', body: '{}', returns: '{ ok: true }' },
  { sdk: 'approvals.answer', method: 'POST', path: '/api/approvals/:id', auth: 'device', summary: 'Answer an approval card (`approvalId` of an `approval` event): allow or deny.', body: '{ approved: boolean; how?: string }', returns: '{ ok: true }' },
  { sdk: 'files.upload', method: 'POST', path: '/api/library', auth: 'device', summary: 'Upload a document (raw bytes, `?name=&conversation=&keep=0|1`). Without `keep` it is shared with one conversation; send its id in `docs` with the next message.', body: 'application/octet-stream', returns: '{ doc: { id, name, … }; already?: boolean }' },
  { sdk: 'v1.models', method: 'GET', path: '/v1/models', auth: 'api-key', summary: 'OpenAI-compatible: her companions as models.', returns: '{ object: "list"; data: { id, object, created, owned_by, name }[] }' },
  { sdk: 'v1.chat', method: 'POST', path: '/v1/chat/completions', auth: 'api-key', summary: 'OpenAI-compatible: one turn with her memory and character (`stream: true` for chunks). Her own approval rules apply; approvals are answered in Sara.', body: '{ model: string; messages: { role, content }[]; stream?: boolean; user?: string }', returns: 'chat.completion | text/event-stream of chat.completion.chunk' },
  { sdk: 'v1.responses', method: 'POST', path: '/v1/responses', auth: 'api-key', summary: 'Open Responses (openresponses.org): one turn from `input` items (text, `input_image` data URLs); `previous_response_id` continues a stored response; `stream: true` sends the spec\'s semantic events. Her own tool steps are `sara:tool_call` items, approval cards a `sara:approval` event (answered in Sara).', body: '{ model: string; input: string | Item[]; instructions?: string; previous_response_id?: string; store?: boolean; stream?: boolean }', returns: 'Response | text/event-stream of response.* events' },
  { sdk: 'v1.responses.get', method: 'GET', path: '/v1/responses/:id', auth: 'api-key', summary: 'A stored response (kept 30 days, this key only).', returns: 'Response' },
  { sdk: 'v1.responses.delete', method: 'DELETE', path: '/v1/responses/:id', auth: 'api-key', summary: 'Delete a stored response (her conversation in Sara keeps its messages).', returns: '{ id; object: "response.deleted"; deleted: true }' },
];

/** A route's path with its parameters filled in (each one URL-encoded). */
export function fill(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:(\w+)/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined || v === '') throw new Error(`Missing ${k} for ${path}`);
    return encodeURIComponent(String(v));
  });
}

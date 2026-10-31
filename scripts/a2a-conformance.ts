// Phase 100 (ST5, docs/A2A.md): a minimal A2A 1.0 conformance check of a running server against the
// shapes the specification requires (https://a2a-protocol.org/latest/specification/, a2a.proto):
// the Agent Card's required fields, the JSON-RPC 2.0 envelope (jsonrpc/id/result|error), the method
// names, the error codes, the A2A-Version header, a streamed SendStreamingMessage (SSE, every event a
// JSON-RPC response with exactly one of task/message/statusUpdate/artifactUpdate), GetTask,
// ListTasks paging, CancelTask, a terminal task refusing SubscribeToTask, and the HTTP+JSON binding.
// Read-only apart from the tasks it creates (they use the agent's key, so its daily limits apply).
//   SARA_A2A_URL=http://127.0.0.1:7860 SARA_A2A_KEY=sara_dev.… node scripts/a2a-conformance.ts
// Exits 1 when a check fails; skips (exit 0, with the reason) when the URL or key is missing.
const base = (process.env.SARA_A2A_URL ?? '').replace(/\/+$/, '');
const key = process.env.SARA_A2A_KEY ?? '';
if (!base || !key) {
  console.log('skipped: set SARA_A2A_URL (the server) and SARA_A2A_KEY (an agent key from Settings → Connections → Other agents).');
  process.exit(0);
}

type Json = Record<string, any>;
let failed = 0;
let passed = 0;
function check(name: string, ok: unknown, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}
const STATES = new Set(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED']);
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const isTask = (t: Json | undefined) => Boolean(t && typeof t.id === 'string' && typeof t.contextId === 'string' && t.status && STATES.has(t.status.state));
const oneOf = (o: Json, keys: string[]) => keys.filter((k) => o[k] !== undefined).length === 1;

let n = 0;
async function rpc(url: string, method: string, params: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const id = ++n;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'a2a-version': '1.0', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const body = (await r.json().catch(() => ({}))) as Json;
  check(`${method}: a JSON-RPC 2.0 response with the same id and exactly one of result/error`, body.jsonrpc === '2.0' && body.id === id && oneOf(body, ['result', 'error']), body);
  if (body.error) check(`${method}: error has an integer code and a message`, Number.isInteger(body.error.code) && typeof body.error.message === 'string', body.error);
  return { status: r.status, body };
}
async function* sse(res: Response): AsyncGenerator<Json> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      buf = buf.slice(i + 2);
      if (data) yield JSON.parse(data) as Json;
    }
  }
}
const message = (text: string, extra: Json = {}) => ({ message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra } });

// 1. Discovery.
const cardRes = await fetch(`${base}/.well-known/agent-card.json`);
check('agent card: 200 at /.well-known/agent-card.json, JSON', cardRes.ok && /json/.test(cardRes.headers.get('content-type') ?? ''), cardRes.status);
const card = (await cardRes.json().catch(() => ({}))) as Json;
for (const f of ['name', 'description', 'version']) check(`agent card: ${f} is a string`, typeof card[f] === 'string' && card[f]);
check('agent card: capabilities object', card.capabilities && typeof card.capabilities === 'object');
check('agent card: defaultInputModes / defaultOutputModes arrays', Array.isArray(card.defaultInputModes) && Array.isArray(card.defaultOutputModes));
check('agent card: skills array', Array.isArray(card.skills));
const ifaces = (card.supportedInterfaces ?? []) as Json[];
check('agent card: supportedInterfaces with url, protocolBinding, protocolVersion', ifaces.length > 0 && ifaces.every((i) => typeof i.url === 'string' && typeof i.protocolBinding === 'string' && typeof i.protocolVersion === 'string'), ifaces);
const rpcUrl = ifaces.find((i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0')?.url as string | undefined;
const restUrl = ifaces.find((i) => i.protocolBinding === 'HTTP+JSON' && i.protocolVersion === '1.0')?.url as string | undefined;
check('agent card: a JSONRPC 1.0 interface', rpcUrl);
const schemes = card.securitySchemes ?? {};
check('agent card: security schemes are one-of wrappers (httpAuthSecurityScheme …)', Object.values(schemes).every((s: any) => s && Object.keys(s).length === 1 && /SecurityScheme$/.test(Object.keys(s)[0])), schemes);
if (!rpcUrl) {
  console.log(`\n${passed} passed, ${failed} failed (no JSON-RPC interface: stopping)`);
  process.exit(1);
}

// 2. The envelope and errors.
const bad = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'a2a-version': '1.0' }, body: '{not json' });
const badBody = (await bad.json().catch(() => ({}))) as Json;
check('parse error: -32700 with id null', badBody.error?.code === -32700 && badBody.id === null, badBody);
check('unknown method: -32601', (await rpc(rpcUrl, 'tasks/teleport', {})).body.error?.code === -32601);
check('A2A-Version 0.3: VersionNotSupportedError -32009', (await rpc(rpcUrl, 'ListTasks', {}, { 'a2a-version': '0.3' })).body.error?.code === -32009);
check('GetTask of an unknown id: TaskNotFoundError -32001', (await rpc(rpcUrl, 'GetTask', { id: 'no-such-task-00000' })).body.error?.code === -32001);
check('invalid params (a message without parts): -32602', (await rpc(rpcUrl, 'SendMessage', { message: { messageId: 'x', role: 'ROLE_USER' } })).body.error?.code === -32602);
const unauth = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }) });
check('no key: 401 with WWW-Authenticate', unauth.status === 401 && Boolean(unauth.headers.get('www-authenticate')), unauth.status);

// 3. Extended card (when offered).
if (card.capabilities?.extendedAgentCard) {
  const ext = (await rpc(rpcUrl, 'GetExtendedAgentCard', {})).body.result as Json | undefined;
  check('GetExtendedAgentCard: a card with skills', ext && Array.isArray(ext.skills) && typeof ext.name === 'string', ext);
}

// 4. Streaming.
let streamedId = '';
if (card.capabilities?.streaming) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'a2a-version': '1.0', accept: 'text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'stream-1', method: 'SendStreamingMessage', params: message('Write four short sentences about bread, one per line.') }) });
  check('SendStreamingMessage: text/event-stream', /text\/event-stream/.test(res.headers.get('content-type') ?? ''), res.headers.get('content-type'));
  const events: Json[] = [];
  for await (const ev of sse(res)) events.push(ev);
  check('stream: every event is a JSON-RPC response with the request id', events.length > 0 && events.every((e) => e.jsonrpc === '2.0' && e.id === 'stream-1' && oneOf(e, ['result', 'error'])), events[0]);
  const results = events.map((e) => e.result ?? {});
  check('stream: every result has exactly one of task/message/statusUpdate/artifactUpdate', results.every((r) => oneOf(r, ['task', 'message', 'statusUpdate', 'artifactUpdate'])), results.find((r) => !oneOf(r, ['task', 'message', 'statusUpdate', 'artifactUpdate'])));
  check('stream: starts with the task', isTask(results[0]?.task), results[0]);
  streamedId = results[0]?.task?.id ?? '';
  const last = results.at(-1)?.statusUpdate;
  check('stream: ends with a terminal or interrupted status update', last && (TERMINAL.has(last.status?.state) || ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(last.status?.state)), last);
  check('stream: updates carry taskId and contextId', results.slice(1).every((r) => { const u = r.statusUpdate ?? r.artifactUpdate; return u && u.taskId === streamedId && typeof u.contextId === 'string'; }));
  const arts = results.filter((r) => r.artifactUpdate).map((r) => r.artifactUpdate);
  check('stream: artifact updates have an artifactId and parts', arts.every((a) => a.artifact?.artifactId && Array.isArray(a.artifact.parts)), arts[0]);
}

// 5. SendMessage (blocking), GetTask, ListTasks.
const sent = (await rpc(rpcUrl, 'SendMessage', message('Say hello in one word.'))).body.result as Json | undefined;
check('SendMessage: result is exactly one of task/message', sent && oneOf(sent, ['task', 'message']), sent);
const tid = sent?.task?.id as string | undefined;
if (tid) {
  check('SendMessage: a task with id, contextId and a state', isTask(sent!.task), sent!.task);
  const got = (await rpc(rpcUrl, 'GetTask', { id: tid, historyLength: 1 })).body.result as Json | undefined;
  check('GetTask: the same task', got?.id === tid && isTask(got), got);
  check('GetTask historyLength 1: at most one history message', !got?.history || got.history.length <= 1, got?.history?.length);
}
const page = (await rpc(rpcUrl, 'ListTasks', { pageSize: 1 })).body.result as Json | undefined;
check('ListTasks: tasks, nextPageToken, pageSize, totalSize', page && Array.isArray(page.tasks) && typeof page.nextPageToken === 'string' && Number.isInteger(page.pageSize) && Number.isInteger(page.totalSize), page);
if (page?.nextPageToken) {
  const p2 = (await rpc(rpcUrl, 'ListTasks', { pageSize: 1, pageToken: page.nextPageToken })).body.result as Json | undefined;
  check('ListTasks: the next page is a different task', p2?.tasks?.[0]?.id && p2.tasks[0].id !== page.tasks[0]?.id, p2);
}
check('ListTasks pageSize 101: -32602', (await rpc(rpcUrl, 'ListTasks', { pageSize: 101 })).body.error?.code === -32602);

// 6. CancelTask and a terminal task.
const long = (await rpc(rpcUrl, 'SendMessage', { ...message('Write a long story of at least 600 words about a lighthouse keeper.'), configuration: { returnImmediately: true } })).body.result?.task as Json | undefined;
if (long?.id) {
  check('returnImmediately: the task comes back before it is done', !TERMINAL.has(long.status.state), long.status);
  await new Promise((r) => setTimeout(r, 1500));
  const c = (await rpc(rpcUrl, 'CancelTask', { id: long.id })).body;
  check('CancelTask: TASK_STATE_CANCELED (or TaskNotCancelableError -32002 if it already finished)', c.result?.status?.state === 'TASK_STATE_CANCELED' || c.error?.code === -32002, c);
  const again = (await rpc(rpcUrl, 'CancelTask', { id: long.id })).body;
  check('CancelTask on a terminal task: -32002', again.error?.code === -32002, again);
  check('SubscribeToTask on a terminal task: UnsupportedOperationError -32004', (await rpc(rpcUrl, 'SubscribeToTask', { id: long.id })).body.error?.code === -32004);
}
if (!card.capabilities?.pushNotifications) check('push configs unsupported: -32003', (await rpc(rpcUrl, 'CreateTaskPushNotificationConfig', { taskId: tid ?? 'x', url: 'https://example.invalid/hook' })).body.error?.code === -32003);

// 7. HTTP+JSON binding.
if (restUrl) {
  const r = await fetch(`${restUrl.replace(/\/+$/, '')}/tasks?pageSize=1`, { headers: { authorization: `Bearer ${key}`, 'a2a-version': '1.0' } });
  const j = (await r.json().catch(() => ({}))) as Json;
  check('REST GET /tasks: 200 with tasks', r.ok && Array.isArray(j.tasks), r.status);
  const nf = await fetch(`${restUrl.replace(/\/+$/, '')}/tasks/no-such-task-00000`, { headers: { authorization: `Bearer ${key}`, 'a2a-version': '1.0' } });
  const nj = (await nf.json().catch(() => ({}))) as Json;
  check('REST unknown task: 404 with error.details[].reason TASK_NOT_FOUND (google.rpc.ErrorInfo)', nf.status === 404 && nj.error?.details?.some((d: Json) => d.reason === 'TASK_NOT_FOUND' && d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'), nj);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

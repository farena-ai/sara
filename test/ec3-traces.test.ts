// EC3 (docs/ops/EC3_DESIGN.md §6): OpenTelemetry traces over OTLP/HTTP JSON, sampled per turn, with
// ids, names, sizes, durations and outcomes only; a collector that is down never breaks a turn.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { otlpBody, Tracer } from '../src/telemetry/otlp.ts';
import type { Tool } from '../src/tools/types.ts';
import { UsageStore } from '../src/usage.ts';
import { call, makeApp, readBody, ROOT, tempDir, text } from './helpers.ts';

const SENTINELS = ['SENTINEL-MESSAGE-9c1', 'SENTINEL-REPLY-9c1', 'SENTINEL-ARG-9c1', 'SENTINEL-OUTPUT-9c1', 'SENTINEL-LABEL-9c1', 'Alex'];
const ALLOWED_KEYS = new Set(['sara.conversation.id', 'sara.turn.outcome', 'sara.turn.first_token_ms', 'sara.turn.model_calls', 'sara.turn.tool_calls', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'sara.usage.cached_tokens', 'sara.cost_usd', 'sara.billing', 'sara.purpose', 'sara.outcome', 'sara.first_token_ms', 'sara.tool.name', 'sara.tool.output_bytes', 'sara.mcp.server', 'sara.test']);

const echo: Tool = {
  spec: { name: 'echo_fixture', description: 'Echo.', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  defaultPermission: 'auto',
  source: 'built-in',
  summarize: (a) => `echo ${String(a.q)}`,
  run: async () => 'SENTINEL-OUTPUT-9c1',
};

type Got = { path: string; headers: IncomingMessage['headers']; body: string };
async function collector(t: { after: (fn: () => Promise<void> | void) => void }, status = 200) {
  const got: Got[] = [];
  const srv = createServer(async (req, res) => {
    got.push({ path: req.url ?? '', headers: req.headers, body: await readBody(req) });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => srv.close(() => r())));
  return { got, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

async function boot(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date() };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.tools.add(echo);
  app.settings.update({
    providers: [{ id: 'openai', label: 'SENTINEL-LABEL-9c1', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }],
    defaultProviderId: 'openai',
    defaultModel: 'gpt-fixture',
    ownerName: 'Alex',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = auth.newToken!;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${owner}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const turn = async (content: string) => {
    const conv = app.store.createConversation({ title: 'Trace' });
    app.script.push(
      [call('c1', 'echo_fixture', { q: 'SENTINEL-ARG-9c1' }), { type: 'usage', input: 50, output: 9 }],
      [...text('SENTINEL-REPLY-9c1'), { type: 'usage', input: 80, output: 4 }],
    );
    const sse = await (await api(`/api/conversations/${conv.id}/messages`, 'POST', { content })).text();
    return { conv, sse };
  };
  return { app, base, api, turn };
}

const until = async (fn: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (fn()) return;
  throw new Error('timed out');
};

async function lastExport(api: (p: string) => Promise<Response>): Promise<{ ok: boolean; spans: number; error?: string }> {
  for (let i = 0; i < 200; i++) {
    const v = (await (await api('/api/telemetry')).json()).traces.last;
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no export status');
}

type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[]; status: { code: number } };
const spansOf = (body: string): Span[] => (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));

test('a sampled turn reaches the collector as OTLP JSON: one trace, a root, model and tool children, no text or secrets', async (t) => {
  const c = await collector(t);
  const { app, api, turn, base } = await boot(t);
  assert.equal((await api('/api/telemetry/headers', 'PUT', { headers: 'x-api-key: SENTINEL-KEY-9c1' })).status, 200);
  const view = await (await api('/api/telemetry')).json();
  assert.equal(view.traces.hasHeaders, true);
  assert.ok(!JSON.stringify(view).includes('SENTINEL-KEY-9c1'), 'headers are write-only');
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { enabled: true, endpoint: c.url, sample: 1 } })).status, 200);

  const { conv, sse } = await turn('SENTINEL-MESSAGE-9c1');
  assert.match(sse, /SENTINEL-REPLY-9c1/);
  await until(() => c.got.length === 1);
  const g = c.got[0];
  assert.equal(g.path, '/v1/traces');
  assert.equal(g.headers['content-type'], 'application/json');
  assert.equal(g.headers['x-api-key'], 'SENTINEL-KEY-9c1');
  const body = JSON.parse(g.body);
  const attrs = (list: { key: string; value: Record<string, unknown> }[]) => Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.equal(attrs(body.resourceSpans[0].resource.attributes)['service.name'], 'sara');
  assert.equal(body.resourceSpans[0].scopeSpans[0].scope.name, 'sara');
  const spans = spansOf(g.body);
  const root = spans.find((s) => s.name === 'sara.turn')!;
  assert.ok(root && !root.parentSpanId);
  assert.match(root.traceId, /^[0-9a-f]{32}$/);
  for (const s of spans) {
    assert.equal(s.traceId, root.traceId);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
    if (s !== root) assert.equal(s.parentSpanId, root.spanId);
    assert.match(s.startTimeUnixNano, /^\d{19}$/);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
    for (const a of s.attributes) assert.ok(ALLOWED_KEYS.has(a.key), `unexpected attribute ${a.key}`);
  }
  const models = spans.filter((s) => s.name === 'sara.model.call');
  assert.equal(models.length, 2);
  assert.equal(models[0].kind, 3);
  assert.equal(attrs(models[0].attributes)['gen_ai.request.model'], 'gpt-fixture');
  assert.equal(attrs(models[0].attributes)['gen_ai.system'], 'openai');
  assert.equal(attrs(models[0].attributes)['gen_ai.usage.input_tokens'], '50');
  const tools = spans.filter((s) => s.name === 'sara.tool.call');
  assert.equal(tools.length, 1);
  assert.equal(attrs(tools[0].attributes)['sara.tool.name'], 'echo_fixture');
  assert.equal(attrs(tools[0].attributes)['sara.tool.output_bytes'], String('SENTINEL-OUTPUT-9c1'.length));
  assert.equal(attrs(root.attributes)['sara.conversation.id'], conv.id);
  assert.equal(attrs(root.attributes)['sara.turn.outcome'], 'ok');
  assert.equal(root.status.code, 1);
  for (const s of [...SENTINELS, 'SENTINEL-KEY-9c1', ...app.vault.values()]) assert.ok(!g.body.includes(s), `leaked ${s}`);

  // The status shows on the page, and the export count on /metrics.
  const last = await lastExport(api);
  assert.equal(last.ok, true);
  assert.equal(last.spans, spans.length);
  await api('/api/telemetry', 'PUT', { metrics: { enabled: true, allow: ['127.0.0.0/8', '::1', '::ffff:127.0.0.1'] } });
  assert.match(await (await fetch(base + '/metrics')).text(), /^sara_trace_exports_total\{outcome="ok"\} 1$/m);
});

test('sampling: 0 sends nothing, and a ratio samples whole turns by the random draw', async (t) => {
  const c = await collector(t);
  const { api, turn } = await boot(t);
  await api('/api/telemetry', 'PUT', { traces: { enabled: true, endpoint: c.url, sample: 0 } });
  await turn('SENTINEL-MESSAGE-9c1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.got.length, 0);

  const draws = [0.2, 0.7];
  const sent: string[] = [];
  const tracer = new Tracer({ random: () => draws.shift()!, fetch: async (_u, init) => (sent.push(String(init?.body)), new Response('{}')) });
  const cfg = { enabled: true, endpoint: c.url, sample: 0.5 };
  const a = tracer.startTurn(cfg, { conversationId: 'conv-1' });
  const b = tracer.startTurn(cfg, { conversationId: 'conv-2' });
  assert.ok(a, '0.2 < 0.5 is sampled');
  assert.equal(b, null, '0.7 >= 0.5 is not');
  await a.end('ok', {});
  assert.equal(sent.length, 1);
  assert.equal(tracer.startTurn({ ...cfg, enabled: false }, { conversationId: 'x' }), null);
});

test('a collector that is down, slow or refusing never breaks or delays a turn, and the failure is recorded', async (t) => {
  // Down: nothing listens on the port.
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise<void>((r) => dead.close(() => r()));
  const { api, turn } = await boot(t);
  await api('/api/telemetry', 'PUT', { traces: { enabled: true, endpoint: deadUrl, sample: 1 } });
  const t0 = Date.now();
  const { sse } = await turn('SENTINEL-MESSAGE-9c1');
  assert.match(sse, /SENTINEL-REPLY-9c1/);
  assert.ok(Date.now() - t0 < 3000);
  const last = await lastExport(api);
  assert.equal(last.ok, false);
  assert.equal(last.error, 'unreachable');
  assert.equal(JSON.stringify(last).includes('SENTINEL'), false);

  // Slow: the export is abandoned at the timeout, and the turn has long finished.
  const slow = new Tracer({ timeoutMs: 50, fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError')))) });
  const tr = slow.startTurn({ enabled: true, endpoint: 'http://127.0.0.1:9', sample: 1 }, { conversationId: 'c' })!;
  await tr.end('ok', {});
  assert.equal(slow.last?.error, 'timeout');

  // Refusing: an HTTP error is reported by its code only.
  const no = new Tracer({ fetch: async () => new Response('SENTINEL-COLLECTOR-TEXT', { status: 401 }) });
  await no.startTurn({ enabled: true, endpoint: 'http://127.0.0.1:9', sample: 1 }, { conversationId: 'c' })!.end('ok', {});
  assert.deepEqual([no.last?.ok, no.last?.error], [false, 'HTTP 401']);

  // A fetch that throws synchronously is contained too.
  const boom = new Tracer({ fetch: () => { throw new Error('SENTINEL'); } });
  await boom.startTurn({ enabled: true, endpoint: 'http://127.0.0.1:9', sample: 1 }, { conversationId: 'c' })!.end('ok', {});
  assert.equal(boom.last?.ok, false);
});

test('otlpBody caps a batch and spans carry only allowed attribute types', () => {
  const spans = Array.from({ length: 400 }, (_, i) => ({ traceId: 'a'.repeat(32), spanId: i.toString(16).padStart(16, '0'), name: 'sara.tool.call', kind: 1, start: 1, end: 2, attributes: { 'sara.tool.name': 'x', 'sara.tool.output_bytes': 3, 'sara.cost_usd': 0.5, ok: true }, error: false }));
  const body = otlpBody(spans, '1.0.0');
  const out = body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(out.length, 256);
  const a = Object.fromEntries(out[0].attributes.map((x: { key: string; value: Record<string, unknown> }) => [x.key, x.value]));
  assert.deepEqual(a['sara.tool.name'], { stringValue: 'x' });
  assert.deepEqual(a['sara.tool.output_bytes'], { intValue: '3' });
  assert.deepEqual(a['sara.cost_usd'], { doubleValue: 0.5 });
  assert.deepEqual(a.ok, { boolValue: true });
  assert.equal(out[0].startTimeUnixNano, '1000000');
});

test('trace settings are checked: no collector address, credentials in the address and bad headers are refused; test trace works', async (t) => {
  const c = await collector(t);
  const { api } = await boot(t);
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { enabled: true } })).status, 400);
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { endpoint: 'ftp://example.test' } })).status, 400);
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { endpoint: 'https://user:pw@example.test' } })).status, 400);
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { sample: 2 } })).status, 400);
  assert.equal((await api('/api/telemetry/headers', 'PUT', { headers: 'no colon here' })).status, 400);
  assert.equal((await api('/api/telemetry', 'PUT', { traces: { enabled: true, endpoint: `${c.url}/v1/traces`, sample: 0.25 } })).status, 200);
  const r = await (await api('/api/telemetry/test', 'POST', {})).json();
  assert.equal(r.traces.last.ok, true);
  assert.equal(c.got.length, 1);
  assert.equal(c.got[0].path, '/v1/traces');
  assert.deepEqual(spansOf(c.got[0].body).map((s) => s.name), ['sara.test']);
});

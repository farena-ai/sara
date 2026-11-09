// EC3 (docs/ops/EC3_DESIGN.md): the owner-authenticated Prometheus endpoint, readiness, and the
// promise that no chat text, names or keys reach any label.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { SaraMetrics, TurnWatch } from '../src/telemetry/metrics.ts';
import type { Tool } from '../src/tools/types.ts';
import { UsageStore } from '../src/usage.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const SENTINELS = ['SENTINEL-MESSAGE-7f3', 'SENTINEL-REPLY-7f3', 'SENTINEL-ARG-7f3', 'SENTINEL-OUTPUT-7f3', 'SENTINEL-LABEL-7f3', 'Alex'];

const echo: Tool = {
  spec: { name: 'echo_fixture', description: 'Echo.', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  defaultPermission: 'auto',
  source: 'built-in',
  summarize: (a) => `echo ${String(a.q)}`,
  run: async () => 'SENTINEL-OUTPUT-7f3',
};

async function boot(t: { after: (fn: () => Promise<void> | void) => void }, extra: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date() };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.tools.add(echo);
  app.settings.update({
    providers: [{ id: 'openai', label: 'SENTINEL-LABEL-7f3', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }],
    defaultProviderId: 'openai',
    defaultModel: 'gpt-fixture',
    ownerName: 'Alex',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = auth.newToken!;
  const api = (path: string, method = 'GET', body?: unknown, bearer = owner) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${bearer}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { app, auth, base, owner, api };
}

test('metrics are off by default; on, a wrong token is 401, the right token or an allowlisted address is 200', async (t) => {
  const { base, api, app, owner } = await boot(t);
  assert.equal((await fetch(base + '/metrics')).status, 404);
  const view = await (await api('/api/telemetry')).json();
  assert.equal(view.metrics.enabled, false);
  assert.equal(view.metrics.hasToken, false);
  assert.equal(view.traces.enabled, false);

  assert.equal((await api('/api/telemetry', 'PUT', { metrics: { enabled: true } })).status, 200);
  const made = await (await api('/api/telemetry/token', 'POST', {})).json();
  assert.match(made.token, /^[A-Za-z0-9_-]{32,}$/);
  // Shown once: the view only says a token exists.
  const after = await (await api('/api/telemetry')).json();
  assert.equal(after.metrics.hasToken, true);
  assert.ok(!JSON.stringify(after).includes(made.token));
  assert.ok(app.vault.has('telemetry.metrics-token'));

  const none = await fetch(base + '/metrics');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await fetch(base + '/metrics', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  // The owner's session token is not a scrape token.
  assert.equal((await fetch(base + '/metrics', { headers: { authorization: `Bearer ${owner}` } })).status, 401);
  const ok = await fetch(base + '/metrics', { headers: { authorization: `Bearer ${made.token}` } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(await ok.text(), /^sara_build_info\{version="[^"]+",revision="[^"]*",node="v\d+[^"]*"\} 1$/m);

  // Allowlist: this test's address may scrape without a token; a bad entry is refused.
  assert.equal((await api('/api/telemetry', 'PUT', { metrics: { allow: ['not an address'] } })).status, 400);
  assert.equal((await api('/api/telemetry', 'PUT', { metrics: { allow: ['127.0.0.0/8'] } })).status, 200);
  assert.equal((await fetch(base + '/metrics')).status, 200);
  assert.equal((await api('/api/telemetry', 'PUT', { metrics: { allow: ['10.0.0.1'] } })).status, 200);
  assert.equal((await fetch(base + '/metrics')).status, 401);

  // Removing the token leaves only the allowlist; turning metrics off makes it absent again.
  assert.equal((await api('/api/telemetry/token', 'DELETE')).status, 200);
  assert.equal(app.vault.has('telemetry.metrics-token'), false);
  assert.equal((await fetch(base + '/metrics', { headers: { authorization: `Bearer ${made.token}` } })).status, 401);
  assert.equal((await api('/api/telemetry', 'PUT', { metrics: { enabled: false } })).status, 200);
  assert.equal((await fetch(base + '/metrics')).status, 404);
});

test('the monitoring settings are owner only: no device tokens, no signed-out access', async (t) => {
  const { base, api, auth } = await boot(t);
  assert.equal((await fetch(base + '/api/telemetry')).status, 401);
  const device = auth.createDeviceToken('synthetic device');
  assert.equal((await api('/api/telemetry', 'GET', undefined, device.token)).status, 403);
  assert.equal((await api('/api/telemetry/token', 'POST', {}, device.token)).status, 403);
});

test('a member space and the demo never expose /metrics, even when switched on in settings', async (t) => {
  for (const role of ['demo', 'member'] as const) {
    const { dir, cleanup } = tempDir();
    const app = makeApp(dir, { now: new Date() });
    app.settings.update({ telemetry: { metrics: { enabled: true, allow: ['127.0.0.1'] } } } as never);
    const member = { record: () => ({ id: 'synthetic-member', name: 'Example', createdAt: new Date().toISOString(), status: 'active' as const, ownerConfirmed18At: 'fixture', memberConfirmed18At: 'fixture', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }), apps: () => [app], deleteSelf: async () => {} };
    const server = createSaraServer({ app, auth: new OwnerAuth(dir), webDir: join(ROOT, 'web'), ...(role === 'demo' ? { demo: true } : { member }) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`)).status, 404, role);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      app.store.close();
      cleanup();
    }
  }
  t.diagnostic('demo and member checked');
});

test('readiness is public and minimal: 200 when the database and storage are ready, 503 otherwise', async (t) => {
  const { base, app } = await boot(t);
  const r = await fetch(base + '/api/health/ready');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const db = app.store.db as unknown as { prepare: unknown };
  db.prepare = () => {
    throw new Error('database is not open');
  };
  try {
    const bad = await fetch(base + '/api/health/ready');
    assert.equal(bad.status, 503);
    assert.deepEqual(await bad.json(), { ok: false, failing: ['database'] });
  } finally {
    delete (db as { prepare?: unknown }).prepare;
  }
});

test('a real turn feeds turns, model calls, tokens, latency and tools, and no chat text or name reaches the output', async (t) => {
  const { base, api, app } = await boot(t);
  app.script.push(
    [call('c1', 'echo_fixture', { q: 'SENTINEL-ARG-7f3' }), { type: 'usage', input: 120, output: 30 }],
    [...text('SENTINEL-REPLY-7f3'), { type: 'usage', input: 200, output: 12, cached: 100 }],
  );
  await api('/api/telemetry', 'PUT', { metrics: { enabled: true, allow: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] } });
  const conv = app.store.createConversation({ title: 'Meter' });
  const sse = await (await api(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'SENTINEL-MESSAGE-7f3' })).text();
  assert.match(sse, /SENTINEL-REPLY-7f3/);
  const out = await (await fetch(base + '/metrics')).text();

  assert.match(out, /^sara_turns_total\{outcome="ok"\} 1$/m);
  assert.match(out, /^sara_turn_duration_seconds_count\{outcome="ok"\} 1$/m);
  assert.match(out, /^sara_turn_first_token_seconds_count 1$/m);
  assert.match(out, /^sara_model_calls_total\{provider="openai",model="gpt-fixture",outcome="ok"\} 2$/m);
  assert.match(out, /^sara_model_call_duration_seconds_count\{provider="openai",model="gpt-fixture"\} 2$/m);
  assert.match(out, /^sara_model_tokens_total\{provider="openai",model="gpt-fixture",kind="input"\} 320$/m);
  assert.match(out, /^sara_model_tokens_total\{provider="openai",model="gpt-fixture",kind="output"\} 42$/m);
  assert.match(out, /^sara_model_tokens_total\{provider="openai",model="gpt-fixture",kind="cached"\} 100$/m);
  assert.match(out, /^# TYPE sara_model_cost_usd_total counter$/m);
  assert.match(out, /^sara_tool_calls_total\{tool="echo_fixture",outcome="ok"\} 1$/m);
  assert.match(out, /^sara_uptime_seconds \d+/m);
  assert.match(out, /^sara_database_bytes \d+/m);
  assert.match(out, /^sara_queue_items\{queue="pending",state="waiting"\} 0$/m);
  assert.match(out, /^sara_http_requests_total \d+/m);
  assert.match(out, /^sara_process_resident_memory_bytes \d+/m);
  assert.match(out, /^# TYPE sara_backup_age_seconds gauge$/m);
  assert.match(out, /^# TYPE sara_plugin_jobs_running gauge$/m);

  for (const s of [...SENTINELS, conv.id, ...app.vault.values()]) assert.ok(!out.includes(s), `leaked ${s}`);
  // Every sample line is name{safe labels} number.
  for (const line of out.split('\n').filter((l) => l && !l.startsWith('#'))) assert.match(line, /^sara_[a-z_]+(\{([a-z_]+="[A-Za-z0-9_.:/+-]*",?)+\})? [-+\d.e]+$|^sara_[a-z_]+(\{.*\})? (\+Inf|NaN)$/, line);
});

test('TurnWatch counts approvals asked and resolved, tool outcomes and errors from the turn events', () => {
  const m = new SaraMetrics();
  const w = new TurnWatch(m, { mcpServerOf: (name) => (name.startsWith('mcp_files_') ? 'files' : undefined) });
  w.event({ type: 'approval', approvalId: 'a1', id: 't1', name: 'write_file', summary: 'SENTINEL', args: { p: 'SENTINEL' } });
  w.event({ type: 'tool_result', id: 't1', name: 'write_file', status: 'ok', output: 'SENTINEL', ms: 5 });
  w.event({ type: 'approval', approvalId: 'a2', id: 't2', name: 'write_file', summary: 'SENTINEL', args: {} });
  w.event({ type: 'tool_result', id: 't2', name: 'write_file', status: 'denied', output: 'no', ms: 1 });
  w.event({ type: 'tool_result', id: 't3', name: 'mcp_files_read', status: 'error', output: 'SENTINEL', ms: 3 });
  w.event({ type: 'error', message: 'SENTINEL failure' } as never);
  w.end('error');
  const out = m.render();
  assert.match(out, /^sara_approvals_requested_total 2$/m);
  assert.match(out, /^sara_approvals_resolved_total\{outcome="approved"\} 1$/m);
  assert.match(out, /^sara_approvals_resolved_total\{outcome="denied"\} 1$/m);
  assert.match(out, /^sara_tool_calls_total\{tool="write_file",outcome="denied"\} 1$/m);
  assert.match(out, /^sara_tool_calls_total\{tool="mcp:files",outcome="error"\} 1$/m);
  assert.match(out, /^sara_errors_total\{source="turn"\} 1$/m);
  assert.match(out, /^sara_turns_total\{outcome="error"\} 1$/m);
  assert.ok(!out.includes('SENTINEL'));
  // A second end() is ignored (the turn is counted once).
  w.end('ok');
  assert.match(m.render(), /^sara_turns_total\{outcome="error"\} 1$/m);
});

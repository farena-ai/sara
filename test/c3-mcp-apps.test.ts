// C3 (MCP Apps): a tool result's app reaches the chat as a card; its page is served sandboxed;
// calls the app asks for go through Sara's normal approval path (Off / Ask / Runs on its own).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { createSaraServer } from '../src/server.ts';
import { McpManager, type McpAppCard } from '../src/tools/mcp.ts';
import { call as toolCall, makeApp, ROOT, tempDir, text } from './helpers.ts';

const APP_SERVER = join(ROOT, 'test', 'fixtures', 'mcp-app-server.mjs');
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-08T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const mgr = new McpManager(app.tools, { dataDir: dir, sandbox: app.sandbox, secrets: () => ({ env: { MCP_ERA: 'modern' } }) });
app.mcp = mgr;
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
const conv = app.store.createConversation();
let card: McpAppCard;

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  assert.equal(c.status, 'ready', c.error);
});
after(async () => {
  mgr.stopAll();
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  app.store.close();
  cleanup();
});

const api = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
  fetch(`${base}/api${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? owner}` }), origin: base, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

test('C3 chat: the tool result carries the app card (kept with the tool message)', async () => {
  app.script.push([toolCall('c1', 'mcp_counter_show_counter', {})], text('Here is the counter.'));
  const events: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'show me the counter')) events.push(ev);
  const res = events.find((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.equal(res.status, 'ok', res.output);
  assert.equal(res.card?.kind, 'mcp-app');
  card = res.card as McpAppCard;
  assert.equal(card.server, 'counter');
  const msg = app.store.messages(conv.id).find((m) => m.role === 'tool')!;
  assert.equal((msg.meta?.card as McpAppCard).id, card.id);
});

test('C3 frame: the page is served sandboxed (opaque origin, strict CSP); owner only; closed apps say so', async () => {
  const r = await api(`/mcp-apps/${card.id}/frame`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy')!;
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(await r.text(), /<title>Counter<\/title>/);
  assert.equal((await api(`/mcp-apps/${card.id}/frame`, { token: null })).status, 401);
  const gone = await api('/mcp-apps/00000000-0000-0000-0000-000000000000/frame');
  assert.match(gone.headers.get('content-security-policy')!, /^sandbox allow-scripts;/);
  assert.match(await gone.text(), /no longer open/);
  const info = (await (await api(`/mcp-apps/${card.id}`)).json()) as { tool: string; result: { structuredContent: { count: number } } };
  assert.equal(info.tool, 'show_counter');
  assert.deepEqual(info.result.structuredContent, { count: 0 });
});

const approvalsOf = async () => ((await (await api(`/conversations/${conv.id}`)).json()) as { activity?: { approvals: { approvalId: string; name: string; summary: string }[] } }).activity?.approvals ?? [];
const waitFor = async <T>(f: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

test('C3 bridge: an app call to a tool that asks waits for the owner; Deny runs nothing, Allow runs it', async () => {
  // Deny first: nothing changes.
  const denied = api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'bump', arguments: { by: 5 } } });
  const ap = await waitFor(async () => (await approvalsOf())[0]);
  assert.equal(ap.name, 'mcp_counter_bump');
  assert.match(ap.summary, /counter app: bump/);
  await api(`/approvals/${ap.approvalId}`, { method: 'POST', body: { approved: false } });
  const d = await denied;
  assert.equal(d.status, 403);
  const peek = await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'peek' } });
  assert.equal(peek.status, 200, 'a read-only app tool runs on its own');
  assert.deepEqual(((await peek.json()) as { result: { structuredContent: unknown } }).result.structuredContent, { count: 0 }, 'the denied bump changed nothing');
  // Allow: it runs and the app gets the result.
  const allowed = api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'bump', arguments: { by: 2 } } });
  const ap2 = await waitFor(async () => (await approvalsOf())[0]);
  await api(`/approvals/${ap2.approvalId}`, { method: 'POST', body: { approved: true } });
  const a = await allowed;
  assert.equal(a.status, 200);
  assert.deepEqual(((await a.json()) as { result: { structuredContent: unknown } }).result.structuredContent, { count: 2 });
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && /counter app: bump/.test(m.content)), 'what happened is posted in the conversation');
});

test('C3 bridge: Off refuses; model-only and unknown tools are refused; apps off closes the bridge', async () => {
  app.settings.update({ toolPermissions: { mcp_counter_peek: 'never' } });
  assert.equal((await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'peek' } })).status, 403);
  app.settings.update({ toolPermissions: {} });
  const model = await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'whoami' } });
  assert.equal(model.status, 403);
  assert.match(((await model.json()) as { error: string }).error, /not open to apps/);
  assert.equal((await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'nope' } })).status, 403);
  assert.equal((await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'peek' }, token: null })).status, 401);
  assert.equal((await approvalsOf()).length, 0, 'none of these asked');
  await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER], apps: false });
  assert.equal((await api(`/mcp-apps/${card.id}/call`, { method: 'POST', body: { name: 'peek' } })).status, 404, 'restarting the server closes its apps');
});

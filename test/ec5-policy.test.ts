// EC5: policy profiles (admin-pinned settings), enforced on the server: the tool resolver, the
// routes (the owner too: a pin changes only by changing the policy), provider resolution, the
// Store; every change audited; drift in the safety check-up; installs without a policy unchanged.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { resolveProvider, runTurn, type ChatEvent } from '../src/chat.ts';
import { policy, PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { storeSettings } from '../src/routes/store.ts';
import { runSafetyCheck } from '../src/safety-check.ts';
import { createSaraServer } from '../src/server.ts';
import { policyResolver } from '../src/tool-policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev }));
const store = new PolicyStore(dir);
setPolicy(store);
let base = '';
const ask = (name: string, extra: Partial<Tool> = {}): Tool => ({ defaultPermission: 'ask', source: 'test', spec: { name, description: name, parameters: { type: 'object' } }, summarize: () => name, run: async () => 'done', ...extra });
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }, { id: 'c', label: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude' }], defaultProviderId: 'p', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  app.tools.add(ask('send_note'));
  app.tools.add(ask('run_cmd', { runsCommands: true }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
const settle = () => new Promise((r) => setTimeout(r, 30));

test('EC5: without a policy nothing changes (a personal install is unaffected)', async () => {
  assert.equal(store.get().rev, 0);
  assert.equal((await req('/api/tools', { method: 'PUT', body: { permissions: { send_note: 'auto' }, shellNetwork: true } })).status, 200);
  assert.equal(app.tools.permission('send_note', app.settings.get().toolPermissions), 'auto');
  assert.equal(storeSettings({}).on, true);
  assert.equal(resolveProvider(app, 'c', null).model, 'claude');
  assert.deepEqual((await (await req('/api/policy')).json()).pinned, []);
});

test('EC5: policies are checked exactly: unknown keys and loosening values are refused', async () => {
  assert.throws(() => validatePolicy({ pins: { adultMode: true } }), /only be pinned off/);
  assert.throws(() => validatePolicy({ pins: { privateLocal: false } }), /only be pinned on/);
  assert.throws(() => validatePolicy({ pins: { tools: { shell: 'auto' } } }), /ask or never/);
  assert.throws(() => validatePolicy({ pins: { sudo: true } }), /Unknown policy field/);
  assert.throws(() => validatePolicy({ pins: { providers: ['nope'] } }), /provider kind/);
  assert.equal((await req('/api/policy', { method: 'PUT', body: { pins: { store: 'any' } } })).status, 400);
});

test('EC5: saving a policy bumps its revision, conforms settings and writes exactly one audit row', async () => {
  app.settings.update({ adultMode: { on: true, confirmedAt: clock.now.toISOString() } });
  store.onApply = () => app.settings.update({ adultMode: { on: false } });
  const n = auditTrail()!.list().length;
  const res = await req('/api/policy', { method: 'PUT', body: { name: 'Family rules', pins: { providers: ['openai-compatible'], tools: { send_note: 'ask', 'group:commands': 'never' }, alwaysAllow: false, adultMode: false, shellNetwork: false, store: 'off', auditRetentionDays: 365 } } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).policy.rev, 1);
  await settle();
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].target, rows[0].policyRev], ['policy.change', 'rev1', 1]);
  assert.deepEqual(rows[0].keys, ['providers', 'tools', 'alwaysAllow', 'adultMode', 'shellNetwork', 'store', 'auditRetentionDays']);
  assert.equal(app.settings.get().adultMode?.on, false);
  const view = await (await req('/api/policy')).json();
  assert.equal(view.canEdit, true);
  assert.ok(view.pinned.includes('tools'));
});

test('EC5: the tool ceiling beats Always allow, the E7 server choice and the owner\'s own setting', () => {
  const s = app.settings.get();
  assert.equal(s.toolPermissions?.send_note, 'auto', 'the old Always allow is still saved...');
  assert.equal(app.tools.permission('send_note', s.toolPermissions), 'ask', '...but the ceiling wins');
  assert.equal(app.tools.permission('run_cmd', { run_cmd: 'auto' }), 'never', 'a group ceiling (commands)');
  assert.ok(!app.tools.enabled(s.toolPermissions).some((t) => t.spec.name === 'run_cmd'), 'a tool pinned never is not even shown to the model');
  // An MCP server set to "everything" (E7) is held to group:mcp too.
  const reg = new ToolRegistry([ask('mcp_srv_make')]);
  reg.policyFor = policyResolver(() => ({ mcpPolicy: { srv: 'all' } }), { get: () => ({ tools: [{ name: 'make' }] }) });
  assert.equal(reg.permission('mcp_srv_make', undefined), 'auto', 'no MCP ceiling in this policy');
  const other = tempDir();
  try {
    const strict = new PolicyStore(other.dir);
    strict.set({ pins: { tools: { 'group:mcp': 'ask' } } });
    setPolicy(strict);
    assert.equal(reg.permission('mcp_srv_make', undefined), 'ask');
    assert.equal(reg.permission('mcp_srv_make', { mcp_srv_make: 'auto' }), 'ask');
  } finally {
    setPolicy(store);
    other.cleanup();
  }
});

test('EC5: pinned values are refused at the route level, for the owner too, naming the policy', async () => {
  const refused = async (path: string, method: string, body: unknown) => {
    const r = await req(path, { method, body });
    const j = await r.json();
    assert.equal(r.status, 409, `${path} ${JSON.stringify(j)}`);
    assert.match(j.error, /Set by your admin \(Family rules\)/);
    return j.policy.key as string;
  };
  assert.equal(await refused('/api/tools', 'PUT', { permissions: { send_note: 'auto' } }), 'tools');
  assert.equal(await refused('/api/tools', 'PUT', { shellNetwork: true }), 'shellNetwork');
  assert.equal(await refused('/api/adult', 'PUT', { on: true, confirm18: true }), 'adultMode');
  assert.equal(await refused('/api/providers/c2', 'PUT', { label: 'C2', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'providers');
  assert.equal(await refused('/api/settings', 'PUT', { defaultProviderId: 'c' }), 'providers');
  assert.equal(await refused('/api/audit/settings', 'PUT', { retentionDays: 30 }), 'auditRetentionDays');
  // Tightening stays allowed.
  assert.equal((await req('/api/tools', { method: 'PUT', body: { permissions: { send_note: 'never' } } })).status, 200);
  assert.equal(storeSettings({ store: { on: true, community: true } }).on, false, 'the Store reads through the pin');
  assert.throws(() => resolveProvider(app, 'c', null), /Set by your admin/);
  assert.equal(resolveProvider(app, 'p', null).model, 'm');
});

test('EC5: with Always allow pinned off the card never offers it and an answer saying so saves nothing', async () => {
  app.settings.update({ toolPermissions: {} });
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'send_note', {})], text('Done.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'send it')) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true, 'tool');
  }
  const card = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.ok(card && !card.alwaysOk);
  assert.equal(app.settings.get().toolPermissions?.send_note, undefined);
});

test('EC5: export and import round-trip (audited as an import); the check-up reports drift', async () => {
  const file = await (await req('/api/policy/export')).json();
  assert.equal(file.kind, 'sara-policy');
  assert.equal(file.name, 'Family rules');
  const n = auditTrail()!.list().length;
  const imp = await req('/api/policy/import', { method: 'POST', body: { ...file, name: 'Imported', pins: { ...file.pins, store: 'official' } } });
  assert.equal(imp.status, 200);
  assert.equal(policy().get().rev, 2);
  assert.equal(policy().pins.store, 'official');
  await settle();
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n);
  assert.deepEqual(rows.map((r) => [r.action, r.keys]), [['policy.import', ['store']]]);
  // Drift: an Always-allowed tool above its ceiling, a provider kind no longer allowed.
  app.settings.update({ toolPermissions: { send_note: 'auto' } });
  const report = await runSafetyCheck({ app, dataDir: dir, platform: 'linux', env: {} } as never, 'page', { log: false });
  const c = report.checks.find((x) => x.id === 'policy');
  assert.equal(c?.status, 'amber');
  assert.match(c!.line, /providers \(c\).*tools \(send_note\)/);
  // A policy file survives a restart; a damaged one keeps the strict reading.
  assert.equal(new PolicyStore(dir).get().name, 'Imported');
});

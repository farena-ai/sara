// EC4 wiring: each listed action writes exactly one audit row, with names (never values), and the
// trail is the owner's only (members and apps with a device code are refused).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { memberRouteCheck, type MemberRecord } from '../src/household.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k' }));
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown; bearer?: string } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${o.bearer ?? token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
const rows = () => auditTrail()!.list({}, { content: true });
/** The 'finish' hook runs right after the answer; give it a tick. */
const settle = () => new Promise((r) => setTimeout(r, 30));

test('EC4: a settings change and a tool permission change write one row each: field names, never values', async () => {
  const n = rows().length;
  assert.equal((await req('/api/settings', { method: 'PUT', body: { ownerName: 'Secret Name Here' } })).status, 200);
  assert.equal((await req('/api/tools', { method: 'PUT', body: { permissions: { web_fetch: 'never' } } })).status, 200);
  await settle();
  const got = rows().slice(0, rows().length - n).reverse();
  assert.deepEqual(got.map((r) => [r.action, r.outcome, r.role, r.channel]), [['settings.change', 'ok', 'owner', 'web'], ['tools.change', 'ok', 'owner', 'web']]);
  assert.deepEqual(got[0].keys, ['ownerName']);
  assert.deepEqual(got[1].keys, ['permissions', 'permissions.web_fetch']);
  assert.doesNotMatch(JSON.stringify(rows()), /Secret Name Here/);
  // Reads write nothing.
  await req('/api/settings');
  await settle();
  assert.equal(rows().length, n + 2);
});

test('EC4: a refused sign-in is one row (refused); the trail reads, checks and exports for the owner', async () => {
  const n = rows().length;
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: 'wrong-token-value' }) });
  assert.equal(bad.status, 401);
  await settle();
  assert.equal(rows().length, n + 1);
  assert.deepEqual([rows()[0].action, rows()[0].outcome], ['login.do', 'refused']);
  assert.doesNotMatch(JSON.stringify(rows()), /wrong-token-value/);
  const view = await (await req('/api/audit?action=login')).json();
  assert.equal(view.rows.length, 1);
  assert.equal(view.verify.ok, true);
  assert.equal(view.retentionDays, 365);
  const zip = await req('/api/audit/export?format=csv');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(Buffer.from(await zip.arrayBuffer()).toString('latin1'), /manifest\.json/);
  await settle();
  assert.equal(rows()[0].action, 'audit.export', 'the export itself is on the record');
  assert.equal((await req('/api/audit/settings', { method: 'PUT', body: { retentionDays: 7 } })).status, 400);
  assert.equal((await (await req('/api/audit/settings', { method: 'PUT', body: { retentionDays: 90 } })).json()).retentionDays, 90);
});

test('EC4: apps with a device code and household members cannot read the trail', async () => {
  const dev = auth.createDeviceToken('Terminal');
  assert.equal((await req('/api/audit', { bearer: dev.token })).status, 403);
  assert.equal((await req('/api/policy', { bearer: dev.token })).status, 403);
  const rec = { id: 'm1', name: 'Kim', status: 'active', limits: { voice: true, pictures: true, models: [] } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(rec, 'GET', ['audit'])?.status, 403);
  assert.equal(memberRouteCheck(rec, 'GET', ['policy']), undefined, 'members may see what is pinned');
  assert.equal(memberRouteCheck(rec, 'PUT', ['policy'])?.status, 403);
});

test('EC4: a decided approval card is one row with the tool and the answer; its summary only as redacted content', async () => {
  const tool: Tool = { defaultPermission: 'ask', source: 'test', spec: { name: 'send_note', description: 'sends', parameters: { type: 'object' } }, summarize: () => 'send the note', run: async () => 'sent' };
  app.tools.add(tool);
  const n = rows().length;
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'send_note', {})], text('Done.'));
  for await (const ev of runTurn(app, conv.id, 'send it')) if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
  const got = rows().slice(0, rows().length - n);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].action, got[0].target, got[0].outcome], ['approval.decided', 'send_note', 'refused']);
  assert.equal(got[0].content, 'send the note');
  assert.equal(auditTrail()!.list({ action: 'approval' })[0].content, undefined, 'hidden unless asked for');
});

test('EC4: a background run closes with one row; chat turns add none', () => {
  const runs = new RunStore(app.store.db);
  const n = rows().length;
  const id = runs.open({ kind: 'job', title: 'deploy' });
  runs.close(id, 'error', 0, Date.now());
  const t = runs.open({ kind: 'turn' });
  runs.close(t, 'ok', 0, Date.now());
  const got = rows().slice(0, rows().length - n);
  assert.deepEqual(got.map((r) => [r.action, r.target, r.outcome]), [['run.job', `run${id}`, 'failed']]);
});

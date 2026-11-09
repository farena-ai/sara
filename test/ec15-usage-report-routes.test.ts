// EC15: the report routes: the owner sees everyone, a household member only their own; CSV; budgets.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { hub } from '../src/telemetry/hub.ts';
import { budgetAlerter, UsageBudgets } from '../src/usage-report.ts';
import { UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const API: ProviderConfig = { id: 'p', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-luna' };
const { dir, cleanup } = tempDir();
for (const d of ['owner', 'm1']) mkdirSync(join(dir, d), { recursive: true });
const clock = { now: new Date('2026-11-05T12:00:00Z') };
const app = makeApp(join(dir, 'owner'), clock);
const mApp = makeApp(join(dir, 'm1'), clock);
app.usage = new UsageStore(app.store.db, () => clock.now);
mApp.usage = new UsageStore(mApp.store.db, () => clock.now);
const auth = new OwnerAuth(join(dir, 'owner'), () => clock.now);
const mAuth = new OwnerAuth(join(dir, 'm1'), () => clock.now);
const token = auth.newToken!;
const mToken = mAuth.newToken!;
const budgets = new UsageBudgets(join(dir, 'owner'), () => clock.now);
const sources = () => [
  { person: 'owner', personName: 'You', db: app.store.db },
  { person: 'm1', personName: 'Sam', db: mApp.store.db },
];
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), usageSources: sources, usageBudgets: budgets });
const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Sam', status: 'active', createdAt: '', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } }) as never, apps: () => [mApp], deleteSelf: async () => {} } });
setAuditTrail(new AuditTrail(join(dir, 'owner'), { key: () => 'k', policyRev: () => 0 }));
let base = '';
let mbase = '';
before(async () => {
  for (const a of [app, mApp]) a.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  const c = app.store.createConversation({ title: 'a', workspace: 'site' });
  app.usage!.record(API, 'gpt-6-luna', { input: 1_000_000, output: 0 }, { purpose: 'chat', conversationId: c.id });
  mApp.usage!.record(API, 'gpt-6-luna', { input: 3_000_000, output: 0 }, { purpose: 'chat' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => msrv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mbase = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  msrv.close();
  app.store.close();
  mApp.store.close();
  cleanup();
});
const get = (b: string, tok: string, path: string, o: { method?: string; body?: unknown } = {}) =>
  fetch(b + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${tok}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });

test('EC15 routes: the owner sees every person; a member sees only their own rows', async () => {
  const own = await (await get(base, token, '/api/usage/report?period=month&by=person')).json();
  assert.deepEqual(own.rows.map((r: { person: string }) => r.person).sort(), ['Sam', 'You']);
  assert.equal(own.totals.tokens, 4_000_000);
  assert.equal(own.canSeeOthers, true);
  const mine = await (await get(mbase, mToken, '/api/usage/report?period=month&by=person')).json();
  assert.deepEqual(mine.rows.map((r: { person: string }) => r.person), ['Sam']);
  assert.equal(mine.totals.tokens, 3_000_000);
  assert.equal(mine.canSeeOthers, false);
  assert.equal((await get(mbase, mToken, '/api/usage/budgets')).status, 403);
  assert.equal((await get(mbase, mToken, '/api/usage/budgets', { method: 'PUT', body: { budgets: [] } })).status, 403);
  assert.equal((await get(base, token, '/api/usage/report?period=year')).status, 400);
});

test('EC15 routes: CSV export with the same filters', async () => {
  const r = await get(base, token, '/api/usage/report.csv?period=day&by=person,workspace');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(r.headers.get('content-disposition') ?? '', /sara-usage-.*\.csv/);
  const lines = (await r.text()).trim().split('\r\n');
  assert.equal(lines[0], 'period,person,workspace,calls,input_tokens,output_tokens,cached_tokens,tokens,usd,unpriced_calls');
  assert.ok(lines.includes('2026-11-05,You,site,1,1000000,0,0,1000000,0.1,0'));
  assert.ok(lines.includes('2026-11-05,Sam,,1,3000000,0,0,3000000,0.3,0'));
});

test('EC15 routes: budgets are saved (audited) and alert once through the telemetry hub', async () => {
  const n = auditTrail()!.list().length;
  const put = await get(base, token, '/api/usage/budgets', { method: 'PUT', body: { budgets: [{ scope: 'person', key: 'm1', usd: 0.35 }] } });
  assert.equal(put.status, 200);
  const view = await (await get(base, token, '/api/usage/budgets')).json();
  assert.equal(view.status[0].level, 'near');
  assert.deepEqual(view.people.map((p: { id: string }) => p.id), ['owner', 'm1']);
  assert.ok(view.workspaces.includes('site'));
  const told: string[] = [];
  const alerter = budgetAlerter({ budgets, sources, tz: () => 'UTC', lang: () => 'en', debounceMs: 0, notify: (title, line) => void told.push(`${title}|${line}`) });
  try {
    hub.modelCall({ model: 'm', provider: 'P', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, billing: 'api', reported: true, ms: 1, ok: true, startedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 30));
    alerter.check();
  } finally {
    alerter.stop();
  }
  assert.equal(told.length, 1);
  assert.match(told[0], /Sam/);
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n).reverse();
  assert.deepEqual(rows.map((r) => r.action), ['usage.budgets', 'usage.budget.alert']);
  assert.equal(rows[1].target, 'budget:person:m1 near');
});

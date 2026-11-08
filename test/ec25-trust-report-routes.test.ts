// EC25: the trust report routes: owner only (members and the demo get 403), JSON for the page,
// Markdown / PDF / Word downloads, and one audit row per export.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
for (const d of ['owner', 'm1']) mkdirSync(join(dir, d), { recursive: true });
const clock = { now: new Date('2026-11-05T12:00:00Z') };
const app = makeApp(join(dir, 'owner'), clock);
const mApp = makeApp(join(dir, 'm1'), clock);
app.runs = new RunStore(app.store.db, () => clock.now);
mApp.runs = new RunStore(mApp.store.db, () => clock.now);
const auth = new OwnerAuth(join(dir, 'owner'), () => clock.now);
const mAuth = new OwnerAuth(join(dir, 'm1'), () => clock.now);
const token = auth.newToken!;
const mToken = mAuth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Sam', status: 'active', createdAt: '', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } }) as never, apps: () => [mApp], deleteSelf: async () => {} } });
setAuditTrail(new AuditTrail(join(dir, 'owner'), { key: () => 'k', policyRev: () => 0 }));
let base = '';
let mbase = '';
let runId = 0;
before(async () => {
  for (const a of [app, mApp]) a.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  const c = app.store.createConversation({ title: 'a' });
  const reply = app.store.addMessage(c.id, 'assistant', 'I ran the tests.', { unverified: [{ kind: 'run', sentence: 'I ran the tests', problem: 'missing' }] });
  runId = app.runs!.open({ kind: 'turn', conversationId: c.id, title: 'Tests' });
  app.runs!.writeStep(runId, 0, {}, clock.now.toISOString(), null, { calls: [], tools: [{ id: '1', name: 'shell', summary: 'npm test', args: {}, status: 'error', output: 'exit 1', outputChars: 6, ms: 3, approval: 'auto' }], files: [], contradictions: [], replyMessageId: reply.id });
  app.runs!.close(runId, 'ok', 0, Date.now(), { replyMessageId: reply.id });
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
const get = (b: string, tok: string, path: string) => fetch(b + path, { headers: { authorization: `Bearer ${tok}` } });

test('EC25 routes: the week and one run as JSON for the owner', async () => {
  const wk = await get(base, token, '/api/trust/report?scope=week&from=2026-11-01');
  assert.equal(wk.status, 200);
  const w = await wk.json();
  assert.equal(w.summary.runs, 1);
  assert.equal(w.claims[0].problem, 'missing');
  assert.equal(w.failed[0].name, 'shell');
  const one = await (await get(base, token, `/api/trust/report?scope=run&id=${runId}`)).json();
  assert.equal(one.runs[0].id, runId);
  const last7 = await (await get(base, token, '/api/trust/report')).json();
  assert.equal(last7.scope.kind, 'week', 'default: the last seven days');
  assert.equal(last7.summary.runs, 1);
  const projects = await (await get(base, token, '/api/trust/projects')).json();
  assert.ok(Array.isArray(projects.projects));
  assert.equal((await get(base, token, '/api/trust/report?scope=run&id=999')).status, 404);
  assert.equal((await get(base, token, '/api/trust/report?scope=week&from=nope')).status, 400);
  assert.equal((await get(base, token, '/api/trust/report?scope=planet')).status, 400);
});

test('EC25 routes: downloads as Markdown, PDF and Word, each with one audit row', async () => {
  const before = auditTrail()!.list({ action: 'trust' }).length;
  const md = await get(base, token, `/api/trust/report.md?scope=run&id=${runId}`);
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-disposition') ?? '', /attachment; filename="sara-trust-run-\d+\.md"/);
  assert.match(await md.text(), /# Trust report: Run/);
  const pdf = Buffer.from(await (await get(base, token, '/api/trust/report.pdf?scope=week&from=2026-11-01')).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const docx = Buffer.from(await (await get(base, token, '/api/trust/report.docx?scope=week&from=2026-11-01')).arrayBuffer());
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  const rows = auditTrail()!.list({ action: 'trust' });
  assert.equal(rows.length - before, 3);
  assert.deepEqual(rows.map((r) => r.target).sort(), ['docx', 'md', 'pdf']);
  assert.equal(rows[0]!.action, 'trust.export');
});

test('EC25 routes: a household member is refused (owner only)', async () => {
  for (const p of ['/api/trust/report', '/api/trust/report.md', '/api/trust/projects']) {
    const r = await get(mbase, mToken, p);
    assert.equal(r.status, 403, p);
    assert.equal((await r.json()).ownerOnly, true);
  }
});

// N1 (docs/QUALITY.md): "How she did" counts from a seeded database, the owner-only route, the
// weekly review card, and Auto's settings (the API, new installs get Auto, existing ones don't).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { newInstallAuto } from '../src/auto-route.ts';
import { qualityReport, qualityTips } from '../src/quality.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { memberRouteCheck } from '../src/household.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-14T15:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

const iso = (minAgo: number) => new Date(clock.now.getTime() - minAgo * 60_000).toISOString();
let convA = '';
let convB = '';

before(async () => {
  new RunStore(app.store.db, () => clock.now);
  const db = app.store.db;
  convA = app.store.createConversation({ title: 'Time sheet' }).id;
  convB = app.store.createConversation({ title: 'Groceries' }).id;
  const run = (conv: string, status: string, startMin: number, secs: number, tools?: unknown[]) => {
    const r = db.prepare("INSERT INTO runs (kind, conversation_id, title, started_at, ended_at, status) VALUES ('turn', ?, 't', ?, ?, ?)").run(conv, iso(startMin), new Date(Date.parse(iso(startMin)) + secs * 1000).toISOString(), status);
    if (tools) db.prepare('INSERT INTO run_steps (run_id, idx, at, tool_calls) VALUES (?, 0, ?, ?)').run(r.lastInsertRowid, iso(startMin), JSON.stringify(tools));
  };
  run(convA, 'ok', 100, 5);
  run(convA, 'ok', 90, 75); // slow
  run(convA, 'error', 80, 50);
  run(convB, 'error', 70, 3);
  run(convB, 'ok', 60, 4, [
    { name: 'pc_click', status: 'denied', approval: 'refused', output: 'refused' },
    { name: 'pc_click', status: 'error', approval: 'auto', output: 'that control is not there now, so use pc_look and pick it again.' },
    { name: 'fill_document', status: 'ok', output: 'Filled 3 of 5.\nCould not verify: not every field is filled.' },
    { name: 'read_file', status: 'ok', output: 'x' },
  ]);
  run(convB, 'ok', 60 * 24 * 9, 200); // older than the week: not counted
  app.store.addMessage(convA, 'notice', 'turnerror:no answer', { errorClass: 'SlowModelError' });
  app.store.addMessage(convB, 'notice', 'turnerror:empty', { errorClass: 'EmptyReply' });
  app.store.addMessage(convB, 'notice', 'fallback:Fast (x) failed, so Home (y) took over.');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

test('the week is counted from runs, steps and notices', () => {
  const r = qualityReport(app.store.db, clock.now);
  assert.equal(r.turns, 5);
  assert.equal(r.failed, 2);
  assert.equal(r.slow, 1);
  assert.equal(r.empty, 1);
  assert.equal(r.fallbacks, 1);
  assert.equal(r.refused, 1);
  assert.equal(r.stale, 1);
  assert.equal(r.unverified, 1);
  assert.deepEqual(r.reasons.map((x) => [x.errorClass, x.count]), [['EmptyReply', 1], ['SlowModelError', 1]]);
  assert.deepEqual(r.reasons[1].chats, [{ id: convA, title: 'Time sheet' }]);
  assert.ok(r.tips.some((x) => /Auto \(Settings → Models\)/.test(x)));
  assert.equal(qualityReport(app.store.db, clock.now, 30).turns, 6);
});

test('tips: nothing to fix on a clean week', () => {
  assert.deepEqual(qualityTips({ failed: 0, slow: 0, empty: 0, fallbacks: 0, refused: 0, stale: 0, unverified: 0, reasons: [] }), ['Nothing to fix this week.']);
});

test('GET /api/quality for the owner; members never reach it', async () => {
  const r = await call('/api/quality?days=7');
  assert.equal(r.status, 200);
  const body = (await r.json()) as { failed: number; reasons: unknown[] };
  assert.equal(body.failed, 2);
  const member = memberRouteCheck({ status: 'active', limits: {} } as never, 'GET', ['quality']);
  assert.equal(member?.status, 403);
  assert.equal(member?.ownerOnly, true);
});

test('the weekly review carries the counts card (owner)', async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://p' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  app.script.push([{ type: 'text', text: 'A calm week. Next week: rest.' }]);
  const { ReviewWorker } = await import('../src/review.ts');
  const out = await new ReviewWorker(app).send();
  const msg = app.store.messages(out.conversationId).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((msg.meta?.quality as { failed: number }).failed, 2);
  assert.equal((msg.meta?.quality as Record<string, unknown>).reasons, undefined, 'counts only');
});

test('Auto settings: the API keeps only known jobs; new installs get Auto, existing ones do not', async () => {
  const put = await call('/api/settings', 'PUT', { autoJobs: ['chat', 'vision', 'bogus'] });
  assert.equal(put.status, 200);
  assert.deepEqual(app.settings.get().autoJobs, ['chat', 'vision']);
  assert.deepEqual(((await (await call('/api/settings')).json()) as { autoJobs: string[] }).autoJobs, ['chat', 'vision']);
  const auto = (await (await call('/api/model-jobs/auto')).json()) as { jobs: { job: string; picks: { model: string; why: string }[] }[] };
  assert.deepEqual(auto.jobs.map((j) => j.job), ['chat', 'coding', 'vision', 'research']);
  assert.match(auto.jobs[0].picks[0]?.why ?? '', /^Auto for talking/);
  assert.deepEqual(newInstallAuto({ providers: [] }), { autoJobs: ['chat', 'coding', 'vision', 'research'] });
  assert.deepEqual(newInstallAuto({ providers: [{ id: 'x' } as never] }), {});
  assert.deepEqual(newInstallAuto({ providers: [], autoJobs: [] }), {});
});

// V1.2 (docs/WAITING.md): Waiting on you, one queue. A read-only aggregator over the stores that
// already hold each waiting thing (no second store): every source appears once with a working
// action, urgent-then-oldest order, Later = Today's "Not today", a household member sees only their
// own, money/password cards never approve by one tap (swipe), the route, the web view's rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { Errands } from '../src/errands.ts';
import { InboxHelper } from '../src/inbox/helper.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { getLayout } from '../src/today-layout.ts';
import type { Tool } from '../src/tools/types.ts';
import { waitingAct, waitingList, WAIT_SOURCES, type WaitDeps } from '../src/waiting.ts';
import { FIX } from './inbox-fixtures.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const tool = (name: string, out: (a: Record<string, unknown>) => string, perm: Tool['defaultPermission'] = 'auto', log: string[] = []): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: perm, summarize: () => name, run: async (a) => (log.push(name), out(a)) });

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  app.runs = new RunStore(app.store.db, () => clock.now);
  const sent: string[] = [];
  app.tools.add(tool('mail_search', () => 'alex@example.test (IMAP):\n- id m1 · 2026-11-02 · From: Acme Store <orders@acme.example> · Subject: Your receipt #A-1001 · Total $42.50'));
  app.tools.add(tool('web_search', () => 'Acme Store help: write to support@acme.example for refunds.'));
  app.tools.add(tool('mail_send', (a) => `Sent from alex@example.test to ${String(a.to)}.\nVerified: the mail server accepted it (id s1).`, 'ask', sent));
  app.errands = new Errands(app, app.store.db, { runTask: async () => ({ reply: 'ok' }), notify: async () => undefined, quiet: () => false, ownAddresses: () => ['alex@example.test'] });
  const mails = [{ ...FIX.billText, date: '2026-11-16T14:00:00.000Z' }, { ...FIX.shipText, date: '2026-11-16T14:05:00.000Z' }];
  app.inbox = new InboxHelper(app, app.store.db, { accounts: () => ['alex@mail.test'], readMail: async () => mails, model: async () => '{"kind":"none"}', notify: async () => undefined, quiet: () => false });
  const stops: AbortController[] = [];
  t.after(() => {
    for (const c of stops) c.abort();
    app.store.close();
    cleanup();
  });
  return { app, clock, dir, sent, stops };
}

async function drive(e: Errands, id: number): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const before = JSON.stringify(e.get(id));
    await e.advance(id);
    if (JSON.stringify(e.get(id)) === before) return;
  }
}

/** Every source once: a waiting approval (safe + money), a team step, a device, a board question, an errand draft, inbox cards, an overdue to-do, a failed chat, a follow-up. */
async function seedAll(r: ReturnType<typeof rig>) {
  const { app } = r;
  const conv = app.store.createConversation({ title: 'Kitchen' });
  const [c1, c2] = [new AbortController(), new AbortController()];
  r.stops.push(c1, c2);
  const safeReq = app.approvals.request(conv.id, c1.signal);
  const payReq = app.approvals.request(conv.id, c2.signal);
  const approvals = [
    { type: 'approval', approvalId: safeReq.id, id: 'c1', name: 'note_add', summary: 'Add a note', args: {}, conversationId: conv.id, since: '2026-11-16T14:50:00.000Z' },
    { type: 'approval', approvalId: payReq.id, id: 'c2', name: 'pay_bill', summary: 'Pay $56.10 to Northside Water', args: {}, conversationId: conv.id, since: '2026-11-16T14:40:00.000Z' },
  ];
  const teamConv = app.store.createConversation({ title: 'Team' });
  app.team = { running: () => [{ id: 4, conversationId: teamConv.id, goal: 'Ship the site' }], approvals: () => [{ id: 'ta', stepId: 1, helper: 'Builder', tool: 'shell', summary: 'Run npm test' }] } as never;
  app.deviceApprovals = { pending: () => [{ kind: 'sign-in', action: null, label: 'A phone wants to sign in', ip: '203.0.113.9', createdAt: '2026-11-16T14:30:00.000Z', expiresAt: '2026-11-16T15:30:00.000Z' }] } as never;
  app.board = { today: () => ({ waiting: [{ id: 7, title: 'Pick the tiles', question: 'White or gray?', boardId: 2 }], doing: [] }) } as never;
  const e = app.errands!.start({ goal: 'Get the Acme charge refunded', facts: { merchant: 'Acme Store' } });
  await drive(app.errands!, e.id);
  await app.inbox!.scan();
  app.planner!.addTask({ title: 'Renew the car tags', dueAt: '2026-11-10T15:00:00.000Z' });
  const failed = app.store.createConversation({ title: 'Broken chat' });
  const run = app.runs!.open({ kind: 'turn', conversationId: failed.id });
  app.runs!.close(run, 'error', 0, r.clock.now.getTime());
  const deps: WaitDeps = { approvals: () => approvals as never, followups: async () => [{ threadId: 'th1', subject: 'Quote for the deck', from: 'Sam <sam@example.test>', date: '2026-11-12T10:00:00.000Z', ageDays: 4 }] };
  return { deps, safeReq, payReq, errand: e, conv };
}

test('V1.2 one queue: every source appears once, urgent first then oldest, each with its own card', async (t) => {
  const r = rig(t);
  const { deps } = await seedAll(r);
  const items = await waitingList(r.app, deps);
  const keys = items.map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'no row twice');
  assert.deepEqual([...new Set(items.map((x) => x.source))].sort(), [...WAIT_SOURCES].sort(), 'every source is in the queue');
  assert.equal(items.filter((x) => x.source === 'approval').length, 2);
  assert.equal(items.filter((x) => x.source === 'inbox').length, 2, 'the bill and the package');
  // Urgent rows (something is blocked until you answer) come first, oldest first among them.
  const firstLax = items.findIndex((x) => !x.urgent);
  assert.ok(firstLax > 0 && items.slice(firstLax).every((x) => !x.urgent), 'urgent first');
  const urgentAt = items.slice(0, firstLax).map((x) => x.at).filter(Boolean) as string[];
  assert.deepEqual(urgentAt, [...urgentAt].sort(), 'oldest first');
  assert.equal(items[0]!.source, 'device', 'the oldest urgent row leads');
  // Each row opens its own card.
  const by = (s: string) => items.find((x) => x.source === s)!;
  assert.equal(by('approval').open.kind, 'chat');
  assert.deepEqual(by('question').open, { kind: 'card', boardId: 2, cardId: 7 });
  assert.equal(by('errand').open.kind, 'errand');
  assert.equal(by('inbox').open.kind, 'inbox');
  assert.equal(by('overdue').open.kind, 'task');
  assert.equal(by('failed').open.kind, 'chat');
  assert.equal(by('device').open.kind, 'device');
  assert.equal(by('followup').open.kind, 'ask');
  // Read-only: listing changed nothing.
  assert.equal(r.app.inbox!.list({ status: 'pending' }).length, 2);
  assert.equal(r.app.errands!.get(1)!.status, 'waiting_you');
});

test('V1.2 one tap: approves the safe approval, the errand draft and a package card; money never by one tap', async (t) => {
  const r = rig(t);
  const { deps, safeReq, payReq, errand, conv } = await seedAll(r);
  const items = await waitingList(r.app, deps);
  const row = (k: string) => items.find((x) => x.key === k)!;
  assert.equal(row(`approval:${safeReq.id}`).oneTap, true);
  assert.equal(row(`approval:${payReq.id}`).oneTap, false);
  assert.equal(row(`approval:${payReq.id}`).noTap, 'money');
  const bill = items.find((x) => x.source === 'inbox' && /water/i.test(x.title))!;
  const ship = items.find((x) => x.source === 'inbox' && /package/i.test(x.title))!;
  assert.equal(bill.oneTap, false, 'a bill never by swipe');
  assert.equal(bill.noTap, 'money');
  assert.equal(ship.oneTap, true);
  assert.equal(row(`errand:${errand.id}`).oneTap, true, 'the refund email draft waits for one OK');
  for (const s of ['team', 'device', 'question', 'overdue', 'failed', 'followup']) assert.equal(items.find((x) => x.source === s)!.oneTap, false, `${s} needs a look`);
  // Money and passwords are refused and nothing is decided.
  await assert.rejects(waitingAct(r.app, deps, `approval:${payReq.id}`, 'approve'), (e: Error & { status?: number }) => e.status === 409 && /Money and passwords/.test(e.message));
  await assert.rejects(waitingAct(r.app, deps, bill.key, 'approve'), /Money and passwords/);
  assert.ok(r.app.approvals.pendingFor(conv.id).includes(payReq.id), 'the payment still waits');
  await assert.rejects(waitingAct(r.app, deps, 'card:7', 'approve'), /needs a look/);
  // The working actions: the same answer as the card itself.
  await waitingAct(r.app, deps, `approval:${safeReq.id}`, 'approve');
  assert.equal(await safeReq.decision, true);
  await waitingAct(r.app, deps, ship.key, 'approve');
  assert.equal(r.app.inbox!.get(Number(ship.key.split(':')[1]))!.status, 'done');
  await waitingAct(r.app, deps, `errand:${errand.id}`, 'approve');
  assert.equal(r.sent.length, 1, 'the draft went out through mail_send');
  await assert.rejects(waitingAct(r.app, deps, 'inbox:999', 'approve'), (e: Error & { status?: number }) => e.status === 404);
});

test('V1.2 Later: puts a row off until tomorrow through Today\'s "Not today" (no second store)', async (t) => {
  const r = rig(t);
  const { deps } = await seedAll(r);
  await waitingAct(r.app, deps, 'card:7', 'later');
  assert.ok(getLayout(r.app).prefs.notToday.keys.includes('card:7'), 'the same snooze Today uses');
  assert.ok(!(await waitingList(r.app, deps)).some((x) => x.key === 'card:7'));
  // The next day it is back.
  r.clock.now = new Date('2026-11-17T15:00:00Z');
  assert.ok((await waitingList(r.app, deps)).some((x) => x.key === 'card:7'));
});

test('V1.2 household: a member sees only their own (their space, no owner-only device requests)', async (t) => {
  const owner = rig(t);
  await seedAll(owner);
  const { dir, cleanup } = tempDir();
  const member = makeApp(dir, { now: new Date('2026-11-16T15:00:00Z') });
  t.after(() => (member.store.close(), cleanup()));
  member.deviceApprovals = owner.app.deviceApprovals;
  member.planner!.addTask({ title: 'Feed the cat', dueAt: '2026-11-15T15:00:00.000Z' });
  const list = await waitingList(member, { member: true });
  assert.deepEqual(list.map((x) => x.title), ['Feed the cat']);
  const { MEMBER_ROUTES } = await import('../src/household.ts');
  assert.ok(MEMBER_ROUTES.has('waiting'));
});

test('V1.2 route: GET /api/waiting lists the queue with counts; POST act answers or refuses', async (t) => {
  const r = rig(t);
  const auth = new OwnerAuth(r.dir, () => r.app.now());
  const token = auth.newToken!;
  const server = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => (server.closeAllConnections(), server.close()));
  await seedAll(r);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const call = (path: string, body?: unknown) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const g = (await (await call('/waiting')).json()) as { items: { key: string; source: string; oneTap: boolean }[]; counts: Record<string, number> };
  assert.equal(g.counts.inbox, 2);
  assert.equal(g.counts.question, 1);
  const bill = g.items.find((x) => x.source === 'inbox' && !x.oneTap)!;
  assert.equal((await call('/waiting/act', { key: bill.key, action: 'approve' })).status, 409);
  assert.equal((await call('/waiting/act', { key: bill.key, action: 'later' })).status, 200);
  assert.equal((await call('/waiting/act', { key: bill.key })).status, 400);
  const after = (await (await call('/waiting')).json()) as { items: { key: string }[] };
  assert.ok(!after.items.some((x) => x.key === bill.key));
});

test('V1.2 web: own view, Today link, swipe only where one tap is allowed, strings through t()', () => {
  const js = web('waiting.js');
  assert.match(js, /export async function openWaiting/);
  assert.match(js, /oneTap/);
  // A right swipe approves only a one-tap row; others bounce back with the reason.
  assert.match(js, /if \(!x\.oneTap\)/);
  assert.doesNotMatch(js, /fetch\(/, 'through the shared api helper');
  const html = web('index.html');
  assert.match(html, /<dialog id="waiting"/);
  assert.match(web('app.js'), /waiting: \(\) => void openWaiting\(\)/);
  assert.match(web('today.js'), /ctx\.openWaiting/);
});

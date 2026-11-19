// W4.1 (docs/HANDLE_IT.md): "Handle it" on a renewal, a return, a bill, a cancel suggestion and a
// form. Each kind: the plan is shown first (a planned errand, nothing runs), Start runs the steps
// with the existing tools (fakes here), she stops for the person's OK at sign-in, payment and
// sending, Pause/Stop hold or end it, every step lands on the action timeline, and the report ends
// with receipts. She never pays: a payment step is the person's own word, Always allow never skips
// it, and a bill is only marked paid (tracking) after they say they paid.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setAlwaysAllow } from '../src/always-allow.ts';
import { Errands } from '../src/errands.ts';
import { handleBegin, handleOk, handlePause, handleResume, handleSettled, handleStart, handleStop, handleView, HANDLE_KINDS } from '../src/handle-it.ts';
import { observeMoneyMail } from '../src/money/hub.ts';
import { addPurchase } from '../src/money/purchases.ts';
import { moneyStore } from '../src/money/store.ts';
import { observeTrimMail, trimList } from '../src/money/trim.ts';
import { renewalAction } from '../src/renewals.ts';
import { timelineOf } from '../src/timeline.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

type Call = { name: string; args: Record<string, unknown> };
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function fakeTool(name: string, calls: Call[], out: (a: Record<string, unknown>) => string, perm: Tool['defaultPermission'] = 'auto'): Tool {
  return { spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: perm, summarize: () => name, run: async (args) => (calls.push({ name, args }), out(args)) };
}

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-19T15:00:00Z') };
  const app = makeApp(dir, clock) as TestApp;
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' } as never);
  const calls: Call[] = [];
  const sent: Record<string, unknown>[] = [];
  app.tools.add(fakeTool('mail_search', calls, (a) => (/receipt|payment/i.test(String(a.query)) ? 'alex@example.test (IMAP):\n- id m9 · 2026-11-19 · From: City Power <billing@citypower.example> · Subject: Payment received, thank you · $84.20' : 'alex@example.test (IMAP):\n- id m1 · 2026-11-02 · From: Acme Store <orders@acme.example> · Subject: Your bill #A-1001 · Total $84.20')));
  app.tools.add(fakeTool('web_search', calls, () => 'Help: write to support@acme.example. Phone (800) 555-0100. https://acme.example/account'));
  app.tools.add(fakeTool('mail_send', calls, (a) => (sent.push(a), `Sent from alex@example.test to ${String(a.to)}.\nVerified: the mail server accepted it (id s${sent.length}).`), 'ask'));
  app.tools.add(fakeTool('pc_fill_form', calls, () => 'Filled 4 fields and read them back. Stopped before Submit.\nVerified: read back 4 of 4 fields.'));
  const tasks: string[] = [];
  app.errands = new Errands(app, app.store.db, {
    runTask: async (r) => (tasks.push(r.content), { reply: 'Done in the browser: the page shows "Submitted".' }),
    notify: async () => undefined,
    quiet: () => false,
    ownAddresses: () => ['alex@example.test'],
  });
  t.after(async () => {
    await handleSettled();
    app.store.close();
    cleanup();
  });
  return { app, calls, sent, tasks };
}

/** Start/OK run in the background until she needs the person: wait for that. */
async function settle(app: TestApp, id: number) {
  await handleSettled();
  return handleView(app, id);
}

test('W4.1 kinds: five sources, a plan shown first (nothing runs), stops marked on each step', (t) => {
  const { app, calls } = rig(t);
  assert.deepEqual([...HANDLE_KINDS], ['renewal', 'return', 'bill', 'cancel', 'form']);
  const r = renewalAction(app, 'add', { title: 'Passport', date: '2027-01-15', what: 'passport' });
  const b = handleBegin(app, 'renewal', String(r.id));
  assert.equal(b.errand.status, 'planning', 'the plan waits for Start');
  assert.equal(calls.length, 0, 'nothing ran before Start');
  assert.equal(b.errand.facts.handleKind, 'renewal');
  assert.deepEqual(b.plan.map((s) => s.stop), [null, 'signin', 'ok', 'ok', 'pay']);
  assert.match(b.plan[4]!.text, /you press Pay/i);
  // Begin again: the same errand (one per source), not a second one.
  assert.equal(handleBegin(app, 'renewal', String(r.id)).errand.id, b.errand.id);
  assert.throws(() => handleBegin(app, 'nonsense' as never, '1'), /kind/i);
  assert.throws(() => handleBegin(app, 'bill', '999'), /not found|not on your list/i);
});

test('W4.1 renewal: sign-in, fill, submit and pay each stop for the OK; receipts at the end; timeline rows', async (t) => {
  const { app, calls, tasks } = rig(t);
  const r = renewalAction(app, 'add', { title: 'Passport', date: '2027-01-15', what: 'passport' });
  const id = handleBegin(app, 'renewal', String(r.id)).errand.id;
  await handleStart(app, id);
  let v = await settle(app, id);
  assert.equal(v.status, 'waiting_you');
  assert.equal(v.stop, 'signin', 'first stop: sign in on their site');
  assert.match(v.ask ?? '', /never types passwords/);
  await handleOk(app, id, {});
  v = await settle(app, id);
  assert.equal(v.stop, 'ok', 'fill the form asks first');
  await handleOk(app, id, {});
  v = await settle(app, id);
  assert.ok(calls.some((c) => c.name === 'pc_fill_form'), 'the existing form filler ran');
  assert.equal(v.stop, 'ok', 'submit asks first');
  await handleOk(app, id, {});
  v = await settle(app, id);
  assert.equal(tasks.length, 1, 'submit ran as one browser step after the OK');
  assert.equal(v.stop, 'pay');
  assert.match(v.ask ?? '', /you pay/i);
  await handleOk(app, id, { amount: 130 });
  v = await settle(app, id);
  assert.equal(v.status, 'done');
  assert.ok(v.receipts.length >= 3, 'each finished step has its proof line');
  assert.match(v.summary ?? '', /Receipts:/);
  assert.match(v.summary ?? '', /You paid \$130/);
  assert.ok(!calls.some((c) => c.name === 'mail_send'), 'nothing was sent');
  const rows = timelineOf(app).list({ limit: 50 }).filter((x) => x.tool === 'handle_it');
  assert.ok(rows.some((x) => /started/i.test(x.summary)) && rows.some((x) => /done/i.test(x.summary)), 'start and end on the timeline');
  assert.ok(rows.filter((x) => /step/i.test(x.summary)).length >= 4, 'every finished step is a timeline row');
});

test('W4.1 return: the request email waits for the OK; Always allow sends it without the card (W0.7)', async (t) => {
  const { app, sent } = rig(t);
  const p = addPurchase(app, { item: 'Desk lamp', store: 'Acme Store', price: '39.99', date: '2026-11-10', returnBy: '2026-12-10' });
  const id = handleBegin(app, 'return', String(p.id)).errand.id;
  assert.deepEqual(handleView(app, id).steps.map((s) => s.stop), [null, null, 'send', null]);
  await handleStart(app, id);
  let v = await settle(app, id);
  assert.equal(v.stop, 'send');
  assert.equal(sent.length, 0, 'not sent before the OK');
  await handleOk(app, id, {});
  v = await settle(app, id);
  assert.equal(sent.length, 1);
  assert.equal(v.status, 'waiting_others', 'now it waits for their answer');
  // A second return with Always allow on: the email goes without a card.
  const p2 = addPurchase(app, { item: 'Chair', store: 'Acme Store', price: '89', date: '2026-11-11', returnBy: '2026-12-11' });
  setAlwaysAllow(app, { on: true, for: '1h', warned: true });
  const id2 = handleBegin(app, 'return', String(p2.id)).errand.id;
  await handleStart(app, id2);
  v = await settle(app, id2);
  assert.equal(sent.length, 2, 'Always allow skipped the send card');
  assert.equal(v.status, 'waiting_others');
});

test('W4.1 bill: she never pays; Always allow does not skip sign-in or payment; Pay marks the bill paid (tracking only)', async (t) => {
  const { app, calls } = rig(t);
  setAlwaysAllow(app, { on: true, for: '1h', warned: true });
  const s = moneyStore(app);
  const bill = s.addBill({ name: 'City Power', amountCents: 8420, repeat: 'monthly', dueDay: 25, dueDate: null, autopay: false, leadDays: 3 });
  const b = handleBegin(app, 'bill', String(bill.id));
  assert.deepEqual(b.plan.map((x) => x.stop), [null, null, 'signin', 'pay', null]);
  await handleStart(app, b.errand.id);
  let v = await settle(app, b.errand.id);
  assert.equal(v.stop, 'signin', 'Always allow is on, still the sign-in is yours');
  await handleOk(app, b.errand.id, {});
  v = await settle(app, b.errand.id);
  assert.equal(v.stop, 'pay', 'Always allow is on, still the payment is yours');
  assert.match(v.ask ?? '', /\$84\.2/);
  const before = calls.length;
  assert.equal(s.bill(bill.id)!.paidFor ?? null, null, 'not marked paid before they say so');
  await handleOk(app, b.errand.id, {});
  v = await settle(app, b.errand.id);
  assert.ok(s.bill(bill.id)!.paidFor, 'the bill is marked paid (tracking)');
  assert.deepEqual(calls.slice(before).map((c) => c.name), ['mail_search'], 'after the OK only the receipt search ran: no tool paid anything');
  assert.equal(v.status, 'done');
  assert.ok(v.receipts.some((r) => /Your word/.test(r.line)), 'the payment receipt is the person’s own word');
  assert.ok(v.receipts.some((r) => /Read only/.test(r.line)));
});

test('W4.1 cancel: from Maybe cancel; sign-in, fill and the final confirm each ask; Pause holds it, Stop ends it', async (t) => {
  const { app, calls } = rig(t);
  const m = { account: 'alex@example.test', id: 'mh1', from: 'Hulu <hello@hulu.test>', subject: 'We miss you, Alex', date: '2026-11-10T18:00:00Z', text: "You haven't watched anything on Hulu in 60 days. Your plan renews on December 9, 2026 for $7.99." };
  observeMoneyMail(app, m as never);
  observeTrimMail(app, m as never);
  const row = trimList(app).rows.find((r) => r.name === 'Hulu')!;
  const b = handleBegin(app, 'cancel', row.key);
  assert.deepEqual(b.plan.map((x) => x.stop), [null, 'signin', 'ok', 'ok']);
  await handleStart(app, b.errand.id);
  await settle(app, b.errand.id);
  handlePause(app, b.errand.id);
  assert.equal(handleView(app, b.errand.id).paused, true);
  await assert.rejects(handleOk(app, b.errand.id, {}), /paused/i, 'a paused errand takes no OK');
  const n = calls.length;
  app.errands!.due();
  await app.errands!.settled();
  assert.equal(calls.length, n, 'the tick leaves a paused errand alone');
  handleResume(app, b.errand.id);
  await handleOk(app, b.errand.id, {}); // signed in
  const v = await settle(app, b.errand.id);
  assert.equal(v.stop, 'ok');
  handleStop(app, b.errand.id);
  assert.equal(handleView(app, b.errand.id).status, 'stopped');
  const rows = timelineOf(app).list({ limit: 50 }).filter((x) => x.tool === 'handle_it').map((x) => x.summary);
  assert.ok(rows.some((x) => /paused/i.test(x)) && rows.some((x) => /resumed/i.test(x)) && rows.some((x) => /stopped/i.test(x)));
});

test('W4.1 form: a Library form filled in a step of its own, sending asks first; Undo on the timeline stops a run', async (t) => {
  const { app, tasks } = rig(t);
  (app as unknown as { library: unknown }).library = { get: (id: number) => (id === 7 ? { id: 7, name: 'Permit application.pdf', title: 'Permit application' } : undefined) };
  const b = handleBegin(app, 'form', '7');
  assert.deepEqual(b.plan.map((x) => x.stop), [null, 'send']);
  await handleStart(app, b.errand.id);
  const v = await settle(app, b.errand.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0]!, /Permit application/);
  assert.equal(v.stop, 'send');
  const start = timelineOf(app).list({ limit: 50 }).find((x) => x.tool === 'handle_it' && /started/i.test(x.summary))!;
  assert.equal(start.canRevert, true);
  await timelineOf(app).revert(start.id, app);
  assert.equal(handleView(app, b.errand.id).status, 'stopped', 'Undo on the start row stops it');
  assert.throws(() => handleBegin(app, 'form', '8'), /not found/i);
});

test('W4.1 wiring: routes, buttons on each source, one dialog, strings', () => {
  const routes = read('src/routes/errands.ts');
  assert.match(routes, /handleRoute/);
  const js = read('web/handle-it.js');
  for (const k of ['Pause', 'Resume', 'Stop', 'Start']) assert.ok(js.includes(`t('${k}')`), k);
  assert.match(js, /export async function handleIt/);
  for (const [f, kind] of [['web/renewals.js', 'renewal'], ['web/purchases.js', 'return'], ['web/money.js', 'bill'], ['web/trim.js', 'cancel'], ['web/library.js', 'form']] as const) {
    assert.ok(read(f).includes(`'${kind}'`) && read(f).includes("t('Handle it')"), `${f} has a Handle it button`);
  }
  const html = read('web/index.html');
  assert.equal((html.match(/<dialog id="handle-it"/g) ?? []).length, 1);
  const es = read('web/i18n/es.json');
  assert.match(es, /"Handle it": /);
});

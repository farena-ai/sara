// R3 (docs/ERRANDS.md): errands, start to finish. The plan and its one Allow, steps advanced one at a
// time through fake tools, approvals that are never bypassed, purchases that are never automatic, a
// reply (fake inbox) that advances a waiting step, follow-up timing, budget and deadline stops,
// verification evidence, receipts gating claims, household isolation, private chats, words, strings.
// A fake clock, fake tools and fake turns; no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Errands, planFor, templateFor, TEMPLATES, type ErrandOptions } from '../src/errands.ts';
import { InboxHelper } from '../src/inbox/helper.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { checkClaims } from '../src/receipts.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { createErrandTools } from '../src/tools/errands.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type Call = { name: string; args: Record<string, unknown> };

function fakeTool(name: string, calls: Call[], out: (a: Record<string, unknown>) => string, perm: Tool['defaultPermission'] = 'auto'): Tool {
  return { spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: perm, summarize: () => name, run: async (args) => (calls.push({ name, args }), out(args)) };
}

function rig(t: TestContext, o: { now?: string; task?: ErrandOptions['runTask'] } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? '2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  const calls: Call[] = [];
  const sent: Record<string, unknown>[] = [];
  app.tools.add(fakeTool('mail_search', calls, () => 'alex@example.test (IMAP):\n- id m1 · 2026-11-02 · From: Acme Store <orders@acme.example> · Subject: Your receipt #A-1001 · Total $42.50'));
  app.tools.add(fakeTool('web_search', calls, () => 'Acme Store help: write to support@acme.example for refunds. Phone (800) 555-0100. https://acme.example/help'));
  app.tools.add(fakeTool('stores_near', calls, () => 'Stores within 5 mi of Austin:\n- Quick Lube (car_repair) 1.2 mi, 1 Main St, hours Mo-Fr 08:00-18:00, +1 512 555 0101, https://quicklube.example\n- Oil Pros (car_repair) 2.0 mi, 9 Elm St, +1 512 555 0102\n- Fast Oil (car_repair) 3.1 mi, 4 Oak St, https://fastoil.example'));
  app.tools.add(fakeTool('compare', calls, (a) => `| name |\n${(a.items as { name: string }[]).map((x) => `| ${x.name} |`).join('\n')}`));
  app.tools.add(fakeTool('mail_send', calls, (a) => (sent.push(a), `Sent from alex@example.test to ${String(a.to)}.\nVerified: the mail server accepted it (id s${sent.length}).`), 'ask'));
  app.tools.add(fakeTool('mail_draft', calls, (a) => `Saved as a draft to ${String(a.to)}. Nothing was sent.\nVerified: the mail server saved the draft (id d1).`, 'ask'));
  app.tools.add(fakeTool('pc_fill_form', calls, () => 'Filled 4 fields and read them back. Stopped before Submit.\nVerified: read back 4 of 4 fields.'));
  const pushed: { title: string; body: string }[] = [];
  const tasks: string[] = [];
  const errands = new Errands(app, app.store.db, {
    runTask: o.task ?? (async (r) => (tasks.push(r.content), { reply: 'Quick Lube has 4.7 stars and opens at 8.' })),
    notify: async (title, body) => void pushed.push({ title, body }),
    quiet: () => false,
    ownAddresses: () => ['alex@example.test'],
  });
  app.errands = errands;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, errands, calls, sent, pushed, tasks, dir };
}

/** Runs the runner until nothing more moves on its own (each call = one step at most). */
async function drive(e: Errands, id: number, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    const before = JSON.stringify(e.get(id));
    await e.advance(id);
    if (JSON.stringify(e.get(id)) === before) return;
  }
}

test('R3 templates: words in six languages pick the plan; a model plan is cleaned; purchase and call kinds are kept', () => {
  assert.equal(templateFor('get this charge refunded')?.id, 'refund');
  assert.equal(templateFor('quiero un reembolso de Acme')?.id, 'refund');
  assert.equal(templateFor('book an oil change this week')?.id, 'book');
  assert.equal(templateFor('find and book a plumber')?.id, 'book');
  assert.equal(templateFor('cancel my subscription to StreamCo')?.id, 'cancel');
  assert.equal(templateFor('kündige mein Abo')?.id, 'cancel');
  assert.equal(templateFor('write a complaint letter to the landlord')?.id, 'dispute');
  assert.equal(templateFor('get quotes from 3 contractors for a fence')?.id, 'quotes');
  assert.equal(templateFor('what is the weather'), undefined);
  assert.equal(TEMPLATES.length, 5);
  const p = planFor('refund the Acme charge', { facts: { merchant: 'Acme Store' } });
  assert.equal(p.template, 'refund');
  assert.deepEqual(p.steps.map((s) => s.kind), ['research', 'research', 'message', 'wait']);
  const own = planFor('buy a gift', { steps: [{ text: 'Find a gift', kind: 'research' }, { text: 'Pay for it', kind: 'purchase', amount: 30 }, { text: 'Call the shop', kind: 'call', phone: '+1 512 555 0100' }, { text: 'x', kind: 'nonsense' }] });
  assert.deepEqual(own.steps.map((s) => s.kind), ['research', 'purchase', 'call']);
  assert.ok(own.steps.every((s) => s.status === 'todo'));
});

test('R3 plan approval: errand_start asks once and its card is the plan; private chats are refused', async (t) => {
  const r = rig(t);
  const tools = createErrandTools(() => r.app);
  const start = tools.find((x) => x.spec.name === 'errand_start')!;
  assert.equal(start.defaultPermission, 'ask', 'the plan takes one Allow');
  const card = start.summarize!({ goal: 'Get the Acme charge refunded', facts: { merchant: 'Acme Store', amount: '$42.50' } });
  assert.match(card, /Get the Acme charge refunded/);
  assert.match(card, /1\. .*receipt/i);
  assert.match(card, /asks you before/i, 'the card says which steps ask');
  const out = await start.run({ goal: 'Get the Acme charge refunded', facts: { merchant: 'Acme Store', amount: '$42.50' } }, { workspaceDir: r.dir, signal: AbortSignal.timeout(5000), conversationId: r.app.store.createConversation({ title: 'x' }).id } as never);
  assert.match(out, /Errand #1/);
  assert.equal(r.errands.get(1)!.status, 'working');
  const priv = r.app.store.createConversation({ title: 'Private', private: true });
  await assert.rejects(start.run({ goal: 'refund it' }, { workspaceDir: r.dir, signal: AbortSignal.timeout(5000), conversationId: priv.id } as never), /private chat/);
  // From the page: a plan waits in "planning" until Start.
  const e = r.errands.start({ goal: 'book an oil change this week', facts: { service: 'oil change' } }, { by: 'page' });
  assert.equal(e.status, 'planning');
  await r.errands.advance(e.id);
  assert.equal(r.calls.length, 0, 'nothing runs before Start');
  r.errands.confirm(e.id);
  assert.equal(r.errands.get(e.id)!.status, 'working');
});

test('R3 refund end to end: receipt → support address → approve → send → reply advances → done, every step evidenced', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'Get the Acme charge refunded', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, e.id);
  let x = r.errands.get(e.id)!;
  assert.deepEqual(r.calls.map((c) => c.name), ['mail_search', 'web_search']);
  assert.equal(x.facts.amount, '$42.50', 'the amount from the receipt');
  assert.equal(x.facts.email, 'support@acme.example', 'the support address found by research (not the owner’s own)');
  assert.equal(x.status, 'waiting_you');
  assert.equal(x.steps[2]!.status, 'waiting_you');
  assert.match(x.needs!, /support@acme\.example/);
  assert.match(x.steps[2]!.draft!.body, /\$42\.50/);
  assert.equal(r.sent.length, 0, 'never sent without the OK');
  assert.ok(r.pushed.some((p) => /needs you/i.test(p.title)), 'a notification for waiting on you');
  // The OK sends it (through mail_send), with the N1 line as evidence.
  await r.errands.approve(e.id);
  x = r.errands.get(e.id)!;
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.to, 'support@acme.example');
  assert.equal(x.steps[2]!.status, 'done');
  assert.equal(x.steps[2]!.evidence?.verified, 'verified');
  assert.match(x.steps[2]!.evidence!.line!, /Verified: the mail server accepted it/);
  await drive(r.errands, e.id);
  x = r.errands.get(e.id)!;
  assert.equal(x.status, 'waiting_others');
  // Mail that isn't theirs does nothing; their reply in the thread advances the errand and is summarized.
  assert.deepEqual(r.errands.observeMail({ account: 'alex@example.test', id: 'n0', from: 'news@other.example', subject: 'Deals', date: r.clock.now.toISOString(), text: 'Sale!' }), []);
  const hit = r.errands.observeMail({ account: 'alex@example.test', id: 'r1', from: 'Acme Support <support@acme.example>', subject: `Re: ${x.steps[2]!.draft!.subject}`, date: r.clock.now.toISOString(), text: 'Hi Alex, we refunded $42.50 to your card. It takes 3-5 days.\n\nOn Mon, Alex wrote:\n> Hello' });
  assert.deepEqual(hit, [e.id]);
  x = r.errands.get(e.id)!;
  assert.equal(x.steps[3]!.status, 'done');
  assert.match(x.steps[3]!.result!, /refunded \$42\.50/);
  assert.doesNotMatch(x.steps[3]!.result!, /wrote:/, 'quoted text is left out of the summary');
  assert.equal(x.steps[3]!.evidence?.ref, 'r1');
  await drive(r.errands, e.id);
  x = r.errands.get(e.id)!;
  assert.equal(x.status, 'done');
  assert.match(x.summary!, /refunded/);
  for (const s of x.steps) assert.ok(s.evidence, `evidence on: ${s.text}`);
});

test('R3 approvals are never bypassed: a tool set to never fails the step; send-without-asking only by the person and never for purchases', async (t) => {
  const r = rig(t);
  r.app.settings.update({ toolPermissions: { mail_send: 'never' } });
  const e = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, e.id);
  await r.errands.approve(e.id);
  let x = r.errands.get(e.id)!;
  assert.equal(r.sent.length, 0, 'mail_send is set to never');
  assert.equal(x.status, 'waiting_you');
  assert.match(x.needs!, /turned off|never/i);
  r.app.settings.update({ toolPermissions: {} });
  // The model can't turn on sending without asking; the person can (route / page).
  const tools = createErrandTools(() => r.app);
  const upd = tools.find((x) => x.spec.name === 'errand_update')!;
  const said = await upd.run({ id: String(e.id), send_without_asking: true }, { workspaceDir: r.dir, signal: AbortSignal.timeout(5000) } as never);
  assert.match(said, /only you can turn/i);
  assert.equal(r.errands.get(e.id)!.sendWithoutAsking, false);
  const e2 = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  r.errands.update(e2.id, { sendWithoutAsking: true }, { by: 'person' });
  await drive(r.errands, e2.id);
  x = r.errands.get(e2.id)!;
  assert.equal(r.sent.length, 1, 'sent on its own because the person turned it on for this errand');
  assert.equal(x.status, 'waiting_others');
  // Purchases: always a hand-over, even with sending on; no tool runs.
  const e3 = r.errands.start({ goal: 'buy the part', steps: [{ text: 'Pay for the part', kind: 'purchase', url: 'https://shop.example/cart', amount: 25 }] });
  r.errands.update(e3.id, { sendWithoutAsking: true }, { by: 'person' });
  const before = r.calls.length;
  await drive(r.errands, e3.id);
  x = r.errands.get(e3.id)!;
  assert.equal(r.calls.length, before, 'no tool for a purchase');
  assert.equal(x.status, 'waiting_you');
  assert.match(x.needs!, /you pay/i);
  assert.match(x.needs!, /shop\.example\/cart/);
  await r.errands.approve(e3.id, { note: 'paid' });
  x = r.errands.get(e3.id)!;
  assert.equal(x.spent, 25);
  assert.equal(x.steps[0]!.evidence?.kind, 'you', 'your word, not a claim of hers');
  assert.equal(x.status, 'done');
});

test('R3 calls are ready but off; decide waits for the choice; form stops before Submit', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'find and book an oil change', template: 'book', facts: { service: 'oil change' } });
  await drive(r.errands, e.id);
  let x = r.errands.get(e.id)!;
  assert.equal(r.calls[0]!.name, 'stores_near');
  assert.equal(r.tasks.length, 1, 'comparing their sites is a normal turn with her usual approvals');
  assert.equal(x.steps[2]!.kind, 'decide');
  assert.equal(x.status, 'waiting_you');
  assert.deepEqual(x.steps[2]!.options, ['Quick Lube', 'Oil Pros', 'Fast Oil']);
  assert.ok(r.calls.some((c) => c.name === 'compare'));
  await assert.rejects(r.errands.approve(e.id), /Pick one/);
  await r.errands.approve(e.id, { choice: 'Oil Pros' });
  await drive(r.errands, e.id);
  x = r.errands.get(e.id)!;
  // Oil Pros has a phone and no email or page: the booking step becomes a call script (calling is off).
  const step = x.steps[3]!;
  assert.equal(step.kind, 'call');
  assert.equal(x.status, 'waiting_you');
  assert.match(x.needs!, /Calling is not switched on/);
  assert.match(x.needs!, /512 555 0102/);
  assert.match(x.needs!, /oil change/i);
  await r.errands.approve(e.id, { note: 'Booked for Thursday 9 AM' });
  assert.match(r.errands.get(e.id)!.steps[3]!.result!, /Thursday/);
  // A provider with a booking page: the form is filled and she stops before Submit.
  const e2 = r.errands.start({ goal: 'book', template: 'book', facts: { service: 'oil change' } });
  await drive(r.errands, e2.id);
  await r.errands.approve(e2.id, { choice: 'Fast Oil' });
  await drive(r.errands, e2.id);
  x = r.errands.get(e2.id)!;
  assert.equal(x.steps[3]!.kind, 'form');
  assert.equal(x.status, 'waiting_you');
  assert.ok(!r.calls.some((c) => c.name === 'pc_fill_form'), 'not filled before the OK');
  await r.errands.approve(e2.id);
  x = r.errands.get(e2.id)!;
  assert.ok(r.calls.some((c) => c.name === 'pc_fill_form'));
  assert.match(x.steps[3]!.result!, /press Submit yourself/i);
  assert.equal(x.steps[3]!.evidence?.verified, 'verified');
});

test('R3 follow-up after N days with no reply: a drafted follow-up waits for the OK, then the wait goes on', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, e.id);
  await r.errands.approve(e.id);
  await drive(r.errands, e.id);
  assert.equal(r.errands.get(e.id)!.status, 'waiting_others');
  r.clock.now = new Date(r.clock.now.getTime() + 4 * 86_400_000);
  r.errands.due(r.clock.now);
  await r.errands.settled();
  assert.equal(r.errands.get(e.id)!.status, 'waiting_others', 'not yet at 4 days');
  r.clock.now = new Date(r.clock.now.getTime() + 1.1 * 86_400_000);
  r.errands.due(r.clock.now);
  await r.errands.settled();
  let x = r.errands.get(e.id)!;
  assert.equal(x.status, 'waiting_you');
  assert.match(x.needs!, /follow-up/i);
  assert.equal(r.sent.length, 1, 'the follow-up is not sent without the OK');
  await r.errands.approve(e.id);
  x = r.errands.get(e.id)!;
  assert.equal(r.sent.length, 2);
  assert.match(String(r.sent[1]!.subject), /^Re: /);
  assert.equal(x.status, 'waiting_others');
  assert.equal(x.steps[3]!.followUps, 1);
});

test('R3 budget and deadline stop the errand with a summary', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'buy a filter', budget: 20, steps: [{ text: 'Find it', kind: 'research', tool: 'web_search', args: { query: 'filter' } }, { text: 'Pay', kind: 'purchase', amount: 35, url: 'https://shop.example' }] });
  await drive(r.errands, e.id);
  let x = r.errands.get(e.id)!;
  assert.equal(x.status, 'stopped');
  assert.match(x.summary!, /budget/i);
  assert.match(x.summary!, /Find it/);
  const d = r.errands.start({ goal: 'refund', template: 'refund', deadline: '2026-11-18', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, d.id);
  r.clock.now = new Date('2026-11-19T12:00:00Z');
  r.errands.due(r.clock.now);
  await r.errands.settled();
  x = r.errands.get(d.id)!;
  assert.equal(x.status, 'stopped');
  assert.match(x.summary!, /deadline/i);
  assert.ok(r.pushed.some((p) => /stopped/i.test(p.title)));
  // Stop by hand keeps the log and says what was done.
  const s = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  await r.errands.advance(s.id);
  const stopped = r.errands.stop(s.id);
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.summary!, /receipt/i);
});

test('R3 the reminder tick advances errands; the inbox helper hands new mail to them; private local mode pauses', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  const sched = new ReminderScheduler(r.app, r.app.planner!);
  setPrivateLocal(true);
  try {
    sched.tick();
    await r.errands.settled();
    assert.equal(r.errands.get(e.id)!.steps[0]!.status, 'todo', 'private local mode: nothing goes out');
  } finally {
    setPrivateLocal(false);
  }
  sched.tick();
  await r.errands.settled();
  assert.equal(r.errands.get(e.id)!.steps[0]!.status, 'done', 'one step on the tick');
  assert.ok(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8').includes('this.#app.errands?.due(now)'));
  assert.ok(!/setInterval/.test(readFileSync(join(ROOT, 'src', 'errands.ts'), 'utf8')), 'no timer of its own');
  await drive(r.errands, e.id);
  await r.errands.approve(e.id);
  await drive(r.errands, e.id);
  const subject = r.errands.get(e.id)!.steps[2]!.draft!.subject;
  r.app.inbox = new InboxHelper(r.app, r.app.store.db, { accounts: () => ['alex@example.test'], readMail: async () => [{ account: 'alex@example.test', id: 'z9', from: 'support@acme.example', subject: `RE: ${subject}`, date: r.clock.now.toISOString(), text: 'We sent the refund.' }] });
  r.app.inbox.setSettings({ model: 'off' });
  await r.app.inbox.scan();
  assert.equal(r.errands.get(e.id)!.steps[3]!.status, 'done', 'the reply came through the inbox helper');
});

test('R3 receipts gate claims: “I sent the refund request” needs a verified send in the errand', async (t) => {
  const r = rig(t);
  const e = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, e.id);
  const status = createErrandTools(() => r.app).find((x) => x.spec.name === 'errand_status')!;
  const ctx = { workspaceDir: r.dir, signal: AbortSignal.timeout(5000) } as never;
  const before = await status.run({ id: String(e.id) }, ctx);
  const reply = 'I sent the refund request email to Acme.';
  assert.equal(checkClaims(reply, [{ name: 'errand_status', status: 'ok', args: { id: '1' }, output: before }]).length, 1, 'nothing sent yet: flagged');
  await r.errands.approve(e.id);
  const after = await status.run({ id: String(e.id) }, ctx);
  assert.match(after, /Verified:/);
  assert.equal(checkClaims(reply, [{ name: 'errand_status', status: 'ok', args: { id: '1' }, output: after }]).length, 0, 'the errand’s verified send backs it');
});

test('R3 household isolation: each space has its own errands; a member’s errand never shows to the owner', async (t) => {
  const a = rig(t);
  const b = rig(t);
  (b.app as { member?: unknown }).member = { id: 'm1', name: 'Ana' };
  a.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  b.errands.start({ goal: 'book a plumber', template: 'book', facts: { service: 'plumber' } });
  assert.deepEqual(a.errands.list().map((x) => x.goal), ['refund']);
  assert.deepEqual(b.errands.list().map((x) => x.goal), ['book a plumber']);
  assert.equal(b.errands.list()[0]!.owner, 'member');
});

test('R3 Today tile and words: shown only when an errand is open; “waiting on you” first', async (t) => {
  const r = rig(t);
  assert.equal(r.errands.todayTile(), undefined);
  const e = r.errands.start({ goal: 'refund', template: 'refund', facts: { merchant: 'Acme Store' } });
  await drive(r.errands, e.id);
  const tile = r.errands.todayTile()!;
  assert.equal(tile.needYou, 1);
  assert.equal(tile.items[0]!.status, 'waiting_you');
  assert.match(tile.items[0]!.needs!, /Send/);
  // Lean: the errand tools come with errand words, in six languages.
  for (const w of ['errand', 'take care of', 'handle this', 'get a refund', 'book', 'schedule an appointment', 'cancel my subscription', 'find someone to', 'get quotes']) assert.ok(FAMILY_WORDS.errands!.includes(w), w);
  for (const tool of createErrandTools(() => r.app)) assert.equal(familyOf(tool).id, 'errands', tool.spec.name);
  for (const w of ['reembolso', 'remboursement', 'erstattung', 'reembolso', 'rimborso']) assert.ok(FAMILY_WORDS.errands!.includes(w), w);
});

test('R3 wiring: tools, routes, persona, private chats, page, tile, docs and strings', () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  const chat = read('src', 'chat.ts');
  assert.match(chat, /name\.startsWith\('errand_'\)/, 'off in private chats');
  assert.match(read('src', 'lean.ts'), /n\.startsWith\('errand_'\)/);
  assert.match(read('src', 'main.ts'), /createErrandTools/);
  assert.match(read('src', 'server.ts'), /createErrandRoutes/);
  assert.match(read('src', 'household.ts'), /'errands'/);
  assert.match(read('src', 'persona.ts'), /## Errands/);
  const html = read('web', 'index.html');
  assert.match(html, /<dialog id="errands"/);
  assert.match(html, /data-dest="errands"/);
  assert.match(html, /id="td-errands"/);
  assert.match(read('web', 'nav.js'), /'errands'/);
  assert.match(read('web', 'today.js'), /\{ id: 'td-errands'/);
  assert.match(read('src', 'today-layout.ts'), /\{ id: 'td-errands'/);
  assert.ok(read('docs', 'ERRANDS.md').length > 500);
  assert.match(read('CHANGELOG.md'), /Errands/);
  const web = read('web', 'errands.js');
  assert.doesNotMatch(web, /style=/, 'no inline styles');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(read('web', 'i18n', `${lang}.json`)) as Record<string, string>;
    for (const s of ['Errands', 'What she needs from you', 'Approve step', 'Calling is not switched on; here’s the number and what to say:']) assert.ok(d[s] && d[s] !== s, `${lang}: ${s}`);
  }
});

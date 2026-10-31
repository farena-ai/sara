// Phase 103 (ST8, docs/design/STAPLES.md §11, docs/AGENDA.md): her own agenda. Off by default (nothing
// planned, nothing sent, the old proactive path); one shared daily cap with her proactive messages,
// quiet hours, the minimum gap and the daily budget, all checked in code before any model call;
// scheduling from his own words with a quoted why and the limits (5 open, 2 a day, 30 days ahead, no
// past, no sub-daily repeats, no source → no plan); delivery with meta.agenda.why, his answer marks it
// done, a missed window moves once then expires; editing, cancel, off pauses / on restores, the off
// switch aborts a running call; the crisis pause; goals (said twice, asked for, never about weight,
// eating, medication or self-harm); never from outside; the routes; the page wiring.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agenda, AGENDA_TOOLS, createAgendaTools, DEFAULT_AGENDA, feedsAgenda, futureMentions, goalMentions, LIMITS } from '../src/agenda.ts';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import type { HubEvent } from '../src/events.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { LifeWorker } from '../src/life.ts';
import type { ChatRequest, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { buildToday } from '../src/today.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

// Monday 2 November 2026, 10 am in UTC.
const NOW = '2026-11-02T10:00:00Z';

function setup(t: { after: (fn: () => void) => void }, start = NOW) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(start) };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date(start).toISOString() });
  const agenda = new Agenda(app, app.store.db);
  app.agenda = agenda;
  for (const tl of createAgendaTools(() => app)) app.tools.add(tl);
  const events: HubEvent[] = [];
  app.events!.subscribe((e) => events.push(e));
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, agenda, events, dir };
}

async function say(app: TestApp, convId: string, msg: string, reply = 'Mm-hm.'): Promise<ChatEvent[]> {
  app.script.push(text(reply));
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg)) out.push(ev);
  return out;
}
const hours = (n: number) => n * 3_600_000;
const rows = (app: TestApp, table: string) => Number((app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

test('off by default: nothing is planned, nothing new is sent, the proactive path is the old one', async (t) => {
  const { app, clock, agenda } = setup(t);
  assert.deepEqual(agenda.settings(), DEFAULT_AGENDA);
  assert.equal(agenda.enabled(), false);
  const conv = app.store.createConversation();
  await say(app, conv.id, 'Big week: the interview is on Friday. I really need to finish the garden shed.');
  assert.equal(rows(app, 'agenda_items'), 0, 'no plan while off');
  assert.equal(rows(app, 'agenda_goals'), 0);
  assert.equal(app.store.messages(conv.id).filter((m) => m.content.startsWith('agenda:')).length, 0, 'no "Added to her plans" notice');
  assert.deepEqual(await agenda.tick(), { skipped: 'off' });
  // Her tools are hidden while the agenda is off.
  for (const n of AGENDA_TOOLS) assert.equal(app.tools.get(n)!.isAvailable!(), false, n);
  // The LifeWorker tick with the agenda off is the old one (her day + a proactive message).
  clock.now = new Date(Date.parse(NOW) + hours(24));
  const w = new LifeWorker(app, app.life!, app.inner!, () => 0);
  app.script.push(text('A slow coffee and a long walk by the river this morning.'), text('Hey, how did the week start?'));
  const r = await w.tick();
  assert.equal(r.agenda, undefined, 'no agenda step');
  assert.equal(r.proactive, 'Hey, how did the week start?');
  assert.equal(app.store.messages(conv.id).at(-1)!.meta?.agenda, undefined);
  assert.equal(rows(app, 'agenda_ledger'), 0);
});

test('reading his words (code only): future events and goal-like phrases', () => {
  const now = new Date(NOW);
  const f = futureMentions('Big week. The interview is on Friday at 2!', now, 'UTC');
  assert.equal(f.length, 1);
  assert.deepEqual({ event: f[0].event, day: f[0].day, kind: f[0].kind }, { event: 'the interview', day: '2026-11-06', kind: 'ask' });
  assert.equal(f[0].quote, 'The interview is on Friday at 2!');
  assert.equal(futureMentions('I have a dentist appointment tomorrow.', now, 'UTC')[0]?.day, '2026-11-03');
  assert.equal(futureMentions('my exam is next Thursday', now, 'UTC')[0]?.event, 'your exam');
  const r = futureMentions('The passport renewal window opens Dec 1.', now, 'UTC')[0];
  assert.deepEqual({ kind: r.kind, day: r.day, event: r.event }, { kind: 'remind', day: '2026-12-01', event: 'the passport renewal window' });
  assert.deepEqual(futureMentions('What a day. Friday was fun.', now, 'UTC'), []);
  assert.deepEqual(futureMentions('The weather is nice on Friday', now, 'UTC'), [], 'not an event');
  assert.equal(goalMentions('I really need to finish the garden shed before winter.')[0]?.phrase, 'finish the garden shed');
  assert.deepEqual(goalMentions('I have to go, talk later'), [], 'trivial');
  assert.deepEqual(goalMentions('ok'), []);
});

test('scheduling: "the interview is on Friday" → one follow-up with a quoted why; the step says so in the chat', async (t) => {
  const { app, agenda } = setup(t);
  agenda.update({ enabled: true });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'Big week: the interview is on Friday.', 'Good luck!');
  const items = agenda.store.items();
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.what, 'Ask how the interview went');
  assert.equal(it.why, 'You said “Big week: the interview is on Friday.”');
  assert.equal(it.createdBy, 'her');
  assert.equal(it.dueAt, '2026-11-06T19:00:00.000Z', 'Friday evening');
  const said = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal(it.sourceMessage, said.id, 'the source message is stored');
  const notice = app.store.messages(conv.id).find((m) => m.role === 'notice' && m.content.startsWith('agenda:'));
  assert.ok(notice, '"Added to her plans" after her reply');
  assert.equal((notice!.meta?.agenda as { itemId: number }).itemId, it.id);
  // Saying it again plans nothing new.
  await say(app, conv.id, 'Yes, the interview is on Friday, nervous!');
  assert.equal(agenda.store.items().length, 1);
});

test('limits in code: 5 open, 2 a day, 30 days ahead, never the past, no source → no plan', async (t) => {
  const { app, clock, agenda } = setup(t);
  agenda.update({ enabled: true });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'My sister visits on Thursday and the plumber comes on Wednesday.');
  const tool = app.tools.get('agenda_add')!;
  const ctx = { workspaceDir: app.dataDir, signal: new AbortController().signal, sandbox: app.sandbox, conversationId: conv.id };
  // No source: an invented quote is refused.
  await assert.rejects(tool.run({ what: 'Ask how the party went', when: 'saturday 7pm', quote: 'the party is on Saturday' }, ctx), /No plan without a source/);
  assert.match(String(agenda.addByHer({ kind: 'follow-up', what: 'Ask about it', when: 'friday 7pm', quote: '' })), /No plan without a source/);
  // Past and too far ahead.
  assert.match(String(agenda.addByHer({ kind: 'follow-up', what: 'Ask about the plumber', when: '2026-11-01 10:00', quote: 'the plumber comes on Wednesday', conversationId: conv.id })), /Never in the past/);
  assert.match(String(agenda.addByHer({ kind: 'follow-up', what: 'Ask about the plumber', when: '2026-12-20 10:00', quote: 'the plumber comes on Wednesday', conversationId: conv.id })), /30 days ahead/);
  const ok = await tool.run({ what: 'Ask how the plumber visit went', when: 'wednesday 6pm', quote: 'the plumber comes on Wednesday' }, ctx);
  assert.match(String(ok), /Added to her plans: Ask how the plumber visit went/);
  // 2 new a day (the code planner made the first from "My sister visits on Thursday"? no: not an "is on" sentence).
  const made = agenda.store.newByHerSince('2026-11-02T00:00:00Z');
  for (let i = made; i < LIMITS.newPerDay; i++) assert.equal(typeof agenda.addByHer({ kind: 'follow-up', what: `Ask about the visit ${i}`, when: 'thursday 7pm', quote: 'My sister visits on Thursday', conversationId: conv.id }), 'object');
  assert.match(String(agenda.addByHer({ kind: 'follow-up', what: 'One more', when: 'thursday 8pm', quote: 'My sister visits on Thursday', conversationId: conv.id })), /2 new plans today/);
  // 5 open at a time (over the next days).
  for (let d = 1; agenda.store.openByHer() < LIMITS.openByHer; d++) {
    clock.now = new Date(Date.parse(NOW) + d * hours(24));
    agenda.addByHer({ kind: 'follow-up', what: `Ask about the visit, day ${d}`, when: '2026-11-20 18:00', quote: 'My sister visits on Thursday', conversationId: conv.id });
    assert.ok(d < 10);
  }
  clock.now = new Date(Date.parse(NOW) + 9 * hours(24));
  assert.match(String(agenda.addByHer({ kind: 'follow-up', what: 'A sixth', when: '2026-11-20 19:00', quote: 'My sister visits on Thursday', conversationId: conv.id })), /5 open plans/);
  // His own plans are never refused by her limits.
  const his = agenda.addItemByOwner({ what: 'Remind me to call mum', dueAt: new Date('2026-11-21T09:00:00Z') });
  assert.equal(his.createdBy, 'owner');
  // No sub-daily repeats: a goal's check-in is at most daily (anything else falls back to weekly).
  const g = agenda.addGoalByOwner({ title: 'Ship Sara 3.0', checkEvery: '12h' as never });
  assert.equal(g.checkEvery, '7d');
});

test('shared cap: proactive + her plans = 2 a day; quiet hours, min gap and the budget hold before any model call', async (t) => {
  const { app, clock, agenda } = setup(t);
  agenda.update({ enabled: true });
  app.settings.update({ proactive: { enabled: true, maxPerDay: 2, quietStart: 22, quietEnd: 9, minGapHours: 1 } });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'hi');
  const due = (what: string, at: string) => agenda.addItemByOwner({ what, dueAt: new Date(at) });
  due('Plan one', '2026-11-02T12:00:00Z');
  due('Plan two', '2026-11-02T13:00:00Z');
  due('Plan three', '2026-11-02T14:00:00Z');
  // Min gap: he wrote less than an hour ago.
  clock.now = new Date('2026-11-02T10:30:00Z');
  assert.equal((await agenda.tick()).skipped, 'nothing due');
  clock.now = new Date('2026-11-02T12:05:00Z');
  await say(app, conv.id, 'busy day');
  assert.equal((await agenda.tick()).skipped, 'talked recently');
  // One spontaneous message (the old path) counts against the same cap.
  clock.now = new Date('2026-11-02T13:30:00Z');
  const w = new LifeWorker(app, app.life!, app.inner!, () => 0);
  app.script.push(text('Thinking of you, how is the busy day going?'));
  assert.ok((await w.maybeProactive()).proactive);
  await say(app, conv.id, 'fine!');
  clock.now = new Date('2026-11-02T14:40:00Z');
  app.script.push(text('How did plan one go?'));
  const r1 = await agenda.tick();
  assert.equal(r1.sent, 1);
  await say(app, conv.id, 'went well');
  clock.now = new Date('2026-11-02T16:00:00Z');
  const calls = app.requests.length;
  assert.equal((await agenda.tick()).skipped, 'daily limit', '2 in total: 1 proactive + 1 agenda');
  assert.equal(app.requests.length, calls, 'no model call');
  assert.equal((await w.maybeProactive()).skipped, 'daily limit', 'and the proactive path sees the agenda message');
  // Quiet hours (23:30, a plan due at 23:00).
  due('Plan four', '2026-11-02T23:00:00Z');
  clock.now = new Date('2026-11-02T23:30:00Z');
  assert.equal((await agenda.tick()).skipped, 'quiet hours');
  // The budget stops writing before a model call.
  agenda.update({ budgetTokens: 10 });
  clock.now = new Date('2026-11-03T11:50:00Z');
  for (const x of agenda.store.items({ status: ['planned'] })) agenda.editItem(x.id, { dueAt: new Date('2026-11-03T12:00:00Z') });
  clock.now = new Date('2026-11-03T12:10:00Z');
  const before = app.requests.length;
  assert.equal((await agenda.tick()).skipped, 'budget');
  assert.equal(app.requests.length, before, 'no model call when the budget is full');
  const v = agenda.view();
  assert.equal(v.today.maxPerDay, 2);
  assert.ok(v.today.tokens >= 0);
});

test('delivery: meta.agenda.why on the message; his answer marks it done; a missed window moves once then expires', async (t) => {
  const { app, clock, agenda, events } = setup(t);
  agenda.update({ enabled: true });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'Big week: the interview is on Friday.');
  const it = agenda.store.items()[0];
  clock.now = new Date('2026-11-06T19:30:00Z');
  app.script.push(text('Hey, how did the interview go?'));
  const r = await agenda.tick();
  assert.equal(r.sent, 1);
  const msg = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal(msg.content, 'Hey, how did the interview go?');
  assert.deepEqual(msg.meta?.agenda, { itemId: it.id, kind: 'follow-up', by: 'her', why: it.why, quote: it.quote });
  assert.ok(msg.meta?.proactive, 'counts as her texting first (never double-texts)');
  assert.ok(events.some((e) => e.type === 'message' && e.reason === 'proactive'));
  const note = app.requests.at(-1)!.messages.at(-1)!.content as string;
  assert.match(note, /The true reason[\s\S]*the interview is on Friday[\s\S]*Never invent reasons, urgency or feelings/);
  assert.equal(agenda.store.item(it.id)!.status, 'sent');
  assert.equal(agenda.store.ledger('2026-11-06').reachedOut, 1);
  await say(app, conv.id, 'It went great, they want a second round!');
  await agenda.tick();
  assert.equal(agenda.store.item(it.id)!.status, 'done');
  // A missed window: moved to the next day once, then expired (visible on Today).
  const late = agenda.addItemByOwner({ what: 'Ask about the second round', dueAt: new Date('2026-11-07T10:00:00Z') });
  clock.now = new Date('2026-11-07T17:00:00Z'); // the 6-hour window passed
  assert.equal((await agenda.tick()).moved, 1);
  assert.equal(agenda.store.item(late.id)!.dueAt, '2026-11-08T10:00:00.000Z');
  clock.now = new Date('2026-11-08T17:00:00Z');
  assert.equal((await agenda.tick()).expired, 1);
  assert.equal(agenda.store.item(late.id)!.status, 'expired');
  assert.equal(agenda.store.item(late.id)!.note, 'The day was full');
  const today = await buildToday(app);
  assert.deepEqual(today.plans?.expired, [{ id: late.id, what: 'Ask about the second round' }]);
});

test('a check-in: a goal he accepts gets its check-in; his answer becomes a progress note', async (t) => {
  const { app, clock, agenda } = setup(t);
  agenda.update({ enabled: true });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'I really need to finish the garden shed.');
  assert.equal(agenda.store.goals().length, 0, 'once is not a goal');
  clock.now = new Date('2026-11-05T10:00:00Z');
  await say(app, conv.id, 'Ugh, I really need to finish the garden shed this month.');
  const [g] = agenda.store.goals();
  assert.equal(g.status, 'proposed', 'a proposal card, never active on its own');
  assert.equal(g.title, 'Finish the garden shed this month');
  assert.match(g.why, /You said “Ugh, I really need to finish the garden shed this month\.” \(and on 2026-11-02: “I really need to finish the garden shed\.”\)/);
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && (m.meta?.agenda as { goalId?: number } | undefined)?.goalId === g.id));
  assert.equal(agenda.store.items({ goalId: g.id }).length, 0);
  agenda.decideGoal(g.id, 'use', { checkEvery: '1d' });
  const ci = agenda.store.items({ goalId: g.id })[0];
  assert.equal(ci.kind, 'check-in');
  assert.equal(ci.dueAt, '2026-11-06T18:00:00.000Z');
  assert.match(ci.why, /Your goal “Finish the garden shed this month”: you said/);
  clock.now = new Date('2026-11-06T18:10:00Z');
  app.script.push(text('How is the shed coming along?'));
  assert.equal((await agenda.tick()).sent, 1);
  await say(app, conv.id, 'Roof is on, walls next weekend.');
  await agenda.tick();
  const g2 = agenda.store.goal(g.id)!;
  assert.equal(g2.notes.at(-1)!.text, 'Roof is on, walls next weekend.');
  assert.equal(agenda.store.items({ goalId: g.id, status: ['planned'] }).length, 1, 'the next check-in');
  // Never about weight, eating, medication or self-harm on her own.
  await say(app, conv.id, 'I really need to lose 10 pounds.');
  clock.now = new Date('2026-11-07T10:00:00Z');
  await say(app, conv.id, 'I really need to lose 10 pounds, seriously.');
  assert.ok(!agenda.store.goals().some((x) => /pounds/.test(x.title)));
  assert.match(String(agenda.proposeGoalByHer({ title: 'Take my meds every day', quote: 'I really need to lose 10 pounds', conversationId: conv.id })), /never set goals about weight/);
  // "help me keep at this" proposes from what he said just before.
  await say(app, conv.id, 'I want to learn to play the piano.');
  await say(app, conv.id, 'Help me keep at this, ok?');
  assert.ok(agenda.store.goals().some((x) => x.title === 'Learn to play the piano' && x.status === 'proposed'));
  agenda.decideGoal(agenda.store.goals().find((x) => x.title === 'Learn to play the piano')!.id, 'never');
  assert.equal(agenda.store.goals().find((x) => x.title === 'Learn to play the piano')!.status, 'dropped');
});

test('editing on Today: time, text, cancel; off pauses everything (and aborts a running call), on restores', async (t) => {
  const { app, clock, agenda } = setup(t);
  agenda.update({ enabled: true });
  const conv = app.store.createConversation();
  await say(app, conv.id, 'Big week: the interview is on Friday.');
  const it = agenda.store.items()[0];
  const e1 = agenda.editItem(it.id, { dueAt: new Date('2026-11-06T20:30:00Z'), what: 'Ask how the interview with Acme went' })!;
  assert.equal(e1.dueAt, '2026-11-06T20:30:00.000Z');
  assert.equal(e1.what, 'Ask how the interview with Acme went');
  assert.equal(e1.edited, true);
  assert.equal(e1.createdBy, 'owner', 'edited items are his and kept');
  assert.throws(() => agenda.editItem(it.id, { dueAt: new Date('2026-10-01T10:00:00Z') }), /still to come/);
  const other = agenda.addItemByOwner({ what: 'Ask about the trip', dueAt: new Date('2026-11-04T18:00:00Z') });
  agenda.editItem(other.id, { cancel: true });
  assert.equal(agenda.store.item(other.id)!.status, 'cancelled');
  // Off: planned items are listed as paused; nothing is sent; on again they come back.
  agenda.update({ enabled: false });
  assert.equal(agenda.store.item(it.id)!.status, 'paused');
  clock.now = new Date('2026-11-06T21:00:00Z');
  assert.deepEqual(await agenda.tick(), { skipped: 'off' });
  agenda.update({ enabled: true });
  assert.equal(agenda.store.item(it.id)!.status, 'planned');
  // The off switch stops a call that is already running: nothing is posted.
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  app.providerFactory = (config) => ({
    config,
    listModels: async () => [],
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      started();
      await new Promise((_r, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      yield { type: 'text', text: 'never' };
    },
  });
  const tick = agenda.tick();
  await running;
  agenda.stop();
  const r = await tick;
  assert.equal(r.skipped, 'stopped');
  assert.equal(agenda.enabled(), false);
  assert.ok(!app.store.messages(conv.id).some((m) => m.content === 'never'));
  assert.equal(agenda.store.item(it.id)!.status, 'paused');
  // Clear her plans.
  agenda.update({ enabled: true });
  assert.equal(agenda.clearAll(), 1);
  assert.equal(agenda.store.items({ status: ['planned', 'paused'] }).length, 0);
});

test('crisis pause: after a crisis-flagged turn only one gentle check-in within 48 h', async (t) => {
  const { app, clock, agenda } = setup(t);
  agenda.update({ enabled: true });
  app.settings.update({ proactive: { enabled: true, maxPerDay: 5, quietStart: 22, quietEnd: 9, minGapHours: 1 } });
  const conv = app.store.createConversation();
  agenda.addItemByOwner({ what: 'Ask about the trip', dueAt: new Date('2026-11-02T14:00:00Z') });
  agenda.addItemByOwner({ what: 'Ask about the dinner', dueAt: new Date('2026-11-02T18:00:00Z') });
  await say(app, conv.id, "I don't want to be alive anymore", "I'm really glad you told me.");
  assert.ok(agenda.crisisPauseUntil(), 'crisis-flagged');
  clock.now = new Date('2026-11-02T14:30:00Z');
  app.script.push(text("Just thinking of you. I'm here whenever you want to talk."));
  const r = await agenda.tick();
  assert.equal(r.sent, 1);
  const msgs = app.store.messages(conv.id);
  const gentle = msgs.filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((gentle.meta?.agenda as { kind: string }).kind, 'gentle');
  assert.match(app.requests.at(-1)!.messages.at(-1)!.content as string, /gentle, short check-in[\s\S]*no plans, goals or reminders/);
  assert.ok(msgs.at(-1)!.content.startsWith('crisis:'), 'the crisis resources follow it');
  await say(app, conv.id, 'thanks');
  clock.now = new Date('2026-11-02T18:30:00Z');
  const calls = app.requests.length;
  assert.equal((await agenda.tick()).skipped, 'crisis pause');
  assert.equal(app.requests.length, calls);
  // The planned items wait (nothing expires during the pause).
  assert.equal(agenda.store.items({ status: ['planned'] }).length, 2);
  // After 48 h her plans carry on (the missed ones move once).
  clock.now = new Date('2026-11-04T18:30:00Z');
  const after = await agenda.tick();
  assert.ok((after.moved ?? 0) >= 1 || after.sent === 1, JSON.stringify(after));
});

test('never from outside: other apps, agents, webhooks, partner, private and group chats feed nothing and get no agenda tools', async (t) => {
  const { app, agenda } = setup(t);
  agenda.update({ enabled: true });
  for (const c of [
    app.store.createConversation({ channel: 'webhook' }),
    app.store.createConversation({ channel: 'a2a' }),
    app.store.createConversation({ channel: 'api' }),
    app.store.createConversation({ channel: 'group' }),
    app.store.createConversation({ channel: 'telegram', partner: 'Jamie' }),
    app.store.createConversation({ private: true }),
  ]) assert.equal(feedsAgenda(c), false, `${c.channel}${c.partner ? ' partner' : ''}${c.private ? ' private' : ''}`);
  assert.equal(feedsAgenda(app.store.createConversation()), true);
  const priv = app.store.createConversation({ private: true });
  await say(app, priv.id, 'The interview is on Friday.');
  assert.equal(agenda.store.items().length, 0, 'a private chat never feeds her plans');
  const conv = app.store.createConversation();
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, conv.id, 'The interview is on Friday.', new AbortController().signal, { externalApp: true })) void _;
  assert.ok(!(app.requests.at(-1)!.tools ?? []).some((x) => AGENDA_TOOLS.has(x.name)), 'no agenda tools for another app');
  assert.equal(agenda.store.items().length, 0, "another app's turn plans nothing");
  await say(app, conv.id, 'hello');
  assert.ok((app.requests.at(-1)!.tools ?? []).some((x) => x.name === 'agenda_add'), 'in his own chat she has them');
});

test('routes: settings, the off switch, the tick, edits and proposals; members have their own; never the demo', async (t) => {
  const { app, dir, agenda } = setup(t);
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  let r = await api('GET', '/agenda');
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.enabled, false);
  assert.equal(r.json.today.maxPerDay, 2);
  r = await api('PUT', '/agenda', { enabled: true, budgetTokens: 20000, shared: { maxPerDay: 1, minGapHours: 3 } });
  assert.equal(r.json.settings.enabled, true);
  assert.equal(r.json.settings.budgetTokens, 20000);
  assert.equal(r.json.shared.maxPerDay, 1);
  assert.equal(app.settings.get().proactive?.maxPerDay, 1, 'shared with her proactive messages');
  r = await api('POST', '/agenda/items', { what: 'Ask how the run went', dueAt: '2026-11-03T18:00:00Z' });
  assert.equal(r.status, 201);
  const id = r.json.item.id;
  assert.equal((await api('POST', '/agenda/items', { what: 'Too late', dueAt: '2026-10-01T18:00:00Z' })).status, 400);
  r = await api('PUT', `/agenda/items/${id}`, { dueAt: '2026-11-03T19:00:00Z', what: 'Ask how the 10k went' });
  assert.equal(r.json.item.what, 'Ask how the 10k went');
  r = await api('POST', '/agenda/goals', { title: 'Run a 10k in April', checkEvery: '7d', endsOn: '2027-04-30' });
  assert.equal(r.status, 201);
  const gid = r.json.goal.id;
  assert.equal((await api('PUT', `/agenda/goals/${gid}`, { status: 'paused' })).json.goal.status, 'paused');
  r = await api('POST', '/agenda/tick', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.result);
  r = await api('POST', '/agenda/off', {});
  assert.equal(r.json.settings.enabled, false);
  assert.ok(r.json.items.every((x: { status: string }) => x.status === 'paused'));
  assert.equal((await api('PUT', `/agenda/items/${id}`, { cancel: true })).json.item.status, 'cancelled');
  assert.equal((await api('POST', '/agenda/goals/999/decide', { decision: 'use' })).status, 404);
  assert.equal((await api('POST', '/agenda/clear', {})).status, 200);
  // Today's tile appears with proposals or while she keeps plans.
  agenda.update({ enabled: true });
  assert.ok((await buildToday(app)).plans);
  // Members use their own agenda (a member route family); the demo never has one.
  assert.ok(MEMBER_ROUTES.has('agenda'));
  const demo = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((res) => demo.listen(0, '127.0.0.1', res));
  t.after(() => new Promise<void>((res) => demo.close(() => res())));
  const dres = await fetch(`http://127.0.0.1:${(demo.address() as AddressInfo).port}/api/agenda`);
  assert.notEqual(dres.status, 200);
});

test('a member\'s budget sits inside their MemberLimits', (t) => {
  const { app, agenda } = setup(t);
  agenda.update({ enabled: true, budgetUsd: 0.5 });
  (app as { member?: unknown }).member = { limits: () => ({ models: [], messagesPerDay: 0, costPerDay: 0.05, voice: false, pictures: false }) };
  assert.equal(agenda.settings().budgetUsd, 0.05);
});

test('the page: the Her plans tab and tile, the why line, tips, the off switch, the service worker, the eval script', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /data-tab="agenda"/);
  assert.match(html, /id="td-plans"/);
  assert.match(html, /id="ag-switch"[^>]*role="switch"/);
  for (const id of ['ag-goals', 'ag-follow', 'ag-research', 'ag-max', 'ag-gap', 'ag-qs', 'ag-qe', 'ag-tokens', 'ag-usd']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(!/style="/.test(html.slice(html.indexOf('data-panel="agenda"'), html.indexOf('data-panel="agenda"') + 8000)), 'no inline styles');
  const js = readFileSync(join(ROOT, 'web', 'agenda.js'), 'utf8');
  assert.match(js, /Why I'm writing: \{why\}/);
  assert.match(js, /proposalCard/);
  assert.match(readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8'), /caches\.open\('sara-shell-v3[7-9]'\)[\s\S]*sara-shell-v36 from Phase 102/);
  assert.ok(existsSync(join(ROOT, 'scripts', 'eval-agenda.ts')));
  assert.ok(existsSync(join(ROOT, 'docs', 'AGENDA.md')));
});

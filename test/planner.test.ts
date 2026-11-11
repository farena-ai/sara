// Phase 3.7: projects/tasks/notes/reminders, time parsing, scheduler delivery, receipts, API.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import type { HubEvent } from '../src/events.ts';
import { dayStartUtc, nextOccurrence, parseWhen, zonedParts } from '../src/planner.ts';
import { checkClaims } from '../src/receipts.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { createSaraServer } from '../src/server.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const TZ = 'America/Chicago';
// Saturday 2026-10-24 15:00 in Chicago (CDT, UTC-5).
const NOW = new Date('2026-10-24T20:00:00Z');

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: TZ });
  return { app, clock };
}

async function drain(app: TestApp, convId: string, msg: string): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg)) out.push(ev);
  return out;
}

const local = (d: Date | null) => {
  assert.ok(d, 'parsed');
  const p = zonedParts(d!, TZ);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

test('parseWhen: the ways people and models write times, in the owner zone', () => {
  const w = (s: string) => local(parseWhen(s, NOW, TZ));
  assert.equal(w('in 20 minutes'), '2026-10-24 15:20');
  assert.equal(w('in an hour'), '2026-10-24 16:00');
  assert.equal(w('in 2 days'), '2026-10-26 15:00');
  assert.equal(w('2026-10-25 09:30'), '2026-10-25 09:30');
  assert.equal(w('2026-10-25T09:30'), '2026-10-25 09:30');
  assert.equal(w('2026-10-25'), '2026-10-25 09:00');
  assert.equal(w('tomorrow 9am'), '2026-10-25 09:00');
  assert.equal(w('tomorrow at 9:15 pm'), '2026-10-25 21:15');
  assert.equal(w('today at 17:30'), '2026-10-24 17:30');
  assert.equal(w('tonight'), '2026-10-24 20:00');
  assert.equal(w('tonight at 9'), '2026-10-24 21:00');
  assert.equal(w('friday 3pm'), '2026-10-30 15:00');
  assert.equal(w('saturday'), '2026-10-31 09:00', 'same weekday means next week');
  assert.equal(w('9am'), '2026-10-25 09:00', 'a time already past today means tomorrow');
  assert.equal(w('noon'), '2026-10-25 12:00');
  assert.equal(parseWhen('2026-10-25T14:00:00Z', NOW, TZ)!.toISOString(), '2026-10-25T14:00:00.000Z');
  // DST: Nov 1 2026 Chicago falls back to CST (UTC-6).
  assert.equal(parseWhen('2026-11-02 09:00', NOW, TZ)!.toISOString(), '2026-11-02T15:00:00.000Z');
  for (const bad of ['someday', 'banana', '25:00', '']) assert.equal(parseWhen(bad, NOW, TZ), null, bad);
});

test('nextOccurrence keeps the wall-clock time across DST, skips weekends, clamps month ends', () => {
  const at = (s: string) => parseWhen(s, NOW, TZ)!.toISOString();
  assert.equal(local(nextOccurrence(at('2026-10-31 08:00'), 'daily', new Date(at('2026-10-31 08:00')), TZ)), '2026-11-01 08:00');
  assert.equal(local(nextOccurrence(at('2026-10-31 08:00'), 'daily', new Date(at('2026-11-01 08:00')), TZ)), '2026-11-02 08:00');
  assert.equal(local(nextOccurrence(at('2026-10-30 08:00'), 'weekdays', new Date(at('2026-10-30 08:00')), TZ)), '2026-11-02 08:00');
  assert.equal(local(nextOccurrence(at('2026-10-24 10:00'), 'weekly', new Date(at('2026-10-24 10:00')), TZ)), '2026-10-31 10:00');
  assert.equal(local(nextOccurrence(at('2027-01-31 10:00'), 'monthly', new Date(at('2027-01-31 10:00')), TZ)), '2027-02-28 10:00');
  assert.equal(nextOccurrence(at('2026-10-24 10:00'), 'none', NOW, TZ), null);
  // Catches up past several missed occurrences in one step.
  assert.equal(local(nextOccurrence(at('2026-10-20 07:00'), 'daily', NOW, TZ)), '2026-10-25 07:00');
});

test('Sara uses todo/note/remind; tool output reports exact local times; agenda reaches the prompt', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push(
    [
      call('a', 'todo', { action: 'add', title: 'Fix radar loop', project: 'SunnyWeather', due: 'tomorrow 5pm', priority: 'high' }),
      call('b', 'remind', { action: 'set', text: 'call the accountant', when: 'in 20 minutes' }),
      call('c', 'note', { action: 'save', title: 'Radar ideas', body: 'Try frame interpolation and a 10 minute step.', project: 'SunnyWeather' }),
    ],
    text("Done: task added, reminder set for 3:20 PM, and I wrote down your radar ideas."),
  );
  const evs = await drain(app, conv.id, 'add the radar task, remind me to call the accountant in 20 min, and note my radar ideas');
  const results = evs.filter((e) => e.type === 'tool_result').map((e) => (e.type === 'tool_result' ? e.output : ''));
  assert.match(results[0], /Added task #1 \[ \] Fix radar loop \(high\) — due Sun, Oct 25, 2026, 5:00 PM in project "SunnyWeather"/);
  assert.match(results[1], /Reminder #1 set for Sat, Oct 24, 2026, 3:20 PM: "call the accountant"/);
  assert.match(results[2], /Saved note #1 "Radar ideas" \(SunnyWeather\)/);
  assert.ok(!evs.some((e) => e.type === 'claim_check'), 'claims are backed by receipts');
  assert.equal(app.planner!.reminder(1)!.conversationId, conv.id);

  app.script.push(text('ok'));
  await drain(app, conv.id, 'thanks');
  const sys = app.requests.at(-1)!.messages[0].content as string;
  assert.match(sys, /## Keeping track of things[\s\S]*task #1 "Fix radar loop" \(SunnyWeather\): due Sun, Oct 25[\s\S]*reminder #1 "call the accountant"/);

  app.script.push([call('l', 'todo', { action: 'list' }), call('s', 'note', { action: 'search', query: 'interpolation' })], [call('d', 'todo', { action: 'done', id: 1 })], text('Checked it off.'));
  const evs2 = await drain(app, conv.id, 'what is on my list?');
  const out2 = evs2.filter((e) => e.type === 'tool_result').map((e) => (e.type === 'tool_result' ? e.output : ''));
  assert.match(out2[0], /SunnyWeather:\n {2}#1 \[ \] Fix radar loop/);
  assert.match(out2[1], /#1 "Radar ideas"/);
  assert.match(out2[2], /Completed #1 \[x\]/);
  assert.equal(app.planner!.task(1)!.status, 'done');

  app.script.push([call('x', 'remind', { action: 'set', text: 'past', when: '2020-01-01 09:00' })], text('That time is past.'));
  const evs3 = await drain(app, conv.id, 'remind me in 2020');
  assert.match(JSON.stringify(evs3), /is in the past/);
});

test('receipts: "I\'ll remind you" / "added to your list" without the tool are flagged', () => {
  assert.equal(checkClaims("Sure thing, I'll remind you tomorrow at 9.", [])[0]?.kind, 'remind');
  assert.equal(checkClaims('Your reminder is set for 9am.', [])[0]?.kind, 'remind');
  assert.equal(checkClaims("I've added that to your to-do list.", [])[0]?.kind, 'planner');
  assert.deepEqual(checkClaims("I'll remind you tomorrow at 9.", [{ name: 'remind', status: 'ok', args: { action: 'set' }, output: 'Reminder #1 set' }]), []);
  assert.deepEqual(checkClaims("I've added that to your to-do list.", [{ name: 'todo', status: 'ok', args: { action: 'add' }, output: 'Added task #1' }]), []);
  assert.deepEqual(checkClaims('Want me to remind you?', []), []);
  assert.deepEqual(checkClaims("I already set a reminder for that earlier.", []), []);
});

test('scheduler: delivers due reminders into their chat, repeats, skips busy chats, reports late ones', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  const events: HubEvent[] = [];
  app.events!.subscribe((e) => events.push(e));
  const pl = app.planner!;
  pl.addReminder({ text: 'stretch', dueAt: new Date(NOW.getTime() + 60_000).toISOString(), conversationId: conv.id });
  pl.addReminder({ text: 'vitamins', dueAt: new Date(NOW.getTime() + 60_000).toISOString(), repeat: 'daily', conversationId: conv.id });
  const sched = new ReminderScheduler(app, pl);
  assert.equal(sched.tick(), 0, 'not due yet');
  clock.now = new Date(NOW.getTime() + 61_000);
  let busy = true;
  app.isBusy = () => busy;
  assert.equal(sched.tick(), 0, 'waits while Sara is mid-turn');
  busy = false;
  assert.equal(sched.tick(), 2);
  const msgs = app.store.messages(conv.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['assistant', 'Reminder: stretch'], ['assistant', 'Reminder: vitamins']]);
  assert.equal(pl.reminder(1)!.status, 'sent');
  assert.equal(pl.reminder(2)!.status, 'pending');
  assert.equal(local(new Date(pl.reminder(2)!.dueAt)), '2026-10-25 15:01', 'daily repeat moved to tomorrow');
  assert.equal(events.filter((e) => e.type === 'message').length, 2);
  // Sara sees she reminded him (assistant history).
  app.script.push(text('Did you stretch?'));
  await drain(app, conv.id, 'hi');
  assert.match(JSON.stringify(app.requests.at(-1)!.messages), /Reminder: stretch/);
  // Late delivery (server was off for a day) is marked late; deleted conversation falls back.
  pl.addReminder({ text: 'old one', dueAt: new Date(NOW.getTime() - 86_400_000).toISOString(), conversationId: 'gone' });
  sched.tick();
  assert.match(app.store.messages(conv.id).at(-1)!.content, /Reminder: old one \(this was due .*sorry it's late\)/);
});

test('planner API: tasks, projects, reminders, notes, events stream', async (t) => {
  const { app } = setup(t);
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const j = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };

  // Events stream receives a planner change.
  const ac = new AbortController();
  t.after(() => ac.abort());
  const es = await fetch(`${base}/events`, { headers: H, signal: ac.signal });
  assert.equal(es.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = es.body!.getReader();
  const got = (async () => {
    let buf = '';
    while (!buf.includes('event: planner')) buf += new TextDecoder().decode((await reader.read()).value);
    return buf;
  })();

  const task = await j('/tasks', 'POST', { title: 'Buy brisket', project: 'BBQ', due: '2026-10-25', priority: 'high' });
  assert.equal(task.status, 201);
  assert.equal(local(new Date(task.body.dueAt)), '2026-10-25 17:00', 'date-only task due = 5 pm');
  assert.match(await got, /"what":"tasks"/);
  assert.equal((await j(`/tasks/${task.body.id}`, 'PATCH', { status: 'done' })).body.status, 'done');
  assert.equal((await j('/tasks', 'POST', { title: '' })).status, 400);
  assert.equal((await j('/tasks', 'POST', { title: 'x', due: 'whenever' })).status, 400);

  const rem = await j('/reminders', 'POST', { text: 'Check smoker', when: '2026-10-24T18:30', repeat: 'none' });
  assert.equal(rem.status, 201);
  assert.equal(local(new Date(rem.body.dueAt)), '2026-10-24 18:30', 'datetime-local input is owner local time');
  assert.equal((await j('/reminders', 'POST', { text: 'x', when: 'tomorrow', repeat: 'hourly' })).status, 400);

  const note = await j('/notes', 'POST', { title: 'Rub', body: 'Salt, pepper, garlic.' });
  assert.equal((await j('/notes?q=garlic')).body[0].id, note.body.id);
  assert.equal((await j(`/notes/${note.body.id}`, 'PATCH', { body: 'Salt and pepper only.' })).body.body, 'Salt and pepper only.');
  // 3.4.2: earlier versions, and Restore.
  const vers = await j(`/notes/${note.body.id}/versions`);
  assert.equal(vers.status, 200);
  assert.equal(vers.body.length, 1);
  assert.equal(vers.body[0].body, 'Salt, pepper, garlic.');
  const restored = await j(`/notes/${note.body.id}/restore`, 'POST', { version: vers.body[0].id });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.body, 'Salt, pepper, garlic.');
  assert.equal((await j(`/notes/${note.body.id}/restore`, 'POST', { version: 9999 })).status, 404);
  assert.equal((await j('/notes/9999/versions')).body.length, 0);

  const all = await j('/planner');
  assert.equal(all.body.projects[0].name, 'BBQ');
  assert.equal(all.body.tasks.length, 1);
  assert.equal(all.body.reminders.length, 1);
  assert.equal((await j(`/reminders/${rem.body.id}`, 'DELETE')).status, 200);
  assert.equal((await j(`/reminders/${rem.body.id}`, 'DELETE')).status, 404);
  assert.equal((await j(`/projects/${all.body.projects[0].id}`, 'PATCH', { status: 'archived' })).body.status, 'archived');
  assert.equal((await j(`/notes/${note.body.id}`, 'DELETE')).status, 200);
});

test('monthly reminders keep their day: the 31st goes to Feb 28 and back to Mar 31 (not the 28th for ever)', () => {
  const tz = 'America/Chicago';
  let due = new Date('2027-01-31T15:00:00Z'); // 9:00 in Chicago
  const anchor = 31;
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    due = nextOccurrence(due.toISOString(), 'monthly', due, tz, anchor)!;
    seen.push(due.toISOString().slice(0, 10));
  }
  assert.deepEqual(seen, ['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
});

test('Today and follow-ups use the owner\'s midnight, wherever the server is', () => {
  assert.equal(dayStartUtc('2026-10-26', 'America/Chicago').toISOString(), '2026-10-26T05:00:00.000Z');
  assert.equal(dayStartUtc('2026-11-01', 'America/Chicago').toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(dayStartUtc('2026-11-02', 'America/Chicago').toISOString(), '2026-11-02T06:00:00.000Z', 'after the clocks go back');
  assert.equal(dayStartUtc('2026-10-26', 'Asia/Tokyo').toISOString(), '2026-10-25T15:00:00.000Z');
});

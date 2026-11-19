// W1.2 (docs/NUDGES.md): one polite daily budget for everything she sends on her own. Each feature
// asks the gate with a value and an urgency; the gate ranks by value, honors quiet hours (urgent
// safety and reminders the person set are exempt), bundles smaller things into one digest, and
// "Fewer like this" lowers that kind's score for this person.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { askNudge, fewerLikeThis, nudgeState, nudgeTick, noteNudgeReminder, nudgeKindOfReminder, saveNudgePrefs, moreLikeThis, NUDGE_DEFAULTS } from '../src/nudges.ts';
import { postAlert } from '../src/destinations.ts';
import { PlannerStore } from '../src/planner.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (...p: string[]) => readFileSync([ROOT, ...p].join('/'), 'utf8');

function rig(t: TestContext, at = '2026-11-19T15:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(at) };
  const app = makeApp(dir, clock);
  // Quiet hours 22–9 (the Texting first defaults), UTC so local hours are easy to read.
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  app.planner = new PlannerStore(app.store.db, () => clock.now);
  app.push = { notifyOwner: async () => undefined } as never;
  const chat = app.store.createConversation({ channel: 'web', title: 'Evening chat' });
  app.store.addMessage(chat.id, 'user', 'hi');
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, chat };
}

test('W1.2 budget: normal nudges stop at the daily budget and the rest wait for the digest', (t) => {
  const { app } = rig(t);
  saveNudgePrefs(app, { budget: 2 });
  const a = askNudge(app, { kind: 'money', value: 0.9, text: 'one' });
  const b = askNudge(app, { kind: 'money', value: 0.9, text: 'two' });
  const c = askNudge(app, { kind: 'money', value: 0.9, text: 'three' });
  assert.equal(a.send, true);
  assert.equal(b.send, true);
  assert.equal(c.send, false);
  assert.equal(c.held, 'budget');
  const s = nudgeState(app);
  assert.equal(s.today.sent, 2);
  assert.equal(s.today.budget, 2);
  assert.deepEqual(s.held.map((h) => h.text), ['three']);
  // The why line is a translatable key with params.
  assert.match(a.why.key, /\{n\} of \{budget\}/);
  assert.equal(a.why.params.n, 1);
});

test('W1.2 ranking: as the budget fills, only higher-value nudges get through; low ones always wait', (t) => {
  const { app } = rig(t);
  saveNudgePrefs(app, { budget: 4 });
  assert.equal(askNudge(app, { kind: 'workforce', value: 0.2, text: 'small' }).held, 'low');
  assert.equal(askNudge(app, { kind: 'money', value: 0.5, text: 'a' }).send, true);
  assert.equal(askNudge(app, { kind: 'money', value: 0.5, text: 'b' }).send, true);
  // Half the budget used: the bar rose above 0.5.
  const mid = askNudge(app, { kind: 'money', value: 0.5, text: 'c' });
  assert.equal(mid.send, false);
  assert.equal(mid.held, 'budget');
  assert.equal(askNudge(app, { kind: 'renewals', value: 0.95, text: 'passport' }).send, true);
  // Budget 0 = everything that isn't urgent goes to the digest.
  saveNudgePrefs(app, { budget: 0 });
  assert.equal(askNudge(app, { kind: 'renewals', value: 1, text: 'x' }).held, 'budget');
});

test('W1.2 quiet hours: normal nudges wait, safety and reminders the person set are exempt', (t) => {
  const { app } = rig(t, '2026-11-19T23:30:00Z');
  const q = askNudge(app, { kind: 'money', value: 0.9, text: 'trial ends' });
  assert.equal(q.send, false);
  assert.equal(q.held, 'quiet');
  const s = askNudge(app, { kind: 'legacy', value: 0.5, urgency: 'safety', text: 'someone asked for access' });
  assert.equal(s.send, true);
  assert.match(s.why.key, /[Ss]afety/);
  const r = askNudge(app, { kind: 'briefing', value: 0.5, urgency: 'reminder', text: 'your briefing' });
  assert.equal(r.send, true);
  // Exempt ones never use up the budget.
  saveNudgePrefs(app, { budget: 1 });
  for (let i = 0; i < 3; i++) assert.equal(askNudge(app, { kind: 'legacy', value: 0.1, urgency: 'safety', text: `s${i}` }).send, true);
  assert.equal(nudgeState(app).today.sent, 0);
});

test('W1.2 learning: Fewer like this lowers that kind for this person only, and can be undone', (t) => {
  const { app } = rig(t);
  const other = rig(t).app;
  assert.equal(askNudge(app, { kind: 'workforce', value: 0.45, text: 'w1' }).send, true);
  fewerLikeThis(app, 'workforce');
  const after = askNudge(app, { kind: 'workforce', value: 0.45, text: 'w2' });
  assert.equal(after.send, false);
  assert.equal(after.held, 'low');
  assert.ok(nudgeState(app).kinds.find((k) => k.kind === 'workforce')!.weight < 1);
  // Other kinds and other people are untouched.
  assert.equal(askNudge(app, { kind: 'money', value: 0.45, text: 'm' }).send, true);
  assert.equal(askNudge(other, { kind: 'workforce', value: 0.45, text: 'w' }).send, true);
  // Repeated taps keep lowering, with a floor; More like this puts it back.
  for (let i = 0; i < 10; i++) fewerLikeThis(app, 'workforce');
  assert.ok(nudgeState(app).kinds.find((k) => k.kind === 'workforce')!.weight >= 0.1);
  moreLikeThis(app, 'workforce');
  assert.equal(nudgeState(app).kinds.find((k) => k.kind === 'workforce'), undefined);
  // Safety is never lowered below sending.
  fewerLikeThis(app, 'legacy');
  assert.equal(askNudge(app, { kind: 'legacy', value: 0.2, urgency: 'safety', text: 's' }).send, true);
});

test('W1.2 digest: held nudges arrive once, together, ranked by value, after quiet hours', (t) => {
  const { app, clock } = rig(t, '2026-11-19T23:00:00Z');
  askNudge(app, { kind: 'money', value: 0.4, text: 'Hulu price goes up' });
  askNudge(app, { kind: 'renewals', value: 0.9, text: 'Passport renewal soon' });
  assert.equal(nudgeTick(app), undefined, 'still quiet');
  clock.now = new Date('2026-11-20T10:00:00Z');
  assert.equal(nudgeTick(app), undefined, 'before the digest hour');
  clock.now = new Date(`2026-11-20T${String(NUDGE_DEFAULTS.digestHour).padStart(2, '0')}:05:00Z`);
  const conv = nudgeTick(app);
  assert.ok(conv);
  const msg = app.store.messages(conv!).at(-1)!;
  assert.ok(msg.content.indexOf('Passport') < msg.content.indexOf('Hulu'), 'ranked by value');
  assert.equal((msg.meta?.nudge as { kind: string }).kind, 'digest');
  assert.equal(nudgeState(app).held.length, 0);
  assert.equal(nudgeTick(app), undefined, 'only once');
});

test('W1.2 postAlert asks the gate for proactive posts and tags sent ones with a why line', (t) => {
  const { app } = rig(t);
  saveNudgePrefs(app, { budget: 1 });
  const c1 = postAlert(app, 'money', { role: 'assistant', reason: 'proactive', content: 'Trial ends Friday', nudge: { value: 0.8 } });
  assert.ok(c1);
  const m = app.store.messages(c1!).at(-1)!;
  assert.equal((m.meta?.nudge as { kind: string }).kind, 'money');
  assert.ok((m.meta?.nudge as { why: { key: string } }).why.key);
  const before = app.store.messages(c1!).length;
  const c2 = postAlert(app, 'money', { role: 'assistant', reason: 'proactive', content: 'Second', nudge: { value: 0.8 } });
  assert.equal(c2, undefined, 'held for the digest');
  assert.equal(app.store.messages(c1!).length, before);
  // Replies and reminders are not nudges.
  assert.ok(postAlert(app, 'money', { role: 'assistant', reason: 'reply', content: 'You asked' }));
});

test('W1.2 reminders she made (renewals, gifts, upkeep) go through the gate; his own never do', (t) => {
  const { app, clock } = rig(t, '2026-11-19T23:30:00Z');
  const sched = new ReminderScheduler(app, app.planner!);
  const mine = app.planner!.addReminder({ text: 'Call mom', dueAt: new Date(clock.now.getTime() - 1000).toISOString() });
  const hers = app.planner!.addReminder({ text: 'Car registration renews in 30 days', dueAt: new Date(clock.now.getTime() - 1000).toISOString() });
  noteNudgeReminder(app, hers.id, 'renewals', 0.7);
  assert.equal(nudgeKindOfReminder(app, hers.id)?.kind, 'renewals');
  sched.tick();
  const all = app.store.listConversations().flatMap((c) => app.store.messages(c.id)).map((m) => m.content);
  assert.ok(all.some((x) => x.includes('Call mom')), 'his reminder is delivered in quiet hours');
  assert.ok(!all.some((x) => x.includes('Car registration')), 'hers waits for the digest');
  assert.equal(nudgeState(app).held[0]?.kind, 'renewals');
  assert.equal(app.planner!.dueReminders(clock.now).length, 0, 'both marked fired');
});

test('W1.2 wiring: features ask the gate, the web shows why + Fewer like this, Settings has the budget', () => {
  for (const f of ['src/renewals.ts', 'src/gifts.ts', 'src/upkeep.ts', 'src/money/hub.ts']) assert.match(read(f), /noteNudgeReminder\(/, f);
  for (const f of ['src/life.ts', 'src/presence.ts', 'src/briefing.ts']) assert.match(read(f), /askNudge\(/, f);
  assert.match(read('src/legacy.ts'), /urgency: 'safety'/);
  assert.match(read('src/reminders.ts'), /nudgeTick\(/);
  const html = read('web/index.html');
  for (const id of ['ndg-budget', 'ndg-hour', 'ndg-today', 'ndg-kinds']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(read('web/app.js'), /nudgeLine\(/);
  assert.match(read('web/nudges.js'), /\/automations\/nudges\/fewer/);
  const tips = JSON.parse(read('web/tips.json')).tips;
  assert.ok(tips['ndg-budget'] && tips['ndg-hour']);
});

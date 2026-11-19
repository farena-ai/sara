// W1.5 (docs/HER_WEEK.md): a weekly "how am I doing" check-in with her. Counts from the action
// timeline, failed tools, claim-check flags and errors, what cost money (usage), and three concrete
// suggestions with a one-tap Accept that applies an existing setting or creates an automation
// (never money, never Always allow). Weekly through the W1.2 nudge gate; on demand in chat.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { herWeekFacts, herWeekPrefs, saveHerWeekPrefs, herWeekTick, herWeekAccept, asksHowAmIDoing, herWeekTurn, SAFE_TIPS } from '../src/her-week.ts';
import { timelineOf } from '../src/timeline.ts';
import { UsageStore } from '../src/usage.ts';
import { automationsFor } from '../src/automations.ts';
import { runTurn } from '../src/chat.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (...p: string[]) => readFileSync([ROOT, ...p].join('/'), 'utf8');

function rig(t: TestContext, at = '2026-11-19T15:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(at) };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  app.push = { notifyOwner: async () => undefined } as never;
  if (!app.usage) app.usage = new UsageStore(app.store.db);
  const chat = app.store.createConversation({ channel: 'web', title: 'Evening chat' });
  app.store.addMessage(chat.id, 'user', 'hi');
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, chat };
}

function seedWeek(app: ReturnType<typeof makeApp>, chatId: string) {
  const tl = timelineOf(app);
  tl.record({ tool: 'planner_add', kind: 'planner', summary: 'Added a to-do' });
  tl.record({ tool: 'planner_add', kind: 'planner', summary: 'Added a to-do' });
  tl.record({ tool: 'mail_send', kind: 'mail', summary: 'Sent a mail' });
  app.store.addMessage(chatId, 'tool', 'boom', { toolCallId: 'a', name: 'web_fetch', status: 'error' });
  app.store.addMessage(chatId, 'tool', 'boom', { toolCallId: 'b', name: 'web_fetch', status: 'error' });
  app.store.addMessage(chatId, 'tool', 'ok', { toolCallId: 'c', name: 'planner_add', status: 'ok' });
  const said = app.store.addMessage(chatId, 'assistant', 'I sent it.');
  app.store.updateMessageMeta(said.id, { unverified: [{ kind: 'mail', problem: 'missing', sentence: 'I sent it.' }] });
  app.store.db.prepare("INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, input, output, cached, usd) VALUES (?, 'cloud', 'Cloud', 'big-model', 'api', 'chat', 1000, 500, 0, ?)").run(app.now().toISOString(), 2.5);
  app.store.db.prepare("INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, input, output, cached, usd) VALUES (?, 'ollama', 'Ollama', 'small', 'local', 'chat', 1000, 500, 0, 0)").run(app.now().toISOString());
}

test('W1.5 facts: what she did, what failed, what cost money', (t) => {
  const { app, chat } = rig(t);
  seedWeek(app, chat.id);
  const f = herWeekFacts(app);
  assert.equal(f.did.actions, 3);
  assert.equal(f.did.byKind.planner, 2);
  assert.equal(f.did.byKind.mail, 1);
  assert.equal(f.did.toolCalls, 3);
  assert.deepEqual(f.failed.tools, [{ name: 'web_fetch', n: 2 }]);
  assert.equal(f.failed.claims, 1);
  assert.equal(f.cost.usd, 2.5);
  assert.equal(f.cost.paidCalls, 1);
  assert.equal(f.cost.localCalls, 1);
  assert.equal(f.cost.topModel, 'big-model');
  assert.ok(f.week.from < f.week.to);
});

test('W1.5 three safe suggestions; Accept applies a setting and Undo puts it back', async (t) => {
  const { app, chat } = rig(t);
  seedWeek(app, chat.id);
  const f = herWeekFacts(app);
  assert.equal(f.tips.length, 3);
  for (const tip of f.tips) assert.ok(SAFE_TIPS.includes(tip.id), tip.id);
  assert.equal(f.tips[0].id, 'saver', 'cost comes first when the week cost money and the saver is off');
  assert.ok(!SAFE_TIPS.some((id) => /money|spend|always|allow|pay|buy/.test(id)));
  const row = herWeekAccept(app, 'saver');
  assert.equal(app.settings.get().tokenSaver?.mode, 'auto');
  assert.equal(row.kind, 'settings');
  assert.ok(row.canRevert);
  await timelineOf(app).revert(row.id, app);
  assert.notEqual(app.settings.get().tokenSaver?.mode, 'auto');
  // On a stored card: Accept marks the idea done, Undo shows it again.
  const card = app.store.addMessage(chat.id, 'assistant', 'check-in', { herWeek: herWeekFacts(app) });
  const id = (card.meta as { herWeek: { tips: { id: string }[] } }).herWeek.tips[0].id;
  const r2 = herWeekAccept(app, id, card.id);
  const tipOf = () => (app.store.messageById(card.id)?.meta as { herWeek: { tips: { id: string; done?: number }[] } }).herWeek.tips.find((x) => x.id === id);
  assert.equal(tipOf()?.done, r2.id);
  await timelineOf(app).revert(r2.id, app);
  assert.equal(tipOf()?.done, undefined);
  // Accepted or turned down, a tip is not offered again for a while.
  herWeekAccept(app, 'saver');
  assert.ok(!herWeekFacts(app).tips.some((x) => x.id === 'saver'));
});

test('W1.5 Accept can create an automation from the gallery (Undo removes it)', async (t) => {
  const { app } = rig(t);
  const before = automationsFor(app).list().length;
  const row = herWeekAccept(app, 'auto-birthdays');
  const list = automationsFor(app).list();
  assert.equal(list.length, before + 1);
  assert.equal(list.at(-1)?.name, 'Birthday reminders');
  await timelineOf(app).revert(row.id, app);
  assert.equal(automationsFor(app).list().length, before);
  assert.throws(() => herWeekAccept(app, 'pay-bills'), /suggestion/);
});

test('W1.5 weekly: first look only remembers the slot; the next slot sends once through the nudge gate', (t) => {
  const { app, clock, chat } = rig(t, '2026-11-19T15:00:00Z'); // Thursday
  seedWeek(app, chat.id);
  saveHerWeekPrefs(app, { on: true, day: 0, time: '17:00' });
  assert.equal(herWeekTick(app), undefined, 'a fresh look never sends an old week');
  clock.now = new Date('2026-11-22T16:59:00Z'); // Sunday, before the time
  assert.equal(herWeekTick(app), undefined);
  clock.now = new Date('2026-11-22T17:05:00Z');
  const conv = herWeekTick(app);
  assert.ok(conv, 'sent');
  const sent = app.store.messages(conv!).filter((m) => m.meta?.herWeek);
  assert.equal(sent.length, 1);
  const meta = sent[0].meta as { herWeek: { tips: unknown[] }; nudge?: { why?: unknown } };
  assert.equal(meta.herWeek.tips.length, 3);
  assert.ok(meta.nudge?.why, 'it went through the W1.2 gate');
  clock.now = new Date('2026-11-22T19:00:00Z');
  assert.equal(herWeekTick(app), undefined, 'once a week');
  saveHerWeekPrefs(app, { on: false });
  clock.now = new Date('2026-11-29T17:05:00Z');
  assert.equal(herWeekTick(app), undefined, 'off means off');
  assert.equal(herWeekPrefs(app).on, false);
});

test('W1.5 "How am I doing?" in six languages, only as the whole message', () => {
  for (const s of ['How am I doing?', 'how are you doing for me', 'Weekly check-in', '¿Cómo lo estoy haciendo?', 'Comment je m’en sors ?', 'Wie mache ich mich?', 'Como estou indo?', 'Come sto andando?', 'Sara, how am I doing?'])
    assert.ok(asksHowAmIDoing(s, 'Sara'), s);
  for (const s of ['How am I doing on my diet?', 'how are you', 'I wonder how am I doing at work, any idea about the meeting next week?']) assert.ok(!asksHowAmIDoing(s, 'Sara'), s);
});

test('W1.5 chat shortcut answers with the card and no model call', async (t) => {
  const { app, chat } = rig(t);
  seedWeek(app, chat.id);
  const out = herWeekTurn(app, 'How am I doing?');
  assert.ok(out && out.meta.herWeek.tips.length === 3 && out.reply.length > 10);
  const conv = app.store.createConversation({ channel: 'web', title: 'Check' });
  let calls = 0;
  const factory = app.providerFactory as unknown as (c: unknown) => unknown;
  app.providerFactory = ((c: unknown) => {
    calls++;
    return factory(c);
  }) as never;
  for await (const _ of runTurn(app, conv.id, 'How am I doing?')) void _;
  const last = app.store.messages(conv.id).at(-1);
  assert.equal(last?.role, 'assistant');
  assert.ok(last?.meta?.herWeek, 'the card rides on her reply');
  assert.equal(calls, 0);
});

test('W1.5 wiring: settings section, tips, card, routes, feed, strings', () => {
  const html = read('web', 'index.html');
  for (const id of ['hw-on', 'hw-day', 'hw-time', 'hw-now']) assert.ok(html.includes(`id="${id}"`), id);
  const tips = JSON.parse(read('web', 'tips.json'));
  for (const id of ['hw-on', 'hw-day', 'hw-time']) assert.ok(tips.tips[id] || html.match(new RegExp(`data-tip="[^"]+"[^>]*>\\?</button>[^<]*<(select|input)[^>]*id="${id}"`)), `tip for ${id}`);
  assert.match(read('web', 'app.js'), /herWeekCard/);
  assert.match(read('src', 'routes', 'automations.ts'), /her-week/);
  assert.match(read('src', 'destinations.ts'), /'herweek'/);
  assert.match(read('src', 'reminders.ts'), /herWeekTick/);
  assert.match(read('src', 'chat.ts'), /herWeekTurn/);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.ok(read('web', 'i18n', `${l}.json`).includes('"Her weekly check-in"'), l);
});

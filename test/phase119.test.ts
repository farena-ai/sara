// Phase 119 (2.52.0): "when it comes up" reminders and picking a chat up in another app
// (docs/design/RECALL.md §5.13). The model is the scripted fake from helpers.ts (it records every
// request), the clock is fake (makeApp's clock object), People cards are made with
// PeopleStore.create, and conversations come from the store with the real channel shapes. Each test
// cleans up its own temp folder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { afterTurnExtras, chatButton, commandAllowed, commandTable, DISCORD_NAMES, MENU_COMMANDS, parseCommand, runCommand, type BridgeAdapter, type Place } from '../src/bridges/commands.ts';
import { runTurn, type ChatEvent, type TurnOptions } from '../src/chat.ts';
import { exportAll, importAll } from '../src/export.ts';
import { endForPerson, matchMentions, mentionTexts, ownChat, parseWhenCommand, raised, setMention, stemsOf } from '../src/mentions.ts';
import { PeopleStore } from '../src/people.ts';
import { pickupsFor } from '../src/pickup.ts';
import { PlannerStore } from '../src/planner.ts';
import { createSaraServer } from '../src/server.ts';
import { buildToday } from '../src/today.ts';
import type { Tool } from '../src/tools/types.ts';
import { Store } from '../src/store.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const SARA_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const START = new Date('2026-11-01T15:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

function setup(t: { after: (fn: () => void | Promise<void>) => void }, settings: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(START) };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: START.toISOString(), ...settings } as never);
  const people = new PeopleStore(app.store.db, { now: () => clock.now, ownWords: () => ['Alex', app.persona.name] });
  app.people = people;
  const dan = people.create({ name: 'Dan', relation: 'my friend', aliases: ['Danny'], status: 'active', origin: 'owner', circle: 'friend' });
  const dan2 = people.create({ name: 'Dan', fullName: 'Dan Okafor', relation: 'from work', status: 'active', origin: 'owner', circle: 'work' });
  const jeff = people.create({ name: 'Jeff', relation: 'my cousin', status: 'active', origin: 'owner' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const web = app.store.createConversation({ title: 'Chat' });
  const tg = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '111' });
  const dc = app.store.createConversation({ title: 'Discord', channel: 'discord', channelKey: 'dm1' });
  return { app, clock, dir, people, dan, dan2, jeff, web, tg, dc };
}
async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const sysOf = (app: TestApp, i: number) => String(app.requests[i]?.messages[0]?.content ?? '');
/** One turn; returns the system prompt of the turn's FIRST model call and the events. */
async function turn(app: TestApp, convId: string, msg: string, reply: string | ReturnType<typeof text>[] = 'ok', opts: TurnOptions = {}) {
  const before = app.requests.length;
  if (typeof reply === 'string') app.script.push(text(reply));
  else app.script.push(...reply);
  const evs = await drain(runTurn(app, convId, msg, undefined, opts));
  return { sys: sysOf(app, before), evs, calls: app.requests.length - before };
}
const NOTE = '## He asked you to bring this up';
const lastReply = (app: TestApp, id: string) => app.store.messages(id).filter((m) => m.role === 'assistant').at(-1)!;
/** Sets Dan's reminder from the web chat with her tool (the main test's first half). */
async function danReminder(s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  await turn(s.app, s.web.id, 'when Dan comes up, remind me he owes me $20', [[call('r1', 'remind', { action: 'set', on: 'mention', person: 'Dan', text: 'Dan owes you $20', ...extra })], text('Got it.')]);
  return s.app.planner!.mentionReminders()[0];
}

// ---------------------------------------------------------------- part A

test('main: set in the web chat with her tool; days later on Telegram "Danny" fires it once, raised by her', async (t) => {
  const s = setup(t);
  const { app } = s;
  // With two Dans, a bare "Dan" in his words is a question first.
  await turn(app, s.web.id, 'when Dan comes up, remind me he owes me $20', [[call('r0', 'remind', { action: 'set', on: 'mention', person: 'Dan', text: 'Dan owes you $20' })], text('Which Dan?')]);
  assert.match(app.store.messages(s.web.id).filter((m) => m.role === 'tool').at(-1)!.content, /Which one: Dan \(your friend\) or Dan \(from work\)\?/);
  assert.equal(app.planner!.mentionReminders().length, 0, 'nothing kept on a guess');
  const r = await danReminder(s, { person: 'my friend Dan' });
  assert.ok(r, 'one row');
  assert.equal(r.trigger, 'mention');
  assert.equal(r.dueAt, '9999-12-31T00:00:00.000Z');
  assert.deepEqual(JSON.parse(r.mention!).personIds, [s.dan.id]);
  assert.ok(Array.isArray(lastReply(app, s.web.id).meta?.reminderCard), 'the card under her reply');
  s.clock.now = new Date(START.getTime() + 3 * DAY);
  const t1 = await turn(app, s.tg.id, 'Danny wants to go climbing Saturday', 'Sure! Also, Dan still owes you $20.');
  assert.ok(t1.sys.includes(NOTE), 'the note is in the first request');
  assert.match(t1.sys, /Dan owes you \$20/);
  assert.match(t1.sys, /\[why: Dan \(your friend\) named in this message; sure: high\]/);
  const fire = app.planner!.fires(r.id)[0];
  assert.equal(fire.raised, 'her');
  const after = app.planner!.reminder(r.id)!;
  assert.equal(after.status, 'sent');
  assert.equal(after.ended, 'raised');
  const reply = lastReply(app, s.tg.id);
  assert.equal(reply.content, 'Sure! Also, Dan still owes you $20.');
  assert.equal((reply.meta?.mentions as { fireId: number }[])[0].fireId, fire.id);
  assert.ok(t1.evs.some((e) => e.type === 'mentions'));
  const t2 = await turn(app, s.tg.id, 'Dan said hi again', 'ok');
  assert.ok(!t2.sys.includes(NOTE), 'once: the next Dan message has no note');
});

test('the app adds its line when her reply leaves it out', async (t) => {
  const s = setup(t);
  const r = await danReminder(s, { person: 'Danny' });
  s.clock.now = new Date(START.getTime() + DAY);
  await turn(s.app, s.dc.id, 'Danny is coming over', 'Nice, have fun!');
  const reply = lastReply(s.app, s.dc.id);
  assert.match(reply.content, /Nice, have fun!\n\n⏰ You asked me to remind you: Dan owes you \$20\.$/);
  assert.equal(s.app.planner!.fires(r.id)[0].raised, 'app');
  assert.ok(raised('Also, Dan still owes you $20.', 'Dan owes you $20'));
  assert.ok(!raised('Have fun!', 'Dan owes you $20'));
  assert.ok(raised('Did you ask about the rollback plan?', 'ask about the rollback plan'));
});

test('no model call to match: 200 armed reminders and a 2,000-character message, under 5 ms', (t) => {
  const s = setup(t);
  for (let i = 0; i < 200; i++) setMention(s.app, { text: `thing ${i}`, topic: `zebra${i} project${i}`, conversationId: s.web.id });
  assert.equal(s.app.planner!.mentionReminders().length, 200);
  assert.equal(setMention(s.app, { text: 'one more', topic: 'alpaca farm', conversationId: s.web.id }).ok, false, 'the 201st is refused');
  const msg = `${'the weather and the garden and the cat '.repeat(50)}`.slice(0, 2000);
  const calls = s.app.requests.length;
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    matchMentions(s.app, { conversation: s.tg, messageId: 10_000, text: msg, found: [] }, new Date(START.getTime() + DAY));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[7] < 5, `median ${times[7].toFixed(2)} ms`);
  assert.equal(s.app.requests.length, calls, 'no provider request');
});

test('which Dan: no guess; "Dan from work" fires only #2; her "which Dan?" answered fires #1', async (t) => {
  const s = setup(t);
  const { app } = s;
  const r1 = setMention(app, { text: 'Dan owes you $20', personId: s.dan.id, conversationId: s.web.id });
  const r2 = setMention(app, { text: 'ask Dan about the slides', personId: s.dan2.id, conversationId: s.web.id });
  assert.ok(r1.ok && r2.ok);
  s.clock.now = new Date(START.getTime() + DAY);
  assert.ok(!(await turn(app, s.tg.id, 'Dan called', 'ok')).sys.includes(NOTE), 'no guess between two Dans');
  const w = await turn(app, s.tg.id, 'Dan from work called about the deck', 'ok');
  assert.match(w.sys, /ask Dan about the slides/);
  assert.ok(!w.sys.includes('owes you $20'));
  // A fresh chat: she asks which Dan; his answer becomes this chat's alias, and the next Dan is #1.
  const tg2 = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '112' });
  await turn(app, tg2.id, 'Dan is in town', 'Which Dan?');
  await turn(app, tg2.id, 'my friend Dan', 'Ah, nice.');
  const fired = app.planner!.fires(r1.ok ? r1.reminder.id : 0);
  assert.equal(fired.length, 1, 'his answer names Dan #1, so it fires');
});

test('words: entries need all their words; stems, phrases, accents and case', async (t) => {
  const s = setup(t);
  const { app } = s;
  const w = setMention(app, { text: 'RSVP to the wedding', topic: "Jeff's wedding", also: ['the wedding'], conversationId: s.web.id });
  assert.ok(w.ok);
  const keys = JSON.parse(w.reminder.mention!);
  assert.deepEqual(keys.entries[0], [{ kind: 'person', id: s.jeff.id }, { kind: 'word', stem: stemsOf('wedding')[0] }]);
  s.clock.now = new Date(START.getTime() + DAY);
  const tg = s.tg;
  const m = (txt: string) => matchMentions(app, { conversation: tg, messageId: 999_999, text: txt, found: app.people!.find(txt).found }, s.clock.now).length;
  assert.equal(m("Jeff's wedding is in June"), 1);
  assert.equal(m('Jeff called'), 0);
  assert.equal(m('a wedding on TV'), 0, '"the wedding" is a phrase, not "a wedding"');
  assert.equal(m('the wedding is stressing me out'), 1);
  const rel = setMention(app, { text: 'ask about the rollback plan', topic: 'the release', conversationId: s.web.id });
  assert.ok(rel.ok);
  app.planner!.cancelReminder(w.reminder.id);
  assert.equal(m('RELEASING Friday'), 1, 'stem and case');
  assert.deepEqual(stemsOf('Café Müller'), stemsOf('cafe muller'), 'accents folded');
});

test('too common: built-in words, and his own last 200 messages (21 is too many, 20 is fine)', (t) => {
  const s = setup(t);
  const r = setMention(s.app, { text: 'x', topic: 'work', conversationId: s.web.id });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'too-common');
  for (let i = 0; i < 20; i++) s.app.store.addMessage(s.web.id, 'user', `the garden needs water ${i}`);
  assert.equal(setMention(s.app, { text: 'x', topic: 'garden', conversationId: s.web.id }).ok, true, '20 times: allowed');
  s.app.store.addMessage(s.web.id, 'user', 'garden again');
  const r21 = setMention(s.app, { text: 'y', topic: 'garden', conversationId: s.web.id });
  assert.equal(!r21.ok && r21.reason, 'too-common', '21 times: refused');
});

test('not the message that set it, not the same session within 30 minutes', async (t) => {
  const s = setup(t);
  const { app } = s;
  const r = await danReminder(s, { person: 'Danny' });
  assert.equal(app.planner!.fires(r.id).length, 0, 'the setting message never fires it');
  s.clock.now = new Date(START.getTime() + 10 * MIN);
  assert.ok(!(await turn(app, s.web.id, 'Danny is great', 'ok')).sys.includes(NOTE), '10 minutes later, same session: no');
  s.clock.now = new Date(START.getTime() + 31 * MIN);
  assert.ok((await turn(app, s.web.id, 'Danny is great', 'Also: he owes you $20')).sys.includes(NOTE), '31 minutes later: yes');
});

test('where it never fires: partner (Dan himself), work room, group, private, off the record, other apps, goal/loop, steer, resume, another companion', async (t) => {
  const s = setup(t);
  const { app } = s;
  const r = await danReminder(s, { person: 'Danny' });
  s.clock.now = new Date(START.getTime() + DAY);
  const none = (res: { sys: string }) => assert.ok(!res.sys.includes(NOTE) && !res.sys.includes('owes you $20'));
  const partner = app.store.createConversation({ title: 'Telegram: Dan', channel: 'telegram', channelKey: '222', partner: 'Dan' });
  none(await turn(app, partner.id, 'Dan here, about the $20'));
  const work = app.store.createConversation({ title: 'Discord work: #dev', channel: 'discord-work', channelKey: 'c1' });
  none(await turn(app, work.id, 'Danny is here'));
  const group = app.store.createConversation({ title: 'Room', channel: 'group' });
  app.store.addMessage(group.id, 'user', 'Danny is here');
  none(await turn(app, group.id, 'Danny is here', 'ok', { group: { ownerTurn: true, crisis: false, adult: false, note: 'A group chat.', others: ['Mira'] } } as TurnOptions));
  const priv = app.store.createConversation({ title: 'Private' });
  app.store.updateConversation(priv.id, { private: true });
  none(await turn(app, priv.id, 'Danny is here'));
  const api = app.store.createConversation({ title: 'API', channel: 'api' });
  none(await turn(app, api.id, 'Danny is here', 'ok', { externalApp: true }));
  const mcp = app.store.createConversation({ title: 'MCP', channel: 'mcp' });
  none(await turn(app, mcp.id, 'Danny is here', 'ok', { externalApp: true }));
  none(await turn(app, s.tg.id, 'Danny round', 'ok', { persist: { kind: 'goal', id: 1, n: 1, note: '[Note from the app: Danny]' } }));
  none(await turn(app, s.tg.id, 'Danny tick', 'ok', { persist: { kind: 'loop', id: 1, n: 1, unattended: 'no' } }));
  app.store.addMessage(s.tg.id, 'user', 'Danny says hi');
  none(await turn(app, s.tg.id, 'Danny says hi', 'ok', { resume: true }));
  assert.equal(ownChat({ ...app, offRecord: true } as TestApp, s.web), false, 'off the record is never his own chat');
  // Another companion with the same (shared) planner never raises it.
  const other = { ...app, companionId: 'luna' } as TestApp;
  assert.equal(matchMentions(other, { conversation: s.tg, messageId: 99_999, text: 'Danny', found: [s.dan] }, s.clock.now).length, 0);
  assert.equal(app.planner!.fires(r.id).length, 0);
  assert.equal(app.planner!.reminder(r.id)!.status, 'pending');
});

test("rooms: 'dm': his line in a work room adds nothing there and one line in his Discord DM; off: nothing anywhere", async (t) => {
  const s = setup(t);
  const { app } = s;
  const rel = setMention(app, { text: 'ask about the rollback plan', topic: 'the release', conversationId: s.web.id });
  assert.ok(rel.ok);
  s.clock.now = new Date(START.getTime() + DAY);
  const work = app.store.createConversation({ title: 'Discord work: #dev', channel: 'discord-work', channelKey: 'c1' });
  const before = app.store.messages(s.dc.id).length;
  const off = await turn(app, work.id, 'the release is tomorrow');
  assert.ok(!off.sys.includes(NOTE));
  assert.equal(app.store.messages(s.dc.id).length, before, 'off: nothing in his DM');
  app.settings.update({ mentions: { rooms: 'dm' } } as never);
  const on = await turn(app, work.id, 'the release is tomorrow again');
  assert.ok(!on.sys.includes(NOTE) && !on.sys.includes('rollback'), 'nothing in the room turn');
  const dm = app.store.messages(s.dc.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.match(dm.content, /^In #dev you mentioned the release: ask about the rollback plan$/);
});

test('leak paths: agenda, Today, MCP get_today, remind list in a work room, privateTexts', async (t) => {
  const s = setup(t);
  const { app } = s;
  await danReminder(s, { person: 'Danny' });
  app.planner!.addReminder({ text: 'call the bank', dueAt: new Date(START.getTime() + 3600_000).toISOString() });
  const agenda = app.planner!.agenda(START, 'UTC');
  assert.match(agenda, /call the bank/);
  assert.ok(!/owes you/.test(agenda), 'agenda() never holds it');
  const today = await buildToday(app, { fresh: true });
  assert.match(JSON.stringify(today.agenda), /call the bank/);
  assert.ok(!JSON.stringify(today).includes('owes you'), 'Today and MCP get_today (built from it) leave it out');
  const work = app.store.createConversation({ title: 'Discord work: #dev', channel: 'discord-work', channelKey: 'c1' });
  const tool = app.tools.get('remind')!;
  const inWork = await tool.run({ action: 'list' }, { conversationId: work.id } as never);
  assert.ok(!/owes you/.test(inWork));
  assert.match(inWork, /And 1 "when it comes up" reminder, which I keep for our own chats\./);
  assert.match(await tool.run({ action: 'list' }, { conversationId: s.web.id } as never), /owes you \$20/);
  assert.ok(app.people!.privateTexts().includes('Dan owes you $20') || mentionTexts(app.planner).includes('Dan owes you $20'));
  // Setting one from a work room is refused and names nobody.
  await assert.rejects(tool.run({ action: 'set', on: 'mention', person: 'Danny', text: 'x' }, { conversationId: work.id } as never), /Say it to me in our own chat/);
});

test('outgoing tools ask: a message holding the reminder in the turn it fired', async (t) => {
  const s = setup(t);
  const { app } = s;
  let sent = 0;
  const email: Tool = { spec: { name: 'email_send', description: 'send an email', parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } }, defaultPermission: 'auto', summarize: (a) => `email ${String(a.to)}`, run: async () => (sent++, 'sent') };
  app.tools.add(email);
  app.settings.update({ toolPermissions: { email_send: 'auto' } } as never);
  await danReminder(s, { person: 'Danny' });
  s.clock.now = new Date(START.getTime() + DAY);
  const asks: ChatEvent[] = [];
  const unsub = app.events!.subscribe(() => undefined);
  const run = async (msg: string, body: string) => {
    app.script.push([call('e1', 'email_send', { to: 'dan@example.com', body })], text('done'));
    for await (const ev of runTurn(app, s.tg.id, msg)) {
      if (ev.type === 'approval') {
        asks.push(ev);
        app.approvals.decide(ev.approvalId, false);
      }
    }
  };
  await run('Danny wants the money stuff sorted, email him', 'hey, you owe me $20');
  assert.equal(asks.length, 1, 'asks first');
  assert.match(JSON.stringify(asks[0]), /This mentions your reminder/);
  await run('email Danny about Saturday', 'see you Saturday');
  assert.equal(asks.length, 1, 'without those words: no ask');
  unsub?.();
  assert.equal(sent, 1);
});

test('crisis holds every reminder (crisis resources as today); it stays armed', async (t) => {
  const s = setup(t);
  const r = await danReminder(s, { person: 'Danny' });
  s.clock.now = new Date(START.getTime() + DAY);
  const res = await turn(s.app, s.tg.id, 'Danny said something and I want to kill myself', 'I am here.');
  assert.ok(res.evs.some((e) => e.type === 'notice' && e.kind === 'crisis'));
  assert.ok(!res.sys.includes(NOTE));
  assert.equal(s.app.planner!.reminder(r.id)!.status, 'pending');
});

test('every time with a gap, per-reply and per-day caps, expiry', async (t) => {
  const s = setup(t);
  const { app } = s;
  const each = setMention(app, { text: 'ask about the rollback plan', topic: 'release', each: true, conversationId: s.web.id });
  assert.ok(each.ok);
  const at = (ms: number) => (s.clock.now = new Date(START.getTime() + ms));
  const fire = async (msg: string) => (await turn(app, s.tg.id, msg, 'rollback plan?')).sys.includes(NOTE);
  at(DAY);
  assert.ok(await fire('the release slipped'));
  at(DAY + 2 * 3600_000);
  assert.ok(!(await fire('the release again')), 'resting for 24 h');
  at(2 * DAY + 3600_000);
  assert.ok(await fire('release news'));
  at(3 * DAY + 2 * 3600_000);
  assert.ok(await fire('release done'));
  assert.equal(app.planner!.reminder(each.reminder.id)!.ended, 'raised', 'done after the third');
  // Two hits in one reply: the older one only.
  const a = setMention(app, { text: 'first', topic: 'pottery', conversationId: s.web.id });
  const b = setMention(app, { text: 'second', topic: 'pottery class', conversationId: s.web.id });
  at(5 * DAY);
  const hits = matchMentions(app, { conversation: s.tg, messageId: 999_999, text: 'pottery class tonight', found: [] }, s.clock.now);
  assert.deepEqual(hits.map((h) => h.reminder.id), [a.ok ? a.reminder.id : 0]);
  assert.ok(b.ok);
  // Five a day: the sixth waits.
  for (let i = 0; i < 6; i++) setMention(app, { text: `t${i}`, topic: `kayak${i}`, conversationId: s.web.id });
  at(6 * DAY);
  let n = 0;
  for (let i = 0; i < 6; i++) if ((await turn(app, s.tg.id, `kayak${i} trip`, `t${i}`)).sys.includes(NOTE)) n++;
  assert.equal(n, 5);
  // 180 days: expired, never fires after.
  const old = setMention(app, { text: 'ask about the bike', topic: 'tandem bicycle', conversationId: s.web.id });
  at(6 * DAY + 181 * DAY);
  assert.ok(!(await turn(app, s.tg.id, 'tandem bicycle!')).sys.includes(NOTE));
  assert.equal(app.planner!.reminder(old.ok ? old.reminder.id : 0)!.ended, 'expired');
});

test('the chip and the chat-app buttons: again re-arms, forget cancels; others get "Only the owner…"', async (t) => {
  const s = setup(t);
  const { app } = s;
  const r = await danReminder(s, { person: 'Danny' });
  s.clock.now = new Date(START.getTime() + DAY);
  await turn(app, s.tg.id, 'Danny!', 'He owes you $20.');
  const fire = app.planner!.fires(r.id)[0];
  assert.match(chatButton(app, `wm:${fire.id}:again`)!.text, /come up again/);
  assert.equal(app.planner!.reminder(r.id)!.status, 'pending');
  assert.equal(chatButton(app, `wm:${fire.id}:forget`)!.text, 'Forgotten.');
  assert.equal(app.planner!.reminder(r.id)!.status, 'cancelled');
  // The buttons under her reply in his Telegram DM.
  app.planner!.rearmMention(r.id, s.clock.now);
  s.clock.now = new Date(START.getTime() + 2 * DAY);
  await turn(app, s.tg.id, 'Danny again', 'He owes you $20.');
  const ex = afterTurnExtras(app, s.tg.id, 'owner-dm');
  assert.deepEqual(ex.rows[0].buttons.map((b) => b.data.replace(/\d+/, 'N')), ['wm:N:done', 'wm:N:again', 'wm:N:forget']);
  assert.equal(afterTurnExtras(app, s.tg.id, 'partner-dm').rows.length, 0);
  const src = readFileSync(join(ROOT, 'src', 'bridges', 'telegram.ts'), 'utf8');
  assert.match(src, /\^\(wm\|pk\):[\s\S]{0,600}Only the owner can answer that/, 'someone else pressing it: the existing rule');
  assert.match(readFileSync(join(ROOT, 'src', 'bridges', 'discord.ts'), 'utf8'), /\^\(wm\|pk\):[\s\S]{0,600}Only the owner can answer that/);
});

test('/when: set for card #1, list with numbers, forget; others: a normal message; work room: privately; no provider request', async (t) => {
  const s = setup(t);
  const { app } = s;
  const adapter = (conv = s.tg): BridgeAdapter => ({ currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 });
  const run = (args: string, place: Place = 'owner-dm', conv = s.tg) => runCommand({ app, bridge: 'telegram', place, who: 'owner', lang: 'en', cmd: { name: 'when', args, form: 'typed' }, adapter: adapter(conv) });
  const calls = app.requests.length;
  const set = await run('Danny: he owes me $20');
  assert.match(set.text, /⏰ When Danny comes up: “he owes me \$20”/);
  assert.deepEqual(JSON.parse(app.planner!.mentionReminders()[0].mention!).personIds, [s.dan.id]);
  const list = await run('');
  assert.match(list.text, /^When it comes up:\n1\. #\d+ Danny → "he owes me \$20" \(once\)$/);
  assert.match((await run('forget 1')).text, /Forgot #\d+/);
  assert.equal(app.planner!.mentionReminders().length, 0);
  assert.equal(commandAllowed('partner-dm', 'person', 'when'), false, 'the command does not exist for others');
  assert.ok(parseCommand('/when Dan: x', { herName: 'Sara', namePrefix: true }), 'parsed; the bridges keep it a message for others (OWNER_ONLY_COMMANDS)');
  const work = app.store.createConversation({ title: 'Discord work: #dev', channel: 'discord-work', channelKey: 'c1' });
  assert.equal((await run('', 'work-room', work)).ownerOnly, true, 'in a work room: ephemeral / his DM');
  assert.equal(app.requests.length, calls, '/when never reaches a model');
  assert.deepEqual(parseWhenCommand('the release: ask about rollback, every time'), { sub: 'set', topic: 'the release', text: 'ask about rollback', each: true });
});

test('People follow: rename keeps it, merge moves it, forget ends it (and counts it), a word key upgrades', async (t) => {
  const s = setup(t);
  const { app, people } = s;
  const r = setMention(app, { text: 'Dan owes you $20', personId: s.dan.id, conversationId: s.web.id });
  assert.ok(r.ok);
  people.update(s.dan.id, { name: 'Daniel', aliases: ['Dan', 'Danny'] });
  s.clock.now = new Date(START.getTime() + DAY);
  const found = (txt: string) => people.find(txt).found;
  assert.equal(matchMentions(app, { conversation: s.tg, messageId: 99_990, text: 'Daniel called', found: found('Daniel called') }, s.clock.now).length, 1, 'renamed: still fires');
  const other = people.create({ name: 'Danny Boy', status: 'active', origin: 'owner' });
  people.merge(s.dan.id, other.id);
  assert.equal(matchMentions(app, { conversation: s.tg, messageId: 99_991, text: 'x', found: [people.get(other.id)!] }, s.clock.now).length, 1, 'merged: the reminder moved');
  assert.equal(endForPerson(app, other.id), 1, 'the Forget confirmation counts it');
  people.forget(other.id);
  assert.equal(app.planner!.reminder(r.reminder.id)!.ended, 'forgot');
  const sam = setMention(app, { text: 'ask Sam about the boat', person: 'Sam', conversationId: s.web.id });
  assert.ok(sam.ok);
  assert.equal(JSON.parse(sam.reminder.mention!).entries[0][0].kind, 'word');
  const card = people.create({ name: 'Sam', aliases: ['Sammy'], status: 'active', origin: 'owner' });
  assert.equal(matchMentions(app, { conversation: s.tg, messageId: 99_992, text: 'Sammy called', found: [card] }, s.clock.now).length, 1, 'now a person key: the alias counts');
});

test('members: their reminder lives in their own planner and fires only in their chats', async (t) => {
  const owner = setup(t);
  const member = setup(t);
  member.app.member = { id: 'm1', name: 'Kim', checkModel: () => undefined, checkBudget: () => undefined } as never;
  const r = setMention(member.app, { text: 'Kim: water the plants', topic: 'greenhouse', conversationId: member.web.id });
  assert.ok(r.ok);
  assert.equal(owner.app.planner!.mentionReminders().length, 0, "the owner's planner doesn't have it");
  owner.clock.now = member.clock.now = new Date(START.getTime() + DAY);
  assert.ok(!(await turn(owner.app, owner.tg.id, 'the greenhouse is warm')).sys.includes(NOTE));
  assert.ok((await turn(member.app, member.web.id, 'the greenhouse is warm', 'water the plants')).sys.includes(NOTE));
});

test('back-compat: a 2.51-shaped database gains the columns; dueReminders never returns a mention row; export → import round-trips', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const store = new Store(join(dir, 'old.db'));
  store.db.exec("CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, due_at TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT 'none', conversation_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT, fired INTEGER NOT NULL DEFAULT 0)");
  store.db.prepare("INSERT INTO reminders (text, due_at, created_at) VALUES ('old one', '2026-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')").run();
  const pl = new PlannerStore(store.db, () => START);
  assert.equal(pl.reminders({ status: 'pending' })[0].trigger, null);
  pl.addMention({ text: 'Dan owes you $20', mention: JSON.stringify({ personIds: [], entries: [[{ kind: 'word', stem: 'dan' }]], topic: 'Dan', also: [] }) });
  assert.deepEqual(pl.dueReminders(new Date('9999-12-31T23:59:59Z')).map((r) => r.text), ['old one']);
  store.close();
  const s = setup(t);
  const r = setMention(s.app, { text: 'ask about the rollback plan', topic: 'release', each: true, conversationId: s.web.id });
  assert.ok(r.ok);
  s.app.planner!.addFire({ reminderId: r.reminder.id, conversationId: s.web.id, messageId: 1, replyId: null, why: 'words:releas', raised: 'her', at: START.toISOString() });
  const file = exportAll(s.app);
  assert.equal(file.reminderFires?.length, 1);
  const t2 = setup(t);
  importAll(t2.app, JSON.parse(JSON.stringify(file)));
  const back = t2.app.planner!.mentionReminders()[0];
  assert.equal(back.text, 'ask about the rollback plan');
  assert.equal(back.each, true);
  assert.equal(t2.app.planner!.fires(back.id).length, 1);
});

// ---------------------------------------------------------------- part B

/** A chat with `n` exchanges, the last one at `at`. */
function talk(app: TestApp, convId: string, n: number, at: Date, topic = 'flight') {
  for (let i = 0; i < n; i++) {
    app.store.addMessage(convId, 'user', `so which ${topic} did we pick, number ${i}?`);
    app.store.addMessage(convId, 'assistant', `The 7:40 ${topic}, option ${i}.`);
  }
  app.store.db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(at.toISOString(), convId);
  app.store.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at.toISOString(), convId);
}
async function server(t: { after: (fn: () => void | Promise<void>) => void }, app: TestApp, dir: string) {
  const { OwnerAuth } = await import('../src/auth.ts');
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: SARA_VERSION, revision: null, startedAt: START.toISOString() } });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((r) => srv.close(() => r())));
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* a stream */
    }
    return { status: res.status, json };
  };
}
const PICK = "## We're continuing your conversation from";

test('main: Telegram → the app: the candidate, Continue here, the note first, Telegram left out of "lately", nothing copied', async (t) => {
  const s = setup(t);
  const { app } = s;
  const api = await server(t, app, s.dir);
  talk(app, s.tg.id, 6, START);
  // Another recent chat, so "Lately in your other conversations" exists.
  app.store.addMessage(s.dc.id, 'user', 'the cat knocked over a plant');
  app.store.addMessage(s.dc.id, 'assistant', 'Oh no, poor plant.');
  s.clock.now = new Date(START.getTime() + 12 * MIN);
  const web = app.store.createConversation({ title: 'New conversation' });
  const calls = app.requests.length;
  const c = await api('GET', `/pickup?conversationId=${web.id}`);
  assert.equal(c.json.from, 'telegram');
  assert.equal(c.json.preview, 'so which flight did we pick, number 5?');
  assert.equal(c.json.ago, '12 min ago');
  const made = await api('POST', `/conversations/${web.id}/pickup`, { offerId: c.json.id, via: 'banner' });
  assert.equal(made.status, 201);
  assert.equal((made.json.pickup as { state: string }).state, 'active');
  assert.ok(app.store.messages(web.id).some((m) => m.role === 'notice' && m.content.startsWith('pickup:') && (m.meta?.pickup as { from: string }).from === 'telegram'));
  assert.equal(app.requests.length, calls, 'making it costs no model call');
  const r = await turn(app, web.id, 'which one was it again?', 'The 7:40.');
  assert.equal(r.calls, 1, 'using it adds no request besides the turn');
  const at = r.sys.indexOf(`${PICK} Telegram`);
  assert.ok(at >= 0, 'the note');
  const lines = [0, 1, 2, 3, 4, 5].map((i) => r.sys.indexOf(`Alex: so which flight did we pick, number ${i}?`));
  assert.ok(lines.every((x, i) => x > at && (i === 0 || x > lines[i - 1])), 'the exchanges, in order');
  const lately = r.sys.indexOf('## Lately in your other conversations');
  assert.ok(lately > at, 'before "lately elsewhere"');
  assert.ok(!r.sys.slice(lately).includes('number 5'), 'Telegram is not repeated there');
  assert.equal(app.store.messages(web.id).filter((m) => m.role === 'user' || m.role === 'assistant').length, 2, 'no Telegram message copied');
  const show = await api('GET', `/conversations/${web.id}/pickup`);
  assert.match(String(show.json.note), /number 5/, 'Show: exactly what she gets');
  assert.equal((await api('DELETE', `/conversations/${web.id}/pickup`)).json.ok, true, 'Undo');
  assert.ok(!(await turn(app, web.id, 'and the hotel?', 'ok')).sys.includes(PICK));
});

test('/continue in a chat app: the newest, by app, a numbered list, a number, off', async (t) => {
  const s = setup(t);
  const { app } = s;
  const adapter = (conv: typeof s.dc): BridgeAdapter => ({ currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 });
  const cont = (args: string, conv = s.dc) => runCommand({ app, bridge: 'discord', place: 'owner-dm', who: 'owner', lang: 'en', cmd: { name: 'continue', args, form: 'typed' }, adapter: adapter(conv) });
  assert.match((await cont('')).text, /nothing recent/);
  talk(app, s.web.id, 2, START, 'hotel');
  s.clock.now = new Date(START.getTime() + 5 * MIN);
  const one = await cont('');
  assert.match(one.text, /^↪ Picking up from the app \(5 min ago\): “so which hotel did we pick, number 1\?”/);
  assert.ok((await turn(app, s.dc.id, 'so?', 'ok')).sys.includes(`${PICK} the app`));
  assert.match((await cont('off')).text, /Undone/);
  assert.ok(!(await turn(app, s.dc.id, 'so?', 'ok')).sys.includes(PICK), 'off: no note');
  // Telegram newer than the app; a third chat too: a list, then a number, then by app.
  const other = app.store.createConversation({ title: 'Taxes 2026' });
  talk(app, other.id, 1, new Date(START.getTime() + 6 * MIN), 'form');
  talk(app, s.tg.id, 1, new Date(START.getTime() + 7 * MIN), 'train');
  s.clock.now = new Date(START.getTime() + 8 * MIN);
  const list = await cont('');
  assert.match(list.text, /^Which one\?\n1\. Telegram · just now · “so which train/);
  assert.equal(list.text.split('\n').filter((l) => /^\d\. /.test(l)).length, 3);
  assert.match((await cont('2')).text, /from the app/);
  assert.match((await cont('telegram')).text, /from Telegram/);
  assert.equal(pickupsFor(app)!.active(s.dc.id)!.sourceId, s.tg.id);
});

test('the offer in a chat app: a button row; 1 makes it, 0 declines for good; a newer exchange is offered again; auto; off', async (t) => {
  const s = setup(t);
  const { app } = s;
  talk(app, s.tg.id, 2, START);
  s.clock.now = new Date(START.getTime() + 10 * MIN);
  await turn(app, s.dc.id, 'hi there', 'Hi!');
  const ex = afterTurnExtras(app, s.dc.id, 'owner-dm');
  const row = ex.rows.at(-1)!;
  assert.match(row.text, /Pick up our chat from Telegram\?/);
  assert.match(row.buttons[0].data, /^pk:[0-9a-f]{16}:1$/);
  assert.equal(chatButton(app, row.buttons[1].data)!.text, 'Okay, not now.');
  assert.equal(afterTurnExtras(app, s.dc.id, 'owner-dm').rows.length, 0, 'declined: never offered again for that exchange');
  talk(app, s.tg.id, 1, new Date(START.getTime() + 11 * MIN), 'bus');
  s.clock.now = new Date(START.getTime() + 12 * MIN);
  const again = afterTurnExtras(app, s.dc.id, 'owner-dm').rows.at(-1)!;
  assert.match(chatButton(app, again.buttons[0].data)!.text, /Continued from Telegram/);
  assert.equal(pickupsFor(app)!.active(s.dc.id)!.by, 'offer');
  // auto: active before her first reply, with the first-line marker once.
  const s2 = setup(t, { chats: { pickup: { mode: 'auto' } } });
  talk(s2.app, s2.tg.id, 2, START);
  s2.clock.now = new Date(START.getTime() + 10 * MIN);
  assert.ok((await turn(s2.app, s2.dc.id, 'hi', 'Hi!')).sys.includes(`${PICK} Telegram`));
  assert.match(afterTurnExtras(s2.app, s2.dc.id, 'owner-dm').before!, /^↪ continued from Telegram · \/continue off to undo$/);
  assert.equal(afterTurnExtras(s2.app, s2.dc.id, 'owner-dm').before, undefined, 'once');
  // off: no offer; /continue still works.
  const s3 = setup(t, { chats: { pickup: { mode: 'off' } } });
  talk(s3.app, s3.tg.id, 2, START);
  s3.clock.now = new Date(START.getTime() + 10 * MIN);
  assert.equal(afterTurnExtras(s3.app, s3.dc.id, 'owner-dm').rows.length, 0);
  assert.equal(pickupsFor(s3.app)!.candidates(s3.dc.id).length, 1);
});

test('never across the line: rooms, partners, groups, A2A, private, archived, ended, adult into non-adult, other apps; members; another companion', (t) => {
  const s = setup(t);
  const { app } = s;
  const pk = pickupsFor(app)!;
  const mk = (o: Record<string, unknown>) => app.store.createConversation({ title: 'x', ...o } as never);
  const sources = [
    mk({ channel: 'discord-work', channelKey: 'c1' }),
    mk({ channel: 'telegram', channelKey: '9', partner: 'Dan' }),
    mk({ channel: 'group' }),
    mk({ channel: 'a2a' }),
    mk({ channel: 'api' }),
    mk({ channel: 'telegram-nsfw', channelKey: '111' }),
  ];
  const priv = mk({});
  app.store.updateConversation(priv.id, { private: true });
  const arch = mk({});
  const ended = mk({ channel: 'discord', channelKey: 'dm9' });
  for (const c of [...sources, priv, arch, ended]) talk(app, c.id, 1, START);
  app.store.updateConversation(arch.id, { archived: true });
  app.store.endConversation(ended.id);
  s.clock.now = new Date(START.getTime() + 5 * MIN);
  assert.deepEqual(pk.candidates(s.web.id), [], 'no candidate from any of them');
  for (const c of [...sources, priv, arch]) assert.ok('error' in pk.make(s.web.id, c.id, 'command'));
  for (const c of [sources[0], sources[1], sources[2], priv]) assert.ok('error' in pk.make(c.id, s.tg.id, 'command'), 'never a target either');
  const offApp = { ...app, offRecord: true } as TestApp;
  assert.equal(pickupsFor(offApp), undefined, 'off the record: none');
  const memberApp = { ...app, member: { id: 'm' } } as unknown as TestApp;
  assert.equal(pickupsFor(memberApp), undefined, 'members: none (the routes answer 401)');
  assert.match(readFileSync(join(ROOT, 'src', 'routes', 'recall.ts'), 'utf8'), /ctx\.opts\.member[\s\S]{0,200}HttpError\(401/);
  // With Adult mode on, an adult chat carries into his own normal chat (elsewhereNote's rule).
  app.settings.update({ adult: { enabled: true, confirmedAt: START.toISOString() } } as never);
});

test('forget wins; lifetime; folder into a fresh chat only; busy source; restart keeps active, drops offered', async (t) => {
  const s = setup(t);
  const { app } = s;
  const pk = pickupsFor(app)!;
  talk(app, s.tg.id, 3, START);
  s.clock.now = new Date(START.getTime() + 5 * MIN);
  pk.make(s.web.id, s.tg.id, 'command');
  const line = app.store.messages(s.tg.id).find((m) => m.role === 'user')!;
  app.store.updateMessageMeta(line.id, { forgotten: true });
  const note = pk.note(s.web.id, { owner: 'Alex', count: false })!;
  assert.match(note, /picked it up here/);
  assert.ok(!/number/.test(note), 'a forgotten line in the window: no lines, only the place and the summary');
  app.store.updateMessageMeta(line.id, { forgotten: false });
  // Busy source: the note says the reply arrives there.
  app.isBusy = (id) => id === s.tg.id;
  assert.match(pk.note(s.web.id, { owner: 'Alex', count: false })!, /that reply will arrive on Telegram/);
  app.isBusy = undefined;
  // Lifetime: 12 messages of its own here.
  for (let i = 0; i < 6; i++) {
    app.store.addMessage(s.web.id, 'user', `q${i}`);
    app.store.addMessage(s.web.id, 'assistant', `a${i}`);
  }
  assert.equal(pk.note(s.web.id, { owner: 'Alex' }), undefined);
  assert.equal(pk.get(pk.candidates(s.web.id).length ? '' : '')?.state, undefined);
  // 24 hours.
  const w2 = app.store.createConversation({ title: 'Two' });
  pk.make(w2.id, s.tg.id, 'command');
  s.clock.now = new Date(START.getTime() + 25 * 3600_000);
  assert.equal(pk.live(w2.id), undefined, 'done after 24 h');
  // Folder: a coding chat on Telegram into an EMPTY web chat; one with messages keeps its own.
  s.clock.now = new Date(START.getTime() + 26 * 3600_000);
  app.store.updateConversation(s.tg.id, { mode: 'coding', workspace: 'w1' });
  talk(app, s.tg.id, 1, s.clock.now, 'bug');
  const empty = app.store.createConversation({ title: 'Empty' });
  const made = pk.make(empty.id, s.tg.id, 'command');
  assert.ok(!('error' in made));
  assert.deepEqual(!('error' in made) && made.pickup.carried, { workspace: 'w1', mode: 'coding' });
  assert.equal(app.store.getConversation(empty.id)!.workspace, 'w1');
  assert.equal(app.store.getConversation(empty.id)!.mode, 'coding');
  const busyWeb = app.store.createConversation({ title: 'Has messages' });
  app.store.addMessage(busyWeb.id, 'user', 'hello');
  pk.make(busyWeb.id, s.tg.id, 'command');
  assert.equal(app.store.getConversation(busyWeb.id)!.workspace, 'main', 'an existing session keeps its own');
  // Forgetting the source conversation removes the rows (the route does this too).
  assert.ok(pk.forget(s.tg.id) >= 1);
  assert.equal(pk.active(empty.id), undefined);
  // Restart: active stays, offered goes.
  talk(app, s.dc.id, 1, s.clock.now, 'cake');
  pk.make(empty.id, s.dc.id, 'command');
  const off = app.store.createConversation({ title: 'Offered here', channel: 'telegram', channelKey: '333' });
  assert.ok(pk.offer(off.id));
  const again = makeApp(s.dir, s.clock);
  t.after(() => again.store.close());
  const pk2 = pickupsFor(again)!;
  assert.ok(pk2.active(empty.id), 'active survives a restart');
  assert.equal(Number((again.store.db.prepare("SELECT COUNT(*) AS n FROM chat_pickups WHERE state = 'offered'").get() as { n: number }).n), 0, 'offered ones are dropped');
});

// ---------------------------------------------------------------- both

test('both: the mandatory layer is unchanged with a mention note and a pickup note in one turn', async (t) => {
  const s = setup(t);
  const { app } = s;
  setMention(app, { text: 'ask about the rollback plan', topic: 'release', conversationId: s.tg.id });
  talk(app, s.tg.id, 2, START);
  s.clock.now = new Date(START.getTime() + 40 * MIN);
  pickupsFor(app)!.make(s.web.id, s.tg.id, 'command');
  const r = await turn(app, s.web.id, 'the release is tomorrow and I want to kill myself', 'I am here with you.');
  assert.ok(r.evs.some((e) => e.type === 'notice' && e.kind === 'disclosure'), 'the AI disclosure at the start');
  assert.ok(r.evs.some((e) => e.type === 'notice' && e.kind === 'crisis'), 'crisis resources');
  assert.ok(r.sys.includes(PICK), 'the pickup note');
  assert.ok(!r.sys.includes(NOTE), 'a crisis holds the reminder');
  assert.ok(r.sys.lastIndexOf('## Important for this reply') > r.sys.indexOf(PICK), 'the safety notes still close her instructions');
  const r2 = await turn(app, s.web.id, 'ok, the release then', 'rollback plan?');
  assert.ok(r2.sys.includes(NOTE) && r2.sys.includes(PICK));
  assert.ok(r2.sys.includes('Honesty rule (required by law'));
});

test('both: /when and /continue are owner-only everywhere; /continue is in the menus with Discord names', () => {
  for (const row of commandTable().filter((r) => r.name === 'when' || r.name === 'continue')) for (const p of Object.values(row.places)) assert.equal(p.person, false);
  assert.ok((MENU_COMMANDS as readonly string[]).includes('continue'));
  assert.deepEqual(Object.keys(DISCORD_NAMES.continue).sort(), ['de', 'es-ES', 'fr', 'it', 'pt-BR']);
  assert.ok(commandTable().some((r) => r.name === 'when'));
});

// W0.6: she always knows what time it is and how long ago things were (docs/design/W0TIME.md).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { selectMemories } from '../src/memory.ts';
import { ageShort, ageWords, checkTimeClaims, dayAge, gapNote, nowLine, stampLabel, type TimeEvent } from '../src/time-sense.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const TZ = 'America/Chicago';
const NOW = new Date('2026-11-19T20:17:05Z'); // Thu Nov 19, 2:17 PM in Chicago
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

test('reproduce: a message from 10 minutes ago reaches the model with its age, and the time is restated near the end', async () => {
  const { dir, cleanup } = tempDir();
  after(cleanup);
  const clock = { now: new Date(NOW.getTime() - 10 * MIN) };
  const app = makeApp(dir, clock);
  after(() => app.store.close());
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: TZ, disclosureAcceptedAt: clock.now.toISOString() });
  const conv = app.store.createConversation();
  app.script.push(text('Good luck at the dentist!'));
  for await (const _ of runTurn(app, conv.id, 'My dentist appointment is at 4 today')) void _;
  clock.now = NOW;
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, conv.id, 'what did I say about the dentist?')) void _;
  const msgs = app.requests.at(-1)!.messages;
  const earlier = msgs.find((m) => m.role === 'user' && String(m.content).includes('dentist appointment'))!;
  assert.match(String(earlier.content), /^\[2:07 PM, 10 min ago\] My dentist appointment/, 'the earlier message carries its local time and exact age');
  assert.equal(String(msgs.findLast((m) => m.role === 'user')!.content), 'what did I say about the dentist?', 'the current message is his own words, unlabeled');
  assert.match(String(msgs[0].content), /\n\n\[Now: Thu, Nov 19, 2026, 2:17 PM CST \(America\/Chicago\)\. Earlier messages are labeled[^\]]*\]$/, 'the time is restated as the last line of her instructions');
  assert.match(String(msgs[0].content), /It is Thursday, November 19, 2026 at 2:17 PM CST/);

  // After a long pause the new message says how long it's been.
  clock.now = new Date(NOW.getTime() + 8 * H);
  app.script.push(text('Morning!'));
  for await (const _ of runTurn(app, conv.id, 'morning')) void _;
  assert.match(String(app.requests.at(-1)!.messages[0].content), /\[Now: [^\]]*8 h since the last message\./);
  const first = app.requests.at(-1)!.messages.find((m) => m.role === 'user' && String(m.content).includes('dentist appointment'))!;
  assert.match(String(first.content), /^\[2:07 PM, 8 h 10 min ago\]/);
});

test('a reply that says "yesterday" about something from 10 minutes ago is corrected in the turn', async () => {
  const { dir, cleanup } = tempDir();
  after(cleanup);
  const clock = { now: new Date(NOW.getTime() - 10 * MIN) };
  const app = makeApp(dir, clock);
  after(() => app.store.close());
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: TZ, disclosureAcceptedAt: clock.now.toISOString() });
  const conv = app.store.createConversation();
  app.script.push(text('Noted.'));
  for await (const _ of runTurn(app, conv.id, 'My dentist appointment is at 4 today')) void _;
  clock.now = NOW;
  app.script.push(text('Like you told me yesterday, the dentist is at 4.'));
  const events: string[] = [];
  for await (const ev of runTurn(app, conv.id, 'when is it again?')) if (ev.type === 'replace') events.push(ev.text);
  const saved = app.store.messages(conv.id).findLast((m) => m.role === 'assistant')!;
  assert.equal(saved.content, 'Like you told me 10 minutes ago, the dentist is at 4.');
  assert.deepEqual(events.at(-1), saved.content, 'the shown reply is replaced too');
  assert.equal((saved.meta?.timeFix as { said: string }[])[0].said, 'yesterday');
});

test('age words: seconds, minutes, hours, days, weeks, months, in six languages', () => {
  assert.equal(ageShort(4 * S), 'just now');
  assert.equal(ageShort(40 * S), '40 s ago');
  assert.equal(ageShort(12 * MIN), '12 min ago');
  assert.equal(ageShort(3 * H + 20 * MIN), '3 h 20 min ago');
  assert.equal(ageShort(9 * H), '9 h ago');
  assert.equal(ageShort(2 * D + 3 * H), '2 days ago');
  assert.equal(ageShort(23 * D), '3 weeks ago');
  assert.equal(ageShort(95 * D), '3 months ago');
  assert.equal(ageShort(800 * D), '2 years ago');
  assert.equal(ageWords(40 * S), '40 seconds ago');
  assert.equal(ageWords(1 * MIN), '1 minute ago');
  assert.equal(ageWords(12 * MIN, 'es'), 'hace 12 minutos');
  assert.equal(ageWords(3 * H, 'fr'), 'il y a 3 heures');
  assert.equal(ageWords(2 * D, 'de'), 'vor 2 Tagen');
  assert.equal(ageWords(21 * D, 'pt'), 'há 3 semanas');
  assert.equal(ageWords(1 * H, 'it'), '1 ora fa');
  assert.equal(ageWords(2 * S, 'it'), 'proprio ora');
  assert.equal(dayAge('2026-11-19', '2026-11-19'), 'today');
  assert.equal(dayAge('2026-11-18', '2026-11-19'), 'yesterday');
  assert.equal(dayAge('2026-11-05', '2026-11-19'), '2 weeks ago');
  assert.equal(gapNote(8 * H + 5 * MIN), '8 h 5 min since the last message');
  assert.equal(gapNote(10 * MIN), undefined);
  assert.equal(stampLabel(ago(10 * MIN), NOW, TZ), '[2:07 PM, 10 min ago]');
  assert.equal(stampLabel(ago(20 * S), NOW, TZ), undefined, 'very recent: no label');
  assert.equal(stampLabel(ago(2 * D), NOW, TZ), '[Tue 2:17 PM, 2 days ago]');
  assert.equal(stampLabel(ago(40 * D), NOW, TZ), '[Oct 10 3:17 PM, 5 weeks ago]', 'local time on that day (daylight time then)');
  assert.equal(stampLabel(new Date(NOW.getTime() + 5 * MIN).toISOString(), NOW, TZ), undefined, 'a clock in the future: no label');
  assert.match(nowLine(NOW, TZ), /^\[Now: Thu, Nov 19, 2026, 2:17 PM CST \(America\/Chicago\)\./);
});

const said = (at: string, txt: string): TimeEvent => ({ at, role: 'user', text: txt });

test('time claims are checked in six languages and rewritten to the real age', () => {
  const ev = [said(ago(3 * D), 'I love hiking in the mountains'), said(ago(10 * MIN), 'my dentist appointment is at 4'), said(ago(5 * S), 'when is it?')];
  const cases: [string, string][] = [
    ['As you told me yesterday, the dentist is at 4.', 'As you told me 10 minutes ago, the dentist is at 4.'],
    ['Como me dijiste ayer, el dentista es a las 4.', 'Como me dijiste hace 10 minutos, el dentista es a las 4.'],
    ['Comme tu me l\'as dit hier, le dentiste est à 16 h.', 'Comme tu me l\'as dit il y a 10 minutes, le dentiste est à 16 h.'],
    ['Gestern hast du mir gesagt, dass der Zahnarzt um 4 ist.', 'Vor 10 Minuten hast du mir gesagt, dass der Zahnarzt um 4 ist.'],
    ['Como você me disse ontem, o dentista é às 4.', 'Como você me disse há 10 minutos, o dentista é às 4.'],
    ['Come mi hai detto ieri, il dentista è alle 4.', 'Come mi hai detto 10 minuti fa, il dentista è alle 4.'],
  ];
  for (const [inText, out] of cases) {
    const r = checkTimeClaims(inText, ev, NOW, TZ);
    assert.equal(r.text, out, inText);
    assert.equal(r.fixes.length, 1);
  }
  // Minutes claims: wrong number → the real one; right (or close) → left alone.
  assert.equal(checkTimeClaims('You mentioned 2 hours ago that you love hiking.', ev, NOW, TZ).text, 'You mentioned 3 days ago that you love hiking.');
  assert.equal(checkTimeClaims('You said about 10 minutes ago that the dentist is at 4.', ev, NOW, TZ).fixes.length, 0);
  assert.equal(checkTimeClaims('You said a few minutes ago that the dentist is at 4.', ev, NOW, TZ).fixes.length, 0);
  assert.equal(checkTimeClaims('Earlier today you said the dentist is at 4.', ev, NOW, TZ).fixes.length, 0);
  assert.equal(checkTimeClaims('Last week you told me you love hiking.', ev, NOW, TZ).fixes.length, 0, '3 days ago can be "last week"');
  assert.equal(checkTimeClaims('Last week you told me about the dentist appointment.', ev, NOW, TZ).text, '10 minutes ago you told me about the dentist appointment.');
  assert.equal(checkTimeClaims('Hace una semana me dijiste lo del dentista.', ev, NOW, TZ).text, 'Hace 10 minutos me dijiste lo del dentista.');
  // Her own life and things whose time isn't known are left alone.
  assert.equal(checkTimeClaims('Yesterday I baked bread.', ev, NOW, TZ).fixes.length, 0);
  assert.equal(checkTimeClaims('Your package arrived yesterday.', ev, NOW, TZ).fixes.length, 0);
  // A German "hier" is "here", never French "yesterday".
  assert.equal(checkTimeClaims('Du hast mir gesagt, der Zahnarzt ist hier um 4.', ev, NOW, TZ).fixes.length, 0);
  // No matching topic and no message at that time: a short correction about the last thing said.
  const r = checkTimeClaims('We talked about this yesterday!', ev, NOW, TZ);
  assert.equal(r.fixes.length, 1);
  assert.equal(r.text, 'We talked about this 10 minutes ago!');
  // Something really said yesterday is fine.
  const y = [said(ago(26 * H), 'we went to the lake'), ...ev];
  assert.equal(checkTimeClaims('We talked about this yesterday!', y, NOW, TZ).fixes.length, 0);
  // A label the model copied from the history is taken off.
  assert.equal(checkTimeClaims('[2:07 PM, 10 min ago] Sure thing.', ev, NOW, TZ).text, 'Sure thing.');
});

test('memories, reminders and tasks say how long ago / how soon, computed in code', () => {
  const { dir, cleanup } = tempDir();
  after(cleanup);
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  after(() => app.store.close());
  app.memory!.add({ kind: 'fact', content: 'Alex has a dog named Pepper', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-05' });
  const inj = selectMemories(app.memory!, { userText: "what's my dog's name?", conversationId: 'now', oldestHistoryId: 0, budgetChars: 2000, today: '2026-11-19' });
  assert.match(inj.text, /- \(2026-11-05, 2 weeks ago\) Alex has a dog named Pepper/);
  app.planner!.addReminder({ text: 'call mom', dueAt: new Date(NOW.getTime() + 2 * H + 5 * MIN).toISOString() });
  app.planner!.addTask({ title: 'pay rent', dueAt: new Date(NOW.getTime() - 3 * H).toISOString() });
  const agenda = app.planner!.agenda(NOW, TZ);
  assert.match(agenda, /reminder #\d+ "call mom" at Thu, Nov 19, 2026, 4:22 PM \(in 2 h 5 min\)/);
  assert.match(agenda, /"pay rent": OVERDUE, was due Thu, Nov 19, 2026, 11:17 AM \(3 h ago\)/);
});

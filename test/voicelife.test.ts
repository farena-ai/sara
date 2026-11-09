// Phase 37: her voice and her life (expressive voice, voice follows mood, follow-ups from shared
// history, consistent days, things to do together, shared lists).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { addTags, moodSpeed, plainSpeech, stripTags, toneInstructions } from '../src/expressive.ts';
import { exportAll, importAll } from '../src/export.ts';
import { dayPrompt, LifeWorker } from '../src/life.ts';
import { datesNote, followUps, followUpsNote } from '../src/memory.ts';
import { validatePersona } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { tagged } from '../src/speech.ts';
import { createSharedListTool, TogetherStore } from '../src/together.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-28T15:00:00Z') }; // Wednesday 10:00 in Chicago
const app = makeApp(dir, clock);
app.together = new TogetherStore(app.store.db, () => clock.now);
app.tools.add(createSharedListTool(() => app.together));
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = async (path: string, method = 'GET', body?: unknown): Promise<Response> => {
  const go = () => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  // A kept-alive connection the server just closed (a race on a busy machine): try once more.
  return go().catch((err: Error & { cause?: { code?: string } }) => (err.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};

test('expressive voice: cues in her text become Grok speech tags; never in plain speech; stripped from captions', () => {
  assert.equal(addTags('Haha, okay. That was good.', 'subtle'), '[chuckle], okay. That was good.');
  assert.equal(addTags('Hahaha no way!', 'lively'), '[laugh] no way!');
  assert.equal(addTags('*sighs* Long day.', 'subtle'), '[sigh] Long day.');
  assert.equal(addTags('Ugh, Mondays.', 'subtle'), '[sigh] Mondays.');
  assert.equal(addTags('*whispers* I missed you. See you soon.', 'subtle'), '<whisper>I missed you.</whisper> See you soon.');
  assert.equal(addTags('Well... I guess so.', 'subtle'), 'Well... I guess so.', 'subtle leaves pauses alone');
  assert.equal(addTags('Well... I guess so.', 'lively'), '[breath] Well [pause] I guess so.');
  assert.equal(addTags('Haha *sighs* fine', 'off'), 'Haha fine', 'off: no tags, stage directions dropped');
  assert.equal(plainSpeech('*laughs* okay (sighs) fine'), 'okay fine');
  assert.equal(addTags('That sounds hard.', 'subtle', { soft: true }), '<soft>That sounds hard.</soft>', 'softer when you are down');
  // Through the markdown cleanup, tags survive (the cleanup turns < > * into spaces otherwise).
  assert.equal(tagged('**Haha** *whispers* come here.', 'subtle', {}, 'natural'), '[chuckle] <whisper>come here.</whisper>');
  assert.equal(stripTags('[laugh] okay <whisper>come here</whisper> [pause] now'), 'okay come here now');
  assert.equal(moodSpeed(1, { soft: true }), 0.95);
  assert.equal(moodSpeed(1.6, {}, 'bright'), 1.5, 'kept within range');
  assert.match(toneInstructions({ soft: true }, 'warm', 'subtle')!, /warmly.*soft, caring/);
});

test('voice settings: expressive, tone and mood are saved and sent to the speech engine', async () => {
  const r = await call('/api/voice', 'PUT', { expressive: 'lively', tone: 'warm', followMood: false });
  assert.equal(r.status, 200);
  const v = await (await call('/api/voice')).json();
  assert.equal(v.settings.expressive, 'lively');
  assert.equal(v.settings.tone, 'warm');
  assert.equal(v.settings.followMood, false);
  assert.match(v.expressiveSample, /\*sighs\*/);
  assert.equal((await call('/api/voice', 'PUT', { expressive: 'loud' })).status, 400, 'unknown values are refused');
  assert.equal((await (await call('/api/voice')).json()).settings.expressive, 'lively');
  await call('/api/voice', 'PUT', { expressive: 'subtle', tone: 'natural', followMood: true });
});

test('follow-ups: a dated event she learned about comes up the next days ("how did it go?"), birthdays stay yearly', () => {
  const mem = app.memory!;
  mem.addOwner({ kind: 'date', content: "Alex's job interview at Acme", onDate: '2026-10-27', happenedOn: '2026-10-20' });
  mem.add({ kind: 'date', content: "Alex's sister's birthday", onDate: '1990-10-26', happenedOn: '2026-10-01', conversationId: null, sourceMessageId: null });
  const conv = app.store.createConversation();
  const items = followUps(app, conv.id, '2026-10-28');
  assert.deepEqual(items.map((p) => p.memory.content), ["Alex's job interview at Acme"], 'a birthday is not a follow-up');
  assert.match(followUpsNote(items, 'Alex')!, /- Yesterday: Alex's job interview at Acme\nNo clear outcome was found in eligible recent messages\. Ask only if still relevant/);
  const answer = app.store.addMessage(conv.id, 'user', 'The interview went great btw');
  app.store.markDirectOwnerMessage(answer.id);
  assert.equal(followUps(app, conv.id, '2026-10-28').length, 0, 'once he has talked about it, she stops asking');
  app.store.deleteMessagesFrom(conv.id, answer.id);
  assert.equal(mem.recentPast('2026-11-02').length, 0, 'only for a few days');
  // A one-time event doesn't come back next year.
  assert.doesNotMatch(datesNote(mem, '2027-10-20') ?? '', /interview/);
  assert.match(datesNote(mem, '2027-10-20') ?? '', /sister's birthday/);
});

test('proactive: she texts first to ask how it went (bypassing the random wait), once', async () => {
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'hey');
  app.store.addMessage(conv.id, 'assistant', 'hi!');
  app.settings.update({ proactive: { enabled: true, maxPerDay: 2, minGapHours: 1, quietStart: 23, quietEnd: 7 } });
  clock.now = new Date('2026-10-28T20:00:00Z');
  const life = new LifeWorker(app, app.life!, app.inner!, () => 0.99);
  app.script.push(text('So?? How did the interview go?'));
  const r = await life.maybeProactive();
  assert.equal(r.proactive, 'So?? How did the interview go?');
  const note = String(app.requests.at(-1)!.messages.at(-1)!.content);
  assert.match(note, /Yesterday Alex had this coming up: Alex's job interview at Acme\. You remember, and you want to know how it went/);
  // In a chat the same day (before he says how it went), it's in her instructions.
  app.script.push(text('So? Tell me everything!'));
  for await (const _ of runTurn(app, conv.id, 'hey')) void _;
  assert.match(app.requests.at(-1)!.messages.slice(1).filter((m) => m.role === 'system').map((m) => m.content).join('\n'), /## Ask how it went\n- Yesterday: Alex's job interview at Acme/);
  assert.doesNotMatch(String(app.requests.at(-1)!.messages[0].content), /## Ask how it went/, 'source-qualified follow-ups stay out of the replayed base persona');
  const answer = app.store.addMessage(conv.id, 'user', 'the interview went well!');
  app.store.markDirectOwnerMessage(answer.id);
  app.script.push(text('Yay!'));
  for await (const _ of runTurn(app, conv.id, 'so yeah')) void _;
  assert.doesNotMatch(app.requests.at(-1)!.messages.map((m) => m.content).join('\n'), /## Ask how it went/);
  clock.now = new Date('2026-10-28T23:30:00Z');
  const again = await life.maybeProactive();
  assert.notEqual(again.proactive, 'So?? How did the interview go?');
  assert.ok(app.memory!.recentPast('2026-10-28').every((p) => p.memory.mentionedOn === '2026-10-28'), 'marked as followed up');
});

test('her days: her life fields keep the day consistent, and one small thing continues', () => {
  app.persona = validatePersona({ ...app.persona, life: { job: 'a florist at Petal & Stem', friends: 'Maya, her best friend from college' } });
  const p = dayPrompt(app, [{ day: '2026-10-27', content: 'Repotted the fern. Maya is coming over Thursday.' }], [], 'Wednesday, October 28', false);
  assert.match(p, /stay consistent: same job, people, places and hobbies/);
  assert.match(p, /florist at Petal & Stem/);
  assert.match(p, /continue one small thing from them/);
});

test('things to do together: an activity puts its rules in her instructions until it ends', async () => {
  const conv = app.store.createConversation();
  assert.equal((await call(`/api/conversations/${conv.id}/together`, 'POST', { kind: 'chess' })).status, 400);
  const r = await call(`/api/conversations/${conv.id}/together`, 'POST', { kind: 'watch-along', topic: 'The Bear, season 2' });
  assert.equal((await r.json()).activity.kind, 'watch-along');
  assert.equal((await (await call(`/api/conversations/${conv.id}`)).json()).together.topic, 'The Bear, season 2');
  app.script.push(text('Oh no, the kitchen chaos episode!'));
  for await (const _ of runTurn(app, conv.id, "I'm watching The Bear, season 2. Watch along with me?")) void _;
  let sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /## Doing something together\nAlex is watching "The Bear, season 2" and you're 'watching along'/);
  assert.match(sys, /Don't spoil anything/);
  await call(`/api/conversations/${conv.id}/together`, 'DELETE');
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, conv.id, 'that was fun')) void _;
  sys = String(app.requests.at(-1)!.messages[0].content);
  assert.doesNotMatch(sys, /Doing something together/);
  // 20 questions keeps count and stays fair.
  await call(`/api/conversations/${conv.id}/together`, 'POST', { kind: 'twenty-questions' });
  app.script.push(text('Okay, got one!'));
  for await (const _ of runTurn(app, conv.id, "Let's play 20 questions!")) void _;
  assert.match(String(app.requests.at(-1)!.messages[0].content), /keep it the same all game.*count the questions/s);
});

test('shared lists: you and she add to them; she can list and tick off; they export and import', async () => {
  let v = await (await call('/api/together/items', 'POST', { list: 'music', title: 'Clair de Lune – Debussy' })).json();
  assert.equal(v.items[0].addedBy, 'owner');
  assert.equal((await call('/api/together/items', 'POST', { list: 'snacks', title: 'x' })).status, 400);
  const tool = app.tools.get('shared_list')!;
  assert.match(String(await tool.run({ action: 'add', list: 'reading', title: 'The Hobbit – Tolkien', by: 'her', note: 'cozy autumn read' }, {} as never)), /Added to Reading list/);
  assert.match(String(await tool.run({ action: 'list', list: 'reading' }, {} as never)), /The Hobbit – Tolkien \(cozy autumn read\) \[added by you\]/);
  assert.match(String(await tool.run({ action: 'done', list: 'reading', title: 'hobbit' }, {} as never)), /Marked done/);
  await assert.rejects(tool.run({ action: 'done', list: 'watch', title: 'Nothing' }, {} as never), /isn't on Watch list/);
  v = await (await call('/api/together')).json();
  assert.equal(v.activities.length, 6);
  assert.ok(v.items.find((x: { title: string }) => x.title.startsWith('The Hobbit')).doneAt);
  // Export → import into a fresh server keeps the lists.
  const file = exportAll(app);
  assert.equal(file.sharedItems?.length, 2);
  const { dir: d2, cleanup: c2 } = tempDir();
  const app2 = makeApp(d2, clock);
  app2.together = new TogetherStore(app2.store.db, () => clock.now);
  const res = importAll(app2, file);
  assert.equal(res.sharedItems, 2);
  assert.equal(app2.together.items('reading')[0].addedBy, 'her');
  assert.equal(importAll(app2, file).sharedItems, 0, 'no duplicates on a second import');
  app2.store.close();
  try {
    c2();
  } catch {
    /* Windows */
  }
});

// C12 (docs/ops/C12_DESIGN.md): "How to work with you". Working traits held as beliefs with
// evidence (message ids only), confidence that fades unless seen again, statuses, hard topic
// exclusions, the per-turn gates (her replies, private, partner, imported, groups, other apps never
// count), the work/personal split, the prompt block with its cap and the one-time "I've noticed".
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { excludedTopic, observe, STYLE, WorkingStyle, workingStyleNote } from '../src/working-style.ts';
import { makeApp, tempDir, text } from './helpers.ts';

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  const ws = new WorkingStyle(app, app.store.db);
  app.workingStyle = ws;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const say = async (conv: { id: string }, line: string, reply = 'ok', opts: Record<string, unknown> = {}) => {
    app.script.push(text(reply));
    for await (const _ of runTurn(app, conv.id, line, new AbortController().signal, opts as never)) void _;
    return app.requests.at(-1)!;
  };
  const days = (n: number) => (clock.now = new Date(clock.now.getTime() + n * 86_400_000));
  return { app, ws, clock, say, days };
}

const sys = (req: { messages: { role: string; content: unknown }[] }) => req.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');

test('C12 extractor: cheap, usually nothing; stated vs seen; reported, hypothetical and questions are not evidence', () => {
  assert.deepEqual(observe('What is the weather in Denver tomorrow'), []);
  assert.deepEqual(observe('Thanks, that works.'), []);
  assert.deepEqual(observe('That is too long.'), [{ trait: 'reply-length', value: 'short', domain: '', stated: false }]);
  assert.deepEqual(observe('From now on I prefer short answers.'), [{ trait: 'reply-length', value: 'short', domain: '', stated: true }]);
  assert.deepEqual(observe('Go into more detail please.'), [{ trait: 'reply-length', value: 'long', domain: '', stated: false }]);
  assert.deepEqual(observe('Just pick one for me.'), [{ trait: 'options', value: 'one', domain: '', stated: false }]);
  assert.deepEqual(observe('Give me a few options.'), [{ trait: 'options', value: 'options', domain: '', stated: false }]);
  assert.deepEqual(observe('Always ask me before you change anything.'), [{ trait: 'ask-first', value: 'ask', domain: '', stated: true }]);
  assert.deepEqual(observe("Just do it, don't ask."), [{ trait: 'ask-first', value: 'go', domain: '', stated: false }]);
  assert.deepEqual(observe('No need to be so formal.'), [{ trait: 'formality', value: 'casual', domain: '', stated: false }]);
  assert.deepEqual(observe("Be blunt, don't sugarcoat it."), [{ trait: 'feedback', value: 'direct', domain: '', stated: false }]);
  assert.deepEqual(observe("I'm new to kubernetes."), [{ trait: 'expertise', value: 'new', domain: 'kubernetes', stated: true }]);
  assert.deepEqual(observe("I've been doing woodworking for 20 years."), [{ trait: 'expertise', value: 'expert', domain: 'woodworking', stated: true }]);
  // Not his own plain assertion: a question, a hypothetical, someone else's words, a quote.
  assert.deepEqual(observe('Should I keep it short?'), []);
  assert.deepEqual(observe('If it is too long, cut it.'), []);
  assert.deepEqual(observe('My boss said that is too long.'), []);
  assert.deepEqual(observe('She wrote "too long, just pick one".'), []);
});

test('C12 hard exclusions: health, religion, politics, sexuality, personality typing, credentials, other people', () => {
  const cases: [string, string][] = [
    ['Keep it short, my depression is bad today.', 'health'],
    ["I'm new to insulin pumps.", 'health'],
    ["I'm new to christianity, keep it short.", 'religion'],
    ['Too long. Anyway, the election is rigged.', 'politics'],
    ["I'm gay, keep it short.", 'sexuality'],
    ["As an INTJ I like it short.", 'personality'],
    ["I'm an introvert so keep it short.", 'personality'],
    ['My password is hunter2, too long though.', 'credentials'],
    ['Women are always too long-winded, keep it short.', 'others'],
  ];
  for (const [line, cat] of cases) {
    assert.equal(excludedTopic(line), cat, line);
    assert.deepEqual(observe(line), [], `no evidence from: ${line}`);
  }
  assert.equal(excludedTopic('Keep it short please.'), null);
  // Defence in depth: the store refuses an excluded domain even if a caller skipped observe().
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date('2026-11-02T15:00:00Z') });
    const ws = new WorkingStyle(app, app.store.db);
    const conv = app.store.createConversation();
    const m = app.store.addMessage(conv.id, 'user', 'x');
    assert.throws(() => ws.record({ trait: 'expertise', value: 'expert', domain: 'islam', stated: true }, { messageId: m.id, conversationId: conv.id, side: 'personal', scope: 'everywhere', scopeKey: '' }), /not learned/);
    assert.throws(() => ws.record({ trait: 'mood' as never, value: 'sad', domain: '', stated: true }, { messageId: m.id, conversationId: conv.id, side: 'personal', scope: 'everywhere', scopeKey: '' }), /not learned/);
    app.store.close();
  } finally {
    cleanup();
  }
});

test('C12 lifecycle: candidate → held in a 2nd session (she says so once) → fades unless seen again; evidence is ids only', async (t) => {
  const { app, ws, say, days } = rig(t);
  const a = app.store.createConversation();
  await say(a, 'That is too long.');
  let [b] = ws.list();
  assert.equal(b.status, 'candidate');
  assert.equal(b.evidenceFor, 1);
  // The same session again does not make it held.
  await say(a, 'Still too long.');
  assert.equal(ws.list()[0].status, 'candidate');
  const c = app.store.createConversation();
  // The turn that makes it held: the block, and the one-time "I've noticed" line.
  let req = await say(c, 'Too long, shorter please.');
  [b] = ws.list();
  assert.equal(b.status, 'held');
  assert.equal(b.sessions, 2);
  assert.ok(b.confidence > 0.6, String(b.confidence));
  assert.match(sys(req), /How to work with Alex/);
  assert.match(sys(req), /Keep replies short/);
  assert.match(sys(req), /Say once, briefly.*I've noticed you prefer short answers; I'll keep them short\. Say if not\./);
  req = await say(c, 'And for dessert');
  assert.match(sys(req), /Keep replies short/);
  assert.doesNotMatch(sys(req), /Say once, briefly/, 'only once');
  // Evidence is message ids: no copied text anywhere in the C12 tables.
  const cols = (app.store.db.prepare("SELECT name FROM pragma_table_info('working_trait_evidence')").all() as { name: string }[]).map((r) => r.name);
  assert.ok(cols.includes('message_id') && !cols.some((n) => /content|text|quote/.test(n)), cols.join());
  const dump = JSON.stringify([...app.store.db.prepare('SELECT * FROM working_traits').all(), ...app.store.db.prepare('SELECT * FROM working_trait_evidence').all()]);
  assert.doesNotMatch(dump, /too long|shorter please/i);
  // Fading: not seen for months, confidence drops and it stops being used.
  days(120);
  [b] = ws.list();
  assert.ok(b.confidence < 0.35, String(b.confidence));
  assert.equal(b.status, 'candidate');
  req = await say(c, 'Hello again');
  assert.doesNotMatch(sys(req), /Keep replies short/);
  // The overnight pass retires what has all but gone.
  days(200);
  ws.nightly(app.now());
  assert.equal(ws.list()[0].status, 'retired');
});

test('C12 stated preferences never fade; Confirm / Not true / Forget', async (t) => {
  const { app, ws, say, days } = rig(t);
  const a = app.store.createConversation();
  await say(a, 'From now on I prefer short answers.');
  let [b] = ws.list();
  assert.equal(b.status, 'confirmed');
  assert.equal(b.stated, true);
  days(400);
  ws.nightly(app.now());
  [b] = ws.list();
  assert.equal(b.status, 'confirmed');
  assert.ok(b.confidence >= 0.9);
  const req = await say(a, 'hi');
  assert.match(sys(req), /Keep replies short/);
  assert.doesNotMatch(sys(req), /Say once/, 'he said it himself: no announcement');
  // Not true: retired and never re-learned from what she notices.
  await say(a, 'Give me a few options.');
  const opt = ws.list().find((x) => x.trait === 'options')!;
  ws.decide(opt.id, 'confirm');
  assert.equal(ws.list().find((x) => x.id === opt.id)!.status, 'confirmed');
  ws.decide(opt.id, 'deny');
  assert.equal(ws.list().find((x) => x.id === opt.id)!.status, 'retired');
  await say(app.store.createConversation(), 'Give me a few options.');
  await say(app.store.createConversation(), 'Give me a few options.');
  assert.equal(ws.list().find((x) => x.id === opt.id)!.status, 'retired');
  // Forget: the belief and its evidence are gone.
  ws.forget(b.id);
  assert.equal(ws.list().some((x) => x.id === b.id), false);
  assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM working_trait_evidence WHERE trait_id = ?').get(b.id) as { n: number }).n, 0);
});

test('C12 contradiction: a held belief seen the other way becomes contested and she asks once', async (t) => {
  const { app, ws, say } = rig(t);
  await say(app.store.createConversation(), 'Too long.');
  await say(app.store.createConversation(), 'Too long.');
  assert.equal(ws.list()[0].status, 'held');
  const c = app.store.createConversation();
  let req = await say(c, 'Go into more detail please.');
  const short = ws.list().find((x) => x.value === 'short')!;
  assert.equal(short.status, 'contested');
  assert.equal(short.evidenceAgainst, 1);
  assert.match(sys(req), /Ask once, briefly/);
  assert.doesNotMatch(sys(req), /Keep replies short/, 'a contested belief is not applied');
  req = await say(c, 'ok then');
  assert.doesNotMatch(sys(req), /Ask once, briefly/);
});

test('C12 gates: her replies, private, partner, imported, adult channel, groups and other apps never count', async (t) => {
  const { app, ws, say } = rig(t);
  // Her own reply saying the phrase is never evidence.
  await say(app.store.createConversation(), 'Hello there', 'Too long. Just pick one. Ask me before you change anything.');
  assert.equal(ws.list().length, 0);
  const conv = app.store.createConversation();
  const mine = app.store.addMessage(conv.id, 'assistant', 'Too long.');
  assert.equal(ws.learnFrom(conv, mine, {}).length, 0);
  const imported = app.store.addMessage(conv.id, 'user', 'Too long.', { importedFrom: 'chatgpt' });
  assert.equal(ws.learnFrom(conv, imported, {}).length, 0);
  assert.equal(ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'Too long.'), { externalApp: true }).length, 0);
  assert.equal(ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'Too long.'), { outside: {} } as never).length, 0);
  assert.equal(ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'Too long.'), { group: {} } as never).length, 0);
  const priv = app.store.createConversation({ private: true });
  await say(priv, 'Too long.').catch(() => undefined);
  assert.equal(ws.learnFrom(priv, app.store.addMessage(priv.id, 'user', 'Too long.'), {}).length, 0);
  const partner = app.store.createConversation({ channel: 'telegram', channelKey: '5', partner: 'Sam' });
  assert.equal(ws.learnFrom(partner, app.store.addMessage(partner.id, 'user', 'Too long.'), {}).length, 0);
  const adult = app.store.createConversation({ channel: 'telegram-nsfw', channelKey: '6' });
  assert.equal(ws.learnFrom(adult, app.store.addMessage(adult.id, 'user', 'Too long.'), {}).length, 0);
  assert.equal(ws.list().length, 0);
  // Memory off: nothing learned.
  app.settings.update({ memory: { enabled: false } } as never);
  assert.equal(ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'Too long.'), {}).length, 0);
});

test('C12 work and personal stay apart; per-project ask-first; the block is capped', async (t) => {
  const { app, ws, say } = rig(t);
  // Work mode everywhere (the admin's pin): what she learns there is work's own.
  const pol = new PolicyStore(app.dataDir);
  const workMode = (on: boolean) => { pol.set({ pins: on ? { workMode: true } : {} } as never); setPolicy(pol); };
  t.after(() => setPolicy(new PolicyStore()));
  workMode(true);
  for (let i = 0; i < 2; i++) await say(app.store.createConversation(), "Be blunt, don't sugarcoat it.");
  assert.equal(ws.list()[0].side, 'work');
  assert.equal(ws.list()[0].status, 'held');
  assert.match(sys(await say(app.store.createConversation(), 'hi')), /Be direct/);
  workMode(false);
  assert.doesNotMatch(sys(await say(app.store.createConversation(), 'hi')), /Be direct/, 'a work trait stays at work');
  // A shared work channel is not his direct chat: nothing learned there.
  const shared = app.store.createConversation({ channel: 'telegram-work', channelKey: '1' });
  assert.equal(ws.learnFrom(shared, app.store.addMessage(shared.id, 'user', 'Too long.'), {}).length, 0);
  // Ask before acting is per project.
  const p = { id: app.planner!.projectId('Garden')! };
  const pc = app.store.createConversation({ projectId: p.id });
  await say(pc, 'Always ask me before you change anything.');
  const ask = ws.list().find((x) => x.trait === 'ask-first')!;
  assert.equal(ask.scope, 'project');
  assert.equal(ask.scopeKey, String(p.id));
  assert.match(sys(await say(pc, 'hi')), /Ask before you act/);
  assert.doesNotMatch(sys(await say(app.store.createConversation(), 'hi')), /Ask before you act/);
  // Many confirmed traits: the block stays under its cap.
  const c = app.store.createConversation();
  for (const line of ['From now on I prefer short answers.', 'Always give me options.', "I'm new to rust.", "I'm new to gardening.", "I'm new to chess.", "I'm new to baking.", "I'm new to sailing.", "I'm new to welding.", "I'm new to python.", "I'm new to piano."]) await say(c, line);
  const note = workingStyleNote(app, c, {})!;
  assert.ok(note.length <= STYLE.noteChars, String(note.length));
});

test('C12 usual hours from message times in the overnight pass; the admin pin turns learning off', async (t) => {
  const { app, ws, clock } = rig(t);
  for (let d = 0; d < 6; d++) {
    const conv = app.store.createConversation();
    for (let i = 0; i < 4; i++) {
      clock.now = new Date(Date.UTC(2026, 9, 20 + d, 20, i * 10));
      ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'What is on tonight'), {});
    }
  }
  clock.now = new Date('2026-10-27T03:00:00Z');
  ws.nightly(clock.now);
  const h = ws.list().find((x) => x.trait === 'hours');
  assert.equal(h?.value, 'evening');
  const pol = new PolicyStore(app.dataDir);
  pol.set({ pins: { workingStyle: false } } as never);
  setPolicy(pol);
  t.after(() => setPolicy(new PolicyStore()));
  const conv = app.store.createConversation();
  assert.equal(ws.learnFrom(conv, app.store.addMessage(conv.id, 'user', 'Too long.'), {}).length, 0);
  assert.equal(workingStyleNote(app, conv, {}), undefined);
  assert.throws(() => ws.setSettings({ on: true }), /admin/);
});

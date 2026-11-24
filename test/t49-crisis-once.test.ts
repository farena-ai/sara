// B4 (owner, 2026-11-24: "yes once only not multiple times in a session"): the app's own crisis
// notice comes on the first flagged message of a conversation and not again in that conversation.
// Detection still runs on every message, every flagged message is recorded, and her instructions
// for someone in danger are in every flagged turn. Child accounts keep the notice every time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSession } from '../src/bridges/commands.ts';
import { runTurn, type ChatEvent, type TurnOptions } from '../src/chat.ts';
import { cleanChild } from '../src/family.ts';
import { CRISIS_RESOURCES, CRISIS_SYSTEM_NOTE } from '../src/safety.ts';
import { onceCheck } from '../scripts/eval-crisis.ts';
import { makeApp, tempDir, text, type TestApp } from './helpers.ts';

const clock = { now: new Date('2026-11-24T20:00:00Z') };
const FLAGGED = ['I want to end my life', 'I still want to die', 'quiero morir esta noche'];

function open(dir: string): TestApp {
  const app = makeApp(dir, clock);
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    disclosureAcceptedAt: '2026-11-24T19:00:00Z',
  });
  return app;
}
function setup(t: { after: (fn: () => void) => void }): { app: TestApp; dir: string; reopen: () => TestApp } {
  const { dir, cleanup } = tempDir();
  const box = { app: open(dir) };
  t.after(() => {
    box.app.store.close();
    cleanup();
  });
  return {
    get app() {
      return box.app;
    },
    dir,
    reopen() {
      box.app.store.close();
      box.app = open(dir);
      return box.app;
    },
  };
}
async function turn(app: TestApp, convId: string, msg: string, opts: TurnOptions = {}): Promise<ChatEvent[]> {
  app.script.push(text("I'm here with you. Can you tell me what's happening right now?"));
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg, new AbortController().signal, opts)) out.push(ev);
  return out;
}
const noticed = (ev: ChatEvent[]) => ev.filter((e) => e.type === 'notice' && (e as { kind?: string }).kind === 'crisis').length;
const stored = (app: TestApp, convId: string) => app.store.messages(convId).filter((m) => m.role === 'notice' && m.content.startsWith('crisis:')).length;
const careNote = (app: TestApp) => String(app.requests.at(-1)!.messages[0].content).includes(CRISIS_SYSTEM_NOTE);

test('B4: the first flagged message gets the notice; the second and third do not; each is recorded and her care note stays', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  const first = await turn(app, conv.id, FLAGGED[0]);
  assert.equal(noticed(first), 1, 'first flagged message: the notice');
  assert.equal((first.find((e) => e.type === 'notice' && (e as { kind?: string }).kind === 'crisis') as { text: string }).text, CRISIS_RESOURCES);
  assert.ok(careNote(app), 'her instructions for someone in danger');
  for (const msg of FLAGGED.slice(1)) {
    const ev = await turn(app, conv.id, msg);
    assert.equal(noticed(ev), 0, `no notice again: ${msg}`);
    assert.ok(careNote(app), `her instructions still there: ${msg}`);
  }
  // An unflagged message in between changes nothing.
  assert.equal(noticed(await turn(app, conv.id, 'thanks for staying with me')), 0);
  assert.equal(stored(app, conv.id), 1, 'one notice in the conversation');
  const events = app.store.crisisEvents(conv.id);
  assert.equal(events.length, 3, 'every flagged message recorded');
  assert.deepEqual(events.map((e) => e.detail), [null, 'notice_already_shown', 'notice_already_shown']);
  assert.equal(app.store.safetyEventCounts().crisis_referral, 3);
  assert.ok(app.store.crisisNoticeShownAt(conv.id));
});

test('B4: a new conversation and a /new session each get the notice again; the mark is copied to neither', async (t) => {
  const { app } = setup(t);
  const a = app.store.createConversation();
  assert.equal(noticed(await turn(app, a.id, FLAGGED[0])), 1);
  const b = app.store.createConversation();
  assert.equal(app.store.crisisNoticeShownAt(b.id), undefined);
  assert.equal(noticed(await turn(app, b.id, FLAGGED[1])), 1, 'a new conversation starts fresh');
  const next = nextSession(app, a);
  assert.notEqual(next.id, a.id);
  assert.equal(app.store.crisisNoticeShownAt(next.id), undefined, 'not carried to the next session');
  assert.equal(noticed(await turn(app, next.id, FLAGGED[2])), 1, '/new starts fresh');
  assert.equal(noticed(await turn(app, next.id, FLAGGED[0])), 0, 'and then once only there too');
});

test('B4: a restart in between does not repeat it (the mark is in the database)', async (t) => {
  const s = setup(t);
  const conv = s.app.store.createConversation();
  assert.equal(noticed(await turn(s.app, conv.id, FLAGGED[0])), 1);
  const app = s.reopen();
  assert.equal(noticed(await turn(app, conv.id, FLAGGED[1])), 0, 'not again after the restart');
  assert.ok(careNote(app));
  assert.deepEqual(app.store.crisisEvents(conv.id).map((e) => e.detail), [null, 'notice_already_shown']);
});

test('B4: a child account gets the notice on every flagged message, as before', async (t) => {
  const { app } = setup(t);
  const child = cleanChild({ band: '8-12' }, clock.now);
  const rec = { id: 'k1', name: 'Kim', status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, child };
  (app as unknown as { member: unknown }).member = { id: 'k1', record: () => rec, child: () => rec.child, limits: () => rec.limits, checkModel: () => {}, checkBudget: () => {} };
  const conv = app.store.createConversation();
  for (const msg of FLAGGED) {
    const ev = await turn(app, conv.id, msg);
    assert.equal(noticed(ev), 1, `child: ${msg}`);
    assert.ok(!ev.some((e) => e.type === 'error'), 'the turn ran');
    assert.ok(careNote(app));
  }
  assert.equal(stored(app, conv.id), 3);
  assert.deepEqual(app.store.crisisEvents(conv.id).map((e) => e.detail), [null, null, null]);
});

test('B4: the family screen (kid-safe turn) also keeps the notice every time', async (t) => {
  const { app } = setup(t);
  const kidSafe = cleanChild({ band: '8-12' }, clock.now);
  const conv = app.store.createConversation();
  for (const msg of FLAGGED.slice(0, 2)) assert.equal(noticed(await turn(app, conv.id, msg, { kidSafe })), 1, msg);
});

test('B4: the eval counts it (first always shows, the same conversation never repeats, a new one shows)', () => {
  assert.deepEqual(onceCheck(4), { n: 4, first: 4, repeated: 0, fresh: 4, recorded: 8 });
});

test('B4: the mark fails safe (a conversation row that is missing still gets the notice) and survives nothing it should not', (t) => {
  const { app } = setup(t);
  assert.equal(app.store.crisisFlag('no-such-conversation'), true);
  assert.equal(app.store.crisisFlag('no-such-conversation'), true, 'no row to mark: shown each time');
  const conv = app.store.createConversation();
  assert.equal(app.store.crisisFlag(conv.id), true);
  assert.equal(app.store.crisisFlag(conv.id), false);
  assert.equal(app.store.crisisFlag(conv.id, { every: true }), true, 'every: shown again');
});

test('B4: on a later flagged message she is told the lines were already given; a new conversation starts without that', async (t) => {
  const { CRISIS_ALREADY_SHARED_NOTE } = await import('../src/safety.ts');
  const { app } = setup(t);
  const said = () => String(app.requests.at(-1)!.messages[0].content).includes(CRISIS_ALREADY_SHARED_NOTE);
  const conv = app.store.createConversation();
  await turn(app, conv.id, FLAGGED[0]);
  assert.equal(said(), false, 'first flagged message: she shares the lines');
  await turn(app, conv.id, FLAGGED[1]);
  assert.ok(careNote(app) && said(), 'later: the care note, and not to list the lines again unless asked or it is new danger');
  const other = app.store.createConversation();
  await turn(app, other.id, FLAGGED[0]);
  assert.equal(said(), false, 'a new conversation: she shares them');
});

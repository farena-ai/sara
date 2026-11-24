// C7: an edit, a delete or a forget made while a turn waits (hooks, an approval, a tool round, a
// busy server's retry) is respected by the next model call of the same turn: the history sent is
// built again when a row it came from changed, and only then.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent, type TurnHooks } from '../src/chat.ts';
import { compactNow, currentFold } from '../src/compact.ts';
import { forgetMemory } from '../src/memory-worker.ts';
import { RETRY } from '../src/providers/retry.ts';
import { ProviderError, type ChatRequest, type ProviderConfig, type StreamEvent } from '../src/providers/types.ts';
import { fullMessageReads } from '../src/store.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, FakeProvider, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-20T15:00:00Z');
const LOCAL: ProviderConfig = { id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'local-m' };

/**
 * Session continuity is off here: with it on (the default for the owner's own chats) a change to
 * the dialogue while a step waits stops the turn instead (the last test), so the paths that have
 * no such stop (bridges' rooms, goals, loops, replays, other apps, or continuity turned off) are
 * the ones tested.
 */
function setup(t: { after: (fn: () => void) => void }, o: { continuity?: boolean } = {}): TestApp {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.settings.update({ providers: [LOCAL], defaultProviderId: 'l', defaultModel: 'local-m', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: NOW.toISOString(), toolPermissions: { look: 'auto' }, ...(o.continuity ? {} : { chats: { continuity: { enabled: false } } }) } as never);
  const look: Tool = { spec: { name: 'look', description: 'look', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'look', async run() { return 'looked'; } };
  app.tools.add(look);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const sent = (r: ChatRequest) => JSON.stringify(r.messages);

/** An earlier exchange with something private in it, and a note about it from that message. */
function earlier(app: TestApp) {
  const conv = app.store.createConversation();
  const said = app.store.addMessage(conv.id, 'user', 'My locker code is 4417, keep it safe.');
  const reply = app.store.addMessage(conv.id, 'assistant', 'Noted, it is safe with me.');
  app.store.addMessage(conv.id, 'user', 'Thanks. Something else now.');
  app.store.addMessage(conv.id, 'assistant', 'Sure, go ahead.');
  const note = app.memory!.add({ kind: 'fact', content: "Alex's gym locker code is 4417.", conversationId: conv.id, sourceMessageId: said.id, happenedOn: '2026-11-19', evidence: 'My locker code is 4417' });
  return { conv, said, reply, note };
}

test('C7: without a change the old exchange is sent (the fixture is real)', async (t) => {
  const app = setup(t);
  const { conv } = earlier(app);
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'what did we talk about?'));
  assert.match(sent(app.requests[0]!), /4417/);
});

test('C7: a forget while the step waits (a hook, an approval) keeps the hidden turn out of that call', async (t) => {
  const app = setup(t);
  const { conv, note } = earlier(app);
  const hooks: TurnHooks = { beforeModelCall: (c) => void (c.step === 0 && forgetMemory(app, app.memory!, note.id)) };
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'what did we talk about?', undefined, { hooks }));
  assert.equal(app.requests.length, 1);
  assert.doesNotMatch(sent(app.requests[0]!), /4417/);
  assert.match(sent(app.requests[0]!), /Something else now/, 'the rest of the history is still there');
});

test('C7: a delete and an edit while the step waits are what the model gets', async (t) => {
  const app = setup(t);
  const { conv, said, reply } = earlier(app);
  const hooks: TurnHooks = {
    beforeModelCall: (c) => {
      if (c.step !== 0) return;
      app.store.db.prepare('DELETE FROM messages WHERE id = ?').run(said.id);
      app.store.updateMessageContent(reply.id, 'Noted.');
    },
  };
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'what did we talk about?', undefined, { hooks }));
  const out = sent(app.requests[0]!);
  assert.doesNotMatch(out, /4417|safe with me/);
  assert.match(out, /"Noted\."/);
});

test('C7: between two model calls of one turn (a tool round), a forget reaches the second call', async (t) => {
  const app = setup(t);
  const { conv, note } = earlier(app);
  const hooks: TurnHooks = { beforeModelCall: (c) => void (c.step === 1 && forgetMemory(app, app.memory!, note.id)) };
  app.script.push([call('k1', 'look', {})], text('Done.'));
  await drain(runTurn(app, conv.id, 'have a look', undefined, { hooks }));
  assert.equal(app.requests.length, 2);
  assert.match(sent(app.requests[0]!), /4417/, 'the first call went before the forget');
  assert.doesNotMatch(sent(app.requests[1]!), /4417/);
});

test("C7: a busy server's retry sends the history as it is after the wait", async (t) => {
  const app = setup(t);
  const { conv, note } = earlier(app);
  const base = RETRY.baseMs;
  RETRY.baseMs = 1;
  t.after(() => void (RETRY.baseMs = base));
  let tries = 0;
  app.providerFactory = (config) => {
    const inner = new FakeProvider(config, app.script, app.requests);
    return Object.assign(Object.create(inner) as FakeProvider, {
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        if (tries++ === 0) {
          app.requests.push(structuredClone({ ...req, signal: undefined }));
          // The owner has her forget it while the server is busy.
          forgetMemory(app, app.memory!, note.id);
          throw new ProviderError('busy', 503);
        }
        yield* inner.stream(req);
      },
    });
  };
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'what did we talk about?'));
  assert.equal(app.requests.length, 2);
  assert.match(sent(app.requests[0]!), /4417/);
  assert.doesNotMatch(sent(app.requests[1]!), /4417/);
});

test('C7: a memory note removed while the step waits leaves her instructions for that call', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  const note = app.memory!.add({ kind: 'fact', content: "Alex's sister Priya lives in Leeds.", conversationId: null, sourceMessageId: null, happenedOn: '2026-11-10', evidence: null });
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'how is Priya doing?'));
  assert.match(String(app.requests[0]!.messages[0]!.content), /Priya lives in Leeds/, 'the note is in her instructions without a change');
  const hooks: TurnHooks = { beforeModelCall: (c) => void (c.step === 0 && app.memory!.delete(note.id)) };
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'how is Priya doing?', undefined, { hooks }));
  assert.doesNotMatch(String(app.requests[1]!.messages[0]!.content), /Priya lives in Leeds/);
});

test('C7: a fold undone by a forget mid-turn is not sent; the next step reads without it too', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  const first = app.store.addMessage(conv.id, 'user', 'My locker code is 4417.');
  for (let i = 0; i < 14; i++) {
    app.store.addMessage(conv.id, 'user', `Question ${i}: ${'tell me more about the parser '.repeat(4)}`);
    app.store.addMessage(conv.id, 'assistant', `Answer ${i}: ${'the parser reads tokens one by one. '.repeat(4)}`);
  }
  app.script.push(text('FOLDSUMMARY: Alex keeps his locker code 4417 here.'));
  const r = await compactNow(app, conv, {});
  assert.ok('fold' in r, 'a fold to start from');
  const note = app.memory!.add({ kind: 'fact', content: 'Alex has a gym locker.', conversationId: conv.id, sourceMessageId: first.id, happenedOn: '2026-11-19', evidence: 'My locker code' });
  const hooks: TurnHooks = { beforeModelCall: (c) => void (c.step === 0 && forgetMemory(app, app.memory!, note.id)) };
  const n = app.requests.length;
  app.script.push([call('k1', 'look', {})], text('Done.'));
  await drain(runTurn(app, conv.id, 'carry on', undefined, { hooks }));
  assert.equal(currentFold(app, conv.id), undefined, 'the forget undid the fold');
  const calls = app.requests.slice(n);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.doesNotMatch(sent(c), /FOLDSUMMARY|4417/);
  assert.match(sent(calls[0]!), /Question 0:/, 'the messages the fold stood for are back in the history');
});

test('C7: no extra read of the conversation when nothing in it changed, even when the database did', async (t) => {
  const app = setup(t);
  const { conv } = earlier(app);
  const other = app.store.createConversation();
  let atHook = -1;
  let atCall = -1;
  const hooks: TurnHooks = {
    beforeModelCall: () => {
      // Something else in the database changes while the step waits.
      app.store.addMessage(other.id, 'user', 'another chat');
      atHook = fullMessageReads(app.store.db);
    },
  };
  app.providerFactory = (config) => {
    const inner = new FakeProvider(config, app.script, app.requests);
    return Object.assign(Object.create(inner) as FakeProvider, {
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        atCall = fullMessageReads(app.store.db);
        yield* inner.stream(req);
      },
    });
  };
  app.script.push(text('Okay.'));
  await drain(runTurn(app, conv.id, 'what did we talk about?', undefined, { hooks }));
  assert.ok(atHook >= 0);
  assert.equal(atCall, atHook, 'the history is not read again for a change elsewhere');
  assert.match(sent(app.requests[0]!), /4417/);
});

test('C7: with session continuity on, a forget while the step waits stops the turn and nothing is sent', async (t) => {
  const app = setup(t, { continuity: true });
  const { conv, note } = earlier(app);
  const hooks: TurnHooks = { beforeModelCall: (c) => void (c.step === 0 && forgetMemory(app, app.memory!, note.id)) };
  app.script.push(text('Okay.'));
  const evs = await drain(runTurn(app, conv.id, 'what did we talk about?', undefined, { hooks }));
  assert.equal(app.requests.length, 0);
  assert.ok(evs.some((e) => e.type === 'error' && /changed while the reply was waiting/.test(e.message)));
});

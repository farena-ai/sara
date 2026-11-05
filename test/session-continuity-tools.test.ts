import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { createSessionContinuityTools } from '../src/session-continuity-tools.ts';
import { eligibleFor, planFor, familyOf } from '../src/lean.ts';
import { SESSION_CONTINUITY_MARK } from '../src/session-continuity.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

function fixture() {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T15:00:00.000Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', memory: { enabled: false }, lean: { tools: { mode: 'always', localCore: false } } } as never);
  for (const t of createSessionContinuityTools()) app.tools.add(t);
  const current = app.store.createConversation(); const other = app.store.createConversation({ channel: 'discord', channelKey: 'fixture-dm' });
  app.store.addMessage(other.id, 'user', 'OTHER_OWNER_HISTORY');
  return { app, current, other, close() { app.store.close(); temp.cleanup(); } };
}
async function collect(it: AsyncIterable<ChatEvent>) { const out: ChatEvent[] = []; for await (const e of it) out.push(e); return out; }

test('R1 session tools have exact schemas and require a host capability', async () => {
  const m = await import('../src/session-continuity-tools.ts').catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return { createSessionContinuityTools: undefined };
  });
  assert.equal(typeof m.createSessionContinuityTools, 'function', 'session tool factory exists');
  const tools = m.createSessionContinuityTools!();
  assert.deepEqual(tools.map(t => t.spec.name), ['session_context', 'session_handoff']);
  for (const tool of tools) {
    assert.equal(tool.defaultPermission, 'auto');
    assert.equal(tool.spec.parameters.additionalProperties, false);
    await assert.rejects(tool.run({}, {} as never), /unavailable/i);
  }
});

test('R1 tool schemas reject wrong action fields, coercions and model trust before calling host', async () => {
  const [context, handoff] = createSessionContinuityTools(); let calls = 0;
  const ctx = { sessionContinuity: { async context() { calls++; return '{}'; }, async handoff() { calls++; return '{}'; } } };
  for (const args of [{ action: 'list', conversationId: 'x' }, { action: 'read' }, { action: 'read', targetId: 'x' }, { action: 'read', conversationId: 'x', before: '3' }, { action: 'read', conversationId: 'x', before: 0 }, { action: 'read', conversationId: 'x', before: undefined }, { action: 'list', sourceId: 'x' }, { action: 'read', conversationId: 'x', trusted: true }, { action: 'other' }]) {
    await assert.rejects(context.run(args, ctx as never), /invalid|choose/i);
  }
  for (const args of [{ targetId: 'x', text: 'note' }, { targetId: 'x', text: 'note', expectedId: '0' }, { targetId: 'x', text: ' ', expectedId: 0 }, { targetId: 'x', text: 'x'.repeat(601), expectedId: 0 }, { targetId: 'x', text: 'note', expectedId: 0, sourceId: 'forged' }, { targetId: 'x', text: 'note', expectedId: 0, createdAt: 'now' }]) await assert.rejects(handoff.run(args, ctx as never), /invalid/i);
  assert.equal(calls, 0);
  await context.run({ action: 'list' }, ctx as never);
  await context.run({ action: 'read', conversationId: 'exact', before: 3 }, ctx as never);
  await handoff.run({ targetId: 'exact', text: 'note', expectedId: 0 }, ctx as never);
  assert.equal(calls, 3);
});

test('R1 discovery shares owner/disabled/permission policy and memory family in both modes', () => {
  const f = fixture();
  try {
    for (const mode of ['chat', 'coding'] as const) {
      f.app.store.updateConversation(f.current.id, { mode });
      const c = f.app.store.getConversation(f.current.id)!;
      assert.ok(planFor(f.app, c).offeredNames().includes('session_context'), mode);
    }
    for (const t of createSessionContinuityTools()) assert.equal(familyOf(t).id, 'memory');
    f.app.settings.update({ toolPermissions: { session_context: 'never', session_handoff: 'never' } });
    assert.ok(!eligibleFor(f.app, f.current).some(t => t.spec.name.startsWith('session_')));
    f.app.settings.update({ toolPermissions: {}, chats: { continuity: { enabled: false } } } as never);
    assert.ok(!planFor(f.app, f.current).eligible.some(t => t.spec.name.startsWith('session_')));
    f.app.settings.update({ chats: { continuity: { enabled: true } } } as never);
    for (const patch of [{ private: true }, { partner: 'someone' }, { archivedAt: '2026-11-05T15:00:00.000Z' }, { endedAt: '2026-11-05T15:00:00.000Z' }, { channel: 'discord-work' }]) {
      const c = { ...f.current, ...patch };
      assert.ok(!eligibleFor(f.app, c).some(t => t.spec.name.startsWith('session_')), JSON.stringify(patch));
    }
    const source = f.app.store.addMessage(f.current.id, 'user', 'Forgotten source.');
    f.app.store.updateMessageMeta(source.id, { forgotten: true });
    assert.ok(!planFor(f.app, f.app.store.getConversation(f.current.id)!).eligible.some(t => t.spec.name.startsWith('session_')), 'persisted forgotten current history denies preview too');
  } finally { f.close(); }
});

test('R1 actual tool reads host session and stores CAS handoff without external work', async () => {
  const f = fixture();
  try {
    f.app.script.push([call('list', 'session_context', { action: 'list' })], [call('read', 'session_context', { action: 'read', conversationId: f.other.id })], [call('note', 'session_handoff', { targetId: f.other.id, text: 'Internal context only.', expectedId: 0 })], text('Saved contextual note.'));
    const events = await collect(runTurn(f.app, f.current.id, 'Coordinate these sessions.'));
    const results = events.filter(e => e.type === 'tool_result');
    assert.equal(results.length, 3);
    assert.ok(results.every(e => e.status === 'ok'));
    assert.match(results[1].output, /OTHER_OWNER_HISTORY/);
    const receipt = JSON.parse(results[2].output);
    assert.equal(receipt.record.sourceConversationId, f.current.id);
    assert.equal(receipt.record.targetConversationId, f.other.id);
    assert.match(receipt.meaning, /no human delivery/);
    assert.equal(f.app.requests.length, 4, 'only scripted turn steps invoke the fake provider');
    assert.equal(events.filter(e => e.type === 'approval').length, 0, 'default auto does not invent approval');
  } finally { f.close(); }
});

test('R1 late discovery cannot resurrect disabled tools or never permission', async () => {
  for (const action of ['disabled', 'never']) {
    const f = fixture();
    try {
      f.app.script.push([call('find', 'find_tools', { query: 'session_handoff', load: ['session_handoff'] })], text('Done.'));
      const events = await collect(runTurn(f.app, f.current.id, 'Find the session handoff tool.', undefined, { hooks: { async afterReply(c) {
        if (!c.calls.length) return;
        await Promise.resolve();
        if (action === 'disabled') f.app.settings.update({ chats: { continuity: { enabled: false } } } as never);
        else f.app.settings.update({ toolPermissions: { session_handoff: 'never' } });
      } } }));
      const result = events.find(e => e.type === 'tool_result');
      assert.ok(result?.type === 'tool_result');
      assert.ok(!/Loaded[^\n]*session_handoff/.test(result.output));
      assert.ok(!f.app.requests[1].tools?.some(t => t.name === 'session_handoff'));
      if (action === 'disabled') assert.ok(!f.app.requests[1].messages.some(m => m.content.startsWith(SESSION_CONTINUITY_MARK)));
    } finally { f.close(); }
  }
});

test('R1 late discovery withdraws forgotten current history before any false load receipt or source plaintext read', async () => {
  for (const seam of ['afterReply', 'tool']) {
    const f = fixture(); const old = f.app.store.addMessage(f.current.id, 'user', 'Forget this current history.');
    let plaintextReads = 0; let latePlaintextReads = 0; let lateSourceReads = 0; let discovering = false;
    const prepare = f.app.store.db.prepare.bind(f.app.store.db);
    f.app.store.db.prepare = ((sql: string) => {
      if (/SELECT[^;]*\bcontent\b[^;]*FROM messages/i.test(sql)) { plaintextReads++; if (discovering) latePlaintextReads++; }
      const statement = prepare(sql);
      for (const key of ['get', 'all'] as const) {
        const run = statement[key].bind(statement);
        statement[key] = ((...args: never[]) => { if (discovering && args[0] === f.other.id) lateSourceReads++; return run(...args); }) as never;
      }
      return statement;
    }) as never;
    f.app.tools.add({ spec: { name: 'forget_fixture', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Forget fixture', async run() { f.app.store.updateMessageMeta(old.id, { forgotten: true }); return 'Forgotten.'; } });
    const find = call('find', 'find_tools', { query: 'session_handoff', load: ['session_handoff'] });
    f.app.script.push(seam === 'tool' ? [call('forget', 'forget_fixture', {}), find] : [find], text('Fresh ordinary continuation.'));
    try {
      const events: ChatEvent[] = [];
      for await (const e of runTurn(f.app, f.current.id, 'Find the handoff tool.', undefined, { hooks: { async afterReply(c) { if (seam === 'afterReply' && c.calls.length) { await Promise.resolve(); f.app.store.updateMessageMeta(old.id, { forgotten: true }); } } } })) {
        events.push(e); if (e.type === 'tool_call' && e.id === 'find') discovering = true; if (e.type === 'tool_result' && e.id === 'find') discovering = false;
      }
      const result = events.find(e => e.type === 'tool_result' && e.id === 'find'); assert.ok(result?.type === 'tool_result');
      assert.ok(!/Loaded[^\n]*session_handoff/.test(result.output), seam);
      assert.equal(f.app.requests.length, 2, 'fresh ordinary history can continue');
      assert.ok(!f.app.requests[1].tools?.some(t => t.name.startsWith('session_')));
      assert.ok(!f.app.requests[1].messages.some(m => m.content.startsWith(SESSION_CONTINUITY_MARK)));
      assert.ok(plaintextReads >= 1, 'initial eligible prompt actually exercised source reads');
      assert.equal(latePlaintextReads, 0, 'discovery retrieves no dialogue plaintext');
      assert.equal(lateSourceReads, 0, 'bound current denial precedes even other-session metadata access');
    } finally { f.close(); }
  }
});

test('R1 ask/never permissions and revocation refuse effects before source plaintext reads', async () => {
  for (const action of ['deny', 'never', 'disabled', 'private', 'source-private', 'malformed']) {
    const f = fixture();
    try {
      f.app.settings.update({ toolPermissions: { session_context: action === 'never' ? 'never' : 'ask' } });
      f.app.script.push([call('read', 'session_context', { action: 'read', conversationId: f.other.id })], text('Finished.'));
      let readsAfterGate = 0; let watching = false;
      const prepare = f.app.store.db.prepare.bind(f.app.store.db);
      f.app.store.db.prepare = ((sql: string) => {
        const stmt = prepare(sql);
        if (/FROM messages/.test(sql)) {
          for (const key of ['get', 'all'] as const) {
            const run = stmt[key].bind(stmt);
            stmt[key] = ((...args: never[]) => { if (watching && args[0] === f.other.id) readsAfterGate++; return run(...args); }) as never;
          }
        }
        return stmt;
      }) as never;
      let approvals = 0; const events: ChatEvent[] = [];
      for await (const ev of runTurn(f.app, f.current.id, 'Read that other session.')) {
        events.push(ev);
        if (ev.type === 'tool_call') watching = true;
        if (ev.type === 'tool_result') watching = false;
        if (ev.type !== 'approval') continue;
        approvals++; watching = true;
        if (action === 'disabled') f.app.settings.update({ chats: { continuity: { enabled: false } } } as never);
        if (action === 'malformed') f.app.settings.update({ chats: { continuity: { enabled: 'yes' } } } as never);
        if (action === 'private') f.app.store.updateConversation(f.current.id, { private: true });
        if (action === 'source-private') f.app.store.updateConversation(f.other.id, { private: true });
        f.app.approvals.decide(ev.approvalId, action !== 'deny');
      }
      assert.equal(approvals, action === 'never' ? 0 : 1, action);
      const result = events.find(e => e.type === 'tool_result'); assert.ok(result?.type === 'tool_result');
      assert.notEqual(result.status, 'ok', action);
      assert.ok(!result.output.includes('OTHER_OWNER_HISTORY'), action);
      // A denied source is never read by the tool. Automatic final notes are disabled/filtered too.
      assert.equal(readsAfterGate, 0, action);
    } finally { f.close(); }
  }
});

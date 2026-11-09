import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { continuityForTurn, SESSION_CONTINUITY_MARK } from '../src/session-continuity.ts';
import { createSessionContinuityTools } from '../src/session-continuity-tools.ts';
import { acquireSessionStep } from '../src/session-step-gate.ts';
import { RunStore } from '../src/runs.ts';
import { normLean, tokensOf } from '../src/lean.ts';
import { importAll } from '../src/export.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-05T15:00:00.000Z';
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
before(() => { globalThis.fetch = async () => { networkAttempts++; throw new Error('Boundary regressions forbid network'); }; });
after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0); });
function fixture(t: { after(fn: () => void): void }) {
  // Failed synthetic fixtures may be retained for investigation without touching owner data.
  const temp = tempDir();
  const app = makeApp(temp.dir, { now: new Date(NOW) });
  app.settings.update({ providers: [{ id: 'p', label: 'Synthetic local fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false }, chats: { continuity: { enabled: true, parallel: 1 } } });
  app.runs = new RunStore(app.store.db, app.now);
  for (const tool of createSessionContinuityTools()) app.tools.add(tool);
  t.after(() => { app.store.close(); if (!process.env.SARA_KEEP_BOUNDARY_FIXTURES) temp.cleanup(); });
  if (process.env.SARA_KEEP_BOUNDARY_FIXTURES) console.log('Synthetic boundary fixture:', temp.dir);
  return app;
}
async function collect(it: AsyncIterable<ChatEvent>) { const out = []; for await (const event of it) out.push(event); return out; }
const liveNotes = (app: ReturnType<typeof fixture>, i = 0) => app.requests[i].messages.filter(m => m.role === 'system' && m.content.startsWith(SESSION_CONTINUITY_MARK)).map(m => m.content).join('\n');

for (const seam of ['hook', 'fifo'] as const) for (const revoke of [false, true]) {
  test(`final recorded tools match actual schemas after ${seam}, revoked=${revoke}`, async t => {
    const app = fixture(t); const current = app.store.createConversation();
    app.settings.update({ lean: normLean({ tools: { mode: 'always', localCore: false, pins: ['session_context', 'session_handoff'] } }) });
    let release: (() => void) | undefined; let initialEligible = 0; let initialTokens = 0;
    const mutate = () => { if (revoke) app.settings.update({ chats: { continuity: { enabled: false } } }); };
    app.script.push(text('Synthetic reply.'));
    try {
      for await (const event of runTurn(app, current.id, 'Check my other session.', undefined, { hooks: { async beforeModelCall(c) {
        assert.equal(typeof c.eligible, 'number'); initialEligible = c.eligible!; initialTokens = c.lean!.eligibleTokens!;
        assert.ok(c.tools.includes('session_context') && c.tools.includes('session_handoff'));
        if (seam === 'fifo') release = await acquireSessionStep(app.store.db, 'held-synthetic', new AbortController().signal).ready;
        else { await Promise.resolve(); mutate(); }
      } } })) { if (event.type === 'notice' && event.kind === 'continuity') { mutate(); release!(); } }
      assert.equal(app.requests.length, 1);
      const actual = app.requests[0].tools ?? [];
      const lean = app.runs!.steps(app.runs!.list({ conversationId: current.id })[0].id)[0].lean!;
      assert.deepEqual(lean.offered, actual.map(s => s.name), 'persisted witness must describe the final request');
      assert.equal(lean.offeredTokens, tokensOf(actual.map(spec => ({ spec }))));
      assert.equal(lean.eligible, initialEligible - (revoke ? 2 : 0));
      const sessionTokens = tokensOf(createSessionContinuityTools());
      assert.equal(lean.eligibleTokens, initialTokens - (revoke ? sessionTokens : 0));
      assert.equal(actual.some(s => s.name === 'session_context'), !revoke);
    } finally { release?.(); }
  });
}

test('later discovery records added and revoked schemas exactly once with coherent token counts', async t => {
  const app = fixture(t); const current = app.store.createConversation();
  app.tools.add({ spec: { name: 'synthetic_hidden', description: 'A synthetic deferred operation.', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'Synthetic', async run() { return 'Synthetic result'; } });
  app.settings.update({ lean: normLean({ tools: { mode: 'always', localCore: false, pins: ['session_context', 'session_handoff'] } }) });
  app.script.push([call('discover', 'find_tools', { load: ['synthetic_hidden'] })], [call('operate', 'synthetic_hidden', {})], text('Done.'));
  await collect(runTurn(app, current.id, 'Check the other session.', undefined, { hooks: { async beforeModelCall(c) {
    await Promise.resolve(); if (c.step === 1) app.settings.update({ chats: { continuity: { enabled: false } } });
  } } }));
  assert.equal(app.requests.length, 3);
  const steps = app.runs!.steps(app.runs!.list({ conversationId: current.id })[0].id);
  let offered: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const lean = steps[i].lean!;
    if (i === 0) offered = lean.offered!;
    else for (const name of lean.offered!) {
      if (name.startsWith('-')) offered = offered.filter(n => n !== name.slice(1));
      else if (name.startsWith('+')) offered.push(name.slice(1));
      else assert.fail(`Later witness must be incremental: ${name}`);
    }
    assert.deepEqual(offered, app.requests[i].tools!.map(s => s.name));
    assert.equal(lean.offeredTokens, tokensOf(app.requests[i].tools!.map(spec => ({ spec }))));
  }
  assert.ok(steps[1].lean!.offered!.includes('+synthetic_hidden'));
  assert.ok(steps[1].lean!.offered!.includes('-session_context'));
  assert.ok(steps[1].lean!.offered!.includes('-session_handoff'));
  assert.ok(steps[1].lean!.loaded!.some(x => x.name === 'synthetic_hidden'));
  assert.deepEqual(steps[2].lean!.offered, []);
});

for (const meta of [null, '{"custom":{"keep":true}}', '{ "importedFrom": "previous-source", "custom": 7 }', '{"importedFrom":null}', '{"importedFrom":false,"ownerOrigin":"direct-v1"}', '{bad', '[]', 'false', 'null']) {
  test(`native import keeps provenance excluded before and after fresh direct dialogue: ${meta}`, async t => {
    const app = fixture(t); const current = app.store.createConversation(); const id = 'synthetic-native-import';
    const result = importAll(app, { format: 'sara-export', version: 1, exportedAt: NOW, owner: { ownerName: 'Different exported owner' }, conversations: [{ id, title: 'Synthetic imported source', channel: 'web', workspace: 'main', mode: 'chat', private: 0, created_at: NOW, updated_at: NOW, messages: [{ id: 1, role: 'user', content: 'IMPORTED_HISTORY_SENTINEL', created_at: NOW, meta, ownerOrigin: 'direct-v1', owner_origin: 'direct-v1' }] }] });
    assert.equal(result.messages, 1);
    const row = app.store.db.prepare('SELECT meta,owner_origin FROM messages WHERE conversation_id=?').get(id) as { meta: string | null; owner_origin: string | null };
    assert.equal(row.owner_origin, null);
    const service = continuityForTurn(app, current.id)!;
    assert.ok(!service.list().sessions.some(s => s.id === id), 'new native import must not be listed as owner-session context');
    assert.throws(() => service.read(id), /unavailable/);
    if (meta && meta !== '{bad' && meta !== '[]' && meta !== 'false' && meta !== 'null') {
      const before = JSON.parse(meta); const after = JSON.parse(row.meta!);
      for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
      if (Object.hasOwn(before, 'importedFrom')) assert.equal(row.meta, meta, 'prior import markers and metadata bytes remain intact');
    }
    if (meta === '{bad' || meta === '[]' || meta === 'false' || meta === 'null') assert.equal(row.meta, meta, 'invalid metadata stays denied and unmodified');
    else assert.ok(row.meta && Object.hasOwn(JSON.parse(row.meta), 'importedFrom'), 'host import provenance cannot be omitted by the caller');
    assert.throws(() => continuityForTurn(app, id)!.handoff({ targetId: current.id, text: 'Imported context', expectedId: 0 }), /unavailable/);
    await collect(runTurn(app, current.id, 'Actual owner request.', undefined, { noTools: true }));
    assert.ok(!liveNotes(app).includes('IMPORTED_HISTORY_SENTINEL'));
    // The pre-existing Store transcript reader rejects malformed JSON. Preserve its bytes and
    // denial above rather than broadening this fix into a historical-data repair operation.
    if (meta === '{bad') return;
    await collect(runTurn(app, id, 'FRESH_DIRECT_SENTINEL', undefined, { noTools: true }));
    assert.ok(service.list().sessions.some(s => s.id === id), 'fresh owner history remains usable');
    const page = service.read(id);
    assert.ok(page.messages.some(m => m.content === 'FRESH_DIRECT_SENTINEL' && m.ownerOrigin === 'direct-v1'));
    assert.ok(page.messages.every(m => !m.content.includes('IMPORTED_HISTORY_SENTINEL')));
    await collect(runTurn(app, current.id, 'Current owner follow-up.', undefined, { noTools: true }));
    assert.ok(!liveNotes(app, 2).includes('IMPORTED_HISTORY_SENTINEL'));
    assert.ok(liveNotes(app, 2).includes('Alex: FRESH_DIRECT_SENTINEL'));
    assert.equal(app.requests.length, 3);
  });
}

for (const meta of [null, '{"custom":7}']) {
  test(`actual fresh provider note excludes new native import without fresh source dialogue: ${meta}`, async t => {
    const app = fixture(t); const current = app.store.createConversation();
    importAll(app, { format: 'sara-export', version: 1, exportedAt: NOW, owner: {}, conversations: [{ id: 'synthetic-note-import', channel: 'web', private: 0, created_at: NOW, updated_at: NOW, messages: [{ id: 1, role: 'user', content: 'NATIVE_IMPORT_NOTE_SENTINEL', created_at: NOW, meta }] }] });
    await collect(runTurn(app, current.id, 'Current direct owner request.', undefined, { noTools: true }));
    assert.equal(app.requests.length, 1);
    assert.ok(!liveNotes(app).includes('NATIVE_IMPORT_NOTE_SENTINEL'), 'native imported source must not reach the actual provider note');
  });
}

test('legacy null-origin history remains readable but fresh continuity labels its origin unverified', async t => {
  const app = fixture(t); const source = app.store.createConversation(); const current = app.store.createConversation();
  const old = app.store.addMessage(source.id, 'user', 'LEGACY_HISTORY_SENTINEL');
  assert.equal(old.ownerOrigin ?? null, null);
  assert.equal(continuityForTurn(app, current.id)!.read(source.id).messages[0].content, 'LEGACY_HISTORY_SENTINEL');
  await collect(runTurn(app, current.id, 'Current owner request.', undefined, { noTools: true }));
  assert.ok(liveNotes(app).includes('Historical user (origin unverified): LEGACY_HISTORY_SENTINEL'));
  assert.ok(!liveNotes(app).includes('Alex: LEGACY_HISTORY_SENTINEL'));
  await collect(runTurn(app, source.id, 'DIRECT_HISTORY_SENTINEL', undefined, { noTools: true }));
  await collect(runTurn(app, current.id, 'Current owner follow-up.', undefined, { noTools: true }));
  assert.ok(liveNotes(app, 2).includes('Alex: DIRECT_HISTORY_SENTINEL'));
  assert.ok(!liveNotes(app, 2).includes('Alex: LEGACY_HISTORY_SENTINEL'));
});

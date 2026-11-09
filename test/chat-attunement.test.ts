import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type TurnOptions } from '../src/chat.ts';
import { pendingFor } from '../src/pending.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-05T15:00:00Z';

function fixture() {
  const temp = tempDir();
  const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({
    providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }],
    defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex',
    disclosureAcceptedAt: NOW, memory: { enabled: false },
  } as never);
  const conv = app.store.createConversation();
  return { app, clock, conv, close() { app.store.close(); temp.cleanup(); } };
}

test('E2 chat: a fresh direct owner turn receives trusted origin from runtime', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('Ready.'));
    for await (const _ of runTurn(f.app, f.conv.id, 'My interview is tomorrow.', undefined, { noTools: true })) void _;
    assert.equal(f.app.requests.length, 1, 'the actual fake-provider turn must complete');
    const owner = f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!;
    assert.equal(owner.ownerOrigin, 'direct-v1');
  } finally { f.close(); }
});

test('E2 chat: queued owner-web provenance survives only its actual matching pending runner', async () => {
  for (const source of ['web', 'discord', undefined]) {
    const f = fixture();
    try {
      const pending = pendingFor(f.app);
      const complete = Promise.withResolvers<void>();
      f.app.script.push(text('Ready.'));
      const added = pending.add(f.conv.id, { kind: 'queue', sender: 'owner', content: 'My interview is tomorrow.', meta: source ? { source } : {} }, async (item) => {
        try {
          for await (const _ of runTurn(f.app, f.conv.id, item.content, undefined, { noTools: true, pendingId: item.id })) void _;
          complete.resolve();
        } catch (error) { complete.reject(error); }
      });
      assert.ok(added.ok);
      pending.drain(f.conv.id);
      await complete.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(pending.busy(f.conv.id), false, 'the pending runner has finished before fixture teardown');
      const owner = f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!;
      assert.equal(owner.ownerOrigin ?? null, source === 'web' ? 'direct-v1' : null, source ?? 'unknown');
    } finally { f.close(); }
  }
});

test('E2 chat: only proven owner-web steers become current direct-owner evidence', async () => {
  for (const source of ['web', 'discord', undefined]) {
    const f = fixture();
    try {
      const pending = pendingFor(f.app);
      f.app.tools.add({
        spec: { name: 'read_file', description: 'Read fixture text', parameters: { type: 'object', properties: {} } },
        defaultPermission: 'auto',
        summarize: () => 'read fixture',
        async run() {
          const added = pending.add(f.conv.id, { kind: 'steer', sender: 'owner', content: 'You are useless.', meta: source ? { source } : {} });
          assert.ok(added.ok);
          return 'Fixture read.';
        },
      });
      f.app.script.push([call('r1', 'read_file', {})], text('Ready.'));
      for await (const _ of runTurn(f.app, f.conv.id, 'Read the fixture.')) void _;
      const steer = f.app.store.messages(f.conv.id).find((m) => m.role === 'user' && m.meta?.steer)!;
      assert.ok(steer, 'the real turn safe-point consumes the steer');
      assert.equal(steer.ownerOrigin ?? null, source === 'web' ? 'direct-v1' : null, source ?? 'unknown');
      assert.equal(f.app.inner!.get().irritation, source === 'web' ? 0.45 : 0, 'a proven steer reacts once; unknown origins never react');
    } finally { f.close(); }
  }
});

test('E2 chat: private and supplied external/client contexts cannot mint trusted origin', async () => {
  const cases: { label: string; private?: boolean; opts?: TurnOptions }[] = [
    { label: 'private', private: true },
    { label: 'external', opts: { externalApp: true } },
    { label: 'present false external', opts: { externalApp: false } },
    { label: 'empty client history', opts: { clientHistory: [] } },
    { label: 'present false room crisis', opts: { roomCrisis: false } },
  ];
  for (const entry of cases) {
    const f = fixture();
    try {
      if (entry.private) f.app.store.updateConversation(f.conv.id, { private: true });
      f.app.script.push(text('Ready.'));
      for await (const _ of runTurn(f.app, f.conv.id, 'My interview is tomorrow.', undefined, { noTools: true, ...entry.opts })) void _;
      const owners = f.app.store.messages(f.conv.id).filter((m) => m.role === 'user');
      assert.equal(owners.length, 1, entry.label);
      assert.equal(owners[0].ownerOrigin ?? null, null, entry.label);
    } finally { f.close(); }
  }
});

test('E2 chat: denied turn contexts do not mutate owner-derived inner state', async () => {
  for (const opts of [{ externalApp: true }, { untrusted: true }, { clientHistory: [] }, { resume: false }] satisfies TurnOptions[]) {
    const f = fixture();
    try {
      const before = f.app.inner!.get();
      f.app.script.push(text('Ready.'));
      for await (const _ of runTurn(f.app, f.conv.id, 'You are useless.', undefined, { noTools: true, ...opts })) void _;
      assert.deepEqual(f.app.inner!.get(), before, JSON.stringify(opts));
    } finally { f.close(); }
  }
});

test('E2 chat: ordinary private owner interaction retains named-companion legacy reactions', async () => {
  const f = fixture();
  try {
    f.app.persona.name = 'Nova';
    f.app.store.updateConversation(f.conv.id, { private: true });
    const before = f.app.inner!.get();
    f.app.script.push(text('Ready.'));
    for await (const _ of runTurn(f.app, f.conv.id, 'Nova is useless.', undefined, { noTools: true })) void _;
    assert.ok(f.app.inner!.get().irritation > before.irritation, 'actual configured name retains the true directed reaction');
    assert.equal(f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!.ownerOrigin ?? null, null);
  } finally { f.close(); }
});

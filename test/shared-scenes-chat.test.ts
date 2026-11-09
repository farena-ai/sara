import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { inputsHash, RunRecorder, RunStore } from '../src/runs.ts';
import { branchRun, rebuildStep } from '../src/replay.ts';
import { MINOR_BLOCK_REPLY, CRISIS_SYSTEM_NOTE } from '../src/safety.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const policy = await import('../src/shared-scenes-policy.ts').catch(() => undefined);
const scenes = await import('../src/shared-scenes.ts').catch(() => undefined);
const memory = await import('../src/memory-worker.ts');
const NOW = '2026-11-05T15:00:00.000Z';

function fixture() {
  assert.ok(policy?.createScene && scenes?.SharedSceneStore, 'shared scenes are missing');
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  // Continuity off: the provider-step gate must come from the scene seat itself.
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false }, chats: { continuity: { enabled: false } } } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const web = app.store.createConversation({ title: 'Web story' });
  const dm = app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'DM story' });
  const scene = policy.createScene(app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.' });
  for (const c of [web, dm]) policy.linkSeat(app, scene.id, { conversationId: c.id, expectedRevision: policy.getScene(app, scene.id).scene.revision, confirmAudience: true });
  const canon = (key: string, value: string) => policy!.setCanon(app, scene.id, { expectedRevision: policy!.getScene(app, scene.id).scene.revision, key, text: value });
  canon('inn', 'The Ember Inn burned down last night.');
  return { app, clock, web, dm, scene, canon, close() { app.store.close(); temp.cleanup(); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function collect(it: AsyncIterable<ChatEvent>) { const events: ChatEvent[] = []; for await (const e of it) events.push(e); return events; }
async function until(it: AsyncGenerator<ChatEvent>, predicate: (e: ChatEvent) => boolean) {
  for (;;) { const r = await it.next(); assert.equal(r.done, false, 'expected event before turn completed'); if (predicate(r.value)) return r.value; }
}
const blocks = (f: ReturnType<typeof fixture>, i = 0) => f.app.requests[i].messages.filter(m => m.role === 'system' && m.content.startsWith(policy!.SHARED_SCENE_MARK)).map(m => m.content);
const whole = (f: ReturnType<typeof fixture>, i = 0) => JSON.stringify(f.app.requests[i].messages);

test('R1B1 a canon change committed during one seat step is seen by the next seat step, never overlapping', async () => {
  const f = fixture(); const firstIn = deferred(); const finish = deferred();
  const original = f.app.providerFactory!; let streamed = 0; let active = 0; let overlap = false;
  f.app.providerFactory = config => {
    const p = original(config); return { ...p, config, listModels: p.listModels.bind(p), async *stream(req) {
      f.app.requests.push(structuredClone({ ...req, signal: undefined }));
      if (++active > 1) overlap = true;
      try {
        if (++streamed === 1) { firstIn.resolve(); await finish.promise; yield { type: 'text' as const, text: 'The caravan turns north.' }; }
        else yield { type: 'text' as const, text: 'Second seat answer.' };
      } finally { active--; }
    } };
  };
  const a = collect(runTurn(f.app, f.web.id, 'We ride on.', undefined, { noTools: true }));
  let second: AsyncGenerator<ChatEvent> | undefined;
  try {
    await firstIn.promise;
    assert.match(blocks(f, 0)[0], /Ember Inn burned down/);
    second = runTurn(f.app, f.dm.id, 'What do we see?', undefined, { noTools: true });
    const wait = await until(second, e => (e.type === 'notice' && e.kind !== 'disclosure') || e.type === 'token');
    assert.equal(wait.type, 'notice', 'the second seat waits for the first seat step');
    f.canon('caravan', 'The caravan now heads north to the salt flats.');
    finish.resolve(); await a; await collect(second);
    assert.equal(streamed, 2); assert.equal(overlap, false);
    assert.equal(blocks(f, 1).length, 1);
    assert.match(blocks(f, 1)[0], /salt flats/);
    assert.ok(!whole(f, 1).includes('We ride on.'), 'raw lines of another seat never move');
    const assistant = f.app.store.messages(f.web.id).find(m => m.role === 'assistant')!;
    assert.equal((assistant.meta?.scene as { id: number }).id, f.scene.id);
    const run = f.app.runs!.list().find(r => r.conversationId === f.dm.id)!;
    const step = f.app.runs!.steps(run.id)[0];
    assert.equal(step.inputsSha, inputsHash(f.app.requests[1].messages.slice(1)));
    assert.deepEqual(step.extra.filter(x => x.startsWith(policy!.SHARED_SCENE_MARK)), blocks(f, 1), 'recorder captures the block actually sent');
  } finally { finish.resolve(); await a; await second?.return(undefined); f.close(); }
});

test('R1B1 revocation while hooks wait drops the block before the provider call', async () => {
  for (const change of ['unlink', 'private', 'pause', 'setting', 'delete']) {
    const f = fixture();
    try {
      f.app.script.push(text('Ok.'));
      await collect(runTurn(f.app, f.web.id, 'Go on.', undefined, { noTools: true, hooks: { async beforeModelCall() {
        await Promise.resolve();
        const rev = policy!.getScene(f.app, f.scene.id).scene.revision;
        if (change === 'unlink') policy!.unlinkSeat(f.app, f.scene.id, f.web.id, rev);
        else if (change === 'private') f.app.store.db.prepare('UPDATE conversations SET private=1 WHERE id=?').run(f.web.id);
        else if (change === 'pause') policy!.updateScene(f.app, f.scene.id, { expectedRevision: rev, status: 'paused' });
        else if (change === 'setting') f.app.settings.update({ chats: { continuity: { enabled: false }, scenes: { enabled: false } } } as never);
        else policy!.deleteScene(f.app, f.scene.id, rev);
      } } }));
      // A privacy move also changes the admitted tool scope, so that turn stops before any provider call.
      assert.equal(f.app.requests.length, change === 'private' ? 0 : 1, change);
      if (f.app.requests.length) assert.deepEqual(blocks(f), [], change);
    } finally { f.close(); }
  }
});

test('R1B1 a crisis turn steps out of the story; the block returns on the next turn', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('I am here with you.'), text('Back to the road.'));
    const events = await collect(runTurn(f.app, f.web.id, 'I want to kill myself tonight.', undefined, { noTools: true }));
    assert.ok(events.some(e => e.type === 'notice' && e.kind === 'crisis'));
    assert.deepEqual(blocks(f, 0), []);
    assert.ok(f.app.requests[0].messages[0].content.includes(CRISIS_SYSTEM_NOTE));
    await collect(runTurn(f.app, f.web.id, 'Thanks. Shall we ride on?', undefined, { noTools: true }));
    assert.equal(blocks(f, 1).length, 1);
  } finally { f.close(); }
});

test('R1B1 a minors message is blocked before any scene code runs', async () => {
  const f = fixture();
  const proto = scenes!.SharedSceneStore.prototype as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor').map(n => [n, proto[n]]));
  try {
    const before = JSON.stringify(f.app.store.db.prepare('SELECT * FROM scenes').all());
    for (const n of Object.keys(saved)) proto[n] = () => { throw new Error(`scene code reached: ${n}`); };
    const events = await collect(runTurn(f.app, f.web.id, 'In the story the 12 year old girl has sex with him.', undefined, { noTools: true }));
    for (const [n, v] of Object.entries(saved)) proto[n] = v;
    assert.ok(events.some(e => e.type === 'token' && e.text === MINOR_BLOCK_REPLY));
    assert.equal(f.app.requests.length, 0);
    assert.equal(JSON.stringify(f.app.store.db.prepare('SELECT * FROM scenes').all()), before);
  } finally { for (const [n, v] of Object.entries(saved)) proto[n] = v; f.close(); }
});

test('R1B1 an adult scene injects nothing while adult mode is off', async () => {
  const f = fixture();
  try {
    f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
    const rev = policy!.getScene(f.app, f.scene.id).scene.revision;
    policy!.updateScene(f.app, f.scene.id, { expectedRevision: rev, adult: true });
    f.app.script.push(text('One.'), text('Two.'));
    await collect(runTurn(f.app, f.web.id, 'Hello.', undefined, { noTools: true }));
    assert.equal(blocks(f, 0).length, 1);
    f.app.settings.update({ adultMode: { on: false } } as never);
    await collect(runTurn(f.app, f.web.id, 'Hello again.', undefined, { noTools: true }));
    assert.deepEqual(blocks(f, 1), []);
  } finally { f.close(); }
});

test('R1B1 the stop word pauses the shared scene for every seat in that turn', async () => {
  const f = fixture();
  try {
    (f.app.persona as { intimacy?: { stopWord?: string } }).intimacy = { ...(f.app.persona.intimacy ?? {}), stopWord: 'saffron' };
    f.app.script.push(text('Stopping.'), text('Plain.'));
    await collect(runTurn(f.app, f.web.id, 'saffron', undefined, { noTools: true }));
    assert.deepEqual(blocks(f, 0), []);
    assert.equal(policy!.getScene(f.app, f.scene.id).scene.status, 'paused');
    await collect(runTurn(f.app, f.dm.id, 'Hi.', undefined, { noTools: true }));
    assert.deepEqual(blocks(f, 1), []);
  } finally { f.close(); }
});

test('R1B1 external apps, outside agents and non-seat conversations see no scene', async () => {
  const f = fixture();
  try {
    const other = f.app.store.createConversation({ title: 'Not linked' });
    const api = f.app.store.createConversation({ channel: 'api' });
    f.app.script.push(text('a'), text('b'), text('c'));
    await collect(runTurn(f.app, f.web.id, 'From an app.', undefined, { noTools: true, externalApp: true } as never));
    await collect(runTurn(f.app, other.id, 'Plain chat.', undefined, { noTools: true }));
    await collect(runTurn(f.app, api.id, 'Via /v1.', undefined, { noTools: true, externalApp: true } as never));
    for (let i = 0; i < 3; i++) { assert.deepEqual(blocks(f, i), [], String(i)); assert.ok(!whole(f, i).includes('Ember Inn'), String(i)); }
  } finally { f.close(); }
});

test('R1B1 memory labels scene turns as fiction', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('The dunes shimmer.'));
    await collect(runTurn(f.app, f.web.id, 'I draw my sword.', undefined, { noTools: true }));
    const rows = f.app.store.messages(f.web.id);
    const ids = memory.sceneTurnIds(rows);
    const user = rows.find(m => m.role === 'user')!; const reply = rows.find(m => m.role === 'assistant')!;
    assert.ok(ids.has(user.id) && ids.has(reply.id));
    for (const m of [user, reply]) assert.match(memory.transcriptLine(m, 'Alex', 'UTC', 'Sara', ids.has(m.id))!, /shared scene \(fiction/);
    assert.equal(JSON.stringify(rows).includes('Ember Inn'), false, 'canon text is never written to messages');
  } finally { f.close(); }
});

test('R1B1 replay omits the scene block, is inexact and does no scene lookup', async () => {
  const f = fixture();
  const proto = scenes!.SharedSceneStore.prototype as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor').map(n => [n, proto[n]]));
  try {
    const user = f.app.store.addMessage(f.web.id, 'user', 'Ordinary line.');
    const generated = `${policy!.SHARED_SCENE_MARK}\n## Shared scene (fiction)\n{}`;
    const rec = new RunRecorder(f.app.runs, { kind: 'turn', conversationId: f.web.id, userMessageId: user.id });
    rec.startStep({ system: 'Fixture system.', historyFromId: user.id, historyToId: user.id, extra: [generated], inputsSha: inputsHash([{ role: 'user', content: 'Ordinary line.' }, { role: 'system', content: generated }]) });
    rec.modelCall({ model: 'fixture', provider: 'Fixture', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true }); rec.close('ok');
    for (const n of Object.keys(saved)) proto[n] = () => { throw new Error(`replay reached scene code: ${n}`); };
    const rebuilt = rebuildStep(f.app, rec.id, 0);
    assert.equal(rebuilt.exact, false); assert.deepEqual(rebuilt.extra, []);
    assert.ok(rebuilt.problems.some(p => p.key.includes('Shared scene')));
    f.app.script.push(text('Branch answer.'));
    const events: any[] = [];
    for await (const event of branchRun(f.app, rec.id, { fromStep: 0, notes: [generated], recall: false, sandbox: { keep: false } })) events.push(event);
    assert.equal(f.app.requests.length, 1);
    assert.deepEqual(blocks(f, 0), []);
    assert.equal(events.find((e: any) => e.type === 'branch')?.exact, false);
  } finally { for (const [n, v] of Object.entries(saved)) proto[n] = v; f.close(); }
});

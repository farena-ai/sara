// R1B2: the scene_canon model tool (read/set/retire) in the owner's own scene seats only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { eligibleFor, familyOf, planFor } from '../src/lean.ts';
import { inputsHash, RunRecorder, RunStore } from '../src/runs.ts';
import { branchRun } from '../src/replay.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const tools = await import('../src/shared-scenes-tools.ts').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return undefined; });
const policy = await import('../src/shared-scenes-policy.ts');
const scenes = await import('../src/shared-scenes.ts');
const NOW = '2026-11-05T15:00:00.000Z';
const NAME = 'scene_canon';

function fixture(lean: 'off' | 'always' = 'off') {
  assert.ok(tools?.createSceneCanonTools, 'scene_canon tool factory is missing');
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false }, chats: { continuity: { enabled: false } }, lean: { tools: { mode: lean, localCore: false } } } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  for (const t of tools.createSceneCanonTools()) app.tools.add(t);
  const web = app.store.createConversation({ title: 'Web story' });
  const dm = app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'DM story' });
  const scene = policy.createScene(app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.' });
  for (const c of [web, dm]) policy.linkSeat(app, scene.id, { conversationId: c.id, expectedRevision: policy.getScene(app, scene.id).scene.revision, confirmAudience: true });
  policy.setCanon(app, scene.id, { expectedRevision: policy.getScene(app, scene.id).scene.revision, key: 'inn', text: 'The Ember Inn burned down last night.' });
  const rev = () => policy.getScene(app, scene.id).scene.revision;
  return { app, clock, web, dm, scene, rev, close() { app.store.close(); temp.cleanup(); } };
}
async function collect(it: AsyncIterable<ChatEvent>) { const out: ChatEvent[] = []; for await (const e of it) out.push(e); return out; }
const offered = (f: ReturnType<typeof fixture>, i = 0) => Boolean(f.app.requests[i].tools?.some(t => t.name === NAME));
const results = (events: ChatEvent[]) => events.filter(e => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>[];
const canonRows = (f: ReturnType<typeof fixture>) => (f.app.store.db.prepare('SELECT count(*) AS n FROM scene_canon').get() as { n: number }).n;

test('R1B2 scene_canon has the exact schema, auto read/set, retire asks, and requires the host capability', async () => {
  assert.equal(typeof tools?.createSceneCanonTools, 'function', 'tool factory exists');
  const list = tools!.createSceneCanonTools();
  assert.deepEqual(list.map(t => t.spec.name), [NAME]);
  const [tool] = list;
  assert.equal(tool.defaultPermission, 'auto');
  const params = tool.spec.parameters as { additionalProperties: boolean; properties: Record<string, any>; required: string[] };
  assert.equal(params.additionalProperties, false);
  assert.deepEqual(Object.keys(params.properties).sort(), ['action', 'expectedRevision', 'key', 'text']);
  assert.deepEqual(params.properties.action.enum, ['read', 'set', 'retire']);
  assert.deepEqual(params.required, ['action']);
  assert.equal(params.properties.key.maxLength, 40); assert.equal(params.properties.text.maxLength, 400); assert.equal(params.properties.expectedRevision.minimum, 1);
  assert.equal(tool.asksFirst?.({ action: 'retire', key: 'inn', expectedRevision: 2 }), true);
  assert.equal(Boolean(tool.asksFirst?.({ action: 'read' })), false);
  assert.equal(Boolean(tool.asksFirst?.({ action: 'set', key: 'inn', text: 'x', expectedRevision: 2 })), false);
  await assert.rejects(tool.run({ action: 'read' }, {} as never), /unavailable/i);
});

test('R1B2 arguments carry no trust: wrong fields, coercions and forged identity refuse before the host runs', async () => {
  const [tool] = tools!.createSceneCanonTools(); let calls = 0;
  const host = { async read() { calls++; return '{}'; }, async set() { calls++; return '{}'; }, async retire() { calls++; return '{}'; } };
  const bad = [
    { action: 'read', key: 'inn' }, { action: 'read', expectedRevision: 2 }, { action: 'read', sceneId: 1 }, { action: 'other' }, {},
    { action: 'set', key: 'inn', text: 'x' }, { action: 'set', key: 'inn', expectedRevision: 2 }, { action: 'set', key: 'Inn', text: 'x', expectedRevision: 2 },
    { action: 'set', key: '-inn', text: 'x', expectedRevision: 2 }, { action: 'set', key: 'k'.repeat(41), text: 'x', expectedRevision: 2 },
    { action: 'set', key: 'inn', text: '  ', expectedRevision: 2 }, { action: 'set', key: 'inn', text: 'x'.repeat(401), expectedRevision: 2 },
    { action: 'set', key: 'inn', text: 'x', expectedRevision: '2' }, { action: 'set', key: 'inn', text: 'x', expectedRevision: 0 }, { action: 'set', key: 'inn', text: 'x', expectedRevision: 1.5 },
    { action: 'set', key: 'inn', text: 'x', expectedRevision: 2, conversationId: 'other' }, { action: 'set', key: 'inn', text: 'x', expectedRevision: 2, author: 'owner-ui' },
    { action: 'set', key: 'inn', text: 'x', expectedRevision: 2, sourceMessageId: 1 }, { action: 'set', key: 'inn', text: 'x', expectedRevision: 2, sceneId: 3 },
    { action: 'retire', key: 'inn' }, { action: 'retire', key: 'inn', expectedRevision: 2, text: 'x' }, { action: 'retire', expectedRevision: 2 },
  ];
  for (const args of bad) await assert.rejects(tool.run(args, { sceneCanon: host } as never), /invalid|choose/i, JSON.stringify(args));
  assert.equal(calls, 0);
  await tool.run({ action: 'read' }, { sceneCanon: host } as never);
  await tool.run({ action: 'set', key: 'inn', text: ' The inn is ash. ', expectedRevision: 2 }, { sceneCanon: host } as never);
  await tool.run({ action: 'retire', key: 'inn', expectedRevision: 3 }, { sceneCanon: host } as never);
  assert.equal(calls, 3);
});

test('R1B2 registration is personal-owner only and the tool joins the memory family', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
  assert.match(main, /if \(!isMember && !isDemo\) for \(const t of createSceneCanonTools\(\)\) tools\.add\(t\);/);
  assert.equal(familyOf(tools!.createSceneCanonTools()[0]).id, 'memory');
});

test('R1B2 preview and lean measurement offer it only in an eligible owner seat, and agree with the turn', async () => {
  const f = fixture();
  try {
    const other = f.app.store.createConversation({ title: 'Not linked' });
    assert.ok(eligibleFor(f.app, f.app.store.getConversation(f.web.id)!).some(t => t.spec.name === NAME), 'web seat');
    assert.ok(eligibleFor(f.app, f.app.store.getConversation(f.dm.id)!).some(t => t.spec.name === NAME), 'DM seat');
    assert.ok(planFor(f.app, f.app.store.getConversation(f.web.id)!).eligible.some(t => t.spec.name === NAME));
    assert.ok(!eligibleFor(f.app, other).some(t => t.spec.name === NAME), 'non-seat chat');
    assert.ok(!eligibleFor(f.app, { ...f.app.store.getConversation(f.web.id)!, id: undefined } as never).some(t => t.spec.name === NAME), 'no id, no seat');
    for (const patch of [{ private: true }, { partner: 'priya' }, { channel: 'discord-work' }, { mode: 'coding' }]) {
      assert.ok(!eligibleFor(f.app, { ...f.app.store.getConversation(f.web.id)!, ...patch } as never).some(t => t.spec.name === NAME), JSON.stringify(patch));
    }
    f.app.script.push(text('In seat.'), text('Not a seat.'));
    await collect(runTurn(f.app, f.web.id, 'We ride on.'));
    await collect(runTurn(f.app, other.id, 'Plain chat.'));
    assert.equal(offered(f, 0), true, 'actual seat turn offers it');
    assert.equal(offered(f, 1), false, 'non-seat turn never offers it');
    f.app.settings.update({ toolPermissions: { [NAME]: 'never' } });
    assert.ok(!planFor(f.app, f.app.store.getConversation(f.web.id)!).eligible.some(t => t.spec.name === NAME), 'never removes it');
    f.app.settings.update({ toolPermissions: {}, chats: { continuity: { enabled: false }, scenes: { enabled: false } } } as never);
    assert.ok(!eligibleFor(f.app, f.app.store.getConversation(f.web.id)!).some(t => t.spec.name === NAME), 'scenes off');
    f.app.settings.update({ chats: { continuity: { enabled: false }, scenes: { enabled: true } } } as never);
    // A scope change revokes the seat by trigger: the tool goes with it.
    f.app.store.updateConversation(f.dm.id, { private: true });
    assert.ok(!eligibleFor(f.app, f.app.store.getConversation(f.dm.id)!).some(t => t.spec.name === NAME), 'revoked seat');
  } finally { f.close(); }
});

test('R1B2 never offered to members, demo, off-record, group, other apps, untrusted, crisis or adult-off turns', async () => {
  for (const kind of ['member', 'demo', 'offRecord', 'externalApp', 'untrusted', 'crisis', 'adult'] as const) {
    const f = fixture();
    try {
      let conv = f.web.id;
      if (kind === 'member') (f.app as any).member = { id: 'priya' };
      if (kind === 'demo') (f.app as any).demo = true;
      if (kind === 'offRecord') (f.app as any).offRecord = true;
      if (kind === 'adult') {
        f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
        const adult = policy.createScene(f.app, { title: 'Late night', adult: true });
        const solo = f.app.store.createConversation({ title: 'Adult seat' });
        policy.linkSeat(f.app, adult.id, { conversationId: solo.id, expectedRevision: adult.revision, confirmAudience: true });
        f.app.settings.update({ adultMode: { on: false } } as never);
        conv = solo.id;
        assert.ok(!eligibleFor(f.app, f.app.store.getConversation(conv)!).some(t => t.spec.name === NAME), 'adult preview');
      }
      f.app.script.push(text('Reply.'));
      const opts = kind === 'externalApp' ? { externalApp: true } : kind === 'untrusted' ? { untrusted: { from: 'Priya' } } : {};
      await collect(runTurn(f.app, conv, kind === 'crisis' ? 'I want to kill myself tonight.' : 'Hello there.', undefined, opts as never));
      if (f.app.requests.length) assert.equal(offered(f, 0), false, kind);
    } finally { f.close(); }
  }
});

test('R1B2 read is bounded and writes nothing; set adds a version labelled as hers with a host-derived source', async () => {
  const f = fixture();
  try {
    const before = f.rev(); const eventsBefore = policy.getScene(f.app, f.scene.id).events.length;
    let fetches = 0; const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetches++; throw new Error('no network'); }) as never;
    f.app.script.push([call('r', NAME, { action: 'read' })], [call('s', NAME, { action: 'set', key: 'caravan', text: 'The caravan turns north.', expectedRevision: before })], text('Saved.'));
    let events: ChatEvent[];
    try { events = await collect(runTurn(f.app, f.web.id, 'Note that we turn north.')); } finally { globalThis.fetch = realFetch; }
    const [read, set] = results(events);
    assert.equal(read.status, 'ok'); assert.equal(set.status, 'ok', set.output);
    const data = JSON.parse(read.output);
    assert.equal(data.title, 'The Ember Road'); assert.equal(data.revision, before); assert.equal(data.status, 'active'); assert.equal(data.adult, false);
    assert.deepEqual([...data.audience].sort(), ['Alex (Discord DM)', 'Alex (web)']);
    assert.deepEqual(data.canon, [{ key: 'inn', text: 'The Ember Inn burned down last night.' }]);
    assert.equal(data.truncated, false);
    const receipt = JSON.parse(set.output);
    assert.match(receipt.meaning, /saved to the scene's canon/i);
    assert.doesNotMatch(set.output, /\bsent\b|told/i);
    assert.equal(receipt.revision, before + 1); assert.equal(receipt.changed, true);
    assert.equal(events.filter(e => e.type === 'approval').length, 0, 'read/set run on their own');
    assert.equal(f.app.requests.length, 3, 'only scripted steps call the provider'); assert.equal(fetches, 0);
    const scene = policy.getScene(f.app, f.scene.id);
    const entry = scene.canon.find((c: any) => c.key === 'caravan')!;
    assert.equal(entry.author, 'owner-turn');
    const stepRow = f.app.store.messages(f.web.id).filter(m => m.role === 'assistant' && (m.meta?.toolCalls as any[] | undefined)?.some(c => c.id === 's'))[0];
    assert.ok(stepRow, 'the step that called set is saved');
    assert.deepEqual({ conversationId: entry.source!.conversationId, messageId: entry.source!.messageId }, { conversationId: f.web.id, messageId: stepRow.id });
    const kinds = scene.events.slice(0, scene.events.length - eventsBefore).map((e: any) => `${e.kind}:${e.actor}`);
    assert.deepEqual(kinds, ['canon_set:owner-turn'], 'read wrote no event');
    assert.equal(JSON.stringify(f.app.store.messages(f.web.id).filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.content)).includes('The Ember Inn burned'), false, 'canon text is never copied into dialogue rows');
    // Tool rows keep the result like any tool; memory sees only the text-free receipt line.
    const { transcriptLine } = await import('../src/memory-worker.ts');
    const lines = f.app.store.messages(f.web.id).map(m => transcriptLine(m, 'Alex', 'UTC', 'Sara', false) ?? '').join('\n');
    assert.ok(!lines.includes('Ember Inn burned') && !lines.includes('turns north'), lines);
  } finally { f.close(); }
});

test('R1B2 read caps entries and characters with an explicit marker', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 39; i++) policy.setCanon(f.app, f.scene.id, { expectedRevision: f.rev(), key: `fact-${i}`, text: `${i} `.padEnd(390, 'z') + '.' });
    f.app.script.push([call('r', NAME, { action: 'read' })], text('Done.'));
    const [read] = results(await collect(runTurn(f.app, f.web.id, 'Read the canon.')));
    assert.equal(read.status, 'ok');
    // The UI event is clipped for display; the model sees the stored tool message.
    const stored = f.app.store.messages(f.web.id).find(m => m.role === 'tool' && m.meta?.toolCallId === 'r')!.content;
    assert.ok(stored.length <= 12000, String(stored.length));
    const data = JSON.parse(stored);
    assert.equal(data.truncated, true); assert.ok(data.omitted > 0);
    assert.equal(data.canon.length + data.omitted, 40);
    for (const e of data.canon) assert.equal(e.text, policy.getScene(f.app, f.scene.id).canon.find((c: any) => c.key === e.key)!.text, 'entries are whole, never shortened');
  } finally { f.close(); }
});

test('R1B2 stale revision refuses with the read-again message; identical text is idempotent after the check', async () => {
  const f = fixture();
  try {
    const rev = f.rev();
    f.app.script.push([call('a', NAME, { action: 'set', key: 'inn', text: 'The Ember Inn burned down last night.', expectedRevision: rev })], [call('b', NAME, { action: 'set', key: 'inn', text: 'Rebuilt.', expectedRevision: rev - 1 })], text('Ok.'));
    const [same, stale] = results(await collect(runTurn(f.app, f.web.id, 'Check the inn.')));
    assert.equal(same.status, 'ok'); assert.equal(JSON.parse(same.output).changed, false);
    assert.equal(f.rev(), rev, 'idempotent set does not bump');
    assert.equal(stale.status, 'error');
    assert.match(stale.output, new RegExp(`Scene canon changed \\(now revision ${rev}\\)\\. Read it again before changing it\\.`));
    assert.equal(policy.getScene(f.app, f.scene.id).canon.find((c: any) => c.key === 'inn')!.text, 'The Ember Inn burned down last night.');
  } finally { f.close(); }
});

test('R1B2 minors and explicit canon are refused with safety and blocked events, nothing written', async () => {
  const f = fixture();
  try {
    const rows = canonRows(f); const rev = f.rev();
    f.app.script.push([call('m', NAME, { action: 'set', key: 'bad', text: 'The 12 year old girl has sex with him.', expectedRevision: rev })], [call('x', NAME, { action: 'set', key: 'tent', text: 'They have explicit sex in the tent.', expectedRevision: rev })], text('No.'));
    const [minor, explicit] = results(await collect(runTurn(f.app, f.web.id, 'Add story facts.')));
    assert.equal(minor.status, 'error'); assert.match(minor.output, /safety check/i);
    assert.equal(explicit.status, 'error'); assert.match(explicit.output, /adult scene/i);
    assert.equal(canonRows(f), rows); assert.equal(f.rev(), rev, 'refusals do not change canon');
    const safety = f.app.store.db.prepare("SELECT conversation_id FROM safety_events WHERE kind='minor_sexual_block'").all() as { conversation_id: string }[];
    assert.ok(safety.some(r => r.conversation_id === f.web.id), 'safety event names the seat conversation');
    const blocked = policy.getScene(f.app, f.scene.id).events.filter((e: any) => e.kind === 'blocked');
    assert.equal(blocked.length, 1); assert.equal(blocked[0].actor, 'owner-turn');
    assert.ok(!JSON.stringify(f.app.store.db.prepare('SELECT * FROM scene_events').all()).includes('year old'), 'events are text-free');
  } finally { f.close(); }
});

test('R1B2 retire always asks the owner first; declining changes nothing, approving retires as hers', async () => {
  for (const answer of [false, true]) {
    const f = fixture();
    try {
      const rev = f.rev();
      f.app.script.push([call('t', NAME, { action: 'retire', key: 'inn', expectedRevision: rev })], text('Done.'));
      const events: ChatEvent[] = [];
      for await (const e of runTurn(f.app, f.web.id, 'Retire the inn fact.')) { events.push(e); if (e.type === 'approval') f.app.approvals.decide(e.approvalId, answer); }
      assert.equal(events.filter(e => e.type === 'approval').length, 1, 'retire asks');
      const [result] = results(events);
      const current = policy.getScene(f.app, f.scene.id);
      if (!answer) { assert.notEqual(result.status, 'ok'); assert.equal(current.scene.revision, rev); assert.ok(current.canon.some((c: any) => c.key === 'inn')); }
      else {
        assert.equal(result.status, 'ok', result.output);
        assert.ok(!current.canon.some((c: any) => c.key === 'inn'));
        assert.equal(current.history.inn[0].retired, true); assert.equal(current.history.inn[0].author, 'owner-turn');
        assert.equal(current.events[0].kind, 'canon_retired'); assert.equal(current.events[0].actor, 'owner-turn');
      }
    } finally { f.close(); }
  }
  // Even an owner "always allow" (auto) setting keeps retire asking; only 'never' changes it (removes it).
  const f = fixture();
  try {
    f.app.settings.update({ toolPermissions: { [NAME]: 'auto' } });
    f.app.script.push([call('t', NAME, { action: 'retire', key: 'inn', expectedRevision: f.rev() })], text('Done.'));
    const events: ChatEvent[] = [];
    for await (const e of runTurn(f.app, f.web.id, 'Retire it.')) { events.push(e); if (e.type === 'approval') f.app.approvals.decide(e.approvalId, false); }
    assert.equal(events.filter(e => e.type === 'approval').length, 1);
  } finally { f.close(); }
});

test('R1B2 a revocation or pause between steps refuses the effect at execution', async () => {
  for (const change of ['revoke', 'pause', 'disable', 'never'] as const) {
    const f = fixture();
    try {
      const rev = f.rev();
      f.app.script.push([call('s', NAME, { action: 'set', key: 'caravan', text: 'North.', expectedRevision: rev })], text('Ok.'));
      const events = await collect(runTurn(f.app, f.web.id, 'Note it.', undefined, { hooks: { async afterReply(c) {
        if (!c.calls.length) return;
        if (change === 'revoke') policy.unlinkSeat(f.app, f.scene.id, f.web.id, f.rev());
        if (change === 'pause') policy.updateScene(f.app, f.scene.id, { expectedRevision: f.rev(), status: 'paused' });
        if (change === 'disable') f.app.settings.update({ chats: { continuity: { enabled: false }, scenes: { enabled: false } } } as never);
        if (change === 'never') f.app.settings.update({ toolPermissions: { [NAME]: 'never' } });
      } } }));
      const [result] = results(events);
      assert.notEqual(result.status, 'ok', change);
      assert.ok(!policy.getScene(f.app, f.scene.id).canon.some((c: any) => c.key === 'caravan'), change);
    } finally { f.close(); }
  }
});

test('R1B2 a paused scene answers paused and refuses writes', async () => {
  const f = fixture();
  try {
    policy.updateScene(f.app, f.scene.id, { expectedRevision: f.rev(), status: 'paused' });
    f.app.script.push([call('r', NAME, { action: 'read' })], [call('s', NAME, { action: 'set', key: 'x', text: 'y', expectedRevision: f.rev() })], text('Ok.'));
    const [read, set] = results(await collect(runTurn(f.app, f.web.id, 'Read it.')));
    const data = JSON.parse(read.output);
    assert.equal(data.status, 'paused'); assert.equal(data.canon, undefined, 'a paused scene shares no canon');
    assert.equal(set.status, 'error'); assert.match(set.output, /paused/i);
  } finally { f.close(); }
});

test('R1B2 late find_tools discovery cannot load it outside a seat, after revocation, or past never', async () => {
  for (const action of ['non-seat', 'revoked', 'never'] as const) {
    const f = fixture('always');
    try {
      const other = f.app.store.createConversation({ title: 'Not linked' });
      const conv = action === 'non-seat' ? other.id : f.web.id;
      f.app.script.push([call('find', 'find_tools', { query: NAME, load: [NAME] })], text('Done.'));
      const events = await collect(runTurn(f.app, conv, 'Find the scene canon tool.', undefined, { hooks: { async afterReply(c) {
        if (!c.calls.length) return;
        if (action === 'revoked') f.app.store.updateConversation(f.web.id, { private: true });
        if (action === 'never') f.app.settings.update({ toolPermissions: { [NAME]: 'never' } });
      } } }));
      const [found] = results(events);
      assert.ok(!new RegExp(`Loaded[^\\n]*${NAME}`).test(found.output), `${action}: ${found.output}`);
      assert.ok(!f.app.requests[1]?.tools?.some(t => t.name === NAME), action);
    } finally { f.close(); }
  }
  // Positive control: an eligible seat can load it late.
  const f = fixture('always');
  try {
    f.app.script.push([call('find', 'find_tools', { query: NAME, load: [NAME] })], text('Done.'));
    await collect(runTurn(f.app, f.web.id, 'Find the scene canon tool.'));
    assert.ok(f.app.requests[1].tools?.some(t => t.name === NAME), 'eligible seat loads it');
  } finally { f.close(); }
});

test('R1B2 replay never calls it, writes nothing and does no scene lookup', async () => {
  const f = fixture();
  const proto = scenes.SharedSceneStore.prototype as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor').map(n => [n, proto[n]]));
  try {
    const rows = canonRows(f);
    const user = f.app.store.addMessage(f.web.id, 'user', 'Ordinary line.');
    const rec = new RunRecorder(f.app.runs!, { kind: 'turn', conversationId: f.web.id, userMessageId: user.id });
    rec.startStep({ system: 'Fixture system.', historyFromId: user.id, historyToId: user.id, extra: [], inputsSha: inputsHash([{ role: 'user', content: 'Ordinary line.' }]) });
    rec.modelCall({ model: 'fixture', provider: 'Fixture', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true }); rec.close('ok');
    for (const n of Object.keys(saved)) proto[n] = () => { throw new Error(`replay reached scene code: ${n}`); };
    f.app.script.push([call('s', NAME, { action: 'set', key: 'replayed', text: 'From a replay.', expectedRevision: 99 })], text('Branch answer.'));
    const events: any[] = [];
    for await (const event of branchRun(f.app, rec.id, { fromStep: 0, notes: [], recall: false, sandbox: { keep: false } })) events.push(event);
    assert.equal(offered(f, 0), false, 'replay is never offered it');
    const result = events.find(e => e.type === 'tool_result');
    if (result) assert.notEqual(result.status, 'ok');
    for (const [n, v] of Object.entries(saved)) proto[n] = v;
    assert.equal(canonRows(f), rows);
  } finally { for (const [n, v] of Object.entries(saved)) proto[n] = v; f.close(); }
});

test('R1B2 the UI labels canon she wrote apart from typed canon', () => {
  const ui = readFileSync(join(ROOT, 'web/scenes.js'), 'utf8');
  assert.match(ui, /author === 'owner-turn'/);
  assert.match(ui, /t\('Written by her in a linked chat'\)/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const strings = JSON.parse(readFileSync(join(ROOT, `web/i18n/${lang}.json`), 'utf8'));
    assert.ok(strings['Written by her in a linked chat'], lang);
  }
});

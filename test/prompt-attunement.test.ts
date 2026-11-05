import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_CUES_MARK } from '../src/attunement.ts';
import { runTurn, type TurnOptions } from '../src/chat.ts';
import { ownerCueNote } from '../src/owner-cues.ts';
import { branchRun, rebuildStep } from '../src/replay.ts';
import { inputsHash, RunRecorder, RunStore } from '../src/runs.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-05T15:00:00Z';
function fixture() {
  const temp = tempDir();
  const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false } } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const conv = app.store.createConversation();
  return { app, clock, conv, close() { app.store.close(); temp.cleanup(); } };
}
type Fixture = ReturnType<typeof fixture>;
const cueExtras = (f: Fixture, index = 0) => f.app.requests[index].messages.slice(1).filter((m) => m.role === 'system' && m.content.startsWith(OWNER_CUES_MARK)).map((m) => m.content);
async function turn(f: Fixture, message: string, opts: TurnOptions = {}) {
  f.app.script.push(text('Ready.'));
  for await (const _ of runTurn(f.app, f.conv.id, message, undefined, { noTools: true, ...opts })) void _;
}

test('E2 prompt: awaited edits use the current cue in actual provider input and the ordinary audit', async () => {
  const f = fixture();
  try {
    let calls = 0;
    await turn(f, 'I am exhausted.', { hooks: { async beforeModelCall() {
      calls++;
      await Promise.resolve();
      const row = f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!;
      f.app.store.updateMessageContent(row.id, 'This build is frustrating.');
      return { notes: ['A valid late hook note.'] };
    } } });
    const expected = ownerCueNote(f.app, f.conv.id, {})!;
    assert.ok(expected?.startsWith(OWNER_CUES_MARK));
    assert.deepEqual(cueExtras(f), [expected]);
    assert.ok(!f.app.requests[0].messages[0].content.includes(OWNER_CUES_MARK));
    assert.equal(calls, 1, 'refreshing inputs must not rerun side-effectful hooks');
    const run = f.app.runs!.list({ conversationId: f.conv.id })[0];
    const steps = f.app.runs!.steps(run.id);
    assert.equal(steps.length, 1, 'one actual model step remains one recorded step');
    assert.deepEqual(steps[0].extra, ['A valid late hook note.', expected]);
    assert.equal(steps[0].inputsSha, inputsHash(f.app.requests[0].messages.slice(1)));
    assert.ok(!f.app.store.messages(f.conv.id).some((m) => m.content.startsWith(OWNER_CUES_MARK)), 'cue is not stored as dialogue');
  } finally { f.close(); }
});

test('E2 prompt: source and context revocation during awaited hooks removes cues before handoff', async () => {
  const mutations: [string, (f: Fixture, id: number) => void][] = [
    ['edit', (f, id) => f.app.store.updateMessageContent(id, 'The weather is pleasant.')],
    ['delete', (f, id) => { f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(id); }],
    ['forget', (f, id) => f.app.store.updateMessageMeta(id, { forgotten: true })],
    ['private', (f) => { f.app.store.updateConversation(f.conv.id, { private: true }); }],
    ['opt out', (f) => { f.app.settings.update({ persona: { innerLife: false } } as never); }],
    ['expiry', (f) => { f.clock.now = new Date(Date.parse(NOW) + 30 * 60_000); }],
  ];
  for (const [label, mutate] of mutations) {
    const f = fixture();
    try {
      let observed = false;
      await turn(f, 'I am exhausted.', { hooks: { async beforeModelCall() {
        assert.ok(ownerCueNote(f.app, f.conv.id, {}), `${label}: eligible before awaited mutation`);
        observed = true;
        await Promise.resolve();
        mutate(f, f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!.id);
      } } });
      assert.ok(observed);
      if (label === 'private') {
        assert.equal(f.app.requests.length, 0, 'existing privacy admission guard aborts before handoff');
        continue;
      }
      assert.equal(f.app.requests.length, 1, label);
      assert.deepEqual(cueExtras(f), [], label);
      const step = f.app.runs!.steps(f.app.runs!.list()[0].id)[0];
      assert.ok(!step.extra.some((x) => x.startsWith(OWNER_CUES_MARK)), label);
      assert.equal(step.inputsSha, inputsHash(f.app.requests[0].messages.slice(1)), label);
    } finally { f.close(); }
  }
});

test('E2 prompt: actual supplied denial options remain denied and ordinary internal recorder allows cues', async () => {
  for (const opts of [{}, { roomCrisis: false }, { persist: undefined }, { recorder: RunRecorder.none() }, { resume: false }, { resume: true }, { pendingId: 'unknown-pending' }] satisfies TurnOptions[]) {
    const f = fixture();
    try {
      const source = f.app.store.addMessage(f.conv.id, 'user', 'I am exhausted.');
      f.app.store.markDirectOwnerMessage(source.id);
      await turn(f, 'Please continue.', opts);
      assert.equal(cueExtras(f).length, Object.keys(opts).length ? 0 : 1, JSON.stringify(opts));
    } finally { f.close(); }
  }
});

test('E2 prompt: every actual tool-loop step rebuilds cues and preserves individual audit steps', async () => {
  const f = fixture();
  try {
    f.app.tools.add({ spec: { name: 'read_file', description: 'read fixture', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'read fixture', async run() {
      const row = f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!;
      f.app.store.updateMessageContent(row.id, "I'm no longer tired.");
      return 'Read fixture.';
    } });
    f.app.script.push([call('one', 'read_file', {})], text('Done.'));
    for await (const _ of runTurn(f.app, f.conv.id, 'I am exhausted. Read the fixture.')) void _;
    assert.equal(f.app.requests.length, 2);
    assert.equal(cueExtras(f, 0).length, 1);
    assert.deepEqual(cueExtras(f, 1), []);
    const steps = f.app.runs!.steps(f.app.runs!.list()[0].id);
    assert.equal(steps.length, 2);
    for (let i = 0; i < 2; i++) assert.equal(steps[i].inputsSha, inputsHash(f.app.requests[i].messages.slice(1)));
  } finally { f.close(); }
});

test('E2 prompt: follow-up notes are fresh after awaited source or memory revocation and retain valid events', async () => {
  for (const action of ['none', 'source edit', 'source delete', 'source forget', 'source private', 'memory edit', 'memory delete', 'cancel', 'opt out']) {
    const f = fixture();
    try {
      f.app.settings.update({ memory: { enabled: true } });
      const sourceConv = f.app.store.createConversation();
      const source = f.app.store.addMessage(sourceConv.id, 'user', 'My interview was yesterday');
      f.app.store.markDirectOwnerMessage(source.id);
      const memory = f.app.memory!.add({ kind: 'date', content: 'My interview was yesterday.', conversationId: sourceConv.id, sourceMessageId: source.id, evidence: source.content, happenedOn: '2026-11-04', onDate: '2026-11-04' });
      await turn(f, 'Hello.', { hooks: { async beforeModelCall() {
        await Promise.resolve();
        if (action === 'source edit') f.app.store.updateMessageContent(source.id, 'My trip is next week.');
        if (action === 'source delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
        if (action === 'source forget') f.app.store.updateMessageMeta(source.id, { forgotten: true });
        if (action === 'source private') f.app.store.updateConversation(sourceConv.id, { private: true });
        if (action === 'memory edit') f.app.memory!.update(memory.id, 'My trip is next week.');
        if (action === 'memory delete') f.app.memory!.delete(memory.id);
        if (action === 'cancel') {
          const answer = f.app.store.addMessage(f.conv.id, 'user', 'The interview was cancelled.');
          f.app.store.markDirectOwnerMessage(answer.id);
        }
        if (action === 'opt out') f.app.settings.update({ memory: { enabled: false } });
      } } });
      const sent = f.app.requests[0].messages.map((m) => m.content).join('\n');
      assert.equal(sent.includes('## Ask how it went'), action === 'none', action);
      const step = f.app.runs!.steps(f.app.runs!.list()[0].id)[0];
      assert.equal(step.inputsSha, inputsHash(f.app.requests[0].messages.slice(1)), action);
    } finally { f.close(); }
  }
});

test('E2 replay: retained cue extras remain inspectable but are omitted with honest branch provenance', async () => {
  const f = fixture();
  try {
    const ordinary = `${OWNER_CUES_MARK}\n## Ask how it went\nPlease explain these literal headings; I am exhausted.`;
    const source = f.app.store.addMessage(f.conv.id, 'user', ordinary);
    f.app.store.markDirectOwnerMessage(source.id);
    const note = ownerCueNote(f.app, f.conv.id, {})!;
    assert.ok(note);
    const rec = new RunRecorder(f.app.runs, { kind: 'turn', conversationId: f.conv.id, userMessageId: source.id });
    rec.startStep({ system: 'Be helpful.', model: 'fixture', provider: 'Fixture', historyFromId: source.id, historyToId: source.id, extra: [note], inputsSha: inputsHash([{ role: 'user', content: ordinary }, { role: 'system', content: note }]) });
    rec.modelCall({ model: 'fixture', provider: 'Fixture', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true });
    rec.close('ok');
    const retained = f.app.runs!.step(rec.id, 0)!;
    const rebuilt = rebuildStep(f.app, rec.id, 0);
    assert.deepEqual(rebuilt.extra, []);
    assert.equal(rebuilt.exact, false);
    assert.ok(rebuilt.problems.some((p) => /cue/i.test(p.key)));
    assert.ok(rebuilt.messages.some((m) => m.role === 'user' && m.content === ordinary));
    const events = [];
    f.app.script.push(text('Branch answer.'));
    for await (const ev of branchRun(f.app, rec.id, { fromStep: 0, notes: [note], recall: false, sandbox: { keep: false } })) events.push(ev);
    assert.deepEqual(cueExtras(f), [], 'raw replay extra seam independently denies a retained marker supplied again');
    assert.ok(f.app.requests[0].messages.some((m) => m.role === 'user' && m.content === ordinary));
    const branch = events.find((e) => e.type === 'branch')!;
    assert.equal(branch.exact, false);
    const done = events.find((e) => e.type === 'branch_done')!;
    assert.equal(done.outcome.exact, false);
    assert.equal(f.app.runs!.get(branch.runId)!.branch!.exact, false);
    assert.deepEqual(f.app.runs!.step(rec.id, 0), retained, 'rebuilding and running a branch preserve original audit bytes');
  } finally { f.close(); }
});

test('E2 replay: retained source-qualified follow-ups do not survive source deletion into a branch', async () => {
  const f = fixture();
  try {
    f.app.settings.update({ memory: { enabled: true } });
    const memory = f.app.memory!.addOwner({ kind: 'date', content: 'Interview at Acme', happenedOn: '2026-11-01', onDate: '2026-11-04' });
    await turn(f, 'Hello.');
    const original = f.app.runs!.list()[0];
    const retained = f.app.runs!.step(original.id, 0)!;
    assert.ok(retained.extra.some((x) => x.startsWith('## Ask how it went\n')));
    f.app.memory!.delete(memory.id);
    let reads = 0;
    const readEvidence = f.app.store.followUpEvidenceSince.bind(f.app.store);
    f.app.store.followUpEvidenceSince = (...args) => { reads++; return readEvidence(...args); };
    const rebuilt = rebuildStep(f.app, original.id, 0);
    assert.ok(!rebuilt.extra.some((x) => x.startsWith('## Ask how it went\n')));
    assert.equal(rebuilt.exact, false);
    f.app.script.push(text('Branch answer.'));
    for await (const _ of branchRun(f.app, original.id, { fromStep: 0, notes: retained.extra, recall: false, sandbox: { keep: false } })) void _;
    assert.ok(!f.app.requests[1].messages.some((m) => m.content.startsWith('## Ask how it went\n')));
    assert.equal(reads, 0, 'replay must not infer fresh evidence to replace retained notes');
    assert.deepEqual(f.app.runs!.step(original.id, 0), retained);
  } finally { f.close(); }
});

test('E2 prompt: bounded follow-up display remains fully inspectable in the recorded extra', async () => {
  const f = fixture();
  try {
    f.app.settings.update({ memory: { enabled: true } });
    for (let i = 0; i < 7; i++) f.app.memory!.addOwner({ kind: 'date', content: `Interview ${i}: ${'background '.repeat(100)}`, happenedOn: '2026-11-01', onDate: '2026-11-04' });
    await turn(f, 'Hello.');
    const note = f.app.requests[0].messages.find((m) => m.content.startsWith('## Ask how it went\n'))?.content;
    assert.ok(note, 'valid follow-ups remain available');
    assert.ok(note.length <= 4000, 'the entire note fits the existing audit extra limit');
    assert.equal(note.split('\n').filter((line) => line.startsWith('- Yesterday')).length, 6);
    assert.match(note, /No clear outcome was found/);
    assert.ok(f.app.runs!.steps(f.app.runs!.list()[0].id)[0].extra.includes(note));
  } finally { f.close(); }
});

test('E2 prompt: a source changed during real budget approval is refreshed without duplicate steps', async () => {
  const f = fixture();
  try {
    f.app.store.updateConversation(f.conv.id, { mode: 'coding' });
    f.app.settings.update({ turnBudgets: { onLimit: 'ask', quick: false, coding: { on: true, tokens: 200_000, steps: 2, usd: 0, minutes: 0 } } });
    f.app.tools.add({ spec: { name: 'read_file', description: 'read fixture', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'read fixture', async run() { return 'Read fixture.'; } });
    f.app.script.push([call('one', 'read_file', {})], text('Done.'));
    let approvals = 0;
    let hooks = 0;
    for await (const ev of runTurn(f.app, f.conv.id, 'I am exhausted. Read the fixture.', undefined, { hooks: { beforeModelCall() { hooks++; } } })) {
      if (ev.type !== 'approval') continue;
      assert.equal(ev.name, 'budget');
      approvals++;
      await Promise.resolve();
      const row = f.app.store.messages(f.conv.id).find((m) => m.role === 'user')!;
      f.app.store.updateMessageContent(row.id, 'This build is frustrating.');
      f.app.approvals.decide(ev.approvalId, true);
    }
    assert.equal(approvals, 1);
    assert.equal(hooks, 2, 'budget retries stop before ordinary hooks until approval');
    assert.equal(f.app.requests.length, 2);
    assert.match(cueExtras(f, 0)[0], /fatigue/);
    assert.deepEqual(cueExtras(f, 1), [ownerCueNote(f.app, f.conv.id, {})]);
    assert.match(cueExtras(f, 1)[0], /task-frustration/);
    const steps = f.app.runs!.steps(f.app.runs!.list()[0].id);
    assert.equal(steps.length, 2);
    for (let i = 0; i < 2; i++) assert.equal(steps[i].inputsSha, inputsHash(f.app.requests[i].messages.slice(1)));
  } finally { f.close(); }
});

test('E2 audit: final-input refresh preserves receipts and never creates or rewrites nonmodel steps', () => {
  const f = fixture();
  try {
    const rec = new RunRecorder(f.app.runs, { kind: 'turn', conversationId: f.conv.id });
    const final = { system: 'Final system.', model: 'final', provider: 'Fixture', extra: ['Final note.'], inputsSha: 'final-hash' };
    rec.refreshModelInputs(final);
    rec.startStep({ label: 'background work', system: 'Background system.', extra: ['Background note.'] });
    rec.refreshModelInputs(final);
    rec.startStep({ system: 'Initial system.', model: 'initial', provider: 'Fixture', historyFromId: 1, historyToId: 2, policyId: 'preserved-policy' });
    rec.modelCall({ model: 'checker', provider: 'Fixture', providerId: 'p', purpose: 'safety check', in: 4, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true });
    rec.refreshModelInputs(final);
    rec.modelCall({ model: 'final', provider: 'Fixture', providerId: 'p', in: 4, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true });
    rec.close('ok');
    const steps = f.app.runs!.steps(rec.id);
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0].extra, ['Background note.']);
    assert.equal(f.app.runs!.blob(steps[0].systemSha!), 'Background system.');
    assert.deepEqual(steps[1].extra, ['Final note.']);
    assert.equal(f.app.runs!.blob(steps[1].systemSha!), 'Final system.');
    assert.equal(steps[1].model, 'final');
    assert.equal(steps[1].historyFromId, 1);
    assert.equal(steps[1].historyToId, 2);
    assert.equal(steps[1].policyId, 'preserved-policy');
    assert.equal(steps[1].calls[0].purpose, 'safety check');
  } finally { f.close(); }
});

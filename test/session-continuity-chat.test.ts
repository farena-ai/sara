import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent, type TurnOptions } from '../src/chat.ts';
import { SESSION_CONTINUITY_MARK } from '../src/session-continuity.ts';
import { acquireSessionStep } from '../src/session-step-gate.ts';
import { inputsHash, RunRecorder, RunStore } from '../src/runs.ts';
import { ProviderError } from '../src/providers/types.ts';
import { Store } from '../src/store.ts';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { branchRun, rebuildStep } from '../src/replay.ts';
import { continuityForTurn } from '../src/session-continuity.ts';
import { pendingFor } from '../src/pending.ts';
import { pickupsFor } from '../src/pickup.ts';
import { TurnMeter } from '../src/budget.ts';
import { privateLocalOn, setPrivateLocal } from '../src/net-guard.ts';
import { createSessionContinuityTools } from '../src/session-continuity-tools.ts';
import { SessionHandoffStore } from '../src/session-handoffs.ts';
import { UsageStore, priceTable } from '../src/usage.ts';
import { quickIsCheaper } from '../src/budget.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-05T15:00:00.000Z';
function fixture() {
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false },
    // mnt2: these R1 seams test the strict one-step-at-a-time queue (parallel 1, still a valid setting).
    chats: { continuity: { enabled: true, parallel: 1 } } } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const web = app.store.createConversation();
  const dm = app.store.createConversation({ channel: 'discord', channelKey: 'fixture-dm' });
  return { app, web, dm, clock, close() { app.store.close(); temp.cleanup(); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function collect(it: AsyncIterable<ChatEvent>) { const events: ChatEvent[] = []; for await (const e of it) events.push(e); return events; }
async function until(it: AsyncGenerator<ChatEvent>, predicate: (e: ChatEvent) => boolean) {
  for (;;) { const r = await it.next(); assert.equal(r.done, false, 'expected event before turn completed'); if (predicate(r.value)) return r.value; }
}
const liveNotes = (f: ReturnType<typeof fixture>, i = 0) => f.app.requests[i].messages.filter(m => m.role === 'system' && m.content.startsWith(SESSION_CONTINUITY_MARK));

function quickFixture(paid = false, usage = false) {
  const f = fixture();
  f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], baseUrl: paid ? 'https://synthetic.invalid' : 'http://127.0.0.1:1', local: !paid }], defaultModel: 'primary', routes: { quick: { providerId: 'p', model: 'old-quick' } }, turnBudgets: { quick: paid, chat: { on: true, tokens: 200_000, steps: 4, minutes: 0, usd: 0 } }, prices: [{ providerId: 'p', model: 'primary', inPerM: 10, outPerM: 10 }, { providerId: 'p', model: 'old-quick', inPerM: 1, outPerM: 1 }] });
  if (usage) { f.app.usage = new UsageStore(f.app.store.db, f.app.now); f.app.usage.prices = () => priceTable(f.app.settings.get().prices); }
  f.app.tools.add({ spec: { name: 'read_file', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Read fixture', async run() { return 'Fixture.'; } });
  f.app.script.push([call('read', 'read_file', {})], text('Quick final answer.'));
  return f;
}

test('R1 effective explicit budget default ladder witnesses a quick switch even when settings quick is false', async () => {
  for (const seam of ['hook', 'gate']) for (const degrade of [undefined, ['smaller-model'] as const, null]) {
    const f = quickFixture(); let release: (() => void) | undefined; let sawQuick = false; let callsAtWait = 0;
    try {
      const events: ChatEvent[] = [];
      for await (const ev of runTurn(f.app, f.web.id, 'Read fixture.', undefined, { budget: { tokens: 200_000, steps: 4, ...(degrade === undefined ? {} : { degrade: degrade as never }) }, hooks: { async beforeModelCall(c) {
        if (c.step !== 1) return; assert.equal(c.model, 'old-quick', 'actual meter already chose the smaller-model rung'); sawQuick = true; callsAtWait = f.app.providerCalls;
        if (seam === 'gate') release = await acquireSessionStep(f.app.store.db, 'held-quick', new AbortController().signal).ready;
        else { await Promise.resolve(); f.app.settings.update({ routes: { quick: { providerId: 'p', model: 'new-quick' } } }); }
      } } })) {
        events.push(ev); if (ev.type === 'notice' && ev.kind === 'continuity') { f.app.settings.update({ routes: { quick: { providerId: 'p', model: 'new-quick' } } }); release!(); }
      }
      assert.ok(sawQuick); assert.deepEqual(f.app.requests.map(r => r.model), ['primary'], `${seam}/${degrade}`);
      assert.equal(f.app.providerCalls, callsAtWait, 'no provider rebuild after wait');
      assert.ok(events.some(e => e.type === 'error' && /settings changed/.test(e.message)));
    } finally { release?.(); f.close(); }
  }
});

test('R1 selected main/quick price reversal after actual smaller-model selection stops before costlier invocation', async () => {
  for (const seam of ['hook', 'gate']) for (const usage of [false, true]) for (const reversal of ['quick-more', 'main-less', 'missing-quick-price']) {
    const f = quickFixture(true, usage); let release: (() => void) | undefined; let sawQuick = false; let callsAtWait = 0;
    const mutate = () => f.app.settings.update({ prices: [{ providerId: 'p', model: 'primary', inPerM: reversal === 'main-less' ? 0.1 : 10, outPerM: reversal === 'main-less' ? 0.1 : 10 }, ...(reversal === 'missing-quick-price' ? [] : [{ providerId: 'p', model: 'old-quick', inPerM: reversal === 'quick-more' ? 100 : 1, outPerM: reversal === 'quick-more' ? 100 : 1 }])] });
    try {
      const events: ChatEvent[] = [];
      for await (const ev of runTurn(f.app, f.web.id, 'Read fixture.', undefined, { hooks: { async beforeModelCall(c) {
        if (c.step !== 1) return; assert.equal(c.model, 'old-quick', 'price case must reach actual smaller-model selection'); sawQuick = true; callsAtWait = f.app.providerCalls;
        if (seam === 'gate') release = await acquireSessionStep(f.app.store.db, 'held-price', new AbortController().signal).ready;
        else { await Promise.resolve(); mutate(); }
      } } })) { events.push(ev); if (ev.type === 'notice' && ev.kind === 'continuity') { mutate(); release!(); } }
      assert.ok(sawQuick); assert.deepEqual(f.app.requests.map(r => r.model), ['primary'], `${seam}/usage=${usage}/${reversal}`);
      assert.equal(f.app.providerCalls, callsAtWait);
      assert.equal(quickIsCheaper({ billing: 'api', providerId: 'p', model: 'primary', pricePerM: reversal === 'main-less' ? 0.2 : 20 }, { billing: 'api', providerId: 'p', model: 'old-quick', ...(reversal === 'missing-quick-price' ? {} : { pricePerM: reversal === 'quick-more' ? 200 : 2 }) }), false, 'current prices no longer authorize the cheaper switch');
      assert.ok(events.some(e => e.type === 'error' && /settings changed/.test(e.message)));
    } finally { release?.(); f.close(); }
  }
});

test('R1 explicit disabled ladders, inherited defaults and null budgets ignore an unused quick route', async () => {
  for (const opts of [
    { budget: { tokens: 200_000, steps: 4, degrade: [] } },
    { budget: { tokens: 200_000, steps: 4, degrade: ['fewer-tools', 'summarize-stop'] } },
    { budget: undefined }, { budget: null }, { budgetMore: { tokens: 200_000, steps: 4 } },
  ] satisfies TurnOptions[]) {
    const f = quickFixture(); let sawSecond = false;
    try {
      const events = await collect(runTurn(f.app, f.web.id, 'Read fixture.', undefined, { ...opts, hooks: { async beforeModelCall(c) {
        if (c.step !== 1) return; sawSecond = true; assert.equal(c.model, 'primary'); await Promise.resolve(); f.app.settings.update({ routes: { quick: { providerId: 'p', model: 'unused-new-quick' } } });
      } } }));
      assert.ok(sawSecond); assert.deepEqual(f.app.requests.map(r => r.model), ['primary', 'primary']);
      assert.ok(!events.some(e => e.type === 'error'));
    } finally { f.close(); }
  }
});

test('R1 quick prices follow effective UsageStore source and ignore unrelated or shadowed price rows', async () => {
  for (const action of ['unrelated', 'shadowed-generic', 'settings-shadowed-by-usage', 'usage-price-reversal']) {
    const f = quickFixture(true, true); let active = priceTable(f.app.settings.get().prices); let sawQuick = false;
    if (action.includes('usage')) f.app.usage!.prices = () => active;
    try {
      const events = await collect(runTurn(f.app, f.web.id, 'Read fixture.', undefined, { hooks: { async beforeModelCall(c) {
        if (c.step !== 1) return; sawQuick = true; assert.equal(c.model, 'old-quick', 'price-source tests must reach actual smaller-model rung'); await Promise.resolve();
        if (action === 'unrelated') f.app.settings.update({ prices: [...f.app.settings.get().prices!, { providerId: 'unrelated', model: 'other', inPerM: 1000, outPerM: 1000 }] });
        if (action === 'shadowed-generic') f.app.settings.update({ prices: [...f.app.settings.get().prices!, { model: 'old-quick', inPerM: 1000, outPerM: 1000 }] });
        if (action === 'settings-shadowed-by-usage') f.app.settings.update({ prices: [{ providerId: 'p', model: 'primary', inPerM: 10, outPerM: 10 }, { providerId: 'p', model: 'old-quick', inPerM: 100, outPerM: 100 }] });
        if (action === 'usage-price-reversal') active = priceTable([{ providerId: 'p', model: 'primary', inPerM: 10, outPerM: 10 }, { providerId: 'p', model: 'old-quick', inPerM: 100, outPerM: 100 }]);
      } } }));
      assert.ok(sawQuick); assert.deepEqual(f.app.requests.map(r => r.model), action === 'usage-price-reversal' ? ['primary'] : ['primary', 'old-quick'], action);
      assert.equal(events.some(e => e.type === 'error'), action === 'usage-price-reversal', action);
    } finally { f.close(); }
  }
});

test('R1 actual turns serialize web/DM provider steps through committed reply, with exact final audit', async () => {
  const f = fixture(); const firstIn = deferred(); const finish = deferred();
  const original = f.app.providerFactory!; let streamed = 0;
  f.app.providerFactory = config => {
    const p = original(config); return { ...p, config, listModels: p.listModels.bind(p), async *stream(req) {
      f.app.requests.push(structuredClone({ ...req, signal: undefined }));
      if (++streamed === 1) { firstIn.resolve(); await finish.promise; yield { type: 'text' as const, text: 'COMMITTED_REPLY_42' }; }
      else yield { type: 'text' as const, text: 'Second answer.' };
    } };
  };
  const a = collect(runTurn(f.app, f.web.id, 'First request.', undefined, { noTools: true }));
  let second: AsyncGenerator<ChatEvent> | undefined;
  try {
    await firstIn.promise;
    second = runTurn(f.app, f.dm.id, 'Second request.', undefined, { noTools: true });
    const wait = await until(second, e => e.type === 'notice' && e.kind !== 'disclosure' || e.type === 'token');
    assert.equal(wait.type, 'notice', 'second request waits instead of overlapping the provider');
    assert.equal(streamed, 1);
    finish.resolve(); await a; await collect(second);
    assert.equal(streamed, 2);
    assert.match(liveNotes(f, 1)[0].content, /COMMITTED_REPLY_42/);
    assert.equal(liveNotes(f, 1).length, 1);
    assert.ok(!f.app.requests[1].messages[0].content.includes('## Lately in your other conversations'));
    for (const run of f.app.runs!.list()) {
      const step = f.app.runs!.steps(run.id)[0];
      const request = f.app.requests.find(r => r.messages.some(m => m.role === 'user' && m.content === (run.conversationId === f.web.id ? 'First request.' : 'Second request.')))!;
      assert.equal(step.inputsSha, inputsHash(request.messages.slice(1)));
      assert.deepEqual(step.extra.filter(x => x.startsWith(SESSION_CONTINUITY_MARK)), request.messages.filter(m => m.content.startsWith(SESSION_CONTINUITY_MARK)).map(m => m.content));
    }
  } finally { finish.resolve(); await a; await second?.return(undefined); f.close(); }
});

test('R1 actual provider boundary rejects current-history epoch edits after awaited hooks', async () => {
  for (const mutation of ['edit', 'delete', 'forget']) {
    const f = fixture();
    try {
      const events = await collect(runTurn(f.app, f.web.id, 'Current request.', undefined, { noTools: true, hooks: { async beforeModelCall() {
        await Promise.resolve(); const row = f.app.store.messages(f.web.id).find(m => m.role === 'user')!;
        if (mutation === 'edit') f.app.store.updateMessageContent(row.id, 'Changed request.');
        if (mutation === 'delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
        if (mutation === 'forget') f.app.store.updateMessageMeta(row.id, { forgotten: true });
      } } }));
      assert.equal(f.app.requests.length, 0, mutation);
      assert.ok(events.some(e => e.type === 'error' && /changed|refresh/i.test(e.message)), mutation);
    } finally { f.close(); }
  }
});

test('R1 retained chain authorization covers routing inputs after hooks/FIFO without unrelated settings conflicts', async () => {
  type F = ReturnType<typeof fixture>;
  const cases: { name: string; setup?: (f: F) => void; mutate: (f: F) => void; allowed?: boolean; opts?: TurnOptions }[] = [
    { name: 'companion', setup: f => f.app.settings.update({ companionModel: { providerId: 'p', model: 'old-companion' } }), mutate: f => f.app.settings.update({ companionModel: { providerId: 'p', model: 'new-companion' } }) },
    { name: 'default fallback removal', setup: f => f.app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'removed-fallback' }] }), mutate: f => f.app.settings.update({ defaultFallbacks: [] }) },
    { name: 'route fallback removal', setup: f => f.app.settings.update({ routes: { chat: { providerId: 'p', model: 'routed', fallbacks: [{ providerId: 'p', model: 'removed-fallback' }] } } }), mutate: f => f.app.settings.update({ routes: { chat: { providerId: 'p', model: 'routed', fallbacks: [] } } }) },
    { name: 'inherited chat route', setup: f => { f.app.store.updateConversation(f.web.id, { mode: 'coding' }); f.app.settings.update({ routes: { chat: { providerId: 'p', model: 'inherited' } } }); }, mutate: f => f.app.settings.update({ routes: { chat: { providerId: 'p', model: 'new-inherited' } } }) },
    { name: 'provider default', setup: f => { f.app.store.updateConversation(f.web.id, { providerId: 'p', model: null }); f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], defaultModel: 'old-default' }] }); }, mutate: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], defaultModel: 'new-default' }] }) },
    { name: 'provider locality', mutate: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], local: false }] }) },
    { name: 'provider endpoint', mutate: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], baseUrl: 'http://127.0.0.1:2' }] }) },
    { name: 'default model', mutate: f => f.app.settings.update({ defaultModel: 'new-default' }) },
    { name: 'conversation model override', mutate: f => { f.app.store.updateConversation(f.web.id, { providerId: 'p', model: 'new-override' }); } },
    { name: 'credential revocation', setup: f => { f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], needsKey: true }] }); f.app.vault.set('provider:p', 'synthetic-fixture-key'); }, mutate: f => { f.app.vault.delete('provider:p'); } },
    { name: 'research route', setup: f => f.app.settings.update({ routes: { research: { providerId: 'p', model: 'old-research' } } }), mutate: f => f.app.settings.update({ routes: { research: { providerId: 'p', model: 'new-research' } } }), opts: {} },
    { name: 'quick inherited route', opts: { quickModel: true }, setup: f => f.app.settings.update({ routes: { background: { providerId: 'p', model: 'old-background' } } }), mutate: f => f.app.settings.update({ routes: { background: { providerId: 'p', model: 'new-background' } } }) },
    { name: 'newly configured route provider', setup: f => f.app.settings.update({ routes: { chat: { providerId: 'new', model: 'new-routed' } } }), mutate: f => f.app.settings.update({ providers: [...f.app.settings.get().providers, { ...f.app.settings.get().providers[0], id: 'new' }] }) },
    { name: 'vision route', opts: { images: ['synthetic-missing-image'] }, setup: f => f.app.settings.update({ routes: { vision: { providerId: 'p', model: 'old-vision' } } }), mutate: f => f.app.settings.update({ routes: { vision: { providerId: 'p', model: 'new-vision' } } }) },
    { name: 'blind vision talking fallback', opts: { images: ['synthetic-missing-image'] }, setup: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], kind: 'claude-code' }, { ...f.app.settings.get().providers[0], id: 'seeing' }], routes: { vision: { providerId: 'p', model: 'blind' }, chat: { providerId: 'seeing', model: 'old-talking' } } }), mutate: f => f.app.settings.update({ routes: { vision: { providerId: 'p', model: 'blind' }, chat: { providerId: 'seeing', model: 'new-talking' } } }) },
    { name: 'private-local fallback route', setup: f => { f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], baseUrl: 'https://synthetic.invalid' }, { ...f.app.settings.get().providers[0], id: 'here' }], routes: { private: { providerId: 'here', model: 'old-private' } } }); setPrivateLocal(true); }, mutate: f => f.app.settings.update({ routes: { private: { providerId: 'here', model: 'new-private' } } }) },
    { name: 'unused provider', allowed: true, mutate: f => f.app.settings.update({ providers: [...f.app.settings.get().providers, { ...f.app.settings.get().providers[0], id: 'unused' }] }) },
    { name: 'cosmetic provider label', allowed: true, mutate: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], label: 'Renamed fixture' }] }) },
    { name: 'unused provider default', allowed: true, mutate: f => f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], defaultModel: 'unused-default' }] }) },
    { name: 'unused route', allowed: true, mutate: f => f.app.settings.update({ routes: { embeddings: { providerId: 'p', model: 'unused' } } }) },
    { name: 'unused coding budget', allowed: true, mutate: f => f.app.settings.update({ turnBudgets: { coding: { tokens: 500_000 } } }) },
    { name: 'unused third fallback', allowed: true, setup: f => f.app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'one' }, { providerId: 'p', model: 'two' }, { providerId: 'p', model: 'unused' }] }), mutate: f => f.app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'one' }, { providerId: 'p', model: 'two' }, { providerId: 'p', model: 'changed-unused' }] }) },
    { name: 'override ignores companion/default fallbacks', allowed: true, setup: f => { f.app.store.updateConversation(f.web.id, { providerId: 'p', model: 'pinned' }); }, mutate: f => f.app.settings.update({ companionModel: { providerId: 'p', model: 'unused-companion' }, defaultFallbacks: [{ providerId: 'p', model: 'unused-fallback' }] }) },
  ];
  for (const seam of ['hook', 'gate']) for (const c of cases) {
    const localBefore = privateLocalOn(); const f = fixture(); c.setup?.(f);
    let release: (() => void) | undefined; let it: AsyncGenerator<ChatEvent> | undefined; let factories = 0;
    try {
      if (c.name.includes('fallback removal')) {
        const factory = f.app.providerFactory!;
        f.app.providerFactory = config => { const p = factory(config); return { config, listModels: p.listModels.bind(p), async *stream(req) { f.app.requests.push(structuredClone({ ...req, signal: undefined })); if (req.model !== 'removed-fallback') throw new Error('Synthetic primary failure'); yield { type: 'text' as const, text: 'Stale fallback.' }; } }; };
      }
      if (seam === 'gate') release = await acquireSessionStep(f.app.store.db, 'held', new AbortController().signal).ready;
      it = runTurn(f.app, f.web.id, c.name === 'research route' ? 'Please research this topic.' : 'Ordinary request.', undefined, { noTools: true, ...c.opts, ...(seam === 'hook' ? { hooks: { async beforeModelCall() { factories = f.app.providerCalls; await Promise.resolve(); c.mutate(f); } } } : {}) });
      if (seam === 'gate') { await until(it, e => e.type === 'notice' && e.kind === 'continuity'); factories = f.app.providerCalls; c.mutate(f); release!(); }
      const events = await collect(it);
      assert.equal(f.app.requests.length, c.allowed ? 1 : 0, `${seam}/${c.name}`);
      assert.equal(f.app.providerCalls, factories, 'final validation does not rebuild providers');
      assert.equal(events.some(e => e.type === 'error'), !c.allowed, `${seam}/${c.name}`);
    } finally { release?.(); await it?.return(undefined); setPrivateLocal(localBefore); f.close(); }
  }
});

test('R1 fallback removed after a failed primary stops before invoking the retained destination', async () => {
  const f = fixture(); f.app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'removed-fallback' }] });
  const factory = f.app.providerFactory!;
  f.app.providerFactory = config => { const p = factory(config); return { config, listModels: p.listModels.bind(p), async *stream(req) { f.app.requests.push(structuredClone({ ...req, signal: undefined })); if (req.model === 'fixture') throw new Error('Synthetic primary failure'); yield { type: 'text' as const, text: 'Stale fallback.' }; } }; };
  const it = runTurn(f.app, f.web.id, 'Ordinary request.', undefined, { noTools: true }); let release: (() => void) | undefined;
  try {
    await until(it, e => e.type === 'notice' && e.kind === 'fallback');
    assert.equal(f.app.requests.length, 1);
    release = await acquireSessionStep(f.app.store.db, 'held-before-fallback', new AbortController().signal).ready;
    await until(it, e => e.type === 'notice' && e.kind === 'continuity');
    f.app.settings.update({ defaultFallbacks: [] }); release();
    const events = await collect(it);
    assert.equal(f.app.requests.length, 1, 'removed fallback never receives history');
    assert.ok(events.some(e => e.type === 'error' && /settings changed/.test(e.message)));
  } finally { release?.(); await it.return(undefined); f.close(); }
});

test('R1 paused waiting generator releases a granted ticket on abort before provider entry', async () => {
  const f = fixture(); const signal = new AbortController();
  const release = await acquireSessionStep(f.app.store.db, 'held-step', new AbortController().signal).ready;
  const waiting = runTurn(f.app, f.web.id, 'Wait for the previous step.', signal.signal, { noTools: true });
  let c: ReturnType<typeof acquireSessionStep> | undefined;
  try {
    await until(waiting, e => e.type === 'notice' && e.kind === 'continuity');
    release(); await Promise.resolve();
    signal.abort();
    c = acquireSessionStep(f.app.store.db, 'next-step', new AbortController().signal);
    assert.equal(c.waiting, false, 'abort frees a granted ticket while its consumer remains paused');
    assert.equal(f.app.requests.length, 0);
  } finally { release(); await waiting.return(undefined); (await c?.ready)?.(); f.close(); }
});

test('R1 final notes re-read other-source edits/deletes/forget/privacy/settings after hooks and FIFO waits', async () => {
  for (const seam of ['hook', 'gate']) for (const action of ['edit', 'delete', 'forget', 'private', 'archive', 'ended', 'disabled', 'malformed']) {
    const f = fixture(); const source = f.app.store.addMessage(f.dm.id, 'user', 'STALE_SOURCE_42');
    continuityForTurn(f.app, f.dm.id)!.handoff({ targetId: f.web.id, text: 'STALE_HANDOFF_42', expectedId: 0 });
    let release: (() => void) | undefined;
    const mutate = () => {
      if (action === 'edit') f.app.store.updateMessageContent(source.id, 'FRESH_SOURCE_42');
      if (action === 'delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
      if (action === 'forget') f.app.store.updateMessageMeta(source.id, { forgotten: true });
      if (action === 'private') f.app.store.updateConversation(f.dm.id, { private: true });
      if (action === 'archive') f.app.store.updateConversation(f.dm.id, { archived: true });
      if (action === 'ended') f.app.store.endConversation(f.dm.id);
      if (action === 'disabled') f.app.settings.update({ chats: { continuity: { enabled: false } } } as never);
      if (action === 'malformed') f.app.settings.update({ chats: { continuity: { enabled: 'yes' } } } as never);
    };
    let it: AsyncGenerator<ChatEvent> | undefined;
    try {
      if (seam === 'gate') release = await acquireSessionStep(f.app.store.db, 'held', new AbortController().signal).ready;
      it = runTurn(f.app, f.web.id, 'Current request.', undefined, { noTools: true, ...(seam === 'hook' ? { hooks: { async beforeModelCall() { await Promise.resolve(); mutate(); } } } : {}) });
      if (seam === 'gate') { await until(it, e => e.type === 'notice' && e.kind === 'continuity'); mutate(); release!(); }
      await collect(it);
      assert.equal(f.app.requests.length, 1, `${seam}/${action}`);
      const sent = f.app.requests[0].messages.map(m => m.content).join('\n');
      assert.ok(!sent.includes('STALE_HANDOFF_42'), `${seam}/${action}: revoked note`);
      if (action !== 'ended') assert.ok(!sent.includes('STALE_SOURCE_42'), `${seam}/${action}: stale source`);
      if (action === 'edit') assert.match(sent, /FRESH_SOURCE_42/);
      if (['disabled', 'malformed'].includes(action)) assert.equal(liveNotes(f).length, 0);
      if (liveNotes(f).length) { assert.equal(liveNotes(f).length, 1); assert.ok(liveNotes(f)[0].content.length <= 3800); }
    } finally { release?.(); await it?.return(undefined); f.close(); }
  }
});

test('R1 waiting turns refuse replaced databases, changed current scope/history and model/budget authority', async () => {
  for (const seam of ['hook', 'gate']) for (const action of ['database', 'epoch', 'private', 'workspace', 'provider', 'budget']) {
    const f = fixture(); const original = f.app.store; let replacement: Store | undefined;
    let release: (() => void) | undefined; let it: AsyncGenerator<ChatEvent> | undefined;
    const mutate = () => {
      if (action === 'database') { replacement = new Store(join(f.app.dataDir, 'replacement.db'), f.app.now); f.app.store = replacement; }
      if (action === 'epoch') { const m = original.messages(f.web.id).find(m => m.role === 'user')!; original.updateMessageContent(m.id, 'Changed.'); }
      if (action === 'private') original.updateConversation(f.web.id, { private: true });
      if (action === 'workspace') original.updateConversation(f.web.id, { workspace: 'other' });
      if (action === 'provider') f.app.settings.update({ providers: [{ ...f.app.settings.get().providers[0], baseUrl: 'http://127.0.0.1:2' }] });
      if (action === 'budget') f.app.settings.update({ turnBudgets: { chat: { on: true, tokens: 1000 } } });
    };
    try {
      if (seam === 'gate') release = await acquireSessionStep(original.db, 'held', new AbortController().signal).ready;
      it = runTurn(f.app, f.web.id, 'Current request.', undefined, { noTools: true, ...(seam === 'hook' ? { hooks: { async beforeModelCall() { await Promise.resolve(); mutate(); } } } : {}) });
      if (seam === 'gate') { await until(it, e => e.type === 'notice' && e.kind === 'continuity'); mutate(); release!(); }
      const events = await collect(it);
      assert.equal(f.app.requests.length, 0, `${seam}/${action}`);
      assert.ok(events.some(e => e.type === 'error'), `${seam}/${action}`);
      assert.ok(f.app.runs!.list().every(r => f.app.runs!.steps(r.id).every(s => s.calls.length === 0)), 'no invented successful model calls');
    } finally { release?.(); await it?.return(undefined); f.app.store = original; replacement?.close(); f.close(); }
  }
});

test('R1 lease releases before afterReply hooks and before tool/approval waits', async () => {
  const f = fixture(); const entered = deferred(); const finish = deferred();
  f.app.script.push(text('FIRST_SAVED'), text('SECOND_SAVED'));
  const a = collect(runTurn(f.app, f.web.id, 'First.', undefined, { noTools: true, hooks: { async afterReply() { entered.resolve(); await finish.promise; } } }));
  try {
    await entered.promise;
    assert.ok(f.app.store.messages(f.web.id).some(m => m.role === 'assistant' && m.content === 'FIRST_SAVED'));
    const b = await collect(runTurn(f.app, f.dm.id, 'Second.', undefined, { noTools: true }));
    assert.ok(!b.some(e => e.type === 'notice' && e.kind === 'continuity'));
    assert.match(liveNotes(f, 1)[0].content, /FIRST_SAVED/);
  } finally { finish.resolve(); await a; f.close(); }

  const g = fixture(); let it: AsyncGenerator<ChatEvent> | undefined;
  try {
    g.app.tools.add({ spec: { name: 'read_file', description: 'fixture', parameters: {} }, defaultPermission: 'ask', summarize: () => 'Read fixture', async run() { return 'Read fixture.'; } });
    g.app.script.push([call('read', 'read_file', {})], text('Other session.'), text('Finished.'));
    it = runTurn(g.app, g.web.id, 'Read fixture.');
    const card = await until(it, e => e.type === 'approval'); assert.ok(card.type === 'approval');
    const b = await collect(runTurn(g.app, g.dm.id, 'While the card is waiting.', undefined, { noTools: true }));
    assert.ok(!b.some(e => e.type === 'notice' && e.kind === 'continuity'));
    g.app.approvals.decide(card.approvalId, true); await collect(it);
    assert.equal(g.app.requests.length, 3);
  } finally { await it?.return(undefined); g.close(); }
});

test('R1 gate cancellation before grant, paused rejection, queue cap and streaming return leave no lease', async () => {
  for (const action of ['abort-waiting', 'return-waiting', 'cap']) {
    const f = fixture(); const signal = new AbortController();
    const release = await acquireSessionStep(f.app.store.db, 'held', signal.signal).ready;
    const queued: { ready: Promise<() => void>; abort: AbortController }[] = [];
    if (action === 'cap') for (let i = 0; i < 20; i++) { const abort = new AbortController(); const ticket = acquireSessionStep(f.app.store.db, `queued-${i}`, abort.signal); void ticket.ready.catch(() => {}); queued.push({ ready: ticket.ready, abort }); }
    const waitingSignal = new AbortController(); const it = runTurn(f.app, f.web.id, 'Waiting.', waitingSignal.signal, { noTools: true });
    try {
      await until(it, e => e.type === 'notice' && e.kind === 'continuity');
      if (action === 'abort-waiting') waitingSignal.abort();
      await nextTick(); // Reject while the async-generator consumer is deliberately paused.
      if (action === 'return-waiting') await it.return(undefined);
      else { const events = await collect(it); assert.ok(events.some(e => e.type === 'error')); }
      assert.equal(f.app.requests.length, 0);
      for (const q of queued) q.abort.abort(); await Promise.allSettled(queued.map(q => q.ready));
      release(); await nextTick();
      const next = acquireSessionStep(f.app.store.db, 'after', new AbortController().signal); assert.equal(next.waiting, false); (await next.ready)();
    } finally { release(); await it.return(undefined); for (const q of queued) q.abort.abort(); f.close(); }
  }
  const f = fixture(); const it = runTurn(f.app, f.web.id, 'Streaming.', undefined, { noTools: true });
  try {
    await until(it, e => e.type === 'token');
    const next = acquireSessionStep(f.app.store.db, 'after-stream', new AbortController().signal); assert.equal(next.waiting, true, 'lease remains through uncommitted tokens');
    await it.return(undefined); (await next.ready)();
  } finally { await it.return(undefined); f.close(); }
});

test('R1 provider retry/fallback/partial/error/empty paths release without overlapping requests', async () => {
  for (const action of ['unsupported', 'fallback', 'partial', 'error', 'empty', 'abort']) {
    const f = fixture(); const abort = new AbortController(); let count = 0;
    if (action === 'fallback') f.app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'backup' }] });
    const factory = f.app.providerFactory!;
    f.app.providerFactory = config => { const p = factory(config); return { config, listModels: p.listModels.bind(p), async *stream(req) {
      f.app.requests.push(structuredClone({ ...req, signal: undefined })); count++;
      if (count > 1) { yield { type: 'text' as const, text: 'Recovered.' }; return; }
      if (action === 'partial') yield { type: 'text' as const, text: 'Partial answer.' };
      if (action === 'unsupported') throw new ProviderError('tools are unsupported', 400);
      if (action === 'empty') return;
      if (action === 'abort') abort.abort();
      throw new Error('Synthetic provider failure');
    } }; };
    try {
      const events = await collect(runTurn(f.app, f.web.id, 'First.', abort.signal));
      assert.equal(count, ['unsupported', 'fallback'].includes(action) ? 2 : 1, action);
      if (action === 'partial') assert.ok(f.app.store.messages(f.web.id).some(m => m.meta?.partial && m.content === 'Partial answer.'));
      if (!['unsupported', 'fallback'].includes(action)) assert.ok(events.some(e => e.type === 'error'), action);
      const next = acquireSessionStep(f.app.store.db, 'after', new AbortController().signal); assert.equal(next.waiting, false, action); (await next.ready)();
    } finally { f.close(); }
  }
});

test('R1 default budget approval refreshes revoked sources/settings but stops stale current history', async () => {
  for (const source of ['other', 'delete', 'forget', 'private', 'disabled', 'current']) {
    const f = fixture(); const original = f.app.store.addMessage(f.dm.id, 'user', 'OLD_BUDGET_SOURCE');
    try {
      f.app.store.updateConversation(f.web.id, { mode: 'coding' });
      f.app.settings.update({ turnBudgets: { onLimit: 'ask', quick: false, coding: { on: true, tokens: 200_000, steps: 2, usd: 0, minutes: 0 } } });
      f.app.tools.add({ spec: { name: 'read_file', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Read fixture', async run() { return 'Fixture.'; } });
      f.app.script.push([call('read', 'read_file', {})], text('Finished.'));
      let approvals = 0;
      for await (const ev of runTurn(f.app, f.web.id, 'Read fixture.')) if (ev.type === 'approval') {
        assert.equal(ev.name, 'budget'); approvals++;
        if (source === 'delete') f.app.store.db.prepare('DELETE FROM messages WHERE id=?').run(original.id);
        else if (source === 'forget') f.app.store.updateMessageMeta(original.id, { forgotten: true });
        else if (source === 'private') f.app.store.updateConversation(f.dm.id, { private: true });
        else if (source === 'disabled') f.app.settings.update({ chats: { continuity: { enabled: false } } } as never);
        else f.app.store.updateMessageContent(source === 'other' ? original.id : f.app.store.messages(f.web.id).find(m => m.role === 'user')!.id, 'NEW_BUDGET_SOURCE');
        f.app.approvals.decide(ev.approvalId, true);
      }
      assert.equal(approvals, 1); assert.equal(f.app.requests.length, source !== 'current' ? 2 : 1);
      if (source === 'other') { assert.match(liveNotes(f, 1)[0].content, /NEW_BUDGET_SOURCE/); assert.ok(!liveNotes(f, 1)[0].content.includes('OLD_BUDGET_SOURCE')); }
      else if (source !== 'current') assert.ok(!f.app.requests[1].messages.some(m => m.content.includes('OLD_BUDGET_SOURCE')), source);
      else assert.ok(f.app.runs!.steps(f.app.runs!.list()[0].id).at(-1)!.calls.every(c => !c.ok), 'uninvoked step cannot record success');
    } finally { f.close(); }
  }
});

test('R1 provider leases release during actual tool execution and reacquire with the other committed reply', async () => {
  const f = fixture(); const running = deferred(); const finish = deferred();
  f.app.tools.add({ spec: { name: 'read_file', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Read fixture', async run() { running.resolve(); await finish.promise; return 'Fixture.'; } });
  f.app.script.push([call('read', 'read_file', {})], text('OTHER_COMMITTED_DURING_TOOL'), text('Final answer.'));
  const a = collect(runTurn(f.app, f.web.id, 'Read fixture.'));
  try {
    await running.promise;
    const b = await collect(runTurn(f.app, f.dm.id, 'Other session.', undefined, { noTools: true }));
    assert.ok(!b.some(e => e.type === 'notice' && e.kind === 'continuity'));
    finish.resolve(); await a;
    assert.equal(f.app.requests.length, 3); assert.match(liveNotes(f, 2)[0].content, /OTHER_COMMITTED_DURING_TOOL/);
  } finally { finish.resolve(); await a; f.close(); }
});

test('R1 queue waiting is charged as passive meter waiting and active abort retains lease through partial save', async () => {
  const f = fixture(); const release = await acquireSessionStep(f.app.store.db, 'held', new AbortController().signal).ready;
  f.app.settings.update({ turnBudgets: { chat: { on: true, tokens: 200_000, steps: 10, usd: 0, minutes: 10 } } });
  const waited = TurnMeter.prototype.waited; const waits: number[] = [];
  TurnMeter.prototype.waited = function(ms) { waits.push(ms); return waited.call(this, ms); };
  const it = runTurn(f.app, f.web.id, 'Waiting.', undefined, { noTools: true });
  try {
    await until(it, e => e.type === 'notice' && e.kind === 'continuity'); release(); await collect(it);
    assert.equal(waits.length, 1); assert.ok(waits[0] >= 0);
  } finally { TurnMeter.prototype.waited = waited; release(); await it.return(undefined); f.close(); }
  const g = fixture(); const abort = new AbortController(); const stream = runTurn(g.app, g.web.id, 'Partial.', abort.signal, { noTools: true });
  try {
    await until(stream, e => e.type === 'token'); abort.abort();
    const next = acquireSessionStep(g.app.store.db, 'after-partial', new AbortController().signal);
    assert.equal(next.waiting, true, 'aborting a started provider cannot expose uncommitted streamed text');
    await collect(stream); (await next.ready)();
    assert.ok(g.app.store.messages(g.web.id).some(m => m.role === 'assistant' && m.meta?.partial && m.content));
  } finally { await stream.return(undefined); g.close(); }
});

test('R1 forbidden audiences/options get neither new context nor session tool schemas', async () => {
  const cases: { name: string; opts?: TurnOptions; role?: 'member' | 'demo' | 'offRecord'; patch?: Record<string, unknown> }[] = [
    ...[{ externalApp: false }, { clientHistory: [] }, { clientNote: { text: '' } }, { roomCrisis: false }, { roomId: 0 }, { resume: false }, { voiceRoom: false }, { persist: undefined }, { recorder: RunRecorder.none() }].map(opts => ({ name: JSON.stringify(opts), opts: opts as TurnOptions })),
    ...(['member', 'demo', 'offRecord'] as const).map(role => ({ name: role, role })),
    { name: 'private', patch: { private: true } }, { name: 'API', patch: { channel: 'api' } }, { name: 'room', patch: { channel: 'discord-work' } },
  ];
  for (const c of cases) {
    const f = fixture();
    try {
      f.app.store.addMessage(f.dm.id, 'user', 'FORBIDDEN_CROSS_SESSION_DATA');
      for (const tool of createSessionContinuityTools()) f.app.tools.add(tool);
      if (c.role) f.app[c.role] = true as never;
      if (c.patch) for (const [k, v] of Object.entries(c.patch)) f.app.store.db.prepare(`UPDATE conversations SET ${k}=? WHERE id=?`).run(typeof v === 'boolean' ? Number(v) : v as string, f.web.id);
      await collect(runTurn(f.app, f.web.id, 'Hello.', undefined, c.opts));
      for (const req of f.app.requests) {
        assert.ok(!req.messages.some(m => m.content.startsWith(SESSION_CONTINUITY_MARK)), c.name);
        assert.ok(!req.messages.some(m => m.content.includes('FORBIDDEN_CROSS_SESSION_DATA')), c.name);
        assert.ok(!req.tools?.some(t => t.name.startsWith('session_')), c.name);
      }
    } finally { f.close(); }
  }
});

test('R1 source provenance, pickup de-duplication and legacy room-to-owner context stay bounded', async () => {
  const f = fixture();
  try {
    f.app.store.addMessage(f.dm.id, 'user', 'ELIGIBLE_DM_LINE');
    f.app.store.addMessage(f.dm.id, 'user', 'IMPORTED_MUST_STAY_OUT', { importedFrom: 'fixture' });
    const room = f.app.store.createConversation({ channel: 'discord', channelKey: 'fixture-room', partner: 'Fixture room' });
    f.app.store.addMessage(room.id, 'user', '[Casey]: SANCTIONED_ROOM_LINE');
    const work = f.app.store.createConversation({ channel: 'discord-work', channelKey: 'fixture-work-room' });
    f.app.store.addMessage(work.id, 'user', 'SANCTIONED_WORK_ROOM_LINE');
    await collect(runTurn(f.app, f.web.id, 'Hello.', undefined, { noTools: true }));
    const note = liveNotes(f)[0].content; assert.match(note, /ELIGIBLE_DM_LINE/); assert.match(note, /SANCTIONED_ROOM_LINE/); assert.match(note, /SANCTIONED_WORK_ROOM_LINE/); assert.match(note, new RegExp(f.dm.id)); assert.ok(!note.includes('IMPORTED_MUST_STAY_OUT')); assert.ok(note.length <= 3800);
    pickupsFor(f.app)!.make(f.web.id, f.dm.id, 'command');
    await collect(runTurn(f.app, f.web.id, 'Carry on.', undefined, { noTools: true }));
    assert.ok(!liveNotes(f, 1).some(m => m.content.includes('ELIGIBLE_DM_LINE')), 'pickup source is absent from the separate live note');
    assert.match(f.app.requests[1].messages[0].content, /ELIGIBLE_DM_LINE/, 'existing explicit pickup still carries its source');
    await collect(runTurn(f.app, room.id, 'Room request.', undefined, { noTools: true }));
    assert.equal(liveNotes(f, 2).length, 0, 'no new room recipient');
  } finally { f.close(); }
});

test('R1 current forgetting during a tool step withdraws continuity while fresh ordinary history continues', async () => {
  const f = fixture(); const source = f.app.store.addMessage(f.web.id, 'user', 'Historical current source.');
  for (const tool of createSessionContinuityTools()) f.app.tools.add(tool);
  f.app.tools.add({ spec: { name: 'forget_fixture', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Forget fixture', async run() { f.app.store.updateMessageMeta(source.id, { forgotten: true }); return 'Forgotten.'; } });
  f.app.script.push([call('forget', 'forget_fixture', {})], text('Fresh continuation.'));
  try {
    await collect(runTurn(f.app, f.web.id, 'Forget the historical source.'));
    assert.equal(f.app.requests.length, 2);
    assert.ok(!f.app.requests[1].messages.some(m => m.content.startsWith(SESSION_CONTINUITY_MARK)));
    assert.ok(!f.app.requests[1].tools?.some(t => t.name.startsWith('session_')));
    assert.ok(!f.app.requests[1].messages.some(m => m.content === 'Historical current source.'));
  } finally { f.close(); }
});

test('R1 actual safe-point steering rebuilds history and separate stores remain independent', async () => {
  const f = fixture(); const g = fixture(); const release = await acquireSessionStep(g.app.store.db, 'independent', new AbortController().signal).ready;
  try {
    f.app.tools.add({ spec: { name: 'read_file', description: 'fixture', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Read fixture', async run() { return 'Fixture.'; } });
    f.app.script.push([call('read', 'read_file', {})], text('Finished.'));
    const events: ChatEvent[] = [];
    for await (const ev of runTurn(f.app, f.web.id, 'Read fixture.')) { events.push(ev); if (ev.type === 'tool_result') pendingFor(f.app).add(f.web.id, { kind: 'steer', content: 'STEER_AT_SAFE_POINT', sender: 'owner' }); }
    assert.equal(f.app.requests.length, 2); assert.ok(events.some(e => e.type === 'steer')); assert.ok(f.app.requests[1].messages.some(m => m.content === 'STEER_AT_SAFE_POINT')); assert.ok(!events.some(e => e.type === 'notice' && e.kind === 'continuity'));
  } finally { release(); f.close(); g.close(); }
});

test('R1 replay omits only generated marked extras with no source/gate access, preserving ordinary dialogue/audit', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  const headers = SessionHandoffStore.prototype.headers;
  try {
    const ordinary = `${SESSION_CONTINUITY_MARK} This is ordinary owner text.`;
    const user = f.app.store.addMessage(f.web.id, 'user', ordinary);
    const generated = `${SESSION_CONTINUITY_MARK}\nGenerated synthetic live context.`;
    const rec = new RunRecorder(f.app.runs, { kind: 'turn', conversationId: f.web.id, userMessageId: user.id });
    rec.startStep({ system: 'Fixture system.', historyFromId: user.id, historyToId: user.id, extra: [generated], inputsSha: inputsHash([{ role: 'user', content: ordinary }, { role: 'system', content: generated }]) });
    rec.modelCall({ model: 'fixture', provider: 'Fixture', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: 1, ok: true }); rec.close('ok');
    const rebuilt = rebuildStep(f.app, rec.id, 0);
    assert.equal(rebuilt.exact, false); assert.deepEqual(rebuilt.extra, []); assert.ok(rebuilt.messages.some(m => m.role === 'user' && m.content === ordinary));
    assert.deepEqual(f.app.runs!.step(rec.id, 0)!.extra, [generated]); assert.equal(f.app.requests.length, 0);
    assert.ok(rebuilt.problems.some(p => p.key.includes('Live session context')));
    const retained = f.app.runs!.step(rec.id, 0)!;
    release = await acquireSessionStep(f.app.store.db, 'held-during-replay', new AbortController().signal).ready;
    SessionHandoffStore.prototype.headers = () => { throw new Error('Replay must not read live handoff sources'); };
    f.app.script.push(text('Branch answer.'));
    const events = [];
    for await (const event of branchRun(f.app, rec.id, { fromStep: 0, notes: [generated], recall: false, sandbox: { keep: false } })) events.push(event);
    assert.equal(f.app.requests.length, 1, 'held live gate cannot block replay');
    assert.ok(!f.app.requests[0].messages.some(m => m.role === 'system' && m.content.startsWith(SESSION_CONTINUITY_MARK)));
    assert.ok(f.app.requests[0].messages.some(m => m.role === 'user' && m.content === ordinary));
    assert.equal(events.find(e => e.type === 'branch')?.exact, false);
    assert.deepEqual(f.app.runs!.step(rec.id, 0), retained, 'original audit bytes remain inspectable');
  } finally { SessionHandoffStore.prototype.headers = headers; release?.(); f.close(); }
});

test('mnt2: with the default cap web and DM steps overlap; a second step in the same chat still waits', async () => {
  const f = fixture(); f.app.settings.update({ chats: { continuity: { enabled: true } } } as never);
  const firstIn = deferred(); const finish = deferred();
  const original = f.app.providerFactory!; let streamed = 0;
  f.app.providerFactory = config => {
    const p = original(config); return { ...p, config, listModels: p.listModels.bind(p), async *stream(req) {
      f.app.requests.push(structuredClone({ ...req, signal: undefined }));
      if (++streamed === 1) { firstIn.resolve(); await finish.promise; yield { type: 'text' as const, text: 'Web answer.' }; }
      else yield { type: 'text' as const, text: 'DM answer.' };
    } };
  };
  const a = collect(runTurn(f.app, f.web.id, 'First request.', undefined, { noTools: true }));
  try {
    await firstIn.promise;
    const events = await collect(runTurn(f.app, f.dm.id, 'Second request.', undefined, { noTools: true }));
    assert.equal(streamed, 2, 'the DM step ran while the web step was still streaming');
    assert.ok(!events.some(e => e.type === 'notice' && e.kind === 'continuity'), 'no wait notice for another chat');
    assert.ok(events.some(e => e.type === 'done'));
    // The DM note still comes from committed dialogue only: the web reply was not finished yet.
    assert.ok(!liveNotes(f, 1).some(m => m.content.includes('Web answer.')));
  } finally { finish.resolve(); await a; f.close(); }
});

// N1 (docs/design/NEXT.md): Auto picks the model per job from what is connected (tools, pictures,
// on this computer, measured speed, recent errors, spend limit), and the next-best model answers
// once when the pick errors, says nothing, or is slow; private chats never leave this computer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { autoChoose, autoTiming, forgetStats, modelStats, reasonLine, scoreCandidate, spendLimitHit, type AutoCand } from '../src/auto-route.ts';
import { resolveChain, runTurn, slowNoticeTiming, type ChatEvent } from '../src/chat.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { makeApp, tempDir } from './helpers.ts';

const c = (x: Partial<AutoCand> & { model: string }): AutoCand => ({ providerId: 'p', provider: 'P', local: false, billing: 'subscription', ...x });

test('tools: a model that can use tools wins tools and long tasks over one that cannot', () => {
  const picks = autoChoose([c({ model: 'plain:8b', tools: false }), c({ model: 'helper:8b', tools: true })], 'coding');
  assert.equal(picks[0].model, 'helper:8b');
  assert.match(picks[0].why, /^Auto for tools and long tasks: .*can use tools/);
});

test('vision: only models that can see are picked for pictures', () => {
  const picks = autoChoose([c({ model: 'text-only:8b', vision: false }), c({ model: 'gemma4:12b' })], 'vision');
  assert.deepEqual(picks.map((p) => p.model), ['gemma4:12b']);
  assert.equal(autoChoose([c({ model: 'text-only:8b', vision: false })], 'vision').length, 0);
});

test('private: only models on this computer', () => {
  const cands = [c({ model: 'gpt-5', billing: 'api' }), c({ providerId: 'loc', model: 'llama3:8b', local: true, billing: 'local' }), c({ providerId: 'loc', model: 'glm-5:cloud', local: false })];
  const picks = autoChoose(cands, 'chat', { localOnly: true });
  assert.deepEqual(picks.map((p) => p.model), ['llama3:8b']);
});

test('speed: the model that answered quickly here beats a slow one; too big for the processor sinks', () => {
  const picks = autoChoose([c({ model: 'slow:8b', firstMs: 60_000 }), c({ model: 'quick:8b', firstMs: 2_000 })], 'chat');
  assert.equal(picks[0].model, 'quick:8b');
  assert.match(picks[0].why, /first word in 2 s here/);
  assert.equal(autoChoose([c({ model: 'big:27b', cpuBig: true }), c({ model: 'other:8b' })], 'chat')[0].model, 'other:8b');
});

test('errors: a model that failed often lately drops below a steady one', () => {
  const picks = autoChoose([c({ model: 'flaky:8b', calls: 10, errors: 6 }), c({ model: 'steady:8b', calls: 10, errors: 0 })], 'chat');
  assert.equal(picks[0].model, 'steady:8b');
  assert.ok(scoreCandidate(c({ model: 'flaky:8b', calls: 10, errors: 6 }), 'chat')!.bad.some((b) => /failed 60%/.test(b)));
});

test('spend limit: pay-per-use models are skipped once the limit is reached', () => {
  const cands = [c({ model: 'gpt-5', billing: 'api' }), c({ model: 'local:8b', billing: 'local', local: true })];
  assert.equal(autoChoose(cands, 'coding')[0].model, 'gpt-5');
  assert.deepEqual(autoChoose(cands, 'coding', { spendHit: true }).map((p) => p.model), ['local:8b']);
});

test('remixes and raw pulls are not Auto\'s first choice; on the processor the smaller model goes first', () => {
  assert.equal(autoChoose([c({ model: 'hf.co/someone/Big-27B-ablit:Q4', tools: true }), c({ model: 'qwen3.5:27b', tools: true })], 'coding')[0].model, 'qwen3.5:27b');
  assert.equal(autoChoose([c({ model: 'qwen3.5:9b', cpuBig: true }), c({ model: 'qwen3.5:4b', cpuBig: true })], 'chat')[0].model, 'qwen3.5:4b');
});

test('the reason is one line, and never empty', () => {
  assert.equal(reasonLine('chat', [], []), 'Auto for talking: the best match connected.');
  assert.equal(reasonLine('research', [], ["can't use tools"]), "Auto for web research: best left (can't use tools).");
});

// ---- Through the real chain and turn, with fake providers ----

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-14T15:00:00Z') };
const app = makeApp(dir, clock);
const mode: Record<string, 'ok' | 'fail' | 'slow' | 'empty'> = {};
class Fake implements Provider {
  readonly config: ProviderConfig;
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const m = mode[this.config.id] ?? 'ok';
    if (m === 'fail') throw new Error('503 overloaded');
    if (m === 'slow') await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true }));
    if (m === 'empty') return;
    yield { type: 'text', text: `${this.config.id}/${req.model} here.` };
  }
}
const turn = async (convId: string, text: string): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, text)) out.push(ev);
  return out;
};

before(() => {
  // The 90 s "still thinking" notice timer would keep the test process open.
  slowNoticeTiming.anyMs = 0;
  slowNoticeTiming.cpuMs = 0;
  app.providerFactory = (config) => new Fake(config);
  new RunStore(app.store.db, () => clock.now);
  app.settings.update({
    providers: [
      { id: 'fast', label: 'Fast', kind: 'openai-compatible', baseUrl: 'http://fast.example', defaultModel: 'quick-flash' },
      { id: 'slow', label: 'Slowpoke', kind: 'openai-compatible', baseUrl: 'http://slow.example', defaultModel: 'big-model' },
      { id: 'loc', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3:8b', local: true },
    ],
    defaultProviderId: 'slow',
    defaultModel: 'big-model',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: clock.now.toISOString(),
    autoJobs: ['chat', 'coding', 'vision', 'research'],
  });
});
after(() => {
  app.store.close();
  cleanup();
});

function seedRun(providerId: string, model: string, firstMs: number, ok = true): void {
  const db = app.store.db;
  const r = db.prepare("INSERT INTO runs (kind, title, started_at, status) VALUES ('turn', 't', ?, ?)").run(clock.now.toISOString(), ok ? 'ok' : 'error');
  db.prepare('INSERT INTO run_steps (run_id, idx, at, calls) VALUES (?, 0, ?, ?)').run(r.lastInsertRowid, clock.now.toISOString(), JSON.stringify([{ model, providerId, provider: providerId, in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: firstMs + 500, firstMs, ok }]));
}

test('measured speed from the runs table steers the pick; the chain has the reason', () => {
  for (let i = 0; i < 3; i++) seedRun('slow', 'big-model', 50_000);
  for (let i = 0; i < 3; i++) seedRun('fast', 'quick-flash', 1_500);
  forgetStats(app.store.db);
  const stats = modelStats(app.store.db, clock.now);
  assert.equal(stats.get('fast/quick-flash')?.calls, 3);
  const chain = resolveChain(app, app.store.createConversation(), 'turn');
  assert.equal(chain[0].provider.config.id, 'fast');
  assert.equal(chain[0].from, 'auto');
  assert.match(chain[0].why ?? '', /^Auto for talking: .*first word in 2 s here/);
  assert.ok(chain.length <= 2);
});

test('a private chat on Auto stays on this computer; a companion model still wins', () => {
  const priv = resolveChain(app, app.store.createConversation({ private: true }), 'turn');
  assert.deepEqual(priv.map((x) => x.provider.config.id), ['loc']);
  app.settings.update({ companionModel: { providerId: 'slow', model: 'big-model' } });
  assert.equal(resolveChain(app, app.store.createConversation(), 'turn')[0].provider.config.id, 'slow');
  app.settings.update({ companionModel: undefined });
});

test('Auto off for a job: the job keeps its fixed route (existing installs unchanged)', () => {
  app.settings.update({ autoJobs: [] });
  assert.equal(resolveChain(app, app.store.createConversation(), 'turn')[0].provider.config.id, 'slow');
  app.settings.update({ autoJobs: ['chat', 'coding', 'vision', 'research'] });
});

test('fallback on error: the next-best model answers once and says so', async () => {
  forgetStats(app.store.db);
  mode.fast = 'fail';
  const conv = app.store.createConversation();
  const evs = await turn(conv.id, 'hello');
  const note = evs.find((e) => e.type === 'notice' && e.kind === 'fallback') as { text: string } | undefined;
  assert.ok(note, 'a fallback note');
  assert.match(note!.text, /^Fast \(quick-flash\) failed: 503 overloaded, so .* took over\.$/);
  assert.ok(evs.some((e) => e.type === 'token'));
  mode.fast = 'ok';
});

test('fallback on a slow first word (Auto deadline), and on an empty reply after the retry', async () => {
  forgetStats(app.store.db);
  autoTiming.firstMs = 200;
  mode.fast = 'slow';
  const evs = await turn(app.store.createConversation().id, 'are you there?');
  const note = evs.find((e) => e.type === 'notice' && e.kind === 'fallback') as { text: string } | undefined;
  assert.match(note?.text ?? '', /^Fast \(quick-flash\) gave no answer within 0 seconds, so .* took over\.$/);
  autoTiming.firstMs = 45_000;
  mode.fast = 'empty';
  const evs2 = await turn(app.store.createConversation().id, 'hi');
  const note2 = evs2.find((e) => e.type === 'notice' && e.kind === 'fallback') as { text: string } | undefined;
  assert.match(note2?.text ?? '', /^Fast \(quick-flash\) returned no answer, so .* took over\.$/);
  assert.ok(!evs2.some((e) => e.type === 'error'));
  mode.fast = 'ok';
});

test('never from this computer to the cloud in a private chat', async () => {
  mode.loc = 'fail';
  const conv = app.store.createConversation({ private: true });
  const evs = await turn(conv.id, 'secret');
  assert.ok(!evs.some((e) => e.type === 'notice' && e.kind === 'fallback'), 'no cloud fallback');
  assert.ok(evs.some((e) => e.type === 'error'));
  mode.loc = 'ok';
});

test('the spend limit check reads the usage ledger', () => {
  app.settings.update({ spend: { dayUsd: 1, monthUsd: 0, perTool: {}, prices: {} } } as never);
  const was = app.usage;
  app.usage = { spentSince: () => ({ usd: 2, toolUsd: 0, tokens: 0 }) } as never;
  assert.equal(spendLimitHit(app), true);
  app.usage = { spentSince: () => ({ usd: 0.5, toolUsd: 0, tokens: 0 }) } as never;
  assert.equal(spendLimitHit(app), false);
  app.usage = was;
  app.settings.update({ spend: undefined } as never);
});

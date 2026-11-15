// R1 (d): fixes from the live servers' logs (counts only, 2026-11-12..15).
// Top cause: on one server the only chat model (an Ollama cloud model) answered with no words in 34 of
// 78 turns (17 still empty after the think-off retry) while the owner's other model answered all 73 of
// its turns. With no fallback configured the turn ended in an error. Now a model the owner already
// picked elsewhere, with a clean record here, takes over once and says so.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { forgetStats } from '../src/auto-route.ts';
import { rescueChoice, runTurn, slowNoticeTiming, type ChatEvent } from '../src/chat.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { makeApp, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-15T15:00:00Z') };
const app = makeApp(dir, clock);
const mode: Record<string, 'ok' | 'empty'> = {};
class Fake implements Provider {
  readonly config: ProviderConfig;
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if ((mode[`${this.config.id}/${req.model}`] ?? 'ok') === 'empty') return;
    yield { type: 'text', text: `${this.config.id}/${req.model} here.` };
  }
}
const turn = async (convId: string, text: string): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, text)) out.push(ev);
  return out;
};
function seedRun(providerId: string, model: string, ok = true): void {
  const db = app.store.db;
  const r = db.prepare("INSERT INTO runs (kind, title, started_at, status) VALUES ('turn', 't', ?, ?)").run(clock.now.toISOString(), ok ? 'ok' : 'error');
  db.prepare('INSERT INTO run_steps (run_id, idx, at, calls) VALUES (?, 0, ?, ?)').run(r.lastInsertRowid, clock.now.toISOString(), JSON.stringify([{ model, providerId, provider: providerId, in: 1, out: 1, cached: 0, usd: 0, reported: true, ms: 900, firstMs: 400, ok }]));
}

before(() => {
  slowNoticeTiming.anyMs = 0;
  slowNoticeTiming.cpuMs = 0;
  app.providerFactory = (config) => new Fake(config);
  new RunStore(app.store.db, () => clock.now);
  app.settings.update({
    providers: [
      { id: 'oll', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'beam:cloud', local: true },
      { id: 'home', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11435/v1', defaultModel: 'llama3:8b', local: true },
    ],
    defaultProviderId: 'oll',
    defaultModel: 'gemma4:31b-cloud',
    routes: { chat: { providerId: 'oll', model: 'beam:cloud' }, quick: { providerId: 'home', model: 'llama3:8b' } },
    autoJobs: [],
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
});
after(() => {
  app.store.close();
  cleanup();
});

test('no proven model of the owner: nothing to take over (a model only listed is never guessed)', () => {
  forgetStats(app.store.db);
  const conv = app.store.createConversation();
  assert.equal(rescueChoice(app, conv, [{ providerId: 'oll', model: 'beam:cloud' }]), undefined);
});

test('an empty reply twice with no fallback: the owner\'s proven model answers once and says so', async () => {
  for (let i = 0; i < 4; i++) seedRun('oll', 'gemma4:31b-cloud');
  for (let i = 0; i < 4; i++) seedRun('home', 'llama3:8b');
  for (let i = 0; i < 4; i++) seedRun('oll', 'beam:cloud', i % 2 === 0);
  forgetStats(app.store.db);
  const conv = app.store.createConversation();
  const pick = rescueChoice(app, conv, [{ providerId: 'oll', model: 'beam:cloud' }]);
  assert.ok(pick);
  assert.notEqual(pick!.model, 'beam:cloud', 'never the model that just failed');
  mode['oll/beam:cloud'] = 'empty';
  const evs = await turn(conv.id, 'hello');
  const note = evs.find((e) => e.type === 'notice' && e.kind === 'fallback') as { text: string } | undefined;
  assert.match(note?.text ?? '', /^Ollama \(beam:cloud\) returned no answer, so .* took over\.$/);
  assert.ok(!evs.some((e) => e.type === 'error'), 'no error for the person');
  assert.ok(evs.some((e) => e.type === 'token'));
  mode['oll/beam:cloud'] = 'ok';
});

test('a private chat is rescued only by a model on this computer, never a cloud one', () => {
  forgetStats(app.store.db);
  const conv = app.store.createConversation({ private: true });
  const pick = rescueChoice(app, conv, [{ providerId: 'home', model: 'qwen:4b' }]);
  assert.equal(pick?.model, 'llama3:8b');
  assert.equal(rescueChoice(app, conv, [{ providerId: 'home', model: 'llama3:8b' }]), undefined, 'gemma4:31b-cloud runs on Ollama\'s servers');
});

test('a flaky model is no rescue', () => {
  for (let i = 0; i < 6; i++) seedRun('home', 'llama3:8b', false);
  forgetStats(app.store.db);
  const conv = app.store.createConversation({ private: true });
  assert.equal(rescueChoice(app, conv, [{ providerId: 'oll', model: 'beam:cloud' }]), undefined);
});

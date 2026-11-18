// V1.5 (docs/design/V1COST.md): Cost autopilot, a quality bar per job. Auto tries the next cheaper
// model (on this computer first) on a sample of past turns with the M9 eval loop and moves the job
// down only when it passes; Undo on every move; "saved $X this month"; private chats never leave
// the models on this computer.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { autoChain, type AutoCand } from '../src/auto-route.ts';
import { resolveChain, runTurn } from '../src/chat.ts';
import { barVerdict, cheaperCandidates, CostAutopilot, RETRY_DAYS, SAMPLE_TASKS } from '../src/cost-autopilot.ts';
import { Evals, type EvalResult } from '../src/evals.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { priceTable, UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-12T15:00:00Z');
const ANSWER = 'The capital of France is Paris, a lovely city on the Seine river.';
const usage = (input: number, output: number): StreamEvent => ({ type: 'usage', input, output });
const lastUser = (req: ChatRequest) => [...req.messages].reverse().find((m) => m.role === 'user');

interface World {
  app: TestApp;
  ap: CostAutopilot;
  dir: string;
  clock: { now: Date };
  models: Record<string, string>;
}

/**
 * A cloud model Auto picks first for talking (gpt-5-mini, paid), and one local model whose answers
 * are either the same as the cloud's (`good`) or useless (`bad`).
 */
function world(t: { after: (fn: () => void) => void }, local: 'good' | 'bad', opts: { cheapCloud?: boolean } = {}): World {
  const { dir, cleanup } = tempDir();
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.usage.prices = () => priceTable(app.settings.get().prices);
  const runs = new RunStore(app.store.db, () => clock.now);
  runs.usage = app.usage;
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  const models: Record<string, string> = { 'gpt-5-mini': ANSWER, 'gpt-4.1-nano': ANSWER, 'lc-good': ANSWER, 'lc-bad': 'Sorry, no idea at all.' };
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    async listModels() {
      return Object.keys(models);
    },
    async *stream(req: ChatRequest) {
      const said = String(lastUser(req)?.content ?? '');
      yield { type: 'text', text: /capital/i.test(said) ? (models[req.model] ?? 'ok') : 'ok' };
      yield usage(1000, 200);
    },
  });
  const providers: ProviderConfig[] = [
    { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-5-mini' },
    { id: 'loc', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: `lc-${local}` },
  ];
  if (opts.cheapCloud) providers[1] = { id: 'cheap', label: 'Cheap cloud', kind: 'openai-compatible', baseUrl: 'https://cheap.example.com/v1', defaultModel: 'gpt-4.1-nano' };
  app.settings.update({
    providers,
    defaultProviderId: 'cloud',
    defaultModel: 'gpt-5-mini',
    autoJobs: ['chat'],
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    prices: [
      { providerId: 'cloud', model: 'gpt-5-mini', inPerM: 1, outPerM: 4 },
      { providerId: 'cheap', model: 'gpt-4.1-nano', inPerM: 0.1, outPerM: 0.4 },
    ],
  } as never);
  app.evals = new Evals(app);
  app.evals.lastActivity = () => 0;
  const ap = new CostAutopilot(app);
  app.costAutopilot = ap;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, ap, dir, clock, models };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Past talking turns the owner liked ("thanks"): the tasks a trial replays. */
async function seedTurns(w: World, n: number, o: { private?: boolean } = {}) {
  for (let i = 0; i < n; i++) {
    const conv = w.app.store.createConversation({ mode: 'chat', title: `Q${i}`, ...(o.private ? { private: true } : {}) });
    const evs = await drain(runTurn(w.app, conv.id, `What is the capital of France? (${i})`));
    assert.ok(evs.some((e) => (e as { type: string }).type === 'done'), JSON.stringify(evs.filter((e) => (e as { type: string }).type === 'error')));
    w.app.store.addMessage(conv.id, 'user', 'thanks, perfect');
  }
}

const cand = (over: Partial<AutoCand>): AutoCand => ({ providerId: 'p', provider: 'P', model: 'm', local: false, billing: 'api', ...over });

test('V1.5: the next cheaper models come local first, then subscriptions, then lower prices (unknown prices never count as cheaper)', () => {
  const current = cand({ providerId: 'c', model: 'gpt-5-mini' });
  const price: Record<string, number | null> = { 'gpt-5-mini': 2, 'gpt-4.1-nano': 0.2, 'mid-model': 1, pricey: 5, unknown: null };
  const cands = [
    current,
    cand({ providerId: 'c', model: 'gpt-4.1-nano' }),
    cand({ providerId: 'c', model: 'mid-model' }),
    cand({ providerId: 'c', model: 'pricey' }),
    cand({ providerId: 'c', model: 'unknown' }),
    cand({ providerId: 's', model: 'sub-model', billing: 'subscription' }),
    cand({ providerId: 'l', model: 'qwen3:8b', local: true, billing: 'local' }),
  ];
  const out = cheaperCandidates(cands, current, 'chat', { price: (c) => price[c.model] ?? null });
  assert.deepEqual(out.map((c) => c.model), ['qwen3:8b', 'sub-model', 'mid-model', 'gpt-4.1-nano']);
  // Already on this computer: nothing is cheaper.
  assert.deepEqual(cheaperCandidates(cands, cands[6], 'chat', { price: (c) => price[c.model] ?? null }), []);
  // Refused models (a failed trial, an Undo) are skipped; private / no-cloud mode keeps only local ones.
  assert.deepEqual(cheaperCandidates(cands, current, 'chat', { price: (c) => price[c.model] ?? null, skip: (c) => c.model === 'qwen3:8b' }).map((c) => c.model)[0], 'sub-model');
  assert.deepEqual(cheaperCandidates(cands, current, 'chat', { price: (c) => price[c.model] ?? null, localOnly: true }).map((c) => c.model), ['qwen3:8b']);
});

test('V1.5: the verdict reads only the quality parts and needs enough pairs', () => {
  const task = (idx: number, c: number, v: number | 'missing') => ({ idx, title: `t${idx}`, control: { runId: 1, score: c, parts: { done: 1, feedback: c } }, variants: { v1: v === 'missing' ? { runId: null, score: null, parts: {}, delta: null, outcome: 'missing' as const } : { runId: 2, score: v, parts: { done: 1, feedback: v, cost: 1 }, delta: v - c, outcome: 'tie' as const } } });
  const res = (tasks: ReturnType<typeof task>[]): EvalResult => ({ weights: {} as never, alpha: 0.05, variants: [{ id: 'v1', pairs: tasks.length, mean: 0, controlMean: 0, pct: 0, wins: 0, ties: 0, losses: 0, p: 1, significant: false, verdict: 'unclear' }], winner: null, headline: { key: '', text: '' }, tasks });
  assert.equal(barVerdict(res([task(0, 1, 1), task(1, 1, 1), task(2, 1, 0.99)])).pass, true);
  assert.equal(barVerdict(res([task(0, 1, 1), task(1, 1, 1)])).pass, false, 'two pairs are too few');
  const bad = barVerdict(res([task(0, 1, 0.2), task(1, 1, 0.1), task(2, 1, 1), task(3, 1, 1)]));
  assert.equal(bad.pass, false);
  assert.equal(bad.losses, 2);
  // A variant that failed to answer counts as a loss.
  assert.equal(barVerdict(res([task(0, 1, 1), task(1, 1, 1), task(2, 1, 'missing'), task(3, 1, 'missing'), task(4, 1, 1)])).losses, 2);
  assert.equal(barVerdict(null).pass, false);
});

test('V1.5: a cheaper model that passes moves the job; Auto uses it first, keeps the old pick as backup; saved $ this month; Undo puts it back', async (t) => {
  const w = world(t, 'good');
  await seedTurns(w, 5);
  assert.equal(autoChain(w.app, 'chat')[0].model, 'gpt-5-mini', 'Auto picks the cloud model first');
  // Best (the default) never tries anything.
  assert.equal(w.ap.view().jobs.find((j) => j.job === 'chat')!.bar, 'best');
  await assert.rejects(w.ap.tryJob('chat'), /Good enough/);
  w.ap.setBar('chat', 'good');
  const trial = await w.ap.tryJob('chat', { wait: true });
  assert.equal(trial.state, 'passed', JSON.stringify(trial));
  assert.ok(trial.pairs! >= 3 && trial.pairs! <= SAMPLE_TASKS);
  assert.deepEqual(trial.to, { providerId: 'loc', model: 'lc-good', label: 'lc-good · Local' });
  const chain = autoChain(w.app, 'chat');
  assert.deepEqual(chain.map((p) => p.model), ['lc-good', 'gpt-5-mini']);
  assert.match(chain[0].why, /cheaper and good enough on your past tasks/);
  // A real turn now runs on the cheaper model.
  const conv = w.app.store.createConversation({ mode: 'chat' });
  assert.equal(resolveChain(w.app, conv, 'turn')[0].model, 'lc-good');
  // Saved this month: the cheaper model's talking calls since the move, at the old price.
  w.clock.now = new Date(NOW.getTime() + 3600_000);
  const loc = w.app.settings.get().providers.find((p) => p.id === 'loc')!;
  w.app.usage!.record(loc, 'lc-good', { input: 1_000_000, output: 250_000 }, { purpose: 'chat' });
  const v = w.ap.view();
  const job = v.jobs.find((j) => j.job === 'chat')!;
  assert.equal(job.move?.to.model, 'lc-good');
  assert.equal(v.savedUsd, 2, '1M in at $1 + 0.25M out at $4, now $0');
  assert.equal(job.savedUsd, 2);
  // Undo: back to the cloud pick, and the local model is not tried again for a while.
  w.ap.undo('chat');
  assert.equal(autoChain(w.app, 'chat')[0].model, 'gpt-5-mini');
  const after = w.ap.view().jobs.find((j) => j.job === 'chat')!;
  assert.equal(after.move, undefined);
  assert.equal(after.next, undefined, 'the undone model is refused for now');
  assert.equal(w.ap.view().savedUsd, 2, 'what it saved before the Undo still counts this month');
  assert.ok(w.ap.view().log.some((l) => l.kind === 'undone'));
  w.clock.now = new Date(NOW.getTime() + (RETRY_DAYS + 1) * 86_400_000);
  assert.equal(w.ap.view().jobs.find((j) => j.job === 'chat')!.next?.model, 'lc-good', 'offered again after the refusal ends');
});

test('V1.5: a cheaper model that fails does not move the job, and is not retried', async (t) => {
  const w = world(t, 'bad');
  await seedTurns(w, 5);
  w.ap.setBar('chat', 'good');
  const trial = await w.ap.tryJob('chat', { wait: true });
  assert.equal(trial.state, 'failed', JSON.stringify(trial));
  assert.ok(trial.losses! >= 2);
  assert.equal(autoChain(w.app, 'chat')[0].model, 'gpt-5-mini');
  assert.equal(w.ap.view().jobs.find((j) => j.job === 'chat')!.move, undefined);
  await assert.rejects(w.ap.tryJob('chat'), /No cheaper model/);
});

test('V1.5: private chats never leave this computer: a moved cloud model is skipped, trials never replay a private chat in the cloud', async (t) => {
  const w = world(t, 'good', { cheapCloud: true });
  // Private turns ran on a model on this computer that is gone now (so only cloud models are left).
  const s0 = w.app.settings.get();
  w.app.settings.update({ providers: [...s0.providers, { id: 'loc', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'lc-good' }] });
  await seedTurns(w, 4, { private: true });
  w.app.settings.update({ providers: s0.providers });
  w.ap.setBar('chat', 'good');
  const trial = await w.ap.tryJob('chat', { wait: true });
  assert.equal(trial.to.model, 'gpt-4.1-nano');
  assert.equal(trial.state, 'nothing', 'only private turns: nothing to try it on');
  // A move to a cheaper cloud model (as after a passed trial on normal chats).
  w.ap.applyMove('chat', { providerId: 'cheap', model: 'gpt-4.1-nano' }, { providerId: 'cloud', model: 'gpt-5-mini' }, 0);
  assert.equal(autoChain(w.app, 'chat')[0].model, 'gpt-4.1-nano');
  assert.ok(autoChain(w.app, 'chat', { private: true }).every((p) => p.providerId !== 'cheap' && p.providerId !== 'cloud'));
  const priv = w.app.store.createConversation({ mode: 'chat', private: true });
  assert.throws(() => resolveChain(w.app, priv, 'turn'), /private/i, 'no local model connected: refused, never the cloud');
});

test('V1.5: Best undoes a move; the weekly tick tries a Good enough job once, only when idle', async (t) => {
  const w = world(t, 'good');
  await seedTurns(w, 4);
  w.ap.setBar('chat', 'good');
  w.app.evals!.lastActivity = () => w.clock.now.getTime();
  assert.equal(w.ap.tick(), undefined, 'not while she is being talked to');
  w.app.evals!.lastActivity = () => 0;
  const started = w.ap.tick();
  assert.ok(started);
  await w.ap.work;
  assert.equal(w.ap.view().jobs.find((j) => j.job === 'chat')!.move?.to.model, 'lc-good');
  assert.equal(w.ap.tick(), undefined, 'once a week at most');
  w.ap.setBar('chat', 'best');
  assert.equal(autoChain(w.app, 'chat')[0].model, 'gpt-5-mini');
  assert.ok(w.ap.view().log.some((l) => l.kind === 'best'));
  // The state is a plain file in the data folder.
  assert.ok(existsSync(join(w.app.dataDir, 'cost-autopilot.json')));
});

test('V1.5: routes under /api/model-jobs/cost (owner), and the web wiring', async (t) => {
  const w = world(t, 'good');
  await seedTurns(w, 3);
  const auth = new OwnerAuth(w.dir, () => w.clock.now);
  const token = String(auth.newToken);
  const server = createSaraServer({ app: w.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/model-jobs/cost`;
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const g = await req('');
  assert.equal(g.status, 200);
  assert.deepEqual((g.body.jobs as { job: string }[]).map((j) => j.job), ['chat', 'coding', 'research']);
  assert.equal((await req('', 'PUT', { job: 'chat', bar: 'nope' })).status, 400);
  assert.equal((await req('', 'PUT', { job: 'chat', bar: 'good' })).status, 200);
  const tr = await req('/try', 'POST', { job: 'chat' });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  await w.ap.work;
  assert.equal((await req('')).body.jobs && ((await req('')).body.jobs as { job: string; move?: unknown }[]).find((j) => j.job === 'chat')!.move !== undefined, true);
  assert.equal((await req('/undo', 'POST', { job: 'chat' })).status, 200);
  assert.equal((await req('/undo', 'POST', { job: 'chat' })).status, 409);
  // Web: the section on Which model does what, a tip per control, the module wired in app.js.
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['cap-box', 'cap-jobs', 'cap-saved']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="cap-usage-saved"/);
  const js = readFileSync(join(ROOT, 'web', 'cost-autopilot.js'), 'utf8');
  assert.match(js, /\/model-jobs\/cost/);
  assert.match(readFileSync(join(ROOT, 'web', 'app.js'), 'utf8'), /initCostAutopilot\(/);
});

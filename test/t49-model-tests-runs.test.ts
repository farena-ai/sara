// Model tests: runs against scripted models (a strong one, a weak one, a slow one, one that errors, a
// subscription one, a paid one, an embedding model): the plan's numbers, models as the outer loop,
// stop and resume, scores and ties, apply, stale results, autoNew, Auto, and the routes' shapes
// field by field (the web side is built against docs/MODEL_TESTS.md).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { autoChain } from '../src/auto-route.ts';
import { TASK_SET, TASKS, tasksFor, type TestTask } from '../src/model-test-tasks.ts';
import { ModelTests, pickBest, testTiming, THINK_ROOM, type Contender } from '../src/model-tests.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import type { RoutePurpose } from '../src/settings.ts';
import { listen, makeApp, readBody, ROOT, tempDir, type TestApp } from './helpers.ts';
import { BAD, GOOD, toyVector } from './t49-model-tests-fixtures.ts';

testTiming.warmMs = 5_000;

const LISTS: Record<string, string[]> = {
  home: ['gemma4:12b', 'weak:8b', 'slow:8b'],
  lan: ['broken:8b'],
  sub: ['sub-model'],
  cloud: ['paid-model'],
};

/** Each call: which provider and model, and which task (by its prompt). */
interface Seen {
  providerId: string;
  model: string;
  task: string;
  maxTokens?: number;
}

class ScriptModel implements Provider {
  readonly config: ProviderConfig;
  readonly #w: World;
  constructor(config: ProviderConfig, w: World) {
    this.config = config;
    this.#w = w;
  }
  async listModels(): Promise<string[]> {
    return this.#w.lists[this.config.id] ?? [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    // The task's prompt is the last thing the person said (a tool result may come after it).
    const prompt = String(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
    const task = prompt === 'Reply with OK.' ? 'warm-up' : (TASKS.find((t) => t.kind === 'chat' && t.prompt === prompt)?.id ?? '?');
    this.#w.seen.push({ providerId: this.config.id, model: req.model, task, maxTokens: req.maxTokens });
    if (req.model === 'blank:8b' && task !== 'warm-up') return;
    if (req.model === 'thinker:8b' && task !== 'warm-up' && this.#w.seen.filter((s) => s.model === req.model && s.task === task).length === 1) return yield { type: 'reasoning', chars: 900 };
    const delay = this.#w.delay[req.model] ?? 0;
    if (delay) await new Promise<void>((res, rej) => {
      const timer = setTimeout(res, delay);
      req.signal?.addEventListener('abort', () => (clearTimeout(timer), rej(req.signal!.reason)), { once: true });
    });
    if (req.model === 'broken:8b') throw new Error('500 model crashed');
    if (task === 'warm-up') return yield { type: 'text', text: 'OK' };
    const a = (req.model === 'weak:8b' ? BAD : GOOD)[task] ?? { text: '?' };
    if (a.text) yield { type: 'text', text: a.text };
    for (const call of a.calls ?? []) yield { type: 'tool_call', call };
  }
}

interface World {
  app: TestApp;
  tests: ModelTests;
  seen: Seen[];
  delay: Record<string, number>;
  lists: Record<string, string[]>;
  base: string;
  token: string;
  close: () => void;
}

async function world(t: { after: (fn: () => void | Promise<void>) => void }): Promise<World> {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-24T10:00:00Z') };
  const app = makeApp(dir, clock);
  const { server: emb, url: embUrl } = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { input: string[] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: toyVector(s) })) }));
  });
  const w = { seen: [] as Seen[], delay: {} as Record<string, number>, lists: structuredClone(LISTS) } as World;
  w.app = app;
  app.providerFactory = (config) => new ScriptModel(config, w);
  app.settings.update({
    providers: [
      { id: 'home', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', local: true },
      { id: 'lan', label: 'Box', kind: 'openai-compatible', baseUrl: 'http://192.168.1.50:11434/v1', local: true },
      { id: 'sub', label: 'Plan', kind: 'chatgpt', baseUrl: '' },
      { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      { id: 'emb', label: 'Meaning', kind: 'openai-compatible', baseUrl: `${embUrl}/v1`, local: true, defaultModel: 'toy-embed' },
    ],
    defaultProviderId: 'home',
    defaultModel: 'weak:8b',
    ownerName: 'Alex',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
  w.tests = app.modelTests = new ModelTests(app);
  const auth = new OwnerAuth(dir, () => clock.now);
  w.token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await w.tests.idle();
    server.close();
    emb.close();
    app.store.close();
    cleanup();
  });
  return w;
}

const api = async (w: World, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(w.base + path, { method, headers: { authorization: `Bearer ${w.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

/** Tasks a model takes part in, counted the way the plan should (independent of the engine). */
const taskCount = (jobs: RoutePurpose[]) => TASKS.filter((t: TestTask) => t.jobs.some((j) => jobs.includes(j))).length;
const TEXT_JOBS: RoutePurpose[] = ['chat', 'coding', 'planning', 'writing', 'research', 'quick', 'background', 'review'];

test('plan: models, who is left out and why, calls and paid calls; nothing runs', async (t) => {
  const w = await world(t);
  const r = await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'all' } });
  assert.equal(r.status, 200);
  const p = r.json;
  assert.deepEqual(Object.keys(p).sort(), ['calls', 'jobs', 'minutes', 'models', 'paidCalls']);
  for (const m of p.models) {
    assert.deepEqual(Object.keys(m).filter((k) => k !== 'why').sort(), ['billing', 'included', 'label', 'model', 'providerId']);
    assert.ok(['local', 'subscription', 'api'].includes(m.billing));
  }
  const by = (model: string) => p.models.find((m: { model: string }) => m.model === model);
  assert.equal(by('paid-model').included, false);
  assert.equal(by('paid-model').billing, 'api');
  assert.match(by('paid-model').why, /Paid per use/);
  assert.equal(by('sub-model').billing, 'subscription');
  assert.equal(by('gemma4:12b').billing, 'local');
  assert.equal(by('broken:8b').billing, 'local', 'a model on the home network is the owner\'s own hardware');
  assert.equal(by('toy-embed').included, true);
  assert.ok(!p.jobs.includes('adult'), 'adult mode is off');
  // home: gemma4 sees pictures (+ vision, screen), weak and slow don't; each local chat model gets one warm-up.
  const local = taskCount([...TEXT_JOBS, 'private']);
  const seeing = taskCount([...TEXT_JOBS, 'private', 'vision', 'screen']);
  const sub = taskCount(TEXT_JOBS);
  const emb = taskCount(['embeddings']);
  assert.equal(p.calls, seeing + 1 + 2 * (local + 1) + (local + 1) + sub + emb);
  assert.equal(p.paidCalls, 0);
  assert.ok(p.minutes >= 1);
  const paid = (await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'provider', providerId: 'cloud' }, includePaid: true })).json;
  assert.equal(paid.calls, sub);
  assert.equal(paid.paidCalls, sub);
  // Compare two or three for one job; why a model is left out.
  const cmp = (await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'weak:8b' }, { providerId: 'emb', model: 'toy-embed' }] }, jobs: ['vision'] })).json;
  assert.deepEqual(cmp.models.map((m: { why: string }) => m.why), ['Cannot see pictures.', 'An embedding model: only tested for meaning search.']);
  assert.equal(cmp.calls, 0);
  const adult = (await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'weak:8b' }, { providerId: 'sub', model: 'sub-model' }] }, jobs: ['adult'] })).json;
  assert.equal(adult.models[0].why, 'Adult mode is off.');
  const priv = (await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'weak:8b' }, { providerId: 'sub', model: 'sub-model' }] }, jobs: ['private'] })).json;
  assert.deepEqual(priv.models.map((m: { included: boolean }) => m.included), [true, false]);
  assert.match(priv.models[1].why, /own hardware/);
  assert.equal((await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'weak:8b' }] }, jobs: ['chat'] })).status, 400, 'one job: two or three models');
  assert.equal((await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'nope' } })).status, 400);
  assert.equal((await api(w, '/api/model-tests/plan', 'POST', { scope: { kind: 'all' }, jobs: ['dancing'] })).status, 400);
  assert.equal(w.seen.length, 0, 'planning asks no model');
});

test('a full run: models are the outer loop, scores and ties, errors are never suggested, apply, Auto', async (t) => {
  const w = await world(t);
  w.delay['slow:8b'] = 30;
  w.delay['sub-model'] = 10;
  const events: unknown[] = [];
  w.app.events!.subscribe((ev) => ev.type === 'model-tests' && events.push(ev.run));
  // Auto before any score: its own picks.
  w.app.settings.update({ routes: { quick: { providerId: 'home', model: 'gemma4:12b' } } });
  const autoBefore = autoChain(w.app, 'chat');
  assert.ok(autoBefore.every((p) => !/model tests/.test(p.why)));
  assert.equal(autoBefore[0].model, 'weak:8b', 'without scores Auto keeps its order');

  const start = await api(w, '/api/model-tests/start', 'POST', { scope: { kind: 'all' } });
  assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.json), ['runId']);
  const busy = await api(w, '/api/model-tests/start', 'POST', { scope: { kind: 'all' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error, 'A model test is already running.');
  const mid = (await api(w, '/api/model-tests/status')).json;
  assert.equal(mid.run.state, 'running');
  await w.tests.idle();

  // Status shape, field by field.
  const st = (await api(w, '/api/model-tests/status')).json;
  assert.deepEqual(Object.keys(st), ['run']);
  assert.deepEqual(Object.keys(st.run).sort(), ['done', 'endedAt', 'id', 'startedAt', 'state', 'total']);
  assert.equal(st.run.id, start.json.runId);
  assert.equal(st.run.state, 'done');
  assert.equal(st.run.done, st.run.total);
  assert.ok(events.length > 3);
  const ev = events.find((e) => (e as { current?: unknown }).current) as { current: Record<string, string> };
  assert.deepEqual(Object.keys(ev.current).sort(), ['job', 'model', 'providerId']);

  // Each model's calls are contiguous within its provider (one model loaded at a time); no paid model asked.
  for (const pid of ['home', 'lan', 'sub']) {
    const order = w.seen.filter((s) => s.providerId === pid).map((s) => s.model);
    const blocks = order.filter((m, i) => i === 0 || order[i - 1] !== m);
    assert.equal(new Set(blocks).size, blocks.length, `${pid}: ${blocks.join(' ')}`);
  }
  assert.ok(!w.seen.some((s) => s.providerId === 'cloud'));
  // The warm-up comes first for a model on the owner's hardware, never for the subscription one.
  assert.equal(w.seen.find((s) => s.model === 'gemma4:12b')!.task, 'warm-up');
  assert.ok(!w.seen.some((s) => s.model === 'sub-model' && s.task === 'warm-up'));
  // The failing model: three errors in a row, then the rest is not asked.
  assert.equal(w.seen.filter((s) => s.model === 'broken:8b' && s.task !== 'warm-up').length, 3);

  const sc = (await api(w, '/api/model-tests/scores')).json;
  assert.deepEqual(Object.keys(sc).sort(), ['best', 'jobs', 'models', 'taskSet', 'untested']);
  assert.equal(sc.taskSet, TASK_SET);
  for (const j of sc.jobs) assert.deepEqual(Object.keys(j).sort(), ['id', 'label', 'tasks']);
  for (const m of sc.models) {
    assert.deepEqual(Object.keys(m).sort(), ['billing', 'label', 'local', 'model', 'providerId', 'scores', 'stale', 'testedAt']);
    for (const s of Object.values(m.scores) as Record<string, unknown>[]) for (const k of Object.keys(s)) assert.ok(['score', 'passed', 'total', 'firstMs', 'totalMs', 'error'].includes(k), k);
  }
  const model = (name: string) => sc.models.find((m: { model: string }) => m.model === name);
  const V = tasksFor('vision').length;
  assert.deepEqual(model('gemma4:12b').scores.vision, { ...model('gemma4:12b').scores.vision, score: 100, passed: V, total: V });
  assert.equal(model('weak:8b').scores.chat.score, 0);
  assert.equal(model('weak:8b').scores.chat.passed, 0);
  assert.ok(model('broken:8b').scores.chat.error, 'errored on more than half: could not be tested');
  assert.equal(model('toy-embed').scores.embeddings.score, 100);
  assert.equal(model('sub-model').scores.private, undefined, 'not on own hardware');
  assert.equal(model('gemma4:12b').local, true);
  assert.equal(model('sub-model').local, false);
  assert.equal(model('gemma4:12b').stale, false);

  // Best: the tie (100 / 100 / 100) is broken by cost first, then speed; Quick by speed alone.
  const names = (job: string) => sc.best[job].map((b: { model: string }) => b.model);
  for (const b of sc.best.chat) assert.deepEqual(Object.keys(b).sort(), ['model', 'providerId', 'score', 'tie', 'why']);
  assert.deepEqual(names('chat'), ['gemma4:12b', 'slow:8b', 'sub-model']);
  assert.equal(sc.best.chat[0].tie, true);
  assert.equal(sc.best.chat[0].why, 'Tied with slow:8b; faster');
  assert.equal(sc.best.chat[1].why, 'Tied with gemma4:12b');
  assert.deepEqual(names('quick'), ['gemma4:12b', 'sub-model', 'slow:8b'], 'Quick replies: the fastest first, whatever it costs');
  assert.deepEqual(names('vision'), ['gemma4:12b']);
  assert.equal(sc.best.vision[0].why, `Highest score (${V} of ${V})`);
  assert.equal(sc.best.vision[0].tie, false);
  assert.deepEqual(names('private'), ['gemma4:12b', 'slow:8b']);
  assert.ok(!Object.values(sc.best).flat().some((b) => ['weak:8b', 'broken:8b', 'paid-model'].includes((b as { model: string }).model)));
  assert.deepEqual(sc.untested.map((u: { model: string }) => u.model), ['paid-model']);
  assert.deepEqual(Object.keys(sc.untested[0]).sort(), ['label', 'model', 'providerId']);

  // Auto prefers the tested best and says so.
  const auto = autoChain(w.app, 'chat');
  assert.equal(auto[0].model, 'gemma4:12b');
  assert.match(auto[0].why, /^Auto for talking: best in your model tests \(\d+ of \d+\)\.$/);

  // Apply: each job's model and its backups; jobs with no scores are left alone.
  w.app.settings.update({ routes: { chat: { providerId: 'home', model: 'weak:8b' } } });
  const ap = await api(w, '/api/model-tests/apply', 'POST', { jobs: ['chat', 'vision', 'adult'] });
  assert.equal(ap.status, 200);
  assert.deepEqual(ap.json.changed, [
    { job: 'chat', providerId: 'home', model: 'gemma4:12b', backups: [{ providerId: 'home', model: 'slow:8b' }, { providerId: 'sub', model: 'sub-model' }] },
    { job: 'vision', providerId: 'home', model: 'gemma4:12b', backups: [] },
  ]);
  assert.deepEqual(ap.json.previous, { chat: { providerId: 'home', model: 'weak:8b' }, vision: null });
  const routes = w.app.settings.get().routes!;
  assert.deepEqual(routes.chat, { providerId: 'home', model: 'gemma4:12b', fallbacks: [{ providerId: 'home', model: 'slow:8b' }, { providerId: 'sub', model: 'sub-model' }] });
  assert.deepEqual(routes.vision, { providerId: 'home', model: 'gemma4:12b' });
  assert.equal(routes.adult, undefined);

  // Deleting a provider removes its results.
  assert.equal((await api(w, '/api/providers/lan', 'DELETE')).status, 200);
  const after = (await api(w, '/api/model-tests/scores')).json;
  assert.ok(!after.models.some((m: { providerId: string }) => m.providerId === 'lan'));
  assert.equal((w.app.store.db.prepare("SELECT COUNT(*) AS n FROM model_test_results WHERE provider_id = 'lan'").get() as { n: number }).n, 0);
});

test('stop keeps what finished; the next start carries on where it stopped', async (t) => {
  const w = await world(t);
  w.delay['slow:8b'] = 120;
  const body = { scope: { kind: 'models', models: [{ providerId: 'home', model: 'slow:8b' }, { providerId: 'home', model: 'weak:8b' }] }, jobs: ['quick'] };
  const plan = (await api(w, '/api/model-tests/plan', 'POST', body)).json;
  const Q = tasksFor('quick').length;
  assert.equal(plan.calls, 2 * (Q + 1));
  await api(w, '/api/model-tests/start', 'POST', body);
  for (let i = 0; i < 200 && (w.tests.status().run?.done ?? 0) < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await api(w, '/api/model-tests/stop', 'POST')).json, { ok: true });
  await w.tests.idle();
  const stopped = w.tests.status().run!;
  assert.equal(stopped.state, 'stopped');
  assert.ok(stopped.done >= 2 && stopped.done < stopped.total, `${stopped.done} of ${stopped.total}`);
  const kept = (w.app.store.db.prepare('SELECT COUNT(*) AS n FROM model_test_results').get() as { n: number }).n;
  assert.equal(kept, stopped.done);
  // A half-done job has no score yet.
  assert.equal((await api(w, '/api/model-tests/scores')).json.models[0].scores.quick, undefined);

  // The plan and the next run only hold what is left; nothing finished is asked again.
  const left = (await api(w, '/api/model-tests/plan', 'POST', body)).json;
  assert.ok(left.calls < plan.calls);
  const askedBefore = w.seen.filter((s) => s.task !== 'warm-up').map((s) => `${s.model}/${s.task}`);
  w.seen.length = 0;
  w.delay['slow:8b'] = 0;
  await api(w, '/api/model-tests/start', 'POST', body);
  await w.tests.idle();
  const run = w.tests.status().run!;
  assert.equal(run.state, 'done');
  assert.equal(run.total, 2 * Q - kept);
  const finished = (w.app.store.db.prepare('SELECT provider_id, model, task_id FROM model_test_results').all() as { model: string; task_id: string }[]).map((r) => `${r.model}/${r.task_id}`);
  assert.equal(finished.length, 2 * Q);
  const again = w.seen.filter((s) => s.task !== 'warm-up').map((s) => `${s.model}/${s.task}`);
  assert.ok(askedBefore.slice(0, kept).every((x) => !again.includes(x)), 'finished tasks were not asked again');
  const sc = (await api(w, '/api/model-tests/scores')).json;
  assert.equal(sc.best.quick[0].model, 'slow:8b');
  assert.equal(sc.best.quick[0].why, `Highest score (${Q} of ${Q})`);
  // A finished run starts fresh next time.
  assert.equal((await api(w, '/api/model-tests/plan', 'POST', body)).json.calls, plan.calls);
});

test('stale results after a task-set bump are shown as stale and never suggested', async (t) => {
  const w = await world(t);
  const ins = w.app.store.db.prepare('INSERT INTO model_test_results (provider_id, model, task_id, task_set, pass, reason, error, first_ms, total_ms, at, run) VALUES (?, ?, ?, ?, 1, ?, NULL, 100, 200, ?, ?)');
  for (const task of TASKS.filter((x) => x.jobs.includes('quick'))) ins.run('home', 'slow:8b', task.id, TASK_SET - 1, 'ok', '2026-10-01T00:00:00.000Z', 'old');
  const sc = (await api(w, '/api/model-tests/scores')).json;
  const m = sc.models.find((x: { model: string }) => x.model === 'slow:8b');
  assert.equal(m.stale, true);
  assert.equal(m.scores.quick.score, 100);
  assert.equal(m.testedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(sc.best.quick, undefined, 'stale scores are not suggested');
  assert.ok(sc.untested.every((u: { model: string }) => u.model !== 'slow:8b'));
  // Testing it again with the new set makes it current.
  await api(w, '/api/model-tests/start', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'slow:8b' }, { providerId: 'home', model: 'weak:8b' }] }, jobs: ['quick'] });
  await w.tests.idle();
  const now = (await api(w, '/api/model-tests/scores')).json;
  assert.equal(now.models.find((x: { model: string }) => x.model === 'slow:8b').stale, false);
  assert.equal(now.best.quick[0].model, 'slow:8b');
});

test('autoNew: off by default; when on, only untested free models on the owner\'s hardware, in the background', async (t) => {
  const w = await world(t);
  assert.deepEqual((await api(w, '/api/settings')).json.modelTests, { autoNew: false });
  await w.tests.afterListRefresh('home');
  assert.equal(w.tests.status().run, null, 'off: nothing runs');
  assert.equal((await api(w, '/api/settings', 'PUT', { modelTests: { autoNew: 'yes' } })).status, 400);
  // Some home models already have results: only the new one is tested.
  w.app.settings.update({ modelTests: { autoNew: true } });
  const ins = w.app.store.db.prepare('INSERT INTO model_test_results (provider_id, model, task_id, task_set, pass, reason, at) VALUES (?, ?, ?, ?, 1, ?, ?)');
  for (const m of ['gemma4:12b', 'weak:8b', 'slow:8b']) ins.run('home', m, 'quick-word', TASK_SET, 'ok', '2026-11-01T00:00:00.000Z');
  w.lists.home = [...LISTS.home, 'fresh:4b'];
  for (const id of ['cloud', 'sub', 'home']) await w.tests.afterListRefresh(id);
  for (let i = 0; i < 100 && !w.tests.status().run; i++) await new Promise((r) => setTimeout(r, 5));
  await w.tests.idle();
  assert.equal(w.tests.status().run?.state, 'done');
  assert.deepEqual([...new Set(w.seen.map((s) => `${s.providerId}/${s.model}`))], ['home/fresh:4b']);
  // An owner start takes over from a background run.
  w.delay['other:4b'] = 200;
  w.lists.home = [...w.lists.home, 'other:4b'];
  await w.tests.afterListRefresh('home');
  for (let i = 0; i < 100 && w.tests.status().run?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.tests.status().run?.state, 'running');
  const r = await api(w, '/api/model-tests/start', 'POST', { scope: { kind: 'models', models: [{ providerId: 'home', model: 'gemma4:12b' }, { providerId: 'home', model: 'weak:8b' }] }, jobs: ['quick'] });
  assert.equal(r.status, 200);
  w.delay['other:4b'] = 0;
  await w.tests.idle();
  // The background model not finished waits and is tested after the owner's run.
  const otherCalls = () => w.seen.filter((s) => s.model === 'other:4b').length;
  for (let i = 0; i < 400 && otherCalls() < 20; i++) await new Promise((r) => setTimeout(r, 10));
  await w.tests.idle();
  assert.ok(otherCalls() >= 20, `${otherCalls()} calls`);
  assert.ok(!w.seen.some((s) => s.providerId !== 'home'), 'never a paid or subscription model');
  // Turning it on through settings is saved and read back.
  w.app.settings.update({ modelTests: { autoNew: false } });
  assert.equal((await api(w, '/api/settings', 'PUT', { modelTests: { autoNew: true } })).status, 200);
  assert.deepEqual((await api(w, '/api/settings')).json.modelTests, { autoNew: true });
  await w.tests.idle();
});

test('a thinking model that answers nothing at first is asked again with more room; nothing twice is "empty reply"', async (t) => {
  const w = await world(t);
  w.lists.home = [...LISTS.home, 'thinker:8b', 'blank:8b'];
  const body = { scope: { kind: 'models', models: [{ providerId: 'home', model: 'thinker:8b' }, { providerId: 'home', model: 'blank:8b' }] }, jobs: ['quick'] };
  await api(w, '/api/model-tests/start', 'POST', body);
  await w.tests.idle();
  const Q = tasksFor('quick');
  const sc = (await api(w, '/api/model-tests/scores')).json;
  const by = (name: string) => sc.models.find((m: { model: string }) => m.model === name).scores.quick;
  assert.deepEqual([by('thinker:8b').passed, by('thinker:8b').total], [Q.length, Q.length], 'the second, roomier try counts');
  assert.equal(by('blank:8b').passed, 0);
  assert.equal(by('blank:8b').error, undefined, 'an empty reply is a fail, not an error');
  const reasons = w.app.store.db.prepare("SELECT DISTINCT reason FROM model_test_results WHERE model = 'blank:8b'").all() as { reason: string }[];
  assert.deepEqual(reasons.map((r) => r.reason), ['empty reply']);
  // Each task asked twice, the second time with more room on top of the task's own limit.
  for (const task of Q) {
    if (task.kind !== 'chat') continue;
    for (const model of ['thinker:8b', 'blank:8b']) {
      const asks: (number | undefined)[] = w.seen.filter((s) => s.model === model && s.task === task.id).map((s) => s.maxTokens);
      assert.deepEqual(asks, THINK_ROOM.map((room) => task.maxTokens + room), `${model} ${task.id}`);
    }
  }
  assert.ok(THINK_ROOM[1] > THINK_ROOM[0]);
});

test('pickBest: within 3 points is a tie broken by what the job needs; more than 3 is not', () => {
  const c = (model: string, score: number, billing: Contender['billing'], totalMs: number, here = billing === 'local'): Contender => ({ providerId: 'p', model, billing, here, s: { score, passed: Math.round(score / 10), total: 10, totalMs } });
  // Talking: cheaper first within a tie.
  let b = pickBest('chat', [c('paid', 90, 'api', 100), c('free', 87, 'local', 900), c('plan', 70, 'subscription', 50)]);
  assert.deepEqual(b.map((x) => [x.model, x.tie]), [['free', true], ['paid', true], ['plan', false]]);
  assert.equal(b[0].why, 'Tied with paid; runs on your own hardware at no cost');
  assert.equal(b[2].why, 'Next best (7 of 10)');
  // Quick replies: speed decides a tie.
  b = pickBest('quick', [c('free', 90, 'local', 900), c('paid', 88, 'api', 100)]);
  assert.deepEqual(b.map((x) => x.model), ['paid', 'free']);
  assert.equal(b[0].why, 'Tied with free; faster');
  // Private: on this computer first.
  b = pickBest('private', [c('lan', 90, 'local', 100, false), c('here', 88, 'local', 500, true)]);
  assert.equal(b[0].why, 'Tied with lan; runs on this computer');
  // Four points apart (was a tie under the old 5-point rule): no tie now.
  b = pickBest('chat', [c('a', 90, 'api', 100), c('b', 86, 'local', 100)]);
  assert.deepEqual(b.map((x) => [x.model, x.tie]), [['a', false], ['b', false]]);
  assert.equal(b[0].why, 'Highest score (9 of 10)');
  // 11 of 12 against 10 of 12 (92 against 83): one task apart is never a tie.
  b = pickBest('coding', [c('x', 92, 'local', 100), c('y', 83, 'local', 50)]);
  assert.deepEqual(b.map((x) => x.tie), [false, false]);
  // Errors and zero scores are never suggested.
  assert.deepEqual(pickBest('chat', [{ ...c('e', 100, 'local', 1), s: { score: 100, passed: 10, total: 10, error: 'x' } }, c('z', 0, 'local', 1)]), []);
});

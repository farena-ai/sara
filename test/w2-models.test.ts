// W2.4 Free models first (docs/design/W2MODELS.md): a curated, versioned list of free/local models per
// job (src/free-models.json + src/free-models.ts), "Recommended for this computer" in Settings →
// Models & usage → On this computer with one-click downloads through the existing pull route, and a
// monthly local re-check (src/model-recheck.ts) that updates the "tested" marks.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { firstTenDeps } from '../src/first-ten.ts';
import { FREE_JOBS, FREE_MODELS, installedAs, qualityOf, recommendFor, recommendations, validateList, type FreeModel } from '../src/free-models.ts';
import { CPU_TIERS, GPU_TIERS, ModelPuller, recommendModel, type Hardware, type OllamaStatus } from '../src/local-models.ts';
import { ModelRecheck, PROBES, redPng, runModel } from '../src/model-recheck.ts';
import { createSaraServer } from '../src/server.ts';
import { buildPage, recheckSection } from '../scripts/bench-compare.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const hw = (o: Partial<Hardware>): Hardware => ({ platform: 'win32', arch: 'x64', ramGb: 16, budgetGb: 16, basis: 'cpu', cpu: { name: 'Test CPU', cores: 8 }, ...o });
const gpu = (gb: number, ram = 32) => hw({ ramGb: ram, gpu: { name: 'Test GPU', vramGb: gb }, budgetGb: gb, basis: 'gpu' });
const ollama = (names: string[], cloud: string[] = []): OllamaStatus => ({ found: true, url: 'http://127.0.0.1:11434', models: [...names.map((name) => ({ name, sizeGb: 5, cloud: false })), ...cloud.map((name) => ({ name, sizeGb: 0, cloud: true }))] });

test('W2.4: the shipped list is versioned, complete and valid', () => {
  assert.equal(typeof FREE_MODELS.version, 'number');
  assert.match(FREE_MODELS.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(validateList(FREE_MODELS), []);
  assert.deepEqual([...FREE_JOBS], ['chat', 'coding', 'vision', 'hearing', 'voice', 'embeddings', 'phone']);
  for (const job of FREE_JOBS) assert.ok(FREE_MODELS.models.some((m) => m.job === job), `a model for ${job}`);
  for (const m of FREE_MODELS.models) {
    assert.ok(m.license.length > 1, `${m.id} license`);
    assert.ok(m.sizeGb > 0, `${m.id} size`);
    assert.ok(m.why.length > 10 && m.why.length <= 180, `${m.id} why is short`);
    if (m.quality) assert.ok(existsSync(join(ROOT, m.quality.file)), `${m.id} quality points at a real results file`);
  }
});

test('W2.4: validateList catches broken entries', () => {
  const bad = { version: 1, updated: '2026-11-19', models: [{ id: 'x', job: 'chat', name: 'X', how: 'ollama', sizeGb: 0, license: '', why: '' }] } as unknown as typeof FREE_MODELS;
  const problems = validateList(bad);
  assert.ok(problems.length >= 3, problems.join('; '));
  assert.ok(validateList({ ...FREE_MODELS, version: 0 } as typeof FREE_MODELS).length > 0);
  const dup = { ...FREE_MODELS, models: [...FREE_MODELS.models, FREE_MODELS.models[0]] };
  assert.ok(validateList(dup).some((p) => /twice/.test(p)));
});

test('W2.4: the chat pick agrees with the first-run tables (GPU_TIERS / CPU_TIERS)', () => {
  for (const gb of [2, 4, 6, 8, 12, 16, 24, 32]) assert.equal(recommendFor('chat', gpu(gb)).pick?.pull, recommendModel(gpu(gb)).model, `GPU ${gb} GB`);
  for (const ram of [4, 8, 16, 64]) assert.equal(recommendFor('chat', hw({ ramGb: ram, budgetGb: ram })).pick?.pull, recommendModel({ budgetGb: ram, basis: 'cpu' }).model, `CPU ${ram} GB`);
  for (const t of [...GPU_TIERS, ...CPU_TIERS]) assert.ok(FREE_MODELS.models.some((m) => m.job === 'chat' && m.pull === t.model && m.sizeGb === t.sizeGb), `${t.model} in the list with the same size`);
});

test('W2.4: picks fit the hardware; a too-small computer gets no pick but the smallest as a hint', () => {
  const big = recommendFor('coding', gpu(32));
  const small = recommendFor('coding', gpu(8));
  assert.ok(big.pick && small.pick);
  assert.ok((big.pick.minGb ?? 0) >= (small.pick.minGb ?? 0));
  assert.ok((small.pick.minGb ?? 0) <= 8);
  const vision = recommendFor('vision', hw({ ramGb: 4, budgetGb: 4 }));
  assert.equal(vision.pick, undefined);
  assert.ok(vision.smallest, 'the smallest one is named so the page can say what it needs');
  // Not Ollama: hearing/voice/phone always fit (they run on the processor or the phone).
  for (const job of ['hearing', 'voice', 'phone'] as const) assert.ok(recommendFor(job, hw({ ramGb: 4, budgetGb: 4 })).pick, job);
});

test('W2.4: installedAs finds local builds of a listed model, never cloud ones', () => {
  const qwen = FREE_MODELS.models.find((m) => m.pull === 'qwen3.8:27b') as FreeModel;
  assert.equal(installedAs(qwen, ollama(['qwen3.8:27b-mtp-q4_K_M'])), 'qwen3.8:27b-mtp-q4_K_M');
  assert.equal(installedAs(qwen, ollama(['qwen3.8:27b'])), 'qwen3.8:27b');
  assert.equal(installedAs(qwen, ollama([], ['qwen3.8:27b-cloud'])), undefined);
  assert.equal(installedAs(qwen, ollama(['qwen3.8:270b'])), undefined);
  const embed = FREE_MODELS.models.find((m) => m.job === 'embeddings' && m.pull === 'nomic-embed-text') as FreeModel;
  assert.equal(installedAs(embed, ollama(['nomic-embed-text:latest'])), 'nomic-embed-text:latest');
});

test('W2.4: quality = re-checked here, else our own eval, else untested', () => {
  const tested = FREE_MODELS.models.find((m) => m.quality) as FreeModel;
  assert.equal(qualityOf(tested, {}).kind, 'eval');
  const untested = FREE_MODELS.models.find((m) => !m.quality && m.how === 'ollama') as FreeModel;
  assert.equal(qualityOf(untested, {}).kind, 'untested');
  const here = qualityOf(untested, { [untested.id]: { model: untested.pull!, job: untested.job, passed: 3, of: 4, at: '2026-11-19T10:00:00Z', ms: 900, failed: ['json'] } });
  assert.equal(here.kind, 'here');
  assert.deepEqual(here.kind === 'here' ? [here.passed, here.of] : [], [3, 4]);
});

test('W2.4: recommendations per job say download, installed or not here', () => {
  const rows = recommendations(gpu(32), ollama(['qwen3.8:27b-mtp-q4_K_M', 'nomic-embed-text:latest']), {});
  assert.deepEqual(rows.map((r) => r.job), [...FREE_JOBS]);
  const chat = rows.find((r) => r.job === 'chat')!;
  assert.equal(chat.pick?.pull, 'qwen3.8:27b');
  assert.equal(chat.installed, 'qwen3.8:27b-mtp-q4_K_M');
  assert.equal(chat.action, 'installed');
  assert.equal(rows.find((r) => r.job === 'embeddings')!.action, 'installed');
  assert.equal(rows.find((r) => r.job === 'vision')!.action, 'download');
  assert.equal(rows.find((r) => r.job === 'hearing')!.action, 'voice');
  assert.equal(rows.find((r) => r.job === 'phone')!.action, 'phone');
  const noOllama = recommendations(gpu(32), { found: false, url: '', models: [] }, {});
  assert.equal(noOllama.find((r) => r.job === 'chat')!.action, 'get-ollama');
});

/** A fake Ollama: `good` models answer right, others answer badly. Records every call. */
function fakeOllama(good: Set<string>) {
  const calls: { url: string; model: string; images: boolean }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages?: { content: string; images?: string[] }[]; input?: string[] };
    calls.push({ url, model: body.model, images: Boolean(body.messages?.some((m) => m.images?.length)) });
    const ok = good.has(body.model);
    if (url.endsWith('/api/embed')) {
      const vec = (s: string) => (ok ? (/cat|kitten/.test(s) ? [1, 0.1, 0] : [0, 0.2, 1]) : [1, 1, 1]);
      return Response.json({ embeddings: (body.input ?? []).map(vec) });
    }
    const q = body.messages?.at(-1)?.content ?? '';
    let answer = 'I am not sure.';
    if (ok) {
      if (/one word: banana/i.test(q)) answer = 'Banana';
      else if (/17 × 23/.test(q)) answer = '391';
      else if (/capital of France/i.test(q)) answer = '{"capital": "Paris"}';
      else if (/isPalindrome/.test(q)) answer = '```js\nfunction isPalindrome(s) { const t = s.toLowerCase(); return t === [...t].reverse().join(""); }\n```';
      else if (/color/i.test(q)) answer = body.messages?.at(-1)?.images?.length ? 'Red.' : 'No picture.';
    }
    return Response.json({ message: { role: 'assistant', content: answer } });
  }) as typeof fetch;
  return { f, calls };
}

test('W2.4: the probes pass a good model and fail a bad one, per job', async () => {
  const { f, calls } = fakeOllama(new Set(['good:9b', 'nomic-embed-text:latest']));
  for (const job of ['chat', 'coding', 'vision', 'embeddings'] as const) assert.ok(PROBES[job].length >= 1, job);
  const good = await runModel('http://127.0.0.1:11434', 'good:9b', 'chat', f);
  assert.equal(good.passed, good.of);
  const bad = await runModel('http://127.0.0.1:11434', 'bad:9b', 'chat', f);
  assert.equal(bad.passed, 0);
  assert.ok(bad.failed.length === bad.of);
  const code = await runModel('http://127.0.0.1:11434', 'good:9b', 'coding', f);
  assert.equal(code.passed, code.of, code.failed.join(','));
  const see = await runModel('http://127.0.0.1:11434', 'good:9b', 'vision', f);
  assert.equal(see.passed, see.of);
  assert.ok(calls.some((c) => c.images), 'the vision probe sends a picture');
  const emb = await runModel('http://127.0.0.1:11434', 'nomic-embed-text:latest', 'embeddings', f);
  assert.equal(emb.passed, emb.of);
  assert.equal(redPng().subarray(1, 4).toString('latin1'), 'PNG');
});

test('W2.4: generated code is run with no file, network or child-process rights', async () => {
  const evil = (async (_u: string | URL | Request, init?: RequestInit) => {
    const q = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages.at(-1)!.content;
    const content = /isPalindrome/.test(q) ? 'function isPalindrome(s){ require("node:fs").writeFileSync("pwned.txt","x"); return true; }' : 'no';
    return Response.json({ message: { content } });
  }) as typeof fetch;
  const r = await runModel('http://127.0.0.1:11434', 'evil:1b', 'coding', evil);
  assert.ok(r.failed.includes('code'), 'the write is refused, so the probe fails');
  assert.equal(existsSync(join(process.cwd(), 'pwned.txt')), false);
});

test('W2.4: the re-check refuses other computers and cloud models', async () => {
  const { f, calls } = fakeOllama(new Set());
  await assert.rejects(runModel('http://10.0.0.5:11434', 'good:9b', 'chat', f), /this computer/);
  await assert.rejects(runModel('http://127.0.0.1:11434', 'gpt-oss:120b-cloud', 'chat', f), /cloud/);
  assert.equal(calls.length, 0);
});

function recheckRig(t: TestContext, o: { installed?: string[]; idleMin?: number } = {}) {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  let now = new Date('2026-11-19T15:00:00Z');
  const { f, calls } = fakeOllama(new Set(o.installed ?? ['qwen3.5:9b', 'nomic-embed-text:latest']));
  const rc = new ModelRecheck({
    dataDir: dir,
    root: () => 'http://127.0.0.1:11434',
    fetch: f,
    now: () => now,
    ollama: async () => ollama(o.installed ?? ['qwen3.5:9b', 'nomic-embed-text:latest', 'some-other:7b'], ['gpt-oss:120b-cloud']),
    lastActivity: () => now.getTime() - (o.idleMin ?? 60) * 60_000,
  });
  return { rc, calls, dir, at: (d: string) => (now = new Date(d)) };
}

test('W2.4: Re-check now tests only listed local models that are installed, and keeps the marks', async (t) => {
  const { rc, calls, dir } = recheckRig(t);
  const run = await rc.run();
  const models = [...new Set(calls.map((c) => c.model))].sort();
  assert.deepEqual(models, ['nomic-embed-text:latest', 'qwen3.5:9b'], 'not unlisted, not cloud');
  assert.ok(run.results.length >= 2);
  const v = rc.view();
  assert.ok(v.lastRun);
  const qwen = Object.values(v.results).find((r) => r.model === 'qwen3.5:9b' && r.job === 'chat')!;
  assert.equal(qwen.passed, qwen.of);
  // Kept on disk for the next start.
  const again = new ModelRecheck({ dataDir: dir, root: () => 'http://127.0.0.1:11434', fetch: (() => { throw new Error('no'); }) as unknown as typeof fetch, now: () => new Date(), ollama: async () => ollama([]), lastActivity: () => 0 });
  assert.deepEqual(again.view().results, v.results);
});

test('W2.4: the monthly re-check is off by default, then runs once a month when nobody is talking', async (t) => {
  const { rc, calls, at } = recheckRig(t);
  assert.equal(rc.view().on, false);
  assert.equal(await rc.tick(), false, 'off: never runs');
  rc.setOn(true);
  assert.equal(await rc.tick(), true, 'on and never run: runs');
  const n = calls.length;
  at('2026-12-05T15:00:00Z');
  assert.equal(await rc.tick(), false, 'two weeks later: not yet');
  at('2026-12-21T15:00:00Z');
  assert.equal(await rc.tick(), true, 'a month later: again');
  assert.ok(calls.length > n);
  const busy = recheckRig(t, { idleMin: 5 });
  busy.rc.setOn(true);
  assert.equal(await busy.rc.tick(), false, 'someone talked 5 minutes ago: waits');
});

test('W2.4: routes: recommended list, re-check, and a download that does not switch her model', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  const saved = { ...firstTenDeps };
  firstTenDeps.hardware = async () => gpu(12);
  firstTenDeps.ollama = async () => ollama(['qwen3.5:9b']);
  const pulled: string[] = [];
  app.modelPuller = new ModelPuller((async (_u: string | URL | Request, init?: RequestInit) => {
    pulled.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
    return new Response('{"status":"success"}\n');
  }) as typeof fetch);
  const auth = new OwnerAuth(dir);
  const token = String(auth.newToken);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    Object.assign(firstTenDeps, saved);
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Origin: base.replace(/\/api$/, ''), authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await call('/local-models/recommended');
  assert.equal(r.status, 200);
  const j = (await r.json()) as { version: number; updated: string; jobs: { job: string; pick?: { pull?: string }; action: string; why?: string }[]; recheck: { on: boolean } };
  assert.equal(j.version, FREE_MODELS.version);
  assert.equal(j.jobs.find((x) => x.job === 'chat')?.pick?.pull, 'gemma4:12b');
  assert.equal(j.recheck.on, false);
  const vision = j.jobs.find((x) => x.job === 'vision')!;
  assert.equal(vision.action, 'download');
  // One-click download for a non-chat job: her talking model stays as it was.
  const before = app.settings.get().companionModel ?? null;
  const p = await call('/local-models/pull', 'POST', { model: vision.pick!.pull, use: false });
  assert.equal(p.status, 202);
  for (let i = 0; i < 50 && app.modelPuller.status()?.state === 'running'; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(app.modelPuller.status()?.state, 'done');
  assert.deepEqual(pulled, [vision.pick!.pull]);
  assert.deepEqual(app.settings.get().companionModel ?? null, before);
  // Switch the monthly re-check on.
  const on = await call('/local-models/recheck', 'PUT', { on: true });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as { on: boolean }).on, true);
  assert.equal((await call('/local-models/recheck', 'PUT', { on: 'yes' })).status, 400);
});

test('W2.4: Settings → On this computer shows the list (tips, t(), loader)', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const page = html.slice(html.indexOf('data-page="models-local"'), html.indexOf('data-page="models-default"'));
  for (const id of ['fm-list', 'fm-recheck-on', 'fm-recheck-now', 'fm-recheck-status']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(page, /<h3>Recommended for this computer <button type="button" class="tip"/);
  const js = readFileSync(join(ROOT, 'web/free-models.js'), 'utf8');
  assert.match(js, /\/local-models\/recommended/);
  assert.match(js, /\/local-models\/pull/);
  assert.match(js, /use: false/);
  assert.match(js, /t\('Why this one'\)/);
  assert.doesNotMatch(js, /setInterval/);
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  assert.match(app, /loadFreeModels/);
  assert.match(page, /id="fm-recheck-on" type="checkbox">[^<]*<span>[^<]+<\/span> <button type="button" class="tip" data-tip="/, 'the switch has a tip');
});

test('W2.4: the results page shows the monthly re-check', () => {
  const sec = recheckSection({ kind: 'model-recheck', started: '2026-11-19T10:00:00Z', version: '3.31.0', command: 'node scripts/model-recheck.ts --publish', results: [{ model: 'qwen3.5:9b', job: 'chat', passed: 3, of: 3, at: '2026-11-19T10:00:00Z', ms: 1200, failed: [] }, { model: 'gemma4:12b', job: 'vision', passed: 0, of: 1, at: '2026-11-19T10:00:00Z', ms: 900, failed: ['color'] }] });
  assert.match(sec, /id="free-models"/);
  assert.match(sec, /qwen3\.5:9b/);
  assert.match(sec, /3\/3/);
  assert.match(sec, /0\/1/);
  assert.equal(recheckSection(undefined), '');
  const page = buildPage({ sara: [], others: [], built: '2026-11-19', recheck: { kind: 'model-recheck', started: '2026-11-19T10:00:00Z', version: 'x', command: 'c', results: [] } });
  assert.match(page, /Free and local models/);
});

// E7 (docs/design/EVERYDAY.md "Usable by real people"): the model fitness check (CPU/GPU, size,
// recent reply times, tool support), its faster choices, the doctor lines, the first-run pick on a
// computer without a graphics card, and the everyday starter cards (by tools present, dismissal).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDoctor } from '../src/doctor.ts';
import { fasterChoices, median, modelFitness, paramsFromShow, rateFitness, recentTurns, toolsFromShow, SLOW_MEDIAN_MS } from '../src/model-fitness.ts';
import { RunStore } from '../src/runs.ts';
import { suggestModel } from '../web/model-suggest.js';
import { TRY_DONE_KEY, TRY_CARDS, tryCards, markTried, triedSet } from '../web/try-cards.js';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const turns = (...s: number[]) => s.map((x) => ({ totalMs: x * 1000, firstMs: x * 500 }));

test('fitness rules: a local model over 3B on the processor is slow here; on a card or small it is fine', () => {
  assert.deepEqual(rateFitness({ model: 'qwen3.5:4b', onDaemon: true, hw: 'cpu', paramsB: 4.7, turns: [] }).reasons, ['cpu-big']);
  assert.deepEqual(rateFitness({ model: 'qwen3.5:4b', onDaemon: true, hw: 'gpu', paramsB: 4.7, turns: [] }).reasons, []);
  assert.deepEqual(rateFitness({ model: 'qwen3.5:2b', onDaemon: true, hw: 'cpu', paramsB: 2.3, turns: [] }).reasons, []);
  assert.deepEqual(rateFitness({ model: 'llama3.2:3b', onDaemon: true, hw: 'cpu', paramsB: 3, turns: [] }).reasons, [], '3B itself is still fine');
  // Not known yet: no verdict from size alone.
  assert.deepEqual(rateFitness({ model: 'qwen3.5:9b', onDaemon: true, hw: 'unknown', paramsB: 9, turns: [] }).reasons, []);
  // A cloud model through the local Ollama is never "slow here" by size.
  assert.deepEqual(rateFitness({ model: 'gemma4:31b-cloud', onDaemon: false, hw: 'unknown', paramsB: 31, turns: [] }).reasons, []);
});

test('fitness rules: median of the recent turns over 30 s, at least three turns', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), undefined);
  const slow = rateFitness({ model: 'm', onDaemon: false, hw: 'unknown', turns: turns(40, 90, 20, 120, 45) });
  assert.deepEqual(slow.reasons, ['slow-replies']);
  assert.equal(slow.medianS, 45);
  assert.equal(slow.medianFirstS, 23);
  assert.deepEqual(rateFitness({ model: 'm', onDaemon: false, hw: 'unknown', turns: turns(10, 90, 20, 12, 25) }).reasons, [], 'one slow turn is not slow');
  assert.deepEqual(rateFitness({ model: 'm', onDaemon: false, hw: 'unknown', turns: turns(90, 90) }).reasons, [], 'two turns are too few');
  assert.equal(rateFitness({ model: 'm', onDaemon: false, hw: 'unknown', turns: turns(31, 31, 31) }).medianS, 31);
  assert.ok(SLOW_MEDIAN_MS === 30_000);
});

test('fitness rules: Ollama /api/show capabilities without "tools" and parameter sizes', () => {
  const show = { details: { parameter_size: '4.7B' }, capabilities: ['completion', 'vision'] };
  assert.equal(paramsFromShow(show), 4.7);
  assert.equal(paramsFromShow({ details: { parameter_size: '671M' } }), 0.671);
  assert.equal(paramsFromShow({}), undefined);
  assert.equal(toolsFromShow(show), false);
  assert.equal(toolsFromShow({ capabilities: ['completion', 'tools'] }), true);
  assert.equal(toolsFromShow({}), undefined);
  assert.deepEqual(rateFitness({ model: 'gemma3:4b', onDaemon: true, hw: 'gpu', paramsB: 4, turns: [], tools: false }).reasons, ['no-tools']);
});

test('faster choices: Ollama Cloud first, a service next, a small local model on the processor; never the current one', () => {
  const c = (providerId: string, model: string, local: boolean, daemon = false) => ({ providerId, provider: providerId, model, local, daemon });
  const cands = [c('ollama', 'qwen3.5:4b', true, true), c('ollama', 'qwen3.5:2b', true, true), c('ollama', 'nomic-embed-text', true, true), c('ollama', 'gemma4:31b-cloud', false, true), c('ollama', 'gpt-oss:120b-cloud', false, true), c('openai', 'gpt-5-mini', false), c('openai', 'gpt-5', false)];
  const got = fasterChoices(cands, { providerId: 'ollama', model: 'qwen3.5:4b' }, { needTools: false, cpu: true });
  assert.deepEqual(got.map((x) => `${x.kind}:${x.model}`), ['cloud:gemma4:31b-cloud', 'cloud:gpt-oss:120b-cloud', 'service:gpt-5']);
  const small = fasterChoices(cands.filter((x) => x.providerId === 'ollama' && !x.model.includes('cloud')), { providerId: 'ollama', model: 'qwen3.5:4b' }, { needTools: false, cpu: true });
  assert.deepEqual(small.map((x) => `${x.kind}:${x.model}`), ['small:qwen3.5:2b']);
  assert.deepEqual(fasterChoices(cands.filter((x) => x.providerId === 'ollama' && !x.model.includes('cloud')), { providerId: 'ollama', model: 'qwen3.5:4b' }, { needTools: true, cpu: true }), [], 'a small local model is no answer to missing tools');
});

test('recentTurns reads each chat turn\'s main model call from the runs table', (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const runs = new RunStore(app.store.db);
  const seed = (model: string, ms: number, extra: object[] = []) => {
    const id = runs.open({ kind: 'turn', title: 'hi' });
    runs.writeStep(id, 0, {}, new Date().toISOString(), null, { calls: [{ model: 'judge', provider: 'x', providerId: 'p', purpose: 'safety check', in: 0, out: 0, cached: 0, usd: 0, reported: false, ms: 5, ok: true }, { model, provider: 'P', providerId: 'p', in: 1, out: 1, cached: 0, usd: 0, reported: true, ms, firstMs: ms / 2, ok: true }, ...extra] as never, tools: [], files: [], contradictions: [] });
    runs.close(id, 'ok', 0, Date.now());
  };
  for (const ms of [40_000, 50_000, 60_000]) seed('qwen3.5:4b', ms);
  seed('other', 1000);
  const got = recentTurns(app.store.db, 'p', 'qwen3.5:4b');
  assert.deepEqual(got.map((x) => x.totalMs), [60_000, 50_000, 40_000]);
  assert.equal(got[0].firstMs, 30_000);
  assert.deepEqual(recentTurns(app.store.db, 'nope', 'qwen3.5:4b'), []);
});

test('modelFitness: the talking route on a CPU-only Ollama, tool support from /api/show, choices from what is connected', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'ollama', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true }], defaultProviderId: 'ollama', defaultModel: 'qwen3.5:4b' });
  const { ModelContextStore } = await import('../src/model-context.ts');
  app.modelContext = new ModelContextStore(undefined);
  app.modelContext.hardwareKnown = true; // no graphics card here
  const cands = async () => [
    { providerId: 'ollama', provider: 'Ollama', model: 'qwen3.5:4b', local: true },
    { providerId: 'ollama', provider: 'Ollama', model: 'gemma4:31b-cloud', local: false },
  ];
  const f = await modelFitness(app, { ps: async () => ({ models: [] }), show: async () => ({ details: { parameter_size: '4.7B' }, capabilities: ['completion'] }), candidates: cands });
  assert.ok(f);
  assert.equal(f.model, 'qwen3.5:4b');
  assert.equal(f.hw, 'cpu');
  assert.deepEqual(f.reasons, ['cpu-big', 'no-tools']);
  assert.deepEqual(f.choices.map((c) => c.model), ['gemma4:31b-cloud']);
  // A cloud model through the same Ollama with tools: nothing to say.
  app.settings.update({ defaultModel: 'gemma4:31b-cloud' });
  const ok = await modelFitness(app, { ps: async () => ({ models: [] }), show: async () => ({ capabilities: ['completion', 'tools'] }), candidates: cands });
  assert.deepEqual(ok?.reasons, []);
  assert.deepEqual(ok?.choices, []);
  // A graphics card here, but Ollama's own /api/ps says the model sits on the processor (size_vram 0).
  app.settings.update({ defaultModel: 'qwen3.5:4b' });
  app.modelContext.vramGb = 12;
  const ps = async () => ({ models: [{ name: 'qwen3.5:4b', size: 3.4e9, size_vram: 0 }] });
  const split = await modelFitness(app, { ps, show: async () => ({ details: { parameter_size: '4.7B' }, capabilities: ['completion', 'tools'] }), candidates: cands });
  assert.equal(split?.hw, 'cpu');
  assert.deepEqual(split?.reasons, ['cpu-big']);
});

test('doctor: a slow talking model and the live data sources get their own lines', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const checks = await runDoctor({
    dataDir: dir,
    settings: app.settings,
    vault: app.vault,
    fitness: async () => ({ reasons: ['cpu-big', 'slow-replies'], medianS: 95, turns: 5, providerId: 'o', provider: 'Ollama', model: 'qwen3.5:4b', hw: 'cpu', choices: [{ providerId: 'o', provider: 'Ollama', model: 'gemma4:31b-cloud', kind: 'cloud' }] }),
    dataSources: { kinds: () => [{ kind: 'quote', label: 'Yahoo Finance', needsKey: false, hasKey: false }, { kind: 'odds', label: 'The Odds API', needsKey: true, hasKey: false }], test: async (kind) => (kind === 'quote' ? { ok: true, message: 'AAPL 1.00', source: 'Yahoo Finance' } : { ok: false, message: 'needs a key', source: 'The Odds API' }) },
  });
  const by = (n: string) => checks.find((c) => c.name === n);
  assert.equal(by('Chat model speed')?.status, 'warn');
  assert.match(by('Chat model speed')!.detail, /about 95 s with qwen3\.5:4b.*gemma4:31b-cloud/);
  assert.equal(by('Live data: stock prices')?.status, 'ok');
  assert.match(by('Live data: stock prices')!.detail, /Yahoo Finance answered/);
  assert.equal(by('Live data: betting odds')?.status, 'warn');
  assert.match(by('Live data: betting odds')!.detail, /no key/);
  const fine = await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, fitness: async () => ({ reasons: [], turns: 0, providerId: 'o', provider: 'Ollama', model: 'gemma4:31b-cloud', hw: 'unknown', choices: [] }) });
  assert.equal(fine.find((c) => c.name === 'Chat model speed')?.status, 'ok');
});

test('first run: no graphics card prefers an Ollama Cloud model over a big local one', () => {
  const list = ['qwen3.5:9b', 'gemma4:12b', 'gemma4:31b-cloud', 'nomic-embed-text'];
  assert.equal(suggestModel(list), 'gemma4:12b');
  assert.equal(suggestModel(list, { noGpu: true }), 'gemma4:31b-cloud');
  // No cloud model: the smallest usable local one, not the biggest.
  assert.equal(suggestModel(['qwen3.5:9b', 'qwen3.5:2b', 'gemma4:12b'], { noGpu: true }), 'qwen3.5:2b');
  const wiz = readFileSync(join(ROOT, 'web', 'setup-wizard.js'), 'utf8');
  assert.match(wiz, /noGpu/);
  assert.match(wiz, /no graphics card/);
});

test('starter cards: one per everyday area, shown only when its tool is on this server, until used or dismissed', () => {
  const t = (s: string) => s;
  assert.deepEqual(TRY_CARDS.map((c) => c.id), ['form', 'watch', 'near', 'decide', 'invoice', 'spending']);
  assert.deepEqual(tryCards({ tools: [], path: 'both', done: new Set(), t }), []);
  const all = ['fill_document', 'watch_add', 'find_product', 'decide', 'invoice_make', 'spending_summary'];
  assert.deepEqual(tryCards({ tools: all, path: 'both', done: new Set(), t }).map((c) => c.id), ['form', 'watch', 'near', 'decide', 'invoice', 'spending']);
  // Money and sports may arrive from other branches: keyed by tool name, they appear when merged.
  assert.deepEqual(tryCards({ tools: ['sports_follow'], path: 'company', done: new Set(), t }).map((c) => c.id), ['watch']);
  assert.deepEqual(tryCards({ tools: ['budget_import'], path: 'company', done: new Set(), t }).map((c) => c.id), ['spending']);
  assert.deepEqual(tryCards({ tools: ['stores_near'], path: 'company', done: new Set(), t }).map((c) => c.id), ['near']);
  // Coding-only setups don't get the everyday cards (Easy mode is for company and both).
  assert.deepEqual(tryCards({ tools: all, path: 'coding', done: new Set(), t }), []);
  assert.deepEqual(tryCards({ tools: all, path: 'both', done: new Set(['form', 'near']), t }).map((c) => c.id), ['watch', 'decide', 'invoice', 'spending']);
  for (const c of tryCards({ tools: all, path: 'both', done: new Set(), t })) {
    assert.ok(c.title && c.text && c.message, c.id);
    assert.ok(c.message.length > 20);
  }
});

test('starter cards: used or dismissed stays put on this device', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(triedSet(storage).size, 0);
  markTried(storage, 'form');
  markTried(storage, 'form');
  markTried(storage, 'decide');
  assert.deepEqual([...triedSet(storage)], ['form', 'decide']);
  assert.equal(mem.get(TRY_DONE_KEY), '["form","decide"]');
  mem.set(TRY_DONE_KEY, 'not json');
  assert.equal(triedSet(storage).size, 0, 'a damaged value starts fresh');
});

test('starter cards and the fitness notice: markup, theme variables only, strings translated', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="td-try"/);
  assert.match(html, /id="model-fitness"/);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /paintTryCards/);
  assert.match(app, /paintFitness/);
  const css = readFileSync(join(ROOT, 'web', 'today.css'), 'utf8');
  const block = css.slice(css.indexOf('/* E7 try cards */'), css.indexOf('/* /E7 try cards */'));
  assert.ok(block.length > 50);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgba?\(/i, 'theme variables only');
  const es = readFileSync(join(ROOT, 'web', 'i18n', 'es.json'), 'utf8');
  for (const c of TRY_CARDS) assert.ok(es.includes(JSON.stringify(c.title)), `es: ${c.title}`);
});

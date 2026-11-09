import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { OwnerAuth } from '../src/auth.ts';
import { ModelCatalog } from '../src/model-catalog.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { suggestModel } from '../web/model-suggest.js';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// 3.0.3: a model picked in the first-run guide must stay the default model. A fresh install with
// Ollama Cloud + gemma4:31b left `defaultModel` empty when the first test of the model was slow and
// the owner went on (Connect a brain later / Set up later), and Settings → Models → Default model
// then showed the first model of the list as if it were saved.

function fixture() {
  const nodes = new Map<string, any>();
  const get = (id: string): any => {
    if (!nodes.has(id)) {
      const classes = new Set<string>();
      const listeners = new Map<string, Function[]>();
      nodes.set(id, { id, value: '', checked: false, hidden: false, disabled: false, open: false, dataset: {}, textContent: '', children: [], options: [],
        classList: { contains: (v: string) => classes.has(v), add: (v: string) => classes.add(v), remove: (v: string) => classes.delete(v), toggle: (v: string, on = !classes.has(v)) => on ? classes.add(v) : classes.delete(v) },
        addEventListener: (event: string, fn: Function) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
        emit: async (event: string, data = {}) => { for (const fn of listeners.get(event) ?? []) await fn({ preventDefault() {}, ...data }); },
        append(...n: any[]) { this.children.push(...n); }, prepend() {}, replaceWith() {}, setAttribute() {}, getAttribute() { return ''; },
        replaceChildren(...n: any[]) { this.children = n; }, querySelectorAll() { return []; }, contains(n: any) { return n === this; },
        focus() {}, scrollIntoView() {}, showModal() { this.open = true; }, close() { this.open = false; },
      });
    }
    return nodes.get(id);
  };
  const document: any = { activeElement: null, querySelector: (id: string) => get(id), querySelectorAll: () => [], addEventListener() {} };
  return { get, document };
}

function wizard() {
  const dom = fixture();
  const writes: any[] = [];
  let answer: any = new Promise(() => {}); // the first test of a cold cloud model: still checking
  const ctx: any = { state: { providers: { providers: [], presets: [], defaultProviderId: null, defaultModel: null }, usePath: 'both' }, firstRun: { pump() {} }, modelCache: new Map(),
    api: async (url: string, opts?: any) => { if (opts?.method) writes.push([url, JSON.parse(JSON.stringify(opts.body ?? {}))]); return url === '/model-jobs/test' ? await answer : url === '/model-jobs/recommend' ? { picks: {} } : {}; },
    el: () => dom.get('element'), loadProviders: async () => {}, loadConversations: async () => {}, setChatTitle() {}, renderMessages() {}, openSettings() {},
    modelViewFor: async () => ({ models: ['deepseek-v3.1:671b', 'gemma4:31b', 'gpt-oss:120b'] }), fillModelOptions() {},
  };
  const env: any = { document: dom.document, Option: function(label: string, value: string) { return { label, value }; },
    t: (s: string) => s, normPath: (s: string) => s || 'both', pathChoices: () => [], starterChips: () => [],
    countWords: () => '3 models', modelCounts: () => ({}), CLOUD_TAG: /cloud/, todayOpen: () => false, suggestModel,
    unfoldFirstRun() {}, foldFirstRun() {}, queueTourOffer() {}, setIdentity() {}, icon: () => '', URL, Intl,
  };
  const src = readFileSync(join(ROOT, 'web/setup-wizard.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  runInNewContext(src + '\nglobalThis.wizard = { initSetupWizard, openSetup, openModelSetup, suConnect, su };', env);
  env.wizard.initSetupWizard(ctx);
  return { ...dom, ...env.wizard, writes, ctx, setAnswer: (v: any) => { answer = v; } };
}

const OLLAMA_CLOUD = { id: 'ollama-cloud', label: 'Ollama Cloud (API key)', kind: 'openai-compatible', baseUrl: 'https://ollama.com/v1', needsKey: true };
const lastDefault = (writes: any[]) => writes.filter(([u, b]: any[]) => u === '/settings' && 'defaultModel' in b).at(-1)?.[1];

test('3.0.3 first-run guide: the picked model is saved at once, even when its first test is slow and the owner goes on', async () => {
  for (const leave of ['#su-later', '#su-skip']) {
    const w = wizard();
    await w.openSetup({ ollama: [] });
    w.su.step = 3;
    void w.suConnect(OLLAMA_CLOUD, 'synthetic-key');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(lastDefault(w.writes), { defaultProviderId: 'ollama-cloud', defaultModel: 'gemma4:31b' }, 'the suggested model is saved with its provider');
    w.get('#su-model').value = 'gpt-oss:120b';
    void w.get('#su-model').emit('change');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(lastDefault(w.writes), { defaultProviderId: 'ollama-cloud', defaultModel: 'gpt-oss:120b' }, 'Change saves the new pick');
    await w.get(leave).emit('click');
    if (leave === '#su-later') await w.get('#su-next').emit('click');
    assert.deepEqual(lastDefault(w.writes), { defaultProviderId: 'ollama-cloud', defaultModel: 'gpt-oss:120b' }, `${leave}: still the picked model`);
  }
});

test('3.0.3 model recovery still changes nothing until Use this model', async () => {
  const w = wizard();
  await w.openModelSetup({ ollama: [] });
  void w.suConnect(OLLAMA_CLOUD, 'synthetic-key');
  await new Promise((r) => setTimeout(r, 10));
  w.get('#su-model').value = 'gpt-oss:120b';
  void w.get('#su-model').emit('change');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lastDefault(w.writes), undefined);
});

class ListProvider implements Provider {
  readonly config: ProviderConfig;
  readonly list: string[];
  constructor(config: ProviderConfig, list: string[]) {
    this.config = config;
    this.list = list;
  }
  async listModels(): Promise<string[]> {
    return this.list;
  }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text', text: 'hi' };
  }
}

test('3.0.3 a provider that becomes the default gets a default model from its list (wizard, Settings, subscriptions)', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString(), providers: [], defaultProviderId: undefined, defaultModel: undefined });
  app.modelCatalog = new ModelCatalog(dir, { settings: app.settings, providerFor: (c) => new ListProvider(c, ['nomic-embed-text', 'deepseek-v3.1:671b', 'gemma4:31b']), now: app.now, fetch: async () => new Response('no', { status: 404 }) });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); app.store.close(); cleanup(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method: string, body?: unknown) => fetch(base + '/api' + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call('/providers/ollama-cloud', 'PUT', { ...OLLAMA_CLOUD, apiKey: 'synthetic-key' })).status, 200);
  assert.equal(app.settings.get().defaultProviderId, 'ollama-cloud');
  assert.equal(app.settings.get().defaultModel, 'gemma4:31b', 'never left without a model');
  const view = await (await call('/providers', 'GET')).json();
  assert.equal(view.defaultModel, 'gemma4:31b');
  // An explicit pick wins and is never replaced by a second provider.
  assert.equal((await call('/settings', 'PUT', { defaultProviderId: 'ollama-cloud', defaultModel: 'deepseek-v3.1:671b' })).status, 200);
  assert.equal((await call('/providers/other', 'PUT', { label: 'Other', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })).status, 200);
  assert.equal(app.settings.get().defaultModel, 'deepseek-v3.1:671b');
  assert.equal(app.settings.get().defaultProviderId, 'ollama-cloud');
});

test('3.0.3 suggestModel: a general model, never an embedding model', () => {
  assert.equal(suggestModel(['nomic-embed-text', 'deepseek-v3.1:671b', 'gemma4:31b']), 'gemma4:31b');
  assert.equal(suggestModel(['gemma4:31b-cloud', 'qwen3:8b']), 'gemma4:31b-cloud');
  assert.equal(suggestModel(['nomic-embed-text']), 'nomic-embed-text');
  assert.equal(suggestModel([]), undefined);
});

test('3.0.3 Settings → Default model never shows an unsaved model as the default', async () => {
  const dom = fixture();
  const src = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function loadModels(fresh)'), src.indexOf("$('#load-models').addEventListener"));
  dom.get('#default-provider').value = 'ollama-cloud';
  dom.get('#default-model').value = '';
  const select = dom.get('#model-select');
  select.replaceChildren = function (...n: any[]) { this.options = n; };
  select.append = function (...n: any[]) { this.options.push(...n); };
  const env: any = { $: dom.document.querySelector, t: (s: string) => s, Option: function(this: any, label: string, value: string) { this.label = label; this.value = value; },
    modelViewFor: async () => ({ models: ['deepseek-v3.1:671b', 'gemma4:31b'], entries: [] }), fillModelOptions: (sel: any) => sel.replaceChildren({ value: 'deepseek-v3.1:671b' }, { value: 'gemma4:31b' }),
    modelCountWords: () => '2 models', checkedAgo: () => '',
  };
  runInNewContext(fn + '\nglobalThis.load = loadModels;', env);
  await env.load();
  assert.equal(select.value, '', 'no model looks picked');
  assert.equal(dom.get('#default-model').value, '');
  assert.equal(dom.get('#default-model').hidden, true, 'the type-a-name box stays closed');
  assert.match(dom.get('#models-status').textContent, /No default model is saved yet/);
  dom.get('#default-model').value = 'gemma4:31b';
  await env.load();
  assert.equal(select.value, 'gemma4:31b');
  assert.doesNotMatch(dom.get('#models-status').textContent, /No default model/);
});

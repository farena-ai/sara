import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { healthReport } from '../src/health.ts';
import { runDoctor } from '../src/doctor.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import type { AddressInfo } from 'node:net';
import { noSandboxNote } from '../src/tools/sandbox.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// A deliberately small injected DOM: event handlers execute the real browser module.
function fixture() {
  const nodes = new Map<string, any>();
  const get = (id: string): any => {
    if (!nodes.has(id)) {
      const classes = new Set<string>();
      const listeners = new Map<string, Function[]>();
      nodes.set(id, { value: '', checked: false, hidden: false, disabled: false, open: false, dataset: {}, textContent: '', children: [], inert: false, tabIndex: 0,
        classList: { contains: (v: string) => classes.has(v), add: (v: string) => classes.add(v), remove: (v: string) => classes.delete(v), toggle: (v: string, on = !classes.has(v)) => on ? classes.add(v) : classes.delete(v) },
        addEventListener: (event: string, fn: Function) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
        emit: async (event: string, data = {}) => { for (const fn of listeners.get(event) ?? []) await fn({ preventDefault() {}, ...data }); },
        append(...n: any[]) { this.children.push(...n); }, prepend() {}, replaceWith() {}, setAttribute() {}, getAttribute() { return ''; },
        replaceChildren(...n: any[]) { this.children = n; }, querySelectorAll() { return []; }, contains(n: any) { return n === this; },
        focus() { document.activeElement = this; }, scrollIntoView() {}, showModal() { this.open = true; }, close() { this.open = false; },
      });
    }
    return nodes.get(id);
  };
  const document: any = { activeElement: null, querySelector: (id: string) => id.startsWith('dialog[') || id === '#side-more-menu:not([hidden])' ? null : get(id), querySelectorAll: () => [], addEventListener: (...args: any[]) => get('document').addEventListener(...args) };
  return { get, document };
}

function wizard() {
  const dom = fixture();
  const writes: any[] = [];
  let answer: any = { ok: true };
  const providers = { providers: [], presets: [], defaultProviderId: null, defaultModel: null };
  const ctx: any = { state: { providers, usePath: 'coding' }, firstRun: { pump() {} }, modelCache: new Map(),
    api: async (url: string, opts?: any) => { if (opts?.method) writes.push([url, opts.body]); return url === '/model-jobs/test' ? await answer : {}; },
    el: () => dom.get('element'), loadProviders: async () => {}, loadConversations: async () => {}, setChatTitle() {},
    modelViewFor: async () => ({ models: ['fixture-model'] }), fillModelOptions() {},
  };
  const env: any = { document: dom.document, Option: function(label: string, value: string) { return { label, value }; },
    t: (s: string) => s, normPath: (s: string) => s || 'both', pathChoices: () => [], starterChips: () => [],
    countWords: () => '1 model', modelCounts: () => ({}), CLOUD_TAG: /cloud/, todayOpen: () => false,
    unfoldFirstRun() {}, foldFirstRun() {}, queueTourOffer() {}, setIdentity() {}, URL, Intl,
    // 3.3.0 (ezfirst): key help, closing Today and her name for the first chat.
    keyHelp: () => ({ url: '', site: '', looks: '' }), closeToday() {}, currentIdentity: () => ({ name: 'Sara' }),
  };
  const src = readFileSync(join(ROOT, 'web/setup-wizard.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  runInNewContext(src + '\nglobalThis.wizard = { initSetupWizard, openModelSetup: typeof openModelSetup === "function" ? openModelSetup : undefined, suConnect, suPing, su };', env);
  env.wizard.initSetupWizard(ctx);
  return { ...dom, ...env.wizard, writes, ctx, setAnswer: (v: any) => { answer = v; } };
}

test('Q1 model recovery opens model-only; cancel preserves providers, defaults and input draft', async () => {
  const w = wizard();
  assert.equal(typeof w.openModelSetup, 'function');
  w.get('#su-host').value = 'fixture.invalid';
  const before = JSON.stringify(w.ctx.state.providers);
  await w.openModelSetup({ ollama: [] });
  assert.equal(w.su.step, 3);
  assert.equal(w.get('#su-back').hidden, true);
  assert.equal(w.get('#su-next').disabled, true);
  await w.get('#su-skip').emit('click');
  assert.equal(w.get('#setup').open, false);
  assert.equal(w.get('#su-host').value, 'fixture.invalid');
  assert.equal(JSON.stringify(w.ctx.state.providers), before);
  assert.deepEqual(w.writes, []);
});

test('Q1 successful probe unlocks model recovery; failed and stale probes cannot finish', async () => {
  const w = wizard();
  assert.equal(typeof w.openModelSetup, 'function');
  await w.openModelSetup({ ollama: [] });
  w.su.provider = 'fixture';
  w.get('#su-model').value = 'fixture-model';
  w.setAnswer({ ok: false, error: 'fixture failure' });
  await w.suPing();
  assert.equal(w.get('#su-next').disabled, true);
  await w.get('#su-next').emit('click');
  assert.deepEqual(w.writes.filter(([u]: any[]) => u === '/settings'), []);
  let resolve!: Function;
  w.setAnswer(new Promise((r) => { resolve = r; }));
  const pending = w.suPing();
  await w.get('#su-skip').emit('click');
  resolve({ ok: true });
  await pending;
  assert.equal(w.get('#setup').open, false);
  await w.openModelSetup({ ollama: [] });
  w.su.provider = 'fixture';
  w.setAnswer({ ok: true });
  await w.suPing();
  assert.equal(w.get('#su-next').disabled, false);
  await w.get('#su-next').emit('click');
  assert.equal(w.get('#setup').open, false);
  assert.equal(w.writes.filter(([u]: any[]) => u === '/setup/done').length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(w.writes.find(([u]: any[]) => u === '/settings')[1])), { defaultProviderId: 'fixture', defaultModel: 'fixture-model' });
});

test('Q1 mobile sidebar inert, opening, Escape, navigation and desktop transitions', async () => {
  const dom = fixture();
  const media: any = { matches: true, addEventListener(_name: string, fn: Function) { this.change = fn; } };
  const src = readFileSync(join(ROOT, 'web/sidebar.js'), 'utf8').replace(/^export /gm, '');
  const env: any = { document: dom.document, window: { matchMedia: () => media } };
  runInNewContext(src + '\nglobalThis.init = initSidebar;', env);
  const sidebar = env.init({ main: dom.get('#main'), sidebar: dom.get('#sidebar'), toggle: dom.get('#toggle'), close: dom.get('#close'), scrim: dom.get('#scrim'), document: dom.document, media });
  assert.equal(dom.get('#sidebar').inert, true);
  dom.get('#toggle').focus();
  sidebar.open();
  assert.equal(dom.get('#sidebar').inert, false);
  await dom.get('document').emit('keydown', { key: 'Escape' });
  assert.equal(dom.get('#sidebar').inert, true);
  assert.equal(dom.document.activeElement, dom.get('#toggle'));
  sidebar.open(); sidebar.close({ restoreFocus: false });
  assert.equal(dom.get('#sidebar').inert, true);
  media.matches = false; media.change();
  assert.equal(dom.get('#sidebar').inert, false);
  media.matches = true; media.change();
  assert.equal(dom.get('#sidebar').inert, true);
});

test('Q1 open mobile drawer keeps Tab inside visible controls and closes for navigation only', async () => {
  const dom = fixture();
  const media = { matches: true, addEventListener() {} };
  const env: any = { document: dom.document };
  runInNewContext(readFileSync(join(ROOT, 'web/sidebar.js'), 'utf8').replace(/^export /gm, '') + '\nglobalThis.init = initSidebar;', env);
  const side = dom.get('#sidebar');
  const first = dom.get('#first'); const last = dom.get('#last');
  first.getClientRects = last.getClientRects = () => [1];
  side.querySelectorAll = () => [first, last];
  const ui = env.init({ main: dom.get('#main'), sidebar: side, toggle: dom.get('#toggle'), close: first, scrim: dom.get('#scrim'), document: dom.document, media });
  ui.open(); last.focus();
  await dom.get('document').emit('keydown', { key: 'Tab' });
  assert.equal(dom.document.activeElement, first);
  await dom.get('document').emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(dom.document.activeElement, last);
  await side.emit('click', { target: { closest: () => null } });
  assert.equal(side.inert, false, 'pin/menu controls leave drawer open');
  await side.emit('click', { target: { closest: () => first } });
  assert.equal(side.inert, true, 'navigation closes drawer');
  ui.open();
  const select = dom.document.querySelector;
  dom.document.querySelector = (sel: string) => sel === '#side-more-menu:not([hidden])' ? side : select(sel);
  await dom.get('document').emit('keydown', { key: 'Escape' });
  assert.equal(side.inert, false, 'nested More menu handles Escape before the drawer');
});

test('Q1 health and doctor separate execution isolation from approval policy', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-03T12:00:00Z') });
  t.after(() => { app.store.close(); cleanup(); });
  app.tools.add({ spec: { name: 'fixture_shell', description: 'fixture', parameters: {} }, defaultPermission: 'ask', runsCommands: true, async execute() { return ''; } } as any);
  const info = { version: 'fixture', revision: null, startedAt: app.now().toISOString() };
  const checks = healthReport(app, info).checks;
  assert.equal(checks.find((c) => c.name === 'Tool sandbox')?.ok, false);
  assert.equal(checks.find((c) => c.name === 'Command approvals')?.ok, true);
  app.settings.update({ toolPermissions: { fixture_shell: 'auto' } });
  assert.equal(healthReport(app, info).checks.find((c) => c.name === 'Command approvals')?.ok, false);
  app.sandbox = { mode: 'seatbelt', network: true, detail: 'fixture isolation' };
  assert.equal(healthReport(app, info).checks.find((c) => c.name === 'Tool sandbox')?.ok, true);
  const doctor = await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, tools: app.tools, sandbox: { mode: 'none', network: true, detail: 'fixture' }, platform: 'win32' });
  assert.equal(doctor.find((c) => c.name === 'Tool sandbox')?.status, 'warn');
  assert.equal(doctor.find((c) => c.name === 'Command approvals')?.status, 'warn');
});

test('Q1 provider recovery preserves defaults, validates the option and retains owner-only authorization', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString(), providers: [], defaultProviderId: undefined, defaultModel: undefined });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); app.store.close(); cleanup(); });
  const put = (base: string, body: unknown, token = auth.newToken) => fetch(base + '/api/providers/fixture', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', label: 'Fixture', preserveDefault: true };
  assert.equal((await put(base, config)).status, 200);
  assert.equal(app.settings.get().defaultProviderId, undefined);
  assert.equal((await put(base, { ...config, preserveDefault: 'true' })).status, 400);
  assert.equal((await put(base, config, 'invalid-fixture-token')).status, 401);
  const member = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), member: { record: () => ({ id: 'fixture', status: 'active', limits: { models: [] } }) as any, apps: () => [app], deleteSelf: async () => {} } });
  await new Promise<void>((r) => member.listen(0, '127.0.0.1', r));
  t.after(() => member.close());
  assert.equal((await put(`http://127.0.0.1:${(member.address() as AddressInfo).port}`, config)).status, 403);
  assert.equal(app.settings.get().defaultProviderId, undefined);
  assert.equal((await put(base, { ...config, preserveDefault: false })).status, 200);
  assert.equal(app.settings.get().defaultProviderId, 'fixture', 'legacy callers retain first-provider selection');
});

test('Q1 recovery saves new connection without replacing an existing provider or key', async () => {
  const w = wizard();
  w.ctx.state.providers.providers.push({ id: 'fixture', label: 'Existing', baseUrl: 'http://existing.invalid/v1' });
  const before = JSON.stringify(w.ctx.state.providers);
  await w.openModelSetup({ ollama: [] });
  await w.suConnect({ id: 'fixture', label: 'New', baseUrl: 'http://new.invalid/v1' }, 'synthetic-key');
  const saved = w.writes.find(([url]: any[]) => url.startsWith('/providers/'));
  assert.equal(saved[0], '/providers/fixture-2');
  assert.equal(saved[1].preserveDefault, true);
  await w.get('#su-skip').emit('click');
  assert.equal(JSON.stringify(w.ctx.state.providers), before);
  assert.equal(w.writes.filter(([url]: any[]) => url === '/settings').length, 0);
});

test('Q1 none-mode sandbox detail never claims approval when a command tool is auto', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  t.after(() => { app.store.close(); cleanup(); });
  app.sandbox = { mode: 'none', network: true, detail: noSandboxNote('win32') };
  app.tools.add({ spec: { name: 'fixture_shell', description: 'fixture', parameters: {} }, defaultPermission: 'auto', runsCommands: true, async execute() { return ''; } } as any);
  const info = { version: 'fixture', revision: null, startedAt: app.now().toISOString() };
  const health = healthReport(app, info).checks;
  const doctor = await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, tools: app.tools, sandbox: app.sandbox, platform: 'win32' });
  for (const checks of [health, doctor]) {
    const sandbox = checks.find((c) => c.name === 'Tool sandbox')!;
    assert.doesNotMatch(sandbox.detail, /asks before every command/);
    assert.match(sandbox.detail, /No execution isolation/);
    assert.match(checks.find((c) => c.name === 'Command approvals')!.detail, /fixture_shell.*run without asking/);
  }
});

test('Q1 unrelated core autosave does not select the inferred model after cancelled recovery', async () => {
  const dom = fixture();
  const writes: any[] = [];
  // This is the exact rendered state after an explicit connection and Cancel: the legacy
  // pick-lists display their first available entry although no default has been saved.
  dom.get('#model-configured').hidden = false;
  dom.get('#default-provider').value = 'fixture';
  dom.get('#default-model').value = 'failed-model';
  dom.get('#history-budget').value = '120000';
  const src = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  const declarations = src.match(/let defaultModelRevision = 0;\s*let savedDefaultModelRevision = 0;/)?.[0] ?? '';
  const save = src.slice(src.indexOf('async function saveCoreSettings()'), src.indexOf('// Each Settings page saves only its own part'));
  const listeners = src.slice(src.indexOf("$('#load-models').addEventListener"), src.indexOf('// PL2d: the Settings list'));
  const env: any = { $: dom.document.querySelector, state: { providers: { providers: [{ id: 'fixture' }] } },
    currentLang: () => 'en', applyLanguage: async () => {}, rerenderAfterLanguage: async () => {},
    api: async (_url: string, opts: any) => writes.push(opts.body), loadModels() {},
  };
  runInNewContext(declarations + '\n' + save + '\n' + listeners + '\nglobalThis.save = saveCoreSettings;', env);
  await env.save();
  assert.equal(Object.hasOwn(writes[0], 'defaultProviderId'), false);
  assert.equal(Object.hasOwn(writes[0], 'defaultModel'), false);
  assert.equal(writes[0].historyBudgetChars, 120000);
  await dom.get('#default-model').emit('change');
  await env.save();
  assert.equal(writes[1].defaultProviderId, 'fixture', 'explicit model edits still save');
  assert.equal(writes[1].defaultModel, 'failed-model');
  await env.save();
  assert.equal(Object.hasOwn(writes[2], 'defaultModel'), false, 'successful model edits are marked saved');
});

test('Q1 backdrop recovery dismissal refreshes saved connections exactly once and reports refresh errors', async () => {
  const w = wizard();
  let refreshed = 0; let loaded = 0;
  w.ctx.loadProviders = async () => { loaded++; };
  w.ctx.refreshModelSettings = () => { refreshed++; };
  await w.openModelSetup({ ollama: [] });
  await w.suConnect({ id: 'fixture', label: 'Fixture', baseUrl: 'http://fixture.invalid/v1' });
  loaded = 0;
  w.get('#setup').close();
  await w.get('#setup').emit('close');
  assert.equal(loaded, 1);
  assert.equal(refreshed, 1);
  await w.get('#setup').emit('close');
  assert.equal(loaded, 1, 'duplicate close events do not reconcile twice');
  await w.openModelSetup({ ollama: [] });
  w.ctx.loadProviders = async () => { throw new Error('fixture refresh failure'); };
  await w.get('#su-skip').emit('click');
  assert.equal(w.get('#settings-error').textContent, 'fixture refresh failure');
});

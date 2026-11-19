// W2.2 the first ten minutes (docs/design/W2FIRST.md): the R2 guide grows a hardware-aware model
// step, Bring everything and Where do you text? steps, and ends with three quick wins tailored to
// what is connected. Skippable, resumable, six languages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { firstTenDeps, chatAppName, importedNote, modelPlan, quickWins, broughtIn } from '../src/first-ten.ts';
import { detect, guideView, STEPS, stepAction, stepsFor } from '../src/get-started.ts';
import { detectHardware, type Hardware, type OllamaStatus } from '../src/local-models.ts';
import { createSaraServer } from '../src/server.ts';
import { modelWords, pathWords, STEP_IDS, stepWords, winWords, WIN_IDS } from '../web/get-started-words.js';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const none = { devices: [], pushDevices: 0 };

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}

const hw = (o: Partial<Hardware>): Hardware => ({ platform: 'win32', arch: 'x64', ramGb: 16, budgetGb: 16, basis: 'cpu', cpu: { name: 'Test CPU', cores: 8 }, ...o });
const ollama = (found: boolean, names: string[] = []): OllamaStatus => ({ found, url: 'http://127.0.0.1:11434', models: names.map((name) => ({ name, sizeGb: 5, cloud: false })) });

test('W2.2 guide: model, Bring everything, Where do you text?, then the R2 steps; members keep theirs', (t) => {
  const { app } = rig(t);
  assert.deepEqual([...STEPS], ['model', 'bring', 'chat', 'mail', 'calendar', 'phone', 'computer']);
  assert.deepEqual(STEP_IDS, [...STEPS], 'the app names the same steps');
  assert.deepEqual(stepsFor(true), ['mail', 'calendar', 'phone', 'computer'], 'members: no model, import or chat-app step (owner only)');
  const v = guideView(app, none);
  assert.equal(v.total, 7);
  stepAction(app, 'model', 'skip');
  assert.equal(guideView(app, none).at, 'bring', 'skippable');
  stepAction(app, 'bring', 'skip');
  stepAction(app, 'chat', 'skip');
  // Resumable: the saved step comes back after a reload.
  assert.equal(guideView(app, none).at, 'mail');
  stepAction(app, 'chat', 'resume');
  assert.equal(guideView(app, none).at, 'chat');
  assert.throws(() => stepAction(app, 'bring', 'skip', true), 'a member cannot reach the import step');
});

test('W2.2 detect: brought in = an imported conversation; chat = a linked chat app', (t) => {
  const { app } = rig(t);
  assert.equal(broughtIn(app), false);
  assert.equal(chatAppName(app), null);
  assert.equal(detect(app, none).bring, false);
  assert.equal(detect(app, none).chat, false);
  const now = app.now().toISOString();
  const conv = app.store.insertImported({ title: 'Notes from ChatGPT', channel: 'import-chatgpt', channelKey: 'notes', createdAt: now, updatedAt: now, archived: true, from: 'chatgpt', messages: [] });
  assert.equal(broughtIn(app), true);
  assert.equal(detect(app, none).bring, true);
  // Telegram set up but not linked yet: not connected.
  app.settings.update({ telegram: { enabled: true } } as never);
  assert.equal(chatAppName(app), null);
  app.settings.update({ telegram: { enabled: true, ownerChatId: 4242 } } as never);
  assert.equal(chatAppName(app), 'Telegram');
  assert.equal(detect(app, none).chat, true);
  // An imported note (not archived) is what the third quick win asks about.
  assert.equal(importedNote(app), null);
  app.memory!.add({ kind: 'fact', content: 'The garden plan: tomatoes along the south fence, basil by the door, water every other morning.', conversationId: conv.id, sourceMessageId: null, happenedOn: '2026-11-01', evidence: 'From ChatGPT' });
  const note = importedNote(app);
  assert.ok(note && note.length <= 60 && /^The garden plan/.test(note), String(note));
});

test('W2.2 model plan: graphics card, processor or free cloud, by the hardware; one click for the free local option', () => {
  // A 12 GB NVIDIA card with Ollama and nothing downloaded: local GPU, download the right model.
  let p = modelPlan(hw({ gpu: { name: 'NVIDIA RTX 4070', vramGb: 12 }, budgetGb: 12, basis: 'gpu' }), ollama(true));
  assert.equal(p.path, 'gpu');
  assert.equal(p.model.model, 'gemma4:12b');
  assert.equal(p.action, 'download', 'never downloaded without a click: the plan only offers it');
  assert.deepEqual(p.paths, ['gpu', 'cpu', 'cloud']);
  // The recommended model is already there: Use it.
  p = modelPlan(hw({ gpu: { name: 'NVIDIA RTX 4070', vramGb: 12 }, budgetGb: 12, basis: 'gpu' }), ollama(true, ['gemma4:12b']));
  assert.equal(p.action, 'use');
  assert.equal(p.use, 'gemma4:12b');
  // No GPU, 16 GB RAM, 8 cores: a small model on the processor.
  p = modelPlan(hw({}), ollama(true));
  assert.equal(p.path, 'cpu');
  assert.equal(p.model.model, 'qwen3.5:4b');
  assert.equal(p.paths[0], 'cpu');
  // Weak machine (6 GB RAM, 2 cores): a free cloud model first.
  p = modelPlan(hw({ ramGb: 6, budgetGb: 6, cpu: { name: 'Old CPU', cores: 2 } }), ollama(false));
  assert.equal(p.path, 'cloud');
  assert.equal(p.action, 'cloud');
  // Ollama missing on a capable machine: get Ollama first.
  p = modelPlan(hw({}), ollama(false));
  assert.equal(p.action, 'get-ollama');
  // "Nothing leaves this computer": never cloud.
  p = modelPlan(hw({ ramGb: 6, budgetGb: 6, cpu: { name: 'Old CPU', cores: 2 } }), ollama(true), { privateLocal: true });
  assert.equal(p.path, 'cpu');
  assert.ok(!p.paths.includes('cloud'));
  // Apple silicon counts as a graphics card (unified memory).
  p = modelPlan(hw({ platform: 'darwin', arch: 'arm64', appleSilicon: true, ramGb: 32, budgetGb: 14.4, basis: 'unified' }), ollama(true));
  assert.equal(p.path, 'gpu');
});

test('W2.2 hardware: the processor name and cores are read too', async () => {
  const h = await detectHardware({ exec: async () => '', platform: 'linux', arch: 'x64', totalmem: 8 * 1024 ** 3, cpus: [{ model: 'Fake CPU 3000' }, { model: 'Fake CPU 3000' }] } as never);
  assert.deepEqual(h.cpu, { name: 'Fake CPU 3000', cores: 2 });
  assert.equal(h.basis, 'cpu');
});

test('W2.2 quick wins: three, tailored to what is connected', (t) => {
  const { app } = rig(t);
  let w = quickWins(app, detect(app, none));
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((x) => x.id), ['reminder', 'checklist', 'week']);
  assert.equal(w[0].app, undefined);
  app.settings.update({ telegram: { enabled: true, ownerChatId: 4242 } } as never);
  app.google = { status: () => ({ connected: true, gmail: true, calendar: false }) } as never;
  w = quickWins(app, detect(app, none));
  assert.deepEqual(w.map((x) => x.id), ['reminder', 'checklist', 'mail']);
  assert.equal(w[0].app, 'Telegram', 'the reminder comes on the chat app just connected');
  const now = app.now().toISOString();
  const conv = app.store.insertImported({ title: 'Notes', channel: 'import-hermes', channelKey: 'movein-notes-x', createdAt: now, updatedAt: now, archived: true, from: 'hermes', messages: [] });
  app.memory!.add({ kind: 'fact', content: 'Book club meets on the first Thursday', conversationId: conv.id, sourceMessageId: null, happenedOn: '2026-11-01', evidence: 'From Hermes' });
  w = quickWins(app, detect(app, none));
  assert.deepEqual(w.map((x) => x.id), ['reminder', 'checklist', 'note']);
  assert.equal(w[2].note, 'Book club meets on the first Thursday');
  for (const x of w) assert.ok(WIN_IDS.includes(x.id));
});

async function server(t: TestContext, member = false) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  app.companionId = 'main';
  const auth = new OwnerAuth(dir);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(member ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const saved = { ...firstTenDeps };
  t.after(async () => {
    Object.assign(firstTenDeps, saved);
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  const api = async (path: string, method = 'GET') => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}` } });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { app, api };
}

test('W2.2 routes: the model plan and the quick wins over HTTP; owner only for the plan', async (t) => {
  const { api } = await server(t);
  firstTenDeps.hardware = async () => hw({ gpu: { name: 'NVIDIA RTX 4090', vramGb: 24 }, budgetGb: 24, basis: 'gpu' });
  firstTenDeps.ollama = async () => ollama(true, ['qwen3.8:27b']);
  let r = await api('/api/get-started/model');
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.path, 'gpu');
  assert.equal(r.body.plan.action, 'use');
  assert.equal(r.body.hardware.gpu.name, 'NVIDIA RTX 4090');
  r = await api('/api/get-started/wins');
  assert.equal(r.status, 200);
  assert.equal(r.body.wins.length, 3);
  const m = await server(t, true);
  assert.equal((await m.api('/api/get-started/model')).status, 403);
  assert.equal((await m.api('/api/get-started/wins')).status, 200, 'members get quick wins too');
});

test('W2.2 words: every step, path and win in six languages; tips short', () => {
  const t = (s: string) => s;
  for (const id of STEP_IDS) assert.ok(stepWords(id, t)?.title, id);
  for (const p of ['gpu', 'cpu', 'cloud']) assert.ok(pathWords(p, t).title, p);
  for (const id of WIN_IDS) assert.ok(winWords({ id, app: 'Telegram', note: 'x' }, t).prompt, id);
  const mw = modelWords(t);
  const keys = new Set<string>();
  const grab = (s: string) => (keys.add(s), s);
  for (const id of STEP_IDS) stepWords(id, grab);
  for (const p of ['gpu', 'cpu', 'cloud']) pathWords(p, grab);
  for (const id of WIN_IDS) winWords({ id, app: 'Telegram', note: 'x' }, grab);
  modelWords(grab);
  assert.ok(mw.machine);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${l}.json`), 'utf8')) as Record<string, string>;
    for (const k of keys) {
      assert.ok(d[k], `${l}: ${k}`);
      assert.ok(d[k].length <= 260, `${l}: ${k} too long`);
    }
  }
});

test('W2.2 web: the guide draws the model step, the chat step and the quick wins (no new dialogs)', () => {
  const js = readFileSync(join(ROOT, 'web', 'get-started.js'), 'utf8');
  const ft = readFileSync(join(ROOT, 'web', 'first-ten.js'), 'utf8');
  assert.match(js, /from '\.\/first-ten\.js'/);
  assert.match(ft, /\/get-started\/model/);
  assert.match(ft, /\/local-models\/pull/, 'download reuses the existing puller');
  assert.match(ft, /\/plugins\/where\/send-test/, 'Send me a test reuses Where do you text?');
  assert.match(ft, /\/get-started\/wins/);
  assert.doesNotMatch(ft, /#[0-9a-f]{3,6}\b/i, 'theme variables only');
});

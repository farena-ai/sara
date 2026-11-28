// Phase 31: more than one companion on one server.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { CompanionManager, CompanionSettings, COMPANIONS_DIR, LinkedToolRegistry, MAIN_ID, newCompanionPersona, type Companion } from '../src/companions.ts';
import { CompanionHub, EventHub, type HubEvent } from '../src/events.ts';
import { loadPersona } from '../src/persona.ts';
import { createSaraServer, pickCompanion } from '../src/server.ts';
import { createBackup, inspectBackup } from '../src/backup.ts';
import { sharedOwnerFacts } from '../src/recall.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-25T18:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const hub = new EventHub();
const companions = new CompanionManager(dir);
const webDir = join(ROOT, 'web');
const mainApp = makeApp(dir, clock);
const mcpTool: Tool = { spec: { name: 'mcp_files_list', description: 'list', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'list', run: async () => 'ok' };
mainApp.tools.add(mcpTool);

function build(id: string, cdir: string): Companion {
  const app: TestApp = id === MAIN_ID ? mainApp : makeApp(cdir, clock);
  if (id !== MAIN_ID) {
    app.settings = new CompanionSettings(cdir, mainApp.settings);
    app.tools = new LinkedToolRegistry(mainApp.tools);
    app.persona = loadPersona(join(cdir, 'persona.json'));
    app.vault = mainApp.vault;
    // The test provider is the main companion's.
    app.providerFactory = mainApp.providerFactory;
  }
  app.rootDir = dir;
  app.companionId = id;
  app.companions = companions;
  app.events = new CompanionHub(hub, id);
  return { id, app, server: createSaraServer({ app, auth, webDir, companions }), start() {}, async stop() {} };
}
companions.build = build;
companions.add(build(MAIN_ID, dir));
const front: Server = createServer((req, res) => void pickCompanion(companions, req).server.emit('request', req, res));
let base = '';
before(async () => {
  mainApp.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), setupDone: true });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
after(() => {
  front.close();
  for (const c of companions.all()) c.app.store.close();
  cleanup();
});
const call = (path: string, opts: { method?: string; body?: unknown; companion?: string } = {}) => {
  const go = () =>
    fetch(base + path, {
      method: opts.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(opts.companion ? { 'x-sara-companion': opts.companion } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  // A kept-alive connection the server just closed (a race on a busy machine): try once more.
  return go().catch((err: Error & { cause?: { code?: string } }) => (err.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};

test('companions: add, switch, their own characters and conversations, shared server settings, remove', async () => {
  let list = (await (await call('/api/companions')).json()) as { companions: { id: string; name: string; current: boolean }[]; planner: string };
  assert.deepEqual(list.companions.map((c) => c.name), ['Sara']);
  assert.equal(list.planner, 'separate');

  // Bad input is refused plainly.
  assert.equal((await call('/api/companions', { method: 'POST', body: { name: '' } })).status, 400);
  assert.match((await (await call('/api/companions', { method: 'POST', body: { name: 'sara' } })).json()).error, /already a companion called sara/);

  const add = await call('/api/companions', { method: 'POST', body: { name: 'Mia', pronouns: 'she' } });
  assert.equal(add.status, 200);
  const { id: mia } = (await add.json()) as { id: string };
  assert.ok(existsSync(join(dir, COMPANIONS_DIR, mia, 'persona.json')));
  list = await (await call('/api/companions')).json();
  assert.deepEqual(list.companions.map((c) => [c.name, c.current]), [['Sara', true], ['Mia', false]]);

  // The app talks to whichever companion it chose (header here; the web app uses a cookie).
  assert.equal((await (await call('/api/session')).json()).identity.name, 'Sara');
  assert.equal((await (await call('/api/session', { companion: mia })).json()).identity.name, 'Mia');
  assert.equal((await (await call('/api/session', { companion: 'nobody' })).json()).identity.name, 'Sara', 'unknown = the first');
  assert.equal(((await (await call('/api/companions', { companion: mia })).json()) as typeof list).companions.find((c) => c.current)?.name, 'Mia');

  // Her conversations are her own; a conversation link opens with her whatever the app chose.
  const conv = (await (await call('/api/conversations', { method: 'POST', body: {}, companion: mia })).json()) as { id: string };
  const miaApp = companions.get(mia)!.app;
  assert.ok(miaApp.store.getConversation(conv.id));
  assert.equal(mainApp.store.getConversation(conv.id), undefined);
  assert.equal((await call(`/api/conversations/${conv.id}/messages`)).status, 200, 'routed to Mia by the conversation');
  assert.deepEqual(await (await call(`/api/companions/of/${conv.id}`)).json(), { id: mia, name: 'Mia' });

  // The server's settings are shared; her character settings are her own.
  await call('/api/settings', { method: 'PUT', body: { ownerName: 'Lexie' }, companion: mia });
  assert.equal(mainApp.settings.get().ownerName, 'Lexie');
  miaApp.settings.update({ voice: { tts: 'grok', grokVoice: 'ara' } as never });
  assert.equal((miaApp.settings.get().voice as { grokVoice?: string }).grokVoice, 'ara');
  assert.equal((mainApp.settings.get().voice as { grokVoice?: string } | undefined)?.grokVoice, undefined);
  assert.ok(miaApp.settings.get().providers.length, 'models are shared');

  // A new companion is a different AI character: her AI notice is shown again (first use).
  assert.equal(miaApp.settings.get().disclosureAcceptedAt, undefined);
  assert.ok(mainApp.settings.get().disclosureAcceptedAt);

  // Add-on (MCP) tools run once and are offered to every companion.
  assert.ok(miaApp.tools.get('mcp_files_list'));
  assert.ok(miaApp.tools.enabled(undefined).some((t) => t.spec.name === 'mcp_files_list'));

  // The safety layer applies to every companion: same rules, her name.
  miaApp.settings.update({ disclosureAcceptedAt: clock.now.toISOString() });
  mainApp.script.push(text('hi'));
  for await (const _ of runTurn(miaApp, conv.id, 'hello')) void _;
  const sys = String(mainApp.requests.at(-1)!.messages[0].content);
  assert.match(sys, /Mia/);
  assert.match(sys, /Never produce sexual content involving minors/);

  // Events: her own listeners hear only her; the app's stream hears everyone.
  const mineMain: HubEvent[] = [];
  const all: HubEvent[] = [];
  const off1 = mainApp.events!.subscribe((e) => mineMain.push(e));
  const off2 = mainApp.events!.subscribeAll((e) => all.push(e));
  miaApp.events!.publish({ type: 'memory', conversationId: conv.id });
  off1();
  off2();
  assert.equal(mineMain.length, 0);
  assert.equal(all[0].companion, mia);

  // Backups hold every companion (databases snapshotted safely, not copied mid-write).
  const bk = createBackup(dir, join(dir, 'tmp-test-backup.tar.gz'));
  const paths = inspectBackup(join(dir, 'tmp-test-backup.tar.gz')).entries.map((e) => e.path);
  assert.ok(bk.files > 0);
  assert.ok(paths.includes(`companions/${mia}/sara.db`));
  assert.ok(paths.includes(`companions/${mia}/persona.json`));
  assert.ok(!paths.some((p) => /sara\.db-(wal|shm)$/.test(p)));

  // Sharing what they know about the owner (off by default; facts only, never her conversations).
  mainApp.memory!.add({ kind: 'fact', content: 'Alex has a sister named Ana.', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  mainApp.memory!.add({ kind: 'summary', content: 'Alex and Sara talked privately about work.', conversationId: 'c1', sourceMessageId: null, happenedOn: '2026-10-20' });
  assert.deepEqual(sharedOwnerFacts(miaApp, 'my sister'), [], 'own by default');
  await call('/api/memory/settings', { method: 'PUT', body: { sharing: 'shared' } });
  assert.deepEqual(sharedOwnerFacts(miaApp, 'my sister'), ['- (2026-10-20) Alex has a sister named Ana.']);
  mainApp.settings.update({ memorySharing: 'own' });

  // Planner choice.
  const pl = await (await call('/api/companions/planner', { method: 'PUT', body: { planner: 'shared' } })).json();
  assert.equal(pl.planner, 'shared');
  assert.equal(pl.restart, true);

  // Remove: the first can't be; others are put aside (kept in a folder).
  assert.equal((await call(`/api/companions/${MAIN_ID}`, { method: 'DELETE' })).status, 400);
  const del = await call(`/api/companions/${mia}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(((await del.json()) as typeof list).companions.map((c) => c.name), ['Sara']);
  assert.equal(existsSync(join(dir, COMPANIONS_DIR, mia)), false);
  assert.ok(readdirSync(join(dir, COMPANIONS_DIR)).some((n) => n.startsWith(`.removed-${mia}-`)));
});

test('companions: a new character sheet (fresh or a copy) with the right name and pronouns', () => {
  const sara = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const fresh = newCompanionPersona(sara, 'Leo', 'he', true) as { name: string; pronouns: string; summary: string; appearance?: string; boundaries: string[] };
  assert.equal(fresh.name, 'Leo');
  assert.equal(fresh.pronouns, 'he');
  assert.equal(fresh.appearance, undefined, 'no look yet');
  assert.match(fresh.summary, /getting to know him/);
  assert.deepEqual(fresh.boundaries, sara.boundaries.map((b) => b.replace(/\bSara\b/g, 'Leo')));
  const copy = newCompanionPersona(sara, 'Ana', 'she', false) as { summary: string; appearance?: string; age: number };
  assert.equal(copy.appearance, sara.appearance);
  assert.equal(copy.age, sara.age);
  assert.doesNotMatch(JSON.stringify(copy), /\bSara\b/);
});

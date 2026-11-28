// T62: companions are separate identities (planner, companion side, models and rules, My details).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { CompanionManager, CompanionSettings, LinkedToolRegistry, MAIN_ID, type Companion } from '../src/companions.ts';
import { companionOffIn } from '../src/companion-switch.ts';
import { CompanionHub, EventHub } from '../src/events.ts';
import { loadPersona } from '../src/persona.ts';
import { createSaraServer, pickCompanion } from '../src/server.ts';
import { workProfile } from '../src/work-profile.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-28T10:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const hub = new EventHub();
const companions = new CompanionManager(dir);
const mainApp = makeApp(dir, clock);

function build(id: string, cdir: string): Companion {
  const app: TestApp = id === MAIN_ID ? mainApp : makeApp(cdir, clock);
  if (id !== MAIN_ID) {
    app.settings = new CompanionSettings(cdir, mainApp.settings);
    app.tools = new LinkedToolRegistry(mainApp.tools);
    app.persona = loadPersona(join(cdir, 'persona.json'));
    app.vault = mainApp.vault;
    app.providerFactory = mainApp.providerFactory;
  }
  app.rootDir = dir;
  app.companionId = id;
  app.companions = companions;
  app.events = new CompanionHub(hub, id);
  return { id, app, server: createSaraServer({ app, auth, webDir: join(ROOT, 'web'), companions }), start() {}, async stop() {} };
}
companions.build = build;
companions.add(build(MAIN_ID, dir));
const front: Server = createServer((req, res) => void pickCompanion(companions, req).server.emit('request', req, res));
let base = '';
let mia = '';
before(async () => {
  mainApp.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), setupDone: true });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  mia = ((await (await call('/api/companions', { method: 'POST', body: { name: 'Mia', pronouns: 'she' } })).json()) as { id: string }).id;
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
  return go().catch((err: Error & { cause?: { code?: string } }) => (err.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};
const json = async (path: string, opts: Parameters<typeof call>[1] = {}) => (await call(path, opts)).json() as Promise<Record<string, unknown>>;

test('T62.1: each companion keeps her own planner unless the owner chose shared', () => {
  // Only an explicit 'shared' shares; no value (or 'separate') gives her her own.
  assert.match(src('src/main.ts'), /const sharedPlanner = !main && space\.settings\.get\(\)\.companionPlanner === 'shared';/);
  assert.match(src('src/routes/her.ts'), /planner: app\.settings\.get\(\)\.companionPlanner \?\? 'separate'/);
  // The Planner choice sits right under the list, "her own" first, ids kept, not folded away.
  const html = src('web/index.html');
  const page = /data-page="her-companions"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1];
  assert.match(page, /<ul id="cmp-list" class="cmp-list"><\/ul>\s*<h3>Planner<\/h3>\s*<label>[^<]*<select id="cmp-planner"><option value="separate">Each companion keeps her own<\/option><option value="shared">/);
  assert.ok(page.includes('id="cmp-planner-note"'));
  assert.doesNotMatch(src('web/settings-look.js'), /'her-companions':/);
});

test('T62.2: the companion side, the work profile and the app look are each companion\'s own', async () => {
  const miaApp = companions.get(mia)!.app;
  // A new companion: the companion side on, no work profile, no look, whatever the main one has.
  mainApp.settings.update({ companion: { on: false }, workProfile: { on: true, name: 'Work Sara' }, appearance: { palette: 'nord', theme: 'dark', accent: 'blue', density: 'comfy', portrait: 'small' } });
  assert.equal(companionOffIn(miaApp), false);
  assert.equal(workProfile(miaApp).on, false);
  assert.equal(miaApp.settings.get().appearance, undefined);
  assert.equal(((await json('/api/settings', { companion: mia })).companion as { on: boolean }).on, true);
  assert.equal((await json('/api/settings', { companion: mia })).appearance, null);
  mainApp.settings.update({ companion: undefined, workProfile: undefined, appearance: undefined });

  // Switching it off for Mia leaves the main companion as she was (and the other way round).
  assert.equal((await call('/api/settings', { method: 'PUT', companion: mia, body: { companion: { on: false } } })).status, 200);
  assert.equal(companionOffIn(miaApp), true);
  assert.equal(companionOffIn(mainApp), false);
  assert.equal(((await json('/api/settings')).companion as { on: boolean }).on, true);
  assert.equal(((await json('/api/settings', { companion: mia })).companion as { on: boolean }).on, false);
  assert.equal(miaApp.persona.name, 'Mia');
  await call('/api/settings', { method: 'PUT', body: { companion: { on: false } } });
  await call('/api/settings', { method: 'PUT', companion: mia, body: { companion: { on: true } } });
  assert.equal(companionOffIn(mainApp), true);
  assert.equal(companionOffIn(miaApp), false);
  mainApp.settings.update({ companion: undefined });

  // Her work profile.
  assert.equal((await call('/api/work-profile', { method: 'PUT', companion: mia, body: { on: true, name: 'Mia at work' } })).status, 200);
  assert.equal(workProfile(miaApp).name, 'Mia at work');
  assert.equal(workProfile(mainApp).on, false);
  assert.equal(((await json('/api/work-profile')).profile as { on: boolean }).on, false);

  // The synced app look.
  await call('/api/settings', { method: 'PUT', companion: mia, body: { appearance: { palette: 'paper', theme: 'light' } } });
  assert.equal((miaApp.settings.get().appearance as { palette: string }).palette, 'paper');
  assert.equal(mainApp.settings.get().appearance, undefined);
});

test('T62.4: models, thinking, edit checks and tool rules follow the main companion until she has her own', async () => {
  const miaApp = companions.get(mia)!.app;
  const ms = miaApp.settings as CompanionSettings;
  mainApp.settings.update({ providers: [...mainApp.settings.get().providers, { id: 'q', label: 'Q', kind: 'openai-compatible', baseUrl: 'http://y' }], thinking: 'quick' });
  // She follows the main companion's.
  assert.equal(miaApp.settings.get().thinking, 'quick');
  assert.equal(miaApp.settings.get().defaultModel, 'm');
  assert.deepEqual(await json('/api/companions/current/own'), { main: true, name: 'Sara', mainName: 'Sara', own: [], owner: true });
  assert.deepEqual((await json('/api/companions/current/own', { companion: mia })).own, []);

  // A page saves every field it shows: values equal to the ones she follows stay the main companion's.
  await call('/api/settings', { method: 'PUT', companion: mia, body: { ownerName: 'Alex', thinking: 'quick', lookFirst: 'auto', modelAutoSwitch: true } });
  assert.deepEqual(ms.ownKeys(), []);
  assert.equal(mainApp.settings.get().thinking, 'quick');

  // A change made while she is open is hers alone.
  await call('/api/settings', { method: 'PUT', companion: mia, body: { thinking: 'thorough', defaultProviderId: 'q', defaultModel: 'q-model', routes: { coding: { providerId: 'q', model: 'q-code' } } } });
  const tool = miaApp.tools.list()[0].spec.name;
  // Unchanged tool rules (the page sends every tool) stay the main companion's; a changed one is hers.
  const all = Object.fromEntries(miaApp.tools.list().map((x) => [x.spec.name, miaApp.tools.permission(x.spec.name, miaApp.settings.get().toolPermissions)]));
  assert.equal((await call('/api/tools', { method: 'PUT', companion: mia, body: { permissions: all } })).status, 200);
  assert.ok(!ms.ownKeys().includes('toolPermissions'));
  assert.equal((await call('/api/tools', { method: 'PUT', companion: mia, body: { permissions: { [tool]: 'never' } } })).status, 200);
  assert.equal(miaApp.settings.get().toolPermissions?.[tool], 'never');
  assert.equal(mainApp.settings.get().toolPermissions?.[tool], undefined);
  assert.equal(miaApp.tools.permission(tool, miaApp.settings.get().toolPermissions), 'never');
  await call('/api/precise', { method: 'PUT', companion: mia, body: { checks: { on: false } } });
  assert.equal(miaApp.settings.get().thinking, 'thorough');
  assert.equal(mainApp.settings.get().thinking, 'quick');
  assert.equal(mainApp.settings.get().defaultModel, 'm');
  assert.equal(mainApp.settings.get().routes?.coding, undefined);
  assert.equal(mainApp.settings.get().precise, undefined);
  assert.equal((miaApp.settings.get().precise?.checks as { on?: boolean } | undefined)?.on, false);
  assert.deepEqual(((await json('/api/companions/current/own', { companion: mia })).own as string[]).sort(), ['defaultModel', 'defaultProviderId', 'precise', 'routes', 'thinking', 'toolPermissions'].sort());
  // The main companion's later changes reach her only where she has none of her own.
  mainApp.settings.update({ lookFirst: 'off', thinking: 'balanced' });
  assert.equal(miaApp.settings.get().lookFirst, 'off');
  assert.equal(miaApp.settings.get().thinking, 'thorough');

  // Her own retired-model uses are found too (Settings → Models keeps them current).
  const { modelUses } = await import('../src/model-catalog.ts');
  const uses = modelUses(mainApp.settings, companions.all().map((c) => ({ name: c.app.persona.name, settings: c.app.settings })));
  assert.ok(uses.some((u) => u.where === "Mia's default model" && u.model === 'q-model'));
  uses.find((u) => u.model === 'q-code')!.set('q-code-2');
  assert.equal(miaApp.settings.get().routes?.coding?.model, 'q-code-2');
  assert.equal(mainApp.settings.get().routes?.coding, undefined);

  // Going back to the main companion's choices for one page; only the owner, never for the main one.
  assert.equal((await call('/api/companions/current/own?keys=thinking,nope', { method: 'DELETE', companion: mia })).status, 400);
  assert.equal((await call('/api/companions/current/own?keys=thinking', { method: 'DELETE' })).status, 404);
  const back = await json('/api/companions/current/own?keys=thinking,lookFirst,precise', { method: 'DELETE', companion: mia });
  assert.ok(!(back.own as string[]).includes('thinking'));
  assert.equal(miaApp.settings.get().thinking, 'balanced');
  assert.equal(miaApp.settings.get().precise, undefined);

  // Removing a provider she uses as her own default lets it go (she follows the main one's again).
  assert.equal((await call('/api/providers/q', { method: 'DELETE', companion: mia })).status, 200);
  assert.ok(!ms.ownKeys().includes('defaultProviderId'));
  assert.equal(miaApp.settings.get().defaultProviderId, 'p');
  assert.equal(mainApp.settings.get().defaultProviderId, 'p');

  // The four pages carry the line; every key they clear inherits.
  const { INHERIT_KEYS } = await import('../src/companions.ts');
  const { OWN_PAGES } = await import(new URL('../web/own-choices.js', import.meta.url).href);
  const html = src('web/index.html');
  for (const [page, keys] of Object.entries(OWN_PAGES as Record<string, string[]>)) {
    for (const k of keys) assert.ok((INHERIT_KEYS as readonly string[]).includes(k), k);
    const at = html.indexOf(`data-page="${page}"`);
    assert.ok(at > 0, page);
    assert.ok(/^[^>]*>\s*<p class="own-choices small" data-own-choices hidden><\/p>/.test(html.slice(at)), page);
  }
  assert.match(src('web/app.js'), /if \(OWN_PAGES\[pick\]\) void paintOwnChoices\(pick, \{ api, t, reload: OWN_RELOAD\[pick\] \}\);/);
});

test('T62.4: a single main companion is unchanged (her settings are the server\'s)', () => {
  const { dir: d2, cleanup: c2 } = tempDir();
  try {
    const only = makeApp(d2, clock);
    only.settings.update({ thinking: 'quick' });
    assert.ok(!(only.settings instanceof CompanionSettings));
    assert.equal(only.settings.get().thinking, 'quick');
  } finally {
    c2();
  }
});

test('T62.6: each companion keeps her own My details; a second one may copy the main one\'s once', async () => {
  const miaApp = companions.get(mia)!.app;
  const { myDetailsFor } = await import('../src/my-details.ts');
  // As main.ts builds them: each companion's own store in her own database.
  mainApp.myDetails = myDetailsFor(mainApp.store.db);
  miaApp.myDetails = myDetailsFor(miaApp.store.db);
  assert.match(src('src/main.ts'), /\n  app\.myDetails = myDetailsFor\(store\.db\);\n/);
  assert.doesNotMatch(src('src/main.ts'), /space\.companions\.main\.app\.myDetails/);

  // Nothing to copy while the main companion has none.
  assert.equal((await json('/api/my-details', { companion: mia })).copyFrom, null);
  assert.equal((await call('/api/my-details/copy', { method: 'POST', companion: mia, body: {} })).status, 404);

  assert.equal((await call('/api/my-details', { method: 'PUT', body: { firstName: 'Alex', email: 'alex@example.com' } })).status, 200);
  // Hers are her own: the main companion's do not show for Mia, and she is offered a copy.
  const before = await json('/api/my-details', { companion: mia });
  assert.deepEqual(before.details, {});
  assert.equal(before.copyFrom, 'Sara');
  // Never offered on the main companion herself.
  assert.equal((await json('/api/my-details')).copyFrom, null);
  assert.equal((await call('/api/my-details/copy', { method: 'POST', body: {} })).status, 404);

  const copied = await json('/api/my-details/copy', { method: 'POST', companion: mia, body: {} });
  assert.equal((copied.details as { firstName?: string }).firstName, 'Alex');
  // Once: with details of her own there is nothing more to copy, and a change stays hers.
  assert.equal((await json('/api/my-details', { companion: mia })).copyFrom, null);
  assert.equal((await call('/api/my-details/copy', { method: 'POST', companion: mia, body: {} })).status, 404);
  await call('/api/my-details', { method: 'PUT', companion: mia, body: { firstName: 'Alexandra', email: 'alex@example.com' } });
  assert.equal(((await json('/api/my-details')).details as { firstName?: string }).firstName, 'Alex');
  assert.equal(((await json('/api/my-details', { companion: mia })).details as { firstName?: string }).firstName, 'Alexandra');

  // The page offers it with one button.
  const page = /data-page="you-details"[^>]*>([\s\S]*?)<\/section>/.exec(src('web/index.html'))![1];
  assert.ok(page.includes('<p id="md-copy-row" class="small" hidden data-owner-only><button id="md-copy" type="button" class="ghost small"></button></p>'));
  assert.ok(src('web/my-details.js').includes("t('Copy my details from {main}', { main: from })"));
});

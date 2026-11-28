// T62: each companion has her own coding projects folder. The first companion keeps the server's
// workspaces (unchanged); another companion's live in data/companions/<id>/workspaces.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createBackup, inspectBackup } from '../src/backup.ts';
import { CompanionSettings, createCompanionDir, LinkedToolRegistry, newCompanionPersona } from '../src/companions.ts';
import { loadPersona } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { workspaceDir, workspacesBase } from '../src/tools/workspace.ts';
import { Watches } from '../src/watch.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-28T10:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const mainApp = makeApp(dir, clock);
mainApp.rootDir = dir;
mainApp.companionId = 'main';
const { id: miraId, dir: miraDir } = createCompanionDir(dir, newCompanionPersona(mainApp.persona, 'Mira', 'she', true) as unknown as Record<string, unknown>, clock.now);
const mira: TestApp = makeApp(miraDir, clock);
mira.settings = new CompanionSettings(miraDir, mainApp.settings);
mira.tools = new LinkedToolRegistry(mainApp.tools);
mira.persona = loadPersona(join(miraDir, 'persona.json'));
mira.vault = mainApp.vault;
mira.rootDir = dir;
mira.companionId = miraId;

const servers: Server[] = [];
const bases: Record<string, string> = {};
before(async () => {
  mainApp.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), setupDone: true });
  for (const [k, app] of [['main', mainApp], ['mira', mira]] as const) {
    const s = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    bases[k] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
});
after(() => {
  for (const s of servers) s.close();
  mainApp.store.close();
  mira.store.close();
  cleanup();
});
const call = (who: string, path: string, method = 'GET', body?: unknown) =>
  fetch(bases[who] + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

test('t62: the first companion keeps the server folder; another uses her own', () => {
  assert.equal(workspacesBase({ dataDir: dir, rootDir: dir, companionId: 'main' }), dir);
  assert.equal(workspacesBase({ dataDir: dir }), dir);
  assert.equal(workspacesBase({ dataDir: join(dir, 'x'), rootDir: dir }), dir, 'no companion id: as before');
  assert.equal(workspacesBase({ dataDir: miraDir, rootDir: dir, companionId: miraId }), miraDir);
  assert.equal(workspacesBase(mainApp), dir);
  assert.equal(workspacesBase(mira), miraDir);
});

test('t62: a file saved in her project lands in her own folder; each sees only her own projects', async () => {
  const put = await call('mira', '/api/workspaces/main/file', 'PUT', { path: 'notes.txt', text: 'Mira only' });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(readFileSync(join(miraDir, 'workspaces', 'main', 'notes.txt'), 'utf8'), 'Mira only');
  assert.equal(existsSync(join(dir, 'workspaces', 'main', 'notes.txt')), false);

  const put2 = await call('main', '/api/workspaces/shop/file', 'PUT', { path: 'a.txt', text: 'main' });
  assert.equal(put2.status, 200);
  assert.equal(readFileSync(join(dir, 'workspaces', 'shop', 'a.txt'), 'utf8'), 'main', 'the first companion: the same path as before');

  assert.deepEqual(await (await call('main', '/api/workspaces')).json(), ['main', 'shop']);
  assert.deepEqual(await (await call('mira', '/api/workspaces')).json(), ['main']);
  const tree = (await (await call('mira', '/api/workspaces/main/tree')).json()) as { entries?: { name: string }[] };
  assert.ok(JSON.stringify(tree).includes('notes.txt'));
  assert.equal((await call('mira', '/api/workspaces/shop/tree')).status, 200);
  assert.ok(!JSON.stringify(await (await call('mira', '/api/workspaces/shop/tree')).json()).includes('a.txt'), 'the first companion’s project is not hers');
});

test('t62: file watches pick from her own projects', () => {
  mkdirSync(join(dir, 'workspaces', 'onlymain'), { recursive: true });
  workspaceDir(miraDir, 'hers');
  assert.ok(new Watches(mira as never, mira.store.db).roots().workspaces.includes('hers'));
  assert.ok(!new Watches(mira as never, mira.store.db).roots().workspaces.includes('onlymain'));
  assert.ok(new Watches(mainApp as never, mainApp.store.db).roots().workspaces.includes('onlymain'));
});

test('t62: backups keep her projects, not her code snapshots', () => {
  mkdirSync(join(miraDir, 'snapshots', 'main'), { recursive: true });
  writeFileSync(join(miraDir, 'snapshots', 'main', 'x.json'), '{}');
  const out = join(dir, 'tmp-t62.tar.gz');
  createBackup(dir, out);
  const paths = inspectBackup(out).entries.map((e) => e.path);
  assert.ok(paths.includes(`companions/${miraId}/workspaces/main/notes.txt`));
  assert.ok(!paths.some((p) => p.startsWith(`companions/${miraId}/snapshots/`)));
});

// V3.1 My apps (docs/design/MY_APPS.md): keep a small web app she built (static files plus a small
// JSON data store per app, never server code from the model), versions with Undo, a My apps view in
// the Library, share links, served by this server only and never with the Sara session.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { APP_LIMITS, MyApps, MyAppsError, appMime, cleanAppPath, myAppSpace, myAppsFor } from '../src/my-apps.ts';
import { createSaraServer } from '../src/server.ts';
import { createMyAppsTools } from '../src/tools/my-apps.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-18T20:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) {
    MyApps.closeFor(a.dataDir);
    a.store.close();
  }
  for (const d of dirs) d();
});

function space(member?: { id: string }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  if (member) {
    const rec = { id: member.id, name: 'Bo', status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 } };
    (app as unknown as { member: unknown }).member = { id: member.id, record: () => rec, child: () => undefined, limits: () => rec.limits };
  }
  return app;
}

const PAGE_V1 = '<!doctype html><html><head><title>Plants</title></head><body><h1>Water the plants</h1><script src="app.js"></script></body></html>';
const PAGE_V2 = PAGE_V1.replace('Water the plants', 'Plant waterer');
const JS = 'appData.get("plants", []).then((p) => document.title = p.length + " plants");';

async function serve(t: { after: (f: () => unknown) => void }, app: App) {
  const auth = new OwnerAuth(app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bearer = ['Bearer', token].join(' ');
  const call = async (path: string, o: { method?: string; json?: unknown; auth?: boolean; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.auth !== false) headers.authorization = bearer;
    if (o.json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { method: o.method ?? (o.json !== undefined ? 'POST' : 'GET'), headers, redirect: 'manual', ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, headers: res.headers, body: (type.includes('json') ? await res.json() : await res.text()) as any };
  };
  return { call, token, origin };
}

test('paths, kinds of files and the space in an address', () => {
  assert.equal(cleanAppPath('index.html'), 'index.html');
  assert.equal(cleanAppPath('/css/site.css'), 'css/site.css');
  assert.equal(cleanAppPath('./img\\logo.svg'), 'img/logo.svg');
  for (const bad of ['../x.html', 'a/../../b.js', 'server.php', 'run.sh', 'app.py', '', 'a//b.html', '.env', 'x.exe', '_data/x.json', '_sara/data.js', 'C:/x.html'])
    assert.throws(() => cleanAppPath(bad), MyAppsError, bad);
  assert.equal(appMime('index.html'), 'text/html; charset=utf-8');
  assert.equal(appMime('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(appMime('a.png'), 'image/png');
  assert.equal(myAppSpace('/myapp/owner/abc/'), 'owner');
  assert.equal(myAppSpace('/myapp/0a1b2c3d4e/abc/index.html'), '0a1b2c3d4e');
  assert.equal(myAppSpace('/myapp/../abc/'), undefined);
  assert.equal(myAppSpace('/api/myapp/owner/x'), undefined);
});

test('keep → edit → Undo restores the previous version; data survives Undo', () => {
  const app = space();
  const s = myAppsFor(app);
  assert.equal(myAppsFor(app), s, 'one store per space folder');
  const kept = s.keep({ name: 'Plant waterer', files: [{ path: 'index.html', content: PAGE_V1 }, { path: 'app.js', content: JS }], note: 'First go' });
  assert.equal(kept.version, 1);
  assert.equal(kept.versions, 1);
  assert.match(kept.openPath, /^\/myapp\/owner\/[A-Za-z0-9_-]{22}\/$/);
  assert.equal(kept.sharePath, null, 'not shared until asked');
  assert.throws(() => s.keep({ name: 'plant waterer', files: [{ path: 'index.html', content: PAGE_V1 }] }), /already/i, 'names are unique');
  assert.throws(() => s.keep({ name: 'No page', files: [{ path: 'app.js', content: JS }] }), /index\.html/);

  s.setData(kept.id, 'plants', ['fern', 'basil']);
  const edited = s.edit(kept.id, { files: [{ path: 'index.html', content: PAGE_V2 }, { path: 'style.css', content: 'h1{color:teal}' }], note: 'New title' });
  assert.equal(edited.version, 2);
  assert.deepEqual(Object.keys(s.files(kept.id)).sort(), ['app.js', 'index.html', 'style.css'], 'an edit keeps the files it does not change');
  assert.equal(s.files(kept.id)['index.html'], PAGE_V2);

  const undone = s.undo(kept.id);
  assert.equal(undone.version, 1);
  assert.equal(undone.canUndo, false);
  assert.equal(edited.canUndo, true);
  assert.equal(s.files(kept.id)['index.html'], PAGE_V1, 'Undo restores the previous version');
  assert.equal(s.files(kept.id)['style.css'], undefined);
  assert.deepEqual(s.getData(kept.id, 'plants'), ['fern', 'basil'], 'Undo leaves the app data alone');
  assert.throws(() => s.undo(kept.id), /nothing to undo|first version/i);

  // Editing after an Undo builds on the version shown, and Restore can go forward again.
  const v3 = s.edit('Plant waterer', { files: [{ path: 'notes.txt', content: 'hi' }], remove: ['app.js'] });
  assert.equal(v3.version, 3);
  assert.deepEqual(Object.keys(s.files(kept.id)).sort(), ['index.html', 'notes.txt']);
  assert.equal(s.restore(kept.id, 2).version, 2);
  assert.equal(s.files(kept.id)['index.html'], PAGE_V2);
  assert.deepEqual(s.versions(kept.id).map((v) => [v.n, v.current]), [[3, false], [2, true], [1, false]]);
  assert.equal(s.versions(kept.id)[2].note, 'First go');
  assert.equal(s.files(kept.id, 1)['index.html'], PAGE_V1, 'any version can be read');

  s.rename(kept.id, 'Plants');
  assert.equal(s.get('plants')?.id, kept.id, 'found by name, any case');
  s.remove(kept.id);
  assert.equal(s.list().length, 0);
  assert.equal(s.getData(kept.id, 'plants'), undefined, 'deleting an app deletes its data');
});

test('limits: files, sizes, versions and data', () => {
  const app = space();
  const s = myAppsFor(app);
  const big = 'x'.repeat(APP_LIMITS.fileBytes + 1);
  assert.throws(() => s.keep({ name: 'Big', files: [{ path: 'index.html', content: big }] }), /too big/i);
  const many = Array.from({ length: APP_LIMITS.files + 1 }, (_, i) => ({ path: `p${i}.html`, content: 'x' }));
  assert.throws(() => s.keep({ name: 'Many', files: [{ path: 'index.html', content: 'x' }, ...many] }), /files/i);
  const a = s.keep({ name: 'Counter', files: [{ path: 'index.html', content: '<p>0</p>' }] });
  for (let i = 0; i < APP_LIMITS.versions + 5; i++) s.edit(a.id, { files: [{ path: 'index.html', content: `<p>${i}</p>` }] });
  assert.equal(s.versions(a.id).length, APP_LIMITS.versions, 'old versions are dropped past the cap');
  assert.throws(() => s.setData(a.id, 'bad key!', 1), /name/i);
  assert.throws(() => s.setData(a.id, 'k', 'y'.repeat(APP_LIMITS.dataValueBytes)), /too big/i);
  assert.throws(() => s.keep({ name: 'Pic', files: [{ path: 'index.html', content: 'x' }, { path: 'a.png', content: '%%%', base64: true }] }), /base64/i);
  const pic = s.keep({ name: 'Pic', files: [{ path: 'index.html', content: 'x' }, { path: 'a.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), base64: true }] });
  assert.ok(pic.bytes > 0);
});

test('served sandboxed with its own data and no Sara session', async (t) => {
  const app = space();
  const { call } = await serve(t, app);
  const s = myAppsFor(app);
  const a = s.keep({ name: 'Plant waterer', files: [{ path: 'index.html', content: PAGE_V1 }, { path: 'app.js', content: JS }] });
  const open = a.openPath;

  const noSlash = await call(open.slice(0, -1), { auth: false });
  assert.equal(noSlash.status, 308);
  assert.equal(noSlash.headers.get('location'), open);

  // A cookie or bearer on the request changes nothing: the token in the address is the only key.
  const page = await call(open, { auth: false, headers: { cookie: 'sara_session=whatever' } });
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /^sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/, 'an opaque origin: no Sara cookies, storage or API');
  assert.match(csp, /connect-src 'self'/);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.body, /Water the plants/);
  assert.match(page.body, /<script src="\/myapp\/owner\/[^"]+\/_sara\/data\.js"><\/script>/, 'the data helper is added to every page');

  const helper = await call(`${open}_sara/data.js`, { auth: false });
  assert.equal(helper.status, 200);
  assert.match(helper.body, /window\.appData/);
  assert.match(helper.body, /readOnly: 'false' === 'true'/);
  assert.match(helper.body, /const base = "\/myapp\/owner\/[^"]+\/_data\/";/);
  assert.equal((await call(`${open}app.js`, { auth: false })).body, JS);
  assert.equal((await call(`${open}nope.js`, { auth: false })).status, 404);
  assert.equal((await call(`${open}..%2F..%2Fsettings.json`, { auth: false })).status, 404);

  // The data store, used from the page without any credentials (CORS from an opaque origin).
  const pre = await call(`${open}_data/plants`, { method: 'OPTIONS', auth: false, headers: { origin: 'null', 'access-control-request-method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /PUT/);
  assert.equal((await call(`${open}_data/plants`, { auth: false })).status, 404);
  const put = await call(`${open}_data/plants`, { method: 'PUT', auth: false, json: { value: ['fern'] }, headers: { origin: 'null' } });
  assert.equal(put.status, 200);
  assert.equal(put.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual((await call(`${open}_data/plants`, { auth: false })).body, { key: 'plants', value: ['fern'] });
  assert.deepEqual((await call(`${open}_data`, { auth: false })).body.keys, ['plants']);
  assert.deepEqual(s.getData(a.id, 'plants'), ['fern']);

  // The app's token is not a Sara credential.
  const tokenOnly = open.split('/')[3];
  assert.equal((await call('/api/library/apps', { auth: false, headers: { authorization: ['Bearer', tokenOnly].join(' ') } })).status, 401);
  assert.equal((await call('/api/library/apps', { auth: false })).status, 401);

  // Share links: read-only, revocable, expiring.
  const shared = s.share(a.id, '1d');
  assert.ok(shared.sharePath && shared.sharePath !== open);
  const sp = shared.sharePath!;
  assert.equal((await call(sp, { auth: false })).status, 200);
  assert.match((await call(`${sp}_sara/data.js`, { auth: false })).body, /readOnly: 'true' === 'true'/);
  assert.deepEqual((await call(`${sp}_data/plants`, { auth: false })).body.value, ['fern']);
  assert.equal((await call(`${sp}_data/plants`, { method: 'PUT', auth: false, json: { value: [] } })).status, 403, 'visitors read, never write');
  clock.now = new Date('2026-11-20T20:00:00Z');
  assert.equal((await call(sp, { auth: false })).status, 404, 'an expired link stops working');
  clock.now = new Date('2026-11-18T20:00:00Z');
  s.unshare(a.id);
  assert.equal((await call(sp, { auth: false })).status, 404, 'a revoked link stops at once');
  assert.equal((await call(open, { auth: false })).status, 200);

  // Undo is what the page shows next.
  s.edit(a.id, { files: [{ path: 'index.html', content: PAGE_V2 }] });
  assert.match((await call(open, { auth: false })).body, /Plant waterer/);
  s.undo(a.id);
  assert.match((await call(open, { auth: false })).body, /Water the plants/);
});

test('routes under /api/library/apps (owner and a member space)', async (t) => {
  const app = space();
  const { call } = await serve(t, app);
  const s = myAppsFor(app);
  const a = s.keep({ name: 'Plant waterer', files: [{ path: 'index.html', content: PAGE_V1 }] });
  s.edit(a.id, { files: [{ path: 'index.html', content: PAGE_V2 }], note: 'New title' });
  const list = await call('/api/library/apps');
  assert.equal(list.status, 200);
  assert.equal(list.body.apps.length, 1);
  assert.equal(list.body.apps[0].version, 2);
  const one = await call(`/api/library/apps/${a.id}`);
  assert.deepEqual(one.body.versions.map((v: { n: number }) => v.n), [2, 1]);
  assert.deepEqual(one.body.files, ['index.html']);
  assert.equal((await call(`/api/library/apps/${a.id}/undo`, { json: {} })).body.app.version, 1);
  assert.equal((await call(`/api/library/apps/${a.id}/restore`, { json: { n: 2 } })).body.app.version, 2);
  const sh = await call(`/api/library/apps/${a.id}/share`, { json: { expiry: '7d' } });
  assert.match(sh.body.app.sharePath, /^\/myapp\/owner\//);
  assert.equal((await call(`/api/library/apps/${a.id}/share`, { json: { expiry: 'forever-ish' } })).status, 400);
  assert.equal((await call(`/api/library/apps/${a.id}/share`, { method: 'DELETE' })).body.app.sharePath, null);
  assert.equal((await call(`/api/library/apps/${a.id}`, { method: 'PATCH', json: { name: 'Plants' } })).body.app.name, 'Plants');
  assert.equal((await call(`/api/library/apps/${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/library/apps/${a.id}`)).status, 404);

  // A member keeps their own apps in their own space, and the address names that space.
  const bo = space({ id: '0a1b2c3d4e' });
  const mine = myAppsFor(bo).keep({ name: 'Chores', files: [{ path: 'index.html', content: '<p>chores</p>' }] });
  assert.match(mine.openPath, /^\/myapp\/0a1b2c3d4e\//);
  assert.equal(myAppsFor(app).list().length, 0, 'the owner does not see it');
});

test('her tools: keep, read, edit, undo, list', async () => {
  const app = space();
  const tools = new Map(createMyAppsTools(() => app as never).map((x) => [x.spec.name, x]));
  assert.deepEqual([...tools.keys()].sort(), ['app_edit', 'app_keep', 'app_list', 'app_read', 'app_undo']);
  const ctx = { signal: new AbortController().signal, conversationId: 'c1' } as never;
  const kept = String(await tools.get('app_keep')!.run({ name: 'Plant waterer', files: [{ path: 'index.html', content: PAGE_V1 }, { path: 'app.js', content: JS }], note: 'First go' }, ctx));
  assert.match(kept, /Kept "Plant waterer" \(version 1\)/);
  assert.match(kept, /My apps/);
  assert.match(String(await tools.get('app_read')!.run({ app: 'Plant waterer' }, ctx)), /index\.html[\s\S]*app\.js/);
  assert.match(String(await tools.get('app_read')!.run({ app: 'Plant waterer', path: 'index.html' }, ctx)), /Water the plants/);
  assert.match(String(await tools.get('app_edit')!.run({ app: 'Plant waterer', files: [{ path: 'index.html', content: PAGE_V2 }], note: 'New title' }, ctx)), /version 2/);
  assert.match(String(await tools.get('app_undo')!.run({ app: 'Plant waterer' }, ctx)), /back to version 1/i);
  assert.equal(myAppsFor(app).files(myAppsFor(app).get('Plant waterer')!.id)['index.html'], PAGE_V1);
  assert.match(String(await tools.get('app_list')!.run({}, ctx)), /Plant waterer: version 1 of 2/);
  await assert.rejects(Promise.resolve().then(() => tools.get('app_keep')!.run({ name: 'Bad', files: [{ path: 'server.php', content: '<?php' }] }, ctx)), /kind of file/i);
  assert.equal(tools.get('app_list')!.interruptible, true);
});

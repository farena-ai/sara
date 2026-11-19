// D3 Live canvas in chat (docs/design/LIVE_CANVAS.md): she posts a small checklist, table or chart in
// the chat; it stays current with its source (her own data, Planner to-dos, a kept app's data) and
// runs in a sandboxed frame served by the My apps door, never with the Sara session.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cardFor } from '../src/cards.ts';
import { CANVAS_LIMITS, CanvasError, CanvasStore, canvasFor, isCanvasToken } from '../src/canvas.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { MyApps, myAppSpace, myAppsFor } from '../src/my-apps.ts';
import { createSaraServer } from '../src/server.ts';
import { createCanvasTools } from '../src/tools/canvas.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-18T20:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) {
    CanvasStore.closeFor(a.dataDir);
    MyApps.closeFor(a.dataDir);
    a.store.close();
  }
  for (const d of dirs) d();
});

function space(): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  return app;
}

async function serve(t: { after: (f: () => unknown) => void }, app: App) {
  const auth = new OwnerAuth(app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bearer = ['Bearer', token].join(' ');
  const call = async (path: string, o: { method?: string; json?: unknown; auth?: boolean } = {}) => {
    const headers: Record<string, string> = {};
    if (o.auth !== false) headers.authorization = bearer;
    if (o.json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { method: o.method ?? (o.json !== undefined ? 'POST' : 'GET'), headers, redirect: 'manual', ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, headers: res.headers, body: (type.includes('json') ? await res.json() : await res.text()) as any };
  };
  return { call, origin };
}

const tool = (app: App, name: string) => createCanvasTools(() => app).find((x) => x.spec.name === name)!;
const run = (app: App, name: string, args: Record<string, unknown>) => tool(app, name).run(args, { conversationId: 'c1' } as never) as Promise<string>;

test('D3.1 a checklist with its own data: post, tick, update; the state hash moves only on change', () => {
  const app = space();
  const cv = canvasFor(app);
  const c = cv.post({ kind: 'checklist', title: 'Trip packing', items: ['Passport', 'Charger', { text: 'Sunscreen', done: true }], conversationId: 'c1' });
  const s1 = cv.state(app, c.id);
  assert.equal(s1.kind, 'checklist');
  assert.deepEqual(s1.items.map((i: { text: string; done: boolean }) => [i.text, i.done]), [['Passport', false], ['Charger', false], ['Sunscreen', true]]);
  assert.equal(cv.state(app, c.id).rev, s1.rev, 'same data, same rev');
  cv.tick(app, c.id, s1.items[0].id, true);
  const s2 = cv.state(app, c.id);
  assert.notEqual(s2.rev, s1.rev);
  assert.equal(s2.items[0].done, true);
  cv.update(c.id, { add: ['Adapter'], check: ['Charger'], title: 'Packing for Lisbon' });
  const s3 = cv.state(app, c.id);
  assert.equal(s3.title, 'Packing for Lisbon');
  assert.deepEqual(s3.items.map((i: { text: string; done: boolean }) => i.done), [true, true, true, false]);
  assert.throws(() => cv.post({ kind: 'checklist', title: 'x', items: Array.from({ length: CANVAS_LIMITS.items + 1 }, (_, i) => `i${i}`) }), CanvasError);
  assert.throws(() => cv.post({ kind: 'nope' as never, title: 'x' }), CanvasError);
});

test('D3.2 a checklist over Planner to-dos follows the tasks, and ticking it completes only listed tasks', () => {
  const app = space();
  const a = app.planner!.addTask({ title: 'Book the vet', project: 'Home' });
  const b = app.planner!.addTask({ title: 'Fix the gate', project: 'Home' });
  const other = app.planner!.addTask({ title: 'Quarterly taxes', project: 'Money' });
  const cv = canvasFor(app);
  const c = cv.post({ kind: 'checklist', title: 'Home this week', source: { type: 'tasks', project: 'Home' } });
  const s1 = cv.state(app, c.id);
  assert.deepEqual(s1.items.map((i: { text: string }) => i.text).sort(), ['Book the vet', 'Fix the gate']);
  // Done in the Planner: the canvas shows it on the next look.
  app.planner!.updateTask(a.id, { status: 'done' });
  const s2 = cv.state(app, c.id);
  assert.notEqual(s2.rev, s1.rev);
  assert.equal(s2.items.find((i: { text: string }) => i.text === 'Book the vet').done, true);
  // Ticked in the canvas: the Planner task is done.
  cv.tick(app, c.id, `t${b.id}`, true);
  assert.equal(app.planner!.task(b.id)!.status, 'done');
  assert.throws(() => cv.tick(app, c.id, `t${other.id}`, true), CanvasError, 'a task the canvas does not list');
  assert.equal(app.planner!.task(other.id)!.status, 'open');
});

test('D3.3 a table and a chart from a kept app\'s data follow what the app saves', () => {
  const app = space();
  const apps = myAppsFor(app);
  const kept = apps.keep({ name: 'Runs', files: [{ path: 'index.html', content: '<h1>Runs</h1>' }] });
  apps.setData(kept.id, 'runs', [{ day: 'Mon', km: 5 }, { day: 'Tue', km: 7.5 }]);
  const cv = canvasFor(app);
  const table = cv.post({ kind: 'table', title: 'My runs', source: { type: 'app', app: 'Runs', key: 'runs' } });
  const chart = cv.post({ kind: 'chart', title: 'Km per day', source: { type: 'app', app: 'Runs', key: 'runs' }, chart: { label: 'day', value: 'km' } });
  const t1 = cv.state(app, table.id);
  assert.deepEqual(t1.columns, ['day', 'km']);
  assert.deepEqual(t1.rows, [['Mon', '5'], ['Tue', '7.5']]);
  assert.deepEqual(cv.state(app, chart.id).bars, [{ label: 'Mon', value: 5 }, { label: 'Tue', value: 7.5 }]);
  apps.setData(kept.id, 'runs', [{ day: 'Mon', km: 5 }, { day: 'Tue', km: 7.5 }, { day: 'Wed', km: 3 }]);
  assert.notEqual(cv.state(app, table.id).rev, t1.rev);
  assert.equal(cv.state(app, chart.id).bars.length, 3);
  // A missing app is a plain message in the view, not a crash.
  const gone = cv.post({ kind: 'table', title: 'Gone', source: { type: 'app', app: 'Nope', key: 'x' } });
  assert.match(String(cv.state(app, gone.id).problem), /no app/i);
});

test('D3.4 served sandboxed by the My apps door: CSP sandbox without same-origin, no cookies, 204 when unchanged, 404 once removed', async (t) => {
  const app = space();
  const { call } = await serve(t, app);
  const cv = canvasFor(app);
  const c = cv.post({ kind: 'checklist', title: 'Groceries', items: ['Milk', 'Eggs'] });
  const view = cv.get(c.id)!;
  assert.match(view.openPath, /^\/myapp\/owner\/cv[A-Za-z0-9_-]{22}\/$/);
  assert.ok(isCanvasToken(view.openPath.split('/')[3]));
  assert.equal(myAppSpace(view.openPath), 'owner');
  const page = await call(view.openPath, { auth: false });
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /^sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.body, /_sara\/canvas\.js/);
  const js = await call(`${view.openPath}_sara/canvas.js`, { auth: false });
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
  const s = await call(`${view.openPath}_state`, { auth: false });
  assert.equal(s.status, 200);
  assert.equal(s.body.items.length, 2);
  const same = await call(`${view.openPath}_state?rev=${s.body.rev}`, { auth: false });
  assert.equal(same.status, 204);
  const tick = await call(`${view.openPath}_tick`, { auth: false, json: { item: s.body.items[1].id, done: true } });
  assert.equal(tick.status, 200);
  const after = await call(`${view.openPath}_state?rev=${s.body.rev}`, { auth: false });
  assert.equal(after.status, 200);
  assert.equal(after.body.items[1].done, true);
  // A wrong token looks like nothing at all.
  const wrong = view.openPath.replace(/cv[A-Za-z0-9_-]{4}/, 'cvAAAA');
  assert.equal((await call(`${wrong}_state`, { auth: false })).status, 404);
  // The Sara API is not reachable without the session the frame never has.
  assert.equal((await call('/api/conversations', { auth: false })).status, 401);
  cv.remove(c.id);
  assert.equal((await call(view.openPath, { auth: false })).status, 404);
});

test('D3.5 model-written HTML follows the My apps rules: capped, same CSP, only the small helper', async (t) => {
  const app = space();
  const { call } = await serve(t, app);
  const cv = canvasFor(app);
  assert.throws(() => cv.post({ kind: 'html', title: 'Big', html: 'x'.repeat(CANVAS_LIMITS.htmlBytes + 1) }), CanvasError);
  assert.throws(() => cv.post({ kind: 'html', title: 'Empty', html: '' }), CanvasError);
  const c = cv.post({ kind: 'html', title: 'Mood', html: '<!doctype html><html><head></head><body><p id="m">?</p><script>saraCanvas.onData((d) => { document.getElementById("m").textContent = d.mood; });</script></body></html>', data: { mood: 'calm' } });
  const p = cv.get(c.id)!.openPath;
  const page = await call(p, { auth: false });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /allow-same-origin/);
  assert.match(page.body, /<head><script src="[^"]*_sara\/canvas\.js"><\/script>/);
  const saved = await call(`${p}_save`, { auth: false, json: { data: { mood: 'happy' } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(cv.state(app, c.id).data, { mood: 'happy' });
  // A tasks or app source is read-only from the frame.
  const ro = cv.post({ kind: 'html', title: 'RO', html: '<p>x</p>', source: { type: 'tasks' } });
  assert.equal((await call(`${cv.get(ro.id)!.openPath}_save`, { auth: false, json: { data: 1 } })).status, 403);
});

test('D3.6 the tools post a canvas card (id only) and update it; the API lists and removes; lean offers them by words', async (t) => {
  const app = space();
  const { call } = await serve(t, app);
  const out = await run(app, 'canvas_post', { kind: 'checklist', title: 'Moving day', items: ['Boxes', 'Tape'] });
  assert.match(out, /live view #\d+/);
  const card = cardFor({ name: 'canvas_post', args: { kind: 'checklist', title: 'Moving day' }, status: 'ok', output: out });
  assert.equal(card?.kind, 'canvas');
  const id = (card as { id: number }).id;
  assert.ok(id > 0);
  assert.doesNotMatch(JSON.stringify(card), /myapp|cv[A-Za-z0-9_-]{22}/, 'the card never carries the address');
  const up = await run(app, 'canvas_update', { canvas: id, check: ['Boxes'], add: ['Labels'] });
  assert.match(up, /Moving day/);
  assert.deepEqual(canvasFor(app).state(app, id).items.map((i: { done: boolean }) => i.done), [true, false, false]);
  const list = await run(app, 'canvas_list', {});
  assert.match(list, /Moving day/);
  const one = await call(`/api/library/canvases/${id}`);
  assert.equal(one.status, 200);
  assert.match(one.body.canvas.openPath, /^\/myapp\/owner\/cv/);
  const all = await call('/api/library/canvases');
  assert.equal(all.body.canvases.length, 1);
  assert.equal((await call(`/api/library/canvases/${id}`, { auth: false })).status, 401);
  assert.equal((await call(`/api/library/canvases/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/library/canvases/${id}`)).status, 404);
  for (const n of ['canvas_post', 'canvas_update', 'canvas_list']) assert.equal(familyOf(tool(app, n)).id, 'canvas', n);
  for (const w of ['checklist', 'live view', 'chart', 'lista de verificacion', 'liste de controle', 'checkliste', 'lista de verificacao', 'lista di controllo']) assert.ok(FAMILY_WORDS.canvas.includes(w), w);
});

test('D3.7 the chat card frames it with sandbox="allow-scripts" only and trusts only its own frame', () => {
  const card = readFileSync(join(ROOT, 'web/canvas-card.js'), 'utf8');
  assert.match(card, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(card, /allow-same-origin/);
  assert.match(card, /e\.origin !== 'null'/);
  assert.match(card, /contentWindow === e\.source/);
  assert.match(card, /\/library\/canvases\//);
  const cards = readFileSync(join(ROOT, 'web/result-cards.js'), 'utf8');
  assert.match(cards, /canvas: canvasCard/);
  const frame = readFileSync(join(ROOT, 'web/canvas-frame.js'), 'utf8');
  assert.doesNotMatch(frame, /\bimport\b|localStorage|document\.cookie/);
  assert.match(frame, /visibilityState/);
  assert.match(frame, /parent\.postMessage/);
  // Library → My apps lists them (open the chat, remove).
  assert.match(readFileSync(join(ROOT, 'web/index.html'), 'utf8'), /<div id="myap-canvases"/);
  assert.match(readFileSync(join(ROOT, 'web/my-apps.js'), 'utf8'), /api\('\/library\/canvases'\)/);
});

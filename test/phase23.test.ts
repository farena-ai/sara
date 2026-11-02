// Phase 23: getting-started checklist, updates from Settings, built-in help.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { Updater } from '../src/updates.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-26T15:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const unitDir = join(dir, 'units');
mkdirSync(unitDir);
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), updaterUnitDir: unitDir, info: { version: '0.23.0', revision: 'abc1234', startedAt: clock.now.toISOString() } } as never);
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Response> => {
  const go = () => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return go().catch((err: Error & { cause?: { code?: string } }) => (err.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};

test('getting started: ticks itself off; can be hidden', async () => {
  const first = await (await call('/api/checklist')).json();
  assert.equal(first.hidden, false);
  assert.deepEqual(
    first.items.map((i: { id: string }) => i.id),
    ['brain', 'talk', 'yours', 'phone', 'voice', 'morning', 'backup'],
  );
  assert.ok(first.items.every((i: { done: boolean }) => !i.done));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', briefing: { enabled: true, time: '07:30' } });
  const conv = app.store.createConversation({});
  app.store.addMessage(conv.id, 'user', 'hi');
  writeFileSync(join(dir, 'persona.json'), '{}');
  const now = await (await call('/api/checklist')).json();
  const done = Object.fromEntries(now.items.map((i: { id: string; done: boolean }) => [i.id, i.done]));
  assert.deepEqual(done, { brain: true, talk: true, yours: true, phone: false, voice: false, morning: true, backup: false });
  // Phase 121: the morning step (now *Turn on a routine*) opens Planner → Routines.
  assert.ok(now.items.every((i: { open: string }) => /^(chat|routines|settings:[a-z-]+)$/.test(i.open)));
  const hidden = await (await call('/api/checklist', { hidden: true }, 'PUT')).json();
  assert.equal(hidden.hidden, true);
});

test('updates: plain "use the command line" without the updater; with it, requests one thing at a time', async () => {
  const off = await (await call('/api/update')).json();
  assert.deepEqual([off.available, off.version, off.revision, off.status.state], [false, '0.23.0', 'abc1234', 'idle']);
  const refused = await call('/api/update', { action: 'check' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /sudo sara update/);

  writeFileSync(join(unitDir, 'sara-updater.path'), '[Path]\n');
  const r = await call('/api/update', { action: 'check' });
  assert.equal(r.status, 202);
  assert.equal(readFileSync(join(dir, 'update-request'), 'utf8'), 'check\n');
  assert.equal((await r.json()).status.pending, 'check');
  assert.equal((await call('/api/update', { action: 'update' })).status, 409, 'one at a time');

  // The root updater picks it up and reports back.
  const status = (o: Record<string, unknown>) => writeFileSync(join(dir, 'update-status.json'), JSON.stringify({ at: clock.now.toISOString(), version: '0.23.0 (abc1234)', ...o }));
  // (the updater deletes the request file first)
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'update-request'));
  status({ state: 'available', message: 'Sara 0.24.0 is available.', latest: '0.24.0', behind: 3, changes: 'Passkeys\nSecurity review\nSoak test' });
  const avail = await (await call('/api/update')).json();
  assert.equal(avail.status.state, 'available');
  assert.deepEqual(avail.status.changes, ['Passkeys', 'Security review', 'Soak test']);
  assert.equal((await call('/api/update', { action: 'update' })).status, 202);
  assert.equal(readFileSync(join(dir, 'update-request'), 'utf8'), 'update\n');

  // An updater that never picks the request up, or died mid-way, doesn't block for ever.
  const old = new Date(clock.now.getTime() - 5 * 60_000);
  utimesSync(join(dir, 'update-request'), old, old);
  const stuck = await (await call('/api/update')).json();
  assert.equal(stuck.status.state, 'failed');
  assert.match(stuck.status.message, /didn't pick up/);
  rmSync(join(dir, 'update-request'));
  status({ state: 'updating', message: 'Installing…', at: new Date(clock.now.getTime() - 30 * 60_000).toISOString() });
  assert.equal(new Updater({ dataDir: dir, unitDir, statusDir: dir }).status(clock.now).state, 'failed');
  assert.ok(!existsSync(join(dir, 'update-request')));
});

test('help: the guide page is public, and every Settings page has help text', async () => {
  const res = await fetch(`${base}/help`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const id of ['start', 'brain', 'phone', 'voice', 'memory', 'planner', 'coding', 'accounts', 'look', 'find', 'care', 'signin', 'safety', 'trouble']) assert.match(html, new RegExp(`id="${id}"`));
  const index = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  // Page help lives in web/tips.json since Phase 41.
  const help = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')).pages as Record<string, [string, string]>;
  const pages = [...index.matchAll(/data-page="([a-z-]+)" data-group=/g)].map((m) => m[1]);
  assert.ok(pages.length > 20);
  for (const p of pages) assert.ok(help[p]?.[0], `help text for ${p}`);
  // Every guide link points at a section that exists.
  const anchors = pages.map((p) => help[p][1]);
  assert.equal(anchors.length, pages.length);
  for (const anchor of anchors) assert.match(html, new RegExp(`id="${anchor}"`), anchor);
});

test('no page uses inline styles or scripts (the CSP would block them and the page would look broken)', async () => {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(join(ROOT, 'web')).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(join(ROOT, 'web', f), 'utf8');
    assert.doesNotMatch(html, /<style|style="/, `${f} has inline styles`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f} has an inline script`);
  }
  const res = await fetch(`${base}/doc.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});

test('updates: the first click visibly works (no gap where the old status shows and the page stops looking)', () => {
  // The root updater marks the work as started BEFORE it removes the request file…
  const sh = readFileSync(join(ROOT, 'deploy', 'sara'), 'utf8');
  const web = sh.slice(sh.indexOf('web-request)'), sh.indexOf('logs) need_root'));
  assert.ok(web.indexOf('write_status checking') >= 0 && web.indexOf('write_status checking') < web.indexOf('rm -f -- "$rf"'), 'status first, then the request file goes');
  assert.ok(web.indexOf('write_status updating') < web.indexOf('rm -f -- "$rf"'));
  // …and the page keeps showing "Checking…" until the server's status actually changes.
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /let upWait = null;/);
  assert.match(app, /st\.pending = upWait\.action/);
});

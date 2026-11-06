// E4 slice 1: watches are the owner's. Household members, the demo, guests (signed out) and other
// apps' keys (the /v1 and MCP callers) are refused; the business portal, the MCP server and the
// model's tools have no way to make or widen a watch (she can only suggest one).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { Watches } from '../src/watch.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
  app.settings.update({ timeZone: 'UTC' });
  app.watches = new Watches(app, app.store.db);
  mkdirSync(join(dir, 'workspaces', 'proj'), { recursive: true });
  writeFileSync(join(dir, 'workspaces', 'proj', 'app.log'), 'start\n');
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  return { app, auth, api };
}

const NEW = { root: 'workspace', workspace: 'proj', path: 'app.log', patterns: ['ERROR'] };

test('watch owner: the owner lists, adds, checks, pauses and stops a watch', async (t) => {
  const { api } = await rig(t);
  const list = await api('/api/watches');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.roots.workspaces, ['proj']);
  const made = await api('/api/watches', 'POST', NEW);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.watch.id;
  assert.equal((await api(`/api/watches/${id}/check-now`, 'POST', {})).status, 200);
  assert.equal((await api(`/api/watches/${id}/check-now`, 'POST', {})).status, 429);
  assert.equal((await api(`/api/watches/${id}/pause`, 'POST', {})).body.watch.state, 'paused');
  assert.equal((await api(`/api/watches/${id}/stop`, 'POST', {})).body.watch.state, 'stopped');
  assert.equal((await api('/api/watches', 'POST', { ...NEW, path: '../../store.db' })).status, 400);
  assert.equal((await api(`/api/watches/${id}`, 'DELETE')).status, 200);
  assert.equal((await api('/api/watches')).body.watches.length, 0);
});

for (const mode of ['member', 'demo'] as const) {
  test(`watch owner: a ${mode} gets 403 on every watch route`, async (t) => {
    const { api, app } = await rig(t, mode);
    for (const [path, method] of [['/api/watches', 'GET'], ['/api/watches', 'POST'], ['/api/watches/1/check-now', 'POST'], ['/api/watches/1', 'DELETE'], ['/api/watches/alerts/1/ask', 'POST']] as const) {
      assert.equal((await api(path, method, method === 'POST' ? NEW : undefined)).status, 403, `${mode} ${method} ${path}`);
    }
    assert.equal(app.watches!.list().length, 0);
  });
}

test('watch owner: guests (signed out) and other apps’ keys (/v1, MCP) are refused', async (t) => {
  const { api, auth, app } = await rig(t);
  assert.equal((await api('/api/watches', 'GET', undefined, null)).status, 401);
  assert.equal((await api('/api/watches', 'POST', NEW, null)).status, 401);
  const key = auth.createDeviceToken('Other app', 'api').token;
  assert.equal((await api('/api/watches', 'POST', NEW, key)).status, 401);
  assert.equal(app.watches!.list().length, 0);
});

test('watch owner: no model tool, MCP tool or business route can reach the watches', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  const users = files.filter((f) => /from '\.{1,2}\/(?:\.\.\/)*watch\.ts'|import\('\.{1,2}\/(?:\.\.\/)*watch\.ts'\)/.test(readFileSync(f, 'utf8'))).map((f) => relative(join(ROOT, 'src'), f).replace(/\\/g, '/')).sort();
  assert.deepEqual(users, ['chat.ts', 'main.ts', 'routes/watches.ts']);
  for (const f of files.filter((x) => /[\\/](tools|business)[\\/]|mcp-server\.ts$|mcp-bridge\.ts$/.test(x))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /env_watches|\.watches\b/, f);
  }
});

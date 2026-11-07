import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { contentFixture } from './helpers/business-content.ts';

const NATIVE = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard',
  // A2 developer add-ons share the same candidate review path.
  ...['secret-scanner', 'license-auditor', 'sbom-builder', 'artifact-provenance-verifier', 'coverage-explorer', 'log-explorer', 'incident-workbench', 'environment-config-doctor', 'database-fixture-studio', 'data-contract-validator', 'change-impact-analyzer', 'architecture-guard', 'sql-migration-reviewer', 'visual-regression', 'localization-qa', 'accessibility-auditor', 'build-cache-inspector', 'api-contract-guard', 'http-webhook-workbench',
    'performance-regression-lab', 'code-migration-studio', 'build-reproducibility-inspector', 'test-doctor', 'flaky-test-lab', 'documentation-doctor', 'release-readiness', 'repository-onboarding']];
const RECIPES = ['markitdown', 'tavily', 'firecrawl', 'chrome-devtools', 'dbhub', 'drawio', 'linear'];

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.settings.update({});
  app.companionId = 'main';
  app.providerFactory = () => { throw new Error('No provider calls in discovery tests'); };
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: s => s, fence: 'node-only' });
  app.pluginManager = pm; pm.attach('main', app);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { setPrivateLocal(false); await pm.stopAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); cleanup(); });
  async function api(path: string, method = 'GET', body?: unknown, authenticated = true) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(authenticated ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  }
  return { app, pm, api, dir };
}

test('existing Settings APIs expose every local candidate and inert twenty-one MCP investigations without configuration effects', async t => {
  const { app, pm, api, dir } = await rig(t);
  app.vault.set('synthetic-discovery-sentinel', 'synthetic-value');
  const settings = app.settings.get();
  const disk = readFileSync(join(dir, 'settings.json'), 'utf8');
  const candidates = await api('/api/plugins/candidates');
  assert.equal(candidates.status, 200);
  assert.deepEqual(candidates.body.candidates.map((x: any) => x.id).sort(), [...NATIVE].sort());
  assert.equal(candidates.body.packs.length, 6);
  const mcp = await api('/api/mcp/discovery/previews');
  assert.equal(mcp.status, 200);
  assert.equal(mcp.body.investigations.length, 21);
  assert.deepEqual(mcp.body.investigations.filter((x: any) => x.recipePreview).map((x: any) => x.id).sort(), [...RECIPES].sort());
  assert.equal(mcp.body.investigations.filter((x: any) => x.status === 'blocked').length, 14);
  assert.deepEqual(app.settings.get(), settings);
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), disk);
  assert.equal(app.vault.get('synthetic-discovery-sentinel'), 'synthetic-value');
  assert.deepEqual(pm.list(), []); assert.equal(app.providerCalls, 0);
  assert.equal((await api('/api/plugins/builtin')).body.builtin.length, 6); // EC1: + Slack
  assert.equal((await api('/api/mcp/presets')).body.length, 2);
  const text = JSON.stringify([candidates.body, mcp.body]);
  assert.doesNotMatch(text, /outputs[\\/]|docs[\\/]ops|[A-Z]:[\\/]|synthetic-value/);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await api('/api/mcp/discovery/previews', method, {})).status, 405);
    assert.equal((await api('/api/plugins/candidates', method, {})).status, 405);
  }
  assert.deepEqual(app.settings.get(), settings);
});

test('candidate installation rejects malformed or mixed source selectors without staging or effects', async t => {
  const { pm, api } = await rig(t);
  for (const body of [{ candidate: 12 }, { candidate: '../focus' }, { candidate: '/daily-briefing' }, { candidate: 'unknown' }, { candidate: '' }, { candidate: 'daily-briefing', builtin: 'signal' }, { candidate: 'daily-briefing', store: 'focus' }, { candidate: 'daily-briefing', path: '/tmp' }, { candidate: 'daily-briefing', url: 'https://example.com/repo' }, { candidate: 'daily-briefing', origin: 'builtin' }, { candidate: 'daily-briefing', hash: 'a'.repeat(64) }, { candidate: 'daily-briefing', root: '/tmp' }]) {
    const result = await api('/api/plugins/install', 'POST', body);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(pm.list(), []);
});

test('every candidate selector use the ordinary review and cancel flow without installation', async t => {
  const { pm, api } = await rig(t);
  for (const id of NATIVE) {
    const staged = await api('/api/plugins/install', 'POST', { candidate: id });
    assert.equal(staged.status, 200, `${id}: ${JSON.stringify(staged.body)}`);
    assert.equal(staged.body.manifest.id, id); assert.equal(staged.body.origin.kind, 'candidate');
    assert.equal(staged.body.firstParty, undefined); assert.equal(staged.body.needsTrust, true);
    assert.equal((await api(`/api/plugins/install/${staged.body.id}`)).status, 200);
    assert.equal((await api(`/api/plugins/install/${staged.body.id}`, 'DELETE')).status, 200);
    assert.equal((await api(`/api/plugins/${id}/approve`, 'POST', { review: staged.body.id, trust: true })).status, 404);
    assert.equal(pm.store.get(id), undefined);
  }
});

test('the business profile exposes neither personal discovery nor candidate installation to its administrator or users', async () => {
  const f = await contentFixture();
  try {
    const user = f.add('Jordan');
    for (const session of [f.admin, user]) {
      for (const path of ['/api/plugins/candidates', '/api/mcp/discovery/previews']) assert.equal((await f.request(path, session)).status, 404);
      assert.equal((await f.request('/api/plugins/install', session, { candidate: 'daily-briefing' })).status, 404);
    }
  } finally { await f.close(); }
});

for (const mode of ['member', 'demo'] as const) test(`${mode} and anonymous callers cannot read or mutate add-on discovery`, async t => {
  const { api, pm } = await rig(t, mode);
  for (const path of ['/api/plugins/candidates', '/api/mcp/discovery/previews']) {
    assert.equal((await api(path)).status, 403, path);
    assert.equal((await api(path, 'POST', {})).status, 403, path);
  }
  assert.deepEqual(pm.list(), []);
});

test('anonymous callers are refused; private-local discovery stays inert and available to its owner', async t => {
  const { api, pm, app } = await rig(t);
  for (const path of ['/api/plugins/candidates', '/api/mcp/discovery/previews']) assert.equal((await api(path, 'GET', undefined, false)).status, 401);
  setPrivateLocal(true);
  assert.equal((await api('/api/plugins/candidates')).status, 200);
  assert.equal((await api('/api/mcp/discovery/previews')).status, 200);
  assert.deepEqual(pm.list(), []); assert.equal(app.providerCalls, 0);
});

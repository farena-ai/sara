// W3.2 MCP everywhere: the free MCP server catalog (one-click install, sandbox, approval card,
// per-tool permissions) and Sara as an MCP server with scoped keys (docs/design/W3MCP.md).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { catalogCard, catalogConfig, catalogDeps, MCP_CATALOG, runnerFound } from '../src/mcp-catalog.ts';
import { cleanScopes, MCP_SCOPES, SCOPE_TOOLS, scopeAllows } from '../src/mcp-scopes.ts';
import { describeTools } from '../src/mcp-server.ts';
import { createSaraServer } from '../src/server.ts';
import { mcpNetworkOff, validateMcpConfig } from '../src/tools/mcp.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-19T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
// A child's space: /mcp and /v1 are never open there, and no key can be made.
const kidDir = tempDir();
const kidApp = makeApp(kidDir.dir, clock);
const kidAuth = new OwnerAuth(kidDir.dir, () => clock.now);
const kidRecord = { id: 'k1', name: 'Kim', status: 'active', limits: { voice: false, pictures: false }, child: { birthYear: 2016 } };
const kid = createSaraServer({ app: kidApp, auth: kidAuth, webDir: join(ROOT, 'web'), spaceId: 'k1', member: { record: () => kidRecord, apps: () => [kidApp], deleteSelf: async () => {} } } as never);
let base = '';
let kidBase = '';
const folder = join(dir, 'shared-folder');
// Never a realistic-looking token in a test file: built at run time.
const fakeToken = ['not', 'a', 'real', 'token', String(Date.now())].join('-');
// No real downloads in tests: record which installs would fill a package cache.
const prefetched: string[] = [];
catalogDeps.prefetch = async (item) => {
  prefetched.push(item.id);
  return '';
};

before(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(folder, { recursive: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((r) => kid.listen(0, '127.0.0.1', r));
  kidBase = `http://127.0.0.1:${(kid.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => kid.close(r));
  app.store.close();
  kidApp.store.close();
  cleanup();
  kidDir.cleanup();
});

const ownerApi = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${base}/api${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${owner}`, origin: base, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const rpc = async (key: string, body: unknown, at = base) => {
  const r = await fetch(`${at}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean; protocolVersion?: string }; error?: { message: string } } };
};

// ---------- the catalog ----------

test('catalog: popular free servers, each with source, license, runner, sandbox needs and what it can touch', () => {
  const ids = MCP_CATALOG.map((x) => x.id);
  for (const id of ['filesystem', 'git', 'fetch', 'sqlite', 'time', 'memory', 'playwright', 'github']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const x of MCP_CATALOG) {
    assert.match(x.repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/, `${x.id} repo`);
    assert.ok(x.license.length > 1, `${x.id} license`);
    assert.ok(['npx', 'uvx', 'remote'].includes(x.runner), `${x.id} runner`);
    assert.ok(x.touches.length >= 1, `${x.id} says what it can touch`);
    assert.equal(typeof x.network, 'boolean');
    if (x.runner === 'remote') assert.match(x.url ?? '', /^https:\/\//);
    // Pinned versions only: an install never pulls whatever is newest.
    else assert.match(x.version ?? '', /^\d+\.\d+\.\d+$/, `${x.id} pinned`);
  }
  const by = (id: string) => MCP_CATALOG.find((x) => x.id === id)!;
  assert.equal(by('filesystem').path, 'folder');
  assert.equal(by('git').path, 'folder');
  assert.equal(by('sqlite').path, 'file');
  for (const id of ['filesystem', 'git', 'sqlite', 'time', 'memory', 'sequential-thinking']) assert.equal(by(id).network, false, `${id} runs without the internet`);
  for (const id of ['fetch', 'playwright', 'github']) assert.equal(by(id).network, true, `${id} needs the internet`);
  assert.ok(by('github').secret, 'GitHub uses the person\'s own token');
});

test('catalog: install config is sandboxed to the chosen folder, network off unless needed', () => {
  const fs = MCP_CATALOG.find((x) => x.id === 'filesystem')!;
  assert.throws(() => catalogConfig(fs, {}), /folder/i);
  assert.throws(() => catalogConfig(fs, { path: '/' }), /folder/i);
  assert.throws(() => catalogConfig(fs, { path: 'relative/dir' }), /folder/i);
  const out = catalogConfig(fs, { path: folder });
  assert.equal(out.cfg.name, 'filesystem');
  assert.equal(out.cfg.transport, 'stdio');
  assert.equal(out.cfg.command, 'npx');
  assert.deepEqual(out.cfg.folders, [folder]);
  assert.equal(out.cfg.network, false);
  assert.ok(out.cfg.args!.includes(folder));
  assert.ok(out.cfg.args!.some((a) => a.endsWith(`@${fs.version}`)));
  assert.equal(mcpNetworkOff(out.cfg), true);
  // validateMcpConfig (the normal save path) keeps the network choice.
  assert.equal(validateMcpConfig({ ...out.cfg }, 'filesystem').network, false);
  assert.equal(validateMcpConfig({ transport: 'stdio', command: 'npx' }, 'x').network, undefined);
  const sq = catalogConfig(MCP_CATALOG.find((x) => x.id === 'sqlite')!, { path: join(folder, 'notes.db') });
  assert.deepEqual(sq.cfg.folders, [folder], 'a database file shares only its own folder');
  const fetchCfg = catalogConfig(MCP_CATALOG.find((x) => x.id === 'fetch')!, {});
  assert.equal(fetchCfg.cfg.network, undefined);
  assert.equal(mcpNetworkOff(fetchCfg.cfg), false);
  const gh = MCP_CATALOG.find((x) => x.id === 'github')!;
  assert.throws(() => catalogConfig(gh, {}), /token/i);
  const g = catalogConfig(gh, { secret: fakeToken });
  assert.equal(g.cfg.transport, 'http');
  assert.equal(g.headers.Authorization, `Bearer ${fakeToken}`);
});

test('catalog: the approval card lists exactly what it can do (command, folder, internet, source, license), never a secret', () => {
  const fs = MCP_CATALOG.find((x) => x.id === 'filesystem')!;
  const card = catalogCard(fs, { path: folder });
  assert.match(card.command, /^npx -y @modelcontextprotocol\/server-filesystem@/);
  assert.ok(card.command.includes(folder));
  assert.equal(card.folder, folder);
  assert.equal(card.network, false);
  assert.deepEqual(card.touches, fs.touches);
  assert.equal(card.repo, fs.repo);
  assert.equal(card.license, fs.license);
  const gh = catalogCard(MCP_CATALOG.find((x) => x.id === 'github')!, { secret: fakeToken });
  assert.ok(!JSON.stringify(gh).includes(fakeToken), 'the token is never on the card');
  assert.equal(gh.network, true);
  assert.equal(runnerFound('npx'), true, 'npx comes with Sara\'s own Node');
  assert.equal(runnerFound('remote'), true);
  assert.equal(runnerFound('uvx', ''), false);
});

test('catalog routes: list, card preview changes nothing, confirm installs, per-tool permissions use Tools and approvals', async () => {
  const list = await ownerApi('/mcp/catalog');
  assert.equal(list.status, 200);
  const items = list.body.items as { id: string; installed: boolean; ready: boolean; touches: string[] }[];
  assert.ok(items.some((x) => x.id === 'time' && !x.installed));
  const preview = await ownerApi('/mcp/catalog/filesystem', { method: 'POST', body: { path: folder } });
  assert.equal(preview.status, 200);
  assert.equal((preview.body.card as { folder: string }).folder, folder);
  assert.equal((app.settings.get().mcpServers ?? []).length, 0, 'a preview installs nothing');
  const bad = await ownerApi('/mcp/catalog/filesystem', { method: 'POST', body: { confirm: true } });
  assert.equal(bad.status, 400);
  const ok = await ownerApi('/mcp/catalog/filesystem', { method: 'POST', body: { path: folder, confirm: true } });
  assert.equal(ok.status, 200);
  const saved = (app.settings.get().mcpServers ?? []).find((s) => s.name === 'filesystem')!;
  assert.deepEqual(saved.folders, [folder]);
  assert.equal(saved.network, false);
  assert.deepEqual(prefetched, ['filesystem'], 'a network-off server gets its package once, at install');
  const again = await ownerApi('/mcp/catalog', {});
  assert.ok((again.body.items as { id: string; installed: boolean }[]).find((x) => x.id === 'filesystem')!.installed);
  const gh = await ownerApi('/mcp/catalog/github', { method: 'POST', body: { secret: fakeToken, confirm: true } });
  assert.equal(gh.status, 200);
  assert.ok(!JSON.stringify(app.settings.get()).includes(fakeToken), 'the token goes to the vault, never settings');
  assert.match(app.vault.get('mcp:github') ?? '', /Bearer/);
  const unknown = await ownerApi('/mcp/catalog/nope', { method: 'POST', body: { confirm: true } });
  assert.equal(unknown.status, 404);
});

// ---------- Sara as an MCP server with scoped keys ----------

test('scopes: five named scopes covering every tool she shares; unknown scopes dropped, none = refused', () => {
  assert.deepEqual([...MCP_SCOPES], ['ask', 'memory', 'reminders', 'library', 'planner']);
  const all = describeTools().map((t) => String(t.name));
  const covered = new Set(Object.values(SCOPE_TOOLS).flat());
  for (const n of all) assert.ok(covered.has(n), `${n} belongs to a scope`);
  for (const n of covered) assert.ok(all.includes(n), `${n} is a real tool`);
  assert.equal(cleanScopes(undefined), undefined);
  assert.deepEqual(cleanScopes(['memory', 'bogus', 'memory']), ['memory']);
  assert.throws(() => cleanScopes([]), /at least one/i);
  assert.equal(scopeAllows(undefined, 'ask_sara'), true, 'an old key without scopes keeps everything');
  assert.equal(scopeAllows(['memory'], 'ask_sara'), false);
  assert.equal(scopeAllows(['ask'], 'ask_sara'), true);
});

test('MCP protocol round trip over HTTP: a scoped key sees and runs only its scopes', async () => {
  app.planner!.addReminder({ text: 'Water the ferns', dueAt: new Date(clock.now.getTime() + 3600_000).toISOString() });
  const made = await ownerApi('/devices/api-key', { method: 'POST', body: { label: 'Cursor', token: owner, scopes: ['reminders', 'memory'] } });
  assert.equal(made.status, 200);
  const key = String(made.body.key);
  assert.deepEqual(made.body.scopes, ['memory', 'reminders']);
  const init = await rpc(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'w3', version: '1' } } });
  assert.equal(init.body.result!.protocolVersion, '2025-06-18');
  const listed = (await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result!.tools!.map((t) => t.name);
  assert.ok(listed.includes('list_reminders'));
  assert.ok(listed.includes('search_memory'));
  assert.ok(!listed.includes('ask_sara'), 'no ask scope');
  assert.ok(!listed.includes('list_tasks'), 'no planner scope');
  const got = await rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_reminders', arguments: {} } });
  assert.match(got.body.result!.content![0].text, /Water the ferns/);
  const refused = await rpc(key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_sara', arguments: { message: 'hi' } } });
  assert.ok(refused.body.error, 'a tool outside the scopes is refused');
  assert.match(refused.body.error!.message, /scope|not allowed|unknown/i);
  // The key list shows each key's scopes (null = everything, for keys made before scopes).
  const view = await ownerApi('/other-apps');
  const keys = view.body.keys as { label: string; scopes: string[] | null }[];
  assert.deepEqual(keys.find((k) => k.label === 'Cursor')!.scopes, ['memory', 'reminders']);
  const old = auth.createApiKey('Old app');
  assert.equal((await ownerApi('/other-apps')).body.keys && ((await ownerApi('/other-apps')).body.keys as { label: string; scopes: unknown }[]).find((k) => k.label === 'Old app')!.scopes, null);
  const oldList = (await rpc(old.token, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).body.result!.tools!.map((t) => t.name);
  assert.ok(oldList.includes('ask_sara') && oldList.includes('list_reminders'), 'old keys keep every read tool');
  // Bad scopes are a plain 400.
  assert.equal((await ownerApi('/devices/api-key', { method: 'POST', body: { label: 'x', token: owner, scopes: [] } })).status, 400);
});

test('add_reminder (reminders scope, changes switch on) follows her remind approval rule', async () => {
  app.settings.update({ otherApps: { tools: false, changes: true, origins: [] } });
  app.settings.update({ toolPermissions: { ...(app.settings.get().toolPermissions ?? {}), remind: 'auto' } });
  const k = auth.createApiKey('Reminder app', ['reminders']);
  const r = await rpc(k.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_reminder', arguments: { text: 'Call the vet', when: 'tomorrow 9am' } } });
  assert.match(r.body.result!.content![0].text, /Reminder #\d+.*Call the vet/);
  assert.ok(app.planner!.reminders().some((x) => x.text === 'Call the vet'));
  app.settings.update({ toolPermissions: { ...(app.settings.get().toolPermissions ?? {}), remind: 'never' } });
  const off = await rpc(k.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_reminder', arguments: { text: 'Nope', when: 'tomorrow' } } });
  assert.match(off.body.result!.content![0].text, /turned off/);
  app.settings.update({ otherApps: { tools: false, changes: false, origins: [] } });
});

test('MCP protocol round trip over stdio (the bridge) with a scoped key', async () => {
  const k = auth.createApiKey('Claude Desktop', ['library', 'ask']);
  const child = spawn(process.execPath, [join(ROOT, 'clients', 'mcp', 'sara-mcp.ts'), '--server', base], { env: { ...process.env, SARA_API_KEY: k.token, NODE_TEST_CONTEXT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: { id?: number; result?: { tools?: { name: string }[] } }[] = [];
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const waitFor = async (id: number) => {
    for (let i = 0; i < 300; i++) {
      const l = lines.find((x) => x.id === id);
      if (l) return l;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no answer for ${id}`);
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'w3-stdio', version: '1' } } })}\n`);
    await waitFor(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const names = (await waitFor(2)).result!.tools!.map((t) => t.name);
    assert.ok(names.includes('ask_sara'));
    assert.ok(!names.includes('search_memory'), 'no memory scope through the bridge either');
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
  }
});

test('kids never: /mcp and /v1 answer 403 in a child\'s space, and a child cannot make a key', async () => {
  const k = kidAuth.createApiKey('Sneaky');
  const r = await rpc(k.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, kidBase);
  assert.equal(r.status, 403);
  const v1 = await fetch(`${kidBase}/v1/models`, { headers: { authorization: `Bearer ${k.token}` } });
  assert.equal(v1.status, 403);
  const kt = kidAuth.newToken!;
  const mk = await fetch(`${kidBase}/api/devices/api-key`, { method: 'POST', headers: { authorization: `Bearer ${kt}`, origin: kidBase, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x', token: kt }) });
  assert.equal(mk.status, 403);
});

test('Settings wiring: catalog section on the MCP page, scope boxes on Other apps, docs with snippets', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="mcp-catalog"/);
  for (const s of MCP_SCOPES) assert.match(html, new RegExp(`id="oa-scope-${s}"`));
  const js = readFileSync(join(ROOT, 'web', 'mcp-catalog.js'), 'utf8');
  assert.match(js, /\/mcp\/catalog/);
  assert.match(js, /\/tools'/, 'per-tool permissions go through Tools and approvals');
  const doc = readFileSync(join(ROOT, 'docs', 'OTHER_APPS.md'), 'utf8');
  assert.match(doc, /scopes?/i);
  assert.match(doc, /claude mcp add/);
  assert.match(doc, /mcpServers/);
});

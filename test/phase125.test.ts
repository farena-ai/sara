// Phase 125 (2.58.0, docs/store/SARA_STORE.md §13.1): the Sara Store 2, install and submit. Get on a
// plugin, a skill and a tool server through their review cards (nothing switched on), updates with a
// permission diff, Go back, yanks and blocks (switched off, never deleted), the held list, remove,
// `sara pack` (clean and failing fixtures, the fenced smoke test), Submit (the author key, proof of
// work, ≤480 KiB chunks with hashes, the Ed25519 signature, a draft kept through a 503), reports, and
// the owner-only routes. Everything runs against local fakes: no real network, TEST keys only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { fromFolder, hashFiles, type PackageFile } from '../src/packages.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { PluginProcess } from '../src/plugins/runtime.ts';
import { parseManifest, permissionIds, satisfies } from '../src/plugins/manifest.ts';
import { createSaraServer } from '../src/server.ts';
import { SkillStore } from '../src/skill-store.ts';
import { splitListing } from '../src/store/checks.ts';
import { applyIndex, storeBlocked, StoreClient } from '../src/store/client.ts';
import { StoreInstalls } from '../src/store/installs.ts';
import { packFiles, packPath } from '../src/store/pack.ts';
import { AUTHOR_VAULT, authorKey, CHUNK_BYTES, DeskError, deskDown, fingerprintOf, SIGN_PREFIX, START_FIELDS, submit, submissions } from '../src/store/submit.ts';
import { sha256 } from '../src/store/verify.ts';
import { McpManager } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { zipStored } from '../src/zip-write.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Run as 2.58.0 until the release bumps package.json (as phase122b did).
const V = satisfies(PKG_VERSION, '>=2.58.0') ? PKG_VERSION : '2.58.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const FP = `ed25519:${'9b'.repeat(32)}`;

// ---- TEST keys and a local signed shelf built from real packages ----
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'store-2026a': Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64') };
const PRIV: KeyObject = privateKey;

interface Shelf {
  files: Map<string, Buffer>;
  items: Any[];
  blocked: Any[];
  seq: number;
}
function addVersion(s: Shelf, item: Any, version: Any, entry: Any, zip?: Buffer): void {
  const text = Buffer.from(`${JSON.stringify(entry, null, 1)}\n`);
  version.entrySha = sha256(text);
  s.files.set(`/v1/${version.entry}`, text);
  if (zip) s.files.set(`/v1/${version.package}`, zip);
  const have = s.items.find((x) => x.id === item.id);
  if (have) {
    have.versions.unshift(version);
    have.latest = version.version;
  } else s.items.push({ ...item, latest: version.version, versions: [version] });
}
function publish(s: Shelf): void {
  s.seq += 1;
  const now = new Date();
  const index = { format: 'sara-store-index', v: 1, seq: s.seq, generated: iso(now), expires: iso(new Date(now.getTime() + 30 * 86400_000)), key: 'store-2026a', minSara: '2.57.0', items: s.items, blocked: s.blocked, reservedIds: ['sara'] };
  const json = Buffer.from(`${JSON.stringify(index, null, 1)}\n`);
  s.files.set('/v1/index.json', json);
  s.files.set('/v1/index.sig', Buffer.from(JSON.stringify({ v: 1, key: 'store-2026a', sig: sign(null, json, PRIV).toString('base64') })));
}
const baseEntry = (id: string, kind: string, version: string, name: string): Any => ({
  format: 'sara-store-entry', v: 1, id, kind, version, name, description: `${name}, for the tests.`, about: [`${name}.`], author: { name: 'The Sara team', key: FP },
  license: 'MIT', shots: [], changes: [`Version ${version}.`], checks: { ran: '2026-11-19T22:10:00Z', by: `sara-store-check ${V}`, results: [{ id: 'manifest', ok: true }] }, tested: [], needs: [], works: ['windows', 'macos', 'linux'],
});
const itemOf = (id: string, kind: string, name: string, trust = 'reviewed'): Any => ({ id, kind, name, summary: `${name} for the tests.`, trust, category: 'everyday', tags: ['test'], author: { name: 'The Sara team', key: FP, since: '2026-11-20' } });

/** A plugin version from a folder's files (optionally changing the manifest). */
function pluginVersion(s: Shelf, folder: string, o: { version?: string; edit?: (m: Any) => void; trust?: string } = {}): { files: PackageFile[] } {
  const all = fromFolder(folder);
  const { pkg } = splitListing(all);
  let inner = pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png');
  const raw = JSON.parse(inner.find((f) => f.path === 'sara-plugin.json')!.data.toString('utf8'));
  if (o.version) raw.version = o.version;
  o.edit?.(raw);
  inner = inner.map((f) => (f.path === 'sara-plugin.json' ? { path: f.path, data: Buffer.from(JSON.stringify(raw, null, 2)) } : f));
  const zip = zipStored(inner.map((f) => ({ path: f.path, data: f.data })));
  const m = parseManifest(raw, { saraVersion: V });
  const entry = { ...baseEntry(raw.id, 'plugin', raw.version, raw.name), manifest: raw };
  addVersion(s, itemOf(raw.id, 'plugin', raw.name, o.trust), { version: raw.version, sara: '>=2.57.0', published: '2026-11-20', entry: `entries/${raw.id}/${raw.version}.json`, entrySha: '', package: `packages/${raw.id}-${raw.version}.zip`, sha256: sha256(zip), size: zip.length, contentSha: hashFiles(inner), permissions: permissionIds(m) }, entry, zip);
  return { files: inner };
}
function skillVersion(s: Shelf, id: string, version: string): void {
  const md = `---\nname: ${id}\ndescription: Packs a lunch box, step by step, for the tests.\nmetadata:\n  version: ${version}\n---\n\n# Lunch box\n\n1. Ask what they like.\n2. Run scripts/count.sh to count the boxes.\n`;
  const files: PackageFile[] = [{ path: 'SKILL.md', data: Buffer.from(md) }, { path: 'scripts/count.sh', data: Buffer.from('#!/bin/sh\necho 1\n') }];
  const zip = zipStored(files);
  const entry = { ...baseEntry(id, 'skill', version, 'Lunch box'), manifest: { name: id, description: 'Packs a lunch box.' }, scripts: true };
  addVersion(s, { ...itemOf(id, 'skill', 'Lunch box'), category: 'skills' }, { version, sara: '>=2.57.0', published: '2026-11-20', entry: `entries/${id}/${version}.json`, entrySha: '', package: `packages/${id}-${version}.zip`, sha256: sha256(zip), size: zip.length, contentSha: hashFiles(files), permissions: ['scripts'] }, entry, zip);
}

/** A signed fixture containing the exact candidate bytes, including its local assets. */
function candidateVersion(s: Shelf, version = '1.0.0'): PackageFile[] {
  const files = fromFolder(join(ROOT, 'store', 'plugins', 'daily-briefing'));
  const manifest = JSON.parse(files.find(f => f.path === 'sara-plugin.json')!.data.toString('utf8'));
  manifest.version = version;
  const exact = version === '1.0.0' ? files : files.map(f => f.path === 'sara-plugin.json' ? { ...f, data: Buffer.from(JSON.stringify(manifest)) } : f);
  const zip = zipStored(exact);
  const parsed = parseManifest(manifest, { saraVersion: V });
  addVersion(s, itemOf(manifest.id, 'plugin', manifest.name, 'first-party'), { version, sara: '>=2.57.0', published: '2026-11-20', entry: `entries/${manifest.id}/${version}.json`, entrySha: '', package: `packages/${manifest.id}-${version}.zip`, sha256: sha256(zip), size: zip.length, contentSha: hashFiles(exact), permissions: permissionIds(parsed) }, { ...baseEntry(manifest.id, 'plugin', version, manifest.name), manifest }, zip);
  return exact;
}
const helloRecipe = (version: string, extra: Any = {}): Any => ({
  transport: 'stdio', command: 'node', args: ['${home}/hello.mjs', ...(extra.args ?? [])], name: 'hello',
  fields: [{ key: 'GREETING', kind: 'text', label: 'Greeting', default: 'Hi', tip: 'The word it says first.' }],
  secrets: [{ key: 'HELLO_TOKEN', kind: 'secret', label: 'Hello token', tip: 'A pretend key, kept in the vault.' }],
  reaches: ['nothing: it runs on this computer'], tools: { readOnly: ['greet'], ask: ['count_words'] }, needs: ['node'], guide: ['Install it, then press Test.'], ...(extra.recipe ?? {}),
  version,
});
function mcpVersion(s: Shelf, version: string, extra: Any = {}): void {
  const { version: _v, ...mcp } = helloRecipe(version, extra);
  void _v;
  const entry = { ...baseEntry('hello-mcp', 'mcp', version, 'Hello tools'), mcp };
  addVersion(s, { ...itemOf('hello-mcp', 'mcp', 'Hello tools'), category: 'tool-servers' }, { version, sara: '>=2.57.0', published: '2026-11-20', entry: `entries/hello-mcp/${version}.json`, entrySha: '', permissions: ['run:node', 'secret:HELLO_TOKEN'] }, entry);
}

interface Rig {
  app: TestApp;
  pm: PluginManager;
  client: StoreClient;
  installs: StoreInstalls;
  shelf: Shelf;
  held: string[];
  seen: { method: string; url: string; headers: IncomingMessage['headers'] }[];
  dir: string;
  base: string;
  api: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; json: Any }>;
  check: () => Promise<void>;
}
async function rig(t: TestContext, o: { member?: boolean; demo?: boolean; fence?: 'node-only' | 'bwrap' } = {}): Promise<Rig> {
  const shelf: Shelf = { files: new Map(), items: [], blocked: [], seq: 0 };
  const held: string[] = [];
  const seen: Rig['seen'] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url === '/hub/v1/store/held') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v: 1, held: held.map((id) => ({ id, since: '2026-11-20' })) }));
    const f = shelf.files.get((req.url ?? '').replace(/^\/store/, ''));
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(f);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const storeBase = `http://127.0.0.1:${port}/store`;
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), builtinDir: join(ROOT, 'skills') });
  app.mcp = new McpManager(new ToolRegistry(), { dataDir: dir, sandbox: { mode: 'none', network: true, detail: 'tests' }, secrets: (name) => JSON.parse(app.vault.get(`mcp:${name}`) ?? '{}') });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => x, fence: o.fence ?? 'node-only', saraVersion: V });
  app.pluginManager = pm;
  pm.attach('main', app);
  const installs = new StoreInstalls(app.store.db);
  const fetchHeld = async () => (await (await fetch(`http://127.0.0.1:${port}/hub/v1/store/held`)).json()).held;
  const c = new StoreClient({ dataDir: dir, base: storeBase, keys: KEYS, blocked: () => storeBlocked({ on: true, base: storeBase }), held: fetchHeld });
  const { StoreInstaller } = await import('../src/store/install.ts');
  c.onIndex = async (idx) => {
    await applyIndex(idx, { client: c, installs, plugins: pm, others: (row, reason) => new StoreInstaller({ app, client: c, installs, plugins: pm }).blockOther(row, reason) });
  };
  pm.storeMatch = (sha) => c.match(sha);
  app.storeClient = c;
  app.storeInstalls = installs;
  const http = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() }, ...(o.demo ? { demo: true } : {}), ...(o.member ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Ana' }) as never, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    await pm.stopAll();
    for (const s of app.settings.get().mcpServers ?? []) app.mcp?.stop(s.name);
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api: Rig['api'] = async (method, path, body, tok = token) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const check = async () => {
    publish(shelf);
    const r = await api('POST', '/api/store/check', {});
    assert.equal(r.json.result?.ok, true, JSON.stringify(r.json));
  };
  return { app, pm, client: c, installs, shelf, held, seen, dir, base, api, check };
}
const FOCUS = join(ROOT, 'store', 'plugins', 'focus');

test('A1: an exact signed-content association preserves candidate origin and never grants Store update authority', async t => {
  const r = await rig(t);
  const files = candidateVersion(r.shelf);
  await r.check();
  const review = r.pm.stage(files, { kind: 'candidate' as never, where: 'daily-briefing' });
  const approved = await r.api('POST', '/api/plugins/daily-briefing/approve', { review: review.id, trust: true });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(r.installs.get('daily-briefing')?.content_sha, hashFiles(files), 'signed association retained for block/yank evidence');
  const mine = await r.api('GET', '/api/store/mine');
  const local = mine.json.addons.find((x: Any) => x.ref === 'daily-briefing');
  assert.equal(local.origin, 'candidate');
  assert.equal(local.update, null);
  candidateVersion(r.shelf, '1.1.0'); await r.check();
  const shelf = await r.api('GET', '/api/store');
  const item = shelf.json.items.find((x: Any) => x.id === 'daily-briefing');
  assert.equal(item.installedOrigin, 'candidate'); assert.equal(item.installedVersion, '1.0.0');
  assert.equal(item.updateAvailable, false); assert.ok(item.installHeld);
  const detail = await r.api('GET', '/api/store/items/daily-briefing');
  assert.equal(detail.json.installed.origin, 'candidate'); assert.equal(detail.json.installAllowed, false); assert.ok(detail.json.installHeld);
  const downloads = () => r.seen.filter(x => x.url.includes('/packages/')).length;
  const before = downloads();
  for (const path of ['/api/store/install', '/api/store/update', '/api/store/goback']) {
    const response = await r.api('POST', path, path.endsWith('/install') ? { id: 'daily-briefing' } : { item: 'daily-briefing' });
    assert.equal(response.status, 409, `${path}: ${JSON.stringify(response.json)}`);
  }
  assert.equal(downloads(), before, 'candidate source conflict is refused before package download');
  assert.equal(JSON.parse(r.pm.store.get('daily-briefing')!.origin ?? '{}').kind, 'candidate');
  assert.equal(r.pm.store.get('daily-briefing')!.version, '1.0.0');
});

test('A1: a stale signed association cannot update a removed or mismatched local plugin', async t => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS); await r.check();
  const review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  await r.pm.remove('focus');
  assert.ok(r.installs.get('focus'), 'retain a stale ledger fixture');
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0' }); await r.check();
  const shelf = await r.api('GET', '/api/store');
  const item = shelf.json.items.find((x: Any) => x.id === 'focus');
  assert.equal(item.updateAvailable, false); assert.ok(item.installHeld);
  const before = r.seen.filter(x => x.url.includes('/packages/')).length;
  const update = await r.api('POST', '/api/store/update', { item: 'focus' });
  assert.equal(update.status, 409);
  assert.equal(r.seen.filter(x => x.url.includes('/packages/')).length, before);
  assert.equal(r.pm.store.get('focus'), undefined);
  const forgotten = await r.api('POST', '/api/store/remove', { item: 'focus' });
  assert.equal(forgotten.status, 200); assert.equal(r.installs.get('focus'), undefined);
  const fresh = await r.api('POST', '/api/store/install', { id: 'focus' });
  assert.equal(fresh.status, 200, 'forgetting a stale record restores the supported fresh review');
});

test('A1: forgetting a stale signed association preserves a replacement local installation', async t => {
  const r = await rig(t);
  const v1 = pluginVersion(r.shelf, FOCUS).files;
  await r.check();
  const review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  await r.pm.remove('focus');
  const v2 = v1.map(f => f.path === 'sara-plugin.json' ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString('utf8')), version: '1.1.0' })) } : f);
  const replacement = r.pm.stage(v2, { kind: 'zip', where: 'replacement.zip' });
  await r.pm.approve(replacement.id, { trust: true });
  const row = r.pm.store.get('focus')!;
  const detail = await r.api('GET', '/api/store/items/focus');
  assert.equal(detail.json.installHeldCode, 'association');
  assert.equal((await r.api('GET', '/api/store/mine')).json.addons.find((x: Any) => x.ref === 'focus').origin, 'zip');
  assert.equal((await r.api('POST', '/api/store/remove', { item: 'focus' })).status, 200);
  assert.equal(r.installs.get('focus'), undefined);
  assert.deepEqual(r.pm.store.get('focus'), row);
  assert.ok(existsSync(row.dir)); assert.equal(hashFiles(fromFolder(row.dir)), row.approved_sha);
});

test('A1: signed yanks and blocks still reach a matching candidate without changing its source', async t => {
  const r = await rig(t);
  const files = candidateVersion(r.shelf); await r.check();
  const review = r.pm.stage(files, { kind: 'candidate', where: 'daily-briefing' });
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: review.id, trust: true })).status, 200);
  r.shelf.items.find(x => x.id === 'daily-briefing').versions[0].yanked = 'Synthetic qualification withdrawal.';
  await r.check(); assert.equal(r.installs.get('daily-briefing')?.state, 'yanked');
  r.shelf.blocked = [{ id: 'daily-briefing', versions: '*', action: 'disable', reason: 'Synthetic block.', at: '2026-11-21' }];
  await r.check(); assert.equal(r.pm.store.get('daily-briefing')?.status, 'disabled');
  assert.equal(r.installs.get('daily-briefing')?.state, 'blocked');
  assert.equal(JSON.parse(r.pm.store.get('daily-briefing')!.origin ?? '{}').kind, 'candidate');
  assert.equal((await r.api('POST', '/api/store/override', { item: 'daily-briefing', confirm: true })).status, 200);
  assert.equal(r.pm.store.get('daily-briefing')?.status, 'installed');
  assert.equal(JSON.parse(r.pm.store.get('daily-briefing')!.origin ?? '{}').kind, 'candidate');
});

test('A1: a stale blocked association cannot restore a replacement disabled for changed files', async t => {
  const r = await rig(t);
  const files = pluginVersion(r.shelf, FOCUS).files; await r.check();
  const review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  await r.pm.remove('focus');
  const changed = files.map(f => f.path === 'sara-plugin.json' ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString('utf8')), version: '1.1.0' })) } : f);
  await r.pm.approve(r.pm.stage(changed, { kind: 'zip', where: 'replacement.zip' }).id, { trust: true });
  r.pm.store.setStatus('focus', 'disabled', 'changed');
  r.installs.setState('focus', 'blocked', 'Synthetic old version block.', new Date().toISOString());
  const current = r.pm.store.get('focus');
  const override = await r.api('POST', '/api/store/override', { item: 'focus', confirm: true });
  assert.equal(override.status, 409);
  assert.deepEqual(r.pm.store.get('focus'), current);
});

test('A1: a local zip with exact signed content keeps its actual origin and ordinary Store update path', async t => {
  const r = await rig(t);
  const files = pluginVersion(r.shelf, FOCUS).files; await r.check();
  const review = r.pm.stage(files, { kind: 'zip', where: 'local-copy.zip' });
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  assert.equal((await r.api('GET', '/api/store/mine')).json.addons.find((x: Any) => x.ref === 'focus').origin, 'zip');
  assert.equal((await r.api('GET', '/api/store/items/focus')).json.installed.origin, 'zip');
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0' }); await r.check();
  const update = await r.api('POST', '/api/store/update', { item: 'focus' });
  assert.equal(update.status, 200); assert.equal(update.json.review.origin.kind, 'store');
});

test('A1: delayed Store downloads recheck source authority after a local replacement', async t => {
  const r = await rig(t);
  const files = pluginVersion(r.shelf, FOCUS).files; await r.check();
  const review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  pluginVersion(r.shelf, FOCUS, { version: '1.2.0' }); await r.check();
  let downloaded!: () => void; const reached = new Promise<void>(resolve => { downloaded = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = r.client.packageFiles.bind(r.client);
  t.mock.method(r.client, 'packageFiles', async (...args: Parameters<typeof original>) => { const result = await original(...args); downloaded(); await barrier; return result; });
  const pending = r.api('POST', '/api/store/update', { item: 'focus' });
  try {
    await reached;
    await r.pm.remove('focus');
    const replacement = files.map(f => f.path === 'sara-plugin.json' ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString('utf8')), version: '1.1.0' })) } : f);
    await r.pm.approve(r.pm.stage(replacement, { kind: 'zip', where: 'replacement.zip' }).id, { trust: true });
    const current = r.pm.store.get('focus'); release();
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.json));
    assert.deepEqual(r.pm.store.get('focus'), current);
    assert.equal(hashFiles(fromFolder(current!.dir)), current!.approved_sha);
  } finally { release(); await pending; }
});

async function focusHistory(r: Rig): Promise<void> {
  pluginVersion(r.shelf, FOCUS); await r.check();
  let review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0' }); await r.check();
  review = (await r.api('POST', '/api/store/update', { item: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
}

test('A1: rollback preserves the restored version’s fresh signed withdrawal during an awaited process stop', async t => {
  const r = await rig(t); await focusHistory(r);
  await r.pm.setEnabled('focus', 'main', true);
  assert.ok(await until(() => Boolean(r.app.tools.get('focus__start'))));
  let stopped!: () => void; const reached = new Promise<void>(resolve => { stopped = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = PluginProcess.prototype.stop;
  const held = t.mock.method(PluginProcess.prototype, 'stop', async function(this: PluginProcess) { const exiting = original.call(this); stopped(); await barrier; await exiting; });
  const pending = r.api('POST', '/api/store/goback', { item: 'focus' });
  try {
    await reached;
    for (const v of r.shelf.items.find(x => x.id === 'focus').versions) v.yanked = v.version === '1.0.0' ? 'Synthetic old-version withdrawal.' : 'Synthetic current-version withdrawal.';
    await r.check();
    assert.equal(r.installs.get('focus')?.state, 'yanked');
    release(); const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(r.pm.store.get('focus')?.version, '1.0.0');
    assert.equal(r.installs.get('focus')?.version, '1.0.0');
    assert.equal(r.installs.get('focus')?.state, 'yanked');
    assert.equal(r.installs.get('focus')?.state_note, 'Synthetic old-version withdrawal.');
  } finally { release(); await pending; held.mock.restore(); }
});

test('A1: rollback association failure leaves the approved plugin, signed ledger and both package trees coherent', async t => {
  const r = await rig(t); await focusHistory(r);
  const plugin = r.pm.store.get('focus')!; const ledger = r.installs.get('focus');
  const previous = JSON.parse(plugin.prev_version!);
  const upsert = r.installs.upsert.bind(r.installs);
  t.mock.method(r.installs, 'upsert', (row: Parameters<typeof upsert>[0]) => { upsert(row); if (row.version === '1.0.0') throw new Error('Synthetic association write failure.'); });
  const result = await r.api('POST', '/api/store/goback', { item: 'focus' });
  assert.equal(result.status, 400);
  assert.deepEqual(r.pm.store.get('focus'), plugin);
  assert.deepEqual(r.installs.get('focus'), ledger);
  assert.equal(hashFiles(fromFolder(plugin.dir)), plugin.approved_sha);
  assert.equal(hashFiles(fromFolder(previous.dir)), previous.approved_sha);
});

test('A1: rollback clears a withdrawal that applies only to the newer version and refuses a blocked target', async t => {
  const r = await rig(t); await focusHistory(r);
  r.shelf.items.find(x => x.id === 'focus').versions.find((v: Any) => v.version === '1.1.0').yanked = 'Synthetic newer-version withdrawal.';
  await r.check(); assert.equal(r.installs.get('focus')?.state, 'yanked');
  assert.equal((await r.api('POST', '/api/store/goback', { item: 'focus' })).status, 200);
  assert.equal(r.installs.get('focus')?.version, '1.0.0');
  assert.equal(r.installs.get('focus')?.state, 'ok'); assert.equal(r.installs.get('focus')?.state_note, null);
  assert.equal((await r.api('POST', '/api/store/goback', { item: 'focus' })).status, 200);
  r.shelf.blocked = [{ id: 'focus', versions: ['1.0.0'], action: 'disable', reason: 'Synthetic restored-version block.', at: '2026-11-21' }];
  await r.check();
  const current = r.pm.store.get('focus'); const association = r.installs.get('focus');
  assert.equal((await r.api('POST', '/api/store/goback', { item: 'focus' })).status, 403);
  assert.deepEqual(r.pm.store.get('focus'), current);
  assert.deepEqual(r.installs.get('focus'), association);
});

test('A1: Store rollback cannot associate a previously approved local package with different signed bytes', async t => {
  const r = await rig(t);
  const signed = pluginVersion(r.shelf, FOCUS).files; await r.check();
  const local = signed.map(f => f.path === 'main.mjs' ? { ...f, data: Buffer.concat([f.data, Buffer.from('\n// Synthetic alternative source.\n')]) } : f);
  const review = r.pm.stage(local, { kind: 'zip', where: 'local-copy.zip' });
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  assert.equal(r.installs.get('focus'), undefined);
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0' }); await r.check();
  const update = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: update.id, trust: true })).status, 200);
  const current = r.pm.store.get('focus'); const association = r.installs.get('focus');
  const result = await r.api('POST', '/api/store/goback', { item: 'focus' });
  assert.equal(result.status, 409);
  assert.deepEqual(r.pm.store.get('focus'), current); assert.deepEqual(r.installs.get('focus'), association);
  r.shelf.items.find(x => x.id === 'focus').versions = r.shelf.items.find(x => x.id === 'focus').versions.filter((v: Any) => v.version !== '1.0.0');
  await r.check();
  assert.equal((await r.api('POST', '/api/store/goback', { item: 'focus' })).status, 409, 'a missing signed target cannot create an association either');
  assert.deepEqual(r.pm.store.get('focus'), current); assert.deepEqual(r.installs.get('focus'), association);
  assert.equal((await r.api('POST', '/api/plugins/focus/rollback', {})).status, 200, 'previously approved local bytes remain available through the ordinary Plugins rollback');
  assert.equal(r.pm.store.get('focus')?.approved_sha, hashFiles(local));
  assert.equal((await r.api('GET', '/api/store/items/focus')).json.installHeldCode, 'association');
});

test('A1: a newly withdrawn exact-signed candidate requires a fresh review and records the current withdrawal', async t => {
  const r = await rig(t);
  const files = candidateVersion(r.shelf); await r.check();
  const review = r.pm.stage(files, { kind: 'candidate', where: 'daily-briefing' });
  const reason = 'Synthetic withdrawal before first approval.';
  r.shelf.items.find(x => x.id === 'daily-briefing').versions[0].yanked = reason;
  await r.check();
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: review.id, trust: true })).status, 409);
  assert.equal(r.pm.store.get('daily-briefing'), undefined); assert.equal(r.installs.get('daily-briefing'), undefined);
  const fresh = r.pm.stage(files, { kind: 'candidate', where: 'daily-briefing' });
  assert.equal(fresh.store?.yanked, reason); assert.equal(fresh.firstParty, undefined);
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: fresh.id, trust: true })).status, 200);
  assert.equal(r.installs.get('daily-briefing')?.state, 'yanked'); assert.equal(r.installs.get('daily-briefing')?.state_note, reason);
});

test('A1: a verified block before first approval cannot be bypassed by a candidate or an unassociated local review', async t => {
  const r = await rig(t);
  const files = candidateVersion(r.shelf); await r.check();
  const review = r.pm.stage(files, { kind: 'candidate', where: 'daily-briefing' });
  r.shelf.blocked = [{ id: 'daily-briefing', versions: '*', action: 'disable', reason: 'Synthetic block before first approval.', at: '2026-11-21', contentShas: [hashFiles(files)] }];
  await r.check();
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: review.id, trust: true })).status, 403);
  assert.equal(r.pm.store.get('daily-briefing'), undefined); assert.equal(r.installs.get('daily-briefing'), undefined);
  r.pm.storeMatch = undefined;
  const local = r.pm.stage(files, { kind: 'zip', where: 'local-copy.zip' });
  assert.equal(local.store, undefined);
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: local.id, trust: true })).status, 403);
  assert.equal(r.pm.store.get('daily-briefing'), undefined);
});

for (const change of ['trust', 'content', 'held'] as const) test(`A1: current signed ${change} authority is rechecked before first approval`, async t => {
  const r = await rig(t);
  const files = candidateVersion(r.shelf); await r.check();
  const review = r.pm.stage(files, { kind: 'candidate', where: 'daily-briefing' });
  const item = r.shelf.items.find(x => x.id === 'daily-briefing');
  if (change === 'trust') item.trust = 'community';
  if (change === 'content') item.versions[0].contentSha = 'ab'.repeat(32);
  if (change === 'held') r.held.push('daily-briefing');
  await r.check();
  assert.equal((await r.api('POST', '/api/plugins/daily-briefing/approve', { review: review.id, trust: true })).status, 409);
  assert.equal(r.pm.store.get('daily-briefing'), undefined); assert.equal(r.installs.get('daily-briefing'), undefined);
});

for (const withdrawal of ['yank', 'block'] as const) test(`A1: target-only ${withdrawal} during an awaited approval stop preserves the installed baseline`, async t => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS); await r.check();
  let review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true })).status, 200);
  await r.pm.setEnabled('focus', 'main', true); assert.ok(await until(() => Boolean(r.app.tools.get('focus__start'))));
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0' }); await r.check();
  review = (await r.api('POST', '/api/store/update', { item: 'focus' })).json.review;
  const current = r.pm.store.get('focus'); const association = r.installs.get('focus');
  let stopped!: () => void; const reached = new Promise<void>(resolve => { stopped = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = PluginProcess.prototype.stop;
  const held = t.mock.method(PluginProcess.prototype, 'stop', async function(this: PluginProcess) { const exiting = original.call(this); stopped(); await barrier; await exiting; });
  const pending = r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true });
  try {
    await reached;
    if (withdrawal === 'yank') r.shelf.items.find(x => x.id === 'focus').versions.find((v: Any) => v.version === '1.1.0').yanked = 'Synthetic target-only withdrawal.';
    else r.shelf.blocked = [{ id: 'focus', versions: ['1.1.0'], action: 'disable', reason: 'Synthetic target-only block.', at: '2026-11-21' }];
    await r.check(); release();
    assert.equal((await pending).status, withdrawal === 'yank' ? 409 : 403);
    assert.deepEqual(r.pm.store.get('focus'), current); assert.deepEqual(r.installs.get('focus'), association);
    assert.ok(await until(() => Boolean(r.app.tools.get('focus__start'))), 'unchanged live baseline restarts');
  } finally { release(); await pending; held.mock.restore(); }
});

test('1 · Get on a plugin: the normal review with the store strip, origin store, nothing on after approve, a store_installs row', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  await r.check();
  const got = await r.api('POST', '/api/store/install', { id: 'focus' });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal(got.json.kind, 'plugin');
  const review = got.json.review;
  assert.deepEqual(review.origin, { kind: 'store', where: 'focus@1.0.0' });
  assert.equal(review.store.item, 'focus');
  assert.ok(review.lines.length && review.files.length && review.sha && review.fence);
  // Through the plugin route too ({store: id}), the same card.
  const viaPlugins = await r.api('POST', '/api/plugins/install', { store: 'focus' });
  assert.equal(viaPlugins.json.origin?.kind, 'store', JSON.stringify(viaPlugins.json));
  r.pm.cancel(viaPlugins.json.id);
  const ok = await r.api('POST', '/api/plugins/focus/approve', { review: review.id, trust: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = r.installs.get('focus')!;
  assert.equal(row.kind, 'plugin');
  assert.equal(row.version, '1.0.0');
  assert.ok(((r.pm.list() as Any[]).find((p) => p.id === 'focus')?.companions ?? []).every((c: Any) => c.state !== 'ready' && c.state !== 'running'), 'installing switches nothing on');
});

test('2 · a host that can\'t fence plugins in needs the trust tick, for any trust level', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  await r.check();
  const review = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  assert.equal(review.needsTrust, true);
  assert.equal((await r.api('POST', '/api/plugins/focus/approve', { review: review.id })).status, 400);
});

test('3 · Get on a skill: the import review lists its script; accepted it is imported with origin store:… and recorded', async (t) => {
  const r = await rig(t);
  skillVersion(r.shelf, 'lunch-box', '1.0.0');
  await r.check();
  const got = await r.api('POST', '/api/store/install', { id: 'lunch-box' });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal(got.json.kind, 'skill');
  assert.equal(got.json.review.origin, 'store:lunch-box@1.0.0');
  assert.ok(JSON.stringify(got.json.review.skills).includes('scripts/count.sh'), 'its script is listed');
  const acc = await r.api('POST', `/api/skills/import/${got.json.review.id}/accept`, { scope: 'companion' });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const row = r.installs.get('lunch-box')!;
  assert.equal(row.kind, 'skill');
  const [scope, name] = [row.local_ref.slice(0, row.local_ref.lastIndexOf('/')), row.local_ref.slice(row.local_ref.lastIndexOf('/') + 1)];
  const sk = r.app.skills!.get(scope, name) as Any;
  assert.equal(sk.source, 'imported');
});

test('4 · Get on a tool server: the card (command, fields, needs, fence), nothing starts before approve; secrets only in the vault; a name clash gives -2', async (t) => {
  const r = await rig(t);
  mcpVersion(r.shelf, '1.0.0');
  await r.check();
  r.app.settings.update({ mcpServers: [{ name: 'hello', enabled: false, transport: 'stdio', command: 'node', args: ['x.mjs'] } as Any] });
  const got = await r.api('POST', '/api/store/install', { id: 'hello-mcp' });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const card = got.json.review;
  assert.equal(card.kind, 'mcp');
  assert.equal(card.command, 'node');
  assert.deepEqual(card.args, ['${home}/hello.mjs']);
  assert.equal(card.serverName, 'hello-2');
  assert.equal(card.renamed, true);
  assert.equal(card.fence, 'none');
  assert.equal(card.needsTrust, true);
  assert.deepEqual(card.needs[0], { what: 'node', found: true });
  assert.equal(card.fields[0].key, 'GREETING');
  if (process.platform === 'win32') assert.ok(card.windowsForm);
  assert.equal(r.app.mcp!.get('hello-2'), undefined, 'nothing started');
  // Approve: the script goes where ${home} points (the server's own folder), the secret to the vault.
  mkdirSync(join(r.dir, 'mcp', 'hello-2'), { recursive: true });
  cpSync(join(ROOT, 'examples', 'mcp', 'hello-mcp-server.mjs'), join(r.dir, 'mcp', 'hello-2', 'hello.mjs'));
  assert.equal((await r.api('POST', `/api/store/mcp/${card.id}/approve`, { values: {}, secrets: { HELLO_TOKEN: 'tok-SECRET-123' } })).status, 400, 'the trust tick');
  const ok = await r.api('POST', `/api/store/mcp/${card.id}/approve`, { values: { GREETING: 'Hey' }, secrets: { HELLO_TOKEN: 'tok-SECRET-123' }, trust: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.test.ok, true, ok.json.test.text);
  assert.deepEqual(ok.json.tools.sort(), ['count_words', 'greet']);
  assert.match(r.app.vault.get('mcp:hello-2') ?? '', /tok-SECRET-123/);
  assert.ok(!readFileSync(join(r.dir, 'settings.json'), 'utf8').includes('tok-SECRET-123'), 'no secret in the settings file');
  assert.ok(!JSON.stringify(card).includes('tok-SECRET-123'));
  // 5 · the tool advice: greet is read-only by both, count_words is read-only by its annotation, so stays unset.
  const perms = r.app.settings.get().toolPermissions ?? {};
  assert.equal(perms.mcp_hello_2_greet ?? Object.entries(perms).find(([k]) => k.endsWith('greet'))?.[1], 'auto');
  assert.equal(Object.entries(perms).find(([k]) => k.endsWith('count_words'))?.[1], undefined, 'advice only where the annotations agree');
});

test('6 · updates: same permissions → short; one more host → exactly that id added; an MCP update shows its change; Go back; never applied without approve', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  await r.check();
  const rv = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  await r.api('POST', '/api/plugins/focus/approve', { review: rv.id, trust: true });
  pluginVersion(r.shelf, FOCUS, { version: '1.0.1' });
  await r.check();
  const mine = (await r.api('GET', '/api/store/mine')).json;
  assert.equal(mine.updates, 1);
  const short = (await r.api('POST', '/api/store/update', { item: 'focus' })).json.review;
  assert.equal(short.short, true);
  assert.equal(r.installs.get('focus')!.version, '1.0.0', 'not applied without approve');
  r.pm.cancel(short.id);
  pluginVersion(r.shelf, FOCUS, { version: '1.1.0', edit: (m) => (m.permissions = { ...m.permissions, network: [...(m.permissions.network ?? []), 'api.example.org'] }) });
  await r.check();
  const full = (await r.api('POST', '/api/store/update', { item: 'focus' })).json.review;
  assert.notEqual(full.short, true);
  assert.deepEqual(full.added, ['network:api.example.org']);
  await r.api('POST', '/api/plugins/focus/approve', { review: full.id, trust: true });
  assert.equal(r.installs.get('focus')!.version, '1.1.0');
  const gb = await r.api('POST', '/api/store/goback', { item: 'focus' });
  assert.equal(gb.status, 200, JSON.stringify(gb.json));
  assert.equal(r.installs.get('focus')!.version, '1.0.0', JSON.stringify(gb.json));
  // A tool server update that changes what it runs shows that line.
  mcpVersion(r.shelf, '1.0.0');
  await r.check();
  const c1 = (await r.api('POST', '/api/store/install', { id: 'hello-mcp' })).json.review;
  mkdirSync(join(r.dir, 'mcp', 'hello'), { recursive: true });
  cpSync(join(ROOT, 'examples', 'mcp', 'hello-mcp-server.mjs'), join(r.dir, 'mcp', 'hello', 'hello.mjs'));
  await r.api('POST', `/api/store/mcp/${c1.id}/approve`, { secrets: { HELLO_TOKEN: 'x' }, trust: true });
  mcpVersion(r.shelf, '1.1.0', { args: ['--quiet'] });
  await r.check();
  const c2 = (await r.api('POST', '/api/store/update', { item: 'hello-mcp' })).json.review;
  assert.equal(c2.mode, 'update');
  assert.ok(c2.changes.some((x: string) => /--quiet/.test(x)), JSON.stringify(c2.changes));
  assert.equal(r.installs.get('hello-mcp')!.version, '1.0.0');
  const ok = await r.api('POST', `/api/store/mcp/${c2.id}/approve`, { trust: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(r.installs.get('hello-mcp')!.version, '1.1.0');
  assert.equal((await r.api('POST', '/api/store/goback', { item: 'hello-mcp' })).status, 200);
  assert.equal(r.installs.get('hello-mcp')!.version, '1.0.0');
});

test('7 · a yanked version keeps running and says why; a block switches each kind off (nothing deleted); the override needs the confirm', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  skillVersion(r.shelf, 'lunch-box', '1.0.0');
  mcpVersion(r.shelf, '1.0.0');
  await r.check();
  const pr = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  await r.api('POST', '/api/plugins/focus/approve', { review: pr.id, trust: true });
  const sr = (await r.api('POST', '/api/store/install', { id: 'lunch-box' })).json.review;
  await r.api('POST', `/api/skills/import/${sr.id}/accept`, { scope: 'companion' });
  const mr = (await r.api('POST', '/api/store/install', { id: 'hello-mcp' })).json.review;
  mkdirSync(join(r.dir, 'mcp', 'hello'), { recursive: true });
  cpSync(join(ROOT, 'examples', 'mcp', 'hello-mcp-server.mjs'), join(r.dir, 'mcp', 'hello', 'hello.mjs'));
  await r.api('POST', `/api/store/mcp/${mr.id}/approve`, { secrets: { HELLO_TOKEN: 'x' }, trust: true });
  // Yank focus 1.0.0.
  r.shelf.items.find((i) => i.id === 'focus').versions[0].yanked = 'Showed the wrong day.';
  await r.check();
  assert.equal(r.installs.get('focus')!.state, 'yanked');
  assert.equal(r.pm.store.get('focus')!.status, 'installed', 'a yank switches nothing off');
  // Block all three.
  r.shelf.blocked = ['focus', 'lunch-box', 'hello-mcp'].map((id) => ({ id, versions: '*', action: 'disable', reason: 'Sent your settings to a stranger.', at: '2026-11-21' }));
  await r.check();
  assert.equal(r.pm.store.get('focus')!.status, 'disabled');
  assert.ok(existsSync(r.pm.store.get('focus')!.dir), 'the plugin folder is kept');
  const skillRow = r.installs.get('lunch-box')!;
  const [sc, nm] = [skillRow.local_ref.slice(0, skillRow.local_ref.lastIndexOf('/')), skillRow.local_ref.slice(skillRow.local_ref.lastIndexOf('/') + 1)];
  const skill = r.app.skills!.get(sc, nm) as Any;
  assert.ok(skill, 'the skill is kept');
  assert.equal(skill.enabled, false);
  assert.equal((r.app.settings.get().mcpServers ?? []).find((x) => x.name === 'hello')?.enabled, false);
  assert.ok(r.app.vault.get('mcp:hello'), 'its vault entry is kept');
  assert.equal(r.installs.get('hello-mcp')!.state, 'blocked');
  assert.equal((await r.api('POST', '/api/store/override', { item: 'hello-mcp' })).status, 400, 'the confirm is needed');
  assert.equal((await r.api('POST', '/api/store/override', { item: 'hello-mcp', confirm: true })).status, 200);
  assert.equal((r.app.settings.get().mcpServers ?? []).find((x) => x.name === 'hello')?.enabled, true);
});

test('8 · a held id can\'t be installed or updated and its page says so; the held list switches nothing off', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  await r.check();
  const rv = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  await r.api('POST', '/api/plugins/focus/approve', { review: rv.id, trust: true });
  r.held.push('focus');
  await r.check();
  const page = (await r.api('GET', '/api/store/items/focus')).json;
  assert.equal(page.held, true);
  const hi = await r.api('POST', '/api/store/install', { id: 'focus' });
  assert.equal(hi.status, 409);
  assert.equal(hi.json.code, 'held');
  assert.equal((await r.api('POST', '/api/store/update', { item: 'focus' })).json.code, 'held');
  assert.equal(r.pm.store.get('focus')!.status, 'installed', 'held: nothing switched off');
  assert.ok(r.seen.filter((s) => s.url.includes('/held')).every((s) => !s.headers.cookie && !s.url.includes('?')), 'the held list is an anonymous GET');
});

test('9 · Remove takes the plugin folders, the skill to .trash, the tool server and its vault entry, and the row', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  mcpVersion(r.shelf, '1.0.0');
  await r.check();
  const pr = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  await r.api('POST', '/api/plugins/focus/approve', { review: pr.id, trust: true });
  const dir = r.pm.store.get('focus')!.dir;
  const mr = (await r.api('POST', '/api/store/install', { id: 'hello-mcp' })).json.review;
  await r.api('POST', `/api/store/mcp/${mr.id}/approve`, { secrets: { HELLO_TOKEN: 'x' }, trust: true });
  assert.equal((await r.api('POST', '/api/store/remove', { item: 'focus' })).status, 200);
  assert.equal((await r.api('POST', '/api/store/remove', { item: 'hello-mcp' })).status, 200);
  assert.ok(!existsSync(dir));
  assert.equal(r.app.vault.get('mcp:hello'), undefined);
  assert.equal((r.app.settings.get().mcpServers ?? []).length, 0);
  assert.equal(r.installs.get('focus'), undefined);
  assert.equal(r.installs.get('hello-mcp'), undefined);
});

test('10 · sara pack: a clean plugin is ready; a key, an undeclared host, a missing tip, an unknown permission, a link, a big file or a missing tool each fail plainly; the smoke test is fenced', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clean = await packPath(FOCUS, { saraVersion: V, scratch: join(dir, 'scratch') });
  assert.equal(clean.report.ready, true, JSON.stringify(clean.report.results.filter((x) => !x.ok)));
  assert.equal(clean.report.smoke, 'ran');
  assert.ok(clean.report.results.some((x) => x.id === 'smoke' && x.ok));
  const base = fromFolder(FOCUS);
  const withFile = (path: string, data: string | Buffer) => [...base.filter((f) => f.path !== path), { path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }];
  const manifest = JSON.parse(base.find((f) => f.path === 'sara-plugin.json')!.data.toString('utf8'));
  const fails = async (files: PackageFile[], re: RegExp, what: string) => {
    const p = await packFiles(files, { saraVersion: V, smoke: false });
    assert.equal(p.report.ready, false, what);
    const text = p.report.results.flatMap((x) => x.problems).join(' | ');
    assert.match(text, re, `${what}: ${text}`);
  };
  await fails(withFile('notes.txt', 'token = "sk-live-0123456789abcdefghijklmnopqrstuv"\n'), /key|password|secret/i, 'a planted key');
  await fails(withFile('main.mjs', `${base.find((f) => f.path === 'main.mjs')!.data.toString()}\nfetch('https://undeclared.example.net/x');\n`), /undeclared\.example\.net|host/i, 'an undeclared host');
  await fails(withFile('sara-plugin.json', JSON.stringify({ ...manifest, permissions: { ...manifest.permissions, teleport: true } })), /teleport|permission|unknown/i, 'an unknown permission');
  if (manifest.settings?.length) await fails(withFile('sara-plugin.json', JSON.stringify({ ...manifest, settings: manifest.settings.map((s: Any) => ({ ...s, tip: undefined })) })), /tip/i, 'a setting without a tip');
  await fails(withFile('big.bin', Buffer.alloc(6 * 1024 * 1024 + 1, 7)), /MB|big|large/i, 'a 6 MB file');
  // A link in the folder is refused when it's read.
  const linkDir = join(dir, 'linked');
  cpSync(FOCUS, linkDir, { recursive: true });
  let linked = false;
  try {
    symlinkSync(join(dir, 'linked', 'main.mjs'), join(linkDir, 'alias.mjs'));
    linked = true;
  } catch {
    /* Windows without the right: skip that one */
  }
  if (linked) assert.equal((await packPath(linkDir, { saraVersion: V, smoke: false })).report.ready, false, 'a link');
  // A tool in the manifest that ready doesn't list fails the smoke test.
  if (manifest.permissions?.tools?.length) {
    const m2 = { ...manifest, permissions: { ...manifest.permissions, tools: [...manifest.permissions.tools, { name: 'ghost', description: 'Not really there.', input: { type: 'object', properties: {} } }] } };
    const p = await packFiles(withFile('sara-plugin.json', JSON.stringify(m2)), { saraVersion: V, scratch: join(dir, 's2') });
    assert.equal(p.report.ready, false, 'a tool missing from ready');
  }
  // A hanging plugin is killed in time.
  const hang = withFile('main.mjs', 'setInterval(() => {}, 1000);\n');
  const t0 = Date.now();
  const hp = await packFiles(hang, { saraVersion: V, scratch: join(dir, 's3'), readyMs: 800, watchMs: 0 });
  assert.equal(hp.report.ready, false);
  assert.ok(Date.now() - t0 < 12_000, 'a hanging plugin is stopped');
});

test('11 · Submit: one author key in the vault; the start has exactly the listed fields and work; ≤480 KiB chunks with hashes; a signature over the right text; a draft through a 503', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-20T10:00:00Z') });
  t.after(() => app.store.close());
  const k1 = authorKey(app.vault)!;
  assert.equal(authorKey(app.vault)!.fingerprint, k1.fingerprint, 'made once');
  assert.ok(app.vault.get(AUTHOR_VAULT));
  assert.equal(fingerprintOf(k1.publicRaw), k1.fingerprint);
  const big = [...fromFolder(FOCUS), { path: 'data/blob.bin', data: Buffer.from(Array.from({ length: 1_100_000 }, (_v, i) => (i * 7919) % 251)) }];
  const pack = await packFiles(big, { saraVersion: V, smoke: false });
  const sent: { method: string; url: string; headers: Record<string, string>; body: Buffer }[] = [];
  let down = true;
  const send = async (url: string, init: Any) => {
    const body = init.body === undefined ? Buffer.alloc(0) : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    sent.push({ method: init.method, url, headers: init.headers, body });
    if (down) return { status: 503, text: async () => '{}', json: async () => ({}) } as Any;
    if (url.endsWith('/submissions')) return { status: 200, json: async () => ({ submission: 'SUB-1001', token: 'tok', upload: 'up' }), text: async () => '' } as Any;
    if (url.includes('/chunks/')) return { status: 200, json: async () => ({ ok: true }), text: async () => '' } as Any;
    return { status: 200, json: async () => ({ state: 'checking' }), text: async () => '' } as Any;
  };
  const input = { pack, name: 'Ada Example', vault: app.vault, db: app.store.db, hubBase: 'http://127.0.0.1:1/hub', installId: '0123456789abcdef0123456789abcdef', saraVersion: V, os: 'linux' as const, send, bits: 4 };
  // A 503: the desk is down, so the route keeps the draft (drafts.json) and nothing is half-sent.
  await assert.rejects(submit(input as Any), (e: Any) => e instanceof DeskError && deskDown(e.status));
  assert.equal(submissions(app.store.db).length, 0);
  down = false;
  sent.length = 0;
  const res = await submit(input as Any);
  assert.equal(res.submission, 'SUB-1001');
  const startReq = JSON.parse(sent[0].body.toString('utf8'));
  assert.deepEqual(Object.keys(startReq).sort(), [...START_FIELDS].filter((f) => f !== 'contact').sort());
  assert.ok(startReq.pow && String(startReq.pow.nonce).length > 0 && startReq.pow.bits === 4);
  const chunks = sent.filter((s) => s.url.includes('/chunks/'));
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.body.length <= CHUNK_BYTES && CHUNK_BYTES === 480 * 1024);
    assert.equal(c.headers['X-Chunk-Sha256'] ?? c.headers['x-chunk-sha256'], sha256(c.body));
  }
  const fin = JSON.parse(sent.at(-1)!.body.toString('utf8'));
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(k1.publicRaw, 'base64').toString('base64url') }, format: 'jwk' });
  assert.ok(edVerify(null, Buffer.from(`${SIGN_PREFIX}focus:${pack.report.version}:${pack.sha256}`), pub, Buffer.from(fin.signature, 'base64')));
  assert.equal(submissions(app.store.db).find((s) => s.submission === 'SUB-1001')?.token, 'tok');
  // Only what the author chose: no folder path, no settings, no vault values.
  const all = sent.map((s) => s.body.toString('latin1')).join('');
  assert.ok(!all.includes(dir) && !all.includes(app.vault.get(AUTHOR_VAULT)!.slice(10, 40)));
});

test('12 · a report carries no log unless ticked; ticked, the log is scrubbed', async (t) => {
  const r = await rig(t);
  pluginVersion(r.shelf, FOCUS);
  await r.check();
  const rv = (await r.api('POST', '/api/store/install', { id: 'focus' })).json.review;
  await r.api('POST', '/api/plugins/focus/approve', { review: rv.id, trust: true });
  r.pm.store.log('focus', 'main', 'log', `called with key sk-live-0123456789abcdefghijklmnop from ${r.dir}`);
  const plain = await r.api('POST', '/api/store/report', { item: 'focus', preview: true });
  assert.equal(plain.json.log ?? '', '');
  const ticked = await r.api('POST', '/api/store/report', { item: 'focus', preview: true, log: true });
  assert.equal(ticked.status, 200, JSON.stringify(ticked.json));
  assert.ok(ticked.json.log.includes('called with key'));
  assert.ok(!ticked.json.log.includes('sk-live-0123456789abcdefghijklmnop'), 'the key is scrubbed');
});

test('13 · /api/store/* is the owner\'s: members and the demo are refused, private local mode refuses writes, and no member route family names it', async (t) => {
  assert.ok(![...MEMBER_ROUTES].some((x) => x.startsWith("/api/store") || x === "store"));
  const m = await rig(t, { member: true });
  for (const [method, path] of [['GET', '/api/store/mine'], ['POST', '/api/store/install'], ['POST', '/api/store/pack'], ['POST', '/api/store/submit'], ['GET', '/api/store/submissions']] as const) assert.equal((await m.api(method, path, method === 'POST' ? {} : undefined)).status, 403, `member: ${path}`);
  const d = await rig(t, { demo: true });
  assert.equal((await d.api('POST', '/api/store/install', { id: 'focus' })).status, 403);
  const r = await rig(t);
  setPrivateLocal(true);
  try {
    for (const [path, body] of [['/api/store/install', { id: 'focus' }], ['/api/store/submit', {}], ['/api/store/report', { item: 'focus', reason: 'broken', text: 'x' }]] as const) {
      const x = await r.api('POST', path, body);
      assert.equal(x.status, 409, `${path}: ${JSON.stringify(x.json)}`);
      assert.equal(x.json.code, 'private', path);
    }
  } finally {
    setPrivateLocal(false);
  }
});

test('14 · Get more is built with textContent only, uses Sara\'s permission lines and searches locally', () => {
  const js = readFileSync(join(ROOT, 'web', 'store.js'), 'utf8');
  const part2 = js.slice(js.indexOf('Phase 125'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(part2), 'no HTML from the store');
  assert.match(part2, /export function matches\(item, q\)/);
  assert.ok(!/fetch\([^)]*q=/.test(part2), 'search sends nothing');
  assert.match(part2, /r\.lines/, 'the item page shows the lines Sara computed');
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /data-page="ab-store"/);
  assert.match(html, /<dialog id="store-panel"/);
  assert.equal((html.match(/id="stp-close"/g) ?? []).length, 1);
});

test('15 · the hub checker CLI writes result.json for a job (the same checks), without network', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const job = join(dir, 'jobs', 'SUB-1');
  mkdirSync(job, { recursive: true });
  const pack = await packFiles(fromFolder(FOCUS), { saraVersion: V, smoke: false });
  writeFileSync(join(job, 'package.zip'), pack.zip);
  writeFileSync(join(job, 'job.json'), JSON.stringify({ v: 1, submission: 'SUB-1', kind: 'plugin', item: 'focus', version: pack.report.version, sha256: pack.sha256 }));
  const { spawn } = await import('node:child_process');
  const code = await new Promise<number>((res) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'store', 'check-cli.ts'), '--jobs', join(dir, 'jobs')], { stdio: 'ignore', env: { ...process.env, SARA_CHECK_NO_BWRAP: '1' } });
    p.on('exit', (c) => res(c ?? 1));
  });
  assert.equal(code, 0);
  assert.ok(await until(() => existsSync(join(job, 'result.json'))));
  const out = JSON.parse(readFileSync(join(job, 'result.json'), 'utf8'));
  assert.equal(out.ready, true, JSON.stringify(out.report?.results?.filter((x: Any) => !x.ok)));
  assert.equal(out.contentSha, pack.report.contentSha);
  rmSync(job, { recursive: true, force: true });
});

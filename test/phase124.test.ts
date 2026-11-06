// Phase 124 (2.57.0, docs/store/SARA_STORE.md §13.1): the Sara Store 1. The registry format, the
// signature, sequence and expiry, the reader against a local fake store (no real network), blocks on
// installed plugins, the store strip, the first shelf's checks and recipes, the skill tidy-up, and the
// settings row. Test keys only (the shipped keys are swapped through an option, never an env var).
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { OWNER_SETTINGS } from '../src/household.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { fromFolder, hashFiles, stripTop } from '../src/packages.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { parseManifest, satisfies } from '../src/plugins/manifest.ts';
import { storeSettings } from '../src/routes/store.ts';
import { SAME_OK } from '../scripts/i18n-extract.ts';
import { createSaraServer } from '../src/server.ts';
import { SkillStore } from '../src/skill-store.ts';
import { nearDuplicates, tidyAnswer, tidyCandidates, tidyCard } from '../src/skill-tidy.ts';
import { checkPlugin, checkRecipe, recipeCommand, recipeProblems, splitListing } from '../src/store/checks.ts';
import { applyIndex, INDEX_CAP, PULLED_NOTE, storeBase, storeBlocked, StoreClient, type StoreSend } from '../src/store/client.ts';
import { parseEntry, parseIndex, parseRecipe, StoreFormatError } from '../src/store/format.ts';
import { StoreInstalls } from '../src/store/installs.ts';
import { STORE_KEYS } from '../src/store/keys.ts';
import { acceptIndex, checkPackage, checkPinned, sha256, StoreRefused } from '../src/store/verify.ts';
import { zipStored } from '../src/zip-write.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// The first shelf needs Sara 2.57.0; until the release bumps package.json the test runs as 2.57.0.
const V = satisfies(PKG_VERSION, '>=2.57.0') ? PKG_VERSION : '2.57.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HEX = (c: string) => c.repeat(64).slice(0, 64);
const FP = `ed25519:${HEX('9b')}`;
const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};

// ---- test keys and signed lists ----
function testKeys(): { keys: Record<string, string>; priv: Record<string, KeyObject> } {
  const keys: Record<string, string> = {};
  const priv: Record<string, KeyObject> = {};
  for (const name of ['store-2026a', 'store-2026b']) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    keys[name] = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    priv[name] = privateKey;
  }
  return { keys, priv };
}
const K = testKeys();
function signed(index: Any, keyName = 'store-2026a', priv = K.priv[keyName]): { json: Buffer; sig: Buffer } {
  const json = Buffer.from(`${JSON.stringify({ ...index, key: index.key ?? keyName }, null, 1)}\n`);
  return { json, sig: Buffer.from(JSON.stringify({ v: 1, key: keyName, sig: sign(null, json, priv).toString('base64') })) };
}
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
function sampleIndex(o: { seq?: number; now?: Date; items?: Any[]; blocked?: Any[]; revokedKeys?: string[]; expiresDays?: number; key?: string } = {}): Any {
  const now = o.now ?? new Date();
  return {
    format: 'sara-store-index',
    v: 1,
    seq: o.seq ?? 412,
    generated: iso(now),
    expires: iso(new Date(now.getTime() + (o.expiresDays ?? 30) * 86400_000)),
    key: o.key ?? 'store-2026a',
    minSara: '2.57.0',
    items: o.items ?? [
      {
        id: 'weather-alerts',
        kind: 'plugin',
        name: 'Weather alerts',
        summary: 'Warns you about storms on days you have plans outside.',
        trust: 'first-party',
        category: 'everyday',
        tags: ['weather', 'planner'],
        author: { name: 'The Sara team', key: FP, since: '2026-11-20' },
        latest: '2.0.0',
        versions: [
          { version: '2.0.0', sara: '>=2.57.0', published: '2026-11-20', entry: 'entries/weather-alerts/2.0.0.json', entrySha: HEX('5c'), package: 'packages/weather-alerts-2.0.0.zip', sha256: HEX('a3'), size: 18342, contentSha: HEX('77'), permissions: ['hook:schedule', 'network:api.open-meteo.com', 'tool:check', 'settings'] },
          { version: '1.2.0', sara: '>=2.31.0', published: '2026-11-01', yanked: "Showed the wrong day's forecast after midnight.", entry: 'entries/weather-alerts/1.2.0.json', entrySha: HEX('5d'), package: 'packages/weather-alerts-1.2.0.zip', sha256: HEX('a4'), size: 17110, contentSha: HEX('78'), permissions: ['hook:schedule'] },
        ],
      },
    ],
    blocked: o.blocked ?? [{ id: 'free-crypto-tips', versions: '*', action: 'disable', reason: "Sent your settings to a stranger's server.", at: '2026-11-18' }],
    reservedIds: ['sara', 'official', 'admin', 'telegram', 'discord', 'whatsapp', 'signal', 'email', 'matrix', 'imessage'],
    ...(o.revokedKeys ? { revokedKeys: o.revokedKeys } : {}),
  };
}
const comfyEntry = (): Any => ({
  format: 'sara-store-entry', v: 1, id: 'comfyui', kind: 'mcp', version: '1.0.0', name: 'ComfyUI (image workflows)',
  description: 'Lets her run your ComfyUI workflows to make and edit pictures on your own computer. ComfyUI must be running.',
  about: ['ComfyUI makes pictures on your computer.'], author: { name: 'The Sara team', key: FP, contact: 'https://backstagecoding.com/sara/#support' },
  license: 'MIT', source: 'https://github.com/example/comfyui-mcp/tree/abc', shots: [{ file: `shots/${HEX('1c')}.png`, sha256: HEX('1c'), alt: 'Sara making a poster with ComfyUI', width: 1440 }],
  changes: ['First listing.'], checks: { ran: '2026-11-19T22:10:00Z', by: 'sara-store-check 2.57.0', results: [{ id: 'manifest', ok: true }, { id: 'secrets', ok: true }, { id: 'smoke', ok: true, note: 'tools/list answered with 6 tools' }] },
  review: { by: 'team', at: '2026-11-20', notes: 'Tested on Windows 11 and Ubuntu 24.04 with ComfyUI 0.3.x.' }, tested: [{ os: 'windows', sara: '2.57.0' }, { os: 'linux', sara: '2.57.0' }], needs: ['node'], works: ['windows', 'macos', 'linux'],
  mcp: { registry: 'io.github.example/comfyui-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'comfyui-mcp@1.4.2'], name: 'comfyui',
    fields: [{ key: 'COMFYUI_URL', kind: 'url', label: 'ComfyUI address', default: 'http://127.0.0.1:8188', where: 'local', tip: "Where ComfyUI is running. On the same computer as Sara it's usually http://127.0.0.1:8188." }, { key: 'COMFYUI_OUTPUT_DIR', kind: 'folder', label: 'Where pictures are saved', optional: true, tip: "A folder on this computer. Leave empty to use ComfyUI's own output folder." }],
    secrets: [], reaches: ['the ComfyUI address you give it'], tools: { readOnly: ['list_workflows', 'get_queue'], ask: ['run_workflow', 'upload_image'] }, needs: ['node', 'app:ComfyUI running'], guide: ['Start ComfyUI.', 'Install this, then press Test.'] },
});

// ---- a local fake store (a static server that records every request) ----
interface Fake {
  base: string;
  files: Map<string, { status?: number; body?: Buffer | string; headers?: Record<string, string> }>;
  seen: { method: string; url: string; headers: IncomingMessage['headers'] }[];
  server: Server;
}
async function fakeStore(t: TestContext): Promise<Fake> {
  const files: Fake['files'] = new Map();
  const seen: Fake['seen'] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const f = files.get((req.url ?? '').replace(/^\/store/, ''));
    if (!f) return res.writeHead(404).end();
    const body = typeof f.body === 'string' ? Buffer.from(f.body) : (f.body ?? Buffer.alloc(0));
    const etag = `"${sha256(body).slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag && !f.status) return res.writeHead(304, { ETag: etag }).end();
    res.writeHead(f.status ?? 200, { 'Content-Type': 'application/json', ETag: etag, ...(f.headers ?? {}) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/store`, files, seen, server };
}
function publishTo(fake: Fake, s: { json: Buffer; sig: Buffer }): void {
  fake.files.set('/v1/index.json', { body: s.json });
  fake.files.set('/v1/index.sig', { body: s.sig });
}
function client(dir: string, fake: Fake, o: { now?: () => Date; blocked?: () => Any; send?: StoreSend } = {}): StoreClient {
  return new StoreClient({ dataDir: dir, base: fake.base, keys: K.keys, blocked: o.blocked ?? (() => undefined), ...(o.now ? { now: o.now } : {}), ...(o.send ? { send: o.send } : {}) });
}

// =============================================================================================
test('1 · the format takes the §4.2 index and §4.3 entries and refuses each broken shape', () => {
  const { index, skipped } = parseIndex(JSON.stringify(sampleIndex()));
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].versions[1].yanked, "Showed the wrong day's forecast after midnight.");
  assert.deepEqual(skipped, []);
  const e = parseEntry(JSON.stringify(comfyEntry()), { id: 'comfyui', version: '1.0.0', kind: 'mcp' });
  assert.equal(e.mcp?.fields[0].key, 'COMFYUI_URL');
  const pluginEntry = { ...comfyEntry(), id: 'weather-alerts', kind: 'plugin', version: '2.0.0', mcp: undefined, manifest: { manifest: 1, id: 'weather-alerts' } };
  delete pluginEntry.mcp;
  assert.equal(parseEntry(pluginEntry).kind, 'plugin');
  const refuse = (mut: (x: Any) => void, why: RegExp) => {
    const x = sampleIndex();
    mut(x);
    assert.throws(() => parseIndex(JSON.stringify(x)), (err: Error) => err instanceof StoreFormatError && why.test(err.message), String(why));
  };
  refuse((x) => (x.extra = 1), /unknown field "extra"/);
  refuse((x) => (x.items[0].price = 0), /unknown field "price"/);
  refuse((x) => (x.v = 2), /too old/);
  refuse((x) => (x.items[0].id = 'Bad_ID'), /lowercase/);
  refuse((x) => x.items.push({ ...x.items[0] }), /twice/);
  refuse((x) => (x.expires = iso(new Date(Date.parse(x.generated) + 46 * 86400_000))), /45 days/);
  refuse((x) => (x.items[0].name = 'n'.repeat(61)), /longer than 60/);
  refuse((x) => (x.items[0].versions = Array.from({ length: 11 }, (_v, i) => ({ ...x.items[0].versions[0], version: `2.0.${i}` }))), /more than 10/);
  assert.throws(() => parseIndex(`${JSON.stringify(sampleIndex())}${' '.repeat(2 * 1024 * 1024)}`), /bigger than 2 MB/);
  // Entries: unknown fields refused; text only https links.
  assert.throws(() => parseEntry({ ...comfyEntry(), html: '<b>' }), /unknown field/);
  assert.throws(() => parseEntry({ ...comfyEntry(), source: 'http://x.example' }), /https/);
  assert.throws(() => parseEntry({ ...comfyEntry(), review: { by: 'Ada', at: '2026-11-20' } }), /team/);
});

test('2 · items of later kinds are skipped, not an error, and absent from GET /api/store', async (t) => {
  // Phase 127 (2.60.0) made `companion` a known kind; the 2.59 reader's skip of it is test/phase127.test.ts #31.
  const kinds = ['routine', 'starter', 'bundle'];
  const base = sampleIndex();
  const idx = sampleIndex({ items: [...base.items, ...kinds.map((k) => ({ id: `a-${k}`, kind: k, whatever: { future: true } }))] });
  const { index, skipped } = parseIndex(JSON.stringify(idx));
  assert.deepEqual(skipped, kinds.map((k) => `a-${k}`));
  assert.deepEqual(index.items.map((i) => i.id), ['weather-alerts']);
  const r = await rig(t, idx);
  const view = (await r.api('GET', '/api/store')).json;
  assert.deepEqual(view.items.map((i: Any) => i.id), ['weather-alerts']);
});

test('3 · the signature: exact bytes, known key, checked before JSON.parse runs', () => {
  const s = signed(sampleIndex());
  const st = { seq: 0, revokedKeys: [] };
  assert.equal(acceptIndex(s.json, s.sig, st, { keys: K.keys }).index.seq, 412);
  let parsed = 0;
  const spy = (txt: string) => (parsed++, JSON.parse(txt));
  const bad = (json: Buffer, sig: Buffer | string, code: string) => {
    assert.throws(() => acceptIndex(json, sig, st, { keys: K.keys, parse: spy }), (e: Error) => e instanceof StoreRefused && e.code === code, code);
  };
  const flipped = Buffer.from(s.json);
  flipped[40] ^= 1;
  bad(flipped, s.sig, 'signature');
  const other = generateKeyPairSync('ed25519').privateKey;
  bad(s.json, JSON.stringify({ v: 1, key: 'store-2099z', sig: sign(null, s.json, other).toString('base64') }), 'unknown-key');
  const sigObj = JSON.parse(s.sig.toString());
  bad(s.json, JSON.stringify({ ...sigObj, sig: Buffer.from(sigObj.sig, 'base64').subarray(0, 40).toString('base64') }), 'signature');
  // `key` names the other slot, but the signature is by a key that isn't it.
  bad(s.json, JSON.stringify({ v: 1, key: 'store-2026b', sig: sigObj.sig }), 'signature');
  assert.equal(parsed, 0, 'JSON.parse never ran on a list whose signature failed');
  // The same list signed by the spare key passes too (both shipped keys are accepted).
  const b = signed(sampleIndex({ key: 'store-2026b' }), 'store-2026b');
  assert.equal(acceptIndex(b.json, b.sig, st, { keys: K.keys, parse: spy }).index.key, 'store-2026b');
  assert.equal(parsed, 1);
  // The shipped keys are two real 32-byte Ed25519 public keys.
  assert.deepEqual(Object.keys(STORE_KEYS), ['store-2026a', 'store-2026b']);
  for (const k of Object.values(STORE_KEYS)) assert.equal(Buffer.from(k, 'base64').length, 32);
});

test('4 · rollback, freeze, the future and revocation', async (t) => {
  const fake = await fakeStore(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  let now = new Date('2026-11-20T12:00:00Z');
  const c = client(dir, fake, { now: () => now });
  publishTo(fake, signed(sampleIndex({ seq: 5, now })));
  assert.deepEqual(await c.check(), { ok: true, changed: true });
  publishTo(fake, signed(sampleIndex({ seq: 4, now })));
  const r = await c.check();
  assert.equal(r.ok, false);
  assert.equal(c.current()?.index.seq, 5, 'the cache keeps 5');
  assert.match(c.state().lastError ?? '', /older/);
  // Freeze: past expires, the list is kept for browsing but allows no installs.
  assert.equal(c.installAllowed(), true);
  now = new Date('2026-12-21T12:00:00Z');
  assert.equal(c.current()?.index.seq, 5);
  assert.equal(c.installAllowed(), false);
  // generated two days in the future: refused.
  now = new Date('2026-11-20T12:00:00Z');
  const future = new Date(now.getTime() + 2 * 86400_000);
  publishTo(fake, signed(sampleIndex({ seq: 6, now: future })));
  assert.equal((await c.check()).ok, false);
  assert.match(c.state().lastError ?? '', /future/);
  // A valid list signed by b revokes a: from then on a is refused (remembered in state.json).
  publishTo(fake, signed(sampleIndex({ seq: 7, now, key: 'store-2026b', revokedKeys: ['store-2026a'] }), 'store-2026b'));
  assert.deepEqual(await c.check(), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'store', 'state.json'), 'utf8')).revokedKeys, ['store-2026a']);
  publishTo(fake, signed(sampleIndex({ seq: 8, now })));
  assert.equal((await c.check()).ok, false);
  assert.match(c.state().lastError ?? '', /withdrawn/);
  assert.equal(new StoreClient({ dataDir: dir, base: fake.base, keys: K.keys, blocked: () => undefined, now: () => now }).current()?.index.seq, 7);
});

test('5 · entries, pictures and packages must match the signed list; a zip must unpack to the content hash', async (t) => {
  const entryText = JSON.stringify(comfyEntry());
  assert.doesNotThrow(() => checkPinned(Buffer.from(entryText), sha256(entryText)));
  assert.throws(() => checkPinned(Buffer.from(`${entryText} `), sha256(entryText), 'entry'), /didn't match/);
  const files = [{ path: 'sara-plugin.json', data: Buffer.from('{}') }, { path: 'main.mjs', data: Buffer.from('export {}') }];
  const zip = zipStored(files);
  const good = { sha256: sha256(zip), size: zip.length, contentSha: hashFiles(files) };
  assert.equal(checkPackage(zip, good).length, 2);
  assert.throws(() => checkPackage(zip, { ...good, sha256: HEX('00') }), /didn't match/);
  // The zip's bytes hash correctly, but its files are not the ones reviewed.
  assert.throws(() => checkPackage(zip, { ...good, contentSha: hashFiles([files[0]]) }), (e: Error) => e instanceof StoreRefused && e.code === 'content');
  // Through the client: an entry and a picture whose bytes differ from the pins are refused.
  const fake = await fakeStore(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const idx = sampleIndex();
  idx.items[0].versions[0].entrySha = sha256('{"not":"this"}');
  fake.files.set('/v1/entries/weather-alerts/2.0.0.json', { body: '{"something":"else"}' });
  fake.files.set(`/v1/shots/${HEX('1c')}.png`, { body: 'not the picture' });
  publishTo(fake, signed(idx));
  const c = client(dir, fake);
  assert.equal((await c.check()).ok, true);
  await assert.rejects(c.entry('weather-alerts'), /didn't match/);
  await assert.rejects(c.shot(`shots/${HEX('1c')}.png`, HEX('1c')), /didn't match/);
});

test('6 · the reader: GET, If-None-Match, User-Agent Sara only, no cookie or query or id; 304, redirects and a 3 MB list', async (t) => {
  const fake = await fakeStore(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const installId = 'f00dfacecafe0123456789abcdef0123';
  writeFileSync(join(dir, 'hub.json'), JSON.stringify({ id: installId }));
  publishTo(fake, signed(sampleIndex({ seq: 9 })));
  const c = client(dir, fake);
  assert.deepEqual(await c.check(), { ok: true, changed: true });
  assert.deepEqual(await c.check(), { ok: true, changed: false });
  const idx = fake.seen.filter((s) => s.url.endsWith('/v1/index.json'));
  assert.equal(idx.length, 2);
  assert.equal(idx[0].headers['if-none-match'], undefined);
  assert.ok(idx[1].headers['if-none-match'], 'the second fetch is conditional');
  for (const s of fake.seen) {
    assert.equal(s.method, 'GET');
    assert.equal(s.headers['user-agent'], 'Sara');
    assert.equal(s.headers.cookie, undefined);
    assert.equal(s.headers.referer, undefined);
    assert.ok(!s.url.includes('?'), s.url);
    assert.ok(!JSON.stringify(s).includes(installId), 'no install id anywhere');
  }
  assert.equal(c.current()?.index.seq, 9, 'a 304 keeps the cache');
  // A redirect is refused (never followed).
  fake.files.set('/v1/index.json', { status: 302, headers: { Location: 'http://127.0.0.1:1/elsewhere' } });
  const red = await c.check();
  assert.equal(red.ok, false);
  assert.match(c.state().lastError ?? '', /redirect/);
  // A list over the 2 MB cap is refused, the old one kept.
  fake.files.set('/v1/index.json', { body: Buffer.alloc(3 * 1024 * 1024, 0x20) });
  assert.equal((await c.check()).ok, false);
  assert.match(c.state().lastError ?? '', /bigger/);
  assert.ok(INDEX_CAP < 3 * 1024 * 1024);
  assert.equal(c.current()?.index.seq, 9);
});

test('7 · no store request in the demo, private local mode, for a member, with the store off, or in tests without SARA_STORE_URL', async (t) => {
  const fake = await fakeStore(t);
  publishTo(fake, signed(sampleIndex()));
  const env = { NODE_TEST_CONTEXT: 'child' } as NodeJS.ProcessEnv;
  assert.equal(storeBlocked({ demo: true, on: true, base: fake.base, env }), 'demo');
  assert.equal(storeBlocked({ member: true, on: true, base: fake.base, env }), 'member');
  assert.equal(storeBlocked({ on: false, base: fake.base, env }), 'off');
  assert.equal(storeBase({}), 'https://backstagecoding.com/sara/store');
  assert.equal(storeBase({ SARA_STORE_URL: 'http://example.com/store' }), 'https://backstagecoding.com/sara/store', 'plain http only for this computer');
  assert.equal(storeBlocked({ on: true, base: storeBase({}), env }), 'tests');
  assert.equal(storeBlocked({ on: true, base: fake.base, env }), undefined);
  setPrivateLocal(true);
  try {
    // Private local mode (the network guard): refused before anything is sent, even to this computer.
    assert.equal(storeBlocked({ on: true, base: fake.base, env }), 'private');
    assert.equal(storeBlocked({ on: true, base: storeBase({}), env }), 'private');
  } finally {
    setPrivateLocal(false);
  }
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  for (const why of ['demo', 'private', 'member', 'off', 'tests']) {
    const c = client(dir, fake, { blocked: () => why });
    assert.deepEqual(await c.check(), { ok: false, reason: why });
  }
  assert.equal(fake.seen.length, 0, 'not one request');
});

test('8 · the cache survives a restart, a damaged copy is dropped and fetched again, and it is pruned to 50 MB', async (t) => {
  const fake = await fakeStore(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  publishTo(fake, signed(sampleIndex({ seq: 11 })));
  assert.equal((await client(dir, fake).check()).ok, true);
  const again = client(dir, fake);
  assert.equal(again.current()?.index.seq, 11, 'read back after a restart, checked again');
  writeFileSync(join(dir, 'store', 'index.json'), '{"format":"sara-store-index","v":1,"tampered":true}');
  const third = client(dir, fake);
  assert.equal(third.current(), undefined, 'the damaged copy is dropped');
  assert.equal(existsSync(join(dir, 'store', 'index.json')), false);
  const before = fake.seen.length;
  assert.equal((await third.check()).ok, true);
  assert.equal(fake.seen[before].headers['if-none-match'], undefined, 'fetched in full again');
  assert.equal(third.current()?.index.seq, 11);
  // Pruning keeps the newest files under the cap.
  mkdirSync(join(dir, 'store', 'shots'), { recursive: true });
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'store', 'shots', `s${i}`), Buffer.alloc(1000, i));
  assert.equal(third.prune(2500), 3);
  assert.equal(readdirSync(join(dir, 'store', 'shots')).length, 2);
});

// ---- a Sara server with the store wired as main.ts does ----
interface Rig {
  app: TestApp;
  pm: PluginManager;
  client: StoreClient;
  installs: StoreInstalls;
  fake: Fake;
  dir: string;
  api: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; json: Any }>;
}
async function rig(t: TestContext, index?: Any, o: { member?: boolean; demo?: boolean } = {}): Promise<Rig> {
  const fake = await fakeStore(t);
  if (index) publishTo(fake, signed(index));
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => x, fence: 'node-only', saraVersion: V });
  app.pluginManager = pm;
  pm.attach('main', app);
  const c = new StoreClient({ dataDir: dir, base: fake.base, keys: K.keys, blocked: () => storeBlocked({ on: storeSettings(app.settings.get() as never).on, base: fake.base }) });
  const installs = new StoreInstalls(app.store.db);
  c.onIndex = async (idx) => {
    await applyIndex(idx, { client: c, installs, plugins: pm });
  };
  pm.storeMatch = (sha) => c.match(sha);
  app.storeClient = c;
  app.storeInstalls = installs;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() }, ...(o.demo ? { demo: true } : {}), ...(o.member ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Ana' }) as never, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await pm.stopAll();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api: Rig['api'] = async (method, path, body, tok = token) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  if (index) assert.equal((await api('POST', '/api/store/check', {})).json.result.ok, true);
  return { app, pm, client: c, installs, fake, dir, api };
}

test('9 · GET /api/store is the owner\'s, the demo refuses it, and items this Sara can\'t run say why', async (t) => {
  const idx = sampleIndex();
  const other = process.platform === 'linux' ? 'macos' : 'linux';
  idx.items.push({ ...idx.items[0], id: 'needs-new', versions: [{ ...idx.items[0].versions[0], sara: '>=9.1.0' }] });
  idx.items.push({ ...idx.items[0], id: 'other-os', works: [other], versions: [{ ...idx.items[0].versions[0] }] });
  const r = await rig(t, idx);
  const view = (await r.api('GET', '/api/store')).json;
  const by = (id: string) => view.items.find((i: Any) => i.id === id);
  assert.equal(by('weather-alerts').canRun, true);
  assert.equal(by('weather-alerts').version, '2.0.0', 'the yanked 1.2.0 is not offered');
  assert.deepEqual(by('needs-new').why, { code: 'sara', text: 'Needs Sara {version}', params: { version: '9.1.0' } });
  assert.equal(by('other-os').why.code, 'platform');
  assert.equal(view.freshness, 'fresh');
  assert.equal(view.installAllowed, true);
  const m = await rig(t, undefined, { member: true });
  const mr = await m.api('GET', '/api/store');
  assert.equal(mr.status, 403);
  assert.equal(mr.json.ownerOnly, true);
  const d = await rig(t, undefined, { demo: true });
  assert.equal((await d.api('GET', '/api/store')).status, 403);
});

test('10 · a block in a verified list switches off a matching plugin on every companion and deletes nothing; warn only notes', async (t) => {
  const r = await rig(t);
  const files = fromFolder(join(ROOT, 'store', 'plugins', 'focus'));
  const { pkg } = splitListing(files);
  const review = r.pm.stage(pkg, { kind: 'zip', where: 'focus.zip' });
  const row = await r.pm.approve(review.id, { trust: true });
  await r.pm.setEnabled('focus', 'main', true);
  const state = () => ((r.pm.list() as Any[]).find((p) => p.id === 'focus')?.companions ?? []).map((c: Any) => c.state);
  assert.ok(await until(() => state().includes('ready') || state().includes('running')), `it runs (${state()})`);
  const sha = row.approved_sha;
  const blocked = sampleIndex({ seq: 500, blocked: [{ id: 'focus', versions: '*', action: 'disable', reason: 'Sent your settings to a stranger.', at: '2026-11-18', contentShas: [sha] }] });
  publishTo(r.fake, signed(blocked));
  assert.equal((await r.client.check()).ok, true);
  const after = r.pm.store.get('focus')!;
  assert.equal(after.status, 'disabled');
  assert.equal(after.status_note, `${PULLED_NOTE}Sent your settings to a stranger.`);
  assert.ok(await until(() => state().every((x: string) => x === 'stopped')), `its processes stopped (${state()})`);
  assert.ok(existsSync(after.dir), 'nothing deleted');
  assert.equal(r.client.state().notices[0].action, 'disable');
  // The same block again changes nothing (the owner may switch it back on and it stays on).
  await r.pm.setEnabled('focus', 'main', true);
  publishTo(r.fake, signed({ ...blocked, seq: 501 }));
  assert.equal((await r.client.check()).ok, true);
  assert.equal(r.pm.store.get('focus')!.status, 'installed');
  // warn: only a notice.
  const w = await rig(t);
  const rv = w.pm.stage(pkg, { kind: 'zip', where: 'focus.zip' });
  const wr = await w.pm.approve(rv.id, { trust: true });
  publishTo(w.fake, signed(sampleIndex({ seq: 600, blocked: [{ id: 'focus', versions: '*', action: 'warn', reason: 'Looks unmaintained.', at: '2026-11-18', contentShas: [wr.approved_sha] }] })));
  assert.equal((await w.client.check()).ok, true);
  assert.equal(w.pm.store.get('focus')!.status, 'installed');
  assert.equal(w.client.state().notices[0].action, 'warn');
});

test('11 · a .zip whose files match a store entry gets the store strip; another gets none', async (t) => {
  const files = fromFolder(join(ROOT, 'store', 'plugins', 'focus'));
  const { pkg } = splitListing(files);
  const inner = pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png');
  const idx = sampleIndex();
  idx.items.push({ ...idx.items[0], id: 'focus', name: 'Focus', latest: '1.0.0', versions: [{ ...idx.items[0].versions[0], version: '1.0.0', entry: 'entries/focus/1.0.0.json', contentSha: hashFiles(inner) }] });
  const r = await rig(t, idx);
  const review = r.pm.stage(inner, { kind: 'zip', where: 'focus.zip' });
  assert.deepEqual(review.store, { item: 'focus', version: '1.0.0', name: 'Focus', trust: 'first-party' });
  await r.pm.approve(review.id, { trust: true });
  // Approving through the route records it in store_installs (see 10 for blocks on such rows).
  const other = r.pm.stage([...inner.filter((f) => f.path !== 'main.mjs'), { path: 'main.mjs', data: Buffer.from(`${inner.find((f) => f.path === 'main.mjs')!.data.toString()}\n// changed\n`) }].map((f) => (f.path === 'sara-plugin.json' ? { path: f.path, data: Buffer.from(f.data.toString().replace('"1.0.0"', '"1.0.1"')) } : f)), { kind: 'zip', where: 'focus-changed.zip' });
  assert.equal(other.store, undefined, 'a non-matching file: no strip');
});

test('12 · every first-party item in store/ passes the checks, and every plugin answers ready with exactly its tools', async () => {
  const shelf = JSON.parse(readFileSync(join(ROOT, 'store', 'shelf.json'), 'utf8'));
  assert.equal(shelf.items.length, 12);
  assert.deepEqual(shelf.items.filter((i: Any) => i.kind === 'plugin').map((i: Any) => i.id).sort(), ['focus', 'github-digest', 'home-scenes', 'reading-list', 'weather-alerts', 'webhook-notes']);
  for (const s of shelf.items.filter((i: Any) => i.kind === 'plugin')) {
    const files = fromFolder(join(ROOT, 'store', 'plugins', s.id));
    const rep = checkPlugin(files, { saraVersion: V, firstParty: true });
    assert.ok(rep.ready, `${s.id}: ${JSON.stringify(rep.results.filter((x) => !x.ok))}`);
    for (const id of ['manifest', 'limits', 'secrets', 'scan', 'shots', 'listing']) assert.ok(rep.results.find((x) => x.id === id)?.ok, `${s.id} ${id}`);
    // A fake channel: init, then ready with exactly the declared tools.
    const m = parseManifest(readFileSync(join(ROOT, 'store', 'plugins', s.id, 'sara-plugin.json'), 'utf8'), { saraVersion: V });
    const child = spawn(process.execPath, [join(ROOT, 'store', 'plugins', s.id, 'main.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stdin.write(`${JSON.stringify({ v: 1, type: 'init', settings: {}, secrets: {}, lang: 'en', plugin: s.id, companion: 'main' })}\n`);
    assert.ok(await until(() => out.includes('"type":"ready"'), 10_000), `${s.id} answered ready`);
    child.kill();
    const ready = JSON.parse(out.split('\n').find((l) => l.includes('"type":"ready"'))!);
    assert.deepEqual(ready.tools.map((x: Any) => x.name).sort(), [...m.permissions.tools].sort(), s.id);
  }
});

test('13 · every recipe in store/mcp/ passes §6.5, and the checker refuses each bad shape', () => {
  const dir = join(ROOT, 'store', 'mcp');
  const recipes = readdirSync(dir).filter((f) => f.endsWith('.json'));
  // Keep the six original recipes and exactly the seven qualified connection previews.
  // Preview files do not imply they are published in the signed shelf.
  assert.deepEqual(recipes.map((f) => f.slice(0, -5)).sort(), ['blender', 'chrome-devtools', 'comfyui', 'context7', 'dbhub', 'drawio', 'filesystem', 'firecrawl', 'github', 'linear', 'markitdown', 'playwright', 'tavily']);
  for (const f of recipes) {
    const text = readFileSync(join(dir, f), 'utf8');
    const r = JSON.parse(text);
    const shots = readdirSync(join(dir, 'shots')).filter((x) => x.startsWith(`${r.id}-`)).map((x) => ({ path: `shots/${x}`, data: readFileSync(join(dir, 'shots', x)) }));
    const rep = checkRecipe({ ...r, bytes: Buffer.byteLength(text) }, shots, { firstParty: true });
    assert.ok(rep.ready, `${f}: ${JSON.stringify(rep.results.filter((x) => !x.ok))}`);
  }
  const base = comfyEntry().mcp;
  const no = (mut: (r: Any) => void, why: RegExp, o: { dataDirs?: string[] } = {}) => {
    const r = structuredClone(base);
    mut(r);
    const p = recipeProblems(r, o);
    assert.ok(p.some((x) => why.test(x)), `${why}: ${JSON.stringify(p)}`);
  };
  assert.deepEqual(recipeProblems(base), []);
  no((r) => (r.command = 'cmd'), /can't start/);
  no((r) => (r.command = 'bash'), /can't start/);
  no((r) => ((r.command = 'node'), (r.args = ['-e', 'process.exit()'])), /node may/);
  no((r) => (r.command = 'start.cmd'), /\.cmd script/);
  no((r) => (r.command = 'C:\\tools\\server.exe'), /not a path/);
  no((r) => (r.command = '/usr/bin/npx'), /not a path/);
  no((r) => (r.args = ['-y', 'comfyui-mcp']), /exact version/);
  no((r) => (r.args = ['-y', 'comfyui-mcp@latest']), /exact version/);
  no((r) => (r.args = ['-y', 'comfyui-mcp@^1.4.2']), /exact version/);
  no((r) => ((r.command = 'uvx'), (r.args = ['blender-mcp'])), /==/);
  no((r) => ((r.command = 'uvx'), (r.args = ['--from', 'git+https://github.com/a/b@main', 'x'])), /40-character/);
  no((r) => ((r.command = 'docker'), (r.args = ['run', '--rm', '-i', 'ghcr.io/x/y:latest'])), /digest/);
  no((r) => ((r.command = 'docker'), (r.args = ['run', '--rm', '-i', '--privileged', `ghcr.io/x/y@sha256:${HEX('ab')}`])), /privileged/);
  no((r) => ((r.command = 'docker'), (r.args = ['run', '--rm', '-i', '--network', 'host', `ghcr.io/x/y@sha256:${HEX('ab')}`])), /network host/);
  no((r) => (r.args = ['-y', 'comfyui-mcp@1.4.2', '${env:HOME}']), /isn't allowed/);
  no((r) => (r.fields[1].default = join(ROOT, 'data', 'pics')), /folder of its own/, { dataDirs: [join(ROOT, 'data')] });
  no((r) => (r.fields[1].default = 'C:\\'), /folder of its own/);
  no((r) => delete r.fields[0].tip, /tip/);
  assert.equal(parseRecipe(base).tools.ask.length, 2);
});

test('14 · on Windows a store recipe with npx runs as node …npx-cli.js (windowsCommand), and the card shows that form', () => {
  const { dir, cleanup } = tempDir();
  try {
    const bin = join(dir, 'nodejs');
    mkdirSync(join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(bin, 'npx.cmd'), '@echo off');
    writeFileSync(join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
    const r = parseRecipe(JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'playwright.json'), 'utf8')).mcp);
    const nodeExe = join(bin, 'node.exe');
    const w = recipeCommand(r, { platform: 'win32', pathVar: bin, nodeExe })!;
    assert.equal(w.command, nodeExe);
    assert.equal(w.args[0], join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
    assert.deepEqual(w.args.slice(1), ['-y', '@playwright/mcp@0.0.84']);
    assert.deepEqual(recipeCommand(r, { platform: 'linux' }), { command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'] });
  } finally {
    cleanup();
  }
});

test('15 · skill tidy-up: learned skills unused for 60 days are offered and archived only on Archive them; near-duplicates make one merge card a month', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date() });
  t.after(() => app.store.close());
  let now = new Date('2026-08-01T12:00:00Z');
  const s = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), builtinDir: join(ROOT, 'skills'), now: () => now });
  const body = (steps: string[]) => `# Steps\n\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n`;
  s.save('companion', { name: 'old-learned', description: 'Tidy the weekly expense report into one table.', body: body(['Open the report', 'Sum each column', 'Send the table']) }, { create: true, source: 'learned' });
  s.save('companion', { name: 'mine-made', description: 'Something I wrote myself for planning trips.', body: body(['Pick dates']) }, { create: true, source: 'made' });
  s.save('companion', { name: 'brought-in', description: 'Imported from somewhere for reviewing code.', body: body(['Read the diff']) }, { create: true, source: 'imported' });
  s.save('companion', { name: 'used-learned', description: 'Write the changelog entry for a release.', body: body(['Read the commits']) }, { create: true, source: 'learned' });
  now = new Date('2026-09-25T12:00:00Z');
  s.markUsed('companion', 'used-learned', 'auto');
  now = new Date('2026-10-01T12:00:00Z'); // 61 days after the skills were made
  assert.deepEqual(tidyCandidates(s, now).map((v) => v.name), ['old-learned']);
  const card = tidyCard(s, now)!;
  assert.deepEqual(card.archive?.names, ['old-learned']);
  assert.equal(s.get('companion', 'old-learned')!.status, 'ready', 'nothing happens without the click');
  // Keep them: not asked again this month.
  tidyAnswer(s, 'keep', now);
  assert.equal(tidyCard(s, now), undefined);
  now = new Date('2026-11-02T12:00:00Z');
  assert.deepEqual(tidyCard(s, now)?.archive?.names, ['old-learned'], 'asked again next month');
  assert.deepEqual(tidyAnswer(s, 'archive', now).archived, ['old-learned']);
  assert.equal(s.get('companion', 'old-learned')!.status, 'archived');
  assert.ok(!s.effective().some((v) => v.name === 'old-learned'), 'not in her catalog');
  assert.ok(existsSync(join(dir, 'skills', 'old-learned', 'SKILL.md')), 'kept on disk');
  s.rescan(true);
  assert.equal(s.get('companion', 'old-learned')!.status, 'archived', 'a rescan keeps it archived');
  assert.equal(s.bringBack('companion', 'old-learned').status, 'ready');
  assert.ok(s.effective().some((v) => v.name === 'old-learned'));
  // Near-duplicates (fixture vectors ≥ 0.9, most steps shared): one merge card a month; both keep versions.
  s.save('companion', { name: 'expense-table', description: 'Turn the weekly expenses into a single table.', body: body(['Open the report', 'Sum each column', 'Send the table', 'Add a total row']) }, { create: true, source: 'learned' });
  s.save('companion', { name: 'spare', description: 'Nothing like the others: water the plants.', body: body(['Fill the can']) }, { create: true, source: 'learned' });
  const vectors = new Map<string, number[]>([['companion|old-learned', [1, 0.1, 0]], ['companion|expense-table', [0.99, 0.12, 0.01]], ['companion|spare', [0, 0, 1]], ['companion|used-learned', [0, 1, 0]]]);
  const dups = nearDuplicates(s, { vectors });
  assert.equal(dups.length, 1);
  assert.deepEqual([dups[0].keep, dups[0].older], ['expense-table', 'old-learned']);
  const c2 = tidyCard(s, now, { vectors })!;
  assert.equal(c2.merge?.keep, 'expense-table');
  assert.match(c2.merge!.diff, /\+/);
  const r = tidyAnswer(s, 'merge', now, { vectors });
  assert.deepEqual(r.merged, { keep: 'expense-table', older: 'old-learned' });
  assert.equal(s.get('companion', 'old-learned')!.status, 'archived');
  const versions = (name: string) => (app.store.db.prepare('SELECT COUNT(*) AS n FROM skill_versions WHERE scope = ? AND name = ?').get('companion', name) as { n: number }).n;
  assert.ok(versions('expense-table') >= 1 && versions('old-learned') >= 1, 'both keep skill_versions rows');
  assert.equal(tidyCard(s, now, { vectors })?.merge, undefined, 'one merge card a month');
  // Built-in, imported and made skills are never offered.
  now = new Date('2027-03-01T12:00:00Z');
  const names = tidyCandidates(s, now).map((v) => v.name);
  for (const n of ['mine-made', 'brought-in']) assert.ok(!names.includes(n), n);
  assert.ok(!names.some((n) => s.get('builtin', n)));
});

test('16 · the settings row: store on by default, community off, owner-only, and the Privacy row and tip in every language', () => {
  assert.deepEqual(storeSettings({}), { on: true, community: false });
  assert.deepEqual(storeSettings({ store: { on: false, community: true } }), { on: false, community: true });
  assert.ok(OWNER_SETTINGS.includes('store' as never));
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const tip = "Once a day Sara downloads the store's public list to show add-ons and updates. The list is the same for everyone and nothing about you is sent. Off: no store, your add-ons keep working.";
  assert.ok(html.includes('id="store-on"'));
  assert.ok(html.includes(tip.replace(/'/g, "'")), 'the Privacy row has its ? tip');
  assert.ok(tip.length <= 260);
  assert.ok(SAME_OK.test('Sara Store'), 'the name stays the same in every language');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8'));
    assert.ok(typeof d[tip] === 'string' && d[tip].length <= 260, `${lang}: the tip`);
  }
  // More in the Sara Store on Plugins, Skills and Other programs (MCP); a plain link.
  assert.equal((html.match(/class="store-link" href="https:\/\/backstagecoding\.com\/sara\/store\/" target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3);
});

test('the first shelf\'s packages unpack to the content hash the review card shows', () => {
  // The same rule the publish script uses: the package is the plugin folder without shots/, icon.png and CHANGES.md.
  for (const id of ['weather-alerts', 'focus']) {
    const { pkg } = splitListing(fromFolder(join(ROOT, 'store', 'plugins', id)));
    const inner = pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png');
    const zip = zipStored(inner);
    const files = checkPackage(zip, { sha256: sha256(zip), size: zip.length, contentSha: hashFiles(inner) });
    assert.equal(hashFiles(stripTop(files).files), hashFiles(inner));
  }
});

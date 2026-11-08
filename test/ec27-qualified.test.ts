// EC27 (docs/ops/EC2527_DESIGN.md): the Qualified badge. Where and when each Store entry last passed a
// real install, from a signed sidecar (v1/qualified.json + .sig) that older Saras never read, plus the
// owner's `sara addons requalify` that folds qualify-addons-native results into store/qualified.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { shelfView, StoreClient } from '../src/store/client.ts';
import { parseIndex } from '../src/store/format.ts';
import { foldRuns, parseQualified, QUALIFIED_CHECKS, qualifiedFor, sidecarItems } from '../src/store/qualified.ts';
import { ROOT, tempDir } from './helpers.ts';

type Any = any;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'store-2026a': Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64') };
const signedBytes = (o: unknown, priv: KeyObject = privateKey) => {
  const json = Buffer.from(`${JSON.stringify(o, null, 1)}\n`);
  return { json, sig: Buffer.from(JSON.stringify({ v: 1, key: 'store-2026a', sig: sign(null, json, priv).toString('base64') })) };
};
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const HEX = (c: string) => c.repeat(64).slice(0, 64);
const NOW = new Date();
const item = (id: string, latest: string) => ({ id, kind: 'companion', name: id, summary: `${id} summary`, trust: 'first-party', category: 'companions', tags: [], author: { name: 'The Sara team', key: `ed25519:${HEX('9b')}`, since: '2026-11-07' }, rating: 'general', romance: false, latest,
  versions: [{ version: latest, sara: '>=2.60.0', published: '2026-11-07', entry: `entries/${id}/${latest}.json`, entrySha: HEX('5c'), package: `packages/${id}-${latest}.zip`, sha256: HEX('a3'), size: 1000, contentSha: HEX('77'), permissions: ['look:portrait'] }] });
const index = (seq: number) => ({ format: 'sara-store-index', v: 1, seq, generated: iso(NOW), expires: iso(new Date(NOW.getTime() + 30 * 86400_000)), key: 'store-2026a', minSara: '2.57.0', items: [item('juniper', '1.0.0'), item('rowan', '1.1.0')], blocked: [], reservedIds: ['sara'] });
const rec = { version: '1.0.0', at: '2026-11-07', sara: '2.81.0', os: { windows: 'pass', linux: 'pass' }, checks: ['install', 'add', 'retire'] };
const sidecar = (seq: number, items: Any = { juniper: rec, rowan: rec }) => ({ format: 'sara-store-qualified', v: 1, seq, items });

async function fake(t: TestContext) {
  const files = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const f = files.get(req.url ?? '');
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(f);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, files };
}

test('EC27 sidecar format: strict, tied to the list, a fixed check vocabulary', () => {
  assert.equal(parseQualified(JSON.stringify(sidecar(7)), 7).items.juniper?.sara, '2.81.0');
  assert.throws(() => parseQualified(JSON.stringify(sidecar(6)), 7), /another list/);
  assert.throws(() => parseQualified(JSON.stringify({ ...sidecar(7), extra: 1 }), 7), /unknown/);
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, record: 'docs/ops/x.md' } })), 7), /unknown/, 'the private record name never ships');
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, os: { amiga: 'pass' } } })), 7), /system/);
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, os: { linux: 'great' } } })), 7), /result/);
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, checks: ['hacked'] } })), 7), /check/);
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, at: 'yesterday' } })), 7), /date/);
  assert.throws(() => parseQualified(JSON.stringify(sidecar(7, { juniper: { ...rec, sara: '<b>2</b>' } })), 7), /version/);
  assert.ok(QUALIFIED_CHECKS.includes('install') && QUALIFIED_CHECKS.includes('signed-hash'));
});

test('EC27 the badge only for the latest version with at least one passing system', () => {
  const q = parseQualified(JSON.stringify(sidecar(7, { juniper: rec, rowan: rec, jax: { ...rec, os: { linux: 'partial' } } })), 7);
  assert.deepEqual(qualifiedFor(q, 'juniper', '1.0.0'), { at: '2026-11-07', sara: '2.81.0', pass: ['linux', 'windows'], partial: [], checks: ['install', 'add', 'retire'] });
  assert.equal(qualifiedFor(q, 'rowan', '1.1.0'), undefined, 'an update loses the badge until it is checked again');
  assert.equal(qualifiedFor(q, 'jax', '1.0.0'), undefined, 'partly only: no badge');
  assert.equal(qualifiedFor(q, 'nobody', '1.0.0'), undefined);
});

test('EC27 older Saras are unaffected: nothing new in the index', () => {
  const { index: parsed } = parseIndex(JSON.stringify(index(7)));
  assert.equal(parsed.items.length, 2);
  assert.ok(!JSON.stringify(index(7)).includes('qualified'));
});

test('EC27 the client fetches the signed sidecar after the list; Get more carries the badge; bad or missing means none', async (t) => {
  const f = await fake(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const i = signedBytes(index(7));
  f.files.set('/v1/index.json', i.json);
  f.files.set('/v1/index.sig', i.sig);
  const c = new StoreClient({ dataDir: dir, base: f.base, keys: KEYS, blocked: () => undefined });
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(c.qualified(), {});
  const q = signedBytes(sidecar(7));
  f.files.set('/v1/qualified.json', q.json);
  f.files.set('/v1/qualified.sig', q.sig);
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(Object.keys(c.qualified()), ['juniper']);
  const view = shelfView(c, { saraVersion: '2.84.0', on: true, community: false }) as { items: Any[] };
  assert.deepEqual(view.items.find((x) => x.id === 'juniper').qualified.pass, ['linux', 'windows']);
  assert.equal(view.items.find((x) => x.id === 'rowan').qualified, undefined);
  // Signed by someone else: no badges; the list itself is fine.
  const bad = signedBytes(sidecar(7), generateKeyPairSync('ed25519').privateKey);
  f.files.set('/v1/qualified.json', bad.json);
  f.files.set('/v1/qualified.sig', bad.sig);
  const fresh = new StoreClient({ dataDir: join(dir, 'b'), base: f.base, keys: KEYS, blocked: () => undefined });
  assert.equal((await fresh.check()).ok, true);
  assert.deepEqual(fresh.qualified(), {});
  // A sidecar for list 7 is not used with list 8.
  const i8 = signedBytes(index(8));
  f.files.set('/v1/index.json', i8.json);
  f.files.set('/v1/index.sig', i8.sig);
  f.files.set('/v1/qualified.json', q.json);
  f.files.set('/v1/qualified.sig', q.sig);
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(c.qualified(), {});
});

test('EC27 requalify: qualify-addons-native results fold into the records (pass, partly, dropped)', () => {
  const runs: Any[] = [
    { id: 'juniper', os: 'windows', source: 'companion-pack-file', result: 'pass', steps: { preview: { ok: true }, 'add-her': { ok: true }, retire: { ok: true }, 'store-add-1': { ok: true } } },
    { id: 'juniper', os: 'linux', source: 'companion-pack-file', result: 'pass', steps: { preview: { ok: true }, 'add-her': { ok: true }, retire: { ok: true } } },
    { id: 'github-digest', os: 'linux', source: 'signed-store', result: 'pass-lifecycle-only', steps: { install: { ok: true }, enable: { ok: true }, remove: { ok: true } } },
    { id: 'focus', os: 'linux', source: 'signed-store', result: 'fail', steps: { install: { ok: true }, 'read1:start': { ok: false } } },
    { id: 'held-thing', os: 'linux', source: 'held', result: 'pass', steps: { 'not-offered': { ok: true } } },
  ];
  const before: Any = { focus: { version: '1.0.0', at: '2026-11-01', sara: '2.79.0', os: { windows: 'pass', linux: 'pass' }, checks: ['install', 'run', 'remove'], record: 'docs/ops/Q_ADDONS_NATIVE.md' } };
  const after = foldRuns(before, runs, { at: '2026-11-08', sara: '2.84.0', versions: { juniper: '1.0.0', 'github-digest': '1.0.0', focus: '1.0.0' } });
  assert.deepEqual(after.juniper, { version: '1.0.0', at: '2026-11-08', sara: '2.84.0', os: { linux: 'pass', windows: 'pass' }, checks: ['add', 'install', 'retire'], record: 'sara addons requalify' });
  assert.deepEqual(after['github-digest']!.os, { linux: 'partial' });
  assert.deepEqual(after.focus!.os, { windows: 'pass' }, 'a failed re-run drops that system');
  assert.equal(after['held-thing'], undefined, 'held entries and ids without a listed version are not qualified');
});

// The records cite private docs/ops files, which the public export leaves out.
test('EC27 the repo records: every Store entry, parse as a sidecar, and each cites a record that names it', { skip: !existsSync(join(ROOT, 'docs', 'ops')) }, () => {
  const src = JSON.parse(readFileSync(join(ROOT, 'store', 'qualified.json'), 'utf8'));
  const ids = Object.keys(src.items);
  assert.ok(ids.length >= 52, `${ids.length} records`);
  parseQualified(JSON.stringify({ format: 'sara-store-qualified', v: 1, seq: 1, items: sidecarItems(src.items, ids) }), 1);
  for (const id of ids) {
    const r = src.items[id];
    assert.match(r.record, /^docs\/ops\/[A-Z_]+\.md$/, id);
    const doc = join(ROOT, r.record);
    assert.ok(existsSync(doc), `${id}: ${r.record}`);
    assert.ok(readFileSync(doc, 'utf8').includes(id), `${id} is named in ${r.record}`);
  }
});

test('EC27 `node scripts/addons-requalify.ts` writes the folded records and says what changed', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { dir, cleanup } = tempDir();
  try {
    const out = join(dir, 'qualified.json');
    writeFileSync(out, JSON.stringify({ about: 'x', items: { focus: { version: '1.0.0', at: '2026-11-01', sara: '2.79.0', os: { windows: 'pass' }, checks: ['install'], record: 'docs/ops/Q_ADDONS_NATIVE.md' } } }));
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index(7)));
    writeFileSync(join(dir, 'linux.json'), JSON.stringify([{ id: 'juniper', os: 'linux', source: 'signed-store', result: 'pass', steps: { 'store-add-1': { ok: true }, 'store-retire-1': { ok: true } } }]));
    const said = execFileSync(process.execPath, [join(ROOT, 'scripts', 'addons-requalify.ts'), '--from', join(dir, 'linux.json'), '--index', join(dir, 'index.json'), '--out', out, '--sara', '2.84.0', '--at', '2026-11-08'], { encoding: 'utf8' });
    assert.match(said, /juniper 1\.0\.0: Linux pass/);
    const after = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(after.about, 'x');
    assert.deepEqual(after.items.juniper.os, { linux: 'pass' });
    assert.deepEqual(after.items.juniper.checks, ['install', 'retire']);
    assert.equal(after.items.focus.at, '2026-11-01', 'records not re-run stay');
  } finally {
    cleanup();
  }
});

// Store listing translations (docs/store/SARA_STORE.md §4.7): a separate signed sidecar
// (v1/locales.json + v1/locales.sig) next to the index. Older Saras never ask for it, and the index and
// entries keep exactly the fields they refuse unknown ones on, so nothing changes for them.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { shelfView, StoreClient } from '../src/store/client.ts';
import { parseIndex } from '../src/store/format.ts';
import { LOCALE_LANGS, LOCALE_LIMITS, parseLocales } from '../src/store/locales.ts';
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
const index = (seq: number) => ({
  format: 'sara-store-index', v: 1, seq, generated: iso(NOW), expires: iso(new Date(NOW.getTime() + 30 * 86400_000)), key: 'store-2026a', minSara: '2.57.0',
  items: [{ id: 'juniper', kind: 'companion', name: 'Juniper', summary: 'A warm, cozy friend: tea, kind words and good company.', trust: 'first-party', category: 'companions', tags: [], author: { name: 'The Sara team', key: `ed25519:${HEX('9b')}`, since: '2026-11-07' }, rating: 'general', romance: false, latest: '1.0.0',
    versions: [{ version: '1.0.0', sara: '>=2.60.0', published: '2026-11-07', entry: 'entries/juniper/1.0.0.json', entrySha: HEX('5c'), package: 'packages/juniper-1.0.0.zip', sha256: HEX('a3'), size: 1000, contentSha: HEX('77'), permissions: ['look:portrait'] }] }],
  blocked: [], reservedIds: ['sara'],
});
const locales = (seq: number, extra: Any = {}) => ({ format: 'sara-store-locales', v: 1, seq, items: { juniper: { fr: { summary: 'Une amie douce et chaleureuse : du thé, des mots gentils et de la bonne compagnie.', description: 'Juniper est une amie douce.' } } }, ...extra });

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

test('the sidecar format: five languages, bounded text, the index seq it belongs to; anything else refused', () => {
  assert.deepEqual([...LOCALE_LANGS], ['es', 'fr', 'de', 'pt-BR', 'it']);
  assert.equal(parseLocales(JSON.stringify(locales(7)), 7).items.juniper?.fr?.summary.startsWith('Une amie'), true);
  assert.throws(() => parseLocales(JSON.stringify(locales(6)), 7), /another list/);
  assert.throws(() => parseLocales(JSON.stringify({ ...locales(7), items: { juniper: { xx: { summary: 'x' } } } }), 7), /language/);
  assert.throws(() => parseLocales(JSON.stringify({ ...locales(7), items: { juniper: { fr: { summary: 'x'.repeat(LOCALE_LIMITS.summary + 1) } } } }), 7), /too long/);
  assert.throws(() => parseLocales(JSON.stringify({ ...locales(7), items: { juniper: { fr: { summary: 'x', script: 'y' } } } }), 7), /unknown/);
  assert.throws(() => parseLocales(JSON.stringify(locales(7, { extra: 1 })), 7), /unknown/);
});

test('older Saras are unaffected: the index carries no translation field and parses as before', () => {
  const { index: parsed } = parseIndex(JSON.stringify(index(7)));
  assert.equal(parsed.items[0].summary, 'A warm, cozy friend: tea, kind words and good company.');
  assert.ok(!JSON.stringify(index(7)).includes('locales'));
});

test('the client fetches the signed sidecar after the list; Get more shows the owner\'s language; a bad or missing sidecar only means English', async (t) => {
  const f = await fake(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const i = signedBytes(index(7));
  f.files.set('/v1/index.json', i.json);
  f.files.set('/v1/index.sig', i.sig);
  const c = new StoreClient({ dataDir: dir, base: f.base, keys: KEYS, blocked: () => undefined });
  // No sidecar published (the live Store today): the check is fine, everything stays English.
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(c.translations('fr'), {});
  const l = signedBytes(locales(7));
  f.files.set('/v1/locales.json', l.json);
  f.files.set('/v1/locales.sig', l.sig);
  assert.equal((await c.check()).ok, true);
  assert.equal(c.translations('fr').juniper?.summary.startsWith('Une amie'), true);
  assert.deepEqual(c.translations('en'), {}, 'English is the list itself');
  assert.deepEqual(c.translations('de'), {}, 'no German line: the English one');
  const view = shelfView(c, { saraVersion: '2.82.0', on: true, community: false, lang: 'fr' }) as { items: Any[] };
  assert.equal(view.items[0].summary.startsWith('Une amie'), true, 'Get more shows the translated tagline');
  const en = shelfView(c, { saraVersion: '2.82.0', on: true, community: false, lang: 'en' }) as { items: Any[] };
  assert.equal(en.items[0].summary, 'A warm, cozy friend: tea, kind words and good company.');
  // Signed by someone else: refused, English again (the list itself is untouched).
  const other = generateKeyPairSync('ed25519').privateKey;
  const bad = signedBytes(locales(7, { items: { juniper: { fr: { summary: 'Piégé.' } } } }), other);
  f.files.set('/v1/locales.json', bad.json);
  f.files.set('/v1/locales.sig', bad.sig);
  const fresh = new StoreClient({ dataDir: join(dir, 'b'), base: f.base, keys: KEYS, blocked: () => undefined });
  assert.equal((await fresh.check()).ok, true, 'a bad sidecar never fails the list');
  assert.deepEqual(fresh.translations('fr'), {});
  // A sidecar for an older list is not used with a newer one.
  const i8 = signedBytes(index(8));
  f.files.set('/v1/index.json', i8.json);
  f.files.set('/v1/index.sig', i8.sig);
  f.files.set('/v1/locales.json', l.json);
  f.files.set('/v1/locales.sig', l.sig);
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(c.translations('fr'), {}, 'seq 7 translations are not shown with list 8');
});

test('the repo\'s companion translations: every first-party companion, five languages, tagline and description, placeholders kept, within the limits', () => {
  const src = JSON.parse(readFileSync(join(ROOT, 'store', 'locales.json'), 'utf8'));
  const ids = readdirSync(join(ROOT, 'store', 'companions')).sort();
  assert.equal(ids.length, 21);
  assert.deepEqual(Object.keys(src.items).sort(), ids);
  parseLocales(JSON.stringify({ format: 'sara-store-locales', v: 1, seq: 1, items: src.items }), 1);
  for (const id of ids) {
    const persona = JSON.parse(readFileSync(join(ROOT, 'store', 'companions', id, 'persona.json'), 'utf8'));
    for (const lang of LOCALE_LANGS) {
      const tr = src.items[id][lang];
      assert.ok(tr?.summary && tr?.description, `${id} ${lang}`);
      assert.equal(tr.description.includes('{{user}}'), persona.summary.includes('{{user}}'), `${id} ${lang}: {{user}} kept`);
      assert.notEqual(tr.summary, JSON.parse(readFileSync(join(ROOT, 'store', 'companions', id, 'sara-companion.json'), 'utf8')).summary, `${id} ${lang}: translated`);
    }
  }
});

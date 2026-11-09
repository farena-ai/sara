// Store listing translations (docs/store/SARA_STORE.md §4.7): a separate signed sidecar
// (v1/locales.json + v1/locales.sig) next to the index. Older Saras never ask for it, and the index and
// entries keep exactly the fields they refuse unknown ones on, so nothing changes for them.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { shelfView, StoreClient } from '../src/store/client.ts';
import { parseIndex } from '../src/store/format.ts';
import { LOCALE_LANGS, LOCALE_LIMITS, parseLocales, parseLocalesExtra, translateLineParams } from '../src/store/locales.ts';
import { buildLocalesExtra } from '../scripts/store-locales-extra.ts';
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
  for (const id of ids) assert.ok(src.items[id], id);
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

// Store sequence 8: plugins and tool servers.
const pluginIds = () => readdirSync(join(ROOT, 'store', 'plugins')).filter((d) => existsSync(join(ROOT, 'store', 'plugins', d, 'sara-plugin.json'))).sort();
const mcpIds = () => readdirSync(join(ROOT, 'store', 'mcp')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const recipe = (id: string) => JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', `${id}.json`), 'utf8'));
const manifest = (id: string) => JSON.parse(readFileSync(join(ROOT, 'store', 'plugins', id, 'sara-plugin.json'), 'utf8'));

test('the repo\'s plugin and tool-server translations: every one, five languages, tagline and description, translated, in the v1 format older Saras read', () => {
  const src = JSON.parse(readFileSync(join(ROOT, 'store', 'locales.json'), 'utf8'));
  const all = [...pluginIds(), ...mcpIds()];
  assert.ok(all.length >= 50, 'the shelf has its plugins and tool servers');
  const companions = readdirSync(join(ROOT, 'store', 'companions'));
  assert.deepEqual(Object.keys(src.items).sort(), [...companions, ...all].sort(), 'nothing else, nothing missing');
  // The exact v1 shape: summary + description only (2.83 to 3.0.2 refuse any other field and would drop every translation).
  parseLocales(JSON.stringify({ format: 'sara-store-locales', v: 1, seq: 1, items: src.items }), 1);
  for (const id of all) {
    const en = pluginIds().includes(id) ? manifest(id).description : recipe(id).description;
    for (const lang of LOCALE_LANGS) {
      const tr = src.items[id][lang];
      assert.ok(tr?.summary && tr?.description, `${id} ${lang}`);
      assert.notEqual(tr.description, en, `${id} ${lang}: translated`);
      assert.ok(tr.summary.length <= LOCALE_LIMITS.summary, `${id} ${lang}: short tagline`);
    }
    // Product and format names stay as they are.
    for (const word of ['ComfyUI', 'Blender', 'Playwright', 'GitHub', 'SPDX', 'CycloneDX', 'OpenAPI', 'SQLite', 'Home Assistant']) {
      if (src.items[id].es.description.includes(word)) for (const lang of LOCALE_LANGS) assert.ok(`${src.items[id][lang].summary} ${src.items[id][lang].description}`.includes(word), `${id} ${lang}: ${word} kept`);
    }
  }
});

test('the extra sidecar source: about paragraphs line up with the recipe, tags and permission-line words come from the real listing', () => {
  const src = JSON.parse(readFileSync(join(ROOT, 'store', 'locales-extra.json'), 'utf8'));
  parseLocalesExtra(JSON.stringify({ format: 'sara-store-locales-extra', v: 1, seq: 3, items: src.items }), 3);
  const loc = JSON.parse(readFileSync(join(ROOT, 'store', 'locales.json'), 'utf8'));
  for (const [id, langs] of Object.entries(src.items as Record<string, Record<string, Any>>)) {
    const isMcp = mcpIds().includes(id);
    assert.ok(isMcp || pluginIds().includes(id), id);
    const english = new Set<string>();
    if (isMcp) {
      const r = recipe(id);
      for (const x of r.mcp.reaches ?? []) english.add(x);
      for (const f of [...(r.mcp.fields ?? []), ...(r.mcp.secrets ?? [])]) english.add(f.label);
    } else for (const st of manifest(id).settings ?? []) english.add(st.label);
    for (const lang of LOCALE_LANGS) {
      const x = langs[lang];
      assert.ok(x, `${id} ${lang}`);
      if (x.about) {
        assert.equal(x.about.length, recipe(id).about.length, `${id} ${lang}: one translation per about paragraph`);
        assert.equal(x.about[0], loc.items[id][lang].description, `${id} ${lang}: the first paragraph is the v1 description`);
      }
      for (const [en, tr] of Object.entries((x.terms ?? {}) as Record<string, string>)) {
        assert.ok(english.has(en), `${id} ${lang}: ${en} is a word the listing really uses`);
        assert.notEqual(tr, en);
      }
      if (x.tags) assert.equal(x.tags.length, (isMcp ? recipe(id).tags : x.tags).length);
    }
  }
  for (const id of ['comfyui', 'blender', 'playwright', 'github', 'filesystem', 'context7']) assert.ok(src.items[id]?.de?.about, `${id}: the live tool servers have every paragraph`);
});

test('the extra sidecar: signed and tied to the list; Get more search and the item page words use it; old v1 files can\'t carry it', async (t) => {
  // Why a second file: the v1 parser (2.83 to 3.0.2) refuses these fields outright.
  assert.throws(() => parseLocales(JSON.stringify(locales(7, { items: { juniper: { fr: { summary: 'x', tags: ['y'] } } } })), 7), /unknown/);
  const extra = (seq: number) => ({ format: 'sara-store-locales-extra', v: 1, seq, items: { juniper: { fr: { tags: ['thé', 'douceur'], about: ['Juniper est une amie douce.'], terms: { 'Your city': 'Votre ville' } } } } });
  assert.throws(() => parseLocalesExtra(JSON.stringify(extra(6)), 7), /another list/);
  assert.throws(() => parseLocalesExtra(JSON.stringify({ ...extra(7), items: { juniper: { fr: { tags: ['<b>'] } } } }), 7), /markup/);
  assert.throws(() => parseLocalesExtra(JSON.stringify({ ...extra(7), items: { juniper: { fr: { script: 'x' } } } }), 7), /unknown/);
  assert.throws(() => parseLocalesExtra(JSON.stringify({ ...extra(7), items: { juniper: { fr: { tags: [] } } } }), 7), /short list/);
  const f = await fake(t);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const i = signedBytes(index(7));
  f.files.set('/v1/index.json', i.json);
  f.files.set('/v1/index.sig', i.sig);
  const x = signedBytes(extra(7));
  f.files.set('/v1/locales-extra.json', x.json);
  f.files.set('/v1/locales-extra.sig', x.sig);
  const c = new StoreClient({ dataDir: dir, base: f.base, keys: KEYS, blocked: () => undefined });
  assert.equal((await c.check()).ok, true);
  assert.deepEqual(c.translationsExtra('fr').juniper?.tags, ['thé', 'douceur']);
  assert.deepEqual(c.translationsExtra('fr-CA').juniper?.tags, ['thé', 'douceur'], 'fr-CA reads fr');
  assert.deepEqual(c.translationsExtra('en'), {});
  const view = shelfView(c, { saraVersion: '2.82.0', on: true, community: false, lang: 'fr' }) as { items: Any[] };
  assert.deepEqual(view.items[0].tags, ['thé', 'douceur'], 'search finds the translated words too');
  // Signed by someone else: not used, the check still passes.
  const bad = signedBytes(extra(7), generateKeyPairSync('ed25519').privateKey);
  f.files.set('/v1/locales-extra.sig', bad.sig);
  const fresh = new StoreClient({ dataDir: join(dir, 'b'), base: f.base, keys: KEYS, blocked: () => undefined });
  assert.equal((await fresh.check()).ok, true);
  assert.deepEqual(fresh.translationsExtra('fr'), {});
  // The words in a permission line: labels (also a comma list) swap; commands and unknown words stay.
  const terms = { 'Minutes of focus': 'Minutes de concentration', 'Minutes of break': 'Minutes de pause', 'ComfyUI address': 'Adresse de ComfyUI' };
  assert.equal(translateLineParams({ key: 'Has its own settings: {names}', params: { names: 'Minutes of focus, Minutes of break' } }, terms).params.names, 'Minutes de concentration, Minutes de pause');
  assert.equal(translateLineParams({ key: 'Asks you for: {label}', params: { label: 'ComfyUI address' } }, terms).params.label, 'Adresse de ComfyUI');
  assert.equal(translateLineParams({ key: 'Runs a program on this computer: {command}', params: { command: 'npx -y comfyui-mcp@0.52.206' } }, terms).params.command, 'npx -y comfyui-mcp@0.52.206');
  assert.equal(translateLineParams({ key: 'Can use her model up to {n} times a day (billed to you)', params: { n: 5 } }, terms).params.n, 5);
});

test('scripts/store-locales-extra.ts signs the sidecar for the list the publisher built (and only its items); a foreign list is refused', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'v1'), { recursive: true });
  const i = signedBytes({ ...index(8), items: [{ ...index(8).items[0], id: 'focus' }] });
  writeFileSync(join(dir, 'v1', 'index.json'), i.json);
  writeFileSync(join(dir, 'v1', 'index.sig'), i.sig);
  const checked = buildLocalesExtra({ out: dir, publicKeys: KEYS, checkOnly: true });
  assert.equal(checked.seq, 8);
  assert.equal(checked.items, 1, 'only the listed item (focus), not every source entry');
  assert.equal(existsSync(join(dir, 'v1', 'locales-extra.json')), false, '--check-only writes nothing');
  const r = buildLocalesExtra({ out: dir, publicKeys: KEYS, key: privateKey });
  assert.deepEqual(r.written, ['v1/locales-extra.json', 'v1/locales-extra.sig']);
  const parsed = parseLocalesExtra(readFileSync(join(dir, 'v1', 'locales-extra.json'), 'utf8'), 8);
  assert.equal(parsed.items.focus?.de?.terms?.['Minutes of focus'], 'Minuten Konzentration');
  const sig = JSON.parse(readFileSync(join(dir, 'v1', 'locales-extra.sig'), 'utf8'));
  assert.equal(sig.key, 'store-2026a');
  // An index signed by a key Sara doesn't ship: refused before anything is signed.
  const foreign = signedBytes(index(9), generateKeyPairSync('ed25519').privateKey);
  writeFileSync(join(dir, 'v1', 'index.json'), foreign.json);
  writeFileSync(join(dir, 'v1', 'index.sig'), foreign.sig);
  assert.throws(() => buildLocalesExtra({ out: dir, publicKeys: KEYS, key: privateKey }));
});

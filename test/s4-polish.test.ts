// S4, the polish pass after 3.40.0: the Meaning search row lists embedding models (not chat models)
// and says Off; a new install is not told its backups are old; "Usage and costs" names each part
// once in "On this page"; and the Meaning search row says when she has stopped asking a slow model.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelCatalog } from '../src/model-catalog.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { SettingsStore } from '../src/settings.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('S4 models: a provider\'s list names its embedding models apart from the ones to chat with', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-s4-'));
  const settings = new SettingsStore(dir);
  const config: ProviderConfig = { id: 'p', label: 'Prov', kind: 'openai-compatible', baseUrl: 'http://p/v1' };
  settings.update({ providers: [config] });
  const provider = {
    config,
    listModels: async () => ['qwen3:8b', 'nomic-embed-text:latest', 'bge-m3:latest', 'gemma4:12b'],
    async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {},
  } as unknown as Provider;
  const catalog = new ModelCatalog(dir, { settings, providerFor: () => provider, now: () => new Date('2026-11-24T12:00:00Z'), fetch: async () => new Response('no', { status: 404 }) });
  const v = await catalog.refresh('p');
  assert.deepEqual(v.embedding, ['bge-m3:latest', 'nomic-embed-text:latest']);
  assert.deepEqual([...v.models].sort(), ['gemma4:12b', 'qwen3:8b'], 'and they are not offered for chatting');
  assert.equal(v.hidden, 2);
  assert.deepEqual([...catalog.present('p')].sort(), ['bge-m3:latest', 'gemma4:12b', 'nomic-embed-text:latest', 'qwen3:8b']);
});

test('S4 page: the Meaning search row asks for embedding models and its empty choice is Off', () => {
  const js = read('web', 'app.js');
  assert.match(js, /j\.id === 'embeddings' \? \{ kind: 'embedding', blank: t\('Off'\) \} : \{\}/);
  assert.match(js, /kind === 'embedding' \? \{ \.\.\.all, models: all\.embedding \?\? \[\]/);
  assert.match(js, /info\?\.meaningResting \? t\('This model has been answering slowly/);
  assert.match(read('src', 'routes', 'models.ts'), /meaningResting: app\.toolMeaning\?\.resting === true/);
});

test('S4 words: no backup yet is not "more than 2 days old"; every new string is in all five languages', () => {
  const check = read('src', 'safety-check.ts');
  assert.match(check, /back\?\.detail === 'no backups yet' \? T\(en\('Automatic backups are on; the first one has not been made yet\.'\)\)/);
  assert.match(read('src', 'doctor.ts'), /'no backups yet'/, 'the words the check looks for are the ones the health row writes');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(read('web', 'i18n', `${lang}.json`)) as Record<string, string>;
    for (const key of ['Automatic backups are on; the first one has not been made yet.', 'A limit for each reply']) assert.ok(d[key] && d[key] !== key, `${lang}: ${key}`);
  }
});

test('S4 page: "Usage and costs" has one part called Budgets, and its limits are in "On this page"', () => {
  const html = read('web', 'index.html');
  const titles = [...html.matchAll(/class="settings-page" data-page="([^"]+)"[^>]*data-title="([^"]+)"[^>]*>/g)].filter((m) => m[1] === 'dh-usage' || /data-host="dh-usage"/.test(m[0])).map((m) => m[2]);
  assert.ok(titles.includes('A limit for each reply'));
  assert.ok(!titles.includes('Budgets'), 'the part that sets a ceiling per reply is not a second "Budgets"');
  assert.match(read('web', 'settings-look.js'), /:scope > \.s3-card > \.sp-box > h3/);
});

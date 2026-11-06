import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PUBLIC_NATIVE_CANDIDATES, PUBLIC_MCP_INVESTIGATIONS, PUBLIC_GUIDED_PACKS } from '../src/addons/discovery.ts';
import { allKeys, LANGS, loadLang, norm, placeholders, wanted } from '../scripts/i18n-extract.ts';

// These fields are displayed through dynamic t(value) calls. Keeping this contract
// beside the public model prevents a newly added recipe/limit silently falling back to English.
function displayKeys(): string[] {
  const keys = new Set<string>();
  const add = (...values: string[]) => values.forEach(value => keys.add(norm(value)));
  for (const item of [...PUBLIC_NATIVE_CANDIDATES, ...PUBLIC_MCP_INVESTIGATIONS]) {
    add(item.name, item.summary, item.description, item.qualification, item.cost, item.privacy,
      ...item.prerequisites, ...item.permissions, ...item.limitations);
  }
  for (const item of PUBLIC_MCP_INVESTIGATIONS) {
    const preview = item.recipePreview;
    if (!preview) continue;
    add(...preview.guide, ...preview.secrets.map(secret => secret.purpose));
    if (preview.transport === 'stdio') {
      add(...preview.environment.map(variable => variable.purpose), ...preview.substitutions.map(value => value.purpose));
    }
  }
  for (const pack of PUBLIC_GUIDED_PACKS) add(pack.name, pack.summary, pack.description, ...pack.setup, pack.privacy, pack.cost);
  // Product names remain exact, as do commands, identifiers and other technical tokens.
  const products = new Set(['Atlassian Jira / Confluence', 'Chrome DevTools', 'Cloudflare', 'DBHub', 'Docker MCP Toolkit', 'Figma', 'Firecrawl', 'GitLab', 'Google Workspace', 'Linear', 'MarkItDown', 'Microsoft 365', 'Obsidian', 'Sentry', 'Serena', 'Supabase', 'draw.io']);
  return [...keys].filter(key => wanted(key) && !products.has(key) && key !== 'Sara >=2.65.0 / Node >=24');
}

test('public add-on display prose participates in the existing extraction contract', () => {
  const extracted = allKeys();
  const missing = displayKeys().filter(key => !extracted.has(key));
  assert.deepEqual(missing, [], `Dynamic add-on display text missing from the translation inventory: ${missing.join('\n')}`);
});

for (const language of LANGS) test(`public add-on display prose is available in ${language}`, () => {
  const dictionary = loadLang(language);
  const missing = displayKeys().filter(key => typeof dictionary[key] !== 'string' || !dictionary[key].trim());
  assert.deepEqual(missing, [], `Missing ${language} add-on translations: ${missing.join('\n')}`);
  for (const key of displayKeys()) {
    assert.deepEqual(placeholders(dictionary[key]), placeholders(key), `${language}: ${key}`);
    const numbers = (value: string) => value.match(/\d+(?:\.\d+)*/g) ?? [];
    assert.deepEqual(numbers(dictionary[key]), numbers(key), `Numeric limits/version tokens must remain exact in ${language}: ${key}`);
    if (key.includes(' ') && /[.!?]/.test(key)) assert.notEqual(dictionary[key], key, `Untranslated ${language} sentence: ${key}`);
  }
});

test('Daily briefing translations deny live account reads, including manual reads', () => {
  const description = PUBLIC_NATIVE_CANDIDATES.find(item => item.id === 'daily-briefing')!.description;
  assert.match(description, /No live account reads\./);
  // Match the capability denial, rather than merely prohibiting automatic access.
  // These are clause-level language checks; the surrounding prose may be polished freely.
  const clauses = {
    es: /Sin lecturas? de (?:datos de )?cuentas? en tiempo real\./i,
    fr: /Aucune lecture de (?:données de )?comptes en temps réel\./i,
    de: /Keine Live-(?:Abfragen|Zugriffe) von Konten\./i,
    'pt-BR': /Sem leitura de (?:dados de )?contas em tempo real\./i,
    it: /Nessuna lettura di (?:dati degli )?account in tempo reale\./i,
  };
  for (const language of LANGS) assert.match(loadLang(language)[description], clauses[language], `${language}: no live account-reading capability`);
});

test('German MCP guidance describes a server annotation, not an enforced write protection', () => {
  const key = PUBLIC_MCP_INVESTIGATIONS.flatMap(item => item.permissions)
    .find(line => line.startsWith('Sara can auto-allow server-annotated read-only tools;'));
  assert.ok(key, 'The server-annotation admission limitation must remain in the public recipe guidance.');
  const translated = loadLang('de')[key];
  assert.match(translated, /vom Server als schreibgeschützt gekennzeichnete Werkzeuge/i);
  assert.match(translated, /automatisch erlauben/i);
  assert.match(translated, /Rezepthinweise allein erzwingen keine Freigabe\./i);
});

// Public manager/Store refusals reach the UI as dynamic error/held strings rather
// than literal t() calls. Keep this small list limited to the new authority paths.
const runtimeMessages = [
  'That plugin is changing. Try again when it finishes.',
  'That plugin changed after you reviewed it. Add it again for a fresh review.',
  'That plugin changed while it was stopping. Add it again for a fresh review.',
  'The plugin commit callback must be synchronous.',
  'A local candidate cannot change installation source. Remove it first, then review the new source.',
  'This installation source does not allow a Sara Store update. Review it from its own card.',
  'Unknown local workflow candidate.',
  'This local workflow candidate is missing or changed. Restore the supplied package before reviewing it.',
  'The kept version has different files. Review a new version number instead.',
  'That review expired or was cancelled. Add the plugin again.',
  'This is a local candidate. Review its updates in Plugins. Remove it before choosing a different source.',
  'The saved store association no longer matches the installed plugin. Remove the stale association before installing again.',
  'The plugin store association is unavailable. Try again later.',
  'The saved store association changed. Review the installed plugin again.',
  'The earlier plugin does not match a verified store release. Use its Plugins card to roll back.',
  'The saved store association no longer matches the installed plugin.',
];
test('public add-on authority refusals and held reasons are translated', () => {
  const sources = ['../src/plugins/manager.ts', '../src/store/client.ts', '../src/store/install.ts']
    .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  const extracted = allKeys();
  for (const key of runtimeMessages) {
    assert.ok(sources.includes(key), `Runtime wording changed; reconcile its translations: ${key}`);
    assert.ok(extracted.has(key), `Dynamic public refusal missing from extraction: ${key}`);
    for (const language of LANGS) {
      const translated = loadLang(language)[key];
      assert.ok(typeof translated === 'string' && translated.trim(), `${language}: ${key}`);
      assert.notEqual(translated, key, `${language}: ${key}`);
    }
  }
});

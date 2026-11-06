import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO_OUTPUTS_READONLY } from './repo-outputs.ts';

const implementation = new URL('../scripts/package-addons.ts', import.meta.url);

test('add-on bundle refuses an output outside the isolated outputs directory', async () => {
  assert.ok(existsSync(implementation), 'The safe add-on packager must exist before distribution.');
  const { assertBundleOutput } = await import(implementation.href);
  assert.throws(() => assertBundleOutput('store/plugins'), /outputs/);
  assert.throws(() => assertBundleOutput('outputs'), /dedicated/);
  assert.throws(() => assertBundleOutput('outputs/../plugins'), /outputs/);
  assert.doesNotThrow(() => assertBundleOutput('outputs/addons/bundle-test'));
});

test('add-on bundle runs real package smoke and hashes the exact distributable bytes', { skip: REPO_OUTPUTS_READONLY }, async () => {
  const api = await import(implementation.href);
  assert.equal(typeof api.buildAddonBundle, 'function', 'A bundle must execute the existing Sara package checks.');
  mkdirSync(new URL('../outputs/addons/', import.meta.url), { recursive: true });
  const output = mkdtempSync(fileURLToPath(new URL('../outputs/addons/bundle-fixture-', import.meta.url)));
  try {
    const result = await api.buildAddonBundle({ output, pluginIds: ['focus'], recipeIds: [] });
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0].id, 'focus');
    assert.equal(result.plugins[0].smoke, 'ran');
    assert.equal(result.plugins[0].ready, true);
    const { createHash } = await import('node:crypto');
    const bytes = readFileSync(join(output, result.plugins[0].file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.plugins[0].sha256);
    assert.equal(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), `${result.plugins[0].sha256}  ${result.plugins[0].file}\n`);
    assert.equal(JSON.parse(readFileSync(join(output, 'bundle.json'), 'utf8')).published, false);
    await assert.rejects(() => api.buildAddonBundle({ output, pluginIds: ['focus'], recipeIds: [] }), /new or empty/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('artifact versions are rejected rather than normalized into unsafe filenames', async () => {
  const api = await import(implementation.href);
  assert.equal(typeof api.artifactName, 'function', 'Artifact basenames need strict independent validation.');
  assert.equal(api.artifactName('focus', '1.0.0'), 'focus-1.0.0.sarapack.zip');
  for (const version of ['1.0.0\n', ' 1.0.0', '1.0.0\r', '1.0.0/../other', `1.0.0-${'a'.repeat(260)}`, null]) {
    assert.throws(() => api.artifactName('focus', version), /version|filename/i);
  }
});

test('an invalid second package version fails before smoke or distribution writes', { skip: REPO_OUTPUTS_READONLY }, async () => {
  const api = await import(implementation.href);
  const parent = fileURLToPath(new URL('../outputs/addons/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'bundle-preflight-'));
  const output = join(root, 'outputs', 'candidate');
  try {
    writeFileSync(join(root, 'package.json'), readFileSync(new URL('../package.json', import.meta.url)));
    for (const [id, version] of [['first', '1.0.0'], ['second', '1.0.0\n']]) {
      const folder = join(root, 'store', 'plugins', id); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'sara-plugin.json'), JSON.stringify({ id, version }));
    }
    await assert.rejects(() => api.buildAddonBundle({ root, output, pluginIds: ['first', 'second'] }), /version|filename/i);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

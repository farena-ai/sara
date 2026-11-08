// scripts/qualify-addons-native.mjs, the signed-Store path: the version whose download hash it checks
// is the index's `latest`, never simply the last one listed (the index lists the newest first, so
// .at(-1) was the OLDEST and a plugin with two versions, data-contract-validator 1.0.1, wrongly failed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestVersion } from '../scripts/store-latest.ts';

const item = (latest: string, versions: string[]) => ({ id: 'data-contract-validator', latest, versions: versions.map((version) => ({ version, sha256: `sha-${version}`, package: `packages/data-contract-validator-${version}.zip` })) });

test('the Store check uses the index\'s latest version, in whatever order the versions are listed', () => {
  assert.equal(latestVersion(item('1.0.1', ['1.0.1', '1.0.0'])).sha256, 'sha-1.0.1', 'newest first (the publisher\'s order)');
  assert.equal(latestVersion(item('1.0.1', ['1.0.0', '1.0.1'])).sha256, 'sha-1.0.1', 'oldest first');
  assert.equal(latestVersion(item('1.0.0', ['1.0.0'])).version, '1.0.0', 'one version');
});

test('an index whose latest is not among its versions is refused, not silently checked against another version', () => {
  assert.throws(() => latestVersion(item('2.0.0', ['1.0.1', '1.0.0'])), /latest 2\.0\.0 is not in its versions/);
  assert.throws(() => latestVersion(undefined), /not in the signed index/);
});

test('the qualification script itself picks the version through latestVersion', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/qualify-addons-native.mjs', import.meta.url), 'utf8');
  assert.ok(!/versions\.at\(-1\)/.test(src), 'no .at(-1) version pick');
  assert.match(src, /latestVersion\(item\)/);
});

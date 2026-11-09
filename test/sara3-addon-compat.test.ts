// Sara 3.0 changed the look, not the add-on interface: add-ons and store items written for 2.x
// (many declare "sara": ">=2.68.0 <3.0.0") keep installing, loading and listing on 3.x.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseManifest, satisfies, saraSatisfies } from '../src/plugins/manifest.ts';
import { ROOT } from './helpers.ts';

test('a <3.0.0 cap still accepts Sara 3.x; floors and other caps stay strict', () => {
  assert.equal(saraSatisfies('3.0.0', '>=2.68.0 <3.0.0'), true);
  assert.equal(saraSatisfies('3.4.1', '>=2.70.0 <3.0.0'), true);
  assert.equal(saraSatisfies('3.0.0', '>=2.68.0 <3'), true);
  assert.equal(saraSatisfies('4.0.0', '>=2.68.0 <3.0.0'), false, 'not past 3.x');
  assert.equal(saraSatisfies('2.60.0', '>=2.68.0 <3.0.0'), false, 'floor still applies');
  assert.equal(saraSatisfies('3.0.0', '>=3.1.0'), false);
  assert.equal(saraSatisfies('3.0.0', '>=2.68.0 <2.90.0'), false, 'a deliberate lower cap is kept');
  assert.equal(saraSatisfies('2.88.0', '>=2.68.0 <3.0.0'), true);
  assert.equal(saraSatisfies('3.0.0', '>=2.57.0'), true);
  // The plain matcher (also used for pack and add-on versions) is unchanged.
  assert.equal(satisfies('3.0.0', '>=2.68.0 <3.0.0'), false);
});

test('every bundled add-on manifest reads on Sara 3.0.0', () => {
  const dirs = JSON.parse(readFileSync(join(ROOT, 'docs/ops/A2_INVENTORY.json'), 'utf8'));
  assert.ok(dirs);
  for (const id of ['secret-scanner', 'documentation-doctor', 'test-doctor']) {
    const raw = readFileSync(join(ROOT, 'store/plugins', id, 'sara-plugin.json'), 'utf8');
    assert.doesNotThrow(() => parseManifest(raw, { saraVersion: '3.0.0' }), id);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (name: string) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
test('discovery stays inside existing Settings and uses separate inert regions', () => {
  const html = read('index.html');
  assert.match(html, /id="plg-discovery"/);
  assert.match(html, /id="mcp-discovery"/);
  assert.equal((html.match(/data-page="ab-plugins"/g) ?? []).length, 1);
  assert.equal((html.match(/data-page="ab-mcp"/g) ?? []).length, 1);
  assert.match(read('plugins.js'), /body: \{ candidate: id \}/);
  assert.match(read('app.js'), /loadMcpDiscovery/);
});
test('discovery module uses safe DOM, inert filters and explicit manual MCP limits', () => {
  const js = read('addons-discovery.js');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|\.style\s*=/);
  assert.match(js, /textContent/);
  assert.match(js, /noauto/);
  assert.match(js, /nodirty/);
  assert.match(js, /read-only annotations/);
  assert.match(js, /save, leave this page, reopen/);
  assert.match(js, /OAuth/);
  assert.doesNotMatch(js, /method: ['"](?:POST|PUT|DELETE)['"]/);
});
test('Store candidate and stale-association holds have priority over install and update actions', () => {
  const js = read('store.js');
  assert.match(js, /if \(i\.installHeld\)/);
  assert.match(js, /if \(r\.installHeld\)/);
  assert.match(js, /!a\.installHeld && a\.update/);
  assert.match(js, /candidate: \(\) => t\('Local workflow candidate'\)/);
  assert.match(js, /Forget stale store record/);
});

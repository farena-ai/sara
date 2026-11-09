// B2 fixes 5 and 6 (owner report): the edit form of a Store-installed tool server looked empty although
// its ComfyUI address was saved in the vault, so he re-entered it as an "HTTP server" pointing at
// ComfyUI's web page (MCP HTTP 405). The list now carries the recipe's fields with their saved values
// (secrets only as "saved"), an edit keeps vault values unless changed, and the transport stays the recipe's.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { mcpSecrets } from '../src/integrations.ts';
import { createSaraServer } from '../src/server.ts';
import { StoreInstalls } from '../src/store/installs.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T08:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';

const RECIPE = {
  transport: 'stdio', name: 'comfyui', command: 'npx', args: ['-y', 'comfyui-mcp@0.52.206'],
  fields: [{ key: 'COMFYUI_URL', kind: 'url', label: 'ComfyUI address', default: 'http://127.0.0.1:8188', where: 'local', tip: 'Where ComfyUI is running.' }],
  secrets: [{ key: 'COMFY_TOKEN', kind: 'secret', label: 'Access token', optional: true, tip: 'A token if your ComfyUI needs one.' }],
  reaches: [], tools: { readOnly: [], ask: [] }, needs: [], guide: [], version: '1.0.0',
};
const URL1 = 'http://comfy-pc.example:8188/';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const installs = new StoreInstalls(app.store.db);
  app.storeInstalls = installs;
  installs.upsert({ item: 'comfyui', kind: 'mcp', version: '1.0.0', trust: 'first-party', local_ref: 'comfyui', content_sha: null, entry_sha: 'x', recipe: JSON.stringify(RECIPE), installed_at: clock.now.toISOString(), updated_at: clock.now.toISOString() } as never);
  app.vault.set('mcp:comfyui', JSON.stringify({ env: { COMFYUI_URL: URL1, COMFY_TOKEN: 'tok-secret-1' }, headers: {} }));
  app.settings.update({ mcpServers: [{ name: 'comfyui', transport: 'stdio', command: 'npx', args: ['-y', 'comfyui-mcp@0.52.206'], enabled: false }] } as never);
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

test('B2 fix 5: the list shows a recipe server’s saved field values; secrets only as saved', async () => {
  const list = await (await call('/api/mcp')).json();
  const m = list.find((x: { name: string }) => x.name === 'comfyui');
  assert.equal(m.recipe?.item, 'comfyui');
  const url = m.recipe.fields.find((f: { key: string }) => f.key === 'COMFYUI_URL');
  assert.equal(url.value, URL1);
  assert.equal(url.label, 'ComfyUI address');
  const tok = m.recipe.fields.find((f: { key: string }) => f.key === 'COMFY_TOKEN');
  assert.equal(tok.secret, true);
  assert.equal(tok.saved, true);
  assert.equal(tok.value, undefined);
  assert.doesNotMatch(JSON.stringify(list), /tok-secret-1/);
});

test('B2 fix 5: editing a recipe server keeps vault values unless changed', async () => {
  // Only "enabled" changes: the address and the token stay.
  let res = await call('/api/mcp/comfyui', 'PUT', { fields: {}, enabled: false });
  assert.equal(res.status, 200, await res.clone().text());
  let sec = mcpSecrets(app.vault, 'comfyui');
  assert.equal(sec.env?.COMFYUI_URL, URL1);
  assert.equal(sec.env?.COMFY_TOKEN, 'tok-secret-1');
  // A new address replaces the old one; the token is kept; the command stays the recipe's.
  res = await call('/api/mcp/comfyui', 'PUT', { fields: { COMFYUI_URL: 'http://192.0.2.10:8188', COMFY_TOKEN: '' }, enabled: false });
  assert.equal(res.status, 200);
  sec = mcpSecrets(app.vault, 'comfyui');
  assert.equal(sec.env?.COMFYUI_URL, 'http://192.0.2.10:8188');
  assert.equal(sec.env?.COMFY_TOKEN, 'tok-secret-1');
  const cfg = (app.settings.get().mcpServers ?? []).find((s) => s.name === 'comfyui')!;
  assert.equal(cfg.transport, 'stdio');
  assert.equal(cfg.command, 'npx');
  // A bad address is refused and nothing changes.
  res = await call('/api/mcp/comfyui', 'PUT', { fields: { COMFYUI_URL: 'not a url' }, enabled: false });
  assert.equal(res.status, 400);
  assert.equal(mcpSecrets(app.vault, 'comfyui').env?.COMFYUI_URL, 'http://192.0.2.10:8188');
});

test('B2 fix 6: a Store server cannot be switched to an HTTP server pointing at ComfyUI\'s web page', async () => {
  const res = await call('/api/mcp/comfyui', 'PUT', { transport: 'http', url: 'http://192.0.2.10:8188/', enabled: false });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /came from the Sara Store: change its settings/);
  const cfg = (app.settings.get().mcpServers ?? []).find((s) => s.name === 'comfyui')!;
  assert.equal(cfg.transport, 'stdio');
});

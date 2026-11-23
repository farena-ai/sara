// X0 (docs/security/X0_REVIEW.md): an app signed in with a device code can read, chat and work, but
// can't change what runs on the server (tool servers, add-ons, tool permissions, code changes) or
// take a backup away (it holds the vault). Written first: each refused call answered 2xx/4xx-other before.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { mcpDefaultPermission } from '../src/tools/mcp.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-22T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-22T12:00:00Z' } as never);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const device = auth.createDeviceToken('VS Code').token;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  const api = async (token: string, path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, text: await res.text() };
  };
  return { api, owner, device };
}

test('X0 tokens: a device-code app cannot add a tool server, change tool permissions, add-ons or code changes, or download a backup', async (t) => {
  const r = await rig(t);
  const refused: [string, string, unknown?][] = [
    ['/api/mcp/evil', 'PUT', { transport: 'stdio', command: 'node', args: ['-e', '1'], enabled: true }],
    ['/api/mcp/evil', 'DELETE'],
    ['/api/tools/run_command', 'PUT', { permission: 'auto' }],
    ['/api/plugins', 'POST', { url: 'https://example.invalid/p.zip' }],
    ['/api/self-code/helper', 'POST', { on: true, typed: 'ON' }],
    ['/api/backups', 'POST', {}],
    ['/api/backups/sara-backup-2026.tar.gz', 'GET'],
  ];
  for (const [path, method, body] of refused) {
    const res = await r.api(r.device, path, method, body);
    assert.equal(res.status, 403, `${method} ${path} -> ${res.status} ${res.text.slice(0, 120)}`);
    assert.match(res.text, /device code/i, `${method} ${path}`);
  }
});

test('X0 tokens: the same app still reads those pages, and the owner is not refused', async (t) => {
  const r = await rig(t);
  for (const path of ['/api/mcp', '/api/tools', '/api/backups']) {
    const res = await r.api(r.device, path);
    assert.notEqual(res.status, 403, `GET ${path} for a device-code app`);
  }
  for (const [path, method, body] of [['/api/mcp/evil', 'DELETE', undefined], ['/api/backups/none.tar.gz', 'GET', undefined]] as const) {
    const res = await r.api(r.owner, path, method, body);
    assert.doesNotMatch(res.text, /device code/i, `${method} ${path} for the owner`);
  }
});

test('X0 MCP: a tool server reached over the network cannot mark its own tools as safe to run unasked', () => {
  const ro = { annotations: { readOnlyHint: true, destructiveHint: false } };
  assert.equal(mcpDefaultPermission(ro), 'auto', 'unchanged for callers that say nothing');
  assert.equal(mcpDefaultPermission(ro, 'stdio'), 'auto', 'a program the owner installed: its read-only tools run');
  assert.equal(mcpDefaultPermission(ro, 'http'), 'ask', 'a remote server: every tool asks until the owner says otherwise');
  assert.equal(mcpDefaultPermission({}, 'stdio'), 'ask');
});

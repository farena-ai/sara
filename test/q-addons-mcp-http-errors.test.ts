// Q-ADDONS: an HTTP tool server without the owner's key (Linear) said "MCP HTTP 401: " and one that
// is not running (Storybook) said "fetch failed". Both now say in plain words what to check.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { HTTP_KEY_REFUSED, HTTP_UNREACHABLE, McpManager } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { tempDir } from './helpers.ts';

const manager = (dir: string) => new McpManager(new ToolRegistry(), { dataDir: dir, sandbox: { mode: 'none', network: false, detail: 'test' }, secrets: () => ({}) });

test('Q-ADDONS: a refused key (401/403) and an address nobody answers are said in plain words', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  assert.equal(HTTP_KEY_REFUSED, 'The tool server refused the sign-in. Check the key or token saved for it (or add one).');
  assert.equal(HTTP_UNREACHABLE, 'Nothing answered at this address. Check that the program is running and the address is right.');
  for (const status of [401, 403]) {
    const server = createServer((_q, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"invalid_token"}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const m = manager(dir);
    const conn = await m.start({ name: 'linearish', transport: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, enabled: true }).catch(() => m.get('linearish'));
    try {
      assert.equal(conn?.status, 'error');
      assert.ok(conn?.error?.startsWith(HTTP_KEY_REFUSED), conn?.error);
      assert.match(conn?.error ?? '', new RegExp(`HTTP ${status}`));
    } finally { m.stopAll(); server.close(); }
  }
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const m = manager(dir);
  const conn = await m.start({ name: 'storybookish', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, enabled: true }).catch(() => m.get('storybookish'));
  try {
    assert.equal(conn?.status, 'error');
    assert.ok(conn?.error?.startsWith(HTTP_UNREACHABLE), conn?.error);
    assert.ok(conn?.error?.includes(`127.0.0.1:${port}`), 'names the address');
  } finally { m.stopAll(); }
});

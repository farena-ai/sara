// B2 fix 6 (owner report): an "HTTP server" pointed at ComfyUI's web page answered "MCP HTTP 405:
// Method Not Allowed". An address that answers like a web page (405, HTML, not JSON-RPC) now says so in
// plain words.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { McpManager, WEB_PAGE_ANSWER } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { tempDir } from './helpers.ts';

async function page(status: number, type: string, body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => { res.writeHead(status, { 'content-type': type }); res.end(body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

test('B2 fix 6: a web page instead of a tool server is named in plain words (405, HTML 200, not JSON-RPC)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  assert.equal(WEB_PAGE_ANSWER, 'That address answered like a web page, not a tool server. If this program needs an address of another service (like ComfyUI), put it in that setting instead.');
  for (const [status, type, body] of [[405, 'text/plain', 'Method Not Allowed'], [200, 'text/html', '<!doctype html><title>ComfyUI</title>'], [200, 'application/json', '{"system":{"os":"nt"}}']] as const) {
    const { server, url } = await page(status, type, body);
    const m = new McpManager(new ToolRegistry(), { dataDir: dir, sandbox: { mode: 'none', network: false, detail: 'test' }, secrets: () => ({}) });
    const conn = await m.start({ name: 'comfyweb', transport: 'http', url, enabled: true }).catch(() => m.get('comfyweb'));
    try {
      assert.equal(conn?.status, 'error', `${status} ${type}`);
      assert.ok(conn?.error?.startsWith(WEB_PAGE_ANSWER), `${status} ${type}: ${conn?.error}`);
    } finally {
      m.stopAll();
      server.close();
    }
  }
});

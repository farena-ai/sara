// C3: Sara's MCP client on 2026-07-28 (stateless, per-request _meta, server/discover probe) with
// fallback to the legacy handshake, plus MCP Apps (ui:// resources) on the client side.
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpManager, mcpAppCsp, MCP_APP_MAX_BYTES, MCP_MODERN_VERSION, type McpAppCard } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { listen, readBody, ROOT, tempDir } from './helpers.ts';

const APP_SERVER = join(ROOT, 'test', 'fixtures', 'mcp-app-server.mjs');
const ECHO = join(ROOT, 'test', 'fixtures', 'mcp-echo-server.mjs');
const noSandbox = { mode: 'none' as const, network: true, detail: '' };
const signal = () => new AbortController().signal;

function setup(t: { after: (fn: () => Promise<void> | void) => void }, env: Record<string, string> = {}) {
  const { dir, cleanup } = tempDir();
  const registry = new ToolRegistry([]);
  const mgr = new McpManager(registry, { dataDir: dir, sandbox: noSandbox, secrets: () => ({ env }) });
  t.after(async () => {
    mgr.stopAll();
    await new Promise((r) => setTimeout(r, 200));
    cleanup();
  });
  return { dir, registry, mgr };
}

const whoami = async (registry: ToolRegistry, server: string, dir: string) =>
  JSON.parse(await registry.get(`mcp_${server}_whoami`)!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox })) as { era: string; meta: Record<string, unknown> };

test('C3 stdio: a modern-only server is spoken to on 2026-07-28 with per-request _meta (no handshake)', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'modern' });
  const conn = await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  assert.equal(conn.status, 'ready', conn.error);
  assert.equal(conn.era, 'modern');
  assert.equal(conn.protocol, MCP_MODERN_VERSION);
  const seen = await whoami(registry, 'counter', dir);
  assert.equal(seen.era, 'modern');
  assert.equal(seen.meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.equal((seen.meta['io.modelcontextprotocol/clientInfo'] as { name: string }).name, 'sara');
  const caps = seen.meta['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, { mimeTypes: string[] }> };
  assert.deepEqual(caps.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes, ['text/html;profile=mcp-app']);
});

test('C3 stdio: a dual-era server goes modern; a legacy server (echo, comfyui-style) falls back to initialize', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'dual' });
  const dual = await mgr.start({ name: 'dual', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  assert.equal(dual.era, 'modern', dual.error);
  const echo = await mgr.start({ name: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [ECHO] });
  assert.equal(echo.status, 'ready', echo.error);
  assert.equal(echo.era, 'legacy');
  assert.equal(echo.protocol, '2025-11-25', 'the echo server answers with the version offered');
  assert.deepEqual(echo.tools.map((x) => x.name), ['echo', 'fail']);
  assert.ok(registry.get('mcp_echo_echo'));
  assert.equal((await whoami(registry, 'dual', dir)).era, 'modern');
});

test('C3 stdio: legacy-only server: probe error → initialize, then requests carry no modern _meta', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'legacy' });
  const conn = await mgr.start({ name: 'leg', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  assert.equal(conn.status, 'ready', conn.error);
  assert.equal(conn.era, 'legacy');
  const seen = await whoami(registry, 'leg', dir);
  assert.equal(seen.era, 'legacy');
});

test('C3 apps: app-only tools are hidden from the model; apps off means no ui extension and no app', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'modern' });
  await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  assert.ok(registry.get('mcp_counter_show_counter'));
  assert.ok(registry.get('mcp_counter_whoami'));
  assert.equal(registry.get('mcp_counter_bump'), undefined, 'visibility ["app"] is not offered to the model');
  assert.equal(registry.get('mcp_counter_peek'), undefined);

  await mgr.start({ name: 'plain', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER], apps: false });
  const seen = await whoami(registry, 'plain', dir);
  const caps = seen.meta['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, unknown> };
  assert.equal(caps.extensions?.['io.modelcontextprotocol/ui'], undefined);
  let card: McpAppCard | undefined;
  const out = await registry.get('mcp_plain_show_counter')!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox, conversationId: 'c1', attachAppCard: (c) => (card = c) });
  assert.match(out, /count=0/);
  assert.equal(card, undefined);
});

test('C3 apps: a tool result with a ui:// resource gives an app card; the page and its CSP are kept', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'modern' });
  await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  let card: McpAppCard | undefined;
  const out = await registry.get('mcp_counter_show_counter')!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox, conversationId: 'c1', attachAppCard: (c) => (card = c) });
  assert.match(out, /count=0/);
  assert.ok(card, 'app card attached');
  assert.equal(card.kind, 'mcp-app');
  assert.equal(card.server, 'counter');
  assert.equal(card.tool, 'show_counter');
  const rec = mgr.apps.get(card.id)!;
  assert.ok(rec.html.includes('<title>Counter</title>'));
  assert.equal(rec.conversationId, 'c1');
  assert.deepEqual(rec.result.structuredContent, { count: 0 });
  // Declared origins are honoured only when they are plain https origins (no CSP injection).
  const csp = mcpAppCsp(rec.csp);
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src https:\/\/api\.example\.com(;|$)/);
  assert.doesNotMatch(csp, /javascript:|script-src \*|cdn\.example\.com; script-src/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  // From the app: app-visible tools of the same server only.
  const bumped = await mgr.callFromApp(card.id, 'bump', { by: 2 }, signal());
  assert.deepEqual(bumped.structuredContent, { count: 2 });
  await assert.rejects(mgr.callFromApp(card.id, 'whoami', {}, signal()), /not open to apps/);
  await assert.rejects(mgr.callFromApp(card.id, 'nope', {}, signal()), /no tool/i);
  await assert.rejects(mgr.callFromApp('missing', 'bump', {}, signal()), /no longer open/);
});

test('C3 apps: an oversized app page is refused (the tool result still arrives)', async (t) => {
  const { dir, registry, mgr } = setup(t, { MCP_ERA: 'modern', MCP_BIG_HTML: '1' });
  await mgr.start({ name: 'big', enabled: true, transport: 'stdio', command: process.execPath, args: [APP_SERVER] });
  let card: McpAppCard | undefined;
  const out = await registry.get('mcp_big_show_counter')!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox, conversationId: 'c1', attachAppCard: (c) => (card = c) });
  assert.equal(card, undefined);
  assert.match(out, /count=0/);
  assert.match(out, new RegExp(`App not shown: its page is over ${MCP_APP_MAX_BYTES / 1024} KB`));
});

type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: Record<string, unknown> };
async function httpServer(t: { after: (fn: () => void) => void }, handle: (msg: Rpc, req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { method: string; headers: IncomingMessage['headers'] }[] = [];
  const { server, url } = await listen(async (req, res) => {
    if (req.method === 'DELETE') return void res.writeHead(204).end();
    const msg = JSON.parse(await readBody(req)) as Rpc;
    seen.push({ method: msg.method, headers: req.headers });
    handle(msg, req, res);
  });
  t.after(() => server.close());
  return { url, seen };
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

test('C3 HTTP: modern server: MCP-Protocol-Version, Mcp-Method and Mcp-Name headers; no session', async (t) => {
  const { url, seen } = await httpServer(t, (msg, _req, res) => {
    const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
    if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') return json(res, 400, { jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'] } } });
    if (msg.method === 'server/discover') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } });
    if (msg.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', tools: [{ name: 'héllo', inputSchema: { type: 'object' } }, { name: 'ask', inputSchema: { type: 'object' } }], ttlMs: 0, cacheScope: 'private' } });
    if (msg.method === 'tools/call' && msg.params?.name === 'ask') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resultType: 'input_required', inputRequests: { a: { method: 'elicitation/create', params: {} } } } });
    return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'hi' }] } });
  });
  const { dir, registry, mgr } = setup(t);
  const conn = await mgr.start({ name: 'web', enabled: true, transport: 'http', url });
  assert.equal(conn.status, 'ready', conn.error);
  assert.equal(conn.era, 'modern');
  const ctx = { workspaceDir: dir, signal: signal(), sandbox: noSandbox };
  assert.equal(await registry.get('mcp_web_h_llo')!.run({}, ctx), 'hi');
  await assert.rejects(registry.get('mcp_web_ask')!.run({}, ctx), /asked for more input/);
  for (const s of seen) {
    assert.equal(s.headers['mcp-protocol-version'], '2026-07-28');
    assert.equal(s.headers['mcp-method'], s.method);
    assert.equal(s.headers['mcp-session-id'], undefined);
  }
  assert.ok(!seen.some((s) => s.method === 'initialize'));
  const call = seen.find((s) => s.method === 'tools/call')!;
  assert.equal(call.headers['mcp-name'], `=?base64?${Buffer.from('héllo').toString('base64')}?=`, 'non-ASCII names use the base64 sentinel');
  assert.equal(seen.find((s) => s.method === 'tools/call' && s.headers['mcp-name'] === 'ask')?.headers['mcp-name'], 'ask');
});

test('C3 HTTP: legacy server: a 400 without a modern error falls back to initialize with its session', async (t) => {
  const { url, seen } = await httpServer(t, (msg, req, res) => {
    if (msg.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'old', version: '1' } } }, { 'mcp-session-id': 'S1' });
    if (req.headers['mcp-session-id'] !== 'S1') return void res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad Request: No valid session ID provided');
    if (!msg.id) return void res.writeHead(202).end();
    if (msg.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
    return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  });
  const { dir, registry, mgr } = setup(t);
  const conn = await mgr.start({ name: 'old', enabled: true, transport: 'http', url });
  assert.equal(conn.status, 'ready', conn.error);
  assert.equal(conn.era, 'legacy');
  assert.equal(conn.protocol, '2025-06-18');
  assert.equal(await registry.get('mcp_old_ping')!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox }), 'pong');
  assert.deepEqual(seen.map((s) => s.method), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(seen.at(-1)!.headers['mcp-protocol-version'], '2025-06-18');
});

test('C3 HTTP: a modern server that lists only versions Sara lacks gives a plain error (no blind fallback)', async (t) => {
  const { url, seen } = await httpServer(t, (msg, _req, res) => json(res, 400, { jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2027-03-01'] } } }));
  const { mgr } = setup(t);
  const conn = await mgr.start({ name: 'future', enabled: true, transport: 'http', url });
  assert.equal(conn.status, 'error');
  assert.match(conn.error, /2027-03-01/);
  assert.ok(!seen.some((s) => s.method === 'initialize'));
});

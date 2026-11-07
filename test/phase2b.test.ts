import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { buildSystemPrompt, loadPersona } from '../src/persona.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { ensureGitConfig } from '../src/tools/sandbox.ts';
import { createWebSearchTool, formatResults, runSearch } from '../src/tools/search.ts';
import { McpManager, mcpToolName, splitArgs, validateMcpConfig } from '../src/tools/mcp.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, listen, makeApp, readBody, ROOT, tempDir, text } from './helpers.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'mcp-echo-server.mjs');
const noSandbox = { mode: 'none' as const, network: true, detail: '' };
const signal = () => new AbortController().signal;

test('MCP stdio: connects, pages tools/list, calls tools with vault env, maps errors, unregisters on stop', async (t) => {
  const { dir, cleanup } = tempDir();
  const registry = new ToolRegistry([]);
  const mgr = new McpManager(registry, { dataDir: dir, sandbox: noSandbox, secrets: () => ({ env: { SECRET_TOKEN: 'abc123' } }) });
  t.after(async () => {
    mgr.stopAll();
    await new Promise((r) => setTimeout(r, 300));
    cleanup();
  });
  const conn = await mgr.start({ name: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE] });
  assert.equal(conn.status, 'ready', conn.error);
  assert.deepEqual(conn.tools.map((x) => x.name), ['echo', 'fail']);
  const echo = registry.get('mcp_echo_echo')!;
  assert.equal(echo.defaultPermission, 'ask');
  assert.equal(echo.source, 'MCP: echo');
  assert.deepEqual(echo.spec.parameters, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
  const ctx = { workspaceDir: dir, signal: signal(), sandbox: noSandbox };
  assert.equal(await echo.run({ text: 'hi' }, ctx), "echo: hi token=abc123\nImage not attached: pictures from tools can't be shown here.");
  await assert.rejects(registry.get('mcp_echo_fail')!.run({}, ctx), /it broke/);
  mgr.stop('echo');
  assert.equal(registry.get('mcp_echo_echo'), undefined);
});

test('MCP stdio: a bad command reports an error instead of hanging', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const mgr = new McpManager(new ToolRegistry([]), { dataDir: dir, sandbox: noSandbox, secrets: () => ({}) });
  const conn = await mgr.start({ name: 'bad', enabled: true, transport: 'stdio', command: join(dir, 'does-not-exist') });
  assert.equal(conn.status, 'error');
  assert.ok(conn.error.length > 0);
  const off = await mgr.start({ name: 'off', enabled: false, transport: 'stdio', command: 'x' });
  assert.equal(off.status, 'stopped');
});

test('MCP streamable HTTP: JSON and SSE responses, session header, custom headers', async (t) => {
  const seen: { method: string; session?: string; auth?: string; proto?: string }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    seen.push({ method: body.method, session: req.headers['mcp-session-id'] as string, auth: req.headers.authorization, proto: req.headers['mcp-protocol-version'] as string });
    if (body.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
    }
    if (body.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
      return res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } })}\n\n`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'pong' }] } }));
  });
  t.after(() => server.close());
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const registry = new ToolRegistry([]);
  const mgr = new McpManager(registry, { dataDir: dir, sandbox: noSandbox, secrets: () => ({ headers: { authorization: 'Bearer tok' } }) });
  const conn = await mgr.start({ name: 'remote', enabled: true, transport: 'http', url });
  assert.equal(conn.status, 'ready', conn.error);
  assert.equal(await registry.get('mcp_remote_ping')!.run({}, { workspaceDir: dir, signal: signal(), sandbox: noSandbox }), 'pong');
  assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(seen[0].session, undefined);
  assert.ok(seen.slice(1).every((s) => s.session === 'sess-1' && s.proto === '2025-06-18' && s.auth === 'Bearer tok'));
  mgr.stopAll();
});

test('MCP config validation, names and argument splitting', () => {
  assert.throws(() => validateMcpConfig({ transport: 'stdio' }, 'Bad Name'), /lowercase/);
  assert.throws(() => validateMcpConfig({ transport: 'stdio' }, 'ok'), /command is required/);
  assert.throws(() => validateMcpConfig({ transport: 'http', url: 'ftp://x' }, 'ok'), /http or https/);
  assert.deepEqual(validateMcpConfig({ transport: 'stdio', command: 'npx', args: '-y "@scope/pkg name" --flag' }, 'gh'), {
    name: 'gh',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@scope/pkg name', '--flag'],
  });
  assert.deepEqual(splitArgs(`a 'b c' "d"`), ['a', 'b c', 'd']);
  assert.equal(mcpToolName('git-hub', 'create.issue'), 'mcp_git-hub_create_issue');
  assert.ok(mcpToolName('x', 'y'.repeat(100)).length <= 64);
});

test('web search: SearXNG + formatting; tool hidden until configured', async (t) => {
  const { server, url } = await listen((req, res) => {
    assert.match(req.url ?? '', /^\/search\?q=sara\+ai&format=json/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'A', url: 'https://a.example', content: 'first   result' }, { title: 'B', url: 'https://b.example', content: '' }] }));
  });
  t.after(() => server.close());
  const results = await runSearch({ provider: 'searxng', url }, 'sara ai', 1, signal());
  assert.deepEqual(results, [{ title: 'A', url: 'https://a.example', snippet: 'first   result' }]);
  assert.equal(formatResults(results), '1. A\n   https://a.example\n   first result');
  let cfg: { provider: 'searxng'; url: string } | undefined;
  const reg = new ToolRegistry([createWebSearchTool(() => cfg)]);
  assert.deepEqual(reg.enabled(undefined).map((x) => x.spec.name), []);
  cfg = { provider: 'searxng', url };
  assert.deepEqual(reg.enabled(undefined).map((x) => x.spec.name), ['web_search']);
});

test('web search: Brave, Tavily and Ollama request shapes', async (t) => {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const u = String(input);
    const body = u.includes('brave') ? { web: { results: [{ title: 'T', url: 'https://t', description: 'd' }] } } : { results: [{ title: 'T', url: 'https://t', content: 'd' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  for (const provider of ['brave', 'tavily', 'ollama'] as const) {
    const r = await runSearch({ provider, apiKey: 'k-1' }, 'q', 3, signal());
    assert.deepEqual(r, [{ title: 'T', url: 'https://t', snippet: 'd' }], provider);
  }
  assert.match(calls[0].url, /api\.search\.brave\.com.*q=q&count=3/);
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-subscription-token'], 'k-1');
  assert.equal(calls[1].url, 'https://api.tavily.com/search');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { query: 'q', max_results: 3 });
  assert.equal(calls[2].url, 'https://ollama.com/api/web_search');
  assert.equal((calls[2].init?.headers as Record<string, string>).authorization, 'Bearer k-1');
});

test('coding mode: workflow prompt and higher step limit; chat mode has neither', async (t) => {
  const p = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const base = { now: new Date(), tools: ['shell'] };
  assert.match(buildSystemPrompt(p, { ...base, coding: true }), /## Coding mode[\s\S]*sara\/<short-task-name>[\s\S]*Never weaken or delete tests/);
  assert.doesNotMatch(buildSystemPrompt(p, base), /Coding mode/);

  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  const conv = app.store.createConversation({ mode: 'coding', workspace: 'proj' });
  assert.equal(conv.mode, 'coding');
  for (let i = 0; i < 30; i++) app.script.push([call(`c${i}`, 'list_dir', {})]);
  app.script.push(text('done'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'go')) evs.push(ev);
  assert.equal(evs.at(-1)?.type, 'done', 'coding mode allows more than 25 steps');
  assert.match(app.requests[0].messages[0].content, /## Coding mode/);
});

test('git config: default identity in the workspace home, never overwritten', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = workspaceDir(dir, 'main');
  ensureGitConfig(ws);
  const first = readFileSync(join(ws, '.gitconfig'), 'utf8');
  assert.match(first, /name = Sara/);
  assert.match(first, /defaultBranch = main/);
  ensureGitConfig(ws);
  assert.equal(readFileSync(join(ws, '.gitconfig'), 'utf8'), first);
});

after(() => {
  // node:test keeps the process alive while child processes exist; make sure fixtures are gone.
});

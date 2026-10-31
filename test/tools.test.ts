import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildHistory, historyFrom, runTurn, type ChatEvent } from '../src/chat.ts';
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from '../src/providers/types.ts';
import type { StoredMessage } from '../src/store.ts';
import { editFileTool, listDir, readFileTool, searchTool, shellTool, webFetchTool, writeFileTool } from '../src/tools/builtin.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { resolveInside, workspaceDir } from '../src/tools/workspace.ts';
import { call, listen, makeApp, tempDir, text } from './helpers.ts';

function ctxFor(dir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { workspaceDir: workspaceDir(dir, 'main'), signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: '' }, ...extra };
}

const hasBash = spawnSync(process.platform === 'win32' ? 'bash' : '/bin/sh', ['-c', 'true']).status === 0;

test('workspace: paths cannot escape, including via symlinks/junctions', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = workspaceDir(dir, 'main');
  assert.equal(resolveInside(ws, 'a/b.txt'), join(ws, 'a', 'b.txt'));
  assert.equal(resolveInside(ws, '/workspace/x.txt'), join(ws, 'x.txt'));
  assert.equal(resolveInside(ws, '/etc/passwd'), join(ws, 'etc', 'passwd'), 'absolute paths are rooted in the workspace');
  assert.throws(() => resolveInside(ws, '../outside.txt'), /outside the workspace/);
  assert.throws(() => resolveInside(ws, 'a/../../x'), /outside the workspace/);
  const outside = join(dir, 'secret');
  mkdirSync(outside);
  writeFileSync(join(outside, 'key'), 'x');
  symlinkSync(outside, join(ws, 'link'), 'junction');
  assert.throws(() => resolveInside(ws, 'link/key'), /resolves outside/);
  assert.throws(() => workspaceDir(dir, '../evil'), /Invalid workspace/);
});

test('file tools: write, read, edit, list, search', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ctx = ctxFor(dir);
  assert.match(await writeFileTool.run({ path: 'src/app.js', content: 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n' }, ctx), /Wrote 40 bytes/);
  assert.equal(await readFileTool.run({ path: 'src/app.js', offset: 2, limit: 1 }, ctx), '2| const b = 2;\n[showing lines 2-2 of 4]');
  await assert.rejects(editFileTool.run({ path: 'src/app.js', old_string: '= 1;', new_string: '= 9;' }, ctx), /matches 2 places/);
  await assert.rejects(editFileTool.run({ path: 'src/app.js', old_string: 'nope', new_string: 'x' }, ctx), /not found/);
  await editFileTool.run({ path: 'src/app.js', old_string: 'const b = 2;', new_string: 'const b = $&3;' }, ctx);
  assert.match(readFileSync(join(ctx.workspaceDir, 'src', 'app.js'), 'utf8'), /const b = \$&3;/, 'replacement text is literal');
  await editFileTool.run({ path: 'src/app.js', old_string: '= 1;', new_string: '= 7;', replace_all: true }, ctx);
  assert.equal((readFileSync(join(ctx.workspaceDir, 'src', 'app.js'), 'utf8').match(/= 7;/g) ?? []).length, 2);
  assert.equal(await listDir.run({}, ctx), 'src/');
  assert.match(await listDir.run({ path: 'src' }, ctx), /app\.js {2}\(\d+ bytes\)/);
  assert.equal(await searchTool.run({ pattern: 'CONST B', ignore_case: true }, ctx), 'src/app.js:2: const b = $&3;');
  await assert.rejects(readFileTool.run({ path: '../x' }, ctx), /outside the workspace/);
});

test('shell: runs in the workspace, reports exit code, never leaks Sara env secrets', { skip: !hasBash && 'no shell available' }, async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ctx = ctxFor(dir);
  writeFileSync(join(ctx.workspaceDir, 'marker.txt'), 'here');
  process.env.SARA_MASTER_KEY = 'super-secret-test-value';
  try {
    const out = await shellTool.run({ command: 'cat marker.txt; echo "[${SARA_MASTER_KEY:-}]"; exit 3' }, ctx);
    assert.match(out, /^\[exit code 3, [\d.]+s \(no sandbox\)\]/);
    assert.match(out, /here/);
    assert.match(out, /\[\]/);
    assert.doesNotMatch(out, /super-secret/);
  } finally {
    delete process.env.SARA_MASTER_KEY;
  }
  const slow = await shellTool.run({ command: 'sleep 5', timeout_seconds: 1 }, ctx);
  assert.match(slow, /timed out after 1s/);
});

test('web_fetch: blocks private addresses unless allowed; converts HTML to text', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>x</title><script>evil()</script></head><body><h1>Hello</h1><p>World &amp; more</p></body></html>');
  });
  t.after(() => server.close());
  await assert.rejects(webFetchTool.run({ url }, ctxFor(dir)), /private or local address/);
  await assert.rejects(webFetchTool.run({ url: 'file:///etc/passwd' }, ctxFor(dir)), /Only http/);
  const out = await webFetchTool.run({ url }, ctxFor(dir, { allowPrivateNetwork: true }));
  assert.match(out, /^\[HTTP 200 text\/html/);
  assert.match(out, /Hello\nWorld & more/);
  assert.doesNotMatch(out, /evil/);
});

async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Extract<ChatEvent, { type: 'approval' }>) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}

function setupProvider(app: ReturnType<typeof makeApp>): void {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
}

test('agent loop: model calls a tool, gets the result, then answers; all of it is stored', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  setupProvider(app);
  const conv = app.store.createConversation();
  app.script.push([...text('Let me write that.'), call('c1', 'write_file', { path: 'notes/todo.md', content: '- ship it' })], text('Done, saved it.'));

  const evs = await drain(runTurn(app, conv.id, 'save a todo'));
  const types = evs.map((e) => e.type);
  assert.deepEqual(types.filter((x) => x !== 'token' && x !== 'notice'), ['tool_call', 'tool_result', 'done'], 'auto tools need no approval events');
  assert.equal(readFileSync(join(dir, 'workspaces', 'main', 'notes', 'todo.md'), 'utf8'), '- ship it');

  // Second model request carries the tool call and its result.
  const second = app.requests[1];
  assert.ok(second.tools?.some((t) => t.name === 'write_file'));
  const tail = second.messages.slice(-2);
  assert.deepEqual(tail[0], { role: 'assistant', content: 'Let me write that.', toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'notes/todo.md', content: '- ship it' } }] });
  assert.equal(tail[1].role, 'tool');
  assert.match((tail[1] as { content: string }).content, /Wrote 9 bytes/);
  assert.match(second.messages[0].content, /What you can do/);

  const roles = app.store.messages(conv.id).map((m) => m.role);
  assert.deepEqual(roles, ['notice', 'user', 'assistant', 'tool', 'assistant']);
});

test('agent loop: "ask" tools wait for approval; a denial is reported to the model', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  setupProvider(app);
  const conv = app.store.createConversation();
  app.script.push([call('s1', 'shell', { command: 'rm -rf /' })], text('Okay, I won\'t.'));
  const evs = await drain(runTurn(app, conv.id, 'clean up'), (ev) => {
    assert.equal(ev.summary, '$ rm -rf /');
    assert.deepEqual(app.approvals.pendingFor(conv.id), [ev.approvalId]);
    app.approvals.decide(ev.approvalId, false);
  });
  const result = evs.find((e) => e.type === 'tool_result');
  assert.equal(result?.type === 'tool_result' && result.status, 'denied');
  assert.match((app.requests[1].messages.at(-1) as { content: string }).content, /declined/);
});

test('agent loop: "never" tools are hidden from the model and refused if called anyway', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  setupProvider(app);
  app.settings.update({ toolPermissions: { write_file: 'never' } });
  const conv = app.store.createConversation();
  app.script.push([call('w', 'write_file', { path: 'x', content: 'y' })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'write'));
  assert.ok(!app.requests[0].tools?.some((t) => t.name === 'write_file'));
  const result = evs.find((e) => e.type === 'tool_result');
  assert.equal(result?.type === 'tool_result' && result.status, 'denied');
  assert.ok(!existsSync(join(dir, 'workspaces', 'main', 'x')));
});

test('agent loop: models without tool support fall back to plain chat', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  setupProvider(app);
  const seen: ChatRequest[] = [];
  app.providerFactory = (config): Provider => ({
    config,
    listModels: async () => [],
    async *stream(req): AsyncIterable<StreamEvent> {
      seen.push(req);
      if (req.tools?.length) throw new ProviderError('HTTP 400: model does not support tools', 400);
      yield { type: 'text', text: 'hi!' };
    },
  });
  const conv = app.store.createConversation();
  const evs = await drain(runTurn(app, conv.id, 'hello'));
  assert.equal(evs.at(-1)?.type, 'done');
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1].messages[0].content, /What you can do/);
  await drain(runTurn(app, conv.id, 'again'));
  assert.equal(seen.length, 3, 'remembered: no second failed attempt');
});

test('historyFrom: repairs interrupted tool calls and drops orphaned leading results', () => {
  const m = (role: StoredMessage['role'], content: string, meta?: Record<string, unknown>): StoredMessage => ({ id: 0, conversationId: 'c', role, content, createdAt: '', ...(meta ? { meta } : {}) });
  const h = historyFrom([
    m('tool', 'orphan', { toolCallId: 'old', name: 'x' }),
    m('user', 'go'),
    m('assistant', '', { toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }, { id: 'b', name: 'shell', arguments: {} }] }),
    m('tool', 'listing', { toolCallId: 'a', name: 'list_dir' }),
    m('notice', 'disclosure:x'),
    m('user', 'hello?'),
  ]);
  assert.deepEqual(
    h.map((x) => (x.role === 'tool' ? `tool:${x.toolCallId}:${x.content}` : x.role)),
    ['user', 'assistant', 'tool:a:listing', 'tool:b:Cancelled: no result.', 'user'],
  );
  // A job's report saved while she was waiting on a tool lands between her request and its result:
  // the result moves up next to its request, the report follows it.
  const h2 = historyFrom([
    m('user', 'run the tests'),
    m('assistant', '', { toolCalls: [{ id: 'c', name: 'shell', arguments: {} }] }),
    m('notice', 'job:Background job #3 finished'),
    m('assistant', 'Done: build finished.', { job: 3 }),
    m('tool', 'all passed', { toolCallId: 'c', name: 'shell' }),
    m('assistant', 'All tests pass.'),
  ]);
  assert.deepEqual(
    h2.map((x) => (x.role === 'tool' ? `tool:${x.toolCallId}:${x.content}` : `${x.role}:${x.content.slice(0, 20)}`)),
    ['user:run the tests', 'assistant:', 'tool:c:all passed', 'user:[Note from the app: ', 'assistant:Done: build finished', 'assistant:All tests pass.'],
  );
});

test('MCP: read-only tools run on their own, everything else asks; presets are well-formed', async () => {
  const { mcpDefaultPermission, MCP_PRESETS, MCP_NAME_RE } = await import('../src/tools/mcp.ts');
  assert.equal(mcpDefaultPermission({ annotations: { readOnlyHint: true, destructiveHint: false } }), 'auto');
  assert.equal(mcpDefaultPermission({ annotations: { readOnlyHint: true, destructiveHint: true } }), 'ask');
  assert.equal(mcpDefaultPermission({ annotations: { readOnlyHint: false } }), 'ask');
  assert.equal(mcpDefaultPermission({}), 'ask', 'no hint: ask');
  for (const p of MCP_PRESETS) {
    assert.match(p.name, MCP_NAME_RE);
    assert.match(p.args.at(-1)!, /@\d+\.\d+\.\d+$/, 'preset packages are pinned');
    assert.ok(p.secrets.length);
  }
  const { runtimeMountArgs } = await import('../src/tools/sandbox.ts');
  assert.deepEqual(runtimeMountArgs('/usr/bin/node'), [], 'system node is already visible');
});

test('web_fetch connects only to the address that passed the check (no DNS rebinding)', async (t) => {
  const { createServer } = await import('node:http');
  const { pinnedGet } = await import('../src/tools/builtin.ts');
  const srv = createServer((req, res) => res.end(`host=${req.headers.host}`));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = (srv.address() as { port: number }).port;
  // The name doesn't exist in DNS; the request still goes to the pinned address, with the original Host.
  const r = await pinnedGet(new URL(`http://rebind-test.invalid:${port}/x`), '127.0.0.1', AbortSignal.timeout(5000));
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), `host=rebind-test.invalid:${port}`);
});

test('web_fetch keeps the pin when Node uses the environment proxy (NODE_USE_ENV_PROXY + HTTP_PROXY)', async (t) => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const srv = createServer((req, res) => res.end(`host=${req.headers.host}`));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = (srv.address() as { port: number }).port;
  // The proxy is a closed port: a request that goes to it fails instead of reaching the pinned address.
  const mod = pathToFileURL(join(import.meta.dirname, '..', 'src', 'tools', 'builtin.ts')).href;
  const script = `const { pinnedGet } = await import(${JSON.stringify(mod)}); const r = await pinnedGet(new URL('http://rebind-test.invalid:${port}/x'), '127.0.0.1', AbortSignal.timeout(5000)); console.log(r.status, r.body.toString());`;
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const out = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '' }, timeout: 30_000, windowsHide: true }, (e, stdout, stderr) => (e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(stdout))),
  );
  assert.equal(out.trim(), `200 host=rebind-test.invalid:${port}`);
});

test('history: one message bigger than the budget is shortened (start and end kept), not sent whole', () => {
  const m = (role: StoredMessage['role'], content: string): StoredMessage => ({ id: 0, conversationId: 'c', role, content, createdAt: '' });
  const huge = `START ${'log line\n'.repeat(20_000)} END`;
  const h = buildHistory([m('user', 'hi'), m('assistant', 'hello'), m('user', huge)], 8000).messages;
  const last = h.at(-1)!;
  assert.ok(last.content.length < 8000, `kept ${last.content.length}`);
  assert.match(last.content, /^START /);
  assert.match(last.content, / END$/);
  assert.match(last.content, /characters left out/);
});

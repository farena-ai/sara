// S2 (docs/ROADMAP_AFTER_3.40.md, stage 2): the thinking level of Settings (Quick / Balanced /
// Thorough) reaches the model as ChatRequest.reasoning, and Claude on a subscription (the CLI) takes
// it as --effort where the CLI and the model know it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, THINK_LEVEL } from '../src/chat.ts';
import { createSaraServer } from '../src/server.ts';
import { CliAgentProvider } from '../src/providers/cli-agent.ts';
import type { ChatRequest } from '../src/providers/types.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('S2 thinking: the level in Settings is what the turn asks the model for; Balanced asks for nothing', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    assert.deepEqual(THINK_LEVEL, { quick: 'low', balanced: undefined, thorough: 'high' });
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    const conv = app.store.createConversation();
    const asked = async (): Promise<ChatRequest['reasoning']> => {
      app.script.push(text('ok'));
      for await (const _ of runTurn(app, conv.id, 'hello there', undefined)) void _;
      return app.requests.at(-1)!.reasoning;
    };
    assert.equal(await asked(), undefined, 'not set: as before');
    app.settings.update({ thinking: 'quick' });
    assert.equal(await asked(), 'low');
    app.settings.update({ thinking: 'thorough' });
    assert.equal(await asked(), 'high');
    app.settings.update({ thinking: 'balanced' });
    assert.equal(await asked(), undefined);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('S2 thinking: Claude on a subscription gets --effort when the CLI and the model know it', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const log = join(dir, 'fake-log.json');
  const rtFor = (help: string) => ({ kind: 'claude' as const, bin: process.execPath, binArgs: ['--disable-warning=ExperimentalWarning', join(ROOT, 'test', 'fixtures', 'fake-claude.ts')], home: join(dir, 'agents', 'claude'), tmpDir: join(dir, 'tmp'), env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HELP: help }), tools: true });
  const argsOf = async (p: CliAgentProvider, model: string, reasoning?: ChatRequest['reasoning']): Promise<string[]> => {
    for await (const _ of p.stream({ model, messages: [{ role: 'system', content: 'You are Sara.' }, { role: 'user', content: 'hello' }], ...(reasoning ? { reasoning } : {}) })) void _;
    return (JSON.parse(readFileSync(log, 'utf8')) as { args: string[] }).args;
  };
  const effort = (a: string[]): string | undefined => (a.includes('--effort') ? a[a.indexOf('--effort') + 1] : undefined);
  const knows = new CliAgentProvider({ id: 'claude-sub', label: 'Claude', kind: 'claude-code', baseUrl: '' }, rtFor('Options:\n  --effort <level>  Effort level (low, medium, high)\n'));
  assert.equal(effort(await argsOf(knows, 'sonnet', 'high')), 'high');
  assert.equal(effort(await argsOf(knows, 'opus', 'low')), 'low');
  assert.equal(effort(await argsOf(knows, 'claude-sonnet-5-5', 'medium')), 'medium');
  assert.equal(effort(await argsOf(knows, 'sonnet', 'none')), 'low', 'no thinking asked: the least there is');
  assert.equal(effort(await argsOf(knows, 'sonnet')), undefined, 'nothing asked, nothing sent');
  assert.equal(effort(await argsOf(knows, 'haiku', 'high')), undefined, 'a model that may have no effort setting');
  assert.equal(effort(await argsOf(knows, 'claude-haiku-4-5', 'high')), undefined);
  // A model that refuses the level: that call fails with the CLI's words, the next one goes without.
  const refuses = new CliAgentProvider({ id: 'claude-sub', label: 'Claude', kind: 'claude-code', baseUrl: '' }, { ...rtFor('  --effort <level>\n'), env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HELP: '  --effort <level>\n', FAKE_CLAUDE_NO_EFFORT: '1' }) });
  await assert.rejects(() => argsOf(refuses, 'sonnet', 'high'), /effort/);
  assert.equal(effort(await argsOf(refuses, 'sonnet', 'high')), undefined);
  // An older CLI that has no such flag is called as before.
  const old = new CliAgentProvider({ id: 'claude-sub', label: 'Claude', kind: 'claude-code', baseUrl: '' }, rtFor('Options:\n  --model <model>\n'));
  assert.equal(effort(await argsOf(old, 'sonnet', 'high')), undefined);
});

test('S2 thinking: Settings reads and saves the level, refuses anything else, and the page has the control', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '3.40.0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, body?: unknown) => {
    const res = await fetch(`${base}/api/settings`, { method, headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  assert.equal((await api('GET')).json.thinking, 'balanced', 'not set reads as Balanced');
  assert.equal((await api('PUT', { thinking: 'thorough' })).status, 200);
  assert.equal(app.settings.get().thinking, 'thorough');
  assert.equal((await api('GET')).json.thinking, 'thorough');
  assert.equal((await api('PUT', { thinking: 'maximum' })).status, 400);
  assert.equal(app.settings.get().thinking, 'thorough');
  const page = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const v of ['quick', 'balanced', 'thorough']) assert.match(page.slice(page.indexOf('id="thinking-level"')), new RegExp(`<option value="${v}">`));
  const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(js, /\$\('#thinking-level'\)\.value = s\.thinking \?\? 'balanced'/);
  assert.match(js, /thinking: \$\('#thinking-level'\)\.value/);
});

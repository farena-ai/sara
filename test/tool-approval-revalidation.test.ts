import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { makeApp, tempDir, call, text, ROOT } from './helpers.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { writeFileTool, shellTool } from '../src/tools/builtin.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { runTurn } from '../src/chat.ts';
import { applySandbox, discardSandbox, SandboxGate, sandboxGateSettings, type SandboxResult } from '../src/sandbox-run.ts';
import { captureToolScope, assertToolAdmission, ToolAdmissionError } from '../src/tool-admission.ts';
import { setProjectChecks, closeChecks } from '../src/diagnostics.ts';

async function waitFor<T>(fn: () => T | undefined): Promise<T> {
  const until = Date.now() + 12000;
  while (Date.now() < until) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for actual approval');
}

test('review regression: HTTP deletion during the admitted checker wait avoids a stale transcript insert', async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'auto', shell: 'auto' } });
  const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(join(ws, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'typescript', 'bin', 'tsc'), "const fs = require('node:fs'); fs.writeFileSync('.checker-started', 'started'); const timer = setInterval(() => { if (fs.existsSync('.release-checker')) clearInterval(timer); }, 5);\n");
  writeFileSync(join(ws, 'tsconfig.json'), '{}');
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc --noEmit' } }));
  assert.ok(setProjectChecks(app, conv.workspace, ws, { project: '.', state: 'on', checkers: ['tsc'], confirm: true }).ok);
  app.script.push([call('first', 'write_file', { path: 'first.ts', content: 'export const first = 1;' })], text('Finished.'));
  const auth = new OwnerAuth(dir, () => now);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let completion: Promise<string> | undefined;
  try {
    completion = api(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'Write first.ts.' }).then(r => r.text());
    await waitFor(() => existsSync(join(ws, '.checker-started')) ? true : undefined);
    assert.equal(readFileSync(join(ws, 'first.ts'), 'utf8'), 'export const first = 1;');
    assert.equal((await api(`/api/conversations/${conv.id}`, 'DELETE')).status, 200);
    writeFileSync(join(ws, '.release-checker'), 'release');
    const events = await completion;
    assert.equal(app.store.getConversation(conv.id), undefined);
    assert.doesNotMatch(events + errors.join('\n'), /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/);
    assert.equal(app.requests.length, 1);
    assert.equal(readFileSync(join(ws, 'first.ts'), 'utf8'), 'export const first = 1;', 'deletion does not undo the completed file write');
  } finally {
    writeFileSync(join(ws, '.release-checker'), 'release');
    app.stopTurn?.(conv.id);
    await completion?.catch(() => {});
    console.error = originalError;
    console.warn = originalWarn;
    await new Promise<void>(r => server.close(() => r()));
    closeChecks(app); app.store.close(); cleanup();
  }
});

test('review regression: deletion at a yielded checks card avoids a stale transcript insert', async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'auto' } });
  const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(join(ws, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exit(0);');
  writeFileSync(join(ws, 'tsconfig.json'), '{}');
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc --noEmit' } }));
  app.script.push([call('first', 'write_file', { path: 'first.ts', content: 'export const first = 1;' })], text('Finished.'));
  let deleted = false;
  try {
    for await (const ev of runTurn(app, conv.id, 'Write first.ts.')) {
      if (ev.type === 'checks_card') {
        app.store.deleteConversation(conv.id);
        deleted = true;
      }
    }
    assert.equal(deleted, true, 'the real checks-card yield was exercised');
    assert.equal(app.store.getConversation(conv.id), undefined);
    assert.equal(app.requests.length, 1);
    assert.equal(readFileSync(join(ws, 'first.ts'), 'utf8'), 'export const first = 1;');
  } finally { closeChecks(app); app.store.close(); cleanup(); }
});

for (const mutation of ['allow', 'workspace', 'private'] as const) test(`review regression: diagnostics after second pending edit ${mutation}`, async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'ask', shell: 'auto' } });
  const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(join(ws, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'typescript', 'bin', 'tsc'), "require('node:fs').writeFileSync('.diagnostics-started', 'started');\n");
  writeFileSync(join(ws, 'tsconfig.json'), '{}');
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc --noEmit' } }));
  assert.ok(setProjectChecks(app, conv.workspace, ws, { project: '.', state: 'on', checkers: ['tsc'], confirm: true }).ok);
  app.script.push([call('first', 'write_file', { path: 'first.ts', content: 'export const first = 1;' }), call('second', 'write_file', { path: 'second.ts', content: 'export const second = 2;' })], text('Finished.'));
  try {
    for await (const ev of runTurn(app, conv.id, 'Write the two files.')) {
      if (ev.type !== 'approval') continue;
      if (ev.id === 'second') {
        assert.equal(readFileSync(join(ws, 'first.ts'), 'utf8'), 'export const first = 1;');
        assert.equal(existsSync(join(ws, '.diagnostics-started')), false);
        if (mutation === 'workspace') app.store.updateConversation(conv.id, { workspace: 'moved' });
        if (mutation === 'private') app.store.updateConversation(conv.id, { private: true });
      }
      app.approvals.decide(ev.approvalId, true);
    }
    assert.equal(existsSync(join(ws, '.diagnostics-started')), mutation === 'allow', 'no diagnostic process may start in the invalidated context');
    const receipts = app.store.messages(conv.id).filter(m => m.role === 'tool');
    assert.equal(receipts[0].meta?.status, 'ok', 'the completed first edit remains successful');
    assert.equal(receipts[1].meta?.status, mutation === 'allow' ? 'ok' : 'denied');
    assert.equal(existsSync(join(ws, 'second.ts')), mutation === 'allow');
  } finally { closeChecks(app); app.store.close(); cleanup(); }
});

for (const mutation of ['allow', 'mode'] as const) test(`review regression: team planning import wait ${mutation}`, async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString() });
  const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
  app.script.push(text(JSON.stringify({ steps: [{ helper: 'writer', title: 'Finish', instructions: 'Reply Done.' }] })), text('Done.'), text('Finished.'));
  app.team = new TeamManager(app, app.store.db);
  try {
    const task = app.team.start(conv.id, 'Plan the synthetic task.');
    if (mutation === 'mode') app.store.updateConversation(conv.id, { mode: 'chat' });
    await app.team.finished(task.id);
    assert.equal(app.requests.length, mutation === 'allow' ? 3 : 0, 'no planning provider starts after the import wait invalidates original scope');
  } finally { app.store.close(); cleanup(); }
});

for (const mutation of ['allow', 'checkpoint-mode', 'checkpoint-partner', 'checkpoint-channel', 'checkpoint-project', 'checkpoint-archived', 'checkpoint-private', 'after-commit', 'after-diff', 'after-review'] as const) test(`review regression: team publication ${mutation}`, async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString() });
  const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  const mutate = () => {
    if (mutation === 'checkpoint-partner') app.store.db.prepare('UPDATE conversations SET partner = ? WHERE id = ?').run('Synthetic guest', conv.id);
    else if (mutation === 'checkpoint-channel') app.store.db.prepare('UPDATE conversations SET channel = ?, channel_key = ? WHERE id = ?').run('discord', 'synthetic-room', conv.id);
    else if (mutation === 'checkpoint-project') app.store.updateConversation(conv.id, { projectId: 42 });
    else if (mutation === 'checkpoint-archived') app.store.updateConversation(conv.id, { archived: true });
    else if (mutation === 'checkpoint-private') app.store.updateConversation(conv.id, { private: true });
    else app.store.updateConversation(conv.id, { mode: 'chat' });
  };
  for (const name of ['git_commit', 'git_push', 'github_open_pr']) app.tools.add({
    spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => name,
    async run() {
      writeFileSync(join(ws, `${name}.effect`), 'synthetic completed effect');
      if (name === 'git_commit' && mutation === 'after-commit') { await Promise.resolve(); mutate(); }
      return name === 'github_open_pr' ? 'Opened https://github.com/synthetic/fixture/pull/7' : 'completed';
    },
  });
  const actualFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.github.com/repos/synthetic/fixture/pulls/7'), `Unexpected synthetic request ${u}`);
    if (u.endsWith('/reviews')) { posts++; writeFileSync(join(ws, 'review-posted.effect'), 'posted'); return new Response(JSON.stringify({ id: 1 })); }
    if ((init?.headers as Record<string, string>)?.accept === 'application/vnd.github.diff') {
      await Promise.resolve();
      if (mutation === 'after-diff') mutate();
      return new Response('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n');
    }
    return new Response(JSON.stringify({ title: 'Synthetic change', head: { sha: 'synthetic' } }));
  }) as typeof fetch;
  app.vault.set('git:github', 'synthetic-fixture-token');
  const factory = app.providerFactory!;
  app.providerFactory = config => {
    const provider = factory(config);
    return { config: provider.config, listModels: () => provider.listModels(), async *stream(request) {
      yield* provider.stream(request);
      if (mutation === 'after-review' && String(request.messages[0]?.content).startsWith('Review pull request')) mutate();
    } };
  };
  app.script.push(text('Done.'), text(JSON.stringify({ summary: 'Synthetic review.', verdict: 'approve', comments: [] })), text('Finished.'));
  app.team = new TeamManager(app, app.store.db);
  let taskId: number | undefined;
  try {
    const task = app.team.start(conv.id, 'Finish the synthetic task.', { plan: [{ helper: 'writer', title: 'Finish', instructions: 'Reply Done.' }], workflow: { checkpoints: true, pr: true } });
    taskId = task.id;
    await waitFor(() => app.team!.get(task.id)?.checkpoint?.kind === 'plan' ? true : undefined);
    app.team.answer(task.id, 'go');
    await waitFor(() => app.team!.get(task.id)?.checkpoint?.kind === 'pr' ? true : undefined);
    if (mutation.startsWith('checkpoint-')) mutate();
    app.team.answer(task.id, 'go');
    const done = await app.team.finished(task.id);
    assert.equal(existsSync(join(ws, 'git_commit.effect')), !mutation.startsWith('checkpoint-'));
    assert.equal(existsSync(join(ws, 'git_push.effect')), !mutation.startsWith('checkpoint-') && mutation !== 'after-commit');
    assert.equal(posts, mutation === 'allow' ? 1 : 0, 'review publication must use the original scope');
    if (mutation === 'checkpoint-private') {
      assert.equal(done.steps[0].status, 'done', 'completed local work stays done');
      const held = done.steps.at(-1)!;
      assert.equal(held.helper, 'lead');
      assert.equal(held.status, 'failed');
      assert.match(held.because ?? '', /privacy/);
      assert.ok(held.receipts.some(r => r.name === 'github_open_pr' && r.status === 'denied'));
    }
    if (mutation === 'after-commit') assert.equal(done.steps.at(-1)!.receipts[0].status, 'ok', 'already completed commit remains recorded');
    if (mutation === 'after-diff' || mutation.startsWith('checkpoint-') || mutation === 'after-commit') assert.equal(app.requests.length, 1, 'no further provider call after context change');
    if (mutation === 'after-review') {
      assert.equal(app.requests.length, 2, 'completed review is preserved but no report model follows invalidation');
      assert.ok(done.steps.at(-1)!.receipts.some(r => r.name === 'review_code' && r.status === 'ok'));
      assert.ok(done.steps.at(-1)!.receipts.some(r => r.name === 'github_post_review' && r.status === 'denied'));
    }
  } finally {
    if (taskId) { app.team.stop(taskId); await app.team.finished(taskId).catch(() => {}); }
    globalThis.fetch = actualFetch;
    app.store.close(); cleanup();
  }
});

for (const engine of ['main', 'team'] as const) {
  for (const mutation of ['allow', 'deny', 'never', 'workspace', 'private', 'remove', 'replace', 'unavailable', 'delete', 'rename', 'loosen', 'never-workspace'] as const) {
    test(`current admission: ${engine} HTTP approval ${mutation}`, async () => {
      const { dir, cleanup } = tempDir();
      const now = new Date('2026-11-05T12:00:00Z');
      const app = makeApp(dir, { now });
      let available = true;
      const tool = { ...writeFileTool, isAvailable: () => available };
      app.tools.add(tool);
      app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', ownerName: 'Alex', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'ask' } });
      if (engine === 'team') app.team = new TeamManager(app, app.store.db);
      const auth = new OwnerAuth(dir, () => now);
      const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const api = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let conversationId = '';
      let taskId: number | undefined;
      let completion: Promise<unknown> | undefined;
      try {
        const created = await api('/api/conversations', 'POST', { mode: 'coding', workspace: 'original', title: 'Synthetic admission' });
        assert.equal(created.status, 201);
        const conv = await created.json() as { id: string; workspace: string };
        conversationId = conv.id;
        const original = join(workspaceDir(dir, 'original'), 'effect.txt');
        const moved = join(workspaceDir(dir, 'moved'), 'effect.txt');
        app.script.push([call('write', 'write_file', { path: 'effect.txt', content: 'synthetic write' })], text('Finished.'));
        let events: { type: string; status?: string }[] = [];
        if (engine === 'main') completion = api(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'Write effect.txt.' }).then(async r => {
          assert.equal(r.status, 200);
          events = (await r.text()).split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
        });
        else {
          app.script.push(text('Finished.'));
          const task = app.team!.start(conv.id, 'Write the synthetic fixture file.', { plan: [{ helper: 'writer', title: 'Write', instructions: 'Write effect.txt.' }] });
          taskId = task.id;
          completion = app.team!.finished(task.id);
        }
        const pending = await waitFor(() => app.approvals.pendingFor(conv.id)[0]);
        const requestsBefore = app.requests.length;
        assert.equal(existsSync(original), false);
        assert.equal(existsSync(moved), false);
        if (mutation === 'rename') assert.equal((await api(`/api/conversations/${conv.id}`, 'PATCH', { title: 'Renamed synthetic conversation' })).status, 200);
        if (mutation === 'loosen') assert.equal((await api('/api/tools', 'PUT', { permissions: { write_file: 'auto' } })).status, 200);
        if (mutation === 'never' || mutation === 'never-workspace') assert.equal((await api('/api/tools', 'PUT', { permissions: { write_file: 'never' } })).status, 200);
        if (mutation === 'workspace' || mutation === 'private' || mutation === 'never-workspace') assert.equal((await api(`/api/conversations/${conv.id}`, 'PATCH', mutation !== 'private' ? { workspace: 'moved' } : { private: true })).status, 200);
        if (mutation === 'remove') app.tools.remove('write_file');
        if (mutation === 'replace') app.tools.add({ ...tool });
        if (mutation === 'unavailable') available = false;
        if (mutation === 'delete') assert.equal((await api(`/api/conversations/${conv.id}`, 'DELETE')).status, 200);
        const decided = await api(`/api/approvals/${pending}`, 'POST', { approved: mutation !== 'deny' });
        assert.equal(decided.status, mutation === 'delete' && engine === 'main' ? 404 : 200);
        await completion;
        if (['workspace', 'private', 'delete', 'never-workspace'].includes(mutation)) assert.equal(app.requests.length, requestsBefore, 'changed context must stop further provider requests');
        const allowed = ['allow', 'rename', 'loosen'].includes(mutation);
        assert.equal(existsSync(original), allowed, `${engine}/${mutation} must not perform a stale effect`);
        assert.equal(existsSync(moved), false);
        if (allowed) assert.equal(readFileSync(original, 'utf8'), 'synthetic write');
        else if (mutation !== 'delete') {
          if (engine === 'main') assert.ok(events.some(e => e.type === 'tool_result' && e.status === 'denied'));
          else assert.equal(app.team!.get(taskId!)!.steps[0].receipts[0].status, 'denied');
        }
      } finally {
        if (conversationId) app.stopTurn?.(conversationId);
        if (taskId) app.team?.stop(taskId);
        await completion?.catch(() => {});
        await new Promise<void>(r => server.close(() => r()));
        app.store.close(); cleanup();
      }
    });
  }
}

for (const permission of ['never', 'ask'] as const) test(`current admission: async beforeTool tightens auto to ${permission}`, async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'auto' } });
  const conv = app.store.createConversation({ workspace: 'original' });
  app.script.push([call('write', 'write_file', { path: 'effect.txt', content: 'synthetic' })], text('Finished.'));
  let snapshots = 0;
  const take = app.snapshots.take.bind(app.snapshots);
  app.snapshots.take = (...args) => { snapshots++; return take(...args); };
  try {
    const events = [];
    for await (const ev of runTurn(app, conv.id, 'Write the file.', undefined, { hooks: { async beforeTool() { await Promise.resolve(); app.settings.update({ toolPermissions: { write_file: permission } }); } } })) {
      events.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
    }
    assert.equal(existsSync(join(workspaceDir(dir, conv.workspace), 'effect.txt')), false);
    assert.equal(snapshots, 0);
    assert.ok(events.some(e => e.type === 'tool_result' && e.status === 'denied'));
  } finally { app.store.close(); cleanup(); }
});

const COPY = { driver: 'copy' as const, isolated: false, label: 'test copy', detail: 'synthetic fixture' };

for (const engine of ['main', 'team'] as const) for (const mutation of ['allow', 'apply-never', 'apply-workspace', 'real-never', 'fallback-ask', 'before-try-never', 'after-try-never', 'network-off'] as const) {
  test(`current admission: ${engine} sandbox ${mutation}`, async () => {
    const { dir, cleanup } = tempDir();
    const now = new Date('2026-11-05T12:00:00Z');
    const app = makeApp(dir, { now });
    app.tools.add(shellTool);
    app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { shell: mutation === 'before-try-never' ? 'ask' : 'auto' }, sandboxGate: { mode: 'every' } });
    const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
    const ws = workspaceDir(dir, conv.workspace);
    app.sandboxGate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), app.sandbox, () => sandboxGateSettings(app.settings.get()), () => COPY);
    const plan = app.sandboxGate.plan.bind(app.sandboxGate);
    let tries = 0;
    app.sandboxGate.plan = (input) => {
      const result = plan(input);
      if (!result) return result;
      const run = result.run;
      result.run = async signal => {
        tries++;
        if (mutation === 'fallback-ask') {
          await Promise.resolve();
          app.settings.update({ toolPermissions: { shell: 'ask' } });
          throw new Error('Synthetic sandbox setup failure');
        }
        const tried = await run(signal);
        if (mutation === 'after-try-never') app.settings.update({ toolPermissions: { shell: 'never' } });
        return tried;
      };
      return result;
    };
    app.script.push([call('shell', 'shell', { command: 'echo synthetic > effect.txt' })], text('Finished.'), text('Finished.'));
    const answer = (id: string) => {
      if (mutation === 'network-off') app.settings.update({ shellNetwork: false });
      if (mutation.includes('never')) app.settings.update({ toolPermissions: { shell: 'never' } });
      if (mutation === 'apply-workspace') app.store.updateConversation(conv.id, { workspace: 'moved' });
      app.approvals.decide(id, true, mutation === 'real-never' ? 'real' : 'apply');
    };
    let completion: Promise<unknown> | undefined;
    let taskId: number | undefined;
    try {
      if (engine === 'main') {
        const events = [];
        for await (const ev of runTurn(app, conv.id, 'Create the synthetic file.')) {
          events.push(ev);
          if (ev.type === 'approval') answer(ev.approvalId);
        }
        assert.ok(events.some(e => e.type === 'tool_result' && e.status === (mutation === 'allow' ? 'ok' : 'denied')));
        if (mutation === 'after-try-never') assert.ok(events.some(e => e.type === 'sandbox' && e.record.decision === 'cancelled'), 'the completed sandbox try remains recorded');
      } else {
        app.team = new TeamManager(app, app.store.db);
        const task = app.team.start(conv.id, 'Create the synthetic file.', { plan: [{ helper: 'coder', title: 'Write', instructions: 'Create effect.txt.' }] });
        taskId = task.id;
        let done = false;
        completion = app.team.finished(task.id).finally(() => { done = true; });
        const until = Date.now() + 20000;
        while (!done && Date.now() < until) {
          for (const id of app.approvals.pendingFor(conv.id)) answer(id);
          await new Promise(r => setTimeout(r, 5));
        }
        assert.equal(done, true);
        await completion;
        assert.equal(app.team.get(task.id)!.steps[0].receipts[0].status, mutation === 'allow' ? 'ok' : 'denied');
      }
      assert.equal(existsSync(join(ws, 'effect.txt')), mutation === 'allow');
      assert.equal(existsSync(join(workspaceDir(dir, 'moved'), 'effect.txt')), false);
      assert.equal(tries, mutation === 'before-try-never' ? 0 : 1);
    } finally {
      if (taskId) app.team?.stop(taskId);
      await completion?.catch(() => {});
      app.store.close(); cleanup();
    }
  });
}

test('current admission: Apply rechecks after its asynchronous workspace reference before copying', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-05T12:00:00Z') });
  const conv = app.store.createConversation({ workspace: 'original' });
  const ws = workspaceDir(dir, conv.workspace);
  const copy = join(dir, 'isolated-copy', 'ws');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'effect.txt'), 'synthetic');
  const result: SandboxResult = { id: 'synthetic', command: 'fixture', workspaceDir: ws, isolation: COPY, network: false, copy: null, run: null, changes: { added: [{ path: 'effect.txt', size: 9 }], changed: [], removed: [] }, findings: [], verdict: 'clean', ms: 0, copyDir: copy };
  app.settings.update({ toolPermissions: { write_file: 'auto' } });
  const scope = captureToolScope(conv, conv.workspace, false);
  try {
    const applying = applySandbox(result, () => { assertToolAdmission(app, scope, writeFileTool, new AbortController().signal, { workspace: conv.workspace, privateLocal: false, offServer: false }); });
    app.settings.update({ toolPermissions: { write_file: 'never' } });
    await assert.rejects(applying, ToolAdmissionError);
    assert.equal(existsSync(join(ws, 'effect.txt')), false);
  } finally { discardSandbox(result); app.store.close(); cleanup(); }
});


for (const engine of ['main', 'team'] as const) for (const mutation of ['never-before-prepare', 'workspace-before-tool'] as const) {
  test(`current admission: ${engine} binds scope before provider await (${mutation})`, async () => {
    const { dir, cleanup } = tempDir();
    const now = new Date('2026-11-05T12:00:00Z');
    const app = makeApp(dir, { now });
    app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { write_file: 'auto' } });
    const conv = app.store.createConversation({ workspace: 'original', mode: 'coding' });
    let prepared = 0;
    app.tools.add({ ...writeFileTool, async prepare() { prepared++; return {}; } });
    const factory = app.providerFactory!;
    let mutated = false;
    app.providerFactory = config => {
      const provider = factory(config);
      return { config: provider.config, listModels: () => provider.listModels(), async *stream(request) {
        if (!mutated) {
          mutated = true;
          await Promise.resolve();
          if (mutation === 'never-before-prepare') app.settings.update({ toolPermissions: { write_file: 'never' } });
          else app.store.updateConversation(conv.id, { workspace: 'moved' });
        }
        yield* provider.stream(request);
      } };
    };
    app.script.push([call('write', 'write_file', { path: 'effect.txt', content: 'synthetic' })], text('Finished.'), text('Finished.'));
    try {
      if (engine === 'main') {
        const events = [];
        for await (const ev of runTurn(app, conv.id, 'Write the synthetic file.')) events.push(ev);
        assert.ok(events.some(e => e.type === 'tool_result' && e.status === 'denied'));
      } else {
        app.team = new TeamManager(app, app.store.db);
        const task = app.team.start(conv.id, 'Write the synthetic file.', { plan: [{ helper: 'writer', title: 'Write', instructions: 'Write effect.txt.' }] });
        await app.team.finished(task.id);
        assert.equal(app.team.get(task.id)!.steps[0].receipts[0].status, 'denied');
      }
      assert.equal(prepared, 0);
      assert.equal(existsSync(join(workspaceDir(dir, 'original'), 'effect.txt')), false);
      assert.equal(existsSync(join(workspaceDir(dir, 'moved'), 'effect.txt')), false);
      if (mutation === 'workspace-before-tool') assert.equal(app.requests.length, 1);
    } finally { app.store.close(); cleanup(); }
  });
}

test('current admission: an unchanged conversation may bind a different explicit task workspace', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-05T12:00:00Z') });
  const conv = app.store.createConversation({ workspace: 'conversation-default' });
  app.settings.update({ toolPermissions: { write_file: 'ask' } });
  const scope = captureToolScope(conv, 'explicit-task-workspace', false);
  try {
    assert.equal(assertToolAdmission(app, scope, writeFileTool, new AbortController().signal, { workspace: 'explicit-task-workspace', privateLocal: false, offServer: false }), 'ask');
    app.store.updateConversation(conv.id, { workspace: 'moved' });
    assert.throws(() => assertToolAdmission(app, scope, writeFileTool, new AbortController().signal, { workspace: 'explicit-task-workspace', privateLocal: false, offServer: false }), ToolAdmissionError);
  } finally { app.store.close(); cleanup(); }
});

test('current admission: network permission tightened during a hook prevents command startup', async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-05T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'fixture', defaultModel: 'fake-small', disclosureAcceptedAt: now.toISOString(), toolPermissions: { shell: 'auto' }, shellNetwork: true });
  const conv = app.store.createConversation({ workspace: 'original' });
  app.script.push([call('shell', 'shell', { command: 'echo synthetic > effect.txt' })], text('Finished.'));
  try {
    const events = [];
    for await (const ev of runTurn(app, conv.id, 'Create the synthetic file.', undefined, { hooks: { async beforeTool() { await Promise.resolve(); app.settings.update({ shellNetwork: false }); } } })) events.push(ev);
    assert.equal(existsSync(join(workspaceDir(dir, conv.workspace), 'effect.txt')), false);
    assert.ok(events.some(e => e.type === 'tool_result' && e.status === 'denied'));
  } finally { app.store.close(); cleanup(); }
});

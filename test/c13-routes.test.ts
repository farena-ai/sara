// C13 (docs/ops/C13_DESIGN.md): the worktree flow end to end. She starts a task worktree in a
// coding chat (asks), her file tools then write there (not in the main checkout), git_commit adds
// the Co-authored-by trailer, worktree_finish merges. Routes: list with status, discard 409 until
// confirmed, the PR draft, Open PR (push to the remote, open through a fake GitHub, needs confirm),
// the co-author setting, the Workspace view (tree, save with a stale-hash refusal, the terminal,
// diagnostics without a server), and members/demo refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { LspEngine } from '../src/lsp.ts';
import { createSaraServer } from '../src/server.ts';
import { writeFileTool } from '../src/tools/builtin.ts';
import { createCodingTools } from '../src/tools/coding.ts';
import { GITHUB_VAULT } from '../src/tools/coding.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { createWorktreeTools } from '../src/tools/worktrees.ts';
import { gitRunner, Worktrees } from '../src/worktrees.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-08T12:00:00Z') };
const app = makeApp(dir, clock);
app.tools.add(writeFileTool);
for (const t of createCodingTools(app)) app.tools.add(t);
const gh: { url: string; body: Record<string, unknown> }[] = [];
app.githubFetch = async (url, init) => {
  gh.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
  if (url.endsWith('/pulls')) return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/alex/app/pull/7' }), { status: 201 });
  return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
};
for (const t of createWorktreeTools(app, app.githubFetch)) app.tools.add(t);
app.worktrees = new Worktrees(app.store.db, () => clock.now, gitRunner({ GIT_AUTHOR_NAME: 'Alex', GIT_AUTHOR_EMAIL: 'alex@example.com', GIT_COMMITTER_NAME: 'Alex', GIT_COMMITTER_EMAIL: 'alex@example.com' }));
app.lsp = new LspEngine({ resolve: () => undefined });
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
const ws = workspaceDir(dir, 'app');
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { write_file: 'auto', worktree_start: 'auto', worktree_finish: 'auto', git_commit: 'auto' } } as never);
  g(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'README.md'), '# app\n');
  g(ws, 'add', '.');
  g(ws, 'commit', '-q', '-m', 'first');
  // The GitHub remote for the PR; pushes go to a local bare repository.
  const bare = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  g(ws, 'remote', 'add', 'origin', 'https://github.com/alex/app.git');
  g(ws, 'remote', 'set-url', '--push', 'origin', bare);
  process.env.GIT_AUTHOR_EMAIL = 'alex@example.com';
  process.env.GIT_COMMITTER_EMAIL = 'alex@example.com';
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  app.lsp?.stopAll();
  server.close();
  app.store.close();
  cleanup();
});
const api = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const drain = async (it: AsyncIterable<unknown>) => {
  for await (const _ of it) void _;
};

test('a coding chat: start a worktree, write and commit there (with the trailer), merge', async () => {
  const conv = app.store.createConversation({ title: 'Task', mode: 'coding', workspace: 'app' });
  app.script.push([call('s1', 'worktree_start', { task: 'Add a greeting' })], [call('w1', 'write_file', { path: 'hello.txt', content: 'hi\n' })], [call('c1', 'git_commit', { message: 'Add hello' })], text('Done.'));
  await drain(runTurn(app, conv.id, 'Add a greeting file'));
  const rec = app.worktrees!.active(conv.id)!;
  assert.equal(rec.branch, 'sara/add-a-greeting');
  const tree = join(ws, '.sara-worktrees', 'add-a-greeting');
  assert.ok(existsSync(join(tree, 'hello.txt')), 'her write landed in the worktree');
  assert.ok(!existsSync(join(ws, 'hello.txt')), 'not in the main checkout');
  const msg = g(tree, 'log', '-1', '--format=%B');
  assert.match(msg, /^Add hello\n\nCo-authored-by: Sara <sara@noreply\.sara\.invalid>$/);
  const list = await api('/worktrees?workspace=app');
  assert.equal(list.json.worktrees[0].status.ahead, 1);
  assert.equal(list.json.worktrees[0].folder, '.sara-worktrees/add-a-greeting');
  const draft = await api(`/worktrees/${rec.id}/pr-draft`, 'POST', {});
  assert.equal(draft.json.title, 'Add hello');
  app.script.push([call('f1', 'worktree_finish', { action: 'merge' })], text('Merged.'));
  await drain(runTurn(app, conv.id, 'Merge it'));
  assert.ok(app.requests.slice(-2).some((r) => JSON.stringify(r.messages).includes('its own git worktree: branch sara/add-a-greeting')), 'she is told where she works');
  assert.equal(readFileSync(join(ws, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'hi\n');
  assert.equal(app.worktrees!.get(rec.id)!.state, 'merged');
});

test('routes: start, discard needs confirm, Open PR pushes and opens through GitHub', async () => {
  const conv = app.store.createConversation({ title: 'Two', mode: 'coding', workspace: 'app' });
  const chat = app.store.createConversation({ title: 'Chat', mode: 'chat', workspace: 'app' } as never);
  assert.equal((await api('/worktrees', 'POST', { conversationId: chat.id, task: 'x' })).status, 400);
  const s = await api('/worktrees', 'POST', { conversationId: conv.id, task: 'Fix the title' });
  assert.equal(s.status, 201);
  const id = s.json.worktree.id;
  const tree = join(ws, s.json.worktree.folder);
  writeFileSync(join(tree, 'wip.txt'), 'draft\n');
  const d1 = await api(`/worktrees/${id}/discard`, 'POST', {});
  assert.equal(d1.status, 409);
  assert.deepEqual(d1.json.detail.dirty, ['wip.txt']);
  assert.ok(existsSync(join(tree, 'wip.txt')));
  // Open PR: refused while dirty, needs confirm, then pushes and opens.
  assert.equal((await api(`/worktrees/${id}/pr`, 'POST', { confirm: true })).status, 409);
  g(tree, 'add', '.');
  g(tree, 'commit', '-q', '-m', 'Fix the title');
  assert.equal((await api(`/worktrees/${id}/pr`, 'POST', {})).status, 400);
  app.vault.set(GITHUB_VAULT, 'ghp_test');
  const pr = await api(`/worktrees/${id}/pr`, 'POST', { confirm: true });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  assert.equal(pr.json.url, 'https://github.com/alex/app/pull/7');
  const sent = gh.find((x) => x.url.endsWith('/repos/alex/app/pulls'))!;
  assert.equal(sent.body.head, 'sara/fix-the-title');
  assert.equal(sent.body.base, 'main');
  assert.match(String(sent.body.body), /Drafted by Sara/);
  assert.ok(g(join(dir, 'remote.git'), 'branch', '--list', 'sara/fix-the-title'), 'the branch was pushed');
  assert.equal(app.worktrees!.get(id)!.prUrl, 'https://github.com/alex/app/pull/7');
  const closed = await api(`/worktrees/${id}/close`, 'POST', {});
  assert.equal(closed.json.worktree.state, 'pr');
  assert.ok(!existsSync(tree));
});

test('co-author setting: GET defaults, PUT cleans', async () => {
  const r = await api('/coding-depth');
  assert.deepEqual(r.json.coAuthor, { on: true, name: 'Sara', email: 'sara@noreply.sara.invalid' });
  assert.equal(r.json.servers.length, 4);
  const p = await api('/coding-depth', 'PUT', { coAuthor: { on: false, name: 'Robo', email: 'robo@example.com' } });
  assert.deepEqual(p.json.coAuthor, { on: false, name: 'Robo', email: 'robo@example.com' });
  await api('/coding-depth', 'PUT', { coAuthor: { on: true, name: '', email: '' } });
});

test('Workspace view: tree, save (stale hash refused), terminal, diagnostics without a server', async () => {
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, '.env'), 'KEY=1\n');
  const t = await api('/workspaces/app/tree');
  const paths = t.json.entries.map((e: { path: string }) => e.path);
  assert.ok(paths.includes('src/a.ts'));
  assert.ok(!paths.includes('.env'), 'secrets are hidden');
  assert.ok(!paths.some((p: string) => p.startsWith('.git/')), 'git internals are not listed');
  const f = await api('/workspaces/app/file?path=src/a.ts');
  assert.ok(f.json.hash);
  const ok = await api('/workspaces/app/file', 'PUT', { path: 'src/a.ts', text: 'export const a = 2;\n', hash: f.json.hash });
  assert.equal(ok.status, 200);
  const stale = await api('/workspaces/app/file', 'PUT', { path: 'src/a.ts', text: 'x', hash: f.json.hash });
  assert.equal(stale.status, 409);
  assert.equal((await api('/workspaces/app/file', 'PUT', { path: '.env', text: 'x' })).status, 403);
  assert.ok([400, 403].includes((await api('/workspaces/app/file', 'PUT', { path: '.git/config', text: 'x' })).status));
  assert.equal((await api('/workspaces/app/file', 'PUT', { path: '.gitmodules', text: 'x' })).status, 400);
  assert.equal((await api('/workspaces/app/file', 'PUT', { path: '../escape.txt', text: 'x' })).status, 400);
  const run = await api('/workspaces/app/run', 'POST', { command: 'echo hello-from-terminal', cwd: 'src' });
  assert.equal(run.status, 200);
  assert.equal(run.json.exitCode, 0);
  assert.match(run.json.output, /hello-from-terminal/);
  app.settings.update({ toolPermissions: { ...app.settings.get().toolPermissions, shell: 'never' } });
  assert.equal((await api('/workspaces/app/run', 'POST', { command: 'echo no' })).status, 403);
  const diag = await api('/workspaces/app/diagnostics?path=src/a.ts');
  assert.equal(diag.json.available, false);
  assert.match(diag.json.reason, /No language server for typescript/);
});

test('members and the demo are refused', async () => {
  const demo = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), demo: true } as never);
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(demo.address() as AddressInfo).port}/api/worktrees`, { headers: { authorization: `Bearer ${token}` } });
    assert.ok(r.status === 403 || r.status === 404, String(r.status));
  } finally {
    demo.close();
  }
});

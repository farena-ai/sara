// Phase 13: background jobs, git (look freely; commit/push need approval), delegation receipts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { historyFrom } from '../src/chat.ts';
import { JobManager } from '../src/jobs.ts';
import { agentReport, createCodingTools, GITHUB_VAULT, shq } from '../src/tools/coding.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const node = JSON.stringify(process.execPath);

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.now = () => new Date();
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.jobs = new JobManager(app, app.store.db);
  const conv = app.store.createConversation();
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(ws, { recursive: true });
  const ctx: ToolContext = { workspaceDir: ws, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: '' }, conversationId: conv.id };
  const tools = Object.fromEntries(createCodingTools(app).map((x) => [x.spec.name, x]));
  t.after(() => {
    app.jobs?.stopAll();
    app.store.close();
    cleanup();
  });
  return { app, conv, ws, ctx, tools, dir };
}

test('tools: approval defaults (look freely; run, commit, branch, push and delegate ask first)', (t) => {
  const { tools } = setup(t);
  const perms = Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v.defaultPermission]));
  assert.deepEqual(perms, { start_job: 'ask', job_status: 'auto', stop_job: 'auto', git: 'auto', git_commit: 'ask', git_branch: 'ask', git_push: 'ask', delegate_task: 'ask' });
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('background job: keeps running after the tool returns; result saved as a receipt; she reports it (checked)', async (t) => {
  const { app, conv, ctx, tools } = setup(t);
  const events: string[] = [];
  app.events!.subscribe((ev) => {
    if (ev.type === 'job') events.push(ev.job.status);
  });
  const script = `${node} -e "console.log('compiling'); setTimeout(() => { console.log('12 passed, 1 failed: test_login'); process.exit(1) }, 300)"`;
  const out = await tools.start_job.run({ command: script, label: 'full test suite' }, ctx);
  assert.match(out, /Started background job #1 \(full test suite\)/);
  assert.equal(app.jobs!.running().length, 1);
  assert.match(await tools.job_status.run({ job: 1 }, ctx), /running/);
  app.script.push(text('The full test suite finished: 12 passed and 1 failed (test_login). Want me to look at it?'));
  const job = await new Promise<import('../src/jobs.ts').Job>((res) => {
    const off = app.events!.subscribe((ev) => {
      if (ev.type === 'message' && ev.reason === 'job' && ev.message.role === 'assistant') {
        off();
        res(app.jobs!.get(1)!);
      }
    });
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.exitCode, 1);
  assert.match(job.tail, /12 passed, 1 failed: test_login/);
  assert.equal(events[0], 'running');
  assert.equal(events.at(-1), 'failed');
  const msgs = app.store.messages(conv.id);
  const notice = msgs.find((m) => m.role === 'notice')!;
  assert.match(notice.content, /^job:Background job #1 failed \(exit code 1\) after .*: full test suite/);
  assert.match(msgs.at(-1)!.content, /12 passed and 1 failed/);
  // In her history the result is an app note, so later turns know what really happened.
  const hist = historyFrom(msgs);
  assert.ok(hist.some((m) => m.role === 'user' && String(m.content).startsWith('[Note from the app: Background job #1 failed')));
  // The prompt asked her to stick to the result.
  assert.match(String(app.requests.at(-1)!.messages.at(-1)!.content), /Only what the result above shows/);
});

test('background job: an invented result is replaced by the plain facts; stop works', async (t) => {
  const { app, conv, ctx, tools } = setup(t);
  await tools.start_job.run({ command: `${node} -e "console.log('ok')"`, label: 'build' }, ctx);
  app.script.push(text('Build passed and I pushed it to GitHub and deployed it.'));
  await new Promise<void>((res) => {
    const off = app.events!.subscribe((ev) => {
      if (ev.type === 'message' && ev.reason === 'job' && ev.message.role === 'assistant') (off(), res());
    });
  });
  assert.match(app.store.messages(conv.id).at(-1)!.content, /^Done: build finished/);
  // Stop a long one.
  await tools.start_job.run({ command: `${node} -e "setTimeout(() => {}, 20000)"`, label: 'long' }, ctx);
  const j = app.jobs!.running()[0];
  assert.match(await tools.stop_job.run({ job: j.id }, ctx), /Stopping/);
  for (let i = 0; i < 50 && app.jobs!.get(j.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.jobs!.get(j.id)!.status, 'stopped');
});

test('jobs: running ones are marked interrupted after a restart', (t) => {
  const { app } = setup(t);
  app.store.db.prepare("INSERT INTO jobs (conversation_id, workspace, label, status, started_at) VALUES ('c', 'main', 'x', 'running', '2026-01-01')").run();
  const again = new JobManager(app, app.store.db);
  assert.equal(again.list()[0].status, 'interrupted');
});

test('git: look, branch, commit under her name; push uses the token only for that command', { skip: !hasGit }, async (t) => {
  const { app, ws, ctx, tools, dir } = setup(t);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'sara@example.com');
  g('config', 'commit.gpgsign', 'false'); // the tester's own signing setup is not part of this test
  writeFileSync(join(ws, 'a.txt'), 'one\n');
  g('add', '.');
  g('-c', 'user.name=Owner', 'commit', '-qm', 'first');
  writeFileSync(join(ws, 'a.txt'), 'two\n');
  assert.match(await tools.git.run({ action: 'status' }, ctx), /M a\.txt/);
  assert.match(await tools.git.run({ action: 'diff' }, ctx), /-one\n\+two/);
  await assert.rejects(tools.git_branch.run({ action: 'create', name: '--force' }, ctx), /isn't allowed/);
  assert.match(await tools.git_commit.run({ message: 'Change a', new_branch: 'sara/change-a' }, { ...ctx, companionName: 'River' }), /Change a/);
  assert.equal(g('log', '-1', '--format=%an|%s').trim(), 'River|Change a');
  assert.equal(g('branch', '--show-current').trim(), 'sara/change-a');
  // Push to a local bare remote with a token set: the token is never stored in the repo.
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g('remote', 'add', 'origin', remote);
  app.vault.set(GITHUB_VAULT, 'github_pat_secretsecretsecretsecret123');
  assert.match(await tools.git_push.run({}, ctx), /sara\/change-a|new branch|->/);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'sara/change-a'], { encoding: 'utf8' }).trim(), 'Change a');
  assert.doesNotMatch(readFileSync(join(ws, '.git', 'config'), 'utf8'), /secret/);
  assert.deepEqual(g('status', '--porcelain').trim(), '', 'no helper file left behind');
});

test('delegation: the agent\'s own report is taken from its output', () => {
  const claude = 'progress...\n{"type":"result","subtype":"success","is_error":false,"num_turns":7,"result":"Added a --verbose flag and a test; npm test passes (14/14)."}\n';
  assert.equal(agentReport('claude', claude), 'Added a --verbose flag and a test; npm test passes (14/14). [7 steps]');
  assert.equal(agentReport('grok', 'thinking\nDone: fixed the off-by-one in paginate().\n'), 'thinking\nDone: fixed the off-by-one in paginate().');
});

test('delegation: changed files come from undo points before and after', (t) => {
  const { app, conv, ws } = setup(t);
  writeFileSync(join(ws, 'keep.txt'), 'a');
  writeFileSync(join(ws, 'edit.txt'), 'a');
  writeFileSync(join(ws, 'gone.txt'), 'a');
  const before = app.snapshots.take(conv.workspace, ws, 'before', conv.id).id;
  writeFileSync(join(ws, 'edit.txt'), 'b');
  writeFileSync(join(ws, 'new.txt'), 'b');
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(ws, 'gone.txt'))})`]);
  const after = app.snapshots.take(conv.workspace, ws, 'after', conv.id).id;
  assert.deepEqual(app.snapshots.compare(conv.workspace, before, after), { added: ['new.txt'], changed: ['edit.txt'], removed: ['gone.txt'] });
});

// C13 (docs/ops/C13_DESIGN.md): a managed git worktree per coding task. Start makes a branch
// sara/<slug> in <repo>/.sara-worktrees/<slug> (kept out of git status); merge brings it back into
// the base branch; discard refuses uncommitted or unmerged work until confirmed; removal unlinks
// links (Windows junctions) first, so nothing outside the worktree is ever deleted through one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/store.ts';
import { gitRunner, slugOf, unlinkLinks, WorktreeError, Worktrees } from '../src/worktrees.ts';
import { tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-08T12:00:00Z') };
const store = new Store(join(dir, 'sara.db'), () => clock.now);
after(() => {
  store.close();
  cleanup();
});
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
function repo(name: string): string {
  const ws = join(dir, 'workspaces', name);
  mkdirSync(ws, { recursive: true });
  g(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'a.txt'), 'one\n');
  g(ws, 'add', '.');
  g(ws, 'commit', '-q', '-m', 'first');
  return ws;
}
const wt = new Worktrees(store.db, () => clock.now, gitRunner({ GIT_AUTHOR_NAME: 'Sara', GIT_AUTHOR_EMAIL: 'sara@example.com', GIT_COMMITTER_NAME: 'Sara', GIT_COMMITTER_EMAIL: 'sara@example.com' }));

test('slugOf makes a short, safe branch slug', () => {
  assert.equal(slugOf('Fix the login bug!! (urgent)'), 'fix-the-login-bug-urgent');
  assert.equal(slugOf('***'), 'task');
  assert.ok(slugOf('x'.repeat(200)).length <= 40);
});

test('start makes branch sara/<slug> in .sara-worktrees, hidden from git status; merge brings it home', async () => {
  const ws = repo('app');
  const rec = await wt.start({ conversationId: 'c1', workspace: 'app', wsDir: ws, task: 'Add a greeting' });
  assert.equal(rec.branch, 'sara/add-a-greeting');
  assert.equal(rec.base, 'main');
  assert.equal(rec.dir, '.sara-worktrees/add-a-greeting');
  const full = wt.dirOf(rec, ws);
  assert.ok(existsSync(join(full, 'a.txt')));
  assert.equal(g(full, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sara/add-a-greeting');
  assert.equal(g(ws, 'status', '--porcelain'), '', 'the worktree folder is excluded from the main checkout');
  assert.equal(wt.active('c1')?.id, rec.id);
  // A second start for the same task gets its own slug.
  await assert.rejects(wt.start({ conversationId: 'c1', workspace: 'app', wsDir: ws, task: 'Other' }), (e: Error) => e instanceof WorktreeError && e.code === 'active');
  writeFileSync(join(full, 'b.txt'), 'hello\n');
  let st = await wt.status(rec, ws);
  assert.deepEqual(st.dirty, ['b.txt']);
  await assert.rejects(wt.merge(rec, ws), (e: Error) => e instanceof WorktreeError && e.code === 'dirty');
  g(full, 'add', '.');
  g(full, 'commit', '-q', '-m', 'Add greeting');
  st = await wt.status(rec, ws);
  assert.equal(st.ahead, 1);
  assert.deepEqual(st.commits, ['Add greeting']);
  const done = await wt.merge(rec, ws);
  assert.equal(done.state, 'merged');
  assert.equal(readFileSync(join(ws, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'hello\n');
  assert.ok(!existsSync(full), 'the worktree is removed after merging');
  assert.equal(g(ws, 'branch', '--list', 'sara/add-a-greeting'), '', 'the merged branch is deleted');
  assert.equal(wt.active('c1'), undefined);
});

test('discard refuses uncommitted or unmerged work until confirmed, then removes it', async () => {
  const ws = repo('app2');
  const rec = await wt.start({ conversationId: 'c2', workspace: 'app2', wsDir: ws, task: 'Try something' });
  const full = wt.dirOf(rec, ws);
  writeFileSync(join(full, 'draft.txt'), 'wip\n');
  await assert.rejects(wt.discard(rec, ws), (e: Error) => e instanceof WorktreeError && e.code === 'unsaved' && /draft\.txt/.test(JSON.stringify(e.detail)));
  assert.ok(existsSync(join(full, 'draft.txt')), 'nothing deleted without asking');
  const done = await wt.discard(rec, ws, { confirm: true });
  assert.equal(done.state, 'discarded');
  assert.ok(!existsSync(full));
  assert.equal(g(ws, 'branch', '--list', 'sara/try-something'), '');
});

test('removal unlinks links first: a junction/link to a folder outside is never deleted through', async () => {
  const ws = repo('app3');
  const outside = join(dir, 'real_node_modules');
  mkdirSync(join(outside, 'pkg'), { recursive: true });
  writeFileSync(join(outside, 'pkg', 'index.js'), 'keep me\n');
  const rec = await wt.start({ conversationId: 'c3', workspace: 'app3', wsDir: ws, task: 'Link test' });
  const full = wt.dirOf(rec, ws);
  symlinkSync(outside, join(full, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(unlinkLinks(join(dir, 'nothing-here')), 0);
  await wt.discard(rec, ws, { confirm: true });
  assert.ok(!existsSync(full));
  assert.equal(readFileSync(join(outside, 'pkg', 'index.js'), 'utf8'), 'keep me\n', 'the linked folder survives');
});

test('a merge conflict is aborted and reported; the worktree stays', async () => {
  const ws = repo('app4');
  const rec = await wt.start({ conversationId: 'c4', workspace: 'app4', wsDir: ws, task: 'Conflict' });
  const full = wt.dirOf(rec, ws);
  writeFileSync(join(full, 'a.txt'), 'theirs\n');
  g(full, 'commit', '-q', '-am', 'change in task');
  writeFileSync(join(ws, 'a.txt'), 'ours\n');
  g(ws, 'commit', '-q', '-am', 'change on main');
  await assert.rejects(wt.merge(rec, ws), (e: Error) => e instanceof WorktreeError && e.code === 'conflict');
  assert.equal(g(ws, 'status', '--porcelain'), '', 'the merge was aborted');
  assert.ok(existsSync(full));
  assert.equal(wt.get(rec.id)?.state, 'active');
  assert.equal(wt.list({ workspace: 'app4' }).length, 1);
});

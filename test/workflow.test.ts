// Phase 40: coding workflows. Project knowledge, review mode, plan → build → test → pull request
// with checkpoints, a task that survives a restart, and GitHub issues becoming tasks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { formatReview, parseDiff, reviewDiff } from '../src/codereview.ts';
import { checkIssues, cleanWatch, watchSettings } from '../src/issues.ts';
import { createProjectNoteTool, findRepos, ProjectKnowledgeStore, projectSection, scanProject } from '../src/projectknow.ts';
import { TeamManager } from '../src/team.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-28T15:00:00Z') };
const app = makeApp(dir, clock);
app.team = new TeamManager(app, app.store.db);
app.projects = new ProjectKnowledgeStore(app, app.store.db);
app.tools.add(createProjectNoteTool(() => app));
const realFetch = globalThis.fetch;
before(() => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { write_file: 'auto', project_note: 'auto' } });
});
after(() => {
  globalThis.fetch = realFetch;
  app.store.close();
  try {
    cleanup();
  } catch {
    /* Windows */
  }
});

function makeRepo(ws: string): void {
  mkdirSync(join(ws, 'shop', 'src'), { recursive: true });
  writeFileSync(join(ws, 'shop', 'package.json'), JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test', build: 'tsc', lint: 'eslint .' }, engines: { node: '>=22' } }));
  writeFileSync(join(ws, 'shop', 'AGENTS.md'), '# Rules\nUse tabs. Never edit generated files in dist/.\n');
  writeFileSync(join(ws, 'shop', 'README.md'), '# Shop\nA tiny shop.\n');
  writeFileSync(join(ws, 'shop', 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }');
  writeFileSync(join(ws, 'shop', 'src', 'price.ts'), 'export const x = 1;\n');
  writeFileSync(join(ws, 'shop', 'src', 'cart.js'), 'export const y = 2;\n');
  const g = (...a: string[]) => execFileSync('git', ['-C', join(ws, 'shop'), ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'First commit');
  g('remote', 'add', 'origin', 'https://github.com/alex/shop.git');
}

test('project knowledge: commands, layout, rules and repo from the files; notes; in coding prompts', async () => {
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  makeRepo(ws);
  assert.deepEqual(findRepos(ws).map((d) => d.split(/[\\/]/).pop()), ['shop']);
  const f = scanProject(ws, join(ws, 'shop'));
  assert.equal(f.path, 'shop');
  assert.equal(f.name, 'shop');
  assert.equal(f.repo, 'alex/shop');
  assert.deepEqual(f.commands, { test: 'npm test', build: 'npm run build', lint: 'npm run lint' });
  assert.ok(f.languages.some((l) => l.startsWith('TypeScript')) && f.languages.some((l) => l.startsWith('JavaScript')));
  assert.ok(f.conventions.includes('ES modules (package.json "type": "module")') && f.conventions.includes('TypeScript strict mode') && f.conventions.includes('Node >=22'));
  assert.match(f.rules!, /AGENTS\.md:\n# Rules\nUse tabs/);
  assert.deepEqual(f.recentCommits, ['First commit']);
  // Her note, kept per project (no duplicates).
  const out = await app.tools.get('project_note')!.run({ note: 'Run npm run build before the tests', kind: 'command' }, { workspaceDir: ws, signal: new AbortController().signal, sandbox: app.sandbox, conversationId: conv.id });
  assert.equal(out, 'Noted for shop: (command) Run npm run build before the tests');
  app.projects!.addNote(conv.workspace, 'shop', 'command', 'run npm run build before the tests');
  const k = app.projects!.get(conv.workspace);
  assert.equal(k[0].notes.length, 1);
  const sec = projectSection(k)!;
  assert.match(sec, /^shop \(folder shop\), GitHub alex\/shop, default branch main/);
  assert.match(sec, /Commands: test: `npm test`, build: `npm run build`, lint: `npm run lint`/);
  assert.match(sec, /Notes you kept:\n- \(command\) Run npm run build before the tests/);
  // In a coding conversation's instructions (not in a chat one).
  app.script.push(text('ok'));
  for await (const _ of runTurn(app, conv.id, 'how do I run the tests?')) void _;
  assert.match(String(app.requests.at(-1)!.messages[0].content), /## This project\nWhat you know about the code here[\s\S]*Use tabs\. Never edit generated files/);
  const chat = app.store.createConversation();
  app.script.push(text('hi'));
  for await (const _ of runTurn(app, chat.id, 'hi')) void _;
  assert.doesNotMatch(String(app.requests.at(-1)!.messages[0].content), /## This project/);
});

const DIFF = `diff --git a/src/price.js b/src/price.js
index 1..2 100644
--- a/src/price.js
+++ b/src/price.js
@@ -1,3 +1,6 @@
 export function total(items) {
-  return items.reduce((s, i) => s + i.price, 0);
+  return items.reduce((s, i) => s + i.price * i.quantity, 0);
 }
+export function discount(a, p) {
+  return a - a * p / 100;
+}
diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+# Shop
`;

test('review mode: comments only on real files and lines in the diff; a "must" means changes needed', async () => {
  const p = parseDiff(DIFF);
  assert.deepEqual(p.files.map((f) => [f.path, [...f.lines]]), [['src/price.js', [1, 2, 3, 4, 5, 6]], ['README.md', [1]]]);
  assert.equal(p.additions, 5);
  assert.equal(p.deletions, 1);
  app.script.push(text(JSON.stringify({ summary: 'Fixes total; adds discount.', verdict: 'approve', comments: [
    { file: 'src/price.js', line: 5, severity: 'must', comment: 'discount() does not check that p is 0 to 100.' },
    { file: 'src/price.js', line: 99, severity: 'nit', comment: 'Line not in the diff.' },
    { file: 'nope.js', line: 1, severity: 'should', comment: 'Not a file in the diff.' },
  ] })));
  const r = await reviewDiff(app, app.store.createConversation({ mode: 'coding' }), DIFF, 'your uncommitted changes');
  assert.equal(r.verdict, 'changes', 'a must-fix means changes needed, whatever the model said');
  assert.deepEqual(r.comments.map((c) => [c.file, c.line ?? null, c.severity]), [['src/price.js', 5, 'must'], ['src/price.js', null, 'nit']]);
  assert.match(formatReview(r), /^Review of your uncommitted changes: 2 files, \+5 −1\. Verdict: changes needed\.\nFixes total; adds discount\.\nComments:\n- src\/price\.js:5 \[must\] discount\(\)/);
});

const fakeTool = (name: string, out: (a: Record<string, unknown>) => string, log: { name: string; args: Record<string, unknown> }[]): Tool => ({
  defaultPermission: 'ask',
  spec: { name, description: name, parameters: { type: 'object', properties: {} } },
  summarize: () => name,
  async run(args) {
    log.push({ name, args });
    return out(args);
  },
});

test('workflow: stops at the plan for your OK, then build → test → pull request (with her posted review)', async () => {
  const log: { name: string; args: Record<string, unknown> }[] = [];
  app.tools.add(fakeTool('git_commit', (a) => `[${String(a.new_branch)} abc123] ${String(a.message).split('\n')[0]}`, log));
  app.tools.add(fakeTool('git_push', (a) => `pushed ${String(a.branch)}`, log));
  app.tools.add(fakeTool('github_open_pr', () => 'Opened pull request #7 (sara/x → main): https://github.com/alex/shop/pull/7', log));
  const posted: unknown[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/repos/alex/shop/pulls/7') && (init?.headers as Record<string, string>)?.accept === 'application/vnd.github.diff') return new Response(DIFF);
    if (u.endsWith('/repos/alex/shop/pulls/7')) return new Response(JSON.stringify({ title: 'Add discount', head: { sha: 'abc' } }));
    if (u.endsWith('/repos/alex/shop/pulls/7/reviews')) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 1, html_url: 'https://github.com/alex/shop/pull/7#pullrequestreview-1' }));
    }
    return realFetch(url, init);
  }) as typeof fetch;
  app.vault.set('git:github', 'ghp_test');
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.length = 0;
  app.script.push(
    [call('w', 'write_file', { path: 'note.txt', content: 'hi' })],
    text('Wrote note.txt.'),
    // Her review of the pull request (coding job), then her report.
    text(JSON.stringify({ summary: 'Small and fine.', verdict: 'approve', comments: [{ file: 'src/price.js', line: 2, severity: 'nit', comment: 'Name the parameter.' }] })),
    text('Done: the pull request is open and I reviewed it.'),
  );
  const t = app.team!.start(conv.id, 'Add a note file for issue 5.', { plan: [{ helper: 'writer', title: 'Write note.txt', instructions: 'Write note.txt' }], workflow: { checkpoints: true, pr: true, repoPath: '.', issue: { repo: 'alex/shop', number: 5, title: 'Add a note', url: 'https://github.com/alex/shop/issues/5' } } });
  for (let i = 0; i < 100 && app.team!.get(t.id)!.status !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
  let v = app.team!.get(t.id)!;
  assert.equal(v.status, 'waiting');
  assert.deepEqual(v.checkpoint && { kind: v.checkpoint.kind, text: v.checkpoint.text }, { kind: 'plan', text: '1. Writer: Write note.txt' });
  assert.equal(v.steps[0].status, 'waiting', 'nothing runs before your OK');
  assert.equal(app.team!.answer(t.id, 'go'), true);
  for (let i = 0; i < 200 && !(app.team!.get(t.id)!.checkpoint?.kind === 'pr'); i++) await new Promise((r) => setTimeout(r, 10));
  v = app.team!.get(t.id)!;
  assert.equal(v.checkpoint!.kind, 'pr');
  assert.match(v.checkpoint!.text, /closes alex\/shop#5/);
  assert.equal(log.length, 0, 'no commit before the second OK');
  app.team!.answer(t.id, 'go');
  const done = await app.team!.finished(t.id);
  assert.equal(done.status, 'done', JSON.stringify(app.team!.log(t.id).map((l) => l.text)));
  assert.deepEqual(log.map((l) => l.name), ['git_commit', 'git_push', 'github_open_pr']);
  assert.match(String(log[0].args.new_branch), /^sara\/\d+-add-a-note$/);
  assert.match(String(log[0].args.message), /^Add a note \(#5\)\n\nCloses #5\./);
  assert.match(String(log[2].args.body), /^Closes #5\.\n\n\*\*Task:\*\* Add a note file/);
  assert.equal(done.workflow!.prUrl, 'https://github.com/alex/shop/pull/7');
  const lead = done.steps.at(-1)!;
  assert.equal(lead.helper, 'lead');
  assert.deepEqual(lead.receipts.map((r) => `${r.name}:${r.status}`), ['git_commit:ok', 'git_push:ok', 'github_open_pr:ok', 'review_code:ok', 'github_post_review:ok']);
  assert.deepEqual(posted, [{ event: 'COMMENT', body: '**Review by Sara** (looks good)\n\nSmall and fine.', comments: [{ path: 'src/price.js', line: 2, side: 'RIGHT', body: '[nit] Name the parameter.' }] }]);
  const msg = app.store.messages(conv.id).at(-1)!.content;
  assert.match(msg, /• Sara committed: Add a note \(#5\) \(branch sara\/\d+-add-a-note\)\n• Sara pushed sara\/\d+-add-a-note\n• Sara opened https:\/\/github\.com\/alex\/shop\/pull\/7\n• Sara reviewed the pull request: looks good \(1 comments, 0 must-fix\)\n• Sara posted the review on the pull request/);
  // "Go on, don't ask again" turns the checkpoints off for the rest of that task; "Stop" stops it.
  app.script.push(text('ok'), text('report'));
  const t2 = app.team!.start(conv.id, 'Another small thing.', { plan: [{ helper: 'writer', title: 'x', instructions: 'x' }], workflow: { checkpoints: true, pr: false } });
  for (let i = 0; i < 100 && app.team!.get(t2.id)!.status !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
  app.team!.answer(t2.id, 'skip');
  const d2 = await app.team!.finished(t2.id);
  assert.equal(d2.workflow!.checkpoints, false);
  assert.equal(d2.status, 'done');
  const t3 = app.team!.start(conv.id, 'A third thing.', { plan: [{ helper: 'writer', title: 'x', instructions: 'x' }], workflow: { checkpoints: true, pr: false } });
  for (let i = 0; i < 100 && app.team!.get(t3.id)!.status !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
  app.script.push(text('report'));
  app.team!.answer(t3.id, 'stop');
  assert.equal((await app.team!.finished(t3.id)).status, 'stopped');
});

test('a long task survives a restart: done parts stay done, the cut-off part is redone, it finishes', async () => {
  // A tool that never returns stands in for the server going down mid-part.
  app.tools.add({ defaultPermission: 'auto', spec: { name: 'hang_tool', description: 'x', parameters: { type: 'object', properties: {} } }, summarize: () => 'hang', run: () => new Promise<string>(() => {}) });
  app.settings.update({ helpers: [{ id: 'slow', name: 'Slow Sam', role: 'writer', tools: ['hang_tool'] }] });
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.length = 0;
  app.script.push(text('First part done.'), [call('h', 'hang_tool', {})]);
  const t = app.team!.start(conv.id, 'Two parts; the server restarts during the second.', { plan: [{ helper: 'writer', title: 'One', instructions: 'x' }, { helper: 'slow', title: 'Two', instructions: 'y' }] });
  for (let i = 0; i < 200 && app.team!.get(t.id)!.steps[1]?.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.team!.get(t.id)!.steps[1].status, 'running');
  // "Restart": a new manager on the same database.
  const after = new TeamManager(app, app.store.db);
  const v = after.get(t.id)!;
  assert.equal(v.status, 'interrupted');
  assert.deepEqual(v.steps.map((s) => s.status), ['done', 'waiting']);
  app.team = after;
  app.script.push(text('Second part done.'), text('All done after a restart.'));
  assert.deepEqual(after.resumeInterrupted(), [t.id]);
  const done = await after.finished(t.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.steps.map((s) => `${s.title}:${s.status}`), ['One:done', 'Two:done']);
  assert.equal(done.steps[0].report, 'First part done.', 'the first part was not redone');
  assert.ok(after.log(t.id).some((l) => l.text === 'Picked up again after a restart.'));
  app.settings.update({ helpers: [] });
});

test('GitHub issues: watch settings; the first look notes where things stand; new issues go on the planner', async () => {
  assert.throws(() => cleanWatch({ repos: ['not a repo'] }, watchSettings(app)), /isn't a repository name/);
  const w = cleanWatch({ repos: ['https://github.com/alex/shop.git', 'alex/shop'], label: 'sara', everyMinutes: 15 }, watchSettings(app));
  assert.deepEqual([w.repos, w.label, w.everyMinutes], [['alex/shop'], 'sara', 15]);
  assert.equal(cleanWatch({ everyMinutes: 5 }, w).everyMinutes, 0, 'only off, 15 or 60');
  app.settings.update({ githubWatch: w });
  let issues = [{ number: 3, title: 'Old bug', body: '', html_url: 'https://github.com/alex/shop/issues/3', labels: [{ name: 'sara' }], created_at: '2026-10-01T00:00:00Z' }];
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(issues));
  }) as typeof fetch;
  assert.deepEqual(await checkIssues(app), [], 'the first look only notes where things stand');
  assert.match(urls[0], /\/repos\/alex\/shop\/issues\?state=open&per_page=30&sort=created&direction=desc&labels=sara$/);
  issues = [{ number: 5, title: 'Add a discount', body: 'Please', html_url: 'https://github.com/alex/shop/issues/5', labels: [{ name: 'sara' }], created_at: '2026-10-28T00:00:00Z' }, ...issues, { number: 6, title: 'A PR', body: '', html_url: '', labels: [], created_at: '2026-10-28T00:00:00Z', pull_request: {} } as never];
  const fresh = await checkIssues(app);
  assert.deepEqual(fresh.map((i) => i.number), [5]);
  assert.ok(app.planner!.tasks({ status: 'all' }).some((x) => x.title === 'GitHub alex/shop#5: Add a discount'));
  const gc = app.store.listConversations().find((c) => c.title === 'GitHub issues')!;
  assert.match(app.store.messages(gc.id).at(-1)!.content, /^New on GitHub: alex\/shop#5 “Add a discount”/);
  assert.deepEqual(await checkIssues(app), [], 'not twice');
});

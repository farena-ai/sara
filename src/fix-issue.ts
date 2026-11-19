// V3.4 "Fix this issue" (docs/design/V3-FIXISSUE.md): one button next to an open GitHub issue.
// Built on what was there: Phase 40 issue workflows (src/issues.ts startFromIssue, the team in
// src/team.ts: coder → tester, sent back until the tests pass → reviewer → pull request after the
// owner's OK → her review posted), C13 task worktrees (src/worktrees.ts) and the Phase 80 sandbox
// tries of the helpers' commands. This file adds the fixed plan, the issue list with each issue's
// state, and the pull-request card (what changed, the test run, the review) that waits for the OK.
import type { AppContext } from './chat.ts';
import { openIssues, startFromIssue, watchSettings, type OpenIssue } from './issues.ts';
import { taskDir, teamHelpers, verdict, type TeamTask } from './team.ts';
import { ToolError } from './tools/types.ts';
import { gitRunner } from './worktrees.ts';

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export type FixState = 'working' | 'ready' | 'waiting' | 'pr' | 'done' | 'failed' | 'stopped' | 'limit' | 'interrupted';
export interface FixView {
  task: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  conversationId: string;
  state: FixState;
  branch: string | null;
  prUrl: string | null;
  at: string;
}
export interface PrCard {
  branch: string;
  base: string;
  files: { path: string; added: number; removed: number }[];
  /** The tester's last command and whether it passed (its exit code, not its words). */
  tests: { command: string; ok: boolean } | null;
  /** The reviewer's last verdict. */
  review: { ok: boolean; detail: string } | null;
  /** Rounds sent back to the coder because the tests failed. */
  fixes: number;
}

/** What is happening to a fix (null for team tasks that are not about an issue). */
export function fixView(_app: AppContext, t: TeamTask): FixView | null {
  const wf = t.workflow;
  if (!wf?.issue) return null;
  const state: FixState =
    t.status === 'planning' || t.status === 'running' ? 'working'
    : t.status === 'waiting' ? (t.checkpoint?.kind === 'pr' ? 'ready' : 'waiting')
    : t.status === 'done' ? (wf.prUrl ? 'pr' : 'done')
    : t.status;
  return { task: t.id, repo: wf.issue.repo, number: wf.issue.number, title: wf.issue.title, url: wf.issue.url, conversationId: t.conversationId, state, branch: wf.worktree?.branch ?? null, prUrl: wf.prUrl ?? null, at: t.endedAt ?? t.createdAt };
}

/** Issue fixes, newest first. */
export function fixes(app: AppContext, limit = 30): FixView[] {
  if (!app.team) return [];
  return app.team.list(200).map((t) => fixView(app, t)).filter((v): v is FixView => Boolean(v)).slice(0, limit);
}

/** Open issues of one repository (or the watched ones), each with its latest fix. */
export async function fixList(app: AppContext, repo?: string): Promise<{ repos: string[]; issues: (OpenIssue & { fix: FixView | null })[]; fixes: FixView[] }> {
  hooks(app);
  const w = watchSettings(app);
  if (repo !== undefined && !REPO.test(repo)) throw new ToolError('Name the repository as owner/name.');
  const list = await openIssues(app, repo ? [repo] : w.repos, repo ? undefined : w.label);
  const all = fixes(app, 200);
  const latest = (i: OpenIssue) => all.find((f) => f.repo.toLowerCase() === i.repo.toLowerCase() && f.number === i.number) ?? null;
  return { repos: w.repos, issues: list.slice(0, 50).map((i) => ({ ...i, body: '', fix: latest(i) })), fixes: all.slice(0, 20) };
}

/** The one button: worktree, team (code → test until green → review), pull-request card. */
export async function fixIssue(app: AppContext, repo: string, number: number): Promise<TeamTask> {
  if (!app.team) throw new ToolError('Teams are not available.');
  if (!REPO.test(repo) || !(Number.isInteger(number) && number > 0)) throw new ToolError('Name the repository as owner/name and the issue number.');
  const busy = fixes(app, 200).find((f) => f.repo.toLowerCase() === repo.toLowerCase() && f.number === number && !['failed', 'stopped', 'limit'].includes(f.state));
  if (busy) throw new ToolError(busy.prUrl ? `${repo}#${number} already has a pull request: ${busy.prUrl}` : `${repo}#${number} is already being fixed (team task #${busy.task}).`);
  hooks(app);
  const helpers = teamHelpers(app, { workers: false });
  const id = (role: string) => helpers.find((h) => h.role === role)?.id ?? role;
  const plan = [
    { helper: id('coder'), title: 'Fix the issue', instructions: 'Read the issue in the goal and the code it is about. Make the smallest clean change that fixes it, with a test or check that shows it is fixed.' },
    { helper: id('tester'), title: "Run the project's tests", instructions: 'Find how this project runs its tests (package.json, Makefile, README) and run them. Report the exact command and result. End with "VERDICT: PASS" or "VERDICT: FAIL: <what failed>".' },
    { helper: id('reviewer'), title: 'Review the change', instructions: 'Read the change (git diff) against the issue. End with "VERDICT: APPROVE" or "VERDICT: CHANGES NEEDED: <what to change>".' },
  ];
  return startFromIssue(app, repo, number, { checkpoints: true, pr: true, plan, skipPlanStop: true, fix: true });
}

/** The pull-request card: what changed against the base, the last test run, the review. */
export async function prCard(app: AppContext, t: TeamTask): Promise<PrCard> {
  const wf = t.workflow;
  if (!wf?.issue) throw new ToolError('No such fix.');
  const dir = taskDir(app, t);
  const git = gitRunner();
  const base = wf.worktree?.base ?? 'main';
  const files = new Map<string, { path: string; added: number; removed: number }>();
  const num = await git(dir, ['-c', 'core.quotepath=off', 'diff', '--numstat', base]);
  if (num.code === 0)
    for (const line of num.out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (m) files.set(m[3], { path: m[3], added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
    }
  const fresh = await git(dir, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']);
  if (fresh.code === 0)
    for (const f of fresh.out.split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (files.has(f)) continue;
      const shown = await git(dir, ['diff', '--no-index', '--numstat', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', f]);
      const m = /^(\d+|-)\t/.exec(shown.out.trim());
      files.set(f, { path: f, added: m ? Number(m[1]) || 0 : 0, removed: 0 });
    }
  const helpers = new Map(teamHelpers(app, { workers: false }).map((h) => [h.id, h.role]));
  const done = t.steps.filter((s) => s.status === 'done');
  const run = done.filter((s) => helpers.get(s.helper) === 'tester').flatMap((s) => s.receipts.filter((r) => r.name === 'shell')).at(-1);
  const rev = done.filter((s) => helpers.get(s.helper) === 'reviewer').at(-1);
  return {
    branch: wf.worktree?.branch ?? '',
    base,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 100),
    tests: run ? { command: String(run.args.command ?? '').slice(0, 200), ok: run.status === 'ok' && /^\[exit code 0[,\]]/.test(run.output) } : null,
    review: rev ? (verdict(rev.report) ?? null) : null,
    fixes: t.steps.filter((s) => s.because?.endsWith('found a failure')).length,
  };
}

/** Open the pull request (the OK) or not now (the work stays in its worktree). */
export function answerFix(app: AppContext, id: number, decision: 'open' | 'not-now'): void {
  const t = app.team?.get(id);
  if (!t?.workflow?.issue) throw new ToolError('No such fix.');
  if (t.status !== 'waiting' || t.checkpoint?.kind !== 'pr') throw new ToolError("That fix isn't waiting for your OK.");
  if (!app.team!.answer(id, decision === 'open' ? 'go' : 'stop')) throw new ToolError("That fix isn't waiting for your OK.");
}

/** Plain lines for the chat card. */
export function cardText(v: FixView, c: PrCard): string {
  const add = c.files.reduce((n, f) => n + f.added, 0);
  const del = c.files.reduce((n, f) => n + f.removed, 0);
  return [
    `${v.repo}#${v.number} is fixed and tested, ready for your OK: ${c.files.length} file${c.files.length === 1 ? '' : 's'} changed (+${add} −${del}) on ${c.branch}.`,
    c.tests ? `Tests: \`${c.tests.command}\` ${c.tests.ok ? 'passed' : 'failed'}${c.fixes ? ` (after ${c.fixes} fix${c.fixes === 1 ? '' : 'es'})` : ''}.` : 'Tests: none ran.',
    c.review ? `Review: ${c.review.ok ? 'looks good' : `changes asked: ${c.review.detail}`}.` : '',
    'Nothing is on GitHub yet. Open the pull request or say not now in Settings → Connections → Apps and services → GitHub → Fix an issue (or on the Team page).',
  ].filter(Boolean).join('\n');
}

function hooks(app: AppContext): void {
  const team = app.team;
  if (!team || team.onCheckpoint) return;
  team.onCheckpoint = async (t) => {
    if (!t.workflow?.fix || t.checkpoint?.kind !== 'pr') return;
    const v = fixView(app, t);
    if (!v) return;
    const text = cardText(v, await prCard(app, t));
    const msg = app.store.addMessage(t.conversationId, 'assistant', app.redactor.redact(text), { fixIssue: { task: t.id } });
    app.events?.publish({ type: 'message', conversationId: t.conversationId, message: msg, reason: 'job' });
  };
}

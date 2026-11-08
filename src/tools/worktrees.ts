// C13 (docs/ops/C13_DESIGN.md): her task-worktree tools and the pull-request helper.
// worktree_start (asks): a branch sara/<slug> in its own folder; from then on her file and command
// tools in this conversation work there. worktree_finish (asks): merge, open a pull request (pushes
// the branch, then opens it through the GitHub connection), or discard (always asks, and the card
// says what would be deleted). github_draft_pr (runs on its own): a title and body from the branch.
import type { AppContext } from '../chat.ts';
import { coAuthorOf, draftPullRequest } from '../coding-depth.ts';
import { netFetch } from '../net-guard.ts';
import { type WorktreeRecord, WorktreeError, worktreeRel } from '../worktrees.ts';
import { git, pushBranch } from './coding.ts';
import { type FetchLike, openPullRequest, repoFromRemote } from './github.ts';
import { str, ToolError, type Tool, type ToolContext } from './types.ts';
import { workspaceDir } from './workspace.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** The workspace root of a conversation (her tools' folder may be the worktree itself). */
export function convRoot(app: AppContext, conversationId: string | undefined): { conv: NonNullable<ReturnType<AppContext['store']['getConversation']>>; wsDir: string } {
  const conv = conversationId ? app.store.getConversation(conversationId) : undefined;
  if (!conv) throw new ToolError('No conversation for this.');
  return { conv, wsDir: workspaceDir(app.rootDir ?? app.dataDir, conv.workspace) };
}

/** A pull request's draft for a worktree (commit subjects + diff stat). */
export async function worktreeDraft(app: AppContext, rec: WorktreeRecord, wsDir: string): Promise<{ title: string; body: string }> {
  const wt = app.worktrees!;
  const [st, stat] = await Promise.all([wt.status(rec, wsDir), wt.stat(rec, wsDir)]);
  return draftPullRequest({ branch: rec.branch, base: rec.base, commits: st.commits, stat, task: rec.task, by: coAuthorOf(app.settings.get().coAuthor, app.persona.name).name });
}

/** Push the worktree's branch and open its pull request (the caller has the owner's OK). */
export async function worktreePr(app: AppContext, rec: WorktreeRecord, wsDir: string, o: { title?: string; body?: string; draft?: boolean; signal: AbortSignal; fetchImpl?: FetchLike }): Promise<{ record: WorktreeRecord; url: string; number: number }> {
  const wt = app.worktrees!;
  if (rec.state !== 'active') throw new WorktreeError('state', `That worktree is already ${rec.state}.`);
  const st = await wt.status(rec, wsDir);
  if (st.dirty.length) throw new WorktreeError('dirty', 'The worktree has changes that are not committed yet. Commit them first.', { dirty: st.dirty });
  if (!st.ahead) throw new WorktreeError('state', `There are no commits on ${rec.branch} yet.`);
  const ctx: ToolContext = { workspaceDir: wsDir, signal: o.signal, sandbox: { ...app.sandbox, network: true } };
  const dir = worktreeRel(rec);
  const remote = await git(ctx, ['-C', dir, 'remote', 'get-url', 'origin']);
  const repo = remote.code === 0 ? repoFromRemote(remote.out) : undefined;
  if (!repo) throw new WorktreeError('state', 'This repository has no GitHub remote (origin).');
  await pushBranch(app, ctx, { dir, branch: rec.branch });
  const draft = o.title?.trim() ? { title: o.title.trim(), body: o.body ?? '' } : await worktreeDraft(app, rec, wsDir);
  const pr = await openPullRequest(app, o.fetchImpl ?? netFetch, { repo, head: rec.branch, base: rec.base, title: draft.title, body: o.body ?? draft.body, draft: o.draft, signal: o.signal });
  return { record: wt.markPr(rec, pr.url), url: pr.url, number: pr.number };
}

const why = (err: unknown) => {
  if (err instanceof WorktreeError) {
    const d = err.detail as { dirty?: string[]; commits?: string[] } | undefined;
    return new ToolError(`${err.message}${d?.dirty?.length ? `\nUncommitted: ${d.dirty.slice(0, 20).join(', ')}` : ''}${d?.commits?.length ? `\nCommits: ${d.commits.slice(0, 10).join('; ')}` : ''}`);
  }
  return err instanceof Error ? err : new Error(String(err));
};

export function createWorktreeTools(app: AppContext, fetchImpl: FetchLike = netFetch): Tool[] {
  const on = () => Boolean(app.worktrees);
  const start: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'worktree_start',
      description: "Start this coding task in its own git worktree: a new branch sara/<task> in its own folder (the main checkout stays as it is). From then on your file and command tools in this conversation work there. Finish with worktree_finish (merge, pull request or discard).",
      parameters: obj({ task: { type: 'string', description: 'What the task is (names the branch)' }, repo_path: { type: 'string', description: 'Folder of the repository inside the workspace (default: the workspace)' } }, ['task']),
    },
    isAvailable: on,
    summarize: (a) => `Start a task worktree: ${String(a.task ?? '').slice(0, 120)}`,
    async run(args, ctx) {
      const { conv, wsDir } = convRoot(app, ctx.conversationId);
      if (conv.mode !== 'coding') throw new ToolError('Task worktrees are for coding conversations.');
      try {
        const rec = await app.worktrees!.start({ conversationId: conv.id, workspace: conv.workspace, wsDir, task: str(args, 'task'), repo: str(args, 'repo_path', false) || '.' });
        return `Working in ${worktreeRel(rec)} on branch ${rec.branch} (from ${rec.base}). Your file and command tools in this conversation now work there; commit as you go, then worktree_finish.`;
      } catch (err) {
        throw why(err);
      }
    },
  };
  const finish: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'worktree_finish',
      description: "Finish this conversation's task worktree: merge (into the branch it started from), pr (push the branch and open a pull request; title/body are drafted from the commits when left out), or discard (deletes the folder and the branch).",
      parameters: obj({ action: { type: 'string', enum: ['merge', 'pr', 'discard'] }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } }, ['action']),
    },
    isAvailable: on,
    // Discarding always asks, even if the owner lets this tool run on its own.
    asksFirst: (a) => a.action === 'discard',
    async prepare(args, pctx) {
      if (args.action !== 'discard' || !pctx.conversationId) return {};
      try {
        const { conv, wsDir } = convRoot(app, pctx.conversationId);
        const rec = app.worktrees?.active(conv.id);
        if (!rec) return { refuse: 'This conversation has no task worktree.' };
        const st = await app.worktrees!.status(rec, wsDir);
        return { ask: true, summary: `Discard worktree ${rec.branch}${st.dirty.length || st.ahead ? `: deletes ${st.dirty.length} uncommitted file(s) and ${st.ahead} commit(s) not merged anywhere` : ' (nothing unsaved)'}` };
      } catch {
        return { ask: true };
      }
    },
    summarize: (a) => (a.action === 'merge' ? 'Merge the task worktree' : a.action === 'pr' ? `Push the task branch and open a pull request${a.title ? `: “${String(a.title)}”` : ''}` : 'Discard the task worktree'),
    async run(args, ctx) {
      const { conv, wsDir } = convRoot(app, ctx.conversationId);
      const rec = app.worktrees!.active(conv.id);
      if (!rec) throw new ToolError('This conversation has no task worktree.');
      const action = str(args, 'action');
      try {
        if (action === 'merge') {
          const r = await app.worktrees!.merge(rec, wsDir);
          return `Merged ${r.branch} into ${r.base}; the worktree and the branch are removed. Your tools work in the main checkout again.`;
        }
        if (action === 'discard') {
          // The approval card named what would be deleted (prepare), so the owner's OK is the confirm.
          await app.worktrees!.discard(rec, wsDir, { confirm: true });
          return `Discarded ${rec.branch}: the worktree and the branch are removed.`;
        }
        if (action === 'pr') {
          const r = await worktreePr(app, rec, wsDir, { title: str(args, 'title', false), body: str(args, 'body', false) || undefined, draft: args.draft === true, signal: ctx.signal, fetchImpl });
          return `Opened pull request #${r.number}: ${r.url} (${rec.branch} → ${rec.base}). The worktree stays for follow-up changes.`;
        }
      } catch (err) {
        throw why(err);
      }
      throw new ToolError('Unknown action.');
    },
  };
  const draftPr: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'github_draft_pr', description: "Draft a pull request's title and body from this task's branch (its commits and changed files). Read only: show it, then open it with worktree_finish (pr) or github_open_pr.", parameters: obj({}) },
    isAvailable: on,
    summarize: () => 'Draft a pull request',
    async run(_args, ctx) {
      const { conv, wsDir } = convRoot(app, ctx.conversationId);
      const rec = app.worktrees!.active(conv.id);
      if (!rec) throw new ToolError('This conversation has no task worktree; start one with worktree_start, or write the pull request yourself.');
      const d = await worktreeDraft(app, rec, wsDir);
      return `Title: ${d.title}\n\n${d.body}`;
    },
  };
  return [start, finish, draftPr];
}

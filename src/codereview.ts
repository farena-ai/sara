// Phase 40: review mode. She reviews a diff (your uncommitted changes, what's staged, a branch) or
// a GitHub pull request, with comments on files and lines, a short summary and a verdict. With
// your OK the review can be posted on the pull request (as comments: GitHub doesn't let anyone
// approve their own pull request).
import { netFetch } from './net-guard.ts';
import { type AppContext } from './chat.ts';
import { complete } from './life.ts';
import type { Conversation } from './store.ts';
import { git, GITHUB_VAULT } from './tools/coding.ts';
import { repoFromRemote } from './tools/github.ts';
import { clip, str, ToolError, type Tool, type ToolContext } from './tools/types.ts';

export interface ReviewComment {
  file: string;
  line?: number;
  severity: 'must' | 'should' | 'nit';
  comment: string;
}

export interface CodeReview {
  label: string;
  summary: string;
  verdict: 'approve' | 'changes';
  comments: ReviewComment[];
  files: number;
  additions: number;
  deletions: number;
}

export interface DiffFile {
  path: string;
  /** New-file line numbers that are in the diff (added or context): comments can go there. */
  lines: Set<number>;
}

/** Files, their commentable lines, and +/− counts from a unified diff. */
export function parseDiff(diff: string): { files: DiffFile[]; additions: number; deletions: number } {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let line = 0;
  let additions = 0;
  let deletions = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      cur = undefined;
      continue;
    }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4).trim();
      if (p === '/dev/null') {
        cur = undefined;
        continue;
      }
      cur = { path: p.replace(/^b\//, ''), lines: new Set() };
      files.push(cur);
      continue;
    }
    if (l.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+')) {
      cur.lines.add(line++);
      additions++;
    } else if (l.startsWith('-')) deletions++;
    else if (l.startsWith(' ')) cur.lines.add(line++);
  }
  return { files, additions, deletions };
}

async function gh(app: AppContext, path: string, init: { method?: string; body?: unknown; accept?: string; signal?: AbortSignal } = {}): Promise<{ status: number; text: string }> {
  const t = app.vault.get(GITHUB_VAULT);
  if (!t) throw new ToolError('GitHub is not connected (Settings → Coding → GitHub).');
  const res = await netFetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${t}`, accept: init.accept ?? 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Sara', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new ToolError(`GitHub said ${res.status}: ${clip(text, 300)}`);
  return { status: res.status, text };
}

export type ReviewTarget = { kind: 'working' } | { kind: 'staged' } | { kind: 'branch'; branch: string; base?: string } | { kind: 'pr'; number: number; repo?: string };

/** The diff to review, and a label for it. */
export async function getDiff(app: AppContext, ctx: ToolContext, target: ReviewTarget, dir?: string): Promise<{ diff: string; label: string; repo?: string; number?: number; headSha?: string }> {
  const C = dir ? ['-C', dir] : [];
  const flags = ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U3'];
  if (target.kind === 'pr') {
    let repo = target.repo;
    if (!repo) {
      const r = await git(ctx, [...C, 'remote', 'get-url', 'origin']);
      repo = r.code === 0 ? repoFromRemote(r.out) : undefined;
    }
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ToolError('Which repository? Name it as owner/name.');
    const pr = JSON.parse((await gh(app, `/repos/${repo}/pulls/${target.number}`, { signal: ctx.signal })).text) as { title: string; head: { sha: string } };
    const diff = (await gh(app, `/repos/${repo}/pulls/${target.number}`, { accept: 'application/vnd.github.diff', signal: ctx.signal })).text;
    return { diff, label: `pull request #${target.number} in ${repo} (“${pr.title}”)`, repo, number: target.number, headSha: pr.head.sha };
  }
  if (target.kind === 'staged') return { diff: (await git(ctx, [...C, ...flags, '--cached'])).out, label: 'the staged changes' };
  if (target.kind === 'branch') {
    const base = target.base || (await git(ctx, [...C, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).out.trim().replace(/^origin\//, '') || 'main';
    if (!/^(?!-)[\w./-]{1,100}$/.test(target.branch) || !/^(?!-)[\w./-]{1,100}$/.test(base)) throw new ToolError("That branch name isn't allowed.");
    return { diff: (await git(ctx, [...C, ...flags, `${base}...${target.branch}`])).out, label: `branch ${target.branch} (against ${base})` };
  }
  // Working changes: tracked edits plus new files (shown whole).
  let diff = (await git(ctx, [...C, ...flags, 'HEAD'])).out;
  const untracked = (await git(ctx, [...C, 'ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean).slice(0, 30);
  for (const f of untracked) {
    const d = await git(ctx, [...C, ...flags, '--no-index', '/dev/null', f]);
    diff += `\n${d.out}`;
  }
  return { diff, label: 'your uncommitted changes' };
}

/** The coding model reviews the diff. */
export async function reviewDiff(app: AppContext, conv: Conversation, diff: string, label: string, project?: string): Promise<CodeReview> {
  const parsed = parseDiff(diff);
  if (!parsed.files.length) throw new ToolError(`There are no changes in ${label}.`);
  const prompt = `Review ${label} as a careful senior engineer.${project ? `\n\nAbout the project:\n${clip(project, 1500)}` : ''}\n\nThe diff:\n\`\`\`diff\n${clip(diff, 60_000)}\n\`\`\`\n\nLook for bugs, missing cases and tests, security problems, unclear names, and anything against the project's style. Be specific and brief; praise nothing. Only comment on lines in the diff (new-file line numbers).\nReturn ONLY JSON: {"summary":"<2-3 sentences>","verdict":"approve"|"changes","comments":[{"file":"<path>","line":<number or null>,"severity":"must"|"should"|"nit","comment":"<what and why, with a fix>"}]}`;
  const text = await complete(app, { ...conv, providerId: null, model: null, mode: 'coding' }, [{ role: 'user', content: prompt }], 3000, 'coding');
  let j: { summary?: unknown; verdict?: unknown; comments?: unknown };
  try {
    j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    throw new ToolError(`The review model didn't return a review: ${clip(text, 200)}`);
  }
  const known = new Map(parsed.files.map((f) => [f.path, f]));
  const comments: ReviewComment[] = (Array.isArray(j.comments) ? j.comments : [])
    .map((c: Record<string, unknown>) => {
      const file = String(c.file ?? '').replace(/^[ab]\//, '');
      const f = known.get(file);
      const line = Number(c.line);
      return { file, ...(f && Number.isInteger(line) && f.lines.has(line) ? { line } : {}), severity: (['must', 'should', 'nit'].includes(String(c.severity)) ? c.severity : 'should') as ReviewComment['severity'], comment: clip(String(c.comment ?? '').trim(), 1000) };
    })
    .filter((c: ReviewComment) => c.comment && known.has(c.file))
    .slice(0, 30);
  const verdict = j.verdict === 'approve' && !comments.some((c) => c.severity === 'must') ? 'approve' : 'changes';
  return { label, summary: clip(String(j.summary ?? '').trim(), 800), verdict, comments, files: parsed.files.length, additions: parsed.additions, deletions: parsed.deletions };
}

export function formatReview(r: CodeReview): string {
  const head = `Review of ${r.label}: ${r.files} file${r.files === 1 ? '' : 's'}, +${r.additions} −${r.deletions}. Verdict: ${r.verdict === 'approve' ? 'looks good' : 'changes needed'}.`;
  const list = r.comments.map((c) => `- ${c.file}${c.line ? `:${c.line}` : ''} [${c.severity}] ${c.comment}`);
  return [head, r.summary, ...(list.length ? ['Comments:', ...list] : ['No comments.'])].filter(Boolean).join('\n');
}

/** Posts the review on the pull request (comments on lines in the diff, the rest in the body). */
export async function postReview(app: AppContext, repo: string, number: number, r: CodeReview, signal?: AbortSignal): Promise<string> {
  const onLines = r.comments.filter((c) => c.line);
  const general = r.comments.filter((c) => !c.line);
  const body = [`**Review by ${app.persona.name}** (${r.verdict === 'approve' ? 'looks good' : 'changes needed'})`, r.summary, ...general.map((c) => `- \`${c.file}\` [${c.severity}] ${c.comment}`)].filter(Boolean).join('\n\n');
  const res = await gh(app, `/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event: 'COMMENT', body, comments: onLines.map((c) => ({ path: c.file, line: c.line, side: 'RIGHT', body: `[${c.severity}] ${c.comment}` })) }, ...(signal ? { signal } : {}) });
  const out = JSON.parse(res.text) as { html_url?: string; id?: number };
  return out.html_url ?? `review ${out.id}`;
}

/** Her tools: review a diff or pull request; post the last review on its pull request. */
export function createReviewTools(app: () => AppContext): Tool[] {
  const last = new Map<string, { review: CodeReview; repo?: string; number?: number }>();
  const review: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'review_code',
      description: "Review code changes with comments on files and lines, a summary and a verdict: the workspace's uncommitted changes ('working'), the staged ones ('staged'), a branch against the default branch ('branch'), or a GitHub pull request ('pr' with its number). Read only.",
      parameters: { type: 'object', properties: { target: { type: 'string', enum: ['working', 'staged', 'branch', 'pr'] }, number: { type: 'integer', description: 'Pull request number (for pr)' }, branch: { type: 'string' }, base: { type: 'string' }, repo: { type: 'string', description: 'owner/name (default: the workspace repository)' }, path: { type: 'string', description: 'Folder of the repository in the workspace' } }, required: ['target'] },
    },
    summarize: (a) => `Review ${a.target === 'pr' ? `pull request #${String(a.number ?? '?')}` : a.target === 'branch' ? `branch ${String(a.branch ?? '')}` : String(a.target ?? '')}`,
    async run(args, ctx) {
      const a = app();
      const conv = ctx.conversationId ? a.store.getConversation(ctx.conversationId) : undefined;
      if (!conv) throw new ToolError('Reviews need a conversation.');
      const kind = str(args, 'target');
      const target: ReviewTarget = kind === 'pr' ? { kind: 'pr', number: Number(args.number), ...(args.repo ? { repo: String(args.repo) } : {}) } : kind === 'branch' ? { kind: 'branch', branch: str(args, 'branch'), ...(args.base ? { base: String(args.base) } : {}) } : kind === 'staged' ? { kind: 'staged' } : { kind: 'working' };
      if (target.kind === 'pr' && !(target.number > 0)) throw new ToolError('Which pull request number?');
      const d = await getDiff(a, ctx, target, str(args, 'path', false) || undefined);
      const project = a.projects ? a.projects.get(conv.workspace).map((k) => `${k.facts.name}: ${k.facts.conventions.join('; ')}${k.facts.rules ? `\n${k.facts.rules.slice(0, 600)}` : ''}`).join('\n') : undefined;
      const r = await reviewDiff(a, conv, d.diff, d.label, project);
      last.set(conv.id, { review: r, ...(d.repo ? { repo: d.repo, number: d.number } : {}) });
      return `${formatReview(r)}${d.repo ? `\n(To put this review on the pull request, use github_post_review.)` : ''}`;
    },
  };
  const post: Tool = {
    defaultPermission: 'ask',
    spec: { name: 'github_post_review', description: 'Post your last review_code review of a GitHub pull request on that pull request (as comments).', parameters: { type: 'object', properties: {} } },
    isAvailable: () => Boolean(app().vault.get(GITHUB_VAULT)),
    summarize: () => 'Post the review on the pull request',
    async run(_args, ctx) {
      const a = app();
      const l = ctx.conversationId ? last.get(ctx.conversationId) : undefined;
      if (!l?.repo || !l.number) throw new ToolError('Review a pull request first (review_code with target pr).');
      return `Posted the review on ${l.repo}#${l.number}: ${await postReview(a, l.repo, l.number, l.review, ctx.signal)}`;
    },
  };
  return [review, post];
}

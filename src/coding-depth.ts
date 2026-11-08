// C13 (docs/ops/C13_DESIGN.md): co-authored commits and the pull-request draft.
// - Her commits carry a `Co-authored-by:` trailer (Settings → Coding → GitHub; on by default, the
//   companion's name with a noreply address that can't reach anybody).
// - The pull-request helper drafts a title and body from the branch's commit subjects and diff
//   stat; opening it goes through the GitHub connection and needs the owner's OK.

export interface CoAuthor {
  on: boolean;
  name: string;
  email: string;
}

const EMAIL = /^[^\s<>@]{1,64}@[^\s<>@]{1,190}\.[^\s<>@]{2,}$/;
const cleanName = (v: unknown) =>
  String(v ?? '')
    .replace(/[<>\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sara';

/** The co-author her commits name: the owner's choice, else the companion with a noreply address. */
export function coAuthorOf(saved: Partial<CoAuthor> | undefined, companion: string): CoAuthor {
  const name = cleanName(saved?.name) || cleanName(companion) || 'Sara';
  const email = saved?.email && EMAIL.test(saved.email) ? saved.email : `${slug(name)}@noreply.sara.invalid`;
  return { on: saved?.on !== false, name, email };
}

/** Settings PUT: only clean values are kept (an invalid email is dropped, so the default applies). */
export function mergeCoAuthor(cur: Partial<CoAuthor> | undefined, body: Record<string, unknown>): CoAuthor {
  const out: CoAuthor = { on: cur?.on !== false, name: cleanName(cur?.name), email: cur?.email && EMAIL.test(cur.email) ? cur.email : '' };
  if (typeof body.on === 'boolean') out.on = body.on;
  if (body.name !== undefined) out.name = cleanName(body.name);
  if (body.email !== undefined) {
    const e = String(body.email ?? '').trim();
    out.email = EMAIL.test(e) && e.length <= 254 ? e : '';
  }
  return out;
}

const TRAILER = /^[A-Za-z][\w-]*: .+$/;

/** The commit message with her `Co-authored-by:` trailer (once; joins an existing trailer block). */
export function withCoAuthor(message: string, who: CoAuthor): string {
  if (!who.on) return message;
  const line = `Co-authored-by: ${who.name} <${who.email}>`;
  const body = message.replace(/\s+$/, '');
  if (body.toLowerCase().includes(`<${who.email.toLowerCase()}>`) && /co-authored-by:/i.test(body)) return body;
  const paras = body.split(/\n\s*\n/);
  const last = paras.at(-1) ?? '';
  const trailerBlock = paras.length > 1 && last.split('\n').every((l) => TRAILER.test(l));
  return trailerBlock ? `${body}\n${line}` : `${body}\n\n${line}`;
}

export interface PrDraftInput {
  branch: string;
  base: string;
  /** Commit subjects, oldest first. */
  commits: string[];
  /** `git diff --stat base...branch` */
  stat: string;
  /** The task the worktree was made for, if any. */
  task?: string;
  /** Who drafted it (the companion's name). */
  by: string;
}

const clipTitle = (s: string) => (s.length <= 72 ? s : `${s.slice(0, 71).trimEnd()}…`);

/** A title and Markdown body for a pull request, from what the branch holds. */
export function draftPullRequest(i: PrDraftInput): { title: string; body: string } {
  const commits = i.commits.map((c) => c.trim()).filter((c) => c && !/^co-authored-by:/i.test(c));
  const fromBranch = i.branch.replace(/^sara\//, '').replace(/[-_/]+/g, ' ').trim();
  const title = clipTitle(commits.length === 1 ? commits[0] : fromBranch ? fromBranch[0].toUpperCase() + fromBranch.slice(1) : commits[0] || i.task || 'Changes');
  const lines = ['## Summary', '', i.task?.trim() || (commits.length === 1 ? commits[0] : `Changes from ${i.branch} into ${i.base}.`), ''];
  if (commits.length) lines.push('## Commits', '', ...commits.slice(0, 50).map((c) => `- ${c}`), ...(commits.length > 50 ? [`- … and ${commits.length - 50} more`] : []), '');
  if (i.stat.trim()) lines.push('## Files changed', '', '```', i.stat.trim().split('\n').slice(0, 60).join('\n'), '```', '');
  lines.push(`_Drafted by ${cleanName(i.by) || 'Sara'} from the branch; please review before merging._`);
  return { title, body: lines.join('\n') };
}

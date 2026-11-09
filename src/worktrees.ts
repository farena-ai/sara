// C13 (docs/ops/C13_DESIGN.md): a managed git worktree per coding task.
// Start: a branch `sara/<slug>` checked out in `<repo>/.sara-worktrees/<slug>` (the folder is added
// to the repository's .git/info/exclude, so the main checkout stays clean). While a conversation's
// worktree is active her file and command tools work there (src/chat.ts). Finish: Merge (into the
// branch it started from, in the main checkout), Open PR (src/routes/worktrees.ts), or Discard.
// Uncommitted or unmerged work is never deleted without the owner's confirm, and removal unlinks
// every link inside the worktree first (Windows junctions to node_modules), so nothing outside it is
// ever deleted through one.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { GIT_SAFE } from './tools/coding.ts';
import { inside } from './tools/workspace.ts';

export type WorktreeState = 'active' | 'merged' | 'pr' | 'discarded';
export interface WorktreeRecord {
  id: number;
  conversationId: string;
  workspace: string;
  /** The repository inside the workspace ('.' = the workspace itself). */
  repo: string;
  branch: string;
  /** The branch it started from (merge target, pull-request base). */
  base: string;
  /** The worktree folder, relative to the repository. */
  dir: string;
  task: string;
  state: WorktreeState;
  prUrl: string | null;
  createdAt: string;
  endedAt: string | null;
}
export interface WorktreeStatus {
  dirty: string[];
  ahead: number;
  commits: string[];
}

export class WorktreeError extends Error {
  readonly code: 'active' | 'dirty' | 'unsaved' | 'conflict' | 'git' | 'state' | 'base';
  readonly detail?: unknown;
  constructor(code: WorktreeError['code'], message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export type GitRun = (cwd: string, args: string[]) => Promise<{ code: number | null; out: string }>;

/** Environment names a git command may see (never Sara's own keys or tokens). */
const ENV_KEEP = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|LANG|LC_ALL|GIT_EXEC_PATH)$/;
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_KEEP.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

/**
 * Git run directly (host paths), with GIT_SAFE (no hooks, pagers, fsmonitor or helpers from the
 * repository's own config) and a clean environment. Worktree bookkeeping is Sara's own work, never
 * the repository's code.
 */
export function gitRunner(extraEnv: Record<string, string> = {}): GitRun {
  return (cwd, args) =>
    new Promise((done) => {
      execFile('git', [...GIT_SAFE, ...args], { cwd, env: cleanEnv(extraEnv), timeout: 60_000, maxBuffer: 4_000_000, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        done({ code, out: `${stdout}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.trimEnd() });
      });
    });
}

/** A short branch-safe slug from the task. */
export function slugOf(task: string): string {
  const s = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'task';
}

/**
 * Removes every link (symlink or Windows junction) below `dir` without following it. Returns how
 * many were removed. A recursive delete afterwards then can't reach anything outside `dir`.
 */
export function unlinkLinks(dir: string): number {
  let n = 0;
  if (!existsSync(dir)) return 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        try {
          unlinkSync(p);
        } catch {
          rmdirSync(p); // a directory link on some Windows versions
        }
        n++;
      } else if (st.isDirectory() && name !== '.git') walk(p);
    }
  };
  walk(dir);
  return n;
}

const SLUG_DIR = '.sara-worktrees';
const row = (r: Record<string, unknown>): WorktreeRecord => ({
  id: Number(r.id),
  conversationId: String(r.conversation_id),
  workspace: String(r.workspace),
  repo: String(r.repo),
  branch: String(r.branch),
  base: String(r.base),
  dir: String(r.dir),
  task: String(r.task),
  state: String(r.state) as WorktreeState,
  prUrl: r.pr_url ? String(r.pr_url) : null,
  createdAt: String(r.created_at),
  endedAt: r.ended_at ? String(r.ended_at) : null,
});

export class Worktrees {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #git: GitRun;
  constructor(db: DatabaseSync, now: () => Date, git: GitRun = gitRunner()) {
    this.#db = db;
    this.#now = now;
    this.#git = git;
    db.exec(`CREATE TABLE IF NOT EXISTS task_worktrees (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, workspace TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, dir TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, pr_url TEXT, created_at TEXT NOT NULL, ended_at TEXT)`);
  }

  get(id: number): WorktreeRecord | undefined {
    const r = this.#db.prepare('SELECT * FROM task_worktrees WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? row(r) : undefined;
  }
  /** The conversation's active worktree, if any. */
  active(conversationId: string): WorktreeRecord | undefined {
    const r = this.#db.prepare("SELECT * FROM task_worktrees WHERE conversation_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1").get(conversationId) as Record<string, unknown> | undefined;
    return r ? row(r) : undefined;
  }
  list(q: { workspace?: string; conversationId?: string; limit?: number } = {}): WorktreeRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (q.workspace) where.push('workspace = ?'), args.push(q.workspace);
    if (q.conversationId) where.push('conversation_id = ?'), args.push(q.conversationId);
    return (this.#db.prepare(`SELECT * FROM task_worktrees ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (state = 'active') DESC, id DESC LIMIT ${Math.min(200, q.limit ?? 50)}`).all(...args) as Record<string, unknown>[]).map(row);
  }

  /** The repository folder (absolute) inside the workspace. */
  repoOf(rec: Pick<WorktreeRecord, 'repo'>, wsDir: string): string {
    const r = resolve(wsDir, rec.repo);
    if (!inside(wsDir, r)) throw new WorktreeError('state', 'That repository is outside the workspace.');
    return r;
  }
  /** The worktree folder (absolute). */
  dirOf(rec: Pick<WorktreeRecord, 'repo' | 'dir'>, wsDir: string): string {
    const d = resolve(this.repoOf(rec, wsDir), rec.dir);
    if (!inside(wsDir, d)) throw new WorktreeError('state', 'That worktree is outside the workspace.');
    return d;
  }

  async #must(cwd: string, args: string[], code: WorktreeError['code'] = 'git'): Promise<string> {
    const r = await this.#git(cwd, args);
    if (r.code !== 0) throw new WorktreeError(code, r.out || `git ${args[0]} failed`);
    return r.out;
  }

  async start(o: { conversationId: string; workspace: string; wsDir: string; task: string; repo?: string; folder?: string }): Promise<WorktreeRecord> {
    if (this.active(o.conversationId)) throw new WorktreeError('active', 'This conversation already has a task worktree. Finish it first (merge, pull request or discard).');
    const task = o.task.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!task) throw new WorktreeError('state', 'Say what the task is.');
    const repoRel = (o.repo || '.').replace(/\\/g, '/');
    const repoDir = this.repoOf({ repo: repoRel }, o.wsDir);
    const top = (await this.#must(repoDir, ['rev-parse', '--show-toplevel'], 'state').catch(() => {
      throw new WorktreeError('state', 'That folder is not a git repository yet.');
    })).trim();
    if (resolve(top).toLowerCase() !== repoDir.toLowerCase() && !inside(o.wsDir, resolve(top))) throw new WorktreeError('state', 'That repository is outside the workspace.');
    const base = (await this.#must(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], 'base')).trim();
    if (!base || base === 'HEAD') throw new WorktreeError('base', 'The repository has no branch checked out (detached HEAD); switch to a branch first.');
    const folder = (o.folder || SLUG_DIR).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(folder) || folder.split('/').some((p) => p === '..' || p.toLowerCase() === '.git')) throw new WorktreeError('state', 'That worktree folder name is not allowed.');
    let slug = slugOf(task);
    for (let i = 2; existsSync(join(repoDir, folder, slug)) || (await this.#git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/sara/${slug}`])).code === 0; i++) slug = `${slugOf(task).slice(0, 36)}-${i}`;
    const dir = `${folder}/${slug}`;
    const branch = `sara/${slug}`;
    // Relative paths (git 2.48+) keep the worktree working when the folder is seen from a sandbox.
    let add = await this.#git(repoDir, ['worktree', 'add', '--relative-paths', '-b', branch, dir, base]);
    if (add.code !== 0 && /relative-paths/.test(add.out)) add = await this.#git(repoDir, ['worktree', 'add', '-b', branch, dir, base]);
    if (add.code !== 0) throw new WorktreeError('git', add.out || 'git worktree add failed');
    this.#exclude(repoDir, folder);
    const now = this.#now().toISOString();
    const r = this.#db.prepare("INSERT INTO task_worktrees (conversation_id, workspace, repo, branch, base, dir, task, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)").run(o.conversationId, o.workspace, repoRel, branch, base, dir, task, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Adds the worktree folder to .git/info/exclude (once). */
  #exclude(repoDir: string, folder: string): void {
    const gitDir = join(repoDir, '.git');
    try {
      if (!lstatSync(gitDir).isDirectory()) return; // the repository is itself a worktree or submodule
    } catch {
      return;
    }
    const file = join(gitDir, 'info', 'exclude');
    const line = `/${folder}/`;
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(line)) {
      try {
        appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Sara's task worktrees\n${line}\n`);
      } catch {
        /* info/ missing: git status shows the folder, nothing breaks */
      }
    }
  }

  async status(rec: WorktreeRecord, wsDir: string): Promise<WorktreeStatus> {
    const dir = this.dirOf(rec, wsDir);
    if (!existsSync(dir)) return { dirty: [], ahead: 0, commits: [] };
    const st = await this.#must(dir, ['status', '--porcelain', '--untracked-files=all']);
    const dirty = st.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 200);
    const log = await this.#git(dir, ['log', '--reverse', '--format=%s', `${rec.base}..HEAD`]);
    const commits = log.code === 0 ? log.out.split('\n').filter(Boolean).slice(0, 200) : [];
    return { dirty, ahead: commits.length, commits };
  }

  /** `git diff --stat` of the branch against its base. */
  async stat(rec: WorktreeRecord, wsDir: string): Promise<string> {
    const r = await this.#git(this.dirOf(rec, wsDir), ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${rec.base}...HEAD`]);
    return r.code === 0 ? r.out.slice(0, 20_000) : '';
  }

  #end(rec: WorktreeRecord, state: WorktreeState, prUrl?: string): WorktreeRecord {
    this.#db.prepare('UPDATE task_worktrees SET state = ?, ended_at = ?, pr_url = COALESCE(?, pr_url) WHERE id = ?').run(state, this.#now().toISOString(), prUrl ?? null, rec.id);
    return this.get(rec.id)!;
  }
  #mustBeActive(rec: WorktreeRecord): void {
    if (rec.state !== 'active') throw new WorktreeError('state', `That worktree is already ${rec.state}.`);
  }

  /** Merge the branch into its base in the main checkout, then remove the worktree and the branch. */
  async merge(rec: WorktreeRecord, wsDir: string): Promise<WorktreeRecord> {
    this.#mustBeActive(rec);
    const st = await this.status(rec, wsDir);
    if (st.dirty.length) throw new WorktreeError('dirty', 'The worktree has changes that are not committed yet. Commit them first (or discard).', { dirty: st.dirty });
    const repoDir = this.repoOf(rec, wsDir);
    const cur = (await this.#must(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (cur !== rec.base) throw new WorktreeError('base', `The main checkout is on ${cur}, not ${rec.base}. Switch it back first.`);
    const mainDirty = (await this.#must(repoDir, ['status', '--porcelain', '--untracked-files=no'])).trim();
    if (mainDirty) throw new WorktreeError('dirty', `The main checkout (${rec.base}) has uncommitted changes. Commit or stash them first.`, { dirty: mainDirty.split('\n').map((l) => l.slice(3)) });
    if (st.ahead) {
      const m = await this.#git(repoDir, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${rec.branch}: ${rec.task.slice(0, 120)}`, rec.branch]);
      if (m.code !== 0) {
        await this.#git(repoDir, ['merge', '--abort']);
        throw new WorktreeError('conflict', `The merge into ${rec.base} has conflicts, so it was stopped and nothing changed. Resolve them in the worktree (merge ${rec.base} into it), then merge again.`, { output: m.out.slice(0, 4000) });
      }
    }
    await this.#remove(rec, wsDir);
    await this.#git(repoDir, ['branch', '-d', rec.branch]);
    return this.#end(rec, 'merged');
  }

  /** Remove the worktree and its branch. Uncommitted or unmerged work needs `confirm`. */
  async discard(rec: WorktreeRecord, wsDir: string, o: { confirm?: boolean } = {}): Promise<WorktreeRecord> {
    this.#mustBeActive(rec);
    const st = await this.status(rec, wsDir);
    if ((st.dirty.length || st.ahead) && !o.confirm) throw new WorktreeError('unsaved', `This worktree has ${st.dirty.length} uncommitted file(s) and ${st.ahead} commit(s) not merged anywhere. Discarding deletes them.`, st);
    const repoDir = this.repoOf(rec, wsDir);
    await this.#remove(rec, wsDir);
    await this.#git(repoDir, ['branch', '-D', rec.branch]);
    return this.#end(rec, 'discarded');
  }

  /** After a pull request is opened: the record keeps the link; the worktree stays for follow-ups. */
  markPr(rec: WorktreeRecord, url: string): WorktreeRecord {
    this.#db.prepare('UPDATE task_worktrees SET pr_url = ? WHERE id = ?').run(url.slice(0, 500), rec.id);
    return this.get(rec.id)!;
  }
  /** Close a worktree whose pull request is done: removed like discard, but the branch stays. */
  async closePr(rec: WorktreeRecord, wsDir: string, o: { confirm?: boolean } = {}): Promise<WorktreeRecord> {
    this.#mustBeActive(rec);
    const st = await this.status(rec, wsDir);
    if (st.dirty.length && !o.confirm) throw new WorktreeError('unsaved', `This worktree has ${st.dirty.length} uncommitted file(s).`, st);
    await this.#remove(rec, wsDir);
    return this.#end(rec, 'pr');
  }

  async #remove(rec: WorktreeRecord, wsDir: string): Promise<void> {
    const repoDir = this.repoOf(rec, wsDir);
    const dir = this.dirOf(rec, wsDir);
    if (existsSync(dir)) {
      unlinkLinks(dir);
      const r = await this.#git(repoDir, ['worktree', 'remove', '--force', rec.dir]);
      // Git may leave the folder behind on Windows (a file in use); every link inside is gone, so a
      // plain delete can't reach outside it.
      if (existsSync(dir) && dir !== repoDir && inside(repoDir, dir)) {
        try {
          unlinkLinks(dir);
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          if (r.code !== 0) throw new WorktreeError('git', r.out || 'The worktree folder could not be removed.');
        }
      }
    }
    await this.#git(repoDir, ['worktree', 'prune']);
  }
}

/** For prompts and the task card: what the folder is called relative to the workspace. */
export function worktreeRel(rec: WorktreeRecord): string {
  return relative('.', join(rec.repo, rec.dir)).split(sep).join('/');
}

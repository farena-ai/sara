// Phase 40: project knowledge. For each repository in a workspace she keeps what she learned:
// its layout, languages, the commands to build, test and lint, its conventions (AGENTS.md,
// CONTRIBUTING, editor and lint configs), the GitHub repository and default branch, recent
// commits, and notes she or the owner added (decisions, conventions, commands). Found by looking
// (cheap, no model), refreshed when it is older than an hour, and shown in coding conversations
// and to team helpers as "## This project".
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { checksDb, detectCheckers } from './diagnostics.ts';
import { GIT_SAFE } from './tools/coding.ts';
import { repoFromRemote } from './tools/github.ts';
import { ToolError, type Tool } from './tools/types.ts';
import { resolveInside, workspaceDir } from './tools/workspace.ts';
import { ProjectCheckpointStore } from './project-checkpoints.ts';

export interface ProjectFacts {
  /** Folder of the repository inside the workspace ('.' for the workspace itself). */
  path: string;
  name: string;
  repo?: string;
  defaultBranch?: string;
  languages: string[];
  layout: string[];
  commands: { test?: string; build?: string; lint?: string; run?: string };
  conventions: string[];
  /** The first lines of AGENTS.md / CLAUDE.md / CONTRIBUTING.md (rules the project asks for). */
  rules?: string;
  readme?: string;
  recentCommits: string[];
  /** Phase 120 (PRECISE §4.2): the project's own type checkers and linters, found from files only. */
  checkers?: { id: string; label: string; installed: boolean; runsProjectCode: boolean }[];
}

export interface ProjectNote {
  id: number;
  kind: 'decision' | 'convention' | 'command' | 'note';
  text: string;
  at: string;
}

export interface ProjectKnowledge {
  workspace: string;
  path: string;
  /** Phase 120: the owner's choice for checks after her edits here. */
  checks?: 'ask' | 'on' | 'off';
  facts: ProjectFacts;
  notes: ProjectNote[];
  updatedAt: string;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);
const LANG: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.jsx': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C', '.css': 'CSS', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart', '.sh': 'Shell', '.sql': 'SQL' };
const CONV_FILES = ['.editorconfig', '.prettierrc', '.prettierrc.json', 'prettier.config.js', 'eslint.config.js', '.eslintrc', '.eslintrc.json', 'biome.json', 'tsconfig.json', 'ruff.toml', '.rustfmt.toml', 'rustfmt.toml', '.golangci.yml', 'deno.json'];
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md'];

const read = (p: string, max = 4000): string => {
  try {
    return readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

function gitOut(dir: string, args: string[]): string {
  try {
    // The same switched-off settings as every git command she runs (a repository's own config
    // can't make these read-only looks run other programs).
    return execFileSync('git', [...GIT_SAFE, '-c', 'log.showSignature=false', '-C', dir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Repositories in a workspace: the workspace itself if it is one, else folders up to two levels down. */
export function findRepos(ws: string): string[] {
  if (existsSync(join(ws, '.git'))) return [ws];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, '.git'))) out.push(p);
      else if (depth < 2) walk(p, depth + 1);
    }
  };
  walk(ws, 1);
  // A workspace with code but no git at all is still a project.
  if (!out.length && readdirSync(ws).some((n) => /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile)$/.test(n))) out.push(ws);
  return out.slice(0, 10);
}

/** Looks at one repository and writes down what it finds. */
export function scanProject(ws: string, dir: string): ProjectFacts {
  const rel = relative(ws, dir).split(sep).join('/') || '.';
  const commands: ProjectFacts['commands'] = {};
  const conventions: string[] = [];
  let name = rel === '.' ? (dir.split(/[\\/]/).pop() ?? 'project') : rel;
  // package.json
  const pkgText = read(join(dir, 'package.json'), 20_000);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { name?: string; scripts?: Record<string, string>; type?: string; packageManager?: string; engines?: Record<string, string> };
      if (pkg.name) name = pkg.name;
      const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : existsSync(join(dir, 'bun.lockb')) ? 'bun' : 'npm';
      const s = pkg.scripts ?? {};
      const run = (k: string) => (pm === 'npm' ? (k === 'test' ? 'npm test' : `npm run ${k}`) : `${pm} ${k}`);
      if (s.test) commands.test = run('test');
      else if (s.check) commands.test = run('check');
      if (s.build) commands.build = run('build');
      if (s.lint) commands.lint = run('lint');
      else if (s.typecheck) commands.lint = run('typecheck');
      if (s.dev) commands.run = run('dev');
      else if (s.start) commands.run = run('start');
      if (pkg.type === 'module') conventions.push('ES modules (package.json "type": "module")');
      if (pkg.engines?.node) conventions.push(`Node ${pkg.engines.node}`);
      conventions.push(`package manager: ${pm}`);
    } catch {
      /* not JSON */
    }
  }
  if (!commands.test && existsSync(join(dir, 'pyproject.toml'))) commands.test = /pytest/.test(read(join(dir, 'pyproject.toml'))) || existsSync(join(dir, 'tests')) ? 'pytest' : 'python -m unittest';
  if (existsSync(join(dir, 'Cargo.toml'))) {
    commands.test ??= 'cargo test';
    commands.build ??= 'cargo build';
    commands.lint ??= 'cargo clippy';
  }
  if (existsSync(join(dir, 'go.mod'))) {
    commands.test ??= 'go test ./...';
    commands.build ??= 'go build ./...';
    commands.lint ??= 'go vet ./...';
  }
  const make = read(join(dir, 'Makefile'));
  if (make) for (const k of ['test', 'build', 'lint'] as const) if (!commands[k] && new RegExp(`^${k}:`, 'm').test(make)) commands[k] = `make ${k}`;
  // Languages and layout.
  const counts = new Map<string, number>();
  let files = 0;
  const walk = (d: string, depth: number) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > 4000) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.') && depth < 6) walk(join(d, e.name), depth + 1);
      } else {
        files++;
        const lang = LANG[extname(e.name).toLowerCase()];
        if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  };
  walk(dir, 0);
  const languages = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${l} (${n})`);
  const layout = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !SKIP.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 30)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  for (const f of CONV_FILES) if (existsSync(join(dir, f))) conventions.push(f);
  const tsconfig = read(join(dir, 'tsconfig.json'));
  if (/"strict"\s*:\s*true/.test(tsconfig)) conventions.push('TypeScript strict mode');
  const rules = RULE_FILES.map((f) => [f, read(join(dir, f), 1500)] as const)
    .filter(([, t]) => t.trim())
    .map(([f, t]) => `${f}:\n${t.trim()}`)
    .join('\n\n')
    .slice(0, 2000);
  const readmeName = readdirSync(dir).find((n) => /^readme(\.md|\.txt)?$/i.test(n));
  const readme = readmeName ? read(join(dir, readmeName), 600).replace(/\s+/g, ' ').trim() : undefined;
  // Git.
  const remote = gitOut(dir, ['remote', 'get-url', 'origin']);
  const repo = remote ? repoFromRemote(remote) : undefined;
  const head = gitOut(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  const defaultBranch = head || gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  const recentCommits = gitOut(dir, ['log', '-5', '--format=%s']).split('\n').filter(Boolean);
  let checkers: ProjectFacts['checkers'];
  try {
    checkers = detectCheckers(dir).map((c) => ({ id: c.id, label: c.label, installed: c.installed, runsProjectCode: c.runsProjectCode }));
  } catch {
    /* never breaks the scan */
  }
  return { ...(checkers?.length ? { checkers } : {}), path: rel, name, ...(repo ? { repo } : {}), ...(defaultBranch && defaultBranch !== 'HEAD' ? { defaultBranch } : {}), languages, layout, commands, conventions, ...(rules ? { rules } : {}), ...(readme ? { readme } : {}), recentCommits };
}

const FRESH_MS = 3600_000;

export class ProjectKnowledgeStore {
  readonly checkpoints: ProjectCheckpointStore;
  readonly #db: DatabaseSync;
  readonly #app: AppContext;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    this.checkpoints = new ProjectCheckpointStore(app, db);
    db.exec(`
CREATE TABLE IF NOT EXISTS project_knowledge (
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  facts TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, path)
);
CREATE TABLE IF NOT EXISTS project_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);`);
  }

  #ws(workspace: string): string {
    return workspaceDir(this.#app.rootDir ?? this.#app.dataDir, workspace);
  }

  /** Existing canonical keys only: checkpoint operations must never trigger project scans. */
  knownPaths(workspace: string): string[] {
    return (this.#db.prepare('SELECT path FROM project_knowledge WHERE workspace = ? ORDER BY path').all(workspace) as { path: string }[]).map(row => row.path);
  }

  /** What she knows about every project in a workspace (looks again when older than an hour or `fresh`). */
  get(workspace: string, opts: { fresh?: boolean } = {}): ProjectKnowledge[] {
    const ws = this.#ws(workspace);
    const now = this.#app.now();
    const rows = this.#db.prepare('SELECT * FROM project_knowledge WHERE workspace = ?').all(workspace) as { path: string; facts: string; updated_at: string }[];
    const stale = opts.fresh || !rows.length || rows.some((r) => now.getTime() - Date.parse(r.updated_at) > FRESH_MS);
    if (stale) {
      const repos = findRepos(ws);
      this.#db.prepare('DELETE FROM project_knowledge WHERE workspace = ?').run(workspace);
      for (const dir of repos) {
        const f = scanProject(ws, dir);
        this.#db.prepare('INSERT INTO project_knowledge (workspace, path, facts, updated_at) VALUES (?, ?, ?, ?)').run(workspace, f.path, JSON.stringify(f), now.toISOString());
      }
    }
    return (this.#db.prepare('SELECT * FROM project_knowledge WHERE workspace = ? ORDER BY path').all(workspace) as { path: string; facts: string; updated_at: string }[]).map((r) => ({
      workspace,
      path: r.path,
      facts: JSON.parse(r.facts) as ProjectFacts,
      notes: this.notes(workspace, r.path),
      updatedAt: r.updated_at,
      checks: (() => {
        try {
          return checksDb(this.#app).choice(workspace, r.path).state;
        } catch {
          return undefined;
        }
      })(),
    }));
  }

  notes(workspace: string, path: string): ProjectNote[] {
    return (this.#db.prepare('SELECT * FROM project_notes WHERE workspace = ? AND path = ? ORDER BY id').all(workspace, path) as { id: number; kind: string; text: string; at: string }[]).map((r) => ({ id: r.id, kind: r.kind as ProjectNote['kind'], text: r.text, at: r.at }));
  }

  addNote(workspace: string, path: string, kind: ProjectNote['kind'], text: string): ProjectNote {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) throw new Error('Write the note.');
    const dup = this.notes(workspace, path).find((n) => n.text.toLowerCase() === t.toLowerCase());
    if (dup) return dup;
    const at = this.#app.now().toISOString();
    const id = Number(this.#db.prepare('INSERT INTO project_notes (workspace, path, kind, text, at) VALUES (?, ?, ?, ?, ?)').run(workspace, path, kind, t, at).lastInsertRowid);
    // Keep the newest 40 per project.
    this.#db.prepare('DELETE FROM project_notes WHERE workspace = ? AND path = ? AND id NOT IN (SELECT id FROM project_notes WHERE workspace = ? AND path = ? ORDER BY id DESC LIMIT 40)').run(workspace, path, workspace, path);
    return { id, kind, text: t, at };
  }

  deleteNote(id: number): boolean {
    return this.#db.prepare('DELETE FROM project_notes WHERE id = ?').run(id).changes > 0;
  }
}

/** "## This project" for her prompt and the helpers' (about 2500 characters at most). */
export function projectSection(list: ProjectKnowledge[]): string | undefined {
  if (!list.length) return undefined;
  const one = (k: ProjectKnowledge) => {
    const f = k.facts;
    const cmds = Object.entries(f.commands).map(([n, c]) => `${n}: \`${c}\``).join(', ');
    return [
      `${f.name}${k.path !== '.' ? ` (folder ${k.path})` : ''}${f.repo ? `, GitHub ${f.repo}` : ''}${f.defaultBranch ? `, default branch ${f.defaultBranch}` : ''}`,
      f.languages.length ? `Languages: ${f.languages.join(', ')}` : '',
      cmds ? `Commands: ${cmds}` : '',
      // Phase 120: one line for the type check (the turn's checks run it after her edits when allowed).
      f.checkers?.some((c) => c.installed) ? `Type check: ${f.checkers.filter((c) => c.installed).map((c) => c.label).join(', ')}${k.checks === 'on' ? ' (Sara checks your edits)' : ''}` : '',
      f.layout.length ? `Layout: ${f.layout.join(' ')}` : '',
      f.conventions.length ? `Conventions: ${f.conventions.join('; ')}` : '',
      f.rules ? `The project's own rules (follow them):\n${f.rules.slice(0, 900)}` : '',
      k.notes.length ? `Notes you kept:\n${k.notes.slice(-10).map((n) => `- (${n.kind}) ${n.text}`).join('\n')}` : '',
      f.recentCommits.length ? `Recent commits: ${f.recentCommits.slice(0, 3).join(' · ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };
  return list.map(one).join('\n\n').slice(0, 3000);
}

/** Her tool: keep a note about this project (a decision, a convention, a command). */
export function createProjectNoteTool(app: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'project_note',
      description: "Keep a note about this coding project so you remember it next time: a decision made together, a convention to follow, or a command that works (e.g. 'tests need `npm run build` first'). Short and specific.",
      parameters: {
        type: 'object',
        properties: { note: { type: 'string' }, kind: { type: 'string', enum: ['decision', 'convention', 'command', 'note'] }, path: { type: 'string', description: "The project's folder in the workspace (default: the only or first one)." } },
        required: ['note'],
      },
    },
    isAvailable: () => Boolean(app().projects),
    summarize: (a) => `Project note: ${String(a.note ?? '').slice(0, 120)}`,
    async run(args, ctx) {
      const a = app();
      const conv = ctx.conversationId ? a.store.getConversation(ctx.conversationId) : undefined;
      if (!conv || !a.projects) throw new ToolError('Project notes need a conversation with a workspace.');
      const list = a.projects.get(conv.workspace);
      const want = typeof args.path === 'string' && args.path.trim() ? args.path.trim().replace(/\/+$/, '') : undefined;
      if (want) resolveInside(workspaceDir(a.rootDir ?? a.dataDir, conv.workspace), want);
      const k = want ? list.find((x) => x.path === want) : list[0];
      const path = k?.path ?? want ?? '.';
      const kind = ['decision', 'convention', 'command', 'note'].includes(String(args.kind)) ? (String(args.kind) as ProjectNote['kind']) : 'note';
      const n = a.projects.addNote(conv.workspace, path, kind, String(args.note ?? ''));
      return `Noted for ${k?.facts.name ?? path}: (${n.kind}) ${n.text}`;
    },
  };
}

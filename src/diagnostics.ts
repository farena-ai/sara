// Phase 120 part A (docs/design/PRECISE.md §4, 2.53.0): checks after her edits. After she changes
// files, the project's OWN type checker or linter (tsc, pyright or mypy, cargo check, go vet, eslint)
// runs through the Phase 118 check runner (persist.ts runProjectCommand: the workspace sandbox,
// network off, a time limit, the redactor, refused by classifyCommand when it installs, deletes,
// changes the system or uses the network), its output is parsed here, compared with what the files
// had before her first change in this turn, and the block goes into the SAME tool result she reads
// next. Nothing is installed or fetched, no model is called, and every project needs the owner's OK
// once (§4.3). The optional language-server engine (§4.9) is not in this release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, posix, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext, ChatEvent } from './chat.ts';
import { en } from './i18n.ts';
import { fingerprint, fpChanges, runProjectCommand, type Fingerprint } from './persist.ts';
import { findRepos } from './projectknow.ts';
import type { Conversation } from './store.ts';
import { windowsShell } from './tools/sandbox.ts';
import { inside, resolveInside } from './tools/workspace.ts';

// ------------------------------------------------------------------ settings (§3.3)

export interface PreciseSettings {
  checks: { on: boolean; waitS: number; timeoutS: number; shown: number; warnings: boolean; nudges: number };
  refs: { on: boolean; perRefChars: number; softPct: number; hardPct: number; folderEntries: number; urls: boolean; olderAs: 'stub' | 'full' };
}
export const PRECISE_CHOICES = {
  waitS: [5, 10, 20, 30],
  timeoutS: [30, 60, 120, 300],
  shown: [10, 20, 50],
  nudges: [0, 1, 2, 3],
  perRefChars: [20_000, 40_000, 80_000],
} as const;
export const DEFAULT_PRECISE: PreciseSettings = {
  checks: { on: true, waitS: 20, timeoutS: 60, shown: 20, warnings: false, nudges: 2 },
  refs: { on: true, perRefChars: 40_000, softPct: 25, hardPct: 50, folderEntries: 200, urls: true, olderAs: 'stub' },
};
const pick = (v: unknown, list: readonly number[], dflt: number, testAny = false): number => {
  const n = Number(v);
  if (testAny && Number.isFinite(n) && n > 0 && process.env.SARA_TEST_PRECISE === '1') return n;
  return Number.isFinite(n) && list.includes(n) ? n : dflt;
};

/** Settings → Coding → Check her edits (owner settings; unknown values fall back to the defaults). */
export function preciseSettings(app: AppContext): PreciseSettings {
  const raw = ((app.settings.get() as { precise?: { checks?: Partial<PreciseSettings['checks']>; refs?: Partial<PreciseSettings['refs']> } }).precise ?? {});
  const c = raw.checks ?? {};
  const r = raw.refs ?? {};
  const D = DEFAULT_PRECISE;
  return {
    checks: {
      on: c.on !== false,
      // Tests may use short waits (SARA_TEST_PRECISE=1); the app only takes the listed choices.
      waitS: pick(c.waitS, PRECISE_CHOICES.waitS, D.checks.waitS, true),
      timeoutS: pick(c.timeoutS, PRECISE_CHOICES.timeoutS, D.checks.timeoutS, true),
      shown: pick(c.shown, PRECISE_CHOICES.shown, D.checks.shown),
      warnings: c.warnings === true,
      nudges: pick(c.nudges, PRECISE_CHOICES.nudges, D.checks.nudges),
    },
    refs: {
      on: r.on !== false,
      perRefChars: pick(r.perRefChars, PRECISE_CHOICES.perRefChars, D.refs.perRefChars, true),
      softPct: D.refs.softPct,
      hardPct: D.refs.hardPct,
      folderEntries: D.refs.folderEntries,
      urls: r.urls !== false,
      olderAs: r.olderAs === 'full' ? 'full' : 'stub',
    },
  };
}

/** PUT /api/precise: each value kept only when it is one of the offered choices. */
export function mergePrecise(app: AppContext, body: Record<string, unknown>): PreciseSettings {
  const cur = preciseSettings(app);
  const c = (body.checks ?? {}) as Record<string, unknown>;
  const r = (body.refs ?? {}) as Record<string, unknown>;
  const b = (v: unknown, d: boolean) => (v === undefined ? d : Boolean(v));
  const next: PreciseSettings = {
    checks: {
      on: b(c.on, cur.checks.on),
      waitS: pick(c.waitS, PRECISE_CHOICES.waitS, cur.checks.waitS),
      timeoutS: pick(c.timeoutS, PRECISE_CHOICES.timeoutS, cur.checks.timeoutS),
      shown: pick(c.shown, PRECISE_CHOICES.shown, cur.checks.shown),
      warnings: b(c.warnings, cur.checks.warnings),
      nudges: pick(c.nudges, PRECISE_CHOICES.nudges, cur.checks.nudges),
    },
    refs: {
      ...cur.refs,
      on: b(r.on, cur.refs.on),
      perRefChars: pick(r.perRefChars, PRECISE_CHOICES.perRefChars, cur.refs.perRefChars),
      urls: b(r.urls, cur.refs.urls),
      olderAs: r.olderAs === undefined ? cur.refs.olderAs : r.olderAs === 'full' ? 'full' : 'stub',
    },
  };
  app.settings.update({ precise: next } as never);
  return next;
}

// ------------------------------------------------------------------ P1 detection (§4.2)

export type CheckerId = 'tsc' | 'pyright' | 'mypy' | 'cargo' | 'govet' | 'eslint';
export type Format = 'tsc' | 'pyright' | 'mypy' | 'cargo' | 'govet' | 'eslint';
export interface Checker {
  id: CheckerId;
  lang: string;
  /** How it is named on cards and in the block ("tsc --noEmit"). */
  label: string;
  /** The argv (no shell); `node` / `python` are resolved when it runs. */
  argv: string[];
  files: 'touched' | 'project';
  format: Format;
  runsProjectCode: boolean;
  installed: boolean;
  /** The config file it was found by (project-relative). */
  config: string;
  /** Not installed: the command the owner can copy (never run by Sara). */
  install?: string;
  /** The project's own script that runs the same check (shown, never run). */
  script?: string;
}

const EXT: Record<CheckerId, RegExp> = {
  tsc: /\.(ts|tsx|mts|cts)$/i,
  eslint: /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i,
  pyright: /\.pyi?$/i,
  mypy: /\.pyi?$/i,
  cargo: /\.rs$/i,
  govet: /\.go$/i,
};
export const checksFile = (id: CheckerId, path: string): boolean => EXT[id].test(path);

const readText = (p: string, max = 50_000): string => {
  try {
    return readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

/** A program on the PATH commands get (cargo, go): looked up, never run to find out. */
export function onPath(bin: string, pathVar = process.env.PATH ?? ''): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of pathVar.split(delimiter).filter(Boolean)) for (const e of exts) if (existsSync(join(d, bin + e))) return true;
  return false;
}

function venvPython(dir: string): string | undefined {
  for (const v of ['.venv', 'venv']) {
    for (const p of [join(v, 'Scripts', 'python.exe'), join(v, 'bin', 'python')]) if (existsSync(join(dir, p))) return p.split(sep).join('/');
  }
  return undefined;
}
function venvHas(dir: string, mod: string): boolean {
  for (const v of ['.venv', 'venv']) {
    if (existsSync(join(dir, v, 'Lib', 'site-packages', mod))) return true;
    let libs: string[] = [];
    try {
      libs = readdirSync(join(dir, v, 'lib'));
    } catch {
      /* none */
    }
    if (libs.some((l) => existsSync(join(dir, v, 'lib', l, 'site-packages', mod)))) return true;
  }
  return false;
}

/** The checkers a project has, found only from files that are there (§4.2). No network, no npx, no install. */
export function detectCheckers(dir: string, o: { path?: string } = {}): Checker[] {
  const out: Checker[] = [];
  const has = (p: string) => existsSync(join(dir, p));
  let pkg: { scripts?: Record<string, string>; eslintConfig?: unknown } = {};
  try {
    pkg = JSON.parse(readText(join(dir, 'package.json'))) as typeof pkg;
  } catch {
    /* no package.json */
  }
  const scripts = pkg.scripts ?? {};
  const scriptFor = (re: RegExp): string | undefined => {
    for (const k of ['typecheck', 'type-check', 'types', 'lint', 'check']) if (scripts[k] && re.test(scripts[k])) return `${k}: ${scripts[k]}`;
    return undefined;
  };
  const tsconfig = has('tsconfig.json') ? 'tsconfig.json' : has('jsconfig.json') && /"checkJs"\s*:\s*true/.test(readText(join(dir, 'jsconfig.json'))) ? 'jsconfig.json' : '';
  if (tsconfig) {
    const installed = has('node_modules/typescript/bin/tsc');
    out.push({ id: 'tsc', lang: 'TypeScript', label: 'tsc --noEmit', argv: ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', tsconfig], files: 'project', format: 'tsc', runsProjectCode: false, installed, config: tsconfig, ...(installed ? {} : { install: 'npm i -D typescript' }), ...(scriptFor(/\btsc\b/) ? { script: scriptFor(/\btsc\b/) } : {}) });
  }
  const pyproject = readText(join(dir, 'pyproject.toml'));
  const pyrightCfg = has('pyrightconfig.json') ? 'pyrightconfig.json' : /^\[tool\.pyright\]/m.test(pyproject) ? 'pyproject.toml' : '';
  const mypyCfg = has('mypy.ini') ? 'mypy.ini' : has('.mypy.ini') ? '.mypy.ini' : /^\[mypy\]/m.test(readText(join(dir, 'setup.cfg'))) ? 'setup.cfg' : /^\[tool\.mypy\]/m.test(pyproject) ? 'pyproject.toml' : '';
  const py = venvPython(dir);
  if (pyrightCfg) {
    const nodePyright = has('node_modules/pyright/index.js');
    const venvPyright = ['.venv/bin/pyright', '.venv/Scripts/pyright.exe', 'venv/bin/pyright'].find((p) => has(p));
    const installed = nodePyright || Boolean(venvPyright);
    out.push({ id: 'pyright', lang: 'Python', label: 'pyright', argv: nodePyright ? ['node', 'node_modules/pyright/index.js', '--outputjson'] : [venvPyright ?? 'pyright', '--outputjson'], files: 'touched', format: 'pyright', runsProjectCode: false, installed, config: pyrightCfg, ...(installed ? {} : { install: 'npm i -D pyright' }) });
  } else if (mypyCfg) {
    // Pyright beats mypy when both are set up (one Python checker per project).
    const installed = Boolean(py) && venvHas(dir, 'mypy');
    out.push({ id: 'mypy', lang: 'Python', label: 'mypy', argv: [py ?? 'python', '-m', 'mypy', '--show-column-numbers', '--no-error-summary', '--no-pretty', '--no-color-output'], files: 'touched', format: 'mypy', runsProjectCode: true, installed, config: mypyCfg, ...(installed ? {} : { install: 'pip install mypy' }) });
  }
  if (has('Cargo.toml')) {
    const installed = onPath('cargo', o.path);
    out.push({ id: 'cargo', lang: 'Rust', label: 'cargo check', argv: ['cargo', 'check', '--offline', '--message-format=short', '--quiet'], files: 'project', format: 'cargo', runsProjectCode: true, installed, config: 'Cargo.toml', ...(installed ? {} : { install: 'https://rustup.rs' }) });
  }
  if (has('go.mod')) {
    const installed = onPath('go', o.path);
    out.push({ id: 'govet', lang: 'Go', label: 'go vet', argv: ['go', 'vet'], files: 'touched', format: 'govet', runsProjectCode: false, installed, config: 'go.mod', ...(installed ? {} : { install: 'https://go.dev/dl/' }) });
  }
  const eslintCfg = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'].find((f) => has(f)) ?? (pkg.eslintConfig ? 'package.json' : '');
  if (eslintCfg) {
    const installed = has('node_modules/eslint/bin/eslint.js');
    out.push({ id: 'eslint', lang: 'JavaScript', label: 'eslint', argv: ['node', 'node_modules/eslint/bin/eslint.js', '--format', 'unix', '--no-warn-ignored'], files: 'touched', format: 'eslint', runsProjectCode: true, installed, config: eslintCfg, ...(installed ? {} : { install: 'npm i -D eslint' }), ...(scriptFor(/\beslint\b/) ? { script: scriptFor(/\beslint\b/) } : {}) });
  }
  return out;
}

/** The "## This project" line (§4.11). */
export function checkersLine(list: Checker[], state?: 'ask' | 'on' | 'off'): string | undefined {
  const ok = list.filter((c) => c.installed);
  if (!ok.length) return undefined;
  const tail = state === 'on' ? ' (Sara checks your edits)' : '';
  return `Type check: ${ok.map((c) => c.label).join(', ')}${tail}`;
}

// ------------------------------------------------------------------ P4 parsers

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  code?: string;
  message: string;
  source: string;
}

/**
 * A checker's path → workspace-relative with forward slashes, or undefined when it isn't inside the
 * workspace (dropped). Accepts `\`, drive letters, the sandbox's `/workspace/`, and paths relative to
 * the project folder.
 */
export function relPath(ws: string, project: string, p: string): string | undefined {
  const f = p.trim().replace(/\\/g, '/');
  const w = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel: string;
  if (f.toLowerCase().startsWith(`${w.toLowerCase()}/`)) rel = f.slice(w.length + 1);
  else if (f.startsWith('/workspace/')) rel = f.slice('/workspace/'.length);
  else if (/^[A-Za-z]:\//.test(f) || f.startsWith('/')) return undefined;
  else rel = posix.join(project === '.' ? '' : project, f);
  rel = posix.normalize(rel);
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || posix.isAbsolute(rel)) return undefined;
  return rel;
}

const cut = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Reads one checker's output into diagnostics (pure; recorded fixtures in the tests). */
export function parseOutput(format: Format, out: string, ws: string, project: string): Diagnostic[] {
  const d: Diagnostic[] = [];
  const add = (file: string, line: number, col: number, severity: string, message: string, code: string | undefined, source: string) => {
    const rel = relPath(ws, project, file);
    if (!rel) return;
    d.push({ file: rel, line, col, severity: /warn/i.test(severity) ? 'warning' : 'error', ...(code ? { code } : {}), message: cut(message.trim()), source });
  };
  if (format === 'pyright') {
    const start = out.indexOf('{');
    try {
      const j = JSON.parse(out.slice(start)) as { generalDiagnostics?: { file: string; severity: string; message: string; rule?: string; range?: { start?: { line?: number; character?: number } } }[] };
      for (const g of j.generalDiagnostics ?? []) {
        if (g.severity === 'information') continue;
        add(g.file, (g.range?.start?.line ?? 0) + 1, (g.range?.start?.character ?? 0) + 1, g.severity, g.message.split('\n')[0], g.rule, 'pyright');
      }
    } catch {
      /* not JSON: nothing parsed */
    }
    return d;
  }
  for (const raw of out.split(/\r?\n/)) {
    const l = raw.replace(/\r$/, '');
    let m: RegExpExecArray | null;
    if (format === 'tsc') {
      if ((m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(l))) add(m[1], +m[2], +m[3], m[4], m[6], m[5], 'tsc');
    } else if (format === 'mypy') {
      if ((m = /^(.+?):(\d+):(?:(\d+):)? (error|warning): (.*?)(?:\s+\[([\w-]+)\])?$/.exec(l))) add(m[1], +m[2], +(m[3] ?? 1), m[4], m[5], m[6], 'mypy');
    } else if (format === 'cargo') {
      if ((m = /^(.+?\.rs):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/.exec(l))) add(m[1], +m[2], +m[3], m[4], m[6], m[5], 'cargo');
    } else if (format === 'govet') {
      if ((m = /^(?:vet: )?(?:# \S+\s+)?(.+?\.go):(\d+):(\d+): (.*)$/.exec(l))) add(m[1], +m[2], +m[3], 'error', m[4], undefined, 'go vet');
    } else if (format === 'eslint') {
      if ((m = /^(.+?):(\d+):(\d+): (.*?) \[(Error|Warning)\/(.+?)\]$/.exec(l))) add(m[1], +m[2], +m[3], m[5], m[4], m[6], 'eslint');
    }
  }
  return d;
}

/** "New" is decided on this key: file, code and the message, never the line (a shift above isn't new). */
export const diagKey = (x: Diagnostic): string => `${x.file}|${x.code ?? ''}|${x.message.replace(/\s+/g, ' ').trim()}`;
export const diagLine = (x: Diagnostic): string => `${x.file}:${x.line}:${x.col} ${x.severity}${x.code ? ` ${x.code}` : ''}: ${x.message}`;

// ------------------------------------------------------------------ tables (§4.12): the shared code cache

export type ProjectState = 'ask' | 'on' | 'off';
export interface ProjectChoice {
  workspace: string;
  project: string;
  state: ProjectState;
  checkers: CheckerId[];
  python?: 'pyright' | 'mypy';
  askedAt?: string;
  decidedAt?: string;
}
export interface DiagRun {
  id: number;
  workspace: string;
  project: string;
  checker: string;
  engine: 'command';
  files: string[] | '*';
  startedAt: string;
  ms: number | null;
  exitCode: number | null;
  state: 'ok' | 'errors' | 'broken' | 'timeout' | 'stopped' | 'refused';
  errors: number;
  warnings: number;
  otherErrors: number;
  note: string | null;
}

/**
 * The checks database: `diag_cache` / `diag_runs` (a fact about files in a workspace, shared by every
 * companion working there) and `project_checks` (the owner's OK per project). One file in the shared
 * code cache folder, next to the code maps (§3.2).
 */
export class ChecksDb {
  readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS diag_cache (
  workspace TEXT NOT NULL, project TEXT NOT NULL, checker TEXT NOT NULL, file TEXT NOT NULL,
  sha TEXT NOT NULL, diags TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (workspace, project, checker, file)
);
CREATE TABLE IF NOT EXISTS diag_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, project TEXT NOT NULL, checker TEXT NOT NULL,
  engine TEXT NOT NULL, files TEXT NOT NULL, started_at TEXT NOT NULL, ms INTEGER, exit_code INTEGER,
  state TEXT NOT NULL, errors INTEGER NOT NULL DEFAULT 0, warnings INTEGER NOT NULL DEFAULT 0,
  other_errors INTEGER NOT NULL DEFAULT 0, note TEXT
);
CREATE INDEX IF NOT EXISTS diag_runs_ws ON diag_runs(workspace, project, id);
CREATE TABLE IF NOT EXISTS project_checks (
  workspace TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, checkers TEXT NOT NULL,
  python TEXT, asked_at TEXT, decided_at TEXT,
  PRIMARY KEY (workspace, project)
);`);
  }
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
  choice(workspace: string, project: string): ProjectChoice {
    const r = this.db.prepare('SELECT * FROM project_checks WHERE workspace = ? AND project = ?').get(workspace, project) as Record<string, string | null> | undefined;
    if (!r) return { workspace, project, state: 'ask', checkers: [] };
    return { workspace, project, state: (r.state as ProjectState) ?? 'ask', checkers: JSON.parse(String(r.checkers ?? '[]')) as CheckerId[], ...(r.python ? { python: r.python as 'pyright' } : {}), ...(r.asked_at ? { askedAt: r.asked_at } : {}), ...(r.decided_at ? { decidedAt: r.decided_at } : {}) };
  }
  setChoice(c: ProjectChoice): void {
    this.db.prepare('INSERT INTO project_checks (workspace, project, state, checkers, python, asked_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, project) DO UPDATE SET state = excluded.state, checkers = excluded.checkers, python = excluded.python, asked_at = excluded.asked_at, decided_at = excluded.decided_at').run(c.workspace, c.project, c.state, JSON.stringify(c.checkers), c.python ?? null, c.askedAt ?? null, c.decidedAt ?? null);
  }
  cached(workspace: string, project: string, checker: string, file: string): { sha: string; diags: Diagnostic[] } | undefined {
    const r = this.db.prepare('SELECT sha, diags FROM diag_cache WHERE workspace = ? AND project = ? AND checker = ? AND file = ?').get(workspace, project, checker, file) as { sha: string; diags: string } | undefined;
    return r ? { sha: r.sha, diags: JSON.parse(r.diags) as Diagnostic[] } : undefined;
  }
  cacheAll(workspace: string, project: string, checker?: string): { file: string; checker: string; sha: string; diags: Diagnostic[]; at: string }[] {
    return (this.db.prepare(`SELECT file, checker, sha, diags, at FROM diag_cache WHERE workspace = ? AND project = ?${checker ? ' AND checker = ?' : ''} ORDER BY file`).all(...[workspace, project, ...(checker ? [checker] : [])]) as { file: string; checker: string; sha: string; diags: string; at: string }[]).map((r) => ({ ...r, diags: JSON.parse(r.diags) as Diagnostic[] }));
  }
  putCache(workspace: string, project: string, checker: string, file: string, sha: string, diags: Diagnostic[], at: string): void {
    this.db.prepare('INSERT INTO diag_cache (workspace, project, checker, file, sha, diags, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, project, checker, file) DO UPDATE SET sha = excluded.sha, diags = excluded.diags, at = excluded.at').run(workspace, project, checker, file, sha, JSON.stringify(diags.slice(0, 200)), at);
  }
  trimCache(workspace: string, project: string): void {
    this.db.prepare('DELETE FROM diag_cache WHERE workspace = ? AND project = ? AND rowid NOT IN (SELECT rowid FROM diag_cache WHERE workspace = ? AND project = ? ORDER BY at DESC LIMIT 2000)').run(workspace, project, workspace, project);
  }
  addRun(r: Omit<DiagRun, 'id'>): number {
    const id = Number(this.db.prepare('INSERT INTO diag_runs (workspace, project, checker, engine, files, started_at, ms, exit_code, state, errors, warnings, other_errors, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.workspace, r.project, r.checker, r.engine, JSON.stringify(r.files === '*' ? '*' : r.files.slice(0, 50)), r.startedAt, r.ms, r.exitCode, r.state, r.errors, r.warnings, r.otherErrors, r.note).lastInsertRowid);
    this.db.prepare('DELETE FROM diag_runs WHERE workspace = ? AND project = ? AND id NOT IN (SELECT id FROM diag_runs WHERE workspace = ? AND project = ? ORDER BY id DESC LIMIT 200)').run(r.workspace, r.project, r.workspace, r.project);
    return id;
  }
  runs(workspace: string, project?: string, limit = 20): DiagRun[] {
    const rows = this.db.prepare(`SELECT * FROM diag_runs WHERE workspace = ?${project ? ' AND project = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...[workspace, ...(project ? [project] : []), limit]) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), workspace: String(r.workspace), project: String(r.project), checker: String(r.checker), engine: 'command', files: JSON.parse(String(r.files)) as string[] | '*', startedAt: String(r.started_at), ms: r.ms === null ? null : Number(r.ms), exitCode: r.exit_code === null ? null : Number(r.exit_code), state: String(r.state) as DiagRun['state'], errors: Number(r.errors), warnings: Number(r.warnings), otherErrors: Number(r.other_errors), note: (r.note as string | null) ?? null }));
  }
}

const dbs = new Map<string, ChecksDb>();
/** The checks database of this server's data folder (opened once). */
export function checksDb(app: AppContext): ChecksDb {
  const file = join(app.rootDir ?? app.dataDir, 'cache', 'codemap', 'checks.db');
  let d = dbs.get(file);
  if (!d) {
    d = new ChecksDb(file);
    dbs.set(file, d);
  }
  return d;
}
/** Closes the checks database of a data folder (app shutdown, tests). */
export function closeChecks(app: AppContext): void {
  const file = join(app.rootDir ?? app.dataDir, 'cache', 'codemap', 'checks.db');
  dbs.get(file)?.close();
  dbs.delete(file);
}

// ------------------------------------------------------------------ projects and running a checker

export interface ProjectRef {
  /** Workspace-relative ('.' or 'packages/web'). */
  path: string;
  dir: string;
}
/** The project (repository) of the workspace that holds a workspace-relative file. */
export function projectOf(ws: string, file: string): ProjectRef | undefined {
  const repos = findRepos(ws).map((dir) => ({ dir, path: relative(ws, dir).split(sep).join('/') || '.' }));
  const abs = join(ws, file);
  return repos.filter((r) => inside(r.dir, abs)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
export function projectsOf(ws: string): ProjectRef[] {
  return findRepos(ws).map((dir) => ({ dir, path: relative(ws, dir).split(sep).join('/') || '.' }));
}

const sha = (p: string): string => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return 'missing';
  }
};

/** The command line of an argv: quoted for sh (bubblewrap, Seatbelt, Git Bash) or cmd.exe. */
export function commandLine(argv: string[], platform: NodeJS.Platform = process.platform): string {
  const first = argv[0] === 'node' ? (platform === 'win32' ? process.execPath.replace(/\\/g, '/') : 'node') : argv[0];
  const all = [first, ...argv.slice(1)];
  const sh = platform !== 'win32' || windowsShell().sh;
  return all.map((a) => (sh ? `'${a.replace(/'/g, `'\\''`)}'` : /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
}

/** Checker environment: never fetch (§4.10). */
export const CHECKER_ENV: Record<string, string> = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_offline: 'true', PIP_NO_INDEX: '1', GOFLAGS: '-mod=mod', GOPROXY: 'off', GOTOOLCHAIN: 'local', CARGO_NET_OFFLINE: 'true' };

export interface CheckerRun {
  checker: Checker;
  project: ProjectRef;
  diags: Diagnostic[];
  ms: number;
  exitCode: number | null;
  state: DiagRun['state'];
  note?: string;
  /** The files it was run for ('*' = the project). */
  files: string[] | '*';
}

/** Runs one checker once (no shell for the checker itself; the sandbox's own spawn path). */
export async function runChecker(app: AppContext, ws: string, project: ProjectRef, checker: Checker, files: string[] | '*', o: { signal: AbortSignal; timeoutMs: number; sandbox?: AppContext['sandbox'] }): Promise<CheckerRun> {
  const base = { checker, project, files } as const;
  if (!checker.installed || (checker.argv[1] && /node_modules/.test(checker.argv[1]) && !existsSync(join(project.dir, checker.argv[1])))) {
    return { ...base, diags: [], ms: 0, exitCode: null, state: 'broken', note: `${checker.label} is not installed in this project` };
  }
  const projFiles = files === '*' ? [] : files.map((f) => (project.path === '.' ? f : posix.relative(project.path, f)));
  const argv = [...checker.argv];
  if (checker.files === 'touched' && files !== '*') {
    if (checker.id === 'govet') argv.push(...[...new Set(projFiles.map((f) => `./${posix.dirname(f)}`.replace(/\/\.$/, '')))]);
    else argv.push(...projFiles);
  } else if (checker.id === 'govet') argv.push('./...');
  const r = await runProjectCommand(app, project.dir, commandLine(argv), { signal: o.signal, timeoutMs: o.timeoutMs, maxBytes: 400_000, env: CHECKER_ENV, ...(o.sandbox ? { sandbox: o.sandbox } : {}) });
  if (r.refused) return { ...base, diags: [], ms: r.ms, exitCode: null, state: 'refused', note: r.refused };
  if (o.signal.aborted) return { ...base, diags: [], ms: r.ms, exitCode: r.exitCode, state: 'stopped' };
  if (r.timedOut) return { ...base, diags: [], ms: r.ms, exitCode: r.exitCode, state: 'timeout' };
  const diags = parseOutput(checker.format, r.out, ws, project.path);
  if (r.exitCode !== 0 && !diags.length) return { ...base, diags, ms: r.ms, exitCode: r.exitCode, state: 'broken', note: `${checker.label} exited without a result (exit code ${r.exitCode ?? 'none'}, no file:line lines)` };
  return { ...base, diags, ms: r.ms, exitCode: r.exitCode, state: diags.some((x) => x.severity === 'error') ? 'errors' : 'ok' };
}

/** The checkers allowed in a project now (On, ticked, installed). */
export function allowedCheckers(app: AppContext, workspace: string, project: ProjectRef, found = detectCheckers(project.dir)): Checker[] {
  const c = checksDb(app).choice(workspace, project.path);
  if (c.state !== 'on') return [];
  return found.filter((k) => c.checkers.includes(k.id));
}

/** Source files of a project a checker covers (for a full check's baseline; ≤ 2,000). */
function sourceFiles(ws: string, dir: string, id: CheckerId): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', 'coverage', '.next', '.cache']);
  const walk = (d: string, depth: number) => {
    if (depth > 8 || out.length >= 2000) return;
    let list: import('node:fs').Dirent[] = [];
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (out.length >= 2000) return;
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), depth + 1);
      } else if (e.isFile() && checksFile(id, e.name)) out.push(relative(ws, join(d, e.name)).split(sep).join('/'));
    }
  };
  walk(dir, 0);
  return out;
}

/** Stores a run's results in the cache (the newest result per file and content hash) and the run row. */
function record(app: AppContext, workspace: string, ws: string, run: CheckerRun, touched: string[], full: boolean): void {
  const d = checksDb(app);
  const at = app.now().toISOString();
  const byFile = new Map<string, Diagnostic[]>();
  for (const x of run.diags) byFile.set(x.file, [...(byFile.get(x.file) ?? []), x]);
  if (run.state === 'ok' || run.state === 'errors') {
    const covered = full ? sourceFiles(ws, run.project.dir, run.checker.id) : [];
    const files = new Set([...byFile.keys(), ...touched.filter((f) => checksFile(run.checker.id, f)), ...covered]);
    for (const f of files) d.putCache(workspace, run.project.path, run.checker.id, f, sha(join(ws, f)), byFile.get(f) ?? [], at);
    // A project-wide checker: files that are clean now (and weren't touched) keep their hash with no problems.
    if (run.checker.files === 'project') for (const row of d.cacheAll(workspace, run.project.path, run.checker.id)) if (!files.has(row.file) && row.diags.length) d.putCache(workspace, run.project.path, run.checker.id, row.file, row.sha, [], at);
    d.trimCache(workspace, run.project.path);
  }
  const errors = run.diags.filter((x) => x.severity === 'error');
  const touchedSet = new Set(touched);
  d.addRun({ workspace, project: run.project.path, checker: run.checker.id, engine: 'command', files: run.files, startedAt: at, ms: run.ms, exitCode: run.exitCode, state: run.state, errors: errors.filter((x) => full || touchedSet.has(x.file)).length, warnings: run.diags.length - errors.length, otherErrors: full ? 0 : errors.filter((x) => !touchedSet.has(x.file)).length, note: run.note ?? null });
}

/** A full check of a project now (the first OK, *Run now*, `/problems check`, goals' Types check). */
export async function fullCheck(app: AppContext, workspace: string, ws: string, project: ProjectRef, signal: AbortSignal, o: { checkers?: Checker[] } = {}): Promise<CheckerRun[]> {
  const list = o.checkers ?? allowedCheckers(app, workspace, project);
  const out: CheckerRun[] = [];
  for (const c of list) {
    if (signal.aborted) break;
    const r = await runChecker(app, ws, project, c, c.files === 'project' ? '*' : sourceFiles(ws, project.dir, c.id).slice(0, 400), { signal, timeoutMs: preciseSettings(app).checks.timeoutS * 1000 });
    if (r.state !== 'stopped') record(app, workspace, ws, r, [], true);
    out.push(r);
  }
  return out;
}

/**
 * Phase 120 (§4.11): a goal's *Types check*: every installed type checker of every project in the
 * workspace over the whole project; red on any error (the check runs no matter the per-project OK,
 * because the owner picked it for this goal himself).
 */
export async function runTypesCheck(app: AppContext, workspace: string, ws: string, signal: AbortSignal): Promise<import('./persist.ts').CheckResult> {
  const t0 = Date.now();
  const runs: CheckerRun[] = [];
  for (const p of projectsOf(ws)) runs.push(...(await fullCheck(app, workspace, ws, p, signal, { checkers: detectCheckers(p.dir).filter((c) => c.installed && c.id !== 'eslint') })));
  const errors = runs.flatMap((r) => r.diags.filter((d) => d.severity === 'error'));
  const broken = runs.find((r) => r.state === 'broken' || r.state === 'timeout' || r.state === 'refused');
  const command = [...new Set(runs.map((r) => r.checker.label))].join(', ') || 'types';
  const ok = runs.length > 0 && !errors.length && !broken && !signal.aborted;
  const quote = ok ? '' : broken ? (broken.note ?? `${broken.checker.label}: ${broken.state}`) : errors.length ? diagLine(errors[0]) : en('No type checker is installed in this project.');
  return { kind: 'types', command, ok, exitCode: runs.at(-1)?.exitCode ?? null, timedOut: runs.some((r) => r.state === 'timeout'), key: ok ? null : `types|${errors[0] ? diagKey(errors[0]) : (broken?.state ?? 'none')}`, quote, tail: errors.slice(0, 40).map(diagLine).join('\n'), ms: Date.now() - t0, failed: errors.length, ...(broken || !runs.length ? { broken: quote } : {}) };
}

/** The latest problems of a project (or one file) from the cache: `@problem`, /problems, the project page. */
export function latestProblems(app: AppContext, workspace: string, project: string, file?: string): { diags: Diagnostic[]; checked: boolean; at?: string; checkers: string[] } {
  const rows = checksDb(app).cacheAll(workspace, project).filter((r) => !file || r.file === file);
  const runs = checksDb(app).runs(workspace, project, 1);
  const diags = rows.flatMap((r) => r.diags).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { diags, checked: runs.length > 0, ...(runs[0] ? { at: runs[0].startedAt } : {}), checkers: [...new Set(rows.map((r) => r.checker))] };
}

// ------------------------------------------------------------------ the block (§4.6)

export interface CheckOutcome {
  run: CheckerRun;
  /** Errors in the files she changed that weren't in their baseline (written out). */
  mine: Diagnostic[];
  /** Errors in the files she changed that were there before (counted), and their files. */
  before: number;
  beforeFiles: string[];
  /** Files she changed with no earlier check to compare with. */
  noBaseline: string[];
  /** Errors in other files (counted), and the ones her change broke (named, ≤ 3 files). */
  others: Diagnostic[];
  broke: Diagnostic[];
  warnings: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The text appended to the tool result (≤ 3,000 characters). */
export function blockText(list: CheckOutcome[], o: { shown: number; timeoutS: number; said: Set<string>; warnings: boolean; late?: boolean }): string {
  const parts: string[] = [];
  for (const x of [...list].sort((a, b) => (a.run.checker.id === 'tsc' ? -1 : b.run.checker.id === 'tsc' ? 1 : 0))) {
    const r = x.run;
    const secs = (r.ms / 1000).toFixed(1);
    const pre = o.late ? 'Check of your earlier edit: ' : '';
    if (r.state === 'timeout') {
      if (o.said.has(`timeout`)) continue;
      o.said.add('timeout');
      parts.push(`[${pre}The check took longer than ${o.timeoutS} s and was stopped.]`);
      continue;
    }
    if (r.state === 'broken' || r.state === 'refused') {
      if (o.said.has(`broken:${r.checker.id}`)) continue;
      o.said.add(`broken:${r.checker.id}`);
      parts.push(`[${pre}Couldn't check: ${r.note ?? `${r.checker.label} gave no result`}. Check by running it yourself if it matters.]`);
      continue;
    }
    if (r.state === 'stopped') continue;
    const head = `[${pre}Checked with ${r.checker.label} in ${secs} s`;
    // Errors in other files that weren't named as hers: counted only.
    const rest = x.others.filter((d) => !x.broke.includes(d));
    const otherFiles = new Set(rest.map((d) => d.file)).size;
    const othersLine = rest.length ? `(Also ${plural(rest.length, 'error')} in ${plural(otherFiles, 'other file')}, there before your edit.)` : '';
    const lines: string[] = [];
    if (!x.mine.length) {
      lines.push(`${head}: no ${x.before ? 'new ' : ''}errors in the files you changed.]`);
    } else {
      const fresh = x.noBaseline.length && x.mine.every((d) => x.noBaseline.includes(d.file));
      lines.push(`${head}]`);
      lines.push(`${plural(x.mine.length, fresh ? 'error' : 'new error')} in the files you changed${fresh ? ' (no earlier check of this file to compare with)' : ''}:`);
      const sorted = [...x.mine].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      for (const d of sorted.slice(0, o.shown)) lines.push(diagLine(d));
      if (sorted.length > o.shown) lines.push(`… and ${sorted.length - o.shown} more`);
    }
    if (x.before) lines.push(`(${plural(x.before, 'error')} in ${x.beforeFiles.slice(0, 3).join(', ') || 'the files you changed'} ${x.before === 1 ? 'was' : 'were'} there before your edit.)`);
    if (x.broke.length) {
      const files = [...new Set(x.broke.map((d) => d.file))];
      lines.push(`Your change broke ${plural(files.length, 'other file')}: ${files.slice(0, 3).map((f) => diagLine(x.broke.find((d) => d.file === f)!)).join(' · ')}`);
    }
    if (othersLine) lines.push(othersLine);
    if (!o.warnings && x.warnings) lines.push(`(and ${plural(x.warnings, 'warning')})`);
    parts.push(lines.join('\n'));
  }
  const s = parts.join('\n');
  return s.length > 3000 ? `${s.slice(0, 2980)}\n[… cut]` : s;
}

// ------------------------------------------------------------------ P3 the driver, per turn

/** The words that mean "leave the errors" (§4.7, §11 Q7), six languages. */
const LEAVE = /\b(leave|ignore|don'?t (?:fix|touch)) (?:the )?(?:type )?(?:errors?|types?)\b|\bdon'?t fix the types\b|\bwip\b|\bwork in progress\b|deja los errores|no arregles los tipos|laisse les erreurs|ne corrige pas les types|lass die fehler|fehler ignorieren|deixe os erros|não corrija os tipos|lascia gli errori|non correggere i tipi/i;
export const leaveErrors = (text: string): boolean => LEAVE.test(text);

const FILE_TOOLS = new Set(['write_file', 'edit_file']);
const FP_TOOLS = (name: string) => name === 'shell' || name.startsWith('git_');

export interface ChecksCard {
  workspace: string;
  project: string;
  checkers: { id: CheckerId; label: string; argv: string; runsProjectCode: boolean }[];
  /** No sandbox here (Windows): it runs directly on this computer. */
  direct: boolean;
  timeoutS: number;
}
export interface ChecksChip {
  state: 'clean' | 'left';
  checker: string;
  left: number;
  fixed: number;
  files: string[];
  lines: string[];
}

/** One turn's checks (§4.4): created by runTurn when checks may run; Stop wins through the turn's signal. */
export class TurnChecks {
  readonly #app: AppContext;
  readonly #conv: Conversation;
  readonly #ws: string;
  readonly #sandbox: AppContext['sandbox'];
  readonly #s: PreciseSettings['checks'];
  /** Touched files this step (workspace-relative). */
  #step = new Set<string>();
  readonly touched = new Set<string>();
  /** The baseline of each touched file (null: none to compare with), taken before her first change. */
  readonly #base = new Map<string, Diagnostic[] | null>();
  readonly #fp = new Map<string, Fingerprint>();
  readonly said = new Set<string>();
  /** The newest outcome per project and checker. */
  readonly latest = new Map<string, CheckOutcome>();
  #late: Promise<CheckOutcome[]> | undefined;
  #lateDone: CheckOutcome[] | undefined;
  readonly #queue = new Map<string, Promise<unknown>>();
  nudges = 0;
  maxMine = 0;
  ran = 0;
  readonly events: ChatEvent[] = [];
  readonly runs: { label: string; files: string[]; block: string; ms: number; errors: number }[] = [];

  constructor(app: AppContext, conv: Conversation, ws: string, sandbox: AppContext['sandbox']) {
    this.#app = app;
    this.#conv = conv;
    this.#ws = ws;
    this.#sandbox = sandbox;
    this.#s = preciseSettings(app).checks;
  }

  #rel(p: unknown): string | undefined {
    if (typeof p !== 'string' || !p.trim()) return undefined;
    try {
      const abs = resolveInside(this.#ws, p);
      return relative(this.#ws, abs).split(sep).join('/');
    } catch {
      return undefined;
    }
  }

  /** The project's state, or undefined when it has no checker this edit could use. */
  #projectFor(file: string): { project: ProjectRef; found: Checker[]; state: ProjectState } | undefined {
    const project = projectOf(this.#ws, file);
    if (!project) return undefined;
    const found = detectCheckers(project.dir).filter((c) => checksFile(c.id, file));
    if (!found.length) return undefined;
    return { project, found, state: checksDb(this.#app).choice(this.#conv.workspace, project.path).state };
  }

  /** Before a call runs: the file's baseline (first change in the turn) or the workspace fingerprint. */
  before(name: string, args: Record<string, unknown>): void {
    try {
      if (FILE_TOOLS.has(name)) {
        const f = this.#rel(args.path ?? args.file);
        if (!f || this.#base.has(f)) return;
        const p = this.#projectFor(f);
        if (!p || p.state !== 'on') return;
        const s = sha(join(this.#ws, f));
        let base: Diagnostic[] | null = null;
        for (const c of allowedCheckers(this.#app, this.#conv.workspace, p.project, p.found)) {
          const hit = checksDb(this.#app).cached(this.#conv.workspace, p.project.path, c.id, f);
          if (hit && hit.sha === s) base = [...(base ?? []), ...hit.diags];
          else if (!hit && s === 'missing') base = base ?? [];
        }
        this.#base.set(f, base);
      } else if (FP_TOOLS(name)) {
        for (const p of projectsOf(this.#ws)) if (checksDb(this.#app).choice(this.#conv.workspace, p.path).state === 'on') this.#fp.set(p.path, fingerprint(p.dir));
      }
    } catch {
      /* a check never breaks a write */
    }
  }

  /** After a call ran: what it changed. */
  after(name: string, args: Record<string, unknown>, status: string): void {
    if (status !== 'ok') return;
    try {
      if (FILE_TOOLS.has(name)) {
        const f = this.#rel(args.path ?? args.file);
        if (f) this.#step.add(f);
      } else if (FP_TOOLS(name)) {
        for (const [path, before] of this.#fp) {
          const p = projectsOf(this.#ws).find((x) => x.path === path);
          if (!p) continue;
          for (const c of fpChanges(before, fingerprint(p.dir)).changed) {
            const f = path === '.' ? c : `${path}/${c}`;
            if (Object.values(EXT).some((re) => re.test(f))) {
              if (!this.#base.has(f)) {
                const hit = allowedCheckers(this.#app, this.#conv.workspace, p).flatMap((k) => checksDb(this.#app).cached(this.#conv.workspace, p.path, k.id, f)?.diags ?? []);
                this.#base.set(f, before.all[c] ? hit : []);
              }
              this.#step.add(f);
            }
          }
        }
        this.#fp.clear();
      }
    } catch {
      /* a check never breaks a write */
    }
  }

  /**
   * After the step's last file-changing call (and on every later call while a late result waits):
   * the block to append to this result, or ''. Card events go to `events`.
   */
  async stepEnd(lastChange: boolean, signal: AbortSignal): Promise<string> {
    let text = '';
    // A late result from an earlier step rides on this result.
    if (this.#lateDone) {
      text += blockText(this.#lateDone, { shown: this.#s.shown, timeoutS: this.#s.timeoutS, said: this.said, warnings: this.#s.warnings, late: true });
      this.#lateDone = undefined;
    }
    if (!lastChange || !this.#step.size) return text;
    const files = [...this.#step];
    this.#step = new Set();
    for (const f of files) this.touched.add(f);
    // Group by project; card for projects still at Ask; at most 3 checker runs per step.
    const groups = new Map<string, { project: ProjectRef; files: string[]; checkers: Checker[] }>();
    for (const f of files) {
      const p = this.#projectFor(f);
      if (!p) continue;
      if (p.state === 'ask') {
        this.#card(p.project, detectCheckers(p.project.dir));
        continue;
      }
      if (p.state !== 'on') continue;
      const allowed = allowedCheckers(this.#app, this.#conv.workspace, p.project, detectCheckers(p.project.dir)).filter((c) => checksFile(c.id, f));
      if (!allowed.length) continue;
      const g = groups.get(p.project.path) ?? { project: p.project, files: [], checkers: [] };
      g.files.push(f);
      for (const c of allowed) if (!g.checkers.some((x) => x.id === c.id)) g.checkers.push(c);
      groups.set(p.project.path, g);
    }
    if (!groups.size) return text;
    const jobs: { project: ProjectRef; checker: Checker; files: string[] }[] = [];
    for (const g of groups.values()) for (const c of g.checkers) jobs.push({ project: g.project, checker: c, files: g.files.filter((f) => checksFile(c.id, f)) });
    const now = jobs.slice(0, 3);
    for (const j of jobs.slice(3)) for (const f of j.files) this.#step.add(f); // the rest wait for the next step
    const work = Promise.all(now.map((j) => this.#one(j.project, j.checker, j.files, signal)));
    const waited = await Promise.race([work.then((r) => ({ r })), new Promise<{ r?: undefined }>((res) => setTimeout(() => res({}), this.#s.waitS * 1000).unref?.())]);
    if (waited.r) {
      const b = blockText(waited.r, { shown: this.#s.shown, timeoutS: this.#s.timeoutS, said: this.said, warnings: this.#s.warnings });
      return [text, b].filter(Boolean).join('\n');
    }
    this.#late = work;
    void work.then((r) => {
      if (this.#late === work) {
        this.#late = undefined;
        this.#lateDone = r;
      }
    }).catch(() => undefined);
    const label = now.map((j) => j.checker.label.split(' ')[0]).join(', ');
    return [text, `[Still checking (${label}, ${this.#s.waitS} s so far): the result comes with your next step.]`].filter(Boolean).join('\n');
  }

  /** Before her final reply: a check still running is waited for once (≤ waitS). */
  async settle(): Promise<void> {
    if (!this.#late) return;
    const w = this.#late;
    await Promise.race([w, new Promise((r) => setTimeout(r, this.#s.waitS * 1000).unref?.())]).catch(() => undefined);
    if (this.#lateDone) this.#lateDone = undefined; // its outcome is in `latest` (the nudge and chip read it)
  }

  #card(project: ProjectRef, found: Checker[]): void {
    const d = checksDb(this.#app);
    const c = d.choice(this.#conv.workspace, project.path);
    const today = this.#app.now().toISOString().slice(0, 10);
    if (c.askedAt?.slice(0, 10) === today || this.said.has(`card:${project.path}`)) return;
    this.said.add(`card:${project.path}`);
    d.setChoice({ ...c, askedAt: this.#app.now().toISOString() });
    const card: ChecksCard = { workspace: this.#conv.workspace, project: project.path, checkers: found.filter((k) => k.installed).map((k) => ({ id: k.id, label: k.label, argv: k.argv.join(' '), runsProjectCode: k.runsProjectCode })), direct: this.#sandbox.mode === 'none', timeoutS: this.#s.timeoutS };
    if (!card.checkers.length) return;
    this.events.push({ type: 'checks_card', card });
  }

  async #one(project: ProjectRef, checker: Checker, files: string[], signal: AbortSignal): Promise<CheckOutcome> {
    // One check per project at a time: a second one waits for the running one.
    const key = `${this.#conv.workspace}|${project.path}`;
    const prev = projectQueue.get(key) ?? Promise.resolve();
    const mine = prev.catch(() => undefined).then(() => runChecker(this.#app, this.#ws, project, checker, checker.files === 'project' ? '*' : files, { signal, timeoutMs: this.#s.timeoutS * 1000, sandbox: { ...this.#sandbox, network: false } }));
    projectQueue.set(key, mine);
    this.#queue.set(key, mine);
    const run = await mine;
    if (projectQueue.get(key) === mine) projectQueue.delete(key);
    this.ran++;
    const lastFull = new Map<string, Diagnostic[]>();
    for (const row of checksDb(this.#app).cacheAll(this.#conv.workspace, project.path, checker.id)) lastFull.set(row.file, row.diags);
    const outcome = this.#compare(run, lastFull);
    if (run.state !== 'stopped') record(this.#app, this.#conv.workspace, this.#ws, run, [...this.touched], false);
    this.latest.set(`${project.path}|${checker.id}`, outcome);
    this.maxMine = Math.max(this.maxMine, this.mineLeft().length);
    return outcome;
  }

  #compare(run: CheckerRun, lastFull: Map<string, Diagnostic[]>): CheckOutcome {
    const errors = run.diags.filter((d) => d.severity === 'error');
    const warnings = run.diags.length - errors.length;
    const mine: Diagnostic[] = [];
    let before = 0;
    const beforeFiles = new Set<string>();
    const noBaseline: string[] = [];
    const others: Diagnostic[] = [];
    const broke: Diagnostic[] = [];
    const ofFile = new Map<string, Diagnostic[]>();
    for (const d of errors) ofFile.set(d.file, [...(ofFile.get(d.file) ?? []), d]);
    for (const f of this.touched) {
      const list = ofFile.get(f) ?? [];
      if (!checksFile(run.checker.id, f)) continue;
      const base = this.#base.get(f);
      if (base === undefined || base === null) {
        if (list.length) noBaseline.push(f);
        mine.push(...list);
        continue;
      }
      const keys = new Map<string, number>();
      for (const b of base.filter((x) => x.severity === 'error')) keys.set(diagKey(b), (keys.get(diagKey(b)) ?? 0) + 1);
      for (const d of list) {
        const k = diagKey(d);
        const n = keys.get(k) ?? 0;
        if (n > 0) {
          keys.set(k, n - 1);
          before++;
          beforeFiles.add(f);
        } else mine.push(d);
      }
    }
    for (const [f, list] of ofFile) {
      if (this.touched.has(f)) continue;
      others.push(...list);
      const prev = lastFull.get(f);
      if (prev) {
        const keys = new Set(prev.map(diagKey));
        broke.push(...list.filter((d) => !keys.has(diagKey(d))));
      }
    }
    return { run, mine: mine.map((d) => ({ ...d })), before, beforeFiles: [...beforeFiles], noBaseline, others, broke: broke.slice(0, 50), warnings };
  }

  /** Her own errors left now (provably new ones only: a file with no baseline doesn't count). */
  mineLeft(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const o of this.latest.values()) out.push(...o.mine.filter((d) => !o.noBaseline.includes(d.file)), ...o.broke);
    return out;
  }
  /** Every error written out as hers (for the chip). */
  shownLeft(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const o of this.latest.values()) out.push(...o.mine, ...o.broke);
    return out;
  }

  /** The nudge (§4.7): the app's note for one more step, or undefined. */
  nudge(o: { ownerText: string; ownerName: string; canStep: boolean; goalOrLoop: boolean; hasTools: boolean }): string | undefined {
    const left = this.mineLeft();
    if (!left.length || this.nudges >= this.#s.nudges || !o.canStep || o.goalOrLoop || !o.hasTools || leaveErrors(o.ownerText)) return undefined;
    this.nudges++;
    const by = [...new Set([...this.latest.values()].filter((x) => x.mine.length || x.broke.length).map((x) => x.run.checker.label.split(' ')[0]))].join(', ');
    return `[Note from the app, not from ${o.ownerName}: your edits left ${plural(left.length, 'error')} (${by}): ${left.slice(0, 5).map((d) => `${d.file}:${d.line}:${d.col} ${d.code ?? ''} ${cut(d.message, 160)}`.replace(/\s+/g, ' ')).join(' · ')}. Fix them if they're yours, or say plainly in your answer that they're left and why.]`;
  }

  /** The claim check's receipt (§4.11 types_clean): the turn's last check, errors left or clean. */
  receipts(): { name: string; status: 'ok' | 'error' | 'denied'; args: Record<string, unknown>; output: string }[] {
    if (!this.latest.size) return [];
    const left = this.shownLeft();
    return [{ name: 'diagnostics', status: left.length ? 'error' : 'ok', args: { files: [...this.touched] }, output: left.slice(0, 5).map(diagLine).join('\n') }];
  }

  /** The reply chip (§4.11), or undefined when no check ran. */
  chip(): ChecksChip | undefined {
    if (!this.latest.size) return undefined;
    const left = this.shownLeft();
    const label = [...new Set([...this.latest.values()].map((x) => x.run.checker.label.split(' ')[0]))].join(', ');
    if ([...this.latest.values()].every((x) => x.run.state === 'broken' || x.run.state === 'timeout' || x.run.state === 'refused' || x.run.state === 'stopped')) return undefined;
    return { state: left.length ? 'left' : 'clean', checker: label, left: left.length, fixed: Math.max(0, this.maxMine - this.mineLeft().length), files: [...new Set(left.map((d) => d.file))].slice(0, 5), lines: left.slice(0, 10).map(diagLine) };
  }
}
const projectQueue = new Map<string, Promise<unknown>>();

/** Who may have checks in this turn (§4.4 Not in). */
export function checksAllowed(app: AppContext, conv: Conversation, o: { replay?: boolean; external?: boolean; group?: boolean; tools: number }): boolean {
  if (o.replay || o.external || o.group || conv.partner || app.member || !o.tools) return false;
  return preciseSettings(app).checks.on;
}

/** The project-page view of one workspace (GET /api/workspaces/:ws/checks). */
export function workspaceChecks(app: AppContext, workspace: string, ws: string): { project: string; name: string; checkers: (Checker & { command: string })[]; state: ProjectState; allowed: CheckerId[]; runs: DiagRun[]; problems: number }[] {
  return projectsOf(ws).map((p) => {
    const found = detectCheckers(p.dir);
    const c = checksDb(app).choice(workspace, p.path);
    const runs = checksDb(app).runs(workspace, p.path, 30);
    const last = new Map<string, DiagRun>();
    for (const r of runs) if (!last.has(r.checker)) last.set(r.checker, r);
    return { project: p.path, name: p.path === '.' ? (ws.split(/[\\/]/).pop() ?? workspace) : p.path, checkers: found.map((k) => ({ ...k, command: k.argv.join(' ') })), state: c.state, allowed: c.checkers, runs: [...last.values()], problems: latestProblems(app, workspace, p.path).diags.length };
  });
}

/** PUT /api/workspaces/:ws/checks and the card's answers (§4.3, §4.16). */
export function setProjectChecks(app: AppContext, workspace: string, ws: string, body: { project?: unknown; state?: unknown; checkers?: unknown; confirm?: unknown }): { ok: true; choice: ProjectChoice } | { ok: false; status: number; error: string } {
  const project = projectsOf(ws).find((p) => p.path === String(body.project ?? '.'));
  if (!project) return { ok: false, status: 404, error: en('No such project in this workspace.') };
  const found = detectCheckers(project.dir);
  const d = checksDb(app);
  const cur = d.choice(workspace, project.path);
  const state = body.state === undefined ? cur.state : (['ask', 'on', 'off'] as const).find((s) => s === body.state);
  if (!state) return { ok: false, status: 400, error: en('Pick on, off or ask.') };
  let checkers = cur.checkers.length ? cur.checkers : found.filter((k) => k.installed).map((k) => k.id);
  if (Array.isArray(body.checkers)) checkers = body.checkers.map(String).filter((x): x is CheckerId => found.some((k) => k.id === x));
  if (state === 'on' && checkers.some((id) => found.find((k) => k.id === id)?.runsProjectCode) && body.confirm !== true) return { ok: false, status: 400, error: en('One of these runs code from your project. Confirm to switch it on.') };
  const choice: ProjectChoice = { ...cur, state, checkers, decidedAt: app.now().toISOString() };
  d.setChoice(choice);
  return { ok: true, choice };
}

/** Phase 120: statSync guard for a path that may be gone. */
export const isFileAt = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

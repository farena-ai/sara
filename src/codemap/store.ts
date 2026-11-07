// Phase 50: the code map of one workspace, in its own SQLite file under <data>/cache/codemap
// (it is rebuilt from the files, so backups leave it out). Files, symbols, imports and search
// chunks are kept per file; a scan compares each file's size and modification time with what was
// indexed and re-reads only files that changed (and only re-indexes them when their content hash
// changed). A scan runs in small steps with a time budget, so it never holds up the server for
// long; it carries on where it stopped at the next step.
import { createHash } from 'node:crypto';
import { isPlainFileInside, readInsideNoFollow, readTextInside } from './safe-read.ts';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cosine, type EmbedTarget, embedTexts } from '../embeddings.ts';
import { ftsQuery } from '../memory.ts';
import { chunkLines, extract, identWords, type Imp, type Lang, langOf } from './extract.ts';
import { IgnoreRules } from './ignore.ts';

export const MAX_FILE_BYTES = 1024 * 1024;
/** Most files a map takes (a workspace with more is mapped up to this many). */
export const MAX_FILES = 20_000;
/** Folders that are installed, built or cached rather than written. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'vendor', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '__pycache__', '.venv', 'venv', 'env', 'coverage', '.cache', '.gradle', '.idea', '.vs', 'obj', 'bower_components', '.terraform', '.tox', '.mypy_cache', '.pytest_cache']);
const VECTOR_BATCH = 32;
/** Meaning-search floor for code chunks (nomic-embed-text: related code ~0.5+, unrelated ~0.3-0.45). */
export const CHUNK_MIN_SCORE = 0.45;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  hash TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  parent TEXT
);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  spec TEXT NOT NULL,
  line INTEGER NOT NULL,
  names TEXT,
  resolved TEXT
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS imports_resolved ON imports(resolved);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  symbol TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;
// Word search: identifiers stay whole ("disclosure_text"), their parts are in "words".
/**
 * A statement whose run() result is never read: rowids come back as BigInt, so a value above
 * Number.MAX_SAFE_INTEGER (contentless FTS5 deletes on Node 26) cannot throw a RangeError.
 */
export function writeOnly<S extends { setReadBigInts(on: boolean): void }>(stmt: S): S {
  stmt.setReadBigInts(true);
  return stmt;
}

const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, symbol, text, words, content='', contentless_delete=1, tokenize="porter unicode61 tokenchars '_'")`;

export interface FileRow {
  id: number;
  path: string;
  lang: Lang;
  size: number;
  lines: number;
  symbols: number;
}

export interface SymbolRow {
  name: string;
  kind: string;
  path: string;
  line: number;
  end: number;
  signature: string;
  exported: boolean;
  parent: string | null;
}

export interface ImportRow {
  spec: string;
  line: number;
  names: string | null;
  resolved: string | null;
}

export interface TextHit {
  path: string;
  line: number;
  start: number;
  end: number;
  symbol: string | null;
  snippet: string;
  by: 'symbol' | 'words' | 'meaning' | 'both';
  score: number;
}

export interface RunReport {
  done: boolean;
  /** Files whose symbols and chunks were (re)written in this scan. */
  reindexed: string[];
  removed: string[];
  skippedBig: string[];
  skippedBinary: string[];
  ignored: number;
  ms: number;
}

interface Known {
  id: number;
  mtime: number;
  size: number;
  hash: string;
}

interface ScanState {
  stack: string[];
  seen: Set<string>;
  queue: { rel: string; size: number; mtime: number }[];
  known: Map<string, Known>;
  rules: Map<string, IgnoreRules>;
  report: RunReport;
  truncated: boolean;
  started: number;
}

type Row = Record<string, string | number | null>;

/** Words that say nothing about which code is meant ("which file calls …"). */
const QUERY_STOP = new Set(['where', 'which', 'what', 'when', 'who', 'how', 'does', 'did', 'the', 'are', 'is', 'file', 'files', 'code', 'function', 'functions', 'method', 'methods', 'class', 'find', 'show', 'used', 'use', 'uses', 'using', 'calls', 'call', 'called', 'thing', 'this', 'that', 'there', 'here', 'into', 'from', 'with', 'for', 'and', 'not', 'any', 'all', 'some', 'our', 'your', 'its', 'can', 'should', 'would', 'happens', 'happen', 'handled', 'handles', 'handle', 'done', 'work', 'works', 'part', 'logic', 'place', 'places']);

/** The search words of a question: lower case, 3+ letters, without the generic ones. */
export function queryTerms(query: string): string[] {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !QUERY_STOP.has(w));
  // Split identifiers too ("disclosureText" → disclosure, text).
  for (const id of query.match(/[A-Za-z][A-Za-z0-9]*[A-Z_][A-Za-z0-9_]*/g) ?? []) for (const p of identWords(id).split(' ')) if (p && !QUERY_STOP.has(p)) words.push(p);
  return [...new Set(words)].slice(0, 16);
}

/** "./src/x.ts", "src\\x.ts", "/workspace/src/x.ts" → "src/x.ts". */
export function normRel(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+workspace(\/|$)/, '')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

export class CodeMapStore {
  readonly root: string;
  readonly db: DatabaseSync;
  /**
   * Every write statement (issue #9): after an FTS5 write the connection's last insert rowid can be
   * above 2^53, and Node 26 then throws a RangeError from any later run(). BigInt results avoid it.
   */
  #write(sql: string) {
    return writeOnly(this.db.prepare(sql));
  }
  #scan: ScanState | undefined;
  #goModule: string | null | undefined;
  #vecCache: { model: string; rows: { id: number; vec: Float32Array }[] } | undefined;
  /** The last finished scan. */
  lastRun: RunReport | undefined;
  /** The last problem making vectors, cleared on success. */
  vectorError: string | undefined;

  constructor(root: string, dbPath: string) {
    this.root = root;
    if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.db.exec(FTS);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  get building(): boolean {
    return Boolean(this.#scan);
  }

  /** Has a full scan ever finished? */
  get ready(): boolean {
    return Boolean(this.#meta('scanned_at'));
  }

  #meta(k: string): string | undefined {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  }

  #setMeta(k: string, v: string): void {
    this.#write('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ---------- scanning ----------

  #begin(): ScanState {
    const known = new Map<string, Known>();
    for (const r of this.db.prepare('SELECT id, path, mtime, size, hash FROM files').all() as Row[]) known.set(String(r.path), { id: Number(r.id), mtime: Number(r.mtime), size: Number(r.size), hash: String(r.hash) });
    this.#goModule = undefined;
    return { stack: [''], seen: new Set(), queue: [], known, rules: new Map(), report: { done: false, reindexed: [], removed: [], skippedBig: [], skippedBinary: [], ignored: 0, ms: 0 }, truncated: false, started: Date.now() };
  }

  #ignored(st: ScanState, rel: string, isDir: boolean): boolean {
    const parts = rel.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const base = parts.slice(0, i).join('/');
      const rules = st.rules.get(base);
      const decision = rules?.decision(parts.slice(i).join('/'), isDir);
      if (decision !== undefined) return decision;
    }
    return false;
  }

  /** Lists one folder: changed files go in the queue, folders on the stack. */
  #walkDir(st: ScanState, dir: string): void {
    const abs = dir ? join(this.root, dir) : this.root;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        const rules = new IgnoreRules(readTextInside(this.root, join(abs, '.gitignore'), 1_000_000, 1_000_000));
        if (rules.size) st.rules.set(dir, rules);
      } catch {
        /* unreadable: no rules */
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      // Links are not followed (they could lead outside the workspace).
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        if (this.#ignored(st, rel, true)) {
          st.report.ignored++;
          continue;
        }
        st.stack.push(rel);
      } else if (e.isFile()) {
        if (!langOf(rel)) continue;
        if (this.#ignored(st, rel, false)) {
          st.report.ignored++;
          continue;
        }
        if (st.seen.size >= MAX_FILES) {
          st.truncated = true;
          continue;
        }
        let s: import('node:fs').Stats;
        try {
          s = lstatSync(join(abs, e.name));
        } catch {
          continue;
        }
        if (s.size > MAX_FILE_BYTES) {
          st.report.skippedBig.push(rel);
          continue;
        }
        st.seen.add(rel);
        const k = st.known.get(rel);
        if (!k || k.size !== s.size || Math.abs(k.mtime - s.mtimeMs) > 1) st.queue.push({ rel, size: s.size, mtime: s.mtimeMs });
      }
    }
  }

  /**
   * One step of keeping the map up to date, for at most about `budgetMs`. Returns the scan's
   * report; `done` is false when it stopped for time (call again to carry on).
   */
  refresh(budgetMs = 150): RunReport {
    const t0 = Date.now();
    const st = (this.#scan ??= this.#begin());
    let inTx = false;
    try {
      // At least one piece of work per step, then as many as fit in the budget.
      for (let first = true; first || Date.now() - t0 < budgetMs; first = false) {
        const next = st.queue.shift();
        if (next) {
          if (!inTx) {
            this.db.exec('BEGIN');
            inTx = true;
          }
          this.#indexFile(st, next.rel, next.size, next.mtime);
          continue;
        }
        const dir = st.stack.pop();
        if (dir === undefined) break;
        this.#walkDir(st, dir);
      }
      const finished = !st.queue.length && !st.stack.length;
      if (finished) {
        if (!inTx) {
          this.db.exec('BEGIN');
          inTx = true;
        }
        // Files that are gone (or newly ignored/too big) leave the map.
        for (const [path, k] of st.known) {
          if (st.seen.has(path)) continue;
          this.#dropFile(k.id);
          this.#write('DELETE FROM files WHERE id = ?').run(k.id);
          this.#write('UPDATE imports SET resolved = NULL WHERE resolved = ?').run(path);
          st.report.removed.push(path);
        }
        if (st.report.reindexed.length || st.report.removed.length || !this.ready) this.#resolveAll();
        this.#setMeta('scanned_at', new Date().toISOString());
        this.#setMeta('truncated', st.truncated ? '1' : '0');
      }
      if (inTx) this.db.exec('COMMIT');
      inTx = false;
      st.report.ms += Date.now() - t0;
      if (finished) {
        st.report.done = true;
        this.lastRun = st.report;
        this.#scan = undefined;
        if (st.report.reindexed.length || st.report.removed.length) this.#vecCache = undefined;
      }
      return { ...st.report };
    } catch (err) {
      if (inTx && this.db.isTransaction) this.db.exec('ROLLBACK');
      this.#scan = undefined;
      throw err;
    }
  }

  /** Runs refresh steps until the scan is done (tests, scripts, first-time builds off the server). */
  refreshAll(): RunReport {
    let r = this.refresh(1000);
    while (!r.done) r = this.refresh(1000);
    return r;
  }

  #dropFile(fileId: number): void {
    const ids = (this.db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId) as { id: number }[]).map((r) => r.id);
    const del = this.#write('DELETE FROM chunks_fts WHERE rowid = ?');
    const delVec = this.#write('DELETE FROM chunk_vectors WHERE chunk_id = ?');
    for (const id of ids) {
      del.run(id);
      delVec.run(id);
    }
    this.#write('DELETE FROM chunks WHERE file_id = ?').run(fileId);
    this.#write('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    this.#write('DELETE FROM imports WHERE file_id = ?').run(fileId);
  }

  #indexFile(st: ScanState, rel: string, size: number, mtime: number): void {
    let buf: Buffer;
    try {
      const b = readInsideNoFollow(this.root, join(this.root, rel), 2_000_000);
      if (!b) throw new Error('refused');
      buf = b;
    } catch {
      st.seen.delete(rel);
      return;
    }
    const k = st.known.get(rel);
    if (buf.subarray(0, 8000).includes(0)) {
      st.report.skippedBinary.push(rel);
      st.seen.delete(rel); // dropped from the map at the end of the scan
      return;
    }
    const hash = createHash('sha1').update(buf).digest('hex');
    if (k && k.hash === hash) {
      // Touched but not changed: only the size and time are updated.
      this.#write('UPDATE files SET size = ?, mtime = ? WHERE id = ?').run(size, mtime, k.id);
      return;
    }
    const lang = langOf(rel) ?? 'text';
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const ex = extract(lang, text);
    const now = new Date().toISOString();
    let fileId: number;
    if (k) {
      this.#dropFile(k.id);
      this.#write('UPDATE files SET lang = ?, size = ?, mtime = ?, hash = ?, lines = ?, indexed_at = ? WHERE id = ?').run(lang, size, mtime, hash, lines.length, now, k.id);
      fileId = k.id;
    } else {
      fileId = Number(this.#write('INSERT INTO files (path, lang, size, mtime, hash, lines, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rel, lang, size, mtime, hash, lines.length, now).lastInsertRowid);
    }
    st.known.set(rel, { id: fileId, mtime, size, hash });
    const putSym = this.#write('INSERT INTO symbols (file_id, name, kind, line, end_line, signature, exported, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of ex.symbols) putSym.run(fileId, s.name, s.kind, s.line, Math.max(s.line, s.end), s.signature, s.exported ? 1 : 0, s.parent ?? null);
    const putImp = this.#write('INSERT INTO imports (file_id, spec, line, names, resolved) VALUES (?, ?, ?, ?, ?)');
    for (const i of ex.imports) putImp.run(fileId, i.spec, i.line, i.names ?? null, this.#resolve(lang, i, rel));
    const putChunk = this.#write('INSERT INTO chunks (file_id, start_line, end_line, symbol, text) VALUES (?, ?, ?, ?, ?)');
    const putFts = this.#write('INSERT INTO chunks_fts (rowid, path, symbol, text, words) VALUES (?, ?, ?, ?, ?)');
    const pathWords = identWords(rel.replace(/[/.\-]/g, ' '));
    for (const c of chunkLines(lines.length, ex.symbols, lines)) {
      const body = lines.slice(c.start - 1, c.end).join('\n');
      if (!body.trim()) continue;
      const id = Number(putChunk.run(fileId, c.start, c.end, c.symbol, body).lastInsertRowid);
      putFts.run(id, rel.replace(/[/.\-_]/g, ' '), c.symbol ?? '', body, `${pathWords} ${identWords(`${c.symbol ?? ''} ${body}`)}`);
    }
    st.report.reindexed.push(rel);
  }

  // ---------- import resolution ----------

  #isFile(rel: string): boolean {
    if (!rel || rel.startsWith('..')) return false;
    try {
      return isPlainFileInside(this.root, join(this.root, rel));
    } catch {
      return false;
    }
  }

  #isDir(rel: string): boolean {
    try {
      return lstatSync(join(this.root, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  #first(cands: string[]): string | null {
    for (const c of cands) {
      const n = posix.normalize(c);
      if (!n.startsWith('..') && this.#isFile(n)) return n;
    }
    return null;
  }

  /** The workspace file (or Go package folder, ending in "/") an import points at, when it is here. */
  #resolve(lang: Lang, imp: Pick<Imp, 'spec'>, from: string): string | null {
    const spec = imp.spec;
    const dir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
    const at = (p: string) => (dir ? posix.join(dir, p) : posix.normalize(p));
    switch (lang) {
      case 'typescript':
      case 'javascript': {
        if (!spec.startsWith('.')) return null;
        const base = at(spec);
        const noJs = base.replace(/\.(m|c)?js$/, '');
        return this.#first([base, `${noJs}.ts`, `${noJs}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`]);
      }
      case 'python': {
        const dots = /^\.*/.exec(spec)![0].length;
        const rest = spec.slice(dots).replace(/\./g, '/');
        if (dots) {
          let base = dir;
          for (let i = 1; i < dots; i++) base = posix.dirname(base) === '.' ? '' : posix.dirname(base);
          const p = base ? (rest ? `${base}/${rest}` : base) : rest;
          return this.#first(rest ? [`${p}.py`, `${p}/__init__.py`] : [`${p}/__init__.py`]);
        }
        return this.#first([`${rest}.py`, `${rest}/__init__.py`, `src/${rest}.py`, `src/${rest}/__init__.py`, ...(dir ? [`${dir}/${rest}.py`] : [])]);
      }
      case 'rust': {
        if (spec.startsWith('mod:')) {
          const name = spec.slice(4);
          const stem = from.replace(/\.rs$/, '');
          const own = /(^|\/)(mod|lib|main)\.rs$/.test(from) ? dir : stem;
          return this.#first([at(`${name}.rs`), at(`${name}/mod.rs`), `${own}/${name}.rs`, `${own}/${name}/mod.rs`]);
        }
        const m = /^crate::(\w+)/.exec(spec);
        return m ? this.#first([`src/${m[1]}.rs`, `src/${m[1]}/mod.rs`]) : null;
      }
      case 'c':
      case 'cpp':
        if (spec.startsWith('<')) return null;
        return this.#first([at(spec), spec, `include/${spec}`, `src/${spec}`]);
      case 'go': {
        if (this.#goModule === undefined) {
          try {
            this.#goModule = /^module\s+(\S+)/m.exec(readTextInside(this.root, join(this.root, 'go.mod'), 200_000))?.[1] ?? null;
          } catch {
            this.#goModule = null;
          }
        }
        const mod = this.#goModule;
        if (!mod || !spec.startsWith(`${mod}/`)) return null;
        const p = spec.slice(mod.length + 1);
        return this.#isDir(p) ? `${p}/` : null;
      }
      case 'java':
      case 'kotlin': {
        if (spec.endsWith('.*')) return null;
        const p = spec.replace(/\./g, '/');
        const exts = lang === 'java' ? ['.java', '.kt'] : ['.kt', '.java'];
        return this.#first(['', 'src/main/java/', 'src/main/kotlin/', 'src/', 'app/src/main/java/', 'app/src/main/kotlin/', 'src/test/java/'].flatMap((r) => exts.map((e) => `${r}${p}${e}`)));
      }
      default:
        return null;
    }
  }

  /** Imports that pointed nowhere are tried again (their target may have been added since). */
  #resolveAll(): void {
    const rows = this.db.prepare('SELECT i.id, i.spec, f.path, f.lang FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved IS NULL LIMIT 50000').all() as Row[];
    const put = this.#write('UPDATE imports SET resolved = ? WHERE id = ?');
    for (const r of rows) {
      const spec = String(r.spec);
      // Packages from outside the workspace can't resolve: skip the disk checks for them.
      if ((r.lang === 'typescript' || r.lang === 'javascript') && !spec.startsWith('.')) continue;
      if ((r.lang === 'c' || r.lang === 'cpp') && spec.startsWith('<')) continue;
      const to = this.#resolve(r.lang as Lang, { spec }, String(r.path));
      if (to) put.run(to, Number(r.id));
    }
  }

  // ---------- reading the map ----------

  status(): { files: number; symbols: number; chunks: number; imports: number; langs: Record<string, number>; scannedAt: string | null; building: boolean; truncated: boolean } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    const langs: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY n DESC').all() as Row[]) langs[String(r.lang)] = Number(r.n);
    return { files: n('SELECT COUNT(*) AS n FROM files'), symbols: n('SELECT COUNT(*) AS n FROM symbols'), chunks: n('SELECT COUNT(*) AS n FROM chunks'), imports: n('SELECT COUNT(*) AS n FROM imports'), langs, scannedAt: this.#meta('scanned_at') ?? null, building: this.building, truncated: this.#meta('truncated') === '1' };
  }

  /** Every mapped file with its symbol count (for the folder tree). */
  files(): FileRow[] {
    return (this.db.prepare('SELECT f.id, f.path, f.lang, f.size, f.lines, (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id) AS symbols FROM files f ORDER BY f.path').all() as Row[]).map((r) => ({ id: Number(r.id), path: String(r.path), lang: r.lang as Lang, size: Number(r.size), lines: Number(r.lines), symbols: Number(r.symbols) }));
  }

  /** How many files import each file (most first). */
  importCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.db.prepare('SELECT resolved, COUNT(DISTINCT file_id) AS n FROM imports WHERE resolved IS NOT NULL GROUP BY resolved ORDER BY n DESC').all() as Row[]) out.set(String(r.resolved), Number(r.n));
    return out;
  }

  /** A path as the map knows it: exact, or the one file ending with it ("chat.ts" → "src/chat.ts"). */
  findPath(p: string): { path?: string; candidates: string[] } {
    const rel = normRel(p);
    if (!rel) return { candidates: [] };
    if (this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(rel)) return { path: rel, candidates: [rel] };
    const like = rel.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = (this.db.prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT 20").all(`%/${like}`) as { path: string }[]).map((r) => r.path);
    return rows.length === 1 ? { path: rows[0], candidates: rows } : { candidates: rows };
  }

  #symRow = (r: Row): SymbolRow => ({ name: String(r.name), kind: String(r.kind), path: String(r.path), line: Number(r.line), end: Number(r.end_line), signature: String(r.signature), exported: Boolean(r.exported), parent: (r.parent as string | null) ?? null });

  symbolsIn(path: string): SymbolRow[] {
    return (this.db.prepare('SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.line').all(path) as Row[]).map(this.#symRow);
  }

  /** What a file imports, and which files import it. */
  deps(path: string): { imports: ImportRow[]; importedBy: { path: string; line: number; names: string | null }[] } {
    const imports = (this.db.prepare('SELECT i.spec, i.line, i.names, i.resolved FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path = ? ORDER BY i.line').all(path) as Row[]).map((r) => ({ spec: String(r.spec), line: Number(r.line), names: (r.names as string | null) ?? null, resolved: (r.resolved as string | null) ?? null }));
    const dir = posix.dirname(path);
    const importedBy = (this.db.prepare('SELECT f.path, MIN(i.line) AS line, i.names FROM imports i JOIN files f ON f.id = i.file_id WHERE (i.resolved = ? OR i.resolved = ?) AND f.path != ? GROUP BY f.path ORDER BY f.path').all(path, `${dir}/`, path) as Row[]).map((r) => ({ path: String(r.path), line: Number(r.line), names: (r.names as string | null) ?? null }));
    return { imports, importedBy };
  }

  /** Symbols by name: exact first, then same name in another case, starts with, contains. */
  findSymbols(query: string, limit = 10, offset = 0): { hits: SymbolRow[]; total: number } {
    const q = query.trim().replace(/\(\)$/, '');
    if (!q) return { hits: [], total: 0 };
    const parts = q.split(/[\s.:#]+/).filter(Boolean);
    const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    let rows: Row[];
    let parent: string | undefined;
    let name = q;
    if (parts.length === 2 && /^[\w$]+$/.test(parts[0]) && /[.:#]/.test(q) && !/\s/.test(q)) {
      [parent, name] = parts;
      rows = this.db.prepare("SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name LIKE ? ESCAPE '\\' LIMIT 2000").all(`%${esc(name)}%`) as Row[];
    } else if (parts.length > 1) {
      const where = parts.map(() => "s.name LIKE ? ESCAPE '\\'").join(' AND ');
      rows = this.db.prepare(`SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE ${where} LIMIT 2000`).all(...parts.map((p) => `%${esc(p)}%`)) as Row[];
      name = parts.join('');
    } else rows = this.db.prepare("SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name LIKE ? ESCAPE '\\' LIMIT 2000").all(`%${esc(q)}%`) as Row[];
    const kindRank: Record<string, number> = { class: 0, interface: 0, struct: 0, trait: 0, function: 1, type: 1, enum: 1, object: 1, impl: 2, method: 2, constructor: 3, const: 3, var: 4, macro: 4, namespace: 4, mod: 4, heading: 6 };
    const lower = name.toLowerCase();
    const score = (s: SymbolRow) => {
      const n = s.name.toLowerCase();
      let sc = s.name === name ? 0 : n === lower ? 1 : n.startsWith(lower) ? 3 : 5;
      if (parent && s.parent?.toLowerCase() !== parent.toLowerCase()) sc += 4;
      sc += (kindRank[s.kind] ?? 5) * 0.3 + (s.exported ? 0 : 0.5) + (/(^|\/)(test|tests|__tests__|spec|fixtures?)\//.test(s.path) || /\.(test|spec)\.\w+$/.test(s.path) ? 0.8 : 0);
      return sc;
    };
    const all = rows.map(this.#symRow).map((s) => ({ s, sc: score(s) })).sort((a, b) => a.sc - b.sc || a.s.name.length - b.s.name.length || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line);
    return { hits: all.slice(offset, offset + limit).map((x) => x.s), total: all.length };
  }

  #chunk(id: number): { id: number; path: string; start: number; end: number; symbol: string | null; text: string } | undefined {
    const r = this.db.prepare('SELECT c.*, f.path FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?').get(id) as Row | undefined;
    return r ? { id: Number(r.id), path: String(r.path), start: Number(r.start_line), end: Number(r.end_line), symbol: (r.symbol as string | null) ?? null, text: String(r.text) } : undefined;
  }

  /** The line of a chunk that best matches the words (for file:line and the snippet). */
  #bestLine(c: { start: number; text: string; symbol: string | null }, query: string): { line: number; snippet: string } {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []).map((w) => w.slice(0, Math.max(3, Math.min(w.length, 5)))))];
    const lines = c.text.split('\n');
    let best = -1;
    let bestScore = 0;
    lines.forEach((l, i) => {
      const low = l.toLowerCase();
      const s = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best < 0) best = Math.max(0, lines.findIndex((l) => l.trim()));
    return { line: c.start + best, snippet: lines[best].trim().replace(/\s+/g, ' ').slice(0, 140) };
  }

  /**
   * Chunks with the words: FTS5 finds candidates (any of the words, by bm25), then chunks that have
   * more of the different words (in their text, path or symbol name) come first.
   */
  findWords(query: string, limit = 10, offset = 0): TextHit[] {
    const terms = queryTerms(query);
    const camel = query.match(/[\w$]{3,}/g)?.filter((w) => /[A-Z_]/.test(w.slice(1))) ?? [];
    const words = ftsQuery([...terms, ...camel].join(' '));
    if (!words) return [];
    let rows: Row[];
    try {
      rows = this.db.prepare('SELECT rowid AS id, bm25(chunks_fts, 3.0, 4.0, 1.0, 1.5) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 300').all(words) as Row[];
    } catch {
      return [];
    }
    const stems = [...new Set(terms.map((t) => t.slice(0, Math.min(t.length, 5))))];
    const scored = rows.flatMap((r, i) => {
      const c = this.#chunk(Number(r.id));
      if (!c) return [];
      const text = c.text.toLowerCase();
      const head = `${c.path} ${c.symbol ?? ''}`.toLowerCase();
      let have = 0;
      for (const t of stems) {
        if (head.includes(t)) have += 1.5;
        else if (text.includes(t)) have += 1;
      }
      // Tests and fixtures come after the code they test, when the words fit equally.
      const testy = /(^|\/)(test|tests|__tests__|spec|fixtures?)\//.test(c.path) || /\.(test|spec)\.\w+$/.test(c.path) ? 0.6 : 0;
      return [{ c, score: have - testy - i / 1000 }];
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(offset, offset + limit).map(({ c, score }) => {
      const b = this.#bestLine(c, query);
      return { path: c.path, line: b.line, start: c.start, end: c.end, symbol: c.symbol, snippet: b.snippet, by: 'words' as const, score };
    });
  }

  /** Makes vectors for up to a batch of chunks that don't have one for the current model. */
  async indexVectors(target: EmbedTarget | undefined, limit = VECTOR_BATCH, signal?: AbortSignal): Promise<number> {
    if (!target) return 0;
    const todo = this.db.prepare('SELECT c.id, c.symbol, c.text, f.path FROM chunks c JOIN files f ON f.id = c.file_id LEFT JOIN chunk_vectors v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL OR v.model != ? ORDER BY c.id LIMIT ?').all(target.model, limit) as Row[];
    if (!todo.length) return 0;
    try {
      const doc = (t: string) => (/nomic-embed/i.test(target.model) ? `search_document: ${t}` : t);
      const vecs = await embedTexts(target, todo.map((c) => doc(`${c.path}${c.symbol ? ` · ${c.symbol}` : ''}\n${String(c.text).slice(0, 3000)}`)), signal);
      const put = this.#write('INSERT INTO chunk_vectors (chunk_id, model, vec) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, vec = excluded.vec');
      // The chunks may have been re-indexed while the model was working: keep only those still here.
      const still = this.db.prepare('SELECT 1 FROM chunks WHERE id = ?');
      this.db.exec('BEGIN');
      todo.forEach((c, i) => {
        if (still.get(Number(c.id))) put.run(Number(c.id), target.model, new Uint8Array(vecs[i].buffer));
      });
      this.db.exec('COMMIT');
      this.#vecCache = undefined;
      this.vectorError = undefined;
      return todo.length;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.vectorError = (err as Error).message;
      throw err;
    }
  }

  vectorCount(model: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors WHERE model = ?').get(model) as { n: number }).n);
  }

  #vectors(model: string): { id: number; vec: Float32Array }[] {
    if (this.#vecCache?.model === model) return this.#vecCache.rows;
    const rows = (this.db.prepare('SELECT chunk_id, vec FROM chunk_vectors WHERE model = ?').all(model) as { chunk_id: number; vec: Uint8Array }[]).map((r) => ({ id: r.chunk_id, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
    this.#vecCache = { model, rows };
    return rows;
  }

  /** Chunks closest in meaning to the text, above the floor (empty when there are no vectors). */
  async findMeaningOnly(target: EmbedTarget | undefined, query: string, limit = 10, timeoutMs = 4000): Promise<TextHit[]> {
    if (!target || !query.trim()) return [];
    const rows = this.#vectors(target.model);
    if (!rows.length) return [];
    let q: Float32Array;
    try {
      const text = /nomic-embed/i.test(target.model) ? `search_query: ${query.slice(0, 2000)}` : query.slice(0, 2000);
      [q] = await embedTexts(target, [text], AbortSignal.timeout(timeoutMs));
    } catch (err) {
      this.vectorError = (err as Error).message;
      return [];
    }
    const scored = rows.map((r) => ({ id: r.id, score: cosine(q, r.vec) })).filter((r) => r.score >= CHUNK_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, limit);
    return scored.flatMap((s) => {
      const c = this.#chunk(s.id);
      if (!c) return [];
      const b = this.#bestLine(c, query);
      return [{ path: c.path, line: b.line, start: c.start, end: c.end, symbol: c.symbol, snippet: b.snippet, by: 'meaning' as const, score: s.score }];
    });
  }

  /** Words and meaning merged by reciprocal rank (a chunk found both ways comes first). */
  async findMeaning(target: EmbedTarget | undefined, query: string, limit = 10, offset = 0, timeoutMs = 4000): Promise<TextHit[]> {
    const want = limit + offset;
    const words = this.findWords(query, want * 2);
    const meaning = await this.findMeaningOnly(target, query, want * 2, timeoutMs);
    const merged = new Map<string, TextHit>();
    words.forEach((w, i) => merged.set(`${w.path}:${w.start}`, { ...w, score: 1 / (60 + i) }));
    meaning.forEach((m, i) => {
      const k = `${m.path}:${m.start}`;
      const had = merged.get(k);
      // Meaning counts a little more: it is what this search is for.
      if (had) merged.set(k, { ...had, score: had.score + 1.2 / (60 + i), by: 'both' });
      else merged.set(k, { ...m, score: 1.2 / (60 + i) });
    });
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(offset, offset + limit);
  }

  /**
   * Where a name is defined and used: definitions from the symbols, uses by a whole-word search over
   * the mapped files (the word index narrows it down first).
   */
  refs(name: string, limit = 30): { defs: SymbolRow[]; uses: { path: string; line: number; text: string }[]; total: number; files: number } {
    const n = name.trim().replace(/\(\)$/, '').split(/[.:#]+/).pop() ?? '';
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(n)) return { defs: [], uses: [], total: 0, files: 0 };
    const defs = (this.db.prepare('SELECT s.*, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY s.exported DESC, f.path, s.line').all(n) as Row[]).map(this.#symRow);
    const defAt = new Set(defs.map((d) => `${d.path}:${d.line}`));
    const token = n.replace(/\$/g, ' ').trim();
    let ids: number[] = [];
    try {
      ids = (this.db.prepare('SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5000').all(`text : "${token.replace(/"/g, '')}"`) as { id: number }[]).map((r) => Number(r.id));
    } catch {
      ids = [];
    }
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_$])${n.replace(/[$]/g, '\\$')}(?![\\p{L}\\p{N}_$])`, 'u');
    const uses: { path: string; line: number; text: string }[] = [];
    for (const id of ids) {
      const c = this.#chunk(id);
      if (!c) continue;
      c.text.split('\n').forEach((l, i) => {
        if (!re.test(l)) return;
        const line = c.start + i;
        if (defAt.has(`${c.path}:${line}`)) return;
        uses.push({ path: c.path, line, text: l.trim().replace(/\s+/g, ' ').slice(0, 140) });
      });
    }
    uses.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return { defs, uses: uses.slice(0, limit), total: uses.length, files: new Set(uses.map((u) => u.path)).size };
  }

  /** The text of some lines of a mapped file (from its chunks; for snippets in the Map view). */
  lines(path: string, from: number, to: number): string[] {
    const rows = this.db.prepare('SELECT c.start_line, c.text FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = ? AND c.end_line >= ? AND c.start_line <= ? ORDER BY c.start_line').all(path, from, to) as Row[];
    const out: string[] = [];
    for (const r of rows) {
      const ls = String(r.text).split('\n');
      ls.forEach((l, i) => {
        const n = Number(r.start_line) + i;
        if (n >= from && n <= to) out.push(l);
      });
    }
    return out;
  }

  /** The size of the map's database file (bytes), for reports. */
  dbBytes(): number {
    const p = this.db.location();
    if (!p || !existsSync(p)) return 0;
    let n = statSync(p).size;
    for (const ext of ['-wal', '-shm']) if (existsSync(p + ext)) n += statSync(p + ext).size;
    return n;
  }
}

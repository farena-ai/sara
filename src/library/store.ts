// Phase 44: her library. Documents the owner gives her are kept as they came (in <data>/library),
// read into passages that remember where they are ("page 4", "sheet Budget", "slide 3"), and found
// again by their words (SQLite FTS5, always) and by meaning (vectors, when the Meaning search job is
// set). A document is either kept in her library (searchable from any of the owner's chats) or
// "read once" for a single conversation (found only there, gone with that conversation).
import { assertNotHeld } from '../legal-hold.ts';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type EmbedTarget, embedTexts } from '../embeddings.ts';
import { ftsQuery } from '../memory.ts';
import type { Settings } from '../settings.ts';
import { exactScores, VectorIndex } from './vectors.ts';

const MB = 1024 * 1024;
/**
 * Largest file taken whole in memory: anything sent through a chat bridge, and every kind of
 * document except PDF (their readers need the whole file). PDFs are read page by page from disk,
 * so they may be as big as the owner's limit (Phase 74, default 1 GB).
 */
export const MAX_DOC_BYTES = 100 * MB;
/** Phase 74: the owner's choices for the largest document (MB). */
export const MAX_MB_CHOICES = [100, 250, 500, 1024, 2048] as const;
export const MEMBER_MAX_MB_CHOICES = [25, 50, 100, 250, 500, 1024] as const;
export const DEFAULT_MAX_MB = 1024;
export const DEFAULT_MEMBER_MAX_MB = 100;

/** Phase 74: the library settings the owner sets (members follow the owner's). */
export interface LibraryLimits {
  /** Largest document, in MB (PDFs; other kinds stay at MAX_DOC_BYTES). */
  maxMb: number;
  /** Largest document a household member may add, in MB. */
  memberMaxMb: number;
  /** Scanned pages: ask before a cloud picture model reads them, read them only on this computer, or don't read them. */
  ocr: 'ask' | 'local' | 'off';
  /** Background speed: 1 gentle (chat always first), 2 normal, 3 fast. */
  speed: 1 | 2 | 3;
}

export function libraryLimits(s: Pick<Settings, 'libraryLimits'>): LibraryLimits {
  const l = s.libraryLimits ?? {};
  const pick = <T extends number>(v: unknown, list: readonly T[], d: T): T => (list.includes(Number(v) as T) ? (Number(v) as T) : d);
  return {
    maxMb: pick(l.maxMb, MAX_MB_CHOICES, DEFAULT_MAX_MB),
    memberMaxMb: pick(l.memberMaxMb, MEMBER_MAX_MB_CHOICES, DEFAULT_MEMBER_MAX_MB),
    ocr: l.ocr === 'local' || l.ocr === 'off' ? l.ocr : 'ask',
    speed: l.speed === 1 || l.speed === 3 ? l.speed : 2,
  };
}

/** Cleans a library-settings change from the owner (unknown values are refused). */
export function cleanLibraryLimits(v: Record<string, unknown>, cur: LibraryLimits): LibraryLimits {
  const out = { ...cur };
  if (v.maxMb !== undefined) {
    if (!MAX_MB_CHOICES.includes(Number(v.maxMb) as (typeof MAX_MB_CHOICES)[number])) throw new Error('Pick one of the offered sizes.');
    out.maxMb = Number(v.maxMb);
  }
  if (v.memberMaxMb !== undefined) {
    if (!MEMBER_MAX_MB_CHOICES.includes(Number(v.memberMaxMb) as (typeof MEMBER_MAX_MB_CHOICES)[number])) throw new Error('Pick one of the offered sizes.');
    out.memberMaxMb = Number(v.memberMaxMb);
  }
  if (v.ocr !== undefined) {
    if (!['ask', 'local', 'off'].includes(String(v.ocr))) throw new Error('Pick one of the offered choices.');
    out.ocr = v.ocr as LibraryLimits['ocr'];
  }
  if (v.speed !== undefined) {
    if (![1, 2, 3].includes(Number(v.speed))) throw new Error('Pick one of the offered speeds.');
    out.speed = Number(v.speed) as LibraryLimits['speed'];
  }
  return out;
}

/** The SHA-256 of a file, read in pieces. */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}
/** About how long a passage is, and how much neighbouring passages overlap. */
export const PASSAGE_CHARS = 1400;
const OVERLAP_CHARS = 200;
/** Meaning-search floor for passages (nomic-embed-text: relevant ~0.55+, unrelated up to ~0.5). */
export const PASSAGE_MIN_SCORE = 0.52;
const VECTOR_BATCH = 32;

export type DocStatus = 'waiting' | 'reading' | 'ready' | 'failed';
export type LearnStatus = 'off' | 'waiting' | 'learning' | 'done' | 'failed';
export type DocOrigin = 'library' | 'chat' | 'telegram' | 'discord' | 'plugin' | 'room-archive';
/** Phase 110 (CH4): where a search looks: her library (the default), the room archives, or both. */
export type SearchIn = 'library' | 'archives' | 'all';

export interface LibraryDoc {
  id: number;
  name: string;
  kind: string | null;
  size: number;
  sha: string;
  title: string | null;
  status: DocStatus;
  error: string | null;
  warnings: string[];
  /** Kept in her library (true) or read once for one conversation (false). */
  keep: boolean;
  conversationId: string | null;
  origin: DocOrigin;
  passages: number;
  chars: number;
  /** Pages read by the picture model (scanned pages, photos of pages). */
  pagesSeen: number;
  learn: LearnStatus;
  learnError: string | null;
  facts: number;
  /** One line on what it is ("A 12-month lease for 14 Elm St, from March 2026"), written while learning. */
  summary: string | null;
  /** Phase 74: a summary of the whole document (long documents, from its section summaries). */
  overview: string | null;
  /** Phase 74: pages, for paged documents (PDFs). */
  pages: number;
  addedAt: string;
  readAt: string | null;
  /** Phase 110 (CH4): the collection it belongs to ('Archive: #general · My Server'), or null. */
  collection: string | null;
  /** Phase 110: a read-only document (a room archive): no rename, no edits, never learned. */
  readOnly: boolean;
  /** Phase 110: the room it belongs to (Forget this room deletes it). */
  roomId: number | null;
  /** Phase 110: the ISO week of a room archive ('2026-W44'). */
  period: string | null;
}

export interface Passage {
  id: number;
  docId: number;
  ord: number;
  /** Where in the document: "page 4", "sheet Budget", "slide 3", "chapter 2", or "". */
  place: string;
  /** Phase 74: the page number, for paged documents (else null). */
  page: number | null;
  heading: string | null;
  text: string;
}

export interface PassageHit {
  passage: Passage;
  doc: LibraryDoc;
  /** Higher is better; word hits and meaning hits are merged by rank. */
  score: number;
  by: 'words' | 'meaning' | 'both';
}

/** A piece of a read document, as the readers return it. */
export interface PartIn {
  text: string;
  where: string;
  heading?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT,
  size INTEGER NOT NULL,
  sha TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  title TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  keep INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  origin TEXT NOT NULL DEFAULT 'library',
  passages INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  pages_seen INTEGER NOT NULL DEFAULT 0,
  learn TEXT NOT NULL DEFAULT 'off',
  learn_error TEXT,
  facts INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  added_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS library_docs_conv ON library_docs(conversation_id);
CREATE TABLE IF NOT EXISTS library_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  heading TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_passages_doc ON library_passages(doc_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(text, heading, content='library_passages', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS library_passages_ai AFTER INSERT ON library_passages BEGIN
  INSERT INTO library_fts(rowid, text, heading) VALUES (new.id, new.text, coalesce(new.heading, ''));
END;
CREATE TRIGGER IF NOT EXISTS library_passages_ad AFTER DELETE ON library_passages BEGIN
  INSERT INTO library_fts(library_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, coalesce(old.heading, ''));
END;
CREATE TABLE IF NOT EXISTS library_vectors (
  passage_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS library_jobs (
  doc_id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  needs TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  page INTEGER NOT NULL DEFAULT 0,
  body_size REAL NOT NULL DEFAULT 0,
  heading TEXT,
  ocr_total INTEGER NOT NULL DEFAULT 0,
  ocr_done INTEGER NOT NULL DEFAULT 0,
  ocr_ok INTEGER NOT NULL DEFAULT 0,
  steps_total INTEGER NOT NULL DEFAULT 0,
  steps_done INTEGER NOT NULL DEFAULT 0,
  sec_page REAL NOT NULL DEFAULT 0,
  sec_ocr REAL NOT NULL DEFAULT 0,
  sec_step REAL NOT NULL DEFAULT 0,
  learn_done INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  timings TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS library_ocr (
  doc_id INTEGER NOT NULL,
  page INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  PRIMARY KEY (doc_id, page)
);
CREATE TABLE IF NOT EXISTS library_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  page_end INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'heading',
  summary TEXT
);
CREATE INDEX IF NOT EXISTS library_sections_doc ON library_sections(doc_id, ord);
`;

/** Phase 74: columns added to older libraries. */
const MIGRATIONS: [string, string, string][] = [
  ['library_passages', 'page', 'ALTER TABLE library_passages ADD COLUMN page INTEGER'],
  ['library_docs', 'overview', 'ALTER TABLE library_docs ADD COLUMN overview TEXT'],
  ['library_docs', 'pages', 'ALTER TABLE library_docs ADD COLUMN pages INTEGER NOT NULL DEFAULT 0'],
  // Phase 110 (CH4, docs/design/CHATS.md §7.9): collections and read-only room archives.
  ['library_docs', 'collection', 'ALTER TABLE library_docs ADD COLUMN collection TEXT'],
  ['library_docs', 'read_only', 'ALTER TABLE library_docs ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0'],
  ['library_docs', 'room_id', 'ALTER TABLE library_docs ADD COLUMN room_id INTEGER'],
  ['library_docs', 'period', 'ALTER TABLE library_docs ADD COLUMN period TEXT'],
];

/** SQL for "this document is a room archive" (alias d). */
const ARCHIVE_SQL = "(coalesce(d.read_only, 0) = 1 OR d.origin = 'room-archive')";

export type JobPhase = 'text' | 'ocr' | 'structure' | 'summaries' | 'learn' | 'vectors' | 'done' | 'cancelled';
/** Phase 74: a long document's reading job, kept in the database so a restart goes on where it was. */
export interface LibraryJob {
  docId: number;
  phase: JobPhase;
  paused: boolean;
  /** Waiting for the owner: 'ocr-approval' (a cloud picture model would read scanned pages) or 'local-ocr' (private mode is on and the picture model isn't local). */
  needs: 'ocr-approval' | 'local-ocr' | null;
  pages: number;
  /** Pages read so far in the text phase. */
  page: number;
  bodySize: number;
  heading: string | null;
  ocrTotal: number;
  ocrDone: number;
  /** The owner allowed a cloud picture model for this document's scanned pages. */
  ocrOk: boolean;
  /** Model calls planned and done in the later phases (summaries, key points). */
  stepsTotal: number;
  stepsDone: number;
  secPage: number;
  secOcr: number;
  secStep: number;
  /** Windows of key points already learned (so a pause or restart goes on from the next one). */
  learnDone: number;
  warnings: string[];
  /** Milliseconds spent per phase (shown in the measurements). */
  timings: Record<string, number>;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface Section {
  id: number;
  docId: number;
  ord: number;
  level: number;
  title: string;
  page: number;
  pageEnd: number;
  source: 'outline' | 'heading';
  summary: string | null;
}

const toJob = (r: Row): LibraryJob => {
  const j = (v: unknown, d: unknown) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return d;
    }
  };
  return {
    docId: Number(r.doc_id),
    phase: r.phase as JobPhase,
    paused: Boolean(r.paused),
    needs: (r.needs as LibraryJob['needs']) ?? null,
    pages: Number(r.pages),
    page: Number(r.page),
    bodySize: Number(r.body_size),
    heading: (r.heading as string | null) ?? null,
    ocrTotal: Number(r.ocr_total),
    ocrDone: Number(r.ocr_done),
    ocrOk: Boolean(r.ocr_ok),
    stepsTotal: Number(r.steps_total),
    stepsDone: Number(r.steps_done),
    secPage: Number(r.sec_page),
    secOcr: Number(r.sec_ocr),
    secStep: Number(r.sec_step),
    learnDone: Number(r.learn_done ?? 0),
    warnings: j(r.warnings, []) as string[],
    timings: j(r.timings, {}) as Record<string, number>,
    startedAt: String(r.started_at),
    updatedAt: String(r.updated_at),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
};

const JOB_COLS: Record<string, string> = { phase: 'phase', paused: 'paused', needs: 'needs', pages: 'pages', page: 'page', bodySize: 'body_size', heading: 'heading', ocrTotal: 'ocr_total', ocrDone: 'ocr_done', ocrOk: 'ocr_ok', stepsTotal: 'steps_total', stepsDone: 'steps_done', secPage: 'sec_page', secOcr: 'sec_ocr', secStep: 'sec_step', learnDone: 'learn_done', warnings: 'warnings', timings: 'timings', finishedAt: 'finished_at' };

const toSection = (r: Row): Section => ({ id: Number(r.id), docId: Number(r.doc_id), ord: Number(r.ord), level: Number(r.level), title: String(r.title), page: Number(r.page), pageEnd: Number(r.page_end), source: r.source === 'outline' ? 'outline' : 'heading', summary: (r.summary as string | null) ?? null });

type Row = Record<string, string | number | null>;

function toDoc(r: Row): LibraryDoc {
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(String(r.warnings ?? '[]')) as string[];
  } catch {
    /* old row */
  }
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: (r.kind as string | null) ?? null,
    size: Number(r.size),
    sha: String(r.sha),
    title: (r.title as string | null) ?? null,
    status: r.status as DocStatus,
    error: (r.error as string | null) ?? null,
    warnings,
    keep: Boolean(r.keep),
    conversationId: (r.conversation_id as string | null) ?? null,
    origin: r.origin as DocOrigin,
    passages: Number(r.passages),
    chars: Number(r.chars),
    pagesSeen: Number(r.pages_seen),
    learn: r.learn as LearnStatus,
    learnError: (r.learn_error as string | null) ?? null,
    facts: Number(r.facts),
    summary: (r.summary as string | null) ?? null,
    overview: (r.overview as string | null) ?? null,
    pages: Number(r.pages ?? 0),
    addedAt: String(r.added_at),
    readAt: (r.read_at as string | null) ?? null,
    collection: (r.collection as string | null) ?? null,
    readOnly: Number(r.read_only ?? 0) === 1,
    roomId: r.room_id === null || r.room_id === undefined ? null : Number(r.room_id),
    period: (r.period as string | null) ?? null,
  };
}

const toPassage = (r: Row): Passage => ({ id: Number(r.id), docId: Number(r.doc_id), ord: Number(r.ord), place: String(r.place ?? ''), page: r.page === null || r.page === undefined ? null : Number(r.page), heading: (r.heading as string | null) ?? null, text: String(r.text) });

/** A file name that is safe to show and store (no folders, no control characters). */
export function cleanName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const s = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
  return s || 'document';
}

/** The file's extension in lower case (letters and digits only), for storing the original. */
function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * Splits read parts into passages of about PASSAGE_CHARS, on paragraph (then sentence) boundaries,
 * never across a page/sheet/slide; neighbouring passages in the same place overlap a little so a
 * fact on the boundary is found from either side.
 */
export function toPassages(parts: PartIn[], size = PASSAGE_CHARS, overlap = OVERLAP_CHARS): { place: string; heading: string | null; text: string }[] {
  const out: { place: string; heading: string | null; text: string }[] = [];
  for (const part of parts) {
    const place = String(part.where ?? '').slice(0, 80);
    let heading: string | null = part.heading?.trim().slice(0, 200) || null;
    const paras = String(part.text ?? '')
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);
    let cur = '';
    let curHeading = heading;
    // Has the passage got text of its own (not only the overlap carried from the one before)?
    let fresh = false;
    const flush = (carry: boolean) => {
      const t = cur.trim();
      if (t && fresh) out.push({ place, heading: curHeading, text: t });
      cur = carry && overlap > 0 && t.length > overlap ? `${t.slice(-overlap).replace(/^\S*\s/, '')}\n\n` : '';
      fresh = false;
      curHeading = heading;
    };
    for (const para of paras) {
      // A Markdown-style heading line starts a new section (no overlap across sections).
      const h = /^#{1,6}\s+(.{1,200})$/.exec(para);
      if (h) {
        flush(false);
        heading = h[1].trim();
        curHeading = heading;
        cur = `${para}\n\n`;
        continue;
      }
      for (const piece of splitLong(para, size)) {
        if (fresh && cur.length + piece.length > size) flush(true);
        cur += `${piece}\n\n`;
        fresh = true;
      }
    }
    flush(false);
  }
  return out;
}

/** One very long paragraph (a table, a page with no blank lines) becomes sentence-sized pieces. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (cut < size * 0.5) cut = window.lastIndexOf(' ');
    if (cut < size * 0.3) cut = size - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export class LibraryStore {
  readonly db: DatabaseSync;
  readonly dir: string;
  readonly #now: () => Date;
  #index: VectorIndex | undefined;
  /** The last problem making passage vectors (shown on the Library page), cleared on success. */
  vectorError: string | undefined;

  constructor(db: DatabaseSync, dataDir: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.dir = join(dataDir, 'library');
    this.#now = now;
    db.exec(SCHEMA);
    for (const [table, col, sql] of MIGRATIONS) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes(col)) db.exec(sql);
    }
    db.exec('CREATE INDEX IF NOT EXISTS library_passages_page ON library_passages(doc_id, page)');
  }

  /** Where a document's original is kept. */
  #path(sha: string, ext: string): string {
    return join(this.dir, `${sha.slice(0, 40)}.${ext}`);
  }

  /** The original file's path on disk (big documents are read from there, piece by piece). */
  filePath(doc: LibraryDoc): string | undefined {
    const ext = (this.db.prepare('SELECT ext FROM library_docs WHERE id = ?').get(doc.id) as { ext: string } | undefined)?.ext ?? 'bin';
    const path = this.#path(doc.sha, ext);
    return existsSync(path) ? path : undefined;
  }

  /**
   * Phase 74: takes a file already on disk (an upload streamed to a temporary file): moves it into
   * the library folder and lists it as waiting to be read. Never reads it into memory.
   */
  addFile(f: { name: string; path: string; sha: string; keep: boolean; conversationId?: string | null; origin?: DocOrigin; learn?: boolean }): LibraryDoc {
    const size = statSync(f.path).size;
    if (!size) throw new Error('That file is empty.');
    const name = cleanName(f.name);
    const ext = extOf(name);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#path(f.sha, ext);
    if (existsSync(file)) rmSync(f.path, { force: true });
    else {
      try {
        renameSync(f.path, file);
      } catch {
        copyFileSync(f.path, file);
        rmSync(f.path, { force: true });
      }
    }
    const r = this.db
      .prepare('INSERT INTO library_docs (name, size, sha, ext, keep, conversation_id, origin, learn, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, size, f.sha, ext, f.keep ? 1 : 0, f.conversationId ?? null, f.origin ?? (f.keep ? 'library' : 'chat'), f.keep && f.learn !== false ? 'waiting' : 'off', this.#now().toISOString());
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** The first bytes of the original file (what kind it is), without reading the rest. */
  head(doc: LibraryDoc, n = 1024): Buffer | undefined {
    const path = this.filePath(doc);
    if (!path) return undefined;
    const fd = openSync(path, 'r');
    try {
      const b = Buffer.alloc(n);
      const got = readSync(fd, b, 0, n, 0);
      return b.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  }

  /** The same file (by its hash) already kept in her library, if any. */
  findKeptSha(sha: string): LibraryDoc | undefined {
    const r = this.db.prepare("SELECT * FROM library_docs WHERE sha = ? AND keep = 1 AND status != 'failed' ORDER BY id LIMIT 1").get(sha) as Row | undefined;
    return r ? toDoc(r) : undefined;
  }

  // ---------------------------------------------------------------- Phase 74: reading jobs

  job(docId: number): LibraryJob | undefined {
    const r = this.db.prepare('SELECT * FROM library_jobs WHERE doc_id = ?').get(docId) as Row | undefined;
    return r ? toJob(r) : undefined;
  }

  /** Jobs still to run (not paused, not waiting for the owner), oldest first. */
  activeJobs(): LibraryJob[] {
    return (this.db.prepare("SELECT * FROM library_jobs WHERE phase NOT IN ('done', 'cancelled') ORDER BY doc_id").all() as Row[]).map(toJob);
  }

  /** Starts (or restarts) a document's reading job from the first page. */
  startJob(docId: number, phase: JobPhase = 'text'): LibraryJob {
    const now = this.#now().toISOString();
    this.db.exec('BEGIN');
    try {
      this.#dropPassages(docId);
      this.db.prepare('DELETE FROM library_ocr WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM library_sections WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM library_jobs WHERE doc_id = ?').run(docId);
      this.db.prepare('INSERT INTO library_jobs (doc_id, phase, started_at, updated_at) VALUES (?, ?, ?, ?)').run(docId, phase, now, now);
      this.db.prepare("UPDATE library_docs SET status = 'reading', error = NULL, passages = 0, chars = 0, pages_seen = 0, overview = NULL WHERE id = ?").run(docId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.#index = undefined;
    return this.job(docId)!;
  }

  /** A job for a document that was read the ordinary way (structure and summaries for a long one). */
  startLaterJob(docId: number, phase: JobPhase): LibraryJob {
    const now = this.#now().toISOString();
    this.db.prepare('DELETE FROM library_sections WHERE doc_id = ?').run(docId);
    this.db.prepare('INSERT INTO library_jobs (doc_id, phase, started_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET phase = excluded.phase, paused = 0, needs = NULL, steps_total = 0, steps_done = 0, finished_at = NULL, updated_at = excluded.updated_at').run(docId, phase, now, now);
    return this.job(docId)!;
  }

  updateJob(docId: number, patch: Partial<Omit<LibraryJob, 'docId' | 'startedAt' | 'updatedAt'>>): LibraryJob | undefined {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = JOB_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : (v as string | number | null));
    }
    sets.push('updated_at = ?');
    args.push(this.#now().toISOString());
    this.db.prepare(`UPDATE library_jobs SET ${sets.join(', ')} WHERE doc_id = ?`).run(...args, docId);
    return this.job(docId);
  }

  /** Adds a time to a phase's total (for the measurements). */
  addTiming(docId: number, phase: string, ms: number): void {
    const j = this.job(docId);
    if (!j) return;
    j.timings[phase] = Math.round((j.timings[phase] ?? 0) + ms);
    this.updateJob(docId, { timings: j.timings });
  }

  /**
   * Stores one page's text as passages (in its own transaction, together with the job's progress,
   * so a restart never finds half a page). Headings found on the page are returned for the contents.
   */
  addPage(docId: number, page: number, text: string, opts: { heading?: string | null; jobPage?: number; ocr?: boolean } = {}): { passages: number; chars: number; heading: string | null; headings: { level: number; title: string }[] } {
    const headings: { level: number; title: string }[] = [];
    for (const m of text.matchAll(/^(#{1,6})\s+(.{1,200})$/gm)) headings.push({ level: m[1].length, title: m[2].trim() });
    const ps = toPassages([{ text, where: `page ${page}`, heading: opts.heading ?? undefined }]);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM library_vectors WHERE passage_id IN (SELECT id FROM library_passages WHERE doc_id = ? AND page = ?)').run(docId, page);
      this.db.prepare('DELETE FROM library_passages WHERE doc_id = ? AND page = ?').run(docId, page);
      const put = this.db.prepare('INSERT INTO library_passages (doc_id, ord, place, heading, text, page) VALUES (?, ?, ?, ?, ?, ?)');
      ps.forEach((p, i) => put.run(docId, page * 1000 + i, p.place, p.heading, p.text, page));
      if (opts.jobPage !== undefined) this.db.prepare('UPDATE library_jobs SET page = ?, heading = ?, updated_at = ? WHERE doc_id = ?').run(opts.jobPage, headings.at(-1)?.title ?? opts.heading ?? null, this.#now().toISOString(), docId);
      if (opts.ocr) this.db.prepare("UPDATE library_ocr SET status = 'done' WHERE doc_id = ? AND page = ?").run(docId, page);
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return { passages: ps.length, chars: text.length, heading: headings.at(-1)?.title ?? opts.heading ?? null, headings };
  }

  /** Drops what was stored for pages from `page` on (a restart mid-way goes on cleanly). */
  dropPagesFrom(docId: number, page: number): void {
    this.db.prepare('DELETE FROM library_vectors WHERE passage_id IN (SELECT id FROM library_passages WHERE doc_id = ? AND page >= ?)').run(docId, page);
    this.db.prepare('DELETE FROM library_passages WHERE doc_id = ? AND page >= ?').run(docId, page);
    this.db.prepare("DELETE FROM library_sections WHERE doc_id = ? AND source = 'heading' AND page >= ?").run(docId, page);
    this.db.prepare('DELETE FROM library_ocr WHERE doc_id = ? AND page >= ?').run(docId, page);
  }

  /** Marks a page as a scan for the picture model. */
  addOcrPage(docId: number, page: number): void {
    this.db.prepare("INSERT INTO library_ocr (doc_id, page, status) VALUES (?, ?, 'waiting') ON CONFLICT(doc_id, page) DO NOTHING").run(docId, page);
  }

  ocrPages(docId: number, status = 'waiting'): number[] {
    return (this.db.prepare('SELECT page FROM library_ocr WHERE doc_id = ? AND status = ? ORDER BY page').all(docId, status) as { page: number }[]).map((r) => r.page);
  }

  ocrCounts(docId: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM library_ocr WHERE doc_id = ? GROUP BY status').all(docId) as { status: string; n: number }[]) out[r.status] = r.n;
    return out;
  }

  setOcrStatus(docId: number, page: number | null, status: 'waiting' | 'done' | 'failed' | 'skipped'): void {
    if (page === null) this.db.prepare("UPDATE library_ocr SET status = ? WHERE doc_id = ? AND status = 'waiting'").run(status, docId);
    else this.db.prepare('UPDATE library_ocr SET status = ? WHERE doc_id = ? AND page = ?').run(status, docId, page);
  }

  /** The text has been read (all pages, scans too): counts come from what was stored. */
  finishPages(docId: number, r: { title?: string | null; kind: string; warnings: string[]; pagesSeen: number; pages: number }): LibraryDoc | undefined {
    const c = this.db.prepare('SELECT COUNT(*) AS n, coalesce(SUM(length(text)), 0) AS chars FROM library_passages WHERE doc_id = ?').get(docId) as { n: number; chars: number };
    this.db
      .prepare("UPDATE library_docs SET status = 'ready', error = NULL, kind = ?, title = coalesce(?, title), warnings = ?, passages = ?, chars = ?, pages_seen = ?, pages = ?, read_at = ? WHERE id = ?")
      .run(r.kind, r.title?.trim().slice(0, 300) || null, JSON.stringify(r.warnings.slice(0, 30)), Number(c.n), Number(c.chars), r.pagesSeen, r.pages, this.#now().toISOString(), docId);
    this.#index = undefined;
    return this.get(docId);
  }

  // ---------------------------------------------------------------- Phase 74: structure

  sections(docId: number): Section[] {
    return (this.db.prepare('SELECT * FROM library_sections WHERE doc_id = ? ORDER BY ord').all(docId) as Row[]).map(toSection);
  }

  addHeadingSections(docId: number, page: number, headings: { level: number; title: string }[]): void {
    if (!headings.length) return;
    const ord = (this.db.prepare('SELECT coalesce(MAX(ord), -1) + 1 AS n FROM library_sections WHERE doc_id = ?').get(docId) as { n: number }).n;
    const put = this.db.prepare("INSERT INTO library_sections (doc_id, ord, level, title, page, source) VALUES (?, ?, ?, ?, ?, 'heading')");
    headings.forEach((h, i) => put.run(docId, ord + i, h.level, h.title.slice(0, 200), page));
  }

  /** Replaces the contents (sections with their page ranges). */
  setSections(docId: number, rows: { level: number; title: string; page: number; pageEnd: number; source: 'outline' | 'heading' }[]): Section[] {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM library_sections WHERE doc_id = ?').run(docId);
      const put = this.db.prepare('INSERT INTO library_sections (doc_id, ord, level, title, page, page_end, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
      rows.forEach((r, i) => put.run(docId, i, r.level, r.title.slice(0, 200), r.page, r.pageEnd, r.source));
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return this.sections(docId);
  }

  setSectionSummary(id: number, summary: string): void {
    this.db.prepare('UPDATE library_sections SET summary = ? WHERE id = ?').run(summary.trim().slice(0, 1200) || null, id);
  }

  setOverview(docId: number, overview: string | null, about?: string | null): void {
    this.db.prepare('UPDATE library_docs SET overview = ?, summary = coalesce(?, summary) WHERE id = ?').run(overview?.trim().slice(0, 4000) || null, about?.trim().slice(0, 300) || null, docId);
  }

  /** The text of a page range (for summaries), with page markers, up to maxChars. */
  pagesText(docId: number, from: number, to: number, maxChars = 200_000): string {
    let out = '';
    let last = -1;
    for (const p of this.db.prepare('SELECT page, text FROM library_passages WHERE doc_id = ? AND page >= ? AND page <= ? ORDER BY ord').iterate(docId, from, to) as Iterable<{ page: number; text: string }>) {
      out += (out ? '\n\n' : '') + (p.page !== last ? `[page ${p.page}]\n` : '') + p.text;
      last = p.page;
      if (out.length >= maxChars) return out.slice(0, maxChars);
    }
    return out;
  }

  /** Phase 74: the page a quote from a paged document is on (key points cite their page). */
  pageOf(docId: number, quote: string | null): number | undefined {
    if (!quote) return undefined;
    const doc = this.get(docId);
    if (!doc?.pages) return undefined;
    const want = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const h of this.searchWords(quote, { docIds: [docId], limit: 5 })) {
      if (h.passage.page && h.passage.text.toLowerCase().replace(/\s+/g, ' ').includes(want)) return h.passage.page;
    }
    return undefined;
  }

  /** The passages of one page (for reading a document from a page, and for citations). */
  passagesAt(docId: number, page: number, limit = 20): Passage[] {
    return (this.db.prepare('SELECT * FROM library_passages WHERE doc_id = ? AND page >= ? ORDER BY ord LIMIT ?').all(docId, page, limit) as Row[]).map(toPassage);
  }

  /** Saves the original file and lists it as waiting to be read. */
  add(f: { name: string; bytes: Buffer; keep: boolean; conversationId?: string | null; origin?: DocOrigin; learn?: boolean }): LibraryDoc {
    if (!f.bytes.length) throw new Error('That file is empty.');
    if (f.bytes.length > MAX_DOC_BYTES) throw new Error(`Documents sent this way can be up to ${MAX_DOC_BYTES / 1024 / 1024} MB.`);
    const name = cleanName(f.name);
    const sha = createHash('sha256').update(f.bytes).digest('hex');
    const ext = extOf(name);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${sha.slice(0, 40)}.${ext}`);
    if (!existsSync(file)) writeFileSync(file, f.bytes, { mode: 0o600 });
    const r = this.db
      .prepare('INSERT INTO library_docs (name, size, sha, ext, keep, conversation_id, origin, learn, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, f.bytes.length, sha, ext, f.keep ? 1 : 0, f.conversationId ?? null, f.origin ?? (f.keep ? 'library' : 'chat'), f.keep && f.learn !== false ? 'waiting' : 'off', this.#now().toISOString());
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** The same file already kept in her library, if any (so a second upload doesn't double it). */
  findKept(bytes: Buffer): LibraryDoc | undefined {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const r = this.db.prepare("SELECT * FROM library_docs WHERE sha = ? AND keep = 1 AND status != 'failed' ORDER BY id LIMIT 1").get(sha) as Row | undefined;
    return r ? toDoc(r) : undefined;
  }

  get(id: number): LibraryDoc | undefined {
    const r = this.db.prepare('SELECT * FROM library_docs WHERE id = ?').get(id) as Row | undefined;
    return r ? toDoc(r) : undefined;
  }

  /** The original file's bytes. */
  file(doc: LibraryDoc): Buffer | undefined {
    const ext = (this.db.prepare('SELECT ext FROM library_docs WHERE id = ?').get(doc.id) as { ext: string } | undefined)?.ext ?? 'bin';
    const path = this.#path(doc.sha, ext);
    return existsSync(path) ? readFileSync(path) : undefined;
  }

  /** Her library (kept documents), newest first; or the documents read once in one conversation. */
  list(opts: { conversationId?: string; collection?: string } = {}): LibraryDoc[] {
    // Phase 110: room archives are never in this list (the prompt's "In your library", the tool's
    // list, MCP, exports); they have their own (`archives`).
    const rows = opts.conversationId
      ? this.db.prepare('SELECT * FROM library_docs WHERE keep = 0 AND conversation_id = ? ORDER BY id DESC').all(opts.conversationId)
      : opts.collection
        ? this.db.prepare('SELECT * FROM library_docs WHERE keep = 1 AND collection = ? ORDER BY id DESC').all(opts.collection)
        : this.db.prepare(`SELECT * FROM library_docs d WHERE keep = 1 AND NOT ${ARCHIVE_SQL} ORDER BY id DESC`).all();
    return (rows as Row[]).map(toDoc);
  }

  /** Phase 110 (CH4): the room archives (one document per room and week), newest week first; or one room's. */
  archives(roomId?: number): LibraryDoc[] {
    const rows = roomId === undefined ? this.db.prepare(`SELECT * FROM library_docs d WHERE ${ARCHIVE_SQL} ORDER BY coalesce(period, '') DESC, id DESC`).all() : this.db.prepare(`SELECT * FROM library_docs d WHERE ${ARCHIVE_SQL} AND room_id = ? ORDER BY coalesce(period, '') DESC, id DESC`).all(roomId);
    return (rows as Row[]).map(toDoc);
  }

  /** Phase 110: a room's archive document for one ISO week, if there is one. */
  archiveFor(roomId: number, period: string): LibraryDoc | undefined {
    const r = this.db.prepare(`SELECT * FROM library_docs d WHERE ${ARCHIVE_SQL} AND room_id = ? AND period = ? ORDER BY id LIMIT 1`).get(roomId, period) as Row | undefined;
    return r ? toDoc(r) : undefined;
  }

  /**
   * Phase 110 (CH4, §7.9): a new read-only weekly transcript of a room. Kept, never learned
   * (`learn = 'off'`), ready at once (no reading job: the text is ours). Runs inside the caller's
   * transaction (the fold's archive step).
   */
  addArchive(a: { name: string; collection: string; roomId: number; period: string }): LibraryDoc {
    const now = this.#now().toISOString();
    const sha = createHash('sha256').update(`room-archive:${a.roomId}:${a.period}:${now}`).digest('hex');
    const id = Number(
      this.db
        .prepare("INSERT INTO library_docs (name, kind, size, sha, ext, title, status, keep, origin, passages, chars, learn, added_at, read_at, collection, read_only, room_id, period) VALUES (?, 'transcript', 0, ?, 'txt', NULL, 'ready', 1, 'room-archive', 0, 0, 'off', ?, ?, ?, 1, ?, ?)")
        .run(cleanName(a.name), sha, now, now, a.collection.slice(0, 200), a.roomId, a.period).lastInsertRowid,
    );
    return this.get(id)!;
  }

  /**
   * Phase 110: appends passages to a document (FTS5 indexes them as they are written). Runs inside
   * the caller's transaction. The original "file" of an archive is its passages (size = text bytes).
   */
  appendPassages(docId: number, passages: { place: string; heading: string | null; text: string }[]): number {
    const doc = this.get(docId);
    if (!doc || !passages.length) return 0;
    const last = this.db.prepare('SELECT coalesce(MAX(ord), -1) AS o FROM library_passages WHERE doc_id = ?').get(docId) as { o: number };
    const put = this.db.prepare('INSERT INTO library_passages (doc_id, ord, place, heading, text) VALUES (?, ?, ?, ?, ?)');
    let chars = 0;
    passages.forEach((p, i) => {
      put.run(docId, Number(last.o) + 1 + i, String(p.place ?? '').slice(0, 80), p.heading?.slice(0, 200) ?? null, String(p.text));
      chars += p.text.length;
    });
    this.db.prepare('UPDATE library_docs SET passages = passages + ?, chars = chars + ?, size = size + ? WHERE id = ?').run(passages.length, chars, Buffer.byteLength(passages.map((p) => p.text).join('\n'), 'utf8'), docId);
    return passages.length;
  }

  /** Phase 110: what the room archives hold (the Library's storage line and Forget this room's card). */
  archiveCounts(roomId?: number): { docs: number; passages: number; bytes: number } {
    const r = (roomId === undefined ? this.db.prepare(`SELECT COUNT(*) AS docs, coalesce(SUM(passages), 0) AS passages, coalesce(SUM(size), 0) AS bytes FROM library_docs d WHERE ${ARCHIVE_SQL}`).get() : this.db.prepare(`SELECT COUNT(*) AS docs, coalesce(SUM(passages), 0) AS passages, coalesce(SUM(size), 0) AS bytes FROM library_docs d WHERE ${ARCHIVE_SQL} AND room_id = ?`).get(roomId)) as Record<string, number>;
    return { docs: Number(r.docs), passages: Number(r.passages), bytes: Number(r.bytes) };
  }

  /** Phase 110: renames a collection (the documents in it keep their read-only names). */
  renameCollection(from: string, to: string): number {
    return Number(this.db.prepare('UPDATE library_docs SET collection = ? WHERE collection = ?').run(to.trim().slice(0, 200), from).changes);
  }

  /** Documents waiting to be read (oldest first); ones with a reading job are run by the job. */
  waiting(limit = 5): LibraryDoc[] {
    return (this.db.prepare("SELECT * FROM library_docs WHERE status IN ('waiting', 'reading') AND id NOT IN (SELECT doc_id FROM library_jobs) ORDER BY id LIMIT ?").all(limit) as Row[]).map(toDoc);
  }

  /** Read documents whose key facts are still to be written (a long document's job does its own). */
  toLearn(limit = 3): LibraryDoc[] {
    return (this.db.prepare("SELECT * FROM library_docs WHERE status = 'ready' AND keep = 1 AND learn IN ('waiting', 'learning') AND id NOT IN (SELECT doc_id FROM library_jobs WHERE phase NOT IN ('done', 'cancelled')) ORDER BY id LIMIT ?").all(limit) as Row[]).map(toDoc);
  }

  setStatus(id: number, status: DocStatus, error: string | null = null): void {
    this.db.prepare('UPDATE library_docs SET status = ?, error = ? WHERE id = ?').run(status, error, id);
    // Reading again from the start: the old job goes (the next round makes a new one).
    if (status === 'waiting') this.db.prepare('DELETE FROM library_jobs WHERE doc_id = ?').run(id);
  }

  setLearn(id: number, learn: LearnStatus, patch: { error?: string | null; facts?: number; summary?: string | null } = {}): void {
    // Phase 110: room archives are never learned (her memory never learns room talk from them).
    if (learn !== 'off' && this.get(id)?.readOnly) return;
    this.db.prepare('UPDATE library_docs SET learn = ?, learn_error = ?, facts = coalesce(?, facts), summary = coalesce(?, summary) WHERE id = ?').run(learn, patch.error ?? null, patch.facts ?? null, patch.summary?.trim().slice(0, 300) || null, id);
  }

  rename(id: number, name: string): LibraryDoc | undefined {
    // Phase 110: a read-only document (a room archive) keeps its name (its collection can be renamed).
    if (this.get(id)?.readOnly) throw new Error('This document is read-only.');
    this.db.prepare('UPDATE library_docs SET name = ? WHERE id = ?').run(cleanName(name), id);
    return this.get(id);
  }

  /** Keeps a read-once document in her library after all (it becomes searchable everywhere). */
  keep(id: number, learn = true): LibraryDoc | undefined {
    if (this.get(id)?.readOnly) return this.get(id);
    this.db.prepare("UPDATE library_docs SET keep = 1, conversation_id = NULL, origin = CASE origin WHEN 'chat' THEN 'chat' ELSE origin END, learn = CASE WHEN ? AND learn = 'off' THEN 'waiting' ELSE learn END WHERE id = ?").run(learn ? 1 : 0, id);
    return this.get(id);
  }

  /** Stores what was read: replaces any passages from an earlier read. */
  setRead(id: number, r: { title?: string | null; kind: string; parts: PartIn[]; warnings: string[]; pagesSeen?: number }): LibraryDoc | undefined {
    if (this.get(id)?.readOnly) throw new Error('This document is read-only.');
    const passages = toPassages(r.parts);
    this.db.exec('BEGIN');
    try {
      this.#dropPassages(id);
      const put = this.db.prepare('INSERT INTO library_passages (doc_id, ord, place, heading, text) VALUES (?, ?, ?, ?, ?)');
      passages.forEach((p, i) => put.run(id, i, p.place, p.heading, p.text));
      const chars = r.parts.reduce((n, p) => n + String(p.text ?? '').length, 0);
      this.db
        .prepare("UPDATE library_docs SET status = 'ready', error = NULL, kind = ?, title = ?, warnings = ?, passages = ?, chars = ?, pages_seen = ?, read_at = ? WHERE id = ?")
        .run(r.kind, r.title?.trim().slice(0, 300) || null, JSON.stringify(r.warnings.slice(0, 20)), passages.length, chars, r.pagesSeen ?? 0, this.#now().toISOString(), id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.#index = undefined;
    return this.get(id);
  }

  #dropPassages(docId: number): void {
    this.db.prepare('DELETE FROM library_vectors WHERE passage_id IN (SELECT id FROM library_passages WHERE doc_id = ?)').run(docId);
    this.db.prepare('DELETE FROM library_passages WHERE doc_id = ?').run(docId);
  }

  /**
   * Import (export file): a kept document comes back with the text she read (the original file
   * isn't in exports; its text is stored as a .txt so it can be downloaded and read again).
   * Runs inside the caller's transaction. Returns the new id, or the id of the same text already here.
   */
  importDoc(d: { name: string; kind?: string | null; title?: string | null; summary?: string | null; overview?: string | null; addedAt?: string; passages: { place: string; heading: string | null; text: string }[]; sections?: { level: number; title: string; page: number; pageEnd: number; summary: string | null }[] }): number {
    const body = Buffer.from(d.passages.map((p) => (p.place ? `[${p.place}]\n${p.text}` : p.text)).join('\n\n'), 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    const had = this.db.prepare('SELECT id FROM library_docs WHERE sha = ? AND keep = 1').get(sha) as { id: number } | undefined;
    if (had) return had.id;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${sha.slice(0, 40)}.txt`);
    if (!existsSync(file)) writeFileSync(file, body, { mode: 0o600 });
    const chars = d.passages.reduce((n, p) => n + p.text.length, 0);
    const id = Number(
      this.db
        .prepare("INSERT INTO library_docs (name, kind, size, sha, ext, title, status, keep, origin, passages, chars, learn, summary, added_at, read_at) VALUES (?, ?, ?, ?, 'txt', ?, 'ready', 1, 'library', ?, ?, 'done', ?, ?, ?)")
        .run(cleanName(d.name), d.kind ?? null, body.length, sha, d.title ?? null, d.passages.length, chars, d.summary ?? null, d.addedAt ?? this.#now().toISOString(), this.#now().toISOString()).lastInsertRowid,
    );
    // Phase 74: pages come back from "page N" places (citations keep working), with the contents.
    const put = this.db.prepare('INSERT INTO library_passages (doc_id, ord, place, heading, text, page) VALUES (?, ?, ?, ?, ?, ?)');
    let pages = 0;
    d.passages.forEach((p, i) => {
      const place = String(p.place ?? '').slice(0, 80);
      const pm = /^page (\d+)$/.exec(place);
      const page = pm ? Number(pm[1]) : null;
      if (page && page > pages) pages = page;
      put.run(id, page ? page * 1000 + i : i, place, p.heading ?? null, String(p.text), page);
    });
    if (pages || d.overview) this.db.prepare('UPDATE library_docs SET pages = ?, overview = ? WHERE id = ?').run(pages, d.overview?.slice(0, 4000) ?? null, id);
    if (Array.isArray(d.sections) && d.sections.length) {
      const sput = this.db.prepare('INSERT INTO library_sections (doc_id, ord, level, title, page, page_end, source, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      d.sections.slice(0, 5000).forEach((x, i) => sput.run(id, i, Number(x.level) || 1, String(x.title ?? '').slice(0, 200), Number(x.page) || 0, Number(x.pageEnd) || 0, 'outline', x.summary ? String(x.summary).slice(0, 1200) : null));
    }
    this.#index = undefined;
    return id;
  }

  /** For export: kept documents with the text she read. */
  exportDocs(): { id: number; name: string; kind: string | null; title: string | null; summary: string | null; overview: string | null; addedAt: string; passages: { place: string; heading: string | null; text: string }[]; sections: { level: number; title: string; page: number; pageEnd: number; summary: string | null }[] }[] {
    return this.list()
      .filter((d) => d.status === 'ready')
      .map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        title: d.title,
        summary: d.summary,
        overview: d.overview,
        addedAt: d.addedAt,
        passages: this.passages(d.id, { limit: 1_000_000 }).map((p) => ({ place: p.place, heading: p.heading, text: p.text })),
        sections: this.sections(d.id).map((x) => ({ level: x.level, title: x.title, page: x.page, pageEnd: x.pageEnd, summary: x.summary })),
      }));
  }

  /** Removes a document, its passages and (if nothing else uses it) the original file. */
  delete(id: number): boolean {
    assertNotHeld(this.db);
    const doc = this.get(id);
    if (!doc) return false;
    const ext = (this.db.prepare('SELECT ext FROM library_docs WHERE id = ?').get(id) as { ext: string }).ext;
    this.#dropPassages(id);
    for (const t of ['library_jobs', 'library_ocr', 'library_sections']) this.db.prepare(`DELETE FROM ${t} WHERE doc_id = ?`).run(id);
    this.db.prepare('DELETE FROM library_docs WHERE id = ?').run(id);
    const others = (this.db.prepare('SELECT COUNT(*) AS n FROM library_docs WHERE sha = ?').get(doc.sha) as { n: number }).n;
    if (!others) rmSync(join(this.dir, `${doc.sha.slice(0, 40)}.${ext}`), { force: true });
    this.#index = undefined;
    return true;
  }

  /** Read-once documents of a conversation that is being deleted. */
  deleteForConversation(conversationId: string): number {
    const ids = (this.db.prepare('SELECT id FROM library_docs WHERE keep = 0 AND conversation_id = ?').all(conversationId) as { id: number }[]).map((r) => r.id);
    for (const id of ids) this.delete(id);
    return ids.length;
  }

  passages(docId: number, opts: { from?: number; limit?: number } = {}): Passage[] {
    return (this.db.prepare('SELECT * FROM library_passages WHERE doc_id = ? AND ord >= ? ORDER BY ord LIMIT ?').all(docId, opts.from ?? 0, opts.limit ?? 50) as Row[]).map(toPassage);
  }

  passage(id: number): Passage | undefined {
    const r = this.db.prepare('SELECT * FROM library_passages WHERE id = ?').get(id) as Row | undefined;
    return r ? toPassage(r) : undefined;
  }

  /** The whole read text of a document (for reading it once in a chat, or for learning). */
  text(docId: number, maxChars = 200_000): string {
    let out = '';
    let lastPlace = '';
    for (const p of this.db.prepare('SELECT place, text FROM library_passages WHERE doc_id = ? ORDER BY ord').iterate(docId) as Iterable<{ place: string; text: string }>) {
      // Overlap is carried into the next passage: drop the repeated start.
      const piece = p.place && p.place !== lastPlace ? `[${p.place}]\n${p.text}` : p.text;
      lastPlace = p.place;
      out += (out ? '\n\n' : '') + piece;
      if (out.length >= maxChars) return out.slice(0, maxChars);
    }
    return out;
  }

  counts(): { docs: number; passages: number; chars: number; bytes: number; reading: number } {
    const r = this.db.prepare(`SELECT COUNT(*) AS docs, coalesce(SUM(passages), 0) AS passages, coalesce(SUM(chars), 0) AS chars, coalesce(SUM(size), 0) AS bytes, coalesce(SUM(status IN ('waiting', 'reading')), 0) AS reading FROM library_docs d WHERE keep = 1 AND NOT ${ARCHIVE_SQL}`).get() as Record<string, number>;
    return { docs: Number(r.docs), passages: Number(r.passages), chars: Number(r.chars), bytes: Number(r.bytes), reading: Number(r.reading) };
  }

  /** Which documents a search may look in: her library, plus what was read once in this chat. */
  #scope(conversationId?: string, docIds?: number[], where: SearchIn = 'library', roomId?: number): { sql: string; args: (string | number)[] } {
    const parts = ['(d.keep = 1' + (conversationId ? ' OR d.conversation_id = ?' : '') + ')', "d.status = 'ready'"];
    const args: (string | number)[] = conversationId ? [conversationId] : [];
    // Phase 110 (CH4): archives only when asked for ('archives' or 'all'); never in the default search.
    if (where === 'library') parts.push(`NOT ${ARCHIVE_SQL}`);
    else if (where === 'archives') parts.push(ARCHIVE_SQL);
    if (roomId !== undefined && where !== 'library') {
      parts.push('d.room_id = ?');
      args.push(roomId);
    }
    if (docIds?.length) {
      parts.push(`d.id IN (${docIds.map(() => '?').join(',')})`);
      args.push(...docIds);
    }
    return { sql: parts.join(' AND '), args };
  }

  /** Passages with the words of the text (best first, by FTS5 rank). */
  searchWords(text: string, opts: { conversationId?: string; docIds?: number[]; limit?: number; in?: SearchIn; roomId?: number } = {}): { passage: Passage; rank: number }[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const scope = this.#scope(opts.conversationId, opts.docIds, opts.in, opts.roomId);
    const rows = this.db
      .prepare(
        `SELECT p.*, bm25(library_fts, 1.0, 0.6) AS rank FROM library_fts JOIN library_passages p ON p.id = library_fts.rowid JOIN library_docs d ON d.id = p.doc_id WHERE library_fts MATCH ? AND ${scope.sql} ORDER BY rank LIMIT ?`,
      )
      .all(q, ...scope.args, opts.limit ?? 8) as Row[];
    return rows.map((r) => ({ passage: toPassage(r), rank: Number(r.rank) }));
  }

  /** Makes vectors for up to a batch of passages that don't have one for the current model. */
  async indexVectors(target: EmbedTarget | undefined, limit = VECTOR_BATCH, docId?: number): Promise<number> {
    if (!target) return 0;
    const todo = this.db
      .prepare(
        `SELECT p.id, p.doc_id, p.text, p.heading FROM library_passages p JOIN library_docs d ON d.id = p.doc_id LEFT JOIN library_vectors v ON v.passage_id = p.id WHERE d.status = 'ready' AND NOT ${ARCHIVE_SQL} AND (v.passage_id IS NULL OR v.model != ?)${docId ? ' AND p.doc_id = ?' : ''} ORDER BY d.keep ASC, p.id LIMIT ?`,
      )
      .all(target.model, ...(docId ? [docId] : []), limit) as { id: number; doc_id: number; text: string; heading: string | null }[];
    if (!todo.length) return 0;
    try {
      const doc = (t: string) => (/nomic-embed/i.test(target.model) ? `search_document: ${t}` : t);
      const vecs = await embedTexts(target, todo.map((p) => doc(`${p.heading ? `${p.heading}\n` : ''}${p.text}`.slice(0, 6000))));
      const put = this.db.prepare('INSERT INTO library_vectors (passage_id, model, vec) VALUES (?, ?, ?) ON CONFLICT(passage_id) DO UPDATE SET model = excluded.model, vec = excluded.vec');
      this.db.exec('BEGIN');
      todo.forEach((p, i) => put.run(p.id, target.model, new Uint8Array(vecs[i].buffer)));
      this.db.exec('COMMIT');
      // New vectors join the search block as they come (a full rebuild only after changes).
      if (this.#index?.model === target.model) todo.forEach((p, i) => this.#index!.add(p.id, p.doc_id, vecs[i]));
      else this.#index = undefined;
      this.vectorError = undefined;
      return todo.length;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.vectorError = (err as Error).message;
      throw err;
    }
  }

  /** How many passages have a vector for the model (for the Library page). */
  vectorCount(model: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM library_vectors WHERE model = ?').get(model) as { n: number }).n;
  }

  /** The meaning-search block for a model (built on first use, then kept up to date). */
  vectorIndex(model: string): VectorIndex {
    if (this.#index?.model !== model) this.#index = VectorIndex.load(this.db, model);
    return this.#index;
  }

  /** Passages closest in meaning to the text (best first), above the floor. */
  async searchMeaning(target: EmbedTarget | undefined, text: string, opts: { conversationId?: string; docIds?: number[]; limit?: number; timeoutMs?: number; in?: SearchIn; roomId?: number } = {}): Promise<{ passage: Passage; score: number }[]> {
    if (!target || !text.trim()) return [];
    const index = this.vectorIndex(target.model);
    if (!index.count) return [];
    let q: Float32Array;
    try {
      const query = /nomic-embed/i.test(target.model) ? `search_query: ${text.slice(0, 2000)}` : /mxbai-embed/i.test(target.model) ? `Represent this sentence for searching relevant passages: ${text.slice(0, 2000)}` : text.slice(0, 2000);
      [q] = await embedTexts(target, [query], AbortSignal.timeout(opts.timeoutMs ?? 2500));
    } catch (err) {
      this.vectorError = (err as Error).message;
      return [];
    }
    const scope = this.#scope(opts.conversationId, opts.docIds, opts.in, opts.roomId);
    const allowed = new Set((this.db.prepare(`SELECT d.id FROM library_docs d WHERE ${scope.sql}`).all(...scope.args) as { id: number }[]).map((r) => r.id));
    // Approximate scores over the whole block, then the best few exactly.
    const cands = index.candidates(q, allowed, Math.max(48, (opts.limit ?? 8) * 4));
    const exact = exactScores(this.db, target.model, q, cands.map((c) => c.id));
    const scored = cands
      .map((c) => ({ id: c.id, score: exact.get(c.id) ?? c.score }))
      .filter((r) => r.score >= PASSAGE_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 8);
    return scored.flatMap((s) => {
      const p = this.passage(s.id);
      return p ? [{ passage: p, score: s.score }] : [];
    });
  }

  /**
   * Finds passages by words and by meaning and merges them (reciprocal rank: a passage both ways
   * comes first). Each result names its document and place.
   */
  async find(text: string, opts: { target?: EmbedTarget; conversationId?: string; docIds?: number[]; limit?: number; timeoutMs?: number; in?: SearchIn; roomId?: number } = {}): Promise<PassageHit[]> {
    const limit = opts.limit ?? 5;
    const words = this.searchWords(text, { ...opts, limit: limit * 2 });
    const meaning = await this.searchMeaning(opts.target, text, { ...opts, limit: limit * 2 });
    const merged = new Map<number, { passage: Passage; score: number; by: PassageHit['by'] }>();
    words.forEach((w, i) => merged.set(w.passage.id, { passage: w.passage, score: 1 / (60 + i), by: 'words' }));
    meaning.forEach((m, i) => {
      const had = merged.get(m.passage.id);
      if (had) {
        had.score += 1 / (60 + i);
        had.by = 'both';
      } else merged.set(m.passage.id, { passage: m.passage, score: 1 / (60 + i), by: 'meaning' });
    });
    const docs = new Map<number, LibraryDoc | undefined>();
    const out: PassageHit[] = [];
    for (const h of [...merged.values()].sort((a, b) => b.score - a.score)) {
      if (!docs.has(h.passage.docId)) docs.set(h.passage.docId, this.get(h.passage.docId));
      const doc = docs.get(h.passage.docId);
      if (doc) out.push({ ...h, doc });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** "your lease (page 4)": how she names where a passage came from. */
export function sourceLabel(doc: Pick<LibraryDoc, 'name' | 'title'>, place: string): string {
  const name = doc.title && doc.title.length < 80 ? doc.title : doc.name;
  return place ? `${name}, ${place}` : name;
}

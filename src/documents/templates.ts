// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): templates and past documents. Any
// Library document can be marked a template of a kind (contract, proposal, letter, NDA, SOW, invoice
// cover); its placeholders are found once and kept with the mark. Past documents are the person's
// own wording: for a kind of document, the clause each past document has (by the clause checklist)
// is offered with the document it came from, and a clause she reuses is checked word for word
// against that document before it goes into a draft. Each space keeps its own (its own database).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import type { LibraryDoc } from '../library/store.ts';
import { readDocument } from '../library/read.ts';
import { clauseChecklist, DOC_TYPES, guessDocType, type DocType } from './clauses.ts';
import { detectPlaceholders, type Placeholder } from './placeholders.ts';

export interface DocTemplate {
  libraryId: number;
  type: DocType;
  placeholders: Placeholder[];
  createdAt: string;
}

type Row = Record<string, unknown>;
const toTemplate = (r: Row): DocTemplate => ({ libraryId: Number(r.library_id), type: String(r.type) as DocType, placeholders: JSON.parse(String(r.placeholders)) as Placeholder[], createdAt: String(r.created_at) });

export class DocTemplates {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date) {
    this.#db = db;
    this.#now = now;
    db.exec('CREATE TABLE IF NOT EXISTS doc_templates (library_id INTEGER PRIMARY KEY, type TEXT NOT NULL, placeholders TEXT NOT NULL, created_at TEXT NOT NULL)');
  }
  mark(libraryId: number, type: DocType, placeholders: Placeholder[]): DocTemplate {
    this.#db.prepare('INSERT INTO doc_templates (library_id, type, placeholders, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(library_id) DO UPDATE SET type = excluded.type, placeholders = excluded.placeholders').run(libraryId, type, JSON.stringify(placeholders.slice(0, 200)), this.#now().toISOString());
    return this.get(libraryId)!;
  }
  unmark(libraryId: number): boolean {
    return Number(this.#db.prepare('DELETE FROM doc_templates WHERE library_id = ?').run(libraryId).changes) > 0;
  }
  get(libraryId: number): DocTemplate | undefined {
    const r = this.#db.prepare('SELECT * FROM doc_templates WHERE library_id = ?').get(libraryId) as Row | undefined;
    return r ? toTemplate(r) : undefined;
  }
  list(): DocTemplate[] {
    return (this.#db.prepare('SELECT * FROM doc_templates ORDER BY created_at DESC').all() as Row[]).map(toTemplate);
  }
}

const stores = new WeakMap<DatabaseSync, DocTemplates>();
export function docTemplates(app: AppContext): DocTemplates {
  const db = app.store.db;
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new DocTemplates(db, () => app.now())));
  return s;
}

const TEXTY = /\.(docx|pdf|txt|md|markdown|html?|rtf|odt)$/i;

/** A Library document's text (read from its file, so it works before the Library has read it). */
export async function docText(app: AppContext, doc: LibraryDoc): Promise<string> {
  const lib = app.library;
  if (!lib) return '';
  if (doc.status === 'ready' && doc.chars) {
    const t = lib.text(doc.id);
    if (t.trim()) return t;
  }
  const bytes = lib.file(doc);
  if (!bytes) return '';
  try {
    const r = await readDocument(doc.name, bytes, { maxChars: 400_000 });
    return r.parts.map((p) => (p.where && /^page /.test(p.where) ? `[${p.where}]\n${p.text}` : p.text)).join('\n\n');
  } catch {
    return '';
  }
}

export interface PastClause {
  topic: string;
  label: string;
  docId: number;
  docName: string;
  quote: string;
  where: string;
}

/**
 * The person's own clause wording from past documents of this kind (newest first), one per clause
 * per document, each with the document it came from.
 */
export async function pastClauses(app: AppContext, type: DocType, o: { exclude?: number[]; limitDocs?: number } = {}): Promise<PastClause[]> {
  const lib = app.library;
  if (!lib) return [];
  const skip = new Set([...(o.exclude ?? []), ...docTemplates(app).list().map((t) => t.libraryId)]);
  const out: PastClause[] = [];
  let seen = 0;
  for (const d of lib.list()) {
    if (skip.has(d.id) || !d.keep || !TEXTY.test(d.name) || d.readOnly) continue;
    if (seen >= (o.limitDocs ?? 12)) break;
    const text = await docText(app, d);
    if (!text.trim()) continue;
    const kind = guessDocType(d.name, text);
    if (kind !== type && !(type === 'sow' && kind === 'contract') && !(type === 'contract' && (kind === 'sow' || kind === 'nda'))) continue;
    seen++;
    for (const i of clauseChecklist(text, type).items) {
      if (i.status === 'missing' || !i.quote || i.id === 'parties' || i.id === 'signatures') continue;
      out.push({ topic: i.id, label: i.label, docId: d.id, docName: d.name, quote: i.quote, where: i.where ?? '' });
    }
  }
  return out;
}

const foldQ = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚`]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

/** True when `quote` is really in the text (whitespace, quote marks and accents folded). */
export function quoteIn(text: string, quote: string): boolean {
  const q = foldQ(quote);
  return q.length >= 12 && foldQ(text.replace(/\[[^\]\n]{1,40}\]\n/g, ' ')).includes(q);
}

export const isTemplateType = (v: unknown): v is DocType => (DOC_TYPES as readonly string[]).includes(String(v));
export { detectPlaceholders };

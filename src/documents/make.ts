// make_document (docs/DOCUMENTS.md): makes the file, keeps it, and remembers how it was made.
// Every document she makes is saved in her Library (so it can be found, read and shared like any
// other) and recorded in `made_docs` with the Markdown or sheets it came from, so \"Make changes\"
// makes a new version from it and the old versions stay. Each household member has their own data
// folder, so their documents, Library and versions are theirs alone.
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import type { AppContext } from '../chat.ts';
import { makeDocx } from './docx.ts';
import { makeHtml, previewHtml } from './html.ts';
import { measure } from './images.ts';
import { makePdf } from './pdf.ts';
import { makePptx } from './pptx.ts';
import { cleanSpec, DocError, type DocFormat, type DocSpec, fileName, type ImageLookup, LIMITS, MIME, type Picture } from './spec.ts';
import { makeCsv, makeXlsx } from './xlsx.ts';

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** The file's bytes for a spec. */
export function renderDocument(spec: DocSpec, image: ImageLookup): Buffer {
  switch (spec.format) {
    case 'docx':
      return makeDocx(spec, image);
    case 'pdf':
      return makePdf(spec, image);
    case 'xlsx':
      return makeXlsx(spec);
    case 'pptx':
      return makePptx(spec, image);
    case 'csv':
      return makeCsv(spec);
    case 'html':
      return Buffer.from(makeHtml(spec, image), 'utf8');
    case 'md':
      return Buffer.from(spec.content.endsWith('\n') ? spec.content : `${spec.content}\n`, 'utf8');
  }
}

/** Pictures from this space's own uploads and Library only (never a web address). */
export function imagesOf(app: AppContext): ImageLookup {
  const cache = new Map<string, Picture | undefined>();
  return (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    let p: Picture | undefined;
    try {
      let bytes: Buffer | undefined;
      if (ref.startsWith('upload:')) {
        const u = app.uploads?.get(ref.slice(7));
        if (u && statSync(u.path).size <= MAX_PICTURE_BYTES) bytes = readFileSync(u.path);
      } else if (ref.startsWith('library:')) {
        const doc = app.library?.get(Number(ref.slice(8)));
        if (doc && doc.size <= MAX_PICTURE_BYTES) bytes = app.library!.file(doc);
      }
      p = bytes ? measure(bytes) : undefined;
    } catch {
      p = undefined;
    }
    cache.set(ref, p);
    return p;
  };
}

export interface MadeDoc {
  id: number;
  /** The first version's id (all versions of one document share it). */
  family: number;
  version: number;
  format: DocFormat;
  title: string;
  name: string;
  bytes: number;
  libraryId: number | null;
  conversationId: string | null;
  createdAt: string;
  spec: DocSpec;
}

type Row = Record<string, unknown>;
const toMade = (r: Row): MadeDoc => ({
  id: Number(r.id),
  family: Number(r.family),
  version: Number(r.version),
  format: String(r.format) as DocFormat,
  title: String(r.title),
  name: String(r.name),
  bytes: Number(r.bytes),
  libraryId: r.library_id == null ? null : Number(r.library_id),
  conversationId: r.conversation_id == null ? null : String(r.conversation_id),
  createdAt: String(r.created_at),
  spec: JSON.parse(String(r.spec)) as DocSpec,
});

export class MadeDocs {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS made_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, family INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      format TEXT NOT NULL, title TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, spec TEXT NOT NULL,
      library_id INTEGER, conversation_id TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS made_docs_family ON made_docs(family, version);`);
  }
  add(m: Omit<MadeDoc, 'id' | 'family'> & { family?: number }): MadeDoc {
    const r = this.#db
      .prepare('INSERT INTO made_docs (family, version, format, title, name, bytes, spec, library_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.family ?? 0, m.version, m.format, m.title, m.name, m.bytes, JSON.stringify(m.spec), m.libraryId, m.conversationId, m.createdAt);
    const id = Number(r.lastInsertRowid);
    if (!m.family) this.#db.prepare('UPDATE made_docs SET family = ? WHERE id = ?').run(id, id);
    return this.get(id)!;
  }
  get(id: number): MadeDoc | undefined {
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const r = this.#db.prepare('SELECT * FROM made_docs WHERE id = ?').get(id) as Row | undefined;
    return r ? toMade(r) : undefined;
  }
  versions(family: number): MadeDoc[] {
    return (this.#db.prepare('SELECT * FROM made_docs WHERE family = ? ORDER BY version').all(family) as Row[]).map(toMade);
  }
  /** Forget the record of a library document that was deleted (the file itself is the Library's). */
  forgetLibrary(libraryId: number): void {
    this.#db.prepare('UPDATE made_docs SET library_id = NULL WHERE library_id = ?').run(libraryId);
  }
}

const stores = new WeakMap<DatabaseSync, MadeDocs>();
/** This space's record of made documents (in its own database). */
export function madeDocs(app: AppContext): MadeDocs {
  const db = app.store.db;
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new MadeDocs(db)));
  return s;
}

export const FORMAT_LABEL: Record<DocFormat, string> = { docx: 'Word document', pdf: 'PDF', xlsx: 'Excel spreadsheet', pptx: 'PowerPoint presentation', md: 'Markdown file', csv: 'CSV file', html: 'web page' };

/**
 * Makes a document (or a new version of one) and keeps it. Throws a DocError the model can act on.
 * `basedOn`: the document it changes (same format and title unless given).
 */
export function makeDocument(app: AppContext, args: Record<string, unknown>, o: { conversationId?: string; keep?: boolean } = {}): { made: MadeDoc; data: Buffer; mime: string } {
  const store = madeDocs(app);
  const baseId = Number(args.basedOn);
  const base = args.basedOn !== undefined && args.basedOn !== null && args.basedOn !== '' ? store.get(baseId) : undefined;
  if (args.basedOn !== undefined && args.basedOn !== null && args.basedOn !== '' && !base) throw new DocError(`There is no document #${String(args.basedOn)} here.`);
  const spec = cleanSpec({ ...args, format: args.format ?? base?.format, title: args.title ?? base?.title, template: args.template ?? base?.spec.template });
  const data = renderDocument(spec, imagesOf(app));
  if (data.length > LIMITS.outBytes) throw new DocError(`That document came out at ${Math.round(data.length / 1048576)} MB; documents can be up to ${LIMITS.outBytes / 1048576} MB. Use fewer or smaller pictures, or split it.`);
  const family = base?.family;
  const version = family ? Math.max(...store.versions(family).map((v) => v.version)) + 1 : 1;
  const name = fileName(spec.title, spec.format, version);
  let libraryId: number | null = null;
  if (app.library) {
    try {
      const keep = o.keep !== false;
      libraryId = app.library.add({ name, bytes: data, keep, conversationId: keep ? null : (o.conversationId ?? null), origin: keep ? 'library' : 'chat', learn: false }).id;
      app.libraryNudge?.();
      app.events?.publish({ type: 'library', id: libraryId });
    } catch (err) {
      console.warn(`make_document: saving to the Library failed: ${(err as Error).message}`);
    }
  }
  const made = store.add({ ...(family ? { family } : {}), version, format: spec.format, title: spec.title, name, bytes: data.length, spec, libraryId, conversationId: o.conversationId ?? null, createdAt: app.now().toISOString() });
  return { made, data, mime: MIME[spec.format] };
}

/** A made document's file (from the Library, or made again from its record if the file was removed). */
export function madeFile(app: AppContext, m: MadeDoc): Buffer {
  const doc = m.libraryId ? app.library?.get(m.libraryId) : undefined;
  const bytes = doc ? app.library!.file(doc) : undefined;
  return bytes ?? renderDocument(m.spec, imagesOf(app));
}

/** The Open button's page for a made document. */
export function madePreview(app: AppContext, m: MadeDoc): string {
  return previewHtml(m.spec, imagesOf(app));
}

export { DocError };

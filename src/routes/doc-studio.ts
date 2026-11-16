// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): the Library's document panel for
// contracts, proposals and letters, each person's own (a household member's Library is their own
// space). Never the demo.
//   GET  /api/doc-studio/templates          {templates: [{libraryId, name, type, placeholders}]}
//   GET  /api/doc-studio/:libraryId         {type, template, placeholders, revisions, checklist}
//   PUT  /api/doc-studio/:libraryId/template {on, type} → {template}
//   POST /api/doc-studio/:libraryId/fill    {values, title} → {made, filled, missing}
//   POST /api/doc-studio/:libraryId/resolve {how: accept|reject} → {made, resolved}
//   POST /api/doc-studio/:libraryId/sign    {signers?, draft?} → {ready, checks, made?}
import { clauseChecklist, DOC_TYPES, guessDocType, isDocType } from '../documents/clauses.ts';
import { DocError, keepMade, madeDocs } from '../documents/make.ts';
import { detectPlaceholders, fillDocxPlaceholders } from '../documents/placeholders.ts';
import { docxToMarkdown, makeSignPdf, signersOf } from '../documents/sign.ts';
import { docTemplates, docText } from '../documents/templates.ts';
import { listRevisions, resolveAll } from '../documents/tracked.ts';
import type { DocSpec } from '../documents/spec.ts';
import { HttpError, readJson, send } from '../http.ts';
import type { LibraryDoc } from '../library/store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const baseName = (n: string) => n.replace(/\.[a-z0-9]+$/i, '').replace(/\s+v\d+$/i, '');

export function createDocStudioRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'doc-studio') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const lib = app.library;
    if (!lib) throw new HttpError(404, 'The library is not available');
    const store = docTemplates(app);
    if (b === 'templates' && !c && method === 'GET') {
      const templates = store.list().flatMap((t) => {
        const d = lib.get(t.libraryId);
        return d ? [{ libraryId: t.libraryId, name: d.name, type: t.type, placeholders: t.placeholders.filter((p) => p.kind !== 'signature') }] : [];
      });
      return send(res, 200, { templates, types: DOC_TYPES });
    }
    const id = Number(b);
    const doc: LibraryDoc | undefined = Number.isInteger(id) ? lib.get(id) : undefined;
    if (!doc) throw new HttpError(404, 'That document is not here.');
    const docx = /\.docx$/i.test(doc.name);
    const fileOf = () => {
      const f = lib.file(doc);
      if (!f) throw new HttpError(404, 'The file for that document is not here any more.');
      return f;
    };
    const keep = (spec: DocSpec, data: Buffer, from?: LibraryDoc) => {
      const family = from ? madeDocs(app).byLibrary(from.id)?.family : undefined;
      const m = keepMade(app, { spec, data, ...(family ? { family } : {}) });
      return { id: m.id, libraryId: m.libraryId, name: m.name, version: m.version, format: m.format };
    };
    const title = () => madeDocs(app).byLibrary(doc.id)?.title ?? baseName(doc.name);
    const wrap = <T>(f: () => T): T => {
      try {
        return f();
      } catch (err) {
        if (err instanceof DocError) throw new HttpError(400, err.message);
        throw err;
      }
    };
    if (!c && method === 'GET') {
      const text = await docText(app, doc);
      const tpl = store.get(doc.id);
      const type = tpl?.type ?? guessDocType(doc.name, text);
      let revisions: ReturnType<typeof listRevisions> = [];
      if (docx) {
        try {
          revisions = listRevisions(fileOf()).slice(0, 300);
        } catch {
          revisions = [];
        }
      }
      return send(res, 200, {
        id: doc.id,
        name: doc.name,
        docx,
        type,
        types: DOC_TYPES,
        template: tpl ?? null,
        placeholders: (tpl?.placeholders ?? detectPlaceholders(text)).filter((p) => p.kind !== 'signature'),
        revisions,
        checklist: text.trim() ? clauseChecklist(text, type) : null,
      });
    }
    if (c === 'template' && method === 'PUT') {
      const body = (await readJson(req)) as { on?: unknown; type?: unknown };
      if (body.on === false) {
        store.unmark(doc.id);
        return send(res, 200, { template: null });
      }
      const text = await docText(app, doc);
      const type = isDocType(body.type) ? body.type : guessDocType(doc.name, text);
      return send(res, 200, { template: store.mark(doc.id, type, detectPlaceholders(text)) });
    }
    if (c === 'fill' && method === 'POST') {
      const body = (await readJson(req)) as { values?: Record<string, unknown>; title?: unknown };
      if (!docx) throw new HttpError(400, 'Only a Word (.docx) template can be filled here; ask her in the chat for other kinds.');
      const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
      const r = wrap(() => fillDocxPlaceholders(fileOf(), values));
      if (!r.filled.length) throw new HttpError(400, 'Fill in at least one blank first.');
      const t = String(body.title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || `${baseName(doc.name)} (draft)`;
      const made = keep({ format: 'docx', title: t, template: 'plain', content: docxToMarkdown(r.data), edited: { kind: 'template', fromId: doc.id, fromName: doc.name, clauses: [] } }, r.data);
      return send(res, 201, { made, filled: r.filled, missing: r.missing });
    }
    if (c === 'resolve' && method === 'POST') {
      const body = (await readJson(req)) as { how?: unknown };
      if (body.how !== 'accept' && body.how !== 'reject') throw new HttpError(400, 'how is accept or reject.');
      if (!docx) throw new HttpError(400, 'Only a Word (.docx) file has tracked changes.');
      const r = wrap(() => resolveAll(fileOf(), body.how as 'accept' | 'reject'));
      if (!r.resolved) throw new HttpError(400, 'There are no tracked changes in it.');
      const made = keep({ format: 'docx', title: title(), template: 'plain', content: docxToMarkdown(r.data), edited: { kind: 'tracked', fromId: doc.id, fromName: doc.name } }, r.data, doc);
      return send(res, 201, { made, resolved: r.resolved });
    }
    if (c === 'sign' && method === 'POST') {
      const body = (await readJson(req)) as { signers?: unknown; draft?: unknown };
      if (!docx) throw new HttpError(400, 'Make the signing PDF from the final Word (.docx) file.');
      const bytes = fileOf();
      const signers = signersOf(body.signers, await docText(app, doc));
      const r = wrap(() => makeSignPdf({ docx: bytes, title: title(), signers, draft: body.draft === true }));
      if (!r.data) return send(res, 200, { ready: false, checks: r.checks, made: null });
      const made = keep({ format: 'pdf', title: title(), template: 'report', content: docxToMarkdown(bytes), sign: { signers }, edited: { kind: 'sign', fromId: doc.id, fromName: doc.name } }, r.data);
      return send(res, 201, { ready: r.ready, checks: r.checks, pages: r.pages, signers, made });
    }
    throw new HttpError(404, 'Not found');
  };
}

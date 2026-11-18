// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): contracts, proposals and letters end to
// end. doc_from_template drafts from the person's template (placeholders filled in their own Word
// file) and their past documents (clauses reused word for word, each checked against the document it
// came from); doc_revise writes real tracked changes into a Word file; doc_checklist reads a document
// against the usual clauses for its kind; doc_to_sign makes the signature-ready PDF after the Ready
// to sign check. Every file is a new copy kept in the Library (the person's original never changes)
// and arrives as the usual document card. Information, not legal advice.
import type { AppContext } from '../chat.ts';
import { checklistText, clauseChecklist, DOC_TYPE_LABEL, guessDocType, isDocType, type DocType } from '../documents/clauses.ts';
import { DocError, FORMAT_LABEL, keepMade, madeDocs, makeDocument } from '../documents/make.ts';
import { detectPlaceholders, fillDocxPlaceholders, fillText } from '../documents/placeholders.ts';
import { docxToMarkdown, makeSignPdf, signersOf } from '../documents/sign.ts';
import { LIMITS, MIME, type DocSpec } from '../documents/spec.ts';
import { docTemplates, docText, pastClauses, quoteIn } from '../documents/templates.ts';
import { addClauses, changesOf, listRevisions, resolveAll, reviseDocx } from '../documents/tracked.ts';
import type { LibraryDoc } from '../library/store.ts';
import { minorSexualMatch } from '../safety.ts';
import type { Conversation } from '../store.ts';
import { findForm } from './fill-document.ts';
import { shareMade } from './make-document.ts';
import { humanSize } from './send-file.ts';
import { ToolError, type Tool, type ToolContext } from './types.ts';

export const DOC_STUDIO_TOOLS = ['doc_from_template', 'doc_revise', 'doc_checklist', 'doc_to_sign'] as const;

interface Env {
  app: AppContext;
  conv: Conversation | undefined;
  docs: LibraryDoc[];
}

function envOf(getApp: () => AppContext, ctx: ToolContext): Env {
  const app = getApp();
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  if (conv?.partner) throw new ToolError("Documents can't be made or changed in this chat (a chat with another companion or person): ask the owner to ask for it in their own chat with you.");
  const lib = app.library;
  if (!lib) throw new ToolError('There is no library here, so there are no documents to work with.');
  return { app, conv, docs: [...(conv ? lib.list({ conversationId: conv.id }) : []), ...lib.list()] };
}

const wrapDoc = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof DocError) throw new ToolError(err.message);
    throw err;
  }
};

/** The document asked for; by name, the newest version of one she made (a number means that exact one). */
function pick(e: Env, q: string): LibraryDoc {
  const doc = findForm(e.docs, q);
  if (/^#?\d+$/.test(q.trim())) return doc;
  const m = madeDocs(e.app).byLibrary(doc.id);
  const latest = m ? madeDocs(e.app).versions(m.family).filter((v) => v.format === m.format && v.libraryId).at(-1) : undefined;
  return (latest?.libraryId && e.app.library!.get(latest.libraryId)) || doc;
}

function fileOf(e: Env, doc: LibraryDoc): Buffer {
  const b = e.app.library!.file(doc);
  if (!b) throw new ToolError(`The file for “${doc.name}” isn't here any more.`);
  return b;
}

const cleanTitle = (v: unknown, fallback: string) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\.(docx|pdf)$/i, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.titleChars) || fallback;
const baseName = (n: string) => n.replace(/\.[a-z0-9]+$/i, '').replace(/\s+v\d+$/i, '');

/** Saves the new file (a new version when it came from one of her documents) and puts the card in the chat. */
function keepAndShare(e: Env, ctx: ToolContext, spec: DocSpec, data: Buffer, from?: LibraryDoc): string {
  if (data.length > LIMITS.outBytes) throw new ToolError('That document is too big to keep.');
  const family = from ? madeDocs(e.app).byLibrary(from.id)?.family : undefined;
  const made = keepMade(e.app, { spec, data, ...(family ? { family } : {}), ...(e.conv ? { conversationId: e.conv.id } : {}), keep: !e.conv?.private });
  const shared = shareMade(e.app, ctx, e.conv, made, data, MIME[spec.format]);
  const where = [shared ? 'it is in the chat with Download and Open buttons' : '', made.libraryId ? `it is saved in the Library (document ${made.libraryId})` : ''].filter(Boolean).join(', and ');
  return `Saved “${made.name}” (${FORMAT_LABEL[spec.format]}, ${humanSize(data.length)}), document #${made.id}${made.version > 1 ? `, version ${made.version}` : ''}.${where ? ` ${where[0].toUpperCase()}${where.slice(1)}.` : ''}`;
}

interface ClauseIn {
  topic: string;
  fromDoc: number;
  text: string;
}
function clausesIn(v: unknown): ClauseIn[] {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) throw new ToolError('clauses is a list: [{"topic": "Liability", "fromDoc": 12, "text": "the clause, word for word from that document"}].');
  return v.slice(0, 30).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? o.quote ?? '').trim().slice(0, 6000);
    const fromDoc = Number(String(o.fromDoc ?? o.from ?? '').replace(/^#/, ''));
    if (!text || !Number.isInteger(fromDoc)) throw new ToolError('Each clause needs topic, fromDoc (the past document\'s Library number) and text (word for word from it).');
    return { topic: String(o.topic ?? '').trim().slice(0, 80), fromDoc, text };
  });
}

export function createDocStudioTools(getApp: () => AppContext): Tool[] {
  const fromTemplate: Tool = {
    spec: {
      name: 'doc_from_template',
      description:
        "Draft a contract, proposal, letter, NDA, SOW or invoice cover from the person's own template or past documents in the Library. Call it first with only `template` (its name or Library number): it returns the placeholders to fill ({{Client}}, [CLIENT NAME], Date: ____) and clauses from their past documents of that kind, each with the document it came from. Ask the person only for the facts you don't know (ask_choice when there are a few set options); then call again with `values` ({\"Client\": \"Acme Corp\"}, the placeholder labels as listed). To reuse a clause from a past document, pass clauses: [{topic, fromDoc (its Library number), text (word for word from that document)}]; each is checked against that document and its source is shown. Without a template, give `content` (Markdown) and clauses to draft from past documents. Makes a Word file (their own template's formatting is kept). Information, not legal advice.",
      parameters: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'The template or past document: its name (or part of it) or Library number.' },
          values: { type: 'object', description: 'Placeholder label: value, e.g. {"Client": "Acme Corp", "EFFECTIVE DATE": "March 1, 2027"}.' },
          clauses: { type: 'array', description: 'Clauses reused from past documents: [{"topic": "Liability", "fromDoc": 12, "text": "word for word"}].', items: { type: 'object' } },
          content: { type: 'string', description: 'Optional, without a template: the whole draft as Markdown.' },
          type: { type: 'string', enum: ['contract', 'nda', 'sow', 'proposal', 'letter', 'invoice'], description: 'Optional: the kind of document (picked from the template when left out).' },
          title: { type: 'string', description: 'The new document\'s title (its file name), e.g. "Consulting Agreement - Acme".' },
        },
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Draft from ${String(a.template ?? 'past documents').slice(0, 80)}`,
    run: async (args, ctx) => {
      const e = envOf(getApp, ctx);
      const tpl = args.template !== undefined && String(args.template).trim() ? findForm(e.docs, String(args.template)) : undefined;
      const tplText = tpl ? await docText(e.app, tpl) : '';
      const marked = tpl ? docTemplates(e.app).get(tpl.id) : undefined;
      const type: DocType = isDocType(args.type) ? args.type : marked?.type ?? guessDocType(tpl?.name ?? String(args.title ?? ''), tplText || String(args.content ?? ''));
      const values = args.values && typeof args.values === 'object' && !Array.isArray(args.values) ? (args.values as Record<string, unknown>) : {};
      const clauses = clausesIn(args.clauses);
      const content = typeof args.content === 'string' ? args.content.slice(0, LIMITS.contentChars) : '';
      if (minorSexualMatch(`${String(args.title ?? '')}\n${JSON.stringify(values)}\n${content}`, { fromHer: true })) throw new ToolError("I won't make that.");
      // 1) Nothing to fill yet: the facts to ask for, and the person's own past clauses.
      if (!Object.keys(values).length && !content && !clauses.length) {
        if (!tpl) throw new ToolError('Say which template or past document to start from (its name or Library number), or give content.');
        const ph = (marked?.placeholders ?? detectPlaceholders(tplText)).filter((p) => p.kind !== 'signature');
        const past = await pastClauses(e.app, type, { exclude: [tpl.id] });
        const lines = ph.map((p) => `- ${p.label}${p.count > 1 ? ` (${p.count} places)` : ''}`).join('\n');
        const pc = past.slice(0, 12).map((c) => `- ${c.label}, from “${c.docName}” (#${c.docId}, ${c.where}): “${c.quote.slice(0, 300)}”`).join('\n');
        return `“${tpl.name}” (#${tpl.id}) is a ${DOC_TYPE_LABEL[type].toLowerCase()} template with ${ph.length} ${ph.length === 1 ? 'placeholder' : 'placeholders'}:\n${lines || '- (none found: it may use other wording for its blanks)'}\n${pc ? `\nTheir own clauses from past ${DOC_TYPE_LABEL[type].toLowerCase()}s (reuse word for word with clauses: [{topic, fromDoc, text}]):\n${pc}\n` : ''}\nAsk the person for the facts you don't already know, in one short message (use ask_choice when there are a few set options, like the state or payment terms); then call doc_from_template again with values. Don't invent names, amounts or dates.`;
      }
      // 2) Clauses from past documents: each must really be in the document it is said to come from.
      const kept: { topic: string; fromId: number; fromName: string; quote: string }[] = [];
      for (const c of clauses) {
        const d = e.app.library!.get(c.fromDoc);
        if (!d) throw new ToolError(`There is no document #${c.fromDoc} in the Library.`);
        if (!quoteIn(await docText(e.app, d), c.text)) throw new ToolError(`That ${c.topic || 'clause'} isn't in “${d.name}” word for word: “${c.text.slice(0, 160)}”. Quote the clause exactly as that document has it (doc_from_template with only the template lists them), or write it as a new clause in the content without a source.`);
        kept.push({ topic: c.topic, fromId: d.id, fromName: d.name, quote: c.text });
      }
      const title = cleanTitle(args.title, tpl ? `${baseName(tpl.name)} (draft)` : 'Draft');
      const sources = kept.length ? `\nClauses from past documents:\n${kept.map((k) => `- ${k.topic || 'Clause'}: from “${k.fromName}” (#${k.fromId}): “${k.quote.slice(0, 200)}”`).join('\n')}` : '';
      let data: Buffer;
      let filledLine = '';
      if (tpl && /\.docx$/i.test(tpl.name) && !content) {
        // Their own Word template: values written in place, clauses added before the signatures.
        const res = wrapDoc(() => fillDocxPlaceholders(fileOf(e, tpl), values));
        data = wrapDoc(() => addClauses(res.data, kept.filter((k) => !quoteIn(tplText, k.quote)).map((k) => ({ heading: k.topic, text: k.quote }))));
        const total = res.filled.length + res.missing.length;
        filledLine = `Filled ${res.filled.length} of ${total} placeholders${res.missing.length ? `; not filled: ${res.missing.join(', ')} (ask for them, then call again with all the values)` : ''}.`;
      } else {
        // A PDF or text template, or a draft from past documents: a new Word file from the text.
        let md = content;
        let f = { filled: [] as string[], missing: [] as string[] };
        if (!md) {
          const r = fillText(tplText.replace(/^\[page \d+\]\n/gm, ''), values);
          md = r.text;
          f = r;
        }
        for (const k of kept) if (!quoteIn(md, k.quote)) md += `\n\n## ${k.topic || 'Clause'}\n\n${k.quote}`;
        const out = wrapDoc(() => makeDocument(e.app, { format: 'docx', title, content: md, template: type === 'letter' ? 'letter' : 'report' }, { ...(e.conv ? { conversationId: e.conv.id } : {}), keep: !e.conv?.private }));
        // makeDocument keeps it already: record where it came from and share it.
        const m = out.made;
        m.spec.edited = { kind: 'draft', ...(tpl ? { fromId: tpl.id, fromName: tpl.name } : {}), clauses: kept };
        e.app.store.db.prepare('UPDATE made_docs SET spec = ? WHERE id = ?').run(JSON.stringify(m.spec), m.id);
        const shared = shareMade(e.app, ctx, e.conv, m, out.data, out.mime);
        const total = f.filled.length + f.missing.length;
        filledLine = tpl ? `Filled ${f.filled.length} of ${total} placeholders${f.missing.length ? `; not filled: ${f.missing.join(', ')}` : ''}.` : 'Drafted from past documents.';
        return `${filledLine} Made “${m.name}” (Word document, ${humanSize(out.data.length)}), document #${m.id}${shared ? ', in the chat with Download and Open buttons' : ''}${m.libraryId ? `, saved in the Library (document ${m.libraryId})` : ''}.${sources}\nTell them in a sentence what you made and where each reused clause came from. Offer the clause checklist (doc_checklist). Information, not legal advice.`;
      }
      const spec: DocSpec = { format: 'docx', title, template: 'plain', content: docxToMarkdown(data), edited: { kind: 'template', fromId: tpl.id, fromName: tpl.name, clauses: kept } };
      return `${filledLine} ${keepAndShare(e, ctx, spec, data)} The template “${tpl.name}” is unchanged.${sources}\nTell them in a sentence what you made and where each reused clause came from. Offer the clause checklist (doc_checklist). Information, not legal advice.`;
    },
  };

  const revise: Tool = {
    spec: {
      name: 'doc_revise',
      description:
        "Revise a Word document (.docx) with real tracked changes: each change is written as a Word revision by Sara with the date (body, headers, footers, footnotes, text boxes), so the person can Accept or Reject it in Word (Review tab) or in the app. changes: [{\"find\": \"exact words now in it\", \"replace\": \"new words\"}] (add \"all\": true to change every place), [{\"after\": \"words in a paragraph\", \"insert\": \"a new paragraph after it\"}], [{\"deleteParagraph\": \"words in the paragraph\"}], [{\"comment\": \"a note or question\", \"on\": \"exact words it is about\"}] (a Word comment instead of an edit), [{\"move\": \"words in a paragraph\", \"after\": \"words in the paragraph it goes after\"}] (or \"before\"; a tracked move). Quote enough words to be unique. resolve: \"accept\" or \"reject\" applies or drops every tracked change (when they decide). Makes a new version; the earlier one is kept.",
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The Word document: its name or Library number.' },
          changes: { type: 'array', items: { type: 'object' }, description: 'The changes (find/replace, after/insert, deleteParagraph, comment/on, move/after).' },
          resolve: { type: 'string', enum: ['accept', 'reject'], description: 'Optional: accept or reject every tracked change in it instead.' },
        },
        required: ['document'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Tracked changes in ${String(a.document ?? 'a document').slice(0, 80)}`,
    run: async (args, ctx) => {
      const e = envOf(getApp, ctx);
      const doc = pick(e, String(args.document ?? ''));
      if (!/\.docx$/i.test(doc.name)) throw new ToolError(`“${doc.name}” isn't a Word document (.docx); tracked changes need one.`);
      const bytes = fileOf(e, doc);
      const prior = madeDocs(e.app).byLibrary(doc.id);
      const title = prior?.title ?? baseName(doc.name);
      if (args.resolve === 'accept' || args.resolve === 'reject') {
        const r = wrapDoc(() => resolveAll(bytes, args.resolve as 'accept' | 'reject'));
        if (!r.resolved) return `“${doc.name}” has no tracked changes.`;
        const spec: DocSpec = { format: 'docx', title, template: 'plain', content: docxToMarkdown(r.data), edited: { kind: 'tracked', fromId: doc.id, fromName: doc.name } };
        return `${args.resolve === 'accept' ? 'Accepted' : 'Rejected'} every tracked change in “${doc.name}”. ${keepAndShare(e, ctx, spec, r.data, doc)}`;
      }
      const changes = wrapDoc(() => changesOf(args.changes));
      const res = wrapDoc(() => reviseDocx(bytes, changes, { date: e.app.now() }));
      const bad = res.applied.filter((a) => a.status !== 'done');
      const badText = bad.length ? `\nNot changed:\n${bad.map((b) => `- ${b.change}: ${b.detail ?? b.status}`).join('\n')}` : '';
      if (!res.revisions && !res.comments) return `No tracked changes were made in “${doc.name}”.${badText}\nQuote the words exactly as the document has them and try again.`;
      const spec: DocSpec = { format: 'docx', title, template: 'plain', content: docxToMarkdown(res.data), edited: { kind: 'tracked', fromId: doc.id, fromName: doc.name } };
      const done = res.applied.filter((a) => a.status === 'done');
      const saved = keepAndShare(e, ctx, spec, res.data, doc);
      const notes = res.comments ? ` and ${res.comments} ${res.comments === 1 ? 'comment' : 'comments'}` : '';
      return `Wrote ${done.length - res.comments} tracked ${done.length - res.comments === 1 ? 'change' : 'changes'}${notes} (${listRevisions(res.data).length} revision marks, author Sara, ${e.app.now().toISOString().slice(0, 10)}):\n${done.map((d) => `- ${d.change}${d.detail ? ` ${d.detail}` : ''}`).join('\n')}${badText}\n${saved} In Word: Review → Accept or Reject each change (comments are in the margin); the Library's Review view shows them too.`;
    },
  };

  const checklist: Tool = {
    spec: {
      name: 'doc_checklist',
      description: "Check a contract, NDA, SOW, proposal, letter or invoice cover against the usual clauses for its kind (contract: parties, term, payment, termination, liability cap, indemnity, confidentiality, IP, governing law, signatures; proposal: scope, timeline, price, assumptions). Each clause is present (with the exact sentence and where), missing, or unusual (with why). Information, not legal advice: say so.",
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The document: its name or Library number.' },
          type: { type: 'string', enum: ['contract', 'nda', 'sow', 'proposal', 'letter', 'invoice'], description: 'Optional: the kind of document (guessed when left out).' },
        },
        required: ['document'],
      },
    },
    defaultPermission: 'auto',
    interruptible: true,
    summarize: (a) => `Clause checklist for ${String(a.document ?? 'a document').slice(0, 80)}`,
    run: async (args, ctx) => {
      const e = envOf(getApp, ctx);
      const doc = pick(e, String(args.document ?? ''));
      const text = await docText(e.app, doc);
      if (!text.trim()) throw new ToolError(`“${doc.name}” has no text to check (a scan? the Library may still be reading it).`);
      const type: DocType = isDocType(args.type) ? args.type : docTemplates(e.app).get(doc.id)?.type ?? guessDocType(doc.name, text);
      return `${checklistText(clauseChecklist(text, type), doc.name)}\nTell them what is missing or unusual first, quoting it; don't call it legal advice.`;
    },
  };

  const toSign: Tool = {
    spec: {
      name: 'doc_to_sign',
      description: "Make the final Word document into a signature-ready PDF: the text with page numbers, and for each signer a signature field, a name field and a date field (fields a PDF reader can sign or type into). First a Ready to sign check: no placeholders left and no tracked changes left; if it fails, no PDF is made (say what to fix) unless draft is true. signers: [{\"party\": \"Acme Corp\", \"name\": \"Pat Doe\", \"title\": \"CEO\"}] (default: the parties named in it).",
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The final Word document: its name or Library number.' },
          signers: { type: 'array', items: { type: 'object' }, description: 'Who signs: [{"party", "name", "title"}].' },
          draft: { type: 'boolean', description: 'Make the PDF even if the check fails (marked not ready).' },
        },
        required: ['document'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Ready to sign: ${String(a.document ?? 'a document').slice(0, 80)}`,
    run: async (args, ctx) => {
      const e = envOf(getApp, ctx);
      const doc = pick(e, String(args.document ?? ''));
      if (!/\.docx$/i.test(doc.name)) throw new ToolError(`“${doc.name}” isn't a Word document (.docx). Make the PDF from the final Word file.`);
      const bytes = fileOf(e, doc);
      const prior = madeDocs(e.app).byLibrary(doc.id);
      const title = prior?.title ?? baseName(doc.name);
      const text = await docText(e.app, doc);
      const signers = signersOf(args.signers, text);
      const r = wrapDoc(() => makeSignPdf({ docx: bytes, title, signers, draft: args.draft === true }));
      const checks = r.checks.map((c) => `- ${c.ok ? '✓' : '✗'} ${c.detail}`).join('\n');
      if (!r.data) return `Not ready to sign: “${doc.name}”\n${checks}\nNo PDF was made. Tell them what to fix (fill the placeholders with doc_from_template, or accept/reject the tracked changes with doc_revise resolve), then try again.`;
      const spec: DocSpec = { format: 'pdf', title, template: 'report', content: docxToMarkdown(bytes), sign: { signers }, edited: { kind: 'sign', fromId: doc.id, fromName: doc.name } };
      const saved = keepAndShare(e, ctx, spec, r.data);
      return `${r.ready ? 'Ready to sign' : 'Not ready to sign (a draft PDF, as asked)'}: “${doc.name}” → PDF, ${r.pages} ${r.pages === 1 ? 'page' : 'pages'}, signers: ${signers.map((s) => s.party).join(', ')}.\n${checks}\n${saved} Each signer signs in the signature field and types the date; any PDF reader that signs forms works.`;
    },
  };
  return [fromTemplate, revise, checklist, toSign];
}

export type { ToolContext };

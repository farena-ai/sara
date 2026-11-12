// fill_document (docs/DOCUMENTS.md): she fills in the person's own form or template (a file they
// uploaded, or one she made) instead of rebuilding it. The values go into a new copy that keeps the
// file's layout and formatting; the original is never changed. The copy is read back with the
// Library's reader before she reports anything, and the result says exactly how many fields were
// filled and which weren't, so she never claims a form is done when it isn't. The copy arrives in
// the chat as the same document card make_document uses (Download, Open, Save to PC).
import type { AppContext } from '../chat.ts';
import { fillFile, fillItems, fillReport } from '../documents/fill.ts';
import { DocError, FORMAT_LABEL, keepMade } from '../documents/make.ts';
import { fileName, LIMITS, MIME, type DocSpec } from '../documents/spec.ts';
import { readDocument } from '../library/read.ts';
import type { LibraryDoc } from '../library/store.ts';
import { minorSexualMatch } from '../safety.ts';
import { shareMade } from './make-document.ts';
import { humanSize } from './send-file.ts';
import { ToolError, type Tool } from './types.ts';

export const FILL_DOCUMENT = 'fill_document';

const FILLABLE = /\.(xlsx|docx|pdf)$/i;

/** The person's document to fill: by number or by (part of) its name; this chat's files first. */
export function findForm(docs: LibraryDoc[], q: string): LibraryDoc {
  const query = q.trim().replace(/^#/, '').toLowerCase();
  const forms = docs.filter((d) => FILLABLE.test(d.name));
  if (!query) {
    const pick = forms.find((d) => FILLABLE.test(d.name));
    if (!pick) throw new ToolError('Say which document to fill in (its name or number). Use the library tool (action list) to see them.');
    return pick;
  }
  if (/^\d+$/.test(query)) {
    const d = docs.find((x) => x.id === Number(query));
    if (d) return d;
  }
  const exact = docs.filter((d) => d.name.toLowerCase() === query || d.name.toLowerCase().replace(/\.[a-z0-9]+$/, '') === query);
  const near = exact.length ? exact : docs.filter((d) => d.name.toLowerCase().includes(query) || (d.title ?? '').toLowerCase().includes(query));
  if (!near.length) throw new ToolError(`No document matching “${q}”. Use the library tool (action list) to see what's there.`);
  const fillable = near.filter((d) => FILLABLE.test(d.name));
  const pool = fillable.length ? fillable : near;
  const names = new Set(pool.map((d) => d.name.toLowerCase()));
  if (names.size > 1) throw new ToolError(`More than one document matches “${q}”: ${pool.slice(0, 8).map((d) => `${d.name} (#${d.id})`).join(', ')}. Say which one (its number).`);
  return pool[0];
}

/** What a filled copy reads as, in Markdown (for the Open preview and to read it again later). */
function contentOf(parts: { text: string; heading?: string; where?: string }[], kind: string): string {
  if (kind !== 'xlsx') return parts.map((p) => p.text).join('\n\n');
  return parts
    .map((p) => {
      const rows = p.text.split('\n').map((r) => r.split(' | ').map((c) => c.replace(/\|/g, '\\|')));
      const width = Math.max(1, ...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return `## ${p.heading ?? p.where ?? 'Sheet'}\n\n${line(rows[0] ?? [])}\n|${' --- |'.repeat(width)}\n${rows.slice(1).map(line).join('\n')}`;
    })
    .join('\n\n');
}

export function createFillDocumentTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: FILL_DOCUMENT,
      description:
        "Fill in the person's own form or template (an Excel .xlsx, Word .docx or fillable PDF form they uploaded, or one you made): writes the values into a new copy of THEIR file, keeping its layout and formatting (the original is not changed), then reads the copy back and reports exactly what was filled. Use this, not make_document, whenever they give you a form, time sheet, application or template to fill in. values: {\"EMPLOYEE NAME\": \"Kent\", \"WEEK OF\": \"11/08/2026\"} (the label as it is in the form; the value goes in the empty cell or blank next to it), or a list with {\"cell\": \"B3\", \"value\": 8} for a spreadsheet cell. For a PDF form use the field names the Library shows under \"Form fields\" (or the words printed next to each box); check boxes take yes/no, choices take one of their options. tables: [{\"table\": \"DAY\", \"rows\": [{\"DAY\": \"SUNDAY\", \"START TIME\": \"2200\", \"END TIME\": \"0600\"}]}] (table = one of its column headers; each row is found by its label in that column). Leave totals that are formulas alone (they work themselves out). Only say the form is filled when the result says every field was filled; otherwise say which weren't.",
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The form to fill: its name (or part of it) or its number in the library. Default: the newest form shared in this chat.' },
          values: { type: 'object', description: 'Label: value pairs, e.g. {"EMPLOYEE NAME": "Kent", "TITLE": "Officer"}. A list of {label, value} or {cell, value, sheet} also works.' },
          tables: { type: 'array', description: 'Rows to fill in a table: [{"table": "DAY", "rows": [{"DAY": "MONDAY", "START TIME": "2200"}]}].', items: { type: 'object' } },
          cells: { type: 'array', description: 'Optional for spreadsheets: [{"cell": "B3", "value": 8}] (or "Sheet1!B3").', items: { type: 'object' } },
          title: { type: 'string', description: 'A title (file name) for the filled copy, e.g. "Time Sheet - Kent - Nov 8".' },
        },
        required: ['document'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Fill in ${String(a.document ?? 'a form').slice(0, 80)}`,
    run: async (args, ctx) => {
      const app = getApp();
      const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
      if (conv?.partner) throw new ToolError("Forms can't be filled in this chat (a chat with another companion or person): ask the owner to ask for it in their own chat with you.");
      const lib = app.library;
      if (!lib) throw new ToolError('There is no library here, so there is no form to fill.');
      const docs = [...(conv ? lib.list({ conversationId: conv.id }) : []), ...lib.list()];
      const doc = findForm(docs, String(args.document ?? ''));
      if (!FILLABLE.test(doc.name)) throw new ToolError(`“${doc.name}” isn't an Excel (.xlsx), Word (.docx) or PDF form, so it can't be filled in here.`);
      const bytes = lib.file(doc);
      if (!bytes) throw new ToolError(`The file for “${doc.name}” isn't here any more; ask for it again.`);
      let items;
      try {
        items = fillItems(args);
      } catch (err) {
        if (err instanceof DocError) throw new ToolError(err.message);
        throw err;
      }
      if (minorSexualMatch(`${String(args.title ?? '')}\n${JSON.stringify(items)}`, { fromHer: true })) throw new ToolError("I won't make that.");
      let res;
      try {
        res = fillFile(doc.name, bytes, items);
      } catch (err) {
        if (err instanceof DocError) throw new ToolError(`${err.message}${/\.pdf$/i.test(doc.name) ? " Don't say it's filled." : ''}`);
        throw new ToolError(`“${doc.name}” couldn't be opened to fill in: ${(err as Error).message}`);
      }
      const report = fillReport(res);
      if (!res.filled) return `${report}\nNothing was filled, so no copy was made. Don't say the form is filled; check the labels above (or use cell addresses) and try again.`;
      if (res.data.length > LIMITS.outBytes) throw new ToolError('The filled copy is too big to keep.');
      const base = doc.name.replace(/\.[a-z0-9]+$/i, '');
      const title = String(args.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\.(xlsx|docx|pdf)$/i, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.titleChars) || `${base} (filled)`;
      const read = await readDocument(fileName(title, res.format), res.data).catch(() => undefined);
      const spec: DocSpec = { format: res.format, title, template: 'plain', content: read ? contentOf(read.parts, res.format) : report, filled: { fromId: doc.id, fromName: doc.name, fields: res.total, filled: res.filled } };
      const made = keepMade(app, { spec, data: res.data, ...(conv ? { conversationId: conv.id } : {}), keep: !conv?.private });
      const shared = shareMade(app, ctx, conv, made, res.data, MIME[res.format]);
      const where = [shared ? 'it is in the chat with Download and Open buttons' : '', made.libraryId ? `it is saved in the Library (document ${made.libraryId})` : ''].filter(Boolean).join(', and ');
      const all = res.filled === res.total;
      return `${report}\nSaved the filled copy as “${made.name}” (${FORMAT_LABEL[res.format]}, ${humanSize(res.data.length)}), document #${made.id}; the original “${doc.name}” is unchanged.${where ? ` ${where[0].toUpperCase()}${where.slice(1)}.` : ''} ${all ? 'Tell them in a sentence that it is filled in.' : `Don't say the form is filled: say which ${res.total - res.filled === 1 ? 'field is' : 'fields are'} not filled and why, and ask for what's missing.`}`;
    },
  };
}

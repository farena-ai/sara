// make_document (docs/DOCUMENTS.md): she makes real files. Word, PDF, Excel, PowerPoint, Markdown,
// CSV or a web page, from Markdown (the one thing every model needs to write) or, for spreadsheets
// and slides, from sheets or slides directly. The file is saved in her Library and arrives in the
// chat as a card with Download, Open and Make changes; chat apps (Telegram, Discord) get the file
// itself. Built in, for the owner and every household member (each in their own space), and it
// works in private local mode: nothing is fetched and nothing leaves the server.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { fileQuotaHit, recordShared, sha256, sharedDir } from '../bridges/media.ts';
import { DocError, FORMAT_LABEL, madeDocs, makeDocument } from '../documents/make.ts';
import { FORMATS, TEMPLATES } from '../documents/spec.ts';
import { minorSexualMatch } from '../safety.ts';
import { humanSize } from './send-file.ts';
import { ToolError, type Tool } from './types.ts';

export const MAKE_DOCUMENT = 'make_document';

export function createMakeDocumentTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: MAKE_DOCUMENT,
      description:
        'Make a real file the owner can download and open: a Word document (docx), PDF, Excel spreadsheet (xlsx), PowerPoint presentation (pptx), Markdown (md), CSV or web page (html). Use it whenever they ask for a document, report, letter, resume/CV, invoice, table, spreadsheet, slides or any file: you CAN make these, so never say you can\'t. Make it right away: if details are missing (a resume for someone you know little about), write a good first draft with [placeholders] to fill in, then say what to fill in. Write content as Markdown: # title, ## headings, paragraphs, **bold**, *italic*, - bullets, 1. numbers, | tables |, > quotes, a line [page break], and pictures from their uploads or library as ![caption](upload:ID) or ![caption](library:ID). Spreadsheets: each Markdown table becomes a sheet (cells starting with = are formulas). Slides: each # or ## heading starts a slide; its bullets are the slide; a line "Notes: …" is the speaker notes. The file arrives in the chat with Download and Open buttons and is kept in the Library. To change a document, call it with basedOn (its number) and the whole new content; call with only basedOn to read its current content first.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: [...FORMATS], description: 'docx (Word), pdf, xlsx (Excel), pptx (PowerPoint), md, csv or html.' },
          title: { type: 'string', description: 'The document title (also its file name).' },
          content: { type: 'string', description: 'The whole document as Markdown.' },
          template: { type: 'string', enum: [...TEMPLATES], description: 'Optional look: report, letter, resume or plain. Picked from the request when left out.' },
          basedOn: { type: 'number', description: 'Optional: the number of a document you made, to make a new version of it.' },
          sheets: { type: 'array', description: 'Optional for xlsx: [{"name":"Budget","rows":[["Item","Cost"],["Rent",1200],["Total","=SUM(B2:B2)"]]}].', items: { type: 'object' } },
          slides: { type: 'array', description: 'Optional for pptx: [{"title":"…","bullets":["…"],"notes":"…","image":"upload:ID"}].', items: { type: 'object' } },
        },
        required: ['format'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Make ${String(a.title ?? 'a document').slice(0, 100)} (${String(a.format ?? '?')})`,
    run: async (args, ctx) => {
      const app = getApp();
      const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
      if (conv?.partner) throw new ToolError("Documents can't be made in this chat.");
      const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== '' && !(Array.isArray(args[k]) && !(args[k] as unknown[]).length);
      // Read a document's content first (to change it).
      if (has('basedOn') && !has('content') && !has('sheets') && !has('slides')) {
        const m = madeDocs(app).get(Number(args.basedOn));
        if (!m) throw new ToolError(`There is no document #${String(args.basedOn)} here.`);
        const extra = m.spec.sheets ? `\nSheets (JSON): ${JSON.stringify(m.spec.sheets).slice(0, 20_000)}` : m.spec.slides ? `\nSlides (JSON): ${JSON.stringify(m.spec.slides).slice(0, 20_000)}` : '';
        return `Document #${m.id} “${m.title}” (${FORMAT_LABEL[m.format]}, version ${m.version}). Its content now:\n\n${m.spec.content.slice(0, 60_000)}${extra}\n\nTo change it, call make_document with basedOn: ${m.id} and the whole changed content.`;
      }
      const text = `${String(args.title ?? '')}\n${String(args.content ?? '').slice(0, 200_000)}`;
      if (minorSexualMatch(text, { fromHer: true })) throw new ToolError("I won't make that.");
      let out;
      try {
        out = makeDocument(app, args, { ...(conv ? { conversationId: conv.id } : {}), keep: !conv?.private });
      } catch (err) {
        if (err instanceof DocError) throw new ToolError(err.message);
        throw err;
      }
      const { made, data, mime } = out;
      // The chat card (and the real file in Telegram, Discord and plugin chats).
      let shared = false;
      if (conv && ctx.attachFile && !fileQuotaHit(app, data.length)) {
        const hash = sha256(data);
        const copy = join(sharedDir(app), hash);
        if (!existsSync(copy)) writeFileSync(copy, data, { mode: 0o600 });
        const keep = (app.settings.get() as { chats?: { media?: { sentKeepDays?: number } } }).chats?.media?.sentKeepDays;
        const days = [7, 30, 90].includes(Number(keep)) ? Number(keep) : 30;
        const ch = conv.channel;
        const id = recordShared(app, { conversationId: conv.id, direction: 'out', bridge: ch.startsWith('telegram') ? 'telegram' : ch.startsWith('discord') ? 'discord' : ch.startsWith('plugin-') ? ch : 'web', chatKey: conv.channelKey ?? conv.id, sender: 'her', kind: 'file', name: made.name, mime, bytes: data.length, path: copy, status: 'ok', expiresAt: new Date(app.now().getTime() + days * 86_400_000).toISOString() });
        ctx.attachFile({ id, name: made.name, mime, bytes: data.length, made: { id: made.id, format: made.format, version: made.version, title: made.title } });
        shared = true;
      }
      const where = [shared ? 'it is in the chat with Download, Open and Make changes buttons' : '', made.libraryId ? `it is saved in the Library (document ${made.libraryId})` : ''].filter(Boolean).join(', and ');
      return `Made “${made.title}” as a ${FORMAT_LABEL[made.format]} (${made.name}, ${humanSize(data.length)}), document #${made.id}${made.version > 1 ? `, version ${made.version}` : ''}.${where ? ` ${where[0].toUpperCase()}${where.slice(1)}.` : ''} Tell the owner in a sentence; don't paste the content again. To change it later, call make_document with basedOn: ${made.id}.`;
    },
  };
}

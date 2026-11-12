// The front door for reading documents into her library. detectKind() works out what a file
// is (by its first bytes, then by its name), and readDocument() turns it into text parts in
// reading order, plus any page pictures that need a vision model (scanned pages and photos).
// Every reader is written from scratch here; nothing comes from npm.

import { readEpub } from './epub.ts';
import { type Block, blocksToParts, htmlToText } from './html.ts';
import { readDocx, readPptx, readXlsx } from './ooxml.ts';
import { formFieldsText } from '../documents/pdf-form.ts';
import { readPdf } from './pdf.ts';
import { openZip } from './zip.ts';

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'html' | 'markdown' | 'text' | 'csv' | 'image';
export interface DocPart {
  text: string;
  where: string; // 'page 4' | 'sheet Budget' | 'slide 3' | 'chapter 2' | ''
  heading?: string; // the nearest section heading, if known
}
export interface PageImage {
  where: string;
  mime: 'image/jpeg' | 'image/png';
  data: Buffer;
}
export interface ReadResult {
  kind: DocKind;
  title?: string;
  parts: DocPart[];
  images: PageImage[];
  warnings: string[];
}

/** A problem worth telling the owner about, in words a beginner understands. */
export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadError';
  }
}

export const SUPPORTED: { kind: DocKind; exts: string[]; label: string }[] = [
  { kind: 'pdf', exts: ['.pdf'], label: 'PDF' },
  { kind: 'docx', exts: ['.docx', '.docm', '.dotx'], label: 'Word document' },
  { kind: 'xlsx', exts: ['.xlsx', '.xlsm', '.xltx'], label: 'Excel spreadsheet' },
  { kind: 'pptx', exts: ['.pptx', '.pptm', '.potx'], label: 'PowerPoint presentation' },
  { kind: 'epub', exts: ['.epub'], label: 'EPUB e-book' },
  { kind: 'html', exts: ['.html', '.htm', '.xhtml'], label: 'Web page' },
  { kind: 'markdown', exts: ['.md', '.markdown'], label: 'Markdown' },
  { kind: 'text', exts: ['.txt', '.text', '.log'], label: 'Plain text' },
  { kind: 'csv', exts: ['.csv', '.tsv'], label: 'CSV table' },
  { kind: 'image', exts: ['.jpg', '.jpeg', '.png', '.webp'], label: 'Photo of a page' },
];

function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

function kindFromExt(name: string): DocKind | undefined {
  const ext = extOf(name);
  return ext ? SUPPORTED.find((s) => s.exts.includes(ext))?.kind : undefined;
}

function startsWith(b: Buffer, ...bytes: number[]): boolean {
  return b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
}

function isWebp(b: Buffer): boolean {
  return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
}

function isOle(b: Buffer): boolean {
  return startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
}

/** What kind of document this is: magic bytes first, the file name second. */
export function detectKind(name: string, bytes: Buffer): DocKind | undefined {
  const head = bytes.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, 0xff, 0xd8, 0xff) || startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || isWebp(bytes)) return 'image';
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) || startsWith(bytes, 0x50, 0x4b, 0x05, 0x06)) {
    try {
      const zip = openZip(bytes);
      if (zip.has('mimetype') && (zip.text('mimetype') ?? '').trim() === 'application/epub+zip') return 'epub';
      if (zip.has('META-INF/container.xml') && !zip.has('[Content_Types].xml')) return 'epub';
      if (zip.has('[Content_Types].xml')) {
        if (zip.has('word/document.xml')) return 'docx';
        if (zip.has('xl/workbook.xml')) return 'xlsx';
        if (zip.has('ppt/presentation.xml')) return 'pptx';
        const ct = zip.text('[Content_Types].xml') ?? '';
        if (ct.includes('wordprocessingml')) return 'docx';
        if (ct.includes('spreadsheetml')) return 'xlsx';
        if (ct.includes('presentationml')) return 'pptx';
      }
    } catch {
      // A damaged zip: fall back to the name.
    }
    const k = kindFromExt(name);
    return k === 'docx' || k === 'xlsx' || k === 'pptx' || k === 'epub' ? k : undefined;
  }
  const byExt = kindFromExt(name);
  if (byExt && byExt !== 'pdf' && byExt !== 'image' && !['docx', 'xlsx', 'pptx', 'epub'].includes(byExt)) return byExt;
  if (byExt) return undefined; // the name says PDF/Office/photo, but the bytes don't match
  // No useful name: sniff text.
  if (isOle(bytes) || bytes.subarray(0, 4096).includes(0)) {
    if (!startsWith(bytes, 0xff, 0xfe) && !startsWith(bytes, 0xfe, 0xff)) return undefined;
  }
  const sample = decodeText(bytes.subarray(0, 4096)).trimStart().toLowerCase();
  if (sample.startsWith('<!doctype html') || sample.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(sample)) return 'html';
  return 'text';
}

/** Decodes text files: UTF-8 (BOM stripped), UTF-16 with a BOM, else Windows-1252. */
export function decodeText(b: Buffer): string {
  if (startsWith(b, 0xef, 0xbb, 0xbf)) return b.subarray(3).toString('utf8');
  if (startsWith(b, 0xff, 0xfe)) return b.subarray(2).toString('utf16le');
  if (startsWith(b, 0xfe, 0xff)) return Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))).swap16().toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(b);
    } catch {
      return b.toString('latin1');
    }
  }
}

function decodeHtmlBytes(b: Buffer): string {
  if (startsWith(b, 0xef, 0xbb, 0xbf) || startsWith(b, 0xff, 0xfe) || startsWith(b, 0xfe, 0xff)) return decodeText(b);
  const m = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(b.subarray(0, 4096).toString('latin1'));
  const label = m?.[1].toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(b);
    } catch {
      // Unknown label: fall through to the usual guess.
    }
  }
  return decodeText(b);
}

// ---------------------------------------------------------------- Markdown, text, CSV

function markdownBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let fence = '';
  const flush = (): void => {
    const t = para.join('\n').replace(/\s+$/, '');
    if (t.trim()) blocks.push({ text: t });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      para.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) {
        fence = '';
        flush();
      }
      continue;
    }
    if (f) {
      flush();
      fence = f[1];
      para.push(line);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      if (h[2]) blocks.push({ text: h[2], level: h[1].length });
      continue;
    }
    // Setext headings: a line underlined with === or ---.
    const next = lines[i + 1];
    if (para.length === 0 && line.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) {
      blocks.push({ text: line.trim(), level: next.trim()[0] === '=' ? 1 : 2 });
      i++;
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return blocks;
}

function textBlocks(src: string): Block[] {
  return src
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p.trim())
    .map((text) => ({ text }));
}

/** Splits CSV text into rows of cells, honouring quotes ("a, b" and doubled "" quotes). */
export function parseCsv(src: string, delimiter?: string): string[][] {
  const text = src.replace(/^\ufeff/, '');
  if (!delimiter) {
    const first = text.slice(0, text.search(/\r?\n|$/));
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const);
    counts.sort((a, b) => b[1] - a[1]);
    delimiter = counts[0][1] > 1 ? counts[0][0] : ',';
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else cell += c;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function readCsv(src: string, tab: boolean): ReadResult {
  const rows = parseCsv(src, tab ? '\t' : undefined)
    .map((r) => r.map((c) => c.replace(/\s*\r?\n\s*/g, ' ').trim()))
    .filter((r) => r.some((c) => c));
  const parts: DocPart[] = [];
  const per = 2000;
  const header = rows[0]?.join(' | ');
  for (let k = 0; k < rows.length; k += per) {
    const chunk = rows.slice(k, k + per).map((r) => r.join(' | '));
    const where = rows.length > per ? `rows ${k + 1}-${Math.min(rows.length, k + per)}` : '';
    parts.push(header && k > 0 ? { text: chunk.join('\n'), where, heading: header } : { text: chunk.join('\n'), where });
  }
  return { kind: 'csv', parts, images: [], warnings: parts.length ? [] : ['This table is empty.'] };
}

// ---------------------------------------------------------------- the front door

function capChars(result: ReadResult, maxChars: number): ReadResult {
  let total = 0;
  const kept: DocPart[] = [];
  for (const p of result.parts) {
    if (total + p.text.length > maxChars) {
      const room = maxChars - total;
      if (room > 200) kept.push({ ...p, text: p.text.slice(0, room) });
      result.warnings.push(`This document is very long, so she only read the first ${maxChars.toLocaleString('en-US')} characters.`);
      result.parts = kept;
      return result;
    }
    kept.push(p);
    total += p.text.length;
  }
  return result;
}

/** Reads a document into text parts (and page pictures for anything that needs a vision model). */
export async function readDocument(name: string, bytes: Buffer, opts: { signal?: AbortSignal; maxChars?: number } = {}): Promise<ReadResult> {
  const maxChars = opts.maxChars ?? 5_000_000;
  if (opts.signal?.aborted) throw new ReadError('Reading was stopped before it finished.');
  if (!bytes.length) throw new ReadError('This file is empty.');
  const kind = detectKind(name, bytes);
  if (!kind) {
    const ext = extOf(name);
    if (isOle(bytes) && ['.docx', '.xlsx', '.pptx'].includes(ext)) throw new ReadError('This Office file is locked with a password, so she can\'t read it. Remove the password in Office and add it again.');
    if (isOle(bytes) || ['.doc', '.xls', '.ppt'].includes(ext)) throw new ReadError('This is an older Office file (.doc, .xls or .ppt). Open it in Office and save it as .docx, .xlsx or .pptx, then add it again.');
    if (kindFromExt(name)) throw new ReadError(`This file is named like a ${SUPPORTED.find((s) => s.kind === kindFromExt(name))!.label}, but it isn't one inside. It may be damaged.`);
    throw new ReadError('She can\'t read this kind of file yet. She can read PDFs, Word, Excel, PowerPoint, EPUB, web pages, Markdown, text and CSV files, and photos of pages.');
  }
  let result: ReadResult;
  try {
    switch (kind) {
      case 'pdf':
        result = await readPdf(bytes, { signal: opts.signal, maxChars });
        {
          // A fillable form: its field names and values, so fill_document can be given the right names.
          const fields = formFieldsText(bytes);
          if (fields) result.parts.push({ text: fields, where: 'form fields' });
        }
        break;
      case 'docx':
        result = readDocx(openZip(bytes), opts);
        break;
      case 'xlsx':
        result = readXlsx(openZip(bytes), opts);
        break;
      case 'pptx':
        result = readPptx(openZip(bytes), opts);
        break;
      case 'epub':
        result = readEpub(openZip(bytes), opts);
        break;
      case 'html': {
        const { title, blocks } = htmlToText(decodeHtmlBytes(bytes));
        result = { kind, title, parts: blocksToParts(blocks), images: [], warnings: [] };
        break;
      }
      case 'markdown':
        result = { kind, parts: blocksToParts(markdownBlocks(decodeText(bytes))), images: [], warnings: [] };
        break;
      case 'text':
        result = { kind, parts: blocksToParts(textBlocks(decodeText(bytes))), images: [], warnings: [] };
        break;
      case 'csv':
        result = readCsv(decodeText(bytes), extOf(name) === '.tsv');
        break;
      case 'image': {
        if (isWebp(bytes)) throw new ReadError('She can\'t pass WebP pictures on yet. Save the picture as JPEG or PNG and add it again.');
        const mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
        result = { kind, parts: [], images: [{ where: '', mime, data: bytes }], warnings: [] };
        break;
      }
    }
  } catch (err) {
    if (err instanceof ReadError) throw err;
    // Anything unexpected inside a reader means the file is malformed in a way we didn't plan for.
    throw new ReadError('This file looks damaged, so she couldn\'t read it.');
  }
  if (!result.parts.length && !result.images.length && !['image'].includes(kind) && !result.warnings.length) {
    result.warnings.push('She found no text in this file.');
  }
  return capChars(result, maxChars);
}

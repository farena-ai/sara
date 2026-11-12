// make_document (docs/DOCUMENTS.md): what a document is made from, checked. A model sends a format,
// a title and Markdown (every format takes Markdown, so the smallest model only needs that); a
// capable one may send spreadsheet sheets or slides directly. The caps keep a document small enough
// to make in memory on an old server, and the checks keep it inert: no macros (only .docx, .xlsx and
// .pptx, never the macro kinds), no external links in formulas, nothing fetched from the internet.
import { type Block, inline, parseMarkdown, plain, type Run } from './markdown.ts';

export const FORMATS = ['docx', 'pdf', 'xlsx', 'pptx', 'md', 'csv', 'html'] as const;
export type DocFormat = (typeof FORMATS)[number];
export const TEMPLATES = ['plain', 'report', 'letter', 'resume'] as const;
export type Template = (typeof TEMPLATES)[number];

export const LIMITS = {
  titleChars: 150,
  contentChars: 200_000,
  sheets: 12,
  rowsPerSheet: 5000,
  cols: 60,
  cells: 100_000,
  cellChars: 4000,
  slides: 60,
  bulletsPerSlide: 14,
  images: 12,
  /** The finished file. */
  outBytes: 25 * 1024 * 1024,
} as const;

export const EXT: Record<DocFormat, string> = { docx: 'docx', pdf: 'pdf', xlsx: 'xlsx', pptx: 'pptx', md: 'md', csv: 'csv', html: 'html' };
export const MIME: Record<DocFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

export class DocError extends Error {}

export type Cell = string | number | boolean | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
  /** The table's header row (0-based; default 0) when label rows come above it. */
  head?: number;
  /** How many rows the table has, header included (default: to the end). */
  tableRows?: number;
}
export interface SlideLine {
  runs: Run[];
  depth: number;
  bullet: boolean;
}
export interface Slide {
  title: string;
  subtitle?: string;
  lines: SlideLine[];
  notes?: string;
  image?: string;
  /** The opening slide (big centered title). */
  cover?: boolean;
}
export interface DocSpec {
  format: DocFormat;
  title: string;
  template: Template;
  /** The Markdown (also kept for spreadsheets and slides: \"Make changes\" starts from it). */
  content: string;
  sheets?: Sheet[];
  slides?: Slide[];
  /** fill_document: this file is the person's own form filled in (content is what the copy reads as). */
  filled?: { fromId: number; fromName: string; fields: number; filled: number };
}

/** A picture from her library or uploads, ready to place. */
export interface Picture {
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  bytes: Buffer;
  width: number;
  height: number;
}
export type ImageLookup = (ref: string) => Picture | undefined;

const FORMAT_WORDS: Record<string, DocFormat> = { word: 'docx', doc: 'docx', docx: 'docx', pdf: 'pdf', excel: 'xlsx', xls: 'xlsx', xlsx: 'xlsx', spreadsheet: 'xlsx', sheet: 'xlsx', powerpoint: 'pptx', ppt: 'pptx', pptx: 'pptx', slides: 'pptx', presentation: 'pptx', deck: 'pptx', markdown: 'md', md: 'md', csv: 'csv', html: 'html', web: 'html' };

export function formatOf(v: unknown): DocFormat {
  const s = String(v ?? '').trim().toLowerCase().replace(/^\./, '');
  const f = (FORMATS as readonly string[]).includes(s) ? (s as DocFormat) : FORMAT_WORDS[s];
  if (!f) throw new DocError(`Pick a format: ${FORMATS.join(', ')}.`);
  return f;
}

/** The template a request plainly asks for (a letter, a report, a resume), else \"plain\". */
export function guessTemplate(title: string, content: string): Template {
  const head = `${title}\n${content.slice(0, 1500)}`.toLowerCase();
  // A resume only by its title (a report may well have a "Résumé" section).
  const named = `${title}\n${/^#\s+(.+)$/m.exec(content)?.[1] ?? ''}`.toLowerCase();
  if (/(?<![\p{L}])(r[eé]sum[eé]|curriculum vitae|cv|lebenslauf|curr[ií]culo|curriculum)(?![\p{L}])/u.test(named)) return 'resume';
  if (/\b(letter|cover letter|carta|lettre|brief|lettera)\b/.test(title.toLowerCase()) || /^(dear|to whom it may concern|estimad[oa]|cher|ch[eè]re|sehr geehrte|liebe|prezad[oa]|gentile|caro|cara)\b/im.test(content.slice(0, 600)) || /\n(sincerely|best regards|kind regards|yours truly|atentamente|cordialement|mit freundlichen gr[uü](ss|ß)en|atenciosamente|cordiali saluti)[,.]?\s*\n/i.test(content)) return 'letter';
  if (/\b(report|summary|analysis|overview|history|guide|plan|proposal|informe|rapport|bericht|relat[oó]rio|relazione)\b/.test(head)) return 'report';
  return 'plain';
}

const cleanTitle = (v: unknown, fallback: string): string =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.titleChars) || fallback;

/** A file name for the title (no path characters), with its version and extension. */
export function fileName(title: string, format: DocFormat, version = 1): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[. ]+$/, '') || 'Document';
  return `${base}${version > 1 ? ` (v${version})` : ''}.${EXT[format]}`;
}

/** A formula she may put in a spreadsheet: the sheet's own cells and functions, nothing outside. */
const BAD_FORMULA = /\[|\||https?:|\\\\|\b(WEBSERVICE|FILTERXML|RTD|CALL|REGISTER(\.ID)?|EXEC|DDE|DDEAUTO|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTRANGE|IMPORTFEED|IMAGE|INFO|CELL)\s*\(/i;
export function checkFormula(f: string): string {
  const s = f.trim();
  if (s.length > 1000) throw new DocError('A formula can be up to 1000 characters.');
  if (BAD_FORMULA.test(s)) throw new DocError(`This formula reaches outside the spreadsheet, so I won't add it: ${s.slice(0, 80)}`);
  return s;
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** A table cell's text as a value: numbers as numbers, \"=…\" as a formula. */
export function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  const s = String(v).slice(0, LIMITS.cellChars);
  const t = s.trim();
  if (NUMBER.test(t)) return Number(t.replace(/,/g, ''));
  if (t.startsWith('=') && t.length > 1) return `=${checkFormula(t.slice(1))}`;
  return s;
}

function cleanSheets(v: unknown): Sheet[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  if (v.length > LIMITS.sheets) throw new DocError(`A spreadsheet can have up to ${LIMITS.sheets} sheets.`);
  let cells = 0;
  const names = new Set<string>();
  return v.map((s, i) => {
    const o = (s && typeof s === 'object' ? s : {}) as { name?: unknown; rows?: unknown };
    let name = String(o.name ?? '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    names.add(name.toLowerCase());
    const rows = Array.isArray(o.rows) ? o.rows : [];
    if (rows.length > LIMITS.rowsPerSheet) throw new DocError(`A sheet can have up to ${LIMITS.rowsPerSheet} rows.`);
    return {
      name,
      rows: rows.map((r) => {
        const row = Array.isArray(r) ? r : [r];
        if (row.length > LIMITS.cols) throw new DocError(`A row can have up to ${LIMITS.cols} columns.`);
        cells += row.length;
        if (cells > LIMITS.cells) throw new DocError(`A spreadsheet can have up to ${LIMITS.cells} cells.`);
        return row.map(cellValue);
      }),
    };
  });
}

function cleanSlides(v: unknown): Slide[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  if (v.length > LIMITS.slides) throw new DocError(`A presentation can have up to ${LIMITS.slides} slides.`);
  return v.map((s) => {
    const o = (s && typeof s === 'object' ? s : {}) as { title?: unknown; bullets?: unknown; notes?: unknown; image?: unknown; subtitle?: unknown };
    const bullets = (Array.isArray(o.bullets) ? o.bullets : typeof o.bullets === 'string' ? o.bullets.split('\n') : []).map(String).filter((b) => b.trim());
    if (bullets.length > LIMITS.bulletsPerSlide * 2) throw new DocError(`A slide can have up to ${LIMITS.bulletsPerSlide * 2} bullets.`);
    const image = o.image ? imageOf(String(o.image)) : undefined;
    return {
      title: cleanTitle(o.title, ''),
      ...(o.subtitle ? { subtitle: String(o.subtitle).slice(0, 300) } : {}),
      lines: bullets.map((b) => {
        const depth = Math.min(2, Math.floor((b.length - b.trimStart().length) / 2));
        return { runs: inline(b.trim().replace(/^[-*•]\s+/, '')), depth, bullet: true };
      }),
      ...(o.notes ? { notes: String(o.notes).slice(0, 4000) } : {}),
      ...(image ? { image } : {}),
    };
  });
}
const imageOf = (s: string): string | undefined => {
  const m = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(s.trim());
  const src = m ? m[1] : s;
  if (/^upload:|^library:|^[a-f0-9]{32}\./i.test(src.trim())) return src.trim().replace(/^([a-f0-9]{32}\.)/i, 'upload:$1');
  return undefined;
};

/** The model's arguments as a checked spec; throws a DocError the model can act on. */
export function cleanSpec(args: Record<string, unknown>): DocSpec {
  const format = formatOf(args.format);
  const content = typeof args.content === 'string' ? args.content.replace(/\r\n?/g, '\n') : '';
  if (content.length > LIMITS.contentChars) throw new DocError(`That's too long for one document (up to ${LIMITS.contentChars.toLocaleString('en-US')} characters).`);
  const sheets = cleanSheets(args.sheets);
  const slides = cleanSlides(args.slides);
  if (!content.trim() && !sheets && !slides) throw new DocError('Put the document in content, as Markdown (headings with #, lists with -, tables with |).');
  // A title given as a file name ("Pat_Resume.docx") loses its extension.
  const title = cleanTitle(String(args.title ?? '').replace(/\.(docx?|pdf|xlsx?|pptx?|md|markdown|csv|html?|txt)$/i, ''), cleanTitle(/^#\s+(.+)$/m.exec(content)?.[1], 'Document'));
  const t = String(args.template ?? '').toLowerCase();
  const template = (TEMPLATES as readonly string[]).includes(t) ? (t as Template) : guessTemplate(title, content);
  if (content.includes('|')) checkTables(content);
  const images = (content.match(/!\[[^\]]*\]\((upload|library):/gi) ?? []).length + (slides?.filter((s) => s.image).length ?? 0);
  if (images > LIMITS.images) throw new DocError(`A document can have up to ${LIMITS.images} pictures.`);
  return { format, title, template, content, ...(sheets ? { sheets } : {}), ...(slides ? { slides } : {}) };
}

/** A table row with more cells than its header would shift every value after it (totals land in the wrong column). */
function checkTables(content: string): void {
  for (const b of parseMarkdown(content)) {
    if (b.t !== 'table') continue;
    const bad = b.rows.findIndex((r) => r.length > b.head.length);
    if (bad >= 0) {
      const name = plain(b.head[0] ?? []).trim();
      throw new DocError(`Row ${bad + 1} of a table${name ? ` (the one starting "${name.slice(0, 40)}")` : ''} has ${b.rows[bad].length} cells but its header has ${b.head.length} columns. Put each value under its own column (leave a cell empty with | |) so nothing shifts, and send it again.`);
    }
  }
}

/** A line "**Label:** value" or "Label: value" as two cells; other lines as one. */
function lineCells(line: Run[]): Cell[] {
  const text = plain(line).trim();
  if (!text) return [];
  const first = line[0];
  if (first?.bold) {
    const label = first.text.trim();
    const rest = plain(line.slice(1)).trim();
    if (label.endsWith(':') && rest) return [label, cellValue(rest)];
    if (rest.startsWith(':') && rest.slice(1).trim()) return [`${label}:`, cellValue(rest.slice(1).trim())];
  }
  const m = /^([^:|]{1,40}):\s+(\S.*)$/.exec(text);
  if (m && !/^https?$/i.test(m[1].trim())) return [`${m[1].trim()}:`, cellValue(m[2])];
  return [cellValue(text)];
}

/** The blocks to lay out: the title is the first heading unless the Markdown starts with one. */
export function docBlocks(spec: DocSpec): Block[] {
  const blocks = parseMarkdown(spec.content, { keepLines: spec.template === 'letter' || spec.template === 'resume' });
  if (spec.template === 'letter') return blocks;
  const first = blocks.find((b) => b.t !== 'break');
  if (first?.t === 'h' && first.level === 1) return blocks;
  return [{ t: 'h', level: 1, runs: [{ text: spec.title }] }, ...blocks];
}

/** The section level of a heading: # (when not the title) and ## are sections, ### a subsection. */
export const sectionLevel = (level: 1 | 2 | 3): 1 | 2 => (level === 3 ? 2 : 1);

/**
 * Sheets for a spreadsheet (or a CSV): given ones, else the Markdown's tables, else its lines. Label
 * lines around a table ("**EMPLOYEE NAME:** Kent") go on its sheet, above or below it, as label | value cells.
 */
export function sheetsOf(spec: DocSpec): Sheet[] {
  if (spec.sheets?.length) return spec.sheets;
  const blocks = parseMarkdown(spec.content, { keepLines: true });
  const out: Sheet[] = [];
  let heading = '';
  const names = new Set<string>();
  let cells = 0;
  let pending: Cell[][] = [];
  const linesOf = (runs: Run[]): Run[][] => {
    const lines: Run[][] = [[]];
    for (const r of runs) {
      const parts = r.text.split('\n');
      parts.forEach((t, i) => {
        if (i) lines.push([]);
        if (t) lines[lines.length - 1].push({ ...r, text: t });
      });
    }
    return lines;
  };
  for (const b of blocks) {
    if (b.t === 'h') heading = plain(b.runs);
    if (b.t === 'p' || b.t === 'li' || b.t === 'quote') for (const l of linesOf(b.runs)) {
      // Label lines ("EMPLOYEE NAME: Kent") go on the sheet; other prose stays in the Markdown only.
      const row = lineCells(l);
      if (row.length === 2) pending.push(row);
    }
    if (b.t !== 'table') continue;
    if (out.length >= LIMITS.sheets) break;
    let name = (heading || `Sheet${out.length + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${out.length + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${out.length + 1}`;
    names.add(name.toLowerCase());
    const table = [b.head, ...b.rows].map((r) => r.map((c) => cellValue(plain(c))));
    const above = pending.length ? [...pending, []] : [];
    pending = [];
    const rows = [...above, ...table];
    cells += rows.reduce((n, r) => n + r.length, 0);
    if (cells > LIMITS.cells || rows.length > LIMITS.rowsPerSheet) throw new DocError('That table is too big for one spreadsheet.');
    out.push({ name, rows, ...(above.length ? { head: above.length } : {}), tableRows: table.length });
  }
  if (out.length) {
    if (pending.length) out[out.length - 1].rows.push([], ...pending);
    return out;
  }
  const lines = blocks.flatMap((b) => (b.t === 'h' ? [[cellValue(plain(b.runs))]] : b.t === 'p' || b.t === 'li' || b.t === 'quote' ? linesOf(b.runs).map(lineCells) : b.t === 'code' ? b.text.split('\n').map((l) => [cellValue(l)]) : [])).filter((r) => r.length).slice(0, LIMITS.rowsPerSheet);
  return [{ name: 'Sheet1', rows: lines.length ? lines : [[cellValue(spec.content.trim())]] }];
}

/** Slides for a presentation: given ones, else one per # / ## heading of the Markdown. */
export function slidesOf(spec: DocSpec): Slide[] {
  if (spec.slides?.length) return spec.slides.map((s, i) => (i === 0 && !s.lines.length && !s.image ? { ...s, cover: true } : s));
  const blocks = parseMarkdown(spec.content);
  const slides: Slide[] = [];
  let cur: Slide | undefined;
  const start = (title: string) => {
    cur = { title, lines: [] };
    slides.push(cur);
  };
  blocks.forEach((b, i) => {
    if (b.t === 'h' && (b.level <= 2 || !cur)) {
      start(plain(b.runs));
      if (i === 0 && b.level === 1) cur!.cover = true;
      return;
    }
    if (!cur) start(slides.length ? '' : spec.title);
    const s = cur!;
    const notes = (text: string) => (s.notes = s.notes ? `${s.notes}\n${text}` : text);
    if (b.t === 'h') s.lines.push({ runs: b.runs.map((r) => ({ ...r, bold: true })), depth: 0, bullet: false });
    else if (b.t === 'li') s.lines.push({ runs: b.runs, depth: b.depth, bullet: true });
    else if (b.t === 'p' || b.t === 'quote') {
      const txt = plain(b.runs);
      const m = /^(speaker )?notes?:\s*(.*)$/i.exec(txt);
      if (m) notes(m[2]);
      else if (b.t === 'quote') notes(txt);
      else if (s.cover && !s.subtitle && !s.lines.length) s.subtitle = txt;
      else s.lines.push({ runs: b.runs, depth: 0, bullet: false });
    } else if (b.t === 'img' && !s.image) s.image = b.ref;
    else if (b.t === 'table') for (const r of [b.head, ...b.rows]) s.lines.push({ runs: [{ text: r.map(plain).join('  ·  ') }], depth: 0, bullet: true });
    else if (b.t === 'code') s.lines.push({ runs: [{ text: b.text, code: true }], depth: 0, bullet: false });
  });
  if (!slides.length) start(spec.title);
  if (slides.length > LIMITS.slides) throw new DocError(`A presentation can have up to ${LIMITS.slides} slides.`);
  return slides;
}

// Readers for Microsoft Office files (Word .docx, Excel .xlsx, PowerPoint .pptx). They are all
// zip archives full of XML. Word paragraphs and tables keep their order and headings; each Excel
// sheet becomes one part with rows of " | "-joined cells; each PowerPoint slide becomes one part
// with its title first and any speaker notes at the end.

import { type Block, blocksToParts } from './html.ts';
import type { DocPart, ReadResult } from './read.ts';
import { ReadError } from './read.ts';
import { attr, find, findAll, kid, kids, localName, parseXml, scanXml, StopScan, textOf, type XmlElement } from './xml.ts';
import type { Zip } from './zip.ts';

export interface OoxmlOptions {
  signal?: AbortSignal;
  maxRowsPerSheet?: number;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReadError('Reading was stopped before it finished.');
}

/** The document title from docProps/core.xml, if the author set one. */
export function coreTitle(zip: Zip): string | undefined {
  const xml = zip.text('docProps/core.xml');
  if (!xml) return undefined;
  const t = textOf(find(parseXml(xml), 'title')).trim();
  return t || undefined;
}

/** Relationship id -> target path (resolved against the part's folder). */
export function readRels(zip: Zip, partPath: string): Map<string, { target: string; type: string }> {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash + 1);
  const relsPath = dir + '_rels/' + partPath.slice(slash + 1) + '.rels';
  const out = new Map<string, { target: string; type: string }>();
  const xml = zip.text(relsPath);
  if (!xml) return out;
  for (const r of findAll(parseXml(xml), 'Relationship')) {
    const id = r.attrs.Id;
    const target = r.attrs.Target;
    if (!id || !target || r.attrs.TargetMode === 'External') continue;
    out.set(id, { target: resolvePath(dir, target), type: r.attrs.Type ?? '' });
  }
  return out;
}

export function resolvePath(dir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : dir + target;
  const out: string[] = [];
  for (const seg of decodeURIComponentSafe(raw).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function requireXml(zip: Zip, path: string, what: string): XmlElement {
  const xml = zip.text(path);
  if (xml === undefined) throw new ReadError(`This ${what} file is missing its main content, so it may be damaged.`);
  return parseXml(xml);
}

// ---------------------------------------------------------------- Word

interface WordStyles {
  headingLevel: Map<string, number>;
}

function readWordStyles(zip: Zip): WordStyles {
  const headingLevel = new Map<string, number>();
  const xml = zip.text('word/styles.xml');
  if (xml) {
    for (const s of findAll(parseXml(xml), 'style')) {
      const id = attr(s, 'styleId');
      if (!id) continue;
      const name = (attr(kid(s, 'name'), 'val') ?? '').toLowerCase();
      const outline = attr(find(s, 'outlineLvl'), 'val');
      let level: number | undefined;
      const m = /^heading\s*(\d)$/.exec(name);
      if (m) level = Number(m[1]);
      else if (name === 'title') level = 1;
      else if (outline !== undefined && Number(outline) < 9) level = Number(outline) + 1;
      if (level) headingLevel.set(id, Math.min(6, level));
    }
  }
  return { headingLevel };
}

function styleHeading(styles: WordStyles, id: string | undefined): number | undefined {
  if (!id) return undefined;
  const known = styles.headingLevel.get(id);
  if (known) return known;
  const m = /^heading(\d)$/i.exec(id);
  if (m) return Math.min(6, Number(m[1]));
  if (/^title$/i.test(id)) return 1;
  return undefined;
}

/** Collects the visible text of a run container (paragraph, hyperlink, insertion...). */
function wordRunText(el: XmlElement, out: string[], boxes: XmlElement[]): void {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    switch (c.local) {
      case 't':
        out.push(textOf(c));
        break;
      case 'tab':
        if (el.local === 'r') out.push('\t');
        break;
      case 'br':
      case 'cr':
        out.push(attr(c, 'type') === 'page' ? '\n' : '\n');
        break;
      case 'noBreakHyphen':
        out.push('-');
        break;
      case 'sym': {
        const ch = attr(c, 'char');
        if (ch && /^[0-9a-fA-F]{2,4}$/.test(ch)) {
          const code = parseInt(ch, 16);
          if (code >= 0x20 && code < 0xf000) out.push(String.fromCharCode(code));
        }
        break;
      }
      case 'del':
      case 'delText':
      case 'instrText':
      case 'pPr':
      case 'rPr':
      case 'Fallback':
      case 'footnoteReference':
      case 'endnoteReference':
        break;
      case 'txbxContent':
        boxes.push(c);
        break;
      default:
        wordRunText(c, out, boxes);
    }
  }
}

function wordParagraph(p: XmlElement, styles: WordStyles, blocks: Block[]): void {
  const pPr = kid(p, 'pPr');
  const styleId = attr(kid(pPr, 'pStyle'), 'val');
  let level = styleHeading(styles, styleId);
  const outline = attr(kid(pPr, 'outlineLvl'), 'val');
  if (!level && outline !== undefined && Number(outline) < 9) level = Math.min(6, Number(outline) + 1);
  const out: string[] = [];
  const boxes: XmlElement[] = [];
  wordRunText(p, out, boxes);
  let text = out.join('').replace(/[ \t]+\n/g, '\n').trim();
  if (text) {
    if (!level && kid(pPr, 'numPr')) text = '- ' + text;
    blocks.push(level ? { text: text.replace(/\s+/g, ' '), level } : { text });
  }
  for (const box of boxes) wordBody(box, styles, blocks);
}

function wordTable(tbl: XmlElement, styles: WordStyles): string {
  const rows: string[] = [];
  for (const tr of kids(tbl, 'tr')) {
    const cells: string[] = [];
    for (const tc of kids(tr, 'tc')) {
      const inner: Block[] = [];
      wordBody(tc, styles, inner);
      cells.push(inner.map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.some((c) => c)) rows.push(cells.join(' | '));
  }
  return rows.join('\n');
}

function wordBody(el: XmlElement, styles: WordStyles, blocks: Block[]): void {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === 'p') wordParagraph(c, styles, blocks);
    else if (c.local === 'tbl') {
      const t = wordTable(c, styles);
      if (t) blocks.push({ text: t });
    } else if (c.local === 'sdt' || c.local === 'sdtContent' || c.local === 'customXml' || c.local === 'ins' || c.local === 'smartTag') {
      wordBody(c, styles, blocks);
    } else if (c.local === 'AlternateContent') {
      const choice = kid(c, 'Choice');
      if (choice) wordBody(choice, styles, blocks);
    }
  }
}

export function readDocx(zip: Zip, opts: OoxmlOptions = {}): ReadResult {
  const warnings: string[] = [];
  let main = 'word/document.xml';
  // The real main part is named in [Content_Types].xml; it's almost always word/document.xml.
  const ct = zip.text('[Content_Types].xml');
  if (ct) {
    const m = /PartName="\/?([^"]+)"[^>]*ContentType="application\/vnd\.ms-word\.document\.macroEnabled\.main\+xml|PartName="\/?([^"]+)"[^>]*ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(?:document|template)\.main\+xml/.exec(ct);
    const found = m?.[1] ?? m?.[2];
    if (found && zip.has(found)) main = found;
  }
  const doc = requireXml(zip, main, 'Word');
  checkAbort(opts.signal);
  const styles = readWordStyles(zip);
  const blocks: Block[] = [];
  const body = find(doc, 'body');
  if (body) wordBody(body, styles, blocks);
  const parts = blocksToParts(blocks);

  // Footnotes and endnotes, if any, come after the body.
  const noteBlocks: Block[] = [];
  for (const [path, tag] of [['word/footnotes.xml', 'footnote'], ['word/endnotes.xml', 'endnote']] as const) {
    const xml = zip.text(path);
    if (!xml) continue;
    for (const note of findAll(parseXml(xml), tag)) {
      const type = attr(note, 'type');
      if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
      const inner: Block[] = [];
      wordBody(note, styles, inner);
      const text = inner.map((b) => b.text).join(' ').trim();
      if (text) noteBlocks.push({ text });
    }
  }
  if (noteBlocks.length) parts.push({ text: noteBlocks.map((b) => b.text).join('\n\n'), where: 'notes', heading: 'Notes' });
  if (!parts.length) warnings.push('This Word document has no text in it.');
  return { kind: 'docx', title: coreTitle(zip), parts, images: [], warnings };
}

// ---------------------------------------------------------------- Excel

// Built-in number formats that show dates or times.
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

interface CellStyles {
  dateStyles: Set<number>; // indexes into cellXfs that format as a date
}

function readCellStyles(zip: Zip, path: string | undefined): CellStyles {
  const dateStyles = new Set<number>();
  const xml = path ? zip.text(path) : undefined;
  if (!xml) return { dateStyles };
  const root = parseXml(xml);
  const custom = new Map<number, string>();
  for (const f of findAll(find(root, 'numFmts'), 'numFmt')) custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
  kids(find(root, 'cellXfs'), 'xf').forEach((xf, i) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : DATE_FORMAT_IDS.has(id)) dateStyles.add(i);
  });
  return { dateStyles };
}

function isDateFormat(code: string): boolean {
  // Remove quoted text, escapes and colour/condition brackets, then look for date letters.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\sE+-]*$/.test(bare);
}

export function excelDate(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  if (serial < 1 && serial >= 0) return iso.slice(11, 19); // a time only
  return Number.isInteger(serial) || iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

export function formatNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}

function colIndex(ref: string | undefined): number | undefined {
  if (!ref) return undefined;
  const m = /^([A-Z]{1,3})/i.exec(ref);
  if (!m) return undefined;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(zip: Zip, path: string | undefined): string[] {
  const xml = path ? zip.text(path) : undefined;
  if (!xml) return [];
  const out: string[] = [];
  let inSi = 0;
  let inT = false;
  let inPhonetic = 0;
  let cur = '';
  scanXml(xml, {
    open(name, _a, selfClosing) {
      const l = localName(name);
      if (selfClosing) return;
      if (l === 'si') {
        inSi++;
        cur = '';
      } else if (l === 'rPh') inPhonetic++;
      else if (l === 't') inT = true;
    },
    close(name) {
      const l = localName(name);
      if (l === 'si') {
        inSi = Math.max(0, inSi - 1);
        out.push(cur);
      } else if (l === 'rPh') inPhonetic = Math.max(0, inPhonetic - 1);
      else if (l === 't') inT = false;
    },
    text(t) {
      if (inSi && inT && !inPhonetic) cur += t;
    },
  });
  return out;
}

function readSheet(xml: string, strings: string[], styles: CellStyles, date1904: boolean, maxRows: number, onCell?: (row: number, col: number, text: string) => void): { rows: string[]; capped: boolean } {
  const rows: string[] = [];
  let capped = false;
  let row: string[] = [];
  let inRow = false;
  let rowNum = 0;
  let cell: { t: string; s: number; col: number } | undefined;
  let value = '';
  let inV = false;
  let inIs = false;
  let inT = false;
  let isText = '';
  let nextCol = 0;
  scanXml(xml, {
    open(name, a, selfClosing) {
      const l = localName(name);
      if (l === 'row') {
        row = [];
        nextCol = 0;
        rowNum = Number(a.r) || rowNum + 1;
        inRow = !selfClosing;
      } else if (l === 'c' && inRow) {
        const col = colIndex(a.r) ?? nextCol;
        cell = { t: a.t ?? 'n', s: Number(a.s ?? 0), col };
        nextCol = col + 1;
        value = '';
        isText = '';
        if (selfClosing) cell = undefined;
      } else if (l === 'v' && cell) inV = !selfClosing;
      else if (l === 'is' && cell) inIs = !selfClosing;
      else if (l === 't' && inIs) inT = !selfClosing;
    },
    close(name) {
      const l = localName(name);
      if (l === 'v') inV = false;
      else if (l === 't') inT = false;
      else if (l === 'is') inIs = false;
      else if (l === 'c' && cell) {
        let text = '';
        switch (cell.t) {
          case 's':
            text = strings[Number(value)] ?? '';
            break;
          case 'inlineStr':
            text = isText;
            break;
          case 'b':
            text = value.trim() === '1' ? 'TRUE' : value.trim() === '0' ? 'FALSE' : value;
            break;
          case 'str':
          case 'e':
            text = value;
            break;
          default:
            text = value === '' ? '' : styles.dateStyles.has(cell.s) && Number.isFinite(Number(value)) ? excelDate(Number(value), date1904) : formatNumber(value);
        }
        if (cell.col < 16384) {
          while (row.length < cell.col) row.push('');
          row[cell.col] = text.replace(/\s*\n\s*/g, ' ').trim();
          onCell?.(rowNum, cell.col, row[cell.col]);
        }
        cell = undefined;
      } else if (l === 'row' && inRow) {
        inRow = false;
        while (row.length && !row[row.length - 1]) row.pop();
        if (row.length) {
          if (rows.length >= maxRows) {
            capped = true;
            throw new StopScan();
          }
          rows.push(row.join(' | '));
        }
      }
    },
    text(t) {
      if (inV) value += t;
      else if (inIs && inT) isText += t;
    },
  });
  return { rows, capped };
}

export function readXlsx(zip: Zip, opts: OoxmlOptions = {}): ReadResult {
  return readXlsxWith(zip, opts);
}

/**
 * fill_document (docs/DOCUMENTS.md): every cell's text as the Library reads it, by sheet and
 * address ("B3"), so a filled copy is checked with the very reader that reads it later.
 */
export function readXlsxCells(zip: Zip): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  readXlsxWith(zip, {}, (sheet, row, col, text) => {
    let m = out.get(sheet);
    if (!m) out.set(sheet, (m = new Map()));
    m.set(`${colLetters(col)}${row}`, text);
  });
  return out;
}

function colLetters(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function readXlsxWith(zip: Zip, opts: OoxmlOptions, onCell?: (sheet: string, row: number, col: number, text: string) => void): ReadResult {
  const warnings: string[] = [];
  const maxRows = opts.maxRowsPerSheet ?? 20_000;
  const wbPath = zip.has('xl/workbook.xml') ? 'xl/workbook.xml' : [...zip.entries.keys()].find((k) => /^xl\/workbook[^/]*\.xml$/i.test(k)) ?? 'xl/workbook.xml';
  const wb = requireXml(zip, wbPath, 'Excel');
  const rels = readRels(zip, wbPath);
  let sstPath: string | undefined;
  let stylesPath: string | undefined;
  for (const r of rels.values()) {
    if (r.type.endsWith('/sharedStrings')) sstPath = r.target;
    else if (r.type.endsWith('/styles')) stylesPath = r.target;
  }
  sstPath ??= zip.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : undefined;
  stylesPath ??= zip.has('xl/styles.xml') ? 'xl/styles.xml' : undefined;
  const strings = sharedStrings(zip, sstPath);
  const styles = readCellStyles(zip, stylesPath);
  const pr = find(wb, 'workbookPr');
  const date1904 = ['1', 'true'].includes(attr(pr, 'date1904') ?? '');
  const parts: DocPart[] = [];
  for (const sheet of findAll(find(wb, 'sheets'), 'sheet')) {
    checkAbort(opts.signal);
    const name = attr(sheet, 'name') ?? 'Sheet';
    const rid = attr(sheet, 'id');
    const target = rid ? rels.get(rid)?.target : undefined;
    if (!target || !zip.has(target)) continue; // chart sheets and missing sheets have no cells
    const xml = zip.text(target) ?? '';
    const { rows, capped } = readSheet(xml, strings, styles, date1904, maxRows, onCell ? (r, c, text) => onCell(name, r, c, text) : undefined);
    if (capped) warnings.push(`Sheet "${name}" is very long, so she only read the first ${maxRows.toLocaleString('en-US')} rows.`);
    if (rows.length) parts.push({ text: rows.join('\n'), where: `sheet ${name}`, heading: name });
  }
  if (!parts.length) warnings.push('This spreadsheet has no cells with anything in them.');
  return { kind: 'xlsx', title: coreTitle(zip), parts, images: [], warnings };
}

// ---------------------------------------------------------------- PowerPoint

function drawingParagraphs(txBody: XmlElement | undefined): string[] {
  const out: string[] = [];
  for (const p of kids(txBody, 'p')) {
    let s = '';
    for (const c of p.children) {
      if (typeof c === 'string') continue;
      if (c.local === 'r' || c.local === 'fld') s += textOf(kid(c, 't'));
      else if (c.local === 'br') s += '\n';
    }
    s = s.trim();
    if (s) out.push(s);
  }
  return out;
}

interface SlideShape {
  kind: 'title' | 'body' | 'other';
  text: string;
}

function placeholderType(sp: XmlElement): string | undefined {
  const nv = kids(sp).find((k) => k.local.startsWith('nv'));
  const ph = find(nv, 'ph');
  if (!ph) return undefined;
  return attr(ph, 'type') ?? 'body';
}

function slideShapes(tree: XmlElement | undefined, out: SlideShape[]): void {
  for (const c of kids(tree)) {
    if (c.local === 'sp') {
      const type = placeholderType(c);
      if (type === 'sldNum' || type === 'dt' || type === 'ftr' || type === 'hdr') continue;
      const text = drawingParagraphs(kid(c, 'txBody')).join('\n');
      if (text) out.push({ kind: type === 'title' || type === 'ctrTitle' ? 'title' : type ? 'body' : 'other', text });
    } else if (c.local === 'grpSp') {
      slideShapes(c, out);
    } else if (c.local === 'graphicFrame') {
      const tbl = find(c, 'tbl');
      if (tbl) {
        const rows: string[] = [];
        for (const tr of kids(tbl, 'tr')) {
          const cells = kids(tr, 'tc').map((tc) => drawingParagraphs(kid(tc, 'txBody')).join(' '));
          if (cells.some((x) => x)) rows.push(cells.join(' | '));
        }
        if (rows.length) out.push({ kind: 'other', text: rows.join('\n') });
      }
    } else if (c.local === 'AlternateContent') {
      slideShapes(kid(c, 'Choice'), out);
    }
  }
}

export function readPptx(zip: Zip, opts: OoxmlOptions = {}): ReadResult {
  const warnings: string[] = [];
  const presPath = 'ppt/presentation.xml';
  const pres = requireXml(zip, presPath, 'PowerPoint');
  const rels = readRels(zip, presPath);
  const slidePaths: string[] = [];
  for (const s of findAll(find(pres, 'sldIdLst'), 'sldId')) {
    const rid = Object.entries(s.attrs).find(([k]) => k.endsWith(':id'))?.[1];
    const t = rid ? rels.get(rid)?.target : undefined;
    if (t && zip.has(t)) slidePaths.push(t);
  }
  if (!slidePaths.length) {
    // No usable order list: fall back to slide file numbers.
    const found = [...zip.entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k));
    found.sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1]));
    slidePaths.push(...found);
  }
  const parts: DocPart[] = [];
  slidePaths.forEach((path, i) => {
    checkAbort(opts.signal);
    const xml = zip.text(path);
    if (!xml) return;
    const shapes: SlideShape[] = [];
    slideShapes(find(parseXml(xml), 'spTree'), shapes);
    const title = shapes.find((s) => s.kind === 'title')?.text.replace(/\s+/g, ' ');
    const lines: string[] = [];
    if (title) lines.push('# ' + title);
    for (const s of shapes) if (s.kind !== 'title') lines.push(s.text);
    // Speaker notes live in a separate part linked from the slide.
    for (const r of readRels(zip, path).values()) {
      if (!r.type.endsWith('/notesSlide')) continue;
      const nx = zip.text(r.target);
      if (!nx) continue;
      const noteShapes: SlideShape[] = [];
      const tree = find(parseXml(nx), 'spTree');
      for (const sp of findAll(tree, 'sp')) {
        if (placeholderType(sp) !== 'body') continue;
        const text = drawingParagraphs(kid(sp, 'txBody')).join('\n');
        if (text) noteShapes.push({ kind: 'body', text });
      }
      if (noteShapes.length) lines.push('Speaker notes: ' + noteShapes.map((s) => s.text).join('\n'));
    }
    const text = lines.join('\n\n').trim();
    if (text) parts.push(title ? { text, where: `slide ${i + 1}`, heading: title } : { text, where: `slide ${i + 1}` });
  });
  if (!parts.length) warnings.push('This presentation has no text on its slides.');
  return { kind: 'pptx', title: coreTitle(zip), parts, images: [], warnings };
}

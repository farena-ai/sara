// fill_document (docs/DOCUMENTS.md): she fills in the person's own form or template. The values go
// into a COPY of their file (never the original), in place: next to a label ("EMPLOYEE NAME:" ->
// the empty cell to its right, or below), at a cell address ("B3"), or into a table by its header
// and row label (DAY = SUNDAY, START TIME = 2200). Everything else in the file stays as it was:
// styles, merged cells, formulas (worked out again when the file opens), column widths, pictures.
// Numbers go in as numbers, times and dates as times and dates only where the cell is formatted for
// them, text as text. The copy is then read back with the Library's own reader and every value is
// checked where it should be, so the report (filled / label not found / ambiguous / …) is the truth.
// Excel (.xlsx) and Word (.docx: text after labels, table cells, content controls) for now.
import { excelDate, formatNumber, readDocx, readRels, readXlsxCells } from '../library/ooxml.ts';
import { attr, find, findAll, kid, kids, parseXml, textOf, type XmlChild, type XmlElement } from '../library/xml.ts';
import { openZip, type Zip } from '../library/zip.ts';
import { cloneEl, element, removeAttr, repack, serializeXml, setAttr, xmlSafe } from './ooxml-edit.ts';
import { DocError } from './spec.ts';

export type FillValue = string | number | boolean;
export type FillItem =
  | { kind: 'label'; label: string; value: FillValue; sheet?: string }
  | { kind: 'cell'; cell: string; value: FillValue; sheet?: string }
  | { kind: 'table'; table: string; rows: Record<string, FillValue>[]; sheet?: string };
export type FieldStatus = 'filled' | 'not_found' | 'ambiguous' | 'formula' | 'no_space' | 'not_verified';
export interface FieldResult {
  /** What was asked: a label, a cell address, or \"TABLE ROW / COLUMN\". */
  field: string;
  value: string;
  status: FieldStatus;
  /** Where it went (\"Sheet1!B3\", \"the table under DAY\"). */
  where?: string;
  detail?: string;
}
export interface FillResult {
  format: 'xlsx' | 'docx';
  data: Buffer;
  fields: FieldResult[];
  filled: number;
  total: number;
  /** Labels the form has (to tell the model what it can use when one isn't found). */
  labels: string[];
}

export const FILL_FORMATS = ['xlsx', 'docx'] as const;
const MAX_FIELDS = 2000;

// ---------------------------------------------------------------- the model's arguments

const cleanValue = (v: unknown): FillValue | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') throw new DocError('Each value is plain text or a number.');
  const s = xmlSafe(String(v)).slice(0, 4000);
  return s.trim() ? s : undefined;
};
const cleanKey = (k: unknown): string => String(k ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** A cell address (\"B3\", \"$B$3\", \"Sheet1!B3\", \"'My sheet'!B3\"), checked. */
export function parseCellRef(ref: string): { sheet?: string; row: number; col: number } | undefined {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!']+))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[3].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[4]);
  if (col < 1 || col > 16384 || row < 1 || row > 1048576) return undefined;
  const sheet = m[1]?.replace(/''/g, "'") ?? m[2]?.trim();
  return { ...(sheet ? { sheet } : {}), row, col: col - 1 };
}

/**
 * The model's values as fill items. Takes `values` ({label: value} or a list of {label, value},
 * {cell, value} and {table, rows}), `cells` and `tables`. Throws a DocError the model can act on.
 */
export function fillItems(args: Record<string, unknown>): FillItem[] {
  const out: FillItem[] = [];
  const sheetOf = (o: Record<string, unknown>) => (typeof o.sheet === 'string' && o.sheet.trim() ? { sheet: o.sheet.trim() } : {});
  const one = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new DocError('Each entry is {label, value}, {cell, value} or {table, rows}.');
    const r = o as Record<string, unknown>;
    if (r.table !== undefined) {
      const table = cleanKey(r.table);
      if (!table) throw new DocError('A table needs the text of one of its column headers (e.g. "DAY").');
      if (!Array.isArray(r.rows) || !r.rows.length) throw new DocError(`The table "${table}" needs rows, like [{"${table}": "SUNDAY", "START TIME": "2200"}].`);
      const rows = r.rows.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DocError(`Each row of "${table}" is an object of column: value.`);
        const clean: Record<string, FillValue> = {};
        for (const [k, v] of Object.entries(row)) {
          const key = cleanKey(k);
          const val = cleanValue(v);
          if (key && val !== undefined) clean[key] = val;
        }
        return clean;
      });
      out.push({ kind: 'table', table, rows, ...sheetOf(r) });
      return;
    }
    const value = cleanValue(r.value);
    if (r.cell !== undefined) {
      const cell = cleanKey(r.cell);
      const ref = parseCellRef(cell);
      if (!ref) throw new DocError(`"${cell}" isn't a cell address (like B3 or Sheet1!B3).`);
      if (value !== undefined) out.push({ kind: 'cell', cell, value, ...sheetOf(r) });
      return;
    }
    const label = cleanKey(r.label ?? r.field ?? r.name);
    if (!label) throw new DocError('Each entry is {label, value}, {cell, value} or {table, rows}.');
    if (value !== undefined) out.push({ kind: 'label', label, value, ...sheetOf(r) });
  };
  const values = args.values;
  if (Array.isArray(values)) values.forEach(one);
  else if (values && typeof values === 'object') {
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) one({ label: k, ...(v as object) });
      else if (parseCellRef(k) && /\d$/.test(k) && !/\s/.test(k.trim())) one({ cell: k, value: v });
      else one({ label: k, value: v });
    }
  } else if (values !== undefined && values !== null) throw new DocError('values is {label: value} or a list of {label, value}, {cell, value} and {table, rows}.');
  if (Array.isArray(args.cells)) args.cells.forEach((c) => one({ ...(c as object), cell: (c as { cell?: unknown })?.cell ?? '' }));
  if (Array.isArray(args.tables)) args.tables.forEach(one);
  const count = out.reduce((n, it) => n + (it.kind === 'table' ? it.rows.reduce((m, r) => m + Math.max(0, Object.keys(r).length - 1), 0) : 1), 0);
  if (!count) throw new DocError('Say what to fill in: values like {"EMPLOYEE NAME": "Kent"}, cells like {"cell": "B3", "value": 8}, or tables like {"table": "DAY", "rows": [{"DAY": "SUNDAY", "START TIME": "2200"}]}.');
  if (count > MAX_FIELDS) throw new DocError(`That's more than ${MAX_FIELDS} fields at once; fill it in parts.`);
  return out;
}

// ---------------------------------------------------------------- shared helpers

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** A label's text for matching: no accents or case, no trailing colon, underscores or stars. */
export const normLabel = (s: string): string => fold(s).replace(/[\s\u00a0]+/g, ' ').replace(/^[\s*#]+/, '').replace(/[\s:：*_.\u2026-]+$/, '').trim();
/** A cell or blank that's empty for filling: nothing, spaces, or a fill-in line (____ or ....). */
const isBlank = (s: string) => /^[\s_.\u2026\u2013\u2014-]*$/.test(s);
const shown = (v: FillValue) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

function finish(format: 'xlsx' | 'docx', data: Buffer, fields: FieldResult[], labels: string[]): FillResult {
  return { format, data, fields, filled: fields.filter((f) => f.status === 'filled').length, total: fields.length, labels: [...new Set(labels)].slice(0, 60) };
}

/** Fills a copy of an .xlsx or .docx form (by its name and content). */
export function fillFile(name: string, bytes: Buffer, items: FillItem[]): FillResult {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const zip = openZip(bytes);
  if (ext === 'xlsx' || (!ext && zip.has('xl/workbook.xml'))) return fillXlsx(bytes, items);
  if (ext === 'docx' || (!ext && zip.has('word/document.xml'))) return fillDocx(bytes, items);
  throw new DocError('She can fill in Excel (.xlsx) and Word (.docx) forms.');
}

// ---------------------------------------------------------------- Excel

type NumKind = 'general' | 'text' | 'date' | 'time' | 'datetime';
// The built-in formats the Library's reader shows as dates or times (and 49, text).
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);
const BUILTIN_DATE = new Set([14, 15, 16, 17, 27, 30, 36, 50, 57]);

function kindOfCode(code: string): NumKind {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  if (bare.trim() === '@') return 'text';
  if (!/[dmyhs]/i.test(bare) || /^[#0.,%\sE+-]*$/.test(bare)) return 'general';
  const date = /[dy]/i.test(bare);
  const time = /[hs]/i.test(bare);
  return date && time ? 'datetime' : time ? 'time' : date ? 'date' : 'date';
}

interface Merge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
interface XCell {
  el: XmlElement;
  rowEl: XmlElement;
  row: number;
  col: number;
}

const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const refOf = (row: number, col: number) => `${colName(col)}${row}`;

class XSheet {
  readonly rows = new Map<number, XmlElement>();
  readonly cells = new Map<string, XCell>();
  readonly merges: Merge[] = [];
  readonly colStyles: { min: number; max: number; style: string }[] = [];
  maxRow = 0;
  maxCol = 0;
  changed = false;
  readonly sheetData: XmlElement;
  readonly name: string;
  readonly path: string;
  readonly root: XmlElement;

  constructor(name: string, path: string, root: XmlElement) {
    this.name = name;
    this.path = path;
    this.root = root;
    const ws = find(root, 'worksheet') ?? root;
    let sd = kid(ws, 'sheetData');
    if (!sd) {
      sd = element(ws, 'sheetData');
      ws.children.push(sd);
    }
    this.sheetData = sd;
    let r = 0;
    for (const rowEl of kids(sd, 'row')) {
      r = Number(attr(rowEl, 'r')) || r + 1;
      setAttr(rowEl, 'r', String(r));
      this.rows.set(r, rowEl);
      let c = -1;
      for (const cEl of kids(rowEl, 'c')) {
        const p = parseCellRef(attr(cEl, 'r') ?? '');
        c = p ? p.col : c + 1;
        setAttr(cEl, 'r', refOf(r, c));
        this.cells.set(`${r},${c}`, { el: cEl, rowEl, row: r, col: c });
        this.maxCol = Math.max(this.maxCol, c);
      }
      this.maxRow = Math.max(this.maxRow, r);
    }
    for (const m of findAll(find(ws, 'mergeCells'), 'mergeCell')) {
      const [a, b] = (attr(m, 'ref') ?? '').split(':');
      const pa = parseCellRef(a ?? '');
      const pb = parseCellRef(b ?? a ?? '');
      if (pa && pb) {
        this.merges.push({ r1: Math.min(pa.row, pb.row), c1: Math.min(pa.col, pb.col), r2: Math.max(pa.row, pb.row), c2: Math.max(pa.col, pb.col) });
        this.maxCol = Math.max(this.maxCol, pa.col, pb.col);
        this.maxRow = Math.max(this.maxRow, pa.row, pb.row);
      }
    }
    for (const c of findAll(find(ws, 'cols'), 'col')) {
      const style = attr(c, 'style');
      if (style) this.colStyles.push({ min: Number(attr(c, 'min')) - 1, max: Number(attr(c, 'max')) - 1, style });
    }
  }

  mergeAt(row: number, col: number): Merge | undefined {
    return this.merges.find((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2);
  }
  /** A cell hidden inside a merge (not its top-left one). */
  covered(row: number, col: number): boolean {
    const m = this.mergeAt(row, col);
    return Boolean(m && (m.r1 !== row || m.c1 !== col));
  }
  cell(row: number, col: number): XCell | undefined {
    return this.cells.get(`${row},${col}`);
  }
  styleFor(row: number, col: number): string | undefined {
    const c = this.cell(row, col);
    if (c) return attr(c.el, 's');
    const rowEl = this.rows.get(row);
    if (rowEl && ['1', 'true'].includes(attr(rowEl, 'customFormat') ?? '') && attr(rowEl, 's')) return attr(rowEl, 's');
    return this.colStyles.find((x) => col >= x.min && col <= x.max)?.style;
  }
  /** The cell element at a place, made (in order) when it isn't there. */
  ensure(row: number, col: number): XCell {
    const had = this.cell(row, col);
    if (had) return had;
    let rowEl = this.rows.get(row);
    if (!rowEl) {
      rowEl = element(this.sheetData.name, 'row', { r: String(row) });
      const after = [...this.rows.keys()].filter((r) => r < row).sort((a, b) => b - a)[0];
      const at = after === undefined ? 0 : this.sheetData.children.indexOf(this.rows.get(after)!) + 1;
      this.sheetData.children.splice(at, 0, rowEl);
      this.rows.set(row, rowEl);
    }
    const style = this.styleFor(row, col);
    const el = element(rowEl, 'c', { r: refOf(row, col), ...(style ? { s: style } : {}) });
    const next = kids(rowEl, 'c').find((c) => (parseCellRef(attr(c, 'r') ?? '')?.col ?? -1) > col);
    if (next) rowEl.children.splice(rowEl.children.indexOf(next), 0, el);
    else rowEl.children.push(el);
    const x = { el, rowEl, row, col };
    this.cells.set(`${row},${col}`, x);
    this.maxRow = Math.max(this.maxRow, row);
    this.maxCol = Math.max(this.maxCol, col);
    return x;
  }
}

class XBook {
  readonly sheets: XSheet[] = [];
  readonly strings: string[] = [];
  readonly kinds: NumKind[] = [];
  readonly date1904: boolean;
  readonly wbPath: string;
  readonly wb: XmlElement;
  readonly zip: Zip;

  constructor(zip: Zip) {
    this.zip = zip;
    this.wbPath = zip.has('xl/workbook.xml') ? 'xl/workbook.xml' : ([...zip.entries.keys()].find((k) => /^xl\/workbook[^/]*\.xml$/i.test(k)) ?? 'xl/workbook.xml');
    const wbXml = zip.text(this.wbPath);
    if (!wbXml) throw new DocError('This Excel file is missing its workbook, so it may be damaged.');
    this.wb = parseXml(wbXml);
    const rels = readRels(zip, this.wbPath);
    let sst: string | undefined;
    let styles: string | undefined;
    for (const r of rels.values()) {
      if (r.type.endsWith('/sharedStrings')) sst = r.target;
      else if (r.type.endsWith('/styles')) styles = r.target;
    }
    const sstXml = sst ? zip.text(sst) : undefined;
    if (sstXml) for (const si of findAll(parseXml(sstXml), 'si')) this.strings.push(siText(si));
    const stXml = styles ? zip.text(styles) : undefined;
    if (stXml) {
      const st = parseXml(stXml);
      const custom = new Map<number, string>();
      for (const f of findAll(find(st, 'numFmts'), 'numFmt')) custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
      for (const xf of kids(find(st, 'cellXfs'), 'xf')) {
        const id = Number(attr(xf, 'numFmtId') ?? 0);
        const code = custom.get(id);
        this.kinds.push(code !== undefined ? kindOfCode(code) : id === 49 ? 'text' : BUILTIN_TIME.has(id) ? 'time' : id === 22 ? 'datetime' : BUILTIN_DATE.has(id) ? 'date' : 'general');
      }
    }
    this.date1904 = ['1', 'true'].includes(attr(find(this.wb, 'workbookPr'), 'date1904') ?? '');
    for (const s of findAll(find(this.wb, 'sheets'), 'sheet')) {
      const rid = attr(s, 'id');
      const target = rid ? rels.get(rid)?.target : undefined;
      const xml = target ? zip.text(target) : undefined;
      if (!target || !xml) continue;
      this.sheets.push(new XSheet(attr(s, 'name') ?? 'Sheet', target, parseXml(xml)));
    }
    if (!this.sheets.length) throw new DocError('This Excel file has no sheets with cells to fill.');
  }

  text(c: XCell | undefined): string {
    if (!c) return '';
    const t = attr(c.el, 't');
    if (t === 's') return this.strings[Number(textOf(kid(c.el, 'v')))] ?? '';
    if (t === 'inlineStr') return siText(kid(c.el, 'is'));
    return textOf(kid(c.el, 'v'));
  }
  kindOf(sheet: XSheet, row: number, col: number): NumKind {
    const s = sheet.styleFor(row, col);
    return (s !== undefined && this.kinds[Number(s)]) || 'general';
  }
}

function siText(si: XmlElement | undefined): string {
  if (!si) return '';
  let s = '';
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.local === 't') s += textOf(c);
      else if (c.local !== 'rPh' && c.local !== 'phoneticPr') walk(c);
    }
  };
  walk(si);
  return s;
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^[-+]?\.\d+$/;
function parseTime(s: string): number | undefined {
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?$/i.exec(s);
  let h: number;
  let min: number;
  let sec = 0;
  if (m) {
    h = Number(m[1]);
    min = Number(m[2]);
    sec = Number(m[3] ?? 0);
    if (m[4]) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
    }
  } else if ((m = /^(\d{1,2})(\d{2})$/.exec(s))) {
    h = Number(m[1]);
    min = Number(m[2]);
  } else if ((m = /^(\d{1,2})\s*([ap])\.?\s*m\.?$/i.exec(s))) {
    h = Number(m[1]);
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[2].toLowerCase() === 'p' ? 12 : 0);
    min = 0;
  } else return undefined;
  if (h > 24 || min > 59 || sec > 59 || (h === 24 && (min || sec))) return undefined;
  return (h * 3600 + min * 60 + sec) / 86400;
}
function parseDate(s: string, date1904: boolean): number | undefined {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.+))?$/.exec(s);
  let y: number, mo: number, d: number, rest: string | undefined;
  if (m) [y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/.exec(s))) [mo, d, y, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  else return undefined;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  const time = rest ? parseTime(rest.trim()) : 0;
  if (time === undefined) return undefined;
  return (ms - Date.UTC(1899, 11, 30)) / 86400000 - (date1904 ? 1462 : 0) + time;
}

type Written = { type: 'n'; n: number } | { type: 's'; s: string } | { type: 'b'; b: boolean };
function toCell(v: FillValue, kind: NumKind, date1904: boolean): Written {
  if (typeof v === 'boolean') return { type: 'b', b: v };
  if (typeof v === 'number') return kind === 'text' ? { type: 's', s: String(v) } : { type: 'n', n: v };
  const s = v.trim();
  if (kind === 'text') return { type: 's', s: v };
  if (kind === 'time') {
    const t = parseTime(s);
    if (t !== undefined) return { type: 'n', n: t };
  }
  if (kind === 'date' || kind === 'datetime') {
    const d = parseDate(s, date1904);
    if (d !== undefined) return { type: 'n', n: d };
    if (kind === 'datetime') {
      const t = parseTime(s);
      if (t !== undefined) return { type: 'n', n: t };
    }
  }
  // Numbers as numbers, unless a leading zero matters (\"0600\", a badge number \"007\").
  if (NUMBER.test(s) && !/^[-+]?0\d/.test(s)) return { type: 'n', n: Number(s.replace(/,/g, '')) };
  return { type: 's', s: v };
}

function writeCell(x: XCell, w: Written): void {
  const el = x.el;
  el.children = el.children.filter((c) => typeof c !== 'string' && c.local === 'extLst');
  removeAttr(el, 't');
  removeAttr(el, 'cm');
  removeAttr(el, 'vm');
  const v = (text: string) => element(el, 'v', {}, [text]);
  if (w.type === 'n') el.children.unshift(v(String(w.n)));
  else if (w.type === 'b') {
    el.attrs.t = 'b';
    el.children.unshift(v(w.b ? '1' : '0'));
  } else {
    el.attrs.t = 'inlineStr';
    el.children.unshift(element(el, 'is', {}, [element(el, 't', { 'xml:space': 'preserve' }, [xmlSafe(w.s)])]));
  }
}

interface XTarget {
  sheet: XSheet;
  row: number;
  col: number;
}

/** Fills a copy of an Excel form. */
export function fillXlsx(bytes: Buffer, items: FillItem[]): FillResult {
  const zip = openZip(bytes);
  const book = new XBook(zip);
  const fields: FieldResult[] = [];
  const expect: { f: FieldResult; t: XTarget; text: string }[] = [];
  const taken = new Set<string>();
  const sheetsFor = (name?: string): XSheet[] => {
    if (!name) return book.sheets;
    const s = book.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return s ? [s] : [];
  };
  const at = (t: XTarget) => `${t.sheet.name}!${refOf(t.row, t.col)}`;
  const put = (f: FieldResult, t: XTarget, value: FillValue) => {
    const key = at(t);
    const x = t.sheet.cell(t.row, t.col);
    if (x && kid(x.el, 'f')) {
      fields.push({ ...f, status: 'formula', where: key, detail: 'that cell works itself out with a formula, so it was left as it is' });
      return;
    }
    const w = toCell(value, book.kindOf(t.sheet, t.row, t.col), book.date1904);
    const cell = t.sheet.ensure(t.row, t.col);
    writeCell(cell, w);
    t.sheet.changed = true;
    taken.add(key);
    const kind = book.kindOf(t.sheet, t.row, t.col);
    const text = w.type === 's' ? oneLine(w.s) : w.type === 'b' ? (w.b ? 'TRUE' : 'FALSE') : kind === 'date' || kind === 'time' || kind === 'datetime' ? excelDate(w.n, book.date1904) : formatNumber(String(w.n));
    const done = { ...f, status: 'filled' as const, where: key };
    fields.push(done);
    expect.push({ f: done, t, text });
  };
  const empty = (s: XSheet, row: number, col: number) => {
    const x = s.cell(row, col);
    return !taken.has(`${s.name}!${refOf(row, col)}`) && (!x || (!kid(x.el, 'f') && isBlank(book.text(x))));
  };
  /** The empty cell for a label: right of it (past its own merge and hidden merged cells), else below it. */
  const targetFor = (s: XSheet, row: number, col: number): XTarget | undefined => {
    const own = s.mergeAt(row, col);
    let c = (own?.c2 ?? col) + 1;
    while (c <= s.maxCol + 1 && s.covered(row, c)) c++;
    if (c < 16384 && empty(s, row, c)) return { sheet: s, row, col: c };
    const below = (own?.r2 ?? row) + 1;
    if (!s.covered(below, col) && empty(s, below, col)) return { sheet: s, row: below, col };
    return undefined;
  };
  const labelCells = (sheets: XSheet[], label: string) => {
    const want = normLabel(label);
    const exact: XTarget[] = [];
    const loose: XTarget[] = [];
    if (!want) return exact;
    for (const s of sheets)
      for (const x of s.cells.values()) {
        const raw = book.text(x);
        if (!raw.trim() || raw.length > 200 || /_{2,}/.test(raw)) continue;
        const n = normLabel(raw);
        if (n === want) exact.push({ sheet: s, row: x.row, col: x.col });
        else if (n.length <= want.length + 20 && ` ${n.replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${want.replace(/[^\p{L}\p{N}]+/gu, ' ')} `)) loose.push({ sheet: s, row: x.row, col: x.col });
      }
    return exact.length ? exact : loose;
  };
  const order = (a: XTarget, b: XTarget) => book.sheets.indexOf(a.sheet) - book.sheets.indexOf(b.sheet) || a.row - b.row || a.col - b.col;

  for (const it of items) {
    if (it.kind === 'cell') {
      const p = parseCellRef(it.cell)!;
      const f: FieldResult = { field: it.cell, value: shown(it.value), status: 'not_found' };
      const sheets = sheetsFor(p.sheet ?? it.sheet);
      if (!sheets.length) {
        fields.push({ ...f, detail: `there's no sheet called "${p.sheet ?? it.sheet}" (sheets: ${book.sheets.map((s) => s.name).join(', ')})` });
        continue;
      }
      const s = sheets[0];
      const m = s.mergeAt(p.row, p.col);
      put(f, { sheet: s, row: m?.r1 ?? p.row, col: m?.c1 ?? p.col }, it.value);
    } else if (it.kind === 'label') {
      const f: FieldResult = { field: it.label, value: shown(it.value), status: 'not_found' };
      const found = labelCells(sheetsFor(it.sheet), it.label).sort(order);
      if (!found.length) {
        fields.push({ ...f, detail: 'no label like that in the form' });
        continue;
      }
      const targets = found.map((c) => ({ c, t: targetFor(c.sheet, c.row, c.col) }));
      const open = targets.filter((x) => x.t);
      if (open.length > 1) fields.push({ ...f, status: 'ambiguous', detail: `that label is in ${open.length} places (${open.map((x) => at(x.c)).join(', ')}); give the cell address instead` });
      else if (!open.length) fields.push({ ...f, status: 'no_space', where: at(found[0]), detail: 'the cells next to and below that label already have something in them; give the cell address instead' });
      else put(f, open[0].t!, it.value);
    } else {
      // A table: the header cell named by `table` gives the header row; rows are found by their label in that column.
      const heads = labelCells(sheetsFor(it.sheet), it.table).sort(order);
      const cols = (h: XTarget) => {
        const m = new Map<string, number>();
        for (const x of h.sheet.cells.values()) if (x.row === h.row) {
          const n = normLabel(book.text(x));
          if (n && !m.has(n)) m.set(n, x.col);
        }
        return m;
      };
      const wanted = new Set(it.rows.flatMap((r) => Object.keys(r).map(normLabel)));
      const head = heads.map((h) => ({ h, cols: cols(h) })).sort((a, b) => [...wanted].filter((w) => b.cols.has(w)).length - [...wanted].filter((w) => a.cols.has(w)).length)[0];
      for (const row of it.rows) {
        const keys = Object.keys(row);
        const rowKey = keys.find((k) => normLabel(k) === normLabel(it.table)) ?? keys[0];
        const rowLabel = shown(row[rowKey] ?? '');
        for (const k of keys) {
          if (k === rowKey) continue;
          const f: FieldResult = { field: `${it.table} ${rowLabel} / ${k}`, value: shown(row[k]), status: 'not_found' };
          if (!head) {
            fields.push({ ...f, detail: `no table with a "${it.table}" column header` });
            continue;
          }
          const s = head.h.sheet;
          let rr = 0;
          for (let r = head.h.row + 1; r <= s.maxRow && !rr; r++) if (normLabel(book.text(s.cell(r, head.h.col))) === normLabel(rowLabel)) rr = r;
          if (!rr) {
            fields.push({ ...f, detail: `no row "${rowLabel}" under ${it.table}` });
            continue;
          }
          const want = normLabel(k);
          let col = head.cols.get(want);
          if (col === undefined) {
            const near = [...head.cols.entries()].filter(([n]) => n.includes(want) || want.includes(n));
            if (near.length === 1) col = near[0][1];
          }
          if (col === undefined) {
            fields.push({ ...f, detail: `no column "${k}" in that table (columns: ${[...head.cols.keys()].join(', ').toUpperCase()})` });
            continue;
          }
          const m = s.mergeAt(rr, col);
          put(f, { sheet: s, row: m?.r1 ?? rr, col: m?.c1 ?? col }, row[k]);
        }
      }
    }
  }

  // Write the changed sheets back; formulas there lose their old answers and are worked out on opening.
  const changed = new Map<string, string>();
  for (const s of book.sheets) {
    if (!s.changed) continue;
    for (const x of s.cells.values()) {
      if (!kid(x.el, 'f')) continue;
      x.el.children = x.el.children.filter((c) => typeof c === 'string' || c.local !== 'v');
      removeAttr(x.el, 't');
    }
    for (const r of s.rows.values()) removeAttr(r, 'spans');
    const ws = find(s.root, 'worksheet');
    const dim = kid(ws, 'dimension');
    if (dim) {
      let minR = Infinity, minC = Infinity;
      for (const x of s.cells.values()) {
        minR = Math.min(minR, x.row);
        minC = Math.min(minC, x.col);
      }
      if (Number.isFinite(minR)) setAttr(dim, 'ref', `${refOf(minR, minC)}:${refOf(s.maxRow, s.maxCol)}`);
    }
    changed.set(s.path, serializeXml(s.root));
  }
  if (changed.size) {
    const wbRoot = find(book.wb, 'workbook') ?? book.wb;
    let calc = kid(wbRoot, 'calcPr');
    if (!calc) {
      calc = element(wbRoot, 'calcPr');
      // calcPr comes after sheets, functionGroups, externalReferences and definedNames.
      const before = ['sheets', 'functionGroups', 'externalReferences', 'definedNames'];
      let at = -1;
      wbRoot.children.forEach((c, i) => {
        if (typeof c !== 'string' && before.includes(c.local)) at = i;
      });
      wbRoot.children.splice(at + 1, 0, calc);
    }
    setAttr(calc, 'fullCalcOnLoad', '1');
    changed.set(book.wbPath, serializeXml(book.wb));
  }
  const data = repack(zip, changed);

  // Check the copy with the Library's reader: every filled value where it should be.
  const read = readXlsxCells(openZip(data));
  for (const e of expect) {
    const got = read.get(e.t.sheet.name)?.get(refOf(e.t.row, e.t.col)) ?? '';
    if (got !== e.text) Object.assign(e.f, { status: 'not_verified', detail: `reading the copy back shows "${got}" there, not "${e.text}"` });
  }
  const labels: string[] = [];
  for (const s of book.sheets) for (const x of s.cells.values()) {
    const t = book.text(x).trim();
    if (t && t.length <= 40 && !NUMBER.test(t) && (/:\s*$/.test(t) || t === t.toUpperCase()) && /\p{L}/u.test(t)) labels.push(t.replace(/\s*:\s*$/, ''));
  }
  return finish('xlsx', data, fields, labels);
}

// ---------------------------------------------------------------- Word

interface Seg {
  /** A w:t (text) or w:tab element. */
  el: XmlElement;
  run: XmlElement;
  text: string;
}

const W_PLACEHOLDER = /^(click or tap here to enter text\.?|click here to enter text\.?|haga clic o pulse aquí para escribir texto\.?|cliquez ou appuyez ici pour entrer du texte\.?|klicken oder tippen sie hier, um text einzugeben\.?|clique ou toque aqui para inserir o texto\.?|fare clic o toccare qui per immettere il testo\.?)$/i;

/** Fills a copy of a Word form. */
export function fillDocx(bytes: Buffer, items: FillItem[]): FillResult {
  const zip = openZip(bytes);
  let main = 'word/document.xml';
  const ct = zip.text('[Content_Types].xml');
  const m = ct ? /PartName="\/?([^"]+)"[^>]*ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(?:document|template)\.main\+xml/.exec(ct) : null;
  if (m && zip.has(m[1])) main = m[1];
  const xml = zip.text(main);
  if (!xml) throw new DocError('This Word file is missing its main content, so it may be damaged.');
  const root = parseXml(xml);
  const docEl = find(root, 'document');
  const body = find(docEl, 'body');
  if (!docEl || !body) throw new DocError('This Word file has no body to fill.');
  const W = docEl.name.includes(':') ? docEl.name.slice(0, docEl.name.indexOf(':') + 1) : '';
  const isW = (el: XmlElement, local: string) => el.local === local && el.name === `${W}${local}`;
  const all = (el: XmlElement, local: string) => findAll(el, local).filter((x) => isW(x, local));
  const parent = new Map<XmlElement, XmlElement>();
  const index = (el: XmlElement) => {
    for (const c of el.children) if (typeof c !== 'string') {
      parent.set(c, el);
      index(c);
    }
  };
  index(root);
  const up = (el: XmlElement, local: string): XmlElement | undefined => {
    for (let p = parent.get(el); p; p = parent.get(p)) if (isW(p, local)) return p;
    return undefined;
  };
  const w = (local: string, attrs: Record<string, string> = {}, children: XmlChild[] = []) => element(`${W}${local}`, local, attrs, children);
  const tText = (s: string) => w('t', { 'xml:space': 'preserve' }, [xmlSafe(s)]);

  /** A paragraph's text pieces (runs' w:t and w:tab), not counting nested paragraphs or deleted text. */
  const segs = (p: XmlElement): Seg[] => {
    const out: Seg[] = [];
    const walk = (el: XmlElement, run?: XmlElement) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (isW(c, 'p') || isW(c, 'del') || isW(c, 'pPr') || isW(c, 'rPr') || isW(c, 'txbxContent') || c.local === 'Fallback') continue;
        if (isW(c, 'r')) walk(c, c);
        else if (run && isW(c, 't')) out.push({ el: c, run, text: textOf(c) });
        else if (run && isW(c, 'tab')) out.push({ el: c, run, text: '\t' });
        else if (!run || !['drawing', 'pict', 'object'].includes(c.local)) walk(c, run);
      }
    };
    walk(p);
    return out;
  };
  const textOfP = (p: XmlElement) => segs(p).map((s) => s.text).join('');
  const cellText = (tc: XmlElement) => all(tc, 'p').filter((p) => up(p, 'tc') === tc).map(textOfP).join('\n');
  const setText = (t: XmlElement, s: string) => {
    t.children = s ? [xmlSafe(s)] : [];
    t.attrs['xml:space'] = 'preserve';
  };
  const rPrOf = (run: XmlElement | undefined, dropBold: boolean): XmlElement | undefined => {
    const r = run ? kid(run, 'rPr') : undefined;
    if (!r) return undefined;
    const c = cloneEl(r);
    if (dropBold) c.children = c.children.filter((x) => typeof x === 'string' || !['b', 'bCs'].includes(x.local));
    c.children = c.children.filter((x) => typeof x === 'string' || x.local !== 'rStyle' || !/placeholder/i.test(attr(x, 'val') ?? ''));
    return c.children.length ? c : undefined;
  };
  const newRun = (rPr: XmlElement | undefined, text: string) => {
    const lines = text.split('\n');
    const kidsOf: XmlChild[] = rPr ? [rPr] : [];
    lines.forEach((l, i) => {
      if (i) kidsOf.push(w('br'));
      kidsOf.push(tText(l));
    });
    return w('r', {}, kidsOf);
  };
  /** Replaces the characters [a, b) of a paragraph's text with a value, keeping the first run's look. */
  const replaceRange = (ss: Seg[], a: number, b: number, value: string) => {
    let pos = 0;
    let placed = false;
    for (const s of ss) {
      const s0 = pos;
      const s1 = pos + s.text.length;
      pos = s1;
      if (s1 <= a || s0 >= b) continue;
      if (s.el.local === 'tab') continue;
      const keepHead = s.text.slice(0, Math.max(0, a - s0));
      const keepTail = s.text.slice(Math.max(0, Math.min(s.text.length, b - s0)));
      setText(s.el, placed ? keepHead + keepTail : keepHead + value + keepTail);
      placed = true;
    }
    return placed;
  };
  /** Puts a value right after character `at` of a paragraph (splitting a run when needed). */
  const insertAfter = (ss: Seg[], at: number, value: string) => {
    let pos = 0;
    for (const s of ss) {
      const s1 = pos + s.text.length;
      if (at > pos && at <= s1) {
        const run = s.run;
        const holder = parent.get(run);
        if (!holder) return false;
        const head = s.text.slice(0, at - pos);
        if (s.el.local === 't' && at < s1) {
          // Split the run: the rest of its text (and what follows it) moves to a copy just after it.
          const i = run.children.indexOf(s.el);
          const rPr = kid(run, 'rPr');
          const copy = w('r', { ...run.attrs }, [...(rPr ? [cloneEl(rPr)] : []), tText(s.text.slice(at - pos)), ...run.children.slice(i + 1)]);
          run.children = run.children.slice(0, i + 1);
          setText(s.el, head);
          holder.children.splice(holder.children.indexOf(run) + 1, 0, copy);
          parent.set(copy, holder);
        }
        const r = newRun(rPrOf(run, true), (/\s$/.test(head) ? '' : ' ') + value);
        holder.children.splice(holder.children.indexOf(run) + 1, 0, r);
        parent.set(r, holder);
        return true;
      }
      pos = s1;
    }
    return false;
  };
  /** Puts a value in an empty table cell, in the look of its paragraph mark. */
  const fillCell = (tc: XmlElement, value: string, labelRun?: XmlElement) => {
    let p = all(tc, 'p').find((x) => up(x, 'tc') === tc);
    if (!p) {
      p = w('p');
      tc.children.push(p);
      parent.set(p, tc);
    }
    for (const s of segs(p)) {
      const holder = parent.get(s.run);
      if (holder) holder.children = holder.children.filter((c) => c !== s.run);
    }
    const mark = kid(kid(p, 'pPr') ?? w('pPr'), 'rPr');
    const rPr = mark ? cloneEl(mark) : rPrOf(labelRun, true);
    const r = newRun(rPr, value);
    p.children.push(r);
    parent.set(r, p);
  };
  // Cells by grid column (a cell spanning columns counts from its first one).
  const gridRow = (tr: XmlElement) => {
    const out: { tc: XmlElement; col: number }[] = [];
    let col = 0;
    for (const tc of kids(tr).filter((x) => isW(x, 'tc'))) {
      out.push({ tc, col });
      col += Number(attr(find(tc, 'gridSpan'), 'val') ?? 1) || 1;
    }
    return out;
  };
  const rowsOf = (tbl: XmlElement) => kids(tbl).filter((x) => isW(x, 'tr'));
  const isLabelCell = (t: string) => !/_{2,}/.test(t) && t.trim().length > 0 && t.length <= 200;

  const fields: FieldResult[] = [];
  const checks: { f: FieldResult; value: string; near?: string; line?: string }[] = [];
  const used = new Set<XmlElement>();
  const ok = (f: FieldResult, value: string, where: string, check: { near?: string; line?: string }) => {
    const done = { ...f, status: 'filled' as const, where };
    fields.push(done);
    checks.push({ f: done, value, ...check });
  };
  const labelsSeen: string[] = [];

  for (const it of items) {
    if (it.kind === 'cell') {
      fields.push({ field: it.cell, value: shown(it.value), status: 'not_found', detail: 'cell addresses are for spreadsheets; in a Word form, give the label instead' });
      continue;
    }
    if (it.kind === 'label') {
      const want = normLabel(it.label);
      const value = shown(it.value);
      const f: FieldResult = { field: it.label, value, status: 'not_found' };
      // 1) A content control named or tagged like the label.
      const sdts = all(body, 'sdt').filter((s) => {
        const pr = kid(s, 'sdtPr');
        return [attr(kid(pr, 'alias'), 'val'), attr(kid(pr, 'tag'), 'val')].some((n) => n && normLabel(n) === want);
      });
      if (sdts.length > 1) {
        fields.push({ ...f, status: 'ambiguous', detail: `${sdts.length} fill-in boxes are named like that` });
        continue;
      }
      if (sdts.length === 1) {
        const sdt = sdts[0];
        const pr = kid(sdt, 'sdtPr');
        if (pr) pr.children = pr.children.filter((c) => typeof c === 'string' || c.local !== 'showingPlcHdr');
        const content = kid(sdt, 'sdtContent') ?? w('sdtContent');
        const ts = all(content, 't');
        if (ts.length) {
          const run = parent.get(ts[0])!;
          const rp = kid(run, 'rPr');
          if (rp) rp.children = rp.children.filter((c) => typeof c === 'string' || c.local !== 'rStyle' || !/placeholder/i.test(attr(c, 'val') ?? ''));
          setText(ts[0], value);
          for (const t of ts.slice(1)) setText(t, '');
        } else {
          const p = all(content, 'p')[0];
          (p ?? content).children.push(newRun(undefined, value));
          if (!kid(sdt, 'sdtContent')) sdt.children.push(content);
        }
        ok(f, value, 'a fill-in box', {});
        continue;
      }
      // 2) A table cell that holds just the label: the value goes in the next cell (or the one below).
      const cellHits: { tc: XmlElement; target?: XmlElement }[] = [];
      for (const tbl of all(body, 'tbl')) {
        const rows = rowsOf(tbl);
        rows.forEach((tr, ri) => {
          const g = gridRow(tr);
          g.forEach(({ tc, col }, ci) => {
            const t = cellText(tc);
            if (!isLabelCell(t) || normLabel(t) !== want) return;
            const right = g[ci + 1]?.tc;
            const below = rows[ri + 1] ? gridRow(rows[ri + 1]).find((x) => x.col === col)?.tc : undefined;
            const free = (x?: XmlElement) => x && !used.has(x) && isBlank(cellText(x)) ? x : undefined;
            cellHits.push({ tc, target: free(right) ?? free(below) });
          });
        });
      }
      if (cellHits.length) {
        const open = cellHits.filter((h) => h.target);
        if (open.length > 1) fields.push({ ...f, status: 'ambiguous', detail: `that label is in ${open.length} table cells` });
        else if (!open.length) fields.push({ ...f, status: 'no_space', detail: 'the cells next to and below that label already have text' });
        else {
          const labelRun = segs(all(open[0].tc, 'p')[0] ?? w('p'))[0]?.run;
          fillCell(open[0].target!, value, labelRun);
          used.add(open[0].target!);
          ok(f, value, 'the table cell next to the label', { line: it.label });
        }
        continue;
      }
      // 3) The label inside a paragraph, followed by a blank (____, nothing, a [placeholder]).
      const words = it.label.trim().replace(/[\s:：]+$/, '');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')})(\\s*[:：])?`, 'giu');
      type Hit = { p: XmlElement; ss: Seg[]; act: 'replace' | 'insert'; a: number; b: number };
      const hits: Hit[] = [];
      let found = 0;
      for (const p of all(body, 'p')) {
        const ss = segs(p);
        const text = ss.map((s) => s.text).join('');
        if (!text) continue;
        for (const mm of text.matchAll(re)) {
          found++;
          const end = mm.index + mm[0].length;
          const rest = text.slice(end);
          const colon = Boolean(mm[3]);
          let k: RegExpExecArray | null;
          if ((k = /^([ \t]*)(_{2,}|\.{4,}|…+|\[[^\]\n]{0,60}\]|<[^>\n]{0,60}>|\{[^}\n]{0,60}\})/.exec(rest))) hits.push({ p, ss, act: 'replace', a: end + k[1].length, b: end + k[0].length });
          else if (/^[ \t]*$/.test(rest) && (colon || !text.slice(0, mm.index + mm[1].length).trim())) hits.push({ p, ss, act: 'insert', a: end, b: end });
          else if (colon && /^[ \t]+[^\s:][^:\n]{0,40}:/.test(rest)) hits.push({ p, ss, act: 'insert', a: end, b: end });
        }
      }
      if (hits.length > 1) fields.push({ ...f, status: 'ambiguous', detail: `that label has a blank after it in ${hits.length} places` });
      else if (!hits.length) fields.push(found ? { ...f, status: 'no_space', detail: 'that label already has text after it' } : { ...f, detail: 'no label like that in the form' });
      else {
        const h = hits[0];
        const done = h.act === 'replace' ? replaceRange(h.ss, h.a, h.b, value) : insertAfter(h.ss, h.a, value);
        if (done) ok(f, value, 'after the label', { near: words });
        else fields.push({ ...f, status: 'no_space', detail: "couldn't place the value there" });
      }
      continue;
    }
    // A table by its header: rows found by their label in that column.
    const want = normLabel(it.table);
    let best: { tbl: XmlElement; head: number; col: number; cols: Map<string, number>; score: number } | undefined;
    for (const tbl of all(body, 'tbl')) {
      rowsOf(tbl).forEach((tr, ri) => {
        const g = gridRow(tr);
        const hit = g.find(({ tc }) => normLabel(cellText(tc)) === want);
        if (!hit) return;
        const cols = new Map<string, number>();
        for (const { tc, col } of g) {
          const n = normLabel(cellText(tc));
          if (n && !cols.has(n)) cols.set(n, col);
        }
        const score = it.rows.flatMap((r) => Object.keys(r)).filter((k) => cols.has(normLabel(k))).length;
        if (!best || score > best.score) best = { tbl, head: ri, col: hit.col, cols, score };
      });
    }
    for (const row of it.rows) {
      const keys = Object.keys(row);
      const rowKey = keys.find((k) => normLabel(k) === want) ?? keys[0];
      const rowLabel = shown(row[rowKey] ?? '');
      for (const k of keys) {
        if (k === rowKey) continue;
        const value = shown(row[k]);
        const f: FieldResult = { field: `${it.table} ${rowLabel} / ${k}`, value, status: 'not_found' };
        if (!best) {
          fields.push({ ...f, detail: `no table with a "${it.table}" column header` });
          continue;
        }
        const b = best;
        const rows = rowsOf(b.tbl);
        const tr = rows.slice(b.head + 1).find((r) => gridRow(r).some(({ tc, col }) => col === b.col && normLabel(cellText(tc)) === normLabel(rowLabel)));
        if (!tr) {
          fields.push({ ...f, detail: `no row "${rowLabel}" under ${it.table}` });
          continue;
        }
        let col = b.cols.get(normLabel(k));
        if (col === undefined) {
          const near = [...b.cols.entries()].filter(([n]) => n.includes(normLabel(k)) || normLabel(k).includes(n));
          if (near.length === 1) col = near[0][1];
        }
        const cell = col === undefined ? undefined : gridRow(tr).find((x) => x.col === col)?.tc;
        if (!cell) {
          fields.push({ ...f, detail: `no column "${k}" in that table (columns: ${[...b.cols.keys()].join(', ').toUpperCase()})` });
          continue;
        }
        if (!isBlank(cellText(cell)) || used.has(cell)) {
          fields.push({ ...f, status: 'no_space', detail: `that cell already says "${cellText(cell).slice(0, 60)}"` });
          continue;
        }
        fillCell(cell, value);
        used.add(cell);
        ok(f, value, `the table under ${it.table}`, { line: rowLabel });
      }
    }
  }

  for (const p of all(body, 'p')) {
    for (const mm of textOfP(p).matchAll(/(?:^|[\t ]{2,}|\t)([\p{L}][\p{L}\p{N} #./()'-]{0,38}?)\s*:/gu)) labelsSeen.push(mm[1].trim());
  }
  const data = repack(zip, new Map([[main, serializeXml(root)]]));
  // Check the copy with the Library's reader.
  const read = readDocx(openZip(data)).parts.map((p) => p.text).join('\n');
  const flat = fold(read).replace(/\s+/g, ' ');
  for (const c of checks) {
    const v = fold(c.value).replace(/\s+/g, ' ').trim();
    let good: boolean;
    if (c.line) good = fold(read).split('\n').some((l) => l.replace(/\s+/g, ' ').includes(fold(c.line!).replace(/\s+/g, ' ').trim()) && l.replace(/\s+/g, ' ').includes(v));
    else if (c.near) {
      const n = fold(c.near).replace(/\s+/g, ' ');
      good = false;
      for (let i = flat.indexOf(n); i >= 0 && !good; i = flat.indexOf(n, i + 1)) good = flat.slice(i, i + n.length + v.length + 300).includes(v);
    } else good = flat.includes(v);
    if (!good) Object.assign(c.f, { status: 'not_verified', detail: "reading the copy back didn't show it in place" });
  }
  return finish('docx', data, fields, labelsSeen);
}

/** The tool's words for a result: \"Filled 23 of 23 fields\", or what's missing and why. */
export function fillReport(r: FillResult): string {
  const lines = [`Filled ${r.filled} of ${r.total} field${r.total === 1 ? '' : 's'} (each one checked by reading the new copy back).`];
  const bad = r.fields.filter((f) => f.status !== 'filled');
  if (bad.length) {
    const why: Record<FieldStatus, string> = { filled: '', not_found: 'not found', ambiguous: 'ambiguous', formula: 'left as is', no_space: 'no empty place', not_verified: 'not confirmed' };
    lines.push('Not filled:');
    for (const f of bad.slice(0, 40)) lines.push(`- ${f.field}: ${f.status === 'not_found' && f.detail === 'no label like that in the form' ? 'no label like that in the form' : `${why[f.status]}${f.detail ? ` (${f.detail})` : ''}`}`);
    if (bad.length > 40) lines.push(`- …and ${bad.length - 40} more`);
    if (r.labels.length) lines.push(`Labels in this form: ${r.labels.join(', ')}.`);
  }
  return lines.join('\n');
}

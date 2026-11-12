// fill_document for PDF forms (docs/DOCUMENTS.md): the person's own fillable PDF (an AcroForm) gets
// their values in a new copy. The copy is the original file, byte for byte, with an incremental
// update appended (the changed field and widget objects, new appearance streams, a new
// cross-reference section pointing back at the old one), so everything else in the file (and any
// signature over the original bytes) stays as it was. Fields are found by their full name, their
// own name, their tooltip, or the words printed next to the box on the page. Text gets a simple
// appearance drawn in the field's font, and NeedAppearances asks viewers to draw it again their
// way. The copy is read back with the same reader and every value is checked before anything is
// reported. Protected PDFs, XFA-only forms and flat (non-fillable) PDFs are refused plainly.
import { deflateSync } from 'node:zlib';
import { isPdfDict, isPdfStream, PdfBook, PdfDoc, PdfName, PdfRef, PdfString, pdfTextString, type PdfDict, type PdfRun, type PdfValue } from '../library/pdf.ts';
import { BufferSource } from '../library/source.ts';
import { DocError } from './spec.ts';
import type { FieldResult, FillItem, FillResult, FillValue } from './fill.ts';

export type PdfFieldKind = 'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button';
interface Widget {
  num: number;
  dict: PdfDict;
  page: number;
  rect: [number, number, number, number];
  /** Its "on" appearance state (check boxes and radio buttons). */
  on?: string;
}
export interface PdfField {
  /** The full name (partial names joined with dots). */
  name: string;
  /** Its own (last) part. */
  partial: string;
  tooltip?: string;
  kind: PdfFieldKind;
  flags: number;
  value: string;
  /** Choices: export value and what it shows. Check boxes and radio buttons: per widget. */
  options: { exp: string; label: string }[];
  maxLen?: number;
  q: number;
  da: string;
  num: number;
  dict: PdfDict;
  widgets: Widget[];
}

const FF = { readOnly: 1, multiline: 1 << 12, password: 1 << 13, radio: 1 << 15, push: 1 << 16, combo: 1 << 17, edit: 1 << 18, fileSelect: 1 << 20, comb: 1 << 24 };
const PROTECTED = 'This PDF is protected; ask for an unprotected copy (or the form as Excel or Word).';
const XFA_ONLY = "This PDF form is an XFA (LiveCycle) form, which can't be filled here; ask for a regular PDF form, or the form as Excel or Word.";
const FLAT = "This PDF has no fillable fields. She can make a new document with the values instead (make_document), or fill an Excel or Word version of the form if there is one.";
const DAMAGED = "This PDF's structure is damaged, so it can't be filled safely; ask for a fresh copy of the form.";

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Text for matching: no case, accents, punctuation or [0] indexes. */
const key = (s: string) => fold(s).replace(/\[\d+\]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const shown = (v: FillValue) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
const ON = new Set(['yes', 'y', 'true', 'x', 'checked', 'check', 'on', '1', 'si', 'oui', 'ja', 'sim', 'selected']);
const OFF = new Set(['no', 'n', 'false', 'unchecked', 'off', '0', 'none', 'non', 'nein', 'nao']);
const CHECK_MARK = /^[\u2713\u2714\u2611\u2612]$/u;

// ---------------------------------------------------------------- reading the form

export interface PdfForm {
  book: PdfBook;
  doc: PdfDoc;
  fields: PdfField[];
  acro?: PdfDict;
  /** The AcroForm's own object number, or undefined when it sits inside the catalog. */
  acroNum?: number;
  rootNum?: number;
  xfa: boolean;
}

const str = (doc: PdfDoc, v: PdfValue | undefined): string | undefined => {
  const r = doc.get(v);
  if (r instanceof PdfString) return pdfTextString(r.bytes).replace(/\0/g, '');
  if (r instanceof PdfName) return r.name;
  return undefined;
};

/** Opens a PDF and reads its form fields (refusing protected files). */
export function readPdfForm(bytes: Buffer): PdfForm {
  const probe = new PdfDoc(new BufferSource(bytes));
  if (probe.trailer.has('Encrypt')) throw new DocError(PROTECTED);
  let book: PdfBook;
  try {
    book = new PdfBook(new BufferSource(bytes));
  } catch (err) {
    throw new DocError(`This PDF couldn't be opened: ${(err as Error).message}`);
  }
  const doc = book.doc;
  const rootRef = doc.trailer.get('Root');
  const root = book.root;
  const acroV = root.get('AcroForm');
  const acro = doc.dict(acroV);
  const form: PdfForm = { book, doc, fields: [], ...(acro ? { acro } : {}), ...(acroV instanceof PdfRef ? { acroNum: acroV.num } : {}), ...(rootRef instanceof PdfRef ? { rootNum: rootRef.num } : {}), xfa: Boolean(acro?.has('XFA')) };
  if (!acro) return form;
  // Which page each widget is on.
  const pageOf = new Map<number, number>();
  book.pages.forEach((p, i) => {
    for (const a of doc.arr(p.dict.get('Annots'))) if (a instanceof PdfRef && !pageOf.has(a.num)) pageOf.set(a.num, i);
  });
  const pageNums = new Map<number, number>();
  book.pages.forEach((p, i) => p.num !== undefined && pageNums.set(p.num, i));
  const da0 = str(doc, acro.get('DA')) ?? '';
  const q0 = doc.num(acro.get('Q'), 0);
  const seen = new Set<PdfDict>();
  type Inh = { ft?: string; ff: number; da?: string; q?: number; v?: PdfValue; opt?: PdfValue; maxLen?: number; tu?: string };
  const widgetOf = (ref: PdfValue, d: PdfDict): Widget | undefined => {
    if (!(ref instanceof PdfRef)) return undefined;
    const r = doc.arr(d.get('Rect')).map((x) => doc.num(x));
    const rect: [number, number, number, number] = r.length >= 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : [0, 0, 0, 0];
    const p = d.get('P');
    const page = pageOf.get(ref.num) ?? (p instanceof PdfRef ? pageNums.get(p.num) : undefined) ?? -1;
    const n = doc.dict(doc.dict(d.get('AP'))?.get('N'));
    const on = n ? [...n.keys()].find((k) => k !== 'Off') : undefined;
    return { num: ref.num, dict: d, page, rect, ...(on ? { on } : {}) };
  };
  const walk = (ref: PdfValue, parent: string, inh: Inh, depth: number) => {
    const d = doc.dict(ref);
    if (!d || seen.has(d) || depth > 32 || form.fields.length > 5000) return;
    seen.add(d);
    const t = str(doc, d.get('T'));
    const name = t !== undefined ? (parent ? `${parent}.${t}` : t) : parent;
    const here: Inh = {
      ft: doc.name(d.get('FT')) ?? inh.ft,
      ff: d.has('Ff') ? doc.num(d.get('Ff')) : inh.ff,
      da: str(doc, d.get('DA')) ?? inh.da,
      q: d.has('Q') ? doc.num(d.get('Q')) : inh.q,
      v: d.has('V') ? d.get('V') : inh.v,
      opt: d.has('Opt') ? d.get('Opt') : inh.opt,
      maxLen: d.has('MaxLen') ? doc.num(d.get('MaxLen')) : inh.maxLen,
      tu: str(doc, d.get('TU')) ?? inh.tu,
    };
    const kids = doc.arr(d.get('Kids')).map((k) => ({ ref: k, d: doc.dict(k) })).filter((k): k is { ref: PdfValue; d: PdfDict } => Boolean(k.d));
    const childFields = kids.filter((k) => k.d.has('T') || (k.d.has('Kids') && !k.d.has('Rect')));
    if (childFields.length) {
      for (const k of childFields) walk(k.ref, name, here, depth + 1);
      return;
    }
    if (!(ref instanceof PdfRef) || !name) return;
    const widgets = (kids.length ? kids.map((k) => widgetOf(k.ref, k.d)) : [widgetOf(ref, d)]).filter((w): w is Widget => Boolean(w));
    const ff = here.ff;
    const kind: PdfFieldKind = here.ft === 'Tx' ? 'text' : here.ft === 'Ch' ? 'choice' : here.ft === 'Sig' ? 'signature' : here.ft === 'Btn' ? (ff & FF.push ? 'button' : ff & FF.radio ? 'radio' : 'checkbox') : 'text';
    if (!here.ft) return;
    const options: { exp: string; label: string }[] = [];
    for (const o of doc.arr(here.opt)) {
      const v = doc.get(o);
      if (Array.isArray(v)) options.push({ exp: str(doc, v[0]) ?? '', label: str(doc, v[1]) ?? str(doc, v[0]) ?? '' });
      else {
        const s = str(doc, v);
        if (s !== undefined) options.push({ exp: s, label: s });
      }
    }
    const vv = doc.get(here.v);
    const value = Array.isArray(vv) ? (str(doc, vv[0]) ?? '') : (str(doc, vv) ?? '');
    form.fields.push({ name, partial: t ?? name.split('.').pop() ?? name, ...(here.tu ? { tooltip: here.tu } : {}), kind, flags: ff, value, options, ...(here.maxLen ? { maxLen: here.maxLen } : {}), q: here.q ?? q0, da: here.da ?? da0, num: ref.num, dict: d, widgets });
  };
  for (const f of doc.arr(acro.get('Fields'))) walk(f, '', { ff: 0 }, 0);
  return form;
}

/** A field's current value as people say it. */
function valueText(f: PdfField): string {
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    if (!f.value || f.value === 'Off') return 'Off';
    const i = f.widgets.findIndex((w) => w.on === f.value);
    return f.options[i]?.label ?? f.value;
  }
  if (f.kind === 'choice') return f.options.find((o) => o.exp === f.value)?.label ?? f.value;
  return f.value;
}

/** The short "Form fields" section the Library shows for a fillable PDF (so the model sees the names). */
export function formFieldsText(bytes: Buffer, max = 150): string {
  let form: PdfForm;
  try {
    form = readPdfForm(bytes);
  } catch {
    return '';
  }
  const fields = form.fields.filter((f) => f.kind !== 'button');
  if (!fields.length) return '';
  const runs = new Map<number, PdfRun[]>();
  const printed = (f: PdfField): string | undefined => {
    const w = f.widgets[0];
    if (!w || w.page < 0 || f.kind === 'radio') return undefined;
    if (!runs.has(w.page)) {
      try {
        runs.set(w.page, form.book.run(w.page).out.runs);
      } catch {
        runs.set(w.page, []);
      }
    }
    return nearLabel(runs.get(w.page)!, w.rect, f.kind === 'checkbox');
  };
  const lines = fields.slice(0, max).map((f) => {
    const kind = f.kind === 'text' ? '' : f.kind === 'checkbox' ? ' [checkbox]' : f.kind === 'radio' ? ` [choose: ${f.widgets.map((w, i) => f.options[i]?.label ?? w.on).filter(Boolean).join(' / ')}]` : f.kind === 'choice' ? ` [choose: ${f.options.slice(0, 12).map((o) => o.label).join(' / ')}]` : ' [signature]';
    const words = f.tooltip ?? printed(f);
    const label = words && key(words) !== key(f.name) ? ` ("${words.replace(/\s+/g, ' ').slice(0, 80)}")` : '';
    const ro = f.flags & FF.readOnly ? ' [read-only]' : '';
    return `- ${f.name}${label}${kind}${ro} = ${valueText(f).replace(/\s+/g, ' ').slice(0, 120)}`;
  });
  if (fields.length > max) lines.push(`- …and ${fields.length - max} more`);
  return `Form fields (fillable with fill_document; name = current value):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- the words next to a box

/**
 * The words printed next to a box: for a check box or radio button the words just right of it
 * (else left); for a text box the words just left of it, else the label block right above it
 * (its lines starting where the box starts, read top to bottom).
 */
function nearLabel(runs: PdfRun[], rect: [number, number, number, number], check = false): string | undefined {
  const [x1, y1, x2, y2] = rect;
  const live = runs.filter((r) => r.text.trim());
  const sameRow = (r: PdfRun) => r.y >= y1 - r.size * 0.6 && r.y <= y2 + r.size * 0.2;
  /** The run's line, grown from it to the left (-1) or right (1) while the words are close. */
  const line = (seed: PdfRun, dir: -1 | 1, ok: (r: PdfRun) => boolean) => {
    const row = live.filter((r) => r === seed || (Math.abs(r.y - seed.y) < Math.max(1, seed.size * 0.35) && ok(r))).sort((a, b) => a.x - b.x);
    let lo = row.indexOf(seed);
    let hi = lo;
    if (dir < 0) while (lo > 0 && row[lo].x - row[lo - 1].endX < seed.size * 1.5) lo--;
    else while (hi + 1 < row.length && row[hi + 1].x - row[hi].endX < seed.size * 1.5) hi++;
    let s = '';
    for (let i = lo; i <= hi; i++) s += (i > lo && row[i].x - row[i - 1].endX > row[i].size * 0.15 ? ' ' : '') + row[i].text;
    return s.replace(/\s+/g, ' ').trim();
  };
  const words = (s: string | undefined) => (s && /\p{L}/u.test(s) ? s : undefined);
  const right = () => {
    const seed = live.filter((r) => sameRow(r) && r.x >= x2 - 1 && r.x - x2 < 16).sort((a, b) => a.x - b.x)[0];
    return seed ? words(line(seed, 1, (r) => r.x >= x2 - 1)) : undefined;
  };
  const left = () => {
    const seed = live.filter((r) => sameRow(r) && r.endX <= x1 + 3 && x1 - r.endX < 60).sort((a, b) => b.endX - a.endX)[0];
    return seed ? words(line(seed, -1, (r) => r.endX <= x1 + 3)) : undefined;
  };
  const above = () => {
    const seed = live.filter((r) => r.y > y2 - 1 && r.y < y2 + Math.max(14, (y2 - y1) * 1.5) && r.x >= x1 - 8 && r.x < x1 + Math.max(40, (x2 - x1) / 2)).sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (!seed) return undefined;
    const within = (r: PdfRun) => r.x >= x1 - 8 && r.x <= x2 + 200;
    const lines = [line(seed, 1, within)];
    let y = seed.y;
    for (let k = 0; k < 3; k++) {
      const up = live.filter((r) => r.y > y + 0.5 && r.y <= y + seed.size * 1.6 && r.x >= x1 - 8 && r.x <= seed.x + 4).sort((a, b) => a.y - b.y || a.x - b.x)[0];
      if (!up) break;
      lines.unshift(line(up, 1, within));
      y = up.y;
    }
    return words(lines.join(' '));
  };
  return check ? (right() ?? left()) : (left() ?? above());
}

// ---------------------------------------------------------------- writing values

const winAnsi = new Map<number, number>([[0x20ac, 0x80], [0x201a, 0x82], [0x192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x2c6, 0x88], [0x2030, 0x89], [0x160, 0x8a], [0x2039, 0x8b], [0x152, 0x8c], [0x17d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x2dc, 0x98], [0x2122, 0x99], [0x161, 0x9a], [0x203a, 0x9b], [0x153, 0x9c], [0x17e, 0x9e], [0x178, 0x9f]]);
/** Text as WinAnsi bytes for a simple font (what it can't show becomes "?"). */
const ansi = (s: string): number[] => [...s].map((ch) => {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff)) return c;
  return winAnsi.get(c) ?? 0x3f;
});
// Helvetica's advance widths (1/1000 em) for codes 32-126, from its published font metrics.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** A PDF literal string for a content stream (bytes escaped). */
const lit = (bytes: number[]) => `(${bytes.map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b))).join('')})`;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

/** A field value as a PDF text string: PDFDocEncoding when it fits Latin-1, else UTF-16BE with a byte-order mark. */
export function pdfTextBytes(s: string): Buffer {
  if ([...s].every((ch) => { const c = ch.codePointAt(0)!; return c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0x7f) || (c >= 0xa1 && c <= 0xff); })) return Buffer.from(s, 'latin1');
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
}

/** One value written out as PDF syntax. */
function ser(v: PdfValue | undefined): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'number') return fmt(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof PdfName) return `/${[...v.name].map((ch) => { const c = ch.charCodeAt(0); return c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch) ? `#${c.toString(16).padStart(2, '0')}` : ch; }).join('')}`;
  if (v instanceof PdfString) {
    const b = v.bytes;
    const printable = [...b].every((c) => c >= 0x20 && c < 0x7f);
    return printable ? lit([...b]) : `<${b.toString('hex')}>`;
  }
  if (v instanceof PdfRef) return `${v.num} ${v.gen} R`;
  if (Array.isArray(v)) return `[${v.map(ser).join(' ')}]`;
  if (isPdfDict(v)) return `<<${[...v].map(([k, x]) => `${ser(new PdfName(k))} ${ser(x)}`).join(' ')}>>`;
  throw new DocError('A form field object holds a stream where it should not.');
}

interface Font {
  /** The resource name in the appearance. */
  res: string;
  ref: PdfValue;
  size: number;
  color: string;
  widths: (c: number) => number;
}

/** Fills a copy of a PDF form. */
export function fillPdf(bytes: Buffer, items: FillItem[]): FillResult {
  const form = readPdfForm(bytes);
  const { doc, acro } = form;
  const fields = form.fields;
  if (!acro || !fields.length) {
    if (form.xfa) throw new DocError(XFA_ONLY);
    throw new DocError(FLAT);
  }
  if (doc.mode !== 'xref') throw new DocError(DAMAGED);
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString('latin1');
  const sx = /startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(tail.slice(tail.lastIndexOf('startxref')));
  const prev = sx ? Number(sx[1]) : -1;
  if (prev < 0 || prev >= bytes.length) throw new DocError(DAMAGED);
  const classic = /^\s*xref/.test(bytes.subarray(prev, prev + 32).toString('latin1'));

  // ---- objects to write
  const dirty = new Set<number>();
  const fresh: { num: number; body: Buffer }[] = [];
  let next = Math.max(doc.num(doc.trailer.get('Size')), ...[...doc.objs.keys()].map((n) => n + 1));
  if (!Number.isFinite(next) || next < 1) next = 1;
  const touchAcro = () => dirty.add(form.acroNum ?? form.rootNum ?? -1);
  /** A dictionary inside another, made editable (marking whichever object holds it). */
  const sub = (holder: PdfDict, holderNum: number, k: string): { d: PdfDict; num: number } => {
    const v = holder.get(k);
    if (v instanceof PdfRef) {
      const d = doc.dict(v);
      if (d && !isPdfStream(doc.get(v))) return { d, num: v.num };
    }
    if (isPdfDict(v)) return { d: v, num: holderNum };
    const d: PdfDict = new Map();
    holder.set(k, d);
    dirty.add(holderNum);
    return { d, num: holderNum };
  };
  const acroNum = form.acroNum ?? form.rootNum ?? -1;
  let helv: PdfValue | undefined;
  const fontFor = (f: PdfField): Font => {
    const m = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(f.da);
    const color = (/((?:[\d.]+\s+){1,4})(g|rg|k)\b/.exec(f.da.replace(/\/[^\s/]+\s+[\d.]+\s+Tf/, ''))?.[0] ?? '0 g').trim();
    const size = m ? Number(m[2]) : 0;
    const dr = doc.dict(acro.get('DR'));
    const fonts = doc.dict(dr?.get('Font'));
    const named = m ? fonts?.get(m[1]) : undefined;
    const fd = doc.dict(named);
    const simple = fd && ['Type1', 'TrueType', 'MMType1'].includes(doc.name(fd.get('Subtype')) ?? '');
    if (m && named !== undefined && fd && simple) {
      const first = doc.num(fd.get('FirstChar'), 0);
      const ws = doc.arr(fd.get('Widths')).map((x) => doc.num(x));
      const base = doc.name(fd.get('BaseFont')) ?? '';
      const fixed = /Courier/i.test(base) ? 600 : 0;
      return { res: m[1], ref: named, size, color, widths: (c) => (ws.length && c >= first && c < first + ws.length ? ws[c - first] : fixed || (HELV[c - 32] ?? 556)) };
    }
    if (!helv) {
      const { d: drD, num: drNum } = sub(acro, acroNum, 'DR');
      const { d: fontD, num: fontNum } = sub(drD, drNum, 'Font');
      const had = fontD.get('Helv');
      if (had !== undefined && doc.dict(had)) helv = had;
      else {
        const num = next++;
        fresh.push({ num, body: Buffer.from('<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>', 'latin1') });
        helv = new PdfRef(num, 0);
        fontD.set('Helv', helv);
        dirty.add(fontNum);
      }
    }
    return { res: 'Helv', ref: helv, size, color, widths: (c) => HELV[c - 32] ?? 556 };
  };

  /** A simple appearance for a text (or combo box) widget: the value in the field's font, size and alignment. */
  const appearance = (f: PdfField, w: Widget, text: string): PdfRef => {
    const width = Math.max(1, w.rect[2] - w.rect[0]);
    const height = Math.max(1, w.rect[3] - w.rect[1]);
    const font = fontFor(f);
    const pad = 2;
    const tw = (b: number[], size: number) => b.reduce((n, c) => n + font.widths(c), 0) * size / 1000;
    const ops: string[] = [];
    const multiline = Boolean(f.flags & FF.multiline) && f.kind === 'text';
    const comb = Boolean(f.flags & FF.comb) && f.kind === 'text' && f.maxLen && !multiline;
    let size = font.size;
    const shown = f.flags & FF.password ? '*'.repeat([...text].length) : text;
    if (comb && f.maxLen) {
      if (!size) size = Math.max(4, Math.min(12, (height - 4) / 1.15));
      const cell = width / f.maxLen;
      const y = (height - size * 0.925) / 2 + size * 0.207;
      ansi(shown).forEach((c, i) => {
        const cw = font.widths(c) * size / 1000;
        ops.push(`1 0 0 1 ${fmt(i * cell + (cell - cw) / 2)} ${fmt(y)} Tm ${lit([c])} Tj`);
      });
    } else if (multiline) {
      const wrap = (sz: number) => {
        const lines: number[][] = [];
        for (const para of shown.split(/\r\n|\r|\n/)) {
          let line: number[] = [];
          for (const word of para.split(/(\s+)/)) {
            const wb = ansi(word);
            if (line.length && tw([...line, ...wb], sz) > width - 2 * pad && word.trim()) {
              lines.push(line);
              line = ansi(word.trimStart());
            } else line.push(...wb);
          }
          lines.push(line);
        }
        return lines;
      };
      if (!size) {
        size = 12;
        while (size > 4 && wrap(size).length * size * 1.15 > height - 2 * pad) size -= 0.5;
      }
      const lines = wrap(size);
      let y = height - pad - size * 0.85;
      for (const l of lines) {
        const lw = tw(l, size);
        const x = f.q === 1 ? (width - lw) / 2 : f.q === 2 ? width - pad - lw : pad;
        ops.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm ${lit(l)} Tj`);
        y -= size * 1.15;
      }
    } else {
      const b = ansi(shown.replace(/\s*[\r\n]+\s*/g, ' '));
      if (!size) {
        size = Math.max(4, Math.min(12, (height - 4) / 1.15));
        const full = tw(b, size);
        if (full > width - 2 * pad) size = Math.max(4, size * (width - 2 * pad) / full);
      }
      const lw = tw(b, size);
      const x = f.q === 1 ? (width - lw) / 2 : f.q === 2 ? width - pad - lw : pad;
      const y = (height - size * 0.925) / 2 + size * 0.207;
      ops.push(`1 0 0 1 ${fmt(Math.max(pad, x))} ${fmt(y)} Tm ${lit(b)} Tj`);
    }
    // The box's own background and border (its /MK colors), as viewers draw them.
    const mk = doc.dict(w.dict.get('MK'));
    const color = (v: PdfValue | undefined, stroke: boolean) => {
      const c = doc.arr(v).map((x) => fmt(doc.num(x)));
      const op = c.length === 1 ? 'g' : c.length === 3 ? 'rg' : c.length === 4 ? 'k' : '';
      return op ? `${c.join(' ')} ${stroke ? op.toUpperCase() : op}` : '';
    };
    const bg = color(mk?.get('BG'), false);
    const bc = color(mk?.get('BC'), true);
    const bw = doc.num(doc.dict(w.dict.get('BS'))?.get('W'), 1);
    let frame = '';
    if (bg) frame += `q ${bg} 0 0 ${fmt(width)} ${fmt(height)} re f Q\n`;
    if (bc && bw > 0) frame += `q ${bc} ${fmt(bw)} w ${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(width - bw)} ${fmt(height - bw)} re S Q\n`;
    const content = `${frame}/Tx BMC\nq\n1 1 ${fmt(width - 2)} ${fmt(height - 2)} re W n\nBT\n${font.color}\n/${font.res} ${fmt(size)} Tf\n${ops.join('\n')}\nET\nQ\nEMC\n`;
    const num = next++;
    const body = Buffer.concat([Buffer.from(`<</Type /XObject /Subtype /Form /BBox [0 0 ${fmt(width)} ${fmt(height)}] /Resources <</Font <<${ser(new PdfName(font.res))} ${ser(font.ref)}>>>> /Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n`, 'latin1'), Buffer.from(content, 'latin1'), Buffer.from('\nendstream', 'latin1')]);
    fresh.push({ num, body });
    return new PdfRef(num, 0);
  };
  const setAp = (w: Widget, ap: PdfRef) => {
    const old = doc.dict(w.dict.get('AP'));
    const d: PdfDict = new Map(old ? [...old].filter(([k]) => k !== 'N' && k !== 'D') : []);
    d.set('N', ap);
    w.dict.set('AP', d);
    dirty.add(w.num);
  };

  // ---- which field each value is for
  const runsCache = new Map<number, PdfRun[]>();
  const runsOf = (page: number): PdfRun[] => {
    if (page < 0) return [];
    if (!runsCache.has(page)) {
      try {
        runsCache.set(page, form.book.run(page).out.runs);
      } catch {
        runsCache.set(page, []);
      }
    }
    return runsCache.get(page)!;
  };
  const near = new Map<PdfField, string | undefined>();
  const nearOf = (f: PdfField) => {
    // (A radio group's words are its choices' words, so it goes by its name and tooltip.)
    if (!near.has(f)) near.set(f, f.widgets[0] && f.kind !== 'radio' ? nearLabel(runsOf(f.widgets[0].page), f.widgets[0].rect, f.kind === 'checkbox') : undefined);
    return near.get(f);
  };
  const stages: ((f: PdfField) => (string | undefined)[])[] = [(f) => [f.name], (f) => [f.partial], (f) => [f.tooltip], (f) => [nearOf(f)]];
  const findField = (label: string): { hits: PdfField[]; how: string } => {
    const want = key(label);
    if (!want) return { hits: [], how: '' };
    const how = ['its name', 'its name', 'its tooltip', 'the words next to it'];
    for (const [i, s] of stages.entries()) {
      const hits = fields.filter((f) => s(f).some((x) => x !== undefined && key(x) === want));
      if (hits.length) return { hits, how: how[i] };
    }
    // Looser: the words of the label inside a tooltip or the words next to the box.
    // (A long printed label like "1 Name of entity/individual. An entry is required…" matches by its start.)
    const re = (x: string) => {
      const k = key(x);
      return (k.length <= want.length + 30 && ` ${k} `.includes(` ${want} `)) || `${k.replace(/^(?:[a-z]?\d+[a-z]?|[a-z])\s+/, '')} `.startsWith(`${want} `);
    };
    const loose = fields.filter((f) => [f.tooltip, nearOf(f)].some((x) => x !== undefined && re(x)));
    return { hits: loose, how: 'its tooltip or the words next to it' };
  };

  const results: FieldResult[] = [];
  const expect: { f: FieldResult; field: PdfField; v: string; kind: 'text' | 'name' }[] = [];
  const taken = new Map<PdfField, string>();
  const optionList = (f: PdfField) => (f.kind === 'radio' ? f.widgets.map((w, i) => f.options[i]?.label ?? w.on).filter(Boolean) : f.options.map((o) => o.label)).slice(0, 20).join(', ');

  for (const it of items) {
    if (it.kind !== 'label') {
      const field = it.kind === 'cell' ? it.cell : it.table;
      results.push({ field, value: it.kind === 'cell' ? shown(it.value) : '', status: 'not_found', detail: it.kind === 'cell' ? 'cell addresses are for spreadsheets; in a PDF form, give the field name or its label' : 'a PDF form has no tables to fill by header; give each field by its name or label' });
      continue;
    }
    const value = shown(it.value);
    const r: FieldResult = { field: it.label, value, status: 'not_found' };
    const { hits, how } = findField(it.label);
    if (!hits.length) {
      results.push({ ...r, detail: 'no field like that in the form' });
      continue;
    }
    if (hits.length > 1) {
      results.push({ ...r, status: 'ambiguous', detail: `${hits.length} fields match by ${how} (${hits.slice(0, 6).map((h) => h.name).join(', ')}); give the field's full name` });
      continue;
    }
    const f = hits[0];
    const where = f.name;
    if (taken.has(f)) {
      results.push({ ...r, status: 'ambiguous', where, detail: `that field was already filled by "${taken.get(f)}"` });
      continue;
    }
    if (f.kind === 'signature') {
      results.push({ ...r, status: 'skipped', where, detail: 'a signature field; they sign it themselves' });
      continue;
    }
    if (f.kind === 'button') {
      results.push({ ...r, status: 'skipped', where, detail: 'a push button, not a field' });
      continue;
    }
    if (f.flags & FF.readOnly) {
      results.push({ ...r, status: 'skipped', where, detail: 'the form marks this field read-only' });
      continue;
    }
    if (!f.widgets.length) {
      results.push({ ...r, status: 'no_space', where, detail: 'the field has no box on any page' });
      continue;
    }
    taken.set(f, it.label);
    const done: FieldResult = { ...r, status: 'filled', where };
    if (f.kind === 'text') {
      if (f.flags & FF.fileSelect) {
        results.push({ ...r, status: 'skipped', where, detail: 'a file-upload field' });
        continue;
      }
      const v = f.flags & FF.multiline ? value : value.replace(/\s*[\r\n]+\s*/g, ' ');
      if (f.maxLen && [...v].length > f.maxLen) {
        results.push({ ...r, status: 'no_space', where, detail: `the box takes at most ${f.maxLen} characters` });
        continue;
      }
      f.dict.set('V', new PdfString(pdfTextBytes(v)));
      dirty.add(f.num);
      for (const w of f.widgets) setAp(w, appearance(f, w, v));
      results.push(done);
      expect.push({ f: done, field: f, v, kind: 'text' });
    } else if (f.kind === 'checkbox' || f.kind === 'radio') {
      const k = key(value);
      let byWidget = f.widgets.findIndex((w, i) => (w.on && key(w.on) === k) || (f.options[i] && (key(f.options[i].label) === k || key(f.options[i].exp) === k)));
      // A radio button by the words printed next to it ("Premium"), when its state names say nothing.
      if (byWidget < 0 && f.kind === 'radio') {
        const hits = f.widgets.map((w, i) => (w.on && key(nearLabel(runsOf(w.page), w.rect, true) ?? '') === k ? i : -1)).filter((i) => i >= 0);
        if (hits.length === 1 && new Set(f.widgets.map((w) => w.on)).size === f.widgets.length) byWidget = hits[0];
      }
      let state: string | undefined;
      if (byWidget >= 0) state = f.widgets[byWidget].on;
      else if (OFF.has(k) || (typeof it.value === 'boolean' && !it.value)) state = 'Off';
      else if (f.kind === 'checkbox' && (ON.has(k) || it.value === true || CHECK_MARK.test(value.trim()))) state = f.widgets.find((w) => w.on)?.on;
      if (!state) {
        results.push({ ...r, status: 'invalid', where, detail: f.kind === 'checkbox' ? 'a check box takes yes or no' : `not one of its choices (${optionList(f)})` });
        continue;
      }
      f.dict.set('V', new PdfName(state));
      dirty.add(f.num);
      for (const w of f.widgets) {
        w.dict.set('AS', new PdfName(w.on === state ? state : 'Off'));
        dirty.add(w.num);
      }
      results.push(done);
      expect.push({ f: done, field: f, v: state, kind: 'name' });
    } else {
      const k = key(value);
      const opt = f.options.find((o) => key(o.label) === k) ?? f.options.find((o) => key(o.exp) === k);
      const editable = Boolean(f.flags & FF.combo && f.flags & FF.edit);
      if (!opt && !editable) {
        results.push({ ...r, status: 'invalid', where, detail: `not one of its choices (${optionList(f)})` });
        continue;
      }
      const exp = opt ? opt.exp : value;
      f.dict.set('V', new PdfString(pdfTextBytes(exp)));
      const idx = opt ? f.options.indexOf(opt) : -1;
      if (idx >= 0) f.dict.set('I', [idx]);
      else f.dict.delete('I');
      dirty.add(f.num);
      if (f.flags & FF.combo) for (const w of f.widgets) setAp(w, appearance(f, w, opt ? opt.label : value));
      results.push(done);
      expect.push({ f: done, field: f, v: exp, kind: 'text' });
    }
  }

  const filled = results.filter((x) => x.status === 'filled').length;
  // What to call each field when something wasn't found: its tooltip, the words next to it, or its name.
  const labels = () => fields.filter((f) => f.kind !== 'button' && f.kind !== 'signature').map((f) => (f.tooltip ?? nearOf(f) ?? f.name).replace(/\s+/g, ' ').slice(0, 60));
  if (!filled) return { format: 'pdf', data: bytes, fields: results, filled: 0, total: results.length, labels: results.length ? [...new Set(labels())].slice(0, 60) : [] };

  // Viewers redraw the fields their way; an XFA part (which would show the old values) is dropped.
  acro.set('NeedAppearances', true);
  if (acro.has('XFA')) acro.delete('XFA');
  // Viewers redraw check boxes and radio buttons with ZapfDingbats (ZaDb); make sure it's there.
  if (expect.some((e) => e.kind === 'name')) {
    const { d: drD, num: drNum } = sub(acro, acroNum, 'DR');
    const { d: fontD, num: fontNum } = sub(drD, drNum, 'Font');
    if (!fontD.has('ZaDb')) {
      const num = next++;
      fresh.push({ num, body: Buffer.from('<</Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats>>', 'latin1') });
      fontD.set('ZaDb', new PdfRef(num, 0));
      dirty.add(fontNum);
    }
  }
  touchAcro();
  dirty.delete(-1);

  // ---- the incremental update
  const parts: Buffer[] = [bytes];
  let pos = bytes.length;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    pos += buf.length;
  };
  if (bytes[bytes.length - 1] !== 0x0a && bytes[bytes.length - 1] !== 0x0d) push('\n');
  const offsets = new Map<number, { off: number; gen: number }>();
  for (const num of [...dirty].sort((a, b) => a - b)) {
    const e = doc.objs.get(num);
    const gen = e?.stm !== undefined ? 0 : (e?.gen ?? 0);
    const v = doc.get(new PdfRef(num, gen));
    offsets.set(num, { off: pos, gen });
    if (isPdfStream(v)) {
      const raw = v.raw;
      const d = new Map(v.dict);
      d.set('Length', raw.length);
      push(`${num} ${gen} obj\n${ser(d)}\nstream\n`);
      push(raw);
      push('\nendstream\nendobj\n');
    } else push(`${num} ${gen} obj\n${ser(v)}\nendobj\n`);
  }
  for (const o of fresh) {
    offsets.set(o.num, { off: pos, gen: 0 });
    push(`${o.num} 0 obj\n`);
    push(o.body);
    push('\nendobj\n');
  }
  const keep = ['Root', 'Info', 'ID'].filter((k) => doc.trailer.has(k)).map((k) => `/${k} ${ser(doc.trailer.get(k))}`).join(' ');
  const ranges = (nums: number[]) => {
    const out: [number, number][] = [];
    for (const n of nums) {
      const last = out[out.length - 1];
      if (last && last[0] + last[1] === n) last[1]++;
      else out.push([n, 1]);
    }
    return out;
  };
  if (classic) {
    const size = Math.max(next, ...[...offsets.keys()].map((n) => n + 1));
    const xref = pos;
    // The free-list head first (as Acrobat writes it; some readers expect a section to start at 0).
    let s = 'xref\n0 1\n0000000000 65535 f\r\n';
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    for (const [start, n] of ranges(nums)) {
      s += `${start} ${n}\n`;
      for (let k = 0; k < n; k++) {
        const o = offsets.get(start + k)!;
        s += `${String(o.off).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n\r\n`;
      }
    }
    s += `trailer\n<</Size ${size} ${keep} /Prev ${prev}>>\nstartxref\n${xref}\n%%EOF\n`;
    push(s);
  } else {
    const self = next++;
    const xref = pos;
    offsets.set(self, { off: xref, gen: 0 });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const wOff = xref > 0xffffffff ? 6 : 4;
    const rows = Buffer.alloc(nums.length * (1 + wOff + 2));
    nums.forEach((n, i) => {
      const o = offsets.get(n)!;
      const at = i * (1 + wOff + 2);
      rows[at] = 1;
      rows.writeUIntBE(o.off, at + 1, wOff);
      rows.writeUInt16BE(o.gen, at + 1 + wOff);
    });
    const data = deflateSync(rows);
    const index = ranges(nums).flat().join(' ');
    push(`${self} 0 obj\n<</Type /XRef /Size ${Math.max(next, self + 1)} /Index [${index}] /W [1 ${wOff} 2] /Filter /FlateDecode /Length ${data.length} ${keep} /Prev ${prev}>>\nstream\n`);
    push(data);
    push(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`);
  }
  const out = Buffer.concat(parts);

  // ---- read the copy back: every value where it should be
  let back: PdfForm | undefined;
  try {
    back = readPdfForm(out);
  } catch {
    back = undefined;
  }
  for (const e of expect) {
    const g = back?.fields.find((x) => x.name === e.field.name);
    let ok = false;
    let got = '';
    if (g) {
      got = g.value;
      ok = g.value === e.v;
      if (ok && e.kind === 'name') ok = g.widgets.every((w) => {
        const as = back!.doc.name(w.dict.get('AS'));
        return as === (w.on === e.v ? e.v : 'Off');
      });
    }
    if (!ok) Object.assign(e.f, { status: 'not_verified', detail: g ? `reading the copy back shows "${got}" there, not "${e.v}"` : 'reading the copy back did not find the field' });
  }
  return { format: 'pdf', data: out, fields: results, filled: results.filter((x) => x.status === 'filled').length, total: results.length, labels: results.every((x) => x.status === 'filled') ? [] : [...new Set(labels())].slice(0, 60) };
}

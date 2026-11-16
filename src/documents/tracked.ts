// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): tracked changes in the person's own Word
// file. A revision is written as real Word revision markup (w:ins / w:del with author "Sara" and a
// date), word by word, so Word's Review tab can Accept or Reject each change. The paragraph model
// here is shared with template filling (src/documents/placeholders.ts): a paragraph's plain runs
// become characters that remember the run they came from, an edit changes the characters, and the
// paragraph is written back with each run's own formatting. Anything that isn't plain text (fields,
// hyperlinks, pictures, earlier revisions) stays exactly as it was and can't be cut through.
import { attr, findAll, kid, kids, parseXml, textOf, type XmlChild, type XmlElement } from '../library/xml.ts';
import { openZip, type Zip } from '../library/zip.ts';
import { cloneEl, element, repack, serializeXml, xmlSafe } from './ooxml-edit.ts';
import { DocError } from './spec.ts';

/** Stands for something in a paragraph that isn't plain text (no edit can cut through it). */
export const OPAQUE = '\uE000';

type Mark = 'ins' | 'del' | undefined;
interface CharItem {
  t: 'c';
  ch: string;
  /** Index of the run it came from (its formatting); -1 for none. */
  src: number;
  mark: Mark;
}
interface OpaqueItem {
  t: 'o';
  el: XmlElement;
  /** Shows as OPAQUE in the paragraph's text (false: takes no room, like a bookmark). */
  visible: boolean;
}
type Item = CharItem | OpaqueItem;
export interface ParaModel {
  p: XmlElement;
  items: Item[];
  /** The run each character came from (cloned rPr is taken from here). */
  runs: XmlElement[];
}

const ZERO_WIDTH = new Set(['bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd', 'commentRangeStart', 'commentRangeEnd', 'del', 'moveFrom', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);

/** A run with only formatting, text and tabs (the kind an edit may split). */
function plainRun(r: XmlElement): boolean {
  return r.children.every((c) => (typeof c === 'string' ? !c.trim() : ['rPr', 't', 'tab', 'lastRenderedPageBreak'].includes(c.local)));
}

export function paraModel(p: XmlElement): ParaModel {
  const items: Item[] = [];
  const runs: XmlElement[] = [];
  for (const c of p.children) {
    if (typeof c === 'string') continue;
    if (c.local === 'pPr') continue;
    if (c.local === 'r' && plainRun(c)) {
      const src = runs.push(c) - 1;
      for (const k of c.children) {
        if (typeof k === 'string') continue;
        if (k.local === 't') for (const ch of textOf(k)) items.push({ t: 'c', ch, src, mark: undefined });
        else if (k.local === 'tab') items.push({ t: 'c', ch: '\t', src, mark: undefined });
      }
      continue;
    }
    items.push({ t: 'o', el: c, visible: !ZERO_WIDTH.has(c.local) && textOf(c).length > 0 });
  }
  return { p, items, runs };
}

/** The paragraph's text as the edits see it (OPAQUE for each non-text element). */
export function modelText(m: ParaModel): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  m.items.forEach((it, i) => {
    if (it.t === 'c') {
      if (it.mark === 'del') return;
      text += it.ch;
      at.push(i);
    } else if (it.visible) {
      text += OPAQUE;
      at.push(i);
    }
  });
  return { text, at };
}

export interface Revisor {
  author: string;
  date: string;
  next: () => number;
}

/**
 * Replaces text[start, end) (indexes into modelText) with `text`. Tracked: the old characters are
 * marked deleted and the new ones inserted, word by word (unchanged words stay as they were).
 * New characters take the formatting of the first replaced character (or the one before).
 */
export function editModel(m: ParaModel, start: number, end: number, text: string, track: boolean): void {
  const { text: vis, at } = modelText(m);
  if (vis.slice(start, end).includes(OPAQUE)) throw new DocError('That text runs through a field, link or picture, so it can\'t be changed here.');
  const firstIdx = start < at.length ? at[start] : m.items.length;
  const pick = (i: number): number => {
    const it = m.items[i];
    if (it && it.t === 'c') return it.src;
    for (let k = i - 1; k >= 0; k--) if (m.items[k].t === 'c') return (m.items[k] as CharItem).src;
    for (let k = i + 1; k < m.items.length; k++) if (m.items[k].t === 'c') return (m.items[k] as CharItem).src;
    return -1;
  };
  const src = pick(firstIdx);
  const chars = (s: string, mark: Mark, from = src): CharItem[] => [...s.replace(/\r?\n/g, ' ')].map((ch) => ({ t: 'c', ch, src: from, mark }));
  if (!track) {
    // Untracked: the range goes (zero-width items inside it stay), the new text takes its place.
    const span = new Set(at.slice(start, end));
    const lo = start < end ? at[start] : firstIdx;
    const hi = start < end ? at[end - 1] + 1 : lo;
    const keep = m.items.slice(lo, hi).filter((_, k) => !span.has(lo + k));
    m.items.splice(lo, hi - lo, ...chars(text, undefined), ...keep);
    return;
  }
  // Tracked, word by word: the old and new texts as tokens, and the longest run of tokens they share.
  const oldText = vis.slice(start, end);
  const a = tokens(oldText);
  const b = tokens(text);
  const ops = diff(a, b);
  // Walk the old characters (visible ones, by their item index) alongside the ops.
  let oi = start;
  const out: Item[] = [];
  const lo = start < at.length ? at[start] : m.items.length;
  const hi = end > start ? at[end - 1] + 1 : lo;
  // Items between lo and hi that aren't visible characters (deleted text, bookmarks) keep their place.
  const vset = new Set(at);
  const between = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (!vset.has(i)) out.push(m.items[i]);
    }
  };
  let cursor = lo;
  for (const op of ops) {
    if (op.kind === 'ins') {
      out.push(...chars(op.text, 'ins', oi < end ? (m.items[at[oi]] as CharItem).src : src));
      continue;
    }
    for (let k = 0; k < op.text.length; k++) {
      const idx = at[oi];
      between(cursor, idx);
      const it = m.items[idx] as CharItem;
      out.push(op.kind === 'del' ? { ...it, mark: it.mark === 'ins' ? it.mark : 'del' } : it);
      cursor = idx + 1;
      oi++;
    }
  }
  between(cursor, hi);
  m.items.splice(lo, hi - lo, ...out);
}

const tokens = (s: string): string[] => s.match(/\s+|\p{N}+(?:[.,:/]\p{N}+)*[\p{L}_]*|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
function diff(a: string[], b: string[]): { kind: 'eq' | 'del' | 'ins'; text: string }[] {
  // Plain LCS (clauses are short; capped so a huge replace can't blow up).
  if (a.length * b.length > 250_000) return [{ kind: 'del' as const, text: a.join('') }, { kind: 'ins' as const, text: b.join('') }].filter((o) => o.text);
  const n = a.length;
  const mm = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(mm + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = mm - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: { kind: 'eq' | 'del' | 'ins'; text: string }[] = [];
  const push = (kind: 'eq' | 'del' | 'ins', text: string) => {
    const last = ops.at(-1);
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < mm) {
    if (i < n && j < mm && a[i] === b[j]) {
      push('eq', a[i]);
      i++;
      j++;
    } else if (j < mm && (i >= n || L[i][j + 1] > L[i + 1][j])) {
      push('ins', b[j++]);
    } else push('del', a[i++]);
  }
  // A lone shared space between changes reads better as part of the change ("30 days" → "two weeks").
  const merged: typeof ops = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.kind === 'eq' && /^(\s+|[,.;:'"-])$/.test(o.text) && ops[k - 1] && ops[k + 1] && ops[k - 1].kind !== 'eq' && ops[k + 1].kind !== 'eq') {
      merged.push({ kind: 'del', text: o.text }, { kind: 'ins', text: o.text });
      continue;
    }
    merged.push(o);
  }
  // Deletions before insertions within each changed stretch (how Word shows them).
  const final: typeof ops = [];
  let dels = '';
  let inss = '';
  const flush = () => {
    if (dels) final.push({ kind: 'del', text: dels });
    if (inss) final.push({ kind: 'ins', text: inss });
    dels = inss = '';
  };
  for (const o of merged) {
    if (o.kind === 'del') dels += o.text;
    else if (o.kind === 'ins') inss += o.text;
    else {
      flush();
      final.push(o);
    }
  }
  flush();
  return final;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Writes the paragraph back from its model (runs regrouped by origin and revision mark). */
export function writeModel(m: ParaModel, rev?: Revisor): void {
  const pPr = kid(m.p, 'pPr');
  const out: XmlChild[] = pPr ? [pPr] : [];
  const like = m.p;
  let i = 0;
  while (i < m.items.length) {
    const it = m.items[i];
    if (it.t === 'o') {
      out.push(it.el);
      i++;
      continue;
    }
    let s = '';
    const { src, mark } = it;
    while (i < m.items.length) {
      const c = m.items[i];
      if (c.t !== 'c' || c.src !== src || c.mark !== mark) break;
      s += c.ch;
      i++;
    }
    const run = runFor(like, m.runs[src], s, mark === 'del');
    if (mark && rev) out.push(element(like, mark, { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }, [run]));
    else out.push(run);
  }
  m.p.children = out;
}

function runFor(like: XmlElement, from: XmlElement | undefined, text: string, deleted: boolean): XmlElement {
  const rPr = from ? kid(from, 'rPr') : undefined;
  const kidsOut: XmlChild[] = rPr ? [cloneEl(rPr)] : [];
  for (const part of text.split(/(\t)/)) {
    if (!part) continue;
    if (part === '\t') kidsOut.push(element(like, 'tab'));
    else kidsOut.push(element(like, deleted ? 'delText' : 't', { 'xml:space': 'preserve' }, [xmlSafe(part)]));
  }
  return element(from ?? like, 'r', {}, kidsOut);
}

/** Marks a paragraph's own mark (its end) inserted or deleted, so accepting/rejecting joins cleanly. */
function markParagraph(p: XmlElement, kind: 'ins' | 'del', rev: Revisor): void {
  let pPr = kid(p, 'pPr');
  if (!pPr) {
    pPr = element(p, 'pPr');
    p.children.unshift(pPr);
  }
  let rPr = kid(pPr, 'rPr');
  if (!rPr) {
    rPr = element(p, 'rPr');
    const at = pPr.children.findIndex((c) => typeof c !== 'string' && (c.local === 'sectPr' || c.local === 'pPrChange'));
    if (at < 0) pPr.children.push(rPr);
    else pPr.children.splice(at, 0, rPr);
  }
  rPr.children.unshift(element(p, kind, { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }));
}

// ---------------------------------------------------------------- finding text

/** Folds quotes and spaces for matching; `map[i]` is the original index of folded char i. */
function fold(s: string): { s: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (/[\s\u00a0]/.test(ch)) {
      if (space) continue;
      space = true;
      ch = ' ';
    } else space = false;
    ch = ch.replace(/[‘’‚`´]/, "'").replace(/[“”„«»]/, '"').replace(/[‐-―]/, '-').toLowerCase();
    out += ch;
    map.push(i);
  }
  return { s: out, map };
}

/** Every place `needle` is in the paragraph texts: [paragraph index, start, end] (case and spacing forgiving). */
export function findIn(texts: string[], needle: string): [number, number, number][] {
  const f = fold(needle.trim());
  if (!f.s) return [];
  const hits: [number, number, number][] = [];
  texts.forEach((t, pi) => {
    const ft = fold(t);
    let from = 0;
    for (;;) {
      const k = ft.s.indexOf(f.s, from);
      if (k < 0) break;
      const s = ft.map[k];
      const e = ft.map[k + f.s.length - 1] + 1;
      hits.push([pi, s, e]);
      from = k + f.s.length;
    }
  });
  // An exact-case match wins over case-folded ones.
  const exact = hits.filter(([pi, s, e]) => texts[pi].slice(s, e) === needle.trim());
  return exact.length === 1 ? exact : hits;
}

// ---------------------------------------------------------------- the package

export interface DocxParts {
  zip: Zip;
  main: string;
  doc: XmlElement;
  paras: XmlElement[];
}

export function openDocx(bytes: Buffer): DocxParts {
  let zip: Zip;
  try {
    zip = openZip(bytes);
  } catch {
    throw new DocError('That file isn\'t a Word document (.docx) that can be opened.');
  }
  let main = 'word/document.xml';
  const ct = zip.text('[Content_Types].xml') ?? '';
  const m = /PartName="\/?([^"]+)"[^>]*ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(?:document|template)\.main\+xml/.exec(ct);
  if (m && zip.has(m[1])) main = m[1];
  const xml = zip.text(main);
  if (!xml) throw new DocError('That Word file has no document part.');
  const doc = parseXml(xml);
  return { zip, main, doc, paras: findAll(doc, 'p') };
}

const BEFORE_TRACK = new Set(['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView']);

/** The settings part with Track Changes on (created, with its relationship, when the file has none). */
function trackSettings(zip: Zip, main: string, changed: Map<string, string | Buffer>): void {
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const relsPath = `${dir}_rels/${main.slice(dir.length)}.rels`;
  const rels = zip.text(relsPath);
  const target = rels ? /<Relationship\b[^>]*Type="[^"]*\/settings"[^>]*Target="([^"]+)"/.exec(rels)?.[1] ?? /<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/settings"/.exec(rels)?.[1] : undefined;
  if (target) {
    const path = target.startsWith('/') ? target.slice(1) : `${dir}${target}`;
    const xml = zip.text(path);
    if (xml) {
      if (/<w:trackRevisions\b/.test(xml)) return;
      const root = parseXml(xml);
      const settings = root.children.find((c): c is XmlElement => typeof c !== 'string' && c.local === 'settings');
      if (!settings) return;
      let at = 0;
      settings.children.forEach((c, i) => {
        if (typeof c !== 'string' && BEFORE_TRACK.has(c.local)) at = i + 1;
      });
      settings.children.splice(at, 0, element(settings, 'trackRevisions'));
      changed.set(path, serializeXml(root));
      return;
    }
  }
  // No settings part: add one.
  const path = `${dir}settings.xml`;
  changed.set(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:settings xmlns:w="${W_NS}"><w:trackRevisions/></w:settings>`);
  const rel = `<Relationship Id="rIdSaraSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`;
  changed.set(relsPath, rels ? rels.replace(/<\/Relationships>\s*$/, `${rel}</Relationships>`) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`);
  const ct = zip.text('[Content_Types].xml') ?? '';
  if (!ct.includes(`/${path}"`)) changed.set('[Content_Types].xml', ct.replace(/<\/Types>\s*$/, `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`));
}

// ---------------------------------------------------------------- revising

export type Change = { find: string; replace: string } | { after: string; insert: string } | { deleteParagraph: string };
export interface ChangeResult {
  change: string;
  status: 'done' | 'not_found' | 'ambiguous' | 'invalid';
  detail?: string;
}

/** The model's changes, checked. */
export function changesOf(v: unknown): Change[] {
  if (!Array.isArray(v) || !v.length) throw new DocError('changes is a list: [{"find": "old words", "replace": "new words"}], [{"after": "words in a paragraph", "insert": "a new paragraph"}] or [{"deleteParagraph": "words in it"}].');
  if (v.length > 200) throw new DocError('Up to 200 changes at a time.');
  return v.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? xmlSafe(o[k] as string).slice(0, 8000) : undefined);
    if (s('find') !== undefined && (s('replace') !== undefined || o.delete === true)) return { find: s('find')!, replace: s('replace') ?? '' };
    if (s('after') !== undefined && s('insert') !== undefined) return { after: s('after')!, insert: s('insert')! };
    if (s('deleteParagraph') !== undefined) return { deleteParagraph: s('deleteParagraph')! };
    throw new DocError('Each change is {"find", "replace"}, {"after", "insert"} or {"deleteParagraph"}.');
  });
}

const label = (c: Change) => ('find' in c ? `“${c.find.slice(0, 60)}” → “${c.replace.slice(0, 60)}”` : 'after' in c ? `new paragraph after “${c.after.slice(0, 60)}”` : `delete the paragraph “${c.deleteParagraph.slice(0, 60)}”`);

/**
 * A copy of the Word file with each change written as a tracked revision (author, date). Changes
 * whose text isn't found exactly once are reported, not guessed.
 */
export function reviseDocx(bytes: Buffer, changes: Change[], o: { date: Date; author?: string }): { data: Buffer; applied: ChangeResult[]; revisions: number } {
  const d = openDocx(bytes);
  const xml = d.zip.text(d.main) ?? '';
  let id = Math.max(100, ...[...xml.matchAll(/w:id="(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n < 2 ** 31 - 1000)) + 1;
  let made = 0;
  const rev: Revisor = { author: (o.author ?? 'Sara').slice(0, 60), date: o.date.toISOString().replace(/\.\d{3}Z$/, 'Z'), next: () => (made++, id++) };
  const applied: ChangeResult[] = [];
  for (const c of changes) {
    const models = d.paras.map((p) => paraModel(p));
    const texts = models.map((m) => modelText(m).text);
    const needle = 'find' in c ? c.find : 'after' in c ? c.after : c.deleteParagraph;
    const hits = findIn(texts, needle);
    if (!hits.length) {
      applied.push({ change: label(c), status: 'not_found', detail: 'Those words are not in the document (word for word).' });
      continue;
    }
    const paras = new Set(hits.map((h) => h[0]));
    if ('find' in c ? hits.length > 1 : paras.size > 1) {
      applied.push({ change: label(c), status: 'ambiguous', detail: `Those words are in ${hits.length} places; quote more of the sentence.` });
      continue;
    }
    const [pi, s, e] = hits[0];
    const m = models[pi];
    try {
      if ('find' in c) {
        editModel(m, s, e, c.replace, true);
        writeModel(m, rev);
      } else if ('after' in c) {
        let at = m.p;
        for (const line of c.insert.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
          const np = element(m.p, 'p');
          const pPr = kid(m.p, 'pPr');
          if (pPr) np.children.push(cloneEl({ ...pPr, children: pPr.children.filter((k) => typeof k === 'string' || (k.local !== 'rPr' && k.local !== 'sectPr' && k.local !== 'pPrChange')) }));
          const firstRun = m.runs[0];
          np.children.push(element(m.p, 'ins', { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }, [runFor(m.p, firstRun, line, false)]));
          markParagraph(np, 'ins', rev);
          insertAfter(d.doc, at, np);
          at = np;
        }
      } else {
        for (const it of m.items) if (it.t === 'c' && it.mark !== 'ins') it.mark = 'del';
        writeModel(m, rev);
        // Runs that aren't plain text (fields, links) are left; the paragraph's text is deleted.
        markParagraph(m.p, 'del', rev);
      }
      applied.push({ change: label(c), status: 'done' });
    } catch (err) {
      applied.push({ change: label(c), status: 'invalid', detail: (err as Error).message });
    }
  }
  const changed = new Map<string, string | Buffer>();
  if (made) {
    changed.set(d.main, serializeXml(d.doc));
    trackSettings(d.zip, d.main, changed);
  }
  return { data: made ? repack(d.zip, changed) : bytes, applied, revisions: made };
}

function insertAfter(root: XmlElement, ref: XmlElement, el: XmlElement): boolean {
  for (const c of root.children) {
    if (typeof c === 'string') continue;
    const i = c.children.indexOf(ref);
    if (i >= 0) {
      c.children.splice(i + 1, 0, el);
      return true;
    }
    if (insertAfter(c, ref, el)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- reading revisions back

export interface Revision {
  id: string;
  type: 'ins' | 'del';
  author: string;
  date: string;
  text: string;
  /** The paragraph as it reads with every change accepted. */
  context: string;
}

const accepted = (el: XmlElement): string => {
  let s = '';
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === 't') s += textOf(c);
    else if (c.local === 'tab') s += '\t';
    else if (c.local === 'del' || c.local === 'delText' || c.local === 'pPr' || c.local === 'rPr' || c.local === 'instrText') continue;
    else s += accepted(c);
  }
  return s;
};

/** Every tracked insertion and deletion in the document body, in order (adjacent pieces joined). */
export function listRevisions(bytes: Buffer): Revision[] {
  const d = openDocx(bytes);
  const out: Revision[] = [];
  for (const p of d.paras) {
    const context = accepted(p).replace(/\s+/g, ' ').trim();
    let last: Revision | undefined;
    let lastEl: XmlElement | undefined;
    for (const c of p.children) {
      if (typeof c === 'string') continue;
      if (c.local !== 'ins' && c.local !== 'del') {
        if (c.local !== 'pPr' && !(c.local === 'bookmarkStart' || c.local === 'bookmarkEnd' || c.local === 'proofErr')) last = undefined;
        continue;
      }
      const type = c.local as 'ins' | 'del';
      const text = type === 'del' ? findAll(c, 'delText').map((x) => textOf(x)).join('') : accepted(c);
      const author = attr(c, 'author') ?? '';
      const date = attr(c, 'date') ?? '';
      if (last && lastEl && last.type === type && last.author === author && last.date === date) last.text += text;
      else {
        last = { id: attr(c, 'id') ?? '', type, author, date, text, context };
        out.push(last);
      }
      lastEl = c;
    }
  }
  return out.filter((r) => r.text.length);
}

/** True when the file still has tracked changes (body text or paragraph marks). */
export function hasRevisions(bytes: Buffer): boolean {
  const d = openDocx(bytes);
  const xml = d.zip.text(d.main) ?? '';
  return /<w:(ins|del|moveFrom|moveTo)\b/.test(xml);
}

/**
 * Accepts (or rejects) every tracked change in the body: insertions kept (or dropped), deletions
 * dropped (or kept as text). A paragraph left with no text by it is removed.
 */
export function resolveAll(bytes: Buffer, how: 'accept' | 'reject'): { data: Buffer; resolved: number } {
  const d = openDocx(bytes);
  let resolved = 0;
  const drop = how === 'accept' ? 'del' : 'ins';
  const keep = how === 'accept' ? 'ins' : 'del';
  const gone = new Set<XmlElement>();
  const walk = (el: XmlElement) => {
    const out: XmlChild[] = [];
    for (const c of el.children) {
      if (typeof c === 'string') {
        out.push(c);
        continue;
      }
      if (c.local === drop || c.local === (how === 'accept' ? 'moveFrom' : 'moveTo')) {
        resolved++;
        // A paragraph mark marked this way: the paragraph goes when nothing is left in it.
        if (el.local === 'rPr') gone.add(el);
        continue;
      }
      if (c.local === keep || c.local === (how === 'accept' ? 'moveTo' : 'moveFrom')) {
        resolved++;
        if (el.local === 'rPr') continue;
        walk(c);
        for (const k of c.children) {
          if (typeof k !== 'string' && k.local === 'r') for (const t of k.children) if (typeof t !== 'string' && t.local === 'delText') t.name = t.name.replace(/delText$/, 't'), (t.local = 't');
          out.push(k);
        }
        continue;
      }
      walk(c);
      out.push(c);
    }
    el.children = out;
  };
  walk(d.doc);
  if (gone.size) {
    const prune = (el: XmlElement) => {
      el.children = el.children.filter((c) => {
        if (typeof c === 'string') return true;
        if (c.local === 'p') {
          const rPr = kid(kid(c, 'pPr'), 'rPr');
          if (rPr && gone.has(rPr) && !textOf({ ...c, children: c.children.filter((k) => typeof k === 'string' || k.local !== 'pPr') }).trim() && !findAll(c, 'drawing').length) return false;
        }
        prune(c);
        return true;
      });
    };
    prune(d.doc);
  }
  if (!resolved) return { data: bytes, resolved: 0 };
  return { data: repack(d.zip, new Map([[d.main, serializeXml(d.doc)]])), resolved };
}

/**
 * Adds clauses (a heading and its text) to a Word file, untracked: before the signature part
 * ("IN WITNESS…", "Signature:") when there is one, else at the end. Headings copy the formatting of
 * the file's own first heading.
 */
export function addClauses(bytes: Buffer, clauses: { heading: string; text: string }[]): Buffer {
  if (!clauses.length) return bytes;
  const d = openDocx(bytes);
  const body = findAll(d.doc, 'body')[0];
  if (!body) return bytes;
  const top = kids(body);
  const headLike = top.find((p) => p.local === 'p' && /^heading\d$/i.test(attr(kid(kid(p, 'pPr'), 'pStyle'), 'val') ?? ''));
  const textLike = top.find((p) => p.local === 'p' && !kid(kid(p, 'pPr'), 'pStyle') && textOf(p).trim().length > 30);
  const sigAt = top.findIndex((p) => p.local === 'p' && /^(in witness whereof|signatures?\b|signed\b|agreed and accepted)/i.test(modelText(paraModel(p)).text.trim()));
  const endAt = top.findIndex((c) => c.local === 'sectPr');
  const at = sigAt >= 0 ? sigAt : endAt >= 0 ? endAt : top.length;
  const made: XmlElement[] = [];
  const para = (like: XmlElement | undefined, text: string) => {
    const p = element(d.doc.children.find((c): c is XmlElement => typeof c !== 'string') ?? body, 'p');
    const pPr = like ? kid(like, 'pPr') : undefined;
    if (pPr) p.children.push(cloneEl({ ...pPr, children: pPr.children.filter((k) => typeof k === 'string' || (k.local !== 'sectPr' && k.local !== 'pPrChange')) }));
    const run = like ? paraModel(like).runs[0] : undefined;
    p.children.push(runFor(p, run, text, false));
    return p;
  };
  for (const c of clauses) {
    if (c.heading.trim()) made.push(para(headLike, c.heading.trim()));
    for (const line of c.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) made.push(para(textLike, line));
  }
  const ref = top[at];
  const i = ref ? body.children.indexOf(ref) : body.children.length;
  body.children.splice(i, 0, ...made);
  return repack(d.zip, new Map([[d.main, serializeXml(d.doc)]]));
}

export { kids };

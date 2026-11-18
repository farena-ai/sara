// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): tracked changes in the person's own Word
// file. A revision is written as real Word revision markup (w:ins / w:del with author "Sara" and a
// date), word by word, so Word's Review tab can Accept or Reject each change. The paragraph model
// here is shared with template filling (src/documents/placeholders.ts): a paragraph's plain runs
// become characters that remember the run they came from, an edit changes the characters, and the
// paragraph is written back with each run's own formatting. Anything that isn't plain text (fields,
// pictures, earlier revisions) stays exactly as it was and can't be cut through; a hyperlink's runs are
// edited inside the link and a simple field (page number, date) is kept whole.
// U3.15: every story part is revised (headers, footers, footnotes, endnotes, comments; text boxes in
// any of them, both the drawing and its VML copy), Word comments can be left instead of an edit, and
// a paragraph can be moved as a tracked move (w:moveFrom / w:moveTo with named ranges).
import { readRels } from '../library/ooxml.ts';
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
  /** Index into `boxes` when it is inside a hyperlink. */
  box?: number;
}
interface OpaqueItem {
  t: 'o';
  el: XmlElement;
  /** Shows as OPAQUE in the paragraph's text (false: takes no room, like a bookmark). */
  visible: boolean;
  /** A simple field: a tracked edit may go through it (its own text is kept as it is). */
  keep?: boolean;
  box?: number;
}
type Item = CharItem | OpaqueItem;
export interface ParaModel {
  p: XmlElement;
  items: Item[];
  /** The run each character came from (cloned rPr is taken from here). */
  runs: XmlElement[];
  /** Hyperlinks whose runs became characters (written back as one link per stretch). */
  boxes: XmlElement[];
}

const ZERO_WIDTH = new Set(['bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd', 'commentRangeStart', 'commentRangeEnd', 'del', 'moveFrom', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);

/** A run with only formatting, text and tabs (the kind an edit may split). */
function plainRun(r: XmlElement): boolean {
  return r.children.every((c) => (typeof c === 'string' ? !c.trim() : ['rPr', 't', 'tab', 'lastRenderedPageBreak'].includes(c.local)));
}

/** A hyperlink with only plain runs (and bookmarks and the like) can be edited inside. */
const openLink = (c: XmlElement): boolean => c.local === 'hyperlink' && c.children.some((k) => typeof k !== 'string' && k.local === 'r') && c.children.every((k) => (typeof k === 'string' ? !k.trim() : (k.local === 'r' && plainRun(k)) || ZERO_WIDTH.has(k.local)));

export function paraModel(p: XmlElement): ParaModel {
  const items: Item[] = [];
  const runs: XmlElement[] = [];
  const boxes: XmlElement[] = [];
  const add = (c: XmlElement, box?: number) => {
    if (c.local === 'r' && plainRun(c)) {
      const src = runs.push(c) - 1;
      for (const k of c.children) {
        if (typeof k === 'string') continue;
        if (k.local === 't') for (const ch of textOf(k)) items.push({ t: 'c', ch, src, mark: undefined, ...(box !== undefined ? { box } : {}) });
        else if (k.local === 'tab') items.push({ t: 'c', ch: '\t', src, mark: undefined, ...(box !== undefined ? { box } : {}) });
      }
      return;
    }
    const visible = !ZERO_WIDTH.has(c.local) && textOf(c).length > 0;
    items.push({ t: 'o', el: c, visible, ...(c.local === 'fldSimple' && visible ? { keep: true } : {}), ...(box !== undefined ? { box } : {}) });
  };
  for (const c of p.children) {
    if (typeof c === 'string') continue;
    if (c.local === 'pPr') continue;
    if (openLink(c)) {
      const box = boxes.push(c) - 1;
      for (const k of c.children) if (typeof k !== 'string') add(k, box);
      continue;
    }
    add(c);
  }
  return { p, items, runs, boxes };
}

/**
 * The paragraph's text as the edits see it (OPAQUE for each non-text element). With `fields`, a
 * simple field shows its own text (each of its characters points at the field).
 */
export function modelText(m: ParaModel, fields = false): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  m.items.forEach((it, i) => {
    if (it.t === 'c') {
      if (it.mark === 'del') return;
      text += it.ch;
      at.push(i);
    } else if (it.visible) {
      if (fields && it.keep) {
        for (const ch of textOf(it.el)) {
          text += ch === OPAQUE ? ' ' : ch;
          at.push(i);
        }
        return;
      }
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
  const { text: vis, at } = modelText(m, track);
  if (vis.slice(start, end).includes(OPAQUE)) throw new DocError('That text runs through a picture, a complex field or an earlier tracked change, so it can\'t be changed here.');
  const firstIdx = start < at.length ? at[start] : m.items.length;
  // Where new characters come from: the run (formatting) and hyperlink of the character there, or
  // the nearest one before (or after).
  const pick = (i: number): { src: number; box?: number } => {
    const of = (it: CharItem) => ({ src: it.src, ...(it.box !== undefined ? { box: it.box } : {}) });
    const it = m.items[i];
    if (it && it.t === 'c') return of(it);
    for (let k = i - 1; k >= 0; k--) if (m.items[k].t === 'c') return of(m.items[k] as CharItem);
    for (let k = i + 1; k < m.items.length; k++) if (m.items[k].t === 'c') return of(m.items[k] as CharItem);
    return { src: -1 };
  };
  const origin = pick(firstIdx);
  const chars = (s: string, mark: Mark, from = origin): CharItem[] => [...s.replace(/\r?\n/g, ' ').replaceAll(OPAQUE, '')].map((ch) => ({ t: 'c', ch, mark, ...from }));
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
      out.push(...chars(op.text, 'ins', oi < end ? pick(at[oi]) : origin));
      continue;
    }
    for (let k = 0; k < op.text.length; k++) {
      const idx = at[oi++];
      // A field's later characters (the field itself is already placed).
      if (idx < cursor) continue;
      between(cursor, idx);
      const it = m.items[idx];
      // A field is never deleted: it stays as it is.
      if (it.t === 'o') out.push(it);
      else out.push(op.kind === 'del' ? { ...it, mark: it.mark === 'ins' ? it.mark : 'del' } : it);
      cursor = idx + 1;
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
  // One item (or a stretch of characters from one run with one mark) into `into`.
  const emit = (into: XmlChild[]) => {
    const it = m.items[i];
    if (it.t === 'o') {
      into.push(it.el);
      i++;
      return;
    }
    let s = '';
    const { src, mark, box } = it;
    while (i < m.items.length) {
      const c = m.items[i];
      if (c.t !== 'c' || c.src !== src || c.mark !== mark || c.box !== box) break;
      s += c.ch;
      i++;
    }
    const run = runFor(like, m.runs[src], s, mark === 'del');
    if (mark && rev) into.push(element(like, mark, { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }, [run]));
    else into.push(run);
  };
  while (i < m.items.length) {
    const box = m.items[i].box;
    if (box === undefined) {
      emit(out);
      continue;
    }
    // A stretch inside one hyperlink: the link element again around it (same r:id, same style).
    const link = m.boxes[box];
    const inner: XmlChild[] = [];
    while (i < m.items.length && m.items[i].box === box) emit(inner);
    out.push({ ...link, attrs: { ...link.attrs }, children: inner });
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
function markParagraph(p: XmlElement, kind: 'ins' | 'del' | 'moveFrom' | 'moveTo', rev: Revisor): void {
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

/** Where a paragraph is: the body or another story part, or a text box in one of them. */
export type Where = 'body' | 'header' | 'footer' | 'footnote' | 'endnote' | 'comment' | 'textbox';
export interface Story {
  path: string;
  kind: Exclude<Where, 'textbox'>;
  root: XmlElement;
}
export interface Para {
  p: XmlElement;
  story: Story;
  where: Where;
  /** The same text box paragraph in the VML copy (mc:Fallback), edited alongside. */
  twin?: XmlElement;
}

export interface DocxParts {
  zip: Zip;
  main: string;
  doc: XmlElement;
  paras: XmlElement[];
  /** The main document first, then headers, footers, footnotes, endnotes and comments. */
  stories: Story[];
}

const REL_KIND: Record<string, Story['kind']> = { header: 'header', footer: 'footer', footnotes: 'footnote', endnotes: 'endnote', comments: 'comment' };

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
  const stories: Story[] = [{ path: main, kind: 'body', root: doc }];
  const seen = new Set([main]);
  const rels = [...readRels(zip, main).values()].map((r) => ({ ...r, kind: REL_KIND[r.type.slice(r.type.lastIndexOf('/') + 1)] })).filter((r) => r.kind);
  rels.sort((x, y) => Object.values(REL_KIND).indexOf(x.kind) - Object.values(REL_KIND).indexOf(y.kind) || x.target.localeCompare(y.target, 'en', { numeric: true }));
  for (const r of rels) {
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    const x = zip.text(r.target);
    if (x) stories.push({ path: r.target, kind: r.kind, root: parseXml(x) });
  }
  return { zip, main, doc, paras: findAll(doc, 'p'), stories };
}

/** Every paragraph in every story, in order; text box paragraphs once (their VML copy as `twin`). */
export function storyParas(stories: Story[]): Para[] {
  const out: Para[] = [];
  for (const story of stories) {
    const walk = (el: XmlElement, box: boolean, list: Para[]) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (c.local === 'AlternateContent') {
          // A drawing (Choice) and its older copy (Fallback): pair their paragraphs when they match.
          const choice: Para[] = [];
          const fallback: Para[] = [];
          for (const k of kids(c)) {
            if (k.local === 'Choice') walk(k, box, choice);
            else if (k.local === 'Fallback') walk(k, box, fallback);
          }
          const same = choice.length === fallback.length && choice.every((x, i) => modelText(paraModel(x.p), true).text === modelText(paraModel(fallback[i].p), true).text);
          choice.forEach((x, i) => list.push(same && x.where === 'textbox' ? { ...x, twin: fallback[i].p } : x));
          continue;
        }
        if (c.local === 'p') {
          list.push({ p: c, story, where: box ? 'textbox' : story.kind });
          walk(c, box, list);
          continue;
        }
        walk(c, box || c.local === 'txbxContent', list);
      }
    };
    walk(story.root, false, out);
  }
  return out;
}

const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';

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

/** The relationship (and part, and content type) for a part the main document doesn't have yet. */
function addPart(zip: Zip, main: string, changed: Map<string, string | Buffer>, o: { file: string; rel: string; type: string; xml: string }): string {
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const relsPath = `${dir}_rels/${main.slice(dir.length)}.rels`;
  const rels = (changed.get(relsPath) as string | undefined) ?? zip.text(relsPath);
  const path = `${dir}${o.file}`;
  changed.set(path, o.xml);
  let id = 'rIdSara1';
  for (let n = 1; rels?.includes(`Id="${id}"`); n++) id = `rIdSara${n}`;
  const rel = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${o.rel}" Target="${o.file}"/>`;
  changed.set(relsPath, rels ? rels.replace(/<\/Relationships>\s*$/, `${rel}</Relationships>`) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`);
  const ct = (changed.get('[Content_Types].xml') as string | undefined) ?? zip.text('[Content_Types].xml') ?? '';
  if (!ct.includes(`"/${path}"`)) changed.set('[Content_Types].xml', ct.replace(/<\/Types>\s*$/, `<Override PartName="/${path}" ContentType="${o.type}"/></Types>`));
  return path;
}

// ---------------------------------------------------------------- revising

export type Change =
  | { find: string; replace: string; all?: boolean }
  | { after: string; insert: string }
  | { deleteParagraph: string }
  | { comment: string; on: string }
  | { move: string; after: string }
  | { move: string; before: string };
export interface ChangeResult {
  change: string;
  status: 'done' | 'not_found' | 'ambiguous' | 'invalid';
  detail?: string;
}

/** The model's changes, checked. */
export function changesOf(v: unknown): Change[] {
  if (!Array.isArray(v) || !v.length) throw new DocError('changes is a list: [{"find": "old words", "replace": "new words"}], [{"after": "words in a paragraph", "insert": "a new paragraph"}], [{"deleteParagraph": "words in it"}], [{"comment": "a note", "on": "words it is about"}] or [{"move": "words in a paragraph", "after": "words in the paragraph it goes after"}].');
  if (v.length > 200) throw new DocError('Up to 200 changes at a time.');
  return v.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? xmlSafe(o[k] as string).slice(0, 8000) : undefined);
    if (s('find') !== undefined && (s('replace') !== undefined || o.delete === true)) return { find: s('find')!, replace: s('replace') ?? '', ...(o.all === true ? { all: true } : {}) };
    if (s('comment') !== undefined) {
      if (!s('comment')!.trim() || !s('on')?.trim()) throw new DocError('A comment is {"comment": "the note", "on": "the exact words it is about"}.');
      return { comment: s('comment')!.trim(), on: s('on')! };
    }
    if (s('move') !== undefined) {
      if (s('after') !== undefined) return { move: s('move')!, after: s('after')! };
      if (s('before') !== undefined) return { move: s('move')!, before: s('before')! };
      throw new DocError('A move is {"move": "words in the paragraph", "after": "words in the paragraph it goes after"} (or "before").');
    }
    if (s('after') !== undefined && s('insert') !== undefined) return { after: s('after')!, insert: s('insert')! };
    if (s('deleteParagraph') !== undefined) return { deleteParagraph: s('deleteParagraph')! };
    throw new DocError('Each change is {"find", "replace"}, {"after", "insert"}, {"deleteParagraph"}, {"comment", "on"} or {"move", "after"}.');
  });
}

const cut = (s: string) => s.slice(0, 60);
const label = (c: Change) =>
  'find' in c
    ? `“${cut(c.find)}” → “${cut(c.replace)}”`
    : 'comment' in c
      ? `comment on “${cut(c.on)}”: ${cut(c.comment)}`
      : 'move' in c
        ? `move “${cut(c.move)}” ${'after' in c ? `after “${cut(c.after)}”` : `before “${cut((c as { before: string }).before)}”`}`
        : 'after' in c
          ? `new paragraph after “${cut(c.after)}”`
          : `delete the paragraph “${cut(c.deleteParagraph)}”`;

const NOTE: Record<Where, string> = { body: '', header: ' (in the header)', footer: ' (in the footer)', footnote: ' (in a footnote)', endnote: ' (in an endnote)', comment: ' (in a comment)', textbox: ' (in a text box)' };

/**
 * A copy of the Word file with each change written as a tracked revision (author, date) in whichever
 * part it is (body, header, footer, footnote, endnote, text box, comment), a comment, or a tracked
 * move. Changes whose text isn't found exactly once are reported, not guessed.
 */
export function reviseDocx(bytes: Buffer, changes: Change[], o: { date: Date; author?: string }): { data: Buffer; applied: ChangeResult[]; revisions: number; comments: number } {
  const d = openDocx(bytes);
  // Ids are unique across every part (Word repairs a file otherwise).
  const all = d.zip.all.filter((e) => /\.xml$/i.test(e.name) && !e.name.includes('_rels')).map((e) => d.zip.text(e.name) ?? '').join('');
  let id = Math.max(100, ...[...all.matchAll(/w:id="(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n < 2 ** 31 - 1000)) + 1;
  let made = 0;
  const author = (o.author ?? 'Sara').slice(0, 60);
  const rev: Revisor = { author, date: o.date.toISOString().replace(/\.\d{3}Z$/, 'Z'), next: () => (made++, id++) };
  const dirty = new Set<Story>();
  const notes: { id: number; text: string }[] = [];
  const applied: ChangeResult[] = [];
  const editPara = (p: XmlElement, spans: [number, number][], text: string) => {
    const m = paraModel(p);
    for (const [s, e] of [...spans].sort((x, y) => y[0] - x[0])) editModel(m, s, e, text, true);
    writeModel(m, rev);
  };
  for (const c of changes) {
    const paras = storyParas(d.stories);
    const texts = paras.map((x) => modelText(paraModel(x.p), true).text);
    // The body, notes, headers and footers first; a comment's own words only when nothing else has them.
    const search = (needle: string, ok: (x: Para) => boolean = () => true) => {
      const hits = findIn(texts, needle).filter(([pi]) => ok(paras[pi]));
      const main = hits.filter(([pi]) => paras[pi].where !== 'comment');
      return main.length ? main : hits;
    };
    const needle = 'find' in c ? c.find : 'comment' in c ? c.on : 'move' in c ? c.move : 'after' in c ? c.after : c.deleteParagraph;
    const hits = 'comment' in c ? search(needle, (x) => x.where === 'body' || x.where === 'footnote' || x.where === 'endnote') : 'move' in c ? search(needle, (x) => x.where === 'body') : search(needle);
    if (!hits.length) {
      applied.push({ change: label(c), status: 'not_found', detail: 'comment' in c && search(needle).length ? 'Comments can be left on the body and notes, not headers, footers or text boxes.' : 'Those words are not in the document (word for word).' });
      continue;
    }
    const inParas = new Set(hits.map((h) => h[0]));
    if (('find' in c ? hits.length > 1 && !c.all : 'comment' in c ? hits.length > 1 : inParas.size > 1)) {
      const where = [...new Set(hits.map(([pi]) => paras[pi].where))].map((w) => (w === 'body' ? 'the body' : `the ${w === 'textbox' ? 'text box' : w}`));
      applied.push({ change: label(c), status: 'ambiguous', detail: `Those words are in ${hits.length} places (${where.join(', ')}); quote more of the sentence${'find' in c ? ', or ask to change every one' : ''}.` });
      continue;
    }
    const [pi, s, e] = hits[0];
    const at = paras[pi];
    const before = made;
    try {
      if ('find' in c) {
        const by = new Map<number, [number, number][]>();
        for (const [hp, hs, he] of hits) by.set(hp, [...(by.get(hp) ?? []), [hs, he]]);
        for (const [hp, spans] of by) {
          const x = paras[hp];
          editPara(x.p, spans, c.replace);
          if (x.twin) editPara(x.twin, spans, c.replace);
          dirty.add(x.story);
        }
        applied.push({ change: label(c), status: 'done', ...(hits.length > 1 ? { detail: `Changed in ${hits.length} places.` } : paras[pi].where !== 'body' ? { detail: `Changed${NOTE[paras[pi].where]}.` } : {}) });
        continue;
      }
      if ('comment' in c) {
        const cid = id++;
        anchorComment(at.p, s, e, cid);
        notes.push({ id: cid, text: c.comment });
        dirty.add(at.story);
      } else if ('move' in c) {
        const to = 'after' in c ? c.after : c.before;
        const th = search(to, (x) => x.where === 'body' && x.story === at.story);
        if (!th.length) throw new DocError(`“${cut(to)}” is not in the document (word for word).`);
        if (new Set(th.map((h) => h[0])).size > 1) throw new DocError(`“${cut(to)}” is in ${th.length} places; quote more of that paragraph.`);
        moveParagraph(at, paras[th[0][0]].p, 'after' in c ? 'after' : 'before', rev);
        dirty.add(at.story);
      } else if ('after' in c) {
        const add = (target: XmlElement) => {
          let ref = target;
          for (const line of c.insert.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
            const np = element(target, 'p');
            const pPr = kid(target, 'pPr');
            if (pPr) np.children.push(cloneEl({ ...pPr, children: pPr.children.filter((k) => typeof k === 'string' || (k.local !== 'rPr' && k.local !== 'sectPr' && k.local !== 'pPrChange')) }));
            const firstRun = paraModel(target).runs[0];
            np.children.push(element(target, 'ins', { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }, [runFor(target, firstRun, line, false)]));
            markParagraph(np, 'ins', rev);
            insertAfter(at.story.root, ref, np);
            ref = np;
          }
        };
        add(at.p);
        if (at.twin) add(at.twin);
        dirty.add(at.story);
      } else {
        const del = (target: XmlElement) => {
          const m = paraModel(target);
          for (const it of m.items) if (it.t === 'c' && it.mark !== 'ins') it.mark = 'del';
          writeModel(m, rev);
          // Runs that aren't plain text (fields, pictures) are left; the paragraph's text is deleted.
          markParagraph(target, 'del', rev);
        };
        del(at.p);
        if (at.twin) del(at.twin);
        dirty.add(at.story);
      }
      applied.push({ change: label(c), status: 'done', ...(at.where !== 'body' && made > before ? { detail: `Changed${NOTE[at.where]}.` } : {}) });
    } catch (err) {
      applied.push({ change: label(c), status: 'invalid', detail: (err as Error).message });
    }
  }
  const changed = new Map<string, string | Buffer>();
  for (const st of d.stories) if (dirty.has(st)) changed.set(st.path, serializeXml(st.root));
  if (made) trackSettings(d.zip, d.main, changed);
  if (notes.length) addComments(d, changed, notes, rev, all);
  return { data: changed.size ? repack(d.zip, changed) : bytes, applied, revisions: made, comments: notes.length };
}

function insertAfter(root: XmlElement, ref: XmlElement, el: XmlElement, before = false): boolean {
  for (const c of root.children) {
    if (typeof c === 'string') continue;
    const i = c.children.indexOf(ref);
    if (i >= 0) {
      c.children.splice(before ? i : i + 1, 0, el);
      return true;
    }
    if (insertAfter(c, ref, el, before)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- comments

/** commentRangeStart / End around text[s, e) and the reference run after it (inside a link when the words are). */
function anchorComment(p: XmlElement, s: number, e: number, cid: number): void {
  const m = paraModel(p);
  const { at } = modelText(m, true);
  const lo = at[s];
  const hi = at[e - 1] + 1;
  const boxAt = (i: number) => m.items[i]?.box;
  const mk = (local: string, box: number | undefined, children: XmlChild[] = []): OpaqueItem => ({ t: 'o', el: element(p, local, { 'w:id': String(cid) }, children), visible: false, ...(box !== undefined ? { box } : {}) });
  const endBox = boxAt(hi - 1);
  const ref: OpaqueItem = { t: 'o', el: element(p, 'r', {}, [element(p, 'commentReference', { 'w:id': String(cid) })]), visible: false, ...(endBox !== undefined ? { box: endBox } : {}) };
  m.items.splice(hi, 0, mk('commentRangeEnd', endBox), ref);
  m.items.splice(lo, 0, mk('commentRangeStart', boxAt(lo)));
  writeModel(m);
}

/** An 8-digit hex id below 0x80000000 not used anywhere in the file. */
function hexIds(all: string): () => string {
  const used = new Set([...all.matchAll(/(?:paraId|textId|durableId)="([0-9A-Fa-f]{8})"/g)].map((m) => m[1].toUpperCase()));
  let n = 0x5a000000 + (used.size * 7919) % 0x100000;
  return () => {
    let h: string;
    do h = (n++).toString(16).toUpperCase().padStart(8, '0');
    while (used.has(h));
    used.add(h);
    return h;
  };
}

/** The comments part (made when missing), plus commentsExtended / commentsIds / commentsExtensible entries when the file has those parts. */
function addComments(d: DocxParts, changed: Map<string, string | Buffer>, notes: { id: number; text: string }[], rev: Revisor, all: string): void {
  const rels = readRels(d.zip, d.main);
  const relOf = (t: string) => [...rels.values()].find((r) => r.type.endsWith(`/${t}`))?.target;
  const hex = hexIds(all);
  const initials = rev.author.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 4).toUpperCase() || 'S';
  const paraIds: { id: number; para: string; durable: string }[] = [];
  const xmlOf = notes.map((n) => {
    const lines = n.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const ps = lines.map((line, i) => {
      const para = hex();
      if (i === lines.length - 1) paraIds.push({ id: n.id, para, durable: hex() });
      const esc = xmlSafe(line).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<w:p w14:paraId="${para}" w14:textId="77777777">${i === 0 ? '<w:r><w:annotationRef/></w:r>' : ''}<w:r><w:t xml:space="preserve">${esc}</w:t></w:r></w:p>`;
    });
    return `<w:comment w:id="${n.id}" w:author="${attrEsc(rev.author)}" w:date="${rev.date}" w:initials="${attrEsc(initials)}">${ps.join('')}</w:comment>`;
  });
  const cpath = relOf('comments');
  const existing = cpath ? ((changed.get(cpath) as string | undefined) ?? d.zip.text(cpath)) : undefined;
  if (cpath && existing) {
    let x = existing;
    // w14 (paragraph ids) on the root when it isn't declared yet.
    x = x.replace(/<((?:\w+:)?comments)\b([^>]*)>/, (whole, name: string, at: string) => (/xmlns:w14=/.test(at) ? whole : `<${name}${at} xmlns:w14="${W14}">`));
    const prefix = /<(\w+):comments\b/.exec(x)?.[1];
    const body = prefix && prefix !== 'w' ? xmlOf.map((s) => s.replace(/<(\/?)w:/g, `<$1${prefix}:`).replace(/ w:/g, ` ${prefix}:`)) : xmlOf;
    changed.set(cpath, x.replace(/<\/((?:\w+:)?comments)>\s*$/, `${body.join('')}</$1>`));
  } else {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:comments xmlns:w="${W_NS}" xmlns:w14="${W14}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">${xmlOf.join('')}</w:comments>`;
    addPart(d.zip, d.main, changed, { file: 'comments.xml', rel: 'comments', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', xml });
  }
  const append = (rel: string, root: string, entry: (x: (typeof paraIds)[number], pre: string) => string) => {
    const path = relOf(rel);
    const xml = path ? ((changed.get(path) as string | undefined) ?? d.zip.text(path)) : undefined;
    if (!path || !xml) return;
    const pre = new RegExp(`<(\\w+):${root}\\b`).exec(xml)?.[1];
    if (!pre) return;
    changed.set(path, xml.replace(new RegExp(`</${pre}:${root}>\\s*$`), `${paraIds.map((x) => entry(x, pre)).join('')}</${pre}:${root}>`).replace(new RegExp(`<${pre}:${root}\\b([^>]*)/>\\s*$`), (_w, a: string) => `<${pre}:${root}${a}>${paraIds.map((x) => entry(x, pre)).join('')}</${pre}:${root}>`));
  };
  append('commentsExtended', 'commentsEx', (x, pre) => `<${pre}:commentEx ${pre}:paraId="${x.para}" ${pre}:done="0"/>`);
  append('commentsIds', 'commentsIds', (x, pre) => `<${pre}:commentId ${pre}:paraId="${x.para}" ${pre}:durableId="${x.durable}"/>`);
  append('commentsExtensible', 'commentsExtensible', (x, pre) => `<${pre}:commentExtensible ${pre}:durableId="${x.durable}" ${pre}:dateUtc="${rev.date}"/>`);
}

const attrEsc = (s: string) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export interface DocComment {
  id: string;
  author: string;
  date: string;
  text: string;
  /** The words it is about. */
  anchor: string;
}

/** Every comment in the file, in order, with the words each is about. */
export function listComments(bytes: Buffer): DocComment[] {
  const d = openDocx(bytes);
  const st = d.stories.find((x) => x.kind === 'comment');
  if (!st) return [];
  const anchors = new Map<string, string>();
  const open = new Set<string>();
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.local === 'commentRangeStart') open.add(attr(c, 'id') ?? '');
      else if (c.local === 'commentRangeEnd') open.delete(attr(c, 'id') ?? '');
      else if (c.local === 't' || c.local === 'tab') for (const k of open) anchors.set(k, (anchors.get(k) ?? '') + (c.local === 'tab' ? '\t' : textOf(c)));
      else if (c.local === 'del' || c.local === 'moveFrom' || c.local === 'delText' || c.local === 'instrText' || c.local === 'Fallback') continue;
      else {
        walk(c);
        if (c.local === 'p') for (const k of open) anchors.set(k, `${anchors.get(k) ?? ''} `);
      }
    }
  };
  for (const s of d.stories) if (s.kind !== 'comment') walk(s.root);
  return findAll(st.root, 'comment').map((c) => {
    const cid = attr(c, 'id') ?? '';
    return {
      id: cid,
      author: attr(c, 'author') ?? '',
      date: attr(c, 'date') ?? '',
      text: findAll(c, 'p').map((p) => accepted(p).trim()).filter(Boolean).join('\n'),
      anchor: (anchors.get(cid) ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
}

// ---------------------------------------------------------------- moves

const RUN_LEVEL = new Set(['r', 'customXml', 'smartTag', 'sdt']);

/** Wraps a paragraph's runs in w:moveFrom / w:moveTo (inside links and simple fields too), between named range marks. */
function wrapMove(p: XmlElement, kind: 'moveFrom' | 'moveTo', name: string, rev: Revisor): void {
  const range = rev.next();
  const mark = () => element(p, kind, { 'w:id': String(rev.next()), 'w:author': rev.author, 'w:date': rev.date }, []);
  const wrap = (el: XmlElement) => {
    const out: XmlChild[] = [];
    let cur: XmlElement | undefined;
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.local === 'pPr') {
        out.push(c);
        continue;
      }
      if (RUN_LEVEL.has(c.local)) {
        if (!cur) out.push((cur = mark()));
        cur.children.push(c);
        continue;
      }
      cur = undefined;
      if (c.local === 'hyperlink' || c.local === 'fldSimple') wrap(c);
      out.push(c);
    }
    el.children = out;
  };
  wrap(p);
  const pPr = kid(p, 'pPr');
  const at = pPr ? p.children.indexOf(pPr) + 1 : 0;
  p.children.splice(at, 0, element(p, `${kind}RangeStart`, { 'w:id': String(range), 'w:author': rev.author, 'w:date': rev.date, 'w:name': name }));
  p.children.push(element(p, `${kind}RangeEnd`, { 'w:id': String(range) }));
  markParagraph(p, kind, rev);
}

function moveParagraph(from: Para, target: XmlElement, where: 'after' | 'before', rev: Revisor): void {
  const p = from.p;
  if (p === target) throw new DocError('A paragraph can\'t move next to itself.');
  const has = (local: string) => findAll(p, local).length > 0;
  if (['ins', 'del', 'moveFrom', 'moveTo'].some(has)) throw new DocError('That paragraph already has tracked changes; accept or reject them first.');
  if (['footnoteReference', 'endnoteReference', 'commentReference', 'commentRangeStart', 'txbxContent', 'fldChar'].some(has)) throw new DocError('That paragraph has a footnote, comment, text box or field in it; move it in Word.');
  if (kid(kid(p, 'pPr'), 'sectPr')) throw new DocError('That paragraph ends a section; move it in Word.');
  const parent = (root: XmlElement, el: XmlElement): XmlElement | undefined => {
    for (const c of root.children) {
      if (typeof c === 'string') continue;
      if (c.children.includes(el)) return c;
      const f = parent(c, el);
      if (f) return f;
    }
    return undefined;
  };
  const pp = parent(from.story.root, p);
  const tp = parent(from.story.root, target);
  if (!pp || !tp) throw new DocError('That paragraph can\'t be moved here.');
  const sib = (el: XmlElement, list: XmlElement, step: number) => {
    const ks = kids(list);
    return ks[ks.indexOf(el) + step];
  };
  if (pp === tp && sib(p, pp, where === 'after' ? -1 : 1) === target) throw new DocError('That paragraph is already there.');
  const copy = cloneEl(p);
  const strip = (el: XmlElement) => {
    el.children = el.children.filter((c) => typeof c === 'string' || !['bookmarkStart', 'bookmarkEnd', 'proofErr'].includes(c.local));
    for (const c of el.children) if (typeof c !== 'string') strip(c);
  };
  strip(copy);
  const cpPr = kid(copy, 'pPr');
  if (cpPr) cpPr.children = cpPr.children.filter((k) => typeof k === 'string' || k.local !== 'sectPr');
  const name = `move${rev.next()}`;
  wrapMove(p, 'moveFrom', name, rev);
  wrapMove(copy, 'moveTo', name, rev);
  insertAfter(from.story.root, target, copy, where === 'before');
}

// ---------------------------------------------------------------- reading revisions back

export interface Revision {
  id: string;
  type: 'ins' | 'del' | 'moveFrom' | 'moveTo';
  author: string;
  date: string;
  text: string;
  /** The paragraph as it reads with every change accepted. */
  context: string;
  /** Which part it is in. */
  where: Where;
}

const accepted = (el: XmlElement): string => {
  let s = '';
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === 't') s += textOf(c);
    else if (c.local === 'tab') s += '\t';
    else if (c.local === 'del' || c.local === 'moveFrom' || c.local === 'delText' || c.local === 'pPr' || c.local === 'rPr' || c.local === 'instrText' || c.local === 'txbxContent' || c.local === 'Fallback') continue;
    else s += accepted(c);
  }
  return s;
};

const REV = new Set(['ins', 'del', 'moveFrom', 'moveTo']);
const SILENT = new Set(['pPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'commentRangeStart', 'commentRangeEnd']);
const INTO = new Set(['hyperlink', 'fldSimple', 'smartTag', 'customXml', 'sdt', 'sdtContent']);

/** Every tracked insertion, deletion and move in every part, in order (adjacent pieces joined). */
export function listRevisions(bytes: Buffer): Revision[] {
  const d = openDocx(bytes);
  const out: Revision[] = [];
  for (const { p, where } of storyParas(d.stories)) {
    const context = accepted(p).replace(/\s+/g, ' ').trim();
    let last: Revision | undefined;
    const walk = (el: XmlElement) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (INTO.has(c.local)) {
          walk(c);
          continue;
        }
        if (!REV.has(c.local)) {
          if (!SILENT.has(c.local)) last = undefined;
          continue;
        }
        const type = c.local as Revision['type'];
        const text = type === 'del' ? findAll(c, 'delText').map((x) => textOf(x)).join('') : type === 'moveFrom' ? findAll(c, 't').map((x) => textOf(x)).join('') : accepted(c);
        const author = attr(c, 'author') ?? '';
        const date = attr(c, 'date') ?? '';
        if (last && last.type === type && last.author === author && last.date === date) last.text += text;
        else {
          last = { id: attr(c, 'id') ?? '', type, author, date, text, context, where };
          out.push(last);
        }
      }
    };
    walk(p);
  }
  return out.filter((r) => r.text.length);
}

/** True when the file still has tracked changes (any part: text or paragraph marks). */
export function hasRevisions(bytes: Buffer): boolean {
  const d = openDocx(bytes);
  return d.stories.some((s) => /<w:(ins|del|moveFrom|moveTo)\b/.test(d.zip.text(s.path) ?? ''));
}

const RANGE = new Set(['moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);

/**
 * Accepts (or rejects) every tracked change in every part: insertions kept (or dropped), deletions
 * dropped (or kept as text), moves made (or undone). A paragraph left with no text by it is removed.
 * Comments stay (as in Word).
 */
export function resolveAll(bytes: Buffer, how: 'accept' | 'reject'): { data: Buffer; resolved: number } {
  const d = openDocx(bytes);
  let resolved = 0;
  const drop = new Set(how === 'accept' ? ['del', 'moveFrom'] : ['ins', 'moveTo']);
  const keep = new Set(how === 'accept' ? ['ins', 'moveTo'] : ['del', 'moveFrom']);
  const changed = new Map<string, string | Buffer>();
  for (const st of d.stories) {
    let here = 0;
    const gone = new Set<XmlElement>();
    const walk = (el: XmlElement) => {
      const out: XmlChild[] = [];
      for (const c of el.children) {
        if (typeof c === 'string') {
          out.push(c);
          continue;
        }
        if (RANGE.has(c.local)) {
          here++;
          continue;
        }
        if (drop.has(c.local)) {
          resolved++;
          here++;
          // A paragraph mark marked this way: the paragraph goes when nothing is left in it.
          if (el.local === 'rPr') gone.add(el);
          continue;
        }
        if (keep.has(c.local)) {
          resolved++;
          here++;
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
    walk(st.root);
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
      prune(st.root);
    }
    if (here) changed.set(st.path, serializeXml(st.root));
  }
  if (!resolved) return { data: bytes, resolved: 0 };
  return { data: repack(d.zip, changed), resolved };
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

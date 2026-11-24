// EC6 (docs/ops/EC6_DESIGN.md "Exports"): a research report's Markdown as a Word (.docx) or PDF
// file. Sara only had readers (src/library/); these are the smallest writers that open in Word,
// LibreOffice, browsers and PDF viewers. The Markdown is the report's own small dialect: # title,
// ## / ### headings, paragraphs, "- " and "1. " lists, **bold**, [text](url) links and bare URLs.
// No dependency: DOCX is a stored zip (src/zip-write.ts); PDF 1.4 uses the built-in Helvetica in
// WinAnsi encoding for Western European text. C23: other text is drawn with a font already on
// this computer (src/pdf-fonts.ts), embedded with only the glyphs used; what can't be drawn right
// (no font here, or a script whose letters must be joined) is marked […] and named in a note under
// the title, never printed as "?" or boxes. The .md and .docx keep everything.
import { deflateSync } from 'node:zlib';
import { en, toLang, tr } from './i18n.ts';
import { subsetFace, SystemFonts, type Face } from './pdf-fonts.ts';
import { zipStored } from './zip-write.ts';

export interface Run {
  text: string;
  bold?: boolean;
  href?: string;
}
export type BlockKind = 'title' | 'h2' | 'h3' | 'p' | 'li' | 'oli' | 'quote';
export interface Block {
  kind: BlockKind;
  runs: Run[];
  /** The number of a numbered list item. */
  num?: number;
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(src: string): Run[] {
  const runs: Run[] = [];
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index > at) runs.push({ text: src.slice(at, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) runs.push({ text: /^\d+$/.test(m[2]) ? `[${m[2]}]` : m[2], href: m[3] });
    else runs.push({ text: m[4], href: m[4] });
    at = m.index + m[0].length;
  }
  if (at < src.length) runs.push({ text: src.slice(at) });
  return runs.filter((r) => r.text);
}

/** The report's Markdown as blocks of runs. */
export function parseReport(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', runs: inline(para.join(' ')) });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line) flush();
    else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: m[1].length === 1 ? 'title' : m[1].length === 2 ? 'h2' : 'h3', runs: inline(m[2]) });
    } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'li', runs: inline(m[1]) });
    } else if ((m = /^(\d+)\.\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'oli', runs: inline(m[2]), num: Number(m[1]) });
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'quote', runs: inline(m[1]) });
    } else para.push(line);
  }
  flush();
  return out;
}

// ---------- Word ----------

const xml = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const STYLE_OF: Record<BlockKind, string | null> = { title: 'Title', h2: 'Heading1', h3: 'Heading2', p: null, li: 'ListParagraph', oli: 'ListParagraph', quote: 'Quote' };

export function markdownToDocx(md: string, title: string): Buffer {
  const links: string[] = [];
  const rid = (href: string) => {
    let i = links.indexOf(href);
    if (i < 0) i = links.push(href) - 1;
    return `rId${i + 10}`;
  };
  const run = (r: Run) => {
    const t = `<w:r>${r.bold || r.href ? `<w:rPr>${r.href ? '<w:rStyle w:val="Hyperlink"/>' : ''}${r.bold ? '<w:b/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(r.text)}</w:t></w:r>`;
    return r.href ? `<w:hyperlink r:id="${rid(r.href)}" w:history="1">${t}</w:hyperlink>` : t;
  };
  const paras = parseReport(md).map((b) => {
    const style = STYLE_OF[b.kind];
    const lead = b.kind === 'li' ? [{ text: '• ' }] : b.kind === 'oli' ? [{ text: `${b.num}. ` }] : [];
    return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${[...lead, ...b.runs].map(run).join('')}</w:p>`;
  });
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id: string, name: string, size: number, extra = '') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>${extra}</w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style('Title', 'Title', 40)}${style('Heading1', 'heading 1', 30, '<w:outlineLvl w:val="0"/>')}${style('Heading2', 'heading 2', 26, '<w:outlineLvl w:val="1"/>')}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map((h, i) => `<Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(h)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ],
    [
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>Sara</dc:creator></cp:coreProperties>`,
    ],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', rels],
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })));
}

// ---------- PDF ----------

// Helvetica advance widths (per 1000 em) for ASCII 32..126 (the standard AFM metrics).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };

/** Whether Helvetica (WinAnsi) can write the character. */
function hasAnsi(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff) || ch in WIN_ANSI;
}
/** One character's WinAnsi byte ("?" when it has none; the text flow never sends such a character). */
function ansi(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) return c;
  return WIN_ANSI[ch] ?? 0x3f;
}
function widthOf(s: string, size: number, bold: boolean): number {
  let w = 0;
  for (const ch of s) {
    const b = ansi(ch);
    w += b >= 32 && b <= 126 ? HELV[b - 32] : b === 0x97 || b === 0x89 ? 1000 : 556;
  }
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}
function pdfString(s: string): string {
  let out = '(';
  for (const ch of s) {
    const b = ansi(ch);
    out += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 127 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}
/** A text string for the file's own details (its title): plain when ASCII, else UTF-16 so every script is kept. */
function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return pdfString(s);
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}
const asciiUrl = (u: string) => pdfString(encodeURI(decodeURI(u.replace(/%(?![\da-f]{2})/gi, '%25'))));

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const SIZE: Record<BlockKind, number> = { title: 18, h2: 14, h3: 12, p: 10.5, li: 10.5, oli: 10.5, quote: 10.5 };

// C23: text Helvetica can't write is drawn with a font already on this computer (src/pdf-fonts.ts).
// What can't be drawn right is never guessed at: it is marked […] and the PDF says which scripts.

/** Characters with no shape of their own (joiners, direction marks, emoji style and skin-tone marks). */
const INVISIBLE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{fe00}-\u{fe0f}\u{feff}\u{20e3}\u{e0000}-\u{e007f}\u{1f3fb}-\u{1f3ff}]/gu;
/**
 * Scripts whose letters join, stack or reorder (they need a shaping engine this writer does not
 * have) and right-to-left scripts other than Hebrew: marked, never drawn letter by letter.
 */
const NEEDS_SHAPING = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\u{600}-\u{8ff}\u{fb50}-\u{fdff}\u{fe70}-\u{fefe}\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
const HEBREW = /[\u{590}-\u{5ff}\u{fb1d}-\u{fb4f}]/u;
/** Scripts the note can name (ISO 15924 code, tested in this order). */
const SCRIPTS: [string, RegExp][] = (
  [
    ['Arab', 'Arabic'], ['Hebr', 'Hebrew'], ['Deva', 'Devanagari'], ['Beng', 'Bengali'], ['Guru', 'Gurmukhi'], ['Gujr', 'Gujarati'], ['Orya', 'Oriya'], ['Taml', 'Tamil'], ['Telu', 'Telugu'], ['Knda', 'Kannada'], ['Mlym', 'Malayalam'], ['Sinh', 'Sinhala'],
    ['Thai', 'Thai'], ['Laoo', 'Lao'], ['Tibt', 'Tibetan'], ['Mymr', 'Myanmar'], ['Khmr', 'Khmer'], ['Mong', 'Mongolian'], ['Syrc', 'Syriac'], ['Thaa', 'Thaana'], ['Nkoo', 'Nko'], ['Grek', 'Greek'], ['Cyrl', 'Cyrillic'], ['Armn', 'Armenian'], ['Geor', 'Georgian'],
    ['Hani', 'Han'], ['Hira', 'Hiragana'], ['Kana', 'Katakana'], ['Hang', 'Hangul'], ['Ethi', 'Ethiopic'], ['Cher', 'Cherokee'], ['Cans', 'Canadian_Aboriginal'], ['Latn', 'Latin'],
  ] as const
).map(([code, name]) => [code, new RegExp(`\\p{Script=${name}}`, 'u')]);
function scriptOf(ch: string): string {
  for (const [code, re] of SCRIPTS) if (re.test(ch)) return code;
  if (/[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}]/u.test(ch)) return 'emoji';
  return 'other';
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
/**
 * A word with Hebrew letters as it is drawn, left to right on the page: letters reversed (marks stay
 * on their letter), brackets mirrored, numbers and Latin words inside kept in their own order.
 */
export function visualOrder(word: string): string {
  const clusters = word.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
  const rev = clusters.reverse().map((c) => MIRROR[c] ?? c).join('');
  return rev.replace(/[\p{Script=Latin}\p{Nd}]+(?:[.,:/'’-][\p{Script=Latin}\p{Nd}]+)*/gu, (m) => [...m].reverse().join(''));
}
/** In a left-to-right paragraph the punctuation around a Hebrew word stays where it is. */
function visualCore(word: string): string {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}\p{M}]*)$/su.exec(word)!;
  return m[1] + visualOrder(m[2]) + m[3];
}

/** In a right-to-left paragraph the punctuation around a word of another script changes sides. */
function swapEnds(word: string): string {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}\p{M}]*)$/su.exec(word)!;
  const flip = (x: string) => [...x].reverse().map((c) => MIRROR[c] ?? c).join('');
  return flip(m[3]) + m[2] + flip(m[1]);
}

// Chinese and Japanese are written without spaces: a line may break between any two characters,
// but not before closing punctuation or after opening punctuation.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u{3000}-\u{303f}\u{ff00}-\u{ffef}]/u;
const NO_START = /[、。，．！？：；）］｝」』】〉》〕’”…ー々ゝゞ)\]}.,;:!?%]/u;
const NO_END = /[（［｛「『【〈《〔‘“(\[{]/u;
function breakPieces(word: string): string[] {
  if (!CJK.test(word)) return [word];
  const out: string[] = [];
  let cur = '';
  let prev = '';
  for (const ch of word) {
    if (cur && (CJK.test(prev) || CJK.test(ch)) && !NO_START.test(ch) && !NO_END.test(prev)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
    prev = ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A stretch of one word in one font: `gids` when it is a font of this computer, else Helvetica text. */
interface Seg {
  font: string;
  text: string;
  gids?: number[];
  width: number;
}
interface Word {
  segs: Seg[];
  width: number;
  bold: boolean;
  href?: string;
  /** Follows the word before it with no space (a break point inside text written without spaces). */
  glue: boolean;
  /** Has Hebrew letters / has no letters at all (for the order of words on a line). */
  rtl: boolean;
  neutral: boolean;
  /** Only the […] mark: text that could not be drawn. */
  gap: boolean;
}
interface Line {
  y: number;
  x: number;
  size: number;
  words: { x: number; w: Word; width: number }[];
}
interface UsedFont {
  tag: string;
  face: Face;
  bold: boolean;
  /** Glyph → the text it stands for (for copy and search). */
  gids: Map<number, string>;
}
const GAP = '[…]';

/** Hebrew words on one line in the order they are read: right to left, with numbers and other-script words in their own order. */
function orderLine(words: Line['words'], rtlPara: boolean): Line['words'] {
  if (!words.some((x) => x.w.rtl) || words.some((x) => x.w.glue)) return words;
  const out = [...words];
  const flip = (strong: (w: Word) => boolean) => {
    for (let i = 0; i < out.length; i++) {
      if (!strong(out[i].w)) continue;
      let j = i;
      for (let k = i + 1; k < out.length && (strong(out[k].w) || out[k].w.neutral); k++) if (strong(out[k].w)) j = k;
      if (j > i) out.splice(i, j - i + 1, ...out.slice(i, j + 1).reverse());
      i = j;
    }
  };
  if (rtlPara) {
    out.reverse();
    flip((w) => !w.rtl && !w.neutral);
  } else flip((w) => w.rtl);
  return out;
}

export interface PdfOptions {
  /** The reader's language, for the note about text that could not be drawn (English when not given). */
  lang?: string;
}

export function markdownToPdf(md: string, title: string, opts: PdfOptions = {}): Buffer {
  const blocks = parseReport(md);
  const all = blocks.map((b) => b.runs.map((r) => r.text).join(' ')).join(' ');
  let fonts: SystemFonts | null = null;
  const system = () => (fonts ??= new SystemFonts(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(all) ? 'ja' : /\p{Script=Hangul}/u.test(all) ? 'ko' : 'zh'));
  const used = new Map<string, UsedFont>();
  const missing = new Set<string>();
  const picks = new Map<string, { font: string; gid: number; face: Face } | null>();
  /** The font of this computer that draws a character, or null (then the text is marked). */
  const pick = (ch: string, bold: boolean) => {
    const key = `${bold ? 'b' : 'r'}${ch}`;
    if (picks.has(key)) return picks.get(key)!;
    let out: { font: string; gid: number; face: Face } | null = null;
    if (!NEEDS_SHAPING.test(ch)) {
      let found: ReturnType<SystemFonts['find']> = null;
      try {
        found = system().find(ch.codePointAt(0)!, bold);
      } catch {
        found = null;
      }
      if (found) {
        const id = `${found.face.path}#${found.face.index}`;
        let u = used.get(id);
        if (!u) used.set(id, (u = { tag: `G${used.size + 1}`, face: found.face, bold, gids: new Map() }));
        out = { font: u.tag, gid: found.gid, face: found.face };
      }
    }
    picks.set(key, out);
    return out;
  };

  const makeWord = (text: string, size: number, bold: boolean, href: string | undefined, glue: boolean): Word => {
    const segs: Seg[] = [];
    const base = bold ? 'F2' : 'F1';
    const add = (font: string, ch: string, width: number, gid?: number) => {
      const last = segs.at(-1);
      if (last && last.font === font && !(font === base && last.text === GAP)) {
        last.text += ch;
        last.width += width;
        if (gid !== undefined) last.gids!.push(gid);
      } else segs.push({ font, text: ch, width, ...(gid !== undefined ? { gids: [gid] } : {}) });
    };
    let drawn = false;
    let inGap = false;
    for (const ch of text) {
      if (hasAnsi(ch)) {
        add(base, ch, widthOf(ch, size, bold));
        drawn = true;
        inGap = false;
        continue;
      }
      const p = pick(ch, bold);
      if (p) {
        add(p.font, ch, (p.face.advance(p.gid) * size) / p.face.unitsPerEm, p.gid);
        used.get(`${p.face.path}#${p.face.index}`)!.gids.set(p.gid, ch);
        drawn = true;
        inGap = false;
        continue;
      }
      // Marks that sit on a letter that is itself not drawn belong to the same mark.
      if (!/\p{M}/u.test(ch) || !inGap) missing.add(/\p{M}/u.test(ch) && scriptOf(ch) === 'other' ? 'other' : scriptOf(ch));
      if (!inGap) segs.push({ font: base, text: GAP, width: widthOf(GAP, size, bold) });
      inGap = true;
    }
    return { segs, width: segs.reduce((n, s) => n + s.width, 0), bold, ...(href ? { href } : {}), glue, rtl: HEBREW.test(text), neutral: !/\p{L}/u.test(text), gap: !drawn && segs.length > 0 };
  };

  const wordsOf = (b: Block): { words: Word[]; rtlPara: boolean } => {
    const size = SIZE[b.kind];
    const heading = b.kind === 'title' || b.kind === 'h2' || b.kind === 'h3';
    const first = /\p{L}/u.exec(b.runs.map((r) => r.text).join(' '))?.[0] ?? '';
    const rtlPara = HEBREW.test(first);
    const words: Word[] = [];
    const push = (w: Word) => {
      // A run of words that can't be drawn is one mark, not a row of them.
      if (w.gap && words.at(-1)?.gap) return;
      if (w.segs.length) words.push(w);
    };
    if (b.kind === 'li') push(makeWord('•', size, false, undefined, false));
    if (b.kind === 'oli') push(makeWord(`${b.num}.`, size, false, undefined, false));
    for (const r of b.runs) {
      const bold = heading || Boolean(r.bold);
      for (const raw of r.text.normalize('NFC').replace(INVISIBLE, '').split(/\s+/)) {
        if (!raw) continue;
        const piece = HEBREW.test(raw) ? (rtlPara ? visualOrder(raw) : visualCore(raw)) : rtlPara ? (/\p{L}/u.test(raw) ? swapEnds(raw) : visualOrder(raw)) : raw;
        breakPieces(piece).forEach((p, i) => push(makeWord(p, size, bold, r.href, i > 0)));
      }
    }
    return { words, rtlPara };
  };

  const prepared = blocks.map((b) => ({ b, ...wordsOf(b) }));
  if (missing.size) {
    // Say plainly what is not there, under the title, in the reader's language.
    const lang = toLang(opts.lang) ?? 'en';
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([lang], { type: 'script' });
    } catch {
      names = null;
    }
    const what = [...missing].sort((a, b) => Number(a === 'other') - Number(b === 'other') || a.localeCompare(b)).map((code) => (code === 'emoji' ? tr(en('some emoji'), lang) : code === 'other' ? tr(en('some other characters'), lang) : (names?.of(code) ?? code)));
    const note: Block = { kind: 'quote', runs: [{ text: tr(en('Not shown in this PDF: {what}. Each place is marked […]. The PDF writer could not draw this text with the fonts on this computer. The other download formats have all of it.'), lang, { what: what.join(', ') }) }] };
    const at = prepared[0]?.b.kind === 'title' ? 1 : 0;
    prepared.splice(at, 0, { b: note, ...wordsOf(note) });
  }

  const pages: Line[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const { b, words, rtlPara } of prepared) {
    const size = SIZE[b.kind];
    const lead = size * 1.35;
    const heading = b.kind === 'title' || b.kind === 'h2' || b.kind === 'h3';
    const indent = b.kind === 'li' || b.kind === 'oli' || b.kind === 'quote' ? 16 : 0;
    y -= heading ? size * 0.8 : size * 0.35;
    const maxW = PAGE_W - 2 * MARGIN - indent;
    const space = widthOf(' ', size, false);
    const mine: Line[] = [];
    let line: Line | undefined;
    for (const w of words) {
      const width = w.width;
      const at = line ? line.words.at(-1)!.x + line.words.at(-1)!.width + (w.glue ? 0 : space) : 0;
      if (!line || at + width > maxW) {
        if (y - lead < MARGIN) {
          pages.push([]);
          y = PAGE_H - MARGIN;
        }
        y -= lead;
        line = { y, x: MARGIN + indent, size, words: [] };
        pages.at(-1)!.push(line);
        mine.push(line);
        line.words.push({ x: 0, w, width });
      } else line.words.push({ x: at, w, width });
    }
    // Hebrew: the words of each line in reading order, the line against the right edge.
    for (const l of mine) {
      if (!l.words.some((x) => x.w.rtl)) continue;
      l.words = orderLine(l.words, rtlPara);
      let x = 0;
      l.words.forEach((it, i) => {
        if (i) x += it.w.glue ? 0 : space;
        it.x = x;
        x += it.width;
      });
      if (rtlPara) l.x = Math.max(l.x, MARGIN + indent + maxW - x);
    }
    if (heading) y -= size * 0.2;
  }

  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then for each font of this
  // computer that was used: the font, its description, its file (only the glyphs used) and its
  // glyph → text table; then per page: page, content, links.
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  add('');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(`<< /Title ${pdfTextString(title)} /Creator (Sara) /Producer (Sara) >>`);
  const fontRefs: string[] = [];
  const stream = (dict: string, data: Buffer) => `<< ${dict} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`;
  for (const u of used.values()) {
    const f = u.face;
    const k = 1000 / f.unitsPerEm;
    const gids = [...u.gids.keys()].sort((a, b) => a - b);
    const file = subsetFace(f, gids);
    // Six letters made from the glyphs kept, as the PDF rules ask of a partial font.
    let h = gids.reduce((n, g) => (n * 31 + g) >>> 0, 7);
    let prefix = '';
    for (let i = 0; i < 6; i++, h = Math.floor(h / 26)) prefix += String.fromCharCode(65 + (h % 26));
    const name = `${prefix}+${f.name}`;
    const fileId = add(stream(`/Filter /FlateDecode /Length1 ${file.length}`, deflateSync(file)));
    const descId = add(`<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${f.bbox.map((v) => Math.round(v * k)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * k)} /Descent ${Math.round(f.descent * k)} /CapHeight ${Math.round(f.ascent * k)} /StemV ${u.bold ? 120 : 80} /FontFile2 ${fileId} 0 R >>`);
    const cidId = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 1000 /W [${gids.map((g) => `${g} [${Math.round(f.advance(g) * k)}]`).join(' ')}] /CIDToGIDMap /Identity >>`);
    const hex16 = (s: string) => [...s].map((ch) => Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i).toString(16).padStart(4, '0')).join('')).join('').toUpperCase();
    const rows = gids.map((g) => `<${g.toString(16).padStart(4, '0').toUpperCase()}> <${hex16(u.gids.get(g)!)}>`);
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < rows.length; i += 100) cmap += `${Math.min(100, rows.length - i)} beginbfchar\n${rows.slice(i, i + 100).join('\n')}\nendbfchar\n`;
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    const uniId = add(stream('', Buffer.from(cmap, 'latin1')));
    fontRefs.push(`/${u.tag} ${add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${uniId} 0 R >>`)} 0 R`);
  }
  const kids: number[] = [];
  for (const lines of pages) {
    let content = '';
    const annots: number[] = [];
    for (const l of lines) {
      // One text position per line; the words follow on their own advance with real spaces between
      // them, so viewers and text extractors read whole lines. x is only used for the link boxes.
      content += `BT\n1 0 0 1 ${l.x.toFixed(2)} ${l.y.toFixed(2)} Tm\n`;
      let font = '';
      const use = (f: string) => {
        if (f !== font) content += `/${f} ${l.size} Tf\n`;
        font = f;
      };
      for (const [i, { w }] of l.words.entries()) {
        const next = l.words[i + 1];
        const spaced = Boolean(next) && !next.w.glue;
        if (w.href) content += '0.02 0.34 0.76 rg\n';
        for (const [j, s] of w.segs.entries()) {
          use(s.font);
          if (s.gids) content += `<${s.gids.map((g) => g.toString(16).padStart(4, '0')).join('')}> Tj\n`;
          else content += `${pdfString(spaced && j === w.segs.length - 1 ? `${s.text} ` : s.text)} Tj\n`;
        }
        // After a word that ends in a font of this computer the space is Helvetica's.
        if (spaced && w.segs.at(-1)?.gids) {
          use('F1');
          content += '( ) Tj\n';
        }
        if (w.href) content += '0 0 0 rg\n';
      }
      content += 'ET\n';
      for (const { x, w, width } of l.words) {
        if (!w.href) continue;
        annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [${(l.x + x).toFixed(2)} ${(l.y - 2).toFixed(2)} ${(l.x + x + width).toFixed(2)} ${(l.y + l.size).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI ${asciiUrl(w.href)} >> >>`));
      }
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R${fontRefs.length ? ` ${fontRefs.join(' ')}` : ''} >> >> /Contents ${contentId} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

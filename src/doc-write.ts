// EC6 (docs/ops/EC6_DESIGN.md "Exports"): a research report's Markdown as a Word (.docx) or PDF
// file. Sara only had readers (src/library/); these are the smallest writers that open in Word,
// LibreOffice, browsers and PDF viewers. The Markdown is the report's own small dialect: # title,
// ## / ### headings, paragraphs, "- " and "1. " lists, **bold**, [text](url) links and bare URLs.
// No dependency: DOCX is a stored zip (src/zip-write.ts); PDF 1.4 uses the built-in Helvetica in
// WinAnsi encoding (characters outside it are written as "?"; the .md and .docx keep them).
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

/** One character's WinAnsi byte ("?" when it has none). */
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
const asciiUrl = (u: string) => pdfString(encodeURI(decodeURI(u.replace(/%(?![\da-f]{2})/gi, '%25'))));

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const SIZE: Record<BlockKind, number> = { title: 18, h2: 14, h3: 12, p: 10.5, li: 10.5, oli: 10.5, quote: 10.5 };

interface Word {
  text: string;
  bold: boolean;
  href?: string;
}
interface Line {
  y: number;
  x: number;
  size: number;
  words: { x: number; w: Word; width: number }[];
}

export function markdownToPdf(md: string, title: string): Buffer {
  const pages: Line[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const b of parseReport(md)) {
    const size = SIZE[b.kind];
    const lead = size * 1.35;
    const heading = b.kind === 'title' || b.kind === 'h2' || b.kind === 'h3';
    const indent = b.kind === 'li' || b.kind === 'oli' || b.kind === 'quote' ? 16 : 0;
    y -= heading ? size * 0.8 : size * 0.35;
    const words: Word[] = [];
    if (b.kind === 'li') words.push({ text: '•', bold: false });
    if (b.kind === 'oli') words.push({ text: `${b.num}.`, bold: false });
    for (const r of b.runs) for (const piece of r.text.split(/\s+/)) if (piece) words.push({ text: piece, bold: heading || Boolean(r.bold), ...(r.href ? { href: r.href } : {}) });
    const maxW = PAGE_W - 2 * MARGIN - indent;
    let line: Line | undefined;
    for (const w of words) {
      const width = widthOf(w.text, size, w.bold);
      const space = widthOf(' ', size, false);
      const at = line ? line.words.at(-1)!.x + line.words.at(-1)!.width + space : 0;
      if (!line || at + width > maxW) {
        if (y - lead < MARGIN) {
          pages.push([]);
          y = PAGE_H - MARGIN;
        }
        y -= lead;
        line = { y, x: MARGIN + indent, size, words: [] };
        pages.at(-1)!.push(line);
        line.words.push({ x: 0, w, width });
      } else line.words.push({ x: at, w, width });
    }
    if (heading) y -= size * 0.2;
  }

  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then per page: page, content, links.
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  add('');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(`<< /Title ${pdfString(title)} /Creator (Sara) /Producer (Sara) >>`);
  const kids: number[] = [];
  for (const lines of pages) {
    let content = '';
    const annots: number[] = [];
    for (const l of lines) {
      // One text position per line; the words follow on their own advance with real spaces between
      // them, so viewers and text extractors read whole lines. x is only used for the link boxes.
      content += `BT\n1 0 0 1 ${l.x.toFixed(2)} ${l.y.toFixed(2)} Tm\n`;
      let font = '';
      for (const [i, { w }] of l.words.entries()) {
        const f = w.bold ? 'F2' : 'F1';
        if (f !== font) content += `/${f} ${l.size} Tf\n`;
        font = f;
        if (w.href) content += '0.02 0.34 0.76 rg\n';
        content += `${pdfString(i < l.words.length - 1 ? `${w.text} ` : w.text)} Tj\n`;
        if (w.href) content += '0 0 0 rg\n';
      }
      content += 'ET\n';
      for (const { x, w, width } of l.words) {
        if (!w.href) continue;
        annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [${(l.x + x).toFixed(2)} ${(l.y - 2).toFixed(2)} ${(l.x + x + width).toFixed(2)} ${(l.y + l.size).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI ${asciiUrl(w.href)} >> >>`));
      }
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
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

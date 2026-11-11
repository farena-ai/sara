// make_document → PDF. A PDF 1.4 writer with no dependency: the standard Helvetica family and
// Courier in WinAnsi encoding (every letter of English, Spanish, French, German, Portuguese and
// Italian; other letters lose their accent, and characters with no Latin form become \"?\"), Flate-
// compressed pages, wrapped text with bold, italic, code and real links, nested lists, tables with
// a repeated header row, pictures (JPEG, PNG), page breaks and page numbers.
import { deflateSync } from 'node:zlib';
import { type Block, plain, type Run } from './markdown.ts';
import { fitSize, pdfImage } from './images.ts';
import { docBlocks, type DocSpec, type ImageLookup, sectionLevel } from './spec.ts';
import { rgb, THEMES, type Theme } from './theme.ts';

// Advance widths per 1000 em for ASCII 32..126 (the standard AFM metrics).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const NEAR: Record<string, string> = { 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ø': 'ø', '−': '-', '‐': '-', '‑': '-', '′': "'", '″': '"', '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '≠': '!=', '✓': 'v', '✔': 'v', '★': '*', '☆': '*', '▪': '•', '◦': '•', '·': '·', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ' };

/** The text as WinAnsi characters (accents dropped where WinAnsi has no such letter). */
export function toAnsi(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI[ch]) out += ch;
    else if (NEAR[ch]) out += NEAR[ch];
    else if (c < 32) out += ' ';
    else {
      const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
      out += base && base !== ch && [...base].every((b) => b.charCodeAt(0) < 0x100) ? base : '?';
    }
  }
  return out;
}
const byteOf = (ch: string): number => {
  const c = ch.codePointAt(0)!;
  return c < 0x100 ? c : (WIN_ANSI[ch] ?? 0x3f);
};

type Font = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';
const fontOf = (r: { bold?: boolean; italic?: boolean; code?: boolean }): Font => (r.code ? 'F5' : r.bold && r.italic ? 'F4' : r.bold ? 'F2' : r.italic ? 'F3' : 'F1');

function charWidth(ch: string, font: Font): number {
  if (font === 'F5') return 600;
  const table = font === 'F2' || font === 'F4' ? HELV_BOLD : HELV;
  const b = byteOf(ch);
  if (b >= 32 && b <= 126) return table[b - 32];
  if (b === 0x95) return 350;
  if (b === 0x97 || b === 0x89) return 1000;
  if (b === 0x96 || b === 0x80) return 556;
  if (b === 0x85) return 1000;
  if (b >= 0x91 && b <= 0x94) return 222;
  const base = ch.normalize('NFD')[0];
  const bb = base ? base.charCodeAt(0) : 0;
  if (bb >= 32 && bb <= 126) return table[bb - 32];
  return 556;
}
export function textWidth(s: string, font: Font, size: number): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, font);
  return (w * size) / 1000;
}
function pdfString(s: string): string {
  let out = '(';
  for (const ch of s) {
    const b = byteOf(ch);
    out += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b >= 32 && b < 127 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}
const asciiUrl = (u: string) => pdfString(u.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c)));
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const color = (hex: string) => rgb(hex).map((c) => n(c)).join(' ');

const PAGE_W = 612; // US Letter
const PAGE_H = 792;

interface Seg {
  text: string;
  font: Font;
  size: number;
  color: string;
  href?: string;
  x: number;
  w: number;
}
interface Line {
  segs: Seg[];
  w: number;
}

/** Runs wrapped into lines no wider than maxW. */
function wrap(runs: Run[], size: number, maxW: number, colorHex: string, force: Partial<Run> = {}, linkHex = '0B5CAD'): Line[] {
  const lines: Line[] = [{ segs: [], w: 0 }];
  const add = (text: string, r: Run, font: Font) => {
    let line = lines.at(-1)!;
    let w = textWidth(text, font, size);
    const space = /^\s+$/.test(text);
    if (space && !line.segs.length) return;
    // (an empty line from a line break keeps its height)
    if (!space && line.w + w > maxW && line.segs.length) {
      // Trailing spaces don't count.
      const last = line.segs.at(-1)!;
      if (/\s$/.test(last.text)) {
        last.text = last.text.trimEnd();
        last.w = textWidth(last.text, last.font, size);
      }
      line = { segs: [], w: 0 };
      lines.push(line);
    }
    // A word longer than the line is cut.
    while (!space && w > maxW) {
      let cut = '';
      for (const ch of text) {
        if (textWidth(cut + ch, font, size) > maxW - line.w && cut) break;
        cut += ch;
      }
      add(cut, r, font);
      text = text.slice(cut.length);
      line = { segs: [], w: 0 };
      lines.push(line);
      w = textWidth(text, font, size);
    }
    const prev = line.segs.at(-1);
    const c = r.href ? linkHex : colorHex;
    if (prev && prev.font === font && prev.href === r.href && prev.color === c) {
      prev.text += text;
      prev.w += w;
    } else line.segs.push({ text, font, size, color: c, ...(r.href ? { href: r.href } : {}), x: line.w, w });
    line.w += w;
  };
  for (const r0 of runs) {
    const r = { ...r0, ...force };
    const font = fontOf(r);
    r.text.split('\n').forEach((part, i) => {
      if (i) lines.push({ segs: [], w: 0 });
      for (const piece of toAnsi(part).split(/(\s+)/)) if (piece) add(/^\s+$/.test(piece) ? ' ' : piece, r, font);
    });
  }
  const last = lines.at(-1)!;
  if (!last.segs.length && lines.length > 1) lines.pop();
  return lines;
}

interface Page {
  ops: string[];
  annots: string[];
  images: Set<number>;
}

export function makePdf(spec: DocSpec, image: ImageLookup): Buffer {
  const th: Theme = THEMES[spec.template];
  const M = th.margin;
  const W = PAGE_W - 2 * M;
  const bottom = M + 18;
  const pages: Page[] = [];
  let page!: Page;
  let y = 0;
  const newPage = () => {
    page = { ops: [], annots: [], images: new Set() };
    pages.push(page);
    y = PAGE_H - M;
  };
  newPage();
  const ensure = (h: number) => {
    if (y - h < bottom && y < PAGE_H - M - 1) newPage();
  };
  const objs: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => objs.push(body);
  // 1 catalog, 2 pages, 3..7 fonts, 8 info; images and pages follow.
  for (let i = 0; i < 8; i++) add('');
  const imageCache = new Map<string, { id: number; w: number; h: number } | null>();

  const drawLines = (lines: Line[], x: number, size: number, lead: number, align: 'left' | 'center' = 'left') => {
    for (const l of lines) {
      ensure(size * lead);
      y -= size * lead;
      const base = y + size * (lead - 1) * 0.5;
      const off = align === 'center' ? (W - l.w) / 2 : 0;
      for (const s of l.segs) {
        if (!s.text) continue;
        page.ops.push(`BT /${s.font} ${n(s.size)} Tf ${color(s.color)} rg 1 0 0 1 ${n(x + off + s.x)} ${n(base)} Tm ${pdfString(s.text)} Tj ET`);
        if (s.href) {
          page.ops.push(`${color(s.color)} RG 0.5 w ${n(x + off + s.x)} ${n(base - 1.5)} m ${n(x + off + s.x + s.w)} ${n(base - 1.5)} l S`);
          page.annots.push(`<< /Type /Annot /Subtype /Link /Rect [${n(x + off + s.x)} ${n(base - 3)} ${n(x + off + s.x + s.w)} ${n(base + s.size)}] /Border [0 0 0] /A << /S /URI /URI ${asciiUrl(s.href)} >> >>`);
        }
      }
    }
  };
  const rule = (x1: number, x2: number, hex: string, width = 0.75) => page.ops.push(`${color(hex)} RG ${n(width)} w ${n(x1)} ${n(y)} m ${n(x2)} ${n(y)} l S`);

  const pictureObj = (ref: string) => {
    if (imageCache.has(ref)) return imageCache.get(ref)!;
    const p = image(ref);
    const img = p ? pdfImage(p) : undefined;
    let v: { id: number; w: number; h: number } | null = null;
    if (img) {
      let smask = '';
      if (img.mask) {
        const mid = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.mask.dict} /Length ${img.mask.data.length} >>\nstream\n`, 'latin1'), img.mask.data, Buffer.from('\nendstream', 'latin1')]));
        smask = ` /SMask ${mid} 0 R`;
      }
      const id = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.dict}${smask} /Length ${img.data.length} >>\nstream\n`, 'latin1'), img.data, Buffer.from('\nendstream', 'latin1')]));
      v = { id, w: img.width, h: img.height };
    }
    imageCache.set(ref, v);
    return v;
  };

  const blocks = docBlocks(spec);
  let first = true;
  let prev: Block | undefined;
  for (const b of blocks) {
    const body = th.body;
    switch (b.t) {
      case 'break':
        newPage();
        break;
      case 'h': {
        const isTitle = first && b.level === 1 && spec.template !== 'letter';
        const sec = sectionLevel(b.level);
        const size = isTitle ? th.title : sec === 1 ? th.h1 : th.h2;
        const runs = th.sectionRule && !isTitle && sec === 1 ? b.runs.map((r) => ({ ...r, text: r.text.toLocaleUpperCase() })) : b.runs;
        const lines = wrap(runs, size, W, isTitle ? '111827' : th.accent, { bold: true });
        y -= prev ? (isTitle ? 0 : size * 0.9) : 0;
        ensure(lines.length * size * 1.25 + body * 3);
        drawLines(lines, M, size, 1.25, isTitle ? th.titleAlign : 'left');
        if ((isTitle && th.titleRule) || (!isTitle && th.sectionRule && sec === 1)) {
          y -= 4;
          rule(M, M + W, isTitle ? th.accent : 'B6C2D1', isTitle ? 1.5 : 0.75);
          y -= isTitle ? 10 : 4;
        } else y -= isTitle ? 10 : size * 0.3;
        break;
      }
      case 'p': {
        if (!b.runs.length) break;
        // A resume's contact line (right under the centered name) is centered too.
        const contact = th.titleAlign === 'center' && prev?.t === 'h' && prev.level === 1;
        const lines = wrap(b.runs, body, W, contact ? th.muted : '1F2937');
        // Short paragraphs stay together on one page.
        if (lines.length <= 4) ensure(lines.length * body * th.lead);
        drawLines(lines, M, body, th.lead, contact ? 'center' : 'left');
        y -= th.after;
        break;
      }
      case 'li': {
        const indent = 18 + b.depth * 16;
        const lines = wrap(b.runs, body, W - indent, '1F2937');
        const mark = b.ordered ? `${b.num}.` : b.depth === 1 ? '–' : b.depth === 2 ? '·' : '•';
        ensure(body * th.lead);
        // The first line fits on this page (ensured above), so the marker goes beside it here.
        const top = y;
        const markPage = page;
        const at = page.ops.length;
        drawLines(lines, M + indent, body, th.lead);
        const base = top - body * th.lead + body * (th.lead - 1) * 0.5;
        const mw = textWidth(mark, 'F1', body);
        // Before the item's text, so text extraction reads "• First point".
        markPage.ops.splice(at, 0, `BT /F1 ${n(body)} Tf ${color(th.accent)} rg 1 0 0 1 ${n(M + indent - 6 - mw)} ${n(base)} Tm ${pdfString(mark)} Tj ET`);
        y -= th.after * 0.4;
        break;
      }
      case 'quote': {
        const lines = wrap(b.runs, body, W - 18, '4B5563', { italic: true });
        // The quote and its bar start on the same page.
        ensure(Math.min(lines.length, 6) * body * th.lead);
        const top = y;
        drawLines(lines, M + 14, body, th.lead);
        if (page.ops.length && top - y > 0) page.ops.push(`${color(th.accent)} RG 2 w ${n(M + 3)} ${n(Math.min(top, PAGE_H - M) - 2)} m ${n(M + 3)} ${n(y + 1)} l S`);
        y -= th.after;
        break;
      }
      case 'code': {
        const size = 8.5;
        const lead = size * 1.35;
        const rows = b.text.split('\n').flatMap((l) => wrap([{ text: l.replace(/ /g, '\u00a0') || ' ', code: true }], size, W - 16, '111827'));
        for (const l of rows) {
          ensure(lead + 4);
          page.ops.push(`0.96 0.96 0.97 rg ${n(M)} ${n(y - lead - 2)} ${n(W)} ${n(lead + 2)} re f`);
          y -= lead;
          for (const s of l.segs) page.ops.push(`BT /F5 ${n(size)} Tf ${color(s.color)} rg 1 0 0 1 ${n(M + 8 + s.x)} ${n(y + 2)} Tm ${pdfString(s.text)} Tj ET`);
        }
        y -= th.after + 4;
        break;
      }
      case 'hr':
        y -= 6;
        ensure(8);
        rule(M, M + W, 'D1D5DB');
        y -= 8;
        break;
      case 'img': {
        const obj = pictureObj(b.ref);
        if (!obj) {
          if (b.alt) drawLines(wrap([{ text: `[${b.alt}]`, italic: true }], body, W, th.muted), M, body, th.lead);
          break;
        }
        const { w, h } = fitSize({ width: obj.w, height: obj.h }, W, 320);
        y -= 4;
        ensure(h + (b.alt ? 18 : 6));
        y -= h;
        page.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(M + (W - w) / 2)} ${n(y)} cm /Im${obj.id} Do Q`);
        page.images.add(obj.id);
        if (b.alt) drawLines(wrap([{ text: b.alt, italic: true }], body - 1.5, W, th.muted), M, body - 1.5, 1.4, 'center');
        y -= th.after + 4;
        break;
      }
      case 'table': {
        const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
        if (!cols) break;
        const size = Math.max(7.5, body - 1);
        const pad = 4;
        const natural = Array.from({ length: cols }, (_, c) => Math.max(24, ...[b.head, ...b.rows].map((r, i) => textWidth(toAnsi(plain(r[c] ?? [])), i === 0 ? 'F2' : 'F1', size) + 2 * pad)));
        const total = natural.reduce((a, v) => a + v, 0);
        const widths = total <= W ? natural.map((v) => (v * W) / total) : (() => {
          // Shrink the widest columns first; every column keeps at least an even share's half.
          const floor = W / cols / 2;
          const capped = natural.map((v) => Math.max(floor, v));
          const sum = capped.reduce((a, v) => a + v, 0);
          return capped.map((v) => (v * W) / sum);
        })();
        const rowOf = (r: Run[][], head: boolean) => {
          const cellLines = widths.map((cw, c) => wrap(r[c] ?? [], size, cw - 2 * pad, head ? '111827' : '1F2937', head ? { bold: true } : {}));
          const h = Math.max(1, ...cellLines.map((l) => l.length)) * size * 1.3 + 2 * pad;
          return { cellLines, h };
        };
        const drawRow = (row: { cellLines: Line[][]; h: number }, head: boolean) => {
          ensure(row.h);
          const top = y;
          if (head) page.ops.push(`${color(th.head)} rg ${n(M)} ${n(top - row.h)} ${n(W)} ${n(row.h)} re f`);
          let x = M;
          row.cellLines.forEach((lines, c) => {
            let yy = top - pad;
            for (const l of lines) {
              yy -= size * 1.3;
              for (const s of l.segs) {
                page.ops.push(`BT /${s.font} ${n(size)} Tf ${color(s.color)} rg 1 0 0 1 ${n(x + pad + s.x)} ${n(yy + size * 0.28)} Tm ${pdfString(s.text)} Tj ET`);
                if (s.href) page.annots.push(`<< /Type /Annot /Subtype /Link /Rect [${n(x + pad + s.x)} ${n(yy)} ${n(x + pad + s.x + s.w)} ${n(yy + size)}] /Border [0 0 0] /A << /S /URI /URI ${asciiUrl(s.href)} >> >>`);
              }
            }
            x += widths[c];
          });
          page.ops.push(`0.82 0.84 0.87 RG 0.5 w ${n(M)} ${n(top - row.h)} ${n(W)} ${n(row.h)} re S`);
          let xx = M;
          for (const cw of widths.slice(0, -1)) {
            xx += cw;
            page.ops.push(`${n(xx)} ${n(top)} m ${n(xx)} ${n(top - row.h)} l S`);
          }
          y = top - row.h;
        };
        y -= 4;
        const head = rowOf(b.head, true);
        const firstRow = b.rows[0] ? rowOf(b.rows[0], false) : undefined;
        ensure(head.h + (firstRow?.h ?? 0));
        drawRow(head, true);
        for (const r of b.rows) {
          const row = rowOf(r, false);
          if (y - row.h < bottom) {
            newPage();
            drawRow(head, true);
          }
          drawRow(row, false);
        }
        y -= th.after + 6;
        break;
      }
    }
    if (b.t !== 'break') first = false;
    prev = b;
  }

  // Fonts and info.
  objs[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objs[7] = `<< /Title ${pdfString(toAnsi(spec.title))} /Creator (Sara) /Producer (Sara) >>`;
  const numbered = th.pageNumbers === 'always' || (th.pageNumbers === 'many' && pages.length > 1);
  const kids: number[] = [];
  pages.forEach((p, i) => {
    if (numbered) {
      const label = `${i + 1} / ${pages.length}`;
      p.ops.push(`BT /F1 8.5 Tf ${color(th.muted)} rg 1 0 0 1 ${n((PAGE_W - textWidth(label, 'F1', 8.5)) / 2)} ${n(M / 2)} Tm ${pdfString(label)} Tj ET`);
    }
    const content = deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
    const annots = p.annots.map((a) => add(a));
    const xo = [...p.images].map((id) => `/Im${id} ${id} 0 R`).join(' ');
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> /Contents ${contentId} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
  });
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(size);
    const c = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(c);
    size += c.length;
  });
  const tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(chunks);
}

// W5.3 (docs/design/W5BACKUP.md): the printable recovery sheet. One Letter page, no dependency:
// the 18 words in a numbered grid, the QR code (drawn as squares, so it prints sharp), the date and
// how to restore with it. Text in the owner's language (WinAnsi letters, like make_document's PDFs).
import { toAnsi } from './documents/pdf.ts';
import { en, trOwner } from './i18n.ts';
import { makeQr } from './qr.ts';
import type { Settings } from './settings.ts';

export interface SheetInput {
  words: string[];
  qrText: string;
  madeAt: string;
  owner?: string;
  lang?: string;
}

const W = 612;
const H = 792;
const esc = (s: string) => Buffer.from(toAnsi(s), 'latin1').toString('latin1').replace(/[\\()]/g, (c) => `\\${c}`);

/** Greedy wrap by an average Helvetica width (good enough for short paragraphs). */
function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(10, Math.floor(width / (size * 0.5)));
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function carrySheetPdf(o: SheetInput): Buffer {
  const s = { language: o.lang ?? 'en' } as Pick<Settings, 'language' | 'languageDetected'>;
  const tr = (k: string, p?: Record<string, unknown>) => trOwner(k, s, p);
  const ops: string[] = [];
  const text = (x: number, y: number, size: number, str: string, bold = false) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(str)}) Tj ET`);
  const para = (x: number, y: number, size: number, str: string, width: number, lead = size * 1.35): number => {
    for (const l of wrap(str, size, width)) {
      text(x, y, size, l);
      y -= lead;
    }
    return y;
  };
  let y = H - 64;
  text(54, y, 24, tr(en('Recovery sheet')), true);
  y -= 22;
  const date = o.madeAt.slice(0, 10);
  y = para(54, y, 11, o.owner ? tr(en("For {name}'s Sara. Made {date}."), { name: o.owner, date }) : tr(en('For your Sara. Made {date}.'), { date }), 504);
  y -= 6;
  y = para(54, y, 11, tr(en('These 18 words open your sealed backups (.sara files) on any computer. Keep this page somewhere safe, like with your passport. Anyone with this page and a backup can open the backup.')), 504);
  // Words: 3 columns x 6 rows, numbered.
  y -= 18;
  const top = y;
  ops.push('0.85 G 1 w');
  ops.push(`54 ${top - 5 * 30 - 14} 330 ${5 * 30 + 36} re S`);
  ops.push('0 G');
  o.words.forEach((w, i) => {
    const col = Math.floor(i / 6);
    const row = i % 6;
    const x = 66 + col * 108;
    const yy = top - row * 30;
    text(x, yy, 10, `${i + 1}.`);
    text(x + 20, yy, 15, w, true);
  });
  // The QR code to the right of the words.
  const q = makeQr(o.qrText);
  const box = 150;
  const cell = box / (q.size + 8);
  const qx = W - 54 - box;
  const qy = top - 6 * 30 + 12;
  ops.push('0 g');
  q.modules.forEach((row, yy) =>
    row.forEach((dark, xx) => {
      if (dark) ops.push(`${(qx + (xx + 4) * cell).toFixed(2)} ${(qy + box - (yy + 5) * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f`);
    }),
  );
  y = top - 6 * 30 - 34;
  para(qx, qy - 12, 9, tr(en('Scan it with your phone instead of typing.')), box, 11);
  y -= 8;
  text(54, y, 14, tr(en('Restore on a new computer')), true);
  y -= 20;
  const steps = [
    tr(en('Install Sara on the new computer and open her.')),
    tr(en('Go to Settings, Privacy & system, Backups, Restore on a new computer.')),
    tr(en("Plug in the drive with your backup, or choose the .sara file a friend's Sara kept for you.")),
    tr(en('Type the 18 words (or paste what your phone read from the QR code). Sara checks the backup before anything changes.')),
  ];
  steps.forEach((st, i) => {
    text(54, y, 11, `${i + 1}.`);
    y = para(72, y, 11, st, 486) - 4;
  });
  y -= 10;
  para(54, y, 9.5, tr(en('Sara shows these words only once. If you make a new sheet, she uses a new key from then on; backups made before still need this page.')), 504);
  const content = Buffer.from(ops.join('\n'), 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`,
    `<< /Title (${esc(tr(en('Recovery sheet')))}) /Producer (Sara) >>`,
  ];
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// fill_document PDF fixtures: small PDFs written by hand (objects, a cross-reference table or a
// cross-reference stream with an object stream), with an AcroForm of every common kind of field.
// Used by test/fill-pdf.test.ts and the real-renderer check.
import { deflateSync } from 'node:zlib';

type Body = string | Buffer;
/** A stream object's body: its dictionary (without /Length) and data. */
export const stream = (dict: string, data: string | Buffer): Buffer => {
  const d = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([Buffer.from(`<<${dict} /Length ${d.length}>>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]);
};

/** Builds a PDF from numbered objects. xrefStream: a 1.5 cross-reference stream, with the plain objects packed in an object stream. */
export function buildPdf(objs: Record<number, Body>, opts: { xrefStream?: boolean; trailer?: string } = {}): Buffer {
  const nums = Object.keys(objs).map(Number).sort((a, b) => a - b);
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length;
  const put = (b: Body) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    pos += buf.length;
  };
  const where = new Map<number, { type: 1 | 2; a: number; b: number }>();
  const max = nums[nums.length - 1];
  if (!opts.xrefStream) {
    for (const n of nums) {
      where.set(n, { type: 1, a: pos, b: 0 });
      put(`${n} 0 obj\n`);
      put(objs[n]);
      put('\nendobj\n');
    }
    const xref = pos;
    let s = `xref\n0 ${max + 1}\n0000000000 65535 f\r\n`;
    for (let n = 1; n <= max; n++) {
      const w = where.get(n);
      s += w ? `${String(w.a).padStart(10, '0')} 00000 n\r\n` : '0000000000 65535 f\r\n';
    }
    s += `trailer\n<</Size ${max + 1} /Root 1 0 R${opts.trailer ?? ''}>>\nstartxref\n${xref}\n%%EOF\n`;
    put(s);
    return Buffer.concat(parts);
  }
  const packed = nums.filter((n) => typeof objs[n] === 'string');
  const loose = nums.filter((n) => typeof objs[n] !== 'string');
  for (const n of loose) {
    where.set(n, { type: 1, a: pos, b: 0 });
    put(`${n} 0 obj\n`);
    put(objs[n]);
    put('\nendobj\n');
  }
  const stmNum = max + 1;
  let head = '';
  let body = '';
  packed.forEach((n, i) => {
    head += `${n} ${body.length} `;
    body += `${objs[n] as string}\n`;
    where.set(n, { type: 2, a: stmNum, b: i });
  });
  const data = deflateSync(Buffer.from(head + body, 'latin1'));
  where.set(stmNum, { type: 1, a: pos, b: 0 });
  put(`${stmNum} 0 obj\n`);
  put(stream(`/Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode`, data));
  put('\nendobj\n');
  const xrefNum = stmNum + 1;
  const xref = pos;
  where.set(xrefNum, { type: 1, a: xref, b: 0 });
  const rows = Buffer.alloc((xrefNum + 1) * 7);
  for (let n = 0; n <= xrefNum; n++) {
    const w = where.get(n);
    const at = n * 7;
    if (!w) {
      rows[at] = 0;
      rows.writeUInt16BE(n === 0 ? 65535 : 0, at + 5);
      continue;
    }
    rows[at] = w.type;
    rows.writeUInt32BE(w.a, at + 1);
    rows.writeUInt16BE(w.b, at + 5);
  }
  put(`${xrefNum} 0 obj\n`);
  put(stream(`/Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode${opts.trailer ?? ''}`, deflateSync(rows)));
  put(`\nendobj\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const ON = stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '0 g 2 2 m 12 12 l 2 12 m 12 2 l S');
const OFF = stream('/Type /XObject /Subtype /Form /BBox [0 0 14 14]', '');
const widget = (rect: string) => `/Type /Annot /Subtype /Widget /F 4 /P 4 0 R /Rect [${rect}] /MK <</BC [0 0 0]>>`;

/**
 * An application form: a text field with a cryptic name (only the words printed next to it say
 * what it is), a multi-line address, a check box, a radio group, a combo box, a read-only field,
 * a signature field, a comb field inside a parent field (emp.badge), and a box whose label is
 * printed above it.
 */
export function formPdf(opts: { xrefStream?: boolean; noDr?: boolean; trailer?: string; twoEmails?: boolean } = {}): Buffer {
  const label = (x: number, y: number, s: string) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET`;
  const content = [label(50, 702, 'Full name:'), label(50, 645, 'Home address'), label(50, 562, 'I agree to the terms'), label(50, 522, 'Shift: Day'), label(160, 522, 'Night'), label(50, 482, 'State'), label(50, 442, 'Office'), label(50, 402, 'Signature'), label(50, 362, 'Badge'), label(120, 262, 'Mailing address (street, apt. or suite)'), ...(opts.twoEmails ? [label(50, 322, 'Email'), label(300, 322, 'Email')] : [])].join('\n');
  const fields = [10, 11, 12, 13, 16, 17, 18, 19, 23, ...(opts.twoEmails ? [21, 22] : [])];
  const annots = [10, 11, 12, 14, 15, 16, 17, 18, 20, 23, ...(opts.twoEmails ? [21, 22] : [])];
  const objs: Record<number, Body> = {
    1: '<</Type /Catalog /Pages 2 0 R /AcroForm 3 0 R>>',
    2: '<</Type /Pages /Kids [4 0 R] /Count 1>>',
    3: `<</Fields [${fields.map((n) => `${n} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g)${opts.noDr ? '' : ' /DR <</Font <</Helv 5 0 R>>>>'}>>`,
    4: `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources <</Font <</F1 5 0 R>>>> /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]>>`,
    5: '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
    6: stream('', content),
    10: `<<${widget('120 695 320 715')} /FT /Tx /T (f1_01) /DA (/Helv 0 Tf 0 g)>>`,
    11: `<<${widget('120 600 400 660')} /FT /Tx /T (Address) /TU (Home address) /Ff 4096 /DA (/Helv 10 Tf 0 g)>>`,
    12: `<<${widget('180 558 194 572')} /FT /Btn /T (Agree) /TU (I agree to the terms) /V /Off /AS /Off /AP <</N <</Yes 30 0 R /Off 31 0 R>>>>>>`,
    13: '<</FT /Btn /T (Shift) /Ff 49152 /V /Off /Kids [14 0 R 15 0 R]>>',
    14: `<<${widget('120 518 134 532')} /Parent 13 0 R /AS /Off /AP <</N <</Day 30 0 R /Off 31 0 R>>>>>>`,
    15: `<<${widget('200 518 214 532')} /Parent 13 0 R /AS /Off /AP <</N <</Night 30 0 R /Off 31 0 R>>>>>>`,
    16: `<<${widget('120 475 260 495')} /FT /Ch /T (State) /Ff 131072 /Opt [(TX) (OK) [(NM) (New Mexico)]] /DA (/Helv 0 Tf 0 g)>>`,
    17: `<<${widget('120 435 260 455')} /FT /Tx /T (Office) /Ff 1 /V (HQ) /DA (/Helv 0 Tf 0 g)>>`,
    18: `<<${widget('120 395 260 415')} /FT /Sig /T (Signature)>>`,
    19: '<</T (emp) /Kids [20 0 R]>>',
    20: `<<${widget('120 355 240 375')} /Parent 19 0 R /FT /Tx /T (badge) /TU (Badge number) /Ff 16777216 /MaxLen 6 /Q 1 /DA (/Helv 0 Tf 0 g)>>`,
    23: `<<${widget('120 236 400 256')} /FT /Tx /T (f9) /DA (/Helv 0 Tf 0 g)>>`,
    30: ON,
    31: OFF,
  };
  if (opts.twoEmails) {
    objs[21] = `<<${widget('90 315 250 335')} /FT /Tx /T (e1) /TU (Email) /DA (/Helv 0 Tf 0 g)>>`;
    objs[22] = `<<${widget('340 315 500 335')} /FT /Tx /T (e2) /TU (Email) /DA (/Helv 0 Tf 0 g)>>`;
  }
  return buildPdf(objs, { ...(opts.xrefStream ? { xrefStream: true } : {}), ...(opts.trailer ? { trailer: opts.trailer } : {}) });
}

/** A PDF with no form: just a page of text. */
export function flatPdf(trailer?: string): Buffer {
  return buildPdf({
    1: '<</Type /Catalog /Pages 2 0 R>>',
    2: '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    3: '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>',
    4: stream('', 'BT /F1 12 Tf 72 700 Td (Name: ______________) Tj ET'),
    5: '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  }, trailer ? { trailer } : {});
}

/** A form that is only XFA (LiveCycle): no AcroForm fields. */
export function xfaPdf(): Buffer {
  return buildPdf({
    1: '<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [] /XFA 6 0 R>>>>',
    2: '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    3: '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>',
    4: stream('', 'BT ET'),
    6: stream('', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'),
  });
}

/** A PDF marked as protected (a Standard security handler in its trailer). */
export const protectedPdf = (): Buffer => flatPdf(' /Encrypt <</Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4>> /ID [<01> <01>]');

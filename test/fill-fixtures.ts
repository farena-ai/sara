// fill_document fixtures: a blank weekly time sheet (Excel) and a Word form, made by hand as OOXML,
// plus a strict XML well-formedness check. Used by test/fill-document.test.ts and the real-reader check.
import assert from 'node:assert/strict';
import { zipStored } from '../src/zip-write.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const COLS = ['DAY', 'START TIME', 'END TIME', 'REGULAR HOURS', 'OVERTIME HOURS', 'VACATION HOURS', 'SICK HOURS', 'COMP HOURS', 'TOTAL HOURS', 'NOTES'];

/** A blank time sheet like the one people upload: labels, merged value cells, a day table with formulas. */
export function timeSheet(): Buffer {
  const strings: string[] = [];
  const si = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const str = (ref: string, s: string, style: number) => `<c r="${ref}" s="${style}" t="s"><v>${si(s)}</v></c>`;
  const L = 'ABCDEFGHIJ';
  const rows: string[] = [];
  rows.push(`<row r="1" spans="1:10">${str('A1', 'WEEK OF:', 1)}<c r="B1" s="2"/><c r="C1" s="2"/>${str('E1', 'EMPLOYEE NAME:', 1)}<c r="F1" s="2"/><c r="G1" s="2"/><c r="H1" s="2"/></row>`);
  // F2 has no cell element at all (an empty cell in a styled column).
  rows.push(`<row r="2" spans="1:10">${str('A2', 'TITLE:', 1)}<c r="B2" s="2"/>${str('E2', 'EMPLOYEE NUMBER:', 1)}</row>`);
  rows.push(`<row r="3">${str('A3', 'STATUS:', 1)}<c r="B3" s="2"/>${str('E3', 'DIVISION CORRECTIONS:', 1)}<c r="F3" s="2"/></row>`);
  rows.push(`<row r="4">${str('A4', 'SUPERVISOR:', 1)}<c r="B4" s="2"/></row>`);
  rows.push(`<row r="6">${COLS.map((h, i) => str(`${L[i]}6`, h, 3)).join('')}</row>`);
  DAYS.forEach((d, k) => {
    const r = 7 + k;
    const cells = [str(`A${r}`, d, 4), `<c r="B${r}" s="5"/>`, `<c r="C${r}" s="4"/>`, ...['D', 'E', 'F', 'G', 'H'].map((c) => `<c r="${c}${r}" s="4"/>`), `<c r="I${r}" s="4"><f>SUM(D${r}:H${r})</f><v>0</v></c>`, `<c r="J${r}" s="4"/>`];
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  });
  rows.push(`<row r="14">${str('A14', 'WEEKLY', 3)}${['D', 'E', 'F', 'G', 'H', 'I'].map((c) => `<c r="${c}14" s="3"><f>SUM(${c}7:${c}13)</f><v>0</v></c>`).join('')}</row>`);
  rows.push(`<row r="16">${str('A16', 'DATE:', 1)}${str('E16', 'DATE:', 1)}</row>`);
  rows.push(`<row r="18">${str('A18', 'EMPLOYEE SIGNATURE:', 1)}<c r="B18" s="2"/></row>`);
  const sheet = `${HEAD}<worksheet xmlns="${SS}" xmlns:r="${REL}"><dimension ref="A1:J18"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="22" customWidth="1"/><col min="6" max="6" width="14" style="2" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData><mergeCells count="2"><mergeCell ref="B1:C1"/><mergeCell ref="F1:H1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const sst = `${HEAD}<sst xmlns="${SS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  const styles = `${HEAD}<styleSheet xmlns="${SS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="20" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `${HEAD}<workbook xmlns="${SS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`;
  const files: [string, string][] = [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/sharedStrings.xml', sst],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })), { deflate: true });
}

/** The 23 values Kent asked for: 7 header fields and 16 day cells. */
export const KENT = {
  values: {
    'WEEK OF': '11/08/2026',
    'EMPLOYEE NAME:': 'Kent Shelton',
    TITLE: 'Officer',
    'EMPLOYEE NUMBER': 4521,
    STATUS: 'Full time',
    'DIVISION CORRECTIONS': 'North',
    'supervisor:': 'Sgt. Diaz',
  },
  tables: [
    {
      table: 'DAY',
      rows: [
        { DAY: 'SUNDAY', 'START TIME': '2200', 'END TIME': '0600', 'REGULAR HOURS': '8', NOTES: 'night' },
        { DAY: 'MONDAY', 'START TIME': '22:00', 'END TIME': '0600', 'REGULAR HOURS': 8, NOTES: 'night' },
        { DAY: 'Tuesday', 'START TIME': '10:00 PM', 'END TIME': '0600', 'REGULAR HOURS': '8', 'OVERTIME HOURS': '1.5' },
        { DAY: 'WEDNESDAY', 'START TIME': '2200', 'END TIME': '0600', 'REGULAR HOURS': '8', NOTES: 'training' },
      ],
    },
  ],
};

/** Strict well-formedness: every tag closes in order, attributes are quoted, no bare & or <. */
export function strictXml(src: string): void {
  const body = src.replace(/^\uFEFF?<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g;
  let at = 0;
  let m: RegExpExecArray | null;
  const textOk = (t: string) => assert.ok(!/<|&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t), `bad text: ${t.slice(0, 80)}`);
  while ((m = re.exec(body))) {
    textOk(body.slice(at, m.index));
    at = m.index + m[0].length;
    if (!m[2]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `closing ${m[2]}`);
    else if (!m[4]) stack.push(m[2]);
    const names = [...m[3].matchAll(/([\w.:-]+)\s*=/g)].map((x) => x[1]);
    assert.equal(new Set(names).size, names.length, `duplicate attribute in <${m[2]}>`);
  }
  textOk(body.slice(at));
  assert.deepEqual(stack, [], 'every element closes');
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const tc = (body: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${body}</w:tc>`;
const para = (txt: string, rPr = '') => `<w:p>${txt ? `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${txt}</w:t></w:r>` : ''}</w:p>`;

export function wordForm(): Buffer {
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Time off request</w:t></w:r></w:p>`,
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Employee Name: </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>______________</w:t></w:r></w:p>`,
    `<w:p><w:r><w:rPr><w:b/><w:color w:val="1F3864"/></w:rPr><w:t>Date:</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">Badge: [badge number]   Shift: </w:t></w:r><w:r><w:t>________</w:t></w:r></w:p>`,
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>`,
    `<w:tr>${tc(para('Title:', '<w:b/>'))}${tc(`<w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr></w:p>`)}</w:tr>`,
    `<w:tr>${tc(para('Supervisor', '<w:b/>'))}${tc(para(''))}</w:tr>`,
    `</w:tbl>`,
    `<w:p/>`,
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>`,
    `<w:tr>${['DAY', 'START', 'END'].map((h) => tc(para(h, '<w:b/>'))).join('')}</w:tr>`,
    ...['MONDAY', 'TUESDAY'].map((d) => `<w:tr>${tc(para(d))}${tc(para(''))}${tc(para(''))}</w:tr>`),
    `</w:tbl>`,
    `<w:sdt><w:sdtPr><w:alias w:val="Department"/><w:tag w:val="dept"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:p><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click or tap here to enter text.</w:t></w:r></w:p></w:sdtContent></w:sdt>`,
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`,
  ].join('');
  const doc = `${HEAD}<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${body}</w:body></w:document>`;
  const files: [string, string][] = [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', doc],
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })), { deflate: true });
}


// make_document → Excel (.xlsx). SpreadsheetML by hand (no dependency): one worksheet per sheet,
// numbers as numbers, text as inline strings, \"=…\" as formulas (checked: only the workbook's own
// cells and functions; Excel and LibreOffice work out the values when the file opens), a bold
// shaded header row that stays in view, and column widths fitted to the text. Never .xlsm.
import { zipStored } from '../zip-write.ts';
import { appXml, coreXml, xml } from './docx.ts';
import { type DocSpec, type Sheet, sheetsOf } from './spec.ts';
import { THEMES } from './theme.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function sheetXml(sheet: Sheet): string {
  const cols = Math.max(1, ...sheet.rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(8, ...sheet.rows.slice(0, 500).map((r) => {
    const v = r[c];
    return v === null || v === undefined ? 0 : String(v).length * (typeof v === 'number' ? 1.1 : 1) + 2;
  }))));
  const head = sheet.rows.length > 1;
  const rows = sheet.rows.map((r, i) => {
    const cells = r.map((v, c) => {
      const ref = `${colName(c)}${i + 1}`;
      const s = i === 0 && head ? ' s="1"' : '';
      if (v === null || v === undefined || v === '') return s ? `<c r="${ref}"${s}/>` : '';
      if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
      if (v.startsWith('=') && v.length > 1) return `<c r="${ref}"${s}><f>${xml(v.slice(1))}</f></c>`;
      return `<c r="${ref}"${s || (v.includes('\n') ? ' s="2"' : '')} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    });
    return `<row r="${i + 1}">${cells.join('')}</row>`;
  });
  const last = `${colName(cols - 1)}${Math.max(1, sheet.rows.length)}`;
  const pane = head ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return `${HEAD}<worksheet xmlns="${SS}" xmlns:r="${REL}"><dimension ref="A1:${last}"/>${pane}<sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData>${head ? `<autoFilter ref="A1:${last}"/>` : ''}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

export function makeXlsx(spec: DocSpec): Buffer {
  const sheets = sheetsOf(spec);
  const th = THEMES[spec.template];
  const styles = `${HEAD}<styleSheet xmlns="${SS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${th.head}"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFB6C2D1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbook = `${HEAD}<workbook xmlns="${SS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const wbRels = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const types = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const files: [string, string][] = [
    ['[Content_Types].xml', types],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', coreXml(spec.title)],
    ['docProps/app.xml', appXml()],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', styles],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })), { deflate: true });
}

/** A CSV of the first sheet (or table). Cells that a spreadsheet would run as a formula get a leading ' unless they are numbers. */
export function makeCsv(spec: DocSpec): Buffer {
  const sheet = sheetsOf(spec)[0];
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(`\ufeff${sheet.rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

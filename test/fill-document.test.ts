// fill_document (docs/DOCUMENTS.md): she writes into the person's own form (a copy of it), keeps its
// layout and formatting, and checks the copy with the Library's own reader before saying it's done.
// Fixtures are hand-made OOXML resembling a blank weekly time sheet and a Word form.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { madeDocs } from '../src/documents/make.ts';
import { fillDocx, fillFile, fillItems, fillXlsx } from '../src/documents/fill.ts';
import { cleanSpec, DocError, sheetsOf } from '../src/documents/spec.ts';
import { makeXlsx } from '../src/documents/xlsx.ts';
import { readXlsxCells } from '../src/library/ooxml.ts';
import { readDocument } from '../src/library/read.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { DEFAULT_LEAN, familyOf, leanFor } from '../src/lean.ts';
import { createFillDocumentTool } from '../src/tools/fill-document.ts';
import { createMakeDocumentTool } from '../src/tools/make-document.ts';
import { KENT, strictXml, timeSheet, wordForm } from './fill-fixtures.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const cellsOf = (buf: Buffer) => readXlsxCells(new Zip(buf)).get('Sheet1')!;
const sheetXml = (buf: Buffer) => new Zip(buf).text('xl/worksheets/sheet1.xml')!;
const cellXml = (buf: Buffer, ref: string) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>.*?</c>)`).exec(sheetXml(buf))?.[0] ?? '';

test('fill_document xlsx: labels, merged cells, missing cells and the day table, checked by reading back', () => {
  const original = timeSheet();
  const before = Buffer.from(original);
  const res = fillXlsx(original, fillItems(KENT));
  assert.equal(res.total, 23);
  assert.equal(res.filled, 23, JSON.stringify(res.fields.filter((f) => f.status !== 'filled')));
  assert.ok(original.equals(before), 'the original is never changed');
  const cells = cellsOf(res.data);
  assert.equal(cells.get('B1'), '11/08/2026', 'WEEK OF goes in the merged cell to its right');
  assert.equal(cells.get('F1'), 'Kent Shelton', 'a label with its colon, merged value cells');
  assert.equal(cells.get('B2'), 'Officer');
  assert.equal(cells.get('F2'), '4521', 'a cell that had no element at all');
  assert.equal(cells.get('F3'), 'North');
  assert.equal(cells.get('B4'), 'Sgt. Diaz', 'labels match in any case');
  // The day table: matched by header and row label. START TIME cells are formatted as time.
  assert.equal(cells.get('B7'), '22:00:00', '2200 in a time cell is a time');
  assert.equal(cells.get('B8'), '22:00:00');
  assert.equal(cells.get('B9'), '22:00:00', '10:00 PM');
  assert.equal(cells.get('C7'), '0600', 'a time in a General cell stays text (its leading zero kept)');
  assert.equal(cells.get('D7'), '8');
  assert.equal(cells.get('E9'), '1.5');
  assert.equal(cells.get('J7'), 'night');
  // Numbers are numbers, text is text, times are time serials.
  assert.match(cellXml(res.data, 'D7'), /<v>8<\/v>/);
  assert.doesNotMatch(cellXml(res.data, 'D7'), /t="/);
  assert.match(cellXml(res.data, 'C7'), /t="inlineStr"/);
  assert.match(cellXml(res.data, 'B7'), /<v>0\.91666/);
  // Formatting kept: every cell keeps its style; a new cell takes its column's style.
  assert.match(cellXml(res.data, 'B1'), /s="2"/);
  assert.match(cellXml(res.data, 'B7'), /s="5"/);
  assert.match(cellXml(res.data, 'D7'), /s="4"/);
  assert.match(cellXml(res.data, 'F2'), /s="2"/);
  assert.match(cellXml(res.data, 'A1'), /s="1" t="s"/);
  assert.match(sheetXml(res.data), /<mergeCell ref="F1:H1"\/>/);
  // Formulas stay and are worked out again when the file opens.
  assert.match(cellXml(res.data, 'I7'), /<f>SUM\(D7:H7\)<\/f>/);
  assert.match(cellXml(res.data, 'D14'), /<f>SUM\(D7:D13\)<\/f>/);
  assert.match(new Zip(res.data).text('xl/workbook.xml')!, /<calcPr[^>]*fullCalcOnLoad="1"/);
  for (const e of new Zip(res.data).entries.keys()) if (e.endsWith('.xml') || e.endsWith('.rels')) strictXml(new Zip(res.data).text(e)!);
});

test('fill_document xlsx: reports what it could not fill (not found, ambiguous, formulas) and cell addresses', () => {
  const res = fillXlsx(timeSheet(), fillItems({ values: [{ label: 'FAVORITE COLOR', value: 'blue' }, { label: 'DATE', value: '11/14/2026' }, { cell: 'J9', value: 'court' }, { cell: 'Sheet1!J10', value: 'off' }], tables: [{ table: 'DAY', rows: [{ DAY: 'SUNDAY', 'TOTAL HOURS': 8 }, { DAY: 'FUNDAY', NOTES: 'x' }, { DAY: 'MONDAY', 'LUNCH': '30' }] }] }));
  const by = (f: string) => res.fields.find((x) => x.field === f);
  assert.equal(by('FAVORITE COLOR')?.status, 'not_found');
  assert.equal(by('DATE')?.status, 'ambiguous');
  assert.match(by('DATE')!.detail!, /A16.*E16/);
  assert.equal(by('J9')?.status, 'filled');
  assert.equal(by('Sheet1!J10')?.status, 'filled');
  assert.equal(by('DAY SUNDAY / TOTAL HOURS')?.status, 'formula', 'a formula cell is never overwritten');
  assert.equal(by('DAY FUNDAY / NOTES')?.status, 'not_found');
  assert.equal(by('DAY MONDAY / LUNCH')?.status, 'not_found');
  assert.equal(res.filled, 2);
  assert.equal(res.total, 7);
  const cells = cellsOf(res.data);
  assert.equal(cells.get('J9'), 'court');
  assert.equal(cells.get('J10'), 'off');
  assert.throws(() => fillItems({}), DocError);
  assert.throws(() => fillItems({ values: [{ cell: 'ZZZZ1', value: 1 }] }), DocError);
});

test('fill_document xlsx: a file made by make_document can be filled too', () => {
  const made = makeXlsx(cleanSpec({ format: 'xlsx', title: 'Budget', sheets: [{ name: 'Budget', rows: [['Item', 'Cost'], ['Rent', null], ['Food', null], ['Total', '=SUM(B2:B3)']] }] }));
  const res = fillFile('Budget.xlsx', made, fillItems({ tables: [{ table: 'Item', rows: [{ Item: 'Rent', Cost: '1,200' }, { Item: 'Food', Cost: 300.5 }] }] }));
  assert.equal(res.filled, 2);
  const cells = readXlsxCells(new Zip(res.data)).get('Budget')!;
  assert.equal(cells.get('B2'), '1200');
  assert.equal(cells.get('B3'), '300.5');
});

// ---------------------------------------------------------------- Word

test('fill_document docx: text after labels, table cells, table rows and content controls keep their formatting', async () => {
  const original = wordForm();
  const before = Buffer.from(original);
  const res = fillDocx(original, fillItems({ values: { 'Employee Name': 'Kent Shelton', Date: '11/12/2026', Badge: '4521', Shift: 'Nights', Title: 'Officer', Supervisor: 'Sgt. Diaz', Department: 'Corrections', Nickname: 'K' }, tables: [{ table: 'DAY', rows: [{ DAY: 'MONDAY', START: '2200', END: '0600' }, { DAY: 'TUESDAY', START: '2200' }] }] }));
  assert.ok(original.equals(before), 'the original is never changed');
  assert.equal(res.total, 11);
  assert.equal(res.filled, 10, JSON.stringify(res.fields.filter((f) => f.status !== 'filled')));
  assert.equal(res.fields.find((f) => f.field === 'Nickname')?.status, 'not_found');
  const xml = new Zip(res.data).text('word/document.xml')!;
  strictXml(xml);
  assert.match(xml, /<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Kent Shelton<\/w:t>/, 'the blank line\'s run keeps its underline');
  assert.doesNotMatch(xml, /______________/);
  assert.match(xml, /<w:t>Date:<\/w:t><\/w:r><w:r><w:rPr><w:color w:val="1F3864"\/><\/w:rPr><w:t xml:space="preserve"> 11\/12\/2026<\/w:t>/, 'a value after a bare label copies its look, not its bold');
  assert.match(xml, /Badge: 4521   Shift: /, 'a [placeholder] after a label is replaced');
  assert.match(xml, /<w:pPr><w:rPr><w:i\/><\/w:rPr><\/w:pPr><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">Officer<\/w:t>/, 'an empty cell takes its paragraph mark\'s look');
  assert.doesNotMatch(xml, /showingPlcHdr/);
  assert.doesNotMatch(xml, /Click or tap here/);
  assert.match(xml, /<w:alias w:val="Department"\/>/);
  const read = (await readDocument('x.docx', res.data)).parts.map((p) => p.text).join('\n');
  assert.match(read, /Employee Name: Kent Shelton/);
  assert.match(read, /Title: \| Officer/);
  assert.match(read, /Supervisor \| Sgt\. Diaz/);
  assert.match(read, /MONDAY \| 2200 \| 0600/);
  assert.match(read, /TUESDAY \| 2200/);
  assert.match(read, /Corrections/);
});

// ---------------------------------------------------------------- make_document's spreadsheets

test('make_document xlsx: label lines become label | value cells, and over-wide table rows are refused', async () => {
  const md = `# Time sheet\n\n**WEEK OF:** 11/08/2026\n**EMPLOYEE NAME:** Kent\n\n| DAY | START | END |\n|---|---|---|\n| SUNDAY | 2200 | 0600 |\n\n**SUPERVISOR:** Sgt. Diaz\n`;
  const sheets = sheetsOf(cleanSpec({ format: 'xlsx', title: 'Time sheet', content: md }));
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].rows, [['WEEK OF:', '11/08/2026'], ['EMPLOYEE NAME:', 'Kent'], [], ['DAY', 'START', 'END'], ['SUNDAY', 2200, 600], [], ['SUPERVISOR:', 'Sgt. Diaz']]);
  assert.equal(sheets[0].head, 3, 'the table header row is the styled one');
  const buf = makeXlsx(cleanSpec({ format: 'xlsx', title: 'Time sheet', content: md }));
  const cells = readXlsxCells(new Zip(buf)).get('Time sheet')!;
  assert.equal(cells.get('B2'), 'Kent');
  assert.equal(cells.get('A4'), 'DAY');
  assert.match(new Zip(buf).text('xl/worksheets/sheet1.xml')!, /<c r="A4" s="1"/);
  assert.match(new Zip(buf).text('xl/worksheets/sheet1.xml')!, /<autoFilter ref="A4:C5"\/>/);
  assert.throws(() => cleanSpec({ format: 'xlsx', title: 'x', content: '| A | B |\n|---|---|\n| 1 | 2 | 3 |\n' }), (e: Error) => e instanceof DocError && /row 1 of a table.* has 3 cells but its header has 2 columns/i.test(e.message));
  // Fewer cells is fine (the rest stay empty).
  assert.doesNotThrow(() => cleanSpec({ format: 'xlsx', title: 'x', content: '| A | B |\n|---|---|\n| 1 |\n' }));
});

// ---------------------------------------------------------------- the tool

test('fill_document tool: fills a copy of the uploaded form, shows the card, and says how many fields it filled', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const now = new Date('2026-11-12T12:00:00Z');
  const app = makeApp(dir, { now });
  app.library = new LibraryStore(app.store.db, dir, () => now);
  app.tools.add(createMakeDocumentTool(() => app));
  app.tools.add(createFillDocumentTool(() => app));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Kent', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-10T12:00:00.000Z' } as never);
  const conv = app.store.createConversation({ title: 'forms' });
  const blank = timeSheet();
  const up = app.library.add({ name: 'Time Sheet Blank (1).xlsx', bytes: blank, keep: false, conversationId: conv.id, origin: 'chat', learn: false });
  const turn = async (args: Record<string, unknown>) => {
    const evs: ChatEvent[] = [];
    app.script.push([call(`f${Math.random()}`, 'fill_document', args)], text('Done.'));
    for await (const ev of runTurn(app, conv.id, 'fill in my time sheet')) evs.push(ev);
    return evs;
  };
  const out = (evs: ChatEvent[]) => evs.find((e) => e.type === 'tool_result') as { output: string; status: string };
  const evs = await turn({ document: 'time sheet', title: 'Time Sheet Kent', ...KENT });
  assert.equal(out(evs).status, 'ok', out(evs).output);
  assert.match(out(evs).output, /Filled 23 of 23 fields/);
  const file = evs.find((e) => e.type === 'file') as { name: string; made: { id: number; format: string } } | undefined;
  assert.ok(file, 'the chat card');
  assert.equal(file.made.format, 'xlsx');
  assert.equal(file.name, 'Time Sheet Kent.xlsx');
  const m = madeDocs(app).get(file.made.id)!;
  const copy = app.library.file(app.library.get(m.libraryId!)!)!;
  assert.equal(readXlsxCells(new Zip(copy)).get('Sheet1')!.get('F1'), 'Kent Shelton');
  assert.ok(app.library.file(app.library.get(up.id)!)!.equals(blank), 'the uploaded original is unchanged');
  // The system prompt tells her to use it for forms, and never to claim a form is filled without it.
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /fill_document/);
  assert.match(sys, /never say a form is filled unless fill_document reported every field filled/i);
  // Partly filled: the output lists what's missing and the labels it saw.
  const part = out(await turn({ document: String(up.id), values: { 'EMPLOYEE NAME': 'Kent', 'SHOE SIZE': '11' } }));
  assert.match(part.output, /Filled 1 of 2 fields/);
  assert.match(part.output, /SHOE SIZE: no label like that/);
  assert.match(part.output, /Labels in this form: .*WEEK OF/);
  assert.match(part.output, /Don't say the form is filled/);
  // make_document on a filled copy points back at fill_document (rebuilding it would lose the layout).
  const again = out(await (async () => {
    const e: ChatEvent[] = [];
    app.script.push([call('mk', 'make_document', { basedOn: m.id, content: '# x' })], text('ok'));
    for await (const ev of runTurn(app, conv.id, 'change it')) e.push(ev);
    return e;
  })());
  assert.match(again.output, /fill_document/);
  assert.match(out(await turn({ document: 'nothing like this', values: { A: 'b' } })).output, /No document matching/);
});

test('fill_document: in the documents family, found by the lean picker for forms in six languages', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-12T12:00:00Z') });
  const tool = createFillDocumentTool(() => app);
  assert.equal(familyOf(tool).id, 'documents');
  const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const, localCore: true };
  for (const msg of ['fill in my time sheet', 'rellena este formulario', 'remplis ce formulaire', 'füll das Formular aus', 'preencha o formulário', 'compila il modulo']) {
    const tt = leanFor(lean, [tool], { text: msg, mode: 'chat', local: true, turnId: 1, ownerTurnIds: [1] });
    assert.ok(tt.offeredNames([tool]).includes('fill_document'), msg);
  }
});

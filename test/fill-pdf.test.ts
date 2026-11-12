// fill_document for PDF forms (docs/DOCUMENTS.md): the person's fillable PDF gets their values in a
// copy that is the original bytes plus an incremental update; every value is checked by reading
// the copy back. Fixtures are hand-written PDFs (test/pdf-form-fixtures.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { fillFile, fillItems, fillReport } from '../src/documents/fill.ts';
import { madeDocs } from '../src/documents/make.ts';
import { fillPdf, formFieldsText, pdfTextBytes, readPdfForm } from '../src/documents/pdf-form.ts';
import { DocError } from '../src/documents/spec.ts';
import { readDocument } from '../src/library/read.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createFillDocumentTool } from '../src/tools/fill-document.ts';
import { createMakeDocumentTool } from '../src/tools/make-document.ts';
import { flatPdf, formPdf, protectedPdf, xfaPdf } from './pdf-form-fixtures.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const VALUES = { values: { 'Full name': 'Kent Shelton', 'Home address': '12 Oak St\nAustin, TX 78701', 'I agree to the terms': 'yes', Shift: 'Night', State: 'new mexico', 'Badge number': '4521', 'Mailing address': 'PO Box 9' } };
const valueOf = (data: Buffer, name: string) => readPdfForm(data).fields.find((f) => f.name === name);

for (const xrefStream of [false, true]) {
  test(`fill_document pdf (${xrefStream ? 'xref stream + object stream' : 'classic xref table'}): every kind of field, an incremental update, read back`, () => {
    const original = formPdf({ xrefStream });
    const before = Buffer.from(original);
    const res = fillPdf(original, fillItems(VALUES));
    assert.equal(res.format, 'pdf');
    assert.equal(res.filled, 7, JSON.stringify(res.fields.filter((f) => f.status !== 'filled')));
    assert.equal(res.total, 7);
    assert.ok(original.equals(before), 'the original is never changed');
    assert.ok(res.data.subarray(0, original.length).equals(original), 'the original bytes are kept as they are, the update follows');
    const update = res.data.subarray(original.length).toString('latin1');
    if (xrefStream) {
      assert.match(update, /\/Type \/XRef/, 'an xref stream file gets an xref stream');
      assert.doesNotMatch(update, /\nxref\n/);
    } else {
      assert.match(update, /\nxref\n/, 'a classic file gets a classic table');
      assert.match(update, /trailer\n<<\/Size \d+ \/Root 1 0 R \/Prev \d+>>/);
    }
    const prev = Number(/\/Prev (\d+)/.exec(update)![1]);
    assert.equal(prev, Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(original.toString('latin1'))![1]), '/Prev points at the original section');
    assert.match(update, /\/NeedAppearances true/);
    assert.match(update, /startxref\n\d+\n%%EOF\n$/);
    // Read back with the same reader.
    assert.equal(valueOf(res.data, 'f1_01')?.value, 'Kent Shelton', 'found by the words printed next to the box');
    assert.equal(valueOf(res.data, 'Address')?.value, '12 Oak St\nAustin, TX 78701', 'multi-line keeps its lines');
    assert.equal(valueOf(res.data, 'Agree')?.value, 'Yes', 'yes -> the on state');
    assert.equal(valueOf(res.data, 'Shift')?.value, 'Night', 'the radio kid whose state matches');
    assert.equal(valueOf(res.data, 'State')?.value, 'NM', 'a choice stores its export value');
    assert.equal(valueOf(res.data, 'emp.badge')?.value, '4521', 'kids: full names joined with dots');
    assert.equal(valueOf(res.data, 'f9')?.value, 'PO Box 9', 'found by the label printed above the box (its start)');
    assert.equal(valueOf(res.data, 'Office')?.value, 'HQ', 'other fields keep their values');
    const shift = valueOf(res.data, 'Shift')!;
    const form = readPdfForm(res.data);
    assert.deepEqual(shift.widgets.map((w) => form.doc.name(w.dict.get('AS'))), ['Off', 'Night'], 'each radio widget shows its own state');
    // Appearance streams: the text in the field's font.
    const tx = form.fields.find((f) => f.name === 'f1_01')!;
    const ap = form.doc.get(form.doc.dict(tx.widgets[0].dict.get('AP'))!.get('N')) as unknown as { raw: Buffer };
    assert.match(ap.raw.toString('latin1'), /\/Helv [\d.]+ Tf[\s\S]*\(Kent Shelton\) Tj/);
    const report = fillReport(res);
    assert.match(report, /^Filled 7 of 7 fields/);
    // The Library's reader shows the form's fields and values.
    const summary = formFieldsText(res.data);
    assert.match(summary, /^Form fields/);
    assert.match(summary, /- f1_01 \("Full name:"\) = Kent Shelton/, 'a cryptic name shows the words printed next to it');
    assert.match(summary, /- f9 \("Mailing address \(street, apt\. or suite\)"\) = PO Box 9/);
    assert.match(summary, /- Shift \[choose: Day \/ Night\] = Night/);
    assert.match(summary, /- Office \[read-only\] = HQ/);
  });
}

test('fill_document pdf: skipped, invalid, ambiguous and not-found fields are reported, never claimed', () => {
  const res = fillPdf(formPdf({ twoEmails: true }), fillItems({ values: { Office: 'Dallas', Signature: 'Kent', Email: 'k@example.com', State: 'Ohio', Shift: 'Evening', 'Favorite color': 'blue', 'Badge number': '12345678', 'I agree to the terms': 'maybe', 'Full name': 'Kent' } }));
  const by = (k: string) => res.fields.find((f) => f.field === k)!;
  assert.equal(by('Office').status, 'skipped');
  assert.match(by('Office').detail!, /read-only/);
  assert.equal(by('Signature').status, 'skipped');
  assert.match(by('Signature').detail!, /signature/);
  assert.equal(by('Email').status, 'ambiguous');
  assert.match(by('Email').detail!, /e1, e2/);
  assert.equal(by('State').status, 'invalid');
  assert.match(by('State').detail!, /TX, OK, New Mexico/);
  assert.equal(by('Shift').status, 'invalid');
  assert.equal(by('Favorite color').status, 'not_found');
  assert.equal(by('Badge number').status, 'no_space');
  assert.match(by('Badge number').detail!, /6 characters/);
  assert.equal(by('I agree to the terms').status, 'invalid');
  assert.equal(res.filled, 1);
  const report = fillReport(res);
  assert.match(report, /^Filled 1 of 9 fields/);
  assert.match(report, /- Favorite color: no field like that in the form/);
  assert.match(report, /Fields in this form: Full name:, Home address, I agree to the terms, /, 'fields by the words people see');
  assert.equal(valueOf(res.data, 'Office')?.value, 'HQ', 'a read-only field is left alone');
  // Spreadsheet-style entries don't apply to a PDF.
  const cells = fillPdf(formPdf(), fillItems({ values: [{ cell: 'B3', value: 1 }, { label: 'f1_01', value: 'Kent' }] }));
  assert.equal(cells.fields[0].status, 'not_found');
  assert.equal(cells.fields[1].status, 'filled', 'the full field name works too');
});

test('fill_document pdf: names with any case or punctuation, check boxes off, non-Latin text as UTF-16', () => {
  const res = fillPdf(formPdf(), fillItems({ values: { 'EMP.BADGE': '77', agree: false, 'full name:': 'Łukasz 漢字', SHIFT: 'day' } }));
  assert.equal(res.filled, 4, JSON.stringify(res.fields));
  assert.equal(valueOf(res.data, 'emp.badge')?.value, '77');
  assert.equal(valueOf(res.data, 'Agree')?.value, 'Off');
  assert.equal(valueOf(res.data, 'f1_01')?.value, 'Łukasz 漢字');
  assert.equal(valueOf(res.data, 'Shift')?.value, 'Day');
  assert.ok(res.data.toString('latin1').includes(`<${pdfTextBytes('Łukasz 漢字').toString('hex')}>`), 'UTF-16BE with a byte-order mark');
  assert.ok(pdfTextBytes('Łukasz').subarray(0, 2).equals(Buffer.from([0xfe, 0xff])));
  assert.equal(pdfTextBytes('José').toString('latin1'), 'José');
});

test('fill_document pdf: a form without a font in /DR gets Helvetica added', () => {
  const res = fillPdf(formPdf({ noDr: true }), fillItems({ values: { 'Full name': 'Kent' } }));
  assert.equal(res.filled, 1);
  const form = readPdfForm(res.data);
  const font = form.doc.dict(form.doc.dict(form.doc.dict(form.acro!.get('DR'))!.get('Font'))!.get('Helv'));
  assert.equal(form.doc.name(font?.get('BaseFont')), 'Helvetica');
});

test('fill_document pdf: protected, XFA-only and flat PDFs are refused plainly; nothing to fill makes no copy', () => {
  assert.throws(() => fillPdf(protectedPdf(), fillItems(VALUES)), (e: Error) => e instanceof DocError && /This PDF is protected; ask for an unprotected copy/.test(e.message));
  assert.throws(() => fillPdf(xfaPdf(), fillItems(VALUES)), (e: Error) => e instanceof DocError && /XFA/.test(e.message));
  assert.throws(() => fillPdf(flatPdf(), fillItems(VALUES)), (e: Error) => e instanceof DocError && /This PDF has no fillable fields/.test(e.message) && /make_document/.test(e.message));
  const none = fillFile('form.pdf', formPdf(), fillItems({ values: { Nope: 'x' } }));
  assert.equal(none.filled, 0);
  assert.equal(formFieldsText(flatPdf()), '');
});

test('library: reading a fillable PDF shows its form fields', async () => {
  const read = await readDocument('form.pdf', formPdf());
  const part = read.parts.find((p) => p.where === 'form fields');
  assert.ok(part, JSON.stringify(read.parts.map((p) => p.where)));
  assert.match(part.text, /- emp\.badge \("Badge number"\) = /);
  assert.match(part.text, /- State \[choose: TX \/ OK \/ New Mexico\] = /);
  assert.ok(read.parts.some((p) => /Full name:/.test(p.text)), 'the page text is still there');
  const flat = await readDocument('flat.pdf', flatPdf());
  assert.ok(!flat.parts.some((p) => p.where === 'form fields'));
});

test('fill_document tool: fills an uploaded PDF form into a new PDF and reports it', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const now = new Date('2026-11-12T12:00:00Z');
  const app = makeApp(dir, { now });
  app.library = new LibraryStore(app.store.db, dir, () => now);
  app.tools.add(createMakeDocumentTool(() => app));
  app.tools.add(createFillDocumentTool(() => app));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Kent', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-10T12:00:00.000Z' } as never);
  const conv = app.store.createConversation({ title: 'forms' });
  const blank = formPdf();
  const up = app.library.add({ name: 'Application.pdf', bytes: blank, keep: false, conversationId: conv.id, origin: 'chat', learn: false });
  const flat = flatPdf();
  app.library.add({ name: 'Letter.pdf', bytes: flat, keep: false, conversationId: conv.id, origin: 'chat', learn: false });
  const turn = async (args: Record<string, unknown>) => {
    const evs: ChatEvent[] = [];
    app.script.push([call(`f${Math.random()}`, 'fill_document', args)], text('Done.'));
    for await (const ev of runTurn(app, conv.id, 'fill in my form')) evs.push(ev);
    return evs.find((e) => e.type === 'tool_result') as { output: string; status: string } & ChatEvent;
  };
  const evs: ChatEvent[] = [];
  app.script.push([call('f1', 'fill_document', { document: 'Application', title: 'Application - Kent', ...VALUES })], text('Done.'));
  for await (const ev of runTurn(app, conv.id, 'fill in my application')) evs.push(ev);
  const out = evs.find((e) => e.type === 'tool_result') as { output: string; status: string };
  assert.equal(out.status, 'ok', out.output);
  assert.match(out.output, /Filled 7 of 7 fields/);
  const file = evs.find((e) => e.type === 'file') as { name: string; made: { id: number; format: string } } | undefined;
  assert.ok(file);
  assert.equal(file.made.format, 'pdf');
  assert.equal(file.name, 'Application - Kent.pdf');
  const m = madeDocs(app).get(file.made.id)!;
  const copy = app.library.file(app.library.get(m.libraryId!)!)!;
  assert.ok(copy.subarray(0, blank.length).equals(blank));
  assert.equal(valueOf(copy, 'f1_01')?.value, 'Kent Shelton');
  assert.ok(app.library.file(app.library.get(up.id)!)!.equals(blank), 'the uploaded original is unchanged');
  const flatOut = await turn({ document: 'Letter.pdf', values: { Name: 'Kent' } });
  assert.equal(flatOut.status, 'error');
  assert.match(flatOut.output, /This PDF has no fillable fields/);
});

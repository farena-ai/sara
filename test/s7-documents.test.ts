// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): templates with placeholders, drafting
// from templates and past documents, tracked changes in Word, a clause checklist and a
// signature-ready PDF. Fixtures are hand-made OOXML (runs split the way Word splits them) and
// documents made by Sara's own writers; every revised file is read back with the Library's reader.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { runTurn } from '../src/chat.ts';
import { clauseChecklist, guessDocType } from '../src/documents/clauses.ts';
import { madeDocs, makeDocument } from '../src/documents/make.ts';
import { detectPlaceholders, fillDocxPlaceholders, fillText } from '../src/documents/placeholders.ts';
import { docxToMarkdown, makeSignPdf } from '../src/documents/sign.ts';
import { docTemplates, pastClauses } from '../src/documents/templates.ts';
import { listRevisions, resolveAll, reviseDocx } from '../src/documents/tracked.ts';
import { readDocx } from '../src/library/ooxml.ts';
import { readPdfForm } from '../src/documents/pdf-form.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { familyOf } from '../src/lean.ts';
import { createDocStudioTools } from '../src/tools/doc-studio.ts';
import { zipStored } from '../src/zip-write.ts';
import { strictXml } from './fill-fixtures.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** A Word file from paragraph XML (no styles part, like many real templates). */
function docx(body: string): Buffer {
  const doc = `${HEAD}<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  const files: [string, string][] = [
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', doc],
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })), { deflate: true });
}
const p = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
const r = (t: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const h1 = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${r(t)}</w:p>`;

/** A consulting agreement template: placeholders split across runs, as Word saves them. */
function agreementTemplate(): Buffer {
  return docx(
    [
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${r('Consulting Agreement')}</w:p>`,
      p(r('This Agreement is made between '), r('{{', '<w:b/>'), r('Client', '<w:b/>'), r('}}', '<w:b/>'), r(' and Northwind Studio LLC, effective '), r('[EFFECTIVE DATE]'), r('.')),
      h1('1. Payment'),
      p(r('Client shall pay '), r('{{Fee}}'), r(' within 30 days of each invoice.')),
      h1('2. Termination'),
      p(r('Either party may terminate this Agreement on 15 days written notice.')),
      h1('3. Governing law'),
      p(r('This Agreement is governed by the laws of the State of '), r('[STATE]'), r('.')),
      p(r('Project contact: '), r('____________')),
      p(r('Signature: ________________')),
      p(r('See [1] and [page 3] and [a link](https://example.com).')),
    ].join(''),
  );
}

const docXml = (buf: Buffer) => new Zip(buf).text('word/document.xml')!;
const readText = (buf: Buffer) => readDocx(new Zip(buf)).parts.map((x) => x.text).join('\n');

test('S7 placeholders: braces, brackets, angle quotes and labelled blanks; links and numbers are not', () => {
  const found = detectPlaceholders('Dear {{ Client Name }},\nYour fee is [FEE AMOUNT] ([insert date]). <<Project>> «Owner»\nDate: ________\nSignature: __________\nSee [1], [page 3], [click here](https://x.test), [Note].');
  const keys = found.map((f) => `${f.kind}:${f.label}`);
  assert.deepEqual(keys, ['braces:Client Name', 'brackets:FEE AMOUNT', 'brackets:insert date', 'angle:Project', 'angle:Owner', 'blank:Date', 'signature:Signature']);
  assert.equal(found[0].raw[0], '{{ Client Name }}');
  // The same placeholder twice counts once, with its count.
  const twice = detectPlaceholders('{{Client}} pays. {{ client }} signs.');
  assert.equal(twice.length, 1);
  assert.equal(twice[0].count, 2);
  // Filling plain text by label, in any case or spacing.
  assert.equal(fillText('Dear {{Client}}, by [DUE DATE]. Date: _____', { client: 'Acme', 'due date': 'May 1', Date: '4/2' }).text, 'Dear Acme, by May 1. Date: 4/2');
});

test('S7 placeholders: a Word template is filled in place across split runs; formatting kept; the original unchanged', () => {
  const tpl = agreementTemplate();
  const before = Buffer.from(tpl);
  const ph = detectPlaceholders(readText(tpl));
  assert.deepEqual(ph.filter((x) => x.kind !== 'signature').map((x) => x.label), ['Client', 'EFFECTIVE DATE', 'Fee', 'STATE', 'Project contact']);
  const res = fillDocxPlaceholders(tpl, { Client: 'Acme Corp', 'Effective date': 'March 1, 2027', fee: '$4,500', State: 'Texas' });
  assert.ok(tpl.equals(before));
  assert.deepEqual(res.filled.sort(), ['Client', 'EFFECTIVE DATE', 'Fee', 'STATE']);
  assert.deepEqual(res.missing, ['Project contact']);
  const t = readText(res.data);
  assert.match(t, /made between Acme Corp and Northwind Studio LLC, effective March 1, 2027\./);
  assert.match(t, /Client shall pay \$4,500 within 30 days/);
  assert.match(t, /laws of the State of Texas\./);
  assert.match(t, /Signature: ________________/, 'signature lines are left for signing');
  const xml = docXml(res.data);
  strictXml(xml);
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Acme Corp<\/w:t>/, 'the value takes the placeholder\'s formatting');
  assert.doesNotMatch(xml, /\{\{|\}\}/);
});

test('S7 tracked changes: real w:ins/w:del by Sara with a date, word-level, readable by the Library reader', () => {
  const tpl = agreementTemplate();
  const date = new Date('2027-01-05T15:00:00Z');
  const res = reviseDocx(
    tpl,
    [
      { find: 'within 30 days of each invoice', replace: 'within 15 days of each invoice' },
      { find: 'on 15 days written notice', replace: 'on 30 days written notice' },
      { after: 'Either party may terminate', insert: 'Sections 1 and 3 survive termination.' },
      { deleteParagraph: 'See [1] and [page 3]' },
      { find: 'no such words here', replace: 'x' },
    ],
    { date },
  );
  assert.deepEqual(res.applied.map((a) => a.status), ['done', 'done', 'done', 'done', 'not_found']);
  const xml = docXml(res.data);
  strictXml(xml);
  assert.match(xml, /<w:ins w:id="\d+" w:author="Sara" w:date="2027-01-05T15:00:00Z">/);
  assert.match(xml, /<w:del w:id="\d+" w:author="Sara" w:date="2027-01-05T15:00:00Z"><w:r><w:delText xml:space="preserve">30<\/w:delText>/);
  // Only the changed word is marked, not the whole sentence.
  assert.match(xml, /<w:t xml:space="preserve">Client shall pay <\/w:t>/);
  const ids = [...xml.matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'revision ids are unique');
  // The Library's reader shows the document as if every change were accepted.
  const t = readText(res.data);
  assert.match(t, /within 15 days of each invoice/);
  assert.match(t, /on 30 days written notice/);
  assert.match(t, /Sections 1 and 3 survive termination\./);
  assert.doesNotMatch(t, /See \[1\]/);
  // The review list: what was inserted and deleted, by whom, when.
  const revs = listRevisions(res.data);
  assert.ok(revs.length >= 6);
  assert.ok(revs.every((x) => x.author === 'Sara' && x.date === '2027-01-05T15:00:00Z'));
  assert.ok(revs.some((x) => x.type === 'del' && x.text === '30' && /within/.test(x.context)));
  assert.ok(revs.some((x) => x.type === 'ins' && x.text === 'Sections 1 and 3 survive termination.'));
  assert.ok(revs.some((x) => x.type === 'del' && /See \[1\]/.test(x.text)));
  // A new paragraph's mark is inserted too; a deleted paragraph's mark is deleted (clean Accept/Reject).
  assert.match(xml, /<w:pPr><w:rPr><w:ins w:id="\d+" w:author="Sara"/);
  assert.match(xml, /<w:rPr><w:del w:id="\d+" w:author="Sara"/);
  // The settings part turns on Track Changes so the person's own edits are tracked too.
  assert.match(new Zip(res.data).text('word/settings.xml') ?? '', /<w:trackRevisions\/>/);
  assert.match(new Zip(res.data).text('[Content_Types].xml') ?? '', /word\/settings\.xml/);
  // Revising twice keeps the earlier revisions and new ids keep counting up.
  const again = reviseDocx(res.data, [{ find: 'Northwind Studio LLC', replace: 'Northwind Studio, LLC' }], { date, author: 'Sara' });
  assert.equal(again.applied[0].status, 'done');
  assert.ok(listRevisions(again.data).length > revs.length);
  const ids2 = [...docXml(again.data).matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids2).size, ids2.length);
});

test('S7 tracked changes on a document Sara made (real styles part, made by make_document)', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date('2027-01-05T15:00:00Z') });
    app.library = new LibraryStore(app.store.db, dir, () => new Date());
    const tools = createDocStudioTools(() => app);
    assert.deepEqual(tools.map((x) => x.spec.name), ['doc_from_template', 'doc_revise', 'doc_checklist', 'doc_to_sign']);
    for (const t of tools) assert.equal(familyOf(t).id, 'documents', t.spec.name);
    // A Word file from make_document (styles, numbering, settings parts) revised and read back.
    const { data } = makeDocument(app, { format: 'docx', title: 'Proposal', content: '# Website proposal\n\n## Scope\n\nWe will redesign **five** pages.\n\n## Price\n\nThe fixed price is $9,000, due in two parts.\n\n- Kickoff in March\n- Launch in May' });
    const res = reviseDocx(data, [{ find: 'The fixed price is $9,000', replace: 'The fixed price is $8,500' }, { find: 'Launch in May', replace: 'Launch in June' }], { date: new Date('2027-01-05T15:00:00Z') });
    assert.deepEqual(res.applied.map((a) => a.status), ['done', 'done']);
    strictXml(docXml(res.data));
    const zip = new Zip(res.data);
    assert.equal((zip.text('word/settings.xml') ?? '').match(/<w:trackRevisions\/>/g)?.length ?? 0, 1);
    assert.match(readText(res.data), /The fixed price is \$8,500, due in two parts\./);
    assert.match(readText(res.data), /Launch in June/);
    assert.ok(listRevisions(res.data).some((x) => x.type === 'del' && x.text === '9,000'));
    // Accept all: no revision marks left, the new words stay; reject all: the old words come back.
    const acc = resolveAll(res.data, 'accept');
    assert.ok(acc.resolved >= 4);
    assert.doesNotMatch(docXml(acc.data), /<w:(ins|del)\b/);
    assert.match(readText(acc.data), /\$8,500/);
    const rej = resolveAll(res.data, 'reject');
    assert.doesNotMatch(docXml(rej.data), /<w:(ins|del)\b/);
    assert.match(readText(rej.data), /\$9,000/);
    assert.match(readText(rej.data), /Launch in May/);
    strictXml(docXml(rej.data));
  } finally {
    cleanup();
  }
});

const CONTRACT = `SERVICES AGREEMENT
This Services Agreement is made between Acme Corp ("Client") and Northwind Studio LLC ("Provider").
1. Term. This Agreement begins on March 1, 2027 and shall automatically renew for successive one-year terms unless either party gives notice.
2. Payment. Client shall pay $4,500 per month within 30 days of invoice.
3. Termination. Either party may terminate this Agreement on 30 days written notice.
4. Confidentiality. Each party shall keep the other party's Confidential Information secret.
5. Intellectual property. All work product and intellectual property created under this Agreement belongs to Client upon payment.
6. Indemnification. Provider shall indemnify and hold harmless Client from third-party claims.
7. Governing law. This Agreement is governed by the laws of the State of Texas.
IN WITNESS WHEREOF, the parties have signed this Agreement.
Signature: ____________ Date: ________`;

test('S7 clause checklist: present, missing and unusual with quotes; a proposal has its own list; not legal advice', () => {
  assert.equal(guessDocType('Acme MSA.docx', CONTRACT), 'contract');
  assert.equal(guessDocType('NDA - Acme.docx', 'Mutual Non-Disclosure Agreement'), 'nda');
  assert.equal(guessDocType('Website proposal.docx', 'Proposal\nScope of work\nTimeline\nInvestment'), 'proposal');
  assert.equal(guessDocType('Statement of Work 3.docx', ''), 'sow');
  const c = clauseChecklist(CONTRACT, 'contract');
  const by = Object.fromEntries(c.items.map((i) => [i.id, i]));
  assert.equal(by.parties.status, 'present');
  assert.match(by.parties.quote!, /between Acme Corp/);
  assert.equal(by.term.status, 'unusual', 'automatic renewal is flagged');
  assert.match(by.term.note!, /renew/i);
  assert.equal(by.payment.status, 'present');
  assert.match(by.payment.where!, /Section 2/);
  assert.equal(by.termination.status, 'present');
  assert.equal(by.liability_cap.status, 'missing');
  assert.equal(by.indemnity.status, 'present');
  assert.equal(by.confidentiality.status, 'present');
  assert.equal(by.ip.status, 'present');
  assert.equal(by.governing_law.status, 'present');
  assert.equal(by.signatures.status, 'present');
  assert.equal(c.missing, 1);
  assert.match(c.notice, /not legal advice/i);
  // Unlimited liability is unusual.
  const u = clauseChecklist(`${CONTRACT}\n8. Liability. Provider's liability shall not be limited in any way.`, 'contract');
  assert.equal(u.items.find((i) => i.id === 'liability_cap')!.status, 'unusual');
  // "effective March 1, 2027" is a start date (the term), and a bare heading is never the quote.
  const eff = clauseChecklist('This Agreement is made between Acme Corp and Northwind LLC, effective March 1, 2027.\n2. Payment\nClient shall pay $10 within 30 days of invoice.', 'contract');
  assert.equal(eff.items.find((i) => i.id === 'term')!.status, 'present');
  assert.match(eff.items.find((i) => i.id === 'payment')!.quote!, /shall pay/);
  const prop = clauseChecklist('Website redesign proposal\nScope: We will redesign five pages.\nTimeline: Six weeks from kickoff.\nAssumptions: Client provides copy.', 'proposal');
  assert.deepEqual(prop.items.map((i) => `${i.id}:${i.status}`), ['scope:present', 'timeline:present', 'price:missing', 'assumptions:present']);
});

test('S7 signature-ready PDF: AcroForm signature and date fields, page numbers, ready check blocks leftovers', async () => {
  const filled = fillDocxPlaceholders(agreementTemplate(), { Client: 'Acme Corp', 'Effective date': 'March 1, 2027', fee: '$4,500', State: 'Texas', 'Project contact': 'Dana Lee' }).data;
  const md = docxToMarkdown(filled);
  assert.match(md, /^# Consulting Agreement/m);
  assert.match(md, /^## 1\. Payment/m);
  const ok = makeSignPdf({ docx: filled, title: 'Consulting Agreement', signers: [{ party: 'Acme Corp', name: 'Pat Doe' }, { party: 'Northwind Studio LLC' }] });
  assert.equal(ok.ready, true, JSON.stringify(ok.checks));
  assert.deepEqual(ok.checks.map((c) => `${c.id}:${c.ok}`), ['placeholders:true', 'tracked:true', 'fields:true', 'pages:true']);
  const form = readPdfForm(ok.data!);
  const sigs = form.fields.filter((f) => f.kind === 'signature');
  const texts = form.fields.filter((f) => f.kind === 'text');
  assert.equal(sigs.length, 2);
  assert.ok(texts.some((f) => /date/i.test(f.name)));
  assert.ok(texts.some((f) => /name/i.test(f.name) && f.value === 'Pat Doe'));
  assert.match(ok.data!.toString('latin1'), /\/AcroForm/);
  assert.match(ok.data!.toString('latin1'), /\/AP << \/N \d+ 0 R >>/, 'a filled name shows in every viewer');
  assert.doesNotMatch(ok.data!.toString('latin1'), /Signature: _{4}/, 'the blank signature line gives way to the fields');
  // Leftover placeholders and tracked changes block it (no PDF unless asked for a draft).
  const revised = reviseDocx(agreementTemplate(), [{ find: '30 days of each', replace: '15 days of each' }], { date: new Date('2027-01-05T15:00:00Z') }).data;
  const bad = makeSignPdf({ docx: revised, title: 'Consulting Agreement', signers: [{ party: 'Acme Corp' }] });
  assert.equal(bad.ready, false);
  assert.equal(bad.data, undefined);
  const why = Object.fromEntries(bad.checks.map((c) => [c.id, c]));
  assert.equal(why.placeholders.ok, false);
  assert.match(why.placeholders.detail, /Client/);
  assert.equal(why.tracked.ok, false);
  const draft = makeSignPdf({ docx: revised, title: 'Consulting Agreement', signers: [{ party: 'Acme Corp' }], draft: true });
  assert.ok(draft.data && draft.ready === false);
});

test('S7 tools: mark a template, ask for its facts, fill it, revise with tracked changes, checklist, to sign', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const now = new Date('2027-01-05T15:00:00Z');
    const app = makeApp(dir, { now });
    app.library = new LibraryStore(app.store.db, dir, () => now);
    for (const t of createDocStudioTools(() => app)) app.tools.add(t);
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Kent', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-10T12:00:00.000Z' } as never);
    const results: string[] = [];
    const turn = async (msg: string) => {
      for await (const ev of runTurn(app, conv.id, msg)) if (ev.type === 'tool_result') results.push((ev as { output: string }).output);
    };
    const tpl = app.library.add({ name: 'Consulting agreement template.docx', bytes: agreementTemplate(), keep: true, origin: 'library', learn: false });
    const past = app.library.add({ name: 'Globex services agreement 2025.docx', bytes: docx([p(r('This Services Agreement is made between Globex Inc and Northwind Studio LLC.')), h1('Liability'), p(r("Provider's total liability under this Agreement shall not exceed the fees paid in the twelve months before the claim."))].join('')), keep: true, origin: 'library', learn: false });
    const tm = docTemplates(app).mark(tpl.id, 'contract', await (async () => detectPlaceholders(readText(agreementTemplate())))());
    assert.equal(tm.type, 'contract');
    assert.equal(docTemplates(app).list().length, 1);
    // Past clauses: the person's own wording, with the document it came from.
    const pc = await pastClauses(app, 'contract', { exclude: [tpl.id] });
    const cap = pc.find((x) => x.topic === 'liability_cap');
    assert.ok(cap && cap.docId === past.id && /shall not exceed the fees paid/.test(cap.quote));

    const conv = app.store.createConversation({ title: 'Docs' });
    // 1) No values yet: she gets the facts to ask for.
    app.script.push([call('a', 'doc_from_template', { template: String(tpl.id) })], text('ok'));
    await turn('Draft the consulting agreement from my template');
    // 2) Values + a clause from a past document (quoted, checked).
    app.script.push(
      [call('b', 'doc_from_template', { template: String(tpl.id), title: 'Consulting Agreement - Acme', values: { Client: 'Acme Corp', 'EFFECTIVE DATE': 'March 1, 2027', Fee: '$4,500', STATE: 'Texas', 'Project contact': 'Dana Lee' }, clauses: [{ topic: 'Liability', fromDoc: past.id, text: "Provider's total liability under this Agreement shall not exceed the fees paid in the twelve months before the claim." }] })],
      text('made'),
    );
    await turn('Here are the facts for the agreement');
    const tools = results;
    assert.match(tools[0], /Client/);
    assert.match(tools[0], /EFFECTIVE DATE/);
    assert.match(tools[0], /ask/i);
    assert.match(tools[0], /shall not exceed the fees paid/, 'their own past clause is offered');
    assert.match(tools[1], /Filled 5 of 5/);
    assert.match(tools[1], /Globex services agreement 2025\.docx/);
    const made = madeDocs(app).get(1)!;
    assert.equal(made.format, 'docx');
    const madeBytes = app.library.file(app.library.get(made.libraryId!)!)!;
    assert.match(readText(madeBytes), /shall not exceed the fees paid/);
    assert.deepEqual(made.spec.edited?.clauses?.map((c) => c.fromName), ['Globex services agreement 2025.docx']);

    // A made-up clause source is refused.
    app.script.push([call('c', 'doc_from_template', { template: String(tpl.id), values: { Client: 'X' }, clauses: [{ topic: 'Liability', fromDoc: past.id, text: 'Liability is capped at one dollar.' }] })], text('no'));
    await turn('Use a one dollar cap from the Globex contract');
    // Revise with tracked changes, then checklist, then to sign.
    app.script.push([call('d', 'doc_revise', { document: String(made.libraryId), changes: [{ find: 'within 30 days', replace: 'within 15 days' }] })], text('revised'));
    await turn('Make the payment term 15 days, tracked');
    assert.match(results[2], /isn't in “Globex/);
    assert.match(results[3], /tracked change/i);
    const v2 = madeDocs(app).get(2)!;
    assert.equal(v2.family, made.family);
    assert.equal(v2.version, 2);
    const v2bytes = app.library.file(app.library.get(v2.libraryId!)!)!;
    assert.ok(listRevisions(v2bytes).some((x) => x.type === 'ins' && x.text === '15'));

    // By name, the newest version (the tracked one), not the first.
    app.script.push([call('n', 'doc_to_sign', { document: 'Consulting Agreement - Acme' })], text('by name'));
    await turn('Is the Acme agreement ready to sign?');
    assert.match(results[4], /\(v2\)\.docx/);
    results.splice(4, 1);
    app.script.push([call('e', 'doc_checklist', { document: String(v2.libraryId) })], text('checked'));
    await turn('Check the clauses');
    app.script.push([call('f', 'doc_to_sign', { document: String(v2.libraryId) })], text('not yet'));
    await turn('Make it ready to sign');
    assert.match(results[4], /not legal advice/i);
    assert.match(results[4], /Liability cap/);
    assert.match(results[5], /tracked changes/i);
    assert.match(results[5], /Not ready to sign/i);
  } finally {
    cleanup();
  }
});

test('S7 routes: template mark + fill form, review list, accept all, ready to sign; members get their own', async () => {
  const { dir, cleanup } = tempDir();
  const now = new Date('2027-01-05T15:00:00Z');
  const app = makeApp(dir, { now });
  app.library = new LibraryStore(app.store.db, dir, () => now);
  app.settings.update({ disclosureAcceptedAt: now.toISOString() });
  const auth = new OwnerAuth(app.dataDir);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const bearer = ['Bearer', auth.newToken].join(' ');
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: bearer, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  try {
    const tpl = app.library.add({ name: 'Agreement template.docx', bytes: agreementTemplate(), keep: true, origin: 'library', learn: false });
    const info = (await api(`/api/doc-studio/${tpl.id}`)).body;
    assert.equal(info.docx, true);
    assert.equal(info.type, 'contract');
    assert.equal(info.template, null);
    assert.deepEqual(info.placeholders.map((p: { label: string }) => p.label), ['Client', 'EFFECTIVE DATE', 'Fee', 'STATE', 'Project contact']);
    assert.match(info.checklist.notice, /not legal advice/i);
    const marked = (await api(`/api/doc-studio/${tpl.id}/template`, 'PUT', { on: true, type: 'contract' })).body;
    assert.equal(marked.template.type, 'contract');
    assert.equal((await api('/api/doc-studio/templates')).body.templates.length, 1);
    const filled = await api(`/api/doc-studio/${tpl.id}/fill`, 'POST', { values: { Client: 'Acme Corp', 'EFFECTIVE DATE': 'March 1, 2027', Fee: '$4,500', STATE: 'Texas' }, title: 'Acme agreement' });
    assert.equal(filled.status, 201);
    assert.deepEqual(filled.body.missing, ['Project contact']);
    const newId = filled.body.made.libraryId;
    // Not ready: a blank is left.
    const notReady = (await api(`/api/doc-studio/${newId}/sign`, 'POST', {})).body;
    assert.equal(notReady.ready, false);
    assert.equal(notReady.made, null);
    // A revised copy: the review list shows Sara's changes; Accept all makes a clean new version.
    const revised = reviseDocx(fillDocxPlaceholders(agreementTemplate(), { Client: 'Acme Corp', 'Effective date': 'March 1, 2027', fee: '$4,500', State: 'Texas', 'Project contact': 'Dana Lee' }).data, [{ find: 'within 30 days', replace: 'within 15 days' }], { date: now });
    const rv = app.library.add({ name: 'Acme agreement v2.docx', bytes: revised.data, keep: true, origin: 'library', learn: false });
    const ri = (await api(`/api/doc-studio/${rv.id}`)).body;
    assert.ok(ri.revisions.some((r: { type: string; text: string; author: string }) => r.type === 'del' && r.text === '30' && r.author === 'Sara'));
    const acc = await api(`/api/doc-studio/${rv.id}/resolve`, 'POST', { how: 'accept' });
    assert.equal(acc.status, 201);
    const clean = acc.body.made.libraryId;
    assert.deepEqual((await api(`/api/doc-studio/${clean}`)).body.revisions, []);
    const sign = await api(`/api/doc-studio/${clean}/sign`, 'POST', { signers: [{ party: 'Acme Corp', name: 'Pat Doe' }, { party: 'Northwind Studio LLC' }] });
    assert.equal(sign.status, 201);
    assert.equal(sign.body.ready, true, JSON.stringify(sign.body.checks));
    assert.equal(sign.body.made.format, 'pdf');
    const pdf = await fetch(`${base}/api/library/made/${sign.body.made.id}/file`, { headers: { authorization: bearer } });
    const form = readPdfForm(Buffer.from(await pdf.arrayBuffer()));
    assert.equal(form.fields.filter((f) => f.kind === 'signature').length, 2);
    assert.equal((await api('/api/doc-studio/99999')).status, 404);
    assert.equal((await api(`/api/doc-studio/${clean}/resolve`, 'POST', { how: 'maybe' })).status, 400);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    cleanup();
  }
});

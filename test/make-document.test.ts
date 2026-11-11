// make_document (docs/DOCUMENTS.md): every format is made and read back with the Library's own
// readers (independent readers run in the end-to-end check), accented text survives, spreadsheets
// keep formulas and refuse ones that reach outside, the tool saves to the Library with versions and
// a chat card, members' documents stay in their own space, and private local mode keeps the tool.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { measure, pdfImage } from '../src/documents/images.ts';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { makeDocument, madeDocs, madeFile, madePreview, renderDocument } from '../src/documents/make.ts';
import { parseMarkdown } from '../src/documents/markdown.ts';
import { toAnsi } from '../src/documents/pdf.ts';
import { cellValue, cleanSpec, DocError, fileName, guessTemplate, sheetsOf, slidesOf } from '../src/documents/spec.ts';
import { CORE_CHAT, familyOf, leanFor, DEFAULT_LEAN, searchTools } from '../src/lean.ts';
import { readDocument } from '../src/library/read.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createMakeDocumentTool } from '../src/tools/make-document.ts';
import { call, makeApp, PNG, tempDir, text } from './helpers.ts';

const MD = `# Café report

## Résumé of the year

The **team** grew in *São Paulo*, Zürich and Kraków; see [our site](https://example.org/a).

- First point
  - nested point
- Second point

1. One
2. Two

| Item | Cost |
|------|-----:|
| Rent | 1,200 |
| Food | 300.50 |

> A quote that matters.

[page break]

## After the break

Größe, ação, perché, señor, œuvre — all fine.
`;

const noImages = () => undefined;
const textOf = async (name: string, buf: Buffer) => (await readDocument(name, buf)).parts.map((p) => p.text).join('\n');

test('make_document markdown: headings, inline styles, nested lists, tables, quotes, breaks and pictures', () => {
  const b = parseMarkdown(`${MD}\n![A chart](upload:${'a'.repeat(32)}.png)\n![web](https://example.org/x.png)\n`);
  assert.deepEqual(b.filter((x) => x.t === 'h').map((x) => (x as { level: number }).level), [1, 2, 2]);
  const p = b.find((x) => x.t === 'p')!;
  assert.ok(p.t === 'p' && p.runs.some((r) => r.bold && r.text === 'team') && p.runs.some((r) => r.italic && r.text === 'São Paulo') && p.runs.some((r) => r.href === 'https://example.org/a'));
  const lis = b.filter((x) => x.t === 'li') as { depth: number; ordered: boolean; num: number }[];
  assert.deepEqual(lis.map((l) => [l.depth, l.ordered, l.num]), [[0, false, 0], [1, false, 0], [0, false, 0], [0, true, 1], [0, true, 2]]);
  assert.equal(b.filter((x) => x.t === 'table').length, 1);
  assert.equal(b.filter((x) => x.t === 'break').length, 1);
  assert.equal(b.filter((x) => x.t === 'quote').length, 1);
  const imgs = b.filter((x) => x.t === 'img');
  assert.equal(imgs.length, 1, 'only her own pictures; a web address is never fetched');
  assert.equal(b.filter((x) => x.t === 'p' && x.runs.some((r) => r.text === 'web')).length, 1, 'a web picture stays its caption');
  assert.equal(parseMarkdown('![caption](https://images.example/x.jpg)').length, 0, 'a placeholder caption of a web picture goes');
  assert.deepEqual(parseMarkdown('[x](javascript:void)')[0], { t: 'p', runs: [{ text: 'x' }] }, 'only http(s)/mailto links');
});

test('make_document: templates are picked from the request, names and caps are checked', () => {
  assert.equal(guessTemplate('Résumé for Pat', ''), 'resume');
  assert.equal(guessTemplate('Pat Lee CV', ''), 'resume');
  assert.equal(guessTemplate('To the landlord', 'Dear Ms. Lee,\n\nThe heating…\n\nSincerely,\nAlex\n'), 'letter');
  assert.equal(guessTemplate('History of coffee', 'Coffee began…'), 'report');
  assert.equal(guessTemplate('Shopping', '- milk'), 'plain');
  assert.equal(fileName('Q3: plan / budget?', 'docx', 2), 'Q3 plan budget (v2).docx');
  // A letter keeps its address lines; elsewhere a line ending in two spaces breaks.
  const letter = parseMarkdown('Alex Morgan\n12 Elm Street', { keepLines: true })[0];
  assert.deepEqual(letter.t === 'p' && letter.runs.map((r) => r.text), ['Alex Morgan', '\n', '12 Elm Street']);
  const p = parseMarkdown('one  \ntwo\nthree')[0];
  assert.deepEqual(p.t === 'p' && p.runs.map((r) => r.text).join(''), 'one\ntwo three');
  assert.equal(cleanSpec({ format: 'word', content: 'hi' }).format, 'docx', 'format words map');
  assert.equal(cleanSpec({ format: 'Excel', content: 'hi' }).format, 'xlsx');
  assert.throws(() => cleanSpec({ format: 'exe', content: 'x' }), DocError);
  assert.throws(() => cleanSpec({ format: 'pdf', content: '' }), /Markdown/);
  assert.throws(() => cleanSpec({ format: 'pdf', content: 'x'.repeat(200_001) }), /too long/);
  assert.throws(() => cleanSpec({ format: 'xlsx', sheets: [{ rows: Array.from({ length: 5001 }, () => [1]) }] }), /rows/);
  assert.equal(cleanSpec({ format: 'pdf', content: '# Coffee\n\ntext' }).title, 'Coffee', 'title from the first heading');
  assert.equal(cleanSpec({ format: 'docx', title: 'Pat_Resume.docx', content: 'x' }).title, 'Pat_Resume', 'a file-name title loses its extension (no "x.docx.docx")');
});

test('make_document: formulas stay inside the workbook; CSV cells are never run', () => {
  assert.equal(cellValue('=SUM(B2:B3)'), '=SUM(B2:B3)');
  assert.equal(cellValue('1,200'), 1200);
  assert.equal(cellValue('300.50'), 300.5);
  for (const bad of ['=WEBSERVICE("https://x.example")', "=cmd|' /C calc'!A0", '=[book.xlsx]Sheet1!A1', '=HYPERLINK("http://x")&IMPORTXML(1)', '=IMAGE("x")']) assert.throws(() => cellValue(bad), /outside the spreadsheet/, bad);
  const csv = renderDocument(cleanSpec({ format: 'csv', sheets: [{ rows: [['a', 'b'], ['=1+1', '-5'], ['@x', 'say "hi", ok']] }] }), noImages).toString('utf8');
  assert.match(csv, /'=1\+1,-5/, 'a formula is text in a CSV; a negative number stays a number');
  assert.match(csv, /'@x,"say ""hi"", ok"/);
});

test('make_document: Word opens, keeps styles, lists, tables, links, pictures and accents', async () => {
  const spec = cleanSpec({ format: 'docx', title: 'Café report', content: `${MD}\n![A dot](upload:x)\n` });
  const pic = { mime: 'image/png' as const, bytes: Buffer.from(PNG, 'base64'), width: 1, height: 1 };
  const buf = renderDocument({ ...spec, content: `${spec.content}\n![A dot](upload:${'b'.repeat(32)}.png)\n` }, () => pic);
  const zip = new Zip(buf);
  const names = zip.all.map((e) => e.name);
  for (const p of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/footer1.xml', 'word/media/image1.png']) assert.ok(names.includes(p), p);
  assert.ok(!names.some((n) => /vbaProject|macro/i.test(n)), 'no macros');
  const doc = zip.read('word/document.xml').toString('utf8');
  assert.match(doc, /w:val="Title"/);
  assert.match(doc, /<w:numId w:val="1"\/>/, 'bullets');
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:br w:type="page"\/>/);
  assert.match(doc, /<w:drawing>/);
  assert.match(zip.read('word/_rels/document.xml.rels').toString('utf8'), /Target="https:\/\/example\.org\/a" TargetMode="External"/);
  const t = await textOf('r.docx', buf);
  for (const w of ['São Paulo', 'Größe, ação, perché, señor, œuvre', 'Rent', '1,200']) assert.ok(t.includes(w), w);
});

test('make_document: PDF opens, has pages, page numbers and WinAnsi accents', async () => {
  const buf = renderDocument(cleanSpec({ format: 'pdf', title: 'Café report', content: MD }), noImages);
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 2/, 'the page break made a second page');
  assert.match(s, /\/Helvetica-Oblique/);
  const t = await textOf('r.pdf', buf);
  for (const w of ['São Paulo', 'Größe, ação, perché, señor, œuvre', 'Rent', '1 / 2']) assert.ok(t.includes(w), `${w} in ${t.slice(0, 300)}`);
  assert.equal(toAnsi('Kraków łódź 中'), 'Kraków lódz ?', 'letters WinAnsi lacks lose their accent; others become ?');
});

test('make_document: PDF takes PNG (with transparency) and JPEG pictures', () => {
  // A 2×2 RGBA PNG (rows filtered with Sub and Paeth), made here.
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  const rows = Buffer.from([1, 255, 0, 0, 255, 1, 255, 0, 129, 4, 0, 0, 255, 0, 10, 10, 10, 0]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const pic = measure(png)!;
  assert.deepEqual([pic.mime, pic.width, pic.height], ['image/png', 2, 2]);
  const img = pdfImage(pic)!;
  assert.ok(img.mask, 'transparency as a soft mask');
  assert.deepEqual([...inflateSync(img.data)], [255, 0, 0, 0, 255, 0, 255, 0, 255, 10, 9, 9], 'Sub and Paeth rows unfiltered');
  assert.deepEqual([...inflateSync(img.mask.data)], [255, 128, 255, 128]);
  const buf = renderDocument(cleanSpec({ format: 'pdf', content: `# P\n\n![dot](upload:${'c'.repeat(32)}.png)\n` }), () => pic);
  const s = buf.toString('latin1');
  assert.match(s, /\/Subtype \/Image/);
  assert.match(s, /\/SMask \d+ 0 R/);
  // A JPEG goes in as it is (DCTDecode); its size is read from the frame header.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 30, 0, 40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 0, 0, 0]);
  assert.deepEqual([measure(jpeg)!.width, measure(jpeg)!.height], [40, 30]);
  assert.match(pdfImage(measure(jpeg)!)!.dict, /DCTDecode/);
});

test('make_document: Excel keeps sheets, numbers and formulas; Markdown tables become sheets', async () => {
  const spec = cleanSpec({ format: 'xlsx', title: 'Budget', sheets: [{ name: 'Costs', rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300.5], ['Total', '=SUM(B2:B3)']] }, { name: 'Notes', rows: [['Café ok']] }] });
  const buf = renderDocument(spec, noImages);
  const zip = new Zip(buf);
  const sheet = zip.read('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /<f>SUM\(B2:B3\)<\/f>/);
  assert.match(sheet, /<v>1200<\/v>/);
  assert.match(sheet, /state="frozen"/);
  assert.match(zip.read('xl/workbook.xml').toString('utf8'), /name="Costs".*name="Notes"/);
  assert.ok(!zip.all.some((e) => /vbaProject/i.test(e.name)));
  const t = await textOf('b.xlsx', buf);
  assert.ok(t.includes('Rent') && t.includes('Café ok'), t);
  const fromMd = sheetsOf(cleanSpec({ format: 'xlsx', content: MD }));
  assert.equal(fromMd[0].name, 'Résumé of the year', 'the heading above a table names its sheet');
  assert.deepEqual(fromMd[0].rows[1], ['Rent', 1200]);
});

test('make_document: PowerPoint has a cover, a slide per heading, notes and slide numbers', async () => {
  const md = `# Coffee\n\nA short history\n\n## Origins\n\n- Ethiopia\n- Yemen\n  - Mocha port\n\nNotes: mention Kaldi.\n\n## Today\n\n- 2 billion cups a day\n`;
  const spec = cleanSpec({ format: 'pptx', content: md });
  const slides = slidesOf(spec);
  assert.equal(slides.length, 3);
  assert.equal(slides[0].cover, true);
  assert.equal(slides[0].subtitle, 'A short history');
  assert.equal(slides[1].notes, 'mention Kaldi.');
  const buf = renderDocument(spec, noImages);
  const zip = new Zip(buf);
  const names = zip.all.map((e) => e.name);
  for (const p of ['ppt/presentation.xml', 'ppt/slides/slide3.xml', 'ppt/notesSlides/notesSlide2.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/theme/theme1.xml']) assert.ok(names.includes(p), p);
  const t = await textOf('c.pptx', buf);
  for (const w of ['Coffee', 'Ethiopia', 'Mocha port', '2 billion cups a day']) assert.ok(t.includes(w), w);
  const given = slidesOf(cleanSpec({ format: 'pptx', slides: [{ title: 'Hi' }, { title: 'Two', bullets: ['a', '  b'], notes: 'n' }] }));
  assert.equal(given[1].lines[1].depth, 1);
});

test('make_document: HTML and the preview are self-contained (no scripts, nothing fetched)', () => {
  const spec = cleanSpec({ format: 'html', content: `${MD}\n<script>alert(1)</script>\n` });
  const html = renderDocument(spec, noImages).toString('utf8');
  assert.ok(!/<script/i.test(html), 'markup in content is escaped');
  assert.ok(!/(src|href)="(?!data:|https:\/\/example\.org)/.test(html.replace(/<a href="https:\/\/example\.org\/a"/, '')), 'nothing loaded from elsewhere');
  assert.match(html, /<table>/);
});

test('make_document tool: saves to the Library, shows a card, makes versions and reads a document back', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => new Date('2026-11-10T12:00:00Z'));
  app.tools.add(createMakeDocumentTool(() => app));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-10T12:00:00.000Z' } as never);
  const conv = app.store.createConversation({ title: 'docs' });
  const turn = async (args: Record<string, unknown>) => {
    const evs: ChatEvent[] = [];
    app.script.push([call(`m${Math.random()}`, 'make_document', args)], text('Done.'));
    for await (const ev of runTurn(app, conv.id, 'make me a word document')) evs.push(ev);
    return evs;
  };
  const out = (evs: ChatEvent[]) => (evs.find((e) => e.type === 'tool_result') as { output: string; status: string });
  const first = await turn({ format: 'docx', title: 'Coffee', content: '# Coffee\n\nIt began in Ethiopia.' });
  assert.equal(out(first).status, 'ok', out(first).output);
  assert.match(out(first).output, /Made “Coffee” as a Word document \(Coffee\.docx/);
  const file = first.find((e) => e.type === 'file') as { name: string; made: { id: number; version: number } } | undefined;
  assert.ok(file, 'a file event for the live chat');
  assert.equal(file.made.version, 1);
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((reply.meta?.files as { made: { id: number } }[])[0].made.id, file.made.id, 'the card is on her saved reply');
  const m1 = madeDocs(app).get(file.made.id)!;
  assert.ok(m1.libraryId && app.library.get(m1.libraryId)!.keep, 'kept in her Library');
  assert.equal(app.library.get(m1.libraryId)!.name, 'Coffee.docx');
  // Read it back, then make version 2 (same format and title), keeping version 1.
  const read = await turn({ basedOn: m1.id });
  assert.match(out(read).output, /It began in Ethiopia\./);
  const second = await turn({ basedOn: m1.id, content: '# Coffee\n\nIt began in Ethiopia, then Yemen.' });
  const m2 = madeDocs(app).get((second.find((e) => e.type === 'file') as { made: { id: number } }).made.id)!;
  assert.equal(m2.version, 2);
  assert.equal(m2.family, m1.family);
  assert.equal(m2.name, 'Coffee (v2).docx');
  assert.equal(madeDocs(app).versions(m1.family).length, 2);
  assert.match(await textOf('x.docx', madeFile(app, m1)), /It began in Ethiopia\./, 'version 1 is still there');
  assert.match(madePreview(app, m2), /then Yemen/);
  assert.match(out(await turn({ basedOn: 999 })).output, /no document #999/);
  assert.match(out(await turn({ format: 'xlsx', sheets: [{ rows: [['=WEBSERVICE("http://x")']] }] })).output, /outside the spreadsheet/);
});

test('make_document: each household space keeps its own documents', async (t) => {
  const a = tempDir();
  const b = tempDir();
  t.after(() => {
    a.cleanup();
    b.cleanup();
  });
  const clock = { now: new Date('2026-11-10T12:00:00Z') };
  const owner = makeApp(a.dir, clock);
  const member = makeApp(b.dir, clock);
  owner.library = new LibraryStore(owner.store.db, a.dir, () => clock.now);
  member.library = new LibraryStore(member.store.db, b.dir, () => clock.now);
  const made = makeDocument(owner, { format: 'md', title: 'Owner only', content: '# Secret plan' }).made;
  assert.ok(madeDocs(owner).get(made.id));
  assert.equal(madeDocs(member).get(made.id), undefined, "a member's space can't see the owner's document");
  assert.equal(member.library.list().length, 0);
  assert.ok(existsSync(a.dir) && member.library.list().every((d) => d.name !== 'Owner only.md'));
});

test('make_document: offered in private local mode, found by find_tools and by the lean picker in six languages', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  app.library = new LibraryStore(app.store.db, dir, () => new Date());
  const tool = createMakeDocumentTool(() => app);
  app.tools.add(tool);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-10T12:00:00.000Z' } as never);
  const conv = app.store.createConversation({ title: 'x' });
  setPrivateLocal(true);
  try {
    app.script.push(text('ok'));
    for await (const ev of runTurn(app, conv.id, 'hi')) void ev;
    assert.ok((app.requests.at(-1)!.tools ?? []).some((x) => x.name === 'make_document'), 'works offline: nothing leaves the server');
  } finally {
    setPrivateLocal(false);
  }
  assert.equal(familyOf(tool).id, 'documents');
  assert.ok((CORE_CHAT as readonly string[]).includes('make_document'));
  for (const q of ['word document', 'make a pdf', 'excel spreadsheet', 'powerpoint slides', 'resume', 'invoice']) assert.equal(searchTools([tool], q)[0]?.tool.spec.name, 'make_document', q);
  const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const, localCore: true };
  for (const msg of ['make me a one-page PDF about coffee', 'hazme un informe en Word', 'fais-moi une lettre', 'erstelle eine Tabelle', 'faça uma planilha', 'fammi una presentazione']) {
    const tt = leanFor(lean, [tool], { text: msg, mode: 'chat', local: true, turnId: 1, ownerTurnIds: [1] });
    assert.ok(tt.offeredNames([tool]).includes('make_document'), msg);
  }
});

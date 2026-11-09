// EC6 slice 1 (docs/ops/EC6_DESIGN.md "Exports"): the report's Word and PDF files open. The DOCX
// is checked as a zip (central directory, required parts, hyperlink relationships) and read back
// with the Library's own reader; the PDF's header, xref offsets, trailer and %%EOF are checked and
// it is read back with the Library's own PDF reader.
import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToDocx, markdownToPdf, parseReport } from '../src/doc-write.ts';
import { Zip } from '../src/library/zip.ts';
import { readDocument } from '../src/library/read.ts';

const MD = `# Do heat pumps work in cold climates?

## Short answer

Modern cold-climate heat pumps keep heating at -25 °C [1](https://example.org/a). Efficiency drops as it gets colder [1](https://example.org/a), [2](https://example.org/b).

- Ducted and ductless models exist [2](https://example.org/b).

## Sources

1. [Cold climate study](https://example.org/a)
2. [Field report & notes <2026>](https://example.org/b)
`;

test('ec6 docwrite: markdown blocks and links are parsed', () => {
  const blocks = parseReport(MD);
  assert.equal(blocks[0].kind, 'title');
  assert.deepEqual(blocks.filter((b) => b.kind === 'h2').map((b) => b.runs.map((r) => r.text).join('')), ['Short answer', 'Sources']);
  const para = blocks.find((b) => b.kind === 'p')!;
  assert.ok(para.runs.some((r) => r.href === 'https://example.org/a' && r.text === '[1]'), 'citation keeps its brackets and link');
  assert.equal(blocks.filter((b) => b.kind === 'li').length, 1);
  assert.equal(blocks.filter((b) => b.kind === 'oli').length, 2);
});

test('ec6 docwrite: the Word file is a valid docx with real hyperlinks', async () => {
  const buf = markdownToDocx(MD, 'Do heat pumps work in cold climates?');
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'zip local header');
  const zip = new Zip(buf);
  const names = zip.all.map((e) => e.name);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) assert.ok(names.includes(p), p);
  const rels = zip.read('word/_rels/document.xml.rels').toString('utf8');
  assert.match(rels, /Target="https:\/\/example\.org\/a" TargetMode="External"/);
  const doc = zip.read('word/document.xml').toString('utf8');
  assert.match(doc, /<w:hyperlink r:id="rId\d+"/);
  assert.match(doc, /&amp; notes &lt;2026&gt;/, 'xml escaped');
  assert.match(doc, /w:val="Heading1"/);
  const back = await readDocument('report.docx', buf);
  const text = back.parts.map((p) => p.text).join('\n');
  assert.match(text, /cold-climate heat pumps keep heating at -25 °C/);
  assert.match(text, /Field report & notes <2026>/);
});

test('ec6 docwrite: the PDF has a header, a correct xref, a trailer and reads back', async () => {
  const long = `${MD}\n${Array.from({ length: 160 }, (_, i) => `Line ${i} — “quoted” text that wraps across the page width to force a few page breaks in the PDF writer, ✓ done.`).join('\n\n')}\n`;
  const buf = markdownToPdf(long, 'Heat pumps');
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'), 'header');
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s.slice(startxref))!;
  const count = Number(m[1]);
  const rows = m[2].trim().split('\n');
  assert.equal(rows.length, count);
  for (let i = 1; i < count; i++) {
    const off = Number(rows[i].slice(0, 10));
    assert.match(s.slice(off, off + 20), new RegExp(`^${i} 0 obj`), `object ${i} at its xref offset`);
  }
  assert.match(s, /trailer\s*<<[^>]*\/Size \d+[^>]*\/Root 1 0 R/);
  assert.match(s, /\/Subtype \/Link[\s\S]*\/URI \(https:\/\/example\.org\/a\)/, 'source links are clickable');
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
  assert.ok(pages >= 3, `pages: ${pages}`);
  const back = await readDocument('report.pdf', buf);
  const text = back.parts.map((p) => p.text).join('\n');
  assert.match(text, /cold-climate heat pumps keep heating/);
  assert.match(text, /Line 159/);
  assert.match(text, /“quoted”/, 'WinAnsi quotes survive');
});

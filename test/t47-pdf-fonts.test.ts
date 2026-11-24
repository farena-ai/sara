// C23 (docs/RESEARCH.md "The PDF and other scripts"): the PDF writer draws text Helvetica can't
// write with a font already on the computer, and says plainly what it could not draw. The tests
// make their own small TrueType fonts in a temp folder (so they do not depend on this machine),
// write PDFs and read them back with the Library's own PDF reader. One last test uses the real
// fonts of this computer when it has any.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { inflateSync } from 'node:zlib';
import { markdownToPdf, visualOrder } from '../src/doc-write.ts';
import { readDocument } from '../src/library/read.ts';
import { fontDirs, parseFace, pdfFontDeps, subsetFace, SystemFonts } from '../src/pdf-fonts.ts';
import { tempDir } from './helpers.ts';

const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);

/**
 * A small TrueType font: glyph 0 (.notdef), glyph 1 (a square), one square per character, and for
 * `composite` a glyph built from glyph 1. `fsType` sets the licence bits (OS/2).
 */
function makeFont(chars: string, o: { composite?: string; fsType?: number; format4Only?: boolean } = {}): Buffer {
  const list = [...new Set([...cps(chars), ...(o.composite ? cps(o.composite) : [])])].sort((a, b) => a - b);
  const comp = new Set(o.composite ? cps(o.composite) : []);
  const square = Buffer.alloc(36);
  square.writeInt16BE(1, 0);
  square.writeInt16BE(500, 6);
  square.writeInt16BE(700, 8);
  square.writeUInt16BE(3, 10);
  square.writeUInt16BE(0, 12);
  square.fill(1, 14, 18);
  [0, 500, 0, -500].forEach((v, i) => square.writeInt16BE(v, 18 + 2 * i));
  [0, 0, 700, 0].forEach((v, i) => square.writeInt16BE(v, 26 + 2 * i));
  const composite = Buffer.alloc(20);
  composite.writeInt16BE(-1, 0);
  composite.writeInt16BE(500, 6);
  composite.writeInt16BE(700, 8);
  composite.writeUInt16BE(0x0003, 10);
  composite.writeUInt16BE(1, 12);
  const glyphs = [square, square, ...list.map((cp) => (comp.has(cp) ? composite : square))];
  const n = glyphs.length;
  const loca = Buffer.alloc(4 * (n + 1));
  let at = 0;
  glyphs.forEach((g, i) => {
    loca.writeUInt32BE(at, 4 * i);
    at += g.length;
  });
  loca.writeUInt32BE(at, 4 * n);
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  head.writeInt16BE(500, 40);
  head.writeInt16BE(700, 42);
  head.writeInt16BE(1, 50);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(n, 34);
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(n, 4);
  const hmtx = Buffer.alloc(4 * n);
  for (let i = 0; i < n; i++) hmtx.writeUInt16BE(600, 4 * i);
  // cmap: format 4 for the first plane, and format 12 for everything unless asked not to.
  const bmp = list.filter((cp) => cp <= 0xffff);
  const segs = bmp.length + 1;
  const f4 = Buffer.alloc(16 + 8 * segs);
  f4.writeUInt16BE(4, 0);
  f4.writeUInt16BE(f4.length, 2);
  f4.writeUInt16BE(segs * 2, 6);
  [...bmp, 0xffff].forEach((cp, i) => {
    f4.writeUInt16BE(cp, 14 + 2 * i);
    f4.writeUInt16BE(cp, 16 + 2 * segs + 2 * i);
    f4.writeUInt16BE(cp === 0xffff ? 1 : (list.indexOf(cp) + 2 - cp) & 0xffff, 16 + 4 * segs + 2 * i);
  });
  const f12 = Buffer.alloc(16 + 12 * list.length);
  f12.writeUInt16BE(12, 0);
  f12.writeUInt32BE(f12.length, 4);
  f12.writeUInt32BE(list.length, 12);
  list.forEach((cp, i) => {
    f12.writeUInt32BE(cp, 16 + 12 * i);
    f12.writeUInt32BE(cp, 20 + 12 * i);
    f12.writeUInt32BE(i + 2, 24 + 12 * i);
  });
  const subs = o.format4Only ? [[3, 1, f4]] : [[3, 1, f4], [3, 10, f12]];
  const cmapHead = Buffer.alloc(4 + 8 * subs.length);
  cmapHead.writeUInt16BE(subs.length, 2);
  let off = cmapHead.length;
  subs.forEach(([p, e, b], i) => {
    cmapHead.writeUInt16BE(p as number, 4 + 8 * i);
    cmapHead.writeUInt16BE(e as number, 6 + 8 * i);
    cmapHead.writeUInt32BE(off, 8 + 8 * i);
    off += (b as Buffer).length;
  });
  const cmap = Buffer.concat([cmapHead, ...subs.map((x) => x[2] as Buffer)]);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(o.fsType ?? 0, 8);
  const tables: [string, Buffer][] = [['OS/2', os2], ['cmap', cmap], ['glyf', Buffer.concat(glyphs)], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp]];
  const dir = Buffer.alloc(12 + 16 * tables.length);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(tables.length, 4);
  let pos = dir.length;
  tables.forEach(([tag, data], i) => {
    dir.write(tag, 12 + 16 * i, 'latin1');
    dir.writeUInt32BE(pos, 12 + 16 * i + 8);
    dir.writeUInt32BE(data.length, 12 + 16 * i + 12);
    pos += data.length;
  });
  return Buffer.concat([dir, ...tables.map((x) => x[1])]);
}

/** A temp font folder holding these files; the PDF writer looks there and nowhere else. */
function fontsIn(t: TestContext, files: Record<string, Buffer>): string {
  const { dir, cleanup } = tempDir();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  pdfFontDeps.dirs = [dir];
  t.after(() => {
    pdfFontDeps.dirs = undefined;
    cleanup();
  });
  return dir;
}
const textOf = async (pdf: Buffer) => (await readDocument('report.pdf', pdf)).parts.map((p) => p.text).join('\n');
/** The header, every object at its xref offset, the trailer. */
function checkFile(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s.slice(startxref))!;
  const rows = m[2].trim().split('\n');
  assert.equal(rows.length, Number(m[1]));
  for (let i = 1; i < rows.length; i++) assert.ok(s.slice(Number(rows[i].slice(0, 10))).startsWith(`${i} 0 obj`), `object ${i} at its xref offset`);
  return s;
}
/** The font files embedded in a PDF, unpacked. */
function embedded(pdf: Buffer): Buffer[] {
  const s = pdf.toString('latin1');
  return [...s.matchAll(/\/Filter \/FlateDecode \/Length1 (\d+) \/Length (\d+) >>\nstream\n/g)].map((m) => {
    const at = m.index + m[0].length;
    const out = inflateSync(pdf.subarray(at, at + Number(m[2])));
    assert.equal(out.length, Number(m[1]));
    return out;
  });
}
/** Table lengths of each glyph in a TrueType file with a long loca. */
function glyphLengths(ttf: Buffer): number[] {
  const n = ttf.readUInt16BE(4);
  const t = new Map<string, number>();
  for (let i = 0; i < n; i++) t.set(ttf.toString('latin1', 12 + 16 * i, 16 + 16 * i), ttf.readUInt32BE(12 + 16 * i + 8));
  const count = ttf.readUInt16BE(t.get('maxp')! + 4);
  assert.equal(ttf.readInt16BE(t.get('head')! + 50), 1);
  return Array.from({ length: count }, (_, g) => ttf.readUInt32BE(t.get('loca')! + 4 * (g + 1)) - ttf.readUInt32BE(t.get('loca')! + 4 * g));
}

const GREEK = 'Ελληνικά';
const RUSSIAN = 'Привет';

test('t47 pdf: Greek and Cyrillic are drawn with a font of the computer, embedded with only the glyphs used, and read back', async (t) => {
  fontsIn(t, { 'dejavusans.ttf': makeFont(`${GREEK}${RUSSIAN}мир абвгдежзийклнопрстуфхцчшщ`, { composite: 'é́ё' }), 'dejavusans-bold.ttf': makeFont(RUSSIAN) });
  const pdf = markdownToPdf(`# ${RUSSIAN} мир\n\nGreek ${GREEK}, Russian ${RUSSIAN} and ёж [1](https://example.org/a).\n`, `${RUSSIAN} мир`);
  const s = checkFile(pdf);
  const text = await textOf(pdf);
  assert.match(text, new RegExp(`Greek ${GREEK}, Russian ${RUSSIAN} and ёж`));
  assert.match(text, new RegExp(`${RUSSIAN} мир`), 'the heading too');
  assert.doesNotMatch(text, /\?|\[…\]|Not shown/, 'nothing is replaced and there is no note');
  assert.match(s, /\/Subtype \/Type0[^>]*\/Encoding \/Identity-H/);
  assert.match(s, /\/Subtype \/CIDFontType2/);
  assert.match(s, /\/BaseFont \/[A-Z]{6}\+dejavusans\b/, 'the regular file');
  assert.match(s, /\/BaseFont \/[A-Z]{6}\+dejavusansbold\b/, 'the bold file for the heading');
  assert.match(s, /\/Title <FEFF041F/, 'the title in the file details keeps its letters');
  assert.match(s, /\/Subtype \/Link[\s\S]*\/URI \(https:\/\/example\.org\/a\)/);
  // The embedded file draws the glyphs used and the part a composite glyph is built from; the rest are empty.
  const files = embedded(pdf);
  assert.equal(files.length, 2);
  const lens = glyphLengths(files.find((f) => glyphLengths(f).length > 10)!);
  const face = parseFace(makeFont(`${GREEK}${RUSSIAN}мир абвгдежзийклнопрстуфхцчшщ`, { composite: 'é́ё' }))!;
  assert.ok(lens[face.glyph('П'.codePointAt(0)!)] > 0, 'a letter used');
  assert.ok(lens[face.glyph('ё'.codePointAt(0)!)] > 0, 'a composite letter used');
  assert.ok(lens[1] > 0, 'the glyph the composite is built from');
  assert.equal(lens[face.glyph('щ'.codePointAt(0)!)], 0, 'a letter not used is empty');
  assert.ok(lens.filter((x) => x > 0).length < lens.length / 2);
});

test('t47 pdf: with no font for a script the text is marked and named in a note, in the reader’s language, never "?"', async (t) => {
  fontsIn(t, {});
  const md = `# Report\n\nRussian ${RUSSIAN} мир and Greek ${GREEK}. Plain text stays: café “quoted” — done.\n`;
  const text = await textOf(markdownToPdf(md, 'Report'));
  assert.match(text, /Russian \[…\] and Greek \[…\]\./, 'a run of words that can’t be drawn is one mark');
  assert.match(text, /Not shown in this PDF: Cyrillic, Greek\. Each place is marked \[…\]\./);
  assert.match(text, /café “quoted” — done/);
  assert.doesNotMatch(text, /\?/);
  assert.ok(text.indexOf('Not shown') < text.indexOf('Russian'), 'the note is under the title, before the text');
  const es = await textOf(markdownToPdf(md, 'Report', { lang: 'es' }));
  assert.match(es, /No se muestra en este PDF: cirílico, griego\./);
  // Plain Western text: no note, no font work, the same small file as before.
  const plain = markdownToPdf('# Report\n\nOnly café and “quotes”.\n', 'Report');
  assert.doesNotMatch(await textOf(plain), /Not shown|\[…\]/);
  assert.ok(plain.length < 2000);
  assert.doesNotMatch(plain.toString('latin1'), /FontFile2/);
});

test('t47 pdf: scripts whose letters must be joined are marked even when a font has them; emoji and other characters are named', async (t) => {
  const arabic = 'مرحبا';
  const hindi = 'नमस्ते';
  fontsIn(t, { 'dejavusans.ttf': makeFont(`${arabic}${hindi}✓`) });
  const text = await textOf(markdownToPdf(`Arabic ${arabic} and Hindi ${hindi}, a check ✓, a face 😀, a rune ᚠ.\n`, 'x'));
  assert.match(text, /Arabic \[…\] and Hindi \[…\], a check ✓, a face \[…\], a rune \[…\]\./);
  assert.match(text, /Not shown in this PDF: Arabic, Devanagari, some emoji, some other characters\./);
  assert.doesNotMatch(text, /م|न/, 'never drawn letter by letter');
});

test('t47 pdf: Hebrew is written right to left, with numbers, brackets and Latin words in their own order', async (t) => {
  assert.equal(visualOrder('שלום'), 'םולש');
  assert.equal(visualOrder('(שלום)'), '(םולש)', 'brackets are mirrored');
  assert.equal(visualOrder('ב-2024'), '2024-ב', 'a number inside keeps its order');
  assert.equal(visualOrder('שָׁלוֹם').normalize('NFC'), 'םוֹלשָׁ'.normalize('NFC'), 'marks stay on their letter');
  fontsIn(t, { 'dejavusans.ttf': makeFont('שלום עולם זה מבחן של') });
  // A Hebrew paragraph: the whole line runs right to left; the Latin word and the number read left to right.
  const para = await textOf(markdownToPdf('שלום עולם, זה מבחן (2024) של PDF.\n', 'x'));
  assert.match(para, /\.PDF לש \(2024\) ןחבמ הז ,םלוע םולש/);
  // Hebrew words inside an English sentence: only they turn; the full stop stays at the end.
  const mixed = await textOf(markdownToPdf('The words שלום עולם mean hello world, and שלום. is peace.\n', 'x'));
  assert.match(mixed, /The words םלוע םולש mean hello world, and םולש\. is peace\./);
  assert.doesNotMatch(`${para}${mixed}`, /Not shown/);
});

test('t47 pdf: Chinese and Japanese text without spaces wraps inside the page; kana picks a Japanese font first', async (t) => {
  const zh = '中文文本没有空格所以需要在字符之间换行。';
  const ja = 'これは日本語の文章です。';
  fontsIn(t, { 'msyh.ttf': makeFont(`${zh}${ja}`), 'notosansjp-regular.ttf': makeFont(ja), 'malgun.ttf': makeFont('한국어') });
  const pdf = markdownToPdf(`${zh.repeat(12)}\n`, 'x');
  const s = checkFile(pdf);
  const lines = [...s.matchAll(/BT\n1 0 0 1 [\d.]+ [\d.]+ Tm\n([\s\S]*?)ET\n/g)].map((m) => [...m[1].matchAll(/<([0-9a-f]+)> Tj/g)].reduce((n, x) => n + x[1].length / 4, 0));
  assert.ok(lines.length >= 4, `lines: ${lines.length}`);
  // Each glyph of the test font is 600/1000 of the 10.5 pt size; the text width is 483 pt.
  for (const n of lines) assert.ok(n * 6.3 <= 483.01, `a line of ${n} characters fits`);
  assert.equal((await textOf(pdf)).replace(/\s+/g, ''), zh.repeat(12));
  assert.ok(!(await textOf(pdf)).split('\n').some((l) => l.startsWith('。')), 'no line starts with a full stop');
  assert.match(s, /\+msyh\b/);
  // Kana in the text: the Japanese font is tried before the Chinese one; Hangul finds the Korean font.
  const mixed = markdownToPdf(`${ja} 한국어\n`, 'x').toString('latin1');
  assert.match(mixed, /\+notosansjpregular\b/);
  assert.doesNotMatch(mixed, /\+msyh\b/);
  assert.match(mixed, /\+malgun\b/);
});

test('t47 pdf: a damaged font, a CFF font and a font that forbids embedding are passed over without a crash', async (t) => {
  const good = makeFont(RUSSIAN, { format4Only: true });
  const otto = Buffer.from(good);
  otto.write('OTTO', 0, 'latin1');
  fontsIn(t, {
    'segoeui.ttf': Buffer.from('this is not a font at all'),
    'arial.ttf': makeFont(RUSSIAN, { fsType: 0x0002 }),
    'dejavusans.ttf': otto,
    'liberationsans-regular.ttf': good.subarray(0, 200),
    'freesans.ttf': makeFont(RUSSIAN, { fsType: 0x0100 }),
  });
  assert.equal(parseFace(Buffer.alloc(0)), null);
  assert.equal(parseFace(makeFont(RUSSIAN, { fsType: 0x0002 })), null, 'restricted licence: not embedded');
  assert.ok(parseFace(makeFont(RUSSIAN, { fsType: 0x0008 })), 'editable embedding is allowed');
  let text = await textOf(markdownToPdf(`Russian ${RUSSIAN}.\n`, 'x'));
  assert.match(text, /Russian \[…\]\./);
  assert.match(text, /Not shown in this PDF: Cyrillic/);
  // The next font in the order that can be used is used (a format 4 character table).
  fontsIn(t, { 'segoeui.ttf': Buffer.from('junk'), 'tahoma.ttf': good });
  text = await textOf(markdownToPdf(`Russian ${RUSSIAN}.\n`, 'x'));
  assert.match(text, new RegExp(`Russian ${RUSSIAN}\\.`));
});

test('t47 pdf: a subset keeps glyph numbers, has a right checksum and joiners and style marks are dropped quietly', async (t) => {
  const face = parseFace(makeFont('абвгд', { composite: 'ё' }))!;
  const g = face.glyph('ё'.codePointAt(0)!);
  const sub = subsetFace(face, [g, 99_999]);
  assert.equal(sub.readUInt32BE(0), 0x00010000);
  let sum = 0;
  for (let i = 0; i + 4 <= sub.length; i += 4) sum = (sum + sub.readUInt32BE(i)) >>> 0;
  assert.equal(sum, 0xb1b0afba, 'the whole-file checksum');
  const lens = glyphLengths(sub);
  assert.equal(lens.length, face.numGlyphs);
  assert.deepEqual(lens.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0), [0, 1, g]);
  fontsIn(t, { 'seguisym.ttf': makeFont('✓👍') });
  // Thumbs up with a skin tone and the emoji style mark: the mark and tone are dropped, the sign is drawn.
  const text = await textOf(markdownToPdf('Done ✓\u{fe0f} and 👍\u{1f3fd}\u{200d} here.\n', 'x'));
  assert.match(text, /Done ✓ and 👍 here\./);
  assert.doesNotMatch(text, /Not shown/);
});

test('t47 pdf: with the fonts of this computer (skipped when it has none of the known ones)', async (t) => {
  assert.ok(fontDirs().length > 0);
  const fonts = new SystemFonts();
  const samples: [string, string][] = [['Greek', GREEK], ['Cyrillic', RUSSIAN], ['Japanese', '日本語'], ['Korean', '한국어'], ['Hebrew', 'שלום'], ['Thai', 'ไทย']];
  const have = samples.filter(([, s]) => cps(s).every((cp) => fonts.find(cp)));
  if (!have.length) return t.skip('no known font on this computer');
  const md = `# Report\n\n${have.map(([name, s]) => `${name}: ${s}.`).join(' ')} Arabic: مرحبا.\n`;
  const pdf = markdownToPdf(md, 'Report');
  checkFile(pdf);
  const text = await textOf(pdf);
  for (const [name, s] of have) assert.ok(text.includes(`${name}: ${name === 'Hebrew' ? visualOrder(s) : s}.`), `${name} reads back`);
  assert.match(text, /Not shown in this PDF: Arabic\./);
  assert.ok(pdf.length < 600_000, `only the glyphs used are embedded: ${pdf.length} bytes`);
  t.diagnostic(`drawn with this computer's fonts: ${have.map((x) => x[0]).join(', ')}; ${pdf.length} bytes`);
});

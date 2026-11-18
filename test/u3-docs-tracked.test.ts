// U3.15 (docs/DOCUMENTS.md "Tracked changes"): tracked changes beyond the body (headers, footers,
// footnotes, endnotes, text boxes), Word comments, moved paragraphs, and edits through a hyperlink or
// a simple field. Fixtures are hand-made OOXML (zipStored, like S7's); every result is checked for
// well-formed XML, ids unique across parts, rels and content types, and read back with the reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesOf, hasRevisions, listComments, listRevisions, resolveAll, reviseDocx } from '../src/documents/tracked.ts';
import { readDocx } from '../src/library/ooxml.ts';
import { Zip } from '../src/library/zip.ts';
import { contract } from './u3-docs-fixtures.ts';
import { strictXml } from './fill-fixtures.ts';
import { DEFAULT_LEAN, leanFor } from '../src/lean.ts';
import { createDocStudioTools } from '../src/tools/doc-studio.ts';
import { makeApp, tempDir } from './helpers.ts';

const date = new Date('2027-02-03T16:00:00Z');
const xmlParts = (buf: Buffer) => {
  const z = new Zip(buf);
  return z.all.filter((e) => e.name.endsWith('.xml') || e.name.endsWith('.rels')).map((e) => ({ name: e.name, xml: z.text(e.name) ?? '' }));
};
/** Every revision/comment/move-range id across every part: unique (Word repairs a file otherwise). */
function idsUnique(buf: Buffer): number {
  const ids: string[] = [];
  for (const { name, xml } of xmlParts(buf)) {
    if (!name.startsWith('word/') || name.includes('_rels')) continue;
    strictXml(xml);
    for (const m of xml.matchAll(/<w:(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart) w:id="(\d+)"/g)) ids.push(m[2]);
  }
  assert.equal(new Set(ids).size, ids.length, `ids unique: ${ids.join(',')}`);
  return ids.length;
}
const readText = (buf: Buffer) => readDocx(new Zip(buf)).parts.map((x) => x.text).join('\n');
const part = (buf: Buffer, name: string) => new Zip(buf).text(name) ?? '';

test('U3.15 tracked changes in the header, footer, footnote, endnote and a text box (both copies), same author/date', () => {
  const res = reviseDocx(
    contract(),
    [
      { find: 'Confidential draft', replace: 'Confidential' },
      { find: 'version 2', replace: 'version 3' },
      { find: 'sent monthly by email', replace: 'sent every two weeks by email' },
      { find: 'go to both parties', replace: 'go to each party' },
      { find: 'reviewed every year', replace: 'reviewed every six months' },
    ],
    { date },
  );
  assert.deepEqual(res.applied.map((a) => a.status), ['done', 'done', 'done', 'done', 'done'], JSON.stringify(res.applied));
  assert.ok(idsUnique(res.data) >= 10);
  for (const name of ['word/header1.xml', 'word/footer1.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    assert.match(part(res.data, name), /<w:(ins|del) w:id="\d+" w:author="Sara" w:date="2027-02-03T16:00:00Z">/, name);
  }
  // The text box is in the drawing (mc:Choice) and its VML copy (mc:Fallback): both are revised.
  const doc = part(res.data, 'word/document.xml');
  assert.equal(doc.match(/<w:delText xml:space="preserve">year<\/w:delText>/g)?.length, 2);
  assert.match(new Zip(res.data).text('word/settings.xml') ?? '', /<w:trackRevisions\/>/);
  // The review list knows where each change is.
  const revs = listRevisions(res.data);
  const where = new Set(revs.map((x) => x.where));
  for (const w of ['header', 'footer', 'footnote', 'endnote', 'textbox']) assert.ok(where.has(w as never), `${w} in ${[...where].join(',')}`);
  assert.ok(revs.some((x) => x.where === 'header' && x.type === 'del' && x.text.trim() === 'draft'));
  assert.equal(revs.filter((x) => x.where === 'textbox' && x.type === 'ins').length, 1, 'the fallback copy is not listed twice');
  // The reader (changes accepted) sees the new footnote, endnote and text box.
  const t = readText(res.data);
  assert.match(t, /sent every two weeks by email/);
  assert.match(t, /reviewed every six months/);
  assert.ok(hasRevisions(res.data));
  // Accept all and reject all cover every part.
  const acc = resolveAll(res.data, 'accept');
  assert.ok(!hasRevisions(acc.data));
  assert.match(part(acc.data, 'word/header1.xml'), /Confidential/);
  assert.doesNotMatch(part(acc.data, 'word/header1.xml'), /draft|<w:(ins|del)\b/);
  assert.match(part(acc.data, 'word/footer1.xml').replace(/<[^>]+>/g, ''), /version 3/);
  const rej = resolveAll(res.data, 'reject');
  assert.ok(!hasRevisions(rej.data));
  assert.match(part(rej.data, 'word/footer1.xml').replace(/<[^>]+>/g, ''), /version 2/);
  assert.match(readText(rej.data), /reviewed every year/);
  for (const b of [acc.data, rej.data]) idsUnique(b);
});

test('U3.15 the same words in two parts are ambiguous unless "all" is asked; ids keep counting across parts', () => {
  // "parties" is in the body and in the endnote.
  const twice = reviseDocx(contract(), [{ find: 'parties', replace: 'signers' }], { date });
  assert.equal(twice.applied[0].status, 'ambiguous');
  assert.equal(twice.revisions, 0);
  const all = reviseDocx(contract(), [{ find: 'parties', replace: 'signers', all: true }], { date });
  assert.equal(all.applied[0].status, 'done');
  assert.match(all.applied[0].detail ?? '', /2 places/);
  assert.deepEqual([...new Set(listRevisions(all.data).map((x) => x.where))].sort(), ['body', 'endnote']);
  idsUnique(all.data);
  const both = reviseDocx(contract(), [{ find: 'Either party', replace: 'Each party' }, { find: 'Client shall', replace: 'The Client shall' }], { date });
  assert.deepEqual(both.applied.map((a) => a.status), ['done', 'done']);
  const again = reviseDocx(both.data, [{ find: 'version 2', replace: 'version 4' }], { date });
  assert.equal(again.applied[0].status, 'done');
  idsUnique(again.data);
  // changesOf takes "all" for a find that is meant everywhere.
  assert.deepEqual(changesOf([{ find: 'a', replace: 'b', all: true }]), [{ find: 'a', replace: 'b', all: true }]);
});

test('U3.15 an edit across a hyperlink keeps the link (split runs) and an edit across a simple field keeps the field', () => {
  const res = reviseDocx(
    contract(),
    [
      { find: 'Details are on our pricing page and may change.', replace: 'Details are on our current pricing page and may change yearly.' },
      { find: 'This is page 3 of the agreement draft.', replace: 'This is page 3 of the final agreement.' },
    ],
    { date },
  );
  assert.deepEqual(res.applied.map((a) => a.status), ['done', 'done'], JSON.stringify(res.applied));
  idsUnique(res.data);
  const doc = part(res.data, 'word/document.xml');
  // The link is still there with its relationship id; the inserted word sits inside it with the link's style.
  const links = [...doc.matchAll(/<w:hyperlink r:id="rIdLink" w:history="1">([\s\S]*?)<\/w:hyperlink>/g)].map((m) => m[1]);
  assert.ok(links.length >= 1);
  assert.match(links.join(''), /<w:ins [^>]*><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">current <\/w:t>/);
  assert.match(doc, /<w:fldSimple w:instr=" PAGE "><w:r><w:t>3<\/w:t><\/w:r><\/w:fldSimple>/, 'the field is untouched');
  assert.equal(doc.match(/<w:fldSimple /g)?.length, 1);
  const t = readText(res.data);
  assert.match(t, /Details are on our current pricing page and may change yearly\./);
  assert.match(t, /This is page 3 of the final agreement\./);
  // Rejecting brings the old wording back with the link intact.
  const rej = resolveAll(res.data, 'reject');
  assert.match(readText(rej.data), /Details are on our pricing page and may change\./);
  assert.match(part(rej.data, 'word/document.xml'), /<w:hyperlink r:id="rIdLink"/);
  // Taking the field's own words out still keeps the field (it is the page number, not her text).
  const keep = reviseDocx(contract(), [{ find: 'This is page 3 of the agreement draft.', replace: 'This is the agreement draft.' }], { date });
  assert.equal(keep.applied[0].status, 'done');
  assert.match(part(keep.data, 'word/document.xml'), /<w:fldSimple w:instr=" PAGE ">/);
});

test('U3.15 comments: a note on the words instead of an edit; comments part, rels and content types are added', () => {
  const res = reviseDocx(contract(), [{ comment: 'Can we ask for 15 days instead? Please check the payment terms.', on: 'within 30 days of each invoice' }, { comment: 'x', on: 'not in the document' }], { date });
  assert.deepEqual(res.applied.map((a) => a.status), ['done', 'not_found']);
  assert.equal(res.comments, 1);
  idsUnique(res.data);
  const doc = part(res.data, 'word/document.xml');
  const id = /<w:commentRangeStart w:id="(\d+)"\/>/.exec(doc)?.[1];
  assert.ok(id);
  assert.match(doc, new RegExp(`<w:commentRangeStart w:id="${id}"/><w:r><w:t xml:space="preserve">within 30 days of each invoice</w:t></w:r><w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`));
  const comments = part(res.data, 'word/comments.xml');
  strictXml(comments);
  assert.match(comments, new RegExp(`<w:comment w:id="${id}" w:author="Sara" w:date="2027-02-03T16:00:00Z" w:initials="S">`));
  assert.match(comments, /<w:annotationRef\/>/);
  assert.match(part(res.data, 'word/_rels/document.xml.rels'), /relationships\/comments" Target="comments.xml"/);
  assert.match(part(res.data, '[Content_Types].xml'), /PartName="\/word\/comments.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.comments\+xml"/);
  // No tracked change was made, so the file has no revisions; the comment is listed with its anchor.
  assert.ok(!hasRevisions(res.data));
  const list = listComments(res.data);
  assert.deepEqual(list.map((c) => [c.author, c.anchor, c.text]), [['Sara', 'within 30 days of each invoice', 'Can we ask for 15 days instead? Please check the payment terms.']]);
  // The reader still reads the body (comments are not body text).
  assert.match(readText(res.data), /within 30 days of each invoice/);
  assert.doesNotMatch(readText(res.data), /Can we ask/);
  // Accept/reject all leaves comments alone (as Word does).
  const acc = resolveAll(res.data, 'accept');
  assert.equal(acc.resolved, 0);
});

test('U3.15 comments next to existing ones: commentsExtended and commentsIds get matching entries', () => {
  const res = reviseDocx(contract({ comments: true }), [{ comment: 'Ask about the payment terms.', on: 'Client shall pay the fee' }], { date });
  assert.equal(res.applied[0].status, 'done');
  idsUnique(res.data);
  const comments = part(res.data, 'word/comments.xml');
  strictXml(comments);
  const ids = [...comments.matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  const paraId = /<w:comment w:id="[1-9]\d*"[^>]*><w:p w14:paraId="([0-9A-F]{8})"/.exec(comments)?.[1];
  assert.ok(paraId, comments);
  assert.ok(parseInt(paraId, 16) < 0x80000000);
  const ext = part(res.data, 'word/commentsExtended.xml');
  strictXml(ext);
  assert.match(ext, new RegExp(`<w15:commentEx w15:paraId="${paraId}" w15:done="0"/>`));
  const cid = part(res.data, 'word/commentsIds.xml');
  strictXml(cid);
  assert.match(cid, new RegExp(`<w16cid:commentId w16cid:paraId="${paraId}" w16cid:durableId="[0-9A-F]{8}"/>`));
  const list = listComments(res.data);
  assert.deepEqual(list.map((c) => c.author), ['Pat Doe', 'Sara']);
  assert.equal(list[0].anchor, 'Governing law is Texas.');
  // Rels are not duplicated.
  assert.equal(part(res.data, 'word/_rels/document.xml.rels').match(/relationships\/comments"/g)?.length, 1);
});

test('U3.15 move: a paragraph moved is a moveFrom/moveTo pair with named ranges; accept and reject both read right', () => {
  const res = reviseDocx(contract(), [{ move: 'Either party may terminate', after: 'Consulting Agreement' }], { date });
  assert.deepEqual(res.applied.map((a) => a.status), ['done'], JSON.stringify(res.applied));
  idsUnique(res.data);
  const doc = part(res.data, 'word/document.xml');
  const name = /<w:moveFromRangeStart w:id="(\d+)" w:author="Sara" w:date="2027-02-03T16:00:00Z" w:name="(move\d+)"\/>/.exec(doc);
  assert.ok(name, doc);
  assert.match(doc, new RegExp(`<w:moveToRangeStart w:id="\\d+" w:author="Sara" w:date="2027-02-03T16:00:00Z" w:name="${name[2]}"/>`));
  assert.match(doc, new RegExp(`<w:moveFromRangeEnd w:id="${name[1]}"/>`));
  assert.match(doc, /<w:moveFrom w:id="\d+" w:author="Sara"[^>]*><w:r><w:t xml:space="preserve">Either party may terminate on 15 days notice\.<\/w:t>/);
  assert.match(doc, /<w:moveTo w:id="\d+" w:author="Sara"[^>]*><w:r><w:t xml:space="preserve">Either party may terminate/);
  // The moved-to copy comes right after the title.
  assert.ok(doc.indexOf('<w:moveTo ') < doc.indexOf('Client shall pay'));
  assert.ok(doc.indexOf('<w:moveFrom ') > doc.indexOf('Client shall pay'));
  // Paragraph marks are marked moved too (accept/reject leave no empty paragraph).
  assert.match(doc, /<w:rPr><w:moveFrom w:id="\d+"/);
  assert.match(doc, /<w:rPr><w:moveTo w:id="\d+"/);
  const revs = listRevisions(res.data);
  assert.deepEqual(revs.map((x) => x.type).sort(), ['moveFrom', 'moveTo']);
  assert.ok(revs.every((x) => /Either party may terminate/.test(x.text)));
  // The reader (accepted view) has it once, in the new place.
  const t = readText(res.data);
  assert.equal(t.match(/Either party may terminate/g)?.length, 1);
  assert.ok(t.indexOf('Either party') < t.indexOf('Client shall pay'));
  const acc = resolveAll(res.data, 'accept');
  const accDoc = part(acc.data, 'word/document.xml');
  assert.doesNotMatch(accDoc, /<w:move/);
  assert.equal(accDoc.match(/Either party may terminate/g)?.length, 1);
  assert.ok(accDoc.indexOf('Either party') < accDoc.indexOf('Client shall pay'));
  const rej = resolveAll(res.data, 'reject');
  const rejDoc = part(rej.data, 'word/document.xml');
  assert.doesNotMatch(rejDoc, /<w:move/);
  assert.equal(rejDoc.match(/Either party may terminate/g)?.length, 1);
  assert.ok(rejDoc.indexOf('Either party') > rejDoc.indexOf('Client shall pay'));
  for (const b of [acc.data, rej.data]) idsUnique(b);
  // "before" works too; moving a paragraph after itself is refused.
  const before = reviseDocx(contract(), [{ move: 'Governing law', before: 'Client shall pay' }], { date });
  assert.equal(before.applied[0].status, 'done');
  const self = reviseDocx(contract(), [{ move: 'Governing law', after: 'Governing law' }], { date });
  assert.equal(self.applied[0].status, 'invalid');
});

test('U3.15 changesOf: comment and move shapes; bad ones explained', () => {
  assert.deepEqual(changesOf([{ comment: 'Why?', on: 'payment terms' }, { move: 'a', after: 'b' }, { move: 'a', before: 'b' }]), [
    { comment: 'Why?', on: 'payment terms' },
    { move: 'a', after: 'b' },
    { move: 'a', before: 'b' },
  ]);
  assert.throws(() => changesOf([{ comment: 'x' }]), /comment/);
});

test('U3.15 lean: asking for a comment or a moved paragraph offers doc_revise (six languages)', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: date });
    const tools = createDocStudioTools(() => app);
    for (const text of ['Add a comment asking about the payment terms', 'leave a comment on the termination clause', 'Move the paragraph about termination after the title', 'añade un comentario sobre el pago', 'ajoute un commentaire sur le paiement', 'einen Kommentar zur Zahlung', 'deixe um comentário sobre o pagamento', 'sposta il paragrafo sulla risoluzione']) {
      const plan = leanFor({ ...DEFAULT_LEAN.tools, mode: 'always' }, tools, { text, mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1], permission: () => 'auto' });
      assert.ok(plan.isOffered('doc_revise'), text);
    }
  } finally {
    cleanup();
  }
});

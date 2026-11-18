// U3.15 fixture: a contract with a header, a footer, a footnote, an endnote, a text box (drawing plus
// its VML copy), a hyperlink and a simple field; optionally an existing comment with commentsExtended
// and commentsIds. Used by test/u3-docs-tracked.test.ts and the real-Word check.
import { zipStored } from '../src/zip-write.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS = `xmlns:w="${W}" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="w14 w15 wps"`;
const r = (t: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
const CT_W = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

function textBox(text: string): string {
  const inner = `<w:txbxContent>${p(r(text))}</w:txbxContent>`;
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="2000000" cy="500000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx>${inner}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape id="Text Box 1" style="width:157pt;height:39pt"><v:textbox>${inner}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
}

/** A contract with a header, a footer, a footnote, an endnote, a text box, a link and a field. */
export function contract(o: { comments?: boolean } = {}): Buffer {
  const body = [
    p(r('Consulting Agreement')),
    p(r('Client shall pay the fee within 30 days of each invoice.'), `<w:r><w:footnoteReference w:id="1"/></w:r>`),
    p(r('Details are on '), `<w:hyperlink r:id="rIdLink" w:history="1">${r('our pricing page', '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`, r(' and may change.')),
    p(r('This is page '), `<w:fldSimple w:instr=" PAGE "><w:r><w:t>3</w:t></w:r></w:fldSimple>`, r(' of the agreement draft.')),
    p(r('Either party may terminate on 15 days notice.')),
    p(r('Sidebar: '), textBox('Rates are reviewed every year.')),
    o.comments ? p(`<w:commentRangeStart w:id="0"/>`, r('Governing law is Texas.'), `<w:commentRangeEnd w:id="0"/>`, `<w:r><w:commentReference w:id="0"/></w:r>`) : p(r('Governing law is Texas.')),
    p(r('The parties sign below.'), `<w:r><w:endnoteReference w:id="1"/></w:r>`),
  ].join('');
  const sect = `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`;
  const doc = `${HEAD}<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`;
  const hdr = `${HEAD}<w:hdr ${NS}>${p(r('Acme Corp - Confidential draft'))}</w:hdr>`;
  const ftr = `${HEAD}<w:ftr ${NS}>${p(r('Northwind Studio LLC, version 2'))}</w:ftr>`;
  const sep = `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`;
  const fn = `${HEAD}<w:footnotes ${NS}>${sep}<w:footnote w:id="1">${p(r('Invoices are sent monthly by email.'))}</w:footnote></w:footnotes>`;
  const en = `${HEAD}<w:endnotes ${NS}>${sep.replace(/footnote/g, 'endnote')}<w:endnote w:id="1">${p(r('Signed copies go to both parties.'))}</w:endnote></w:endnotes>`;
  const overrides = [
    ['/word/document.xml', `${CT_W}.document.main+xml`],
    ['/word/header1.xml', `${CT_W}.header+xml`],
    ['/word/footer1.xml', `${CT_W}.footer+xml`],
    ['/word/footnotes.xml', `${CT_W}.footnotes+xml`],
    ['/word/endnotes.xml', `${CT_W}.endnotes+xml`],
  ];
  const rels = [
    ['rIdH1', 'header', 'header1.xml'],
    ['rIdF1', 'footer', 'footer1.xml'],
    ['rIdFn', 'footnotes', 'footnotes.xml'],
    ['rIdEn', 'endnotes', 'endnotes.xml'],
  ];
  const files: [string, string][] = [
    ['word/document.xml', doc],
    ['word/header1.xml', hdr],
    ['word/footer1.xml', ftr],
    ['word/footnotes.xml', fn],
    ['word/endnotes.xml', en],
  ];
  if (o.comments) {
    const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
    overrides.push(['/word/comments.xml', `${CT_W}.comments+xml`], ['/word/commentsExtended.xml', `${CT_W}.commentsExtended+xml`], ['/word/commentsIds.xml', `${CT_W}.commentsIds+xml`]);
    rels.push(['rIdC', 'comments', 'comments.xml'], ['rIdCx', 'commentsExtended', 'commentsExtended.xml'], ['rIdCi', 'commentsIds', 'commentsIds.xml']);
    files.push(
      ['word/comments.xml', `${HEAD}<w:comments ${NS}><w:comment w:id="0" w:author="Pat Doe" w:date="2026-12-01T10:00:00Z" w:initials="PD"><w:p w14:paraId="1A2B3C4D" w14:textId="77777777"><w:r><w:annotationRef/></w:r>${r('Is Texas right for us?')}</w:p></w:comment></w:comments>`],
      ['word/commentsExtended.xml', `${HEAD}<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w15:commentEx w15:paraId="1A2B3C4D" w15:done="0"/></w15:commentsEx>`],
      ['word/commentsIds.xml', `${HEAD}<w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="2B3C4D5E"/></w16cid:commentsIds>`],
    );
    void W14;
  }
  const ct = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([n, c]) => `<Override PartName="${n}" ContentType="${c}"/>`).join('')}</Types>`;
  const docRels = `${HEAD}<Relationships xmlns="${PKG}">${rels.map(([id, t, target]) => `<Relationship Id="${id}" Type="${REL}/${t}" Target="${target}"/>`).join('')}<Relationship Id="rIdLink" Type="${REL}/hyperlink" Target="https://example.com/pricing" TargetMode="External"/></Relationships>`;
  files.push(['[Content_Types].xml', ct], ['_rels/.rels', `${HEAD}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`], ['word/_rels/document.xml.rels', docRels]);
  return zipStored(files.map(([path, s]) => ({ path, data: Buffer.from(s, 'utf8') })), { deflate: true });
}


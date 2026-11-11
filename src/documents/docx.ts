// make_document → Word (.docx). WordprocessingML written by hand (no dependency) into a zip: real
// styles (Title, Heading 1–3, Quote, Code, Caption) so Word's navigation pane and table of contents
// work, real bullet and number lists (numbering.xml), tables with a repeated header row, pictures,
// page breaks and a page-number footer. Never a macro-enabled kind (.docm).
import { zipStored } from '../zip-write.ts';
import { type Block, plain, type Run } from './markdown.ts';
import { fitSize } from './images.ts';
import { docBlocks, type DocSpec, type ImageLookup, type Picture, sectionLevel } from './spec.ts';
import { THEMES } from './theme.ts';

export const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 12700; // per point

export function makeDocx(spec: DocSpec, image: ImageLookup): Buffer {
  const th = THEMES[spec.template];
  const half = (pt: number) => Math.round(pt * 2);
  const rels: string[] = [];
  const media: { path: string; data: Buffer }[] = [];
  const rid = (type: string, target: string, external = false) => {
    rels.push(`<Relationship Id="rId${rels.length + 10}" Type="${REL}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return `rId${rels.length + 9}`;
  };
  const linkIds = new Map<string, string>();
  const imageIds = new Map<string, { rid: string; p: Picture } | null>();
  let drawingId = 0;

  const run = (r: Run, extra = '') => {
    const pr = `${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ''}${r.href ? '<w:rStyle w:val="Hyperlink"/>' : ''}${extra}`;
    const t = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}${r.text.split('\n').map((s, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(s)}</w:t>`).join('')}</w:r>`;
    if (!r.href) return t;
    let id = linkIds.get(r.href);
    if (!id) linkIds.set(r.href, (id = rid('hyperlink', r.href, true)));
    return `<w:hyperlink r:id="${id}" w:history="1">${t}</w:hyperlink>`;
  };
  const runs = (rs: Run[], extra = '') => rs.map((r) => run(r, extra)).join('');
  const para = (body: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
  const style = (id: string) => `<w:pStyle w:val="${id}"/>`;

  const picture = (ref: string, alt: string, maxW: number, maxH: number) => {
    if (!imageIds.has(ref)) {
      const p = image(ref);
      if (!p || p.mime === 'image/webp') imageIds.set(ref, null);
      else {
        const ext = p.mime === 'image/jpeg' ? 'jpeg' : p.mime === 'image/png' ? 'png' : 'gif';
        const path = `media/image${media.length + 1}.${ext}`;
        media.push({ path: `word/${path}`, data: p.bytes });
        imageIds.set(ref, { rid: rid('image', path), p });
      }
    }
    const im = imageIds.get(ref);
    if (!im) return undefined;
    const { w, h } = fitSize(im.p, maxW, maxH);
    const cx = Math.round(w * EMU);
    const cy = Math.round(h * EMU);
    const id = ++drawingId;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xml(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${im.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  // Numbering: one bullet list definition; each numbered list gets its own instance (restarts at its first number).
  const nums: string[] = [];
  let listNum = 0;
  let prevBlock: Block | undefined;

  const pageW = 612;
  const textW = pageW - 2 * th.margin;
  const body: string[] = [];
  let first = true;
  for (const b of docBlocks(spec)) {
    switch (b.t) {
      case 'break':
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      case 'h': {
        const isTitle = first && b.level === 1 && spec.template !== 'letter';
        body.push(para(runs(b.runs), style(isTitle ? 'Title' : `Heading${sectionLevel(b.level)}`)));
        break;
      }
      case 'p':
        // A resume's contact line (right under the centered name) is centered too.
        if (b.runs.length) body.push(para(runs(b.runs), th.titleAlign === 'center' && prevBlock?.t === 'h' && prevBlock.level === 1 ? '<w:jc w:val="center"/>' : ''));
        break;
      case 'li': {
        let numId = 1;
        if (b.ordered) {
          // A new numbered list (not right after another item of one) gets its own numbering.
          if (!listNum || (prevBlock?.t === 'li' && !prevBlock.ordered && prevBlock.depth === b.depth)) {
            listNum = nums.length + 2;
            nums.push(`<w:num w:numId="${listNum}"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="${b.depth}"><w:startOverride w:val="${b.num}"/></w:lvlOverride></w:num>`);
          }
          numId = listNum;
        }
        body.push(para(runs(b.runs), `${style('ListParagraph')}<w:numPr><w:ilvl w:val="${b.depth}"/><w:numId w:val="${numId}"/></w:numPr>`));
        break;
      }
      case 'quote':
        body.push(para(runs(b.runs), style('Quote')));
        break;
      case 'code':
        body.push(para(b.text.split('\n').map((l, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xml(l)}</w:t></w:r>`).join(''), style('Code')));
        break;
      case 'hr':
        body.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr>'));
        break;
      case 'img': {
        const pic = picture(b.ref, b.alt, textW, 320);
        if (pic) {
          body.push(para(pic, '<w:jc w:val="center"/><w:keepNext/>'));
          if (b.alt) body.push(para(runs([{ text: b.alt }]), style('Caption')));
        } else if (b.alt) body.push(para(runs([{ text: `[${b.alt}]`, italic: true }])));
        break;
      }
      case 'table': {
        const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
        if (!cols) break;
        const tw = Math.round(textW * 20);
        const natural = Array.from({ length: cols }, (_, c) => Math.max(4, ...[b.head, ...b.rows].map((r) => Math.min(40, plain(r[c] ?? []).length))));
        const sum = natural.reduce((a, v) => a + v, 0);
        const widths = natural.map((v) => Math.round((v * tw) / sum));
        const cell = (rs: Run[] | undefined, w: number, head: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="${th.head}"/>` : ''}</w:tcPr>${para(runs(rs ?? [], head ? '<w:b/>' : ''), '<w:spacing w:before="40" w:after="40"/>')}</w:tc>`;
        const row = (r: Run[][], head: boolean) => `<w:tr>${head ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${widths.map((w, c) => cell(r[c], w, head)).join('')}</w:tr>`;
        const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`;
        body.push(`<w:tbl><w:tblPr><w:tblW w:w="${tw}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${row(b.head, true)}${b.rows.map((r) => row(r, false)).join('')}</w:tbl>`);
        body.push(para('', '<w:spacing w:after="60"/>'));
        break;
      }
    }
    if (b.t !== 'li') listNum = 0;
    if (b.t !== 'break') first = false;
    prevBlock = b;
  }

  const footer = th.pageNumbers !== 'never';
  const footerRid = footer ? rid('footer', 'footer1.xml') : '';
  const stylesRid = rid('styles', 'styles.xml');
  const numberingRid = rid('numbering', 'numbering.xml');
  void stylesRid;
  void numberingRid;
  const twip = (pt: number) => Math.round(pt * 20);
  const sect = `<w:sectPr>${footer ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${twip(th.margin)}" w:right="${twip(th.margin)}" w:bottom="${twip(th.margin)}" w:left="${twip(th.margin)}" w:header="708" w:footer="500" w:gutter="0"/></w:sectPr>`;
  const document = `${HEAD}<w:document ${NS}><w:body>${body.join('')}${sect}</w:body></w:document>`;

  const accent = th.accent;
  const pStyle = (id: string, name: string, size: number, o: { before?: number; after?: number; outline?: number; color?: string; bold?: boolean; caps?: boolean; center?: boolean; rule?: string; italic?: boolean; keep?: boolean } = {}) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>${o.keep !== false ? '<w:keepNext/><w:keepLines/>' : ''}${o.rule ? `<w:pBdr><w:bottom w:val="single" w:sz="${o.rule === accent ? 12 : 6}" w:space="4" w:color="${o.rule}"/></w:pBdr>` : ''}<w:spacing w:before="${o.before ?? 240}" w:after="${o.after ?? 80}"/>${o.center ? '<w:jc w:val="center"/>' : ''}${o.outline !== undefined ? `<w:outlineLvl w:val="${o.outline}"/>` : ''}</w:pPr><w:rPr>${o.bold !== false ? '<w:b/>' : ''}${o.italic ? '<w:i/>' : ''}${o.caps ? '<w:caps/>' : ''}<w:color w:val="${o.color ?? accent}"/><w:sz w:val="${half(size)}"/></w:rPr></w:style>`;
  const lvls = (fmt: 'bullet' | 'decimal') =>
    [0, 1, 2].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt === 'bullet' ? 'bullet' : i === 1 ? 'lowerLetter' : i === 2 ? 'lowerRoman' : 'decimal'}"/><w:lvlText w:val="${fmt === 'bullet' ? ['•', '–', '·'][i] : `%${i + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 + i * 360}" w:hanging="270"/></w:pPr>${fmt === 'bullet' ? `<w:rPr><w:color w:val="${accent}"/></w:rPr>` : ''}</w:lvl>`).join('');
  const styles = `${HEAD}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:color w:val="1F2937"/><w:sz w:val="${half(th.body + 0.5)}"/><w:szCs w:val="${half(th.body + 0.5)}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${twip(th.after + 2)}" w:line="${Math.round(240 * (th.lead - 0.12))}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + pStyle('Title', 'Title', th.title + 2, { before: 0, after: th.titleRule ? 240 : 160, color: '111827', center: th.titleAlign === 'center', ...(th.titleRule ? { rule: accent } : {}) })
    + pStyle('Heading1', 'heading 1', th.h1 + 1, { outline: 0, caps: th.sectionRule, ...(th.sectionRule ? { rule: 'B6C2D1', before: 200 } : {}) })
    + pStyle('Heading2', 'heading 2', th.h2 + 0.5, { outline: 1, before: th.sectionRule ? 140 : 200 })
    + pStyle('Caption', 'caption', th.body - 1, { before: 40, after: 160, color: th.muted, bold: false, italic: true, center: true, keep: false })
    + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="${twip(Math.max(2, th.after / 2))}"/><w:contextualSpacing/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${accent}"/></w:pBdr><w:ind w:left="284"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>`
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="17"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0B5CAD"/><w:u w:val="single"/></w:rPr></w:style></w:styles>';
  const numbering = `${HEAD}<w:numbering ${NS}><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>${nums.join('')}</w:numbering>`;
  const fld = (instr: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const footerXml = `${HEAD}<w:ftr ${NS}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>${fld('PAGE')}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${fld('NUMPAGES')}</w:p></w:ftr>`;

  const types = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const files: [string, string | Buffer][] = [
    ['[Content_Types].xml', types],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', coreXml(spec.title)],
    ['docProps/app.xml', appXml()],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ...(footer ? ([['word/footer1.xml', footerXml]] as [string, string][]) : []),
    ['word/_rels/document.xml.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`],
    ...media.map((m) => [m.path, m.data] as [string, Buffer]),
  ];
  return zipStored(files.map(([path, s]) => ({ path, data: typeof s === 'string' ? Buffer.from(s, 'utf8') : s })), { deflate: true });
}

export const coreXml = (title: string) => `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Sara</dc:creator></cp:coreProperties>`;
export const appXml = () => `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Sara</Application></Properties>`;

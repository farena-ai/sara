// make_document → PowerPoint (.pptx). PresentationML by hand (no dependency), 16:9: an opening
// slide in the accent colour, then one slide per heading with its title, bullets (nested, bold,
// italic, links), an optional picture on the right, speaker notes and a slide number. The text is
// sized to fit its box. Never .pptm.
import { zipStored } from '../zip-write.ts';
import { appXml, coreXml, xml } from './docx.ts';
import { fitSize } from './images.ts';
import type { Run } from './markdown.ts';
import { type DocSpec, type ImageLookup, type Slide, slidesOf } from './spec.ts';
import { THEMES } from './theme.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const IN = 914400;
const SW = 12192000;
const SH = 6858000;
const PT = 12700;
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

function theme(accent: string): string {
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = (w: number) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  const font = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
  return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Sara"><a:themeElements><a:clrScheme name="Sara"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${accent}"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="${accent}"/></a:accent1><a:accent2><a:srgbClr val="3B82F6"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6><a:hlink><a:srgbClr val="0B5CAD"/></a:hlink><a:folHlink><a:srgbClr val="6B21A8"/></a:folHlink></a:clrScheme><a:fontScheme name="Sara"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Sara"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

interface Ctx {
  rels: string[];
  rid: (type: string, target: string, external?: boolean) => string;
  id: number;
}

const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
function runXml(c: Ctx, r: Run, size: number, hex: string): string {
  const link = r.href ? `<a:hlinkClick r:id="${c.rid('hyperlink', r.href, true)}"/>` : '';
  return `<a:r><a:rPr lang="en-US" sz="${Math.round(size * 100)}"${r.bold ? ' b="1"' : ''}${r.italic ? ' i="1"' : ''}${r.href ? ' u="sng"' : ''} dirty="0">${solid(r.href ? '0B5CAD' : hex)}${r.code ? '<a:latin typeface="Consolas"/>' : ''}${link}</a:rPr><a:t>${xml(r.text.replace(/\n/g, ' '))}</a:t></a:r>`;
}
function box(c: Ctx, name: string, x: number, y: number, w: number, h: number, paras: string, anchor: 't' | 'ctr' | 'b' = 't'): string {
  const id = ++c.id;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)} ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}
function rect(c: Ctx, x: number, y: number, w: number, h: number, hex: string): string {
  const id = ++c.id;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solid(hex)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}
const textOf = (runs: Run[]) => runs.map((r) => r.text).join('');

/** A font size (points) at which the lines fit the box (rough: average character width ½ em). */
function fitFont(lines: { text: string; depth: number }[], w: number, h: number, start: number, min: number): number {
  for (let size = start; size > min; size -= 1) {
    const perLine = (w / PT) / (size * 0.5);
    const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.text.length + 2) / Math.max(8, perLine - l.depth * 3))), 0);
    if (rows * size * 1.25 + lines.length * size * 0.35 <= h / PT) return size;
  }
  return min;
}

function slideXml(c: Ctx, s: Slide, i: number, count: number, accent: string, pic?: { rid: string; w: number; h: number; alt: string }): string {
  const shapes: string[] = [];
  const M = 0.6 * IN;
  if (s.cover) {
    shapes.push(rect(c, 0, 0, SW, SH, accent));
    const ts = fitFont([{ text: s.title, depth: 0 }], SW - 2 * IN, 2.2 * IN, 44, 24);
    shapes.push(box(c, 'Title', IN, 1.7 * IN, SW - 2 * IN, 2.4 * IN, `<a:p><a:pPr algn="ctr"/>${runXml(c, { text: s.title, bold: true }, ts, 'FFFFFF')}</a:p>`, 'b'));
    if (s.subtitle) shapes.push(box(c, 'Subtitle', IN, 4.35 * IN, SW - 2 * IN, 1.3 * IN, `<a:p><a:pPr algn="ctr"/>${runXml(c, { text: s.subtitle }, 20, 'E5E7EB')}</a:p>`));
    if (s.lines.length) shapes.push(box(c, 'Text', IN, 5.2 * IN, SW - 2 * IN, 1.4 * IN, s.lines.map((l) => `<a:p><a:pPr algn="ctr"/>${l.runs.map((r) => runXml(c, r, 16, 'E5E7EB')).join('')}</a:p>`).join('')));
  } else {
    shapes.push(rect(c, 0, 0, SW, 0.12 * IN, accent));
    const ts = fitFont([{ text: s.title, depth: 0 }], SW - 2 * M, 0.95 * IN, 32, 20);
    if (s.title) shapes.push(box(c, 'Title', M, 0.42 * IN, SW - 2 * M, 1.0 * IN, `<a:p>${runXml(c, { text: s.title, bold: true }, ts, '111827')}</a:p>`, 'ctr'));
    shapes.push(rect(c, M, 1.5 * IN, 1.1 * IN, 0.05 * IN, accent));
    const bodyW = pic ? 6.9 * IN : SW - 2 * M;
    const bodyH = 5.0 * IN;
    if (s.lines.length) {
      const size = fitFont(s.lines.map((l) => ({ text: textOf(l.runs), depth: l.depth })), bodyW, bodyH, 22, 11);
      const paras = s.lines.map((l) => {
        const sz = Math.max(10, size - l.depth * 2);
        const indent = Math.round((0.32 + l.depth * 0.35) * IN);
        const ppr = l.bullet ? `<a:pPr marL="${indent}" indent="-${Math.round(0.3 * IN)}"><a:spcBef><a:spcPts val="${Math.round(size * 45)}"/></a:spcBef><a:buClr><a:srgbClr val="${accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${l.depth ? '–' : '•'}"/></a:pPr>` : `<a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="${Math.round(size * 45)}"/></a:spcBef><a:buNone/></a:pPr>`;
        return `<a:p>${ppr}${l.runs.map((r) => runXml(c, r, sz, '1F2937')).join('') || `<a:endParaRPr lang="en-US" sz="${sz * 100}"/>`}</a:p>`;
      });
      shapes.push(box(c, 'Text', M, 1.8 * IN, bodyW, bodyH, paras.join('')));
    }
    if (pic) {
      const area = { x: (s.lines.length ? 7.85 : 0.6) * IN, w: (s.lines.length ? 4.85 : 12.13) * IN, y: 1.8 * IN, h: 5.0 * IN };
      const { w, h } = fitSize({ width: pic.w, height: pic.h }, area.w / PT, area.h / PT);
      const id = ++c.id;
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${xml(pic.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${pic.rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(area.x + (area.w - w * PT) / 2)}" y="${Math.round(area.y)}"/><a:ext cx="${Math.round(w * PT)}" cy="${Math.round(h * PT)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
    }
    shapes.push(box(c, 'Slide Number', SW - 1.6 * IN, SH - 0.5 * IN, 1.0 * IN, 0.3 * IN, `<a:p><a:pPr algn="r"/>${runXml(c, { text: `${i + 1} / ${count}` }, 10, '9CA3AF')}</a:p>`));
  }
  return `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export function makePptx(spec: DocSpec, image: ImageLookup): Buffer {
  const slides = slidesOf(spec);
  const accent = THEMES[spec.template].accent;
  const files: [string, string | Buffer][] = [];
  const media: [string, Buffer][] = [];
  const mediaOf = new Map<string, { path: string; w: number; h: number } | null>();
  const hasNotes = slides.some((s) => s.notes?.trim());
  slides.forEach((s, i) => {
    const rels: string[] = [];
    const c: Ctx = {
      rels,
      id: 1,
      rid: (type, target, external = false) => {
        rels.push(`<Relationship Id="rId${rels.length + 1}" Type="${REL}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`);
        return `rId${rels.length}`;
      },
    };
    c.rid('slideLayout', '../slideLayouts/slideLayout1.xml');
    let pic: { rid: string; w: number; h: number; alt: string } | undefined;
    if (s.image) {
      if (!mediaOf.has(s.image)) {
        const p = image(s.image);
        if (p && p.mime !== 'image/webp') {
          const path = `media/image${media.length + 1}.${p.mime === 'image/jpeg' ? 'jpeg' : p.mime === 'image/png' ? 'png' : 'gif'}`;
          media.push([`ppt/${path}`, p.bytes]);
          mediaOf.set(s.image, { path, w: p.width, h: p.height });
        } else mediaOf.set(s.image, null);
      }
      const m = mediaOf.get(s.image);
      if (m) pic = { rid: c.rid('image', `../${m.path}`), w: m.w, h: m.h, alt: s.title };
    }
    const body = slideXml(c, s, i, slides.length, accent, pic);
    if (s.notes?.trim()) {
      c.rid('notesSlide', `../notesSlides/notesSlide${i + 1}.xml`);
      const paras = s.notes.split('\n').map((l) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(l)}</a:t></a:r></a:p>`).join('');
      files.push([`ppt/notesSlides/notesSlide${i + 1}.xml`, `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`]);
      files.push([`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${i + 1}.xml"/></Relationships>`]);
    }
    files.push([`ppt/slides/slide${i + 1}.xml`, body]);
    files.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`]);
  });

  const presRels = [
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId3" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="rId4" Type="${REL}/viewProps" Target="viewProps.xml"/>`,
    `<Relationship Id="rId5" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
    ...(hasNotes ? [`<Relationship Id="rId6" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`] : []),
    ...slides.map((_, i) => `<Relationship Id="rId${i + 10}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`),
  ];
  const presentation = `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`;
  const master = `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld>${CLRMAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
  const layout = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const notesMaster = `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld>${CLRMAP}</p:notesMaster>`;
  const rel = (items: string[]) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
  const ct = (part: string, type: string) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`;
  const types = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>${ct('/ppt/presentation.xml', 'presentationml.presentation.main+xml')}${ct('/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml')}${ct('/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml')}${ct('/ppt/theme/theme1.xml', 'theme+xml')}${ct('/ppt/presProps.xml', 'presentationml.presProps+xml')}${ct('/ppt/viewProps.xml', 'presentationml.viewProps+xml')}${ct('/ppt/tableStyles.xml', 'presentationml.tableStyles+xml')}${hasNotes ? `${ct('/ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster+xml')}${ct('/ppt/theme/theme2.xml', 'theme+xml')}` : ''}${slides.map((s, i) => `${ct(`/ppt/slides/slide${i + 1}.xml`, 'presentationml.slide+xml')}${s.notes?.trim() ? ct(`/ppt/notesSlides/notesSlide${i + 1}.xml`, 'presentationml.notesSlide+xml') : ''}`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${ct('/docProps/app.xml', 'extended-properties+xml')}</Types>`;
  const all: [string, string | Buffer][] = [
    ['[Content_Types].xml', types],
    ['_rels/.rels', rel([`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`, '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>', `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`])],
    ['docProps/core.xml', coreXml(spec.title)],
    ['docProps/app.xml', appXml()],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', rel(presRels)],
    ['ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`],
    ['ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`],
    ['ppt/tableStyles.xml', `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
    ['ppt/slideMasters/slideMaster1.xml', master],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rel([`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`, `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/>`])],
    ['ppt/slideLayouts/slideLayout1.xml', layout],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rel([`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`])],
    ['ppt/theme/theme1.xml', theme(accent)],
    ...(hasNotes
      ? ([
          ['ppt/notesMasters/notesMaster1.xml', notesMaster],
          ['ppt/notesMasters/_rels/notesMaster1.xml.rels', rel([`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`])],
          ['ppt/theme/theme2.xml', theme(accent)],
        ] as [string, string][])
      : []),
    ...files,
    ...media,
  ];
  return zipStored(all.map(([path, s]) => ({ path, data: typeof s === 'string' ? Buffer.from(s, 'utf8') : s })), { deflate: true });
}

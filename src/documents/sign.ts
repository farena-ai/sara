// S7 (docs/DOCUMENTS.md "Ready to sign"): the final Word file as a PDF made to be signed, with the
// existing PDF maker (src/documents/pdf.ts): the text, page numbers on every page, and for each signer
// a signature field, a name field and a date field (real AcroForm fields a PDF reader can sign or
// type into). Before it is made, a "Ready to sign" check: no placeholders left, no tracked changes
// left; after, the fields and page numbers are read back from the PDF itself.
import { attr, find, kid, kids, textOf, type XmlElement } from '../library/xml.ts';
import { makePdf } from './pdf.ts';
import { readPdfForm } from './pdf-form.ts';
import { detectPlaceholders } from './placeholders.ts';
import { DocError, type DocSpec } from './spec.ts';
import { hasRevisions, listRevisions, openDocx } from './tracked.ts';

const esc = (s: string) => s.replace(/([\\`*_{}[\]#|>])/g, '\\$1');

/** The visible text of a run container, with every tracked change accepted. */
function runsText(el: XmlElement): string {
  let s = '';
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.local === 't') s += textOf(c);
    else if (c.local === 'tab') s += ' ';
    else if (c.local === 'br' || c.local === 'cr') s += '\n';
    else if (['del', 'delText', 'pPr', 'rPr', 'instrText', 'footnoteReference', 'endnoteReference'].includes(c.local)) continue;
    else s += runsText(c);
  }
  return s;
}

function headingLevel(p: XmlElement): number {
  const pPr = kid(p, 'pPr');
  const style = (attr(kid(pPr, 'pStyle'), 'val') ?? '').toLowerCase().replace(/\s+/g, '');
  if (style === 'title') return 1;
  const m = /^heading(\d)$/.exec(style);
  if (m) return Math.min(4, Number(m[1]) + 1);
  const o = attr(kid(pPr, 'outlineLvl'), 'val');
  if (o !== undefined && Number(o) < 3) return Number(o) + 2;
  return 0;
}

/** A Word file as Markdown for the PDF maker: headings, lists, tables and paragraphs (changes accepted). */
export function docxToMarkdown(bytes: Buffer): string {
  const d = openDocx(bytes);
  const body = find(d.doc, 'body');
  const out: string[] = [];
  const walk = (el: XmlElement | undefined) => {
    for (const c of kids(el)) {
      if (c.local === 'p') {
        const text = runsText(c).replace(/[ \t]+/g, ' ').trim();
        if (!text) continue;
        const lvl = headingLevel(c);
        const list = Boolean(kid(kid(c, 'pPr'), 'numPr'));
        const lines = text.split('\n').map((l) => esc(l.trim()));
        out.push(lvl ? `${'#'.repeat(lvl)} ${lines.join(' ')}` : list ? `- ${lines.join(' ')}` : lines.join('  \n'));
      } else if (c.local === 'tbl') {
        const rows = kids(c, 'tr').map((tr) => kids(tr, 'tc').map((tc) => kids(tc, 'p').map((p) => runsText(p).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').replace(/\|/g, '\\|')));
        if (!rows.length || !rows.some((r) => r.some(Boolean))) continue;
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => esc(r[i] ?? '').replace(/\\\|/g, '\\|')).join(' | ')} |`;
        out.push([line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n'));
      } else if (['sdt', 'sdtContent', 'customXml', 'ins'].includes(c.local)) walk(c);
    }
  };
  walk(body);
  return out.join('\n\n');
}

/** Plain text of a Word file (changes accepted), for checks. */
export function docxPlainText(bytes: Buffer): string {
  return docxToMarkdown(bytes).replace(/\\([\\`*_{}[\]#|>])/g, '$1').replace(/^#+ /gm, '');
}

export interface SignCheck {
  id: 'placeholders' | 'tracked' | 'fields' | 'pages';
  ok: boolean;
  detail: string;
}
export interface Signer {
  party: string;
  name?: string;
  title?: string;
}

/** Signers from the model's list, or the parties named in the document ("between A and B"). */
export function signersOf(v: unknown, text: string): Signer[] {
  const list = Array.isArray(v) ? v : [];
  const out: Signer[] = [];
  for (const s of list.slice(0, 8)) {
    const o = typeof s === 'string' ? { party: s } : ((s ?? {}) as Record<string, unknown>);
    const clean = (x: unknown) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '');
    const party = clean(o.party ?? o.name);
    if (party) out.push({ party, ...(clean(o.name) && clean(o.name) !== party ? { name: clean(o.name) } : {}), ...(clean(o.title) ? { title: clean(o.title) } : {}) });
  }
  if (out.length) return out;
  const m = /\bbetween\s+(.{2,80}?)\s*(?:\([^)]{0,40}\))?,?\s+and\s+(.{2,80}?)\s*(?:\([^)]{0,40}\))?(?:[.,;]|$)/im.exec(text.slice(0, 3000));
  if (m) return [m[1], m[2]].map((p) => ({ party: p.replace(/^(?:the\s+)?/i, '').replace(/[,\s]+$/, '').trim() }));
  return [{ party: 'Signer' }];
}

/**
 * The signature-ready PDF of a final Word file, with the Ready to sign check. Not ready (placeholders
 * or tracked changes left): no PDF, unless `draft` asks for one anyway (marked not ready).
 */
export function makeSignPdf(o: { docx: Buffer; title: string; signers: Signer[]; draft?: boolean }): { data?: Buffer; ready: boolean; checks: SignCheck[]; pages: number } {
  const md = docxToMarkdown(o.docx);
  if (!md.trim()) throw new DocError('That Word file has no text to make a PDF from.');
  const plain = docxPlainText(o.docx);
  const left = detectPlaceholders(plain).filter((p) => p.kind !== 'signature');
  const tracked = hasRevisions(o.docx);
  const revs = tracked ? listRevisions(o.docx).length : 0;
  const checks: SignCheck[] = [
    { id: 'placeholders', ok: !left.length, detail: left.length ? `Placeholders left: ${left.slice(0, 12).map((p) => p.label).join(', ')}` : 'No placeholders left.' },
    { id: 'tracked', ok: !tracked, detail: tracked ? `${revs || 'Some'} tracked changes are still in the Word file: accept or reject them first (Word: Review → Accept / Reject, or ask her to accept them).` : 'No tracked changes left.' },
  ];
  if (!checks.every((c) => c.ok) && !o.draft) return { ready: false, checks, pages: 0 };
  // The title is the document's own first heading when it has one (not printed twice).
  // The document's own blank signature lines ("Signature: ____ Date: ____") give way to the real fields.
  const body = md
    .split('\n\n')
    .filter((b) => !/^(?:\s*(?:signature|signed|sign here|by|name|printed name|title|date|initials?)\s*:?\s*(?:\\_){3,}\s*)+$/i.test(b.replace(/\s{2}\n/g, ' ')))
    .join('\n\n');
  const spec: DocSpec = { format: 'pdf', title: o.title, template: 'report', content: /^# /.test(body) ? body : `# ${esc(o.title)}\n\n${body}`, sign: { signers: o.signers } };
  const data = makePdf(spec, () => undefined);
  const form = readPdfForm(data);
  const sigs = form.fields.filter((f) => f.kind === 'signature').length;
  const dates = form.fields.filter((f) => f.kind === 'text' && /^Date /.test(f.name)).length;
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(data.toString('latin1'))?.[1] ?? 0);
  const numbered = (data.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length === pages && pages > 0;
  checks.push({ id: 'fields', ok: sigs === o.signers.length && dates === o.signers.length, detail: `${sigs} signature ${sigs === 1 ? 'field' : 'fields'} and ${dates} date ${dates === 1 ? 'field' : 'fields'} for ${o.signers.length} ${o.signers.length === 1 ? 'signer' : 'signers'}.` });
  checks.push({ id: 'pages', ok: numbered, detail: `${pages} ${pages === 1 ? 'page' : 'pages'}, numbered “1 / ${pages}” at the foot of each.` });
  return { data, ready: checks.every((c) => c.ok), checks, pages };
}

export { DocError };

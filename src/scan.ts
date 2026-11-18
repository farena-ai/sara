// V2.5 Snap and file (docs/design/SNAP.md). Pages photographed with the phone app or a browser's
// camera are cropped, straightened and shrunk in the page (web/scan-math.js, web/scan.js), then sent
// here as one scan. They become ONE PDF (a page per picture, no text layer) kept in the Library
// through the usual reader: every page is a scanned page for the picture model (the same local-first
// rule and cloud question as any scanned PDF), and src/facts.ts finds its dates like for any other
// document, so renewals, purchases and Today pick it up with no extra wiring.
//   POST /api/library/scan {pages: [data URL…], title?, learn?}   → 201 {doc} (200 {doc, already} for the same scan)
//   GET  /api/library/scan/:id                                    → {doc, pages, text, facts, suggestions}
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './chat.ts';
import { measure, pdfImage, type PdfImage } from './documents/images.ts';
import { factsFor } from './facts.ts';
import { HttpError, readJson, send } from './http.ts';
import { en } from './i18n.ts';
import type { LibraryDoc } from './library/store.ts';

/** Pages in one scan (a long contract fits; a book goes through Add documents). */
export const SCAN_MAX_PAGES = 30;
/** One page picture (decoded bytes). The page sends ~0.3-1 MB JPEGs at 2000 px. */
export const SCAN_PAGE_MAX_BYTES = 3_000_000;
/** The request body cap: every page at its largest, base64, plus a little JSON. */
export const SCAN_MAX_BODY = Math.ceil((SCAN_MAX_PAGES * SCAN_PAGE_MAX_BYTES * 4) / 3 / 2) + 64_000;

export class ScanError extends HttpError {}

export interface ScanPage {
  mime: 'image/jpeg' | 'image/png';
  data: Buffer;
}

const MAGIC: Record<ScanPage['mime'], (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

/** One page: a JPEG or PNG data URL whose bytes match its type, at most SCAN_PAGE_MAX_BYTES. */
export function parseScanPage(raw: unknown): ScanPage {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(raw ?? ''));
  if (!m) throw new ScanError(400, en('A scanned page must be a JPEG or PNG picture.'));
  if ((m[2].length * 3) / 4 > SCAN_PAGE_MAX_BYTES + 3) throw new ScanError(413, en('A scanned page is too large. Scan it again.'));
  const data = Buffer.from(m[2], 'base64');
  const mime = m[1] as ScanPage['mime'];
  if (!MAGIC[mime](data) || !measure(data)) throw new ScanError(400, en('A scanned page must be a JPEG or PNG picture.'));
  return { mime, data };
}

const pdfText = (s: string) => s.replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * The pages as one PDF: a page per picture at the picture's shape (612 pt wide, a long page at most
 * 1008 pt tall), nothing else on it. No dates inside, so the same scan makes the same file.
 */
export function scanPdf(pages: ScanPage[], o: { title?: string } = {}): Buffer {
  const objs: (string | Buffer)[] = [];
  const add = (o: string | Buffer) => objs.push(o) && objs.length;
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  const catalog = add('');
  const tree = add('');
  const info = add(`<< /Producer (Sara)${o.title ? ` /Title (${pdfText(o.title)})` : ''} >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const pic = measure(p.data);
    const img: PdfImage | undefined = pic && pdfImage(pic);
    if (!img) throw new ScanError(400, en('A scanned page must be a JPEG or PNG picture.'));
    let w = 612;
    let h = (612 * img.height) / img.width;
    if (h > 1008) {
      w = (w * 1008) / h;
      h = 1008;
    }
    const W = w.toFixed(2);
    const H = h.toFixed(2);
    const mask = img.mask ? add(stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.mask.dict}`, img.mask.data)) : 0;
    const im = add(stream(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${img.dict}${mask ? ` /SMask ${mask} 0 R` : ''}`, img.data));
    const content = add(stream('', Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q`, 'latin1')));
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${content} 0 R /Resources << /XObject << /Im1 ${im} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(at);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    at += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** "Scan 2026-11-18 09.00.pdf" in the owner's time zone, or the name the person gave it. */
export function scanName(at: Date, timeZone: string | undefined, title?: string): string {
  const given = String(title ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '').slice(0, 80);
  if (given) return `${given}.pdf`;
  let p: Record<string, string>;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  } catch {
    return scanName(at, 'UTC');
  }
  return `Scan ${p.year}-${p.month}-${p.day} ${p.hour}.${p.minute}.pdf`;
}

/** Keeps a scan in the Library (once: the same pages again give the copy already there). */
export function takeScan(app: AppContext, pages: ScanPage[], o: { title?: string; learn?: boolean } = {}): { doc: LibraryDoc; already: boolean } {
  const lib = app.library;
  if (!lib) throw new HttpError(404, 'The library is not available');
  if (!pages.length) throw new ScanError(400, en('Take a picture of at least one page.'));
  if (pages.length > SCAN_MAX_PAGES) throw new ScanError(400, en('A scan can have up to {n} pages.'), { params: { n: SCAN_MAX_PAGES } });
  const bytes = scanPdf(pages, { title: o.title?.trim() || undefined });
  const had = lib.findKept(bytes);
  if (had) return { doc: had, already: true };
  const doc = lib.add({ name: scanName(app.now?.() ?? new Date(), app.settings.get().timeZone, o.title), bytes, keep: true, origin: 'scan', learn: o.learn !== false });
  app.libraryNudge?.();
  app.events?.publish({ type: 'library', id: doc.id });
  return { doc, already: false };
}

/** What the scan view shows after saving: how the reading goes, the text read, the facts found. */
export function scanView(app: AppContext, doc: LibraryDoc) {
  const lib = app.library!;
  const text = doc.status === 'ready' ? lib.passages(doc.id, { limit: 12 }).map((p) => ({ page: p.page, text: p.text.slice(0, 600) })) : [];
  const facts = doc.status === 'ready' ? factsFor(app).list().filter((f) => f.source.kind === 'document' && f.source.docId === doc.id && f.group !== 'dates') : [];
  const suggestions = doc.status === 'ready' ? factsFor(app).suggestions({ status: 'all', limit: 500 }).filter((s) => s.docId === doc.id) : [];
  return { pages: doc.pages, text, facts, suggestions };
}

/** `/api/library/scan[/:id]`, called from the library routes (src/routes/library.ts). */
export async function scanRoute(app: AppContext, req: IncomingMessage, res: ServerResponse, method: string, id: string | undefined, docView: (d: LibraryDoc) => unknown): Promise<void> {
  const lib = app.library!;
  if (!id && method === 'POST') {
    const body = await readJson(req, SCAN_MAX_BODY);
    const raw = Array.isArray(body.pages) ? body.pages : [];
    if (!raw.length) throw new ScanError(400, en('Take a picture of at least one page.'));
    if (raw.length > SCAN_MAX_PAGES) throw new ScanError(400, en('A scan can have up to {n} pages.'), { params: { n: SCAN_MAX_PAGES } });
    const r = takeScan(app, raw.map(parseScanPage), { title: typeof body.title === 'string' ? body.title : undefined, learn: body.learn !== false });
    return send(res, r.already ? 200 : 201, { doc: docView(r.doc), ...(r.already ? { already: true } : {}) });
  }
  if (id && /^\d+$/.test(id) && method === 'GET') {
    const doc = lib.get(Number(id));
    if (!doc || !doc.keep) throw new HttpError(404, 'Not found');
    return send(res, 200, { doc: docView(doc), ...scanView(app, doc) });
  }
  throw new HttpError(405, 'Method not allowed');
}

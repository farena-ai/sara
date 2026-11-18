// V2.5 Snap and file (docs/design/SNAP.md): pages from the phone or browser camera are cropped and
// straightened in the page (web/scan-math.js), sent as one scan, made into one PDF and kept in the
// Library through the usual reading, so facts.ts finds its dates like for any document.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { OwnerAuth } from '../src/auth.ts';
import { closeAllPagers } from '../src/library/bigread.ts';
import { readDocument } from '../src/library/read.ts';
import { LibraryStore } from '../src/library/store.ts';
import { readOne } from '../src/library/worker.ts';
import { parseScanPage, SCAN_MAX_PAGES, scanName, scanPdf, ScanError, takeScan } from '../src/scan.ts';
import { createSaraServer } from '../src/server.ts';
// @ts-expect-error plain JS module shared with the browser
import { findPageQuad, skewAngle, warpQuad, toGray, outSize, rotateRgba } from '../web/scan-math.js';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const LOCAL = { id: 'p', label: 'Ollama here', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:9/v1' };

/** A grey PNG drawn by `shade(x, y)` (0-255). */
function png(w: number, h: number, shade: (x: number, y: number) => number): Buffer {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = shade(x, y);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A fake "page photo": light paper with a few dark lines, page number n as line count. */
const pagePng = (n: number) => png(600, 800, (x, y) => (y > 100 && y < 100 + n * 40 && y % 40 < 6 && x > 60 && x < 540 ? 20 : 235));
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

// ------------------------------------------------------------------ page math (web/scan-math.js)

/** A w×h grey image: dark table, a bright page rotated by `deg` around the centre. */
function photo(w: number, h: number, pw: number, ph: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * Math.cos(a) + dy * Math.sin(a);
      const v = -dx * Math.sin(a) + dy * Math.cos(a);
      g[y * w + x] = Math.abs(u) < pw / 2 && Math.abs(v) < ph / 2 ? 230 : 45;
    }
  const corner = (u: number, v: number) => ({ x: cx + u * Math.cos(a) - v * Math.sin(a), y: cy + u * Math.sin(a) + v * Math.cos(a) });
  return { g, corners: [corner(-pw / 2, -ph / 2), corner(pw / 2, -ph / 2), corner(pw / 2, ph / 2), corner(-pw / 2, ph / 2)] };
}

test('V2.5 page math: finds a tilted page on a dark table (crop + straighten corners)', () => {
  const { g, corners } = photo(400, 300, 220, 160, 8);
  const q = findPageQuad(g, 400, 300);
  assert.equal(q.found, true);
  q.corners.forEach((c: { x: number; y: number }, i: number) => {
    assert.ok(Math.hypot(c.x - corners[i].x, c.y - corners[i].y) < 6, `corner ${i}: ${JSON.stringify(c)} vs ${JSON.stringify(corners[i])}`);
  });
  const size = outSize(q.corners);
  assert.ok(Math.abs(size.w - 220) < 8 && Math.abs(size.h - 160) < 8, JSON.stringify(size));
});

test('V2.5 page math: a page that fills the photo keeps the whole frame', () => {
  const g = new Uint8Array(200 * 100).fill(230);
  const q = findPageQuad(g, 200, 100);
  assert.equal(q.found, false);
  assert.deepEqual(q.corners, [{ x: 0, y: 0 }, { x: 199, y: 0 }, { x: 199, y: 99 }, { x: 0, y: 99 }]);
});

test('V2.5 page math: skew of text lines is measured; a straight page reads 0', () => {
  const lines = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const g = new Uint8Array(300 * 300).fill(240);
    for (let y = 0; y < 300; y++) for (let x = 20; x < 280; x++) if (Math.round(y - (x - 150) * t) % 25 < 3 && y > 30 && y < 270) g[y * 300 + x] = 20;
    return g;
  };
  assert.ok(Math.abs(skewAngle(lines(4), 300, 300) - 4) <= 0.6, String(skewAngle(lines(4), 300, 300)));
  assert.ok(Math.abs(skewAngle(lines(-3), 300, 300) + 3) <= 0.6);
  assert.ok(Math.abs(skewAngle(lines(0), 300, 300)) <= 0.5);
});

test('V2.5 page math: warping an upright box is a plain crop; rotate turns a quarter', () => {
  const w = 20;
  const h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([i % 256, 0, 0, 255], i * 4);
  const out = warpQuad(rgba, w, h, [{ x: 5, y: 2 }, { x: 14, y: 2 }, { x: 14, y: 7 }, { x: 5, y: 7 }], 10, 6);
  assert.equal(out.length, 10 * 6 * 4);
  assert.equal(out[0], (2 * w + 5) % 256, 'top-left is the crop corner');
  assert.equal(out[(5 * 10 + 9) * 4], (7 * w + 14) % 256, 'bottom-right is the crop corner');
  const g = toGray(rgba, w, h);
  assert.equal(g.length, w * h);
  const r = rotateRgba(rgba, w, h);
  assert.deepEqual([r.w, r.h], [h, w]);
  // Clockwise: the old bottom-left pixel is the new top-left.
  assert.equal(r.data[0], ((h - 1) * w) % 256);
});

// ------------------------------------------------------------------ server: checks, PDF, name

test('V2.5 scan pages: only real JPEG/PNG pictures, a page limit, a clear refusal', () => {
  assert.equal(parseScanPage(dataUrl(pagePng(1))).mime, 'image/png');
  assert.throws(() => parseScanPage('data:image/png;base64,AAAA'), ScanError);
  assert.throws(() => parseScanPage(dataUrl(pagePng(1), 'image/jpeg')), ScanError, 'type must match the bytes');
  assert.throws(() => parseScanPage('data:image/webp;base64,UklGRgAAAABXRUJQ'), ScanError);
  assert.throws(() => parseScanPage('https://example.com/a.png'), ScanError);
  assert.ok(SCAN_MAX_PAGES >= 20);
});

test('V2.5 scan PDF: three page pictures become one PDF, in order, each page read as a scanned page', async () => {
  const pdf = scanPdf([pagePng(1), pagePng(2), pagePng(3)].map((b) => parseScanPage(dataUrl(b))), { title: 'Car papers' });
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Count 3\b/);
  assert.match(pdf.toString('latin1'), /\/Title \(Car papers\)/);
  const r = await readDocument('scan.pdf', pdf);
  assert.equal(r.images.length, 3, 'every page is a scanned picture for the picture model');
  assert.deepEqual(r.images.map((i) => i.where), ['page 1', 'page 2', 'page 3']);
});

test('V2.5 scan name: the date in the owner\'s time zone, or the name given', () => {
  const at = new Date('2026-11-18T03:30:00Z');
  assert.equal(scanName(at, 'America/Chicago'), 'Scan 2026-11-17 21.30.pdf');
  assert.equal(scanName(at, 'UTC', '  Car / papers  '), 'Car papers.pdf');
});

// ------------------------------------------------------------------ acceptance: three pages → PDF, text, facts

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ providers: [LOCAL], defaultProviderId: LOCAL.id, defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString() });
  t.after(async () => {
    await closeAllPagers();
    app.store.close();
    cleanup();
  });
  return { app, dir, lib: app.library };
}

test('V2.5 acceptance: three fake page pictures become one PDF in the Library with read text and suggested facts', async (t) => {
  const { app, dir, lib } = setup(t);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  let nudged = 0;
  app.libraryNudge = () => void nudged++;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${owner}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  // Refusals first: nothing, too many, not a picture.
  assert.equal((await api('/library/scan', { pages: [] })).status, 400);
  assert.equal((await api('/library/scan', { pages: Array(SCAN_MAX_PAGES + 1).fill(dataUrl(pagePng(1))) })).status, 400);
  assert.equal((await api('/library/scan', { pages: ['data:image/png;base64,AAAA'] })).status, 400);

  const saved = await api('/library/scan', { pages: [1, 2, 3].map((n) => dataUrl(pagePng(n))), learn: false });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const id = saved.body.doc.id as number;
  assert.equal(saved.body.doc.name, 'Scan 2026-11-18 09.00.pdf');
  assert.equal(saved.body.doc.keep, true);
  assert.equal(saved.body.doc.origin, 'scan');
  assert.ok(nudged >= 1, 'the library reader is woken up');
  const file = lib.file(lib.get(id)!)!;
  assert.match(file.toString('latin1'), /\/Count 3\b/, 'one PDF with three pages');

  // The usual reading: each page by the picture model (local here, so nobody is asked).
  app.script.push(text('STATE OF TEXAS\nDriver License'), text("Driver's license number: D1234-5678\nExpires March 3, 2028"), text('Page 3 of 3'));
  const read = await readOne(app, lib, lib.get(id)!);
  assert.equal(read!.status, 'ready');
  assert.equal(read!.pagesSeen, 3);

  const view = await api(`/library/scan/${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.doc.status, 'ready');
  assert.equal(view.body.pages, 3);
  assert.ok(view.body.text.some((p: { text: string }) => /Expires March 3, 2028/.test(p.text)), 'read text comes back');
  const sug = view.body.suggestions as { label: string; date: string; dateKind: string; daysBefore: number; page: number }[];
  assert.equal(sug.length, 1, JSON.stringify(sug));
  assert.deepEqual([sug[0].dateKind, sug[0].date, sug[0].daysBefore, sug[0].page], ['license_expiry', '2028-03-03', 30, 2]);
  assert.ok(view.body.facts.some((f: { label: string }) => f.label === 'License number'), 'other facts too');
  // Same suggestion everywhere else (Today, What Sara knows): no second copy.
  const all = await api('/facts');
  assert.equal(all.body.suggestions.filter((s: { docId: number }) => s.docId === id).length, 1);

  // Another doc id or a deleted one: 404.
  assert.equal((await api('/library/scan/99999')).status, 404);
});

test('V2.5 the same scan twice is kept once', async (t) => {
  const { app, lib } = setup(t);
  const pages = [1, 2].map((n) => parseScanPage(dataUrl(pagePng(n))));
  const a = takeScan(app, pages, { title: 'Lease' });
  const b = takeScan(app, pages, { title: 'Lease' });
  assert.equal(a.doc.id, b.doc.id);
  assert.equal(b.already, true);
  assert.equal(lib.list().length, 1);
});

test('V2.5 wiring: Library button, scan view, #view=scan, phone camera input, closed dialogs', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="lib-scan-open"/);
  assert.match(html, /<section id="lib-scan" hidden/);
  // Photos (no `capture`, so a phone offers both its camera and its gallery) and a live camera.
  assert.match(html, /id="scan-file"[^>]*accept="image\/jpeg,image\/png,image\/\*"[^>]*multiple/);
  assert.match(html, /id="scan-camera"/);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /scan: \(\) => void openScan\(\)/);
  const lib = readFileSync(join(ROOT, 'web', 'library.js'), 'utf8');
  assert.match(lib, /#lib-scan/);
  // Leaving the view turns the camera off, without looping on its own `hidden` writes.
  const scan = readFileSync(join(ROOT, 'web', 'scan.js'), 'utf8');
  assert.match(scan, /if \(shown && sec\.hidden\) closeScan\(\)/);
  assert.match(scan, /if \(s && !s\.hidden\) s\.hidden = true/);
  const howto = JSON.parse(readFileSync(join(ROOT, 'web', 'howto.json'), 'utf8'));
  assert.ok(howto.library.some((h: { show?: string }) => h.show === '#lib-scan-open'));
});

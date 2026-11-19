// W5.3 (docs/design/W5BACKUP.md): backups you can carry (owner only; the `backups` route family,
// mounted before admin's /api/backups).
//   GET    /api/backups/carry                       the page: sheet state, targets, drives, links, held copies, staged restore
//   POST   /api/backups/carry/sheet  {again?}       a new recovery key + sheet (words, QR)
//   GET    /api/backups/carry/sheet[.pdf]           the sheet until "I printed it", then 410
//   POST   /api/backups/carry/sheet/confirm         "I printed it"
//   POST   /api/backups/carry/targets {kind, path|link, every, keep}
//   PUT|DELETE /api/backups/carry/targets/:id        · POST …/:id/copy = copy now
//   PUT    /api/backups/carry/hold/:link {on, maxMb} keep sealed copies for a linked friend
//   GET|DELETE /api/backups/carry/hold/:link/:name
//   GET    /api/backups/carry/restore/found         .sara files on the drives
//   POST   /api/backups/carry/restore {path} · /restore/upload (raw body, ?name=)
//   POST   /api/backups/carry/restore/:id/check {words} · /:id/stage · DELETE /:id · DELETE /restore/staged
// Peer: POST /msg/v1/carry/{begin|part|end|list|drop}, signed with scope 'carry'.
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { carrySheetPdf } from '../carry-sheet.ts';
import { addTarget, CARRY_OPS, CARRY_PEER_MAX, CarryHttp, carryReceived, carryView, cancelRestore, confirmSheet, copyNow, foundCopies, heldFile, newSheet, pendingSheet, removeTarget, restoreCheck, restoreFromPath, restoreStage, restoreUploadTarget, setHold, unstage, updateTarget, uploaded } from '../carry.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { en } from '../i18n.ts';
import { privateLocalOn } from '../net-guard.ts';
import { qrSvg } from '../qr.ts';
import { SupportError, supportOf } from '../support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const qr = (s: string) => `data:image/svg+xml;base64,${Buffer.from(qrSvg(s)).toString('base64')}`;

export function createCarryRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'backups' || b !== 'carry') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const root = app.rootDir ?? app.dataDir;
    const view = () => send(res, 200, carryView(app));
    try {
      if (c === 'restore' && d === 'upload' && method === 'POST') {
        const t = restoreUploadTarget(app);
        await pipeline(req, createWriteStream(t.file, { mode: 0o600 }));
        const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '';
        return send(res, 200, uploaded(app, t.id, name));
      }
      const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 64 * 1024);
      if (!c && method === 'GET') return view();
      if (c === 'sheet' && !d && method === 'POST') {
        const s = newSheet(app, body.again === true);
        return send(res, 200, { ...s, qr: qr(s.qrText) });
      }
      if (c === 'sheet' && !d && method === 'GET') {
        const s = pendingSheet(app);
        return send(res, 200, { ...s, qr: qr(s.qrText) });
      }
      if (c === 'sheet.pdf' && method === 'GET') {
        const s = pendingSheet(app);
        const st = app.settings.get();
        const pdf = carrySheetPdf({ ...s, owner: st.ownerName || undefined, lang: st.language && st.language !== 'auto' ? st.language : 'en' });
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="sara-recovery-sheet.pdf"', 'content-length': pdf.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(pdf);
      }
      if (c === 'sheet' && d === 'confirm' && method === 'POST') return (confirmSheet(app), view());
      if (c === 'targets' && !d && method === 'POST') return (addTarget(app, body), view());
      if (c === 'targets' && d && !e && method === 'PUT') return (updateTarget(app, d, body), view());
      if (c === 'targets' && d && !e && method === 'DELETE') return (removeTarget(app, d), view());
      if (c === 'targets' && d && e === 'copy' && method === 'POST') return (await copyNow(app, d, ctx.opts.info?.version), view());
      if (c === 'hold' && d && !e && method === 'PUT') return (setHold(app, d, body), view());
      if (c === 'hold' && d && e && method === 'GET') {
        const f = heldFile(app, d, decodeURIComponent(e));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${decodeURIComponent(e)}"`, 'content-length': statSync(f).size, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        createReadStream(f).pipe(res);
        return;
      }
      if (c === 'hold' && d && e && method === 'DELETE') {
        const { rmSync } = await import('node:fs');
        rmSync(heldFile(app, d, decodeURIComponent(e)), { force: true });
        return view();
      }
      if (c === 'restore' && d === 'found' && method === 'GET') return send(res, 200, { files: foundCopies() });
      if (c === 'restore' && !d && method === 'POST') return send(res, 200, restoreFromPath(app, body.path));
      if (c === 'restore' && d === 'staged' && method === 'DELETE') return (unstage(root), view());
      if (c === 'restore' && d && e === 'check' && method === 'POST') return send(res, 200, { record: await restoreCheck(app, d, body.words) });
      if (c === 'restore' && d && e === 'stage' && method === 'POST') return send(res, 200, restoreStage(app, d));
      if (c === 'restore' && d && !e && method === 'DELETE') return (cancelRestore(app, d), send(res, 200, { ok: true }));
    } catch (err) {
      if (err instanceof CarryHttp) throw new HttpError(err.status, err.message, err.params ? { params: err.params } : undefined);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  };
}

/** POST /msg/v1/carry/<op> from another linked server (mounted in server.ts for the owner only). */
export async function handleCarryPeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const sup = supportOf(ctx.app);
  const op = path.slice('/msg/v1/carry/'.length);
  if (!sup || req.method !== 'POST' || !(CARRY_OPS as readonly string[]).includes(op)) {
    req.resume();
    return reply(404, { error: 'not found' });
  }
  let raw = '';
  try {
    raw = await new Promise<string>((ok, fail) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (ch: Buffer) => {
        n += ch.length;
        if (n > CARRY_PEER_MAX) {
          fail(new Error('too big'));
          req.destroy();
        } else chunks.push(ch);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  } catch {
    return reply(413, { error: 'too big' });
  }
  if (privateLocalOn()) return reply(403, { error: en('Private local mode is on there.') });
  try {
    const { linkId } = sup.verify(req.headers, op, raw, 'carry');
    return reply(200, carryReceived(ctx.app, linkId, op, JSON.parse(raw) as Record<string, unknown>));
  } catch (err) {
    if (err instanceof SupportError) return reply(err.status, { error: err.message });
    return reply(400, { error: 'bad request' });
  }
}

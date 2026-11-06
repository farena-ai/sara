// E5 (docs/ops/E5_DESIGN.md): read together, the owner's only. Household members and the demo get
// 403 before anything is read (guests and other apps' keys never get past sign-in); off-record,
// partner and room conversations are not found. Nothing here starts a turn or calls a model.
//   GET    /api/read-together/:conversationId   {share, privateLocal}
//   PUT    /api/read-together/:conversationId   {docId, sha, ordFrom, ordTo, start, end, textSha, mode} → {ok, share} | 409 {reason}
//   DELETE /api/read-together/:conversationId   Stop (204)
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { ReadTogetherError, readTogetherAllowed, sharedExcerpt } from '../read-together.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createReadTogetherRoutes(ctx: RouteCtx): RouteHandler {
  const { app, offStore, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, id, more] = parts;
    if (a !== 'read-together') return NEXT;
    if (opts.demo || opts.member || !app.readTogether || !app.library) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const conv = id && !more && !offStore.getConversation(id) ? app.store.getConversation(id) : undefined;
    if (!conv || !readTogetherAllowed(app, conv)) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Conversation not found');
    }
    const rt = app.readTogether;
    if (method === 'GET') {
      const s = rt.get(conv.id);
      const got = s ? sharedExcerpt(app, s) : undefined;
      return send(res, 200, { share: s && got ? { docId: s.docId, name: s.name, mode: s.mode, at: s.at, ...('mismatch' in got ? { mismatch: got.mismatch } : { place: got.place, heading: got.heading }) } : null, privateLocal: privateLocalOn() || conv.private });
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      try {
        return send(res, 200, { ok: true, share: rt.share(app, conv.id, body), privateLocal: privateLocalOn() || conv.private });
      } catch (err) {
        if (err instanceof ReadTogetherError) throw new HttpError(err.status, err.message, { reason: err.reason, errorKey: err.message });
        throw err;
      }
    }
    if (method === 'DELETE') {
      rt.stop(conv.id);
      res.writeHead(204, { 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end();
    }
    throw new HttpError(405, 'Method not allowed');
  };
}

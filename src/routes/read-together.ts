// E5 (docs/ops/E5_DESIGN.md): read together, the owner's only. Household members and the demo get
// 403 before anything is read (guests and other apps' keys never get past sign-in); off-record,
// partner and room conversations are not found. Nothing here starts a turn or calls a model.
//   GET    /api/read-together/:conversationId   {share, privateLocal}
//   PUT    /api/read-together/:conversationId   {docId, sha, ordFrom, ordTo, start, end, textSha, mode} → {ok, share} | 409 {reason}
//   DELETE /api/read-together/:conversationId   Stop (204): ends the share and closes an open feed (?only=share: the share only)
// E6 (docs/ops/E6_DESIGN.md): one public feed per chat, fetched only here (Open/Reload):
//   POST   /api/read-together/:conversationId/feed   {url} → {feed} | 400/409/413/422/429/502/504 {reason}
//   PUT    /api/read-together/:conversationId        {source: 'feed', rev, key, textSha} shares one item
import { FeedError, openFeed, type Snapshot } from '../feed-together.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { isPrivateLocalError, privateLocalOn } from '../net-guard.ts';
import { ReadTogetherError, readTogetherAllowed, sharedExcerpt, sharedFeedItem } from '../read-together.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** What the browser gets of a feed: titles, dates, links, keys and hashes (never the item text). */
const feedView = (f: Snapshot | undefined) => (f ? { url: f.url, host: f.host, title: f.title, rev: f.rev.slice(0, 12), at: f.at, items: f.items.map((i) => ({ key: i.key, title: i.title, published: i.published, link: i.link, textSha: i.textSha })) } : null);

export function createReadTogetherRoutes(ctx: RouteCtx): RouteHandler {
  const { app, offStore, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, id, more] = parts;
    if (a !== 'read-together') return NEXT;
    if (opts.demo || opts.member || !app.readTogether || !app.library) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const feedPath = more === 'feed' && parts.length === 3;
    const conv = id && (!more || feedPath) && !offStore.getConversation(id) ? app.store.getConversation(id) : undefined;
    if (!conv || !readTogetherAllowed(app, conv)) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Conversation not found');
    }
    const rt = app.readTogether;
    const privateLocal = privateLocalOn() || conv.private;
    const fail = (err: unknown): never => {
      if (err instanceof ReadTogetherError || err instanceof FeedError) throw new HttpError(err.status, err.message, { reason: err.reason, errorKey: err.message });
      throw err;
    };
    if (feedPath) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      if (conv.private) throw new HttpError(409, 'Feeds need the internet, so a private chat cannot open one.', { reason: 'private' });
      if (privateLocalOn()) throw new HttpError(409, 'Feeds need the internet; private local mode is on.', { reason: 'private' });
      try {
        rt.limit(conv.id);
        const snap = await openFeed(typeof body.url === 'string' ? body.url.trim().slice(0, 2000) : '', { now: () => app.now() });
        rt.setFeed(conv.id, snap);
        return send(res, 200, { ok: true, feed: feedView(snap), privateLocal });
      } catch (err) {
        if (isPrivateLocalError(err)) throw new HttpError(409, 'Feeds need the internet; private local mode is on.', { reason: 'private' });
        return fail(err);
      }
    }
    if (method === 'GET') {
      const s = rt.get(conv.id);
      let share: Record<string, unknown> | null = null;
      if (s?.source === 'feed') {
        const got = sharedFeedItem(app, s);
        share = { source: 'feed', key: s.key, name: s.name, feed: s.feed, mode: s.mode, at: s.at, ...('mismatch' in got ? { mismatch: got.mismatch } : {}) };
      } else if (s) {
        const got = sharedExcerpt(app, s);
        share = { docId: s.docId, name: s.name, mode: s.mode, at: s.at, ...('mismatch' in got ? { mismatch: got.mismatch } : { place: got.place, heading: got.heading }) };
      }
      return send(res, 200, { share, feed: feedView(rt.feed(conv.id)), privateLocal });
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      try {
        return send(res, 200, { ok: true, share: rt.share(app, conv.id, body), privateLocal });
      } catch (err) {
        return fail(err);
      }
    }
    if (method === 'DELETE') {
      // ?only=share (Follow off): ends the share but keeps an open feed's list; plain DELETE is Stop.
      if (new URL(req.url ?? '/', 'http://local').searchParams.get('only') === 'share') rt.unshare(conv.id);
      else rt.stop(conv.id);
      res.writeHead(204, { 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end();
    }
    throw new HttpError(405, 'Method not allowed');
  };
}

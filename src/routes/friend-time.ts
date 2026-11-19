// V2.10 (docs/design/V2SCHEDULE.md): find a time with a linked friend (owner only).
//   GET    /api/friend-time                  {requests, friends, parts, minutes, privateLocal}
//   POST   /api/friend-time                  {link, title, minutes, part, days} → {request}   ask a friend
//   POST   /api/friend-time/:id/share        friend: share my free/busy → {request} (with the times)
//   POST   /api/friend-time/:id/decline      friend: not now
//   POST   /api/friend-time/:id/pick         {time} → {request} (agreed when both picked it)
//   POST   /api/friend-time/:id/cancel       either side: call it off
//   DELETE /api/friend-time/:id              forget it here
// Peer: POST /msg/v1/ftime/{ask|busy|pick|cancel}, signed with scope 'ftime'.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FT_MINUTES, FT_OPS, FT_PARTS, FT_PEER_MAX, friendTimeOf } from '../friend-time.ts';
import { HttpError, readJson, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { SupportError } from '../support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { en } from '../i18n.ts';

export function createFriendTimeRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'friend-time') return NEXT;
    const ft = ctx.opts.demo || ctx.opts.member ? undefined : friendTimeOf(app);
    if (!ft) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 16 * 1024);
    try {
      if (!b && method === 'GET') return send(res, 200, { requests: ft.list(), friends: ft.friends(), parts: FT_PARTS, minutes: FT_MINUTES, privateLocal: privateLocalOn() });
      if (!b && method === 'POST') return send(res, 200, { request: await ft.ask(String(body.link ?? ''), body.title, body.minutes, body.part, body.days) });
      if (b && !c && method === 'DELETE') return (await ft.forget(b), send(res, 200, { ok: true }));
      if (b && c === 'share' && method === 'POST') return send(res, 200, { request: await ft.share(b) });
      if (b && (c === 'decline' || c === 'cancel') && method === 'POST') return send(res, 200, { request: await ft.cancel(b) });
      if (b && c === 'pick' && method === 'POST') return send(res, 200, { request: await ft.pick(b, body.time) });
    } catch (err) {
      if (err instanceof SupportError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  };
}

/** POST /msg/v1/ftime/<op> from another linked server (mounted in server.ts for the owner only). */
export async function handleFriendTimePeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const ft = friendTimeOf(ctx.app);
  const op = path.slice('/msg/v1/ftime/'.length);
  if (!ft || req.method !== 'POST' || !(FT_OPS as readonly string[]).includes(op)) {
    req.resume();
    return reply(404, { error: 'not found' });
  }
  let raw = '';
  try {
    raw = await readBody(req);
  } catch {
    return reply(413, { error: 'too big' });
  }
  if (privateLocalOn()) return reply(403, { error: en('Private local mode is on there.') });
  try {
    const { linkId, name } = ft.verify(req.headers, op, raw);
    return reply(200, await ft.received(linkId, name, op, JSON.parse(raw) as Record<string, unknown>));
  } catch (err) {
    if (err instanceof SupportError) return reply(err.status, { error: err.message });
    return reply(400, { error: 'bad request' });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > FT_PEER_MAX) {
        fail(new Error('too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

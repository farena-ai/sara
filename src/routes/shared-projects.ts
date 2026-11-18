// U4.26 (docs/SHARED_PROJECTS.md): shared projects' owner API and peer endpoint. Owner only: household
// members, kid mode and the demo get 403 here and no peer endpoint at all (404).
//   GET    /api/shared-projects                       {shares, friends, roles, kinds}
//   POST   /api/shared-projects                       {project, link, role, kinds} → {share}   host: invite a friend
//   GET    /api/shared-projects/:id                   {share, items, activity}
//   PATCH  /api/shared-projects/:id                   {notify?, kinds? (host)} → {share}
//   DELETE /api/shared-projects/:id                   host: stop sharing; guest: forget the copy
//   POST   /api/shared-projects/:id/accept            {accept} guest
//   POST   /api/shared-projects/:id/leave             guest
//   POST   /api/shared-projects/:id/seen
//   PATCH  /api/shared-projects/:id/members/:link     {role} host
//   DELETE /api/shared-projects/:id/members/:link     host: remove (sync to them stops)
//   POST   /api/shared-projects/:id/items             {kind, title, body, done, file:{name,data}, libraryDoc, conversation}
//   PATCH  /api/shared-projects/:id/items/:item       {title, body, done, file, refresh}
//   DELETE /api/shared-projects/:id/items/:item
//   GET    /api/shared-projects/:id/items/:item/file  the bytes
// Peer: POST /msg/v1/sproj/{invite|answer|leave|remove|events}, signed with scope 'sproj'.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { SP_KINDS, SP_OPS, SP_PEER_MAX, SP_ROLES, sharedProjectsOf } from '../shared-projects.ts';
import { SupportError } from '../support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createSharedProjectRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'shared-projects') return NEXT;
    const sp = ctx.opts.demo || ctx.opts.member ? undefined : sharedProjectsOf(app);
    if (!sp) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 4 * 1024 * 1024);
    try {
      if (!b && method === 'GET') return send(res, 200, { shares: sp.list(), friends: app.messages!.links().filter((l) => l.kind === 'direct').map((l) => ({ id: l.id, name: l.name })), roles: SP_ROLES, kinds: SP_KINDS, privateLocal: privateLocalOn() });
      if (!b && method === 'POST') return send(res, 200, { share: await sp.invite(Number(body.project), String(body.link ?? ''), body.role, body.kinds) });
      if (b && !c && method === 'GET') return send(res, 200, { share: sp.get(b), items: sp.items(b), activity: sp.activity(b) });
      if (b && !c && method === 'PATCH') return send(res, 200, { share: sp.patch(b, body) });
      if (b && !c && method === 'DELETE') return (await sp.drop(b), send(res, 200, { ok: true }));
      if (b && c === 'accept' && method === 'POST') return send(res, 200, { share: await sp.answer(b, body.accept === true) });
      if (b && c === 'leave' && method === 'POST') return (await sp.leave(b), send(res, 200, { ok: true }));
      if (b && c === 'seen' && method === 'POST') return (sp.seen(b), send(res, 200, { ok: true }));
      if (b && c === 'members' && d && method === 'PATCH') return (sp.setRole(b, d, body.role), send(res, 200, { share: sp.get(b) }));
      if (b && c === 'members' && d && method === 'DELETE') return (await sp.removeMember(b, d), send(res, 200, { share: sp.get(b) }));
      if (b && c === 'items' && !d && method === 'POST') return send(res, 200, { item: sp.add(b, body) });
      if (b && c === 'items' && d && !e && method === 'PATCH') return send(res, 200, { item: sp.change(b, d, body) });
      if (b && c === 'items' && d && !e && method === 'DELETE') return send(res, 200, { item: sp.change(b, d, { deleted: true }) });
      if (b && c === 'items' && d && e === 'file' && method === 'GET') {
        const f = sp.file(b, d);
        if (!f) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        res.end(f.bytes);
        return;
      }
    } catch (err) {
      if (err instanceof SupportError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > SP_PEER_MAX) {
        fail(new Error('too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** POST /msg/v1/sproj/<op> from another linked server (mounted in server.ts for the owner only). */
export async function handleSharedProjectPeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const sp = sharedProjectsOf(ctx.app);
  const op = path.slice('/msg/v1/sproj/'.length);
  if (!sp || req.method !== 'POST' || !(SP_OPS as readonly string[]).includes(op)) {
    req.resume();
    return reply(404, { error: 'not found' });
  }
  let raw = '';
  try {
    raw = await readBody(req);
  } catch {
    return reply(413, { error: 'too big' });
  }
  if (privateLocalOn()) return reply(403, { error: 'Private local mode is on there.' });
  try {
    const { linkId, name } = sp.verify(req.headers, op, raw);
    return reply(200, sp.received(linkId, name, op, JSON.parse(raw) as Record<string, unknown>));
  } catch (err) {
    if (err instanceof SupportError) return reply(err.status, { error: err.message });
    return reply(400, { error: 'bad request' });
  }
}

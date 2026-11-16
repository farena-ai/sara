// S9a (docs/MESSAGES.md): the owner's Messages page. Household members, kid mode and the demo get 403;
// nothing here calls a model or a tool. The other servers talk to /msg/v1 (src/messages.ts handlePeer).
//   GET    /api/messages                                {settings, chats, unread, requests, links}
//   PUT    /api/messages/settings                       {retentionDays, receipts, typing, url, name}
//   POST   /api/messages/invite                         {url?} → {code, expiresAt}   one-time link code
//   POST   /api/messages/join                           {code, url?} → {chat}       a link or a community code
//   DELETE /api/messages/links/:id?history=keep|remove  unlink (keys go on both sides)
//   GET    /api/messages/chats/:id                      {chat, messages, typing, members, reports, code}
//   PATCH  /api/messages/chats/:id                      {muted, blocked, retentionDays, hide}
//   DELETE /api/messages/chats/:id?history=keep|remove  end/leave/close, or remove an ended chat's history
//   POST   /api/messages/chats/:id/send|read|typing|leave
//   PATCH|DELETE /api/messages/chats/:id/m/:mid         edit / delete your own message
//   GET    /api/messages/chats/:id/m/:mid/file          a picture or file
//   POST   /api/messages/chats/:id/m/:mid/report        {why} → the community's creator
//   POST   /api/messages/communities                    {name, url?} → {chat}
//   POST   /api/messages/communities/:id/code           {url?} → {code} (a new code; the old one stops)
//   POST   /api/messages/communities/:id/members/:mid   {action: kick|ban|mod|unmod}
//   POST   /api/messages/communities/:id/intro          {member, url?} ask for a private chat
//   POST   /api/messages/requests/:id                   {accept}
import type { IncomingMessage } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { MSG, MsgError } from '../messages.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** This server's address as the browser sees it (the default for codes when none is set). */
function origin(req: IncomingMessage): string | undefined {
  const o = req.headers.origin;
  return typeof o === 'string' && /^https?:\/\//.test(o) ? o : undefined;
}

export function createMessagesRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof MsgError) throw new HttpError(err.status, err.message, err.params ? { params: err.params } : undefined);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d, e, f] = parts;
    if (a !== 'messages') return NEXT;
    const m = app.messages;
    if (ctx.opts.demo || ctx.opts.member || !m) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, MSG.bodyBytes);
    const url = (typeof body.url === 'string' && body.url) || origin(req);
    const keep = new URL(req.url ?? '/', 'http://x').searchParams.get('history') !== 'remove';
    if (!b && method === 'GET') return send(res, 200, { settings: m.settings(), chats: m.chats(), unread: m.unread(), requests: m.requests(), links: m.links().length, limits: { fileMB: MSG.fileBytes / 1024 / 1024, textChars: MSG.textChars } });
    if (b === 'settings' && method === 'PUT') return send(res, 200, { settings: await wrap(() => m.setSettings(body)) });
    if (b === 'invite' && method === 'POST') return send(res, 200, await wrap(() => m.invite(url)));
    if (b === 'join' && method === 'POST') return send(res, 200, { chat: await wrap(() => m.join(String(body.code ?? ''), url)) });
    if (b === 'links' && c && method === 'DELETE') {
      await wrap(() => m.unlink(c, keep));
      return send(res, 200, { ok: true });
    }
    if (b === 'requests' && c && method === 'POST') return send(res, 200, { chat: await wrap(() => m.answerRequest(c, Boolean(body.accept), url)) });
    if (b === 'communities') {
      if (!c && method === 'POST') return send(res, 200, { chat: await wrap(() => m.createCommunity(body.name, url)) });
      if (c && d === 'code' && method === 'POST') return send(res, 200, await wrap(() => m.rotateCode(c, url)));
      if (c && d === 'members' && e && method === 'POST') {
        await wrap(() => m.moderate(c, e, body.action));
        return send(res, 200, { ok: true });
      }
      if (c && d === 'intro' && method === 'POST') {
        await wrap(() => m.intro(c, String(body.member ?? ''), url));
        return send(res, 200, { ok: true });
      }
    }
    if (b === 'chats' && c) {
      if (!m.chat(c)) throw new HttpError(404, 'Not found');
      if (!d) {
        if (method === 'GET') {
          const chat = m.chat(c)!;
          const before = new URL(req.url ?? '/', 'http://x').searchParams.get('before') ?? undefined;
          return send(res, 200, { chat, messages: m.messages(c, before ? { before } : {}), typing: m.typing(c), members: m.members(c), me: m.me(c), reports: m.reports(c), code: chat.role === 'host' || chat.role === 'mod' ? m.inviteCode(c) : null });
        }
        if (method === 'PATCH') return send(res, 200, { chat: await wrap(() => m.patchChat(c, body)) });
        if (method === 'DELETE') {
          await wrap(() => (m.chat(c)!.kind === 'community' && m.chat(c)!.status === 'active' ? m.leave(c, keep) : m.chat(c)!.status === 'active' ? m.unlink(m.chat(c)!.linkId!, keep) : m.removeChat(c)));
          return send(res, 200, { ok: true });
        }
      }
      if (d === 'send' && method === 'POST') return send(res, 200, { message: await wrap(() => m.send(c, { text: body.text, file: (body.file as { name?: unknown; data?: unknown } | undefined) ?? null })) });
      if (d === 'read' && method === 'POST') return (m.markRead(c), send(res, 200, { ok: true }));
      if (d === 'typing' && method === 'POST') return (await wrap(() => m.typingNow(c)), send(res, 200, { ok: true }));
      if (d === 'leave' && method === 'POST') {
        await wrap(() => m.leave(c, body.history !== 'remove'));
        return send(res, 200, { ok: true });
      }
      if (d === 'm' && e) {
        if (!f && method === 'PATCH') return send(res, 200, { message: await wrap(() => m.edit(c, e, body.text)) });
        if (!f && method === 'DELETE') return (await wrap(() => m.remove(c, e)), send(res, 200, { ok: true }));
        if (f === 'report' && method === 'POST') return (await wrap(() => m.report(c, e, body.why)), send(res, 200, { ok: true }));
        if (f === 'file' && method === 'GET') {
          const file = m.file(c, e);
          if (!file) throw new HttpError(404, 'Not found');
          res.writeHead(200, { 'content-type': file.type, 'content-length': file.bytes.length, 'cache-control': 'private, no-store', 'content-disposition': `${file.type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.name)}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
          return void res.end(file.bytes);
        }
      }
    }
    throw new HttpError(404, 'Not found');
  };
}

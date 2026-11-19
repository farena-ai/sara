// W1.3: continue on another device (src/continue-here.ts). Each space answers for its own person
// (the family is in MEMBER_ROUTES; a member's app has its own data folder). Nothing calls a model.
//   GET  /api/continue-here?device=&lang=       → {offer|null, settings}
//   PUT  /api/continue-here  {device, kind, conversationId, draft, scroll, talk, canvas} → {noted}
//   POST /api/continue-here/dismiss {device, at}  → {ok}
//   POST /api/continue-here/phone {device, kind, conversationId, draft, …} → {sent, phones}
//   GET|PUT /api/continue-here/settings {on, withinMin}
import { ContinueError, continueHereOf, type NoteInput } from '../continue-here.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createContinueHereRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a === 'continue-here') {
      const ch = continueHereOf(app);
      try {
        if (!b && method === 'GET') {
          const q = new URL(req.url ?? '/', 'http://x').searchParams;
          return send(res, 200, { offer: ch.offer(q.get('device') ?? '', q.get('lang') ?? undefined), settings: ch.settings() });
        }
        // PUT from the page; POST from navigator.sendBeacon-like keepalive saves when the page hides.
        if (!b && (method === 'PUT' || method === 'POST')) {
          const body = (await readJson(req)) as unknown as NoteInput;
          return send(res, 200, { noted: ch.note(body) });
        }
        if (b === 'dismiss' && method === 'POST') {
          const body = (await readJson(req)) as { device?: string; at?: string };
          ch.dismiss(String(body.device ?? ''), body.at);
          return send(res, 200, { ok: true });
        }
        if (b === 'phone' && method === 'POST') {
          const body = (await readJson(req)) as unknown as NoteInput;
          const r = await ch.toPhone(body);
          return send(res, 200, { sent: r.sent, phones: r.phones });
        }
        if (b === 'settings' && method === 'GET') return send(res, 200, { settings: ch.settings() });
        if (b === 'settings' && method === 'PUT') return send(res, 200, { settings: ch.setSettings((await readJson(req)) as Record<string, never>) });
      } catch (err) {
        if (err instanceof ContinueError) throw new HttpError(err.status, err.message);
        throw err;
      }
      throw new HttpError(404, en('Not found'));
    }
    return NEXT;
  };
}

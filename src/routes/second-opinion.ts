// D8 (docs/design/D8SECOND.md): a second opinion on one of her replies (each person's own chats;
// the demo gets 404).
//   GET  /api/conversations/:id/second-opinion?message=ID   the two picks, every choice, the spend estimate
//   POST /api/conversations/:id/second-opinion              { message, models?: [{ providerId, model }] } → answers + differences
import { HttpError, readJson, send } from '../http.ts';
import { askSecondOpinion, needChoices, replyOf, secondOpinionPlan } from '../second-opinion.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const running = new Set<string>();

export function createSecondOpinionRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (!(a === 'conversations' && b && c === 'second-opinion' && !d)) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const conv = app.store.getConversation(b);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (method === 'GET') {
      const id = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('message'));
      const plan = secondOpinionPlan(app, conv, replyOf(app, conv, id));
      needChoices(plan);
      return send(res, 200, plan);
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = (await readJson(req)) as { message?: unknown; models?: unknown };
    const reply = replyOf(app, conv, Number(body.message));
    const models = Array.isArray(body.models) ? body.models.filter((m): m is { providerId: string; model: string } => Boolean(m) && typeof m === 'object' && typeof m.providerId === 'string' && typeof m.model === 'string') : undefined;
    const k = `${conv.id}|${reply.id}`;
    if (running.has(k)) throw new HttpError(409, 'A second opinion on this reply is already on its way.');
    running.add(k);
    try {
      return send(res, 200, await askSecondOpinion(app, conv, reply, models));
    } finally {
      running.delete(k);
    }
  };
}

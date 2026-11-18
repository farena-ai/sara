// V1.2 (docs/WAITING.md): Waiting on you, one queue, each person's own (a household member's list
// comes from their own space: their turns, errands, inbox, board, to-dos). Never the demo.
//   GET  /api/waiting                {items, counts}   read-only (src/waiting.ts)
//   POST /api/waiting/act            {key, action: 'approve' | 'later'}
import { rankFollowUps, gatherThreads } from '../biz/followups.ts';
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { waitingAct, waitingList, WaitError, type WaitDeps } from '../waiting.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const FOLLOW_MS = 30 * 60_000;

export function createWaitingRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  let follow: { at: number; list: Awaited<ReturnType<NonNullable<WaitDeps['followups']>>> } | null = null;
  const deps = (): WaitDeps => ({
    member: Boolean(ctx.opts.member || app.member),
    approvals: () => [...ctx.active.entries()].flatMap(([conversationId, t]) => [...t.approvals.values()].map((ap) => ({ ...ap, conversationId, since: t.startedAt }))),
    // Mail threads waiting on a reply: read at most every 30 minutes, only with a mailbox connected.
    followups: async () => {
      if (follow && Date.now() - follow.at < FOLLOW_MS) return follow.list;
      const has = (() => {
        try {
          return (app.mailAccounts?.list() ?? []).length > 0;
        } catch {
          return false;
        }
      })();
      if (!has) return [];
      const { threads, me } = await gatherThreads(app, 14, AbortSignal.timeout(8000));
      const list = rankFollowUps(threads, me, app.now(), 2).slice(0, 10).map((f) => ({ threadId: f.threadId, subject: f.subject, from: f.from, date: f.date, ageDays: f.ageDays }));
      follow = { at: Date.now(), list };
      return list;
    },
  });
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'waiting') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (!b && method === 'GET') {
      const items = await waitingList(app, deps());
      const counts: Record<string, number> = {};
      for (const x of items) counts[x.source] = (counts[x.source] ?? 0) + 1;
      return send(res, 200, { items, counts });
    }
    if (b === 'act' && !c && method === 'POST') {
      const body = await readJson(req);
      const key = typeof body.key === 'string' ? body.key.slice(0, 64) : '';
      const action = body.action === 'approve' || body.action === 'later' ? body.action : null;
      if (!key || !action) throw new HttpError(400, 'key and action (approve or later) are needed');
      try {
        const r = await waitingAct(app, deps(), key, action);
        app.events?.publish({ type: 'today', part: 'needs' });
        return send(res, 200, r);
      } catch (err) {
        if (err instanceof WaitError) throw new HttpError(err.status, trOwner(err.message, app.settings.get()));
        throw err;
      }
    }
    return NEXT;
  };
}

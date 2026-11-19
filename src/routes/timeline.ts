// V5.1: the action timeline (src/timeline.ts). Each space sees its own (members included: the family
// is in MEMBER_ROUTES; a member's app has its own sara.db). Nothing here calls a model.
//   GET  /api/timeline?kind=&limit=&before=   → {items, kinds}
//   POST /api/timeline/:id/revert             → {item}; 404 unknown, 409 already reverted / can't be undone
import { whyLines } from '../action-why.ts';
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, send } from '../http.ts';
import { TIMELINE_KINDS, TimelineError, timelineOf } from '../timeline.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createTimelineRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'timeline') return NEXT;
    const tl = timelineOf(app);
    if (!b && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const items = tl.list({ kind: q.get('kind') ?? undefined, limit: Number(q.get('limit') ?? 100) || 100, before: Number(q.get('before') ?? 0) || undefined });
      // W5.5: each row carries its "Why did you do this?" lines (en() keys the web translates).
      return send(res, 200, { items: items.map((i) => ({ ...i, whyLines: whyLines(i.why) })), kinds: TIMELINE_KINDS });
    }
    if (b && c === 'revert' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const id = Number(b);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      try {
        const item = await tl.revert(id, app);
        audit({ action: 'timeline.revert', target: item.tool, outcome: 'ok', ...(ctx.opts.member ? { role: 'member' } : { role: 'owner' }) });
        return send(res, 200, { item: { ...item, whyLines: whyLines(item.why) } });
      } catch (err) {
        if (err instanceof TimelineError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    throw new HttpError(404, 'Not found');
  };
}

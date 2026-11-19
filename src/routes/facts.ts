// N6 (docs/WHAT_SARA_KNOWS.md): Settings → You → What Sara knows, each person's own (their space's
// store.db; never the demo).
//   GET    /api/facts                               {facts, groups, suggestions}
//   PATCH  /api/facts/:id {text}                    edit (a memory fact edits the memory itself)
//   DELETE /api/facts/:id                           delete
//   POST   /api/facts/:id/not-true                  forget it and never learn it again from the same words
//   POST   /api/facts/suggestions/:n/accept {daysBefore?}   a planner reminder before the date
//   POST   /api/facts/suggestions/:n/dismiss
//   POST   /api/facts/ask {question}                ask your documents: {found, quotes:[{docId,name,page,quote,cite}]}
//   GET    /api/facts/renewals                      V2.1 {renewals, daysBefore, whats} (docs/RENEWALS.md)
//   POST   /api/facts/renewals {what, title, date}  add one by hand
//   POST   /api/facts/renewals/:id/remind|hide|remove|errand
//   W1.1 (docs/design/W1KNOW.md): the one "What I know about you" page
//   GET    /api/facts/know?q=                       {today, total, topics, duplicates, also}
//   GET    /api/facts/:id/why                       the source message / document page
//   POST   /api/facts/:id/forget                    {timelineId}: Undo = POST /api/timeline/:id/revert
//   POST   /api/facts/:id/wrong {text}              "That's wrong": {fact, timelineId}
//   POST   /api/facts/merge {keep, drop}            {timelineId}
//   POST   /api/facts/keep-both {a, b}              never suggest that pair again
import { askDocuments, DAYS_BEFORE, FACT_GROUPS, factsFor, FactsError } from '../facts.ts';
import { ErrandError } from '../errands.ts';
import { RENEWAL_WHATS, RenewalError, renewalAction, renewalsOf } from '../renewals.ts';
import { HttpError, readJson, send } from '../http.ts';
import { knowEdit, knowForget, knowKeepBoth, knowMerge, knowView, knowWhy } from '../know.ts';
import { TimelineError } from '../timeline.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createFactsRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'facts') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    const facts = factsFor(app);
    try {
      if (!b && method === 'GET') return send(res, 200, { facts: facts.list(), groups: FACT_GROUPS, suggestions: facts.suggestions() });
      if (b === 'know' && !c && method === 'GET') return send(res, 200, knowView(app, { q: new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '' }));
      if ((b === 'merge' || b === 'keep-both') && !c && method === 'POST') {
        const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
        if (b === 'merge') return send(res, 200, knowMerge(app, String(body.keep ?? ''), String(body.drop ?? '')));
        knowKeepBoth(app, String(body.a ?? ''), String(body.b ?? ''));
        return send(res, 200, { ok: true });
      }
      if (b && c === 'why' && !d && method === 'GET') return send(res, 200, knowWhy(app, b));
      if (b && (c === 'forget' || c === 'wrong') && !d && method === 'POST') {
        const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
        return send(res, 200, c === 'forget' ? knowForget(app, b) : knowEdit(app, b, String(body.text ?? '')));
      }
      if (b === 'renewals') {
        if (!c && method === 'GET') return send(res, 200, { renewals: renewalsOf(app), daysBefore: DAYS_BEFORE, whats: RENEWAL_WHATS });
        const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
        if (!c && method === 'POST') return send(res, 200, renewalAction(app, 'add', body));
        if (c && !d && method === 'POST') throw new HttpError(404, 'Not found');
        if (c && (d === 'remind' || d === 'hide' || d === 'remove' || d === 'errand') && method === 'POST') return send(res, 200, renewalAction(app, d, { ...body, id: c }));
        throw new HttpError(405, 'Method not allowed');
      }
      if (b === 'ask' && !c && method === 'POST') {
        const body = (await readJson(req)) as { question?: unknown };
        const q = String(body?.question ?? '').trim().slice(0, 500);
        if (!q) throw new HttpError(400, 'Ask a question.');
        return send(res, 200, await askDocuments(app, q));
      }
      if (b === 'suggestions' && c && /^\d+$/.test(c) && method === 'POST' && (d === 'accept' || d === 'dismiss')) {
        const body = ((await readJson(req).catch(() => ({}))) ?? {}) as { daysBefore?: unknown };
        if (d === 'dismiss') {
          facts.dismiss(Number(c));
          return send(res, 200, { ok: true });
        }
        const days = body.daysBefore === undefined ? undefined : Number(body.daysBefore);
        if (days !== undefined && (!Number.isFinite(days) || days < 0 || days > 365)) throw new HttpError(400, 'Pick 0 to 365 days before.');
        return send(res, 200, facts.accept(Number(c), days));
      }
      if (b && !c && method === 'PATCH') {
        const body = (await readJson(req)) as { text?: unknown };
        return send(res, 200, { fact: facts.edit(b, String(body?.text ?? '')) });
      }
      if (b && !c && method === 'DELETE') {
        facts.remove(b);
        return send(res, 200, { ok: true });
      }
      if (b && c === 'not-true' && !d && method === 'POST') {
        await readJson(req).catch(() => undefined);
        facts.notTrue(b);
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      if (err instanceof FactsError || err instanceof RenewalError || err instanceof ErrandError || err instanceof TimelineError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(405, 'Method not allowed');
  };
}

// N6 (docs/WHAT_SARA_KNOWS.md): Settings → You → What Sara knows, each person's own (their space's
// store.db; never the demo).
//   GET    /api/facts                               {facts, groups, suggestions}
//   PATCH  /api/facts/:id {text}                    edit (a memory fact edits the memory itself)
//   DELETE /api/facts/:id                           delete
//   POST   /api/facts/:id/not-true                  forget it and never learn it again from the same words
//   POST   /api/facts/suggestions/:n/accept {daysBefore?}   a planner reminder before the date
//   POST   /api/facts/suggestions/:n/dismiss
//   POST   /api/facts/ask {question}                ask your documents: {found, quotes:[{docId,name,page,quote,cite}]}
import { askDocuments, FACT_GROUPS, factsFor, FactsError } from '../facts.ts';
import { HttpError, readJson, send } from '../http.ts';
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
      if (err instanceof FactsError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(405, 'Method not allowed');
  };
}

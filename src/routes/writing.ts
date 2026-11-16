// S11 (docs/WRITING_STYLE.md): "Write like a person", in each person's own space (the owner's, or a
// household member's own store.db; never the demo). A child gets coaching instead of a rewrite.
//   GET    /api/writing              {style, card}
//   PUT    /api/writing              {style: 'natural'|'as-written'} → {style, card}
//   POST   /api/writing/voice        {samples?: string[], libraryIds?: number[]} (1-5 in all) → {card}
//   DELETE /api/writing/voice        forget the style card
//   POST   /api/writing/check        {text} → the "reads natural" check (no model)
//   POST   /api/writing/humanize     {text | madeId | researchId, voice?, words?} → before/after, scores, facts, changes
//   POST   /api/writing/keep         {madeId | researchId, text} → a new version of the document / the report replaced
import { DocError, madeDocs, makeDocument } from '../documents/make.ts';
import { HttpError, readJson, send } from '../http.ts';
import { checkText, extractStyleCard, humanize, HUMANIZE_MAX_CHARS, isChild, writingFor, type WritingStyle } from '../humanize.ts';
import { ResearchError } from '../research.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWritingRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'writing' || c !== undefined) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    const prefs = writingFor(app);
    const body = async () => {
      const x = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(400, 'Send an object.');
      return x;
    };
    const research = () => {
      if (ctx.opts.member || !app.research) throw new HttpError(403, 'Only the owner of this server can use this.');
      return app.research;
    };
    try {
      if (b === undefined) {
        if (method === 'GET') return send(res, 200, prefs.get());
        if (method === 'PUT') {
          const x = await body();
          prefs.setStyle(String(x.style) as WritingStyle);
          return send(res, 200, prefs.get());
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (b === 'voice') {
        if (method === 'DELETE') {
          prefs.setCard(null);
          return send(res, 200, { ok: true });
        }
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const x = await body();
        const samples = Array.isArray(x.samples) ? x.samples.map(String) : [];
        const ids = Array.isArray(x.libraryIds) ? x.libraryIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        for (const id of ids.slice(0, 5)) {
          if (!app.library?.get(id)) throw new HttpError(404, 'That document is not in your Library.');
          samples.push(app.library.text(id, 20_000));
        }
        const card = { ...extractStyleCard(samples), updatedAt: app.now().toISOString() };
        prefs.setCard(card);
        return send(res, 200, { card });
      }
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const x = await body();
      if (b === 'check') {
        const text = String(x.text ?? '');
        if (!text.trim()) throw new HttpError(400, 'There is no text to rewrite.');
        return send(res, 200, checkText(text.slice(0, HUMANIZE_MAX_CHARS)));
      }
      const madeId = Number(x.madeId);
      const researchId = Number(x.researchId);
      const made = madeId > 0 ? madeDocs(app).get(madeId) : undefined;
      if (madeId > 0 && !made) throw new HttpError(404, 'That document is not here.');
      if (b === 'humanize') {
        let text = String(x.text ?? '');
        if (made) {
          if (made.spec.sheets || made.spec.slides || made.spec.filled) throw new HttpError(400, 'Spreadsheets, slides and filled-in forms keep their words as they are.');
          text = made.spec.content;
        } else if (researchId > 0) {
          const run = research().get(researchId);
          if (!run?.report) throw new HttpError(409, 'The report isn’t written yet.');
          text = run.report;
        }
        const words = Number(x.words);
        const r = await humanize(app, text, { voice: x.voice === true, ...(words > 0 ? { targetWords: Math.round(words) } : {}) });
        return send(res, 200, { ...r, child: isChild(app), hasCard: Boolean(prefs.get().card) });
      }
      if (b === 'keep') {
        if (isChild(app)) throw new HttpError(403, 'Coaching only: make the changes in your own words.');
        const text = String(x.text ?? '');
        if (!text.trim()) throw new HttpError(400, 'There is no text to rewrite.');
        if (made) {
          const { made: next } = makeDocument(app, { basedOn: made.id, content: text }, { ...(made.conversationId ? { conversationId: made.conversationId } : {}), keep: true });
          return send(res, 200, { made: { id: next.id, version: next.version, title: next.title, format: next.format } });
        }
        if (researchId > 0) {
          const run = research().replaceReport(researchId, text);
          return send(res, 200, { research: { id: run.id } });
        }
        throw new HttpError(400, 'Say which document or report to keep it in.');
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof DocError) throw new HttpError(400, err.message);
      if (err instanceof ResearchError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
}

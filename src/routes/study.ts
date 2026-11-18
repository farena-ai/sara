// U4.23 (docs/LEARNING.md "Learning coach"): the Study page (Library → Study), each person's own
// (a household member's sets live in their own space). Never the demo.
//   GET    /api/study                          {sets: [set + progress], due, prefs, kid}
//   GET    /api/study/docs                     Library documents with their chapters (the make form)
//   PUT    /api/study/prefs                    {remind?, remindAt?, newPerDay?, maxCards?} → {prefs}
//   POST   /api/study                          {text? | docId?, section?, title?} → {set}
//   POST   /api/study/import?format=csv|anki&title=…   raw text body → {set}
//   GET    /api/study/:id                      {set, cards, progress, next}
//   PATCH  /api/study/:id                      {title}
//   DELETE /api/study/:id
//   GET    /api/study/:id/export?format=csv|anki        the file
//   POST   /api/study/cards/:cid/review        {grade: 1|3|4|5} → {card, next}
//   POST   /api/study/cards/:cid/answer        {answer} → {result, next}
//   POST   /api/study/cards/:cid/reveal        {step} → {step, text}
import { HttpError, readJson, readRaw, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { fromAnki, fromCsv, StudyError, studyFor, toAnki, toCsv, type Card } from '../study.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createStudyRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof StudyError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const int = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'study') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = studyFor(app);
    const kid = Boolean(app.member?.child?.());
    // Kid mode: an unseen card's answer is not sent with the list (hints come first, from /reveal).
    const cardView = (x: Card) => (kid ? { ...x, back: x.reps > 0 ? x.back : '' } : x);
    const nextOf = (setId?: number) => {
      const n = s.next(setId);
      return n ? cardView(n) : null;
    };
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (!b && method === 'GET') {
      return send(res, 200, { sets: s.list().map((x) => ({ ...x, progress: s.progress(x.id) })), due: s.dueCount(), prefs: s.prefs(), kid });
    }
    if (b === 'docs' && !c && method === 'GET') {
      const lib = app.library;
      const docs = (lib?.list() ?? []).filter((x) => x.status === 'ready').slice(0, 200).map((x) => ({ id: x.id, title: x.title || x.name, sections: lib!.sections(x.id).slice(0, 80).map((y) => ({ id: y.id, title: y.title, level: y.level })) }));
      return send(res, 200, { docs });
    }
    if (b === 'prefs' && !c && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { prefs: s.setPrefs(body as never) });
    }
    if (b === 'import' && !c && method === 'POST') {
      const raw = (await readRaw(req, 4_000_000)).toString('utf8');
      const drafts = q.get('format') === 'csv' || (!raw.startsWith('#') && /^front,/i.test(raw)) ? fromCsv(raw) : fromAnki(raw);
      return send(res, 200, { set: await wrap(() => s.importCards(q.get('title') ?? '', drafts)) });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const set = await wrap(() => s.make({ ...(typeof body.text === 'string' ? { text: body.text.slice(0, 200_000) } : {}), ...(int(body.docId) ? { docId: int(body.docId) } : {}), ...(int(body.section) ? { section: int(body.section) } : {}), ...(typeof body.title === 'string' ? { title: body.title } : {}) }));
      return send(res, 200, { set });
    }
    if (b === 'cards') {
      const cid = int(c);
      if (!cid || method !== 'POST') throw new HttpError(404, 'Not found');
      const body = await readJson(req);
      const card = s.card(cid);
      if (!card) throw new HttpError(404, T('Card not found.'));
      if (d === 'review') return send(res, 200, { card: cardView(await wrap(() => s.review(cid, Number(body.grade)))), next: nextOf(card.setId) });
      if (d === 'answer') return send(res, 200, { result: await wrap(() => s.answer(cid, String(body.answer ?? ''))), next: nextOf(card.setId) });
      if (d === 'reveal') return send(res, 200, await wrap(() => s.reveal(cid, Number(body.step ?? 0))));
      throw new HttpError(404, 'Not found');
    }
    const id = int(b);
    if (!id) throw new HttpError(404, 'Not found');
    const set = s.get(id);
    if (!set) throw new HttpError(404, T('Study set not found.'));
    if (!c && method === 'GET') return send(res, 200, { set, cards: s.cards(id).map(cardView), progress: s.progress(id), next: nextOf(id) });
    if (!c && method === 'PATCH') {
      const body = await readJson(req);
      return send(res, 200, { set: await wrap(() => s.rename(id, String(body.title ?? ''))) });
    }
    if (!c && method === 'DELETE') {
      await wrap(() => s.remove(id));
      return send(res, 200, { ok: true });
    }
    if (c === 'export' && method === 'GET') {
      const anki = q.get('format') !== 'csv';
      const cards = s.cards(id);
      const body = anki ? toAnki(cards) : toCsv(cards);
      const name = `${set.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'study'}.${anki ? 'txt' : 'csv'}`;
      res.writeHead(200, { 'Content-Type': `${anki ? 'text/plain' : 'text/csv'}; charset=utf-8`, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    throw new HttpError(404, 'Not found');
  };
}

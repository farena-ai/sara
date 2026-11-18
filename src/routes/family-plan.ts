// U4.21 (docs/FAMILY.md "Home and family planner"): the planner's routes under /api/family (the
// member route `family`, audited; never the demo). Parents change the plan; everyone reads it; a
// person's private events and own likes/allergies are theirs (parents see everyone's allergies).
// Pages and iCal links are fetched through netFetch, never in private local mode.
//   GET    /api/family/week?start=YYYY-MM-DD        {week, prefs, recipes, pending, settings, rotas}
//   PUT    /api/family/meals/:day                   {title?, recipeId?, ingredients?, note?} · DELETE
//   POST   /api/family/meals/shopping               {start, listId?}  (into a grocery list)
//   GET    /api/family/recipes · POST {text | url | libraryId | title + ingredients} · DELETE /:id
//   PUT    /api/family/prefs/:person                {likes?, dislikes?, allergies?}
//   PUT    /api/family/plan-settings                {dinnerTime?, reminders?, remindAt?, rotaDay?}
//   PUT    /api/family/rota/:choreId                {people: [ids]}
//   POST   /api/family/events                       {title, start, end?, who: 'family' | 'me'} · DELETE /:id
//   POST   /api/family/events/import                {text | ics | url | libraryId, source?}  (pending)
//   POST   /api/family/events/decide                {ids, ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { linkUrl } from '../calendar-links.ts';
import type { FamilyAccess } from '../family.ts';
import { eventsFromIcs, eventsFromText, planOf, recipeFromHtml, weekStartOf, type FoundEvent } from '../family-plan.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { netFetch, privateLocalOn } from '../net-guard.ts';
import type { AppContext } from '../chat.ts';
import { NEXT } from './context.ts';

const MAX_PAGE = 3_000_000;
async function fetchText(raw: string, T: (s: string) => string): Promise<string> {
  if (privateLocalOn()) throw new HttpError(409, T(en('Private local mode is on: paste the text instead.')));
  let url: URL;
  try {
    url = linkUrl(raw.replace(/^http:\/\//i, 'https://'));
  } catch {
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, T(en('That doesn’t look like a web address.')));
    }
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, T(en('That doesn’t look like a web address.')));
  let res: Response;
  try {
    res = await netFetch(url, { headers: { accept: 'text/html,text/calendar,*/*' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new HttpError(502, T(en('That page didn’t answer.')));
  }
  if (!res.ok) throw new HttpError(502, T(en('That page didn’t answer.')));
  const text = await res.text();
  return text.slice(0, MAX_PAGE);
}

export async function familyPlanRoutes(app: AppContext, f: FamilyAccess, T: (s: string) => string, req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<unknown> {
  const [, b, c, d] = parts;
  const plan = planOf(f.store);
  const me = f.person;
  const tz = f.tz();
  const known = () => f.people().map((p) => p.id);
  const libText = (id: unknown): string => {
    const doc = Number(id);
    const lib = app.library;
    if (!lib || !Number.isInteger(doc) || !lib.get(doc)) throw new HttpError(404, T(en('That document is gone.')));
    return lib.text(doc, 200_000);
  };

  if (b === 'week' && !c && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('start') ?? '';
    const start = /^\d{4}-\d{2}-\d{2}$/.test(q) ? weekStartOf(new Date(`${q}T12:00:00Z`), 'UTC') : weekStartOf(app.now(), tz);
    return send(res, 200, { week: plan.week(me, start, tz, f.people()), thisWeek: weekStartOf(app.now(), tz), today: plan.today(me, app.now(), tz), prefs: plan.prefs(me), recipes: plan.recipes().map((r) => ({ id: r.id, title: r.title, n: r.ingredients.length, source: r.source })), pending: plan.pending(me), settings: plan.settings(), rotas: f.store.isParent(me) ? plan.rotas() : {} });
  }
  if (b === 'meals' && c === 'shopping' && !d && method === 'POST') {
    const body = await readJson(req);
    if (!f.boards) throw new HttpError(404, 'Not found');
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start ?? '')) ? String(body.start) : weekStartOf(app.now(), tz);
    const lines = plan.shopping(start);
    if (!lines.length) throw new HttpError(400, T(en('No ingredients this week yet: give the dinners a recipe first.')));
    return send(res, 200, plan.toGrocery(me, start, f.boards, known(), typeof body.listId === 'string' ? body.listId : undefined));
  }
  if (b === 'meals' && c && !d) {
    if (method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, plan.setMeal(me, c, { title: body.title, recipeId: body.recipeId, ingredients: body.ingredients, note: body.note }, f.people()));
    }
    if (method === 'DELETE') return send(res, 200, { ok: plan.clearMeal(me, c) });
  }
  if (b === 'recipes') {
    if (!c && method === 'GET') return send(res, 200, { recipes: plan.recipes() });
    if (!c && method === 'POST') {
      const body = await readJson(req);
      if (!f.store.isParent(me)) throw new HttpError(403, T(en('Only a parent can do that.')));
      if (typeof body.url === 'string' && body.url.trim()) {
        const parsed = recipeFromHtml(await fetchText(body.url.trim(), T));
        if (!parsed) throw new HttpError(422, T(en('That page has no recipe I can read. Paste the recipe text instead.')));
        return send(res, 200, { recipe: plan.addRecipe(me, { title: body.title, parsed, source: body.url.trim() }) });
      }
      if (body.libraryId !== undefined) return send(res, 200, { recipe: plan.addRecipe(me, { title: body.title, text: libText(body.libraryId), source: `library:${Number(body.libraryId)}` }) });
      return send(res, 200, { recipe: plan.addRecipe(me, { title: body.title, text: body.text, ingredients: body.ingredients, source: body.source }) });
    }
    if (c && !d && method === 'DELETE') return send(res, 200, { ok: plan.removeRecipe(me, Number(c)) });
  }
  if (b === 'prefs' && c && !d && method === 'PUT') {
    const body = await readJson(req);
    return send(res, 200, { prefs: plan.setPrefs(me, c, body, known()) });
  }
  if (b === 'plan-settings' && !c && method === 'PUT') {
    const body = await readJson(req);
    return send(res, 200, { settings: plan.setSettings(me, body) });
  }
  if (b === 'rota' && c && !d && method === 'PUT') {
    const body = await readJson(req);
    return send(res, 200, { people: plan.setRota(me, Number(c), body.people, known()) });
  }
  if (b === 'events') {
    if (!c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { event: plan.addEvent(me, { title: body.title, start: body.start, end: body.end, who: body.who }) });
    }
    if (c === 'import' && !d && method === 'POST') {
      const body = await readJson(req);
      if (!f.store.isParent(me)) throw new HttpError(403, T(en('Only a parent can do that.')));
      let found: FoundEvent[];
      const now = app.now();
      if (typeof body.ics === 'string' && body.ics.includes('BEGIN:VCALENDAR')) found = eventsFromIcs(body.ics.slice(0, MAX_PAGE), now, tz);
      else if (typeof body.url === 'string' && body.url.trim()) {
        const text = await fetchText(body.url.trim(), T);
        if (!text.includes('BEGIN:VCALENDAR')) throw new HttpError(422, T(en('That calendar link didn’t answer like a calendar.')));
        found = eventsFromIcs(text, now, tz);
      } else if (body.libraryId !== undefined) found = eventsFromText(libText(body.libraryId), now);
      else found = eventsFromText(String(body.text ?? '').slice(0, 200_000), now);
      if (!found.length) throw new HttpError(422, T(en('No dates found. Each event needs a date on its line.')));
      return send(res, 200, { pending: plan.importEvents(me, found, body.source ?? (body.url ? new URL(String(body.url).replace(/^webcals?:/i, 'https:')).hostname : '')) });
    }
    if (c === 'decide' && !d && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { n: plan.decide(me, body.ids, body.ok === true) });
    }
    if (c && !d && method === 'DELETE') return send(res, 200, { ok: plan.removeEvent(me, Number(c)) });
  }
  return NEXT;
}

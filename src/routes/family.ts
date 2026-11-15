// R8 (docs/FAMILY.md): the Family page. One household store (src/family.ts); every call names the
// person asking (this space), and only parents change chores, approve, record payouts or read a kid's
// activity summary. Never the demo. Kid-safe member mode itself is set by the owner here or on the
// Household page; it is enforced in src/household.ts (routes), main.ts (tools) and chat.ts (her tone).
//   GET    /api/family                                  {me, people, kids, chores, waiting, recent, grocery, options}
//   POST   /api/family/chores                           {title, assignee, points?, amount?, repeat?, dueAt?, photo?}
//   PATCH  /api/family/chores/:id · DELETE /api/family/chores/:id
//   POST   /api/family/chores/:id/done                  {note?, photo? (data URL)}
//   GET    /api/family/marks/:id/photo
//   POST   /api/family/marks/:id/approve · /reject      {note?}
//   GET    /api/family/kids/:id                         {balance, ledger, activity (parents)}
//   POST   /api/family/kids/:id/pay                     {amount, note?}  (a record only)
//   PUT    /api/family/kids/:id/profile                 {child | null}   (the owner)
//   PUT    /api/family/parents/:id                      {on}             (the owner)
//   GET    /api/family/grocery · POST /api/family/grocery {name}
//   GET    /api/family/grocery/:id
//   POST   /api/family/grocery/:id/items                {title, aisle?, store?}
//   PATCH  /api/family/grocery/:id/items/:ref           {aisle?, store?, done?} · DELETE …/items/:ref
//   POST   /api/family/grocery/:id/cheapest             {refs?}          (find_product; the owner's space)
import { AGE_BANDS, AISLES, cheapestLine, CHORE_REPEATS, FamilyError, KID_MINUTES, kidsOf, OTHER_AISLE, STAPLES } from '../family.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { en, trOwner } from '../i18n.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const MAX_PHOTO_BODY = 6 * 1024 * 1024;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

export function createFamilyRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof FamilyError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'family') return NEXT;
    const f = app.family;
    if (ctx.opts.demo || !f) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const me = f.person;
    const parent = f.store.isParent(me);
    const people = () => f.people();
    const known = () => people().map((p) => p.id);
    const tz = f.tz();
    const mustParent = () => {
      if (!parent) throw new HttpError(403, T(en('Only a parent can do that.')));
    };
    const kidView = (id: string) => {
      const p = people().find((x) => x.id === id);
      return { id, name: p?.name ?? id, band: p?.child?.band ?? null, profile: parent ? (p?.child ?? null) : null, ...f.store.balance(parent ? me : id, id) };
    };
    const groceryLists = () => (f.boards ? f.store.groceryIds().map((id) => f.store.groceryView(f.boards!, me, id)).filter((v): v is NonNullable<typeof v> => Boolean(v)).map((v) => ({ id: v.id, name: v.name, open: v.open, members: v.members })) : []);
    const groceryInvites = () => (f.boards ? f.boards.invitesFor(me).filter((i) => f.store.isGrocery(i.boardId)) : []);

    if (!b && method === 'GET') {
      const kids = kidsOf(f);
      const mine = people().find((p) => p.id === me);
      return send(res, 200, {
        me: { person: me, parent, child: Boolean(mine?.child), owner: me === 'owner', name: mine?.name ?? '' },
        people: people().map((p) => ({ id: p.id, name: p.name, child: Boolean(p.child), parent: f.store.isParent(p.id) })),
        kids: parent ? kids.map((k) => kidView(k.id)) : mine?.child || f.store.chores(me).length ? [kidView(me)] : [],
        chores: f.store.chores(me, { all: parent }),
        waiting: f.store.marks(me, { status: 'waiting', limit: 30 }),
        recent: f.store.marks(me, { limit: 20 }).filter((m) => m.status !== 'waiting'),
        grocery: groceryLists(),
        groceryInvites: groceryInvites(),
        options: { repeats: CHORE_REPEATS, bands: AGE_BANDS, minutes: KID_MINUTES, aisles: [...AISLES, OTHER_AISLE].map((x) => ({ id: x.id, name: x.name })) },
      });
    }

    // ------------------------------------------------------------ chores
    if (b === 'chores') {
      if (!c && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { chore: await wrap(() => f.store.addChore(me, { title: body.title, assignee: body.assignee, points: body.points, amount: body.amount, repeat: body.repeat, dueAt: body.dueAt, photo: body.photo, tz }, known())) });
      }
      const id = Number(c);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      if (!d && method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, { chore: await wrap(() => f.store.updateChore(me, id, body, known())) });
      }
      if (!d && method === 'DELETE') {
        if (!(await wrap(() => f.store.removeChore(me, id)))) throw new HttpError(404, T(en('That chore is gone.')));
        return send(res, 200, { ok: true });
      }
      if (d === 'done' && !e && method === 'POST') {
        const body = await readJson(req, MAX_PHOTO_BODY);
        let photo: Buffer | undefined;
        if (typeof body.photo === 'string' && body.photo) {
          const m = PHOTO_RE.exec(body.photo);
          if (!m) throw new HttpError(400, T(en('That photo can’t be read. Use a JPEG, PNG or WebP picture.')));
          photo = Buffer.from(m[2]!, 'base64');
        }
        return send(res, 200, { mark: await wrap(() => f.store.markDone(me, id, { note: body.note, ...(photo ? { photo } : {}), tz })) });
      }
    }

    // ------------------------------------------------------------ marks (approve, reject, photo)
    if (b === 'marks') {
      const id = Number(c);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      if (d === 'photo' && !e && method === 'GET') {
        const img = f.store.photo(me, id);
        if (!img) throw new HttpError(404, T(en('No photo.')));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(img);
      }
      if ((d === 'approve' || d === 'reject') && !e && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { mark: await wrap(() => (d === 'approve' ? f.store.approve(me, id) : f.store.reject(me, id, body.note))) });
      }
    }

    // ------------------------------------------------------------ kids: balance, ledger, payouts, activity, profile
    if (b === 'kids' && c) {
      if (!known().includes(c)) throw new HttpError(404, T(en('No such person.')));
      if (!d && method === 'GET') {
        if (!parent && c !== me) throw new HttpError(403, T(en('Only a parent can see that.')));
        return send(res, 200, { kid: kidView(c), ledger: await wrap(() => f.store.ledger(me, c, 50)), ...(parent ? { activity: f.store.activity(me, c, app.now(), tz) } : {}) });
      }
      if (d === 'pay' && !e && method === 'POST') {
        const body = await readJson(req);
        const row = await wrap(() => f.store.pay(me, c, body.amount, body.note));
        return send(res, 200, { entry: row, kid: kidView(c) });
      }
      if (d === 'profile' && !e && method === 'PUT') {
        const body = await readJson(req);
        if (me !== 'owner' || !f.setChild) throw new HttpError(403, T(en('Only the owner of this server can change this.')));
        if (c === 'owner') throw new HttpError(400, T(en('The owner can’t be a child.')));
        await wrap(() => f.setChild!(c, body.child ?? null));
        return send(res, 200, { kid: kidView(c), person: people().find((p) => p.id === c) ?? null });
      }
    }
    if (b === 'parents' && c && !d && method === 'PUT') {
      const body = await readJson(req);
      if (me !== 'owner') throw new HttpError(403, T(en('Only the owner of this server can change this.')));
      const p = people().find((x) => x.id === c);
      if (!p || p.child) throw new HttpError(400, T(en('Only a grown-up can be a parent here.')));
      f.store.setParent(c, body.on === true);
      return send(res, 200, { ok: true, parents: f.store.parents() });
    }

    // ------------------------------------------------------------ grocery lists (shared lists with aisles and stores)
    if (b === 'grocery') {
      const boards = f.boards;
      if (!boards) throw new HttpError(404, 'Not found');
      if (!c && method === 'GET') return send(res, 200, { lists: groceryLists(), invites: groceryInvites() });
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const name = String(body.name ?? '').trim() || T(en('Groceries'));
        // Shared with the whole household (they accept the invitation; kids too, to tick things off).
        const others = Array.isArray(body.people) ? body.people.map(String) : known().filter((p) => p !== me);
        const board = await wrap(() => boards.create(me, name.slice(0, 80), others, known()));
        f.store.markGrocery(board.id, me);
        return send(res, 200, { list: f.store.groceryView(boards, me, board.id) });
      }
      if (!c) throw new HttpError(404, 'Not found');
      if (!f.store.isGrocery(c)) throw new HttpError(404, T(en('That list is gone.')));
      const view = () => {
        const v = f.store.groceryView(boards, me, c);
        if (!v) throw new HttpError(404, T(en('That list is gone.')));
        return v;
      };
      if (!d && method === 'GET') return send(res, 200, { list: view() });
      if (d === 'items' && !e && method === 'POST') {
        const body = await readJson(req);
        const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) throw new HttpError(400, T(en('Type what to buy.')));
        view();
        const card = boards.addCard(me, c, { title });
        if (!card) throw new HttpError(404, T(en('That list is gone.')));
        if (body.aisle !== undefined || body.store !== undefined) f.store.setItemMeta(c, card.ref, { aisle: body.aisle, store: body.store });
        return send(res, 200, { list: view() });
      }
      if (d === 'items' && e && method === 'PATCH') {
        const body = await readJson(req);
        if (!boards.card(me, e)) throw new HttpError(404, T(en('That item is gone.')));
        if (body.done !== undefined) boards.update(me, e, { status: body.done === true ? 'done' : 'open' });
        if (body.aisle !== undefined || body.store !== undefined) f.store.setItemMeta(c, e, { aisle: body.aisle, store: body.store });
        return send(res, 200, { list: view() });
      }
      if (d === 'items' && e && method === 'DELETE') {
        if (!boards.deleteCard(me, e)) throw new HttpError(404, T(en('That item is gone.')));
        return send(res, 200, { list: view() });
      }
      if (d === 'cheapest' && !e && method === 'POST') {
        const body = await readJson(req);
        const tool = app.tools.get('find_product');
        if (!tool || tool.isAvailable?.() === false || app.member?.child?.()) throw new HttpError(403, T(en('Price checks are only in the owner’s space, with the shopping helper on.')));
        const v = view();
        const want = new Set(Array.isArray(body.refs) ? body.refs.map(String) : []);
        const items = v.aisles.flatMap((x) => x.items).filter((i) => !i.done && (want.size ? want.has(i.ref) : STAPLES.test(i.title))).slice(0, 4);
        const results: { ref: string; title: string; store?: string; price?: string; error?: string }[] = [];
        for (const it of items) {
          try {
            const out = await tool.run({ what: it.title, near: true, online: false }, { workspaceDir: app.dataDir, signal: AbortSignal.timeout(90_000), sandbox: app.sandbox, conversationId: 'family-grocery' });
            const best = cheapestLine(out);
            if (best) f.store.setItemMeta(c, it.ref, { store: best.store, price: best.price, checkedAt: app.now().toISOString() });
            results.push({ ref: it.ref, title: it.title, ...(best ?? { error: T(en('No price I could confirm.')) }) });
          } catch (err) {
            results.push({ ref: it.ref, title: it.title, error: String((err as Error).message).slice(0, 200) });
          }
        }
        return send(res, 200, { list: view(), results });
      }
    }
    throw new HttpError(404, 'Not found');
  };
}

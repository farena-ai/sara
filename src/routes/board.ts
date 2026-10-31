// Phase 99 (ST4, docs/design/STAPLES.md §7.7): the board's routes. Boards are views over the
// planner's tasks (src/board.ts); shared household boards (ids "s<n>") live in the shared store
// (src/shared-boards.ts) and answer only their members (404 for anyone else). Members use these
// routes in their own space (household.ts MEMBER_ROUTES: boards, columns; tasks already).
// The demo gets a sample board per visitor (in memory) and a scripted run for Assign.
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { boardFor, type BoardStore, type ColumnRole, EVERYTHING, LABEL_COLORS, ROLES } from '../board.ts';
import { boardSettings, CONCURRENT_CHOICES } from '../board-work.ts';
import { HttpError, readJson, send } from '../http.ts';
import { parseWhen, PlannerStore, REPEATS, type Repeat } from '../planner.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const CARD_ACTIONS = new Set(['move', 'assign', 'work', 'answer', 'activity', 'card', 'check', 'comment']);
/** Card routes the demo answers (in its own sample board). */
export const DEMO_CARD_ACTIONS: ReadonlySet<string> = CARD_ACTIONS;

const localId = (v: unknown): number | undefined => (/^\d{1,12}$/.test(String(v)) ? Number(v) : undefined);
const sharedId = (v: unknown): string | undefined => (/^s\d{1,12}$/.test(String(v)) ? String(v) : undefined);
const optNum = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : undefined);

// ---------------- the demo's sample board ----------------

interface DemoSpace {
  board: BoardStore;
  at: number;
  timers: ReturnType<typeof setTimeout>[];
}
const demoSpaces = new Map<string, DemoSpace>();
function demoBoard(key: string): DemoSpace {
  const now = Date.now();
  for (const [k, v] of demoSpaces) if (now - v.at > 6 * 3600_000) (v.timers.forEach(clearTimeout), demoSpaces.delete(k));
  let sp = demoSpaces.get(key);
  if (sp) {
    sp.at = now;
    return sp;
  }
  if (demoSpaces.size >= 300) {
    const oldest = [...demoSpaces.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    oldest[1].timers.forEach(clearTimeout);
    demoSpaces.delete(oldest[0]);
  }
  const planner = new PlannerStore(new DatabaseSync(':memory:'));
  const board = boardFor(planner);
  const pid = planner.projectId('Garden party')!;
  const b = board.forProject(pid);
  board.setLabels(b.id, [{ name: 'Food', color: 'orange' }, { name: 'Guests', color: 'blue' }, { name: 'Outside', color: 'green' }, { name: 'Urgent', color: 'red' }]);
  const cols = board.columns(b.id);
  const col = (r: ColumnRole) => cols.find((c) => c.role === r)!.id;
  const day = (n: number) => new Date(now + n * 86_400_000).toISOString();
  board.addCard(b.id, { title: 'Send the invitations', labels: ['Guests'], dueAt: day(1), notes: '- [x] Make the guest list\n- [ ] Write the invitation\n- [ ] Send it' });
  board.addCard(b.id, { title: 'Find three lemonade recipes', labels: ['Food'], notes: 'Something without too much sugar.' });
  board.addCard(b.id, { title: 'Borrow folding chairs', labels: ['Outside'], dueAt: day(3) });
  board.addCard(b.id, { title: 'Book the bouncy castle', labels: ['Outside', 'Urgent'], columnId: col('doing'), dueAt: day(-1) });
  board.addCard(b.id, { title: 'Pick a date', columnId: col('done') });
  sp = { board, at: now, timers: [] };
  demoSpaces.set(key, sp);
  return sp;
}
/** The demo's Assign → Sara: a scripted run (no model): reading, two steps, Done with receipts. */
function demoRun(sp: DemoSpace, id: number, publish: () => void): void {
  const b = sp.board;
  const start = new Date().toISOString();
  const steps: [number, () => void][] = [
    [0, () => (b.moveToRole(id, 'doing', 'sara'), b.setWork(id, { kind: 'turn', conversationId: '', startedAt: start, state: 'running', line: 'Reading the card', by: 'owner' }))],
    [1500, () => b.setWork(id, { kind: 'turn', conversationId: '', startedAt: start, state: 'running', line: 'Searching the web: lemonade recipes', by: 'owner', used: { tokens: 1800, steps: 1 } })],
    [3200, () => b.setWork(id, { kind: 'turn', conversationId: '', startedAt: start, state: 'running', line: 'Saving a note: three recipes', by: 'owner', used: { tokens: 4200, steps: 2 } })],
    [4800, () => {
      b.setWork(id, { kind: 'turn', conversationId: '', startedAt: start, state: 'done', line: 'I found three recipes and saved them in a note.', by: 'owner', used: { tokens: 5100, steps: 3 }, endedAt: new Date().toISOString(), receipts: [{ tool: 'web_search', summary: 'lemonade recipes low sugar: 8 results', status: 'ok' }, { tool: 'note', summary: 'Saved note "Three lemonades"', status: 'ok' }] });
      b.log(id, 'sara', 'receipt', { receipts: ['web_search: lemonade recipes low sugar', 'note: Saved note "Three lemonades"'] });
      b.moveToRole(id, 'done', 'sara');
    }],
  ];
  for (const [ms, fn] of steps) {
    const tm = setTimeout(() => {
      fn();
      publish();
    }, ms);
    tm.unref?.();
    sp.timers.push(tm);
  }
}

export function createBoardRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, visitorKey } = ctx;
  const sb = () => app.sharedBoards;
  const person = () => sb()?.person ?? 'owner';
  const known = () => sb()?.people().map((p) => p.id) ?? [];
  const nameOf = (id: string) => sb()?.people().find((p) => p.id === id)?.name ?? '';

  function local(req: IncomingMessage): { board: BoardStore; demo?: DemoSpace } {
    if (opts.demo) {
      const sp = demoBoard(visitorKey(req));
      return { board: sp.board, demo: sp };
    }
    if (!app.board) throw new HttpError(404, 'The board is not available here.');
    return { board: app.board };
  }
  const whenOrNull = (v: unknown): string | null => {
    if (v === undefined || v === null || v === '') return null;
    const d = parseWhen(String(v), app.now(), app.settings.get().timeZone, { dateOnlyHour: 17 });
    if (!d) throw new HttpError(400, 'Couldn\'t understand the time "{time}"', { params: { time: String(v) } });
    return d.toISOString();
  };
  const bad = (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    const m = (err as Error).message;
    throw new HttpError(/not found|No such/i.test(m) ? 404 : 400, m);
  };
  /** Local cards carry a ref (the id as text) like shared ones, so the app treats both the same. */
  const withRef = <T extends { id: number | string }>(c: T) => ({ ...c, ref: String(c.id) });
  const people = () => (sb()?.people() ?? []).filter((p) => p.id !== person());

  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;

    // ---------------- boards ----------------
    if (a === 'boards') {
      const { board, demo } = local(req);
      if (!b && method === 'GET') {
        const mine = board.boards();
        const counts = (id: number) => {
          const v = board.view(id)!;
          const done = new Set(v.columns.filter((x) => x.role === 'done').map((x) => x.id));
          return { open: v.cards.filter((x) => !done.has(x.columnId)).length, waiting: v.cards.filter((x) => x.work?.state === 'waiting').length };
        };
        const shared = demo ? [] : (sb()?.store.boardsFor(person()) ?? []);
        return send(res, 200, {
          boards: [{ ...board.board(EVERYTHING)!, ...counts(EVERYTHING) }, ...mine.map((x) => ({ ...x, ...counts(x.id) })), ...shared.map((x) => ({ ...x, members: x.members.map((m) => ({ ...m, name: nameOf(m.person) })) }))],
          invites: demo ? [] : (sb()?.store.invitesFor(person()) ?? []).map((i) => ({ ...i, fromName: nameOf(i.from) })),
          people: demo ? [] : people(),
          settings: demo ? { concurrent: 2 } : boardSettings(app),
          workers: demo ? [{ id: 'sara', name: app.persona.name }] : (app.cardWork?.workers() ?? []),
          labelColors: LABEL_COLORS,
          roles: ROLES,
          demo: Boolean(opts.demo),
        });
      }
      if (!b && method === 'POST') {
        const body = await readJson(req);
        if (body.shared === true || Array.isArray(body.people)) {
          if (demo || !sb()) throw new HttpError(400, 'Shared boards need household members (Settings → Household).');
          try {
            return send(res, 201, sb()!.store.create(person(), String(body.name ?? ''), (Array.isArray(body.people) ? body.people : []).map(String), known()));
          } catch (err) {
            return bad(err);
          }
        }
        try {
          return send(res, 201, board.createBoard(String(body.name ?? '')));
        } catch (err) {
          return bad(err);
        }
      }
      if (b === 'settings' && !c && method === 'PUT') {
        if (demo) throw new HttpError(403, 'Not in the demo.');
        const body = await readJson(req);
        const n = Number(body.concurrent);
        if (!CONCURRENT_CHOICES.includes(n as 1)) throw new HttpError(400, 'Pick 1 to 4 cards at once.');
        app.settings.update({ board: { ...boardSettings(app), concurrent: n } } as never);
        return send(res, 200, boardSettings(app));
      }
      if (b === 'invites' && c && (d === 'accept' || d === 'decline') && method === 'POST') {
        const store = sb()?.store;
        if (demo || !store || !(d === 'accept' ? store.accept(person(), c) : store.decline(person(), c))) throw new HttpError(404, 'No such invitation.');
        return send(res, 200, { ok: true });
      }
      const sid = sharedId(b);
      if (sid) {
        const store = sb()?.store;
        if (demo || !store) throw new HttpError(404, 'Board not found');
        const me = person();
        if (!c && method === 'GET') {
          const v = store.view(me, sid);
          if (!v) throw new HttpError(404, 'Board not found');
          return send(res, 200, { ...v, board: { ...v.board, members: v.board.members.map((m) => ({ ...m, name: nameOf(m.person) })) }, me });
        }
        try {
          if (!c && method === 'PUT') {
            const body = await readJson(req);
            // Membership first: a PUT that changes nothing must not tell a stranger the board exists.
            if (!store.board(me, sid)) throw new HttpError(404, 'Board not found');
            if (body.labels !== undefined && !store.setLabels(me, sid, body.labels)) throw new HttpError(404, 'Board not found');
            if (body.name !== undefined && !store.rename(me, sid, String(body.name))) throw new HttpError(404, 'Board not found');
            return send(res, 200, store.board(me, sid) ?? {});
          }
          if (!c && method === 'DELETE') {
            if (!store.remove(me, sid, sb()!.copyToPlanner)) throw new HttpError(404, 'Board not found');
            return send(res, 200, { ok: true });
          }
          if (c === 'columns' && method === 'POST') {
            const body = await readJson(req);
            if (!store.addColumn(me, sid, String(body.name ?? ''), (ROLES.includes(body.role as ColumnRole) ? body.role : 'other') as ColumnRole, optNum(body.wipLimit) ?? null)) throw new HttpError(404, 'Board not found');
            return send(res, 201, { ok: true });
          }
          if (c === 'cards' && method === 'POST') {
            const body = await readJson(req);
            const card = store.addCard(me, sid, { title: String(body.title ?? ''), notes: body.notes ? String(body.notes) : '', dueAt: whenOrNull(body.due), ...(optNum(body.columnId) ? { columnId: Number(body.columnId) } : {}), labels: Array.isArray(body.labels) ? body.labels.map(String) : [] });
            if (!card) throw new HttpError(404, 'Board not found');
            return send(res, 201, card);
          }
          if (c === 'share' && method === 'POST') {
            const body = await readJson(req);
            const r = store.share(me, sid, (Array.isArray(body.people) ? body.people : []).map(String), known());
            if (!r) throw new HttpError(404, 'Board not found');
            return send(res, 200, r);
          }
          if (c === 'leave' && method === 'POST') {
            if (!store.leave(me, sid)) throw new HttpError(404, 'Board not found');
            return send(res, 200, { ok: true });
          }
        } catch (err) {
          return bad(err);
        }
        return NEXT;
      }
      const id = localId(b);
      if (id === undefined) return b ? send(res, 404, { error: 'Board not found' }) : NEXT;
      if (!c && method === 'GET') {
        const v = board.view(id);
        if (!v) throw new HttpError(404, 'Board not found');
        return send(res, 200, { ...v, cards: v.cards.map(withRef), me: person() });
      }
      try {
        if (!c && method === 'PUT') {
          const body = await readJson(req);
          if (!board.board(id) || id === EVERYTHING) throw new HttpError(404, 'Board not found');
          if (body.name !== undefined) board.renameBoard(id, String(body.name));
          if (body.labels !== undefined) board.setLabels(id, body.labels);
          return send(res, 200, board.board(id));
        }
        if (!c && method === 'DELETE') {
          if (!board.deleteBoard(id)) throw new HttpError(404, 'Board not found');
          return send(res, 200, { ok: true });
        }
        if (c === 'columns' && method === 'POST') {
          const body = await readJson(req);
          return send(res, 201, board.addColumn(id, String(body.name ?? ''), (body.role ?? 'other') as ColumnRole, optNum(body.wipLimit) ?? null));
        }
        if (c === 'cards' && method === 'POST') {
          const body = await readJson(req);
          const card = board.addCard(id, { title: String(body.title ?? ''), notes: body.notes ? String(body.notes) : '', dueAt: whenOrNull(body.due), ...(optNum(body.columnId) ? { columnId: Number(body.columnId) } : {}), labels: Array.isArray(body.labels) ? body.labels.map(String) : [] });
          app.events?.publish({ type: 'planner', what: 'tasks' });
          return send(res, 201, withRef(card));
        }
      } catch (err) {
        return bad(err);
      }
      return NEXT;
    }

    if (a === 'columns' && b) {
      const { board } = local(req);
      if (method !== 'PUT' || c) return NEXT;
      const id = localId(b);
      if (id === undefined) throw new HttpError(404, 'Column not found');
      const body = await readJson(req);
      const patch = { ...(body.name !== undefined ? { name: String(body.name) } : {}), ...(body.wipLimit !== undefined ? { wipLimit: optNum(body.wipLimit) ?? null } : {}) };
      try {
        // A shared board's column (the shared store checks membership), else this planner's.
        if (sb() && !opts.demo && body.shared === true) {
          if (!sb()!.store.updateColumn(person(), id, patch)) throw new HttpError(404, 'Column not found');
          return send(res, 200, { ok: true });
        }
        const col = board.updateColumn(id, { ...patch, ...(Number.isFinite(Number(body.position)) ? { position: Number(body.position) } : {}) });
        if (!col) throw new HttpError(404, 'Column not found');
        return send(res, 200, col);
      } catch (err) {
        return bad(err);
      }
    }

    // ---------------- cards (tasks) ----------------
    if (a === 'tasks' && b && c && CARD_ACTIONS.has(c)) {
      const { board, demo } = local(req);
      const sid = sharedId(b);
      const store = sid && !demo ? sb()?.store : undefined;
      const me = person();
      if (sid && !store) throw new HttpError(404, 'Task not found');
      const id = sid ? undefined : localId(b);
      if (!sid && id === undefined) throw new HttpError(404, 'Task not found');
      const exists = sid ? Boolean(store!.card(me, sid)) : Boolean(board.card(id!));
      if (!exists) throw new HttpError(404, 'Task not found');
      const ref = sid ?? String(id);
      const publish = () => app.events?.publish({ type: 'board', boardId: demo ? 'demo' : 0, what: 'work' });
      try {
        if (c === 'activity' && method === 'GET') return send(res, 200, { activity: sid ? store!.activity(me, sid) : board.activity(id!) });
        if (c === 'card' && method === 'DELETE') {
          if (sid ? !store!.deleteCard(me, sid) : !board.planner.deleteTask(id!)) throw new HttpError(404, 'Task not found');
          return send(res, 200, { ok: true });
        }
        if (method !== 'POST' && method !== 'PUT') return NEXT;
        const body = await readJson(req);
        if (c === 'move') {
          const col = Number(body.columnId);
          if (!Number.isInteger(col)) throw new HttpError(400, 'Pick a column.');
          if (sid) return send(res, 200, store!.move(me, sid, col, { before: body.before as string | null, after: body.after as string | null }));
          const card = board.move(id!, col, { before: optNum(body.before) ?? null, after: optNum(body.after) ?? null, who: 'me' });
          app.events?.publish({ type: 'planner', what: 'tasks' });
          return send(res, 200, { ...withRef(card), place: board.place(id!, Number.isInteger(Number(body.boardId)) ? Number(body.boardId) : undefined) });
        }
        if (c === 'card') {
          // The card's own fields (title, notes, due, repeat) are the task's; labels and limits are the board's.
          const fields = { ...(body.title !== undefined ? { title: String(body.title) } : {}), ...(body.notes !== undefined ? { notes: String(body.notes).slice(0, 20_000) } : {}), ...(body.due !== undefined ? { dueAt: whenOrNull(body.due) } : {}) };
          if (fields.title !== undefined && (!fields.title.trim() || fields.title.length > 300)) throw new HttpError(400, 'Task title must be 1-300 characters');
          if (sid) {
            if (Object.keys(fields).length) store!.update(me, sid, fields);
            return send(res, 200, store!.setCard(me, sid, { ...(body.labels !== undefined ? { labels: body.labels } : {}), ...(body.limits !== undefined ? { limits: body.limits } : {}) }));
          }
          const repeat = REPEATS.includes(body.repeat as Repeat) ? (body.repeat as Repeat) : undefined;
          if (Object.keys(fields).length || repeat) board.as('me', () => board.planner.updateTask(id!, { ...fields, ...(repeat ? { repeat } : {}) }));
          if (body.labels !== undefined || body.limits !== undefined) board.setCard(id!, { ...(body.labels !== undefined ? { labels: body.labels } : {}), ...(body.limits !== undefined ? { limits: body.limits } : {}) });
          app.events?.publish({ type: 'planner', what: 'tasks' });
          return send(res, 200, withRef(board.card(id!)!));
        }
        if (c === 'check') {
          const index = Number(body.index);
          if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'Pick a checklist line.');
          if (sid) return send(res, 200, store!.tick(me, sid, index, body.done === true));
          return send(res, 200, withRef(board.tick(id!, index, body.done === true)));
        }
        if (c === 'comment') {
          if (sid) store!.comment(me, sid, `member:${me}`, String(body.text ?? ''));
          else board.comment(id!, 'me', String(body.text ?? ''));
          return send(res, 200, { ok: true });
        }
        if (c === 'assign') {
          const to = body.assignee === null || body.assignee === '' ? null : String(body.assignee ?? '');
          if (demo) {
            if (to === 'sara') {
              board.setAssignee(id!, 'sara', 'me');
              demoRun(demo, id!, publish);
              return send(res, 200, withRef(board.card(id!)!));
            }
            board.setAssignee(id!, to, 'me');
            return send(res, 200, withRef(board.card(id!)!));
          }
          const w = app.cardWork;
          if (!w) throw new HttpError(404, 'Card work is not available here.');
          w.assign(ref, to, 'me');
          return send(res, 200, sid ? store!.card(me, sid) : withRef(board.card(id!)!));
        }
        if (c === 'work' && d === 'stop') {
          if (demo) {
            demo.timers.splice(0).forEach(clearTimeout);
            board.setWork(id!, null);
            board.moveToRole(id!, 'todo', 'me');
            return send(res, 200, { ok: true });
          }
          if (!app.cardWork?.stop(ref)) throw new HttpError(409, 'Nothing is running on this card.');
          return send(res, 200, { ok: true });
        }
        if (c === 'answer') {
          if (demo) throw new HttpError(409, 'This card is not waiting for an answer.');
          // "Move to Done?" (she did the work in chat): yes moves it, no clears the chip.
          if (body.suggest === 'yes' || body.suggest === 'no') {
            if (sid) throw new HttpError(400, 'Not on shared boards.');
            const cur = board.card(id!)!;
            if (cur.work?.suggest) board.setWork(id!, cur.work.state === 'done' && !cur.work.conversationId ? null : { ...cur.work, suggest: undefined });
            if (body.suggest === 'yes') board.moveToRole(id!, 'done', 'me');
            return send(res, 200, withRef(board.card(id!)!));
          }
          const ok = app.cardWork?.answer(ref, { ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(body.approval === 'allow' || body.approval === 'deny' ? { approval: body.approval } : {}), ...(body.more === true ? { more: true } : {}), ...(body.resume === true ? { resume: true } : {}) });
          if (!ok) throw new HttpError(409, 'This card is not waiting for that answer.');
          return send(res, 200, { ok: true });
        }
      } catch (err) {
        return bad(err);
      }
    }
    return NEXT;
  };
}

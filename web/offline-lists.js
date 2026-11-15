// R9 (docs/OFFLINE.md "Lists and shopping mode"): lists kept on this device and ticked offline.
// The device keeps the newest lists (your boards and the household lists shared with you) as plain
// items: title, done or not, when it last changed. In shopping mode you tick items off (or add one)
// with no connection; each change waits in the outbox (kind 'list') and syncs when the connection is
// back, item by item, last writer wins: a change made on another device AFTER yours keeps the newer
// one and says so in a note. An added item that is already on the list is not added twice.
// Pure helpers (tested in Node) + the sync of one outbox item through the normal board routes.

export const LIST_LIMITS = { lists: 12, items: 300 };

const doneIds = (view) => new Set((view?.columns ?? []).filter((c) => c.role === 'done').map((c) => c.id));
/** When the server last changed a card (shared cards have no updatedAt: their done/created time). */
export const changedAt = (card) => [card?.updatedAt, card?.doneAt, card?.createdAt].filter(Boolean).sort().pop() ?? null;
export const cardRef = (card) => String(card?.ref ?? card?.id ?? '');

/** A board view (GET /api/boards/:id) → what the device keeps of it. */
export function slimBoard(view) {
  const done = doneIds(view);
  const cols = view?.columns ?? [];
  const doneCol = cols.find((c) => done.has(c.id))?.id ?? null;
  const openCol = cols.find((c) => !done.has(c.id))?.id ?? null;
  const items = (view?.cards ?? [])
    .slice(0, LIST_LIMITS.items)
    .map((c) => ({ ref: cardRef(c), title: String(c.title ?? '').slice(0, 300), done: done.has(c.columnId) || c.status === 'done', at: changedAt(c) }));
  return { id: String(view?.board?.id ?? ''), name: String(view?.board?.name ?? ''), shared: Boolean(view?.board?.shared || /^s\d+$/.test(String(view?.board?.id ?? ''))), doneCol, openCol, items };
}

/** The list as shown in shopping mode: the kept items with this device's waiting changes on top. */
export function withPending(list, outbox) {
  const mine = (outbox ?? []).filter((x) => x.kind === 'list' && String(x.boardId) === String(list.id) && x.state !== 'refused');
  const items = list.items.map((i) => {
    const last = mine.filter((x) => x.ref === i.ref && x.op === 'tick').pop();
    return last ? { ...i, done: last.done, pending: true } : { ...i };
  });
  for (const x of mine) if (x.op === 'add') items.push({ ref: null, title: x.text, done: false, pending: true, outboxId: x.id });
  return { ...list, items };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Last writer wins, per item: what to do with one waiting change against the server's list now.
 * → { action: 'move', ref, columnId } | { action: 'add', title, columnId } | { action: 'none', why }
 *   why: 'same' (already so), 'newer' (changed elsewhere after this change: the newer one stays),
 *   'gone' (the item was deleted meanwhile), 'duplicate' (an added item that is already there).
 */
export function planListChange(view, item) {
  const done = doneIds(view);
  const cols = view?.columns ?? [];
  const doneCol = cols.find((c) => done.has(c.id))?.id;
  const openCol = cols.find((c) => !done.has(c.id))?.id;
  if (item.op === 'add') {
    const there = (view?.cards ?? []).some((c) => norm(c.title) === norm(item.text) && !done.has(c.columnId) && c.status !== 'done');
    return there ? { action: 'none', why: 'duplicate' } : { action: 'add', title: String(item.text).slice(0, 300), columnId: openCol };
  }
  const card = (view?.cards ?? []).find((c) => cardRef(c) === item.ref);
  if (!card) return { action: 'none', why: 'gone' };
  const isDone = done.has(card.columnId) || card.status === 'done';
  if (isDone === item.done) return { action: 'none', why: 'same' };
  const at = changedAt(card);
  if (at && item.writtenAt && at > item.writtenAt) return { action: 'none', why: 'newer', title: card.title };
  const columnId = item.done ? doneCol : openCol;
  if (columnId === undefined) return { action: 'none', why: 'gone' };
  return { action: 'move', ref: cardRef(card), columnId };
}

/**
 * Sends one waiting list change: reads the list now, applies last-writer-wins, then the normal board
 * route. `get(path)` / `post(path, body)` return fetch Responses (throw without a connection).
 * → a Response-like { ok, status, json(), text(), note? } (note: why nothing changed).
 */
export async function sendListChange(item, { get, post }) {
  const r = await get(`/api/boards/${encodeURIComponent(item.boardId)}`);
  if (!r.ok) return r;
  const view = await r.json();
  const plan = planListChange(view, item);
  const done = (note) => ({ ok: true, status: 200, note, json: async () => ({}), text: async () => '' });
  if (plan.action === 'none') return done(plan.why === 'same' ? null : { why: plan.why, title: plan.title ?? item.title ?? item.text });
  if (plan.action === 'add') return post(`/api/boards/${encodeURIComponent(item.boardId)}/cards`, { title: plan.title, ...(plan.columnId !== undefined ? { columnId: plan.columnId } : {}) });
  return post(`/api/tasks/${encodeURIComponent(plan.ref)}/move`, { columnId: plan.columnId });
}

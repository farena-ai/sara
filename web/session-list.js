// Phase 108 (CH2, docs/design/CHATS.md §5): the tidy session list. Pure helpers (no DOM, no t()),
// so the sidebar and the project page share one rule and tests can run them in Node:
//
// - sessions of one chat (`sessionOf`) sit together: the open one is the row, ended ones are
//   "earlier sessions" under it, one press away;
// - each group shows the newest `pageSize` rows (5, 8 or 10; Settings → Appearance), then
//   "See more (n)"; each press adds 20; "Show less" goes back to the first page;
// - a channel project can be grouped by room, each room with its own See more.

/** How many more rows one press of See more adds. */
export const PAGE_STEP = 20;
/** The pick-list in Settings → Appearance → Sessions shown. */
export const PAGE_SIZES = [5, 8, 10];
export const PAGE_KEY = 'sara.pageSize';

/** Sessions shown per group before See more (this device's choice; 5 when unset: V3, the owner's default). */
export function pageSize(storage) {
  const n = Number(storage?.getItem?.(PAGE_KEY));
  return PAGE_SIZES.includes(n) ? n : 5;
}

/** Newest first, then id: the same order as the server's pages, so nothing repeats or goes missing. */
export function newestFirst(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The rows of one group: each chat once, its open session as the row and the ended ones under it
 * (newest first). A chat's place in the list is its newest session. Web conversations without
 * sessions are rows of their own.
 */
export function chains(convs) {
  const by = new Map();
  for (const c of [...convs].sort(newestFirst)) {
    const root = c.sessionOf ?? c.id;
    if (!by.has(root)) by.set(root, []);
    by.get(root).push(c);
  }
  const out = [];
  for (const list of by.values()) {
    const head = list.find((c) => !c.endedAt) ?? list[0];
    out.push({ head, earlier: list.filter((c) => c !== head), at: list[0] });
  }
  return out.sort((x, y) => newestFirst(x.at, y.at));
}

/**
 * One group's page: the first `shown` rows and how many are left. `total` is the server's count
 * of sessions in the group (it may hold more than the app has loaded); rows not loaded yet count
 * one each.
 */
export function pageOf(convs, { shown, total = convs.length, size = 8 }) {
  const all = chains(convs);
  const notLoaded = Math.max(0, total - convs.length);
  const rows = all.slice(0, shown);
  const more = Math.max(0, all.length - rows.length) + notLoaded;
  return { rows, more, less: shown > size && rows.length > size, needsFetch: rows.length < shown && notLoaded > 0 };
}

/** The room a bridge session is in (B3 chip from the server), as a stable key for Group by room. */
export const roomKey = (c) => (c.room ? `${c.channel?.replace(/-work|-nsfw/g, '')}:${c.channelKey ?? ''}` : 'other');

/** Sessions by room (Group by room in a channel project), rooms ordered by their newest session. */
export function byRoom(convs) {
  const m = new Map();
  for (const c of [...convs].sort(newestFirst)) {
    const k = roomKey(c);
    if (!m.has(k)) m.set(k, { key: k, room: c.room ?? null, convs: [] });
    m.get(k).convs.push(c);
  }
  return [...m.values()];
}

/** The cursor for the next page of a group: its oldest loaded row ("updatedAt,id"). */
export function cursorOf(convs) {
  const last = [...convs].sort(newestFirst).at(-1);
  return last ? `${last.updatedAt},${last.id}` : '';
}

/** The sidebar's group key of a conversation (the same keys as the server's ?cap totals). */
export function groupKeyOf(c, activeIds) {
  if (c.archivedAt) return 'archived';
  return c.projectId !== null && c.projectId !== undefined && activeIds.has(c.projectId) ? `p${c.projectId}` : 'none';
}

/** Adds a fetched page to the list (no duplicates; a row already there keeps its newer copy). */
export function mergePage(list, page) {
  const have = new Set(list.map((c) => c.id));
  return [...list, ...page.filter((c) => !have.has(c.id))];
}

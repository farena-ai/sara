// MSGPOP (docs/MESSAGES.md "New message notice"): the pure parts of the new-message card, with no
// imports so tests can load it directly. Which unread chats deserve the card (one-to-one, community
// mentions, communities set to "everything"), the per-message memory behind Later, the card's title
// when several people wrote, and the "(n) " tab-title prefix.

/** How many shown message keys localStorage keeps (newest last). */
export const SHOWN_MAX = 200;

/** A chat's notice key: one per incoming message, so a newer message from the same person shows again. */
export const noticeKey = (c) => `${c.id}:${c.lastIn || c.lastAt || ''}`;

/** The first letter of a name, for the round avatar. */
export const initialOf = (name) => (String(name || '').trim().match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();

/**
 * Unread chats that deserve the card and were not shown yet.
 * @param {any[]} chats the `GET /api/messages` rows
 * @param {string[]} shown remembered keys
 * @param {{ communityNotify?: string, popup?: boolean, openChat?: string }} o settings and the chat on screen
 */
export function pendingNotices(chats, shown, o = {}) {
  if (o.popup === false) return [];
  const seen = new Set(shown);
  const out = [];
  for (const c of chats ?? []) {
    if (!c || c.muted || c.blocked || c.id === o.openChat) continue;
    let mention = false;
    if (c.kind === 'community') {
      const level = c.notify ?? o.communityNotify ?? 'mentions';
      if (level === 'none') continue;
      if (level === 'all' ? !(c.unread > 0) : !(c.mentions > 0)) continue;
      mention = level !== 'all';
    } else if (!(c.unread > 0)) continue;
    const key = noticeKey(c);
    if (seen.has(key)) continue;
    out.push({ chatId: c.id, name: c.title || '', initial: initialOf(c.title), body: c.last || '', unread: (mention ? c.mentions : c.unread) || 1, mention, key });
  }
  return out;
}

/** Adds (or refreshes) one chat's notice, newest first. */
export function addNotice(list, n) {
  return [n, ...list.filter((x) => x.chatId !== n.chatId)];
}

/** Remembers shown keys (bounded, newest kept). */
export function remember(shown, keys) {
  const next = [...shown.filter((k) => !keys.includes(k)), ...keys];
  return next.slice(-SHOWN_MAX);
}

/** Reads the remembered keys; anything odd is an empty memory. */
export function parseShown(raw) {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** The card's title: one sender, a mention, or "Hank and 2 others". `t` is the page's translator. */
export function noticeTitle(list, t) {
  const first = list[0];
  if (!first) return '';
  if (list.length === 1) return first.mention ? t('You were mentioned in {name}', { name: first.name }) : t('New message from {name}', { name: first.name });
  if (list.length === 2) return t('New messages from {name} and 1 other', { name: first.name });
  return t('New messages from {name} and {n} others', { name: first.name, n: list.length - 1 });
}

/** Total unread on the card (the count pill). */
export const noticeCount = (list) => list.reduce((n, x) => n + (x.unread || 1), 0);

/** A count for a pill: 1…99, then 99+. */
export const countText = (n) => (n > 99 ? '99+' : String(n));

/** The tab title with an "(n) " prefix while there are unread messages (any old prefix replaced). */
export function withCount(title, n) {
  const base = String(title || '').replace(/^\(\d+\+?\) /, '');
  return n > 0 ? `(${countText(n)}) ${base}` : base;
}

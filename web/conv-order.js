// Y5 (docs/CHATS.md "How the list is ordered"): the order of the chat list, as plain rules.
// Owner report (2026-11-23): "the latest session/project used is not always at the top". It could
// not be: projects were listed in a fixed order (chat-app projects, then his own, then "No project"),
// so the chat he had just used sat wherever its folder happened to be.
//
// Now, top to bottom:
//   1. her home chat ("From Sara"): what she sends on her own, always first (src/home-chat.ts);
//   2. Recent: the newest few chats from every folder, newest first, so the last one used is always
//      at the top (only when there is more than one folder to look through);
//   3. the folders, the one used most recently first; an empty folder goes after the used ones;
//   4. Archived and hidden projects, as before.
// "Used" means its last message (the server's updatedAt, which only a message moves).
// No DOM here: web/app.js draws what these return.

/** How many chats Recent shows. */
export const RECENT_N = 5;

const at = (c) => Date.parse(c?.updatedAt ?? '') || 0;

/** The home chat among these (not archived), or undefined. */
export const homeOf = (convs) => convs.find((c) => c.home && !c.archivedAt);

/** The newest chats across every folder, newest first (never the home chat or an archived one). */
export function recentOf(convs, n = RECENT_N) {
  return convs
    .filter((c) => !c.home && !c.archivedAt)
    .sort((a, b) => at(b) - at(a))
    .slice(0, n);
}

/**
 * Whether Recent is worth showing: it repeats rows that are also in their folders, so it appears only
 * when the chats are spread over more than one folder and there are more of them than it would show.
 */
export function showRecent(convs, foldersWithChats, n = RECENT_N) {
  return foldersWithChats > 1 && convs.filter((c) => !c.home && !c.archivedAt).length > n;
}

/**
 * Folders ordered by their newest chat, newest first. `groups` are { key, convs, ... }; folders with no
 * chats keep their given order after the used ones (a new project stays where it was made).
 */
export function byActivity(groups) {
  const newest = (g) => g.convs.reduce((m, c) => Math.max(m, at(c)), 0);
  return groups
    .map((g, i) => ({ g, i, t: newest(g) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .map((x) => x.g);
}

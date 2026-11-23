// Y2 (docs/design/LAGFIX.md #5): keep the turns of a chat that have not changed when the chat is
// drawn again. After every reply the page asked the server for the chat and rebuilt all of it (about
// 16,000 elements for a long chat: 170 ms on a fast computer, close to a second on a slow one, with
// the window not reacting meanwhile). Now a redraw that asks for it (`on`) rebuilds only what
// changed: the newest turn always (it carries Regenerate, Edit, Continue), the one before it once (it
// was the newest last time, so it was never kept), and any earlier turn whose messages differ from
// what was drawn.
//
// A "turn" starts at each message from the person. A turn's key is the chat's id and its messages as
// JSON, so anything the server changed in an old message (a saved note, a forgotten mark) redraws
// that turn. Kept elements never leave the page: only what differs is removed or added.
// No framework and no imports: the caller (renderMessages in web/app.js) builds the elements.

/** Splits a chat into turns: a new one at each message from the person. */
export function splitTurns(messages) {
  const turns = [];
  for (const m of messages) {
    if (m.role === 'user' || !turns.length) turns.push([]);
    turns.at(-1).push(m);
  }
  return turns;
}

/** How many of the newest turns are always rebuilt (and never remembered). */
export const ALWAYS_REBUILT = 1;

const caches = new WeakMap();

/**
 * @param box the element that holds the chat
 * @param convId the open chat's id (another chat never reuses these elements)
 * @param messages what will be drawn
 * @param o.on true to keep unchanged turns; false rebuilds everything (and still remembers what was built)
 */
export function turnReuse(box, convId, messages, o = {}) {
  const turns = splitTurns(messages);
  const old = caches.get(box);
  const prev = o.on && old && old.conv === convId ? old.turns : new Map();
  const next = new Map();
  const keptEls = new Set();
  // The turn that holds her newest reply carries "latest" marks too, even when a newer message from the
  // person has no reply yet (a failed turn): it is never kept either.
  const newestReply = messages.findLast((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  const settled = (group) => turns.indexOf(group) < turns.length - ALWAYS_REBUILT && !group.includes(newestReply);
  const keyOf = (group) => JSON.stringify(group);
  return {
    turns,
    /** Puts a kept turn's elements into `els`; false when the turn has to be built. */
    take(group, els) {
      if (!prev.size || !settled(group)) return false;
      const key = keyOf(group);
      const had = prev.get(key);
      // Only when every element is still in this chat (nothing removed them since).
      if (!had || !had.every((e) => e.parentNode === box)) return false;
      els.push(...had);
      for (const e of had) keptEls.add(e);
      next.set(key, had);
      return true;
    },
    /** Remembers the elements just built for a turn (the ones in `els` from index `from`). */
    built(group, els, from) {
      if (settled(group) && convId) next.set(keyOf(group), els.slice(from));
    },
    /** True for an element that was kept (it already has its buttons and its heading). */
    kept: (e) => keptEls.has(e),
    /** Makes the box hold exactly `els`, in order, without touching the kept ones. */
    place(els) {
      caches.set(box, { conv: convId, turns: next });
      if (!keptEls.size) return void box.replaceChildren(...els);
      const want = new Set(els);
      for (const child of [...box.childNodes]) if (!want.has(child)) child.remove();
      let ref = box.firstChild;
      for (const e of els) {
        if (e === ref) ref = ref.nextSibling;
        else box.insertBefore(e, ref);
      }
    },
  };
}

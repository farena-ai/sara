// Y2 (docs/design/LAGFIX.md #5): the redraw after a reply keeps the turns that have not changed.
// web/turn-reuse.js is plain logic over a container's child list, so a small stand-in for the
// page's box is enough to run it here.
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error a browser module without types
import { ALWAYS_REBUILT, splitTurns, turnReuse } from '../web/turn-reuse.js';

interface Node_ { name: string; parentNode: Box | null; remove(): void; readonly nextSibling: Node_ | null }
class Box {
  kids: Node_[] = [];
  moves = 0;
  get childNodes() { return this.kids; }
  get firstChild() { return this.kids[0] ?? null; }
  replaceChildren(...els: Node_[]) {
    for (const k of this.kids) k.parentNode = null;
    this.kids = [...els];
    for (const e of els) e.parentNode = this;
    this.moves += els.length;
  }
  insertBefore(e: Node_, ref: Node_ | null) {
    if (e.parentNode) e.remove();
    const at = ref ? this.kids.indexOf(ref) : this.kids.length;
    this.kids.splice(at < 0 ? this.kids.length : at, 0, e);
    e.parentNode = this;
    this.moves++;
  }
}
const node = (name: string): Node_ => {
  const n: Node_ = {
    name,
    parentNode: null,
    remove() {
      const b = n.parentNode;
      if (!b) return;
      b.kids.splice(b.kids.indexOf(n), 1);
      n.parentNode = null;
    },
    get nextSibling() {
      const b = n.parentNode;
      return b ? (b.kids[b.kids.indexOf(n) + 1] ?? null) : null;
    },
  };
  return n;
};

type Msg = { id: number; role: string; content: string; meta?: Record<string, unknown> };
const chat = (turns: number): Msg[] => Array.from({ length: turns }, (_, i) => [{ id: i * 2 + 1, role: 'user', content: `q${i}` }, { id: i * 2 + 2, role: 'assistant', content: `a${i}` }]).flat();

/** Draws the way renderMessages does: one element per message, built only for turns that are not kept. */
function draw(box: Box, messages: Msg[], on: boolean, conv = 'c1') {
  const r = turnReuse(box, conv, messages, { on });
  const els: Node_[] = [];
  let built = 0;
  for (const group of r.turns as Msg[][]) {
    if (r.take(group, els)) continue;
    const from = els.length;
    for (const m of group) {
      els.push(node(`${m.id}:${m.content}`));
      built++;
    }
    r.built(group, els, from);
  }
  r.place(els);
  return { built, r, els };
}

test('Y2 turns: a new turn starts at each message from the person', () => {
  assert.deepEqual(splitTurns(chat(3)).map((t: Msg[]) => t.map((m) => m.id)), [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(splitTurns([{ role: 'assistant', id: 1 }, { role: 'user', id: 2 }, { role: 'tool', id: 3 }]).map((t: Msg[]) => t.length), [1, 2]);
  assert.deepEqual(splitTurns([]), []);
  assert.equal(ALWAYS_REBUILT, 1);
});

test('Y2 turns: after a reply only the last two turns are built; the rest stay in the page untouched', () => {
  const box = new Box();
  const first = draw(box, chat(20), false);
  assert.equal(first.built, 40, 'the first draw builds everything');
  const before = [...box.kids];
  box.moves = 0;
  // A reply arrived: one more turn. The redraw asks for reuse.
  const again = draw(box, chat(21), true);
  assert.equal(again.built, 4, 'the new turn and the one before it (it was the newest last time, with its Regenerate and Edit)');
  assert.deepEqual(box.kids.map((k) => k.name), chat(21).map((m) => `${m.id}:${m.content}`), 'the page shows the chat in order');
  for (let i = 0; i < 38; i++) assert.equal(box.kids[i], before[i], `element ${i} is the same element as before`);
  assert.equal(box.moves, 4, 'only the rebuilt elements were put into the page');
  assert.ok(again.r.kept(box.kids[0]) && !again.r.kept(box.kids.at(-1)));
  // A failed turn (a message from the person with no reply): the turn with her newest reply is rebuilt too.
  const failed = [...chat(21), { id: 99, role: 'user', content: 'again?' }];
  assert.equal(draw(box, failed, true).built, 2 + 1);
  box.moves = 0;
  assert.equal(draw(box, chat(22), true).built, 4);
});

test('Y2 turns: a changed old message redraws its turn; a shorter window drops the turns that left it', () => {
  const box = new Box();
  draw(box, chat(10), false);
  draw(box, chat(11), true);
  const changed = chat(12);
  changed[3] = { ...changed[3]!, meta: { savedMemoryIds: [7] } }; // the memory worker marked an old reply
  const r = draw(box, changed, true);
  assert.equal(r.built, 2 + 4, 'that one turn and the last two');
  assert.deepEqual(box.kids.map((k) => k.name), changed.map((m) => `${m.id}:${m.content}`));
  // The server now sends only the newest part of a long chat (the 150-message window).
  const windowed = chat(13).slice(8);
  const w = draw(box, windowed, true);
  assert.deepEqual(box.kids.map((k) => k.name), windowed.map((m) => `${m.id}:${m.content}`), 'older turns left the page');
  assert.equal(w.built, 4, 'and nothing else was rebuilt');
});

test('Y2 turns: another chat, or a draw that does not ask for it, reuses nothing', () => {
  const box = new Box();
  draw(box, chat(8), false);
  assert.equal(draw(box, chat(8), true, 'other-chat').built, 16, 'the same messages in another chat are built again');
  assert.equal(draw(box, chat(8), false).built, 16, 'opening or editing a chat draws all of it');
  // An element something removed from the page since (a deleted message) is never brought back.
  draw(box, chat(8), false);
  box.kids[0]!.remove();
  const r = draw(box, chat(9), true);
  assert.equal(r.built, 2 + 4);
  assert.equal(box.kids.length, 18);
});

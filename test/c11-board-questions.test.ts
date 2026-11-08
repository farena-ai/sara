// C11 (docs/ops/C11_DESIGN.md): board questions and a board from a description. A card she works
// parks in "question" (not failed, and not holding a work slot), the owner answers on the card or
// from chat (card_answer), the same run resumes with the answer; questions count on the board list;
// a parked card is reminded about after a day, never in quiet hours, at most once a day. "Make a
// board from a description": a model draft (columns, cards, dependencies) previewed, then created.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanDraft, createFromDraft, QUESTION_REMIND_MS } from '../src/board-questions.ts';
import { createBoardTools, setUpBoard } from '../src/board-work.ts';
import { createSaraServer } from '../src/server.ts';
import { writeFileTool } from '../src/tools/builtin.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-02T15:00:00Z') };
const app = makeApp(dir, clock);
app.tools.add(writeFileTool);
setUpBoard(app);
for (const t of createBoardTools(() => app)) app.tools.add(t);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
const notes: { title: string; text: string; tag: string }[] = [];
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { write_file: 'auto' }, board: { concurrent: 1 } } as never);
  app.cardWork!.notify = async (title, body, _conv, tag) => void notes.push({ title, text: body, tag });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const api = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};
async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}
const board = () => app.board!;

test('card_ask parks the card in "question" without holding a work slot; the answer resumes the same run', async () => {
  const q = board().addCard(board().general().id, { title: 'Pick a colour' });
  const other = board().addCard(board().general().id, { title: 'Write a note' });
  app.script.push([call('q1', 'card_ask', { question: 'Blue or green?' })]);
  app.cardWork!.assign(String(q.id), 'sara', 'me');
  await until(() => board().card(q.id)!.work?.state === 'question');
  const w = board().card(q.id)!.work!;
  assert.equal(w.ask?.kind, 'question');
  assert.equal(w.ask?.text, 'Blue or green?');
  assert.equal(w.ask?.askedAt, clock.now.toISOString());
  assert.equal(board().column(board().card(q.id)!.columnId)!.role, 'waiting');
  // One card at a time, yet the parked question doesn't block the next card.
  app.script.push([call('o1', 'write_file', { path: 'note.md', content: 'hi' })], text('Wrote note.md.'));
  app.cardWork!.assign(String(other.id), 'sara', 'me');
  await app.cardWork!.finished(String(other.id));
  assert.equal(board().card(other.id)!.work?.state, 'done');
  const list = await api('/api/boards');
  assert.equal(list.json.questions, 1, 'the board list counts open questions');
  assert.equal(list.json.boards.find((b: any) => b.kind === 'general').questions, 1);
  app.script.push([call('q2', 'write_file', { path: 'colour.md', content: 'green' })], text('Green it is: I wrote colour.md.'));
  assert.equal((await api(`/api/tasks/${q.id}/answer`, 'POST', { text: 'Green' })).status, 200);
  await app.cardWork!.finished(String(q.id));
  assert.equal(board().card(q.id)!.work?.state, 'done');
  const toolMsg = app.store.messages(w.conversationId).find((m) => m.role === 'tool');
  assert.match(String(toolMsg?.content ?? ''), /The owner answered: Green/);
});

test('words without receipts park in "question" too; she answers from chat with card_answer', async () => {
  const n = board().addCard(board().general().id, { title: 'Pick a banner' });
  app.script.push(text('Wide or tall?'));
  app.cardWork!.assign(String(n.id), 'sara', 'me');
  await app.cardWork!.finished(String(n.id));
  assert.equal(board().card(n.id)!.work?.state, 'question');
  const tool = createBoardTools(() => app).find((t) => t.spec.name === 'card_answer')!;
  assert.ok(tool, 'card_answer exists');
  app.script.push([call('b1', 'write_file', { path: 'banner.md', content: 'wide' })], text('Made it wide.'));
  const out = await tool.run({ task: n.id, answer: 'Wide' }, { signal: new AbortController().signal, conversationId: 'chat-1' } as never);
  assert.match(out, /Answered card #\d+/);
  await app.cardWork!.finished(String(n.id));
  assert.equal(board().card(n.id)!.work?.state, 'done');
  await assert.rejects(() => tool.run({ task: n.id, answer: 'again' }, { signal: new AbortController().signal } as never), /not waiting/);
});

test('a parked question is reminded about after a day, never in quiet hours, at most once a day', async () => {
  const r = board().addCard(board().general().id, { title: 'Choose a venue' });
  app.script.push(text('Garden or hall?'));
  app.cardWork!.assign(String(r.id), 'sara', 'me');
  await app.cardWork!.finished(String(r.id));
  notes.length = 0;
  const asked = clock.now.getTime();
  assert.equal(await app.cardWork!.remind(new Date(asked + 3600_000)), 0, 'not before a day');
  // 03:00 in Chicago is inside the default quiet hours.
  const quiet = new Date('2026-11-04T09:00:00Z');
  assert.ok(quiet.getTime() - asked > QUESTION_REMIND_MS);
  assert.equal(await app.cardWork!.remind(quiet), 0, 'quiet hours wait');
  const day = new Date('2026-11-04T16:00:00Z');
  assert.equal(await app.cardWork!.remind(day), 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Choose a venue/);
  assert.match(notes[0].text, /Garden or hall\?/);
  assert.equal(await app.cardWork!.remind(new Date(day.getTime() + 3600_000)), 0, 'once a day');
  assert.ok(board().card(r.id)!.work!.ask!.remindedAt);
  app.cardWork!.stop(String(r.id));
});

test('a board from a description: draft cleaned (columns, cards, dependencies), previewed, then created', async () => {
  const draft = { name: 'Move house', columns: [{ name: 'To pack', role: 'todo' }, { name: 'Packing', role: 'doing' }, { name: 'Waiting on you', role: 'waiting' }, { name: 'Done', role: 'done' }], cards: [{ title: 'Book the van', column: 'To pack' }, { title: 'Pack the kitchen', column: 'Packing', notes: 'Plates first', after: [0] }, { title: 'Return the keys', after: [0, 1, 7] }] };
  app.script.push(text(`Here it is:\n${JSON.stringify(draft)}`));
  const res = await api('/api/boards/draft', 'POST', { description: 'I am moving house next month: book a van, pack, hand back the keys.' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const d = res.json.draft;
  assert.equal(d.name, 'Move house');
  assert.equal(d.columns.length, 4);
  assert.deepEqual(d.cards[2].after, [0, 1], 'unknown dependencies are dropped');
  assert.equal((await api('/api/boards/draft', 'POST', { description: '' })).status, 400);
  // The owner edits the preview (drops a card) and creates it.
  d.cards[1].title = 'Pack the kitchen and bathroom';
  const made = await api('/api/boards/from-draft', 'POST', { draft: d });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const v = board().view(made.json.board.id)!;
  assert.deepEqual(v.columns.map((c) => c.name), ['To pack', 'Packing', 'Waiting on you', 'Done']);
  assert.equal(v.cards.length, 3);
  const keys = v.cards.find((c) => c.title === 'Return the keys')!;
  const van = v.cards.find((c) => c.title === 'Book the van')!;
  assert.match(keys.notes, new RegExp(`Waits for: #${van.id} Book the van`));
  assert.equal(board().column(v.cards.find((c) => c.title.startsWith('Pack'))!.columnId)!.name, 'Packing');
});

test('cleanDraft refuses nonsense and keeps the limits; createFromDraft makes a To do and Done when missing', () => {
  assert.throws(() => cleanDraft({}), /cards/);
  const big = cleanDraft({ name: 'x'.repeat(200), columns: Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, role: 'other' })), cards: Array.from({ length: 80 }, (_, i) => ({ title: `Card ${i}`, after: [i + 1, i - 1] })) });
  assert.ok(big.name.length <= 80);
  assert.ok(big.columns.length <= 12);
  assert.ok(big.cards.length <= 40);
  assert.ok(big.columns.some((c) => c.role === 'todo') && big.columns.some((c) => c.role === 'done'));
  assert.ok(big.cards.every((c, i) => c.after.every((a) => a < i)), 'a card only waits for cards above it (no loops)');
  const b = createFromDraft(board(), cleanDraft({ name: 'Tiny', cards: [{ title: 'One thing' }] }));
  assert.equal(board().view(b.id)!.cards.length, 1);
});

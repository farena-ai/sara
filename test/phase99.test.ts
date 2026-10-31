// Phase 99 (ST4, docs/design/STAPLES.md §7.10): the board over the planner's tasks. Migration
// without touching old rows, To do / Done by status, chat tasks on the board, Done ⇄ completed,
// repeating cards, fractional positions under 200 random moves and two tabs, Assign → Sara with a
// fake model (Done with receipts, unproven claims wait, an approval waits and Allow resumes the same
// run, Stop, the 3rd card queues), helpers through TeamManager with the card's limits, shared
// household boards by membership, Today's tile, the plugin event, and the board's web pieces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { between, boardFor, checklistOf, EVERYTHING, tickChecklist, VIRTUAL_COLUMN } from '../src/board.ts';
import { CardWorker, createBoardTools, setUpBoard } from '../src/board-work.ts';
import { PlannerStore } from '../src/planner.ts';
import { createSaraServer } from '../src/server.ts';
import { SharedBoardStore } from '../src/shared-boards.ts';
import { TeamManager } from '../src/team.ts';
import { buildToday } from '../src/today.ts';
import { writeFileTool } from '../src/tools/builtin.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-30T15:00:00Z') };
const app = makeApp(dir, clock);
app.tools.add(writeFileTool);
setUpBoard(app);
for (const t of createBoardTools(() => app)) app.tools.add(t);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { write_file: 'auto', todo: 'auto' } });
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
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
};
/** Waits for a state, not for a log line. */
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
const roleOf = (id: number) => board().column(board().card(id)!.columnId)!.role;

test('migration: an old planner database gets the board columns without touching its rows; old tasks land in To do / Done by status', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, conversation_id TEXT);
    INSERT INTO tasks (title, status, created_at, updated_at, done_at) VALUES ('Old open', 'open', '2025-01-01', '2025-01-01', NULL), ('Old done', 'done', '2025-01-02', '2025-01-02', '2025-01-03');`);
  const before = db.prepare('SELECT id, title, status, created_at, updated_at, done_at FROM tasks ORDER BY id').all();
  const pl = new PlannerStore(db);
  const b = boardFor(pl);
  const cols = new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
  for (const c of ['board_id', 'column_id', 'position', 'labels', 'assignee', 'work', 'repeat']) assert.ok(cols.has(c), c);
  for (const t of ['boards', 'board_columns', 'board_labels', 'card_activity']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t), t);
  assert.deepEqual(db.prepare('SELECT id, title, status, created_at, updated_at, done_at FROM tasks ORDER BY id').all(), before, 'old rows are untouched');
  const v = b.view(b.general().id)!;
  assert.deepEqual(v.columns.map((c) => `${c.name}/${c.role}`), ['To do/todo', 'Doing/doing', 'Waiting on you/waiting', 'Done/done']);
  const col = (title: string) => v.columns.find((c) => c.id === v.cards.find((x) => x.title === title)!.columnId)!.role;
  assert.equal(col('Old open'), 'todo');
  assert.equal(col('Old done'), 'done');
  // A second open is a no-op (additive, idempotent).
  boardFor(new PlannerStore(db));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }).n, 1);
});

test('a task added in chat appears on the board; moving to Done completes it; completing it in chat moves it; a repeating card returns', async () => {
  const conv = app.store.createConversation();
  app.script.push([call('t1', 'todo', { action: 'add', title: 'Buy stamps', project: 'Errands' })], text('Added it.'));
  for await (const _ of (await import('../src/chat.ts')).runTurn(app, conv.id, 'add buy stamps to errands', new AbortController().signal)) void _;
  const task = app.planner!.tasks({ status: 'open' }).find((t) => t.title === 'Buy stamps')!;
  const bd = board().forProject(task.projectId!);
  assert.ok(board().view(bd.id)!.cards.some((c) => c.id === task.id), 'on the project board');
  assert.ok(board().view(EVERYTHING)!.cards.some((c) => c.id === task.id), 'and on Everything');
  assert.equal(roleOf(task.id), 'todo');
  board().move(task.id, board().roleColumn(bd.id, 'done').id);
  assert.equal(app.planner!.task(task.id)!.status, 'done');
  app.planner!.updateTask(task.id, { status: 'open' });
  assert.equal(roleOf(task.id), 'todo', 'reopened in chat → To do');
  app.planner!.updateTask(task.id, { status: 'done' });
  assert.equal(roleOf(task.id), 'done', 'done in chat → Done');
  // Repeating: done moves the next occurrence back to To do.
  const rep = app.planner!.addTask({ title: 'Water the plants', dueAt: '2026-10-30T14:00:00.000Z', repeat: 'weekly' });
  board().move(rep.id, board().roleColumn(board().general().id, 'done').id);
  const back = app.planner!.task(rep.id)!;
  assert.equal(back.status, 'open');
  // 9:00 in Chicago both times (the clocks change on Nov 1: 14:00Z → 15:00Z).
  assert.equal(back.dueAt, '2026-11-06T15:00:00.000Z');
  assert.equal(roleOf(rep.id), 'todo');
  assert.ok(board().activity(rep.id).some((a) => a.what === 'done' && a.detail.repeat === 'weekly'));
  // The checklist in the notes, ticked on the card.
  assert.deepEqual(checklistOf('- [x] a\n- [ ] b\ntext'), { done: 1, total: 2 });
  assert.equal(tickChecklist('- [x] a\n- [ ] b', 1, true), '- [x] a\n- [x] b');
});

test('fractional positions: 200 random moves keep one consistent order; two tabs with stale neighbours converge', () => {
  const pid = app.planner!.projectId('Shuffle')!;
  const bd = board().forProject(pid);
  const cols = board().columns(bd.id).filter((c) => c.role !== 'done');
  const ids = Array.from({ length: 12 }, (_, i) => board().addCard(bd.id, { title: `Card ${i}` }).id);
  // The model: each column's list of ids in order.
  const model = new Map(cols.map((c) => [c.id, [] as number[]]));
  model.get(cols[0].id)!.push(...ids);
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 200; i++) {
    const id = ids[rnd(ids.length)];
    const to = cols[rnd(cols.length)].id;
    for (const l of model.values()) if (l.includes(id)) l.splice(l.indexOf(id), 1);
    const list = model.get(to)!;
    const at = rnd(list.length + 1);
    const opts = at > 0 ? { after: list[at - 1] } : list.length ? { before: list[0] } : {};
    list.splice(at, 0, id);
    board().move(id, to, opts);
  }
  const v = board().view(bd.id)!;
  for (const c of cols) {
    const got = v.cards.filter((x) => x.columnId === c.id);
    assert.deepEqual(got.map((x) => x.id), model.get(c.id), `order of ${c.name}`);
    for (let i = 1; i < got.length; i++) assert.ok(got[i].position > got[i - 1].position, 'strictly increasing positions');
  }
  // Two tabs: tab A moves X after Y while tab B (stale) moved Y to another column; both land, last write per card wins.
  const [x, y] = model.get(cols[0].id)!.length >= 2 ? model.get(cols[0].id)! : ids;
  board().move(y, cols[1].id);
  board().move(x, cols[0].id, { after: y }); // Y is no longer there: the stale neighbour is ignored
  assert.equal(board().card(x)!.columnId, cols[0].id);
  assert.equal(board().card(y)!.columnId, cols[1].id);
  assert.ok(between(1, 1 + 1e-12) === undefined, 'no room left is detected (the column is respaced)');
});

test('routes: boards, a card added on the board is a task, move with neighbours, the place for the aria-live line; the Everything board moves by role', async () => {
  const list = await api('/api/boards');
  assert.equal(list.status, 200);
  const boards = list.json.boards as { id: number; kind: string }[];
  assert.equal(boards[0].kind, 'everything');
  const gen = boards.find((b) => b.kind === 'general')!;
  const v = (await api(`/api/boards/${gen.id}`)).json as { columns: { id: number; role: string }[] };
  const todo = v.columns.find((c) => c.role === 'todo')!.id;
  const doing = v.columns.find((c) => c.role === 'doing')!.id;
  const a = (await api(`/api/boards/${gen.id}/cards`, 'POST', { title: 'Card A', columnId: doing })).json as { id: number; ref: string };
  const b = (await api(`/api/boards/${gen.id}/cards`, 'POST', { title: 'Card B' })).json as { id: number };
  assert.equal(app.planner!.task(b.id)!.title, 'Card B', 'a card is a task');
  assert.equal(a.ref, String(a.id));
  const m = await api(`/api/tasks/${b.id}/move`, 'POST', { columnId: doing, before: a.id });
  assert.equal(m.status, 200, m.json.error);
  assert.deepEqual(m.json.place, { column: 'Doing', index: 1, of: 2 });
  const e = await api(`/api/tasks/${a.id}/move`, 'POST', { columnId: VIRTUAL_COLUMN.done, boardId: 0 });
  assert.equal(e.status, 200);
  assert.equal(app.planner!.task(a.id)!.status, 'done');
  assert.equal((await api(`/api/tasks/${b.id}/move`, 'POST', { columnId: 99999 })).status, 404);
  assert.equal((await api('/api/boards/not-a-board')).status, 404);
  assert.equal((await api('/api/tasks/s999/move', 'POST', { columnId: todo })).status, 404, 'no shared store here');
  const act = await api(`/api/tasks/${b.id}/activity`);
  assert.ok((act.json.activity as { what: string }[]).some((x) => x.what === 'moved'));
});

test('Assign → Sara: Doing → Done with receipts; an unbacked claim waits with the unproven line', async () => {
  const c = board().addCard(board().general().id, { title: 'Write notes.md' });
  app.script.push([call('w1', 'write_file', { path: 'notes.md', content: '# Notes\n' })], text('I wrote notes.md with a heading.'));
  app.cardWork!.assign(String(c.id), 'sara', 'me');
  await app.cardWork!.finished(String(c.id));
  const done = board().card(c.id)!;
  assert.equal(done.work?.state, 'done', JSON.stringify(done.work));
  assert.equal(roleOf(c.id), 'done');
  assert.ok(done.work!.receipts!.some((r) => r.tool === 'write_file' && r.status === 'ok'));
  assert.equal(app.store.getConversation(done.work!.conversationId)!.channel, 'board');
  assert.ok(board().activity(c.id).some((x) => x.what === 'receipt'));
  // A claim without a receipt.
  const u = board().addCard(board().general().id, { title: 'Write report.md' });
  app.script.push(text('I wrote the file report.md for you.'), text('I created report.md.'));
  app.cardWork!.assign(String(u.id), 'sara', 'me');
  await app.cardWork!.finished(String(u.id));
  const w = board().card(u.id)!;
  assert.equal(w.work?.state, 'waiting');
  assert.equal(w.work?.ask?.kind, 'unproven');
  assert.match(w.work!.ask!.text, /^I think it's done, but I couldn't prove: /);
  assert.equal(roleOf(u.id), 'waiting');
  assert.equal(app.planner!.task(u.id)!.status, 'open');
});

test('an approval moves the card to Waiting; Allow on the card resumes the same run; Stop stops it; the 3rd card queues', async () => {
  app.settings.update({ toolPermissions: { write_file: 'ask', todo: 'auto' } });
  const a = board().addCard(board().general().id, { title: 'Needs an OK' });
  app.script.push([call('a1', 'write_file', { path: 'ok.md', content: 'ok' })], text('I wrote ok.md.'));
  app.cardWork!.assign(String(a.id), 'sara', 'me');
  const asked = await until(() => (board().card(a.id)!.work?.ask?.approvalId ? board().card(a.id)!.work! : undefined));
  assert.equal(roleOf(a.id), 'waiting');
  const convId = asked.conversationId;
  // Two more: the 2nd also waits on an approval, the 3rd queues (2 at once).
  const b = board().addCard(board().general().id, { title: 'Second' });
  app.script.push([call('b1', 'write_file', { path: 'b.md', content: 'b' })], text('I wrote b.md.'));
  app.cardWork!.assign(String(b.id), 'sara', 'me');
  await until(() => board().card(b.id)!.work?.ask?.approvalId);
  const c = board().addCard(board().general().id, { title: 'Third' });
  app.cardWork!.assign(String(c.id), 'sara', 'me');
  assert.equal(board().card(c.id)!.work?.state, 'queued');
  assert.deepEqual(app.cardWork!.queue(), [String(c.id)]);
  // Allow on the card answers the same broker entry: the same conversation, no new turn.
  const r = await api(`/api/tasks/${a.id}/answer`, 'POST', { approval: 'allow' });
  assert.equal(r.status, 200, r.json.error);
  await app.cardWork!.finished(String(a.id));
  assert.equal(board().card(a.id)!.work?.state, 'done');
  assert.equal(board().card(a.id)!.work?.conversationId, convId);
  assert.equal(app.store.messages(convId).filter((m) => m.role === 'user').length, 1, 'one run, resumed');
  // The queued card started when a slot freed up; Stop it, and the waiting one too.
  app.script.length = 0;
  await until(() => board().card(c.id)!.work?.state !== 'queued' || undefined);
  assert.equal((await api(`/api/tasks/${b.id}/work/stop`, 'POST', {})).status, 200);
  await app.cardWork!.finished(String(b.id));
  assert.equal(board().card(b.id)!.work?.state, 'stopped');
  assert.equal(roleOf(b.id), 'todo');
  await app.cardWork!.finished(String(c.id));
  app.settings.update({ toolPermissions: { write_file: 'auto', todo: 'auto' } });
});

test('a run with no receipts (only words) waits on the owner with what she said; an answer resumes it', async () => {
  const n = board().addCard(board().general().id, { title: 'Pick a banner colour' });
  app.script.push(text('Blue or green? I will wait for you.'));
  app.cardWork!.assign(String(n.id), 'sara', 'me');
  await app.cardWork!.finished(String(n.id));
  const w = board().card(n.id)!.work!;
  assert.equal(w.state, 'waiting');
  assert.deepEqual(w.ask, { kind: 'question', text: 'Blue or green? I will wait for you.' });
  assert.equal(roleOf(n.id), 'waiting');
  app.script.push([call('n1', 'write_file', { path: 'banner.md', content: 'green' })], text('I wrote banner.md: green.'));
  assert.equal((await api(`/api/tasks/${n.id}/answer`, 'POST', { text: 'Green' })).status, 200);
  await app.cardWork!.finished(String(n.id));
  assert.equal(board().card(n.id)!.work?.state, 'done');
  assert.equal(board().card(n.id)!.work?.conversationId, w.conversationId, 'the same conversation');
});

test('card_ask waits on the owner with the question; the answer on the card goes back into the same run', async () => {
  const q = board().addCard(board().general().id, { title: 'Pick a colour' });
  app.script.push([call('q1', 'card_ask', { question: 'Blue or green?' })], [call('q2', 'write_file', { path: 'colour.md', content: 'green' })], text('Green it is: I wrote colour.md.'));
  app.cardWork!.assign(String(q.id), 'sara', 'me');
  await until(() => board().card(q.id)!.work?.ask?.kind === 'question');
  assert.equal(board().card(q.id)!.work!.ask!.text, 'Blue or green?');
  assert.equal(roleOf(q.id), 'waiting');
  assert.equal((await api(`/api/tasks/${q.id}/answer`, 'POST', { text: 'Green' })).status, 200);
  await app.cardWork!.finished(String(q.id));
  assert.equal(board().card(q.id)!.work?.state, 'done');
  const toolMsg = app.store.messages(board().card(q.id)!.work!.conversationId).find((m) => m.role === 'tool');
  assert.match(String(toolMsg?.content ?? ''), /The owner answered: Green/);
});

test('her tools: card_move asks for cards that are not hers; board_list says what is blocked', async () => {
  const tools = createBoardTools(() => app);
  const move = tools.find((t) => t.spec.name === 'card_move')!;
  const mine = board().addCard(board().general().id, { title: 'Hers' });
  board().setAssignee(mine.id, 'sara', 'me');
  const other = board().addCard(board().general().id, { title: 'Not hers' });
  assert.equal(move.asksFirst!({ task: mine.id }), false);
  assert.equal(move.asksFirst!({ task: other.id }), true);
  const prep = await move.prepare!({ task: other.id, column: 'Doing' }, { signal: new AbortController().signal });
  assert.equal(prep.summary, 'Move “Not hers” from To do to Doing');
  const list = await tools.find((t) => t.spec.name === 'board_list')!.run({}, { signal: new AbortController().signal } as never);
  assert.match(list, /Write report\.md — .*BLOCKED, waiting on the owner: I think it's done/);
  assert.equal(tools.find((t) => t.spec.name === 'card_assign')!.defaultPermission, 'ask');
});

test('a helper card runs through TeamManager with the card\'s limits', async () => {
  app.team = new TeamManager(app, app.store.db);
  const seen: unknown[] = [];
  const start = app.team.start.bind(app.team);
  app.team.start = (conv, goal, opts = {}) => (seen.push(opts.limits), start(conv, goal, opts));
  const h = board().addCard(board().general().id, { title: 'Research lemonade recipes' });
  board().setCard(h.id, { limits: { minutes: 10, tokens: 50_000, steps: 5 } });
  app.script.push(text('Found three recipes: classic, ginger, mint.'), text('Done: the researcher found three recipes.'));
  app.cardWork!.assign(String(h.id), 'helper:researcher', 'me');
  await app.cardWork!.finished(String(h.id));
  assert.deepEqual(seen[0], { minutes: 10, tokens: 50_000, steps: 5 });
  const card = board().card(h.id)!;
  assert.equal(card.work?.kind, 'team');
  assert.equal(app.team.get(card.work!.id!)!.limits.tokens, 50_000);
  assert.equal(card.work?.state, 'done', JSON.stringify(card.work));
  app.team = undefined;
});

test('shared boards: members see shared cards only by membership; work runs in the assigner\'s own space; others see the outcome', async () => {
  const shared = new SharedBoardStore(':memory:');
  const known = ['owner', 'ana', 'ben'];
  const bd = shared.create('owner', 'Groceries', ['ana'], known);
  assert.deepEqual(shared.invitesFor('ana').map((i) => i.boardId), [bd.id]);
  assert.equal(shared.view('ana', bd.id), undefined, 'not before accepting');
  assert.ok(shared.accept('ana', bd.id));
  const card = shared.addCard('owner', bd.id, { title: 'Milk', notes: 'oat' })!;
  assert.equal(shared.view('ana', bd.id)!.cards[0].title, 'Milk');
  // Ben isn't on it: nothing by id, nothing in his lists.
  assert.equal(shared.view('ben', bd.id), undefined);
  assert.equal(shared.card('ben', card.ref), undefined);
  assert.equal(shared.activity('ben', card.ref), undefined);
  assert.equal(shared.move('ben', card.ref, shared.columns(1)[1].id), undefined);
  assert.deepEqual(shared.boardsFor('ben'), []);
  // The owner's private planner board is structurally elsewhere: the shared store has no such rows.
  assert.equal(shared.card('ana', 's999'), undefined);
  // Ana asks HER Sara: the conversation is in Ana's space, with Ana's limits.
  const { dir: anaDir, cleanup: anaClean } = tempDir();
  const ana = makeApp(anaDir, clock);
  ana.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', disclosureAcceptedAt: clock.now.toISOString() });
  // Ana's limits (src/household.ts MemberPolicy): every model call in her space is checked against them.
  const checked: string[] = [];
  ana.member = { checkModel: (p: string, m: string) => void checked.push(`model ${p}/${m}`), checkBudget: () => void checked.push('budget'), limits: () => ({ models: [{ providerId: 'p', model: 'm' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false }), record: () => undefined } as never;
  const anaServer = createSaraServer({ app: ana, auth: new OwnerAuth(anaDir, () => clock.now), webDir: join(ROOT, 'web') });
  void anaServer;
  const worker = new CardWorker(ana, [shared.source('ana')], 'ana');
  ana.tools.add(writeFileTool);
  ana.settings.update({ toolPermissions: { write_file: 'auto' } });
  ana.script.push([call('m1', 'write_file', { path: 'groceries.md', content: '- oat milk\n' })], text('I wrote groceries.md with oat milk on it.'));
  worker.assign(card.ref, 'sara', 'me');
  await worker.finished(card.ref);
  const forAna = shared.card('ana', card.ref)!;
  assert.equal(forAna.work?.state, 'done', JSON.stringify(forAna.work));
  assert.equal(forAna.work?.by, 'ana');
  assert.ok(forAna.work?.conversationId && ana.store.getConversation(forAna.work.conversationId), 'the work is in Ana\'s space');
  assert.equal(app.store.getConversation(forAna.work!.conversationId!), undefined, 'not in the owner\'s');
  assert.ok(checked.includes('model p/m'), 'with Ana\'s limits');
  const forOwner = shared.card('owner', card.ref)!;
  assert.equal(forOwner.work?.conversationId, undefined, 'the owner sees only the outcome');
  assert.equal(forOwner.work?.state, 'done');
  // The owner's worker can't run Ana's card, and Ben can't stop it.
  assert.equal(new CardWorker(app, [shared.source('owner')], 'owner').stop(card.ref), false);
  // Leaving removes access; the creator deletes; an assignee keeps a copy.
  shared.source('ana').setAssignee(Number(card.ref.slice(1)), 'member:ana', 'me');
  shared.update('ana', card.ref, { status: 'open' });
  const copies: string[] = [];
  assert.ok(shared.remove('owner', bd.id, (p, c) => copies.push(`${p}:${c.title}`)));
  assert.deepEqual(copies, ['ana:Milk']);
  assert.equal(shared.view('ana', bd.id), undefined);
  ana.store.close();
  anaClean();
  shared.close();
});

test('Today shows waiting cards (Needs you) and her work (Doing); plugins get event:board', async () => {
  const t = await buildToday(app);
  assert.ok(t.board?.waiting.some((c) => c.title === 'Write report.md' && /couldn't prove/.test(c.question)));
  const mgr = readFileSync(join(ROOT, 'src', 'plugins', 'manager.ts'), 'utf8');
  assert.match(mgr, /ev\.type === 'board'[\s\S]{0,200}type = 'board'/, 'PluginManager.#onEvent sends event:board');
  const seen: unknown[] = [];
  const off = app.events!.subscribe((ev) => ev.type === 'board' && seen.push(ev));
  board().addCard(board().general().id, { title: 'Pushes an event' });
  off();
  assert.ok(seen.length >= 1, 'a board change is pushed to /api/events');
  assert.ok(!JSON.stringify(seen).includes('Pushes an event'), 'ids only, never what the card says');
});

test('demo: a sample board per visitor, Assign shows a scripted run', async () => {
  const { dir: d2, cleanup: c2 } = tempDir();
  const demo = makeApp(d2, clock);
  const demoAuth = new OwnerAuth(d2, () => clock.now);
  const s2 = createSaraServer({ app: demo, auth: demoAuth, webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  const tok = demoAuth.newToken!;
  const h = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const list = await (await fetch(`${b2}/api/boards`, { headers: h })).json() as { boards: { id: number; name: string }[]; demo: boolean };
  assert.equal(list.demo, true);
  const garden = list.boards.find((b) => b.name === 'Garden party')!;
  const v = await (await fetch(`${b2}/api/boards/${garden.id}`, { headers: h })).json() as { cards: { id: number; title: string }[] };
  const lemon = v.cards.find((c) => c.title === 'Find three lemonade recipes')!;
  const r = await fetch(`${b2}/api/tasks/${lemon.id}/assign`, { method: 'POST', headers: h, body: JSON.stringify({ assignee: 'sara' }) });
  assert.equal(r.status, 200);
  let state = '';
  for (let i = 0; i < 80 && state !== 'done'; i++) {
    await new Promise((res) => setTimeout(res, 100));
    const x = await (await fetch(`${b2}/api/boards/${garden.id}`, { headers: h })).json() as { cards: { id: number; work: { state: string; receipts?: unknown[] } | null }[] };
    state = x.cards.find((c) => c.id === lemon.id)?.work?.state ?? '';
  }
  assert.equal(state, 'done', 'the scripted run ends in Done with receipts');
  s2.close();
  demo.store.close();
  c2();
});

test('web: drag with pointer events (mouse, pen, touch), keyboard moves announced, the phone layout, tips and strings', async () => {
  const js = readFileSync(join(ROOT, 'web', 'board.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'web', 'board.css'), 'utf8');
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const ev of ["'pointerdown'", "'pointermove'", "'pointerup'", "'pointercancel'"]) assert.ok(js.includes(ev), ev);
  assert.match(js, /touchmove[\s\S]{0,120}passive: false/, 'the page does not scroll under a carried card');
  assert.match(js, /LONG_PRESS_MS = 350/);
  for (const k of ["e.key === ' '", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "e.key === 'Escape'"]) assert.ok(js.includes(k), k);
  assert.match(html, /id="bd-live" class="bd-sr" aria-live="polite"/);
  // The pure helpers: neighbours for the move, the drop index, the announcement.
  const src = js.replace(/^import .*$/gm, '').replace(/\bt\(/g, '__t(');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(`const __t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(p[k]));\nconst document = undefined, localStorage = undefined;\n${src}`).toString('base64')}`);
  assert.deepEqual(mod.neighbours(['1', '2', '3'], '2'), { after: '1', before: '3' });
  assert.deepEqual(mod.neighbours(['5'], '5'), { after: null, before: null });
  assert.equal(mod.dropIndex([10, 30, 50], 35), 2);
  assert.equal(mod.movedLine('Fix login', 'Doing', 2, 5), 'Moved Fix login to Doing, position 2 of 5');
  // Phone: one column per screen with snap, the column tab strip, the sheet with the safe area.
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
  assert.match(phone, /grid-auto-columns: calc\(100% - 28px\)/);
  assert.match(phone, /scroll-snap-type: x mandatory/);
  assert.match(phone, /\.bd-tabs \{ display: flex/);
  assert.match(phone, /var\(--safe-b\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colours only through theme tokens');
  assert.doesNotMatch(css.replace(/var\(--safe-[tb]\)/g, ''), /safe-area-inset/, 'safe areas only through the variables');
  assert.ok(!/style="/.test(html.slice(html.indexOf('data-panel="board"'), html.indexOf('data-panel="reminders"'))), 'no inline style');
  for (const id of ['bd-board', 'bd-concurrent', 'bd-col-wip', 'cd-lim-minutes']) assert.ok(html.includes(`id="${id}"`), id);
  // The six languages carry the board's words.
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const dict = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const k of ['Board', 'Waiting on you', 'Moved {title} to {column}, position {index} of {of}', 'Picked up {title}. Arrow keys move it, Space drops it, Escape cancels.']) assert.ok(dict[k], `${lang}: ${k}`);
  }
  const sw = readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8');
  assert.match(sw, /caches\.open\('sara-shell-v33'\)/);
});

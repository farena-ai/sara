// S3 (docs/GOALS.md "Goals over days"): long-running goals above errands. A goal becomes a plan of
// milestones with due dates; a milestone may start a task, a reminder, an errand or an automation
// through their own engines (never a copy); the reminder tick checks progress, nudges before a
// checkpoint, proposes a new plan when something slips (applied only by the person) and sends a
// weekly summary per goal. Members' goals stay in their own space. A fake clock; no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Automations } from '../src/automations.ts';
import { Errands } from '../src/errands.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { LongGoals, GOAL, type LongGoalOptions } from '../src/long-goals.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { createLongGoalTools } from '../src/tools/long-goals.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function rig(t: TestContext, o: { now?: string; quiet?: () => boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? '2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  app.errands = new Errands(app, app.store.db, { runTask: async () => ({ reply: 'ok' }), notify: async () => undefined, quiet: () => false, ownAddresses: () => [] });
  app.automations = new Automations(app, app.store.db);
  const pushed: { title: string; body: string }[] = [];
  const opts: LongGoalOptions = { notify: async (title, body) => void pushed.push({ title, body }), quiet: o.quiet ?? (() => false) };
  const goals = new LongGoals(app, app.store.db, opts);
  app.longGoals = goals;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const tick = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
    return goals.due(clock.now);
  };
  const said = (id: number) => {
    const g = goals.get(id)!;
    return g.conversationId ? app.store.messages(g.conversationId).map((m) => m.content) : [];
  };
  return { app, clock, goals, pushed, tick, said, dir };
}

const HOUSE = {
  title: 'Get my house sale paperwork done',
  due: '2026-12-15',
  milestones: [
    { text: 'Gather the deed and mortgage papers', due: '2026-11-20', kind: 'task' },
    { text: 'Ask the title company for the payoff letter', due: '2026-11-27', kind: 'errand' },
    { text: 'Book the notary', due: '2026-12-05', kind: 'reminder' },
    { text: 'Sign and send everything', due: '2026-12-12' },
  ],
};

test('S3 plan: milestones with due dates; a plan made from the words alone when none are given; checks', (t) => {
  const r = rig(t);
  const p = r.goals.plan(HOUSE);
  assert.equal(p.title, HOUSE.title);
  assert.equal(p.due, '2026-12-15');
  assert.deepEqual(p.milestones.map((m) => [m.due, m.kind, m.status]), [['2026-11-20', 'task', 'todo'], ['2026-11-27', 'errand', 'todo'], ['2026-12-05', 'reminder', 'todo'], ['2026-12-12', 'none', 'todo']]);
  // No milestones: three evenly spread checkpoints up to the due date (code only, no model).
  const plain = r.goals.plan({ title: 'Learn to make bread', due: '2026-12-16' });
  assert.equal(plain.milestones.length, 3);
  assert.deepEqual(plain.milestones.map((m) => m.due), ['2026-11-26', '2026-12-06', '2026-12-16']);
  assert.throws(() => r.goals.plan({ title: '  ' }), /Say what the goal is/);
  assert.throws(() => r.goals.plan({ title: 'x', milestones: Array.from({ length: GOAL.maxMilestones + 1 }, (_, i) => ({ text: `m${i}` })) }), /at most/);
  // Bad dates are dropped, not guessed; milestones are sorted by date.
  const odd = r.goals.plan({ title: 'y', milestones: [{ text: 'b', due: '2026-12-01' }, { text: 'a', due: 'soon' }, { text: 'c', due: '2026-11-20' }] });
  assert.deepEqual(odd.milestones.map((m) => [m.text, m.due]), [['c', '2026-11-20'], ['b', '2026-12-01'], ['a', null]]);
  // The card's words: each milestone, what it starts and that acting still asks.
  const text = r.goals.planText(HOUSE);
  assert.match(text, /1\. Gather the deed .*Nov 20.*task/);
  assert.match(text, /errand.*waits for your Start/i);
  assert.match(text, /asks you first/i);
});

test('S3 milestones start real tasks, reminders, errands and automations through their own engines', async (t) => {
  const r = rig(t);
  const g = r.goals.create(HOUSE, { by: 'page' });
  assert.equal(g.status, 'active');
  // Only the current milestone starts its thing: one task now.
  const tasks = r.app.planner!.tasks({ status: 'all' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, 'Gather the deed and mortgage papers');
  assert.ok(tasks[0]!.dueAt?.startsWith('2026-11-20'), 'due on its date');
  assert.deepEqual(r.goals.get(g.id)!.milestones[0]!.link, { kind: 'task', id: tasks[0]!.id });
  assert.equal(r.app.errands!.list().length, 0, 'later errands wait for their turn');
  // The task is done in the Planner → the milestone is done on the next check; the errand is planned (not started).
  r.app.planner!.updateTask(tasks[0]!.id, { status: 'done' });
  r.tick(2 * HOUR);
  const g2 = r.goals.get(g.id)!;
  assert.equal(g2.milestones[0]!.status, 'done');
  const errands = r.app.errands!.list();
  assert.equal(errands.length, 1);
  assert.equal(errands[0]!.status, 'planning', 'an errand from a goal waits for the person’s Start (approval rules unchanged)');
  assert.equal(errands[0]!.deadline, '2026-11-27');
  assert.deepEqual(g2.milestones[1]!.link, { kind: 'errand', id: errands[0]!.id });
  // The errand finishes → the milestone is done; the reminder milestone sets a real reminder.
  r.app.errands!.confirm(errands[0]!.id);
  (r.app.store.db as import('node:sqlite').DatabaseSync).prepare("UPDATE errands SET status = 'done' WHERE id = ?").run(errands[0]!.id);
  r.tick(2 * HOUR);
  const g3 = r.goals.get(g.id)!;
  assert.equal(g3.milestones[1]!.status, 'done');
  const rem = r.app.planner!.reminders({ status: 'pending' });
  assert.equal(rem.length, 1);
  assert.match(rem[0]!.text, /Book the notary/);
  assert.deepEqual(g3.milestones[2]!.link, { kind: 'reminder', id: rem[0]!.id });
  // The person ticks the rest off; the goal is done with a summary.
  r.goals.update(g.id, { done: 2 }, { by: 'person' });
  r.goals.update(g.id, { done: 3 }, { by: 'person' });
  const end = r.goals.get(g.id)!;
  assert.equal(end.status, 'done');
  assert.ok(r.pushed.some((p) => /Goal done/.test(p.title)));
  assert.ok(end.history.some((h) => /Done/.test(h.text)));
});

test('S3 an automation milestone is made switched off: it acts only once the person turns it on', (t) => {
  const r = rig(t);
  const g = r.goals.create({ title: 'Save for a bike', due: '2027-02-01', milestones: [{ text: 'Weekly savings check', due: '2026-12-01', kind: 'automation', automation: { name: 'Savings check', trigger: { kind: 'schedule', every: 'week', time: '09:00', days: [1] }, actions: [{ kind: 'notify', text: 'Did you move $20 to savings?' }] } }] }, { by: 'page' });
  const autos = r.app.automations!.list();
  assert.equal(autos.length, 1);
  assert.equal(autos[0]!.enabled, false);
  assert.deepEqual(r.goals.get(g.id)!.milestones[0]!.link, { kind: 'automation', id: autos[0]!.id });
});

test('S3 the tick: checks at most hourly, nudges once before a checkpoint, quiet hours hold the push', (t) => {
  let quiet = false;
  const r = rig(t, { quiet: () => quiet });
  const g = r.goals.create(HOUSE, { by: 'page' });
  assert.equal(r.tick(10 * 60_000), 0, 'checked at creation: not again within the hour');
  // 2026-11-19 15:00Z: the first checkpoint (Nov 20) is tomorrow → one nudge.
  r.clock.now = new Date('2026-11-19T15:00:00Z');
  assert.equal(r.goals.due(r.clock.now), 1);
  assert.equal(r.pushed.filter((p) => /Checkpoint/.test(p.title)).length, 1);
  assert.ok(r.said(g.id).some((m) => /Gather the deed/.test(m) && /tomorrow/i.test(m)));
  r.tick(2 * HOUR);
  assert.equal(r.pushed.filter((p) => /Checkpoint/.test(p.title)).length, 1, 'once per checkpoint');
  // Quiet hours: the chat line is kept, the phone stays quiet.
  quiet = true;
  r.goals.update(g.id, { done: 0 }, { by: 'person' });
  r.clock.now = new Date('2026-11-26T15:00:00Z');
  const n = r.pushed.length;
  r.goals.due(r.clock.now);
  assert.equal(r.pushed.length, n, 'no push in quiet hours');
  assert.ok(r.said(g.id).some((m) => /payoff letter/.test(m)));
  assert.ok(!/setInterval/.test(readFileSync(join(ROOT, 'src', 'long-goals.ts'), 'utf8')), 'no timer of its own');
  assert.ok(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8').includes('this.#app.longGoals?.due(now)'));
});

test('S3 slips: a missed checkpoint becomes a proposal; only the person applies it; dates move in the linked engines', (t) => {
  const r = rig(t);
  const g = r.goals.create(HOUSE, { by: 'page' });
  const taskId = r.goals.get(g.id)!.milestones[0]!.link!.id;
  // Nov 22: the Nov 20 checkpoint was missed.
  r.clock.now = new Date('2026-11-22T16:00:00Z');
  r.goals.due(r.clock.now);
  const p = r.goals.get(g.id)!.proposal!;
  assert.ok(p, 'a proposal, not a silent change');
  assert.match(p.why, /Gather the deed/);
  assert.deepEqual(p.moves.map((m) => [m.index, m.from, m.to]), [[0, '2026-11-20', '2026-11-24'], [1, '2026-11-27', '2026-12-01'], [2, '2026-12-05', '2026-12-09'], [3, '2026-12-12', '2026-12-15']]);
  assert.equal(r.goals.get(g.id)!.milestones[0]!.due, '2026-11-20', 'nothing moved yet');
  assert.ok(r.pushed.some((x) => /new plan/i.test(x.title)));
  // One proposal at a time; the same slip isn't proposed twice.
  r.tick(2 * HOUR);
  assert.equal(r.goals.get(g.id)!.proposal!.at, p.at);
  // The model can't apply it.
  const update = createLongGoalTools(() => r.app).find((x) => x.spec.name === 'goal_update')!;
  assert.equal(update.defaultPermission, 'auto');
  assert.throws(() => r.goals.accept(g.id, { by: 'model' }), /Only you/);
  // The person does: milestones and the linked task move.
  const after = r.goals.accept(g.id, { by: 'person' });
  assert.equal(after.proposal, null);
  assert.deepEqual(after.milestones.map((m) => m.due), ['2026-11-24', '2026-12-01', '2026-12-09', '2026-12-15']);
  assert.ok(r.app.planner!.task(taskId)!.dueAt!.startsWith('2026-11-24'));
  assert.ok(after.history.some((h) => /new plan/i.test(h.text)));
});

test('S3 slips: no room before the due date → the proposal moves the goal’s date; dismiss keeps the plan', (t) => {
  const r = rig(t);
  const g = r.goals.create({ title: 'File the paperwork', due: '2026-11-25', milestones: [{ text: 'Fill the forms', due: '2026-11-20' }, { text: 'Mail them', due: '2026-11-25' }] }, { by: 'page' });
  r.clock.now = new Date('2026-11-24T16:00:00Z');
  r.goals.due(r.clock.now);
  const p = r.goals.get(g.id)!.proposal!;
  // The slipped one gets two days from today (Nov 26 = +6 days); the rest and the goal's date move as much.
  assert.deepEqual(p.due, { from: '2026-11-25', to: '2026-12-01' });
  assert.deepEqual(p.moves.map((m) => m.to), ['2026-11-26', '2026-12-01']);
  const d = r.goals.dismiss(g.id);
  assert.equal(d.proposal, null);
  assert.equal(d.due, '2026-11-25');
  r.tick(2 * HOUR);
  assert.equal(r.goals.get(g.id)!.proposal, null, 'a dismissed slip is not proposed again');
});

test('S3 an errand that stops counts as a slip', (t) => {
  const r = rig(t);
  const g = r.goals.create({ title: 'Refund the trip', due: '2026-12-20', milestones: [{ text: 'Get the airline refund', due: '2026-12-10', kind: 'errand' }] }, { by: 'page' });
  const eid = r.goals.get(g.id)!.milestones[0]!.link!.id;
  r.app.errands!.stop(eid, 'no answer');
  r.tick(2 * HOUR);
  const p = r.goals.get(g.id)!.proposal!;
  assert.match(p.why, /errand stopped/i);
});

test('S3 weekly summary per goal, once a week', (t) => {
  const r = rig(t);
  const a = r.goals.create(HOUSE, { by: 'page' });
  const b = r.goals.create({ title: 'Learn to make bread', due: '2027-01-10' }, { by: 'page' });
  r.tick(6 * DAY);
  assert.equal(r.pushed.filter((p) => /This week/.test(p.title)).length, 0);
  r.tick(DAY + HOUR);
  const weekly = r.pushed.filter((p) => /This week/.test(p.title));
  assert.equal(weekly.length, 2, 'one per goal');
  assert.ok(r.said(a.id).some((m) => /0 of 4 milestones/.test(m)));
  assert.ok(r.said(b.id).some((m) => /Next:/.test(m)));
  r.tick(2 * HOUR);
  assert.equal(r.pushed.filter((p) => /This week/.test(p.title)).length, 2, 'not again the same week');
  // Paused goals stay silent.
  r.goals.pause(a.id);
  r.tick(7 * DAY + HOUR);
  assert.equal(r.pushed.filter((p) => /This week/.test(p.title) && /house/i.test(p.body + p.title)).length, 1);
});

test('S3 private local mode pauses the checks; stop and remove; limits', (t) => {
  const r = rig(t);
  const g = r.goals.create(HOUSE, { by: 'page' });
  r.clock.now = new Date('2026-11-22T16:00:00Z');
  setPrivateLocal(true);
  try {
    assert.equal(r.goals.due(r.clock.now), 0);
    assert.equal(r.goals.get(g.id)!.proposal, null);
  } finally {
    setPrivateLocal(false);
  }
  const s = r.goals.stop(g.id);
  assert.equal(s.status, 'stopped');
  assert.equal(r.goals.list({ open: true }).length, 0);
  assert.ok(r.goals.remove(g.id));
  // Goals can't start in a private chat.
  const conv = r.app.store.createConversation({ private: true });
  assert.throws(() => r.goals.create(HOUSE, { by: 'chat', conversationId: conv.id }), /private chat/);
});

test('S3 household isolation: each space has its own goals', (t) => {
  const a = rig(t);
  const b = rig(t);
  (b.app as { member?: unknown }).member = { id: 'm1', name: 'Ana' };
  a.goals.create(HOUSE, { by: 'page' });
  b.goals.create({ title: 'Run a 10k', due: '2027-03-01' }, { by: 'page' });
  assert.deepEqual(a.goals.list().map((x) => x.title), [HOUSE.title]);
  assert.deepEqual(b.goals.list().map((x) => x.title), ['Run a 10k']);
  assert.equal(b.goals.list()[0]!.owner, 'member');
  assert.equal(a.app.planner!.tasks({ status: 'all' }).length, 1, 'the owner’s planner has only the owner’s task');
});

test('S3 tools: goal_create asks with the plan; goal_status reads; goal_update notes and ticks off', async (t) => {
  const r = rig(t);
  const tools = createLongGoalTools(() => r.app);
  const by = (n: string) => tools.find((x) => x.spec.name === n)!;
  assert.deepEqual(tools.map((x) => x.spec.name), ['goal_create', 'goal_status', 'goal_update']);
  assert.equal(by('goal_create').defaultPermission, 'ask');
  assert.equal(by('goal_status').interruptible, true);
  const card = by('goal_create').summarize!(HOUSE);
  assert.match(card, /Gather the deed/);
  const ctx = { workspaceDir: r.dir, signal: AbortSignal.timeout(5000) } as never;
  const out = await by('goal_create').run(HOUSE, ctx);
  assert.match(out, /Goal #1/);
  const st = await by('goal_status').run({}, ctx);
  assert.match(st, /#1 .*0 of 4/);
  const one = await by('goal_status').run({ id: '1' }, ctx);
  assert.match(one, /1\. \[ \] Gather the deed/);
  await by('goal_update').run({ id: '1', done: 1, note: 'Found the deed' }, ctx);
  const g = r.goals.get(1)!;
  assert.equal(g.milestones[0]!.status, 'done');
  assert.ok(g.history.some((h) => /Found the deed/.test(h.text)));
  // Lean: goal words bring the tools, in six languages.
  for (const tool of tools) assert.equal(familyOf(tool).id, 'goals', tool.spec.name);
  for (const w of ['my goal', 'by december', 'milestone', 'mi meta', 'mon objectif', 'mein ziel', 'minha meta', 'il mio obiettivo']) assert.ok(FAMILY_WORDS.goals!.includes(w), w);
});

test('S3 Today tile: active goals with progress and the next step; a proposal first', (t) => {
  const r = rig(t);
  assert.equal(r.goals.todayTile(), undefined);
  const g = r.goals.create(HOUSE, { by: 'page' });
  let tile = r.goals.todayTile()!;
  assert.equal(tile.items[0]!.title, HOUSE.title);
  assert.equal(tile.items[0]!.pct, 0);
  assert.match(tile.items[0]!.next!, /Gather the deed/);
  r.clock.now = new Date('2026-11-22T16:00:00Z');
  r.goals.due(r.clock.now);
  tile = r.goals.todayTile()!;
  assert.equal(tile.proposals, 1);
  assert.equal(tile.items[0]!.proposal, true);
  void g;
});

test('S3 wiring: tick, tools, routes, persona, page, tile, docs and strings', () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  assert.match(read('src', 'main.ts'), /createLongGoalTools/);
  assert.match(read('src', 'server.ts'), /createLongGoalRoutes/);
  assert.match(read('src', 'household.ts'), /'goal-plans'/);
  assert.match(read('src', 'persona.ts'), /## Goals over days/);
  assert.match(read('src', 'lean.ts'), /goal_\(create\|status\|update\)/);
  const html = read('web', 'index.html');
  assert.match(html, /<dialog id="goals"/);
  assert.match(html, /data-dest="goals"/);
  assert.match(html, /id="td-goals"/);
  assert.match(read('web', 'nav.js'), /'goals'/);
  assert.match(read('web', 'today.js'), /\{ id: 'td-goals'/);
  assert.match(read('src', 'today-layout.ts'), /\{ id: 'td-goals'/);
  assert.match(read('docs', 'GOALS.md'), /## Goals over days/);
  assert.match(read('CHANGELOG.md'), /Goals over days/);
  const web = read('web', 'long-goals.js');
  assert.doesNotMatch(web, /style=/, 'no inline styles');
  assert.match(web, /proposalCard/, 'the new plan shows as a proposal card');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(read('web', 'i18n', `${lang}.json`)) as Record<string, string>;
    for (const s of ['Goals', 'A new plan', 'Use the new plan', 'Keep the old plan', 'Next step']) assert.ok(d[s] && d[s] !== s, `${lang}: ${s}`);
  }
});

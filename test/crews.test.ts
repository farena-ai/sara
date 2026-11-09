// EC12 (docs/ops/EC1213_DESIGN.md): crews. A two-member crew's weekly slot produces a report file
// within budget, one board card per member with its receipts, one lead summary and one crew card;
// Stop all stops and pauses; the owner's mail rule; the policy pin; templates; restart.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { boardFor } from '../src/board.ts';
import { CrewError, Crews, loadCrewTemplates } from '../src/crews.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { TeamManager } from '../src/team.ts';
import { listDir, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

function rig(t: TestContext, start = '2026-11-04T12:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(start) };
  const app = makeApp(dir, clock);
  for (const tool of [listDir, readFileTool, writeFileTool]) app.tools.add(tool);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { list_dir: 'auto', read_file: 'auto', write_file: 'auto' } });
  app.team = new TeamManager(app, app.store.db);
  app.board = boardFor(app.planner!);
  const sent: { kind: string; text: string; name?: string }[] = [];
  app.bridges = { telegram: { ownerLinked: () => true, toOwner: async (s: string) => (sent.push({ kind: 'text', text: s }), true), fileToOwner: async (_p: string, name: string, caption: string) => (sent.push({ kind: 'file', text: caption, name }), true) } } as never;
  const crews = new Crews(app, app.store.db);
  app.crews = crews;
  t.after(() => {
    setPolicy(new PolicyStore());
    app.store.close();
    cleanup();
  });
  return { app, dir, clock, crews, sent };
}

const WEEKLY = { name: 'Weekly report', brief: 'Write a short weekly report on the project for Alex.', members: [{ helper: 'researcher', task: 'Find what changed this week in the notes' }, { helper: 'writer', task: 'Write the weekly report' }], limits: { tokens: 50_000, minutes: 10, steps: 4 }, schedule: { kind: 'weekly', day: 5, time: '09:00' }, alsoTo: ['telegram'] };

test('crews: a two-member crew produces the weekly report within budget, with receipts per card', async (t) => {
  const r = rig(t);
  const crew = r.crews.create(WEEKLY);
  assert.equal(crew.nextAt, '2026-11-06T09:00:00.000Z', 'next Friday 09:00 in his time zone');
  const conv = r.app.store.getConversation(crew.conversationId)!;
  assert.equal(conv.title, 'Crew: Weekly report');
  const sched = new ReminderScheduler(r.app, r.app.planner!);
  sched.tick();
  assert.equal(r.crews.runs(crew.id).length, 0, 'not due yet');
  r.app.script.push(
    [call('r1', 'list_dir', { path: '.' })],
    text('Looked at the workspace: the notes folder is where this week happened.'),
    [call('w1', 'write_file', { path: 'draft.md', content: '# Week\nThings moved.\n' })],
    text('Wrote draft.md with the weekly report.'),
    text('The crew finished the weekly report: the researcher looked at the workspace and the writer wrote draft.md.'),
  );
  r.clock.now = new Date('2026-11-06T09:00:30Z');
  sched.tick();
  const [run] = r.crews.runs(crew.id);
  assert.ok(run, 'the weekly slot started a run');
  assert.equal(run.why, 'schedule');
  const done = await r.crews.finished(run.id);
  assert.equal(done.status, 'done', JSON.stringify(done));
  // Within budget: the team task's own counts never passed the crew's limits.
  const task = r.app.team!.get(done.teamTaskId!)!;
  assert.equal(task.status, 'done');
  assert.ok(task.tokens <= 50_000);
  assert.deepEqual(task.steps.map((s) => s.helper), ['researcher', 'writer']);
  // The deliverable: a file in the crew's folder with the lead's summary and the receipts.
  const ws = workspaceDir(r.dir, conv.workspace);
  assert.equal(done.file, 'crews/weekly-report/2026-11-06-0900.md');
  const file = join(ws, done.file!);
  assert.ok(existsSync(file));
  const body = readFileSync(file, 'utf8');
  assert.match(body, /# Weekly report/);
  assert.match(body, /the writer wrote draft\.md/);
  assert.match(body, /Researcher[\s\S]*list_dir: ok/);
  assert.match(body, /Writer[\s\S]*write_file: ok \(draft\.md\)/);
  // One board card per member, on the crew's own board, in Done, each with its receipts.
  const cards = done.cards.map((id) => r.app.board!.card(id)!);
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.equal(r.app.board!.column(c.columnId)!.role, 'done');
    assert.ok(r.app.board!.activity(c.id).some((a) => a.what === 'receipt'), `${c.title} has a receipt`);
  }
  assert.equal(r.app.board!.board(r.app.board!.boardOf(cards[0]).id)!.name, 'Crew: Weekly report');
  // One crew card in the crew chat; the lead's one summary is there too.
  const msgs = r.app.store.messages(conv.id);
  const card = msgs.filter((m) => m.role === 'notice' && m.meta?.crew);
  assert.equal(card.length, 1);
  assert.equal((card[0].meta!.crew as { runId: number }).runId, run.id);
  assert.equal(msgs.filter((m) => m.role === 'assistant' && m.meta?.team).length, 1, 'one summary');
  // Telegram: the summary and the file.
  assert.ok(r.sent.some((s) => s.kind === 'file' && s.name === '2026-11-06-0900.md'));
  // Next slot a week later; the same slot never runs twice.
  assert.equal(r.crews.get(crew.id)!.nextAt, '2026-11-13T09:00:00.000Z');
  sched.tick();
  assert.equal(r.crews.runs(crew.id).length, 1);
});

test('crews: Stop all stops a running crew and pauses every crew', async (t) => {
  const r = rig(t);
  r.app.settings.update({ toolPermissions: { list_dir: 'auto', read_file: 'auto', write_file: 'ask' } });
  const crew = r.crews.create({ ...WEEKLY, members: [{ helper: 'writer', task: 'Write the weekly report' }], alsoTo: [] });
  const other = r.crews.create({ ...WEEKLY, name: 'Second', alsoTo: [] });
  r.app.script.push([call('w0', 'write_file', { path: 'x.md', content: 'x' })]);
  const run = r.crews.run(crew.id, 'manual');
  await new Promise((res) => setTimeout(res, 50));
  const out = r.crews.stopAll();
  assert.equal(out.stopped, 1);
  assert.equal(out.paused, 2);
  const done = await r.crews.finished(run.id);
  assert.equal(done.status, 'stopped');
  assert.equal(r.crews.get(crew.id)!.state, 'paused');
  assert.equal(r.crews.get(other.id)!.state, 'paused');
  r.clock.now = new Date('2026-11-06T09:00:30Z');
  assert.equal(r.crews.due(r.clock.now), 0, 'paused crews never start');
  assert.throws(() => r.crews.run(crew.id, 'schedule'), CrewError);
});

test('crews: a mail rule fires only on the owner\'s verified mail with the subject words', async (t) => {
  const r = rig(t);
  const crew = r.crews.create({ ...WEEKLY, schedule: { kind: 'manual' }, mail: { subject: 'weekly report' }, alsoTo: [] });
  assert.equal(r.crews.onMail({ subject: 'Lunch?', owner: true }), 0);
  assert.equal(r.crews.onMail({ subject: 'Fwd: WEEKLY report please', owner: false }), 0, 'never on someone else\'s mail');
  assert.equal(r.crews.onMail({ subject: 'Fwd: WEEKLY report please', owner: true }), 1);
  const [run] = r.crews.runs(crew.id);
  assert.equal(run.why, 'mail');
  assert.equal(r.crews.onMail({ subject: 'weekly report again', owner: true }), 0, 'not twice while running');
  await r.crews.finished(run.id);
});

test('crews: the policy pin crews=off refuses create, run, schedule and mail', (t) => {
  const r = rig(t);
  const crew = r.crews.create({ ...WEEKLY, mail: { subject: 'report' }, alsoTo: [] });
  const pol = new PolicyStore(r.dir);
  setPolicy(pol);
  pol.set({ name: 'House', pins: { crews: 'off' } });
  assert.throws(() => r.crews.create(WEEKLY), (e: CrewError) => e.status === 403);
  assert.throws(() => r.crews.run(crew.id, 'manual'), (e: CrewError) => e.status === 403);
  r.clock.now = new Date('2026-11-06T09:00:30Z');
  assert.equal(r.crews.due(r.clock.now), 0);
  assert.equal(r.crews.onMail({ subject: 'report', owner: true }), 0);
  assert.throws(() => pol.set({ name: 'House', pins: { crews: 'on' } }));
});

test('crews: checks what the owner sends', (t) => {
  const r = rig(t);
  const bad = (body: Record<string, unknown>) => assert.throws(() => r.crews.create({ ...WEEKLY, ...body }), (e: CrewError) => e.status === 400, JSON.stringify(body));
  bad({ name: '' });
  bad({ brief: 'short' });
  bad({ members: [] });
  bad({ members: Array.from({ length: 5 }, () => ({ helper: 'writer', task: 'Write it all' })) });
  bad({ members: [{ helper: 'nobody', task: 'Do the thing' }] });
  bad({ folder: '../outside' });
  bad({ folder: '/etc' });
  bad({ folder: '.ssh/keys' });
  bad({ schedule: { kind: 'weekly', day: 9, time: '09:00' } });
  bad({ schedule: { kind: 'daily', time: '25:00' } });
  bad({ alsoTo: ['discord'] });
  const c = r.crews.create({ ...WEEKLY, folder: 'reports/weekly' });
  assert.equal(c.folder, 'reports/weekly');
  const p = r.crews.patch(c.id, { limits: { tokens: 20_000 }, state: 'paused' });
  assert.equal(p.limits.tokens, 20_000);
  assert.equal(p.state, 'paused');
  assert.equal(p.nextAt, null);
});

test('crews: three starter templates, each a valid crew', (t) => {
  const r = rig(t);
  const tpl = loadCrewTemplates(join(ROOT, 'templates', 'crews'));
  assert.deepEqual(tpl.map((x) => x.id).sort(), ['code-review-crew', 'research-desk', 'weekly-planner']);
  for (const x of tpl) {
    const c = r.crews.create({ ...x.crew, alsoTo: [] });
    assert.ok(c.members.length >= 2, x.id);
    r.crews.remove(c.id);
  }
});

test('crews: after a restart a run that was going is marked interrupted', (t) => {
  const r = rig(t);
  const crew = r.crews.create({ ...WEEKLY, alsoTo: [] });
  r.app.store.db.prepare("INSERT INTO crew_runs (crew_id, why, status, started_at) VALUES (?, 'manual', 'running', ?)").run(crew.id, r.clock.now.toISOString());
  const again = new Crews(r.app, r.app.store.db);
  assert.equal(again.runs(crew.id)[0].status, 'interrupted');
});

test('crews: crews.ts has no timer of its own and rides the reminder tick', () => {
  const src = readFileSync(join(ROOT, 'src', 'crews.ts'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout\(|crontab|schtasks/);
  assert.match(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8'), /this\.#app\.crews\?\.due\(now\)/);
});

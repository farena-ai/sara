// N7 (docs/WORK_AND_TEAMS.md): shared lists with assignees across household spaces, the client
// pipeline moved by E6 quotes and invoices, and time tracking (math, overlaps, invoices from hours
// that never double-bill, the time-sheet source). Invented people: Alex (owner), Ana and Ben (members).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Automations } from '../src/automations.ts';
import { bizStore } from '../src/biz/store.ts';
import { imagesOf, renderDocument } from '../src/documents/make.ts';
import { cleanSpec } from '../src/documents/spec.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { eligibleFor, familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { PeopleStore } from '../src/people.ts';
import { SharedBoardStore, type SharedBoardsAccess } from '../src/shared-boards.ts';
import { buildToday, TODAY_PARTS } from '../src/today.ts';
import { todayLoaders } from '../src/today-parts.ts';
import { createBizTools } from '../src/tools/biz.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { clientsOf, createWorkTools, timeOf, WORK_TOOLS } from '../src/tools/work.ts';
import { stageFor } from '../src/work/clients.ts';
import { clockMinutes, roundHours, sumHours } from '../src/work/time.ts';
import { makeApp, tempDir } from './helpers.ts';

const NOW = new Date('2026-11-13T15:00:00Z'); // Fri Nov 13 2026, 9:00 AM in Chicago
const PEOPLE = [
  { id: 'owner', name: 'Alex' },
  { id: 'ana', name: 'Ana' },
  { id: 'ben', name: 'Ben' },
];

type T = { after: (fn: () => void) => void };
function space(t: T, person: string, shared?: SharedBoardStore, clock = { now: NOW }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.people = new PeopleStore(app.store.db);
  if (shared) app.sharedBoards = { store: shared, person, people: () => PEOPLE } satisfies SharedBoardsAccess;
  const tools = [...createWorkTools(() => app), ...createBizTools(() => app)];
  for (const x of tools) app.tools.add(x);
  const conv = app.store.createConversation({ title: 'work' }).id;
  const ctx = (): ToolContext => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: 'tests' }, conversationId: conv }) as ToolContext;
  const tool = (n: string): Tool => tools.find((x) => x.spec.name === n)!;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, conv, clock, dir, tool, run: async (n: string, a: Record<string, unknown>) => String(await tool(n).run(a, ctx())) };
}

// ---------------------------------------------------------------- shared lists

test('N7 sharing: only explicitly shared lists cross spaces; members see them after accepting, with assignee and done-by', async (t) => {
  const shared = new SharedBoardStore(':memory:');
  t.after(() => shared.close());
  const owner = space(t, 'owner', shared);
  const ana = space(t, 'ana', shared);
  const ben = space(t, 'ben', shared);
  // The owner's own to-dos and a list shared only with Ben never reach Ana.
  owner.app.planner!.addTask({ title: 'Private: call the lawyer' });
  shared.create('owner', 'Gifts for Ana', ['ben'], PEOPLE.map((p) => p.id));
  const made = await owner.run('list_share', { list: 'Groceries', people: ['Ana'], items: ['Milk', 'Eggs'] });
  assert.match(made, /Made the shared list “Groceries” with Ana, with 2 items/);
  // Before accepting: an invitation only, no list.
  const before = await ana.run('household_lists', {});
  assert.match(before, /Invitations waiting: “Groceries” from Alex/);
  assert.doesNotMatch(before, /Milk|Gifts|lawyer/);
  const inv = shared.invitesFor('ana')[0]!;
  assert.ok(shared.accept('ana', inv.boardId));
  // Assign (owner → Ana) with a due date; Ana is notified, the owner is not.
  const heard: { to: string; title: string; by: string }[] = [];
  shared.assignedListeners.add((ev) => heard.push({ to: ev.to, title: ev.title, by: ev.by }));
  const out = await owner.run('task_assign', { list: 'groceries', task: 'Milk', to: 'Ana', due: 'saturday 10am' });
  assert.match(out, /Updated “Milk” on Groceries: given to Ana \(they get a notification\), due/);
  assert.deepEqual(heard, [{ to: 'ana', title: 'Milk', by: 'owner' }]);
  await owner.run('task_assign', { list: 'Groceries', task: 'Bread', to: 'me' });
  assert.equal(heard.length, 1, 'taking an item yourself notifies nobody');
  // Ana's own space: the list with the assignee, her \"Shared with you\", never the owner's private things.
  const seen = await ana.run('household_lists', {});
  assert.match(seen, /List “Groceries” \(shared with Alex\): 3 open/);
  assert.match(seen, /Milk → you, due Sat/);
  assert.match(seen, /Bread → Alex/);
  assert.doesNotMatch(seen, /Gifts|lawyer/);
  const w = shared.sharedWith('ana');
  assert.deepEqual(w.assigned.map((a) => [a.title, a.board, a.by]), [['Milk', 'Groceries', 'owner']]);
  assert.equal(shared.sharedWith('ben').lists.length, 0, 'Ben has only an invitation to Gifts');
  // Ana ticks it off: done-by is Ana; Ben can't touch Groceries.
  await ana.run('task_assign', { list: 'Groceries', task: 'Milk', done: true });
  const milk = shared.view('owner', inv.boardId)!.cards.find((c) => c.title === 'Milk')!;
  assert.equal(milk.status, 'done');
  assert.equal(milk.doneBy, 'ana');
  assert.match(await owner.run('household_lists', { list: 'groceries' }), /✓ Milk \(done by Ana\)/);
  await assert.rejects(ben.run('task_assign', { list: 'Groceries', task: 'Eggs', to: 'Ben' }), /No shared list called “Groceries”/);
  // A person not on the list can't be given an item.
  await assert.rejects(owner.run('task_assign', { list: 'Groceries', task: 'Eggs', to: 'Ben' }), /Ben isn't on “Groceries” yet/);
  // Today: Ana's tile shows the item given to her (reopened) by name.
  await owner.run('task_assign', { list: 'Groceries', task: 'Eggs', to: 'Ana' });
  const today = await buildToday(ana.app, { parts: ['shared'], loaders: todayLoaders() });
  assert.deepEqual(today.shared?.assigned.map((a) => a.title), ['Eggs']);
  assert.equal((today.shared?.assigned[0] as { byName?: string }).byName, 'Alex');
  const benToday = await buildToday(ben.app, { parts: ['shared'], loaders: todayLoaders() });
  assert.deepEqual(benToday.shared?.invites.map((i) => i.name), ['Gifts for Ana']);
  assert.equal((await buildToday(space(t, 'owner').app, { parts: ['shared'], loaders: todayLoaders() })).shared, undefined, 'no household: no tile');
});

test('N7 list tools: private chats leave out sharing, lean families and words, member route, Today parts', (t) => {
  const s = space(t, 'owner', new SharedBoardStore(':memory:'));
  const conv = s.app.store.getConversation(s.conv)!;
  const priv = eligibleFor(s.app, { ...conv, private: true }).map((x) => x.spec.name);
  assert.ok(!priv.includes('list_share') && !priv.includes('task_assign'), 'sharing never runs from a private chat');
  assert.ok(priv.includes('time_start') && priv.includes('household_lists'));
  assert.equal(familyOf({ spec: { name: 'task_assign' } } as Tool).id, 'teamwork');
  assert.equal(familyOf({ spec: { name: 'time_invoice' } } as Tool).id, 'clients');
  assert.equal(familyOf({ spec: { name: 'clients_pipeline' } } as Tool).id, 'clients');
  for (const w of ['grocery list', 'assign', 'asignar', 'einkaufsliste', 'assegna']) assert.ok(FAMILY_WORDS.teamwork!.includes(w), w);
  for (const w of ['invoice my hours', 'timer', 'cliente', 'stunden', 'ore']) assert.ok(FAMILY_WORDS.clients!.includes(w), w);
  assert.ok(MEMBER_ROUTES.has('work'));
  assert.ok(TODAY_PARTS.includes('shared') && TODAY_PARTS.includes('worktime'));
  assert.equal(WORK_TOOLS.length, 11);
  assert.equal(s.tool('list_share').defaultPermission, 'ask', 'sharing a list with someone asks first');
});

// ---------------------------------------------------------------- clients pipeline

test('N7 pipeline: E6 quotes and invoices move stages (quoted, won, invoiced, paid), values follow, a new round restarts', async (t) => {
  const s = space(t, 'owner');
  // Without a client list, invoices don't start one.
  await s.run('invoice_make', { kind: 'quote', client: 'Walk-in Co', items: [{ desc: 'Fix', qty: 1, unit_price: 50 }] });
  assert.equal(clientsOf(s.app).list().length, 0, 'the pipeline never appears unasked');
  assert.match(await s.run('client_add', { name: 'Acme Corp', email: 'pat@acme.example', rate: 85 }), /Added client #\d+ Acme Corp <pat@acme.example> · Lead · \$85\.00\/h \(on their People card too\)/);
  assert.ok(s.app.people!.list({ q: 'Acme Corp' }).some((p) => p.relation === 'client'));
  const id = clientsOf(s.app).find('acme')!.id;
  const stage = () => clientsOf(s.app).get(id)!;
  await s.run('invoice_make', { kind: 'quote', client: 'Acme Corp', items: [{ desc: 'Website', qty: 10, unit_price: 85 }] });
  assert.equal(stage().stage, 'quoted');
  assert.equal(stage().valueCents, 85000);
  assert.equal(stage().nextStep, 'Follow up on quote Q-2026-0002');
  assert.equal(stage().nextDate, '2026-11-20');
  await s.run('invoice_mark', { id: 'Q-2026-0002', status: 'accepted' });
  assert.equal(stage().stage, 'won');
  assert.equal(stage().nextStep, '', 'the quote follow-up goes once it is won');
  await s.run('invoice_make', { client: 'Acme Corp', items: [{ desc: 'Website', qty: 10, unit_price: 85 }, { desc: 'Hosting', qty: 1, unit_price: 120.5 }] });
  assert.equal(stage().stage, 'invoiced');
  assert.equal(stage().valueCents, 85000, 'an invoice keeps the quoted deal value');
  await s.run('invoice_mark', { id: 'INV-2026-0001', status: 'sent' });
  assert.equal(stage().stage, 'invoiced', 'sent does not move it');
  await s.run('invoice_mark', { id: 'INV-2026-0001', status: 'paid' });
  assert.equal(stage().stage, 'paid');
  // Never backwards: an old quote accepted late doesn't pull a paid client back.
  await s.run('invoice_mark', { id: 'Q-2026-0002', status: 'accepted' });
  assert.equal(stage().stage, 'paid');
  assert.deepEqual(clientsOf(s.app).moves(id).map((m) => m.to), ['lead', 'quoted', 'won', 'invoiced', 'paid']);
  // A new quote starts a new round; an unknown client is added now that the list is used.
  await s.run('invoice_make', { kind: 'quote', client: 'Acme Corp', items: [{ desc: 'Phase 2', qty: 1, unit_price: 2000 }] });
  assert.equal(stage().stage, 'quoted');
  await s.run('invoice_make', { kind: 'quote', client: 'Globex <ops@globex.example>', items: [{ desc: 'Audit', qty: 2, unit_price: 300 }] });
  assert.equal(stage().valueCents, 200000, 'a new quote sets the value');
  const g = clientsOf(s.app).find('Globex')!;
  assert.equal(g.stage, 'quoted');
  assert.equal(g.email, 'ops@globex.example');
  assert.equal(stageFor({ kind: 'invoice', what: 'sent' }), undefined);
});

test('N7 pipeline: value math by stage, overdue next steps, client_stage by hand, follow_ups lists due steps', async (t) => {
  const s = space(t, 'owner');
  await s.run('client_add', { name: 'Alpha', value: 1000, stage: 'lead', next_step: 'Call about scope', next_date: '2026-11-10' });
  await s.run('client_add', { name: 'Beta', value: '2,500.50', stage: 'won' });
  await s.run('client_add', { name: 'Gamma', value: 99.99, stage: 'paid' });
  await s.run('client_add', { name: 'Delta', value: 400, stage: 'lead', next_step: 'Send samples', next_date: 'today' });
  const p = clientsOf(s.app).pipeline('2026-11-13');
  const by = Object.fromEntries(p.stages.map((x) => [x.stage, [x.count, x.valueCents]]));
  assert.deepEqual(by.lead, [2, 140000]);
  assert.deepEqual(by.won, [1, 250050]);
  assert.equal(p.openCents, 390050);
  assert.equal(p.wonCents, 250050 + 9999);
  assert.deepEqual(p.overdue.map((c) => c.name), ['Alpha']);
  assert.deepEqual(p.due.map((c) => c.name), ['Delta']);
  const text = await s.run('clients_pipeline', {});
  assert.match(text, /Clients: 4\. Open value \$3,900\.50 \(lead to invoiced\); won \$2,600\.49/);
  assert.match(text, /Next steps overdue: Alpha: Call about scope \(was due Nov 10, 2026\)/);
  assert.match(await s.run('client_stage', { client: 'alpha', stage: 'lost' }), /Alpha: Lead → Lost/);
  assert.equal(clientsOf(s.app).pipeline('2026-11-13').overdue.length, 0, 'a lost client has no due step');
  await assert.rejects(s.run('client_stage', { client: 'Nobody' }), /No client “Nobody”/);
  await assert.rejects(s.run('client_add', { name: 'Zed', stage: 'maybe' }), /stage is one of/);
  // follow_ups without a mailbox still lists the client steps that are due.
  const f = await s.run('follow_ups', {});
  assert.match(f, /client Delta \(lead\): Send samples \(due today\)/);
});

// ---------------------------------------------------------------- time

test('N7 time math: 0.1 h rounding, sums without float dust, clock words', () => {
  assert.equal(roundHours(2), 0);
  assert.equal(roundHours(3), 0.1, '3 minutes rounds up');
  assert.equal(roundHours(75), 1.3);
  assert.equal(roundHours(120), 2);
  assert.equal(roundHours(9 * 60 + 2), 9);
  assert.equal(sumHours([0.1, 0.2, 0.3]), 0.6);
  assert.equal(sumHours([1.1, 2.2, 3.3, 0.4]), 7);
  assert.equal(clockMinutes('9:30'), 570);
  assert.equal(clockMinutes('2:15 pm'), 855);
  assert.equal(clockMinutes('12am'), 0);
  assert.equal(clockMinutes('0930'), 570);
  assert.equal(clockMinutes('25:00'), undefined);
});

test('N7 time tracking: timer start/stop with a 10 h reminder, one timer at a time, overlaps refused, overnight entries', async (t) => {
  const s = space(t, 'owner');
  assert.match(await s.run('time_start', { client: 'Acme Corp', project: 'Website', note: 'header' }), /Timer started for Acme Corp · Website/);
  const rem = s.app.planner!.reminders({ status: 'pending', kind: 'timed' });
  assert.equal(rem.length, 1);
  assert.equal(rem[0]!.dueAt, new Date(NOW.getTime() + 10 * 3_600_000).toISOString(), 'reminder at 10 hours');
  s.clock.now = new Date(NOW.getTime() + 47 * 60_000);
  // A second start stops the first (0.8 h) and starts anew.
  assert.match(await s.run('time_start', { project: 'Admin' }), /Stopped the timer for Acme Corp · Website at 0\.8 h\. Timer started for Admin/);
  s.clock.now = new Date(NOW.getTime() + 77 * 60_000);
  assert.match(await s.run('time_stop', {}), /Stopped: #2 Nov 13, 2026 9:47 AM-10:17 AM 0\.5 h · Admin\. Today so far: 1\.3 h/);
  assert.equal(s.app.planner!.reminders({ status: 'pending', kind: 'timed' }).length, 0, 'reminders cleared on stop');
  assert.equal(await s.run('time_stop', {}), 'No timer is running.');
  // Overlap with the timed entries is refused; next to them is fine.
  await assert.rejects(s.run('time_add', { date: '2026-11-13', start: '10:00', end: '11:00', client: 'Acme Corp' }), /overlaps time already logged \(#2 Admin 2026-11-13\)/);
  assert.match(await s.run('time_add', { date: '2026-11-13', start: '10:17', end: '11:00', client: 'Acme Corp' }), /0\.7 h · Acme Corp/);
  // Overnight: 22:00-07:00 = 9 h on the day it starts.
  assert.match(await s.run('time_add', { date: '2026-11-11', start: '22:00', end: '7:00', project: 'Night shift' }), /Nov 11, 2026 10:00 PM-7:00 AM 9\.0 h/);
  assert.match(await s.run('time_add', { date: 'yesterday', hours: 1.24, client: 'Acme Corp' }), /Nov 12, 2026 1\.2 h/);
  await assert.rejects(s.run('time_add', { date: '2026-11-13', hours: 30 }), /between 0 and 24/);
  await assert.rejects(s.run('time_add', { date: '2026-11-13', hours: 0.04 }), /rounds to 0 hours/);
  const r = await s.run('time_report', { from: '2026-11-09', to: '2026-11-13' });
  assert.match(r, /Hours Nov 9, 2026 – Nov 13, 2026: 12\.2 h in 5 entries/);
  assert.match(r, /- Acme Corp: 2\.7 h \(unbilled\)/);
  const byDay = timeOf(s.app).report('2026-11-09', '2026-11-13', 'day');
  assert.deepEqual(byDay.groups.map((g) => [g.key, g.hours]), [['2026-11-11', 9], ['2026-11-12', 1.2], ['2026-11-13', 2]]);
  // Today: running timer and the week's hours.
  await s.run('time_start', { client: 'Acme Corp' });
  s.clock.now = new Date(NOW.getTime() + (77 + 11 * 60) * 60_000);
  const d = await buildToday(s.app, { parts: ['worktime'], loaders: todayLoaders() });
  assert.equal(d.worktime?.timer?.client, 'Acme Corp');
  assert.equal(d.worktime?.timer?.long, true, 'over 10 hours shows a warning');
  assert.equal(d.worktime?.week, 12.2);
});

test('N7 invoice my hours: lines from unbilled time at the client rate, entries marked billed, never billed twice; void frees them', async (t) => {
  const s = space(t, 'owner');
  await s.run('client_add', { name: 'Acme Corp', email: 'pat@acme.example', stage: 'won' });
  await s.run('time_add', { date: '2026-11-10', start: '9:00', end: '10:30', client: 'Acme Corp', project: 'Website' });
  await s.run('time_add', { date: '2026-11-12', hours: 0.5, client: 'acme corp', project: 'Website', note: 'fixes' });
  await s.run('time_add', { date: '2026-11-12', hours: 1, client: 'Acme Corp', project: 'Support' });
  await s.run('time_add', { date: '2026-11-12', hours: 3, client: 'Other Client' });
  await assert.rejects(s.run('time_invoice', { client: 'Acme Corp' }), /has no hourly rate yet/);
  const out = await s.run('time_invoice', { client: 'Acme Corp', rate: 85 });
  assert.match(out, /Made invoice INV-2026-0001 for Acme Corp .*<pat@acme.example>/);
  assert.match(out, /Website \(hours, Nov 10, 2026 – Nov 12, 2026\) 2 × \$85\.00 = \$170\.00; Support \(hours, Nov 12, 2026\) 1 × \$85\.00 = \$85\.00/);
  assert.match(out, /total \$255\.00/);
  assert.match(out, /Billed 3\.0 h of tracked time \(3 entries\) at \$85\.00\/h on INV-2026-0001/);
  const inv = bizStore(s.app).find('INV-2026-0001')!;
  assert.equal(inv.totalCents, 25500);
  assert.equal(clientsOf(s.app).find('Acme Corp')!.rateCents, 8500, 'the rate is saved on the client');
  assert.equal(clientsOf(s.app).find('Acme Corp')!.stage, 'invoiced');
  assert.equal(timeOf(s.app).billedOn(inv.id).length, 3);
  // Again: nothing left to bill.
  assert.match(await s.run('time_invoice', { client: 'Acme Corp' }), /No unbilled time for Acme Corp\./);
  assert.equal(bizStore(s.app).invoices().length, 1);
  // Billed entries can't be deleted; a held entry can't be taken by a second invoice.
  assert.throws(() => timeOf(s.app).remove(timeOf(s.app).billedOn(inv.id)[0]!.id), /billed on an invoice/);
  const e = timeOf(s.app).add({ day: '2026-11-13', hours: 2, client: 'Acme Corp' }, 'America/Chicago');
  assert.equal(timeOf(s.app).reserve([e.id]), 1);
  assert.equal(timeOf(s.app).reserve([e.id]), 0, 'held once only');
  timeOf(s.app).settle([e.id], null);
  // Voiding the invoice frees its hours; they can be billed again on a new number.
  await s.run('invoice_mark', { id: 'INV-2026-0001', status: 'void' });
  assert.equal(timeOf(s.app).billedOn(inv.id).length, 0);
  const again = await s.run('time_invoice', { client: 'Acme Corp', through: '2026-11-12' });
  assert.match(again, /INV-2026-0002/);
  assert.match(again, /Billed 3\.0 h/);
  assert.equal(timeOf(s.app).unbilled((x) => x.client === 'Acme Corp').length, 1, 'the 11/13 entry is after "through"');
});

test('N7 time sheet: the N2 starter can use tracked time as its source', async (t) => {
  const s = space(t, 'owner');
  const tpl = renderDocument(cleanSpec({ format: 'xlsx', title: 'Time Sheet', content: '| DAY | START TIME | END TIME | REGULAR HOURS |\n|---|---|---|---|\n| | | | |\n' }), imagesOf(s.app));
  s.app.library!.add({ name: 'Time Sheet.xlsx', bytes: tpl, keep: true, origin: 'chat', learn: false });
  await s.run('time_add', { date: '2026-11-09', start: '8:00', end: '12:30', client: 'Acme Corp' });
  await s.run('time_add', { date: '2026-11-10', hours: 2.5, client: 'Acme Corp' });
  const auto = new Automations(s.app, s.app.store.db, { calendar: async () => [{ id: 'c1', title: 'Dentist', start: '2026-11-11T15:00:00Z', end: '2026-11-11T16:00:00Z', allDay: false }], notify: async () => undefined, quiet: () => false, runTask: async () => ({ reply: 'ok' }) });
  const mk = (source?: string) => auto.create({ name: `TS ${source ?? 'calendar'}`, trigger: { kind: 'schedule', every: 'week', days: [5], time: '15:00' }, actions: [{ kind: 'fill', document: 'time sheet', timesheet: { week: 'this', ...(source ? { source } : {}) } }] });
  const tracked = await auto.fire(mk('tracked').id, 'x', { dry: true, force: true });
  assert.match(tracked.steps[0]!.text, /MONDAY 0800-1230 4\.5h, TUESDAY 0900-1130 2\.5h/);
  assert.doesNotMatch(tracked.steps[0]!.text, /WEDNESDAY/);
  const both = await auto.fire(mk('both').id, 'x', { dry: true, force: true });
  assert.match(both.steps[0]!.text, /MONDAY 0800-1230 4\.5h, TUESDAY 0900-1130 2\.5h, WEDNESDAY 0900-1000 1h/);
  const cal = await auto.fire(mk().id, 'x', { dry: true, force: true });
  assert.match(cal.steps[0]!.text, /WEDNESDAY 0900-1000 1h/);
  assert.doesNotMatch(cal.steps[0]!.text, /MONDAY/);
  assert.equal(auto.get(mk('tracked').id)!.actions[0]!.timesheet!.source, 'tracked', 'the source is kept when saved');
});

test('N7 members: their own clients and hours (household-private), tools on the member route, strings and tips', (t) => {
  const shared = new SharedBoardStore(':memory:');
  t.after(() => shared.close());
  const a = space(t, 'owner', shared);
  const b = space(t, 'ana', shared);
  clientsOf(a.app).add({ name: 'Acme Corp' });
  timeOf(a.app).add({ day: '2026-11-13', hours: 2 }, 'America/Chicago');
  assert.equal(clientsOf(b.app).list().length, 0, "a member never sees the owner's clients");
  assert.equal(timeOf(b.app).list().length, 0);
  const web = (f: string) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  assert.match(web('today.js'), /\{ id: 'td-shared', section: 'needs'/);
  assert.match(web('today.js'), /\{ id: 'td-worktime', section: 'work'/);
  assert.match(web('index.html'), /id="td-shared"[^>]*>.*Shared with you/);
  assert.match(web('index.html'), /id="td-worktime"[^>]*>.*Clients and hours/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const j = web(`i18n/${lang}.json`);
    for (const k of ['Shared with you', 'Clients and hours', '{name} gave you a task']) assert.ok(j.includes(`"${k}":`), `${lang}: ${k}`);
  }
});

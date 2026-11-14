// N2 (docs/AUTOMATIONS.md): automations, one place. The model and its adapters over the existing
// stores (C4 triggers, E1/E2 watches, routines and repeating reminders), schedule math with time
// zones and DST, the runner (one at a time, history, auto-pause after three failures), approvals that
// are never bypassed, a dry run without side effects, the time sheet starter with a fixture calendar
// and Kent's template, household isolation and private chats. A fake clock and fake turns; no network.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Automations, draftFromWords, nextRun, nextRuns, STARTERS, timesheetDays, weekOf, withoutWhen, type AutomationOptions, type ScheduleTrigger } from '../src/automations.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventTriggers } from '../src/event-triggers.ts';
import { familyOf } from '../src/lean.ts';
import { readXlsxCells } from '../src/library/ooxml.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { LiveWatches } from '../src/live-watch.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { routinesFor, ROUTINES_DIR } from '../src/routines.ts';
import { ProductWatches } from '../src/shopping/watch.ts';
import { createAutomationTools } from '../src/tools/automations.ts';
import { resolveAttachments } from '../src/mail/attachments.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { timeSheet } from './fill-fixtures.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const CHICAGO = 'America/Chicago';

function rig(t: TestContext, o: { now?: string; task?: AutomationOptions['runTask']; calendar?: AutomationOptions['calendar']; tz?: string } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? '2026-11-13T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: o.tz ?? CHICAGO });
  const pushed: { title: string; body: string }[] = [];
  const tasks: string[] = [];
  const auto = new Automations(app, app.store.db, {
    runTask: o.task ?? (async (r) => (tasks.push(r.content), { reply: 'Done.' })),
    notify: async (title, body) => void pushed.push({ title, body }),
    quiet: () => false,
    ...(o.calendar ? { calendar: o.calendar } : {}),
  });
  app.automations = auto;
  auto.useRoutines((a) => routinesFor(a, ROUTINES_DIR));
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, auto, pushed, tasks, dir };
}

const friday3: ScheduleTrigger = { kind: 'schedule', every: 'week', days: [5], time: '15:00' };

test('N2 schedule math: Friday 3 PM in Chicago across the DST change, weekdays, month-end, other zones', () => {
  // Fri Oct 30 2026 15:00 CDT = 20:00Z; Fri Nov 6 2026 15:00 CST = 21:00Z (DST ended Nov 1).
  const runs = nextRuns(friday3, new Date('2026-10-28T12:00:00Z'), CHICAGO, 3).map((d) => d.toISOString());
  assert.deepEqual(runs, ['2026-10-30T20:00:00.000Z', '2026-11-06T21:00:00.000Z', '2026-11-13T21:00:00.000Z']);
  // Strictly after: at 15:00 exactly, the next is a week later.
  assert.equal(nextRun(friday3, new Date('2026-11-13T21:00:00Z'), CHICAGO)!.toISOString(), '2026-11-20T21:00:00.000Z');
  // Spring forward (Sun Mar 14 2027): 08:00 local is 14:00Z before, 13:00Z after.
  assert.deepEqual(nextRuns({ kind: 'schedule', every: 'day', time: '08:00' }, new Date('2027-03-12T20:00:00Z'), CHICAGO, 3).map((d) => d.toISOString()), ['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
  // 02:30 doesn't exist that night: it runs once, an hour later on the clock (never skipped, never twice).
  const gap = nextRuns({ kind: 'schedule', every: 'day', time: '02:30' }, new Date('2027-03-13T12:00:00Z'), CHICAGO, 2).map((d) => d.toISOString());
  assert.equal(gap.length, 2);
  assert.ok(Date.parse(gap[1]!) - Date.parse(gap[0]!) >= 22 * 3600_000);
  // Weekdays skip the weekend (Sat Nov 14 2026 → Mon Nov 16).
  assert.equal(nextRun({ kind: 'schedule', every: 'weekdays', time: '09:30' }, new Date('2026-11-14T12:00:00Z'), CHICAGO)!.toISOString(), '2026-11-16T15:30:00.000Z');
  // Day 31 in February is the last day.
  assert.deepEqual(nextRuns({ kind: 'schedule', every: 'month', day: 31, time: '07:00' }, new Date('2027-01-31T14:00:00Z'), 'UTC', 2).map((d) => d.toISOString().slice(0, 10)), ['2027-02-28', '2027-03-31']);
  // Another zone: Berlin 15:00 on Friday = 14:00Z in winter.
  assert.equal(nextRun(friday3, new Date('2026-11-10T00:00:00Z'), 'Europe/Berlin')!.toISOString(), '2026-11-13T14:00:00.000Z');
});

test('N2 plain words → a draft: the owner’s Friday time sheet, reminders, emails and calendar', () => {
  const d = draftFromWords('every Friday at 3, fill my time sheet from my calendar and send me the draft. Shifts are 2200-0700, no lunch');
  assert.deepEqual(d.trigger, { kind: 'schedule', every: 'week', days: [5], time: '15:00' });
  assert.equal(d.actions[0]!.kind, 'fill');
  assert.deepEqual(d.actions[0]!.timesheet, { week: 'this', start: '2200', end: '0700', lunchMinutes: 0 });
  assert.equal(d.actions[1]!.kind, 'notify');
  assert.deepEqual(draftFromWords('remind me every weekday at 8:30am to take my pills').trigger, { kind: 'schedule', every: 'weekdays', time: '08:30' });
  assert.equal(draftFromWords('remind me every weekday at 8:30am to take my pills').actions[0]!.text, 'take my pills');
  assert.deepEqual(draftFromWords('whenever an email arrives from billing@acme.example, add it to my bills').trigger, { kind: 'email', from: 'billing@acme.example' });
  assert.deepEqual(draftFromWords('15 minutes before each calendar event, tell me what to bring').trigger, { kind: 'calendar', minutes: 15 });
  assert.deepEqual(draftFromWords('on the 1st of every month at 9am pay rent').trigger, { kind: 'schedule', every: 'month', day: 1, time: '09:00' });
  assert.equal(draftFromWords('on the 1st of every month at 9am pay rent').actions[0]!.prompt, 'pay rent');
  assert.equal(withoutWhen('every Monday and Thursday at 7:15 pm, check the mail'), 'check the mail');
});

test('N2 create + preview: what runs, the next 3 times, the approvals; creating in a private chat is refused', (t) => {
  const r = rig(t);
  const p = r.auto.preview(STARTERS[0]!.draft);
  assert.equal(p.next.length, 3);
  assert.equal(p.next[0]!.at, '2026-11-13T21:00:00.000Z', 'today (Friday) at 3 PM Chicago');
  assert.match(p.when, /Friday/);
  assert.match(p.approvals.join(' '), /fill/i);
  assert.match(r.auto.previewText(STARTERS[0]!.draft), /next: Fri, Nov 13, 3:00 PM/);
  const a = r.auto.create(STARTERS[0]!.draft);
  assert.equal(a.enabled, true);
  assert.equal(a.nextAt, '2026-11-13T21:00:00.000Z');
  const priv = r.app.store.createConversation({ title: 'Private', private: true });
  assert.throws(() => r.auto.create(STARTERS[0]!.draft, { conversationId: priv.id }), /private chat/);
  assert.throws(() => r.auto.create({ name: 'x', trigger: { kind: 'schedule', every: 'day', time: '25:00' }, actions: [{ kind: 'notify', text: 'hi' }] }), /time like 15:00/);
  assert.throws(() => r.auto.create({ name: 'x', trigger: { kind: 'schedule', every: 'week', time: '10:00' }, actions: [{ kind: 'notify', text: 'hi' }] }), /at least one day/);
});

test('N2 one list: C4 triggers, E1 live and E2 product watches, routines and repeating reminders show and toggle through their own stores', async (t) => {
  const r = rig(t);
  const app = r.app;
  app.eventTriggers = new EventTriggers(app, app.store.db, { runPrompt: async () => ({ reply: 'ok', tokens: 1 }), notify: async () => undefined, quiet: () => false });
  const trig = app.eventTriggers.create({ name: 'Invoices', source: 'email', filter: { from: 'acme.example' }, action: { kind: 'prompt', prompt: 'File it.', tools: [] } });
  app.liveWatches = new LiveWatches(app, app.store.db);
  const lw = app.liveWatches.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400 });
  app.productWatches = new ProductWatches(app, app.store.db, async () => {
    throw new Error('no network in tests');
  });
  const pw = app.productWatches.add({ url: 'https://www.example-store.test/ip/1', label: 'WD-40', condition: 'back_in_stock' });
  const rem = app.planner!.addReminder({ text: 'Water the plants', dueAt: '2026-11-14T15:00:00Z', repeat: 'daily' });
  const mine = r.auto.create({ name: 'Morning note', trigger: { kind: 'schedule', every: 'day', time: '07:00' }, actions: [{ kind: 'notify', text: 'Good morning' }] });
  const keys = r.auto.all().map((x) => x.key);
  for (const k of [`auto:${mine.id}`, `trigger:${trig.id}`, `live:${lw.id}`, `product:${pw.id}`, `elsewhere:reminder:${rem.id}`]) assert.ok(keys.includes(k), `${k} in ${keys.join(', ')}`);
  const item = (k: string) => r.auto.all().find((x) => x.key === k)!;
  assert.match(item(`auto:${mine.id}`).when, /Every day at 7:00 AM/);
  // Toggle each through its own store.
  r.auto.toggle(`trigger:${trig.id}`, false);
  assert.equal(app.eventTriggers.get(trig.id)!.state, 'paused');
  r.auto.toggle(`trigger:${trig.id}`, true);
  assert.equal(app.eventTriggers.get(trig.id)!.state, 'on');
  r.auto.toggle(`live:${lw.id}`, false);
  assert.equal(app.liveWatches.get(lw.id)!.state, 'paused');
  assert.equal(item(`live:${lw.id}`).enabled, false);
  r.auto.toggle(`live:${lw.id}`, true);
  assert.equal(app.liveWatches.get(lw.id)!.state, 'active');
  r.auto.toggle(`product:${pw.id}`, false);
  assert.equal(app.productWatches.get(pw.id)!.state, 'paused');
  r.auto.toggle(`auto:${mine.id}`, false);
  assert.equal(r.auto.get(mine.id)!.enabled, false);
  assert.throws(() => r.auto.toggle(`elsewhere:reminder:${rem.id}`, true), /where it was set up/);
  r.auto.toggle(`elsewhere:reminder:${rem.id}`, false);
  assert.equal(app.planner!.reminders({ status: 'all', limit: 50 }).find((x) => x.id === rem.id)!.status, 'cancelled');
  // History through the trigger's own runs.
  await app.eventTriggers.observe({ source: 'email', id: 'm1', from: 'a@acme.example', verified: true, subject: 'Invoice', text: 'Invoice 1' });
  await app.eventTriggers.settled();
  assert.equal(r.auto.historyKey(`trigger:${trig.id}`)[0]!.outcome, 'done');
  // Delete through its own store.
  r.auto.removeKey(`product:${pw.id}`);
  assert.equal(app.productWatches.get(pw.id), undefined);
});

test('N2 runner: the reminder tick runs a due schedule once, one run at a time, with history', async (t) => {
  let release: (() => void) | undefined;
  const hold = { on: true };
  const r = rig(t, {
    now: '2026-11-13T20:59:00Z',
    task: async () => {
      if (hold.on) await new Promise<void>((res) => (release = res));
      return { reply: 'Checked the deploy: green.' };
    },
  });
  const a = r.auto.create({ name: 'Deploy check', trigger: friday3, actions: [{ kind: 'task', prompt: 'Check the deploy.' }, { kind: 'notify', text: 'Deploy checked.', how: 'phone' }] });
  const ticker = new ReminderScheduler(r.app, r.app.planner!);
  ticker.tick();
  assert.equal(r.auto.history(a.id).length, 0, 'not due yet');
  r.clock.now = new Date('2026-11-13T21:00:05Z');
  ticker.tick();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.auto.get(a.id)!.nextAt, '2026-11-20T21:00:00.000Z', 'the next run moved on');
  // While it runs, a second start is skipped (one at a time).
  const second = await r.auto.fire(a.id, 'Run now', { force: true });
  assert.equal(second.outcome, 'skipped');
  assert.match(second.summary, /still on the last run/);
  release!();
  hold.on = false;
  await r.auto.settled();
  const runs = r.auto.history(a.id);
  assert.equal(runs[0]!.outcome, 'skipped');
  const done = runs.find((x) => x.outcome === 'done')!;
  assert.match(done.trigger, /Scheduled/);
  assert.deepEqual(done.steps.map((s) => s.status), ['done', 'done']);
  assert.ok(done.conversationId);
  assert.equal(r.pushed.length, 1);
  assert.match(r.app.store.messages(done.conversationId!).at(-1)!.content, /Deploy checked/);
});

test('N2 auto-pause: three failed runs in a row pause it with a notification and the reason; a good run resets the count', async (t) => {
  let fail = true;
  const r = rig(t, { task: async () => (fail ? { reply: '', error: 'the site is down' } : { reply: 'ok' }) });
  const a = r.auto.create({ name: 'Flaky', trigger: { kind: 'schedule', every: 'day', time: '07:00' }, actions: [{ kind: 'task', prompt: 'Check the site.' }] });
  await r.auto.fire(a.id, 'x');
  await r.auto.fire(a.id, 'x');
  fail = false;
  await r.auto.fire(a.id, 'x');
  assert.equal(r.auto.get(a.id)!.fails, 0, 'a good run resets');
  fail = true;
  for (let i = 0; i < 3; i++) await r.auto.fire(a.id, 'x');
  const after = r.auto.get(a.id)!;
  assert.equal(after.enabled, false);
  assert.match(after.pausedReason!, /3 failures in a row: the site is down/);
  assert.ok(r.pushed.some((p) => /paused/i.test(p.title)));
  assert.equal((await r.auto.fire(a.id, 'x')).outcome, 'skipped', 'a paused one does not run on a trigger');
  assert.ok(r.auto.todayTile()!.failing.some((f) => f.id === a.id));
  r.auto.setEnabled(a.id, true);
  assert.equal(r.auto.get(a.id)!.pausedReason, null);
});

function withLibrary(r: ReturnType<typeof rig>) {
  r.app.library = new LibraryStore(r.app.store.db, r.dir, () => r.clock.now);
  return r.app.library.add({ name: 'Time Sheet Blank.xlsx', bytes: timeSheet(), keep: true, origin: 'chat', learn: false });
}
// Kent's week (Sun Nov 8 - Sat Nov 14 2026, Chicago): night shifts 22:00-07:00 Sun-Thu, a lunch-free 9 hours.
const shifts = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map((d, i) => {
  const start = new Date(`${d}T22:00:00-06:00`);
  return { id: `e${i}`, title: 'Shift', start: start.toISOString(), end: new Date(start.getTime() + 9 * 3600_000).toISOString(), allDay: false };
});

test('N2 time sheet math: overnight shifts on the day they start, rules for all-day events and fixed days', () => {
  const week = weekOf(new Date('2026-11-13T21:00:00Z'), CHICAGO);
  assert.deepEqual(week, ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  assert.equal(weekOf(new Date('2026-11-13T21:00:00Z'), CHICAGO, { week: 'last' })[0], '2026-11-01');
  const days = timesheetDays([...shifts, { id: 'x', title: 'Dentist', start: '2026-11-13T15:00:00Z', end: '2026-11-13T16:00:00Z', allDay: false }], week, CHICAGO, { words: 'shift', regularHours: 8 });
  assert.equal(days.length, 5);
  assert.deepEqual(days[0], { day: 'SUNDAY', date: '2026-11-08', start: '2200', end: '0700', hours: 9, regular: 8, overtime: 1 });
  const fixed = timesheetDays([{ id: 'a', title: 'Work', start: '2026-11-09', allDay: true }], week, CHICAGO, { start: '2200', end: '0700', lunchMinutes: 30 });
  assert.deepEqual(fixed.map((d) => [d.day, d.hours]), [['MONDAY', 8.5]]);
  const noCal = timesheetDays([], week, CHICAGO, { start: '0800', end: '1630', lunchMinutes: 30, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(noCal.map((d) => d.hours), [8, 8, 8, 8, 8]);
});

test('N2 time sheet starter: Friday 3 PM fills Kent’s template from the fixture calendar and sends the file', async (t) => {
  const r = rig(t, { now: '2026-11-13T21:00:01Z', calendar: async () => shifts });
  const blank = withLibrary(r);
  const a = r.auto.create({ ...STARTERS[0]!.draft, actions: [{ kind: 'fill', document: 'time sheet', values: { 'EMPLOYEE NAME:': 'Kent Shelton' }, timesheet: { week: 'this', words: 'shift', regularHours: 8 } }, STARTERS[0]!.draft.actions[1]!] });
  r.auto.due(new Date('2026-11-13T21:00:01Z'));
  assert.equal(r.auto.history(a.id).length, 0, 'not due until next_at (created after 3 PM)');
  const run = await r.auto.fire(a.id, 'Run now', { force: true });
  assert.equal(run.outcome, 'done', JSON.stringify(run.steps));
  assert.match(run.steps[0]!.text, /SUNDAY 2200-0700 9h/);
  const docs = r.app.library!.list().filter((d) => d.id !== blank.id);
  assert.equal(docs.length, 1, 'one filled copy');
  assert.match(docs[0]!.name, /week of 11-08-2026/);
  const cells = readXlsxCells(new Zip(r.app.library!.file(docs[0]!)!)).get('Sheet1')!;
  assert.equal(cells.get('B1'), '11/08/2026');
  assert.equal(cells.get('F1'), 'Kent Shelton');
  assert.equal(cells.get('B7'), '22:00:00', 'START TIME (a time cell)');
  assert.equal(cells.get('C7'), '0700', 'END TIME');
  assert.equal(cells.get('D7'), '8');
  assert.equal(cells.get('E7'), '1');
  assert.equal(cells.get('B12'), undefined, 'Friday: no shift');
  // The note carries the file.
  const msg = r.app.store.messages(run.conversationId!).at(-1)!;
  assert.match(msg.content, /week of 11\/08\/2026 is filled: Time Sheet Blank - week of 11-08-2026/);
  assert.equal((msg.meta as { files?: unknown[] }).files?.length, 1);
  assert.equal(r.pushed.length, 1);
});

test('N2 approvals are never bypassed: fill set to ask waits for Allow; drafts wait; send-without-asking needs mail_send to allow it', async (t) => {
  const r = rig(t, { calendar: async () => shifts });
  withLibrary(r);
  r.app.settings.update({ toolPermissions: { fill_document: 'ask' } });
  const a = r.auto.create({ name: 'TS', trigger: friday3, actions: [{ kind: 'fill', document: 'time sheet', timesheet: { words: 'shift' } }, { kind: 'notify', text: 'Filled {files}' }] });
  const run = await r.auto.fire(a.id, 'Run now', { force: true });
  assert.equal(run.outcome, 'waiting');
  assert.equal(r.app.library!.list().length, 1, 'nothing filled before the OK');
  assert.ok(r.pushed.some((p) => /needs your OK/.test(p.title)));
  assert.equal(r.auto.waiting().length, 1);
  assert.equal(r.auto.todayTile()!.waiting, 1);
  const done = await r.auto.answer(run.id, true);
  assert.equal(done.outcome, 'done', JSON.stringify(done.steps));
  assert.equal(r.app.library!.list().length, 2);
  await assert.rejects(r.auto.answer(run.id, true), /Nothing is waiting/);
  // Declined: it stops there.
  const run2 = await r.auto.fire(a.id, 'Run now', { force: true });
  assert.equal((await r.auto.answer(run2.id, false)).outcome, 'declined');
  assert.equal(r.app.library!.list().length, 2);
  // Email: mail_draft asks by default; send-without-asking is only honored when mail_send is auto.
  const sent: string[] = [];
  const mailTool = (name: string, perm: 'ask' | 'auto'): Tool => ({ spec: { name, description: '', parameters: { type: 'object', properties: {} } }, defaultPermission: perm, summarize: () => name, run: async () => (sent.push(name), `${name} ok`) });
  r.app.tools.add(mailTool('mail_draft', 'ask'));
  r.app.tools.add(mailTool('mail_send', 'ask'));
  const m = r.auto.create({ name: 'Mail', trigger: friday3, actions: [{ kind: 'draft_email', to: 'boss@example.com', subject: 'Time sheet', body: 'Attached.', sendWithoutAsking: true }] });
  assert.match(r.auto.approvals(r.auto.get(m.id)!.actions).join(' '), /mail_send asks first, so it saves a draft/);
  const mr = await r.auto.fire(m.id, 'Run now', { force: true });
  assert.equal(mr.outcome, 'waiting');
  assert.deepEqual(sent, []);
  await r.auto.answer(mr.id, true);
  assert.deepEqual(sent, ['mail_draft'], 'a draft, never a send');
  r.app.settings.update({ toolPermissions: { mail_send: 'auto' } });
  await r.auto.fire(m.id, 'Run now', { force: true });
  assert.deepEqual(sent, ['mail_draft', 'mail_send'], 'sent only with both switches on');
  // A tool set to never fails the step.
  r.app.settings.update({ toolPermissions: { fill_document: 'never' } });
  assert.equal((await r.auto.fire(a.id, 'Run now', { force: true })).outcome, 'failed');
});

test('N2 dry run: no copy, no draft, no task turn, no phone notification; a chat line labeled as a test', async (t) => {
  const r = rig(t, { calendar: async () => shifts });
  withLibrary(r);
  const sent: string[] = [];
  r.app.tools.add({ spec: { name: 'mail_draft', description: '', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => '', run: async () => (sent.push('draft'), 'ok') });
  const a = r.auto.create({ name: 'Everything', trigger: friday3, actions: [{ kind: 'fill', document: 'time sheet', timesheet: { words: 'shift' } }, { kind: 'task', prompt: 'Tidy my inbox.' }, { kind: 'draft_email', to: 'me@example.com', subject: 'TS', body: 'x' }, { kind: 'notify', text: 'All done', how: 'phone' }] });
  const run = await r.auto.fire(a.id, 'Test run', { dry: true });
  assert.equal(run.outcome, 'test');
  assert.deepEqual(run.steps.map((s) => s.status), ['test', 'test', 'test', 'test']);
  assert.match(run.steps[0]!.text, /Would fill a copy of “Time Sheet Blank.xlsx” \(not saved in the test\): SUNDAY 2200-0700 9h/);
  assert.equal(r.app.library!.list().length, 1, 'no copy kept');
  assert.deepEqual(sent, [], 'no draft');
  assert.deepEqual(r.tasks, [], 'no task turn');
  assert.equal(r.pushed.length, 0, 'no notification');
  const last = r.app.store.messages(run.conversationId!).at(-1)!;
  assert.match(last.content, /^Test run \(nothing was done\): All done/);
  assert.equal((last.meta as { files?: unknown[] }).files, undefined, 'nothing attached in a test');
  assert.equal(r.auto.get(a.id)!.fails, 0);
  // A draft (no row): nothing is created.
  const steps = await r.auto.dryDraft(draftFromWords('every Monday at 9 check my bank'));
  assert.equal(steps[0]!.status, 'test');
  assert.equal(r.auto.list().length, 1);
});

test('N2 events: an email (through C4’s observe) and a live watch firing start their automations; repeats are skipped', async (t) => {
  const r = rig(t);
  const app = r.app;
  app.eventTriggers = new EventTriggers(app, app.store.db, { runPrompt: async () => ({ reply: 'ok', tokens: 1 }), notify: async () => undefined, quiet: () => false });
  const a = r.auto.create({ name: 'Bills', trigger: { kind: 'email', from: 'acme.example', words: 'invoice' }, actions: [{ kind: 'bill', prompt: 'Add the bill from this email.' }] });
  const ev = { source: 'email' as const, id: 'm1', from: 'billing@acme.example', verified: true, subject: 'Invoice 42', text: 'Your invoice' };
  await app.eventTriggers.observe(ev);
  await app.eventTriggers.observe(ev);
  await app.eventTriggers.observe({ ...ev, id: 'm2', subject: 'Hello', text: 'no match' });
  await r.auto.settled();
  assert.equal(r.tasks.length, 1);
  assert.match(r.tasks[0]!, /Add this bill: Add the bill from this email\./);
  assert.match(r.auto.history(a.id)[0]!.trigger, /Email from billing@acme.example: Invoice 42/);
  assert.equal(r.auto.observeEvent({ ...ev, id: 'm3', self: true }).length, 0, 'her own mail never triggers');
  app.liveWatches = new LiveWatches(app, app.store.db);
  const b = r.auto.create({ name: 'AAPL', trigger: { kind: 'live', watch: { kind: 'price', symbol: 'AAPL', when: 'above', value: 400 } }, actions: [{ kind: 'notify', text: 'AAPL crossed: {detail}', how: 'chat' }] } as never);
  const ref = (r.auto.get(b.id)!.trigger as { ref: number }).ref;
  assert.ok(app.liveWatches.get(ref), 'the watch was made through its own store');
  assert.ok(!r.auto.all().some((x) => x.key === `live:${ref}`), 'a watch made for an automation is listed once');
  r.auto.watchFired('live', ref, 'AAPL is 401');
  await r.auto.settled();
  assert.equal(r.auto.history(b.id)[0]!.outcome, 'done');
  r.auto.remove(b.id);
  assert.equal(app.liveWatches.get(ref), undefined, 'and goes with it');
});

test('N2 calendar trigger: N minutes before an event, once per event', async (t) => {
  const r = rig(t, { now: '2026-11-13T15:50:00Z', calendar: async () => [{ id: 'c1', title: 'Standup', start: '2026-11-13T16:00:00Z', end: '2026-11-13T16:15:00Z', allDay: false }] });
  const a = r.auto.create({ name: 'Before meetings', trigger: { kind: 'calendar', minutes: 15 }, actions: [{ kind: 'notify', text: 'Coming up: {detail}', how: 'chat' }] });
  r.auto.due(r.clock.now);
  await r.auto.settled();
  assert.equal(r.auto.history(a.id).length, 1);
  assert.match(r.auto.history(a.id)[0]!.trigger, /Standup/);
  r.clock.now = new Date('2026-11-13T15:56:00Z');
  r.auto.due(r.clock.now);
  await r.auto.settled();
  assert.equal(r.auto.history(a.id).length, 1, 'once per event');
});

test('N2 household isolation and members: each space keeps its own; a member can’t make email automations', (t) => {
  const owner = rig(t);
  const member = rig(t);
  owner.auto.create({ name: 'Owner thing', trigger: friday3, actions: [{ kind: 'notify', text: 'x' }] });
  assert.equal(member.auto.list().length, 0);
  assert.equal(member.auto.all().filter((x) => x.source === 'automation').length, 0);
  member.app.member = { id: 'm1' } as never;
  assert.throws(() => member.auto.create({ name: 'Mail', trigger: { kind: 'email' }, actions: [{ kind: 'notify', text: 'x' }] }), /owner’s only/);
  const m = member.auto.create({ name: 'Mine', trigger: friday3, actions: [{ kind: 'notify', text: 'x' }] });
  assert.equal(m.owner, 'member');
  assert.equal(owner.auto.list().length, 1);
});

test('N2 tools: create asks once with the preview on its card; private chats are refused; list, history, disable', async (t) => {
  const r = rig(t);
  const tools = new Map(createAutomationTools(() => r.app).map((x) => [x.spec.name, x]));
  for (const n of ['automation_create', 'automation_preview', 'automation_dry_run', 'automation_list', 'automation_enable', 'automation_disable', 'automation_delete', 'automation_history']) assert.ok(tools.has(n), n);
  const create = tools.get('automation_create')!;
  assert.equal(create.defaultPermission, 'ask', 'one Allow in chat');
  assert.equal(tools.get('automation_delete')!.defaultPermission, 'ask');
  assert.equal(tools.get('automation_dry_run')!.defaultPermission, 'auto');
  const args = { description: 'every Friday at 3, fill my time sheet from my calendar and send me the draft' };
  const card = create.summarize(args);
  assert.match(card, /Make this automation:[\s\S]*When: Every Friday at 3:00 PM \(next: Fri, Nov 13, 3:00 PM; Fri, Nov 20, 3:00 PM; Fri, Nov 27, 3:00 PM\)[\s\S]*Approvals:/);
  const conv = r.app.store.createConversation({ title: 'Chat' });
  const priv = r.app.store.createConversation({ title: 'Private', private: true });
  const ctx = (id: string) => ({ conversationId: id, workspaceDir: r.dir, signal: AbortSignal.timeout(5000), sandbox: r.app.sandbox }) as ToolContext;
  await assert.rejects(create.run(args, ctx(priv.id)), /private chat/);
  assert.match(await create.run(args, ctx(conv.id)), /Made automation #1 “Fill my time sheet every week” \(on\)\. Next run: Fri, Nov 13, 3:00 PM/);
  assert.match(await tools.get('automation_list')!.run({}, ctx(conv.id)), /auto:1 on · Fill my time sheet every week/);
  assert.match(await tools.get('automation_disable')!.run({ id: '1' }, ctx(conv.id)), /paused/);
  assert.match(await tools.get('automation_history')!.run({ id: '1' }, ctx(conv.id)), /not run yet/);
  assert.match(await tools.get('automation_dry_run')!.run({ description: 'remind me every day at 7am to stretch' }, ctx(conv.id)), /Would tell you: stretch/);
});

test('N2 page, tile, lean words and i18n: Settings → You → Automations, a Today tile, the automations family, every string translated', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  assert.match(html, /<section class="settings-page" data-page="you-automations" data-group="You" data-title="Automations" hidden>/);
  assert.match(html, /id="td-automations"/);
  assert.match(web('settings-nav.js'), /'ab-when', 'you-automations', 'you-adult'/);
  assert.match(web('today.js'), /draw\('td-automations', /);
  const js = web('automations.js');
  assert.doesNotMatch(js, /style=|\.style\./, 'no inline styles');
  assert.doesNotMatch(web('begin.css').split('/* N2')[1]!.split('\n\n')[0]!, /#[0-9a-f]{3,6}\b|rgb\(/i, 'theme variables only');
  const tool = (name: string) => ({ spec: { name, description: '', parameters: {} }, defaultPermission: 'auto' as const, summarize: () => '', run: async () => '' });
  assert.equal(familyOf(tool('automation_create')).id, 'automations');
  const lean = readFileSync(join(ROOT, 'src', 'lean.ts'), 'utf8');
  for (const w of ['automate', 'every friday', 'whenever', 'remind me every', 'cada viernes', 'chaque vendredi', 'jeden freitag', 'toda sexta', 'ogni venerdi']) assert.ok(lean.includes(`'${w}'`), w);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Automations', 'Ask Sara to change it', 'Fill my time sheet every week', 'Every {days} at {time}', 'Automation paused: {name}']) assert.ok(tr[k], `${lang}: ${k}`);
  }
});

test('N4 the time sheet draft carries the filled file as an attachment (words with an address make the draft)', async (t) => {
  const d = draftFromWords('every Friday at 3, fill my time sheet from my calendar and email it to boss@work.example');
  assert.deepEqual(d.actions.map((a) => a.kind), ['fill', 'notify', 'draft_email']);
  assert.equal(d.actions[2]!.to, 'boss@work.example');
  assert.equal(draftFromWords('every Friday at 3, fill my time sheet and send me the draft').actions.length, 2, 'no address: the file comes in the chat');
  const r = rig(t, { calendar: async () => shifts });
  withLibrary(r);
  const got: Record<string, unknown>[] = [];
  r.app.tools.add({ spec: { name: 'mail_draft', description: '', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => '', run: async (args) => (got.push(args), 'Saved as a draft.') });
  const a = r.auto.create(d);
  const dry = await r.auto.fire(a.id, 'Test run', { dry: true });
  assert.match(dry.steps[2]!.text, /The filled file goes with it as an attachment/);
  assert.equal(got.length, 0);
  const run = await r.auto.fire(a.id, 'Run now', { force: true });
  assert.equal(run.outcome, 'done', JSON.stringify(run.steps));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.to, 'boss@work.example');
  assert.match(String(got[0]!.subject), /Time sheet – week of 11\/08\/2026/);
  const ids = got[0]!.attachments as string[];
  assert.equal(ids.length, 1);
  const files = resolveAttachments(r.app, ids, 'imap');
  assert.match(files[0]!.name, /^Time Sheet Blank - week of 11-08-2026\.xlsx$/);
  assert.equal(files[0]!.data.subarray(0, 2).toString(), 'PK', 'the real filled workbook');
  assert.doesNotMatch(String(got[0]!.body), /in Sara’s chat/);
});

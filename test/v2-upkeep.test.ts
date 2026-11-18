// V2.6 Car and house upkeep (docs/UPKEEP.md): schedules per car (by miles or months) and for the home
// (filters, gutters, smoke alarms) from a small built-in table, service history (by hand or from the
// receipts V2.2 Purchases already reads), a "book it" errand (the existing `book` template), and a
// Planner reminder for each next due date. Acceptance: a schedule fires a reminder; logging a service
// resets the next due.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { myDetailsFor } from '../src/my-details.ts';
import { addPurchase } from '../src/money/purchases.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { createSaraServer } from '../src/server.ts';
import { createUpkeepTools } from '../src/tools/upkeep.ts';
import { addMonths, UPKEEP_TABLE, upkeepAction, upkeepList, UpkeepError } from '../src/upkeep.ts';
import { makeApp, tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-18T15:00:00Z');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function rig(t: TestContext, now = NOW) {
  const { dir, cleanup } = tempDir();
  const clock = { now };
  const app = makeApp(dir, clock as never);
  app.now = () => clock.now;
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, dir };
}

test('V2.6 table: car rows have miles and months, home rows months only; every row a reason', () => {
  const car = UPKEEP_TABLE.filter((r) => r.place === 'car');
  const home = UPKEEP_TABLE.filter((r) => r.place === 'home');
  assert.ok(car.length >= 5 && home.length >= 5);
  for (const r of UPKEEP_TABLE) {
    assert.ok(r.everyMonths > 0 && r.everyMonths <= 24, r.key);
    assert.ok(r.title && r.why, r.key);
    if (r.place === 'home') assert.equal(r.everyMiles, null, r.key);
  }
  assert.ok(car.find((r) => r.key === 'oil')!.everyMiles! > 0);
  for (const k of ['hvac-filter', 'gutters', 'smoke-test']) assert.ok(home.some((r) => r.key === k), k);
  assert.equal(new Set(UPKEEP_TABLE.map((r) => r.key)).size, UPKEEP_TABLE.length);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'month ends clamp');
  assert.equal(addMonths('2026-11-18', 6), '2027-05-18');
});

test('V2.6 acceptance: a schedule fires a reminder; logging a service resets the next due', (t) => {
  const { app, clock } = rig(t);
  const out = upkeepAction(app, 'setup', { place: 'home' });
  assert.ok(out.added! >= 5);
  const list = upkeepList(app);
  const smoke = list.items.find((i) => i.key === 'smoke-test')!;
  // Never logged: counted from today, so nothing is \"overdue\" on day one.
  assert.equal(smoke.next.date, '2026-12-18');
  assert.equal(smoke.next.by, 'months');
  assert.ok(smoke.reminder, 'a Planner reminder for the next due date');
  const rem = app.planner!.reminder(smoke.reminder!.id)!;
  assert.equal(rem.dueAt, '2026-12-18T15:00:00.000Z', '9:00 Chicago on the due day');
  assert.match(rem.text, /Test smoke and CO alarms/);
  // Setting the same place up again adds nothing twice.
  assert.equal(upkeepAction(app, 'setup', { place: 'home' }).added, 0);
  // The reminder fires on the due day through the normal scheduler.
  const conv = app.store.createConversation();
  void conv;
  const sched = new ReminderScheduler(app, app.planner!);
  assert.equal(sched.tick(), 0);
  clock.now = new Date('2026-12-18T15:01:00Z');
  assert.ok(sched.tick() >= 1);
  assert.equal(app.planner!.reminder(rem.id)!.status, 'sent');
  const due = upkeepList(app).items.find((i) => i.key === 'smoke-test')!;
  assert.equal(due.daysLeft, 0);
  // Log it two days later: next due moves a month on, with a new reminder; the old one is not reused.
  clock.now = new Date('2026-12-20T16:00:00Z');
  const logged = upkeepAction(app, 'log', { id: smoke.id, note: 'All beep' });
  assert.equal(logged.item!.lastDate, '2026-12-20');
  assert.equal(logged.item!.next.date, '2027-01-20');
  assert.notEqual(logged.item!.reminder!.id, rem.id);
  assert.equal(app.planner!.reminder(logged.item!.reminder!.id)!.dueAt, '2027-01-20T15:00:00.000Z');
  assert.deepEqual(logged.item!.history.map((h) => [h.date, h.note, h.source]), [['2026-12-20', 'All beep', 'you']]);
  // A log with an earlier date (done before) is history, the newest date drives the schedule.
  const again = upkeepAction(app, 'log', { id: smoke.id, date: '2026-12-01' });
  assert.equal(again.item!.lastDate, '2026-12-20');
  assert.equal(again.item!.history.length, 2);
  // Reminders off: the pending reminder is cancelled and none comes back.
  const off = upkeepAction(app, 'remind', { id: smoke.id, on: false });
  assert.equal(off.item!.reminder, null);
  assert.equal(app.planner!.reminder(logged.item!.reminder!.id)!.status, 'cancelled');
});

test('V2.6 cars: from My details, by miles or months, odometer readings set the pace', (t) => {
  const { app } = rig(t);
  myDetailsFor(app.store.db).set({ vehicles: [{ year: '2019', make: 'Honda', model: 'Civic' }] }, NOW);
  assert.deepEqual(upkeepList(app).cars, ['2019 Honda Civic']);
  assert.throws(() => upkeepAction(app, 'setup', { place: 'car' }), UpkeepError, 'which car');
  upkeepAction(app, 'setup', { place: 'car', car: '2019 Honda Civic' });
  // Oil change last done at 40,000 miles on Sep 1; odometer 42,000 on Oct 1 and 44,000 on Nov 15.
  const oil = upkeepList(app).items.find((i) => i.key === 'oil')!;
  assert.equal(oil.car, '2019 Honda Civic');
  upkeepAction(app, 'log', { id: oil.id, date: '2026-09-01', miles: 40000 });
  upkeepAction(app, 'miles', { car: '2019 Honda Civic', miles: 42000, date: '2026-10-01' });
  const r = upkeepAction(app, 'miles', { car: '2019 Honda Civic', miles: 44000, date: '2026-11-15' });
  assert.equal(r.ok, true);
  const now = upkeepList(app).items.find((i) => i.key === 'oil')!;
  // 4,000 miles in 75 days (Sep 1 → Nov 15) → 45,000 miles (every 5,000) 19 days after Nov 15, well before March.
  assert.equal(now.next.by, 'miles');
  assert.equal(now.next.miles, 45000);
  assert.equal(now.next.date, '2026-12-04');
  assert.equal(upkeepList(app).odometer['2019 Honda Civic'].miles, 44000);
  // Logging with the odometer resets the miles too.
  const done = upkeepAction(app, 'log', { id: now.id, date: '2026-11-18', miles: 44100 });
  assert.equal(done.item!.next.miles, 49100);
  assert.equal(done.item!.lastMiles, 44100);
  // A service logged without miles: its miles are estimated from the readings (4,100 miles in 78 days).
  const tires = upkeepList(app).items.find((i) => i.key === 'tires')!;
  const t2 = upkeepAction(app, 'log', { id: tires.id, date: '2026-11-17' });
  assert.equal(t2.item!.next.miles, 44105 + 6000, '44,000 on Nov 15 + 2 days × ~52.6');
  // A smaller odometer number than the last reading is refused (typo guard).
  assert.throws(() => upkeepAction(app, 'miles', { car: '2019 Honda Civic', miles: 4000 }), UpkeepError);
  // Without any car in My details, a typed name works.
  upkeepAction(app, 'setup', { place: 'car', car: 'Work truck' });
  assert.ok(upkeepList(app).items.some((i) => i.car === 'Work truck' && i.key === 'oil'));
  // Own task: every 3 months, no table row.
  const own = upkeepAction(app, 'add', { place: 'home', title: 'Clean the fridge coils', everyMonths: 6 });
  assert.equal(own.item!.key, 'own');
  assert.throws(() => upkeepAction(app, 'add', { place: 'home', title: 'x', everyMonths: 0 }), UpkeepError);
  assert.equal(upkeepAction(app, 'remove', { id: own.item!.id }).ok, true);
});

test('V2.6 receipts: a service receipt (V2.2 Purchases) is offered once and logs with its date and cost', (t) => {
  const { app } = rig(t);
  myDetailsFor(app.store.db).set({ vehicles: [{ year: '2019', make: 'Honda', model: 'Civic' }] }, NOW);
  upkeepAction(app, 'setup', { place: 'car', car: '2019 Honda Civic' });
  upkeepAction(app, 'setup', { place: 'home' });
  const p = addPurchase(app, { item: 'Synthetic oil change', store: 'Quick Lube', price: '59.99', date: '2026-11-02' });
  addPurchase(app, { item: 'Desk lamp', store: 'IKEA', price: '39.99', date: '2026-11-10' });
  const g = addPurchase(app, { item: 'Gutter cleaning', store: 'Clear Gutters Co', price: 150, date: '2026-10-20' });
  const found = upkeepList(app).found;
  assert.deepEqual(found.map((f) => [f.purchaseId, f.key]).sort(), [[g.id, 'gutters'], [p.id, 'oil']].sort());
  const oil = upkeepList(app).items.find((i) => i.key === 'oil')!;
  const hit = found.find((f) => f.key === 'oil')!;
  assert.equal(hit.itemId, oil.id);
  const res = upkeepAction(app, 'log', { id: oil.id, purchaseId: p.id });
  assert.equal(res.item!.lastDate, '2026-11-02');
  assert.deepEqual(res.item!.history.map((h) => [h.source, h.costCents, h.note]), [['receipt', 5999, 'Quick Lube']]);
  assert.ok(!upkeepList(app).found.some((f) => f.purchaseId === p.id), 'offered once');
  // Not this one: it stays out of the list.
  upkeepAction(app, 'skip', { purchaseId: g.id });
  assert.equal(upkeepList(app).found.length, 0);
});

test('V2.6 book it: the existing `book` template, deadline = the next due date, the service as a fact', (t) => {
  const { app } = rig(t);
  upkeepAction(app, 'setup', { place: 'home' });
  const items = upkeepList(app).items;
  const gutters = items.find((i) => i.key === 'gutters')!;
  assert.ok(gutters.service);
  const r = upkeepAction(app, 'book', { id: gutters.id });
  assert.equal(r.errand!.template, 'book');
  assert.equal(r.errand!.deadline, gutters.next.date);
  assert.match(r.errand!.goal, /^Book gutter cleaning \(due /);
  assert.equal(upkeepList(app).items.find((i) => i.id === gutters.id)!.errandId, r.errand!.id);
  // A do-it-yourself task (test the alarms) has nothing to book.
  const smoke = items.find((i) => i.key === 'smoke-test')!;
  assert.equal(smoke.service, null);
  assert.throws(() => upkeepAction(app, 'book', { id: smoke.id }), UpkeepError);
});

test('V2.6 chat tools: upkeep_list reads, upkeep_log logs by name', async (t) => {
  const { app } = rig(t);
  upkeepAction(app, 'setup', { place: 'home' });
  const tools = createUpkeepTools(() => app);
  const list = tools.find((x) => x.spec.name === 'upkeep_list')!;
  const log = tools.find((x) => x.spec.name === 'upkeep_log')!;
  const ctx = { signal: new AbortController().signal, conversationId: null } as never;
  assert.match(String(await list.run({}, ctx)), /Replace the furnace\/AC filter.*due 2027-02-18/);
  const out = String(await log.run({ task: 'furnace filter' }, ctx));
  assert.match(out, /Logged “Replace the furnace\/AC filter” on 2026-11-18.*next due 2027-02-18/);
  await assert.rejects(async () => log.run({ task: 'paint the moon' }, ctx), /No upkeep task/);
  // Lean picks the family from everyday words.
  const lean = read('src/lean.ts');
  assert.match(lean, /upkeep_\(list\|log\)/);
  assert.match(lean, /'oil change'/);
});

test('V2.6 routes: /api/my-details/upkeep (each space its own; not on the demo)', async (t) => {
  const { app, dir } = rig(t);
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/my-details/upkeep`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  assert.equal((await call('')).json.items.length, 0);
  assert.ok((await call('/setup', { place: 'home' })).json.added >= 5);
  const g = await call('');
  assert.ok(g.json.table.length >= 10);
  const id = g.json.items[0].id;
  assert.equal((await call(`/${id}/log`, { note: 'done' })).json.item.history.length, 1);
  assert.equal((await call(`/${id}/remind`, { on: false })).json.item.reminder, null);
  assert.equal((await call('/add', { place: 'home', title: '' })).status, 400);
  assert.equal((await call('/999/log', {})).status, 404);
  assert.equal((await call(`/${id}/remove`, {})).json.ok, true);
});

test('V2.6 web: a section on My details (hosted page), its own module, tips and five languages', () => {
  const html = read('web/index.html');
  assert.match(html, /data-page="you-upkeep" data-group="You" data-title="Car and house upkeep" data-host="you-details"/);
  for (const id of ['upk-box', 'upk-setup-car', 'upk-setup-home', 'upk-add-title', 'upk-add-months', 'upk-add-miles', 'upk-odo-miles']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(read('web/settings-nav.js'), /'you-details', 'you-upkeep'/);
  const js = read('web/upkeep.js');
  assert.match(js, /\/my-details\/upkeep/);
  assert.match(read('web/my-details.js'), /loadUpkeep/, 'loaded with My details (no app.js churn)');
  const tips = JSON.parse(read('web/tips.json'));
  assert.ok(tips.pages['you-upkeep']);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.match(read(`web/i18n/${l}.json`), /"Car and house upkeep":/, l);
  assert.match(read('CHANGELOG.md'), /Car and house upkeep/);
  assert.ok(read('docs/UPKEEP.md').length > 400);
});

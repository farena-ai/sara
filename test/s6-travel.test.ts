// S6 (docs/TRAVEL.md): the travel assistant. Booking emails (three airlines, a hotel, a car, a train,
// an event) found by the inbox helper in two mailboxes become trips with a timeline (deduped, times
// with their time zones); a fake flight status source drives delay / gate / cancellation alerts with
// rebooking options (never booked); check-in 24 h before and leave-by through the existing leave-by
// engine; a packing list from trip length and a fake forecast as a shared list; add to calendar only
// on the person's tap; trip_list / trip_status. A fake clock; no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { classify, type InboxMail } from '../src/inbox/classify.ts';
import { InboxHelper } from '../src/inbox/helper.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { SharedBoardStore } from '../src/shared-boards.ts';
import { airlabsSource, Travel, type FlightStatus, type FlightStatusSource, type TravelOptions } from '../src/travel.ts';
import { createTravelTools } from '../src/tools/travel.ts';
import type { Tool } from '../src/tools/types.ts';
import { TRAVEL } from './travel-fixtures.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const HOUR = 3600_000;
const MIN = 60_000;
const NOW = '2026-11-16T15:00:00Z';

function fakeSource() {
  const statuses = new Map<string, Partial<FlightStatus>>();
  const calls: string[] = [];
  const src: FlightStatusSource = {
    id: 'fake',
    label: 'Fake status',
    async status(flight, date) {
      calls.push(`${flight}|${date}`);
      const s = statuses.get(flight);
      return s ? { state: 'scheduled', ...s, source: 'Fake status', at: new Date().toISOString() } : undefined;
    },
    async nextFlights(from, to) {
      return [
        { flight: 'SK1460', from, to, departs: '2026-11-20T12:15' },
        { flight: 'SK1474', from, to, departs: '2026-11-20T16:40' },
      ];
    },
  };
  return { src, statuses, calls };
}

function rig(t: TestContext, o: { now?: string; source?: FlightStatusSource | null; quiet?: () => boolean; calendar?: boolean; boards?: boolean; opts?: Partial<TravelOptions> } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? NOW) };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  const pushed: { title: string; body: string }[] = [];
  const weather: string[] = [];
  const fake = fakeSource();
  const opts: TravelOptions = {
    ...(o.source === null ? {} : { source: o.source ?? fake.src }),
    notify: async (title, body) => void pushed.push({ title, body }),
    quiet: o.quiet ?? (() => false),
    weather: async (place, from, to) => (weather.push(`${place.name}|${from}|${to}`), { hiC: 4, loC: -6, rainPct: 60, snow: true }),
    ...o.opts,
  };
  const travel = new Travel(app, app.store.db, opts);
  app.travel = travel;
  const calendar: Record<string, unknown>[] = [];
  if (o.calendar) {
    app.tools.add({ spec: { name: 'calendar_add', description: 'x', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'x', run: async (args) => (calendar.push(args), `Added “${String(args.title)}” (event ev${calendar.length}).\nVerified: read the event back from the calendar (event ev${calendar.length}).`) } as Tool);
  }
  let boards: SharedBoardStore | undefined;
  if (o.boards) {
    boards = new SharedBoardStore(join(dir, 'shared', 'boards.db'));
    app.sharedBoards = { store: boards, person: 'owner', people: () => [{ id: 'owner', name: 'Alex' }] };
  }
  // Two mailboxes, read by the real inbox helper (the hook feeds travel).
  const boxes: Record<string, InboxMail[]> = { 'alex@mail.test': [], 'alex@work.test': [] };
  const inbox = new InboxHelper(app, app.store.db, {
    accounts: () => Object.keys(boxes),
    readMail: async (_a, x) => boxes[x.account]!.filter((m) => !x.seen.has(m.id)),
    model: async () => '{"kind":"none"}',
    notify: async () => undefined,
    quiet: () => false,
  });
  app.inbox = inbox;
  t.after(() => {
    setPrivateLocal(false);
    boards?.close();
    app.store.close();
    cleanup();
  });
  const deliver = (account: string, ...mails: InboxMail[]) => boxes[account]!.push(...mails.map((m) => ({ ...m, account, id: `${account}:${m.id}` })));
  const at = async (iso: string) => {
    clock.now = new Date(iso);
    return travel.tick(clock.now);
  };
  return { app, clock, travel, inbox, pushed, weather, calendar, deliver, at, fake, boards, dir };
}

async function denverTrip(r: ReturnType<typeof rig>) {
  r.deliver('alex@mail.test', TRAVEL.skyway, TRAVEL.prairie, TRAVEL.hotel, TRAVEL.car, TRAVEL.concert, TRAVEL.lakeshore, TRAVEL.train);
  // The airline mail was forwarded to the work mailbox too: still one flight.
  r.deliver('alex@work.test', TRAVEL.skyway);
  await r.inbox.scan();
}

test('S6 classify: car, train, event and each flight of a two-flight mail with its own times', () => {
  const now = new Date(NOW);
  const car = classify(TRAVEL.car, now).findings[0]!;
  assert.equal(car.kind, 'trip');
  assert.deepEqual(car.car, { company: 'Peak Car Rental', pickup: 'Denver International Airport (DEN)', pickupAt: '2026-11-20T10:30', dropoff: 'Denver International Airport (DEN)', dropoffAt: '2026-11-23T15:00' });
  assert.equal(car.confirmation, 'PC90210');
  const train = classify(TRAVEL.train, now).findings[0]!;
  assert.deepEqual(train.trains, [{ train: '512', from: 'Minneapolis', to: 'Duluth', departs: '2026-12-04T09:10', arrives: '2026-12-04T11:45' }]);
  const lk = classify(TRAVEL.lakeshore, now).findings[0]!;
  assert.deepEqual(lk.flights, [
    { flight: 'LK220', from: 'ORD', to: 'MSP', departs: '2026-12-03T06:40', arrives: '2026-12-03T08:05' },
    { flight: 'LK221', from: 'MSP', to: 'ORD', departs: '2026-12-05T19:15', arrives: '2026-12-05T20:40' },
  ]);
  assert.equal(lk.confirmation, 'LK4M8N');
  const ev = classify(TRAVEL.concert, now).findings[0]!;
  assert.equal(ev.kind, 'appointment');
  assert.equal(ev.confirmation, 'FT8812');
});

test('S6 itinerary: bookings from two mailboxes become two trips with ordered timelines, deduped, times in their own zones', async (t) => {
  const r = rig(t);
  await denverTrip(r);
  const trips = r.travel.trips();
  assert.equal(trips.length, 2);
  const [den, msp] = trips;
  assert.equal(den!.title, 'Trip to Denver');
  assert.deepEqual(den!.bookings.map((b) => `${b.kind}:${b.title}`), [
    'flight:SK1452 ORD → DEN',
    'car:Peak Car Rental',
    'hotel:Mile High Inn',
    'event:Evening concert at Foothills Amphitheater',
    'flight:PJ88 DEN → ORD',
  ]);
  const out = den!.bookings[0]!;
  assert.deepEqual(out.accounts.sort(), ['alex@mail.test', 'alex@work.test'], 'one flight, seen in both mailboxes');
  assert.equal(out.startsAt, '2026-11-20T14:05:00.000Z');
  assert.equal(out.tz, 'America/Chicago');
  const home = den!.bookings[4]!;
  assert.equal(home.tz, 'America/Denver', 'a wall time is read in the departure airport’s zone');
  assert.equal(home.startsAt, '2026-11-24T00:30:00.000Z');
  assert.match(home.when, /Mon, Nov 23, 5:30 PM MST/);
  assert.equal(den!.bookings[1]!.tz, 'America/Denver', 'the car is picked up at DEN');
  assert.equal(msp!.title, 'Trip to Minneapolis');
  assert.deepEqual(msp!.bookings.map((b) => b.kind), ['flight', 'train', 'flight']);
  // A second scan of the same mail changes nothing.
  r.deliver('alex@work.test', { ...TRAVEL.prairie, id: 'again' });
  await r.inbox.scan();
  assert.equal(r.travel.trips()[0]!.bookings.length, 5);
});

test('S6 alerts: check-in 24 h before once; delay and gate change to the phone; same status is quiet; cancellation lists rebooking options and books nothing', async (t) => {
  const r = rig(t);
  await denverTrip(r);
  const sk = r.travel.trips()[0]!.bookings[0]!;
  // Check-in opens 24 h before 14:05Z.
  await r.at('2026-11-19T14:10:00Z');
  assert.equal(r.pushed.length, 1);
  assert.match(r.pushed[0]!.body, /Check-in is open for SK1452 ORD → DEN/);
  await r.at('2026-11-19T14:20:00Z');
  assert.equal(r.pushed.length, 1, 'once');
  // Delay + first gate (5 h before: checked every 10 minutes).
  r.fake.statuses.set('SK1452', { state: 'scheduled', depDelayMin: 45, depEstimated: '2026-11-20T08:50:00-06:00', depGate: 'B7' });
  await r.at('2026-11-20T09:00:00Z');
  assert.equal(r.pushed.length, 2);
  assert.match(r.pushed[1]!.body, /SK1452 ORD → DEN: delayed 45 min, now leaves 8:50 AM CST · gate B7/);
  await r.at('2026-11-20T09:11:00Z');
  assert.equal(r.pushed.length, 2, 'same status: no new alert');
  r.fake.statuses.set('SK1452', { state: 'scheduled', depDelayMin: 45, depEstimated: '2026-11-20T08:50:00-06:00', depGate: 'C3' });
  await r.at('2026-11-20T09:22:00Z');
  assert.match(r.pushed[2]!.body, /gate changed to C3 \(was B7\)/);
  r.fake.statuses.set('SK1452', { state: 'cancelled', depGate: 'C3' });
  await r.at('2026-11-20T09:33:00Z');
  const last = r.pushed.at(-1)!.body;
  assert.match(last, /SK1452 ORD → DEN is cancelled/);
  const b = r.travel.trip(sk.tripId)!.bookings[0]!;
  assert.equal(b.status?.state, 'cancelled');
  assert.ok(b.rebook && b.rebook.length >= 3);
  assert.match(JSON.stringify(b.rebook), /SK1460/);
  assert.match(JSON.stringify(b.rebook), /Skyway Air/);
  const chat = r.app.store.messages(r.travel.conversationId()).map((m) => m.content).join('\n');
  assert.match(chat, /Options:[\s\S]*SK1460[\s\S]*never book or pay/);
});

test('S6 quiet hours hold routine alerts (check-in) but not a cancellation close to departure; private local mode checks nothing', async (t) => {
  let quiet = true;
  const r = rig(t, { quiet: () => quiet });
  await denverTrip(r);
  await r.at('2026-11-19T14:10:00Z');
  assert.equal(r.pushed.length, 0, 'check-in waits in the chat');
  assert.match(r.app.store.messages(r.travel.conversationId()).at(-1)!.content, /Check-in is open/);
  r.fake.statuses.set('SK1452', { state: 'cancelled' });
  await r.at('2026-11-20T10:00:00Z');
  assert.equal(r.pushed.length, 1);
  assert.match(r.pushed[0]!.body, /cancelled/);
  quiet = false;
  setPrivateLocal(true);
  const before = r.fake.calls.length;
  r.fake.statuses.set('PJ88', { state: 'cancelled' });
  await r.at('2026-11-23T20:00:00Z');
  assert.equal(r.fake.calls.length, before, 'no status check in private local mode');
});

test('S6 leave-by: uses the existing leave-by engine for the airport and alerts once', async (t) => {
  const r = rig(t, { source: null });
  const asked: { id: string; start: string; location?: string }[] = [];
  r.app.leaveBy = { planFor: async (evs: { id: string; start: string; location?: string }[]) => (asked.push(...evs), evs.map((e) => ({ eventId: e.id, leaveAt: new Date(Date.parse(e.start) - 45 * MIN).toISOString(), minutes: 35, mode: 'car' as const }))) } as never;
  await denverTrip(r);
  await r.at('2026-11-20T10:00:00Z');
  assert.ok(asked.some((e) => /O'Hare|ORD/.test(e.location ?? '') && e.start === '2026-11-20T12:05:00.000Z'), 'be at the airport 2 hours before');
  assert.equal(r.pushed.filter((p) => /leave/i.test(p.body)).length, 0);
  await r.at('2026-11-20T11:21:00Z');
  const lb = r.pushed.filter((p) => /Time to leave/.test(p.body));
  assert.equal(lb.length, 1);
  assert.match(lb[0]!.body, /about 35 minutes/);
  await r.at('2026-11-20T11:30:00Z');
  assert.equal(r.pushed.filter((p) => /Time to leave/.test(p.body)).length, 1, 'once');
});

test('S6 no source: no status checks at all; the AirLabs slot is off until a key is saved and reads its answer', async (t) => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify({ response: { flight_iata: 'SK1452', status: 'scheduled', dep_gate: 'B9', dep_terminal: '1', dep_delayed: 20, dep_estimated: '2026-11-20 08:25', arr_gate: 'A4' } }), { status: 200 });
  };
  const r = rig(t, { source: null, opts: { fetch: fetchImpl as never } });
  await denverTrip(r);
  await r.at('2026-11-20T09:00:00Z');
  assert.equal(seen.length, 0, 'provider off by default');
  assert.equal(r.travel.settings().provider, 'off');
  const key = ['k', 'e', 'y'].join('') + 'x'.repeat(12);
  r.travel.setSettings({ provider: 'airlabs', key });
  assert.equal(JSON.stringify(r.travel.settings()).includes(key), false, 'the key stays in the vault');
  const s = await airlabsSource(key, fetchImpl as never).status('SK1452', '2026-11-20');
  assert.deepEqual({ state: s?.state, gate: s?.depGate, delay: s?.depDelayMin }, { state: 'scheduled', gate: 'B9', delay: 20 });
  assert.match(seen[0]!, /^https:\/\/airlabs\.co\/api\/v9\/flight\?flight_iata=SK1452/);
  await r.at('2026-11-20T09:30:00Z');
  assert.ok(seen.length >= 2, 'checked once a key is saved');
});

test('S6 packing list: from trip length and the forecast, as a shared list, made once', async (t) => {
  const r = rig(t, { boards: true });
  await denverTrip(r);
  const den = r.travel.trips()[0]!;
  const p = await r.travel.packingList(den.id);
  assert.equal(p.name, 'Packing: Trip to Denver');
  assert.match(r.weather[0]!, /^Denver\|2026-11-20\|2026-11-23/);
  const items = p.items.join('\n');
  for (const want of [/Underwear and socks \(4\)/, /Warm jacket/, /Hat and gloves/, /Umbrella or rain jacket/, /Waterproof boots/, /Driver’s license/, /Event tickets/, /Phone charger/]) assert.match(items, want);
  assert.doesNotMatch(items, /Passport/, 'a domestic trip');
  const board = r.boards!.view('owner', p.boardId!)!;
  assert.equal(board.cards.length, p.items.length);
  const again = await r.travel.packingList(den.id);
  assert.equal(again.boardId, p.boardId);
  assert.equal(r.boards!.boardsFor('owner').length, 1);
});

test('S6 add to calendar: only on the person’s tap, once per booking, through calendar_add', async (t) => {
  const r = rig(t, { calendar: true });
  await denverTrip(r);
  assert.equal(r.calendar.length, 0, 'nothing on its own');
  const den = r.travel.trips()[0]!;
  const a = await r.travel.addToCalendar(den.id);
  assert.equal(a.added, 5);
  assert.deepEqual(r.calendar.map((c) => c.title), ['Flight SK1452 ORD → DEN', 'Car: Peak Car Rental', 'Stay: Mile High Inn', 'Evening concert at Foothills Amphitheater', 'Flight PJ88 DEN → ORD']);
  assert.equal(r.calendar[0]!.start, '2026-11-20T08:05');
  const b = await r.travel.addToCalendar(den.id);
  assert.equal(b.added, 0);
  assert.equal(r.calendar.length, 5);
});

test('S6 tools: trip_list and trip_status read (interruptible), lean family travel', async (t) => {
  const r = rig(t);
  await denverTrip(r);
  const tools = new Map(createTravelTools(() => r.app).map((x) => [x.spec.name, x]));
  assert.deepEqual([...tools.keys()], ['trip_list', 'trip_status']);
  for (const x of tools.values()) {
    assert.equal(x.defaultPermission, 'auto');
    assert.equal(x.interruptible, true);
    assert.equal(familyOf(x).id, 'travel');
  }
  const ctx = { workspaceDir: r.dir, signal: AbortSignal.timeout(5000) } as never;
  const list = await tools.get('trip_list')!.run({}, ctx);
  assert.match(list, /Trip #1 “Trip to Denver”.*Nov 20.*Nov 23/);
  assert.match(list, /Trip #2 “Trip to Minneapolis”/);
  r.fake.statuses.set('SK1452', { state: 'scheduled', depGate: 'B7' });
  r.clock.now = new Date('2026-11-19T20:00:00Z');
  const st = await tools.get('trip_status')!.run({ id: '1' }, ctx);
  assert.match(st, /SK1452 ORD → DEN · Fri, Nov 20, 8:05 AM CST/);
  assert.match(st, /confirmation QX7P2L/);
  assert.match(st, /gate B7/);
  // U1.1 real-model run: without the airline's name the model guessed one ("Lufthansa SK1452").
  assert.match(st, /- flight \(Skyway Air\): SK1452/);
  assert.ok(FAMILY_WORDS.travel?.includes('flight'));
});

test('S6 household: a member’s trips are their own; private chats are never read; routes are member routes', async (t) => {
  const owner = rig(t);
  await denverTrip(owner);
  const member = rig(t);
  assert.equal(member.travel.trips().length, 0);
  assert.equal(owner.travel.trips().length, 2);
  assert.ok(MEMBER_ROUTES.has('trips'));
  // The travel chat is its own (never a private chat).
  const conv = owner.app.store.getConversation(owner.travel.conversationId())!;
  assert.equal(Boolean((conv as { private?: boolean }).private), false);
});

test('S6 Today tile: the next trip with what comes next; the inbox tile stops listing trips', async (t) => {
  const r = rig(t);
  await denverTrip(r);
  const tile = r.travel.todayTile()!;
  assert.equal(tile.trips[0]!.title, 'Trip to Denver');
  assert.equal(tile.trips[0]!.next[0]!.title, 'SK1452 ORD → DEN');
  assert.deepEqual(r.inbox.todayTile()?.trips ?? [], []);
});

test('S6 wiring and strings', () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  assert.match(read('src', 'main.ts'), /new Travel\(app, store\.db\)/);
  assert.match(read('src', 'reminders.ts'), /this\.#app\.travel\?\.due\(now\)/);
  assert.match(read('src', 'inbox', 'helper.ts'), /this\.#app\.travel\?\.observe\(/);
  const html = read('web', 'index.html');
  assert.match(html, /<dialog id="trips"/);
  assert.match(html, /id="td-trips"/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const j = read('web', 'i18n', `${lang}.json`);
    for (const k of ['Trips', 'Add to calendar', 'Packing list', 'Check-in is open for {flight} ({when}). {link}']) assert.ok(j.includes(`"${k}":`), `${lang}: ${k}`);
  }
});

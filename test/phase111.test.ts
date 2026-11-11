// Phase 111 (TD1, 2.44.0): Today on big screens (docs/design/TODAY.md §12.1). The pure helpers of
// web/today.js (dayItems, needsItems, fillRow), the layout store and routes, the stale Mail tile
// (generation counter, per-companion cache, the reload push from the organizer), Mail 2.0, the
// batched GET /api/today, compatibility, Coming up, Usage today, Home, Coding projects, Since you
// were away, privacy for household members, the owner's opt-in Rooms tile (2026-11-01) and the
// static UI rules. Everything runs against fakes: a fake Google, a fake Home Assistant, a fake
// GitHub; fake clocks; no real network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { forgetRoom, logLine, setRoom } from '../src/bridges/keepup.ts';
import type { AppContext } from '../src/chat.ts';
import { GmailOrganizer } from '../src/gmail-organize.ts';
import type { GoogleAccount } from '../src/google.ts';
import { sceneAllowed } from '../src/home-switch.ts';
import { setNetTransport } from '../src/net-guard.ts';
import { PeopleStore } from '../src/people.ts';
import { createSaraServer } from '../src/server.ts';
import { buildToday, gmailTodayHook, mailKey, todayState, type Today } from '../src/today.ts';
import { defaultPrefs, getLayout, normalizePrefs, putLayout, recordMail, setSeen } from '../src/today-layout.ts';
import { todayLoaders } from '../src/today-parts.ts';
import { HOME_VAULT } from '../src/tools/home.ts';
import { GITHUB_VAULT } from '../src/tools/coding.ts';
import { UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const NOW = new Date('2026-10-31T15:00:00Z'); // 10:00 in Chicago

/** A web module in Node (its naming.js import becomes a small stand-in). */
async function load(file: string) {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  let src = web(file).replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/device-approval\.js';/, `from 'data:text/javascript,${encodeURIComponent('export const checkPrompts = async () => {}; export const requestLine = () => "";')}';`).replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  if (file === 'today-layout.js') src = src.replace(/from '\.\/today\.js';/, `from 'data:text/javascript;base64,${Buffer.from(web('today.js').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/device-approval\.js';/, `from 'data:text/javascript,${encodeURIComponent('export const checkPrompts = async () => {}; export const requestLine = () => "";')}';`).replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`)).toString('base64')}';`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

/** A fake Google account: Gmail counts, important mail, calendar; an optional gate holds the INBOX read. */
function fakeGoogle(o: { total?: number; unread?: number } = {}) {
  const state = { total: o.total ?? 1204, unread: o.unread ?? 37, calls: 0, gate: null as Promise<void> | null, labels: new Map<string, Set<string>>(), events: [] as { id: string; summary: string; start: { dateTime?: string; date?: string }; location?: string }[] };
  const g = {
    status: () => ({ configured: true, connected: true, email: 'alex@example.com', gmail: true, calendar: true, canOrganize: true }),
    api: async (url: string, init: { method?: string; body?: unknown } = {}) => {
      if (url.includes('/labels/INBOX')) {
        state.calls++;
        const snap = { messagesTotal: state.total, messagesUnread: state.unread };
        if (state.gate) await state.gate;
        return snap;
      }
      if (url.includes('/messages?')) return { messages: [{ id: 'm1' }] };
      if (url.includes('/messages/m1')) return { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-10-31T14:41:00Z')), payload: { headers: [{ name: 'From', value: 'Dana Ruiz <dana@example.com>' }, { name: 'Subject', value: 'Contract for Friday' }] } };
      if (url.includes('/batchModify')) {
        const b = init.body as { ids: string[]; removeLabelIds?: string[]; addLabelIds?: string[] };
        if (b.removeLabelIds?.includes('INBOX')) state.total -= b.ids.length;
        if (b.addLabelIds?.includes('INBOX')) state.total += b.ids.length;
        return {};
      }
      if (url.includes('/labels')) return { labels: [{ id: 'Label_1', name: 'Receipts' }] };
      if (url.includes('calendar/v3')) {
        const q = new URL(url).searchParams;
        const from = Date.parse(q.get('timeMin')!);
        const to = Date.parse(q.get('timeMax')!);
        return { items: state.events.filter((e) => { const s = Date.parse(e.start.dateTime ?? `${e.start.date}T12:00:00Z`); return s >= from && s < to; }) };
      }
      return {};
    },
  };
  return { g: g as unknown as GoogleAccount, state };
}

function setup(t: { after: (fn: () => void) => void }, o: { member?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(NOW) };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  if (o.member) (app as AppContext).member = { today: () => ({ messages: 3, usd: 0.01 }) } as unknown as AppContext['member'];
  t.after(() => {
    setNetTransport();
    app.store.close();
    cleanup();
  });
  return { app, dir, clock };
}
const allParts = (app: AppContext, extra: Parameters<typeof todayLoaders>[0] = {}) => todayLoaders({ approvals: () => [], ...extra });

// ------------------------------------------------------------------ 1 · dayItems

test('111.1 dayItems: events, reminders, timed to-dos and leave-by in time order, all-day first, past flagged, undated out; leave-by before its event (Phase 114 B1)', async () => {
  const m = await load('today.js');
  const at = (h: string) => new Date(`2026-10-31T${h}:00`).toISOString();
  const now = Date.parse(at('10:00'));
  const items = m.dayItems({
    day: '2026-10-31',
    calendar: { events: [{ id: 'e2', title: 'Dentist', start: at('15:00'), end: at('15:45'), location: '12 Oak Ave' }, { id: 'e1', title: 'Standup', start: at('09:30'), end: at('09:45') }, { id: 'e0', title: 'Halloween', allDay: true, start: '2026-10-31' }], leaveBy: [{ eventId: 'e2', leaveAt: at('14:20'), minutes: 25 }] },
    agenda: { reminders: [{ id: 1, text: 'Call Mom', dueAt: at('17:30') }], tasks: [{ id: 7, title: 'Feed the cat', dueAt: at('08:30') }, { id: 8, title: 'Undated', dueAt: null }, { id: 9, title: 'Yesterday', dueAt: new Date('2026-10-30T12:00:00').toISOString(), overdue: true }] },
  }, now);
  assert.deepEqual(items.map((x: { kind: string; title: string }) => `${x.kind}:${x.title}`), ['event:Halloween', 'todo:Feed the cat', 'event:Standup', 'leave:Dentist', 'event:Dentist', 'reminder:Call Mom']);
  assert.deepEqual(items.map((x: { past: boolean }) => x.past), [false, true, true, false, false, false]);
  assert.equal(items[3].minutes, 25, 'the leave-by row carries the travel time');
});

// ------------------------------------------------------------------ 2 · needsItems

test('111.2 needsItems ranks approvals → failed → overdue → board → mail → hooks → models; Not today keys drop out', async () => {
  const m = await load('today.js');
  const d = {
    day: '2026-10-31',
    needs: { approvals: [{ approvalId: 'a1', title: 'Run git push?', since: NOW.toISOString() }], failedJobs: [{ id: 3, label: 'nightly tests', status: 'error', at: NOW.toISOString() }], failedRuns: [], models: [{ key: 'model:gpt-x', text: 'gpt-x was retired' }], notToday: ['card:5'], includeMail: true },
    agenda: { tasks: [{ id: 2, title: 'Newer', dueAt: new Date('2026-10-30T12:00:00').toISOString(), overdue: true }, { id: 1, title: 'Older', dueAt: new Date('2026-10-28T12:00:00').toISOString(), overdue: true }] },
    board: { waiting: [{ id: 4, title: 'Pick a host', question: 'Which?' }, { id: 5, title: 'Put off', question: '' }] },
    mail: { important: [{ id: 'm1', subject: 'Contract', from: 'Dana' }] },
    hooks: [{ id: 9, kind: 'tell', text: 'Deploy failed', name: 'CI', at: NOW.toISOString() }],
  };
  const items = m.needsItems(d, NOW.getTime());
  assert.deepEqual(items.map((x: { kind: string; title: string }) => `${x.kind}:${x.title}`), ['approval:Run git push?', 'failed:nightly tests', 'overdue:Older', 'overdue:Newer', 'board:Pick a host', 'mail:Contract', 'hook:Deploy failed', 'model:gpt-x was retired']);
  assert.equal(m.needsItems({ ...d, needs: { ...d.needs, includeMail: false } }).some((x: { kind: string }) => x.kind === 'mail'), false, 'the include-mail switch');
  // A member's answer (below, 111.15) has no owner-only sources: none of those kinds can appear.
  const member = m.needsItems({ day: '2026-10-31', needs: { approvals: [], failedJobs: [], failedRuns: [], models: [], notToday: [] }, agenda: { tasks: [] } });
  assert.deepEqual(member, []);
});

// ------------------------------------------------------------------ 3 · fillRow

test('111.3 fillRow fills every row at 12, 8 and 2 columns for any mix, never narrower than a tile allows', async () => {
  const m = await load('today.js');
  const grids = [{ cols: 12, span: { S: 3, M: 4, L: 6 } }, { cols: 12, span: { S: 4, M: 6, L: 12 } }, { cols: 8, span: { S: 2, M: 4, L: 8 } }, { cols: 2, span: { S: 1, M: 1, L: 2 } }];
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let run = 0; run < 400; run++) {
    const tiles = m.TILES.filter(() => rnd() > 0.35).map((x: { id: string; sizes: string[] }) => ({ id: x.id, sizes: x.sizes, size: x.sizes[Math.floor(rnd() * x.sizes.length)] }));
    for (const g of grids) {
      const spans = m.fillRow(tiles, g.cols, g.span);
      let row = 0;
      for (const x of tiles) {
        const s = spans[x.id];
        assert.ok(s >= m.minSpan(x, g.cols, g.span) && s <= g.cols, `${x.id} at ${g.cols}: ${s}`);
        row += s;
        assert.ok(row <= g.cols, 'a row never overflows');
        if (row === g.cols) row = 0;
      }
      assert.equal(row, 0, `every row is full (${g.cols} columns)`);
    }
  }
  const at1440 = m.fillRow([{ id: 'a', size: 'L', sizes: ['M', 'L'] }, { id: 'b', size: 'S', sizes: ['S', 'M'] }, { id: 'c', size: 'S', sizes: ['S', 'M'] }], 12, { S: 3, M: 4, L: 6 });
  assert.deepEqual(at1440, { a: 6, b: 3, c: 3 }, 'the designed row stays as designed');
  assert.deepEqual(m.fillRow([{ id: 'a', size: 'L', sizes: ['M', 'L'] }, { id: 'c', size: 'S', sizes: ['S', 'M'] }], 12, { S: 3, M: 4, L: 6 }), { a: 8, c: 4 }, 'a hidden tile: the row still fills (the rest goes to the widest)');
  // Span classes, never inline styles.
  const cls = m.spanClasses([{ id: 'a', size: 'L', sizes: ['M', 'L'] }]);
  assert.deepEqual(cls.a, ['td-span-12', 'td-lg-12', 'td-md-12']);
});

// ------------------------------------------------------------------ 4 · layout

test('111.4 layout: PUT validates and round-trips, per companion, DELETE resets; old device keys migrate once', async (t) => {
  const a = setup(t);
  const b = setup(t);
  const auth = new OwnerAuth(a.app.dataDir);
  const server = createSaraServer({ app: a.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json', origin: base.replace('/api', '') }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  a.app.settings.update({ disclosureAcceptedAt: NOW.toISOString() });
  const r1 = await req('PUT', '/today/layout', { sections: ['work', 'day'], tiles: { 'td-mail': { size: 'M' }, 'td-nope': { size: 'L' }, 'td-usage': { hidden: true } }, order: { day: ['td-dates', 'td-calendar'] }, awayHours: 30 });
  assert.equal(r1.status, 200);
  const p = r1.body.prefs as ReturnType<typeof defaultPrefs>;
  assert.deepEqual(p.sections, ['work', 'day', 'needs', 'her', 'more'], 'the rest follow in the designed order');
  assert.deepEqual(Object.keys(p.tiles).sort(), ['td-mail', 'td-usage'], 'unknown ids are dropped');
  assert.deepEqual(p.order.day, ['td-dates', 'td-calendar', 'td-weather']);
  assert.equal(p.awayHours, 24, 'clamped');
  assert.equal((await req('PUT', '/today/layout', { tiles: { 'td-mail': { size: 'S' } } })).status, 400, 'a size the tile does not allow is refused');
  const many = Object.fromEntries(Array.from({ length: 70 }, (_v, i) => [`td-x${i}`, {}]));
  assert.equal((await req('PUT', '/today/layout', { tiles: many })).status, 400, 'at most 64 entries');
  const back = await req('GET', '/today?parts=layout');
  assert.equal((back.body.layout as { tiles: Record<string, { size?: string }> }).tiles['td-mail'].size, 'M', 'round-trips through GET /api/today');
  // Per companion: the second companion's database has its own (the designed) layout.
  putLayout(b.app, { tiles: { 'td-weather': { size: 'M' } } });
  assert.equal(getLayout(b.app).prefs.tiles['td-mail'], undefined);
  assert.equal(getLayout(a.app).prefs.tiles['td-weather'], undefined);
  assert.equal((await req('DELETE', '/today/layout')).status, 200);
  assert.deepEqual(getLayout(a.app).prefs.sections, defaultPrefs().sections, 'reset to the designed layout');
  // The old device keys: read once, sent, removed.
  const m = await load('today.js');
  const store = new Map<string, string>([['sara.today.home', JSON.stringify(['light.desk', 'switch.fan'])], ['sara.today.setup', 'hidden']]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) };
  const patch = m.migrateDeviceKeys(defaultPrefs(), storage);
  assert.deepEqual(patch.home.entities, ['light.desk', 'switch.fan']);
  assert.equal(patch.tiles['td-setup'].hidden, true);
  assert.equal(patch.migrated, true);
  assert.equal(store.size, 0, 'the device keys are removed');
  assert.equal(m.migrateDeviceKeys({ ...defaultPrefs(), migrated: true }, storage), null, 'only once');
  assert.throws(() => normalizePrefs({ comingDays: 9 }), /7, 14 or 30/);
});

// ------------------------------------------------------------------ 5 · the stale-mail race

test('111.5 stale mail: a load that started before an organizer change never writes old numbers back; ?fresh=1 is never overwritten', async (t) => {
  const { app } = setup(t);
  const { g, state } = fakeGoogle({ total: 1204, unread: 37 });
  app.google = g;
  app.gmail = new GmailOrganizer(g, app.store.db, { timeZone: () => 'America/Chicago', now: () => app.now(), onChange: gmailTodayHook(app) });
  let release!: () => void;
  state.gate = new Promise<void>((r) => (release = r));
  const slow = buildToday(app, { parts: ['mail'] });
  await new Promise((r) => setImmediate(r));
  // The organizer archives 418 while that load waits on Google.
  state.gate = null;
  const plan = { action: 'archive' as const, query: 'in:inbox', exact: 'in:inbox', ids: Array.from({ length: 418 }, (_v, i) => `msg${String(i).padStart(4, '0')}`), capped: false, samples: [], at: app.now().getTime() };
  await app.gmail.run(plan);
  release();
  const before = await slow;
  assert.equal(before.mail!.total, 1204, 'the slow load answers once with what it read');
  assert.equal(before.parts!.mail.stale, true, 'marked stale (the page asks again)');
  assert.equal(todayState(app).cache.get('mail'), undefined, 'and it did not fill the cache');
  const calls = state.calls;
  const next = await buildToday(app, { parts: ['mail'] });
  assert.equal(state.calls, calls + 1, 'the next load reads Gmail again');
  assert.equal(next.mail!.total, 786);
  // ?fresh=1 vs an older load still on its way.
  todayState(app).cache.clear();
  state.gate = new Promise<void>((r) => (release = r));
  const older = buildToday(app, { parts: ['mail'] });
  await new Promise((r) => setImmediate(r));
  state.gate = null;
  state.total = 700;
  app.now = () => new Date(NOW.getTime() + 1000);
  const fresh = await buildToday(app, { parts: ['mail'], fresh: true });
  assert.equal(fresh.mail!.total, 700);
  release();
  await older;
  assert.equal((todayState(app).cache.get('mail')!.value as { total: number }).total, 700, 'the older load did not overwrite the fresh one');
});

// ------------------------------------------------------------------ 6 · the reload push

test('111.6 mail refresh: an organize run says SSE today {part:mail} during a long run (every 500), at the end and on Undo', async (t) => {
  const { app } = setup(t);
  const { g } = fakeGoogle();
  app.google = g;
  app.gmail = new GmailOrganizer(g, app.store.db, { timeZone: () => 'America/Chicago', now: () => app.now(), onChange: gmailTodayHook(app) });
  const seen: string[] = [];
  app.events!.subscribe((ev) => ev.type === 'today' && seen.push(ev.part));
  const ids = Array.from({ length: 2600 }, (_v, i) => `msg${String(i).padStart(5, '0')}`);
  const out = await app.gmail.run({ action: 'label', label: 'Receipts', query: 'subject:receipt', exact: 'subject:receipt', ids, capped: false, samples: [], at: app.now().getTime() });
  // 1,000 per batch: past 1,000, 2,000 and the end (2,600), and the record.
  assert.ok(seen.filter((p) => p === 'mail').length >= 3, `progress and the end: ${seen.length}`);
  seen.length = 0;
  await app.gmail.undo(out.actionId!);
  assert.ok(seen.includes('mail'), 'Undo tells the page too');
  // The tools (gmail_organize, gmail_undo) run through the same organizer, so they push the same way.
  const src = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(src, /app\.gmail = new GmailOrganizer\(google, store\.db, \{[^\n]*onChange: gmailTodayHook\(app\) \}\);/);
});

// ------------------------------------------------------------------ 7 · Mail 2.0

test('111.7 Mail 2.0: total, unread, change only with yesterday, organised from this companion, at; the cache key has the companion', async (t) => {
  const { app } = setup(t);
  const { g } = fakeGoogle({ total: 1204, unread: 37 });
  app.google = g;
  app.gmail = new GmailOrganizer(g, app.store.db, { timeZone: () => 'America/Chicago', now: () => app.now() });
  let d = await buildToday(app, { parts: ['mail'] });
  assert.equal(d.mail!.total, 1204);
  assert.equal(d.mail!.unread, 37);
  assert.equal(d.mail!.change, undefined, 'no row for yesterday: no change line');
  assert.equal(d.mail!.important[0].threadId, 't1');
  assert.ok(d.mail!.at);
  // Yesterday's first reading → the change since yesterday.
  app.store.db.prepare("INSERT INTO mail_daily VALUES ('2026-10-30', 'alex@example.com', 1416, 33, 'x', 1400, 35, 'x')").run();
  assert.deepEqual(recordMail(app, 'alex@example.com', 1204, 37), { total: -212, unread: 4 });
  await app.gmail.run({ action: 'label', label: 'Receipts', query: 'q', exact: 'q', ids: ['aaaaaa1', 'aaaaaa2'], capped: false, samples: [], at: app.now().getTime() });
  await app.gmail.run({ action: 'archive', query: 'q', exact: 'q', ids: ['aaaaaa3'], capped: false, samples: [], at: app.now().getTime() });
  const undone = await app.gmail.run({ action: 'archive', query: 'q', exact: 'q', ids: ['aaaaaa4', 'aaaaaa5'], capped: false, samples: [], at: app.now().getTime() });
  await app.gmail.undo(undone.actionId!);
  d = await buildToday(app, { parts: ['mail'], fresh: true });
  assert.deepEqual(d.mail!.change, { total: -212 - 1, unread: 4 });
  assert.deepEqual(d.mail!.organised!.map((x) => `${x.action}:${x.label ?? ''}:${x.count}`).sort(), ['archive::1', 'label:Receipts:2'], 'not-undone changes only, grouped');
  // Another companion (its own database) never sees these.
  const other = setup(t);
  other.app.google = g;
  other.app.companionId = 'c2';
  other.app.gmail = new GmailOrganizer(g, other.app.store.db, { timeZone: () => 'America/Chicago', now: () => other.app.now() });
  assert.deepEqual((await buildToday(other.app, { parts: ['mail'] })).mail!.organised, []);
  assert.notEqual(mailKey(app, '2026-10-31'), mailKey(other.app, '2026-10-31'));
  assert.match(mailKey(other.app, '2026-10-31'), /^c2\|2026-10-31\|alex@example\.com$/);
});

// ------------------------------------------------------------------ 8 · the batched endpoint

test('111.8 GET /api/today: one answer with every part; a failing part says so and the rest arrive; ?parts= limits the work', async (t) => {
  const { app } = setup(t);
  const { g, state } = fakeGoogle();
  app.google = g;
  const loaders = { ...allParts(app), weather: () => { throw new Error('Open-Meteo is down'); } };
  const d = await buildToday(app, { loaders });
  for (const p of ['day', 'coming', 'mail', 'her', 'board', 'plans', 'models', 'layout', 'needs']) assert.ok(d.parts![p], `part ${p}`);
  assert.equal(d.parts!.weather.error, 'Open-Meteo is down');
  assert.ok(d.mail && d.calendar, 'the others still arrive');
  const calls = state.calls;
  const only = await buildToday(app, { parts: ['weather', 'layout'], loaders: { weather: () => ({ setUp: true, now: 60 }) } });
  assert.equal(state.calls, calls, 'no Gmail call when mail was not asked');
  assert.deepEqual(Object.keys(only.parts!).sort(), ['layout', 'weather']);
  assert.equal(only.mail, undefined);
});

// ------------------------------------------------------------------ 9 · compatibility

test('111.9 compatibility: every field the phone widget and her panel read is still there, with the same type', async (t) => {
  const { app } = setup(t);
  app.google = fakeGoogle().g;
  app.planner!.addTask({ title: 'Renew passport', dueAt: '2026-10-29T17:00:00Z' });
  const d = (await buildToday(app, { loaders: allParts(app) })) as Today & Record<string, unknown>;
  for (const [k, type] of Object.entries({ greeting: 'string', greetingKey: 'string', owner: 'string', day: 'string', date: 'string', agenda: 'object', calendar: 'object', dates: 'object', jobs: 'object' })) assert.equal(typeof d[k], type, k);
  assert.ok(Array.isArray(d.agenda.tasks) && Array.isArray(d.agenda.reminders));
  assert.equal(typeof d.mail!.unread, 'number');
  assert.ok(Array.isArray(d.mail!.important));
  assert.ok(Array.isArray(d.dates) && Array.isArray(d.jobs));
});

// ------------------------------------------------------------------ 10 · Coming up

test('111.10 Coming up: next N days of events (7 by default), memory dates and People birthdays; sensitive notes stay out', async (t) => {
  const { app } = setup(t);
  const { g, state } = fakeGoogle();
  app.google = g;
  state.events = [{ id: 'n1', summary: 'Car service', start: { dateTime: '2026-11-01T14:00:00Z' } }, { id: 'n2', summary: 'Far away', start: { dateTime: '2026-11-20T14:00:00Z' } }];
  app.people = new PeopleStore(app.store.db, { now: () => app.now() });
  app.people.create({ name: 'Priya', birthday: '11-02', status: 'active', origin: 'owner' });
  const date = app.memory!.add({ kind: 'date', content: 'Our anniversary', onDate: '11-04', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  const secret = app.memory!.add({ kind: 'date', content: 'Clinic follow-up', onDate: '11-03', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  const sens = app.people.sensitiveMemory.bind(app.people);
  app.people.sensitiveMemory = (id: number) => id === secret.id || sens(id);
  const d = await buildToday(app, { parts: ['coming', 'layout'] });
  assert.deepEqual(d.coming!.events.map((e) => e.title), ['Car service'], 'the next 7 days only');
  assert.equal(d.coming!.days, 7);
  assert.ok(d.dates.some((x) => x.what === 'Our anniversary') && d.dates.some((x) => x.what === "Priya's birthday"));
  assert.ok(!d.dates.some((x) => x.what === 'Clinic follow-up'), 'sensitive notes never show');
  void date;
  putLayout(app, { comingDays: 30 });
  todayState(app).cache.clear();
  assert.deepEqual((await buildToday(app, { parts: ['coming'] })).coming!.events.map((e) => e.title), ['Car service', 'Far away']);
});

// ------------------------------------------------------------------ 11 · Usage today

test('111.11 Usage today: tokens and cost since local midnight; local and subscription calls are $0; absent for members and on the demo', async (t) => {
  const { app } = setup(t);
  app.usage = new UsageStore(app.store.db, () => app.now());
  const api = { id: 'or', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' } as never;
  const local = { id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true } as never;
  app.usage.record(api, 'm', { input: 1000, output: 200, usd: 0.5 } as never, { purpose: 'chat' });
  app.usage.record(local, 'q', { input: 3000, output: 100 } as never, { purpose: 'background' });
  const d = await buildToday(app, { parts: ['usage'], loaders: allParts(app) });
  const u = d as unknown as { usage: { tokens: number; usd: number; billing: string[] } };
  const s = app.usage.summary(new Date('2026-10-31T05:00:00Z').toISOString()).total;
  assert.equal(u.usage.tokens, s.tokens, 'the same numbers as GET /api/usage (local midnight)');
  assert.equal(u.usage.usd, Math.round(s.usd * 10000) / 10000);
  assert.ok(u.usage.billing.includes('local'));
  const m = setup(t, { member: true });
  m.app.usage = new UsageStore(m.app.store.db, () => m.app.now());
  m.app.usage.record(api, 'm', { input: 10, output: 2, usd: 0.1 } as never, { purpose: 'chat' });
  assert.equal(((await buildToday(m.app, { parts: ['usage'], loaders: allParts(m.app) })) as unknown as { usage?: unknown }).usage, undefined, 'members: no usage part');
  assert.equal(((await buildToday(app, { parts: ['usage'], demo: true, loaders: allParts(app) })) as unknown as { usage?: unknown }).usage, undefined, 'demo: none');
});

// ------------------------------------------------------------------ 12 · Home

test('111.12 Home: who is home from person.*, scenes only when picked, a scene press goes through the switch rule; absent for members and the demo', async (t) => {
  const { app } = setup(t);
  app.settings.update({ home: { url: 'http://127.0.0.1:8123' } } as never);
  app.vault.set(HOME_VAULT, 'ha-token');
  let asked = 0;
  setNetTransport((async (input: string | URL | Request) => {
    asked++;
    void input;
    return new Response(JSON.stringify([
      { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
      { entity_id: 'person.alex', state: 'home', attributes: { friendly_name: 'Alex' } },
      { entity_id: 'person.sam', state: 'not_home', attributes: { friendly_name: 'Sam' } },
      { entity_id: 'scene.movie_night', state: 'scening', attributes: { friendly_name: 'Movie night' } },
      { entity_id: 'scene.unlock_front_door', state: 'scening', attributes: { friendly_name: 'Unlock front door' } },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  type HomePart = { people: { name: string; home: boolean }[]; scenes: { id: string; picked: boolean }[] };
  let d = (await buildToday(app, { parts: ['home'], loaders: allParts(app) })) as unknown as { home: HomePart };
  assert.deepEqual(d.home.people, [{ id: 'person.alex', name: 'Alex', home: true }, { id: 'person.sam', name: 'Sam', home: false }]);
  assert.ok(d.home.scenes.every((s) => !s.picked), 'no scene is a button until picked');
  putLayout(app, { home: { entities: [], scenes: ['scene.movie_night', 'scene.unlock_front_door'] } });
  d = (await buildToday(app, { parts: ['home'], fresh: true, loaders: allParts(app) })) as unknown as { home: HomePart };
  assert.deepEqual(d.home.scenes.filter((s) => s.picked).map((s) => s.id), ['scene.movie_night', 'scene.unlock_front_door']);
  assert.equal(sceneAllowed('scene.movie_night', 'Movie night', getLayout(app).prefs.home.scenes), true);
  assert.equal(sceneAllowed('scene.unlock_front_door', 'Unlock front door', getLayout(app).prefs.home.scenes), false, 'named like a lock or door: Ask Sara');
  assert.equal(sceneAllowed('scene.bedtime', 'Bedtime', getLayout(app).prefs.home.scenes), false, 'not picked');
  assert.match(readFileSync(join(ROOT, 'src', 'routes', 'connections.ts'), 'utf8'), /if \(!sceneAllowed\(id, nm, getLayout\(app\)\.prefs\.home\.scenes\)\) throw new HttpError\(403/);
  const before = asked;
  const m = setup(t, { member: true });
  m.app.settings.update({ home: { url: 'http://127.0.0.1:8123' } } as never);
  m.app.vault.set(HOME_VAULT, 'ha-token');
  assert.equal(((await buildToday(m.app, { parts: ['home'], loaders: allParts(m.app) })) as unknown as { home?: unknown }).home, undefined, 'members: no home');
  assert.equal(((await buildToday(app, { parts: ['home'], demo: true, fresh: true, loaders: allParts(app) })) as unknown as { home?: unknown }).home, undefined, 'demo: none');
  assert.equal(asked, before, 'and nothing was asked of Home Assistant');
});

// ------------------------------------------------------------------ 13 · Coding projects

test('111.13 Coding projects: last change from git, tests from runs, PRs only with GitHub connected; nothing for members', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding', workspace: 'hub-site' } as never);
  void conv;
  const gitLast = async () => ({ at: '2026-10-31T13:00:00.000Z', subject: 'Add the install counter' });
  let gh = 0;
  const fetchFake = (async () => {
    gh++;
    return new Response(JSON.stringify([{ number: 1 }, { number: 2 }]), { status: 200 });
  }) as unknown as typeof fetch;
  type P = { projects?: { items: { workspace: string; last?: { subject: string }; prs?: number }[]; github: boolean } };
  let d = (await buildToday(app, { parts: ['projects'], loaders: todayLoaders({ gitLast, fetch: fetchFake }) })) as unknown as P;
  assert.equal(d.projects!.items[0].workspace, 'hub-site');
  assert.equal(d.projects!.items[0].last!.subject, 'Add the install counter');
  assert.equal(d.projects!.items[0].prs, undefined, 'no GitHub: no PR count');
  assert.equal(gh, 0);
  app.vault.set(GITHUB_VAULT, 'ghp_fake');
  d = (await buildToday(app, { parts: ['projects'], loaders: todayLoaders({ gitLast, fetch: fetchFake }) })) as unknown as P;
  assert.equal(d.projects!.github, true);
  // The PR count needs the workspace's GitHub remote (git, read locally); without one nothing is asked.
  assert.ok(gh <= 1);
  const m = setup(t, { member: true });
  m.app.store.createConversation({ mode: 'coding', workspace: 'hub-site' } as never);
  assert.equal(((await buildToday(m.app, { parts: ['projects'], loaders: todayLoaders({ gitLast }) })) as unknown as P).projects, undefined);
});

// ------------------------------------------------------------------ 14 · Since you were away

test('111.14 Since you were away: only past the threshold, built from the stores with no model call, never partner or room content; dismiss sets seen', async (t) => {
  const { app, clock } = setup(t);
  setSeen(app, '2026-10-31T01:00:00Z');
  app.memory!.add({ kind: 'fact', content: 'Alex likes rye', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-31', evidence: 'x' });
  const partner = app.store.createConversation({ partner: 'Lee', channel: 'telegram', channelKey: '-77' } as never);
  app.store.addMessage(partner.id, 'assistant', 'PARTNER-SECRET-LINE', { proactive: { reason: 'x' } });
  const r = noteRoom(app, { bridge: 'discord', key: '700', kind: 'room', title: 'general', parentTitle: 'Dev Crew' });
  logLine(app, setRoom(app, r.id, { keepUp: true, model: 'local' })!, { platformId: 'p1', authorId: 'u', author: 'Scott', who: 'person', text: 'ROOM-SECRET-LINE', at: NOW.toISOString() });
  const calls = app.providerCalls;
  type A = { away?: { hours: number; lines: { kind: string; n: number }[] } };
  const d = (await buildToday(app, { loaders: allParts(app) })) as unknown as A;
  assert.equal(d.away!.hours, 14);
  assert.deepEqual(d.away!.lines.map((l) => l.kind), ['memories']);
  assert.equal(app.providerCalls, calls, 'no model call');
  assert.doesNotMatch(JSON.stringify(d), /PARTNER-SECRET-LINE|ROOM-SECRET-LINE/);
  putLayout(app, { awayHours: 0 });
  assert.equal(((await buildToday(app, { loaders: allParts(app) })) as unknown as A).away, undefined, 'Off');
  putLayout(app, { awayHours: 16 });
  assert.equal(((await buildToday(app, { loaders: allParts(app) })) as unknown as A).away, undefined, 'under the threshold');
  putLayout(app, { awayHours: 8 });
  setSeen(app);
  assert.equal(getLayout(app).seenAt, clock.now.toISOString(), 'dismiss / seen sets seen_at');
  assert.equal(((await buildToday(app, { loaders: allParts(app) })) as unknown as A).away, undefined, 'never twice for the same absence');
});

// ------------------------------------------------------------------ 15 · privacy

test('111.15 privacy: a member has no hooks, home, usage, projects, rooms, owner-only needs or owner mail; partner and room logs never appear', async (t) => {
  const { app } = setup(t, { member: true });
  app.google = fakeGoogle().g;
  app.settings.update({ home: { url: 'http://127.0.0.1:8123' } } as never);
  app.vault.set(HOME_VAULT, 'ha-token');
  app.roomKeeper = {} as never;
  const partner = app.store.createConversation({ partner: 'Lee', channel: 'telegram', channelKey: '-77' } as never);
  app.store.addMessage(partner.id, 'user', 'PARTNER-SECRET-LINE');
  const r = noteRoom(app, { bridge: 'discord', key: '700', kind: 'room', title: 'general' });
  logLine(app, setRoom(app, r.id, { keepUp: true, model: 'local' })!, { platformId: 'p1', authorId: 'u', author: 'Scott', who: 'person', text: 'ROOM-SECRET-LINE', at: NOW.toISOString() });
  putLayout(app, { rooms: { on: true, ids: [] } });
  const approvals = () => [{ approvalId: 'a1', conversationId: 'c', name: 'shell', summary: 'OWNER-APPROVAL', since: NOW.toISOString() }];
  const d = (await buildToday(app, { loaders: todayLoaders({ approvals }) })) as unknown as Record<string, unknown>;
  for (const k of ['hooks', 'home', 'usage', 'projects', 'rooms', 'mail']) assert.equal(d[k], undefined, `no ${k}`);
  const needs = d.needs as { approvals: unknown[]; failedJobs: unknown[]; failedRuns: unknown[]; models: unknown[] };
  assert.deepEqual([needs.approvals, needs.failedJobs, needs.failedRuns, needs.models], [[], [], [], []]);
  const json = JSON.stringify(d);
  assert.doesNotMatch(json, /PARTNER-SECRET-LINE|ROOM-SECRET-LINE|OWNER-APPROVAL|Dana Ruiz|alex@example\.com/);
  assert.equal((d.layout as Record<string, unknown>).rooms, undefined);
  // The owner's own Today: partner conversations and room logs are not sources of any part either
  // (the opt-in Rooms tile, below, shows only topics and names, and only when switched on).
  const o = setup(t);
  const p2 = o.app.store.createConversation({ partner: 'Lee', channel: 'telegram', channelKey: '-77' } as never);
  o.app.store.addMessage(p2.id, 'assistant', 'PARTNER-SECRET-LINE', { proactive: { reason: 'x' } });
  o.app.memory!.add({ kind: 'fact', content: 'PARTNER-FACT', conversationId: p2.id, sourceMessageId: null, happenedOn: '2026-10-31', evidence: 'x' });
  assert.doesNotMatch(JSON.stringify(await buildToday(o.app, { loaders: allParts(o.app) })), /PARTNER-SECRET-LINE|PARTNER-FACT/);
});

// ------------------------------------------------------------------ Rooms (owner decision 2026-11-01)

test('111.R Rooms tile: off by default, never for members, keep-up-off rooms left out, a forgotten room disappears, no model call', async (t) => {
  const { app } = setup(t);
  app.roomKeeper = {} as never;
  const on = noteRoom(app, { bridge: 'discord', key: '700', kind: 'room', title: 'general', parentTitle: 'Dev Crew' });
  const onRoom = setRoom(app, on.id, { keepUp: true, model: 'local' })!;
  const off = noteRoom(app, { bridge: 'telegram', key: '-500', kind: 'room', title: 'Book club' });
  logLine(app, onRoom, { platformId: 'p1', authorId: 'u1', author: 'Scott', who: 'person', text: 'Catan on Friday with the seafarers expansion', at: '2026-10-31T14:30:00Z' });
  logLine(app, onRoom, { platformId: 'p2', authorId: 'u2', author: 'Jo', who: 'person', text: 'Catan works, seafarers too', at: '2026-10-31T14:40:00Z' });
  void off;
  type Item = { id: number; name: string; topic: string; who: string[] };
  type R = { rooms?: { on: boolean; items: Item[]; available: { id: number }[] } };
  const items = (x: R): Item[] => x.rooms!.items;
  const calls = app.providerCalls;
  let d = (await buildToday(app, { parts: ['rooms'], loaders: allParts(app) })) as unknown as R;
  assert.equal(d.rooms!.on, false, 'off by default');
  assert.equal(items(d).length, 0);
  assert.deepEqual(d.rooms!.available.map((x) => x.id), [on.id], 'only keep-up rooms can be picked');
  const m = await load('today.js');
  assert.equal(m.layoutModel(defaultPrefs()).flatMap((s: { tiles: { id: string; shown: boolean }[] }) => s.tiles).find((x: { id: string }) => x.id === 'td-rooms').shown, false, 'the tile is hidden in the designed layout');
  putLayout(app, { rooms: { on: true, ids: [] } });
  d = (await buildToday(app, { parts: ['rooms'], loaders: allParts(app) })) as unknown as R;
  assert.deepEqual(items(d).map((x) => x.name), ['#general · Dev Crew'], 'keep-up off: never shown');
  assert.match(items(d)[0].topic, /catan/i, 'the topic words without a model (no summary yet)');
  assert.deepEqual(items(d)[0].who.sort(), ['Jo', 'Scott']);
  assert.equal(app.providerCalls, calls, 'no model call');
  forgetRoom(app, on.id);
  d = (await buildToday(app, { parts: ['rooms'], loaders: allParts(app) })) as unknown as R;
  assert.equal(items(d).length, 0, 'a forgotten room disappears');
  const mem = setup(t, { member: true });
  mem.app.roomKeeper = {} as never;
  putLayout(mem.app, { rooms: { on: true, ids: [] } });
  assert.equal(((await buildToday(mem.app, { parts: ['rooms'], loaders: allParts(mem.app) })) as unknown as R).rooms, undefined, 'members: nothing');
  assert.equal(((await buildToday(app, { parts: ['rooms'], demo: true, loaders: allParts(app) })) as unknown as R).rooms, undefined, 'demo: nothing');
  app.companionId = 'c2';
  assert.equal(((await buildToday(app, { parts: ['rooms'], loaders: allParts(app) })) as unknown as R).rooms, undefined, 'another companion: nothing (main companion only)');
  app.companionId = undefined;
  // Nothing from it goes into other parts or memory.
  const src = readFileSync(join(ROOT, 'src', 'today-parts.ts'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('function rooms()')), /memory\.add|app\.memory/);
});

// ------------------------------------------------------------------ 16 · the page

test('111.16 UI: five section headings in order; spans are classes, no style=; tips ≤ 260; 44 px controls; empty tiles collapse; Add to your day lists what is not set up', async () => {
  const html = web('index.html');
  const today = html.slice(html.indexOf('<dialog id="today"'), html.indexOf('</dialog>', html.indexOf('<dialog id="today"')));
  assert.deepEqual([...today.matchAll(/<h2 class="td-sec-h" id="td-sec-(\w+)-h">([^<]+)<\/h2>/g)].map((m) => `${m[1]}:${m[2]}`), ['day:Your day', 'needs:Needs you', 'her:With her', 'work:Work', 'more:Home &amp; more']);
  assert.doesNotMatch(today, /\sstyle=/, 'no inline styles in Today');
  for (const f of ['today.js', 'today-layout.js']) assert.doesNotMatch(web(f), /\.style\.|setAttribute\('style'/, `${f}: spans are classes`);
  const css = web('today.css');
  for (const n of [3, 4, 6, 12]) assert.match(css, new RegExp(`\\.td-grid > \\.td-span-${n} \\{ grid-column: span ${n}; \\}`));
  assert.match(css, /@container today \(min-width: 1060px\)/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ #today \.td-tile\.td-skel::after \{ animation: none; \}/);
  for (const sel of ['.td-c-arrows button', '.td-tile-head > .td-more', '.td-menu-item', '.td-c-size', '.td-c-row', '.td-away-x']) assert.match(css, new RegExp(`${sel.replace(/[.>()[\]]/g, (c) => `\\${c}`)} \\{[^}]*min-height: 44px`), `${sel} is 44 px`);
  // Every Customise setting has a ? tip of at most 260 characters (tips.json), and each tile row's tip too.
  const tips = JSON.parse(web('tips.json')).tips as Record<string, [string, string]>;
  for (const id of ['td-away-hours', 'td-needs-mail', 'td-usage-cost', 'td-coming-days', 'td-phone-open', 'td-rooms-on']) assert.ok(tips[id] && tips[id][0].length <= 260, id);
  const lay = await load('today-layout.js');
  for (const x of lay.TILES) assert.ok(lay.tileTip(x.id).length > 10 && lay.tileTip(x.id).length <= 260, `tip for ${x.id}`);
  // Empty tiles collapse; not-set-up ones become lines in Add to your day.
  const m = await load('today.js');
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, calendar: undefined, mail: null, home: 'not-connected', projects: { items: [{}], github: false } }).map((x: { key: string }) => x.key), ['weather', 'calendar', 'mail', 'home', 'github']);
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, calendar: undefined, hidden: ['weather'] }).map((x: { key: string }) => x.key), ['calendar'], 'each line has its own Hide');
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, member: true }), []);
  // Fixed slots first, collapse after the batch (no layout shift): the skeleton keeps last time's slots.
  assert.match(web('today.js'), /applyLayout\(saved\.prefs, \{ pending: true, keep: saved\.visible \?\? \[\] \}\)/);
  assert.match(web('app.js'), /if \(!todayData\(\)\) drawSkeleton\(\);/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v45'\)/);
});

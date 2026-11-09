// M1 gaps: leave-by reminders and the weekly review read the calendar Sara uses everywhere (the
// default mailbox's Outlook calendar, else Google's), not only Google's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaveByWorker } from '../src/leaveby.ts';
import { gatherReview } from '../src/review.ts';
import type { CalendarEventOut, MailAccountInfo } from '../src/mail/types.ts';
import { makeApp, tempDir } from './helpers.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stand-in account list with one Outlook mailbox (calendar on) as the default. */
function outlook(events: CalendarEventOut[], asked: { from: Date; to: Date }[]) {
  const info = { id: 'ms1', kind: 'microsoft', provider: 'outlook', address: 'alex@outlook.com', label: 'Outlook', calendar: true } as unknown as MailAccountInfo;
  return {
    default: () => info,
    list: () => [info],
    provider: () => ({
      calendar: {
        events: async (from: Date, to: Date) => {
          asked.push({ from, to });
          return events.filter((e) => Date.parse(e.start) >= from.getTime() && Date.parse(e.start) < to.getTime());
        },
      },
    }),
  };
}

test('leave-by: reminders come from the default Outlook calendar when Google is not connected', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-26T19:30:00Z') }; // 2:30 PM Chicago
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ timeZone: 'America/Chicago', leaveBy: { enabled: true, home: { label: 'Home', lat: 39.1, lon: -94.6 }, mode: 'car', bufferMin: 10 } });
  const asked: { from: Date; to: Date }[] = [];
  (app as { mailAccounts?: unknown }).mailAccounts = outlook(
    [
      { id: 'dent', title: 'Dentist', location: '123 Main St, Kansas City', start: '2026-10-26T20:00:00Z', allDay: false },
      { id: 'team', title: 'Standup', location: 'Microsoft Teams Meeting', start: '2026-10-26T20:05:00Z', allDay: false },
      { id: 'fair', title: 'Fair', location: 'Fairgrounds', start: '2026-10-26T00:00:00Z', allDay: true },
    ],
    asked,
  );
  (app as { google?: unknown }).google = { status: () => ({ calendar: false, gmail: false }), api: async () => assert.fail('Google must not be asked') };
  const f = async (url: string) => {
    if (url.includes('nominatim')) return json([{ lat: '39.0', lon: '-94.5', display_name: 'somewhere' }]);
    if (url.includes('routed-car')) return json({ code: 'Ok', routes: [{ duration: 25 * 60 }] });
    return json({}, 404);
  };
  const w = new LeaveByWorker(app, f as never);
  const sent = await w.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Time to leave for “Dentist” at 3:00 PM: it's about a 25-minute drive to 123 Main St/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].to.getTime() - asked[0].from.getTime(), 4 * 3600_000, 'the next four hours');
  assert.deepEqual(await w.tick(), [], 'only once');
});

test('leave-by: nothing to read without any calendar', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-26T19:30:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ leaveBy: { enabled: true, home: { label: 'Home', lat: 39.1, lon: -94.6 }, mode: 'car', bufferMin: 10 } });
  const w = new LeaveByWorker(app, (async () => assert.fail('no lookups')) as never);
  assert.deepEqual(await w.tick(), []);
});

test('weekly review: next week\'s calendar comes from the default Outlook mailbox, ahead of Google', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T23:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ timeZone: 'America/Chicago' });
  const asked: { from: Date; to: Date }[] = [];
  (app as { mailAccounts?: unknown }).mailAccounts = outlook(
    [
      { id: 'a', title: 'Quarterly planning', start: '2026-11-10T15:00:00Z', allDay: false },
      { id: 'b', title: 'Holiday', start: '2026-11-11', allDay: true },
    ],
    asked,
  );
  // Google is connected too, but the default mailbox is Outlook: its calendar wins.
  (app as { google?: unknown }).google = { status: () => ({ calendar: true, gmail: true }), api: async () => ({ items: [{ id: 'g', summary: 'From Google', start: { dateTime: '2026-11-10T16:00:00Z' } }] }) };
  const f = await gatherReview(app, clock.now);
  assert.ok(f.calendar, 'has a calendar');
  assert.ok(f.calendar!.some((x) => /Quarterly planning/.test(x)), f.calendar!.join());
  assert.ok(f.calendar!.some((x) => /Holiday/.test(x)));
  assert.ok(!f.calendar!.some((x) => /From Google/.test(x)));
  assert.equal(asked.length, 1);
});

test('weekly review: still Google\'s calendar when Gmail is the only mailbox', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T23:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  (app as { google?: unknown }).google = { status: () => ({ calendar: true, gmail: true }), api: async () => ({ items: [{ id: 'g', summary: 'From Google', start: { dateTime: '2026-11-10T16:00:00Z' } }] }) };
  const f = await gatherReview(app, clock.now);
  assert.deepEqual(f.calendar?.length, 1);
  assert.match(f.calendar![0], /From Google/);
});

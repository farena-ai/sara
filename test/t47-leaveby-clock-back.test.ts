// T47: her leave-by chat message in the hour the clocks go back. An event at a wall time that
// happens twice that night says which one it is, (1st) or (2nd), as the Today page does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaveByWorker, repeatedHour } from '../src/leaveby.ts';
import { makeApp, tempDir } from './helpers.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One tick of the worker at `now`, with one event at `start` 35 minutes of travel + buffer away. */
async function leaveMessage(t: { after: (fn: () => void) => void }, now: string, start: string, timeZone: string): Promise<string[]> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date(now) });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ timeZone, leaveBy: { enabled: true, home: { label: 'Home', lat: 39.1, lon: -94.6 }, mode: 'car', bufferMin: 10 } });
  (app as { google?: unknown }).google = { status: () => ({ calendar: true, gmail: true }), api: async () => ({ items: [{ id: 'party', summary: 'After party', location: '123 Main St, Kansas City', start: { dateTime: start } }] }) };
  const f = async (url: string) => (url.includes('nominatim') ? json([{ lat: '39.0', lon: '-94.5', display_name: 'somewhere' }]) : url.includes('routed-car') ? json({ code: 'Ok', routes: [{ duration: 25 * 60 }] }) : json({}, 404));
  return new LeaveByWorker(app, f as never).tick();
}

// America/Chicago: the clocks go back on 2026-11-01 at 07:00 UTC, so 1:00 to 1:59 AM happens twice.
test('the first 1:30 AM of the night is marked (1st)', async (t) => {
  const sent = await leaveMessage(t, '2026-11-01T05:56:00Z', '2026-11-01T06:30:00Z', 'America/Chicago');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^🚗 Time to leave for “After party” at 1:30 AM \(1st\): it's about a 25-minute drive to 123 Main St without traffic\.$/);
});

test('the second 1:30 AM of the night is marked (2nd)', async (t) => {
  const sent = await leaveMessage(t, '2026-11-01T06:56:00Z', '2026-11-01T07:30:00Z', 'America/Chicago');
  assert.equal(sent.length, 1);
  assert.match(sent[0], / at 1:30 AM \(2nd\): /);
});

test('any other time has no mark, that night and the rest of the year', async (t) => {
  const later = await leaveMessage(t, '2026-11-01T07:56:00Z', '2026-11-01T08:30:00Z', 'America/Chicago');
  assert.match(later[0], / at 2:30 AM: /);
  const ordinary = await leaveMessage(t, '2026-10-26T19:30:00Z', '2026-10-26T20:00:00Z', 'America/Chicago');
  assert.match(ordinary[0], / at 3:00 PM: /);
});

test("the mark follows the owner's time zone, not this computer's", () => {
  const first = Date.parse('2026-11-01T06:30:00Z');
  const second = Date.parse('2026-11-01T07:30:00Z');
  assert.equal(repeatedHour(first, 'America/Chicago'), '1st');
  assert.equal(repeatedHour(second, 'America/Chicago'), '2nd');
  // The same instants elsewhere are ordinary times.
  assert.equal(repeatedHour(first, 'Asia/Tokyo'), '');
  assert.equal(repeatedHour(second, 'UTC'), '');
  // Europe/Berlin went back a week earlier (2026-10-25 01:00 UTC): 2:30 happens twice there.
  assert.equal(repeatedHour(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Berlin'), '1st');
  assert.equal(repeatedHour(Date.parse('2026-10-25T01:30:00Z'), 'Europe/Berlin'), '2nd');
  // The spring change repeats nothing; a zone that is not known gets no mark.
  assert.equal(repeatedHour(Date.parse('2026-03-08T08:30:00Z'), 'America/Chicago'), '');
  assert.equal(repeatedHour(first, 'Not/AZone'), '');
  assert.equal(repeatedHour(Number.NaN, 'America/Chicago'), '');
});

// T45 C21: Today in the hour the clocks go back. A time in the hour that happens twice says which
// one it is everywhere it is shown: the timeline, the "Leave by" line, the Now card and the phone's
// summary. The rows stay in true time order, with a leave-by row before its event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

/** web/today.js in Node (its naming.js import becomes a small stand-in). */
async function loadToday() {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  const src = web('today.js')
    .replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub)
    .replace(/from '\.\/device-approval\.js';/, `from 'data:text/javascript,${encodeURIComponent('export const checkPrompts = async () => {}; export const requestLine = () => "";')}';`)
    .replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  assert.ok(src.includes(stub), 'today.js imports naming.js');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

/** Runs `fn` with the clock rules of America/Chicago (clocks go back on 2026-11-01 at 07:00 UTC). */
async function inChicago(fn: () => void | Promise<void>) {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    await fn();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}
const utc = (hm: string) => Date.parse(`2026-11-01T${hm}:00Z`);

test('T45 Today: a time in the repeated hour says which one, and no other time does', async () => {
  const m = await loadToday();
  await inChicago(() => {
    assert.match(m.dayTime(utc('06:30')), /^1:30\sAM \(1st\)$/);
    assert.match(m.dayTime(utc('07:30')), /^1:30\sAM \(2nd\)$/);
    assert.match(m.dayTime(utc('05:30')), /^12:30\sAM$/, 'the hour before');
    assert.match(m.dayTime(utc('08:30')), /^2:30\sAM$/, 'the hour after');
    assert.match(m.dayTime(Date.parse('2026-07-04T18:00:00Z')), /^1:00\sPM$/, 'a summer afternoon');
    // The night the clocks go forward has no repeated hour.
    assert.doesNotMatch(m.dayTime(Date.parse('2026-03-08T07:30:00Z')), /\(/);
    assert.doesNotMatch(m.dayTime(Date.parse('2026-03-08T08:30:00Z')), /\(/);
  });
});

test('T45 Today: Leave by, the Now card and the phone summary name the repeated hour too', async () => {
  const m = await loadToday();
  await inChicago(() => {
    const iso = (hm: string) => new Date(utc(hm)).toISOString();
    // A late shift: a reminder at 1:45 (the first time), then leave at 1:10 for work at 1:30 (the second time).
    const d = {
      day: '2026-11-01',
      calendar: { events: [{ id: 'e1', title: 'Night shift', start: iso('07:30'), end: iso('09:00'), location: '4 Mill Rd' }], leaveBy: [{ eventId: 'e1', leaveAt: iso('07:10'), minutes: 15, mode: 'car' }] },
      agenda: { reminders: [{ id: 1, text: 'Take the pills', dueAt: iso('06:45') }], tasks: [] },
    };
    const now = utc('05:00');
    const items = m.dayItems(d, now) as { kind: string; at: number; title: string }[];
    assert.deepEqual(items.map((x) => x.kind), ['reminder', 'leave', 'event'], 'true time order; the leave-by before its event');
    // On the wall clock they read 1:45, 1:10, 1:30: only the mark makes that order make sense.
    assert.deepEqual(items.map((x) => m.dayTime(x.at).replace(/\s/g, ' ')), ['1:45 AM (1st)', '1:10 AM (2nd)', '1:30 AM (2nd)']);
    assert.equal(m.leaveLine(items[1]).replace(/\s/g, ' '), 'Leave by 1:10 AM (2nd) for Night shift');

    const next = m.nowItems(d, now) as { kind: string; mins: number }[];
    assert.deepEqual(next.map((x) => x.kind), ['reminder', 'leave']);
    const lines = next.map((x) => (m.nowLine(x) as string[]).map((s) => s.replace(/\s/g, ' ')));
    assert.deepEqual(lines[0], ['reminder', 'Take the pills at 1:45 AM (1st)', '']);
    assert.deepEqual(lines[1], ['car', 'Leave by 1:10 AM (2nd) for Night shift', 'leave']);
    // Within the hour the Now card counts minutes, which is never unclear.
    assert.deepEqual(m.nowLine({ kind: 'event', title: 'Night shift', at: utc('07:30'), mins: 20 }), ['calendar', 'Night shift in 20 min', 'soon']);
    assert.deepEqual(m.nowLine({ kind: 'reminder', title: 'Take the pills', at: utc('06:45'), mins: 0 }), ['reminder', 'Now: Take the pills', 'soon']);

    // The phone's one-line summary: the time once, with its mark.
    assert.equal(m.phoneDayLine(next[1]).replace(/\s/g, ' '), '1:10 AM (2nd) Leave · 15 min');
    assert.equal(m.phoneDayLine(next[0]).replace(/\s/g, ' '), '1:45 AM (1st) Take the pills');
  });
});

test('T45 Today: an ordinary day reads as before', async () => {
  const m = await loadToday();
  await inChicago(() => {
    const at = Date.parse('2026-10-30T19:20:00Z'); // 2:20 PM
    assert.equal(m.leaveLine({ at, title: 'Dentist' }).replace(/\s/g, ' '), 'Leave by 2:20 PM for Dentist');
    assert.deepEqual((m.nowLine({ kind: 'event', title: 'Dentist', at, mins: 240 }) as string[]).map((s) => s.replace(/\s/g, ' ')), ['calendar', 'Dentist at 2:20 PM', '']);
    assert.equal(m.phoneDayLine({ kind: 'leave', at, minutes: 25 }).replace(/\s/g, ' '), '2:20 PM Leave · 25 min');
  });
});

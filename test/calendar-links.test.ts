// HANDSFREE 3 (docs/CALENDAR_LINKS.md): "Add a calendar by link" (a private iCal address, read only, read
// again every 15 minutes, the address kept in the vault) and the "Set up Google sign-in for me" playbook,
// checked against fake Google pages (real Google can't be tested here).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { CalendarLinks, CalLinkError, expandRule, linkEvents, linkUrl } from '../src/calendar-links.ts';
import { isGoogleSignIn, nextSetupStep, redirectFrom, setupSteps } from '../src/google-setup.ts';
import { allEvents, calendarSources } from '../src/mail/calendars.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:dentist',
  'DTSTART:20261118T150000Z',
  'DTEND:20261118T160000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:standup',
  'DTSTART:20261102T140000Z',
  'DTEND:20261102T141500Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
  'EXDATE:20261118T140000Z',
  'SUMMARY:Standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:standup',
  'RECURRENCE-ID:20261116T140000Z',
  'DTSTART:20261116T170000Z',
  'DTEND:20261116T171500Z',
  'SUMMARY:Standup (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gone',
  'STATUS:CANCELLED',
  'DTSTART:20261117T100000Z',
  'SUMMARY:Cancelled thing',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:bday',
  'DTSTART;VALUE=DATE:20151119',
  'DTEND;VALUE=DATE:20151120',
  'RRULE:FREQ=YEARLY',
  'SUMMARY:Sam\u2019s birthday',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const FROM = new Date('2026-11-16T00:00:00Z');
const TO = new Date('2026-11-23T00:00:00Z');

test('calendar links: the address, recurring events, moved and cancelled ones', () => {
  assert.equal(linkUrl('webcal://p01-caldav.example.com/published/2/abc').toString(), 'https://p01-caldav.example.com/published/2/abc');
  for (const bad of ['ftp://x.example/cal.ics', 'not a link', 'https://user:pw@x.example/cal.ics']) assert.throws(() => linkUrl(bad), CalLinkError, bad);
  const evs = linkEvents(ICS, 'cl_1', FROM, TO);
  const titles = evs.map((e) => `${e.title} ${e.start}`);
  assert.deepEqual(titles, [
    'Standup (moved) 2026-11-16T17:00:00.000Z',
    'Dentist 2026-11-18T15:00:00.000Z',
    'Sam\u2019s birthday 2026-11-19',
  ]);
  // Weekly on Mondays and Wednesdays: the Monday moved, the Wednesday an EXDATE; next week both come.
  const next = linkEvents(ICS, 'cl_1', new Date('2026-11-23T00:00:00Z'), new Date('2026-11-26T00:00:00Z')).map((e) => e.start);
  assert.deepEqual(next, ['2026-11-23T14:00:00.000Z', '2026-11-25T14:00:00.000Z']);
  // Rules: COUNT, UNTIL, INTERVAL, a monthly 31st skips short months, far-away starts skip ahead.
  const d = (s: string) => new Date(s);
  assert.equal(expandRule(d('2026-01-01T09:00:00Z'), 'FREQ=DAILY;COUNT=3', d('2026-01-01T00:00:00Z'), d('2026-02-01T00:00:00Z')).length, 3);
  assert.equal(expandRule(d('2026-01-01T09:00:00Z'), 'FREQ=DAILY;UNTIL=20260105T090000Z', d('2026-01-01T00:00:00Z'), d('2026-02-01T00:00:00Z')).length, 5);
  assert.equal(expandRule(d('2026-01-01T09:00:00Z'), 'FREQ=WEEKLY;INTERVAL=2', d('2026-01-01T00:00:00Z'), d('2026-02-01T00:00:00Z')).length, 3);
  assert.deepEqual(expandRule(d('2026-01-31T09:00:00Z'), 'FREQ=MONTHLY', d('2026-01-01T00:00:00Z'), d('2026-06-01T00:00:00Z')).map((x) => x.toISOString().slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31']);
  assert.equal(expandRule(d('2000-01-03T09:00:00Z'), 'FREQ=DAILY', d('2026-11-16T00:00:00Z'), d('2026-11-17T00:00:00Z')).length, 1);
});

test('the store: the address in the vault only, read again after 15 minutes, a failed read keeps the last copy, remove', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const vault = new Map<string, string>();
    const v = { get: (k: string) => vault.get(k), set: (k: string, x: string) => void vault.set(k, x), delete: (k: string) => void vault.delete(k) };
    const links = new CalendarLinks(v, join(dir, 'calendar-links.json'));
    let now = Date.parse('2026-11-16T12:00:00Z');
    links.now = () => now;
    let reads = 0;
    let fail = false;
    links.fetch = async (url) => {
      reads++;
      assert.equal(url, 'https://calendar.example.com/calendar/ical/abc/private-0000/basic.ics');
      if (fail) throw new Error('offline');
      return new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } });
    };
    await assert.rejects(links.add('', 'https://calendar.example.com/x.ics'), /Give the calendar a name/);
    const info = await links.add('Family', 'https://calendar.example.com/calendar/ical/abc/private-0000/basic.ics');
    assert.equal(info.name, 'Family');
    assert.equal(info.host, 'calendar.example.com');
    assert.equal(info.events, 5);
    const file = readFileSync(join(dir, 'calendar-links.json'), 'utf8');
    assert.ok(!file.includes('private-0000'), 'the secret address is not in the plain file');
    assert.equal(vault.get(`calendar-link:${info.id}`), 'https://calendar.example.com/calendar/ical/abc/private-0000/basic.ics');
    const src = calendarSources({ mailAccounts: { list: () => [], calendarLinks: links } as never });
    assert.equal(src.length, 1);
    assert.equal(src[0].address, 'Family');
    const got = await allEvents(src, FROM, TO, 20, new AbortController().signal);
    assert.equal(got.events.length, 3);
    assert.equal(reads, 1, 'cached');
    now += 16 * 60_000;
    await src[0].events(FROM, TO, 20, new AbortController().signal);
    assert.equal(reads, 2, 'read again after 15 minutes');
    fail = true;
    now += 16 * 60_000;
    assert.equal((await src[0].events(FROM, TO, 20, new AbortController().signal)).length, 3, 'the last good copy');
    assert.match(String(links.list()[0].problem), /didn’t answer like a calendar/);
    // Not a calendar.
    fail = false;
    links.fetch = async () => new Response('<html>sign in</html>', { status: 200 });
    await assert.rejects(links.add('Work', 'https://calendar.example.com/x.ics'), /didn’t answer like a calendar/);
    assert.equal(links.remove(info.id), true);
    assert.equal(vault.size, 0);
    assert.equal(links.list().length, 0);
  } finally {
    cleanup();
  }
});

test('the routes: add, list (never the address), remove', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const vault = new Map<string, string>();
  const links = new CalendarLinks({ get: (k) => vault.get(k), set: (k, x) => void vault.set(k, x), delete: (k) => void vault.delete(k) }, join(dir, 'calendar-links.json'));
  links.fetch = async () => new Response(ICS, { status: 200 });
  app.mailAccounts = { member: false, list: () => [], default: () => undefined, view: () => ({}), calendarLinks: links } as never;
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  try {
    const add = await call('POST', '/api/mail/calendar-links', { name: 'Family', url: 'webcal://calendar.example.com/ical/secret-path/basic.ics' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.ok(!JSON.stringify(add.json).includes('secret-path'));
    const list = await call('GET', '/api/mail/calendar-links');
    assert.equal(list.json.links[0].name, 'Family');
    assert.ok(!JSON.stringify(list.json).includes('secret-path'));
    assert.equal((await call('POST', '/api/mail/calendar-links', { name: 'x', url: 'ftp://nope' })).status, 400);
    assert.equal((await call('DELETE', `/api/mail/calendar-links/${add.json.link.id}`)).json.links.length, 0);
    assert.equal((await call('DELETE', '/api/mail/calendar-links/cl_none')).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    app.store.close();
    cleanup();
  }
});

test('the Google sign-in playbook walks fake Google pages checkpoint by checkpoint; sign-in is the person\u2019s turn', () => {
  const R = 'https://sara.example.net/api/google/callback';
  assert.equal(redirectFrom(`Set up Google sign-in for me, just do it. My redirect address is ${R}`), R);
  assert.equal(redirectFrom('no address here'), undefined);
  assert.equal(setupSteps(R).length, 6);
  assert.match(setupSteps(R).find((s) => s.id === 'client')!.how, /sara\.example\.net\/api\/google\/callback/);
  const done = new Set<string>();
  const walk = (url: string, title: string, text = '') => {
    const n = nextSetupStep({ url, title, text }, R, done);
    for (const d of n.done) done.add(d);
    return n;
  };
  // Nothing open yet: open the project page.
  let n = walk('', '');
  assert.equal(n.step.id, 'project');
  assert.match(n.text, /Open https:\/\/console\.cloud\.google\.com\/projectcreate/);
  // Google asks her to sign in: the person's turn.
  n = walk('https://accounts.google.com/v3/signin/identifier?continue=x', 'Sign in - Google Accounts', 'Email or phone');
  assert.equal(n.signIn, true);
  assert.match(n.text, /pc_browser_your_turn/);
  assert.ok(isGoogleSignIn({ url: 'https://accounts.google.com/signin/v2/challenge/pwd' }));
  assert.ok(!isGoogleSignIn({ url: 'https://myaccount.google.com/' }));
  // On the project page.
  n = walk('https://console.cloud.google.com/projectcreate', 'New Project', 'Project name');
  assert.match(n.text, /You are on the right page/);
  // The project exists: on to the APIs.
  n = walk('https://console.cloud.google.com/home/dashboard?project=sara-123456', 'Dashboard', 'Project info');
  assert.equal(n.step.id, 'apis');
  n = walk('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=sara-123456', 'Google Calendar API', 'Enable');
  assert.equal(n.step.id, 'apis');
  n = walk('https://console.cloud.google.com/apis/api/gmail.googleapis.com/metrics?project=sara-123456', 'Gmail API', 'API Enabled  Manage');
  assert.equal(n.step.id, 'branding');
  n = walk('https://console.cloud.google.com/auth/overview?project=sara-123456', 'Google Auth Platform', 'Google Auth Platform not configured yet Get started');
  assert.equal(n.step.id, 'branding');
  n = walk('https://console.cloud.google.com/auth/overview?project=sara-123456', 'Google Auth Platform', 'OAuth configuration created! Create OAuth client');
  assert.equal(n.step.id, 'audience');
  n = walk('https://console.cloud.google.com/auth/audience?project=sara-123456', 'Audience', 'Publishing status In production');
  assert.equal(n.step.id, 'client');
  assert.match(n.text, /Authorized redirect URIs.*https:\/\/sara\.example\.net\/api\/google\/callback/);
  n = walk('https://console.cloud.google.com/auth/clients?project=sara-123456', 'Clients', 'OAuth client created Client ID Client secret');
  assert.equal(n.step.id, 'paste');
  assert.match(n.text, /your turn|Your turn/);
  assert.match(n.text, /never type or read the secret/);
  assert.deepEqual(n.done, ['project', 'apis', 'branding', 'audience', 'client']);
});

test('Gmail with an app password points at the calendar link or Google sign-in', () => {
  const js = readFileSync(join(ROOT, 'web', 'mail-accounts.js'), 'utf8');
  assert.match(js, /Calendar: use Add a calendar by link, or Google sign-in/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="cl-page"/);
  assert.match(html, /id="g-auto"/);
});

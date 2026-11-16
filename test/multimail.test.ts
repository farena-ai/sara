// MULTIMAIL (docs/MAIL_ACCOUNTS.md): several Google sign-ins through the owner's one Google app,
// calendars from every account (Google each, CalDAV for app-password mailboxes), the combined
// inbox / Today labeled by account, and replies going from the mailbox that got the email.
// Fakes only: a fake Google (token, profile, Gmail, Calendar per signed-in account), a fake CalDAV
// server on 127.0.0.1, and stand-in gmail_* tools per account.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { GOOGLE_CLIENT_VAULT, GOOGLE_TOKEN_VAULT, GoogleAccount } from '../src/google.ts';
import { GOOGLE_EXTRA_VAULT, GoogleAccounts, googleTokenVault } from '../src/google-accounts.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { eventsFromIcs, icsFor } from '../src/mail/caldav.ts';
import { allEvents, calendarSources } from '../src/mail/calendars.ts';
import { createMailTools, routeCalendarTools } from '../src/tools/mail.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { calendarEvents, clearTodayCache, mailToday } from '../src/today.ts';
import { vaultSecretValues } from '../src/redact.ts';
import { makeApp, tempDir } from './helpers.ts';

// Fake ids are built at run time (never realistic-looking secrets in the repo).
const fakeId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const CLIENT = `${fakeId('client')}.apps.googleusercontent.com`;

/** A fake Google: the sign-in code says which person signs in; every API answer is that person's. */
function fakeGoogle() {
  const people: Record<string, { email: string; unread: number; events: { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string } }[]; important: { id: string; subject: string; at: number }[] }> = {
    alex: { email: 'alex@example.com', unread: 3, events: [{ id: 'ga1', summary: 'Dentist', start: { dateTime: '2026-11-16T15:00:00Z' }, end: { dateTime: '2026-11-16T16:00:00Z' } }], important: [{ id: 'mA1xyz', subject: 'Lease renewal', at: Date.parse('2026-11-16T08:00:00Z') }] },
    work: { email: 'alex@work.example', unread: 2, events: [{ id: 'gw1', summary: 'Standup', start: { dateTime: '2026-11-16T14:00:00Z' }, end: { dateTime: '2026-11-16T14:15:00Z' } }], important: [{ id: 'mW1xyz', subject: 'Budget review', at: Date.parse('2026-11-16T09:00:00Z') }] },
  };
  const tokens = new Map<string, string>();
  const calls: string[] = [];
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(init.body));
      const who = p.get('code') ?? 'alex';
      const at = fakeId(`at-${who}`);
      tokens.set(at, who);
      return json(200, { access_token: at, expires_in: 3600, refresh_token: fakeId('rt'), scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    const auth = String((init.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '');
    const who = people[tokens.get(auth) ?? ''];
    if (!who) return json(401, { error: { message: 'bad token' } });
    if (url.endsWith('/users/me/profile')) return json(200, { emailAddress: who.email });
    if (url.endsWith('/labels/INBOX')) return json(200, { messagesUnread: who.unread, messagesTotal: who.unread * 10 });
    if (url.includes('/users/me/messages?')) return json(200, { messages: who.important.map((m) => ({ id: m.id })) });
    const one = /\/messages\/(\w+)\?format=metadata/.exec(url);
    if (one) {
      const m = who.important.find((x) => x.id === one[1])!;
      return json(200, { id: m.id, threadId: `t-${m.id}`, internalDate: String(m.at), payload: { headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Subject', value: m.subject }] } });
    }
    if (url.includes('/calendars/primary/events')) return json(200, { items: who.events });
    if (url.includes('/users/me/calendarList')) return json(200, { items: [{ id: who.email, summary: who.email, primary: true }, { id: 'family@group.example', summary: 'Family' }] });
    return json(404, { error: { message: 'not found' } });
  }) as typeof fetch;
  return { f, calls, people };
}

const tmp = tempDir();
const fg = fakeGoogle();
const clock = { now: new Date('2026-11-16T12:00:00Z') };
const app = makeApp(tmp.dir, clock);
const vault = app.vault;
vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: CLIENT, clientSecret: fakeId('GOCSPX') }));
const primary = new GoogleAccount(vault, { fetch: fg.f });
const googles = new GoogleAccounts(vault, primary, { fetch: fg.f });
const ms = new MicrosoftAuth(vault, {});

/** A fake CalDAV server (one calendar, events with a time zone and an all-day one). */
const dav = { puts: [] as { url: string; body: string }[], deletes: [] as string[], auth: '' };
const davServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    dav.auth = String(req.headers.authorization ?? '');
    const ms207 = (xml: string) => (res.writeHead(207, { 'content-type': 'application/xml' }), res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>`));
    if (req.method === 'PROPFIND' && req.url === '/dav/') return ms207('<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/alex/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>');
    if (req.method === 'PROPFIND' && req.url === '/dav/principals/alex/') return ms207('<d:response><d:href>/dav/principals/alex/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/dav/calendars/alex/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>');
    if (req.method === 'PROPFIND' && req.url === '/dav/calendars/alex/')
      return ms207(
        '<d:response><d:href>/dav/calendars/alex/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
          '<d:response><d:href>/dav/calendars/alex/home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Home</d:displayname><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>' +
          '<d:response><d:href>/dav/calendars/alex/tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>',
      );
    if (req.method === 'REPORT' && req.url === '/dav/calendars/alex/home/') {
      const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'DTSTART;TZID=America/Chicago:20261116T100000', 'DTEND;TZID=America/Chicago:20261116T110000', 'SUMMARY:Piano lesson\\, Ana', 'LOCATION:Music room', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:2', 'DTSTART;VALUE=DATE:20261116', 'DTEND;VALUE=DATE:20261117', 'SUMMARY:Recycling day', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      return ms207(`<d:response><d:href>/dav/calendars/alex/home/e1.ics</d:href><d:propstat><d:prop><cal:calendar-data>${ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</cal:calendar-data></d:prop></d:propstat></d:response>`);
    }
    if (req.method === 'PUT') {
      dav.puts.push({ url: req.url ?? '', body });
      return (res.writeHead(201), res.end());
    }
    if (req.method === 'DELETE') {
      dav.deletes.push(req.url ?? '');
      return (res.writeHead(204), res.end());
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((r) => davServer.listen(0, '127.0.0.1', () => r()));
const davBase = `http://127.0.0.1:${(davServer.address() as { port: number }).port}/dav/`;
const accounts = new MailAccounts(vault, primary, ms, { googles, viewFile: `${tmp.dir}/mail-view.json`, caldav: { fetch }, imap: { lookup: async () => { throw new Error('no network in tests'); } } });
after(async () => {
  await new Promise<void>((r) => davServer.close(() => r()));
  app.store.close();
  tmp.cleanup();
});

/** Signs a person in through the real authUrl → finish flow (the fake's code names the person). */
async function signIn(who: string, add: boolean) {
  const url = new URL(googles.authUrl('https://sara.example.com/api/google/callback', { add }));
  return googles.finish(who, url.searchParams.get('state')!);
}

test('several Google sign-ins: the first stays "google", the next is "google:2", each with its own vault entry', async () => {
  const first = await signIn('alex', false);
  assert.equal(first.id, 'google');
  assert.equal(first.email, 'alex@example.com');
  // Adding another: Google's account picker first, a new slot.
  const addUrl = new URL(googles.authUrl('https://sara.example.com/api/google/callback', { add: true }));
  assert.equal(addUrl.searchParams.get('prompt'), 'select_account consent');
  const second = await googles.finish('work', addUrl.searchParams.get('state')!);
  assert.equal(second.id, 'google:2');
  assert.equal(second.email, 'alex@work.example');
  assert.ok(vault.get(GOOGLE_TOKEN_VAULT), 'the first sign-in stays where it always was');
  assert.ok(vault.get(googleTokenVault(2)));
  assert.deepEqual(JSON.parse(vault.get(GOOGLE_EXTRA_VAULT)!), { n: [2] }, 'the list holds numbers only');
  assert.deepEqual(accounts.list().map((a) => [a.id, a.address, a.calendar]), [['google', 'alex@example.com', true], ['google:2', 'alex@work.example', true]]);
  // The same address signing in again replaces its own sign-in (no duplicate account).
  const again = await signIn('work', true);
  assert.equal(again.id, 'google:2');
  assert.equal(googles.list().length, 2);
  assert.equal(vault.get(googleTokenVault(3)), undefined);
  // Addresses and permissions are labels, not secrets (cards and Today name each mailbox).
  const secrets = vaultSecretValues(vault.values());
  assert.ok(!secrets.includes('alex@work.example') && !secrets.includes('alex@example.com'));
  assert.ok(secrets.some((s) => s.startsWith('at-work')), 'the tokens stay hidden');
});

test('combined Today: every mailbox, counts added up, rows labeled; a later account opens Gmail as itself', async () => {
  app.mailAccounts = accounts;
  app.google = primary;
  const m = (await mailToday(app))!;
  assert.equal(m.unread, 5);
  assert.deepEqual(m.accounts?.map((a) => [a.address, a.unread]), [['alex@example.com', 3], ['alex@work.example', 2]]);
  assert.deepEqual(m.important.map((x) => [x.subject, x.account]), [['Budget review', 'alex@work.example'], ['Lease renewal', 'alex@example.com']]);
  assert.match(m.important[0].webUrl!, /authuser=alex%40work\.example/);
  // Left out of the combined view: Today reads the default alone, exactly as before.
  accounts.setView({ off: ['google:2'] });
  clearTodayCache(app);
  const one = (await mailToday(app))!;
  assert.equal(one.unread, 3);
  assert.equal(one.accounts, undefined);
  accounts.setView({ off: [] });
});

test('calendars from every account: Google each, CalDAV turned on for an iCloud-style mailbox, labeled and sorted', async () => {
  const { info, password } = accounts.imapDraft({ preset: 'other', address: 'alex@icloud.example', password: fakeId('pw'), imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' });
  const saved = accounts.saveImap(info, password);
  await assert.rejects(accounts.enableCalendar(saved.id), /doesn't know a calendar address/);
  const on = await accounts.enableCalendar(saved.id, davBase);
  assert.equal(on.calendar, true);
  assert.deepEqual(accounts.calDavCalendars(saved.id).map((c) => c.name), ['Home'], 'only calendars with events (not task lists)');
  assert.match(dav.auth, /^Basic /);
  const srcs = calendarSources(app);
  assert.deepEqual(srcs.map((s) => s.id), ['google', 'google:2', saved.id]);
  const evs = await calendarEvents(app, new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'), 20);
  assert.deepEqual(evs.map((e) => [e.title, e.account]), [
    ['Recycling day', 'alex@icloud.example'],
    ['Standup', 'alex@work.example'],
    ['Dentist', 'alex@example.com'],
    ['Piano lesson, Ana', 'alex@icloud.example'],
  ]);
  assert.equal(evs.find((e) => e.title.startsWith('Piano'))!.start, '2026-11-16T16:00:00.000Z', 'TZID wall time → UTC');
  // Choosing calendars per account: Google's work account hidden, the family calendar shown for the first.
  accounts.setView({ calendars: { 'google:2': false, google: ['primary', 'family@group.example'] } });
  assert.deepEqual(calendarSources(app).map((s) => s.id), ['google', saved.id]);
  fg.calls.length = 0;
  await allEvents(calendarSources(app), new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'), 20, AbortSignal.timeout(5000));
  assert.ok(fg.calls.some((c) => c.includes('/calendars/family%40group.example/events')));
  accounts.setView({ calendars: { 'google:2': null, google: null } as never });
  assert.deepEqual(accounts.view().calendars, {}, 'null puts an account back to its usual calendars');
});

test('ICS in and out: a new event as one VEVENT; escaped text read back', () => {
  const ics = icsFor({ title: 'Lunch; with Ana', start: '2026-11-18T12:00', end: '2026-11-18T13:00', allDay: false, guests: ['ana@example.com'], timeZone: 'America/Chicago' }, 'u1@sara', new Date('2026-11-16T00:00:00Z'));
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20261118T120000/);
  assert.match(ics, /SUMMARY:Lunch\\; with Ana/);
  const back = eventsFromIcs(ics, 'https://dav.example/e.ics');
  assert.equal(back[0].title, 'Lunch; with Ana');
  assert.deepEqual(back[0].attendees, ['ana@example.com']);
});

// ---------- the tools: stand-in gmail_* tools per account ----------
const calls: { account: string; name: string; args: Record<string, unknown> }[] = [];
const stubs = (account: string, prefix: string) =>
  new Map<string, Tool>(
    ['gmail_search', 'gmail_read', 'gmail_thread', 'gmail_needs_answer', 'gmail_draft', 'gmail_send', 'gmail_organize', 'gmail_undo', 'gmail_labels', 'gmail_senders', 'gmail_unsubscribe_info', 'calendar_events', 'calendar_add', 'calendar_remove'].map((name) => [
      name,
      {
        defaultPermission: /draft|send|organize|undo|add|remove/.test(name) ? 'ask' : 'auto',
        spec: { name, description: name, parameters: { type: 'object', properties: {} } },
        isAvailable: () => true,
        summarize: () => name,
        async run(args: Record<string, unknown>) {
          calls.push({ account, name, args });
          if (name === 'gmail_search') return String(args.query).includes('bea@') && account === 'google:2' ? `- [${prefix}9xyzq] From: Bea` : String(args.query).includes('bea@') ? 'No emails found.' : `- [${prefix}1xyzq] From: Ana · Subject: Hello`;
          if (name === 'gmail_read' && !String(args.id).startsWith(prefix)) throw new Error('not found');
          return `${account} ${name}`;
        },
      } satisfies Tool,
    ]),
  );
const tools = new Map<string, Tool>();
const extra = stubs('google:2', 'w');
for (const t of createMailTools({ accounts, organizer: new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => 'UTC' }), google: stubs('google', 'a'), googleFor: (id) => (id === 'google:2' ? extra : undefined), timeZone: () => 'UTC' })) tools.set(t.spec.name, t);
const gcal = stubs('google', 'a');
for (const t of routeCalendarTools([gcal.get('calendar_events')!, gcal.get('calendar_add')!, gcal.get('calendar_remove')!], accounts, () => 'UTC', (id) => (id === 'google:2' ? extra : undefined))) tools.set(t.spec.name, t);
const ctx = (): ToolContext => ({ workspaceDir: tmp.dir, signal: AbortSignal.timeout(20_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId: 'c1' });
const tool = (n: string) => tools.get(n)!;

test('mail_search without an account searches every mailbox in the combined inbox, each part labeled', async () => {
  accounts.setView({ off: [accounts.list().find((a) => a.kind === 'imap')!.id] });
  const out = await tool('mail_search').run({ query: 'from:ana' }, ctx());
  assert.match(out, /Searched 2 mailboxes/);
  assert.match(out, /alex@example\.com \(Gmail\):\n- \[a1xyzq\]/);
  assert.match(out, /alex@work\.example \(Gmail\):\n- \[w1xyzq\]/);
  // Named: that one only.
  calls.length = 0;
  await tool('mail_search').run({ query: 'from:ana', account: 'alex@work.example' }, ctx());
  assert.deepEqual(calls.map((c) => c.account), ['google:2']);
});

test('a reply goes from the mailbox that got the email; the card shows From:', async () => {
  // w1xyzq came from the work account's search above.
  const args: Record<string, unknown> = { to: 'ana@example.com', subject: 'Re: Hello', body: 'Yes!', reply_to: 'w1xyzq' };
  const prep = await tool('mail_send').prepare!(args, { signal: AbortSignal.timeout(5000), conversationId: 'c1' });
  assert.match(prep.summary!, /^SEND email\nFrom: alex@work\.example\nTo: ana@example\.com/);
  assert.equal(args.account, 'alex@work.example', 'the decided mailbox is in the call (the run uses the same one)');
  calls.length = 0;
  assert.equal(await tool('mail_send').run(args, ctx()), 'google:2 gmail_send');
  // An id nobody has seen yet: the mailbox that holds it is found.
  const probe: Record<string, unknown> = { to: 'ana@example.com', subject: 'Re', body: 'x', reply_to: 'w77xyz' };
  await tool('mail_draft').prepare!(probe, { signal: AbortSignal.timeout(5000) });
  assert.equal(probe.account, 'alex@work.example');
  // Reading an email it found goes to the same mailbox without naming it.
  calls.length = 0;
  await tool('mail_read').run({ id: 'w1xyzq' }, ctx());
  assert.deepEqual(calls.map((c) => c.account), ['google:2']);
});

test('a new email: the default mailbox, unless only another one has written with that person', async () => {
  const plain: Record<string, unknown> = { to: 'ana@example.com', subject: 'Hi', body: 'x' };
  await tool('mail_send').prepare!(plain, { signal: AbortSignal.timeout(5000) });
  assert.equal(plain.account, 'alex@example.com', 'the default has talked with Ana');
  const bea: Record<string, unknown> = { to: 'Bea <bea@example.com>', subject: 'Hi', body: 'x' };
  await tool('mail_send').prepare!(bea, { signal: AbortSignal.timeout(5000) });
  assert.equal(bea.account, 'alex@work.example', 'only the work mailbox has a thread with Bea');
  const named: Record<string, unknown> = { to: 'bea@example.com', subject: 'Hi', body: 'x', account: 'alex@example.com' };
  await tool('mail_send').prepare!(named, { signal: AbortSignal.timeout(5000) });
  assert.equal(named.account, 'alex@example.com', 'a named mailbox always wins');
});

test('waiting for my answer covers every combined mailbox by default', async () => {
  calls.length = 0;
  const out = await tool('mail_needs_answer').run({}, ctx());
  assert.deepEqual(calls.map((c) => c.account), ['google', 'google:2']);
  assert.match(out, /alex@example\.com \(Gmail\):[\s\S]*alex@work\.example \(Gmail\):/);
  accounts.setView({ off: [] });
});

test('calendar tools: reading merges every calendar; adding asks which calendar until a default is set', async () => {
  const out = await tool('calendar_events').run({ from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' }, ctx());
  assert.match(out, /Every calendar \(alex@example\.com, alex@work\.example, alex@icloud\.example\)/);
  assert.match(out, /Standup · alex@work\.example/);
  const ask = await tool('calendar_add').prepare!({ title: 'Lunch', start: '2026-11-18T12:00' }, { signal: AbortSignal.timeout(5000) });
  assert.match(ask.refuse!, /Which calendar should it go on\?.*alex@work\.example/);
  const imap = accounts.list().find((a) => a.kind === 'imap')!;
  accounts.setView({ calendarDefault: imap.id });
  assert.deepEqual(await tool('calendar_add').prepare!({ title: 'Lunch', start: '2026-11-18T12:00' }, { signal: AbortSignal.timeout(5000) }), {});
  const added = await tool('calendar_add').run({ title: 'Lunch', start: '2026-11-18T12:00' }, ctx());
  assert.match(added, /to alex@icloud\.example's calendar/);
  assert.match(dav.puts.at(-1)!.body, /SUMMARY:Lunch/);
  // A later Google account's calendar through its own tools.
  calls.length = 0;
  await tool('calendar_add').run({ title: 'Review', start: '2026-11-18T15:00', account: 'alex@work.example' }, ctx());
  assert.deepEqual(calls.map((c) => [c.account, c.name]), [['google:2', 'calendar_add']]);
  // A Gmail app-password mailbox can't open Google Calendar: it says so.
  const { info, password } = accounts.imapDraft({ preset: 'gmail', address: 'bea@gmail.example', password: fakeId('pw') });
  const gm = accounts.saveImap(info, password);
  await assert.rejects(accounts.enableCalendar(gm.id), /Sign in with Google instead/);
  await accounts.remove(gm.id);
});

test('removing one Google account leaves the others; its view choices go too', async () => {
  accounts.setView({ off: ['google:2'], calendarDefault: 'google:2' });
  await accounts.remove('google:2');
  assert.deepEqual(accounts.list().map((a) => a.id).filter((x) => x.startsWith('google')), ['google']);
  assert.ok(vault.get(GOOGLE_TOKEN_VAULT), 'the first account is untouched');
  assert.equal(vault.get(googleTokenVault(2)), undefined);
  assert.equal(vault.get(GOOGLE_EXTRA_VAULT), undefined);
  assert.deepEqual(accounts.view().off, []);
  assert.equal(accounts.view().calendarDefault, undefined);
  // A household member's list never shows the owner's Google accounts.
  const { Vault } = await import('../src/vault.ts');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(`${tmp.dir}/member`, { recursive: true });
  const mv = new Vault(`${tmp.dir}/member`);
  const member = new MailAccounts(mv, undefined, new MicrosoftAuth(mv, {}), {});
  assert.deepEqual(member.list(), []);
});

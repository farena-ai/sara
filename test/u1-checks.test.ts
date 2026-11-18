// U1.2 / U1.4 (docs/CHECKS.md): the check scripts' shared part, and the bug the account check found:
// Settings' Remove on a later Google account (DELETE /api/google/accounts/:id) signed it out but kept its
// combined-view choices (left out of the inbox, calendar picks, the default), so the next Google account
// to get that slot inherited them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { GOOGLE_CLIENT_VAULT, GoogleAccount } from '../src/google.ts';
import { GoogleAccounts } from '../src/google-accounts.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { CheckRun, missingParts } from '../scripts/checks-lib.ts';
import { calendarWhen } from '../src/tools/mail.ts';
import { makeApp, tempDir, ROOT } from './helpers.ts';

const fakeId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const tmp = tempDir();
after(() => tmp.cleanup());

function fakeGoogle() {
  const who = new Map<string, string>();
  const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const code = new URLSearchParams(String(init.body)).get('code') ?? 'a';
      const at = fakeId(`at-${code}`);
      who.set(at, code);
      return json({ access_token: at, expires_in: 3600, refresh_token: fakeId('rt'), scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    const name = who.get(String((init.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, ''));
    if (url.endsWith('/users/me/profile') && name) return json({ emailAddress: `${name}@example.com` });
    return json({ error: { message: 'nope' } }, 404);
  }) as typeof fetch;
}

test('U1.2 bug: Remove on a later Google account (its own route) also forgets its mail view choices', async () => {
  const app = makeApp(tmp.dir, { now: new Date() });
  const f = fakeGoogle();
  app.vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: `${fakeId('c')}.apps.googleusercontent.com`, clientSecret: fakeId('s') }));
  const google = new GoogleAccount(app.vault, { fetch: f });
  const googles = new GoogleAccounts(app.vault, google, { fetch: f });
  const accounts = new MailAccounts(app.vault, google, new MicrosoftAuth(app.vault, {}), { googles, viewFile: join(tmp.dir, 'mail-view.json') });
  app.google = google;
  app.googleAccounts = googles;
  app.mailAccounts = accounts;
  const sign = async (who: string, add: boolean) => googles.finish(who, new URL(googles.authUrl('https://sara.example.com/api/google/callback', { add })).searchParams.get('state')!);
  await sign('alex', false);
  await sign('work', true);
  accounts.setView({ off: ['google:2'], calendarDefault: 'google:2' });
  accounts.setDefault('google:2');
  const auth = new OwnerAuth(tmp.dir, () => new Date());
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/api/google/accounts/google:2`, { method: 'DELETE', headers: { authorization: ['Bearer', tok].join(' '), origin: base } });
    assert.equal(r.status, 200);
    assert.deepEqual(accounts.list().map((a) => a.id), ['google']);
    assert.deepEqual(accounts.view().off, [], 'not left out of the combined inbox any more');
    assert.equal(accounts.view().calendarDefault, undefined, 'not the calendar default any more');
    assert.equal(accounts.default()?.id, 'google', 'the default falls back to the one left');
    // The next Google account in that slot starts clean.
    await sign('new', true);
    assert.deepEqual(accounts.view().off, []);
  } finally {
    await new Promise<void>((ok) => srv.close(() => ok()));
    app.store.close();
  }
});

test('U1 checks: secrets never reach the printed steps or the report', () => {
  const run = new CheckRun('t');
  const pw = fakeId('pw');
  run.secret(pw, 'abc');
  run.group('G');
  run.skip('one', `signed in with ${pw}`);
  const file = run.report(tmp.dir, 'x');
  const md = readFileSync(file, 'utf8');
  assert.ok(existsSync(file) && /outputs[\\/]checks[\\/]x-\d{4}-\d{2}-\d{2}\.md$/.test(file));
  assert.ok(!md.includes(pw) && md.includes('signed in with •••'));
});

test('U1.2: a missing or partial test-accounts file is listed in plain words', () => {
  assert.equal(missingParts({}).length, 7);
  const some = missingParts({ gmail: [{ address: 'a@example.com', appPassword: fakeId('x') }], icalLink: { url: 'https://cal.example/x.ics' } });
  assert.ok(some.some((x) => x.startsWith('gmail[1]')) && !some.some((x) => x.startsWith('gmail[0]')) && !some.some((x) => x.startsWith('icalLink')));
});

test('U1.2 bug: "Added …" names the time the owner asked for, whatever time zone the server runs in', () => {
  const was = process.env.TZ;
  try {
    // The server in Chicago, the owner in UTC (and the other way round: a UTC VPS, an owner in Chicago).
    process.env.TZ = 'America/Chicago';
    assert.match(calendarWhen({ start: '2026-11-19T12:00', end: '2026-11-19T13:00', allDay: false }, 'UTC'), /Thu, Nov 19, 12:00\sPM → Thu, Nov 19, 1:00\sPM/);
    process.env.TZ = 'UTC';
    assert.match(calendarWhen({ start: '2026-11-19T12:00', allDay: false }, 'America/Chicago'), /12:00\sPM/);
    // Times read from a calendar carry their offset and are shown in the owner's zone, as before.
    assert.match(calendarWhen({ start: '2026-11-19T18:00:00.000Z', allDay: false }, 'America/Chicago'), /12:00\sPM/);
    assert.equal(calendarWhen({ start: '2026-11-19', allDay: true }, 'UTC'), '2026-11-19 (all day) → ?');
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

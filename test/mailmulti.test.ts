// MAILMULTI (docs/MAIL_ACCOUNTS.md): adding several Google (and other) accounts is obvious and safe.
// Route level on a real in-process server with a fake Google OAuth (the sign-in code names the
// person): signing in with a different Google address never replaces an account (it is added),
// the same address re-signs in place, the first "google" slot fills first, re-saving the same Google
// app keeps every sign-in, both Settings pages carry the one account list with "+ Add an account",
// and asking in the chat ("add another email account") gets a card that opens that page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { GOOGLE_CLIENT_VAULT, GOOGLE_TOKEN_VAULT, GoogleAccount } from '../src/google.ts';
import { GoogleAccounts, googleTokenVault } from '../src/google-accounts.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { MailOrganizer } from '../src/mail/organize.ts';
import { createMailTools } from '../src/tools/mail.ts';
import { cardFor } from '../src/cards.ts';
import { searchGuide } from '../src/settingsguide.ts';
import { createSaraServer } from '../src/server.ts';
import { DatabaseSync } from 'node:sqlite';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// Fake ids are built at run time (never realistic-looking secrets in the repo).
const fakeId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const CLIENT = `${fakeId('client')}.apps.googleusercontent.com`;
const PEOPLE: Record<string, string> = { alex: 'alex@example.com', work: 'alex@work.example', sam: 'sam@example.org', noprofile: '' };

/** A fake Google: token exchange by code (= the person), profile, revoke. */
function fakeGoogle() {
  const tokens = new Map<string, string>();
  const revoked: string[] = [];
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const who = new URLSearchParams(String(init.body)).get('code') ?? 'alex';
      const at = fakeId(`at-${who}`);
      tokens.set(at, who);
      return json(200, { access_token: at, expires_in: 3600, refresh_token: fakeId(`rt-${who}`), scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return (revoked.push(url), json(200, {}));
    const auth = String((init.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '');
    const who = tokens.get(auth);
    if (who === undefined) return json(401, { error: { message: 'bad token' } });
    if (url.endsWith('/users/me/profile')) return PEOPLE[who] ? json(200, { emailAddress: PEOPLE[who] }) : json(403, { error: { message: 'insufficient scope' } });
    return json(404, { error: { message: 'not found' } });
  }) as typeof fetch;
  return { f, revoked };
}

const tmp = tempDir();
const fg = fakeGoogle();
const app = makeApp(tmp.dir, { get now() { return new Date(); } });
const vault = app.vault;
vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: CLIENT, clientSecret: fakeId('GOCSPX') }));
const primary = new GoogleAccount(vault, { fetch: fg.f });
const googles = new GoogleAccounts(vault, primary, { fetch: fg.f });
const accounts = new MailAccounts(vault, primary, new MicrosoftAuth(vault, {}), { googles, viewFile: `${tmp.dir}/mail-view.json`, imap: { lookup: async () => { throw new Error('no network in tests'); } } });
Object.assign(app, { google: primary, googleAccounts: googles, mailAccounts: accounts });
const auth = new OwnerAuth(tmp.dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  app.store.close();
  tmp.cleanup();
});

async function api(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(base + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
/** The whole round trip: Connect (as the page sends it) → Google's account picker → /api/google/callback. */
async function signIn(who: string, body: Record<string, unknown> = {}): Promise<string> {
  const r = await api('/google/connect', 'POST', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const state = new URL(String(r.json.url)).searchParams.get('state')!;
  const back = await fetch(`${base}/api/google/callback?code=${who}&state=${encodeURIComponent(state)}`);
  const html = await back.text();
  return /#google=(\w+)/.exec(html)?.[1] ?? '';
}
const listed = async () => ((await api('/google')).json.accounts as { id: string; email: string | null }[]).map((a) => `${a.id}=${a.email}`);

test('Gmail and Calendar\'s plain "Sign in" with a different Google address adds it; the same address re-signs in place', async () => {
  assert.equal(await signIn('alex'), 'connected');
  assert.deepEqual(await listed(), ['google=alex@example.com']);
  const alexBefore = vault.get(GOOGLE_TOKEN_VAULT);

  // Hank's case: the first page's button (no `add`), signed in as another person: never replaces.
  assert.equal(await signIn('work'), 'added');
  assert.deepEqual(await listed(), ['google=alex@example.com', 'google:2=alex@work.example']);
  assert.equal(vault.get(GOOGLE_TOKEN_VAULT), alexBefore, 'the first account keeps its own sign-in');

  // The same address again (no add): renewed in place, nothing new.
  assert.equal(await signIn('alex'), 'connected');
  assert.deepEqual(await listed(), ['google=alex@example.com', 'google:2=alex@work.example']);
  assert.notEqual(vault.get(GOOGLE_TOKEN_VAULT), alexBefore, 'renewed');

  // "Sign in again" on the first account, but Google's picker chose the SECOND one: that one renews, the first stays.
  const workBefore = vault.get(googleTokenVault(2));
  const alexNow = vault.get(GOOGLE_TOKEN_VAULT);
  assert.equal(await signIn('work'), 'connected');
  assert.deepEqual(await listed(), ['google=alex@example.com', 'google:2=alex@work.example']);
  assert.equal(vault.get(GOOGLE_TOKEN_VAULT), alexNow);
  assert.notEqual(vault.get(googleTokenVault(2)), workBefore);
});

test('"+ Add an account" (add: true) and Reconnect on one row ({id}) never make duplicates or swap accounts', async () => {
  // Add with an address that is already there: renews it.
  assert.equal(await signIn('work', { add: true }), 'connected');
  assert.equal((await listed()).length, 2);
  // Add a new person.
  assert.equal(await signIn('sam', { add: true }), 'added');
  assert.deepEqual(await listed(), ['google=alex@example.com', 'google:2=alex@work.example', 'google:3=sam@example.org']);
  // Reconnect google:2, but the person picked alex in Google's picker: alex renews, google:2 keeps work.
  const work = vault.get(googleTokenVault(2));
  assert.equal(await signIn('alex', { id: 'google:2' }), 'connected');
  assert.equal(vault.get(googleTokenVault(2)), work);
  assert.deepEqual(await listed(), ['google=alex@example.com', 'google:2=alex@work.example', 'google:3=sam@example.org']);
  // Reconnect google:3 as a brand-new person: added, sam stays.
  assert.equal(await signIn('noprofile', { id: 'google:3' }), 'connected', 'no address readable: renews that row (can\'t tell)');
});

test('the first "google" slot: removed, then a sign-in for an address already listed renews that row instead of copying it', async () => {
  // Start clean for this order.
  for (const a of (await api('/google')).json.accounts as { id: string }[]) assert.equal((await api(`/google/accounts/${encodeURIComponent(a.id)}`, 'DELETE')).status, 200);
  assert.deepEqual(await listed(), []);
  assert.equal(await signIn('work', { add: true }), 'connected', 'no Google account: add fills the first slot');
  assert.deepEqual(await listed(), ['google=alex@work.example']);
  assert.equal(await signIn('alex', { add: true }), 'added');
  assert.deepEqual(await listed(), ['google=alex@work.example', 'google:2=alex@example.com']);
  // The first one goes; signing in as the second person through the plain button renews google:2 (no copy in slot 1).
  assert.equal((await api('/google/accounts/google', 'DELETE')).status, 200);
  assert.equal(await signIn('alex'), 'connected');
  assert.deepEqual(await listed(), ['google:2=alex@example.com']);
  // A new person through the plain button takes the empty first slot.
  assert.equal(await signIn('sam'), 'connected');
  assert.deepEqual(await listed(), ['google=sam@example.org', 'google:2=alex@example.com']);
  // Both are mailboxes she reads.
  assert.deepEqual(accounts.list().filter((a) => a.kind === 'google').map((a) => a.id), ['google', 'google:2']);
});

test('saving the same Google app again keeps every sign-in; a different app still starts over', async () => {
  const before = await listed();
  assert.equal(before.length, 2);
  const secret = fakeId('GOCSPX');
  assert.equal((await api('/google/client', 'PUT', { clientId: CLIENT, clientSecret: secret })).status, 200);
  assert.deepEqual(await listed(), before, 'same Client ID (a new secret): nothing lost');
  const other = `${fakeId('client2')}.apps.googleusercontent.com`;
  assert.equal((await api('/google/client', 'PUT', { clientId: other, clientSecret: secret })).status, 200);
  assert.deepEqual(await listed(), []);
  // Put the first app back for the next tests.
  assert.equal((await api('/google/client', 'PUT', { clientId: CLIENT, clientSecret: secret })).status, 200);
});

test('the mail accounts view lists every Google account with what it is used for', async () => {
  await signIn('alex');
  await signIn('work');
  const v = (await api('/mail/accounts')).json;
  const g = v.googleApp as { configured: boolean; multi: boolean; accounts: { id: string; email: string; gmail: boolean; calendar: boolean; docs: boolean }[] };
  assert.equal(g.configured, true);
  assert.equal(g.multi, true);
  assert.deepEqual(g.accounts.map((a) => [a.id, a.email, a.gmail, a.calendar, a.docs]), [['google', 'alex@example.com', true, true, false], ['google:2', 'alex@work.example', true, true, false]]);
});

test('both Settings pages carry the one account list with "+ Add an account"', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const page = (id: string) => html.slice(html.indexOf(`data-page="${id}"`), html.indexOf('</section>', html.indexOf(`data-page="${id}"`)));
  assert.match(page('ab-mail'), /id="ma-page"/);
  assert.match(page('ab-google'), /id="g-accounts"/);
  const js = readFileSync(join(ROOT, 'web/mail-accounts.js'), 'utf8');
  assert.match(js, /t\('\+ Add an account'\)/);
  for (const s of ["t('Google account')", "t('Gmail with an app password')", "t('Outlook or Microsoft 365')", "t('Another provider')", "t('Reconnect')", "t('Remove')"]) assert.ok(js.includes(s), s);
  assert.match(js, /export async function loadMailAccounts\(where/);
  const appJs = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  assert.match(appJs, /pick === 'ab-google'[^\n]*loadMailAccounts\('#g-accounts'\)/);
  // The first page's own Sign in button adds once someone is signed in (never re-signs the first account by surprise).
  assert.match(appJs, /api\('\/google\/connect', \{ method: 'POST', body: g\?\.connected \? \{ add: true \} : \{\} \}\)/);
});

test('chat: "add another email account" gets a link card to Email and calendar', async () => {
  const tools = createMailTools({ accounts, organizer: new MailOrganizer(new DatabaseSync(':memory:'), { timeZone: () => 'UTC' }), google: new Map(), timeZone: () => 'UTC' } as never);
  const add = tools.find((t) => t.spec.name === 'mail_add_account');
  assert.ok(add, 'a mail_add_account tool');
  assert.equal(add.isAvailable?.() ?? true, true, 'offered to the owner even with no mailbox yet');
  const out = String(await add.run({ kind: 'gmail' }, { signal: AbortSignal.timeout(5000) } as never));
  assert.match(out, /\(\/#view=settings:ab-mail\)/);
  assert.match(out, /alex@example\.com/);
  const card = cardFor({ name: 'mail_add_account', args: { kind: 'gmail' }, output: out, status: 'ok' } as never) as { kind: string; page: string; accounts: string[] } | undefined;
  assert.equal(card?.kind, 'open');
  assert.equal(card?.page, 'ab-mail');
  assert.ok(card?.accounts.includes('alex@example.com'));
  const rc = readFileSync(join(ROOT, 'web/result-cards.js'), 'utf8');
  assert.match(rc, /open: \(c\) => openCard\(c\)|open: openCard/);
  // The guide points the same way.
  assert.equal(searchGuide('add another email account', 1)[0]?.link, '/#view=settings:ab-mail');
  assert.equal(searchGuide('connect my other gmail', 1)[0]?.link, '/#view=settings:ab-mail');
});

// T62: which of the server's mailboxes, Google and Spotify another companion may use. The first
// companion uses all of them (unchanged); another uses none until the owner allows them.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { accessFor, ACCESS_FILE, CompanionAccessFile, gateGoogle, gateGoogles, gateMail, gateSpotify, NOT_ALLOWED, realOf } from '../src/companion-access.ts';
import { CompanionSettings, LinkedToolRegistry } from '../src/companions.ts';
import { GOOGLE_CLIENT_VAULT, GOOGLE_TOKEN_VAULT, GoogleAccount } from '../src/google.ts';
import { GoogleAccounts } from '../src/google-accounts.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { createSaraServer } from '../src/server.ts';
import { SPOTIFY_CLIENT_VAULT, SPOTIFY_TOKEN_VAULT, SpotifyAccount } from '../src/spotify.ts';
import { createGoogleTools } from '../src/tools/google.ts';
import { createSpotifyTools } from '../src/tools/spotify.ts';
import { Vault } from '../src/vault.ts';
import { calendarToday, mailToday } from '../src/today.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const { dir, cleanup } = tempDir();
mkdirSync(join(dir, 'v'), { recursive: true });
after(cleanup);
const vault = new Vault(join(dir, 'v'));
const calls: string[] = [];
const fakeFetch = (async (url: string | URL) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ items: [], messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: 'x.apps.googleusercontent.com', clientSecret: 's' }));
vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000, email: 'me@gmail.com', scopes: 'gmail.modify calendar.events auth/documents auth/spreadsheets' }));
vault.set(SPOTIFY_CLIENT_VAULT, JSON.stringify({ clientId: 'sp' }));
vault.set(SPOTIFY_TOKEN_VAULT, JSON.stringify({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000, name: 'Me' }));
const google = new GoogleAccount(vault, { fetch: fakeFetch });
const googles = new GoogleAccounts(vault, google);
const mail = new MailAccounts(vault, google, new MicrosoftAuth(vault), { googles });
const spotify = new SpotifyAccount(vault, { fetch: fakeFetch });

test('t62: the allow list starts empty and is kept in her own folder', () => {
  const cdir = join(dir, 'companions', 'mira');
  mkdirSync(cdir, { recursive: true });
  const f = new CompanionAccessFile(cdir);
  assert.deepEqual(f.get(), { mail: [], google: false, spotify: false });
  assert.deepEqual(f.set({ mail: ['google', 'google', 7 as never], google: true }), { mail: ['google'], google: true, spotify: false });
  assert.deepEqual(JSON.parse(readFileSync(join(cdir, ACCESS_FILE), 'utf8')), { mail: ['google'], google: true, spotify: false });
  assert.deepEqual(new CompanionAccessFile(cdir).get(), { mail: ['google'], google: true, spotify: false });
  assert.equal(accessFor(cdir), accessFor(cdir));
});

test('t62: her mailboxes, Gmail, Calendar and Spotify follow the list (nothing until allowed)', async () => {
  let acc = { mail: [] as string[], google: false, spotify: false };
  const of = () => acc;
  const m = gateMail(mail, of);
  const g = gateGoogle(google, of);
  const sp = gateSpotify(spotify, of);
  // The real accounts are unchanged (the first companion's).
  assert.equal(mail.list().length, 1);
  assert.equal(google.status().gmail, true);
  assert.equal(realOf(m), mail);
  assert.equal(realOf(g), google);

  assert.deepEqual(m.list(), []);
  assert.equal(m.default(), undefined);
  assert.throws(() => m.resolve(), /No mailbox is connected/);
  assert.deepEqual(m.googleAccounts(), []);
  assert.deepEqual(m.combined(), []);
  assert.equal(g.status().connected, false);
  assert.equal(g.status().email, undefined);
  assert.equal(sp.status().connected, false);
  assert.equal(sp.status().name, undefined);
  await assert.rejects(g.api('https://gmail.googleapis.com/gmail/v1/users/me/messages'), new RegExp(NOT_ALLOWED.slice(0, 20)));
  await assert.rejects(g.api('https://www.googleapis.com/calendar/v3/calendars/primary/events'));
  await assert.rejects(sp.api('/me/player'));
  // Her tools are not offered.
  for (const t of createGoogleTools(g, () => 'UTC')) assert.equal(t.isAvailable?.() ?? true, false, t.spec.name);
  for (const t of createSpotifyTools(sp)) assert.equal(t.isAvailable?.() ?? true, false, t.spec.name);
  assert.equal(calls.length, 0, 'nothing reached Google or Spotify');

  // Gmail allowed: her mailbox and the gmail tools, still no calendar.
  acc = { mail: ['google'], google: false, spotify: false };
  assert.deepEqual(m.list().map((x) => x.id), ['google']);
  assert.equal(m.resolve('gmail').id, 'google');
  assert.equal(m.default()?.id, 'google');
  assert.equal(g.status().gmail, true);
  assert.equal(g.status().calendar, false);
  assert.equal(g.status().docs, false);
  await g.api('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  await assert.rejects(g.api('https://docs.googleapis.com/v1/documents/x'));
  await assert.rejects(g.calendars());
  const names = createGoogleTools(g, () => 'UTC').filter((t) => t.isAvailable?.() ?? true).map((t) => t.spec.name);
  assert.ok(names.some((n) => n.startsWith('gmail_')) && !names.some((n) => n.startsWith('calendar_')));
  // Each later Google sign-in goes the same way.
  const gl = gateGoogles(googles, of);
  assert.deepEqual(gl.list().map((x) => x.id), ['google']);
  assert.equal(gl.get('google')?.status().calendar, false);

  // Google and Spotify allowed.
  acc = { mail: ['google'], google: true, spotify: true };
  assert.equal(g.status().calendar, true);
  await g.calendars();
  assert.equal(sp.status().connected, true);
  await sp.api('/me/player');
  assert.ok(createSpotifyTools(sp).some((t) => t.isAvailable?.() ?? true));

  // Taken away again: at once.
  acc = { mail: [], google: true, spotify: false };
  assert.deepEqual(m.list(), []);
  assert.equal(g.status().gmail, false);
  assert.equal(g.status().calendar, true);
  await assert.rejects(sp.api('/me/player'));
});

// ---- the owner's route ------------------------------------------------------------------------------

const clock = { now: new Date('2026-11-28T10:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const mainApp = makeApp(dir, clock);
mainApp.rootDir = dir;
mainApp.companionId = 'main';
mainApp.mailAccounts = mail;
mainApp.google = google;
mainApp.googleAccounts = googles;
mainApp.spotify = spotify;
const miraDir = join(dir, 'companions', 'mira2');
mkdirSync(miraDir, { recursive: true });
const mira: TestApp = makeApp(miraDir, clock);
mira.settings = new CompanionSettings(miraDir, mainApp.settings);
mira.tools = new LinkedToolRegistry(mainApp.tools);
mira.rootDir = dir;
mira.companionId = 'mira2';
const miraAccess = () => accessFor(miraDir).get();
mira.mailAccounts = gateMail(mail, miraAccess);
mira.google = gateGoogle(google, miraAccess);
mira.googleAccounts = gateGoogles(googles, miraAccess);
mira.spotify = gateSpotify(spotify, miraAccess);
const servers: Server[] = [];
const bases: Record<string, string> = {};
before(async () => {
  mainApp.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), setupDone: true });
  for (const [k, app, demo] of [['main', mainApp, false], ['mira', mira, false], ['demo', mira, true]] as const) {
    const s = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(demo ? { demo: true } : {}) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    bases[k] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
});
after(() => {
  for (const s of servers) s.close();
  mainApp.store.close();
  mira.store.close();
});
const call = (who: string, path: string, method = 'GET', body?: unknown) =>
  fetch(bases[who] + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

test('t62: Today reads no mail or calendar for her until allowed; the first companion as before', async () => {
  const before = calls.length;
  assert.equal(await mailToday(mira), undefined);
  assert.equal(await calendarToday(mira, clock.now, 'UTC'), undefined);
  assert.equal(calls.length, before, 'nothing was read for her');
  assert.notEqual(await mailToday(mainApp), undefined);
});

test('t62: the owner reads and sets her allow list; the first companion has none', async () => {
  const m0 = (await (await call('main', '/api/companion-access')).json()) as { main: boolean; access: unknown; mail: { id: string }[] };
  assert.equal(m0.main, true);
  assert.equal(m0.access, null);
  assert.equal((await call('main', '/api/companion-access', 'PUT', { google: true })).status, 400);

  const v0 = (await (await call('mira', '/api/companion-access')).json()) as { main: boolean; access: { mail: string[]; google: boolean; spotify: boolean }; mail: { id: string; address: string }[]; google: { connected: boolean }; spotify: { connected: boolean } };
  assert.equal(v0.main, false);
  assert.deepEqual(v0.access, { mail: [], google: false, spotify: false });
  assert.deepEqual(v0.mail.map((x) => x.address), ['me@gmail.com'], 'every server mailbox is offered to tick');
  assert.equal(v0.google.connected, true);
  assert.equal(v0.spotify.connected, true);
  assert.equal((await call('mira', '/api/companion-access', 'PUT', { mail: 'google' })).status, 400);

  const v1 = (await (await call('mira', '/api/companion-access', 'PUT', { mail: ['google'], spotify: true })).json()) as { access: { mail: string[]; google: boolean; spotify: boolean } };
  assert.deepEqual(v1.access, { mail: ['google'], google: false, spotify: true });
  assert.equal(mira.mailAccounts!.list().length, 1, 'enforced at once');
  assert.equal(mira.spotify!.status().connected, true);
  assert.ok(existsSync(join(miraDir, ACCESS_FILE)));

  // The connections page manages the server's real accounts from any companion.
  const g = (await (await call('mira', '/api/google')).json()) as { connected: boolean; calendar: boolean };
  assert.equal(g.connected, true);
  assert.equal(g.calendar, true);

  // Never on the demo.
  assert.equal((await call('demo', '/api/companion-access')).status, 403);
  assert.equal((await call('demo', '/api/companion-access', 'PUT', { google: true })).status, 403);
});

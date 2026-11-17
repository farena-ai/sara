// HANKFIX (docs/handoffs/2026-11-16-hankfix.md): "adding a second Gmail account replaced the first".
// The real route (POST /api/mail/imap on an in-process server) adds two Gmail mailboxes with app
// passwords; both must stay listed, in every order with a Google sign-in, and after a restart.
// The IMAP/SMTP sign-in check is stubbed (the Gmail preset's fixed ports can't reach a loopback
// stand-in); everything after it (draft, save, vault, list, view) is real.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { GOOGLE_CLIENT_VAULT, GoogleAccount } from '../src/google.ts';
import { GoogleAccounts } from '../src/google-accounts.ts';
import { MailAccounts } from '../src/mail/accounts.ts';
import { MicrosoftAuth } from '../src/mail/graph.ts';
import { ImapMail } from '../src/mail/imap.ts';
import { createSaraServer } from '../src/server.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const fakeId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const pw = () => `${fakeId('app')}${fakeId('pw')}`.replace(/[^a-z0-9]/g, '').slice(0, 16);

// The sign-in check: every address signs in (no network).
const proto = ImapMail.prototype as unknown as { test: () => Promise<string>; testSmtp: () => Promise<void> };
const realTest = proto.test;
const realSmtp = proto.testSmtp;
proto.test = async () => 'Signed in. 3 emails in the inbox.';
proto.testSmtp = async () => undefined;
after(() => {
  proto.test = realTest;
  proto.testSmtp = realSmtp;
});

/** A fake Google that signs in whoever the code names. */
function fakeGoogle(people: Record<string, string>) {
  const tokens = new Map<string, string>();
  const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const who = new URLSearchParams(String(init.body)).get('code') ?? '';
      const at = fakeId(`at-${who}`);
      tokens.set(at, who);
      return json(200, { access_token: at, expires_in: 3600, refresh_token: fakeId('rt'), scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events' });
    }
    const auth = String((init.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '');
    const email = people[tokens.get(auth) ?? ''];
    if (!email) return json(401, { error: { message: 'bad token' } });
    if (url.endsWith('/users/me/profile')) return json(200, { emailAddress: email });
    return json(200, {});
  }) as typeof fetch;
}

async function serve(withGoogle: boolean) {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, { now: new Date() });
  const vault = app.vault as Vault;
  let googles: GoogleAccounts | undefined;
  let primary: GoogleAccount | undefined;
  if (withGoogle) {
    const f = fakeGoogle({ first: 'hank.first@gmail.com', second: 'hank.second@gmail.com' });
    vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId: `${fakeId('client')}.apps.googleusercontent.com`, clientSecret: fakeId('GOCSPX') }));
    primary = new GoogleAccount(vault, { fetch: f });
    googles = new GoogleAccounts(vault, primary, { fetch: f });
    app.google = primary;
    app.googleAccounts = googles;
  }
  const make = () => new MailAccounts(vault, primary, new MicrosoftAuth(vault, {}), { ...(googles ? { googles } : {}), viewFile: join(tmp.dir, 'mail-view.json') });
  app.mailAccounts = make();
  const auth = new OwnerAuth(tmp.dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const addGmail = async (address: string) => {
    const r = await call('POST', '/api/mail/imap', { preset: 'gmail', address, password: pw() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const googleSignIn = async (who: string, add: boolean) => {
    const url = new URL(googles!.authUrl('https://sara.example.com/api/google/callback', { add }));
    return googles!.finish(who, url.searchParams.get('state')!);
  };
  const addresses = async () => ((await call('GET', '/api/mail/accounts')).json.accounts as { address: string }[]).map((a) => a.address).sort();
  /** Starts over on the same data (a restart): a fresh MailAccounts and a fresh vault read. */
  const restart = () => {
    app.mailAccounts = new MailAccounts(new Vault(tmp.dir), primary, new MicrosoftAuth(vault, {}), { ...(googles ? { googles } : {}), viewFile: join(tmp.dir, 'mail-view.json') });
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    app.store.close();
    tmp.cleanup();
  };
  return { app, call, addGmail, googleSignIn, addresses, restart, close };
}

test('two Gmail app-password mailboxes through the real route: both stay, also after a restart', async () => {
  const s = await serve(false);
  try {
    const first = await s.addGmail('hank.first@gmail.com');
    const second = await s.addGmail('hank.second@gmail.com');
    assert.notEqual(first.added, second.added, 'two accounts, two ids');
    assert.deepEqual(await s.addresses(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
    s.restart();
    assert.deepEqual(await s.addresses(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
  } finally {
    await s.close();
  }
});

test('Google sign-in, then a Gmail app password for another address: both stay', async () => {
  const s = await serve(true);
  try {
    await s.googleSignIn('first', false);
    await s.addGmail('hank.second@gmail.com');
    assert.deepEqual(await s.addresses(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
  } finally {
    await s.close();
  }
});

test('a Gmail app password, then a Google sign-in for another address: both stay', async () => {
  const s = await serve(true);
  try {
    await s.addGmail('hank.first@gmail.com');
    await s.googleSignIn('second', false);
    assert.deepEqual(await s.addresses(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
  } finally {
    await s.close();
  }
});

test('the vault: a second copy of it (another process, an old instance) never writes back a stale list', () => {
  const tmp = tempDir();
  try {
    const a = new Vault(tmp.dir);
    const b = new Vault(tmp.dir); // read before the first mailbox was added
    const first = new MailAccounts(a, undefined, new MicrosoftAuth(a, {}), {});
    first.saveImap(first.imapDraft({ preset: 'gmail', address: 'hank.first@gmail.com', password: pw() }).info, pw());
    // The other copy adds the second mailbox: the first one stays.
    const second = new MailAccounts(b, undefined, new MicrosoftAuth(b, {}), {});
    second.saveImap(second.imapDraft({ preset: 'gmail', address: 'hank.second@gmail.com', password: pw() }).info, pw());
    assert.deepEqual(second.list().map((x) => x.address).sort(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
    // Any later write through the first copy keeps the second mailbox too.
    a.set('unrelated', 'x');
    assert.deepEqual(new MailAccounts(new Vault(tmp.dir), undefined, new MicrosoftAuth(new Vault(tmp.dir), {}), {}).list().map((x) => x.address).sort(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
    assert.equal(first.list().length, 2, 'the first copy reads the newer list');
  } finally {
    tmp.cleanup();
  }
});

test('the same Gmail address again: its sign-in is updated in place (same id, first added date), and the route says so', async () => {
  const s = await serve(false);
  try {
    const one = await s.addGmail('hank.first@gmail.com');
    await s.addGmail('hank.second@gmail.com');
    const again = await s.addGmail('Hank.First@gmail.com');
    // In place: the first stays first (and so stays the default mailbox).
    const view = (await s.call('GET', '/api/mail/accounts')).json;
    assert.deepEqual(view.accounts.map((a: { address: string }) => a.address), ['hank.first@gmail.com', 'hank.second@gmail.com']);
    assert.equal(view.default, one.added);
    assert.equal(again.added, one.added, 'the same account, not a new one');
    assert.equal(again.replaced, true);
    assert.equal(one.replaced, undefined);
    assert.deepEqual(await s.addresses(), ['hank.first@gmail.com', 'hank.second@gmail.com']);
    const vault = s.app.vault as Vault;
    assert.equal(vault.values().filter((v) => v.length === 16 && /^[a-z0-9]+$/.test(v)).length, 2, 'the old app password is gone (one per mailbox)');
  } finally {
    await s.close();
  }
});

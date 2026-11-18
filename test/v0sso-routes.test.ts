// V0.8: OpenID Connect sign-in over HTTP (src/routes/sso.ts) on a throwaway in-process server.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { HouseholdStore } from '../src/household.ts';
import { createSaraServer, type HouseholdHooks } from '../src/server.ts';
import { fakeOidc } from './fixtures/fake-oidc.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith(name + '='))?.slice(name.length + 1);

test('V0.8 routes: owner and member sign in with the provider; token and logout keep working', { timeout: 60_000 }, async (t) => {
  const { dir, cleanup } = tempDir();
  const idp = await fakeOidc();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const store = new HouseholdStore(dir);
  const { code } = store.invite({ name: 'Bo', hours: 1, confirm18: true, limits: { models: [{ providerId: 'fake', model: 'fake-model' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } });
  const bo = store.redeem(code, true).member;
  mkdirSync(join(dir, 'bo-space'));
  const boAuth = new OwnerAuth(join(dir, 'bo-space'));
  const household: HouseholdHooks = {
    store, models: () => [], join: async () => { throw new Error('no'); }, usage: () => null, deleteNow: async () => {}, signOutAll: () => {},
    sessionFor: (id, label) => (id === bo.id ? boAuth.createSession(label) : undefined),
  };
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), household });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await idp.close(); app.store.close(); cleanup(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json', origin };
  const json = { 'content-type': 'application/json', origin };

  // Off by default: no button, start refused, settings owner-only.
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).sso, undefined);
  assert.equal((await fetch(`${origin}/api/sso`)).status, 401);
  assert.equal((await fetch(`${origin}/api/sso/start`, { method: 'POST', headers: json, body: '{}' })).status, 400);

  const view = await (await fetch(`${origin}/api/sso`, { headers: owner })).json();
  assert.equal(view.redirectUrl, `${origin}/api/sso/callback`, 'the exact redirect URL to paste, before anything is saved');
  const bad = await fetch(`${origin}/api/sso`, { method: 'PUT', headers: owner, body: JSON.stringify({ issuer: 'ftp://x' }) });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /issuer URL must start with https/);
  const saved = await fetch(`${origin}/api/sso`, { method: 'PUT', headers: owner, body: JSON.stringify({
    enabled: true, preset: 'authentik', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin, label: 'Home login',
    people: { owner: { emails: ['alice@example.com'], groups: [] }, [bo.id]: { emails: ['bob@example.com'], groups: [] } },
  }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const sv = await saved.json();
  assert.equal(sv.secretSaved, true); assert.equal(JSON.stringify(sv).includes(idp.clientSecret), false, 'the secret never comes back');
  assert.deepEqual((await (await fetch(`${origin}/api/session`)).json()).sso, { enabled: true, label: 'Home login' });
  assert.deepEqual(await (await fetch(`${origin}/api/sso/check`, { method: 'POST', headers: owner, body: '{}' })).json(), { ok: true, keys: 1, endSession: true });
  const preview = await (await fetch(`${origin}/api/sso/preview`, { method: 'POST', headers: owner, body: JSON.stringify({ email: 'bob@example.com', groups: [] }) })).json();
  assert.equal(preview.person.name, 'Bo');

  async function signIn(sub: string) {
    const start = await fetch(`${origin}/api/sso/start`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(start.status, 200);
    const binding = cookieOf(start, 'sara_sso')!; assert.ok(binding);
    assert.match(start.headers.getSetCookie()[0], /SameSite=Lax/);
    const back = idp.approve((await start.json()).url, sub);
    assert.ok(back.startsWith(`${origin}/api/sso/callback?`));
    // The provider's redirect: a cross-site navigation with only the Lax binding cookie.
    const cb = await fetch(back, { redirect: 'manual', headers: { cookie: `sara_sso=${binding}`, 'sec-fetch-site': 'cross-site' } });
    assert.equal(cb.status, 303);
    return cb;
  }
  const cb = await signIn('alice');
  assert.equal(cb.headers.get('location'), '/?sso=done');
  const ticket = cookieOf(cb, 'sara_sso_t')!; assert.ok(ticket);
  const fin = await fetch(`${origin}/api/sso/finish`, { method: 'POST', headers: { ...json, cookie: `sara_sso_t=${ticket}` }, body: '{}' });
  assert.equal(fin.status, 200, await fin.clone().text());
  const session = cookieOf(fin, 'sara_session')!; assert.ok(session);
  const me = await (await fetch(`${origin}/api/session`, { headers: { cookie: `sara_session=${session}` } })).json();
  assert.equal(me.authenticated, true); assert.equal(me.role, 'owner');
  assert.equal((await fetch(`${origin}/api/sso/finish`, { method: 'POST', headers: { ...json, cookie: `sara_sso_t=${ticket}` }, body: '{}' })).status, 401, 'a ticket works once');
  const out = await (await fetch(`${origin}/api/logout`, { method: 'POST', headers: { ...json, cookie: `sara_session=${session}` }, body: '{}' })).json();
  assert.ok(String(out.endSession).startsWith(`${idp.issuer}/logout?`), 'sign-out offers the provider’s own sign-out');
  assert.equal((await fetch(`${origin}/api/sso`, { headers: owner })).status, 200, 'the owner token always keeps working');

  // A member signs in into their own space.
  const mcb = await signIn('bob');
  const mfin = await fetch(`${origin}/api/sso/finish`, { method: 'POST', headers: { ...json, cookie: `sara_sso_t=${cookieOf(mcb, 'sara_sso_t')}` }, body: '{}' });
  assert.equal(mfin.status, 200);
  const mval = decodeURIComponent(cookieOf(mfin, 'sara_session')!);
  assert.ok(boAuth.verifySession(mval), 'the cookie belongs to the member’s space'); assert.equal(auth.verifySession(mval), false);

  // Strangers get a plain reason, and a wrong binding is refused.
  assert.equal((await signIn('eve')).headers.get('location'), '/?sso=no_account');
  const start = await fetch(`${origin}/api/sso/start`, { method: 'POST', headers: json, body: '{}' });
  const back = idp.approve((await start.json()).url, 'alice');
  assert.equal((await fetch(back, { redirect: 'manual', headers: { cookie: 'sara_sso=wrong' } })).headers.get('location'), '/?sso=state');

  // Test sign-in: signs nobody in, the owner reads the result.
  const ts = await fetch(`${origin}/api/sso/test`, { method: 'POST', headers: owner, body: '{}' });
  const tb = idp.approve((await ts.json()).url, 'bob');
  const tcb = await fetch(tb, { redirect: 'manual', headers: { cookie: `sara_sso=${cookieOf(ts, 'sara_sso')}` } });
  assert.equal(tcb.headers.get('location'), '/?sso-test=done'); assert.equal(cookieOf(tcb, 'sara_sso_t'), undefined);
  const tr = (await (await fetch(`${origin}/api/sso/test-result`, { headers: owner })).json()).result;
  assert.equal(tr.ok, true); assert.equal(tr.who, 'Bo'); assert.equal(tr.email, 'bob@example.com');
  assert.equal((await (await fetch(`${origin}/api/sso/unlink`, { method: 'POST', headers: owner, body: JSON.stringify({ person: 'owner' }) })).json()).removed, 1);
});

test('V0.8 routes: not offered in the demo', { timeout: 30_000 }, async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); app.store.close(); cleanup(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await fetch(`${origin}/api/sso/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
  assert.notEqual(r.status, 200);
});

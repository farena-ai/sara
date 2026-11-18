// V0.8: OpenID Connect sign-in for every server (src/home-sso.ts) against the fake in-process provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claimFacts, decideSignIn, HomeSso, redirectFor, SsoInputError, type HomeSsoConfig, type SsoPerson } from '../src/home-sso.ts';
import { Vault } from '../src/vault.ts';
import { fakeOidc, type FakeOidc } from './fixtures/fake-oidc.ts';
import { tempDir } from './helpers.ts';

const ORIGIN = 'http://127.0.0.1:7999';
const people: SsoPerson[] = [
  { id: 'owner', name: 'Alex', role: 'owner', active: true },
  { id: 'm1', name: 'Bo', role: 'member', active: true },
  { id: 'k1', name: 'Kit', role: 'kid', active: true },
  { id: 'm2', name: 'Paused', role: 'member', active: false },
];
const base = (over: Partial<HomeSsoConfig> = {}): HomeSsoConfig => ({
  enabled: true, preset: 'generic', issuer: 'https://idp.test', clientId: 'c', origin: ORIGIN, label: '', groupClaim: 'groups', skewSeconds: 60,
  people: {}, roleGroups: { owner: [], member: [], kid: [] }, jit: { on: false, adults: false, emails: [], groups: [] }, ...over,
});
const facts = (email: string | undefined, groups: string[] = [], verified = true) => ({ ...(email ? { email } : {}), verified, groups, name: 'X' });

test('V0.8 mapping: email, group, owner role group, link, kid and paused accounts', () => {
  const cfg = base({ people: { owner: { emails: ['alex@home.test'], groups: [] }, m1: { emails: [], groups: ['family'] }, k1: { emails: ['kit@home.test'], groups: [] } } });
  const who = (d: ReturnType<typeof decideSignIn>) => (d.ok ? ('person' in d ? `${d.person.id}/${d.by}` : `create/${d.by}`) : `no:${d.reason}`);
  assert.equal(who(decideSignIn(cfg, people, undefined, facts('ALEX@home.test'.toLowerCase()))), 'owner/email');
  assert.equal(who(decideSignIn(cfg, people, undefined, facts('alex@home.test', [], false))), 'no:no_account', 'an unverified email never matches');
  assert.equal(who(decideSignIn(cfg, people, undefined, facts('x@y.test', ['family']))), 'm1/group');
  assert.equal(who(decideSignIn(cfg, people, 'k1', facts(undefined))), 'k1/link');
  assert.equal(who(decideSignIn(cfg, people, 'm2', facts(undefined))), 'no:disabled');
  assert.equal(who(decideSignIn(cfg, people, undefined, facts('stranger@y.test'))), 'no:no_account', 'nobody maps to the owner by default');
  const roles = base({ ...cfg, roleGroups: { owner: ['admins'], member: ['family'], kid: ['kids'] } });
  assert.equal(who(decideSignIn(roles, people, undefined, facts('s@y.test', ['admins']))), 'owner/role', 'owner group maps to the owner');
  assert.equal(who(decideSignIn(roles, people, undefined, facts('kit@home.test', []))), 'no:group', 'a kid must be in a kid group once one is set');
  assert.equal(who(decideSignIn(roles, people, undefined, facts('kit@home.test', ['kids']))), 'k1/email');
});

test('V0.8 just-in-time members: off by default, allow-list only, adults only, never kids', () => {
  const off = base();
  assert.deepEqual(decideSignIn(off, people, undefined, facts('new@y.test', ['family'])), { ok: false, reason: 'no_account' });
  const on = base({ jit: { on: true, adults: true, emails: ['new@y.test'], groups: ['guests'] }, roleGroups: { owner: [], member: [], kid: ['kids'] } });
  const d = decideSignIn(on, people, undefined, { email: 'new@y.test', verified: true, groups: [], name: 'Newt' });
  assert.deepEqual(d, { ok: true, create: { name: 'Newt', role: 'member' }, by: 'jit' });
  assert.equal(decideSignIn(on, people, undefined, facts('other@y.test', ['guests'])).ok, true, 'allowed group');
  assert.deepEqual(decideSignIn(on, people, undefined, facts('other@y.test')), { ok: false, reason: 'no_account' });
  assert.deepEqual(decideSignIn(on, people, undefined, facts('new@y.test', [], false)), { ok: false, reason: 'email' }, 'unverified email is not on the list');
  assert.deepEqual(decideSignIn(on, people, undefined, facts('new@y.test', ['kids'])), { ok: false, reason: 'group' }, 'kids are never made automatically');
  assert.deepEqual(decideSignIn({ ...on, jit: { ...on.jit, adults: false } }, people, undefined, facts('new@y.test')), { ok: false, reason: 'no_account' });
});

test('V0.8 claim facts: Entra preferred_username, group claim name, name fallback', () => {
  assert.deepEqual(claimFacts({ groupClaim: 'roles', preset: 'entra' }, { preferred_username: 'Pat@Corp.test', roles: ['a', 7, 'b'] }), { email: 'pat@corp.test', verified: true, groups: ['a', 'b'], name: 'pat' });
  assert.equal(claimFacts({ groupClaim: 'groups', preset: 'generic' }, { preferred_username: 'pat@corp.test' }).email, undefined);
  assert.equal(claimFacts({ groupClaim: 'groups', preset: 'generic' }, { email: 'a@b.test', email_verified: false }).verified, false);
});

function rig(idp: FakeOidc, dir: string, list = people) {
  const vault = new Vault(dir);
  const sso = new HomeSso({ dataDir: dir, vault, people: () => list });
  return { sso, vault };
}
async function roundTrip(idp: FakeOidc, sso: HomeSso, sub: string, o: { test?: boolean; confirm18?: boolean } = {}) {
  const { url, binding } = await sso.start(o);
  const back = new URL(idp.approve(url, sub));
  return sso.callback(back.searchParams, binding);
}

test('V0.8 settings: validation, secret in the vault, enable needs everything, redirect URL', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const { sso, vault } = rig(idp, dir);
  assert.equal(sso.status().enabled, false, 'off by default');
  assert.throws(() => sso.save({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, origin: ORIGIN }), SsoInputError, 'no secret yet');
  assert.throws(() => sso.save({ issuer: 'http://idp.example.test' }), SsoInputError, 'plain http only on loopback');
  assert.throws(() => sso.save({ jit: { on: true, adults: false } }), SsoInputError, 'JIT needs the 18+ confirmation');
  assert.throws(() => sso.save({ people: { owner: { emails: ['a@b.test'] }, m1: { emails: ['a@b.test'] } } }), SsoInputError, 'one email, one person');
  assert.throws(() => sso.save({ nope: 1 }), SsoInputError);
  const secret = idp.clientSecret;
  const v = sso.save({ enabled: true, preset: 'keycloak', issuer: idp.issuer, clientId: idp.clientId, clientSecret: secret, origin: ORIGIN + '/some/path', label: 'Family login', people: { owner: { emails: ['Alice@Example.com'], groups: [] } } });
  assert.equal(v.redirectUrl, `${ORIGIN}/api/sso/callback`); assert.equal(v.origin, ORIGIN);
  assert.equal(v.secretSaved, true); assert.equal('clientSecret' in v, false);
  assert.equal(vault.get('sso:client-secret'), secret);
  assert.equal(readFileSync(join(dir, 'sso.json'), 'utf8').includes(secret), false, 'the secret is never in sso.json');
  assert.deepEqual(v.people.find(p => p.id === 'owner')!.emails, ['alice@example.com']);
  assert.deepEqual(sso.status(), { enabled: true, label: 'Family login' });
  assert.equal(redirectFor('https://sara.home.test/'), 'https://sara.home.test/api/sso/callback');
  const check = await sso.check();
  assert.deepEqual(check, { ok: true, keys: 1, endSession: true });
});

test('V0.8 round trip: owner by email, ticket once, PKCE/state/nonce, link reused, logout URL', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const { sso } = rig(idp, dir);
  sso.save({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin: ORIGIN, people: { owner: { emails: ['alice@example.com'], groups: [] }, m1: { emails: [], groups: ['sara-users'] } } });
  const r = await roundTrip(idp, sso, 'alice');
  assert.ok('ticket' in r, JSON.stringify(r));
  const form = idp.tokenCalls.at(-1)!; assert.ok(form.code_verifier, 'PKCE verifier sent');
  const f = sso.finish(r.ticket)!;
  assert.deepEqual(f.target, { person: people[0] });
  assert.equal(sso.finish(r.ticket), undefined, 'a ticket works once');
  f.complete('owner', 'owner', 'sid-1');
  assert.equal(sso.view().people.find(p => p.id === 'owner')!.linked, 1);
  // A member by group.
  const b = await roundTrip(idp, sso, 'bob');
  assert.ok('ticket' in b); assert.equal((sso.finish(b.ticket)!.target as { person: SsoPerson }).person.id, 'm1');
  // State: wrong binding, unknown state, replayed callback.
  const { url } = await sso.start();
  const back = new URL(idp.approve(url, 'alice'));
  assert.deepEqual(await sso.callback(back.searchParams, 'not-the-binding'), { reason: 'state' });
  assert.deepEqual(await sso.callback(back.searchParams, 'x'), { reason: 'state' }, 'a state works once');
  // Nonce and issuer checks come from the protocol layer.
  idp.tamper = { nonce: 'other' };
  assert.deepEqual(await roundTrip(idp, sso, 'alice'), { reason: 'failed' });
  idp.tamper = { iss: 'https://evil.test' };
  assert.deepEqual(await roundTrip(idp, sso, 'alice'), { reason: 'failed' });
  idp.tamper = {};
  // Refused at the provider.
  const d = await sso.start(); const denied = new URL(idp.approve(d.url, 'nobody'));
  assert.deepEqual(await sso.callback(denied.searchParams, d.binding), { reason: 'denied' });
  // Logout: the provider's end-session page for sessions that came from it, nothing for others.
  const end = await sso.signedOut('owner', 'sid-1');
  assert.ok(end?.startsWith(`${idp.issuer}/logout?`), end);
  assert.equal(new URL(end!).searchParams.get('post_logout_redirect_uri'), ORIGIN + '/');
  assert.equal(await sso.signedOut('owner', 'sid-1'), undefined, 'once');
  assert.equal(await sso.signedOut('owner', 'token-session'), undefined);
});

test('V0.8 key rotation, clock skew and a second account with the same email', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const { sso } = rig(idp, dir);
  sso.save({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin: ORIGIN, skewSeconds: 30, people: { owner: { emails: ['alice@example.com'], groups: [] } } });
  const first = await roundTrip(idp, sso, 'alice'); assert.ok('ticket' in first);
  sso.finish(first.ticket)!.complete('owner', 'owner', 's1');
  const fetches = idp.jwksFetches;
  idp.rotate('ES256', true);
  const again = await roundTrip(idp, sso, 'alice');
  assert.ok('ticket' in again, 'a new signing key is fetched once (JWKS refresh)'); assert.equal(idp.jwksFetches, fetches + 1);
  idp.tamper = { iatShift: 20 };
  assert.ok('ticket' in (await roundTrip(idp, sso, 'alice')), 'within the 30 s skew');
  idp.tamper = { iatShift: 90 };
  assert.deepEqual(await roundTrip(idp, sso, 'alice'), { reason: 'failed' }, 'beyond the skew');
  idp.tamper = {};
  // Another provider account claiming the owner's email does not take over the linked owner.
  idp.users.set('mallory', { sub: 'mallory', email: 'alice@example.com', email_verified: true, name: 'M' });
  assert.deepEqual(await roundTrip(idp, sso, 'mallory'), { reason: 'linked' });
  assert.equal(sso.unlink('owner'), 1);
  assert.ok('ticket' in (await roundTrip(idp, sso, 'mallory')), 'after Unlink the owner decides again');
});

test('V0.8 Test sign-in: works before turning on, signs nobody in, reports plainly', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const { sso } = rig(idp, dir);
  await assert.rejects(sso.start({ test: true }), SsoInputError, 'needs issuer, client and secret');
  sso.save({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin: ORIGIN, people: { m1: { emails: ['bob@example.com'], groups: [] } } });
  await assert.rejects(sso.start(), SsoInputError, 'real sign-in is off');
  assert.deepEqual(await roundTrip(idp, sso, 'bob', { test: true }), { test: true });
  const r = sso.testResult()!;
  assert.equal(r.ok, true); assert.equal(r.who, 'Bo'); assert.equal(r.role, 'member'); assert.equal(r.by, 'email'); assert.deepEqual(r.groups, ['sara-users']);
  assert.equal(sso.view().people.find(p => p.id === 'm1')!.linked, 0, 'a test links nobody');
  await roundTrip(idp, sso, 'eve', { test: true });
  assert.equal(sso.testResult()!.reason, 'no_account');
  idp.clientSecret = 'rotated-at-the-provider';
  await roundTrip(idp, sso, 'bob', { test: true });
  assert.equal(sso.testResult()!.reason, 'client', 'a wrong client secret is named');
  // The preview needs no provider at all.
  assert.deepEqual(sso.preview({ email: 'BOB@example.com', groups: [] }), { ok: true, person: people[1], by: 'email' });
});

test('V0.8 JIT needs the person\'s 18+ confirmation at sign-in', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const { sso } = rig(idp, dir);
  sso.save({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin: ORIGIN, jit: { on: true, adults: true, emails: ['eve@other.test'], groups: [] } });
  assert.deepEqual(sso.status(), { enabled: true, label: '', jit: true });
  assert.deepEqual(await roundTrip(idp, sso, 'eve'), { reason: 'adult' });
  const r = await roundTrip(idp, sso, 'eve', { confirm18: true });
  assert.ok('ticket' in r);
  assert.deepEqual(sso.finish(r.ticket)!.target, { create: { name: 'Eve Outsider', role: 'member' } });
});

test('V0.8 a person suspended between callback and finish is not signed in', async (t) => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const idp = await fakeOidc(); t.after(() => idp.close());
  const list = people.map(p => ({ ...p }));
  const { sso } = rig(idp, dir, list);
  sso.save({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, origin: ORIGIN, people: { m1: { emails: ['bob@example.com'], groups: [] } } });
  const r = await roundTrip(idp, sso, 'bob'); assert.ok('ticket' in r);
  list[1].active = false;
  assert.equal(sso.finish(r.ticket), undefined);
});

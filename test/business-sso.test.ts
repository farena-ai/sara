// EC2: single sign-on for business instances, end to end over HTTP against a local fake IdP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { Vault } from '../src/vault.ts';
import type { BusinessSession } from '../src/business/identity.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';
import { contentFixture } from './helpers/business-content.ts';
import { fakeOidc, type FakeOidc } from './fixtures/fake-oidc.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type Fixture = Awaited<ReturnType<typeof contentFixture>>;
const SECRET_CANARY = 'fake-client-secret-0123456789';

async function setup(config: Record<string, unknown> = {}) {
  const idp = await fakeOidc();
  const f = await contentFixture();
  const base = { enabled: true, preset: 'generic', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedDomains: ['example.com'], groupClaim: 'groups', adminGroups: [], memberGroups: [], jit: false, enforce: false, sessionHours: 12, checkMinutes: 15 };
  const saved = await f.request('/api/business/sso/config', f.admin, { ...base, ...config });
  assert.equal(saved.status, 200, await saved.clone().text());
  return { idp, f, async close() { await f.close(); await idp.close(); } };
}

/** An anonymous browser: start, approve at the IdP, follow the redirect back to Sara. */
async function signIn(f: Fixture, idp: FakeOidc, sub: string, body: Record<string, unknown> = {}, opts: { session?: BusinessSession; mutate?: (callback: URL) => void; dropBinding?: boolean } = {}) {
  const start = await fetch(f.runtime.origin + '/api/business/sso/start', { method: 'POST', headers: { origin: f.runtime.origin, 'content-type': 'application/json', ...(opts.session ? { cookie: `sara_business_session=${opts.session.value}` } : {}) }, body: JSON.stringify(body) });
  assert.equal(start.status, 200, await start.clone().text());
  const { url } = await start.json() as { url: string };
  const binding = start.headers.getSetCookie().find(c => c.startsWith('sara_business_sso='))!;
  assert.match(binding, /HttpOnly/); assert.match(binding, /SameSite=Lax/);
  const back = new URL(idp.approve(url, sub)); opts.mutate?.(back);
  assert.equal(back.origin + back.pathname, f.runtime.origin + '/api/business/sso/callback');
  const callback = await fetch(back, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site', ...(opts.dropBinding ? {} : { cookie: binding.split(';')[0] }) } });
  const cookie = callback.headers.getSetCookie().find(c => c.startsWith('sara_business_session=') && !c.startsWith('sara_business_session=;'));
  return { status: callback.status, location: callback.headers.get('location') ?? '', cookie, value: cookie ? cookie.split(';')[0].slice('sara_business_session='.length) : undefined, raw: cookie, url };
}
const me = (f: Fixture, value: string) => fetch(f.runtime.origin + '/api/business/me', { headers: { cookie: `sara_business_session=${value}` } });
const audit = (f: Fixture) => f.runtime.control.database.prepare("SELECT action FROM business_audit WHERE action LIKE 'sso.%' ORDER BY id").all().map(r => String(r.action));
const orgInvite = (f: Fixture, role = 'user') => f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role, subject: 'new' }).code;

test('sso: personal instances have no single sign-on route', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() }); const auth = new OwnerAuth(dir); const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/api/business/sso/status', '/api/business/sso/callback?code=x&state=y', '/api/business/sso/config']) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
      assert.ok([404, 401].includes(response.status) && !response.headers.get('location'), `${path} -> ${response.status}`);
    }
  } finally { server.close(); app.store.close(); cleanup(); }
});

test('sso: off by default; admin-only settings; the client secret is write-only and kept in the operator Vault', async () => {
  const idp = await fakeOidc(); const f = await contentFixture();
  try {
    assert.deepEqual(await (await fetch(f.runtime.origin + '/api/business/sso/status')).json(), { enabled: false });
    const member = f.add('Morgan');
    assert.equal((await f.request('/api/business/sso/config', member)).status, 403);
    assert.equal((await f.request('/api/business/sso/config', member, { enabled: false })).status, 403);
    assert.equal((await fetch(f.runtime.origin + '/api/business/sso/config')).status, 401);
    const empty = await (await f.request('/api/business/sso/config')).json();
    assert.equal(empty.enabled, false); assert.equal(empty.jit, false, 'JIT is off by default'); assert.equal(empty.enforce, false);
    assert.equal(empty.redirectUrl, f.runtime.origin + '/api/business/sso/callback');
    const bad = [{ issuer: 'http://idp.example.com' }, { allowedDomains: ['*.example.com'] }, { sessionHours: 0 }, { sessionHours: 1000 }, { checkMinutes: 1 }, { preset: 'ldap' }, { extra: true }, { enforce: true, enabled: false }];
    const good = { enabled: true, preset: 'okta', issuer: idp.issuer, clientId: idp.clientId, clientSecret: SECRET_CANARY, allowedDomains: ['Example.com'], groupClaim: 'groups', adminGroups: ['sara-admins'], memberGroups: [], jit: false, enforce: false, sessionHours: 8, checkMinutes: 15 };
    for (const change of bad) assert.equal((await f.request('/api/business/sso/config', f.admin, { ...good, ...change })).status, 400, JSON.stringify(change));
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...good, clientSecret: undefined })).status, 400, 'enabling needs a saved secret');
    const saved = await f.request('/api/business/sso/config', f.admin, good); assert.equal(saved.status, 200);
    const view = await (await f.request('/api/business/sso/config')).json();
    assert.equal(view.secretSaved, true); assert.equal(view.clientSecret, undefined); assert.deepEqual(view.allowedDomains, ['example.com']);
    assert.ok(!JSON.stringify(view).includes(SECRET_CANARY));
    assert.equal(new Vault(join(f.profile.businessDir, 'operator')).get('business-oidc:client-secret'), SECRET_CANARY);
    const db = readFileSync(join(f.profile.businessDir, 'business.db')); assert.ok(!db.includes(SECRET_CANARY), 'secret never in the control database');
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...good, clientSecret: undefined, sessionHours: 10 })).status, 200, 'an omitted secret keeps the saved one');
    assert.deepEqual(await (await fetch(f.runtime.origin + '/api/business/sso/status')).json(), { enabled: true, preset: 'okta' });
    const check = await (await f.request('/api/business/sso/test', f.admin, {})).json();
    assert.equal(check.ok, true); assert.equal(check.keys, 1);
    assert.deepEqual(audit(f), ['sso.configure', 'sso.configure']);
    assert.equal(f.runtime.control.database.prepare("SELECT COUNT(*) AS n FROM business_audit WHERE action='sso.configure' AND actor_id=?").get(f.admin.principal.identityId)!.n, 2);
  } finally { await f.close(); await idp.close(); }
});

test('sso: invitation-bound first sign-in (default); later sign-ins use the link', async () => {
  const { idp, f, close } = await setup();
  try {
    const refused = await signIn(f, idp, 'bob', { confirm18: true });
    assert.equal(refused.status, 303); assert.equal(refused.location, '/?sso=no_account'); assert.equal(refused.cookie, undefined);
    const code = orgInvite(f);
    const adult = await signIn(f, idp, 'bob', { code });
    assert.equal(adult.location, '/?sso=adult', 'a new account confirms 18+');
    const joined = await signIn(f, idp, 'bob', { code, confirm18: true });
    assert.equal(joined.location, '/'); assert.ok(joined.value);
    assert.match(joined.raw!, /HttpOnly/); assert.match(joined.raw!, /SameSite=Strict/); assert.match(joined.raw!, /Max-Age=43200/);
    const self = await (await me(f, joined.value!)).json();
    assert.equal(self.identity.name, 'Bob Member'); assert.equal(self.organization.role, 'user'); assert.equal(self.signIn, 'sso');
    assert.ok(self.principal.expiresAt <= Date.now() + 12 * 3600_000 + 5000, 'session expiry follows the SSO session length');
    idp.users.set('dan', { sub: 'dan', email: 'dan@example.com', email_verified: true, name: 'Dan' });
    assert.equal((await signIn(f, idp, 'dan', { code, confirm18: true })).location, '/?sso=invite', 'an invitation is single use');
    const again = await signIn(f, idp, 'bob');
    assert.equal(again.location, '/');
    assert.equal((await (await me(f, again.value!)).json()).identity.id, self.identity.id, 'same account through the link');
    assert.ok(audit(f).includes('sso.signin') && audit(f).includes('sso.refused'));
    const rows = JSON.stringify(f.runtime.control.database.prepare('SELECT * FROM business_audit').all());
    assert.ok(!rows.includes('bob@example.com') && !rows.includes(idp.clientSecret), 'no email or secret in audit rows');
  } finally { await close(); }
});

test('sso: just-in-time accounts when the admin turns them on', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    assert.equal((await signIn(f, idp, 'bob')).location, '/?sso=adult');
    const joined = await signIn(f, idp, 'bob', { confirm18: true });
    assert.equal(joined.location, '/');
    assert.equal((await (await me(f, joined.value!)).json()).organization.role, 'user');
  } finally { await close(); }
});

test('sso: email domain allowlist (unverified email and other domains refused)', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    assert.equal((await signIn(f, idp, 'eve', { confirm18: true })).location, '/?sso=domain');
    idp.users.get('bob')!.email_verified = false;
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true })).location, '/?sso=domain');
    idp.users.get('bob')!.email = undefined; idp.users.get('bob')!.email_verified = undefined;
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true })).location, '/?sso=domain', 'no email at all');
    assert.equal(f.runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_sso_links').get()!.n, 0);
  } finally { await close(); }
});

test('sso: group claim maps to Sara roles and follows changes at the IdP', async () => {
  const { idp, f, close } = await setup({ jit: true, adminGroups: ['sara-admins'], memberGroups: ['sara-users'] });
  try {
    idp.users.set('carol', { sub: 'carol', email: 'carol@example.com', email_verified: true, name: 'Carol', groups: ['marketing'] });
    assert.equal((await signIn(f, idp, 'carol', { confirm18: true })).location, '/?sso=group');
    const alice = await signIn(f, idp, 'alice', { confirm18: true });
    assert.equal((await (await me(f, alice.value!)).json()).organization.role, 'orgadmin');
    const bob = await signIn(f, idp, 'bob', { confirm18: true });
    const bobId = (await (await me(f, bob.value!)).json()).identity.id;
    assert.equal(f.runtime.control.organizationMembership(bobId)!.role, 'user');
    idp.users.get('bob')!.groups = ['sara-admins', 'sara-users'];
    await signIn(f, idp, 'bob');
    assert.equal(f.runtime.control.organizationMembership(bobId)!.role, 'orgadmin', 'promoted at the next sign-in');
    idp.users.get('bob')!.groups = ['marketing'];
    assert.equal((await signIn(f, idp, 'bob')).location, '/?sso=group', 'no mapped group: refused');
  } finally { await close(); }
});

test('sso: ID-token failures at the callback are refused and audited (audience, issuer, expiry, signature, nonce)', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    for (const tamper of [{ aud: 'another-app' }, { iss: 'https://evil.example' }, { expIn: -600 }, { badSignature: true }, { nonce: 'other' }, { alg: 'none' }]) {
      idp.tamper = tamper;
      const result = await signIn(f, idp, 'bob', { confirm18: true });
      assert.equal(result.location, '/?sso=failed', JSON.stringify(tamper)); assert.equal(result.cookie, undefined);
    }
    idp.tamper = {};
    idp.rotate('ES256', true);
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true })).location, '/', 'key rotation: unknown kid refetches the JWKS');
    assert.ok(audit(f).filter(a => a === 'sso.refused').length >= 6);
  } finally { await close(); }
});

test('sso: state is single use, bound to this browser, and checked', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true }, { mutate: u => u.searchParams.set('state', 'x'.repeat(43)) })).location, '/?sso=state');
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true }, { dropBinding: true })).location, '/?sso=state', 'another browser cannot finish the sign-in');
    const start = await fetch(f.runtime.origin + '/api/business/sso/start', { method: 'POST', headers: { origin: f.runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify({ confirm18: true }) });
    const binding = start.headers.getSetCookie()[0].split(';')[0]; const back = idp.approve((await start.json()).url, 'bob');
    assert.equal((await fetch(back, { redirect: 'manual', headers: { cookie: binding } })).headers.get('location'), '/');
    assert.equal((await fetch(back, { redirect: 'manual', headers: { cookie: binding } })).headers.get('location'), '/?sso=state', 'replay refused');
    assert.equal((await signIn(f, idp, 'bob', {}, { mutate: u => { u.searchParams.delete('code'); u.searchParams.set('error', 'access_denied'); } })).location, '/?sso=denied');
    assert.equal((await fetch(f.runtime.origin + '/api/business/sso/start', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await close(); }
});

test('sso: a person disabled at the IdP loses access at the next session check', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    const bob = await signIn(f, idp, 'bob', { confirm18: true });
    assert.equal((await me(f, bob.value!)).status, 200);
    await f.runtime.sso.checkSessions(true);
    assert.equal((await me(f, bob.value!)).status, 200, 'an active person keeps the session');
    idp.disable('bob');
    assert.equal((await me(f, bob.value!)).status, 200, 'until the next check');
    await f.runtime.sso.checkSessions(true);
    assert.equal((await me(f, bob.value!)).status, 401);
    assert.ok(audit(f).includes('sso.revoked'));
    assert.equal((await signIn(f, idp, 'bob')).location, '/?sso=denied');
  } finally { await close(); }
});

test('sso: session length is enforced; logout returns the IdP end-session address', async () => {
  const { idp, f, close } = await setup({ jit: true, sessionHours: 1 });
  try {
    const bob = await signIn(f, idp, 'bob', { confirm18: true });
    assert.match(bob.raw!, /Max-Age=3600/);
    const out = await fetch(f.runtime.origin + '/api/business/logout', { method: 'POST', headers: { origin: f.runtime.origin, 'content-type': 'application/json', cookie: `sara_business_session=${bob.value}` }, body: '{}' });
    const body = await out.json();
    assert.equal(new URL(body.endSession).origin, idp.issuer); assert.equal(new URL(body.endSession).searchParams.get('post_logout_redirect_uri'), f.runtime.origin + '/');
    assert.equal((await me(f, bob.value!)).status, 401);
    const later = await signIn(f, idp, 'bob');
    f.runtime.control.database.prepare('UPDATE business_sso_sessions SET expires_at=?').run(Date.now() - 1);
    assert.equal((await me(f, later.value!)).status, 401, 'an expired SSO session is closed even with a valid cookie');
  } finally { await close(); }
});

test('sso: break-glass owner passkey always works; enforce refuses other passkeys; Sara-disabled accounts stay out', async () => {
  const { idp, f, close } = await setup({ jit: true });
  try {
    const enroll = (session: BusinessSession) => {
      const key = new BusinessAuthenticator(); const o = f.runtime.auth.options('register', session.principal.identityId, f.runtime.origin, session.principal);
      f.runtime.auth.finish('register', o.challenge, key.register(o.challenge, f.runtime.origin), f.runtime.origin, session.principal); return key;
    };
    const login = (key: BusinessAuthenticator) => { const o = f.runtime.auth.options('login', undefined, f.runtime.origin); return f.runtime.auth.finish('login', o.challenge, key.assertion(o.challenge, f.runtime.origin), f.runtime.origin); };
    const ownerKey = enroll(f.admin); const member = f.add('Morgan'); const memberKey = enroll(member);
    const config = await (await f.request('/api/business/sso/config')).json();
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...strip(config), enforce: true })).status, 200);
    assert.throws(() => login(memberKey), /Sign-in failed/);
    assert.ok(login(ownerKey), 'break-glass: the owner passkey still signs in');
    // Misconfigured IdP: the owner can still get in and fix it.
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...strip(config), enforce: true, issuer: 'http://127.0.0.1:9' })).status, 200);
    assert.ok(login(ownerKey));
    assert.equal((await signIn(f, idp, 'bob', { confirm18: true }).catch(() => ({ location: 'start-refused' }))).location !== '/', true);
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...strip(config), enforce: false })).status, 200);
    const bob = await signIn(f, idp, 'bob', { confirm18: true });
    const bobId = (await (await me(f, bob.value!)).json()).identity.id;
    f.runtime.control.setOrganizationMember(f.admin.principal, bobId, { status: 'disabled' });
    assert.equal((await me(f, bob.value!)).status, 401);
    assert.equal((await signIn(f, idp, 'bob')).location, '/?sso=disabled');
  } finally { await close(); }
});

test('sso: a signed-in member links the company account; changing the IdP ends SSO sessions', async () => {
  const { idp, f, close } = await setup();
  try {
    const member = f.add('Morgan');
    const linked = await signIn(f, idp, 'bob', { link: true }, { session: member });
    assert.equal(linked.location, '/');
    assert.equal((await (await me(f, linked.value!)).json()).identity.id, member.principal.identityId);
    const again = await signIn(f, idp, 'bob');
    assert.equal((await (await me(f, again.value!)).json()).identity.id, member.principal.identityId);
    assert.equal((await signIn(f, idp, 'alice', { link: true }, { session: member })).location, '/?sso=linked', 'one company account per member');
    assert.ok(audit(f).includes('sso.link'));
    const config = await (await f.request('/api/business/sso/config')).json();
    assert.equal((await f.request('/api/business/sso/config', f.admin, { ...strip(config), clientId: 'another-client' })).status, 200);
    assert.equal((await me(f, again.value!)).status, 401, 'issuer or client change ends every SSO session');
    assert.equal((await me(f, member.value)).status, 200, 'passkey sessions are untouched');
  } finally { await close(); }
});

function strip(view: Record<string, unknown>) {
  const { secretSaved: _s, redirectUrl: _r, ...rest } = view; void _s; void _r; return rest;
}

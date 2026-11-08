// EC16 (docs/ops/EC1617_DESIGN.md, docs/SCIM.md): SCIM 2.0 provisioning for business instances,
// driven with the request sequences Microsoft Entra ID and Okta send (recorded shapes, see docs/SCIM.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { contentFixture } from './helpers/business-content.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type Fixture = Awaited<ReturnType<typeof contentFixture>>;
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';

async function setup() {
  const f = await contentFixture();
  const on = await f.request('/api/business/scim/config', f.admin, { enabled: true });
  assert.equal(on.status, 200, await on.clone().text());
  const issued = await f.request('/api/business/scim/token', f.admin, {});
  assert.equal(issued.status, 200);
  const { token, baseUrl } = await issued.json() as { token: string; baseUrl: string };
  assert.equal(baseUrl, f.runtime.origin + '/scim/v2');
  const scim = (method: string, path: string, body?: unknown, auth = token) => fetch(f.runtime.origin + '/scim/v2' + path, {
    method, headers: { authorization: `Bearer ${auth}`, accept: 'application/scim+json', ...(body === undefined ? {} : { 'content-type': 'application/scim+json; charset=utf-8' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (r: Response, status: number) => { const text = await r.text(); assert.equal(r.status, status, text); return text ? JSON.parse(text) : undefined; };
  return { f, token, scim, json };
}
const actions = (f: Fixture) => f.runtime.control.database.prepare("SELECT action FROM business_audit WHERE action LIKE 'scim.%' ORDER BY id").all().map(r => String(r.action));
const identity = (f: Fixture, id: string) => ({ ...f.runtime.control.database.prepare('SELECT i.status AS identity,i.auth_epoch AS epoch,m.status AS member,m.role FROM business_identities i JOIN organization_members m ON m.identity_id=i.id WHERE i.id=?').get(id) }) as { identity: string; epoch: number; member: string; role: string };

test('scim: personal servers have no /scim route', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() }); const auth = new OwnerAuth(dir); const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/scim/v2/Users`, { headers: { authorization: `Bearer ${token}` } });
    // The web app's page fallback may answer, but never SCIM.
    assert.doesNotMatch(r.headers.get('content-type') ?? '', /scim/);
    assert.doesNotMatch(await r.text(), /ListResponse|urn:ietf:params:scim/);
  } finally { server.close(); app.store.close(); cleanup(); }
});

test('scim: off by default, token admin-only, shown once, kept hashed in the operator vault; no cookie and no wrong token', async () => {
  const f = await contentFixture();
  try {
    const off = await fetch(f.runtime.origin + '/scim/v2/Users', { headers: { authorization: 'Bearer x'.padEnd(50, 'x') } });
    assert.equal(off.status, 404);
    const user = f.add('Blake');
    assert.equal((await f.request('/api/business/scim/config', user, { enabled: true })).status, 403);
    assert.equal((await f.request('/api/business/scim/token', user, {})).status, 403);
    const view = await (await f.request('/api/business/scim/config')).json() as { enabled: boolean; tokenSet: boolean; baseUrl: string };
    assert.deepEqual([view.enabled, view.tokenSet], [false, false]);
  } finally { await f.close(); }
  const { f: g, token, scim, json } = await setup();
  try {
    const vault = readFileSync(join(g.profile.businessDir, 'operator', 'secrets.enc'), 'utf8');
    assert.ok(!vault.includes(token));
    const view = await (await g.request('/api/business/scim/config')).json() as Record<string, unknown>;
    assert.equal(view.tokenSet, true); assert.ok(!JSON.stringify(view).includes(token));
    await json(await scim('GET', '/Users'), 200);
    const wrong = await scim('GET', '/Users', undefined, token.slice(0, -2) + 'zz');
    assert.equal(wrong.status, 401); assert.equal((await wrong.json()).schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
    const cookie = await fetch(g.runtime.origin + '/scim/v2/Users', { headers: { cookie: `sara_business_session=${g.admin.value}` } });
    assert.equal(cookie.status, 401);
    // Rotating ends the old token at once.
    const next = await (await g.request('/api/business/scim/token', g.admin, {})).json() as { token: string };
    assert.equal((await scim('GET', '/Users')).status, 401);
    assert.equal((await scim('GET', '/Users', undefined, next.token)).status, 200);
    assert.ok(actions(g).includes('scim.token') && actions(g).includes('scim.configure') && actions(g).includes('scim.refused'));
  } finally { await g.close(); }
});

test('scim: discovery endpoints describe what Sara supports', async () => {
  const { f, scim, json } = await setup();
  try {
    const spc = await json(await scim('GET', '/ServiceProviderConfig'), 200);
    assert.equal(spc.patch.supported, true); assert.equal(spc.bulk.supported, false); assert.equal(spc.filter.supported, true);
    assert.equal(spc.authenticationSchemes[0].type, 'oauthbearertoken');
    const types = await json(await scim('GET', '/ResourceTypes'), 200);
    assert.deepEqual(types.Resources.map((r: { name: string }) => r.name).sort(), ['Group', 'User']);
    const schemas = await json(await scim('GET', '/Schemas'), 200);
    assert.deepEqual(schemas.Resources.map((r: { id: string }) => r.id).sort(), [GROUP, USER]);
    assert.equal((await scim('GET', '/Bulk')).status, 404);
  } finally { await f.close(); }
});

test('scim: the Microsoft Entra ID provisioning sequence (validator probe, create, update, groups, disable, delete)', async () => {
  const { f, scim, json } = await setup();
  try {
    await f.request('/api/business/sso/config', f.admin, { adminGroups: ['Sara Admins'], memberGroups: ['Sara Users'] });
    // 1. Entra's first call: a userName that cannot exist must give an empty list, not 404.
    const probe = await json(await scim('GET', '/Users?filter=userName+eq+%22d3c6b8f2-8e9a-4b47-9f3a-1e2f3a4b5c6d%22'), 200);
    assert.deepEqual([probe.totalResults, probe.Resources.length, probe.schemas[0]], [0, 0, 'urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    // 2. Create (the enterprise extension and roles are sent; Sara ignores what it does not keep).
    const created = await json(await scim('POST', '/Users', { schemas: [USER, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'], externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef', userName: 'Test_User_ab6490ee@contoso.com', active: true,
      emails: [{ primary: true, type: 'work', value: 'Test_User_ab6490ee@contoso.com' }], meta: { resourceType: 'User' }, name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' }, roles: [],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Sales' } }), 201);
    assert.match(created.id, /^[0-9a-f-]{36}$/); assert.equal(created.active, true); assert.equal(created.meta.location, f.runtime.origin + '/scim/v2/Users/' + created.id);
    assert.deepEqual(identity(f, created.id), { identity: 'active', epoch: 0, member: 'active', role: 'user' });
    // Duplicate userName (any case) is a uniqueness conflict.
    const dup = await json(await scim('POST', '/Users', { schemas: [USER], userName: 'TEST_USER_AB6490EE@contoso.com' }), 409);
    assert.equal(dup.scimType, 'uniqueness');
    // 3. Read back by id and by filter (exact match, case-insensitive userName).
    assert.equal((await json(await scim('GET', `/Users/${created.id}`), 200)).userName, 'Test_User_ab6490ee@contoso.com');
    const found = await json(await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "test_user_ab6490ee@contoso.com"')}`), 200);
    assert.equal(found.totalResults, 1);
    const byExt = await json(await scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef"')}`), 200);
    assert.equal(byExt.Resources[0].id, created.id);
    assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('title sw "x"')}`)).status, 400);
    // 4. Entra updates with capitalised ops and filtered paths.
    const patched = await json(await scim('PATCH', `/Users/${created.id}`, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'emails[type eq "work"].value', value: 'updatedEmail@contoso.com' }, { op: 'Replace', path: 'name.familyName', value: 'updatedFamilyName' }, { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager', value: 'x' }] }), 200);
    assert.equal(patched.emails[0].value, 'updatedEmail@contoso.com'); assert.equal(patched.name.familyName, 'updatedFamilyName');
    // 5. Groups: create, look up by displayName, add the member: the member group maps to user, the admin group to orgadmin.
    const group = await json(await scim('POST', '/Groups', { schemas: [GROUP], externalId: '8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159', displayName: 'Sara Admins', meta: { resourceType: 'Group' } }), 201);
    assert.deepEqual(group.members, []);
    const g2 = await json(await scim('GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Sara Admins"')}`), 200);
    assert.equal(g2.Resources[0].id, group.id); assert.equal(g2.Resources[0].members, undefined);
    await json(await scim('PATCH', `/Groups/${group.id}`, { schemas: [PATCH], Operations: [{ op: 'Add', path: 'members', value: [{ $ref: null, value: created.id }] }] }), 200);
    assert.equal(identity(f, created.id).role, 'orgadmin');
    const withGroups = await json(await scim('GET', `/Users/${created.id}`), 200);
    assert.deepEqual(withGroups.groups.map((x: { value: string }) => x.value), [group.id]);
    await json(await scim('PATCH', `/Groups/${group.id}`, { schemas: [PATCH], Operations: [{ op: 'Remove', path: 'members', value: [{ $ref: null, value: created.id }] }] }), 200);
    assert.equal(identity(f, created.id).role, 'user');
    await json(await scim('PATCH', `/Groups/${group.id}`, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'displayName', value: '1879db59updatedDisplayName' }] }), 200);
    // 6. Disable with Entra's string boolean: the account is closed at once.
    await json(await scim('PATCH', `/Users/${created.id}`, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }), 200);
    const off = identity(f, created.id);
    assert.deepEqual([off.identity, off.member, off.epoch], ['disabled', 'disabled', 1]);
    assert.equal((await json(await scim('GET', `/Users/${created.id}`), 200)).active, false);
    // 7. Delete the group and the user (204, then 404).
    assert.equal((await scim('DELETE', `/Groups/${group.id}`)).status, 204);
    assert.equal((await scim('DELETE', `/Users/${created.id}`)).status, 204);
    assert.equal((await scim('GET', `/Users/${created.id}`)).status, 404);
    assert.equal(identity(f, created.id).member, 'removed');
    const log = actions(f);
    for (const a of ['scim.user.create', 'scim.user.update', 'scim.group', 'scim.user.deactivate', 'scim.user.delete']) assert.ok(log.includes(a), a);
    const rows = JSON.stringify(f.runtime.control.database.prepare('SELECT * FROM business_audit').all());
    assert.ok(!rows.includes('contoso'), 'no userName or email in audit rows');
  } finally { await f.close(); }
});

test('scim: the Okta provisioning sequence (lookup with paging, create with password, PUT, PATCH active, push groups)', async () => {
  const { f, scim, json } = await setup();
  try {
    await f.request('/api/business/sso/config', f.admin, { adminGroups: ['Okta Admins'] });
    const none = await json(await scim('GET', '/Users?filter=userName%20eq%20%22test.user%40okta.local%22&startIndex=1&count=100'), 200);
    assert.deepEqual([none.totalResults, none.startIndex, none.itemsPerPage], [0, 1, 0]);
    const u = await json(await scim('POST', '/Users', { schemas: [USER], userName: 'test.user@okta.local', name: { givenName: 'Test', familyName: 'User' }, emails: [{ primary: true, value: 'test.user@okta.local', type: 'work' }], displayName: 'Test User', locale: 'en-US', externalId: '00ujl29u0le5T6Aj10h7', groups: [], password: '1mz050nq-canary', active: true }), 201);
    assert.equal(u.password, undefined);
    assert.ok(!JSON.stringify(f.runtime.control.database.prepare('SELECT * FROM business_scim_users').all()).includes('1mz050nq-canary'), 'password never stored');
    const put = await json(await scim('PUT', `/Users/${u.id}`, { schemas: [USER], id: u.id, userName: 'test.user@okta.local', name: { givenName: 'Another', familyName: 'User' }, emails: [{ primary: true, value: 'test.user@okta.local', type: 'work' }], displayName: 'Another User', active: true }), 200);
    assert.equal(put.name.givenName, 'Another');
    assert.equal(f.runtime.identities.get(u.id)!.name, 'Another User');
    const g = await json(await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'Okta Admins', members: [] }), 201);
    await json(await scim('PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: u.id, display: 'test.user@okta.local' }] }] }), 200);
    assert.equal(identity(f, u.id).role, 'orgadmin');
    await json(await scim('PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'remove', path: `members[value eq "${u.id}"]` }] }), 200);
    assert.equal(identity(f, u.id).role, 'user');
    const replaced = await json(await scim('PUT', `/Groups/${g.id}`, { schemas: [GROUP], id: g.id, displayName: 'Okta Admins', members: [{ value: u.id, display: 'test.user@okta.local' }] }), 200);
    assert.equal(replaced.members.length, 1); assert.equal(identity(f, u.id).role, 'orgadmin');
    await json(await scim('PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { id: g.id, displayName: 'Okta Admins renamed' } }] }), 200);
    assert.equal(identity(f, u.id).role, 'user', 'renamed out of the admin mapping');
    await json(await scim('PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: false } }] }), 200);
    assert.equal(identity(f, u.id).identity, 'disabled');
    // Okta re-activates with the same PATCH; old sessions stay closed (the epoch moved on).
    await json(await scim('PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] }), 200);
    assert.deepEqual([identity(f, u.id).identity, identity(f, u.id).member, identity(f, u.id).epoch], ['active', 'active', 1]);
    const page = await json(await scim('GET', '/Users?startIndex=1&count=1'), 200);
    assert.equal(page.itemsPerPage, 1); assert.equal(page.totalResults, 1);
  } finally { await f.close(); }
});

test('scim: deactivating a provisioned person ends their signed-in session at once', async () => {
  const { f, scim, json } = await setup();
  try {
    const u = await json(await scim('POST', '/Users', { schemas: [USER], userName: 'pat@example.com', displayName: 'Pat' }), 201);
    // A session for the provisioned identity (as company sign-in would issue).
    const session = f.runtime.auth.ssoSession(f.runtime.identities.get(u.id)!, 3600);
    assert.equal((await fetch(f.runtime.origin + '/api/business/me', { headers: { cookie: `sara_business_session=${session.value}` } })).status, 200);
    await json(await scim('PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }), 200);
    assert.equal((await fetch(f.runtime.origin + '/api/business/me', { headers: { cookie: `sara_business_session=${session.value}` } })).status, 401);
  } finally { await f.close(); }
});

test('scim: never touches accounts it did not create, and refuses malformed requests', async () => {
  const { f, scim, json } = await setup();
  try {
    assert.equal((await scim('GET', `/Users/${f.admin.principal.identityId}`)).status, 404);
    assert.equal((await scim('PATCH', `/Users/${f.admin.principal.identityId}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] })).status, 404);
    assert.equal((await scim('DELETE', `/Users/${f.admin.principal.identityId}`)).status, 404);
    assert.equal(identity(f, f.admin.principal.identityId).identity, 'active');
    const g = await json(await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'X' }), 201);
    assert.equal((await scim('PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: f.admin.principal.identityId }] }] })).status, 400);
    assert.equal((await scim('POST', '/Users', { schemas: [USER] })).status, 400);
    assert.equal((await scim('POST', '/Users', { schemas: [USER], userName: 'a\u0000b' })).status, 400);
    assert.equal((await scim('PATCH', `/Groups/${g.id}`, { schemas: [PATCH], Operations: [{ op: 'move', path: 'members' }] })).status, 400);
    const big = await fetch(f.runtime.origin + '/scim/v2/Users', { method: 'POST', headers: { authorization: `Bearer ${(await (await f.request('/api/business/scim/token', f.admin, {})).json()).token}`, 'content-type': 'application/scim+json' }, body: JSON.stringify({ userName: 'x'.repeat(70_000) }) });
    assert.equal(big.status, 413);
  } finally { await f.close(); }
});

test('scim: rate limits on bad tokens per address and on requests per minute', async () => {
  const { f, scim, token } = await setup();
  try {
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await scim('GET', '/Users', undefined, 'wrong'.padEnd(43, 'x'))).status;
    assert.equal(last, 429);
    // Even the right token waits now from this address.
    assert.equal((await scim('GET', '/Users', undefined, token)).status, 429);
    f.runtime.scim.resetLimits();
    f.runtime.scim.setRequestLimit(5);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await scim('GET', '/ServiceProviderConfig')).status);
    assert.deepEqual(statuses.slice(-2), [429, 429]);
    const r = await scim('GET', '/ServiceProviderConfig');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally { await f.close(); }
});

test('scim: a provisioned person signs in with company sign-in the first time without an invitation', async () => {
  const { fakeOidc } = await import('./fixtures/fake-oidc.ts');
  const idp = await fakeOidc();
  const { f, scim, json } = await setup();
  try {
    const saved = await f.request('/api/business/sso/config', f.admin, { enabled: true, preset: 'generic', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedDomains: ['example.com'] });
    assert.equal(saved.status, 200);
    const u = await json(await scim('POST', '/Users', { schemas: [USER], userName: 'Bob@Example.com', displayName: 'Bob' }), 201);
    const go = async (confirm18: boolean) => {
      const start = await fetch(f.runtime.origin + '/api/business/sso/start', { method: 'POST', headers: { origin: f.runtime.origin, 'content-type': 'application/json' }, body: JSON.stringify(confirm18 ? { confirm18 } : {}) });
      const { url } = await start.json() as { url: string };
      const binding = start.headers.getSetCookie().find(c => c.startsWith('sara_business_sso='))!.split(';')[0];
      return fetch(idp.approve(url, 'bob'), { redirect: 'manual', headers: { cookie: binding } });
    };
    assert.equal((await go(false)).headers.get('location'), '/?sso=adult');
    const ok = await go(true);
    assert.equal(ok.headers.get('location'), '/');
    const link = f.runtime.control.database.prepare('SELECT identity_id FROM business_sso_links WHERE subject=?').get('bob');
    assert.equal(link?.identity_id, u.id);
    // Deactivated in the provider: the next company sign-in is refused.
    await json(await scim('PATCH', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }), 200);
    assert.equal((await go(true)).headers.get('location'), '/?sso=disabled');
  } finally { await f.close(); await idp.close(); }
});

test('scim ui: the settings module is served, translated, tipped within 260 characters, without inline styles', async () => {
  const { LANGS, fromJs, loadLang } = await import('../scripts/i18n-extract.ts');
  const source = readFileSync(new URL('../web/business-scim.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.style\b|style=|cssText/);
  const keys = fromJs(source);
  assert.ok(keys.length >= 20, `found ${keys.length} strings`);
  const tips = source.split("dataset.tip = t('").slice(1).map(part => part.slice(0, part.indexOf("')")));
  assert.equal(tips.length, 3);
  for (const lang of LANGS) {
    const d = loadLang(lang);
    for (const k of [...keys, ...fromJs(readFileSync(new URL('../web/business-admin.js', import.meta.url), 'utf8'))]) assert.ok(d[k]?.trim(), `${lang}: ${k}`);
    for (const tip of tips) assert.ok(tip.length <= 260 && d[tip].length <= 260, `${lang} tip too long: ${tip.slice(0, 40)}`);
  }
  const f = await contentFixture();
  try {
    const script = await fetch(f.runtime.origin + '/business-scim.js');
    assert.equal(script.status, 200); assert.match(await script.text(), /renderScimSettings/);
  } finally { await f.close(); }
});

test('scim: RFC 7643/7644 points a real SCIM client found (C1: scim2-cli 0.7.1 / scim2-tester 0.6.4)', async () => {
  const { f, scim, json } = await setup();
  try {
    // Discovery by id (RFC 7644 §4): clients build their models from these.
    assert.equal((await json(await scim('GET', `/Schemas/${USER}`), 200)).id, USER);
    assert.equal((await json(await scim('GET', `/Schemas/${GROUP}`), 200)).id, GROUP);
    assert.equal((await json(await scim('GET', '/ResourceTypes/User'), 200)).endpoint, '/Users');
    assert.equal((await json(await scim('GET', '/ResourceTypes/Group'), 200)).endpoint, '/Groups');
    assert.equal((await scim('GET', '/Schemas/urn:nope')).status, 404);
    assert.deepEqual((await json(await scim('GET', `/Schemas/${USER}`), 200)).schemas, ['urn:ietf:params:scim:schemas:core:2.0:Schema']);
    for (const path of ['/Schemas', '/ResourceTypes/User', '/ServiceProviderConfig']) assert.equal((await scim('POST', path, {})).status, 405, path);
    // Every sub-attribute Sara returns is declared, so a strict client accepts its answers.
    const schemas = (await json(await scim('GET', '/Schemas'), 200)).Resources as { id: string; attributes: { name: string; subAttributes?: { name: string }[] }[] }[];
    const subs = (schema: string, attr: string) => schemas.find(s => s.id === schema)!.attributes.find(a => a.name === attr)!.subAttributes!.map(a => a.name).sort();
    assert.deepEqual(subs(USER, 'groups'), ['$ref', 'display', 'type', 'value']);
    assert.deepEqual(subs(GROUP, 'members'), ['$ref', 'display', 'type', 'value']);
    const u = await json(await scim('POST', '/Users', { schemas: [USER], userName: 'pat@example.com', externalId: 'x-pat', name: { givenName: 'Pat', familyName: 'Lee' }, emails: [{ value: 'pat@example.com', type: 'work', primary: true }] }), 201);
    await json(await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'Ops', members: [{ value: u.id }] }), 201);
    // attributes / excludedAttributes (RFC 7644 §3.4.2.5); id and schemas are always returned.
    const only = await json(await scim('GET', `/Users/${u.id}?attributes=userName`), 200);
    assert.deepEqual(Object.keys(only).filter(k => k !== 'meta').sort(), ['id', 'schemas', 'userName']);
    const sub = await json(await scim('GET', `/Users/${u.id}?attributes=name.givenName`), 200);
    assert.deepEqual(sub.name, { givenName: 'Pat' });
    const without = await json(await scim('GET', `/Users/${u.id}?excludedAttributes=emails,name`), 200);
    assert.equal(without.emails, undefined); assert.equal(without.name, undefined); assert.equal(without.userName, 'pat@example.com');
    const list = await json(await scim('GET', '/Users?attributes=externalId'), 200);
    assert.deepEqual(Object.keys(list.Resources[0]).filter(k => k !== 'meta').sort(), ['externalId', 'id', 'schemas']);
    const groups = await json(await scim('GET', '/Groups?attributes=displayName'), 200);
    assert.equal(groups.Resources[0].members, undefined); assert.equal(groups.Resources[0].displayName, 'Ops');
    assert.equal((await json(await scim('GET', '/Groups?excludedAttributes=displayName'), 200)).Resources[0].displayName, undefined);
    // PUT replaces the whole group: displayName is required.
    const g = (await json(await scim('GET', '/Groups'), 200)).Resources[0];
    const put = await json(await scim('PUT', `/Groups/${g.id}`, { schemas: [GROUP], members: [] }), 400);
    assert.equal(put.scimType, 'invalidValue');
  } finally { await f.close(); }
});

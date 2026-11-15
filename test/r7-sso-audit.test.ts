// R7: company sign-in with Entra- and Okta-shaped providers against the local fake IdP (discovery,
// PKCE, a test JWKS, nonce, groups → roles), the administrator's "Test sign-in" (the whole round trip,
// nobody signed in or linked), and the business audit export (CSV/JSON, date range, admins only).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentFixture } from './helpers/business-content.ts';
import { fakeOidc, type FakeOidc } from './fixtures/fake-oidc.ts';

type Fixture = Awaited<ReturnType<typeof contentFixture>>;

async function setup(config: Record<string, unknown>) {
  const idp = await fakeOidc();
  const f = await contentFixture();
  const base = { enabled: true, preset: 'generic', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedDomains: [], groupClaim: 'groups', adminGroups: [], memberGroups: [], jit: true, enforce: false, sessionHours: 12, checkMinutes: 15 };
  const saved = await f.request('/api/business/sso/config', f.admin, { ...base, ...config });
  assert.equal(saved.status, 200, await saved.clone().text());
  return { idp, f, async close() { await f.close(); await idp.close(); } };
}

async function roundTrip(f: Fixture, idp: FakeOidc, sub: string, body: Record<string, unknown>, cookie?: string) {
  const start = await fetch(f.runtime.origin + '/api/business/sso/start', { method: 'POST', headers: { origin: f.runtime.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  if (start.status !== 200) return { status: start.status, location: '', session: undefined };
  const { url } = (await start.json()) as { url: string };
  const auth = new URL(url);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(auth.searchParams.get('nonce') && auth.searchParams.get('state'));
  const binding = start.headers.getSetCookie().find((c) => c.startsWith('sara_business_sso='))!;
  const back = new URL(idp.approve(url, sub));
  const res = await fetch(back, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site', cookie: binding.split(';')[0] } });
  const session = res.headers.getSetCookie().find((c) => c.startsWith('sara_business_session=') && !c.startsWith('sara_business_session=;'));
  return { status: res.status, location: res.headers.get('location') ?? '', session: session?.split(';')[0] };
}
const role = (f: Fixture, cookie: string) => fetch(f.runtime.origin + '/api/business/me', { headers: { cookie } }).then((r) => r.json()).then((j) => j.organization.role as string);
const links = (f: Fixture) => Number((f.runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_sso_links').get() as { n: number }).n);

test('Entra-shaped: email from preferred_username, group object IDs map to roles', async () => {
  const ADMINS = '6f1c2a3b-0000-4000-8000-000000000001';
  const USERS = '6f1c2a3b-0000-4000-8000-000000000002';
  const { idp, f, close } = await setup({ preset: 'entra', allowedDomains: ['contoso.example'], adminGroups: [ADMINS], memberGroups: [USERS] });
  try {
    idp.users.set('ent-1', { sub: 'ent-1', upn: 'dana@contoso.example', name: 'Dana', groups: [ADMINS] });
    idp.users.set('ent-2', { sub: 'ent-2', upn: 'lee@contoso.example', name: 'Lee', groups: [USERS] });
    idp.users.set('ent-3', { sub: 'ent-3', upn: 'kim@fabrikam.example', name: 'Kim', groups: [USERS] });
    const dana = await roundTrip(f, idp, 'ent-1', { confirm18: true });
    assert.equal(dana.location, '/', JSON.stringify(dana));
    assert.equal(await role(f, dana.session!), 'orgadmin');
    const lee = await roundTrip(f, idp, 'ent-2', { confirm18: true });
    assert.equal(await role(f, lee.session!), 'user');
    assert.equal((await roundTrip(f, idp, 'ent-3', { confirm18: true })).location, '/?sso=domain');
  } finally { await close(); }
});

test('Okta-shaped: a groups claim with group names; nobody in a listed group is refused', async () => {
  const { idp, f, close } = await setup({ preset: 'okta', allowedDomains: ['example.com'], adminGroups: ['Sara Admins'], memberGroups: ['Sara Users'] });
  try {
    idp.users.set('00u1', { sub: '00u1', email: 'pat@example.com', email_verified: true, name: 'Pat', groups: ['Everyone', 'Sara Users'] });
    idp.users.set('00u2', { sub: '00u2', email: 'sam@example.com', email_verified: true, name: 'Sam', groups: ['Everyone'] });
    const pat = await roundTrip(f, idp, '00u1', { confirm18: true });
    assert.equal(await role(f, pat.session!), 'user');
    assert.equal((await roundTrip(f, idp, '00u2', { confirm18: true })).location, '/?sso=group');
    // A forged signature (a key not in the JWKS) is refused at the callback.
    idp.tamper = { badSignature: true };
    assert.equal((await roundTrip(f, idp, '00u1', {})).location, '/?sso=failed');
  } finally { await close(); }
});

test('Test sign-in: before turning it on, the admin sees what the provider sends; nobody is signed in or linked', async () => {
  const { idp, f, close } = await setup({ enabled: false, adminGroups: ['sara-admins'], memberGroups: ['sara-users'], allowedDomains: ['example.com'] });
  try {
    const admin = `sara_business_session=${f.admin.value}`;
    // Anonymous and plain starts are refused while company sign-in is off.
    assert.equal((await roundTrip(f, idp, 'alice', { test: true })).status, 401);
    assert.equal((await roundTrip(f, idp, 'alice', {})).status, 404);
    assert.equal((await roundTrip(f, idp, 'alice', { test: true, confirm18: true }, admin)).status, 400);
    const r = await roundTrip(f, idp, 'alice', { test: true }, admin);
    assert.equal(r.location, '/?sso-test=done');
    assert.equal(r.session, undefined, 'no session cookie');
    assert.equal(links(f), 0, 'no account link');
    const result = (await (await f.request('/api/business/sso/test-result')).json()).result;
    assert.equal(result.ok, true);
    assert.equal(result.role, 'orgadmin');
    assert.equal(result.emailDomain, 'example.com');
    assert.deepEqual(result.groups, ['sara-admins']);
    assert.equal(JSON.stringify(result).includes('alice@'), false, 'no full email address kept');
    // A refusal says why.
    const eve = await roundTrip(f, idp, 'eve', { test: true }, admin);
    assert.equal(eve.location, '/?sso-test=done');
    const refused = (await (await f.request('/api/business/sso/test-result')).json()).result;
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'domain');
    const actions = f.runtime.control.database.prepare("SELECT action FROM business_audit WHERE action = 'sso.test'").all();
    assert.equal(actions.length, 2);
    // Someone who is not an organization administrator gets nothing.
    const other = f.add('Morgan');
    assert.equal((await f.request('/api/business/sso/test-result', other)).status, 403);
    assert.equal((await roundTrip(f, idp, 'alice', { test: true }, `sara_business_session=${other.value}`)).status, 403);
  } finally { await close(); }
});

test('business audit export: CSV and JSON for a date range, administrators only, ids and actions only', async () => {
  const f = await contentFixture();
  try {
    const csv = await f.request('/api/business/org/audit.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition') ?? '', /sara-business-audit-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await csv.text();
    assert.ok(text.startsWith('id,at,action,actorId,actorName,workspaceId,subjectId,revision\r\n'));
    assert.match(text, /organization\.bootstrap/);
    const json = await (await f.request('/api/business/org/audit.json')).json();
    assert.equal(json.kind, 'sara-business-audit-export');
    assert.equal(json.content, false);
    assert.ok(json.rows >= 1 && json.entries.some((e: { action: string }) => e.action === 'audit.export'), 'the CSV export is on the record');
    assert.match(json.sha256OfJsonLines, /^[0-9a-f]{64}$/);
    const none = await (await f.request('/api/business/org/audit.json?from=2000-01-01&to=2000-01-02')).json();
    assert.equal(none.rows, 0);
    assert.equal((await f.request('/api/business/org/audit.json?from=yesterday')).status, 400);
    const other = f.add('Morgan');
    assert.equal((await f.request('/api/business/org/audit.csv', other)).status, 403);
    assert.equal((await fetch(f.runtime.origin + '/api/business/org/audit.csv', { headers: { origin: f.runtime.origin } })).status, 401);
  } finally { await f.close(); }
});

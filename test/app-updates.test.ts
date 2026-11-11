// The Sara apps' versions and Update it (src/app-installs.ts, src/routes/app-updates.ts): the app's page
// checks in with its own sign-in, Settings → Devices lists each app and how far behind it is, Update it is
// handed to the app once, members only reach their own apps, the owner also reaches a member's.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { appInstallView, AppInstalls, cleanCheckin } from '../src/app-installs.ts';
import { OwnerAuth } from '../src/auth.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const APP = { platform: 'windows', version: '3.4.4', computer: 'DESK-1', how: 'remote', auto: true, selfUpdate: true, state: 'current', latest: '3.4.4' };

test('app installs: what an app may say, Update it handed over once, forgotten when signed out', () => {
  assert.throws(() => cleanCheckin({ ...APP, platform: 'linux' }), /platform/);
  assert.throws(() => cleanCheckin({ ...APP, version: 'latest' }), /version/);
  const c = cleanCheckin({ ...APP, state: 'nonsense', computer: 'A\u0000B'.repeat(50), extra: 'dropped' } as never);
  assert.equal(c.state, undefined);
  assert.equal(c.computer.length, 80);
  assert.ok(!('extra' in c));
  const { dir, cleanup } = tempDir();
  try {
    let now = new Date('2026-11-11T10:00:00Z');
    const s = new AppInstalls(dir, () => now);
    assert.deepEqual(s.checkin('sid1', cleanCheckin(APP), 'Sara app on Windows'), { ask: false });
    assert.equal(s.ask('nobody', 'owner'), false);
    assert.equal(s.ask('sid1', 'owner'), true);
    assert.deepEqual(s.checkin('sid1', cleanCheckin(APP), 'Sara app on Windows'), { ask: true, askedBy: 'owner' });
    assert.deepEqual(s.checkin('sid1', cleanCheckin(APP), 'Sara app on Windows'), { ask: false }, 'once');
    assert.equal(appInstallView('sid1', s.get('sid1')!, '3.4.6').asked, true, 'still shown as asked until the version changes');
    s.checkin('sid1', cleanCheckin({ ...APP, version: '3.4.6', latest: '3.4.6' }), '');
    assert.equal(appInstallView('sid1', s.get('sid1')!, '3.4.6').asked, false);
    // Views: behind the server, a newer app ready there, or one that updates with its server.
    const v = appInstallView('x', { ...cleanCheckin(APP), seenAt: now.toISOString() }, '3.4.6', 'x');
    assert.equal(v.behind, true);
    assert.equal(v.canAsk, true);
    assert.equal(v.current, true);
    assert.equal(appInstallView('x', { ...cleanCheckin({ ...APP, version: '3.4.6' }), seenAt: '' }, '3.4.6').canAsk, false, 'up to date');
    assert.equal(appInstallView('x', { ...cleanCheckin({ ...APP, version: '3.4.6', latest: '3.4.7', state: 'ready' }), seenAt: '' }, '3.4.6').canAsk, true, 'newer than the server is fine');
    const local = appInstallView('x', { ...cleanCheckin({ ...APP, how: 'server' }), seenAt: '' }, '3.4.6');
    assert.equal(local.canAsk, false);
    assert.match(local.why!, /updates together with her server/);
    assert.match(appInstallView('x', { ...cleanCheckin({ ...APP, selfUpdate: false }), seenAt: '' }, '3.4.6').why!, /can’t update itself/);
    // Signed out, or not seen for 60 days: forgotten.
    s.checkin('sid2', cleanCheckin(APP), '');
    assert.deepEqual(s.list((id) => id === 'sid2').map(([id]) => id), ['sid2']);
    now = new Date('2027-02-01T10:00:00Z');
    assert.deepEqual(s.list(), []);
  } finally {
    cleanup();
  }
});

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() } as never);
  const auth = new OwnerAuth(dir);
  // A household member (Bea) with an app of her own (her space's file, as her space writes it).
  const beaDir = join(dir, 'members', 'm1');
  mkdirSync(beaDir, { recursive: true });
  new AppInstalls(beaDir).checkin('beasid', cleanCheckin({ ...APP, computer: 'BEA-LAPTOP' }), 'Sara app on Windows');
  const household = { store: { members: () => [{ id: 'm1', name: 'Bea' }], dirOf: (id: string) => join(dir, 'members', id) } };
  const server = createSaraServer({
    app,
    auth,
    webDir: join(ROOT, 'web'),
    info: { version: '3.4.6', revision: null, startedAt: new Date().toISOString() },
    ...(mode === 'demo' ? { demo: true } : {}),
    ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Bea', status: 'active', limits: {} }), apps: () => [app], deleteSelf: async () => {} } } : { household }),
  } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  let cookie = '';
  async function api(path: string, method = 'GET', body?: unknown, how: 'cookie' | 'token' | 'none' = 'cookie') {
    const headers: Record<string, string> = { Origin: base, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 SaraDesktop/1 (Windows)' };
    if (how === 'cookie' && cookie) headers.cookie = cookie;
    if (how === 'token') headers.authorization = `Bearer ${auth.newToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  if (mode !== 'demo') {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) SaraDesktop/1 (Windows)' }, body: JSON.stringify({ token: auth.newToken }) });
    assert.equal(res.status, 200);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  return { api, dir };
}

test('app updates routes: check-in, the list, Update it, and the owner reaching a member’s app', async (t) => {
  const { api, dir } = await rig(t);
  // Only the app's own sign-in checks in (not an owner token), and only with an app's fields.
  assert.equal((await api('/api/app-updates/checkin', 'POST', APP, 'token')).status, 401);
  assert.equal((await api('/api/app-updates/checkin', 'POST', { ...APP, version: 'x' })).status, 400);
  const first = await api('/api/app-updates/checkin', 'POST', APP);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { server: '3.4.6', every: 300, ask: false });
  const list = await api('/api/app-updates');
  assert.equal(list.body.server, '3.4.6');
  assert.equal(list.body.apps.length, 1);
  const me = list.body.apps[0];
  assert.equal(me.current, true);
  assert.equal(me.behind, true);
  assert.equal(me.canAsk, true);
  assert.equal(me.label, 'Sara app on Windows');
  // Bea's app is listed for the owner, with her name.
  assert.deepEqual(list.body.members.map((m: { name: string; apps: { computer: string }[] }) => [m.name, m.apps[0].computer]), [['Bea', 'BEA-LAPTOP']]);
  // Update it: handed to the app once, at its next check-in.
  const asked = await api(`/api/app-updates/${me.id}/update`, 'POST', {});
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.asked, true);
  assert.equal((await api('/api/app-updates/checkin', 'POST', APP)).body.ask, true);
  assert.equal((await api('/api/app-updates/checkin', 'POST', APP)).body.ask, false);
  assert.equal((await api('/api/app-updates/nope/update', 'POST', {})).status, 404);
  // An app on the computer Sara runs on updates with her server: Update it says so.
  await api('/api/app-updates/checkin', 'POST', { ...APP, how: 'server' });
  const local = await api(`/api/app-updates/${me.id}/update`, 'POST', {});
  assert.equal(local.status, 409);
  assert.match(local.body.error, /updates together with her server/);
  // The owner asks Bea's app; it lands in Bea's own file.
  assert.equal((await api('/api/app-updates/member/m1/beasid/update', 'POST', {})).status, 200);
  assert.ok(new AppInstalls(join(dir, 'members', 'm1')).get('beasid')?.askedAt);
  assert.equal((await api('/api/app-updates/member/m9/beasid/update', 'POST', {})).status, 404);
  assert.equal((await api('/api/app-updates/member/m1/other/update', 'POST', {})).status, 404);
});

test('app updates routes: a member sees only their own apps and can’t reach anyone else’s; not on the demo', async (t) => {
  const member = await rig(t, 'member');
  const r = await member.api('/api/app-updates/checkin', 'POST', APP);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = await member.api('/api/app-updates');
  assert.equal(list.status, 200);
  assert.equal(list.body.members, undefined);
  assert.equal(list.body.apps.length, 1);
  assert.equal((await member.api(`/api/app-updates/${list.body.apps[0].id}/update`, 'POST', {})).status, 200);
  const other = await member.api('/api/app-updates/member/m1/beasid/update', 'POST', {});
  assert.equal(other.status, 403);
  assert.equal(other.body.ownerOnly, true);
  assert.ok(MEMBER_ROUTES.has('app-updates'));
  const demo = await rig(t, 'demo');
  assert.ok([401, 403].includes((await demo.api('/api/app-updates', 'GET', undefined, 'none')).status));
});

test('app updates routes: Update it is audited, the check-in every few minutes is not; app tokens are refused', () => {
  const src = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(/const AUDITED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'app-updates'/);
  assert.match(/const DEVICE_TOKEN_DENIED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'app-updates'/);
  assert.match(src, /!\(parts\[0\] === 'app-updates' && parts\[1\] === 'checkin'\)/);
});

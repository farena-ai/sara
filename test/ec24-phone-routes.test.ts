// EC24 (docs/ops/EC24_DESIGN.md): the phone-helper routes with a fake paired device: a cookie
// session (as /pair gives a phone) opts in, listens on /api/events, sees the prompt (and only it does),
// answers Allow once / Deny over HTTP; a late answer is 404, another device is 403, a picture over the
// cap is 413, apps signed in with a device code, household members and the pin are refused, and every
// request and opt-in writes one audit row.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { IMAGE_MAX_BYTES, PhoneHelper } from '../src/phone-helper.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
for (const d of ['owner', 'm1']) mkdirSync(join(dir, d), { recursive: true });
const clock = { now: new Date() };
const app = makeApp(join(dir, 'owner'), clock);
const mApp = makeApp(join(dir, 'm1'), clock);
const auth = new OwnerAuth(join(dir, 'owner'), () => clock.now);
const mAuth = new OwnerAuth(join(dir, 'm1'), () => clock.now);
const token = auth.newToken!;
const mToken = mAuth.newToken!;
const browser = (id: string) => auth.devices().find((d) => d.id === id && d.kind === 'browser');
app.phoneHelper = new PhoneHelper({ dir: join(dir, 'owner'), events: app.events, timeoutMs: 1500, alive: (id) => Boolean(browser(id)), label: (id) => browser(id)?.label });
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Sam', status: 'active', createdAt: '', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } }) as never, apps: () => [mApp], deleteSelf: async () => {} } });
const pol = new PolicyStore(join(dir, 'owner'));
setPolicy(pol);
setAuditTrail(new AuditTrail(join(dir, 'owner'), { key: () => 'k', policyRev: () => 0 }));
const phone = auth.createSession('Chrome on Android');
const laptop = auth.createSession('Firefox on Windows');
const appTok = auth.createDeviceToken('sara-chat');
let base = '';
let mbase = '';
before(async () => {
  for (const a of [app, mApp]) a.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => msrv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mbase = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
});
after(() => {
  app.phoneHelper!.cancelAll();
  server.closeAllConnections?.();
  msrv.closeAllConnections?.();
  server.close();
  msrv.close();
  setPolicy(new PolicyStore());
  setAuditTrail(undefined);
  app.store.close();
  mApp.store.close();
  cleanup();
});
const cookieOf = (s: { value: string }) => ({ cookie: `sara_session=${encodeURIComponent(s.value)}`, origin: base });
const req = (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { ...(o.body !== undefined || o.raw ? { 'content-type': 'application/json' } : {}), ...o.headers }, ...(o.raw ? { body: o.raw } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });

/** The fake paired device's event stream: collects `helper` events. */
async function listen(headers: Record<string, string>) {
  const ac = new AbortController();
  const got: { id: string; kind: string; state: string; reason?: string }[] = [];
  const res = await fetch(`${base}/api/events`, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: helper$/m.test(chunk)) got.push(JSON.parse(/^data: (.*)$/m.exec(chunk)![1]));
        }
      }
    } catch {
      /* closed */
    }
  })();
  return { got, close: () => ac.abort() };
}
const until = async (fn: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const rows = (action: string) => auditTrail()!.list({ limit: 200 }).filter((r) => r.action === action);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);

test('opt in: a browser session turns itself on; the owner token alone and device-code apps cannot', async () => {
  const off = await (await req('/api/phone-helper', { headers: cookieOf(phone) })).json();
  assert.equal(off.thisDevice, false);
  assert.equal(off.canOptIn, true);
  assert.equal((await req('/api/phone-helper', { method: 'PUT', body: { helper: true }, headers: { authorization: `Bearer ${token}` } })).status, 400, 'no device to switch on');
  assert.equal((await req('/api/phone-helper', { headers: { authorization: `Bearer ${appTok.token}` } })).status, 403, 'terminal/VS Code apps');
  const on = await req('/api/phone-helper', { method: 'PUT', body: { helper: true }, headers: cookieOf(phone) });
  assert.equal(on.status, 200);
  const v = await on.json();
  assert.equal(v.thisDevice, true);
  assert.deepEqual(v.devices.map((d: { label: string }) => d.label), ['Chrome on Android']);
  assert.equal(rows('phone.helper').length, 1, 'one audit row for the change');
  assert.deepEqual(rows('phone.helper')[0].keys, ['helper']);
});

test('ask → only the helper device sees the prompt → Allow once with a picture', async () => {
  const p = await listen(cookieOf(phone));
  const l = await listen(cookieOf(laptop));
  await new Promise((r) => setTimeout(r, 80));
  const asked = app.phoneHelper!.request('camera', { reason: 'See the plant' });
  await until(() => p.got.length > 0);
  const ev = p.got[0];
  assert.equal(ev.state, 'asking');
  assert.equal(ev.reason, 'See the plant');
  const pending = await (await req('/api/phone-helper', { headers: cookieOf(phone) })).json();
  assert.deepEqual(pending.pending.map((x: { id: string }) => x.id), [ev.id], 'a page opened later finds it');
  assert.equal((await req(`/api/phone-helper/requests/${ev.id}`, { method: 'POST', body: { allow: true, image: 'x' }, headers: cookieOf(laptop) })).status, 403, 'another device cannot answer');
  const ok = await req(`/api/phone-helper/requests/${ev.id}`, { method: 'POST', body: { allow: true, image: `data:image/jpeg;base64,${JPEG.toString('base64')}` }, headers: cookieOf(phone) });
  assert.equal(ok.status, 200);
  const r = await asked;
  assert.ok(r.ok && 'image' in r && r.image.data.equals(JPEG));
  await until(() => p.got.some((e) => e.state === 'done'));
  assert.equal(l.got.length, 0, 'a device that did not opt in never sees it');
  assert.equal((await req(`/api/phone-helper/requests/${ev.id}`, { method: 'POST', body: { allow: false }, headers: cookieOf(phone) })).status, 404, 'answered once');
  p.close();
  l.close();
  assert.equal(rows('phone.camera').at(-1)!.outcome, 'ok');
});

test('Deny, a timeout, and a picture over the cap', async () => {
  const p = await listen(cookieOf(phone));
  await new Promise((r) => setTimeout(r, 80));
  const denied = app.phoneHelper!.request('location', { reason: 'Weather' });
  await until(() => p.got.length > 0);
  await req(`/api/phone-helper/requests/${p.got[0].id}`, { method: 'POST', body: { allow: false }, headers: cookieOf(phone) });
  const d = await denied;
  assert.equal(!d.ok && d.outcome, 'denied');
  const late = await app.phoneHelper!.request('screen', { reason: 'Error' });
  assert.equal(!late.ok && late.outcome, 'timeout');
  await until(() => p.got.some((e) => e.kind === 'screen' && e.state === 'expired'));
  const exp = p.got.find((e) => e.kind === 'screen' && e.state === 'expired');
  assert.ok(exp, 'the prompt is told it expired');
  assert.equal((await req(`/api/phone-helper/requests/${exp!.id}`, { method: 'POST', body: { allow: true }, headers: cookieOf(phone) })).status, 404);
  const big = app.phoneHelper!.request('camera', { reason: 'x' });
  await until(() => p.got.some((e) => e.kind === 'camera' && e.state === 'asking'));
  const id = p.got.filter((e) => e.kind === 'camera' && e.state === 'asking').at(-1)!.id;
  const huge = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(IMAGE_MAX_BYTES + 10)]).toString('base64')}`;
  const res = await req(`/api/phone-helper/requests/${id}`, { method: 'POST', body: { allow: true, image: huge }, headers: cookieOf(phone) });
  assert.equal(res.status, 413);
  const r = await big;
  assert.equal(!r.ok && r.outcome, 'error');
  p.close();
  assert.deepEqual(rows('phone.location').map((x) => x.outcome), ['refused']);
  assert.deepEqual(rows('phone.screen').map((x) => x.outcome), ['failed']);
});

test('owner only: a household member gets 403; the demo has none', async () => {
  const r = await fetch(`${mbase}/api/phone-helper`, { headers: { authorization: `Bearer ${mToken}` } });
  assert.equal(r.status, 403);
});

test('the pin: opting in is refused (409), the page says so, the phone is never asked', async () => {
  await req('/api/phone-helper', { method: 'PUT', body: { helper: false }, headers: cookieOf(phone) });
  pol.set({ name: 'Family rules', pins: { phoneHelper: false } });
  const res = await req('/api/phone-helper', { method: 'PUT', body: { helper: true }, headers: cookieOf(phone) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).policy.key, 'phoneHelper');
  const v = await (await req('/api/phone-helper', { headers: cookieOf(phone) })).json();
  assert.equal(v.pinned, true);
  const r = await app.phoneHelper!.request('camera', { reason: 'x' });
  assert.equal(!r.ok && r.outcome, 'off');
  pol.set({ name: 'Family rules', pins: {} });
});

test('signing the device out drops it from the helpers', async () => {
  await req('/api/phone-helper', { method: 'PUT', body: { helper: true }, headers: cookieOf(phone) });
  assert.equal(app.phoneHelper!.devices().length, 1);
  const id = auth.devices().find((d) => d.label === 'Chrome on Android')!.id;
  await req(`/api/devices/${id}`, { method: 'DELETE', headers: cookieOf(laptop) });
  assert.equal(app.phoneHelper!.devices().length, 0);
  assert.equal(app.phoneHelper!.available(), false);
});

// 2.7.1: real on/off switches on Today's Home tile (owner decision). POST /api/home/entities/<id>/toggle
// switches lights, switches, fans and blinds for the owner with no approval card, reads the state
// back, and refuses everything sensitive (locks, alarms, garage doors, gates, doors), the demo,
// household members and unknown devices. Home Assistant is a fake behind setNetTransport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { switchPlan } from '../src/home-switch.ts';
import { memberRouteCheck, MEMBER_ROUTES, type MemberRecord } from '../src/household.ts';
import { setNetTransport } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { HOME_VAULT, type HaState } from '../src/tools/home.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const HA = 'http://ha.test:8123';
const TOKEN = 'ha-token-0123456789abcdefghij';
type Dev = { entity_id: string; state: string; attributes: Record<string, unknown> };
const devices = new Map<string, Dev>();
const calls: { path: string; body?: unknown; auth?: string }[] = [];
let ignoreServices = false;
const reset = () => {
  devices.clear();
  calls.length = 0;
  ignoreServices = false;
  for (const d of [
    { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
    { entity_id: 'switch.coffee', state: 'on', attributes: { friendly_name: 'Coffee machine' } },
    { entity_id: 'fan.bedroom', state: 'off', attributes: { friendly_name: 'Bedroom fan' } },
    { entity_id: 'cover.living_blinds', state: 'closed', attributes: { friendly_name: 'Living room blinds', device_class: 'blind' } },
    { entity_id: 'cover.garage', state: 'closed', attributes: { friendly_name: 'Garage', device_class: 'garage' } },
    { entity_id: 'cover.mystery', state: 'closed', attributes: { friendly_name: 'Something' } },
    { entity_id: 'switch.garage_door', state: 'off', attributes: { friendly_name: 'Garage opener' } },
    { entity_id: 'switch.relay_2', state: 'off', attributes: { friendly_name: 'Front door lock relay' } },
    { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: 'Front door' } },
    { entity_id: 'alarm_control_panel.home', state: 'armed_away', attributes: { friendly_name: 'Alarm' } },
    { entity_id: 'climate.hall', state: 'heat', attributes: { friendly_name: 'Hall' } },
    { entity_id: 'light.porch', state: 'unavailable', attributes: { friendly_name: 'Porch' } },
  ]) devices.set(d.entity_id, structuredClone(d));
};

/** The fake Home Assistant: states and services, with the owner's token required. */
const fakeHa = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get('authorization') ?? undefined;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path: url.pathname, body, auth });
  if (url.origin !== HA) return new Response('wrong host', { status: 599 });
  if (auth !== `Bearer ${TOKEN}`) return new Response('401', { status: 401 });
  if (url.pathname === '/api/states') return Response.json([...devices.values()]);
  const st = /^\/api\/states\/(.+)$/.exec(url.pathname);
  if (st) {
    const d = devices.get(st[1]);
    return d ? Response.json(d) : new Response('Entity not found.', { status: 404 });
  }
  const sv = /^\/api\/services\/(\w+)\/(\w+)$/.exec(url.pathname);
  if (sv && (init?.method ?? 'GET') === 'POST') {
    const d = devices.get(String(body?.entity_id));
    if (d && !ignoreServices) {
      const s = sv[2];
      d.state = s === 'turn_on' ? 'on' : s === 'turn_off' ? 'off' : s === 'open_cover' ? 'open' : s === 'close_cover' ? 'closed' : s === 'toggle' ? (d.state === 'on' ? 'off' : 'on') : d.state;
    }
    return Response.json([]);
  }
  return new Response('no', { status: 404 });
}) as typeof fetch;

const closers: (() => void)[] = [];
type App = TestApp & { dir: string };
function setupApp(): App {
  const t = tempDir();
  const app = makeApp(t.dir, { now: new Date() });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString(), home: { url: HA } });
  app.vault.set(HOME_VAULT, TOKEN);
  closers.push(() => {
    app.store.close();
    t.cleanup();
  });
  return Object.assign(app, { dir: t.dir });
}
const owner = setupApp();
const auth = new OwnerAuth(owner.dir);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') });
const demoApp = setupApp();
const demo = createSaraServer({ app: demoApp, auth: new OwnerAuth(demoApp.dir), webDir: join(ROOT, 'web'), demo: true });
let base = '';
let demoBase = '';
before(async () => {
  setNetTransport(fakeHa);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  demoBase = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
});
after(() => {
  setNetTransport();
  server.close();
  demo.close();
  for (const c of closers.reverse()) c();
});
const api = async (method: string, path: string, body?: unknown, b = base, token = ownerToken) => {
  const r = await fetch(`${b}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: b }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const toggle = (id: string, body: unknown = {}, b = base) => api('POST', `/home/entities/${encodeURIComponent(id)}/toggle`, body, b);
const services = () => calls.filter((c) => c.path.startsWith('/api/services/'));

test('switchPlan: lights, switches, fans and blinds switch here; everything sensitive keeps Ask Sara', () => {
  const s = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState => ({ entity_id, state, attributes });
  assert.deepEqual(switchPlan(s('light.kitchen', 'off')), { ok: true, domain: 'light', service: 'turn_on', to: 'on' });
  assert.deepEqual(switchPlan(s('light.kitchen', 'on')), { ok: true, domain: 'light', service: 'turn_off', to: 'off' });
  assert.deepEqual(switchPlan(s('light.kitchen', 'on'), 'on'), { ok: true, domain: 'light', service: 'turn_on', to: 'on' }, 'the switch position wins over a stale state');
  assert.equal(switchPlan(s('switch.coffee', 'on')).ok, true);
  assert.equal(switchPlan(s('fan.bedroom', 'off')).ok, true);
  assert.equal(switchPlan(s('input_boolean.guest_mode', 'off')).ok, true);
  assert.deepEqual(switchPlan(s('cover.blinds', 'closed', { device_class: 'blind' })), { ok: true, domain: 'cover', service: 'open_cover', to: 'open' });
  assert.deepEqual(switchPlan(s('cover.blinds', 'open', { device_class: 'shade' })), { ok: true, domain: 'cover', service: 'close_cover', to: 'closed' });
  for (const [id, state, attrs] of [
    ['lock.front', 'locked', {}],
    ['alarm_control_panel.home', 'armed_away', {}],
    ['climate.hall', 'heat', {}],
    ['media_player.tv', 'on', {}],
    ['scene.movie', 'scening', {}],
    ['cover.garage', 'closed', { device_class: 'garage' }],
    ['cover.gate', 'closed', { device_class: 'gate' }],
    ['cover.front', 'closed', { device_class: 'door' }],
    ['cover.window', 'closed', { device_class: 'window' }],
    ['cover.mystery', 'closed', {}],
    ['switch.garage_door', 'off', {}],
    ['switch.relay_2', 'off', { friendly_name: 'Front door lock relay' }],
    ['switch.siren', 'off', {}],
    ['light.gate_lamp', 'off', {}],
  ] as const) assert.deepEqual(switchPlan(s(id, state, attrs)), { ok: false, why: 'ask' }, id);
  assert.deepEqual(switchPlan(s('light.porch', 'unavailable')), { ok: false, why: 'unreachable' });
  assert.deepEqual(switchPlan(s('light.outdoor', 'off')).ok, true, '"outdoor" is not a door');
});

test('the owner switches a light, a switch, a fan and a blind: no approval card, the state is read back', async () => {
  reset();
  const pending = owner.store.listConversations().length;
  const on = await toggle('light.kitchen');
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { id: 'light.kitchen', name: 'Kitchen', state: 'on', was: 'off', asked: 'on' });
  assert.deepEqual(services().map((c) => [c.path, c.body]), [['/api/services/light/turn_on', { entity_id: 'light.kitchen' }]]);
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`), 'the owner’s Home Assistant token');
  // Read before and after the change.
  assert.deepEqual(calls.map((c) => c.path), ['/api/states/light.kitchen', '/api/services/light/turn_on', '/api/states/light.kitchen']);
  assert.equal((await toggle('switch.coffee', { to: 'off' })).json.state, 'off');
  assert.equal((await toggle('fan.bedroom')).json.state, 'on');
  const blind = await toggle('cover.living_blinds');
  assert.equal(blind.status, 200);
  assert.equal(blind.json.state, 'open');
  assert.equal(owner.store.listConversations().length, pending, 'no conversation, message or approval was made');
  // A device that ignores the call: the answer is the real state, not what was asked.
  ignoreServices = true;
  const stuck = await toggle('light.kitchen', { to: 'off' });
  assert.equal(stuck.status, 200);
  assert.equal(stuck.json.state, 'on');
  assert.equal(stuck.json.asked, 'off');
});

test('sensitive devices are refused with Ask Sara, and nothing is sent to Home Assistant', async () => {
  reset();
  for (const id of ['lock.front', 'alarm_control_panel.home', 'cover.garage', 'cover.mystery', 'switch.garage_door', 'switch.relay_2', 'climate.hall']) {
    const r = await toggle(id);
    assert.equal(r.status, 403, id);
    assert.equal(r.json.askSara, true, id);
    assert.match(String(r.json.error), /Ask Sara/);
  }
  assert.equal(services().length, 0, 'no service was called');
  assert.equal(devices.get('lock.front')?.state, 'locked');
  const away = await toggle('light.porch');
  assert.equal(away.status, 409, 'unreachable device');
  assert.equal(services().length, 0);
});

test('unknown devices 404, bad ids 400, not connected 400', async () => {
  reset();
  assert.equal((await toggle('light.nowhere')).status, 404);
  assert.equal((await toggle('Light.Kitchen')).status, 400);
  assert.equal((await toggle('light.kitchen;rm')).status, 400);
  assert.equal((await api('GET', '/home/entities/light.kitchen/toggle')).status, 404, 'POST only');
  assert.equal(services().length, 0);
  owner.vault.delete(HOME_VAULT);
  try {
    assert.equal((await toggle('light.kitchen')).status, 400);
  } finally {
    owner.vault.set(HOME_VAULT, TOKEN);
  }
});

test('the entity list tells the tile what may switch here', async () => {
  reset();
  const r = await api('GET', '/home/entities?domains=light,switch,climate,lock,cover,fan');
  assert.equal(r.status, 200);
  const can = Object.fromEntries((r.json.entities as { id: string; canSwitch: boolean }[]).map((e) => [e.id, e.canSwitch]));
  assert.deepEqual(can, { 'light.kitchen': true, 'switch.coffee': true, 'fan.bedroom': true, 'cover.living_blinds': true, 'cover.garage': false, 'cover.mystery': false, 'switch.garage_door': false, 'switch.relay_2': false, 'lock.front': false, 'climate.hall': false, 'light.porch': true });
});

test('never on the demo; household members are refused (no Home Assistant routes for members)', async () => {
  reset();
  const d = await toggle('light.kitchen', {}, demoBase);
  assert.ok([401, 403].includes(d.status), `demo: ${d.status}`);
  assert.equal(services().length, 0);
  assert.equal(MEMBER_ROUTES.has('home'), false);
  const rec = { id: 'm1', status: 'active', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(rec, 'POST', ['home', 'entities', 'light.kitchen', 'toggle'])?.ownerOnly, true);
  // And through a real member server: 403 before anything reaches Home Assistant.
  const mApp = setupApp();
  const mAuth = new OwnerAuth(mApp.dir);
  const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => rec, apps: () => [mApp], deleteSelf: async () => {} } });
  await new Promise<void>((r) => msrv.listen(0, '127.0.0.1', r));
  try {
    const mb = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
    const m = await api('POST', '/home/entities/light.kitchen/toggle', {}, mb, mAuth.newToken!);
    assert.equal(m.status, 403);
    assert.equal(m.json.ownerOnly, true);
    assert.equal(services().length, 0);
  } finally {
    msrv.close();
  }
});

test('the tile: a real switch for what may switch, Ask Sara for the rest, the result under the name', () => {
  const js = readFileSync(join(ROOT, 'web', 'today.js'), 'utf8');
  assert.match(js, /if \(e\.canSwitch\) \{/);
  assert.match(js, /sw\.setAttribute\('role', 'switch'\);/);
  assert.match(js, /sw\.setAttribute\('aria-checked', String\(isOnState\(state\)\)\);/);
  assert.match(js, /ctx\.api\(`\/home\/entities\/\$\{encodeURIComponent\(e\.id\)\}\/toggle`, \{ method: 'POST', body: \{ to \} \}\)/);
  assert.match(js, /st\.setAttribute\('aria-live', 'polite'\);/);
  assert.match(js, /btn\('td-dev-ask ghost small', t\('Ask Sara'\), \(\) => askAbout\(e\)\)/, 'Ask Sara stays for the rest');
  assert.doesNotMatch(js, /confirm\(/, 'no confirm step');
  // Still hidden for members and on the demo.
  assert.match(js, /if \(!h \|\| ctx\.demo\(\) \|\| ctx\.member\(\)\) \{\s*tile\.hidden = true;/);
  const css = readFileSync(join(ROOT, 'web', 'today.css'), 'utf8');
  assert.match(css, /\.td-dev-switch \{[^}]*height: 44px;/, '44 px target');
});

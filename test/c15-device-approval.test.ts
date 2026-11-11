// C15 (docs/ops/C15_DESIGN.md): approve a new device from chat. Codes (5 characters, nothing
// ambiguous, case-insensitive), what counts as remote (tunnel and proxy headers, a foreign Host even
// from 127.0.0.1), the DNS rebinding host check, a remote sign-in that waits for the owner (the
// asking device can't approve itself; 10 minutes = no), the Telegram/Discord reply, sensitive
// actions from a remote device asking first, the device list rules (unused 30 days, max devices,
// a notice on a new address, revoke cuts open streams), and what must keep working (local sign-in,
// pairing, API keys, approval off, the first device of a fresh install).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { answerFromChat, CODE_ALPHABET, DeviceApprovals, hostAllowed, initialDeviceApproval, isRemoteRequest, newCode, normCode, parseApprovalReply } from '../src/device-approval.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const fakeReq = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

test('codes: 5 characters, no look-alikes (0/O, 1/I/L, 5/S, 2/Z, 8/B), answered in any case', () => {
  for (const ch of '0O1IL5S2Z8B') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  for (let i = 0; i < 200; i++) assert.match(newCode(), new RegExp(`^[${CODE_ALPHABET}]{5}$`));
  assert.equal(normCode(' k7q-2m '), 'K7Q2M');
  assert.deepEqual(parseApprovalReply('approve k7qcm'), { yes: true, code: 'K7QCM' });
  assert.deepEqual(parseApprovalReply('Deny K7QCM'), { yes: false, code: 'K7QCM' });
  assert.deepEqual(parseApprovalReply('deny'), { yes: false });
  assert.equal(parseApprovalReply('approve'), undefined, 'approve needs the code');
  assert.equal(parseApprovalReply('I approve of this plan'), undefined);
});

test('remote: any tunnel or proxy header, a foreign Host, or another computer; local only when plainly local', () => {
  assert.equal(isRemoteRequest(fakeReq('127.0.0.1', { host: 'localhost:8080' })), false);
  assert.equal(isRemoteRequest(fakeReq('::1', { host: '[::1]:8080' })), false);
  assert.equal(isRemoteRequest(fakeReq('::ffff:127.0.0.1', { host: '127.0.0.1:8080' })), false);
  for (const h of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'tailscale-user-login']) assert.equal(isRemoteRequest(fakeReq('127.0.0.1', { host: 'localhost', [h]: '203.0.113.9' })), true, h);
  assert.equal(isRemoteRequest(fakeReq('127.0.0.1', { host: 'sara.example.com' })), true, 'a Host other than localhost');
  assert.equal(isRemoteRequest(fakeReq('192.168.1.20', { host: 'localhost' })), true);
});

test('host check (DNS rebinding): a foreign name straight to 127.0.0.1 is refused; allowed hosts pin the names', () => {
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: 'evil.example:8080' }), []), false);
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: 'localhost:8080' }), []), true);
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: '192.168.1.5:8080' }), []), true);
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: 'sara.example.com', 'x-forwarded-for': '1.2.3.4' }), []), true, 'through a proxy (and then remote)');
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: 'evil.example', 'x-forwarded-for': '1.2.3.4' }), ['sara.example.com']), false);
  assert.equal(hostAllowed(fakeReq('127.0.0.1', { host: 'sara.example.com' }), ['sara.example.com']), true);
  assert.equal(hostAllowed(fakeReq('10.0.0.2', { host: 'pc.tail1234.ts.net' }), ['.ts.net']), true);
});

test('requests: the asking device never answers itself; 10 minutes = no; "deny" refuses all; a grant works once', () => {
  const clock = { now: new Date('2026-11-08T12:00:00Z') };
  const ap = new DeviceApprovals(() => clock.now);
  const r = ap.request('sign-in', { sessionId: 'new', label: 'Chrome on Windows', ip: '203.0.113.9' });
  assert.equal(ap.answer(r.code, true, { sessionId: 'new', channel: 'app' }), 'self');
  assert.equal(ap.answer(r.code.toLowerCase(), true, { sessionId: 'old', channel: 'app' }), 'approved');
  const late = ap.request('sign-in', { sessionId: 'b', label: 'x', ip: '1.1.1.1' });
  clock.now = new Date(clock.now.getTime() + 10 * 60_000 + 1);
  assert.equal(ap.answer(late.code, true, { channel: 'telegram' }), 'expired');
  ap.request('sign-in', { sessionId: 'c', label: 'x', ip: '1.1.1.1' });
  ap.request('sign-in', { sessionId: 'd', label: 'x', ip: '1.1.1.1' });
  assert.deepEqual(answerFromChat(ap, 'deny', 'discord'), { text: 'Refused {n} request(s). That device is not signed in.', params: { n: 2 } });
  const act = ap.request('action', { sessionId: 'old', label: 'x', ip: '1.1.1.1', action: 'password' });
  assert.equal(ap.takeGrant('old', 'password'), false);
  assert.equal(answerFromChat(ap, `approve ${act.code.toLowerCase()}`, 'telegram')?.text, 'Approved.');
  assert.equal(ap.takeGrant('old', 'password'), true);
  assert.equal(ap.takeGrant('old', 'password'), false, 'once');
  assert.deepEqual(initialDeviceApproval(false), { on: true });
  assert.deepEqual(initialDeviceApproval(true), { on: false, notice: true });
});

test('the bridges answer only from the verified owner in a private chat', () => {
  const tg = readFileSync(join(ROOT, 'src/bridges/telegram.ts'), 'utf8');
  assert.match(tg, /isPrivate && isTelegramOwner\(cfg, msg\.from\.id\)[^\n]*answerFromChat/);
  const dc = readFileSync(join(ROOT, 'src/bridges/discord.ts'), 'utf8');
  assert.match(dc, /!guildId && isDiscordOwner\([^\n]*answerFromChat/);
});

// ---------------- the server ----------------

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-08T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const told: string[] = [];
let base = '';
before(async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), deviceApproval: { on: true } } as never);
  app.bridges = { telegram: { toOwner: async (t: string) => (told.push(t), true) } } as never;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };
async function call(path: string, o: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const r = await fetch(base + path, { method: o.method ?? 'GET', headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const set = r.headers.get('set-cookie');
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, cookie: set ? set.split(';')[0] : undefined };
}
const login = (headers: Record<string, string> = {}) => call('/api/login', { method: 'POST', body: { token }, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ...headers } });

let trusted = '';
test('the first device of a fresh install signs in from anywhere (nothing to approve it from yet)', async () => {
  const r = await login(REMOTE);
  assert.equal(r.status, 200);
  trusted = r.cookie!;
  assert.equal((await call('/api/session', { cookie: trusted })).json.authenticated, true);
});

test('a remote sign-in waits for the owner; it cannot approve itself; a trusted device approves with its code', async () => {
  told.length = 0;
  const r = await login(REMOTE);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const { code } = r.json.pendingApproval;
  assert.match(code, /^[A-Z0-9]{5}$/);
  const pend = r.cookie!;
  const s = await call('/api/session', { cookie: pend });
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.pendingApproval.code, code);
  assert.equal((await call('/api/conversations', { cookie: pend })).status, 401, 'a waiting device can do nothing');
  assert.equal((await call(`/api/device-approvals/${code}`, { method: 'POST', body: { approve: true }, cookie: pend })).status, 401, 'never approves itself');
  // The trusted device sees the request, without the code; Telegram got the prompt, without the code.
  const list = await call('/api/device-approvals', { cookie: trusted });
  assert.equal(list.json.requests.length, 1);
  assert.equal(list.json.requests[0].code, undefined);
  assert.match(told.join('\n'), /A new device wants to sign in/);
  assert.ok(!told.join('\n').includes(code), 'the code is only on the asking device');
  assert.equal((await call(`/api/device-approvals/${code.toLowerCase()}`, { method: 'POST', body: { approve: true }, cookie: trusted })).status, 200);
  assert.equal((await call('/api/session', { cookie: pend })).json.authenticated, true);
  assert.equal((await call('/api/conversations', { cookie: pend })).status, 200);
});

test('10 minutes without an answer: the waiting device is signed out', async () => {
  const r = await login({ ...REMOTE, 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(r.status, 202);
  clock.now = new Date(clock.now.getTime() + 11 * 60_000);
  const s = await call('/api/session', { cookie: r.cookie });
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.pendingApproval?.state, 'expired');
  assert.equal((await call(`/api/device-approvals/${r.json.pendingApproval.code}`, { method: 'POST', body: { approve: true }, cookie: trusted })).status, 410);
});

test('Telegram "approve CODE" from the owner approves a waiting sign-in', async () => {
  const r = await login(REMOTE);
  assert.equal(r.status, 202);
  assert.equal(answerFromChat(app.deviceApprovals, `approve ${r.json.pendingApproval.code.toLowerCase()}`, 'telegram')?.text, 'Approved.');
  assert.equal((await call('/api/session', { cookie: r.cookie })).json.authenticated, true);
});

test('local sign-in, pairing codes, API keys and the switch off keep working as before', async () => {
  assert.equal((await login()).status, 200, 'this computer');
  // Pairing: the code was made on a trusted device, so it is already the approval.
  const pair = await call('/api/pair', { method: 'POST', body: {}, cookie: trusted });
  assert.equal(pair.status, 200, JSON.stringify(pair.json));
  assert.equal((await call('/api/pair/redeem', { method: 'POST', body: { code: pair.json.code }, headers: REMOTE })).status, 200);
  assert.equal((await call('/api/conversations', { headers: { authorization: `Bearer ${token}`, ...REMOTE } })).status, 401, 'the owner token as a header from elsewhere would skip the approval');
  assert.equal((await call('/api/conversations', { headers: { authorization: `Bearer ${token}` } })).status, 200, 'on this computer it works');
  const key = auth.createApiKey('Open WebUI').token;
  assert.equal((await call('/v1/models', { headers: { authorization: `Bearer ${key}`, ...REMOTE } })).status, 200, 'API keys are not devices');
  app.settings.update({ deviceApproval: { on: false } } as never);
  assert.equal((await login(REMOTE)).status, 200);
  app.settings.update({ deviceApproval: { on: true } } as never);
});

test('sensitive actions from a remote device ask the owner first; from this computer they do not', async () => {
  const rem = await login(REMOTE);
  await call(`/api/device-approvals/${rem.json.pendingApproval.code}`, { method: 'POST', body: { approve: true }, cookie: trusted });
  const remote = rem.cookie!;
  // A check only looks (the app does one by itself every hour): never an unasked prompt.
  assert.notEqual((await call('/api/update', { method: 'POST', body: { action: 'check' }, cookie: remote, headers: REMOTE })).status, 428, 'a check never asks');
  const ask = await call('/api/update', { method: 'POST', body: { action: 'update' }, cookie: remote, headers: REMOTE });
  assert.equal(ask.status, 428, JSON.stringify(ask.json));
  assert.equal(ask.json.approval.action, 'restart');
  const code = ask.json.approval.code;
  assert.equal((await call(`/api/device-approvals/${code}`, { method: 'POST', body: { approve: true }, cookie: remote, headers: REMOTE })).status, 403, 'not from the asking device');
  assert.equal((await call(`/api/device-approvals/${code}/status`, { cookie: remote, headers: REMOTE })).json.state, 'pending');
  assert.equal((await call(`/api/device-approvals/${code}`, { method: 'POST', body: { approve: true }, cookie: trusted })).status, 200);
  assert.notEqual((await call('/api/update', { method: 'POST', body: { action: 'update' }, cookie: remote, headers: REMOTE })).status, 428);
  assert.equal((await call('/api/update', { method: 'POST', body: { action: 'update' }, cookie: remote, headers: REMOTE })).status, 428, 'one approval, one action');
  assert.equal((await call('/api/owner-token/rotate', { method: 'POST', body: { current: 'x' }, cookie: remote, headers: REMOTE })).status, 428);
  assert.equal((await call('/api/bridges/telegram', { method: 'PUT', body: { token: '' }, cookie: remote, headers: REMOTE })).status, 428);
  assert.equal((await call('/api/device-approval', { method: 'PUT', body: { on: false }, cookie: remote, headers: REMOTE })).status, 428);
  assert.notEqual((await call('/api/update', { method: 'POST', body: { action: 'update' }, cookie: trusted })).status, 428, 'this computer');
});

test('host check: a foreign Host straight to 127.0.0.1 gets 421', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    const rq = httpRequest({ host: '127.0.0.1', port: u.port, path: '/api/session', headers: { host: `evil.example:${u.port}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    rq.on('error', reject);
    rq.end();
  });
  assert.equal(status, 421);
});

test('device list: a notice on a new address, max devices, unused 30 days signed out, revoke cuts the open stream', async () => {
  told.length = 0;
  const r = await login({ 'x-forwarded-for': '192.0.2.44' });
  await call(`/api/device-approvals/${r.json.pendingApproval.code}`, { method: 'POST', body: { approve: true }, cookie: trusted });
  assert.match(told.join('\n'), /signed in from a new address/i);
  // Revoke: the device's open event stream ends at once.
  const id = (await call('/api/devices', { cookie: r.cookie })).json.devices.find((d: any) => d.current).id;
  const ended = new Promise<boolean>((resolve) => {
    const u = new URL(base);
    const rq = httpRequest({ host: '127.0.0.1', port: u.port, path: '/api/events', headers: { cookie: r.cookie!, 'x-forwarded-for': '192.0.2.44' } }, (res) => {
      res.on('data', () => undefined);
      res.on('close', () => resolve(true));
      res.on('error', () => resolve(true));
      setTimeout(() => void call(`/api/devices/${id}`, { method: 'DELETE', cookie: trusted }), 100);
    });
    rq.on('error', () => resolve(true));
    rq.end();
  });
  assert.equal(await Promise.race([ended, new Promise((r2) => setTimeout(() => r2(false), 4000))]), true);
  // Max devices: the oldest browser sign-ins go; API keys stay.
  app.settings.update({ deviceApproval: { on: true, maxDevices: 3 } } as never);
  for (let i = 0; i < 4; i++) await login();
  const devs = auth.devices();
  assert.equal(devs.filter((d) => d.kind === 'browser' || d.kind === 'app').length, 3);
  assert.ok(devs.some((d) => d.kind === 'api'));
  // Unused for 30 days: signed out.
  const last = (await login()).cookie!;
  clock.now = new Date(clock.now.getTime() + 31 * 24 * 3600_000);
  assert.equal((await call('/api/session', { cookie: last })).json.authenticated, false);
});

test('settings: the switch, allowed hosts and max devices; turning it off from this computer needs no approval', async () => {
  const fresh = (await login()).cookie!;
  const put = await call('/api/device-approval', { method: 'PUT', body: { on: true, allowedHosts: 'Sara.Example.com, .ts.net', maxDevices: 5 }, cookie: fresh });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(put.json.allowedHosts, ['sara.example.com', '.ts.net']);
  assert.equal(put.json.maxDevices, 5);
  assert.equal((await call('/api/device-approval', { method: 'PUT', body: { on: false }, cookie: fresh })).json.on, false);
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { proxyTrust } from '../src/http.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'sara-business-'));
async function modules() {
  const profile = await import('../src/business/profile.ts').catch(() => undefined);
  const identity = await import('../src/business/identity.ts').catch(() => undefined);
  const runtime = await import('../src/business/runtime.ts').catch(() => undefined);
  assert.ok(profile && identity && runtime, 'Independent business profile modules must exist');
  return { ...profile, ...identity, ...runtime };
}

test('business roots reject personal state, ancestor household state, and symlink escape', async () => {
  const { openBusinessProfile } = await modules();
  const dir = scratch();
  try {
    for (const file of ['owner.json', 'household.json', 'settings.json', 'sara.db']) {
      const root = join(dir, file.replace('.', '-')); mkdirSync(root);
      writeFileSync(join(root, file), '{}');
      assert.throws(() => openBusinessProfile(root), /personal|empty|household/i);
      assert.equal(existsSync(join(root, 'profile.json')), false);
    }
    const personal = join(dir, 'personal'); mkdirSync(personal); writeFileSync(join(personal, 'owner.json'), '{}');
    assert.throws(() => openBusinessProfile(join(personal, 'business')), /personal|household/i);
    const fresh = join(dir, 'fresh'); openBusinessProfile(fresh);
    const outside = join(dir, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(fresh, 'business', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => openBusinessProfile(fresh), /link|escape/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claim creates an independent UUID browser identity and rejects forged/personal/legacy credentials', async () => {
  const { openBusinessProfile, BusinessIdentityDirectory, BusinessAuth } = await modules();
  const dir = scratch();
  try {
    const profile = openBusinessProfile(join(dir, 'business'));
    const identities = new BusinessIdentityDirectory(profile);
    try {
      const auth = new BusinessAuth(profile, identities);
      assert.equal(auth.principal(undefined), undefined);
      assert.equal(auth.claim('127.0.0.1', 'wrong', 'Alex'), undefined);
      assert.equal(auth.claim('127.0.0.1', auth.claimCode, 'Alex', false), undefined);
      const claimed = auth.claim('127.0.0.1', auth.claimCode, 'Alex', true); assert.ok(claimed);
      assert.match(claimed.principal.identityId, /^[0-9a-f-]{36}$/);
      assert.equal(claimed.principal.credentialKind, 'browser');
      assert.equal(auth.claim('127.0.0.1', auth.claimCode, 'Again'), undefined);
      assert.equal(identities.firstIdentityId(), claimed.principal.identityId);
      assert.deepEqual(auth.principal(claimed.value), claimed.principal);
      for (const value of ['', 'sara_m.member.fake', 'sara_dev.fake.secret', 'forged', claimed.value + 'x']) assert.equal(auth.principal(value), undefined);
      mkdirSync(join(dir, 'personal'));
      const personal = new OwnerAuth(join(dir, 'personal'));
      assert.equal(auth.principal(personal.createSession().value), undefined);
      assert.equal(auth.principal(personal.newToken), undefined);
      const imported = identities.create('Imported');
      const importedDir = join(profile.businessDir, 'auth', imported.id, '0'); mkdirSync(importedDir, { recursive: true });
      writeFileSync(join(importedDir, 'owner.json'), readFileSync(join(dir, 'personal', 'owner.json')));
      assert.equal(auth.principal(`${imported.id}.0.${personal.createSession().value}`), undefined);
      assert.throws(() => auth.createIdentity('Taylor', false), /adult|18/i);
      const other = auth.createIdentity('Taylor', true);
      assert.notEqual(other.principal.identityId, claimed.principal.identityId);
      assert.equal(auth.principal(other.value)?.identityId, other.principal.identityId);
      identities.database.prepare('UPDATE business_identities SET auth_epoch = auth_epoch + 1 WHERE id = ?').run(claimed.principal.identityId);
      assert.equal(auth.principal(claimed.value), undefined);
      assert.equal(auth.principal(claimed.value.replace('.0.', '.1.')), undefined);
      identities.database.prepare("UPDATE business_identities SET status = 'disabled' WHERE id = ?").run(other.principal.identityId);
      assert.equal(auth.principal(other.value), undefined);
      const restarted = new BusinessAuth(profile, identities);
      assert.equal(restarted.claimCode, undefined);
    } finally { identities.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('business HTTP runtime is origin-bound and denies all unsupported entry paths', async () => {
  const { openBusinessProfile, createBusinessRuntime } = await modules();
  const dir = scratch();
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const probeAddress = probe.address(); assert.ok(probeAddress && typeof probeAddress === 'object'); const port = probeAddress.port;
  await new Promise<void>(r => probe.close(() => r()));
  const runtime = createBusinessRuntime({ profile: openBusinessProfile(dir), origin: `http://127.0.0.1:${port}` });
  try {
    await new Promise<void>(r => runtime.server.listen(port, '127.0.0.1', r));
    const address = runtime.server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { origin: runtime.origin, host: new URL(runtime.origin).host, 'content-type': 'application/json' };
    const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
    assert.equal((await request('/api/business/claim', { method: 'POST', headers: { origin: 'https://personal.invalid' }, body: '{}' })).status, 403);
    const missingConfirmation = await request('/api/business/claim', { method: 'POST', body: JSON.stringify({ code: runtime.auth.claimCode, name: 'Alex' }) });
    assert.equal(missingConfirmation.status, 400);
    const claim = await request('/api/business/claim', { method: 'POST', body: JSON.stringify({ code: runtime.auth.claimCode, name: 'Alex', confirm18: true }) });
    assert.equal(claim.status, 201);
    const cookie = claim.headers.get('set-cookie')!; assert.match(cookie, /sara_business_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const signed = { cookie: cookie.split(';')[0] };
    assert.equal((await request('/api/business/me', { headers: signed })).status, 200);
    assert.equal((await request('/api/business/me', { headers: { cookie: signed.cookie.replace('sara_business_session', 'sara_session') } })).status, 401);
    assert.equal((await request('/api/business/me', { headers: { authorization: 'Bearer sara_dev.fake.secret' } })).status, 401);
    for (const path of ['/v1/models', '/mcp', '/api/chat', '/api/events', '/api/voice', '/api/hands', '/api/device/code', '/api/preview/anything', '/api/telegram', '/a2a']) {
      assert.equal((await request(path, { headers: signed })).status, 404, path);
    }
    const registration = await request('/api/business/passkeys/register/options', { method: 'POST', headers: signed, body: '{}' });
    assert.equal(registration.status, 200);
    const { challenge } = await registration.json() as { challenge: string };
    const key = new BusinessAuthenticator();
    assert.equal((await request('/api/business/passkeys/register/finish', { method: 'POST', headers: signed, body: JSON.stringify({ challenge, response: key.register(challenge, runtime.origin) }) })).status, 200);
    const discovery = await request('/api/business/passkeys/login/options', { method: 'POST', body: '{}' });
    const login = await discovery.json() as { challenge: string };
    const secondBrowser = await request('/api/business/passkeys/login/finish', { method: 'POST', body: JSON.stringify({ challenge: login.challenge, response: key.assertion(login.challenge, runtime.origin) }) });
    assert.equal(secondBrowser.status, 200);
    assert.equal((await request('/api/business/me', { headers: { cookie: secondBrowser.headers.get('set-cookie')!.split(';')[0] } })).status, 200);
    assert.equal((await request('/api/business/logout', { method: 'POST', headers: { ...signed, origin: '' }, body: '{}' })).status, 403);
    assert.equal((await request('/api/business/me', { headers: { cookie: signed.cookie + '; ' + signed.cookie } })).status, 401);
    assert.equal((await request('/api/business/logout', { method: 'POST', headers: signed, body: '{}' })).status, 200);
    assert.equal((await request('/api/business/me', { headers: signed })).status, 401);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actual main CLI dispatch starts business without constructing personal stores or workers', async () => {
  const dir = scratch();
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: dir, SARA_HOST: '127.0.0.1', SARA_PORT: '0', SARA_BUSINESS_ORIGIN: 'http://127.0.0.1:17863' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', b => { output += String(b); }); child.stderr!.on('data', b => { output += String(b); });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const until = setTimeout(() => reject(new Error('No business startup banner: ' + output)), 20_000);
      const timer = setInterval(() => { if (/Business listening/.test(output)) { clearTimeout(until); clearInterval(timer); resolveReady(); } }, 50);
      child.once('exit', code => { clearTimeout(until); clearInterval(timer); reject(new Error(`CLI exited ${code}: ${output}`)); });
    });
    assert.equal(existsSync(join(dir, 'owner.json')), false);
    assert.equal(existsSync(join(dir, 'settings.json')), false);
    assert.deepEqual(readdirSync(dir).sort(), ['business', 'profile.json']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).profile, 'business');
  } finally { child.kill(); await new Promise<void>(r => child.exitCode !== null ? r() : child.once('exit', () => r())); rmSync(dir, { recursive: true, force: true }); }
});

test('business version stays read-only and unrecognized profiles fail before owner initialization', () => {
  const dir = scratch();
  try {
    const version = spawnSync(process.execPath, ['src/main.ts', '--version'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: dir }, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr); assert.match(version.stdout, /Sara \d+\./);
    assert.deepEqual(readdirSync(dir), []);
    const invalid = spawnSync(process.execPath, ['src/main.ts'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, SARA_PROFILE: 'busines', SARA_DATA: dir }, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /SARA_PROFILE/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('individual discoverable passkeys survive restart, bind origin, consume challenges, and respect epoch/disable', async () => {
  const { openBusinessProfile, BusinessIdentityDirectory, BusinessAuth } = await modules();
  const dir = scratch(); const profile = openBusinessProfile(dir); const identities = new BusinessIdentityDirectory(profile);
  const origin = 'https://business.example.test';
  try {
    let auth = new BusinessAuth(profile, identities);
    const session = auth.claim('127.0.0.1', auth.claimCode, 'Alex', true)!;
    const key = new BusinessAuthenticator();
    const registration = auth.options('register', session.principal.identityId, origin, session.principal);
    assert.equal('authenticatorSelection' in registration && registration.authenticatorSelection?.residentKey, 'required');
    auth.finish('register', registration.challenge, key.register(registration.challenge, origin), origin, session.principal);
    assert.throws(() => auth.finish('register', registration.challenge, key.register(registration.challenge, origin), origin, session.principal));
    auth = new BusinessAuth(profile, identities);
    const login = auth.options('login', undefined, origin);
    assert.deepEqual('allowCredentials' in login && login.allowCredentials, []);
    const signed = auth.finish('login', login.challenge, key.assertion(login.challenge, origin), origin); assert.ok(signed);
    assert.equal(signed.principal.identityId, session.principal.identityId);
    assert.throws(() => auth.finish('login', login.challenge, key.assertion(login.challenge, origin), origin));
    const wrongOrigin = auth.options('login', undefined, origin);
    assert.throws(() => auth.finish('login', wrongOrigin.challenge, key.assertion(wrongOrigin.challenge, 'https://personal.example.test'), origin));
    const second = auth.createIdentity('Taylor', true);
    assert.throws(() => auth.finish('register', auth.options('register', session.principal.identityId, origin, session.principal).challenge, key.register('bad', origin), origin, second.principal));
    const pending = auth.options('login', undefined, origin);
    identities.database.prepare("UPDATE business_identities SET status='disabled' WHERE id=?").run(session.principal.identityId);
    assert.throws(() => auth.finish('login', pending.challenge, key.assertion(pending.challenge, origin), origin));
    assert.equal(auth.principal(signed.value), undefined);
  } finally { identities.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function authHttpFixture(trustProxy: boolean | { secret: string } = false) {
  const { openBusinessProfile, createBusinessRuntime } = await modules();
  const dir = scratch();
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  const port = address.port; await new Promise<void>(r => probe.close(() => r()));
  const runtime = createBusinessRuntime({ profile: openBusinessProfile(dir), origin: `http://127.0.0.1:${port}`, trustProxy });
  await new Promise<void>(r => runtime.server.listen(port, '127.0.0.1', r));
  return { runtime, async request(path: string, data: unknown = {}, headers: Record<string, string> = {}) {
    return fetch(runtime.origin + '/api/business/' + path, { method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  }, async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('successful passkey sign-ins and logouts do not consume the failed-authentication limit', async () => {
  const fixture = await authHttpFixture(); const { runtime, request } = fixture;
  try {
    const claimed = runtime.auth.claim('127.0.0.1', runtime.auth.claimCode, 'Alex', true)!;
    const key = new BusinessAuthenticator();
    const registration = runtime.auth.options('register', claimed.principal.identityId, runtime.origin, claimed.principal);
    runtime.auth.finish('register', registration.challenge, key.register(registration.challenge, runtime.origin), runtime.origin, claimed.principal);
    for (let i = 0; i < 35; i++) {
      // Repeated failures below the lock threshold must be cleared by a real successful sign-in.
      for (let j = 0; j < 2; j++) assert.equal((await request('passkeys/login/finish', { challenge: 'invalid', response: {} })).status, 400);
      const options = await request('passkeys/login/options'); assert.equal(options.status, 200, `options ${i}`);
      const { challenge } = await options.json() as { challenge: string };
      const signed = await request('passkeys/login/finish', { challenge, response: key.assertion(challenge, runtime.origin) });
      assert.equal(signed.status, 200, `sign-in ${i}`);
      const cookie = signed.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await request('logout', {}, { cookie })).status, 200, `logout ${i}`);
    }
  } finally { await fixture.close(); }
});

test('failed authentication is bounded, untrusted forwarding cannot evade it, and logout stays available', async () => {
  const fixture = await authHttpFixture(); const { runtime, request } = fixture;
  try {
    const session = runtime.auth.claim('127.0.0.1', runtime.auth.claimCode, 'Alex', true)!;
    for (let i = 0; i < 30; i++) assert.equal((await request('passkeys/login/finish', { challenge: 'invalid', response: {} }, { 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-sara-proxy': 'untrusted' })).status, 400);
    assert.equal((await request('passkeys/login/finish', { challenge: 'invalid', response: {} }, { 'x-forwarded-for': '203.0.113.8' })).status, 429);
    assert.equal((await request('logout', {}, { cookie: `sara_business_session=${session.value}` })).status, 200);
  } finally { await fixture.close(); }
});

test('challenge allocation is independently bounded and trusted-proxy clients have separate limits', async () => {
  const fixture = await authHttpFixture({ secret: 'synthetic-proxy-secret' }); const { request } = fixture;
  try {
    const a = { 'x-sara-proxy': 'synthetic-proxy-secret', 'x-forwarded-for': 'spoofed-first, 198.51.100.10' };
    const b = { 'x-sara-proxy': 'synthetic-proxy-secret', 'x-forwarded-for': '198.51.100.11' };
    for (let i = 0; i < 100; i++) assert.equal((await request('passkeys/login/options', {}, a)).status, 200, `allocation ${i}`);
    assert.equal((await request('passkeys/login/options', {}, { ...a, 'x-forwarded-for': 'changed-first, 198.51.100.10' })).status, 429);
    assert.equal((await request('passkeys/login/options', {}, b)).status, 200);
    for (let i = 0; i < 30; i++) assert.equal((await request('passkeys/login/finish', { challenge: 'bad', response: {} }, a)).status, 400);
    assert.equal((await request('passkeys/login/finish', { challenge: 'bad', response: {} }, a)).status, 429);
    assert.equal((await request('passkeys/login/finish', { challenge: 'bad', response: {} }, b)).status, 400);
  } finally { await fixture.close(); }
});

test('proxy configuration defaults to socket identity and reads only an explicitly enabled business secret', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'proxy-secret'), 'synthetic-file-proxy-secret');
    assert.equal(proxyTrust({}, dir), false);
    assert.deepEqual(proxyTrust({ SARA_TRUST_PROXY: '1' }, dir), { secret: 'synthetic-file-proxy-secret' });
    assert.deepEqual(proxyTrust({ SARA_TRUST_PROXY: '1', SARA_PROXY_SECRET: 'synthetic-env-proxy-secret' }, dir), { secret: 'synthetic-env-proxy-secret' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

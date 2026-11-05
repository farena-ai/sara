import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { Vault } from '../src/vault.ts';
import { contentFixture } from './helpers/business-content.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';
import type { BusinessSession } from '../src/business/identity.ts';

function material(f: Awaited<ReturnType<typeof contentFixture>>, actor = f.admin) {
  return ['auth/' + actor.principal.identityId + '/0', 'operator'].flatMap(dir => readdirSync(join(f.profile.businessDir, dir)).map(name => [dir + '/' + name, createHash('sha256').update(readFileSync(join(f.profile.businessDir, dir, name))).digest('hex')]));
}
function seedVault(f: Awaited<ReturnType<typeof contentFixture>>) {
  const dir = join(f.profile.businessDir, 'operator'); mkdirSync(dir, { recursive: true }); new Vault(dir).set('fixture', 'synthetic-secret');
}
async function stalled(f: Awaited<ReturnType<typeof contentFixture>>, session: BusinessSession, path: string, value: object) {
  const payload = JSON.stringify(value); let seen!: () => void;
  const authenticated = new Promise<void>(resolve => { seen = resolve; });
  const principal = f.runtime.auth.principal.bind(f.runtime.auth);
  f.runtime.auth.principal = value => { const result = principal(value); f.runtime.auth.principal = principal; seen(); return result; };
  let send!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    send = request(f.runtime.origin + path, { method: 'POST', headers: { origin: f.runtime.origin, cookie: 'sara_business_session=' + session.value, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    send.on('error', reject); send.setTimeout(5000, () => send.destroy(new Error('Stalled registration test timed out'))); send.write(payload.slice(0, 1));
  });
  await authenticated;
  return { finish: async () => { send.end(payload.slice(1)); return response; } };
}

for (const boundary of ['logout', 'expiry']) for (const operation of ['options', 'finish']) test(`real HTTP registration ${operation} rechecks ${boundary} after delayed body without credential or Vault mutation`, async () => {
  const f = await contentFixture();
  try {
    seedVault(f); let session = f.admin;
    if (boundary === 'expiry') {
      const signed = new OwnerAuth(join(f.profile.businessDir, 'auth', f.admin.principal.identityId, '0'), () => new Date(Date.now() - 30 * 24 * 3600_000 + 1500)).createSession();
      const value = `${f.admin.principal.identityId}.0.${signed.value}`;
      session = { value, maxAgeSeconds: signed.maxAgeSeconds, principal: f.runtime.auth.principal(value)! };
    }
    const authenticator = new BusinessAuthenticator();
    const options = await (await f.request('/api/business/passkeys/register/options', session, {})).json(); assert.ok(options.challenge);
    const pending = await stalled(f, session, '/api/business/passkeys/register/' + operation, operation === 'options' ? {} : { challenge: options.challenge, response: authenticator.register(options.challenge, f.runtime.origin) });
    if (boundary === 'logout') assert.equal((await f.request('/api/business/logout', session, {})).status, 200);
    else await new Promise(resolve => setTimeout(resolve, Math.max(1, session.principal.expiresAt - Date.now() + 20)));
    assert.equal(f.runtime.auth.isPrincipalActive(session.principal), false);
    const before = material(f); const result = await pending.finish(); assert.equal(result.status, 401);
    assert.deepEqual(material(f), before); assert.equal(f.runtime.identities.credentialIdentity(authenticator.id.toString('base64url')), undefined);
    const login = await (await f.request('/api/business/passkeys/login/options', session, {})).json();
    assert.equal((await f.request('/api/business/passkeys/login/finish', session, { challenge: login.challenge, response: authenticator.assertion(login.challenge, f.runtime.origin) })).status, 400);
    assert.deepEqual(material(f), before);
  } finally { await f.close(); }
});

test('direct registration rejects stale principals and rechecks authority immediately before credential persistence', async () => {
  const f = await contentFixture();
  try {
    seedVault(f); const auth = f.runtime.auth; const principal = f.admin.principal;
    const ceremony = auth.options('register', principal.identityId, f.runtime.origin, principal);
    assert.throws(() => auth.options('register', principal.identityId, f.runtime.origin, { ...principal, expiresAt: Date.now() - 1 }), /Sign-in required/);
    const authenticator = new BusinessAuthenticator(); const response = authenticator.register(ceremony.challenge, f.runtime.origin); const attestation = response.attestationObject;
    const beforeExpired = material(f);
    assert.throws(() => auth.finish('register', ceremony.challenge, response, f.runtime.origin, { ...principal, expiresAt: Date.now() - 1 }), /Sign-in required/);
    assert.deepEqual(material(f), beforeExpired);
    let afterLogout: ReturnType<typeof material> | undefined;
    Object.defineProperty(response, 'attestationObject', { get() { if (!afterLogout) { auth.logout(principal); afterLogout = material(f); } return attestation; } });
    assert.throws(() => auth.finish('register', ceremony.challenge, response, f.runtime.origin, principal), /Sign-in required/);
    assert.deepEqual(material(f), afterLogout); assert.equal(f.runtime.identities.credentialIdentity(authenticator.id.toString('base64url')), undefined);
    assert.throws(() => auth.options('register', principal.identityId, f.runtime.origin, principal), /Sign-in required/);
    assert.throws(() => auth.finish('register', ceremony.challenge, response, f.runtime.origin, principal), /Sign-in required/);
  } finally { await f.close(); }
});

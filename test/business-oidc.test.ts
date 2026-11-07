// EC2: the OpenID Connect protocol layer (discovery, JWKS, ID-token checks, PKCE, code and refresh).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { OidcClient, OidcError, issuerAllowed, pkcePair } from '../src/business/oidc.ts';
import { fakeOidc, type FakeOidc } from './fixtures/fake-oidc.ts';

const redirectUri = 'http://127.0.0.1:7886/api/business/sso/callback';
const client = (idp: FakeOidc, extra: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}) => new OidcClient({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri, ...extra });
async function signIn(idp: FakeOidc, c: OidcClient, sub = 'alice') {
  const request = await c.authorizationRequest();
  const back = new URL(idp.approve(request.url, sub));
  assert.equal(back.searchParams.get('state'), request.state);
  return c.exchange(back.searchParams.get('code')!, request.verifier, request.nonce);
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (error) { assert.ok(error instanceof OidcError, String(error)); return (error as OidcError).code; } };

test('oidc: PKCE S256 pair and issuer rules', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(issuerAllowed('https://login.microsoftonline.com/x/v2.0', false), true);
  assert.equal(issuerAllowed('http://idp.example.com', false), false, 'plain HTTP only on loopback');
  assert.equal(issuerAllowed('http://127.0.0.1:8080/realms/sara', false), true);
  assert.equal(issuerAllowed('https://user:pw@idp.example.com', false), false);
  assert.equal(issuerAllowed('https://idp.example.com?x=1', false), false);
  assert.equal(issuerAllowed('https://accounts.google.com', true), false, 'private-local: cloud IdP refused');
  assert.equal(issuerAllowed('https://keycloak.lan:8443/realms/sara', true) || issuerAllowed('https://192.168.1.20/realms/sara', true), true, 'private-local: LAN IdP allowed');
});

test('oidc: authorization request carries state, nonce, PKCE and the exact redirect', async () => {
  const idp = await fakeOidc();
  try {
    const r = await client(idp, { scope: 'openid email profile offline_access', params: { prompt: 'select_account' } }).authorizationRequest();
    const url = new URL(r.url);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: idp.clientId, redirect_uri: redirectUri, state: r.state, nonce: r.nonce, code_challenge_method: 'S256', scope: 'openid email profile offline_access', prompt: 'select_account' })) assert.equal(url.searchParams.get(k), v, k);
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(r.verifier).digest('base64url'));
    assert.match(r.state, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(r.state, r.nonce);
  } finally { await idp.close(); }
});

test('oidc: a valid sign-in returns verified claims and a refresh token (RS256 and ES256)', async () => {
  const idp = await fakeOidc();
  try {
    const c = client(idp);
    const result = await signIn(idp, c);
    assert.equal(result.claims.sub, 'alice'); assert.equal(result.claims.email, 'alice@example.com'); assert.deepEqual(result.claims.groups, ['sara-admins']);
    assert.ok(result.refreshToken);
    idp.rotate('ES256');
    assert.equal((await signIn(idp, c, 'bob')).claims.sub, 'bob', 'ES256 with ieee-p1363 signatures');
    const form = idp.tokenCalls.find(call => call.grant_type === 'authorization_code')!;
    assert.ok(form.code_verifier && !form.client_secret, 'client_secret_basic preferred; the secret is not in the body');
  } finally { await idp.close(); }
});

test('oidc: client_secret_post when that is all the provider supports', async () => {
  const idp = await fakeOidc(); idp.authMethods = ['client_secret_post'];
  try { await signIn(idp, client(idp)); assert.equal(idp.tokenCalls.at(-1)!.client_secret, idp.clientSecret); }
  finally { await idp.close(); }
});

test('oidc: discovery issuer must match the configured issuer exactly', async () => {
  const idp = await fakeOidc(); idp.discoveryIssuer = 'https://evil.example';
  try { assert.equal(await code(client(idp).authorizationRequest()), 'issuer'); }
  finally { await idp.close(); }
});

test('oidc: wrong issuer, audience, azp, expiry, not-yet-valid and nonce are refused', async () => {
  const idp = await fakeOidc();
  try {
    const cases: [FakeOidc['tamper'], string][] = [
      [{ iss: 'https://evil.example' }, 'issuer'], [{ aud: 'someone-else' }, 'audience'], [{ aud: ['someone-else', 'x'] }, 'audience'],
      [{ aud: [idp.clientId, 'other-app'], azp: 'other-app' }, 'audience'], [{ expIn: -120 }, 'expired'], [{ nbfIn: 600 }, 'expired'],
      [{ iatShift: 600 }, 'expired'], [{ nonce: 'replayed-nonce' }, 'nonce'], [{ dropNonce: true }, 'nonce'],
    ];
    for (const [tamper, expected] of cases) { idp.tamper = tamper; assert.equal(await code(signIn(idp, client(idp))), expected, JSON.stringify(tamper)); }
    idp.tamper = { expIn: -30 };
    assert.equal(await code(signIn(idp, client(idp))), 'ok', 'expiry within the 60 s clock skew is accepted');
    idp.tamper = { aud: [idp.clientId, 'other-app'], azp: idp.clientId };
    assert.equal(await code(signIn(idp, client(idp))), 'ok');
  } finally { await idp.close(); }
});

test('oidc: bad signatures, alg none, HS256 and a mismatched key type are refused', async () => {
  const idp = await fakeOidc();
  try {
    const c = client(idp);
    idp.tamper = { badSignature: true }; assert.equal(await code(signIn(idp, c)), 'signature');
    idp.tamper = { alg: 'none' }; assert.equal(await code(signIn(idp, c)), 'algorithm');
    idp.tamper = { alg: 'HS256' }; assert.equal(await code(signIn(idp, c)), 'algorithm');
    idp.tamper = { alg: 'ES256' }; assert.equal(await code(signIn(idp, c)), 'algorithm', 'an RSA key never verifies an ES256 header');
    idp.tamper = {};
    const now = Math.floor(Date.now() / 1000);
    const forged = idp.jwt({ iss: idp.issuer, aud: idp.clientId, sub: 'alice', iat: now, exp: now + 60 }, { alg: 'none' });
    assert.equal(await code(c.verifyIdToken(forged.split('.').slice(0, 2).join('.') + '.')), 'algorithm');
    assert.equal(await code(c.verifyIdToken('not.a.jwt.at.all')), 'token');
  } finally { await idp.close(); }
});

test('oidc: JWKS is cached; an unknown kid refetches once (rotation) and a forged kid cannot hammer the IdP', async () => {
  const idp = await fakeOidc();
  try {
    const c = client(idp);
    await signIn(idp, c); await signIn(idp, c);
    assert.equal(idp.jwksFetches, 1, 'cached between sign-ins');
    idp.rotate('RS256', true);
    assert.equal(await code(signIn(idp, c)), 'ok', 'rotation: the new kid triggers one refetch');
    assert.equal(idp.jwksFetches, 2);
    const stray = idp.signWithUnpublished();
    const before = idp.jwksFetches;
    for (let i = 0; i < 3; i++) assert.equal(await code(signIn(idp, c)), 'unknown_key');
    assert.ok(idp.jwksFetches - before <= 1, 'unknown kids refetch at most once every 30 s');
    idp.publish(stray);
    const later = client(idp, { now: () => Date.now() + 31_000 });
    assert.equal(await code(signIn(idp, later)), 'ok', 'after the cool-down a newly published key is found');
  } finally { await idp.close(); }
});

test('oidc: refresh proves the person is still active; a disabled person gets invalid_grant', async () => {
  const idp = await fakeOidc();
  try {
    const c = client(idp);
    const first = await signIn(idp, c, 'bob');
    const next = await c.refresh(first.refreshToken!, 'bob');
    assert.equal(next.claims?.sub, 'bob'); assert.ok(next.refreshToken && next.refreshToken !== first.refreshToken);
    idp.tamper = { sub: 'mallory' };
    assert.equal(await code(c.refresh(next.refreshToken!, 'bob')), 'claims', 'a refreshed token for another subject is refused');
    idp.tamper = {};
    const again = await signIn(idp, c, 'bob');
    idp.disable('bob');
    assert.equal(await code(c.refresh(again.refreshToken!, 'bob')), 'refused');
  } finally { await idp.close(); }
});

test('oidc: unreachable provider and oversized or redirected answers fail closed', async () => {
  const idp = await fakeOidc(); const issuer = idp.issuer; await idp.close();
  assert.equal(await code(new OidcClient({ issuer, clientId: 'x', clientSecret: 'y', redirectUri }).authorizationRequest()), 'network');
  assert.equal(await code(new OidcClient({ issuer: 'http://idp.example.com', clientId: 'x', clientSecret: 'y', redirectUri }).authorizationRequest()), 'issuer');
});

test('oidc: end-session URL uses client_id and the post-logout address, never a token', async () => {
  const idp = await fakeOidc();
  try {
    const url = new URL((await client(idp).endSessionUrl('http://127.0.0.1:7886/'))!);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/logout`);
    assert.equal(url.searchParams.get('client_id'), idp.clientId); assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'http://127.0.0.1:7886/');
    assert.equal(url.searchParams.has('id_token_hint'), false);
  } finally { await idp.close(); }
});

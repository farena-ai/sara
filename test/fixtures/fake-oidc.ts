// A small, fully local OpenID Connect provider for tests (EC2). Discovery, JWKS with rotation, an
// authorization endpoint that approves a chosen user, a token endpoint (authorization code + PKCE and
// refresh), end-session, and switches that make the next ID token wrong in one specific way.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeUser { sub: string; email?: string; email_verified?: boolean; name?: string; groups?: string[]; disabled?: boolean; upn?: string }
/** Changes applied to the next ID tokens the provider signs (cleared with `idp.tamper = {}`). */
export interface Tamper { iss?: string; aud?: string | string[]; azp?: string; expIn?: number; iatShift?: number; nbfIn?: number; nonce?: string; alg?: string; kid?: string; badSignature?: boolean; dropNonce?: boolean; sub?: string }
interface Key { kid: string; alg: 'RS256' | 'ES256'; privateKey: KeyObject; jwk: Record<string, unknown> }
interface Grant { sub: string; nonce?: string; challenge: string; method: string; clientId: string; redirectUri: string; scope: string }

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export class FakeOidc {
  readonly server: Server;
  issuer = '';
  clientId = 'sara-test-client';
  clientSecret = 'fake-client-secret-0123456789';
  /** Returned by discovery; tests may set it to a different issuer. */
  discoveryIssuer?: string;
  authMethods: string[] = ['client_secret_basic', 'client_secret_post'];
  issueRefresh = true;
  tamper: Tamper = {};
  readonly users = new Map<string, FakeUser>();
  readonly published: Key[] = [];
  signing!: Key;
  jwksFetches = 0;
  discoveryFetches = 0;
  tokenCalls: Record<string, string>[] = [];
  jwksMaxAge = 600;
  readonly #grants = new Map<string, Grant>();
  readonly #refresh = new Map<string, { sub: string; clientId: string; nonce?: string }>();
  defaultUser = 'alice';

  constructor() {
    this.server = createServer((req, res) => { void this.#handle(req, res).catch(() => { if (!res.headersSent) this.#json(res, 500, { error: 'server_error' }); }); });
    this.rotate('RS256');
    this.users.set('alice', { sub: 'alice', email: 'alice@example.com', email_verified: true, name: 'Alice Admin', groups: ['sara-admins'] });
    this.users.set('bob', { sub: 'bob', email: 'bob@example.com', email_verified: true, name: 'Bob Member', groups: ['sara-users'] });
    this.users.set('eve', { sub: 'eve', email: 'eve@other.test', email_verified: true, name: 'Eve Outsider', groups: ['sara-users'] });
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(port, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close(): Promise<void> { return new Promise(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); }); }

  /** Publish a new key and sign with it from now on. `retire` drops the earlier keys from the JWKS. */
  rotate(alg: 'RS256' | 'ES256' = 'RS256', retire = false): string {
    const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kid = `k-${randomBytes(6).toString('hex')}`;
    const key: Key = { kid, alg, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' } };
    if (retire) this.published.length = 0;
    this.published.push(key); this.signing = key; return kid;
  }
  /** Sign with a key that is not (yet) in the published JWKS. */
  signWithUnpublished(alg: 'RS256' | 'ES256' = 'RS256'): Key {
    const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kid = `k-${randomBytes(6).toString('hex')}`;
    const key: Key = { kid, alg, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' } };
    this.signing = key; return key;
  }
  publish(key: Key): void { this.published.push(key); }

  jwt(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key = this.signing): string {
    const head = { alg: key.alg, kid: key.kid, typ: 'JWT', ...header };
    const input = `${b64(JSON.stringify(head))}.${b64(JSON.stringify(claims))}`;
    let signature = (head.alg as string) === 'none' ? Buffer.alloc(0)
      : key.alg === 'RS256' ? sign('sha256', Buffer.from(input), key.privateKey)
      : sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    if (this.tamper.badSignature && signature.length) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0xff; }
    return `${input}.${b64(signature)}`;
  }

  idToken(user: FakeUser, clientId: string, nonce?: string): string {
    const now = Math.floor(Date.now() / 1000); const t = this.tamper;
    const claims: Record<string, unknown> = {
      iss: t.iss ?? this.issuer, sub: t.sub ?? user.sub, aud: t.aud ?? clientId, iat: now + (t.iatShift ?? 0), exp: now + (t.expIn ?? 300),
      ...(t.nbfIn !== undefined ? { nbf: now + t.nbfIn } : {}), ...(t.azp ? { azp: t.azp } : {}),
      ...(t.dropNonce ? {} : nonce !== undefined || t.nonce !== undefined ? { nonce: t.nonce ?? nonce } : {}),
      ...(user.email !== undefined ? { email: user.email } : {}), ...(user.email_verified !== undefined ? { email_verified: user.email_verified } : {}),
      ...(user.name ? { name: user.name } : {}), ...(user.groups ? { groups: user.groups } : {}), ...(user.upn ? { preferred_username: user.upn } : {}),
    };
    return this.jwt(claims, { ...(t.alg ? { alg: t.alg } : {}), ...(t.kid ? { kid: t.kid } : {}) });
  }

  /** Act as the person approving the sign-in at the IdP: returns the redirect back to Sara. */
  approve(authorizeUrl: string, sub = this.defaultUser): string {
    const url = new URL(authorizeUrl);
    const q = url.searchParams;
    const redirect = q.get('redirect_uri')!;
    if (q.get('response_type') !== 'code' || q.get('client_id') !== this.clientId || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256' || !q.get('scope')?.split(' ').includes('openid')) throw new Error('Fake IdP: bad authorization request');
    const user = this.users.get(sub);
    if (!user || user.disabled) { const back = new URL(redirect); back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', q.get('state') ?? ''); return back.href; }
    const code = randomBytes(16).toString('base64url');
    this.#grants.set(code, { sub, nonce: q.get('nonce') ?? undefined, challenge: q.get('code_challenge')!, method: q.get('code_challenge_method')!, clientId: q.get('client_id')!, redirectUri: redirect, scope: q.get('scope')! });
    const back = new URL(redirect); back.searchParams.set('code', code); back.searchParams.set('state', q.get('state') ?? ''); back.searchParams.set('iss', this.issuer);
    return back.href;
  }
  disable(sub: string): void {
    const user = this.users.get(sub); if (user) user.disabled = true;
    for (const [token, grant] of this.#refresh) if (grant.sub === sub) this.#refresh.delete(token);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      this.discoveryFetches++;
      return this.#json(res, 200, { issuer: this.discoveryIssuer ?? this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks`, end_session_endpoint: `${this.issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256', 'ES256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: this.authMethods });
    }
    if (url.pathname === '/jwks') { this.jwksFetches++; res.setHeader('cache-control', `public, max-age=${this.jwksMaxAge}`); return this.#json(res, 200, { keys: this.published.map(k => k.jwk) }); }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      // Browser walk-through: approve the login_hint user (or the default user) at once.
      const location = this.approve(url.href, url.searchParams.get('login_hint') ?? this.defaultUser);
      res.writeHead(302, { location }); res.end(); return;
    }
    if (url.pathname === '/logout') { res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' }); res.end(); return; }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      this.tokenCalls.push(form);
      let clientId = form.client_id; let secret = form.client_secret;
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      if (basic) { const [id, pass] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent); clientId = id; secret = pass; }
      if (clientId !== this.clientId || secret !== this.clientSecret) return this.#json(res, 401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        const grant = this.#grants.get(form.code); this.#grants.delete(form.code);
        if (!grant || grant.clientId !== clientId || grant.redirectUri !== form.redirect_uri) return this.#json(res, 400, { error: 'invalid_grant' });
        if (createHash('sha256').update(form.code_verifier ?? '').digest('base64url') !== grant.challenge) return this.#json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        const user = this.users.get(grant.sub)!;
        const refresh = this.issueRefresh ? randomBytes(16).toString('base64url') : undefined;
        if (refresh) this.#refresh.set(refresh, { sub: user.sub, clientId, nonce: grant.nonce });
        return this.#json(res, 200, { access_token: randomBytes(12).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: this.idToken(user, clientId, grant.nonce), ...(refresh ? { refresh_token: refresh } : {}) });
      }
      if (form.grant_type === 'refresh_token') {
        const grant = this.#refresh.get(form.refresh_token); const user = grant && this.users.get(grant.sub);
        if (!grant || !user || user.disabled || grant.clientId !== clientId) return this.#json(res, 400, { error: 'invalid_grant' });
        this.#refresh.delete(form.refresh_token);
        const next = randomBytes(16).toString('base64url'); this.#refresh.set(next, grant);
        return this.#json(res, 200, { access_token: randomBytes(12).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: this.idToken(user, clientId), refresh_token: next });
      }
      return this.#json(res, 400, { error: 'unsupported_grant_type' });
    }
    this.#json(res, 404, { error: 'not_found' });
  }
  #json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  }
}

export async function fakeOidc(port = 0): Promise<FakeOidc> { return new FakeOidc().start(port); }

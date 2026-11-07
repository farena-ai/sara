// EC2: OpenID Connect relying-party protocol (authorization code + PKCE). Protocol only: no Sara
// accounts, roles or storage. Node built-in crypto verifies RS256 and ES256; every other alg is refused.
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { isLanHost, isLoopbackHost } from '../net-guard.ts';

export type OidcErrorCode = 'discovery' | 'issuer' | 'audience' | 'expired' | 'signature' | 'algorithm' | 'unknown_key' | 'nonce' | 'token' | 'claims' | 'refused' | 'network' | 'client';
/** Reason codes only; messages never carry tokens, claims or secrets. */
export class OidcError extends Error {
  readonly code: OidcErrorCode;
  constructor(code: OidcErrorCode) { super(`OpenID Connect check failed: ${code}`); this.code = code; }
}

export interface OidcMetadata {
  issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string;
  end_session_endpoint?: string; token_endpoint_auth_methods_supported?: string[];
}
export interface OidcClaims { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; [claim: string]: unknown }
export interface OidcClientOptions {
  issuer: string; clientId: string; clientSecret: string; redirectUri: string;
  scope?: string; params?: Record<string, string>; privateLocal?: boolean; skewSeconds?: number;
  now?: () => number; fetch?: typeof fetch;
}

const MAX_BYTES = 262_144;
const TIMEOUT_MS = 10_000;
const REFETCH_COOLDOWN_MS = 30_000;
const random = () => randomBytes(32).toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = random();
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** HTTPS only (HTTP to loopback for tests and a local IdP); no credentials, query or fragment. */
export function issuerAllowed(value: string, privateLocal = false): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash || value.length > 512) return false;
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
  if (privateLocal && !loopback && !isLanHost(url.hostname)) return false;
  return true;
}

function endpointAllowed(value: unknown, privateLocal: boolean): value is string {
  return typeof value === 'string' && issuerAllowed(value.split('?')[0], privateLocal);
}

type ResolvedOptions = Required<Omit<OidcClientOptions, 'params' | 'scope'>> & { params: Record<string, string>; scope: string };

export class OidcClient {
  readonly #o: ResolvedOptions;
  #metadata?: { value: OidcMetadata; until: number };
  #keys = new Map<string, { key: KeyObject; kty: string; crv?: string; alg?: string }>();
  #keysUntil = 0;
  #lastForced = -Infinity;

  constructor(options: OidcClientOptions) {
    this.#o = { privateLocal: false, skewSeconds: 60, now: Date.now, fetch: globalThis.fetch, scope: 'openid email profile', params: {}, ...options } as ResolvedOptions;
  }

  async #get(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
    let response: Response;
    try { response = await this.#o.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', ...(init.headers ?? {}) } }); }
    catch { throw new OidcError('network'); }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_BYTES) { await reader.cancel(); throw new OidcError('network'); }
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
    return { status: response.status, body, headers: response.headers };
  }

  async discover(): Promise<OidcMetadata> {
    if (this.#metadata && this.#metadata.until > this.#o.now()) return this.#metadata.value;
    if (!issuerAllowed(this.#o.issuer, this.#o.privateLocal)) throw new OidcError('issuer');
    const { status, body } = await this.#get(this.#o.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
    if (status !== 200 || !body || typeof body !== 'object') throw new OidcError('discovery');
    const m = body as Record<string, unknown>;
    if (m.issuer !== this.#o.issuer) throw new OidcError('issuer');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!endpointAllowed(m[field], this.#o.privateLocal)) throw new OidcError('discovery');
    const value: OidcMetadata = {
      issuer: m.issuer as string, authorization_endpoint: m.authorization_endpoint as string, token_endpoint: m.token_endpoint as string, jwks_uri: m.jwks_uri as string,
      ...(endpointAllowed(m.end_session_endpoint, this.#o.privateLocal) ? { end_session_endpoint: m.end_session_endpoint as string } : {}),
      ...(Array.isArray(m.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: m.token_endpoint_auth_methods_supported.filter(x => typeof x === 'string') } : {}),
    };
    this.#metadata = { value, until: this.#o.now() + 3_600_000 };
    return value;
  }

  async #loadKeys(): Promise<void> {
    const { jwks_uri } = await this.discover();
    const { status, body, headers } = await this.#get(jwks_uri);
    const keys = (body as { keys?: unknown } | undefined)?.keys;
    if (status !== 200 || !Array.isArray(keys)) throw new OidcError('discovery');
    const next = new Map<string, { key: KeyObject; kty: string; crv?: string; alg?: string }>();
    for (const jwk of keys.slice(0, 100) as Record<string, unknown>[]) {
      if (!jwk || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig') || !['RSA', 'EC'].includes(String(jwk.kty))) continue;
      if (jwk.kty === 'EC' && jwk.crv !== 'P-256') continue;
      try {
        const { d: _private, ...pub } = jwk; void _private;
        next.set(jwk.kid, { key: createPublicKey({ key: pub as JsonWebKey, format: 'jwk' }), kty: String(jwk.kty), ...(typeof jwk.crv === 'string' ? { crv: jwk.crv } : {}), ...(typeof jwk.alg === 'string' ? { alg: jwk.alg } : {}) });
      } catch { /* A malformed key is skipped, never trusted. */ }
    }
    const maxAge = Number(/max-age=(\d+)/.exec(headers.get('cache-control') ?? '')?.[1] ?? 600);
    this.#keys = next; this.#keysUntil = this.#o.now() + Math.min(86_400, Math.max(60, maxAge)) * 1000;
  }

  async #key(kid: string) {
    if (this.#keysUntil <= this.#o.now()) await this.#loadKeys();
    let key = this.#keys.get(kid);
    if (!key && this.#o.now() - this.#lastForced >= REFETCH_COOLDOWN_MS) {
      // Rotation: an unseen kid forces one refetch, rate-limited so forged kids cannot hammer the IdP.
      this.#lastForced = this.#o.now(); await this.#loadKeys(); key = this.#keys.get(kid);
    }
    if (!key) throw new OidcError('unknown_key');
    return key;
  }

  /** Settings check: discovery plus a fresh JWKS fetch; returns the number of usable signing keys. */
  async keyCount(): Promise<number> { await this.#loadKeys(); return this.#keys.size; }

  async authorizationRequest(extra: Record<string, string> = {}): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const meta = await this.discover();
    const { verifier, challenge } = pkcePair(); const state = random(); const nonce = random();
    const url = new URL(meta.authorization_endpoint);
    const params = { ...this.#o.params, ...extra, response_type: 'code', client_id: this.#o.clientId, redirect_uri: this.#o.redirectUri, scope: this.#o.scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return { url: url.href, state, nonce, verifier };
  }

  async #token(form: Record<string, string>): Promise<Record<string, unknown>> {
    const meta = await this.discover();
    const methods = meta.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    const basic = methods.includes('client_secret_basic') || !methods.includes('client_secret_post');
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams(form);
    if (basic) headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(this.#o.clientId)}:${encodeURIComponent(this.#o.clientSecret)}`).toString('base64');
    else { body.set('client_id', this.#o.clientId); body.set('client_secret', this.#o.clientSecret); }
    const { status, body: answer } = await this.#get(meta.token_endpoint, { method: 'POST', headers, body: body.toString() });
    const value = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
    if (status === 401 || value.error === 'invalid_client') throw new OidcError('client');
    if (status >= 400 && status < 500) throw new OidcError('refused');
    if (status !== 200) throw new OidcError('network');
    return value;
  }

  async exchange(code: string, verifier: string, nonce: string): Promise<{ claims: OidcClaims; refreshToken?: string }> {
    if (typeof code !== 'string' || !code || code.length > 4096) throw new OidcError('token');
    const answer = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: this.#o.redirectUri, code_verifier: verifier });
    if (typeof answer.id_token !== 'string') throw new OidcError('token');
    const claims = await this.verifyIdToken(answer.id_token, nonce);
    return { claims, ...(typeof answer.refresh_token === 'string' && answer.refresh_token.length <= 8192 ? { refreshToken: answer.refresh_token } : {}) };
  }

  /** A successful refresh proves the IdP still accepts the person; a returned ID token is re-verified. */
  async refresh(refreshToken: string, subject: string): Promise<{ claims?: OidcClaims; refreshToken?: string }> {
    const answer = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    let claims: OidcClaims | undefined;
    if (typeof answer.id_token === 'string') {
      claims = await this.verifyIdToken(answer.id_token);
      if (claims.sub !== subject) throw new OidcError('claims');
    }
    return { ...(claims ? { claims } : {}), ...(typeof answer.refresh_token === 'string' && answer.refresh_token.length <= 8192 ? { refreshToken: answer.refresh_token } : {}) };
  }

  /** `nonce` undefined only for refresh responses (no new authorization request). */
  async verifyIdToken(token: string, nonce?: string): Promise<OidcClaims> {
    const parts = typeof token === 'string' && token.length <= 16_384 ? token.split('.') : [];
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[0] || !parts[1]) throw new OidcError('token');
    let header: Record<string, unknown>; let claims: Record<string, unknown>;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
    catch { throw new OidcError('token'); }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new OidcError('token');
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') throw new OidcError('algorithm');
    if (header.crit !== undefined || typeof header.kid !== 'string') throw new OidcError('token');
    const key = await this.#key(header.kid);
    if ((alg === 'RS256' && key.kty !== 'RSA') || (alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256')) || (key.alg !== undefined && key.alg !== alg)) throw new OidcError('algorithm');
    const data = Buffer.from(`${parts[0]}.${parts[1]}`); const signature = Buffer.from(parts[2], 'base64url');
    const ok = alg === 'RS256' ? verify('sha256', data, key.key, signature) : verify('sha256', data, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!ok) throw new OidcError('signature');
    const now = this.#o.now() / 1000; const skew = this.#o.skewSeconds;
    if (claims.iss !== this.#o.issuer) throw new OidcError('issuer');
    const aud = claims.aud;
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every(a => typeof a === 'string') ? aud as string[] : [];
    if (!audiences.includes(this.#o.clientId)) throw new OidcError('audience');
    if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== this.#o.clientId) throw new OidcError('audience');
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || claims.exp + skew < now || claims.iat - skew > now || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - skew > now))) throw new OidcError('expired');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new OidcError('claims');
    if (nonce !== undefined && claims.nonce !== nonce) throw new OidcError('nonce');
    return claims as OidcClaims;
  }

  async endSessionUrl(postLogoutRedirect: string): Promise<string | undefined> {
    const meta = await this.discover();
    if (!meta.end_session_endpoint) return undefined;
    const url = new URL(meta.end_session_endpoint);
    url.searchParams.set('client_id', this.#o.clientId); url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    return url.href;
  }
}

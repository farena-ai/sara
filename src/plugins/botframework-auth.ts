// EC7 (docs/ops/EC7_DESIGN.md "Inbound"): the check Sara runs on every call Microsoft's Bot Connector
// makes to a Teams bridge hook, before the plugin sees a byte. Written from the public Bot Framework
// authentication rules (no Microsoft library): `Authorization: Bearer <JWT>`; the OpenID metadata at
// login.botframework.com gives the JWKS; RS256 only; issuer https://api.botframework.com; audience =
// the bot's App ID; exp/nbf within 5 minutes; the signing key endorsed for the activity's channel
// (`msteams`); the token's serviceUrl claim equal to the activity's, and that the public connector.
// The EC2 rules are kept (src/business/oidc.ts): HTTPS or loopback only, a size cap, keys cached for
// their max-age, an unseen kid forces one refetch at most every 30 s. Answers carry a reason code
// only, never a token or a claim.
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { issuerAllowed } from '../business/oidc.ts';
import { privateLocalOn } from '../net-guard.ts';

export const BF_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BF_ISSUER = 'https://api.botframework.com';
const SKEW_S = 300;
const MAX_BYTES = 262_144;
const TIMEOUT_MS = 10_000;
const REFETCH_COOLDOWN_MS = 30_000;

/** The public Bot Connector (Teams, every region): https://smba.trafficmanager.net/<region>/. */
export function serviceUrlAllowed(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'smba.trafficmanager.net' && !u.username && !u.password && (u.port === '' || u.port === '443');
  } catch {
    return false;
  }
}

const sameService = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

export interface BotFrameworkAuthOptions {
  /** Tests only: a loopback stand-in for login.botframework.com. */
  metadataUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Key {
  key: KeyObject;
  endorsements: string[];
}

export type BfVerdict = { ok: true } | { ok: false; why: string };

export class BotFrameworkAuth {
  readonly #metadataUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #jwksUri?: { value: string; until: number };
  #keys = new Map<string, Key>();
  #keysUntil = 0;
  #lastForced = -Infinity;

  constructor(o: BotFrameworkAuthOptions = {}) {
    this.#metadataUrl = o.metadataUrl ?? BF_METADATA;
    this.#fetch = o.fetch ?? globalThis.fetch;
    this.#now = o.now ?? Date.now;
  }

  async #get(url: string): Promise<{ status: number; body: unknown; maxAge: number }> {
    if (!issuerAllowed(url.split('?')[0])) throw new Error('an address that is not https');
    const res = await this.#fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error('too big');
        }
        chunks.push(value);
      }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = undefined;
    }
    return { status: res.status, body, maxAge: Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600) };
  }

  async #loadKeys(): Promise<void> {
    if (!this.#jwksUri || this.#jwksUri.until <= this.#now()) {
      const m = await this.#get(this.#metadataUrl);
      const uri = (m.body as { jwks_uri?: unknown } | undefined)?.jwks_uri;
      if (m.status !== 200 || typeof uri !== 'string' || !issuerAllowed(uri.split('?')[0])) throw new Error('the metadata has no key address');
      this.#jwksUri = { value: uri, until: this.#now() + 24 * 3600_000 };
    }
    const { status, body, maxAge } = await this.#get(this.#jwksUri.value);
    const keys = (body as { keys?: unknown } | undefined)?.keys;
    if (status !== 200 || !Array.isArray(keys)) throw new Error('no keys');
    const next = new Map<string, Key>();
    for (const jwk of keys.slice(0, 100) as Record<string, unknown>[]) {
      if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA' || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
      try {
        const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' });
        next.set(jwk.kid, { key, endorsements: Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((x): x is string => typeof x === 'string').slice(0, 50) : [] });
      } catch {
        /* A malformed key is skipped, never trusted. */
      }
    }
    this.#keys = next;
    this.#keysUntil = this.#now() + Math.min(5 * 86_400, Math.max(60, maxAge)) * 1000;
  }

  async #key(kid: string): Promise<Key | undefined> {
    if (this.#keysUntil <= this.#now()) await this.#loadKeys();
    let key = this.#keys.get(kid);
    if (!key && this.#now() - this.#lastForced >= REFETCH_COOLDOWN_MS) {
      // Rotation: an unseen kid forces one refetch, rate-limited so forged kids cannot hammer Microsoft.
      this.#lastForced = this.#now();
      await this.#loadKeys();
      key = this.#keys.get(kid);
    }
    return key;
  }

  /** The whole check for one call: the header, the activity's channel and serviceUrl, the App ID. */
  async check(authorization: string | undefined, activity: { channelId?: unknown; serviceUrl?: unknown }, appId: string): Promise<BfVerdict> {
    const no = (why: string): BfVerdict => ({ ok: false, why });
    if (privateLocalOn()) return no('private local mode is on');
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(String(authorization ?? '').trim());
    if (!m || m[1].length > 16_384) return no('no Authorization: Bearer token');
    const parts = m[1].split('.');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return no('not a token');
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) return no('not a token');
    if (header.alg !== 'RS256') return no('the algorithm is not RS256');
    if (header.crit !== undefined || typeof header.kid !== 'string') return no('not a token');
    let key: Key | undefined;
    try {
      key = await this.#key(header.kid);
    } catch {
      return no("couldn't fetch Microsoft's keys");
    }
    if (!key) return no('an unknown key');
    if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key.key, Buffer.from(parts[2], 'base64url'))) return no('the signature does not match');
    if (claims.iss !== BF_ISSUER) return no('the issuer is not the Bot Framework');
    const aud = claims.aud;
    if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId))) || !appId) return no('the audience is not this bot');
    const now = this.#now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_S > now))) return no('the token expired or is not valid yet');
    const channel = typeof activity.channelId === 'string' ? activity.channelId : '';
    if (!channel || !key.endorsements.includes(channel)) return no(`the key is not endorsed for ${channel.slice(0, 20) || 'this channel'}`);
    const su = activity.serviceUrl;
    if (!serviceUrlAllowed(su)) return no('the serviceUrl is not the Bot Connector');
    if (typeof claims.serviceUrl !== 'string' || !sameService(claims.serviceUrl, su as string)) return no('the serviceUrl claim does not match the activity');
    return { ok: true };
  }
}

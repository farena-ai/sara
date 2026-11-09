// EC2: single sign-on policy for business instances (OpenID Connect). Settings, first sign-in
// (invitation-bound by default, optional just-in-time accounts), domain and group rules, SSO session
// lifetime and the periodic session check. The protocol itself lives in oidc.ts.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '../vault.ts';
import { appendAudit } from './audit.ts';
import type { BusinessAuth, BusinessSession } from './identity.ts';
import { operatorVault } from './model-config.ts';
import { BusinessAccessError, exactFields } from './policy.ts';
import type { BusinessProfile } from './profile.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessIdentity, BusinessPrincipal } from './types.ts';
import { OidcClient, OidcError, issuerAllowed, type OidcClaims } from './oidc.ts';

export type SsoPreset = 'entra' | 'google' | 'okta' | 'generic';
export interface SsoConfig {
  enabled: boolean; preset: SsoPreset; issuer: string; clientId: string; allowedDomains: string[];
  groupClaim: string; adminGroups: string[]; memberGroups: string[]; jit: boolean; enforce: boolean;
  sessionHours: number; checkMinutes: number;
}
/** Reason codes shown by the sign-in page (`/?sso=<reason>`); never claims or provider text. */
export type SsoReason = 'denied' | 'state' | 'failed' | 'domain' | 'group' | 'no_account' | 'adult' | 'disabled' | 'invite' | 'unavailable' | 'linked';

const DEFAULTS: SsoConfig = { enabled: false, preset: 'generic', issuer: '', clientId: '', allowedDomains: [], groupClaim: 'groups', adminGroups: [], memberGroups: [], jit: false, enforce: false, sessionHours: 12, checkMinutes: 15 };
const FIELDS = Object.keys(DEFAULTS);
const SECRET = 'business-oidc:client-secret';
const PENDING_MS = 600_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const list = (value: unknown, max: number, each: (item: string) => boolean): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !each(item))) throw new BusinessAccessError(400);
  return [...new Set(value as string[])];
};

interface Pending { nonce: string; verifier: string; binding: string; until: number; key: string; code?: string; confirm18: boolean; link?: { identityId: string; authEpoch: number; sessionId: string } }
interface Evaluated { ok: true; role?: 'orgadmin' | 'user'; name: string }

export class BusinessSso {
  readonly #profile: BusinessProfile;
  readonly #control: BusinessControlStore;
  readonly #auth: BusinessAuth;
  readonly #origin: string;
  readonly #privateLocal: boolean;
  readonly #fetch?: typeof fetch;
  readonly #pending = new Map<string, Pending>();
  #client?: { key: string; client: OidcClient };
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;
  #checking?: Promise<void>;
  /** EC16: an unlinked first sign-in may match a SCIM-provisioned account by email (scim.ts). */
  #provisioned: (email: string) => string | undefined = () => undefined;

  constructor(options: { profile: BusinessProfile; control: BusinessControlStore; auth: BusinessAuth; origin: string; privateLocal?: boolean; fetch?: typeof fetch }) {
    this.#profile = options.profile; this.#control = options.control; this.#auth = options.auth; this.#origin = options.origin;
    this.#privateLocal = !!options.privateLocal; this.#fetch = options.fetch;
    this.#control.database.exec(`CREATE TABLE IF NOT EXISTS business_sso_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), config TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1));
      CREATE TABLE IF NOT EXISTS business_sso_links (issuer TEXT NOT NULL, subject TEXT NOT NULL, identity_id TEXT NOT NULL REFERENCES business_identities(id), linked_at INTEGER NOT NULL, PRIMARY KEY(issuer,subject), UNIQUE(issuer,identity_id));
      CREATE TABLE IF NOT EXISTS business_sso_sessions (identity_id TEXT NOT NULL REFERENCES business_identities(id), session_id TEXT NOT NULL, auth_epoch INTEGER NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        expires_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY(identity_id,session_id));`);
    this.#auth.setSsoGates({ session: (identityId, sessionId) => this.#gate(identityId, sessionId), passkey: identityId => this.#passkeyAllowed(identityId) });
  }

  setProvisionedLookup(lookup: (email: string) => string | undefined): void { this.#provisioned = lookup; }
  /** EC16: SCIM deactivated or removed someone: end every company sign-in session of theirs now. */
  endIdentity(identityId: string): void {
    for (const row of this.#control.database.prepare('SELECT session_id,auth_epoch FROM business_sso_sessions WHERE identity_id=? AND ended_at IS NULL').all(identityId)) this.#end(identityId, String(row.session_id), Number(row.auth_epoch), false);
  }
  /** EC16: SCIM deleted the account: drop its company sign-in link so a new account can be provisioned. */
  unlinkIdentity(identityId: string): void { this.#control.database.prepare('DELETE FROM business_sso_links WHERE identity_id=?').run(identityId); }

  get redirectUrl(): string { return `${this.#origin}/api/business/sso/callback`; }

  config(): SsoConfig {
    const row = this.#control.database.prepare('SELECT config FROM business_sso_config WHERE singleton=1').get();
    return row ? { ...DEFAULTS, ...JSON.parse(String(row.config)) as Partial<SsoConfig> } : { ...DEFAULTS };
  }
  #secret(): string | undefined {
    const dir = join(this.#profile.businessDir, 'operator');
    return existsSync(join(dir, 'secrets.enc')) ? operatorVault(this.#profile).get(SECRET) : undefined;
  }
  /** Refresh tokens live apart from the operator Vault and are never backed up (restore closes access anyway). */
  #tokens(): Vault {
    const dir = join(this.#profile.businessDir, 'sso');
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('Invalid SSO token store.');
    return new Vault(dir);
  }
  #oidc(config = this.config()): OidcClient {
    const secret = this.#secret() ?? '';
    const key = sha(JSON.stringify([config.issuer, config.clientId, config.preset, secret]));
    if (this.#client?.key !== key) {
      const google = config.preset === 'google';
      this.#client = { key, client: new OidcClient({ issuer: config.issuer, clientId: config.clientId, clientSecret: secret, redirectUri: this.redirectUrl, privateLocal: this.#privateLocal,
        scope: google ? 'openid email profile' : 'openid email profile offline_access', params: google ? { access_type: 'offline', prompt: 'consent' } : {}, ...(this.#fetch ? { fetch: this.#fetch } : {}) }) };
    }
    return this.#client.client;
  }

  status(): { enabled: boolean; preset?: SsoPreset } {
    const config = this.config();
    return config.enabled ? { enabled: true, preset: config.preset } : { enabled: false };
  }
  view(principal: BusinessPrincipal) {
    this.#control.policy.requireOrganizationAdmin(principal);
    return { ...this.config(), secretSaved: !!this.#secret(), redirectUrl: this.redirectUrl };
  }

  save(principal: BusinessPrincipal, input: unknown) {
    exactFields(input, [...FIELDS, 'clientSecret']);
    this.#control.policy.requireOrganizationAdmin(principal);
    const before = this.config();
    const next: SsoConfig = { ...before };
    const bool = (name: 'enabled' | 'jit' | 'enforce') => { if (input[name] !== undefined) { if (typeof input[name] !== 'boolean') throw new BusinessAccessError(400); next[name] = input[name]; } };
    bool('enabled'); bool('jit'); bool('enforce');
    if (input.preset !== undefined) { if (!['entra', 'google', 'okta', 'generic'].includes(String(input.preset))) throw new BusinessAccessError(400); next.preset = input.preset as SsoPreset; }
    if (input.issuer !== undefined) { if (input.issuer !== '' && (!plain(input.issuer, 512) || !issuerAllowed(input.issuer, this.#privateLocal))) throw new BusinessAccessError(400); next.issuer = String(input.issuer); }
    if (input.clientId !== undefined) { if (input.clientId !== '' && !plain(input.clientId, 256)) throw new BusinessAccessError(400); next.clientId = String(input.clientId); }
    if (input.allowedDomains !== undefined) next.allowedDomains = list(input.allowedDomains, 50, d => /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)).map(d => d.toLowerCase());
    if (input.groupClaim !== undefined) { if (typeof input.groupClaim !== 'string' || !/^[A-Za-z0-9_:./-]{1,64}$/.test(input.groupClaim)) throw new BusinessAccessError(400); next.groupClaim = input.groupClaim; }
    for (const name of ['adminGroups', 'memberGroups'] as const) if (input[name] !== undefined) next[name] = list(input[name], 100, g => plain(g, 256));
    for (const [name, min, max] of [['sessionHours', 1, 168], ['checkMinutes', 5, 60]] as const) if (input[name] !== undefined) {
      if (!Number.isSafeInteger(input[name]) || Number(input[name]) < min || Number(input[name]) > max) throw new BusinessAccessError(400);
      next[name] = Number(input[name]);
    }
    const secret = input.clientSecret;
    if (secret !== undefined && (!plain(secret, 4096) || /\s/.test(secret))) throw new BusinessAccessError(400);
    if (next.enforce && !next.enabled) throw new BusinessAccessError(400);
    if (next.enabled && (!next.issuer || !next.clientId || (secret === undefined && !this.#secret()))) throw new BusinessAccessError(400);
    // The secret reaches the Vault only after every other field validated.
    if (secret !== undefined) operatorVault(this.#profile).set(SECRET, secret);
    const providerChanged = before.issuer !== next.issuer || before.clientId !== next.clientId || (before.enabled && !next.enabled);
    this.#control.transaction(() => {
      this.#control.policy.requireOrganizationAdmin(principal);
      this.#control.database.prepare('INSERT INTO business_sso_config(singleton,config,revision) VALUES (1,?,1) ON CONFLICT(singleton) DO UPDATE SET config=excluded.config,revision=revision+1').run(JSON.stringify(next));
      appendAudit(this.#control.database, { action: 'sso.configure', actorId: principal.identityId });
    });
    this.#client = undefined;
    if (providerChanged) this.#endAll();
    return this.view(principal);
  }

  async test(principal: BusinessPrincipal): Promise<{ ok: true; keys: number; endSession: boolean } | { ok: false; reason: string }> {
    this.#control.policy.requireOrganizationAdmin(principal);
    const config = this.config();
    if (!config.issuer || !config.clientId) return { ok: false, reason: 'incomplete' };
    try {
      const client = this.#oidc(config); const meta = await client.discover();
      return { ok: true, keys: await client.keyCount(), endSession: !!meta.end_session_endpoint };
    } catch (error) { return { ok: false, reason: error instanceof OidcError ? error.code : 'network' }; }
  }

  async start(input: unknown, principal?: BusinessPrincipal): Promise<{ url: string; binding: string }> {
    exactFields(input, ['code', 'confirm18', 'link']);
    const config = this.config();
    if (!config.enabled) throw new BusinessAccessError(404);
    if (input.code !== undefined && (typeof input.code !== 'string' || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(input.code))) throw new BusinessAccessError(400);
    if ((input.confirm18 !== undefined && typeof input.confirm18 !== 'boolean') || (input.link !== undefined && input.link !== true)) throw new BusinessAccessError(400);
    if (input.link && (!principal || !this.#auth.isPrincipalActive(principal))) throw new BusinessAccessError(401);
    const now = Date.now();
    for (const [state, pending] of this.#pending) if (pending.until <= now) this.#pending.delete(state);
    if (this.#pending.size >= 1000) throw new BusinessAccessError(409, 'Too many sign-in requests.');
    const request = await this.#oidc(config).authorizationRequest();
    const binding = randomBytes(32).toString('base64url');
    this.#pending.set(request.state, { nonce: request.nonce, verifier: request.verifier, binding: sha(binding), until: now + PENDING_MS, key: this.#client!.key, confirm18: input.confirm18 === true,
      ...(typeof input.code === 'string' ? { code: input.code } : {}), ...(input.link && principal ? { link: { identityId: principal.identityId, authEpoch: principal.authEpoch, sessionId: principal.sessionId } } : {}) });
    return { url: request.url, binding };
  }

  #refuse(reason: SsoReason, actorId?: string): { reason: SsoReason } {
    try { appendAudit(this.#control.database, { action: 'sso.refused', ...(actorId ? { actorId } : {}) }); } catch { /* Refusal stands without its audit row. */ }
    return { reason };
  }

  #evaluate(config: SsoConfig, claims: OidcClaims): Evaluated | { ok: false; reason: SsoReason } {
    const email = typeof claims.email === 'string' ? claims.email : config.preset === 'entra' && typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : undefined;
    if (config.allowedDomains.length) {
      const domain = email && /^[^@\s]+@([^@\s]+)$/.exec(email)?.[1]?.toLowerCase();
      if (!domain || claims.email_verified === false || !config.allowedDomains.includes(domain)) return { ok: false, reason: 'domain' };
    }
    let role: 'orgadmin' | 'user' | undefined;
    if (config.adminGroups.length || config.memberGroups.length) {
      const raw = claims[config.groupClaim];
      const groups = new Set(Array.isArray(raw) ? raw.filter(g => typeof g === 'string') as string[] : typeof raw === 'string' ? [raw] : []);
      role = config.adminGroups.some(g => groups.has(g)) ? 'orgadmin' : config.memberGroups.some(g => groups.has(g)) ? 'user' : undefined;
      if (!role) return { ok: false, reason: 'group' };
    }
    const name = (typeof claims.name === 'string' ? claims.name : email?.split('@')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Business user';
    return { ok: true, ...(role ? { role } : {}), name };
  }

  #provisionedFor(config: SsoConfig, claims: OidcClaims): string | undefined {
    const email = typeof claims.email === 'string' ? claims.email : config.preset === 'entra' && typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : undefined;
    const id = email ? this.#provisioned(email) : undefined;
    // Never re-point an account that is already linked to someone else at this provider.
    return id && !this.#control.database.prepare('SELECT 1 FROM business_sso_links WHERE issuer=? AND identity_id=?').get(claims.iss, id) ? id : undefined;
  }
  #link(issuer: string, subject: string): string | undefined {
    const row = this.#control.database.prepare('SELECT identity_id FROM business_sso_links WHERE issuer=? AND subject=?').get(issuer, subject);
    return row ? String(row.identity_id) : undefined;
  }
  #insertLink(issuer: string, subject: string, identityId: string): void {
    this.#control.database.prepare('INSERT INTO business_sso_links(issuer,subject,identity_id,linked_at) VALUES (?,?,?,?)').run(issuer, subject, identityId, Date.now());
  }
  #session(identity: BusinessIdentity, config: SsoConfig): BusinessSession { return this.#auth.ssoSession(identity, config.sessionHours * 3600); }

  async callback(params: URLSearchParams, binding: string | undefined): Promise<{ session: BusinessSession } | { reason: SsoReason }> {
    const state = params.get('state') ?? '';
    const pending = this.#pending.get(state); this.#pending.delete(state);
    if (!pending || pending.until <= Date.now() || !binding || sha(binding) !== pending.binding) return this.#refuse('state');
    const config = this.config();
    if (!config.enabled) return this.#refuse('unavailable');
    const client = this.#oidc(config);
    if (this.#client!.key !== pending.key) return this.#refuse('state');
    if (params.has('error') || !params.get('code')) return this.#refuse('denied');
    let claims: OidcClaims; let refreshToken: string | undefined;
    try { ({ claims, refreshToken } = await client.exchange(params.get('code')!, pending.verifier, pending.nonce)); }
    catch (error) { return this.#refuse(error instanceof OidcError && error.code === 'network' ? 'unavailable' : 'failed'); }
    const verdict = this.#evaluate(config, claims);
    if (!verdict.ok) return this.#refuse(verdict.reason);
    const linked = this.#link(claims.iss, claims.sub);
    let session: BusinessSession;
    try {
      if (pending.link) {
        const { identityId, authEpoch, sessionId } = pending.link;
        const own = this.#control.database.prepare('SELECT subject FROM business_sso_links WHERE issuer=? AND identity_id=?').get(claims.iss, identityId);
        if ((linked && linked !== identityId) || (own && own.subject !== claims.sub)) return this.#refuse('linked', identityId);
        const identity = this.#control.identities.get(identityId);
        if (!identity || identity.status !== 'active' || identity.authEpoch !== authEpoch || !this.#auth.isPrincipalActive({ identityId, authEpoch, sessionId, expiresAt: Number.MAX_SAFE_INTEGER, credentialKind: 'browser' })) return this.#refuse('disabled', identityId);
        if (!linked) { this.#insertLink(claims.iss, claims.sub, identityId); appendAudit(this.#control.database, { action: 'sso.link', actorId: identityId, subjectId: identityId }); }
        session = this.#session(identity, config);
      } else if (linked) {
        const identity = this.#control.identities.get(linked); const member = this.#control.organizationMembership(linked);
        if (!identity || identity.status !== 'active' || !member || member.status !== 'active') return this.#refuse('disabled', linked);
        session = this.#session(identity, config);
      } else if (pending.code === undefined && claims.email_verified !== false && this.#provisionedFor(config, claims)) {
        const id = this.#provisionedFor(config, claims)!;
        const identity = this.#control.identities.get(id); const member = this.#control.organizationMembership(id);
        if (!identity || identity.status !== 'active' || !member || member.status !== 'active') return this.#refuse('disabled', id);
        if (!pending.confirm18) return this.#refuse('adult');
        this.#insertLink(claims.iss, claims.sub, id); appendAudit(this.#control.database, { action: 'sso.link', actorId: id, subjectId: id });
        session = this.#session(identity, config);
      } else if (pending.code !== undefined) {
        if (!pending.confirm18) return this.#refuse('adult');
        try {
          session = this.#control.redeemInvite(pending.code, { name: verdict.name, confirm18: true }, { createIdentity: (name: string) => {
            const identity = this.#control.identities.create(name); this.#insertLink(claims.iss, claims.sub, identity.id); return this.#session(identity, config);
          } }).session!;
        } catch { return this.#refuse('invite'); }
      } else if (config.jit) {
        if (!pending.confirm18) return this.#refuse('adult');
        session = this.#control.ssoCreateMember(verdict.name, verdict.role ?? 'user', identity => { this.#insertLink(claims.iss, claims.sub, identity.id); return this.#session(identity, config); });
      } else return this.#refuse('no_account');
    } catch { return this.#refuse('failed'); }
    const principal = session.principal;
    if (verdict.role) this.#control.ssoSyncRole(principal.identityId, verdict.role);
    const now = Date.now();
    this.#control.database.prepare('INSERT INTO business_sso_sessions(identity_id,session_id,auth_epoch,issuer,subject,expires_at,next_check_at) VALUES (?,?,?,?,?,?,?)').run(principal.identityId, principal.sessionId, principal.authEpoch, claims.iss, claims.sub, principal.expiresAt, now + config.checkMinutes * 60_000);
    if (refreshToken) this.#tokens().set(`refresh:${principal.identityId}:${principal.sessionId}`, refreshToken);
    appendAudit(this.#control.database, { action: 'sso.signin', actorId: principal.identityId, revision: principal.authEpoch });
    return { session };
  }

  #gate(identityId: string, sessionId: string): number | false | undefined {
    const row = this.#control.database.prepare('SELECT expires_at,ended_at FROM business_sso_sessions WHERE identity_id=? AND session_id=?').get(identityId, sessionId);
    if (!row) return undefined;
    return row.ended_at !== null ? false : Number(row.expires_at);
  }
  #passkeyAllowed(identityId: string): boolean {
    const config = this.config();
    // Break-glass: the person who claimed the instance always keeps passkey sign-in.
    return !(config.enabled && config.enforce) || identityId === this.#control.identities.firstIdentityId();
  }
  isSsoSession(principal: BusinessPrincipal): boolean { return this.#gate(principal.identityId, principal.sessionId) !== undefined; }

  #end(identityId: string, sessionId: string, authEpoch: number, audit: boolean): void {
    this.#control.database.prepare('UPDATE business_sso_sessions SET ended_at=? WHERE identity_id=? AND session_id=? AND ended_at IS NULL').run(Date.now(), identityId, sessionId);
    try { const tokens = this.#tokens(); const name = `refresh:${identityId}:${sessionId}`; if (tokens.has(name)) tokens.delete(name); } catch { /* The session row already refuses it. */ }
    if (audit) appendAudit(this.#control.database, { action: 'sso.revoked', subjectId: identityId, revision: authEpoch });
    this.#auth.endSession(identityId, authEpoch, sessionId);
  }
  #endAll(): void {
    for (const row of this.#control.database.prepare('SELECT identity_id,session_id,auth_epoch FROM business_sso_sessions WHERE ended_at IS NULL').all()) this.#end(String(row.identity_id), String(row.session_id), Number(row.auth_epoch), false);
  }

  /** Ends the SSO record of a signing-out session; returns the IdP's end-session address when it has one. */
  async logout(principal: BusinessPrincipal): Promise<string | undefined> {
    if (this.#gate(principal.identityId, principal.sessionId) === undefined) return undefined;
    this.#end(principal.identityId, principal.sessionId, principal.authEpoch, false);
    const config = this.config();
    if (!config.enabled) return undefined;
    try { return await this.#oidc(config).endSessionUrl(this.#origin + '/'); } catch { return undefined; }
  }

  /** The session check: refresh at the IdP and re-apply the rules. `force` checks every open session now. */
  checkSessions(force = false): Promise<void> {
    if (this.#checking) return this.#checking;
    this.#checking = this.#check(force).finally(() => { this.#checking = undefined; });
    return this.#checking;
  }
  async #check(force: boolean): Promise<void> {
    if (this.#closed) return;
    const config = this.config(); const now = Date.now();
    const rows = this.#control.database.prepare(`SELECT identity_id,session_id,auth_epoch,issuer,subject,expires_at FROM business_sso_sessions WHERE ended_at IS NULL ${force ? '' : 'AND (next_check_at<=? OR expires_at<=?)'} LIMIT 500`).all(...(force ? [] : [now, now]));
    for (const row of rows) {
      if (this.#closed) return;
      const identityId = String(row.identity_id); const sessionId = String(row.session_id); const epoch = Number(row.auth_epoch);
      if (Number(row.expires_at) <= now || !config.enabled || row.issuer !== config.issuer) { this.#end(identityId, sessionId, epoch, false); continue; }
      const name = `refresh:${identityId}:${sessionId}`;
      const token = this.#tokens().get(name);
      const later = () => this.#control.database.prepare('UPDATE business_sso_sessions SET next_check_at=? WHERE identity_id=? AND session_id=?').run(Date.now() + config.checkMinutes * 60_000, identityId, sessionId);
      if (!token) { later(); continue; }
      try {
        const result = await this.#oidc(config).refresh(token, String(row.subject));
        if (this.#closed) return;
        if (result.refreshToken) this.#tokens().set(name, result.refreshToken);
        if (result.claims) {
          const verdict = this.#evaluate(config, result.claims);
          if (!verdict.ok) { this.#end(identityId, sessionId, epoch, true); continue; }
          if (verdict.role) this.#control.ssoSyncRole(identityId, verdict.role);
        }
        later();
      } catch (error) {
        if (this.#closed) return;
        // An IdP that cannot be reached is retried; any refusal or failed check ends the session now.
        if (error instanceof OidcError && (error.code === 'network' || error.code === 'discovery')) later();
        else this.#end(identityId, sessionId, epoch, true);
      }
    }
  }
  startTimer(): void {
    this.#timer = setInterval(() => { void this.checkSessions().catch(() => {}); }, 60_000); this.#timer.unref();
  }
  close(): void { this.#closed = true; if (this.#timer) clearInterval(this.#timer); }
  closing(): Promise<void> { return this.#checking ?? Promise.resolve(); }
}

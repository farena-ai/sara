// V0.8 (docs/SIGN_IN_SSO.md): OpenID Connect sign-in for every Sara server (personal and household),
// next to the owner token, passkeys and pairing codes, which always keep working (no lock-out).
// The protocol (PKCE, state, nonce, issuer/audience/expiry with clock skew, JWKS cache with a forced
// refetch on an unseen key id, end-session) is EC2's OidcClient; this file adds the household rules:
// who maps to which person (owner, member, kid) by link, email or group, role groups, and opt-in
// just-in-time members from an allow-list. Business mode keeps its own src/business/sso.ts.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OidcClient, OidcError, issuerAllowed, type OidcClaims } from './business/oidc.ts';
import type { Vault } from './vault.ts';

export type SsoRole = 'owner' | 'member' | 'kid';
export type SsoPresetId = 'entra' | 'okta' | 'google' | 'authentik' | 'keycloak' | 'pocketid' | 'authelia' | 'generic';
export const SSO_PRESET_IDS: readonly SsoPresetId[] = ['entra', 'okta', 'google', 'authentik', 'keycloak', 'pocketid', 'authelia', 'generic'];
/** Providers that only send groups when the `groups` scope is asked for. */
const GROUPS_SCOPE = new Set<SsoPresetId>(['authelia', 'pocketid', 'authentik', 'generic']);

export interface SsoPerson { id: string; name: string; role: SsoRole; active: boolean }
export interface SsoMatch { emails: string[]; groups: string[] }
export interface HomeSsoConfig {
  enabled: boolean; preset: SsoPresetId; issuer: string; clientId: string; origin: string; label: string;
  groupClaim: string; skewSeconds: number;
  /** Per person ('owner' or a member id): the emails and groups that are this person. */
  people: Record<string, SsoMatch>;
  /** When a role lists groups, a person with that role signs in only while in one of them. Owner groups also map to the owner. */
  roleGroups: Record<SsoRole, string[]>;
  /** Just-in-time members (off by default): a new adult member for an allowed email or group. */
  jit: { on: boolean; adults: boolean; emails: string[]; groups: string[] };
}
/** Plain reason codes (the web turns them into sentences); never provider text, tokens or claims. */
export type SsoReason = 'off' | 'state' | 'denied' | 'failed' | 'unavailable' | 'no_account' | 'group' | 'disabled' | 'linked' | 'email' | 'adult' | 'issuer' | 'audience' | 'expired' | 'signature' | 'unknown_key' | 'nonce' | 'client' | 'discovery' | 'network' | 'incomplete';
export type SsoDecision =
  | { ok: true; person: SsoPerson; by: 'link' | 'email' | 'group' | 'role' }
  | { ok: true; create: { name: string; role: 'member' }; by: 'jit' }
  | { ok: false; reason: SsoReason };
export interface SsoFacts { email?: string; verified: boolean; groups: string[]; name: string }
export interface SsoTestResult { at: string; ok: boolean; reason?: SsoReason; who?: string; role?: SsoRole; by?: string; email?: string; groups: string[]; create?: boolean }

export const SSO_CALLBACK = '/api/sso/callback';
export const SSO_BINDING_COOKIE = 'sara_sso';
export const SSO_TICKET_COOKIE = 'sara_sso_t';
const SECRET = 'sso:client-secret';
const PENDING_MS = 600_000;
const TICKET_MS = 120_000;
const EMPTY: HomeSsoConfig = {
  enabled: false, preset: 'generic', issuer: '', clientId: '', origin: '', label: '', groupClaim: 'groups', skewSeconds: 60,
  people: {}, roleGroups: { owner: [], member: [], kid: [] }, jit: { on: false, adults: false, emails: [], groups: [] },
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const rand = () => randomBytes(32).toString('base64url');
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,253}$/;

export class SsoInputError extends Error {}
function bad(what: string): never { throw new SsoInputError(what); }
function list(v: unknown, max: number, each: (s: string) => boolean, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) bad(what);
  const out = (v as unknown[]).map(x => (typeof x === 'string' ? x.trim() : x));
  if (out.some(x => typeof x !== 'string' || !each(x))) bad(what);
  return [...new Set(out as string[])];
}
const emails = (v: unknown, max: number) => list(v, max, s => EMAIL.test(s), 'email').map(s => s.toLowerCase());
const groups = (v: unknown, max: number) => list(v, max, s => plain(s, 256), 'group');

/** What the ID token says about the person (email only counts when not marked unverified). */
export function claimFacts(cfg: Pick<HomeSsoConfig, 'groupClaim' | 'preset'>, claims: Record<string, unknown>): SsoFacts {
  const raw = typeof claims.email === 'string' ? claims.email
    : cfg.preset === 'entra' && typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : undefined;
  const email = raw && EMAIL.test(raw) ? raw.toLowerCase() : undefined;
  const g = claims[cfg.groupClaim];
  const gs = (Array.isArray(g) ? g : typeof g === 'string' ? [g] : []).filter((x): x is string => plain(x, 256)).slice(0, 100);
  const name = (typeof claims.name === 'string' ? claims.name : email?.split('@')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return { ...(email ? { email } : {}), verified: claims.email_verified !== false, groups: gs, name: name || 'New member' };
}

const meets = (want: string[], have: string[]) => want.some(g => have.includes(g));

/** Who this sign-in is (pure; the Settings preview uses it too). */
export function decideSignIn(cfg: HomeSsoConfig, people: SsoPerson[], linkedTo: string | undefined, f: SsoFacts): SsoDecision {
  const byId = new Map(people.map(p => [p.id, p]));
  const order = [...people].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0));
  let person: SsoPerson | undefined; let by: 'link' | 'email' | 'group' | 'role' = 'link';
  if (linkedTo) person = byId.get(linkedTo);
  if (!person && f.email && f.verified) { person = order.find(p => cfg.people[p.id]?.emails.includes(f.email!)); by = 'email'; }
  if (!person) { person = order.find(p => meets(cfg.people[p.id]?.groups ?? [], f.groups)); by = 'group'; }
  if (!person && meets(cfg.roleGroups.owner, f.groups)) { person = byId.get('owner'); by = 'role'; }
  if (person) {
    if (!person.active) return { ok: false, reason: 'disabled' };
    const want = cfg.roleGroups[person.role];
    if (want.length && !meets(want, f.groups)) return { ok: false, reason: 'group' };
    return { ok: true, person, by };
  }
  if (!cfg.jit.on || !cfg.jit.adults) return { ok: false, reason: 'no_account' };
  const allowed = (f.email && f.verified && cfg.jit.emails.includes(f.email)) || meets(cfg.jit.groups, f.groups);
  if (!allowed) return { ok: false, reason: f.email && !f.verified ? 'email' : 'no_account' };
  // Kids are never made automatically: a parent or guardian makes a child's account with an invite.
  if (meets(cfg.roleGroups.kid, f.groups)) return { ok: false, reason: 'group' };
  if (cfg.roleGroups.member.length && !meets(cfg.roleGroups.member, f.groups)) return { ok: false, reason: 'group' };
  return { ok: true, create: { name: f.name, role: 'member' }, by: 'jit' };
}

export function redirectFor(origin: string): string { return origin.replace(/\/+$/, '') + SSO_CALLBACK; }

interface Stored { config: HomeSsoConfig; links: { iss: string; sub: string; person: string; at: string }[]; sessions: { space: string; sid: string; iss: string }[] }
interface Pending { nonce: string; verifier: string; binding: string; until: number; key: string; test: boolean; confirm18: boolean }
interface Ticket { until: number; iss: string; sub: string; decision: SsoDecision & { ok: true }; confirm18: boolean }
export interface SsoFinish { target: { person: SsoPerson } | { create: { name: string } }; confirm18: boolean; complete: (personId: string, space: string, sessionId: string) => void }

export interface HomeSsoOptions {
  dataDir: string; vault: Pick<Vault, 'get' | 'set' | 'delete' | 'has'>;
  /** The owner and every household member, read live. */
  people: () => SsoPerson[];
  privateLocal?: () => boolean; fetch?: typeof fetch; now?: () => number;
}

export class HomeSso {
  readonly #o: HomeSsoOptions;
  readonly #file: string;
  readonly #pending = new Map<string, Pending>();
  readonly #tickets = new Map<string, Ticket>();
  #test?: SsoTestResult;
  #client?: { key: string; client: OidcClient };

  constructor(o: HomeSsoOptions) { this.#o = o; this.#file = join(o.dataDir, 'sso.json'); }
  #now() { return this.#o.now?.() ?? Date.now(); }
  #pl() { return Boolean(this.#o.privateLocal?.()); }

  #read(): Stored {
    try {
      const s = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<Stored>;
      const c = (s.config ?? {}) as Partial<HomeSsoConfig>;
      return { config: { ...EMPTY, ...c, roleGroups: { ...EMPTY.roleGroups, ...(c.roleGroups ?? {}) }, jit: { ...EMPTY.jit, ...(c.jit ?? {}) }, people: c.people ?? {} }, links: Array.isArray(s.links) ? s.links : [], sessions: Array.isArray(s.sessions) ? s.sessions : [] };
    } catch { return { config: structuredClone(EMPTY), links: [], sessions: [] }; }
  }
  #write(s: Stored) { const tmp = this.#file + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 }); renameSync(tmp, this.#file); }

  config(): HomeSsoConfig { return this.#read().config; }
  secretSaved(): boolean { return Boolean(this.#o.vault.get(SECRET)); }
  /** The public sign-in button (no secrets): shown when on and complete. */
  status(): { enabled: boolean; label?: string; jit?: boolean } {
    const c = this.config();
    return c.enabled && c.issuer && c.clientId && c.origin ? { enabled: true, label: c.label || '', ...(c.jit.on ? { jit: true } : {}) } : { enabled: false };
  }
  view(pageOrigin?: string) {
    const s = this.#read(); const people = this.#o.people();
    const origin = s.config.origin || pageOrigin || '';
    return {
      ...s.config, secretSaved: this.secretSaved(), redirectUrl: origin ? redirectFor(origin) : '',
      people: people.map(p => ({ ...p, ...(s.config.people[p.id] ?? { emails: [], groups: [] }), linked: s.links.filter(l => l.person === p.id).length })),
      test: this.#test ?? null,
    };
  }

  save(input: Record<string, unknown>): ReturnType<HomeSso['view']> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('body');
    const allowed = new Set(['enabled', 'preset', 'issuer', 'clientId', 'clientSecret', 'origin', 'label', 'groupClaim', 'skewSeconds', 'people', 'roleGroups', 'jit']);
    for (const k of Object.keys(input)) if (!allowed.has(k)) bad(k);
    const s = this.#read(); const before = s.config; const next: HomeSsoConfig = structuredClone(before);
    if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') bad('enabled'); next.enabled = input.enabled as boolean; }
    if (input.preset !== undefined) { if (!SSO_PRESET_IDS.includes(input.preset as SsoPresetId)) bad('preset'); next.preset = input.preset as SsoPresetId; }
    if (input.issuer !== undefined) {
      const v = typeof input.issuer === 'string' ? input.issuer.trim() : input.issuer;
      if (v !== '' && (!plain(v, 512) || !issuerAllowed(v, this.#pl()))) bad('issuer');
      next.issuer = String(v);
    }
    if (input.clientId !== undefined) { const v = typeof input.clientId === 'string' ? input.clientId.trim() : input.clientId; if (v !== '' && !plain(v, 256)) bad('clientId'); next.clientId = String(v); }
    if (input.origin !== undefined) {
      let v = '';
      if (input.origin !== '') { try { const u = new URL(String(input.origin)); if (!/^https?:$/.test(u.protocol) || u.username || u.password) bad('origin'); v = u.origin; } catch (e) { if (e instanceof SsoInputError) throw e; bad('origin'); } }
      next.origin = v;
    }
    if (input.label !== undefined) { if (input.label !== '' && !plain(input.label, 40)) bad('label'); next.label = String(input.label).trim(); }
    if (input.groupClaim !== undefined) { if (typeof input.groupClaim !== 'string' || !/^[A-Za-z0-9_:./-]{1,64}$/.test(input.groupClaim)) bad('groupClaim'); next.groupClaim = input.groupClaim; }
    if (input.skewSeconds !== undefined) { if (!Number.isSafeInteger(input.skewSeconds) || Number(input.skewSeconds) < 0 || Number(input.skewSeconds) > 300) bad('skewSeconds'); next.skewSeconds = Number(input.skewSeconds); }
    if (input.people !== undefined) {
      const p = input.people as Record<string, unknown>;
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length > 60) bad('people');
      next.people = {};
      for (const [id, m] of Object.entries(p)) {
        if (!/^(owner|[a-z0-9]{1,40})$/.test(id) || !m || typeof m !== 'object') bad('people');
        const e = emails((m as SsoMatch).emails, 20); const g = groups((m as SsoMatch).groups, 20);
        if (e.length || g.length) next.people[id] = { emails: e, groups: g };
      }
      const seen = new Map<string, string>();
      for (const [id, m] of Object.entries(next.people)) for (const e of m.emails) { if (seen.has(e) && seen.get(e) !== id) bad('duplicate'); seen.set(e, id); }
    }
    if (input.roleGroups !== undefined) {
      const r = input.roleGroups as Record<string, unknown>;
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['owner', 'member', 'kid'].includes(k))) bad('roleGroups');
      next.roleGroups = { owner: groups(r.owner, 50), member: groups(r.member, 50), kid: groups(r.kid, 50) };
    }
    if (input.jit !== undefined) {
      const j = input.jit as Record<string, unknown>;
      if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).some(k => !['on', 'adults', 'emails', 'groups'].includes(k))) bad('jit');
      if ((j.on !== undefined && typeof j.on !== 'boolean') || (j.adults !== undefined && typeof j.adults !== 'boolean')) bad('jit');
      next.jit = { on: Boolean(j.on), adults: Boolean(j.adults), emails: emails(j.emails, 100), groups: groups(j.groups, 50) };
      if (next.jit.on && !next.jit.adults) bad('adults');
    }
    const secret = input.clientSecret;
    if (secret !== undefined && secret !== '' && (!plain(secret, 4096) || /\s/.test(secret))) bad('clientSecret');
    if (next.enabled && (!next.issuer || !next.clientId || !next.origin || ((secret === undefined || secret === '') && !this.secretSaved()))) bad('incomplete');
    if (typeof secret === 'string' && secret) this.#o.vault.set(SECRET, secret);
    const moved = before.issuer !== next.issuer || before.clientId !== next.clientId;
    s.config = next;
    // A different provider: old links mean nothing there (and old sessions stay as they are: the token still works).
    if (moved) s.links = s.links.filter(l => l.iss === next.issuer);
    this.#write(s);
    this.#client = undefined;
    return this.view();
  }

  #oidc(c = this.config()): { key: string; client: OidcClient } {
    const secret = this.#o.vault.get(SECRET) ?? '';
    const key = sha(JSON.stringify([c.issuer, c.clientId, c.origin, c.preset, c.skewSeconds, secret, this.#pl()]));
    if (this.#client?.key !== key) {
      const scope = 'openid email profile' + (GROUPS_SCOPE.has(c.preset) ? ' groups' : '');
      this.#client = { key, client: new OidcClient({
        issuer: c.issuer, clientId: c.clientId, clientSecret: secret, redirectUri: redirectFor(c.origin), scope, skewSeconds: c.skewSeconds,
        privateLocal: this.#pl(), params: c.preset === 'google' || c.preset === 'entra' ? { prompt: 'select_account' } : {},
        ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}), ...(this.#o.now ? { now: this.#o.now } : {}),
      }) };
    }
    return this.#client;
  }

  /** "Check the provider": discovery plus a fresh key download. */
  async check(): Promise<{ ok: true; keys: number; endSession: boolean } | { ok: false; reason: SsoReason }> {
    const c = this.config();
    if (!c.issuer || !c.clientId || !c.origin) return { ok: false, reason: 'incomplete' };
    try {
      const { client } = this.#oidc(c); const meta = await client.discover();
      return { ok: true, keys: await client.keyCount(), endSession: Boolean(meta.end_session_endpoint) };
    } catch (e) { return { ok: false, reason: e instanceof OidcError ? e.code as SsoReason : 'network' }; }
  }

  /** Starts a sign-in (or the owner's Test sign-in, which signs nobody in and links nothing). */
  async start(o: { test?: boolean; confirm18?: boolean } = {}): Promise<{ url: string; binding: string }> {
    const c = this.config();
    if (o.test) { if (!c.issuer || !c.clientId || !c.origin || !this.secretSaved()) throw new SsoInputError('incomplete'); }
    else if (!this.status().enabled) throw new SsoInputError('off');
    const now = this.#now();
    for (const [k, p] of this.#pending) if (p.until <= now) this.#pending.delete(k);
    if (this.#pending.size >= 200) throw new SsoInputError('busy');
    const { key, client } = this.#oidc(c);
    const r = await client.authorizationRequest();
    const binding = rand();
    this.#pending.set(r.state, { nonce: r.nonce, verifier: r.verifier, binding: sha(binding), until: now + PENDING_MS, key, test: Boolean(o.test), confirm18: o.confirm18 === true });
    return { url: r.url, binding };
  }

  #linkOf(iss: string, sub: string) { return this.#read().links.find(l => l.iss === iss && l.sub === sub)?.person; }

  /** The provider sent the browser back: every check, then a one-use ticket for /api/sso/finish. */
  async callback(params: URLSearchParams, binding: string | undefined): Promise<{ ticket: string } | { reason: SsoReason } | { test: true }> {
    const state = params.get('state') ?? '';
    const p = this.#pending.get(state); this.#pending.delete(state);
    if (!p || p.until <= this.#now() || !binding || sha(binding) !== p.binding) return { reason: 'state' };
    const c = this.config();
    const done = (r: Omit<SsoTestResult, 'at' | 'groups'> & { groups?: string[] }) => { this.#test = { at: new Date(this.#now()).toISOString(), groups: [], ...r }; return { test: true as const }; };
    const { key, client } = this.#oidc(c);
    if (key !== p.key) return p.test ? done({ ok: false, reason: 'state' }) : { reason: 'state' };
    if (!p.test && !this.status().enabled) return { reason: 'off' };
    if (params.has('error') || !params.get('code')) return p.test ? done({ ok: false, reason: 'denied' }) : { reason: 'denied' };
    let claims: OidcClaims;
    try { ({ claims } = await client.exchange(params.get('code')!, p.verifier, p.nonce)); }
    catch (e) {
      const code = e instanceof OidcError ? e.code : 'failed';
      const reason: SsoReason = code === 'network' ? 'unavailable' : (['issuer', 'audience', 'expired', 'signature', 'unknown_key', 'nonce', 'client', 'discovery'] as string[]).includes(code) ? code as SsoReason : 'failed';
      return p.test ? done({ ok: false, reason }) : { reason: reason === 'unavailable' ? 'unavailable' : 'failed' };
    }
    const f = claimFacts(c, claims);
    const linked = this.#linkOf(claims.iss, claims.sub);
    let d = decideSignIn(c, this.#o.people(), linked, f);
    // One provider account per person: a second account with the same email does not take over.
    if (d.ok && 'person' in d && !linked) { const id = d.person.id; if (this.#read().links.some(l => l.iss === claims.iss && l.person === id)) d = { ok: false, reason: 'linked' }; }
    if (p.test) {
      return d.ok
        ? done({ ok: true, by: d.by, groups: f.groups, ...(f.email ? { email: f.email } : {}), ...('person' in d ? { who: d.person.name, role: d.person.role } : { who: d.create.name, role: 'member', create: true }) })
        : done({ ok: false, reason: d.reason, groups: f.groups, ...(f.email ? { email: f.email } : {}) });
    }
    if (!d.ok) return { reason: d.reason };
    if ('create' in d && !p.confirm18) return { reason: 'adult' };
    const ticket = rand();
    for (const [k, t] of this.#tickets) if (t.until <= this.#now()) this.#tickets.delete(k);
    this.#tickets.set(sha(ticket), { until: this.#now() + TICKET_MS, iss: claims.iss, sub: claims.sub, decision: d, confirm18: p.confirm18 });
    return { ticket };
  }

  /** One use: who to sign in. The caller makes the session, then `complete` links and records it. */
  finish(ticket: string | undefined): SsoFinish | undefined {
    if (!ticket) return undefined;
    const k = sha(ticket); const t = this.#tickets.get(k); this.#tickets.delete(k);
    if (!t || t.until <= this.#now()) return undefined;
    const d = t.decision;
    // Re-read the person: suspended or removed in the two minutes since the callback means no.
    if ('person' in d) {
      const now = this.#o.people().find(p => p.id === d.person.id);
      if (!now || !now.active) return undefined;
    }
    return {
      target: 'person' in d ? { person: d.person } : { create: d.create }, confirm18: t.confirm18,
      complete: (personId, space, sessionId) => {
        const s = this.#read();
        if (!s.links.some(l => l.iss === t.iss && l.sub === t.sub)) s.links.push({ iss: t.iss, sub: t.sub, person: personId, at: new Date(this.#now()).toISOString() });
        s.sessions = [...s.sessions.filter(x => !(x.space === space && x.sid === sessionId)), { space, sid: sessionId, iss: t.iss }].slice(-300);
        this.#write(s);
      },
    };
  }

  /** Settings preview: "who would this be?" for an email and groups typed by the owner. */
  preview(input: { email?: unknown; groups?: unknown }): SsoDecision {
    const email = typeof input.email === 'string' && EMAIL.test(input.email.trim()) ? input.email.trim().toLowerCase() : undefined;
    const gs = Array.isArray(input.groups) ? input.groups.filter((g): g is string => plain(g, 256)).slice(0, 50) : [];
    return decideSignIn(this.config(), this.#o.people(), undefined, { ...(email ? { email } : {}), verified: true, groups: gs, name: email?.split('@')[0] ?? 'New member' });
  }
  testResult(): SsoTestResult | null { return this.#test ?? null; }

  /** Removes a person's provider links (Settings "Unlink", or a member removed). */
  unlink(personId: string): number {
    const s = this.#read(); const before = s.links.length;
    s.links = s.links.filter(l => l.person !== personId);
    if (s.links.length !== before) this.#write(s);
    return before - s.links.length;
  }

  /** Sign-out of a session that came from the provider: the provider's own sign-out page, when it has one. */
  async signedOut(space: string, sessionId: string | undefined): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const s = this.#read(); const row = s.sessions.find(x => x.space === space && x.sid === sessionId);
    if (!row) return undefined;
    s.sessions = s.sessions.filter(x => x !== row); this.#write(s);
    const c = s.config;
    if (!c.enabled || row.iss !== c.issuer || !c.origin) return undefined;
    try { return await this.#oidc(c).client.endSessionUrl(c.origin + '/'); } catch { return undefined; }
  }
}

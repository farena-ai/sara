import { initializeRecovery, recoveryMode, recoveryHash } from './recovery.ts';
import { BusinessLifecycle } from './lifecycle.ts';
import { initializeAudit, appendAudit } from './audit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerAuth } from '../auth.ts';
import { FirstClaim } from '../claim.ts';
import type { BusinessProfile } from './profile.ts';
import { BUSINESS_UUID, type BusinessIdentity, type BusinessPrincipal } from './types.ts';
import { newChallenge, verifyAssertion, verifyRegistration } from '../webauthn.ts';

export interface IdentityDirectory {
  get(id: string): BusinessIdentity | undefined;
  create(name: string): BusinessIdentity;
  firstIdentityId(): string | undefined;
  claimAvailable(): boolean;
  recordFirstIdentity(id: string): void;
  credentialIdentity(credentialId: string): { identityId: string; authEpoch: number } | undefined;
  bindCredential(credentialId: string, identity: BusinessIdentity): void;
}

/** Task-specific schema composes with the business control tables in the same database. */
export class BusinessIdentityDirectory implements IdentityDirectory {
  readonly database: DatabaseSync;
  readonly lifecycle = new BusinessLifecycle();
  constructor(profile: BusinessProfile) {
    this.database = new DatabaseSync(join(profile.businessDir, 'business.db'));
    this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS business_identities (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0), created_at TEXT NOT NULL,
        adult_confirmed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_credential_refs (
        credential_id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES business_identities(id),
        auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0)
      );
    `);
    initializeAudit(this.database);
    initializeRecovery(this.database);
    this.database.exec(`CREATE TRIGGER IF NOT EXISTS audit_identity_create AFTER INSERT ON business_identities BEGIN INSERT INTO business_audit(at,action,actor_id,subject_id,revision) VALUES (unixepoch()*1000,'identity.create',NEW.id,NEW.id,NEW.auth_epoch); END;
      CREATE TRIGGER IF NOT EXISTS audit_identity_epoch AFTER UPDATE OF auth_epoch,status ON business_identities BEGIN INSERT INTO business_audit(at,action,subject_id,revision) VALUES (unixepoch()*1000,'identity.epoch',NEW.id,NEW.auth_epoch); END;
      CREATE TRIGGER IF NOT EXISTS audit_identity_credential AFTER INSERT ON business_credential_refs BEGIN INSERT INTO business_audit(at,action,actor_id,subject_id,revision) VALUES (unixepoch()*1000,'identity.credential',NEW.identity_id,NEW.identity_id,NEW.auth_epoch); END;`);
  }
  get(id: string): BusinessIdentity | undefined {
    this.lifecycle.assertAdmission();
    if (!BUSINESS_UUID.test(id)) return undefined;
    const row = this.database.prepare('SELECT id, name, status, auth_epoch AS authEpoch, created_at AS createdAt FROM business_identities WHERE id = ?').get(id);
    if (!row || !Number.isSafeInteger(row.authEpoch) || Number(row.authEpoch) < 0) return undefined;
    return { ...row } as unknown as BusinessIdentity;
  }
  create(name: string): BusinessIdentity {
    this.lifecycle.assertAdmission();
    if (recoveryMode(this.database)) throw new Error('Identity creation is closed during recovery.');
    const identity: BusinessIdentity = { id: randomUUID(), name: name.trim().slice(0, 80) || 'Business user', status: 'active', authEpoch: 0, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO business_identities (id,name,status,auth_epoch,created_at,adult_confirmed_at) VALUES (?,?,?,?,?,?)').run(identity.id, identity.name, identity.status, identity.authEpoch, identity.createdAt, identity.createdAt);
    return identity;
  }
  firstIdentityId(): string | undefined {
    const first = this.database.prepare("SELECT value FROM business_meta WHERE key = 'first_identity_id'").get();
    if (first) return String(first.value);
    return undefined;
  }
  claimAvailable(): boolean {
    // Partial bootstrap is fail closed; never silently reopen claim after a crash.
    return this.firstIdentityId() === undefined && !this.database.prepare('SELECT id FROM business_identities LIMIT 1').get();
  }
  recordFirstIdentity(id: string): void {
    this.lifecycle.assertAdmission();
    this.database.prepare("INSERT INTO business_meta (key,value) VALUES ('first_identity_id',?)").run(id);
  }
  credentialIdentity(credentialId: string): { identityId: string; authEpoch: number } | undefined {
    const row = this.database.prepare('SELECT identity_id AS identityId, auth_epoch AS authEpoch FROM business_credential_refs WHERE credential_id=?').get(credentialId);
    return row ? { ...row } as unknown as { identityId: string; authEpoch: number } : undefined;
  }
  bindCredential(credentialId: string, identity: BusinessIdentity): void {
    this.lifecycle.assertAdmission();
    this.database.prepare('INSERT INTO business_credential_refs (credential_id,identity_id,auth_epoch) VALUES (?,?,?)').run(credentialId, identity.id, identity.authEpoch);
  }
  close(): void { this.database.close(); }
}

export const BUSINESS_COOKIE = 'sara_business_session';
export interface BusinessSession { value: string; maxAgeSeconds: number; principal: BusinessPrincipal }
type Ceremony = { identityId?: string; epoch?: number; challenge: string; kind: 'register' | 'login'; until: number; sessionId?: string };

/** Narrow adapter: no owner token, device key, legacy cookie, or personal fallback is exposed. */
export class BusinessAuth {
  readonly #profile: BusinessProfile;
  readonly #identities: IdentityDirectory;
  readonly #claim: FirstClaim;
  readonly #ceremonies = new Map<string, Ceremony>();
  readonly #sessionInvalidations = new Set<() => void>();
  constructor(profile: BusinessProfile, identities: IdentityDirectory) {
    this.#profile = profile;
    this.#identities = identities;
    this.#claim = new FirstClaim({ mode: 'code', pending: () => identities.claimAvailable() });
  }
  reenroll(code: unknown, confirm18: boolean): BusinessSession {
    if (!(this.#identities instanceof BusinessIdentityDirectory) || typeof code !== 'string' || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(code) || confirm18 !== true) throw new Error('Re-enrollment denied.');
    this.#identities.lifecycle.assertAdmission();
    const db = this.#identities.database; db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM business_reenrollment WHERE secret_hash=? AND used_at IS NULL AND expires_at>?').get(recoveryHash(code), Date.now());
      if (!row) throw new Error('Re-enrollment denied.');
      const identity = this.#identities.get(String(row.identity_id));
      if (!identity || identity.authEpoch !== row.epoch || identity.status !== 'active' && row.allow_reactivate !== 1) throw new Error('Re-enrollment denied.');
      db.prepare("UPDATE business_identities SET status='active' WHERE id=?").run(identity.id);
      db.prepare('UPDATE business_reenrollment SET used_at=? WHERE identity_id=?').run(Date.now(), identity.id);
      db.prepare('INSERT OR REPLACE INTO business_recovery_fresh VALUES (?,?,0)').run(identity.id, identity.authEpoch);
      const session = this.#session({ ...identity, status: 'active' });
      appendAudit(db, { action: 'identity.signin', actorId: identity.id, revision: identity.authEpoch });
      db.exec('COMMIT'); return session;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  get claimCode(): string | undefined { return this.#claim.code; }
  claimStatus() { return this.#claim.status(); }
  #auth(identity: BusinessIdentity, create = false): OwnerAuth | undefined {
    const dir = join(this.#profile.businessDir, 'auth', identity.id, String(identity.authEpoch));
    const path = join(dir, 'owner.json');
    if (!create && !existsSync(path)) return undefined;
    const scopePath = join(dir, 'scope.json');
    if (existsSync(path)) {
      if (!existsSync(scopePath)) throw new Error('Unscoped authentication files cannot be imported into a business profile.');
      const scope = JSON.parse(readFileSync(scopePath, 'utf8')) as { profile?: string; identityId?: string; authEpoch?: number };
      if (scope.profile !== 'business' || scope.identityId !== identity.id || scope.authEpoch !== identity.authEpoch) throw new Error('Authentication scope mismatch.');
      const record = JSON.parse(readFileSync(path, 'utf8')) as { legacy?: boolean; sessions?: unknown };
      if (record.legacy || !Array.isArray(record.sessions)) throw new Error('Legacy authentication files cannot be used in a business profile.');
    }
    if (create) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(scopePath)) writeFileSync(scopePath, JSON.stringify({ profile: 'business', identityId: identity.id, authEpoch: identity.authEpoch }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return new OwnerAuth(dir, undefined, { tokenPrefix: `sara_business.${identity.id}.` });
  }
  #session(identity: BusinessIdentity): BusinessSession {
    if (this.#identities instanceof BusinessIdentityDirectory) appendAudit(this.#identities.database, { action: 'identity.signin.attempt', actorId: identity.id, revision: identity.authEpoch });
    const auth = this.#auth(identity, true)!;
    auth.markSignedIn();
    const session = auth.createSession();
    return { value: `${identity.id}.${identity.authEpoch}.${session.value}`, maxAgeSeconds: session.maxAgeSeconds, principal: { identityId: identity.id, authEpoch: identity.authEpoch, sessionId: session.id, expiresAt: Number(session.value.split('.')[0]), credentialKind: 'browser' } };
  }
  /** Internal invitation seam; callers must complete their own invitation/policy transaction. */
  createIdentity(name: string, confirm18: boolean): BusinessSession {
    if (confirm18 !== true) throw new Error('Adult confirmation (18+) is required.');
    return this.#session(this.#identities.create(name));
  }
  claim(ip: string, code: unknown, name: string, confirm18 = false): BusinessSession | undefined {
    if (confirm18 !== true) return undefined;
    const check = this.#claim.check(ip, code);
    if (!check.ok) { if (check.wrongCode) this.#claim.failed(); return undefined; }
    const session = this.createIdentity(name, confirm18);
    this.#identities.recordFirstIdentity(session.principal.identityId);
    this.#claim.finish();
    return session;
  }
  principal(value: string | undefined): BusinessPrincipal | undefined {
    if (!value || value.length > 2048) return undefined;
    const [id, epoch, ...cookie] = value.split('.');
    const identity = this.#identities.get(id);
    if (!identity || identity.status !== 'active' || String(identity.authEpoch) !== epoch) return undefined;
    try {
      const sessionId = this.#auth(identity)?.sessionId(cookie.join('.'));
      const expiresAt = Number(cookie[0]);
      return sessionId && Number.isSafeInteger(expiresAt) ? { identityId: id, authEpoch: identity.authEpoch, sessionId, expiresAt, credentialKind: 'browser' } : undefined;
    } catch {
      // Damaged or imported auth material never becomes a legacy sign-in migration.
      return undefined;
    }
  }
  /** Recheck an already authenticated actor without retaining or exposing its raw cookie. */
  isPrincipalActive(principal: BusinessPrincipal): boolean {
    const identity = this.#identities.get(principal.identityId);
    if (!identity || identity.status !== 'active' || identity.authEpoch !== principal.authEpoch || principal.credentialKind !== 'browser' || !Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= Date.now()) return false;
    try {
      const device = this.#auth(identity)?.devices().find(device => device.id === principal.sessionId && device.kind === 'browser');
      return !!device;
    } catch { return false; }
  }
  logout(principal: BusinessPrincipal): void {
    const identity = this.#active(principal.identityId, principal.authEpoch);
    if (this.#identities instanceof BusinessIdentityDirectory) appendAudit(this.#identities.database, { action: 'identity.logout.attempt', actorId: identity.id, revision: identity.authEpoch });
    this.#auth(identity)?.signOut(principal.sessionId);
    for (const listener of this.#sessionInvalidations) { try { listener(); } catch { /* Session removal has already completed. */ } }
  }
  /** Runtime-owned listeners close active transports immediately after explicit sign-out. */
  onSessionInvalidated(listener: () => void): () => void {
    this.#sessionInvalidations.add(listener); return () => { this.#sessionInvalidations.delete(listener); };
  }
  #active(id: string, epoch?: number): BusinessIdentity {
    const identity = this.#identities.get(id);
    if (!identity || identity.status !== 'active' || (epoch !== undefined && identity.authEpoch !== epoch)) throw new Error('Sign-in required.');
    return identity;
  }
  options(kind: 'register' | 'login', identityId: string | undefined, origin: string, principal?: BusinessPrincipal) {
    const identity = identityId ? this.#active(identityId) : undefined;
    if (kind === 'register' && (!identity || !principal || principal.identityId !== identityId || principal.authEpoch !== identity.authEpoch || !this.isPrincipalActive(principal))) throw new Error('Sign-in required.');
    for (const [key, ceremony] of this.#ceremonies) if (ceremony.until <= Date.now()) this.#ceremonies.delete(key);
    if (this.#ceremonies.size >= 1000) throw new Error('Too many sign-in requests.');
    const challenge = newChallenge();
    this.#ceremonies.set(challenge, { identityId, epoch: identity?.authEpoch, challenge, kind, until: Date.now() + 120_000, sessionId: principal?.sessionId });
    const keys = identity ? this.#auth(identity)?.passkeys() ?? [] : [];
    const rpId = new URL(origin).hostname;
    return kind === 'register'
      ? { challenge, rp: { id: rpId, name: 'Sara Business' }, user: { id: Buffer.from(identity!.id).toString('base64url'), name: identity!.name, displayName: identity!.name }, pubKeyCredParams: [-7, -257, -8].map(alg => ({ type: 'public-key', alg })), authenticatorSelection: { userVerification: 'required', residentKey: 'required' }, attestation: 'none', timeout: 120_000, excludeCredentials: keys.map(k => ({ id: k.id, type: 'public-key' })) }
      : { challenge, rpId, userVerification: 'required', timeout: 120_000, allowCredentials: keys.map(k => ({ id: k.id, type: 'public-key' })) };
  }
  finish(kind: 'register' | 'login', challenge: string, response: unknown, origin: string, principal?: BusinessPrincipal): BusinessSession | undefined {
    if (kind === 'register' && (!principal || !this.isPrincipalActive(principal))) throw new Error('Sign-in required.');
    const ceremony = this.#ceremonies.get(challenge); this.#ceremonies.delete(challenge);
    if (!ceremony || ceremony.kind !== kind || ceremony.until <= Date.now()) throw new Error('Sign-in request expired.');
    if (!response || typeof response !== 'object') throw new Error('Invalid passkey response.');
    const input = response as Record<string, unknown>;
    if (typeof input.clientDataJSON !== 'string') throw new Error('Invalid passkey response.');
    const ref = kind === 'login' && typeof input.id === 'string' ? this.#identities.credentialIdentity(input.id) : undefined;
    const identityId = ceremony.identityId ?? ref?.identityId;
    if (!identityId || (kind === 'login' && (!ref || ref.identityId !== identityId))) throw new Error('Sign-in failed.');
    const identity = this.#active(identityId, ceremony.epoch ?? ref?.authEpoch);
    if (kind === 'login' && identity.authEpoch !== ref?.authEpoch) throw new Error('Sign-in failed.');
    const want = { challenge, origin, rpId: new URL(origin).hostname };
    if (kind === 'register') {
      if (!principal || principal.identityId !== identity.id || principal.sessionId !== ceremony.sessionId || principal.authEpoch !== identity.authEpoch) throw new Error('Sign-in required.');
      if (typeof input.attestationObject !== 'string') throw new Error('Invalid passkey response.');
      const key = verifyRegistration({ clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject }, want);
      if (this.#identities.credentialIdentity(key.id)) throw new Error('Passkey already registered.');
      // Verification must not turn a revoked/expired session into a persistent credential.
      if (!this.isPrincipalActive(principal)) throw new Error('Sign-in required.');
      const auth = this.#auth(identity)!;
      auth.addPasskey({ ...key, label: 'Passkey' });
      this.#identities.bindCredential(key.id, identity);
      if (this.#identities instanceof BusinessIdentityDirectory) this.#identities.database.prepare('UPDATE business_recovery_fresh SET registered=1 WHERE identity_id=? AND epoch=?').run(identity.id, identity.authEpoch);
      return undefined;
    }
    if (typeof input.id !== 'string' || typeof input.authenticatorData !== 'string' || typeof input.signature !== 'string') throw new Error('Invalid passkey response.');
    const auth = this.#auth(identity)!;
    const key = auth.passkey(input.id);
    if (!key) throw new Error('Sign-in failed.');
    auth.usedPasskey(key.id, verifyAssertion({ id: input.id, clientDataJSON: input.clientDataJSON, authenticatorData: input.authenticatorData, signature: input.signature }, key, want));
    return this.#session(identity);
  }
}

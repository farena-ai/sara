// Single-owner authentication. A random owner token is generated on first start and shown once
// in the server log; only its hash is stored. Browser sessions use an HMAC-signed cookie.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adminHint } from './platform.ts';
import { writeFileAtomic } from './fs-util.ts';
import { StartupError } from './settings.ts';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.ts';
import type { StoredPasskey } from './webauthn.ts';

const FILE = 'owner.json';
/** The last owner file that was saved whole: used if owner.json is ever found damaged. */
const BACKUP = 'owner.json.bak';
export const SESSION_COOKIE = 'sara_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A device token (terminal, VS Code) ends 90 days after approval even when used every day. */
export const DEVICE_TOKEN_MAX_MS = 90 * 24 * 60 * 60 * 1000;

interface DeviceSession {
  id: string;
  label: string;
  createdAt: string;
  lastSeen: string;
  /** Phase 52: an app signed in with the device code (terminal, VS Code): its token's hash. */
  tokenHash?: string;
  /**
   * Phase 57: 'api' = an API key the owner made for another app (SillyTavern, Open WebUI, Claude
   * Desktop…). It only works on /v1 (OpenAI-compatible) and /mcp, never on the app's own /api,
   * and lasts until the owner removes it under Devices.
   * Hardening M4: 'home-assistant' = the Home Assistant integration's device token: it may only talk
   * with her in the conversations it made itself (no other conversation, memory, file or setting).
   * Phase 87: 'hands' = Sara's hands on a computer (the desktop app's computer-use channel): it only
   * opens the /api/hands WebSocket, never the app's own API (docs/design/COMPUTER_USE.md §3.2).
   */
  kind?: 'api' | 'home-assistant' | 'hands' | 'a2a';
  /** Phase 100: an agent's key (kind 'a2a') stops working at this time (default 180 days). */
  expiresAt?: string;
}

interface OwnerFile {
  tokenHash: string;
  sessionSecret: string;
  /** Signed-in devices; a session cookie only works while its device is listed. */
  sessions?: DeviceSession[];
  /** Upgraded from a version without the device list: earlier cookies are added as they show up. */
  legacy?: boolean;
  /** Phase 24: passkeys (WebAuthn) that can sign in. */
  passkeys?: StoredPasskey[];
  /** Phase 24: two-step sign-in (authenticator app). `pending` until the first code is confirmed. */
  totp?: { secret: string; enabledAt: string | null; lastCounter: number };
  /**
   * Phase 59: set on a brand-new server until the owner first signs in (or claims it in the
   * browser, src/claim.ts). Owner files from before Phase 59, and every token reset, don't have it,
   * so browser setup never reopens on a server that already has an owner.
   */
  setupPending?: true;
}

export interface DeviceView {
  id: string;
  label: string;
  createdAt: string;
  lastSeen: string;
  /** Phase 52: 'app' = signed in with a device code and a token (terminal, VS Code). Phase 57: 'api' = an API key for another app. M4: 'home-assistant'. Phase 87: 'hands'. */
  kind: 'browser' | 'app' | 'api' | 'home-assistant' | 'hands' | 'a2a';
  /** Phase 100: when an agent's key stops working. */
  expiresAt?: string;
}

/** Hardening L4: browser and app sign-ins kept at most (API keys are capped on their own, at 20). */
export const MAX_SESSIONS = 50;
/** Keeps every API key and the newest MAX_SESSIONS other sign-ins (a pile of old sign-ins never drops a key). */
function capSessions(list: DeviceSession[]): DeviceSession[] {
  const others = list.filter((d) => d.kind !== 'api' && d.kind !== 'a2a');
  const drop = new Set(others.slice(0, Math.max(0, others.length - MAX_SESSIONS)));
  return list.filter((d) => !drop.has(d));
}

/** Phase 52: device tokens look like `sara_dev.<device id>.<secret>`. */
export const DEVICE_TOKEN_PREFIX = 'sara_dev.';
/** Phase 87: Sara's hands on a computer: `sara_hands.<device id>.<secret>` (only /api/hands takes it). */
export const HANDS_TOKEN_PREFIX = 'sara_hands.';

/** "Chrome on Windows", "Safari on iPhone"… from a User-Agent header. */
export function deviceLabel(ua = ''): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /\bSaraPhone\/\d/.test(ua) ? 'Sara app' : /\bSaraDesktop\/\d/.test(ua) ? 'Sara app' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python/i.test(ua) ? 'Script' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class OwnerAuth {
  readonly #path: string;
  #owner: OwnerFile;
  readonly #now: () => Date;
  /** Set only when a new token was generated during this process start. */
  readonly newToken: string | undefined;
  #fresh = false;
  /** Phase 71: a member's tokens start with `sara_m.<member id>.` (the owner's have no prefix). */
  readonly #prefix: string;

  /**
   * `resetIfDamaged`: only for the server-side token reset (`--reset-token`), which replaces the
   * sign-in anyway: a damaged owner file with no good copy then gets a new one instead of refusing.
   */
  constructor(dataDir: string, now: () => Date = () => new Date(), opts: { tokenPrefix?: string; resetIfDamaged?: boolean } = {}) {
    this.#path = join(dataDir, FILE);
    this.#now = now;
    this.#prefix = opts.tokenPrefix ?? '';
    const loaded = existsSync(this.#path) ? OwnerAuth.#load(this.#path, opts.resetIfDamaged === true) : undefined;
    if (loaded === null) {
      // Damaged with no good copy, during a token reset: a new owner file that is NOT a new server
      // (no browser setup opens); the reset that follows prints the new token.
      const { owner, token } = OwnerAuth.#generate(this.#prefix);
      this.#owner = owner;
      this.newToken = token;
      this.#save();
    } else if (loaded) {
      this.#owner = loaded;
      if (!this.#owner.sessions) {
        this.#owner.sessions = [];
        this.#owner.legacy = true;
        this.#save();
      }
    } else {
      const { owner, token } = OwnerAuth.#generate(this.#prefix);
      this.#owner = owner;
      this.newToken = token;
      this.#fresh = true;
      this.#save();
    }
  }

  /**
   * Reads owner.json. A damaged file (cut short by a crash or power loss, or edited by hand) must
   * never reset the sign-in silently: that would either lock the owner out or open the server to
   * whoever claims it first. So it falls back to owner.json.bak (the last copy saved whole) and
   * puts that back; with no good copy it refuses to start and names the file.
   */
  static #load(path: string, resetIfDamaged: boolean): OwnerFile | null {
    const read = (file: string): OwnerFile => {
      const o = JSON.parse(readFileSync(file, 'utf8')) as OwnerFile;
      if (!o || typeof o !== 'object' || typeof o.tokenHash !== 'string' || typeof o.sessionSecret !== 'string') throw new Error('the token or session secret is missing');
      return o;
    };
    try {
      return read(path);
    } catch (err) {
      const bak = join(dirname(path), BACKUP);
      let good: OwnerFile | undefined;
      try { if (existsSync(bak)) good = read(bak); } catch { /* the backup is damaged too */ }
      if (!good) {
        if (resetIfDamaged) return null;
        throw new StartupError(`The owner sign-in file ${path} is damaged (${(err as Error).message}) and there is no good copy in ${bak}. Restore a backup, or make a new owner token with: ${adminHint('reset-token')} (this also turns off passkeys and two-step sign-in).`);
      }
      console.warn(`[sara] ${path} was damaged (${(err as Error).message}); restored it from ${bak}.`);
      writeFileAtomic(path, JSON.stringify(good, null, 2) + '\n', 0o600);
      return good;
    }
  }

  /** Phase 59: a new server nobody has signed in to yet (browser setup may be open, src/claim.ts). */
  get setupPending(): boolean {
    return this.#owner.setupPending === true;
  }

  /** Phase 59: the owner signed in for the first time: browser setup closes for good. */
  markSignedIn(): void {
    if (!this.#owner.setupPending) return;
    delete this.#owner.setupPending;
    this.#save();
  }

  static #generate(prefix = ''): { owner: OwnerFile; token: string } {
    const token = `${prefix}${randomBytes(24).toString('base64url')}`;
    return { token, owner: { tokenHash: sha256(token), sessionSecret: randomBytes(32).toString('base64url'), sessions: [] } };
  }

  #save(): void {
    if (this.#fresh) {
      // Phase 59: only the very first owner file of a server waits for its owner (see setupPending).
      this.#owner.setupPending = true;
      this.#fresh = false;
    }
    const text = JSON.stringify(this.#owner, null, 2) + '\n';
    writeFileAtomic(this.#path, text, 0o600);
    // The last good copy, read only if owner.json is ever found damaged (#load).
    writeFileAtomic(join(dirname(this.#path), BACKUP), text, 0o600);
  }

  /**
   * Replaces the owner token (and invalidates all sessions). Returns the new token. Passkeys and
   * two-step sign-in stay, unless `clearSecurity` (the server-side recovery: `sara reset-token`).
   */
  resetToken(opts: { clearSecurity?: boolean } = {}): string {
    const { owner, token } = OwnerAuth.#generate(this.#prefix);
    if (!opts.clearSecurity) {
      if (this.#owner.passkeys) owner.passkeys = this.#owner.passkeys;
      if (this.#owner.totp) owner.totp = this.#owner.totp;
    }
    this.#owner = owner;
    this.#save();
    return token;
  }

  // ---------- Phase 24: passkeys ----------

  passkeys(): Omit<StoredPasskey, 'jwk'>[] {
    return (this.#owner.passkeys ?? []).map(({ jwk: _k, ...p }) => ({ ...p }));
  }

  passkey(id: string): StoredPasskey | undefined {
    return this.#owner.passkeys?.find((p) => p.id === id);
  }

  addPasskey(p: Omit<StoredPasskey, 'createdAt' | 'lastUsedAt'>): void {
    const list = (this.#owner.passkeys ??= []);
    if (list.some((x) => x.id === p.id)) throw new Error('That passkey is already added.');
    if (list.length >= 20) throw new Error('Up to 20 passkeys: remove one first.');
    list.push({ ...p, label: p.label.slice(0, 60) || 'Passkey', createdAt: this.#now().toISOString(), lastUsedAt: null });
    this.#save();
  }

  usedPasskey(id: string, signCount: number): void {
    const p = this.passkey(id);
    if (!p) return;
    p.signCount = signCount;
    p.lastUsedAt = this.#now().toISOString();
    this.#save();
  }

  removePasskey(id: string): boolean {
    const before = this.#owner.passkeys?.length ?? 0;
    this.#owner.passkeys = (this.#owner.passkeys ?? []).filter((p) => p.id !== id);
    this.#save();
    return this.#owner.passkeys.length < before;
  }

  // ---------- Phase 24: two-step sign-in ----------

  get twoStepOn(): boolean {
    return Boolean(this.#owner.totp?.enabledAt);
  }

  /** Starts setting up two-step sign-in: a new secret to add to an authenticator app. */
  startTwoStep(account: string): { secret: string; url: string } {
    if (this.twoStepOn) throw new Error('Two-step sign-in is already on.');
    const secret = newTotpSecret();
    this.#owner.totp = { secret, enabledAt: null, lastCounter: -1 };
    this.#save();
    return { secret, url: otpauthUrl(secret, account) };
  }

  /** Checks a code; when setting up, the first right code turns it on. */
  checkTwoStep(code: string): boolean {
    const t = this.#owner.totp;
    if (!t) return false;
    const k = verifyTotp(t.secret, code, this.#now().getTime(), t.lastCounter);
    if (k === undefined) return false;
    t.lastCounter = k; // each code works once
    t.enabledAt ??= this.#now().toISOString();
    this.#save();
    return true;
  }

  /** Turns two-step sign-in off (needs a current code when it's on). */
  stopTwoStep(code: string): void {
    if (this.twoStepOn && !this.checkTwoStep(code)) throw new Error('That code is wrong. Use the current code from your authenticator app.');
    delete this.#owner.totp;
    this.#save();
  }

  /** New owner token from the app: the current one must be given; all devices are signed out. */
  rotateToken(current: string, opts: { clearPasskeys?: boolean } = {}): string {
    if (!this.verifyToken(current)) throw new Error('That is not the current owner token.');
    const passkeys = this.#owner.passkeys;
    const token = this.resetToken();
    // A new token is for "someone may have had access": passkeys go too unless asked to keep them.
    if (opts.clearPasskeys !== false) delete this.#owner.passkeys;
    else if (passkeys) this.#owner.passkeys = passkeys;
    this.#save();
    return token;
  }

  verifyToken(token: string): boolean {
    return typeof token === 'string' && token.length > 0 && safeEqual(sha256(token), this.#owner.tokenHash);
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#owner.sessionSecret).update(payload).digest('base64url');
  }

  createSession(label = 'Browser'): { value: string; maxAgeSeconds: number; id: string } {
    const now = this.#now();
    const expires = now.getTime() + SESSION_TTL_MS;
    const id = randomBytes(9).toString('base64url');
    const payload = `${expires}.${id}`;
    const sessions = (this.#owner.sessions ?? []).filter((d) => d.kind === 'api' || d.kind === 'a2a' || Date.parse(d.lastSeen) > now.getTime() - SESSION_TTL_MS);
    sessions.push({ id, label: label.slice(0, 60), createdAt: now.toISOString(), lastSeen: now.toISOString() });
    this.#owner.sessions = capSessions(sessions);
    this.#save();
    return { value: `${payload}.${this.#sign(payload)}`, maxAgeSeconds: SESSION_TTL_MS / 1000, id };
  }

  /** The device id of a valid session cookie, or undefined. */
  sessionId(value: string | undefined, label = 'Earlier sign-in'): string | undefined {
    if (!value) return undefined;
    const i = value.lastIndexOf('.');
    if (i < 0) return undefined;
    const payload = value.slice(0, i);
    if (!safeEqual(this.#sign(payload), value.slice(i + 1))) return undefined;
    const [exp, id] = payload.split('.');
    const expires = Number(exp);
    const now = this.#now();
    if (!Number.isFinite(expires) || expires <= now.getTime() || !id) return undefined;
    const sessions = (this.#owner.sessions ??= []);
    let d = sessions.find((x) => x.id === id);
    if (!d) {
      if (!this.#owner.legacy) return undefined; // signed out
      d = { id, label, createdAt: now.toISOString(), lastSeen: now.toISOString() };
      sessions.push(d);
      this.#save();
    } else if (now.getTime() - Date.parse(d.lastSeen) > 60 * 60 * 1000) {
      d.lastSeen = now.toISOString();
      this.#save();
    }
    return id;
  }

  verifySession(value: string | undefined): boolean {
    return this.sessionId(value) !== undefined;
  }

  devices(): DeviceView[] {
    return [...(this.#owner.sessions ?? [])].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map(({ tokenHash, kind, ...d }) => ({ ...d, kind: kind === 'api' || kind === 'home-assistant' || kind === 'hands' || kind === 'a2a' ? kind : tokenHash ? 'app' : 'browser' }));
  }

  /**
   * Phase 52: a token for an app the owner approved with a device code. It is listed with the
   * other devices (and stops working when signed out there). Only its hash is kept.
   */
  createDeviceToken(label: string, kind?: 'api' | 'home-assistant'): { token: string; id: string } {
    const now = this.#now();
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const sessions = (this.#owner.sessions ?? []).filter((d) => d.kind === 'api' || d.kind === 'a2a' || Date.parse(d.lastSeen) > now.getTime() - SESSION_TTL_MS);
    if (kind === 'api' && sessions.filter((d) => d.kind === 'api').length >= 20) throw new Error('Up to 20 API keys: remove one you no longer use first (Devices and sign-in).');
    sessions.push({ id, label: label.slice(0, 60) || (kind === 'api' ? 'Another app' : 'App'), createdAt: now.toISOString(), lastSeen: now.toISOString(), tokenHash: sha256(secret), ...(kind ? { kind } : {}) });
    this.#owner.sessions = capSessions(sessions);
    this.#save();
    return { token: `${DEVICE_TOKEN_PREFIX}${id}.${secret}`, id };
  }

  /**
   * Phase 100 (STAPLES §8.2): a key for another agent (A2A). It only works on /a2a, never on /api,
   * /v1 or /mcp; shown once, only its hash kept, revocable, and it ends after `days` (default 180).
   */
  createAgentKey(label: string, days = 180): { token: string; id: string; expiresAt: string } {
    const now = this.#now();
    const sessions = this.#owner.sessions ?? [];
    if (sessions.filter((d) => d.kind === 'a2a').length >= 20) throw new Error('Up to 20 agent keys: remove one first.');
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + Math.max(1, Math.min(365, Math.round(days))) * 24 * 3600_000).toISOString();
    sessions.push({ id, label: label.slice(0, 60) || 'Another agent', createdAt: now.toISOString(), lastSeen: now.toISOString(), tokenHash: sha256(secret), kind: 'a2a', expiresAt });
    this.#owner.sessions = capSessions(sessions);
    this.#save();
    return { token: `${DEVICE_TOKEN_PREFIX}${id}.${secret}`, id, expiresAt };
  }

  /** Phase 100: the device id of a valid agent key (any other token, a cookie or an expired key: undefined). */
  agentKeyId(token: string | undefined): string | undefined {
    const id = this.deviceTokenId(token);
    return id && this.deviceKind(id) === 'a2a' ? id : undefined;
  }

  /** Phase 100: when an agent's key ends. */
  expiresOf(id: string): string | undefined {
    return this.#owner.sessions?.find((x) => x.id === id)?.expiresAt;
  }

  /** Phase 57: an API key for another app (an OpenAI-compatible app or an MCP app). Shown once. */
  createApiKey(label: string): { token: string; id: string } {
    return this.createDeviceToken(label, 'api');
  }

  /** Phase 57: 'api' for an API key, 'app' for a device-code app, 'home-assistant' (M4), 'hands' (Phase 87), undefined for anything else. */
  deviceKind(id: string): 'api' | 'app' | 'home-assistant' | 'hands' | 'a2a' | undefined {
    const d = this.#owner.sessions?.find((x) => x.id === id);
    return !d?.tokenHash ? undefined : d.kind === 'api' || d.kind === 'home-assistant' || d.kind === 'hands' || d.kind === 'a2a' ? d.kind : 'app';
  }

  /**
   * Phase 87: Sara's hands on a computer (docs/design/COMPUTER_USE.md §3.2): made only through the
   * signed-in page after a fresh confirmation, shown once, hash-only here, listed under Devices as
   * "Sara's hands on <computer>", 90 days at most (the app renews it before then).
   */
  createHandsToken(label: string): { token: string; id: string; expiresAt: string } {
    const now = this.#now();
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const sessions = (this.#owner.sessions ?? []).filter((d) => d.kind === 'api' || d.kind === 'a2a' || Date.parse(d.lastSeen) > now.getTime() - SESSION_TTL_MS);
    // One computer, one set of hands: a new pairing with the same name replaces the old one.
    const same = sessions.filter((d) => d.kind === 'hands' && d.label === label.slice(0, 60)).map((d) => d.id);
    const kept = sessions.filter((d) => !same.includes(d.id));
    if (kept.filter((d) => d.kind === 'hands').length >= 10) throw new Error('Up to 10 computers can let Sara use them: remove one under Devices first.');
    kept.push({ id, label: label.slice(0, 60) || "Sara's hands", createdAt: now.toISOString(), lastSeen: now.toISOString(), tokenHash: sha256(secret), kind: 'hands' });
    this.#owner.sessions = capSessions(kept);
    this.#save();
    return { token: `${HANDS_TOKEN_PREFIX}${id}.${secret}`, id, expiresAt: new Date(now.getTime() + DEVICE_TOKEN_MAX_MS).toISOString() };
  }

  /** Phase 87: the device id of a valid hands token (other tokens and cookies never match). */
  handsTokenId(token: string | undefined): string | undefined {
    if (!token?.startsWith(HANDS_TOKEN_PREFIX)) return undefined;
    const [id, secret, extra] = token.slice(HANDS_TOKEN_PREFIX.length).split('.');
    if (!id || !secret || extra !== undefined) return undefined;
    const d = this.#owner.sessions?.find((x) => x.id === id);
    if (!d?.tokenHash || d.kind !== 'hands' || !safeEqual(sha256(secret), d.tokenHash)) return undefined;
    const now = this.#now().getTime();
    if (Date.parse(d.lastSeen) < now - SESSION_TTL_MS) return undefined;
    if (!(Date.parse(d.createdAt) > now - DEVICE_TOKEN_MAX_MS)) return undefined;
    if (now - Date.parse(d.lastSeen) > 60 * 60 * 1000) {
      d.lastSeen = new Date(now).toISOString();
      this.#save();
    }
    return id;
  }

  /** Phase 87: a fresh secret (and a fresh 90 days) for hands that still hold a valid token. */
  renewHandsToken(token: string): { token: string; id: string; expiresAt: string } | undefined {
    const id = this.handsTokenId(token);
    const d = id ? this.#owner.sessions?.find((x) => x.id === id) : undefined;
    if (!id || !d) return undefined;
    const now = this.#now();
    const secret = randomBytes(32).toString('base64url');
    d.tokenHash = sha256(secret);
    d.createdAt = now.toISOString();
    d.lastSeen = now.toISOString();
    this.#save();
    return { token: `${HANDS_TOKEN_PREFIX}${id}.${secret}`, id, expiresAt: new Date(now.getTime() + DEVICE_TOKEN_MAX_MS).toISOString() };
  }

  /** Phase 88: a fresh secret for a hands device that is connected with a valid token right now (the app renews over its own connection). */
  renewHandsId(id: string): { token: string; id: string; expiresAt: string } | undefined {
    const d = this.#owner.sessions?.find((x) => x.id === id && x.kind === 'hands');
    if (!d?.tokenHash) return undefined;
    const now = this.#now();
    const secret = randomBytes(32).toString('base64url');
    d.tokenHash = sha256(secret);
    d.createdAt = now.toISOString();
    d.lastSeen = now.toISOString();
    this.#save();
    return { token: `${HANDS_TOKEN_PREFIX}${id}.${secret}`, id, expiresAt: new Date(now.getTime() + DEVICE_TOKEN_MAX_MS).toISOString() };
  }

  /** Phase 71: whether a device or app sign-in with this id is listed here (routing only; tokens are still checked). */
  hasDevice(id: string): boolean {
    return Boolean(this.#owner.sessions?.some((x) => x.id === id));
  }

  /** Phase 57: the label of a signed-in device or API key. */
  deviceLabelOf(id: string): string | undefined {
    return this.#owner.sessions?.find((x) => x.id === id)?.label;
  }

  /**
   * The device id of a valid device token, or undefined. Unused for 30 days = signed out; and in any
   * case 90 days after it was approved (the app then asks to be approved again).
   */
  deviceTokenId(token: string | undefined): string | undefined {
    if (!token?.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
    const [id, secret] = token.slice(DEVICE_TOKEN_PREFIX.length).split('.');
    if (!id || !secret) return undefined;
    const d = this.#owner.sessions?.find((x) => x.id === id);
    if (!d?.tokenHash || !safeEqual(sha256(secret), d.tokenHash)) return undefined;
    // Phase 87: a hands token written with the other prefix is still only a hands token.
    if (d.kind === 'hands') return undefined;
    const now = this.#now().getTime();
    // Phase 100: an agent's key works until its expiry (or until the owner removes it).
    if (d.kind === 'a2a' && !(Date.parse(d.expiresAt ?? '') > now)) return undefined;
    // Phase 57: an API key works until the owner removes it (it can only reach /v1 and /mcp).
    if (d.kind !== 'api' && d.kind !== 'a2a') {
      if (Date.parse(d.lastSeen) < now - SESSION_TTL_MS) return undefined;
      if (!(Date.parse(d.createdAt) > now - DEVICE_TOKEN_MAX_MS)) return undefined;
    }
    if (now - Date.parse(d.lastSeen) > 60 * 60 * 1000) {
      d.lastSeen = new Date(now).toISOString();
      this.#save();
    }
    return id;
  }

  /** Signs out one device (or every device except `keepId`). */
  signOut(id: string | 'others', keepId?: string): number {
    const before = this.#owner.sessions?.length ?? 0;
    this.#owner.sessions = (this.#owner.sessions ?? []).filter((d) => (id === 'others' ? d.id === keepId : d.id !== id));
    this.#owner.legacy = false; // after an explicit sign-out, unknown cookies no longer get in
    this.#save();
    return before - this.#owner.sessions.length;
  }
}

/** Simple in-memory brute-force limiter for the login endpoint. */
export class LoginLimiter {
  readonly #failures = new Map<string, { at: number; w: number }[]>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  #sweptAt = 0;

  /** IPv6 addresses count per /64 (one home or one server usually has a whole /64). */
  static key(ip: string): string {
    if (!ip.includes(':') || /^::ffff:\d/.test(ip)) return ip.replace(/^::ffff:/, '');
    const [head, tail = ''] = ip.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
    return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
  }

  #recent(ip: string, now: number): { at: number; w: number }[] {
    if (now - this.#sweptAt > this.#windowMs) {
      this.#sweptAt = now;
      for (const [k, v] of this.#failures) if (!v.some((f) => now - f.at < this.#windowMs)) this.#failures.delete(k);
    }
    return (this.#failures.get(LoginLimiter.key(ip)) ?? []).filter((f) => now - f.at < this.#windowMs);
  }

  blocked(ip: string, now = Date.now()): boolean {
    return this.#recent(ip, now).reduce((n, f) => n + f.w, 0) >= this.#max;
  }

  /** Counts a failure (weight 1; cheap requests like asking for a passkey challenge count less). */
  fail(ip: string, now = Date.now(), weight = 1): void {
    const list = this.#recent(ip, now);
    list.push({ at: now, w: weight });
    this.#failures.set(LoginLimiter.key(ip), list.slice(-200));
  }

  reset(ip: string): void {
    this.#failures.delete(LoginLimiter.key(ip));
  }
}

// Phase 52: signing in the terminal client and the VS Code extension with a device code.
// The app asks for a short code (no owner token typed anywhere), shows it with a link, and polls.
// The owner approves it in Settings → Devices and sign-in (or on the /device page, typing the
// code the app shows; the page names the app, its address and how long ago it asked), confirming
// with the owner token, the two-step code or a passkey; the next poll hands the app its own device
// token, once. Codes last
// 10 minutes and live only in memory.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_CODE_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LEN = 8;
const MAX_PENDING = 20;

export type DeviceRequestStatus = 'pending' | 'approved' | 'denied';

interface Entry {
  code: string;
  name: string;
  pollHash: Buffer;
  createdAt: number;
  expires: number;
  status: DeviceRequestStatus;
  /** Set on approval; handed out once by poll. */
  token?: string;
  deviceId?: string;
  tokenExpiresAt?: string;
  from: string;
  /** The address the request came from (shown to the owner before approving). */
  ip: string;
  /** Hardening M4: the app asked for a limited token ('home-assistant'); 'full' otherwise. */
  scope: DeviceScope;
}

/**
 * Hardening M4: what an approved app may reach. 'full' = everything a device-code app may (the
 * terminal, VS Code). 'home-assistant' = only talking with her in the conversations it made itself.
 * 'hands' is a separate device capability, never an app/API credential: the signed-in browser
 * shows its computer-control warning and requires fresh identity proof before issuing it.
 */
export type DeviceScope = 'full' | 'home-assistant' | 'hands';
export const cleanScope = (v: unknown): DeviceScope => (v === 'hands' ? 'hands' : v === 'home-assistant' ? 'home-assistant' : 'full');

export interface PendingView {
  code: string;
  name: string;
  from: string;
  /** Where the request came from (network address) and how long ago, in seconds. */
  ip: string;
  ageSeconds: number;
  createdAt: string;
  expiresAt: string;
  /** M4: 'home-assistant' = it asked for the limited Home Assistant access. */
  scope: DeviceScope;
}

const hash = (s: string) => createHash('sha256').update(s).digest();
export const normalizeDeviceCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode(): string {
  let s = '';
  while (s.length < CODE_LEN) for (const b of randomBytes(CODE_LEN)) if (b < 248 && s.length < CODE_LEN) s += ALPHABET[b % 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "sara-chat on Windows (alex-pc)": the name an app gives itself, cleaned for showing. */
export function cleanDeviceName(v: unknown): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'An app';
}

export class DeviceFlow {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  #sweep(): void {
    const t = this.#now();
    for (const [k, e] of this.#entries) if (e.expires < t) this.#entries.delete(k);
  }

  /** A new request: the code to show and a secret the app polls with. */
  start(name: unknown, from = '', ip = '', scope: DeviceScope = 'full'): { code: string; pollToken: string; expiresAt: string; interval: number; scope: DeviceScope } {
    this.#sweep();
    if ([...this.#entries.values()].filter((e) => e.status === 'pending').length >= MAX_PENDING) throw new Error('Too many sign-in requests are waiting. Try again in a few minutes.');
    let code = newCode();
    while (this.#entries.has(normalizeDeviceCode(code))) code = newCode();
    const pollToken = randomBytes(24).toString('base64url');
    const t = this.#now();
    this.#entries.set(normalizeDeviceCode(code), { code, name: cleanDeviceName(name), pollHash: hash(pollToken), createdAt: t, expires: t + DEVICE_CODE_MS, status: 'pending', from: String(from).slice(0, 60), ip: String(ip).replace(/^::ffff:/, '').slice(0, 60), scope });
    return { code, pollToken, expiresAt: new Date(t + DEVICE_CODE_MS).toISOString(), interval: 2, scope };
  }

  /**
   * The app checks on its request. 'approved' carries the token (only once: the request is then
   * gone); 'expired' when there's no such request (any more).
   */
  poll(pollToken: string): { status: DeviceRequestStatus | 'expired'; token?: string; deviceId?: string; expiresAt?: string } {
    this.#sweep();
    const h = hash(String(pollToken ?? ''));
    for (const [k, e] of this.#entries) {
      if (!timingSafeEqual(h, e.pollHash)) continue;
      if (e.status === 'approved') {
        this.#entries.delete(k);
        return { status: 'approved', token: e.token!, deviceId: e.deviceId!, ...(e.tokenExpiresAt ? { expiresAt: e.tokenExpiresAt } : {}) };
      }
      if (e.status === 'denied') {
        this.#entries.delete(k);
        return { status: 'denied' };
      }
      return { status: 'pending' };
    }
    return { status: 'expired' };
  }

  pending(): PendingView[] {
    this.#sweep();
    return [...this.#entries.values()].filter((e) => e.status === 'pending').map((e) => this.#view(e));
  }

  #view(e: Entry): PendingView {
    return { code: e.code, name: e.name, from: e.from, ip: e.ip, ageSeconds: Math.max(0, Math.round((this.#now() - e.createdAt) / 1000)), createdAt: new Date(e.createdAt).toISOString(), expiresAt: new Date(e.expires).toISOString(), scope: e.scope };
  }

  find(code: string): PendingView | undefined {
    return this.pending().find((p) => normalizeDeviceCode(p.code) === normalizeDeviceCode(code));
  }

  /** The owner said yes: `issue` makes the device token (listed under Devices). */
  approve(code: string, issue: (name: string, scope: DeviceScope) => { token: string; id: string; expiresAt?: string }): PendingView | undefined {
    this.#sweep();
    const e = this.#entries.get(normalizeDeviceCode(code));
    if (!e || e.status !== 'pending') return undefined;
    const { token, id, expiresAt } = issue(e.name, e.scope);
    e.status = 'approved';
    e.token = token;
    e.deviceId = id;
    e.tokenExpiresAt = expiresAt;
    return this.#view(e);
  }

  deny(code: string): boolean {
    const e = this.#entries.get(normalizeDeviceCode(code));
    if (!e || e.status !== 'pending') return false;
    e.status = 'denied';
    return true;
  }
}

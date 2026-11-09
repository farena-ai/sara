// C15 (docs/ops/C15_DESIGN.md): approve a new device from chat. A sign-in (owner token or passkey)
// from a remote address waits until the owner approves it from a device he already uses, or from
// his verified Telegram/Discord account ("approve K7Q2M" / "deny K7Q2M"). The 5-character code is
// shown only on the asking device, so whoever answers must see that device; the asking device can
// never answer its own request, and 10 minutes without an answer is a no. The same request guards
// sensitive actions from a remote device (Allow-All policies, the password, add-ons from a URL,
// channel tokens, restart). Remote = anything not plainly on this computer: any proxy or tunnel
// header (Forwarded, X-Forwarded-*, X-Real-IP, CF-Connecting-IP, Tailscale-User-*), a non-loopback
// socket, or a Host other than localhost, even when the connection comes from 127.0.0.1.
// Pairing codes and device codes are made on a trusted device already, API keys are not devices.
import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { en } from './i18n.ts';

/** No 0/O, 1/I/L or 5/S, 2/Z, 8/B: nothing that reads two ways. */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const CODE_LEN = 5;
export const APPROVAL_TTL_MS = 10 * 60_000;
/** An approved sensitive action may be done once, within this time. */
export const GRANT_TTL_MS = 10 * 60_000;
/** A browser or app sign-in unused this long is signed out. */
export const UNUSED_SIGN_OUT_MS = 30 * 24 * 3600_000;
export const MAX_DEVICE_CHOICES = [0, 3, 5, 10, 20] as const;

export type SensitiveAction = 'allow-all' | 'password' | 'addon-url' | 'channel-token' | 'restart' | 'approval-off' | 'hands';
export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = ['allow-all', 'password', 'addon-url', 'channel-token', 'restart', 'approval-off', 'hands'];
/** What the owner reads in the prompt (English; the app and bridges translate). */
export const ACTION_WORDS: Record<SensitiveAction, string> = {
  'allow-all': en('turn on Always allow'),
  password: en('change the owner password (token)'),
  'addon-url': en('install an add-on from a web address'),
  'channel-token': en('change a chat channel token'),
  restart: en('restart or update Sara'),
  'approval-off': en('turn off new-device approval'),
  hands: en('let Sara use a computer (computer use)'),
};

export interface DeviceApprovalSettings {
  /** The switch (default on for new installs; existing installs get a notice and keep it off). */
  on: boolean;
  /** Host names this server answers to besides localhost and IP addresses (DNS rebinding). */
  allowedHosts: string[];
  /** Browser and app sign-ins kept at most (0 = no limit beyond the built-in 50). */
  maxDevices: number;
  /** An existing install that hasn't seen the one-time notice about the switch yet. */
  notice: boolean;
}

export function deviceApprovalSettings(s: { deviceApproval?: Partial<DeviceApprovalSettings> }): DeviceApprovalSettings {
  const d = s.deviceApproval ?? {};
  const max = Number(d.maxDevices);
  return {
    on: d.on === true,
    allowedHosts: Array.isArray(d.allowedHosts) ? cleanHosts(d.allowedHosts) : [],
    maxDevices: MAX_DEVICE_CHOICES.includes(max as 0) ? max : 0,
    notice: d.notice === true,
  };
}

/** Lower-case host names (no port, no scheme); `.example.com` allows its subdomains. At most 20. */
export function cleanHosts(v: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)) {
    const h = String(raw).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) && h.length <= 253 && !out.includes(h)) out.push(h);
  }
  return out.slice(0, 20);
}

/** A first start (no owner file before) gets the switch on; an existing install a one-time notice. */
export function initialDeviceApproval(existingInstall: boolean): Partial<DeviceApprovalSettings> {
  return existingInstall ? { on: false, notice: true } : { on: true };
}

export function newCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
/** What the owner typed, as a code: case and spaces don't matter. */
export function normCode(s: string): string {
  return String(s ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-app-capabilities', 'x-sara-proxy'];

export function isLoopbackIp(ip: string | undefined): boolean {
  const a = String(ip ?? '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
/** The Host header's name without the port (IPv6 brackets kept off). */
export function hostName(req: IncomingMessage): string {
  const h = String(req.headers.host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}
const isLocalName = (h: string) => h === '' || h === 'localhost' || h.endsWith('.localhost') || isLoopbackIp(h);
const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

export function viaProxy(req: IncomingMessage): boolean {
  return FORWARD_HEADERS.some((k) => req.headers[k] !== undefined);
}

/** Is this request from somewhere other than this computer (or through a tunnel or proxy)? */
export function isRemoteRequest(req: IncomingMessage): boolean {
  if (!isLoopbackIp(req.socket.remoteAddress)) return true;
  if (viaProxy(req)) return true;
  return !isLocalName(hostName(req));
}

/**
 * DNS rebinding guard: a page on another site that points its name at 127.0.0.1 reaches this
 * server with its own name in Host and no proxy in between. Localhost and IP addresses always
 * pass; with allowed hosts set, only those names pass; without, a name passes only through a
 * proxy or from another computer (and then counts as remote anyway).
 */
export function hostAllowed(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const h = hostName(req);
  if (isLocalName(h) || isIpLiteral(h)) return true;
  if (allowedHosts.length) return allowedHosts.some((a) => (a.startsWith('.') ? h.endsWith(a) || h === a.slice(1) : h === a));
  return viaProxy(req) || !isLoopbackIp(req.socket.remoteAddress);
}

export interface ApprovalRequest {
  code: string;
  kind: 'sign-in' | 'action';
  action?: SensitiveAction;
  /** The asking device's session (it may never answer this request). */
  sessionId: string;
  label: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  /** Who answered: 'app:<session>', 'telegram', 'discord'. */
  by?: string;
  /** An approved action: used once. */
  used?: boolean;
}
export type AnswerResult = 'approved' | 'denied' | 'unknown' | 'self' | 'expired';

/** The open requests (in memory: a restart is a no, like the 10 minutes). */
export class DeviceApprovals {
  readonly #now: () => Date;
  readonly #list: ApprovalRequest[] = [];
  /** Told on every new request and every answer (the server pushes the prompt and the bridges DM). */
  readonly listeners = new Set<(r: ApprovalRequest, what: 'new' | 'answered' | 'expired') => void>();

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  #emit(r: ApprovalRequest, what: 'new' | 'answered' | 'expired'): void {
    for (const fn of this.listeners) {
      try {
        fn(r, what);
      } catch {
        /* a listener's problem */
      }
    }
  }

  /** Marks the overdue ones expired (10 minutes without an answer = no). */
  sweep(): void {
    const now = this.#now().getTime();
    for (const r of this.#list) {
      if (r.state === 'pending' && Date.parse(r.expiresAt) <= now) {
        r.state = 'expired';
        this.#emit(r, 'expired');
      }
    }
    // Answered and expired requests are kept an hour for the asking device's status, then dropped.
    for (let i = this.#list.length - 1; i >= 0; i--) if (Date.parse(this.#list[i].expiresAt) < now - 3600_000) this.#list.splice(i, 1);
  }

  /** A request for this device (the same open one again when it asks twice). */
  request(kind: ApprovalRequest['kind'], o: { sessionId: string; label: string; ip: string; action?: SensitiveAction }): ApprovalRequest {
    this.sweep();
    const open = this.#list.find((r) => r.state === 'pending' && r.sessionId === o.sessionId && r.kind === kind && r.action === o.action);
    if (open) return open;
    let code = newCode();
    while (this.#list.some((r) => r.code === code)) code = newCode();
    const now = this.#now();
    const r: ApprovalRequest = { code, kind, ...(o.action ? { action: o.action } : {}), sessionId: o.sessionId, label: o.label.slice(0, 80), ip: o.ip.slice(0, 64), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(), state: 'pending' };
    // At most 20 open at once (a flood of sign-in attempts can't bury the owner's prompt list).
    const pending = this.#list.filter((x) => x.state === 'pending');
    if (pending.length >= 20) pending[0].state = 'expired';
    this.#list.push(r);
    this.#emit(r, 'new');
    return r;
  }

  get(code: string): ApprovalRequest | undefined {
    this.sweep();
    return this.#list.find((r) => r.code === normCode(code));
  }
  pending(): ApprovalRequest[] {
    this.sweep();
    return this.#list.filter((r) => r.state === 'pending');
  }
  forSession(sessionId: string, kind: ApprovalRequest['kind'], action?: SensitiveAction): ApprovalRequest | undefined {
    this.sweep();
    return this.#list.filter((r) => r.sessionId === sessionId && r.kind === kind && r.action === action).at(-1);
  }

  /** The owner's answer. `from` is the answering device's session, or a chat ('telegram', 'discord'). */
  answer(code: string, yes: boolean, from: { sessionId?: string; channel: 'app' | 'telegram' | 'discord' }): AnswerResult {
    this.sweep();
    const r = this.#list.find((x) => x.code === normCode(code));
    if (!r) return 'unknown';
    if (r.state === 'expired') return 'expired';
    if (r.state !== 'pending') return 'unknown';
    if (from.sessionId && from.sessionId === r.sessionId) return 'self';
    r.state = yes ? 'approved' : 'denied';
    r.by = from.channel === 'app' ? `app:${from.sessionId ?? ''}` : from.channel;
    this.#emit(r, 'answered');
    return r.state;
  }

  /** "deny" with no code: every open sign-in request is refused (he didn't try to sign in). */
  denyAll(from: { channel: 'app' | 'telegram' | 'discord'; sessionId?: string }): number {
    let n = 0;
    for (const r of this.pending()) {
      if (from.sessionId && r.sessionId === from.sessionId) continue;
      r.state = 'denied';
      r.by = from.channel;
      this.#emit(r, 'answered');
      n++;
    }
    return n;
  }

  /** An approved sensitive action for this device, not used yet and still fresh: uses it. */
  takeGrant(sessionId: string, action: SensitiveAction): boolean {
    const r = this.#list.find((x) => x.kind === 'action' && x.sessionId === sessionId && x.action === action && x.state === 'approved' && !x.used && Date.parse(x.createdAt) + GRANT_TTL_MS > this.#now().getTime());
    if (!r) return false;
    r.used = true;
    return true;
  }
}

/** "approve K7Q2M" / "deny K7Q2M" / "deny" (case-insensitive) in a chat from the verified owner. */
export function parseApprovalReply(text: string): { yes: boolean; code?: string } | undefined {
  const m = /^\s*\/?(approve|allow|deny|refuse)\b\s*([a-z0-9]{5})?\s*[.!]?\s*$/i.exec(text);
  if (!m) return undefined;
  const yes = /^(approve|allow)$/i.test(m[1]);
  if (yes && !m[2]) return undefined;
  return { yes, ...(m[2] ? { code: normCode(m[2]) } : {}) };
}

export interface Said {
  text: string;
  params?: Record<string, string | number>;
}

/** The line a chat bridge sends the owner for a new request (the code is never in it). */
export function chatPrompt(r: ApprovalRequest): Said {
  const how = en('If it is you, reply "approve" and the 5-character code that device shows (e.g. approve K7Q2M). If not, reply "deny". No answer in 10 minutes = no.');
  if (r.kind === 'sign-in') return { text: en('A new device wants to sign in to Sara: {label}, from {ip}. {how}'), params: { label: r.label, ip: r.ip, how } };
  return { text: en('A device signed in from {ip} ({label}) asks to {what}. {how}'), params: { label: r.label, ip: r.ip, what: ACTION_WORDS[r.action!], how } };
}

/** What a chat bridge does with the owner's message: undefined when it isn't an approval reply. */
export function answerFromChat(approvals: DeviceApprovals | undefined, text: string, channel: 'telegram' | 'discord'): Said | undefined {
  const p = parseApprovalReply(text);
  if (!p || !approvals) return undefined;
  if (!p.code) {
    const n = approvals.denyAll({ channel });
    return n ? { text: en('Refused {n} request(s). That device is not signed in.'), params: { n } } : { text: en('Nothing is waiting for your answer.') };
  }
  const res = approvals.answer(p.code, p.yes, { channel });
  if (res === 'approved') return { text: en('Approved.') };
  if (res === 'denied') return { text: en('Refused. That device is not signed in.') };
  if (res === 'expired') return { text: en('That code has expired (10 minutes). Sign in again on that device for a new one.') };
  return { text: en('No request has that code. Check the code on the device that asks.') };
}

/** Fills {placeholders} (bridges translate `text` first). */
export function fill(s: Said, tr: (t: string) => string = (t) => t): string {
  const params = Object.fromEntries(Object.entries(s.params ?? {}).map(([k, v]) => [k, typeof v === 'string' ? tr(v) : String(v)]));
  return tr(s.text).replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);
}

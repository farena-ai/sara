// Phase 6: Web Push with no dependencies. VAPID (RFC 8292, ES256 JWT) + message encryption
// (RFC 8291 / RFC 8188 aes128gcm) using node:crypto. Payloads are end-to-end encrypted: the
// browser vendor's push service (Google, Mozilla, Apple) only relays ciphertext.
import { netFetch, privateLocalOn } from './net-guard.ts';
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApnsSender } from './apns.ts';
import type { HubEvent } from './events.ts';
import type { SettingsStore } from './settings.ts';
import { appLanguage, trOwner } from './i18n.ts';
import { type Identity, personalize, swapName } from './identity.ts';
import type { Vault } from './vault.ts';
import { ACT_TITLES, PhoneActions, type ActItem } from './phone-actions.ts';

export const PUSH_VAULT = 'push:vapid';

export interface PushSettings {
  /** Show the message text in the notification (off: "Sara sent you a message"). */
  preview: boolean;
}
export const DEFAULT_PUSH: PushSettings = { preview: true };

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** Page to open on click, e.g. "/#c=<conversation id>". */
  url: string;
  tag?: string;
  /** N5b: notification buttons (action id + title) and the one-time token they use. */
  actions?: { action: string; title: string; type?: 'text'; placeholder?: string }[];
  act?: string;
  /** N5b: the companion the token belongs to (sent as x-sara-companion with the action). */
  companion?: string;
  /** R4: the installed web app's badge number (approvals and inbox cards waiting; 0 clears it). */
  badge?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  origin TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);`;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

/** RFC 8291 + RFC 8188: encrypts one record for a browser subscription. */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, opts: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {}): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Bad p256dh key');
  if (authSecret.length !== 16) throw new Error('Bad auth secret');
  const ecdh = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = padding delimiter of the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

interface VapidKeys {
  privateJwk: { kty: string; crv: string; d: string; x: string; y: string };
  publicKey: string; // base64url, uncompressed point
}

export class PushService {
  readonly #db: DatabaseSync;
  readonly #vault: Vault;
  readonly #settings: SettingsStore;
  readonly #now: () => Date;
  readonly #allowInsecure: boolean;
  #keys: VapidKeys | undefined;
  /** iPhone app notifications (Phase 17); sendAll reaches them too. */
  apns: ApnsSender | undefined;
  /** N5b: one-time action tokens for notification buttons (this space's key and used list). */
  readonly actions: PhoneActions;

  constructor(db: DatabaseSync, vault: Vault, settings: SettingsStore, opts: { now?: () => Date; allowInsecure?: boolean } = {}) {
    this.#db = db;
    this.#vault = vault;
    this.#settings = settings;
    this.#now = opts.now ?? (() => new Date());
    this.#allowInsecure = opts.allowInsecure ?? false;
    db.exec(SCHEMA);
    this.actions = new PhoneActions(db, vault, { now: () => this.#now().getTime() });
    // Which signed-in device subscribed, so signing that device out stops its notifications.
    if (!(db.prepare("SELECT name FROM pragma_table_info('push_subscriptions')").all() as { name: string }[]).some((c) => c.name === 'session')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN session TEXT');
  }

  /** Drops subscriptions (and iPhones) whose sign-in is gone. */
  prune(validSessions: Set<string>): number {
    let n = 0;
    for (const r of this.#db.prepare('SELECT endpoint, session FROM push_subscriptions WHERE session IS NOT NULL').all() as { endpoint: string; session: string }[]) {
      if (!validSessions.has(r.session)) {
        this.unsubscribe(r.endpoint);
        n++;
      }
    }
    return n + (this.apns?.prune(validSessions) ?? 0);
  }

  get settings(): PushSettings {
    return { ...DEFAULT_PUSH, ...this.#settings.get().push };
  }

  /** VAPID keys, created on first use and kept in the encrypted vault. */
  #vapid(): VapidKeys {
    if (this.#keys) return this.#keys;
    const saved = this.#vault.get(PUSH_VAULT);
    if (saved) {
      this.#keys = JSON.parse(saved) as VapidKeys;
      return this.#keys;
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }) as VapidKeys['privateJwk'];
    const keys: VapidKeys = { privateJwk: jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
    this.#vault.set(PUSH_VAULT, JSON.stringify(keys));
    this.#keys = keys;
    return keys;
  }

  get publicKey(): string {
    return this.#vapid().publicKey;
  }

  /** `Authorization` header for one push service (audience = its origin). */
  vapidHeader(endpoint: string, subject: string): string {
    const k = this.#vapid();
    const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const exp = Math.floor(this.#now().getTime() / 1000) + 12 * 3600;
    const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp, sub: subject })));
    const key = createPrivateKey({ key: k.privateJwk, format: 'jwk' });
    const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${k.publicKey}`;
  }

  subscribe(sub: PushSubscriptionJson, origin: string, label = '', session?: string): void {
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      throw new Error('Bad push endpoint');
    }
    if (!(url.protocol === 'https:' || (this.#allowInsecure && url.protocol === 'http:'))) throw new Error('Push endpoints must use https');
    if (unb64u(sub.keys?.p256dh ?? '').length !== 65 || unb64u(sub.keys?.auth ?? '').length !== 16) throw new Error('Bad push subscription keys');
    this.#db
      .prepare('INSERT INTO push_subscriptions (endpoint, p256dh, auth, origin, label, created_at, session) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin, label = excluded.label, session = excluded.session, failures = 0')
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, origin, label.slice(0, 80), this.#now().toISOString(), session ?? null);
  }

  unsubscribe(endpoint: string): boolean {
    return Number(this.#db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
  }

  list(): { endpoint: string; label: string; createdAt: string; lastOkAt: string | null; failures: number }[] {
    return (this.#db.prepare('SELECT endpoint, label, created_at, last_ok_at, failures FROM push_subscriptions ORDER BY created_at').all() as Record<string, string | number | null>[]).map((r) => ({
      endpoint: String(r.endpoint),
      label: String(r.label),
      createdAt: String(r.created_at),
      lastOkAt: (r.last_ok_at as string | null) ?? null,
      failures: Number(r.failures),
    }));
  }

  /** Sends to every subscribed device. Dead subscriptions (404/410) are removed. */
  async sendAll(payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
    // Phase 67: browser and iPhone push services are off this computer: paused in private local
    // mode (nothing is counted as a failure, so no device is dropped).
    if (privateLocalOn()) return { sent: 0, failed: 0, removed: 0 };
    const [web, ios] = await Promise.all([this.#sendWeb(payload), this.apns ? this.apns.sendAll(payload).catch(() => ({ sent: 0, failed: 1, removed: 0 })) : { sent: 0, failed: 0, removed: 0 }]);
    return { sent: web.sent + ios.sent, failed: web.failed + ios.failed, removed: web.removed + ios.removed };
  }

  async #sendWeb(payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
    const rows = this.#db.prepare('SELECT endpoint, p256dh, auth, origin FROM push_subscriptions').all() as Record<string, string>[];
    const out = { sent: 0, failed: 0, removed: 0 };
    let badge = payload.badge;
    try {
      badge ??= this.badge?.();
    } catch {
      /* no count */
    }
    const body = Buffer.from(JSON.stringify(badge === undefined ? payload : { ...payload, badge }));
    await Promise.all(
      rows.map(async (r) => {
        try {
          const res = await netFetch(r.endpoint, {
            method: 'POST',
            headers: {
              ttl: '86400',
              urgency: 'normal',
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ...(payload.tag ? { topic: payload.tag.replace(/[^\w-]/g, '').slice(0, 32) } : {}),
              authorization: this.vapidHeader(r.endpoint, r.origin.startsWith('https://') ? r.origin : 'mailto:sara@example.invalid'),
            },
            body: new Uint8Array(encryptPayload(body, unb64u(r.p256dh), unb64u(r.auth))),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.status === 404 || res.status === 410) {
            this.unsubscribe(r.endpoint);
            out.removed++;
          } else if (res.ok) {
            this.#db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?').run(this.#now().toISOString(), r.endpoint);
            out.sent++;
          } else throw new Error(`HTTP ${res.status}`);
        } catch {
          this.#db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(r.endpoint);
          out.failed++;
        }
      }),
    );
    return out;
  }

  /** Phase 61: the notification's own words in the owner's app language (her words stay as she wrote them). */
  #tr(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#settings.get(), params);
  }

  /** R4: what the installed web app's badge shows (set by the server: approvals and inbox cards waiting). */
  badge?: () => number;

  /** The companion's name and pronouns (set by main.ts): notification titles are built-in words about her. */
  who?: () => Identity;

  /** A note for the owner (approval needed, long job done); text only if previews are on. */
  async notifyOwner(title: string, text: string, conversationId: string, tag: string, act?: ActItem): Promise<void> {
    const t = text.replace(/\s+/g, ' ').trim();
    const body = this.settings.preview ? (t.length > 180 ? `${t.slice(0, 177)}…` : t) : this.#tr('Open the app to see it.');
    // A title written for Sara ("She learned something new") names a renamed companion; the body may
    // quote the owner or her, so it is left as it is.
    const who = this.who?.();
    await this.sendAll({ title: who ? (appLanguage(this.#settings.get()) === 'en' ? personalize(title, who) : swapName(title, who.name)) : title, body, url: `/#c=${conversationId}`, tag, ...this.actFields(act) });
  }

  /** N5b: the buttons and token for one notification (nothing when there's nothing to do from it). */
  actFields(act?: ActItem): Pick<PushPayload, 'actions' | 'act' | 'companion'> {
    if (!act?.acts.length) return {};
    return {
      act: this.actions.mint(act),
      companion: act.companion ?? 'main',
      // Reply is an inline text box where the phone supports one (else it opens the chat).
      actions: act.acts.slice(0, 2).map((a) => ({ action: a, title: this.#tr(ACT_TITLES[a]), ...(a === 'reply' ? { type: 'text' as const, placeholder: this.#tr('Reply…') } : {}) })),
    };
  }

  /** Reminders and messages Sara starts herself become notifications (the page decides whether to show). */
  async onEvent(ev: HubEvent, persona: string, isPartner: (conversationId: string) => boolean, redact: (s: string) => string = (s) => s): Promise<void> {
    if (ev.type === 'ring') {
      // Phase 26: she's calling. Where Sara isn't open, a notification; opening it shows the call.
      if (ev.ring.state !== 'ringing') return;
      const reason = redact(ev.ring.reason).replace(/\s+/g, ' ').trim();
      await this.sendAll({ title: `📞 ${this.#tr('{name} is calling', { name: persona })}`, body: this.settings.preview ? reason.slice(0, 180) : this.#tr('Open the app to answer.'), url: `/#c=${ev.ring.conversationId}`, tag: 'ring' });
      return;
    }
    if (ev.type !== 'message' || ev.message.role === 'notice' || isPartner(ev.conversationId)) return;
    const text = redact(ev.message.content).replace(/\s+/g, ' ').trim();
    const body = this.settings.preview ? (text.length > 180 ? `${text.slice(0, 177)}…` : text) : ev.reason === 'reminder' ? this.#tr('You have a reminder.') : this.#tr('{name} sent you a message.', { name: persona });
    // N5b: a reminder can be snoozed for an hour; her messages can be answered from the notification.
    const rid = (ev.message.meta?.reminder as { id?: number } | undefined)?.id;
    const act: ActItem | undefined = ev.message.role !== 'assistant' ? undefined : ev.reason === 'reminder' && typeof rid === 'number' ? { kind: 'reminder', id: String(rid), conv: ev.conversationId, companion: ev.companion ?? 'main', acts: ['snooze', 'reply'] } : { kind: 'reply', id: String(ev.message.id), conv: ev.conversationId, companion: ev.companion ?? 'main', acts: ['reply'] };
    await this.sendAll({ title: ev.reason === 'reminder' ? `⏰ ${persona}` : persona, body, url: `/#c=${ev.conversationId}`, tag: `c${ev.message.id}`, ...this.actFields(act) });
  }
}

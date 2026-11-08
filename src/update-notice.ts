// C9: the signed update notice. Every release publishes update-notice.json next to its installers:
// the version, its date, the oldest version still supported, whether it fixes a security problem,
// and each platform's installer with its SHA-256. The notice is signed with the release-notice
// Ed25519 key (private half in .secrets/update-notice/, never committed; scripts/update-notice.ts
// signs on publish). Sara only installs what a notice signed by a key below vouches for, and never
// accepts a notice older than one she has already seen.
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const NOTICE_FORMAT = 'sara-update-notice/1';
export const NOTICE_URL = 'https://github.com/farena-ai/sara/releases/latest/download/update-notice.json';
/** One release's own notice (for the previous installer a rollback needs). */
export const noticeUrlFor = (version: string): string => `https://github.com/farena-ai/sara/releases/download/v${version}/update-notice.json`;

/** Raw Ed25519 public keys (base64) by id (first 16 hex of the key's SHA-256). */
export const NOTICE_KEYS: Record<string, string> = {
  '0bfd41a73239cf88': 'nbiVWlh8nPGrGcj1vzjzQD9AAMBCWKtoU6lkiWR3UMY=',
};

export interface NoticeAsset {
  name: string;
  url: string;
  sha256: string;
  size?: number;
}

export interface NoticePayload {
  version: string;
  /** Release date (ISO). */
  date: string;
  /** Versions below this must update ("Update required"). */
  minSupported: string;
  /** This release fixes a security problem: the button turns red at once. */
  security: boolean;
  /** "win32-x64", "darwin" (universal), "linux" (the source tarball). */
  assets: Record<string, NoticeAsset>;
}

export interface SignedNotice {
  format?: string;
  keyId?: string;
  /** The payload exactly as signed (a JSON string), so no canonical form is needed. */
  payload?: string;
  signature?: string;
}

export type NoticeCheck = { ok: true; notice: NoticePayload; keyId: string } | { ok: false; reason: string };

/** The asset name a platform installs. */
export function assetKey(platform: string, arch: string): string {
  return platform === 'win32' ? `win32-${arch}` : platform === 'darwin' ? 'darwin' : 'linux';
}

const rawToKey = (b64: string): KeyObject =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });

/** A key's id: the first 16 hex characters of the SHA-256 of its 32 raw bytes. */
export function keyIdOf(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
}

/** Dotted versions: negative, zero or positive (same rule as updates.ts). */
function cmp(a: string, b: string): number {
  const p = (v: string) => v.trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** Signs a payload (release side). */
export function signNotice(p: NoticePayload, privateKey: KeyObject): SignedNotice {
  const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  const payload = JSON.stringify(p);
  return { format: NOTICE_FORMAT, keyId: keyIdOf(pub), payload, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') };
}

/** Checks the signature and every field. `seen` = the newest version already accepted here. */
export function verifyNotice(raw: unknown, o: { keys?: Record<string, string>; seen?: string } = {}): NoticeCheck {
  const keys = o.keys ?? NOTICE_KEYS;
  const n = (raw && typeof raw === 'object' ? raw : {}) as SignedNotice;
  if (typeof n.payload !== 'string' || typeof n.signature !== 'string' || !n.signature) return { ok: false, reason: 'the notice is not signed' };
  const sig = Buffer.from(n.signature, 'base64');
  const ids = n.keyId && keys[n.keyId] ? [n.keyId] : Object.keys(keys);
  const keyId = ids.find((id) => {
    try {
      return sig.length === 64 && verify(null, Buffer.from(n.payload!, 'utf8'), rawToKey(keys[id]), sig);
    } catch {
      return false;
    }
  });
  if (!keyId) return { ok: false, reason: 'the signature does not match the release key' };
  let p: NoticePayload;
  try {
    p = JSON.parse(n.payload) as NoticePayload;
  } catch {
    return { ok: false, reason: 'the notice is not readable' };
  }
  if (!p || typeof p.version !== 'string' || !VERSION.test(p.version)) return { ok: false, reason: 'the notice has no version' };
  if (typeof p.minSupported !== 'string' || !VERSION.test(p.minSupported)) return { ok: false, reason: 'the notice has no minimum version' };
  if (typeof p.date !== 'string' || !Number.isFinite(Date.parse(p.date))) return { ok: false, reason: 'the notice has no date' };
  if (typeof p.security !== 'boolean') return { ok: false, reason: 'the notice has no security flag' };
  if (!p.assets || typeof p.assets !== 'object') return { ok: false, reason: 'the notice lists no files' };
  const prefix = `https://github.com/farena-ai/sara/releases/download/v${p.version}/`;
  for (const a of Object.values(p.assets)) {
    if (!a || typeof a.name !== 'string' || !/^[\w.-]+$/.test(a.name) || a.url !== prefix + a.name) return { ok: false, reason: 'a file in the notice is not on the release page' };
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return { ok: false, reason: 'a file in the notice has no SHA-256' };
  }
  if (o.seen && cmp(p.version, o.seen) < 0) return { ok: false, reason: `the notice (${p.version}) is older than one already seen (${o.seen})` };
  return { ok: true, notice: p, keyId };
}

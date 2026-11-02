// Phase 124 (2.57.0, SARA_STORE.md §4.4, K2): checking the Sara Store's files. The index's Ed25519
// signature covers its exact bytes and is checked BEFORE the JSON is parsed; then the sequence only
// goes up (no rollback), `generated` may not be in the future, an index past `expires` is kept for
// browsing but allows no installs (a freeze), and a key revoked by a valid index is refused from then
// on. Every entry, picture and package is accepted only when its sha256 matches the signed index; a
// package's unpacked files must also hash (hashFiles) to the pinned content hash.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { fromZip, hashFiles, stripTop, type PackageFile, type PackageLimits } from '../packages.ts';
import { parseIndex, type StoreIndex, type StoreVersion } from './format.ts';
import { STORE_KEYS } from './keys.ts';

/** A new index may be at most this far past its expiry and still be taken (then browse only). */
export const EXPIRED_GRACE_MS = 24 * 3600_000;
/** `generated` may be at most this far in the future (clock skew). */
export const FUTURE_MS = 24 * 3600_000;

export class StoreRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreRefused';
    this.code = code;
  }
}

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

const keyCache = new Map<string, KeyObject>();
function publicKey(raw: string): KeyObject {
  let k = keyCache.get(raw);
  if (!k) {
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 32) throw new StoreRefused('key', 'A store key is not 32 bytes.');
    k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') }, format: 'jwk' });
    keyCache.set(raw, k);
  }
  return k;
}

/** The signature file: `{"v":1,"key":"store-2026a","sig":"<base64 of 64 bytes>"}`. */
export function parseSig(raw: Uint8Array | string): { key: string; sig: Buffer } {
  const s = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (s.length > 1024) throw new StoreRefused('signature', "The store list's signature file is too big.");
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    throw new StoreRefused('signature', "The store list's signature isn't readable.");
  }
  const r = o as Record<string, unknown>;
  if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['v', 'key', 'sig'].includes(k)) || r.v !== 1 || typeof r.key !== 'string' || typeof r.sig !== 'string') throw new StoreRefused('signature', "The store list's signature isn't readable.");
  const sig = Buffer.from(r.sig, 'base64');
  if (sig.length !== 64) throw new StoreRefused('signature', "The store list's signature is cut short.");
  return { key: r.key, sig };
}

export interface AcceptState {
  /** The highest seq accepted so far (0: none yet). */
  seq: number;
  /** The sha256 of the accepted index of that seq (the same seq may only come back unchanged). */
  sha?: string;
  revokedKeys: string[];
}
export interface AcceptOptions {
  keys?: Readonly<Record<string, string>>;
  now?: Date;
  /** Tests: a spy for the JSON parser (it must not run before the signature is checked). */
  parse?: (text: string) => unknown;
  /** Re-checking the cached copy at start: the same seq is fine, nothing new is learned. */
  cached?: boolean;
}

/** Only the signature: true when `bytes` were signed by the named, known, not revoked key. */
export function signatureOk(bytes: Uint8Array, sigRaw: Uint8Array | string, keys: Readonly<Record<string, string>>, revoked: readonly string[]): { key: string } {
  const { key, sig } = parseSig(sigRaw);
  if (revoked.includes(key)) throw new StoreRefused('revoked', `The store list was signed with a key that was withdrawn (${key}).`);
  const raw = Object.hasOwn(keys, key) ? keys[key] : undefined;
  if (!raw) throw new StoreRefused('unknown-key', `The store list was signed with a key this Sara doesn't know (${key}).`);
  if (!verify(null, bytes, publicKey(raw), sig)) throw new StoreRefused('signature', "The store list's signature doesn't match.");
  return { key };
}

/**
 * The whole check of a downloaded index (§4.4). Returns the parsed index and what the caller must
 * remember (the new seq, the sha and any keys it revokes); throws StoreRefused otherwise.
 */
export function acceptIndex(bytes: Uint8Array, sigRaw: Uint8Array | string, state: AcceptState, o: AcceptOptions = {}): { index: StoreIndex; skipped: string[]; sha: string; revokedKeys: string[] } {
  const keys = o.keys ?? STORE_KEYS;
  const now = (o.now ?? new Date()).getTime();
  const { key } = signatureOk(bytes, sigRaw, keys, state.revokedKeys);
  // Only now is the text parsed (never before the signature is checked).
  const text = Buffer.from(bytes).toString('utf8');
  let parsed: { index: StoreIndex; skipped: string[] };
  try {
    parsed = parseIndex(o.parse ? o.parse(text) : JSON.parse(text));
  } catch (err) {
    throw new StoreRefused('format', (err as Error).message);
  }
  const { index } = parsed;
  if (index.key !== key) throw new StoreRefused('signature', 'The store list names another key than the one that signed it.');
  const sha = sha256(bytes);
  if (index.seq < state.seq) throw new StoreRefused('rollback', `The store list is older than the one Sara already has (${index.seq} < ${state.seq}).`);
  if (index.seq === state.seq && state.sha && state.sha !== sha) throw new StoreRefused('rollback', 'The store list changed without a new number.');
  if (Date.parse(index.generated) > now + FUTURE_MS) throw new StoreRefused('future', 'The store list says it was made in the future.');
  if (!o.cached && Date.parse(index.expires) + EXPIRED_GRACE_MS < now) throw new StoreRefused('expired', 'The store list has expired.');
  const revokedKeys = [...new Set([...state.revokedKeys, ...(index.revokedKeys ?? [])])].filter((k) => k !== key);
  return { index, skipped: parsed.skipped, sha, revokedKeys };
}

/** Installing and updating need a list that hasn't expired. */
export const indexFresh = (index: Pick<StoreIndex, 'expires'>, now: Date = new Date()): boolean => Date.parse(index.expires) > now.getTime();

/** An entry or a picture: its bytes must hash to what the signed index pins. */
export function checkPinned(bytes: Uint8Array, expectSha: string, what = 'file'): void {
  if (sha256(bytes) !== expectSha) throw new StoreRefused('hash', `That ${what} didn't match the store's list, so Sara threw it away.`);
}

/**
 * A package (§4.4, §8.3): the zip's bytes and size must match the index, and its unpacked files
 * must hash to the pinned content hash (so a zip can't carry other files under a matching name).
 */
export function checkPackage(zip: Buffer, v: Pick<StoreVersion, 'sha256' | 'size' | 'contentSha'>, lim?: PackageLimits): PackageFile[] {
  if (!v.sha256 || !v.contentSha) throw new StoreRefused('hash', 'This version has no package.');
  if (v.size !== undefined && zip.length !== v.size) throw new StoreRefused('hash', "That download didn't match the store's list, so Sara threw it away. Try again later.");
  checkPinned(zip, v.sha256, 'download');
  const files = fromZip(zip, lim);
  const { files: inner } = stripTop(files);
  if (hashFiles(inner) !== v.contentSha) throw new StoreRefused('content', "That download didn't match the store's list, so Sara threw it away. Try again later.");
  return files;
}

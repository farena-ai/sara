// Encrypted secret storage (API keys, future OAuth tokens). AES-256-GCM with a per-install
// master key kept in the data directory (mode 0600) or supplied via SARA_MASTER_KEY.
// EC10: an entry may hold a reference to an external source (src/secret-sources.ts); get() returns
// the resolved value, which stays in memory only (never written back here).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { audit } from './audit-trail.ts';
import { writeFileAtomic } from './fs-util.ts';
import { join, resolve } from 'node:path';
import { policy } from './policy-profile.ts';
import { parseReference, secretSources, type SecretSources, type SourceKind } from './secret-sources.ts';

const FILE = 'secrets.enc';
const KEY_FILE = 'master.key';
/** How a reference is stored (so a pasted key can never be mistaken for one). */
export const REF_PREFIX = 'sara-ref:v1:';
/** Server secrets the Secret sources page lists even when they are plain (Sara's vault). */
export const SERVER_SECRET = /^(provider:|business-provider:|business-oidc:|bridge:|voice:|images:|home:token$|git:github$|backup:s3secret$)/;

export interface SecretSourceStatus {
  name: string;
  /** 'vault': stored in Sara's vault; 'reference': read from the sources below. */
  source: 'vault' | 'reference';
  refs?: { kind: SourceKind; ref: string; ok: boolean | null; error?: string; errorKey?: string; params?: Record<string, string | number>; checkedAt?: string }[];
  /** Index of the key in use (several keys rotate on failure). */
  active?: number;
}

// Shared by every Vault instance of this process (the business operator vault is opened per call).
const activeKey = new Map<string, number>();
const namesOf = new Map<string, Set<string>>();
const hooked = new WeakSet<SecretSources>();
function sources(): SecretSources {
  const s = secretSources();
  if (!hooked.has(s)) {
    hooked.add(s);
    s.onStatus = (raw, ok, message) =>
      audit({ action: 'secret.resolve', target: [...(namesOf.get(raw) ?? [])].sort().join(', ') || raw, who: 'system', role: 'system', channel: 'system', outcome: ok ? 'ok' : 'failed', keys: [raw.slice(0, raw.indexOf(':'))], ...(message ? { content: message } : {}) });
  }
  return s;
}
const kindOf = (stored: string | undefined): string => (stored === undefined ? 'none' : stored.startsWith(REF_PREFIX) ? [...new Set((parseReference(stored.slice(REF_PREFIX.length)) ?? []).map((r) => r.kind))].join('-') || 'vault' : 'vault');

export class Vault {
  readonly #dir: string;
  readonly #key: Buffer;
  #data: Record<string, string>;

  constructor(dataDir: string, masterKeyEnv?: string) {
    this.#dir = dataDir;
    this.#key = Vault.#loadKey(dataDir, masterKeyEnv);
    this.#data = this.#read();
  }

  static #loadKey(dir: string, env?: string): Buffer {
    if (env) {
      const k = Buffer.from(env, 'base64');
      if (k.length !== 32) throw new Error('SARA_MASTER_KEY must be 32 bytes, base64-encoded');
      return k;
    }
    const path = join(dir, KEY_FILE);
    if (existsSync(path)) {
      const k = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
      if (k.length !== 32) throw new Error(`${path} is not a valid 32-byte base64 key`);
      return k;
    }
    const k = randomBytes(32);
    writeFileAtomic(path, k.toString('base64') + '\n', 0o600);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort on non-POSIX filesystems
    }
    return k;
  }

  #read(): Record<string, string> {
    const path = join(this.#dir, FILE);
    if (!existsSync(path)) return {};
    const raw = readFileSync(path);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv('aes-256-gcm', this.#key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(enc), d.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
  }

  #write(): void {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(this.#data), 'utf8'), c.final()]);
    const out = Buffer.concat([iv, c.getAuthTag(), enc]);
    const path = join(this.#dir, FILE);
    writeFileAtomic(path, out, 0o600);
  }

  /** Authenticated recovery payload; deliberately excluded from stored secret values. */
  seal(value: string, context: string): string {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1_048_576 || typeof context !== 'string' || !context || context.length > 4096) throw new Error('Invalid recovery payload');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`sara-seal:v1:${context}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  unseal(value: string, context: string): string {
    if (typeof value !== 'string' || value.length > 1_398_144 || !/^v1\.[A-Za-z0-9_-]+$/.test(value) || typeof context !== 'string' || !context || context.length > 4096) throw new Error('Invalid recovery payload');
    const raw = Buffer.from(value.slice(3), 'base64url');
    if (raw.length < 28 || raw.toString('base64url') !== value.slice(3)) throw new Error('Invalid recovery payload');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`sara-seal:v1:${context}`, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  get(name: string): string | undefined {
    const v = this.#data[name];
    if (v === undefined || !v.startsWith(REF_PREFIX)) return v;
    const refs = parseReference(v.slice(REF_PREFIX.length));
    if (!refs) return undefined;
    const src = sources();
    const start = (activeKey.get(this.#slot(name)) ?? 0) % refs.length;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[(start + i) % refs.length];
      this.#note(ref.raw, name);
      const p = src.peek(ref);
      if (p.value !== undefined && !p.error) return p.value;
    }
    // Every key failing: the last good value of the one in use, if any (a refresh may only be late).
    return src.status(refs[start].raw).value;
  }

  /** The reference an entry holds (not a secret), or undefined for a value kept here. */
  reference(name: string): string | undefined {
    const v = this.#data[name];
    return v?.startsWith(REF_PREFIX) ? v.slice(REF_PREFIX.length) : undefined;
  }

  /** Every secret value (for redaction): stored values and the resolved values of references. */
  values(): string[] {
    return [...Object.values(this.#data).filter((v) => !v.startsWith(REF_PREFIX)), ...sources().values()];
  }

  /** Resolves every reference now (start-up), so the first use finds its value. */
  async ready(): Promise<void> {
    await Promise.allSettled(this.#refs().flatMap(([name, refs]) => refs.map((r) => (this.#note(r.raw, name), sources().resolve(r)))));
  }

  /** Re-reads references now ("Check now"); returns their status. */
  async check(name?: string): Promise<SecretSourceStatus[]> {
    await Promise.allSettled(this.#refs().filter(([n]) => !name || n === name).flatMap(([n, refs]) => refs.map((r) => (this.#note(r.raw, n), sources().resolve(r, true)))));
    return this.sources();
  }

  /** Moves a multi-key reference to its next key (after the provider refused the one in use). */
  rotate(name: string): boolean {
    const text = this.reference(name);
    const refs = text ? parseReference(text) : undefined;
    if (!refs || refs.length < 2) return false;
    const slot = this.#slot(name);
    const from = (activeKey.get(slot) ?? 0) % refs.length;
    const to = (from + 1) % refs.length;
    activeKey.set(slot, to);
    // The refused key is read again next time (it may have been rotated at the source).
    if (refs[from].kind !== 'env' && refs[from].kind !== 'file') void sources().resolve(refs[from], true).catch(() => {});
    else sources().forget(refs[from].raw);
    audit({ action: 'secret.rotate', target: name, who: 'system', role: 'system', channel: 'system', outcome: 'ok', keys: [`from.${from + 1}`, `to.${to + 1}`] });
    return true;
  }

  /** Where each server secret and every reference comes from. Never a value. */
  sources(): SecretSourceStatus[] {
    const out: SecretSourceStatus[] = [];
    for (const name of Object.keys(this.#data).sort()) {
      const text = this.reference(name);
      if (text === undefined) {
        if (SERVER_SECRET.test(name)) out.push({ name, source: 'vault' });
        continue;
      }
      const refs = parseReference(text) ?? [];
      out.push({
        name,
        source: 'reference',
        active: (activeKey.get(this.#slot(name)) ?? 0) % Math.max(1, refs.length),
        refs: refs.map((r) => {
          const st = r.kind === 'env' ? sources().peek(r) : sources().status(r.raw);
          return { kind: r.kind, ref: r.raw, ok: st.checkedAt === undefined ? null : !st.error, ...(st.error ? { error: st.error, errorKey: st.errorKey, ...(st.params ? { params: st.params } : {}) } : {}), ...(st.checkedAt !== undefined ? { checkedAt: new Date(st.checkedAt).toISOString() } : {}) };
        }),
      });
    }
    return out;
  }

  #slot(name: string): string {
    return `${resolve(this.#dir)}\0${name}`;
  }
  #note(raw: string, name: string): void {
    let set = namesOf.get(raw);
    if (!set) namesOf.set(raw, (set = new Set()));
    set.add(name);
  }
  #refs(): [string, NonNullable<ReturnType<typeof parseReference>>][] {
    const out: [string, NonNullable<ReturnType<typeof parseReference>>][] = [];
    for (const name of Object.keys(this.#data)) {
      const text = this.reference(name);
      const refs = text ? parseReference(text) : undefined;
      if (refs) out.push([name, refs]);
    }
    return out;
  }

  has(name: string): boolean {
    return name in this.#data;
  }

  /** Stores a value, or a reference when the value is one (env:…, file:…, vault:…, op://…, keychain:…, cmd:…). */
  set(name: string, value: string): void {
    const refs = parseReference(value);
    // EC5 pin: server keys only from external sources (a pasted key is refused; Sara's own secrets are not affected).
    if (!refs && SERVER_SECRET.test(name) && policy().pins.externalSecrets) throw policy().refusal('externalSecrets');
    const before = kindOf(this.#data[name]);
    this.#data[name] = refs ? REF_PREFIX + refs.map((r) => r.raw).join(' | ') : value;
    this.#write();
    this.#sourceChanged(name, before);
    if (refs) {
      activeKey.delete(this.#slot(name));
      for (const r of refs) {
        this.#note(r.raw, name);
        if (r.kind !== 'env') void sources().resolve(r, true).catch(() => {});
      }
    }
  }

  delete(name: string): void {
    if (!(name in this.#data)) return;
    const before = kindOf(this.#data[name]);
    delete this.#data[name];
    this.#write();
    activeKey.delete(this.#slot(name));
    this.#sourceChanged(name, before);
  }

  /** EC4: one audit row when an entry's source changes (Sara's vault ↔ a reference, or another source). */
  #sourceChanged(name: string, before: string): void {
    const after = kindOf(this.#data[name]);
    if (before === after || (before !== 'none' && before.split('-').every((k) => k === 'vault') && after === 'vault')) return;
    if (before === 'none' && after === 'vault') return;
    if (after === 'none' && before === 'vault') return;
    audit({ action: 'secret.source', target: name, keys: [`from.${before}`, `to.${after}`] });
  }
}

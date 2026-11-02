// Phase 125 (2.58.0, SARA_STORE.md §9.4, K6): sending an add-on to the Sara team's desk, with no
// account anywhere. The first submit makes an author key (Ed25519; the private half in the vault as
// `store:author`, never sent, never shown); every submission and update is signed with it. The upload
// fits the hub's limits: a start request (≤ 64 KB, proof of work like tickets), chunks of at most
// 480 KiB as application/octet-stream with their sha256, then *finish* with the author key's
// signature over `sara-store-submit:v1:<item>:<version>:<sha256>`. Only what the author chose is
// sent: the package, its report, the name shown on the store, an optional email, the public key,
// the install id (as tickets send it), Sara's version and the OS.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { solvePow, type HubSend } from '../hub.ts';
import { netFetch } from '../net-guard.ts';
import type { Vault } from '../vault.ts';
import type { PackReport } from './checks.ts';
import { ensureStoreTables } from './installs.ts';

export const AUTHOR_VAULT = 'store:author';
export const CHUNK_BYTES = 480 * 1024;
export const SUBMIT_POW_BITS = 18;
export const SIGN_PREFIX = 'sara-store-submit:v1:';
/** Exactly these fields go in the start request (the test checks it). */
export const START_FIELDS = ['v', 'id', 'kind', 'item', 'version', 'name', 'contact', 'report', 'size', 'sha256', 'chunks', 'authorKey', 'sara', 'os', 'pow'] as const;

export interface AuthorKey {
  /** ed25519:<hex sha256 of the raw public key> (the hub ties an add-on to it). */
  fingerprint: string;
  /** Base64 of the raw 32-byte public key (sent). */
  publicRaw: string;
  privateKey: KeyObject;
}
type VaultLike = Pick<Vault, 'get' | 'set' | 'has'>;

export const fingerprintOf = (publicRaw: string): string => `ed25519:${createHash('sha256').update(Buffer.from(publicRaw, 'base64')).digest('hex')}`;
export const shortFingerprint = (fp: string): string => (/^ed25519:[0-9a-f]{64}$/.test(fp) ? `ed25519:${fp.slice(8, 12)}…${fp.slice(-2)}` : fp);

/** The author key: read from the vault, or made once (on the first submit) and kept there. */
export function authorKey(vault: VaultLike, o: { create?: boolean } = { create: true }): AuthorKey | undefined {
  const raw = vault.get(AUTHOR_VAULT);
  if (raw) {
    const j = JSON.parse(raw) as { private: string; public: string };
    return { fingerprint: fingerprintOf(j.public), publicRaw: j.public, privateKey: createPrivateKey({ key: Buffer.from(j.private, 'base64'), format: 'der', type: 'pkcs8' }) };
  }
  if (o.create === false) return undefined;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  vault.set(AUTHOR_VAULT, JSON.stringify({ v: 1, private: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), public: pub }));
  return { fingerprint: fingerprintOf(pub), publicRaw: pub, privateKey };
}

/** The bytes the author key signs. */
export const signedText = (item: string, version: string, sha: string): string => `${SIGN_PREFIX}${item}:${version}:${sha}`;
export function signSubmission(k: AuthorKey, item: string, version: string, sha: string): string {
  return edSign(null, Buffer.from(signedText(item, version, sha), 'utf8'), k.privateKey).toString('base64');
}
/** Tests and the hub: does a signature check with a raw public key? */
export function signatureChecks(publicRaw: string, item: string, version: string, sha: string, sig: string): boolean {
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicRaw, 'base64').toString('base64url') }, format: 'jwk' });
  return edVerify(null, Buffer.from(signedText(item, version, sha), 'utf8'), pub, Buffer.from(sig, 'base64'));
}

export class DeskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
/** "Our desk isn't answering right now": the draft is kept and nothing is lost. */
export const deskDown = (status: number): boolean => status === 0 || status === 502 || status === 503 || status === 504;

async function call(base: string, path: string, init: { method: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> }, send: HubSend): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await send(`${base}${path}`, {
      method: init.method,
      headers: { 'x-sara-hub': '1', accept: 'application/json', ...(init.raw ? { 'content-type': 'application/octet-stream' } : init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      ...(init.raw ? { body: new Uint8Array(init.raw) } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { status: 0, json: {} };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

export interface SubmitInput {
  base: string;
  installId: string;
  vault: VaultLike;
  db: DatabaseSync;
  pack: { zip: Buffer; sha256: string; size: number; report: PackReport };
  name: string;
  contact?: string;
  saraVersion: string;
  os: string;
  send?: HubSend;
  now?: () => Date;
  bits?: number;
  /** Progress, for the page and the terminal. */
  progress?: (done: number, of: number) => void;
}
export interface SubmitResult {
  submission: string;
  state: string;
  key: string;
}

/** The whole upload. Throws DeskError (with `deskDown(status)` when the draft should just wait). */
export async function submit(i: SubmitInput): Promise<SubmitResult> {
  const send = i.send ?? netFetch;
  const r = i.pack.report;
  if (!r.ready) throw new DeskError(400, 'not-ready', 'Fix what the checks found first.');
  const key = authorKey(i.vault)!;
  const chunks = Math.max(1, Math.ceil(i.pack.size / CHUNK_BYTES));
  let bits = i.bits ?? SUBMIT_POW_BITS;
  let start: { status: number; json: Record<string, unknown> } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = await solvePow(i.installId, `${r.id}@${r.version}`, bits);
    const body: Record<string, unknown> = { v: 1, id: i.installId, kind: r.kind, item: r.id, version: r.version, name: i.name.trim().slice(0, 60), ...(i.contact?.trim() ? { contact: i.contact.trim().slice(0, 200) } : {}), report: slimReport(r), size: i.pack.size, sha256: i.pack.sha256, chunks, authorKey: key.publicRaw, sara: i.saraVersion, os: i.os, pow: { nonce, bits } };
    start = await call(i.base, '/v1/store/submissions', { method: 'POST', body }, send);
    if (start.status === 428 && typeof start.json.bits === 'number' && start.json.bits > bits) {
      bits = start.json.bits;
      continue;
    }
    break;
  }
  if (!start || start.status !== 200) throw new DeskError(start?.status ?? 0, String(start?.json.error ?? 'desk'), String(start?.json.message ?? "Our desk isn't answering right now. Try again later."));
  const sub = String(start.json.submission);
  const token = String(start.json.token);
  const upload = String(start.json.upload);
  ensureStoreTables(i.db);
  const at = (i.now?.() ?? new Date()).toISOString();
  i.db.prepare(`INSERT INTO store_submissions (submission, token, item, kind, version, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'uploading') ON CONFLICT(submission) DO NOTHING`).run(sub, token, r.id, r.kind, r.version, at);
  for (let n = 0; n < chunks; n++) {
    const part = i.pack.zip.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES);
    const sha = createHash('sha256').update(part).digest('hex');
    const c = await call(i.base, `/v1/store/submissions/${encodeURIComponent(sub)}/chunks/${n}`, { method: 'PUT', raw: Buffer.from(part), headers: { 'x-upload': upload, 'x-chunk-sha256': sha } }, send);
    if (c.status !== 200) throw new DeskError(c.status, String(c.json.error ?? 'chunk'), String(c.json.message ?? "Our desk isn't answering right now. Try again later."));
    i.progress?.(n + 1, chunks);
  }
  const fin = await call(i.base, `/v1/store/submissions/${encodeURIComponent(sub)}/finish`, { method: 'POST', body: { token, signature: signSubmission(key, r.id, r.version, i.pack.sha256) } }, send);
  if (fin.status !== 200) throw new DeskError(fin.status, String(fin.json.error ?? 'finish'), String(fin.json.message ?? "Our desk isn't answering right now. Try again later."));
  const state = String(fin.json.state ?? 'checking');
  i.db.prepare('UPDATE store_submissions SET status = ? WHERE submission = ?').run(state, sub);
  return { submission: sub, state, key: key.fingerprint };
}

/** The report as sent (the manifest copy stays home: the reviewers read the files themselves). */
export function slimReport(r: PackReport & { contentSha?: string; fence?: string }): Record<string, unknown> {
  return { kind: r.kind, id: r.id, version: r.version, name: r.name, ready: r.ready, results: r.results.map((x) => ({ id: x.id, ok: x.ok, warnings: x.warnings.slice(0, 20).map((w) => w.slice(0, 300)), problems: x.problems.slice(0, 20).map((p) => p.slice(0, 300)) })), ...(r.lines ? { lines: r.lines.slice(0, 40) } : {}), ...(r.contentSha ? { contentSha: r.contentSha } : {}), ...(r.fence ? { fence: r.fence } : {}) };
}

export interface SubmissionRow {
  submission: string;
  token: string;
  item: string;
  kind: string;
  version: string;
  created_at: string;
  status: string;
  messages: string;
  checked_at: string | null;
}

/** *My submissions*: ask the desk with the reply token and keep what it says. */
export async function refreshSubmission(db: DatabaseSync, base: string, sub: string, o: { send?: HubSend; now?: () => Date } = {}): Promise<SubmissionRow> {
  ensureStoreTables(db);
  const row = db.prepare('SELECT * FROM store_submissions WHERE submission = ?').get(sub) as unknown as SubmissionRow | undefined;
  if (!row) throw new DeskError(404, 'not-found', 'No such submission here.');
  const r = await call(base, `/v1/store/submissions/${encodeURIComponent(sub)}?token=${encodeURIComponent(row.token)}`, { method: 'GET' }, o.send ?? netFetch);
  if (r.status !== 200) throw new DeskError(r.status, String(r.json.error ?? 'desk'), String(r.json.message ?? "Our desk isn't answering right now. Try again later."));
  const msgs = Array.isArray(r.json.messages) ? (r.json.messages as { at?: unknown; from?: unknown; text?: unknown; name?: unknown }[]).slice(-50).map((m) => ({ at: String(m.at ?? ''), from: m.from === 'team' ? 'team' : 'you', text: String(m.text ?? '').slice(0, 4000), ...(typeof m.name === 'string' ? { name: m.name.slice(0, 40) } : {}) })) : [];
  const at = (o.now?.() ?? new Date()).toISOString();
  db.prepare('UPDATE store_submissions SET status = ?, messages = ?, checked_at = ? WHERE submission = ?').run(String(r.json.state ?? row.status), JSON.stringify(msgs), at, sub);
  return { ...row, status: String(r.json.state ?? row.status), messages: JSON.stringify(msgs), checked_at: at };
}

export async function replySubmission(db: DatabaseSync, base: string, sub: string, text: string, o: { send?: HubSend } = {}): Promise<void> {
  const row = db.prepare('SELECT token FROM store_submissions WHERE submission = ?').get(sub) as { token: string } | undefined;
  if (!row) throw new DeskError(404, 'not-found', 'No such submission here.');
  const r = await call(base, `/v1/store/submissions/${encodeURIComponent(sub)}/reply`, { method: 'POST', body: { token: row.token, text: text.slice(0, 4000) } }, o.send ?? netFetch);
  if (r.status !== 200) throw new DeskError(r.status, String(r.json.error ?? 'desk'), String(r.json.message ?? "Our desk isn't answering right now. Try again later."));
}

export function submissions(db: DatabaseSync): SubmissionRow[] {
  ensureStoreTables(db);
  return db.prepare('SELECT * FROM store_submissions ORDER BY created_at DESC LIMIT 100').all() as unknown as SubmissionRow[];
}

export const REPORT_REASONS = ['bad', 'broken', 'spam', 'copy', 'other'] as const;
/** *Report this* (§10.1): no diagnostics unless the owner ticked the box (then only its scrubbed log). */
export async function sendReport(o: { base: string; installId: string; item: string; version?: string; reason: string; text: string; contact?: string; log?: string; send?: HubSend; bits?: number }): Promise<string> {
  if (!(REPORT_REASONS as readonly string[]).includes(o.reason)) throw new DeskError(400, 'reason', 'Pick what is wrong.');
  let bits = o.bits ?? SUBMIT_POW_BITS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = await solvePow(o.installId, `${o.item}:${o.reason}`, bits);
    const body = { v: 1, id: o.installId, item: o.item, ...(o.version ? { version: o.version } : {}), reason: o.reason, text: o.text.slice(0, 2000), ...(o.contact?.trim() ? { contact: o.contact.trim().slice(0, 200) } : {}), ...(o.log ? { log: o.log.slice(0, 64 * 1024) } : {}), pow: { nonce, bits } };
    const r = await call(o.base, '/v1/store/reports', { method: 'POST', body }, o.send ?? netFetch);
    if (r.status === 428 && typeof r.json.bits === 'number' && r.json.bits > bits) {
      bits = r.json.bits;
      continue;
    }
    if (r.status !== 200) throw new DeskError(r.status, String(r.json.error ?? 'desk'), String(r.json.message ?? "Our desk isn't answering right now. Try again later."));
    return String(r.json.report);
  }
  throw new DeskError(428, 'pow', 'The desk asked for more proof of work than expected.');
}

/** The held list (§10.2): an anonymous GET with no id; it can only hide items. */
export async function fetchHeld(base: string, send: HubSend = netFetch): Promise<{ id: string; since: string }[]> {
  const r = await call(base, '/v1/store/held', { method: 'GET' }, send);
  if (r.status !== 200 || !Array.isArray(r.json.held)) return [];
  return (r.json.held as { id?: unknown; since?: unknown }[]).filter((h) => typeof h.id === 'string' && /^[a-z0-9-]{1,48}$/.test(h.id)).slice(0, 200).map((h) => ({ id: String(h.id), since: String(h.since ?? '') }));
}

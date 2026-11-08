// EC4 (docs/ops/EC45_DESIGN.md): one append-only, hash-chained audit trail for the whole server.
// Rows hold who, what, where and the outcome: names and ids only, never values, secrets or chat
// text. The only free text (`content`, an approval card's summary) is redacted before it is kept and
// is left out of views and exports unless the owner asks for it.
import { anyHold } from './legal-hold.ts';
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';
import { zipStored } from './zip-write.ts';

export type AuditRole = 'owner' | 'member' | 'device' | 'system';
export type AuditOutcome = 'ok' | 'refused' | 'failed' | 'pending';
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['ok', 'refused', 'failed', 'pending'];
export const RETENTION_CHOICES = [30, 90, 365, 0] as const;
export const DEFAULT_RETENTION_DAYS = 365;

export interface AuditInput {
  action: string;
  who?: string;
  role?: AuditRole;
  target?: string;
  channel?: string;
  outcome?: AuditOutcome;
  /** Names of the fields a request changed (never their values). */
  keys?: string[];
  /** Redacted free text (an approval card's summary); hidden unless asked for. */
  content?: string;
}
export interface AuditRow extends Required<Pick<AuditInput, 'action' | 'who' | 'role' | 'channel' | 'outcome'>> {
  seq: number;
  at: string;
  target?: string;
  keys?: string[];
  content?: string;
  policyRev: number;
  prev: string;
  hash: string;
}
export interface AuditFilter {
  who?: string;
  action?: string;
  channel?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: number;
}

const GENESIS = '0'.repeat(64);
const ID = /^[\w.:@/ -]{1,120}$/;
const clip = (v: unknown, n = 120): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
  return s || undefined;
};
const hashOf = (row: Omit<AuditRow, 'hash'>): string => createHash('sha256').update(row.prev).update(JSON.stringify(row)).digest('hex');

export class AuditTrail {
  readonly #dir: string;
  readonly #file: string;
  readonly #head: string;
  readonly #settings: string;
  readonly #redact: (s: string) => string;
  readonly #key: () => string;
  readonly #policyRev: () => number;
  readonly #now: () => Date;

  constructor(dataDir: string, o: { redact?: (s: string) => string; key?: () => string; policyRev?: () => number; now?: () => Date } = {}) {
    this.#dir = join(dataDir, 'audit');
    this.#file = join(this.#dir, 'trail.jsonl');
    this.#head = join(this.#dir, 'head.json');
    this.#settings = join(this.#dir, 'settings.json');
    this.#redact = o.redact ?? ((s) => s);
    this.#key = o.key ?? (() => 'sara-audit');
    this.#policyRev = o.policyRev ?? (() => 0);
    this.#now = o.now ?? (() => new Date());
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #readHead(): { seq: number; hash: string; anchor?: { seq: number; hash: string } } {
    try {
      return JSON.parse(readFileSync(this.#head, 'utf8'));
    } catch {
      return { seq: 0, hash: GENESIS };
    }
  }

  /** Appends one row. Never throws to its caller: an audit failure must not break the action. */
  record(input: AuditInput): AuditRow | undefined {
    try {
      const head = this.#readHead();
      const action = clip(input.action, 80);
      if (!action || !ID.test(action)) return undefined;
      const keys = input.keys?.filter((k) => typeof k === 'string' && /^[\w.-]{1,60}$/.test(k)).slice(0, 40);
      const content = input.content ? clip(this.#redact(input.content), 400) : undefined;
      const body: Omit<AuditRow, 'hash'> = {
        seq: head.seq + 1,
        at: this.#now().toISOString(),
        who: clip(input.who, 80) ?? 'owner',
        role: input.role ?? 'owner',
        action,
        ...(clip(input.target) ? { target: clip(input.target)! } : {}),
        channel: clip(input.channel, 40) ?? 'web',
        outcome: AUDIT_OUTCOMES.includes(input.outcome as AuditOutcome) ? input.outcome! : 'ok',
        ...(keys?.length ? { keys } : {}),
        ...(content ? { content } : {}),
        policyRev: this.#policyRev(),
        prev: head.hash,
      };
      const row: AuditRow = { ...body, hash: hashOf(body) };
      appendFileSync(this.#file, JSON.stringify(row) + '\n', { mode: 0o600 });
      writeFileAtomic(this.#head, JSON.stringify({ ...head, seq: row.seq, hash: row.hash }));
      return row;
    } catch (err) {
      console.warn(`audit: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Every row, oldest first (lines that don't parse stay in as null, so verify() sees them). */
  #rows(): (AuditRow | null)[] {
    if (!existsSync(this.#file)) return [];
    return readFileSync(this.#file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l) as AuditRow;
      } catch {
        return null;
      }
    });
  }

  /** Checks the chain end to end: each row's hash, its link to the one before, and the head. */
  verify(): { ok: boolean; rows: number; brokenAt?: number; reason?: string } {
    const head = this.#readHead();
    const rows = this.#rows();
    let prev = head.anchor?.hash ?? GENESIS;
    let seq = head.anchor?.seq ?? 0;
    for (const r of rows) {
      if (!r) return { ok: false, rows: rows.length, brokenAt: seq + 1, reason: 'unreadable' };
      const { hash, ...body } = r;
      if (r.seq !== seq + 1) return { ok: false, rows: rows.length, brokenAt: seq + 1, reason: 'missing' };
      if (r.prev !== prev || hashOf(body) !== hash) return { ok: false, rows: rows.length, brokenAt: r.seq, reason: 'changed' };
      prev = hash;
      seq = r.seq;
    }
    if (seq !== head.seq || prev !== head.hash) return { ok: false, rows: rows.length, brokenAt: seq + 1, reason: 'truncated' };
    return { ok: true, rows: rows.length };
  }

  list(f: AuditFilter = {}, o: { content?: boolean } = {}): AuditRow[] {
    const from = f.from ? Date.parse(f.from) : NaN;
    const to = f.to ? Date.parse(f.to) + (/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? 86_400_000 - 1 : 0) : NaN;
    const limit = Math.min(Math.max(Number(f.limit) || 500, 1), 5000);
    const out: AuditRow[] = [];
    const rows = this.#rows();
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (!r) continue;
      if (f.who && r.who !== f.who && r.role !== f.who) continue;
      if (f.action && r.action !== f.action && !r.action.startsWith(f.action + '.')) continue;
      if (f.channel && r.channel !== f.channel) continue;
      if (f.outcome && r.outcome !== f.outcome) continue;
      const at = Date.parse(r.at);
      if ((!Number.isNaN(from) && at < from) || (!Number.isNaN(to) && at > to)) continue;
      if (!o.content && r.content !== undefined) {
        const { content: _c, ...rest } = r;
        out.push(rest as AuditRow);
      } else out.push(r);
    }
    return out;
  }

  get retentionDays(): number {
    try {
      const n = JSON.parse(readFileSync(this.#settings, 'utf8')).retentionDays;
      return (RETENTION_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_RETENTION_DAYS;
    } catch {
      return DEFAULT_RETENTION_DAYS;
    }
  }
  setRetention(days: number): void {
    if (!(RETENTION_CHOICES as readonly number[]).includes(days)) throw new Error('Pick 30, 90 or 365 days, or keep everything.');
    writeFileAtomic(this.#settings, JSON.stringify({ retentionDays: days }));
  }

  /**
   * Drops the oldest rows past the retention, as one contiguous run that stops at the first row
   * still pending (unresolved delivery evidence is never deleted). The chain stays checkable: the
   * head keeps an anchor (the last dropped row's seq and hash). Returns how many rows went.
   */
  prune(days = this.retentionDays): number {
    // EC17: while anyone is under a legal hold the trail is kept whole.
    if (!days || anyHold()) return 0;
    const cutoff = this.#now().getTime() - days * 86_400_000;
    const rows = this.#rows();
    let n = 0;
    while (n < rows.length && rows[n] && Date.parse(rows[n]!.at) < cutoff && rows[n]!.outcome !== 'pending') n++;
    if (!n || !this.verify().ok) return 0;
    const last = rows[n - 1]!;
    writeFileAtomic(this.#file, rows.slice(n).map((r) => JSON.stringify(r) + '\n').join(''));
    const head = this.#readHead();
    writeFileAtomic(this.#head, JSON.stringify({ ...head, anchor: { seq: last.seq, hash: last.hash } }));
    this.record({ action: 'audit.prune', role: 'system', who: 'system', channel: 'system', keys: [`rows_${n}`] });
    return n;
  }

  /** A ZIP with the rows (JSONL or CSV) and a manifest hashed and signed with this server's key. */
  exportZip(format: 'jsonl' | 'csv', f: AuditFilter = {}, o: { content?: boolean } = {}): { zip: Buffer; manifest: Record<string, unknown> } {
    const rows = this.list({ ...f, limit: 5000 }, o).reverse();
    const data = Buffer.from(format === 'csv' ? toCsv(rows, Boolean(o.content)) : rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
    const head = this.#readHead();
    const manifest: Record<string, unknown> = {
      kind: 'sara-audit-export',
      version: 1,
      createdAt: this.#now().toISOString(),
      format,
      file: `audit.${format}`,
      filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')),
      content: Boolean(o.content),
      rows: rows.length,
      firstSeq: rows[0]?.seq ?? null,
      lastSeq: rows.at(-1)?.seq ?? null,
      sha256: createHash('sha256').update(data).digest('hex'),
      chainHead: { seq: head.seq, hash: head.hash },
      verified: this.verify().ok,
    };
    manifest.hmacSha256 = this.sign(manifest);
    return { zip: zipStored([{ path: `audit.${format}`, data }, { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]), manifest };
  }

  /** HMAC-SHA256 of a manifest (without its own signature field) with this server's key. */
  sign(manifest: Record<string, unknown>): string {
    const { hmacSha256: _s, ...rest } = manifest;
    return createHmac('sha256', this.#key()).update(JSON.stringify(rest)).digest('hex');
  }
}

const CSV_COLS = ['seq', 'at', 'who', 'role', 'action', 'target', 'channel', 'outcome', 'keys', 'policyRev', 'prev', 'hash'] as const;
/** One CSV cell: quoted when needed; a leading = + - @ (a spreadsheet formula) gets a ' first. */
export function csvCell(v: unknown): string {
  let s = Array.isArray(v) ? v.join(' ') : v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: readonly AuditRow[], content = false): string {
  const cols: string[] = [...CSV_COLS, ...(content ? ['content'] : [])];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell((r as unknown as Record<string, unknown>)[c])).join(','))].join('\r\n') + '\r\n';
}

// ---- the server's one trail (set by main.ts; tests set their own). Unset = nothing is written. ----
let current: AuditTrail | undefined;
export function setAuditTrail(t: AuditTrail | undefined): void {
  current = t;
}
export function auditTrail(): AuditTrail | undefined {
  return current;
}
export function audit(input: AuditInput): void {
  current?.record(input);
}

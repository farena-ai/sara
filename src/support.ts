// S9b (docs/SUPPORT_LINK.md): the support link. Built on an S9a link (src/messages.ts): the helped owner
// gives the other owner a time-limited help pass; with it, the helper's Sara reads a support report
// (health, self-test, versions, recent errors, redacted log lines, settings without keys, model status,
// app versions) and may PROPOSE a change from a short allowlist, which the helped owner approves or not.
// Never chats, memories, files, mail, messages or medical data; no shell, no files, no remote control.
//
// Wire (server to server, JSON over HTTPS, the link's own Ed25519 keys, scope 'support'):
//   POST /msg/v1/support/<op>   headers sara-sup-link, sara-sup-time,
//        sara-sup-sig = sign(`support\n${link}\n${time}\n${op}\n${sha256(body)}`)
//   ops: pass, revoke (helped → helper); look, propose (helper → helped, need a valid pass); answer (helped → helper)
// The 'support' prefix and the op are signed, so an S9a message signature (or one for another op) never
// passes here, and a support signature never passes on /msg/v1/inbox. Body ids are remembered (409).
import { createHash, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import type { Messenger } from './messages.ts';
import type { Settings } from './settings.ts';

export const SUPPORT_HOURS = [1, 24, 168] as const;
const SKEW_MS = 5 * 60_000;
const NOTE_CHARS = 1000;
const LOG_KEEP = 500;

/** U5.33: signed peer calls a link may make a minute, per scope (support, repair, sproj, market). */
export const PEER_PER_MINUTE = 120;
/** Counts one call; false when the link is over PEER_PER_MINUTE this minute. */
export function peerRate(m: Map<string, { min: number; n: number }>, key: string, nowMs: number): boolean {
  const minute = Math.floor(nowMs / 60_000);
  const r = m.get(key);
  if (r && r.min === minute && r.n >= PEER_PER_MINUTE) return false;
  m.set(key, r && r.min === minute ? { min: minute, n: r.n + 1 } : { min: minute, n: 1 });
  if (m.size > 2000) for (const [k, v] of m) if (v.min !== minute) m.delete(k);
  return true;
}

export class SupportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * What a helper may propose: model and provider choice, fallbacks, toggles, timeouts. Nothing that
 * touches keys, permissions, adult mode, private mode, sharing, tools, shell or computer use.
 */
export const SUPPORT_ALLOW: Readonly<Record<string, { kind: 'provider' | 'model' | 'fallbacks' | 'seconds' | 'bool' | 'jobs' | 'enum'; values?: readonly string[]; min?: number; max?: number }>> = {
  defaultProviderId: { kind: 'provider' },
  defaultModel: { kind: 'model' },
  defaultFallbacks: { kind: 'fallbacks' },
  fallbackAfterSec: { kind: 'seconds', min: 10, max: 600 },
  autoJobs: { kind: 'jobs', values: ['chat', 'coding', 'vision', 'research'] },
  historyBudgetMode: { kind: 'enum', values: ['auto', 'full', 'fixed'] },
  'memoryTidy.on': { kind: 'bool' },
  'persona.innerLife': { kind: 'bool' },
};
export type SupportChange = { path: string; value: unknown };

const MODEL_RE = /^[\w.:/@+-]{1,120}$/;
const bad = (why: string) => new SupportError(400, why);

/** Checks one proposed change against the allowlist and this server's settings; returns the clean value. */
export function cleanChange(c: unknown, s: Settings): SupportChange {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const path = String(o.path ?? '');
  if (!Object.hasOwn(SUPPORT_ALLOW, path)) throw bad(en('That setting can’t be changed through a help pass.'));
  const rule = SUPPORT_ALLOW[path]!;
  const v = o.value;
  const providers = new Set((s.providers ?? []).map((p) => p.id));
  const model = (x: unknown) => {
    if (typeof x !== 'string' || !MODEL_RE.test(x)) throw bad(en('That model name is not valid.'));
    return x;
  };
  const provider = (x: unknown) => {
    if (typeof x !== 'string' || !providers.has(x)) throw bad(en('That model service is not set up on this server.'));
    return x;
  };
  switch (rule.kind) {
    case 'provider':
      return { path, value: provider(v) };
    case 'model':
      return { path, value: model(v) };
    case 'fallbacks': {
      if (!Array.isArray(v) || v.length > 5) throw bad(en('Up to 5 fallback models.'));
      return { path, value: v.map((f) => ({ providerId: provider((f as Record<string, unknown>)?.providerId), model: model((f as Record<string, unknown>)?.model) })) };
    }
    case 'seconds': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < rule.min! || n > rule.max!) throw bad(en('Pick 10 to 600 seconds.'));
      return { path, value: n };
    }
    case 'bool':
      if (typeof v !== 'boolean') throw bad(en('That needs on or off.'));
      return { path, value: v };
    case 'jobs':
      if (!Array.isArray(v) || v.some((x) => !rule.values!.includes(String(x)))) throw bad(en('That setting can’t be changed through a help pass.'));
      return { path, value: [...new Set(v.map(String))] };
    case 'enum':
      if (!rule.values!.includes(String(v))) throw bad(en('That setting can’t be changed through a help pass.'));
      return { path, value: String(v) };
  }
}

/** The current value of an allowlisted path (null when unset). */
export function valueAt(s: Settings, path: string): unknown {
  const [a, b] = path.split('.');
  const top = (s as unknown as Record<string, unknown>)[a!];
  const v = b ? (top && typeof top === 'object' ? (top as Record<string, unknown>)[b] : undefined) : top;
  return v === undefined ? null : structuredClone(v);
}
/** The settings patch for clean changes (dotted paths merge into their object). */
export function patchFor(s: Settings, changes: SupportChange[]): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const c of changes) {
    const [a, b] = c.path.split('.');
    if (!b) out[a!] = c.value;
    else out[a!] = { ...((out[a!] ?? (s as unknown as Record<string, unknown>)[a!] ?? {}) as Record<string, unknown>), [b]: c.value };
  }
  return out as Partial<Settings>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);

/** The signed scope word: 'support' (S9b help pass), 'repair' (T5 fix pass, docs/REMOTE_REPAIR.md) or 'sproj' (U4.26 shared projects). */
export type SupportScope = 'support' | 'repair' | 'sproj';
/** The headers of a support-scope request (exported for tests). */
export function signSupport(linkId: string, op: string, body: string, key: KeyObject, at: Date, scope: SupportScope = 'support'): Record<string, string> {
  const time = at.toISOString();
  const sig = sign(null, Buffer.from(`${scope}\n${linkId}\n${time}\n${op}\n${sha(body)}`), key).toString('base64');
  return { 'sara-sup-link': linkId, 'sara-sup-time': time, 'sara-sup-sig': sig };
}

export interface PassView {
  id: string;
  link: string;
  peer: string;
  note: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}
export interface ProposalView {
  id: string;
  peerId: string;
  link: string;
  peer: string;
  side: 'in' | 'out';
  changes: SupportChange[];
  diff: { path: string; before: unknown; after: unknown }[];
  note: string;
  status: 'pending' | 'approved' | 'denied' | 'failed';
  createdAt: string;
  decidedAt: string | null;
}
export interface LogRow {
  at: string;
  link: string;
  peer: string;
  side: 'helper' | 'helped';
  kind: 'pass' | 'revoke' | 'look' | 'propose' | 'approved' | 'denied' | `repair-${string}`;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sp_passes (id TEXT PRIMARY KEY, link TEXT NOT NULL, side TEXT NOT NULL, peer TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, asked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sp_proposals (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, link TEXT NOT NULL, side TEXT NOT NULL, peer TEXT NOT NULL, changes TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, before TEXT);
CREATE TABLE IF NOT EXISTS sp_log (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, link TEXT NOT NULL, peer TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sp_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
`;

export class SupportLink {
  readonly #db: DatabaseSync;
  readonly #rate = new Map<string, { min: number; n: number }>();
  readonly #m: Messenger;
  readonly #now: () => Date;
  #closed = false;
  /** Something changed (a pass, a proposal, an answer): the page reloads; main.ts notifies for proposals. */
  onChange: ((linkId: string) => void) | undefined;

  constructor(o: { dataDir: string; messenger: Messenger; now: () => Date }) {
    this.#db = new DatabaseSync(join(o.dataDir, 'support.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#m = o.messenger;
    this.#now = o.now;
    o.messenger.whenClosed(() => this.close());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
  #iso(): string {
    return this.#now().toISOString();
  }
  peer(linkId: string): { id: string; url: string; key: KeyObject; name: string } {
    const p = this.#m.peer(linkId);
    if (!p) throw new SupportError(404, en('That link is gone. Link the servers again under Messages.'));
    return p;
  }
  /** Linked servers by name (the tool picks one by name). */
  peers(): { id: string; name: string }[] {
    return this.#m.links().filter((l) => l.kind === 'direct').map((l) => ({ id: l.id, name: l.name }));
  }

  // ---- the log (both sides) ----------------------------------------------------------------------
  log(linkId: string, peer: string, side: LogRow['side'], kind: LogRow['kind'], detail = ''): void {
    this.#db.prepare('INSERT INTO sp_log (at, link, peer, side, kind, detail) VALUES (?, ?, ?, ?, ?, ?)').run(this.#iso(), linkId, peer, side, kind, clip(detail, 300));
    this.#db.prepare('DELETE FROM sp_log WHERE n <= (SELECT MAX(n) FROM sp_log) - ?').run(LOG_KEEP);
  }
  logRows(limit = 100): LogRow[] {
    return this.#db.prepare('SELECT at, link, peer, side, kind, detail FROM sp_log ORDER BY n DESC LIMIT ?').all(limit) as unknown as LogRow[];
  }

  // ---- passes ------------------------------------------------------------------------------------
  #passView(r: Record<string, unknown>): PassView {
    const expiresAt = String(r.expires_at);
    const revokedAt = (r.revoked_at as string | null) ?? null;
    return { id: String(r.id), link: String(r.link), peer: String(r.peer), note: String(r.note ?? ''), createdAt: String(r.created_at), expiresAt, revokedAt, active: !revokedAt && expiresAt > this.#iso() };
  }
  passes(side: 'given' | 'held'): PassView[] {
    return (this.#db.prepare('SELECT * FROM sp_passes WHERE side = ? ORDER BY created_at DESC LIMIT 50').all(side) as Record<string, unknown>[]).map((r) => this.#passView(r));
  }
  /** The valid pass on a link (given: I am helped; held: I help). */
  activePass(linkId: string, side: 'given' | 'held'): (PassView & { asked: boolean }) | undefined {
    const r = this.#db.prepare('SELECT * FROM sp_passes WHERE link = ? AND side = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1').get(linkId, side, this.#iso()) as Record<string, unknown> | undefined;
    return r ? { ...this.#passView(r), asked: Boolean(r.asked) } : undefined;
  }
  /** The tool asked its owner once for this pass: later looks on it don't ask again. */
  markAsked(passId: string): void {
    this.#db.prepare('UPDATE sp_passes SET asked = 1 WHERE id = ?').run(passId);
  }

  /** The helped owner gives a pass (1 h, 1 day or 7 days); the helper is told. Ends any earlier pass on that link. */
  async grant(linkId: string, hours: unknown, note: unknown): Promise<PassView> {
    const h = Number(hours);
    if (!SUPPORT_HOURS.includes(h as 1)) throw bad(en('A help pass lasts 1 hour, 1 day or 7 days.'));
    const p = this.peer(linkId);
    const now = this.#iso();
    this.#db.prepare('UPDATE sp_passes SET revoked_at = ? WHERE link = ? AND side = ? AND revoked_at IS NULL').run(now, linkId, 'given');
    const id = randomUUID();
    const expiresAt = new Date(this.#now().getTime() + h * 3_600_000).toISOString();
    const n = clip(note, NOTE_CHARS);
    this.#db.prepare('INSERT INTO sp_passes (id, link, side, peer, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, linkId, 'given', p.name, n, now, expiresAt);
    this.log(linkId, p.name, 'helped', 'pass', `${h} h`);
    const r = await this.call(linkId, 'pass', { pass: id, expiresAt, note: n }).catch(() => null);
    if (!r) throw new SupportError(502, en('The other server did not answer. Check its address and try again.'));
    return this.#passView(this.#db.prepare('SELECT * FROM sp_passes WHERE id = ?').get(id) as Record<string, unknown>);
  }
  async revoke(passId: string): Promise<void> {
    const r = this.#db.prepare('SELECT * FROM sp_passes WHERE id = ? AND side = ?').get(passId, 'given') as Record<string, unknown> | undefined;
    if (!r) throw new SupportError(404, en('Not found'));
    if (!r.revoked_at) this.#db.prepare('UPDATE sp_passes SET revoked_at = ? WHERE id = ?').run(this.#iso(), passId);
    this.log(String(r.link), String(r.peer), 'helped', 'revoke');
    // Best effort: the pass is already dead on this side, which is the side that checks it.
    await this.call(String(r.link), 'revoke', { pass: passId }).catch(() => null);
    this.onChange?.(String(r.link));
  }

  // ---- proposals ---------------------------------------------------------------------------------
  #proposalView(r: Record<string, unknown>, s: Settings): ProposalView {
    const changes = JSON.parse(String(r.changes)) as SupportChange[];
    const decided = r.status !== 'pending' && r.before ? (JSON.parse(String(r.before)) as unknown[]) : null;
    return {
      id: String(r.id),
      peerId: String(r.peer_id),
      link: String(r.link),
      peer: String(r.peer),
      side: String(r.side) as 'in' | 'out',
      changes,
      diff: changes.map((c, i) => ({ path: c.path, before: decided ? (decided[i] ?? null) : valueAt(s, c.path), after: c.value })),
      note: String(r.note ?? ''),
      status: String(r.status) as ProposalView['status'],
      createdAt: String(r.created_at),
      decidedAt: (r.decided_at as string | null) ?? null,
    };
  }
  proposals(s: Settings): ProposalView[] {
    return (this.#db.prepare('SELECT * FROM sp_proposals ORDER BY created_at DESC LIMIT 50').all() as Record<string, unknown>[]).map((r) => this.#proposalView(r, s));
  }
  /** Helper side: send a proposal (clean changes and/or a plain instruction). */
  async propose(linkId: string, changes: SupportChange[], note: unknown): Promise<ProposalView & { remote: string }> {
    const p = this.peer(linkId);
    const n = clip(note, NOTE_CHARS);
    if (!changes.length && !n) throw bad(en('Add a change or a note.'));
    if (!this.activePass(linkId, 'held')) throw new SupportError(403, en('You need a valid help pass first.'));
    const id = randomUUID();
    const r = (await this.call(linkId, 'propose', { proposal: id, changes, note: n })) as { id?: string };
    this.#db.prepare('INSERT INTO sp_proposals (id, peer_id, link, side, peer, changes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, clip(r.id, 64), linkId, 'out', p.name, JSON.stringify(changes), n, this.#iso());
    this.log(linkId, p.name, 'helper', 'propose', changes.map((c) => c.path).join(', ') || 'note');
    return { ...this.#proposalView(this.#db.prepare('SELECT * FROM sp_proposals WHERE id = ?').get(id) as Record<string, unknown>, {} as Settings), remote: clip(r.id, 64) };
  }
  /** Helped side: a proposal arrived over a valid pass (already checked against the allowlist). */
  received(linkId: string, peerId: string, changes: SupportChange[], note: string, s: Settings): ProposalView {
    const p = this.peer(linkId);
    const id = randomUUID();
    this.#db.prepare('INSERT INTO sp_proposals (id, peer_id, link, side, peer, changes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, peerId, linkId, 'in', p.name, JSON.stringify(changes), clip(note, NOTE_CHARS), this.#iso());
    this.log(linkId, p.name, 'helped', 'propose', changes.map((c) => c.path).join(', ') || 'note');
    this.onChange?.(linkId);
    return this.#proposalView(this.#db.prepare('SELECT * FROM sp_proposals WHERE id = ?').get(id) as Record<string, unknown>, s);
  }
  /**
   * Helped side: the owner's OK or no. `apply` writes the settings (the allowlist is checked again
   * against today's settings); the helper is told either way.
   */
  async decide(id: string, approve: boolean, s: Settings, apply: (patch: Partial<Settings>) => void): Promise<ProposalView> {
    const r = this.#db.prepare('SELECT * FROM sp_proposals WHERE id = ? AND side = ?').get(id, 'in') as Record<string, unknown> | undefined;
    if (!r) throw new SupportError(404, en('Not found'));
    if (r.status !== 'pending') throw new SupportError(409, en('Already answered.'));
    const changes = (JSON.parse(String(r.changes)) as SupportChange[]).map((c) => cleanChange(c, s));
    const before = changes.map((c) => valueAt(s, c.path));
    if (approve && changes.length) apply(patchFor(s, changes));
    const status = approve ? 'approved' : 'denied';
    this.#db.prepare('UPDATE sp_proposals SET status = ?, decided_at = ?, before = ? WHERE id = ?').run(status, this.#iso(), JSON.stringify(before), id);
    this.log(String(r.link), String(r.peer), 'helped', status, changes.map((c) => c.path).join(', ') || 'note');
    await this.call(String(r.link), 'answer', { proposal: String(r.peer_id), status }).catch(() => null);
    this.onChange?.(String(r.link));
    return this.#proposalView(this.#db.prepare('SELECT * FROM sp_proposals WHERE id = ?').get(id) as Record<string, unknown>, s);
  }

  // ---- the wire ----------------------------------------------------------------------------------
  /** A signed support call to the other side; throws SupportError with the other side's status. */
  async call(linkId: string, op: string, payload: Record<string, unknown>, scope: SupportScope = 'support'): Promise<Record<string, unknown>> {
    const p = this.peer(linkId);
    const key = this.#m.privateKeyFor(linkId);
    if (!key) throw new SupportError(404, en('That link is gone. Link the servers again under Messages.'));
    const body = JSON.stringify({ v: 1, id: randomUUID(), ...payload });
    let res: Response;
    try {
      res = await this.#m.peerFetch(`${p.url}/msg/v1/${scope}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(linkId, op, body, key, this.#now(), scope) }, body, redirect: 'error', signal: AbortSignal.timeout(45_000) });
    } catch {
      throw new SupportError(502, en('The other server did not answer. Check its address and try again.'));
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 403) throw new SupportError(403, scope === 'repair' && typeof j.error === 'string' && j.error !== 'no valid pass' ? clip(j.error, 200) : scope === 'repair' ? en('You need a valid fix pass first.') : en('You need a valid help pass first.'));
    if (!res.ok) throw new SupportError(res.status === 400 ? 400 : 502, typeof j.error === 'string' && res.status === 400 ? clip(j.error, 200) : en('The other server did not answer. Check its address and try again.'));
    return j;
  }

  /** Checks a peer request: link, time, support-scope signature for this op, replay. Returns the link id. */
  verify(headers: IncomingHttpHeaders, op: string, body: string, scope: SupportScope = 'support'): { linkId: string; name: string } {
    const linkId = String(headers['sara-sup-link'] ?? '');
    const time = String(headers['sara-sup-time'] ?? '');
    const sig = String(headers['sara-sup-sig'] ?? '');
    const p = linkId ? this.#m.peer(linkId) : undefined;
    const t = Date.parse(time);
    const unsigned = new SupportError(401, 'unsigned');
    if (!p || !Number.isFinite(t) || Math.abs(t - this.#now().getTime()) > SKEW_MS) throw unsigned;
    let ok = false;
    try {
      ok = verify(null, Buffer.from(`${scope}\n${linkId}\n${time}\n${op}\n${sha(body)}`), p.key, Buffer.from(sig, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw unsigned;
    // U5.33: a linked server that floods (help, fix, recipe or shared-project calls) is slowed down.
    if (!peerRate(this.#rate, `${scope}:${linkId}`, this.#now().getTime())) throw new SupportError(429, 'slow down');
    let id = '';
    try {
      id = String((JSON.parse(body) as { id?: unknown }).id ?? '');
    } catch {
      throw new SupportError(400, 'bad request');
    }
    if (!id) throw new SupportError(400, 'bad request');
    const seen = sha(`${linkId}/${id}`);
    if (this.#db.prepare('SELECT 1 FROM sp_seen WHERE id = ?').get(seen)) throw new SupportError(409, 'replay');
    this.#db.prepare('INSERT INTO sp_seen (id, at) VALUES (?, ?)').run(seen, this.#iso());
    this.#db.prepare('DELETE FROM sp_seen WHERE at < ?').run(new Date(this.#now().getTime() - 86_400_000).toISOString());
    return { linkId, name: p.name };
  }

  /** Helper side: the other owner gave or ended a pass. */
  heldPass(linkId: string, name: string, b: Record<string, unknown>): void {
    const id = clip(b.pass, 64);
    const expiresAt = typeof b.expiresAt === 'string' && Number.isFinite(Date.parse(b.expiresAt)) ? new Date(Math.min(Date.parse(b.expiresAt), this.#now().getTime() + 168 * 3_600_000)).toISOString() : '';
    if (!id || !expiresAt) throw bad('bad pass');
    this.#db.prepare('UPDATE sp_passes SET revoked_at = ? WHERE link = ? AND side = ? AND revoked_at IS NULL').run(this.#iso(), linkId, 'held');
    this.#db.prepare('INSERT OR REPLACE INTO sp_passes (id, link, side, peer, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, linkId, 'held', name, clip(b.note, NOTE_CHARS), this.#iso(), expiresAt);
    this.log(linkId, name, 'helper', 'pass');
    this.onChange?.(linkId);
  }
  heldRevoked(linkId: string, name: string, b: Record<string, unknown>): void {
    this.#db.prepare('UPDATE sp_passes SET revoked_at = ? WHERE id = ? AND link = ? AND side = ? AND revoked_at IS NULL').run(this.#iso(), clip(b.pass, 64), linkId, 'held');
    this.log(linkId, name, 'helper', 'revoke');
    this.onChange?.(linkId);
  }
  answered(linkId: string, name: string, b: Record<string, unknown>): void {
    const status = b.status === 'approved' ? 'approved' : 'denied';
    const r = this.#db.prepare("UPDATE sp_proposals SET status = ?, decided_at = ? WHERE id = ? AND link = ? AND side = 'out' AND status = 'pending'").run(status, this.#iso(), clip(b.proposal, 64), linkId);
    if (Number(r.changes)) this.log(linkId, name, 'helper', status);
    this.onChange?.(linkId);
  }
}

const cache = new WeakMap<Messenger, SupportLink>();
/** The owner's support link (undefined for members, kid mode and the demo: they have no Messenger). */
export function supportOf(app: Pick<AppContext, 'messages' | 'dataDir' | 'now'>): SupportLink | undefined {
  const m = app.messages;
  if (!m) return undefined;
  let s = cache.get(m);
  if (!s) cache.set(m, (s = new SupportLink({ dataDir: app.dataDir, messenger: m, now: () => app.now() })));
  return s;
}

// ---- reading a report (helper side; the tool and the page) -------------------------------------
export interface Finding {
  level: 'problem' | 'note';
  /** The health check's name or the self-test area (an English key), shown before the text. */
  area?: string;
  text: string;
  params?: Record<string, string | number>;
}
type Rep = Record<string, any>;
/** What looks wrong in a report, as English keys with params (the page translates them; the tool sends English). */
export function supportFindings(r: Rep): Finding[] {
  const out: Finding[] = [];
  for (const c of r?.health?.checks ?? []) if (c && c.ok === false) out.push({ level: 'problem', area: String(c.name), text: String(c.detailKey ?? c.detail ?? '').slice(0, 300), ...(c.detailKey && c.params ? { params: c.params } : {}) });
  // Self-test lines that only say something isn't set up (no mailbox, no phone, no desktop app) are notes.
  for (const l of r?.selfTest ?? []) if (l?.status === 'attention') out.push({ level: /^(No |The inbox helper has not)/.test(String(l.text)) ? 'note' : 'problem', area: String(l.area), text: String(l.text).slice(0, 300), ...(l.params ? { params: l.params } : {}) });
  for (const p of r?.errors?.providers ?? []) out.push({ level: 'problem', text: en('{service} failed recently: {kind}.'), params: { service: String(p.service), kind: String(p.kind) } });
  const turns = (r?.errors?.turns ?? []).length;
  if (turns) out.push({ level: turns >= 3 ? 'problem' : 'note', text: en('{n} turn error(s) recently.'), params: { n: turns } });
  const tools = (r?.errors?.tools ?? []).length;
  if (tools) out.push({ level: 'note', text: en('{n} tool error(s) recently.'), params: { n: tools } });
  const u = r?.version?.update;
  if (u && (u.state === 'available' || u.required)) out.push({ level: u.required ? 'problem' : 'note', text: en('An update is waiting: {latest}.'), params: { latest: String(u.latest ?? '') } });
  if (u?.state === 'failed' || u?.state === 'rolledback') out.push({ level: 'problem', text: en('The last update did not finish: {message}'), params: { message: String(u.message ?? '').slice(0, 160) } });
  if (!r?.models?.default?.model) out.push({ level: 'problem', text: en('No default model is set.') });
  if (r?.models?.default?.model && !(r?.models?.fallbacks ?? []).length) out.push({ level: 'note', text: en('No fallback model: if the default stops, chats stop.') });
  for (const a of r?.apps ?? []) if (a?.behind) out.push({ level: 'note', text: en('The {kind} app is on {version}, older than the server.'), params: { kind: String(a.kind), version: String(a.version) } });
  return out;
}

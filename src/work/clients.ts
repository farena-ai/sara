// N7 (docs/WORK_AND_TEAMS.md): a light client pipeline. A client is a person the owner (or a household
// member, in their own space) works for: a People card flagged as a client, plus a stage
// (lead → quoted → won → invoiced → paid, or lost), a value, a next step with a date and an hourly rate
// (time_invoice bills hours at it). The rows live in the person's own store.db next to their E6
// invoices, so stages move by themselves when a quote or an invoice is made, accepted or paid
// (`workOnBiz`, called by src/biz/store.ts). Money is whole cents; nothing here calls a model.
import type { DatabaseSync } from 'node:sqlite';
import { releaseBilled } from './time.ts';

export const STAGES = ['lead', 'quoted', 'won', 'invoiced', 'paid', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
const RANK: Record<Stage, number> = { lead: 0, quoted: 1, won: 2, invoiced: 3, paid: 4, lost: -1 };

export interface Client {
  id: number;
  name: string;
  email: string;
  stage: Stage;
  valueCents: number;
  currency: string;
  nextStep: string;
  /** Local date YYYY-MM-DD. */
  nextDate: string | null;
  /** Hourly rate for billed time, cents (0: not set). */
  rateCents: number;
  personId: number | null;
  stageAt: string;
  createdAt: string;
}
export interface StageMove {
  clientId: number;
  at: string;
  from: Stage | null;
  to: Stage;
  why: string;
}

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** Names compare folded (accents, case, punctuation, \"Inc\"/\"LLC\"). */
export const foldName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|gmbh|sa)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export const isStage = (s: unknown): s is Stage => (STAGES as readonly string[]).includes(String(s));

const toClient = (r: Row): Client => ({
  id: Number(r.id),
  name: String(r.name),
  email: String(r.email),
  stage: (isStage(r.stage) ? r.stage : 'lead') as Stage,
  valueCents: Number(r.value_cents),
  currency: String(r.currency),
  nextStep: String(r.next_step),
  nextDate: r.next_date == null ? null : String(r.next_date),
  rateCents: Number(r.rate_cents),
  personId: r.person_id == null ? null : Number(r.person_id),
  stageAt: String(r.stage_at),
  createdAt: String(r.created_at),
});

export class ClientStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS work_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'lead',
      value_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', next_step TEXT NOT NULL DEFAULT '', next_date TEXT,
      rate_cents INTEGER NOT NULL DEFAULT 0, person_id INTEGER, stage_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_client_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, at TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, why TEXT NOT NULL DEFAULT '');`);
  }

  list(): Client[] {
    return (this.#db.prepare('SELECT * FROM work_clients ORDER BY name COLLATE NOCASE').all() as Row[]).map(toClient);
  }
  get(id: number): Client | undefined {
    const r = this.#db.prepare('SELECT * FROM work_clients WHERE id = ?').get(id) as Row | undefined;
    return r ? toClient(r) : undefined;
  }
  /** By id, exact folded name, email, or the only client whose name contains the words. */
  find(q: unknown, email = ''): Client | undefined {
    const s = String(q ?? '').trim();
    const all = this.list();
    if (/^#?\d+$/.test(s)) {
      const c = this.get(Number(s.replace('#', '')));
      if (c) return c;
    }
    const f = foldName(s);
    const em = (email || (/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.exec(s)?.[0] ?? '')).toLowerCase();
    const hit = (f ? all.find((c) => foldName(c.name) === f) : undefined) ?? (em ? all.find((c) => c.email.toLowerCase() === em) : undefined);
    if (hit) return hit;
    const part = f.length >= 3 ? all.filter((c) => foldName(c.name).includes(f)) : [];
    return part.length === 1 ? part[0] : undefined;
  }
  add(c: { name: string; email?: string; stage?: Stage; valueCents?: number; currency?: string; nextStep?: string; nextDate?: string | null; rateCents?: number; personId?: number | null }, why = 'added'): Client {
    const name = clip(c.name, 160);
    if (!name) throw new Error('Give the client a name.');
    if (this.find(name, c.email)) throw new Error(`“${name}” is already a client.`);
    const ts = this.#now().toISOString();
    const stage = c.stage ?? 'lead';
    const id = Number(
      this.#db
        .prepare('INSERT INTO work_clients (name, email, stage, value_cents, currency, next_step, next_date, rate_cents, person_id, stage_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, clip(c.email, 200), stage, Math.max(0, Math.round(c.valueCents ?? 0)), c.currency ?? 'USD', clip(c.nextStep, 300), c.nextDate ?? null, Math.max(0, Math.round(c.rateCents ?? 0)), c.personId ?? null, ts, ts).lastInsertRowid,
    );
    this.#move(id, null, stage, why);
    return this.get(id)!;
  }
  update(id: number, patch: { name?: string; email?: string; valueCents?: number; currency?: string; nextStep?: string; nextDate?: string | null; rateCents?: number; personId?: number | null }): Client | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined && clip(patch.name, 160)) cols.name = clip(patch.name, 160);
    if (patch.email !== undefined) cols.email = clip(patch.email, 200);
    if (patch.valueCents !== undefined) cols.value_cents = Math.max(0, Math.round(patch.valueCents));
    if (patch.currency !== undefined) cols.currency = patch.currency;
    if (patch.nextStep !== undefined) cols.next_step = clip(patch.nextStep, 300);
    if (patch.nextDate !== undefined) cols.next_date = patch.nextDate;
    if (patch.rateCents !== undefined) cols.rate_cents = Math.max(0, Math.round(patch.rateCents));
    if (patch.personId !== undefined) cols.person_id = patch.personId;
    const keys = Object.keys(cols);
    if (keys.length) this.#db.prepare(`UPDATE work_clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => cols[k]) as never[]), id);
    return this.get(id);
  }
  setStage(id: number, stage: Stage, why = 'set by hand'): Client | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    if (cur.stage !== stage) {
      this.#db.prepare('UPDATE work_clients SET stage = ?, stage_at = ? WHERE id = ?').run(stage, this.#now().toISOString(), id);
      this.#move(id, cur.stage, stage, why);
    }
    return this.get(id);
  }
  remove(id: number): boolean {
    this.#db.prepare('DELETE FROM work_client_moves WHERE client_id = ?').run(id);
    return Number(this.#db.prepare('DELETE FROM work_clients WHERE id = ?').run(id).changes) > 0;
  }
  moves(id: number): StageMove[] {
    return (this.#db.prepare('SELECT * FROM work_client_moves WHERE client_id = ? ORDER BY id').all(id) as Row[]).map((r) => ({ clientId: Number(r.client_id), at: String(r.at), from: r.from_stage == null ? null : (String(r.from_stage) as Stage), to: String(r.to_stage) as Stage, why: String(r.why) }));
  }
  #move(id: number, from: Stage | null, to: Stage, why: string): void {
    this.#db.prepare('INSERT INTO work_client_moves (client_id, at, from_stage, to_stage, why) VALUES (?, ?, ?, ?, ?)').run(id, this.#now().toISOString(), from, to, clip(why, 200));
  }

  /** Counts and value by stage, open value (lead..invoiced), and next steps past their date. */
  pipeline(today: string): { stages: { stage: Stage; count: number; valueCents: number }[]; openCents: number; wonCents: number; overdue: Client[]; due: Client[]; currency: string; total: number } {
    const all = this.list();
    const stages = STAGES.map((stage) => {
      const xs = all.filter((c) => c.stage === stage);
      return { stage, count: xs.length, valueCents: xs.reduce((n, c) => n + c.valueCents, 0) };
    });
    const sum = (ss: Stage[]) => stages.filter((s) => ss.includes(s.stage)).reduce((n, s) => n + s.valueCents, 0);
    const steps = all.filter((c) => c.nextDate && c.nextStep && c.stage !== 'lost' && c.stage !== 'paid');
    return {
      stages,
      openCents: sum(['lead', 'quoted', 'won', 'invoiced']),
      wonCents: sum(['won', 'invoiced', 'paid']),
      overdue: steps.filter((c) => c.nextDate! < today).sort((a, b) => a.nextDate!.localeCompare(b.nextDate!)),
      due: steps.filter((c) => c.nextDate === today),
      currency: all.find((c) => c.valueCents)?.currency ?? all[0]?.currency ?? 'USD',
      total: all.length,
    };
  }
}

const stores = new WeakMap<DatabaseSync, ClientStore>();
export function clientStoreOf(db: DatabaseSync, now?: () => Date): ClientStore {
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new ClientStore(db, now)));
  return s;
}

/** What happened to an E6 invoice or quote (src/biz/store.ts tells this after the change is saved). */
export interface BizEvent {
  kind: 'invoice' | 'quote';
  what: 'made' | 'sent' | 'accepted' | 'paid' | 'void';
  id: number;
  number: string;
  clientName: string;
  clientEmail: string;
  totalCents: number;
  currency: string;
  issued: string;
}

/** The stage an E6 event moves a client to (none: the event doesn't move the pipeline). */
export function stageFor(ev: Pick<BizEvent, 'kind' | 'what'>): Stage | undefined {
  if (ev.kind === 'quote' && ev.what === 'made') return 'quoted';
  if (ev.kind === 'quote' && ev.what === 'accepted') return 'won';
  if (ev.kind === 'invoice' && ev.what === 'made') return 'invoiced';
  if (ev.kind === 'invoice' && ev.what === 'paid') return 'paid';
  return undefined;
}

/**
 * Moves the client's stage forward on an E6 event (never backwards; a new quote or invoice for a
 * paid or lost client starts a new round). A client not on the list is added only once the person
 * keeps a client list (at least one client), so the pipeline never appears unasked.
 */
export function workOnBiz(db: DatabaseSync, now: () => Date, ev: BizEvent): void {
  if (ev.what === 'void' && ev.kind === 'invoice') releaseBilled(db, ev.id);
  const to = stageFor(ev);
  if (!to) return;
  const cs = clientStoreOf(db, now);
  let c = cs.find(ev.clientName, ev.clientEmail);
  const label = `${ev.number} ${ev.what === 'made' ? 'made' : ev.what}`;
  if (!c) {
    if (!cs.list().length) return;
    c = cs.add({ name: ev.clientName, email: ev.clientEmail, stage: to, valueCents: ev.totalCents, currency: ev.currency }, label);
  } else {
    const restart = ev.what === 'made' && (c.stage === 'paid' || c.stage === 'lost');
    if (RANK[to] > RANK[c.stage] || restart) cs.setStage(c.id, to, label);
    // A quote sets the deal's value; an invoice only fills it in when none was set (part invoices,
    // like billed hours, don't shrink the deal).
    const value = ev.kind === 'quote' || !c.valueCents ? { valueCents: ev.totalCents, currency: ev.currency } : {};
    if (ev.what === 'made') cs.update(c.id, { ...value, ...(ev.clientEmail && !c.email ? { email: ev.clientEmail } : {}) });
  }
  // A quote gets a follow-up a week later, unless a next step is already set.
  const now2 = cs.get(c.id)!;
  if (ev.kind === 'quote' && ev.what === 'made' && !now2.nextStep) {
    const d = new Date(`${ev.issued}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    cs.update(c.id, { nextStep: `Follow up on quote ${ev.number}`, nextDate: d.toISOString().slice(0, 10) });
  }
  // Paid: the round is over, an automatic quote follow-up goes with it.
  if ((to === 'won' || to === 'paid') && /^Follow up on quote /.test(now2.nextStep)) cs.update(c.id, { nextStep: '', nextDate: null });
}

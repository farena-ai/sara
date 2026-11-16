// S3 (docs/GOALS.md "Goals over days"): long-running goals, ABOVE errands. "Get my house sale
// paperwork done by Dec 15" becomes a plan of milestones with due dates. A milestone may start one
// thing through its own engine when its turn comes (never a copy of one): a Planner task, a
// reminder, an errand (planned, waiting for the person's Start) or an automation (made switched
// off, waiting for the person to turn it on). So nothing that acts runs without the usual OK.
//
// The reminder scheduler's tick calls due() (no timer of its own; at most one check an hour per
// goal): linked things that finished tick their milestone off, the next milestone starts its thing,
// a checkpoint due tomorrow gets one nudge, a missed checkpoint (or a stopped errand) becomes a
// proposed new plan that only the person applies (Goals page or the tile; the model can't), and
// every goal sends a weekly summary. Quiet hours keep the phone silent; the goal's own chat keeps
// the line. Private local mode pauses the checks.
//
// Table (additive, the space's own store.db, so each household member has their own): long_goals.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { errandsFor } from './errands.ts';
import { appLanguage, en, trOwner } from './i18n.ts';
import { quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { zonedParts, zonedToUtc } from './planner.ts';

export const GOAL = { max: 20, maxMilestones: 10, keepHistory: 60, checkEveryMs: 3600_000, weekMs: 7 * 24 * 3600_000, slipDays: 2 } as const;
export const GOAL_STATUSES = ['active', 'paused', 'done', 'stopped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const MILESTONE_KINDS = ['none', 'task', 'reminder', 'errand', 'automation'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export interface Milestone {
  text: string;
  /** A local date, YYYY-MM-DD (null: no date). */
  due: string | null;
  kind: MilestoneKind;
  status: 'todo' | 'done' | 'skipped';
  /** What it started, in its own engine. */
  link?: { kind: Exclude<MilestoneKind, 'none'>; id: number };
  /** errand: what the errand engine needs. */
  errand?: { template?: string; facts?: Record<string, unknown> };
  /** automation: an automation draft (made switched off). */
  automation?: Record<string, unknown>;
  nudged?: string;
  /** The due date a slip was already proposed (or dismissed) for. */
  slipAt?: string;
  doneAt?: string;
}
export interface Proposal {
  why: string;
  at: string;
  index: number;
  moves: { index: number; from: string | null; to: string }[];
  due?: { from: string; to: string };
  /** A stopped errand: a fresh one is planned when the plan is used. */
  retry?: boolean;
}
export interface LongGoal {
  id: number;
  title: string;
  due: string | null;
  status: GoalStatus;
  milestones: Milestone[];
  history: { at: string; text: string }[];
  proposal: Proposal | null;
  owner: 'owner' | 'member';
  conversationId: string | null;
  lastCheck: string | null;
  lastWeekly: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MilestoneDraft {
  text?: string;
  due?: string;
  kind?: string;
  errand?: { template?: string; facts?: Record<string, unknown> };
  automation?: Record<string, unknown>;
}
export interface GoalDraft {
  title: string;
  due?: string;
  milestones?: MilestoneDraft[];
}
export interface LongGoalOptions {
  /** Tests: catch notifications (default: app.push.notifyOwner). */
  notify?: (title: string, body: string, conversationId: string, tag: string) => Promise<void>;
  quiet?: () => boolean;
}

export class GoalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const GOAL_LINES = [en('Goal not found.'), en('Say what the goal is.'), en('A goal has at most 10 milestones.'), en('You have the most goals this keeps.'), en('Goals can’t be set up from a private chat.'), en('Only you can use a new plan.'), en('There is no new plan to use.')];

const DAY = 24 * 3600_000;
const line = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
/** YYYY-MM-DD plus n days (calendar arithmetic at noon UTC, so no DST surprises). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
}
const maxDay = (a: string, b: string) => (a > b ? a : b);

type Row = Record<string, string | number | null>;
interface Data {
  milestones: Milestone[];
  history: { at: string; text: string }[];
  proposal: Proposal | null;
}

export class LongGoals {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: LongGoalOptions;

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: LongGoalOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`
CREATE TABLE IF NOT EXISTS long_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  due TEXT,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'owner',
  conversation_id TEXT,
  last_check TEXT,
  last_weekly TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
  }

  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone;
  }
  #today(now: Date = this.#now()): string {
    const p = zonedParts(now, this.#tz());
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  #at(day: string, h: number): Date {
    const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
    return zonedToUtc(y, mo, d, h, 0, this.#tz());
  }
  #T(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }
  /** A date for people: "Nov 20" in the owner's language (the model's words keep YYYY-MM-DD). */
  #day(day: string | null | undefined): string {
    if (!day) return '—';
    try {
      return new Date(`${day}T12:00:00Z`).toLocaleDateString(appLanguage(this.#app.settings.get()), { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch {
      return day;
    }
  }

  #row(r: Row): LongGoal {
    const d = JSON.parse(String(r.data_json)) as Data;
    return {
      id: Number(r.id),
      title: String(r.title),
      due: r.due ? String(r.due) : null,
      status: String(r.status) as GoalStatus,
      milestones: d.milestones ?? [],
      history: d.history ?? [],
      proposal: d.proposal ?? null,
      owner: r.owner === 'member' ? 'member' : 'owner',
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      lastCheck: r.last_check ? String(r.last_check) : null,
      lastWeekly: r.last_weekly ? String(r.last_weekly) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  list(o: { open?: boolean } = {}): LongGoal[] {
    const rows = this.#db.prepare(`SELECT * FROM long_goals ${o.open ? "WHERE status IN ('active', 'paused')" : ''} ORDER BY id DESC`).all() as Row[];
    return rows.map((r) => this.#row(r));
  }
  get(id: number): LongGoal | undefined {
    const r = this.#db.prepare('SELECT * FROM long_goals WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }
  #must(id: number): LongGoal {
    const g = this.get(id);
    if (!g) throw new GoalError(404, en('Goal not found.'));
    return g;
  }
  #save(g: LongGoal): LongGoal {
    const data: Data = { milestones: g.milestones, history: g.history.slice(-GOAL.keepHistory), proposal: g.proposal };
    this.#db
      .prepare('UPDATE long_goals SET title = ?, due = ?, status = ?, data_json = ?, conversation_id = ?, last_check = ?, last_weekly = ?, updated_at = ? WHERE id = ?')
      .run(g.title, g.due, g.status, JSON.stringify(data), g.conversationId, g.lastCheck, g.lastWeekly, this.#now().toISOString(), g.id);
    this.#app.events?.publish({ type: 'today', part: 'goals' });
    return this.get(g.id)!;
  }
  #log(g: LongGoal, text: string): void {
    g.history.push({ at: this.#now().toISOString(), text: clip(text, 400) });
  }

  // ------------------------------------------------------------ the plan

  /** A checked plan (no row): what the Allow card and the page's preview show. */
  plan(draft: GoalDraft): { title: string; due: string | null; milestones: Milestone[] } {
    const title = line(draft.title, 200);
    if (!title) throw new GoalError(400, en('Say what the goal is.'));
    const due = isDay(draft.due) ? draft.due : null;
    const raw = Array.isArray(draft.milestones) ? draft.milestones.filter((m) => m && typeof m === 'object' && line(m.text, 200)) : [];
    if (raw.length > GOAL.maxMilestones) throw new GoalError(400, en('A goal has at most 10 milestones.'));
    let milestones: Milestone[] = raw.map((m) => {
      const kind = (MILESTONE_KINDS as readonly string[]).includes(String(m.kind)) ? (m.kind as MilestoneKind) : 'none';
      return {
        text: line(m.text, 200),
        due: isDay(m.due) ? m.due : null,
        kind,
        status: 'todo',
        ...(kind === 'errand' && m.errand && typeof m.errand === 'object' ? { errand: { ...(typeof m.errand.template === 'string' ? { template: m.errand.template } : {}), ...(m.errand.facts && typeof m.errand.facts === 'object' ? { facts: m.errand.facts } : {}) } } : {}),
        ...(kind === 'automation' && m.automation && typeof m.automation === 'object' ? { automation: JSON.parse(JSON.stringify(m.automation).slice(0, 4000)) as Record<string, unknown> } : {}),
      };
    });
    if (!milestones.length) {
      // From the words alone (code, no model): three checkpoints spread up to the due date, else weekly.
      const today = this.#today();
      const span = due ? Math.max(3, daysBetween(today, due)) : 21;
      milestones = [en('Plan the steps and gather what you need'), en('Do the main part'), en('Finish and check it’s done')].map((text, i) => ({ text: this.#T(text), due: addDays(today, Math.round((span * (i + 1)) / 3)), kind: 'none', status: 'todo' }));
    }
    // By date (undated last); the order is the plan.
    milestones = sortTodo(milestones);
    return { title, due, milestones };
  }
  #kindWords(m: Milestone): string {
    const T = (s: string) => this.#T(s);
    if (m.kind === 'task') return T(en('a task in your Planner'));
    if (m.kind === 'reminder') return T(en('a reminder'));
    if (m.kind === 'errand') return T(en('an errand that waits for your Start'));
    if (m.kind === 'automation') return T(en('an automation, made switched off until you turn it on'));
    return '';
  }
  /** The plan in plain words (the Allow card). */
  planText(draft: GoalDraft): string {
    const p = this.plan(draft);
    const T = (s: string, x?: Record<string, unknown>) => this.#T(s, x);
    return [
      `“${p.title}”${p.due ? ` · ${T(en('by {when}'), { when: this.#day(p.due) })}` : ''}`,
      ...p.milestones.map((m, i) => `${i + 1}. ${m.text}${m.due ? ` · ${this.#day(m.due)}` : ''}${m.kind !== 'none' ? ` → ${this.#kindWords(m)}` : ''}`),
      T(en('She checks progress, nudges you before each checkpoint and sends a weekly summary. A new plan when something slips is only a proposal; anything that acts still asks you first.')),
    ].join('\n');
  }
  create(draft: GoalDraft, o: { by?: 'chat' | 'page'; conversationId?: string | null } = {}): LongGoal {
    if (o.conversationId && this.#app.store.getConversation(o.conversationId)?.private) throw new GoalError(403, en('Goals can’t be set up from a private chat.'));
    if (this.list({ open: true }).length >= GOAL.max) throw new GoalError(409, en('You have the most goals this keeps.'));
    const p = this.plan(draft);
    const iso = this.#now().toISOString();
    const data: Data = { milestones: p.milestones, history: [{ at: iso, text: o.by === 'page' ? 'Set up on the Goals page.' : 'Set up from the chat (you allowed the plan).' }], proposal: null };
    const id = Number(
      this.#db
        .prepare('INSERT INTO long_goals (title, due, status, data_json, owner, last_check, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.title, p.due, 'active', JSON.stringify(data), this.#app.member ? 'member' : 'owner', iso, iso, iso).lastInsertRowid,
    );
    const g = this.get(id)!;
    this.#settle(g);
    return this.#save(g);
  }

  // ------------------------------------------------------------ change

  update(id: number, patch: { title?: string; due?: string | null; note?: string; done?: number; undone?: number; skip?: number; addMilestone?: MilestoneDraft; milestoneDue?: { index: number; due: string | null } }, o: { by: 'model' | 'person' }): LongGoal {
    const g = this.#must(id);
    const who = o.by === 'person' ? 'You' : 'Sara';
    if (patch.note && line(patch.note, 300)) this.#log(g, `${who}: ${line(patch.note, 300)}`);
    if (patch.title && line(patch.title, 200)) g.title = line(patch.title, 200);
    if (patch.due !== undefined) g.due = isDay(patch.due) ? patch.due : null;
    const at = (i: number | undefined) => (typeof i === 'number' && Number.isInteger(i) ? g.milestones[i] : undefined);
    const d = at(patch.done);
    if (d && d.status !== 'done') {
      d.status = 'done';
      d.doneAt = this.#now().toISOString();
      this.#log(g, `${who} ticked off: ${d.text}`);
    }
    const u = at(patch.undone);
    if (u && u.status !== 'todo') {
      u.status = 'todo';
      delete u.doneAt;
      if (g.status === 'done') g.status = 'active';
      this.#log(g, `${who} reopened: ${u.text}`);
    }
    const s = at(patch.skip);
    if (s && s.status === 'todo') {
      s.status = 'skipped';
      this.#log(g, `${who} skipped: ${s.text}`);
    }
    if (patch.addMilestone && g.milestones.length < GOAL.maxMilestones) {
      const m = this.plan({ title: g.title, milestones: [patch.addMilestone] }).milestones[0];
      if (m && line(patch.addMilestone.text, 200)) {
        g.milestones.push(m);
        g.milestones = sortTodo(g.milestones);
        if (g.status === 'done') g.status = 'active';
        this.#log(g, `${who} added: ${m.text}`);
      }
    }
    const md = patch.milestoneDue ? at(patch.milestoneDue.index) : undefined;
    if (md && patch.milestoneDue) {
      md.due = isDay(patch.milestoneDue.due) ? patch.milestoneDue.due : null;
      delete md.slipAt;
      this.#moveLink(md);
      this.#log(g, `${who} moved “${md.text}” to ${md.due ? this.#day(md.due) : 'no date'}.`);
    }
    if (g.status === 'active') this.#settle(g);
    return this.#save(g);
  }
  pause(id: number): LongGoal {
    const g = this.#must(id);
    if (g.status !== 'active') return g;
    g.status = 'paused';
    this.#log(g, 'Paused.');
    return this.#save(g);
  }
  resume(id: number): LongGoal {
    const g = this.#must(id);
    if (g.status !== 'paused') return g;
    g.status = 'active';
    this.#log(g, 'Going again.');
    this.#settle(g);
    return this.#save(g);
  }
  stop(id: number): LongGoal {
    const g = this.#must(id);
    if (g.status === 'done' || g.status === 'stopped') return g;
    g.status = 'stopped';
    g.proposal = null;
    this.#log(g, 'Stopped. What it started (tasks, reminders, errands, automations) stays where it is.');
    return this.#save(g);
  }
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM long_goals WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------------ proposals (only the person applies one)

  accept(id: number, o: { by: 'model' | 'person' }): LongGoal {
    if (o.by !== 'person') throw new GoalError(403, en('Only you can use a new plan.'));
    const g = this.#must(id);
    const p = g.proposal;
    if (!p) throw new GoalError(409, en('There is no new plan to use.'));
    for (const mv of p.moves) {
      const m = g.milestones[mv.index];
      if (!m || m.status !== 'todo') continue;
      m.due = mv.to;
      delete m.slipAt;
      delete m.nudged;
      if (p.retry && mv.index === p.index) delete m.link;
      else this.#moveLink(m);
    }
    if (p.due) g.due = p.due.to;
    g.proposal = null;
    this.#log(g, `You used the new plan${p.due ? ` (the goal’s date is now ${this.#day(p.due.to)})` : ''}.`);
    if (g.status === 'active') this.#settle(g);
    return this.#save(g);
  }
  dismiss(id: number): LongGoal {
    const g = this.#must(id);
    if (!g.proposal) return g;
    g.proposal = null;
    this.#log(g, 'You kept the old plan.');
    return this.#save(g);
  }

  // ------------------------------------------------------------ links (their own engines)

  /** Starts the current milestone's thing (once), through its own engine. */
  #start(g: LongGoal, m: Milestone): void {
    if (m.link || m.kind === 'none' || m.status !== 'todo') return;
    const app = this.#app;
    try {
      if (m.kind === 'task' && app.planner) {
        const t = app.planner.addTask({ title: m.text, ...(m.due ? { dueAt: this.#at(m.due, 17).toISOString() } : {}), notes: this.#T(en('For your goal “{goal}”.'), { goal: g.title }) });
        m.link = { kind: 'task', id: t.id };
      } else if (m.kind === 'reminder' && app.planner) {
        const when = m.due ? this.#at(m.due, 9) : null;
        if (when && when.getTime() > this.#now().getTime()) {
          const r = app.planner.addReminder({ text: this.#T(en('For your goal “{goal}”: {step}'), { goal: g.title, step: m.text }), dueAt: when.toISOString(), conversationId: g.conversationId });
          m.link = { kind: 'reminder', id: r.id };
        }
      } else if (m.kind === 'errand') {
        const e = errandsFor(app).start({ goal: m.text, ...(m.due ? { deadline: m.due } : {}), ...(m.errand?.template ? { template: m.errand.template } : {}), ...(m.errand?.facts ? { facts: m.errand.facts } : {}) }, { by: 'page' });
        m.link = { kind: 'errand', id: e.id };
        this.#log(g, `Planned an errand for “${m.text}”: it waits for your Start on the Errands page.`);
      } else if (m.kind === 'automation' && app.automations && m.automation) {
        const a = app.automations.create(m.automation, { by: 'chat' });
        app.automations.setEnabled(a.id, false);
        m.link = { kind: 'automation', id: a.id };
        this.#log(g, `Made the automation “${a.name}” for “${m.text}”, switched off until you turn it on.`);
      }
    } catch (err) {
      this.#log(g, `Couldn’t start “${m.text}”: ${(err as Error).message}`);
      m.kind = 'none';
    }
  }
  /** A milestone's date moved: its task or reminder moves too; its errand gets the new deadline. */
  #moveLink(m: Milestone): void {
    const app = this.#app;
    const l = m.link;
    if (!l || !m.due) return;
    try {
      if (l.kind === 'task') app.planner?.updateTask(l.id, { dueAt: this.#at(m.due, 17).toISOString() });
      else if (l.kind === 'errand') errandsFor(app).update(l.id, { deadline: m.due }, { by: 'person' });
      else if (l.kind === 'reminder' && app.planner) {
        const r = app.planner.reminder(l.id);
        if (r && r.status === 'pending') {
          app.planner.cancelReminder(l.id);
          const n = app.planner.addReminder({ text: r.text, dueAt: this.#at(m.due, 9).toISOString(), conversationId: r.conversationId ?? null });
          m.link = { kind: 'reminder', id: n.id };
        }
      }
    } catch {
      /* it was removed in its own place */
    }
  }
  /** 'done' | 'stopped' | undefined: what the linked thing says. */
  #linkState(m: Milestone): 'done' | 'stopped' | undefined {
    const l = m.link;
    if (!l) return undefined;
    try {
      if (l.kind === 'task') return this.#app.planner?.task(l.id)?.status === 'done' ? 'done' : undefined;
      if (l.kind === 'errand') {
        const e = errandsFor(this.#app).get(l.id);
        return e?.status === 'done' ? 'done' : e?.status === 'stopped' ? 'stopped' : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  /** Linked things that finished tick their milestone off; the next one starts; all done ends the goal. */
  #settle(g: LongGoal): void {
    for (const m of g.milestones) {
      if (m.status === 'todo' && this.#linkState(m) === 'done') {
        m.status = 'done';
        m.doneAt = this.#now().toISOString();
        this.#log(g, `Done: ${m.text}`);
      }
    }
    if (g.status === 'active' && g.milestones.length && g.milestones.every((m) => m.status !== 'todo')) {
      g.status = 'done';
      g.proposal = null;
      this.#log(g, 'Done: every milestone is finished.');
      const title = this.#T(en('Goal done: {goal}'), { goal: clip(g.title, 60) });
      const body = this.#T(en('All {n} milestones are finished.'), { n: g.milestones.filter((m) => m.status === 'done').length });
      this.#say(g, `${title}\n${body}`);
      void this.#push(g, title, body);
      return;
    }
    const cur = current(g);
    if (cur) this.#start(g, cur);
  }

  // ------------------------------------------------------------ words out

  #say(g: LongGoal, text: string): void {
    try {
      if (!g.conversationId || !this.#app.store.getConversation(g.conversationId)) {
        g.conversationId = this.#app.store.createConversation({ title: clip(`Goal: ${g.title}`, 60), channel: 'goal', channelKey: String(g.id) }).id;
      }
      // ALERTDEST: nudges and weekly summaries go where the person chose (default: the goal's own chat).
      const own = g.conversationId;
      postAlert(this.#app, 'goals', { item: `goal:${g.id}`, origin: () => own, role: 'assistant', content: text, meta: { goal: { id: g.id } }, reason: 'reminder' });
    } catch {
      /* the chat was deleted */
    }
  }
  async #push(g: LongGoal, title: string, body: string): Promise<void> {
    if ((this.#o.quiet ? this.#o.quiet() : quietNow(this.#app)) || privateLocalOn()) return;
    const n = this.#o.notify ?? ((a: string, b: string, c: string, d: string) => this.#app.push?.notifyOwner(a, b, c, d) ?? Promise.resolve());
    await n(title, body, g.conversationId ?? '', `goal-${g.id}`).catch(() => undefined);
  }

  // ------------------------------------------------------------ the tick

  /** The reminder tick: each active goal is checked at most once an hour. Returns the goals checked. */
  due(now: Date = this.#now()): number {
    if (privateLocalOn()) return 0;
    let open: LongGoal[];
    try {
      open = this.list({ open: true });
    } catch {
      return 0;
    }
    let checked = 0;
    for (const g of open) {
      if (g.status !== 'active') continue;
      if (g.lastCheck && now.getTime() - Date.parse(g.lastCheck) < GOAL.checkEveryMs) continue;
      try {
        this.#check(g, now);
      } catch (err) {
        console.warn(`goal ${g.id}: ${(err as Error).message}`);
      }
      checked++;
    }
    return checked;
  }
  #check(g: LongGoal, now: Date): void {
    g.lastCheck = now.toISOString();
    this.#settle(g);
    if (g.status !== 'active') {
      this.#save(g);
      return;
    }
    const today = this.#today(now);
    if (!g.proposal) this.#slip(g, today);
    this.#nudge(g, today);
    if (now.getTime() - Date.parse(g.lastWeekly ?? g.createdAt) >= GOAL.weekMs) {
      g.lastWeekly = now.toISOString();
      const title = this.#T(en('This week: {goal}'), { goal: clip(g.title, 60) });
      const body = this.weeklyText(g, today);
      this.#log(g, 'Weekly summary sent.');
      this.#say(g, `${title}\n${body}`);
      void this.#push(g, title, clip(body, 300));
    }
    this.#save(g);
  }
  /** A missed checkpoint or a stopped errand → a proposed new plan (nothing moves until the person says so). */
  #slip(g: LongGoal, today: string): void {
    const T = (s: string, x?: Record<string, unknown>) => this.#T(s, x);
    const i = g.milestones.findIndex((m) => m.status === 'todo' && ((m.due && m.due < today && m.slipAt !== m.due) || (this.#linkState(m) === 'stopped' && m.slipAt !== `stopped:${m.link?.id}`)));
    if (i < 0) return;
    const m = g.milestones[i]!;
    const stopped = this.#linkState(m) === 'stopped';
    m.slipAt = stopped ? `stopped:${m.link?.id}` : (m.due ?? undefined);
    let p: Proposal;
    if (stopped) {
      const to = maxDay(m.due ?? today, addDays(today, GOAL.slipDays + 1));
      p = { why: T(en('Its errand stopped: “{step}”. New plan: plan a fresh errand for it, due {when}.'), { step: m.text, when: this.#day(to) }), at: this.#now().toISOString(), index: i, moves: [{ index: i, from: m.due, to }], retry: true };
    } else {
      const to = addDays(today, GOAL.slipDays);
      const shift = daysBetween(m.due!, to);
      const moves: Proposal['moves'] = [];
      const fits = !g.due || to <= g.due;
      g.milestones.forEach((x, j) => {
        if (j < i || x.status !== 'todo' || !x.due) return;
        let nd = j === i ? to : addDays(x.due, shift);
        if (fits && g.due && nd > g.due) nd = g.due;
        if (j === i || nd !== x.due) moves.push({ index: j, from: x.due, to: nd });
      });
      p = { why: T(en('The checkpoint “{step}” was due {when} and isn’t done yet.'), { step: m.text, when: this.#day(m.due) }), at: this.#now().toISOString(), index: i, moves, ...(!fits && g.due ? { due: { from: g.due, to: addDays(g.due, shift) } } : {}) };
    }
    g.proposal = p;
    this.#log(g, `Proposed a new plan: ${p.why}`);
    const title = this.#T(en('A new plan for {goal}?'), { goal: clip(g.title, 60) });
    const body = [p.why, ...p.moves.map((x) => `${g.milestones[x.index]!.text}: ${this.#day(x.from)} → ${this.#day(x.to)}`), ...(p.due ? [T(en('The goal’s date: {from} → {to}'), { from: this.#day(p.due.from), to: this.#day(p.due.to) })] : []), T(en('Open Goals to use it or keep the old plan.'))].join('\n');
    this.#say(g, `${title}\n${body}`);
    void this.#push(g, title, clip(body, 300));
  }
  #nudge(g: LongGoal, today: string): void {
    const m = current(g);
    if (!m?.due || m.nudged === m.due) return;
    const left = daysBetween(today, m.due);
    if (left < 0 || left > 1) return;
    m.nudged = m.due;
    const title = this.#T(en('Checkpoint: {goal}'), { goal: clip(g.title, 60) });
    const body = left === 0 ? this.#T(en('Due today: {step}'), { step: m.text }) : this.#T(en('Due tomorrow: {step}'), { step: m.text });
    this.#log(g, `Nudged: ${m.text} (${this.#day(m.due)}).`);
    this.#say(g, `${title}\n${body}`);
    void this.#push(g, title, body);
  }

  // ------------------------------------------------------------ words and the Today tile

  progress(g: LongGoal): { done: number; total: number; pct: number; next: Milestone | undefined } {
    const total = g.milestones.filter((m) => m.status !== 'skipped').length;
    const done = g.milestones.filter((m) => m.status === 'done').length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0, next: current(g) };
  }
  weeklyText(g: LongGoal, today: string = this.#today()): string {
    const T = (s: string, x?: Record<string, unknown>) => this.#T(s, x);
    const p = this.progress(g);
    const week = addDays(today, -7);
    const doneWeek = g.milestones.filter((m) => m.status === 'done' && m.doneAt && m.doneAt.slice(0, 10) >= week).map((m) => m.text);
    const late = p.next?.due && p.next.due < today;
    return [
      T(en('{done} of {total} milestones done.'), { done: p.done, total: p.total }),
      doneWeek.length ? T(en('Finished this week: {list}'), { list: doneWeek.join(' · ') }) : T(en('Nothing finished this week.')),
      p.next ? `${T(en('Next:'))} ${p.next.text}${p.next.due ? ` (${this.#day(p.next.due)})` : ''}` : '',
      g.due ? (late ? T(en('Behind: a checkpoint was missed.')) : T(en('Due {when}.'), { when: this.#day(g.due) })) : '',
    ].filter(Boolean).join('\n');
  }
  statusText(g: LongGoal): string {
    const p = this.progress(g);
    const mark = { todo: ' ', done: 'x', skipped: '-' } as const;
    const lines = [`Goal #${g.id} “${g.title}” · ${g.status}${g.due ? ` · by ${g.due}` : ''} · ${p.done} of ${p.total} milestones`];
    g.milestones.forEach((m, i) => lines.push(`${i + 1}. [${mark[m.status]}] ${m.text}${m.due ? ` · ${m.due}` : ''}${m.link ? ` · ${m.link.kind} #${m.link.id}` : ''}`));
    if (g.proposal) lines.push(`A new plan waits for ${this.#app.settings.get().ownerName || 'them'} on the Goals page: ${g.proposal.why}`);
    for (const h of g.history.slice(-5)) lines.push(`- ${h.at.slice(0, 10)} ${h.text}`);
    return lines.join('\n');
  }
  listText(all = false): string {
    const list = this.list(all ? {} : { open: true });
    if (!list.length) return all ? 'No goals yet.' : 'No open goals.';
    return list
      .map((g) => {
        const p = this.progress(g);
        return `#${g.id} ${g.status} · ${g.title} · ${p.done} of ${p.total} milestones${g.due ? ` · by ${g.due}` : ''}${p.next ? ` · next: ${p.next.text}` : ''}${g.proposal ? ' · a new plan waits' : ''}`;
      })
      .join('\n');
  }
  /** Today: active goals with progress and the next step; the ones with a new plan first. */
  todayTile(): { proposals: number; items: { id: number; title: string; due: string | null; pct: number; done: number; total: number; next: string | null; nextDue: string | null; proposal: boolean }[] } | undefined {
    const open = this.list({ open: true }).filter((g) => g.status === 'active');
    if (!open.length) return undefined;
    const items = open
      .sort((a, b) => Number(!!b.proposal) - Number(!!a.proposal) || (current(a)?.due ?? '9999').localeCompare(current(b)?.due ?? '9999'))
      .slice(0, 4)
      .map((g) => {
        const p = this.progress(g);
        return { id: g.id, title: g.title, due: g.due, pct: p.pct, done: p.done, total: p.total, next: p.next?.text ?? null, nextDue: p.next?.due ?? null, proposal: !!g.proposal };
      });
    return { proposals: open.filter((g) => g.proposal).length, items };
  }
}

/** The first milestone still to do (the plan's order is its order). */
function current(g: LongGoal): Milestone | undefined {
  return g.milestones.find((m) => m.status === 'todo');
}
function sortTodo(ms: Milestone[]): Milestone[] {
  return ms.map((m, i) => ({ m, i })).sort((a, b) => (a.m.due ?? '9999').localeCompare(b.m.due ?? '9999') || a.i - b.i).map((x) => x.m);
}

/** This space's goals (made on first use; members get their own in their own store). */
export function longGoalsFor(app: AppContext): LongGoals {
  app.longGoals ??= new LongGoals(app, app.store.db);
  return app.longGoals;
}

// ROADMAP_T T5 (docs/REMOTE_REPAIR.md): remote repair between linked servers. Built on the S9b support link
// (src/support.ts: the S9a link's Ed25519 keys, signed requests, the help log): no second link, no second code.
//
//   helped (Hank)  "Ask Sam to fix something" → a fix pass (1 h / 1 day / 7 days) with a scope:
//                    look  = look only, each = fix with my OK for every step, pass = fix within this pass
//                  → signed `request` to Sam; Sam's server shows a notice (T4 popup + push) with Accept/Decline.
//   helper (Sam)   with an accepted pass: `look` (the S9b report + Hank's T1 problems), `plan` (steps), `stop`.
//   helped         checks every step itself, then runs it through ITS OWN engines: T1 fix ids (repair.fix),
//                  T1 level 2 learning (repair.learn), S9b allowlisted settings (cleanChange) recorded as T1
//                  rows with an undo, T3 code change requests (selfCode.start: Hank's server prepares and tests
//                  the change with its own model and caps; only the request text crosses). Level 3 always asks.
//                  Live `status` events go back to Sam after every step; Stop (either side) ends after the
//                  current step and undoes nothing; Undo stays offered for each undoable step.
// Wire: POST /msg/v1/repair/<op>, signed like S9b with the scope word 'repair' (a 'support' signature never
// passes here, nor the other way round). Owner only: members, kid mode and the demo have no Messenger.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { en, fill } from './i18n.ts';
import type { Messenger } from './messages.ts';
import { privateLocalOn } from './net-guard.ts';
import { neverTouch, recordRepair, type Problem, type Repair, type RepairRun } from './repair.ts';
import { selfCodeOf } from './self-code.ts';
import type { Settings } from './settings.ts';
import { cleanChange, patchFor, SUPPORT_ALLOW, SUPPORT_HOURS, SupportError, supportOf, valueAt, type SupportLink } from './support.ts';

export const REPAIR_SCOPES = ['look', 'each', 'pass'] as const;
export type RepairScope = (typeof REPAIR_SCOPES)[number];
export const STEP_KINDS = ['fix', 'learn', 'setting', 'code'] as const;
export const MAX_STEPS = 10;
const TEXT = 1000;
const FINAL = new Set(['done', 'failed', 'declined', 'skipped', 'refused']);

export type StepStatus = 'waiting' | 'ready' | 'running' | 'done' | 'failed' | 'declined' | 'skipped' | 'refused';
export interface PlanStep {
  kind: (typeof STEP_KINDS)[number];
  problem?: string;
  what?: string;
  body?: string;
  path?: string;
  value?: unknown;
  request?: string;
}
export interface StepView extends PlanStep {
  n: number;
  /** Plain words: an English key with {params} (the page translates it). */
  title: string;
  params?: Record<string, string | number>;
  status: StepStatus;
  detail?: string;
  detailParams?: Record<string, string | number>;
  run?: number;
  undoable: boolean;
  undone: boolean;
  change?: number;
}
export interface FixPassView {
  id: string;
  link: string;
  peer: string;
  side: 'given' | 'held';
  scope: RepairScope;
  problem: string;
  hours: number;
  status: 'draft' | 'asked' | 'active' | 'declined' | 'revoked';
  createdAt: string;
  expiresAt: string;
  active: boolean;
}
export interface PlanView {
  id: string;
  peerId: string;
  link: string;
  peer: string;
  side: 'in' | 'out';
  pass: string;
  scope: RepairScope;
  note: string;
  status: 'waiting' | 'running' | 'stopping' | 'stopped' | 'done' | 'failed';
  approved: boolean;
  reason: string;
  report: string;
  steps: StepView[];
  createdAt: string;
  updatedAt: string;
}

/** What the helped side's engines are (the real server's, or a test's). */
export interface HelpedDeps {
  repair(): Repair | undefined;
  selfCode(): { start(request: string): { id: number } } | undefined;
  settings: { get(): Settings; update(p: Partial<Settings>): unknown };
  record(run: Omit<RepairRun, 'id' | 'at' | 'undone'>): RepairRun | undefined;
  privateLocal(): boolean;
  notify(title: string, body: string, link: string): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rr_passes (id TEXT PRIMARY KEY, link TEXT NOT NULL, side TEXT NOT NULL, peer TEXT NOT NULL, scope TEXT NOT NULL, problem TEXT NOT NULL DEFAULT '', hours INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, asked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rr_plans (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, link TEXT NOT NULL, side TEXT NOT NULL, peer TEXT NOT NULL, pass TEXT NOT NULL, scope TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', report TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const bad = (why: string, params?: Record<string, unknown>) => new SupportError(400, fill(why, params));

/** The shape of one step (both sides): only the four kinds, plain values, allowlisted setting paths. */
export function stepShape(x: unknown, n: number): PlanStep {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const at = { n: n + 1 };
  switch (o.kind) {
    case 'fix': {
      const problem = clip(o.problem, 120);
      if (!/^[\w.:@/+-]{3,120}$/.test(problem)) throw bad(en('Step {n}: pick a problem from the list.'), at);
      if (problem.startsWith('setting:') && neverTouch(problem.slice(8))) throw bad(en('Step {n}: self-repair never changes that.'), at);
      return { kind: 'fix', problem };
    }
    case 'learn': {
      const what = clip(o.what, 200);
      if (!what) throw bad(en('Step {n}: say what she should learn.'), at);
      return { kind: 'learn', what, ...(o.body ? { body: String(o.body).slice(0, 8000) } : {}) };
    }
    case 'setting': {
      const path = String(o.path ?? '');
      if (!Object.hasOwn(SUPPORT_ALLOW, path) || neverTouch(path)) throw bad(en('Step {n}: that setting can’t be changed through a fix pass.'), at);
      if (o.value === undefined) throw bad(en('Step {n}: that value is not valid for this setting.'), at);
      return { kind: 'setting', path, value: o.value };
    }
    case 'code': {
      const request = clip(o.request, 2000);
      if (request.length < 8) throw bad(en('Step {n}: describe the code change in a sentence.'), at);
      return { kind: 'code', request };
    }
    default:
      throw bad(en('Step {n}: only fixes from the problem list, learning a skill, the allowed settings and code change requests can be in a plan. No commands, files, remote control or passwords.'), at);
  }
}

export class RemoteRepair {
  readonly #db: DatabaseSync;
  readonly #sp: SupportLink;
  readonly #m: Messenger;
  readonly #now: () => Date;
  readonly deps: HelpedDeps;
  #closed = false;
  readonly #running = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(o: { dataDir: string; messenger: Messenger; support: SupportLink; now: () => Date; deps: HelpedDeps }) {
    this.#db = new DatabaseSync(join(o.dataDir, 'remote-repair.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#sp = o.support;
    this.#m = o.messenger;
    this.#now = o.now;
    this.deps = o.deps;
    o.messenger.whenClosed(() => this.close());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
  get support(): SupportLink {
    return this.#sp;
  }
  /** Waits for running plans and status sends (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size || this.#pending.size) await Promise.allSettled([...this.#running.values(), ...this.#pending]);
  }
  #iso(): string {
    return this.#now().toISOString();
  }
  #track<T>(p: Promise<T>): Promise<T> {
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p)).catch(() => undefined);
    return p;
  }
  #log(link: string, peer: string, side: 'helper' | 'helped', kind: string, detail = ''): void {
    this.#sp.log(link, peer, side, `repair-${kind}`, detail);
  }
  #audit(action: string, o: { who?: string; outcome: 'ok' | 'refused' | 'failed' | 'pending'; target?: string; content?: string }): void {
    audit({ action: `remote-repair.${action}`, who: o.who ?? 'owner', role: o.who ? 'system' : 'owner', channel: 'repair-link', outcome: o.outcome, ...(o.target ? { target: o.target } : {}), ...(o.content ? { content: o.content.slice(0, 300) } : {}) });
  }
  #changed(link: string): void {
    this.#sp.onChange?.(link);
  }

  // ---- passes --------------------------------------------------------------------------------------
  #passView(r: Record<string, unknown>): FixPassView {
    const expiresAt = String(r.expires_at);
    const status = String(r.status) as FixPassView['status'];
    return { id: String(r.id), link: String(r.link), peer: String(r.peer), side: String(r.side) as 'given' | 'held', scope: String(r.scope) as RepairScope, problem: String(r.problem ?? ''), hours: Number(r.hours), status, createdAt: String(r.created_at), expiresAt, active: status === 'active' && expiresAt > this.#iso() };
  }
  #pass(id: string): FixPassView | undefined {
    const r = this.#db.prepare('SELECT * FROM rr_passes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.#passView(r) : undefined;
  }
  passes(side: 'given' | 'held'): FixPassView[] {
    return (this.#db.prepare('SELECT * FROM rr_passes WHERE side = ? ORDER BY created_at DESC LIMIT 50').all(side) as Record<string, unknown>[]).map((r) => this.#passView(r));
  }
  /** The valid (accepted, not expired, not revoked) fix pass on a link. Private local mode pauses given passes. */
  activePass(link: string, side: 'given' | 'held'): (FixPassView & { asked: boolean }) | undefined {
    if (side === 'given' && this.deps.privateLocal()) return undefined;
    const r = this.#db.prepare("SELECT * FROM rr_passes WHERE link = ? AND side = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(link, side, this.#iso()) as Record<string, unknown> | undefined;
    return r ? { ...this.#passView(r), asked: Boolean(r.asked) } : undefined;
  }
  markAsked(passId: string): void {
    this.#db.prepare('UPDATE rr_passes SET asked = 1 WHERE id = ?').run(passId);
  }
  #privateLocal(): void {
    if (this.deps.privateLocal()) throw new SupportError(409, en('Private local mode is on ("Nothing leaves this computer"), so a friend’s Sara can’t look at or fix this server. Turn it off under Privacy & system first.'));
  }

  /** Helped: "can you have Sam fix it" from a chat. Only a card on this side; nothing is sent yet. */
  draft(link: string, problem: unknown): FixPassView {
    this.#privateLocal();
    const p = this.#sp.peer(link);
    this.#db.prepare("DELETE FROM rr_passes WHERE link = ? AND side = 'given' AND status = 'draft'").run(link);
    const id = randomUUID();
    const now = this.#iso();
    this.#db.prepare('INSERT INTO rr_passes (id, link, side, peer, scope, problem, hours, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, link, 'given', p.name, 'each', clip(problem, TEXT), 24, 'draft', now, now);
    this.#changed(link);
    return this.#pass(id)!;
  }
  discardDraft(id: string): void {
    const r = this.#pass(id);
    if (!r || r.side !== 'given' || r.status !== 'draft') throw new SupportError(404, en('Not found'));
    this.#db.prepare('DELETE FROM rr_passes WHERE id = ?').run(id);
    this.#changed(r.link);
  }

  /** Helped: send the request (the card's OK). Ends any earlier fix pass on that link. */
  async request(link: string, o: { problem?: unknown; hours?: unknown; scope?: unknown; draft?: unknown }): Promise<FixPassView> {
    const h = Number(o.hours);
    if (!SUPPORT_HOURS.includes(h as 1)) throw bad(en('A fix pass lasts 1 hour, 1 day or 7 days.'));
    const scope = String(o.scope ?? '') as RepairScope;
    if (!REPAIR_SCOPES.includes(scope)) throw bad(en('Pick what they may do: look only, fix with your OK each time, or fix within this pass.'));
    this.#privateLocal();
    const p = this.#sp.peer(link);
    const now = this.#iso();
    const problem = clip(o.problem, TEXT);
    const expiresAt = new Date(this.#now().getTime() + h * 3_600_000).toISOString();
    this.#db.prepare("UPDATE rr_passes SET status = 'revoked' WHERE link = ? AND side = 'given' AND status IN ('asked', 'active')").run(link);
    const draft = o.draft ? this.#pass(String(o.draft)) : undefined;
    const id = draft && draft.status === 'draft' && draft.link === link ? draft.id : randomUUID();
    this.#db.prepare("DELETE FROM rr_passes WHERE link = ? AND side = 'given' AND status = 'draft' AND id <> ?").run(link, id);
    this.#db.prepare('INSERT OR REPLACE INTO rr_passes (id, link, side, peer, scope, problem, hours, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, link, 'given', p.name, scope, problem, h, 'asked', now, expiresAt);
    try {
      await this.#sp.call(link, 'request', { pass: id, expiresAt, scope, problem }, 'repair');
    } catch (err) {
      this.#db.prepare("UPDATE rr_passes SET status = 'revoked' WHERE id = ?").run(id);
      throw err;
    }
    this.#log(link, p.name, 'helped', 'request', `${scope}, ${h} h`);
    this.#audit('request', { outcome: 'pending', target: `link:${p.name}`, content: scope });
    this.#changed(link);
    return this.#pass(id)!;
  }

  /** Either side ends a pass; the other side is told (best effort: the helped side is the one that checks). */
  async revoke(id: string): Promise<void> {
    const r = this.#pass(id);
    if (!r || r.status === 'draft') throw new SupportError(404, en('Not found'));
    if (r.status === 'asked' || r.status === 'active') this.#db.prepare("UPDATE rr_passes SET status = 'revoked' WHERE id = ?").run(id);
    this.#log(r.link, r.peer, r.side === 'given' ? 'helped' : 'helper', 'revoke');
    this.#audit('revoke', { outcome: 'ok', target: `link:${r.peer}` });
    await this.#sp.call(r.link, 'revoke', { pass: id }, 'repair').catch(() => null);
    this.#changed(r.link);
  }

  /** Helper: Accept or Decline a request. */
  async answer(id: string, accept: boolean): Promise<FixPassView> {
    const r = this.#pass(id);
    if (!r || r.side !== 'held') throw new SupportError(404, en('Not found'));
    if (r.status !== 'asked') throw new SupportError(409, en('Already answered.'));
    if (r.expiresAt <= this.#iso()) throw new SupportError(409, en('That request has ended.'));
    await this.#sp.call(r.link, accept ? 'accept' : 'decline', { pass: id }, 'repair');
    this.#db.prepare('UPDATE rr_passes SET status = ? WHERE id = ?').run(accept ? 'active' : 'declined', id);
    this.#log(r.link, r.peer, 'helper', accept ? 'accept' : 'decline');
    this.#audit(accept ? 'accept' : 'decline', { outcome: 'ok', target: `link:${r.peer}` });
    this.#changed(r.link);
    return this.#pass(id)!;
  }

  // ---- peer ops (already signature-checked by the route) --------------------------------------------
  /** Helper side: a request arrived. A prominent notice (T4 popup + push) with Accept/Decline in the chat. */
  heldRequest(link: string, name: string, b: Record<string, unknown>): void {
    const id = clip(b.pass, 64);
    const scope = String(b.scope) as RepairScope;
    const t = Date.parse(String(b.expiresAt ?? ''));
    if (!id || !REPAIR_SCOPES.includes(scope) || !Number.isFinite(t)) throw bad('bad request');
    const expiresAt = new Date(Math.min(t, this.#now().getTime() + 168 * 3_600_000)).toISOString();
    const hours = Math.max(1, Math.round((t - this.#now().getTime()) / 3_600_000));
    this.#db.prepare("UPDATE rr_passes SET status = 'revoked' WHERE link = ? AND side = 'held' AND status IN ('asked', 'active')").run(link);
    this.#db.prepare('INSERT OR REPLACE INTO rr_passes (id, link, side, peer, scope, problem, hours, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, link, 'held', name, scope, clip(b.problem, TEXT), hours, 'asked', this.#iso(), expiresAt);
    this.#log(link, name, 'helper', 'request', scope);
    this.#audit('request', { who: `link:${name}`, outcome: 'pending' });
    this.#m.onNotify?.(name, en('Asks you to fix something on their Sara. Open Messages to accept or decline.'), link);
    this.#changed(link);
  }
  /** Helped side: the helper accepted or declined. */
  answered(link: string, name: string, b: Record<string, unknown>, accept: boolean): void {
    const r = this.#db.prepare("SELECT * FROM rr_passes WHERE id = ? AND link = ? AND side = 'given'").get(clip(b.pass, 64), link) as Record<string, unknown> | undefined;
    if (!r || r.status !== 'asked') throw new SupportError(409, 'not asked');
    if (String(r.expires_at) <= this.#iso()) throw new SupportError(409, 'ended');
    this.#db.prepare('UPDATE rr_passes SET status = ? WHERE id = ?').run(accept ? 'active' : 'declined', String(r.id));
    this.#log(link, name, 'helped', accept ? 'accept' : 'decline');
    this.#audit(accept ? 'accept' : 'decline', { who: `link:${name}`, outcome: 'ok' });
    this.deps.notify(name, accept ? en('Accepted your fix pass. Their Sara can look now; you see each step here.') : en('Declined your fix pass.'), link);
    this.#changed(link);
  }
  heldRevoked(link: string, name: string, b: Record<string, unknown>): void {
    this.#db.prepare("UPDATE rr_passes SET status = 'revoked' WHERE id = ? AND link = ? AND status IN ('asked', 'active')").run(clip(b.pass, 64), link);
    this.#log(link, name, 'helped', 'revoke');
    this.#changed(link);
  }

  // ---- looking (helped side) ------------------------------------------------------------------------
  /** This server's T1 problems (fresh), in plain words. */
  async problems(): Promise<Pick<Problem, 'id' | 'level' | 'severity' | 'text' | 'params' | 'fixable' | 'area' | 'fix'>[]> {
    const rep = this.deps.repair();
    if (!rep) return [];
    const ps = await rep.detect().catch(() => rep.problems());
    return ps.map((p) => ({ id: p.id, level: p.level, severity: p.severity, text: p.text, params: p.params, fixable: p.fixable, ...(p.area ? { area: p.area } : {}), ...(p.fix ? { fix: p.fix } : {}) }));
  }
  /** What a plan may contain on this server. */
  can(): { code: boolean; settings: string[]; kinds: readonly string[] } {
    return { code: Boolean(this.deps.selfCode()), settings: Object.keys(SUPPORT_ALLOW), kinds: STEP_KINDS };
  }

  // ---- plans (helped side) --------------------------------------------------------------------------
  /** Every step is checked here, against this server's own engines and settings; one bad step refuses the plan. */
  async validate(raw: unknown): Promise<StepView[]> {
    if (!Array.isArray(raw) || !raw.length) throw bad(en('A plan needs at least one step.'));
    if (raw.length > MAX_STEPS) throw bad(en('A plan has at most {n} steps.'), { n: MAX_STEPS });
    const rep = this.deps.repair();
    let known: Problem[] | undefined;
    const out: StepView[] = [];
    for (const [n, x] of raw.entries()) {
      const s = stepShape(x, n);
      const at = { n: n + 1 };
      const base = { ...s, n, status: 'waiting' as StepStatus, undoable: false, undone: false };
      if (s.kind === 'fix') {
        if (!rep) throw bad(en('Step {n}: self-repair is not on here.'), at);
        known ??= await rep.detect().catch(() => rep.problems());
        const p = known.find((q) => q.id === s.problem);
        if (!p || (p.level === 1 && !p.fixable)) throw bad(en('Step {n}: that problem is not on this server’s list (or only its owner can fix it).'), at);
        out.push({ ...base, title: p.text, ...(p.params ? { params: p.params } : {}) });
      } else if (s.kind === 'learn') {
        if (!rep) throw bad(en('Step {n}: self-repair is not on here.'), at);
        out.push({ ...base, title: en('Learn: {what}'), params: { what: s.what! } });
      } else if (s.kind === 'setting') {
        const c = cleanChange({ path: s.path, value: s.value }, this.deps.settings.get());
        out.push({ ...base, value: c.value, title: en('Change “{setting}” to {value}'), params: { setting: c.path, value: JSON.stringify(c.value).slice(0, 120) } });
      } else {
        if (!this.deps.selfCode()) throw bad(en('Step {n}: this install can’t change its own code (see Updates → Code changes).'), at);
        out.push({ ...base, title: en('Prepare a code change: {request}'), params: { request: s.request!.slice(0, 200) } });
      }
    }
    return out;
  }

  #planView(r: Record<string, unknown>): PlanView {
    return { id: String(r.id), peerId: String(r.peer_id), link: String(r.link), peer: String(r.peer), side: String(r.side) as 'in' | 'out', pass: String(r.pass), scope: String(r.scope) as RepairScope, note: String(r.note ?? ''), status: String(r.status) as PlanView['status'], approved: Boolean(r.approved), reason: String(r.reason ?? ''), report: String(r.report ?? ''), steps: JSON.parse(String(r.steps)) as StepView[], createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  plan(id: string): PlanView | undefined {
    const r = this.#db.prepare('SELECT * FROM rr_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.#planView(r) : undefined;
  }
  plans(): PlanView[] {
    return (this.#db.prepare('SELECT * FROM rr_plans ORDER BY created_at DESC, rowid DESC LIMIT 30').all() as Record<string, unknown>[]).map((r) => this.#planView(r));
  }
  #save(p: PlanView): void {
    this.#db.prepare('UPDATE rr_plans SET status = ?, approved = ?, reason = ?, report = ?, steps = ?, updated_at = ? WHERE id = ?').run(p.status, p.approved ? 1 : 0, p.reason, p.report, JSON.stringify(p.steps), this.#iso(), p.id);
  }

  /** Helped: a plan arrived over an accepted pass that allows fixing. */
  async received(link: string, name: string, b: Record<string, unknown>): Promise<PlanView> {
    const pass = this.activePass(link, 'given');
    if (!pass) throw new SupportError(403, 'no valid pass');
    if (pass.scope === 'look') throw new SupportError(403, en('This fix pass is for looking only.'));
    const steps = await this.validate(b.steps);
    // "Fix within this pass": one OK for the plan, but a code change (level 3) always asks on its own.
    if (pass.scope === 'pass') for (const s of steps) s.status = s.kind === 'code' ? 'waiting' : 'ready';
    const id = randomUUID();
    const now = this.#iso();
    this.#db.prepare('INSERT INTO rr_plans (id, peer_id, link, side, peer, pass, scope, note, status, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, clip(b.plan, 64), link, 'in', name, pass.id, pass.scope, clip(b.note, TEXT), 'waiting', JSON.stringify(steps), now, now);
    this.#log(link, name, 'helped', 'plan', `${steps.length}`);
    this.#audit('plan', { who: `link:${name}`, outcome: 'pending', content: steps.map((s) => s.kind).join(', ') });
    this.deps.notify(name, en('Sent a plan to fix your Sara. Open Messages to see each step and approve it.'), link);
    this.#changed(link);
    return this.plan(id)!;
  }

  #inPlan(id: string): PlanView {
    const p = this.plan(id);
    if (!p || p.side !== 'in') throw new SupportError(404, en('Not found'));
    return p;
  }
  async #needPass(p: PlanView): Promise<void> {
    const pass = this.#pass(p.pass);
    if (!pass?.active || this.deps.privateLocal()) {
      await this.#finish(p, 'stopped', en('The fix pass ended, so the rest of the plan did not run.'));
      throw new SupportError(409, en('The fix pass ended, so the rest of the plan did not run.'));
    }
  }

  /** Helped: one OK for the whole plan ("fix within this pass" only). */
  async approvePlan(id: string, approve: boolean): Promise<PlanView> {
    const p = this.#inPlan(id);
    if (p.scope !== 'pass' || p.approved || p.status !== 'waiting') throw new SupportError(409, en('Already answered.'));
    if (!approve) {
      for (const s of p.steps) if (!FINAL.has(s.status)) s.status = 'declined';
      this.#audit('plan', { outcome: 'refused', target: `link:${p.peer}` });
      await this.#finish(p, 'done', en('You declined the plan.'));
      return this.plan(id)!;
    }
    await this.#needPass(p);
    p.approved = true;
    this.#save(p);
    this.#audit('plan', { outcome: 'ok', target: `link:${p.peer}` });
    this.#start(id);
    return this.plan(id)!;
  }
  /** Helped: OK or no for one step (every step under "each"; code changes always). */
  async decideStep(id: string, n: number, approve: boolean): Promise<PlanView> {
    const p = this.#inPlan(id);
    const s = p.steps[n];
    if (!s || s.status !== 'waiting' || !['waiting', 'running'].includes(p.status)) throw new SupportError(409, en('Already answered.'));
    if (approve) await this.#needPass(p);
    s.status = approve ? 'ready' : 'declined';
    this.#save(p);
    this.#audit('step', { outcome: approve ? 'ok' : 'refused', target: `${s.kind}:${s.problem ?? s.path ?? ''}`.slice(0, 120) });
    if (!approve) this.#log(p.link, p.peer, 'helped', 'step', `${n + 1} declined`);
    this.#start(id);
    return this.plan(id)!;
  }
  /** Either side's Stop: ends after the current step; nothing is undone (Undo stays offered). */
  async stop(id: string): Promise<PlanView> {
    const p = this.plan(id);
    if (!p) throw new SupportError(404, en('Not found'));
    if (p.side === 'out') {
      await this.#sp.call(p.link, 'stop', { plan: p.id }, 'repair');
      this.#log(p.link, p.peer, 'helper', 'stop');
      this.#audit('stop', { outcome: 'ok', target: `link:${p.peer}` });
      return this.plan(id)!;
    }
    return this.#stopIn(p, 'owner');
  }
  async #stopIn(p: PlanView, who: string): Promise<PlanView> {
    if (['stopped', 'done', 'failed'].includes(p.status)) return p;
    this.#log(p.link, p.peer, 'helped', 'stop', who === 'owner' ? '' : 'by helper');
    this.#audit('stop', { ...(who === 'owner' ? {} : { who }), outcome: 'ok', target: `link:${p.peer}` });
    if (p.status === 'running') {
      p.status = 'stopping';
      this.#save(p);
      await this.#emit(p);
      return p;
    }
    await this.#finish(p, 'stopped', en('Stopped. Nothing was undone; you can undo each step here.'));
    return this.plan(p.id)!;
  }
  /** Peer op: the helper pressed Stop. */
  async stopFromPeer(link: string, name: string, b: Record<string, unknown>): Promise<void> {
    const r = this.#db.prepare("SELECT * FROM rr_plans WHERE peer_id = ? AND link = ? AND side = 'in'").get(clip(b.plan, 64), link) as Record<string, unknown> | undefined;
    if (!r) throw new SupportError(404, 'not found');
    await this.#stopIn(this.#planView(r), `link:${name}`);
  }
  /** Helped: Undo one step through T1 (exactly as a local repair). */
  async undoStep(id: string, n: number): Promise<PlanView> {
    const p = this.#inPlan(id);
    const s = p.steps[n];
    const rep = this.deps.repair();
    if (!s || !s.undoable || s.undone || !s.run || !rep) throw new SupportError(409, en('This one can’t be undone (any more).'));
    await rep.undo(s.run);
    s.undone = true;
    s.undoable = false;
    this.#save(p);
    this.#log(p.link, p.peer, 'helped', 'undo', `${n + 1}`);
    this.#audit('undo', { outcome: 'ok', target: s.problem ?? s.path ?? s.kind });
    await this.#emit(p);
    return this.plan(id)!;
  }

  readonly #again = new Set<string>();
  /** Starts the runner, or tells a running one to look again when it would stop (a new OK arrived meanwhile). */
  #start(id: string): void {
    if (this.#running.has(id)) return void this.#again.add(id);
    const job = (async () => {
      do {
        this.#again.delete(id);
        await this.#run(id);
      } while (this.#again.has(id) && !this.#closed);
    })()
      .catch((err: Error) => console.warn(`remote-repair: ${err.message}`))
      .finally(() => this.#running.delete(id));
    this.#running.set(id, job);
  }
  async #run(id: string): Promise<void> {
    for (;;) {
      if (this.#closed) return;
      const p = this.plan(id);
      if (!p || ['stopped', 'done', 'failed'].includes(p.status)) return;
      if (p.status === 'stopping') return void (await this.#finish(p, 'stopped', en('Stopped. Nothing was undone; you can undo each step here.')));
      const next = p.steps.find((s) => !FINAL.has(s.status));
      if (!next) return void (await this.#finish(p, 'done', ''));
      if (!this.#pass(p.pass)?.active || this.deps.privateLocal()) return void (await this.#finish(p, 'stopped', en('The fix pass ended, so the rest of the plan did not run.')));
      if (next.status === 'waiting' || (p.scope === 'pass' && !p.approved)) {
        if (p.status !== 'waiting') {
          p.status = 'waiting';
          this.#save(p);
          await this.#emit(p);
        }
        return;
      }
      next.status = 'running';
      p.status = 'running';
      this.#save(p);
      await this.#emit(p);
      const res = await this.#exec(p, next);
      const cur = this.plan(id)!;
      Object.assign(cur.steps[next.n]!, res);
      this.#save(cur);
      this.#log(cur.link, cur.peer, 'helped', 'step', `${next.n + 1} ${res.status}`);
      this.#audit('step', { who: `link:${cur.peer}`, outcome: res.status === 'done' ? 'ok' : res.status === 'refused' ? 'refused' : 'failed', target: `${next.kind}:${next.problem ?? next.path ?? ''}`.slice(0, 120) });
      await this.#emit(cur);
    }
  }
  /** One step through this server's own engine (checked again: settings and problems may have changed). */
  async #exec(p: PlanView, s: StepView): Promise<Partial<StepView>> {
    const by = `link:${p.peer}` as const;
    const rep = this.deps.repair();
    try {
      if (s.kind === 'fix' || s.kind === 'learn') {
        if (!rep) return { status: 'refused', detail: en('Self-repair is not on here.') };
        const runs = s.kind === 'fix' ? await rep.fix(s.problem!, { by }) : [await rep.learn({ kind: 'skill', what: s.what!, ...(s.body ? { body: s.body } : {}) }, by)];
        const run = runs[0];
        if (!run) return { status: 'skipped', detail: en('That problem is gone already.') };
        const ok = run.result === 'fixed' || run.result === 'applied';
        return { status: ok ? 'done' : run.result === 'refused' ? 'refused' : 'failed', run: run.id, undoable: run.undoable, detail: run.steps.at(-1)?.text ?? run.result, ...(run.steps.at(-1)?.params ? { detailParams: run.steps.at(-1)!.params } : {}) };
      }
      if (s.kind === 'setting') {
        const st = this.deps.settings.get();
        const c = cleanChange({ path: s.path, value: s.value }, st);
        if (neverTouch(c.path)) return { status: 'refused', detail: en('Self-repair never changes this.') };
        const before = valueAt(st, c.path);
        this.deps.settings.update(patchFor(st, [c]));
        const params = { setting: c.path, before: JSON.stringify(before).slice(0, 80), after: JSON.stringify(c.value).slice(0, 80) };
        const run = this.deps.record({ level: 1, problem: `setting:${c.path}`, title: en('Change “{setting}” to {value}'), params: { setting: c.path, value: params.after }, steps: [{ at: this.#iso(), text: en('Changed “{setting}” from {before} to {after}.'), params }], snapshot: JSON.stringify({ path: c.path, value: before ?? undefined }), result: 'applied', undoable: true, by });
        return { status: 'done', run: run?.id, undoable: Boolean(run), detail: en('Changed “{setting}” from {before} to {after}.'), detailParams: params };
      }
      const sc = this.deps.selfCode();
      if (!sc) return { status: 'refused', detail: en('This install can’t change its own code.') };
      const ch = sc.start(s.request!);
      return { status: 'done', change: ch.id, detail: en('Prepared as code change #{id}: your Sara writes and tests it herself, then it waits for your OK under Updates → Code changes.'), detailParams: { id: ch.id } };
    } catch (err) {
      return { status: err instanceof SupportError && err.status === 400 ? 'refused' : 'failed', detail: en('It did not work: {why}'), detailParams: { why: clip((err as Error).message, 200) } };
    }
  }
  async #finish(p: PlanView, status: 'done' | 'stopped' | 'failed', reason: string): Promise<void> {
    for (const s of p.steps) if (!FINAL.has(s.status)) s.status = 'skipped';
    p.status = status;
    p.reason = reason;
    p.report = reportOf(p, 'helped');
    this.#save(p);
    this.#log(p.link, p.peer, 'helped', 'done', status);
    this.#audit('done', { outcome: status === 'done' ? 'ok' : 'failed', target: `link:${p.peer}` });
    this.deps.notify(p.peer, p.report, p.link);
    await this.#emit(p);
  }
  /** Live status to the helper (signed; best effort) and the open pages on this side. */
  async #emit(p: PlanView): Promise<void> {
    this.#changed(p.link);
    if (p.side !== 'in') return;
    await this.#track(this.#sp.call(p.link, 'status', { plan: p.peerId, status: p.status, reason: p.reason, steps: p.steps.map(({ n, kind, title, params, status, detail, detailParams, undoable, undone, change }) => ({ n, kind, title, params, status, detail, detailParams, undoable, undone, change })) }, 'repair').catch(() => null));
  }

  // ---- the helper's side -------------------------------------------------------------------------------
  /** Helper: send a plan (shape checked here; the helped server checks everything again). */
  async send(link: string, raw: unknown, note: unknown): Promise<PlanView> {
    const pass = this.activePass(link, 'held');
    if (!pass) throw new SupportError(403, en('You need a valid fix pass first.'));
    if (pass.scope === 'look') throw new SupportError(403, en('This fix pass is for looking only.'));
    if (!Array.isArray(raw) || !raw.length) throw bad(en('A plan needs at least one step.'));
    if (raw.length > MAX_STEPS) throw bad(en('A plan has at most {n} steps.'), { n: MAX_STEPS });
    const steps = raw.map((x, n) => stepShape(x, n));
    const id = randomUUID();
    const r = (await this.#sp.call(link, 'plan', { plan: id, steps, note: clip(note, TEXT) }, 'repair')) as { id?: string; steps?: StepView[]; status?: string };
    const now = this.#iso();
    const views = Array.isArray(r.steps) ? r.steps : steps.map((s, n) => ({ ...s, n, title: s.kind, status: 'waiting', undoable: false, undone: false }));
    this.#db.prepare('INSERT INTO rr_plans (id, peer_id, link, side, peer, pass, scope, note, status, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, clip(r.id, 64), link, 'out', pass.peer, pass.id, pass.scope, clip(note, TEXT), 'waiting', JSON.stringify(views), now, now);
    this.#log(link, pass.peer, 'helper', 'plan', `${steps.length}`);
    this.#audit('plan', { outcome: 'pending', target: `link:${pass.peer}`, content: steps.map((s) => s.kind).join(', ') });
    this.#changed(link);
    return this.plan(id)!;
  }
  /** Helper: a status event from the helped server. */
  statusIn(link: string, name: string, b: Record<string, unknown>): void {
    const r = this.#db.prepare("SELECT * FROM rr_plans WHERE id = ? AND link = ? AND side = 'out'").get(clip(b.plan, 64), link) as Record<string, unknown> | undefined;
    if (!r) throw new SupportError(404, 'not found');
    const p = this.#planView(r);
    const status = String(b.status) as PlanView['status'];
    if (!['waiting', 'running', 'stopping', 'stopped', 'done', 'failed'].includes(status) || !Array.isArray(b.steps)) throw bad('bad status');
    const was = p.status;
    p.status = status;
    p.reason = clip(b.reason, 300);
    p.steps = (b.steps as Record<string, unknown>[]).slice(0, MAX_STEPS).map((s, n) => ({ n, kind: String(s.kind) as StepView['kind'], title: clip(s.title, 300), ...(s.params && typeof s.params === 'object' ? { params: s.params as Record<string, string> } : {}), status: String(s.status) as StepStatus, ...(s.detail ? { detail: clip(s.detail, 300) } : {}), ...(s.detailParams && typeof s.detailParams === 'object' ? { detailParams: s.detailParams as Record<string, string> } : {}), undoable: Boolean(s.undoable), undone: Boolean(s.undone), ...(s.change ? { change: Number(s.change) } : {}) }));
    const final = ['stopped', 'done', 'failed'].includes(status);
    if (final) p.report = reportOf(p, 'helper');
    this.#save(p);
    if (final && !['stopped', 'done', 'failed'].includes(was)) {
      this.#log(link, name, 'helper', 'done', status);
      this.#m.onNotify?.(name, p.report, link);
    }
    this.#changed(link);
  }
}

/** The final report in plain words (English; the page builds its own translated line from the steps). */
export function reportOf(p: PlanView, side: 'helped' | 'helper'): string {
  const n = (st: StepStatus) => p.steps.filter((s) => s.status === st).length;
  const parts = [
    side === 'helped' ? fill(en('{name}’s fix plan: {done} of {all} steps done'), { name: p.peer, done: n('done'), all: p.steps.length }) : fill(en('Your fix plan for {name}: {done} of {all} steps done'), { name: p.peer, done: n('done'), all: p.steps.length }),
    n('failed') ? fill(en('{n} did not work'), { n: n('failed') }) : '',
    n('declined') ? fill(en('{n} declined'), { n: n('declined') }) : '',
    n('skipped') ? fill(en('{n} not run'), { n: n('skipped') }) : '',
  ].filter(Boolean);
  const end = p.status === 'stopped' ? ` ${p.reason || en('Stopped.')}` : '';
  const undo = side === 'helped' && p.steps.some((s) => s.undoable && !s.undone) ? ` ${en('You can undo each step in Messages.')}` : '';
  return `${parts.join(', ')}.${end}${undo}`;
}

const cache = new WeakMap<Messenger, RemoteRepair>();
/** The owner's remote repair (undefined for members, kid mode and the demo: they have no Messenger). */
export function remoteRepairOf(app: AppContext): RemoteRepair | undefined {
  const m = app.messages;
  const sp = supportOf(app);
  if (!m || !sp || app.member) return undefined;
  let r = cache.get(m);
  if (!r) {
    const deps: HelpedDeps = {
      repair: () => app.repair,
      selfCode: () => {
        const sc = selfCodeOf(app) as unknown as { status(): { available: boolean }; start(request: string): { id: number } } | undefined;
        try {
          return sc && sc.status().available ? sc : undefined;
        } catch {
          return undefined;
        }
      },
      settings: { get: () => app.settings.get(), update: (p) => app.settings.update(p) },
      record: (run) => recordRepair(app, run),
      privateLocal: () => privateLocalOn(),
      notify: (title, body, link) => m.onNotify?.(title, body, link),
    };
    cache.set(m, (r = new RemoteRepair({ dataDir: app.dataDir, messenger: m, support: sp, now: () => app.now(), deps })));
  }
  return r;
}

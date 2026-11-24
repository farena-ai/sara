// ROADMAP_T T1+T2 (docs/SELF_REPAIR.md): the self-repair engine.
//   Detection: one "problems" list from health, the doctor, the self-test, health history, recent turn and
//   tool errors, model/sign-in/add-on trouble, stuck jobs and errands, the database, disk and settings. Each
//   problem has a stable id, plain words (an English key + params), evidence and a severity.
//   Level 1 ("fix the setup"): a playbook. Each fix is check → snapshot → act → verify → undo: when health is
//   worse after a fix it is put back by itself and she says so. Runs on its own (permission 'auto1') or asks.
//   Level 2 ("grow"): repeated failures of the same kind, or "learn to do X", become a proposed skill,
//   automation or add-on; always asked once; new things start on trial.
// NEVER, at any level or permission: turn off or edit the safety layer, hard limits, kid mode, approvals or
// the audit trail; read or change vault values (the engine has no vault); give herself more permission
// (repair.* is never written here). Every action writes an audit row. Owner only (repairOf → undefined for
// household members and kid mode). T3 (src/self-code.ts) reads repair.permission / repair.fullUntil.
import type { DatabaseSync } from 'node:sqlite';
import { en, fill } from './i18n.ts';

// ---- the permission (Settings → Privacy & system → Health → Self-repair) -------------------------------
export const REPAIR_PERMISSIONS = ['auto1', 'ask'] as const;
export type RepairPermission = (typeof REPAIR_PERMISSIONS)[number];
export interface RepairSettings {
  /** 'auto1' (default): level 1 fixes run on their own and are reported after; 'ask': everything asks. */
  permission: RepairPermission;
  /** "Full permission for 24 hours": until then one approval covers a whole multi-step repair (ISO or null). */
  fullUntil: string | null;
  /** U3.17 "Share fixes that worked" (off by default) and the linked friends (link ids) it goes to. */
  share: boolean;
  shareLinks: string[];
}
export const FULL_HOURS = 24;
export function repairSettings(s: { repair?: unknown } | undefined): RepairSettings {
  const r = (s?.repair ?? {}) as Record<string, unknown>;
  const permission = REPAIR_PERMISSIONS.includes(r.permission as RepairPermission) ? (r.permission as RepairPermission) : 'auto1';
  const fullUntil = typeof r.fullUntil === 'string' && Number.isFinite(Date.parse(r.fullUntil)) ? r.fullUntil : null;
  const shareLinks = Array.isArray(r.shareLinks) ? [...new Set(r.shareLinks.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,80}$/.test(x)))].slice(0, 50) : [];
  return { permission, fullUntil, share: r.share === true, shareLinks };
}
/** The 24-hour switch is on (and not expired) at `now`. */
export function fullOn(s: { repair?: unknown } | undefined, now: Date): boolean {
  const f = repairSettings(s).fullUntil;
  return Boolean(f && Date.parse(f) > now.getTime());
}
/** Whether a fix of this level may run without asking now. Levels 2 and 3 always ask (once per repair). */
export function runsAlone(s: { repair?: unknown } | undefined, level: number, now: Date): boolean {
  if (level !== 1) return false;
  return repairSettings(s).permission === 'auto1' || fullOn(s, now);
}

// ---- the never-list -------------------------------------------------------------------------------------
/** Settings she never writes in a repair: safety, limits, kid mode, approvals, audit, permissions, her own. */
const NEVER = /^(safety|hardLimits|limits|kid|family|household|toolPermissions|approv|audit|adultMode|policy|privateLocal|security|sandbox|repair|selfCode|permissions|redteam|threat|vault|budgets?|spend)/i;
export function neverTouch(path: string): boolean {
  return NEVER.test(path) || /vault|secret|password|token|apiKey/i.test(path);
}
export class RepairRefused extends Error {}
/** U3.17: told about every fix that worked (src/fix-recipes.ts offers it to friends when the owner allows it). */
export const repairFixed = new Set<(rep: Repair, run: RepairRun, p: Problem) => void>();

// ---- what she finds -------------------------------------------------------------------------------------
export type Severity = 'low' | 'medium' | 'high';
export interface Problem {
  /** Stable while the same thing is wrong (e.g. `model:ollama`, `setting:fallbackAfterSec`). */
  id: string;
  level: 1 | 2;
  severity: Severity;
  /** Plain words: an English key with {params} (the web translates it). */
  text: string;
  params?: Record<string, string | number>;
  evidence: string[];
  /** What the fix does (English key), when there is one; otherwise where the person fixes it. */
  fix?: string;
  page?: string;
  /** False: she can only explain it (or ask the person, e.g. to sign in again). */
  fixable: boolean;
  /** The health check or self-test area it comes from (an English key), shown before the text. */
  area?: string;
}
const WEIGHT: Record<Severity, number> = { low: 1, medium: 2, high: 4 };
/** Lower is healthier. */
export const scoreOf = (ps: Problem[]): number => ps.filter((p) => p.level === 1).reduce((s, p) => s + WEIGHT[p.severity], 0);

export interface RepairStep {
  at: string;
  text: string;
  params?: Record<string, string | number>;
}
export type RepairResult = 'fixed' | 'not-fixed' | 'undone' | 'needs-you' | 'proposed' | 'applied' | 'declined' | 'refused' | 'failed';
export interface RepairRun {
  id: number;
  level: number;
  problem: string;
  title: string;
  params?: Record<string, string | number>;
  steps: RepairStep[];
  /** A backup name or the JSON of what was before (for Undo). */
  snapshot: string | null;
  result: RepairResult;
  undone: boolean;
  undoable: boolean;
  by: string;
  at: string;
  /** Level 2: on trial until (ISO). */
  trialUntil?: string | null;
}

// ---- what the engine reads and changes (the real server's adapters, or a test's fakes) ------------------
export interface HealthCheckLike {
  name: string;
  ok: boolean;
  detail: string;
  detailKey?: string;
  params?: Record<string, unknown>;
}
export interface DoctorLike {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}
export interface SelfTestLike {
  id: string;
  area: string;
  status: string;
  text: string;
  params?: Record<string, string | number>;
  page?: string;
}
export interface TroubleLike {
  id: string;
  kind: string;
  key: string;
  params: Record<string, string | number>;
  fix?: { page?: string };
}
export interface ProviderLike {
  id: string;
  label: string;
  local: boolean;
  /** An Ollama daemon (a model that went missing can be downloaded again). */
  daemon: boolean;
}
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}
export interface RepairEnv {
  now(): Date;
  settings: { get(): Record<string, any>; update(patch: Record<string, unknown>): unknown };
  audit(row: { action: string; target?: string; outcome: 'ok' | 'refused' | 'failed' | 'pending'; content?: string }): void;
  /** Private local mode: only models on this computer. */
  privateLocal?(): boolean;
  health?(): HealthCheckLike[];
  doctor?(): Promise<DoctorLike[]>;
  selfTest?(): Promise<SelfTestLike[]>;
  /** Failed and all turns over the last 24 hours (health history). */
  history?(): { turns: number; failed: number };
  turnErrors?(): { at: string; kind: string; message: string }[];
  toolErrors?(): { at: string; tool: string }[];
  trouble?(): TroubleLike[];
  models?: {
    providers(): ProviderLike[];
    /** Ask the service for its models again (clears its trouble when it answers). */
    retry(providerId: string): Promise<boolean>;
    pull?(providerId: string, model: string): Promise<boolean>;
    /** Whether a model is on this computer (private local mode). */
    onThisComputer?(providerId: string, model: string): boolean;
  };
  jobs?: { running(): { id: number; label: string; startedAt: string }[]; stop(id: number): boolean };
  errands?: { open(): { id: number; goal: string; status: string; updatedAt: string }[]; nudge(id: number): void; updatedAt(id: number): string | undefined };
  addons?: { list(): { id: string; name: string; version: string; status: string; enabled: boolean }[]; restart(id: string): Promise<void>; setEnabled(id: string, on: boolean): Promise<void> };
  db?: { check(): string; bloat(): { freeBytes: number; totalBytes: number }; backup(): string; reindex(): void; vacuum(): void };
  disk?: { freeBytes(): number | null; caches(): { bytes: number }; clean(): { bytes: number; files: number } };
  apps?: { list(): { id: string; label: string; version: string; state?: string; canAsk: boolean }[]; ask(id: string): boolean };
  grow?: {
    skill(d: SkillDraft): { name: string; scope: string };
    removeSkill(scope: string, name: string): void;
    automation?(draft: Record<string, unknown>): { id: number; name: string };
    removeAutomation?(id: number): void;
  };
  /** A notice to the person after a repair she did on her own (Today / her latest chat). */
  report?(text: string): void;
}

// ---- settings that can be put back to their defaults ---------------------------------------------------
interface SettingRule {
  path: string;
  ok(v: unknown, s: Record<string, any>): boolean;
  /** The default (undefined = remove it, so the built-in default applies). */
  def(s: Record<string, any>): unknown;
}
const validZone = (z: unknown) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(z) });
    return true;
  } catch {
    return false;
  }
};
export const SETTING_RULES: readonly SettingRule[] = [
  { path: 'defaultProviderId', ok: (v, s) => (s.providers ?? []).some((p: { id: string }) => p.id === v), def: (s) => s.providers?.[0]?.id },
  { path: 'fallbackAfterSec', ok: (v) => typeof v === 'number' && v >= 10 && v <= 600, def: () => undefined },
  { path: 'thinking', ok: (v) => ['quick', 'balanced', 'thorough'].includes(String(v)), def: () => undefined },
  { path: 'historyBudgetMode', ok: (v) => ['auto', 'full', 'fixed'].includes(String(v)), def: () => undefined },
  { path: 'timeZone', ok: validZone, def: () => undefined },
  { path: 'language', ok: (v) => typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v), def: () => undefined },
  { path: 'autoJobs', ok: (v) => Array.isArray(v) && v.every((x) => ['chat', 'coding', 'vision', 'research'].includes(String(x))), def: () => undefined },
  { path: 'backup.keep', ok: (v) => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 365, def: () => 7 },
];
const getPath = (s: Record<string, any>, path: string): unknown => path.split('.').reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), s);
const has = (s: Record<string, any>, path: string): boolean => {
  const parts = path.split('.');
  const parent = (parts.length > 1 ? getPath(s, parts.slice(0, -1).join('.')) : s) as Record<string, unknown> | undefined;
  return Boolean(parent && typeof parent === 'object' && Object.hasOwn(parent, parts.at(-1)!) && parent[parts.at(-1)!] !== undefined);
};
/** The only way a repair writes a setting: never on the never-list. */
export function safeSet(env: RepairEnv, path: string, value: unknown): void {
  if (neverTouch(path)) {
    env.audit({ action: 'repair.setting', target: path, outcome: 'refused' });
    throw new RepairRefused(`Self-repair never changes ${path}.`);
  }
  const s = env.settings.get();
  const [top, ...rest] = path.split('.');
  if (!rest.length) env.settings.update({ [top!]: value });
  else {
    const obj: Record<string, unknown> = { ...(s[top!] ?? {}) };
    if (value === undefined) delete obj[rest.join('.')];
    else obj[rest.join('.')] = value;
    env.settings.update({ [top!]: obj });
  }
}

// ---- detection -----------------------------------------------------------------------------------------
const STUCK_JOB_MS = 75 * 60_000;
const STUCK_ERRAND_MS = 24 * 3_600_000;
const GROW_TIMES = 3;
const GROW_QUIET_DAYS = 14;
const LOW_DISK = 1e9;

export async function detectProblems(env: RepairEnv, o: { deep?: boolean; db?: boolean } = {}): Promise<Problem[]> {
  const out = new Map<string, Problem>();
  const add = (p: Problem) => {
    if (!out.has(p.id)) out.set(p.id, p);
  };
  const now = env.now();
  const safe = async <T>(f: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch {
      return undefined;
    }
  };
  // Model services, sign-ins, add-ons that stopped (the same list Today's "Needs you" shows).
  for (const t of (await safe(() => env.trouble?.() ?? [])) ?? []) {
    if (t.id.startsWith('model:')) add({ id: t.id, level: 1, severity: 'high', text: t.key, params: t.params, evidence: [`${t.kind}`], fix: en('Try the service again, download the model again if it went missing, or switch to your backup model.'), page: t.fix?.page, fixable: true });
    else if (t.id.startsWith('mail:')) add({ id: `signin:${t.id.slice(5)}`, level: 1, severity: 'medium', text: t.key, params: t.params, evidence: ['signed out'], fix: en('Only you can sign in again (I never type passwords).'), page: t.fix?.page ?? 'ab-mail', fixable: false });
  }
  for (const a of (await safe(() => env.addons?.list() ?? [])) ?? []) {
    if (a.status === 'crashed') add({ id: `addon:${a.id}`, level: 1, severity: 'medium', text: en('The add-on {name} {version} stopped working.'), params: { name: a.name, version: a.version }, evidence: ['crashed'], fix: en('Start it again; if it still fails, turn it off.'), page: 'ab-plugins', fixable: true });
  }
  // Stuck background jobs and errands.
  for (const j of (await safe(() => env.jobs?.running() ?? [])) ?? []) {
    const age = now.getTime() - Date.parse(j.startedAt);
    if (age > STUCK_JOB_MS) add({ id: `job:${j.id}`, level: 1, severity: 'medium', text: en('The background job “{label}” has been running for {min} minutes.'), params: { label: j.label.slice(0, 80), min: Math.round(age / 60_000) }, evidence: [`started ${j.startedAt}`], fix: en('Stop it (it is past its time limit).'), fixable: true });
  }
  for (const e of (await safe(() => env.errands?.open() ?? [])) ?? []) {
    if (!['planning', 'working'].includes(e.status)) continue;
    const age = now.getTime() - Date.parse(e.updatedAt);
    if (age > STUCK_ERRAND_MS) add({ id: `errand:${e.id}`, level: 1, severity: 'low', text: en('The errand “{goal}” has not moved for {h} hours.'), params: { goal: e.goal.slice(0, 80), h: Math.round(age / 3_600_000) }, evidence: [`last change ${e.updatedAt}`], fix: en('Give it a push to take its next step.'), page: 'errands', fixable: true });
  }
  // Database and disk.
  // The integrity check reads the whole file: on demand, and at most once a day on the tick.
  const check = o.deep || o.db !== false ? await safe(() => env.db?.check()) : undefined;
  if (check && check !== 'ok') add({ id: 'db:integrity', level: 1, severity: 'high', text: en('The database reports damage: {detail}'), params: { detail: check.slice(0, 160) }, evidence: [check.slice(0, 300)], fix: en('Make a backup first, then rebuild the indexes and compact it.'), page: 'dh-backups', fixable: true });
  const bloat = await safe(() => env.db?.bloat());
  if (bloat && bloat.freeBytes > 200e6 && bloat.freeBytes > bloat.totalBytes / 3) add({ id: 'db:bloat', level: 1, severity: 'low', text: en('The database has {mb} MB of empty space.'), params: { mb: Math.round(bloat.freeBytes / 1e6) }, evidence: [`${bloat.freeBytes} of ${bloat.totalBytes} bytes free`], fix: en('Make a backup first, then compact it.'), fixable: true });
  const free = await safe(() => env.disk?.freeBytes());
  if (typeof free === 'number' && free < LOW_DISK) {
    const caches = (await safe(() => env.disk?.caches().bytes)) ?? 0;
    add({ id: 'disk:low', level: 1, severity: 'high', text: en('Only {gb} GB of disk space is left.'), params: { gb: (free / 1e9).toFixed(1) }, evidence: [`${free} bytes free`, `${caches} bytes in her caches`], fix: caches ? en('Clear her own caches (downloads and temporary files she can make again).') : undefined, page: 'dh-health', fixable: caches > 0 });
  }
  // Settings with a value that can't work.
  const s = env.settings.get();
  for (const r of SETTING_RULES) {
    if (!has(s, r.path)) continue;
    const v = getPath(s, r.path);
    if (r.ok(v, s)) continue;
    const def = r.def(s);
    if (def !== undefined && !r.ok(def, s)) continue;
    add({ id: `setting:${r.path}`, level: 1, severity: 'medium', text: en('The setting {path} has a value that can’t work ({value}).'), params: { path: r.path, value: JSON.stringify(v ?? null).slice(0, 60) }, evidence: [`now ${JSON.stringify(v ?? null).slice(0, 120)}`, `default ${JSON.stringify(def ?? null)}`], fix: en('Put it back to its default.'), fixable: true });
  }
  // U5.31: the newest finished test restore of a source (src/restore-test.ts) failed.
  {
    const hist = ((s as { restoreTest?: { history?: { at: string; result: string; source: string; step?: string; params?: { error?: unknown } }[] } }).restoreTest?.history ?? []).filter((r) => r.result !== 'skipped');
    const bad = ['local', 'offsite'].map((src) => hist.find((r) => r.source === src)).find((r) => r?.result === 'failed');
    if (bad) add({ id: 'backup:restore-test', area: en('Backups'), level: 1, severity: 'high', text: bad.source === 'offsite' ? en('The off-server copy did not pass its test restore.') : en('The newest backup did not pass its test restore.'), evidence: [`${bad.at} ${bad.step ?? ''} ${String(bad.params?.error ?? '')}`.trim().slice(0, 300)], fix: en('Make a new backup, then press Test a restore now. If it fails again, keep the older backups and ask for help.'), page: 'dh-backups', fixable: false });
  }
  // Desktop and phone apps whose own update failed.
  for (const a of (await safe(() => env.apps?.list() ?? [])) ?? []) {
    if (a.state === 'failed') add({ id: `app:${a.id}`, level: 1, severity: 'medium', text: en('{label} {version}: its last update failed.'), params: { label: a.label, version: a.version }, evidence: ['update state: failed'], fix: a.canAsk ? en('Ask the app to install again with its own updater (it keeps the previous version and goes back by itself if the new one fails).') : undefined, page: 'dh-devices', fixable: a.canAsk });
  }
  // Health checks, the doctor and the self-test: explained, with the page that fixes them.
  for (const c of (await safe(() => env.health?.() ?? [])) ?? []) {
    if (c.ok || ['Model', 'Disk space'].includes(c.name)) continue;
    add({ id: `health:${c.name}`, area: c.name, level: 1, severity: 'low', text: c.detailKey ?? c.detail, params: (c.params ?? {}) as Record<string, string | number>, evidence: [`${c.name}: ${c.detail}`.slice(0, 300)], page: 'dh-health', fixable: false });
  }
  if (o.deep) {
    for (const c of (await safe(() => env.doctor?.())) ?? []) {
      if (c.status !== 'fail' || /^(Provider|Database|Disk space)/.test(c.name)) continue;
      add({ id: `doctor:${c.name}`, level: 1, severity: 'medium', text: en('The full check found a problem with {name}: {detail}'), params: { name: c.name, detail: c.detail.slice(0, 200) }, evidence: [c.detail.slice(0, 300)], page: 'dh-health', fixable: false });
    }
    for (const l of (await safe(() => env.selfTest?.())) ?? []) {
      if (l.status !== 'attention' || /^(No |The inbox helper has not)/.test(l.text) || l.id.startsWith('mail:')) continue;
      add({ id: `selftest:${l.id}`, area: l.area, level: 1, severity: 'low', text: l.text, params: l.params, evidence: [l.area], page: l.page, fixable: false });
    }
  }
  // Failing replies (health history) and recent turn errors.
  const h = await safe(() => env.history?.());
  if (h && h.turns >= 5 && h.failed / h.turns > 0.3) add({ id: 'turns:failing', level: 1, severity: 'high', text: en('{failed} of {turns} replies failed in the last 24 hours.'), params: { failed: h.failed, turns: h.turns }, evidence: ['health history'], page: 'dh-quality', fixable: false });
  // Level 2: the same failure again and again becomes something to grow.
  const week = now.getTime() - 7 * 86_400_000;
  const count = (xs: { at: string; key: string }[]) => {
    const m = new Map<string, number>();
    for (const x of xs) if (Date.parse(x.at) > week) m.set(x.key, (m.get(x.key) ?? 0) + 1);
    return m;
  };
  const turnKinds = count(((await safe(() => env.turnErrors?.() ?? [])) ?? []).map((x) => ({ at: x.at, key: x.kind })));
  for (const [kind, n] of turnKinds) if (n >= GROW_TIMES) add({ id: `grow:turn:${kind}`, level: 2, severity: 'low', text: en('The same error ({kind}) stopped {n} replies this week.'), params: { kind, n }, evidence: [`${n}× ${kind}`], fix: en('Learn a skill for it (on trial first).'), fixable: true });
  const toolNames = count(((await safe(() => env.toolErrors?.() ?? [])) ?? []).map((x) => ({ at: x.at, key: x.tool })));
  for (const [tool, n] of toolNames) if (n >= GROW_TIMES) add({ id: `grow:tool:${tool}`, level: 2, severity: 'low', text: en('{tool} failed {n} times this week.'), params: { tool, n }, evidence: [`${n}× ${tool}`], fix: en('Learn a skill for it (on trial first).'), fixable: true });
  return [...out.values()];
}

// ---- the engine ----------------------------------------------------------------------------------------
export const DETECT_EVERY_MS = 15 * 60_000;
type Act = { steps: RepairStep[]; snapshot: unknown; changed: boolean; undoable: boolean; result?: RepairResult };

export class Repair {
  readonly env: RepairEnv;
  readonly #db: DatabaseSync;
  #last: Problem[] = [];
  #lastAt = 0;
  #busy: Promise<unknown> | undefined;

  constructor(env: RepairEnv, db: DatabaseSync) {
    this.env = env;
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS repair_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level INTEGER NOT NULL,
      problem TEXT NOT NULL,
      title TEXT NOT NULL,
      params TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      snapshot TEXT,
      result TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      undoable INTEGER NOT NULL DEFAULT 0,
      by TEXT NOT NULL DEFAULT 'owner',
      trial_until TEXT,
      at TEXT NOT NULL
    )`);
  }

  /** The last list (no new checks). */
  problems(): Problem[] {
    return this.#last;
  }
  checkedAt(): string | null {
    return this.#lastAt ? new Date(this.#lastAt).toISOString() : null;
  }

  #dbAt = 0;
  async detect(o: { deep?: boolean } = {}): Promise<Problem[]> {
    const now = this.env.now().getTime();
    const db = Boolean(o.deep) || now - this.#dbAt > 86_400_000 || this.#last.some((p) => p.id === 'db:integrity');
    if (db) this.#dbAt = now;
    const all = await detectProblems(this.env, { ...o, db });
    // A growth idea she already proposed (or the person declined) stays quiet for two weeks.
    const quiet = new Set((this.#db.prepare("SELECT problem FROM repair_runs WHERE level = 2 AND at > ?").all(new Date(this.env.now().getTime() - GROW_QUIET_DAYS * 86_400_000).toISOString()) as { problem: string }[]).map((r) => r.problem));
    this.#last = all.filter((p) => p.level !== 2 || !quiet.has(p.id));
    this.#lastAt = this.env.now().getTime();
    return this.#last;
  }

  /** The reminder tick: at most every 15 minutes; level 1 fixes run on their own when allowed. */
  due(now: Date = this.env.now()): void {
    if (this.#busy || now.getTime() - this.#lastAt < DETECT_EVERY_MS) return;
    this.#lastAt = now.getTime();
    this.#busy = this.#auto().catch((err: Error) => console.warn(`self-repair: ${err.message}`)).finally(() => (this.#busy = undefined));
  }
  /** Tests: wait for a tick's work. */
  idle(): Promise<unknown> {
    return this.#busy ?? Promise.resolve();
  }

  async #auto(): Promise<void> {
    const ps = await this.detect();
    if (!runsAlone(this.env.settings.get(), 1, this.env.now())) return;
    // Only fixes that change something she can check; a failed automatic try is not repeated within a day.
    const recent = new Set((this.#db.prepare("SELECT problem FROM repair_runs WHERE by = 'auto' AND at > ?").all(new Date(this.env.now().getTime() - 86_400_000).toISOString()) as { problem: string }[]).map((r) => r.problem));
    const todo = ps.filter((p) => p.level === 1 && p.fixable && !recent.has(p.id));
    if (!todo.length) return;
    const runs = await this.fix(todo.map((p) => p.id), { by: 'auto' });
    const done = runs.filter((r) => r.result === 'fixed').length;
    const undone = runs.filter((r) => r.undone).length;
    if (runs.length) this.env.report?.(fill(en('I fixed {done} of {n} problems on my own; {undone} made things worse, so I put them back. Settings → Privacy & system → Health → Self-repair shows each step.'), { done, n: runs.length, undone }));
  }

  /** May this run now without the person's OK? (the tool and the tick ask this). */
  allowedAlone(ids: string[]): boolean {
    const s = this.env.settings.get();
    const now = this.env.now();
    const ps = ids.map((id) => this.#find(id));
    return ps.every((p) => p && runsAlone(s, p.level, now));
  }

  #find(id: string): Problem | undefined {
    return this.#last.find((p) => p.id === id);
  }

  /** Fixes problems (ids or 'everything'), one after the other. The caller has the person's OK when needed. */
  async fix(target: string | string[], o: { by: 'auto' | 'owner' | 'chat' | `link:${string}`; learn?: { kind?: string; what: string; body?: string; automation?: Record<string, unknown> } } = { by: 'owner' }): Promise<RepairRun[]> {
    if (!this.#lastAt) await this.detect();
    const ids = target === 'everything' ? this.#last.filter((p) => p.fixable && p.level === 1).map((p) => p.id) : Array.isArray(target) ? target : [target];
    const out: RepairRun[] = [];
    for (const id of ids) {
      if (id.startsWith('setting:') && neverTouch(id.slice(8))) {
        this.env.audit({ action: 'repair.fix', target: id, outcome: 'refused' });
        out.push(this.#save({ level: 1, problem: id, title: en('Self-repair never changes this.'), steps: [], snapshot: null, result: 'refused', undoable: false, by: o.by }));
        continue;
      }
      const p = this.#find(id);
      if (!p) continue;
      const run = p.level === 2 ? await this.#grow(p, o.by) : await this.#fixOne(p, o.by);
      out.push(run);
      if (run.result === 'fixed' || run.result === 'applied') {
        for (const f of repairFixed) {
          try {
            f(this, run, p);
          } catch (err) {
            console.warn(`self-repair: ${(err as Error).message}`);
          }
        }
      }
    }
    if (o.learn) out.push(await this.learn(o.learn, o.by));
    if (ids.length) await this.detect();
    return out;
  }

  async #fixOne(p: Problem, by: string): Promise<RepairRun> {
    const before = scoreOf(this.#last);
    const base = { level: 1, problem: p.id, title: p.text, params: p.params, by };
    if (!p.fixable) {
      this.env.audit({ action: 'repair.fix', target: p.id, outcome: 'pending' });
      return this.#save({ ...base, steps: [this.#step(p.fix ?? en('I can only explain this one: open {page} to fix it.'), { page: p.page ?? '' })], snapshot: null, result: 'needs-you', undoable: false });
    }
    let act: Act;
    try {
      act = await this.#act(p);
    } catch (err) {
      const refused = err instanceof RepairRefused;
      this.env.audit({ action: 'repair.fix', target: p.id, outcome: refused ? 'refused' : 'failed', content: (err as Error).message.slice(0, 200) });
      return this.#save({ ...base, steps: [this.#step(en('It did not work: {why}'), { why: (err as Error).message.slice(0, 200) })], snapshot: null, result: refused ? 'refused' : 'failed', undoable: false });
    }
    if (act.result) {
      this.env.audit({ action: 'repair.fix', target: p.id, outcome: 'pending' });
      return this.#save({ ...base, steps: act.steps, snapshot: act.snapshot === null ? null : JSON.stringify(act.snapshot), result: act.result, undoable: false });
    }
    // Verify: the problem is gone, and health is not worse (no higher score, nothing new).
    const prev = new Set(this.#last.map((x) => x.id));
    const after = await this.detect({ deep: p.id.startsWith('doctor:') || p.id.startsWith('selftest:') });
    const worse = scoreOf(after) > before || after.some((x) => x.level === 1 && !prev.has(x.id));
    const gone = !after.some((x) => x.id === p.id);
    const steps = [...act.steps];
    let result: RepairResult = gone ? 'fixed' : 'not-fixed';
    let undone = false;
    if (act.changed && act.undoable && (worse || !gone)) {
      try {
        await this.#undoAct(p.id, act.snapshot);
        undone = true;
        result = 'undone';
        steps.push(this.#step(worse ? en('Health got worse after this, so I put it back the way it was.') : en('That did not fix it, so I put it back the way it was.')));
        await this.detect();
      } catch (err) {
        steps.push(this.#step(en('Putting it back failed: {why}'), { why: (err as Error).message.slice(0, 200) }));
      }
    } else steps.push(this.#step(gone ? en('Checked again: fixed.') : en('Checked again: still there.')));
    this.env.audit({ action: undone ? 'repair.undo' : 'repair.fix', target: p.id, outcome: result === 'fixed' ? 'ok' : 'failed' });
    return this.#save({ ...base, steps, snapshot: act.snapshot === null ? null : JSON.stringify(act.snapshot), result, undone, undoable: act.undoable && !undone && result === 'fixed' });
  }
  #step(text: string, params?: Record<string, string | number>): RepairStep {
    return { at: this.env.now().toISOString(), text, ...(params ? { params } : {}) };
  }

  async #act(p: Problem): Promise<Act> {
    const env = this.env;
    const [kind, ...restParts] = p.id.split(':');
    const rest = restParts.join(':');
    const steps: RepairStep[] = [];
    const say = (t: string, params?: Record<string, string | number>) => steps.push(this.#step(t, params));
    switch (kind) {
      case 'job': {
        const id = Number(rest);
        say(en('Stopped the background job (it was past its time limit).'));
        if (!env.jobs?.stop(id)) throw new Error('that job is not running any more');
        return { steps, snapshot: { job: id }, changed: true, undoable: false };
      }
      case 'errand': {
        const id = Number(rest);
        const was = env.errands?.updatedAt(id);
        env.errands?.nudge(id);
        say(env.errands?.updatedAt(id) !== was ? en('Gave the errand a push: it took its next step.') : en('Gave the errand a push.'));
        return { steps, snapshot: { errand: id }, changed: true, undoable: false };
      }
      case 'model': {
        const m = env.models;
        if (!m) throw new Error('no model services here');
        const s = env.settings.get();
        if (await m.retry(rest)) {
          say(en('Asked {service} again: it answers now.'), { service: this.#label(rest) });
          return { steps, snapshot: null, changed: false, undoable: false };
        }
        say(en('Asked {service} again: still no answer.'), { service: this.#label(rest) });
        const prov = m.providers().find((x) => x.id === rest);
        const model = s.defaultProviderId === rest ? s.defaultModel : undefined;
        if (prov?.daemon && prov.local && model && m.pull) {
          say(en('Downloading {model} again on {service}.'), { model, service: prov.label });
          if ((await m.pull(rest, model)) && (await m.retry(rest))) return { steps, snapshot: null, changed: false, undoable: false };
        }
        // The configured backup model (private local mode: only one on this computer).
        if (s.defaultProviderId !== rest) return { steps, snapshot: null, changed: false, undoable: false };
        const local = env.privateLocal?.() === true;
        const fb = ((s.defaultFallbacks ?? []) as { providerId: string; model: string }[]).find((f) => f.providerId !== rest && (!local || m.onThisComputer?.(f.providerId, f.model) === true));
        if (!fb) {
          say(local ? en('No backup model on this computer is set up (private local mode), so I did not switch.') : en('No backup model is set up, so I did not switch (Settings → Models & usage → Default model).'));
          return { steps, snapshot: null, changed: false, undoable: false, result: 'needs-you' };
        }
        const snap = { defaultProviderId: s.defaultProviderId, defaultModel: s.defaultModel };
        safeSet(env, 'defaultProviderId', fb.providerId);
        safeSet(env, 'defaultModel', fb.model);
        say(en('Switched talking to your backup model {model} on {service}.'), { model: fb.model, service: this.#label(fb.providerId) });
        return { steps, snapshot: snap, changed: true, undoable: true };
      }
      case 'addon': {
        const a = env.addons;
        if (!a) throw new Error('no add-ons here');
        await a.restart(rest);
        if (a.list().find((x) => x.id === rest)?.status !== 'crashed') {
          say(en('Started the add-on again: it runs.'));
          return { steps, snapshot: { enabled: true }, changed: true, undoable: false };
        }
        say(en('Started the add-on again: it stopped again.'));
        await a.setEnabled(rest, false);
        say(en('Turned it off so it stops failing (Undo turns it back on).'));
        return { steps, snapshot: { enabled: true }, changed: true, undoable: true };
      }
      case 'db': {
        const d = env.db;
        if (!d) throw new Error('no database here');
        const ref = d.backup();
        say(en('Made a backup first: {name}.'), { name: ref });
        if (rest === 'integrity') {
          d.reindex();
          say(en('Rebuilt the indexes.'));
        }
        d.vacuum();
        say(en('Compacted the database.'));
        say(en('To go back, restore {name} under Settings → Privacy & system → Backups.'), { name: ref });
        return { steps, snapshot: { backup: ref }, changed: true, undoable: false };
      }
      case 'disk': {
        const r = env.disk?.clean();
        if (!r) throw new Error('nothing to clean here');
        say(en('Cleared her own caches: {mb} MB in {files} files (she makes them again when needed).'), { mb: Math.round(r.bytes / 1e6), files: r.files });
        return { steps, snapshot: { bytes: r.bytes }, changed: true, undoable: false };
      }
      case 'setting': {
        const rule = SETTING_RULES.find((r) => r.path === rest);
        if (!rule) throw new Error('unknown setting');
        const s = env.settings.get();
        const old = getPath(s, rest);
        const def = rule.def(s);
        safeSet(env, rest, def);
        say(en('Put {path} back to its default: {from} → {to}.'), { path: rest, from: JSON.stringify(old ?? null).slice(0, 60), to: def === undefined ? 'default' : JSON.stringify(def) });
        return { steps, snapshot: { path: rest, value: old }, changed: true, undoable: true };
      }
      case 'app': {
        if (!env.apps?.ask(rest)) throw new Error('that app is not signed in any more');
        say(en('Asked the app to install again with its own updater at its next check-in (it keeps the previous version and goes back by itself if the new one fails). I never change app code.'));
        return { steps, snapshot: null, changed: false, undoable: false, result: 'needs-you' };
      }
      default:
        throw new Error('no fix for this one');
    }
  }

  #label(providerId: string): string {
    return this.env.models?.providers().find((x) => x.id === providerId)?.label ?? providerId;
  }

  async #undoAct(problem: string, snapshot: unknown): Promise<void> {
    const snap = (snapshot ?? {}) as Record<string, any>;
    const [kind, ...restParts] = problem.split(':');
    const rest = restParts.join(':');
    if (kind === 'model') {
      safeSet(this.env, 'defaultProviderId', snap.defaultProviderId);
      safeSet(this.env, 'defaultModel', snap.defaultModel);
    } else if (kind === 'setting') safeSet(this.env, String(snap.path), snap.value);
    else if (kind === 'addon') await this.env.addons?.setEnabled(rest, true);
    else if (kind === 'grow') {
      if (snap.skill) this.env.grow?.removeSkill(snap.skill.scope, snap.skill.name);
      if (snap.automation) this.env.grow?.removeAutomation?.(snap.automation.id);
    } else throw new Error('this fix can’t be undone');
  }

  /** Undo from the Repairs view (or the tool). */
  async undo(runId: number): Promise<RepairRun> {
    const r = this.run(runId);
    if (!r) throw new RepairRefused('No such repair.');
    if (!r.undoable || r.undone) throw new RepairRefused('This one can’t be undone (any more).');
    await this.#undoAct(r.problem, r.snapshot ? JSON.parse(r.snapshot) : null);
    const steps = [...r.steps, this.#step(en('Undone by you.'))];
    this.#db.prepare("UPDATE repair_runs SET undone = 1, undoable = 0, result = 'undone', steps = ? WHERE id = ?").run(JSON.stringify(steps), runId);
    this.env.audit({ action: 'repair.undo', target: r.problem, outcome: 'ok' });
    await this.detect();
    return this.run(runId)!;
  }

  // ---- level 2: grow --------------------------------------------------------------------------------
  /** The proposal for a repeated failure (a skill on trial). Applied right away when the caller has the OK. */
  #draftFor(p: Problem): SkillDraft {
    const what = String(p.params?.tool ?? p.params?.kind ?? 'this');
    const name = `handle-${what.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'failure'}`;
    return {
      name,
      description: `What to do when ${what} fails (learned from ${p.params?.n ?? 'repeated'} failures this week).`,
      body: `# When ${what} fails\n\n1. Read the error and say in plain words what went wrong.\n2. Check the obvious cause first (the service answers, the sign-in is valid, the input is complete).\n3. Try once more with a smaller or simpler request.\n4. If it still fails, stop, tell the person what you tried, and offer the setting or page that fixes it.\n`,
    };
  }

  async #grow(p: Problem, by: string): Promise<RepairRun> {
    return this.applyGrow({ kind: 'skill', problem: p.id, title: p.text, params: p.params, draft: this.#draftFor(p) }, by);
  }

  /** "Learn to do X": a skill (default), an automation, or an add-on to look for in Get more. */
  async learn(l: { kind?: string; what: string; body?: string; automation?: Record<string, unknown> }, by: string): Promise<RepairRun> {
    const what = String(l.what ?? '').trim().slice(0, 200);
    if (!what) throw new RepairRefused('Say what she should learn.');
    const kind = ['skill', 'automation', 'addon'].includes(String(l.kind)) ? String(l.kind) : 'skill';
    const name = `learned-${what.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill'}`;
    const draft: SkillDraft = { name, description: what, body: (l.body?.trim() || `# ${what}\n\nSteps she follows for this (refine after the trial).\n`).slice(0, 8000) };
    return this.applyGrow({ kind, problem: `learn:${name}`, title: en('Learn: {what}'), params: { what }, draft, automation: l.automation }, by);
  }

  /** Creates the skill/automation (on trial) or points at Get more for an add-on. The OK was given by the caller. */
  async applyGrow(g: { kind: string; problem: string; title: string; params?: Record<string, string | number>; draft: SkillDraft; automation?: Record<string, unknown> }, by: string): Promise<RepairRun> {
    const base = { level: 2, problem: g.problem, title: g.title, params: g.params, by };
    const trialUntil = new Date(this.env.now().getTime() + 7 * 86_400_000).toISOString();
    try {
      if (g.kind === 'addon') {
        this.env.audit({ action: 'repair.grow', target: g.problem, outcome: 'pending' });
        return this.#save({ ...base, steps: [this.#step(en('Add-ons install through Get more, where you see what it may do before it is added. Search there for: {what}.'), { what: g.draft.description.slice(0, 80) })], snapshot: null, result: 'needs-you', undoable: false });
      }
      if (g.kind === 'automation') {
        if (!this.env.grow?.automation || !g.automation) throw new Error('an automation needs a schedule or trigger and what it does');
        const a = this.env.grow.automation(g.automation);
        this.env.audit({ action: 'repair.grow', target: `automation:${a.id}`, outcome: 'ok' });
        return this.#save({ ...base, steps: [this.#step(en('Made the automation “{name}”, on trial for 7 days (its steps still ask where they always do).'), { name: a.name })], snapshot: JSON.stringify({ automation: a }), result: 'applied', undoable: true, trialUntil });
      }
      if (!this.env.grow) throw new Error('skills are not available here');
      const sk = this.env.grow.skill(g.draft);
      this.env.audit({ action: 'repair.grow', target: `skill:${sk.name}`, outcome: 'ok' });
      return this.#save({ ...base, steps: [this.#step(en('Saved the skill “{name}”, on trial: used only when it clearly fits, until it proves itself.'), { name: sk.name })], snapshot: JSON.stringify({ skill: sk }), result: 'applied', undoable: true, trialUntil });
    } catch (err) {
      this.env.audit({ action: 'repair.grow', target: g.problem, outcome: 'failed', content: (err as Error).message.slice(0, 200) });
      return this.#save({ ...base, steps: [this.#step(en('It did not work: {why}'), { why: (err as Error).message.slice(0, 200) })], snapshot: null, result: 'failed', undoable: false });
    }
  }

  /** The person said no to a growth idea: it stays quiet for two weeks. */
  decline(problem: string, by: string): RepairRun {
    const p = this.#find(problem);
    this.env.audit({ action: 'repair.grow', target: problem, outcome: 'refused' });
    const r = this.#save({ level: 2, problem, title: p?.text ?? problem, params: p?.params, by, steps: [], snapshot: null, result: 'declined', undoable: false });
    this.#last = this.#last.filter((x) => x.id !== problem);
    return r;
  }

  // ---- the log -------------------------------------------------------------------------------------
  #save(r: Omit<RepairRun, 'id' | 'at' | 'undone'> & { undone?: boolean }): RepairRun {
    return recordRepairIn(this.#db, this.env.now(), r);
  }
  record(r: Omit<RepairRun, 'id' | 'at' | 'undone'> & { undone?: boolean }): RepairRun {
    return this.#save(r);
  }
  runs(limit = 50): RepairRun[] {
    return (this.#db.prepare('SELECT * FROM repair_runs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, any>[]).map(rowOf);
  }
  run(id: number): RepairRun | undefined {
    const r = this.#db.prepare('SELECT * FROM repair_runs WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? rowOf(r) : undefined;
  }
}

function rowOf(r: Record<string, any>): RepairRun {
  return {
    id: Number(r.id),
    level: Number(r.level),
    problem: String(r.problem),
    title: String(r.title),
    ...(r.params ? { params: JSON.parse(String(r.params)) } : {}),
    steps: JSON.parse(String(r.steps ?? '[]')),
    snapshot: r.snapshot === null ? null : String(r.snapshot),
    result: r.result as RepairResult,
    undone: Boolean(r.undone),
    undoable: Boolean(r.undoable),
    by: String(r.by),
    at: String(r.at),
    trialUntil: r.trial_until ?? null,
  };
}

function recordRepairIn(db: DatabaseSync, now: Date, r: Omit<RepairRun, 'id' | 'at' | 'undone'> & { undone?: boolean }): RepairRun {
  const at = now.toISOString();
  const res = db
    .prepare('INSERT INTO repair_runs (level, problem, title, params, steps, snapshot, result, undone, undoable, by, trial_until, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.level, r.problem, r.title, r.params ? JSON.stringify(r.params) : null, JSON.stringify(r.steps ?? []), r.snapshot ?? null, r.result, r.undone ? 1 : 0, r.undoable ? 1 : 0, r.by, r.trialUntil ?? null, at);
  return { ...r, id: Number(res.lastInsertRowid), at, undone: Boolean(r.undone), trialUntil: r.trialUntil ?? null };
}

/**
 * For other builders (T3 own-code changes, T5 remote repair): add a row to the repair log. Writes an audit
 * row too. Undo for such rows is the caller's own (undoable rows need a matching undo path here).
 */
export function recordRepair(app: { repair?: Repair }, run: Omit<RepairRun, 'id' | 'at' | 'undone'> & { undone?: boolean }): RepairRun | undefined {
  const rep = app.repair;
  if (!rep) return undefined;
  rep.env.audit({ action: `repair.level${run.level}`, target: run.problem, outcome: run.result === 'fixed' || run.result === 'applied' ? 'ok' : run.result === 'refused' ? 'refused' : 'pending' });
  return rep.record(run);
}

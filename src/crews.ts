// EC12 (docs/ops/EC1213_DESIGN.md): crews. A crew is a saved team task with standing members: each
// member is one of the owner's helpers (Settings → Team: role, instructions, tools, model) with a
// standing part to do; the lead (Sara, through TeamManager) hands each part over as a board card,
// checks it and sends one summary. A crew runs by hand, on a daily or weekly slot (the reminder
// scheduler's tick, no timer of its own) or when the owner's own verified mail to her mailbox has
// the crew's subject words. The deliverable is a file in the crew's folder (the lead's report and
// the receipts per member), a crew card in the crew's chat and, when turned on, his Telegram.
// Everything else is the team's: approvals, sandbox, claim checks, budgets, run records.
//
// Tables (additive, the space's own store.db): crews, crew_runs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { nextScheduled } from './loops.ts';
import { policy } from './policy-profile.ts';
import { cleanLimits, teamHelpers, type TeamLimits, type TeamStep } from './team.ts';
import { isSecretPath, resolveInside, workspaceDir } from './tools/workspace.ts';
import { usageLine } from './usage.ts';

export const CREW = { maxCrews: 12, maxMembers: 4, minMembers: 1, missedSlotMs: 6 * 3600_000 } as const;
export type CrewSchedule = { kind: 'manual' } | { kind: 'daily'; time: string } | { kind: 'weekly'; day: number; time: string };
export type CrewWhy = 'manual' | 'schedule' | 'mail';
export type CrewRunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'limit' | 'interrupted';
export interface CrewMember {
  helper: string;
  task: string;
}
export interface Crew {
  id: number;
  name: string;
  brief: string;
  members: CrewMember[];
  limits: TeamLimits;
  schedule: CrewSchedule;
  mail: { subject: string } | null;
  folder: string;
  alsoTo: 'telegram'[];
  state: 'on' | 'paused';
  conversationId: string;
  boardId: number | null;
  nextAt: string | null;
  template: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CrewRun {
  id: number;
  crewId: number;
  why: CrewWhy;
  status: CrewRunStatus;
  teamTaskId: number | null;
  file: string | null;
  cards: number[];
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}
export interface CrewTemplate {
  id: string;
  name: string;
  blurb: string;
  crew: Record<string, unknown>;
}

export class CrewError extends Error {
  readonly status: number;
  readonly params?: Record<string, string | number>;
  constructor(status: number, message: string, params?: Record<string, string | number>) {
    super(message);
    this.status = status;
    this.params = params;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'crew';
type Row = Record<string, string | number | null>;

/** The schedule as the loops' clock schedule (the same slot maths as routines), or null for manual. */
function clockOf(s: CrewSchedule): { at: string; repeat: 'daily' | 'weekly'; day?: number } | null {
  if (s.kind === 'daily') return { at: s.time, repeat: 'daily' };
  if (s.kind === 'weekly') return { at: s.time, repeat: 'weekly', day: s.day };
  return null;
}

/** The starter crews (templates/crews/*.json); a bad file is skipped, never half-loaded. */
export function loadCrewTemplates(dir: string = join(import.meta.dirname, '..', 'templates', 'crews')): CrewTemplate[] {
  if (!existsSync(dir)) return [];
  const out: CrewTemplate[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<CrewTemplate>;
      if (typeof j.id !== 'string' || typeof j.name !== 'string' || typeof j.blurb !== 'string' || !j.crew || typeof j.crew !== 'object') throw new Error('id, name, blurb and crew are needed');
      out.push({ id: j.id, name: j.name, blurb: j.blurb, crew: j.crew });
    } catch (err) {
      console.warn(`crews: template ${f} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

export class Crews {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #done = new Map<number, Promise<CrewRun>>();

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`
CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brief TEXT NOT NULL,
  members TEXT NOT NULL,
  limits TEXT NOT NULL,
  schedule TEXT NOT NULL,
  mail TEXT,
  folder TEXT NOT NULL,
  also_to TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  board_id INTEGER,
  next_at TEXT,
  template TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crew_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id INTEGER NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL,
  team_task_id INTEGER,
  file TEXT,
  cards TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS crew_runs_crew ON crew_runs(crew_id, id);
`);
    // A run that was going when the server stopped: its team task is interrupted too (the Team page resumes it).
    db.prepare("UPDATE crew_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(this.#now().toISOString());
  }

  #now(): Date {
    return this.#app.now();
  }

  #view(r: Row): Crew {
    return {
      id: Number(r.id),
      name: String(r.name),
      brief: String(r.brief),
      members: JSON.parse(String(r.members)) as CrewMember[],
      limits: JSON.parse(String(r.limits)) as TeamLimits,
      schedule: JSON.parse(String(r.schedule)) as CrewSchedule,
      mail: r.mail ? (JSON.parse(String(r.mail)) as { subject: string }) : null,
      folder: String(r.folder),
      alsoTo: JSON.parse(String(r.also_to)) as 'telegram'[],
      state: r.state === 'on' ? 'on' : 'paused',
      conversationId: String(r.conversation_id),
      boardId: r.board_id === null ? null : Number(r.board_id),
      nextAt: r.next_at === null ? null : String(r.next_at),
      template: r.template === null ? null : String(r.template),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  #runView(r: Row): CrewRun {
    return {
      id: Number(r.id),
      crewId: Number(r.crew_id),
      why: String(r.why) as CrewWhy,
      status: String(r.status) as CrewRunStatus,
      teamTaskId: r.team_task_id === null ? null : Number(r.team_task_id),
      file: r.file === null ? null : String(r.file),
      cards: JSON.parse(String(r.cards)) as number[],
      error: r.error === null ? null : String(r.error),
      startedAt: String(r.started_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
    };
  }

  list(): Crew[] {
    return (this.#db.prepare('SELECT * FROM crews ORDER BY id').all() as Row[]).map((r) => this.#view(r));
  }

  get(id: number): Crew | undefined {
    const r = this.#db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  runs(crewId: number, limit = 20): CrewRun[] {
    return (this.#db.prepare('SELECT * FROM crew_runs WHERE crew_id = ? ORDER BY id DESC LIMIT ?').all(crewId, limit) as Row[]).map((r) => this.#runView(r));
  }

  run_(id: number): CrewRun | undefined {
    const r = this.#db.prepare('SELECT * FROM crew_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#runView(r) : undefined;
  }

  templates(): CrewTemplate[] {
    return loadCrewTemplates();
  }

  /** EC5: the admin's pin `crews: 'off'` refuses every way a crew could start or be made. */
  #pinned(): void {
    if (policy().pins.crews === 'off') throw new CrewError(403, en('Crews are turned off by your admin.'));
  }

  #clean(body: Record<string, unknown>, cur?: Crew): Omit<Crew, 'id' | 'conversationId' | 'boardId' | 'nextAt' | 'createdAt' | 'updatedAt'> {
    const has = (k: string) => body[k] !== undefined;
    const name = has('name') ? String(body.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : (cur?.name ?? '');
    if (!name) throw new CrewError(400, en('Give the crew a name.'));
    const brief = has('brief') ? String(body.brief ?? '').trim() : (cur?.brief ?? '');
    if (brief.length < 8 || brief.length > 2000) throw new CrewError(400, en('Describe what the crew delivers in 8 to 2000 characters.'));
    let members = cur?.members ?? [];
    if (has('members')) {
      const raw = body.members;
      if (!Array.isArray(raw) || raw.length < CREW.minMembers || raw.length > CREW.maxMembers) throw new CrewError(400, en('A crew has 1 to 4 members.'));
      const ids = new Set(teamHelpers(this.#app).map((h) => h.id));
      members = raw.map((x) => {
        const m = (x ?? {}) as Record<string, unknown>;
        const helper = String(m.helper ?? '');
        const task = String(m.task ?? '').trim().slice(0, 1000);
        if (!ids.has(helper)) throw new CrewError(400, en('Pick one of your helpers for each member.'));
        if (task.length < 4) throw new CrewError(400, en('Say what each member does.'));
        return { helper, task };
      });
    }
    const limits = has('limits') ? cleanLimits({ ...(cur?.limits ?? {}), ...((body.limits ?? {}) as object) }, cur?.limits ?? cleanLimits(this.#app.settings.get().teamLimits)) : (cur?.limits ?? cleanLimits(this.#app.settings.get().teamLimits));
    let schedule: CrewSchedule = cur?.schedule ?? { kind: 'manual' };
    if (has('schedule')) {
      const s = (body.schedule ?? {}) as Record<string, unknown>;
      const time = String(s.time ?? '');
      if (s.kind === 'manual') schedule = { kind: 'manual' };
      else if (s.kind === 'daily' && TIME_RE.test(time)) schedule = { kind: 'daily', time };
      else if (s.kind === 'weekly' && TIME_RE.test(time) && Number.isInteger(s.day) && Number(s.day) >= 0 && Number(s.day) <= 6) schedule = { kind: 'weekly', day: Number(s.day), time };
      else throw new CrewError(400, en('Pick by hand, every day or every week, and a time.'));
    }
    let mail = cur?.mail ?? null;
    if (has('mail')) {
      const subject = String(((body.mail ?? {}) as Record<string, unknown>).subject ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
      mail = subject.length >= 3 ? { subject } : null;
    }
    let folder = cur?.folder ?? `crews/${slug(name)}`;
    if (has('folder') && body.folder !== '') {
      const f = String(body.folder ?? '').trim().replace(/\\/g, '/');
      if (!f || f.startsWith('/') || /^[a-z]:/i.test(f) || f.split('/').some((p) => p === '..') || isSecretPath(f) || f.length > 120) throw new CrewError(400, en('Pick a folder inside the crew\'s workspace.'));
      folder = f.replace(/\/+$/, '');
    }
    let alsoTo = cur?.alsoTo ?? [];
    if (has('alsoTo')) {
      const raw = body.alsoTo;
      if (!Array.isArray(raw) || raw.some((x) => x !== 'telegram')) throw new CrewError(400, en('Results can also go to your own linked Telegram chat.'));
      alsoTo = raw.length ? ['telegram'] : [];
    }
    const state = has('state') ? (body.state === 'paused' ? 'paused' : 'on') : (cur?.state ?? 'on');
    const template = typeof body.template === 'string' ? body.template.slice(0, 40) : (cur?.template ?? null);
    return { name, brief, members, limits, schedule, mail, folder, alsoTo, state, template };
  }

  #next(schedule: CrewSchedule, state: 'on' | 'paused', after: Date): string | null {
    const c = clockOf(schedule);
    return c && state === 'on' ? nextScheduled(c, after, this.#app.settings.get().timeZone).toISOString() : null;
  }

  create(body: Record<string, unknown>): Crew {
    this.#pinned();
    if (this.list().length >= CREW.maxCrews) throw new CrewError(400, en('You have the most crews there can be (12). Delete one first.'));
    const c = this.#clean(body);
    const now = this.#now();
    const conv = this.#app.store.createConversation({ title: `Crew: ${c.name}`, mode: 'coding' });
    const iso = now.toISOString();
    const r = this.#db
      .prepare('INSERT INTO crews (name, brief, members, limits, schedule, mail, folder, also_to, state, conversation_id, next_at, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.name, c.brief, JSON.stringify(c.members), JSON.stringify(c.limits), JSON.stringify(c.schedule), c.mail ? JSON.stringify(c.mail) : null, c.folder, JSON.stringify(c.alsoTo), c.state, conv.id, this.#next(c.schedule, c.state, now), c.template, iso, iso);
    return this.get(Number(r.lastInsertRowid))!;
  }

  patch(id: number, body: Record<string, unknown>): Crew {
    const cur = this.get(id);
    if (!cur) throw new CrewError(404, en('Crew not found'));
    if (body.state !== 'paused') this.#pinned();
    const c = this.#clean(body, cur);
    const now = this.#now();
    const scheduleChanged = JSON.stringify(c.schedule) !== JSON.stringify(cur.schedule) || c.state !== cur.state;
    this.#db
      .prepare('UPDATE crews SET name = ?, brief = ?, members = ?, limits = ?, schedule = ?, mail = ?, folder = ?, also_to = ?, state = ?, next_at = ?, updated_at = ? WHERE id = ?')
      .run(c.name, c.brief, JSON.stringify(c.members), JSON.stringify(c.limits), JSON.stringify(c.schedule), c.mail ? JSON.stringify(c.mail) : null, c.folder, JSON.stringify(c.alsoTo), c.state, scheduleChanged ? this.#next(c.schedule, c.state, now) : cur.nextAt, now.toISOString(), id);
    return this.get(id)!;
  }

  /** Forgets the crew (its chat, board, runs and files stay). */
  remove(id: number): boolean {
    this.stop(id);
    return Number(this.#db.prepare('DELETE FROM crews WHERE id = ?').run(id).changes) > 0;
  }

  #running(crewId: number): CrewRun | undefined {
    const r = this.#db.prepare("SELECT * FROM crew_runs WHERE crew_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(crewId) as Row | undefined;
    return r ? this.#runView(r) : undefined;
  }

  /** The crew's own board (made once, made again if he deleted it). */
  #board(c: Crew): number | null {
    const b = this.#app.board;
    if (!b) return null;
    if (c.boardId && b.board(c.boardId)) return c.boardId;
    const made = b.createBoard(`Crew: ${c.name}`);
    this.#db.prepare('UPDATE crews SET board_id = ? WHERE id = ?').run(made.id, c.id);
    return made.id;
  }

  /** Starts a run: one card per member, then the team task with the members as the plan. */
  run(id: number, why: CrewWhy): CrewRun {
    this.#pinned();
    const c = this.get(id);
    if (!c) throw new CrewError(404, en('Crew not found'));
    if (why !== 'manual' && c.state !== 'on') throw new CrewError(409, en('This crew is paused.'));
    if (this.#running(id)) throw new CrewError(409, en('This crew is already working.'));
    const team = this.#app.team;
    if (!team) throw new CrewError(403, en('Only the owner of this server can use this.'));
    const iso = this.#now().toISOString();
    const runId = Number(this.#db.prepare("INSERT INTO crew_runs (crew_id, why, status, started_at) VALUES (?, ?, 'running', ?)").run(id, why, iso).lastInsertRowid);
    const names = new Map(teamHelpers(this.#app).map((h) => [h.id, h.name]));
    const boardId = this.#board(c);
    const cards: number[] = [];
    if (boardId !== null) {
      for (const m of c.members) {
        const card = this.#app.board!.addCard(boardId, { title: clip(`${names.get(m.helper) ?? m.helper}: ${m.task}`, 160), notes: c.brief, conversationId: c.conversationId }, 'sara');
        this.#app.board!.log(card.id, 'sara', 'assigned', { to: `helper:${m.helper}`, crew: c.id, run: runId });
        this.#app.board!.moveToRole(card.id, 'doing', `helper:${m.helper}`);
        cards.push(card.id);
      }
    }
    this.#db.prepare('UPDATE crew_runs SET cards = ? WHERE id = ?').run(JSON.stringify(cards), runId);
    const plan = c.members.map((m) => ({ helper: m.helper, title: clip(m.task, 160), instructions: `${m.task}\n\nThe crew's brief (what the whole crew delivers): ${c.brief}` }));
    let taskId: number;
    try {
      taskId = team.start(c.conversationId, `${c.name}: ${c.brief}`, { plan, limits: c.limits }).id;
    } catch (err) {
      this.#end(runId, 'failed', { error: clip((err as Error).message, 300) });
      for (const card of cards) this.#app.board?.moveToRole(card, 'waiting', 'sara');
      throw new CrewError(409, (err as Error).message);
    }
    this.#db.prepare('UPDATE crew_runs SET team_task_id = ? WHERE id = ?').run(taskId, runId);
    if (why !== 'manual') audit({ action: 'crew.run', target: `crew${id}`, role: 'system', who: 'sara', channel: 'system', outcome: 'ok', keys: [why] });
    const done = team.finished(taskId).then(
      () => this.#finish(runId),
      (err) => {
        this.#end(runId, 'failed', { error: clip((err as Error).message, 300) });
        return this.run_(runId)!;
      },
    );
    this.#done.set(runId, done.finally(() => this.#done.delete(runId)));
    return this.run_(runId)!;
  }

  /** Resolves when a run ends (tests, and the routes' "wait"). */
  async finished(runId: number): Promise<CrewRun> {
    await this.#done.get(runId);
    return this.run_(runId)!;
  }

  #end(runId: number, status: CrewRunStatus, patch: { file?: string; error?: string } = {}): void {
    this.#db.prepare('UPDATE crew_runs SET status = ?, file = COALESCE(?, file), error = COALESCE(?, error), ended_at = ? WHERE id = ?').run(status, patch.file ?? null, patch.error ?? null, this.#now().toISOString(), runId);
  }

  /** The team task ended: cards, the deliverable file, the crew card and Telegram. */
  async #finish(runId: number): Promise<CrewRun> {
    const app = this.#app;
    const run = this.run_(runId)!;
    const c = this.get(run.crewId);
    const task = run.teamTaskId ? app.team?.get(run.teamTaskId) : undefined;
    if (!task) {
      this.#end(runId, 'failed', { error: 'no team task' });
      return this.run_(runId)!;
    }
    const status: CrewRunStatus = task.status === 'done' ? 'done' : task.status === 'stopped' ? 'stopped' : task.status === 'limit' ? 'limit' : task.status === 'interrupted' ? 'interrupted' : 'failed';
    const names = new Map(teamHelpers(app).map((h) => [h.id, h.name]));
    // Each member's card: Done when its part is done, otherwise Waiting on him; its receipts as activity.
    const members = c?.members ?? [];
    members.forEach((m, i) => {
      const card = run.cards[i];
      if (!card || !app.board?.card(card)) return;
      const steps = task.steps.filter((s) => s.helper === m.helper);
      for (const s of steps) for (const r of s.receipts) app.board.log(card, `helper:${m.helper}`, 'receipt', { tool: r.name, status: r.status, summary: argOf(r.args) });
      const ok = steps.length > 0 && steps.every((s) => s.status === 'done' || s.status === 'skipped') && steps.some((s) => s.status === 'done');
      app.board.moveToRole(card, ok ? 'done' : 'waiting', `helper:${m.helper}`);
    });
    let file: string | undefined;
    if (c && status !== 'stopped') {
      try {
        file = this.#writeFile(c, task.report ?? '', task.steps, names, run.teamTaskId!);
      } catch (err) {
        console.warn(`crews: could not write the file for crew ${c.id}: ${(err as Error).message}`);
      }
    }
    this.#end(runId, status, file ? { file } : {});
    if (c) {
      const s = app.settings.get();
      const receipts = task.steps.reduce((n, st) => n + st.receipts.length, 0);
      const msg = app.store.addMessage(c.conversationId, 'notice', `crew:${c.name}`, { crew: { id: c.id, runId, name: c.name, status, file: file ?? null, cards: run.cards.length, receipts, teamTaskId: task.id } });
      app.events?.publish({ type: 'message', conversationId: c.conversationId, message: msg, reason: 'job' });
      const tg = app.bridges?.telegram as (NonNullable<AppContext['bridges']>['telegram'] & { fileToOwner?: (path: string, name: string, caption: string) => Promise<boolean> }) | undefined;
      if (c.alsoTo.includes('telegram') && tg?.ownerLinked()) {
        const caption = trOwner('Crew {name}: {status}', s, { name: c.name, status: trOwner(STATUS_WORDS[status], s) });
        if (file && tg.fileToOwner) void tg.fileToOwner(join(this.#dir(c), basename(file)), basename(file), caption).catch(() => false);
        else void tg.toOwner(caption).catch(() => false);
      }
    }
    return this.run_(runId)!;
  }

  #dir(c: Crew): string {
    const conv = this.#app.store.getConversation(c.conversationId);
    const ws = workspaceDir(this.#app.rootDir ?? this.#app.dataDir, conv?.workspace ?? 'main');
    return resolveInside(ws, c.folder);
  }

  /** The deliverable: written by the app (not a tool), inside the crew's folder only. */
  #writeFile(c: Crew, report: string, steps: TeamStep[], names: Map<string, string>, taskId: number): string {
    const now = this.#now();
    const tz = this.#app.settings.get().timeZone;
    const z = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const part = (t: string) => z.find((x) => x.type === t)?.value ?? '00';
    const name = `${part('year')}-${part('month')}-${part('day')}-${part('hour')}${part('minute')}.md`;
    const dir = this.#dir(c);
    mkdirSync(dir, { recursive: true });
    const lines = [`# ${c.name}`, '', `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`, '', report.trim(), '', '## Receipts', ''];
    for (const s of steps) {
      lines.push(`### ${names.get(s.helper) ?? s.helper}: ${s.title} (${s.status})`);
      if (!s.receipts.length) lines.push('- (none)');
      for (const r of s.receipts) lines.push(`- ${r.name}: ${r.status}${argOf(r.args) ? ` (${argOf(r.args)})` : ''}`);
      lines.push('');
    }
    const u = this.#app.usage?.forTeam(taskId);
    if (u) lines.push(`Used: ${usageLine(u)}`, '');
    const target = join(dir, name);
    writeFileSync(target, this.#app.redactor.redact(lines.join('\n')), { mode: 0o600 });
    return `${c.folder}/${name}`;
  }

  /** The file of a run (for *Open the file*), inside the crew's folder only. */
  file(runId: number): { path: string; name: string } | undefined {
    const run = this.run_(runId);
    const c = run ? this.get(run.crewId) : undefined;
    if (!run?.file || !c) return undefined;
    const conv = this.#app.store.getConversation(c.conversationId);
    const path = resolveInside(workspaceDir(this.#app.rootDir ?? this.#app.dataDir, conv?.workspace ?? 'main'), run.file);
    return existsSync(path) ? { path, name: basename(path) } : undefined;
  }

  /** Stops a crew's running team task. */
  stop(id: number): boolean {
    const run = this.#running(id);
    return Boolean(run?.teamTaskId && this.#app.team?.stop(run.teamTaskId));
  }

  /** *Stop all*: every running crew stops, every crew is paused (nothing starts until he turns one on). */
  stopAll(): { stopped: number; paused: number } {
    let stopped = 0;
    for (const c of this.list()) if (this.stop(c.id)) stopped++;
    const paused = Number(this.#db.prepare("UPDATE crews SET state = 'paused', next_at = NULL, updated_at = ? WHERE state = 'on'").run(this.#now().toISOString()).changes);
    return { stopped, paused };
  }

  /** Called from ReminderScheduler.tick(): crews whose slot has come. A slot missed by over 6 h is skipped. */
  due(now: Date = this.#now()): number {
    if (policy().pins.crews === 'off') return 0;
    let started = 0;
    for (const c of this.list()) {
      if (c.state !== 'on' || !c.nextAt || Date.parse(c.nextAt) > now.getTime()) continue;
      const late = now.getTime() - Date.parse(c.nextAt) > CREW.missedSlotMs;
      this.#db.prepare('UPDATE crews SET next_at = ? WHERE id = ?').run(this.#next(c.schedule, c.state, now), c.id);
      if (late || this.#running(c.id)) continue;
      try {
        this.run(c.id, 'schedule');
        started++;
      } catch (err) {
        console.warn(`crews: crew ${c.id} did not start: ${(err as Error).message}`);
      }
    }
    return started;
  }

  /**
   * A mail rule: the owner's own mail to her mailbox (the bridge's sender check passed) whose subject
   * has the crew's words starts it. Never someone else's mail; the mail's text never reaches the crew.
   */
  onMail(m: { subject: string; owner: boolean }): number {
    if (!m.owner || policy().pins.crews === 'off') return 0;
    const subject = m.subject.toLowerCase();
    let started = 0;
    for (const c of this.list()) {
      if (c.state !== 'on' || !c.mail || !subject.includes(c.mail.subject.toLowerCase()) || this.#running(c.id)) continue;
      try {
        this.run(c.id, 'mail');
        started++;
      } catch (err) {
        console.warn(`crews: crew ${c.id} did not start from mail: ${(err as Error).message}`);
      }
    }
    return started;
  }
}

const STATUS_WORDS: Record<CrewRunStatus, string> = { running: 'working', done: 'done', failed: 'finished with problems', stopped: 'stopped', limit: 'stopped at its budget', interrupted: 'interrupted by a restart' };
/** Server words the crew card and Telegram use (so the extractor sees them). */
export const CREW_LINES = [en('working'), en('done'), en('finished with problems'), en('stopped'), en('stopped at its budget'), en('interrupted by a restart'), en('Crew {name}: {status}')];

/** A receipt's short argument (a path, a command, a query or an address), clipped. */
function argOf(a: Record<string, unknown>): string {
  const v = a.path ?? a.command ?? a.query ?? a.url ?? '';
  return clip(String(v).replace(/\s+/g, ' '), 80);
}

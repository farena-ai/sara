// W1.5 (docs/HER_WEEK.md): a weekly "how am I doing" check-in with her. Read-only over records that
// already exist: the V5.1 action timeline (what she changed), tool results and the receipts check's
// flags in messages (what failed or she couldn't back up), runs that ended in an error, and the
// Phase 52 usage meter (what cost money). Three concrete suggestions, each with a one-tap Accept
// that turns on an existing setting or creates an automation from the gallery (never money, never
// Always allow), recorded on the timeline so Undo works. Once a week through the W1.2 nudge gate
// (a scored nudge; "Show me now" and the chat ask are asked-for), and "How am I doing?" in chat.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { automationsFor } from './automations.ts';
import { fillTemplate, GALLERY } from './automation-templates.ts';
import { postAlert } from './destinations.ts';
import { en, trOwner } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { zonedParts } from './planner.ts';
import { saverSettings } from './spend.ts';
import { registerRevert, timelineOf, TimelineError, type TimelineRow } from './timeline.ts';
import { asksHowAmIDoing } from './her-week-words.ts';
import { howSheDid, type HowSheDid } from './how-she-did.ts';

export { asksHowAmIDoing };

const DAY_MS = 86_400_000;
/** A tip that was accepted or turned down is not offered again for eight weeks. */
const QUIET_DAYS = 56;
/** A slot found later than this (server was off) is remembered, not sent. */
const LATE_MIN = 24 * 60;

export interface HerWeekPrefs {
  on: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** Local "HH:MM". */
  time: string;
}
interface State extends HerWeekPrefs {
  /** Local date of the latest weekly slot she looked at (sent or not). */
  slot?: string;
  /** Tip id → when it was accepted or turned down. */
  acted: Record<string, string>;
}
export const HER_WEEK_DEFAULTS: HerWeekPrefs = { on: true, day: 0, time: '17:00' };

export interface HerTip {
  id: string;
  /** en() key the web translates. */
  text: string;
  /** Why now, en() key + params (optional). */
  why?: { key: string; params: Record<string, string | number> };
  /** Set on the stored card after Accept (timeline row id) or "Not now". */
  done?: number;
  no?: true;
}
export interface HerWeek {
  week: { from: string; to: string };
  did: { actions: number; byKind: Record<string, number>; toolCalls: number; turns: number };
  failed: { tools: { name: string; n: number }[]; failedCalls: number; claims: number; errors: number };
  cost: { usd: number; paidCalls: number; localCalls: number; topModel: string };
  /** F6: how she did this week (src/how-she-did.ts): counts and plain sentences, no message text. */
  how?: HowSheDid;
  tips: HerTip[];
}

const file = (app: AppContext) => join(app.dataDir, 'her-week.json');

function load(app: AppContext): State {
  let s: Partial<State> = {};
  try {
    if (existsSync(file(app))) s = JSON.parse(readFileSync(file(app), 'utf8')) as Partial<State>;
  } catch {
    s = {};
  }
  return { ...HER_WEEK_DEFAULTS, ...s, acted: s.acted && typeof s.acted === 'object' ? s.acted : {} };
}
function save(app: AppContext, s: State): void {
  const tmp = `${file(app)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, file(app));
}

export function herWeekPrefs(app: AppContext): HerWeekPrefs & { slot?: string } {
  const { on, day, time, slot } = load(app);
  return { on, day, time, ...(slot ? { slot } : {}) };
}
export function saveHerWeekPrefs(app: AppContext, p: Partial<HerWeekPrefs>): HerWeekPrefs {
  const s = load(app);
  if (typeof p.on === 'boolean') s.on = p.on;
  if (Number.isInteger(p.day) && p.day! >= 0 && p.day! <= 6) s.day = p.day!;
  if (typeof p.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) s.time = p.time;
  save(app, s);
  return herWeekPrefs(app);
}

// ------------------------------------------------------------------ the facts

type Row = Record<string, unknown>;
const hasTable = (app: AppContext, name: string) => Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const hasColumn = (app: AppContext, table: string, col: string) => (app.store.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => r.name === col);
const parse = (v: unknown): Record<string, unknown> => {
  try {
    return v ? (JSON.parse(String(v)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function gather(app: AppContext, now: Date): Omit<HerWeek, 'tips'> {
  const db = app.store.db;
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = new Date(now.getTime() + 1000).toISOString();
  const byKind: Record<string, number> = {};
  let actions = 0;
  timelineOf(app); // makes sure the table exists
  for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM action_timeline WHERE at >= ? AND at < ? AND tool != 'her_week' GROUP BY kind").all(from, to) as Row[]) {
    byKind[String(r.kind)] = Number(r.n);
    actions += Number(r.n);
  }
  let toolCalls = 0;
  let turns = 0;
  let claims = 0;
  const failedBy = new Map<string, number>();
  for (const r of db.prepare("SELECT role, meta FROM messages WHERE created_at >= ? AND created_at < ? AND role IN ('tool', 'user', 'assistant')").all(from, to) as Row[]) {
    if (r.role === 'user') turns++;
    else if (r.role === 'tool') {
      toolCalls++;
      const m = parse(r.meta);
      if (m.status === 'error') failedBy.set(String(m.name ?? '?'), (failedBy.get(String(m.name ?? '?')) ?? 0) + 1);
    } else if (r.meta && String(r.meta).includes('"unverified"')) {
      const u = parse(r.meta).unverified;
      claims += Array.isArray(u) ? u.length : 0;
    }
  }
  const errors = hasTable(app, 'runs') ? Number((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'error' AND started_at >= ? AND started_at < ?").get(from, to) as Row).n) : 0;
  const tools = [...failedBy].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 5);
  let usd = 0;
  let paidCalls = 0;
  let localCalls = 0;
  let topModel = '';
  if (hasTable(app, 'usage')) {
    const evals = hasTable(app, 'eval_runs') && hasColumn(app, 'usage', 'run_id') ? ' AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM eval_runs))' : '';
    const rows = db.prepare(`SELECT model, billing, COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd FROM usage WHERE at >= ? AND at < ?${evals} GROUP BY model, billing`).all(from, to) as Row[];
    let best = 0;
    for (const r of rows) {
      const cost = Number(r.usd) || 0;
      if (r.billing === 'local') localCalls += Number(r.n);
      else if (cost > 0) paidCalls += Number(r.n);
      usd += cost;
      if (cost > best) {
        best = cost;
        topModel = String(r.model);
      }
    }
  }
  let how: HowSheDid | undefined;
  try {
    how = howSheDid(app, from, to);
  } catch (err) {
    console.warn(`her week: how she did: ${(err as Error).message}`);
  }
  return {
    week: { from, to: now.toISOString() },
    did: { actions, byKind, toolCalls, turns },
    failed: { tools, failedCalls: [...failedBy.values()].reduce((a, b) => a + b, 0), claims, errors },
    cost: { usd: Math.round(usd * 100) / 100, paidCalls, localCalls, topModel },
    ...(how ? { how } : {}),
  };
}

// ------------------------------------------------------------------ the suggestions

interface Applied {
  undo: Record<string, unknown>;
}
interface TipDef {
  id: string;
  text: string;
  when: (app: AppContext, f: Omit<HerWeek, 'tips'>) => boolean;
  why?: (f: Omit<HerWeek, 'tips'>) => HerTip['why'];
  apply: (app: AppContext) => Applied;
}
const setting = <K extends 'tokenSaver' | 'weeklyReview' | 'briefing' | 'story' | 'memoryTidy'>(app: AppContext, key: K, value: unknown): Applied => {
  const before = app.settings.get()[key];
  app.settings.update({ [key]: value } as never);
  return { undo: { key, before: before === undefined ? null : before } };
};
const automationFrom = (app: AppContext, gallery: string): Applied => {
  const g = GALLERY.find((x) => x.id === gallery)!;
  const a = automationsFor(app).create(fillTemplate(g.template), { by: 'settings' });
  return { undo: { automation: a.id } };
};
const hasAutomation = (app: AppContext, name: string) => automationsFor(app).list().some((a) => a.name === name);

/** In order: problems the week showed first, then helpful defaults. Never money, never Always allow. */
const TIPS: readonly TipDef[] = [
  {
    id: 'saver',
    text: en('Turn on the token saver: on busy days I keep replies shorter so the week costs less.'),
    when: (app, f) => f.cost.usd >= 1 && saverSettings(app.settings.get()).mode === 'off',
    why: (f) => ({ key: en('Paid models cost about ${usd} this week.'), params: { usd: f.cost.usd.toFixed(2) } }),
    apply: (app) => setting(app, 'tokenSaver', { ...saverSettings(app.settings.get()), mode: 'auto' }),
  },
  {
    id: 'tidy',
    text: en('Let me tidy my memory once a day with the model on this computer, so I mix up fewer facts.'),
    when: (app, f) => f.failed.claims > 0 && !app.settings.get().memoryTidy?.on,
    why: (f) => ({ key: en('{n} of my sentences had nothing to back them up.'), params: { n: f.failed.claims } }),
    apply: (app) => setting(app, 'memoryTidy', { ...app.settings.get().memoryTidy, on: true, model: 'local' }),
  },
  {
    id: 'review',
    text: en('Get a weekly planner review: what got done, what slipped and a short plan.'),
    when: (app) => !app.settings.get().weeklyReview?.enabled,
    apply: (app) => setting(app, 'weeklyReview', { day: 0, time: '18:00', ...app.settings.get().weeklyReview, enabled: true }),
  },
  {
    id: 'briefing',
    text: en('Get a short morning briefing with your day, reminders and the weather.'),
    when: (app) => !app.settings.get().briefing?.enabled,
    apply: (app) => setting(app, 'briefing', { time: '07:30', ...app.settings.get().briefing, enabled: true }),
  },
  {
    id: 'auto-birthdays',
    text: en('Add the Birthday reminders automation: every morning I check for birthdays in the next 7 days.'),
    when: (app) => !hasAutomation(app, 'Birthday reminders'),
    apply: (app) => automationFrom(app, 'birthdays'),
  },
  {
    id: 'auto-grocery',
    text: en('Add the Grocery reorder reminder: Sundays at 10 AM I remind you to check the pantry.'),
    when: (app) => !hasAutomation(app, 'Grocery reorder reminder'),
    apply: (app) => automationFrom(app, 'grocery'),
  },
  {
    id: 'story',
    text: en('Get a yearly look back on our anniversary.'),
    when: (app) => !app.settings.get().story?.yearly,
    apply: (app) => setting(app, 'story', { ...app.settings.get().story, yearly: true }),
  },
];
/** Every suggestion id she may apply (tests check none of them touches money or Always allow). */
export const SAFE_TIPS: readonly string[] = TIPS.map((x) => x.id);

function pickTips(app: AppContext, f: Omit<HerWeek, 'tips'>): HerTip[] {
  const acted = load(app).acted;
  const cut = app.now().getTime() - QUIET_DAYS * DAY_MS;
  const out: HerTip[] = [];
  for (const d of TIPS) {
    if (out.length >= 3) break;
    if (acted[d.id] && Date.parse(acted[d.id]) > cut) continue;
    try {
      if (!d.when(app, f)) continue;
    } catch {
      continue;
    }
    const why = d.why?.(f);
    out.push({ id: d.id, text: d.text, ...(why ? { why } : {}) });
  }
  return out;
}

/** This week's check-in (the last 7 days up to now). */
export function herWeekFacts(app: AppContext, now: Date = app.now()): HerWeek {
  const f = gather(app, now);
  return { ...f, tips: pickTips(app, f) };
}

function mark(app: AppContext, id: string, messageId: number | undefined, patch: Partial<HerTip>): void {
  const s = load(app);
  s.acted[id] = app.now().toISOString();
  save(app, s);
  if (messageId === undefined) return;
  const m = app.store.messageById(messageId);
  const card = m?.meta?.herWeek as HerWeek | undefined;
  if (!card || !Array.isArray(card.tips)) return;
  app.store.updateMessageMeta(messageId, { herWeek: { ...card, tips: card.tips.map((x) => (x.id === id ? { ...x, ...patch } : x)) } });
}

/** One-tap Accept: applies the suggestion and puts it on the action timeline (Undo there or on the card). */
export function herWeekAccept(app: AppContext, id: string, messageId?: number): TimelineRow {
  const d = TIPS.find((x) => x.id === id);
  if (!d) throw new TimelineError(400, en('That suggestion isn’t one she can apply.'));
  const done = d.apply(app);
  const row = timelineOf(app).record({ tool: 'her_week', kind: 'settings', summary: `Weekly check-in: ${d.id}`, undo: { type: 'herweek', tip: d.id, ...(messageId !== undefined ? { message: messageId } : {}), ...done.undo }, title: d.text, params: {}, why: { cause: { kind: 'click' }, rule: 'click' } });
  mark(app, id, messageId, { done: row.id });
  return row;
}
/** "Not now": not offered again for eight weeks. */
export function herWeekSkip(app: AppContext, id: string, messageId?: number): void {
  if (!TIPS.some((x) => x.id === id)) throw new TimelineError(400, en('That suggestion isn’t one she can apply.'));
  mark(app, id, messageId, { no: true });
}

registerRevert('herweek', (u, app) => {
  // The card shows the idea again (Accept / Not now) after an Undo, also after a reload.
  if (typeof u.message === 'number' && typeof u.tip === 'string') {
    const card = app.store.messageById(u.message)?.meta?.herWeek as HerWeek | undefined;
    if (card && Array.isArray(card.tips)) app.store.updateMessageMeta(u.message, { herWeek: { ...card, tips: card.tips.map((x) => (x.id === u.tip ? { id: x.id, text: x.text, ...(x.why ? { why: x.why } : {}) } : x)) } });
  }
  if (typeof u.automation === 'number') {
    automationsFor(app).remove(u.automation);
    return;
  }
  const key = String(u.key);
  if (!['tokenSaver', 'weeklyReview', 'briefing', 'story', 'memoryTidy'].includes(key)) throw new TimelineError(409, en('That change can’t be undone any more.'));
  app.settings.update({ [key]: u.before ?? undefined } as never);
});

// ------------------------------------------------------------------ words

/** Her message in the owner's language (the card itself is translated by the web). */
export function herWeekText(app: AppContext, w: HerWeek): string {
  const s = app.settings.get();
  const tz = s.timeZone;
  const day = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(iso));
  const T = (k: string, p?: Record<string, unknown>) => trOwner(k, s, p);
  const out = [T(en('Here’s how this week went ({from} – {to}).'), { from: day(w.week.from), to: day(w.week.to) })];
  out.push(w.did.actions || w.did.toolCalls ? T(en('What I did: {actions} changes and {tools} tool runs, across {turns} of your messages.'), { actions: w.did.actions, tools: w.did.toolCalls, turns: w.did.turns }) : T(en('What I did: nothing that changed anything this week.')));
  const bad = w.failed.failedCalls + w.failed.claims + w.failed.errors;
  out.push(bad ? T(en('What didn’t work: failed tool runs {failed} · claims I couldn’t back up {claims} · replies that ended in an error {errors}.'), { failed: w.failed.failedCalls, claims: w.failed.claims, errors: w.failed.errors }) : T(en('What didn’t work: nothing failed this week.')));
  out.push(w.cost.usd > 0 ? T(en('What cost money: about ${usd} on paid models ({paid} paid calls; {local} free ones on this computer).'), { usd: w.cost.usd.toFixed(2), paid: w.cost.paidCalls, local: w.cost.localCalls }) : T(en('What cost money: nothing on paid models this week.')));
  if (w.how?.lines.length) out.push(T(en('How I did this week:')), ...w.how.lines.map((l) => `- ${T(l.key, l.params)}`));
  if (w.tips.length) out.push(T(en('My ideas for next week (tap Accept on one to use it):')), ...w.tips.map((x, i) => `${i + 1}. ${T(x.text)}`));
  return out.join('\n');
}

/** chat.ts: "How am I doing?" → her reply + the card, no model call. */
export function herWeekTurn(app: AppContext, text: string): { reply: string; meta: { herWeek: HerWeek } } | undefined {
  if (!asksHowAmIDoing(text, app.persona?.name)) return undefined;
  const w = herWeekFacts(app);
  return { reply: herWeekText(app, w), meta: { herWeek: w } };
}

/** Sends the check-in now (Settings "Show me now": asked for, so it skips the daily nudge budget). */
export function sendHerWeek(app: AppContext, asked: boolean): string | undefined {
  const w = herWeekFacts(app);
  const content = herWeekText(app, w);
  return postAlert(app, 'herweek', { role: 'assistant', content, meta: { herWeek: w }, reason: 'proactive', nudge: { kind: 'herweek', value: 0.7, ...(asked ? { urgency: 'reminder' as const } : {}) } });
}

function slotOf(now: Date, tz: string | undefined, day: number, time: string): { slot: string; lateMin: number } {
  const p = zonedParts(now, tz);
  const [hh, mm] = time.split(':').map(Number);
  const nowMin = p.h * 60 + p.mi;
  let back = (p.wd - day + 7) % 7;
  if (back === 0 && nowMin < hh * 60 + mm) back = 7;
  const today = localDate(now, tz);
  const slot = new Date(Date.parse(`${today}T12:00:00Z`) - back * DAY_MS).toISOString().slice(0, 10);
  return { slot, lateMin: back * 1440 + nowMin - (hh * 60 + mm) };
}

/** ReminderScheduler.tick: once a week at the chosen day and time. Returns the chat it went to. */
export function herWeekTick(app: AppContext, now: Date = app.now()): string | undefined {
  // Y9: never on the demo. Its data folder must stay empty (the demo refuses to start on one that holds a
  // chat), and a weekly check-in written there on 2026-11-22 took the demo down at its next restart.
  if (app.demo) return undefined;
  const s = load(app);
  if (!s.on) return undefined;
  const { slot, lateMin } = slotOf(now, app.settings.get().timeZone, s.day, s.time);
  if (s.slot === slot) return undefined;
  const first = s.slot === undefined;
  s.slot = slot;
  save(app, s);
  // A fresh look (new install, just switched on, changed day) never sends an old week at once.
  if (first || lateMin > LATE_MIN) return undefined;
  return sendHerWeek(app, false);
}

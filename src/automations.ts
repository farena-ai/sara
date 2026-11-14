// N2 (docs/AUTOMATIONS.md): automations, one place. "When ___, do ___."
//
// An automation is a trigger, an optional condition and a list of actions. Triggers: a schedule
// (every day / weekday / chosen weekdays / a day of the month, at a time in the person's zone), an
// email (C4's email source), a webhook (C4's webhook source), a live-data watch (E1), a product watch
// (E2), a file watch (E4) or a calendar event that starts in N minutes (the connected calendar, else
// the planner's reminders). Actions: tell me, ask Sara to do a task (an ordinary turn in the
// automation's own chat, with the person's normal approvals), draft an email, fill a document, run a
// recipe, add a bill or an expense (the last three are written instructions to her, so the money and
// recipe tools keep their own approvals).
//
// Nothing new ticks: schedules and calendar triggers ride the reminder scheduler's 15-second tick
// (src/reminders.ts), event triggers arrive through C4's observe() and the watches' fire paths.
// Changes keep their approvals: an action whose tool is set to ask holds the run (outcome
// "waiting") until the person taps Allow; a tool set to never fails the action. Drafts are never sent
// unless the person turned on "send without asking" for that automation AND mail_send itself runs
// without asking. One run at a time per automation; the last 50 runs are kept; three failed runs in a
// row pause it with a notification and the reason. A dry run performs nothing: no draft, no copy, no
// turn, no phone notification; it says what would happen and drops one chat line labeled as a test.
//
// The existing rows (C4 triggers, E1/E2/E4 watches, routines, repeating reminders, loops) are shown
// here through adapters that read and write their own stores; nothing is migrated.
//
// Tables (additive, the space's own store.db, so each household member has their own): automations,
// automation_runs.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext, ChatEvent } from './chat.ts';
import { matches, type TriggerEvent } from './event-triggers.ts';
import { en, trOwner } from './i18n.ts';
import { quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import { spendSettings, spentNow } from './spend.ts';
import { calendarEvents, hasCalendar, type TodayEvent } from './today.ts';
import { createFillDocumentTool, findForm } from './tools/fill-document.ts';
import type { Permission, Tool, ToolContext } from './tools/types.ts';

export const AUTOMATION = { max: 50, keepRuns: 50, failPause: 3, lateMs: 12 * 3600_000, calendarEveryMs: 5 * 60_000, taskTokens: 40_000, taskMinutes: 15, seenRing: 100 } as const;
export const EVERY = ['day', 'weekdays', 'week', 'month'] as const;
export type Every = (typeof EVERY)[number];
export const TRIGGER_KINDS = ['schedule', 'email', 'webhook', 'live', 'product', 'file', 'calendar'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const ACTION_KINDS = ['notify', 'task', 'draft_email', 'fill', 'recipe', 'expense', 'bill'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ScheduleTrigger {
  kind: 'schedule';
  every: Every;
  /** "HH:MM", 24-hour, the person's time zone. */
  time: string;
  /** every: 'week': 0 (Sunday) … 6 (Saturday). */
  days?: number[];
  /** every: 'month': 1 … 31 (the last day in shorter months). */
  day?: number;
}
export interface EmailTrigger {
  kind: 'email';
  from?: string;
  words?: string;
}
export interface WebhookTrigger {
  kind: 'webhook';
  hookId: string;
  event?: string;
}
export interface WatchTrigger {
  kind: 'live' | 'product' | 'file';
  /** The watch's id in its own store. */
  ref: number;
  label?: string;
}
export interface CalendarTrigger {
  kind: 'calendar';
  minutes: number;
  words?: string;
}
export type Trigger = ScheduleTrigger | EmailTrigger | WebhookTrigger | WatchTrigger | CalendarTrigger;

/** Time sheet rules ("shifts are 2200-0700, no lunch"). */
export interface TimesheetRules {
  /** Which week: the one the run falls in, or the one before. */
  week?: 'this' | 'last';
  /** The week starts on (0 Sunday, 1 Monday). */
  weekStart?: number;
  /** Fixed shift times, "HHMM" (used for all-day work events, or for every listed day). */
  start?: string;
  end?: string;
  lunchMinutes?: number;
  regularHours?: number;
  /** Only events whose title has one of these words count as work (default: every timed event). */
  words?: string;
  /** No calendar events: these weekdays (0-6) are work days with the fixed shift. */
  days?: number[];
  /** Also write TOTAL HOURS (leave off when the template totals with formulas). */
  total?: boolean;
}
export interface Action {
  kind: ActionKind;
  /** notify: the message ({week}, {detail}, {files} are filled in). */
  text?: string;
  how?: 'chat' | 'phone' | 'desktop';
  /** task / recipe / expense / bill: the written instruction (recipe: its name). */
  prompt?: string;
  /** draft_email */
  to?: string;
  subject?: string;
  body?: string;
  sendWithoutAsking?: boolean;
  /** fill */
  document?: string;
  /** fill: the template's Library id, pinned when it was made (its filled copies share its name). */
  docId?: number;
  values?: Record<string, string | number>;
  timesheet?: TimesheetRules;
  title?: string;
}
export interface Automation {
  id: number;
  name: string;
  trigger: Trigger;
  condition: { words?: string } | null;
  actions: Action[];
  enabled: boolean;
  pausedReason: string | null;
  owner: 'owner' | 'member';
  createdBy: 'chat' | 'settings';
  conversationId: string | null;
  nextAt: string | null;
  fails: number;
  createdAt: string;
  updatedAt: string;
}
export type Outcome = 'running' | 'done' | 'failed' | 'waiting' | 'declined' | 'skipped' | 'test';
export interface StepResult {
  kind: ActionKind;
  status: 'done' | 'failed' | 'waiting' | 'skipped' | 'test' | 'declined';
  text: string;
}
export interface AutomationRun {
  id: number;
  automationId: number;
  at: string;
  endedAt: string | null;
  trigger: string;
  outcome: Outcome;
  summary: string;
  steps: StepResult[];
  dry: boolean;
  conversationId: string | null;
}
export interface Draft {
  name?: string;
  trigger: Trigger | (Omit<WatchTrigger, 'ref'> & { ref?: number; watch?: Record<string, unknown> });
  condition?: { words?: string } | null;
  actions: Action[];
}

export class AutomationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Plain words for every error (translated through trOwner on the routes). */
export const AUTOMATION_LINES = [en('Automation not found.'), en('Give it a name.'), en('Pick when it runs.'), en('Pick a time like 15:00.'), en('Pick at least one day.'), en('Add at least one thing to do.'), en('Write what she should do.'), en('Who is the email to?'), en('Say which document to fill.'), en('You have the most automations this keeps.'), en('Pick the webhook.'), en('Email and webhook automations are the owner’s only.'), en('Automations can’t be set up from a private chat.'), en('That watch isn’t there.'), en('This one is turned on where it was set up.'), en('Nothing is waiting for your OK on this run.')];

type Row = Record<string, string | number | null>;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const line = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------- schedule math (pure)

function lastDay(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function dayMatches(t: ScheduleTrigger, y: number, mo: number, d: number, wd: number): boolean {
  if (t.every === 'day') return true;
  if (t.every === 'weekdays') return wd >= 1 && wd <= 5;
  if (t.every === 'week') return (t.days ?? []).includes(wd);
  return d === Math.min(t.day ?? 1, lastDay(y, mo));
}
/** The next run strictly after `after`, in the person's zone (DST-safe through zonedToUtc). */
export function nextRun(t: ScheduleTrigger, after: Date, tz?: string): Date | null {
  const m = TIME.exec(t.time);
  if (!m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  const p = zonedParts(after, tz);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const [y, mo, d, wd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    if (!dayMatches(t, y, mo, d, wd)) continue;
    const at = zonedToUtc(y, mo, d, h, mi, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}
/** The next `n` runs. */
export function nextRuns(t: ScheduleTrigger, after: Date, tz: string | undefined, n = 3): Date[] {
  const out: Date[] = [];
  let at: Date | null = after;
  while (out.length < n && at) {
    at = nextRun(t, at, tz);
    if (at) out.push(at);
  }
  return out;
}

// ---------------------------------------------------------------- the time sheet (pure)

const hhmm = (s: string | undefined): number | undefined => {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s ?? '').trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};
const pad = (n: number) => String(n).padStart(2, '0');
const asHHMM = (min: number) => `${pad(Math.floor(min / 60) % 24)}${pad(min % 60)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface TimesheetDay {
  day: string;
  date: string;
  start: string;
  end: string;
  hours: number;
  regular: number;
  overtime: number;
}
/** The local dates (YYYY-MM-DD) of the week a time falls in (or the one before). */
export function weekOf(at: Date, tz: string | undefined, rules: TimesheetRules = {}): string[] {
  const p = zonedParts(at, tz);
  const start = rules.weekStart ?? 0;
  const back = (p.wd - start + 7) % 7 + (rules.week === 'last' ? 7 : 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d - back + i));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  });
}
/**
 * Daily start/end/hours from the week's work events and the person's rules. An overnight shift
 * counts on the day it starts. All-day work events (or `days` with no calendar) use the fixed shift.
 */
export function timesheetDays(events: { title: string; start: string; end?: string; allDay: boolean; id?: string }[], week: string[], tz: string | undefined, rules: TimesheetRules = {}): TimesheetDay[] {
  const words = (rules.words ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const work = events.filter((e) => !words.length || words.some((w) => e.title.toLowerCase().includes(w)));
  const fixedStart = hhmm(rules.start);
  const fixedEnd = hhmm(rules.end);
  const lunch = Math.max(0, rules.lunchMinutes ?? 0);
  const regularMax = rules.regularHours ?? 8;
  const localDay = (iso: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { date: iso, min: 0 };
    const p = zonedParts(new Date(iso), tz);
    return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, min: p.h * 60 + p.mi };
  };
  const out: TimesheetDay[] = [];
  for (const date of week) {
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    const today = work.filter((e) => localDay(e.start).date === date);
    let startMin: number | undefined;
    let minutes = 0;
    const timed = today.filter((e) => !e.allDay && e.end);
    if (timed.length) {
      const first = Math.min(...timed.map((e) => Date.parse(e.start)));
      const last = Math.max(...timed.map((e) => Date.parse(e.end!)));
      startMin = localDay(new Date(first).toISOString()).min;
      minutes = (last - first) / 60_000;
    } else if ((today.length || (!events.length && (rules.days ?? []).includes(wd))) && fixedStart !== undefined && fixedEnd !== undefined) {
      startMin = fixedStart;
      minutes = (fixedEnd - fixedStart + 1440) % 1440 || 1440;
    }
    if (startMin === undefined || minutes <= 0) continue;
    const hours = round2(Math.max(0, minutes - lunch) / 60);
    const regular = round2(Math.min(hours, regularMax));
    out.push({ day: DAY_NAMES[wd]!.toUpperCase(), date, start: asHHMM(startMin), end: asHHMM((startMin + minutes) % 1440), hours, regular, overtime: round2(hours - regular) });
  }
  return out;
}
/** The fill_document arguments for a week (labels as in the usual weekly time sheet). */
export function timesheetFill(days: TimesheetDay[], week: string[], rules: TimesheetRules, values: Record<string, string | number> = {}): { values: Record<string, string | number>; tables: { table: string; rows: Record<string, string | number>[] }[] } {
  const [y, mo, d] = week[0]!.split('-');
  const rows = days.map((x) => ({ DAY: x.day, 'START TIME': x.start, 'END TIME': x.end, 'REGULAR HOURS': x.regular, ...(x.overtime ? { 'OVERTIME HOURS': x.overtime } : {}), ...(rules.total ? { 'TOTAL HOURS': x.hours } : {}) }));
  return { values: { 'WEEK OF': `${mo}/${d}/${y}`, ...values }, tables: rows.length ? [{ table: 'DAY', rows }] : [] };
}

// ---------------------------------------------------------------- plain words → a draft (pure)

const WD: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAYW = String.raw`(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
/** The words without their "when" ("every Friday at 3,", "daily", "on the 1st of every month"). */
export function withoutWhen(s: string): string {
  return s
    .replace(/\b(?:on\s+)?the\s+\d{1,2}(?:st|nd|rd|th)(?:\s+of\s+(?:every|each|the)\s+month)?/gi, ' ')
    .replace(new RegExp(String.raw`\b(?:every|each|on)\s+(?:other\s+)?(?:day|weekday|work ?day|week|month|morning|evening|night|${DAYW})s?(?:\s*(?:,|and|&)\s*${DAYW})*`, 'gi'), ' ')
    .replace(/\bat\s+(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/gi, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/gi, ' ')
    .replace(/\b(?:daily|weekly|monthly|on weekdays)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]*(?:to\s+)?/i, '')
    .replace(/^[\s,.:;-]+|[\s,]+$/g, '')
    .trim();
}
/** "every Friday at 3, fill my time sheet …" → a draft (the model may give the structure itself). */
export function draftFromWords(words: string): Draft {
  const s = words.toLowerCase();
  let time = '09:00';
  const tm = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(s) ?? /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/.exec(s);
  if (/\bnoon\b/.test(s)) time = '12:00';
  else if (tm) {
    let h = Number(tm[1]);
    const ap = tm[3]?.[0];
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12;
    time = `${pad(Math.min(23, h))}:${tm[2] ?? '00'}`;
  } else if (/\bmorning\b/.test(s)) time = '08:00';
  else if (/\bevening\b/.test(s)) time = '18:00';
  const days = [...s.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/g)].map((m) => WD[m[1]!]!).filter((v, i, a) => a.indexOf(v) === i);
  const monthDay = /\b(?:on the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(s);
  let trigger: Draft['trigger'];
  const from = /\bemail(?:s)?\s+(?:arrives?\s+|comes?\s+in\s+)?from\s+([^\s,]+)/.exec(s)?.[1];
  const before = /(\d{1,3})\s*min(?:ute)?s?\s+before\s+(?:a|an|each|every|my)?\s*(?:calendar\s+)?(?:event|meeting)/.exec(s);
  if (from || /\bwhen(?:ever)?\s+(?:an?\s+)?(?:new\s+)?email\b/.test(s)) trigger = { kind: 'email', ...(from ? { from } : {}) };
  else if (before) trigger = { kind: 'calendar', minutes: Number(before[1]) };
  else if (/\bweekdays?\b|\bevery work ?day\b/.test(s)) trigger = { kind: 'schedule', every: 'weekdays', time };
  else if (/\bmonth(ly)?\b/.test(s)) trigger = { kind: 'schedule', every: 'month', day: Math.min(31, Math.max(1, Number(monthDay?.[1] ?? 1))), time };
  else if (days.length) trigger = { kind: 'schedule', every: 'week', days, time };
  else if (/\bweek(ly)?\b/.test(s)) trigger = { kind: 'schedule', every: 'week', days: [1], time };
  else trigger = { kind: 'schedule', every: 'day', time };
  const actions: Action[] = [];
  const instruction = withoutWhen(words) || words.trim();
  if (/time ?sheet/.test(s)) {
    const shift = /(\d{1,2}:?\d{2})\s*(?:-|–|to)\s*(\d{1,2}:?\d{2})/.exec(s);
    const lunch = /no lunch/.test(s) ? 0 : Number(/(\d{2})\s*min(?:ute)?s?\s+lunch|lunch\s+(?:is\s+)?(\d{2})/.exec(s)?.slice(1).find(Boolean) ?? 0);
    actions.push({ kind: 'fill', document: 'time sheet', timesheet: { week: /last week/.test(s) ? 'last' : 'this', ...(shift ? { start: shift[1]!.replace(':', ''), end: shift[2]!.replace(':', '') } : {}), lunchMinutes: lunch } });
    actions.push({ kind: 'notify', text: 'Your time sheet for the week of {week} is filled: {files}. Check it, then send it on.', how: 'phone' });
    // N4: “…and email it to boss@work.com”: a draft to them with the filled copy attached (never sent unless turned on).
    const mailTo = /\b(?:send|email|e-mail|mail)\b[^@]{0,60}?\b([^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,})/i.exec(words)?.[1];
    if (mailTo) actions.push({ kind: 'draft_email', to: mailTo, subject: 'Time sheet – week of {week}', body: 'Hi,\n\nHere is my time sheet for the week of {week} (attached).\n\nThanks' });
  } else if (/^\s*(?:.*\b)?remind me\b/.test(s)) {
    actions.push({ kind: 'notify', text: withoutWhen(words.replace(/^.*?\bremind me\b/i, '')) || words.trim(), how: 'phone' });
  } else actions.push({ kind: 'task', prompt: instruction });
  const name = /time ?sheet/.test(s) ? 'Fill my time sheet every week' : clip(instruction.replace(/^./, (c) => c.toUpperCase()), 60);
  return { name, trigger, actions };
}

// ---------------------------------------------------------------- starters

export const STARTERS: { id: string; name: string; pitch: string; draft: Draft }[] = [
  {
    id: 'timesheet',
    name: en('Fill my time sheet every week'),
    pitch: en('Every Friday at 3 PM: reads the week’s work events from your calendar (or your shift rules), fills your own time sheet template and sends you the filled copy to check.'),
    draft: {
      name: 'Fill my time sheet every week',
      trigger: { kind: 'schedule', every: 'week', days: [5], time: '15:00' },
      actions: [
        { kind: 'fill', document: 'time sheet', timesheet: { week: 'this', lunchMinutes: 0, regularHours: 8 } },
        { kind: 'notify', text: 'Your time sheet for the week of {week} is filled: {files}. Check it, then send it on.', how: 'phone' },
      ],
    },
  },
];

// ---------------------------------------------------------------- the store and the runner

export interface AutomationOptions {
  /** Tests: a fake task turn (default: app.runTracked in the automation's chat). */
  runTask?: (r: { automation: Automation; conversationId: string; content: string }) => Promise<{ reply: string; error?: string; declined?: boolean; asked?: boolean }>;
  /** Tests: catch notifications (default: app.push.notifyOwner). */
  notify?: (title: string, body: string, conversationId: string, tag: string) => Promise<void>;
  /** Tests: the calendar (default: the connected calendar through today.ts). */
  calendar?: (from: Date, to: Date) => Promise<Pick<TodayEvent, 'id' | 'title' | 'start' | 'end' | 'allDay'>[]>;
  quiet?: () => boolean;
}

interface RunCtx {
  files: { id: string; name: string; mime: string; bytes: number; made?: import('./tools/types.ts').MadeRef }[];
  week?: string;
  detail: string;
  /** The action the person allowed (index): runs once without asking again. */
  allowed?: number;
}

export class Automations {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: AutomationOptions;
  readonly #running = new Set<number>();
  readonly #work = new Set<Promise<unknown>>();
  #calBusy = false;

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: AutomationOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  condition_json TEXT,
  actions_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  paused_reason TEXT,
  owner TEXT NOT NULL DEFAULT 'owner',
  created_by TEXT NOT NULL DEFAULT 'chat',
  conversation_id TEXT,
  next_at TEXT,
  memo_json TEXT NOT NULL DEFAULT '{}',
  fails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  ended_at TEXT,
  trigger_detail TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  dry INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  held_json TEXT
);
CREATE INDEX IF NOT EXISTS automation_runs_a ON automation_runs (automation_id, id);
`);
    // A restart ends what was running (a run waiting for an OK keeps waiting).
    db.prepare("UPDATE automation_runs SET outcome = 'failed', summary = 'interrupted by a restart', ended_at = at WHERE outcome = 'running'").run();
  }

  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone;
  }
  #T(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }

  #row(r: Row): Automation {
    return {
      id: Number(r.id),
      name: String(r.name),
      trigger: JSON.parse(String(r.trigger_json)) as Trigger,
      condition: r.condition_json ? (JSON.parse(String(r.condition_json)) as { words?: string }) : null,
      actions: JSON.parse(String(r.actions_json)) as Action[],
      enabled: Number(r.enabled) === 1,
      pausedReason: r.paused_reason ? String(r.paused_reason) : null,
      owner: r.owner === 'member' ? 'member' : 'owner',
      createdBy: r.created_by === 'settings' ? 'settings' : 'chat',
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      nextAt: r.next_at ? String(r.next_at) : null,
      fails: Number(r.fails),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  list(): Automation[] {
    return (this.#db.prepare('SELECT * FROM automations ORDER BY id').all() as Row[]).map((r) => this.#row(r));
  }
  get(id: number): Automation | undefined {
    const r = this.#db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }
  #must(id: number): Automation {
    const a = this.get(id);
    if (!a) throw new AutomationError(404, en('Automation not found.'));
    return a;
  }
  #memo(id: number): Record<string, unknown> {
    const r = this.#db.prepare('SELECT memo_json FROM automations WHERE id = ?').get(id) as { memo_json: string } | undefined;
    return r ? (JSON.parse(r.memo_json) as Record<string, unknown>) : {};
  }
  #setMemo(id: number, memo: Record<string, unknown>): void {
    this.#db.prepare('UPDATE automations SET memo_json = ? WHERE id = ?').run(JSON.stringify(memo), id);
  }

  // ------------------------------------------------ cleaning a draft

  #cleanTrigger(raw: unknown, createWatch: boolean): Trigger {
    const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const kind = TRIGGER_KINDS.find((k) => k === t.kind);
    if (!kind) throw new AutomationError(400, en('Pick when it runs.'));
    if (kind === 'schedule') {
      const every = EVERY.find((e) => e === t.every) ?? 'day';
      const time = line(t.time, 5);
      if (!TIME.test(time)) throw new AutomationError(400, en('Pick a time like 15:00.'));
      const [h, m] = time.split(':');
      const out: ScheduleTrigger = { kind, every, time: `${pad(Number(h))}:${m}` };
      if (every === 'week') {
        const days = (Array.isArray(t.days) ? t.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (!days.length) throw new AutomationError(400, en('Pick at least one day.'));
        out.days = [...new Set(days)].sort();
      }
      if (every === 'month') out.day = Math.min(31, Math.max(1, Math.round(Number(t.day) || 1)));
      return out;
    }
    if (kind === 'email' || kind === 'webhook') {
      if (this.#app.member || !this.#app.eventTriggers) throw new AutomationError(403, en('Email and webhook automations are the owner’s only.'));
      if (kind === 'email') return { kind, ...(line(t.from, 120) ? { from: line(t.from, 120) } : {}), ...(line(t.words, 120) ? { words: line(t.words, 120) } : {}) };
      const hookId = line(t.hookId, 80);
      if (!hookId) throw new AutomationError(400, en('Pick the webhook.'));
      return { kind, hookId, ...(line(t.event, 120) ? { event: line(t.event, 120) } : {}) };
    }
    if (kind === 'calendar') return { kind, minutes: Math.min(24 * 60, Math.max(0, Math.round(Number(t.minutes ?? 15)))), ...(line(t.words, 80) ? { words: line(t.words, 80) } : {}) };
    // A watch: an existing one (ref), or a new one made through its own store.
    let ref = Number(t.ref);
    if (!(Number.isInteger(ref) && ref > 0) && createWatch && t.watch && typeof t.watch === 'object') ref = this.#makeWatch(kind, t.watch as Record<string, unknown>);
    const label = this.#watchLabel(kind, ref);
    if (label === undefined) throw new AutomationError(400, en('That watch isn’t there.'));
    return { kind, ref, label };
  }
  #makeWatch(kind: 'live' | 'product' | 'file', w: Record<string, unknown>): number {
    const app = this.#app;
    if (kind === 'live' && app.liveWatches) return app.liveWatches.add({ ...w, how: 'chat' }).id;
    if (kind === 'product' && app.productWatches) return app.productWatches.add({ url: String(w.url ?? ''), label: String(w.label ?? w.url ?? ''), condition: (w.condition as 'back_in_stock') ?? 'any_change', ...(w.threshold !== undefined ? { threshold: Number(w.threshold) } : {}) }).id;
    if (kind === 'file' && app.watches) return app.watches.create(w).id;
    throw new AutomationError(400, en('That watch isn’t there.'));
  }
  #watchLabel(kind: 'live' | 'product' | 'file', ref: number): string | undefined {
    const app = this.#app;
    if (kind === 'live') return app.liveWatches?.get(ref)?.label;
    if (kind === 'product') return app.productWatches?.get(ref)?.label;
    const w = app.watches?.get(ref);
    return w ? `${w.file}: ${w.patterns.join(', ')}` : undefined;
  }
  #cleanActions(raw: unknown): Action[] {
    const list = Array.isArray(raw) ? raw.slice(0, 6) : [];
    const out: Action[] = [];
    for (const x of list) {
      const a = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
      const kind = ACTION_KINDS.find((k) => k === a.kind);
      if (!kind) continue;
      const how = a.how === 'chat' || a.how === 'desktop' ? a.how : 'phone';
      if (kind === 'notify') out.push({ kind, text: line(a.text, 500) || 'Your automation ran.', how });
      else if (kind === 'task' || kind === 'recipe' || kind === 'expense' || kind === 'bill') {
        const prompt = String(a.prompt ?? '').replace(/\u0000/g, '').trim().slice(0, 2000);
        if (!prompt) throw new AutomationError(400, en('Write what she should do.'));
        out.push({ kind, prompt });
      } else if (kind === 'draft_email') {
        const to = line(a.to, 200);
        if (!/@/.test(to)) throw new AutomationError(400, en('Who is the email to?'));
        out.push({ kind, to, subject: line(a.subject, 200) || 'From your automation', body: String(a.body ?? '').slice(0, 4000), ...(a.sendWithoutAsking === true ? { sendWithoutAsking: true } : {}) });
      } else if (kind === 'fill') {
        const document = line(a.document, 200);
        if (!document) throw new AutomationError(400, en('Say which document to fill.'));
        const values = a.values && typeof a.values === 'object' ? Object.fromEntries(Object.entries(a.values as Record<string, unknown>).slice(0, 40).map(([k, v]) => [line(k, 80), typeof v === 'number' ? v : line(v, 200)])) : undefined;
        const ts = a.timesheet && typeof a.timesheet === 'object' ? (a.timesheet as Record<string, unknown>) : undefined;
        const timesheet: TimesheetRules | undefined = ts
          ? {
              week: ts.week === 'last' ? 'last' : 'this',
              weekStart: ts.weekStart === 1 ? 1 : 0,
              ...(hhmm(String(ts.start ?? '')) !== undefined ? { start: String(ts.start).replace(':', '').padStart(4, '0') } : {}),
              ...(hhmm(String(ts.end ?? '')) !== undefined ? { end: String(ts.end).replace(':', '').padStart(4, '0') } : {}),
              lunchMinutes: Math.min(240, Math.max(0, Math.round(Number(ts.lunchMinutes ?? 0)))),
              regularHours: Math.min(24, Math.max(1, Number(ts.regularHours ?? 8))),
              ...(line(ts.words, 80) ? { words: line(ts.words, 80) } : {}),
              ...(Array.isArray(ts.days) ? { days: ts.days.map(Number).filter((d) => d >= 0 && d <= 6) } : {}),
              ...(ts.total === true ? { total: true } : {}),
            }
          : undefined;
        let docId = Number.isInteger(a.docId) && this.#app.library?.get(Number(a.docId)) ? Number(a.docId) : undefined;
        if (docId === undefined && this.#app.library) {
          try {
            docId = findForm(this.#app.library.list(), document).id;
          } catch {
            docId = undefined;
          }
        }
        out.push({ kind, document, ...(docId !== undefined ? { docId } : {}), ...(values ? { values } : {}), ...(timesheet ? { timesheet } : {}), ...(line(a.title, 120) ? { title: line(a.title, 120) } : {}) });
      }
    }
    if (!out.length) throw new AutomationError(400, en('Add at least one thing to do.'));
    return out;
  }
  /** A checked draft (no row, no watch made): what preview and dry run use. */
  clean(draft: Draft | Record<string, unknown>, o: { createWatch?: boolean } = {}): { name: string; trigger: Trigger; condition: { words?: string } | null; actions: Action[] } {
    const d = draft as Record<string, unknown>;
    const actions = this.#cleanActions(d.actions);
    const trigger = this.#cleanTrigger(d.trigger, o.createWatch === true);
    const name = line(d.name, 80);
    if (!name) throw new AutomationError(400, en('Give it a name.'));
    const words = d.condition && typeof d.condition === 'object' ? line((d.condition as Record<string, unknown>).words, 120) : '';
    return { name, trigger, condition: words ? { words } : null, actions };
  }

  // ------------------------------------------------ create, change, remove

  create(draft: Draft | Record<string, unknown>, o: { by?: 'chat' | 'settings'; conversationId?: string | null } = {}): Automation {
    if (o.conversationId && this.#app.store.getConversation(o.conversationId)?.private) throw new AutomationError(403, en('Automations can’t be set up from a private chat.'));
    if (this.list().length >= AUTOMATION.max) throw new AutomationError(409, en('You have the most automations this keeps.'));
    const c = this.clean(draft, { createWatch: true });
    const iso = this.#now().toISOString();
    const next = c.trigger.kind === 'schedule' ? (nextRun(c.trigger, this.#now(), this.#tz())?.toISOString() ?? null) : null;
    const id = Number(
      this.#db
        .prepare('INSERT INTO automations (name, trigger_json, condition_json, actions_json, enabled, owner, created_by, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
        .run(c.name, JSON.stringify(c.trigger), c.condition ? JSON.stringify(c.condition) : null, JSON.stringify(c.actions), this.#app.member ? 'member' : 'owner', o.by ?? 'chat', next, iso, iso).lastInsertRowid,
    );
    this.#app.events?.publish({ type: 'automations' });
    return this.get(id)!;
  }
  /** Edit: name, trigger (time/days), condition, actions. */
  patch(id: number, body: Record<string, unknown>): Automation {
    const cur = this.#must(id);
    const c = this.clean({ name: body.name ?? cur.name, trigger: body.trigger ? { ...cur.trigger, ...(body.trigger as object) } : cur.trigger, condition: body.condition ?? cur.condition, actions: body.actions ?? cur.actions });
    const next = c.trigger.kind === 'schedule' ? (nextRun(c.trigger, this.#now(), this.#tz())?.toISOString() ?? null) : null;
    this.#db.prepare('UPDATE automations SET name = ?, trigger_json = ?, condition_json = ?, actions_json = ?, next_at = ?, updated_at = ? WHERE id = ?').run(c.name, JSON.stringify(c.trigger), c.condition ? JSON.stringify(c.condition) : null, JSON.stringify(c.actions), next, this.#now().toISOString(), id);
    return this.get(id)!;
  }
  setEnabled(id: number, on: boolean): Automation {
    const a = this.#must(id);
    const next = on && a.trigger.kind === 'schedule' ? (nextRun(a.trigger, this.#now(), this.#tz())?.toISOString() ?? null) : a.nextAt;
    this.#db.prepare('UPDATE automations SET enabled = ?, paused_reason = NULL, fails = CASE WHEN ? THEN 0 ELSE fails END, next_at = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, on ? 1 : 0, next, this.#now().toISOString(), id);
    return this.get(id)!;
  }
  remove(id: number): boolean {
    const a = this.get(id);
    if (!a) return false;
    // A watch made for it goes with it (through its own store).
    const t = a.trigger;
    if (t.kind === 'live') this.#app.liveWatches?.remove(t.ref);
    else if (t.kind === 'product') this.#app.productWatches?.remove(t.ref);
    else if (t.kind === 'file') this.#app.watches?.forget(t.ref);
    this.#db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(id);
    this.#db.prepare('DELETE FROM automations WHERE id = ?').run(id);
    return true;
  }

  // ------------------------------------------------ plain words

  whenWords(t: Trigger): string {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const time = (s: string) => {
      const [h, m] = s.split(':').map(Number);
      return `${((h! + 11) % 12) + 1}:${pad(m!)} ${h! < 12 ? 'AM' : 'PM'}`;
    };
    switch (t.kind) {
      case 'schedule':
        if (t.every === 'day') return T(en('Every day at {time}'), { time: time(t.time) });
        if (t.every === 'weekdays') return T(en('Every weekday at {time}'), { time: time(t.time) });
        if (t.every === 'month') return T(en('Every month on day {day} at {time}'), { day: t.day, time: time(t.time) });
        return T(en('Every {days} at {time}'), { days: (t.days ?? []).map((d) => T(DAY_NAMES[d]!)).join(', '), time: time(t.time) });
      case 'email':
        return t.from ? T(en('When an email from {from} arrives'), { from: t.from }) : T(en('When an email arrives'));
      case 'webhook':
        return T(en('When the webhook {hook} is delivered'), { hook: t.hookId });
      case 'calendar':
        return T(en('{n} minutes before a calendar event'), { n: t.minutes });
      default:
        return T(en('When this watch fires: {label}'), { label: t.label ?? '' });
    }
  }
  doesWords(a: Action): string {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    switch (a.kind) {
      case 'notify':
        return a.how === 'chat' ? T(en('Tell you in the chat: {text}'), { text: clip(a.text ?? '', 120) }) : T(en('Tell you (chat and a notification): {text}'), { text: clip(a.text ?? '', 120) });
      case 'task':
        return T(en('Ask Sara: {prompt}'), { prompt: clip(a.prompt ?? '', 160) });
      case 'draft_email':
        return a.sendWithoutAsking ? T(en('Write an email to {to} and send it without asking'), { to: a.to }) : T(en('Draft an email to {to} (never sent)'), { to: a.to });
      case 'fill':
        return a.timesheet ? T(en('Fill “{doc}” from the week’s work hours'), { doc: a.document }) : T(en('Fill “{doc}”'), { doc: a.document });
      case 'recipe':
        return T(en('Run the recipe {name}'), { name: a.prompt });
      case 'expense':
        return T(en('Add an expense: {what}'), { what: clip(a.prompt ?? '', 120) });
      case 'bill':
        return T(en('Add a bill: {what}'), { what: clip(a.prompt ?? '', 120) });
    }
  }

  // ------------------------------------------------ approvals (never bypassed)

  #permission(name: string, tool?: Tool): Permission {
    const app = this.#app;
    const over = app.settings.get().toolPermissions;
    if (app.tools.get(name)) return app.tools.permission(name, over);
    return (over?.[name] as Permission | undefined) ?? tool?.defaultPermission ?? 'ask';
  }
  /** The approvals a run will ask for, in plain words (and the tool behind each, for the hold). */
  approvals(actions: Action[]): string[] {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const out: string[] = [];
    for (const a of actions) {
      if (a.kind === 'task' || a.kind === 'recipe' || a.kind === 'expense' || a.kind === 'bill') out.push(T(en('Sara’s task: anything that changes something asks you first in the automation’s chat (your usual approvals).')));
      else if (a.kind === 'fill') {
        const p = this.#permission('fill_document');
        out.push(p === 'auto' ? T(en('Filling: makes a new copy (your original stays the same) without asking, as you set fill_document.')) : p === 'never' ? T(en('Filling is turned off (fill_document is set to never), so this step will fail.')) : T(en('Filling: waits for your OK on each run.')));
      } else if (a.kind === 'draft_email') {
        const send = a.sendWithoutAsking && this.#permission('mail_send') === 'auto';
        const p = this.#permission(send ? 'mail_send' : 'mail_draft');
        if (a.sendWithoutAsking && !send) out.push(T(en('Sending without asking is on for this one, but mail_send asks first, so it saves a draft instead.')));
        out.push(send ? T(en('Email: sent without asking (you turned this on and mail_send runs on its own).')) : p === 'auto' ? T(en('Email: saved as a draft without asking; never sent.')) : p === 'never' ? T(en('Email drafts are turned off, so this step will fail.')) : T(en('Email: waits for your OK before saving the draft; never sent.')));
      }
    }
    return out;
  }

  // ------------------------------------------------ preview

  preview(draft: Draft | Record<string, unknown>): { name: string; when: string; does: string[]; next: { at: string; local: string }[]; approvals: string[]; notes: string[]; trigger: Trigger | Record<string, unknown>; actions: Action[] } {
    const d = draft as Record<string, unknown>;
    const t = d.trigger as Record<string, unknown> | undefined;
    // A watch that doesn't exist yet: preview it without making it.
    const pending = t && (t.kind === 'live' || t.kind === 'product' || t.kind === 'file') && !t.ref;
    const c = pending ? { ...this.clean({ ...d, trigger: { kind: 'schedule', every: 'day', time: '09:00' } }), trigger: t as unknown as Trigger } : this.clean(d);
    const tz = this.#tz();
    const next = c.trigger.kind === 'schedule' ? nextRuns(c.trigger, this.#now(), tz, 3).map((x) => ({ at: x.toISOString(), local: localWhen(x, tz) })) : [];
    const notes: string[] = [];
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    for (const a of c.actions) {
      if (a.kind === 'fill' && a.timesheet && !this.#hasCalendar()) notes.push(a.timesheet.start ? T(en('No calendar is connected: it uses your shift rules for the days you list.')) : T(en('No calendar is connected and no shift times are set, so the time sheet would be empty. Connect your calendar or say your shift (like 2200-0700).')));
      if (a.kind === 'fill') {
        try {
          if (this.#app.library && !(a.docId !== undefined && this.#app.library.get(a.docId))) findForm(this.#app.library.list(), a.document ?? '');
        } catch (err) {
          notes.push((err as Error).message);
        }
      }
    }
    if (c.trigger.kind === 'calendar' && !this.#hasCalendar()) notes.push(T(en('No calendar is connected: it uses your planner reminders.')));
    const when = pending ? T(en('When this watch fires: {label}'), { label: line((t!.watch as Record<string, unknown> | undefined)?.label ?? (t!.watch as Record<string, unknown> | undefined)?.symbol ?? '', 80) }) : this.whenWords(c.trigger);
    return { name: c.name, when, does: c.actions.map((a) => this.doesWords(a)), next, approvals: this.approvals(c.actions), notes, trigger: c.trigger, actions: c.actions };
  }
  /** The preview as text (chat cards and tools). */
  previewText(draft: Draft | Record<string, unknown>): string {
    const p = this.preview(draft);
    return [`“${p.name}”`, `When: ${p.when}${p.next.length ? ` (next: ${p.next.map((x) => x.local).join('; ')})` : ''}`, `Does: ${p.does.map((x, i) => `${i + 1}. ${x}`).join(' ')}`, `Approvals: ${p.approvals.length ? p.approvals.join(' ') : 'none needed (it only tells you).'}`, ...(p.notes.length ? [`Notes: ${p.notes.join(' ')}`] : [])].join('\n');
  }

  #hasCalendar(): boolean {
    try {
      return Boolean(this.#o.calendar) || hasCalendar(this.#app);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------ runs

  history(id: number, limit: number = AUTOMATION.keepRuns): AutomationRun[] {
    return (this.#db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?').all(id, limit) as Row[]).map((r) => this.#runRow(r));
  }
  run(runId: number): AutomationRun | undefined {
    const r = this.#db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as Row | undefined;
    return r ? this.#runRow(r) : undefined;
  }
  #runRow(r: Row): AutomationRun {
    return { id: Number(r.id), automationId: Number(r.automation_id), at: String(r.at), endedAt: r.ended_at ? String(r.ended_at) : null, trigger: String(r.trigger_detail), outcome: String(r.outcome) as Outcome, summary: String(r.summary), steps: JSON.parse(String(r.steps_json)) as StepResult[], dry: Number(r.dry) === 1, conversationId: r.conversation_id ? String(r.conversation_id) : null };
  }
  #startRun(a: Automation, detail: string, dry: boolean): number {
    const id = Number(this.#db.prepare("INSERT INTO automation_runs (automation_id, at, trigger_detail, outcome, dry) VALUES (?, ?, ?, 'running', ?)").run(a.id, this.#now().toISOString(), clip(detail, 300), dry ? 1 : 0).lastInsertRowid);
    this.#db.prepare('DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?)').run(a.id, a.id, AUTOMATION.keepRuns);
    return id;
  }
  #skip(a: Automation, detail: string, why: string): AutomationRun {
    const id = this.#startRun(a, detail, false);
    this.#db.prepare("UPDATE automation_runs SET outcome = 'skipped', summary = ?, ended_at = at WHERE id = ?").run(clip(why, 300), id);
    return this.run(id)!;
  }

  /** The automation's own chat ("Automation: name"), made on first use. */
  #conversation(a: Automation): string {
    if (a.conversationId && this.#app.store.getConversation(a.conversationId)) return a.conversationId;
    const id = this.#app.store.createConversation({ title: clip(`Automation: ${a.name}`, 60), channel: 'automation', channelKey: String(a.id) }).id;
    this.#db.prepare('UPDATE automations SET conversation_id = ? WHERE id = ?').run(id, a.id);
    return id;
  }
  #quiet(): boolean {
    return this.#o.quiet ? this.#o.quiet() : quietNow(this.#app);
  }
  async #push(title: string, body: string, conversationId: string, tag: string): Promise<boolean> {
    if (this.#quiet() || privateLocalOn()) return false;
    const n = this.#o.notify ?? ((a: string, b: string, c: string, d: string) => this.#app.push?.notifyOwner(a, b, c, d) ?? Promise.resolve());
    return n(title, body, conversationId, tag).then(
      () => true,
      () => false,
    );
  }
  #say(conversationId: string, text: string, meta: Record<string, unknown>): void {
    const msg = this.#app.store.addMessage(conversationId, 'assistant', text, meta);
    this.#app.events?.publish({ type: 'message', conversationId, message: msg, reason: 'reminder' });
  }

  /**
   * Runs an automation now (a trigger, *Run now* or a dry run). One run at a time: a second start
   * while one runs is recorded as skipped. Resolves when the run ends (or waits for an OK).
   */
  async fire(id: number, detail: string, o: { dry?: boolean; force?: boolean } = {}): Promise<AutomationRun> {
    const a = this.#must(id);
    if (!o.dry && !o.force && !a.enabled) return this.#skip(a, detail, 'it is paused');
    if (this.#running.has(id)) return this.#skip(a, detail, 'still on the last run');
    if (!o.dry && a.condition?.words && !a.condition.words.toLowerCase().split(/\s+/).every((w) => detail.toLowerCase().includes(w))) return this.#skip(a, detail, `the condition didn’t match (${a.condition.words})`);
    if (!o.dry && a.actions.some((x) => x.kind !== 'notify' && x.kind !== 'fill' && x.kind !== 'draft_email')) {
      const sp = spendSettings(this.#app.settings.get());
      const spent = spentNow(this.#app.usage, this.#now(), this.#tz());
      if ((sp.dayUsd > 0 && spent.day >= sp.dayUsd) || (sp.monthUsd > 0 && spent.month >= sp.monthUsd)) return this.#skip(a, detail, 'your spend limit is reached');
    }
    this.#running.add(id);
    const runId = this.#startRun(a, detail, o.dry === true);
    const p = this.#execute(a, runId, { files: [], detail }, 0, o.dry === true).finally(() => this.#running.delete(id));
    this.#work.add(p);
    void p.finally(() => this.#work.delete(p));
    await p;
    return this.run(runId)!;
  }
  /** A dry run of a draft (no row, no watch, nothing done); the test line goes to `conversationId` if given. */
  async dryDraft(draft: Draft | Record<string, unknown>, conversationId?: string): Promise<StepResult[]> {
    const p = this.preview(draft);
    const iso = this.#now().toISOString();
    const a: Automation = { id: 0, name: p.name, trigger: p.trigger as Trigger, condition: null, actions: p.actions, enabled: false, pausedReason: null, owner: 'owner', createdBy: 'chat', conversationId: conversationId ?? null, nextAt: null, fails: 0, createdAt: iso, updatedAt: iso };
    const ctx: RunCtx = { files: [], detail: 'Test run' };
    const steps: StepResult[] = [];
    for (const [i, act] of a.actions.entries()) {
      try {
        steps.push(await this.#step(a, act, i, ctx, conversationId ?? '', true));
      } catch (err) {
        steps.push({ kind: act.kind, status: 'failed', text: clip((err as Error).message, 300) });
        break;
      }
    }
    return steps;
  }

  /** Waits for every background run (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  async #execute(a: Automation, runId: number, ctx: RunCtx, from: number, dry: boolean): Promise<void> {
    const conversationId = this.#conversation(a);
    const steps: StepResult[] = from ? this.run(runId)!.steps.slice(0, from) : [];
    let outcome: Outcome = dry ? 'test' : 'done';
    for (let i = from; i < a.actions.length; i++) {
      const act = a.actions[i]!;
      let r: StepResult;
      try {
        r = await this.#step(a, act, i, ctx, conversationId, dry);
      } catch (err) {
        r = { kind: act.kind, status: 'failed', text: clip((err as Error).message, 300) };
      }
      steps.push(r);
      if (r.status === 'waiting') {
        outcome = 'waiting';
        this.#db.prepare('UPDATE automation_runs SET held_json = ? WHERE id = ?').run(JSON.stringify({ index: i, ctx: { files: ctx.files, week: ctx.week, detail: ctx.detail } }), runId);
        const title = this.#T(en('Automation needs your OK: {name}'), { name: clip(a.name, 60) });
        this.#say(conversationId, `${title}\n${r.text}`, { automation: { id: a.id, runId, waiting: true } });
        await this.#push(title, r.text, conversationId, `automation-${a.id}`);
        break;
      }
      if (r.status === 'failed' || r.status === 'declined') {
        outcome = r.status === 'declined' ? 'declined' : 'failed';
        break;
      }
    }
    const summary = clip(steps.map((s) => s.text).filter(Boolean).join(' · '), 300);
    this.#db.prepare('UPDATE automation_runs SET outcome = ?, summary = ?, steps_json = ?, conversation_id = ?, ended_at = ? WHERE id = ?').run(outcome, summary, JSON.stringify(steps), conversationId, outcome === 'waiting' ? null : this.#now().toISOString(), runId);
    if (!dry) this.#afterRun(a, outcome, summary, conversationId);
    this.#app.events?.publish({ type: 'automations' });
  }

  /** Failure streak: three failed runs in a row pause it, with a notification and the reason. */
  #afterRun(a: Automation, outcome: Outcome, summary: string, conversationId: string): void {
    if (outcome === 'done') this.#db.prepare('UPDATE automations SET fails = 0 WHERE id = ?').run(a.id);
    if (outcome !== 'failed') return;
    const fails = Number((this.#db.prepare('UPDATE automations SET fails = fails + 1 WHERE id = ? RETURNING fails').get(a.id) as { fails: number }).fails);
    if (fails < AUTOMATION.failPause) return;
    const why = clip(summary || 'it failed', 200);
    this.#db.prepare('UPDATE automations SET enabled = 0, paused_reason = ?, updated_at = ? WHERE id = ?').run(`${AUTOMATION.failPause} failures in a row: ${why}`, this.#now().toISOString(), a.id);
    const title = this.#T(en('Automation paused: {name}'), { name: clip(a.name, 60) });
    const body = this.#T(en('It failed {n} times in a row, so it is paused. Last problem: {why}'), { n: AUTOMATION.failPause, why });
    this.#say(conversationId, `${title}\n${body}`, { automation: { id: a.id, paused: true } });
    void this.#push(title, body, conversationId, `automation-${a.id}`);
  }

  async #step(a: Automation, act: Action, index: number, ctx: RunCtx, conversationId: string, dry: boolean): Promise<StepResult> {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const fillIn = (s: string) => s.replace(/\{week\}/g, ctx.week ?? '').replace(/\{detail\}/g, clip(ctx.detail, 300)).replace(/\{files\}/g, ctx.files.map((f) => f.name).join(', ') || T(en('no file')));
    switch (act.kind) {
      case 'notify': {
        const text = fillIn(act.text ?? '');
        if (dry) {
          if (conversationId) this.#say(conversationId, `${T(en('Test run (nothing was done):'))} ${text}`, { automation: { id: a.id, test: true } });
          return { kind: act.kind, status: 'test', text: T(en('Would tell you: {text}'), { text: clip(text, 200) }) };
        }
        this.#say(conversationId, text, { automation: { id: a.id }, ...(ctx.files.length ? { files: ctx.files } : {}) });
        const pushed = act.how === 'chat' ? false : await this.#push(clip(a.name, 80), clip(text, 300), conversationId, `automation-${a.id}`);
        return { kind: act.kind, status: 'done', text: pushed ? T(en('Told you (chat and a notification).')) : T(en('Told you in the chat.')) };
      }
      case 'task':
      case 'recipe':
      case 'expense':
      case 'bill': {
        const prompt = act.kind === 'recipe' ? `Run my recipe “${act.prompt}”.` : act.kind === 'expense' ? `Add this expense: ${act.prompt}` : act.kind === 'bill' ? `Add this bill: ${act.prompt}` : (act.prompt ?? '');
        if (dry) return { kind: act.kind, status: 'test', text: T(en('Would ask Sara: {prompt}'), { prompt: clip(prompt, 200) }) };
        const content = `${prompt}\n\n(This is my automation “${a.name}”, started by: ${clip(ctx.detail, 300)}. Anything that changes something still needs my OK.)`;
        const res = await (this.#o.runTask ?? ((r) => this.#defaultTask(r)))({ automation: a, conversationId, content });
        if (res.declined) return { kind: act.kind, status: 'declined', text: T(en('You declined her step, so she stopped there.')) };
        if (res.error) return { kind: act.kind, status: 'failed', text: clip(res.error, 200) };
        return { kind: act.kind, status: 'done', text: clip(res.reply || T(en('Sara did the task.')), 200) };
      }
      case 'fill':
        return this.#fill(a, act, index, ctx, conversationId, dry);
      case 'draft_email': {
        const send = act.sendWithoutAsking === true && this.#permission('mail_send') === 'auto';
        const name = send ? 'mail_send' : 'mail_draft';
        // N4: the files made earlier in this run (the filled time sheet) go along as attachments.
        const body = fillIn(act.body || '');
        const attach = ctx.files.map((f) => f.id).filter(Boolean);
        if (dry) return { kind: act.kind, status: 'test', text: (send ? T(en('Would send an email to {to}: “{subject}”'), { to: act.to, subject: act.subject }) : T(en('Would save a draft to {to}: “{subject}” (not saved in the test)'), { to: act.to, subject: act.subject })) + (a.actions.slice(0, index).some((x) => x.kind === 'fill') ? ` ${T(en('The filled file goes with it as an attachment.'))}` : '') };
        const tool = this.#app.tools.get(name);
        if (!tool || tool.isAvailable?.() === false) return { kind: act.kind, status: 'failed', text: T(en('No mailbox is connected for drafts.')) };
        const perm = this.#permission(name);
        if (perm === 'never') return { kind: act.kind, status: 'failed', text: T(en('Email drafts are turned off, so this step will fail.')) };
        if (perm !== 'auto' && ctx.allowed !== index) return { kind: act.kind, status: 'waiting', text: T(en('Save a draft to {to}: “{subject}”. Allow it in Settings → Automations.'), { to: act.to, subject: act.subject }) };
        const out = await tool.run({ to: act.to, subject: fillIn(act.subject ?? ''), body, ...(attach.length ? { attachments: attach } : {}) }, this.#toolCtx(conversationId, ctx));
        return { kind: act.kind, status: 'done', text: clip(out, 200) };
      }
    }
  }

  #toolCtx(conversationId: string, ctx: RunCtx): ToolContext {
    return { workspaceDir: this.#app.dataDir, signal: AbortSignal.timeout(120_000), sandbox: this.#app.sandbox, conversationId, attachFile: (f) => void ctx.files.push(f) };
  }

  async #events(from: Date, to: Date): Promise<Pick<TodayEvent, 'id' | 'title' | 'start' | 'end' | 'allDay'>[]> {
    if (this.#o.calendar) return this.#o.calendar(from, to);
    if (!this.#hasCalendar()) return [];
    return calendarEvents(this.#app, from, to, 100, 15_000);
  }

  async #fill(a: Automation, act: Action, index: number, ctx: RunCtx, conversationId: string, dry: boolean): Promise<StepResult> {
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const tool = createFillDocumentTool(() => this.#app);
    const lib = this.#app.library;
    if (!lib) return { kind: act.kind, status: 'failed', text: T(en('There is no library here, so there is no form to fill.')) };
    const pinned = act.docId !== undefined ? lib.get(act.docId) : undefined;
    const doc = pinned ?? findForm(lib.list(), act.document ?? '');
    let args: Record<string, unknown> = { document: String(doc.id), values: act.values ?? {} };
    let what = '';
    if (act.timesheet) {
      const tz = this.#tz();
      const week = weekOf(this.#now(), tz, act.timesheet);
      const from = zonedToUtc(...(week[0]!.split('-').map(Number) as [number, number, number]), 0, 0, tz);
      const to = new Date(zonedToUtc(...(week[6]!.split('-').map(Number) as [number, number, number]), 0, 0, tz).getTime() + 86_400_000);
      const events = await this.#events(from, to);
      const days = timesheetDays(events, week, tz, act.timesheet);
      const f = timesheetFill(days, week, act.timesheet, act.values);
      ctx.week = String(f.values['WEEK OF']);
      args = { document: String(doc.id), values: f.values, tables: f.tables, title: act.title ?? `${doc.name.replace(/\.[a-z0-9]+$/i, '')} - week of ${ctx.week.replace(/\//g, '-')}` };
      what = days.length ? days.map((d) => `${d.day} ${d.start}-${d.end} ${d.hours}h`).join(', ') : T(en('no work days found'));
      if (!days.length) return { kind: act.kind, status: 'failed', text: T(en('No work hours found for the week of {week} (no calendar events and no shift rules).'), { week: ctx.week }) };
    }
    if (dry) {
      // The test names the copy it would make (nothing is kept, nothing attached).
      ctx.files.push({ id: '', name: `${String(args.title ?? `${doc.name.replace(/\.[a-z0-9]+$/i, '')} (filled)`)}${/\.[a-z0-9]+$/i.exec(doc.name)?.[0] ?? ''}`, mime: '', bytes: 0 });
      return { kind: act.kind, status: 'test', text: T(en('Would fill a copy of “{doc}” (not saved in the test): {what}'), { doc: doc.name, what: what || Object.keys(act.values ?? {}).join(', ') }) };
    }
    const perm = this.#permission('fill_document', tool);
    if (perm === 'never') return { kind: act.kind, status: 'failed', text: T(en('Filling is turned off (fill_document is set to never), so this step will fail.')) };
    if (perm !== 'auto' && ctx.allowed !== index) return { kind: act.kind, status: 'waiting', text: T(en('Fill a copy of “{doc}”: {what}. Allow it in Settings → Automations.'), { doc: doc.name, what }) };
    const out = await tool.run(args, this.#toolCtx(conversationId, ctx));
    if (/Nothing was filled/.test(out)) return { kind: act.kind, status: 'failed', text: clip(out.split('\n')[0] ?? out, 200) };
    const partial = /Don't say the form is filled/.test(out);
    return { kind: act.kind, status: 'done', text: partial ? T(en('Filled “{doc}”, but not every field: {what}'), { doc: doc.name, what: clip(out.split('\n')[0] ?? '', 160) }) : T(en('Filled a copy of “{doc}”: {what}'), { doc: doc.name, what: clip(what || 'every field', 200) }) };
  }

  async #defaultTask(r: { automation: Automation; conversationId: string; content: string }): Promise<{ reply: string; error?: string; declined?: boolean; asked?: boolean }> {
    const app = this.#app;
    if (!app.runTracked) return { reply: '', error: 'this server cannot run turns in the background' };
    if (app.isBusy?.(r.conversationId)) return { reply: '', error: 'she is still working in its chat' };
    let step = '';
    let replaced: string | undefined;
    let error = '';
    let asked = false;
    let declined = false;
    try {
      // An ordinary turn in the automation's chat: the person's normal tools and approvals (a change
      // shows its card there and waits; nothing is approved for them).
      await app.runTracked(
        r.conversationId,
        r.content,
        (ev: ChatEvent) => {
          if (ev.type === 'token') step += ev.text;
          else if (ev.type === 'tool_call') step = '';
          else if (ev.type === 'replace') replaced = ev.text;
          else if (ev.type === 'error') error = ev.message;
          else if (ev.type === 'approval') asked = true;
          else if (ev.type === 'tool_result' && asked && ev.status === 'denied') declined = true;
        },
        { budget: { tokens: AUTOMATION.taskTokens, minutes: AUTOMATION.taskMinutes } },
      );
    } catch (err) {
      error = (err as Error).message;
    }
    return { reply: clip((replaced ?? step).replace(/\s+/g, ' ').trim(), 300), asked, ...(error ? { error: clip(error, 200) } : {}), ...(declined ? { declined } : {}) };
  }

  /** The person's Allow (or Decline) on a run that waits: the held step runs once, then the rest. */
  async answer(runId: number, allow: boolean): Promise<AutomationRun> {
    const run = this.run(runId);
    const row = this.#db.prepare('SELECT held_json FROM automation_runs WHERE id = ?').get(runId) as { held_json: string | null } | undefined;
    if (!run || run.outcome !== 'waiting' || !row?.held_json) throw new AutomationError(409, en('Nothing is waiting for your OK on this run.'));
    const a = this.#must(run.automationId);
    const held = JSON.parse(row.held_json) as { index: number; ctx: RunCtx };
    if (allow && this.#running.has(a.id)) throw new AutomationError(409, en('Nothing is waiting for your OK on this run.'));
    this.#db.prepare('UPDATE automation_runs SET held_json = NULL WHERE id = ?').run(runId);
    if (!allow) {
      const steps = [...run.steps.slice(0, held.index), { kind: a.actions[held.index]!.kind, status: 'declined' as const, text: this.#T(en('You said no, so it stopped there.')) }];
      this.#db.prepare("UPDATE automation_runs SET outcome = 'declined', steps_json = ?, summary = ?, ended_at = ? WHERE id = ?").run(JSON.stringify(steps), clip(steps.map((s) => s.text).join(' · '), 300), this.#now().toISOString(), runId);
      return this.run(runId)!;
    }
    this.#running.add(a.id);
    this.#db.prepare("UPDATE automation_runs SET outcome = 'running' WHERE id = ?").run(runId);
    try {
      await this.#execute(a, runId, { ...held.ctx, allowed: held.index }, held.index, false);
    } finally {
      this.#running.delete(a.id);
    }
    return this.run(runId)!;
  }
  /** Runs that wait for the person's OK (the page and the Today tile). */
  waiting(): { runId: number; automationId: number; name: string; text: string; at: string }[] {
    const rows = this.#db.prepare("SELECT r.id, r.automation_id, r.at, r.steps_json, a.name FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.outcome = 'waiting' ORDER BY r.id DESC LIMIT 20").all() as Row[];
    return rows.map((r) => ({ runId: Number(r.id), automationId: Number(r.automation_id), name: String(r.name), at: String(r.at), text: (JSON.parse(String(r.steps_json)) as StepResult[]).at(-1)?.text ?? '' }));
  }

  // ------------------------------------------------ triggers

  /** The reminder scheduler's tick: due schedules, and calendar triggers (each checked every 5 minutes). */
  due(now: Date = this.#now()): number {
    let started = 0;
    const tz = this.#tz();
    for (const a of this.list()) {
      if (!a.enabled) continue;
      if (a.trigger.kind === 'schedule' && a.nextAt && Date.parse(a.nextAt) <= now.getTime()) {
        const was = a.nextAt;
        const next = nextRun(a.trigger, now, tz)?.toISOString() ?? null;
        this.#db.prepare('UPDATE automations SET next_at = ? WHERE id = ?').run(next, a.id);
        const late = now.getTime() - Date.parse(was) > AUTOMATION.lateMs;
        if (late) this.#skip(a, `${localWhen(new Date(was), tz)}`, 'missed (the server was off); it runs again next time');
        else {
          void this.fire(a.id, `${this.#T(en('Scheduled'))}: ${localWhen(new Date(was), tz)}`).catch(() => undefined);
          started++;
        }
      }
    }
    if (!this.#calBusy && this.list().some((a) => a.enabled && a.trigger.kind === 'calendar')) {
      this.#calBusy = true;
      const p = this.#calendarPass(now).finally(() => (this.#calBusy = false));
      this.#work.add(p);
      void p.catch(() => undefined).finally(() => this.#work.delete(p));
    }
    return started;
  }
  async #calendarPass(now: Date): Promise<void> {
    const list = this.list().filter((a) => a.enabled && a.trigger.kind === 'calendar');
    for (const a of list) {
      const t = a.trigger as CalendarTrigger;
      const memo = this.#memo(a.id);
      if (typeof memo.checkedAt === 'number' && now.getTime() - memo.checkedAt < AUTOMATION.calendarEveryMs) continue;
      memo.checkedAt = now.getTime();
      const horizon = new Date(now.getTime() + (t.minutes + 10) * 60_000);
      let events: Pick<TodayEvent, 'id' | 'title' | 'start' | 'allDay'>[] = [];
      try {
        events = this.#hasCalendar() ? await this.#events(now, horizon) : (this.#app.planner?.reminders({ status: 'pending', kind: 'timed', limit: 50 }) ?? []).map((r) => ({ id: `rem${r.id}`, title: r.text, start: r.dueAt, allDay: false }));
      } catch {
        events = [];
      }
      const seen = Array.isArray(memo.seen) ? (memo.seen as string[]) : [];
      for (const e of events) {
        if (e.allDay) continue;
        const start = Date.parse(e.start);
        const key = `${e.id}@${e.start}`;
        if (seen.includes(key) || start - t.minutes * 60_000 > now.getTime() || start < now.getTime()) continue;
        if (t.words && !t.words.toLowerCase().split(/\s+/).every((w) => e.title.toLowerCase().includes(w))) continue;
        seen.push(key);
        void this.fire(a.id, `${e.title} (${localWhen(new Date(start), this.#tz())})`).catch(() => undefined);
      }
      memo.seen = seen.slice(-AUTOMATION.seenRing);
      this.#setMemo(a.id, memo);
    }
  }
  /** C4's events (email, webhook): called from EventTriggers.observe. Never throws. */
  observeEvent(ev: TriggerEvent): number[] {
    const out: number[] = [];
    if (ev.self === true) return out;
    try {
      for (const a of this.list()) {
        if (!a.enabled || (a.trigger.kind !== 'email' && a.trigger.kind !== 'webhook') || a.trigger.kind !== ev.source) continue;
        const filter = a.trigger.kind === 'email' ? { ...(a.trigger.from ? { from: a.trigger.from } : {}), ...(a.trigger.words ? { words: a.trigger.words } : {}) } : { hookId: a.trigger.hookId, ...(a.trigger.event ? { event: a.trigger.event } : {}) };
        if (!matches({ source: ev.source, filter }, ev)) continue;
        const memo = this.#memo(a.id);
        const seen = Array.isArray(memo.seen) ? (memo.seen as string[]) : [];
        const key = ev.id ?? `${ev.from ?? ''}|${ev.subject ?? ''}|${ev.text.slice(0, 200)}`;
        if (seen.includes(key)) continue;
        this.#setMemo(a.id, { ...memo, seen: [...seen, key].slice(-AUTOMATION.seenRing) });
        const detail = ev.source === 'email' ? `Email from ${line(ev.from, 120)}: ${line(ev.subject, 160)}` : `Webhook ${line(ev.event ?? ev.hookId, 120)}`;
        void this.fire(a.id, detail).catch(() => undefined);
        out.push(a.id);
      }
    } catch {
      /* never break the event source */
    }
    return out;
  }
  /** A watch fired (E1 live, E2 product, E4 file): its automations run. Never throws. */
  watchFired(kind: 'live' | 'product' | 'file', ref: number, text: string): number[] {
    const out: number[] = [];
    try {
      for (const a of this.list()) {
        if (!a.enabled || a.trigger.kind !== kind || (a.trigger as WatchTrigger).ref !== ref) continue;
        void this.fire(a.id, clip(text, 300)).catch(() => undefined);
        out.push(a.id);
      }
    } catch {
      /* never break the watch */
    }
    return out;
  }

  // ------------------------------------------------ one list (adapters over the existing stores)

  /** Every automation-like thing in this space, in plain words, each through its own store. */
  all(): UnifiedItem[] {
    const app = this.#app;
    const T = (s: string, p?: Record<string, unknown>) => this.#T(s, p);
    const tz = this.#tz();
    const out: UnifiedItem[] = [];
    const linked = new Set<string>();
    for (const a of this.list()) {
      const last = this.history(a.id, 1)[0];
      if (a.trigger.kind === 'live' || a.trigger.kind === 'product' || a.trigger.kind === 'file') linked.add(`${a.trigger.kind}:${a.trigger.ref}`);
      out.push({ key: `auto:${a.id}`, source: 'automation', name: a.name, when: this.whenWords(a.trigger), does: a.actions.map((x) => this.doesWords(x)).join(' · '), enabled: a.enabled, status: a.pausedReason ?? '', next: a.enabled && a.nextAt ? a.nextAt : null, nextLocal: a.enabled && a.nextAt ? localWhen(new Date(a.nextAt), tz) : '', last: last ? { at: last.at, outcome: last.outcome, summary: last.summary } : null, canToggle: true, canEdit: true, canDelete: true, conversationId: a.conversationId, trigger: a.trigger, actions: a.actions });
    }
    for (const t of app.eventTriggers?.list() ?? []) {
      const r = app.eventTriggers!.runs(t.id, 1)[0];
      out.push({ key: `trigger:${t.id}`, source: 'trigger', name: t.name, when: T(en('When this happens: {source}'), { source: t.source }), does: t.action.kind === 'crew' ? T(en('Start a crew')) : clip(t.action.prompt ?? '', 160), enabled: t.state === 'on', status: '', next: null, nextLocal: '', last: r ? { at: r.at, outcome: r.verdict, summary: r.summary } : null, canToggle: true, canEdit: false, canDelete: true, conversationId: t.conversationId, where: 'co-hooks' });
    }
    for (const w of app.liveWatches?.list() ?? []) {
      if (w.state === 'done' || linked.has(`live:${w.id}`)) continue;
      out.push({ key: `live:${w.id}`, source: 'live', name: w.label, when: T(en('When this watch fires: {label}'), { label: w.label }), does: T(en('Tell you')), enabled: w.state === 'active', status: w.state === 'paused' && w.reason !== 'owner' ? (w.lastError ?? w.reason ?? '') : '', next: null, nextLocal: '', last: w.lastFiredAt ? { at: w.lastFiredAt, outcome: 'done', summary: w.lastValue ?? '' } : null, canToggle: true, canEdit: false, canDelete: true, conversationId: w.conversationId });
    }
    for (const w of app.productWatches?.list() ?? []) {
      if (linked.has(`product:${w.id}`)) continue;
      out.push({ key: `product:${w.id}`, source: 'product', name: w.label, when: T(en('When this product changes: {label}'), { label: `${w.label} (${w.retailer})` }), does: T(en('Tell you')), enabled: w.state === 'active', status: w.lastError ?? '', next: null, nextLocal: '', last: w.lastCheckedAt ? { at: w.lastCheckedAt, outcome: w.lastError ? 'failed' : 'done', summary: w.lastPrice !== null ? `$${w.lastPrice}` : (w.lastAvailability ?? '') } : null, canToggle: true, canEdit: false, canDelete: true, conversationId: w.conversationId });
    }
    for (const w of app.watches?.list() ?? []) {
      if (w.state === 'stopped' || linked.has(`file:${w.id}`)) continue;
      out.push({ key: `file:${w.id}`, source: 'file', name: w.file, when: T(en('When {file} gets a line with: {words}'), { file: w.file, words: w.patterns.join(', ') }), does: T(en('Tell you')), enabled: w.state === 'active', status: w.state === 'paused' && w.reason !== 'owner' ? (w.reason ?? '') : '', next: null, nextLocal: '', last: w.lastMatchAt ? { at: w.lastMatchAt, outcome: 'done', summary: '' } : null, canToggle: true, canEdit: false, canDelete: true, conversationId: w.conversationId });
    }
    for (const r of this.#routines()) out.push(r);
    return out;
  }
  #routines(): UnifiedItem[] {
    const rs = (this.#app as AppContext & { routines?: import('./routines.ts').Routines }).routines ?? this.#routinesStore();
    if (!rs) return [];
    let mine: ReturnType<import('./routines.ts').Routines['mine']> = [];
    try {
      mine = rs.mine();
    } catch {
      return [];
    }
    return mine.map((m) => ({ key: m.rid !== undefined ? `routine:${m.rid}` : `elsewhere:${m.kind}:${m.key}`, source: 'routine' as const, name: m.title, when: m.when, does: m.cost ? `${m.engine} · ${m.cost}` : m.engine, enabled: m.on, status: m.status, next: null, nextLocal: m.status, last: null, canToggle: m.rid !== undefined || m.on, canEdit: false, canDelete: true, conversationId: m.conversationId ?? null, where: m.rid !== undefined ? 'routines' : undefined }));
  }
  #routinesStore(): import('./routines.ts').Routines | undefined {
    return this.#routinesFor?.(this.#app);
  }
  /** Set by main.ts (routinesFor), so this module doesn't load the routines catalog itself. */
  #routinesFor: ((app: AppContext) => import('./routines.ts').Routines) | undefined;
  useRoutines(f: (app: AppContext) => import('./routines.ts').Routines): void {
    this.#routinesFor = f;
  }

  /** On/off through each thing's own store. */
  toggle(key: string, on: boolean): void {
    const [kind, a, b] = key.split(':');
    const id = Number(a);
    const app = this.#app;
    switch (kind) {
      case 'auto':
        this.setEnabled(id, on);
        return;
      case 'trigger':
        if (!app.eventTriggers) break;
        app.eventTriggers.patch(id, { state: on ? 'on' : 'paused' });
        return;
      case 'live':
        if (!app.liveWatches?.get(id)) break;
        app.liveWatches.setPaused(id, !on);
        return;
      case 'product':
        if (!app.productWatches?.get(id)) break;
        app.productWatches.setPaused(id, !on);
        return;
      case 'file':
        if (!app.watches?.get(id)) break;
        if (on) app.watches.resume(id);
        else app.watches.pause(id);
        return;
      case 'routine': {
        const rs = this.#routinesStore();
        if (!rs) break;
        if (on) rs.on(id);
        else rs.off(id);
        return;
      }
      case 'elsewhere': {
        if (on) throw new AutomationError(409, en('This one is turned on where it was set up.'));
        const rs = this.#routinesStore();
        if (!rs) break;
        rs.elsewhereOff(a!, b!);
        return;
      }
    }
    throw new AutomationError(404, en('Automation not found.'));
  }
  /** Delete through each thing's own store. */
  removeKey(key: string): void {
    const [kind, a, b] = key.split(':');
    const id = Number(a);
    const app = this.#app;
    let ok = false;
    if (kind === 'auto') ok = this.remove(id);
    else if (kind === 'trigger') ok = app.eventTriggers?.remove(id) ?? false;
    else if (kind === 'live') ok = app.liveWatches?.remove(id) ?? false;
    else if (kind === 'product') ok = app.productWatches?.remove(id) ?? false;
    else if (kind === 'file' && app.watches?.get(id)) {
      app.watches.forget(id);
      ok = true;
    } else if (kind === 'routine' && this.#routinesStore()) {
      this.#routinesStore()!.remove(id);
      ok = true;
    } else if (kind === 'elsewhere' && this.#routinesStore()) {
      this.#routinesStore()!.elsewhereOff(a!, b!);
      ok = true;
    }
    if (!ok) throw new AutomationError(404, en('Automation not found.'));
  }
  /** History through each thing's own store (automations and C4 triggers keep runs). */
  historyKey(key: string): { at: string; outcome: string; summary: string; trigger?: string; conversationId?: string | null; steps?: StepResult[]; runId?: number }[] {
    const [kind, a] = key.split(':');
    const id = Number(a);
    if (kind === 'auto') return this.history(id).map((r) => ({ at: r.at, outcome: r.dry ? 'test' : r.outcome, summary: r.summary, trigger: r.trigger, conversationId: r.conversationId, steps: r.steps, runId: r.id }));
    if (kind === 'trigger') return (this.#app.eventTriggers?.runs(id, 50) ?? []).map((r) => ({ at: r.at, outcome: r.verdict, summary: r.summary, conversationId: r.conversationId }));
    if (kind === 'file') return (this.#app.watches?.alerts(id) ?? []).slice(0, 50).map((x) => ({ at: x.lastAt, outcome: 'done', summary: x.line }));
    const item = this.all().find((x) => x.key === key);
    return item?.last ? [{ at: item.last.at, outcome: item.last.outcome, summary: item.last.summary }] : [];
  }

  /** Today: a tile only when something failed, waits for an OK, or runs today. */
  todayTile(now: Date = this.#now()): { failing: { id: number; name: string; why: string }[]; waiting: number; today: { id: number; name: string; at: string; local: string }[] } | undefined {
    const tz = this.#tz();
    const p = zonedParts(now, tz);
    const end = zonedToUtc(p.y, p.mo, p.d + 1, 0, 0, tz).getTime();
    const list = this.list();
    const failing = list.filter((a) => a.pausedReason || (a.enabled && this.history(a.id, 1)[0]?.outcome === 'failed')).map((a) => ({ id: a.id, name: a.name, why: a.pausedReason ?? this.history(a.id, 1)[0]?.summary ?? '' }));
    const today = list.filter((a) => a.enabled && a.nextAt && Date.parse(a.nextAt) < end).map((a) => ({ id: a.id, name: a.name, at: a.nextAt!, local: localWhen(new Date(a.nextAt!), tz) }));
    const waiting = this.waiting().length;
    return failing.length || today.length || waiting ? { failing, waiting, today } : undefined;
  }
}

export interface UnifiedItem {
  key: string;
  source: 'automation' | 'trigger' | 'live' | 'product' | 'file' | 'routine';
  name: string;
  when: string;
  does: string;
  enabled: boolean;
  status: string;
  next: string | null;
  nextLocal: string;
  last: { at: string; outcome: string; summary: string } | null;
  canToggle: boolean;
  canEdit: boolean;
  canDelete: boolean;
  conversationId: string | null;
  /** Where it is set up (a Settings page id), for adapters. */
  where?: string;
  trigger?: Trigger;
  actions?: Action[];
}

export function localWhen(at: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(at);
}

/** This space's automations (made on first use; members get their own in their own store). */
export function automationsFor(app: AppContext): Automations {
  app.automations ??= new Automations(app, app.store.db);
  return app.automations;
}

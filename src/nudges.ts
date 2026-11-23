// W1.2 (docs/NUDGES.md): one polite daily budget for everything she sends on her own.
//
// Each feature asks `askNudge` with a kind, a value (0..1, how much it matters) and an urgency.
// - `safety` (someone asked for legacy access, a smoke-alarm test) and `reminder` (things the person
//   asked for: a briefing at 7, a report they turned on) always go out, any hour, and never use up
//   the budget.
// - Normal nudges: quiet hours (the Texting first hours) hold them; low scores (value × what this
//   person taught her with "Fewer like this") wait; and the bar rises as the day's budget fills, so
//   the budget goes to the ones that matter most.
// - Whatever waits is bundled into ONE roundup a day (`nudgeTick`, on the reminders' tick), ranked
//   by score, where "Smaller things" alerts go.
// State is per person (`<app.dataDir>/nudges.json`: household members have their own dataDir).
import { ownChat } from './home-chat.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { FEEDS, feedTitle, isFeed, ownerWebChats, postAlert } from './destinations.ts';
import { en, trOwner } from './i18n.ts';
import { proactiveSettings, quietNow } from './life.ts';
import { localDate } from './memory-worker.ts';
import { zonedParts } from './planner.ts';

export type Urgency = 'normal' | 'reminder' | 'safety';
export interface NudgeAsk {
  kind: string;
  /** 0..1: how much it matters to the person (a passport expiring ≈ 0.9, a price change ≈ 0.4). */
  value: number;
  urgency?: Urgency;
  /** The words to keep for the roundup when it has to wait. */
  text: string;
  /** false: if it can't go now, drop it (her "thinking of you" messages make no sense hours later). */
  digest?: boolean;
}
export interface Why {
  key: string;
  params: Record<string, string | number>;
}
export interface NudgeVerdict {
  send: boolean;
  held?: 'quiet' | 'budget' | 'low';
  score: number;
  why: Why;
}
export interface NudgePrefs {
  /** Normal nudges a day; 0 = everything that isn't urgent waits for the roundup. */
  budget: number;
  /** Local hour of the daily roundup of smaller things. */
  digestHour: number;
}
interface Held {
  kind: string;
  text: string;
  score: number;
  at: string;
  held: 'quiet' | 'budget' | 'low';
}
interface State {
  prefs: NudgePrefs;
  day: string;
  sent: { kind: string; at: string; score: number }[];
  exempt: number;
  held: Held[];
  weights: Record<string, number>;
  made: Record<string, { kind: string; value: number; urgency?: Urgency }>;
  digestDay?: string;
}

export const NUDGE_DEFAULTS: NudgePrefs = { budget: 4, digestHour: 17 };
/** Below this score a nudge always waits for the roundup. */
const LOW = 0.3;
/** How far the bar rises once the budget is used up (ranking: later slots need more value). */
const RISE = 0.5;
const FEWER = 0.6;
const FLOOR = 0.1;
const MAX_HELD = 30;

/** Labels for kinds that are not alert feeds (feeds use their own titles). */
const KIND_TITLES: Record<string, string> = {
  renewals: en('Renewals and paperwork'),
  gifts: en('Birthdays and gifts'),
  upkeep: en('Car and house upkeep'),
  trials: en('Free trials'),
  checkin: en('Her messages'),
  presence: en('Her reactions'),
  digest: en('Smaller things'),
};

export function kindLabel(app: AppContext, kind: string): string {
  return KIND_TITLES[kind] ?? (isFeed(kind) ? feedTitle(app, kind) : kind);
}
/** The English label (the web translates it with t()). */
const rawLabel = (kind: string): string => KIND_TITLES[kind] ?? FEEDS.find((f) => f.id === kind)?.title ?? kind;

const file = (app: AppContext) => join(app.dataDir, 'nudges.json');
const today = (app: AppContext) => localDate(app.now(), app.settings.get().timeZone);

function load(app: AppContext): State {
  let s: Partial<State> = {};
  try {
    if (existsSync(file(app))) s = JSON.parse(readFileSync(file(app), 'utf8')) as Partial<State>;
  } catch {
    s = {};
  }
  const day = today(app);
  const fresh = s.day !== day;
  return {
    prefs: { ...NUDGE_DEFAULTS, ...(s.prefs ?? {}) },
    day,
    sent: fresh ? [] : (s.sent ?? []),
    exempt: fresh ? 0 : (s.exempt ?? 0),
    held: s.held ?? [],
    weights: s.weights ?? {},
    made: s.made ?? {},
    ...(s.digestDay ? { digestDay: s.digestDay } : {}),
  };
}

function save(app: AppContext, s: State): void {
  const tmp = `${file(app)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file(app));
}

const clamp = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5);

/** The gate. Call it right before sending; `send: false` means don't send (it waits, if it can). */
export function askNudge(app: AppContext, ask: NudgeAsk): NudgeVerdict {
  const s = load(app);
  const what = rawLabel(ask.kind);
  const urgency = ask.urgency ?? 'normal';
  if (urgency !== 'normal') {
    s.exempt++;
    save(app, s);
    return {
      send: true,
      score: 1,
      why:
        urgency === 'safety'
          ? { key: en('{what}: safety comes first, so this skips quiet hours and the daily limit.'), params: { what } }
          : { key: en('{what}: you asked for this, so it never counts against your daily limit.'), params: { what } },
    };
  }
  const score = Math.round(clamp(ask.value) * (s.weights[ask.kind] ?? 1) * 100) / 100;
  const used = s.sent.length;
  const budget = Math.max(0, Math.floor(s.prefs.budget));
  const bar = budget > 0 ? LOW + (used / budget) * RISE : Infinity;
  const held: Held['held'] | undefined = quietNow(app) ? 'quiet' : score < LOW ? 'low' : used >= budget || score < bar ? 'budget' : undefined;
  if (held) {
    if (ask.digest !== false) {
      s.held.push({ kind: ask.kind, text: ask.text.slice(0, 400), score, at: app.now().toISOString(), held });
      s.held = s.held.sort((a, b) => b.score - a.score).slice(0, MAX_HELD);
    }
    save(app, s);
    return { send: false, held, score, why: { key: en('Waiting for your roundup of smaller things.'), params: { what } } };
  }
  s.sent.push({ kind: ask.kind, at: app.now().toISOString(), score });
  save(app, s);
  return { send: true, score, why: { key: en('{what}: nudge {n} of {budget} today. Smaller things wait for one roundup.'), params: { what, n: used + 1, budget } } };
}

/** "Fewer like this": that kind's score drops for this person (repeatable, with a floor). */
export function fewerLikeThis(app: AppContext, kind: string): number {
  const s = load(app);
  s.weights[kind] = Math.max(FLOOR, Math.round((s.weights[kind] ?? 1) * FEWER * 100) / 100);
  save(app, s);
  return s.weights[kind];
}

/** Undo: that kind counts fully again. */
export function moreLikeThis(app: AppContext, kind: string): void {
  const s = load(app);
  delete s.weights[kind];
  save(app, s);
}

export function saveNudgePrefs(app: AppContext, p: Partial<NudgePrefs>): NudgePrefs {
  const s = load(app);
  const n = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d);
  s.prefs = { budget: n(p.budget, 0, 20, s.prefs.budget), digestHour: n(p.digestHour, 0, 23, s.prefs.digestHour) };
  save(app, s);
  return s.prefs;
}

/** A reminder she made herself (renewals, gifts, upkeep, trials): it asks the gate when it is due. */
export function noteNudgeReminder(app: AppContext, reminderId: number, kind: string, value: number, urgency: Urgency = 'normal'): void {
  try {
    const s = load(app);
    s.made[String(reminderId)] = { kind, value: clamp(value), ...(urgency !== 'normal' ? { urgency } : {}) };
    const keys = Object.keys(s.made);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete s.made[k];
    save(app, s);
  } catch {
    /* a gate that can't write never stops the feature */
  }
}

export function nudgeKindOfReminder(app: AppContext, reminderId: number): { kind: string; value: number; urgency?: Urgency } | undefined {
  return load(app).made[String(reminderId)];
}

/** At the reminders' delivery: true = deliver it now. His own reminders never come here. */
export function reminderMayGo(app: AppContext, reminderId: number, text: string): { go: boolean; why?: Why; kind?: string } {
  let made: { kind: string; value: number; urgency?: Urgency } | undefined;
  try {
    made = nudgeKindOfReminder(app, reminderId);
  } catch {
    return { go: true };
  }
  if (!made) return { go: true };
  const v = askNudge(app, { kind: made.kind, value: made.value, ...(made.urgency ? { urgency: made.urgency } : {}), text });
  return { go: v.send, why: v.why, kind: made.kind };
}

/** For Settings → Automations → Her nudges. */
export function nudgeState(app: AppContext) {
  const s = load(app);
  const p = proactiveSettings(app);
  return {
    prefs: s.prefs,
    today: { day: s.day, sent: s.sent.length, budget: s.prefs.budget, exempt: s.exempt, kinds: s.sent.map((x) => x.kind) },
    held: s.held.map((h) => ({ kind: h.kind, label: rawLabel(h.kind), text: h.text, score: h.score, held: h.held, at: h.at })),
    kinds: Object.entries(s.weights).map(([kind, weight]) => ({ kind, label: rawLabel(kind), weight })),
    quiet: { start: p.quietStart, end: p.quietEnd },
  };
}

/** On the reminders' tick: the day's one roundup, after quiet hours, from the roundup hour on. */
export function nudgeTick(app: AppContext, now: Date = app.now()): string | undefined {
  if (!existsSync(file(app))) return undefined;
  const s = load(app);
  if (!s.held.length || s.digestDay === s.day || quietNow(app, now)) return undefined;
  const h = zonedParts(now, app.settings.get().timeZone).h;
  const oldest = Math.min(...s.held.map((x) => new Date(x.at).getTime()));
  if (h < s.prefs.digestHour && now.getTime() - oldest < 24 * 3_600_000) return undefined;
  const items = [...s.held].sort((a, b) => b.score - a.score);
  const set = app.settings.get();
  const content = [trOwner(en('A few smaller things, saved up so they would not interrupt you:'), set), ...items.map((x) => `- ${kindLabel(app, x.kind)}: ${x.text}`)].join('\n');
  s.held = [];
  s.digestDay = s.day;
  save(app, s);
  return postAlert(app, 'nudges', {
    origin: () => (ownChat(app) ?? { id: ownerWebChats(app, 1)[0]?.id }).id,
    role: 'assistant',
    reason: 'proactive',
    content,
    meta: { nudge: { kind: 'digest', why: { key: en('Smaller things saved up so they did not interrupt you: one roundup a day.'), params: {} }, kinds: [...new Set(items.map((x) => x.kind))] } },
  });
}

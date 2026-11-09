// Phase 121 part A (docs/design/BEGIN.md §4, 2.54.0): the routines gallery. A routine is a recipe
// for settings and rows that already exist: the morning briefing (settings.briefing), the weekly
// review (settings.weeklyReview), a repeating planner reminder, leave-by, the GitHub watcher (new
// issues, and CI runs since 2.54), a Phase 118 loop grown with a clock schedule and an end date (the
// paid ones), and the safety check-up's weekly quiet check. No cron, no new timer, no new run engine.
//
// R1 the catalog: templates/routines/*.json, read and checked at start (a bad file is skipped with a
//    log line, never half-loaded). A file never states its own cost.
// R2 preview: code only (no model call, no network): what Turn on will create, the next three runs,
//    the cost line, the needs, a sample from today's facts; `sig` hashes the answers + the cost line.
// R3 Turn on / Off: through each engine's own path; one `routines` row points at what it made. My
//    routines reads the engine's live state, never the row.
// R4 the cost line: from the engine, the answers, the model route and the caps code enforces.
//
// Tools a loop routine uses keep the owner's approval settings (the owner's answer to BEGIN §11 Q5):
// a tick that needs an OK pauses the routine and tells him, as every Phase 118 repeat does.
//
// Table (additive, the space's own store.db): routines (§4.14).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { briefingSettings } from './briefing.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { leaveBySettings } from './leaveby.ts';
import { loopsFor, nextScheduled, ROUTINE_MAX_DAYS, ROUTINE_MIN_EVERY_H, type Loop, type LoopSchedule } from './loops.ts';
import { privateLocalOn } from './net-guard.ts';
import { persistSettings } from './persist.ts';
import { zonedParts } from './planner.ts';
import { billingOf, findPrice, priceTable } from './usage.ts';
import { reviewSettings } from './review.ts';
import { GITHUB_VAULT } from './tools/coding.ts';
import { watchSettings } from './issues.ts';
import type { Tool } from './tools/types.ts';

export const ENGINES = ['briefing', 'review', 'reminder', 'leaveBy', 'githubWatch', 'ciWatch', 'loop', 'safetyWeekly'] as const;
export type Engine = (typeof ENGINES)[number];
/** Members may use these in their own space (BEGIN §7); never GitHub, hooks or loops. */
export const MEMBER_ENGINES: readonly Engine[] = ['briefing', 'review', 'reminder', 'leaveBy'];
const FREE: readonly Engine[] = ['reminder', 'leaveBy', 'githubWatch', 'ciWatch', 'safetyWeekly'];
export type FieldKind = 'time' | 'day' | 'text' | 'url' | 'number' | 'repo' | 'place' | 'pick';
export interface RoutineField {
  key: string;
  kind: FieldKind;
  label: string;
  default?: string | number;
  tip: string;
  choices?: { value: string; label: string }[];
  optional?: boolean;
}
export type NeedId = 'brain' | 'gmail' | 'calendar' | 'github' | 'home' | 'online';
export interface RoutineFile {
  id: string;
  version: number;
  title: string;
  pitch: string;
  icon?: string;
  category: 'everyday' | 'work' | 'coding' | 'safety';
  engine: Engine;
  fields: RoutineField[];
  needs: NeedId[];
  /** Needs that make it better but never block. */
  better?: NeedId[];
  defaults?: Record<string, string | number>;
  words?: { prompt?: string; until?: string; reads?: string };
  /** Tools a loop routine may use (read-only ones; they keep the owner's approval setting). */
  tools?: string[];
  source?: string;
}
export interface Need {
  id: NeedId;
  ok: boolean;
  label: string;
  open: string;
  better?: boolean;
}
export interface CostLine {
  free: boolean;
  calls?: { per: 'day' | 'week'; n: number };
  cap?: string;
  tokensPerDay?: number;
  usdPerDay?: number;
  endsAt?: string;
  local?: boolean;
  /** The line in the owner's words. */
  words: string;
  /** The short form (My routines). */
  short: string;
}
export interface Preview {
  ok: boolean;
  problems: { field: string; error: string }[];
  creates: string[];
  schedule: string;
  next: string[];
  cost: CostLine;
  needs: Need[];
  sample?: string;
  tools?: string;
  sig: string;
}

/** Tools a loop routine may name (read-only: nothing that sends, writes, organizes, buys or runs commands). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_search', 'gmail_search', 'gmail_read', 'gmail_thread', 'gmail_needs_answer', 'mail_search', 'mail_read', 'mail_thread', 'mail_needs_answer', 'calendar_list', 'recall']);

// ------------------------------------------------------------------ R1 the catalog

/** Checks one routine file; returns the problem or undefined. */
export function checkRoutineFile(j: unknown): string | undefined {
  const r = j as Record<string, unknown>;
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}(:[a-z0-9-]{1,40})?$/.test(r.id)) return 'bad id';
  if (typeof r.title !== 'string' || typeof r.pitch !== 'string') return 'needs a title and a pitch';
  if (!(ENGINES as readonly string[]).includes(String(r.engine))) return `unknown engine ${String(r.engine)}`;
  if ('cost' in r) return 'a routine file may not state its own cost';
  if (!Array.isArray(r.fields) || r.fields.length > 3) return 'at most three questions';
  for (const f of r.fields as RoutineField[]) if (!f || typeof f.key !== 'string' || !['time', 'day', 'text', 'url', 'number', 'repo', 'place', 'pick'].includes(f.kind)) return 'a bad question';
  if (!Array.isArray(r.needs)) return 'needs must be a list';
  for (const t of (r.tools as unknown[] | undefined) ?? []) if (!READ_ONLY_TOOLS.has(String(t))) return `${String(t)} is not a read-only tool`;
  if (r.tools && r.engine !== 'loop') return 'only loop routines name tools';
  return undefined;
}

let cache: { dir: string; list: RoutineFile[] } | undefined;
/** The built-in routines (templates/routines/*.json), checked; bad files skipped with a log line. */
export function loadCatalog(dir: string, o: { log?: (s: string) => void; fresh?: boolean } = {}): RoutineFile[] {
  if (cache && cache.dir === dir && !o.fresh) return cache.list;
  const log = o.log ?? ((m: string) => console.warn(m));
  const list: RoutineFile[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      let j: unknown;
      try {
        j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch (err) {
        log(`routines: ${f} skipped: ${(err as Error).message}`);
        continue;
      }
      const bad = checkRoutineFile(j);
      if (bad) {
        log(`routines: ${f} skipped: ${bad}`);
        continue;
      }
      list.push({ ...(j as RoutineFile), version: Number((j as RoutineFile).version) || 1, source: 'built-in' });
    }
  }
  cache = { dir, list };
  return list;
}

// ------------------------------------------------------------------ the table

const SQL = `CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  engine TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  target TEXT NOT NULL DEFAULT '{}',
  cost TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  off_at TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS routines_state ON routines(state);`;

export interface RoutineRow {
  id: number;
  routineId: string;
  version: number;
  source: string;
  engine: Engine;
  answers: Record<string, string | number>;
  target: { settingsKey?: string; reminderId?: number; repo?: string; loopId?: number; conversationId?: string };
  cost: CostLine;
  state: 'on' | 'off' | 'removed';
  createdAt: string;
  updatedAt: string;
  offAt: string | null;
  reason: string | null;
}
const toRow = (r: Record<string, unknown>): RoutineRow => ({ id: Number(r.id), routineId: String(r.routine_id), version: Number(r.version), source: String(r.source), engine: String(r.engine) as Engine, answers: JSON.parse(String(r.answers)), target: JSON.parse(String(r.target)), cost: JSON.parse(String(r.cost)), state: String(r.state) as RoutineRow['state'], createdAt: String(r.created_at), updatedAt: String(r.updated_at), offAt: (r.off_at as string | null) ?? null, reason: (r.reason as string | null) ?? null });

export class RoutineError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    if (field) this.field = field;
  }
}

// ------------------------------------------------------------------ the gallery

export class Routines {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #dir: string;

  constructor(app: AppContext, dir: string, db: DatabaseSync = app.store.db) {
    this.#app = app;
    this.#db = db;
    this.#dir = dir;
    db.exec(SQL);
  }

  #T(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }
  catalog(): RoutineFile[] {
    const all = loadCatalog(this.#dir);
    return this.#app.member ? all.filter((r) => MEMBER_ENGINES.includes(r.engine)) : all;
  }
  find(id: string): RoutineFile | undefined {
    return this.catalog().find((r) => r.id === id);
  }
  rows(): RoutineRow[] {
    return (this.#db.prepare("SELECT * FROM routines WHERE state != 'removed' ORDER BY id").all() as Record<string, unknown>[]).map(toRow);
  }
  row(rid: number): RoutineRow | undefined {
    const r = this.#db.prepare('SELECT * FROM routines WHERE id = ?').get(rid) as Record<string, unknown> | undefined;
    return r ? toRow(r) : undefined;
  }

  // ---------------------------------------------------------------- needs

  needs(r: RoutineFile): Need[] {
    const app = this.#app;
    const s = app.settings.get();
    const subs = app.subscriptions;
    const brain = Boolean(s.defaultProviderId && s.defaultModel) || Boolean(subs?.grokStatus().signedIn || subs?.claudeStatus().signedIn || subs?.chatgpt?.status().signedIn);
    const g = app.google?.status();
    const check: Record<NeedId, () => Omit<Need, 'id' | 'better'>> = {
      brain: () => ({ ok: brain, label: this.#T(en('A brain (an AI model)')), open: 'settings:models-default' }),
      gmail: () => ({ ok: Boolean(g?.gmail), label: 'Gmail', open: 'settings:ab-google' }),
      calendar: () => ({ ok: Boolean(g?.calendar), label: this.#T(en('Google Calendar')), open: 'settings:ab-google' }),
      github: () => ({ ok: Boolean(app.vault.get(GITHUB_VAULT)), label: this.#T(en('A GitHub token')), open: 'settings:ab-github' }),
      home: () => ({ ok: Boolean(leaveBySettings(app).home), label: this.#T(en('Your home place')), open: 'settings:you-leave-by' }),
      online: () => ({ ok: !privateLocalOn(), label: this.#T(en('Not in private local mode')), open: 'settings:models-local' }),
    };
    return [...r.needs.map((id) => ({ id, ...check[id]() })), ...(r.better ?? []).map((id) => ({ id, ...check[id](), better: true }))];
  }

  // ---------------------------------------------------------------- answers

  /** The routine's answers cleaned with each engine's own rules; throws 400 with the field. */
  clean(r: RoutineFile, raw: Record<string, unknown>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const f of r.fields) {
      const v = raw[f.key] ?? r.defaults?.[f.key] ?? f.default;
      const bad = (msg: string) => new RoutineError(400, msg, f.key);
      if ((v === undefined || v === '') && f.optional) continue;
      if (v === undefined || v === '') throw bad(this.#T(en('Answer “{q}”.'), { q: this.#T(f.label) }));
      const t = String(v).trim();
      switch (f.kind) {
        case 'time':
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw bad(en('Time must look like 07:30.'));
          out[f.key] = t;
          break;
        case 'day': {
          const n = Number(t);
          if (!Number.isInteger(n) || n < 0 || n > 6) throw bad(en('Pick a day of the week.'));
          out[f.key] = n;
          break;
        }
        case 'pick':
          if (!f.choices?.some((c) => c.value === t)) throw bad(en('Pick one of the choices.'));
          out[f.key] = t;
          break;
        case 'number': {
          const n = Number(t.replace(/[^\d.]/g, ''));
          if (!Number.isFinite(n) || n <= 0) throw bad(en('Type a number, like 90.'));
          out[f.key] = n;
          break;
        }
        case 'url': {
          let u: URL;
          try {
            u = new URL(t);
          } catch {
            throw bad(en('Paste the whole web address, starting with https://'));
          }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(en('Paste the whole web address, starting with https://'));
          out[f.key] = u.href.slice(0, 500);
          break;
        }
        case 'repo': {
          const repo = t.replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
          if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo)) throw bad(en('Name the repository as owner/name.'));
          out[f.key] = repo;
          break;
        }
        default:
          out[f.key] = t.slice(0, 200);
      }
    }
    for (const [k, v] of Object.entries(r.defaults ?? {})) if (out[k] === undefined && !r.fields.some((f) => f.key === k)) out[k] = v;
    if (r.engine === 'loop' && out.every !== undefined && Number(out.every) < ROUTINE_MIN_EVERY_H) throw new RoutineError(400, this.#T(en('A routine checks every {h} hours at most.'), { h: ROUTINE_MIN_EVERY_H }), 'every');
    if (out.days !== undefined && !(ROUTINE_MAX_DAYS as readonly number[]).includes(Number(out.days))) throw new RoutineError(400, en('Pick 7, 14, 30 or 90 days.'), 'days');
    return out;
  }

  /** The loop schedule (clock) or interval of a loop routine's answers. */
  #loopPlan(a: Record<string, string | number>): { schedule?: LoopSchedule; everyMin?: number; days: number } {
    const days = Number(a.days ?? 30);
    if (a.at) return { schedule: { at: String(a.at), repeat: a.repeat === 'daily' ? 'daily' : a.repeat === 'weekly' ? 'weekly' : 'weekdays' }, days };
    return { everyMin: Number(a.every ?? 12) * 60, days };
  }

  #schedule(r: RoutineFile, a: Record<string, string | number>): LoopSchedule | null {
    switch (r.engine) {
      case 'briefing':
        return { at: String(a.time ?? briefingSettings(this.#app).time), repeat: 'daily' };
      case 'review':
        return { at: String(a.time ?? '18:00'), repeat: 'weekly', day: Number(a.day ?? 0) };
      case 'reminder':
        return { at: String(a.time), repeat: a.repeat === 'weekdays' ? 'weekdays' : 'daily' };
      case 'loop':
        return this.#loopPlan(a).schedule ?? null;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- R4 the cost line

  costLine(r: RoutineFile, a: Record<string, string | number>): CostLine {
    const app = this.#app;
    const s = app.settings.get();
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    if (FREE.includes(r.engine)) return { free: true, words: T(en('Free · no model calls.')), short: T(en('Free')) };
    const route = r.engine === 'loop' ? undefined : s.routes?.background;
    const providerId = route?.providerId ?? s.defaultProviderId;
    const model = route?.model ?? s.defaultModel ?? '';
    const prov = s.providers.find((p) => p.id === providerId);
    const billing = prov ? billingOf(prov) : 'local';
    const price = prov ? findPrice(priceTable(s.prices), prov.id, model) : undefined;
    if (r.engine === 'briefing' || r.engine === 'review') {
      const per = r.engine === 'briefing' ? 'day' : 'week';
      const tokens = 3000;
      const usd = price ? (tokens * 0.8 * price.inPerM + tokens * 0.2 * price.outPerM) / 1e6 : undefined;
      const head = per === 'day' ? T(en('About 1 model call a day')) : T(en('About 1 model call a week'));
      const cap = per === 'day' ? T(en('At most 1 a day.')) : T(en('At most 1 a week.'));
      const how = billing === 'local' ? T(en('on your own computer (no money)')) : billing === 'subscription' ? T(en('from your subscription')) : usd !== undefined ? T(en('≈ {tokens} tokens, about ${usd}'), { tokens: tokens.toLocaleString('en-US'), usd: usd < 0.01 ? '0.01' : usd.toFixed(2) }) : T(en('≈ {tokens} tokens; Sara has no price for this model'), { tokens: tokens.toLocaleString('en-US') });
      return { free: false, calls: { per, n: 1 }, cap, local: billing === 'local', ...(usd !== undefined ? { usdPerDay: per === 'day' ? usd : usd / 7 } : {}), words: `${head} (${how}). ${cap}`, short: per === 'day' ? T(en('1 call a day')) : T(en('1 call a week')) };
    }
    // A loop routine: turns a day from the schedule, the per-routine daily share, the all-repeats caps, the end.
    const set = persistSettings(app).loops;
    const plan = this.#loopPlan(a);
    const perDay = plan.schedule ? 1 : Math.max(1, Math.round(1440 / (plan.everyMin ?? 720)));
    const share = Math.max(1, Math.floor(set.dailyTokens / set.maxActive));
    const endsAt = new Date(app.now().getTime() + plan.days * 86_400_000);
    const date = this.#date(endsAt);
    const unpriced = billing === 'api' && !price && set.dailyUsd > 0;
    const head = plan.schedule ? (plan.schedule.repeat === 'weekdays' ? T(en('About 1 model turn on weekdays')) : T(en('About 1 model turn a day'))) : T(en('About {n} model turns a day'), { n: perDay });
    const words = unpriced
      ? `${head}. ${T(en('Sara has no price for this model, so the dollar limit stops it at the first call: pick a priced or local model.'))} ${T(en('Ends {date}.'), { date })}`
      : `${head} (${T(en('each at most {tokens} tokens'), { tokens: set.tick.tokens.toLocaleString('en-US') })}${billing === 'local' ? `, ${T(en('on your own computer (no money)'))}` : ''}). ${T(en('At most {share} tokens a day for this routine; all routines and repeats together at most {all} tokens and ${usd} a day.'), { share: share.toLocaleString('en-US'), all: set.dailyTokens.toLocaleString('en-US'), usd: set.dailyUsd.toFixed(2) })} ${T(en('Ends {date}.'), { date })}`;
    return { free: false, calls: { per: 'day', n: perDay }, cap: T(en('At most {share} tokens a day'), { share: share.toLocaleString('en-US') }), tokensPerDay: share, endsAt: endsAt.toISOString(), local: billing === 'local', words, short: T(en('~{n} turn(s) a day'), { n: perDay }) };
  }

  #date(d: Date): string {
    const tz = this.#app.settings.get().timeZone;
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', ...(tz ? { timeZone: tz } : {}) }).format(d);
  }
  #when(d: Date): string {
    const tz = this.#app.settings.get().timeZone;
    const p = zonedParts(d, tz);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${this.#T(days[p.wd])} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  }

  /** "Every day at 7:30" / "Weekdays at 8:00, until 2 December" … in words. */
  whenWords(r: RoutineFile, a: Record<string, string | number>): string {
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    const sc = this.#schedule(r, a);
    const until = r.engine === 'loop' ? `, ${T(en('until {date}'), { date: this.#date(new Date(this.#app.now().getTime() + this.#loopPlan(a).days * 86_400_000)) })}` : '';
    if (sc) {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const base = sc.repeat === 'daily' ? T(en('Every day at {time}'), { time: sc.at }) : sc.repeat === 'weekdays' ? T(en('Weekdays at {time}'), { time: sc.at }) : T(en('Every {day} at {time}'), { day: T(days[sc.day ?? 0]), time: sc.at });
      return base + until;
    }
    if (r.engine === 'loop') return `${T(en('Every {h} hours'), { h: Number(a.every ?? 12) })}${until}`;
    if (r.engine === 'githubWatch' || r.engine === 'ciWatch') return T(en('Sara checks GitHub every 15 minutes'));
    if (r.engine === 'leaveBy') return T(en('When a meeting has an address'));
    if (r.engine === 'safetyWeekly') return T(en('Once a week'));
    return '';
  }

  #creates(r: RoutineFile, a: Record<string, string | number>): string[] {
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    switch (r.engine) {
      case 'briefing':
        return [T(en('Switch on the morning briefing at {time}'), { time: a.time }) + (a.place ? ` ${T(en('in {place}'), { place: a.place })}` : '')];
      case 'review':
        return [T(en('Switch on the weekly review'))];
      case 'reminder':
        return [T(en('Add a repeating reminder: “{text}”'), { text: a.text })];
      case 'leaveBy':
        return [T(en('Switch on leave-by reminders'))];
      case 'githubWatch':
        return [T(en('Watch {repo} for new issues'), { repo: a.repo })];
      case 'ciWatch':
        return [T(en('Watch the GitHub Actions runs of {repo} on {branch}'), { repo: a.repo, branch: a.branch || 'main' })];
      case 'loop':
        return [T(en('Make a chat “{title}” and check it on this schedule until the end date'), { title: this.#title(r, a) })];
      case 'safetyWeekly':
        return [T(en('Switch on the weekly safety check'))];
    }
  }
  #title(r: RoutineFile, a: Record<string, string | number>): string {
    if (r.engine === 'loop' && a.url) {
      try {
        return `${this.#T(r.title)} · ${new URL(String(a.url)).hostname.replace(/^www\./, '')}`;
      } catch {
        /* fall through */
      }
    }
    return this.#T(r.title);
  }

  // ---------------------------------------------------------------- R2 preview

  preview(id: string, raw: Record<string, unknown>): Preview {
    const r = this.find(id);
    if (!r) throw new RoutineError(404, en('Routine not found.'));
    this.#allowed(r);
    const a = this.clean(r, raw);
    const needs = this.needs(r);
    const cost = this.costLine(r, a);
    const sc = this.#schedule(r, a);
    const tz = this.#app.settings.get().timeZone;
    const next: string[] = [];
    if (sc) for (let t = nextScheduled(sc, this.#app.now(), tz); next.length < 3; t = nextScheduled(sc, t, tz)) next.push(this.#when(t));
    else if (r.engine === 'loop') for (let i = 1; i <= 3; i++) next.push(this.#when(new Date(this.#app.now().getTime() + i * Number(a.every ?? 12) * 3_600_000)));
    const out: Preview = { ok: needs.every((n) => n.ok || n.better), problems: [], creates: this.#creates(r, a), schedule: this.whenWords(r, a), next, cost, needs, sig: '' };
    if (r.engine === 'briefing') out.sample = this.#sample(a);
    if (r.engine === 'loop') out.tools = this.#T(en('She may use {tools} for this. Your approval settings still apply: if one of them is set to Ask, the routine pauses and tells you.'), { tools: (r.tools ?? []).join(', ') });
    out.sig = sigOf(id, a, cost);
    return out;
  }

  /** The briefing's sample from today's facts, no model and no network. */
  #sample(a: Record<string, string | number>): string {
    const app = this.#app;
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    const todos = app.planner?.tasks({ status: 'open' }).length ?? 0;
    const rem = app.planner?.reminders({ status: 'pending', limit: 50, kind: 'timed' }).length ?? 0;
    const place = a.place || briefingSettings(app).place?.name;
    return `${T(en('Sample, without her words:'))} ` + [place ? T(en('the weather in {place}'), { place }) : T(en('the weather (add a place)')), T(en('{n} to-do(s)'), { n: todos }), T(en('{n} reminder(s)'), { n: rem }), app.google?.status().calendar ? T(en('your first meetings')) : '', app.google?.status().gmail ? T(en('important mail')) : ''].filter(Boolean).join(' · ');
  }

  #allowed(r: RoutineFile): void {
    if (this.#app.member && !MEMBER_ENGINES.includes(r.engine)) throw new RoutineError(403, en('Only the owner of this server can use this.'));
    if (r.engine === 'loop' && !this.#app.loops && !this.#app.member) loopsFor(this.#app);
    if (r.engine === 'loop' && privateLocalOn()) throw new RoutineError(409, en("Can't run in private local mode: it reads the web or your mailbox."));
  }

  // ---------------------------------------------------------------- R3 Turn on

  async turnOn(id: string, raw: Record<string, unknown>, sig: unknown, o: { geocode?: (name: string) => Promise<{ name: string; lat: number; lon: number }> } = {}): Promise<RoutineRow> {
    const r = this.find(id);
    if (!r) throw new RoutineError(404, en('Routine not found.'));
    this.#allowed(r);
    const a = this.clean(r, raw);
    const needs = this.needs(r);
    const cost = this.costLine(r, a);
    if (typeof sig !== 'string' || sig !== sigOf(id, a, cost)) throw new RoutineError(409, en('Something changed since the preview. Look at it again, then turn it on.'));
    if (needs.some((n) => !n.ok && !n.better)) throw new RoutineError(412, en('Set up what it needs first.'));
    const app = this.#app;
    const now = app.now().toISOString();
    let target: RoutineRow['target'] = {};
    switch (r.engine) {
      case 'briefing': {
        const cur = briefingSettings(app);
        let place = cur.place;
        if (a.place && a.place !== cur.place?.name) {
          if (!o.geocode) throw new RoutineError(400, en('Set the place on the Morning briefing page.'), 'place');
          try {
            place = await o.geocode(String(a.place));
          } catch (err) {
            throw new RoutineError(400, (err as Error).message, 'place');
          }
        }
        const fresh = briefingSettings(app);
        app.settings.update({ briefing: { ...fresh, enabled: true, time: String(a.time), ...(place ? { place } : {}), ...(fresh.time !== a.time ? { lastDay: undefined } : {}) } });
        target = { settingsKey: 'briefing' };
        break;
      }
      case 'review':
        app.settings.update({ weeklyReview: { ...reviewSettings(app), enabled: true, day: Number(a.day), time: String(a.time) } });
        target = { settingsKey: 'weeklyReview' };
        break;
      case 'reminder': {
        if (!app.planner) throw new RoutineError(400, en('Reminders are not available.'));
        const sc = this.#schedule(r, a)!;
        const due = nextScheduled(sc, app.now(), app.settings.get().timeZone);
        const rem = app.planner.addReminder({ text: String(a.text), dueAt: due.toISOString(), repeat: sc.repeat === 'weekdays' ? 'weekdays' : 'daily' });
        target = { reminderId: rem.id };
        break;
      }
      case 'leaveBy':
        app.settings.update({ leaveBy: { ...leaveBySettings(app), enabled: true, ...(a.mode ? { mode: a.mode as 'car' | 'bike' | 'foot' } : {}) } });
        target = { settingsKey: 'leaveBy' };
        break;
      case 'githubWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, repos: [...new Set([...w.repos, String(a.repo)])], everyMinutes: w.everyMinutes || 15, ...(a.label ? { label: String(a.label) } : {}) } });
        target = { repo: String(a.repo) };
        break;
      }
      case 'ciWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, ciRepos: [...new Set([...(w.ciRepos ?? []), String(a.repo)])], ciBranch: { ...(w.ciBranch ?? {}), [String(a.repo)]: String(a.branch || 'main') }, everyMinutes: 15 } });
        target = { repo: String(a.repo) };
        break;
      }
      case 'safetyWeekly':
        app.settings.update({ safetyCheck: { ...(app.settings.get().safetyCheck ?? {}), weekly: true } });
        target = { settingsKey: 'safetyCheck' };
        break;
      case 'loop': {
        const loops = loopsFor(app);
        const rowId = this.#insert(r, a, {}, cost, now);
        const conv = app.store.createConversation({ title: this.#title(r, a) });
        this.#file(conv.id);
        const prompt = fill(r.words?.prompt ?? r.pitch, a);
        const plan = this.#loopPlan(a);
        const made = loops.createRoutine(conv.id, { prompt, ...(plan.schedule ? { schedule: plan.schedule } : { everyMin: plan.everyMin! }), days: plan.days, ...(r.words?.until ? { untilText: fill(r.words.until, a) } : {}), routineId: rowId });
        if ('error' in made) {
          this.#db.prepare('DELETE FROM routines WHERE id = ?').run(rowId);
          app.store.deleteConversation?.(conv.id);
          throw new RoutineError(made.status, made.error);
        }
        this.#db.prepare('UPDATE routines SET target = ? WHERE id = ?').run(JSON.stringify({ loopId: made.loop.id, conversationId: conv.id }), rowId);
        return this.row(rowId)!;
      }
    }
    return this.row(this.#insert(r, a, target, cost, now))!;
  }

  #insert(r: RoutineFile, a: Record<string, string | number>, target: RoutineRow['target'], cost: CostLine, now: string): number {
    return Number(this.#db.prepare('INSERT INTO routines (routine_id, version, source, engine, answers, target, cost, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.version, r.source ?? 'built-in', r.engine, JSON.stringify(a), JSON.stringify(target), JSON.stringify(cost), 'on', now, now).lastInsertRowid);
  }
  /** Routine chats are filed under a \"Routines\" project (renamable, hideable), so ticks never clutter his main chat. */
  #file(conversationId: string): void {
    const p = this.#app.planner;
    if (!p) return;
    try {
      const proj = p.createBuiltinProject('routines', 'Routines');
      this.#app.store.updateConversation(conversationId, { projectId: proj.id });
    } catch {
      /* filing is a nicety */
    }
  }

  // ---------------------------------------------------------------- live state, Off, On, Remove

  #loopOf(row: RoutineRow): Loop | undefined {
    return row.target.loopId ? this.#app.loops?.get(row.target.loopId) : undefined;
  }
  /** The engine's live state (never the row's). */
  live(row: RoutineRow): { on: boolean; status: string; next?: string } {
    const app = this.#app;
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    const r = { engine: row.engine } as RoutineFile;
    switch (row.engine) {
      case 'briefing':
        return { on: briefingSettings(app).enabled, status: '' };
      case 'review':
        return { on: reviewSettings(app).enabled, status: '' };
      case 'leaveBy':
        return { on: leaveBySettings(app).enabled, status: '' };
      case 'reminder': {
        const rem = app.planner?.reminders({ status: 'all', limit: 500 }).find((x) => x.id === row.target.reminderId);
        return { on: rem?.status === 'pending', status: rem?.status === 'pending' ? T(en('Next: {when}'), { when: this.#when(new Date(rem.dueAt)) }) : '' };
      }
      case 'githubWatch':
        return { on: watchSettings(app).repos.includes(String(row.target.repo)) && watchSettings(app).everyMinutes > 0, status: '' };
      case 'ciWatch':
        return { on: (watchSettings(app).ciRepos ?? []).includes(String(row.target.repo)) && watchSettings(app).everyMinutes > 0, status: '' };
      case 'safetyWeekly':
        return { on: app.settings.get().safetyCheck?.weekly === true, status: '' };
      case 'loop': {
        const l = this.#loopOf(row);
        if (!l) return { on: false, status: T(en('Ended')) };
        if (l.state === 'done') return { on: false, status: T(en('Ended: {why}'), { why: l.untilText ?? T(en('done')) }) };
        if (l.state === 'ended') return { on: false, status: T(en('Ended')) };
        if (l.state === 'stopped') return { on: false, status: l.reason === 'owner' ? '' : T(en('Stopped: {why}'), { why: l.reason ?? '' }) };
        if (l.state === 'paused') return { on: true, status: l.reason === 'cap:day' ? T(en('Paused: daily limit (back tomorrow)')) : l.reason === 'approval' ? T(en('Paused: it needs your OK')) : T(en('Paused: {why}'), { why: l.reason ?? '' }) };
        void r;
        return { on: true, status: l.nextAt ? T(en('Next: {when}'), { when: this.#when(new Date(l.nextAt)) }) : '' };
      }
    }
  }

  off(rid: number, reason = 'owner'): RoutineRow {
    const row = this.row(rid);
    if (!row || row.state === 'removed') throw new RoutineError(404, en('Routine not found.'));
    this.#engineOff(row);
    this.#db.prepare("UPDATE routines SET state = 'off', off_at = ?, reason = ?, updated_at = ? WHERE id = ?").run(this.#app.now().toISOString(), reason, this.#app.now().toISOString(), rid);
    return this.row(rid)!;
  }
  #engineOff(row: RoutineRow): void {
    const app = this.#app;
    switch (row.engine) {
      case 'briefing':
        app.settings.update({ briefing: { ...briefingSettings(app), enabled: false } });
        break;
      case 'review':
        app.settings.update({ weeklyReview: { ...reviewSettings(app), enabled: false } });
        break;
      case 'leaveBy':
        app.settings.update({ leaveBy: { ...leaveBySettings(app), enabled: false } });
        break;
      case 'reminder':
        if (row.target.reminderId) app.planner?.cancelReminder(row.target.reminderId);
        break;
      case 'githubWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, repos: w.repos.filter((x) => x !== row.target.repo) } });
        break;
      }
      case 'ciWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, ciRepos: (w.ciRepos ?? []).filter((x) => x !== row.target.repo) } });
        break;
      }
      case 'safetyWeekly':
        app.settings.update({ safetyCheck: { ...(app.settings.get().safetyCheck ?? {}), weekly: false } });
        break;
      case 'loop':
        if (row.target.loopId) this.#app.loops?.stop(row.target.loopId);
        break;
    }
  }
  /** Back on (free and settings routines; a paused loop resumes; an ended paid one needs a new preview). */
  on(rid: number): RoutineRow {
    const row = this.row(rid);
    if (!row || row.state === 'removed') throw new RoutineError(404, en('Routine not found.'));
    const app = this.#app;
    const r = this.find(row.routineId);
    switch (row.engine) {
      case 'loop': {
        const l = this.#loopOf(row);
        if (l?.state === 'paused') {
          const out = loopsFor(app).resume(l.id);
          if ('error' in out) throw new RoutineError(out.status, out.error);
          break;
        }
        if (!l || l.state !== 'active') throw new RoutineError(409, en('This routine has ended. It needs a new preview to turn on again.'));
        break;
      }
      case 'reminder': {
        if (!r) throw new RoutineError(409, en('This routine has ended. It needs a new preview to turn on again.'));
        const sc = this.#schedule(r, row.answers)!;
        const rem = app.planner!.addReminder({ text: String(row.answers.text), dueAt: nextScheduled(sc, app.now(), app.settings.get().timeZone).toISOString(), repeat: sc.repeat === 'weekdays' ? 'weekdays' : 'daily' });
        this.#db.prepare('UPDATE routines SET target = ? WHERE id = ?').run(JSON.stringify({ reminderId: rem.id }), rid);
        break;
      }
      case 'briefing':
        app.settings.update({ briefing: { ...briefingSettings(app), enabled: true } });
        break;
      case 'review':
        app.settings.update({ weeklyReview: { ...reviewSettings(app), enabled: true } });
        break;
      case 'leaveBy':
        app.settings.update({ leaveBy: { ...leaveBySettings(app), enabled: true } });
        break;
      case 'githubWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, repos: [...new Set([...w.repos, String(row.target.repo)])], everyMinutes: w.everyMinutes || 15 } });
        break;
      }
      case 'ciWatch': {
        const w = watchSettings(app);
        app.settings.update({ githubWatch: { ...w, ciRepos: [...new Set([...(w.ciRepos ?? []), String(row.target.repo)])], everyMinutes: w.everyMinutes || 15 } });
        break;
      }
      case 'safetyWeekly':
        app.settings.update({ safetyCheck: { ...(app.settings.get().safetyCheck ?? {}), weekly: true } });
        break;
    }
    this.#db.prepare("UPDATE routines SET state = 'on', off_at = NULL, reason = NULL, updated_at = ? WHERE id = ?").run(app.now().toISOString(), rid);
    return this.row(rid)!;
  }
  remove(rid: number): void {
    const row = this.row(rid);
    if (!row || row.state === 'removed') throw new RoutineError(404, en('Routine not found.'));
    this.#engineOff(row);
    this.#db.prepare("UPDATE routines SET state = 'removed', off_at = COALESCE(off_at, ?), reason = COALESCE(reason, 'owner'), updated_at = ? WHERE id = ?").run(this.#app.now().toISOString(), this.#app.now().toISOString(), rid);
  }
  /** *Run now*: the briefing, the review or a loop routine's tick (the cost is on the button). */
  async runNow(rid: number): Promise<{ ok: true }> {
    const row = this.row(rid);
    if (!row) throw new RoutineError(404, en('Routine not found.'));
    const app = this.#app;
    if (row.engine === 'briefing' && app.briefing) await app.briefing.send();
    else if (row.engine === 'review' && app.review) await (app.review as unknown as { send: () => Promise<unknown> }).send();
    else if (row.engine === 'loop' && row.target.loopId) {
      const out = loopsFor(app).runNow(row.target.loopId);
      if ('error' in out) throw new RoutineError(out.status, out.error);
    } else throw new RoutineError(400, en('This routine has no Run now.'));
    return { ok: true };
  }

  // ---------------------------------------------------------------- My routines (with *Set up elsewhere*)

  mine(): { rid?: number; routineId?: string; engine: string; title: string; when: string; cost: string; status: string; on: boolean; reason: string | null; elsewhere?: true; kind?: string; key?: string; conversationId?: string; answers?: Record<string, string | number> }[] {
    const app = this.#app;
    const T = (t: string, p?: Record<string, unknown>) => this.#T(t, p);
    const out: ReturnType<Routines['mine']> = [];
    const rows = this.rows();
    for (const row of rows) {
      const r = this.find(row.routineId);
      const live = this.live(row);
      const title = r ? (row.engine === 'loop' ? this.#title(r, row.answers) : row.engine === 'reminder' ? String(row.answers.text) : T(r.title)) : row.routineId;
      out.push({ rid: row.id, routineId: row.routineId, engine: row.engine, title, when: r ? this.whenWords(r, row.answers).replace(/, until .*$/, '') + (row.cost.endsAt ? ` · ${T(en('until {date}'), { date: this.#date(new Date(row.cost.endsAt)) })}` : '') : '', cost: row.cost.short ?? '', status: live.status, on: live.on, reason: row.reason, ...(row.target.conversationId ? { conversationId: row.target.conversationId } : {}), answers: row.answers });
    }
    // Things already on a schedule, set up elsewhere (one list of everything that runs).
    const has = (engine: string, pred: (x: RoutineRow) => boolean = () => true) => rows.some((x) => x.engine === engine && pred(x) && this.live(x).on);
    const b = briefingSettings(app);
    if (b.enabled && !has('briefing')) out.push({ engine: 'briefing', title: T(en('Morning briefing')), when: T(en('Every day at {time}'), { time: b.time }), cost: T(en('1 call a day')), status: '', on: true, reason: null, elsewhere: true, kind: 'briefing', key: 'briefing' });
    const rv = reviewSettings(app);
    if (rv.enabled && !has('review')) out.push({ engine: 'review', title: T(en('Weekly review')), when: '', cost: T(en('1 call a week')), status: '', on: true, reason: null, elsewhere: true, kind: 'review', key: 'review' });
    const mineRem = new Set(rows.map((x) => x.target.reminderId).filter(Boolean));
    for (const rem of app.planner?.reminders({ status: 'pending', limit: 200, kind: 'timed' }) ?? []) {
      if (!rem.repeat || rem.repeat === 'none' || mineRem.has(rem.id)) continue;
      out.push({ engine: 'reminder', title: rem.text, when: rem.repeat, cost: T(en('Free')), status: T(en('Next: {when}'), { when: this.#when(new Date(rem.dueAt)) }), on: true, reason: null, elsewhere: true, kind: 'reminder', key: String(rem.id) });
    }
    if (!app.member) {
      const w = watchSettings(app);
      const mineRepos = new Set(rows.filter((x) => x.engine === 'githubWatch').map((x) => x.target.repo));
      if (w.everyMinutes) for (const repo of w.repos) if (!mineRepos.has(repo)) out.push({ engine: 'githubWatch', title: T(en('New issues: {repo}'), { repo }), when: '', cost: T(en('Free')), status: '', on: true, reason: null, elsewhere: true, kind: 'repo', key: repo });
      const mineLoops = new Set(rows.map((x) => x.target.loopId).filter(Boolean));
      for (const l of app.loops?.all() ?? []) {
        if (mineLoops.has(l.id) || l.routineId !== null || !['active', 'ticking', 'paused'].includes(l.state)) continue;
        out.push({ engine: 'loop', title: l.prompt.slice(0, 80), when: `${Math.round(l.everyMin)} min`, cost: T(en('Repeat in a chat')), status: l.state === 'paused' ? T(en('Paused: {why}'), { why: l.reason ?? '' }) : '', on: true, reason: null, elsewhere: true, kind: 'loop', key: String(l.id), conversationId: l.conversationId });
      }
    }
    return out;
  }

  /** The *Set up elsewhere* switch, through the engine's own off. */
  elsewhereOff(kind: string, key: string): void {
    const app = this.#app;
    if (kind === 'briefing') app.settings.update({ briefing: { ...briefingSettings(app), enabled: false } });
    else if (kind === 'review') app.settings.update({ weeklyReview: { ...reviewSettings(app), enabled: false } });
    else if (kind === 'reminder') app.planner?.cancelReminder(Number(key));
    else if (kind === 'repo' && !app.member) {
      const w = watchSettings(app);
      app.settings.update({ githubWatch: { ...w, repos: w.repos.filter((x) => x !== key) } });
    } else if (kind === 'loop' && !app.member) app.loops?.stop(Number(key));
    else throw new RoutineError(404, en('Routine not found.'));
  }

  /** Getting started: any routine on (a briefing switched on anywhere counts). */
  anyOn(): boolean {
    return this.mine().some((x) => x.on);
  }
}

const fill = (t: string, a: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (a[k] !== undefined ? String(a[k]) : m));
export function sigOf(id: string, a: Record<string, string | number>, cost: CostLine): string {
  return createHash('sha256').update(JSON.stringify([id, Object.entries(a).sort(), cost.words])).digest('hex').slice(0, 20);
}

/** This space's routines (made on first use). */
export function routinesFor(app: AppContext, dir?: string): Routines {
  const a = app as AppContext & { routines?: Routines };
  a.routines ??= new Routines(app, dir ?? join(app.rootDir ?? import.meta.dirname, '..', 'templates', 'routines'));
  return a.routines;
}
export const ROUTINES_DIR = join(import.meta.dirname, '..', 'templates', 'routines');

/** Her tool: draws a routine's card in the chat. It never turns anything on. */
export function createSuggestRoutineTool(app: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'suggest_routine',
      description: 'When the owner asks for something on a schedule ("every morning", "check this daily"), show him the matching ready-made routine card: what it does, when, what it needs and costs. You cannot turn it on: he taps Turn on in Planner → Routines.',
      parameters: { type: 'object', properties: { routine: { type: 'string', description: 'A routine id or a few words (e.g. "price watch", "morning briefing").' } }, required: ['routine'] },
    },
    summarize: (a) => `Show the routine card: ${String(a.routine ?? '')}`,
    async run(args) {
      const rs = routinesFor(app(), ROUTINES_DIR);
      const q = String(args.routine ?? '').toLowerCase();
      const r = rs.catalog().find((x) => x.id === q) ?? rs.catalog().find((x) => x.title.toLowerCase().includes(q) || q.split(/\s+/).every((w) => `${x.title} ${x.pitch}`.toLowerCase().includes(w)));
      if (!r) return `No ready-made routine matches. There are: ${rs.catalog().map((x) => x.title).join(', ')}.`;
      let a: Record<string, string | number> = {};
      try {
        a = rs.clean(r, {});
      } catch {
        a = { ...(r.defaults ?? {}), ...Object.fromEntries(r.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default!])) };
      }
      const needs = rs.needs(r);
      return `Routine card (shown to him; nothing is on yet): ${r.title}: ${r.pitch}\nWhen: ${rs.whenWords(r, a)}\nNeeds: ${needs.map((n) => `${n.ok ? '✓' : '✗'} ${n.label}`).join(', ') || 'nothing'}\nCosts: ${rs.costLine(r, a).words}\nHe turns it on in Planner → Routines (open: routines:${r.id}).`;
    },
  };
}

// C8 (docs/ops/C8_DESIGN.md, docs/COSTS.md): spend control. Three parts, all on the existing usage
// ledger (src/usage.ts):
//   1. Price tags: a tool or picture engine that costs money has a price per call (a small built-in
//      table, an add-on's manifest `costs`, or the owner's own row). The approval card and the tool
//      step say "about $X" before it runs; a paid tool with no known price says "cost unknown".
//   2. Spend limits: dollars per day and per month overall (model calls and paid tools together) and
//      per tool. At a limit a paid tool call stops with a plain message; the owner can allow one call
//      on its card. The policy pin `spendCap` is a hard daily cap with no override.
//   3. Token Saver: off / on / auto. On = shorter replies, a smaller history window, fewer tool
//      steps and the quick model route when one is set. Auto turns on near a daily threshold and off
//      again below a lower line (hysteresis) or at the day's reset. Off changes nothing at all.
import { en, trOwner } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { PICTURE_PRICE } from './own-photos.ts';
import { dayStartUtc } from './planner.ts';
import type { Settings } from './settings.ts';
import type { UsageStore } from './usage.ts';

// ------------------------------------------------------------------------------------------------
// price tags
// ------------------------------------------------------------------------------------------------

/** What one call of a paid tool costs. `usd: null` = it costs money, but how much isn't known. */
export interface PriceTag {
  usd: number | null;
  source: 'built-in' | 'add-on' | 'owner';
}

/** The owner's limits and own prices (Settings → Data & health → Usage and costs → Spend limits). */
export interface SpendSettings {
  /** 0 = no limit. US dollars, counted in the owner's time zone. */
  dayUsd: number;
  monthUsd: number;
  /** Per tool (its name): its own day/month limit. */
  perTool: Record<string, { dayUsd?: number; monthUsd?: number }>;
  /** The owner's own price per call for a tool (wins over the built-in table and the add-on). */
  prices: Record<string, number>;
}
export const DEFAULT_SPEND: SpendSettings = { dayUsd: 0, monthUsd: 0, perTool: {}, prices: {} };
const TOOL_NAME = /^[a-z][\w-]{0,99}$/i;
const money = (v: unknown, max = 100_000): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n * 10_000) / 10_000) : 0;
};

/** The owner's spend settings, cleaned (unknown keys dropped, every number in range). */
export function spendSettings(s: { spend?: unknown } | undefined): SpendSettings {
  const v = (s?.spend ?? {}) as Record<string, unknown>;
  const perTool: SpendSettings['perTool'] = {};
  for (const [k, raw] of Object.entries((v.perTool ?? {}) as Record<string, unknown>).slice(0, 100)) {
    if (!TOOL_NAME.test(k) || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const d = money(r.dayUsd);
    const m = money(r.monthUsd);
    if (d || m) perTool[k] = { ...(d ? { dayUsd: d } : {}), ...(m ? { monthUsd: m } : {}) };
  }
  const prices: Record<string, number> = {};
  for (const [k, raw] of Object.entries((v.prices ?? {}) as Record<string, unknown>).slice(0, 200)) {
    const n = Number(raw);
    if (TOOL_NAME.test(k) && Number.isFinite(n) && n >= 0 && n <= 1000) prices[k] = Math.round(n * 10_000) / 10_000;
  }
  return { dayUsd: money(v.dayUsd), monthUsd: money(v.monthUsd), perTool, prices };
}

/**
 * The price tag of a call, or undefined when the tool doesn't cost money. Order: the owner's own
 * price, the tool's declared cost (an add-on's manifest `costs`), the built-in table (pictures by
 * engine: Grok and OpenAI are paid, ComfyUI on your own computer is free, "an image tool" unknown).
 */
export function priceTagFor(o: { settings: Settings; tool?: { cost?: number | null } }, name: string): PriceTag | undefined {
  const own = spendSettings(o.settings).prices[name];
  if (own !== undefined) return own > 0 ? { usd: own, source: 'owner' } : undefined;
  if (o.tool && o.tool.cost !== undefined) return o.tool.cost === 0 ? undefined : { usd: o.tool.cost, source: 'add-on' };
  if (name === 'take_photo') {
    const engine = o.settings.photos?.engine ?? 'grok';
    const p = PICTURE_PRICE[engine];
    return p === 0 ? undefined : { usd: p ?? null, source: 'built-in' };
  }
  return undefined;
}

/** "about $0.07" / "cost unknown" (English; the web and bridges translate). */
export function priceLine(tag: PriceTag): string {
  return tag.usd === null ? 'cost unknown' : `about $${tag.usd < 0.1 ? tag.usd.toFixed(3).replace(/0$/, '') : tag.usd.toFixed(2)}`;
}

// ------------------------------------------------------------------------------------------------
// spend limits
// ------------------------------------------------------------------------------------------------

/** Where the owner's day and month begin (ISO times), in his time zone. */
export function periodStarts(now: Date, tz: string | undefined): { day: string; dayStart: string; monthStart: string } {
  const day = localDate(now, tz);
  return { day, dayStart: dayStartUtc(day, tz).toISOString(), monthStart: dayStartUtc(`${day.slice(0, 7)}-01`, tz).toISOString() };
}

export interface SpentNow {
  day: number;
  month: number;
  toolDay: number;
  toolMonth: number;
  /** Tokens today (all model calls): Token Saver's auto line. */
  dayTokens: number;
}

/** What was spent today and this month, overall and for one tool (the usage ledger). */
export function spentNow(usage: UsageStore | undefined, now: Date, tz: string | undefined, tool?: string): SpentNow {
  if (!usage) return { day: 0, month: 0, toolDay: 0, toolMonth: 0, dayTokens: 0 };
  const p = periodStarts(now, tz);
  const d = usage.spentSince(p.dayStart, tool);
  const m = usage.spentSince(p.monthStart, tool);
  return { day: d.usd, month: m.usd, toolDay: d.toolUsd, toolMonth: m.toolUsd, dayTokens: d.tokens };
}

/**
 * V4a (docs/ops/V4_DESIGN.md): today's spend as a line for the at-a-glance card. One point per hour
 * since the day started (in the owner's time zone), each the total spent by then; the last point is
 * now. Empty when nothing is metered here.
 */
export function spendHours(usage: UsageStore | undefined, now: Date, tz: string | undefined): number[] {
  if (!usage) return [];
  const start = Date.parse(periodStarts(now, tz).dayStart);
  const day = usage.spentSince(new Date(start).toISOString()).usd;
  const out: number[] = [];
  for (let at = start + 3600_000; at < now.getTime(); at += 3600_000) out.push(Math.round((day - usage.spentSince(new Date(at).toISOString()).usd) * 10000) / 10000);
  return [0, ...out, Math.round(day * 10000) / 10000];
}

export interface SpendStop {
  /** An English template (translated with trOwner and `params` where shown). */
  message: string;
  params: Record<string, string>;
  /** The policy pin's hard cap: no override. */
  hard: boolean;
  limit: 'day' | 'month' | 'tool-day' | 'tool-month' | 'cap';
  usd: number;
}

/**
 * Whether a paid call may run now. A limit is reached when what was spent plus this call's price
 * (when known) would pass it. The pin `spendCap` (dollars a day) is checked first and is hard.
 */
export function spendCheck(sp: SpendSettings, spent: SpentNow, tag: PriceTag, tool: string, cap?: number): SpendStop | undefined {
  const add = tag.usd ?? 0;
  const over = (used: number, limit: number) => limit > 0 && (used >= limit || used + add > limit);
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const stop = (limit: SpendStop['limit'], usd: number, message: string, hard = false): SpendStop => ({ hard, limit, usd, message, params: { usd: fmt(usd), tool } });
  if (cap && over(spent.day, cap)) return stop('cap', cap, en("Your admin's daily spending cap ({usd}) is reached, so paid tools are stopped until tomorrow."), true);
  const t = sp.perTool[tool];
  if (t?.dayUsd && over(spent.toolDay, t.dayUsd)) return stop('tool-day', t.dayUsd, en('The daily limit for {tool} ({usd}) is reached.'));
  if (t?.monthUsd && over(spent.toolMonth, t.monthUsd)) return stop('tool-month', t.monthUsd, en('The monthly limit for {tool} ({usd}) is reached.'));
  if (over(spent.day, sp.dayUsd)) return stop('day', sp.dayUsd, en("Today's spending limit ({usd}) is reached."));
  if (over(spent.month, sp.monthUsd)) return stop('month', sp.monthUsd, en("This month's spending limit ({usd}) is reached."));
  return undefined;
}

/** The tool result when a paid call was stopped (what she reads; she tells the owner plainly). */
export function stoppedOutput(stop: SpendStop, settings: Settings): string {
  return `${trOwner(stop.message, settings, stop.params)} ${stop.hard ? trOwner('Nothing was spent.', settings) : trOwner('Nothing was spent. The owner can allow one call on its card, or raise the limit in Settings → Usage and costs.', settings)}`;
}

// ------------------------------------------------------------------------------------------------
// Token Saver
// ------------------------------------------------------------------------------------------------

export type SaverMode = 'off' | 'on' | 'auto';
export const SAVER_MODES: readonly SaverMode[] = ['off', 'on', 'auto'];
export interface SaverSettings {
  mode: SaverMode;
  /** Auto: tokens a day it watches (0 = only the daily $ limit). */
  dailyTokens: number;
  /** Auto: on at this share of the daily line, off again below `offAt`. */
  onAt: number;
  offAt: number;
}
export const DEFAULT_SAVER: SaverSettings = { mode: 'off', dailyTokens: 0, onAt: 0.8, offAt: 0.6 };
/** What "on" changes. */
export const SAVER = {
  /** Most tokens one reply may write. */
  replyTokens: 700,
  /** Share of the history window kept. */
  historyShare: 0.5,
  /** Most model steps in a turn. */
  steps: 8,
  note: 'Token Saver is on: keep this reply short and plain (a few sentences), use as few tool steps as you can, and skip extras the owner did not ask for.',
} as const;
export const SAVER_TOKEN_CHOICES = [0, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000] as const;

export function saverSettings(s: { tokenSaver?: unknown } | undefined): SaverSettings {
  const v = (s?.tokenSaver ?? {}) as Record<string, unknown>;
  const mode = SAVER_MODES.includes(v.mode as SaverMode) ? (v.mode as SaverMode) : 'off';
  const n = Number(v.dailyTokens);
  const dailyTokens = Number.isFinite(n) && n > 0 ? Math.min(100_000_000, Math.round(n)) : 0;
  const onAt = Math.min(1, Math.max(0.3, Number(v.onAt) || DEFAULT_SAVER.onAt));
  const offAt = Math.min(onAt - 0.05, Math.max(0.1, Number(v.offAt) || DEFAULT_SAVER.offAt));
  return { mode, dailyTokens, onAt, offAt: Math.round(offAt * 100) / 100 };
}

/** The share of today's line used: tokens against `dailyTokens`, dollars against the daily limit (the larger). */
export function saverFraction(sv: SaverSettings, sp: SpendSettings, spent: SpentNow): number | undefined {
  const parts: number[] = [];
  if (sv.dailyTokens > 0) parts.push(spent.dayTokens / sv.dailyTokens);
  if (sp.dayUsd > 0) parts.push(spent.day / sp.dayUsd);
  return parts.length ? Math.max(...parts) : undefined;
}

/** Auto's memory: on or off, and for which day (a new day starts off). */
export interface SaverAuto {
  day: string;
  on: boolean;
}

/** Decides whether Token Saver is on now. Auto has hysteresis: on at `onAt`, off only below `offAt`. */
export function saverDecide(sv: SaverSettings, frac: number | undefined, prev: SaverAuto | undefined, today: string): { on: boolean; why: 'off' | 'on' | 'auto'; auto?: SaverAuto } {
  if (sv.mode === 'off') return { on: false, why: 'off' };
  if (sv.mode === 'on') return { on: true, why: 'on' };
  const was = prev && prev.day === today ? prev.on : false;
  const on = frac !== undefined && (frac >= sv.onAt || (was && frac > sv.offAt));
  return { on, why: on ? 'auto' : 'off', auto: { day: today, on } };
}

/** Per-app memory of auto mode (it is worked out again from the ledger after a restart). */
const autoMemory = new WeakMap<object, SaverAuto>();

export interface SaverNow {
  on: boolean;
  why: 'off' | 'on' | 'auto';
  mode: SaverMode;
  frac?: number;
}

/** Token Saver's state for this app now. With the mode off nothing is read or remembered. */
export function saverNow(app: { settings: { get(): Settings }; usage?: UsageStore; now?: () => Date }): SaverNow {
  const s = app.settings.get();
  const sv = saverSettings(s);
  if (sv.mode === 'off') return { on: false, why: 'off', mode: 'off' };
  if (sv.mode === 'on') return { on: true, why: 'on', mode: 'on' };
  const now = app.now?.() ?? new Date();
  const spent = spentNow(app.usage, now, s.timeZone);
  const frac = saverFraction(sv, spendSettings(s), spent);
  const d = saverDecide(sv, frac, autoMemory.get(app), localDate(now, s.timeZone));
  if (d.auto) autoMemory.set(app, d.auto);
  return { on: d.on, why: d.why, mode: 'auto', ...(frac !== undefined ? { frac: Math.round(frac * 1000) / 1000 } : {}) };
}

/** Merges a settings change for spend and Token Saver (the route's PUT). */
export function mergeSpend(s: Settings, body: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (body.spend !== undefined) out.spend = spendSettings({ spend: { ...spendSettings(s), ...((body.spend ?? {}) as object) } });
  if (body.tokenSaver !== undefined) out.tokenSaver = saverSettings({ tokenSaver: { ...saverSettings(s), ...((body.tokenSaver ?? {}) as object) } });
  return out;
}

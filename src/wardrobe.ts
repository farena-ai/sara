// Phase 36: her closet. Saved looks are tagged with scenarios (work hours, at home, going out, date
// night, sleep, workout, weather, holidays, the owner's own). With "Dress automatically" on, she
// changes into the look for the scenario that applies right now (time, day, weather), or the one
// you or she picked ("we're going to the beach"). She knows what she's wearing.
// Adults-only looks are worn and listed only while Adult mode is on.
import { netFetch } from './net-guard.ts';
import type { AppContext } from './chat.ts';
import { PLACES, type LookMeta, type SavedLook } from './look.ts';
import { adultModeOn } from './settings.ts';
import { everyJob, type EveryJob } from './tick-jobs.ts';
import type { Tool } from './tools/types.ts';
import { str, ToolError } from './tools/types.ts';

export interface CustomScenario {
  id: string;
  label: string;
  /** Optional yearly dates it applies on its own, "MM-DD". */
  from?: string;
  to?: string;
}

export interface WardrobeSettings {
  /** Dress automatically for the scenario that applies now. */
  auto: boolean;
  workStart: string;
  workEnd: string;
  /** 0 = Sunday. */
  workDays: number[];
  custom: CustomScenario[];
  /** Picked by you or her: until when. */
  manual?: { scenario: string; until: string };
}

export const DEFAULT_WARDROBE: WardrobeSettings = { auto: false, workStart: '09:00', workEnd: '17:00', workDays: [1, 2, 3, 4, 5], custom: [] };

export interface Scenario {
  id: string;
  label: string;
  emoji: string;
  /** When it applies on its own (plain words), or that it's picked by hand. */
  when: string;
  /** Picked by hand only (no automatic rule). */
  manual?: boolean;
}

/** Built-in scenarios, most specific first: the first that applies wins. */
export const SCENARIOS: Scenario[] = [
  { id: 'sleep', label: 'Sleep', emoji: '🌙', when: 'Late at night (11 pm to 6 am)' },
  { id: 'date', label: 'Date night', emoji: '🌹', when: 'When you or she picks it', manual: true },
  { id: 'workout', label: 'Workout', emoji: '🏃', when: 'When you or she picks it', manual: true },
  { id: 'halloween', label: 'Halloween', emoji: '🎃', when: 'October 24 to 31' },
  { id: 'winter-holidays', label: 'Winter holidays', emoji: '🎄', when: 'December 15 to January 1' },
  { id: 'rain', label: 'Rainy day', emoji: '☔', when: 'When it rains where you are (needs your town in Morning briefing)' },
  { id: 'cold', label: 'Cold day', emoji: '🧣', when: 'Below 8 °C / 46 °F where you are' },
  { id: 'hot', label: 'Hot day', emoji: '☀️', when: 'Above 26 °C / 79 °F where you are' },
  { id: 'work', label: 'Work hours', emoji: '💼', when: 'Your work hours (set below)' },
  { id: 'out', label: 'Going out', emoji: '✨', when: 'Friday and Saturday evenings (6 pm to 11 pm)' },
  { id: 'home', label: 'At home', emoji: '🏠', when: 'Any other time' },
];

export interface Weather {
  tempC: number;
  code: number;
}

export function wardrobeSettings(app: Pick<AppContext, 'settings'>): WardrobeSettings {
  return { ...DEFAULT_WARDROBE, ...app.settings.get().wardrobe };
}

/** All scenarios: built-in and the owner's own (own ones after the hand-picked built-ins). */
export function allScenarios(w: WardrobeSettings): Scenario[] {
  const own = w.custom.map((c) => ({ id: c.id, label: c.label, emoji: '⭐', when: c.from && c.to ? `${c.from} to ${c.to} each year, or when picked` : 'When you or she picks it', manual: !(c.from && c.to) }));
  const i = SCENARIOS.findIndex((s) => s.id === 'halloween');
  return [...SCENARIOS.slice(0, i), ...own, ...SCENARIOS.slice(i)];
}

function zoned(now: Date, tz?: string): { md: string; minutes: number; dow: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { md: `${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};
const inRange = (md: string, from: string, to: string) => (from <= to ? md >= from && md <= to : md >= from || md <= to);
const RAIN = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);

/** The scenarios that apply right now, most specific first ('home' always last). */
export function activeScenarios(now: Date, tz: string | undefined, w: WardrobeSettings, weather?: Weather): string[] {
  const { md, minutes, dow } = zoned(now, tz);
  const out: string[] = [];
  if (w.manual && Date.parse(w.manual.until) > now.getTime()) out.push(w.manual.scenario);
  if (minutes >= 23 * 60 || minutes < 6 * 60) out.push('sleep');
  for (const c of w.custom) if (c.from && c.to && inRange(md, c.from, c.to)) out.push(c.id);
  if (inRange(md, '10-24', '10-31')) out.push('halloween');
  if (inRange(md, '12-15', '01-01')) out.push('winter-holidays');
  if (weather) {
    if (RAIN.has(weather.code)) out.push('rain');
    if (weather.tempC < 8 || SNOW.has(weather.code)) out.push('cold');
    if (weather.tempC > 26) out.push('hot');
  }
  if (w.workDays.includes(dow) && minutes >= mins(w.workStart) && minutes < mins(w.workEnd)) out.push('work');
  if ((dow === 5 || dow === 6) && minutes >= 18 * 60 && minutes < 23 * 60) out.push('out');
  out.push('home');
  return [...new Set(out)];
}

/** The look for the first scenario (in order) that has one. Adults-only looks only with Adult mode on. */
export function pickLook(saved: SavedLook[], active: string[], adultOn: boolean): { look: SavedLook; scenario: string } | undefined {
  const ok = saved.filter((s) => adultOn || !s.adult);
  for (const sc of active) {
    const look = ok.find((s) => s.scenarios?.includes(sc));
    if (look) return { look, scenario: sc };
  }
  return undefined;
}

/** "You're wearing …" for her instructions. */
export function wearingLine(meta: LookMeta, name?: string): string | undefined {
  const where = meta.place ? (PLACES[meta.place]?.label.toLowerCase() ?? meta.place) : '';
  if (!meta.wear && !where) return undefined;
  return `In your picture right now you're wearing ${meta.wear ?? 'your usual clothes'}${where ? `, and you're at ${where.replace(/^her /, 'your ')}` : ''}${name ? ` (your "${name}" look)` : ''}. You know this; mention it only if it fits (e.g. they ask what you're wearing or where you are).`;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Checks every 10 minutes and changes her into the right look. */
export class WardrobeWorker {
  readonly #app: AppContext;
  readonly #fetch: FetchLike;
  #timer: EveryJob | undefined;
  #weather: { at: number; w?: Weather } = { at: 0 };
  /** Last automatic change, for the Closet page. */
  last: { at: string; scenario: string; look: string } | undefined;

  constructor(app: AppContext, fetchImpl: FetchLike = netFetch) {
    this.#app = app;
    this.#fetch = fetchImpl;
  }

  start(intervalMs = 10 * 60_000): void {
    this.#timer = everyJob('wardrobe', intervalMs, () => this.tick());
    setTimeout(() => void this.tick().catch(() => {}), 45_000).unref();
  }
  stop(): void {
    this.#timer?.stop();
  }

  async weather(): Promise<Weather | undefined> {
    const place = this.#app.settings.get().briefing?.place;
    if (!place) return undefined;
    const now = this.#app.now().getTime();
    if (Math.abs(now - this.#weather.at) < 3600_000) return this.#weather.w;
    this.#weather = { at: now, w: this.#weather.w };
    try {
      const r = await this.#fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code`, { signal: AbortSignal.timeout(15_000) });
      const d = (await r.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
      if (typeof d.current?.temperature_2m === 'number') this.#weather.w = { tempC: d.current.temperature_2m, code: d.current.weather_code ?? -1 };
    } catch {
      /* keep the last reading */
    }
    return this.#weather.w;
  }

  /** What applies now and which look that means. */
  async plan(): Promise<{ active: string[]; pick?: { look: SavedLook; scenario: string } }> {
    const app = this.#app;
    const w = wardrobeSettings(app);
    const active = activeScenarios(app.now(), app.settings.get().timeZone, w, await this.weather());
    return { active, pick: app.look ? pickLook(app.look.saved(), active, adultModeOn(app.settings.get())) : undefined };
  }

  /** Changes her look if needed. Returns the look's name when she changed. */
  async tick(): Promise<string | undefined> {
    const app = this.#app;
    const look = app.look;
    if (!look || look.status.state === 'drafting' || look.status.state === 'building') return undefined;
    const w = wardrobeSettings(app);
    const adultOn = adultModeOn(app.settings.get());
    const manualOn = Boolean(w.manual && Date.parse(w.manual.until) > app.now().getTime());
    if (w.manual && !manualOn) app.settings.update({ wardrobe: { ...w, manual: undefined } });
    const current = look.currentSavedId();
    const wearingAdult = look.custom && look.currentMeta().adult === true;
    if (!w.auto && !manualOn && !(wearingAdult && !adultOn)) return undefined;
    const { pick } = await this.plan();
    let to = pick?.look;
    // Adult mode went off while wearing an adults-only look: change into something else.
    if (!to && wearingAdult && !adultOn) to = look.saved().find((s) => !s.adult);
    if (wearingAdult && !adultOn && !to) {
      look.reset();
      this.#changed('home', 'the default look');
      return 'the default look';
    }
    if (!to || to.id === current) return undefined;
    look.use(to.id, app.now());
    this.#changed(pick?.scenario ?? 'home', to.name);
    return to.name;
  }

  #changed(scenario: string, name: string): void {
    this.last = { at: this.#app.now().toISOString(), scenario, look: name };
    this.#app.events?.publish({ type: 'look' });
    // A look saved before newer frames existed gets them in the background (if pictures can be made).
    if (this.#app.look?.missingFrames().length) void this.#app.look.complete().catch(() => {});
  }
}

/** Her tool: change outfit (by scenario or look name). Cheap: no new pictures are made. */
export function createWardrobeTool(getApp: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    source: 'built-in',
    isAvailable: () => Boolean(getApp().look?.saved().length),
    spec: {
      name: 'change_outfit',
      description:
        "Change into another of your saved looks (your closet), e.g. when you two are going out, it's date night, you're working out, going to bed, or they ask you to. Pick a scenario (you change into the look saved for it) or a look by name. Hours = how long before you go back to dressing for the time of day (default 4).",
      parameters: {
        type: 'object',
        properties: {
          scenario: { type: 'string', description: `One of: ${SCENARIOS.map((s) => s.id).join(', ')} (or one of the owner's own)` },
          look: { type: 'string', description: 'A saved look by name, instead of a scenario' },
          hours: { type: 'number', description: 'How long (1 to 24)' },
        },
        additionalProperties: false,
      },
    },
    summarize: (a) => `Change outfit: ${String(a.look ?? a.scenario ?? '')}`,
    async run(args) {
      const app = getApp();
      const look = app.look;
      if (!look) throw new ToolError('No closet here.');
      const adultOn = adultModeOn(app.settings.get());
      const saved = look.saved().filter((s) => adultOn || !s.adult);
      const w = wardrobeSettings(app);
      const hours = Math.min(24, Math.max(1, Number(args.hours) || 4));
      let to: SavedLook | undefined;
      let scenario: string | undefined;
      if (typeof args.look === 'string' && args.look.trim()) {
        const want = args.look.trim().toLowerCase();
        to = saved.find((s) => s.name.toLowerCase() === want) ?? saved.find((s) => s.name.toLowerCase().includes(want));
        if (!to) throw new ToolError(`No saved look called "${args.look}". Your looks: ${saved.map((s) => s.name).join(', ') || 'none'}.`);
        scenario = to.scenarios?.[0] ?? 'home';
      } else {
        scenario = str(args, 'scenario');
        if (!allScenarios(w).some((s) => s.id === scenario)) throw new ToolError(`Unknown scenario. Use one of: ${allScenarios(w).map((s) => s.id).join(', ')}.`);
        to = pickLook(saved, [scenario], adultOn)?.look;
        if (!to) throw new ToolError(`You have no look saved for "${scenario}" yet (the owner tags looks in Settings → Look → Closet). Your looks: ${saved.map((s) => `${s.name} (${(s.scenarios ?? []).join(', ') || 'untagged'})`).join('; ') || 'none'}.`);
      }
      app.settings.update({ wardrobe: { ...w, manual: { scenario, until: new Date(app.now().getTime() + hours * 3600_000).toISOString() } } });
      if (look.currentSavedId() !== to.id) {
        if (look.status.state === 'drafting' || look.status.state === 'building') throw new ToolError('A new look is being made right now; try again in a minute.');
        look.use(to.id, app.now());
        app.events?.publish({ type: 'look' });
      }
      return `You're now wearing your "${to.name}" look${to.wear ? ` (${to.wear})` : ''} for the next ${hours} hours. Your picture has changed.`;
    },
  };
}

const ID = /^[a-z0-9-]{1,40}$/;
const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Validates the Closet settings from the web page. */
export function cleanWardrobe(raw: Partial<WardrobeSettings>, prev: WardrobeSettings): WardrobeSettings {
  const out: WardrobeSettings = { ...prev };
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (raw.workStart !== undefined) {
    if (!hm.test(String(raw.workStart))) throw new Error('Work hours: use a time like 09:00.');
    out.workStart = String(raw.workStart);
  }
  if (raw.workEnd !== undefined) {
    if (!hm.test(String(raw.workEnd))) throw new Error('Work hours: use a time like 17:00.');
    out.workEnd = String(raw.workEnd);
  }
  if (Array.isArray(raw.workDays)) out.workDays = [...new Set(raw.workDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (Array.isArray(raw.custom)) {
    if (raw.custom.length > 20) throw new Error('Up to 20 scenarios of your own.');
    out.custom = raw.custom.map((c) => {
      const label = String(c.label ?? '').trim().slice(0, 40);
      if (!label) throw new Error('Give your scenario a name.');
      const id = ID.test(String(c.id ?? '')) && !SCENARIOS.some((s) => s.id === c.id) ? String(c.id) : `own-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'scenario'}`;
      const sc: CustomScenario = { id, label };
      if (c.from || c.to) {
        if (!MD.test(String(c.from)) || !MD.test(String(c.to))) throw new Error(`"${label}": dates look like 07-01 (month-day).`);
        sc.from = String(c.from);
        sc.to = String(c.to);
      }
      return sc;
    });
  }
  return out;
}

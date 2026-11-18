// U4.21 (docs/FAMILY.md "Home and family planner"): the planner half of Family, in the same household
// store (`<data>/shared/family.db`, R8). A meal plan (one dinner a day on a week grid; recipes pasted
// as text, read from a page's schema.org Recipe or a Library document, with allergy warnings per
// person), one tap from the week's dinners to a grocery list (R8 aisles, quantities merged), a weekly
// chores rota over R8 chores with a reminder per person outside their quiet hours, and a family
// calendar: events typed in, or read from a school letter / PDF text / an iCal file, that wait for a
// parent's OK before everyone sees them. A person's private events stay theirs (even the owner never
// sees them). Parents change the plan; everyone else reads it. Nothing here calls a model or the
// network (the routes fetch pages and iCal links through netFetch, never in private local mode).
import { findDate } from './inbox/classify.ts';
import { linkEvents } from './calendar-links.ts';
import { aisleOf, FamilyError, type FamilyAccess, type FamilyPerson, type FamilyStore } from './family.ts';
import { en } from './i18n.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import type { SharedBoardStore } from './shared-boards.ts';

type Row = Record<string, string | number | null>;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const pad = (n: number) => String(n).padStart(2, '0');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const START_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

// ------------------------------------------------------------------------------------------------
// Ingredients and recipes
// ------------------------------------------------------------------------------------------------

export interface Ingredient {
  qty: number | null;
  unit: string;
  name: string;
  text: string;
}
const UNITS: [RegExp, string][] = [
  [/^(cups?|c)$/i, 'cup'],
  [/^(tablespoons?|tbsps?|tbs|tb|T)$/, 'tbsp'],
  [/^(teaspoons?|tsps?|t)$/, 'tsp'],
  [/^(pounds?|lbs?)$/i, 'lb'],
  [/^(ounces?|oz)$/i, 'oz'],
  [/^(grams?|g)$/i, 'g'],
  [/^(kilograms?|kgs?)$/i, 'kg'],
  [/^(milliliters?|ml)$/i, 'ml'],
  [/^(liters?|l)$/i, 'l'],
  [/^(cloves?)$/i, 'clove'],
  [/^(cans?)$/i, 'can'],
  [/^(packages?|pkgs?|packs?)$/i, 'pack'],
  [/^(bunch(es)?)$/i, 'bunch'],
  [/^(pinch(es)?)$/i, 'pinch'],
  [/^(slices?)$/i, 'slice'],
];
const FRAC: Record<string, number> = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅛': 0.125 };
function numberOf(tok: string): number | null {
  if (FRAC[tok] !== undefined) return FRAC[tok]!;
  const mixed = /^(\d+)([½⅓⅔¼¾⅛])$/.exec(tok);
  if (mixed) return Number(mixed[1]) + FRAC[mixed[2]!]!;
  const fr = /^(\d+)\/(\d+)$/.exec(tok);
  if (fr) return Number(fr[2]) ? Number(fr[1]) / Number(fr[2]) : null;
  return /^\d+(\.\d+)?$/.test(tok) ? Number(tok) : null;
}
/** One ingredient line: "1 1/2 lb chicken breast, diced" → 1.5 lb "chicken breast". */
export function parseIngredient(line: string): Ingredient {
  const text = clip(line.replace(/^[\s*•\-–]+/, ''), 160);
  const toks = text.split(' ');
  let qty: number | null = null;
  let i = 0;
  while (i < toks.length) {
    const n = numberOf(toks[i]!);
    if (n === null) break;
    qty = (qty ?? 0) + n;
    i++;
  }
  let unit = '';
  if (qty !== null && toks[i]) {
    const u = UNITS.find(([re]) => re.test(toks[i]!.replace(/\.$/, '')));
    if (u) {
      unit = u[1];
      i++;
      if (toks[i] === 'of') i++;
    }
  }
  const name = toks.slice(i).join(' ').split(/,|\(| - /)[0]!.replace(/\b(to taste|optional|as needed)\b/gi, '').trim().replace(/\s+/g, ' ').toLowerCase();
  return { qty: qty === null ? null : Math.round(qty * 1000) / 1000, unit, name: name || text.toLowerCase(), text };
}
export interface ParsedRecipe {
  title: string;
  ingredients: Ingredient[];
  steps: string[];
}
const QTY_START = /^[\s*•\-–]*(\d|[½⅓⅔¼¾⅛])/;
/** Pasted recipe text (a page copied, a note): the title, the ingredient lines and the steps. */
export function parseRecipeText(text: string): ParsedRecipe {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines.findIndex((l) => /^ingredients:?$/i.test(l));
  const stepHead = lines.findIndex((l) => /^(method|directions|instructions|steps|preparation):?$/i.test(l));
  let ingLines: string[];
  let stepLines: string[];
  if (head >= 0) {
    const end = stepHead > head ? stepHead : lines.length;
    ingLines = lines.slice(head + 1, end).filter((l) => !/^(serves|makes|yield)\b/i.test(l));
    stepLines = stepHead > head ? lines.slice(stepHead + 1) : [];
  } else {
    ingLines = lines.slice(1).filter((l) => QTY_START.test(l) && !/^\d+[.)]\s/.test(l));
    stepLines = lines.slice(1).filter((l) => /^\d+[.)]\s/.test(l));
  }
  const title = clip(lines[0] && lines[0] !== lines[head] ? lines[0] : '', 100);
  return { title, ingredients: ingLines.slice(0, 60).map(parseIngredient), steps: stepLines.slice(0, 40).map((s) => clip(s.replace(/^\d+[.)]\s*/, ''), 400)) };
}
/** A recipe page: its schema.org Recipe (JSON-LD), as most recipe sites publish; else undefined. */
export function recipeFromHtml(html: string): ParsedRecipe | undefined {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const all: unknown[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        all.push(v);
        const g = (v as Record<string, unknown>)['@graph'];
        if (g) walk(g);
      }
    };
    walk(data);
    const r = all.find((x) => {
      const t = (x as Record<string, unknown>)['@type'];
      return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
    }) as Record<string, unknown> | undefined;
    if (!r || !Array.isArray(r.recipeIngredient)) continue;
    const steps: string[] = [];
    const walkSteps = (v: unknown) => {
      if (typeof v === 'string') steps.push(...v.split(/\n+/));
      else if (Array.isArray(v)) v.forEach(walkSteps);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.text === 'string') steps.push(o.text);
        else if (o.itemListElement) walkSteps(o.itemListElement);
      }
    };
    walkSteps(r.recipeInstructions);
    return { title: clip(r.name, 100), ingredients: (r.recipeIngredient as unknown[]).slice(0, 60).map((x) => parseIngredient(String(x))), steps: steps.map((s) => clip(s, 400)).filter(Boolean).slice(0, 40) };
  }
  return undefined;
}
export interface ShoppingLine {
  name: string;
  qty: number | null;
  unit: string;
  aisle: string;
  title: string;
}
const singular = (n: string) => (/(ch|sh|x|o)es$/.test(n) ? n.slice(0, -2) : /ies$/.test(n) ? `${n.slice(0, -3)}y` : /[^s]s$/.test(n) ? n.slice(0, -1) : n);
const FRACS: [number, string][] = [[0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2'], [2 / 3, '2/3'], [0.75, '3/4']];
/** 0.25 → "1/4", 1.5 → "1 1/2", 2 → "2". */
const fmt = (n: number) => {
  const whole = Math.floor(n + 1e-9);
  const rest = n - whole;
  if (rest < 0.02) return String(whole);
  const f = FRACS.find(([v]) => Math.abs(v - rest) < 0.02);
  return f ? (whole ? `${whole} ${f[1]}` : f[1]) : String(Math.round(n * 100) / 100);
};
const PLURAL_UNIT: Record<string, string> = { cup: 'cups', can: 'cans', clove: 'cloves', pack: 'packs', bunch: 'bunches', pinch: 'pinches', slice: 'slices' };
const unitFor = (unit: string, qty: number) => (qty > 1 && PLURAL_UNIT[unit] ? PLURAL_UNIT[unit]! : unit);
/** The aisle for an ingredient: canned and dry pantry things first (R8 aisleOf reads "tomato sauce" as produce). */
export function foodAisle(name: string, unit = ''): string {
  if (unit === 'can' || /\b(sauce|paste|broth|stock|spaghetti|penne|macaroni|lasagna|linguine|fettuccine|noodles?|tortellini|ramen|quinoa|lentils?|chickpeas|breadcrumbs|cornstarch|baking (soda|powder)|yeast|vanilla|cumin|paprika|oregano|cinnamon)\b/i.test(name)) return 'pantry';
  if (/\bdough\b/i.test(name)) return 'bakery';
  return aisleOf(name);
}
/** Ingredients from several recipes as one shopping list: same thing + same unit summed, by aisle. */
export function mergeIngredients(list: Ingredient[]): ShoppingLine[] {
  const by = new Map<string, ShoppingLine & { forms: Set<string> }>();
  for (const i of list) {
    if (!i.name) continue;
    const key = `${singular(i.name)}|${i.qty === null ? '-' : i.unit}`;
    const loose = `${singular(i.name)}|-`;
    const cur = by.get(key);
    if (cur) {
      cur.qty = (cur.qty ?? 0) + (i.qty ?? 0);
      cur.forms.add(i.name);
      continue;
    }
    // "salt to taste" next to "1 tbsp salt": once, with the amount.
    if (i.qty === null && [...by.keys()].some((k) => k.startsWith(`${singular(i.name)}|`))) continue;
    if (i.qty !== null && by.has(loose)) by.delete(loose);
    by.set(key, { name: i.name, qty: i.qty, unit: i.qty === null ? '' : i.unit, aisle: foodAisle(i.name, i.unit), title: '', forms: new Set([i.name]) });
  }
  return [...by.values()].map((l) => {
    const name = [...l.forms].sort((x, y) => y.length - x.length)[0]!;
    const shown = l.qty !== null && l.qty > 1 && !l.unit && !name.endsWith('s') ? `${name}s` : name;
    return { name, qty: l.qty, unit: l.unit, aisle: l.aisle, title: l.qty === null ? name : `${fmt(l.qty)}${l.unit ? ` ${unitFor(l.unit, l.qty)}` : ''} ${shown}` };
  }).sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------------------------------------
// Calendar text and iCal
// ------------------------------------------------------------------------------------------------

export interface FoundEvent {
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  uid?: string;
}
const DATE_TOKEN = /\b(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?\b\.?,?\s|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
function bareDate(line: string, now: Date): { day: string; time?: string } | undefined {
  const m = /\b(\d{1,2})\/(\d{1,2})\b(?!\/)/.exec(line);
  if (!m) return undefined;
  const mo = Number(m[1]);
  const day = Number(m[2]);
  if (!(mo >= 1 && mo <= 12 && day >= 1 && day <= 31)) return undefined;
  let y = now.getUTCFullYear();
  if (Date.UTC(y, mo - 1, day) < now.getTime() - 31 * 86_400_000) y++;
  const tm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(line.slice(m.index + m[0].length));
  let time: string | undefined;
  if (tm) {
    let h = Number(tm[1]) % 12;
    if (tm[3]!.toLowerCase() === 'pm') h += 12;
    time = `${pad(h)}:${tm[2] ?? '00'}`;
  }
  return { day: `${y}-${pad(mo)}-${pad(day)}`, ...(time ? { time } : {}) };
}
/** Dated lines in a school letter, newsletter or PDF's text: one event per line with a date (at most 60). */
export function eventsFromText(text: string, now: Date): FoundEvent[] {
  const out: FoundEvent[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\n|(?<=[.!?])\s+(?=[A-Z*•-])/).map((l) => l.replace(/^[\s*•\-–]+/, '').trim()).filter((l) => l.length > 3).slice(0, 600);
  for (const line of lines) {
    const when = findDate(line, now) ?? bareDate(line, now);
    if (!when) continue;
    const at = DATE_TOKEN.exec(line)?.index ?? -1;
    let title = (at > 0 ? line.slice(0, at) : line).replace(/\s*\b(on|at|from|this|next|by)\s*$/i, '').replace(/[\s,:;—–-]+$/, '').trim();
    if (!title) {
      title = line.replace(/^[^A-Za-z]*(?:\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*)?(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?)?[\s,:;—–-]*/i, '');
      title = title.replace(/\s*\(.*$/, '').replace(/[.!]+$/, '');
    }
    title = clip(title.replace(/\s*\(.*$/, ''), 80);
    if (!title || /^[^A-Za-z]*$/.test(title)) continue;
    const start = when.time ? `${when.day}T${when.time}` : when.day;
    const key = `${title.toLowerCase()}|${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, start, allDay: !when.time });
    if (out.length >= 60) break;
  }
  return out;
}
const localStart = (iso: string, allDay: boolean, tz?: string) => {
  if (allDay || DAY_RE.test(iso)) return iso.slice(0, 10);
  const z = zonedParts(new Date(iso), tz);
  return `${z.y}-${pad(z.mo)}-${pad(z.d)}T${pad(z.h)}:${pad(z.mi)}`;
};
/** An iCal file's events for the next year (repeats expanded), in the household's local time. */
export function eventsFromIcs(ics: string, now: Date, tz?: string): FoundEvent[] {
  const evs = linkEvents(ics, 'import', new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 366 * 86_400_000), 300);
  return evs.map((e) => ({ title: clip(e.title, 80) || 'Event', start: localStart(e.start, e.allDay, tz), ...(e.end ? { end: localStart(e.end, e.allDay, tz) } : {}), allDay: e.allDay, uid: e.id }));
}

// ------------------------------------------------------------------------------------------------
// The planner store (tables in family.db)
// ------------------------------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS family_recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', ingredients TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]', by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_meals (day TEXT PRIMARY KEY, title TEXT NOT NULL, recipe_id INTEGER, ingredients TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_prefs (person TEXT PRIMARY KEY, likes TEXT NOT NULL DEFAULT '', dislikes TEXT NOT NULL DEFAULT '', allergies TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chore_rota (chore_id INTEGER PRIMARY KEY, people TEXT NOT NULL, last_week TEXT);
CREATE TABLE IF NOT EXISTS family_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT, all_day INTEGER NOT NULL DEFAULT 1, who TEXT NOT NULL DEFAULT 'family', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS family_reminded (person TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (person, day));
`;

export interface PlanSettings {
  dinnerTime: string;
  reminders: boolean;
  remindAt: string;
  /** 0 = Sunday … 6 = Saturday. */
  rotaDay: number;
}
const DEFAULTS: PlanSettings = { dinnerTime: '18:00', reminders: true, remindAt: '16:00', rotaDay: 1 };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export interface Prefs {
  person: string;
  likes: string;
  dislikes: string;
  allergies: string;
}
export interface FamilyRecipe extends ParsedRecipe {
  id: number;
  source: string;
}
export interface Meal {
  day: string;
  title: string;
  recipeId: number | null;
  ingredients: Ingredient[];
  note: string;
  warnings: string[];
}
export interface FamilyEvent {
  id: number;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  who: string;
  source: string;
  status: 'pending' | 'ok' | 'declined';
  by: string;
}

/** Allergy words that stand for a group of foods ("shellfish" covers shrimp). */
const ALLERGENS: [RegExp, string[]][] = [
  [/shellfish|seafood/, ['shrimp', 'prawn', 'crab', 'lobster', 'scallop', 'clam', 'mussel', 'oyster']],
  [/tree nut|^nuts?$/, ['almond', 'walnut', 'cashew', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'nut']],
  [/dairy|lactose|milk/, ['milk', 'cheese', 'cream', 'yogurt', 'parmesan', 'mozzarella', 'cheddar']],
  [/gluten|wheat/, ['flour', 'bread', 'pasta', 'spaghetti', 'noodle', 'tortilla', 'bun', 'cracker', 'couscous']],
  [/^fish$/, ['fish', 'salmon', 'tuna', 'cod', 'tilapia', 'anchov']],
  [/^eggs?$/, ['egg']],
  [/soy/, ['soy', 'tofu', 'edamame']],
];
/** True when hour `h` falls in quiet hours from `start` to `end` (they may cross midnight). */
export const inQuiet = (h: number, start: number, end: number): boolean => (start > end ? h >= start || h < end : h >= start && h < end);
/** The Monday that starts the week holding `at` (the household's time), as YYYY-MM-DD. */
export function weekStartOf(at: Date, tz?: string): string {
  const z = zonedParts(at, tz);
  const back = (z.wd + 6) % 7;
  const d = new Date(Date.UTC(z.y, z.mo - 1, z.d - back));
  return d.toISOString().slice(0, 10);
}
const addDays = (day: string, n: number) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n)).toISOString().slice(0, 10);

const plans = new WeakMap<FamilyStore, FamilyPlan>();
/** The planner over a household store (one per store). */
export function planOf(store: FamilyStore, now: () => Date = () => new Date()): FamilyPlan {
  let p = plans.get(store);
  if (!p) plans.set(store, (p = new FamilyPlan(store, now)));
  return p;
}

export class FamilyPlan {
  readonly #s: FamilyStore;
  readonly #now: () => Date;
  constructor(store: FamilyStore, now: () => Date) {
    this.#s = store;
    this.#now = now;
    store.db.exec(SCHEMA);
  }
  get #db() {
    return this.#s.db;
  }
  #iso() {
    return this.#now().toISOString();
  }
  #mustParent(person: string) {
    if (!this.#s.isParent(person)) throw new FamilyError(403, en('Only a parent can do that.'));
  }
  #meta(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM family_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  #setMeta(key: string, value: string) {
    this.#db.prepare('INSERT INTO family_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  #changed(what: string) {
    // The R8 listeners refresh everyone's Today and Family page.
    for (const fn of this.#s.listeners) {
      try {
        fn({ people: ['owner', ...this.#s.parents()], what });
      } catch {
        /* never breaks a change */
      }
    }
  }

  // ------------------------------------------------------------ settings
  settings(): PlanSettings {
    try {
      return { ...DEFAULTS, ...(JSON.parse(this.#meta('plan.settings') ?? '{}') as Partial<PlanSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }
  setSettings(by: string, patch: Partial<Record<keyof PlanSettings, unknown>>): PlanSettings {
    this.#mustParent(by);
    const cur = this.settings();
    const next: PlanSettings = {
      dinnerTime: typeof patch.dinnerTime === 'string' && TIME_RE.test(patch.dinnerTime) ? patch.dinnerTime : cur.dinnerTime,
      remindAt: typeof patch.remindAt === 'string' && TIME_RE.test(patch.remindAt) ? patch.remindAt : cur.remindAt,
      reminders: typeof patch.reminders === 'boolean' ? patch.reminders : cur.reminders,
      rotaDay: Number.isInteger(Number(patch.rotaDay)) && Number(patch.rotaDay) >= 0 && Number(patch.rotaDay) <= 6 && patch.rotaDay !== null && patch.rotaDay !== '' ? Number(patch.rotaDay) : cur.rotaDay,
    };
    this.#setMeta('plan.settings', JSON.stringify(next));
    return next;
  }

  // ------------------------------------------------------------ likes and allergies
  prefs(person: string): Prefs[] {
    const rows = (this.#s.isParent(person) ? this.#db.prepare('SELECT * FROM family_prefs ORDER BY person').all() : this.#db.prepare('SELECT * FROM family_prefs WHERE person = ?').all(person)) as Row[];
    return rows.map((r) => ({ person: String(r.person), likes: String(r.likes), dislikes: String(r.dislikes), allergies: String(r.allergies) }));
  }
  setPrefs(by: string, person: string, p: { likes?: unknown; dislikes?: unknown; allergies?: unknown }, known: string[]): Prefs {
    if (by !== person) this.#mustParent(by);
    if (!known.includes(person)) throw new FamilyError(400, en('Pick who does it.'));
    const cur = this.prefs(by === person && !this.#s.isParent(by) ? by : 'owner').find((x) => x.person === person) ?? { person, likes: '', dislikes: '', allergies: '' };
    const next = { person, likes: p.likes !== undefined ? clip(p.likes, 200) : cur.likes, dislikes: p.dislikes !== undefined ? clip(p.dislikes, 200) : cur.dislikes, allergies: p.allergies !== undefined ? clip(p.allergies, 200) : cur.allergies };
    this.#db.prepare('INSERT INTO family_prefs (person, likes, dislikes, allergies, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(person) DO UPDATE SET likes = excluded.likes, dislikes = excluded.dislikes, allergies = excluded.allergies, at = excluded.at').run(person, next.likes, next.dislikes, next.allergies, this.#iso());
    this.#changed('prefs');
    return next;
  }
  /** "Mia: peanuts" for each person whose allergy shows up in a meal's title or ingredients. */
  warningsFor(title: string, ingredients: Ingredient[], people: FamilyPerson[]): string[] {
    const hay = ` ${[title, ...ingredients.map((i) => i.name)].join(' ').toLowerCase()} `;
    const out: string[] = [];
    for (const p of this.prefs('owner')) {
      const name = people.find((x) => x.id === p.person)?.name;
      if (!name) continue;
      for (const a of p.allergies.split(/[,;/]| and /).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 1)) {
        const words = [singular(a).replace(/s$/, ''), ...ALLERGENS.filter(([re]) => re.test(a)).flatMap(([, w]) => w)];
        if (words.some((w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(hay))) out.push(`${name}: ${a}`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ recipes
  #recipe(r: Row): FamilyRecipe {
    return { id: Number(r.id), title: String(r.title), source: String(r.source), ingredients: JSON.parse(String(r.ingredients)) as Ingredient[], steps: JSON.parse(String(r.steps)) as string[] };
  }
  recipes(): FamilyRecipe[] {
    return (this.#db.prepare('SELECT * FROM family_recipes ORDER BY title COLLATE NOCASE LIMIT 300').all() as Row[]).map((r) => this.#recipe(r));
  }
  recipe(id: number): FamilyRecipe | undefined {
    const r = this.#db.prepare('SELECT * FROM family_recipes WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#recipe(r) : undefined;
  }
  /** A recipe from pasted text, a parsed page, or a title plus ingredient lines. */
  addRecipe(by: string, r: { title?: unknown; text?: unknown; ingredients?: unknown; steps?: unknown; parsed?: ParsedRecipe; source?: unknown }): FamilyRecipe {
    this.#mustParent(by);
    const parsed = r.parsed ?? (typeof r.text === 'string' && r.text.trim() ? parseRecipeText(r.text.slice(0, 40_000)) : { title: '', ingredients: Array.isArray(r.ingredients) ? r.ingredients.slice(0, 60).map((x) => parseIngredient(String(x))) : [], steps: Array.isArray(r.steps) ? r.steps.slice(0, 40).map((x) => clip(x, 400)) : [] });
    const title = clip(r.title, 100) || parsed.title;
    if (!title) throw new FamilyError(400, en('Give the recipe a name.'));
    if (!parsed.ingredients.length) throw new FamilyError(400, en('No ingredients found. Paste the list with one ingredient per line.'));
    const id = Number(this.#db.prepare('INSERT INTO family_recipes (title, source, ingredients, steps, by, at) VALUES (?, ?, ?, ?, ?, ?)').run(title, clip(r.source, 300), JSON.stringify(parsed.ingredients), JSON.stringify(parsed.steps), by, this.#iso()).lastInsertRowid);
    this.#changed('recipe');
    return this.recipe(id)!;
  }
  removeRecipe(by: string, id: number): boolean {
    this.#mustParent(by);
    return Number(this.#db.prepare('DELETE FROM family_recipes WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ meals
  #meal(r: Row, people: FamilyPerson[]): Meal {
    const ingredients = JSON.parse(String(r.ingredients)) as Ingredient[];
    return { day: String(r.day), title: String(r.title), recipeId: r.recipe_id === null ? null : Number(r.recipe_id), ingredients, note: String(r.note), warnings: this.warningsFor(String(r.title), ingredients, people) };
  }
  setMeal(by: string, day: string, m: { title?: unknown; recipeId?: unknown; ingredients?: unknown; note?: unknown }, people: FamilyPerson[]): { meal: Meal; warnings: string[] } {
    this.#mustParent(by);
    if (!DAY_RE.test(day)) throw new FamilyError(400, en('That date doesn’t look right.'));
    const rec = m.recipeId !== undefined && m.recipeId !== null && m.recipeId !== '' ? this.recipe(Number(m.recipeId)) : undefined;
    if (m.recipeId && !rec) throw new FamilyError(404, en('That recipe is gone.'));
    const title = clip(m.title, 100) || rec?.title || '';
    if (!title) throw new FamilyError(400, en('Name the dinner.'));
    const ingredients = rec?.ingredients ?? (Array.isArray(m.ingredients) ? m.ingredients.slice(0, 60).map((x) => parseIngredient(String(x))) : []);
    this.#db.prepare('INSERT INTO family_meals (day, title, recipe_id, ingredients, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET title = excluded.title, recipe_id = excluded.recipe_id, ingredients = excluded.ingredients, note = excluded.note, by = excluded.by, at = excluded.at').run(day, title, rec?.id ?? null, JSON.stringify(ingredients), clip(m.note, 200), by, this.#iso());
    this.#changed('meal');
    const meal = this.meals(day, day, people)[0]!;
    return { meal, warnings: meal.warnings };
  }
  clearMeal(by: string, day: string): boolean {
    this.#mustParent(by);
    const n = Number(this.#db.prepare('DELETE FROM family_meals WHERE day = ?').run(day).changes);
    if (n) this.#changed('meal');
    return n > 0;
  }
  meals(from: string, to: string, people: FamilyPerson[] = []): Meal[] {
    return (this.#db.prepare('SELECT * FROM family_meals WHERE day >= ? AND day <= ? ORDER BY day').all(from, to) as Row[]).map((r) => this.#meal(r, people));
  }
  /** The week's dinners as one shopping list, merged by thing and unit, grouped by aisle. */
  shopping(start: string): ShoppingLine[] {
    return mergeIngredients(this.meals(start, addDays(start, 6)).flatMap((m) => m.ingredients));
  }
  /** One tap: the week's shopping list into a grocery list (the first one, or a new one shared with everyone). */
  toGrocery(by: string, start: string, boards: SharedBoardStore, known: string[], listId?: string): { listId: string; added: number; lines: number } {
    this.#mustParent(by);
    let id = listId && this.#s.isGrocery(listId) && boards.view(by, listId) ? listId : this.#s.groceryIds().find((g) => boards.view(by, g));
    if (!id) {
      const b = boards.create(by, en('Groceries'), known.filter((p) => p !== by), known);
      this.#s.markGrocery(b.id, by);
      id = b.id;
    }
    const have = new Set((boards.view(by, id)?.cards ?? []).filter((c) => c.status !== 'done').map((c) => c.title.toLowerCase()));
    const lines = this.shopping(start);
    let added = 0;
    for (const l of lines) {
      if (have.has(l.title.toLowerCase())) continue;
      const card = boards.addCard(by, id, { title: l.title.slice(0, 120) });
      if (!card) continue;
      this.#s.setItemMeta(id, card.ref, { aisle: l.aisle });
      have.add(l.title.toLowerCase());
      added++;
    }
    return { listId: id, added, lines: lines.length };
  }

  // ------------------------------------------------------------ chores rota
  rota(choreId: number): string[] {
    const r = this.#db.prepare('SELECT people FROM chore_rota WHERE chore_id = ?').get(choreId) as { people: string } | undefined;
    return r ? (JSON.parse(r.people) as string[]) : [];
  }
  rotas(): Record<number, string[]> {
    return Object.fromEntries((this.#db.prepare('SELECT chore_id, people FROM chore_rota').all() as { chore_id: number; people: string }[]).map((r) => [r.chore_id, JSON.parse(r.people) as string[]]));
  }
  /** Who takes turns at a chore (2+ people), or [] to stop the rota. */
  setRota(by: string, choreId: number, people: unknown, known: string[]): string[] {
    this.#mustParent(by);
    const c = this.#s.chore(choreId);
    if (!c) throw new FamilyError(404, en('That chore is gone.'));
    const list = Array.isArray(people) ? [...new Set(people.map(String))] : [];
    if (list.some((p) => !known.includes(p))) throw new FamilyError(400, en('Pick who does it.'));
    if (list.length < 2) {
      this.#db.prepare('DELETE FROM chore_rota WHERE chore_id = ?').run(choreId);
      return [];
    }
    this.#db.prepare('INSERT INTO chore_rota (chore_id, people, last_week) VALUES (?, ?, NULL) ON CONFLICT(chore_id) DO UPDATE SET people = excluded.people').run(choreId, JSON.stringify(list));
    if (!list.includes(c.assignee)) this.#s.updateChore(by, choreId, { assignee: list[0] }, known);
    this.#changed('rota');
    return list;
  }
  /** On the rota day (once a week): each rota chore moves to the next person. Returns how many moved. */
  rotateDue(at: Date, tz?: string): number {
    const z = zonedParts(at, tz);
    if (z.wd !== this.settings().rotaDay) return 0;
    const week = weekStartOf(at, tz);
    let n = 0;
    for (const r of this.#db.prepare('SELECT chore_id, people, last_week FROM chore_rota').all() as Row[]) {
      if (r.last_week === week) continue;
      const c = this.#s.chore(Number(r.chore_id));
      const people = JSON.parse(String(r.people)) as string[];
      this.#db.prepare('UPDATE chore_rota SET last_week = ? WHERE chore_id = ?').run(week, r.chore_id);
      if (!c || !c.active || people.length < 2) continue;
      const next = people[(people.indexOf(c.assignee) + 1) % people.length]!;
      this.#db.prepare('UPDATE chores SET assignee = ? WHERE id = ?').run(next, c.id);
      n++;
    }
    if (n) this.#changed('rota');
    return n;
  }
  /** Chores left today for each person (due before the end of the day, not done). */
  #choresLeft(at: Date, tz?: string): Map<string, string[]> {
    const z = zonedParts(at, tz);
    const end = zonedToUtc(z.y, z.mo, z.d + 1, 0, 0, tz).toISOString();
    const out = new Map<string, string[]>();
    for (const c of this.#s.chores('owner')) {
      if (c.dueAt >= end) continue;
      if (this.#db.prepare("SELECT 1 FROM chore_marks WHERE chore_id = ? AND due_at = ? AND status != 'rejected'").get(c.id, c.dueAt)) continue;
      out.set(c.assignee, [...(out.get(c.assignee) ?? []), c.title]);
    }
    return out;
  }
  /** At the reminder time: one reminder per person with chores left, outside their quiet hours, once a day. */
  remindersDue(at: Date, tz: string | undefined, quiet: (person: string) => boolean): { person: string; chores: string[] }[] {
    const s = this.settings();
    if (!s.reminders) return [];
    const z = zonedParts(at, tz);
    if (z.h * 60 + z.mi < Number(s.remindAt.slice(0, 2)) * 60 + Number(s.remindAt.slice(3))) return [];
    const day = `${z.y}-${pad(z.mo)}-${pad(z.d)}`;
    const out: { person: string; chores: string[] }[] = [];
    for (const [person, chores] of this.#choresLeft(at, tz)) {
      if (this.#db.prepare('SELECT 1 FROM family_reminded WHERE person = ? AND day = ?').get(person, day)) continue;
      if (quiet(person)) continue;
      this.#db.prepare('INSERT OR IGNORE INTO family_reminded (person, day) VALUES (?, ?)').run(person, day);
      out.push({ person, chores });
    }
    return out;
  }

  // ------------------------------------------------------------ family calendar
  #event(r: Row): FamilyEvent {
    return { id: Number(r.id), title: String(r.title), start: String(r.start), end: r.end === null ? null : String(r.end), allDay: Boolean(r.all_day), who: String(r.who), source: String(r.source), status: String(r.status) as FamilyEvent['status'], by: String(r.by) };
  }
  /** An event typed in: "family" (a parent's shows at once, anyone else's waits for a parent) or "me" (private). */
  addEvent(by: string, e: { title: unknown; start: unknown; end?: unknown; who?: unknown }): FamilyEvent {
    const title = clip(e.title, 100);
    if (!title) throw new FamilyError(400, en('Name the event.'));
    const start = String(e.start ?? '');
    if (!START_RE.test(start)) throw new FamilyError(400, en('That date doesn’t look right.'));
    const end = typeof e.end === 'string' && START_RE.test(e.end) ? e.end : null;
    const mine = e.who === 'me';
    const status = mine || this.#s.isParent(by) ? 'ok' : 'pending';
    const id = Number(this.#db.prepare('INSERT INTO family_events (title, start, end, all_day, who, source, status, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, start, end, start.length === 10 ? 1 : 0, mine ? by : 'family', '', status, by, this.#iso()).lastInsertRowid);
    this.#changed('event');
    return this.#event(this.#db.prepare('SELECT * FROM family_events WHERE id = ?').get(id) as Row);
  }
  /** Events read from a letter, PDF or iCal file: they wait for a parent's OK (the same date and title once). */
  importEvents(by: string, found: FoundEvent[], source: unknown): FamilyEvent[] {
    this.#mustParent(by);
    const src = clip(source, 80);
    const ids: number[] = [];
    for (const f of found.slice(0, 300)) {
      const title = clip(f.title, 100);
      if (!title || !START_RE.test(f.start)) continue;
      if (this.#db.prepare("SELECT 1 FROM family_events WHERE who = 'family' AND lower(title) = lower(?) AND start = ?").get(title, f.start)) continue;
      ids.push(Number(this.#db.prepare("INSERT INTO family_events (title, start, end, all_day, who, source, status, by, at) VALUES (?, ?, ?, ?, 'family', ?, 'pending', ?, ?)").run(title, f.start, f.end && START_RE.test(f.end) ? f.end : null, f.allDay ? 1 : 0, src, by, this.#iso()).lastInsertRowid));
    }
    if (ids.length) this.#changed('event');
    return ids.map((id) => this.#event(this.#db.prepare('SELECT * FROM family_events WHERE id = ?').get(id) as Row));
  }
  pending(by: string): FamilyEvent[] {
    if (!this.#s.isParent(by)) return [];
    return (this.#db.prepare("SELECT * FROM family_events WHERE status = 'pending' ORDER BY start LIMIT 300").all() as Row[]).map((r) => this.#event(r));
  }
  decide(by: string, ids: unknown, ok: boolean): number {
    this.#mustParent(by);
    let n = 0;
    for (const id of Array.isArray(ids) ? ids.slice(0, 300) : []) n += Number(this.#db.prepare("UPDATE family_events SET status = ? WHERE id = ? AND status = 'pending'").run(ok ? 'ok' : 'declined', Number(id)).changes);
    if (n) this.#changed('event');
    return n;
  }
  /** Remove an event: its own person, or a parent for family events. */
  removeEvent(by: string, id: number): boolean {
    const r = this.#db.prepare('SELECT * FROM family_events WHERE id = ?').get(id) as Row | undefined;
    if (!r) return false;
    const e = this.#event(r);
    if (e.who === 'family' ? !this.#s.isParent(by) && e.by !== by : e.who !== by) throw new FamilyError(403, en('Only a parent can do that.'));
    this.#db.prepare('DELETE FROM family_events WHERE id = ?').run(id);
    this.#changed('event');
    return true;
  }
  /** What a person sees between two days: approved family events and their own private ones. */
  events(person: string, from: string, to: string): FamilyEvent[] {
    return (this.#db.prepare("SELECT * FROM family_events WHERE status = 'ok' AND (who = 'family' OR who = ?) AND substr(start, 1, 10) >= ? AND substr(start, 1, 10) <= ? ORDER BY start LIMIT 500").all(person, from, to) as Row[]).map((r) => this.#event(r));
  }

  // ------------------------------------------------------------ the week and Today
  week(person: string, start: string, tz?: string, people: FamilyPerson[] = []): { start: string; days: { day: string; meal: Meal | null; events: FamilyEvent[]; chores: { id: number; title: string; assignee: string }[] }[] } {
    if (!DAY_RE.test(start)) start = weekStartOf(this.#now(), tz);
    const end = addDays(start, 6);
    const meals = this.meals(start, end, people);
    const events = this.events(person, start, end);
    const chores = this.#s.chores(person);
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(start, i);
      return {
        day,
        meal: meals.find((m) => m.day === day) ?? null,
        events: events.filter((e) => e.start.slice(0, 10) === day),
        chores: chores.filter((c) => localStart(c.dueAt, false, tz).slice(0, 10) === day).map((c) => ({ id: c.id, title: c.title, assignee: c.assignee })),
      };
    });
    return { start, days };
  }
  /** Family Today: tonight's dinner, the person's chores left today, the next family event. */
  today(person: string, at: Date, tz?: string): { dinner: string | null; dinnerTime: string; choresLeft: number; nextEvent: FamilyEvent | null } {
    const z = zonedParts(at, tz);
    const day = `${z.y}-${pad(z.mo)}-${pad(z.d)}`;
    const now = `${day}T${pad(z.h)}:${pad(z.mi)}`;
    const dinner = this.meals(day, day)[0]?.title ?? null;
    const left = this.#s.isParent(person) ? [...this.#choresLeft(at, tz).values()].flat().length : (this.#choresLeft(at, tz).get(person) ?? []).length;
    const next = this.events(person, day, addDays(day, 60)).find((e) => (e.allDay ? e.start >= day : e.start >= now)) ?? null;
    return { dinner, dinnerTime: this.settings().dinnerTime, choresLeft: left, nextEvent: next };
  }
}

/** The reminder tick (from familyTick, the owner's space): the rota turns, then chore reminders per person. */
export function familyPlanTick(f: FamilyAccess, now: Date): void {
  const plan = planOf(f.store);
  const tz = f.tz();
  plan.rotateDue(now, tz);
  if (!f.notifyPerson) return;
  for (const r of plan.remindersDue(now, tz, (p) => f.quietFor?.(p) ?? false)) {
    f.notifyPerson(r.person, en('Chores for today'), r.chores.slice(0, 6).join(', '));
  }
}

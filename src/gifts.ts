// V2.7 (docs/design/GIFTS.md, docs/PEOPLE.md "Gifts and occasions"): gift ideas, a budget, a
// shopping-list to-do, card text in the owner's writing style and a reminder ahead of each
// birthday and yearly date on a People card.
//
// Privacy: only what she may use in a normal chat goes into a prompt. A private card is refused before any model call; private, sensitive (health, intimate, money, legal), pending
// and chat-room facts never leave the card. Each person's space has its own store.db, so household
// members never see each other's plans. Ideas and card text are drafts: nothing is bought or sent.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { HttpError } from './http.ts';
import { styleCardNote, writingFor } from './humanize.ts';
import { complete } from './life.ts';
import type { Person } from './people.ts';
import { zonedToUtc } from './planner.ts';
import { backgroundConversation } from './store.ts';
import type { Tool } from './tools/types.ts';
import { ToolError } from './tools/types.ts';

const DAY = 86_400_000;
/** How far ahead reminders are armed, and how often the tick looks. */
const ARM_AHEAD_DAYS = 60;
const TICK_EVERY = 3600_000;
export const GIFT_DAYS = [7, 14, 21, 30] as const;
const MAX_IDEAS = 5;
const MAX_FACTS = 12;

export interface Occasion { key: string; label: string; date: string; days: number }
export interface GiftIdea { title: string; why: string; price: number | null; taskId: number | null }
export interface GiftPlan { budget: number | null; remind: boolean | null; ideas: GiftIdea[]; card: { occasion: string; text: string; at: string } | null; ideasAt: string | null }
export interface GiftPrefs { on: boolean; days: number; budget: number | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gift_plans (person_id INTEGER PRIMARY KEY, budget REAL, remind INTEGER, ideas TEXT NOT NULL DEFAULT '[]', ideas_at TEXT, card TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS gift_reminders (person_id INTEGER NOT NULL, occasion TEXT NOT NULL, date TEXT NOT NULL, reminder_id INTEGER, PRIMARY KEY (person_id, occasion, date));
`;

/** The next `YYYY-MM-DD` (today counts) for a `…MM-DD` day; Feb 29 falls on Feb 28 in other years. */
export function nextOn(day: string, today: string): string | null {
  const md = /(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!md) return null;
  const y = Number(today.slice(0, 4));
  for (const yr of [y, y + 1, y + 2]) {
    const leap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
    const ymd = `${yr}-${md[1]}-${md[1] === '02' && md[2] === '29' && !leap ? '28' : md[2]}`;
    if (ymd >= today) return ymd;
  }
  return null;
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const money = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[^\d.]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(Math.min(n, 1_000_000) * 100) / 100 : null;
};
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export class Gifts {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  #lastTick = 0;

  constructor(app: AppContext) {
    this.#app = app;
    this.#db = app.store.db;
    this.#db.exec(SCHEMA);
    const people = app.people;
    if (people) {
      // Chain with S4's hooks (PeopleTies sets them first): forget/merge stay exact.
      const wipe = people.onWipe;
      const merge = people.onMerge;
      people.onWipe = (id) => {
        wipe?.(id);
        this.forget(id);
      };
      people.onMerge = (id, into) => {
        merge?.(id, into);
        this.merge(id, into);
      };
    }
  }

  #today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.#app.settings.get().timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.#app.now());
  }
  #kv(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
  }
  #kvSet(key: string, value: string): void {
    this.#db.prepare('INSERT INTO memory_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ------------------------------------------------------------------ prefs (Settings)

  prefs(): GiftPrefs {
    let p: Partial<GiftPrefs> = {};
    try {
      p = JSON.parse(this.#kv('gifts:prefs') ?? '{}') as Partial<GiftPrefs>;
    } catch {
      p = {};
    }
    return { on: p.on !== false, days: GIFT_DAYS.includes(p.days as 14) ? (p.days as number) : 14, budget: money(p.budget) };
  }
  setPrefs(patch: { on?: unknown; days?: unknown; budget?: unknown }): GiftPrefs {
    const cur = this.prefs();
    if (patch.days !== undefined && !GIFT_DAYS.includes(Number(patch.days) as 14)) throw new HttpError(400, 'Pick 7, 14, 21 or 30 days.');
    const next: GiftPrefs = {
      on: patch.on === undefined ? cur.on : patch.on !== false,
      days: patch.days === undefined ? cur.days : Number(patch.days),
      budget: patch.budget === undefined ? cur.budget : money(patch.budget),
    };
    this.#kvSet('gifts:prefs', JSON.stringify(next));
    this.#lastTick = 0;
    return next;
  }

  // ------------------------------------------------------------------ per card

  /** Why gifts can't be planned from this card (null = they can). */
  blocked(p: Person): 'private' | null {
    // A card with a sensitive fact stays usable: those facts are filtered out (usableFacts).
    return p.private ? 'private' : null;
  }
  #person(id: number): Person {
    const p = this.#app.people?.get(id);
    if (!p || p.status === 'merged' || p.status === 'forgotten' || p.status === 'rejected') throw new HttpError(404, 'That person is gone.');
    return p;
  }
  #usable(id: number): Person {
    const p = this.#person(id);
    if (this.blocked(p)) throw new HttpError(409, 'This card is private: she does not plan gifts from it.');
    return p;
  }

  occasions(p: Person): Occasion[] {
    const today = this.#today();
    const out: Occasion[] = [];
    const add = (key: string, label: string, day: string | null | undefined) => {
      const date = day ? nextOn(day, today) : null;
      if (date) out.push({ key, label, date, days: daysBetween(today, date) });
    };
    add('birthday', 'Birthday', p.birthday);
    for (const d of this.#app.peopleTies?.tie(p.id).dates ?? []) add(`date:${d.label}`, d.label, d.date);
    return out.sort((a, b) => a.days - b.days);
  }

  plan(personId: number): GiftPlan {
    const r = this.#db.prepare('SELECT * FROM gift_plans WHERE person_id = ?').get(personId) as Record<string, unknown> | undefined;
    const parse = <T>(s: unknown, d: T): T => {
      try {
        return s ? (JSON.parse(String(s)) as T) : d;
      } catch {
        return d;
      }
    };
    return { budget: money(r?.budget), remind: r?.remind === null || r?.remind === undefined ? null : Boolean(r.remind), ideas: parse<GiftIdea[]>(r?.ideas, []), card: parse<GiftPlan['card']>(r?.card, null), ideasAt: (r?.ideas_at as string | null) ?? null };
  }
  #save(personId: number, p: GiftPlan): GiftPlan {
    this.#db
      .prepare('INSERT INTO gift_plans (person_id, budget, remind, ideas, ideas_at, card, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET budget = excluded.budget, remind = excluded.remind, ideas = excluded.ideas, ideas_at = excluded.ideas_at, card = excluded.card, updated_at = excluded.updated_at')
      .run(personId, p.budget, p.remind === null ? null : p.remind ? 1 : 0, JSON.stringify(p.ideas), p.ideasAt, p.card ? JSON.stringify(p.card) : null, this.#app.now().toISOString());
    return p;
  }
  setPlan(personId: number, patch: { budget?: unknown; remind?: unknown }): GiftPlan {
    this.#person(personId);
    const cur = this.plan(personId);
    if (patch.budget !== undefined) cur.budget = money(patch.budget);
    if (patch.remind !== undefined) cur.remind = patch.remind === null ? null : Boolean(patch.remind);
    this.#lastTick = 0;
    return this.#save(personId, cur);
  }
  budgetOf(personId: number): number | null {
    return this.plan(personId).budget ?? this.prefs().budget;
  }

  /** Facts she may use for gifts: never private, sensitive, pending, room or replaced ones. */
  usableFacts(personId: number): string[] {
    return (this.#app.people?.facts(personId) ?? [])
      .filter((f) => !f.private && !f.category && !f.pending && f.roomId === null && (f.supersededBy === null || f.supersededBy === undefined))
      .slice(0, MAX_FACTS)
      .map((f) => clip(f.content, 240));
  }
  #about(p: Person): string {
    const facts = this.usableFacts(p.id);
    const notes = clip(p.notes, 600);
    return [`Name: ${p.name}`, p.relation ? `Who they are to the owner: ${clip(p.relation, 80)}` : '', facts.length ? `What she knows:\n${facts.map((f) => `- ${f}`).join('\n')}` : 'What she knows: nothing yet.', notes ? `The owner's own notes on the card: ${notes}` : ''].filter(Boolean).join('\n');
  }

  /** Up to 5 ideas from what she knows (within the budget), saved on the card. */
  async ideas(personId: number, opts: { occasion?: string; signal?: AbortSignal } = {}): Promise<GiftIdea[]> {
    const p = this.#usable(personId);
    const occ = this.occasions(p).find((o) => o.key === opts.occasion) ?? this.occasions(p)[0];
    const budget = this.budgetOf(personId);
    const prompt = `${this.#about(p)}\n${occ ? `Occasion: ${occ.label} on ${occ.date}.` : ''}\n${budget ? `Budget: up to ${budget} per gift.` : 'No budget given: keep it modest.'}\nSuggest up to ${MAX_IDEAS} thoughtful, specific gift ideas that fit what she knows about this person. Answer only JSON: {"ideas":[{"title":"short name of the gift","why":"one short reason from what she knows","price":estimated price as a number}]}.`;
    const out = await complete(this.#app, backgroundConversation(this.#app.store, 'Gifts'), [{ role: 'system', content: 'You suggest gift ideas. Output only valid JSON.' }, { role: 'user', content: prompt }], 700, 'background', opts.signal);
    const list = parseIdeas(out).filter((i) => !budget || i.price === null || i.price <= budget).slice(0, MAX_IDEAS);
    if (!list.length) throw new HttpError(502, 'She could not think of ideas right now. Try again in a moment.');
    const plan = this.plan(personId);
    // Keep ideas already on the shopping list.
    const kept = plan.ideas.filter((i) => i.taskId);
    plan.ideas = [...kept, ...list.filter((i) => !kept.some((k) => k.title.toLowerCase() === i.title.toLowerCase()))].slice(0, MAX_IDEAS + kept.length);
    plan.ideasAt = this.#app.now().toISOString();
    this.#save(personId, plan);
    return plan.ideas;
  }

  /** A short card text in the owner's writing style, saved as a draft (never sent). */
  async card(personId: number, occasion?: string, opts: { gift?: string; signal?: AbortSignal } = {}): Promise<string> {
    const p = this.#usable(personId);
    const occ = this.occasions(p).find((o) => o.key === occasion) ?? this.occasions(p)[0];
    const s = this.#app.settings.get();
    const style = writingFor(this.#app).get().card;
    const voice = style ? styleCardNote(style) : 'Write warmly and plainly, the way a person writes a card by hand.';
    const owner = clip(s.ownerName, 60);
    const prompt = `${this.#about(p)}\nOccasion: ${occ?.label ?? 'a card'}.${opts.gift ? `\nThe gift: ${clip(opts.gift, 120)}.` : ''}\nWrite the text for a greeting card from ${owner || 'the owner'} to ${p.name}: 2 to 4 short sentences, personal, no clichés, no hashtags or emojis. ${voice}${owner ? ` Sign it with "${owner}".` : ''} Answer with the card text only.`;
    const text = clip(await complete(this.#app, backgroundConversation(this.#app.store, 'Gifts'), [{ role: 'system', content: 'You write short greeting cards in the owner\'s own voice.' }, { role: 'user', content: prompt }], 400, 'writing', opts.signal), 1200);
    if (!text) throw new HttpError(502, 'She could not write the card right now. Try again in a moment.');
    const plan = this.plan(personId);
    plan.card = { occasion: occ?.key ?? '', text, at: this.#app.now().toISOString() };
    this.#save(personId, plan);
    return text;
  }

  /** An idea as a to-do in the Planner's Gifts project, due a week before the occasion (once). */
  toList(personId: number, index: number): { id: number; title: string } {
    const p = this.#usable(personId);
    const plan = this.plan(personId);
    const idea = plan.ideas[index];
    if (!idea) throw new HttpError(404, 'That idea is gone.');
    const planner = this.#app.planner;
    if (!planner) throw new HttpError(404, 'The Planner is not available here.');
    const have = idea.taskId ? planner.task(idea.taskId) : undefined;
    if (have) return { id: have.id, title: have.title };
    const project = planner.createBuiltinProject('gifts', 'Gifts');
    const occ = this.occasions(p)[0];
    const today = this.#today();
    let dueAt: string | null = null;
    if (occ) {
      const d = new Date(Date.parse(`${occ.date}T12:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
      const day = d < today ? today : d;
      dueAt = zonedToUtc(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)), 9, 0, this.#app.settings.get().timeZone).toISOString();
    }
    const budget = this.budgetOf(personId);
    const task = planner.addTask({ title: `Gift for ${p.name}: ${idea.title}`.slice(0, 200), project: project.name, notes: [idea.why, idea.price ? `About ${idea.price}` : '', budget ? `Budget: up to ${budget}` : '', occ ? `${occ.label}: ${occ.date}` : ''].filter(Boolean).join('\n'), dueAt });
    idea.taskId = task.id;
    this.#save(personId, plan);
    this.#app.events?.publish({ type: 'planner', what: 'tasks' } as never);
    return { id: task.id, title: task.title };
  }

  /** Whom the reminder applies to: switched on, or (default) family/partner or a card with a plan. */
  #remindsFor(p: Person): boolean {
    if (this.blocked(p) || p.status !== 'active') return false;
    const plan = this.plan(p.id);
    if (plan.remind !== null) return plan.remind;
    return p.circle === 'family' || p.circle === 'partner' || plan.budget !== null || plan.ideas.length > 0;
  }

  /** The reminder tick: N days before each occasion, a Planner reminder (once per person + day). */
  due(now: Date): number {
    if (now.getTime() - this.#lastTick < TICK_EVERY && this.#lastTick) return 0;
    this.#lastTick = now.getTime();
    const prefs = this.prefs();
    const planner = this.#app.planner;
    if (!prefs.on || this.#app.offRecord || !this.#app.people || !planner) return 0;
    const tz = this.#app.settings.get().timeZone;
    let made = 0;
    for (const p of this.#app.people.all()) {
      if (!this.#remindsFor(p)) continue;
      for (const o of this.occasions(p)) {
        if (o.days > ARM_AHEAD_DAYS || o.days < 2) continue;
        if (this.#db.prepare('SELECT 1 FROM gift_reminders WHERE person_id = ? AND occasion = ? AND date = ?').get(p.id, o.key, o.date)) continue;
        const day = new Date(Date.parse(`${o.date}T12:00:00Z`) - prefs.days * DAY);
        let at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 0, tz);
        if (at.getTime() <= now.getTime()) at = new Date(now.getTime() + 60_000);
        const when = new Date(`${o.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
        const what = o.key === 'birthday' ? `${p.name}'s birthday is on ${when}` : `${p.name}: ${o.label} is on ${when}`;
        const budget = this.budgetOf(p.id);
        const r = planner.addReminder({ text: `${what}. Time to think of a gift${budget ? ` (budget ${budget})` : ''} and a card: ideas are on their People card.`, dueAt: at.toISOString() });
        this.#db.prepare('INSERT INTO gift_reminders (person_id, occasion, date, reminder_id) VALUES (?, ?, ?, ?)').run(p.id, o.key, o.date, r.id);
        made++;
      }
    }
    if (made) this.#app.events?.publish({ type: 'planner', what: 'reminders' });
    return made;
  }

  forget(personId: number): void {
    for (const r of this.#db.prepare('SELECT reminder_id FROM gift_reminders WHERE person_id = ?').all(personId) as { reminder_id: number | null }[]) if (r.reminder_id) this.#app.planner?.cancelReminder(r.reminder_id);
    this.#db.prepare('DELETE FROM gift_reminders WHERE person_id = ?').run(personId);
    this.#db.prepare('DELETE FROM gift_plans WHERE person_id = ?').run(personId);
  }
  merge(from: number, into: number): void {
    if (!this.#db.prepare('SELECT 1 FROM gift_plans WHERE person_id = ?').get(into)) this.#db.prepare('UPDATE gift_plans SET person_id = ? WHERE person_id = ?').run(into, from);
    this.#db.prepare('DELETE FROM gift_plans WHERE person_id = ?').run(from);
    this.#db.prepare('UPDATE OR IGNORE gift_reminders SET person_id = ? WHERE person_id = ?').run(into, from);
    this.#db.prepare('DELETE FROM gift_reminders WHERE person_id = ?').run(from);
  }

  /** The card's view for the web. */
  view(personId: number): { occasions: Occasion[]; plan: GiftPlan; blocked: 'private' | null; budget: number | null; reminds: boolean; on: boolean; days: number } {
    const p = this.#person(personId);
    const blocked = this.blocked(p);
    const prefs = this.prefs();
    return { occasions: blocked ? [] : this.occasions(p), plan: blocked ? { budget: null, remind: null, ideas: [], card: null, ideasAt: null } : this.plan(personId), blocked, budget: blocked ? null : this.budgetOf(personId), reminds: this.#remindsFor(p), on: prefs.on, days: prefs.days };
  }
}

/** Ideas from the model's JSON (lenient: a bare array, code fences, extra text). */
export function parseIdeas(out: string): GiftIdea[] {
  const m = /[[{][\s\S]*[\]}]/.exec(String(out ?? ''));
  if (!m) return [];
  let v: unknown;
  try {
    v = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const arr = Array.isArray(v) ? v : Array.isArray((v as { ideas?: unknown })?.ideas) ? (v as { ideas: unknown[] }).ideas : [];
  const seen = new Set<string>();
  const out_: GiftIdea[] = [];
  for (const x of arr as Record<string, unknown>[]) {
    const title = clip(x?.title ?? x?.name, 120);
    if (title.length < 2 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out_.push({ title, why: clip(x?.why ?? x?.reason, 240), price: money(x?.price), taskId: null });
  }
  return out_;
}

const cache = new WeakMap<DatabaseSync, Gifts>();
/** The space's gift planner (one per store.db, made on first use). */
export function giftsOf(app: AppContext): Gifts {
  let g = cache.get(app.store.db);
  if (!g) {
    g = new Gifts(app);
    cache.set(app.store.db, g);
  }
  return g;
}
/** The reminder tick (src/reminders.ts): only where People cards exist. */
export function giftsTick(app: AppContext, now: Date): void {
  if (!app.people) return;
  try {
    giftsOf(app).due(now);
  } catch (err) {
    console.warn(`gifts: ${(err as Error).message}`);
  }
}

export function createGiftTools(app: () => AppContext): Tool[] {
  const who = (name: unknown): Person => {
    const people = app().people;
    if (!people) throw new ToolError('People cards are not available here.');
    const p = typeof name === 'string' && name.trim() ? people.find(name.trim()).found[0] : undefined;
    if (!p) throw new ToolError(`No people card for "${clip(name, 60)}".`);
    return p;
  };
  const refuse = (p: Person) => `${p.name}'s card is private: she does not plan gifts or write cards from it.`;
  return [
    {
      changes: false,
      spec: {
        name: 'people_gift_ideas',
        description: "Gift ideas for a person on the owner's People cards (birthday, anniversary or another occasion), from what she knows about them, within the owner's budget. Saves them on the card; the owner can put one on the shopping list there. Never uses private cards or private facts.",
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'The person (a name on a card).' }, budget: { type: 'number', description: 'Only when the owner gives a budget now.' } }, required: ['name'] },
      },
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().people && !app().offRecord),
      summarize: (a) => `Gift ideas for ${clip(a.name, 40)}`,
      async run(args, ctx) {
        const p = who(args.name);
        const g = giftsOf(app());
        if (g.blocked(p)) return refuse(p);
        if (args.budget !== undefined) g.setPlan(p.id, { budget: args.budget });
        try {
          const ideas = await g.ideas(p.id, { signal: (ctx as { signal?: AbortSignal })?.signal });
          const occ = g.occasions(p)[0];
          return `${occ ? `${occ.label} on ${occ.date} (in ${occ.days} days). ` : ''}Ideas for ${p.name} (saved on their card):\n${ideas.map((i) => `- ${i.title}${i.price ? ` (about ${i.price})` : ''}${i.why ? `: ${i.why}` : ''}`).join('\n')}`;
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
      },
    },
    {
      changes: true,
      spec: {
        name: 'people_gift_card',
        description: "Draft the text for a greeting card to a person on the owner's People cards, in the owner's own writing style. Saved on the card as a draft; never sent.",
        parameters: { type: 'object', properties: { name: { type: 'string' }, occasion: { type: 'string', description: "'birthday' or the label of a date on their card." }, gift: { type: 'string', description: 'The gift, when the owner said it.' } }, required: ['name'] },
      },
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().people && !app().offRecord),
      summarize: (a) => `Card text for ${clip(a.name, 40)}`,
      async run(args, ctx) {
        const p = who(args.name);
        const g = giftsOf(app());
        if (g.blocked(p)) return refuse(p);
        const occ = typeof args.occasion === 'string' ? (args.occasion === 'birthday' ? 'birthday' : `date:${args.occasion}`) : undefined;
        try {
          return `Draft card for ${p.name} (saved on their card):\n\n${await g.card(p.id, occ, { gift: typeof args.gift === 'string' ? args.gift : undefined, signal: (ctx as { signal?: AbortSignal })?.signal })}`;
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
      },
    },
  ];
}

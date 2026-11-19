// R8 (docs/FAMILY.md): her Family tools. chore_add (a parent: a recurring chore for someone, worth
// points and/or money), chore_list, chore_done (the person it's assigned to: it then waits for a
// parent's OK), allowance_balance, and allowance_pay (a parent records a payout: a record only, it
// never moves money; the card says so). kid_search is a child's web search in strict safe-search mode
// (only when a parent allowed it and the owner's search provider has a safe-search switch).
import type { AppContext } from '../chat.ts';
import { FamilyError, kidResultOk, kidsOf, money, type FamilyAccess } from '../family.ts';
import { planOf, weekStartOf } from '../family-plan.ts';
import { formatResults, runSearch, type SearchConfig } from './search.ts';
import { ToolError, type Tool } from './types.ts';

const guard = <T>(f: () => T): T => {
  try {
    return f();
  } catch (err) {
    if (err instanceof FamilyError) throw new ToolError(err.message);
    throw err;
  }
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const access = (app: AppContext): FamilyAccess => {
  if (!app.family) throw new ToolError('Family is not available here.');
  return app.family;
};
/** A person by name ("Mia"), among the household. */
function personNamed(f: FamilyAccess, name: unknown): { id: string; name: string } | undefined {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return undefined;
  const all = f.people();
  return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().startsWith(n)) ?? all.find((p) => p.id === n);
}
const due = (iso: string, tz?: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
const worth = (c: { points: number; cents: number }) => [c.cents ? money(c.cents) : '', c.points ? `${c.points} points` : ''].filter(Boolean).join(' + ') || 'no reward';

export function createFamilyTools(appOf: () => AppContext): Tool[] {
  const isParent = () => {
    const f = appOf().family;
    return Boolean(f && f.store.isParent(f.person));
  };
  const has = () => Boolean(appOf().family);
  const choreAdd: Tool = {
    defaultPermission: 'auto',
    isAvailable: () => has() && isParent(),
    spec: {
      name: 'chore_add',
      description: 'A parent adds a chore for someone in the household (a kid, usually): what, who, how often (once, daily, weekdays, weekly), when it is first due, and what it is worth (points and/or an amount of allowance). The kid marks it done (photo optional) and a parent approves; approved chores go into their allowance ledger.',
      parameters: obj({ title: { type: 'string' }, who: { type: 'string', description: 'Their name.' }, repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly'] }, due: { type: 'string', description: 'ISO date-time it is first due (default: tomorrow).' }, points: { type: 'integer' }, amount: { type: 'number', description: 'Allowance in dollars, e.g. 2.5.' }, photo: { type: 'boolean', description: 'Ask for a photo when they mark it done.' } }, ['title', 'who']),
    },
    summarize: (a) => `add the chore “${String(a.title ?? '')}” for ${String(a.who ?? '')}`,
    async run(args) {
      const f = access(appOf());
      const p = personNamed(f, args.who);
      if (!p) throw new ToolError(`Who is that? The household: ${f.people().map((x) => x.name).join(', ')}.`);
      const c = guard(() => f.store.addChore(f.person, { title: args.title, assignee: p.id, points: args.points, amount: args.amount, repeat: args.repeat, dueAt: args.due, photo: args.photo, tz: f.tz() }, f.people().map((x) => x.id)));
      const back = f.store.chore(c.id);
      return back ? `Chore #${back.id} “${back.title}” for ${p.name}, ${back.repeat}, first due ${due(back.dueAt, f.tz())}, worth ${worth(back)}.\nVerified: chore #${back.id} reads back from Family.` : 'Could not verify: the chore was not saved.';
    },
  };
  const choreList: Tool = {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: has,
    spec: { name: 'chore_list', description: 'The chores: a parent sees everyone’s, a kid their own (number, who, when due, worth), plus the ones waiting for a parent’s OK.', parameters: obj({}) },
    summarize: () => 'list the chores',
    async run() {
      const f = access(appOf());
      const names = new Map(f.people().map((p) => [p.id, p.name]));
      const list = f.store.chores(f.person);
      const waiting = f.store.marks(f.person, { status: 'waiting', limit: 20 });
      if (!list.length && !waiting.length) return 'No chores yet.';
      return [
        ...list.map((c) => `#${c.id} ${c.title} — ${names.get(c.assignee) ?? 'someone'} — ${c.repeat}, due ${due(c.dueAt, f.tz())} — ${worth(c)}${c.photo ? ' — photo asked' : ''}`),
        ...(waiting.length ? ['', 'Waiting for a parent’s OK:', ...waiting.map((m) => `- mark #${m.id}: ${m.title} by ${names.get(m.kid) ?? 'someone'} (${worth(m)})`)] : []),
      ].join('\n');
    },
  };
  const choreDone: Tool = {
    defaultPermission: 'auto',
    isAvailable: has,
    spec: { name: 'chore_done', description: 'Marks one of their chores done (by number or name). It then waits for a parent’s OK before it counts toward the allowance. A photo can be added on the Family page.', parameters: obj({ chore: { type: 'string', description: 'The chore number or name.' }, note: { type: 'string' } }, ['chore']) },
    summarize: (a) => `mark “${String(a.chore ?? '')}” done`,
    async run(args) {
      const f = access(appOf());
      const c = f.store.findChore(f.person, args.chore);
      if (!c) throw new ToolError('Which chore? chore_list shows them.');
      const m = guard(() => f.store.markDone(f.person, c.id, { note: args.note, tz: f.tz() }));
      return `Marked “${m.title}” done. It waits for a parent’s OK (${worth(m)}).\nVerified: mark #${m.id} reads back as waiting.`;
    },
  };
  const balance: Tool = {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: has,
    spec: { name: 'allowance_balance', description: 'Allowance so far: earned, paid out, balance and points (a kid: their own; a parent: one kid by name, or every kid).', parameters: obj({ who: { type: 'string' } }) },
    summarize: () => 'check the allowance',
    async run(args) {
      const f = access(appOf());
      const kids = f.store.isParent(f.person) ? (args.who ? [personNamed(f, args.who)].filter((x): x is { id: string; name: string } => Boolean(x)) : kidsOf(f)) : [{ id: f.person, name: 'You' }];
      if (!kids.length) return 'No kids in the household yet (a parent turns on kid-safe mode for a member in Settings → Household).';
      return kids.map((k) => {
        const b = guard(() => f.store.balance(f.person, k.id));
        return `${k.name}: balance ${money(b.balanceCents)} (earned ${money(b.earnedCents)}, paid out ${money(b.paidCents)})${b.points ? `, ${b.points} points` : ''}${b.waiting ? `, ${b.waiting} chore${b.waiting === 1 ? '' : 's'} waiting for an OK` : ''}.`;
      }).join('\n');
    },
  };
  const pay: Tool = {
    defaultPermission: 'ask',
    isAvailable: () => has() && isParent(),
    spec: { name: 'allowance_pay', description: 'A parent records that they paid a kid some allowance (cash, or a transfer they made themselves). It is a record in the ledger only: you never move money.', parameters: obj({ who: { type: 'string' }, amount: { type: 'number', description: 'Dollars, e.g. 5.' }, note: { type: 'string' } }, ['who', 'amount']) },
    summarize: (a) => `record a $${Number(a.amount ?? 0).toFixed(2)} allowance payout to ${String(a.who ?? '')} (a record only; no money moves)`,
    async run(args) {
      const f = access(appOf());
      const p = personNamed(f, args.who);
      if (!p) throw new ToolError('Who was paid? Give their name.');
      const row = guard(() => f.store.pay(f.person, p.id, args.amount, args.note));
      const b = f.store.balance(f.person, p.id);
      return `Recorded: paid ${p.name} ${money(row.cents)} (a record only; no money was moved). Balance now ${money(b.balanceCents)}.\nVerified: ledger entry #${row.id} reads back.`;
    },
  };
  return [choreAdd, choreList, choreDone, balance, pay, ...createPlanTools(appOf, has, isParent)];
}

/** A child's web search: strict safe-search, shops and explicit results left out (src/family.ts). */
export function createKidSearchTool(appOf: () => AppContext, config: () => SearchConfig | undefined): Tool {
  return {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: () => Boolean(appOf().member?.child?.()?.safeSearch && config()),
    spec: { name: 'kid_search', description: 'Search the web in safe-search mode (for school questions and things they are curious about). Returns titles, links and snippets; shops and grown-up results are left out.', parameters: obj({ query: { type: 'string' } }, ['query']) },
    summarize: (a) => `safe search “${String(a.query ?? '')}”`,
    async run(args, ctx) {
      const child = appOf().member?.child?.();
      const cfg = config();
      if (!child?.safeSearch || !cfg) throw new ToolError('Safe search is not on for you.');
      const results = (await runSearch({ ...cfg, safe: true }, String(args.query ?? '').slice(0, 200), 8, ctx.signal)).filter((r) => kidResultOk(r.url, `${r.title} ${r.snippet}`, child)).slice(0, 5);
      ctx.webTurn?.noteFound(results.map((r) => r.url));
      return formatResults(results);
    },
  };
}

// U4.21: the planner. meal_plan_get (the week, everyone's likes and allergies, saved recipes: what
// she needs to plan dinners), meal_plan_set (a parent: dinners for days; allergy clashes come back),
// meal_shopping (a parent: the week's ingredients into a grocery list, merged by aisle) and
// family_calendar (anyone, kids too: the family week, dinners and chores).
function createPlanTools(appOf: () => AppContext, has: () => boolean, isParent: () => boolean): Tool[] {
  const week = (f: FamilyAccess, start?: unknown) => {
    const tz = f.tz();
    const s = typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : weekStartOf(appOf().now(), tz);
    return planOf(f.store).week(f.person, s, tz, f.people());
  };
  const names = (f: FamilyAccess) => new Map(f.people().map((p) => [p.id, p.name]));
  const get: Tool = {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: () => has() && isParent(),
    spec: { name: 'meal_plan_get', description: 'The family meal plan for a week (one dinner a day), what each person likes, dislikes and is allergic to, and the saved family recipes. Read it before planning dinners.', parameters: obj({ week: { type: 'string', description: 'Any YYYY-MM-DD in the week (default: this week).' } }) },
    summarize: () => 'read the meal plan',
    async run(args) {
      const f = access(appOf());
      const plan = planOf(f.store);
      const w = week(f, args.week);
      const prefs = plan.prefs(f.person);
      return [
        `Week of ${w.start}:`,
        ...w.days.map((d) => `- ${d.day}: ${d.meal ? d.meal.title + (d.meal.warnings.length ? ` (allergy: ${d.meal.warnings.join('; ')})` : '') : 'no dinner planned'}`),
        '',
        'People:',
        ...f.people().map((p) => {
          const x = prefs.find((q) => q.person === p.id);
          return `- ${p.name}${p.child ? ' (kid)' : ''}: ${x ? [x.likes && `likes ${x.likes}`, x.dislikes && `dislikes ${x.dislikes}`, x.allergies && `allergic to ${x.allergies}`].filter(Boolean).join('; ') || 'nothing noted' : 'nothing noted'}`;
        }),
        '',
        `Family recipes: ${plan.recipes().map((r) => `#${r.id} ${r.title}`).join(', ') || 'none saved yet'}`,
      ].join('\n');
    },
  };
  const set: Tool = {
    defaultPermission: 'auto',
    isAvailable: () => has() && isParent(),
    spec: {
      name: 'meal_plan_set',
      description: 'A parent sets dinners on the family meal plan: one per day (YYYY-MM-DD), a title, optionally a saved recipe id or ingredient lines ("1 lb chicken thighs"). Plan around everyone\'s allergies (meal_plan_get). Replies with any allergy clash.',
      parameters: obj({ dinners: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, title: { type: 'string' }, recipe: { type: 'integer' }, ingredients: { type: 'array', items: { type: 'string' } } }, required: ['day'] } } }, ['dinners']),
    },
    summarize: (a) => `plan ${Array.isArray(a.dinners) ? a.dinners.length : 0} dinners`,
    async run(args) {
      const f = access(appOf());
      const plan = planOf(f.store);
      const list = Array.isArray(args.dinners) ? (args.dinners as Record<string, unknown>[]).slice(0, 14) : [];
      if (!list.length) throw new ToolError('Give at least one dinner: {day, title}.');
      const lines: string[] = [];
      for (const d of list) {
        const r = guard(() => plan.setMeal(f.person, String(d.day ?? ''), { title: d.title, recipeId: d.recipe, ingredients: d.ingredients }, f.people()));
        lines.push(`- ${r.meal.day}: ${r.meal.title}${r.warnings.length ? ` — allergy warning: ${r.warnings.join('; ')}` : ''}`);
      }
      return `Planned ${list.length} dinner${list.length === 1 ? '' : 's'}:\n${lines.join('\n')}\nVerified: they read back from the family meal plan.`;
    },
  };
  const shop: Tool = {
    defaultPermission: 'auto',
    isAvailable: () => has() && isParent() && Boolean(appOf().family?.boards),
    changes: true,
    spec: { name: 'meal_shopping', description: 'A parent puts the week\'s planned dinners\' ingredients on the family grocery list (quantities merged, grouped by aisle; nothing is bought).', parameters: obj({ week: { type: 'string', description: 'Any YYYY-MM-DD in the week (default: this week).' } }) },
    summarize: () => 'add the week\'s ingredients to the grocery list',
    async run(args) {
      const f = access(appOf());
      if (!f.boards) throw new ToolError('Grocery lists are not available here.');
      const w = week(f, args.week);
      const plan = planOf(f.store);
      const lines = plan.shopping(w.start);
      if (!lines.length) return `No ingredients on the plan for the week of ${w.start}: give the dinners recipes or ingredient lines first.`;
      const r = guard(() => plan.toGrocery(f.person, w.start, f.boards!, f.people().map((p) => p.id)));
      return `Added ${r.added} of ${r.lines} items to the grocery list (the rest were already on it):\n${lines.map((l) => `- ${l.title}`).join('\n')}`;
    },
  };
  const cal: Tool = {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: has,
    spec: { name: 'family_calendar', description: 'The family week: each day\'s dinner, family events (school, activities) and chores due. Kids see it too.', parameters: obj({ week: { type: 'string', description: 'Any YYYY-MM-DD in the week (default: this week).' } }) },
    summarize: () => 'read the family week',
    async run(args) {
      const f = access(appOf());
      const n = names(f);
      const w = week(f, args.week);
      return [`Family week of ${w.start}:`, ...w.days.map((d) => `- ${d.day}: ${[d.meal ? `dinner ${d.meal.title}` : '', ...d.events.map((e) => `${e.title}${e.allDay ? '' : ` at ${e.start.slice(11)}`}${e.who !== 'family' ? ' (private)' : ''}`), ...d.chores.map((c) => `chore ${c.title} (${n.get(c.assignee) ?? 'someone'})`)].filter(Boolean).join('; ') || 'nothing'}`)].join('\n');
    },
  };
  return [get, set, shop, cal];
}

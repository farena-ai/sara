// R8 (docs/FAMILY.md): her Family tools. chore_add (a parent: a recurring chore for someone, worth
// points and/or money), chore_list, chore_done (the person it's assigned to: it then waits for a
// parent's OK), allowance_balance, and allowance_pay (a parent records a payout: a record only, it
// never moves money; the card says so). kid_search is a child's web search in strict safe-search mode
// (only when a parent allowed it and the owner's search provider has a safe-search switch).
import type { AppContext } from '../chat.ts';
import { FamilyError, kidResultOk, kidsOf, money, type FamilyAccess } from '../family.ts';
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
  return [choreAdd, choreList, choreDone, balance, pay];
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

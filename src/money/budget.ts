// E3 (docs/MONEY.md): budget math on the person's own transactions, all in whole cents and in code.
// Categories come from, in order: the person's own corrections (\"Costco is groceries\"), a keyword
// table of common merchants, the bank's own category column, then the sign (money in is income).
// Summaries compare a period with the one before it; the subscription finder looks for the same
// merchant charging about the same amount every ~month, ~week or ~year. Pure functions (tested on
// invented rows).
import { addDays, daysBetween } from '../biz/store.ts';

export const BUDGET_CATEGORIES = ['groceries', 'dining', 'fuel', 'utilities', 'subscriptions', 'shopping', 'travel', 'health', 'income', 'transfers', 'other'] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
/** Not spending: left out of spending totals, limits and the subscription finder. */
export const NOT_SPENDING = new Set(['income', 'transfers']);

export interface Tx {
  id: number;
  date: string;
  description: string;
  merchant: string;
  amountCents: number;
  account: string;
  category: string;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** The description without card-processor prefixes, store numbers, dates and places: \"SQ *BLUE BOTTLE #123 OAKLAND CA\" → \"blue bottle\". */
export function merchantKey(description: string): string {
  let s = ` ${fold(description)} `;
  s = s
    .replace(/\b(pos|debit card purchase|debit purchase|purchase authorized on \d{1,2}\/\d{1,2}|recurring (payment|debit)|ach (debit|credit)|card purchase|checkcard \d+|visa|ppd id|web id)\b/g, ' ')
    .replace(/\b(sq|tst|pp|paypal|sp|dd|py|in|bt)\s?\*/g, ' ')
    .replace(/\.(com|net|org|co)\b/g, ' ')
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    .replace(/[#*]\s?\w*\d\w*/g, ' ')
    .replace(/\b\d[\d\-/.]*\b/g, ' ')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A trailing two-letter state code (\"... austin tx\") and the city before it say nothing about the merchant.
  const words = s.split(' ').filter(Boolean);
  if (words.length > 2 && /^[a-z]{2}$/.test(words.at(-1)!)) words.splice(-2, 2);
  return words.slice(0, 3).join(' ') || fold(description).trim().slice(0, 40);
}

/** Keyword table: [pattern on the folded description, category]. Order matters (\"uber eats\" before \"uber\"). */
const KEYWORDS: [RegExp, BudgetCategory][] = [
  [/\b(payroll|direct dep(osit)?|salary|paycheck|interest paid|dividend)\b/, 'income'],
  [/\b(payment thank you|autopay payment|online payment|credit card payment|card payment|epay|transfer|xfer|zelle|venmo|cash app|to savings|from savings|from checking|to checking)\b/, 'transfers'],
  [/\b(uber\s*\*?\s*eats|ubereats|doordash|grubhub|postmates|seamless)\b/, 'dining'],
  [/\b(netflix|spotify|hulu|disney ?(plus|\+)|hbo|max\.com|youtube premium|apple\.com\/bill|itunes|icloud|amazon prime|prime video|audible|patreon|adobe|microsoft 365|dropbox|google (storage|one)|paramount|peacock|chatgpt|openai|nytimes|new york times|siriusxm|crunchyroll)/, 'subscriptions'],
  [/\b(kroger|safeway|whole ?foods|wholefds|trader joe|aldi|publix|h-?e-?b|wegmans|sprouts|food lion|giant eagle|meijer|albertsons|instacart|grocery|groceries|supermarket|winco|hy-?vee|stop & shop|ralphs|fred meyer)\b/, 'groceries'],
  [/\b(restaurant|cafe|coffee|starbucks|mcdonald|chipotle|subway|pizza|taco bell|burger|wendy|chick-?fil-?a|dunkin|panera|grill|diner|sushi|bakery|kitchen|bistro|tst\*)/, 'dining'],
  [/\b(shell|exxon|chevron|mobil|marathon|speedway|sunoco|valero|citgo|circle k|wawa|quiktrip|racetrac|phillips 66|gas station|fuel)\b/, 'fuel'],
  [/\b(electric|energy|power co|water|utility|utilities|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|pg&e|duke energy|con ed|sewer|waste management)\b/, 'utilities'],
  [/\b(airline|airlines|delta air|united air|american air|southwest|jetblue|hotel|marriott|hilton|hyatt|airbnb|expedia|booking\.com|uber|lyft|amtrak|hertz|avis|enterprise rent|parking|toll)\b/, 'travel'],
  [/\b(pharmacy|cvs|walgreens|rite aid|doctor|dental|dentist|clinic|hospital|medical|optometr|health|gym|fitness)\b/, 'health'],
  [/\b(amazon|amzn|target|walmart|best buy|ebay|etsy|home depot|lowe'?s|ikea|macy|nordstrom|tj ?maxx|marshalls|costco)\b/, 'shopping'],
];

/** The bank's own category words → ours. */
const BANK: [RegExp, BudgetCategory][] = [
  [/food|dining|restaurant/, 'dining'],
  [/grocer/, 'groceries'],
  [/gas|fuel|automotive/, 'fuel'],
  [/utilit|bills|phone|internet|cable/, 'utilities'],
  [/travel|airfare|lodging|hotel/, 'travel'],
  [/health|medical|pharmacy|wellness/, 'health'],
  [/shopping|merchandise|retail/, 'shopping'],
  [/entertainment|subscription|streaming/, 'subscriptions'],
  [/payment|transfer/, 'transfers'],
  [/income|paycheck|deposit/, 'income'],
];

export interface Rule {
  merchant: string;
  category: string;
}

/** The person's rule for this merchant (theirs win): the longest rule that is a whole-word part of the merchant. */
export function ruleFor(merchant: string, rules: Rule[]): Rule | undefined {
  return rules.filter((r) => r.merchant && ` ${merchant} `.includes(` ${r.merchant} `)).sort((a, b) => b.merchant.length - a.merchant.length)[0];
}

export function categorize(t: { description: string; amountCents: number; bankCategory?: string }, rules: Rule[]): string {
  const own = ruleFor(merchantKey(t.description), rules);
  if (own) return own.category;
  const d = ` ${fold(t.description)} `;
  for (const [re, cat] of KEYWORDS) if (re.test(d)) return cat === 'income' && t.amountCents < 0 ? 'other' : cat;
  const b = fold(t.bankCategory ?? '');
  if (b) for (const [re, cat] of BANK) if (re.test(b)) return cat;
  return t.amountCents > 0 ? 'income' : 'other';
}

/** A free-form category from the person: one of ours (also a few common words), else their own word. */
export function cleanBudgetCategory(v: unknown): string | undefined {
  const s = fold(String(v ?? '')).replace(/[^a-z0-9 &-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!s) return undefined;
  const alias: Record<string, string> = { food: 'dining', restaurants: 'dining', 'eating out': 'dining', gas: 'fuel', grocery: 'groceries', subscription: 'subscriptions', medical: 'health', transfer: 'transfers', salary: 'income', bills: 'utilities', utility: 'utilities', trip: 'travel', shop: 'shopping' };
  return alias[s] ?? s;
}

// ---------------------------------------------------------------- periods and summaries

export interface Period {
  from: string;
  to: string;
  label: string;
}

/** \"2026-10\" → that month; the period of the same length right before a period. */
export function monthPeriod(month: string): Period {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}`, label };
}
export function previousPeriod(p: Period): Period {
  if (/-01$/.test(p.from) && monthPeriod(p.from.slice(0, 7)).to === p.to) {
    const [y, m] = p.from.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return monthPeriod(d.toISOString().slice(0, 7));
  }
  const len = daysBetween(p.from, p.to) + 1;
  const to = addDays(p.from, -1);
  return { from: addDays(to, -(len - 1)), to, label: `${addDays(to, -(len - 1))} to ${to}` };
}

export interface CategoryTotal {
  category: string;
  cents: number;
  count: number;
}
export interface Summary {
  period: Period;
  previous: Period;
  /** Spending (money out minus refunds) per category, biggest first; income and transfers left out. */
  spending: CategoryTotal[];
  spentCents: number;
  incomeCents: number;
  previousSpentCents: number;
  /** Per category: this period minus the previous one, biggest change first. */
  changes: { category: string; cents: number; previousCents: number; deltaCents: number }[];
  topMerchants: { merchant: string; cents: number; count: number }[];
  count: number;
  /** The first and last day with any transactions at all (to say what the data covers). */
  coverage: { from: string; to: string } | null;
}

function spendBy(list: Tx[], p: Period): Map<string, CategoryTotal> {
  const m = new Map<string, CategoryTotal>();
  for (const t of list) {
    if (t.date < p.from || t.date > p.to || NOT_SPENDING.has(t.category)) continue;
    const c = m.get(t.category) ?? { category: t.category, cents: 0, count: 0 };
    c.cents -= t.amountCents;
    c.count++;
    m.set(t.category, c);
  }
  return m;
}

export function summarize(all: Tx[], period: Period): Summary {
  const previous = previousPeriod(period);
  const now = spendBy(all, period);
  const before = spendBy(all, previous);
  const spending = [...now.values()].filter((c) => c.cents !== 0).sort((a, b) => b.cents - a.cents);
  const inPeriod = all.filter((t) => t.date >= period.from && t.date <= period.to);
  const cats = new Set([...now.keys(), ...before.keys()]);
  const changes = [...cats]
    .map((category) => {
      const cents = now.get(category)?.cents ?? 0;
      const previousCents = before.get(category)?.cents ?? 0;
      return { category, cents, previousCents, deltaCents: cents - previousCents };
    })
    .filter((c) => c.deltaCents !== 0)
    .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
  const merchants = new Map<string, { merchant: string; cents: number; count: number }>();
  for (const t of inPeriod) {
    if (NOT_SPENDING.has(t.category) || t.amountCents >= 0) continue;
    const x = merchants.get(t.merchant) ?? { merchant: t.merchant, cents: 0, count: 0 };
    x.cents -= t.amountCents;
    x.count++;
    merchants.set(t.merchant, x);
  }
  const dates = all.map((t) => t.date).sort();
  return {
    period,
    previous,
    spending,
    spentCents: spending.reduce((n, c) => n + c.cents, 0),
    incomeCents: inPeriod.filter((t) => t.category === 'income').reduce((n, t) => n + t.amountCents, 0),
    previousSpentCents: [...before.values()].reduce((n, c) => n + c.cents, 0),
    changes: changes.slice(0, 5),
    topMerchants: [...merchants.values()].sort((a, b) => b.cents - a.cents).slice(0, 5),
    count: inPeriod.length,
    coverage: dates.length ? { from: dates[0], to: dates.at(-1)! } : null,
  };
}

// ---------------------------------------------------------------- subscriptions

export interface Subscription {
  merchant: string;
  /** The latest charge. */
  amountCents: number;
  every: 'week' | 'month' | 'year';
  count: number;
  last: string;
  next: string;
  yearlyCents: number;
  category: string;
  /** No charge where one was expected (more than 1.5 intervals since the last). */
  maybeStopped: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The next date after `day` that repeats monthly (same day of month, clamped to the month's end). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.toISOString().slice(0, 8)}${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Recurring charges: one merchant, about the same amount (within 25 %), at ~weekly, ~monthly or ~yearly gaps. */
export function findSubscriptions(all: Tx[], today: string): Subscription[] {
  const by = new Map<string, Tx[]>();
  for (const t of all) {
    if (t.amountCents >= 0 || NOT_SPENDING.has(t.category) || ['groceries', 'fuel', 'dining'].includes(t.category)) continue;
    by.set(t.merchant, [...(by.get(t.merchant) ?? []), t]);
  }
  const out: Subscription[] = [];
  for (const [merchant, list] of by) {
    if (list.length < 2) continue;
    const amounts = list.map((t) => -t.amountCents);
    const mid = median(amounts);
    const same = list.filter((t) => Math.abs(-t.amountCents - mid) <= Math.max(mid * 0.25, 100)).sort((a, b) => a.date.localeCompare(b.date));
    // One charge per date (a split payment on one day is one charge).
    const days = [...new Map(same.map((t) => [t.date, t])).values()];
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((t, i) => daysBetween(days[i].date, t.date));
    const gap = median(gaps);
    const every = gap >= 6 && gap <= 8 ? 'week' : gap >= 26 && gap <= 35 ? 'month' : gap >= 350 && gap <= 380 ? 'year' : undefined;
    if (!every) continue;
    // Every gap must fit the pattern (allowing one missed charge), so random repeat shopping isn't called a subscription.
    const fits = gaps.every((g) => (every === 'week' ? g >= 5 && g <= 16 : every === 'month' ? g >= 24 && g <= 66 : g >= 340 && g <= 400));
    if (!fits || (every === 'week' && days.length < 3)) continue;
    const lastTx = days.at(-1)!;
    const amountCents = -lastTx.amountCents;
    const next = every === 'week' ? addDays(lastTx.date, 7) : every === 'month' ? addMonths(lastTx.date, 1) : addMonths(lastTx.date, 12);
    const interval = every === 'week' ? 7 : every === 'month' ? 30.4 : 365;
    out.push({
      merchant,
      amountCents,
      every,
      count: days.length,
      last: lastTx.date,
      next,
      yearlyCents: every === 'week' ? amountCents * 52 : every === 'month' ? amountCents * 12 : amountCents,
      category: lastTx.category,
      maybeStopped: daysBetween(lastTx.date, today) > interval * 1.5,
    });
  }
  return out.sort((a, b) => Number(a.maybeStopped) - Number(b.maybeStopped) || b.yearlyCents - a.yearlyCents);
}

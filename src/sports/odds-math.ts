// E4 (docs/SPORTS.md): betting math, all deterministic code (the model never does this arithmetic).
// Odds in any of the three common formats (American +150/-110, decimal 2.50, fractional 6/4 or
// "evens"), implied probability, the no-vig (fair) split of a two- or three-way market and the
// book's hold, expected value for the person's own probability, the Kelly fraction (full and
// quarter, shown as math, never advice) and parlay odds. Probabilities are 0-1.

export class OddsInputError extends Error {}

export interface OddsPrice {
  /** What the person wrote, trimmed. */
  input: string;
  decimal: number;
  american: number;
  /** "6/4"; "≈" in front when no small fraction is exact. */
  fractional: string;
  implied: number;
}

const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** "+150", "-110", "150", "2.5", "6/4", "6-4"? no (ambiguous): "6/4" only, "evens"/"even"/"EV". */
export function parseOdds(raw: unknown): OddsPrice {
  const input = String(raw ?? '').trim();
  const s = input.toLowerCase().replace(/\s+/g, '');
  let dec: number;
  if (!s) throw new OddsInputError('Give the odds, like +150, -110, 2.50 or 6/4.');
  if (/^(evens?|ev|pk|pick)$/.test(s)) dec = 2;
  else if (/^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(s)) {
    const [a, b] = s.split('/').map(Number);
    if (!(a > 0) || !(b > 0)) throw new OddsInputError(`"${input.slice(0, 20)}" isn't a fractional price.`);
    dec = 1 + a / b;
  } else if (/^[+-]\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Math.abs(n) < 100) throw new OddsInputError(`"${input.slice(0, 20)}" isn't an American price (they are +100 or more, or -100 or less).`);
    dec = n > 0 ? 1 + n / 100 : 1 + 100 / -n;
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // A bare number of 100 or more is American (+150); between 1 and 100 it is decimal (2.5).
    if (n >= 100) dec = 1 + n / 100;
    else if (n > 1) dec = n;
    else throw new OddsInputError(`"${input.slice(0, 20)}" isn't a price: decimal odds are above 1.00.`);
  } else throw new OddsInputError(`"${input.slice(0, 20)}" isn't a price I can read. Use American (+150, -110), decimal (2.50) or fractional (6/4).`);
  return priceOf(dec, input);
}

export function priceOf(decimal: number, input = ''): OddsPrice {
  if (!Number.isFinite(decimal) || decimal <= 1) throw new OddsInputError('Decimal odds are above 1.00.');
  return { input: input || String(r(decimal, 3)), decimal: r(decimal, 4), american: americanOf(decimal), fractional: fractionalOf(decimal), implied: r(1 / decimal, 6) };
}

/** Decimal → American, rounded to a whole number (2.5 → +150, 1.909 → -110). */
export function americanOf(decimal: number): number {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

/** Decimal → the simplest fraction within half a cent (1.909 → 10/11, 2.5 → 3/2). */
export function fractionalOf(decimal: number): string {
  const x = decimal - 1;
  let best = { n: 1, d: 1, err: Infinity };
  for (let d = 1; d <= 100; d++) {
    const n = Math.max(1, Math.round(x * d));
    const err = Math.abs(x - n / d);
    if (err < best.err) best = { n, d, err };
    if (err < 0.005) break;
  }
  const g = gcd(best.n, best.d);
  return `${best.err >= 0.005 ? '≈' : ''}${best.n / g}/${best.d / g}`;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a) || 1);

/** The fair split of one market (two or three ways) and the book's hold (its cut: 1 - 1/overround). */
export function fairMarket(prices: OddsPrice[]): { fair: number[]; overround: number; hold: number } {
  const sum = prices.reduce((a, p) => a + p.implied, 0);
  return { fair: prices.map((p) => r(p.implied / sum, 6)), overround: r(sum - 1, 6), hold: r(1 - 1 / sum, 6) };
}

/** Expected profit for a stake when the true chance is p. Per unit it is p·(d−1) − (1−p). */
export function expectedValue(p: number, decimal: number, stake = 1): { ev: number; evPct: number; edge: number } {
  checkP(p);
  const perUnit = p * (decimal - 1) - (1 - p);
  return { ev: r(perUnit * stake, 2), evPct: r(perUnit * 100, 2), edge: r(p - 1 / decimal, 6) };
}

/** Kelly fraction of the bankroll: (b·p − q)/b with b = d − 1; 0 when there is no edge by p. */
export function kelly(p: number, decimal: number): { full: number; quarter: number } {
  checkP(p);
  const b = decimal - 1;
  const f = Math.max(0, (b * p - (1 - p)) / b);
  return { full: r(f, 6), quarter: r(f / 4, 6) };
}

/** Parlay: the legs' decimal odds multiplied (independent legs). */
export function parlay(legs: OddsPrice[]): OddsPrice {
  if (legs.length < 2) throw new OddsInputError('A parlay needs two or more legs.');
  return priceOf(legs.reduce((a, l) => a * l.decimal, 1), legs.map((l) => l.input).join(' × '));
}

function checkP(p: number): void {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new OddsInputError('Your probability is between 0 and 1 (or 1% and 99%).');
}

/** "55%", "55", "0.55" → 0.55. */
export function probabilityOf(raw: unknown): number {
  const s = String(raw ?? '').trim().replace(/%$/, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new OddsInputError('Your probability is between 0 and 1 (or 1% and 99%).');
  const p = n >= 1 || /%/.test(String(raw)) ? n / 100 : n;
  checkP(p);
  return p;
}

export const pctText = (p: number, d = 1): string => `${(p * 100).toFixed(d)}%`;
export const americanText = (a: number): string => (a > 0 ? `+${a}` : String(a));
export const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
